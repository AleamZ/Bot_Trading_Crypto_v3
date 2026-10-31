import { defaultSettings, settingsJsonSchema, settingsWarnings } from "@bot-v3/core";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { BotError, type BotRuntime } from "../app/runtime.js";
import type { LogLevelName } from "../db/stores.js";
import type { TradeStatus } from "../engine/types.js";
import { silentLogger, type Logger } from "../lib/logger.js";
import { AiError } from "../ai/client.js";
import { TelegramError } from "../telegram/client.js";
import { serveWeb } from "./web.js";
import { clearedCookie, LoginLimiter, parseCookies, safeEqual, SessionSigner, sessionCookie, verifyPassword, type Session } from "./auth.js";

export const SESSION_COOKIE = "bot3_session";

export interface ServerOptions {
  runtime: BotRuntime;
  auth: {
    username: string;
    /** null: no password configured yet, every protected route answers 401 SETUP_REQUIRED. */
    passwordHash: string | null;
    sessionSecret: string;
    /** Set the Secure flag (the site is served over https). */
    secureCookie: boolean;
    sessionTtlMs?: number;
  };
  /** Built web UI (apps/web/dist) served at /, or null for the API only. */
  webDir?: string | null;
  logger?: Logger;
  now?: () => number;
  heartbeatMs?: number;
}

declare module "fastify" {
  interface FastifyRequest {
    session: Session | null;
  }
}

/** Routes anyone may call. Everything else under /api needs a session. */
const PUBLIC = new Set(["/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/me"]);

const TRADE_STATUSES = ["OPENING", "OPEN", "CLOSED", "FAILED"] as const;
const LEVELS = ["info", "warn", "error"] as const;

const csv = <T extends string>(values: readonly T[]) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const list = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      for (const item of list) {
        if (!(values as readonly string[]).includes(item)) ctx.addIssue({ code: "custom", message: `Giá trị không hợp lệ: ${item}` });
      }
      return list as T[];
    });

/** Optional time range in ms (Vietnam days are turned into ms by the UI); `to` is exclusive. */
const range = {
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
};
const ranged = (q: { from?: number | undefined; to?: number | undefined }) => ({ ...(q.from !== undefined ? { from: q.from } : {}), ...(q.to !== undefined ? { to: q.to } : {}) });

const tradesQuery = z.object({
  ...range,
  status: csv(TRADE_STATUSES),
  symbol: z.string().trim().toUpperCase().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const eventsQuery = z.object({
  ...range,
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  level: csv(LEVELS),
  symbol: z.string().trim().toUpperCase().optional(),
});

const chartQuery = z.object({
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,20}USDT$/, "Symbol phải có dạng XXXUSDT"),
  limit: z.coerce.number().int().min(50).max(1000).default(300),
});

const statsQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Tháng phải có dạng YYYY-MM")
    .optional(),
});

const chatBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) }))
    .min(1)
    .max(30),
});

const reviewsQuery = z.object({
  ...range,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  outcome: z.enum(["WIN", "LOSS", "FLAT"]).optional(),
  symbol: z.string().trim().toUpperCase().optional(),
});

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const loginBody = z.object({ username: z.string().max(200), password: z.string().max(1000) });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new BotError(400, "BAD_REQUEST", "Tham số không hợp lệ", result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return result.data;
}

const actor = (request: FastifyRequest) => `UI ${request.session?.username ?? "?"}`;

/**
 * The HTTP API (JSON under /api, SSE at /api/events/stream). Errors the user can act on are 4xx
 * with { error, message }: Cloudflare replaces the body of a 502, which once hid the real error.
 */
