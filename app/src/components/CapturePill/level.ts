/**
 * Maps microphone loudness (dBFS, measured natively in
 * `tauri/src-tauri/src/dictation/audio.rs`) onto the HUD's level bars.
 */

/** At or below this the input is room noise and the bars lie flat. */
export const LEVEL_FLOOR_DB = -55;
/** At or above this the bars are full height. */
export const LEVEL_FULL_DB = -12;
/** Above this the input is about to clip and the bars turn orange. */
export const LEVEL_CLIP_DB = -3;

export const BAR_MIN_PX = 3;
export const BAR_MAX_PX = 16;
/** Bars are shaped around the center. */
export const BAR_WEIGHTS = [0.55, 0.8, 1, 0.8, 0.55] as const;

/** Bars rise fast and fall slower so they don't flicker between syllables. */
export const LEVEL_RISE_MS = 30;
export const LEVEL_FALL_MS = 150;

/** 0 (silent) to 1 (full). No reading yet counts as silent. */
export function levelFromDb(db: number | null | undefined): number {
  if (db == null || Number.isNaN(db)) return 0;
  const level = (db - LEVEL_FLOOR_DB) / (LEVEL_FULL_DB - LEVEL_FLOOR_DB);
  return Math.min(1, Math.max(0, level));
}

export function barHeights(level: number): number[] {
  return BAR_WEIGHTS.map((weight) => BAR_MIN_PX + (BAR_MAX_PX - BAR_MIN_PX) * level * weight);
}

export function isClipping(db: number | null | undefined): boolean {
  return db != null && db > LEVEL_CLIP_DB;
}
