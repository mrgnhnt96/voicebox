"""
Backend abstraction layer for speech-to-text (Whisper) and the local LLM.

Provides a unified interface for MLX and PyTorch backends,
and a model config registry that eliminates per-engine dispatch maps.
"""

# Install HF compatibility patches before any backend imports transformers /
# huggingface_hub. The module runs ``patch_transformers_mistral_regex`` at
# import time, which wraps transformers' tokenizer load against the
# unconditional HuggingFace metadata call that otherwise raises on
# HF_HUB_OFFLINE=1 and on network failures.
from ..utils import hf_offline_patch  # noqa: F401

import threading
from dataclasses import dataclass, field
from typing import Protocol, Optional
from typing_extensions import runtime_checkable
import numpy as np

DEFAULT_LLM_MAX_TOKENS = 512
DEFAULT_LLM_TEMPERATURE = 0.7

from ..utils.platform_detect import get_backend_type

WHISPER_HF_REPOS = {
    "base": "openai/whisper-base",
    "small": "openai/whisper-small",
    "medium": "openai/whisper-medium",
    "large": "openai/whisper-large-v3",
    "turbo": "openai/whisper-large-v3-turbo",
}


@dataclass
class ModelConfig:
    """Declarative config for a downloadable model variant."""

    model_name: str  # e.g. "whisper-turbo", "qwen3-0.6b"
    display_name: str  # e.g. "Whisper Turbo"
    engine: str  # "whisper" or "qwen_llm"
    hf_repo_id: str  # e.g. "openai/whisper-large-v3-turbo"
    model_size: str = "default"
    size_mb: int = 0
    languages: list[str] = field(default_factory=lambda: ["en"])


@runtime_checkable
class STTBackend(Protocol):
    """Protocol for STT (Speech-to-Text) backend implementations."""

    async def load_model(self, model_size: str) -> None:
        """Load STT model."""
        ...

    async def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        model_size: Optional[str] = None,
        previous_text: Optional[str] = None,
    ) -> str:
        """
        Transcribe audio to text.

        ``previous_text`` marks the audio as one phrase of a longer dictation:
        it conditions recognition on the text heard so far and keeps Whisper
        from marking the pause that ended the phrase with an ellipsis.

        Returns:
            Transcribed text
        """
        ...

    async def transcribe_array(
        self,
        samples: np.ndarray,
        sample_rate: int,
        language: Optional[str] = None,
        model_size: Optional[str] = None,
        previous_text: Optional[str] = None,
    ) -> str:
        """
        Transcribe in-memory audio, as ``transcribe`` does for a file.

        ``samples`` is mono int16 PCM, or float audio scaled to [-1, 1], at
        ``sample_rate`` Hz. No temporary file is written.

        Returns:
            Transcribed text
        """
        ...

    def unload_model(self) -> None:
        """Unload model to free memory."""
        ...

    def is_loaded(self) -> bool:
        """Check if model is loaded."""
        ...


@runtime_checkable
class LLMBackend(Protocol):
    """Protocol for local LLM (chat/completion) backend implementations."""

    async def load_model(self, model_size: str) -> None:
        """Load LLM weights and tokenizer."""
        ...

    async def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        max_tokens: int = DEFAULT_LLM_MAX_TOKENS,
        temperature: float = DEFAULT_LLM_TEMPERATURE,
        model_size: Optional[str] = None,
        examples: Optional[list[tuple[str, str]]] = None,
    ) -> str:
        """Run a single-turn chat completion and return the assistant reply.

        ``examples`` is an optional list of ``(user, assistant)`` pairs
        prepended to the conversation as proper chat turns — small models
        pattern-match on inline system-prompt examples (echoing them
        verbatim for unrelated inputs), but treat structured turns as
        data and generalize instead. Used by the refinement service.
        """
        ...

    def unload_model(self) -> None:
        ...

    def is_loaded(self) -> bool:
        ...


# Global backend instances
_stt_backend: Optional[STTBackend] = None
_llm_backends: dict[str, LLMBackend] = {}
_llm_backends_lock = threading.Lock()

LLM_ENGINES = {
    "qwen_llm": "Qwen3 LLM",
}


def _get_whisper_configs() -> list[ModelConfig]:
    """Return Whisper STT model configs."""
    return [
        ModelConfig(
            model_name="whisper-base",
            display_name="Whisper Base",
            engine="whisper",
            hf_repo_id="openai/whisper-base",
            model_size="base",
        ),
        ModelConfig(
            model_name="whisper-small",
            display_name="Whisper Small",
            engine="whisper",
            hf_repo_id="openai/whisper-small",
            model_size="small",
        ),
        ModelConfig(
            model_name="whisper-medium",
            display_name="Whisper Medium",
            engine="whisper",
            hf_repo_id="openai/whisper-medium",
            model_size="medium",
        ),
        ModelConfig(
            model_name="whisper-large",
            display_name="Whisper Large",
            engine="whisper",
            hf_repo_id="openai/whisper-large-v3",
            model_size="large",
        ),
        ModelConfig(
            model_name="whisper-turbo",
            display_name="Whisper Turbo",
            engine="whisper",
            hf_repo_id="openai/whisper-large-v3-turbo",
            model_size="turbo",
        ),
    ]


