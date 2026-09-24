// API Types matching backend Pydantic models
import type { LanguageCode } from '@/lib/constants/languages';

export type WhisperModelSize = 'base' | 'small' | 'medium' | 'large' | 'turbo';

export type Qwen3ModelSize = '0.6B' | '1.7B' | '4B';

export type CaptureSource = 'dictation' | 'recording' | 'file';

/**
 * Snapshot of the accessibility-focused UI element at chord-start. Emitted
 * from Rust as part of the ``dictate:start`` payload so the frontend can
 * pass it back to ``paste_final_text`` once the final text is ready.
 */
export interface FocusSnapshot {
  pid: number;
  bundle_id: string | null;
  role: string | null;
}

export type PunctuationStyle = 'standard' | 'casual' | 'learned';

/** Stable codes for learned punctuation habits; the app words them. */
export type WritingStyleHabit =
  | 'boundary_period'
  | 'boundary_comma'
  | 'boundary_none'
  | 'lowercase_start'
  | 'drop_intro_comma'
  | 'drop_conjunction_comma'
  | 'drop_final_period';

export interface WritingStyleStatus {
  ready: boolean;
  runs: number;
  last_run_at: string | null;
  example_count: number;
  habits: WritingStyleHabit[];
}

export interface PersonalExample {
  id: string;
  source: 'correction' | 'calibration';
  said: string;
  meant: string;
  created_at: string | null;
}

export interface WritingStyleCalibrationStep {
  session_id: string;
  step: number;
  total: number;
  /** What was said, as speech-to-text wrote it; null when done. */
  said: string | null;
  /** Voicebox's cleanup of it, using everything learned so far; null when done. */
  paragraph: string | null;
  habits: WritingStyleHabit[];
  /** Share of each submitted paragraph the user changed, 0 to 1. */
  changes: number[];
  done: boolean;
}

export interface WritingStyleCalibrationResult {
  status: WritingStyleStatus;
  before: string;
  after: string;
}

export interface RefinementFlags {
  smart_cleanup: boolean;
  self_correction: boolean;
  preserve_technical: boolean;
  punctuation_style?: PunctuationStyle;
}

/** Why a capture's cleanup is flagged for the user to check. */
export interface RefinementReview {
  /** review: cleanup kept; reject: the transcript was used instead. */
  outcome: 'review' | 'reject';
  added: string[];
  missing: string[];
  reasons: ('answered' | 'negation' | 'number' | 'technical')[];
}

export interface CaptureResponse {
  id: string;
  audio_path: string;
  source: CaptureSource;
  language?: string | null;
  duration_ms?: number | null;
  transcript_raw: string;
  transcript_refined?: string | null;
  stt_model?: string | null;
  llm_model?: string | null;
  refinement_flags?: RefinementFlags | null;
  refinement_review?: RefinementReview | null;
  created_at: string;
}

export interface CaptureListResponse {
  items: CaptureResponse[];
  total: number;
}

/**
 * Response of ``POST /captures``. Adds ``auto_refine`` and ``allow_auto_paste``
 * — the server's current settings captured at request time — so the client
 * can decide whether to chain a refine call and whether to fire the
 * synthetic-paste pipeline without relying on its own (possibly stale) copy
 * of capture_settings.
 */
export interface CaptureCreateResponse extends CaptureResponse {
  auto_refine: boolean;
  allow_auto_paste: boolean;
}

export interface CaptureRefineRequest {
  flags?: RefinementFlags;
  model_size?: Qwen3ModelSize;
}

export interface CaptureRetranscribeRequest {
  model?: WhisperModelSize;
  language?: LanguageCode;
}

