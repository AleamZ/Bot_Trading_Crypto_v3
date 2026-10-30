import { describe, expect, it } from "vitest";
import { ceilToStep, dec, floorToStep, formatToStep, roundToStep, stepDecimals } from "../src/risk/decimal.js";
import type { SymbolFilters } from "../src/risk/filters.js";
import { lossPerUnit, sizePosition, type SizingInput } from "../src/risk/sizing.js";
import { rng } from "./helpers.js";

const BTC: SymbolFilters = {
  symbol: "BTCUSDT",
  tickSize: "0.10",
  stepSize: "0.001",
  minQty: "0.001",
  maxQty: "1000",
  minNotional: "100",
};

describe("step rounding", () => {
  it("floors, ceils and rounds to steps without float drift", () => {
    expect(floorToStep(0.1 + 0.2, "0.1").toString()).toBe("0.3");
    expect(floorToStep("0.3", "0.1").toString()).toBe("0.3");
    expect(floorToStep("0.0057632", "0.001").toString()).toBe("0.005");
    expect(floorToStep("1588.06", "1").toString()).toBe("1588");
    expect(floorToStep("1588.06", "10").toString()).toBe("1580");
    expect(floorToStep("0.123456789", "0.00001").toString()).toBe("0.12345");
    expect(ceilToStep("67067.53", "0.1").toString()).toBe("67067.6");
    expect(ceilToStep("67067.5", "0.1").toString()).toBe("67067.5");
    expect(roundToStep("69864.84", "0.1").toString()).toBe("69864.8");
    expect(roundToStep("69864.85", "0.1").toString()).toBe("69864.9");
    expect(floorToStep("1.0000000001", "0.001").toString()).toBe("1");
  });

  it("formats with the decimals Binance allows", () => {
    expect(stepDecimals("0.00100000")).toBe(3);
    expect(stepDecimals("1.00000000")).toBe(0);
    expect(stepDecimals("0.10")).toBe(1);
    expect(formatToStep("0.005", "0.00100000")).toBe("0.005");
    expect(formatToStep("67200", "0.10")).toBe("67200.0");
    expect(formatToStep("1588", "1")).toBe("1588");
  });

  it("rejects a step that is not positive", () => {
    expect(() => floorToStep(1, 0)).toThrow();
    expect(() => floorToStep(1, "-0.1")).toThrow();
  });
});

