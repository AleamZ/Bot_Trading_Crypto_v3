import { checkMargin, type Direction, type MarginResult, type RiskSettings } from "@bot-v3/core";
import type { LeverageBracket } from "../binance/types.js";

export interface LeverageInput {
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  notional: number;
  availableBalance: number;
  brackets: readonly LeverageBracket[];
  risk: RiskSettings;
}

export type LeverageChoice = MarginResult & { leverage: number; maxLeverage: number };

/**
 * The leverage a trade is opened with and whether its margin and liquidation price are acceptable.
 * Used by the executor and by the chart's "if it entered now" preview, so both always agree.
 */
export function chooseLeverage(input: LeverageInput): LeverageChoice {
  const { risk, brackets } = input;
  const maxLeverage = brackets[0]?.initialLeverage ?? risk.leverage;
  const leverage = Math.max(1, Math.min(risk.leverage, maxLeverage));
  const bracket = brackets.find((b) => input.notional >= b.notionalFloor && input.notional < b.notionalCap) ?? brackets[0];
  const result = checkMargin({
    direction: input.direction,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    notional: input.notional,
    leverage,
    availableBalance: input.availableBalance,
    maxMarginUsagePct: risk.maxMarginUsagePct,
    maintenanceMarginRate: bracket?.maintMarginRatio ?? 0.005,
    liqBufferMultiple: risk.liqBufferMultiple,
  });
  return { ...result, leverage, maxLeverage };
}
