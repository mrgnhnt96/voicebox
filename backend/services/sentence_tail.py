"""Which sentences of a streaming cleanup are final.

Streaming dictation cleans the open tail: the raw words since the last final
sentence. A pause is often the speaker thinking mid-sentence, so the last
sentence of a cleanup stays open; the next words may continue it. Every
sentence before it is final and never cleaned again.

``settle`` finds that boundary in the cleaned text and the raw word it
corresponds to, by aligning the two word for word. It settles nothing unless
both sides of the boundary line up with words the speaker said: a boundary
placed on the wrong raw word would repeat or lose words.
"""

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

# A tail that grows past this many raw words without a sentence ending is
# settled anyway, so the cleanup after release stays about one phrase long.
# 99% of the user's cleaned sentences are shorter (p50 7, p95 21, p99 32).
MAX_OPEN_WORDS = 30

# A sentence ends after a word, not a number or list marker ("1.", "$5.").
_ENDING = re.compile(r"[^\W\d_][.?!][\"')\]\u201d\u2019]*$")


@dataclass
class Settled:
    committed: str  # final cleaned text, ending with its sentence's punctuation
    gap: str  # the whitespace the cleanup put after it
    open_cleaned: str  # the cleaned last sentence, still open
    open_raw: str  # the raw words the open sentence came from
    committed_raw: str  # the raw words before them


def _key(word: str) -> str:
    return re.sub(r"[^\w']", "", word.replace("\u2019", "'")).lower()


def _words(text: str) -> list[tuple[str, int]]:
    """Words with their start offsets; punctuation-only tokens are skipped."""
    return [(_key(m.group()), m.start()) for m in re.finditer(r"\S+", text) if _key(m.group())]


def settle(raw: str, cleaned: str) -> Settled | None:
    """Split ``cleaned`` into final sentences and the open last one, or None."""
    boundary = None
    for gap in re.finditer(r"\s+", cleaned):
        if gap.end() < len(cleaned) and ("\n" in gap.group() or _ENDING.search(cleaned[: gap.start()])):
            boundary = gap
    if boundary is None:
        return None
    raw_words = raw.split()
    said = [_key(word) for word in raw_words]
    written = _words(cleaned)
    matcher = SequenceMatcher(None, said, [key for key, _ in written], autojunk=False)
    aligned = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            aligned[block.b + offset] = block.a + offset
    first_open = next(i for i, (_, start) in enumerate(written) if start >= boundary.end())
    last_committed = first_open - 1
    if last_committed < 0 or last_committed not in aligned or first_open not in aligned:
        return None
    start = aligned[last_committed] + 1
    if aligned[first_open] < start:
        return None
    return Settled(
        committed=cleaned[: boundary.start()],
        gap=boundary.group(),
        open_cleaned=cleaned[boundary.end() :],
        open_raw=" ".join(raw_words[start:]),
        committed_raw=" ".join(raw_words[:start]),
    )
