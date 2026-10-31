import {
  dec,
  feeRateOf,
  finalizeAfterFill,
  formatToStep,
  planTrade,
  type Dec,
  type Direction,
  type MethodSignal,
  type Settings,
} from "@bot-v3/core";
import { errorText, isBinanceError } from "../binance/errors.js";
import type { FuturesApi, LeverageBracket, OrderResult } from "../binance/types.js";
import { silentLogger, type Logger } from "../lib/logger.js";
import { chooseLeverage } from "./leverage.js";
import { cancelEntryOrders, closedStats, entrySide, flatten, placeProtection, positionAmount } from "./protection.js";
import { KeyedLock, newTradeId, sleep as realSleep } from "./support.js";
import { CLIENT_ID, type EntryStage, type EventSink, type Trade, type TradeStore } from "./types.js";

export interface EntryRequest {
  symbol: string;
  direction: Direction;
  /** The agreeing methods' active signals. */
  signals: readonly MethodSignal[];
  /** ATR of the entry timeframe at the analysed candle. */
  atr: number;
  settings: Settings;
  /** A retry: a failure for this same reason was already reported, so it is only logged. */
  quietReason?: string;
}

/** How often a resting LIMIT entry is checked. */
const LIMIT_POLL_MS = 2000;

export type EntryOutcome =
  | { ok: true; trade: Trade }
  | { ok: false; stage: EntryStage; reason: string; detail: string; trade: Trade | null };

export interface ExecutorDeps {
  api: FuturesApi;
  store: TradeStore;
  events: EventSink;
  locks: KeyedLock;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
}

/**
 * Opens a position for a 3/3 decision. The rule it enforces: a position is never left without both
 * a stop loss and a take profit. If either cannot be placed, the position is closed at market.
 */
export class Executor {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;

  constructor(private readonly deps: ExecutorDeps) {
    this.logger = deps.logger ?? silentLogger;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? realSleep;
    this.newId = deps.newId ?? (() => newTradeId(this.now()));
  }

  enter(request: EntryRequest): Promise<EntryOutcome> {
    return this.deps.locks.run(request.symbol, () => this.enterLocked(request));
  }

