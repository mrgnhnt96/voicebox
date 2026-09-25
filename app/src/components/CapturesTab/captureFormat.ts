import type { CaptureResponse } from '@/lib/api/types';

/** The row tag: REVIEW wins over REFINED, since it asks the user to look. */
export type CaptureTag = 'refined' | 'review' | 'raw';

export function formatDuration(ms?: number | null): string {
  if (!ms || ms < 0) return '0:00';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Backend timestamps are naive UTC, so a string without a zone is read as UTC.
function parseServerDate(date: string): Date {
  const trimmed = date.trim();
  const hasZone = trimmed.includes('Z') || /[+-]\d{2}:\d{2}$/.test(trimmed);
  return new Date(hasZone ? trimmed : `${trimmed}Z`);
}

const pad = (n: number) => String(n).padStart(2, '0');

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Local 12-hour clock time: "2:14 PM". */
function formatClock(date: Date): string {
  return date.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
}

/** Row time: "2:14 PM" today, "yest 6:21 PM" yesterday, "Sep 21" before that. */
export function formatRowTime(createdAt: string, yesterdayLabel: string, now = new Date()): string {
  const date = parseServerDate(createdAt);
  const time = formatClock(date);
  if (sameDay(date, now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `${yesterdayLabel} ${time}`;
  return date.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

/** Detail header stamp: "2026-09-23 2:14 PM". */
export function formatStamp(createdAt: string): string {
  const d = parseServerDate(createdAt);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatClock(d)}`;
}

export function captureTag(capture: CaptureResponse): CaptureTag {
  if (capture.refinement_review) return 'review';
  return capture.transcript_refined ? 'refined' : 'raw';
}

export function matchesSearch(capture: CaptureResponse, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    (capture.transcript_raw || '').toLowerCase().includes(q) ||
    (capture.transcript_refined || '').toLowerCase().includes(q) ||
    (capture.app_name || '').toLowerCase().includes(q)
  );
}

/** The text a capture delivers: the refined transcript when there is one. */
export function deliveredText(capture: CaptureResponse): string {
  return capture.transcript_refined || capture.transcript_raw || '';
}

/** Markdown export of a capture: its metadata, then both transcripts. */
export function buildCaptureMarkdown(capture: CaptureResponse): string {
  const lines: string[] = [];
  lines.push(`# Capture ${capture.id}`, '');
  lines.push(`- **Source:** ${capture.source}`);
  if (capture.app_name) lines.push(`- **App:** ${capture.app_name}`);
  lines.push(`- **Created:** ${capture.created_at}`);
  if (capture.duration_ms != null)
    lines.push(`- **Duration:** ${formatDuration(capture.duration_ms)}`);
  if (capture.language) lines.push(`- **Language:** ${capture.language}`);
  if (capture.stt_model) lines.push(`- **STT model:** ${capture.stt_model}`);
  if (capture.llm_model) lines.push(`- **LLM model:** ${capture.llm_model}`);
  lines.push('');
  if (capture.transcript_refined?.trim()) {
    lines.push('## Refined transcript', '', capture.transcript_refined.trim(), '');
  }
  if (capture.transcript_raw?.trim()) {
    lines.push('## Raw transcript', '', capture.transcript_raw.trim(), '');
  }
  return lines.join('\n');
}

/** Focus is somewhere typing goes, so single-key shortcuts must stay out of the way. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(target.type);
  }
  return false;
}

/** A dialog, menu or popover has focus, so its own keys take priority. */
export function isInOverlay(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')
  );
}
