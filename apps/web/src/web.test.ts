import { describe, expect, it } from "vitest";
import { clock, dateTime, duration, price, progress, rMultiple, signed, usd } from "./format";
import { changedPaths, diffPatch, getAt, parseNumber, parseSymbols, sectionsFromSchema, setAt } from "./schemaForm";
import type { JsonSchema } from "./types";

const schema: JsonSchema = {
  type: "object",
  properties: {
    general: {
      type: "object",
      properties: {
        watchlist: { type: "array", title: "Danh sách symbol", items: { type: "string" } },
        entryTf: { type: "string", enum: ["5m", "15m"], title: "Khung vào lệnh" },
        autoTrade: { type: "boolean", title: "Tự vào lệnh" },
      },
    },
    risk: { type: "object", properties: { riskUsd: { type: "number", title: "1R", unit: "$", minimum: 0.1, maximum: 10000, default: 5 } } },
    methods: {
      type: "object",
      properties: {
        trendPullback: { type: "object", properties: { enabled: { type: "boolean", title: "Bật" }, emaFast: { type: "integer", title: "EMA nhanh", minimum: 2, maximum: 400 } } },
      },
    },
  },
};

describe("sectionsFromSchema", () => {
  it("builds tabs, groups and typed fields with units and limits", () => {
    const sections = sectionsFromSchema(schema);
    expect(sections.map((s) => s.title)).toEqual(["Chung", "Quản lý vốn", "Phương pháp"]);
    expect(sections[0]!.groups[0]!.fields.map((f) => [f.key, f.kind])).toEqual([
      ["general.watchlist", "symbols"],
      ["general.entryTf", "enum"],
      ["general.autoTrade", "boolean"],
    ]);
    expect(sections[1]!.groups[0]!.fields[0]).toMatchObject({ key: "risk.riskUsd", kind: "number", unit: "$", min: 0.1, max: 10000, defaultValue: 5 });
    expect(sections[2]!.groups).toEqual([
      expect.objectContaining({ key: "trendPullback", title: "A. Xu hướng + hồi EMA", fields: [expect.objectContaining({ key: "methods.trendPullback.enabled" }), expect.objectContaining({ kind: "integer" })] }),
    ]);
  });
});

describe("settings draft helpers", () => {
  const original = { general: { watchlist: ["BTCUSDT"], autoTrade: true }, risk: { riskUsd: 5, rr: 2 } };

  it("reads and writes nested values without mutating", () => {
    const next = setAt(original, ["risk", "riskUsd"], 7);
    expect(getAt(next, ["risk", "riskUsd"])).toBe(7);
    expect(original.risk.riskUsd).toBe(5);
    expect(next.general).toBe(original.general);
  });

  it("sends only the changed leaves, arrays whole", () => {
    let draft = setAt(original, ["risk", "riskUsd"], 7);
    draft = setAt(draft, ["general", "watchlist"], ["BTCUSDT", "ETHUSDT"]);
    expect(changedPaths(original, draft)).toEqual(["general.watchlist", "risk.riskUsd"]);
    expect(diffPatch(original, draft)).toEqual({ general: { watchlist: ["BTCUSDT", "ETHUSDT"] }, risk: { riskUsd: 7 } });
    expect(diffPatch(original, structuredClone(original))).toBeNull();
  });

  it("parses symbol lists and numbers the way people type them", () => {
    expect(parseSymbols("btcusdt, ETHUSDT\nsolusdt;btcusdt")).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    const field = { kind: "number" as const, min: 0.1, max: 100 };
    expect(parseNumber("2,5", field)).toEqual({ ok: true, value: 2.5 });
    expect(parseNumber("", field)).toMatchObject({ ok: false });
    expect(parseNumber("abc", field)).toEqual({ ok: false, error: "Không phải số" });
    expect(parseNumber("0.05", field)).toEqual({ ok: false, error: "Nhỏ nhất 0.1" });
    expect(parseNumber("2.5", { kind: "integer", min: null, max: null })).toEqual({ ok: false, error: "Cần số nguyên" });
  });
});

describe("format", () => {
  it("shows Vietnam time", () => {
    const t = Date.UTC(2026, 9, 30, 8, 15, 7);
    expect(clock(t)).toBe("15:15");
    expect(dateTime(t)).toBe("30/10 15:15");
    expect(clock(null)).toBe("—");
  });

  it("formats money, R and prices", () => {
    expect(signed(1.796)).toBe("+1.80");
    expect(signed(-5)).toBe("−5.00");
    expect(signed(-0.001)).toBe("0.00");
    expect(rMultiple(-1)).toBe("−1.00R");
    expect(usd("8.9793")).toBe("+8.98$");
    expect(price(78080.5)).toBe("78,080.5");
    expect(price("0.14700")).toBe("0.147");
    expect(price(67190.49999999)).toBe("67,190.5");
    expect(duration(45_000)).toBe("45 giây");
    expect(duration(3_900_000)).toBe("1 giờ 5 phút");
    expect(progress(5, 0, 10)).toBe(0.5);
    expect(progress(15, 10, 0)).toBe(0);
  });
});
