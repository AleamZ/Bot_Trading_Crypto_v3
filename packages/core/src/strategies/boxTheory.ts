import { TRADING_DAY_OFFSET_MINUTES } from "../risk/guards.js";
import type { BoxTheoryParams } from "../settings/schema.js";
import type { Candle, Direction, MethodSignal } from "../types.js";
import { fmt, side, type Check, type MarketData, type PreparedStrategy, type SharedSeries, type SideExplanation, type StrategyExplanation } from "./types.js";

const DAY_MS = 86_400_000;
const OFFSET_MS = TRADING_DAY_OFFSET_MINUTES * 60_000;

export interface Box {
  /** Start (ms) of the Vietnam day the box comes from. */
  day: number;
  top: number;
  bottom: number;
}

const dayOf = (time: number) => Math.floor((time + OFFSET_MS) / DAY_MS) * DAY_MS - OFFSET_MS;

/**
 * High and low of every Vietnam day the candles cover completely. A candle interval that does not
 * divide the day at 00:00 Vietnam time (4h candles start at 07:00) cannot give a whole day.
 */
export function dailyRanges(candles: readonly Candle[]): Map<number, { top: number; bottom: number }> {
  const out = new Map<number, { top: number; bottom: number; count: number }>();
  if (candles.length === 0) return new Map();
  const interval = candles[0]!.closeTime - candles[0]!.openTime + 1;
  if (interval <= 0 || DAY_MS % interval !== 0 || OFFSET_MS % interval !== 0) return new Map();
  for (const c of candles) {
    const day = dayOf(c.openTime);
    const range = out.get(day) ?? { top: -Infinity, bottom: Infinity, count: 0 };
    range.top = Math.max(range.top, c.high);
    range.bottom = Math.min(range.bottom, c.low);
    range.count++;
    out.set(day, range);
  }
  const complete = new Map<number, { top: number; bottom: number }>();
  for (const [day, r] of out) if (r.count === DAY_MS / interval) complete.set(day, { top: r.top, bottom: r.bottom });
  return complete;
}

/**
 * D. Box theory: the box is yesterday's high and low (Vietnam day). Buy when a candle dips into the
 * bottom `zonePct`% of the box and closes back up as a rejection candle; sell the mirror at the top.
 * No trade in the middle or outside the box. The stop goes just outside the box.
 */
