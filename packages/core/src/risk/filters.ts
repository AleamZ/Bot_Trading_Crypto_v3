/** The Binance exchangeInfo filters that matter for a MARKET entry and its stop/limit triggers. */
export interface SymbolFilters {
  symbol: string;
  /** PRICE_FILTER.tickSize */
  tickSize: string;
  /** Quantity step for market orders (MARKET_LOT_SIZE, compatible with LOT_SIZE). */
  stepSize: string;
  minQty: string;
  /** Null when Binance reports no usable maximum. */
  maxQty: string | null;
  /** MIN_NOTIONAL.notional, or null when absent. */
  minNotional: string | null;
}
