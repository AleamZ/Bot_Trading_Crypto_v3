import { describe, expect, it } from "vitest";
import { defaultSettings, mergeSettings, parseSettings, settingsJsonSchema, settingsWarnings } from "../src/settings/index.js";

describe("settings", () => {
  it("fills every default from an empty object", () => {
    const s = defaultSettings();
    expect(s.general).toMatchObject({
      watchlist: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"],
      entryTf: "15m",
      trendTf: "1h",
      signalTtlBars: 4,
      alertThreshold: 2,
      autoEntryThreshold: 3,
      autoTrade: true,
    });
    expect(s.risk).toMatchObject({ riskUsd: 5, rr: 2, slPolicy: "WIDEST", slMode: "EXACT_1R", leverage: 10, marginType: "ISOLATED" });
    expect(s.risk).toMatchObject({ moveSl: true, breakEvenAtTpPct: 50, lockAtTpPct: 75, lockSlAtTpPct: 50 });
    expect(s.methods.trendPullback).toMatchObject({ enabled: true, emaFast: 20, emaMid: 50, emaSlow: 200 });
    expect(s.methods.donchianBreakout).toMatchObject({ enabled: true, channelLength: 20, volumeMultiplier: 1.5 });
    expect(s.methods.smcSweep).toMatchObject({ enabled: true, swingStrength: 3 });
    expect(s.telegram).toEqual({ notifyReady: true, notifyEntry: true, notifyExit: true, notifyStopMove: true, notifyError: true });
  });

  it("normalizes and validates the watchlist", () => {
    const ok = parseSettings({ general: { watchlist: [" btcusdt ", "ethusdt"] } });
    expect(ok.ok && ok.settings.general.watchlist).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(parseSettings({ general: { watchlist: ["BTC"] } }).ok).toBe(false);
    expect(parseSettings({ general: { watchlist: ["BTCUSDT", "btcusdt"] } }).ok).toBe(false);
    expect(parseSettings({ general: { watchlist: [] } }).ok).toBe(false);
  });

  it("reports cross-field errors with their path", () => {
    const paths = (input: unknown) => {
      const r = parseSettings(input);
      return r.ok ? [] : r.errors.map((e) => e.path);
    };
    expect(paths({ general: { entryTf: "1h", trendTf: "15m" } })).toContain("general.trendTf");
    expect(paths({ general: { alertThreshold: 3, autoEntryThreshold: 2 } })).toContain("general.alertThreshold");
    expect(paths({ risk: { minSlPct: 3, maxSlPct: 2 } })).toContain("risk.minSlPct");
    expect(paths({ methods: { trendPullback: { emaFast: 60 } } })).toContain("methods.trendPullback.emaFast");
    expect(
      paths({ methods: { trendPullback: { enabled: false }, donchianBreakout: { enabled: false }, smcSweep: { enabled: false } } }),
    ).toContain("methods");
  });

  it("rejects values out of range and wrong types", () => {
    expect(parseSettings({ risk: { riskUsd: 0 } }).ok).toBe(false);
    expect(parseSettings({ risk: { leverage: 2.5 } }).ok).toBe(false);
    expect(parseSettings({ risk: { slPolicy: "ANY" } }).ok).toBe(false);
    expect(parseSettings({ general: { autoTrade: "false" } }).ok).toBe(false);
  });

  it("merges a partial update and keeps everything else", () => {
    const current = defaultSettings();
    const r = mergeSettings(current, { risk: { riskUsd: 10 }, general: { watchlist: ["SOLUSDT"] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.risk.riskUsd).toBe(10);
    expect(r.settings.risk.rr).toBe(2);
    expect(r.settings.general.watchlist).toEqual(["SOLUSDT"]);
    expect(r.settings.methods).toEqual(current.methods);
  });

  it("warns when a threshold can no longer be reached", () => {
    const r = mergeSettings(defaultSettings(), { methods: { smcSweep: { enabled: false } } });
    expect(r.ok && settingsWarnings(r.settings)).toEqual([expect.stringContaining("ngưỡng tự vào lệnh 3")]);
    expect(settingsWarnings(defaultSettings())).toEqual([]);
  });

  it("exports a JSON Schema with titles, units and defaults for the UI form", () => {
    const schema = settingsJsonSchema() as {
      properties: { risk: { properties: Record<string, { title?: string; unit?: string; default?: unknown }> } };
    };
    expect(schema.properties.risk.properties.riskUsd).toMatchObject({ title: "1R", unit: "$", default: 5 });
    expect(schema.properties.risk.properties.slMode).toMatchObject({ default: "EXACT_1R" });
  });
});

describe("entry combos", () => {
  it("accepts combos of methods that are on, and refuses a list that can never enter", () => {
    const ok = mergeSettings(defaultSettings(), { general: { entryCombos: ["B+C", "A+B+C"] } });
    expect(ok.ok && ok.settings.general.entryCombos).toEqual(["B+C", "A+B+C"]);
    const onlyOff = mergeSettings(defaultSettings(), { general: { entryCombos: ["D"] } });
    expect(onlyOff.ok).toBe(false);
    if (!onlyOff.ok) expect(onlyOff.errors[0]).toMatchObject({ path: "general.entryCombos" });
    expect(mergeSettings(defaultSettings(), { general: { entryCombos: ["D"] }, methods: { boxTheory: { enabled: true } } }).ok).toBe(true);
    expect(mergeSettings(defaultSettings(), { general: { entryCombos: ["X"] } }).ok).toBe(false);
  });
});
