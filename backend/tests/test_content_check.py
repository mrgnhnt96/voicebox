"""The content check: restructuring passes, possible content changes get a review."""

import pytest

from backend.services.content_check import check, check_refinement, summarize_reviews
from backend.services.refinement import RefinementFlags


@pytest.mark.parametrize(
    ("said", "cleaned"),
    [
        ("so I was thinking we should, we should push it", "I was thinking we should push it."),
        ("the tests the tests aren't done", "The tests aren't done."),
        ("if I am making 180,000 a year", "If I'm making $180,000 a year."),
        ("no wait I meant Friday", "I meant Friday."),
    ],
)
def test_restructuring_passes(said, cleaned):
    assert check(said, cleaned).outcome == "ok"


def test_new_words_are_listed_for_review():
    verdict = check("send the notes", "Send the notes and the slides.")
    assert (verdict.outcome, verdict.added, verdict.missing) == ("review", ["slides"], [])


def test_dropping_much_of_what_was_said_is_reviewed():
    verdict = check("book flights hotel and a car for the trip", "Book flights for the trip.")
    assert verdict.outcome == "review"
    assert verdict.missing == ["car", "hotel"]


def test_answering_instead_of_cleaning_is_rejected():
    verdict = check("what is the capital of France", "The capital of France is Paris, a city famous for art.")
    assert (verdict.outcome, verdict.reason) == ("reject", "answered")


def test_self_correction_may_drop_the_retracted_words():
    flags = RefinementFlags()
    text, verdict = check_refinement(
        "the meeting is on Tuesday actually Wednesday", "The meeting is on Wednesday.", flags
    )
    assert (text, verdict.outcome) == ("The meeting is on Wednesday.", "ok")


def test_summary_takes_the_worst_outcome_and_joins_words():
    reviews = [check("send the notes", "Send the notes and slides."), check("do not ship", "Ship.")]
    assert summarize_reviews(reviews) == {
        "outcome": "reject",
        "added": ["slides"],
        "missing": ["not"],
        "reasons": ["negation"],
    }
    assert summarize_reviews([check("hello", "Hello.")]) is None
