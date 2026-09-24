import type { LanguageCode } from '@/lib/constants/languages';
import { SERVER_URL } from '@/stores/serverStore';
import type {
  ActiveTasksResponse,
  CaptureCreateResponse,
  CaptureFeedbackCreate,
  CaptureFeedbackResponse,
  CaptureListResponse,
  CaptureReadinessResponse,
  CaptureRefineRequest,
  CaptureResponse,
  CaptureSettings,
  CaptureSettingsUpdate,
  CaptureSource,
  CorrectionLearningStatus,
  CorrectionNotesStatus,
  HealthResponse,
  ModelDownloadRequest,
  ModelStatusListResponse,
  PersonalExample,
  WhisperModelSize,
  WritingStyleCalibrationResult,
  WritingStyleCalibrationStep,
  WritingStyleStatus,
} from './types';

function formatErrorDetail(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((e: Record<string, unknown>) => e.msg || e.message || JSON.stringify(e))
      .join('; ');
  }
  if (detail && typeof detail === 'object') {
    const obj = detail as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    return JSON.stringify(detail);
  }
  return fallback;
}

class ApiClient {
  private getBaseUrl(): string {
    return SERVER_URL;
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${this.getBaseUrl()}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: response.statusText,
      }));
      throw new Error(formatErrorDetail(error.detail, `HTTP error! status: ${response.status}`));
    }

    return response.json();
  }

  // Health
  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health');
  }

  async reportCaptureOutput(
    captureId: string,
    body: CaptureFeedbackCreate,
  ): Promise<CaptureFeedbackResponse> {
    return this.request(`/captures/${captureId}/feedback`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async listCaptureFeedback(captureId: string): Promise<CaptureFeedbackResponse[]> {
    return this.request(`/captures/${captureId}/feedback`);
  }

  async exportCaptureFeedback(): Promise<CaptureFeedbackResponse[]> {
    return this.request('/capture/feedback/export');
  }

  async correctionLearningStatus(): Promise<CorrectionLearningStatus> {
    return this.request('/capture/learning');
  }

  async runCorrectionLearning(): Promise<CorrectionLearningStatus> {
    return this.request('/capture/learning/run', { method: 'POST' });
  }

  async pauseLearningForRecording(): Promise<void> {
    await this.request('/capture/learning/activity', { method: 'POST' });
  }

  async cancelModelLearning(): Promise<void> {
    await this.request('/capture/learning/cancel', { method: 'POST' });
  }

  async rollbackCorrectionLearning(): Promise<CorrectionLearningStatus> {
    return this.request('/capture/learning/rollback', { method: 'POST' });
  }

  // Captures
  async listCaptures(limit = 50, offset = 0): Promise<CaptureListResponse> {
    return this.request<CaptureListResponse>(`/captures?limit=${limit}&offset=${offset}`);
  }

  async createCapture(
    file: File,
    options?: {
      source?: CaptureSource;
      language?: LanguageCode;
      sttModel?: WhisperModelSize;
    },
  ): Promise<CaptureCreateResponse> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('source', options?.source ?? 'file');
    if (options?.language) formData.append('language', options.language);
    if (options?.sttModel) formData.append('stt_model', options.sttModel);

    const url = `${this.getBaseUrl()}/captures`;
    const response = await fetch(url, { method: 'POST', body: formData });
    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: response.statusText,
      }));
      throw new Error(formatErrorDetail(error.detail, `HTTP error! status: ${response.status}`));
    }
    return response.json();
  }

  async deleteCapture(captureId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/captures/${captureId}`, {
      method: 'DELETE',
    });
  }

  async refineCapture(captureId: string, body: CaptureRefineRequest): Promise<CaptureResponse> {
    return this.request<CaptureResponse>(`/captures/${captureId}/refine`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  getCaptureAudioUrl(captureId: string): string {
    return `${this.getBaseUrl()}/captures/${captureId}/audio`;
  }

  // Writing style
  async getWritingStyle(): Promise<WritingStyleStatus> {
    return this.request<WritingStyleStatus>('/writing-style');
  }

  async resetWritingStyle(): Promise<WritingStyleStatus> {
    return this.request<WritingStyleStatus>('/writing-style', { method: 'DELETE' });
  }

  async listPersonalExamples(): Promise<PersonalExample[]> {
    return this.request<PersonalExample[]>('/writing-style/examples');
  }

  async getCorrectionNotes(): Promise<CorrectionNotesStatus> {
    return this.request<CorrectionNotesStatus>('/writing-style/notes');
  }

  async removeCorrectionNote(noteId: string): Promise<void> {
    const response = await fetch(
      `${this.getBaseUrl()}/writing-style/notes/${encodeURIComponent(noteId)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  }

  async removePersonalExample(exampleId: string): Promise<void> {
    const response = await fetch(
      `${this.getBaseUrl()}/writing-style/examples/${encodeURIComponent(exampleId)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  }

  async startStyleCalibration(): Promise<WritingStyleCalibrationStep> {
    return this.request<WritingStyleCalibrationStep>('/writing-style/calibration', {
      method: 'POST',
    });
  }

  async submitStyleCalibrationStep(
    sessionId: string,
    written: string,
  ): Promise<WritingStyleCalibrationStep> {
    return this.request<WritingStyleCalibrationStep>(
      `/writing-style/calibration/${sessionId}/steps`,
      {
        method: 'POST',
        body: JSON.stringify({ written }),
      },
    );
  }

  async finishStyleCalibration(sessionId: string): Promise<WritingStyleCalibrationResult> {
    return this.request<WritingStyleCalibrationResult>(
      `/writing-style/calibration/${sessionId}/finish`,
      { method: 'POST' },
    );
  }

  async discardStyleCalibration(sessionId: string): Promise<void> {
    const response = await fetch(`${this.getBaseUrl()}/writing-style/calibration/${sessionId}`, {
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  }

  // Settings
  async getCaptureSettings(): Promise<CaptureSettings> {
    return this.request<CaptureSettings>('/settings/captures');
  }

  async getCaptureReadiness(): Promise<CaptureReadinessResponse> {
    return this.request<CaptureReadinessResponse>('/capture/readiness');
  }

  async updateCaptureSettings(patch: CaptureSettingsUpdate): Promise<CaptureSettings> {
    return this.request<CaptureSettings>('/settings/captures', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  }

  // Model Management
  async getModelStatus(): Promise<ModelStatusListResponse> {
    return this.request<ModelStatusListResponse>('/models/status');
  }

  async getModelsCacheDir(): Promise<{ path: string }> {
    return this.request<{ path: string }>('/models/cache-dir');
  }

  async migrateModels(
    destination: string,
  ): Promise<{ source: string; destination: string; moved: number; errors: string[] }> {
    return this.request('/models/migrate', {
      method: 'POST',
      body: JSON.stringify({ destination }),
    });
  }

  getMigrationProgressUrl(): string {
    return `${this.getBaseUrl()}/models/migrate/progress`;
  }

  async triggerModelDownload(modelName: string): Promise<{ message: string }> {
    console.log(
      '[API] triggerModelDownload called for:',
      modelName,
      'at',
      new Date().toISOString(),
    );
    const result = await this.request<{ message: string }>('/models/download', {
      method: 'POST',
      body: JSON.stringify({ model_name: modelName } as ModelDownloadRequest),
    });
    console.log('[API] triggerModelDownload response:', result);
    return result;
  }

  async deleteModel(modelName: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/models/${modelName}`, {
      method: 'DELETE',
    });
  }

  async unloadModel(modelName: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/models/${modelName}/unload`, {
      method: 'POST',
    });
  }

  async cancelDownload(modelName: string): Promise<{ message: string }> {
    return this.request<{ message: string }>('/models/download/cancel', {
      method: 'POST',
      body: JSON.stringify({ model_name: modelName } as ModelDownloadRequest),
    });
  }

  // Task Management
  async getActiveTasks(): Promise<ActiveTasksResponse> {
    return this.request<ActiveTasksResponse>('/tasks/active');
  }

  async clearAllTasks(): Promise<{ message: string }> {
    return this.request<{ message: string }>('/tasks/clear', { method: 'POST' });
  }
}

export const apiClient = new ApiClient();
