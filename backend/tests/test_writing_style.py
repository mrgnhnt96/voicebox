"""Learning punctuation habits from calibration rewrites and applying them."""

from unittest.mock import MagicMock

import pytest

from backend import config
from backend.services import writing_style
from backend.services.refinement import (
    REFINEMENT_EXAMPLES,
    RefinementFlags,
    build_refinement_prompt,
    refine_transcript,
    refinement_examples,
)
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


def _rewrite(text):
    return writing_style.apply_style(text.replace("I'll", "I will"), CASUAL).replace("I will", "I'll")


def test_calibration_learns_and_styles_the_next_paragraph():
    step = writing_style.start_calibration()
    assert (step["step"], step["total"], step["habits"]) == (0, 5, [])
    original = BY_ID[writing_style._sessions[step["session_id"]]["paragraphs"][0]].text
    assert step["paragraph"] == original
    session_id = step["session_id"]
    for index in range(5):
        written = _rewrite(step["paragraph"])
        step = writing_style.submit_step(session_id, written)
        assert step["step"] == index + 1
        if index < 4:
            assert not step["done"]
    assert step["done"]
    assert "boundary_comma" in step["habits"]
    assert not writing_style.is_ready()
    status = writing_style.finish_calibration(session_id)
    assert status["ready"]
    assert status["runs"] == 1
    assert status["example_count"] == 5
    assert (config.get_data_dir() / "writing-style.json").is_file()


def test_later_paragraphs_arrive_styled():
    step = writing_style.start_calibration()
    session_id = step["session_id"]
    step = writing_style.submit_step(session_id, _rewrite(step["paragraph"]))
    session = writing_style._sessions[session_id]
    original = BY_ID[session["paragraphs"][1]].text
    assert step["paragraph"] != original
    # Examples keep the Standard paragraph so undoing a habit is evidence too.
    assert session["examples"][0]["shown"] == BY_ID[session["paragraphs"][0]].text


def test_calibration_errors_and_reset():
    with pytest.raises(KeyError):
        writing_style.submit_step("missing", "text")
    step = writing_style.start_calibration()
    with pytest.raises(ValueError, match="Rewrite the paragraph"):
        writing_style.submit_step(step["session_id"], "   ")
    with pytest.raises(ValueError, match="at least one paragraph"):
        writing_style.finish_calibration(step["session_id"])
    step = writing_style.start_calibration()
    writing_style.submit_step(step["session_id"], _rewrite(step["paragraph"]))
    writing_style.finish_calibration(step["session_id"])
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
    step = writing_style.start_calibration()
    for _ in range(5):
        step = writing_style.submit_step(step["session_id"], _rewrite(step["paragraph"]))
    writing_style.finish_calibration(step["session_id"])


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
    raw, written = refinement_examples(learned)[0]
    assert written == writing_style._load()["examples"][-1]["written"]
    assert raw == raw.casefold()
    assert "." not in raw
    assert "," not in raw
    assert refinement_examples(learned)[1:] == REFINEMENT_EXAMPLES


def test_unedited_calibration_gives_no_example():
    step = writing_style.start_calibration()
    writing_style.submit_step(step["session_id"], step["paragraph"])
    writing_style.finish_calibration(step["session_id"])
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


def test_calibration_api_round_trip():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from backend.database import get_db
    from backend.database.models import Base
    from backend.routes.writing_style import router

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: session()
    client = TestClient(app)

    assert client.get("/writing-style").json()["ready"] is False
    step = client.post("/writing-style/calibration").json()
    assert step["done"] is False
    for _ in range(step["total"]):
        response = client.post(
            f"/writing-style/calibration/{step['session_id']}/steps", json={"written": _rewrite(step["paragraph"])}
        )
        assert response.status_code == 200
        step = response.json()
    assert step["done"] is True
    result = client.post(f"/writing-style/calibration/{step['session_id']}/finish").json()
    assert result["status"]["ready"] is True
    # No dictations yet, so the preview uses a calibration paragraph.
    assert result["before"] == BY_ID["explanation-cache"].text
    assert result["after"] != result["before"]
    assert client.post("/writing-style/calibration/expired/steps", json={"written": "x"}).status_code == 404
    assert client.delete("/writing-style").json()["runs"] == 0


def test_preview_uses_the_dictation_the_style_changes_most(monkeypatch):
    from backend.routes import writing_style as routes

    db = MagicMock()
    # Newest first: the latest dictation is too short to restyle.
    rows = [("It might.",), ("Okay. So it works. Ship it.",), ("It works. Ship it.",)]
    db.query.return_value.filter.return_value.order_by.return_value.limit.return_value.all.return_value = rows

    _learn_casual()
    before, after = routes._preview(db)
    assert before == "Okay. So it works. Ship it."
    assert after != before
