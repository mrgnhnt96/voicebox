"""
Platform check. Voicebox runs on Apple Silicon only, with MLX as its sole backend.
"""

import platform

BACKEND_TYPE = "mlx"
GPU_TYPE = "Metal (Apple Silicon via MLX)"


def is_apple_silicon() -> bool:
    """True when running on Apple Silicon (arm64 macOS)."""
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def require_apple_silicon() -> None:
    """Raise a clear error unless this is Apple Silicon with a working MLX.

    Raises:
        RuntimeError: on any other platform, or when MLX cannot load.
    """
    if not is_apple_silicon():
        raise RuntimeError(
            "Voicebox requires an Apple Silicon Mac (arm64 macOS); "
            f"this is {platform.system()} {platform.machine()}."
        )
    try:
        import mlx.core  # noqa: F401 — triggers native lib loading
    except (ImportError, OSError, RuntimeError) as e:
        # OSError covers a missing .dylib / .metallib inside a PyInstaller bundle.
        raise RuntimeError(f"MLX failed to load: {e}") from e
