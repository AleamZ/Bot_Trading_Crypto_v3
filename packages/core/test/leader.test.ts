import { describe, expect, it } from "vitest";
import { createAnalyzer } from "../src/analyzer.js";
import { decideConsensus, type ConsensusOptions } from "../src/consensus/index.js";
import { againstLeader, leaderTrendText, trendBiasSeries } from "../src/leader.js";
import { defaultSettings, mergeSettings } from "../src/settings/index.js";
import { candles, mirror, randomWalk, resample, signal, trendRows } from "./helpers.js";

const params = { emaMid: 50, emaSlow: 200, slopeLookback: 3 };
const rising = candles(trendRows(400, 100, 0.5), 60);
const falling = mirror(rising, 400);

describe("trendBiasSeries", () => {
  it("reads a steady rise as LONG, its mirror as SHORT, and nothing before the slow EMA exists", () => {
    expect(trendBiasSeries(rising, params).at(-1)).toBe("LONG");
    expect(trendBiasSeries(falling, params).at(-1)).toBe("SHORT");
    expect(trendBiasSeries(rising, params)[10]).toBeNull();
  });

  it("gives no trend to a flat market", () => {
    expect(trendBiasSeries(candles(trendRows(400, 100, 0)), params).at(-1)).toBeNull();
  });
});

describe("againstLeader", () => {
  it("NOT_AGAINST blocks only the opposite of a clear BTC trend, WITH needs the same one, missing data blocks", () => {
    expect(againstLeader("LONG", "SHORT", "NOT_AGAINST")).toBe(true);
    expect(againstLeader("LONG", "LONG", "NOT_AGAINST")).toBe(false);
    expect(againstLeader("LONG", null, "NOT_AGAINST")).toBe(false);
    expect(againstLeader("SHORT", null, "WITH")).toBe(true);
    expect(againstLeader("SHORT", "SHORT", "WITH")).toBe(false);
    expect(againstLeader("SHORT", "NO_DATA", "NOT_AGAINST")).toBe(true);
    expect(againstLeader("SHORT", "LONG", "OFF")).toBe(false);
    expect(leaderTrendText("SHORT")).toBe("BTC giảm");
  });
});

describe("decideConsensus with BTC's trend", () => {
  const options: ConsensusOptions = { alertThreshold: 2, autoEntryThreshold: 2, alertWhenOpposed: true, followBtc: "NOT_AGAINST" };
  const two = [signal("trendPullback", "LONG", 95), signal("donchianBreakout", "LONG", 96)];

  it("turns an altcoin entry against BTC into a READY alert, and says why", () => {
    expect(decideConsensus(two, options, "SHORT")).toMatchObject({ level: "READY", direction: "LONG", leader: { trend: "SHORT", blocked: true } });
    expect(decideConsensus(two, options, "LONG")).toMatchObject({ level: "ENTER", leader: { trend: "LONG", blocked: false } });
    expect(decideConsensus(two, options, null)).toMatchObject({ level: "ENTER", leader: { trend: null, blocked: false } });
    expect(decideConsensus(two, { ...options, followBtc: "WITH" }, null)).toMatchObject({ level: "READY", leader: { blocked: true } });
    expect(decideConsensus(two, options, "NO_DATA")).toMatchObject({ level: "READY", leader: { blocked: true } });
  });

  it("leaves BTC itself and the rule turned off alone", () => {
    expect(decideConsensus(two, options)).not.toHaveProperty("leader");
    expect(decideConsensus(two, options).level).toBe("ENTER");
    const off = decideConsensus(two, { ...options, followBtc: "OFF" }, "SHORT");
    expect(off.level).toBe("ENTER");
    expect(off).not.toHaveProperty("leader");
  });
});

describe("createAnalyzer with BTC's candles", () => {
  const merged = mergeSettings(defaultSettings(), { general: { followBtc: "NOT_AGAINST", autoEntryThreshold: 2 } });
  if (!merged.ok) throw new Error("settings");
  const settings = merged.settings;
  const entry = randomWalk(1600, 2026);
  const trend = resample(entry, 4);
  const alone = createAnalyzer({ entry, trend }, settings);

  it("only ever removes entries against BTC, and leaves every other candle as it was", () => {
    let blocked = 0;
    for (const leader of [rising, falling]) {
      const follower = createAnalyzer({ entry, trend, leader }, settings);
      for (let i = 0; i < follower.length; i++) {
        const before = alone.at(i).consensus;
        const after = follower.at(i).consensus;
        expect(after.leader).toBeDefined();
        if (after.leader!.blocked) expect(after.level).not.toBe("ENTER");
        if (after.level !== before.level) {
          expect(before.level).toBe("ENTER");
          expect(after.leader).toMatchObject({ blocked: true });
          expect(after.leader!.trend).not.toBe(after.direction);
          blocked++;
        }
      }
    }
    expect(blocked).toBeGreaterThan(0);
  });

  it("enters nothing when BTC's candles could not be loaded", () => {
    const follower = createAnalyzer({ entry, trend, leader: null }, settings);
    for (let i = 0; i < follower.length; i += 3) {
      expect(follower.at(i).consensus.level).not.toBe("ENTER");
      expect(follower.at(i).consensus.leader?.trend).toBe("NO_DATA");
    }
  });
});
