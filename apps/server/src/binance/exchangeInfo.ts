import { dec, type SymbolFilters } from "@bot-v3/core";
import type { ExchangeSymbol } from "./types.js";

interface RawFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  maxQty?: string;
  notional?: string;
}

export interface RawExchangeSymbol {
  symbol: string;
  status: string;
  contractType: string;
  filters: RawFilter[];
}

/**
 * Filters for a MARKET entry and its reduce-only exits. A market quantity must satisfy both
 * LOT_SIZE and MARKET_LOT_SIZE, so the coarser step, the larger minimum and the smaller maximum win.
 */
export function toExchangeSymbol(raw: RawExchangeSymbol): ExchangeSymbol {
  const find = (type: string) => raw.filters.find((f) => f.filterType === type);
  const price = find("PRICE_FILTER");
  const lot = find("LOT_SIZE");
  const market = find("MARKET_LOT_SIZE");
  const notional = find("MIN_NOTIONAL");
  if (!price?.tickSize || !lot?.stepSize || !lot.minQty) throw new Error(`${raw.symbol}: thiếu PRICE_FILTER hoặc LOT_SIZE`);

  const steps = [lot.stepSize, market?.stepSize].filter(isPositive);
  const stepSize = steps.reduce((a, b) => (dec(a).gte(b) ? a : b));
  const mins = [lot.minQty, market?.minQty].filter(isPositive);
  const minQty = mins.length ? mins.reduce((a, b) => (dec(a).gte(b) ? a : b)) : stepSize;
  const maxes = [lot.maxQty, market?.maxQty].filter(isPositive);
  const maxQty = maxes.length ? maxes.reduce((a, b) => (dec(a).lte(b) ? a : b)) : null;

  const filters: SymbolFilters = {
    symbol: raw.symbol,
    tickSize: price.tickSize,
    stepSize,
    minQty,
    maxQty,
    minNotional: isPositive(notional?.notional) ? notional.notional : null,
  };
  return { symbol: raw.symbol, status: raw.status, contractType: raw.contractType, filters };
}

function isPositive(value: string | undefined): value is string {
  if (value === undefined) return false;
  try {
    return dec(value).gt(0);
  } catch {
    return false;
  }
}
