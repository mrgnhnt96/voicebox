"""Learning punctuation habits from calibration rewrites and applying them."""

from datetime import datetime
from unittest.mock import AsyncMock

import pytest

from backend import config
from backend.database.models import Capture
from backend.services import writing_style
from backend.services.refinement import (
    REFINEMENT_EXAMPLES,
    RefinementFlags,
    build_refinement_prompt,
    refine_transcript,
    refinement_examples,
)
from backend.services.writing_style import RUN_LENGTH
from backend.services.writing_style_paragraphs import BY_ID, PARAGRAPHS, SITUATIONS

CASUAL = {
    "boundary": "comma",
    "lowercase_start": False,
    "drop_intro_comma": True,
    "drop_conjunction_comma": True,
    "drop_final_period": True,
}


@pytest.fixture(autouse=True)
def profile(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "_data_dir", tmp_path)
    monkeypatch.setattr(writing_style, "_state", None)
    monkeypatch.setattr(writing_style, "_sessions", {})
    # Draw the first paragraph of each situation so runs are repeatable.
    monkeypatch.setattr(writing_style.random, "choice", lambda options: options[0])


def test_observe_counts_each_kind_of_choice():
    shown = "Yeah, that works. I can go at seven, but traffic is bad. Do you want food?"
    written = "yeah that works, I can go at seven but traffic is bad. do you want food?"
    counts = writing_style.observe(shown, written)
    assert counts["boundary"] == {"period": 1, "comma": 1, "none": 0}
    assert counts["intro_comma"] == {"kept": 0, "dropped": 1}
    assert counts["conjunction_comma"] == {"kept": 0, "dropped": 1}
    assert counts["lowercase_start"] == {"yes": 2, "no": 0}


def test_observe_ignores_words_the_user_rewrote():
    counts = writing_style.observe("It works. Ship it.", "Totally different words here")
    assert counts["boundary"] == {"period": 0, "comma": 0, "none": 0}


def test_final_period_is_counted_only_at_the_end():
    counts = writing_style.observe("That works for me.", "That works for me")
    assert counts["final_period"] == {"kept": 0, "dropped": 1}


def test_decide_needs_evidence_and_breaks_ties_toward_the_period():
    one = writing_style.observe("It works. Ship it.", "It works, ship it.")
    assert writing_style.decide(one)["boundary"] is None
    tie = writing_style._merge(one, writing_style.observe("It works. Ship it.", "It works. Ship it."))
    assert writing_style.decide(tie)["boundary"] == "period"


def test_apply_style_changes_only_punctuation_and_first_letters():
    text = "Quick update. The fix is merged, and QA is next. So we ship Thursday."
    styled = writing_style.apply_style(text, CASUAL)
    assert styled == "Quick update, the fix is merged and QA is next, so we ship Thursday"
    assert [w.strip(",.").casefold() for w in styled.split()] == [w.strip(",.").casefold() for w in text.split()]


def test_apply_style_keeps_i_acronyms_line_breaks_and_questions():
    text = "It works. I tested it. API calls pass.\nNext. Is it done? Yes."
    styled = writing_style.apply_style(text, {**CASUAL, "drop_final_period": False})
    assert styled == "It works, I tested it, API calls pass.\nNext, is it done? Yes."


def test_standard_habits_leave_text_alone():
    habits = writing_style.decide(writing_style._empty_counts())
    assert writing_style.apply_style("It works. Ship it.", habits) == "It works. Ship it."


def test_every_run_covers_each_situation():
    ids = writing_style._pick_paragraphs([])
    assert [BY_ID[i].situation for i in ids] == list(SITUATIONS)
    assert len(PARAGRAPHS) >= 2 * len(SITUATIONS)


