"""
MLX backend implementation for Whisper STT using mlx-audio.
"""

from typing import Optional
import logging
import numpy as np

logger = logging.getLogger(__name__)

# PATCH: Import and apply offline patch BEFORE any huggingface_hub usage
# This prevents mlx_audio from making network requests when models are cached
from ..utils.hf_offline_patch import patch_huggingface_hub_offline

patch_huggingface_hub_offline()

from . import WHISPER_HF_REPOS
from .base import (
    is_model_cached,
    ellipsis_token_ids,
    model_load_progress,
)
from ..services import speech_detect
from ..services.refinement import strip_stt_artifacts
from ..services.mlx_thread import run_on_mlx_thread, clear_mlx_cache
from . import mlx_whisper_loader, whisper_audio


def vocabulary_decoder(tokenizer):
    """Decode many token sequences in one call, or None if unavailable.

    mlx-audio's tokenizer wraps a Hugging Face fast tokenizer; its Rust
    backend decodes a batch without a Python round trip per token. Special
    tokens are kept, as the wrapper's own ``decode`` keeps them.
    """
    backend = getattr(getattr(tokenizer, "hf_tokenizer", None), "backend_tokenizer", None)
    if backend is None or not hasattr(backend, "decode_batch"):
        return None
    return lambda sequences: backend.decode_batch(sequences, skip_special_tokens=False)


class MLXSTTBackend:
    """MLX-based STT backend using mlx-audio Whisper."""

    def __init__(self, model_size: str = "base"):
        self.model = None
        self.model_size = model_size

    def is_loaded(self) -> bool:
        """Check if model is loaded."""
        return self.model is not None

    def _is_model_cached(self, model_size: str) -> bool:
        hf_repo = WHISPER_HF_REPOS.get(model_size, f"openai/whisper-{model_size}")
        return is_model_cached(hf_repo, weight_extensions=(".safetensors", ".bin", ".npz"))

    def _ensure_loaded_sync(self, model_size: Optional[str]):
        """Load the model if the requested size isn't already resident.

        Runs on the MLX worker thread so it stays serialized with transcription.
        """
        if model_size is None:
            model_size = self.model_size

        if self.model is not None and self.model_size == model_size:
            return

        self._load_model_sync(model_size)

    async def load_model_async(self, model_size: Optional[str] = None):
        """
        Lazy load the MLX Whisper model.

        Args:
            model_size: Model size (tiny, base, small, medium, large)
        """
        await run_on_mlx_thread(self._ensure_loaded_sync, model_size)

    # Alias for compatibility
    load_model = load_model_async

    async def unload(self):
        """Free the model, serialized onto the MLX worker thread."""
        await run_on_mlx_thread(self.unload_model)

    def _load_model_sync(self, model_size: str):
        """Synchronous model loading."""
        progress_model_name = f"whisper-{model_size}"
        is_cached = self._is_model_cached(model_size)

        with model_load_progress(progress_model_name, is_cached):
            model_name = WHISPER_HF_REPOS.get(model_size, f"openai/whisper-{model_size}")
            logger.info("Loading MLX Whisper model %s...", model_size)

            # mlx_audio.stt.load, minus imports Whisper never uses; they were
            # most of the packaged server's startup load time.
            self.model = mlx_whisper_loader.load_whisper(model_name)

        self.model_size = model_size
        logger.info("MLX Whisper model %s loaded successfully", model_size)

    def unload_model(self):
        """Unload the model to free memory."""
        if self.model is not None:
            del self.model
            self.model = None
            clear_mlx_cache()
            logger.info("MLX Whisper model unloaded")

    async def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        model_size: Optional[str] = None,
        previous_text: Optional[str] = None,
        check_speech: bool = True,
    ) -> str:
        """
        Transcribe an audio file to text.

        Args:
            audio_path: Path to audio file
            language: Optional language hint
            model_size: Optional model size override
            previous_text: Earlier dictation text when transcribing one phrase
            check_speech: Return "" without running Whisper when no voice is
                detected; False when the caller already checked

        Returns:
            Transcribed text
        """
        # Decoded here rather than by mlx-audio, whose resampler would import
        # scipy.signal on the first file that is not 16 kHz.
        return await self._transcribe(
            lambda: whisper_audio.read_audio_file(audio_path), language, model_size, previous_text, check_speech
        )

    async def transcribe_array(
        self,
        samples: np.ndarray,
        sample_rate: int,
        language: Optional[str] = None,
        model_size: Optional[str] = None,
        previous_text: Optional[str] = None,
        check_speech: bool = True,
    ) -> str:
        """
        Transcribe in-memory audio to text, without a temporary file.

        Args:
            samples: Mono int16 PCM, or float audio scaled to [-1, 1]; shape
                (n,) or (n, channels)
            sample_rate: Sample rate of ``samples`` in Hz (resampled to 16 kHz)
            language: Optional language hint
            model_size: Optional model size override
            previous_text: Earlier dictation text when transcribing one phrase
            check_speech: Return "" without running Whisper when no voice is
                detected; False when the caller already checked

        Returns:
            Transcribed text, identical to ``transcribe`` of the same audio
            written to a WAV file
        """
        samples = np.asarray(samples)
        if samples.size == 0:
            raise ValueError("No audio samples to transcribe")
        return await self._transcribe(
            lambda: whisper_audio.prepare_samples(samples, sample_rate),
            language,
            model_size,
            previous_text,
            check_speech,
        )

    async def _transcribe(self, prepare_audio, language, model_size, previous_text, check_speech=True) -> str:
        def _transcribe_sync():
            audio = prepare_audio()
            # Whisper invents text ("Thank you.") for audio without a voice.
            if check_speech and not speech_detect.has_speech(np.asarray(audio), whisper_audio.SAMPLE_RATE):
                return ""

            decode_options = {}
            if language:
                decode_options["language"] = language
            if previous_text is not None:
                tokenizer = self.model.get_tokenizer(language=language or "en")
                decode_options["suppress_tokens"] = [
                    -1,
                    *ellipsis_token_ids(self.model_size, tokenizer.decode, tokenizer.eot, vocabulary_decoder(tokenizer)),
                ]
                if previous_text:
                    decode_options["initial_prompt"] = previous_text

            # Inference runs with the process's default HF_HUB_OFFLINE
            # state — see the comment in MLXTTSBackend.generate for the
            # regression this revert fixes (issue #462).
            result = self.model.generate(audio, **decode_options)

            if isinstance(result, str):
                text = result
            elif isinstance(result, dict):
                text = result.get("text", "")
            elif hasattr(result, "text"):
                text = result.text
            else:
                text = str(result)
            return strip_stt_artifacts(text.strip())

        # Load-if-needed and transcription run as one job on the MLX worker so
        # a concurrent unload or load can't land between them.
        def _load_and_transcribe():
            self._ensure_loaded_sync(model_size)
            return _transcribe_sync()

        return await run_on_mlx_thread(_load_and_transcribe)
