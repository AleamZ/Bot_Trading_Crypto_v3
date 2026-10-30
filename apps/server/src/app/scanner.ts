import {
  advanceEpisode,
  checkEntryGuards,
  createAnalyzer,
  type Candle,
  type Episode,
  type MarketData,
  type Settings,
  type SymbolAnalysis,
} from "@bot-v3/core";
import { errorText } from "../binance/errors.js";
import type { MarketApi } from "../binance/types.js";
import type { KeyValueStore, SqliteTradeStore } from "../db/stores.js";
import type { EntryOutcome, EntryRequest } from "../engine/executor.js";
import { sleep as realSleep } from "../engine/support.js";
import { silentLogger, type Logger } from "../lib/logger.js";
import { guardStateFor, timeframeMs, type BotControl } from "./control.js";
import { toAnalysisView, type AnalysisView, type EventHub } from "./events.js";

const EPISODES_KEY = "episodes";

export interface ScannerDeps {
  market: MarketApi;
  settings: () => Settings;
  store: SqliteTradeStore;
  control: BotControl;
  hub: EventHub;
  kv: KeyValueStore;
  /** Executor.enter, or a stand-in in tests. */
  enter: (request: EntryRequest) => Promise<EntryOutcome>;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Replaces the core analyzer in tests. */
  analyze?: (market: MarketData, settings: Settings) => SymbolAnalysis;
  /** How long after a candle closes the scan starts (default 2s). */
  closeDelayMs?: number;
  /** Retries while Binance does not have the just-closed candle yet (default 5, 1.5s apart). */
  freshRetries?: number;
}

export interface SymbolScan {
  symbol: string;
  level: SymbolAnalysis["consensus"]["level"] | null;
  direction: SymbolAnalysis["consensus"]["direction"];
  emitted: "READY" | "ENTER" | null;
  entry: "FILLED" | "FAILED" | "SKIPPED" | null;
  error: string | null;
}

export interface ScanReport {
  startedAt: number;
  finishedAt: number;
  /** closeTime the last entry candle was expected to have. */
  expectedClose: number;
  symbols: SymbolScan[];
}

interface EpisodeRecord {
  episode: Episode;
  /** closeTime of the last candle that continued the episode. */
  lastSeenAt: number;
}

/** Candles to ask for: enough history for the slowest indicator, at least 499 (Binance weight 2). */
export function candleLimits(settings: Settings): { entry: number; trend: number } {
  const m = settings.methods;
  const entry = Math.max(
    m.trendPullback.emaMid * 3,
    m.donchianBreakout.channelLength + m.donchianBreakout.volumeSmaLength + 50,
    m.donchianBreakout.adxPeriod * 10,
    m.smcSweep.swingMaxAge + m.smcSweep.sweepLookback + 50,
    settings.general.atrPeriod * 10,
  );
  const trend = Math.max(m.trendPullback.emaSlow * 2 + m.trendPullback.slopeLookback, m.trendPullback.emaMid * 3);
  const clamp = (n: number) => Math.min(1500, Math.max(499, Math.ceil(n)));
  return { entry: clamp(entry), trend: clamp(trend) };
}

/** closeTime of the newest candle that has closed at `now` (Binance candles are UTC-aligned). */
export function lastClosedCandleTime(now: number, tfMs: number): number {
  return Math.floor(now / tfMs) * tfMs - 1;
}

/**
 * Runs after every close of the entry timeframe: fetches closed candles, runs the three methods,
 * decides 2/3 (READY alert) or 3/3 (automatic entry) with one alert per episode, and hands 3/3 to
 * the executor once the entry guards pass. Analysis is recomputed from candles every time, so a
 * restart gives the same answer; only the episodes are stored, to avoid repeating alerts.
 */
export class Scanner {
  readonly latest = new Map<string, AnalysisView>();
  lastReport: ScanReport | null = null;
  nextScanAt: number | null = null;

  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly analyze: (market: MarketData, settings: Settings) => SymbolAnalysis;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<ScanReport> | null = null;
  private stopped = true;

  constructor(private readonly deps: ScannerDeps) {
    this.logger = deps.logger ?? silentLogger;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? realSleep;
    this.analyze = deps.analyze ?? ((market, settings) => createAnalyzer(market, settings).latest());
  }

  get scanning(): boolean {
    return this.running !== null;
  }

  /** Scans the last closed candle now, then on every close. */
  start(): void {
    this.stopped = false;
    void this.scanNow().finally(() => this.schedule());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextScanAt = null;
    await this.running?.catch(() => undefined);
  }

