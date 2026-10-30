import { describe, expect, it } from "vitest";
import { atr } from "../src/indicators/oscillators.js";
import { defaultSettings } from "../src/settings/index.js";
import type { DonchianBreakoutParams, SmcSweepParams, TrendPullbackParams } from "../src/settings/schema.js";
import { activeSignalAt } from "../src/strategies/active.js";
import { prepareDonchianBreakout } from "../src/strategies/donchianBreakout.js";
import { prepareSmcSweep } from "../src/strategies/smcSweep.js";
import { prepareTrendPullback } from "../src/strategies/trendPullback.js";
import type { MarketData, PreparedStrategy } from "../src/strategies/types.js";
import type { Candle } from "../src/types.js";
import { candles, MINUTE, mirror, signal, T0, trendRows, type Row } from "./helpers.js";

const ATR_PERIOD = 5;
const shared = (list: readonly Candle[]) => ({ atr: atr(list, ATR_PERIOD) });
const triggersOf = (strategy: PreparedStrategy, length: number) =>
  Array.from({ length }, (_, i) => strategy.evaluate(i))
    .filter((s) => s !== null)
    .map((s) => `${s.index}:${s.direction}`);

describe("A. trend pullback", () => {
  const params: TrendPullbackParams = {
    ...defaultSettings().methods.trendPullback,
    emaFast: 5,
    emaMid: 10,
    emaSlow: 20,
    slopeLookback: 3,
    pullbackLookback: 4,
    rsiPeriod: 5,
    rsiMin: 50,
    rsiMax: 80,
    slAtrBuffer: 0.2,
  };
  // 1h uptrend; the 15m candles start 25h later so the trend EMAs are warm.
  const trend = candles(trendRows(40, 100, 1, 0.6, 0.2), 60);
  const rows: Row[] = [
    ...trendRows(30, 130, 0.5),
    [144.5, 144.6, 144.0, 144.1],
    [144.1, 144.2, 143.6, 143.8],
    [143.8, 143.9, 143.3, 143.6],
    [143.6, 144.7, 143.5, 144.6], // 33: trigger
    [144.6, 144.9, 144.4, 144.8],
    [144.8, 145.0, 144.5, 144.6],
  ];
  const entry = candles(rows, 15, T0 + 25 * 60 * MINUTE);

  it("goes LONG when the pullback in an uptrend turns back up", () => {
    const strategy = prepareTrendPullback({ entry, trend }, params, shared(entry));
    expect(strategy.evaluate(32)).toBeNull();
    const s = strategy.evaluate(33);
    expect(s).toMatchObject({ method: "trendPullback", direction: "LONG", index: 33, price: 144.6 });
    // Lowest low of candles 30..33 is 143.3, minus 0.2 ATR.
    expect(s!.stopLoss).toBeLessThan(143.3);
    expect(s!.stopLoss).toBeGreaterThan(143.0);
    expect(triggersOf(strategy, 30)).toEqual([]);
  });

  it("goes SHORT on the mirror image", () => {
    const strategy = prepareTrendPullback({ entry: mirror(entry, 300), trend: mirror(trend, 300) }, params, shared(mirror(entry, 300)));
    const s = strategy.evaluate(33);
    expect(s).toMatchObject({ direction: "SHORT", index: 33 });
    expect(s!.stopLoss).toBeGreaterThan(300 - 143.3);
  });

  it("does nothing against the higher timeframe trend", () => {
    const strategy = prepareTrendPullback({ entry, trend: mirror(trend, 300) }, params, shared(entry));
    expect(triggersOf(strategy, entry.length)).toEqual([]);
  });

  it("does nothing while the trend timeframe is not warm yet", () => {
    const early = candles(rows, 15, T0);
    const strategy = prepareTrendPullback({ entry: early, trend }, params, shared(early));
    expect(triggersOf(strategy, early.length)).toEqual([]);
  });

  it("is invalidated by a close below the mid EMA", () => {
    const strategy = prepareTrendPullback({ entry, trend }, params, shared(entry));
    const s = strategy.evaluate(33)!;
    expect(strategy.isInvalidated(s, 34)).toBe(false);
    const crashed = [...entry.slice(0, 34), { ...entry[34]!, close: 140, low: 139.9 }];
    const again = prepareTrendPullback({ entry: crashed, trend }, params, shared(crashed));
    expect(again.isInvalidated(s, 34)).toBe(true);
  });
});

