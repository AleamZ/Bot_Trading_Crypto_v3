import { dec, feeRateOf, finalizeAfterFill, nextStop, tpProgress, type Settings } from "@bot-v3/core";
import { errorText } from "../binance/errors.js";
import type { AlgoOrder, FuturesApi, PositionInfo } from "../binance/types.js";
import { silentLogger, type Logger } from "../lib/logger.js";
import { absQty, closedStats, flatten, placeProtection } from "./protection.js";
import { KeyedLock, sleep as realSleep } from "./support.js";
import { CLIENT_ID, type EventSink, type StopMove, type Trade, type TradeStore } from "./types.js";

export interface WatchdogDeps {
  api: FuturesApi;
  store: TradeStore;
  events: EventSink;
  locks: KeyedLock;
  /** Current settings (read on every pass, so UI changes apply). */
  settings: () => Settings;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReconcileReport {
  checked: number;
  closed: string[];
  repaired: string[];
  /** Trades whose stop was moved towards the TP. */
  stopsMoved: string[];
  flattened: string[];
  skippedLocked: string[];
  foreign: string[];
  orphansCanceled: string[];
}

const LIVE_ALGO = new Set(["NEW"]);
/** The order fired and the position is being closed right now: do not replace it. */
const FIRING_ALGO = new Set(["TRIGGERING", "TRIGGERED"]);
const FILLED_ALGO = new Set(["TRIGGERED", "FINISHED"]);
/** Extra looks at the SL/TP orders when a position is gone and neither shows as fired yet. */
const CLOSE_CHECK_RETRIES = 3;
const CLOSE_CHECK_DELAY_MS = 1000;

/** The order fired and some quantity executed. */
const executed = (a: AlgoOrder | null) => a !== null && FILLED_ALGO.has(a.algoStatus) && dec(a.actualQty || "0").gt(0);

/**
 * Compares the bot's open trades with the exchange (on a timer and after every user-stream event):
 * - a position without its SL or TP gets them back, or is closed if that fails;
 * - the stop moves to the entry, then into profit, as the mark price runs towards the TP;
 * - a trade whose position is gone is closed out (TP/SL/manual), and the leftover leg is canceled;
 * - a trade left OPENING by a crash is adopted (protected) or marked FAILED;
 * - positions the bot did not open are reported once and left alone.
 */
export class Watchdog {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly reportedForeign = new Set<string>();
  private running: Promise<ReconcileReport> | null = null;

  constructor(private readonly deps: WatchdogDeps) {
    this.logger = deps.logger ?? silentLogger;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? realSleep;
  }

  /**
   * Closed trades recorded as manual because the SL/TP order did not show as fired yet when the
   * position went (fixed since): if Binance now shows the order executed, record that exit.
   */
  async recheckManualExits(trades: readonly Trade[]): Promise<string[]> {
    const fixed: string[] = [];
    for (const trade of trades) {
      if (trade.status !== "CLOSED" || trade.exitReason !== "MANUAL") continue;
      const sl = trade.slClientId ? await this.deps.api.getAlgoOrder(trade.slClientId).catch(() => null) : null;
      const tp = trade.tpClientId ? await this.deps.api.getAlgoOrder(trade.tpClientId).catch(() => null) : null;
      const reason = executed(tp) ? "TP" : executed(sl) ? "SL" : null;
      if (!reason) continue;
      trade.exitReason = reason;
      trade.note = [trade.note, `Kiểu thoát sửa thành ${reason} (trước ghi nhầm là đóng tay)`].filter(Boolean).join("; ");
      await this.deps.store.update(trade);
      fixed.push(trade.id);
      this.logger.info("Exit reason corrected", { tradeId: trade.id, symbol: trade.symbol, exit: reason });
    }
    return fixed;
  }

  /** One pass. Concurrent calls share the pass in progress. */
  reconcile(): Promise<ReconcileReport> {
    if (!this.running) this.running = this.pass().finally(() => (this.running = null));
    return this.running;
  }