# Stand-ins for Voicebox's cleanup of each calibration paragraph, written
# the way Standard punctuates so the rewrites carry punctuation habits.
CLEANED = [
    "Yeah, that works. I can get there at seven, but traffic is bad. Do you want food?",
    "Okay, quick update. The fix is merged. QA is next, and it looks good.",
    "Hey, when is the report due? I thought Friday, but someone said Wednesday.",
    "First, pull the changes. Then run the script, and start the server.",
    "So, the page is slow. It loads everything at once, and most is hidden.",
]


def _rewrite(text):
    return writing_style.apply_style(text, CASUAL)


def _run(rewrite=_rewrite, finish=True):
    """A whole calibration run with CLEANED standing in for the model's cleanup."""
    started = writing_style.start_calibration()
    session_id = started["session_id"]
    step = writing_style.present(session_id, CLEANED[0])
    for index in range(RUN_LENGTH):
        result = writing_style.submit_step(session_id, rewrite(step["paragraph"]))
        if result["done"]:
            break
        step = writing_style.present(session_id, CLEANED[index + 1])
    if finish:
        writing_style.finish_calibration(session_id)
    return session_id, result


def test_calibration_shows_what_was_said_and_the_cleanup():
    started = writing_style.start_calibration()
    said = BY_ID[writing_style._sessions[started["session_id"]]["paragraphs"][0]].said
    assert started["said"] == said
    step = writing_style.present(started["session_id"], CLEANED[0])
    assert (step["step"], step["total"], step["said"], step["paragraph"]) == (0, 5, said, CLEANED[0])
    assert step["done"] is False


def test_calibration_learns_habits_and_saves_examples():
    _, result = _run(finish=False)
    assert result["done"]
    assert "boundary_comma" in result["habits"]
    assert not writing_style.is_ready()
    _run()
    status = writing_style.status()
    assert status["ready"]
    assert status["runs"] == 1
    assert status["example_count"] == 5
    assert (config.get_data_dir() / "writing-style.json").is_file()
    saved = writing_style._load()["examples"]
    assert [e["said"] for e in saved] == [BY_ID[p].said for p in (e["paragraph_id"] for e in saved)]


def test_each_rewrite_feeds_the_next_cleanup():
    started = writing_style.start_calibration()
    session_id = started["session_id"]
    writing_style.present(session_id, CLEANED[0])
    result = writing_style.submit_step(session_id, "Yeah that works, I can get there at seven")
    assert result == {"done": False, "said": BY_ID[writing_style._sessions[session_id]["paragraphs"][1]].said}
    assert writing_style.session_examples(session_id) == [
        (started["said"], "Yeah that works, I can get there at seven")
    ]


def test_calibration_errors_and_reset():
    with pytest.raises(KeyError):
        writing_style.submit_step("missing", "text")
    started = writing_style.start_calibration()
    writing_style.present(started["session_id"], CLEANED[0])
    with pytest.raises(ValueError, match="Rewrite the paragraph"):
        writing_style.submit_step(started["session_id"], "   ")
    with pytest.raises(ValueError, match="at least one paragraph"):
        writing_style.finish_calibration(started["session_id"])
    _run()
    assert writing_style.status()["runs"] == 1
    writing_style.reset()
    assert writing_style.status() == {
        "ready": False,
        "runs": 0,
        "last_run_at": None,
        "example_count": 0,
        "habits": [],
    }


def _learn_casual():
    _run()


def test_learned_style_has_its_own_prompt_and_example():
    learned = RefinementFlags(punctuation_style="learned")
    # Nothing learned yet: Match my writing punctuates like Standard.
    assert build_refinement_prompt(learned) == build_refinement_prompt(RefinementFlags())
    assert refinement_examples(learned) is REFINEMENT_EXAMPLES
    _learn_casual()
    prompt = build_refinement_prompt(learned)
    assert "Punctuation style: match how this speaker writes." in prompt
    assert "- Join related thoughts with commas instead of starting new sentences." in prompt
    assert '- Do not put a comma before "and", "but", "so" or "or".' in prompt
    assert "written prose" not in prompt
    assert "Punctuation style: casual." not in prompt
    said, written = refinement_examples(learned)[0]
    latest = writing_style._load()["examples"][-1]
    assert (said, written) == (latest["said"], latest["written"])
    assert refinement_examples(learned)[1:] == REFINEMENT_EXAMPLES


