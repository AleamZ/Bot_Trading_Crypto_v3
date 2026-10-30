import { randomBytes } from "node:crypto";
import { AiClient } from "./ai/client.js";
import { isPasswordHash } from "./api/auth.js";
import { buildServer } from "./api/server.js";
import { findWebDir } from "./api/web.js";
import { BotRuntime } from "./app/runtime.js";
import { BinanceFutures } from "./binance/futures.js";
import { BinanceRest } from "./binance/rest.js";
import { loadEnv } from "./config/env.js";
import { openDatabase } from "./db/database.js";
import { createLogger } from "./lib/logger.js";
import { acquireLock } from "./lib/lock.js";
import { TelegramClient } from "./telegram/client.js";

export async function run(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL, "bot");
  logger.info("Starting bot v3", {
    envFile: env.envFile,
    db: env.dbPath,
    binance: env.binanceRestUrl,
    tradingEnabled: env.TRADING_ENABLED,
    hasKeys: env.hasBinanceKeys,
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN),
  });

  const release = env.dbPath === ":memory:" ? () => {} : acquireLock(`${env.dbPath}.lock`);
  const db = openDatabase(env.dbPath);

  const rest = new BinanceRest({ baseUrl: env.binanceRestUrl, apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET, logger });
  await rest.syncTime().catch((error) => logger.warn("Clock sync failed; will retry on the first signed request", { error: String(error) }));
  const exchange = new BinanceFutures(rest);
  const telegramClient = env.TELEGRAM_BOT_TOKEN ? new TelegramClient(env.TELEGRAM_BOT_TOKEN) : null;
  const aiClient = env.AI_BASE_URL
    ? new AiClient({ baseUrl: env.AI_BASE_URL, apiKey: env.AI_API_KEY, model: env.AI_MODEL, timeoutMs: env.AI_TIMEOUT_MS })
    : null;
  logger.info(aiClient ? "AI on" : "AI off (no AI_BASE_URL)", aiClient ? { host: aiClient.host, model: aiClient.model } : {});
  const runtime = new BotRuntime({ env, db, exchange, telegramClient, aiClient, logger });

  let passwordHash = env.ADMIN_PASSWORD_HASH ?? null;
  if (passwordHash && !isPasswordHash(passwordHash)) {
    logger.error("ADMIN_PASSWORD_HASH is not a hash from `npm run hash-password`; login is disabled");
    passwordHash = null;
  }
  if (!passwordHash) logger.warn("No ADMIN_PASSWORD_HASH: the web UI cannot log in until you run `npm run hash-password` and add it to .env");
  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString("base64url");
    logger.warn("No SESSION_SECRET in .env: logins last only until the bot restarts");
  }
  const webDir = env.WEB_DIR ?? findWebDir();
  logger.info(webDir ? "Serving the web UI" : "No built web UI found (npm run build); serving the API only", { webDir });
  const server = await buildServer({
    runtime,
    webDir,
    auth: { username: env.ADMIN_USERNAME, passwordHash, sessionSecret, secureCookie: env.PUBLIC_URL?.startsWith("https://") ?? false },
    logger,
  });

  let stopping = false;
  const shutdown = async (signal: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    logger.warn("Shutting down", { signal });
    const force = setTimeout(() => process.exit(code || 1), 20_000);
    force.unref();
    try {
      await server.close();
      await runtime.stop(signal);
    } catch (error) {
      logger.error("Shutdown failed", { error });
    } finally {
      db.close();
      release();
      process.exit(code);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", { error: reason });
    runtime.hub.emit({ type: "ERROR", message: "Lỗi không xử lý được trong bot", detail: String(reason) });
  });
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception; exiting so pm2 restarts the bot", { error });
    void shutdown("uncaughtException", 1);
  });

  await server.listen({ host: env.HOST, port: env.PORT });
  logger.info("API listening", { url: `http://${env.HOST}:${env.PORT}` });
  await runtime.start();
}
