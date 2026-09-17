"""Corrections preserve evaluation evidence without changing model output."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend.database.models import Base, Capture, CaptureFeedback
from backend.models import CaptureFeedbackCreate
from backend.services.capture_feedback import list_feedback, save_feedback
from backend.services.captures import delete_capture, get_capture


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(Capture(id="take", audio_path="captures/take.wav", source="dictation",
                            transcript_raw="wrong words", transcript_refined="Wrong words.",
                            stt_model="turbo", llm_model="0.6B"))
        session.commit()
        yield session
    engine.dispose()


def request(db, **kwargs):
    return CaptureFeedbackCreate(snapshot=get_capture("take", db), target="raw",
                                 expected_text="Right words", **kwargs)


def test_report_survives_reprocessing_and_session_reload(db):
    result = save_feedback("take", request(db, notes="Missed a name"), db)
    assert get_capture("take", db).transcript_raw == "wrong words"
    row = db.get(Capture, "take")
    row.transcript_raw = "new result"
    row.stt_model = "large"
    db.commit()
    db.expunge_all()
    reports = list_feedback(db, "take")
    assert len(reports) == 1
    assert reports[0].id == result.id
    assert reports[0].snapshot.transcript_raw == "wrong words"
    assert reports[0].snapshot.stt_model == "turbo"
    assert reports[0].snapshot.audio_path == "captures/take.wav"
    assert reports[0].expected_text == "Right words"
    assert reports[0].notes == "Missed a name"


def test_stale_snapshot_rejected(db):
    draft = request(db)
    db.get(Capture, "take").transcript_raw = "new output"
    db.commit()
    with pytest.raises(ValueError, match="Capture changed"):
        save_feedback("take", draft, db)
    assert list_feedback(db) == []


def test_unchanged_output_rejected_but_empty_correction_allowed(db):
    draft = request(db)
    draft.expected_text = " wrong words "
    with pytest.raises(ValueError, match="must differ"):
        save_feedback("take", draft, db)
    draft.expected_text = ""
    assert save_feedback("take", draft, db).expected_text == ""


def test_refined_report_and_missing_refinement(db):
    draft = request(db)
    draft.target = "refined"
    assert save_feedback("take", draft, db).target == "refined"
    db.get(Capture, "take").transcript_refined = None
    db.commit()
    draft.snapshot = get_capture("take", db)
    with pytest.raises(ValueError, match="no refined output"):
        save_feedback("take", draft, db)


def test_capture_deletion_removes_reports(db, monkeypatch):
    from backend import config
    monkeypatch.setattr(config, "resolve_storage_path", lambda _: None)
    save_feedback("take", request(db), db)
    assert delete_capture("take", db)
    assert db.query(CaptureFeedback).count() == 0
    assert list_feedback(db) == []


def test_missing_capture_and_snapshot_mismatch(db):
    draft = request(db)
    assert save_feedback("missing", draft, db) is None
    draft.snapshot.id = "another"
    with pytest.raises(ValueError, match="Capture changed"):
        save_feedback("take", draft, db)


def test_http_roundtrip_export_and_validation(db):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from backend.database import get_db
    from backend.routes.captures import router
    from sqlalchemy.pool import StaticPool

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(Capture(id="take", audio_path="captures/take.wav", transcript_raw="wrong words"))
        session.commit()
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_db] = lambda: session
        with TestClient(app) as client:
            snapshot = client.get("/captures/take").json()
            body = {"snapshot": snapshot, "target": "raw", "expected_text": "Right words"}
            response = client.post("/captures/take/feedback", json=body)
            assert response.status_code == 200
            assert client.get("/capture/feedback/export").json() == [response.json()]
            assert client.get("/captures/take/feedback").json() == [response.json()]
            assert client.post("/captures/missing/feedback", json=body).status_code == 404
            body["target"] = "unknown"
            assert client.post("/captures/take/feedback", json=body).status_code == 422
    engine.dispose()
