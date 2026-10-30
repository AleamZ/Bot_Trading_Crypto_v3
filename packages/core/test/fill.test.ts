import { describe, expect, it } from "vitest";
import { dec } from "../src/risk/decimal.js";
import { finalizeAfterFill, type FillInput } from "../src/risk/fill.js";
import { lossPerUnit } from "../src/risk/sizing.js";
import { netResultAt } from "../src/risk/targets.js";
import { rng } from "./helpers.js";

const btc: FillInput = {
  direction: "LONG",
  fillPrice: 68000,
  filledQty: "0.005",
  structuralStop: 67200,
  riskUsd: 5,
  feeRate: 0.0005,
  rr: 2,
  mode: "EXACT_1R",
  maxSlWidenPct: 25,
  tickSize: "0.10",
};

const lossOf = (input: FillInput, stop: string) => dec(input.filledQty).mul(lossPerUnit(input.fillPrice, stop, input.feeRate));

describe("finalizeAfterFill", () => {
  it("EXACT_1R moves the stop so the real fill loses 1R (proposal example)", () => {
    const r = finalizeAfterFill(btc);
    expect(r).toEqual({
      ok: true,
      stopLoss: "67067.6",
      // 68000 + 2 × (68000 − 67067.6): the price the analysis gives; fees make the net win ~1.8R.
      takeProfit: "69864.8",
      riskUsd: "4.9997",
      riskR: expect.closeTo(0.99993, 5),
      rewardUsd: "8.9793",
      rewardR: expect.closeTo(1.79587, 5),
      mode: "EXACT_1R",
      fellBack: false,
    });
  });

  it("EXACT_1R works for SHORT and keeps the loss within one tick of 1R", () => {
    const input: FillInput = { ...btc, direction: "SHORT", fillPrice: 68000, structuralStop: 68800 };
    const r = finalizeAfterFill(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const loss = lossOf(input, r.stopLoss);
    expect(loss.lte(5)).toBe(true);
    expect(dec(5).minus(loss).lt(dec("0.005").mul("0.1").mul(1.0005))).toBe(true);
    expect(Number(r.takeProfit)).toBeLessThan(68000);
  });

  it("EXACT_1R absorbs adverse slippage on the entry", () => {
    const input: FillInput = { ...btc, fillPrice: 68150 };
    const r = finalizeAfterFill(input);
    expect(r).toMatchObject({ ok: true, mode: "EXACT_1R" });
    if (r.ok) expect(lossOf(input, r.stopLoss).lte(5)).toBe(true);
  });

  it("falls back to the structural stop when 1R would widen it too much", () => {
    // 0.001 BTC with a 2500 stop: exact 1R would need about a 5000 stop (+100%).
    const r = finalizeAfterFill({ ...btc, filledQty: "0.001", structuralStop: 65500 });
    expect(r).toMatchObject({ ok: true, stopLoss: "65500.0", takeProfit: "73000.0", mode: "KEEP_STRUCTURE", fellBack: true });
    expect(r.ok && r.riskR).toBeCloseTo(0.51335, 5);
  });

  it("KEEP_STRUCTURE keeps the structural stop", () => {
    const r = finalizeAfterFill({ ...btc, mode: "KEEP_STRUCTURE" });
    expect(r).toMatchObject({ ok: true, stopLoss: "67200.0", takeProfit: "69600.0", riskUsd: "4.3380", rewardUsd: "7.6560", mode: "KEEP_STRUCTURE", fellBack: false });
  });

  it("refuses a fill that is already past the stop", () => {
    expect(finalizeAfterFill({ ...btc, fillPrice: 67150 })).toMatchObject({ ok: false, reason: "FILL_BEYOND_STOP" });
    expect(finalizeAfterFill({ ...btc, direction: "SHORT", structuralStop: 67900 })).toMatchObject({
      ok: false,
      reason: "FILL_BEYOND_STOP",
    });
  });

  it("refuses when the round-trip fees alone exceed 1R", () => {
    const r = finalizeAfterFill({ ...btc, fillPrice: 100, filledQty: 100_000, structuralStop: 99, tickSize: "0.01" });
    expect(r).toMatchObject({ ok: false, reason: "FEES_EXCEED_RISK" });
  });

  it("never loses more than 1R at the final stop (random fills)", () => {
    const random = rng(7);
    for (let n = 0; n < 2000; n++) {
      const long = random() < 0.5;
      const fill = Number((1 + random() * 50_000).toFixed(2));
      const stopPct = 0.003 + random() * 0.02;
      const structural = long ? fill * (1 - stopPct) : fill * (1 + stopPct);
      const perUnit = Math.abs(fill - structural) + 0.0005 * (fill + structural);
      const qty = Math.max(0.001, Math.floor((10 / perUnit) * 1000) / 1000);
      const input: FillInput = {
        ...btc,
        direction: long ? "LONG" : "SHORT",
        fillPrice: fill,
        filledQty: qty,
        structuralStop: structural,
        riskUsd: 10,
        tickSize: "0.01",
      };
      const r = finalizeAfterFill(input);
      if (!r.ok) {
        expect(r.reason).toBe("FEES_EXCEED_RISK");
        continue;
      }
      const loss = lossOf(input, r.stopLoss);
      expect(loss.lte(10)).toBe(true);
      expect(long ? Number(r.stopLoss) < fill : Number(r.stopLoss) > fill).toBe(true);
      expect(long ? Number(r.takeProfit) > fill : Number(r.takeProfit) < fill).toBe(true);
      // TP = fill ± 2 × the final stop distance, to the nearest tick.
      const target = long ? dec(fill).plus(dec(fill).minus(r.stopLoss).abs().mul(2)) : dec(fill).minus(dec(r.stopLoss).minus(fill).mul(2));
      if (target.gt("0.01")) expect(dec(r.takeProfit).minus(target).abs().lte("0.005")).toBe(true);
      expect(r.rewardUsd).toBe(netResultAt(input.direction, fill, r.takeProfit, qty, 0.0005).toFixed(4));
    }
  });
});
