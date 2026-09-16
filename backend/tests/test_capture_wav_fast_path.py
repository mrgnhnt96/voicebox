"""WAV dictation should not initialize librosa merely to measure duration."""

import io
from unittest.mock import AsyncMock

import numpy as np
import pytest
import soundfile as sf
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend import config
from backend.database.models import Base
from backend.services import captures


@pytest.mark.asyncio
async def test_wav_capture_measures_duration_without_librosa(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "_data_dir", tmp_path)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)

    def unexpected_decode(*args, **kwargs):
        pytest.fail("WAV dictation must not initialize librosa")

    monkeypatch.setattr(captures, "load_audio", unexpected_decode)
    stt = type("STT", (), {"model_size": "turbo", "transcribe": AsyncMock(return_value="Hello.")})()
    monkeypatch.setattr(captures, "get_whisper_model", lambda: stt)
    audio = io.BytesIO()
    sf.write(audio, np.zeros(16000), 16000, format="WAV")
    with Session(engine) as db:
        result = await captures.create_capture(
            audio_bytes=audio.getvalue(),
            filename="take.wav",
            source="dictation",
            language=None,
            stt_model="turbo",
            db=db,
        )
    assert result.duration_ms == 1000
    assert result.transcript_raw == "Hello."
    stt.transcribe.assert_awaited_once()
