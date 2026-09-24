"""
Whisper audio input without temporary files or SciPy.

mlx-audio's Whisper reads audio from a file path and resamples it with
``scipy.signal.resample_poly``. Importing ``scipy.signal`` loads about a
hundred native libraries, which in the packaged server costs seconds (see
``mlx_whisper_loader``). This module prepares the same float32 16 kHz
waveform in memory, with a NumPy port of ``resample_poly(..., padtype="edge")``.
"""

from __future__ import annotations

from math import gcd

import numpy as np

SAMPLE_RATE = 16000


def _kaiser_lowpass(numtaps: int, cutoff: float, beta: float = 5.0) -> np.ndarray:
    """``scipy.signal.firwin(numtaps, cutoff, window=("kaiser", beta))``."""
    alpha = 0.5 * (numtaps - 1)
    m = np.arange(numtaps) - alpha
    h = cutoff * np.sinc(cutoff * m)
    h *= np.kaiser(numtaps, beta)
    h /= np.sum(h)
    return h


def _resample_channel(x: np.ndarray, up: int, down: int, h: np.ndarray, start: int, count: int) -> np.ndarray:
    """Outputs ``start .. start+count`` of ``upfirdn(h, x, up, down, mode="edge")``.

    Output ``k`` is ``sum(x[n] * h[k*down - n*up])`` over original samples
    ``n``, with samples before the start or after the end taking the edge
    value. Terms are accumulated in increasing ``n``, as SciPy does.
    """
    taps_per_phase = -(-len(h) // up)
    padded_h = np.zeros(taps_per_phase * up)
    padded_h[: len(h)] = h

    last_n = ((start + count - 1) * down) // up
    left = taps_per_phase
    right = max(0, last_n - len(x) + 1) + 1
    padded_x = np.concatenate([np.full(left, x[0]), x, np.full(right, x[-1])])

    y = np.empty(count)
    # Outputs k and k+up share a filter phase and sit exactly `down` input
    # samples apart, so each phase is a strided slice of the input.
    for r in range(min(up, count)):
        outputs = len(range(r, count, up))
        t = (start + r) * down
        base, phase = t // up + left, t % up
        if up == 1:
            # One phase with few taps (48 kHz and other integer ratios): sum
            # tap by tap, in SciPy's order, so the result is bit-identical.
            acc = np.zeros(outputs)
            for j in range(taps_per_phase - 1, -1, -1):
                first = base - j
                acc += padded_h[phase + j * up] * padded_x[first : first + down * (outputs - 1) + 1 : down]
        else:
            # Many phases (44.1 kHz has 160): one matrix-vector product per
            # phase over a zero-copy window view, instead of thousands of tiny
            # array operations. Equal to SciPy within float64 rounding.
            windows = np.lib.stride_tricks.as_strided(
                padded_x[base - taps_per_phase + 1 :],
                shape=(outputs, taps_per_phase),
                strides=(down * padded_x.strides[0], padded_x.strides[0]),
                writeable=False,
            )
            acc = windows @ padded_h[phase :: up][::-1]
        y[r::up] = acc
    return y


def resample(x: np.ndarray, orig_sr: int, target_sr: int = SAMPLE_RATE) -> np.ndarray:
    """``scipy.signal.resample_poly(x, up, down, padtype="edge")`` along axis 0.

    This is what mlx-audio's ``load_audio`` applies to files that are not
    already at 16 kHz.
    """
    x = np.asarray(x, dtype=np.float64)
    g = gcd(int(orig_sr), int(target_sr))
    up, down = int(target_sr) // g, int(orig_sr) // g
    if up == down == 1:
        return x.copy()

    max_rate = max(up, down)
    half_len = 10 * max_rate
    h = _kaiser_lowpass(2 * half_len + 1, 1.0 / max_rate) * up
    # Center the output samples, exactly as resample_poly pads the filter.
    n_pre_pad = down - half_len % down
    h = np.concatenate([np.zeros(n_pre_pad), h])
    n_in = x.shape[0]
    n_out = n_in * up // down + bool(n_in * up % down)
    start = (half_len + n_pre_pad) // down

    if x.ndim == 1:
        return _resample_channel(x, up, down, h, start, n_out)
    return np.stack([_resample_channel(x[:, c], up, down, h, start, n_out) for c in range(x.shape[1])], axis=1)


def _to_float64(samples: np.ndarray) -> np.ndarray:
    samples = np.asarray(samples)
    if samples.dtype == np.int16:
        # Same scaling as mlx_audio.audio_io.read.
        return samples.astype(np.float64) / 32768.0
    if not np.issubdtype(samples.dtype, np.floating):
        raise TypeError(f"Expected int16 or float samples, got {samples.dtype}")
    return samples.astype(np.float64)


def _to_whisper_input(audio: np.ndarray, sample_rate: int):
    """(samples, channels) float64 -> mono float32 mx.array at 16 kHz, like load_audio."""
    import mlx.core as mx

    if audio.ndim == 1:
        audio = audio[:, np.newaxis]
    if sample_rate != SAMPLE_RATE:
        audio = resample(audio, sample_rate)
    return mx.array(audio, dtype=mx.float32).mean(axis=1)


def prepare_samples(samples: np.ndarray, sample_rate: int):
    """Whisper's input for in-memory audio.

    ``samples`` is int16 PCM or float audio already scaled to [-1, 1], shaped
    ``(n,)`` or ``(n, channels)``. The result equals what mlx-audio produces
    from the same audio written to a WAV file.
    """
    return _to_whisper_input(_to_float64(samples), int(sample_rate))


def to_16k_mono_float32(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """NumPy-only variant of ``prepare_samples`` for non-MLX backends."""
    audio = _to_float64(samples)
    if int(sample_rate) != SAMPLE_RATE:
        audio = resample(audio, int(sample_rate))
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    return audio.astype(np.float32)


def read_audio_file(path: str):
    """Whisper's input for an audio file, decoded like mlx-audio's ``load_audio``."""
    from mlx_audio.audio_io import read

    audio, sample_rate = read(str(path), always_2d=True)
    return _to_whisper_input(np.asarray(audio, dtype=np.float64), int(sample_rate))
