import { describe, expect, it } from "vitest";
import { advanceEpisode, decideConsensus, markEntered, matchesCombo, type ConsensusOptions, type Episode } from "../src/consensus/index.js";
import { METHOD_COMBOS } from "../src/types.js";
import { signal } from "./helpers.js";

const defaults: ConsensusOptions = { alertThreshold: 2, autoEntryThreshold: 3, alertWhenOpposed: true };
const A = (dir: "LONG" | "SHORT") => signal("trendPullback", dir, dir === "LONG" ? 95 : 105);
const B = (dir: "LONG" | "SHORT") => signal("donchianBreakout", dir, dir === "LONG" ? 96 : 104);
const C = (dir: "LONG" | "SHORT") => signal("smcSweep", dir, dir === "LONG" ? 97 : 103);

describe("decideConsensus", () => {
  it("3/3 the same way enters", () => {
    const r = decideConsensus([A("LONG"), B("LONG"), C("LONG")], defaults);
    expect(r).toMatchObject({ level: "ENTER", direction: "LONG", longCount: 3, shortCount: 0 });
    expect(r.agreeing.map((s) => s.method)).toEqual(["trendPullback", "donchianBreakout", "smcSweep"]);
    expect(decideConsensus([A("SHORT"), B("SHORT"), C("SHORT")], defaults)).toMatchObject({ level: "ENTER", direction: "SHORT" });
  });

  it("2/3 with the third silent is READY, never ENTER", () => {
    const r = decideConsensus([A("LONG"), C("LONG")], defaults);
    expect(r).toMatchObject({ level: "READY", direction: "LONG", opposing: [] });
    expect(decideConsensus([B("SHORT"), C("SHORT")], defaults)).toMatchObject({ level: "READY", direction: "SHORT" });
  });

  it("2/3 with the third opposed is READY with the opposing method listed", () => {
    const r = decideConsensus([A("LONG"), B("LONG"), C("SHORT")], defaults);
    expect(r.level).toBe("READY");
    expect(r.opposing.map((s) => s.method)).toEqual(["smcSweep"]);
  });

  it("2/3 opposed is NONE when alerts on opposition are turned off", () => {
    expect(decideConsensus([A("LONG"), B("LONG"), C("SHORT")], { ...defaults, alertWhenOpposed: false }).level).toBe("NONE");
  });

  it("1/3 or nothing is NONE", () => {
    expect(decideConsensus([A("LONG")], defaults)).toMatchObject({ level: "NONE", direction: "LONG" });
    expect(decideConsensus([], defaults)).toMatchObject({ level: "NONE", direction: null, longCount: 0, shortCount: 0 });
  });

  it("a tie has no direction", () => {
    expect(decideConsensus([A("LONG"), B("SHORT")], { ...defaults, alertThreshold: 1 })).toMatchObject({ level: "NONE", direction: null });
  });

  it("never enters automatically while a method points the other way", () => {
    const r = decideConsensus([A("LONG"), B("LONG"), C("SHORT")], { ...defaults, autoEntryThreshold: 2 });
    expect(r.level).toBe("READY");
  });

  it("enters only with the required method among the agreeing ones", () => {
    const twoOfThree = { ...defaults, autoEntryThreshold: 2, entryRequires: "smcSweep" as const };
    expect(decideConsensus([A("LONG"), B("LONG")], twoOfThree).level).toBe("READY");
    expect(decideConsensus([A("LONG"), C("LONG")], twoOfThree).level).toBe("ENTER");
    expect(decideConsensus([B("SHORT"), C("SHORT")], twoOfThree).level).toBe("ENTER");
    expect(decideConsensus([A("LONG"), B("LONG")], { ...twoOfThree, entryRequires: "NONE" }).level).toBe("ENTER");
  });

  it("follows lower thresholds (2/2 when one method is disabled)", () => {
    const options = { ...defaults, alertThreshold: 1, autoEntryThreshold: 2 };
    expect(decideConsensus([A("LONG"), B("LONG")], options).level).toBe("ENTER");
    expect(decideConsensus([A("LONG")], options).level).toBe("READY");
  });
});

