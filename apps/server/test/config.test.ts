import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findEnvFile, parseEnv } from "../src/config/env.js";
import { toExchangeSymbol } from "../src/binance/exchangeInfo.js";

describe("parseEnv", () => {
  it("has safe defaults", () => {
    const env = parseEnv({});
    expect(env).toMatchObject({
      BINANCE_ENV: "demo",
      TRADING_ENABLED: false,
      PORT: 8787,
      HOST: "127.0.0.1",
      binanceRestUrl: "https://demo-fapi.binance.com",
      binanceWsUrl: "wss://demo-fstream.binance.com/ws",
      hasBinanceKeys: false,
    });
  });

  it('reads booleans as text: "false" stays false', () => {
    expect(parseEnv({ TRADING_ENABLED: "false" }).TRADING_ENABLED).toBe(false);
    expect(parseEnv({ TRADING_ENABLED: "FALSE " }).TRADING_ENABLED).toBe(false);
    expect(parseEnv({ TRADING_ENABLED: "true" }).TRADING_ENABLED).toBe(true);
    expect(parseEnv({ TRADING_ENABLED: "" }).TRADING_ENABLED).toBe(false);
    expect(() => parseEnv({ TRADING_ENABLED: "yes" })).toThrow(/TRADING_ENABLED/);
    expect(() => parseEnv({ TRADING_ENABLED: "1" })).toThrow(/TRADING_ENABLED/);
  });

  it("refuses anything but the demo environment", () => {
    expect(() => parseEnv({ BINANCE_ENV: "live" })).toThrow(/demo/);
  });

  it("detects the Binance keys and URL overrides", () => {
    const env = parseEnv({ BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s", BINANCE_WS_URL: "wss://demo-fstream.binance.com/private/ws" });
    expect(env.hasBinanceKeys).toBe(true);
    expect(env.binanceWsUrl).toBe("wss://demo-fstream.binance.com/private/ws");
    expect(parseEnv({ BINANCE_API_KEY: "k", BINANCE_API_SECRET: "  " }).hasBinanceKeys).toBe(false);
  });

  it("finds the repo-root .env from apps/server", () => {
    const root = mkdtempSync(path.join(tmpdir(), "botv3-"));
    const server = path.join(root, "apps", "server");
    mkdirSync(server, { recursive: true });
    writeFileSync(path.join(root, ".env"), "PORT=9000\n");
    expect(findEnvFile(server)).toBe(path.join(root, ".env"));
  });
});

describe("toExchangeSymbol", () => {
  it("maps the real DEMO BTCUSDT filters", () => {
    const raw = {
      symbol: "BTCUSDT",
      status: "TRADING",
      contractType: "PERPETUAL",
      filters: [
        { filterType: "PRICE_FILTER", minPrice: "261.10", tickSize: "0.10", maxPrice: "809484" },
        { minQty: "0.0001", stepSize: "0.0001", filterType: "LOT_SIZE", maxQty: "1000" },
        { minQty: "0.0001", maxQty: "120", stepSize: "0.0001", filterType: "MARKET_LOT_SIZE" },
        { filterType: "MAX_NUM_ORDERS" },
        { filterType: "MIN_NOTIONAL", notional: "50" },
      ],
    };
    expect(toExchangeSymbol(raw).filters).toEqual({
      symbol: "BTCUSDT",
      tickSize: "0.10",
      stepSize: "0.0001",
      minQty: "0.0001",
      maxQty: "120",
      minNotional: "50",
    });
  });

  it("uses the stricter of LOT_SIZE and MARKET_LOT_SIZE", () => {
    const raw = {
      symbol: "XUSDT",
      status: "TRADING",
      contractType: "PERPETUAL",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.0001" },
        { filterType: "LOT_SIZE", stepSize: "0.1", minQty: "0.1", maxQty: "100000" },
        { filterType: "MARKET_LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "5000" },
      ],
    };
    expect(toExchangeSymbol(raw).filters).toMatchObject({ stepSize: "1", minQty: "1", maxQty: "5000", minNotional: null });
  });
});
