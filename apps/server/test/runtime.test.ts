import { describe, expect, it, vi } from "vitest";
import { tradingDayStart } from "../src/app/control.js";
import { LONG3, runtimeHarness } from "./runtimeHarness.js";

describe("BotRuntime", () => {
  it("starts: reports how it runs, reconciles, scans, and sends the start message to Telegram", async () => {
    const h = runtimeHarness({ telegram: true, env: { TRADING_ENABLED: "false" } });
    h.runtime.settings.update({ general: { watchlist: ["BTCUSDT"] } });
    await h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.scanner.lastReport).not.toBeNull());
    const types = h.runtime.log.list({ limit: 10 }).map((e) => e.type);
    expect(types.at(-1)).toBe("BOT_STARTED");
    expect(h.exchange.calls).toContain("getPositions");
    await vi.waitFor(() => expect(h.telegram.sent()[0]).toContain("Tự vào lệnh: TẮT (TRADING_ENABLED=false)"));
    expect(h.runtime.status()).toMatchObject({ tradingEnabled: false, autoTradeAllowed: false, paused: false, exchange: { ok: true } });
    await h.runtime.stop("test");
    expect(h.runtime.log.list({ limit: 1 })[0]!.type).toBe("BOT_STOPPING");
  });

  it("reports Binance going down once and coming back once", async () => {
    const h = runtimeHarness();
    const original = h.exchange.getPositions.bind(h.exchange);
    let down = true;
    h.exchange.getPositions = async (symbol?: string) => {
      if (down) throw new Error("ECONNRESET");
      return original(symbol);
    };
    await h.runtime.reconcile();
    await h.runtime.reconcile();
    down = false;
    await h.runtime.reconcile();
    await h.runtime.reconcile();
    const statuses = h.runtime.log.list({ limit: 10 }).filter((e) => e.type === "EXCHANGE_STATUS").reverse();
    expect(statuses.map((e) => e.title)).toEqual(["Không gọi được Binance", "Đã kết nối lại Binance"]);
  });

  it("does not call signed endpoints without API keys", async () => {
    const h = runtimeHarness({ env: { BINANCE_API_KEY: "", BINANCE_API_SECRET: "" } });
    h.runtime.settings.update({ general: { watchlist: ["BTCUSDT"] } });
    await h.runtime.start();
    await vi.waitFor(() => expect(h.runtime.scanner.lastReport).not.toBeNull());
    expect(h.exchange.calls).toEqual([]);
    expect(h.runtime.control.autoTradeBlockers()).toContain("Chưa có BINANCE_API_KEY / BINANCE_API_SECRET trong .env");
    await h.runtime.stop();
  });

  it("counts today's results from 00:00 Vietnam time", async () => {
    const h = runtimeHarness();
    const outcome = await h.runtime.executor.enter({ symbol: "BTCUSDT", direction: "LONG", signals: LONG3, atr: 400, settings: h.runtime.settings.get() });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    h.exchange.setMark("BTCUSDT", Number(outcome.trade.stopLoss) - 5);
    await h.runtime.reconcile();
    const today = h.runtime.today();
    expect(today).toMatchObject({ opened: 1, open: 0, closed: { count: 1, wins: 0 } });
    expect(today.closed.r).toBeCloseTo(-1, 1);
  });

  it("puts the trading day boundary at 17:00 UTC", () => {
    expect(new Date(tradingDayStart(Date.UTC(2026, 9, 30, 16, 59))).toISOString()).toBe("2026-10-29T17:00:00.000Z");
    expect(new Date(tradingDayStart(Date.UTC(2026, 9, 30, 17, 0))).toISOString()).toBe("2026-10-30T17:00:00.000Z");
  });
});