describe("sizePosition (1R)", () => {
  const btcLong: SizingInput = {
    direction: "LONG",
    entryPrice: 68000,
    stopLoss: 67200,
    riskUsd: 5,
    feeRate: 0.0005,
    rr: 2,
    filters: BTC,
  };

  it("sizes the BTC example from the proposal", () => {
    expect(lossPerUnit(68000, 67200, 0.0005).toString()).toBe("867.6");
    const r = sizePosition(btcLong);
    expect(r).toEqual({
      ok: true,
      quantity: "0.005",
      entryPrice: "68000",
      stopLoss: "67200.0",
      takeProfit: "69600.0",
      notional: "340.00",
      riskAtStop: "4.3380",
      riskR: 0.8676,
      clampedToMaxQty: false,
    });
  });

  it("sizes a SHORT", () => {
    const r = sizePosition({
      direction: "SHORT",
      entryPrice: 150,
      stopLoss: 152.4,
      riskUsd: 5,
      feeRate: 0.0005,
      rr: 2,
      filters: { symbol: "XUSDT", tickSize: "0.01", stepSize: "0.01", minQty: "0.01", maxQty: null, minNotional: "5" },
    });
    expect(r).toMatchObject({ ok: true, quantity: "1.95", stopLoss: "152.40", takeProfit: "145.20", notional: "292.50", riskAtStop: "4.9748" });
  });

  it("leaves fees out when the fee rate is 0", () => {
    expect(sizePosition({ ...btcLong, feeRate: 0 })).toMatchObject({ ok: true, quantity: "0.006", riskAtStop: "4.8000" });
  });

  it("works with whole-number steps", () => {
    const r = sizePosition({
      direction: "LONG",
      entryPrice: 0.15,
      stopLoss: 0.147,
      riskUsd: 5,
      feeRate: 0.0005,
      rr: 2,
      filters: { symbol: "DOGEUSDT", tickSize: "0.00001", stepSize: "1", minQty: "1", maxQty: null, minNotional: "5" },
    });
    expect(r).toMatchObject({ ok: true, quantity: "1588", stopLoss: "0.14700", takeProfit: "0.15600" });
  });

  it("rounds the stop to the tick away from the entry", () => {
    expect(sizePosition({ ...btcLong, stopLoss: 67200.07 })).toMatchObject({ ok: true, stopLoss: "67200.0" });
    const short = sizePosition({ ...btcLong, direction: "SHORT", stopLoss: 68800.01 });
    expect(short).toMatchObject({ ok: true, stopLoss: "68800.1" });
  });

  it("rejects when 1R cannot buy the minimum quantity, and says what 1R would", () => {
    const r = sizePosition({ ...btcLong, stopLoss: 61200 });
    expect(r).toEqual({
      ok: false,
      reason: "QTY_BELOW_MIN",
      detail: expect.stringContaining("0.001"),
      minRiskUsd: "6.87",
    });
  });

  it("rejects below the minimum notional instead of sizing up", () => {
    const r = sizePosition({ ...btcLong, stopLoss: 67320, riskUsd: 0.5, filters: { ...BTC, stepSize: "0.0001", minQty: "0.0001" } });
    expect(r).toMatchObject({ ok: false, reason: "NOTIONAL_BELOW_MIN", minRiskUsd: "1.13" });
  });

  it("rejects a stop on the wrong side or bad input", () => {
    expect(sizePosition({ ...btcLong, stopLoss: 68100 })).toMatchObject({ ok: false, reason: "STOP_WRONG_SIDE" });
    expect(sizePosition({ ...btcLong, direction: "SHORT" })).toMatchObject({ ok: false, reason: "STOP_WRONG_SIDE" });
    expect(sizePosition({ ...btcLong, riskUsd: 0 })).toMatchObject({ ok: false, reason: "INVALID_INPUT" });
  });

  it("clamps to the maximum quantity, which only lowers the risk", () => {
    const r = sizePosition({ ...btcLong, filters: { ...BTC, maxQty: "0.003" } });
    expect(r).toMatchObject({ ok: true, quantity: "0.003", clampedToMaxQty: true });
    expect(r.ok && r.riskR).toBeLessThan(1);
  });

  it("never risks more than 1R and leaves less than one step on the table (random cases)", () => {
    const random = rng(42);
    const steps = ["0.00001", "0.001", "0.01", "0.1", "1", "10"];
    const ticks = ["0.00001", "0.0001", "0.01", "0.1", "1"];
    let sized = 0;
    for (let n = 0; n < 3000; n++) {
      const entry = Number((0.05 + random() * 100_000).toFixed(5));
      const direction = random() < 0.5 ? "LONG" : "SHORT";
      const distancePct = 0.002 + random() * 0.03;
      const stop = direction === "LONG" ? entry * (1 - distancePct) : entry * (1 + distancePct);
      const step = steps[Math.floor(random() * steps.length)]!;
      const tick = ticks[Math.floor(random() * ticks.length)]!;
      const risk = Number((1 + random() * 99).toFixed(2));
      const feeRate = random() < 0.5 ? 0.0005 : 0;
      const r = sizePosition({
        direction,
        entryPrice: entry,
        stopLoss: stop,
        riskUsd: risk,
        feeRate,
        rr: 2,
        filters: { symbol: "T", tickSize: tick, stepSize: step, minQty: step, maxQty: null, minNotional: null },
      });
      if (!r.ok) {
        expect(["QTY_BELOW_MIN", "STOP_WRONG_SIDE"]).toContain(r.reason);
        continue;
      }
      sized++;
      const qty = dec(r.quantity);
      const perUnit = lossPerUnit(entry, r.stopLoss, feeRate);
      expect(qty.mul(perUnit).lte(risk)).toBe(true);
      expect(qty.plus(step).mul(perUnit).gt(risk)).toBe(true);
      expect(qty.mod(step).isZero()).toBe(true);
      expect(dec(r.stopLoss).mod(tick).isZero()).toBe(true);
      expect(dec(r.takeProfit).mod(tick).isZero()).toBe(true);
    }
    expect(sized).toBeGreaterThan(1500);
  });
});
