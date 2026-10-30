import type { Direction } from "../types.js";
import { ceilToStep, dec, floorToStep, roundToStep, type Dec, type DecValue } from "./decimal.js";

export interface TargetInput {
  direction: Direction;
  entry: DecValue;
  /** The final stop loss (already on the tick). */
  stopLoss: DecValue;
  rr: DecValue;
  tickSize: string;
}

/**
 * Take profit straight from the analysis: entry ± rr × |entry − stop|, rounded to the nearest tick
 * and at least one tick past the entry. Fees are not added, so with fees inside 1R the net win at
 * TP is a little under rr × the loss at the stop; netResultAt reports what it really is.
 */
export function takeProfitPrice(input: TargetInput): Dec {
  const long = input.direction === "LONG";
  const entry = dec(input.entry);
  const reward = dec(input.rr).mul(entry.minus(input.stopLoss).abs());
  const tick = dec(input.tickSize);
  const tp = roundToStep(long ? entry.plus(reward) : entry.minus(reward), input.tickSize);
  if (long) return tp.gt(entry) ? tp : floorToStep(entry, input.tickSize).plus(tick);
  if (!tp.gt(0)) return tick;
  return tp.lt(entry) ? tp : ceilToStep(entry, input.tickSize).minus(tick);
}

/** Net result at `exit` after both taker fees (positive = profit). */
export function netResultAt(direction: Direction, entry: DecValue, exit: DecValue, quantity: DecValue, feeRate: DecValue): Dec {
  const f = dec(entry);
  const x = dec(exit);
  const move = direction === "LONG" ? x.minus(f) : f.minus(x);
  return dec(quantity).mul(move.minus(dec(feeRate).mul(f.plus(x))));
}
