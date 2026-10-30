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

export type LeverageMode = "AUTO" | "FIXED";

export interface LeverageInput {
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  notional: number;
  availableBalance: number;
  maxMarginUsagePct: number;
  liqBufferMultiple: number;
  /** The highest leverage allowed: the setting, capped by the exchange for this notional. */
  maxLeverage: number;
  maintenanceMarginRate: number;
  /** AUTO: the smallest leverage whose margin fits. FIXED: always maxLeverage. */
  mode: LeverageMode;
  /** The 1R setting and what this sized position really loses at its stop (quantity is rounded down). */
  riskUsd: number;
  riskAtStop: number;
}

export type LeverageResult = MarginResult & { leverage: number };

/**
 * Leverage for a trade whose size is already fixed by 1R. Leverage does not change the loss at the
 * stop, only the margin locked and how close liquidation is, so AUTO takes the smallest leverage
 * whose margin fits in `maxMarginUsagePct` of the balance, then checks liquidation stays beyond the
 * stop. When nothing fits, the detail says the largest 1R this balance can carry for this stop.
 */
export function chooseLeverage(input: LeverageInput): LeverageResult {
  const allowed = (input.availableBalance * input.maxMarginUsagePct) / 100;
  const cap = Math.max(1, Math.floor(input.maxLeverage));
  const needed = allowed > 0 ? Math.max(1, Math.ceil(input.notional / allowed - 1e-9)) : Number.POSITIVE_INFINITY;
  const leverage = input.mode === "FIXED" ? cap : Math.min(cap, needed);
  const result = checkMargin({ ...input, leverage });
  if (result.ok) return { ...result, leverage };

  // Largest notional the balance can carry for this stop: margin fits at some leverage <= cap and
  // the liquidation at that leverage is still liqBufferMultiple stops away.
  const d = Math.abs(input.entryPrice - input.stopLoss) / input.entryPrice;
  const maxNotional = Math.min(allowed / (input.liqBufferMultiple * d + input.maintenanceMarginRate), allowed * cap);
  const ratio = maxNotional / input.notional;
  const hints: string[] = [];
  if (input.mode === "AUTO" && needed > cap && result.reason === "INSUFFICIENT_MARGIN") {
    hints.push(`cần đòn bẩy ${needed}x, vượt mức tối đa ${cap}x`);
  }
  if (ratio > 0 && ratio < 1 && input.riskAtStop > 0) {
    const maxRisk = input.riskAtStop * ratio;
    // The position a full 1R needs, relative to what this balance can carry.
    const minBalance = (input.availableBalance * (input.notional * input.riskUsd)) / input.riskAtStop / maxNotional;
    hints.push(`với số dư ${input.availableBalance.toFixed(2)}$ (dùng tối đa ${input.maxMarginUsagePct}% làm ký quỹ), lệnh có SL ${(d * 100).toFixed(2)}% chỉ đủ cho 1R ≤ ${maxRisk.toFixed(2)}$; muốn 1R = ${input.riskUsd}$ cần số dư ≥ ${minBalance.toFixed(2)}$`);
  } else if (input.mode === "FIXED") {
    hints.push(result.reason === "INSUFFICIENT_MARGIN" ? "tăng đòn bẩy hoặc chọn cách tính đòn bẩy AUTO" : "giảm đòn bẩy hoặc chọn cách tính đòn bẩy AUTO");
  }
  // checkMargin says "lower the leverage", which AUTO cannot do: it already uses the smallest that fits.
  const head =
    input.mode === "AUTO" && result.reason === "LIQUIDATION_TOO_CLOSE"
      ? `Ở đòn bẩy ${leverage}x (mức nhỏ nhất đủ ký quỹ) giá thanh lý ~${result.liquidationPrice.toPrecision(6)} quá gần SL ${input.stopLoss.toPrecision(6)}`
      : result.detail;
  return { ...result, leverage, detail: [head, ...hints].join("; ") };
}

export interface AffordInput {
  availableBalance: number;
  maxMarginUsagePct: number;
  liqBufferMultiple: number;
  maxLeverage: number;
  maintenanceMarginRate: number;
  /** Taker fee per side as a fraction (0 when fees are left out of 1R). */
  feeRate: number;
  /** Stop distance in percent of the entry. */
  stopPct: number;
  /** FIXED mode: the one leverage every trade uses (instead of any leverage up to maxLeverage). */
  fixedLeverage?: number;
}

/**
 * The largest 1R (USDT) a balance can carry for a stop `stopPct` away: margin within its share of
 * the balance at a leverage <= maxLeverage, with liquidation at least liqBufferMultiple stops away.
 * A wider stop allows a larger 1R (the same 1R needs a smaller position).
 */
