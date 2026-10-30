import type { RiskSettings } from "../settings/schema.js";
import type { Direction, MethodSignal } from "../types.js";
import type { SymbolFilters } from "./filters.js";
import { sizePosition, type SizingResult } from "./sizing.js";
import { combineStops } from "./stops.js";

export type PlanRejectReason = "STOP_TOO_CLOSE" | "STOP_TOO_FAR" | "STOP_TOO_FAR_ATR" | "STOP_WRONG_SIDE";

export interface PlanInput {
  direction: Direction;
  /** The agreeing methods' signals. */
  signals: readonly MethodSignal[];
  /** Current price the entry would fill near (last close or mark price). */
  entryPrice: number;
  atr: number;
  risk: RiskSettings;
  /** Without filters the plan stops at SL/TP; quantity needs the symbol's exchange filters. */
  filters: SymbolFilters | null;
}

export type TradePlan =
  | {
      ok: true;
      direction: Direction;
      entryPrice: number;
      /** Combined structural stop before tick rounding. */
      stopLoss: number;
      stopPct: number;
      sizing: SizingResult | null;
    }
  | { ok: false; direction: Direction; reason: PlanRejectReason; detail: string; stopLoss: number; stopPct: number };

export function feeRateOf(risk: RiskSettings): number {
  return risk.includeFees ? risk.feeRatePct / 100 : 0;
}

/** Combines the agreeing stops, checks the distance limits and sizes the position for 1R. */
export function planTrade(input: PlanInput): TradePlan {
  const { direction, entryPrice, atr, risk } = input;
  const long = direction === "LONG";
  const stopLoss = combineStops(direction, input.signals.map((s) => s.stopLoss), risk.slPolicy);
  const distance = long ? entryPrice - stopLoss : stopLoss - entryPrice;
  const stopPct = (Math.abs(entryPrice - stopLoss) / entryPrice) * 100;
  const reject = (reason: PlanRejectReason, detail: string): TradePlan => ({ ok: false, direction, reason, detail, stopLoss, stopPct });

  if (!(distance > 0)) return reject("STOP_WRONG_SIDE", `Giá hiện tại ${entryPrice} đã vượt qua SL ${stopLoss}`);
  if (stopPct < risk.minSlPct) return reject("STOP_TOO_CLOSE", `Khoảng SL ${stopPct.toFixed(2)}% nhỏ hơn ${risk.minSlPct}%`);
  if (stopPct > risk.maxSlPct) return reject("STOP_TOO_FAR", `Khoảng SL ${stopPct.toFixed(2)}% lớn hơn ${risk.maxSlPct}%`);
  if (Number.isFinite(atr) && atr > 0 && distance > risk.maxSlAtr * atr) {
    return reject("STOP_TOO_FAR_ATR", `Khoảng SL bằng ${(distance / atr).toFixed(2)} ATR, lớn hơn ${risk.maxSlAtr} ATR`);
  }

  const sizing = input.filters
    ? sizePosition({
        direction,
        entryPrice,
        stopLoss,
        riskUsd: risk.riskUsd,
        feeRate: feeRateOf(risk),
        rr: risk.rr,
        filters: input.filters,
      })
    : null;
  return { ok: true, direction, entryPrice, stopLoss, stopPct, sizing };
}
