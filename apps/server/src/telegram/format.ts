import { comboOf, entryRuleText, feeRateOf, GUARD_MESSAGES, METHOD_IDS, METHOD_LABELS, METHOD_LETTERS, netResultAt, type MethodId, type Settings } from "@bot-v3/core";
import type { AnalysisView, AppEvent } from "../app/events.js";
import { isLimitNotFilled, isStopRuleRejection, stopStage, type Trade } from "../engine/types.js";

/** Telegram HTML messages. Every value that came from outside is escaped. */

export const escapeHtml = (value: unknown) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const method = (id: MethodId) => `${METHOD_LETTERS[id]}. ${METHOD_LABELS[id]}`;
const signed = (value: number, digits = 2) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
const rText = (value: number | null) => (value === null ? "?R" : `${signed(value)}R`);
const usd = (value: string | number | null) => (value === null ? "?$" : `${signed(Number(value))}$`);
/** Computed prices (stops from ATR) to 8 significant digits. */
const price = (value: number) => String(Number(value.toPrecision(8)));

/** "30/10 14:15" in Vietnam time. */
export function vnTime(time: number): string {
  const d = new Date(time + 7 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function methodLines(a: AnalysisView): string[] {
  return METHOD_IDS.map((id) => {
    const state = a.methods[id];
    if (!state.enabled) return `▫️ ${method(id)}: đang tắt`;
    const s = state.signal;
    if (!s) return `▫️ ${method(id)}: chưa có tín hiệu`;
    const mark = s.direction === a.consensus.direction ? "✅" : "⛔";
    return `${mark} ${method(id)}: ${s.direction} · SL ${price(s.stopLoss)} · ${escapeHtml(s.reason)}`;
  });
}

const head = (a: AnalysisView) => `${escapeHtml(a.symbol)} ${a.consensus.direction ?? ""}`.trim();
/** The agreeing methods: "B+C". */
const combo = (a: AnalysisView) => comboOf(a.consensus.agreeing);

/** Net result if the position closes at `exit`, fees included: "+4.12$ (+0.82R)". */
function netAt(t: Trade, exit: string, settings: Settings): string {
  const net = netResultAt(t.direction, t.entryPrice!, exit, t.quantity, feeRateOf(settings.risk)).toNumber();
  return `${usd(net)} (${rText(net / t.riskUsd)})`;
}

function tradeLines(t: Trade): string[] {
  return [
    `Khối lượng <b>${t.quantity}</b> @ ${t.entryPrice} · ${t.leverage}x`,
    `🛑 SL ${t.stopLoss} · lỗ ${t.riskAtStopUsd ?? "?"}$ (${rText(t.riskAtStopR === null ? null : -t.riskAtStopR)})`,
    `🎯 TP ${t.takeProfit} · lãi ròng ${t.rewardAtTpUsd ?? "?"}$ (${rText(t.rewardAtTpR)})`,
  ];
}

const EXIT_HEAD: Record<NonNullable<Trade["exitReason"]>, string> = {
  TP: "✅ <b>CHẠM TP",
  SL: "❌ <b>CHẠM SL",
  MANUAL: "✋ <b>ĐÃ ĐÓNG TAY",
  EMERGENCY: "🚨 <b>ĐÓNG KHẨN",
};

/** A stop hit after it was moved is a break-even or a locked win, not a loss. */
const MOVED_STOP_HEAD = { 1: "🛡 <b>CHẠM SL HOÀ VỐN", 2: "🔒 <b>CHẠM SL KHOÁ LÃI" } as const;

export interface FormatContext {
  settings: Settings;
  /** One line about today's results, appended to exits. */
  todayLine?: () => string;
}

/** The Telegram message for an event, or null when it should not be sent with these settings. */
export function formatEvent(event: AppEvent, ctx: FormatContext): string | null {
  const n = ctx.settings.telegram;
  switch (event.type) {
    case "SIGNAL_READY": {
      if (!n.notifyReady) return null;
      const a = event.analysis;
      return [
        `🟡 <b>SẴN SÀNG ${combo(a)} · ${head(a)}</b>`,
        `Giá ${a.price} · nến ${a.timeframe} đóng ${vnTime(a.time + 1)}`,
        ...methodLines(a),
        `Chưa vào lệnh: cần ${entryRuleText(ctx.settings.general)}.`,
      ].join("\n");
    }
    case "ENTRY_SKIPPED": {
      if (!n.notifyEntry) return null;
      const a = event.analysis;
      return [`⚪ <b>${combo(a)} · ${head(a)} nhưng không vào lệnh</b>`, `Lý do: ${GUARD_MESSAGES[event.reason]}`, `Giá ${a.price}`, ...methodLines(a)].join("\n");
    }
    case "ENTRY_FILLED": {
      if (!n.notifyEntry) return null;
      const t = event.trade;
      return [`🟢 <b>ĐÃ VÀO LỆNH ${comboOf(t.methods)} · ${escapeHtml(t.symbol)} ${t.direction}</b>`, ...tradeLines(t), `Phương pháp: ${t.methods.map(method).join(", ")}`].join("\n");
    }
    case "TRADE_CLOSED": {
      if (!n.notifyExit) return null;
      const t = event.trade;
      const stage = stopStage(t);
      const headText = t.exitReason === "SL" && stage !== 0 ? MOVED_STOP_HEAD[stage] : t.exitReason ? EXIT_HEAD[t.exitReason] : "<b>ĐÃ ĐÓNG";
      const lines = [
        `${headText} · ${escapeHtml(t.symbol)} ${t.direction}</b>`,
        `Vào ${t.entryPrice} → thoát ${t.exitPrice ?? "?"}`,
        `Lãi/lỗ ròng <b>${usd(t.netPnl)}</b> (${rText(t.pnlR)}) · phí ${t.fees ?? "?"}$`,
      ];
      if (ctx.todayLine) lines.push(ctx.todayLine());
      return lines.join("\n");
    }
    case "PROTECTION_FAILED": {
      // Always sent: a position may be without SL/TP.
      const t = event.trade;
      return [
        `🚨 <b>KHÔNG ĐẶT ĐƯỢC SL/TP · ${escapeHtml(t.symbol)} ${t.direction}</b>`,
        escapeHtml(event.detail),
        event.flattened ? "Đã đóng vị thế bằng lệnh MARKET." : "❗ <b>CHƯA đóng được vị thế</b>. Vào Binance kiểm tra ngay!",
      ].join("\n");
    }
    case "ENTRY_FAILED":
      if (isLimitNotFilled(event)) {
        if (!n.notifyEntry) return null;
        return [`⚪ <b>CHƯA VÀO LỆNH · ${escapeHtml(event.symbol)} ${event.direction}</b>`, escapeHtml(event.detail), "Bot thử lại ở nến sau nếu tín hiệu còn."].join("\n");
      }
      if (isStopRuleRejection(event)) {
        if (!n.notifyEntry) return null;
        return [
          `⚪ <b>KHÔNG VÀO LỆNH · ${escapeHtml(event.symbol)} ${event.direction}</b>`,
          `SL ngoài giới hạn: ${escapeHtml(event.detail)}`,
          "Bot bỏ qua theo cài đặt (Cài đặt → Quản lý vốn), không phải lỗi.",
        ].join("\n");
      }
      if (!n.notifyError) return null;
      return [`🔴 <b>KHÔNG VÀO ĐƯỢC LỆNH · ${escapeHtml(event.symbol)} ${event.direction}</b>`, `${event.stage} · ${escapeHtml(event.reason)}`, escapeHtml(event.detail)].join("\n");
    case "STOP_MOVED": {
      if (!n.notifyStopMove) return null;
      const t = event.trade;
      const m = event.move;
      const locked = m.stage === 2 && t.entryPrice ? netAt(t, m.to, ctx.settings) : null;
      return [
        `${m.stage === 1 ? "🛡 <b>DỜI SL VỀ GIÁ VÀO" : "🔒 <b>DỜI SL LÊN KHOÁ LÃI"} · ${escapeHtml(t.symbol)} ${t.direction}</b>`,
        `Giá đã đi ${Math.round(m.progress * 100)}% đường tới TP ${t.takeProfit}`,
        `SL ${m.from} → <b>${m.to}</b>${locked ? ` · chạm SL này lãi khoảng ${locked}` : " · chạm SL này lỗ khoảng bằng phí"}`,
      ].join("\n");
    }
    case "PROTECTION_REPAIRED":
      if (!n.notifyError) return null;
      return [`🛠 <b>Đã đặt lại ${event.legs.join(" + ")} · ${escapeHtml(event.trade.symbol)}</b>`, `SL ${event.trade.stopLoss} · TP ${event.trade.takeProfit}`].join("\n");
    case "ERROR":
      if (!n.notifyError) return null;
      return [`⚠️ <b>LỖI</b> · ${escapeHtml(event.message)}`, event.detail ? escapeHtml(event.detail) : ""].filter(Boolean).join("\n");
    case "SCAN_FAILED":
      if (!n.notifyError) return null;
      return [`⚠️ <b>Không phân tích được</b> ${escapeHtml(event.symbols.join(", "))}`, escapeHtml(event.detail)].join("\n");
    case "EXCHANGE_STATUS":
      if (!n.notifyError) return null;
      return event.ok ? `✅ <b>Đã gọi lại được Binance</b>\n${escapeHtml(event.detail)}` : `⚠️ <b>Không gọi được Binance</b>\n${escapeHtml(event.detail)}`;
    case "BOT_STARTED": {
      const auto = event.tradingEnabled && event.hasKeys && event.autoTrade;
      const why = [!event.tradingEnabled && "TRADING_ENABLED=false", !event.hasKeys && "chưa có khoá API", !event.autoTrade && "tắt trong cài đặt"].filter(Boolean).join(", ");
      return [
        `🤖 <b>Bot v3 đã khởi động</b> · Binance ${escapeHtml(event.binanceEnv.toUpperCase())}`,
        `Tự vào lệnh: ${auto ? "BẬT" : `TẮT (${why})`}`,
        event.paused ? "⏸ Đang tạm dừng vào lệnh mới (/resume để chạy lại)" : "",
      ].filter(Boolean).join("\n");
    }
    case "BOT_STOPPING":
      return `⏹ Bot đang dừng (${escapeHtml(event.signal)}). SL/TP đã đặt trên sàn vẫn giữ nguyên.`;
    case "BOT_PAUSED":
      return `⏸ <b>Đã tạm dừng vào lệnh mới</b> (bởi ${escapeHtml(event.by)}). SL/TP của lệnh đang mở vẫn hoạt động.`;
    case "BOT_RESUMED":
      return `▶️ <b>Đã cho vào lệnh lại</b> (bởi ${escapeHtml(event.by)}).`;
    case "SETTINGS_CHANGED": {
      if (event.changed.length === 0) return null;
      const shown = event.changed.slice(0, 12).join(", ") + (event.changed.length > 12 ? ` và ${event.changed.length - 12} mục khác` : "");
      return `⚙️ Cài đặt đã đổi (bởi ${escapeHtml(event.by)}): ${escapeHtml(shown)}`;
    }
    case "REVIEW_DONE": {
      if (!ctx.settings.ai.notifyReview) return null;
      const result = event.outcome === "WIN" ? "THẮNG" : event.outcome === "LOSS" ? "THUA" : "HOÀ";
      return [
        `🧠 <b>AI phân tích · ${escapeHtml(event.symbol)} ${event.direction} · ${result} ${rText(event.pnlR)}${event.exitReason ? ` (${escapeHtml(event.exitReason)})` : ""}</b>`,
        escapeHtml(event.summary),
        "Chi tiết: trang AI phân tích trên web.",
      ].join("\n");
    }
    case "REVIEW_FAILED":
    case "STATS_RESET":
    case "SIGNAL_ENTER":
    case "FOREIGN_POSITION":
    case "STREAM_STATUS":
      return null;
  }
}

export interface StatusSummary {
  binanceEnv: string;
  autoTradeAllowed: boolean;
  autoTradeBlockers: string[];
  paused: boolean;
  lastScanAt: number | null;
  nextScanAt: number | null;
  openTrades: number;
  maxOpenPositions: number;
  today: { opened: number; closed: { count: number; wins: number; r: number; pnl: number } };
  analysis: AnalysisView[];
}

export function formatStatus(s: StatusSummary): string {
  const signals = s.analysis.map((a) => {
    const c = a.consensus;
    return `${escapeHtml(a.symbol)}: ${c.direction ? `${c.direction} ${comboOf(c.agreeing) || "—"}` : "—"}`;
  });
  return [
    `🤖 <b>Bot v3</b> · Binance ${escapeHtml(s.binanceEnv.toUpperCase())}`,
    `Tự vào lệnh: ${s.autoTradeAllowed ? "BẬT" : `TẮT (${escapeHtml(s.autoTradeBlockers.join("; "))})`}`,
    s.paused ? "⏸ Đang tạm dừng vào lệnh mới" : "▶️ Đang chạy",
    `Vị thế mở: ${s.openTrades}/${s.maxOpenPositions}`,
    formatToday(s.today),
    `Quét gần nhất: ${s.lastScanAt ? vnTime(s.lastScanAt) : "chưa"} · lần tới: ${s.nextScanAt ? vnTime(s.nextScanAt) : "—"}`,
    signals.length ? `Tín hiệu: ${signals.join(" · ")}` : "",
  ].filter(Boolean).join("\n");
}

export function formatToday(today: StatusSummary["today"]): string {
  const c = today.closed;
  return `Hôm nay: vào ${today.opened} lệnh, đóng ${c.count} (thắng ${c.wins}) · ${rText(c.r)} · ${usd(c.pnl)}`;
}

export function formatPositions(trades: readonly Trade[]): string {
  if (trades.length === 0) return "Không có lệnh nào đang mở.";
  return trades
    .map((t) => [`<b>${escapeHtml(t.symbol)} ${t.direction}</b>${t.status === "OPENING" ? " (đang vào)" : ""}`, ...tradeLines(t)].join("\n"))
    .join("\n\n");
}

export const HELP_TEXT = [
  "<b>Lệnh của bot v3</b>",
  "/status · trạng thái, tín hiệu hiện tại",
  "/positions · lệnh đang mở với SL/TP",
  "/today · kết quả hôm nay",
  "/pause · tạm dừng vào lệnh mới (lệnh đang mở vẫn giữ SL/TP)",
  "/resume · cho vào lệnh lại",
  "/ask câu hỏi · hỏi AI về bot (ví dụ: /ask vì sao chưa vào lệnh BTC?)",
].join("\n");

export const BOT_COMMANDS = [
  { command: "status", description: "Trạng thái và tín hiệu" },
  { command: "positions", description: "Lệnh đang mở" },
  { command: "today", description: "Kết quả hôm nay" },
  { command: "pause", description: "Tạm dừng vào lệnh mới" },
  { command: "resume", description: "Cho vào lệnh lại" },
  { command: "ask", description: "Hỏi AI về bot" },
  { command: "help", description: "Danh sách lệnh" },
];
