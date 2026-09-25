import { describe, expect, it } from 'bun:test';
import { formatDuration } from '../src/lib/utils/duration';

describe('server uptime in the status bar tip', () => {
  it('reads like a running time', () => {
    expect(formatDuration(20)).toBe('less than a minute');
    expect(formatDuration(5 * 60 + 59)).toBe('5m');
    expect(formatDuration(2 * 3600 + 14 * 60)).toBe('2h 14m');
    expect(formatDuration(3 * 86400 + 5 * 3600)).toBe('3d 5h');
  });
});

describe('server stats', () => {
  it('lists what the server reports, running time first', async () => {
    const { serverStats } = await import('../src/lib/utils/serverStats');
    const stats = serverStats(
      {
        status: 'healthy',
        model_loaded: true,
        model_size: 'turbo',
        gpu_available: true,
        gpu_type: 'Metal (Apple Silicon via MLX)',
        version: '0.5.0',
        started_at: 1000,
        pid: 42,
        peak_memory_mb: 4083,
      },
      (1000 + 3 * 3600 + 5 * 60) * 1000,
    );
    expect(stats.map((s) => `${s.label}: ${s.value}`)).toEqual([
      'Running for: 3h 5m',
      'Version: 0.5.0',
      'Whisper: turbo in memory',
      'Acceleration: Metal (Apple Silicon via MLX)',
      'Peak memory: 4.0 GB',
      'Process: 42',
    ]);
  });
});
