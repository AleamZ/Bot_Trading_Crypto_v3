/** Shapes of the server's JSON (apps/server/src/api/server.ts), only the parts the UI reads. */

export type Direction = "LONG" | "SHORT";
export type MethodId = "trendPullback" | "donchianBreakout" | "smcSweep";
export type ConsensusLevel = "NONE" | "READY" | "ENTER";

export const METHODS: { id: MethodId; letter: string; label: string }[] = [
  { id: "trendPullback", letter: "A", label: "Xu hướng + hồi EMA" },
  { id: "donchianBreakout", letter: "B", label: "Phá kênh Donchian" },
  { id: "smcSweep", letter: "C", label: "SMC quét thanh khoản" },
];

export interface SignalView {
  direction: Direction;
  time: number;
  price: number;
  stopLoss: number;
  reason: string;
  levels: Record<string, number>;
}

export interface AnalysisView {
  symbol: string;
  timeframe: string;
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
  episode: { direction: Direction; level: "READY" | "ENTER"; startedAt: number } | null;
  scannedAt: number;
}

export type TradeStatus = "OPENING" | "OPEN" | "CLOSED" | "FAILED";
export type ExitReason = "TP" | "SL" | "EMERGENCY" | "MANUAL";

export interface Trade {
  id: string;
  symbol: string;
  direction: Direction;
  status: TradeStatus;
  methods: MethodId[];
  createdAt: number;
  openedAt: number | null;
  closedAt: number | null;
  plannedEntry: number;
  structuralStop: number;
  riskUsd: number;
  rr: number;
  leverage: number;
  quantity: string;
  entryPrice: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  stopMode: string | null;
  riskAtStopUsd: string | null;
  riskAtStopR: number | null;
  rewardAtTpUsd: string | null;
  rewardAtTpR: number | null;
  exitReason: ExitReason | null;
  exitPrice: string | null;
  netPnl: string | null;
  fees: string | null;
  pnlR: number | null;
  note: string | null;
  entryClientId: string;
  slClientId: string | null;
  tpClientId: string | null;
}

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  time: number;
  type: string;
  level: LogLevel;
  symbol: string | null;
  title: string;
  message: string;
  data: unknown;
}

export interface SymbolScan {
  symbol: string;
  level: ConsensusLevel | null;
  direction: Direction | null;
  emitted: "READY" | "ENTER" | null;
  entry: "FILLED" | "FAILED" | "SKIPPED" | null;
  error: string | null;
}

export interface ScanReport {
  startedAt: number;
  finishedAt: number;
  expectedClose: number;
  symbols: SymbolScan[];
}

export interface Today {
  dayStart: number;
  opened: number;
  open: number;
  closed: { count: number; wins: number; r: number; pnl: number };
}

export type TelegramStatus =
  | { configured: false; hint?: string }
  | { configured: true; chatIdSet: boolean; polling: boolean; queued: number; lastSentAt: number | null; lastError: string | null };

export interface Status {
  version: string;
  binanceEnv: string;
  startedAt: number;
  now: number;
  tradingEnabled: boolean;
  hasBinanceKeys: boolean;
  autoTradeAllowed: boolean;
  autoTradeBlockers: string[];
  paused: boolean;
  lastScanAt: number | null;
  nextScanAt: number | null;
  openTrades: number;
  maxOpenPositions: number;
  today: Today;
  analysis: AnalysisView[];
  exchange: { ok: boolean; error: string | null; lastReconcileAt: number | null };
  userStream: { connected: boolean } | null;
  telegram: TelegramStatus;
  scanning: boolean;
  lastScan: ScanReport | null;
  warnings: string[];
  limits: {
    entryTf: string;
    trendTf: string;
    riskUsd: number;
    rr: number;
    maxOpenPositions: number;
    maxTradesPerDay: number;
    maxDailyLossR: number;
    alertThreshold: number;
    autoEntryThreshold: number;
  };
}

export interface Position {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  tradeId: string | null;
}

export interface PositionsResponse {
  positions: Position[];
  availableBalance: number;
}

export type JsonObject = { [key: string]: unknown };

export interface SettingsResponse {
  settings: JsonObject;
  defaults: JsonObject;
  schema: JsonSchema;
  warnings: string[];
}

export interface JsonSchema {
  type?: string;
  title?: string;
  description?: string;
  unit?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
}

export interface Me {
  authenticated: boolean;
  username: string | null;
  passwordConfigured: boolean;
}

export interface TelegramInfo {
  configured: boolean;
  hint?: string;
  chatIdSet?: boolean;
  polling?: boolean;
  queued?: number;
  lastSentAt?: number | null;
  lastError?: string | null;
  candidates?: { chatId: string; name: string; type: string; lastSeenAt: number }[];
}

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface Check {
  label: string;
  pass: boolean | null;
  detail: string | null;
}

export interface SideExplanation {
  direction: Direction;
  checks: Check[];
  passed: number;
  ready: boolean;
}

export interface StrategyExplanation {
  method: MethodId;
  sides: [SideExplanation, SideExplanation];
}

export type Tone = "sky" | "coin" | "stone" | "ink" | "quest" | "heart";

export interface ChartLine {
  id: string;
  label: string;
  group: "A" | "B" | "C";
  tone: Tone;
  style: "solid" | "dashed" | "dotted";
  points: { time: number; value: number }[];
}

export interface ChartOverlays {
  lines: ChartLine[];
  swings: { time: number; kind: "high" | "low"; price: number }[];
  fvgs: { from: number; to: number; top: number; bottom: number; direction: Direction; filled: boolean }[];
  signals: (SignalView & { method: MethodId; index: number; openTime: number })[];
  episodes: { time: number; level: "READY" | "ENTER"; direction: Direction }[];
}

export interface EntryPreview {
  direction: Direction;
  agreeing: number;
  entryPrice: number;
  notes: string[];
  ok: boolean;
  reason: string | null;
  detail: string | null;
  stopLoss: number;
  stopPct: number;
  atrMultiple: number | null;
  sizing: {
    quantity: string;
    stopLoss: string;
    takeProfit: string;
    notional: string;
    riskAtStop: string;
    riskR: number;
    rewardAtTp: string;
    rewardR: number;
  } | null;
  margin: { ok: boolean; leverage: number; maxLeverage: number; margin: number; liquidationPrice: number } | null;
}

export interface ChartResponse {
  symbol: string;
  timeframe: string;
  trendTimeframe: string;
  inWatchlist: boolean;
  candles: Candle[];
  overlays: ChartOverlays;
  analysis: AnalysisView;
  explanation: Record<MethodId, StrategyExplanation | null>;
  preview: EntryPreview | null;
  guard: { ok: boolean; reason: string | null; message: string | null };
  thresholds: { alert: number; entry: number };
  trades: Trade[];
  lastScanAt: number | null;
  nextScanAt: number | null;
}
