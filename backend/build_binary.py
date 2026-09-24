"""
PyInstaller build script for creating the standalone Python server binary.

Usage:
    python build_binary.py
"""

import PyInstaller.__main__
import logging
import os
import platform
import sys
from pathlib import Path

logger = logging.getLogger(__name__)


def is_apple_silicon():
    """Check if running on Apple Silicon."""
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def build_server():
    """Build the Python server as a standalone onefile binary."""
    backend_dir = Path(__file__).parent
    binary_name = "voicebox-server"

    args = [
        "server.py",  # Use server.py as entry point instead of main.py
        "--onefile",
        "--name",
        binary_name,
        # Include service packages used by optional flows and subprocess workers.
        "--collect-submodules",
        "backend.services",
    ]

    # numpy 2.x / torch ABI mismatch fix: install memmove fallback for
    # torch.from_numpy() before the app starts. Runtime hooks run after
    # FrozenImporter is registered so frozen torch/numpy are importable.
    # Paths are passed relative to backend_dir because os.chdir(backend_dir)
    # runs before PyInstaller. Absolute paths would get baked into the
    # generated .spec, breaking reproducible builds on other machines / CI.
    args.extend(
        [
            "--runtime-hook",
            "pyi_rth_numpy_compat.py",
            # Stub torch.compiler.disable before transformers imports
            # flex_attention, which otherwise triggers torch._dynamo →
            # torch._numpy._ufuncs and crashes at module load under
            # PyInstaller. See pyi_rth_torch_compiler_disable.py.
            "--runtime-hook",
            "pyi_rth_torch_compiler_disable.py",
            # Per-module collection overrides (e.g. forcing scipy.stats._distn_infrastructure
            # to bundle .py source alongside .pyc so the runtime hook can source-patch it).
            "--additional-hooks-dir",
            "pyi_hooks",
        ]
    )

    # Add common hidden imports
    args.extend(
        [
            "--hidden-import",
            "backend",
            "--hidden-import",
            "backend.main",
            "--hidden-import",
            "backend.config",
            "--hidden-import",
            "backend.database",
            "--hidden-import",
            "backend.models",
            "--hidden-import",
            "backend.services.transcribe",
            "--hidden-import",
            "backend.utils.platform_detect",
            "--hidden-import",
            "backend.backends",
            "--hidden-import",
            "backend.backends.pytorch_backend",
            "--hidden-import",
            "backend.backends.qwen_llm_backend",
            "--hidden-import",
            "backend.utils.audio",
            "--hidden-import",
            "backend.utils.progress",
            "--hidden-import",
            "backend.utils.hf_progress",
            "--hidden-import",
            "torch",
            "--hidden-import",
            "transformers",
            "--hidden-import",
            "fastapi",
            "--hidden-import",
            "uvicorn",
            # Uvicorn resolves WebSocket transports by import string. Include
            # the streaming dictation transport in frozen desktop builds.
            "--hidden-import",
            "uvicorn.protocols.websockets.auto",
            "--hidden-import",
            "uvicorn.protocols.websockets.websockets_impl",
            "--collect-submodules",
            "websockets",
            "--hidden-import",
            "sqlalchemy",
            # librosa uses lazy_loader which generates .pyi stub files at
            # install time and reads them at runtime to discover submodules.
            # --hidden-import alone doesn't bundle the stubs, causing
            # "Cannot load imports from non-existent stub" at runtime.
            "--collect-all",
            "lazy_loader",
            "--collect-all",
            "librosa",
            "--hidden-import",
            "soundfile",
            "--copy-metadata",
            "requests",
            "--copy-metadata",
            "transformers",
            "--copy-metadata",
            "huggingface-hub",
            "--copy-metadata",
            "tokenizers",
            "--copy-metadata",
            "safetensors",
            "--copy-metadata",
            "tqdm",
            "--hidden-import",
            "requests",
            # Fix for pkg_resources and jaraco namespace packages
            "--hidden-import",
            "pkg_resources.extern",
            "--collect-submodules",
            "jaraco",
        ]
    )

    if sys.version_info >= (3, 13):
        args.extend(["--hidden-import", "audioop"])

    # Keep NVIDIA CUDA packages out of the binary. If the build venv has a
    # CUDA torch installed, PyInstaller would otherwise bundle ~3GB of
    # NVIDIA shared libraries that the app never uses.
    nvidia_packages = [
        "nvidia",
        "nvidia.cublas",
        "nvidia.cuda_cupti",
        "nvidia.cuda_nvrtc",
        "nvidia.cuda_runtime",
        "nvidia.cudnn",
        "nvidia.cufft",
        "nvidia.curand",
        "nvidia.cusolver",
        "nvidia.cusparse",
        "nvidia.nccl",
        "nvidia.nvjitlink",
        "nvidia.nvtx",
    ]
    for pkg in nvidia_packages:
        args.extend(["--exclude-module", pkg])

    # Add MLX-specific imports if building on Apple Silicon
    if is_apple_silicon():
        logger.info("Building for Apple Silicon - including MLX dependencies")
        args.extend(
            [
                "--hidden-import",
                "backend.backends.mlx_backend",
                "--hidden-import",
                "mlx",
                "--hidden-import",
                "mlx.core",
                "--hidden-import",
                "mlx.nn",
                "--hidden-import",
                "mlx_audio",
                "--hidden-import",
                "mlx_audio.stt",
                "--hidden-import",
                "mlx_lm",
                "--collect-submodules",
                "mlx",
                "--collect-submodules",
                "mlx_audio",
                "--collect-submodules",
                "mlx_lm",
                # Use --collect-all so PyInstaller bundles both data files AND
                # native shared libraries (.dylib, .metallib) for MLX.
                # Previously only --collect-data was used, which caused MLX to
                # raise OSError at runtime inside the bundled binary because
                # the Metal shader libraries were missing.
                "--collect-all",
                "mlx",
                "--collect-all",
                "mlx_audio",
                # mlx_lm ships chat_templates/ JSON files and loads tool_parsers
                # submodules dynamically via importlib at tokenizer load time,
                # which --hidden-import alone can't resolve.
                "--collect-all",
                "mlx_lm",
            ]
        )
    else:
        logger.info("Building for a non-Apple Silicon platform - PyTorch only")

    dist_dir = str(backend_dir / "dist")
    build_dir = str(backend_dir / "build")

    args.extend(
        [
            "--distpath",
            dist_dir,
            "--workpath",
            build_dir,
            "--noconfirm",
            "--clean",
        ]
    )

    # Change to backend directory
    os.chdir(backend_dir)

    PyInstaller.__main__.run(args)

    logger.info("Binary built in %s", backend_dir / "dist" / binary_name)


if __name__ == "__main__":
    build_server()
