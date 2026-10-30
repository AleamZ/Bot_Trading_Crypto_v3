import type { Direction } from "@bot-v3/core";
import { dec } from "@bot-v3/core";
import { ERROR_CODES, errorText, isBinanceError } from "../binance/errors.js";
import type { AlgoType, FuturesApi, OrderResult, OrderSide, UserTrade, WorkingType } from "../binance/types.js";
import { CLIENT_ID } from "./types.js";

export const entrySide = (direction: Direction): OrderSide => (direction === "LONG" ? "BUY" : "SELL");
export const exitSide = (direction: Direction): OrderSide => (direction === "LONG" ? "SELL" : "BUY");

/** Absolute value of a Binance quantity string, without float noise ("-0.0057" -> "0.0057"). */
export function absQty(amount: string): string {
  return dec(amount).abs().toString();
}

export interface ProtectionRequest {
  symbol: string;
  direction: Direction;
  quantity: string;
  stopLoss: string;
  takeProfit: string;
  slClientId: string;
  tpClientId: string;
  workingType: WorkingType;
  /** Extra attempts per leg for errors other than "would immediately trigger". */
  retries: number;
  /** Which legs to place (default both). */
  legs?: readonly ("SL" | "TP")[];
  sleep: (ms: number) => Promise<void>;
}

export type ProtectionResult =
  | { ok: true }
  | { ok: false; leg: "SL" | "TP"; reason: "WOULD_TRIGGER" | "PLACE_FAILED"; detail: string };

/**
 * Places the reduce-only STOP_MARKET (first) and TAKE_PROFIT_MARKET through the Algo service, by
 * quantity, never closePosition. An UNKNOWN outcome is looked up by client id before retrying.
 */
export async function placeProtection(api: FuturesApi, request: ProtectionRequest): Promise<ProtectionResult> {
  const legs = request.legs ?? ["SL", "TP"];
  for (const leg of ["SL", "TP"] as const) {
    if (!legs.includes(leg)) continue;
    const type: AlgoType = leg === "SL" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET";
    const clientAlgoId = leg === "SL" ? request.slClientId : request.tpClientId;
    const triggerPrice = leg === "SL" ? request.stopLoss : request.takeProfit;
    let placed = false;
    let lastError = "";
    for (let attempt = 0; attempt <= request.retries && !placed; attempt++) {
      try {
        await api.placeAlgoOrder({
          symbol: request.symbol,
          side: exitSide(request.direction),
          type,
          quantity: request.quantity,
          triggerPrice,
          clientAlgoId,
          workingType: request.workingType,
        });
        placed = true;
      } catch (error) {
        lastError = errorText(error);
        if (isBinanceError(error, ERROR_CODES.WOULD_IMMEDIATELY_TRIGGER)) {
          return { ok: false, leg, reason: "WOULD_TRIGGER", detail: lastError };
        }
        if (isBinanceError(error) && error.kind === "UNKNOWN") {
          const existing = await api.getAlgoOrder(clientAlgoId).catch(() => null);
          if (existing && existing.algoStatus === "NEW") {
            placed = true;
            break;
          }
        }
        if (attempt < request.retries) await request.sleep(500 * (attempt + 1));
      }
    }
    if (!placed) return { ok: false, leg, reason: "PLACE_FAILED", detail: lastError };
  }
  return { ok: true };
}

export interface FlattenResult {
  /** The symbol has no position left. */
  flat: boolean;
  closeOrder: OrderResult | null;
  detail: string;
}

/**
 * Emergency exit: cancel the bot's algo orders on the symbol, then close whatever position is left
 * with a reduce-only MARKET order, and check the position is really gone.
 */
export async function flatten(api: FuturesApi, symbol: string, tradeId: string): Promise<FlattenResult> {
  const notes: string[] = [];
  try {
    const algos = await api.getOpenAlgoOrders(symbol);
    for (const algo of algos.filter((a) => CLIENT_ID.isOurs(a.clientAlgoId))) {
      await api.cancelAlgoOrder(symbol, algo.clientAlgoId).catch((error) => notes.push(`Huỷ ${algo.clientAlgoId} lỗi: ${errorText(error)}`));
    }
  } catch (error) {
    notes.push(`Không đọc được lệnh algo: ${errorText(error)}`);
  }

  let closeOrder: OrderResult | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let amount: string;
    try {
      amount = await positionAmount(api, symbol);
    } catch (error) {
      notes.push(`Không đọc được vị thế: ${errorText(error)}`);
      continue;
    }
    if (dec(amount).isZero()) return { flat: true, closeOrder, detail: notes.join("; ") };
    const clientOrderId = CLIENT_ID.close(tradeId, attempt);
    try {
      closeOrder = await api.placeMarketOrder({
        symbol,
        side: dec(amount).gt(0) ? "SELL" : "BUY",
        quantity: absQty(amount),
        clientOrderId,
        reduceOnly: true,
      });
    } catch (error) {
      notes.push(`Đóng vị thế lần ${attempt} lỗi: ${errorText(error)}`);
      if (isBinanceError(error) && error.kind === "UNKNOWN") {
        closeOrder = await api.getOrder(symbol, clientOrderId).catch(() => null);
      }
    }
  }
  try {
    const amount = await positionAmount(api, symbol);
    return { flat: dec(amount).isZero(), closeOrder, detail: notes.join("; ") };
  } catch (error) {
    notes.push(`Không đọc được vị thế: ${errorText(error)}`);
    return { flat: false, closeOrder, detail: notes.join("; ") };
  }
}

export async function positionAmount(api: FuturesApi, symbol: string): Promise<string> {
  const positions = await api.getPositions(symbol);
  return positions.find((p) => p.symbol === symbol && (p.positionSide === "BOTH" || !p.positionSide))?.positionAmt ?? "0";
}

export interface ClosedStats {
  exitPrice: string | null;
  netPnl: string;
  fees: string;
}

/**
 * Result of a closed trade from the account's fills since it opened: the exit price is the
 * volume-weighted price of the closing side, net PnL is realized PnL minus USDT commissions.
 */
export function closedStats(direction: Direction, trades: readonly UserTrade[]): ClosedStats {
  const closing = trades.filter((t) => t.side === exitSide(direction));
  let qty = dec(0);
  let value = dec(0);
  for (const t of closing) {
    qty = qty.plus(t.qty);
    value = value.plus(dec(t.price).mul(t.qty));
  }
  let realized = dec(0);
  let fees = dec(0);
  for (const t of trades) {
    realized = realized.plus(t.realizedPnl);
    if (t.commissionAsset === "USDT") fees = fees.plus(t.commission);
  }
  return {
    exitPrice: qty.gt(0) ? value.div(qty).toSignificantDigits(12).toString() : null,
    netPnl: realized.minus(fees).toFixed(4),
    fees: fees.toFixed(4),
  };
}
