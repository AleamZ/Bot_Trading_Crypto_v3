/**
 * Series helpers. Every function returns an array aligned with its input, with NaN where the
 * value is not defined yet (warm-up).
 */

export function sma(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (period < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values (same as TradingView ta.ema). */
export function ema(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i]!;
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's moving average (RMA). Leading NaN values are skipped: the first output is the SMA of
 * the first `period` defined values, then avg = (prev * (period - 1) + value) / period.
 */
export function rma(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (period < 1) return out;
  let start = 0;
  while (start < values.length && Number.isNaN(values[start]!)) start++;
  if (values.length - start < period) return out;
  let prev = 0;
  for (let i = start; i < start + period; i++) prev += values[i]!;
  prev /= period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** Highest value of the `length` items before index i (index i itself excluded). */
export function highestBefore(values: readonly number[], length: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  for (let i = length; i < values.length; i++) {
    let max = -Infinity;
    for (let j = i - length; j < i; j++) if (values[j]! > max) max = values[j]!;
    out[i] = max;
  }
  return out;
}

/** Lowest value of the `length` items before index i (index i itself excluded). */
export function lowestBefore(values: readonly number[], length: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  for (let i = length; i < values.length; i++) {
    let min = Infinity;
    for (let j = i - length; j < i; j++) if (values[j]! < min) min = values[j]!;
    out[i] = min;
  }
  return out;
}
