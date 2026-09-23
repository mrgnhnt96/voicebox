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
    )
    monkeypatch.setattr(model_startup.session, "SessionLocal", MagicMock())
    monkeypatch.setattr(model_startup.settings, "get_capture_settings", lambda db: saved)
    stt = SimpleNamespace(_is_model_cached=MagicMock(return_value=True), load_model=AsyncMock())
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
