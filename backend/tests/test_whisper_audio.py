"""Whisper audio input without temporary files or SciPy.

Recognition used to write every window to a temporary WAV so mlx-audio could
read it back, and mlx-audio resampled with ``scipy.signal``, whose import is
slow in the packaged server. These tests pin the in-memory replacement to what
mlx-audio's file path produced.
"""

import platform
import sys
import wave

import numpy as np
import pytest

from backend.backends import whisper_audio

requires_mlx = pytest.mark.skipif(
    not (sys.platform == "darwin" and platform.machine() == "arm64"),
    reason="MLX is only installed on Apple Silicon macOS",
)

RATES = [48000, 44100, 32000, 24000, 22050, 8000, 11025]


def speechlike(rate, seconds, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(int(rate * seconds)) / rate
    tone = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.2 * np.sin(2 * np.pi * 3100 * t)
    return np.clip(tone + 0.05 * rng.standard_normal(len(t)), -1, 1)


@pytest.mark.parametrize("rate", RATES)
@pytest.mark.parametrize("seconds", [0.0001, 0.01, 1.3])
def test_resample_matches_scipy_resample_poly_edge(rate, seconds):
    from scipy.signal import resample_poly

    x = speechlike(rate, seconds, seed=rate)
    if not len(x):
        x = np.array([0.25])
    g = np.gcd(rate, 16000)
    expected = resample_poly(x, 16000 // g, rate // g, padtype="edge")

    actual = whisper_audio.resample(x, rate)

    assert actual.shape == expected.shape
    np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-12)


def test_resample_handles_channels_like_scipy():
    from scipy.signal import resample_poly

    x = np.stack([speechlike(48000, 0.5, 1), speechlike(48000, 0.5, 2)], axis=1)

    actual = whisper_audio.resample(x, 48000)

    np.testing.assert_allclose(actual, resample_poly(x, 1, 3, padtype="edge"), rtol=0, atol=1e-12)


def test_resample_at_16k_is_unchanged():
    x = speechlike(16000, 0.2)
    np.testing.assert_array_equal(whisper_audio.resample(x, 16000), x)


def write_wav(path, samples, rate, channels=1):
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(samples.astype("<i2").tobytes())


def pcm(rate, seconds, seed=0):
    return (speechlike(rate, seconds, seed) * 20000).astype(np.int16)


@requires_mlx
def test_16k_pcm_matches_mlx_audio_file_loading_exactly(tmp_path):
    from mlx_audio.stt.utils import load_audio

    samples = pcm(16000, 1.0)
    write_wav(tmp_path / "a.wav", samples, 16000)

    expected = np.array(load_audio(str(tmp_path / "a.wav")))
    actual = np.array(whisper_audio.prepare_samples(samples, 16000))

    assert actual.dtype == np.float32
    np.testing.assert_array_equal(actual, expected)


@requires_mlx
@pytest.mark.parametrize("rate", [48000, 44100])
def test_resampled_pcm_matches_mlx_audio_file_loading(tmp_path, rate):
    from mlx_audio.stt.utils import load_audio

    samples = pcm(rate, 1.0, seed=3)
    write_wav(tmp_path / "a.wav", samples, rate)

    expected = np.array(load_audio(str(tmp_path / "a.wav")))
    actual = np.array(whisper_audio.prepare_samples(samples, rate))

    assert actual.shape == expected.shape
    # float32 rounding of float64 values that differ in the last bit
    np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-6)
    assert np.mean(actual == expected) > 0.99


@requires_mlx
def test_float_samples_are_taken_as_already_scaled():
    samples = pcm(16000, 0.1)
    as_float = samples.astype(np.float64) / 32768.0

    np.testing.assert_array_equal(
        np.array(whisper_audio.prepare_samples(as_float, 16000)),
        np.array(whisper_audio.prepare_samples(samples, 16000)),
    )


@requires_mlx
def test_stereo_file_matches_mlx_audio_file_loading(tmp_path):
    from mlx_audio.stt.utils import load_audio

    stereo = np.stack([pcm(48000, 0.5, 1), pcm(48000, 0.5, 2)], axis=1)
    write_wav(tmp_path / "s.wav", stereo.reshape(-1), 48000, channels=2)

    expected = np.array(load_audio(str(tmp_path / "s.wav")))
    actual = np.array(whisper_audio.read_audio_file(str(tmp_path / "s.wav")))

    np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-6)


@requires_mlx
def test_preparing_audio_does_not_import_scipy(tmp_path):
    import subprocess

    write_wav(tmp_path / "a.wav", pcm(48000, 0.5), 48000)
    code = (
        "import sys, numpy as np\n"
        "from backend.backends import whisper_audio\n"
        f"whisper_audio.read_audio_file({str(tmp_path / 'a.wav')!r})\n"
        "whisper_audio.prepare_samples(np.zeros(4800, dtype=np.int16), 48000)\n"
        "print(sorted(m for m in sys.modules if m.split('.')[0] in ('scipy', 'numba')))\n"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "[]"
