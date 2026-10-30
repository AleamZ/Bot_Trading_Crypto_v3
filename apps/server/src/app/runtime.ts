import {
  chartOverlays,
  checkEntryGuards,
  createAnalyzer,
  GUARD_MESSAGES,
  planTrade,
  settingsWarnings,
  type MarketData,
  type Settings,
  type SymbolAnalysis,
} from "@bot-v3/core";
import { errorText } from "../binance/errors.js";
import type { FuturesApi, MarketApi } from "../binance/types.js";
import { UserStream, type SocketLike } from "../binance/userStream.js";
import type { AppEnv } from "../config/env.js";
import type { Database } from "../db/database.js";
import { EventLog, KeyValueStore, SqliteTradeStore } from "../db/stores.js";
import { Executor } from "../engine/executor.js";
import { chooseLeverage } from "../engine/leverage.js";
import { flatten } from "../engine/protection.js";
import { KeyedLock } from "../engine/support.js";
import type { Trade } from "../engine/types.js";
import { Watchdog } from "../engine/watchdog.js";
import { silentLogger, type Logger } from "../lib/logger.js";
import type { TelegramClient } from "../telegram/client.js";
import { formatPositions, formatStatus, formatToday, type StatusSummary } from "../telegram/format.js";
import { TelegramService } from "../telegram/service.js";
import { BotControl, guardStateFor, SettingsService, timeframeMs, todayStats } from "./control.js";
import { EventHub, toAnalysisView } from "./events.js";
import { candleLimits, lastClosedCandleTime, Scanner } from "./scanner.js";

export type ExchangeApi = FuturesApi &
  MarketApi & {
    createListenKey(): Promise<string>;
    keepAliveListenKey(): Promise<void>;
  };

export interface RuntimeOptions {
  env: AppEnv;
  db: Database;
  exchange: ExchangeApi;
  telegramClient: TelegramClient | null;
  logger?: Logger;
  now?: () => number;
  /** Replaces the WebSocket in tests; null disables the user stream. */
  createSocket?: ((url: string) => SocketLike) | null;
  watchdogIntervalMs?: number;
  /** Activity log entries older than this are deleted (default 60 days). */
  eventRetentionMs?: number;
}

/** Thrown for problems the API should answer with a 4xx, never a 502. */
export class BotError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Field errors (invalid settings or query). */
    readonly errors?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "BotError";
  }
}

/**
 * The whole bot in one object: storage, settings, the event hub, executor + watchdog, the candle
 * scanner, the Binance user stream and Telegram. The HTTP API and Telegram commands go through it.
 */
export class BotRuntime {
  readonly env: AppEnv;
  readonly kv: KeyValueStore;
  readonly trades: SqliteTradeStore;
  readonly log: EventLog;
  readonly hub: EventHub;
  readonly settings: SettingsService;
  readonly control: BotControl;
  readonly locks = new KeyedLock();
  readonly executor: Executor;
  readonly watchdog: Watchdog;
  readonly scanner: Scanner;
  readonly telegram: TelegramService | null;
  readonly userStream: UserStream | null;
  readonly startedAt: number;

