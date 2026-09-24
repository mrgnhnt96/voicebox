"""Writing style calibration, the learned punctuation profile, and the user's examples."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models
from ..database import Capture, get_db
from ..services import correction_notes, personal_examples, settings as settings_service, writing_style
from ..services.content_check import check_refinement
from ..services.refinement import RefinementFlags, refine_transcript
from ..services.writing_style_paragraphs import PARAGRAPHS

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/writing-style", tags=["writing-style"])
# A preview needs something to restructure; shorter dictations rarely have it.
PREVIEW_MIN_WORDS = 12
PREVIEW_CANDIDATES = 50


async def _clean(db: Session, said: str, extra=None, use_examples=True) -> str:
    """Clean ``said`` up the way dictation would with the user's settings.

    Falls back to what was said when the refinement model is unavailable, so
    calibration still works before it has been downloaded.
    """
    saved = settings_service.get_capture_settings(db)
    flags = RefinementFlags(
        saved.smart_cleanup, saved.self_correction, saved.preserve_technical, saved.punctuation_style
    )
    try:
        refined, _ = await refine_transcript(
            said, flags, model_size=saved.llm_model, use_personal_examples=use_examples, extra_examples=extra
        )
    except Exception:
        logger.warning("Calibration cleanup failed; showing the paragraph as said", exc_info=True)
        return said
    refined, _ = check_refinement(said, refined, flags)
    return refined


@router.get("", response_model=models.WritingStyleStatus)
async def get_writing_style():
    return writing_style.status()


@router.delete("", response_model=models.WritingStyleStatus)
async def reset_writing_style():
    writing_style.reset()
    return writing_style.status()


@router.get("/examples", response_model=list[models.PersonalExample])
async def list_examples():
    return personal_examples.all_examples()


@router.delete("/examples/{example_id}", status_code=204)
async def remove_example(example_id: str):
    """Stop using an example; corrections stay recorded for the personal model."""
    if not personal_examples.hide(example_id):
        raise HTTPException(status_code=404, detail="Example not found")


@router.get("/notes", response_model=models.CorrectionNotesStatus)
async def get_correction_notes():
    return correction_notes.status()


@router.delete("/notes/{note_id}", status_code=204)
async def remove_correction_note(note_id: str):
    if not correction_notes.remove(note_id):
        raise HTTPException(status_code=404, detail="Rule not found")


@router.post("/calibration", response_model=models.WritingStyleCalibrationStep)
async def start_calibration(db: Session = Depends(get_db)):
    started = writing_style.start_calibration()
    shown = await _clean(db, started["said"])
    return writing_style.present(started["session_id"], shown)


@router.post("/calibration/{session_id}/steps", response_model=models.WritingStyleCalibrationStep)
async def submit_calibration_step(
    session_id: str, request: models.WritingStyleStepRequest, db: Session = Depends(get_db)
):
    try:
        result = writing_style.submit_step(session_id, request.written)
        if result["done"]:
            return result
        # Each paragraph is cleaned up with everything learned so far,
        # including this run's rewrites, so it arrives closer to the user.
        shown = await _clean(db, result["said"], extra=writing_style.session_examples(session_id))
        return writing_style.present(session_id, shown)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Calibration expired. Start it again.") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/calibration/{session_id}/finish", response_model=models.WritingStyleCalibrationResult)
async def finish_calibration(session_id: str, db: Session = Depends(get_db)):
    try:
        status = writing_style.finish_calibration(session_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Calibration expired. Start it again.") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    before, after = await _preview(db)
    return {"status": status, "before": before, "after": after}


async def _preview(db: Session) -> tuple[str, str]:
    """One of the user's own dictations, cleaned up before and after this run.

    Uses the newest dictation long enough to have something to restructure.
    With none, a calibration paragraph is cleaned up without and with the
    user's examples instead.
    """
    rows = (
        db.query(Capture.transcript_raw, Capture.transcript_refined)
        .filter(Capture.transcript_raw != "")
        .order_by(Capture.created_at.desc())
        .limit(PREVIEW_CANDIDATES)
        .all()
    )
    for raw, refined in rows:
        if len(raw.split()) >= PREVIEW_MIN_WORDS:
            return refined or raw, await _clean(db, raw)
    said = PARAGRAPHS[-1].said
    return await _clean(db, said, use_examples=False), await _clean(db, said)


@router.delete("/calibration/{session_id}", status_code=204)
async def discard_calibration(session_id: str):
    writing_style.discard_calibration(session_id)
