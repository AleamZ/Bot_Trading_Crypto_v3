import { bearishFvgAt, bullishFvgAt, swings, type Gap } from "../indicators/structure.js";
import type { SmcSweepParams } from "../settings/schema.js";
import type { Direction, MethodSignal } from "../types.js";
import type { MarketData, PreparedStrategy, SharedSeries } from "./types.js";

/**
 * C. SMC: liquidity sweep + market structure shift + FVG.
 * LONG: a candle w wicks below the latest confirmed swing low (first time it is taken) and closes
 * back above it; afterwards the trigger candle is the first to close above the latest swing high
 * that formed before w, and the move from w leaves a bullish FVG of at least `minFvgAtr` ATR.
 * SHORT is the mirror image.
 */
export function prepareSmcSweep(market: MarketData, p: SmcSweepParams, shared: SharedSeries): PreparedStrategy {
  const { entry } = market;
  const s = p.swingStrength;
  const flags = swings(entry, s);

  /** Latest k in [from, to] (walking down) with flag[k] set, or -1. */
  function latestSwing(flag: readonly boolean[], to: number, from: number): number {
    for (let k = to; k >= Math.max(0, from); k--) if (flag[k]) return k;
    return -1;
  }

  function trySetup(direction: Direction, w: number, i: number): MethodSignal | null {
    const long = direction === "LONG";
    const sweep = entry[w]!;
    const c = entry[i]!;
    const atr = shared.atr[i]!;
    if (!Number.isFinite(atr) || atr <= 0) return null;

    // The swept swing must be confirmed by candle w - 1 (k + s <= w - 1).
    const k = latestSwing(long ? flags.isLow : flags.isHigh, w - s - 1, w - p.swingMaxAge);
    if (k < 0) return null;
    const swept = long ? entry[k]!.low : entry[k]!.high;
    const sweptNow = long ? sweep.low < swept && sweep.close > swept : sweep.high > swept && sweep.close < swept;
    if (!sweptNow) return null;
    for (let m = k + 1; m < w; m++) {
      if (long ? entry[m]!.low < swept : entry[m]!.high > swept) return null;
    }

    // Structure level: latest swing of the other kind before w, confirmed before the trigger candle.
    const h = latestSwing(long ? flags.isHigh : flags.isLow, Math.min(w - 1, i - s - 1), w - p.swingMaxAge);
    if (h < 0) return null;
    const level = long ? entry[h]!.high : entry[h]!.low;
    if (long ? !(c.close > level) : !(c.close < level)) return null;
    for (let m = w; m < i; m++) {
      if (long ? entry[m]!.close > level : entry[m]!.close < level) return null;
    }

    let gap: Gap | null = null;
    for (let f = i; f >= w + 2 && !gap; f--) {
      const candidate = long ? bullishFvgAt(entry, f) : bearishFvgAt(entry, f);
      if (candidate && candidate.top - candidate.bottom >= p.minFvgAtr * atr) gap = candidate;
    }
    if (!gap) return null;
    const distance = long ? c.close - gap.top : gap.bottom - c.close;
    if (distance > p.maxDistanceFromFvgAtr * atr) return null;

    const sweepExtreme = long ? sweep.low : sweep.high;
    const stopLoss = long ? sweepExtreme - p.slAtrBuffer * atr : sweepExtreme + p.slAtrBuffer * atr;
    if (long ? !(stopLoss < c.close) : !(stopLoss > c.close)) return null;

    return {
      method: "smcSweep",
      direction,
      index: i,
      time: c.closeTime,
      price: c.close,
      stopLoss,
      reason: long
        ? `Quét đáy ${swept}, đóng cửa phá đỉnh ${level}, FVG ${gap.bottom}–${gap.top}`
        : `Quét đỉnh ${swept}, đóng cửa phá đáy ${level}, FVG ${gap.bottom}–${gap.top}`,
      levels: { swept, sweepExtreme, structure: level, fvgTop: gap.top, fvgBottom: gap.bottom },
    };
  }

  function evaluate(i: number): MethodSignal | null {
    for (let w = i - 1; w >= Math.max(0, i - p.sweepLookback); w--) {
      const signal = trySetup("LONG", w, i) ?? trySetup("SHORT", w, i);
      if (signal) return signal;
    }
    return null;
  }

  function isInvalidated(signal: MethodSignal, j: number): boolean {
    const extreme = signal.levels.sweepExtreme;
    if (extreme === undefined) return false;
    return signal.direction === "LONG" ? entry[j]!.low <= extreme : entry[j]!.high >= extreme;
  }

  return { id: "smcSweep", evaluate, isInvalidated };
}
