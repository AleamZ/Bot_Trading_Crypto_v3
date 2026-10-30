import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseUserEvent, UserStream, type SocketLike, type UserStreamEvent } from "../src/binance/userStream.js";

describe("parseUserEvent", () => {
  it("parses order, algo, account and expiry events", () => {
    expect(
      parseUserEvent({
        e: "ORDER_TRADE_UPDATE",
        E: 10,
        o: { s: "BTCUSDT", c: "v3e-t1", S: "BUY", o: "MARKET", X: "FILLED", x: "TRADE", L: "68000", l: "0.0057", rp: "0" },
      }),
    ).toEqual({
      type: "ORDER_UPDATE",
      symbol: "BTCUSDT",
      clientOrderId: "v3e-t1",
      side: "BUY",
      orderType: "MARKET",
      status: "FILLED",
      executionType: "TRADE",
      lastPrice: "68000",
      lastQty: "0.0057",
      realizedPnl: "0",
      time: 10,
    });
    expect(parseUserEvent({ e: "ALGO_UPDATE", E: 11, o: { caid: "v3s-t1-1", s: "BTCUSDT", X: "TRIGGERED" } })).toEqual({
      type: "ALGO_UPDATE",
      symbol: "BTCUSDT",
      clientAlgoId: "v3s-t1-1",
      status: "TRIGGERED",
      time: 11,
    });
    expect(parseUserEvent({ e: "ACCOUNT_UPDATE", E: 12, a: { m: "ORDER", P: [{ s: "BTCUSDT", pa: "0", ep: "0" }] } })).toEqual({
      type: "ACCOUNT_UPDATE",
      reason: "ORDER",
      positions: [{ symbol: "BTCUSDT", amount: "0", entryPrice: "0" }],
      time: 12,
    });
    expect(parseUserEvent({ e: "listenKeyExpired", E: 13 })).toEqual({ type: "LISTEN_KEY_EXPIRED", time: 13 });
    expect(parseUserEvent({ e: "MARGIN_CALL" })).toBeNull();
    expect(parseUserEvent("nope")).toBeNull();
  });
});

class FakeSocket extends EventEmitter implements SocketLike {
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  close() {
    this.closed = true;
  }
}

describe("UserStream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const sockets: FakeSocket[] = [];
    const events: UserStreamEvent[] = [];
    const statuses: boolean[] = [];
    let keys = 0;
    const keepAlive = vi.fn(async () => {});
    const stream = new UserStream({
      wsBaseUrl: "wss://demo-fstream.binance.com/ws/",
      createListenKey: async () => `key${++keys}`,
      keepAliveListenKey: keepAlive,
      onEvent: (e) => events.push(e),
      onStatus: (connected) => statuses.push(connected),
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      keepAliveMs: 1000,
    });
    return { stream, sockets, events, statuses, keepAlive };
  }

  it("connects with the listen key, forwards events and keeps the key alive", async () => {
    const { stream, sockets, events, statuses, keepAlive } = setup();
    stream.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.url).toBe("wss://demo-fstream.binance.com/ws/key1");
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", JSON.stringify({ e: "ALGO_UPDATE", E: 1, o: { caid: "v3t-x-1", s: "BTCUSDT", X: "FINISHED" } }));
    expect(events).toEqual([{ type: "ALGO_UPDATE", symbol: "BTCUSDT", clientAlgoId: "v3t-x-1", status: "FINISHED", time: 1 }]);
    expect(statuses).toEqual([true]);
    await vi.advanceTimersByTimeAsync(2500);
    expect(keepAlive).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("reconnects with a new key after the socket drops or the key expires", async () => {
    const { stream, sockets, statuses } = setup();
    stream.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.emit("open");
    sockets[0]!.emit("close");
    expect(statuses).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets[1]!.url).toBe("wss://demo-fstream.binance.com/ws/key2");
    sockets[1]!.emit("open");
    sockets[1]!.emit("message", JSON.stringify({ e: "listenKeyExpired", E: 2 }));
    expect(sockets[1]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets[2]!.url).toBe("wss://demo-fstream.binance.com/ws/key3");
    stream.stop();
  });

  it("stops reconnecting once stopped", async () => {
    const { stream, sockets } = setup();
    stream.start();
    await vi.advanceTimersByTimeAsync(0);
    stream.stop();
    sockets[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
  });
});
