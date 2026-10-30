import { GUARD_MESSAGES, METHOD_IDS, METHOD_LABELS, type MethodId, type Settings } from "@bot-v3/core";
import type { AnalysisView, AppEvent } from "../app/events.js";
import type { Trade } from "../engine/types.js";

/** Telegram HTML messages. Every value that came from outside is escaped. */

export const escapeHtml = (value: unknown) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const LETTER: Record<MethodId, string> = { trendPullback: "A", donchianBreakout: "B", smcSweep: "C" };
const method = (id: MethodId) => `${LETTER[id]}. ${METHOD_LABELS[id]}`;
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
const count = (a: AnalysisView) => Math.max(a.consensus.longCount, a.consensus.shortCount);

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
        `🟡 <b>SẴN SÀNG ${count(a)}/3 · ${head(a)}</b>`,
        `Giá ${a.price} · nến ${a.timeframe} đóng ${vnTime(a.time + 1)}`,
        ...methodLines(a),
        `Chưa vào lệnh: cần ${ctx.settings.general.autoEntryThreshold}/3 cùng chiều.`,
      ].join("\n");
    }
    case "ENTRY_SKIPPED": {
      if (!n.notifyEntry) return null;
      const a = event.analysis;
      return [`⚪ <b>${count(a)}/3 · ${head(a)} nhưng không vào lệnh</b>`, `Lý do: ${GUARD_MESSAGES[event.reason]}`, `Giá ${a.price}`, ...methodLines(a)].join("\n");
    }
    case "ENTRY_FILLED": {
      if (!n.notifyEntry) return null;
      const t = event.trade;
      return [`🟢 <b>ĐÃ VÀO LỆNH ${t.methods.length}/3 · ${escapeHtml(t.symbol)} ${t.direction}</b>`, ...tradeLines(t), `Phương pháp: ${t.methods.map((m) => LETTER[m]).join(", ")}`].join("\n");
    }
    case "TRADE_CLOSED": {
      if (!n.notifyExit) return null;
      const t = event.trade;
      const lines = [
        `${t.exitReason ? EXIT_HEAD[t.exitReason] : "<b>ĐÃ ĐÓNG"} · ${escapeHtml(t.symbol)} ${t.direction}</b>`,
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
      if (!n.notifyError) return null;
      return [`🔴 <b>KHÔNG VÀO ĐƯỢC LỆNH · ${escapeHtml(event.symbol)} ${event.direction}</b>`, `${event.stage} · ${escapeHtml(event.reason)}`, escapeHtml(event.detail)].join("\n");
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
    const best = Math.max(c.longCount, c.shortCount);
    return `${escapeHtml(a.symbol)}: ${c.direction ? `${c.direction} ${best}/3` : "—"}`;
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
].join("\n");

export const BOT_COMMANDS = [
  { command: "status", description: "Trạng thái và tín hiệu" },
  { command: "positions", description: "Lệnh đang mở" },
  { command: "today", description: "Kết quả hôm nay" },
  { command: "pause", description: "Tạm dừng vào lệnh mới" },
  { command: "resume", description: "Cho vào lệnh lại" },
  { command: "help", description: "Danh sách lệnh" },
];
