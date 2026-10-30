import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/api/auth.js";
import { buildServer, SESSION_COOKIE } from "../src/api/server.js";
import { sampleTrade } from "./fixtures.js";
import { fakeAi, LONG3, runtimeHarness, type RuntimeHarnessOptions } from "./runtimeHarness.js";

const PASSWORD = "mật-khẩu-đủ-dài";
const passwordHash = await hashPassword(PASSWORD, { N: 1024, r: 8, p: 1 });

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function apiHarness(options: RuntimeHarnessOptions & { hash?: string | null; webDir?: string } = {}) {
  const h = runtimeHarness(options);
  const app = await buildServer({
    runtime: h.runtime,
    auth: { username: "admin", passwordHash: options.hash === undefined ? passwordHash : options.hash, sessionSecret: "test-secret", secureCookie: true },
    now: () => h.exchange.clock,
    heartbeatMs: 50,
    webDir: options.webDir ?? null,
  });
  servers.push(app);
  const login = async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    return { cookie };
  };
  return { ...h, app, login };
}

describe("API auth", () => {
  it("serves health without a session and protects the rest", async () => {
    const h = await apiHarness();
    const health = await h.app.inject({ url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });
    const status = await h.app.inject({ url: "/api/status" });
    expect(status.statusCode).toBe(401);
    expect(status.json()).toEqual({ error: "UNAUTHORIZED", message: "Cần đăng nhập" });
    expect((await h.app.inject({ url: "/api/auth/me" })).json()).toEqual({ authenticated: false, username: null, passwordConfigured: true });
  });

  it("logs in with the .env password and sets a strict, http-only, secure cookie", async () => {
    const h = await apiHarness();
    const bad = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "sai" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe("BAD_CREDENTIALS");

    const res = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");
    const cookie = setCookie.split(";")[0]!;
    expect((await h.app.inject({ url: "/api/status", headers: { cookie } })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/api/auth/me", headers: { cookie } })).json()).toMatchObject({ authenticated: true, username: "admin" });
    const logout = await h.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
  });

  it("rate-limits failed logins with 429", async () => {
    const h = await apiHarness();
    for (let i = 0; i < 5; i++) await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "sai" } });
    const blocked = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("says setup is required when no password hash is configured", async () => {
    const h = await apiHarness({ hash: null });
    expect((await h.app.inject({ url: "/api/status" })).json().error).toBe("SETUP_REQUIRED");
    const login = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
    expect(login.statusCode).toBe(409);
  });
});

describe("API settings", () => {
  it("returns settings with the JSON schema the UI builds its form from", async () => {
    const h = await apiHarness();
    const { cookie } = await h.login();
    const body = (await h.app.inject({ url: "/api/settings", headers: { cookie } })).json();
    expect(body.settings.risk.riskUsd).toBe(5);
    expect(body.schema.properties.risk.properties.riskUsd).toMatchObject({ title: "1R", unit: "$" });
    expect(body.warnings).toEqual([]);
  });

  it("saves a valid patch, logs who changed what, and answers 422 for an invalid one", async () => {
    const h = await apiHarness();
    const { cookie } = await h.login();
    const ok = await h.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload: { risk: { riskUsd: 7.5 }, general: { watchlist: ["btcusdt"] } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.risk.riskUsd).toBe(7.5);
    expect(h.runtime.settings.get().general.watchlist).toEqual(["BTCUSDT"]);
    expect(h.runtime.log.list({ limit: 1 })[0]).toMatchObject({ type: "SETTINGS_CHANGED", message: "Bởi UI admin: general.watchlist, risk.riskUsd" });

    const bad = await h.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload: { risk: { riskUsd: -1, minSlPct: 5, maxSlPct: 1 } } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: "INVALID_SETTINGS", errors: expect.arrayContaining([expect.objectContaining({ path: "risk.riskUsd" })]) });
    expect(h.runtime.settings.get().risk.riskUsd).toBe(7.5);
  });

  it("cannot turn on trading from the UI: env switches are not settings", async () => {
    const h = await apiHarness({ env: { TRADING_ENABLED: "false" } });
    const { cookie } = await h.login();
    await h.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload: { TRADING_ENABLED: true, tradingEnabled: true, general: { autoTrade: true } } });
    const status = (await h.app.inject({ url: "/api/status", headers: { cookie } })).json();
    expect(status).toMatchObject({ tradingEnabled: false, autoTradeAllowed: false, autoTradeBlockers: ["TRADING_ENABLED=false trong .env"] });
    expect(h.runtime.kv.get<Record<string, unknown>>("settings", {})).not.toHaveProperty("tradingEnabled");
  });

  it("persists settings across a restart of the runtime", async () => {
    const h = await apiHarness();
    h.runtime.updateSettings({ risk: { rr: 3 } }, "test");
    const { SettingsService } = await import("../src/app/control.js");
    expect(new SettingsService(h.runtime.kv).get().risk.rr).toBe(3);
  });
});

