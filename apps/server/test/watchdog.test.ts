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
  it("closes out a take profit, cancels the stop and records the net R the entry promised", async () => {
    const h = await opened();
    h.api.setMark("BTCUSDT", Number(h.trade.takeProfit) + 5);
    expect(h.api.positionAmt()).toBe(0);
    const report = await h.watchdog.reconcile();
    expect(report.closed).toEqual(["t1"]);
    const t = (await h.store.get("t1"))!;
    expect(t).toMatchObject({ status: "CLOSED", exitReason: "TP" });
    expect(Number(t.exitPrice)).toBe(Number(h.trade.takeProfit));
    // Price-based TP: RR 2 on price is about 1.77R once both taker fees are paid.
    expect(t.pnlR).toBeCloseTo(h.trade.rewardAtTpR!, 3);
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

  it("still records a stop loss when Binance reports the fired stop late", async () => {
    const h = await opened();
    const real = h.api.getAlgoOrder.bind(h.api);
    let calls = 0;
    // The first look sees the stop as NEW, the second as TRIGGERED without its quantity yet.
    h.api.getAlgoOrder = async (id: string) => {
      const order = await real(id);
      if (!order || order.orderType !== "STOP_MARKET") return order;
      calls++;
      return calls === 1 ? { ...order, algoStatus: "NEW", actualQty: "0" } : calls === 2 ? { ...order, algoStatus: "TRIGGERED", actualQty: "0" } : order;
    };
    h.api.setMark("BTCUSDT", Number(h.trade.stopLoss) - 5);
    await h.watchdog.reconcile();
    expect(await h.store.get("t1")).toMatchObject({ status: "CLOSED", exitReason: "SL" });
    expect(calls).toBe(2);
  });

  it("corrects a stop loss that was recorded as a manual close", async () => {
    const h = await opened();
    const real = h.api.getAlgoOrder.bind(h.api);
    // Binance never shows the stop as fired while the close is handled.
    h.api.getAlgoOrder = async (id: string) => {
      const order = await real(id);
      return order?.orderType === "STOP_MARKET" ? { ...order, algoStatus: "NEW", actualQty: "0" } : order;
    };
    h.api.setMark("BTCUSDT", Number(h.trade.stopLoss) - 5);
    await h.watchdog.reconcile();
    expect(await h.store.get("t1")).toMatchObject({ exitReason: "MANUAL" });
    h.api.getAlgoOrder = real;
    const closed = (await h.store.listByStatus(["CLOSED"]))!;
    expect(await h.watchdog.recheckManualExits(closed)).toEqual(["t1"]);
    expect(await h.store.get("t1")).toMatchObject({ status: "CLOSED", exitReason: "SL", note: expect.stringContaining("đóng tay") });
    expect(await h.watchdog.recheckManualExits(await h.store.listByStatus(["CLOSED"]))).toEqual([]);
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

describe("Watchdog: moving the stop", () => {
  /** The price `pct` of the way from the entry to the TP. */
  const at = (trade: Trade, pct: number) => Number(trade.entryPrice) + (pct / 100) * (Number(trade.takeProfit) - Number(trade.entryPrice));

  it("moves the stop to the entry at 50% of the way, then to 50% at 75%, never leaving the position without one", async () => {
    const h = await opened();
    const entry = Number(h.trade.entryPrice);

    h.api.setMark("BTCUSDT", at(h.trade, 40));
    expect((await h.watchdog.reconcile()).stopsMoved).toEqual([]);

    h.api.setMark("BTCUSDT", at(h.trade, 55));
    expect((await h.watchdog.reconcile()).stopsMoved).toEqual(["t1"]);
    let t = (await h.store.get("t1"))!;
    expect(Number(t.stopLoss)).toBe(entry);
    expect(t.slMoves).toMatchObject([{ stage: 1, from: h.trade.stopLoss, to: t.stopLoss }]);
    expect(h.api.openAlgos().map((a) => [a.clientAlgoId, Number(a.triggerPrice)]).sort()).toEqual([
      ["v3s-t1-2", entry],
      ["v3t-t1-1", Number(h.trade.takeProfit)],
    ]);
    expect(h.events.at(-1)).toMatchObject({ type: "STOP_MOVED", move: { stage: 1 } });

    h.api.setMark("BTCUSDT", at(h.trade, 80));
    await h.watchdog.reconcile();
    t = (await h.store.get("t1"))!;
    expect(Number(t.stopLoss)).toBeCloseTo(at(h.trade, 50), 0);
    expect(Number(t.stopLoss)).toBeLessThanOrEqual(at(h.trade, 50));
    expect(t.slMoves?.map((m) => m.stage)).toEqual([1, 2]);
    expect(h.api.openAlgos().map((a) => a.clientAlgoId).sort()).toEqual(["v3s-t1-3", "v3t-t1-1"]);

    // The locked stop fills: an exit at the stop, but a win of about +0.9R after fees.
    h.api.setMark("BTCUSDT", at(h.trade, 45));
    await h.watchdog.reconcile();
    t = (await h.store.get("t1"))!;
    expect(t).toMatchObject({ status: "CLOSED", exitReason: "SL" });
    expect(t.pnlR).toBeGreaterThan(0.8);
    expect(t.pnlR).toBeLessThan(1);
  });

  it("goes straight to the locked stop when price is already past 75%", async () => {
    const h = await opened();
    h.api.setMark("BTCUSDT", at(h.trade, 90));
    await h.watchdog.reconcile();
    const t = (await h.store.get("t1"))!;
    expect(t.slMoves?.map((m) => m.stage)).toEqual([2]);
  });

  it("waits when price came back past the new stop, and moves once it is safe", async () => {
    const h = await opened();
    const t0 = (await h.store.get("t1"))!;
    t0.bestProgress = 0.6;
    await h.store.update(t0);
    // Between the original stop and the entry: a stop at the entry would fill at once.
    h.api.setMark("BTCUSDT", Number(h.trade.entryPrice) - 50);
    expect((await h.watchdog.reconcile()).stopsMoved).toEqual([]);
    expect(h.api.positionAmt()).not.toBe(0);
    h.api.setMark("BTCUSDT", at(h.trade, 10));
    expect((await h.watchdog.reconcile()).stopsMoved).toEqual(["t1"]);
    expect(Number((await h.store.get("t1"))!.stopLoss)).toBe(Number(h.trade.entryPrice));
  });

  it("keeps the old stop when the new one cannot be placed", async () => {
    const h = await opened();
    h.api.failNext("placeAlgoOrder", rejected(-1111, "bad"), { times: 3 });
    h.api.setMark("BTCUSDT", at(h.trade, 60));
    await h.watchdog.reconcile();
    expect((await h.store.get("t1"))!.stopLoss).toBe(h.trade.stopLoss);
    expect(h.api.openAlgos().map((a) => a.clientAlgoId).sort()).toEqual(["v3s-t1-1", "v3t-t1-1"]);
    expect(h.events.at(-1)).toMatchObject({ type: "ERROR" });
  });

  it("does nothing when moving the stop is off", async () => {
    const h = await opened({ risk: { moveSl: false } });
    h.api.setMark("BTCUSDT", at(h.trade, 90));
    expect((await h.watchdog.reconcile()).stopsMoved).toEqual([]);
    expect((await h.store.get("t1"))!.stopLoss).toBe(h.trade.stopLoss);
  });

  it("works the same way for a SHORT", async () => {
    const h = harness();
    const outcome = await h.executor.enter(h.request("SHORT"));
    if (!outcome.ok) throw new Error(outcome.detail);
    h.api.setMark("BTCUSDT", at(outcome.trade, 55));
    await h.watchdog.reconcile();
    expect(Number((await h.store.get("t1"))!.stopLoss)).toBe(Number(outcome.trade.entryPrice));
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
    rewardAtTpUsd: null,
    rewardAtTpR: null,
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
