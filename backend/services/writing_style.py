"""The user's punctuation habits, learned from calibration and corrections.

Calibration shows paragraphs punctuated the way Standard refinement writes
dictation and asks the user to rewrite each one the way they would type it.
Comparing the two, word by word, counts what the user does at each sentence
break (keep the period, turn it into a comma, drop it), whether they lowercase
sentence starts, drop commas after opening words or before conjunctions, and
end with a period. Refined-output corrections add the same evidence.

"Match my writing" uses those counts three ways: it picks the refinement
prompt style, how dictation phrases join across pauses, and a deterministic
pass over refined text. The pass only ever changes punctuation and the case of
a sentence's first letter, never words.

Everything is local: one JSON file in the data directory.
"""

import hashlib
import json
import logging
import os
import random
import re
import threading
import time
import uuid
from datetime import UTC, datetime
from difflib import SequenceMatcher

from .. import config
from .writing_style_paragraphs import BY_ID, PARAGRAPHS, SITUATIONS

logger = logging.getLogger(__name__)

RUN_LENGTH = len(SITUATIONS)
MAX_EXAMPLES = 50
SESSION_TTL_SECONDS = 2 * 60 * 60
# Least evidence before a habit is applied. Calibration alone gives about ten
# sentence breaks and a handful of each comma kind per run.
MIN_EVIDENCE = 2

_CONJUNCTIONS = frozenset(("and", "but", "so", "or", "yet", "though", "because"))
_ABBREVIATIONS = frozenset(("mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e", "approx"))
_OPENING_PUNCTUATION = "\"'(\u201c\u2018["
_TRAILING = re.compile(r"[.,!?;:\u2026\u2014-]+$")

_lock = threading.RLock()
_state = None
_sessions = {}


# --- Tokens --------------------------------------------------------------------


def _split(token: str) -> tuple[str, str]:
    """Split a whitespace token into its word and trailing punctuation."""
    match = _TRAILING.search(token)
    if not match or match.start() == 0:
        return token, ""
    return token[: match.start()], match.group()


def _key(word: str) -> str:
    return word.lstrip(_OPENING_PUNCTUATION).rstrip("\"')\u201d\u2019]").casefold().replace("\u2019", "'")


def _is_boundary(trail: str) -> bool:
    return "." in trail and ".." not in trail and "\u2026" not in trail


def _capitalized(word: str) -> bool:
    letters = word.lstrip(_OPENING_PUNCTUATION)
    return bool(letters) and letters[0].isupper()


def _keeps_capital(word: str) -> bool:
    """``I``, its contractions and acronyms keep their capitals anywhere."""
    letters = word.lstrip(_OPENING_PUNCTUATION)
    return letters == "I" or letters.startswith(("I'", "I\u2019")) or (len(letters) > 1 and letters.isupper())


def _lower_first(word: str) -> str:
    if _keeps_capital(word):
        return word
    index = len(word) - len(word.lstrip(_OPENING_PUNCTUATION))
    return word[:index] + word[index : index + 1].lower() + word[index + 1 :]


# --- Learning ------------------------------------------------------------------


def _empty_counts() -> dict:
    return {
        "boundary": {"period": 0, "comma": 0, "none": 0},
        "lowercase_start": {"yes": 0, "no": 0},
        "intro_comma": {"kept": 0, "dropped": 0},
        "conjunction_comma": {"kept": 0, "dropped": 0},
        "final_period": {"kept": 0, "dropped": 0},
    }


def _merge(*counts: dict) -> dict:
    total = _empty_counts()
    for item in counts:
        for habit, outcomes in (item or {}).items():
            for outcome, value in outcomes.items():
                if habit in total and outcome in total[habit]:
                    total[habit][outcome] += value
    return total