describe("API control, trades and errors", () => {
  it("pauses and resumes", async () => {
    const h = await apiHarness();
    const { cookie } = await h.login();
    expect((await h.app.inject({ method: "POST", url: "/api/bot/pause", headers: { cookie } })).json()).toEqual({ paused: true });
    expect(h.runtime.status().paused).toBe(true);
    expect((await h.app.inject({ method: "POST", url: "/api/bot/resume", headers: { cookie } })).json()).toEqual({ paused: false });
    expect(h.runtime.log.list({ limit: 2 }).map((e) => e.type)).toEqual(["BOT_RESUMED", "BOT_PAUSED"]);
  });

  it("lists trades, validates queries with 400, and closes a trade by hand", async () => {
    const h = await apiHarness();
    const { cookie } = await h.login();
    const outcome = await h.runtime.executor.enter({ symbol: "BTCUSDT", direction: "LONG", signals: LONG3, atr: 400, settings: h.runtime.settings.get() });
    expect(outcome.ok).toBe(true);
    const list = (await h.app.inject({ url: "/api/trades?status=OPEN", headers: { cookie } })).json();
    expect(list.total).toBe(1);
    const id = list.trades[0].id as string;
    expect((await h.app.inject({ url: "/api/trades?status=BOGUS", headers: { cookie } })).statusCode).toBe(400);
    expect((await h.app.inject({ url: "/api/trades/nope", headers: { cookie } })).statusCode).toBe(404);

    const closed = await h.app.inject({ method: "POST", url: `/api/trades/${id}/close`, headers: { cookie } });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: "CLOSED", exitReason: "MANUAL" });
    expect(h.exchange.positionAmt()).toBe(0);
    expect(h.exchange.openAlgos()).toEqual([]);
    expect((await h.app.inject({ method: "POST", url: `/api/trades/${id}/close`, headers: { cookie } })).statusCode).toBe(409);
  });

  it("answers exchange problems with 4xx, never 502", async () => {
    const h = await apiHarness();
    const { cookie } = await h.login();
    h.exchange.getPositions = async () => {
      throw new Error("socket hang up");
    };
    const res = await h.app.inject({ url: "/api/positions", headers: { cookie } });
    expect(res.statusCode).toBe(424);
    expect(res.json()).toEqual({ error: "EXCHANGE_ERROR", message: "socket hang up" });
  });

  it("answers 409 for positions without API keys and for Telegram when it is not set up", async () => {
    const h = await apiHarness({ env: { BINANCE_API_KEY: "", BINANCE_API_SECRET: "" } });
    const { cookie } = await h.login();
    expect((await h.app.inject({ url: "/api/positions", headers: { cookie } })).json()).toMatchObject({ error: "NO_KEYS" });
    expect((await h.app.inject({ url: "/api/telegram", headers: { cookie } })).json()).toMatchObject({ configured: false });
    expect((await h.app.inject({ method: "POST", url: "/api/telegram/test", headers: { cookie } })).statusCode).toBe(409);
  });

  it("sends a Telegram test message", async () => {
    const h = await apiHarness({ telegram: true });
    const { cookie } = await h.login();
    const res = await h.app.inject({ method: "POST", url: "/api/telegram/test", headers: { cookie } });
    expect(res.json()).toEqual({ sent: true });
    expect(h.telegram.sent()[0]).toContain("Tin nhắn thử");
  });

  it("pages the activity log", async () => {
    const h = await apiHarness();
    const { cookie } = await h.login();
    for (let i = 0; i < 3; i++) h.runtime.hub.emit({ type: "ERROR", message: `lỗi ${i}` });
    const page = (await h.app.inject({ url: "/api/events?limit=2&level=error", headers: { cookie } })).json();
    expect(page.items.map((e: { title: string }) => e.title)).toEqual(["lỗi 2", "lỗi 1"]);
    const next = (await h.app.inject({ url: `/api/events?before=${page.items[1].id}&level=error`, headers: { cookie } })).json();
    expect(next.items.map((e: { title: string }) => e.title)).toEqual(["lỗi 0"]);
  });
});

