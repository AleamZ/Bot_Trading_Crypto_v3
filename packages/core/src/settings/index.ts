import { z } from "zod";
import { METHOD_IDS } from "../types.js";
import { settingsSchema, type Settings } from "./schema.js";

export * from "./schema.js";

export type SettingsParseResult =
  | { ok: true; settings: Settings }
  | { ok: false; errors: { path: string; message: string }[] };

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

export function parseSettings(input: unknown): SettingsParseResult {
  const result = settingsSchema.safeParse(input);
  if (result.success) return { ok: true, settings: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  };
}

/**
 * Applies a partial update on top of the current settings and validates the result. Plain objects
 * merge key by key; arrays and scalars replace.
 */
export function mergeSettings(current: Settings, patch: unknown): SettingsParseResult {
  return parseSettings(deepMerge(current, patch));
}

/** Combinations that are valid but probably not what the user wants. */
export function settingsWarnings(settings: Settings): string[] {
  const warnings: string[] = [];
  const enabled = METHOD_IDS.filter((id) => settings.methods[id].enabled).length;
  if (settings.general.autoEntryThreshold > enabled) {
    warnings.push(`Chỉ bật ${enabled} phương pháp nên không bao giờ đạt ngưỡng tự vào lệnh ${settings.general.autoEntryThreshold}`);
  }
  if (settings.general.alertThreshold > enabled) {
    warnings.push(`Chỉ bật ${enabled} phương pháp nên không bao giờ đạt ngưỡng báo ${settings.general.alertThreshold}`);
  }
  if (!settings.risk.includeFees) warnings.push("Phí không được tính vào 1R, lỗ thực tế khi chạm SL sẽ lớn hơn 1R");
  return warnings;
}

/** JSON Schema (with titles, descriptions and units) the UI uses to build the settings form. */
export function settingsJsonSchema(): unknown {
  return z.toJSONSchema(settingsSchema, { io: "input" });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(base[key], value);
  return out;
}
