import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

/**
 * Schema versions, applied in order and recorded in PRAGMA user_version. Never edit a migration
 * that has shipped; add a new one.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE trades (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    opened_at INTEGER,
    closed_at INTEGER,
    data TEXT NOT NULL
  );
  CREATE INDEX trades_status ON trades (status);
  CREATE INDEX trades_symbol_closed ON trades (symbol, closed_at);
  CREATE INDEX trades_created ON trades (created_at);

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time INTEGER NOT NULL,
    type TEXT NOT NULL,
    level TEXT NOT NULL,
    symbol TEXT,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX events_time ON events (time);
  `,
  `
  CREATE TABLE trade_reviews (
    trade_id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    status TEXT NOT NULL,
    outcome TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    model TEXT,
    facts TEXT,
    review TEXT,
    error TEXT
  );
  CREATE INDEX trade_reviews_updated ON trade_reviews (updated_at);
  `,
];

/** Opens (or creates) the database file and brings the schema up to date. ":memory:" works for tests. */
export function openDatabase(file: string): Database {
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function schemaVersion(db: Database): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

function migrate(db: Database): void {
  const current = schemaVersion(db);
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema v${current} is newer than this bot (v${MIGRATIONS.length}); update the bot first`);
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

/** Runs `work` in one transaction (rolled back if it throws). */
export function transaction<T>(db: Database, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
