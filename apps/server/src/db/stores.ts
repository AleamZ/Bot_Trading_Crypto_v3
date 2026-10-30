import type { Trade, TradeStatus, TradeStore } from "../engine/types.js";
import type { Database } from "./database.js";

/** Trades as JSON rows, with the columns the bot filters on kept alongside. */
export class SqliteTradeStore implements TradeStore {
  constructor(private readonly db: Database) {}

  async insert(trade: Trade): Promise<void> {
    this.db
      .prepare("INSERT INTO trades (id, symbol, status, created_at, opened_at, closed_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(trade.id, trade.symbol, trade.status, trade.createdAt, trade.openedAt, trade.closedAt, JSON.stringify(trade));
  }

  async update(trade: Trade): Promise<void> {
    const result = this.db
      .prepare("UPDATE trades SET symbol = ?, status = ?, opened_at = ?, closed_at = ?, data = ? WHERE id = ?")
      .run(trade.symbol, trade.status, trade.openedAt, trade.closedAt, JSON.stringify(trade), trade.id);
    if (Number(result.changes) === 0) throw new Error(`Trade ${trade.id} not found`);
  }

  async get(id: string): Promise<Trade | null> {
    return this.getSync(id);
  }

  async listByStatus(statuses: readonly TradeStatus[]): Promise<Trade[]> {
    return this.listByStatusSync(statuses);
  }

  getSync(id: string): Trade | null {
    const row = this.db.prepare("SELECT data FROM trades WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Trade) : null;
  }

  listByStatusSync(statuses: readonly TradeStatus[]): Trade[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT data FROM trades WHERE status IN (${marks}) ORDER BY created_at`).all(...statuses) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Trade);
  }

  /** Newest first. */
  list(options: { statuses?: readonly TradeStatus[]; symbol?: string; limit?: number; offset?: number } = {}): { trades: Trade[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.statuses?.length) {
      where.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
      params.push(...options.statuses);
    }
    if (options.symbol) {
      where.push("symbol = ?");
      params.push(options.symbol);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM trades ${clause}`).get(...params) as { n: number }).n);
    const rows = this.db
      .prepare(`SELECT data FROM trades ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, options.limit ?? 50, options.offset ?? 0) as { data: string }[];
    return { trades: rows.map((r) => JSON.parse(r.data) as Trade), total };
  }

  /** Trades that hold or are getting a position. */
  openCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM trades WHERE status IN ('OPENING', 'OPEN')").get() as { n: number }).n);
  }

  hasOpen(symbol: string): boolean {
    return this.db.prepare("SELECT 1 FROM trades WHERE symbol = ? AND status IN ('OPENING', 'OPEN') LIMIT 1").get(symbol) !== undefined;
  }

  /** When the last trade that really held a position on `symbol` was closed, or null. */
  lastExitAt(symbol: string): number | null {
    const row = this.db
      .prepare("SELECT MAX(closed_at) AS t FROM trades WHERE symbol = ? AND status = 'CLOSED' AND opened_at IS NOT NULL")
      .get(symbol) as { t: number | null };
    return row.t === null ? null : Number(row.t);
  }

  /** Trades whose entry filled since `since`; attempts that never filled do not count. */
  openedSince(since: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM trades WHERE opened_at >= ?").get(since) as { n: number }).n);
  }

  /** Closed trades since `since`: their count, wins, and the summed net result in R and USDT. */
  closedSince(since: number): { count: number; wins: number; r: number; pnl: number } {
    const rows = this.db.prepare("SELECT data FROM trades WHERE status = 'CLOSED' AND closed_at >= ?").all(since) as { data: string }[];
    let r = 0;
    let pnl = 0;
    let wins = 0;
    for (const row of rows) {
      const trade = JSON.parse(row.data) as Trade;
      r += trade.pnlR ?? 0;
      pnl += Number(trade.netPnl ?? 0);
      if ((trade.pnlR ?? 0) > 0) wins++;
    }
    return { count: rows.length, wins, r, pnl };
  }
}

/** Small JSON values: bot state, episodes, the Telegram update offset. */
export class KeyValueStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, JSON.stringify(value), this.now());
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }
}

export type LogLevelName = "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  time: number;
  type: string;
  level: LogLevelName;
  symbol: string | null;
  title: string;
  message: string;
  data: unknown;
}

/** The activity log the UI shows and the SSE stream replays from. */
export class EventLog {
  constructor(private readonly db: Database) {}

  append(entry: Omit<LogEntry, "id">): LogEntry {
    const result = this.db
      .prepare("INSERT INTO events (time, type, level, symbol, title, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(entry.time, entry.type, entry.level, entry.symbol, entry.title, entry.message, entry.data === undefined ? null : JSON.stringify(entry.data));
    return { ...entry, id: Number(result.lastInsertRowid) };
  }

  /** Newest first, optionally before an id (paging) and only some levels. */
  list(options: { before?: number; limit?: number; levels?: readonly LogLevelName[]; symbol?: string } = {}): LogEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.before) {
      where.push("id < ?");
      params.push(options.before);
    }
    if (options.levels?.length) {
      where.push(`level IN (${options.levels.map(() => "?").join(", ")})`);
      params.push(...options.levels);
    }
    if (options.symbol) {
      where.push("symbol = ?");
      params.push(options.symbol);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM events ${clause} ORDER BY id DESC LIMIT ?`).all(...params, options.limit ?? 100) as unknown as RawEvent[];
    return rows.map(toEntry);
  }

  /** Oldest first, everything after `id` (SSE replay after a reconnect). */
  since(id: number, limit = 200): LogEntry[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?").all(id, limit) as unknown as RawEvent[];
    return rows.map(toEntry);
  }

  /** Deletes entries older than `before`; returns how many. */
  prune(before: number): number {
    return Number(this.db.prepare("DELETE FROM events WHERE time < ?").run(before).changes);
  }
}

interface RawEvent {
  id: number;
  time: number;
  type: string;
  level: LogLevelName;
  symbol: string | null;
  title: string;
  message: string;
  data: string | null;
}

function toEntry(row: RawEvent): LogEntry {
  return {
    id: Number(row.id),
    time: Number(row.time),
    type: row.type,
    level: row.level,
    symbol: row.symbol,
    title: row.title,
    message: row.message,
    data: row.data === null ? null : (JSON.parse(row.data) as unknown),
  };
}
