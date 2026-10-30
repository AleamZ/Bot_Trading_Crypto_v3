import { describe, expect, it, vi } from "vitest";
import { AiClient, AiError, extractJson } from "../src/ai/client.js";
import { tradeStats } from "../src/ai/reviews.js";
import { sampleTrade } from "./fixtures.js";
import { fakeAi, LONG3, runtimeHarness } from "./runtimeHarness.js";

const REVIEW_JSON = JSON.stringify({
  summary: "Thua vì giá đảo chiều ngay sau khi vào.",
  whyEntered: "Cả 3 phương pháp LONG.",
  whatHappened: "Giá giảm thẳng xuống SL.",
  causes: ["Vào lệnh sát kháng cự"],
  methodNotes: [{ method: "trendPullback", note: "RSI đã cao" }],
  lessons: ["Chờ xác nhận"],
  suggestions: [{ area: "trendPullback", change: "Giảm rsiMax xuống 65", confidence: "thấp" }],
  tags: ["đảo chiều"],
});

describe("AiClient", () => {
  it("sends model, messages, tools and the key, and reads tool calls", async () => {
    const ai = fakeAi();
    ai.replies.push({ tools: [{ name: "bot_status", args: {} }] });
    const client = new AiClient({ baseUrl: "http://ai.test/v1/", apiKey: "sk-1", model: "m1", timeoutMs: 1000 }, ai.fetch);
    const reply = await client.chat([{ role: "user", content: "hi" }], { tools: [{ name: "bot_status", description: "d", parameters: { type: "object", properties: {} } }] });
    expect(reply.toolCalls).toEqual([{ id: "c0", name: "bot_status", arguments: "{}" }]);
    expect(ai.bodies[0]).toMatchObject({ model: "m1", messages: [{ role: "user", content: "hi" }], tool_choice: "auto", tools: [{ type: "function", function: { name: "bot_status" } }] });
    expect(ai.headers[0]!.authorization).toBe("Bearer sk-1");
    expect(client.host).toBe("ai.test");
  });

  it("retries JSON mode without response_format when the server refuses it", async () => {
    const ai = fakeAi();
    ai.replies.push({ status: 400, text: "response_format not supported" }, { content: '{"a":1}' });
    const client = new AiClient({ baseUrl: "http://ai.test/v1", model: "m", timeoutMs: 1000 }, ai.fetch);
    expect((await client.chat([{ role: "user", content: "x" }], { json: true })).content).toBe('{"a":1}');
    expect(ai.bodies[0]).toHaveProperty("response_format");
    expect(ai.bodies[1]).not.toHaveProperty("response_format");
  });

  it("reports HTTP errors without the key", async () => {
    const ai = fakeAi();
    ai.replies.push({ status: 401, text: "bad key" });
    const client = new AiClient({ baseUrl: "http://ai.test/v1", apiKey: "sk-SECRET", model: "m", timeoutMs: 1000 }, ai.fetch);
    const error = (await client.chat([{ role: "user", content: "x" }]).catch((e) => e)) as AiError;
    expect(error).toMatchObject({ code: "HTTP", status: 401 });
    expect(error.message).not.toContain("SECRET");
  });

  it("finds the JSON object inside a reply", () => {
    const fence = "```";
    expect(extractJson(`Đây:\n${fence}json\n{"a": [1]}\n${fence}`)).toEqual({ a: [1] });
    expect(extractJson('nói thêm {"b": 2} hết')).toEqual({ b: 2 });
    expect(() => extractJson("không có")).toThrow();
  });
});

async function closedLoss(h: ReturnType<typeof runtimeHarness>) {
  const outcome = await h.runtime.executor.enter({ symbol: "BTCUSDT", direction: "LONG", signals: LONG3, atr: 400, settings: h.runtime.settings.get() });
  if (!outcome.ok) throw new Error(outcome.detail);
  h.exchange.clock += 45 * 60_000;
  h.exchange.setMark("BTCUSDT", Number(outcome.trade.stopLoss) - 5);
  await h.runtime.reconcile();
  return outcome.trade.id;
}