  exchangeOk = true;
  exchangeError: string | null = null;
  lastReconcileAt: number | null = null;

  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private reconcileSoon: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(private readonly options: RuntimeOptions) {
    this.env = options.env;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    const { db, exchange } = options;
    this.kv = new KeyValueStore(db, this.now);
    this.trades = new SqliteTradeStore(db);
    this.log = new EventLog(db);
    this.hub = new EventHub(this.log, this.logger, this.now);
    this.settings = new SettingsService(this.kv, this.logger);
    const settings = () => this.settings.get();
    this.control = new BotControl(this.kv, { tradingEnabled: this.env.TRADING_ENABLED, hasBinanceKeys: this.env.hasBinanceKeys }, settings, this.hub);

    const engine = { api: exchange, store: this.trades, events: this.hub, locks: this.locks, logger: this.logger, now: this.now };
    this.executor = new Executor(engine);
    this.watchdog = new Watchdog({ ...engine, settings });
    this.scanner = new Scanner({
      market: exchange,
      settings,
      store: this.trades,
      control: this.control,
      hub: this.hub,
      kv: this.kv,
      enter: (request) => this.executor.enter(request),
      logger: this.logger,
      now: this.now,
    });

    this.userStream =
      this.env.hasBinanceKeys && options.createSocket !== null
        ? new UserStream({
            wsBaseUrl: this.env.binanceWsUrl,
            createListenKey: () => exchange.createListenKey(),
            keepAliveListenKey: () => exchange.keepAliveListenKey(),
            onEvent: () => this.scheduleReconcile(),
            onStatus: (connected, detail) => this.hub.live("status", { userStream: { connected, detail: detail ?? null } }),
            logger: this.logger,
            ...(options.createSocket ? { createSocket: options.createSocket } : {}),
          })
        : null;

    // The number before ":" in the token is the bot's own id, a common mix-up for the chat id.
    const botId = this.env.TELEGRAM_BOT_TOKEN?.split(":")[0];
    const chatIdIsBot = this.env.TELEGRAM_CHAT_ID !== undefined && this.env.TELEGRAM_CHAT_ID === botId;
    this.telegram = options.telegramClient
      ? new TelegramService({
          client: options.telegramClient,
          chatId: chatIdIsBot ? null : (this.env.TELEGRAM_CHAT_ID ?? null),
          setupError: chatIdIsBot
            ? "TELEGRAM_CHAT_ID đang là mã của chính bot (phần số đầu token), không phải chat của bạn. Nhắn /start cho bot để lấy chat id đúng"
            : null,
          kv: this.kv,
          hub: this.hub,
          settings,
          commands: {
            status: async () => formatStatus(this.statusSummary()),
            positions: async () => formatPositions(this.trades.listByStatusSync(["OPENING", "OPEN"])),
            today: async () => formatToday(this.today()),
            pause: (by) => this.control.pause(by),
            resume: (by) => this.control.resume(by),
          },
          todayLine: () => formatToday(this.today()),
          logger: this.logger,
          now: this.now,
        })
      : null;

    this.settings.onChange(() => this.scanner.reschedule());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.telegram?.start();
    const s = this.settings.get();
    this.hub.emit({
      type: "BOT_STARTED",
      binanceEnv: this.env.BINANCE_ENV,
      tradingEnabled: this.env.TRADING_ENABLED,
      hasKeys: this.env.hasBinanceKeys,
      autoTrade: s.general.autoTrade,
      paused: this.control.paused,
    });
    if (this.settings.loadErrors.length) {
      this.hub.emit({ type: "ERROR", message: "Cài đặt đã lưu không hợp lệ, bot dùng cài đặt mặc định", detail: this.settings.loadErrors.map((e) => `${e.path}: ${e.message}`).join("; ") });
    }
    if (this.env.hasBinanceKeys) {
      // Protect whatever the last run left before looking for new trades.
      await this.reconcile();
      this.timers.push(setInterval(() => void this.reconcile(), this.options.watchdogIntervalMs ?? 15_000));
      this.userStream?.start();
    }
    const retention = this.options.eventRetentionMs ?? 60 * 86_400_000;
    const prune = () => this.log.prune(this.now() - retention);
    prune();
    this.timers.push(setInterval(prune, 6 * 3_600_000));
    this.scanner.start();
  }

