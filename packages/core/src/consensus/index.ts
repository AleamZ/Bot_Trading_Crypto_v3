import { againstLeader, leaderTrendText, type FollowBtcMode, type LeaderTrend } from "../leader.js";
import { comboOf, type Direction, type MethodId, type MethodSignal } from "../types.js";

export type ConsensusLevel = "NONE" | "READY" | "ENTER";

export interface ConsensusOptions {
  /** Same-direction methods needed for a READY alert (default 2). */
  alertThreshold: number;
  /** Same-direction methods needed to enter automatically (default 3). */
  autoEntryThreshold: number;
  /** Still send READY when another method points the other way. */
  alertWhenOpposed: boolean;
  /** Enter only when this method is among the agreeing ones; otherwise READY at most. */
  entryRequires?: MethodId | "NONE";
  /**
   * Combos that may enter ("B+C", "D"): when set, ENTER needs the agreeing methods to include every
   * method of one of them (more is fine) instead of reaching `autoEntryThreshold`.
   */
  entryCombos?: readonly string[];
  /** Follow BTC: an altcoin against BTC's trend gets READY at most (see againstLeader). */
  followBtc?: FollowBtcMode;
  /** The symbol must have moved one way: efficiency ratio at least this to enter. 0 or absent: off. */
  minEfficiency?: number;
}

/** Market state the entry filters read, besides the signals. */
export interface ConsensusContext {
  /** BTC's trend, for an altcoin; absent for BTC itself. */
  leader?: LeaderTrend;
  /** The symbol's efficiency ratio on this candle (general.efficiencyBars). */
  efficiency?: number;
}

/** What it takes to enter: "B+C hoặc D", or "3 phương pháp cùng chiều" without combos. */
export function entryRuleText(general: { autoEntryThreshold: number; entryCombos?: readonly string[] }): string {
  return general.entryCombos?.length ? general.entryCombos.join(" hoặc ") : `${general.autoEntryThreshold} phương pháp cùng chiều`;
}

/** The agreeing methods contain every method of one of the combos. */
export function matchesCombo(agreeing: readonly MethodId[], combos: readonly string[]): boolean {
  const have = new Set(comboOf(agreeing).split("+"));
  return combos.some((combo) => combo.split("+").every((letter) => have.has(letter)));
}

export interface ConsensusResult {
  level: ConsensusLevel;
  /** Majority direction, or null when no method fires or both sides tie. */
  direction: Direction | null;
  agreeing: MethodSignal[];
  opposing: MethodSignal[];
  longCount: number;
  shortCount: number;
  /** BTC's trend and whether it kept this altcoin from entering; absent for BTC itself or with the rule off. */
  leader?: { trend: LeaderTrend; blocked: boolean };
  /** The symbol's efficiency ratio, the minimum, and whether it was too choppy to enter; absent with the filter off. */
  efficiency?: { value: number; min: number; blocked: boolean };
}

/**
 * Combines the active signals of the enabled methods.
 * - ENTER: none points the other way, the `entryRequires` method (if any) agrees, either the
 *   agreeing methods cover one of `entryCombos` or, without combos, at least `autoEntryThreshold`
 *   agree, the direction is not against BTC's trend (`leader`, altcoins only), and the symbol is not
 *   too choppy (`efficiency` at least `minEfficiency`).
 * - READY: at least `alertThreshold` agree (with an opposing method only if `alertWhenOpposed`).
 */
