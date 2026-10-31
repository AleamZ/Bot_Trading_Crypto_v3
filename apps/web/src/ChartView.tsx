import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { ZonesPrimitive, type Zone } from "./chartZones";
import type { ChartResponse, Tone } from "./types";
import { METHODS } from "./types";

export interface Layers {
  ema: boolean;
  donchian: boolean;
  smc: boolean;
  box: boolean;
  signals: boolean;
  episodes: boolean;
  trades: boolean;
  volume: boolean;
}

export const DEFAULT_LAYERS: Layers = { ema: true, donchian: true, smc: true, box: true, signals: true, episodes: true, trades: true, volume: true };

/** The chart shows Vietnam time: lightweight-charts draws UTC, so times are shifted by 7 hours. */
const VN = 7 * 3_600_000;
const t = (ms: number) => ((ms + VN) / 1000) as UTCTimestamp;

const LETTER = Object.fromEntries(METHODS.map((m) => [m.id, m.letter]));

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

function palette() {
  const tone: Record<Tone, string> = {
    sky: cssVar("--sky"),
    coin: cssVar("--coin"),
    stone: cssVar("--stone"),
    ink: cssVar("--text"),
    quest: cssVar("--quest"),
    heart: cssVar("--heart"),
  };
  return { tone, panel: cssVar("--panel"), text: cssVar("--text"), soft: cssVar("--text-soft"), grid: cssVar("--well"), line: cssVar("--line") };
}

/** Decimals that fit the symbol's prices. */
function precisionOf(price: number): number {
  if (price >= 1000) return 1;
  if (price >= 10) return 2;
  if (price >= 1) return 4;
  return 5;
}

const STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted } as const;

/** Changes whenever the page switches between light and dark, so colours are read again. */
function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", bump);
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      media.removeEventListener("change", bump);
      observer.disconnect();
    };
  }, []);
  return tick;
}

/**
 * Candles with what the bot looks at: method A's EMAs, method B's Donchian channel, method C's
 * swings and fair value gaps, every trigger (A/B/C), the 2/3 and 3/3 moments, the bot's trades with
 * their TP/SL zones and stop moves, and the zones an entry would get now.
 */