def test_unedited_calibration_gives_no_example():
    _run(rewrite=lambda text: text)
    assert writing_style.prompt_example() is None


class _Backend:
    model_size = "0.6B"

    async def generate(self, **_):
        return "Quick update. The fix is merged, and QA is next."


@pytest.mark.asyncio
async def test_learned_style_restyles_refined_text():
    _learn_casual()
    text, _ = await refine_transcript(
        "quick update the fix is merged and qa is next",
        RefinementFlags(punctuation_style="learned"),
        backend_override=_Backend(),
        use_personal_model=False,
    )
    assert text == "Quick update, the fix is merged and QA is next"


def _app(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from backend.database import get_db
    from backend.database.models import Base
    from backend.routes import writing_style as routes

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)
    cleanups = iter(CLEANED + CLEANED)

    async def refine(said, flags, **options):
        return next(cleanups), "0.6B"

    refine_mock = AsyncMock(side_effect=refine)
    monkeypatch.setattr(routes, "refine_transcript", refine_mock)
    monkeypatch.setattr(routes, "check_refinement", lambda said, refined, flags: (refined, None))
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[get_db] = lambda: session()
    return TestClient(app), session, refine_mock


def test_calibration_api_round_trip(monkeypatch):
    client, _, refine = _app(monkeypatch)
    assert client.get("/writing-style").json()["ready"] is False
    step = client.post("/writing-style/calibration").json()
    assert step["said"]
    assert step["paragraph"] == CLEANED[0]
    for index in range(step["total"]):
        response = client.post(
            f"/writing-style/calibration/{step['session_id']}/steps", json={"written": _rewrite(step["paragraph"])}
        )
        assert response.status_code == 200
        step = response.json()
        if index < 4:
            # The rewrites so far go with the next cleanup.
            assert len(refine.await_args.kwargs["extra_examples"]) == index + 1
    assert step["done"] is True
    result = client.post(f"/writing-style/calibration/{step['session_id']}/finish").json()
    assert result["status"]["ready"] is True
    # No dictations yet: a calibration paragraph is cleaned without, then with, examples.
    assert refine.await_args_list[-2].kwargs["use_personal_examples"] is False
    assert refine.await_args_list[-1].kwargs["use_personal_examples"] is True
    assert client.post("/writing-style/calibration/expired/steps", json={"written": "x"}).status_code == 404
    assert client.delete("/writing-style").json()["runs"] == 0


def test_cleanup_failure_shows_what_was_said(monkeypatch):
    client, _, refine = _app(monkeypatch)
    refine.side_effect = RuntimeError("model not downloaded")
    step = client.post("/writing-style/calibration").json()
    assert step["paragraph"] == step["said"]


def test_preview_uses_the_newest_dictation_long_enough_to_restructure(monkeypatch):
    client, session, refine = _app(monkeypatch)
    with session() as db:
        db.add(Capture(id="short", audio_path="a.wav", transcript_raw="it might", transcript_refined="It might."))
        db.add(
            Capture(
                id="long",
                audio_path="b.wav",
                transcript_raw="so I was thinking we should, the release, we should push the release to Friday",
                transcript_refined="So I was thinking we should, the release, we should push the release to Friday.",
                created_at=datetime(2020, 1, 1),
            )
        )
        db.commit()
    _, result = _run(finish=False)
    session_id = result["session_id"]
    preview = client.post(f"/writing-style/calibration/{session_id}/finish").json()
    assert preview["before"] == "So I was thinking we should, the release, we should push the release to Friday."
    assert refine.await_args.args[0] == "so I was thinking we should, the release, we should push the release to Friday"
