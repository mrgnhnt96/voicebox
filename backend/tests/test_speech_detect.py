"""The voice detector that keeps Whisper off audio nobody spoke into."""

import numpy as np
import pytest

from backend.services import speech_detect
from backend.services.speech_detect import SpeechDetector, has_speech

RATE = 48000


def room_noise(seconds, level=300, seed=0):
    return (np.random.default_rng(seed).normal(0, level, round(seconds * RATE))).astype(np.int16)


def voice(seconds, seed=1):
    """A crude vowel: a pitched pulse train through vowel-like resonances,
    with a syllable rhythm. Enough for Silero to hear a voice."""
    rng = np.random.default_rng(seed)
    t = np.arange(round(seconds * RATE)) / RATE
    pitch = 120 + 20 * np.sin(2 * np.pi * 3 * t)
    phase = 2 * np.pi * np.cumsum(pitch) / RATE
    source = sum(np.sin(k * phase) / k for k in range(1, 30))
    formants = sum(np.sin(2 * np.pi * f * t) for f in (700, 1200, 2600))
    syllables = np.clip(np.sin(2 * np.pi * 4 * t), 0, 1)
    signal = source * (1 + 0.3 * formants) * syllables + rng.normal(0, 0.02, len(t))
    return (signal / np.abs(signal).max() * 12000).astype(np.int16)


@pytest.fixture(autouse=True)
def detector_loads():
    assert speech_detect.load() is not None


def test_silence_and_room_noise_are_not_speech():
    assert not has_speech(np.zeros(RATE, dtype=np.int16), RATE)
    assert not has_speech(room_noise(2), RATE)


def test_a_voice_is_speech():
    assert has_speech(np.concatenate([room_noise(0.5), voice(1.5), room_noise(0.5)]), RATE)


def test_float_audio_at_16k_is_checked_too():
    audio = np.concatenate([room_noise(0.5), voice(1.5)]).astype(np.float32)[::3] / 32768
    assert has_speech(audio, 16000)
    assert not has_speech(room_noise(1).astype(np.float32)[::3] / 32768, 16000)


@pytest.mark.parametrize("rate", [16000, 24000, 44100, 48000])
def test_streamed_audio_says_where_the_voice_was(rate):
    silence = np.zeros(rate, dtype=np.int16)
    spoken = voice(1.5)
    spoken = np.interp(np.arange(0, len(spoken), RATE / rate), np.arange(len(spoken)), spoken).astype(np.int16)
    audio = np.concatenate([silence, spoken, silence])
    detector = SpeechDetector(rate)
    for offset in range(0, len(audio), rate // 10):
        detector.feed(audio[offset : offset + rate // 10])
    assert not detector.heard(0, rate // 2)
    assert detector.heard(rate, rate + len(spoken))
    assert not detector.heard(len(audio) - rate // 2, len(audio))


def test_quiet_counts_the_audio_since_the_last_voice():
    rate = 16000
    detector = SpeechDetector(rate)
    detector.feed(np.zeros(rate, dtype=np.int16))
    assert detector.quiet() >= rate * 0.95  # all but a partial window
    detector.feed(voice(1.5)[::3])
    after_voice = detector.quiet()
    assert after_voice < rate * 1.5  # counted from the voice, not the start
    detector.feed(np.zeros(rate, dtype=np.int16))
    assert abs(detector.quiet() - after_voice - rate) <= speech_detect.WINDOW


def test_without_the_model_everything_counts_as_speech(monkeypatch):
    monkeypatch.setattr(speech_detect, "_session", None)
    monkeypatch.setattr(speech_detect, "_unavailable", True)
    assert has_speech(np.zeros(RATE, dtype=np.int16), RATE)
    assert SpeechDetector(RATE).heard(0, RATE)
    # And no pause is ever found, so phrases are all recognized at finish.
    detector = SpeechDetector(RATE)
    detector.feed(np.zeros(RATE, dtype=np.int16))
    assert detector.quiet() == 0
