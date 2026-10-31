import type { Settings } from "@bot-v3/core";
import type { LogEntry, ReviewRecord } from "../db/stores.js";
import type { Trade } from "../engine/types.js";
import { silentLogger, type Logger } from "../lib/logger.js";
import { AiError, type AiClient, type ChatMessage, type ToolSpec } from "./client.js";

/** What the chat may read. Read-only on purpose: it cannot trade or change settings. */
export interface BotReader {
  status(): unknown;
  settings(): Settings;
  symbolAnalysis(symbol: string): Promise<unknown>;
  trades(options: { status?: string; symbol?: string; limit: number }): Trade[];
  trade(id: string): Trade | null;
  review(tradeId: string): ReviewRecord | null;
  reviews(options: { limit: number; outcome?: "WIN" | "LOSS" | "FLAT" }): ReviewRecord[];
  events(options: { limit: number; level?: "warn" | "error" }): LogEntry[];
  insights(): unknown;
  rules(): string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatReply {
  reply: string;
  model: string;
  tools: string[];
}

const TOOLS: ToolSpec[] = [
  {
    name: "bot_status",
    description: "Trạng thái bot: tự vào lệnh bật/tắt và vì sao, tạm dừng, Binance, Telegram, số dư và kiểm tra 1R, kết quả hôm nay, lượt quét, tín hiệu từng symbol, giới hạn.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "bot_settings",
    description: "Toàn bộ cài đặt hiện tại của bot (danh sách symbol, khung thời gian, ngưỡng, quản lý vốn, tham số từng phương pháp, Telegram, AI).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "symbol_analysis",
    description: "Phân tích một symbol trên nến vừa đóng: đồng thuận, tín hiệu từng phương pháp, MỌI điều kiện ✓/✗ của từng phương pháp cho LONG và SHORT, lệnh dự kiến nếu vào lúc này (SL, TP, khối lượng, đòn bẩy, ký quỹ), giới hạn có chặn không.",
    parameters: { type: "object", properties: { symbol: { type: "string", description: "Ví dụ BTCUSDT" } }, required: ["symbol"] },
  },
  {
    name: "list_trades",
    description: "Danh sách lệnh của bot, mới nhất trước.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "OPENING, OPEN, CLOSED, FAILED, hoặc nhiều giá trị cách nhau bởi dấu phẩy" },
        symbol: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "trade_detail",
    description: "Chi tiết một lệnh và bài phân tích AI của nó (nếu có).",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "trade_reviews",
    description: "Các bài AI phân tích lệnh đã đóng: vì sao thắng/thua, nguyên nhân, bài học, đề xuất.",
    parameters: {
      type: "object",
      properties: { outcome: { type: "string", enum: ["WIN", "LOSS", "FLAT"] }, limit: { type: "integer", minimum: 1, maximum: 30 } },
    },
  },
  {
    name: "review_insights",
    description: "Bản tổng hợp bài học gần nhất từ nhiều lệnh (mẫu lặp lại, điểm yếu, đề xuất thay đổi logic).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "recent_events",
    description: "Nhật ký hoạt động gần đây của bot (tín hiệu, vào lệnh, chạm TP/SL, lỗi, đổi cài đặt).",
    parameters: {
      type: "object",
      properties: { level: { type: "string", enum: ["warn", "error"] }, limit: { type: "integer", minimum: 1, maximum: 50 } },
    },
  },
  {
    name: "bot_rules",
    description: "Tài liệu luật giao dịch của bot: 4 phương pháp, đồng thuận, cách tính SL/TP/khối lượng/đòn bẩy, giới hạn, cách đặt lệnh và giữ SL/TP.",
    parameters: { type: "object", properties: {} },
  },
];

const MAX_TOOL_TEXT = 14_000;
const MAX_ROUNDS = 6;

function systemPrompt(now: number): string {
  const today = new Date(now + 7 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
  return `Bạn là trợ lý của bot giao dịch v3 (Binance USDT-M Futures). Bây giờ là ${today} giờ Việt Nam.
Bot phân tích 4 phương pháp (A. Xu hướng + hồi EMA, B. Phá kênh Donchian, C. SMC quét thanh khoản, D. Hộp: đáy/đỉnh khoảng giá hôm trước) trên mỗi symbol sau mỗi nến đóng: đủ ngưỡng báo thì gửi Telegram SẴN SÀNG, đủ ngưỡng hoặc khớp tổ hợp được chọn thì tự vào lệnh MARKET với SL và TP, khối lượng theo 1R.
Cách trả lời:
- Luôn dùng công cụ để lấy dữ liệu thật trước khi trả lời về trạng thái, tín hiệu, lệnh, kết quả hay cài đặt. Không đoán, không bịa số.
- Tiếng Việt, ngắn gọn, đi thẳng vào câu hỏi, có số liệu và giờ Việt Nam.
- Khi giải thích vì sao bot chưa vào lệnh, chỉ rõ điều kiện nào chưa đạt (dùng symbol_analysis) hoặc giới hạn nào đang chặn.
- Bạn chỉ ĐỌC được dữ liệu: không đặt lệnh, không đóng lệnh, không đổi cài đặt. Khi người dùng muốn làm những việc đó, chỉ họ vào đúng chỗ: trang Bảng điều khiển, Phân tích, Lệnh, Cài đặt, AI phân tích, hoặc lệnh Telegram /pause /resume.
- Không đưa lời khuyên đầu tư cá nhân; nói về cách bot hoạt động và dữ liệu của bot.`;
}

/** Chat about the bot, answered by the AI with read-only tools over the bot's own data. */
export class ChatService {
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(
    private readonly ai: AiClient | null,
    private readonly reader: BotReader,
    options: { logger?: Logger; now?: () => number } = {},
  ) {
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.ai !== null;
  }

  async reply(turns: readonly ChatTurn[]): Promise<ChatReply> {
    if (!this.ai) throw new AiError("NETWORK", "AI đang tắt (chưa có AI_BASE_URL trong .env)");
    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(this.now()) }, ...turns.slice(-16).map((t) => ({ role: t.role, content: t.content }))];
    const used: string[] = [];
    let model = this.ai.model;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS - 1;
      let answer;
      try {
        answer = await this.ai.chat(messages, { tools: last ? [] : TOOLS, temperature: 0.3 });
      } catch (error) {
        // A model without function calling: answer once from a snapshot of the status instead.
        if (round === 0 && error instanceof AiError && error.code === "HTTP" && error.status === 400) return this.replyWithoutTools(turns);
        throw error;
      }
      model = answer.model;
      if (answer.toolCalls.length === 0) return { reply: answer.content.trim(), model, tools: used };
      messages.push({
        role: "assistant",
        content: answer.content,
        tool_calls: answer.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      });
      for (const call of answer.toolCalls) {
        used.push(call.name);
        messages.push({ role: "tool", tool_call_id: call.id, content: await this.runTool(call.name, call.arguments) });
      }
    }
    return { reply: "Mình chưa tổng hợp xong câu trả lời, bạn hỏi cụ thể hơn được không?", model, tools: used };
  }

  private async replyWithoutTools(turns: readonly ChatTurn[]): Promise<ChatReply> {
    const snapshot = JSON.stringify({ status: this.reader.status(), recentTrades: this.reader.trades({ limit: 10 }) }).slice(0, MAX_TOOL_TEXT);
    const answer = await this.ai!.chat(
      [
        { role: "system", content: `${systemPrompt(this.now())}\nDữ liệu hiện tại của bot (JSON):\n${snapshot}` },
        ...turns.slice(-16).map((t) => ({ role: t.role, content: t.content })),
      ],
      { temperature: 0.3 },
    );
    return { reply: answer.content.trim(), model: answer.model, tools: ["snapshot"] };
  }

  private async runTool(name: string, rawArgs: string): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return JSON.stringify({ error: "Tham số không phải JSON" });
    }
    const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : undefined);
    const num = (key: string, fallback: number, max: number) => Math.min(max, Math.max(1, Number(args[key]) || fallback));
    try {
      let result: unknown;
      switch (name) {
        case "bot_status":
          result = this.reader.status();
          break;
        case "bot_settings":
          result = this.reader.settings();
          break;
        case "symbol_analysis":
          result = await this.reader.symbolAnalysis((str("symbol") ?? "").toUpperCase());
          break;
        case "list_trades":
          result = this.reader.trades({ ...(str("status") ? { status: str("status")! } : {}), ...(str("symbol") ? { symbol: str("symbol")!.toUpperCase() } : {}), limit: num("limit", 20, 50) });
          break;
        case "trade_detail": {
          const id = str("id") ?? "";
          result = { trade: this.reader.trade(id), review: this.reader.review(id) };
          break;
        }
        case "trade_reviews": {
          const outcome = str("outcome");
          result = this.reader
            .reviews({ limit: num("limit", 10, 30), ...(outcome === "WIN" || outcome === "LOSS" || outcome === "FLAT" ? { outcome } : {}) })
            .map((r) => ({ tradeId: r.tradeId, symbol: r.symbol, status: r.status, outcome: r.outcome, review: r.review, error: r.error }));
          break;
        }
        case "review_insights":
          result = this.reader.insights() ?? { note: "Chưa có bản tổng hợp; bấm Tổng hợp trên trang AI phân tích" };
          break;
        case "recent_events": {
          const level = str("level");
          result = this.reader
            .events({ limit: num("limit", 20, 50), ...(level === "warn" || level === "error" ? { level } : {}) })
            .map((e) => ({ time: new Date(e.time + 7 * 3_600_000).toISOString().slice(5, 16), level: e.level, title: e.title, message: e.message }));
          break;
        }
        case "bot_rules":
          result = this.reader.rules();
          break;
        default:
          result = { error: `Không có công cụ ${name}` };
      }
      const textResult = typeof result === "string" ? result : JSON.stringify(result);
      return textResult.length > MAX_TOOL_TEXT ? `${textResult.slice(0, MAX_TOOL_TEXT)}…(đã cắt bớt)` : textResult;
    } catch (error) {
      this.logger.warn("Chat tool failed", { tool: name, error: String(error) });
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  }
}
