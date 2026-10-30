import { describe, expect, it } from "vitest";
import type { SymbolAnalysis } from "../src/analyzer.js";
import { methodsKey, runBacktest, signalSequence, summarize, type BacktestSymbol, type BacktestTrade } from "../src/backtest.js";
import { decideConsensus } from "../src/consensus/index.js";
import type { SymbolFilters } from "../src/risk/filters.js";
import { defaultSettings, mergeSettings } from "../src/settings/index.js";
import { METHOD_IDS, type Candle, type Direction, type MethodId, type MethodSignal } from "../src/types.js";
import { candles, randomWalk, type Row } from "./helpers.js";

const FILTERS: SymbolFilters = { symbol: "XUSDT", tickSize: "0.01", stepSize: "0.1", minQty: "0.1", maxQty: null, minNotional: "5" };

function settingsWith(patch: unknown = {}) {
  const merged = mergeSettings(defaultSettings(), patch);
  if (!merged.ok) throw new Error(JSON.stringify(merged.errors));
  return merged.settings;
}

const signal = (method: MethodSignal["method"], direction: Direction, stopLoss: number): MethodSignal => ({
  method,
  direction,
  index: 0,
  time: 0,
  price: 100,
  stopLoss,
  reason: "test",
  levels: {},
});

const THREE_LONG = METHOD_IDS.map((m) => signal(m, "LONG", 98.5));
const TWO_LONG = THREE_LONG.slice(0, 2);
const THREE_SHORT = METHOD_IDS.map((m) => signal(m, "SHORT", 101.5));

/** Flat candles around 100 with a few rows replaced. */
function series(count: number, overrides: Record<number, Row> = {}): Candle[] {
  const rows: Row[] = Array.from({ length: count }, (_, i) => overrides[i] ?? [100, 100.2, 99.8, 100]);
  return candles(rows);
}

/** Analyzer stand-in: `script[i]` are the active signals at candle i. */
function scripted(script: Record<number, MethodSignal[]>, general = defaultSettings().general) {
  return (market: { entry: readonly Candle[] }) => ({
    at(i: number): SymbolAnalysis {
      const signals = script[i] ?? [];
      const methods = {} as SymbolAnalysis["methods"];
      for (const id of METHOD_IDS) methods[id] = { enabled: true, signal: signals.find((s) => s.method === id) ?? null };
      const c = market.entry[i]!;
      return { index: i, time: c.closeTime, price: c.close, atr: 1, methods, consensus: decideConsensus(signals, general) };
    },
  });
}

const sym = (symbol: string, entry: Candle[]): BacktestSymbol => ({ symbol, market: { entry, trend: entry }, filters: { ...FILTERS, symbol } });

describe("runBacktest: one trade", () => {
  it("enters at the 3/3 close with exact-1R sizing and books a TP win net of fees", () => {
    const entry = series(30, { 12: [100, 104, 100, 103] });
    const r = runBacktest([sym("XUSDT", entry)], { settings: defaultSettings(), analyzerFor: scripted({ 10: THREE_LONG }) });
    expect(r.enterSignals).toBe(1);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t).toMatchObject({ symbol: "XUSDT", direction: "LONG", entryTime: entry[10]!.closeTime, entry: 100, exitReason: "TP", exitTime: entry[12]!.closeTime, bars: 2 });
    // 5 / (1.5 + 0.0005 × 198.5) = 3.126 → 3.1; EXACT_1R moves the stop so the loss is 1R.
    expect(t.quantity).toBe("3.1");
    expect(t.riskAtStop).toBeLessThanOrEqual(5);
    // Within one tick of 1R: the stop is rounded to 0.01 towards the entry.
    expect(t.riskAtStop).toBeGreaterThan(5 - 3.1 * 0.01 * 1.0005);
    expect(t.takeProfit).toBeCloseTo(100 + 2 * (100 - t.stopLoss), 2);
    expect(t.netPnl).toBeCloseTo(t.rewardAtTp, 4);
    expect(t.r).toBeCloseTo(t.rewardAtTp / 5, 4);
    expect(r.total).toMatchObject({ trades: 1, wins: 1, losses: 0, profitFactor: null, maxDrawdownR: 0 });
  });

  it("loses 1R at the stop", () => {
    const entry = series(30, { 11: [100, 100.1, 98, 98.4] });
    const r = runBacktest([sym("XUSDT", entry)], { settings: defaultSettings(), analyzerFor: scripted({ 10: THREE_LONG }) });
    const t = r.trades[0]!;
    expect(t.exitReason).toBe("SL");
    expect(t.exit).toBe(t.stopLoss);
    expect(t.r).toBeCloseTo(-t.riskAtStop / 5, 4);
    expect(t.r).toBeGreaterThan(-1.0001);
    expect(t.r).toBeLessThan(-0.99);
  });

  it("counts a candle that reaches both SL and TP as a loss", () => {
    const entry = series(30, { 11: [100, 105, 95, 100] });
    const t = runBacktest([sym("XUSDT", entry)], { settings: defaultSettings(), analyzerFor: scripted({ 10: THREE_LONG }) }).trades[0]!;
    expect(t).toMatchObject({ exitReason: "SL", ambiguous: true });
  });

  it("exits at the open when the price gaps through the stop", () => {
    const entry = series(30, { 11: [97, 97.2, 96.5, 97] });
    const t = runBacktest([sym("XUSDT", entry)], { settings: defaultSettings(), analyzerFor: scripted({ 10: THREE_LONG }) }).trades[0]!;
    expect(t).toMatchObject({ exitReason: "SL", exit: 97 });
    expect(t.r).toBeLessThan(-1.5);
  });

  it("handles SHORT and slippage against the trade", () => {
    const entry = series(30, { 12: [100, 100, 96, 97] });
    const t = runBacktest([sym("XUSDT", entry)], { settings: defaultSettings(), slippage: 0.001, analyzerFor: scripted({ 10: THREE_SHORT }) }).trades[0]!;
    expect(t.entry).toBeCloseTo(99.9, 10);
    expect(t.exitReason).toBe("TP");
    expect(t.exit).toBeCloseTo(t.takeProfit * 1.001, 10);
  });

  it("leaves a trade still open at the end out of the results", () => {
    const r = runBacktest([sym("XUSDT", series(15))], { settings: defaultSettings(), analyzerFor: scripted({ 10: THREE_LONG }) });
    expect(r.trades[0]!.exitReason).toBe("OPEN");
    expect(r.total.trades).toBe(0);
  });
});

