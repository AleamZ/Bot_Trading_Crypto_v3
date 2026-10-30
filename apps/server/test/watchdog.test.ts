import { describe, expect, it } from "vitest";
import { closedStats } from "../src/engine/protection.js";
import type { Trade } from "../src/engine/types.js";
import { rejected } from "./fakeBinance.js";
import { harness } from "./harness.js";

async function opened(patch: unknown = {}) {
  const h = harness(patch);
  const outcome = await h.executor.enter(h.request("LONG"));
  if (!outcome.ok) throw new Error(`entry failed: ${outcome.reason} ${outcome.detail}`);
  h.events.length = 0;
  return { ...h, trade: outcome.trade };
}

describe("Watchdog: exits", () => {
  it("closes out a take profit, cancels the stop and records +2R net of fees", async () => {
    const h = await opened();
    h.api.setMark("BTCUSDT", Number(h.trade.takeProfit) + 5);
    expect(h.api.positionAmt()).toBe(0);
    const report = await h.watchdog.reconcile();
    expect(report.closed).toEqual(["t1"]);
    const t = (await h.store.get("t1"))!;
    expect(t).toMatchObject({ status: "CLOSED", exitReason: "TP" });
    expect(Number(t.exitPrice)).toBe(Number(h.trade.takeProfit));
    expect(t.pnlR).toBeGreaterThan(1.99);
    expect(t.pnlR).toBeLessThan(2.01);
    expect(h.api.openAlgos()).toEqual([]);
    expect(h.api.algos.find((a) => a.orderType === "STOP_MARKET")?.algoStatus).toBe("CANCELED");
    expect(h.eventTypes()).toEqual(["TRADE_CLOSED"]);
  });

  it("closes out a stop loss at about -1R, fees included", async () => {
    const h = await opened();
    h.api.setMark("BTCUSDT", Number(h.trade.stopLoss) - 5);
    await h.watchdog.reconcile();
    const t = (await h.store.get("t1"))!;
    expect(t).toMatchObject({ status: "CLOSED", exitReason: "SL" });
    expect(t.pnlR).toBeGreaterThanOrEqual(-1);
    expect(t.pnlR).toBeLessThan(-0.99);
    expect(Number(t.netPnl)).toBeGreaterThanOrEqual(-5);
    expect(h.api.openAlgos()).toEqual([]);
  });

  it("records a manual close", async () => {
    const h = await opened();
    await h.api.placeMarketOrder({ symbol: "BTCUSDT", side: "SELL", quantity: "0.0057", clientOrderId: "manual-1", reduceOnly: true });
    await h.watchdog.reconcile();
    expect(await h.store.get("t1")).toMatchObject({ status: "CLOSED", exitReason: "MANUAL" });
    expect(h.api.openAlgos()).toEqual([]);
  });

  it("does nothing while nothing changed", async () => {
    const h = await opened();
    const report = await h.watchdog.reconcile();
    expect(report).toMatchObject({ checked: 1, closed: [], repaired: [], flattened: [] });
    expect(h.events).toEqual([]);
  });
});

describe("Watchdog: protection", () => {
  it("puts back a stop loss that disappeared", async () => {
    const h = await opened();
    await h.api.cancelAlgoOrder("BTCUSDT", "v3s-t1-1");
    const report = await h.watchdog.reconcile();
    expect(report.repaired).toEqual(["t1"]);
    expect(h.api.openAlgos().map((a) => a.clientAlgoId).sort()).toEqual(["v3s-t1-2", "v3t-t1-1"]);
    const t = (await h.store.get("t1"))!;
    expect(t).toMatchObject({ slClientId: "v3s-t1-2", tpClientId: "v3t-t1-1", protectionVersion: 2 });
    expect(h.events.at(-1)).toMatchObject({ type: "PROTECTION_REPAIRED", legs: ["SL"] });
  });

  it("closes the position when a missing leg cannot be put back", async () => {
    const h = await opened();
    await h.api.cancelAlgoOrder("BTCUSDT", "v3t-t1-1");
    h.api.failNext("placeAlgoOrder", rejected(-1111, "bad"), { times: 3 });
    const report = await h.watchdog.reconcile();
    expect(report.flattened).toEqual(["t1"]);
    expect(h.api.positionAmt()).toBe(0);
    expect(h.api.openAlgos()).toEqual([]);
    expect(await h.store.get("t1")).toMatchObject({ status: "CLOSED", exitReason: "EMERGENCY" });
    expect(h.eventTypes()).toEqual(["TRADE_CLOSED", "PROTECTION_FAILED"]);
  });

  it("resizes both legs when the position was partly closed by hand", async () => {
    const h = await opened();
    await h.api.placeMarketOrder({ symbol: "BTCUSDT", side: "SELL", quantity: "0.0020", clientOrderId: "manual-2", reduceOnly: true });
    await h.watchdog.reconcile();
    const open = h.api.openAlgos();
    expect(open.map((a) => [a.clientAlgoId, a.quantity])).toEqual([
      ["v3s-t1-2", "0.0037"],
      ["v3t-t1-2", "0.0037"],
    ]);
    expect((await h.store.get("t1"))?.quantity).toBe("0.0037");
  });

  it("leaves a leg alone while it is firing", async () => {
    const h = await opened();
    h.api.algos.find((a) => a.clientAlgoId === "v3s-t1-1")!.algoStatus = "TRIGGERING";
    const report = await h.watchdog.reconcile();
    expect(report.repaired).toEqual([]);
    expect(h.api.calls.filter((c) => c === "placeAlgoOrder")).toHaveLength(2);
  });

  it("skips a symbol the executor is working on", async () => {
    const h = await opened();
    await h.api.cancelAlgoOrder("BTCUSDT", "v3s-t1-1");
    let release!: () => void;
    const busy = h.locks.run("BTCUSDT", () => new Promise<void>((resolve) => (release = resolve)));
    await Promise.resolve();
    const report = await h.watchdog.reconcile();
    expect(report.skippedLocked).toEqual(["BTCUSDT"]);
    release();
    await busy;
    expect((await h.watchdog.reconcile()).repaired).toEqual(["t1"]);
  });
});

