import { defaultSettings, mergeSettings } from "@bot-v3/core";
import { describe, expect, it, vi } from "vitest";
import { EventHub, toAnalysisView } from "../src/app/events.js";
import { openDatabase } from "../src/db/database.js";
import { EventLog, KeyValueStore } from "../src/db/stores.js";
import { TelegramClient, TelegramError } from "../src/telegram/client.js";
import { escapeHtml, formatEvent, vnTime } from "../src/telegram/format.js";
import { TelegramService, type TelegramCommands } from "../src/telegram/service.js";
import { sampleTrade } from "./fixtures.js";
import { analysisOf, fakeTelegramFetch, LONG2, LONG3 } from "./runtimeHarness.js";

const settings = defaultSettings();
const ctx = { settings };
const view = (signals = LONG2) => toAnalysisView("BTCUSDT", "15m", analysisOf(signals, 1_800_000_000_000 - 1), null, 0);

describe("Telegram messages", () => {
  it("READY lists every method with its side, stop and reason", () => {
    const text = formatEvent({ type: "SIGNAL_READY", analysis: view() }, ctx)!;
    expect(text).toContain("🟡 <b>SẴN SÀNG 2/3 · BTCUSDT LONG</b>");
    expect(text).toContain("✅ A. Xu hướng + hồi EMA: LONG · SL 67500 · trendPullback test");
    expect(text).toContain("▫️ C. SMC quét thanh khoản: chưa có tín hiệu");
    expect(text).toContain("Chưa vào lệnh: cần 3/3 cùng chiều.");
    expect(text).toContain(`nến 15m đóng ${vnTime(1_800_000_000_000)}`);
  });

  it("an entry shows volume, SL and TP with what each is worth after fees", () => {
    const text = formatEvent({ type: "ENTRY_FILLED", trade: sampleTrade() }, ctx)!;
    expect(text).toContain("🟢 <b>ĐÃ VÀO LỆNH 3/3 · BTCUSDT LONG</b>");
    expect(text).toContain("Khối lượng <b>0.005</b> @ 68000 · 10x");
    expect(text).toContain("🛑 SL 67067.6 · lỗ 4.9997$ (−1.00R)");
    expect(text).toContain("🎯 TP 69864.8 · lãi ròng 8.9793$ (+1.80R)");
  });

  it("exits say TP or SL with the net result", () => {
    const tp = formatEvent({ type: "TRADE_CLOSED", trade: sampleTrade({ status: "CLOSED", exitReason: "TP", exitPrice: "69864.8", netPnl: "8.9793", fees: "0.0689", pnlR: 1.796 }) }, { ...ctx, todayLine: () => "Hôm nay: …" })!;
    expect(tp).toContain("✅ <b>CHẠM TP · BTCUSDT LONG</b>");
    expect(tp).toContain("Lãi/lỗ ròng <b>+8.98$</b> (+1.80R)");
    expect(tp).toContain("Hôm nay: …");
    const sl = formatEvent({ type: "TRADE_CLOSED", trade: sampleTrade({ status: "CLOSED", exitReason: "SL", netPnl: "-5", pnlR: -1 }) }, ctx)!;
    expect(sl).toContain("❌ <b>CHẠM SL");
    expect(sl).toContain("<b>−5.00$</b> (−1.00R)");
  });

  it("follows the notification switches, but always reports a position left without SL/TP", () => {
    const quiet = mergeSettings(settings, { telegram: { notifyReady: false, notifyEntry: false, notifyExit: false, notifyError: false } });
    if (!quiet.ok) throw new Error("bad settings");
    const q = { settings: quiet.settings };
    expect(formatEvent({ type: "SIGNAL_READY", analysis: view() }, q)).toBeNull();
    expect(formatEvent({ type: "ENTRY_FILLED", trade: sampleTrade() }, q)).toBeNull();
    expect(formatEvent({ type: "TRADE_CLOSED", trade: sampleTrade() }, q)).toBeNull();
    expect(formatEvent({ type: "ERROR", message: "x" }, q)).toBeNull();
    expect(formatEvent({ type: "PROTECTION_FAILED", trade: sampleTrade(), detail: "SL lỗi", flattened: false }, q)).toContain("CHƯA đóng được vị thế");
    expect(formatEvent({ type: "SIGNAL_ENTER", analysis: view(LONG3) }, ctx)).toBeNull();
  });

  it("escapes text from outside", () => {
    expect(escapeHtml("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
    expect(formatEvent({ type: "ERROR", message: "lỗi <script>" }, ctx)).toContain("lỗi &lt;script&gt;");
  });
});

describe("TelegramClient", () => {
  it("reports Telegram errors with status and retry_after, without the token", async () => {
    const fetchImpl = (async () =>
      Response.json({ ok: false, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } }, { status: 429 })) as unknown as typeof fetch;
    const client = new TelegramClient("123:SECRET-TOKEN", { fetch: fetchImpl });
    const error = (await client.sendMessage("42", "hi").catch((e) => e)) as TelegramError;
    expect(error).toBeInstanceOf(TelegramError);
    expect(error).toMatchObject({ status: 429, retryAfterSec: 3 });
    expect(error.message).not.toContain("SECRET");

    const notFound = new TelegramClient("bot123:SECRET-TOKEN", {
      fetch: (async () => Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 })) as unknown as typeof fetch,
    });
    const e404 = (await notFound.sendMessage("42", "hi").catch((e) => e)) as TelegramError;
    expect(e404.message).toContain("TELEGRAM_BOT_TOKEN");
    expect(e404.message).not.toContain("SECRET");

    const down = new TelegramClient("123:SECRET-TOKEN", { fetch: (async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch });
    const e2 = (await down.getMe().catch((e) => e)) as TelegramError;
    expect(e2).toMatchObject({ status: 0, message: "Telegram getMe: fetch failed" });
  });
});