describe("AI trade reviews", () => {
  it("reviews a trade when it hits its stop, from facts the code computed", async () => {
    const ai = fakeAi();
    ai.replies.push({ content: REVIEW_JSON });
    const h = runtimeHarness({ ai, telegram: true });
    await h.runtime.start();
    const id = await closedLoss(h);
    await vi.waitFor(() => expect(h.runtime.reviewStore.get(id)?.status).toBe("DONE"));
    const record = h.runtime.reviewStore.get(id)!;
    expect(record).toMatchObject({
      symbol: "BTCUSDT",
      outcome: "LOSS",
      model: "fake-model",
      review: { summary: "Thua vì giá đảo chiều ngay sau khi vào.", suggestions: [{ area: "trendPullback", confidence: "thấp" }] },
    });
    const facts = record.facts as { trade: { exitReason: string; resultR: number }; atEntry: { methods: Record<string, unknown> }; candles: { rows: unknown[] } };
    expect(facts.trade.exitReason).toBe("SL");
    expect(facts.trade.resultR).toBeLessThan(-0.9);
    expect(Object.keys(facts.atEntry.methods)).toEqual(["trendPullback", "donchianBreakout", "smcSweep"]);
    expect(facts.candles.rows.length).toBeGreaterThan(0);
    // The AI got those facts, as JSON, after the system prompt.
    const messages = ai.bodies[0]!.messages as { role: string; content: string }[];
    expect(messages[0]!.role).toBe("system");
    expect(JSON.parse(messages[1]!.content)).toMatchObject({ trade: { id, exitReason: "SL" } });
    await vi.waitFor(() => expect(h.telegram.sent().some((t) => t.includes("🧠 <b>AI phân tích · BTCUSDT LONG · THUA"))).toBe(true));
    await h.runtime.stop();
  });

  it("keeps a failed review, which can be run again", async () => {
    const ai = fakeAi();
    ai.replies.push({ content: "xin lỗi, không có JSON" });
    const h = runtimeHarness({ ai });
    await h.runtime.start();
    const id = await closedLoss(h);
    await vi.waitFor(() => expect(h.runtime.reviewStore.get(id)?.status).toBe("FAILED"));
    expect(h.runtime.reviewStore.get(id)!.error).toContain("JSON");
    ai.replies.push({ content: REVIEW_JSON });
    expect(await h.runtime.reviews.enqueue(id)).toMatchObject({ status: "DONE" });
    await h.runtime.stop();
  });

  it("does not review when AI is off or auto review is disabled", async () => {
    const off = runtimeHarness();
    await off.runtime.start();
    const id = await closedLoss(off);
    expect(off.runtime.reviewStore.get(id)).toBeNull();
    await off.runtime.stop();

    const ai = fakeAi();
    const disabled = runtimeHarness({ ai });
    disabled.runtime.settings.update({ ai: { autoReview: false } });
    await disabled.runtime.start();
    await closedLoss(disabled);
    expect(ai.bodies).toEqual([]);
    await disabled.runtime.stop();
  });

  it("sums results per method, exit and symbol for the insights", () => {
    const stats = tradeStats([
      sampleTrade({ id: "a", pnlR: 1.8, exitReason: "TP" }),
      sampleTrade({ id: "b", pnlR: -1, exitReason: "SL", methods: ["trendPullback", "smcSweep"] }),
    ]);
    expect(stats.overall).toEqual({ trades: 2, wins: 1, losses: 1, winRate: 0.5, totalR: 0.8 });
    expect(stats.byMethod.donchianBreakout).toMatchObject({ trades: 1, wins: 1 });
    expect(stats.byExit.SL).toMatchObject({ trades: 1, losses: 1 });
  });
});

describe("AI chat", () => {
  it("lets the AI read the bot through tools, then answers", async () => {
    const ai = fakeAi();
    ai.replies.push({ tools: [{ name: "bot_status", args: {} }, { name: "symbol_analysis", args: { symbol: "btcusdt" } }] }, { content: "Bot đang chạy, BTC chưa có tín hiệu." });
    const h = runtimeHarness({ ai });
    const reply = await h.runtime.chat.reply([{ role: "user", content: "Bot thế nào?" }]);
    expect(reply).toEqual({ reply: "Bot đang chạy, BTC chưa có tín hiệu.", model: "fake-model", tools: ["bot_status", "symbol_analysis"] });
    const second = ai.bodies[1]!.messages as { role: string; tool_call_id?: string; content: string }[];
    const toolAnswers = second.filter((m) => m.role === "tool");
    expect(toolAnswers.map((m) => m.tool_call_id)).toEqual(["c0", "c1"]);
    expect(JSON.parse(toolAnswers[0]!.content)).toHaveProperty("autoTradeAllowed");
    expect(JSON.parse(toolAnswers[1]!.content)).toMatchObject({ symbol: "BTCUSDT", explanation: { trendPullback: { sides: expect.any(Array) } } });
  });

  it("falls back to a status snapshot when the model has no function calling", async () => {
    const ai = fakeAi();
    ai.replies.push({ status: 400, text: "tools not supported" }, { content: "Trả lời từ ảnh chụp." });
    const h = runtimeHarness({ ai });
    expect(await h.runtime.chat.reply([{ role: "user", content: "?" }])).toMatchObject({ reply: "Trả lời từ ảnh chụp.", tools: ["snapshot"] });
    expect((ai.bodies[1]!.messages as { content: string }[])[0]!.content).toContain("Dữ liệu hiện tại của bot");
  });

  it("answers /ask on Telegram", async () => {
    const ai = fakeAi();
    ai.replies.push({ content: "BTC chưa đủ 2/3 <ok>" });
    const h = runtimeHarness({ ai, telegram: true });
    h.telegram.updates.push({
      update_id: 1,
      message: { message_id: 1, date: Math.floor(h.exchange.clock / 1000), chat: { id: 42, type: "private" }, text: "/ask vì sao chưa vào lệnh?" },
    });
    await h.runtime.start();
    await vi.waitFor(() => expect(h.telegram.sent()).toContain("BTC chưa đủ 2/3 &lt;ok&gt;"));
    expect((ai.bodies[0]!.messages as { role: string; content: string }[]).at(-1)).toEqual({ role: "user", content: "vì sao chưa vào lệnh?" });
    await h.runtime.stop();
  });
});
