export type Direction = "LONG" | "SHORT";

/** A closed kline. Times are Binance milliseconds; closeTime = openTime + interval - 1. */
export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MethodId = "trendPullback" | "donchianBreakout" | "smcSweep";

export const METHOD_IDS: readonly MethodId[] = ["trendPullback", "donchianBreakout", "smcSweep"];

export const METHOD_LABELS: Record<MethodId, string> = {
  trendPullback: "Xu hướng + hồi EMA",
  donchianBreakout: "Phá kênh Donchian",
  smcSweep: "SMC quét thanh khoản",
};

/** A method's entry trigger on one closed candle of the entry timeframe. */
export interface MethodSignal {
  method: MethodId;
  direction: Direction;
  /** Index of the trigger candle in the entry candle array. */
  index: number;
  /** closeTime of the trigger candle. */
  time: number;
  /** Close of the trigger candle. */
  price: number;
  /** The method's own structural stop loss. */
  stopLoss: number;
  reason: string;
  /** Method-specific levels (channel, swept low, FVG...), used for invalidation and for drawing. */
  levels: Record<string, number>;
}

export function isLong(direction: Direction): boolean {
  return direction === "LONG";
}

export function opposite(direction: Direction): Direction {
  return direction === "LONG" ? "SHORT" : "LONG";
}
