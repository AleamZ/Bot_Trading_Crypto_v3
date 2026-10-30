import { describe, expect, it } from "vitest";
import { nextStop, tpProgress, type NextStopInput } from "../src/risk/trail.js";

const SETTINGS = { moveSl: true, breakEvenAtTpPct: 50, lockAtTpPct: 75, lockSlAtTpPct: 50 };
// LONG: entry 100, stop 98, TP 104 (RR 2).
const long = (patch: Partial<NextStopInput> = {}): NextStopInput => ({
  direction: "LONG",
  entry: "100",
  takeProfit: "104",
  stopLoss: "98",
  stage: 0,
  bestProgress: 0,
  settings: SETTINGS,
  tickSize: "0.01",
  ...patch,
});

describe("tpProgress", () => {
  it("is 0 at the entry, 1 at the TP and negative against, for both sides", () => {
    expect(tpProgress("LONG", 100, 104, 102)).toBe(0.5);
    expect(tpProgress("LONG", 100, 104, 99)).toBe(-0.25);
    expect(tpProgress("SHORT", 100, 96, 97)).toBe(0.75);
  });
});

describe("nextStop", () => {
  it("does nothing before half way", () => {
    expect(nextStop(long({ bestProgress: 0.49 }))).toBeNull();
  });

  it("moves to the entry at 50%, then to 50% of the way at 75%", () => {
    expect(nextStop(long({ bestProgress: 0.5 }))).toEqual({ stage: 1, stopLoss: "100.00" });
    expect(nextStop(long({ bestProgress: 0.8, stage: 1, stopLoss: "100.00" }))).toEqual({ stage: 2, stopLoss: "102.00" });
    expect(nextStop(long({ bestProgress: 0.9, stage: 2, stopLoss: "102.00" }))).toBeNull();
  });

  it("skips straight to the locked stop when price is already past 75%", () => {
    expect(nextStop(long({ bestProgress: 0.8 }))).toEqual({ stage: 2, stopLoss: "102.00" });
  });

  it("mirrors for a SHORT and rounds the locked level towards the entry", () => {
    const short = long({ direction: "SHORT", entry: "100", takeProfit: "96.01", stopLoss: "102", tickSize: "0.1" });
    expect(nextStop({ ...short, bestProgress: 0.6 })).toEqual({ stage: 1, stopLoss: "100.0" });
    // 50% of the way is 98.005: rounded up to 98.1, never past the setting.
    expect(nextStop({ ...short, bestProgress: 0.8, stage: 1, stopLoss: "100.0" })).toEqual({ stage: 2, stopLoss: "98.1" });
  });

  it("never moves the stop backwards or when switched off", () => {
    expect(nextStop(long({ bestProgress: 0.6, stopLoss: "100.50" }))).toBeNull();
    expect(nextStop(long({ bestProgress: 0.9, settings: { ...SETTINGS, moveSl: false } }))).toBeNull();
    expect(nextStop(long({ bestProgress: 0.6, settings: { ...SETTINGS, breakEvenAtTpPct: 0 } }))).toBeNull();
  });
});
