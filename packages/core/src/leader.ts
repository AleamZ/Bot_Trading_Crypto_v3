import { ema } from "./indicators/moving.js";
import type { Candle, Direction } from "./types.js";

/** "Theo chân người khổng lồ": altcoins follow BTC. */
export const LEADER_SYMBOL = "BTCUSDT";

/**
 * OFF: no rule. NOT_AGAINST: an altcoin may not enter against BTC's trend (BTC without a clear
 * trend blocks nothing). WITH: an altcoin enters only in BTC's trend direction.
 */
export const FOLLOW_BTC_MODES = ["OFF", "NOT_AGAINST", "WITH"] as const;
export type FollowBtcMode = (typeof FOLLOW_BTC_MODES)[number];

/** BTC's trend for an altcoin: LONG or SHORT, null when unclear, NO_DATA when its candles could not be read. */
export type LeaderTrend = Direction | null | "NO_DATA";

export interface TrendBiasParams {
  emaMid: number;
  emaSlow: number;
  slopeLookback: number;
}

/**
 * The trend of each candle of a trend timeframe: LONG when the close and EMA(mid) are above
 * EMA(slow) and EMA(mid) rose over `slopeLookback` candles, SHORT the mirror, else null. The same
 * rule as method A's higher timeframe ("khung lớn tăng / giảm").
 */
export function trendBiasSeries(trend: readonly Candle[], p: TrendBiasParams): (Direction | null)[] {
  const closes = trend.map((c) => c.close);
  const mid = ema(closes, p.emaMid);
  const slow = ema(closes, p.emaSlow);
  return trend.map((c, t) => {
    const before = t - p.slopeLookback;
    if (before < 0) return null;
    const m = mid[t]!;
    const s = slow[t]!;
    const mBefore = mid[before]!;
    if (!Number.isFinite(m) || !Number.isFinite(s) || !Number.isFinite(mBefore)) return null;
    if (c.close > s && m > s && m > mBefore) return "LONG";
    if (c.close < s && m < s && m < mBefore) return "SHORT";
    return null;
  });
}

/** True when `mode` forbids entering `direction` while BTC's trend is `trend`. Unknown BTC data blocks. */
export function againstLeader(direction: Direction, trend: LeaderTrend, mode: FollowBtcMode): boolean {
  if (mode === "OFF") return false;
  if (trend === "NO_DATA") return true;
  return mode === "WITH" ? trend !== direction : trend !== null && trend !== direction;
}

/** "BTC tăng", "BTC giảm", "BTC chưa rõ xu hướng", "không đọc được nến BTC". */
export function leaderTrendText(trend: LeaderTrend): string {
  if (trend === "NO_DATA") return "không đọc được nến BTC";
  return trend === "LONG" ? "BTC tăng" : trend === "SHORT" ? "BTC giảm" : "BTC chưa rõ xu hướng";
}
