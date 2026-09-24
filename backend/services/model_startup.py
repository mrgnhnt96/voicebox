"""Load the configured dictation models before accepting requests."""

import logging
import time

import numpy as np

from ..database import session
from . import llm, refinement, settings, transcribe

logger = logging.getLogger(__name__)
WARM_RATE = 48000


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

    await warm_whisper(stt_size, language)
    if auto_refine:
        await warm_refinement(flags, llm_size)


async def warm_whisper(stt_size: str, language: str | None) -> None:
    """Transcribe one second of faint noise so the first dictation is warm.

    Loading Whisper doesn't run it; the first real transcription otherwise
    pays ~0.3 s of one-time GPU setup after the user lets go of the keys.
    """
    backend = transcribe.get_whisper_model()
    if not backend.is_loaded():
        return
    try:
        started = time.monotonic()
        # 48 kHz like a Mac microphone, so the resampling path is warm too.
        noise = np.random.default_rng(0).integers(-30, 30, WARM_RATE, dtype=np.int16)
        await backend.transcribe_array(noise, WARM_RATE, language=language, model_size=stt_size)
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
