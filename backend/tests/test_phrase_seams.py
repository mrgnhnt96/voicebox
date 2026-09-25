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


@pytest.mark.parametrize(
    ("heard", "expected"),
    [
        # Whisper's endings for a phrase cut off at a pause.
        ("Wait, but if I pause-", "Wait, but if I pause"),
        ("for a-", "for a"),
        ("second.", "second"),
        ("How...", "How"),
        ("How\u2026", "How"),
        ("so the \u2014", "so the \u2014"),
        # Marks the speaker may have meant stay for cleanup to judge.
        ("that my pauses cannot be cleaned?", "that my pauses cannot be cleaned?"),
        ("wow!", "wow!"),
        # An abbreviation's period isn't an ending.
        ("we moved to the U.S.", "we moved to the U.S."),
        ("it costs $5 (maybe).", "it costs $5 (maybe)"),
        ("", ""),
    ],
)
def test_strip_pause_mark(heard, expected):
    from backend.services.phrase_seams import strip_pause_mark

    assert strip_pause_mark(heard) == expected


@pytest.mark.parametrize(
    ("phrase", "earlier", "expected"),
    [
        ("Does that mean-", "Wait, but if I pause for a second.", "does that mean-"),
        ("Pauses.", "that my pauses cannot be cleaned from in between.", "pauses."),
        # "I" and acronyms keep their capitals.
        ("I think so", "It works.", "I think so"),
        ("VS Code is open", "I was using it.", "VS Code is open"),
        # A word capitalized mid-sentence anywhere in the dictation is a name.
        ("Sagar is not focused", "I have to hit enter twice in Sagar.", "Sagar is not focused"),
        ("Sagar said so, ask Sagar", "Hello.", "Sagar said so, ask Sagar"),
        ("already lowercase", "fine.", "already lowercase"),
        ("", "", ""),
    ],
)
def test_continue_phrase_drops_the_capital_a_pause_added(phrase, earlier, expected):
    from backend.services.phrase_seams import continue_phrase

    assert continue_phrase(phrase, earlier) == expected
