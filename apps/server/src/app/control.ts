import {
  defaultSettings,
  mergeSettings,
  TIMEFRAME_MINUTES,
  TRADING_DAY_OFFSET_MINUTES,
  type GuardState,
  type Settings,
  type SettingsParseResult,
} from "@bot-v3/core";
import type { KeyValueStore, SqliteTradeStore } from "../db/stores.js";
import { silentLogger, type Logger } from "../lib/logger.js";
import type { EventHub } from "./events.js";

const SETTINGS_KEY = "settings";

export interface SettingsUpdate {
  ok: true;
  settings: Settings;
  /** Leaf paths that changed. */
  changed: string[];
}
const PAUSED_KEY = "paused";
const STATS_SINCE_KEY = "stats.since";

/**
 * The settings the UI edits, stored in the database. They only hold what the schema allows, so
 * the env safety switches (BINANCE_ENV, TRADING_ENABLED, keys) can never be overridden from here.
 */
export class SettingsService {
  private current: Settings;
  private readonly listeners = new Set<(settings: Settings) => void>();
  /** Why the stored settings were not usable at startup (the defaults are used instead). */
  readonly loadErrors: { path: string; message: string }[] = [];

  constructor(
    private readonly kv: KeyValueStore,
    private readonly logger: Logger = silentLogger,
  ) {
    const stored = kv.get<unknown>(SETTINGS_KEY, null);
    // Merging onto the defaults lets a stored row from an older version pick up new fields.
    const merged = stored === null ? null : mergeSettings(defaultSettings(), stored);
    if (merged && !merged.ok) {
      this.loadErrors.push(...merged.errors);
      this.logger.error("Stored settings are invalid; using defaults", { errors: merged.errors });
    }
    this.current = merged?.ok ? merged.settings : defaultSettings();
  }

  get(): Settings {
    return this.current;
  }

  /** Applies a partial update; nothing is saved when the result is invalid. */
  update(patch: unknown): SettingsUpdate | Extract<SettingsParseResult, { ok: false }> {
    const result = mergeSettings(this.current, patch);
    if (!result.ok) return result;
    return this.replace(result.settings);
  }

  reset(): SettingsUpdate {
    return this.replace(defaultSettings());
  }

  onChange(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private replace(next: Settings): SettingsUpdate {
    const changed = diffPaths(this.current, next);
    this.kv.set(SETTINGS_KEY, next);
    this.current = next;
    if (changed.length) for (const listener of this.listeners) listener(next);
    return { ok: true, settings: next, changed };
  }
}

/** Leaf paths whose value differs ("risk.riskUsd", "general.watchlist"). */
export function diffPaths(a: unknown, b: unknown, prefix = ""): string[] {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((key) => diffPaths(a[key], b[key], prefix ? `${prefix}.${key}` : key));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}

export interface ControlEnv {
  tradingEnabled: boolean;
  hasBinanceKeys: boolean;
}

/** Pause/resume (from the UI or Telegram) and whether the bot may open trades on its own. */
export class BotControl {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly env: ControlEnv,
    private readonly settings: () => Settings,
    private readonly hub: EventHub,
  ) {}

  get paused(): boolean {
    return this.kv.get(PAUSED_KEY, false);
  }

  /** Returns false when it was already paused. */
  pause(by: string): boolean {
    if (this.paused) return false;
    this.kv.set(PAUSED_KEY, true);
    this.hub.emit({ type: "BOT_PAUSED", by });
    return true;
  }

  resume(by: string): boolean {
    if (!this.paused) return false;
    this.kv.set(PAUSED_KEY, false);
    this.hub.emit({ type: "BOT_RESUMED", by });
    return true;
  }

  /** When the P&L figures were last cleared, or null: stats, the trade list and today's limits start there. */
  get statsSince(): number | null {
    return this.kv.get<number | null>(STATS_SINCE_KEY, null);
  }

  /** Clears the P&L figures from `now` on. Trades and AI reviews stay in the database. */
  resetStats(by: string, now: number): number {
    this.kv.set(STATS_SINCE_KEY, now);
    this.hub.emit({ type: "STATS_RESET", by, since: now });
    return now;
  }

  /** Counts every trade again. */
  restoreStats(by: string): void {
    this.kv.delete(STATS_SINCE_KEY);
    this.hub.emit({ type: "STATS_RESET", by, since: null });
  }

  /** What keeps automatic entries off, in Vietnamese; empty when they are allowed (pausing aside). */
  autoTradeBlockers(): string[] {
    const blockers: string[] = [];
    if (!this.env.tradingEnabled) blockers.push("TRADING_ENABLED=false trong .env");
    if (!this.env.hasBinanceKeys) blockers.push("Chưa có BINANCE_API_KEY / BINANCE_API_SECRET trong .env");
    if (!this.settings().general.autoTrade) blockers.push("Tắt \"Tự vào lệnh\" trong cài đặt");
    return blockers;
  }

  autoTradeAllowed(): boolean {
    return this.autoTradeBlockers().length === 0;
  }
}

/** Start of the trading day (00:00 Vietnam time) that `now` falls in. */
export function tradingDayStart(now: number, offsetMinutes = TRADING_DAY_OFFSET_MINUTES): number {
  const day = 86_400_000;
  const offset = offsetMinutes * 60_000;
  return Math.floor((now + offset) / day) * day - offset;
}

export function timeframeMs(settings: Settings): number {
  return TIMEFRAME_MINUTES[settings.general.entryTf] * 60_000;
}

/** Everything checkEntryGuards needs, from the bot's own trades. */
export function guardStateFor(symbol: string, store: SqliteTradeStore, control: BotControl, settings: Settings, now: number): GuardState {
  const lastExit = store.lastExitAt(symbol);
  const cooldownMs = settings.general.cooldownBars * timeframeMs(settings);
  const from = limitsStart(now, control.statsSince);
  return {
    autoTradeAllowed: control.autoTradeAllowed(),
    paused: control.paused,
    openPositions: store.openCount(),
    tradesToday: store.openedSince(from),
    realizedRToday: store.closedSince(from).r,
    symbolBusy: store.hasOpen(symbol),
    cooldownUntil: lastExit !== null && cooldownMs > 0 ? lastExit + cooldownMs : null,
    now,
  };
}

/** Where today's counts start: 00:00 Vietnam time, or the last clear of the P&L figures if later. */
export function limitsStart(now: number, statsSince: number | null): number {
  return Math.max(tradingDayStart(now), statsSince ?? 0);
}

export function todayStats(store: SqliteTradeStore, now: number, statsSince: number | null = null) {
  const dayStart = tradingDayStart(now);
  const from = limitsStart(now, statsSince);
  return { dayStart, from, opened: store.openedSince(from), closed: store.closedSince(from), open: store.openCount() };
}
