import { describe, expect, it } from "vitest";
import { BinanceError, classifyResponse } from "../src/binance/errors.js";
import { BinanceRest, sign } from "../src/binance/rest.js";

type Reply = { status: number; body: unknown; headers?: Record<string, string> } | Error;

function fakeFetch(replies: Reply[], serverTime = 1_000_000 + 5_000) {
  const calls: { url: URL; method: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.pathname === "/fapi/v1/time") return new Response(JSON.stringify({ serverTime }), { status: 200 });
    const reply = replies.shift();
    if (!reply) throw new Error("no reply queued");
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers ?? {} });
  }) as typeof fetch;
  return { calls, impl };
}

function client(replies: Reply[]) {
  const sleeps: number[] = [];
  const f = fakeFetch(replies);
  const rest = new BinanceRest({
    baseUrl: "https://demo-fapi.binance.com",
    apiKey: "key",
    apiSecret: "secret",
    fetchImpl: f.impl,
    now: () => 1_000_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const apiCalls = () => f.calls.filter((c) => c.url.pathname !== "/fapi/v1/time");
  return { rest, calls: f.calls, apiCalls, sleeps };
}

describe("sign", () => {
  it("matches Binance's documented HMAC-SHA256 example", () => {
    const query = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
    expect(sign(query, "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j")).toBe(
      "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71",
    );
  });
});

describe("BinanceRest", () => {
  it("signs with Binance's clock and sends the API key", async () => {
    const { rest, apiCalls } = client([{ status: 200, body: { ok: true }, headers: { "x-mbx-used-weight-1m": "42" } }]);
    await rest.get("/fapi/v2/balance", {}, true);
    const call = apiCalls()[0]!;
    expect(call.headers["X-MBX-APIKEY"]).toBe("key");
    expect(call.url.searchParams.get("timestamp")).toBe("1005000");
    expect(call.url.searchParams.get("recvWindow")).toBe("5000");
    const unsigned = call.url.search.slice(1).replace(/&signature=[0-9a-f]+$/, "");
    expect(call.url.searchParams.get("signature")).toBe(sign(unsigned, "secret"));
    expect(rest.clockOffsetMs).toBe(5000);
    expect(rest.usedWeight).toBe(42);
  });

  it("retries a read when Binance is unavailable", async () => {
    const { rest, apiCalls, sleeps } = client([
      { status: 503, body: { code: -1, msg: "Service Unavailable." } },
      { status: 200, body: [1] },
    ]);
    expect(await rest.get("/fapi/v1/klines")).toEqual([1]);
    expect(apiCalls()).toHaveLength(2);
    expect(sleeps).toEqual([250]);
  });

  it("retries a read after a network error", async () => {
    const { rest, apiCalls } = client([new TypeError("fetch failed"), { status: 200, body: { a: 1 } }]);
    expect(await rest.get("/fapi/v1/premiumIndex")).toEqual({ a: 1 });
    expect(apiCalls()).toHaveLength(2);
  });

  it("never retries an order whose outcome is unknown", async () => {
    const { rest, apiCalls } = client([{ status: 500, body: { code: -1000, msg: "Unknown error, please check your request or try again later." } }]);
    const error = await rest.request("POST", "/fapi/v1/order", { symbol: "BTCUSDT" }, { signed: true, idempotent: false }).catch((e) => e);
    expect(error).toBeInstanceOf(BinanceError);
    expect(error).toMatchObject({ kind: "UNKNOWN", code: -1000 });
    expect(apiCalls()).toHaveLength(1);
  });

  it("never retries an order after a network error either", async () => {
    const { rest, apiCalls } = client([new TypeError("socket hang up")]);
    const error = await rest.request("POST", "/fapi/v1/order", {}, { signed: true, idempotent: false }).catch((e) => e);
    expect(error).toMatchObject({ kind: "UNKNOWN" });
    expect(apiCalls()).toHaveLength(1);
  });

  it("retries an order Binance throttled, after Retry-After", async () => {
    const { rest, apiCalls, sleeps } = client([
      { status: 429, body: { code: -1003, msg: "Too many requests" }, headers: { "retry-after": "2" } },
      { status: 200, body: { orderId: 1 } },
    ]);
    expect(await rest.request("POST", "/fapi/v1/order", {}, { signed: true, idempotent: false })).toEqual({ orderId: 1 });
    expect(apiCalls()).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("resynchronizes the clock once on -1021 and retries", async () => {
    const { rest, calls, apiCalls } = client([
      { status: 400, body: { code: -1021, msg: "Timestamp for this request is outside of the recvWindow." } },
      { status: 200, body: { ok: 1 } },
    ]);
    expect(await rest.request("POST", "/fapi/v1/order", {}, { signed: true, idempotent: false })).toEqual({ ok: 1 });
    expect(apiCalls()).toHaveLength(2);
    expect(calls.filter((c) => c.url.pathname === "/fapi/v1/time")).toHaveLength(2);
  });

  it("does not retry a plain rejection", async () => {
    const { rest, apiCalls } = client([{ status: 400, body: { code: -2021, msg: "Order would immediately trigger." } }]);
    const error = await rest.request("POST", "/fapi/v1/algoOrder", {}, { signed: true, idempotent: false }).catch((e) => e);
    expect(error).toMatchObject({ kind: "REJECTED", code: -2021, status: 400 });
    expect(apiCalls()).toHaveLength(1);
  });

  it("refuses signed calls without keys and without calling Binance", async () => {
    const f = fakeFetch([]);
    const rest = new BinanceRest({ baseUrl: "https://x", fetchImpl: f.impl });
    await expect(rest.get("/fapi/v2/balance", {}, true)).rejects.toThrow(/BINANCE_API_KEY/);
    expect(f.calls).toHaveLength(0);
  });
});

describe("classifyResponse", () => {
  it("separates what may have executed from what did not", () => {
    expect(classifyResponse(400, { code: -2019, msg: "Margin is insufficient." }, null)).toMatchObject({ kind: "REJECTED", safeToRetry: false });
    expect(classifyResponse(503, { code: -1, msg: "Service Unavailable." }, null)).toMatchObject({ kind: "UNAVAILABLE", safeToRetry: true });
    expect(classifyResponse(503, { code: -1008, msg: "Request throttled by system-level protection." }, null)).toMatchObject({ kind: "UNAVAILABLE" });
    expect(classifyResponse(502, "<html>Bad gateway</html>", null)).toMatchObject({ kind: "UNKNOWN", code: null });
    expect(classifyResponse(418, { code: -1003, msg: "banned" }, "120")).toMatchObject({ kind: "RATE_LIMIT", retryAfterMs: 120_000 });
  });
});
