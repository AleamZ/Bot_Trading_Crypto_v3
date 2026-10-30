import { defaultSettings, type MethodSignal } from "@bot-v3/core";
import { describe, expect, it } from "vitest";
import { candleLimits, lastClosedCandleTime, Scanner } from "../src/app/scanner.js";
import { analysisOf, LONG2, LONG3, runtimeHarness, signal } from "./runtimeHarness.js";

const TF = 15 * 60_000;

function scannerHarness(env: Record<string, string> = {}) {
  const h = runtimeHarness({ env });
  h.runtime.settings.update({ general: { watchlist: ["BTCUSDT"] } });
  let signals: MethodSignal[] = [];
  let entries = 0;
  const make = () =>
    new Scanner({
      market: h.exchange,
      settings: () => h.runtime.settings.get(),
      store: h.runtime.trades,
      control: h.runtime.control,
      hub: h.runtime.hub,
      kv: h.runtime.kv,
      enter: (request) => {
        entries++;
        return h.runtime.executor.enter(request);
      },
      now: () => h.exchange.clock,
      sleep: async () => {},
      analyze: (market, settings) => analysisOf(signals, market.entry.at(-1)!.closeTime, settings),
    });
  const types = () => h.runtime.log.list({ limit: 500 }).reverse().map((e) => e.type);
  return {
    ...h,
    scanner: make(),
    make,
    set: (next: MethodSignal[]) => (signals = next),
    nextCandle: (bars = 1) => (h.exchange.clock += bars * TF),
    types,
    entries: () => entries,
  };
}

describe("Scanner: 2/3 and 3/3", () => {
  it("sends READY once per episode and again after the episode ends", async () => {
    const h = scannerHarness();
    h.set(LONG2);
    const first = await h.scanner.scanNow();
    expect(first.symbols[0]).toMatchObject({ symbol: "BTCUSDT", level: "READY", direction: "LONG", emitted: "READY", entry: null });
    h.nextCandle();
    expect((await h.scanner.scanNow()).symbols[0]!.emitted).toBeNull();
    h.set([]);
    h.nextCandle();
    await h.scanner.scanNow();
    h.set(LONG2);
    h.nextCandle();
    await h.scanner.scanNow();
    expect(h.types().filter((t) => t === "SIGNAL_READY")).toHaveLength(2);
    expect(h.entries()).toBe(0);
    expect(h.scanner.latest.get("BTCUSDT")?.consensus).toMatchObject({ level: "READY", agreeing: ["trendPullback", "donchianBreakout"] });
  });

  it("enters on 3/3 with SL and TP, once per episode", async () => {
    const h = scannerHarness();
    h.set(LONG3);
    const report = await h.scanner.scanNow();
    expect(report.symbols[0]).toMatchObject({ level: "ENTER", emitted: "ENTER", entry: "FILLED" });
    expect(h.types()).toEqual(["SIGNAL_ENTER", "ENTRY_FILLED"]);
    const [trade] = h.runtime.trades.listByStatusSync(["OPEN"]);
    expect(trade).toMatchObject({ symbol: "BTCUSDT", direction: "LONG", methods: ["trendPullback", "donchianBreakout", "smcSweep"] });
    expect(h.exchange.openAlgos()).toHaveLength(2);
    h.nextCandle();
    await h.scanner.scanNow();
    expect(h.entries()).toBe(1);
  });

  it("goes from READY to ENTER when the third method agrees", async () => {
    const h = scannerHarness();
    h.set(LONG2);
    await h.scanner.scanNow();
    h.nextCandle();
    h.set(LONG3);
    expect((await h.scanner.scanNow()).symbols[0]).toMatchObject({ emitted: "ENTER", entry: "FILLED" });
    expect(h.types().filter((t) => t.startsWith("SIGNAL_"))).toEqual(["SIGNAL_READY", "SIGNAL_ENTER"]);
  });

  it("does not enter when another method points the other way", async () => {
    const h = scannerHarness();
    // Two LONG and one SHORT: READY (alertWhenOpposed), never ENTER.
    h.set([...LONG2, signal("smcSweep", "SHORT")]);
    expect((await h.scanner.scanNow()).symbols[0]).toMatchObject({ level: "READY", emitted: "READY", entry: null });
  });
});