  private async enterLocked(request: EntryRequest): Promise<EntryOutcome> {
    const { api, store } = this.deps;
    const { symbol, direction, settings } = request;
    const risk = settings.risk;
    const fail = (stage: EntryStage, reason: string, detail: string, trade: Trade | null = null): EntryOutcome => {
      if (reason !== request.quietReason) this.deps.events.emit({ type: "ENTRY_FAILED", symbol, direction, stage, reason, detail });
      this.logger.warn("Entry failed", { symbol, direction, stage, reason, detail });
      return { ok: false, stage, reason, detail, trade };
    };

    // 1. The account and the symbol must be clean.
    let info;
    let mark: number;
    let brackets: LeverageBracket[];
    let balance: number;
    try {
      if (await api.isHedgeMode()) return fail("PRECHECK", "HEDGE_MODE", "Tài khoản đang ở Hedge mode; bot cần One-way mode");
      const [symbolInfo, positions, orders, algos] = await Promise.all([
        api.getSymbol(symbol),
        api.getPositions(symbol),
        api.getOpenOrders(symbol),
        api.getOpenAlgoOrders(symbol),
      ]);
      if (symbolInfo.status !== "TRADING") return fail("PRECHECK", "SYMBOL_NOT_TRADING", `${symbol} đang ở trạng thái ${symbolInfo.status}`);
      const open = positions.find((p) => !dec(p.positionAmt).isZero());
      if (open || orders.length > 0 || algos.length > 0) {
        return fail("PRECHECK", "SYMBOL_BUSY", `${symbol} đang có vị thế hoặc lệnh chờ (có thể không phải của bot)`);
      }
      info = symbolInfo;
      [mark, brackets, balance] = await Promise.all([api.getMarkPrice(symbol), api.getLeverageBrackets(symbol), api.getAvailableBalance()]);
    } catch (error) {
      return fail("PRECHECK", "EXCHANGE_ERROR", errorText(error));
    }

    // 2. Plan at the current mark price.
    const plan = planTrade({ direction, signals: request.signals, entryPrice: mark, atr: request.atr, risk, filters: info.filters });
    if (!plan.ok) return fail("PLAN", plan.reason, plan.detail);
    const sizing = plan.sizing;
    if (!sizing) return fail("PLAN", "NO_FILTERS", "Thiếu bộ lọc của symbol");
    if (!sizing.ok) {
      const hint = sizing.minRiskUsd ? ` Cần 1R ≥ ${sizing.minRiskUsd}$.` : "";
      return fail("PLAN", sizing.reason, `${sizing.detail}.${hint}`);
    }
    const margin = chooseLeverage({
      direction,
      entryPrice: mark,
      stopLoss: Number(sizing.stopLoss),
      notional: Number(sizing.notional),
      riskAtStop: Number(sizing.riskAtStop),
      availableBalance: balance,
      brackets,
      risk,
    });
    const leverage = margin.leverage;
    if (!margin.ok) return fail("PLAN", margin.reason, margin.detail);

    // 3. Record the attempt before any order, so a crash leaves a trace the watchdog can adopt.
    const id = this.newId();
    const trade: Trade = {
      id,
      symbol,
      direction,
      status: "OPENING",
      methods: request.signals.map((s) => s.method),
      entrySignals: request.signals.map((s) => ({ method: s.method, direction: s.direction, time: s.time, price: s.price, stopLoss: s.stopLoss, reason: s.reason })),
      createdAt: this.now(),
      openedAt: null,
      closedAt: null,
      plannedEntry: mark,
      structuralStop: plan.stopLoss,
      riskUsd: risk.riskUsd,
      rr: risk.rr,
      leverage,
      entryClientId: CLIENT_ID.entry(id),
      quantity: "0",
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      stopMode: null,
      riskAtStopUsd: null,
      riskAtStopR: null,
      rewardAtTpUsd: null,
      rewardAtTpR: null,
      slClientId: null,
      tpClientId: null,
      protectionVersion: 0,
      exitReason: null,
      exitPrice: null,
      netPnl: null,
      fees: null,
      pnlR: null,
      note: null,
    };
    await store.insert(trade);
    const failTrade = async (stage: EntryStage, reason: string, detail: string) => {
      trade.status = "FAILED";
      trade.closedAt = this.now();
      trade.note = detail;
      await store.update(trade);
      return fail(stage, reason, detail, trade);
    };

    // 4. Margin type, leverage, then the entry: MARKET, or a post-only LIMIT that may not fill.
    try {
      await api.setMarginType(symbol, risk.marginType);
      await api.setLeverage(symbol, leverage);
    } catch (error) {
      return failTrade("ORDER", "LEVERAGE_FAILED", errorText(error));
    }
    if (risk.entryOrder === "LIMIT") {
      let note: string;
      try {
        note = (await this.limitEntry(trade, sizing.quantity, request, info.filters.tickSize)).note;
      } catch (error) {
        note = errorText(error);
        await cancelEntryOrders(api, symbol, trade.entryClientId).catch(() => []);
      }
      const amount = await positionAmount(api, symbol).catch(() => "0");
      // Nothing filled: not entered, the next candle that still qualifies tries again.
      if (dec(amount).isZero()) return failTrade("ORDER", "LIMIT_NOT_FILLED", `Lệnh limit không khớp: ${note}`);
      // All or part filled: protect what the position holds.
      return this.protectSafely(trade, null, request);
    }
    let order: OrderResult | null;
    try {
      order = await api.placeMarketOrder({ symbol, side: entrySide(direction), quantity: sizing.quantity, clientOrderId: trade.entryClientId });
    } catch (error) {
      if (!(isBinanceError(error) && error.kind === "UNKNOWN")) return failTrade("ORDER", "ORDER_REJECTED", errorText(error));
      order = await this.lookupEntry(symbol, trade.entryClientId);
      if (!order) {
        const amount = await positionAmount(api, symbol).catch(() => "0");
        if (dec(amount).isZero()) return failTrade("ORDER", "ORDER_UNKNOWN", `Không xác nhận được lệnh vào (${errorText(error)}), sàn không có vị thế`);
        // The position exists although the order lookup failed: protect it, never leave it bare.
        return this.protectSafely(trade, null, request);
      }
    }
    return this.protectSafely(trade, order, request);
  }

  /** From here on a position may exist: any unexpected error closes it instead of leaving it bare. */
  private protectSafely(trade: Trade, order: OrderResult | null, request: EntryRequest): Promise<EntryOutcome> {
    return this.protectOrFlatten(trade, order, request).catch((error: unknown) => {
      this.logger.error("Unexpected error after the entry", { tradeId: trade.id, symbol: trade.symbol, error: errorText(error) });
      return this.abort(trade, "UNEXPECTED_ERROR", `Lỗi bất ngờ sau khi vào lệnh: ${errorText(error)}`);
    });
  }

