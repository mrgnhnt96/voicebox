"""
Load mlx-audio Whisper without importing libraries it never uses.

The startup Whisper load took ~24 s in the packaged server but ~2 s from a
source checkout, and reading the 1.5 GB of weights takes under a second either
way (the weights are not converted in any costly way). The difference is
imports. The packaged server is a PyInstaller onefile build: every launch
extracts its native libraries to a new directory, and macOS validates each
library the first time it is loaded, about 0.2 s apiece. Loading Whisper
imported about a hundred of them that recognition never touches:

- every other speech model family mlx-audio ships, because its
  ``mlx_audio.stt.models`` package imports all eleven up front (one of them
  pulls in mlx-lm and transformers' generation code).
- ``numba``, ``llvmlite`` and ``scipy.signal``, imported by mlx-audio's
  word-timestamp module when Whisper is imported. Voicebox never asks for
  word timestamps.
- transformers' ``WhisperProcessor``, whose base class imports the
  transformers model code and through it ``scipy.optimize``. mlx-audio only
  keeps it to reach the tokenizer.

``load_whisper`` loads the same weights through mlx-audio, but imports only
the Whisper family, defers the word-timestamp module until it is used, and
attaches only the tokenizer. Recognition is unchanged: the tokenizer is the
one ``WhisperProcessor`` would have loaded.
"""

from __future__ import annotations

import importlib
import importlib.util
import logging
import sys
import types
from types import SimpleNamespace

logger = logging.getLogger(__name__)

_MODELS_PACKAGE = "mlx_audio.stt.models"
_WHISPER_MODULE = "mlx_audio.stt.models.whisper.whisper"
_TIMING_MODULE = "mlx_audio.stt.models.whisper.timing"

# mlx-audio's own post-load hook while load_whisper has replaced it.
_mlx_audio_hook = None


def defer_word_timing_import() -> None:
    """Keep numba and scipy.signal out of the Whisper import.

    mlx-audio's Whisper imports ``add_word_timestamps`` at module import, and
    that module imports numba and scipy.signal. They are only used for
    ``word_timestamps=True``. This installs a stand-in that imports the real
    module the first time anything from it is used. Call it before mlx-audio's
    Whisper is imported; afterwards it does nothing.
    """
    if _TIMING_MODULE in sys.modules or _WHISPER_MODULE in sys.modules:
        return
    if importlib.util.find_spec("mlx_audio") is None:
        return

    loaded = []

    def real_module():
        if loaded:
            return loaded[0]
        # Import it under its own name through the normal import system, which
        # also works from the packaged server's archive (no .py files on disk).
        if sys.modules.get(_TIMING_MODULE) is stand_in:
            del sys.modules[_TIMING_MODULE]
        try:
            module = importlib.import_module(_TIMING_MODULE)
        except BaseException:
            sys.modules.setdefault(_TIMING_MODULE, stand_in)
            raise
        loaded.append(module)
        return module

    def add_word_timestamps(*args, **kwargs):
        return real_module().add_word_timestamps(*args, **kwargs)

    def module_getattr(name):
        # inspect and friends probe dunders such as __file__ on every module;
        # those must not trigger the import this stand-in exists to avoid.
        if name.startswith("__"):
            raise AttributeError(name)
        return getattr(real_module(), name)

    stand_in = types.ModuleType(_TIMING_MODULE, "Imports mlx-audio's Whisper word timing on first use.")
    stand_in.__package__ = _TIMING_MODULE.rpartition(".")[0]
    stand_in.add_word_timestamps = add_word_timestamps
    stand_in.real_module = real_module
    stand_in.__getattr__ = module_getattr
    sys.modules[_TIMING_MODULE] = stand_in


def import_whisper_only() -> None:
    """Make mlx-audio's Whisper importable without its sibling model families.

    ``mlx_audio.stt.models`` imports every model family in its ``__init__``.
    Register the package without running that, so its submodules import one
    at a time on demand, as any package's do. Also defers word timing. Call
    before mlx-audio's STT models are imported; afterwards it does nothing.
    """
    defer_word_timing_import()
    if _MODELS_PACKAGE in sys.modules:
        return
    spec = importlib.util.find_spec(_MODELS_PACKAGE)
    if spec is None or spec.submodule_search_locations is None:
        return
    package = importlib.util.module_from_spec(spec)
    sys.modules[_MODELS_PACKAGE] = package
    setattr(sys.modules["mlx_audio.stt"], "models", package)


def _load_tokenizer(model_path):
    # WhisperProcessor.from_pretrained loads this same (fast) tokenizer, plus a
    # feature extractor mlx-audio never uses.
    from transformers import WhisperTokenizerFast

    return WhisperTokenizerFast.from_pretrained(str(model_path))


def attach_tokenizer(model, model_path):
    """Post-load hook: give the model its tokenizer, as mlx-audio's hook does.

    mlx-audio's Whisper only reads ``model._processor.tokenizer``. If the
    tokenizer cannot be loaded this way, fall back to mlx-audio's own hook.
    """
    try:
        model._processor = SimpleNamespace(tokenizer=_load_tokenizer(model_path))
        return model
    except Exception:
        logger.warning("Could not load the Whisper tokenizer directly; using WhisperProcessor", exc_info=True)
    hook = _mlx_audio_hook
    if hook is None:
        from mlx_audio.stt.models.whisper import whisper

        hook = whisper.Model.post_load_hook
    if hook is attach_tokenizer:
        raise RuntimeError("mlx-audio's Whisper post-load hook is unavailable")
    return hook(model, model_path)


def load_whisper(model_path):
    """``mlx_audio.stt.load(model_path)`` without the unused imports above.

    Runs on the MLX worker thread, which serializes every model load.
    """
    global _mlx_audio_hook

    import_whisper_only()
    from mlx_audio.stt.models.whisper import whisper
    from mlx_audio.stt import load

    original = whisper.Model.__dict__["post_load_hook"]
    _mlx_audio_hook = whisper.Model.post_load_hook
    whisper.Model.post_load_hook = staticmethod(attach_tokenizer)
    try:
        return load(model_path)
    finally:
        whisper.Model.post_load_hook = original
        _mlx_audio_hook = None
