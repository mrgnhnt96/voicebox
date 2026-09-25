/**
 * Word-level diff between two transcripts, for showing what refinement (or a
 * correction) changed. Words compare by their letters and digits only, so
 * "thursday" and "Thursday." count as the same word and only real wording
 * changes are marked.
 */

/** A run of text on one side of the diff; `changed` marks words the other side lacks. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

/** One place where the texts differ: the words taken out and the words put in. */
export interface DiffHunk {
  removed: string;
  added: string;
  /** How many times the same change was made, when more than once. */
  count?: number;
}

export interface WordDiff {
  /** The first text, with the words missing from the second marked. */
  before: DiffSegment[];
  /** The second text, with the words missing from the first marked. */
  after: DiffSegment[];
  hunks: DiffHunk[];
}

// Past this many LCS cells (about 2,000 × 2,000 words) the diff is skipped and
// both texts are shown unmarked, so a long file import can't stall the UI.
const MAX_CELLS = 4_000_000;

interface Token {
  /** The word plus the whitespace after it, so joining tokens rebuilds the text. */
  text: string;
  word: string;
  key: string;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const leading = text.match(/^\s*/)?.[0] ?? '';
  for (const match of text.slice(leading.length).matchAll(/(\S+)(\s*)/g)) {
    const word = match[1];
    const key = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') || word;
    tokens.push({ text: match[0], word, key });
  }
  if (leading && tokens.length) tokens[0] = { ...tokens[0], text: leading + tokens[0].text };
  return tokens;
}

type Op =
  | { kind: 'same'; a: Token; b: Token }
  | { kind: 'removed'; a: Token }
  | { kind: 'added'; b: Token };

function diffTokens(a: Token[], b: Token[]): Op[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start].key === b[start].key) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1].key === b[endB - 1].key) {
    endA--;
    endB--;
  }

  const head: Op[] = a.slice(0, start).map((t, i) => ({ kind: 'same', a: t, b: b[i] }));
  const tail: Op[] = a.slice(endA).map((t, i) => ({ kind: 'same', a: t, b: b[endB + i] }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  // Too long to diff: the caller shows both texts unmarked rather than guess.
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;

  // lcs[i][j] = longest common subsequence of midA[i..] and midB[j..].
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        midA[i].key === midB[j].key
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const mid: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i].key === midB[j].key) {
      mid.push({ kind: 'same', a: midA[i++], b: midB[j++] });
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      mid.push({ kind: 'removed', a: midA[i++] });
    } else {
      mid.push({ kind: 'added', b: midB[j++] });
    }
  }
  while (i < n) mid.push({ kind: 'removed', a: midA[i++] });
  while (j < m) mid.push({ kind: 'added', b: midB[j++] });
  return [...head, ...mid, ...tail];
}

function pushSegment(segments: DiffSegment[], text: string, changed: boolean) {
  const last = segments[segments.length - 1];
  if (last && last.changed === changed) last.text += text;
  else segments.push({ text, changed });
}

/**
 * Keeps the space between a changed run and the next word outside the mark,
 * so a strike-through or highlight covers the words and not the gap.
 */
function splitTrailingSpace(segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const segment of segments) {
    if (!segment.changed) {
      pushSegment(out, segment.text, false);
      continue;
    }
    const trailing = segment.text.match(/\s*$/)?.[0] ?? '';
    const body = segment.text.slice(0, segment.text.length - trailing.length);
    if (body) out.push({ text: body, changed: true });
    if (trailing) pushSegment(out, trailing, false);
  }
  return out;
}

/**
 * "Sagar." → "Saggar." is a change to the word, not to the period: drop
 * punctuation both sides start or end with, unless nothing else is left.
 */
function trimSharedPunctuation(removed: string, added: string): DiffHunk {
  let start = 0;
  while (
    start < removed.length &&
    start < added.length &&
    removed[start] === added[start] &&
    /[^\p{L}\p{N}\s]/u.test(removed[start])
  )
    start++;
  let end = 0;
  while (
    end < removed.length - start &&
    end < added.length - start &&
    removed[removed.length - 1 - end] === added[added.length - 1 - end] &&
    /[^\p{L}\p{N}\s]/u.test(removed[removed.length - 1 - end])
  )
    end++;
  const trimmed = {
    removed: removed.slice(start, removed.length - end),
    added: added.slice(start, added.length - end),
  };
  return trimmed.removed || trimmed.added ? trimmed : { removed, added };
}

export function diffWords(before: string, after: string): WordDiff {
  const ops = diffTokens(tokenize(before), tokenize(after));
  if (!ops) {
    return {
      before: before ? [{ text: before, changed: false }] : [],
      after: after ? [{ text: after, changed: false }] : [],
      hunks: [],
    };
  }
  const beforeSegments: DiffSegment[] = [];
  const afterSegments: DiffSegment[] = [];
  const hunks: DiffHunk[] = [];
  let removed: string[] = [];
  let added: string[] = [];

  const closeHunk = () => {
    if (removed.length || added.length) {
      const hunk = trimSharedPunctuation(removed.join(' '), added.join(' '));
      // The same change made again is counted, not listed again.
      const same = hunks.find((h) => h.removed === hunk.removed && h.added === hunk.added);
      if (same) same.count = (same.count ?? 1) + 1;
      else hunks.push(hunk);
    }
    removed = [];
    added = [];
  };

  for (const op of ops) {
    if (op.kind === 'same') {
      closeHunk();
      pushSegment(beforeSegments, op.a.text, false);
      pushSegment(afterSegments, op.b.text, false);
    } else if (op.kind === 'removed') {
      removed.push(op.a.word);
      pushSegment(beforeSegments, op.a.text, true);
    } else {
      added.push(op.b.word);
      pushSegment(afterSegments, op.b.text, true);
    }
  }
  closeHunk();

  return {
    before: splitTrailingSpace(beforeSegments),
    after: splitTrailingSpace(afterSegments),
    hunks,
  };
}

/** Number of words in a transcript. */
export function countWords(text: string | null | undefined): number {
  return text?.match(/\S+/g)?.length ?? 0;
}
