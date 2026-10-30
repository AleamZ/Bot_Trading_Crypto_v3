import type { RiskSettings } from "../settings/schema.js";

/** Vietnam time (UTC+7, no daylight saving): the trading day resets at 00:00 local time. */
export const TRADING_DAY_OFFSET_MINUTES = 7 * 60;

/** "YYYY-MM-DD" of the trading day `time` falls in. */
export function tradingDayKey(time: number, offsetMinutes = TRADING_DAY_OFFSET_MINUTES): string {
  return new Date(time + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export interface GuardState {
  /** Settings toggle AND the TRADING_ENABLED env switch. */
  autoTradeAllowed: boolean;
  /** Paused from the UI or Telegram. */
  paused: boolean;
  openPositions: number;
  tradesToday: number;
  /** Realized result of today's closed trades, in R (losses are negative). */
  realizedRToday: number;
  /** The symbol already has a position or open orders (ours or not). */
  symbolBusy: boolean;
  /** Earliest time a new entry is allowed on the symbol after its last exit, or null. */
  cooldownUntil: number | null;
  now: number;
}

export type GuardReason =
  | "AUTO_TRADE_OFF"
  | "PAUSED"
  | "SYMBOL_BUSY"
  | "COOLDOWN"
  | "MAX_OPEN_POSITIONS"
  | "MAX_TRADES_PER_DAY"
  | "DAILY_LOSS_LIMIT";

export const GUARD_MESSAGES: Record<GuardReason, string> = {
  AUTO_TRADE_OFF: "Tự vào lệnh đang tắt",
  PAUSED: "Bot đang tạm dừng",
  SYMBOL_BUSY: "Symbol đang có vị thế hoặc lệnh chờ",
  COOLDOWN: "Symbol đang trong thời gian nghỉ sau lệnh trước",
  MAX_OPEN_POSITIONS: "Đã đủ số vị thế tối đa",
  MAX_TRADES_PER_DAY: "Đã đủ số lệnh tối đa trong ngày",
  DAILY_LOSS_LIMIT: "Đã chạm mức lỗ tối đa trong ngày",
};

export function checkEntryGuards(state: GuardState, risk: RiskSettings): { ok: true } | { ok: false; reason: GuardReason } {
  const fail = (reason: GuardReason) => ({ ok: false as const, reason });
  if (!state.autoTradeAllowed) return fail("AUTO_TRADE_OFF");
  if (state.paused) return fail("PAUSED");
  if (state.symbolBusy) return fail("SYMBOL_BUSY");
  if (state.cooldownUntil !== null && state.now < state.cooldownUntil) return fail("COOLDOWN");
  if (state.openPositions >= risk.maxOpenPositions) return fail("MAX_OPEN_POSITIONS");
  if (state.tradesToday >= risk.maxTradesPerDay) return fail("MAX_TRADES_PER_DAY");
  if (state.realizedRToday <= -risk.maxDailyLossR) return fail("DAILY_LOSS_LIMIT");
  return { ok: true };
}
