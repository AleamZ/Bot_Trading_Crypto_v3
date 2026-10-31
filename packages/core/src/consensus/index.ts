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
}

/**
 * Combines the active signals of the enabled methods.
 * - ENTER: none points the other way, the `entryRequires` method (if any) agrees, and either the
 *   agreeing methods cover one of `entryCombos` or, without combos, at least `autoEntryThreshold` agree.
 * - READY: at least `alertThreshold` agree (with an opposing method only if `alertWhenOpposed`).
 */
export function decideConsensus(signals: readonly MethodSignal[], options: ConsensusOptions): ConsensusResult {
  const long = signals.filter((s) => s.direction === "LONG");
  const short = signals.filter((s) => s.direction === "SHORT");
  const base = { longCount: long.length, shortCount: short.length };
  if (long.length === short.length) {
    return { ...base, level: "NONE", direction: null, agreeing: [], opposing: [...signals] };
  }
  const direction: Direction = long.length > short.length ? "LONG" : "SHORT";
  const agreeing = direction === "LONG" ? long : short;
  const opposing = direction === "LONG" ? short : long;
  let level: ConsensusLevel = "NONE";
  const required = options.entryRequires && options.entryRequires !== "NONE" ? options.entryRequires : null;
  const hasRequired = required === null || agreeing.some((s) => s.method === required);
  const combos = options.entryCombos ?? [];
  const enough = combos.length > 0 ? matchesCombo(agreeing.map((s) => s.method), combos) : agreeing.length >= options.autoEntryThreshold;
  if (enough && opposing.length === 0 && hasRequired) level = "ENTER";
  else if (agreeing.length >= options.alertThreshold && (opposing.length === 0 || options.alertWhenOpposed)) level = "READY";
  return { ...base, level, direction, agreeing, opposing };
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