def observe(shown: str, written: str) -> dict:
    """Count the user's punctuation choices in ``written`` against ``shown``."""
    counts = _empty_counts()
    before = [_split(token) for token in shown.split()]
    after = [_split(token) for token in written.split()]
    if not before or not after:
        return counts
    matcher = SequenceMatcher(None, [_key(w) for w, _ in before], [_key(w) for w, _ in after], autojunk=False)
    aligned = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            aligned[block.a + offset] = block.b + offset

    def record_start(i: int, j: int):
        word = before[i][0]
        if _capitalized(word) and not _keeps_capital(word):
            counts["lowercase_start"]["no" if _capitalized(after[j][0]) else "yes"] += 1

    if 0 in aligned and aligned[0] == 0:
        record_start(0, 0)
    sentence_start = True
    for i, (word, trail) in enumerate(before):
        j = aligned.get(i)
        last = i == len(before) - 1
        if j is not None:
            written_trail = after[j][1]
            if last:
                if _is_boundary(trail) and j == len(after) - 1:
                    counts["final_period"]["kept" if _is_boundary(written_trail) else "dropped"] += 1
            elif aligned.get(i + 1) == j + 1:
                # Both words and the one after them survived, so the seam is comparable.
                if _is_boundary(trail) and _key(word) not in _ABBREVIATIONS:
                    if _is_boundary(written_trail) or written_trail[-1:] in "!?":
                        counts["boundary"]["period"] += 1
                        record_start(i + 1, j + 1)
                    elif written_trail == ",":
                        counts["boundary"]["comma"] += 1
                    elif written_trail == "":
                        counts["boundary"]["none"] += 1
                elif trail == ",":
                    habit = (
                        "intro_comma"
                        if sentence_start
                        else "conjunction_comma"
                        if _key(before[i + 1][0]) in _CONJUNCTIONS
                        else None
                    )
                    if habit and written_trail in (",", ""):
                        counts[habit]["kept" if written_trail == "," else "dropped"] += 1
        sentence_start = bool(trail) and (trail[-1] in "!?" or _is_boundary(trail))
    return counts


def decide(counts: dict) -> dict:
    """Turn counts into the habits to apply; a habit needs MIN_EVIDENCE first."""

    def share(habit: str, outcome: str) -> float | None:
        total = sum(counts[habit].values())
        return counts[habit][outcome] / total if total >= MIN_EVIDENCE else None

    boundary = counts["boundary"]
    decided_boundary = None
    if sum(boundary.values()) >= MIN_EVIDENCE:
        # Ties keep the period; the user has to show the change more often than not.
        decided_boundary = max(
            ("period", "comma", "none"), key=lambda outcome: (boundary[outcome], outcome == "period")
        )
    return {
        "boundary": decided_boundary,
        "lowercase_start": (share("lowercase_start", "yes") or 0) > 0.5,
        "drop_intro_comma": (share("intro_comma", "dropped") or 0) > 0.5,
        "drop_conjunction_comma": (share("conjunction_comma", "dropped") or 0) > 0.5,
        "drop_final_period": (share("final_period", "dropped") or 0) > 0.5,
    }


def summary(habits: dict) -> list[str]:
    """Stable codes the app turns into plain-language lines."""
    codes = []
    if habits["boundary"]:
        codes.append(f"boundary_{habits['boundary']}")
    for habit in ("lowercase_start", "drop_intro_comma", "drop_conjunction_comma", "drop_final_period"):
        if habits[habit]:
            codes.append(habit)
    return codes


# --- Applying ------------------------------------------------------------------


def apply_style(text: str, habits: dict) -> str:
    """Re-punctuate ``text`` with the user's habits; words are never changed."""
    if not text or not summary(habits) or summary(habits) == ["boundary_period"]:
        return text
    parts = re.split(r"(\s+)", text)
    words = parts[0::2]
    spaces = parts[1::2]
    sentence_start = True
    for index, token in enumerate(words):
        if not token:
            continue
        word, trail = _split(token)
        if sentence_start and habits["lowercase_start"] and _capitalized(word):
            word = _lower_first(word)
        following = next((w for w in words[index + 1 :] if w), None)
        gap = spaces[index] if index < len(spaces) else ""
        inline = following is not None and "\n" not in gap
        next_start = (bool(trail) and (trail[-1] in "!?" or _is_boundary(trail))) or "\n" in gap
        if inline and _is_boundary(trail) and _capitalized(following) and _key(word) not in _ABBREVIATIONS:
            if habits["boundary"] in ("comma", "none"):
                trail = trail.replace(".", "," if habits["boundary"] == "comma" else "", 1)
                words[index + 1] = _lower_first(following)
                next_start = False
        elif trail == "," and inline:
            if (sentence_start and habits["drop_intro_comma"]) or (
                not sentence_start and habits["drop_conjunction_comma"] and _key(_split(following)[0]) in _CONJUNCTIONS
            ):
                trail = ""
        elif following is None and _is_boundary(trail) and trail.endswith(".") and habits["drop_final_period"]:
            trail = trail[:-1]
        words[index] = word + trail
        sentence_start = next_start
    out = [None] * len(parts)
    out[0::2] = words
    out[1::2] = spaces
    return "".join(out)


# --- Profile -------------------------------------------------------------------


def _path():
    return config.get_data_dir() / "writing-style.json"