  /** After the entry filled: final SL/TP from the real fill, place both, verify, or flatten. */
  private async protectOrFlatten(trade: Trade, order: OrderResult | null, request: EntryRequest): Promise<EntryOutcome> {
    const { api, store, events } = this.deps;
    const risk = request.settings.risk;
    const info = await api.getSymbol(trade.symbol);

    let fillPrice = order ? dec(order.avgPrice) : dec(0);
    let filledQty = order ? dec(order.executedQty) : dec(0);
    if (!fillPrice.gt(0) || !filledQty.gt(0)) {
      // RESULT responses normally carry both; fall back to the position itself.
      const position = (await api.getPositions(trade.symbol)).find((p) => p.symbol === trade.symbol);
      if (position && !dec(position.positionAmt).isZero()) {
        fillPrice = dec(position.entryPrice);
        filledQty = dec(position.positionAmt).abs();
      }
    }
    if (!filledQty.gt(0)) {
      trade.status = "FAILED";
      trade.closedAt = this.now();
      trade.note = `Lệnh vào không khớp (trạng thái ${order?.status ?? "?"})`;
      await store.update(trade);
      events.emit({ type: "ENTRY_FAILED", symbol: trade.symbol, direction: trade.direction, stage: "ORDER", reason: "NOT_FILLED", detail: trade.note });
      return { ok: false, stage: "ORDER", reason: "NOT_FILLED", detail: trade.note, trade };
    }
    trade.quantity = filledQty.toString();
    trade.entryPrice = fillPrice.toString();
    trade.openedAt = order?.updateTime || this.now();
    await store.update(trade);

    const final = finalizeAfterFill({
      direction: trade.direction,
      fillPrice,
      filledQty,
      structuralStop: trade.structuralStop,
      riskUsd: risk.riskUsd,
      feeRate: feeRateOf(risk),
      rr: risk.rr,
      mode: risk.slMode,
      maxSlWidenPct: risk.maxSlWidenPct,
      tickSize: info.filters.tickSize,
    });
    if (!final.ok) return this.abort(trade, final.reason, final.detail);

    trade.stopLoss = final.stopLoss;
    trade.takeProfit = final.takeProfit;
    trade.stopMode = final.mode;
    trade.riskAtStopUsd = final.riskUsd;
    trade.riskAtStopR = final.riskR;
    trade.rewardAtTpUsd = final.rewardUsd;
    trade.rewardAtTpR = final.rewardR;
    trade.protectionVersion = 1;
    trade.slClientId = CLIENT_ID.stop(trade.id, 1);
    trade.tpClientId = CLIENT_ID.take(trade.id, 1);
    await store.update(trade);

    const placed = await placeProtection(api, {
      symbol: trade.symbol,
      direction: trade.direction,
      quantity: trade.quantity,
      stopLoss: final.stopLoss,
      takeProfit: final.takeProfit,
      slClientId: trade.slClientId,
      tpClientId: trade.tpClientId,
      workingType: risk.triggerPrice,
      retries: risk.protectionRetries,
      sleep: this.sleep,
    });
    if (!placed.ok) {
      const what = placed.reason === "WOULD_TRIGGER" ? "giá đã vượt qua mức" : "không đặt được";
      return this.abort(trade, `${placed.leg}_${placed.reason}`, `${placed.leg} ${what}: ${placed.detail}`);
    }

    // Both orders must really be on the exchange with the full quantity.
    const open = await api.getOpenAlgoOrders(trade.symbol).catch(() => null);
    const has = (id: string) => open?.some((a) => a.clientAlgoId === id && dec(a.quantity).gte(trade.quantity));
    if (!open || !has(trade.slClientId) || !has(trade.tpClientId)) {
      return this.abort(trade, "PROTECTION_NOT_VISIBLE", "Đã gửi SL/TP nhưng không thấy đủ cả hai trên sàn");
    }

    trade.status = "OPEN";
    await store.update(trade);
    events.emit({ type: "ENTRY_FILLED", trade: structuredClone(trade) });
    this.logger.info("Entry filled and protected", { tradeId: trade.id, symbol: trade.symbol, qty: trade.quantity, sl: trade.stopLoss, tp: trade.takeProfit });
    return { ok: true, trade };
  }

