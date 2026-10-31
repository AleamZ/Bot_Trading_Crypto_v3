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

export type MethodId = "trendPullback" | "donchianBreakout" | "smcSweep" | "boxTheory";

export const METHOD_IDS: readonly MethodId[] = ["trendPullback", "donchianBreakout", "smcSweep", "boxTheory"];

export const METHOD_LABELS: Record<MethodId, string> = {
  trendPullback: "Xu hướng + hồi EMA",
  donchianBreakout: "Phá kênh Donchian",
  smcSweep: "SMC quét thanh khoản",
  boxTheory: "Hộp (Box Theory)",
};

/** Short names used in combos ("B+C") and on the UI. */
export const METHOD_LETTERS: Record<MethodId, string> = { trendPullback: "A", donchianBreakout: "B", smcSweep: "C", boxTheory: "D" };

/** "B+C" for a set of methods, in A-B-C-D order. */
export function comboOf(methods: readonly MethodId[]): string {
  return METHOD_IDS.filter((m) => methods.includes(m))
    .map((m) => METHOD_LETTERS[m])
    .join("+");
}

/** Every non-empty set of methods as a combo, smallest first: "A", "B", …, "A+B", …, "A+B+C+D". */
export const METHOD_COMBOS: readonly string[] = Array.from({ length: (1 << METHOD_IDS.length) - 1 }, (_, k) =>
  comboOf(METHOD_IDS.filter((_, bit) => ((k + 1) >> bit) & 1)),
).sort((a, b) => a.length - b.length || a.localeCompare(b));

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