def _empty_state() -> dict:
    return {
        "version": 1,
        "runs": 0,
        "last_run_at": None,
        "examples": [],
        "recent_paragraphs": [],
        "feedback_counts": _empty_counts(),
        "hidden_examples": [],
    }


def _load() -> dict:
    global _state
    with _lock:
        if _state is None:
            try:
                _state = {**_empty_state(), **json.loads(_path().read_text())}
            except FileNotFoundError:
                _state = _empty_state()
            except (OSError, ValueError):
                logger.warning("Unreadable writing style profile; starting fresh", exc_info=True)
                _state = _empty_state()
        return _state


def _save(state: dict):
    global _state
    with _lock:
        path = _path()
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, indent=2, ensure_ascii=False))
        os.replace(temporary, path)
        _state = state


def _counts(state: dict, extra: list | None = None) -> dict:
    examples = state["examples"] + (extra or [])
    return _merge(state["feedback_counts"], *(observe(e["shown"], e["written"]) for e in examples))


def habits() -> dict:
    return decide(_counts(_load()))


def is_ready() -> bool:
    state = _load()
    return state["runs"] > 0 or sum(state["feedback_counts"]["boundary"].values()) >= 3


def status() -> dict:
    state = _load()
    learned = habits()
    return {
        "ready": is_ready(),
        "runs": state["runs"],
        "last_run_at": state["last_run_at"],
        "example_count": len(state["examples"]),
        "habits": summary(learned),
    }


def apply_learned(text: str) -> str:
    return apply_style(text, habits()) if is_ready() else text


_INSTRUCTIONS = {
    "boundary_period": "End each thought with a period and start the next one as a new sentence.",
    "boundary_comma": "Join related thoughts with commas instead of starting new sentences.",
    "boundary_none": "Run related thoughts together without punctuation between them.",
    "lowercase_start": 'Start sentences with a lowercase letter. Keep "I" and acronyms capitalized.',
    "drop_intro_comma": 'Do not put a comma after opening words like "yeah", "so", "okay" or "honestly".',
    "drop_conjunction_comma": 'Do not put a comma before "and", "but", "so" or "or".',
    "drop_final_period": "Do not end the text with a period.",
}


def prompt_section() -> str | None:
    """Refinement instructions describing this user's own punctuation."""
    if not is_ready():
        return None
    codes = summary(habits())
    if not codes:
        return None
    lines = "\n".join(f"- {_INSTRUCTIONS[code]}" for code in codes)
    return f"Punctuation style: match how this speaker writes.\n{lines}\n- Still use question marks for questions."


def _as_spoken(text: str) -> str:
    """What the speech-to-text step would hand refinement for ``text``."""
    return " ".join(re.sub(r"[^\w'\u2019$%-]", "", word) for word in text.split()).casefold()


def prompt_example() -> tuple[str, str] | None:
    """The user's latest calibration rewrite that differs from what was shown."""
    if not is_ready():
        return None
    for example in reversed(_load()["examples"]):
        if example["written"].strip() != example["shown"].strip():
            return _as_spoken(example["shown"]), example["written"]
    return None


def refresh_feedback(db) -> None:
    """Recount refined-output corrections; called after a correction is saved."""
    from ..database.models import CaptureFeedback

    rows = (
        db.query(CaptureFeedback)
        .filter(CaptureFeedback.target == "refined")
        .order_by(CaptureFeedback.created_at.desc(), CaptureFeedback.id.desc())
        .limit(200)
        .all()
    )
    seen = set()
    counts = []
    for row in rows:
        if row.capture_id in seen:
            continue
        seen.add(row.capture_id)
        try:
            original = json.loads(row.snapshot).get("transcript_refined")
        except (ValueError, TypeError):
            continue
        if original and max(len(original), len(row.expected_text)) <= 2000:
            counts.append(observe(original, row.expected_text))
    with _lock:
        state = dict(_load())
        state["feedback_counts"] = _merge(*counts)
        _save(state)


def reset() -> None:
    with _lock:
        state = _empty_state()
        state["recent_paragraphs"] = _load()["recent_paragraphs"]
        _save(state)
        _sessions.clear()
    _examples_changed()


def _examples_changed() -> None:
    from . import personal_examples

    personal_examples.invalidate()


def _example_id(example: dict) -> str:
    key = f"{example.get('created_at')}|{example['shown']}|{example['written']}"
    return "calibration:" + hashlib.sha256(key.encode()).hexdigest()[:16]


