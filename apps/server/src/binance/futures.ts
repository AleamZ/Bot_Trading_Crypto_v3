import { dec, type Candle } from "@bot-v3/core";
import { BinanceError, ERROR_CODES, isBinanceError } from "./errors.js";
import { toExchangeSymbol, type RawExchangeSymbol } from "./exchangeInfo.js";
import type { BinanceRest } from "./rest.js";
import type {
  AlgoOrder,
  AlgoOrderRequest,
  BookTicker,
  ExchangeSymbol,
  FuturesApi,
  LeverageBracket,
  LimitOrderRequest,
  MarginType,
  MarketApi,
  MarketOrderRequest,
  OpenOrder,
  OrderResult,
  PositionInfo,
  UserTrade,
} from "./types.js";

const EXCHANGE_INFO_TTL_MS = 60 * 60_000;

/** Binance USDⓈ-M Futures endpoints the bot uses. Stops and take profits go through the Algo service. */
export class BinanceFutures implements FuturesApi, MarketApi {
  private symbols: Map<string, ExchangeSymbol> | null = null;
  private symbolsLoadedAt = 0;

  constructor(private readonly rest: BinanceRest) {}

  async getExchangeSymbols(force = false): Promise<Map<string, ExchangeSymbol>> {
    if (!force && this.symbols && Date.now() - this.symbolsLoadedAt < EXCHANGE_INFO_TTL_MS) return this.symbols;
    const info = await this.rest.get<{ symbols: RawExchangeSymbol[] }>("/fapi/v1/exchangeInfo");
    const map = new Map<string, ExchangeSymbol>();
    for (const raw of info.symbols) {
      try {
        map.set(raw.symbol, toExchangeSymbol(raw));
      } catch {
        // Skip contracts without the filters a market order needs.
      }
    }
    this.symbols = map;
    this.symbolsLoadedAt = Date.now();
    return map;
  }

  async getSymbol(symbol: string): Promise<ExchangeSymbol> {
    const found = (await this.getExchangeSymbols()).get(symbol);
    if (!found) throw new Error(`Không tìm thấy symbol ${symbol} trên Binance`);
    return found;
  }

