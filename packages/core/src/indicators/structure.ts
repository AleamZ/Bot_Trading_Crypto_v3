import type { Candle } from "../types.js";

export interface SwingFlags {
  /** isHigh[k]: the high at k is strictly above the `strength` highs on each side. */
  isHigh: boolean[];
  /** isLow[k]: the low at k is strictly below the `strength` lows on each side. */
  isLow: boolean[];
}

/**
 * Fractal swings. A swing at k is only known once candle k + strength has closed, so callers
 * must not use it before that index.
 */
export function swings(candles: readonly Candle[], strength: number): SwingFlags {
  const n = candles.length;
  const isHigh = new Array<boolean>(n).fill(false);
  const isLow = new Array<boolean>(n).fill(false);
  for (let k = strength; k < n - strength; k++) {
    const c = candles[k]!;
    let high = true;
    let low = true;
    for (let m = 1; m <= strength && (high || low); m++) {
      const left = candles[k - m]!;
      const right = candles[k + m]!;
      if (!(c.high > left.high && c.high > right.high)) high = false;
      if (!(c.low < left.low && c.low < right.low)) low = false;
    }
    isHigh[k] = high;
    isLow[k] = low;
  }
  return { isHigh, isLow };
}

export interface Gap {
  /** Index of the third candle, the one that confirms the gap. */
  index: number;
  top: number;
  bottom: number;
}

/** Bullish fair value gap confirmed by candle f: low[f] > high[f - 2]. */
export function bullishFvgAt(candles: readonly Candle[], f: number): Gap | null {
  if (f < 2 || f >= candles.length) return null;
  const first = candles[f - 2]!;
  const third = candles[f]!;
  return third.low > first.high ? { index: f, top: third.low, bottom: first.high } : null;
}

/** Bearish fair value gap confirmed by candle f: high[f] < low[f - 2]. */
export function bearishFvgAt(candles: readonly Candle[], f: number): Gap | null {
  if (f < 2 || f >= candles.length) return null;
  const first = candles[f - 2]!;
  const third = candles[f]!;
  return third.high < first.low ? { index: f, top: first.low, bottom: third.high } : null;
}

/**
 * For each candle of `entry`, the index of the last `higher` candle that had closed by then
 * (higher.closeTime <= entry.closeTime), or -1. Keeps the higher timeframe free of look-ahead.
 */
export function alignHigherTimeframe(entry: readonly Candle[], higher: readonly Candle[]): number[] {
  const out = new Array<number>(entry.length).fill(-1);
  let j = -1;
  for (let i = 0; i < entry.length; i++) {
    const t = entry[i]!.closeTime;
    while (j + 1 < higher.length && higher[j + 1]!.closeTime <= t) j++;
    out[i] = j;
  }
  return out;
}
