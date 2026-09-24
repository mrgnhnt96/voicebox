"""Health and infrastructure endpoints."""

import asyncio
import os
import signal

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import config, models
from ..services import transcribe
from ..database import get_db
from ..utils.platform_detect import BACKEND_TYPE, GPU_TYPE

router = APIRouter()

@router.get("/")
async def root():
    """Root endpoint."""
    from .. import __version__

    return {"message": "voicebox API", "version": __version__}


@router.post("/shutdown")
async def shutdown():
    """Gracefully shutdown the server."""

    async def shutdown_async():
        await asyncio.sleep(0.1)
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.create_task(shutdown_async())
    return {"message": "Shutting down..."}


@router.post("/watchdog/disable")
async def watchdog_disable():
    """Disable the parent process watchdog so the server keeps running."""
    from backend.server import disable_watchdog

    disable_watchdog()
    return {"message": "Watchdog disabled"}


@router.get("/health", response_model=models.HealthResponse)
async def health(db: Session = Depends(get_db)):
    """Health check endpoint.

    ``model_loaded`` / ``model_size`` describe the Whisper model in memory;
    ``model_downloaded`` says whether the Whisper model chosen in the capture
    settings is cached locally.
    """
    whisper_model = transcribe.get_whisper_model()
    model_loaded = False
    model_size = None
    try:
        if whisper_model.is_loaded():
            model_loaded = True
            model_size = getattr(whisper_model, "model_size", None)
    except Exception:
        model_loaded = False
        model_size = None

    model_downloaded = None
    try:
        from ..backends import WHISPER_HF_REPOS
        from ..backends.base import is_model_cached
        from ..services import settings as settings_service

        stt_size = settings_service.get_capture_settings(db).stt_model
        repo = WHISPER_HF_REPOS.get(stt_size)
        if repo:
            model_downloaded = is_model_cached(repo, weight_extensions=(".safetensors", ".bin", ".npz"))
    except Exception:
        pass

    return models.HealthResponse(
        status="healthy",
        model_loaded=model_loaded,
        model_downloaded=model_downloaded,
        model_size=model_size,
        # Startup refuses anything but Apple Silicon, so MLX on Metal is
        # always the backend here.
        gpu_available=True,
        gpu_type=GPU_TYPE,
        backend_type=BACKEND_TYPE,
    )


@router.get("/health/filesystem", response_model=models.FilesystemHealthResponse)
async def filesystem_health():
    """Check filesystem health: directory existence, write permissions, and disk space."""
    import shutil

    dirs_to_check = {
        "captures": config.get_captures_dir(),
        "data": config.get_data_dir(),
    }

    checks: list[models.DirectoryCheck] = []
    all_ok = True

    for _label, dir_path in dirs_to_check.items():
        exists = dir_path.exists()
        writable = False
        error = None
        if exists:
            probe = dir_path / ".voicebox_probe"
            try:
                probe.write_text("ok")
                probe.unlink()
                writable = True
            except PermissionError:
                error = "Permission denied"
            except OSError as e:
                error = str(e)
            finally:
                try:
                    probe.unlink(missing_ok=True)
                except Exception:
                    pass
        else:
            error = "Directory does not exist"

        if not exists or not writable:
            all_ok = False

        checks.append(
            models.DirectoryCheck(
                path=str(dir_path.resolve()),
                exists=exists,
                writable=writable,
                error=error,
            )
        )

    disk_free_mb = None
    disk_total_mb = None
    try:
        usage = shutil.disk_usage(str(config.get_data_dir()))
        disk_free_mb = round(usage.free / (1024 * 1024), 1)
        disk_total_mb = round(usage.total / (1024 * 1024), 1)
        if disk_free_mb < 500:
            all_ok = False
    except OSError:
        all_ok = False

    return models.FilesystemHealthResponse(
        healthy=all_ok,
        disk_free_mb=disk_free_mb,
        disk_total_mb=disk_total_mb,
        directories=checks,
    )
