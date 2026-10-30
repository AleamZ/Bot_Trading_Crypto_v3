import { decideConsensus, type ConsensusResult } from "./consensus/index.js";
import { atr } from "./indicators/oscillators.js";
import type { Settings } from "./settings/schema.js";
import { activeSignalAt } from "./strategies/active.js";
import { prepareDonchianBreakout } from "./strategies/donchianBreakout.js";
import { prepareSmcSweep } from "./strategies/smcSweep.js";
import { prepareTrendPullback } from "./strategies/trendPullback.js";
import type { MarketData, PreparedStrategy, StrategyExplanation } from "./strategies/types.js";
import { METHOD_IDS, type MethodId, type MethodSignal } from "./types.js";

export interface MethodState {
  enabled: boolean;
  /** The signal that still counts at this candle, or null. */
  signal: MethodSignal | null;
}

export interface SymbolAnalysis {
  index: number;
  /** closeTime of the analysed candle. */
  time: number;
  price: number;
  atr: number;
  methods: Record<MethodId, MethodState>;
  consensus: ConsensusResult;
}

export interface Analyzer {
  /** Number of entry candles. */
  readonly length: number;
  /** The prepared methods (null when disabled), for charts and explanations. */
  readonly strategies: Record<MethodId, PreparedStrategy | null>;
  /** ATR of the entry timeframe, per candle. */
  readonly atr: readonly number[];
  at(index: number): SymbolAnalysis;
  /** Analysis of the last closed candle. */
  latest(): SymbolAnalysis;
  /** Every condition of every enabled method at a candle, for LONG and SHORT. */
  explain(index: number): Record<MethodId, StrategyExplanation | null>;
}

/**
 * Prepares the enabled methods once for a candle array. The live bot calls latest() after each
 * candle close; a backtest walks at(i) over the history with the same code.
 */
export function createAnalyzer(market: MarketData, settings: Settings): Analyzer {
  const shared = { atr: atr(market.entry, settings.general.atrPeriod) };
  const { methods } = settings;
  const prepared: Record<MethodId, PreparedStrategy | null> = {
    trendPullback: methods.trendPullback.enabled ? prepareTrendPullback(market, methods.trendPullback, shared) : null,
    donchianBreakout: methods.donchianBreakout.enabled ? prepareDonchianBreakout(market, methods.donchianBreakout, shared) : null,
    smcSweep: methods.smcSweep.enabled ? prepareSmcSweep(market, methods.smcSweep, shared) : null,
  };

  function at(index: number): SymbolAnalysis {
    const candle = market.entry[index];
    if (!candle) throw new RangeError(`No entry candle at index ${index}`);
    const states = {} as Record<MethodId, MethodState>;
    const active: MethodSignal[] = [];
    for (const id of METHOD_IDS) {
      const strategy = prepared[id];
      const signal = strategy ? activeSignalAt(strategy, market.entry, index, settings.general.signalTtlBars) : null;
      states[id] = { enabled: strategy !== null, signal };
      if (signal) active.push(signal);
    }
    return {
      index,
      time: candle.closeTime,
      price: candle.close,
      atr: shared.atr[index] ?? Number.NaN,
      methods: states,
      consensus: decideConsensus(active, settings.general),
    };
  }

  function explain(index: number): Record<MethodId, StrategyExplanation | null> {
    const out = {} as Record<MethodId, StrategyExplanation | null>;
    for (const id of METHOD_IDS) out[id] = prepared[id]?.explain(index) ?? null;
    return out;
  }

  return {
    length: market.entry.length,
    strategies: prepared,
    atr: shared.atr,
    at,
    latest: () => at(market.entry.length - 1),
    explain,
  };
}
