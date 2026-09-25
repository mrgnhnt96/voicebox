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
