import { describe, expect, test } from 'bun:test';
import {
  formatRowTime,
  formatStamp,
  snippetParts,
} from '../src/components/CapturesTab/captureFormat';

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

describe('row snippets', () => {
  test('marks the words the cleanup added, ignoring case and punctuation', () => {
    expect(snippetParts('Push it to Tomorrow, please.', ['tomorrow'])).toEqual([
      { text: 'Push it to ', changed: false },
      { text: 'Tomorrow', changed: true },
      { text: ', please.', changed: false },
    ]);
  });

  test('leaves the text whole when no added word is in it', () => {
    expect(snippetParts('Commit.', [])).toEqual([{ text: 'Commit.', changed: false }]);
    expect(snippetParts('Commit.', ['thursday'])).toEqual([{ text: 'Commit.', changed: false }]);
  });

  test('starts a few words before a change that would fall past two lines', () => {
    const text =
      'Quick heads up for the team: the staging database will be down for about twenty minutes, ' +
      'so please pause long-running jobs before three o’clock.';
    const parts = snippetParts(text, ['three']);
    expect(parts[0]).toEqual({
      text: '…so please pause long-running jobs before ',
      changed: false,
    });
    expect(parts[1]).toEqual({ text: 'three', changed: true });
  });

  test('keeps the start when the change is already in view', () => {
    const parts = snippetParts('Can we push the release notes to tomorrow?', ['tomorrow']);
    expect(parts[0].text).toBe('Can we push the release notes to ');
  });
});
