import {
  decideConsensus,
  defaultSettings,
  METHOD_IDS,
  type Candle,
  type MethodId,
  type MethodSignal,
  type Settings,
  type SymbolAnalysis,
} from "@bot-v3/core";
import { AiClient } from "../src/ai/client.js";
import { BotRuntime } from "../src/app/runtime.js";
import { lastClosedCandleTime } from "../src/app/scanner.js";
import { parseEnv, type AppEnv } from "../src/config/env.js";
import { openDatabase } from "../src/db/database.js";
import { TelegramClient } from "../src/telegram/client.js";
import { FakeBinance } from "./fakeBinance.js";

const TF = 15 * 60_000;

/** FakeBinance plus the market data and listen-key calls the runtime needs. */
export class FakeExchange extends FakeBinance {
  /** When set, getClosedCandles returns candles ending this many candles before the last close. */
  lagCandles = 0;
  candleCalls = 0;
  failCandles: Error | null = null;

  async getClosedCandles(_symbol: string, interval: string, limit: number): Promise<Candle[]> {
    this.candleCalls++;
    if (this.failCandles) throw this.failCandles;
    const tf = interval === "1h" ? 3_600_000 : TF;
    const last = lastClosedCandleTime(this.clock, tf) - this.lagCandles * tf;
    const n = Math.min(limit, 3);
    return Array.from({ length: n }, (_, i) => {
      const closeTime = last - (n - 1 - i) * tf;
      return { openTime: closeTime + 1 - tf, open: 68_000, high: 68_100, low: 67_900, close: 68_000, volume: 1, closeTime };
    });
  }

  /** Candles per "SYMBOL:interval"; without an entry, flat candles at 68,000 are made up. */
  readonly candleBook = new Map<string, Candle[]>();

  async getCandlesBetween(symbol: string, interval: string, startTime: number, endTime: number): Promise<Candle[]> {
    const book = this.candleBook.get(`${symbol}:${interval}`);
    if (book) return book.filter((c) => c.closeTime >= startTime && c.openTime <= endTime && c.closeTime < this.clock);
    const tf = interval === "1h" ? 3_600_000 : TF;
    const out: Candle[] = [];
    for (let open = Math.floor(startTime / tf) * tf; open + tf - 1 < Math.min(endTime, this.clock); open += tf) {
      out.push({ openTime: open, open: 68_000, high: 68_100, low: 67_900, close: 68_000, volume: 1, closeTime: open + tf - 1 });
    }
    return out;
  }

  async createListenKey(): Promise<string> {
    return "listen-key";
  }

  async keepAliveListenKey(): Promise<void> {}
}

/** A core analysis result with exactly these active signals. */
export function analysisOf(signals: readonly MethodSignal[], time: number, settings: Settings = defaultSettings()): SymbolAnalysis {
  const methods = {} as SymbolAnalysis["methods"];
  for (const id of METHOD_IDS) methods[id] = { enabled: true, signal: signals.find((s) => s.method === id) ?? null };
  return { index: 499, time, price: 68_000, atr: 400, methods, consensus: decideConsensus(signals, settings.general) };
}

export function signal(method: MethodId, direction: "LONG" | "SHORT", stopLoss?: number): MethodSignal {
  const stop = stopLoss ?? (direction === "LONG" ? 67_200 : 68_800);
  return { method, direction, index: 499, time: 0, price: 68_000, stopLoss: stop, reason: `${method} test`, levels: {} };
}

export const LONG3 = [signal("trendPullback", "LONG", 67_500), signal("donchianBreakout", "LONG", 67_200), signal("smcSweep", "LONG", 67_400)];
export const LONG2 = LONG3.slice(0, 2);

export interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

/**
 * A fetch for the Telegram client: records every call; getUpdates hands out `updates` once, then
 * waits until aborted, like a real long poll.
 */
export function fakeTelegramFetch() {
  const calls: TelegramCall[] = [];
  const updates: unknown[] = [];
  let respond: ((method: string, body: Record<string, unknown>) => Response | null) | null = null;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    const custom = respond?.(method, body);
    if (custom) return custom;
    if (method === "getUpdates") {
      if (updates.length) return Response.json({ ok: true, result: updates.splice(0) });
      await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: calls.length, date: 0, chat: { id: body.chat_id, type: "private" } } });
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    calls,
    updates,
    sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text)),
    respondWith: (fn: typeof respond) => (respond = fn),
  };
}

/** A scripted OpenAI-compatible endpoint: each call takes the next reply (text or tool calls). */
export function fakeAi() {
  const bodies: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  const replies: ({ content?: string; tools?: { name: string; args: unknown }[] } | { status: number; text: string })[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const next = replies.shift() ?? { content: "ok" };
    if ("status" in next) return new Response(next.text, { status: next.status });
    const tool_calls = next.tools?.map((t, i) => ({ id: `c${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }));
    return Response.json({ model: "fake-model", choices: [{ message: { content: next.content ?? "", ...(tool_calls ? { tool_calls } : {}) } }] });
  }) as typeof fetch;
  return { fetch: fetchImpl, bodies, headers, replies };
}

export interface RuntimeHarnessOptions {
  env?: Record<string, string>;
  telegram?: boolean;
  ai?: ReturnType<typeof fakeAi>;
}

export function runtimeHarness(options: RuntimeHarnessOptions = {}) {
  const env: AppEnv = parseEnv({
    BINANCE_API_KEY: "key",
    BINANCE_API_SECRET: "secret",
    TRADING_ENABLED: "true",
    DB_PATH: ":memory:",
    ...(options.telegram ? { TELEGRAM_BOT_TOKEN: "123:SECRET-TOKEN", TELEGRAM_CHAT_ID: "42" } : {}),
    ...options.env,
  });
  const exchange = new FakeExchange();
  const telegram = fakeTelegramFetch();
  const db = openDatabase(":memory:");
  const runtime = new BotRuntime({
    env,
    db,
    exchange,
    telegramClient: env.TELEGRAM_BOT_TOKEN ? new TelegramClient(env.TELEGRAM_BOT_TOKEN, { fetch: telegram.fetch }) : null,
    aiClient: options.ai ? new AiClient({ baseUrl: "http://ai.test/v1", apiKey: "sk-test-SECRET", model: "fake-model", timeoutMs: 5000 }, options.ai.fetch) : null,
    now: () => exchange.clock,
    createSocket: null,
    watchdogIntervalMs: 3_600_000,
  });
  return { env, exchange, telegram, db, runtime };
}