export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const { runtime, auth } = options;
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? Date.now;
  const ttl = auth.sessionTtlMs ?? 7 * 86_400_000;
  const signer = auth.passwordHash ? new SessionSigner(auth.sessionSecret, auth.passwordHash, ttl, now) : null;
  const limiter = new LoginLimiter(5, 30, 15 * 60_000, now);

  // Only nginx on this machine is trusted to say who the client is.
  const app = Fastify({ logger: false, trustProxy: "127.0.0.1,::1", bodyLimit: 256 * 1024 });
  app.decorateRequest("session", null);

  app.setErrorHandler((error: Error & { statusCode?: number; errors?: unknown; validation?: unknown }, request, reply) => {
    if (error instanceof BotError) {
      return reply.status(error.status).send({ error: error.code, message: error.message, ...(error.errors ? { errors: error.errors } : {}) });
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ error: "BAD_REQUEST", message: error.message });
    }
    logger.error("API error", { method: request.method, url: request.url, error });
    return reply.status(500).send({ error: "INTERNAL", message: "Lỗi máy chủ, xem log của bot" });
  });
  const webDir = options.webDir ?? null;
  app.setNotFoundHandler(async (request, reply) => {
    if (webDir && (await serveWeb(webDir, request, reply))) return reply;
    return reply.status(404).send({ error: "NOT_FOUND", message: `Không có ${request.method} ${request.url}` });
  });

  app.addHook("onRequest", async (request, reply) => {
    request.session = signer?.verify(parseCookies(request.headers.cookie)[SESSION_COOKIE]) ?? null;
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/api/") || PUBLIC.has(path)) return;
    if (!signer) return reply.status(401).send({ error: "SETUP_REQUIRED", message: "Chưa có ADMIN_PASSWORD_HASH trong .env (chạy npm run hash-password)" });
    if (!request.session) return reply.status(401).send({ error: "UNAUTHORIZED", message: "Cần đăng nhập" });
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/health")) {
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
    }
    return payload;
  });

  // Health (no secrets): pm2/deploy scripts and the UI before login.
  const health = async () => ({ ok: true, version: "0.1.0", uptimeSec: Math.round((now() - runtime.startedAt) / 1000), exchangeOk: runtime.exchangeOk });
  app.get("/health", health);
  app.get("/health/ready", health);
  app.get("/api/health", health);

  // --- auth
  app.get("/api/auth/me", async (request) => ({
    authenticated: request.session !== null,
    username: request.session?.username ?? null,
    passwordConfigured: signer !== null,
  }));

  app.post("/api/auth/login", async (request, reply) => {
    if (!signer || !auth.passwordHash) throw new BotError(409, "SETUP_REQUIRED", "Chưa có ADMIN_PASSWORD_HASH trong .env (chạy npm run hash-password)");
    const ip = String(request.headers["cf-connecting-ip"] ?? request.ip);
    const wait = limiter.retryAfter(ip);
    if (wait > 0) {
      reply.header("retry-after", Math.ceil(wait / 1000));
      throw new BotError(429, "TOO_MANY_ATTEMPTS", `Sai quá nhiều lần, thử lại sau ${Math.ceil(wait / 60_000)} phút`);
    }
    const body = parse(loginBody, request.body);
    const userOk = safeEqual(body.username, auth.username);
    const passOk = await verifyPassword(body.password, auth.passwordHash);
    if (!userOk || !passOk) {
      limiter.fail(ip);
      logger.warn("Login failed", { ip, username: body.username.slice(0, 50) });
      throw new BotError(401, "BAD_CREDENTIALS", "Sai tên đăng nhập hoặc mật khẩu");
    }
    limiter.succeed(ip);
    const { token, expiresAt } = signer.sign(auth.username);
    reply.header("set-cookie", sessionCookie(SESSION_COOKIE, token, Math.floor(ttl / 1000), auth.secureCookie));
    logger.info("Login", { ip, username: auth.username });
    return { authenticated: true, username: auth.username, expiresAt };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.header("set-cookie", clearedCookie(SESSION_COOKIE, auth.secureCookie));
    return { authenticated: false };
  });

  // --- status and analysis
  app.get("/api/status", async () => runtime.status());

  app.get("/api/analysis", async () => {
    const s = runtime.statusSummary();
    return { items: s.analysis, lastScan: runtime.scanner.lastReport, nextScanAt: runtime.scanner.nextScanAt };
  });

  app.post("/api/scan", async () => runtime.scanner.scanNow());

  // --- AI: trade reviews and the chat
  app.get("/api/ai", async () => runtime.aiStatus());

  app.post("/api/ai/chat", async (request) => {
    const body = parse(chatBody, request.body);
    if (!runtime.chat.enabled) throw new BotError(409, "AI_OFF", "AI đang tắt: thêm AI_BASE_URL vào .env rồi khởi động lại bot");
    if (!runtime.settings.get().ai.chatEnabled) throw new BotError(409, "CHAT_OFF", "Chat AI đang tắt trong Cài đặt → AI");
    try {
      return await runtime.chat.reply(body.messages);
    } catch (error) {
      if (error instanceof AiError) throw new BotError(424, "AI_ERROR", error.message);
      throw error;
    }
  });

  app.get("/api/reviews", async (request) => {
    const q = parse(reviewsQuery, request.query);
    const items = runtime.reviewStore.list({ limit: q.limit, ...(q.outcome ? { outcome: q.outcome } : {}), ...(q.symbol ? { symbol: q.symbol } : {}), ...ranged(q) });
    return { items: items.map((r) => ({ ...r, trade: runtime.trades.getSync(r.tradeId) })) };
  });

  app.get("/api/reviews/insights", async () => ({ insights: runtime.reviews.latestInsights() }));

  app.post("/api/reviews/insights", async () => {
    if (!runtime.reviews.enabled) throw new BotError(409, "AI_OFF", "AI đang tắt: thêm AI_BASE_URL vào .env rồi khởi động lại bot");
    try {
      return { insights: await runtime.reviews.insights() };
    } catch (error) {
      throw new BotError(error instanceof AiError ? 424 : 409, "INSIGHTS_FAILED", errorMessage(error));
    }
  });

  app.post<{ Params: { tradeId: string } }>("/api/reviews/:tradeId", async (request) => {
    const trade = runtime.trades.getSync(request.params.tradeId);
    if (!trade) throw new BotError(404, "NOT_FOUND", `Không có lệnh ${request.params.tradeId}`);
    if (trade.status !== "CLOSED" || !trade.entryPrice) throw new BotError(409, "NOT_CLOSED", "Chỉ phân tích được lệnh đã vào và đã đóng");
    if (!runtime.reviews.enabled) throw new BotError(409, "AI_OFF", "AI đang tắt: thêm AI_BASE_URL vào .env rồi khởi động lại bot");
    const record = await runtime.reviews.enqueue(trade.id);
    return { ...record, trade: runtime.trades.getSync(trade.id) };
  });

  app.get("/api/chart", async (request) => {
    const q = parse(chartQuery, request.query);
    return runtime.chart(q.symbol, q.limit);
  });

  // --- settings
  app.get("/api/settings", async () => {
    const settings = runtime.settings.get();
    return { settings, defaults: defaultSettings(), schema: settingsJsonSchema(), warnings: settingsWarnings(settings) };
  });

  app.put("/api/settings", async (request) => {
    const settings = runtime.updateSettings(request.body ?? {}, actor(request));
    return { settings, warnings: settingsWarnings(settings) };
  });

  app.post("/api/settings/reset", async (request) => {
    const settings = runtime.resetSettings(actor(request));
    return { settings, warnings: settingsWarnings(settings) };
  });

  // --- bot control
  app.post("/api/bot/pause", async (request) => {
    runtime.control.pause(actor(request));
    return { paused: runtime.control.paused };
  });

  app.post("/api/bot/resume", async (request) => {
    runtime.control.resume(actor(request));
    return { paused: runtime.control.paused };
  });

  // --- trades and positions
  app.get("/api/trades", async (request) => {
    const q = parse(tradesQuery, request.query);
    const since = runtime.statsSince();
    return runtime.trades.list({
      statuses: q.status as TradeStatus[],
      ...(q.symbol ? { symbol: q.symbol } : {}),
      ...ranged(q),
      ...(since !== null ? { since } : {}),
      limit: q.limit,
      offset: q.offset,
    });
  });

  app.get<{ Params: { id: string } }>("/api/trades/:id", async (request) => {
    const trade = runtime.trades.getSync(request.params.id);
    if (!trade) throw new BotError(404, "NOT_FOUND", `Không có lệnh ${request.params.id}`);
    return trade;
  });

  app.post<{ Params: { id: string } }>("/api/trades/:id/close", async (request) => runtime.closeTrade(request.params.id, actor(request)));

  app.get("/api/positions", async () => runtime.positions());

  app.get("/api/today", async () => runtime.today());

  app.get("/api/stats", async (request) => runtime.monthStats(parse(statsQuery, request.query).month));

  app.get("/api/stats/all", async () => runtime.allStats());

  // Clearing P&L hides older finished trades from stats and the trade list; nothing is deleted.
  app.post("/api/stats/reset", async (request) => ({ since: runtime.resetStats(actor(request)) }));

  app.post("/api/stats/restore", async (request) => {
    runtime.restoreStats(actor(request));
    return { since: null };
  });

  // --- activity log
  app.get("/api/events", async (request) => {
    const q = parse(eventsQuery, request.query);
    return {
      items: runtime.log.list({
        limit: q.limit,
        levels: q.level as LogLevelName[],
        ...(q.before ? { before: q.before } : {}),
        ...(q.symbol ? { symbol: q.symbol } : {}),
        ...ranged(q),
      }),
    };
  });

  app.get("/api/events/stream", (request, reply) => streamEvents(runtime, request, reply, options.heartbeatMs ?? 15_000));

  // --- telegram
  app.get("/api/telegram", async () => {
    const telegram = runtime.telegram;
    if (!telegram) return { configured: false, hint: "Thêm TELEGRAM_BOT_TOKEN vào .env rồi khởi động lại bot" };
    const status = telegram.status();
    return { ...status, candidates: telegram.candidates() };
  });

  app.post("/api/telegram/test", async () => {
    if (!runtime.telegram) throw new BotError(409, "TELEGRAM_OFF", "Chưa có TELEGRAM_BOT_TOKEN trong .env");
    try {
      await runtime.telegram.sendTest();
    } catch (error) {
      if (error instanceof TelegramError) throw new BotError(error.status === 0 && !runtime.env.TELEGRAM_CHAT_ID ? 409 : 424, "TELEGRAM_ERROR", error.message);
      throw error;
    }
    return { sent: true };
  });

  return app;
}

/**
 * Server-sent events: "log" entries (with ids, replayed after a reconnect via Last-Event-ID),
 * "status" snapshots and "analysis" updates. Comments every 15s keep Cloudflare and nginx from
 * closing an idle stream; x-accel-buffering stops nginx from buffering it.
 */
function streamEvents(runtime: BotRuntime, request: FastifyRequest, reply: FastifyReply, heartbeatMs: number): void {
  const since = Number(request.headers["last-event-id"] ?? (request.query as { since?: string }).since ?? 0) || 0;
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (event: string, data: unknown, id?: number) => {
    if (res.writableEnded) return;
    res.write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  res.write("retry: 3000\n\n");
  if (since > 0) for (const entry of runtime.log.since(since)) send("log", entry, entry.id);
  send("status", runtime.status());
  for (const view of runtime.statusSummary().analysis) send("analysis", view);

  const offEvent = runtime.hub.onEvent((_event, entry) => {
    send("log", entry, entry.id || undefined);
    send("status", runtime.status());
  });
  const offLive = runtime.hub.onLive((channel, data) => send(channel, channel === "status" ? runtime.status() : data));
  const ping = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
  request.raw.on("close", () => {
    clearInterval(ping);
    offEvent();
    offLive();
  });
}
