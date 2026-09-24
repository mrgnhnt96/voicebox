"""Whisper loads without importing libraries it never uses.

In the packaged server (PyInstaller onefile) every launch extracts native
libraries to a new directory, and macOS validates each one the first time it
is loaded (~0.2 s each). mlx-audio's Whisper load imported numba and
scipy.signal for word timestamps, and transformers' WhisperProcessor (which
pulls in modeling code and scipy.optimize) only to get the tokenizer. That was
20+ s of the ~24 s startup load.
"""

import platform
import subprocess
import sys
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.skipif(
    not (sys.platform == "darwin" and platform.machine() == "arm64"),
    reason="MLX is only installed on Apple Silicon macOS",
)

TURBO = "openai/whisper-large-v3-turbo"


def run(code):
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    return out.stdout.strip().splitlines()[-1]


def cached_snapshot(repo):
    from huggingface_hub import snapshot_download

    try:
        return snapshot_download(repo, local_files_only=True)
    except Exception:
        pytest.skip(f"{repo} is not downloaded")


def test_whisper_imports_without_word_timing_dependencies():
    """numba and scipy.signal are only needed for word timestamps, never used."""
    code = (
        "import sys\n"
        "from backend.backends import mlx_whisper_loader\n"
        "mlx_whisper_loader.defer_word_timing_import()\n"
        "from mlx_audio.stt.models.whisper import whisper\n"
        "print(sorted(m for m in ('numba', 'llvmlite', 'scipy.signal') if m in sys.modules))\n"
    )
    assert run(code) == "[]"


def test_deferred_word_timing_still_resolves_the_real_module():
    code = (
        "import sys\n"
        "from backend.backends import mlx_whisper_loader\n"
        "mlx_whisper_loader.defer_word_timing_import()\n"
        "from mlx_audio.stt.models.whisper import whisper, timing\n"
        "real = timing.real_module()\n"
        "print(real.__name__, real is not timing, 'numba' in sys.modules,"
        " real.TOKENS_PER_SECOND == timing.TOKENS_PER_SECOND)\n"
    )
    module, is_real, numba_loaded, same_constant = run(code).split()
    assert module == "mlx_audio.stt.models.whisper.timing"
    assert (is_real, numba_loaded, same_constant) == ("True", "True", "True")


def test_tokenizer_is_the_one_whisper_processor_would_load():
    path = cached_snapshot(TURBO)
    from transformers import WhisperProcessor

    from backend.backends import mlx_whisper_loader

    model = SimpleNamespace()
    mlx_whisper_loader.attach_tokenizer(model, path)
    ours = model._processor.tokenizer
    theirs = WhisperProcessor.from_pretrained(path).tokenizer

    assert type(ours) is type(theirs)
    assert ours.get_vocab() == theirs.get_vocab()
    assert ours.all_special_ids == theirs.all_special_ids
    text = " Run npm install, then set the timeout to 250ms. Don't enable the cache."
    assert ours.encode(text, add_special_tokens=False) == theirs.encode(text, add_special_tokens=False)
    ids = ours.encode(text)
    assert ours.decode(ids, skip_special_tokens=True) == theirs.decode(ids, skip_special_tokens=True)


def test_attaching_the_tokenizer_skips_transformers_model_code():
    path = cached_snapshot(TURBO)
    code = (
        "import sys\n"
        "from types import SimpleNamespace\n"
        "from backend.backends import mlx_whisper_loader\n"
        f"mlx_whisper_loader.attach_tokenizer(SimpleNamespace(), {path!r})\n"
        "print(sorted(m for m in ('scipy', 'transformers.modeling_utils', 'transformers.processing_utils')"
        " if m in sys.modules))\n"
    )
    assert run(code) == "[]"


def test_load_uses_the_tokenizer_hook_and_restores_mlx_audio(monkeypatch):
    from mlx_audio.stt.models.whisper import whisper

    from backend.backends import mlx_whisper_loader

    original = whisper.Model.__dict__["post_load_hook"]
    seen = {}

    def fake_load(repo):
        seen["repo"] = repo
        seen["hook"] = whisper.Model.post_load_hook
        return "model"

    monkeypatch.setitem(sys.modules, "mlx_audio.stt", SimpleNamespace(load=fake_load))

    assert mlx_whisper_loader.load_whisper(TURBO) == "model"
    assert seen["repo"] == TURBO
    assert seen["hook"] is mlx_whisper_loader.attach_tokenizer
    assert whisper.Model.__dict__["post_load_hook"] is original


def test_tokenizer_failure_falls_back_to_mlx_audio_processor(monkeypatch):
    from mlx_audio.stt.models.whisper import whisper

    from backend.backends import mlx_whisper_loader

    calls = []
    monkeypatch.setattr(mlx_whisper_loader, "_load_tokenizer", lambda path: (_ for _ in ()).throw(OSError("x")))
    monkeypatch.setattr(whisper.Model, "post_load_hook", staticmethod(lambda m, p: calls.append(p) or m))
    model = SimpleNamespace()

    assert mlx_whisper_loader.attach_tokenizer(model, "/models/w") is model
    assert calls == ["/models/w"]


def test_full_load_imports_no_scipy():
    cached_snapshot(TURBO)
    code = (
        "import sys\n"
        "from backend.backends import mlx_whisper_loader\n"
        f"model = mlx_whisper_loader.load_whisper({TURBO!r})\n"
        "model.get_tokenizer(language='en')\n"
        "print(sorted(m for m in ('scipy', 'numba', 'transformers.modeling_utils') if m in sys.modules))\n"
    )
    assert run(code) == "[]"


def test_only_the_whisper_model_family_is_imported():
    code = (
        "import sys\n"
        "from backend.backends import mlx_whisper_loader\n"
        "mlx_whisper_loader.import_whisper_only()\n"
        "from mlx_audio.stt.models.whisper import whisper\n"
        "import mlx_audio.stt.models as models\n"
        "others = [m for m in sys.modules if m.startswith('mlx_audio.stt.models.') and '.whisper' not in m]\n"
        "print(others, 'mlx_lm' in sys.modules, models.whisper is sys.modules['mlx_audio.stt.models.whisper'])\n"
    )
    assert run(code) == "[] False True"


def test_other_model_families_still_import_on_demand():
    code = (
        "from backend.backends import mlx_whisper_loader\n"
        "mlx_whisper_loader.import_whisper_only()\n"
        "from mlx_audio.stt.models import parakeet\n"
        "from mlx_audio.stt.utils import get_model_path\n"
        "print(parakeet.__name__)\n"
    )
    assert run(code) == "mlx_audio.stt.models.parakeet"
