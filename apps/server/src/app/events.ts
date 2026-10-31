import { comboOf, GUARD_MESSAGES, METHOD_LABELS, type ConsensusLevel, type Direction, type Episode, type GuardReason, type MethodId, type SymbolAnalysis } from "@bot-v3/core";
import type { EventLog, LogEntry, LogLevelName } from "../db/stores.js";
import { isLimitNotFilled, isStopRuleRejection, stopStage, type BotEvent, type EventSink, type Trade } from "../engine/types.js";
import { silentLogger, type Logger } from "../lib/logger.js";

export interface SignalView {
  direction: Direction;
  time: number;
  price: number;
  stopLoss: number;
  reason: string;
  levels: Record<string, number>;
}

/** One symbol's analysis of its last closed candle, as the API, SSE and Telegram see it. */
export interface AnalysisView {
  symbol: string;
  timeframe: string;
  /** closeTime of the analysed candle. */
  time: number;
  price: number;
  atr: number;
  methods: Record<MethodId, { enabled: boolean; signal: SignalView | null }>;
  consensus: {
    level: ConsensusLevel;
    direction: Direction | null;
    longCount: number;
    shortCount: number;
    agreeing: MethodId[];
    opposing: MethodId[];
  };
  episode: Episode | null;
  scannedAt: number;
}

export function toAnalysisView(symbol: string, timeframe: string, analysis: SymbolAnalysis, episode: Episode | null, scannedAt: number): AnalysisView {
  const methods = {} as AnalysisView["methods"];
  for (const [id, state] of Object.entries(analysis.methods) as [MethodId, SymbolAnalysis["methods"][MethodId]][]) {
    const s = state.signal;
    methods[id] = {
      enabled: state.enabled,
      signal: s ? { direction: s.direction, time: s.time, price: s.price, stopLoss: s.stopLoss, reason: s.reason, levels: s.levels } : null,
    };
  }
  const c = analysis.consensus;
  return {
    symbol,
    timeframe,
    time: analysis.time,
    price: analysis.price,
    atr: analysis.atr,
    methods,
    consensus: {
      level: c.level,
      direction: c.direction,
      longCount: c.longCount,
      shortCount: c.shortCount,
      agreeing: c.agreeing.map((s) => s.method),
      opposing: c.opposing.map((s) => s.method),
    },
    episode,
    scannedAt,
  };
}

export type ScanEvent =
  | { type: "SIGNAL_READY"; analysis: AnalysisView }
  | { type: "SIGNAL_ENTER"; analysis: AnalysisView }
  | { type: "ENTRY_SKIPPED"; symbol: string; direction: Direction; reason: GuardReason; analysis: AnalysisView }
  | { type: "SCAN_FAILED"; symbols: string[]; detail: string };

export type SystemEvent =
  | { type: "BOT_STARTED"; binanceEnv: string; tradingEnabled: boolean; hasKeys: boolean; autoTrade: boolean; paused: boolean }
  | { type: "BOT_STOPPING"; signal: string }
  | { type: "BOT_PAUSED"; by: string }
  | { type: "BOT_RESUMED"; by: string }
  | { type: "SETTINGS_CHANGED"; by: string; changed: string[] }
  /** P&L figures cleared (since = the new start) or brought back (since = null). */
  | { type: "STATS_RESET"; by: string; since: number | null }
  | { type: "EXCHANGE_STATUS"; ok: boolean; detail: string }
  | { type: "STREAM_STATUS"; connected: boolean; detail: string };

/** Everything that ends up in the activity log, on the SSE stream and (filtered) on Telegram. */
export type AiEvent =
  | {
      type: "REVIEW_DONE";
      tradeId: string;
      symbol: string;
      direction: Direction;
      outcome: "WIN" | "LOSS" | "FLAT";
      pnlR: number | null;
      exitReason: string | null;
      summary: string;
    }
  | { type: "REVIEW_FAILED"; tradeId: string; symbol: string; detail: string };

export type AppEvent = BotEvent | ScanEvent | SystemEvent | AiEvent;
export type AppEventType = AppEvent["type"];

