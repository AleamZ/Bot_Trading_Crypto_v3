import type { Direction, MethodId, StopMode } from "@bot-v3/core";

export type TradeStatus = "OPENING" | "OPEN" | "CLOSED" | "FAILED";
export type ExitReason = "TP" | "SL" | "EMERGENCY" | "MANUAL";

/** One bot trade, from the decision to enter until the position is flat. */
export interface Trade {
  id: string;
  symbol: string;
  direction: Direction;
  status: TradeStatus;
  methods: MethodId[];
  createdAt: number;
  openedAt: number | null;
  closedAt: number | null;
  /** Mark price when the trade was planned. */
  plannedEntry: number;
  /** Combined structural stop the size was computed with. */
  structuralStop: number;
  riskUsd: number;
  rr: number;
  leverage: number;
  entryClientId: string;
  /** Executed quantity (Binance string), "0" until filled. */
  quantity: string;
  entryPrice: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  stopMode: StopMode | null;
  /** Loss at the final stop, fees included, in USDT and in R. */
  riskAtStopUsd: string | null;
  riskAtStopR: number | null;
  slClientId: string | null;
  tpClientId: string | null;
  /** Bumped every time SL/TP are placed again, so client ids stay unique. */
  protectionVersion: number;
  exitReason: ExitReason | null;
  exitPrice: string | null;
  /** Realized PnL minus commissions, in USDT. */
  netPnl: string | null;
  fees: string | null;
  pnlR: number | null;
  note: string | null;
}

export interface TradeStore {
  insert(trade: Trade): Promise<void>;
  update(trade: Trade): Promise<void>;
  get(id: string): Promise<Trade | null>;
  listByStatus(statuses: readonly TradeStatus[]): Promise<Trade[]>;
}

export type EntryStage = "PRECHECK" | "PLAN" | "ORDER" | "PROTECTION";

export type BotEvent =
  | { type: "ENTRY_FILLED"; trade: Trade }
  | { type: "ENTRY_FAILED"; symbol: string; direction: Direction; stage: EntryStage; reason: string; detail: string }
  | { type: "PROTECTION_FAILED"; trade: Trade; detail: string; flattened: boolean }
  | { type: "PROTECTION_REPAIRED"; trade: Trade; legs: ("SL" | "TP")[] }
  | { type: "TRADE_CLOSED"; trade: Trade }
  | { type: "FOREIGN_POSITION"; symbol: string; positionAmt: string }
  | { type: "ERROR"; message: string; detail?: string };

export interface EventSink {
  emit(event: BotEvent): void;
}

/** Client id prefixes: every order the bot sends starts with "v3". */
export const CLIENT_ID = {
  entry: (tradeId: string) => `v3e-${tradeId}`,
  stop: (tradeId: string, version: number) => `v3s-${tradeId}-${version}`,
  take: (tradeId: string, version: number) => `v3t-${tradeId}-${version}`,
  close: (tradeId: string, attempt: number) => `v3x-${tradeId}-${attempt}`,
  isOurs: (clientId: string) => clientId.startsWith("v3"),
} as const;
