"""Load the configured dictation models before accepting requests."""

import asyncio
import logging
import time

import numpy as np

from .. import config
from ..database import session
from . import llm, refinement, settings, speech_detect, transcribe
from .mlx_thread import keep_weights_resident, run_on_mlx_thread

logger = logging.getLogger(__name__)
WARM_RATE = 48000
# Enough real speech to run Whisper's full decode, short enough to keep
# startup quick.
WARM_SECONDS = 5


async def load_startup_models() -> None:
    """Load installed capture models, leaving missing downloads to setup."""
    with session.SessionLocal() as db:
        saved = settings.get_capture_settings(db)
        stt_size = saved.stt_model
        llm_size = saved.llm_model
        auto_refine = saved.auto_refine
        language = None if saved.language in (None, "auto") else saved.language
        flags = refinement.RefinementFlags(
            saved.smart_cleanup, saved.self_correction, saved.preserve_technical, saved.punctuation_style
        )

    try:
        await run_on_mlx_thread(keep_weights_resident)
    except Exception:
        logger.exception("Could not keep model weights resident")

    selected = [("Whisper", transcribe.get_whisper_model, stt_size)]
    if auto_refine:
        selected.append(("refinement", llm.get_llm_model, llm_size))

    for name, get_backend, size in selected:
        try:
            backend = get_backend()
            if not backend._is_model_cached(size):
                logger.info("Skipping startup load for %s %s: not downloaded", name, size)
                continue
            started = time.monotonic()
            logger.info("Loading %s %s for startup", name, size)
            await backend.load_model(size)
            logger.info("Startup %s %s loaded in %.3fs", name, size, time.monotonic() - started)
        except Exception:
            # Keep setup and diagnostics available if an installed model fails.
            logger.exception("Could not load startup %s model %s", name, size)

    # The voice detector every dictation checks its audio with.
    await asyncio.to_thread(speech_detect.load)
    await warm_whisper(stt_size, language)
    if auto_refine:
        await warm_refinement(flags, llm_size)


async def warm_whisper(stt_size: str, language: str | None) -> None:
    """Run Whisper once during startup so the first dictation is warm.

    Loading Whisper doesn't run it; the first real transcription otherwise
    pays one-time setup after the user lets go of the keys: ~0.3 s for the
    first run, and ~0.25 s more to find the ellipsis tokens that dictation
    phrases suppress (see ``ellipsis_token_ids``). Faint
    noise barely decodes anything, so the user's most recent recording is
    used when there is one; its text is discarded.
    """
    backend = transcribe.get_whisper_model()
    if not backend.is_loaded():
        return
    try:
        started = time.monotonic()
        samples, rate = _warm_audio()
        # Called the way streaming recognizes a dictation's first phrase
        # (previous_text=""), which builds the phrase options, such as the
        # suppressed ellipsis tokens, once per process.
        # Whisper runs even if that recording is silent: warming it is the point.
        await backend.transcribe_array(
            samples, rate, language=language, model_size=stt_size, previous_text="", check_speech=False
        )
        logger.info("Whisper warmed in %.3fs", time.monotonic() - started)
    except Exception:
        logger.exception("Could not warm Whisper")


async def warm_refinement(flags, llm_size: str) -> None:
    """Run one short cleanup so the first dictation reuses the cached prompt."""
    backend = llm.get_llm_model()
    if not backend.is_loaded():
        return
    try:
        started = time.monotonic()
        await refinement.refine_transcript("okay", flags, model_size=llm_size)
        logger.info("Refinement prompt warmed in %.3fs", time.monotonic() - started)
    except Exception:
        logger.exception("Could not warm the refinement prompt")


def _warm_audio() -> tuple[np.ndarray, int]:
    """The newest recording's first seconds, or faint 48 kHz noise.

    48 kHz like a Mac microphone, so the resampling path is warm too.
    """
    try:
        recordings = sorted(config.get_captures_dir().glob("*.wav"), key=lambda p: p.stat().st_mtime)
        if recordings:
            import soundfile as sf

            with sf.SoundFile(str(recordings[-1])) as audio:
                rate = audio.samplerate
                samples = audio.read(frames=rate * WARM_SECONDS, dtype="int16", always_2d=True)[:, 0]
            if len(samples):
                return samples, rate
    except Exception:
        logger.info("No usable recording to warm Whisper with; using noise", exc_info=True)
    return np.random.default_rng(0).integers(-30, 30, WARM_RATE, dtype=np.int16), WARM_RATE
