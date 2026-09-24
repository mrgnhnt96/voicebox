"""
Pydantic models for request/response validation.
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Literal
from datetime import datetime

from .utils.capture_chords import (
    default_push_to_talk_chord,
    default_toggle_to_talk_chord,
)


class TranscriptionRequest(BaseModel):
    """Request model for audio transcription."""

    language: Optional[str] = Field(None, pattern="^(en|zh|ja|ko|de|fr|ru|pt|es|it)$")
    model: Optional[str] = Field(None, pattern="^(base|small|medium|large|turbo)$")


class TranscriptionResponse(BaseModel):
    """Response model for transcription."""

    text: str
    duration: float


class RefinementFlagsModel(BaseModel):
    """Boolean toggles that drive the refinement prompt builder."""

    smart_cleanup: bool = True
    self_correction: bool = True
    preserve_technical: bool = True
    punctuation_style: str = Field(default="standard", pattern="^(standard|casual|learned)$")


class RefinementReviewModel(BaseModel):
    """Why a capture's cleanup is flagged for the user to check."""

    outcome: Literal["review", "reject"]
    added: List[str] = []
    missing: List[str] = []
    reasons: List[str] = []


class CaptureResponse(BaseModel):
    """Response model for a capture."""

    id: str
    audio_path: str
    source: str
    language: Optional[str] = None
    duration_ms: Optional[int] = None
    transcript_raw: str
    transcript_refined: Optional[str] = None
    stt_model: Optional[str] = None
    llm_model: Optional[str] = None
    refinement_flags: Optional[RefinementFlagsModel] = None
    refinement_review: Optional[RefinementReviewModel] = None
    created_at: datetime

    class Config:
        from_attributes = True


class CaptureListResponse(BaseModel):
    """Response model for paginated capture list."""

    items: List[CaptureResponse]
    total: int


class CaptureCreateResponse(CaptureResponse):
    """
    Response model for ``POST /captures``.

    Adds ``auto_refine`` and ``allow_auto_paste`` — the server-side settings
    captured at the moment the capture was created. The client reads these to
    decide whether to chain a refinement request and whether to fire the
    synthetic-paste pipeline, so it doesn't need a synced local copy of the
    capture_settings table across sibling Tauri webviews.
    """

    auto_refine: bool
    allow_auto_paste: bool


class CaptureRefineRequest(BaseModel):
    """Request to refine a capture's transcript via the LLM."""

    flags: Optional[RefinementFlagsModel] = None
    model_size: Optional[str] = Field(default=None, pattern="^(0\\.6B|1\\.7B|4B)$")


class CaptureRetranscribeRequest(BaseModel):
    """Request to re-run STT on a capture's audio with a different model."""

    model: Optional[str] = Field(None, pattern="^(base|small|medium|large|turbo)$")
    language: Optional[str] = Field(None, pattern="^(en|zh|ja|ko|de|fr|ru|pt|es|it)$")


class CaptureSettingsResponse(BaseModel):
    """Server-persisted defaults for the capture / refine flow."""

    stt_model: str = Field(default="turbo", pattern="^(base|small|medium|large|turbo)$")
    language: str = Field(default="auto")
    auto_refine: bool = True
    llm_model: str = Field(default="0.6B", pattern="^(0\\.6B|1\\.7B|4B)$")
    smart_cleanup: bool = True
    self_correction: bool = True
    preserve_technical: bool = True
    punctuation_style: str = Field(default="standard", pattern="^(standard|casual|learned)$")
    allow_auto_paste: bool = True
    input_device_id: Optional[str] = Field(
        default=None, description="Configured audio input deviceId (None means default microphone)"
    )
    hotkey_enabled: bool = False
    chord_push_to_talk_keys: List[str] = Field(
        default_factory=default_push_to_talk_chord
    )
    chord_toggle_to_talk_keys: List[str] = Field(
        default_factory=default_toggle_to_talk_chord
    )

    class Config:
        from_attributes = True


class CaptureSettingsUpdate(BaseModel):
    """Partial update for capture settings — every field is optional."""

    stt_model: Optional[str] = Field(default=None, pattern="^(base|small|medium|large|turbo)$")
    language: Optional[str] = None
    auto_refine: Optional[bool] = None
    llm_model: Optional[str] = Field(default=None, pattern="^(0\\.6B|1\\.7B|4B)$")
    smart_cleanup: Optional[bool] = None
    self_correction: Optional[bool] = None
    preserve_technical: Optional[bool] = None
    punctuation_style: Optional[str] = Field(default=None, pattern="^(standard|casual|learned)$")
    allow_auto_paste: Optional[bool] = None
    input_device_id: Optional[str] = Field(
        default=None, description="Configured audio input deviceId (None means default microphone)"
    )
    hotkey_enabled: Optional[bool] = None
    chord_push_to_talk_keys: Optional[List[str]] = Field(default=None, min_length=1, max_length=6)
    chord_toggle_to_talk_keys: Optional[List[str]] = Field(default=None, min_length=1, max_length=6)


