import { describe, expect, it } from "vitest";
import { checkEntryGuards, tradingDayKey, type GuardState } from "../src/risk/guards.js";
import { checkMargin, type MarginInput } from "../src/risk/margin.js";
import { planTrade } from "../src/risk/plan.js";
import { combineStops } from "../src/risk/stops.js";
import { defaultSettings } from "../src/settings/index.js";
import { signal } from "./helpers.js";

const risk = defaultSettings().risk;

describe("combineStops", () => {
  it("LONG: WIDEST is the lowest, TIGHTEST the highest", () => {
    expect(combineStops("LONG", [100, 98, 99], "WIDEST")).toBe(98);
    expect(combineStops("LONG", [100, 98, 99], "TIGHTEST")).toBe(100);
    expect(combineStops("LONG", [100, 98, 99], "MEDIAN")).toBe(99);
    expect(combineStops("LONG", [100, 98], "MEDIAN")).toBe(98);
  });

  it("SHORT: WIDEST is the highest, TIGHTEST the lowest", () => {
    expect(combineStops("SHORT", [100, 102, 101], "WIDEST")).toBe(102);
    expect(combineStops("SHORT", [100, 102, 101], "TIGHTEST")).toBe(100);
    expect(combineStops("SHORT", [100, 102, 101], "MEDIAN")).toBe(101);
    expect(combineStops("SHORT", [100, 102], "MEDIAN")).toBe(102);
  });

  it("needs at least one stop", () => {
    expect(() => combineStops("LONG", [], "WIDEST")).toThrow();
  });
});

describe("planTrade", () => {
  const filters = { symbol: "XUSDT", tickSize: "0.01", stepSize: "0.1", minQty: "0.1", maxQty: null, minNotional: "5" };
  const longSignals = [signal("trendPullback", "LONG", 99), signal("donchianBreakout", "LONG", 98.5), signal("smcSweep", "LONG", 98.8)];

  it("uses the widest stop and sizes for 1R", () => {
    const plan = planTrade({ direction: "LONG", signals: longSignals, entryPrice: 100, atr: 1, risk, filters });
    expect(plan).toMatchObject({ ok: true, stopLoss: 98.5, stopPct: 1.5 });
    // 5 / (1.5 + 0.0005 × 198.5) = 3.126 → 3.1 with a 0.1 step.
    expect(plan.ok && plan.sizing).toMatchObject({ ok: true, quantity: "3.1", stopLoss: "98.50", takeProfit: "103.31" });
  });

  it("follows the stop policy", () => {
    const plan = planTrade({ direction: "LONG", signals: longSignals, entryPrice: 100, atr: 1, risk: { ...risk, slPolicy: "TIGHTEST" }, filters: null });
    expect(plan).toMatchObject({ ok: true, stopLoss: 99, sizing: null });
  });

  it("rejects stops that are too close, too far, or on the wrong side", () => {
    const one = (stop: number, entryPrice = 100, atr = 10) =>
      planTrade({ direction: "LONG", signals: [signal("smcSweep", "LONG", stop)], entryPrice, atr, risk, filters: null });
    expect(one(99.9)).toMatchObject({ ok: false, reason: "STOP_TOO_CLOSE" });
    expect(one(95)).toMatchObject({ ok: false, reason: "STOP_TOO_FAR" });
    expect(one(98.5, 100, 0.4)).toMatchObject({ ok: false, reason: "STOP_TOO_FAR_ATR" });
    expect(one(99, 98.9)).toMatchObject({ ok: false, reason: "STOP_WRONG_SIDE" });
  });

  it("plans a SHORT", () => {
    const plan = planTrade({
      direction: "SHORT",
      signals: [signal("trendPullback", "SHORT", 101), signal("smcSweep", "SHORT", 101.6)],
      entryPrice: 100,
      atr: 1,
      risk,
      filters,
    });
    expect(plan).toMatchObject({ ok: true, stopLoss: 101.6 });
    expect(plan.ok && plan.sizing).toMatchObject({ ok: true, stopLoss: "101.60", takeProfit: "96.50" });
  });
});

describe("checkMargin", () => {
  const base: MarginInput = {
    direction: "LONG",
    entryPrice: 68000,
    stopLoss: 67200,
    notional: 340,
    leverage: 10,
    availableBalance: 100,
    maxMarginUsagePct: 50,
    maintenanceMarginRate: 0.004,
    liqBufferMultiple: 1.5,
  };

  it("accepts enough margin with liquidation far beyond the stop", () => {
    const r = checkMargin(base);
    expect(r).toMatchObject({ ok: true, margin: 34 });
    expect(r.liquidationPrice).toBeCloseTo(61472, 6);
  });

  it("rejects when the margin exceeds the allowed share of the balance", () => {
    expect(checkMargin({ ...base, availableBalance: 50 })).toMatchObject({ ok: false, reason: "INSUFFICIENT_MARGIN" });
  });

  it("rejects when liquidation sits too close to the stop", () => {
    const r = checkMargin({ ...base, stopLoss: 66640, leverage: 50 });
    expect(r).toMatchObject({ ok: false, reason: "LIQUIDATION_TOO_CLOSE" });
    expect(r.liquidationPrice).toBeCloseTo(66912, 6);
  });

  it("handles SHORT", () => {
    const r = checkMargin({ ...base, direction: "SHORT", stopLoss: 68800 });
    expect(r.ok).toBe(true);
    expect(r.liquidationPrice).toBeCloseTo(74528, 6);
  });
});

describe("entry guards", () => {
  const state: GuardState = {
    autoTradeAllowed: true,
    paused: false,
    openPositions: 0,
    tradesToday: 0,
    realizedRToday: 0,
    symbolBusy: false,
    cooldownUntil: null,
    now: 1_000,
  };

  it("allows a clean state", () => {
    expect(checkEntryGuards(state, risk)).toEqual({ ok: true });
  });

  it("reports each limit", () => {
    const reason = (patch: Partial<GuardState>) => {
      const r = checkEntryGuards({ ...state, ...patch }, risk);
      return r.ok ? null : r.reason;
    };
    expect(reason({ autoTradeAllowed: false })).toBe("AUTO_TRADE_OFF");
    expect(reason({ paused: true })).toBe("PAUSED");
    expect(reason({ symbolBusy: true })).toBe("SYMBOL_BUSY");
    expect(reason({ cooldownUntil: 2_000 })).toBe("COOLDOWN");
    expect(reason({ cooldownUntil: 1_000 })).toBeNull();
    expect(reason({ openPositions: 3 })).toBe("MAX_OPEN_POSITIONS");
    expect(reason({ tradesToday: 10 })).toBe("MAX_TRADES_PER_DAY");
    expect(reason({ realizedRToday: -3 })).toBe("DAILY_LOSS_LIMIT");
    expect(reason({ realizedRToday: -2.9 })).toBeNull();
  });

  it("starts the trading day at 00:00 Vietnam time", () => {
    expect(tradingDayKey(Date.UTC(2026, 9, 30, 16, 59, 59))).toBe("2026-10-30");
    expect(tradingDayKey(Date.UTC(2026, 9, 30, 17, 0, 0))).toBe("2026-10-31");
  });
});
