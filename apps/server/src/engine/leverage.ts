import { chooseLeverage as choose, type Direction, type LeverageResult, type RiskSettings } from "@bot-v3/core";
import type { LeverageBracket } from "../binance/types.js";

export interface LeverageInput {
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  notional: number;
  /** What this sized position loses at its stop. */
  riskAtStop: number;
  availableBalance: number;
  brackets: readonly LeverageBracket[];
  risk: RiskSettings;
}

export type LeverageChoice = LeverageResult & { maxLeverage: number };

/** Binance's bracket for a position of this notional (bigger positions get a lower leverage cap). */
export function bracketFor(brackets: readonly LeverageBracket[], notional: number): LeverageBracket | null {
  return brackets.find((b) => notional >= b.notionalFloor && notional < b.notionalCap) ?? brackets.at(-1) ?? null;
}

/**
 * The leverage a trade is opened with and whether its margin and liquidation are acceptable.
 * The cap is the setting, lowered to what Binance allows for this notional. Used by the executor
 * and by the chart's "if it entered now" preview, so both always agree.
 */
export function chooseLeverage(input: LeverageInput): LeverageChoice {
  const { risk } = input;
  const bracket = bracketFor(input.brackets, input.notional);
  const maxLeverage = Math.max(1, Math.min(risk.leverage, bracket?.initialLeverage ?? risk.leverage));
  const result = choose({
    direction: input.direction,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    notional: input.notional,
    availableBalance: input.availableBalance,
    maxMarginUsagePct: risk.maxMarginUsagePct,
    liqBufferMultiple: risk.liqBufferMultiple,
    maxLeverage,
    maintenanceMarginRate: bracket?.maintMarginRatio ?? 0.005,
    mode: risk.leverageMode,
    riskUsd: risk.riskUsd,
    riskAtStop: input.riskAtStop,
  });
  return { ...result, maxLeverage };
}
