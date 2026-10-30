import type { JsonObject, JsonSchema } from "./types";

/**
 * Turns the settings JSON Schema from the server into form fields, so every setting in
 * packages/core/src/settings/schema.ts shows up in the UI with its title, unit and limits.
 */

export type FieldKind = "number" | "integer" | "boolean" | "enum" | "symbols" | "text";

export interface FieldDef {
  path: string[];
  key: string;
  title: string;
  description: string | null;
  unit: string | null;
  kind: FieldKind;
  min: number | null;
  max: number | null;
  options: string[];
  defaultValue: unknown;
}

export interface Group {
  key: string;
  title: string;
  fields: FieldDef[];
}

export interface Section {
  key: string;
  title: string;
  groups: Group[];
}

const SECTION_TITLES: Record<string, string> = { general: "Chung", risk: "Quản lý vốn", methods: "Phương pháp", telegram: "Telegram", ai: "AI" };
const GROUP_TITLES: Record<string, string> = {
  trendPullback: "A. Xu hướng + hồi EMA",
  donchianBreakout: "B. Phá kênh Donchian",
  smcSweep: "C. SMC quét thanh khoản",
};

function fieldOf(path: string[], schema: JsonSchema): FieldDef {
  let kind: FieldKind = "text";
  if (schema.type === "boolean") kind = "boolean";
  else if (schema.type === "integer") kind = "integer";
  else if (schema.type === "number") kind = "number";
  else if (schema.enum) kind = "enum";
  else if (schema.type === "array") kind = "symbols";
  return {
    path,
    key: path.join("."),
    title: schema.title ?? path.at(-1)!,
    description: schema.description ?? null,
    unit: schema.unit ?? null,
    kind,
    min: schema.minimum ?? null,
    max: schema.maximum ?? null,
    options: schema.enum ?? [],
    defaultValue: schema.default,
  };
}

/** Sections in schema order; an object inside a section (a method) becomes its own group. */
export function sectionsFromSchema(schema: JsonSchema): Section[] {
  return Object.entries(schema.properties ?? {}).map(([sectionKey, section]) => {
    const direct: FieldDef[] = [];
    const groups: Group[] = [];
    for (const [key, prop] of Object.entries(section.properties ?? {})) {
      if (prop.type === "object" && prop.properties) {
        groups.push({
          key,
          title: GROUP_TITLES[key] ?? prop.title ?? key,
          fields: Object.entries(prop.properties).map(([k, p]) => fieldOf([sectionKey, key, k], p)),
        });
      } else {
        direct.push(fieldOf([sectionKey, key], prop));
      }
    }
    if (direct.length) groups.unshift({ key: sectionKey, title: SECTION_TITLES[sectionKey] ?? section.title ?? sectionKey, fields: direct });
    return { key: sectionKey, title: SECTION_TITLES[sectionKey] ?? section.title ?? sectionKey, groups };
  });
}

export function getAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as JsonObject)[key];
  }
  return current;
}

/** A copy of `value` with `path` replaced. */
export function setAt<T>(value: T, path: readonly string[], next: unknown): T {
  if (path.length === 0) return next as T;
  const [head, ...rest] = path as [string, ...string[]];
  const base = (typeof value === "object" && value !== null ? value : {}) as JsonObject;
  return { ...base, [head]: setAt(base[head], rest, next) } as T;
}

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Leaf paths that differ ("risk.riskUsd"). Arrays count as one leaf. */
export function changedPaths(a: unknown, b: unknown, prefix: string[] = []): string[] {
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((key) => changedPaths(a[key], b[key], [...prefix, key]));
  }
  return same(a, b) ? [] : [prefix.join(".")];
}

/** Only what changed, nested the way the server merges it; null when nothing changed. */
export function diffPatch(original: unknown, draft: unknown): JsonObject | null {
  const paths = changedPaths(original, draft);
  if (paths.length === 0) return null;
  let patch: JsonObject = {};
  for (const key of paths) {
    const path = key.split(".");
    patch = setAt(patch, path, getAt(draft, path));
  }
  return patch;
}

/** "btcusdt, ETHUSDT\nsolusdt" → ["BTCUSDT", "ETHUSDT", "SOLUSDT"], without duplicates. */
export function parseSymbols(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const symbol = raw.trim().toUpperCase();
    if (symbol && !out.includes(symbol)) out.push(symbol);
  }
  return out;
}

/** Text typed in a number box → number, or an error to show. */
export function parseNumber(text: string, field: Pick<FieldDef, "kind" | "min" | "max">): { ok: true; value: number } | { ok: false; error: string } {
  const normalized = text.trim().replace(",", ".");
  if (normalized === "") return { ok: false, error: "Cần nhập số" };
  const value = Number(normalized);
  if (!Number.isFinite(value)) return { ok: false, error: "Không phải số" };
  if (field.kind === "integer" && !Number.isInteger(value)) return { ok: false, error: "Cần số nguyên" };
  if (field.min !== null && value < field.min) return { ok: false, error: `Nhỏ nhất ${field.min}` };
  if (field.max !== null && value > field.max) return { ok: false, error: `Lớn nhất ${field.max}` };
  return { ok: true, value };
}

/** Server field errors keyed by path, plus errors on a parent object shown on its first field. */
export function errorsByPath(errors: readonly { path: string; message: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of errors) map.set(e.path, map.has(e.path) ? `${map.get(e.path)}; ${e.message}` : e.message);
  return map;
}
