import type { Candle, MethodId, MethodSignal } from "../types.js";

export interface MarketData {
  /** Closed candles of the entry timeframe, oldest first. */
  entry: readonly Candle[];
  /** Closed candles of the trend timeframe, oldest first. */
  trend: readonly Candle[];
}

/** Series several methods share, computed once per candle array. */
export interface SharedSeries {
  atr: readonly number[];
}

/**
 * A method with its indicator series precomputed for one candle array. `evaluate(i)` only looks
 * at candles up to i, so the same object serves the live bot (last index) and backtests (every index).
 */
export interface PreparedStrategy {
  readonly id: MethodId;
  /** The trigger on candle i, or null. */
  evaluate(i: number): MethodSignal | null;
  /** True when the setup behind `signal` no longer holds at candle j > signal.index. Stop touches are checked separately. */
  isInvalidated(signal: MethodSignal, j: number): boolean;
}

export function isFiniteAll(...values: number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}
