import { expect, test } from 'bun:test';
import {
  BAR_COUNT,
  BAR_MAX_PX,
  BAR_MIN_PX,
  barHeights,
  isClipping,
  LEVEL_MAX_FALL,
  levelFromDb,
  pushLevel,
  silentWave,
} from '../src/components/CapturePill/level';

test('room noise and missing readings leave the bars flat', () => {
  for (const db of [null, undefined, Number.NaN, -100, -45]) {
    expect(levelFromDb(db)).toBe(0);
  }
  const wave = pushLevel(silentWave(), levelFromDb(-70));
  expect(barHeights(wave)).toEqual(new Array(BAR_COUNT).fill(BAR_MIN_PX));
});

test('level rises linearly from the noise floor to full at -15 dBFS', () => {
  expect(levelFromDb(-30)).toBeCloseTo(0.5, 5);
  expect(levelFromDb(-15)).toBe(1);
  expect(levelFromDb(0)).toBe(1);
});

test('new readings enter on the left and move right', () => {
  let wave = silentWave();
  wave = pushLevel(wave, 1);
  expect(wave[0]).toBe(1);
  expect(wave.slice(1).every((level) => level === 0)).toBe(true);
  wave = pushLevel(wave, 1);
  expect(wave.slice(0, 2)).toEqual([1, 1]);
  for (let i = 0; i < BAR_COUNT * 2; i++) wave = pushLevel(wave, 0.5);
  expect(wave).toHaveLength(BAR_COUNT);
  expect(wave.every((level) => level === 0.5)).toBe(true);
});

test('levels rise at once and fall gradually', () => {
  const wave = pushLevel(pushLevel(silentWave(), 1), 0);
  expect(wave[0]).toBeCloseTo(1 - LEVEL_MAX_FALL, 5);
  expect(pushLevel(wave, 1)[0]).toBe(1);
});

test('bars are bounded and taper toward the ends', () => {
  const heights = barHeights(new Array(BAR_COUNT).fill(1));
  expect(Math.max(...heights)).toBe(BAR_MAX_PX);
  expect(heights[0]).toBe(heights[BAR_COUNT - 1]);
  expect(heights[0]).toBeLessThan(heights[1]);
  for (const h of barHeights(new Array(BAR_COUNT).fill(0.4))) {
    expect(h).toBeGreaterThanOrEqual(BAR_MIN_PX);
    expect(h).toBeLessThanOrEqual(BAR_MAX_PX);
  }
});

test('only input above -3 dBFS counts as clipping', () => {
  expect(isClipping(-3)).toBe(false);
  expect(isClipping(-2.5)).toBe(true);
  expect(isClipping(null)).toBe(false);
});