describe("Watchdog: after a crash", () => {
  const opening = (h: ReturnType<typeof harness>): Trade => ({
    id: "c1",
    symbol: "BTCUSDT",
    direction: "LONG",
    status: "OPENING",
    methods: ["trendPullback", "donchianBreakout", "smcSweep"],
    createdAt: h.api.clock,
    openedAt: null,
    closedAt: null,
    plannedEntry: 68_000,
    structuralStop: 67_200,
    riskUsd: 5,
    rr: 2,
    leverage: 10,
    entryClientId: "v3e-c1",
    quantity: "0",
    entryPrice: null,
    stopLoss: null,
    takeProfit: null,
    stopMode: null,
    riskAtStopUsd: null,
    riskAtStopR: null,
    slClientId: null,
    tpClientId: null,
    protectionVersion: 0,
    exitReason: null,
    exitPrice: null,
    netPnl: null,
    fees: null,
    pnlR: null,
    note: null,
  });

  it("protects a position whose entry filled right before the bot stopped", async () => {
    const h = harness();
    await h.store.insert(opening(h));
    await h.api.placeMarketOrder({ symbol: "BTCUSDT", side: "BUY", quantity: "0.0057", clientOrderId: "v3e-c1" });
    const report = await h.watchdog.reconcile();
    expect(report.repaired).toEqual(["c1"]);
    const t = (await h.store.get("c1"))!;
    expect(t).toMatchObject({ status: "OPEN", quantity: "0.0057", entryPrice: "68000", stopLoss: "67190.5" });
    expect(h.api.openAlgos()).toHaveLength(2);
  });

  it("marks an attempt that never reached the exchange as FAILED", async () => {
    const h = harness();
    await h.store.insert(opening(h));
    await h.watchdog.reconcile();
    expect(await h.store.get("c1")).toMatchObject({ status: "FAILED" });
  });
});

describe("Watchdog: things the bot does not own", () => {
  it("reports a foreign position once and never touches it", async () => {
    const h = harness();
    h.api.openForeign("ETHUSDT", 1, 3000);
    expect((await h.watchdog.reconcile()).foreign).toEqual(["ETHUSDT"]);
    expect((await h.watchdog.reconcile()).foreign).toEqual([]);
    expect(h.eventTypes()).toEqual(["FOREIGN_POSITION"]);
    expect(h.api.positionAmt("ETHUSDT")).toBe(1);
    expect(h.api.calls).not.toContain("placeMarketOrder");
  });

  it("cancels the bot's leftover algo orders on a symbol it no longer trades", async () => {
    const h = harness();
    h.api.algos.push({ ...(await placeLeftover(h)) });
    const report = await h.watchdog.reconcile();
    expect(report.orphansCanceled).toEqual(["v3s-old-1"]);
  });
});

async function placeLeftover(h: ReturnType<typeof harness>) {
  h.api.marks.set("ETHUSDT", 3000);
  return {
    algoId: 999,
    clientAlgoId: "v3s-old-1",
    symbol: "ETHUSDT",
    side: "SELL" as const,
    orderType: "STOP_MARKET",
    quantity: "1",
    triggerPrice: "2900",
    algoStatus: "NEW",
    reduceOnly: true,
    workingType: "MARK_PRICE",
    actualPrice: "0",
    actualQty: "0",
    createTime: 0,
    updateTime: 0,
  };
}

describe("closedStats", () => {
  it("computes exit price, fees and net PnL from the fills", () => {
    const stats = closedStats("LONG", [
      { id: 1, orderId: 1, symbol: "X", side: "BUY", price: "100", qty: "2", realizedPnl: "0", commission: "0.1", commissionAsset: "USDT", time: 1 },
      { id: 2, orderId: 2, symbol: "X", side: "SELL", price: "104", qty: "1", realizedPnl: "4", commission: "0.052", commissionAsset: "USDT", time: 2 },
      { id: 3, orderId: 3, symbol: "X", side: "SELL", price: "106", qty: "1", realizedPnl: "6", commission: "0.053", commissionAsset: "USDT", time: 3 },
    ]);
    expect(stats).toEqual({ exitPrice: "105", netPnl: "9.7950", fees: "0.2050" });
  });
});