  /** Call after the entry timeframe changes. */
  reschedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule();
  }

  /** One pass over the watchlist; concurrent calls share the pass in progress. */
  scanNow(): Promise<ScanReport> {
    if (!this.running) {
      this.running = this.pass().finally(() => {
        this.running = null;
        this.deps.hub.live("status", { scan: this.lastReport });
      });
      this.deps.hub.live("status", { scanning: true });
    }
    return this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    const tf = timeframeMs(this.deps.settings());
    const now = this.now();
    const at = Math.floor(now / tf) * tf + tf + (this.deps.closeDelayMs ?? 2000);
    this.nextScanAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.scanNow().finally(() => this.schedule());
    }, at - now);
  }

  private async pass(): Promise<ScanReport> {
    const settings = this.deps.settings();
    const startedAt = this.now();
    const expectedClose = lastClosedCandleTime(startedAt, timeframeMs(settings));
    const episodes = this.deps.kv.get<Record<string, EpisodeRecord>>(EPISODES_KEY, {});
    const symbols: SymbolScan[] = [];

    for (const symbol of settings.general.watchlist) {
      const scan: SymbolScan = { symbol, level: null, direction: null, emitted: null, entry: null, error: null };
      symbols.push(scan);
      try {
        await this.scanSymbol(symbol, settings, expectedClose, episodes, scan);
      } catch (error) {
        scan.error = errorText(error);
        this.logger.warn("Scan failed", { symbol, error: scan.error });
      }
    }

    for (const symbol of [...this.latest.keys()]) if (!settings.general.watchlist.includes(symbol)) this.latest.delete(symbol);
    for (const symbol of Object.keys(episodes)) if (!settings.general.watchlist.includes(symbol)) delete episodes[symbol];
    this.deps.kv.set(EPISODES_KEY, episodes);

    // One event per distinct error, so an outage does not send one message per symbol.
    const failures = new Map<string, string[]>();
    for (const s of symbols) if (s.error) failures.set(s.error, [...(failures.get(s.error) ?? []), s.symbol]);
    for (const [detail, failed] of failures) this.deps.hub.emit({ type: "SCAN_FAILED", symbols: failed, detail });

    const report: ScanReport = { startedAt, finishedAt: this.now(), expectedClose, symbols };
    this.lastReport = report;
    return report;
  }

  private async scanSymbol(
    symbol: string,
    settings: Settings,
    expectedClose: number,
    episodes: Record<string, EpisodeRecord>,
    scan: SymbolScan,
  ): Promise<void> {
    const { entryTf, trendTf } = settings.general;
    const limits = candleLimits(settings);
    const entry = await this.freshCandles(symbol, entryTf, limits.entry, expectedClose);
    const trend = trendTf === entryTf ? entry : await this.deps.market.getClosedCandles(symbol, trendTf, limits.trend);
    const analysis = this.analyze({ entry, trend }, settings);
    scan.level = analysis.consensus.level;
    scan.direction = analysis.consensus.direction;

    // A gap of more than one candle (the bot was down) starts a new episode.
    const record = episodes[symbol];
    const tf = timeframeMs(settings);
    const previous = record && analysis.time - record.lastSeenAt <= tf * 1.5 ? record.episode : null;
    const step = advanceEpisode(previous, analysis.consensus, analysis.time);
    if (step.episode) episodes[symbol] = { episode: step.episode, lastSeenAt: analysis.time };
    else delete episodes[symbol];

    const view = toAnalysisView(symbol, entryTf, analysis, step.episode, this.now());
    this.latest.set(symbol, view);
    this.deps.hub.live("analysis", view);
    scan.emitted = step.emit;
    if (step.emit === "READY") this.deps.hub.emit({ type: "SIGNAL_READY", analysis: view });
    if (step.emit === "ENTER") {
      this.deps.hub.emit({ type: "SIGNAL_ENTER", analysis: view });
      scan.entry = await this.tryEnter(symbol, analysis, view, settings);
    }
  }

  private async tryEnter(symbol: string, analysis: SymbolAnalysis, view: AnalysisView, settings: Settings): Promise<SymbolScan["entry"]> {
    const direction = analysis.consensus.direction!;
    const guard = checkEntryGuards(guardStateFor(symbol, this.deps.store, this.deps.control, settings, this.now()), settings.risk);
    if (!guard.ok) {
      this.deps.hub.emit({ type: "ENTRY_SKIPPED", symbol, direction, reason: guard.reason, analysis: view });
      return "SKIPPED";
    }
    const outcome = await this.deps.enter({ symbol, direction, signals: analysis.consensus.agreeing, atr: analysis.atr, settings });
    return outcome.ok ? "FILLED" : "FAILED";
  }

  /** Entry candles that include the candle that just closed (Binance can lag by a moment). */
  private async freshCandles(symbol: string, interval: string, limit: number, expectedClose: number): Promise<Candle[]> {
    const retries = this.deps.freshRetries ?? 5;
    for (let attempt = 0; ; attempt++) {
      const candles = await this.deps.market.getClosedCandles(symbol, interval, limit);
      const last = candles.at(-1);
      if (last && last.closeTime >= expectedClose) return candles;
      if (attempt >= retries) {
        const got = last ? new Date(last.closeTime + 1).toISOString() : "không có nến";
        throw new Error(`Binance chưa trả nến ${interval} đóng lúc ${new Date(expectedClose + 1).toISOString()} (nến mới nhất: ${got})`);
      }
      await this.sleep(1500);
    }
  }
}
