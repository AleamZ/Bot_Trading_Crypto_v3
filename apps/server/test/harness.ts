import { defaultSettings, mergeSettings, type Direction, type MethodId, type MethodSignal, type Settings } from "@bot-v3/core";
import { Executor, type EntryRequest } from "../src/engine/executor.js";
import { KeyedLock, MemoryTradeStore } from "../src/engine/support.js";
import type { BotEvent } from "../src/engine/types.js";
import { Watchdog } from "../src/engine/watchdog.js";
import { FakeBinance } from "./fakeBinance.js";

export function sig(method: MethodId, direction: Direction, stopLoss: number): MethodSignal {
  return { method, direction, index: 100, time: 0, price: 68_000, stopLoss, reason: "test", levels: {} };
}

export const LONG_SIGNALS = [sig("trendPullback", "LONG", 67_500), sig("donchianBreakout", "LONG", 67_200), sig("smcSweep", "LONG", 67_400)];
export const SHORT_SIGNALS = [sig("trendPullback", "SHORT", 68_500), sig("donchianBreakout", "SHORT", 68_800), sig("smcSweep", "SHORT", 68_600)];

export function harness(patch: unknown = {}) {
  const merged = mergeSettings(defaultSettings(), patch);
  if (!merged.ok) throw new Error(JSON.stringify(merged.errors));
  const settings: Settings = merged.settings;
  const api = new FakeBinance();
  const store = new MemoryTradeStore();
  const events: BotEvent[] = [];
  const sink = { emit: (event: BotEvent) => events.push(event) };
  const locks = new KeyedLock();
  let n = 0;
  const executor = new Executor({ api, store, events: sink, locks, now: () => api.clock, sleep: async () => {}, newId: () => `t${++n}` });
  const watchdog = new Watchdog({ api, store, events: sink, locks, settings: () => settings, now: () => api.clock, sleep: async () => {} });
  const request = (direction: Direction = "LONG", overrides: Partial<EntryRequest> = {}): EntryRequest => ({
    symbol: "BTCUSDT",
    direction,
    signals: direction === "LONG" ? LONG_SIGNALS : SHORT_SIGNALS,
    atr: 400,
    settings,
    ...overrides,
  });
  const eventTypes = () => events.map((e) => e.type);
  return { api, store, events, eventTypes, locks, executor, watchdog, settings, request };
}
