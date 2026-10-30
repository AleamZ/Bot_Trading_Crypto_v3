import { randomBytes } from "node:crypto";
import type { Trade, TradeStatus, TradeStore } from "./types.js";

/** Short, sortable, unique enough id: base36 time + 4 random chars (fits Binance's 36-char client ids). */
export function newTradeId(now = Date.now()): string {
  return `${now.toString(36)}${randomBytes(3).toString("hex").slice(0, 4)}`;
}

/**
 * Serializes work per key (symbol): the executor and the watchdog never touch the same symbol at
 * the same time.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly held = new Set<string>();

  isLocked(key: string): boolean {
    return this.held.has(key);
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    this.held.add(key);
    try {
      return await task();
    } finally {
      this.held.delete(key);
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Runs the task only if nobody holds or waits for the key right now; otherwise resolves to undefined without running it. */
  async tryRun<T>(key: string, task: () => Promise<T>): Promise<T | undefined> {
    if (this.held.has(key) || this.tails.has(key)) return undefined;
    return this.run(key, task);
  }
}

export class MemoryTradeStore implements TradeStore {
  private readonly trades = new Map<string, Trade>();

  async insert(trade: Trade): Promise<void> {
    if (this.trades.has(trade.id)) throw new Error(`Trade ${trade.id} already exists`);
    this.trades.set(trade.id, structuredClone(trade));
  }

  async update(trade: Trade): Promise<void> {
    this.trades.set(trade.id, structuredClone(trade));
  }

  async get(id: string): Promise<Trade | null> {
    const trade = this.trades.get(id);
    return trade ? structuredClone(trade) : null;
  }

  async listByStatus(statuses: readonly TradeStatus[]): Promise<Trade[]> {
    return [...this.trades.values()].filter((t) => statuses.includes(t.status)).map((t) => structuredClone(t));
  }

  all(): Trade[] {
    return [...this.trades.values()].map((t) => structuredClone(t));
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
