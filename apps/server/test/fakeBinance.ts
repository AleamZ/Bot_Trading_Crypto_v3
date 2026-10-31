import type { SymbolFilters } from "@bot-v3/core";
import { BinanceError } from "../src/binance/errors.js";
import { toOrderResult } from "../src/binance/futures.js";
import type {
  AlgoOrder,
  AlgoOrderRequest,
  BookTicker,
  ExchangeSymbol,
  FuturesApi,
  LeverageBracket,
  LimitOrderRequest,
  MarginType,
  MarketOrderRequest,
  OpenOrder,
  OrderResult,
  OrderSide,
  PositionInfo,
  UserTrade,
} from "../src/binance/types.js";

export const BTC_FILTERS: SymbolFilters = {
  symbol: "BTCUSDT",
  tickSize: "0.10",
  stepSize: "0.0001",
  minQty: "0.0001",
  maxQty: "120",
  minNotional: "50",
};

export const rejected = (code: number, msg: string) => new BinanceError({ kind: "REJECTED", status: 400, code, message: `Binance 400 (${code}): ${msg}` });
export const unknownError = () => new BinanceError({ kind: "UNKNOWN", status: 0, code: null, message: "Không gọi được Binance: timeout" });

interface FailureRule {
  error: BinanceError;
  times: number;
  /** Perform the action, then throw (an UNKNOWN that actually went through). */
  executeFirst: boolean;
  when: ((args: unknown) => boolean) | undefined;
}

const round = (x: number) => Number(x.toFixed(10));
const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/**
 * In-memory One-way futures account: market fills at the mark price (plus optional slippage),
 * reduce-only algo stops/take-profits that fire when setMark crosses them, user trades with
 * realized PnL and taker fees, and injectable failures per method.
 */
