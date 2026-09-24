import type { Platform } from '@/platform/types';
import { tauriFilesystem } from './filesystem';
import { tauriLifecycle } from './lifecycle';
import { tauriMetadata } from './metadata';

export const tauriPlatform: Platform = {
  filesystem: tauriFilesystem,
  lifecycle: tauriLifecycle,
  metadata: tauriMetadata,
};