describe("advanceEpisode", () => {
  const ready = decideConsensus([A("LONG"), B("LONG")], defaults);
  const enter = decideConsensus([A("LONG"), B("LONG"), C("LONG")], defaults);
  const none = decideConsensus([A("LONG")], defaults);
  const shortReady = decideConsensus([A("SHORT"), B("SHORT")], defaults);

  it("sends READY once per episode", () => {
    const first = advanceEpisode(null, ready, 1);
    expect(first).toEqual({ episode: { direction: "LONG", level: "READY", startedAt: 1 }, emit: "READY" });
    const second = advanceEpisode(first.episode, ready, 2);
    expect(second.emit).toBeNull();
    expect(second.episode).toEqual(first.episode);
  });

  it("emits ENTER when an episode goes from 2/3 to 3/3, and no more once the entry filled", () => {
    const first = advanceEpisode(null, ready, 1);
    const upgraded = advanceEpisode(first.episode, enter, 2);
    expect(upgraded.emit).toBe("ENTER");
    expect(upgraded.episode).toEqual({ direction: "LONG", level: "ENTER", startedAt: 1, entered: false });
    const entered = markEntered(upgraded.episode!);
    expect(advanceEpisode(entered, enter, 3).emit).toBeNull();
    // Dropping back to 2/3 inside the same episode does not send READY again.
    const dropped = advanceEpisode(entered, ready, 4);
    expect(dropped.emit).toBeNull();
    expect(advanceEpisode(dropped.episode, enter, 5).emit).toBeNull();
  });

  it("tries again on the next 3/3 candle while the entry has not filled", () => {
    const upgraded = advanceEpisode(advanceEpisode(null, ready, 1).episode, enter, 2);
    const again = advanceEpisode(upgraded.episode, enter, 3);
    expect(again).toMatchObject({ emit: "ENTER", retry: true });
    // A 2/3 candle in between waits; the next 3/3 tries again.
    const dropped = advanceEpisode(again.episode, ready, 4);
    expect(dropped.emit).toBeNull();
    expect(advanceEpisode(dropped.episode, enter, 5)).toMatchObject({ emit: "ENTER", retry: true });
    // Episodes stored before retries existed count as entered.
    expect(advanceEpisode({ direction: "LONG", level: "ENTER", startedAt: 1 }, enter, 6).emit).toBeNull();
  });

  it("emits ENTER straight away when 3/3 happens at once", () => {
    expect(advanceEpisode(null, enter, 1).emit).toBe("ENTER");
  });

  it("starts a new episode after NONE or a flip", () => {
    const first = advanceEpisode(null, ready, 1);
    const reset = advanceEpisode(first.episode, none, 2);
    expect(reset).toEqual({ episode: null, emit: null });
    expect(advanceEpisode(reset.episode, ready, 3).emit).toBe("READY");
    const flipped = advanceEpisode(first.episode as Episode, shortReady, 4);
    expect(flipped).toEqual({ episode: { direction: "SHORT", level: "READY", startedAt: 4 }, emit: "READY" });
  });
});

describe("entry combos", () => {
  const D = (dir: "LONG" | "SHORT") => signal("boxTheory", dir, dir === "LONG" ? 94 : 106);
  const withCombos = (entryCombos: string[]) => ({ ...defaults, entryCombos });

  it("enters when the agreeing methods cover one of the chosen combos", () => {
    expect(decideConsensus([A("LONG"), B("LONG")], withCombos(["B+C"])).level).toBe("READY");
    expect(decideConsensus([B("LONG"), C("LONG")], withCombos(["B+C"])).level).toBe("ENTER");
    expect(decideConsensus([A("LONG"), B("LONG"), C("LONG")], withCombos(["B+C"])).level).toBe("ENTER");
    // One method alone, below the alert threshold, still enters when chosen.
    expect(decideConsensus([D("SHORT")], withCombos(["D", "B+C"]))).toMatchObject({ level: "ENTER", direction: "SHORT" });
    expect(decideConsensus([A("SHORT")], withCombos(["D"])).level).toBe("NONE");
    // Never against an opposing method.
    expect(decideConsensus([B("LONG"), C("LONG"), D("SHORT")], withCombos(["B+C"])).level).toBe("READY");
    // Without combos the threshold counts.
    expect(decideConsensus([A("LONG"), B("LONG"), C("LONG")], withCombos([])).level).toBe("ENTER");
  });

  it("matches combos by letters, whatever the order of the signals", () => {
    expect(matchesCombo(["smcSweep", "donchianBreakout"], ["B+C"])).toBe(true);
    expect(matchesCombo(["smcSweep"], ["B+C", "A+C"])).toBe(false);
    expect(METHOD_COMBOS).toHaveLength(15);
    expect(METHOD_COMBOS.slice(0, 5)).toEqual(["A", "B", "C", "D", "A+B"]);
    expect(METHOD_COMBOS.at(-1)).toBe("A+B+C+D");
  });
});
