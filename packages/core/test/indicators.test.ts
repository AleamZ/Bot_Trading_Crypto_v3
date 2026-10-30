import { describe, expect, it } from "vitest";
import { adx, alignHigherTimeframe, atr, bearishFvgAt, bullishFvgAt, ema, highestBefore, lowestBefore, rma, rsi, sma, swings, trueRange } from "../src/indicators/index.js";
import { candles, MINUTE, T0, trendRows } from "./helpers.js";

const nan = Number.NaN;

describe("moving averages", () => {
  it("sma", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([nan, nan, 2, 3, 4]);
  });

  it("ema is seeded with the SMA of the first period", () => {
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([nan, nan, 2, 3, 4]);
    expect(ema([1, 2], 3)).toEqual([nan, nan]);
  });

  it("rma skips leading NaN and follows Wilder's formula", () => {
    expect(rma([nan, 1, 2, 3, 4], 2)).toEqual([nan, nan, 1.5, 2.25, 3.125]);
  });

  it("highest/lowest exclude the current value", () => {
    expect(highestBefore([1, 3, 2, 5, 4], 2)).toEqual([nan, nan, 3, 3, 5]);
    expect(lowestBefore([5, 3, 4, 1, 2], 2)).toEqual([nan, nan, 3, 3, 1]);
  });
});

describe("oscillators", () => {
  it("rsi matches a hand-computed Wilder series", () => {
    const values = rsi([1, 2, 1, 2, 1], 2);
    expect(values.slice(0, 2)).toEqual([nan, nan]);
    expect(values[2]).toBeCloseTo(50, 10);
    expect(values[3]).toBeCloseTo(75, 10);
    expect(values[4]).toBeCloseTo(37.5, 10);
  });

  it("rsi is 100 when price only rises and 50 when it is flat", () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 3)[5]).toBe(100);
    expect(rsi([2, 2, 2, 2, 2], 3)[4]).toBe(50);
  });

  it("true range accounts for gaps", () => {
    const list = candles([
      [10, 10.5, 9.5, 10],
      [11.5, 12, 11, 11.8],
    ]);
    expect(trueRange(list)).toEqual([1, 2]);
  });

  it("atr of a constant range is that range", () => {
    const list = candles(Array.from({ length: 10 }, () => [10, 11, 9, 10] as [number, number, number, number]));
    expect(atr(list, 3).slice(2)).toEqual(new Array(8).fill(2));
  });

  it("adx reaches 100 in a perfect uptrend", () => {
    const list = candles(Array.from({ length: 20 }, (_, i) => [10 + i, 11 + i, 9.5 + i, 10.8 + i] as [number, number, number, number]));
    const series = adx(list, 4);
    expect(series.adx[6]).toBeNaN();
    expect(series.adx[7]).toBeCloseTo(100, 10);
    expect(series.minusDi[10]).toBe(0);
    expect(series.plusDi[10]).toBeGreaterThan(0);
  });
});

describe("structure", () => {
  it("finds fractal swings", () => {
    const list = candles([
      [5, 6, 5, 5.5],
      [5, 5.5, 4, 4.5],
      [4, 9, 3, 4],
      [4, 5.5, 4, 5],
      [5, 6, 5, 5.5],
    ]);
    const flags = swings(list, 2);
    expect(flags.isLow).toEqual([false, false, true, false, false]);
    expect(flags.isHigh).toEqual([false, false, true, false, false]);
  });

  it("equal neighbours are not a swing", () => {
    const list = candles([
      [5, 6, 4, 5],
      [5, 6, 3, 5],
      [5, 6, 3, 5],
      [5, 6, 4, 5],
    ]);
    expect(swings(list, 1).isLow).toEqual([false, false, false, false]);
  });

  it("detects fair value gaps", () => {
    const list = candles([
      [9, 10, 8, 9.5],
      [9.5, 12, 9.4, 11.8],
      [11.8, 12.5, 11, 12.2],
    ]);
    expect(bullishFvgAt(list, 2)).toEqual({ index: 2, top: 11, bottom: 10 });
    expect(bearishFvgAt(list, 2)).toBeNull();
    expect(bullishFvgAt(list, 1)).toBeNull();
    const down = candles([
      [12, 12.5, 11, 11.2],
      [11.2, 11.3, 9, 9.2],
      [9.2, 10, 8.5, 8.8],
    ]);
    expect(bearishFvgAt(down, 2)).toEqual({ index: 2, top: 11, bottom: 10 });
  });

  it("aligns a higher timeframe without look-ahead", () => {
    const entry = candles(trendRows(5, 100, 1), 15);
    const hour = candles(trendRows(2, 100, 1), 60);
    expect(alignHigherTimeframe(entry, hour)).toEqual([-1, -1, -1, 0, 0]);
    // A 1h candle closes at the same millisecond as the 4th 15m candle.
    expect(hour[0]!.closeTime).toBe(entry[3]!.closeTime);
    expect(entry[3]!.closeTime).toBe(T0 + 60 * MINUTE - 1);
  });
});
