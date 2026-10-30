import { TRADING_DAY_OFFSET_MINUTES, tradingDayKey } from "@bot-v3/core";
import { tradeOutcome, type Trade } from "../engine/types.js";

const DAY_MS = 86_400_000;

/** One measure (R or USDT) split into what the winners made and what the losers cost. */
export interface MeasureStats {
  /** Sum of the positive results. */
  won: number;
  /** Sum of the negative results (zero or below). */
  lost: number;
  net: number;
  /** won / (won + |lost|): the share of the gross result on the winning side, 0..1. */
  winShare: number | null;
  /** won / |lost|; null when nothing was lost. */
  profitFactor: number | null;
  /** Average of the WIN trades and of the LOSS trades. */
  avgWin: number | null;
  avgLoss: number | null;
  /** net / trades: what one trade made on average. */
  perTrade: number | null;
  best: number | null;
  worst: number | null;
}

export interface PeriodStats {
  count: number;
  wins: number;
  losses: number;
  /** Closed by a stop already moved to the entry, or within ±0.05R. */
  flats: number;
  /** wins / count. */
  winRate: number | null;
  /** wins / (wins + losses), break-even trades left out. */
  winRateDecided: number | null;
  longestWinStreak: number;
  longestLossStreak: number;
  r: MeasureStats;
  usd: MeasureStats & { fees: number };
}

export interface DayStats {
  /** "YYYY-MM-DD", Vietnam trading day the trades closed in. */
  day: string;
  count: number;
  wins: number;
  losses: number;
  flats: number;
  r: number;
  pnl: number;
  fees: number;
}

export interface MonthStats {
  /** "YYYY-MM" */
  month: string;
  /** Trading day of `now`, so the UI can mark it and leave later days empty. */
  today: string;
  /** Month of the first closed trade, or null when nothing has closed yet. */
  firstMonth: string | null;
  /** Every day of the month, empty ones included. */
  days: DayStats[];
  totals: PeriodStats;
  allTime: PeriodStats;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Start (inclusive) and end (exclusive) of a Vietnam-time month, in ms. */
export function monthRange(month: string, offsetMinutes = TRADING_DAY_OFFSET_MINUTES): { from: number; to: number } {
  const m = MONTH.exec(month);
  if (!m) throw new Error(`Bad month ${month}`);
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  const offset = offsetMinutes * 60_000;
  return { from: Date.UTC(year, index, 1) - offset, to: Date.UTC(year, index + 1, 1) - offset };
}

export const monthOf = (time: number) => tradingDayKey(time).slice(0, 7);

function measure(values: number[], outcomes: ReturnType<typeof tradeOutcome>[]): MeasureStats {
  let won = 0;
  let lost = 0;
  const winValues: number[] = [];
  const lossValues: number[] = [];
  values.forEach((v, i) => {
    if (v > 0) won += v;
    else lost += v;
    if (outcomes[i] === "WIN") winValues.push(v);
    if (outcomes[i] === "LOSS") lossValues.push(v);
  });
  const mean = (list: number[]) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : null);
  const gross = won - lost;
  return {
    won,
    lost,
    net: won + lost,
    winShare: gross > 0 ? won / gross : null,
    profitFactor: lost < 0 ? won / -lost : null,
    avgWin: mean(winValues),
    avgLoss: mean(lossValues),
    perTrade: values.length ? (won + lost) / values.length : null,
    best: values.length ? Math.max(...values) : null,
    worst: values.length ? Math.min(...values) : null,
  };
}

/** Win rate by trade count, by R and by USDT for closed trades. */
export function periodStats(trades: readonly Trade[]): PeriodStats {
  const ordered = [...trades].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const outcomes = ordered.map(tradeOutcome);
  const wins = outcomes.filter((o) => o === "WIN").length;
  const losses = outcomes.filter((o) => o === "LOSS").length;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let streak = 0;
  outcomes.forEach((o, i) => {
    // A break-even trade ends both kinds of streak.
    streak = o !== "FLAT" && i > 0 && outcomes[i - 1] === o ? streak + 1 : o === "FLAT" ? 0 : 1;
    if (o === "WIN") longestWinStreak = Math.max(longestWinStreak, streak);
    if (o === "LOSS") longestLossStreak = Math.max(longestLossStreak, streak);
  });
  return {
    count: ordered.length,
    wins,
    losses,
    flats: ordered.length - wins - losses,
    winRate: ordered.length ? wins / ordered.length : null,
    winRateDecided: wins + losses ? wins / (wins + losses) : null,
    longestWinStreak,
    longestLossStreak,
    r: measure(
      ordered.map((t) => t.pnlR ?? 0),
      outcomes,
    ),
    usd: {
      ...measure(
        ordered.map((t) => Number(t.netPnl ?? 0)),
        outcomes,
      ),
      fees: ordered.reduce((s, t) => s + Number(t.fees ?? 0), 0),
    },
  };
}

/**
 * The month's closed trades day by day (Vietnam trading days, by close time, like "R hôm nay")
 * with the month's and the all-time win rates.
 */
export function monthStats(input: { month: string; monthTrades: readonly Trade[]; allTrades: readonly Trade[]; now: number; firstClosedAt: number | null }): MonthStats {
  const { from, to } = monthRange(input.month);
  const days: DayStats[] = [];
  for (let t = from; t < to; t += DAY_MS) days.push({ day: tradingDayKey(t), count: 0, wins: 0, losses: 0, flats: 0, r: 0, pnl: 0, fees: 0 });
  for (const trade of input.monthTrades) {
    if (trade.closedAt === null || trade.closedAt < from || trade.closedAt >= to) continue;
    const day = days[Math.floor((trade.closedAt - from) / DAY_MS)]!;
    const outcome = tradeOutcome(trade);
    day.count++;
    if (outcome === "WIN") day.wins++;
    else if (outcome === "LOSS") day.losses++;
    else day.flats++;
    day.r += trade.pnlR ?? 0;
    day.pnl += Number(trade.netPnl ?? 0);
    day.fees += Number(trade.fees ?? 0);
  }
  return {
    month: input.month,
    today: tradingDayKey(input.now),
    firstMonth: input.firstClosedAt === null ? null : monthOf(input.firstClosedAt),
    days,
    totals: periodStats(input.monthTrades.filter((t) => t.closedAt !== null && t.closedAt >= from && t.closedAt < to)),
    allTime: periodStats(input.allTrades),
  };
}
