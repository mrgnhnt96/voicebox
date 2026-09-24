"""Database package — ORM models, session management, and migrations.

Re-exports all public symbols so that ``from .database import get_db``
and ``from .database import Capture as DBCapture`` work without importers
reaching into submodules.
"""

from .models import (
    Base,
    Capture,
    CaptureFeedback,
    CaptureSettings,
)
from .session import engine, SessionLocal, _db_path, init_db, get_db

__all__ = [
    # Models
    "Base",
    "Capture",
    "CaptureFeedback",
    "CaptureSettings",
    # Session
    "engine",
    "SessionLocal",
    "_db_path",
    "init_db",
    "get_db",
]