  private async pass(): Promise<ReconcileReport> {
    const { api, store, locks } = this.deps;
    const report: ReconcileReport = { checked: 0, closed: [], repaired: [], stopsMoved: [], flattened: [], skippedLocked: [], foreign: [], orphansCanceled: [] };
    const [positions, algos, trades] = await Promise.all([api.getPositions(), api.getOpenAlgoOrders(), store.listByStatus(["OPENING", "OPEN"])]);

    for (const trade of trades) {
      let ran = false;
      await locks.tryRun(trade.symbol, async () => {
        ran = true;
        await this.checkTrade(trade, positions, algos, report);
      });
      if (ran) report.checked++;
      else report.skippedLocked.push(trade.symbol);
    }

    const managed = new Set(trades.map((t) => t.symbol));
    const openSymbols = new Set<string>();
    for (const p of positions) {
      if (dec(p.positionAmt).isZero()) continue;
      openSymbols.add(p.symbol);
      if (managed.has(p.symbol) || this.reportedForeign.has(p.symbol)) continue;
      this.reportedForeign.add(p.symbol);
      report.foreign.push(p.symbol);
      this.deps.events.emit({ type: "FOREIGN_POSITION", symbol: p.symbol, positionAmt: p.positionAmt });
    }
    for (const symbol of [...this.reportedForeign]) if (!openSymbols.has(symbol)) this.reportedForeign.delete(symbol);

    // The bot's algo orders on a symbol with no managed trade and no position are leftovers.
    for (const algo of algos) {
      if (!CLIENT_ID.isOurs(algo.clientAlgoId) || managed.has(algo.symbol) || openSymbols.has(algo.symbol)) continue;
      if (locks.isLocked(algo.symbol)) continue;
      const canceled = await api.cancelAlgoOrder(algo.symbol, algo.clientAlgoId).catch(() => false);
      if (canceled) report.orphansCanceled.push(algo.clientAlgoId);
    }
    return report;
  }

  private async checkTrade(trade: Trade, positions: PositionInfo[], algos: AlgoOrder[], report: ReconcileReport): Promise<void> {
    const position = positions.find((p) => p.symbol === trade.symbol);
    const amount = dec(position?.positionAmt ?? "0");
    try {
      if (amount.isZero()) {
        if (trade.status === "OPENING") await this.failOpening(trade);
        else await this.closeOut(trade, report);
        return;
      }
      const sideMatches = trade.direction === "LONG" ? amount.gt(0) : amount.lt(0);
      if (!sideMatches) {
        this.deps.events.emit({ type: "ERROR", message: `${trade.symbol}: vị thế trên sàn ngược chiều với lệnh ${trade.id}`, detail: position?.positionAmt ?? "" });
        return;
      }
      if (trade.status === "OPENING") await this.adopt(trade, position!, report);
      else if (await this.ensureProtection(trade, absQty(position!.positionAmt), algos, report)) await this.moveStop(trade, position!, report);
    } catch (error) {
      this.logger.error("Reconcile failed", { tradeId: trade.id, symbol: trade.symbol, error: errorText(error) });
      this.deps.events.emit({ type: "ERROR", message: `Đối chiếu ${trade.symbol} lỗi`, detail: errorText(error) });
    }
  }

  private async failOpening(trade: Trade): Promise<void> {
    trade.status = "FAILED";
    trade.closedAt = this.now();
    trade.note = trade.note ?? "Bot dừng giữa lúc vào lệnh; sàn không có vị thế";
    await this.deps.store.update(trade);
  }

  /** OPENING with a live position (the bot stopped right after the fill): protect it now. */
  private async adopt(trade: Trade, position: PositionInfo, report: ReconcileReport): Promise<void> {
    const { api } = this.deps;
    const risk = this.deps.settings().risk;
    const info = await api.getSymbol(trade.symbol);
    trade.quantity = absQty(position.positionAmt);
    trade.entryPrice = position.entryPrice;
    trade.openedAt = trade.openedAt ?? position.updateTime ?? this.now();
    const final = finalizeAfterFill({
      direction: trade.direction,
      fillPrice: position.entryPrice,
      filledQty: trade.quantity,
      structuralStop: trade.structuralStop,
      riskUsd: trade.riskUsd,
      feeRate: feeRateOf(risk),
      rr: trade.rr,
      mode: risk.slMode,
      maxSlWidenPct: risk.maxSlWidenPct,
      tickSize: info.filters.tickSize,
    });
    if (!final.ok) {
      await this.emergency(trade, `Không tính được SL/TP cho vị thế mồ côi: ${final.detail}`, report);
      return;
    }
    trade.stopLoss = final.stopLoss;
    trade.takeProfit = final.takeProfit;
    trade.stopMode = final.mode;
    trade.riskAtStopUsd = final.riskUsd;
    trade.riskAtStopR = final.riskR;
    trade.rewardAtTpUsd = final.rewardUsd;
    trade.rewardAtTpR = final.rewardR;
    trade.status = "OPEN";
    // Leftover algo orders from the interrupted attempt are replaced by a fresh pair.
    await flattenAlgosOnly(api, trade.symbol);
    await this.replace(trade, ["SL", "TP"], trade.quantity, report);
  }

