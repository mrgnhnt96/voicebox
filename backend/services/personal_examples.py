"""The user's own "when I say this, I mean this" examples.

Two sources feed it: corrections to refined output (Teach Voicebox) and
calibration rewrites the user edited. Cleanup shows the model the few
examples closest to what was just said, so a correction counts on the very
next dictation instead of waiting for the personal model to train.

Corrections are immutable training records, so removing one from the user's
examples hides it here without deleting the record.
"""

import json
import logging
import re
import threading

from . import writing_style

logger = logging.getLogger(__name__)

EXAMPLES_PER_REFINEMENT = 3
MAX_EXAMPLE_CHARS = 800

_lock = threading.RLock()
_cache = None

_FUNCTION_WORDS = frozenset(
    re.findall(
        r"\S+",
        "a an the and or but so to of in on at for with from by as is are was were be been am it its i you we they he "
        "she my your our their this that these those there here what when where how why which who do does did have has "
        "had will would can could should just like um uh",
    )
)


def _words(text: str) -> set[str]:
    return {word for word in re.findall(r"[\w']+", text.casefold()) if word not in _FUNCTION_WORDS}


def invalidate() -> None:
    global _cache
    with _lock:
        _cache = None


def _from_corrections() -> list[dict]:
    from ..database import session as database_session
    from ..database.models import CaptureFeedback

    if database_session.SessionLocal is None:
        return []
    with database_session.SessionLocal() as db:
        rows = (
            db.query(CaptureFeedback)
            .filter(CaptureFeedback.target == "refined")
            .order_by(CaptureFeedback.created_at.desc(), CaptureFeedback.id.desc())
            .limit(500)
            .all()
        )
    examples = []
    seen = set()
    for row in rows:
        # The latest correction of a capture replaces earlier ones.
        if row.capture_id in seen:
            continue
        seen.add(row.capture_id)
        try:
            said = json.loads(row.snapshot).get("transcript_raw") or ""
        except (ValueError, TypeError):
            continue
        if said and row.expected_text:
            examples.append(
                {
                    "id": f"correction:{row.id}",
                    "source": "correction",
                    "said": said,
                    "meant": row.expected_text,
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                }
            )
    return examples


def all_examples() -> list[dict]:
    """Every example cleanup may use, newest first."""
    global _cache
    with _lock:
        if _cache is None:
            try:
                corrections = _from_corrections()
            except Exception:
                logger.warning("Could not load corrections as examples", exc_info=True)
                corrections = []
            hidden = set(writing_style.hidden_examples())
            examples = [e for e in corrections + writing_style.calibration_examples() if e["id"] not in hidden]
            examples = [
                e
                for e in examples
                if max(len(e["said"]), len(e["meant"])) <= MAX_EXAMPLE_CHARS and e["said"] != e["meant"]
            ]
            examples.sort(key=lambda e: e["created_at"] or "", reverse=True)
            _cache = examples
        return list(_cache)


def closest(
    transcript: str, count: int = EXAMPLES_PER_REFINEMENT, extra: list[tuple[str, str]] | None = None
) -> list[tuple[str, str]]:
    """The examples sharing the most words with ``transcript``, most similar last.

    Examples still help when nothing overlaps (they show how the user writes),
    so the newest fill any remaining slots. ``extra`` examples, such as a
    calibration run's rewrites before they are saved, count as the newest.
    """
    examples = [{"said": said, "meant": meant} for said, meant in reversed(extra or [])] + all_examples()
    if not examples:
        return []
    words = _words(transcript)

    def overlap(example: dict) -> float:
        theirs = _words(example["said"])
        return len(words & theirs) / len(words | theirs) if words and theirs else 0.0

    # sorted() is stable, so equal overlap keeps newest first.
    ranked = sorted(examples, key=overlap, reverse=True)[:count]
    return [(e["said"], e["meant"]) for e in reversed(ranked)]


def hide(example_id: str) -> bool:
    if not any(e["id"] == example_id for e in all_examples()):
        return False
    writing_style.hide_example(example_id)
    invalidate()
    return True