describe("API event stream", () => {
  it("streams status, then log entries as they happen, with SSE headers nginx will not buffer", async () => {
    const h = await apiHarness();
    const { cookie } = await h.login();
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = h.app.server.address() as AddressInfo;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events/stream`, { headers: { cookie }, signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await readUntil("event: status");
    h.runtime.hub.emit({ type: "BOT_PAUSED", by: "test" });
    await readUntil("Đã tạm dừng");
    expect(text).toMatch(/id: \d+\nevent: log\ndata: .*BOT_PAUSED/);
    await readUntil(": ping");
    controller.abort();
  });

  it("refuses the stream without a session", async () => {
    const h = await apiHarness();
    expect((await h.app.inject({ url: "/api/events/stream" })).statusCode).toBe(401);
  });
});

describe("web UI files", () => {
  const base = mkdtempSync(path.join(tmpdir(), "bot-v3-web-"));
  const dir = path.join(base, "dist");
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Bot V3</title>");
  writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(path.join(base, "secret.txt"), "no");

  it("serves index.html uncached with a CSP, and hashed assets for a year", async () => {
    const h = await apiHarness({ webDir: dir });
    const index = await h.app.inject({ url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect(index.headers["content-security-policy"]).toContain("default-src 'self'");
    const asset = await h.app.inject({ url: "/assets/index-abc123.js" });
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect((await h.app.inject({ url: "/settings" })).body).toContain("<title>Bot V3</title>");
  });

  it("never leaves the folder and keeps API 404s as JSON", async () => {
    const h = await apiHarness({ webDir: dir });
    for (const url of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const res = await h.app.inject({ url });
      expect(res.body).not.toBe("no");
    }
    expect((await h.app.inject({ url: "/assets/missing.js" })).statusCode).toBe(404);
    const api = await h.app.inject({ url: "/api/nope", headers: { cookie: (await h.login()).cookie } });
    expect(api.statusCode).toBe(404);
    expect(api.json().error).toBe("NOT_FOUND");
  });
});

describe("API chart", () => {
  it("returns candles, overlays, each method's conditions, the guard verdict and trades for a symbol", async () => {
    const h = await apiHarness();
    const { cookie } = await h.login();
    const res = await h.app.inject({ url: "/api/chart?symbol=btcusdt&limit=100", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ symbol: "BTCUSDT", timeframe: "15m", trendTimeframe: "1h", inWatchlist: true, preview: null, guard: { ok: true } });
    expect(body.candles.length).toBeGreaterThan(0);
    expect(body.overlays.lines.map((l: { id: string }) => l.id)).toContain("donchianUpper");
    expect(Object.keys(body.explanation)).toEqual(["trendPullback", "donchianBreakout", "smcSweep"]);
    expect(body.explanation.trendPullback.sides.map((s: { direction: string }) => s.direction)).toEqual(["LONG", "SHORT"]);
    expect(body.analysis.consensus.level).toBe("NONE");
  });

  it("validates the symbol and reports exchange problems as 424", async () => {
    const h = await apiHarness();
    const { cookie } = await h.login();
    expect((await h.app.inject({ url: "/api/chart?symbol=BTC", headers: { cookie } })).statusCode).toBe(400);
    h.exchange.failCandles = new Error("timeout");
    const res = await h.app.inject({ url: "/api/chart?symbol=DOGEUSDT", headers: { cookie } });
    expect(res.statusCode).toBe(424);
    expect(res.json().message).toContain("DOGEUSDT");
  });
});

describe("API AI", () => {
  it("says AI is off and refuses chat with 409 when there is no AI_BASE_URL", async () => {
    const h = await apiHarness();
    const { cookie } = await h.login();
    expect((await h.app.inject({ url: "/api/ai", headers: { cookie } })).json()).toMatchObject({ enabled: false, hint: expect.stringContaining("AI_BASE_URL") });
    const chat = await h.app.inject({ method: "POST", url: "/api/ai/chat", headers: { cookie }, payload: { messages: [{ role: "user", content: "hi" }] } });
    expect(chat.statusCode).toBe(409);
    expect(chat.json().error).toBe("AI_OFF");
  });

  it("chats, validates the messages, and maps AI failures to 424", async () => {
    const ai = fakeAi();
    ai.replies.push({ content: "Xin chào" }, { status: 500, text: "router down" });
    const h = await apiHarness({ ai });
    const { cookie } = await h.login();
    const ok = await h.app.inject({ method: "POST", url: "/api/ai/chat", headers: { cookie }, payload: { messages: [{ role: "user", content: "hi" }] } });
    expect(ok.json()).toMatchObject({ reply: "Xin chào", model: "fake-model" });
    expect((await h.app.inject({ method: "POST", url: "/api/ai/chat", headers: { cookie }, payload: { messages: [] } })).statusCode).toBe(400);
    const down = await h.app.inject({ method: "POST", url: "/api/ai/chat", headers: { cookie }, payload: { messages: [{ role: "user", content: "hi" }] } });
    expect(down.statusCode).toBe(424);
    expect(down.json().message).toContain("500");
  });

  it("reviews a closed trade on request and lists reviews with their trade", async () => {
    const ai = fakeAi();
    ai.replies.push({ content: '{"summary":"Thắng nhờ xu hướng","causes":["xu hướng mạnh"]}' });
    const h = await apiHarness({ ai });
    const { cookie } = await h.login();
    await h.runtime.trades.insert(sampleTrade({ id: "w1", status: "CLOSED", exitReason: "TP", pnlR: 1.8, netPnl: "9", openedAt: h.exchange.clock - 3_600_000, closedAt: h.exchange.clock - 600_000 }));
    expect((await h.app.inject({ method: "POST", url: "/api/reviews/nope", headers: { cookie } })).statusCode).toBe(404);
    const res = await h.app.inject({ method: "POST", url: "/api/reviews/w1", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tradeId: "w1", status: "DONE", outcome: "WIN", review: { summary: "Thắng nhờ xu hướng", lessons: [] }, trade: { id: "w1" } });
    const list = (await h.app.inject({ url: "/api/reviews?outcome=WIN", headers: { cookie } })).json();
    expect(list.items.map((r: { tradeId: string }) => r.tradeId)).toEqual(["w1"]);
    expect((await h.app.inject({ url: "/api/reviews/insights", headers: { cookie } })).json()).toEqual({ insights: null });
  });
});