  async getClosedCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const rows = await this.rest.get<unknown[][]>("/fapi/v1/klines", { symbol, interval, limit: Math.min(1500, limit + 1) });
    const now = this.rest.serverNow();
    return rows
      .map((r) => ({
        openTime: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
        closeTime: Number(r[6]),
      }))
      .filter((c) => c.closeTime < now)
      .slice(-limit);
  }

  /** Closed candles between two times, oldest first, fetched 1500 at a time (backtests). */
  async getCandlesBetween(symbol: string, interval: string, startTime: number, endTime: number): Promise<Candle[]> {
    const out: Candle[] = [];
    let cursor = startTime;
    const now = this.rest.serverNow();
    while (cursor < endTime) {
      const rows = await this.rest.get<unknown[][]>("/fapi/v1/klines", { symbol, interval, startTime: cursor, endTime, limit: 1500 });
      if (rows.length === 0) break;
      for (const r of rows) {
        const candle = { openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]), closeTime: Number(r[6]) };
        if (candle.closeTime < now && candle.closeTime <= endTime && (out.length === 0 || candle.openTime > out.at(-1)!.openTime)) out.push(candle);
      }
      const last = Number(rows.at(-1)![0]);
      if (rows.length < 1500 || last + 1 <= cursor) break;
      cursor = last + 1;
    }
    return out;
  }

  async getMarkPrice(symbol: string): Promise<number> {
    const r = await this.rest.get<{ markPrice: string }>("/fapi/v1/premiumIndex", { symbol });
    return Number(r.markPrice);
  }

  async isHedgeMode(): Promise<boolean> {
    const r = await this.rest.get<{ dualSidePosition: boolean | string }>("/fapi/v1/positionSide/dual", {}, true);
    return r.dualSidePosition === true || r.dualSidePosition === "true";
  }

  async getAvailableBalance(): Promise<number> {
    const balances = await this.rest.get<{ asset: string; availableBalance: string }[]>("/fapi/v2/balance", {}, true);
    return Number(balances.find((b) => b.asset === "USDT")?.availableBalance ?? 0);
  }

  async getLeverageBrackets(symbol: string): Promise<LeverageBracket[]> {
    type Raw = { symbol: string; brackets: LeverageBracket[] };
    const r = await this.rest.get<Raw[] | Raw>("/fapi/v1/leverageBracket", { symbol }, true);
    const entry = Array.isArray(r) ? r.find((x) => x.symbol === symbol) ?? r[0] : r;
    return (entry?.brackets ?? []).map((b) => ({
      bracket: Number(b.bracket),
      initialLeverage: Number(b.initialLeverage),
      notionalCap: Number(b.notionalCap),
      notionalFloor: Number(b.notionalFloor),
      maintMarginRatio: Number(b.maintMarginRatio),
    }));
  }

  async getPositions(symbol?: string): Promise<PositionInfo[]> {
    const rows = await this.rest.get<PositionInfo[]>("/fapi/v2/positionRisk", symbol ? { symbol } : {}, true);
    return rows.map((p) => ({ ...p, updateTime: Number(p.updateTime) }));
  }

  getOpenOrders(symbol?: string): Promise<OpenOrder[]> {
    return this.rest.get<OpenOrder[]>("/fapi/v1/openOrders", symbol ? { symbol } : {}, true);
  }

  async getOpenAlgoOrders(symbol?: string): Promise<AlgoOrder[]> {
    const rows = await this.rest.get<Partial<AlgoOrder>[]>("/fapi/v1/openAlgoOrders", symbol ? { symbol } : {}, true);
    return rows.map(toAlgoOrder);
  }

  async setMarginType(symbol: string, marginType: MarginType): Promise<void> {
    try {
      await this.rest.request("POST", "/fapi/v1/marginType", { symbol, marginType }, { signed: true, idempotent: true });
    } catch (error) {
      if (!isBinanceError(error, ERROR_CODES.NO_NEED_TO_CHANGE_MARGIN_TYPE)) throw error;
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.rest.request("POST", "/fapi/v1/leverage", { symbol, leverage }, { signed: true, idempotent: true });
  }

  async placeMarketOrder(request: MarketOrderRequest): Promise<OrderResult> {
    const raw = await this.rest.request<RawOrder>(
      "POST",
      "/fapi/v1/order",
      {
        symbol: request.symbol,
        side: request.side,
        type: "MARKET",
        quantity: request.quantity,
        newClientOrderId: request.clientOrderId,
        newOrderRespType: "RESULT",
        reduceOnly: request.reduceOnly ? "true" : undefined,
      },
      { signed: true, idempotent: false },
    );
    return toOrderResult(raw);
  }

  async placeLimitOrder(request: LimitOrderRequest): Promise<OrderResult> {
    try {
      const raw = await this.rest.request<RawOrder>(
        "POST",
        "/fapi/v1/order",
        {
          symbol: request.symbol,
          side: request.side,
          type: "LIMIT",
          timeInForce: "GTX",
          quantity: request.quantity,
          price: request.price,
          newClientOrderId: request.clientOrderId,
          newOrderRespType: "RESULT",
        },
        { signed: true, idempotent: false },
      );
      return toOrderResult(raw);
    } catch (error) {
      // Some accounts answer a post-only order that would cross with an error rather than EXPIRED.
      if (error instanceof BinanceError && error.code === ERROR_CODES.POST_ONLY_REJECTED) {
        return { symbol: request.symbol, orderId: 0, clientOrderId: request.clientOrderId, side: request.side, type: "LIMIT", status: "EXPIRED", origQty: request.quantity, executedQty: "0", avgPrice: "0", updateTime: Date.now() };
      }
      throw error;
    }
  }

  async cancelOrder(symbol: string, clientOrderId: string): Promise<boolean> {
    try {
      await this.rest.request("DELETE", "/fapi/v1/order", { symbol, origClientOrderId: clientOrderId }, { signed: true, idempotent: true });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async getBookTicker(symbol: string): Promise<BookTicker> {
    const r = await this.rest.get<{ bidPrice: string; askPrice: string }>("/fapi/v1/ticker/bookTicker", { symbol });
    return { bidPrice: Number(r.bidPrice), askPrice: Number(r.askPrice) };
  }

  async getOrder(symbol: string, clientOrderId: string): Promise<OrderResult | null> {
    try {
      return toOrderResult(await this.rest.get<RawOrder>("/fapi/v1/order", { symbol, origClientOrderId: clientOrderId }, true));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async placeAlgoOrder(request: AlgoOrderRequest): Promise<AlgoOrder> {
    const r = await this.rest.request<Partial<AlgoOrder>>(
      "POST",
      "/fapi/v1/algoOrder",
      {
        algoType: "CONDITIONAL",
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        quantity: request.quantity,
        triggerPrice: request.triggerPrice,
        reduceOnly: "true",
        workingType: request.workingType,
        clientAlgoId: request.clientAlgoId,
      },
      { signed: true, idempotent: false },
    );
    return toAlgoOrder({ orderType: request.type, ...r });
  }

  async getAlgoOrder(clientAlgoId: string): Promise<AlgoOrder | null> {
    try {
      return toAlgoOrder(await this.rest.get<Partial<AlgoOrder>>("/fapi/v1/algoOrder", { clientAlgoId }, true));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async cancelAlgoOrder(_symbol: string, clientAlgoId: string): Promise<boolean> {
    try {
      await this.rest.request("DELETE", "/fapi/v1/algoOrder", { clientAlgoId }, { signed: true, idempotent: true });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  getUserTrades(symbol: string, startTime: number): Promise<UserTrade[]> {
    return this.rest.get<UserTrade[]>("/fapi/v1/userTrades", { symbol, startTime, limit: 1000 }, true);
  }

  async createListenKey(): Promise<string> {
    const r = await this.rest.request<{ listenKey: string }>("POST", "/fapi/v1/listenKey", {}, { idempotent: true });
    return r.listenKey;
  }

  async keepAliveListenKey(): Promise<void> {
    await this.rest.request("PUT", "/fapi/v1/listenKey", {}, { idempotent: true });
  }
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof BinanceError) || error.kind !== "REJECTED") return false;
  if (error.code === ERROR_CODES.NO_SUCH_ORDER || error.code === ERROR_CODES.UNKNOWN_ORDER_SENT) return true;
  return /does not exist|not exist|not found|unknown order/i.test(error.message);
}

type RawOrder = Partial<Record<keyof OrderResult | "cumQuote", unknown>>;

/**
 * Order responses vary: the DEMO answer to a MARKET order with newOrderRespType=RESULT has no
 * avgPrice (and no cumQuote). Missing numbers become "0" so callers fall back to the position.
 */
export function toOrderResult(raw: RawOrder): OrderResult {
  const executedQty = String(raw.executedQty ?? "0");
  let avgPrice = raw.avgPrice === undefined || raw.avgPrice === null ? "0" : String(raw.avgPrice);
  if (!(Number(avgPrice) > 0) && Number(raw.cumQuote) > 0 && Number(executedQty) > 0) {
    avgPrice = dec(String(raw.cumQuote)).div(executedQty).toString();
  }
  return {
    symbol: String(raw.symbol ?? ""),
    orderId: Number(raw.orderId ?? 0),
    clientOrderId: String(raw.clientOrderId ?? ""),
    side: raw.side === "SELL" ? "SELL" : "BUY",
    type: String(raw.type ?? ""),
    status: String(raw.status ?? ""),
    origQty: String(raw.origQty ?? "0"),
    executedQty,
    avgPrice,
    updateTime: Number(raw.updateTime ?? 0),
  };
}

function toAlgoOrder(raw: Partial<AlgoOrder>): AlgoOrder {
  return {
    algoId: Number(raw.algoId ?? 0),
    clientAlgoId: String(raw.clientAlgoId ?? ""),
    symbol: String(raw.symbol ?? ""),
    side: raw.side === "SELL" ? "SELL" : "BUY",
    orderType: String(raw.orderType ?? ""),
    quantity: String(raw.quantity ?? "0"),
    triggerPrice: String(raw.triggerPrice ?? "0"),
    algoStatus: String(raw.algoStatus ?? "NEW"),
    reduceOnly: raw.reduceOnly === true || (raw.reduceOnly as unknown) === "true",
    workingType: String(raw.workingType ?? ""),
    actualPrice: String(raw.actualPrice ?? "0"),
    actualQty: String(raw.actualQty ?? "0"),
    createTime: Number(raw.createTime ?? 0),
    updateTime: Number(raw.updateTime ?? 0),
  };
}
