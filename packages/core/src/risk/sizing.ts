import type { Direction } from "../types.js";
import { ceilToStep, D, dec, floorToStep, formatToStep, type Dec, type DecValue } from "./decimal.js";
import type { SymbolFilters } from "./filters.js";
import { takeProfitPrice } from "./targets.js";

export type SizingRejectReason = "INVALID_INPUT" | "STOP_WRONG_SIDE" | "QTY_BELOW_MIN" | "NOTIONAL_BELOW_MIN";

export interface SizingInput {
  direction: Direction;
  entryPrice: DecValue;
  /** Structural stop loss; it is rounded to the tick away from the entry. */
  stopLoss: DecValue;
  /** 1R in USDT. */
  riskUsd: DecValue;
  /** Taker fee per side as a fraction (0.0005 = 0.05%). Pass 0 to leave fees out of 1R. */
  feeRate: DecValue;
  rr: DecValue;
  filters: SymbolFilters;
}

export type SizingResult =
  | {
      ok: true;
      quantity: string;
      entryPrice: string;
      stopLoss: string;
      takeProfit: string;
      notional: string;
      /** Loss in USDT if the stop fills exactly at stopLoss, fees included. Always <= riskUsd. */
      riskAtStop: string;
      riskR: number;
      clampedToMaxQty: boolean;
    }
  | {
      ok: false;
      reason: SizingRejectReason;
      detail: string;
      /** The smallest 1R that would make this trade possible, when that is the problem. */
      minRiskUsd: string | null;
    };

/** Loss per coin if the stop fills at `stop`: price distance plus the taker fee on both legs. */
export function lossPerUnit(entry: DecValue, stop: DecValue, feeRate: DecValue): Dec {
  const e = dec(entry);
  const s = dec(stop);
  return e.minus(s).abs().plus(dec(feeRate).mul(e.plus(s)));
}

/**
 * Position size for a fixed risk: quantity = riskUsd / lossPerUnit, rounded DOWN to the step so a
 * stop at the structural level never loses more than 1R. Never sized up to reach a minimum, since
 * that would risk more than 1R; the trade is rejected instead.
 */
export function sizePosition(input: SizingInput): SizingResult {
  const reject = (reason: SizingRejectReason, detail: string, minRiskUsd: Dec | null = null): SizingResult => ({
    ok: false,
    reason,
    detail,
    minRiskUsd: minRiskUsd ? minRiskUsd.toDecimalPlaces(2, D.ROUND_UP).toFixed(2) : null,
  });

  const { filters } = input;
  const entry = dec(input.entryPrice);
  const risk = dec(input.riskUsd);
  const feeRate = dec(input.feeRate);
  const rr = dec(input.rr);
  if (!entry.gt(0) || !risk.gt(0) || feeRate.lt(0) || !rr.gt(0) || !dec(input.stopLoss).gt(0)) {
    return reject("INVALID_INPUT", "Giá, SL, 1R và RR phải dương");
  }
  const long = input.direction === "LONG";
  const stop = long ? floorToStep(input.stopLoss, filters.tickSize) : ceilToStep(input.stopLoss, filters.tickSize);
  if (long ? !stop.lt(entry) : !stop.gt(entry)) {
    return reject("STOP_WRONG_SIDE", `SL ${stop.toString()} không nằm ${long ? "dưới" : "trên"} giá vào ${entry.toString()}`);
  }

  const perUnit = lossPerUnit(entry, stop, feeRate);
  let quantity = floorToStep(risk.div(perUnit), filters.stepSize);
  let clampedToMaxQty = false;
  if (filters.maxQty !== null && quantity.gt(filters.maxQty)) {
    quantity = floorToStep(filters.maxQty, filters.stepSize);
    clampedToMaxQty = true;
  }

  const minQty = dec(filters.minQty);
  if (quantity.lte(0) || quantity.lt(minQty)) {
    const needed = ceilToStep(minQty.gt(0) ? minQty : filters.stepSize, filters.stepSize);
    return reject(
      "QTY_BELOW_MIN",
      `Khối lượng cho 1R là ${quantity.toString()}, nhỏ hơn mức tối thiểu ${needed.toString()}`,
      needed.mul(perUnit),
    );
  }
  const notional = quantity.mul(entry);
  if (filters.minNotional !== null && notional.lt(filters.minNotional)) {
    const needed = ceilToStep(dec(filters.minNotional).div(entry), filters.stepSize);
    return reject(
      "NOTIONAL_BELOW_MIN",
      `Giá trị lệnh ${notional.toFixed(2)} USDT nhỏ hơn mức tối thiểu ${filters.minNotional} USDT`,
      needed.mul(perUnit),
    );
  }

  const riskAtStop = quantity.mul(perUnit);
  const takeProfit = takeProfitPrice({
    direction: input.direction,
    entry,
    quantity,
    lossAtStop: riskAtStop,
    rr,
    feeRate,
    tickSize: filters.tickSize,
  });
  return {
    ok: true,
    quantity: formatToStep(quantity, filters.stepSize),
    entryPrice: entry.toString(),
    stopLoss: formatToStep(stop, filters.tickSize),
    takeProfit: formatToStep(takeProfit, filters.tickSize),
    notional: notional.toFixed(2),
    riskAtStop: riskAtStop.toFixed(4),
    riskR: riskAtStop.div(risk).toNumber(),
    clampedToMaxQty,
  };
}
