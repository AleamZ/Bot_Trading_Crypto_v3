import type { Direction } from "../types.js";

export type StopPolicy = "WIDEST" | "MEDIAN" | "TIGHTEST";

/**
 * One stop loss from the agreeing methods' stops.
 * WIDEST is furthest from the entry (lowest for LONG, highest for SHORT): when price gets there,
 * every method's reason for the trade has failed. MEDIAN of an even count takes the further of the
 * two middle values.
 */
export function combineStops(direction: Direction, stops: readonly number[], policy: StopPolicy): number {
  if (stops.length === 0) throw new Error("combineStops needs at least one stop");
  // Sorted from furthest to closest to the entry.
  const sorted = [...stops].sort((a, b) => (direction === "LONG" ? a - b : b - a));
  if (policy === "WIDEST") return sorted[0]!;
  if (policy === "TIGHTEST") return sorted[sorted.length - 1]!;
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}
