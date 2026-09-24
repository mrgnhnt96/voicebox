import { expect, test } from 'bun:test';
import { countWords, diffWords } from '../src/components/CapturesTab/wordDiff';

const marked = (segments: { text: string; changed: boolean }[]) =>
  segments.filter((s) => s.changed).map((s) => s.text);
const joined = (segments: { text: string }[]) => segments.map((s) => s.text).join('');

test('identical texts have no changes', () => {
  const diff = diffWords('send the notes', 'send the notes');
  expect(diff.hunks).toEqual([]);
  expect(diff.before).toEqual([{ text: 'send the notes', changed: false }]);
  expect(diff.after).toEqual([{ text: 'send the notes', changed: false }]);
});

test('case and punctuation alone are not changes', () => {
  const diff = diffWords('thursday works for me', 'Thursday works for me.');
  expect(diff.hunks).toEqual([]);
  expect(joined(diff.after)).toBe('Thursday works for me.');
});

test('removed filler is marked on the raw side only', () => {
  const diff = diffWords('um yeah thursday works for me', 'Thursday works for me.');
  expect(marked(diff.before)).toEqual(['um yeah']);
  expect(marked(diff.after)).toEqual([]);
  expect(diff.hunks).toEqual([{ removed: 'um yeah', added: '' }]);
});

test('a replaced phrase is one hunk with both sides', () => {
  const diff = diffWords(
    "let's move the cache into post grass so it survives",
    "Let's move the cache into Postgres so it survives.",
  );
  expect(diff.hunks).toEqual([{ removed: 'post grass', added: 'Postgres' }]);
  expect(marked(diff.before)).toEqual(['post grass']);
  expect(marked(diff.after)).toEqual(['Postgres']);
});

test('separate edits make separate hunks', () => {
  const diff = diffWords('do like two instead of one so I can', 'do 2 PM instead of 1 so I can');
  expect(diff.hunks).toEqual([
    { removed: 'like two', added: '2 PM' },
    { removed: 'one', added: '1' },
  ]);
});

test('marks leave the space between words outside the change', () => {
  const diff = diffWords('a b c', 'a c');
  expect(diff.before).toEqual([
    { text: 'a ', changed: false },
    { text: 'b', changed: true },
    { text: ' c', changed: false },
  ]);
});

test('segments rebuild the original texts exactly', () => {
  const before = '  so the release  we need to\npush the release to friday';
  const after = 'We need to push the release to Friday.';
  const diff = diffWords(before, after);
  expect(joined(diff.before)).toBe(before);
  expect(joined(diff.after)).toBe(after);
});

test('empty sides', () => {
  expect(diffWords('', 'hello there').hunks).toEqual([{ removed: '', added: 'hello there' }]);
  expect(diffWords('hello', '').hunks).toEqual([{ removed: 'hello', added: '' }]);
  expect(diffWords('', '')).toEqual({ before: [], after: [], hunks: [] });
});

test('a very long transcript is shown unmarked instead of diffed', () => {
  const before = Array.from({ length: 2500 }, (_, i) => `a${i}`).join(' ');
  const after = Array.from({ length: 2500 }, (_, i) => `b${i}`).join(' ');
  const diff = diffWords(before, after);
  expect(diff.hunks).toEqual([]);
  expect(diff.before).toEqual([{ text: before, changed: false }]);
  expect(diff.after).toEqual([{ text: after, changed: false }]);
});

test('countWords', () => {
  expect(countWords('  one two\nthree ')).toBe(3);
  expect(countWords('')).toBe(0);
  expect(countWords(null)).toBe(0);
});