describe("B. Donchian breakout", () => {
  const params: DonchianBreakoutParams = {
    ...defaultSettings().methods.donchianBreakout,
    channelLength: 10,
    volumeSmaLength: 10,
    volumeMultiplier: 1.5,
    adxPeriod: 5,
    adxMin: 20,
    minBodyRatio: 0.5,
    closeZoneRatio: 0.25,
    maxChaseAtr: 1.5,
    slAtrMultiplier: 1.5,
  };
  const base: Row[] = [
    ...trendRows(20, 100, 0.6, 0.4, 0.1),
    [111.2, 111.4, 110.8, 111.0],
    [111.0, 111.4, 110.8, 111.3],
    [111.3, 111.4, 110.8, 111.0],
    [111.0, 111.4, 110.8, 111.3],
    [111.3, 111.4, 110.8, 111.0],
  ];
  const breakout: Row = [111.2, 112.3, 111.1, 112.2, 200];
  const build = (last: Row) => candles([...base, last]);

  it("goes LONG on a high-volume close above the channel", () => {
    const entry = build(breakout);
    const strategy = prepareDonchianBreakout({ entry, trend: [] }, params, shared(entry));
    const s = strategy.evaluate(25);
    expect(s).toMatchObject({ method: "donchianBreakout", direction: "LONG", price: 112.2 });
    expect(s!.levels.upper).toBe(111.5);
    const a = shared(entry).atr[25]!;
    expect(s!.stopLoss).toBeCloseTo(112.2 - 1.5 * a, 10);
  });

  it("goes SHORT on the mirror image", () => {
    const entry = mirror(build(breakout), 250);
    const strategy = prepareDonchianBreakout({ entry, trend: [] }, params, shared(entry));
    expect(strategy.evaluate(25)).toMatchObject({ direction: "SHORT" });
  });

  it("ignores a breakout without volume", () => {
    const entry = build([111.2, 112.3, 111.1, 112.2, 120]);
    expect(prepareDonchianBreakout({ entry, trend: [] }, params, shared(entry)).evaluate(25)).toBeNull();
  });

  it("ignores a candle that closes far below its high", () => {
    const entry = build([111.2, 113.0, 111.1, 112.0, 200]);
    expect(prepareDonchianBreakout({ entry, trend: [] }, params, shared(entry)).evaluate(25)).toBeNull();
  });

  it("does not chase a candle that already ran far past the channel", () => {
    const entry = build([111.2, 114.6, 111.1, 114.5, 200]);
    expect(prepareDonchianBreakout({ entry, trend: [] }, params, shared(entry)).evaluate(25)).toBeNull();
  });

  it("is invalidated by a close back below the channel middle", () => {
    const entry = build(breakout);
    const strategy = prepareDonchianBreakout({ entry, trend: [] }, params, shared(entry));
    const s = strategy.evaluate(25)!;
    const back = candles([...base, breakout, [112.2, 112.3, 105, 105.5]]);
    const later = prepareDonchianBreakout({ entry: back, trend: [] }, params, shared(back));
    expect(later.isInvalidated(s, 26)).toBe(true);
  });
});

