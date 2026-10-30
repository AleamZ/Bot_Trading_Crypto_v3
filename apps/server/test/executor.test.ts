import { dec, lossPerUnit, netResultAt } from "@bot-v3/core";
import { describe, expect, it } from "vitest";
import { rejected, unknownError } from "./fakeBinance.js";
import { harness, sig } from "./harness.js";

const lossAtStop = (qty: string, entry: string, stop: string) => dec(qty).mul(lossPerUnit(entry, stop, 0.0005));

describe("Executor: happy path", () => {
  it("enters LONG by quantity and places SL then TP, reduce-only, for exactly 1R", async () => {
    const h = harness();
    const outcome = await h.executor.enter(h.request("LONG"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const t = outcome.trade;
    expect(t).toMatchObject({ status: "OPEN", symbol: "BTCUSDT", direction: "LONG", quantity: "0.0057", entryPrice: "68000", leverage: 1, stopMode: "EXACT_1R" });
    expect(h.api.positionAmt()).toBe(0.0057);
    // AUTO leverage: 388$ of position fits in half of a 10,000$ balance at 1x.
    expect(h.api.settingsBySymbol.get("BTCUSDT")).toEqual({ marginType: "ISOLATED", leverage: 1 });

    const [sl, tp] = h.api.openAlgos();
    expect(sl).toMatchObject({ orderType: "STOP_MARKET", side: "SELL", quantity: "0.0057", triggerPrice: t.stopLoss, reduceOnly: true, workingType: "MARK_PRICE", clientAlgoId: "v3s-t1-1" });
    expect(tp).toMatchObject({ orderType: "TAKE_PROFIT_MARKET", side: "SELL", quantity: "0.0057", triggerPrice: t.takeProfit, clientAlgoId: "v3t-t1-1" });

    // Widest stop 67,200 → exact-1R stop computed from the real fill.
    expect(t.stopLoss).toBe("67190.5");
    const loss = lossAtStop(t.quantity, t.entryPrice!, t.stopLoss!);
    expect(loss.lte(5)).toBe(true);
    expect(loss.gt(4.99)).toBe(true);
    // TP = 68,000 + 2 × (68,000 − 67,190.5); after fees the win is a little under 2R.
    expect(t.takeProfit).toBe("69619.0");
    const win = netResultAt("LONG", t.entryPrice!, t.takeProfit!, t.quantity, 0.0005);
    expect(t.rewardAtTpUsd).toBe(win.toFixed(4));
    expect(t.rewardAtTpR).toBeCloseTo(1.7672, 4);
    expect(h.eventTypes()).toEqual(["ENTRY_FILLED"]);
  });

  it("enters SHORT", async () => {
    const h = harness();
    const outcome = await h.executor.enter(h.request("SHORT"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(h.api.positionAmt()).toBeLessThan(0);
    const [sl, tp] = h.api.openAlgos();
    expect(sl).toMatchObject({ orderType: "STOP_MARKET", side: "BUY" });
    expect(tp).toMatchObject({ orderType: "TAKE_PROFIT_MARKET", side: "BUY" });
    expect(Number(sl!.triggerPrice)).toBeGreaterThan(68_800 - 1);
    expect(lossAtStop(outcome.trade.quantity, outcome.trade.entryPrice!, outcome.trade.stopLoss!).lte(5)).toBe(true);
  });

  it("keeps the loss within 1R when the entry slips", async () => {
    const h = harness();
    h.api.slippage = 60;
    const outcome = await h.executor.enter(h.request("LONG"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.trade.entryPrice).toBe("68060");
    expect(lossAtStop(outcome.trade.quantity, "68060", outcome.trade.stopLoss!).lte(5)).toBe(true);
  });

  it("FIXED uses the leverage setting, capped at the symbol's maximum for the position size", async () => {
    const h = harness({ risk: { leverageMode: "FIXED" } });
    h.api.brackets = [
      { bracket: 1, initialLeverage: 5, notionalFloor: 0, notionalCap: 300, maintMarginRatio: 0.004 },
      { bracket: 2, initialLeverage: 3, notionalFloor: 300, notionalCap: 1e15, maintMarginRatio: 0.01 },
    ];
    const outcome = await h.executor.enter(h.request("LONG"));
    // 388$ of position falls in bracket 2.
    expect(outcome.ok && outcome.trade.leverage).toBe(3);
    expect(h.api.settingsBySymbol.get("BTCUSDT")?.leverage).toBe(3);
  });

  it("AUTO raises the leverage just enough for a small balance", async () => {
    const h = harness({ risk: { leverage: 50 } });
    h.api.balance = 30;
    const outcome = await h.executor.enter(h.request("LONG"));
    // 388$ of position, 15$ of margin allowed (50% of 30$): 26x.
    expect(outcome.ok && outcome.trade.leverage).toBe(26);
    expect(h.api.settingsBySymbol.get("BTCUSDT")?.leverage).toBe(26);
  });

  it("refuses with the largest 1R the balance can carry when no leverage fits", async () => {
    const h = harness({ risk: { leverage: 125 } });
    h.api.balance = 10;
    const outcome = await h.executor.enter(h.request("LONG"));
    expect(outcome).toMatchObject({ ok: false, stage: "PLAN", reason: "LIQUIDATION_TOO_CLOSE" });
    expect(outcome.ok ? "" : outcome.detail).toMatch(/chỉ đủ cho 1R ≤ [\d.]+\$; muốn 1R = 5\$ cần số dư ≥ [\d.]+\$/);
    expect(h.api.calls).not.toContain("placeMarketOrder");
  });
});

describe("Executor: refuses before sending anything", () => {
  it("refuses Hedge mode", async () => {
    const h = harness();
    h.api.hedgeMode = true;
    expect(await h.executor.enter(h.request())).toMatchObject({ ok: false, stage: "PRECHECK", reason: "HEDGE_MODE" });
    expect(h.api.calls).not.toContain("placeMarketOrder");
  });

  it("refuses a symbol that already has a position or orders, even not ours", async () => {
    const h = harness();
    h.api.openForeign("BTCUSDT", 0.01, 67_000);
    expect(await h.executor.enter(h.request())).toMatchObject({ ok: false, stage: "PRECHECK", reason: "SYMBOL_BUSY" });
    const h2 = harness();
    h2.api.openOrders.push({ symbol: "BTCUSDT", orderId: 1, clientOrderId: "manual", type: "LIMIT", side: "BUY", origQty: "1", status: "NEW", reduceOnly: false });
    expect(await h2.executor.enter(h2.request())).toMatchObject({ ok: false, reason: "SYMBOL_BUSY" });
    expect(h.api.calls).not.toContain("placeMarketOrder");
  });

  it("rejects when 1R cannot buy the minimum quantity, and says how much 1R is needed", async () => {
    const h = harness({ risk: { riskUsd: 0.1 } });
    const outcome = await h.executor.enter(h.request());
    expect(outcome).toMatchObject({ ok: false, stage: "PLAN", reason: "NOTIONAL_BELOW_MIN" });
    expect(!outcome.ok && outcome.detail).toContain("Cần 1R ≥");
    expect(h.store.all()).toEqual([]);
  });

  it("rejects without enough margin", async () => {
    const h = harness();
    h.api.balance = 20;
    expect(await h.executor.enter(h.request())).toMatchObject({ ok: false, stage: "PLAN", reason: "INSUFFICIENT_MARGIN" });
  });

  it("rejects a stop that is too far", async () => {
    const h = harness();
    const outcome = await h.executor.enter(h.request("LONG", { signals: [sig("smcSweep", "LONG", 60_000), sig("trendPullback", "LONG", 67_000)] }));
    expect(outcome).toMatchObject({ ok: false, stage: "PLAN", reason: "STOP_TOO_FAR" });
  });

  it("lets only one entry run per symbol at a time", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.executor.enter(h.request()), h.executor.enter(h.request())]);
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, reason: "SYMBOL_BUSY" });
    expect(h.api.positionAmt()).toBe(0.0057);
  });
});

