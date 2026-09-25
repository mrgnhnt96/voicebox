"""Join dictation phrases that were cut at pauses.

Streaming dictation recognizes and refines each phrase on its own, so every
phrase would otherwise come back punctuated as a finished sentence. A pause is
a breath, not a sentence end: phrases stay open while dictation continues and
the seam between two phrases is decided once the next one arrives.

Whisper is given the earlier text when it recognizes a phrase, so the casing of
its first word says whether the speaker continued the sentence. A capitalized
first word is only treated as a new sentence when it is a common sentence
opener; anything else is assumed to be a name continuing the sentence.

Streaming cleanup now sees a whole open sentence at a time
(sentence_tail.py), so joins happen only where a long tail is settled
mid-sentence. Before cleanup, ``strip_pause_mark`` and ``continue_phrase``
remove the ending and capital Whisper gives a phrase only because the audio
paused.
"""

import re

# fmt: off
_SENTENCE_OPENERS = frozenset((
    "a", "an", "the", "this", "that", "these", "those", "there", "here", "it", "its", "i", "we", "you", "he", "she",
    "they", "my", "our", "your", "his", "her", "their", "and", "but", "so", "or", "yet", "also", "then", "now",
    "well", "okay", "ok", "yeah", "yes", "no", "oh", "anyway", "plus", "still", "though", "although", "because",
    "since", "if", "when", "while", "after", "before", "once", "until", "unless", "as", "maybe", "perhaps",
    "actually", "honestly", "basically", "hopefully", "apparently", "otherwise", "meanwhile", "instead", "besides",
    "however", "what", "why", "how", "who", "whom", "whose", "where", "which", "is", "are", "was", "were", "am",
    "be", "been", "do", "does", "did", "don", "doesn", "didn", "have", "has", "had", "haven", "hasn", "can",
    "can't", "cannot", "could", "couldn", "will", "won", "would", "wouldn", "should", "shouldn", "shall", "may",
    "might", "must", "let", "let's", "not", "just", "only", "even", "please", "thanks", "thank", "sure", "all",
    "some", "any", "every", "each", "both", "either", "neither", "one", "two", "first", "next", "last", "lastly",
    "finally",
))
# fmt: on

_TERMINAL = ".?!:;"


def _first_word(text: str) -> str:
    match = re.match(r"\W*([^\W\d_][\w']*)", text)
    return match.group(1) if match else ""


def _starts_sentence(raw: str) -> bool:
    word = _first_word(raw)
    if not word or not word[0].isupper():
        return False
    key = word.casefold().replace("\u2019", "'")
    return key in _SENTENCE_OPENERS or key.split("'")[0] in _SENTENCE_OPENERS


def _lower_first(text: str) -> str:
    word = _first_word(text)
    # "I" and its contractions stay capitalized; so do acronyms.
    if not word or word == "I" or word.startswith(("I'", "I\u2019")) or (len(word) > 1 and word.isupper()):
        return text
    index = text.index(word)
    return text[:index] + word[0].lower() + text[index + 1 :]


def open_phrase(text: str, raw: str) -> str:
    """Drop end punctuation the phrase got only because the audio paused.

    A closing period always goes; a question or exclamation mark goes only when
    Whisper, which heard the earlier text, didn't end the phrase with it.
    """
    text = text.rstrip()
    heard = raw.rstrip()[-1:]
    if re.search(r"[\w)\"'\u201d][?!]$", text) and text[-1] != heard:
        return text[:-1]
    return re.sub(r"(?<=[\w)\"'\u201d])\.$", "", text)


def strip_pause_mark(text: str) -> str:
    """Drop the ending Whisper gives a phrase only because the audio paused.

    Cut off at a pause, Whisper ends the phrase as if it were finished: a
    period, a trailing dash ("if I pause-"), or dots ("How..."). None of that
    was said. A question or exclamation mark stays: it can be the speaker's
    own, and cleanup decides with the rest of the sentence in view. So does
    the period of an abbreviation ("U.S."), which isn't an ending.
    """
    stripped = text.rstrip()
    last = stripped.split()[-1] if stripped else ""
    if re.search(r"[\w)\"'\u201d](?:\.{2,}|\u2026|[-\u2013\u2014]+)$", stripped):
        return re.sub(r"(?:\.{2,}|\u2026|[-\u2013\u2014]+)$", "", stripped)
    if re.search(r"[\w)\"'\u201d]\.$", stripped) and "." not in last[:-1]:
        return stripped[:-1]
    return stripped


def _mid_sentence_capitals(text: str) -> set[str]:
    """Words ``text`` capitalizes where no sentence starts: names and the like."""
    words = text.split()
    kept = set()
    for before, word in zip(words, words[1:], strict=False):
        first = _first_word(word)
        if first and first[0].isupper() and not re.search(r"[.?!:\u2026-]$", before):
            kept.add(first)
    return kept


def continue_phrase(phrase: str, earlier: str) -> str:
    """Lowercase the capital Whisper gives a phrase only because it began after a pause.

    ``I``, acronyms and words capitalized mid-sentence in ``earlier`` (the
    dictation before this phrase) or later in the phrase itself keep their
    capitals: those are names, not sentence starts.
    """
    word = _first_word(phrase)
    if not word or not word[0].isupper():
        return phrase
    if word in _mid_sentence_capitals(earlier) | _mid_sentence_capitals(phrase):
        return phrase
    return _lower_first(phrase)


def close_phrase(text: str) -> str:
    """End a finished dictation that was left open at its last pause."""
    stripped = text.rstrip()
    if re.search(r"[\w)\"'\u201d]$", stripped):
        return stripped + "."
    return text


def join_phrases(previous: str, phrase: str, raw_phrase: str, style: str) -> str:
    """Attach ``phrase`` to ``previous`` across a pause.

    ``raw_phrase`` is what Whisper heard for ``phrase``; its casing decides
    whether the speaker continued the sentence or began a new one.
    """
    before = previous.rstrip()
    if not before:
        return phrase
    if not phrase:
        return previous
    # Spoken formatting may end a phrase with a line or paragraph break.
    whitespace = previous[len(before) :] if "\n" in previous[len(before) :] else " "
    new_sentence = _starts_sentence(raw_phrase)
    casual = style == "casual"

    if whitespace != " ":
        return f"{before}{whitespace}{phrase}"
    if before[-1] in _TERMINAL:
        if casual and new_sentence and before[-1] == "." and not before.endswith(".."):
            return f"{before[:-1]}, {_lower_first(phrase)}"
        return f"{before} {phrase}"
    if before[-1] == ",":
        return f"{before} {_lower_first(phrase) if casual or not new_sentence else phrase}"
    if not re.search(r"[\w)\"'\u201d]$", before):
        return f"{before} {phrase}"
    if not new_sentence:
        first = _first_word(raw_phrase)
        return f"{before} {_lower_first(phrase) if first and first[0].islower() else phrase}"
    if casual:
        return f"{before}, {_lower_first(phrase)}"
    return f"{before}. {phrase}"