  /** Puts back missing legs; true when both were already in place. */
  private async ensureProtection(trade: Trade, quantity: string, algos: AlgoOrder[], report: ReconcileReport): Promise<boolean> {
    const { api } = this.deps;
    const missing: ("SL" | "TP")[] = [];
    for (const leg of ["SL", "TP"] as const) {
      const id = leg === "SL" ? trade.slClientId : trade.tpClientId;
      const live = id ? algos.find((a) => a.clientAlgoId === id && LIVE_ALGO.has(a.algoStatus)) : undefined;
      if (live && dec(live.quantity).eq(quantity)) continue;
      if (live) {
        // Quantity no longer matches the position (partly closed by hand): cancel and place again.
        await api.cancelAlgoOrder(trade.symbol, live.clientAlgoId);
        missing.push(leg);
        continue;
      }
      const state = id ? await api.getAlgoOrder(id).catch(() => null) : null;
      if (state && FIRING_ALGO.has(state.algoStatus)) return false; // closing right now; check again next pass
      missing.push(leg);
    }
    if (missing.length === 0) return true;
    if (quantity !== trade.quantity) trade.quantity = quantity;
    await this.replace(trade, missing, quantity, report);
    return false;
  }

  /**
   * Moves the stop as the mark price runs towards the TP (settings risk.moveSl): to the entry at
   * breakEvenAtTpPct of the way, into profit at lockAtTpPct. The new stop is placed before the old
   * one is canceled, so the position is never without a stop. A move that would trigger at once
   * (price already came back) waits for a later pass.
   */
  private async moveStop(trade: Trade, position: PositionInfo, report: ReconcileReport): Promise<void> {
    const { api, store, events } = this.deps;
    const risk = this.deps.settings().risk;
    const mark = Number(position.markPrice);
    if (!risk.moveSl || !trade.entryPrice || !trade.stopLoss || !trade.takeProfit || !trade.tpClientId || !(mark > 0)) return;
    const progress = tpProgress(trade.direction, Number(trade.entryPrice), Number(trade.takeProfit), mark);
    const best = Math.max(trade.bestProgress ?? 0, progress);
    const bestChanged = best > (trade.bestProgress ?? 0) + 1e-9;
    if (bestChanged) trade.bestProgress = best;

    const info = await api.getSymbol(trade.symbol);
    const next = nextStop({
      direction: trade.direction,
      entry: trade.entryPrice,
      takeProfit: trade.takeProfit,
      stopLoss: trade.stopLoss,
      stage: trade.slMoves?.at(-1)?.stage ?? 0,
      bestProgress: best,
      settings: risk,
      tickSize: info.filters.tickSize,
    });
    const long = trade.direction === "LONG";
    const triggersNow = next !== null && (long ? dec(next.stopLoss).gte(mark) : dec(next.stopLoss).lte(mark));
    if (!next || triggersNow) {
      if (bestChanged) await store.update(trade);
      return;
    }

    const version = trade.protectionVersion + 1;
    const slClientId = CLIENT_ID.stop(trade.id, version);
    const placed = await placeProtection(api, {
      symbol: trade.symbol,
      direction: trade.direction,
      quantity: absQty(position.positionAmt),
      stopLoss: next.stopLoss,
      takeProfit: trade.takeProfit,
      slClientId,
      tpClientId: trade.tpClientId,
      workingType: risk.triggerPrice,
      retries: risk.protectionRetries,
      legs: ["SL"],
      sleep: this.sleep,
    });
    if (!placed.ok) {
      // The old stop is still in place; try again next pass.
      if (bestChanged) await store.update(trade);
      if (placed.reason !== "WOULD_TRIGGER") events.emit({ type: "ERROR", message: `${trade.symbol}: không dời được SL`, detail: placed.detail });
      return;
    }
    if (trade.slClientId) {
      const old = trade.slClientId;
      await api.cancelAlgoOrder(trade.symbol, old).catch((error) => {
        // Both stops are reduce-only and the new one is closer, so it fires first; leftovers are canceled at close.
        this.logger.warn("Old stop not canceled", { tradeId: trade.id, clientAlgoId: old, error: errorText(error) });
      });
    }
    const move: StopMove = { at: this.now(), stage: next.stage, from: trade.stopLoss, to: next.stopLoss, progress: Math.round(best * 1000) / 1000 };
    trade.slMoves = [...(trade.slMoves ?? []), move];
    trade.stopLoss = next.stopLoss;
    trade.slClientId = slClientId;
    trade.protectionVersion = version;
    await store.update(trade);
    report.stopsMoved.push(trade.id);
    events.emit({ type: "STOP_MOVED", trade: structuredClone(trade), move });
    this.logger.info("Stop moved", { tradeId: trade.id, symbol: trade.symbol, stage: move.stage, from: move.from, to: move.to });
  }

