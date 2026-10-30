import { describe, expect, it } from "vitest";
import { rng } from "./helpers.js";
import { checkEntryGuards, tradingDayKey, type GuardState } from "../src/risk/guards.js";
import { checkMargin, chooseLeverage, maxRiskForBalance, riskAffordability, type MarginInput } from "../src/risk/margin.js";
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
    expect(plan.ok && plan.sizing).toMatchObject({ ok: true, quantity: "3.1", stopLoss: "98.50", takeProfit: "103.00" });
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
    expect(plan.ok && plan.sizing).toMatchObject({ ok: true, stopLoss: "101.60", takeProfit: "96.80" });
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

describe("chooseLeverage", () => {
  const base = {
    direction: "LONG" as const,
    entryPrice: 77_700,
    stopLoss: 77_700 * (1 - 0.0125),
    notional: 310.8,
    availableBalance: 10,
    maxMarginUsagePct: 100,
    liqBufferMultiple: 1.5,
    maxLeverage: 125,
    maintenanceMarginRate: 0.004,
    mode: "AUTO" as const,
    riskUsd: 5,
    // 310.8$ of position with a 1.25% stop loses 310.8 × (1.25% + 0.05% × 1.9875).
    riskAtStop: 310.8 * (0.0125 + 0.0005 * 1.9875),
  };

  it("AUTO takes the smallest leverage whose margin fits", () => {
    const r = chooseLeverage(base);
    expect(r).toMatchObject({ ok: true, leverage: 32 });
    expect(r.margin).toBeLessThanOrEqual(10);
  });

  it("says what 1R the balance can carry when liquidation would come before the stop", () => {
    const r = chooseLeverage({ ...base, maxMarginUsagePct: 50 });
    expect(r).toMatchObject({ ok: false, reason: "LIQUIDATION_TOO_CLOSE", leverage: 63 });
    // allowed 5$ / (1.5 × 1.25% + 0.4%) = 219.8$ of position: 1R ≤ 2.96$ (as maxRiskForBalance says),
    // and 1R = 5$ needs 370.6$ of position, so a balance of 16.86$.
    expect(r.ok ? "" : r.detail).toContain("Ở đòn bẩy 63x (mức nhỏ nhất đủ ký quỹ)");
    expect(r.ok ? "" : r.detail).toContain("chỉ đủ cho 1R ≤ 2.97$");
    expect(r.ok ? "" : r.detail).toContain("cần số dư ≥ 16.86$");
  });

  it("says when the needed leverage is above the maximum", () => {
    const r = chooseLeverage({ ...base, maxLeverage: 10 });
    expect(r).toMatchObject({ ok: false, reason: "INSUFFICIENT_MARGIN", leverage: 10 });
    expect(r.ok ? "" : r.detail).toContain("cần đòn bẩy 32x, vượt mức tối đa 10x");
  });

  it("FIXED always uses the maximum", () => {
    expect(chooseLeverage({ ...base, mode: "FIXED", maxLeverage: 40 })).toMatchObject({ ok: true, leverage: 40 });
    expect(chooseLeverage({ ...base, mode: "FIXED", maxLeverage: 10 })).toMatchObject({ ok: false, reason: "INSUFFICIENT_MARGIN" });
  });

  it("AUTO only fails when no leverage up to the maximum would pass (random cases)", () => {
    const random = rng(99);
    for (let n = 0; n < 1500; n++) {
      const entryPrice = 1 + random() * 100_000;
      const d = 0.002 + random() * 0.03;
      const input = {
        ...base,
        direction: random() < 0.5 ? ("LONG" as const) : ("SHORT" as const),
        entryPrice,
        notional: 20 + random() * 2000,
        availableBalance: 1 + random() * 300,
        maxMarginUsagePct: 10 + random() * 90,
        maxLeverage: 1 + Math.floor(random() * 60),
      };
      const stopLoss = input.direction === "LONG" ? entryPrice * (1 - d) : entryPrice * (1 + d);
      const r = chooseLeverage({ ...input, stopLoss });
      const anyPasses = Array.from({ length: input.maxLeverage }, (_, i) => i + 1).some((leverage) => checkMargin({ ...input, stopLoss, leverage }).ok);
      expect(r.ok).toBe(anyPasses);
      if (r.ok) expect(r.margin).toBeLessThanOrEqual((input.availableBalance * input.maxMarginUsagePct) / 100 + 1e-9);
    }
  });
});

describe("maxRiskForBalance", () => {
  const input = { availableBalance: 10, maxMarginUsagePct: 50, liqBufferMultiple: 1.5, maxLeverage: 125, maintenanceMarginRate: 0.004, feeRate: 0.0005, stopPct: 1.25 };

  it("gives the largest 1R a small balance can carry", () => {
    expect(maxRiskForBalance(input)).toBeCloseTo(2.965, 2);
    expect(maxRiskForBalance({ ...input, maxMarginUsagePct: 100 })).toBeCloseTo(5.93, 1);
    expect(maxRiskForBalance({ ...input, availableBalance: 0 })).toBe(0);
  });

  it("grows with a wider stop and is capped by the maximum leverage", () => {
    expect(maxRiskForBalance({ ...input, stopPct: 3 })).toBeGreaterThan(maxRiskForBalance(input));
    expect(maxRiskForBalance({ ...input, maxLeverage: 10 })).toBeCloseTo(50 * (0.0125 + 0.0005 * 1.9875), 6);
  });
});

describe("riskAffordability", () => {
  const risk = defaultSettings().risk;

  it("is fine for a 5$ 1R on a large balance", () => {
    expect(riskAffordability(risk, 4316)).toMatchObject({ level: "ok", message: null });
  });

  it("says no trade can open with 1R = 5$ on 10$ at 50% margin", () => {
    const a = riskAffordability(risk, 10);
    expect(a.level).toBe("none");
    expect(a.maxRiskAtMaxSl).toBeLessThan(5);
    expect(a.message).toContain("bot sẽ không vào được lệnh nào");
  });

  it("finds the stop range that still works", () => {
    const a = riskAffordability({ ...risk, riskUsd: 5, maxMarginUsagePct: 100, leverage: 125 }, 10);
    expect(a.level).toBe("partial");
    expect(a.fitsFrom).toBeGreaterThan(risk.minSlPct);
    expect(a.fitsTo).toBe(risk.maxSlPct);
    expect(a.message).toContain("chỉ vào được lệnh có SL từ");
  });

  it("FIXED leverage rules out stops wider than its liquidation allows", () => {
    const a = riskAffordability({ ...risk, riskUsd: 1, leverage: 50, leverageMode: "FIXED" as const }, 1000);
    // 50x liquidates about 1.6% away: stops wider than ~1.07% (×1.5) cannot be used.
    expect(a.level).toBe("partial");
    expect(a.fitsTo!).toBeLessThan(1.1);
  });
});
