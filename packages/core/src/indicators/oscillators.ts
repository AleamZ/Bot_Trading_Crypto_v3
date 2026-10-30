import type { Candle } from "../types.js";
import { rma } from "./moving.js";

/** Wilder's RSI. The first value sits at index `period`. */
export function rsi(closes: readonly number[], period: number): number[] {
  const gains = new Array<number>(closes.length).fill(Number.NaN);
  const losses = new Array<number>(closes.length).fill(Number.NaN);
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    gains[i] = change > 0 ? change : 0;
    losses[i] = change < 0 ? -change : 0;
  }
  const avgGain = rma(gains, period);
  const avgLoss = rma(losses, period);
  return closes.map((_, i) => {
    const gain = avgGain[i]!;
    const loss = avgLoss[i]!;
    if (Number.isNaN(gain) || Number.isNaN(loss)) return Number.NaN;
    if (loss === 0) return gain === 0 ? 50 : 100;
    return 100 - 100 / (1 + gain / loss);
  });
}

export function trueRange(candles: readonly Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

/** Wilder's ATR. The first value sits at index `period - 1`. */
export function atr(candles: readonly Candle[], period: number): number[] {
  return rma(trueRange(candles), period);
}

export interface AdxSeries {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
}

/** Wilder's ADX with +DI/-DI. DI values start at index `period`, ADX at `2 * period - 1`. */
export function adx(candles: readonly Candle[], period: number): AdxSeries {
  const n = candles.length;
  const tr = new Array<number>(n).fill(Number.NaN);
  const plusDm = new Array<number>(n).fill(Number.NaN);
  const minusDm = new Array<number>(n).fill(Number.NaN);
  const ranges = trueRange(candles);
  for (let i = 1; i < n; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high;
    const down = candles[i - 1]!.low - candles[i]!.low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
    tr[i] = ranges[i]!;
  }
  const smTr = rma(tr, period);
  const smPlus = rma(plusDm, period);
  const smMinus = rma(minusDm, period);
  const plusDi = new Array<number>(n).fill(Number.NaN);
  const minusDi = new Array<number>(n).fill(Number.NaN);
  const dx = new Array<number>(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    const t = smTr[i]!;
    if (Number.isNaN(t)) continue;
    const p = t === 0 ? 0 : (100 * smPlus[i]!) / t;
    const m = t === 0 ? 0 : (100 * smMinus[i]!) / t;
    plusDi[i] = p;
    minusDi[i] = m;
    dx[i] = p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m);
  }
  return { adx: rma(dx, period), plusDi, minusDi };
}
