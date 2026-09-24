"""
STT (Speech-to-Text) module - delegates to backend abstraction layer.
"""

from ..backends import STTBackend, get_stt_backend, unload_backend


def get_whisper_model() -> STTBackend:
    """
    Get the MLX Whisper STT backend instance.

    Returns:
        STT backend instance
    """
    return get_stt_backend()


async def unload_whisper_model():
    """Unload Whisper model to free memory, serialized onto the MLX worker."""
    await unload_backend(get_stt_backend())
