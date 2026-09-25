import { describe, expect, test } from 'bun:test';
import { formatRowTime, formatStamp } from '../src/components/CapturesTab/captureFormat';

// Built from local parts and sent as UTC, like the backend's naive timestamps.
function serverStamp(year: number, month: number, day: number, hour: number, minute: number) {
  return new Date(year, month - 1, day, hour, minute).toISOString().replace('Z', '');
}

describe('capture times', () => {
  const now = new Date(2026, 8, 25, 18, 0);

  test('rows show local 12-hour time', () => {
    expect(formatRowTime(serverStamp(2026, 9, 25, 14, 5), 'yest', now)).toBe('2:05 PM');
    expect(formatRowTime(serverStamp(2026, 9, 24, 0, 30), 'yest', now)).toBe('yest 12:30 AM');
    expect(formatRowTime(serverStamp(2026, 9, 20, 9, 0), 'yest', now)).toBe('Sep 20');
  });

  test('the detail header shows the date and 12-hour time', () => {
    expect(formatStamp(serverStamp(2026, 9, 25, 14, 5))).toBe('2026-09-25 2:05 PM');
  });
});
