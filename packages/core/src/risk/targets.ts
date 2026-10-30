import type { Direction } from "../types.js";
import { ceilToStep, dec, floorToStep, type Dec, type DecValue } from "./decimal.js";

export interface TargetInput {
  direction: Direction;
  entry: DecValue;
  quantity: DecValue;
  /** What the position loses at its stop, fees included (the trade's real 1R). */
  lossAtStop: DecValue;
  rr: DecValue;
  /** Taker fee per side as a fraction; 0 when fees are left out. */
  feeRate: DecValue;
  tickSize: string;
}

/**
 * Take profit at which the position nets exactly rr × lossAtStop after both taker fees, so "R:R 2"
 * means winning 2R the same way the stop means losing 1R:
 *   LONG:  Q·(TP − F) − fee·Q·(F + TP) = rr·L  =>  TP = (rr·L + Q·F·(1 + fee)) / (Q·(1 − fee))
 *   SHORT: Q·(F − TP) − fee·Q·(F + TP) = rr·L  =>  TP = (Q·F·(1 − fee) − rr·L) / (Q·(1 + fee))
 * Rounded to the tick away from the entry, so the net win is never below rr × lossAtStop.
 * Without fees this is the usual F ± rr × |F − SL|.
 */
export function takeProfitPrice(input: TargetInput): Dec {
  const q = dec(input.quantity);
  const f = dec(input.entry);
  const fee = dec(input.feeRate);
  const target = dec(input.rr).mul(input.lossAtStop);
  if (input.direction === "LONG") {
    return ceilToStep(target.plus(q.mul(f).mul(fee.plus(1))).div(q.mul(dec(1).minus(fee))), input.tickSize);
  }
  const raw = q.mul(f).mul(dec(1).minus(fee)).minus(target).div(q.mul(fee.plus(1)));
  const tp = floorToStep(raw, input.tickSize);
  return tp.gt(0) ? tp : dec(input.tickSize);
}

/** Net result at `exit` after both taker fees (positive = profit). */
export function netResultAt(direction: Direction, entry: DecValue, exit: DecValue, quantity: DecValue, feeRate: DecValue): Dec {
  const f = dec(entry);
  const x = dec(exit);
  const move = direction === "LONG" ? x.minus(f) : f.minus(x);
  return dec(quantity).mul(move.minus(dec(feeRate).mul(f.plus(x))));
}
