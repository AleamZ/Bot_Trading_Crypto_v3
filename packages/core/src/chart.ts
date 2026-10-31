import type { Analyzer } from "./analyzer.js";
import { advanceEpisode, type Episode } from "./consensus/index.js";
import { ema, highestBefore, lowestBefore } from "./indicators/moving.js";
import { alignHigherTimeframe, bearishFvgAt, bullishFvgAt, swings } from "./indicators/structure.js";
import type { Settings } from "./settings/schema.js";
import { dailyRanges } from "./strategies/boxTheory.js";
import type { MarketData } from "./strategies/types.js";
import { METHOD_IDS, type Direction, type MethodSignal } from "./types.js";

/** Times are the candle's openTime in ms (what charts put on the time axis). */
export interface ChartPoint {
  time: number;
  value: number;
}

export type OverlayGroup = "A" | "B" | "C" | "D";

export interface ChartLine {
  id: string;
  label: string;
  group: OverlayGroup;
  tone: "sky" | "coin" | "stone" | "ink" | "quest" | "heart";
  style: "solid" | "dashed" | "dotted";
  points: ChartPoint[];
}

export interface ChartSwing {
  time: number;
  kind: "high" | "low";
  price: number;
}

export interface ChartGap {
  /** openTime of the first candle of the gap and of the candle that filled it (or the last candle). */
  from: number;
  to: number;
  top: number;
  bottom: number;
  direction: Direction;
  filled: boolean;
}

/** Method D: yesterday's box drawn over one day of candles, with its buy and sell zones. */
export interface ChartBox {
  /** openTime of the first and last shown candle of the day. */
  from: number;
  to: number;
  top: number;
  bottom: number;
  /** Height of the buy (bottom) and sell (top) zones, in % of the box. */
  zonePct: number;
}

export interface ChartSignal extends MethodSignal {
  openTime: number;
}

export interface ChartEpisode {
  time: number;
  level: "READY" | "ENTER";
  direction: Direction;
}

export interface ChartOverlays {
  lines: ChartLine[];
  swings: ChartSwing[];
  fvgs: ChartGap[];
  boxes: ChartBox[];
  /** Every trigger of every enabled method on the shown candles. */
  signals: ChartSignal[];
  /** READY / ENTER moments, replayed the way the live bot sends them. */
  episodes: ChartEpisode[];
}

const MAX_GAPS = 12;
const GAP_MAX_CANDLES = 40;

/**
 * What the methods see, for drawing on a chart of entry candles [from, end]: the EMAs of method A
 * (the trend-timeframe ones stepped onto entry candles), the Donchian channel of method B, the
 * swings and fair value gaps of method C, every trigger and the 2/3-3/3 moments. Same parameters
 * and code as the live analysis.
 */
