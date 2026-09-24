import type { CaptureResponse } from '@/lib/api/types';

export interface CaptureMatch {
  capture: CaptureResponse;
  /** The text shown for the capture, trimmed to a window around the match. */
  snippet: string;
}

/** Characters of context kept before the first match in a long transcript. */
const LEAD_CONTEXT = 48;

/** The text a capture is known by: the refined version when there is one. */
export function captureText(capture: CaptureResponse): string {
  return capture.transcript_refined || capture.transcript_raw || '';
}

/**
 * Captures whose refined or raw transcript contains ``query``, newest first
 * as the list already is. An empty query returns the most recent ones. The
 * snippet starts a little before the match so it stays visible in a
 * two-line row.
 */
export function searchCaptures(
  captures: CaptureResponse[],
  query: string,
  limit: number,
): CaptureMatch[] {
  const q = query.toLowerCase();
  const matches: CaptureMatch[] = [];
  for (const capture of captures) {
    if (matches.length >= limit) break;
    if (!q) {
      matches.push({ capture, snippet: captureText(capture) });
      continue;
    }
    // Prefer the text the user sees; fall back to the raw transcript so a
    // word the refiner rewrote is still findable.
    const shown = captureText(capture);
    const text = shown.toLowerCase().includes(q) ? shown : capture.transcript_raw || '';
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) continue;
    const start = at > LEAD_CONTEXT ? text.lastIndexOf(' ', at - LEAD_CONTEXT) + 1 : 0;
    matches.push({ capture, snippet: start > 0 ? `…${text.slice(start)}` : text });
  }
  return matches;
}

/** Splits ``text`` into plain and matched parts, case-insensitively. */
export function splitMatches(text: string, query: string): Array<{ text: string; hit: boolean }> {
  if (!query) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: Array<{ text: string; hit: boolean }> = [];
  let from = 0;
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), hit: false });
    parts.push({ text: text.slice(at, at + q.length), hit: true });
    from = at + q.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false });
  return parts;
}

/** ``m:ss`` for a capture's length, or null when it wasn't recorded. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
