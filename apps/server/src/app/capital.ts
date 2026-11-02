import type { Settings } from "@bot-v3/core";
import type { KeyValueStore, SqliteTradeStore } from "../db/stores.js";

const CAPITAL_KEY = "capital";

export interface CapitalStatus {
  /** risk.capitalUsd. */
  capital: number;
  /** Capital plus the net result of the trades closed since `since`. */
  equity: number;
  /** Margin of the bot's open positions (entry × quantity / leverage). */
  inUse: number;
  /** What the bot may still use: equity minus inUse, never below 0. */
  available: number;
  since: number;
}

/**
 * A simulated account size for testing on DEMO with the money one would really put in: the bot
 * sizes margin and leverage as if the account held `risk.capitalUsd`, plus what it has made or lost
 * since. It starts over when the amount changes or the P&L figures are cleared. Unrealised P&L of
 * open positions is not counted.
 */
export class SimulatedCapital {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly trades: SqliteTradeStore,
    private readonly settings: () => Settings,
    private readonly statsSince: () => number | null,
    private readonly now: () => number,
  ) {}

  /** When the current simulated account started: the last change of the amount, or the last clear. */
  since(): number {
    const capital = this.settings().risk.capitalUsd;
    let stored = this.kv.get<{ capital: number; since: number } | null>(CAPITAL_KEY, null);
    if (!stored || stored.capital !== capital) {
      stored = { capital, since: this.now() };
      this.kv.set(CAPITAL_KEY, stored);
    }
    return Math.max(stored.since, this.statsSince() ?? 0);
  }

  /** Null when no simulated capital is set. */
  status(): CapitalStatus | null {
    const capital = this.settings().risk.capitalUsd;
    // Read since() even when off, so turning it on later starts from that moment.
    const since = this.since();
    if (!(capital > 0)) return null;
    const equity = capital + this.trades.closedSince(since).pnl;
    const inUse = this.trades
      .listByStatusSync(["OPENING", "OPEN"])
      .reduce((sum, t) => sum + (t.entryPrice && t.leverage > 0 ? (Number(t.entryPrice) * Number(t.quantity)) / t.leverage : 0), 0);
    return { capital, equity, inUse, available: Math.max(0, equity - inUse), since };
  }

  /** The balance to size with: the real one, or the simulated one when it is lower. */
  available(real: number): number {
    const s = this.status();
    return s ? Math.min(real, s.available) : real;
  }
}