export class FakeBinance implements FuturesApi {
  hedgeMode = false;
  balance = 10_000;
  takerFee = 0.0005;
  /** Added to BUY fills and subtracted from SELL fills. */
  slippage = 0;
  /** Answer MARKET orders without avgPrice, like Binance DEMO does (seen live on 2026-10-30). */
  omitAvgPrice = false;
  clock = 1_800_000_000_000;
  /** Half the bid/ask spread around the mark price. */
  spread = 0.5;
  makerFee = 0.0002;
  /** Called on every getOrder, so a test can move the price while the bot waits on a LIMIT entry. */
  onPoll: ((poll: number) => void) | null = null;
  private polls = 0;
  private readonly resting = new Map<string, { symbol: string; side: OrderSide; price: number; qty: number }>();
  readonly marks = new Map<string, number>();
  readonly symbols = new Map<string, ExchangeSymbol>([["BTCUSDT", { symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", filters: BTC_FILTERS }]]);
  brackets: LeverageBracket[] = [{ bracket: 1, initialLeverage: 125, notionalFloor: 0, notionalCap: 1e15, maintMarginRatio: 0.004 }];
  readonly positions = new Map<string, { amt: number; entry: number; updateTime: number }>();
  openOrders: OpenOrder[] = [];
  readonly algos: AlgoOrder[] = [];
  readonly fills: UserTrade[] = [];
  readonly orders = new Map<string, OrderResult>();
  readonly calls: string[] = [];
  readonly settingsBySymbol = new Map<string, { marginType?: MarginType; leverage?: number }>();
  private readonly failures = new Map<string, FailureRule[]>();
  private nextId = 1;

  constructor() {
    this.marks.set("BTCUSDT", 68_000);
  }

  failNext(method: keyof FuturesApi, error: BinanceError, options: { times?: number; executeFirst?: boolean; when?: (args: unknown) => boolean } = {}) {
    const list = this.failures.get(method) ?? [];
    list.push({ error, times: options.times ?? 1, executeFirst: options.executeFirst ?? false, when: options.when });
    this.failures.set(method, list);
  }

  /** Throws now, or returns an error to throw after the action ran. */
  private check(method: string, args?: unknown): BinanceError | null {
    this.calls.push(method);
    this.clock += 1000;
    const rules = this.failures.get(method) ?? [];
    const rule = rules.find((r) => r.times > 0 && (!r.when || r.when(args)));
    if (!rule) return null;
    rule.times--;
    if (rule.executeFirst) return rule.error;
    throw rule.error;
  }

  /** Moves the mark price and fires any algo order it crosses. */
  setMark(symbol: string, price: number) {
    this.marks.set(symbol, price);
    this.clock += 1000;
    for (const algo of this.algos) {
      if (algo.symbol !== symbol || algo.algoStatus !== "NEW" || !this.crosses(algo, price)) continue;
      const position = this.positions.get(symbol);
      const reduces = position && sign(position.amt) === (algo.side === "SELL" ? 1 : -1);
      if (!reduces) {
        algo.algoStatus = "EXPIRED";
        continue;
      }
      const qty = Math.min(Number(algo.quantity), Math.abs(position.amt));
      const fillPrice = Number(algo.triggerPrice);
      this.fill(symbol, algo.side, qty, fillPrice, this.nextId++);
      algo.algoStatus = "FINISHED";
      algo.actualQty = String(qty);
      algo.actualPrice = String(fillPrice);
      algo.updateTime = this.clock;
    }
    // Resting LIMIT orders fill when the price trades through them.
    for (const [id, order] of [...this.resting]) {
      if (order.symbol !== symbol) continue;
      if (order.side === "BUY" ? price < order.price : price > order.price) this.fillLimit(id);
    }
  }

  /** Fills a resting LIMIT order at its price, all of it or `qty`, with the maker fee. */
  fillLimit(clientOrderId: string, qty?: number) {
    const order = this.resting.get(clientOrderId);
    const result = this.orders.get(clientOrderId);
    if (!order || !result) throw new Error(`No resting order ${clientOrderId}`);
    const amount = Math.min(qty ?? order.qty, order.qty);
    this.fill(order.symbol, order.side, amount, order.price, result.orderId, false, this.makerFee);
    order.qty = round(order.qty - amount);
    const executed = round(Number(result.executedQty) + amount);
    result.executedQty = String(executed);
    result.avgPrice = String(order.price);
    result.updateTime = this.clock;
    result.status = order.qty > 0 ? "PARTIALLY_FILLED" : "FILLED";
    if (order.qty <= 0) {
      this.resting.delete(clientOrderId);
      this.openOrders = this.openOrders.filter((o) => o.clientOrderId !== clientOrderId);
    }
  }

  private crosses(algo: Pick<AlgoOrder, "orderType" | "side" | "triggerPrice">, price: number): boolean {
    const trigger = Number(algo.triggerPrice);
    const stop = algo.orderType === "STOP_MARKET";
    // SELL stop and BUY take-profit fire on the way down; the others on the way up.
    const down = (stop && algo.side === "SELL") || (!stop && algo.side === "BUY");
    return down ? price <= trigger : price >= trigger;
  }

  private fill(symbol: string, side: OrderSide, qty: number, price: number, orderId: number, reduceOnly = false, fee = this.takerFee): number {
    const position = this.positions.get(symbol) ?? { amt: 0, entry: 0, updateTime: this.clock };
    const signed = side === "BUY" ? qty : -qty;
    if (reduceOnly) {
      if (position.amt === 0 || sign(signed) === sign(position.amt)) throw rejected(-2022, "ReduceOnly Order is rejected.");
      qty = Math.min(qty, Math.abs(position.amt));
    }
    const delta = side === "BUY" ? qty : -qty;
    let realized = 0;
    if (position.amt !== 0 && sign(delta) !== sign(position.amt)) {
      const closing = Math.min(qty, Math.abs(position.amt));
      realized = (price - position.entry) * closing * sign(position.amt);
    }
    const amt = round(position.amt + delta);
    if (amt === 0) this.positions.delete(symbol);
    else if (position.amt === 0 || sign(amt) !== sign(position.amt)) this.positions.set(symbol, { amt, entry: price, updateTime: this.clock });
    else if (Math.abs(amt) > Math.abs(position.amt)) {
      const entry = (position.entry * Math.abs(position.amt) + price * qty) / Math.abs(amt);
      this.positions.set(symbol, { amt, entry: round(entry), updateTime: this.clock });
    } else this.positions.set(symbol, { ...position, amt, updateTime: this.clock });
    this.fills.push({
      id: this.nextId++,
      orderId,
      symbol,
      side,
      price: String(price),
      qty: String(qty),
      realizedPnl: String(round(realized)),
      commission: String(round(qty * price * fee)),
      commissionAsset: "USDT",
      time: this.clock,
    });
    return qty;
  }

  /** A position opened outside the bot. */
  openForeign(symbol: string, amt: number, entry: number) {
    this.positions.set(symbol, { amt, entry, updateTime: this.clock });
  }

  // ---- FuturesApi ----

  async getSymbol(symbol: string): Promise<ExchangeSymbol> {
    this.check("getSymbol", symbol);
    const found = this.symbols.get(symbol);
    if (!found) throw new Error(`unknown symbol ${symbol}`);
    return found;
  }

  async getMarkPrice(symbol: string): Promise<number> {
    this.check("getMarkPrice", symbol);
    return this.marks.get(symbol) ?? 0;
  }

  async isHedgeMode(): Promise<boolean> {
    this.check("isHedgeMode");
    return this.hedgeMode;
  }

  async getAvailableBalance(): Promise<number> {
    this.check("getAvailableBalance");
    return this.balance;
  }

  async getLeverageBrackets(symbol: string): Promise<LeverageBracket[]> {
    this.check("getLeverageBrackets", symbol);
    return this.brackets;
  }

  async getPositions(symbol?: string): Promise<PositionInfo[]> {
    this.check("getPositions", symbol);
    const row = (s: string): PositionInfo => {
      const p = this.positions.get(s);
      return {
        symbol: s,
        positionAmt: String(p?.amt ?? 0),
        entryPrice: String(p?.entry ?? 0),
        markPrice: String(this.marks.get(s) ?? 0),
        unRealizedProfit: "0",
        liquidationPrice: "0",
        positionSide: "BOTH",
        updateTime: p?.updateTime ?? 0,
      };
    };
    if (symbol) return [row(symbol)];
    return [...this.positions.keys()].map(row);
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrder[]> {
    this.check("getOpenOrders", symbol);
    return this.openOrders.filter((o) => !symbol || o.symbol === symbol);
  }

  async getOpenAlgoOrders(symbol?: string): Promise<AlgoOrder[]> {
    this.check("getOpenAlgoOrders", symbol);
    return this.algos.filter((a) => a.algoStatus === "NEW" && (!symbol || a.symbol === symbol)).map((a) => ({ ...a }));
  }

  async setMarginType(symbol: string, marginType: MarginType): Promise<void> {
    this.check("setMarginType", { symbol, marginType });
    this.settingsBySymbol.set(symbol, { ...this.settingsBySymbol.get(symbol), marginType });
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.check("setLeverage", { symbol, leverage });
    this.settingsBySymbol.set(symbol, { ...this.settingsBySymbol.get(symbol), leverage });
  }

  async placeMarketOrder(request: MarketOrderRequest): Promise<OrderResult> {
    const after = this.check("placeMarketOrder", request);
    if (this.orders.has(request.clientOrderId)) throw rejected(-4116, "ClientOrderId is duplicated.");
    const mark = this.marks.get(request.symbol) ?? 0;
    const price = request.side === "BUY" ? mark + this.slippage : mark - this.slippage;
    const orderId = this.nextId++;
    const qty = this.fill(request.symbol, request.side, Number(request.quantity), price, orderId, request.reduceOnly ?? false);
    const result: OrderResult = {
      symbol: request.symbol,
      orderId,
      clientOrderId: request.clientOrderId,
      side: request.side,
      type: "MARKET",
      status: "FILLED",
      origQty: request.quantity,
      executedQty: String(qty),
      avgPrice: String(price),
      updateTime: this.clock,
    };
    this.orders.set(request.clientOrderId, result);
    if (after) throw after;
    if (this.omitAvgPrice) {
      const { avgPrice: _omitted, ...withoutPrice } = result;
      return toOrderResult(withoutPrice);
    }
    return { ...result };
  }

  async placeLimitOrder(request: LimitOrderRequest): Promise<OrderResult> {
    const after = this.check("placeLimitOrder", request);
    if (this.orders.has(request.clientOrderId)) throw rejected(-4116, "ClientOrderId is duplicated.");
    const mark = this.marks.get(request.symbol) ?? 0;
    const price = Number(request.price);
    // Post-only: an order that would take liquidity expires instead.
    const crosses = request.side === "BUY" ? price >= mark + this.spread : price <= mark - this.spread;
    const result: OrderResult = {
      symbol: request.symbol,
      orderId: this.nextId++,
      clientOrderId: request.clientOrderId,
      side: request.side,
      type: "LIMIT",
      status: crosses ? "EXPIRED" : "NEW",
      origQty: request.quantity,
      executedQty: "0",
      avgPrice: "0",
      updateTime: this.clock,
    };
    this.orders.set(request.clientOrderId, result);
    if (!crosses) {
      this.resting.set(request.clientOrderId, { symbol: request.symbol, side: request.side, price, qty: Number(request.quantity) });
      this.openOrders.push({ symbol: request.symbol, orderId: result.orderId, clientOrderId: request.clientOrderId, type: "LIMIT", side: request.side, origQty: request.quantity, status: "NEW", reduceOnly: false });
    }
    if (after) throw after;
    return { ...result };
  }

  async cancelOrder(_symbol: string, clientOrderId: string): Promise<boolean> {
    this.check("cancelOrder", clientOrderId);
    const order = this.orders.get(clientOrderId);
    if (!order || !(order.status === "NEW" || order.status === "PARTIALLY_FILLED")) return false;
    order.status = "CANCELED";
    this.resting.delete(clientOrderId);
    this.openOrders = this.openOrders.filter((o) => o.clientOrderId !== clientOrderId);
    return true;
  }

  async getBookTicker(symbol: string): Promise<BookTicker> {
    this.check("getBookTicker", symbol);
    const mark = this.marks.get(symbol) ?? 0;
    return { bidPrice: mark - this.spread, askPrice: mark + this.spread };
  }

  /** LIMIT orders resting on the book. */
  restingOrders() {
    return [...this.resting.entries()].map(([clientOrderId, o]) => ({ clientOrderId, ...o }));
  }

  async getOrder(_symbol: string, clientOrderId: string): Promise<OrderResult | null> {
    this.check("getOrder", clientOrderId);
    this.onPoll?.(++this.polls);
    const order = this.orders.get(clientOrderId);
    return order ? { ...order } : null;
  }

  async placeAlgoOrder(request: AlgoOrderRequest): Promise<AlgoOrder> {
    const after = this.check("placeAlgoOrder", request);
    if (this.algos.some((a) => a.clientAlgoId === request.clientAlgoId && a.algoStatus === "NEW")) {
      throw rejected(-4116, "ClientAlgoId is duplicated.");
    }
    const mark = this.marks.get(request.symbol) ?? 0;
    if (this.crosses({ orderType: request.type, side: request.side, triggerPrice: request.triggerPrice }, mark)) {
      throw rejected(-2021, "Order would immediately trigger.");
    }
    const algo: AlgoOrder = {
      algoId: this.nextId++,
      clientAlgoId: request.clientAlgoId,
      symbol: request.symbol,
      side: request.side,
      orderType: request.type,
      quantity: request.quantity,
      triggerPrice: request.triggerPrice,
      algoStatus: "NEW",
      reduceOnly: true,
      workingType: request.workingType,
      actualPrice: "0",
      actualQty: "0",
      createTime: this.clock,
      updateTime: this.clock,
    };
    this.algos.push(algo);
    if (after) throw after;
    return { ...algo };
  }

  async getAlgoOrder(clientAlgoId: string): Promise<AlgoOrder | null> {
    this.check("getAlgoOrder", clientAlgoId);
    const found = [...this.algos].reverse().find((a) => a.clientAlgoId === clientAlgoId);
    return found ? { ...found } : null;
  }

  async cancelAlgoOrder(_symbol: string, clientAlgoId: string): Promise<boolean> {
    this.check("cancelAlgoOrder", clientAlgoId);
    const found = this.algos.find((a) => a.clientAlgoId === clientAlgoId && a.algoStatus === "NEW");
    if (!found) return false;
    found.algoStatus = "CANCELED";
    return true;
  }

  async getUserTrades(symbol: string, startTime: number): Promise<UserTrade[]> {
    this.check("getUserTrades", { symbol, startTime });
    return this.fills.filter((f) => f.symbol === symbol && f.time >= startTime);
  }

  // ---- helpers for assertions ----

  openAlgos(symbol = "BTCUSDT"): AlgoOrder[] {
    return this.algos.filter((a) => a.symbol === symbol && a.algoStatus === "NEW");
  }

  positionAmt(symbol = "BTCUSDT"): number {
    return this.positions.get(symbol)?.amt ?? 0;
  }
}
