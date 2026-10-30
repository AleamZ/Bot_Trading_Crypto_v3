import type { Direction } from "../types.js";

export interface MarginInput {
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  notional: number;
  leverage: number;
  availableBalance: number;
  /** Largest share of the available balance one trade may use as margin, in percent. */
  maxMarginUsagePct: number;
  /** Maintenance margin rate of the symbol's first bracket (0.004 = 0.4%). */
  maintenanceMarginRate: number;
  /** Liquidation must be at least this many SL distances away from the entry. */
  liqBufferMultiple: number;
}

export type MarginResult =
  | { ok: true; margin: number; liquidationPrice: number }
  | { ok: false; reason: "INVALID_INPUT" | "INSUFFICIENT_MARGIN" | "LIQUIDATION_TOO_CLOSE"; detail: string; margin: number; liquidationPrice: number };

/**
 * Margin and an isolated-margin liquidation estimate:
 *   LONG  liq ≈ entry × (1 − 1/leverage + mmr)
 *   SHORT liq ≈ entry × (1 + 1/leverage − mmr)
 * The estimate ignores fees and funding, which is why a buffer beyond the stop is required.
 */
export function checkMargin(input: MarginInput): MarginResult {
  const { entryPrice, stopLoss, notional, leverage } = input;
  const long = input.direction === "LONG";
  const margin = leverage > 0 ? notional / leverage : Number.NaN;
  const liquidationPrice = long
    ? entryPrice * (1 - 1 / leverage + input.maintenanceMarginRate)
    : entryPrice * (1 + 1 / leverage - input.maintenanceMarginRate);
  if (!(entryPrice > 0 && stopLoss > 0 && notional > 0 && leverage >= 1) || !Number.isFinite(margin)) {
    return { ok: false, reason: "INVALID_INPUT", detail: "Thiếu giá, SL, notional hoặc đòn bẩy", margin, liquidationPrice };
  }
  const allowed = (input.availableBalance * input.maxMarginUsagePct) / 100;
  if (margin > allowed) {
    return {
      ok: false,
      reason: "INSUFFICIENT_MARGIN",
      detail: `Cần ký quỹ ${margin.toFixed(2)} USDT, chỉ được dùng ${allowed.toFixed(2)} USDT`,
      margin,
      liquidationPrice,
    };
  }
  const stopDistance = Math.abs(entryPrice - stopLoss);
  const liqDistance = long ? entryPrice - liquidationPrice : liquidationPrice - entryPrice;
  if (liqDistance < stopDistance * input.liqBufferMultiple) {
    return {
      ok: false,
      reason: "LIQUIDATION_TOO_CLOSE",
      detail: `Giá thanh lý ước tính ${liquidationPrice.toFixed(4)} quá gần SL ${stopLoss}; giảm đòn bẩy`,
      margin,
      liquidationPrice,
    };
  }
  return { ok: true, margin, liquidationPrice };
}
