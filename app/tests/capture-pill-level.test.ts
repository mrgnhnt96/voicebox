import { expect, test } from 'bun:test';
import {
  BAR_MAX_PX,
  BAR_MIN_PX,
  barHeights,
  isClipping,
  levelFromDb,
} from '../src/components/CapturePill/level';

test('room noise and missing readings leave the bars flat', () => {
  for (const db of [null, undefined, Number.NaN, -100, -55]) {
    expect(levelFromDb(db)).toBe(0);
  }
  expect(barHeights(levelFromDb(-70))).toEqual([3, 3, 3, 3, 3]);
});

test('level rises linearly from the noise floor to full at -12 dBFS', () => {
  expect(levelFromDb(-33.5)).toBeCloseTo(0.5, 5);
  expect(levelFromDb(-12)).toBe(1);
  expect(levelFromDb(0)).toBe(1);
});

test('bars are tallest in the middle and bounded', () => {
  const heights = barHeights(1);
  expect(heights[2]).toBe(BAR_MAX_PX);
  expect(heights[0]).toBe(heights[4]);
  expect(heights[1]).toBe(heights[3]);
  expect(heights[0]).toBeLessThan(heights[1]);
  for (const h of barHeights(0.4)) {
    expect(h).toBeGreaterThanOrEqual(BAR_MIN_PX);
    expect(h).toBeLessThanOrEqual(BAR_MAX_PX);
  }
});

test('only input above -3 dBFS counts as clipping', () => {
  expect(isClipping(-3)).toBe(false);
  expect(isClipping(-2.5)).toBe(true);
  expect(isClipping(null)).toBe(false);
});
