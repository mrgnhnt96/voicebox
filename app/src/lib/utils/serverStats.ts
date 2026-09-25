import type { HealthResponse } from '@/lib/api/types';
import { formatDuration } from './duration';

export interface ServerStat {
  key: string;
  label: string;
  value: string;
}

/**
 * What the server reports about itself, in the order the status bar tip and
 * Settings show it. ``now`` is in milliseconds, for the running time.
 */
export function serverStats(health: HealthResponse, now: number = Date.now()): ServerStat[] {
  const stats: Array<ServerStat | false | undefined> = [
    health.started_at !== undefined && {
      key: 'uptime',
      label: 'Running for',
      value: formatDuration(now / 1000 - health.started_at),
    },
    health.version !== undefined && { key: 'version', label: 'Version', value: health.version },
    {
      key: 'whisper',
      label: 'Whisper',
      value: health.model_loaded ? `${health.model_size ?? ''} in memory`.trim() : 'not loaded',
    },
    health.gpu_type !== undefined && {
      key: 'acceleration',
      label: 'Acceleration',
      value: health.gpu_type,
    },
    health.peak_memory_mb !== undefined && {
      key: 'memory',
      label: 'Peak memory',
      value: formatMemory(health.peak_memory_mb),
    },
    health.pid !== undefined && { key: 'pid', label: 'Process', value: String(health.pid) },
  ];
  return stats.filter((stat): stat is ServerStat => Boolean(stat));
}

export function formatMemory(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}
