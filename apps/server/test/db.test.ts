import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase, schemaVersion } from "../src/db/database.js";
import { EventLog, KeyValueStore, SqliteTradeStore } from "../src/db/stores.js";
import { sampleTrade } from "./fixtures.js";

const dir = mkdtempSync(path.join(tmpdir(), "bot-v3-db-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("database", () => {
  it("creates the schema once and reopens an existing file", () => {
    const file = path.join(dir, "nested", "bot.db");
    const db = openDatabase(file);
    expect(schemaVersion(db)).toBe(1);
    new SqliteTradeStore(db).insert(sampleTrade());
    db.close();
    const again = openDatabase(file);
    expect(schemaVersion(again)).toBe(1);
    expect(new SqliteTradeStore(again).getSync("t1")?.symbol).toBe("BTCUSDT");
    again.close();
  });
});

describe("SqliteTradeStore", () => {
  it("round-trips trades and filters by status", async () => {
    const store = new SqliteTradeStore(openDatabase(":memory:"));
    await store.insert(sampleTrade());
    await store.insert(sampleTrade({ id: "t2", symbol: "ETHUSDT", status: "FAILED", createdAt: 2_000, openedAt: null, closedAt: 2_050 }));
    await expect(store.insert(sampleTrade())).rejects.toThrow();
    expect(await store.get("t1")).toEqual(sampleTrade());
    expect((await store.listByStatus(["OPENING", "OPEN"])).map((t) => t.id)).toEqual(["t1"]);

    const t1 = sampleTrade({ status: "CLOSED", closedAt: 5_000, exitReason: "TP", netPnl: "8.9", pnlR: 1.78 });
    await store.update(t1);
    expect(await store.get("t1")).toEqual(t1);
    await expect(store.update(sampleTrade({ id: "missing" }))).rejects.toThrow("not found");
    expect(store.list().trades.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(store.list({ statuses: ["FAILED"] })).toMatchObject({ total: 1, trades: [{ id: "t2" }] });
  });

  it("answers the guard queries", async () => {
    const store = new SqliteTradeStore(openDatabase(":memory:"));
    await store.insert(sampleTrade({ id: "a", status: "CLOSED", openedAt: 100, closedAt: 200, pnlR: -1, netPnl: "-5" }));
    await store.insert(sampleTrade({ id: "b", status: "CLOSED", openedAt: 300, closedAt: 400, pnlR: 1.8, netPnl: "9" }));
    // Never filled: no cooldown, not a trade of the day.
    await store.insert(sampleTrade({ id: "c", status: "CLOSED", openedAt: null, closedAt: 900, pnlR: null }));
    await store.insert(sampleTrade({ id: "d", symbol: "ETHUSDT", status: "OPENING", openedAt: null }));
    expect(store.openCount()).toBe(1);
    expect(store.hasOpen("ETHUSDT")).toBe(true);
    expect(store.hasOpen("BTCUSDT")).toBe(false);
    expect(store.lastExitAt("BTCUSDT")).toBe(400);
    expect(store.lastExitAt("SOLUSDT")).toBeNull();
    expect(store.openedSince(250)).toBe(1);
    expect(store.closedSince(150)).toEqual({ count: 3, wins: 1, r: 0.8, pnl: 4 });
  });
});

describe("KeyValueStore and EventLog", () => {
  it("stores JSON values", () => {
    const kv = new KeyValueStore(openDatabase(":memory:"));
    expect(kv.get("paused", false)).toBe(false);
    kv.set("paused", true);
    kv.set("episodes", { BTCUSDT: { direction: "LONG" } });
    expect(kv.get("paused", false)).toBe(true);
    expect(kv.get("episodes", {})).toEqual({ BTCUSDT: { direction: "LONG" } });
    kv.delete("paused");
    expect(kv.get("paused", false)).toBe(false);
  });

  it("appends, pages, replays and prunes events", () => {
    const log = new EventLog(openDatabase(":memory:"));
    const entries = [1, 2, 3, 4].map((n) =>
      log.append({ time: n * 1000, type: "X", level: n === 4 ? "error" : "info", symbol: n % 2 ? "BTCUSDT" : null, title: `t${n}`, message: "", data: { n } }),
    );
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(log.list({ limit: 2 }).map((e) => e.title)).toEqual(["t4", "t3"]);
    expect(log.list({ before: 3 }).map((e) => e.title)).toEqual(["t2", "t1"]);
    expect(log.list({ levels: ["error"] }).map((e) => e.title)).toEqual(["t4"]);
    expect(log.list({ symbol: "BTCUSDT" }).map((e) => e.title)).toEqual(["t3", "t1"]);
    expect(log.since(2).map((e) => e.data)).toEqual([{ n: 3 }, { n: 4 }]);
    expect(log.prune(2500)).toBe(2);
    expect(log.list().length).toBe(2);
  });
});
