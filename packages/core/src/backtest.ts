import { createAnalyzer, type SymbolAnalysis } from "./analyzer.js";
import { advanceEpisode, markEntered, type Episode } from "./consensus/index.js";
import { finalizeAfterFill } from "./risk/fill.js";
import type { SymbolFilters } from "./risk/filters.js";
import { checkEntryGuards, tradingDayKey } from "./risk/guards.js";
import { feeRateOf, planTrade } from "./risk/plan.js";
import { netResultAt } from "./risk/targets.js";
import { nextStop, tpProgress, type StopStage } from "./risk/trail.js";
import { TIMEFRAME_MINUTES, type Settings } from "./settings/schema.js";
import type { MarketData } from "./strategies/types.js";
import { METHOD_IDS, type Candle, type Direction, type MethodId } from "./types.js";

export interface BacktestSymbol {
  symbol: string;
  market: MarketData;
  filters: SymbolFilters;
}

export interface BacktestOptions {
  settings: Settings;
  /** Trades open only on candles closing at or after this time; earlier candles warm the indicators up. */
  from?: number;
  /** Last candle close considered. */
  to?: number;
  /** Fill price slippage against the trade, as a fraction (0.0002 = 0.02%), on entries and exits. */
  slippage?: number;
  /** Replaces the core analyzer (tests). */
  analyzerFor?: (market: MarketData, settings: Settings) => { at(index: number): SymbolAnalysis };
}

export type BacktestExit = "TP" | "SL" | "OPEN";

export interface BacktestTrade {
  symbol: string;
  direction: Direction;
  methods: MethodId[];
  /** closeTime of the candle each agreeing method fired on (they can be a few candles apart). */
  signalTimes: Partial<Record<MethodId, number>>;
  /** closeTime of the candle that gave 3/3 (the entry fills at its close). */
  entryTime: number;
  entry: number;
  quantity: string;
  stopLoss: number;
  takeProfit: number;
  /** How far the stop had been moved when the trade ended: 0 not moved, 1 to the entry, 2 into profit. */
  stopStage: StopStage;
  /** Loss at the stop and net win at the take profit, fees included, in USDT. */
  riskAtStop: number;
  rewardAtTp: number;
  exitTime: number | null;
  exit: number | null;
  exitReason: BacktestExit;
  netPnl: number;
  /** netPnl / 1R. */
  r: number;
  /** SL and TP were both inside one candle; counted as SL, the worse case. */
  ambiguous: boolean;
  bars: number;
}

export interface BacktestSummary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalR: number;
  avgR: number;
  /** Sum of winning R / sum of losing R; null without losses. */
  profitFactor: number | null;
  maxDrawdownR: number;
  netPnl: number;
  bestR: number;
  worstR: number;
  ambiguous: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  /** 2/3 alerts and 3/3 decisions, as the live bot would have sent them. */
  readyAlerts: number;
  enterSignals: number;
  /** 3/3 decisions that did not become trades, by guard or plan reason. */
  skipped: Record<string, number>;
  total: BacktestSummary;
  bySymbol: Record<string, BacktestSummary>;
  /** Per set of agreeing methods, keyed by methodsKey (e.g. "trendPullback+donchianBreakout"). */
  byMethods: Record<string, BacktestSummary>;
  from: number | null;
  to: number | null;
}

interface Position {
  trade: BacktestTrade;
  entryIndex: number;
  /** The stop in force now (moves towards the TP with settings risk.moveSl). */
  stop: number;
  /** Furthest progress towards the TP so far (1 = at the TP). */
  best: number;
}

interface Book {
  symbol: string;
  data: BacktestSymbol;
  analyzer: { at(index: number): SymbolAnalysis };
  byClose: Map<number, number>;
  episode: Episode | null;
  position: Position | null;
  lastExit: number | null;
}

/**
 * Replays the live rules over history, candle by candle and across symbols in time order:
 * the same analyzer, 2/3-3/3 episodes (with retries while an episode has not entered), entry guards (open positions, trades and loss per Vietnam
 * day, cooldown), stop plan, 1R sizing and EXACT_1R/TP from the fill. Entries fill at the close of
 * the 3/3 candle; exits at the SL or TP price (or the open when the candle gaps through it). When a
 * candle reaches both SL and TP the trade counts as a loss, since candles do not say which came first.
 */
