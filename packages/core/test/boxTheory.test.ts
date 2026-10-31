import { describe, expect, it } from "vitest";
import { atr } from "../src/indicators/oscillators.js";
import { defaultSettings } from "../src/settings/index.js";
import { dailyRanges, prepareBoxTheory } from "../src/strategies/boxTheory.js";
import type { Candle } from "../src/types.js";
import { candles, type Row } from "./helpers.js";

// 00:00 on 02/01/2026, Vietnam time.
const DAY1 = Date.UTC(2026, 0, 1, 17);
const PER_DAY = 288;

/** Yesterday drifts from 100 up to 110 and back with small candles; today starts at 105. */
function market(today: Row[]): Candle[] {
  const rows: Row[] = [];
  for (let i = 0; i < PER_DAY; i++) {
    const close = i < PER_DAY / 2 ? 100 + (10 * i) / (PER_DAY / 2 - 1) : 110 - (10 * (i - PER_DAY / 2)) / (PER_DAY / 2 - 1);
    rows.push([close, close + 0.15, close - 0.15, close]);
  }
  const drift: Row[] = [];
  for (let i = 0; i < 20; i++) {
    const close = 105 - i * 0.15;
    drift.push([close + 0.1, close + 0.2, close - 0.2, close]);
  }
  return candles([...rows, ...drift, ...today], 5, DAY1);
}

const params = () => ({ ...defaultSettings().methods.boxTheory, enabled: true });

function strategyFor(entry: Candle[]) {
  return prepareBoxTheory({ entry, trend: [] }, params(), { atr: atr(entry, 14) });
}

describe("D. box theory", () => {
  it("takes yesterday's high and low, Vietnam time, only from whole days", () => {
    const entry = market([]);
    const days = dailyRanges(entry);
    expect([...days.keys()]).toEqual([DAY1]);
    expect(days.get(DAY1)!.top).toBeCloseTo(110.15);
    expect(days.get(DAY1)!.bottom).toBeCloseTo(99.85);
    // 4h candles start at 07:00 Vietnam time: they cannot make whole days.
    expect(dailyRanges(candles([[1, 2, 0, 1]], 240, DAY1)).size).toBe(0);
  });

  it("buys a rejection candle in the bottom zone, with the stop below the box", () => {
    const entry = market([[101.6, 102.4, 100.8, 102.3]]);
    const s = strategyFor(entry);
    const i = entry.length - 1;
    const signal = s.evaluate(i)!;
    expect(signal).toMatchObject({ method: "boxTheory", direction: "LONG", price: 102.3 });
    const a = atr(entry, 14)[i]!;
    expect(signal.stopLoss).toBeCloseTo(99.85 - 0.3 * a);
    expect(signal.levels.mid).toBeCloseTo(105);
    expect(s.explain(i).sides[0].ready).toBe(true);
    // Gone once price reaches the middle of the box.
    const later = market([[101.6, 102.4, 100.8, 102.3], [102.3, 105.5, 102.2, 105.2]]);
    expect(prepareBoxTheory({ entry: later, trend: [] }, params(), { atr: atr(later, 14) }).isInvalidated(signal, later.length - 1)).toBe(true);
  });

  it("sells the mirror at the top", () => {
    const rally: Row[] = [];
    for (let i = 0; i < 30; i++) rally.push([102 + i * 0.2, 102.3 + i * 0.2, 101.9 + i * 0.2, 102.2 + i * 0.2]);
    const entry = market([...rally, [108.6, 110.6, 107.9, 108.0]]);
    const signal = strategyFor(entry).evaluate(entry.length - 1)!;
    expect(signal).toMatchObject({ direction: "SHORT" });
    expect(signal.stopLoss).toBeGreaterThan(110.6);
  });

  it("does not trade in the middle, outside the box, or without a rejection", () => {
    const cases: Row[] = [
      [104.6, 105.4, 104.4, 105.2], // middle of the box
      [100.2, 100.4, 99.0, 99.3], // closes below the box
      [102.3, 102.4, 100.8, 101.0], // touches the zone but closes red
    ];
    for (const row of cases) {
      const entry = market([row]);
      const s = strategyFor(entry);
      expect(s.evaluate(entry.length - 1), String(row)).toBeNull();
      expect(s.explain(entry.length - 1).sides.every((side) => !side.ready)).toBe(true);
    }
  });

  it("has nothing to say without yesterday's candles", () => {
    const entry = candles([[100, 101, 99, 100.5]], 5, DAY1);
    const explained = strategyFor(entry).explain(0);
    expect(explained.sides[0].checks[0]).toMatchObject({ pass: null });
  });
});
