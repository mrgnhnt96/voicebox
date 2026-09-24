"""Startup prepares saved capture models before the server becomes ready."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.services import model_startup


@pytest.fixture
def startup(monkeypatch):
    saved = SimpleNamespace(
        stt_model="small",
        llm_model="1.7B",
        auto_refine=True,
        smart_cleanup=True,
        self_correction=True,
        preserve_technical=True,
        punctuation_style="standard",
        language="en",
    )
    monkeypatch.setattr(model_startup.session, "SessionLocal", MagicMock())
    monkeypatch.setattr(model_startup.settings, "get_capture_settings", lambda db: saved)
    stt = SimpleNamespace(
        _is_model_cached=MagicMock(return_value=True),
        load_model=AsyncMock(),
        is_loaded=MagicMock(return_value=True),
        transcribe_array=AsyncMock(return_value=""),
    )
    llm = SimpleNamespace(
        _is_model_cached=MagicMock(return_value=True),
        load_model=AsyncMock(),
        is_loaded=MagicMock(return_value=True),
    )
    monkeypatch.setattr(model_startup.refinement, "refine_transcript", AsyncMock(return_value=("Okay.", "1.7B")))
    monkeypatch.setattr(model_startup.transcribe, "get_whisper_model", lambda: stt)
    monkeypatch.setattr(model_startup.llm, "get_llm_model", lambda: llm)
    return saved, stt, llm


@pytest.mark.asyncio
async def test_loads_saved_models_in_order(startup):
    _, stt, llm = startup
    order = []
    stt.load_model.side_effect = lambda size: order.append(("stt", size))
    llm.load_model.side_effect = lambda size: order.append(("llm", size))
    await model_startup.load_startup_models()
    assert order == [("stt", "small"), ("llm", "1.7B")]


@pytest.mark.asyncio
async def test_missing_models_are_not_downloaded(startup):
    _, stt, llm = startup
    stt._is_model_cached.return_value = False
    llm._is_model_cached.return_value = False
    await model_startup.load_startup_models()
    stt.load_model.assert_not_awaited()
    llm.load_model.assert_not_awaited()


@pytest.mark.asyncio
async def test_disabled_refinement_only_loads_whisper(startup):
    saved, stt, llm = startup
    saved.auto_refine = False
    await model_startup.load_startup_models()
    stt.load_model.assert_awaited_once_with("small")
    llm._is_model_cached.assert_not_called()
    llm.load_model.assert_not_awaited()


@pytest.mark.asyncio
async def test_load_failure_does_not_block_other_models(startup, caplog):
    _, stt, llm = startup
    stt.load_model.side_effect = RuntimeError("Model cannot load")
    await model_startup.load_startup_models()
    llm.load_model.assert_awaited_once_with("1.7B")
    assert "Could not load startup Whisper model small" in caplog.text


@pytest.mark.asyncio
async def test_warms_refinement_prompt_after_loading(startup):
    await model_startup.load_startup_models()
    model_startup.refinement.refine_transcript.assert_awaited_once()
    assert model_startup.refinement.refine_transcript.await_args.kwargs == {"model_size": "1.7B"}


@pytest.mark.asyncio
async def test_warm_up_failure_does_not_block_startup(startup, caplog):
    model_startup.refinement.refine_transcript.side_effect = RuntimeError("generate failed")
    await model_startup.load_startup_models()
    assert "Could not warm the refinement prompt" in caplog.text


@pytest.mark.asyncio
async def test_unloaded_refinement_model_is_not_warmed(startup):
    _, _, llm = startup
    llm.is_loaded.return_value = False
    await model_startup.load_startup_models()
    model_startup.refinement.refine_transcript.assert_not_awaited()


@pytest.mark.asyncio
async def test_runs_whisper_once_so_the_first_dictation_is_warm(startup, tmp_path, monkeypatch):
    from backend import config

    _, stt, _ = startup
    monkeypatch.setattr(config, "_data_dir", tmp_path)
    await model_startup.load_startup_models()
    stt.transcribe_array.assert_awaited_once()
    samples, rate = stt.transcribe_array.await_args.args[:2]
    # One second at a Mac microphone's rate, so resampling is warmed too.
    assert rate == 48000 and len(samples) == 48000
    # Warmed as the first phrase of a dictation (no earlier text), the call
    # streaming makes, so its one-time setup is paid here and not after release.
    assert stt.transcribe_array.await_args.kwargs == {"language": "en", "model_size": "small", "previous_text": ""}


@pytest.mark.asyncio
async def test_auto_language_warms_with_detection(startup):
    saved, stt, _ = startup
    saved.language = "auto"
    await model_startup.load_startup_models()
    assert stt.transcribe_array.await_args.kwargs["language"] is None


@pytest.mark.asyncio
async def test_whisper_warm_up_failure_does_not_block_startup(startup, caplog):
    _, stt, _ = startup
    stt.transcribe_array.side_effect = RuntimeError("no GPU")
    await model_startup.load_startup_models()
    assert "Could not warm Whisper" in caplog.text
    model_startup.refinement.refine_transcript.assert_awaited_once()


@pytest.mark.asyncio
async def test_unloaded_whisper_is_not_warmed(startup):
    _, stt, _ = startup
    stt.is_loaded.return_value = False
    await model_startup.load_startup_models()
    stt.transcribe_array.assert_not_awaited()


def _write_capture(directory, name, seconds, rate=48000, value=1000):
    import numpy as np
    import soundfile as sf

    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    sf.write(path, np.full(int(seconds * rate), value, dtype=np.int16), rate, subtype="PCM_16")
    return path


@pytest.mark.asyncio
async def test_warms_whisper_with_the_most_recent_recording(startup, tmp_path, monkeypatch):
    import os

    from backend import config

    _, stt, _ = startup
    monkeypatch.setattr(config, "_data_dir", tmp_path)
    older = _write_capture(config.get_captures_dir(), "older.wav", 2, value=500)
    os.utime(older, (1, 1))
    _write_capture(config.get_captures_dir(), "newest.wav", 9, rate=44100)
    await model_startup.load_startup_models()
    samples, rate = stt.transcribe_array.await_args.args[:2]
    # The newest recording, trimmed so loading stays short.
    assert rate == 44100
    assert len(samples) == model_startup.WARM_SECONDS * 44100
    assert int(samples[0]) == 1000


@pytest.mark.asyncio
async def test_unreadable_recordings_fall_back_to_noise(startup, tmp_path, monkeypatch):
    from backend import config

    _, stt, _ = startup
    monkeypatch.setattr(config, "_data_dir", tmp_path)
    config.get_captures_dir().mkdir(parents=True, exist_ok=True)
    (config.get_captures_dir() / "broken.wav").write_bytes(b"not audio")
    await model_startup.load_startup_models()
    samples, rate = stt.transcribe_array.await_args.args[:2]
    assert rate == 48000 and len(samples) == 48000