describe("runBacktest: live rules", () => {
  it("counts READY once per episode, ENTER once, and nothing during the warm-up", () => {
    const entry = series(40);
    const script: Record<number, MethodSignal[]> = { 2: TWO_LONG, 3: TWO_LONG, 20: TWO_LONG, 21: TWO_LONG, 22: THREE_LONG, 23: THREE_LONG };
    const r = runBacktest([sym("XUSDT", entry)], { settings: defaultSettings(), from: entry[10]!.closeTime, analyzerFor: scripted(script) });
    expect(r.readyAlerts).toBe(1);
    expect(r.enterSignals).toBe(1);
    expect(r.trades).toHaveLength(1);
  });

  it("waits out the cooldown after an exit on the same symbol", () => {
    const entry = series(40, { 11: [100, 104, 100, 103] });
    const script: Record<number, MethodSignal[]> = { 10: THREE_LONG, 13: THREE_LONG, 20: THREE_LONG };
    const r = runBacktest([sym("XUSDT", entry)], { settings: defaultSettings(), analyzerFor: scripted(script) });
    expect(r.skipped).toEqual({ COOLDOWN: 1 });
    expect(r.trades.map((t) => t.entryTime)).toEqual([entry[10]!.closeTime, entry[20]!.closeTime]);
  });

  it("applies the open-position limit across symbols", () => {
    const a = series(30);
    const b = series(30);
    const r = runBacktest([sym("AUSDT", a), sym("BUSDT", b)], { settings: settingsWith({ risk: { maxOpenPositions: 1 } }), analyzerFor: scripted({ 10: THREE_LONG }) });
    expect(r.trades.map((t) => t.symbol)).toEqual(["AUSDT"]);
    expect(r.skipped).toEqual({ MAX_OPEN_POSITIONS: 1 });
  });

  it("stops for the day after the daily loss limit", () => {
    const entry = series(40, { 11: [100, 100.1, 98, 98.4] });
    const r = runBacktest([sym("XUSDT", entry)], {
      settings: settingsWith({ risk: { maxDailyLossR: 0.5 }, general: { cooldownBars: 0 } }),
      analyzerFor: scripted({ 10: THREE_LONG, 15: THREE_LONG }),
    });
    expect(r.trades).toHaveLength(1);
    expect(r.skipped).toEqual({ DAILY_LOSS_LIMIT: 1 });
  });

  it("records plan rejections such as a stop that is too far", () => {
    const far = METHOD_IDS.map((m) => signal(m, "LONG", 90));
    const r = runBacktest([sym("XUSDT", series(30))], { settings: defaultSettings(), analyzerFor: scripted({ 10: far }) });
    expect(r.trades).toEqual([]);
    expect(r.skipped).toEqual({ STOP_TOO_FAR: 1 });
  });

  it("runs the real analyzer over random history without look-ahead surprises", () => {
    const entry = randomWalk(1500, 11);
    const trend = randomWalk(400, 12, 60);
    const settings = settingsWith({ general: { alertThreshold: 1, autoEntryThreshold: 1 } });
    const r = runBacktest([{ symbol: "XUSDT", market: { entry, trend }, filters: FILTERS }], { settings });
    expect(r.enterSignals).toBeGreaterThan(0);
    for (const t of r.trades) {
      if (t.exitTime !== null) expect(t.exitTime).toBeGreaterThan(t.entryTime);
      expect(t.direction === "LONG" ? t.stopLoss < t.entry && t.takeProfit > t.entry : t.stopLoss > t.entry && t.takeProfit < t.entry).toBe(true);
    }
    // Cutting the history at a trade's entry gives the same entry: decisions never use later candles.
    const first = r.trades[0];
    if (first) {
      const cut = entry.findIndex((c) => c.closeTime === first.entryTime);
      const again = runBacktest([{ symbol: "XUSDT", market: { entry: entry.slice(0, cut + 1), trend }, filters: FILTERS }], { settings });
      expect(again.trades[0]).toMatchObject({ entryTime: first.entryTime, entry: first.entry, stopLoss: first.stopLoss, takeProfit: first.takeProfit });
    }
  });
});