  async stop(signal = "stop"): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.hub.emit({ type: "BOT_STOPPING", signal });
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    if (this.reconcileSoon) clearTimeout(this.reconcileSoon);
    this.userStream?.stop();
    await this.scanner.stop();
    // scanner.stop() waited for an entry in progress; one last pass checks its SL/TP are on the exchange.
    if (this.env.hasBinanceKeys) await this.watchdog.reconcile().catch(() => undefined);
    await this.telegram?.stop();
  }

  /** One watchdog pass; reports Binance going down or coming back once, not every 15 seconds. */
  async reconcile(): Promise<void> {
    if (!this.env.hasBinanceKeys) return;
    try {
      await this.watchdog.reconcile();
      this.lastReconcileAt = this.now();
      if (!this.exchangeOk) {
        this.exchangeOk = true;
        this.exchangeError = null;
        this.hub.emit({ type: "EXCHANGE_STATUS", ok: true, detail: "Watchdog đối chiếu lại bình thường" });
      }
    } catch (error) {
      const detail = errorText(error);
      this.exchangeError = detail;
      if (this.exchangeOk) {
        this.exchangeOk = false;
        this.hub.emit({ type: "EXCHANGE_STATUS", ok: false, detail });
      }
    }
  }

  /** User-stream events arrive in bursts (order update + account update): reconcile once. */
  private scheduleReconcile(): void {
    if (this.reconcileSoon) return;
    this.reconcileSoon = setTimeout(() => {
      this.reconcileSoon = null;
      void this.reconcile();
    }, 300);
  }

  today() {
    return todayStats(this.trades, this.now());
  }

  statusSummary(): StatusSummary {
    const s = this.settings.get();
    return {
      binanceEnv: this.env.BINANCE_ENV,
      autoTradeAllowed: this.control.autoTradeAllowed(),
      autoTradeBlockers: this.control.autoTradeBlockers(),
      paused: this.control.paused,
      lastScanAt: this.scanner.lastReport?.finishedAt ?? null,
      nextScanAt: this.scanner.nextScanAt,
      openTrades: this.trades.openCount(),
      maxOpenPositions: s.risk.maxOpenPositions,
      today: this.today(),
      analysis: s.general.watchlist.flatMap((symbol) => this.scanner.latest.get(symbol) ?? []),
    };
  }

  /** Everything the dashboard header needs. */
  status() {
    const summary = this.statusSummary();
    return {
      ...summary,
      version: "0.1.0",
      startedAt: this.startedAt,
      now: this.now(),
      tradingEnabled: this.env.TRADING_ENABLED,
      hasBinanceKeys: this.env.hasBinanceKeys,
      binanceRestUrl: this.env.binanceRestUrl,
      exchange: { ok: this.exchangeOk, error: this.exchangeError, lastReconcileAt: this.lastReconcileAt },
      userStream: this.userStream ? { connected: this.userStream.connected } : null,
      telegram: this.telegram ? this.telegram.status() : { configured: false as const },
      scanning: this.scanner.scanning,
      lastScan: this.scanner.lastReport,
      warnings: settingsWarnings(this.settings.get()),
      limits: this.limits(),
    };
  }

  /** The settings the dashboard meters and labels need. */
  private limits() {
    const { general, risk } = this.settings.get();
    return {
      entryTf: general.entryTf,
      trendTf: general.trendTf,
      riskUsd: risk.riskUsd,
      rr: risk.rr,
      maxOpenPositions: risk.maxOpenPositions,
      maxTradesPerDay: risk.maxTradesPerDay,
      maxDailyLossR: risk.maxDailyLossR,
      alertThreshold: general.alertThreshold,
      autoEntryThreshold: general.autoEntryThreshold,
    };
  }

  updateSettings(patch: unknown, by: string) {
    const result = this.settings.update(patch);
    if (!result.ok) throw new BotError(422, "INVALID_SETTINGS", "Cài đặt không hợp lệ", result.errors);
    if (result.changed.length) this.hub.emit({ type: "SETTINGS_CHANGED", by, changed: result.changed });
    return result.settings;
  }

  resetSettings(by: string): Settings {
    const result = this.settings.reset();
    if (result.changed.length) this.hub.emit({ type: "SETTINGS_CHANGED", by, changed: result.changed });
    return result.settings;
  }

  /** Live positions and orders on the account, with the bot's trade for each symbol when there is one. */
  async positions() {
    if (!this.env.hasBinanceKeys) throw new BotError(409, "NO_KEYS", "Chưa có BINANCE_API_KEY / BINANCE_API_SECRET trong .env");
    const { exchange } = this.options;
    try {
      const [positions, algos, orders, availableBalance] = await Promise.all([
        exchange.getPositions(),
        exchange.getOpenAlgoOrders(),
        exchange.getOpenOrders(),
        exchange.getAvailableBalance(),
      ]);
      const open = this.trades.listByStatusSync(["OPENING", "OPEN"]);
      return {
        positions: positions
          .filter((p) => Number(p.positionAmt) !== 0)
          .map((p) => ({ ...p, tradeId: open.find((t) => t.symbol === p.symbol)?.id ?? null })),
        algoOrders: algos,
        openOrders: orders,
        availableBalance,
      };
    } catch (error) {
      throw new BotError(424, "EXCHANGE_ERROR", errorText(error));
    }
  }

  /**
   * Everything the analysis page shows for one symbol: the last `limit` candles, the indicators and
   * levels the methods use, every trigger and 2/3-3/3 moment, each condition of each method on the
   * last closed candle, what an entry would look like now, whether the guards would allow it, and
   * the bot's trades on the symbol. Uses the candles of the last scan when they are current.
   */
  async chart(symbol: string, limit: number) {
    const settings = this.settings.get();
    const { entryTf, trendTf } = settings.general;
    const market = await this.marketFor(symbol, settings);
    if (market.entry.length < 2) throw new BotError(404, "NO_DATA", `Binance không có nến ${entryTf} cho ${symbol}`);
    const analyzer = createAnalyzer(market, settings);
    const last = analyzer.length - 1;
    const from = Math.max(0, last - limit + 1);
    const analysis = analyzer.at(last);
    const now = this.now();
    const guard = checkEntryGuards(guardStateFor(symbol, this.trades, this.control, settings, now), settings.risk);
    return {
      symbol,
      timeframe: entryTf,
      trendTimeframe: trendTf,
      inWatchlist: settings.general.watchlist.includes(symbol),
      candles: market.entry.slice(from),
      overlays: chartOverlays(market, settings, analyzer, from),
      analysis: toAnalysisView(symbol, entryTf, analysis, this.scanner.latest.get(symbol)?.episode ?? null, now),
      explanation: analyzer.explain(last),
      preview: await this.entryPreview(symbol, analysis, settings),
      guard: guard.ok ? { ok: true as const, reason: null, message: null } : { ok: false as const, reason: guard.reason, message: GUARD_MESSAGES[guard.reason] },
      thresholds: { alert: settings.general.alertThreshold, entry: settings.general.autoEntryThreshold },
      trades: this.trades.list({ symbol, limit: 30 }).trades,
      lastScanAt: this.scanner.lastReport?.finishedAt ?? null,
      nextScanAt: this.scanner.nextScanAt,
    };
  }

  private readonly chartCache = new Map<string, { market: MarketData; close: number }>();

  /** Candles of the last scan when current, else fetched (and kept until the next close). */
  private async marketFor(symbol: string, settings: Settings): Promise<MarketData> {
    const expected = lastClosedCandleTime(this.now(), timeframeMs(settings));
    const scanned = this.scanner.markets.get(symbol);
    if (scanned && (scanned.entry.at(-1)?.closeTime ?? 0) >= expected) return scanned;
    const cached = this.chartCache.get(symbol);
    if (cached && cached.close >= expected) return cached.market;
    const { entryTf, trendTf } = settings.general;
    const limits = candleLimits(settings);
    try {
      const entry = await this.options.exchange.getClosedCandles(symbol, entryTf, limits.entry);
      const trend = trendTf === entryTf ? entry : await this.options.exchange.getClosedCandles(symbol, trendTf, limits.trend);
      const market = { entry, trend };
      if (this.chartCache.size > 20) this.chartCache.clear();
      this.chartCache.set(symbol, { market, close: entry.at(-1)?.closeTime ?? 0 });
      return market;
    } catch (error) {
      throw new BotError(424, "EXCHANGE_ERROR", `Không lấy được nến ${symbol}: ${errorText(error)}`);
    }
  }

  /**
   * What an entry in the majority direction would look like at the current mark price: combined
   * stop, quantity for 1R, take profit, leverage and margin. The same functions as the executor.
   */
  private async entryPreview(symbol: string, analysis: SymbolAnalysis, settings: Settings) {
    const c = analysis.consensus;
    if (!c.direction || c.agreeing.length === 0) return null;
    const { exchange } = this.options;
    const risk = settings.risk;
    const notes: string[] = [];
    let entryPrice = analysis.price;
    try {
      entryPrice = await exchange.getMarkPrice(symbol);
    } catch {
      notes.push("Không lấy được giá mark, dùng giá đóng cửa nến");
    }
    const info = await exchange.getSymbol(symbol).catch(() => null);
    if (!info) notes.push("Không lấy được bộ lọc của symbol, chưa tính được khối lượng");
    const plan = planTrade({ direction: c.direction, signals: c.agreeing, entryPrice, atr: analysis.atr, risk, filters: info?.filters ?? null });
    const base = { direction: c.direction, agreeing: c.agreeing.length, entryPrice, notes };
    if (!plan.ok) {
      return { ...base, ok: false as const, reason: plan.reason as string, detail: plan.detail, stopLoss: plan.stopLoss, stopPct: plan.stopPct, atrMultiple: null, sizing: null, margin: null };
    }
    const sizing = plan.sizing;
    const atrMultiple = analysis.atr > 0 ? Math.abs(entryPrice - plan.stopLoss) / analysis.atr : null;
    if (sizing && !sizing.ok) {
      const detail = `${sizing.detail}${sizing.minRiskUsd ? `. Cần 1R ≥ ${sizing.minRiskUsd}$` : ""}`;
      return { ...base, ok: false as const, reason: sizing.reason as string, detail, stopLoss: plan.stopLoss, stopPct: plan.stopPct, atrMultiple, sizing: null, margin: null };
    }
    let margin: { ok: boolean; leverage: number; maxLeverage: number; margin: number; liquidationPrice: number } | null = null;
    let reason: string | null = null;
    let detail: string | null = null;
    if (sizing?.ok && this.env.hasBinanceKeys) {
      try {
        const [balance, brackets] = await Promise.all([exchange.getAvailableBalance(), exchange.getLeverageBrackets(symbol)]);
        const choice = chooseLeverage({
          direction: c.direction,
          entryPrice,
          stopLoss: Number(sizing.stopLoss),
          notional: Number(sizing.notional),
          availableBalance: balance,
          brackets,
          risk,
        });
        margin = { ok: choice.ok, leverage: choice.leverage, maxLeverage: choice.maxLeverage, margin: choice.margin, liquidationPrice: choice.liquidationPrice };
        if (!choice.ok) {
          reason = choice.reason;
          detail = choice.detail;
        }
      } catch (error) {
        notes.push(`Không kiểm tra được ký quỹ: ${errorText(error)}`);
      }
    } else if (!this.env.hasBinanceKeys) {
      notes.push("Chưa có khoá API nên chưa kiểm tra ký quỹ");
    }
    return {
      ...base,
      ok: reason === null,
      reason,
      detail,
      stopLoss: plan.stopLoss,
      stopPct: plan.stopPct,
      atrMultiple,
      sizing: sizing?.ok ? sizing : null,
      margin,
    };
  }

  /** Closes a bot trade at market; the watchdog then records it as a manual exit. */
  async closeTrade(id: string, by: string): Promise<Trade> {
    const trade = this.trades.getSync(id);
    if (!trade) throw new BotError(404, "NOT_FOUND", `Không có lệnh ${id}`);
    if (trade.status !== "OPEN" && trade.status !== "OPENING") throw new BotError(409, "NOT_OPEN", `Lệnh ${id} đang ở trạng thái ${trade.status}`);
    if (!this.env.hasBinanceKeys) throw new BotError(409, "NO_KEYS", "Chưa có khoá API Binance");
    this.logger.warn("Manual close requested", { tradeId: id, by });
    const result = await this.locks.run(trade.symbol, () => flatten(this.options.exchange, trade.symbol, trade.id));
    if (!result.flat) throw new BotError(424, "CLOSE_FAILED", `Chưa đóng được ${trade.symbol}: ${result.detail}`);
    await this.reconcile();
    return this.trades.getSync(id) ?? trade;
  }
}
