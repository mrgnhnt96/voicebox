"""Route registration for the voicebox API."""

from fastapi import FastAPI


def register_routers(app: FastAPI) -> None:
    """Include all domain routers on the application."""
    from .health import router as health_router
    from .transcription import router as transcription_router
    from .llm import router as llm_router
    from .captures import router as captures_router
    from .capture_stream import router as capture_stream_router
    from .models import router as models_router
    from .settings import router as settings_router
    from .tasks import router as tasks_router
    from .writing_style import router as writing_style_router

    app.include_router(health_router)
    app.include_router(transcription_router)
    app.include_router(llm_router)
    app.include_router(capture_stream_router)
    app.include_router(captures_router)
    app.include_router(models_router)
    app.include_router(settings_router)
    app.include_router(tasks_router)
    app.include_router(writing_style_router)
