"""Load the configured dictation models before accepting requests."""

import logging
import time

from ..database import session
from . import llm, settings, transcribe

logger = logging.getLogger(__name__)


async def load_startup_models() -> None:
    """Load installed capture models, leaving missing downloads to setup."""
    with session.SessionLocal() as db:
        saved = settings.get_capture_settings(db)
        stt_size = saved.stt_model
        llm_size = saved.llm_model
        auto_refine = saved.auto_refine

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
