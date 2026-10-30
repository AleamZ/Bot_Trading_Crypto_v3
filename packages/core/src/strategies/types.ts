import type { Candle, Direction, MethodId, MethodSignal } from "../types.js";

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
  /**
   * Every condition of the method at candle i, for LONG and SHORT, with the values behind it.
   * A side is `ready` exactly when evaluate(i) returns a signal in that direction (tested).
   */
  explain(i: number): StrategyExplanation;
}

/** One condition of a method: met, not met, or not known yet (not enough data, or an earlier step failed). */
export interface Check {
  label: string;
  pass: boolean | null;
  detail: string | null;
}

export interface SideExplanation {
  direction: Direction;
  checks: Check[];
  /** Conditions met, out of checks.length. */
  passed: number;
  /** All conditions met: the method fires in this direction on this candle. */
  ready: boolean;
}

export interface StrategyExplanation {
  method: MethodId;
  sides: [SideExplanation, SideExplanation];
}

export function side(direction: Direction, checks: Check[]): SideExplanation {
  const passed = checks.filter((c) => c.pass === true).length;
  return { direction, checks, passed, ready: passed === checks.length };
}

/** Prices and indicator values for explanations: 6 significant digits. */
export function fmt(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toPrecision(6))) : "—";
}

export function isFiniteAll(...values: number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}
