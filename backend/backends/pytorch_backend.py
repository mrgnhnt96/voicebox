"""
PyTorch backend implementation for Whisper STT.
"""

from typing import Optional
import asyncio
import logging
import torch
import numpy as np

logger = logging.getLogger(__name__)

from . import WHISPER_HF_REPOS
from .base import (
    ellipsis_token_ids,
    is_model_cached,
    get_torch_device,
    empty_device_cache,
    model_load_progress,
)
from ..utils.audio import load_audio


class PyTorchSTTBackend:
    """PyTorch-based STT backend using Whisper."""

    def __init__(self, model_size: str = "base"):
        self.model = None
        self.processor = None
        self.model_size = model_size
        self.device = self._get_device()

    def _get_device(self) -> str:
        """Get the best available device."""
        return get_torch_device()

    def is_loaded(self) -> bool:
        """Check if model is loaded."""
        return self.model is not None

    def _is_model_cached(self, model_size: str) -> bool:
        hf_repo = WHISPER_HF_REPOS.get(model_size, f"openai/whisper-{model_size}")
        return is_model_cached(hf_repo)

    async def load_model_async(self, model_size: Optional[str] = None):
        """
        Lazy load the Whisper model.

        Args:
            model_size: Model size (tiny, base, small, medium, large)
        """
        if model_size is None:
            model_size = self.model_size

        if self.model is not None and self.model_size == model_size:
            return

        await asyncio.to_thread(self._load_model_sync, model_size)

    # Alias for compatibility
    load_model = load_model_async

    def _load_model_sync(self, model_size: str):
        """Synchronous model loading."""
        progress_model_name = f"whisper-{model_size}"
        is_cached = self._is_model_cached(model_size)

        with model_load_progress(progress_model_name, is_cached):
            from transformers import WhisperProcessor, WhisperForConditionalGeneration

            model_name = WHISPER_HF_REPOS.get(model_size, f"openai/whisper-{model_size}")
            logger.info("Loading Whisper model %s on %s...", model_size, self.device)

            self.processor = WhisperProcessor.from_pretrained(model_name)
            self.model = WhisperForConditionalGeneration.from_pretrained(model_name)

        self.model.to(self.device)
        self.model_size = model_size
        logger.info("Whisper model %s loaded successfully", model_size)

    def unload_model(self):
        """Unload the model to free memory."""
        if self.model is not None:
            del self.model
            del self.processor
            self.model = None
            self.processor = None

            empty_device_cache(self.device)

            logger.info("Whisper model unloaded")

    async def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        model_size: Optional[str] = None,
        previous_text: Optional[str] = None,
    ) -> str:
        """
        Transcribe audio to text.

        Args:
            audio_path: Path to audio file
            language: Optional language hint
            model_size: Optional model size override
            previous_text: Earlier dictation text when transcribing one phrase

        Returns:
            Transcribed text
        """
        return await self._transcribe(
            lambda: load_audio(audio_path, sample_rate=16000)[0], language, model_size, previous_text
        )

    async def transcribe_array(
        self,
        samples: np.ndarray,
        sample_rate: int,
        language: Optional[str] = None,
        model_size: Optional[str] = None,
        previous_text: Optional[str] = None,
    ) -> str:
        """
        Transcribe in-memory audio to text, without a temporary file.

        Args:
            samples: Mono int16 PCM, or float audio scaled to [-1, 1]
            sample_rate: Sample rate of ``samples`` in Hz (resampled to 16 kHz)
            language: Optional language hint
            model_size: Optional model size override
            previous_text: Earlier dictation text when transcribing one phrase

        Returns:
            Transcribed text
        """
        from .whisper_audio import to_16k_mono_float32

        samples = np.asarray(samples)
        if samples.size == 0:
            raise ValueError("No audio samples to transcribe")
        return await self._transcribe(
            lambda: to_16k_mono_float32(samples, sample_rate), language, model_size, previous_text
        )

    async def _transcribe(self, get_audio, language, model_size, previous_text) -> str:
        await self.load_model_async(model_size)

        def _transcribe_sync():
            """Run synchronous transcription in thread pool."""
            audio = get_audio()

            # Inference runs with the process's default HF_HUB_OFFLINE
            # state — forcing offline here (issue #462) broke online users
            # whose `get_decoder_prompt_ids` / tokenizer calls issue
            # legitimate metadata lookups.
            # Process audio
            inputs = self.processor(
                audio,
                sampling_rate=16000,
                return_tensors="pt",
            )
            inputs = inputs.to(self.device)

            # Generate transcription
            # If language is provided, force it; otherwise let Whisper auto-detect
            generate_kwargs = {}
            if language:
                forced_decoder_ids = self.processor.get_decoder_prompt_ids(
                    language=language,
                    task="transcribe",
                )
                generate_kwargs["forced_decoder_ids"] = forced_decoder_ids
            if previous_text is not None:
                tokenizer = self.processor.tokenizer
                generate_kwargs["bad_words_ids"] = [
                    [token] for token in ellipsis_token_ids(self.model_size, tokenizer.decode, len(tokenizer))
                ]
                if previous_text:
                    generate_kwargs["prompt_ids"] = self.processor.get_prompt_ids(
                        previous_text, return_tensors="pt"
                    ).to(self.device)

            with torch.no_grad():
                predicted_ids = self.model.generate(
                    inputs["input_features"],
                    **generate_kwargs,
                )

            # Decode
            transcription = self.processor.batch_decode(
                predicted_ids,
                skip_special_tokens=True,
            )[0]

            return transcription.strip()

        # Run blocking transcription in thread pool
        return await asyncio.to_thread(_transcribe_sync)
