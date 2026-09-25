"""Column-level migrations for the voicebox SQLite database.

Why not Alembic?  voicebox is a single-user desktop app shipping as a
PyInstaller binary.  Every user has exactly one SQLite file.  Alembic's
strengths -- migration tracking across environments, rollback, team
coordination -- don't apply here and would add bundling complexity
(alembic.ini, env.py, versions/ directory all need to survive
PyInstaller).  The column-existence checks below are idempotent, run in
<50 ms on startup, and have worked reliably across 12 schema changes.
If the project ever moves to a server-based deployment or Postgres, this
decision should be revisited.

Adding a new migration:
    1. Append a new ``_migrate_*`` helper at the bottom of this file.
    2. Call it from ``run_migrations()`` in the appropriate spot.
    3. The helper should check column/table existence before acting
       (idempotent) and print a short message when it does real work.

Tables from removed features (voice profiles, generations, stories, effects,
audio channels, MCP bindings) are no longer created or migrated, but existing
databases keep them untouched: nothing here drops user data.
"""

import json
import logging

from sqlalchemy import inspect, text

from ..utils.capture_chords import (
    default_push_to_talk_chord,
    default_toggle_to_talk_chord,
)

logger = logging.getLogger(__name__)


def run_migrations(engine) -> None:
    """Run all schema migrations.  Safe to call on every startup."""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())

    _migrate_capture_settings(engine, inspector, tables)
    _migrate_captures(engine, inspector, tables)


# -- helpers ---------------------------------------------------------------

def _get_columns(inspector, table: str) -> set[str]:
    return {col["name"] for col in inspector.get_columns(table)}


def _add_column(engine, table: str, column_sql: str, label: str) -> None:
    """Add a column if it doesn't already exist."""
    with engine.connect() as conn:
        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column_sql}"))
        conn.commit()
    logger.info("Added %s column to %s", label, table)


# -- per-table migrations --------------------------------------------------

def _migrate_captures(engine, inspector, tables: set[str]) -> None:
    if "captures" not in tables:
        return
    if "refinement_review" not in _get_columns(inspector, "captures"):
        _add_column(engine, "captures", "refinement_review TEXT", "refinement_review")


def _migrate_capture_settings(engine, inspector, tables: set[str]) -> None:
    if "capture_settings" not in tables:
        return
    columns = _get_columns(inspector, "capture_settings")
    push_default = json.dumps(default_push_to_talk_chord())
    toggle_default = json.dumps(default_toggle_to_talk_chord())
    if "allow_auto_paste" not in columns:
        _add_column(
            engine,
            "capture_settings",
            "allow_auto_paste BOOLEAN NOT NULL DEFAULT 1",
            "allow_auto_paste",
        )
    if "input_device_id" not in columns:
        _add_column(
            engine,
            "capture_settings",
            "input_device_id VARCHAR",
            "input_device_id",
        )
    if "chord_push_to_talk_keys" not in columns:
        _add_column(
            engine,
            "capture_settings",
            f"chord_push_to_talk_keys TEXT NOT NULL DEFAULT '{push_default}'",
            "chord_push_to_talk_keys",
        )
    if "chord_toggle_to_talk_keys" not in columns:
        _add_column(
            engine,
            "capture_settings",
            f"chord_toggle_to_talk_keys TEXT NOT NULL DEFAULT '{toggle_default}'",
            "chord_toggle_to_talk_keys",
        )
    if "hotkey_enabled" not in columns:
        _add_column(
            engine,
            "capture_settings",
            "hotkey_enabled BOOLEAN NOT NULL DEFAULT 0",
            "hotkey_enabled",
        )
    if "live_text" not in columns:
        _add_column(
            engine,
            "capture_settings",
            "live_text BOOLEAN NOT NULL DEFAULT 0",
            "live_text",
        )
    if "punctuation_style" not in columns:
        _add_column(
            engine,
            "capture_settings",
            "punctuation_style VARCHAR NOT NULL DEFAULT 'standard'",
            "punctuation_style",
        )