describe("Scanner: entry guards", () => {
  it("skips with a reason when TRADING_ENABLED is off", async () => {
    const h = scannerHarness({ TRADING_ENABLED: "false" });
    h.set(LONG3);
    expect((await h.scanner.scanNow()).symbols[0]).toMatchObject({ emitted: "ENTER", entry: "SKIPPED" });
    const skipped = h.runtime.log.list({ limit: 1 })[0]!;
    expect(skipped).toMatchObject({ type: "ENTRY_SKIPPED", level: "warn", message: "Tự vào lệnh đang tắt" });
    expect(h.entries()).toBe(0);
    expect(h.exchange.calls).not.toContain("placeMarketOrder");
  });

  it("skips while paused", async () => {
    const h = scannerHarness();
    h.runtime.control.pause("test");
    h.set(LONG3);
    await h.scanner.scanNow();
    expect(h.runtime.log.list({ limit: 1 })[0]).toMatchObject({ type: "ENTRY_SKIPPED", message: "Bot đang tạm dừng" });
  });

  it("waits out the cooldown after a trade on the symbol closed", async () => {
    const h = scannerHarness();
    h.set(LONG3);
    await h.scanner.scanNow();
    const [trade] = h.runtime.trades.listByStatusSync(["OPEN"]);
    h.exchange.setMark("BTCUSDT", Number(trade!.takeProfit) + 10);
    await h.runtime.watchdog.reconcile();
    expect(h.runtime.trades.getSync(trade!.id)).toMatchObject({ status: "CLOSED", exitReason: "TP" });

    // New episode two candles later: still inside the 4-candle cooldown.
    h.set([]);
    h.nextCandle();
    await h.scanner.scanNow();
    h.set(LONG3);
    h.nextCandle();
    await h.scanner.scanNow();
    expect(h.runtime.log.list({ limit: 1 })[0]).toMatchObject({ type: "ENTRY_SKIPPED", message: expect.stringContaining("nghỉ") });

    h.set([]);
    h.nextCandle(4);
    await h.scanner.scanNow();
    h.exchange.setMark("BTCUSDT", 68_000);
    h.set(LONG3);
    h.nextCandle();
    expect((await h.scanner.scanNow()).symbols[0]!.entry).toBe("FILLED");
  });

  it("stops at the daily loss limit", async () => {
    const h = scannerHarness();
    h.runtime.settings.update({ risk: { maxDailyLossR: 0.5 } });
    h.set(LONG3);
    await h.scanner.scanNow();
    const [trade] = h.runtime.trades.listByStatusSync(["OPEN"]);
    h.exchange.setMark("BTCUSDT", Number(trade!.stopLoss) - 10);
    await h.runtime.watchdog.reconcile();
    expect(h.runtime.trades.getSync(trade!.id)!.pnlR).toBeLessThan(-0.9);
    h.runtime.settings.update({ general: { cooldownBars: 0 } });
    h.set([]);
    h.nextCandle();
    await h.scanner.scanNow();
    h.set(LONG3);
    h.nextCandle();
    await h.scanner.scanNow();
    expect(h.runtime.log.list({ limit: 1 })[0]).toMatchObject({ type: "ENTRY_SKIPPED", message: "Đã chạm mức lỗ tối đa trong ngày" });
  });
});

describe("Scanner: restarts and data", () => {
  it("does not repeat an alert after a restart within the same episode", async () => {
    const h = scannerHarness();
    h.set(LONG2);
    await h.scanner.scanNow();
    h.nextCandle();
    const restarted = h.make();
    expect((await restarted.scanNow()).symbols[0]!.emitted).toBeNull();
  });

  it("treats a gap of several candles as a new episode", async () => {
    const h = scannerHarness();
    h.set(LONG2);
    await h.scanner.scanNow();
    h.nextCandle(6);
    expect((await h.make().scanNow()).symbols[0]!.emitted).toBe("READY");
  });

  it("retries while Binance lacks the just-closed candle, then reports one grouped failure", async () => {
    const h = scannerHarness();
    h.runtime.settings.update({ general: { watchlist: ["BTCUSDT", "ETHUSDT"] } });
    h.exchange.lagCandles = 1;
    const report = await h.scanner.scanNow();
    expect(report.symbols.every((s) => s.error?.includes("chưa trả nến"))).toBe(true);
    // 6 tries per symbol (first + 5 retries), no trend fetch.
    expect(h.exchange.candleCalls).toBe(12);
    const failed = h.runtime.log.list({ limit: 5 }).filter((e) => e.type === "SCAN_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.title).toBe("Không phân tích được BTCUSDT, ETHUSDT");
  });

  it("asks for enough candles for the slowest indicator", () => {
    expect(candleLimits(defaultSettings())).toEqual({ entry: 499, trend: 499 });
    const slow = defaultSettings();
    slow.methods.trendPullback.emaSlow = 600;
    expect(candleLimits(slow).trend).toBe(1205);
  });

  it("knows which candle has just closed", () => {
    const boundary = 1_800_000_000_000;
    expect(lastClosedCandleTime(boundary, TF)).toBe(boundary - 1);
    expect(lastClosedCandleTime(boundary + TF - 1, TF)).toBe(boundary - 1);
  });
});