class LLMGenerateRequest(BaseModel):
    """Request model for LLM text generation."""

    prompt: str = Field(..., min_length=1, max_length=50000)
    system: Optional[str] = Field(None, max_length=4000)
    model_size: Optional[str] = Field(default="0.6B", pattern="^(0\\.6B|1\\.7B|4B)$")
    max_tokens: int = Field(default=512, ge=1, le=4096)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    # Few-shot (user, assistant) pairs prepended as real chat turns.
    # Used by the refinement service to pin tricky rules (imperatives
    # staying imperatives, technical-term punctuation) that small models
    # lose when the examples live inline in the system prompt.
    examples: Optional[List[List[str]]] = Field(default=None, max_length=8)


class LLMGenerateResponse(BaseModel):
    """Response model for LLM text generation."""

    text: str
    model_size: str


class ModelReadiness(BaseModel):
    """Per-model entry in the dictation readiness checklist.

    ``model_name`` is the canonical id used by ``POST /models/download`` so the
    frontend can wire a one-click "Download" button without a second lookup.
    ``size`` is the user's chosen variant (e.g. "turbo", "0.6B"); ``display_name``
    is what the checklist row should show ("Whisper Turbo").
    """

    ready: bool
    model_name: str
    display_name: str
    size: str
    size_mb: Optional[int] = None


class CaptureReadinessResponse(BaseModel):
    """Backend gates that must be green before the global hotkey will fire.

    The frontend combines this with its own TCC permission checks (input
    monitoring, accessibility) into the full dictation readiness checklist.
    Hotkey-enabled is the user's intent toggle and lives outside this struct.
    """

    stt: ModelReadiness
    llm: ModelReadiness


class HealthResponse(BaseModel):
    """Response model for health check."""

    status: str
    model_loaded: bool  # Whether a Whisper model is loaded
    model_downloaded: Optional[bool] = None  # Whether the configured Whisper model is cached
    model_size: Optional[str] = None  # Loaded Whisper model size
    gpu_available: bool
    gpu_type: Optional[str] = None  # "Metal (Apple Silicon via MLX)", "MPS (Apple Silicon)", or None
    backend_type: Optional[str] = None  # Always "mlx"


class DirectoryCheck(BaseModel):
    """Health status for a single directory."""

    path: str
    exists: bool
    writable: bool
    error: Optional[str] = None


class FilesystemHealthResponse(BaseModel):
    """Response model for filesystem health check."""

    healthy: bool
    disk_free_mb: Optional[float] = None
    disk_total_mb: Optional[float] = None
    directories: List[DirectoryCheck]


class ModelStatus(BaseModel):
    """Response model for model status."""

    model_name: str
    display_name: str
    hf_repo_id: Optional[str] = None  # HuggingFace repository ID
    downloaded: bool
    downloading: bool = False  # True if download is in progress
    size_mb: Optional[float] = None
    loaded: bool = False


class ModelStatusListResponse(BaseModel):
    """Response model for model status list."""

    models: List[ModelStatus]


class ModelDownloadRequest(BaseModel):
    """Request model for triggering model download."""

    model_name: str


class ModelMigrateRequest(BaseModel):
    """Request model for migrating models to a new directory."""

    destination: str


class ActiveDownloadTask(BaseModel):
    """Response model for active download task."""

    model_name: str
    status: str
    started_at: datetime
    error: Optional[str] = None
    progress: Optional[float] = None  # 0-100 percentage
    current: Optional[int] = None  # bytes downloaded
    total: Optional[int] = None  # total bytes
    filename: Optional[str] = None  # current file being downloaded


class ActiveTasksResponse(BaseModel):
    """Response model for active tasks."""

    downloads: List[ActiveDownloadTask]


class CaptureFeedbackCreate(BaseModel):
    target: Literal["raw", "refined"]
    expected_text: str = Field(max_length=100000)
    notes: str = Field(default="", max_length=5000)
    snapshot: CaptureResponse


class WritingStyleStatus(BaseModel):
    """What Voicebox has learned about how the user punctuates."""

    ready: bool
    runs: int
    last_run_at: Optional[str] = None
    example_count: int
    habits: List[str]


class PersonalExample(BaseModel):
    """One "when I say this, I mean this" example cleanup learns from."""

    id: str
    source: Literal["correction", "calibration"]
    said: str
    meant: str
    created_at: Optional[str] = None


class CorrectionNote(BaseModel):
    """One rule summarized from the user's older examples."""

    id: str
    text: str


class CorrectionNotesStatus(BaseModel):
    """Rules cleanup follows from examples too old to show the model."""

    notes: List[CorrectionNote]
    pending: int
    last_run: Optional[str] = None
    outcome: str


class WritingStyleStepRequest(BaseModel):
    written: str = Field(..., max_length=4000)


class WritingStyleCalibrationStep(BaseModel):
    session_id: str
    step: int
    total: int
    # What was said, and Voicebox's cleanup of it for the user to rewrite.
    said: Optional[str] = None
    paragraph: Optional[str] = None
    habits: List[str]
    changes: List[float]
    done: bool


class WritingStyleCalibrationResult(BaseModel):
    status: WritingStyleStatus
    before: str
    after: str


class CaptureFeedbackResponse(BaseModel):
    id: str
    capture_id: str
    target: Literal["raw", "refined"]
    expected_text: str
    notes: str
    snapshot: CaptureResponse
    created_at: datetime
