import type { Candle, Direction, MethodId, MethodSignal } from "../src/types.js";

export const T0 = Date.UTC(2026, 0, 1);
export const MINUTE = 60_000;

export type Row = [open: number, high: number, low: number, close: number, volume?: number];

/** Candles from [open, high, low, close, volume?] rows, `intervalMinutes` apart starting at `start`. */
export function candles(rows: readonly Row[], intervalMinutes = 15, start = T0): Candle[] {
  const interval = intervalMinutes * MINUTE;
  return rows.map(([open, high, low, close, volume = 100], i) => ({
    openTime: start + i * interval,
    closeTime: start + (i + 1) * interval - 1,
    open,
    high,
    low,
    close,
    volume,
  }));
}

/** Steady trend: close moves by `step` each candle, body of `body`, wicks of `wick`. */
export function trendRows(count: number, firstClose: number, step: number, body = 0.4, wick = 0.15, volume = 100): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const close = firstClose + step * i;
    const open = step >= 0 ? close - body : close + body;
    rows.push([open, Math.max(open, close) + wick, Math.min(open, close) - wick, close, volume]);
  }
  return rows;
}

/** Mirror image around `pivot` (price p becomes pivot - p): turns a LONG fixture into a SHORT one. */
export function mirror(list: readonly Candle[], pivot: number): Candle[] {
  return list.map((c) => ({
    ...c,
    open: pivot - c.open,
    close: pivot - c.close,
    high: pivot - c.low,
    low: pivot - c.high,
  }));
}

/** Deterministic pseudo-random numbers in [0, 1). */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Random walk candles with occasional volume spikes and trends, for property tests. */
export function randomWalk(count: number, seed: number, intervalMinutes = 15, start = T0, firstPrice = 100): Candle[] {
  const random = rng(seed);
  const rows: Row[] = [];
  let price = firstPrice;
  let drift = 0;
  for (let i = 0; i < count; i++) {
    if (i % 60 === 0) drift = (random() - 0.5) * 0.004;
    const open = price;
    const close = Math.max(0.01, open * (1 + drift + (random() - 0.5) * 0.012));
    const high = Math.max(open, close) * (1 + random() * 0.004);
    const low = Math.min(open, close) * (1 - random() * 0.004);
    rows.push([open, high, low, close, 100 + random() * 100 + (random() < 0.05 ? 400 : 0)]);
    price = close;
  }
  return candles(rows, intervalMinutes, start);
}

/** Candles of a higher timeframe built from `entry` (every `factor` candles merged). */
export function resample(entry: readonly Candle[], factor: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + factor <= entry.length; i += factor) {
    const group = entry.slice(i, i + factor);
    out.push({
      openTime: group[0]!.openTime,
      closeTime: group[group.length - 1]!.closeTime,
      open: group[0]!.open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1]!.close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return out;
}

export function signal(method: MethodId, direction: Direction, stopLoss: number, index = 10, price = 100): MethodSignal {
  return { method, direction, index, time: T0 + index, price, stopLoss, reason: "test", levels: {} };
}