describe("Executor: entry order problems", () => {
  it("marks the trade FAILED when Binance rejects the entry", async () => {
    const h = harness();
    h.api.failNext("placeMarketOrder", rejected(-2019, "Margin is insufficient."));
    const outcome = await h.executor.enter(h.request());
    expect(outcome).toMatchObject({ ok: false, stage: "ORDER", reason: "ORDER_REJECTED" });
    expect(h.store.all()[0]).toMatchObject({ status: "FAILED" });
    expect(h.api.openAlgos()).toEqual([]);
  });

  it("looks the entry up after an unknown answer and protects it when it did go through", async () => {
    const h = harness();
    h.api.failNext("placeMarketOrder", unknownError(), { executeFirst: true });
    const outcome = await h.executor.enter(h.request());
    expect(outcome).toMatchObject({ ok: true, trade: { status: "OPEN", quantity: "0.0057" } });
    expect(h.api.calls).toContain("getOrder");
    expect(h.api.openAlgos()).toHaveLength(2);
  });

  it("gives up cleanly when an unknown entry never reached the exchange", async () => {
    const h = harness();
    h.api.failNext("placeMarketOrder", unknownError());
    const outcome = await h.executor.enter(h.request());
    expect(outcome).toMatchObject({ ok: false, stage: "ORDER", reason: "ORDER_UNKNOWN" });
    expect(h.api.positionAmt()).toBe(0);
    expect(h.store.all()[0]).toMatchObject({ status: "FAILED" });
  });
});

