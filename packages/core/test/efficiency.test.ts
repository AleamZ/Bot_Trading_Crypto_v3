import { describe, expect, it } from "vitest";
import { createAnalyzer } from "../src/analyzer.js";
import { decideConsensus, type ConsensusOptions } from "../src/consensus/index.js";
import { efficiencyRatio } from "../src/indicators/moving.js";
import { defaultSettings, mergeSettings } from "../src/settings/index.js";
import { randomWalk, resample, signal } from "./helpers.js";

describe("efficiencyRatio", () => {
  it("is 1 on a straight line, 0 on a back-and-forth, NaN before enough values", () => {
    expect(efficiencyRatio([1, 2, 3, 4, 5], 4)).toEqual([Number.NaN, Number.NaN, Number.NaN, Number.NaN, 1]);
    expect(efficiencyRatio([1, 2, 1, 2, 1], 4).at(-1)).toBe(0);
    expect(efficiencyRatio([5, 5, 5], 2).at(-1)).toBe(0);
    // Net 2 over a path of 4: 0.5; the rolling sum drops the oldest step.
    expect(efficiencyRatio([0, 1, 0, 1, 2, 3], 4)).toEqual([Number.NaN, Number.NaN, Number.NaN, Number.NaN, 0.5, 0.5]);
  });
});

describe("decideConsensus with the choppiness filter", () => {
  const options: ConsensusOptions = { alertThreshold: 2, autoEntryThreshold: 2, alertWhenOpposed: true, minEfficiency: 0.15 };
  const two = [signal("trendPullback", "LONG", 95), signal("donchianBreakout", "LONG", 96)];

  it("lets a symbol that moved one way enter and keeps a choppy one at READY", () => {
    expect(decideConsensus(two, options, { efficiency: 0.2 })).toMatchObject({ level: "ENTER", efficiency: { value: 0.2, min: 0.15, blocked: false } });
    expect(decideConsensus(two, options, { efficiency: 0.1 })).toMatchObject({ level: "READY", efficiency: { blocked: true } });
    expect(decideConsensus(two, options, { efficiency: Number.NaN })).toMatchObject({ level: "READY", efficiency: { blocked: true } });
  });

  it("does nothing when turned off", () => {
    const off = decideConsensus(two, { ...options, minEfficiency: 0 }, { efficiency: 0.01 });
    expect(off.level).toBe("ENTER");
    expect(off).not.toHaveProperty("efficiency");
  });

  it("combines with the follow-BTC rule: either one blocks", () => {
    const both = { ...options, followBtc: "NOT_AGAINST" as const };
    expect(decideConsensus(two, both, { efficiency: 0.3, leader: "SHORT" }).level).toBe("READY");
    expect(decideConsensus(two, both, { efficiency: 0.05, leader: "LONG" }).level).toBe("READY");
    expect(decideConsensus(two, both, { efficiency: 0.3, leader: "LONG" }).level).toBe("ENTER");
  });
});

describe("createAnalyzer with minEfficiency", () => {
  const entry = randomWalk(1600, 2026);
  const trend = resample(entry, 4);
  const plain = mergeSettings(defaultSettings(), { general: { autoEntryThreshold: 2, followBtc: "OFF" } });
  if (!plain.ok) throw new Error("settings");

  it("only removes entries where the symbol was choppy, using the ratio of its own closes", () => {
    const before = createAnalyzer({ entry, trend }, plain.settings);
    const er = efficiencyRatio(entry.map((c) => c.close), 96);
    // The median ratio of the entry candles: some fall below it, some do not.
    const atEntries = Array.from({ length: entry.length }, (_, i) => i)
      .filter((i) => before.at(i).consensus.level === "ENTER")
      .map((i) => er[i]!)
      .sort((x, y) => x - y);
    const min = atEntries[Math.floor(atEntries.length / 2)]!;
    const strict = mergeSettings(plain.settings, { general: { minEfficiency: min, efficiencyBars: 96 } });
    if (!strict.ok) throw new Error("settings");
    const after = createAnalyzer({ entry, trend }, strict.settings);
    let removed = 0;
    let kept = 0;
    for (let i = 0; i < entry.length; i++) {
      const a = before.at(i).consensus;
      const b = after.at(i).consensus;
      expect(b.efficiency?.value).toEqual(er[i]);
      if (a.level === "ENTER") (b.level === "ENTER" ? kept++ : removed++);
      if (b.level !== a.level) expect(b.efficiency?.blocked).toBe(true);
    }
    expect(removed).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);
  });
});
