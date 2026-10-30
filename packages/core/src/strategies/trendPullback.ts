import { ema } from "../indicators/moving.js";
import { rsi } from "../indicators/oscillators.js";
import { alignHigherTimeframe } from "../indicators/structure.js";
import type { TrendPullbackParams } from "../settings/schema.js";
import type { Direction, MethodSignal } from "../types.js";
import { isFiniteAll, type MarketData, type PreparedStrategy, type SharedSeries } from "./types.js";

/**
 * A. Trend + pullback to the EMA.
 * Trend timeframe: close and EMA(mid) on the trend side of EMA(slow), EMA(mid) sloping that way.
 * Entry timeframe: EMA(fast) beyond EMA(mid); within the last `pullbackLookback` candles price
 * touched EMA(fast) without any close beyond EMA(mid); the trigger candle closes back in the trend
 * direction beyond EMA(fast) and the previous candle's extreme, with RSI in range and turning.
 */
export function prepareTrendPullback(market: MarketData, p: TrendPullbackParams, shared: SharedSeries): PreparedStrategy {
  const { entry, trend } = market;
  const closes = entry.map((c) => c.close);
  const emaFast = ema(closes, p.emaFast);
  const emaMid = ema(closes, p.emaMid);
  const rsiSeries = rsi(closes, p.rsiPeriod);
  const trendCloses = trend.map((c) => c.close);
  const trendMid = ema(trendCloses, p.emaMid);
  const trendSlow = ema(trendCloses, p.emaSlow);
  const trendIndex = alignHigherTimeframe(entry, trend);

  function trendBias(i: number): Direction | null {
    const t = trendIndex[i]!;
    const before = t - p.slopeLookback;
    if (before < 0) return null;
    const close = trend[t]!.close;
    const mid = trendMid[t]!;
    const slow = trendSlow[t]!;
    const midBefore = trendMid[before]!;
    if (!isFiniteAll(mid, slow, midBefore)) return null;
    if (close > slow && mid > slow && mid > midBefore) return "LONG";
    if (close < slow && mid < slow && mid < midBefore) return "SHORT";
    return null;
  }

  function evaluate(i: number): MethodSignal | null {
    const from = i - p.pullbackLookback + 1;
    if (i < 1 || from < 0) return null;
    const bias = trendBias(i);
    if (!bias) return null;
    const long = bias === "LONG";
    const c = entry[i]!;
    const prev = entry[i - 1]!;
    const fast = emaFast[i]!;
    const mid = emaMid[i]!;
    const atr = shared.atr[i]!;
    const r = rsiSeries[i]!;
    const rPrev = rsiSeries[i - 1]!;
    if (!isFiniteAll(fast, mid, atr, r, rPrev)) return null;
    if (long ? !(fast > mid) : !(fast < mid)) return null;

    let touched = false;
    let extreme = long ? Infinity : -Infinity;
    for (let k = from; k <= i; k++) {
      const ck = entry[k]!;
      const midK = emaMid[k]!;
      const fastK = emaFast[k]!;
      if (!isFiniteAll(midK, fastK)) return null;
      if (long ? ck.close < midK : ck.close > midK) return null;
      if (long ? ck.low <= fastK : ck.high >= fastK) touched = true;
      extreme = long ? Math.min(extreme, ck.low) : Math.max(extreme, ck.high);
    }
    if (!touched) return null;

    const triggered = long
      ? c.close > c.open && c.close > fast && c.close > prev.high
      : c.close < c.open && c.close < fast && c.close < prev.low;
    if (!triggered) return null;
    const rsiOk = long
      ? r >= p.rsiMin && r <= p.rsiMax && r > rPrev
      : r >= 100 - p.rsiMax && r <= 100 - p.rsiMin && r < rPrev;
    if (!rsiOk) return null;

    const stopLoss = long ? extreme - p.slAtrBuffer * atr : extreme + p.slAtrBuffer * atr;
    if (long ? !(stopLoss < c.close) : !(stopLoss > c.close)) return null;

    return {
      method: "trendPullback",
      direction: bias,
      index: i,
      time: c.closeTime,
      price: c.close,
      stopLoss,
      reason: `Xu hướng ${long ? "tăng" : "giảm"}, hồi chạm EMA${p.emaFast} rồi ${long ? "bật lên" : "quay xuống"}, RSI ${r.toFixed(1)}`,
      levels: { emaFast: fast, emaMid: mid, pullbackExtreme: extreme },
    };
  }

  function isInvalidated(signal: MethodSignal, j: number): boolean {
    const mid = emaMid[j]!;
    if (!Number.isFinite(mid)) return false;
    return signal.direction === "LONG" ? entry[j]!.close < mid : entry[j]!.close > mid;
  }

  return { id: "trendPullback", evaluate, isInvalidated };
}
