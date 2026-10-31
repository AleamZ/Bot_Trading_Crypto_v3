import { describe, expect, it } from "vitest";
import { createAnalyzer } from "../src/analyzer.js";
import { defaultSettings, mergeSettings } from "../src/settings/index.js";
import type { Candle } from "../src/types.js";
import { METHOD_IDS } from "../src/types.js";
import { randomWalk, resample } from "./helpers.js";

const merged = mergeSettings(defaultSettings(), { methods: { boxTheory: { enabled: true } } });
if (!merged.ok) throw new Error(JSON.stringify(merged.errors));
const settings = merged.settings;
const entry = randomWalk(1600, 2026);
const trend = resample(entry, 4);

describe("createAnalyzer", () => {
  const analyzer = createAnalyzer({ entry, trend }, settings);

  it("keeps the consensus consistent with the method states on every candle", () => {
    let fired = 0;
    for (let i = 0; i < analyzer.length; i++) {
      const a = analyzer.at(i);
      const signals = METHOD_IDS.map((id) => a.methods[id].signal).filter((s) => s !== null);
      fired += signals.length;
      expect(a.consensus.longCount).toBe(signals.filter((s) => s.direction === "LONG").length);
      expect(a.consensus.shortCount).toBe(signals.filter((s) => s.direction === "SHORT").length);
      for (const s of signals) {
        expect(s.index).toBeLessThanOrEqual(i);
        expect(s.index).toBeGreaterThan(i - settings.general.signalTtlBars);
        expect(s.direction === "LONG" ? s.stopLoss < s.price : s.stopLoss > s.price).toBe(true);
      }
      if (a.consensus.level === "ENTER") expect(a.consensus.agreeing.length).toBeGreaterThanOrEqual(3);
    }
    // The random walk is long enough for every method to fire at least once.
    expect(fired).toBeGreaterThan(0);
    for (const id of METHOD_IDS) {
      expect(Array.from({ length: analyzer.length }, (_, i) => analyzer.at(i).methods[id].signal).some((s) => s !== null)).toBe(true);
    }
  });

  it("never looks ahead: analysing a truncated history gives the same answer", () => {
    const strip = (c: Candle[]) => c;
    for (const i of [300, 555, 901, 1203, 1599]) {
      const cut = entry.slice(0, i + 1);
      const cutTrend = trend.filter((c) => c.closeTime <= cut[cut.length - 1]!.closeTime);
      const live = createAnalyzer({ entry: strip(cut), trend: cutTrend }, settings).latest();
      expect(live).toEqual(analyzer.at(i));
    }
  });

  it("leaves disabled methods out", () => {
    const r = mergeSettings(settings, { methods: { donchianBreakout: { enabled: false } } });
    if (!r.ok) throw new Error("settings");
    const partial = createAnalyzer({ entry, trend }, r.settings);
    for (let i = 0; i < partial.length; i += 7) {
      expect(partial.at(i).methods.donchianBreakout).toEqual({ enabled: false, signal: null });
    }
  });

  it("throws on an index outside the candles", () => {
    expect(() => analyzer.at(analyzer.length)).toThrow(RangeError);
  });
});