describe("Executor: never keeps a position without SL and TP", () => {
  it("closes the position when the stop loss cannot be placed", async () => {
    const h = harness();
    h.api.failNext("placeAlgoOrder", rejected(-1111, "Precision is over the maximum defined for this asset."), { times: 3 });
    const outcome = await h.executor.enter(h.request());
    expect(outcome).toMatchObject({ ok: false, stage: "PROTECTION", reason: "SL_PLACE_FAILED" });
    expect(h.api.calls.filter((c) => c === "placeAlgoOrder")).toHaveLength(3);
    expect(h.api.positionAmt()).toBe(0);
    expect(h.api.openAlgos()).toEqual([]);
    expect(h.store.all()[0]).toMatchObject({ status: "CLOSED", exitReason: "EMERGENCY" });
    // Same price in and out: the result is the two taker fees, and it counts in the daily R.
    expect(h.store.all()[0]!.pnlR).toBeLessThan(0);
    expect(h.events.at(-1)).toMatchObject({ type: "PROTECTION_FAILED", flattened: true });
  });

  it("closes the position and cancels the stop when the take profit cannot be placed", async () => {
    const h = harness();
    h.api.failNext("placeAlgoOrder", rejected(-4005, "Quantity greater than max quantity."), {
      times: 3,
      when: (r) => (r as { type: string }).type === "TAKE_PROFIT_MARKET",
    });
    const outcome = await h.executor.enter(h.request());
    expect(outcome).toMatchObject({ ok: false, reason: "TP_PLACE_FAILED" });
    expect(h.api.positionAmt()).toBe(0);
    expect(h.api.openAlgos()).toEqual([]);
    expect(h.api.algos.find((a) => a.orderType === "STOP_MARKET")?.algoStatus).toBe("CANCELED");
  });

  it("retries a stop that failed once", async () => {
    const h = harness();
    h.api.failNext("placeAlgoOrder", rejected(-1001, "Internal error; unable to process your request."));
    expect(await h.executor.enter(h.request())).toMatchObject({ ok: true });
    expect(h.api.openAlgos()).toHaveLength(2);
  });

  it("closes at once without retrying when the price is already past the stop (-2021)", async () => {
    const h = harness();
    h.api.failNext("placeAlgoOrder", rejected(-2021, "Order would immediately trigger."), {
      when: (r) => (r as { type: string }).type === "STOP_MARKET",
    });
    const outcome = await h.executor.enter(h.request());
    expect(outcome).toMatchObject({ ok: false, reason: "SL_WOULD_TRIGGER" });
    expect(h.api.calls.filter((c) => c === "placeAlgoOrder")).toHaveLength(1);
    expect(h.api.positionAmt()).toBe(0);
  });

  it("does not duplicate a stop whose placement answered unknown but went through", async () => {
    const h = harness();
    h.api.failNext("placeAlgoOrder", unknownError(), { executeFirst: true, when: (r) => (r as { type: string }).type === "STOP_MARKET" });
    expect(await h.executor.enter(h.request())).toMatchObject({ ok: true });
    expect(h.api.openAlgos().map((a) => a.orderType)).toEqual(["STOP_MARKET", "TAKE_PROFIT_MARKET"]);
  });

  it("reports when even the emergency close fails, and leaves the trade for the watchdog", async () => {
    const h = harness();
    h.api.failNext("placeAlgoOrder", rejected(-1111, "bad"), { times: 3 });
    h.api.failNext("placeMarketOrder", rejected(-1001, "down"), { times: 3, when: (r) => (r as { reduceOnly?: boolean }).reduceOnly === true });
    const outcome = await h.executor.enter(h.request());
    expect(outcome).toMatchObject({ ok: false, stage: "PROTECTION" });
    expect(h.events.at(-1)).toMatchObject({ type: "PROTECTION_FAILED", flattened: false });
    expect(h.store.all()[0]?.status).toBe("OPENING");
    expect(h.api.positionAmt()).toBe(0.0057);

    // Next watchdog pass protects the position.
    const report = await h.watchdog.reconcile();
    expect(report.repaired).toEqual(["t1"]);
    expect(h.api.openAlgos()).toHaveLength(2);
    expect((await h.store.get("t1"))?.status).toBe("OPEN");
  });
});

describe("Executor: answers it did not expect", () => {
  it("uses the position's entry price when the order answer has no avgPrice (Binance DEMO)", async () => {
    const h = harness();
    h.api.omitAvgPrice = true;
    const outcome = await h.executor.enter(h.request("LONG"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.trade).toMatchObject({ status: "OPEN", entryPrice: "68000", quantity: "0.0057", stopLoss: "67190.5", takeProfit: "69619.0" });
    expect(h.api.openAlgos()).toHaveLength(2);
  });

  it("closes the position when anything throws after the entry filled", async () => {
    const h = harness();
    const getSymbol = h.api.getSymbol.bind(h.api);
    let calls = 0;
    h.api.getSymbol = async (symbol: string) => {
      if (++calls === 2) throw new TypeError("something unexpected");
      return getSymbol(symbol);
    };
    const outcome = await h.executor.enter(h.request("LONG"));
    expect(outcome).toMatchObject({ ok: false, stage: "PROTECTION", reason: "UNEXPECTED_ERROR" });
    expect(h.api.positionAmt()).toBe(0);
    expect(h.api.openAlgos()).toEqual([]);
    expect(h.store.all()[0]).toMatchObject({ status: "CLOSED", exitReason: "EMERGENCY" });
    expect(h.events.at(-1)).toMatchObject({ type: "PROTECTION_FAILED", flattened: true, detail: expect.stringContaining("something unexpected") });
  });
});
