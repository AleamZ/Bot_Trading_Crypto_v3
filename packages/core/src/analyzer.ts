import { decideConsensus, type ConsensusContext, type ConsensusResult } from "./consensus/index.js";
import { efficiencyRatio } from "./indicators/moving.js";
import { atr } from "./indicators/oscillators.js";
import { alignHigherTimeframe } from "./indicators/structure.js";
import { trendBiasSeries, type LeaderTrend } from "./leader.js";
import type { Settings } from "./settings/schema.js";
import { activeSignalAt } from "./strategies/active.js";
import { prepareBoxTheory } from "./strategies/boxTheory.js";
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
    boxTheory: methods.boxTheory.enabled ? prepareBoxTheory(market, methods.boxTheory, shared) : null,
  };

  // Follow BTC: its trend on the trend timeframe, aligned to the entry candles. Not for BTC itself.
  const follows = settings.general.followBtc !== "OFF" && market.leader !== undefined;
  const leaderSides = follows && market.leader ? trendBiasSeries(market.leader, methods.trendPullback) : [];
  const leaderIndex = follows && market.leader ? alignHigherTimeframe(market.entry, market.leader) : [];
  // Choppiness filter: the symbol's own efficiency ratio on the entry timeframe.
  const efficiency = settings.general.minEfficiency > 0 ? efficiencyRatio(market.entry.map((c) => c.close), settings.general.efficiencyBars) : null;

  function leaderAt(index: number): LeaderTrend {
    const t = leaderIndex[index] ?? -1;
    return t < 0 ? "NO_DATA" : (leaderSides[t] ?? null);
  }

  function context(index: number): ConsensusContext {
    return {
      ...(follows ? { leader: leaderAt(index) } : {}),
      ...(efficiency ? { efficiency: efficiency[index] ?? Number.NaN } : {}),
    };
  }

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
      consensus: decideConsensus(active, settings.general, context(index)),
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