export function prepareBoxTheory(market: MarketData, p: BoxTheoryParams, shared: SharedSeries): PreparedStrategy {
  const { entry } = market;
  // Whole days from the entry candles, and from the trend candles for days the entry candles only partly cover.
  const days = dailyRanges(market.trend);
  for (const [day, r] of dailyRanges(entry)) days.set(day, r);

  function boxAt(i: number): Box | null {
    const c = entry[i];
    if (!c) return null;
    const day = dayOf(c.openTime) - DAY_MS;
    const r = days.get(day);
    return r ? { day, top: r.top, bottom: r.bottom } : null;
  }

  interface Setup {
    box: Box;
    height: number;
    zone: number;
    atr: number;
    c: Candle;
    range: number;
  }

  function setupAt(i: number): Setup | null {
    const box = boxAt(i);
    const atr = shared.atr[i];
    const c = entry[i];
    if (!box || !c || atr === undefined || !Number.isFinite(atr) || atr <= 0) return null;
    const height = box.top - box.bottom;
    return { box, height, zone: (height * p.zonePct) / 100, atr, c, range: c.high - c.low };
  }

  function checksFor(direction: Direction, s: Setup | null): Check[] {
    const long = direction === "LONG";
    const when = (pass: (s: Setup) => boolean) => (s ? pass(s) : null);
    const edge = s ? (long ? s.box.bottom : s.box.top) : Number.NaN;
    const fromEdge = (x: number) => (s ? (long ? x - s.box.bottom : s.box.top - x) : Number.NaN);
    return [
      {
        label: "Có hộp của ngày hôm trước (giờ Việt Nam)",
        pass: s ? true : null,
        detail: s ? `${fmt(s.box.bottom)} – ${fmt(s.box.top)}` : "chưa đủ nến của ngày hôm trước",
      },
      {
        label: `Hộp cao ≥ ${p.minBoxAtr} ATR`,
        pass: when((s) => s.height >= p.minBoxAtr * s.atr),
        detail: s ? `${(s.height / s.atr).toFixed(1)} ATR` : null,
      },
      {
        label: `Nến chạm vùng ${long ? "mua" : "bán"} (${p.zonePct}% ${long ? "dưới" : "trên"} cùng của hộp)`,
        pass: when((s) => (long ? s.c.low <= s.box.bottom + s.zone : s.c.high >= s.box.top - s.zone)),
        detail: s ? `${long ? "đáy nến" : "đỉnh nến"} ${fmt(long ? s.c.low : s.c.high)}, vùng tới ${fmt(long ? s.box.bottom + s.zone : s.box.top - s.zone)}` : null,
      },
      {
        label: `Đóng cửa trong hộp, ${long ? "trên đáy" : "dưới đỉnh"} hộp`,
        pass: when((s) => (long ? s.c.close > s.box.bottom && s.c.close < s.box.top : s.c.close < s.box.top && s.c.close > s.box.bottom)),
        detail: s ? `${fmt(s.c.close)} / ${fmt(edge)}` : null,
      },
      {
        label: `Nến ${long ? "tăng" : "giảm"} từ chối: đóng cửa cách ${long ? "đáy" : "đỉnh"} nến ≥ ${Math.round(p.rejectRatio * 100)}% biên độ`,
        pass: when((s) => s.range > 0 && (long ? s.c.close > s.c.open && s.c.close - s.c.low >= p.rejectRatio * s.range : s.c.close < s.c.open && s.c.high - s.c.close >= p.rejectRatio * s.range)),
        detail: s && s.range > 0 ? `nến ${s.c.close > s.c.open ? "tăng" : s.c.close < s.c.open ? "giảm" : "ngang"}, ${Math.round(((long ? s.c.close - s.c.low : s.c.high - s.c.close) / s.range) * 100)}%` : null,
      },
      {
        label: `Giá vào còn trong ${p.maxEntryPct}% gần ${long ? "đáy" : "đỉnh"} hộp (không vào ở giữa hộp)`,
        pass: when((s) => fromEdge(s.c.close) <= (s.height * p.maxEntryPct) / 100),
        detail: s && s.height > 0 ? `${Math.round((fromEdge(s.c.close) / s.height) * 100)}%` : null,
      },
    ];
  }

  function evaluate(i: number): MethodSignal | null {
    const s = setupAt(i);
    if (!s) return null;
    for (const direction of ["LONG", "SHORT"] as const) {
      if (!checksFor(direction, s).every((check) => check.pass === true)) continue;
      const long = direction === "LONG";
      const stopLoss = long ? Math.min(s.c.low, s.box.bottom) - p.slBufferAtr * s.atr : Math.max(s.c.high, s.box.top) + p.slBufferAtr * s.atr;
      const mid = (s.box.top + s.box.bottom) / 2;
      return {
        method: "boxTheory",
        direction,
        index: i,
        time: s.c.closeTime,
        price: s.c.close,
        stopLoss,
        reason: `${long ? "Từ chối ở đáy" : "Từ chối ở đỉnh"} hộp hôm trước ${fmt(s.box.bottom)} – ${fmt(s.box.top)}, giữa hộp ${fmt(mid)}`,
        levels: { top: s.box.top, bottom: s.box.bottom, mid, day: s.box.day },
      };
    }
    return null;
  }

  /** Gone once price closes out of the box on the wrong side, or reaches the middle (the trade's first target). */
  function isInvalidated(signal: MethodSignal, j: number): boolean {
    const { top, bottom, mid } = signal.levels;
    if (top === undefined || bottom === undefined || mid === undefined) return false;
    const close = entry[j]!.close;
    return signal.direction === "LONG" ? close < bottom || close >= mid : close > top || close <= mid;
  }

  function explainSide(direction: Direction, i: number): SideExplanation {
    return side(direction, checksFor(direction, setupAt(i)));
  }

  function explain(i: number): StrategyExplanation {
    return { method: "boxTheory", sides: [explainSide("LONG", i), explainSide("SHORT", i)] };
  }

  return { id: "boxTheory", evaluate, isInvalidated, explain };
}
