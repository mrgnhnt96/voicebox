"""How dictation phrases cut at pauses are joined."""

import pytest

from backend.services.phrase_seams import close_phrase, join_phrases, open_phrase


@pytest.mark.parametrize(
    ("previous", "phrase", "raw", "style", "expected"),
    [
        # Whisper continued the sentence in lowercase.
        ("How", "Much is it?", "much is it?", "standard", "How much is it?"),
        ("How", "Much is it?", "much is it?", "casual", "How much is it?"),
        # A common opener in capitals starts a new sentence.
        ("It might", "But we'll see", "But we'll see", "standard", "It might. But we'll see"),
        ("It might", "But we'll see", "But we'll see", "casual", "It might, but we'll see"),
        # A capitalized name continues the sentence in either style.
        ("I talked to", "Morgan about it", "Morgan about it", "standard", "I talked to Morgan about it"),
        ("I talked to", "Morgan about it", "Morgan about it", "casual", "I talked to Morgan about it"),
        # "I" keeps its capital when lowercasing a continuation.
        ("It works", "I think", "I think", "casual", "It works, I think"),
        # A sentence Whisper already ended stays ended in standard, joins in casual.
        ("It's a 401k.", "So what's left?", "So what's left?", "standard", "It's a 401k. So what's left?"),
        ("It's a 401k.", "So what's left?", "So what's left?", "casual", "It's a 401k, so what's left?"),
        # Questions keep their mark.
        ("Is it done?", "Yes it is", "Yes it is", "casual", "Is it done? Yes it is"),
        # Spoken line breaks are kept as they are.
        ("First item\n\n", "Second item", "Second item", "casual", "First item\n\nSecond item"),
        ("", "Hello", "Hello", "standard", "Hello"),
        ("Hello", "", "", "standard", "Hello"),
    ],
)
def test_join_phrases(previous, phrase, raw, style, expected):
    assert join_phrases(previous, phrase, raw, style) == expected


def test_open_phrase_drops_only_punctuation_the_pause_added():
    assert open_phrase("It might.", "it might") == "It might"
    assert open_phrase("Wait...", "wait...") == "Wait..."
    # Whisper heard a question, so it stays one.
    assert open_phrase("Is it?", "is it?") == "Is it?"
    # A lone "how" became a question only because it was cut off.
    assert open_phrase("How?", "how") == "How"


def test_close_phrase_ends_an_open_dictation():
    assert close_phrase("It might") == "It might."
    assert close_phrase("Is it?") == "Is it?"
    assert close_phrase("") == ""