export function ChartView({ data, layers, zoneOpacity }: { data: ChartResponse; layers: Layers; zoneOpacity: number }) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const themeTick = useThemeTick();

  useEffect(() => {
    if (!host.current || data.candles.length === 0) return;
    const c = palette();
    const last = data.candles.at(-1)!;
    const precision = precisionOf(last.close);
    const chart = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: c.panel },
        textColor: c.text,
        fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
        fontSize: 11,
      },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.line },
      timeScale: { borderColor: c.line, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    chartRef.current = chart;
    const priceFormat = { type: "price" as const, precision, minMove: 10 ** -precision };

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: c.tone.quest,
      downColor: c.tone.heart,
      borderUpColor: c.tone.quest,
      borderDownColor: c.tone.heart,
      wickUpColor: c.tone.quest,
      wickDownColor: c.tone.heart,
      priceFormat,
    });
    candles.setData(data.candles.map((k) => ({ time: t(k.openTime), open: k.open, high: k.high, low: k.low, close: k.close })));

    if (layers.volume) {
      const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "", lastValueVisible: false, priceLineVisible: false });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
      volume.setData(data.candles.map((k) => ({ time: t(k.openTime), value: k.volume, color: `${k.close >= k.open ? c.tone.quest : c.tone.heart}55` })));
    }

    const showGroup = { A: layers.ema, B: layers.donchian, C: layers.smc, D: layers.box };
    for (const line of data.overlays.lines) {
      if (!showGroup[line.group]) continue;
      const series = chart.addSeries(LineSeries, {
        color: c.tone[line.tone],
        lineWidth: line.style === "solid" ? 2 : 1,
        lineStyle: STYLE[line.style],
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        title: line.label,
        priceFormat,
      });
      series.setData(line.points.map((p) => ({ time: t(p.time), value: p.value })));
    }

    // Shaded boxes under the candles: FVGs, TP (green) / SL (red) of trades and of the entry now.
    const zones: Zone[] = [];
    const indexOf = new Map(data.candles.map((k, i) => [k.openTime, i]));
    const lastIndex = data.candles.length - 1;
    const tf = (data.candles[1]?.openTime ?? 0) - (data.candles[0]?.openTime ?? 0) || 900_000;
    const bar = (ms: number) => Math.floor(ms / tf) * tf;
    if (layers.smc) {
      for (const gap of data.overlays.fvgs) {
        const from = indexOf.get(gap.from);
        if (from === undefined) continue;
        const to = indexOf.get(gap.to) ?? lastIndex;
        const color = gap.direction === "LONG" ? c.tone.quest : c.tone.heart;
        zones.push({ from, to, top: gap.top, bottom: gap.bottom, color, alpha: gap.filled ? 0.12 : 0.3, outline: !gap.filled, label: gap.filled ? undefined : "FVG" });
      }
    }
    if (layers.box) {
      for (const box of data.overlays.boxes) {
        const from = indexOf.get(box.from);
        if (from === undefined) continue;
        const to = indexOf.get(box.to) ?? lastIndex;
        const zone = ((box.top - box.bottom) * box.zonePct) / 100;
        zones.push({ from, to, top: box.top, bottom: box.bottom, color: c.tone.stone, alpha: 0.05, outline: true, label: "Hộp" });
        zones.push({ from, to, top: box.bottom + zone, bottom: box.bottom, color: c.tone.quest, alpha: 0.16 });
        zones.push({ from, to, top: box.top, bottom: box.top - zone, color: c.tone.heart, alpha: 0.16 });
      }
    }
    if (layers.trades) {
      for (const trade of data.trades) {
        const from = trade.openedAt === null ? undefined : indexOf.get(bar(trade.openedAt));
        if (from === undefined || !trade.entryPrice || !trade.stopLoss || !trade.takeProfit) continue;
        const open = trade.status === "OPEN" || trade.status === "OPENING";
        const to = open ? lastIndex : (indexOf.get(bar(trade.closedAt ?? 0)) ?? lastIndex);
        const entryPrice = Number(trade.entryPrice);
        // The red zone is the risk taken at the entry: the stop before any move.
        const firstStop = Number(trade.slMoves?.[0]?.from ?? trade.stopLoss);
        zones.push({ from, to, top: Number(trade.takeProfit), bottom: entryPrice, color: c.tone.quest, alpha: zoneOpacity, label: "TP" });
        zones.push({ from, to, top: entryPrice, bottom: firstStop, color: c.tone.heart, alpha: zoneOpacity, label: "SL" });
        for (const move of trade.slMoves ?? []) {
          const at = indexOf.get(bar(move.at)) ?? from;
          zones.push({ from: at, to, top: Number(move.to), bottom: Number(move.to), color: c.tone.sky, alpha: 1, line: true, label: move.stage === 1 ? "SL hoà vốn" : "SL khoá lãi" });
        }
      }
    }
    const preview = data.preview;
    if (preview?.sizing) {
      const entryNow = preview.entryPrice;
      zones.push({ from: lastIndex + 1, to: lastIndex + 8, top: Number(preview.sizing.takeProfit), bottom: entryNow, color: c.tone.quest, alpha: zoneOpacity, label: "TP" });
      zones.push({ from: lastIndex + 1, to: lastIndex + 8, top: entryNow, bottom: Number(preview.sizing.stopLoss), color: c.tone.heart, alpha: zoneOpacity, label: "SL" });
    }
    candles.attachPrimitive(new ZonesPrimitive(zones, c.text));

    const markers: SeriesMarker<Time>[] = [];
    if (layers.smc) {
      for (const s of data.overlays.swings) {
        markers.push({ time: t(s.time), position: s.kind === "high" ? "aboveBar" : "belowBar", color: c.soft, shape: "circle", size: 0.4 });
      }
    }
    if (layers.signals) {
      for (const s of data.overlays.signals) {
        const long = s.direction === "LONG";
        markers.push({
          time: t(s.openTime),
          position: long ? "belowBar" : "aboveBar",
          color: long ? c.tone.quest : c.tone.heart,
          shape: long ? "arrowUp" : "arrowDown",
          text: LETTER[s.method],
          size: 1.6,
        });
      }
    }
    if (layers.episodes) {
      for (const e of data.overlays.episodes) {
        markers.push({
          time: t(e.time),
          position: e.direction === "LONG" ? "belowBar" : "aboveBar",
          color: e.level === "ENTER" ? c.tone.sky : c.tone.coin,
          shape: e.level === "ENTER" ? "square" : "circle",
          text: e.level === "ENTER" ? "Vào" : "Báo",
          size: 1.6,
        });
      }
    }
    if (layers.trades) {
      const first = data.candles[0]!.openTime;
      for (const trade of data.trades) {
        if (!trade.openedAt || trade.openedAt < first) continue;
        const long = trade.direction === "LONG";
        markers.push({ time: t(bar(trade.openedAt)), position: long ? "belowBar" : "aboveBar", color: c.tone.sky, shape: long ? "arrowUp" : "arrowDown", text: "Vào", size: 1.8 });
        if (trade.closedAt && trade.exitReason) {
          markers.push({
            time: t(Math.min(bar(trade.closedAt), last.openTime)),
            position: long ? "aboveBar" : "belowBar",
            color: trade.exitReason === "TP" ? c.tone.quest : trade.exitReason === "SL" ? c.tone.heart : c.soft,
            shape: "square",
            text: trade.exitReason,
            size: 1.8,
          });
        }
        if (trade.status === "OPEN" || trade.status === "OPENING") {
          const lines: [string | null, string, string][] = [
            [trade.entryPrice, c.tone.sky, "Vào"],
            [trade.stopLoss, c.tone.heart, "SL"],
            [trade.takeProfit, c.tone.quest, "TP"],
          ];
          for (const [price, color, title] of lines) {
            if (price) candles.createPriceLine({ price: Number(price), color, lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title });
          }
        }
      }
    }
    if (preview?.sizing) {
      candles.createPriceLine({ price: Number(preview.sizing.stopLoss), color: c.tone.heart, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "SL dự kiến" });
      candles.createPriceLine({ price: Number(preview.sizing.takeProfit), color: c.tone.quest, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "TP dự kiến" });
    }
    markers.sort((a, b) => Number(a.time) - Number(b.time));
    createSeriesMarkers(candles, markers);

    // Room on the right for the zones of the entry the bot would make now.
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.candles.length - 160), to: data.candles.length + (preview?.sizing ? 10 : 4) });
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [data, layers, zoneOpacity, themeTick]);

  return <div ref={host} className="chart-host" role="img" aria-label={`Biểu đồ ${data.symbol} ${data.timeframe}`} />;
}