describe("runBacktest: breakdown by methods", () => {
  it("groups closed trades by the agreeing methods and keeps the candle each one fired on", () => {
    const settings = settingsWith({ general: { autoEntryThreshold: 2 } });
    const a = series(30, { 12: [100, 104, 100, 103] });
    const b = series(30, { 11: [100, 100.1, 98, 98.4] });
    // A two candles before B on the first symbol; A and C on the same candle on the second.
    const ab = [
      { ...signal("trendPullback", "LONG", 98.5), time: a[8]!.closeTime },
      { ...signal("donchianBreakout", "LONG", 98.5), time: a[10]!.closeTime },
    ];
    const ac = [signal("trendPullback", "LONG", 98.5), signal("smcSweep", "LONG", 98.5)].map((s) => ({ ...s, time: b[10]!.closeTime }));
    const r = runBacktest([sym("AUSDT", a), sym("BUSDT", b)], {
      settings,
      analyzerFor: (market) => scripted({ 10: market.entry === a ? ab : ac }, settings.general)(market),
    });
    expect(Object.keys(r.byMethods)).toEqual(["trendPullback+donchianBreakout", "trendPullback+smcSweep"]);
    expect(r.byMethods["trendPullback+donchianBreakout"]).toMatchObject({ trades: 1, wins: 1 });
    expect(r.byMethods["trendPullback+smcSweep"]).toMatchObject({ trades: 1, wins: 0 });
    const [first, second] = r.trades;
    expect(signalSequence(first!.signalTimes)).toEqual([["trendPullback"], ["donchianBreakout"]]);
    expect(signalSequence(second!.signalTimes)).toEqual([["trendPullback", "smcSweep"]]);
  });

  it("orders method sets as A, B, C whatever order they come in", () => {
    expect(methodsKey(["smcSweep", "trendPullback"])).toBe("trendPullback+smcSweep");
  });

  it("lists pairs before the triple: A+B, A+C, B+C, A+B+C", () => {
    const settings = settingsWith({ general: { autoEntryThreshold: 2 }, risk: { maxOpenPositions: 5 } });
    const [a, b, c] = METHOD_IDS as [MethodId, MethodId, MethodId];
    const sets = [[b, c], [a, b, c], [a, c], [a, b]];
    const books = sets.map((_, k) => sym(`S${k}USDT`, series(30, { 11: [100, 100.1, 98, 98.4] })));
    const r = runBacktest(books, {
      settings,
      analyzerFor: (market) => scripted({ 10: sets[books.findIndex((x) => x.market === market)]!.map((m) => signal(m, "LONG", 98.5)) }, settings.general)(market),
    });
    expect(Object.keys(r.byMethods)).toEqual([methodsKey([a, b]), methodsKey([a, c]), methodsKey([b, c]), methodsKey([a, b, c])]);
  });
});

describe("summarize", () => {
  it("computes win rate, profit factor and the deepest drawdown in R", () => {
    const t = (r: number, exitTime: number) => ({ r, exitTime, netPnl: r * 5, ambiguous: false }) as BacktestTrade;
    const s = summarize([t(1.8, 1), t(-1, 2), t(-1, 3), t(1.8, 4), t(-1, 5)]);
    expect(s).toMatchObject({ trades: 5, wins: 2, losses: 3, winRate: 0.4, maxDrawdownR: 2, bestR: 1.8, worstR: -1 });
    expect(s.totalR).toBeCloseTo(0.6, 10);
    expect(s.profitFactor).toBeCloseTo(1.2, 10);
  });
});
