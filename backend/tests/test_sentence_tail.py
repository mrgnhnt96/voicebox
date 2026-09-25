"""Which cleaned sentences are final, and which raw words are still open."""

import pytest

from backend.services.sentence_tail import settle


def test_every_sentence_but_the_last_is_settled():
    result = settle(
        "wait but if I pause for a second does that mean my pauses",
        "Wait, but if I pause for a second. Does that mean my pauses",
    )
    assert result.committed == "Wait, but if I pause for a second."
    assert result.gap == " "
    assert result.open_cleaned == "Does that mean my pauses"
    assert result.open_raw == "does that mean my pauses"
    assert result.committed_raw == "wait but if I pause for a second"


def test_a_single_sentence_stays_open():
    assert settle("does that mean my pauses", "Does that mean my pauses.") is None


def test_several_sentences_settle_at_the_last_boundary():
    result = settle(
        "okay the fix is merged we're waiting on QA if nothing comes up",
        "Okay, the fix is merged. We're waiting on QA. If nothing comes up",
    )
    assert result.committed == "Okay, the fix is merged. We're waiting on QA."
    assert result.open_raw == "if nothing comes up"


def test_words_cleanup_dropped_at_the_boundary_stay_open():
    # Dropped words are cleaned again with the open sentence; content is
    # never lost at a boundary and never cleaned twice.
    result = settle("the build passed um so and the tests", "The build passed. And the tests")
    assert result.committed == "The build passed."
    assert result.open_raw == "um so and the tests"
    assert result.committed_raw == "the build passed"


def test_no_boundary_when_the_open_sentence_does_not_start_on_a_raw_word():
    # "Going" isn't a word the speaker said, so where the open sentence starts
    # in the raw text can't be pinned down.
    assert settle("the build passed gonna ship it", "The build passed. Going to ship it") is None


def test_no_boundary_when_the_settled_sentence_does_not_end_on_a_raw_word():
    # "OK." replaced "okay"; re-cleaning from the wrong word would repeat it.
    assert settle("sounds good okay let me check", "Sounds good, OK. Let me check") is None


def test_line_breaks_are_boundaries_and_are_kept():
    result = settle(
        "here is a list new line bananas new line peppers",
        "Here is a list:\nBananas\nPeppers",
    )
    assert result.committed == "Here is a list:\nBananas"
    assert result.gap == "\n"
    assert result.open_cleaned == "Peppers"
    # The spoken "new line" was dropped at the boundary, so it stays open.
    assert result.open_raw == "new line peppers"


@pytest.mark.parametrize(
    ("raw", "cleaned"),
    [
        # A number or initial ending in a period doesn't end a sentence.
        ("step 1 go to school", "1. Go to school"),
        ("it costs 5 dollars so", "It costs $5. So"),
        ("", ""),
    ],
)
def test_no_boundary_without_a_sentence_ending_word(raw, cleaned):
    assert settle(raw, cleaned) is None
