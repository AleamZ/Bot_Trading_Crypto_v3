import type { Direction } from "../types.js";
import { ceilToStep, dec, floorToStep, formatToStep, type DecValue } from "./decimal.js";

export interface StopMoveSettings {
  moveSl: boolean;
  /** Stop to the entry once price has gone this % of the way to TP (0 = never). */
  breakEvenAtTpPct: number;
  /** Stop to lockSlAtTpPct once price has gone this % of the way to TP (0 = never). */
  lockAtTpPct: number;
  lockSlAtTpPct: number;
}

/** 0: the stop the trade was opened with; 1: moved to the entry; 2: moved into profit. */
export type StopStage = 0 | 1 | 2;

/** How far `price` is from the entry towards the TP: 0 at the entry, 1 at the TP, negative against. */
export function tpProgress(direction: Direction, entry: number, takeProfit: number, price: number): number {
  const distance = takeProfit - entry;
  if (distance === 0) return 0;
  return (price - entry) / distance;
}

export interface NextStopInput {
  direction: Direction;
  entry: DecValue;
  takeProfit: DecValue;
  /** The stop in place now. */
  stopLoss: DecValue;
  stage: StopStage;
  /** Furthest progress towards the TP seen since the entry (tpProgress of the best price). */
  bestProgress: number;
  settings: StopMoveSettings;
  tickSize: string;
}

export interface NextStop {
  stage: 1 | 2;
  /** Formatted to the tick size, as Binance expects. */
  stopLoss: string;
}

/**
 * Moves the stop as price runs towards the TP, never back: at breakEvenAtTpPct of the way the stop
 * goes to the entry, at lockAtTpPct it goes to lockSlAtTpPct of the way (a locked-in win). Returns
 * null when nothing changes. The locked level is rounded towards the entry, so it never asks for
 * more than the setting.
 */
export function nextStop(input: NextStopInput): NextStop | null {
  const s = input.settings;
  if (!s.moveSl) return null;
  const reached = (pct: number) => pct > 0 && input.bestProgress >= pct / 100;
  const target = reached(s.lockAtTpPct) ? 2 : reached(s.breakEvenAtTpPct) ? 1 : null;
  if (target === null || target <= input.stage) return null;

  const long = input.direction === "LONG";
  const entry = dec(input.entry);
  const level = target === 1 ? entry : entry.plus(dec(input.takeProfit).minus(entry).mul(s.lockSlAtTpPct / 100));
  const rounded = long ? floorToStep(level, input.tickSize) : ceilToStep(level, input.tickSize);
  const better = long ? rounded.gt(input.stopLoss) : rounded.lt(input.stopLoss);
  if (!better) return null;
  return { stage: target, stopLoss: formatToStep(rounded, input.tickSize) };
}