export function chartOverlays(market: MarketData, settings: Settings, analyzer: Analyzer, from: number): ChartOverlays {
  const { entry, trend } = market;
  const end = entry.length - 1;
  const start = Math.max(0, from);
  const time = (i: number) => entry[i]!.openTime;
  const points = (series: readonly number[]): ChartPoint[] => {
    const out: ChartPoint[] = [];
    for (let i = start; i <= end; i++) if (Number.isFinite(series[i])) out.push({ time: time(i), value: series[i]! });
    return out;
  };
  const m = settings.methods;
  const lines: ChartLine[] = [];

  if (m.trendPullback.enabled) {
    const closes = entry.map((c) => c.close);
    const trendCloses = trend.map((c) => c.close);
    const align = alignHigherTimeframe(entry, trend);
    const stepped = (series: readonly number[]) => align.map((t) => (t >= 0 ? series[t]! : Number.NaN));
    const tf = settings.general.trendTf;
    lines.push(
      { id: "emaFast", label: `EMA${m.trendPullback.emaFast}`, group: "A", tone: "sky", style: "solid", points: points(ema(closes, m.trendPullback.emaFast)) },
      { id: "emaMid", label: `EMA${m.trendPullback.emaMid}`, group: "A", tone: "coin", style: "solid", points: points(ema(closes, m.trendPullback.emaMid)) },
      {
        id: "trendMid",
        label: `EMA${m.trendPullback.emaMid} ${tf}`,
        group: "A",
        tone: "stone",
        style: "dashed",
        points: points(stepped(ema(trendCloses, m.trendPullback.emaMid))),
      },
      {
        id: "trendSlow",
        label: `EMA${m.trendPullback.emaSlow} ${tf}`,
        group: "A",
        tone: "ink",
        style: "dashed",
        points: points(stepped(ema(trendCloses, m.trendPullback.emaSlow))),
      },
    );
  }

  if (m.donchianBreakout.enabled) {
    const n = m.donchianBreakout.channelLength;
    const upper = highestBefore(entry.map((c) => c.high), n);
    const lower = lowestBefore(entry.map((c) => c.low), n);
    const mid = upper.map((u, i) => (u + lower[i]!) / 2);
    lines.push(
      { id: "donchianUpper", label: `Đỉnh kênh ${n}`, group: "B", tone: "quest", style: "dotted", points: points(upper) },
      { id: "donchianMid", label: `Giữa kênh ${n}`, group: "B", tone: "stone", style: "dotted", points: points(mid) },
      { id: "donchianLower", label: `Đáy kênh ${n}`, group: "B", tone: "heart", style: "dotted", points: points(lower) },
    );
  }

  const swingList: ChartSwing[] = [];
  const gaps: ChartGap[] = [];
  if (m.smcSweep.enabled) {
    const s = m.smcSweep.swingStrength;
    const flags = swings(entry, s);
    for (let k = start; k <= end - s; k++) {
      if (flags.isHigh[k]) swingList.push({ time: time(k), kind: "high", price: entry[k]!.high });
      if (flags.isLow[k]) swingList.push({ time: time(k), kind: "low", price: entry[k]!.low });
    }
    for (let f = Math.max(2, start + 2); f <= end; f++) {
      const atr = analyzer.atr[f]!;
      if (!Number.isFinite(atr)) continue;
      for (const direction of ["LONG", "SHORT"] as const) {
        const gap = direction === "LONG" ? bullishFvgAt(entry, f) : bearishFvgAt(entry, f);
        if (!gap || gap.top - gap.bottom < m.smcSweep.minFvgAtr * atr) continue;
        let close = Math.min(end, f + GAP_MAX_CANDLES);
        let filled = false;
        for (let k = f + 1; k <= Math.min(end, f + GAP_MAX_CANDLES); k++) {
          if (direction === "LONG" ? entry[k]!.low <= gap.bottom : entry[k]!.high >= gap.top) {
            close = k;
            filled = true;
            break;
          }
        }
        gaps.push({ from: time(f - 2), to: time(close), top: gap.top, bottom: gap.bottom, direction, filled });
      }
    }
  }

  const boxes: ChartBox[] = [];
  if (m.boxTheory.enabled) {
    const days = dailyRanges(trend);
    for (const [day, r] of dailyRanges(entry)) days.set(day, r);
    const dayMs = 86_400_000;
    const dayOf = (t: number) => Math.floor((t + 7 * 3_600_000) / dayMs) * dayMs - 7 * 3_600_000;
    for (let i = start; i <= end; i++) {
      const day = dayOf(time(i));
      const box = days.get(day - dayMs);
      if (!box) continue;
      const last = boxes.at(-1);
      if (last && dayOf(last.from) === day) last.to = time(i);
      else boxes.push({ from: time(i), to: time(i), top: box.top, bottom: box.bottom, zonePct: m.boxTheory.zonePct });
    }
  }

  const signals: ChartSignal[] = [];
  for (let i = start; i <= end; i++) {
    for (const id of METHOD_IDS) {
      const signal = analyzer.strategies[id]?.evaluate(i);
      if (signal) signals.push({ ...signal, openTime: time(i) });
    }
  }

  const episodes: ChartEpisode[] = [];
  let episode: Episode | null = null;
  for (let i = Math.max(0, start - 100); i <= end; i++) {
    const analysis = analyzer.at(i);
    const step = advanceEpisode(episode, analysis.consensus, analysis.time);
    episode = step.episode;
    if (step.emit && !step.retry && i >= start && analysis.consensus.direction) {
      episodes.push({ time: time(i), level: step.emit, direction: analysis.consensus.direction });
    }
  }

  return { lines, swings: swingList, fvgs: gaps.slice(-MAX_GAPS), boxes, signals, episodes };
}
