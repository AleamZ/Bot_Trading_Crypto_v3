import { describe, expect, it } from "vitest";
import { sampleTrade } from "./fixtures.js";
import { LONG3, runtimeHarness } from "./runtimeHarness.js";

describe("simulated capital", () => {
  it("is off at 0: the real balance is used as is", () => {
    const h = runtimeHarness();
    expect(h.runtime.capital.status()).toBeNull();
    expect(h.runtime.capital.available(10_000)).toBe(10_000);
  });

  it("adds the net result of trades closed since it was set and takes off the margin of open ones", async () => {
    const h = runtimeHarness();
    h.runtime.settings.update({ risk: { capitalUsd: 100 } });
    expect(h.runtime.capital.status()).toMatchObject({ capital: 100, equity: 100, inUse: 0, available: 100 });

    h.exchange.clock += 60_000;
    const at = h.exchange.clock;
    await h.runtime.trades.insert(sampleTrade({ id: "lost", status: "CLOSED", createdAt: at, openedAt: at, closedAt: at + 1, exitReason: "SL", pnlR: -1, netPnl: "-5" }));
    // 68000 × 0.005 / 10x = 34$ of margin.
    await h.runtime.trades.insert(sampleTrade({ id: "open", status: "OPEN", createdAt: at, openedAt: at }));
    expect(h.runtime.capital.status()).toMatchObject({ equity: 95, inUse: 34, available: 61 });
    expect(h.runtime.capital.available(10_000)).toBe(61);
    // A real balance below the simulated one wins.
    expect(h.runtime.capital.available(20)).toBe(20);
  });

  it("starts over when the amount changes or the P&L figures are cleared", async () => {
    const h = runtimeHarness();
    h.runtime.settings.update({ risk: { capitalUsd: 100 } });
    h.runtime.capital.status();
    h.exchange.clock += 60_000;
    const at = h.exchange.clock;
    await h.runtime.trades.insert(sampleTrade({ id: "lost", status: "CLOSED", createdAt: at, openedAt: at, closedAt: at + 1, exitReason: "SL", pnlR: -1, netPnl: "-5" }));
    expect(h.runtime.capital.status()?.equity).toBe(95);

    h.exchange.clock += 60_000;
    h.runtime.resetStats("test");
    expect(h.runtime.capital.status()?.equity).toBe(100);

    h.runtime.restoreStats("test");
    expect(h.runtime.capital.status()?.equity).toBe(95);
    h.exchange.clock += 60_000;
    h.runtime.settings.update({ risk: { capitalUsd: 200 } });
    expect(h.runtime.capital.status()).toMatchObject({ capital: 200, equity: 200 });
  });

  it("keeps the bot from entering when the simulated account cannot carry the margin", async () => {
    const h = runtimeHarness();
    h.runtime.settings.update({ risk: { capitalUsd: 1 } });
    const outcome = await h.runtime.executor.enter({ symbol: "BTCUSDT", direction: "LONG", signals: LONG3, atr: 400, settings: h.runtime.settings.get() });
    expect(outcome).toMatchObject({ ok: false, stage: "PLAN", reason: "INSUFFICIENT_MARGIN" });
    expect(!outcome.ok && outcome.detail).toContain("với số dư 1.00$");
    expect(h.runtime.trades.listByStatusSync(["OPEN"])).toHaveLength(0);
    // The status the dashboard reads carries it too.
    expect(h.runtime.status().capital).toMatchObject({ capital: 1, available: 1 });
  });
});
