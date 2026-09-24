"""The PyTorch Whisper backend accepts in-memory audio like the MLX one.

capture_stream calls whichever STT backend the platform uses, so both must
offer ``transcribe_array``. The model and processor are faked.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import numpy as np
import pytest

torch = pytest.importorskip("torch")


class FakeInputs(dict):
    def to(self, device):
        return self


class FakeProcessor:
    def __init__(self):
        self.audio = None
        self.tokenizer = SimpleNamespace(decode=lambda tokens: "", __len__=lambda: 51866)

    def __call__(self, audio, sampling_rate, return_tensors):
        self.audio = (np.asarray(audio), sampling_rate)
        return FakeInputs(input_features="features")

    def batch_decode(self, ids, skip_special_tokens):
        return ["  in memory  "]


@pytest.fixture
def stt(monkeypatch):
    from backend.backends import pytorch_backend

    backend = pytorch_backend.PyTorchSTTBackend("turbo")
    backend.processor = FakeProcessor()
    backend.model = SimpleNamespace(generate=lambda features, **kwargs: [[1, 2]])
    monkeypatch.setattr(backend, "load_model_async", AsyncMock())
    return backend


@pytest.mark.asyncio
async def test_transcribe_array_feeds_16k_float_audio(stt):
    from backend.backends import whisper_audio

    samples = (np.sin(np.arange(4800) / 7) * 9000).astype(np.int16)

    text = await stt.transcribe_array(samples, 48000, None, "turbo")

    assert text == "in memory"
    audio, rate = stt.processor.audio
    assert rate == 16000
    assert audio.dtype == np.float32
    expected = whisper_audio.resample(samples.astype(np.float64) / 32768.0, 48000).astype(np.float32)
    np.testing.assert_array_equal(audio, expected)
    stt.load_model_async.assert_awaited_once_with("turbo")


@pytest.mark.asyncio
async def test_transcribe_array_rejects_empty_audio(stt):
    with pytest.raises(ValueError):
        await stt.transcribe_array(np.zeros(0, dtype=np.int16), 16000)