  /** Places the given legs again under new client ids; flattens if that fails. */
  private async replace(trade: Trade, legs: ("SL" | "TP")[], quantity: string, report: ReconcileReport): Promise<void> {
    const { api, store, events } = this.deps;
    const risk = this.deps.settings().risk;
    if (!trade.stopLoss || !trade.takeProfit) {
      await this.emergency(trade, "Lệnh không có giá SL/TP đã lưu", report);
      return;
    }
    const version = trade.protectionVersion + 1;
    const slClientId = legs.includes("SL") ? CLIENT_ID.stop(trade.id, version) : trade.slClientId!;
    const tpClientId = legs.includes("TP") ? CLIENT_ID.take(trade.id, version) : trade.tpClientId!;
    const placed = await placeProtection(api, {
      symbol: trade.symbol,
      direction: trade.direction,
      quantity,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      slClientId,
      tpClientId,
      workingType: risk.triggerPrice,
      retries: risk.protectionRetries,
      legs,
      sleep: this.sleep,
    });
    if (!placed.ok) {
      await this.emergency(trade, `Không đặt lại được ${placed.leg}: ${placed.detail}`, report);
      return;
    }
    trade.protectionVersion = version;
    trade.slClientId = slClientId;
    trade.tpClientId = tpClientId;
    await store.update(trade);
    report.repaired.push(trade.id);
    events.emit({ type: "PROTECTION_REPAIRED", trade: structuredClone(trade), legs });
    this.logger.warn("Protection repaired", { tradeId: trade.id, symbol: trade.symbol, legs });
  }

  private async emergency(trade: Trade, detail: string, report: ReconcileReport): Promise<void> {
    const { api, store, events } = this.deps;
    const result = await flatten(api, trade.symbol, trade.id);
    trade.note = [detail, result.detail].filter(Boolean).join("; ");
    if (result.flat) {
      report.flattened.push(trade.id);
      await this.closeOut(trade, report, "EMERGENCY");
    } else {
      await store.update(trade);
    }
    events.emit({ type: "PROTECTION_FAILED", trade: structuredClone(trade), detail, flattened: result.flat });
  }

  /** The position is gone: find out how, cancel the leftover leg, record the result. */
  private async closeOut(trade: Trade, report: ReconcileReport, forced?: "EMERGENCY"): Promise<void> {
    const { api, store, events } = this.deps;
    const firing = (a: AlgoOrder | null) => a !== null && FIRING_ALGO.has(a.algoStatus);
    let sl: AlgoOrder | null = null;
    let tp: AlgoOrder | null = null;
    let reason: Trade["exitReason"] = forced ?? null;
    // The algo service can report a fired stop as NEW, or without its quantity, for a moment
    // after the position is gone: ask again before calling it a manual close.
    for (let attempt = 0; ; attempt++) {
      sl = trade.slClientId ? await api.getAlgoOrder(trade.slClientId).catch(() => null) : null;
      tp = trade.tpClientId ? await api.getAlgoOrder(trade.tpClientId).catch(() => null) : null;
      reason ??= executed(tp) ? "TP" : executed(sl) ? "SL" : firing(tp) ? "TP" : firing(sl) ? "SL" : null;
      if (reason || attempt >= CLOSE_CHECK_RETRIES) break;
      await this.sleep(CLOSE_CHECK_DELAY_MS);
    }
    trade.exitReason = reason ?? "MANUAL";
    for (const leg of [sl, tp]) {
      if (leg && LIVE_ALGO.has(leg.algoStatus)) await api.cancelAlgoOrder(trade.symbol, leg.clientAlgoId).catch(() => false);
    }
    await flattenAlgosOnly(api, trade.symbol);

    const since = (trade.openedAt ?? trade.createdAt) - 1000;
    const fills = await api.getUserTrades(trade.symbol, since).catch(() => []);
    const stats = closedStats(trade.direction, fills);
    trade.exitPrice = stats.exitPrice ?? (trade.exitReason === "TP" ? tp?.actualPrice ?? null : trade.exitReason === "SL" ? sl?.actualPrice ?? null : null);
    trade.netPnl = stats.netPnl;
    trade.fees = stats.fees;
    trade.pnlR = Number(stats.netPnl) / trade.riskUsd;
    trade.status = "CLOSED";
    trade.closedAt = this.now();
    await store.update(trade);
    report.closed.push(trade.id);
    events.emit({ type: "TRADE_CLOSED", trade: structuredClone(trade) });
    this.logger.info("Trade closed", { tradeId: trade.id, symbol: trade.symbol, exit: trade.exitReason, pnl: trade.netPnl, r: trade.pnlR });
  }
}

/** Cancels the bot's remaining algo orders on a symbol. */
async function flattenAlgosOnly(api: FuturesApi, symbol: string): Promise<void> {
  const open = await api.getOpenAlgoOrders(symbol).catch(() => []);
  for (const algo of open) {
    if (CLIENT_ID.isOurs(algo.clientAlgoId)) await api.cancelAlgoOrder(symbol, algo.clientAlgoId).catch(() => false);
  }
}
