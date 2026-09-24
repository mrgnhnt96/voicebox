"""MLX Whisper takes audio in memory, and loads without word-timing imports.

The model is faked, so these exercise the backend's own orchestration: what
reaches ``model.generate`` for a file versus in-memory samples.
"""

import platform
import sys
import wave
from types import SimpleNamespace

import numpy as np
import pytest

from backend.services.mlx_thread import run_on_mlx_thread

pytestmark = pytest.mark.skipif(
    not (sys.platform == "darwin" and platform.machine() == "arm64"),
    reason="MLX is only installed on Apple Silicon macOS",
)


class FakeWhisper:
    def __init__(self):
        self.calls = []

    def generate(self, audio, **options):
        # Runs on the MLX worker; arrays made there must be read there too.
        self.calls.append((type(audio).__name__, np.array(audio), options))
        return SimpleNamespace(text="  hello there  ")

    def get_tokenizer(self, language="en"):
        return SimpleNamespace(decode=lambda tokens: "", eot=50257)


@pytest.fixture
def stt(monkeypatch):
    from backend.backends import mlx_backend

    monkeypatch.setattr(mlx_backend, "ellipsis_token_ids", lambda size, decode, eot: [1131])
    backend = mlx_backend.MLXSTTBackend("turbo")
    backend.model = FakeWhisper()
    return backend


def pcm(rate, seconds):
    t = np.arange(int(rate * seconds)) / rate
    return (np.sin(2 * np.pi * 330 * t) * 12000).astype(np.int16)


def write_wav(path, samples, rate):
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(samples.tobytes())


@pytest.mark.asyncio
async def test_transcribe_array_passes_the_waveform_not_a_path(stt):
    from backend.backends import whisper_audio

    samples = pcm(48000, 0.5)

    text = await stt.transcribe_array(samples, 48000, "en", "turbo")

    assert text == "hello there"
    kind, audio, options = stt.model.calls[0]
    assert kind == "array"
    expected = await run_on_mlx_thread(lambda: np.array(whisper_audio.prepare_samples(samples, 48000)))
    np.testing.assert_array_equal(audio, expected)
    assert options == {"language": "en"}


@pytest.mark.asyncio
async def test_transcribe_array_uses_the_same_phrase_options_as_files(stt, tmp_path):
    samples = pcm(16000, 0.5)
    write_wav(tmp_path / "w.wav", samples, 16000)

    await stt.transcribe(str(tmp_path / "w.wav"), "en", "turbo", previous_text="We met and")
    await stt.transcribe_array(samples, 16000, "en", "turbo", previous_text="We met and")

    (_, file_audio, file_options), (_, array_audio, array_options) = stt.model.calls
    assert array_options == file_options == {
        "language": "en",
        "suppress_tokens": [-1, 1131],
        "initial_prompt": "We met and",
    }
    np.testing.assert_array_equal(array_audio, file_audio)


@pytest.mark.asyncio
async def test_transcribe_file_is_decoded_in_process(stt, tmp_path):
    """File input is decoded here, so a 48 kHz file never needs scipy.signal."""
    from backend.backends import whisper_audio

    path = str(tmp_path / "w.wav")
    write_wav(path, pcm(48000, 0.5), 48000)

    await stt.transcribe(path, None, "turbo")

    kind, audio, options = stt.model.calls[0]
    assert kind == "array"
    expected = await run_on_mlx_thread(lambda: np.array(whisper_audio.read_audio_file(path)))
    np.testing.assert_array_equal(audio, expected)
    assert options == {}


@pytest.mark.asyncio
async def test_empty_samples_are_rejected_before_inference(stt):
    with pytest.raises(ValueError):
        await stt.transcribe_array(np.zeros(0, dtype=np.int16), 16000, "en", "turbo")
    assert stt.model.calls == []


def test_load_goes_through_the_lean_whisper_loader(monkeypatch):
    from backend.backends import mlx_backend, mlx_whisper_loader

    loaded = []
    monkeypatch.setattr(mlx_whisper_loader, "load_whisper", lambda repo: loaded.append(repo) or FakeWhisper())
    backend = mlx_backend.MLXSTTBackend("base")

    backend._load_model_sync("turbo")

    assert loaded == ["openai/whisper-large-v3-turbo"]
    assert isinstance(backend.model, FakeWhisper)
    assert backend.model_size == "turbo"