export interface CaptureSettings {
  stt_model: WhisperModelSize;
  language: string;
  auto_refine: boolean;
  llm_model: Qwen3ModelSize;
  smart_cleanup: boolean;
  self_correction: boolean;
  preserve_technical: boolean;
  punctuation_style: PunctuationStyle;
  allow_auto_paste: boolean;
  /** Configured audio input deviceId (null or empty string means system default microphone). */
  input_device_id: string | null;
  /** Whether the global keyboard hotkey is armed. Off by default — turning
   *  this on triggers the macOS Input Monitoring TCC prompt. */
  hotkey_enabled: boolean;
  /** keytap key names. Defaults are platform-specific right-hand modifiers. */
  chord_push_to_talk_keys: string[];
  /** keytap key names. Toggle adds Space to the platform-specific PTT chord. */
  chord_toggle_to_talk_keys: string[];
}

export type CaptureSettingsUpdate = Partial<CaptureSettings>;

/**
 * One row in the dictation readiness checklist. ``model_name`` is the
 * canonical id understood by ``POST /models/download`` so the UI can wire a
 * one-click "Download" button without a second lookup.
 */
export interface ModelReadiness {
  ready: boolean;
  model_name: string;
  display_name: string;
  size: string;
  size_mb?: number | null;
}

/** Backend half of the dictation readiness check. The frontend combines this
 *  with TCC permission state into the full checklist used by useDictationReadiness. */
export interface CaptureReadinessResponse {
  stt: ModelReadiness;
  llm: ModelReadiness;
}

export interface TranscriptionResponse {
  text: string;
  duration: number;
}

export interface HealthResponse {
  status: string;
  model_loaded: boolean;
  model_downloaded?: boolean;
  model_size?: string;
  gpu_available: boolean;
  gpu_type?: string;
  backend_type?: string;
}

export interface ModelProgress {
  model_name: string;
  current: number;
  total: number;
  progress: number;
  filename?: string;
  status: 'downloading' | 'extracting' | 'complete' | 'error';
  timestamp: string;
  error?: string;
}

export interface ModelStatus {
  model_name: string;
  display_name: string;
  hf_repo_id?: string; // HuggingFace repository ID
  downloaded: boolean;
  downloading: boolean; // True if download is in progress
  size_mb?: number;
  loaded: boolean;
}

export interface HuggingFaceModelInfo {
  id: string;
  author: string;
  lastModified: string;
  pipeline_tag?: string;
  library_name?: string;
  downloads: number;
  likes: number;
  tags: string[];
  cardData?: {
    license?: string;
    language?: string[];
    pipeline_tag?: string;
  };
}

export interface ModelStatusListResponse {
  models: ModelStatus[];
}

export interface ModelDownloadRequest {
  model_name: string;
}

export interface ActiveDownloadTask {
  model_name: string;
  status: string;
  started_at: string;
  error?: string;
  progress?: number; // 0-100 percentage
  current?: number; // bytes downloaded
  total?: number; // total bytes
  filename?: string; // current file being downloaded
}

export interface ActiveTasksResponse {
  downloads: ActiveDownloadTask[];
}

export interface CaptureFeedbackCreate {
  target: 'raw' | 'refined';
  expected_text: string;
  notes: string;
  snapshot: CaptureResponse;
}

export interface CaptureFeedbackResponse extends CaptureFeedbackCreate {
  id: string;
  capture_id: string;
  created_at: string;
}

export interface CorrectionLearningStatus {
  model?: {
    phase: string;
    revision: number;
    running: boolean;
    active_adapter: string | null;
    speech_model: string | null;
    can_rollback: boolean;
    counts: {
      train?: number;
      validation?: number;
      test?: number;
      audio_test?: number;
      speech_test?: number;
    };
    last_run: string | null;
    error: string | null;
    metrics: {
      adapter?: {
        passed: boolean;
        reasons: string[];
        baseline_errors: number;
        candidate_errors: number;
      };
    } | null;
  };
  evaluated_report_ids: string[];
  revision: number;
  active_rules: number;
  last_run: string | null;
  outcome: 'waiting' | 'updated' | 'no_change' | 'rolled_back';
  can_rollback: boolean;
  metrics: {
    training_examples: number;
    heldout_examples: number;
    candidates: number;
    accepted: number;
    median_rule_ms: number;
    latency_passed: boolean;
  } | null;
}
