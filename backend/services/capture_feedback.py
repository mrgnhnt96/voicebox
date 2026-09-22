"""Local correction records for evaluation and future training datasets."""

import json
import logging

from sqlalchemy.orm import Session

from ..database.models import CaptureFeedback
from ..models import CaptureFeedbackCreate, CaptureFeedbackResponse
from . import personal_examples, writing_style
from .captures import get_capture

logger = logging.getLogger(__name__)


def to_response(row: CaptureFeedback) -> CaptureFeedbackResponse:
    return CaptureFeedbackResponse(
        id=row.id,
        capture_id=row.capture_id,
        target=row.target,
        expected_text=row.expected_text,
        notes=row.notes,
        snapshot=json.loads(row.snapshot),
        created_at=row.created_at,
    )


def save_feedback(capture_id: str, request: CaptureFeedbackCreate, db: Session):
    capture = get_capture(capture_id, db)
    if capture is None:
        return None
    if capture != request.snapshot:
        raise ValueError("Capture changed. Refresh it before reporting a correction.")
    original = capture.transcript_raw if request.target == "raw" else capture.transcript_refined
    if original is None:
        raise ValueError("This capture has no refined output to report.")
    if request.expected_text.strip() == original.strip():
        raise ValueError("Expected output must differ from the model output.")
    row = CaptureFeedback(
        capture_id=capture_id,
        target=request.target,
        expected_text=request.expected_text.strip(),
        notes=request.notes.strip(),
        snapshot=capture.model_dump_json(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    if row.target == "refined":
        personal_examples.invalidate()
        try:
            writing_style.refresh_feedback(db)
        except Exception:
            logger.warning("Could not update the writing style from a correction", exc_info=True)
    return to_response(row)


def list_feedback(db: Session, capture_id: str | None = None):
    query = db.query(CaptureFeedback)
    if capture_id is not None:
        query = query.filter(CaptureFeedback.capture_id == capture_id)
    return [to_response(row) for row in query.order_by(CaptureFeedback.created_at.desc(), CaptureFeedback.id).all()]
