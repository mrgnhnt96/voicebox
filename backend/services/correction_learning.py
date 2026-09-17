"""Periodic, local-only correction learning; inference reads an immutable cache."""

import asyncio
import hashlib
import json
import logging
import os
import threading
from contextlib import suppress
from datetime import UTC, datetime

from .. import config
from ..database import session as database_session
from ..database.models import CaptureFeedback
from .correction_rules import MAX_TEXT, Example, apply_rules, compile_rules, evaluate, loss

logger = logging.getLogger(__name__)
INTERVAL_SECONDS = 6 * 60 * 60
_lock = threading.RLock()
_state = None
_path = None
_compiled = ()


def _empty():
    return {
        "version": 1,
        "revision": 0,
        "rules": [],
        "history": [],
        "blocked": [],
        "last_run": None,
        "fingerprint": None,
        "evaluated_report_ids": [],
        "metrics": None,
        "outcome": "waiting",
    }


def initialize():
    global _state, _path, _compiled
    with _lock:
        path = config.get_data_dir() / "correction-learning.json"
        if _state is not None and _path == path:
            return
        state = _empty()
        if path.exists():
            try:
                loaded = json.loads(path.read_text())
                if loaded["version"] != 1 or len(loaded["rules"]) > 32:
                    raise ValueError("Unsupported correction state")
                compile_rules(loaded["rules"])
                state.update(loaded)
            except (OSError, ValueError, KeyError, TypeError):
                logger.exception("Could not load correction learning; using no learned rules")
        _path, _state = path, state
        _compiled = compile_rules(state["rules"])


def _publish(state):
    global _state, _compiled
    compiled = compile_rules(state["rules"])
    _path.parent.mkdir(parents=True, exist_ok=True)
    temporary = _path.with_suffix(".tmp")
    try:
        with temporary.open("w") as stream:
            json.dump(state, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(_path)
    finally:
        temporary.unlink(missing_ok=True)
    _state = state
    _compiled = compiled


def apply_learned_corrections(text, language=None):
    # No disk/DB access, locks, extra prompts, or model calls during dictation.
    # Very long transcripts skip the bounded, latency-tested rule layer.
    return apply_rules(text, _compiled, language) if len(text) <= MAX_TEXT else text


def status():
    initialize()
    with _lock:
        return {
            "evaluated_report_ids": list(_state["evaluated_report_ids"]),
            "revision": _state["revision"],
            "active_rules": len(_state["rules"]),
            "last_run": _state["last_run"],
            "outcome": _state["outcome"],
            "metrics": _state["metrics"],
            "can_rollback": bool(_state["history"]),
        }


def _examples(db):
    rows = (
        db.query(CaptureFeedback)
        .order_by(CaptureFeedback.created_at.desc(), CaptureFeedback.id.desc())
        .limit(500)
        .all()
    )
    latest = {}
    for row in rows:
        key = (row.capture_id, row.target)
        if key in latest:
            continue
        latest[key] = row
    examples = []
    for row in reversed(list(latest.values())):
        try:
            snapshot = json.loads(row.snapshot)
            original = snapshot["transcript_raw" if row.target == "raw" else "transcript_refined"]
            if not original or max(len(original), len(row.expected_text)) > 1000:
                continue
            examples.append(Example(row.id, row.capture_id, original, row.expected_text, snapshot.get("language")))
        except (ValueError, KeyError, TypeError):
            logger.warning("Skipping invalid correction snapshot %s", row.id)
    return examples


def run_job():
    """Run serially in a worker thread, owning the DB session in that thread."""
    initialize()
    with _lock:
        with database_session.SessionLocal() as db:
            examples = _examples(db)
        fingerprint = hashlib.sha256(repr(examples).encode()).hexdigest()
        report_ids = [example.id for example in examples]
        if fingerprint == _state["fingerprint"] and report_ids == _state["evaluated_report_ids"]:
            return status()
        state = json.loads(json.dumps(_state))
        active = state["rules"]
        # A new report contradicting a learned rule disables it before proposing
        # replacements. Never automatically re-enable a withdrawn rule.
        retained = []
        for rule in active:
            compiled = compile_rules([rule])
            if any(
                apply_rules(e.expected, compiled, e.language) != e.expected
                or loss(apply_rules(e.original, compiled, e.language), e.expected) > loss(e.original, e.expected)
                for e in examples
            ):
                state["blocked"].append(rule["id"])
            else:
                retained.append(rule)
        rules, metrics = evaluate(examples, retained, state["blocked"])
        if rules != active:
            state["history"] = (state["history"] + [{"revision": state["revision"], "rules": active}])[-10:]
            state["revision"] += 1
            state["rules"] = rules
        state.update(
            fingerprint=fingerprint,
            evaluated_report_ids=report_ids,
            metrics=metrics,
            last_run=datetime.now(UTC).isoformat(),
            outcome="updated" if rules != active else "no_change",
        )
        _publish(state)
        return status()


def rollback():
    initialize()
    with _lock:
        if not _state["history"]:
            raise ValueError("No previous correction version is available")
        state = json.loads(json.dumps(_state))
        previous = state["history"].pop()
        restored_ids = {r["id"] for r in previous["rules"]}
        state["blocked"] = list(
            set(state["blocked"]) | {r["id"] for r in state["rules"] if r["id"] not in restored_ids}
        )
        # A contradicted rule must not be restored by rolling back another change.
        state["rules"] = [r for r in previous["rules"] if r["id"] not in state["blocked"]]
        state["revision"] += 1
        state["outcome"] = "rolled_back"
        _publish(state)
        return status()


async def periodic_job():
    initialize()
    await asyncio.sleep(60)
    while True:
        # Shield the worker so shutdown waits for atomic publication to finish.
        worker = asyncio.create_task(asyncio.to_thread(run_job))
        try:
            await asyncio.shield(worker)
        except asyncio.CancelledError:
            with suppress(Exception):
                await worker
            raise
        except Exception:
            logger.exception("Correction improvement job failed; keeping active version")
        await asyncio.sleep(INTERVAL_SECONDS)
