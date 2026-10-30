import type { Direction } from "../types.js";
import { ceilToStep, dec, floorToStep, formatToStep, roundToStep, type Dec, type DecValue } from "./decimal.js";
import { lossPerUnit } from "./sizing.js";

export type StopMode = "EXACT_1R" | "KEEP_STRUCTURE";

export interface FillInput {
  direction: Direction;
  /** Average fill price of the MARKET entry. */
  fillPrice: DecValue;
  /** Executed quantity of the entry. */
  filledQty: DecValue;
  /** The structural stop the position was sized with. */
  structuralStop: DecValue;
  riskUsd: DecValue;
  /** Taker fee per side as a fraction; 0 when fees are not part of 1R. */
  feeRate: DecValue;
  rr: DecValue;
  mode: StopMode;
  /** EXACT_1R falls back to the structural stop if it would move the stop further than this (percent). */
  maxSlWidenPct: number;
  tickSize: string;
}

export type FillResult =
  | {
      ok: true;
      stopLoss: string;
      takeProfit: string;
      /** Loss in USDT if the stop fills exactly at stopLoss, fees included. */
      riskUsd: string;
      riskR: number;
      /** The mode actually used (EXACT_1R may fall back to KEEP_STRUCTURE). */
      mode: StopMode;
      fellBack: boolean;
    }
  | { ok: false; reason: "INVALID_INPUT" | "FILL_BEYOND_STOP" | "FEES_EXCEED_RISK"; detail: string };

/**
 * Final SL/TP once the entry has filled.
 *
 * EXACT_1R solves for the stop at which the real fill and quantity lose exactly 1R with fees:
 *   LONG:  Q·(F − SL) + fee·Q·(F + SL) = R  =>  SL = (Q·F·(1 + fee) − R) / (Q·(1 − fee))
 *   SHORT: Q·(SL − F) + fee·Q·(F + SL) = R  =>  SL = (R + Q·F·(1 − fee)) / (Q·(1 + fee))
 * then rounds to the tick towards the entry, so the loss stays <= 1R. If that would widen the stop
 * by more than `maxSlWidenPct` beyond the structural one (quantity of only one or two steps), the
 * structural stop is kept and the real risk is reported instead.
 */
export function finalizeAfterFill(input: FillInput): FillResult {
  const long = input.direction === "LONG";
  const fill = dec(input.fillPrice);
  const qty = dec(input.filledQty);
  const risk = dec(input.riskUsd);
  const fee = dec(input.feeRate);
  const rr = dec(input.rr);
  if (!fill.gt(0) || !qty.gt(0) || !risk.gt(0) || fee.lt(0) || !rr.gt(0) || !dec(input.structuralStop).gt(0)) {
    return { ok: false, reason: "INVALID_INPUT", detail: "Giá khớp, khối lượng, SL, 1R và RR phải dương" };
  }

  const structural = long ? floorToStep(input.structuralStop, input.tickSize) : ceilToStep(input.structuralStop, input.tickSize);
  if (long ? !structural.lt(fill) : !structural.gt(fill)) {
    return {
      ok: false,
      reason: "FILL_BEYOND_STOP",
      detail: `Giá khớp ${fill.toString()} đã vượt qua SL ${structural.toString()}`,
    };
  }

  let stop = structural;
  let mode: StopMode = "KEEP_STRUCTURE";
  let fellBack = false;
  if (input.mode === "EXACT_1R") {
    const exact = long
      ? qty.mul(fill).mul(fee.plus(1)).minus(risk).div(qty.mul(dec(1).minus(fee)))
      : risk.plus(qty.mul(fill).mul(dec(1).minus(fee))).div(qty.mul(fee.plus(1)));
    const rounded = long ? ceilToStep(exact, input.tickSize) : floorToStep(exact, input.tickSize);
    if (!rounded.gt(0) || (long ? !rounded.lt(fill) : !rounded.gt(fill))) {
      return {
        ok: false,
        reason: "FEES_EXCEED_RISK",
        detail: `Phí hai chiều của lệnh đã lớn hơn hoặc bằng 1R (${risk.toString()} USDT)`,
      };
    }
    const structuralDistance = fill.minus(structural).abs();
    const exactDistance = fill.minus(rounded).abs();
    const limit = structuralDistance.mul(dec(input.maxSlWidenPct).div(100).plus(1));
    if (exactDistance.lte(limit)) {
      stop = rounded;
      mode = "EXACT_1R";
    } else {
      fellBack = true;
    }
  }

  const distance = fill.minus(stop).abs();
  let takeProfit = roundToStep(long ? fill.plus(rr.mul(distance)) : fill.minus(rr.mul(distance)), input.tickSize);
  const tick = dec(input.tickSize);
  if (long ? takeProfit.lte(fill) : takeProfit.gte(fill)) takeProfit = long ? fill.plus(tick) : fill.minus(tick);

  const loss: Dec = qty.mul(lossPerUnit(fill, stop, fee));
  return {
    ok: true,
    stopLoss: formatToStep(stop, input.tickSize),
    takeProfit: formatToStep(takeProfit, input.tickSize),
    riskUsd: loss.toFixed(4),
    riskR: loss.div(risk).toNumber(),
    mode,
    fellBack,
  };
}
