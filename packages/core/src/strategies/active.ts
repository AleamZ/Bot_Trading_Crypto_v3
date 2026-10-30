import type { Candle, MethodSignal } from "../types.js";
import type { PreparedStrategy } from "./types.js";

/**
 * The method's signal that still counts at candle i, or null. Only the most recent trigger within
 * the last `ttlBars` candles is considered: a newer trigger replaces an older one. It stops counting
 * once a later candle touches its stop loss or the method says the setup is invalidated.
 *
 * This is computed from candles alone (no stored state), so a restart gives the same answer.
 */
export function activeSignalAt(
  strategy: PreparedStrategy,
  candles: readonly Candle[],
  i: number,
  ttlBars: number,
): MethodSignal | null {
  for (let j = i; j >= 0 && j > i - ttlBars; j--) {
    const signal = strategy.evaluate(j);
    if (!signal) continue;
    for (let k = j + 1; k <= i; k++) {
      const c = candles[k]!;
      const stopTouched = signal.direction === "LONG" ? c.low <= signal.stopLoss : c.high >= signal.stopLoss;
      if (stopTouched || strategy.isInvalidated(signal, k)) return null;
    }
    return signal;
  }
  return null;
}
