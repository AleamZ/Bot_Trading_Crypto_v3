import type { Direction, MethodId, StopMode } from "@bot-v3/core";

/** One move of the stop after the entry. */
export interface StopMove {
  at: number;
  /** 1: to the entry; 2: into profit. */
  stage: 1 | 2;
  from: string;
  to: string;
  /** How far price had gone towards the TP (1 = at the TP). */
  progress: number;
}

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
  /** Net win at the take profit, fees included, in USDT and in R (below RR when fees count). */
  rewardAtTpUsd: string | null;
  rewardAtTpR: number | null;
  slClientId: string | null;
  tpClientId: string | null;
  /** Bumped every time SL/TP are placed again, so client ids stay unique. */
  protectionVersion: number;
  /** Stop moves (break-even, locked profit), oldest first. Missing on trades from before the feature. */
  slMoves?: StopMove[];
  /** Furthest the mark price went towards the TP while open (1 = at the TP). */
  bestProgress?: number;
  exitReason: ExitReason | null;
  exitPrice: string | null;
  /** Realized PnL minus commissions, in USDT. */
  netPnl: string | null;
  fees: string | null;
  pnlR: number | null;
  note: string | null;
}

/**
 * An entry refused by the stop-distance rules (Settings → risk: min/max SL %, max SL × ATR): the
 * bot chose not to trade, nothing went wrong.
 */
export function isStopRuleRejection(event: { stage: EntryStage; reason: string }): boolean {
  return event.stage === "PLAN" && ["STOP_TOO_CLOSE", "STOP_TOO_FAR", "STOP_TOO_FAR_ATR", "STOP_WRONG_SIDE"].includes(event.reason);
}

/** 0: the stop the trade opened with; 1: at the entry; 2: in profit. */
export function stopStage(trade: Pick<Trade, "slMoves">): 0 | 1 | 2 {
  return trade.slMoves?.at(-1)?.stage ?? 0;
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
  | { type: "STOP_MOVED"; trade: Trade; move: StopMove }
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
