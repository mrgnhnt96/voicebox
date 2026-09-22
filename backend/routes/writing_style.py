"""Writing style calibration and the learned punctuation profile."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models
from ..database import Capture, get_db
from ..services import personal_examples, writing_style
from ..services.writing_style_paragraphs import BY_ID

router = APIRouter(prefix="/writing-style", tags=["writing-style"])
PREVIEW_CANDIDATES = 50


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


@router.post("/calibration", response_model=models.WritingStyleCalibrationStep)
async def start_calibration():
    return {**writing_style.start_calibration(), "done": False}


@router.post("/calibration/{session_id}/steps", response_model=models.WritingStyleCalibrationStep)
async def submit_calibration_step(session_id: str, request: models.WritingStyleStepRequest):
    try:
        return writing_style.submit_step(session_id, request.written)
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
    before, after = _preview(db)
    return {"status": status, "before": before, "after": after}


def _preview(db: Session) -> tuple[str, str]:
    """The recent dictation the learned style changes most.

    A short latest dictation often has no sentence break or comma to restyle,
    so it would show no difference even when plenty was learned. Falls back to
    a sample paragraph when none of the recent dictations would change.
    """
    rows = (
        db.query(Capture.transcript_refined)
        .filter(Capture.transcript_refined.isnot(None), Capture.transcript_refined != "")
        .order_by(Capture.created_at.desc())
        .limit(PREVIEW_CANDIDATES)
        .all()
    )
    best = None
    for (text,) in rows:
        styled = writing_style.apply_learned(text)
        changed = sum(a != b for a, b in zip(text.split(), styled.split(), strict=False))
        if changed and (best is None or changed > best[0]):
            best = (changed, text, styled)
    if best:
        return best[1], best[2]
    sample = BY_ID["explanation-cache"].text
    return sample, writing_style.apply_learned(sample)


@router.delete("/calibration/{session_id}", status_code=204)
async def discard_calibration(session_id: str):
    writing_style.discard_calibration(session_id)
