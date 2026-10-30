import { highestBefore, lowestBefore, sma } from "../indicators/moving.js";
import { adx } from "../indicators/oscillators.js";
import type { DonchianBreakoutParams } from "../settings/schema.js";
import type { Direction, MethodSignal } from "../types.js";
import { fmt, isFiniteAll, side, type Check, type MarketData, type PreparedStrategy, type SharedSeries, type SideExplanation, type StrategyExplanation } from "./types.js";

/**
 * B. Donchian channel breakout with volume and ADX.
 * The trigger candle closes beyond the extreme of the previous `channelLength` candles, on volume of
 * at least `volumeMultiplier` times the previous average, with ADX above `adxMin`, a solid body
 * that closes near its extreme, and without having run more than `maxChaseAtr` ATR past the channel.
 */
export function prepareDonchianBreakout(market: MarketData, p: DonchianBreakoutParams, shared: SharedSeries): PreparedStrategy {
  const { entry } = market;
  const upper = highestBefore(entry.map((c) => c.high), p.channelLength);
  const lower = lowestBefore(entry.map((c) => c.low), p.channelLength);
  const volumeAverage = sma(entry.map((c) => c.volume), p.volumeSmaLength);
  const adxSeries = adx(entry, p.adxPeriod).adx;

  function evaluate(i: number): MethodSignal | null {
    if (i < 1) return null;
    const c = entry[i]!;
    const up = upper[i]!;
    const low = lower[i]!;
    // Average of the candles before the breakout, so the breakout volume is not part of it.
    const avgVolume = volumeAverage[i - 1]!;
    const adxValue = adxSeries[i]!;
    const atr = shared.atr[i]!;
    if (!isFiniteAll(up, low, avgVolume, adxValue, atr)) return null;
    const range = c.high - c.low;
    if (range <= 0 || avgVolume <= 0) return null;
    if (c.volume < p.volumeMultiplier * avgVolume) return null;
    if (adxValue < p.adxMin) return null;
    if (Math.abs(c.close - c.open) < p.minBodyRatio * range) return null;

    const mid = (up + low) / 2;
    const levels = { upper: up, lower: low, mid, adx: adxValue };
    const volumeRatio = (c.volume / avgVolume).toFixed(1);

    if (c.close > up && c.close > c.open && c.close >= c.high - p.closeZoneRatio * range && c.close - up <= p.maxChaseAtr * atr) {
      return {
        method: "donchianBreakout",
        direction: "LONG",
        index: i,
        time: c.closeTime,
        price: c.close,
        stopLoss: c.close - p.slAtrMultiplier * atr,
        reason: `Đóng cửa trên đỉnh ${p.channelLength} nến, volume ×${volumeRatio}, ADX ${adxValue.toFixed(1)}`,
        levels,
      };
    }
    if (c.close < low && c.close < c.open && c.close <= c.low + p.closeZoneRatio * range && low - c.close <= p.maxChaseAtr * atr) {
      return {
        method: "donchianBreakout",
        direction: "SHORT",
        index: i,
        time: c.closeTime,
        price: c.close,
        stopLoss: c.close + p.slAtrMultiplier * atr,
        reason: `Đóng cửa dưới đáy ${p.channelLength} nến, volume ×${volumeRatio}, ADX ${adxValue.toFixed(1)}`,
        levels,
      };
    }
    return null;
  }

  function isInvalidated(signal: MethodSignal, j: number): boolean {
    const mid = signal.levels.mid;
    if (mid === undefined) return false;
    return signal.direction === "LONG" ? entry[j]!.close < mid : entry[j]!.close > mid;
  }

  /** The same conditions as evaluate(), each one reported instead of returning at the first miss. */
  function explainSide(direction: Direction, i: number): SideExplanation {
    const long = direction === "LONG";
    const c = entry[i];
    const up = upper[i] ?? Number.NaN;
    const low = lower[i] ?? Number.NaN;
    const avgVolume = volumeAverage[i - 1] ?? Number.NaN;
    const adxValue = adxSeries[i] ?? Number.NaN;
    const atr = shared.atr[i] ?? Number.NaN;
    const range = c ? c.high - c.low : 0;
    const ok = i >= 1 && c !== undefined && isFiniteAll(up, low, avgVolume, adxValue, atr) && range > 0 && avgVolume > 0;
    const edge = long ? up : low;
    const when = (pass: () => boolean) => (ok ? pass() : null);
    const checks: Check[] = [
      {
        label: `Đóng cửa ${long ? "trên đỉnh" : "dưới đáy"} kênh ${p.channelLength} nến`,
        pass: when(() => (long ? c!.close > up : c!.close < low)),
        detail: ok ? `${fmt(c!.close)} / ${fmt(edge)}` : null,
      },
      {
        label: `Volume ≥ ${p.volumeMultiplier}× trung bình ${p.volumeSmaLength} nến`,
        pass: when(() => c!.volume >= p.volumeMultiplier * avgVolume),
        detail: ok ? `×${(c!.volume / avgVolume).toFixed(2)}` : null,
      },
      { label: `ADX ≥ ${p.adxMin}`, pass: when(() => adxValue >= p.adxMin), detail: ok ? adxValue.toFixed(1) : null },
      {
        label: `Thân nến ≥ ${Math.round(p.minBodyRatio * 100)}% biên độ`,
        pass: when(() => Math.abs(c!.close - c!.open) >= p.minBodyRatio * range),
        detail: ok ? `${Math.round((Math.abs(c!.close - c!.open) / range) * 100)}%` : null,
      },
      {
        label: `Nến ${long ? "tăng" : "giảm"}, đóng cửa trong ${Math.round(p.closeZoneRatio * 100)}% ${long ? "trên" : "dưới"} cùng`,
        pass: when(() => (long ? c!.close > c!.open && c!.close >= c!.high - p.closeZoneRatio * range : c!.close < c!.open && c!.close <= c!.low + p.closeZoneRatio * range)),
        detail: null,
      },
      {
        label: `Cách kênh ≤ ${p.maxChaseAtr} ATR (không đuổi giá)`,
        pass: when(() => (long ? c!.close - up : low - c!.close) <= p.maxChaseAtr * atr),
        detail: ok ? `${((long ? c!.close - up : low - c!.close) / atr).toFixed(2)} ATR` : null,
      },
    ];
    return side(direction, checks);
  }

  function explain(i: number): StrategyExplanation {
    return { method: "donchianBreakout", sides: [explainSide("LONG", i), explainSide("SHORT", i)] };
  }

  return { id: "donchianBreakout", evaluate, isInvalidated, explain };
}