function serviceHarness(options: { chatId?: string | null } = {}) {
  const db = openDatabase(":memory:");
  const kv = new KeyValueStore(db);
  const hub = new EventHub(new EventLog(db));
  const tg = fakeTelegramFetch();
  let now = 1_800_000_000_000;
  const sleeps: number[] = [];
  const commands: TelegramCommands = {
    status: async () => "STATUS",
    positions: async () => "POSITIONS",
    today: async () => "TODAY",
    pause: vi.fn(() => true),
    resume: vi.fn(() => false),
  };
  const service = new TelegramService({
    client: new TelegramClient("123:SECRET-TOKEN", { fetch: tg.fetch }),
    chatId: options.chatId === undefined ? "42" : options.chatId,
    kv,
    hub,
    settings: () => settings,
    commands,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      await new Promise((r) => setImmediate(r));
    },
  });
  const message = (text: string, chatId = 42, ageMs = 0) => ({
    update_id: Math.floor(Math.random() * 1e9),
    message: { message_id: 1, date: Math.floor((now - ageMs) / 1000), chat: { id: chatId, type: "private", first_name: "Dat" }, from: { id: chatId, username: "dat" }, text },
  });
  return { kv, hub, tg, service, commands, sleeps, message, advance: (ms: number) => (now += ms) };
}

describe("TelegramService notifications", () => {
  it("sends events in order to the configured chat", async () => {
    const h = serviceHarness();
    h.service.notify({ type: "SIGNAL_READY", analysis: view() });
    h.service.notify({ type: "ENTRY_FILLED", trade: sampleTrade() });
    await vi.waitFor(() => expect(h.tg.sent()).toHaveLength(2));
    expect(h.tg.sent()[0]).toContain("SẴN SÀNG");
    expect(h.tg.sent()[1]).toContain("ĐÃ VÀO LỆNH");
    expect(h.tg.calls.filter((c) => c.method === "sendMessage").every((c) => c.body.chat_id === "42" && c.body.parse_mode === "HTML")).toBe(true);
  });

  it("waits as long as Telegram asks on 429 and then delivers", async () => {
    const h = serviceHarness();
    let refused = false;
    h.tg.respondWith((method) => {
      if (method !== "sendMessage" || refused) return null;
      refused = true;
      return Response.json({ ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } }, { status: 429 });
    });
    h.service.notify({ type: "ENTRY_FILLED", trade: sampleTrade() });
    await vi.waitFor(() => expect(h.service.status().lastSentAt).not.toBeNull());
    expect(h.sleeps).toContain(8000);
    expect(h.tg.calls.filter((c) => c.method === "sendMessage")).toHaveLength(2);
  });

  it("does not repeat the same error within 30 minutes", async () => {
    const h = serviceHarness();
    h.service.notify({ type: "ERROR", message: "Binance timeout" });
    h.service.notify({ type: "ERROR", message: "Binance timeout" });
    h.advance(31 * 60_000);
    h.service.notify({ type: "ERROR", message: "Binance timeout" });
    await vi.waitFor(() => expect(h.tg.sent()).toHaveLength(2));
  });

  it("sends nothing without a chat id", () => {
    const h = serviceHarness({ chatId: null });
    h.service.notify({ type: "ENTRY_FILLED", trade: sampleTrade() });
    expect(h.tg.calls).toHaveLength(0);
  });
});

describe("TelegramService commands", () => {
  it("answers commands from the configured chat and ignores others and stale ones", async () => {
    const h = serviceHarness();
    h.tg.updates.push(h.message("/status"), h.message("/status", 999), h.message("/positions", 42, 10 * 60_000), h.message("/pause"), h.message("/resume@my_bot"));
    h.service.start();
    await vi.waitFor(() => expect(h.tg.sent()).toEqual(["STATUS", "Bot đang chạy, không cần /resume."]));
    expect(h.commands.pause).toHaveBeenCalledWith("Telegram @dat");
    expect(h.tg.calls.find((c) => c.method === "setMyCommands")).toBeDefined();
    expect(h.kv.get("telegram.offset", 0)).toBeGreaterThan(0);
    await h.service.stop(10);
  });

  it("without TELEGRAM_CHAT_ID, tells the sender their chat id and remembers it for the UI", async () => {
    const h = serviceHarness({ chatId: null });
    h.tg.updates.push(h.message("/start", 777));
    h.service.start();
    await vi.waitFor(() => expect(h.tg.sent()).toHaveLength(1));
    expect(h.tg.sent()[0]).toContain("TELEGRAM_CHAT_ID=777");
    expect(h.service.candidates()).toEqual([{ chatId: "777", name: "Dat", type: "private", lastSeenAt: expect.any(Number) }]);
    await h.service.stop(10);
  });

  it("backs off when another process polls the same token", async () => {
    const h = serviceHarness();
    let conflicts = 0;
    h.tg.respondWith((method) => {
      if (method !== "getUpdates" || conflicts >= 2) return null;
      conflicts++;
      return Response.json({ ok: false, description: "Conflict: terminated by other getUpdates request" }, { status: 409 });
    });
    h.service.start();
    await vi.waitFor(() => expect(h.sleeps.filter((ms) => ms === 30_000)).toHaveLength(2));
    await h.service.stop(10);
  });
});
