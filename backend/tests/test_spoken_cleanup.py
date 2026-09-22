"""Repeats, restarts and replaced answers are cleaned before the model sees them."""

from unittest.mock import AsyncMock

import pytest

from backend.services.content_check import check_refinement
from backend.services.refinement import RefinementFlags, prepare_refinement, refine_transcript
from backend.services.spoken_cleanup import apply_spoken_cleanup


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # Immediate repeat
        ("look at the, the budget", "look at the budget"),
        ("The, the budget is fine", "The budget is fine"),
        ("I I think so", "I think so"),
        # Repeated restart
        ("I can, I can probably get there", "I can probably get there"),
        ("then you print the, print the label", "then you print the label"),
        ("I looked through the, I looked through it", "I looked through it"),
        (
            "okay so the bug is, it only happens when you, when the user logs out",
            "okay so the bug is, it only happens when the user logs out",
        ),
        # Stuttered clause
        ("it loads, it's loading everything", "it loads everything"),
        ("but it's looking, it looks good so far", "but it looks good so far"),
        ("because it is loading, it loads everything", "because it loads everything"),
        ("it loaded, it loads everything", "it loads everything"),
        # Changed answer
        ("somebody said Wednesday, or was it Tuesday, no Wednesday", "somebody said Wednesday"),
        (
            "somebody said Wednesday in standup, or was it Tuesday, no Wednesday, I just want to check",
            "somebody said Wednesday in standup, I just want to check",
        ),
        ("set it to 3.5, no 4.5", "set it to 4.5"),
        ("set it to 3.5, no 4.5.", "set it to 4.5."),
        ("set the timeout to 3.5, no 4.5 seconds", "set the timeout to 4.5 seconds"),
        ("call Bob, no Bill", "call Bill"),
        ("Saturday afternoon, no actually Saturday evening is better", "Saturday evening is better"),
        ("meet at seven, sorry eight", "meet at eight"),
        # Refined answer
        ("we should ship Thursday, well Thursday morning probably", "we should ship Thursday morning"),
        ("ship it Thursday, well probably Thursday morning", "ship it Thursday morning"),
    ],
)
def test_rule_cleans_its_shape(raw, expected):
    assert apply_spoken_cleanup(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        # Not in scope: things said late, "no" as an answer, "well" as an opener.
        "so first pull the latest changes, oh wait, before that, make sure you're on main",
        "did it work? no, it crashed",
        "well, I think so",
        "yes, well I think so",
        # Genuine repetition
        "very, very good",
        "no, no, no",
        "I had had enough",
        "I know that that is true",
        # Technical terms and names
        "run npm install, install the deps",
        "create a list of item A, item B, and item C",
        "grades were A, A, B",
        "call Bob, no problem",
        # Not the same kind of thing, or a new clause rather than an answer
        "meet on Tuesday, no 5 people can come",
        "meet at 5, no one is coming",
        "we need 5, actually 5 is too many",
        "ask Sarah, actually Sarah knows",
        "said Wednesday in standup, or was it Tuesday",
        # Restarts that are really two phrases
        "if you can, if not",
        "we run it in the morning, in the evening",
        "I told you, I told her",
        "yes we can, yes we can",
        "it's cold, it's really cold",
        "the build fails, it fails on CI",
        # Left to the explicit-correction pass
        "Alright, my favorite candy is Bubblegum. No, no, no, it's Reese's Pieces.",
        "",
    ],
)
def test_ambiguous_or_genuine_text_is_unchanged(raw):
    assert apply_spoken_cleanup(raw) == raw


def test_prepare_refinement_cleans_without_resolving():
    cleaned, explicit = prepare_refinement("look at the, the budget, or was it Tuesday", RefinementFlags())
    assert cleaned == "look at the budget, or was it Tuesday"
    assert explicit is None


def test_prepare_refinement_respects_disabled_corrections():
    raw = "I can, I can probably get there"
    assert prepare_refinement(raw, RefinementFlags(self_correction=False)) == (raw, None)


def test_cleanup_runs_before_explicit_corrections():
    cleaned, explicit = prepare_refinement(
        "We meet on the, the Tuesday. No, actually, we meet on Thursday.", RefinementFlags()
    )
    assert explicit == "We meet on Thursday."
    assert cleaned == explicit


@pytest.mark.asyncio
async def test_cleaned_transcript_still_goes_to_the_model(monkeypatch):
    backend = type(
        "Backend", (), {"model_size": "0.6B", "generate": AsyncMock(return_value="I can probably get there.")}
    )()
    monkeypatch.setattr("backend.services.refinement.llm_service.get_llm_model", lambda: backend)
    text, _ = await refine_transcript("I can, I can probably get there", RefinementFlags())
    assert text == "I can probably get there."
    backend.generate.assert_awaited_once()
    assert backend.generate.call_args.kwargs["prompt"] == "I can probably get there"


def test_content_check_does_not_count_a_replaced_number_as_changed():
    said = "set the timeout to 3.5, no 4.5 seconds"
    kept, verdict = check_refinement(said, "Set the timeout to 4.5 seconds.", RefinementFlags())
    assert verdict.outcome == "ok"
    assert kept == "Set the timeout to 4.5 seconds."