export function runBacktest(symbols: readonly BacktestSymbol[], options: BacktestOptions): BacktestResult {
  const { settings } = options;
  const risk = settings.risk;
  const fee = feeRateOf(risk);
  const slip = options.slippage ?? 0;
  const tfMs = TIMEFRAME_MINUTES[settings.general.entryTf] * 60_000;
  const analyzerFor = options.analyzerFor ?? ((market, s) => createAnalyzer(market, s));

  const books: Book[] = symbols.map((data) => ({
    symbol: data.symbol,
    data,
    analyzer: analyzerFor(data.market, settings),
    byClose: new Map(data.market.entry.map((c, i) => [c.closeTime, i])),
    episode: null,
    position: null,
    lastExit: null,
  }));
  const times = [...new Set(symbols.flatMap((s) => s.market.entry.map((c) => c.closeTime)))]
    .filter((t) => (options.to === undefined || t <= options.to))
    .sort((a, b) => a - b);

  const trades: BacktestTrade[] = [];
  const skipped: Record<string, number> = {};
  const skipOnce = (reason: string) => (skipped[reason] = (skipped[reason] ?? 0) + 1);
  const opened = new Map<string, number>();
  const realized = new Map<string, number>();
  let readyAlerts = 0;
  let enterSignals = 0;

  for (const time of times) {
    // Exits first: a trade opened at an earlier close is checked against this candle.
    for (const book of books) {
      const i = book.byClose.get(time);
      const position = book.position;
      if (i === undefined || !position || i <= position.entryIndex) continue;
      const candle = book.data.market.entry[i]!;
      const exit = exitOn(position.trade, position.stop, candle, slip);
      if (!exit) {
        moveStop(position, candle, risk, book.data.filters.tickSize);
        continue;
      }
      const t = position.trade;
      t.exit = exit.price;
      t.exitTime = time;
      t.exitReason = exit.reason;
      t.ambiguous = exit.ambiguous;
      t.bars = i - position.entryIndex;
      t.netPnl = netResultAt(t.direction, t.entry, exit.price, t.quantity, fee).toNumber();
      t.r = t.netPnl / risk.riskUsd;
      const day = tradingDayKey(time);
      realized.set(day, (realized.get(day) ?? 0) + t.r);
      book.position = null;
      book.lastExit = time;
    }

    for (const book of books) {
      const i = book.byClose.get(time);
      if (i === undefined) continue;
      const analysis = book.analyzer.at(i);
      const step = advanceEpisode(book.episode, analysis.consensus, analysis.time);
      book.episode = step.episode;
      if (options.from !== undefined && time < options.from) continue;
      if (step.emit === "READY") readyAlerts++;
      if (step.emit !== "ENTER") continue;
      if (!step.retry) enterSignals++;
      // Refusals are counted once per episode; the live bot also retries silently.
      const skip = (reason: string) => {
        if (!step.retry) skipOnce(reason);
      };

      const day = tradingDayKey(time);
      const guard = checkEntryGuards(
        {
          autoTradeAllowed: true,
          paused: false,
          openPositions: books.filter((b) => b.position).length,
          tradesToday: opened.get(day) ?? 0,
          realizedRToday: realized.get(day) ?? 0,
          symbolBusy: book.position !== null,
          cooldownUntil: book.lastExit !== null && settings.general.cooldownBars > 0 ? book.lastExit + settings.general.cooldownBars * tfMs : null,
          now: time,
        },
        risk,
      );
      if (!guard.ok) {
        skip(guard.reason);
        continue;
      }
      const direction = analysis.consensus.direction!;
      const close = analysis.price;
      const plan = planTrade({ direction, signals: analysis.consensus.agreeing, entryPrice: close, atr: analysis.atr, risk, filters: book.data.filters });
      if (!plan.ok) {
        skip(plan.reason);
        continue;
      }
      if (!plan.sizing?.ok) {
        skip(plan.sizing?.reason ?? "NO_FILTERS");
        continue;
      }
      // LIMIT: post-only at the close, resting through the next candle. It fills only when price
      // trades through it (not just touches, the queue is ahead), and then without slippage.
      const next = book.data.market.entry[i + 1];
      const limit = risk.entryOrder === "LIMIT";
      if (limit && !(next && (direction === "LONG" ? next.low < close : next.high > close))) {
        skip("LIMIT_NOT_FILLED");
        continue;
      }
      const fill = limit ? close : direction === "LONG" ? close * (1 + slip) : close * (1 - slip);
      const final = finalizeAfterFill({
        direction,
        fillPrice: fill,
        filledQty: plan.sizing.quantity,
        structuralStop: plan.stopLoss,
        riskUsd: risk.riskUsd,
        feeRate: fee,
        rr: risk.rr,
        mode: risk.slMode,
        maxSlWidenPct: risk.maxSlWidenPct,
        tickSize: book.data.filters.tickSize,
      });
      if (!final.ok) {
        skip(final.reason);
        continue;
      }
      const trade: BacktestTrade = {
        symbol: book.symbol,
        direction,
        methods: analysis.consensus.agreeing.map((s) => s.method),
        signalTimes: Object.fromEntries(analysis.consensus.agreeing.map((s) => [s.method, s.time])),
        entryTime: time,
        entry: fill,
        quantity: plan.sizing.quantity,
        stopLoss: Number(final.stopLoss),
        takeProfit: Number(final.takeProfit),
        stopStage: 0,
        riskAtStop: Number(final.riskUsd),
        rewardAtTp: Number(final.rewardUsd),
        exitTime: null,
        exit: null,
        exitReason: "OPEN",
        netPnl: 0,
        r: 0,
        ambiguous: false,
        bars: 0,
      };
      trades.push(trade);
      book.episode = markEntered(book.episode!);
      opened.set(day, (opened.get(day) ?? 0) + 1);
      if (!limit) {
        book.position = { trade, entryIndex: i, stop: trade.stopLoss, best: 0 };
        continue;
      }
      // Filled during the next candle: from there on the trade is open. Only the stop is checked on
      // that candle, since its high (LONG) may have come before the fill.
      trade.entryTime = next!.closeTime;
      book.position = { trade, entryIndex: i + 1, stop: trade.stopLoss, best: 0 };
      if (direction === "LONG" ? next!.low <= trade.stopLoss : next!.high >= trade.stopLoss) {
        trade.exit = direction === "LONG" ? trade.stopLoss * (1 - slip) : trade.stopLoss * (1 + slip);
        trade.exitTime = next!.closeTime;
        trade.exitReason = "SL";
        trade.bars = 1;
        trade.netPnl = netResultAt(direction, trade.entry, trade.exit, trade.quantity, fee).toNumber();
        trade.r = trade.netPnl / risk.riskUsd;
        const exitDay = tradingDayKey(next!.closeTime);
        realized.set(exitDay, (realized.get(exitDay) ?? 0) + trade.r);
        book.position = null;
        book.lastExit = next!.closeTime;
      }
    }
  }

  const closed = trades.filter((t) => t.exitReason !== "OPEN");
  const bySymbol: Record<string, BacktestSummary> = {};
  for (const s of symbols) bySymbol[s.symbol] = summarize(closed.filter((t) => t.symbol === s.symbol));
  const byMethods: Record<string, BacktestSummary> = {};
  // Pairs before the triple, each in A, B, C order: A+B, A+C, B+C, A+B+C.
  const rank = (key: string) => key.split("+").map((m) => METHOD_IDS.indexOf(m as MethodId));
  const order = (a: string, b: string) => {
    const [ra, rb] = [rank(a), rank(b)];
    if (ra.length !== rb.length) return ra.length - rb.length;
    const i = ra.findIndex((x, k) => x !== rb[k]);
    return i === -1 ? 0 : ra[i]! - rb[i]!;
  };
  for (const key of [...new Set(closed.map((t) => methodsKey(t.methods)))].sort(order)) {
    byMethods[key] = summarize(closed.filter((t) => methodsKey(t.methods) === key));
  }
  return {
    trades,
    readyAlerts,
    enterSignals,
    skipped,
    total: summarize(closed),
    bySymbol,
    byMethods,
    from: options.from ?? times[0] ?? null,
    to: times.at(-1) ?? null,
  };
}

