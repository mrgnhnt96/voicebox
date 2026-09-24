"""The user's own "when I say this, I mean this" examples.

Two sources feed it: corrections to refined output (Teach Voicebox) and
calibration rewrites the user edited. Cleanup shows the model the same
recent examples on every dictation, so a correction counts on the very next
dictation, and the model's prompt cache keeps the wait short. Examples too old
to fit are summarized into correction notes, so none stop counting.

Corrections are immutable training records, so removing one from the user's
examples hides it here without deleting the record.
"""

import json
import logging
import threading

from . import writing_style

logger = logging.getLogger(__name__)

MAX_EXAMPLE_CHARS = 800
# Enough to show how the user writes without bloating the prompt.
MAX_PROMPT_EXAMPLES = 16
MAX_PROMPT_CHARS = 6000

_lock = threading.RLock()
_cache = None

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


def in_prompt() -> list[dict]:
    """The most recent examples that fit the prompt budget, newest first.

    Older examples are summarized into correction notes instead.
    """
    chosen, size = [], 0
    for example in all_examples()[:MAX_PROMPT_EXAMPLES]:
        size += len(example["said"]) + len(example["meant"])
        if size > MAX_PROMPT_CHARS:
            break
        chosen.append(example)
    return chosen


def for_prompt(extra: list[tuple[str, str]] | None = None) -> list[tuple[str, str]]:
    """The examples every cleanup shows the model, oldest first.

    Every dictation gets the same list, so the cleanup model's cached prompt
    covers it and only the new transcript is read. A new example goes at the
    end, keeping everything before it cached. ``extra`` examples, such as a
    calibration run's rewrites before they are saved, come last.
    """
    chosen = [(example["said"], example["meant"]) for example in in_prompt()]
    return [*reversed(chosen), *(extra or [])]


def hide(example_id: str) -> bool:
    if not any(e["id"] == example_id for e in all_examples()):
        return False
    writing_style.hide_example(example_id)
    invalidate()
    return True