export function maxRiskForBalance(input: AffordInput): number {
  const d = input.stopPct / 100;
  const allowed = (input.availableBalance * input.maxMarginUsagePct) / 100;
  if (!(allowed > 0) || !(d > 0)) return 0;
  const lossShare = d + input.feeRate * (2 - d);
  if (input.fixedLeverage !== undefined) {
    // One leverage: liquidation distance is fixed, so it either clears the stop or nothing fits.
    const leverage = Math.max(1, input.fixedLeverage);
    if (1 / leverage - input.maintenanceMarginRate < input.liqBufferMultiple * d) return 0;
    return allowed * leverage * lossShare;
  }
  const maxNotional = Math.min(allowed / (input.liqBufferMultiple * d + input.maintenanceMarginRate), allowed * Math.max(1, input.maxLeverage));
  return maxNotional * lossShare;
}

export interface Affordability {
  /** ok: every allowed stop distance fits; partial: only some; none: no trade can be opened. */
  level: "ok" | "partial" | "none";
  /** The 1R the balance can carry at the narrowest and the widest allowed stop. */
  maxRiskAtMinSl: number;
  maxRiskAtMaxSl: number;
  /** Stop distances (percent) where 1R fits, or null when none does. */
  fitsFrom: number | null;
  fitsTo: number | null;
  message: string | null;
}

/**
 * Whether the 1R setting fits the balance across the allowed stop range (minSlPct..maxSlPct),
 * so the user hears about it before a 3/3 gets refused. maintenanceMarginRate is the usual first
 * bracket (0.4%); each real trade is checked again with the symbol's own bracket.
 */
export function riskAffordability(
  risk: { riskUsd: number; minSlPct: number; maxSlPct: number; maxMarginUsagePct: number; liqBufferMultiple: number; leverage: number; leverageMode: LeverageMode; includeFees: boolean; feeRatePct: number },
  availableBalance: number,
  maintenanceMarginRate = 0.004,
): Affordability {
  const base: Omit<AffordInput, "stopPct"> = {
    availableBalance,
    maxMarginUsagePct: risk.maxMarginUsagePct,
    liqBufferMultiple: risk.liqBufferMultiple,
    maxLeverage: risk.leverage,
    maintenanceMarginRate,
    feeRate: risk.includeFees ? risk.feeRatePct / 100 : 0,
    ...(risk.leverageMode === "FIXED" ? { fixedLeverage: risk.leverage } : {}),
  };
  const at = (stopPct: number) => maxRiskForBalance({ ...base, stopPct });
  const steps = 100;
  let fitsFrom: number | null = null;
  let fitsTo: number | null = null;
  for (let n = 0; n <= steps; n++) {
    const stopPct = risk.minSlPct + ((risk.maxSlPct - risk.minSlPct) * n) / steps;
    if (at(stopPct) >= risk.riskUsd) {
      fitsFrom ??= stopPct;
      fitsTo = stopPct;
    }
  }
  const maxRiskAtMinSl = at(risk.minSlPct);
  const maxRiskAtMaxSl = at(risk.maxSlPct);
  const level = fitsFrom === null ? "none" : fitsFrom <= risk.minSlPct && fitsTo! >= risk.maxSlPct ? "ok" : "partial";
  const balance = `Số dư khả dụng ${availableBalance.toFixed(2)}$, dùng tối đa ${risk.maxMarginUsagePct}% làm ký quỹ`;
  const range = `1R tối đa từ ${maxRiskAtMinSl.toFixed(2)}$ (SL ${risk.minSlPct}%) đến ${maxRiskAtMaxSl.toFixed(2)}$ (SL ${risk.maxSlPct}%)`;
  let message: string | null = null;
  if (level === "none") {
    message = `${balance}: ${range}. 1R = ${risk.riskUsd}$ lớn hơn mức đó nên bot sẽ không vào được lệnh nào. Giảm 1R, tăng "Ký quỹ tối đa mỗi lệnh"${risk.leverageMode === "AUTO" ? ' hoặc "Đòn bẩy tối đa"' : ""}, hoặc nạp thêm`;
  } else if (level === "partial") {
    message = `${balance}: 1R = ${risk.riskUsd}$ chỉ vào được lệnh có SL từ ${fitsFrom!.toFixed(2)}% đến ${fitsTo!.toFixed(2)}%; lệnh có SL ngoài khoảng này sẽ bị từ chối (${range})`;
  }
  return { level, maxRiskAtMinSl, maxRiskAtMaxSl, fitsFrom, fitsTo, message };
}