/** A set of methods in the fixed A, B, C order, joined with "+". */
export function methodsKey(methods: readonly MethodId[]): string {
  return METHOD_IDS.filter((m) => methods.includes(m)).join("+");
}

/**
 * The order the agreeing methods fired in: groups of methods that fired on the same candle,
 * earliest first. [[A, B]] means both on one candle (likely the same move); [[A], [B]] means A first.
 */
export function signalSequence(signalTimes: Partial<Record<MethodId, number>>): MethodId[][] {
  const groups = new Map<number, MethodId[]>();
  for (const m of METHOD_IDS) {
    const time = signalTimes[m];
    if (time !== undefined) groups.set(time, [...(groups.get(time) ?? []), m]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, methods]) => methods);
}

/**
 * After a candle that did not end the trade: the stop follows the live rule (risk.moveSl), from the
 * candle's best price. It moves only after the candle, so a move never helps the candle that
 * triggered it, and not when the close is already past the new stop (the live bot waits then too).
 */
function moveStop(position: Position, c: Candle, risk: Settings["risk"], tickSize: string): void {
  const t = position.trade;
  const long = t.direction === "LONG";
  position.best = Math.max(position.best, tpProgress(t.direction, t.entry, t.takeProfit, long ? c.high : c.low));
  const next = nextStop({
    direction: t.direction,
    entry: t.entry,
    takeProfit: t.takeProfit,
    stopLoss: position.stop,
    stage: t.stopStage,
    bestProgress: position.best,
    settings: risk,
    tickSize,
  });
  if (!next) return;
  const stop = Number(next.stopLoss);
  if (long ? c.close <= stop : c.close >= stop) return;
  position.stop = stop;
  t.stopStage = next.stage;
}

