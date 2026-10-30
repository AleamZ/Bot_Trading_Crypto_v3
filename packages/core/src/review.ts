import type { Candle, Direction } from "./types.js";

export interface TradePath {
  /** Candles from the one after the entry to the exit candle, inclusive. */
  bars: number;
  /** Largest move in the trade's favour and against it, in units of the entry-to-stop distance. */
  mfeR: number;
  maeR: number;
  /** How far towards the take profit the price got (1 = reached it). */
  maxTpProgress: number;
  /** The best and worst price reached. */
  bestPrice: number;
  worstPrice: number;
}

/**
 * How the price moved while a trade was open, from the candles it was held through. Losses that
 * first ran well in favour, or wins that came close to the stop, are what a review should explain.
 */
export function tradePath(direction: Direction, entry: number, stopLoss: number, takeProfit: number, held: readonly Candle[]): TradePath {
  const long = direction === "LONG";
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  let best = entry;
  let worst = entry;
  for (const c of held) {
    best = long ? Math.max(best, c.high) : Math.min(best, c.low);
    worst = long ? Math.min(worst, c.low) : Math.max(worst, c.high);
  }
  const favour = long ? best - entry : entry - best;
  const against = long ? entry - worst : worst - entry;
  return {
    bars: held.length,
    mfeR: risk > 0 ? favour / risk : 0,
    maeR: risk > 0 ? against / risk : 0,
    maxTpProgress: reward > 0 ? favour / reward : 0,
    bestPrice: best,
    worstPrice: worst,
  };
}
