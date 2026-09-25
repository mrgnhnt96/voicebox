/**
 * Maps microphone loudness (dBFS, measured natively in
 * `tauri/src-tauri/src/dictation/audio.rs`) onto the HUD's level bars.
 *
 * The bars are a scrolling waveform: each bar is one recent reading, the
 * newest enters on the left and older ones move right, so speech reads as a
 * wave travelling across the pill.
 */

/** At or below this the input is room noise and the bars lie flat. */
export const LEVEL_FLOOR_DB = -45;
/** At or above this the bars are full height. Normal speech peaks near here. */
export const LEVEL_FULL_DB = -15;
/** Above this the input is about to clip and the bars turn orange. */
export const LEVEL_CLIP_DB = -3;

export const BAR_MIN_PX = 3;
export const BAR_MAX_PX = 20;
/** Bars shrink toward the pill's ends so the wave fades in and out. */
export const BAR_WEIGHTS = [0.6, 0.85, 1, 1, 1, 0.85, 0.6] as const;
export const BAR_COUNT = BAR_WEIGHTS.length;

/**
 * The most a reading may drop below the one before it. Rises are immediate
 * and falls glide, so the wave doesn't flicker between syllables.
 */
export const LEVEL_MAX_FALL = 0.25;
/** One step of the wave: matches how often Rust sends a reading. */
export const LEVEL_STEP_MS = 50;

/** 0 (silent) to 1 (full). No reading yet counts as silent. */
export function levelFromDb(db: number | null | undefined): number {
  if (db == null || Number.isNaN(db)) return 0;
  const level = (db - LEVEL_FLOOR_DB) / (LEVEL_FULL_DB - LEVEL_FLOOR_DB);
  return Math.min(1, Math.max(0, level));
}

/** An empty wave: every bar flat. */
export function silentWave(): number[] {
  return new Array(BAR_COUNT).fill(0);
}

/** Add the newest level on the left, moving the rest one bar to the right. */
export function pushLevel(wave: readonly number[], level: number): number[] {
  const newest = Math.max(level, (wave[0] ?? 0) - LEVEL_MAX_FALL);
  return [newest, ...wave].slice(0, BAR_COUNT);
}

export function barHeights(wave: readonly number[]): number[] {
  return BAR_WEIGHTS.map(
    (weight, i) => BAR_MIN_PX + (BAR_MAX_PX - BAR_MIN_PX) * (wave[i] ?? 0) * weight,
  );
}

export function isClipping(db: number | null | undefined): boolean {
  return db != null && db > LEVEL_CLIP_DB;
}