/** Whether the candle closes the trade, and where. */
function exitOn(t: BacktestTrade, stop: number, c: Candle, slip: number): { reason: "TP" | "SL"; price: number; ambiguous: boolean } | null {
  const long = t.direction === "LONG";
  const hitSl = long ? c.low <= stop : c.high >= stop;
  const hitTp = long ? c.high >= t.takeProfit : c.low <= t.takeProfit;
  if (!hitSl && !hitTp) return null;
  // Exits are market orders once triggered: slippage works against the trade.
  const worse = (price: number) => (long ? price * (1 - slip) : price * (1 + slip));
  if (hitSl) {
    const gapped = long ? c.open < stop : c.open > stop;
    return { reason: "SL", price: worse(gapped ? c.open : stop), ambiguous: hitTp };
  }
  const gapped = long ? c.open > t.takeProfit : c.open < t.takeProfit;
  return { reason: "TP", price: worse(gapped ? c.open : t.takeProfit), ambiguous: false };
}

export function summarize(trades: readonly BacktestTrade[]): BacktestSummary {
  const ordered = [...trades].sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  let gains = 0;
  let pains = 0;
  for (const t of ordered) {
    equity += t.r;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
    if (t.r > 0) gains += t.r;
    else pains -= t.r;
  }
  const wins = trades.filter((t) => t.r > 0).length;
  const totalR = trades.reduce((s, t) => s + t.r, 0);
  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    winRate: trades.length ? wins / trades.length : 0,
    totalR,
    avgR: trades.length ? totalR / trades.length : 0,
    profitFactor: pains > 0 ? gains / pains : null,
    maxDrawdownR,
    netPnl: trades.reduce((s, t) => s + t.netPnl, 0),
    bestR: trades.length ? Math.max(...trades.map((t) => t.r)) : 0,
    worstR: trades.length ? Math.min(...trades.map((t) => t.r)) : 0,
    ambiguous: trades.filter((t) => t.ambiguous).length,
  };
}