def _get_qwen_llm_configs() -> list[ModelConfig]:
    """Return Qwen3 LLM configs with backend-aware HF repo IDs.

    MLX path uses 4-bit community quantizations for Apple Silicon; PyTorch path
    uses the upstream instruct weights.
    """
    backend_type = get_backend_type()
    if backend_type == "mlx":
        repo_0_6 = "mlx-community/Qwen3-0.6B-4bit"
        repo_1_7 = "mlx-community/Qwen3-1.7B-4bit"
        repo_4 = "mlx-community/Qwen3-4B-4bit"
    else:
        repo_0_6 = "Qwen/Qwen3-0.6B"
        repo_1_7 = "Qwen/Qwen3-1.7B"
        repo_4 = "Qwen/Qwen3-4B"

    common_languages = [
        "en", "zh", "ja", "ko", "de", "fr", "ru", "pt", "es", "it",
    ]

    return [
        ModelConfig(
            model_name="qwen3-0.6b",
            display_name="Qwen3 0.6B",
            engine="qwen_llm",
            hf_repo_id=repo_0_6,
            model_size="0.6B",
            size_mb=400 if backend_type == "mlx" else 1400,
            languages=common_languages,
        ),
        ModelConfig(
            model_name="qwen3-1.7b",
            display_name="Qwen3 1.7B",
            engine="qwen_llm",
            hf_repo_id=repo_1_7,
            model_size="1.7B",
            size_mb=1100 if backend_type == "mlx" else 3500,
            languages=common_languages,
        ),
        ModelConfig(
            model_name="qwen3-4b",
            display_name="Qwen3 4B",
            engine="qwen_llm",
            hf_repo_id=repo_4,
            model_size="4B",
            size_mb=2500 if backend_type == "mlx" else 8000,
            languages=common_languages,
        ),
    ]


def get_all_model_configs() -> list[ModelConfig]:
    """Return the full list of model configs (STT + LLM)."""
    return _get_whisper_configs() + _get_qwen_llm_configs()


def get_llm_model_configs() -> list[ModelConfig]:
    """Return only LLM model configs."""
    return _get_qwen_llm_configs()


def get_stt_model_configs() -> list[ModelConfig]:
    """Return only STT (Whisper) model configs."""
    return _get_whisper_configs()


# Lookup helpers — these replace the if/elif chains in main.py


def get_model_config(model_name: str) -> Optional[ModelConfig]:
    """Look up a model config by model_name."""
    for cfg in get_all_model_configs():
        if cfg.model_name == model_name:
            return cfg
    return None


async def unload_backend(backend) -> None:
    """Free a backend's model, serialized onto the MLX worker when it has one.

    MLX backends expose an async ``unload`` that runs the free on the dedicated
    MLX thread so it can't collide with an in-flight load/generate. Other
    backends only carry the synchronous ``unload_model``.
    """
    unload = getattr(backend, "unload", None)
    if unload is not None:
        await unload()
    else:
        backend.unload_model()


def _loaded_size(backend) -> Optional[str]:
    return getattr(backend, "_current_model_size", None) or getattr(backend, "model_size", None)


def _backend_for_config(config: ModelConfig):
    """Return the live backend instance that serves ``config``'s engine."""
    from ..services import transcribe, llm as llm_service

    if config.engine == "whisper":
        return transcribe.get_whisper_model()
    if config.engine == "qwen_llm":
        return llm_service.get_llm_model()
    raise ValueError(f"Unknown model engine: {config.engine}")


async def unload_model_by_config(config: ModelConfig) -> bool:
    """Unload a model given its config. Returns True if it was loaded, False otherwise."""
    backend = _backend_for_config(config)
    if backend.is_loaded() and _loaded_size(backend) == config.model_size:
        await unload_backend(backend)
        return True
    return False


def check_model_loaded(config: ModelConfig) -> bool:
    """Check if a model is currently loaded."""
    try:
        backend = _backend_for_config(config)
        return backend.is_loaded() and _loaded_size(backend) == config.model_size
    except Exception:
        return False


def get_model_load_func(config: ModelConfig):
    """Return a callable that loads/downloads the model."""
    return lambda: _backend_for_config(config).load_model(config.model_size)


def get_stt_backend() -> STTBackend:
    """
    Get or create STT backend instance based on platform.

    Returns:
        STT backend instance (MLX or PyTorch)
    """
    global _stt_backend

    if _stt_backend is None:
        backend_type = get_backend_type()

        if backend_type == "mlx":
            from .mlx_backend import MLXSTTBackend

            _stt_backend = MLXSTTBackend()
        else:
            from .pytorch_backend import PyTorchSTTBackend

            _stt_backend = PyTorchSTTBackend()

    return _stt_backend


def get_llm_backend() -> LLMBackend:
    """Get or create the default Qwen3 LLM backend based on platform."""
    return get_llm_backend_for_engine("qwen_llm")


def get_llm_backend_for_engine(engine: str) -> LLMBackend:
    """Get or create an LLM backend for the given engine."""
    global _llm_backends

    if engine in _llm_backends:
        return _llm_backends[engine]

    with _llm_backends_lock:
        if engine in _llm_backends:
            return _llm_backends[engine]

        if engine == "qwen_llm":
            backend_type = get_backend_type()
            if backend_type == "mlx":
                from .qwen_llm_backend import MLXQwenLLMBackend

                backend = MLXQwenLLMBackend()
            else:
                from .qwen_llm_backend import PyTorchQwenLLMBackend

                backend = PyTorchQwenLLMBackend()
        else:
            raise ValueError(f"Unknown LLM engine: {engine}. Supported: {list(LLM_ENGINES.keys())}")

        _llm_backends[engine] = backend
        return backend


def reset_backends():
    """Reset backend instances (useful for testing)."""
    global _stt_backend, _llm_backends
    _stt_backend = None
    _llm_backends.clear()
