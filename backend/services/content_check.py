"""Does cleaned-up text still say what the speaker said?

Cleanup may restructure: drop false starts and repeats, reorder a jumbled
sentence, fix grammar. It must not add ideas, summarize, or leave something
out. This compares the meaning-carrying words of the transcript and the
cleanup and returns one of three verdicts:

- ``ok``: nothing but structure changed.
- ``review``: content may have been added or left out. The cleanup is kept
  and the capture is flagged so the user can check it.
- ``reject``: the cleanup is not safe to paste, so the transcript is used and
  the capture is flagged. That is when the model answered or obeyed the
  dictation instead of cleaning it up, or when a negation, a number or a
  technical term changed, since those flip or break the meaning.
"""

import re
import unicodedata
from dataclasses import dataclass, field

_FUNCTION_WORDS = frozenset(
    re.findall(
        r"\S+",
        """
    a an the and or but so yet nor to of in on at for with from by as into onto about than then that this these those
    there here it its it's i i'm i've i'll i'd me my mine you you're your yours we we're our us they they're their them
    he she his her him is are was were be been being am do does did done have has had having will would can could
    should shall may might must just like really very actually basically literally kind sort mean know well okay ok
    yeah oh um uh er hmm ah some any all what which who whom whose when where why how if because while also too wait right anyway
    """,
    )
)
# "no" is left out: as an interjection ("no wait, actually...") a cleanup drops it.
_NEGATIONS = frozenset(
    re.findall(
        r"\S+",
        """
    not never nothing none nobody neither nor cannot can't don't doesn't didn't isn't aren't wasn't weren't won't
    wouldn't shouldn't couldn't haven't hasn't hadn't mustn't without
    """,
    )
)
_FILLERS = frozenset(("um", "uh", "er", "hmm", "ah"))
_TOKEN = re.compile(r"[+-]?\d+(?:[.,]\d+)*%?|[\w'./-]*\w")
# The model answered or obeyed instead of cleaning up when it added this many
# content words, or this share of the transcript's, whichever is larger.
ANSWERED_WORDS = 4
ANSWERED_SHARE = 0.5
# A few dropped words are normal for false starts; more gets a review.
MISSING_SHARE = 0.3


@dataclass
class Verdict:
    outcome: str
    added: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    reason: str | None = None

    def to_dict(self) -> dict:
        return {"outcome": self.outcome, "added": self.added, "missing": self.missing, "reason": self.reason}


def _tokens(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", text).casefold().replace("\u2019", "'").replace("\u2212", "-")
    tokens = []
    for token in _TOKEN.findall(normalized):
        # A sign belongs to a number ("-3.5"); anywhere else it is punctuation.
        token = token.rstrip("./-'") if _is_number(token.rstrip(".")) else token.strip("./-'")
        if token and token not in _FILLERS:
            tokens.append(token)
    return tokens


def _is_number(token: str) -> bool:
    return bool(re.fullmatch(r"[+-]?\d+(?:[.,]\d+)*%?", token))


def _is_technical(token: str) -> bool:
    return bool(re.search(r"\w[_/.]\w", token)) and not _is_number(token)


def _parts(token: str) -> list[str]:
    return [part for part in re.split(r"[_/.-]+", token) if part]


def _number(token: str) -> str:
    return token.replace(",", "")


def check(said: str, cleaned: str) -> Verdict:
    """Compare ``cleaned`` against the transcript ``said``."""
    before = _tokens(said)
    after = _tokens(cleaned)
    heard = set(before)
    heard_parts = heard | {part for token in before for part in _parts(token)}

    numbers_before = {_number(t) for t in before if _is_number(t)}
    numbers_after = {_number(t) for t in after if _is_number(t)}
    if numbers_before != numbers_after:
        return Verdict(
            "reject",
            reason="number",
            added=sorted(numbers_after - numbers_before),
            missing=sorted(numbers_before - numbers_after),
        )

    negations_before = {t for t in before if t in _NEGATIONS}
    negations_after = {t for t in after if t in _NEGATIONS}
    if bool(negations_before) != bool(negations_after):
        return Verdict(
            "reject",
            reason="negation",
            added=sorted(negations_after - negations_before),
            missing=sorted(negations_before - negations_after),
        )

    # "index dot tsx" may become "index.tsx"; a technical term is new only if
    # one of its parts was never said.
    for token in after:
        if _is_technical(token) and token not in heard and not all(p in heard_parts for p in _parts(token)):
            return Verdict("reject", reason="technical", added=[token])
    for token in before:
        if _is_technical(token) and token not in set(after):
            return Verdict("reject", reason="technical", missing=[token])

    ignored = _FUNCTION_WORDS | _NEGATIONS | {"no"}
    content_before = [t for t in before if t not in ignored and not _is_number(t)]
    content_after = [t for t in after if t not in ignored and not _is_number(t)]
    said_words = set(content_before) | heard_parts
    added = sorted({t for t in content_after if t not in said_words and not all(p in said_words for p in _parts(t))})
    missing = sorted(set(content_before) - set(content_after) - {p for t in content_after for p in _parts(t)})

    if len(added) >= max(ANSWERED_WORDS, ANSWERED_SHARE * len(set(content_before))):
        return Verdict("reject", reason="answered", added=added, missing=missing)
    if added or len(missing) > MISSING_SHARE * len(set(content_before)):
        return Verdict("review", added=added, missing=missing)
    return Verdict("ok")


_CORRECTION_CUE = re.compile(r"\b(actually|no wait|no actually|make that|I mean|scratch that)\b", re.I)


def check_refinement(said: str, refined: str, flags) -> tuple[str, Verdict]:
    """Check a cleanup and choose what to keep: the cleanup unless rejected.

    ``said`` is compared after the deterministic spoken-correction pass, so a
    retraction the speaker made ("3, no actually 4") is not a changed number.
    """
    from .refinement import prepare_refinement

    cleaned, explicit = prepare_refinement(said, flags)
    if explicit is not None:
        return explicit, Verdict("ok")
    verdict = check(cleaned, refined)
    if verdict.outcome == "review" and not verdict.added and flags.self_correction and _CORRECTION_CUE.search(said):
        # The speaker took words back, so leaving them out is the point.
        verdict = Verdict("ok")
    return (cleaned if verdict.outcome == "reject" else refined), verdict


def summarize_reviews(verdicts: list[Verdict]) -> dict | None:
    """One flag for a capture from its phrases' verdicts; None when all passed."""
    flagged = [v for v in verdicts if v.outcome != "ok"]
    if not flagged:
        return None
    return {
        "outcome": "reject" if any(v.outcome == "reject" for v in flagged) else "review",
        "added": sorted({word for v in flagged for word in v.added}),
        "missing": sorted({word for v in flagged for word in v.missing}),
        "reasons": sorted({v.reason for v in flagged if v.reason}),
    }
