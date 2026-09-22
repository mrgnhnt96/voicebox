"""The user's own examples: collected, matched to a transcript, and used by cleanup."""

import json
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend import config
from backend.database import session as database_session
from backend.database.models import Base, Capture, CaptureFeedback
from backend.services import personal_examples, writing_style
from backend.services.refinement import (
    REFINEMENT_EXAMPLES,
    RefinementFlags,
    build_refinement_prompt,
    refine_transcript,
)


@pytest.fixture(autouse=True)
def storage(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "_data_dir", tmp_path)
    monkeypatch.setattr(writing_style, "_state", None)
    monkeypatch.setattr(personal_examples, "_cache", None)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)
    monkeypatch.setattr(database_session, "SessionLocal", session)
    return session


def _correct(storage, said, meant, capture_id=None, target="refined"):
    with storage() as db:
        capture = Capture(id=capture_id or said[:20], audio_path="a.wav", transcript_raw=said)
        db.add(capture)
        db.add(
            CaptureFeedback(
                capture_id=capture.id,
                target=target,
                expected_text=meant,
                snapshot=json.dumps({"transcript_raw": said, "transcript_refined": said}),
            )
        )
        db.commit()
    personal_examples.invalidate()


def test_refined_corrections_become_examples(storage):
    _correct(storage, "so the release we need to push the release to friday", "We need to push the release to Friday.")
    _correct(storage, "teh cat", "the cat", target="raw")
    examples = personal_examples.all_examples()
    assert [(e["source"], e["said"], e["meant"]) for e in examples] == [
        ("correction", "so the release we need to push the release to friday", "We need to push the release to Friday.")
    ]


def test_closest_examples_come_last_and_fill_with_newest(storage):
    _correct(storage, "lunch plans for thursday with the team", "Lunch with the team on Thursday.", "a")
    _correct(storage, "push the release to friday the release", "Push the release to Friday.", "b")
    _correct(storage, "the dog needs a walk", "The dog needs a walk.", "c")
    closest = personal_examples.closest("can we push the release to next week", count=2)
    assert closest[-1][0] == "push the release to friday the release"
    assert len(closest) == 2


def test_hidden_examples_are_left_out(storage):
    _correct(storage, "so we should we should ship it", "We should ship it.")
    example_id = personal_examples.all_examples()[0]["id"]
    assert personal_examples.hide(example_id)
    assert personal_examples.all_examples() == []
    assert not personal_examples.hide("correction:missing")


def test_edited_calibration_rewrites_are_examples_and_unedited_are_not():
    step = writing_style.start_calibration()
    step = writing_style.submit_step(step["session_id"], step["paragraph"])
    writing_style.submit_step(step["session_id"], "totally rewritten paragraph")
    writing_style.finish_calibration(step["session_id"])
    examples = personal_examples.all_examples()
    assert [e["source"] for e in examples] == ["calibration"]
    assert examples[0]["meant"] == "totally rewritten paragraph"


def test_prompt_allows_restructuring_only_with_examples():
    assert "Drop false starts" not in build_refinement_prompt(RefinementFlags())
    assert "Keep their vocabulary." in build_refinement_prompt(RefinementFlags())
    personal = build_refinement_prompt(RefinementFlags(), personal=True)
    assert "Drop false starts, repeated words and abandoned half-sentences." in personal
    assert "Keep their vocabulary." not in personal


@pytest.mark.asyncio
async def test_refinement_sends_the_users_examples_after_the_defaults(storage):
    _correct(storage, "so the release we need to push the release to friday", "We need to push the release to Friday.")
    backend = type("Backend", (), {"model_size": "0.6B", "generate": AsyncMock(return_value="Push it to Friday.")})()
    await refine_transcript("push it to friday", RefinementFlags(), backend_override=backend, use_personal_model=False)
    arguments = backend.generate.await_args.kwargs
    assert arguments["examples"][: len(REFINEMENT_EXAMPLES)] == REFINEMENT_EXAMPLES
    assert arguments["examples"][-1] == (
        "so the release we need to push the release to friday",
        "We need to push the release to Friday.",
    )
    assert "Drop false starts" in arguments["system"]
    await refine_transcript(
        "push it to friday",
        RefinementFlags(),
        backend_override=backend,
        use_personal_model=False,
        use_personal_examples=False,
    )
    assert backend.generate.await_args.kwargs["examples"] == REFINEMENT_EXAMPLES


@pytest.mark.asyncio
async def test_refining_a_capture_keeps_and_flags_possible_content_changes(storage, monkeypatch):
    from backend.services import captures

    monkeypatch.setattr(
        captures, "refine_transcript", AsyncMock(return_value=("Send the notes and the slides.", "0.6B"))
    )
    with storage() as db:
        db.add(Capture(id="c1", audio_path="a.wav", transcript_raw="send the notes"))
        db.commit()
        output = await captures.refine_capture("c1", RefinementFlags(), None, db)
    assert output.transcript_refined == "Send the notes and the slides."
    assert output.refinement_review.model_dump() == {
        "outcome": "review",
        "added": ["slides"],
        "missing": [],
        "reasons": [],
    }


def test_examples_api_lists_and_removes(storage):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.routes.writing_style import router

    _correct(storage, "so we should we should ship it", "We should ship it.")
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    examples = client.get("/writing-style/examples").json()
    assert [e["meant"] for e in examples] == ["We should ship it."]
    assert client.delete(f"/writing-style/examples/{examples[0]['id']}").status_code == 204
    assert client.get("/writing-style/examples").json() == []
    assert client.delete("/writing-style/examples/missing").status_code == 404