export function decideConsensus(signals: readonly MethodSignal[], options: ConsensusOptions, context: ConsensusContext = {}): ConsensusResult {
  const long = signals.filter((s) => s.direction === "LONG");
  const short = signals.filter((s) => s.direction === "SHORT");
  const { leader } = context;
  const mode = options.followBtc ?? "OFF";
  const follows = leader !== undefined && mode !== "OFF";
  const min = options.minEfficiency ?? 0;
  // Unknown efficiency (too few candles) counts as too choppy.
  const chop =
    min > 0 && context.efficiency !== undefined
      ? { value: context.efficiency, min, blocked: !(context.efficiency >= min) }
      : null;
  const base = { longCount: long.length, shortCount: short.length, ...(chop ? { efficiency: chop } : {}) };
  if (long.length === short.length) {
    return { ...base, level: "NONE", direction: null, agreeing: [], opposing: [...signals], ...(follows ? { leader: { trend: leader, blocked: false } } : {}) };
  }
  const direction: Direction = long.length > short.length ? "LONG" : "SHORT";
  const agreeing = direction === "LONG" ? long : short;
  const opposing = direction === "LONG" ? short : long;
  let level: ConsensusLevel = "NONE";
  const required = options.entryRequires && options.entryRequires !== "NONE" ? options.entryRequires : null;
  const hasRequired = required === null || agreeing.some((s) => s.method === required);
  const combos = options.entryCombos ?? [];
  const enough = combos.length > 0 ? matchesCombo(agreeing.map((s) => s.method), combos) : agreeing.length >= options.autoEntryThreshold;
  const follow = follows ? { trend: leader, blocked: againstLeader(direction, leader, mode) } : null;
  if (enough && opposing.length === 0 && hasRequired && !follow?.blocked && !chop?.blocked) level = "ENTER";
  else if (agreeing.length >= options.alertThreshold && (opposing.length === 0 || options.alertWhenOpposed)) level = "READY";
  return { ...base, level, direction, agreeing, opposing, ...(follow ? { leader: follow } : {}) };
}

/** Why an agreement does not enter even though enough methods agree, in Vietnamese; empty when nothing blocks it. */
export function entryBlockers(c: { leader?: ConsensusResult["leader"] | null; efficiency?: ConsensusResult["efficiency"] | null }): string[] {
  const out: string[] = [];
  if (c.leader?.blocked) out.push(`ngược xu hướng BTC (${leaderTrendText(c.leader.trend)})`);
  if (c.efficiency?.blocked) {
    const value = Number.isFinite(c.efficiency.value) ? c.efficiency.value.toFixed(2) : "?";
    out.push(`coin đang đi lòng vòng (ER ${value} < ${c.efficiency.min})`);
  }
  return out;
}

/** The alert episode a symbol is in, stored by the caller between candles. */
export interface Episode {
  direction: Direction;
  /** Highest level reached in this episode. */
  level: "READY" | "ENTER";
  startedAt: number;
  /**
   * ENTER episodes: false until an entry fills (the caller sets it with markEntered). While false,
   * every candle that is still 3/3 tries again. Missing on episodes stored before retries existed,
   * which count as entered.
   */
  entered?: boolean;
}

export interface EpisodeStep {
  episode: Episode | null;
  /** What to act on now: send READY, or try to enter. Null means nothing new. */
  emit: "READY" | "ENTER" | null;
  /** ENTER again because the earlier attempts of this episode did not fill. */
  retry?: boolean;
}

/**
 * Anti-spam. One READY per episode, and ENTER when the episode first reaches 3/3. An entry that did
 * not fill (refused by a limit, rejected by the exchange) does not use the episode up: ENTER comes
 * again on every following candle that is still 3/3, until an entry fills. An episode ends when
 * the consensus drops to NONE or flips direction; the next one emits again.
 */
export function advanceEpisode(previous: Episode | null, result: ConsensusResult, time: number): EpisodeStep {
  if (result.level === "NONE" || result.direction === null) return { episode: null, emit: null };
  if (previous === null || previous.direction !== result.direction) {
    const episode: Episode = { direction: result.direction, level: result.level, startedAt: time };
    return { episode: result.level === "ENTER" ? { ...episode, entered: false } : episode, emit: result.level };
  }
  if (previous.level === "READY" && result.level === "ENTER") {
    return { episode: { ...previous, level: "ENTER", entered: false }, emit: "ENTER" };
  }
  if (previous.level === "ENTER" && result.level === "ENTER" && previous.entered === false) {
    return { episode: previous, emit: "ENTER", retry: true };
  }
  return { episode: previous, emit: null };
}

/** The episode after its entry filled: no more ENTER until the next episode. */
export function markEntered(episode: Episode): Episode {
  return { ...episode, entered: true };
}