  /** Protection failed: close the position at market and record why. */
  private async abort(trade: Trade, reason: string, detail: string): Promise<EntryOutcome> {
    const { api, store, events } = this.deps;
    const result = await flatten(api, trade.symbol, trade.id);
    trade.note = [detail, result.detail].filter(Boolean).join("; ");
    if (result.flat) {
      trade.status = "CLOSED";
      trade.closedAt = this.now();
      trade.exitReason = "EMERGENCY";
      if (result.closeOrder && Number(result.closeOrder.avgPrice) > 0) trade.exitPrice = result.closeOrder.avgPrice;
      // The loss counts towards the daily limit like any other exit.
      const fills = await api.getUserTrades(trade.symbol, (trade.openedAt ?? trade.createdAt) - 1000).catch(() => null);
      if (fills) {
        const stats = closedStats(trade.direction, fills);
        trade.exitPrice = stats.exitPrice ?? trade.exitPrice;
        trade.netPnl = stats.netPnl;
        trade.fees = stats.fees;
        trade.pnlR = Number(stats.netPnl) / trade.riskUsd;
      }
    }
    // Not flat: the trade stays OPENING/OPEN so the watchdog keeps trying to protect or close it.
    await store.update(trade);
    events.emit({ type: "PROTECTION_FAILED", trade: structuredClone(trade), detail, flattened: result.flat });
    this.logger.error("Protection failed", { tradeId: trade.id, symbol: trade.symbol, reason, detail, flat: result.flat });
    return { ok: false, stage: "PROTECTION", reason, detail: trade.note, trade };
  }

  /** After an UNKNOWN answer, ask Binance a few times whether the entry exists. */
  /**
   * Post-only LIMIT at the best bid (LONG) or ask (SHORT). When the book moves away it is canceled
   * and posted again at the new best price, as long as that price is within limitMaxChaseAtr ATR of
   * the price at the decision; all of it within limitWaitSec. What filled stays, the rest is canceled.
   */
  private async limitEntry(trade: Trade, quantity: string, request: EntryRequest, tickSize: string): Promise<{ filled: Dec; note: string }> {
    const { api } = this.deps;
    const { symbol } = trade;
    const risk = request.settings.risk;
    const long = trade.direction === "LONG";
    const maxChase = risk.limitMaxChaseAtr * request.atr;
    let polls = Math.max(1, Math.ceil((risk.limitWaitSec * 1000) / LIMIT_POLL_MS));
    let filled = dec(0);
    let note = `hết ${risk.limitWaitSec} giây chờ`;
    for (let quote = 0; polls > 0 && filled.lt(quantity); quote++) {
      const book = await api.getBookTicker(symbol);
      const best = long ? book.bidPrice : book.askPrice;
      if ((long ? best - trade.plannedEntry : trade.plannedEntry - best) > maxChase) {
        note = `giá đã chạy quá ${risk.limitMaxChaseAtr} ATR khỏi giá lúc quyết định (${trade.plannedEntry} → ${best})`;
        break;
      }
      const id = quote === 0 ? trade.entryClientId : `${trade.entryClientId}-${quote}`;
      const price = formatToStep(best, tickSize);
      let order: OrderResult;
      try {
        order = await api.placeLimitOrder({ symbol, side: entrySide(trade.direction), quantity: dec(quantity).minus(filled).toString(), price, clientOrderId: id });
      } catch (error) {
        if (!(isBinanceError(error) && error.kind === "UNKNOWN")) {
          note = errorText(error);
          break;
        }
        const found = await this.lookupEntry(symbol, id);
        if (!found) {
          await api.cancelOrder(symbol, id).catch(() => false);
          note = `không xác nhận được lệnh limit (${errorText(error)})`;
          break;
        }
        order = found;
      }
      // Rest at this price until it fills, expires (it would have taken liquidity) or the book moves away.
      while (order.status === "NEW" || order.status === "PARTIALLY_FILLED") {
        if (polls-- <= 0) break;
        await this.sleep(LIMIT_POLL_MS);
        order = (await api.getOrder(symbol, id)) ?? order;
        if (order.status !== "NEW") continue;
        const top = await api.getBookTicker(symbol);
        if (long ? top.bidPrice > Number(price) : top.askPrice < Number(price)) break;
      }
      if (order.status === "NEW" || order.status === "PARTIALLY_FILLED") {
        await api.cancelOrder(symbol, id).catch(() => false);
        order = (await api.getOrder(symbol, id)) ?? order;
      }
      filled = filled.plus(order.executedQty || "0");
    }
    this.logger.info("Limit entry done", { tradeId: trade.id, symbol, filled: filled.toString(), quantity, note });
    return { filled, note };
  }

  private async lookupEntry(symbol: string, clientOrderId: string): Promise<OrderResult | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const order = await this.deps.api.getOrder(symbol, clientOrderId);
        if (order) return order;
      } catch (error) {
        this.logger.warn("Entry lookup failed", { symbol, clientOrderId, error: errorText(error) });
      }
      await this.sleep(500 * (attempt + 1));
    }
    return null;
  }
}