def calibration_examples() -> list[dict]:
    """Calibration rewrites the user edited, as "said, meant" examples."""
    examples = []
    for example in _load()["examples"]:
        if example["written"].strip() == example["shown"].strip():
            continue
        examples.append(
            {
                "id": _example_id(example),
                "source": "calibration",
                # Spoken-jumble paragraphs are stored as said; punctuation ones as shown.
                "said": example.get("said") or _as_spoken(example["shown"]),
                "meant": example["written"],
                "created_at": example.get("created_at"),
            }
        )
    return examples


def hidden_examples() -> list[str]:
    return list(_load()["hidden_examples"])


def hide_example(example_id: str) -> None:
    with _lock:
        state = dict(_load())
        state["hidden_examples"] = [*state["hidden_examples"], example_id][-1000:]
        _save(state)


# --- Calibration -----------------------------------------------------------------


def _expire_sessions():
    cutoff = time.monotonic() - SESSION_TTL_SECONDS
    for session_id in [key for key, value in _sessions.items() if value["touched"] < cutoff]:
        del _sessions[session_id]


def _pick_paragraphs(recent: list[str]) -> list[str]:
    """One paragraph per situation, avoiding the ones shown most recently."""
    chosen = []
    for situation in SITUATIONS:
        options = [p.id for p in PARAGRAPHS if p.situation == situation]
        fresh = [option for option in options if option not in recent] or options
        chosen.append(random.choice(fresh))
    return chosen


def _change(shown: str, written: str) -> float:
    """Share of the paragraph the user changed, punctuation included (0 to 1)."""
    return round(1 - SequenceMatcher(None, shown.split(), written.split(), autojunk=False).ratio(), 3)


def _step_view(session: dict) -> dict:
    index = session["step"]
    learned = decide(_counts(_load(), session["examples"]))
    shown = apply_style(BY_ID[session["paragraphs"][index]].text, learned)
    session["shown"] = shown
    return {
        "session_id": session["id"],
        "step": index,
        "total": len(session["paragraphs"]),
        "paragraph": shown,
        "habits": summary(learned),
        "changes": session["changes"],
    }


def start_calibration() -> dict:
    with _lock:
        _expire_sessions()
        state = _load()
        session = {
            "id": uuid.uuid4().hex,
            "paragraphs": _pick_paragraphs(state["recent_paragraphs"]),
            "step": 0,
            "examples": [],
            "changes": [],
            "shown": "",
            "touched": time.monotonic(),
        }
        _sessions[session["id"]] = session
        return _step_view(session)


def submit_step(session_id: str, written: str) -> dict:
    with _lock:
        session = _sessions.get(session_id)
        if session is None:
            raise KeyError(session_id)
        if session["step"] >= len(session["paragraphs"]):
            raise ValueError("Calibration already has every paragraph")
        written = written.strip()
        if not written:
            raise ValueError("Rewrite the paragraph, or keep it as it is")
        paragraph_id = session["paragraphs"][session["step"]]
        # Learn against the paragraph as Standard writes it, not the styled copy
        # shown, so undoing a habit Voicebox applied counts as evidence too.
        session["examples"].append(
            {"paragraph_id": paragraph_id, "shown": BY_ID[paragraph_id].text, "written": written}
        )
        session["changes"].append(_change(session["shown"], written))
        session["step"] += 1
        session["touched"] = time.monotonic()
        if session["step"] < len(session["paragraphs"]):
            return {**_step_view(session), "done": False}
        learned = decide(_counts(_load(), session["examples"]))
        return {
            "session_id": session_id,
            "step": session["step"],
            "total": len(session["paragraphs"]),
            "paragraph": None,
            "habits": summary(learned),
            "changes": session["changes"],
            "done": True,
        }


def finish_calibration(session_id: str) -> dict:
    """Keep the run's rewrites in the profile."""
    with _lock:
        session = _sessions.pop(session_id, None)
        if session is None:
            raise KeyError(session_id)
        if not session["examples"]:
            raise ValueError("Rewrite at least one paragraph before saving")
        state = dict(_load())
        now = datetime.now(UTC).isoformat()
        state["examples"] = (state["examples"] + [{**e, "created_at": now} for e in session["examples"]])[
            -MAX_EXAMPLES:
        ]
        state["runs"] += 1
        state["last_run_at"] = now
        state["recent_paragraphs"] = (state["recent_paragraphs"] + session["paragraphs"])[-len(PARAGRAPHS) // 2 :]
        _save(state)
    _examples_changed()
    return status()


def discard_calibration(session_id: str) -> None:
    with _lock:
        _sessions.pop(session_id, None)
