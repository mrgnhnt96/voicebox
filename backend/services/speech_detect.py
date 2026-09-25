"""Is anyone speaking? A voice detector that runs ahead of Whisper.

Whisper writes something for any audio it is given. On a take with no voice
in it, large-v3-turbo returns a phrase from its training subtitles ("Thank
you.") with full confidence; its own no-speech probability stays near 1e-10
whether anyone spoke or not, so it can't be used to tell. Loudness can't
either: room noise on one microphone is as loud as quiet speech on another.

Silero VAD (``backend/assets/silero_vad.onnx``) is a small model trained to
tell a voice from other sound. On 60 of the user's dictations, the three
silent takes peaked at a voice probability of 0.18 and every take with speech
reached 1.0. It costs about 3 ms per second of audio on one CPU core, so a
dictation checks its audio as it arrives and nothing is left to check after
release.
"""

import logging
import threading
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

MODEL_PATH = Path(__file__).resolve().parent.parent / "assets" / "silero_vad.onnx"
RATE = 16000
WINDOW = 512  # 32 ms, the window Silero is trained on at 16 kHz
CONTEXT = 64  # samples of the previous window Silero sees before each one
# Silero's own default. Silent takes stay below 0.2, speech reaches 1.0.
VOICE_PROBABILITY = 0.5

_lock = threading.Lock()
_session = None
_unavailable = False


def load():
    """The shared ONNX session, or None when the model can't be loaded."""
    global _session, _unavailable
    with _lock:
        if _session is None and not _unavailable:
            try:
                import onnxruntime as ort

                options = ort.SessionOptions()
                options.inter_op_num_threads = 1
                options.intra_op_num_threads = 1
                _session = ort.InferenceSession(str(MODEL_PATH), options, providers=["CPUExecutionProvider"])
            except Exception:
                # Without the detector every take goes to Whisper, as before.
                logger.exception("Could not load the voice detector; transcribing all audio")
                _unavailable = True
        return _session


class SpeechDetector:
    """Voice detection over a stream of int16 PCM at any sample rate.

    ``feed`` audio as it arrives; ``heard(start, end)`` says whether any voice
    was detected between two sample offsets of the stream.
    """

    def __init__(self, rate: int):
        self.rate = rate
        self.session = load()
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros(CONTEXT, dtype=np.float32)
        self.buffer = np.zeros(0, dtype=np.float32)  # 16 kHz, not yet run
        self.carry = np.zeros(0, dtype=np.float32)  # source samples not yet resampled
        self.position = 0.0  # next 16 kHz sample, in source samples from carry[0]
        self.analyzed = 0  # 16 kHz samples run through the model
        self.voiced: list[int] = []  # 16 kHz offsets of voiced windows

    def feed(self, pcm: np.ndarray) -> None:
        if self.session is None:
            return
        samples = np.asarray(pcm, dtype=np.float32) / 32768.0
        self.buffer = np.concatenate([self.buffer, self._to_16k(samples)])
        while len(self.buffer) >= WINDOW:
            window, self.buffer = self.buffer[:WINDOW], self.buffer[WINDOW:]
            if self._probability(window) >= VOICE_PROBABILITY:
                self.voiced.append(self.analyzed)
            self.analyzed += WINDOW

    def heard(self, start: int, end: int) -> bool:
        """Whether a voice was detected between source sample offsets."""
        if self.session is None:
            return True
        low, high = start * RATE / self.rate, end * RATE / self.rate
        return any(low < offset + WINDOW and offset < high for offset in self.voiced)

    def _probability(self, window: np.ndarray) -> float:
        frame = np.concatenate([self.context, window])[np.newaxis]
        probability, self.state = self.session.run(
            None, {"input": frame, "state": self.state, "sr": np.array(RATE, dtype=np.int64)}
        )
        self.context = window[-CONTEXT:]
        return float(probability[0][0])

    def _to_16k(self, samples: np.ndarray) -> np.ndarray:
        if self.rate == RATE:
            return samples
        source = np.concatenate([self.carry, samples])
        if self.rate % RATE == 0:
            # 32 or 48 kHz: average each group of samples, which also filters
            # out most of what would alias.
            factor = self.rate // RATE
            usable = len(source) // factor * factor
            self.carry = source[usable:]
            return source[:usable].reshape(-1, factor).mean(axis=1)
        step = self.rate / RATE
        count = max(0, int(np.floor((len(source) - 1 - self.position) / step)) + 1)
        points = self.position + step * np.arange(count)
        out = np.interp(points, np.arange(len(source)), source).astype(np.float32)
        consumed = int(np.floor(self.position + step * count))
        consumed = min(consumed, len(source))
        self.position = self.position + step * count - consumed
        self.carry = source[consumed:]
        return out


def has_speech(samples: np.ndarray, rate: int) -> bool:
    """Whether a whole recording, int16 or float in [-1, 1], contains a voice."""
    samples = np.asarray(samples)
    if samples.ndim == 2:
        samples = samples.mean(axis=1)
    if np.issubdtype(samples.dtype, np.floating):
        samples = np.clip(samples * 32768.0, -32768, 32767)
    detector = SpeechDetector(rate)
    detector.feed(samples)
    # The last partial window is padded so a word at the very end counts.
    if detector.session is not None and len(detector.buffer):
        detector.feed(np.zeros(WINDOW * rate // RATE + 1))
    return detector.heard(0, len(samples) + rate)
