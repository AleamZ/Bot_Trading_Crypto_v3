import type { Candle, SymbolFilters } from "@bot-v3/core";

export type OrderSide = "BUY" | "SELL";
export type AlgoType = "STOP_MARKET" | "TAKE_PROFIT_MARKET";
export type WorkingType = "MARK_PRICE" | "CONTRACT_PRICE";
export type MarginType = "ISOLATED" | "CROSSED";

export interface ExchangeSymbol {
  symbol: string;
  status: string;
  contractType: string;
  filters: SymbolFilters;
}

export interface LeverageBracket {
  bracket: number;
  initialLeverage: number;
  notionalCap: number;
  notionalFloor: number;
  maintMarginRatio: number;
}

export interface PositionInfo {
  symbol: string;
  /** Signed: positive long, negative short (one-way mode). */
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  positionSide: string;
  updateTime: number;
}

export interface OpenOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  type: string;
  side: OrderSide;
  origQty: string;
  status: string;
  reduceOnly: boolean;
}

export interface OrderResult {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  side: OrderSide;
  type: string;
  status: string;
  origQty: string;
  executedQty: string;
  avgPrice: string;
  updateTime: number;
}

/** NEW → TRIGGERING → TRIGGERED → FINISHED, or CANCELED / EXPIRED / REJECTED. */
export type AlgoStatus = "NEW" | "TRIGGERING" | "TRIGGERED" | "FINISHED" | "CANCELED" | "EXPIRED" | "REJECTED" | string;

export interface AlgoOrder {
  algoId: number;
  clientAlgoId: string;
  symbol: string;
  side: OrderSide;
  orderType: string;
  quantity: string;
  triggerPrice: string;
  algoStatus: AlgoStatus;
  reduceOnly: boolean;
  workingType: string;
  /** Average fill price once triggered and filled, "0" before. */
  actualPrice: string;
  /** Filled quantity once triggered, absent or "0" before. */
  actualQty: string;
  createTime: number;
  updateTime: number;
}

export interface UserTrade {
  id: number;
  orderId: number;
  symbol: string;
  side: OrderSide;
  price: string;
  qty: string;
  realizedPnl: string;
  commission: string;
  commissionAsset: string;
  time: number;
}

export interface MarketOrderRequest {
  symbol: string;
  side: OrderSide;
  quantity: string;
  clientOrderId: string;
  reduceOnly?: boolean;
}

export interface AlgoOrderRequest {
  symbol: string;
  side: OrderSide;
  type: AlgoType;
  quantity: string;
  triggerPrice: string;
  clientAlgoId: string;
  workingType: WorkingType;
}

/**
 * Everything the executor and the watchdog need from the exchange. BinanceFutures implements it
 * against the real API; tests use an in-memory fake.
 */
export interface FuturesApi {
  getSymbol(symbol: string): Promise<ExchangeSymbol>;
  getMarkPrice(symbol: string): Promise<number>;
  /** True when the account is in Hedge mode (the bot needs One-way mode). */
  isHedgeMode(): Promise<boolean>;
  getAvailableBalance(): Promise<number>;
  getLeverageBrackets(symbol: string): Promise<LeverageBracket[]>;
  getPositions(symbol?: string): Promise<PositionInfo[]>;
  getOpenOrders(symbol?: string): Promise<OpenOrder[]>;
  getOpenAlgoOrders(symbol?: string): Promise<AlgoOrder[]>;
  setMarginType(symbol: string, marginType: MarginType): Promise<void>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  placeMarketOrder(request: MarketOrderRequest): Promise<OrderResult>;
  /** Null when Binance does not know the order. */
  getOrder(symbol: string, clientOrderId: string): Promise<OrderResult | null>;
  placeAlgoOrder(request: AlgoOrderRequest): Promise<AlgoOrder>;
  /** Null when Binance does not know the algo order. */
  getAlgoOrder(clientAlgoId: string): Promise<AlgoOrder | null>;
  /** False when the order was already gone (filled, canceled or unknown). */
  cancelAlgoOrder(symbol: string, clientAlgoId: string): Promise<boolean>;
  getUserTrades(symbol: string, startTime: number): Promise<UserTrade[]>;
}

/** Market data the scanner needs. */
export interface MarketApi {
  /** Closed candles only, oldest first. */
  getClosedCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
}
