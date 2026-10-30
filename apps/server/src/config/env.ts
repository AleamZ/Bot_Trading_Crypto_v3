import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Environment configuration. Only these values come from `.env`, never from the settings stored in
 * the database, so the UI cannot switch the bot to live trading or turn the master switch on.
 */

const empty = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

/** "true" / "false" only. z.coerce.boolean would read the text "false" as true. */
const textBoolean = (fallback: boolean) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() || undefined : value),
    z.enum(["true", "false"], { error: 'Chỉ nhận "true" hoặc "false"' }).default(fallback ? "true" : "false"),
  ).transform((value) => value === "true");

const optionalText = z.preprocess(empty, z.string().trim().optional());

export const BINANCE_URLS = {
  demo: { rest: "https://demo-fapi.binance.com", ws: "wss://demo-fstream.binance.com/ws" },
} as const;

const envSchema = z.object({
  NODE_ENV: z.preprocess(empty, z.enum(["development", "production", "test"]).default("development")),
  HOST: z.preprocess(empty, z.string().default("127.0.0.1")),
  PORT: z.preprocess(empty, z.coerce.number().int().min(1).max(65535).default(8787)),
  PUBLIC_URL: z.preprocess(empty, z.url().optional()),
  BINANCE_ENV: z.preprocess(
    empty,
    z.enum(["demo"], { error: "Phiên bản này chỉ chạy BINANCE_ENV=demo (https://demo-fapi.binance.com)" }).default("demo"),
  ),
  BINANCE_API_KEY: optionalText,
  BINANCE_API_SECRET: optionalText,
  BINANCE_REST_URL: z.preprocess(empty, z.url().optional()),
  BINANCE_WS_URL: z.preprocess(empty, z.url().optional()),
  TRADING_ENABLED: textBoolean(false),
  TELEGRAM_BOT_TOKEN: optionalText,
  TELEGRAM_CHAT_ID: optionalText,
  ADMIN_USERNAME: z.preprocess(empty, z.string().default("admin")),
  ADMIN_PASSWORD_HASH: optionalText,
  SESSION_SECRET: optionalText,
  DB_PATH: z.preprocess(empty, z.string().default("./data/bot.db")),
  LOG_LEVEL: z.preprocess(empty, z.enum(["debug", "info", "warn", "error"]).default("info")),
});

export type RawEnv = z.output<typeof envSchema>;

export interface AppEnv extends RawEnv {
  binanceRestUrl: string;
  binanceWsUrl: string;
  /** Both Binance keys are present. */
  hasBinanceKeys: boolean;
  /** DB_PATH made absolute against the folder of the .env file (the repo root), or the cwd. */
  dbPath: string;
  envFile: string | null;
}

export function parseEnv(source: Record<string, string | undefined>, envFile: string | null = null): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Cấu hình .env không hợp lệ:\n${lines.join("\n")}`);
  }
  const env = result.data;
  const urls = BINANCE_URLS[env.BINANCE_ENV];
  return {
    ...env,
    binanceRestUrl: env.BINANCE_REST_URL ?? urls.rest,
    binanceWsUrl: env.BINANCE_WS_URL ?? urls.ws,
    hasBinanceKeys: Boolean(env.BINANCE_API_KEY && env.BINANCE_API_SECRET),
    dbPath: env.DB_PATH === ":memory:" ? env.DB_PATH : path.resolve(envFile ? path.dirname(envFile) : process.cwd(), env.DB_PATH),
    envFile,
  };
}

/** The first `.env` found walking up from `start` (the repo root when run from apps/server), or null. */
export function findEnvFile(start = process.cwd(), maxDepth = 4): string | null {
  let dir = path.resolve(start);
  for (let depth = 0; depth <= maxDepth; depth++) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Loads ENV_FILE or the nearest `.env` into process.env (existing variables win), then parses. */
export function loadEnv(): AppEnv {
  const file = process.env.ENV_FILE ?? findEnvFile();
  if (file) {
    try {
      process.loadEnvFile(file);
    } catch (error) {
      throw new Error(`Không đọc được ${file}: ${(error as Error).message}`);
    }
  }
  return parseEnv(process.env, file ? path.resolve(file) : null);
}
