import { describe, expect, it } from "vitest";
import { createAnalyzer } from "../src/analyzer.js";
import { defaultSettings, mergeSettings } from "../src/settings/index.js";
import type { Settings } from "../src/settings/schema.js";
import { METHOD_IDS } from "../src/types.js";
import { randomWalk } from "./helpers.js";

/** Loose parameters so every method fires now and then on random data. */
function loose(): Settings {
  const merged = mergeSettings(defaultSettings(), {
    methods: {
      trendPullback: { rsiMin: 1, rsiMax: 99, slopeLookback: 2, pullbackLookback: 8 },
      donchianBreakout: { channelLength: 10, volumeMultiplier: 0.5, adxMin: 0, minBodyRatio: 0.1, closeZoneRatio: 0.6, maxChaseAtr: 5 },
      smcSweep: { swingStrength: 2, minFvgAtr: 0, maxDistanceFromFvgAtr: 10, sweepLookback: 20 },
      boxTheory: { enabled: true, minBoxAtr: 1, zonePct: 45, maxEntryPct: 50, rejectRatio: 0 },
    },
  });
  if (!merged.ok) throw new Error(JSON.stringify(merged.errors));
  return merged.settings;
}

describe("explain matches evaluate", () => {
  for (const seed of [3, 17, 29]) {
    it(`a side is ready exactly when the method fires that way (random walk ${seed})`, () => {
      const entry = randomWalk(1200, seed);
      const trend = randomWalk(320, seed + 100, 60);
      const analyzer = createAnalyzer({ entry, trend }, loose());
      const fired: Record<string, number> = {};
      for (let i = 0; i < entry.length; i++) {
        for (const id of METHOD_IDS) {
          const strategy = analyzer.strategies[id]!;
          const signal = strategy.evaluate(i);
          const explanation = strategy.explain(i);
          const ready = explanation.sides.filter((s) => s.ready).map((s) => s.direction);
          if (signal) {
            fired[id] = (fired[id] ?? 0) + 1;
            expect(ready, `${id} at ${i}`).toContain(signal.direction);
          } else {
            expect(ready, `${id} at ${i}`).toEqual([]);
          }
          for (const s of explanation.sides) {
            expect(s.passed).toBe(s.checks.filter((c) => c.pass === true).length);
            expect(s.checks.every((c) => c.label.length > 0)).toBe(true);
          }
        }
      }
      // The test means something only if each method fired a few times.
      for (const id of METHOD_IDS) expect(fired[id] ?? 0, id).toBeGreaterThan(0);
    });
  }

  it("reports missing data as unknown, not as failed", () => {
    const entry = randomWalk(30, 5);
    const analyzer = createAnalyzer({ entry, trend: [] }, loose());
    const first = analyzer.explain(0);
    for (const id of METHOD_IDS) {
      for (const s of first[id]!.sides) expect(s.checks.every((c) => c.pass === null)).toBe(true);
    }
  });

  it("returns null for a disabled method", () => {
    const merged = mergeSettings(defaultSettings(), { methods: { smcSweep: { enabled: false } } });
    if (!merged.ok) throw new Error("bad");
    const analyzer = createAnalyzer({ entry: randomWalk(50, 1), trend: [] }, merged.settings);
    expect(analyzer.explain(49).smcSweep).toBeNull();
    expect(analyzer.explain(49).trendPullback?.sides.map((s) => s.direction)).toEqual(["LONG", "SHORT"]);
  });
});

describe("chartOverlays", () => {
  it("draws what the methods use, only on the shown candles, with triggers and 2/3-3/3 moments", async () => {
    const { chartOverlays } = await import("../src/chart.js");
    const entry = randomWalk(900, 3);
    const trend = randomWalk(240, 103, 60);
    const settings = loose();
    const analyzer = createAnalyzer({ entry, trend }, settings);
    const from = 600;
    const o = chartOverlays({ entry, trend }, settings, analyzer, from);
    expect(o.lines.map((l) => l.id)).toEqual(["emaFast", "emaMid", "trendMid", "trendSlow", "donchianUpper", "donchianMid", "donchianLower"]);
    const shown = new Set(entry.slice(from).map((c) => c.openTime));
    for (const line of o.lines) {
      // EMA200 of the 1h trend needs 200 trend candles before it has values.
      expect(line.points.length).toBeGreaterThan(line.id === "trendSlow" ? 50 : 250);
      expect(line.points.every((p) => shown.has(p.time) && Number.isFinite(p.value))).toBe(true);
    }
    expect(o.swings.length).toBeGreaterThan(0);
    expect(o.fvgs.length).toBeLessThanOrEqual(12);
    expect(o.fvgs.every((g) => g.top > g.bottom && g.to >= g.from)).toBe(true);
    expect(o.signals.length).toBeGreaterThan(0);
    expect(o.signals.every((s) => shown.has(s.openTime))).toBe(true);
    // Every trigger on the chart is one evaluate() returns for that candle.
    for (const s of o.signals) expect(analyzer.strategies[s.method]!.evaluate(s.index)).toMatchObject({ direction: s.direction, index: s.index, stopLoss: s.stopLoss });
    expect(o.episodes.every((e) => shown.has(e.time))).toBe(true);
  });
});
