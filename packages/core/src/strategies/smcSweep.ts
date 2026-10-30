import { bearishFvgAt, bullishFvgAt, swings, type Gap } from "../indicators/structure.js";
import type { SmcSweepParams } from "../settings/schema.js";
import type { Direction, MethodSignal } from "../types.js";
import { fmt, side, type Check, type MarketData, type PreparedStrategy, type SharedSeries, type SideExplanation, type StrategyExplanation } from "./types.js";

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

  function stepLabels(long: boolean): string[] {
    return [
      `Có swing ${long ? "đáy" : "đỉnh"} đã xác nhận trong ${p.swingMaxAge} nến`,
      `Nến quét ${long ? "thủng đáy" : "vượt đỉnh"} swing rồi đóng cửa ${long ? "trên" : "dưới"} lại (lần đầu, trong ${p.sweepLookback} nến)`,
      `Đóng cửa phá ${long ? "đỉnh" : "đáy"} cấu trúc lần đầu`,
      `Có FVG ${long ? "tăng" : "giảm"} ≥ ${p.minFvgAtr} ATR trong nhịp`,
      `Giá cách FVG ≤ ${p.maxDistanceFromFvgAtr} ATR`,
      `SL (${long ? "đáy" : "đỉnh"} cú quét ${long ? "−" : "+"} ${p.slAtrBuffer} ATR) nằm ${long ? "dưới" : "trên"} giá`,
    ];
  }

  /**
   * The setup with the sweep at candle w and the trigger at i. When `steps` is given, each step
   * is recorded with its values; the walk stops at the first step that fails, as evaluate() does.
   */
  function attempt(direction: Direction, w: number, i: number, steps?: Check[]): MethodSignal | null {
    const long = direction === "LONG";
    const labels = steps ? stepLabels(long) : null;
    let n = 0;
    const step = (pass: boolean, detail: () => string | null): boolean => {
      if (steps && labels) steps.push({ label: labels[n]!, pass, detail: detail() });
      n++;
      return pass;
    };
    const sweep = entry[w]!;
    const c = entry[i]!;
    const atr = shared.atr[i]!;
    if (!Number.isFinite(atr) || atr <= 0) return null;

    // The swept swing must be confirmed by candle w - 1 (k + s <= w - 1).
    const k = latestSwing(long ? flags.isLow : flags.isHigh, w - s - 1, w - p.swingMaxAge);
    if (!step(k >= 0, () => (k >= 0 ? fmt(long ? entry[k]!.low : entry[k]!.high) : "không có"))) return null;
    const swept = long ? entry[k]!.low : entry[k]!.high;
    let sweptNow = long ? sweep.low < swept && sweep.close > swept : sweep.high > swept && sweep.close < swept;
    for (let m = k + 1; m < w && sweptNow; m++) {
      if (long ? entry[m]!.low < swept : entry[m]!.high > swept) sweptNow = false;
    }
    if (!step(sweptNow, () => `${long ? "low" : "high"} ${fmt(long ? sweep.low : sweep.high)} / swing ${fmt(swept)}`)) return null;

    // Structure level: latest swing of the other kind before w, confirmed before the trigger candle.
    const h = latestSwing(long ? flags.isHigh : flags.isLow, Math.min(w - 1, i - s - 1), w - p.swingMaxAge);
    const level = h >= 0 ? (long ? entry[h]!.high : entry[h]!.low) : Number.NaN;
    let broke = h >= 0 && (long ? c.close > level : c.close < level);
    for (let m = w; m < i && broke; m++) {
      if (long ? entry[m]!.close > level : entry[m]!.close < level) broke = false;
    }
    if (!step(broke, () => (h >= 0 ? `đóng ${fmt(c.close)} / mức ${fmt(level)}` : "không có swing"))) return null;

    let gap: Gap | null = null;
    for (let f = i; f >= w + 2 && !gap; f--) {
      const candidate = long ? bullishFvgAt(entry, f) : bearishFvgAt(entry, f);
      if (candidate && candidate.top - candidate.bottom >= p.minFvgAtr * atr) gap = candidate;
    }
    if (!step(gap !== null, () => (gap ? `${fmt(gap.bottom)}–${fmt(gap.top)}` : null))) return null;
    const fvg = gap!;
    const distance = long ? c.close - fvg.top : fvg.bottom - c.close;
    if (!step(distance <= p.maxDistanceFromFvgAtr * atr, () => `${(distance / atr).toFixed(2)} ATR`)) return null;

    const sweepExtreme = long ? sweep.low : sweep.high;
    const stopLoss = long ? sweepExtreme - p.slAtrBuffer * atr : sweepExtreme + p.slAtrBuffer * atr;
    if (!step(long ? stopLoss < c.close : stopLoss > c.close, () => fmt(stopLoss))) return null;

    return {
      method: "smcSweep",
      direction,
      index: i,
      time: c.closeTime,
      price: c.close,
      stopLoss,
      reason: long
        ? `Quét đáy ${swept}, đóng cửa phá đỉnh ${level}, FVG ${fvg.bottom}–${fvg.top}`
        : `Quét đỉnh ${swept}, đóng cửa phá đáy ${level}, FVG ${fvg.bottom}–${fvg.top}`,
      levels: { swept, sweepExtreme, structure: level, fvgTop: fvg.top, fvgBottom: fvg.bottom },
    };
  }

  function evaluate(i: number): MethodSignal | null {
    for (let w = i - 1; w >= Math.max(0, i - p.sweepLookback); w--) {
      const signal = attempt("LONG", w, i) ?? attempt("SHORT", w, i);
      if (signal) return signal;
    }
    return null;
  }

  function isInvalidated(signal: MethodSignal, j: number): boolean {
    const extreme = signal.levels.sweepExtreme;
    if (extreme === undefined) return false;
    return signal.direction === "LONG" ? entry[j]!.low <= extreme : entry[j]!.high >= extreme;
  }

  /** The candidate sweep (within the lookback) that got furthest through the steps. */
  function explainSide(direction: Direction, i: number): SideExplanation {
    let best: Check[] = [];
    for (let w = i - 1; w >= Math.max(0, i - p.sweepLookback); w--) {
      const steps: Check[] = [];
      attempt(direction, w, i, steps);
      if (steps.filter((c) => c.pass).length > best.filter((c) => c.pass).length) best = steps;
      if (best.length === 0 && steps.length > 0) best = steps;
    }
    const labels = stepLabels(direction === "LONG");
    return side(
      direction,
      labels.map((label, n) => best[n] ?? { label, pass: null, detail: null }),
    );
  }

  function explain(i: number): StrategyExplanation {
    return { method: "smcSweep", sides: [explainSide("LONG", i), explainSide("SHORT", i)] };
  }

  return { id: "smcSweep", evaluate, isInvalidated, explain };
}