const side = (d: Direction | null) => (d === "LONG" ? "LONG" : d === "SHORT" ? "SHORT" : "—");
const methodsOf = (ids: readonly MethodId[]) => ids.map((id) => METHOD_LABELS[id]).join(", ");
const r = (value: number | null) => (value === null ? "?" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`);

const EXIT_LABEL: Record<NonNullable<Trade["exitReason"]>, string> = {
  TP: "Chạm TP",
  SL: "Chạm SL",
  EMERGENCY: "Đóng khẩn",
  MANUAL: "Đóng tay",
};

/** Level, symbol and a one-line Vietnamese title/message for the activity log. */
export function describeEvent(event: AppEvent): { level: LogLevelName; symbol: string | null; title: string; message: string } {
  switch (event.type) {
    case "SIGNAL_READY": {
      const a = event.analysis;
      const c = a.consensus;
      return {
        level: "info",
        symbol: a.symbol,
        title: `SẴN SÀNG ${comboOf(c.agreeing)} ${a.symbol} ${side(c.direction)}`,
        message: `${methodsOf(c.agreeing)} cùng chiều tại ${a.price}`,
      };
    }
    case "SIGNAL_ENTER": {
      const a = event.analysis;
      const combo = comboOf(a.consensus.agreeing);
      return { level: "info", symbol: a.symbol, title: `VÀO LỆNH ${combo} ${a.symbol} ${side(a.consensus.direction)}`, message: `${combo} cùng chiều, thử vào lệnh` };
    }
    case "ENTRY_SKIPPED":
      return { level: "warn", symbol: event.symbol, title: `Không vào lệnh ${event.symbol} ${event.direction}`, message: GUARD_MESSAGES[event.reason] };
    case "SCAN_FAILED":
      return {
        level: "warn",
        symbol: event.symbols.length === 1 ? event.symbols[0]! : null,
        title: `Không phân tích được ${event.symbols.join(", ")}`,
        message: event.detail,
      };
    case "ENTRY_FILLED": {
      const t = event.trade;
      return {
        level: "info",
        symbol: t.symbol,
        title: `ĐÃ VÀO LỆNH ${t.symbol} ${t.direction}`,
        message: `${t.quantity} @ ${t.entryPrice}, SL ${t.stopLoss} (${r(-(t.riskAtStopR ?? 0))}), TP ${t.takeProfit} (${r(t.rewardAtTpR)})`,
      };
    }
    case "ENTRY_FAILED":
      if (isLimitNotFilled(event)) {
        return { level: "info", symbol: event.symbol, title: `Không vào lệnh ${event.symbol} ${event.direction}: lệnh limit không khớp`, message: `${event.detail}. Bot thử lại ở nến sau nếu tín hiệu còn` };
      }
      if (isStopRuleRejection(event)) {
        return {
          level: "warn",
          symbol: event.symbol,
          title: `Không vào lệnh ${event.symbol} ${event.direction}: SL ngoài giới hạn`,
          message: `${event.detail}. Giới hạn nằm trong Cài đặt → Quản lý vốn`,
        };
      }
      return { level: "error", symbol: event.symbol, title: `Lỗi vào lệnh ${event.symbol} ${event.direction}`, message: `${event.reason}: ${event.detail}` };
    case "PROTECTION_FAILED":
      return {
        level: "error",
        symbol: event.trade.symbol,
        title: `Không đặt được SL/TP ${event.trade.symbol}`,
        message: `${event.detail}. ${event.flattened ? "Đã đóng vị thế." : "CHƯA đóng được vị thế, kiểm tra ngay!"}`,
      };
    case "PROTECTION_REPAIRED":
      return { level: "warn", symbol: event.trade.symbol, title: `Đã đặt lại ${event.legs.join(" + ")} ${event.trade.symbol}`, message: `SL ${event.trade.stopLoss}, TP ${event.trade.takeProfit}` };
    case "STOP_MOVED": {
      const m = event.move;
      return {
        level: "info",
        symbol: event.trade.symbol,
        title: `Dời SL ${event.trade.symbol} ${m.stage === 1 ? "về giá vào" : "lên khoá lãi"}`,
        message: `SL ${m.from} → ${m.to}; giá đã đi ${Math.round(m.progress * 100)}% đường tới TP`,
      };
    }
    case "TRADE_CLOSED": {
      const t = event.trade;
      const stage = stopStage(t);
      const label = t.exitReason === "SL" && stage > 0 ? (stage === 1 ? "Chạm SL hoà vốn" : "Chạm SL khoá lãi") : t.exitReason ? EXIT_LABEL[t.exitReason] : "Đã đóng";
      return {
        level: t.exitReason === "EMERGENCY" ? "warn" : "info",
        symbol: t.symbol,
        title: `${label} ${t.symbol} ${t.direction}`,
        message: `Thoát ${t.exitPrice ?? "?"}, lãi/lỗ ròng ${t.netPnl ?? "?"}$ (${r(t.pnlR)})`,
      };
    }
    case "FOREIGN_POSITION":
      return { level: "warn", symbol: event.symbol, title: `Vị thế không phải của bot: ${event.symbol}`, message: `positionAmt ${event.positionAmt}; bot không đụng vào` };
    case "ERROR":
      return { level: "error", symbol: null, title: event.message, message: event.detail ?? "" };
    case "BOT_STARTED":
      return {
        level: "info",
        symbol: null,
        title: "Bot đã khởi động",
        message: `Binance ${event.binanceEnv.toUpperCase()}, TRADING_ENABLED=${event.tradingEnabled}, khoá API ${event.hasKeys ? "có" : "chưa có"}, tự vào lệnh ${event.autoTrade ? "bật" : "tắt"}${event.paused ? ", đang tạm dừng" : ""}`,
      };
    case "BOT_STOPPING":
      return { level: "warn", symbol: null, title: "Bot đang dừng", message: `Nhận tín hiệu ${event.signal}` };
    case "BOT_PAUSED":
      return { level: "warn", symbol: null, title: "Đã tạm dừng vào lệnh mới", message: `Bởi ${event.by}. SL/TP của lệnh đang mở vẫn được giữ` };
    case "BOT_RESUMED":
      return { level: "info", symbol: null, title: "Đã cho vào lệnh lại", message: `Bởi ${event.by}` };
    case "SETTINGS_CHANGED":
      return { level: "info", symbol: null, title: "Đã đổi cài đặt", message: `Bởi ${event.by}: ${event.changed.join(", ") || "không đổi gì"}` };
    case "STATS_RESET":
      return event.since === null
        ? { level: "info", symbol: null, title: "Đã khôi phục số liệu lãi/lỗ", message: `Bởi ${event.by}: thống kê lại tính mọi lệnh` }
        : { level: "warn", symbol: null, title: "Đã xoá số liệu lãi/lỗ", message: `Bởi ${event.by}: thống kê, danh sách lệnh và giới hạn lỗ / số lệnh hôm nay tính từ lúc này; bài AI phân tích được giữ nguyên` };
    case "EXCHANGE_STATUS":
      return { level: event.ok ? "info" : "error", symbol: null, title: event.ok ? "Đã kết nối lại Binance" : "Không gọi được Binance", message: event.detail };
    case "REVIEW_DONE": {
      const result = event.outcome === "WIN" ? "thắng" : event.outcome === "LOSS" ? "thua" : "hoà";
      return { level: "info", symbol: event.symbol, title: `AI phân tích ${event.symbol} ${event.direction}: ${result} ${r(event.pnlR)}`, message: event.summary };
    }
    case "REVIEW_FAILED":
      return { level: "warn", symbol: event.symbol, title: `AI chưa phân tích được lệnh ${event.symbol}`, message: event.detail };
    case "STREAM_STATUS":
      return { level: event.connected ? "info" : "warn", symbol: null, title: event.connected ? "User stream đã kết nối" : "User stream mất kết nối", message: event.detail };
  }
}

export type EventListener = (event: AppEvent, entry: LogEntry) => void;
export type LiveChannel = "analysis" | "status";
export type LiveListener = (channel: LiveChannel, data: unknown) => void;

/**
 * Every event goes through here: it is written to the activity log first, then handed to the
 * listeners (SSE clients, the Telegram notifier). A failing listener never stops the others.
 */
export class EventHub implements EventSink {
  private readonly listeners = new Set<EventListener>();
  private readonly liveListeners = new Set<LiveListener>();

  constructor(
    private readonly log: EventLog,
    private readonly logger: Logger = silentLogger,
    private readonly now: () => number = Date.now,
  ) {}

  emit(event: AppEvent): LogEntry {
    const d = describeEvent(event);
    let entry: LogEntry;
    try {
      entry = this.log.append({ time: this.now(), type: event.type, level: d.level, symbol: d.symbol, title: d.title, message: d.message, data: event });
    } catch (error) {
      // The log is not worth losing the notification over.
      this.logger.error("Event log write failed", { type: event.type, error });
      entry = { id: 0, time: this.now(), type: event.type, level: d.level, symbol: d.symbol, title: d.title, message: d.message, data: event };
    }
    this.logger[d.level](d.title, { event: event.type, symbol: d.symbol ?? undefined, detail: d.message });
    for (const listener of this.listeners) {
      try {
        listener(event, entry);
      } catch (error) {
        this.logger.error("Event listener failed", { type: event.type, error });
      }
    }
    return entry;
  }

  /** Non-persisted updates (analysis snapshots, status) for the SSE stream. */
  live(channel: LiveChannel, data: unknown): void {
    for (const listener of this.liveListeners) {
      try {
        listener(channel, data);
      } catch (error) {
        this.logger.error("Live listener failed", { channel, error });
      }
    }
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onLive(listener: LiveListener): () => void {
    this.liveListeners.add(listener);
    return () => this.liveListeners.delete(listener);
  }
}
