import type { CaptureSettings, ModelStatus } from '@/lib/api/types';

export const MODEL_DESCRIPTIONS: Record<string, string> = {
  'whisper-base':
    'Smallest Whisper model (74M parameters). Fast transcription with moderate accuracy.',
  'whisper-small':
    'Whisper Small (244M parameters). Good balance of speed and accuracy for transcription.',
  'whisper-medium':
    'Whisper Medium (769M parameters). Higher accuracy transcription at moderate speed.',
  'whisper-large':
    'Whisper Large (1.5B parameters). Best accuracy for speech-to-text across multiple languages.',
  'whisper-turbo':
    'Whisper Large v3 Turbo. Pruned for significantly faster inference while maintaining near-large accuracy.',
  'qwen3-0.6b':
    'Qwen3 0.6B — smallest of the Qwen3 instruct family. Very fast on CPU, runs at ~400 MB quantized on Apple Silicon. Good for dictation refinement and short completions.',
  'qwen3-1.7b':
    'Qwen3 1.7B — balanced size and quality. Handles subtle self-corrections and technical vocabulary better than the 0.6B. Runs at ~1.1 GB quantized on Apple Silicon.',
  'qwen3-4b':
    'Qwen3 4B — highest quality local refinement and longer-form reasoning. Runs at ~2.5 GB quantized on Apple Silicon.',
};

/** What a model is used for in dictation. */
export type ModelRole = 'transcription' | 'refinement';

export interface ModelGroup {
  /** The model family, taken from the model name prefix ("whisper", "qwen3"). */
  family: string;
  models: ModelStatus[];
}

export function modelFamily(modelName: string): string {
  return modelName.split('-')[0];
}

/** Group models by family, keeping the server's order. */
export function groupModels(models: ModelStatus[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const model of models) {
    const family = modelFamily(model.model_name);
    const group = groups.find((g) => g.family === family);
    if (group) group.models.push(model);
    else groups.push({ family, models: [model] });
  }
  return groups;
}

/**
 * The models dictation is set to use, keyed by model name. Mirrors the
 * backend's naming: `whisper-<size>` and `qwen3-<size lowercased>`.
 */
export function modelsInUse(settings: CaptureSettings | undefined): Map<string, ModelRole> {
  const inUse = new Map<string, ModelRole>();
  if (!settings) return inUse;
  inUse.set(`whisper-${settings.stt_model}`, 'transcription');
  inUse.set(`qwen3-${settings.llm_model.toLowerCase()}`, 'refinement');
  return inUse;
}

/** A model's folder in the Hugging Face hub cache. */
export function hfCacheFolder(cacheDir: string, repoId: string): string {
  return `${cacheDir.replace(/\/+$/, '')}/models--${repoId.split('/').join('--')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

export function formatSizeMb(sizeMb: number): string {
  if (sizeMb < 1024) return `${sizeMb.toFixed(1)} MB`;
  return `${(sizeMb / 1024).toFixed(2)} GB`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

export function formatLicense(license: string): string {
  const map: Record<string, string> = {
    'apache-2.0': 'Apache 2.0',
    mit: 'MIT',
    'cc-by-4.0': 'CC BY 4.0',
    'cc-by-sa-4.0': 'CC BY-SA 4.0',
    'cc-by-nc-4.0': 'CC BY-NC 4.0',
    'openrail++': 'OpenRAIL++',
    openrail: 'OpenRAIL',
  };
  return map[license] || license;
}

export function formatPipelineTag(tag: string): string {
  return tag
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