describe("C. SMC sweep + structure shift", () => {
  const params: SmcSweepParams = {
    ...defaultSettings().methods.smcSweep,
    swingStrength: 2,
    sweepLookback: 6,
    swingMaxAge: 30,
    minFvgAtr: 0.1,
    maxDistanceFromFvgAtr: 1.5,
    slAtrBuffer: 0.2,
  };
  const rows: Row[] = [
    [110, 111, 109, 109.5],
    [109.5, 110, 108, 108.5],
    [108.5, 109, 107, 107.5],
    [107.5, 108, 106, 106.5],
    [106.5, 107, 105, 105.5],
    [105.5, 106, 104, 104.5],
    [104.5, 105, 103, 103.5],
    [103.5, 104, 101, 101.5], // 7: swing low 101
    [101.5, 103.5, 101.5, 103],
    [103, 104.5, 102.5, 104], // 9: swing high 104.5
    [104, 104.2, 102, 102.5],
    [102.5, 103, 101.8, 102],
    [102, 102.5, 101.6, 101.8],
    [101.8, 102, 100.5, 101.6], // 13: sweeps 101, closes back above
    [101.6, 103.2, 101.5, 103],
    [103, 105.2, 102.8, 105], // 15: first close above 104.5, FVG 102..102.8
    [105, 105.8, 104.6, 105.5],
    [105.5, 106, 105, 105.8],
    [105.8, 106.2, 105.4, 106],
  ];
  const entry = candles(rows);

  it("goes LONG after a sweep of the swing low and a close above the swing high", () => {
    const strategy = prepareSmcSweep({ entry, trend: [] }, params, shared(entry));
    expect(triggersOf(strategy, entry.length)).toEqual(["15:LONG"]);
    const s = strategy.evaluate(15)!;
    expect(s.levels).toMatchObject({ swept: 101, sweepExtreme: 100.5, structure: 104.5, fvgTop: 102.8, fvgBottom: 102 });
    expect(s.stopLoss).toBeCloseTo(100.5 - 0.2 * shared(entry).atr[15]!, 10);
  });

  it("goes SHORT on the mirror image", () => {
    const down = mirror(entry, 220);
    const strategy = prepareSmcSweep({ entry: down, trend: [] }, params, shared(down));
    expect(triggersOf(strategy, down.length)).toEqual(["15:SHORT"]);
  });

  it("needs the sweep candle to close back above the swept low", () => {
    const noReclaim = candles(rows.map((r, i) => (i === 13 ? ([101.8, 102, 100.5, 100.8] as Row) : r)));
    expect(triggersOf(prepareSmcSweep({ entry: noReclaim, trend: [] }, params, shared(noReclaim)), noReclaim.length)).toEqual([]);
  });

  it("needs a fair value gap in the move", () => {
    // Candle 15 now overlaps candle 13's high, so there is no gap.
    const noGap = candles(rows.map((r, i) => (i === 15 ? ([103, 105.2, 101.9, 105] as Row) : r)));
    expect(triggersOf(prepareSmcSweep({ entry: noGap, trend: [] }, params, shared(noGap)), noGap.length)).toEqual([]);
  });
});

describe("active signal", () => {
  const entry = candles(trendRows(12, 100, 0.1));
  const fake = (triggerAt: number, stopLoss: number, invalidAt = -1): PreparedStrategy => ({
    id: "smcSweep",
    evaluate: (i) => (i === triggerAt ? signal("smcSweep", "LONG", stopLoss, i, entry[i]!.close) : null),
    isInvalidated: (_s, j) => j === invalidAt,
  });

  it("counts for ttl candles including the trigger candle", () => {
    const strategy = fake(5, 90);
    expect(activeSignalAt(strategy, entry, 4, 3)).toBeNull();
    expect(activeSignalAt(strategy, entry, 5, 3)?.index).toBe(5);
    expect(activeSignalAt(strategy, entry, 7, 3)?.index).toBe(5);
    expect(activeSignalAt(strategy, entry, 8, 3)).toBeNull();
  });

  it("stops counting once a later candle touches the stop", () => {
    const dip = entry.map((c, i) => (i === 7 ? { ...c, low: 95 } : c));
    expect(activeSignalAt(fake(5, 96), dip, 6, 5)).not.toBeNull();
    expect(activeSignalAt(fake(5, 96), dip, 7, 5)).toBeNull();
    expect(activeSignalAt(fake(5, 96), dip, 8, 5)).toBeNull();
  });

  it("stops counting when the method invalidates the setup", () => {
    expect(activeSignalAt(fake(5, 90, 6), entry, 5, 5)).not.toBeNull();
    expect(activeSignalAt(fake(5, 90, 6), entry, 6, 5)).toBeNull();
  });
});
