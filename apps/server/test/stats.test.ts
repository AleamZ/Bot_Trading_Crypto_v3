import { describe, expect, it } from "vitest";
import { monthOf, monthRange, monthStats, periodStats } from "../src/app/stats.js";
import { tradeOutcome, type Trade } from "../src/engine/types.js";
import { sampleTrade } from "./fixtures.js";

const HOUR = 3_600_000;
// 01/10/2026 00:00 Vietnam time.
const OCT = Date.UTC(2026, 8, 30, 17);

let seq = 0;
function closed(closedAt: number, pnlR: number, netPnl: number, extra: Partial<Trade> = {}): Trade {
  seq++;
  return sampleTrade({
    id: `c${seq}`,
    status: "CLOSED",
    openedAt: closedAt - HOUR,
    closedAt,
    exitReason: pnlR > 0 ? "TP" : "SL",
    pnlR,
    netPnl: String(netPnl),
    fees: "0.2",
    ...extra,
  });
}

const atEntry = { exitReason: "SL" as const, slMoves: [{ at: 0, stage: 1 as const, from: "67067.6", to: "68000", progress: 0.5 }] };

describe("trade outcome", () => {
  it("counts a stop moved to the entry, or a result within ±0.05R, as break-even", () => {
    expect(tradeOutcome(closed(OCT, 1.8, 9))).toBe("WIN");
    expect(tradeOutcome(closed(OCT, -1, -5))).toBe("LOSS");
    // Fees make an exit at the entry slightly negative: still break-even.
    expect(tradeOutcome(closed(OCT, -0.12, -0.6, atEntry))).toBe("FLAT");
    expect(tradeOutcome(closed(OCT, 0.03, 0.15, { exitReason: "MANUAL" }))).toBe("FLAT");
    // A stop locked in profit is a win.
    expect(tradeOutcome(closed(OCT, 0.5, 2.5, { exitReason: "SL", slMoves: [{ at: 0, stage: 2, from: "68000", to: "68930", progress: 0.75 }] }))).toBe("WIN");
  });
});

describe("periodStats", () => {
  it("gives the win rate by trades, by R and by USDT, with streaks", () => {
    const trades = [
      closed(OCT + 1 * HOUR, 1.8, 9),
      closed(OCT + 2 * HOUR, 1.8, 9),
      closed(OCT + 3 * HOUR, -0.08, -0.4, atEntry),
      closed(OCT + 4 * HOUR, -1, -5),
      closed(OCT + 5 * HOUR, -1, -5),
      closed(OCT + 6 * HOUR, 0.03, 0.15, { exitReason: "MANUAL" }),
      closed(OCT + 7 * HOUR, 1.8, 9),
    ];
    const s = periodStats([...trades].reverse());
    expect(s).toMatchObject({ count: 7, wins: 3, losses: 2, flats: 2, longestWinStreak: 2, longestLossStreak: 2 });
    expect(s.winRate).toBeCloseTo(3 / 7);
    expect(s.winRateDecided).toBeCloseTo(3 / 5);
    expect(s.r.won).toBeCloseTo(5.43);
    expect(s.r.lost).toBeCloseTo(-2.08);
    expect(s.r.net).toBeCloseTo(3.35);
    expect(s.r.winShare).toBeCloseTo(5.43 / 7.51);
    expect(s.r.profitFactor).toBeCloseTo(5.43 / 2.08);
    expect(s.r).toMatchObject({ avgWin: 1.8, avgLoss: -1, best: 1.8, worst: -1 });
    expect(s.r.perTrade).toBeCloseTo(3.35 / 7);
    expect(s.usd.net).toBeCloseTo(16.75);
    expect(s.usd.won).toBeCloseTo(27.15);
    expect(s.usd.lost).toBeCloseTo(-10.4);
    expect(s.usd.fees).toBeCloseTo(1.4);
  });

  it("has no rates without trades and no profit factor without a loss", () => {
    expect(periodStats([])).toMatchObject({ count: 0, winRate: null, winRateDecided: null, r: { net: 0, winShare: null, profitFactor: null, perTrade: null, best: null } });
    expect(periodStats([closed(OCT, 1.8, 9)]).r).toMatchObject({ winShare: 1, profitFactor: null });
  });
});

describe("monthStats", () => {
  it("covers every Vietnam day of the month and files trades by their close time", () => {
    expect(monthRange("2026-10")).toEqual({ from: OCT, to: Date.UTC(2026, 9, 31, 17) });
    expect(monthOf(OCT - 1)).toBe("2026-09");
    expect(monthOf(OCT)).toBe("2026-10");
    const lastMinuteOfDay1 = closed(OCT + 24 * HOUR - 60_000, 1.8, 9);
    const firstMinuteOfDay2 = closed(OCT + 24 * HOUR, -1, -5);
    const september = closed(OCT - HOUR, -1, -5);
    const stats = monthStats({
      month: "2026-10",
      monthTrades: [lastMinuteOfDay1, firstMinuteOfDay2, september],
      allTrades: [september, lastMinuteOfDay1, firstMinuteOfDay2],
      now: OCT + 30 * 24 * HOUR,
      firstClosedAt: september.closedAt,
    });
    expect(stats).toMatchObject({ month: "2026-10", today: "2026-10-31", firstMonth: "2026-09" });
    expect(stats.days).toHaveLength(31);
    expect(stats.days[0]).toEqual({ day: "2026-10-01", count: 1, wins: 1, losses: 0, flats: 0, r: 1.8, pnl: 9, fees: 0.2 });
    expect(stats.days[1]).toMatchObject({ day: "2026-10-02", count: 1, losses: 1, r: -1, pnl: -5 });
    expect(stats.days[30]).toMatchObject({ day: "2026-10-31", count: 0 });
    expect(stats.totals).toMatchObject({ count: 2, wins: 1, losses: 1 });
    expect(stats.allTime).toMatchObject({ count: 3, wins: 1, losses: 2 });
  });
});
