/**
 * Checks the bot against Binance DEMO.
 *
 *   npm run smoke:demo -w @bot-v3/server                      read-only: clock, filters, candles, account
 *   npm run smoke:demo -w @bot-v3/server -- --trade --symbol ETHUSDT --risk 1 --yes-demo
 *       places ONE real DEMO trade through the executor (SL ~1% away), shows the SL/TP, then closes it.
 *
 * Never run --trade on a symbol another bot is trading on the same account (One-way mode merges positions).
 */
import { defaultSettings, mergeSettings, type Direction, type MethodSignal } from "@bot-v3/core";
import { BinanceFutures } from "../src/binance/futures.js";
import { BinanceRest } from "../src/binance/rest.js";
import { UserStream } from "../src/binance/userStream.js";
import { loadEnv } from "../src/config/env.js";
import { Executor } from "../src/engine/executor.js";
import { flatten } from "../src/engine/protection.js";
import { KeyedLock, MemoryTradeStore, sleep } from "../src/engine/support.js";
import { createLogger } from "../src/lib/logger.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

const env = loadEnv();
const logger = createLogger("warn", "smoke");
const rest = new BinanceRest({ baseUrl: env.binanceRestUrl, apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET, logger });
const api = new BinanceFutures(rest);
const ok = (label: string, value: unknown = "") => console.log(`  ✓ ${label}`, value);

console.log(`Binance ${env.BINANCE_ENV}: ${env.binanceRestUrl} | ${env.binanceWsUrl}`);

console.log("\n[1] Public endpoints");
await rest.syncTime();
ok("clock offset (ms)", Math.round(rest.clockOffsetMs));
const symbols = await api.getExchangeSymbols();
ok("exchangeInfo symbols", symbols.size);
for (const symbol of defaultSettings().general.watchlist) {
  const info = symbols.get(symbol);
  ok(symbol, info ? `${info.status} ${JSON.stringify(info.filters)}` : "KHÔNG CÓ");
}
const candles = await api.getClosedCandles("BTCUSDT", "15m", 3);
ok("last closed 15m BTCUSDT", candles.map((c) => `${new Date(c.closeTime + 1).toISOString().slice(11, 16)} ${c.close}`).join(", "));
ok("mark BTCUSDT", await api.getMarkPrice("BTCUSDT"));

if (!env.hasBinanceKeys) {
  console.log("\nChưa có BINANCE_API_KEY / BINANCE_API_SECRET trong .env: bỏ qua phần tài khoản.");
  process.exit(0);
}

console.log("\n[2] Account (signed)");
const hedge = await api.isHedgeMode();
ok("position mode", hedge ? "HEDGE (bot sẽ từ chối vào lệnh)" : "One-way");
ok("available USDT", await api.getAvailableBalance());
const positions = (await api.getPositions()).filter((p) => Number(p.positionAmt) !== 0);
ok("open positions", positions.map((p) => `${p.symbol} ${p.positionAmt}`).join(", ") || "none");
ok("open orders", (await api.getOpenOrders()).length);
const algos = await api.getOpenAlgoOrders();
ok("open algo orders", algos.map((a) => `${a.symbol} ${a.orderType} ${a.clientAlgoId}`).join(", ") || "none");
ok("BTCUSDT max leverage", (await api.getLeverageBrackets("BTCUSDT"))[0]?.initialLeverage);

console.log("\n[3] User data stream");
await new Promise<void>((resolve) => {
  const stream = new UserStream({
    wsBaseUrl: env.binanceWsUrl,
    createListenKey: () => api.createListenKey(),
    keepAliveListenKey: () => api.keepAliveListenKey(),
    onEvent: (event) => ok("event", event.type),
    onStatus: (connected, detail) => {
      ok(connected ? "WebSocket connected" : `WebSocket not connected: ${detail}`);
      stream.stop();
      resolve();
    },
  });
  stream.start();
  setTimeout(() => {
    console.log("  ✗ WebSocket: no answer within 10s");
    stream.stop();
    resolve();
  }, 10_000).unref();
});

if (!flag("trade")) process.exit(0);
if (!flag("yes-demo")) {
  console.log("\n--trade cần thêm --yes-demo để xác nhận đặt lệnh thật trên DEMO.");
  process.exit(1);
}

const symbol = option("symbol", "ETHUSDT");
const direction = option("side", "LONG").toUpperCase() as Direction;
const risk = Number(option("risk", "1"));
console.log(`\n[4] DEMO round trip: ${direction} ${symbol}, 1R = ${risk}$`);
const merged = mergeSettings(defaultSettings(), { risk: { riskUsd: risk } });
if (!merged.ok) throw new Error(JSON.stringify(merged.errors));
const mark = await api.getMarkPrice(symbol);
const stop = direction === "LONG" ? mark * 0.99 : mark * 1.01;
const signal: MethodSignal = { method: "smcSweep", direction, index: 0, time: Date.now(), price: mark, stopLoss: stop, reason: "smoke test", levels: {} };
const store = new MemoryTradeStore();
const executor = new Executor({
  api,
  store,
  locks: new KeyedLock(),
  logger: createLogger("info", "smoke"),
  events: { emit: (event) => ok("event", `${event.type}${"detail" in event ? `: ${event.detail}` : ""}`) },
});
const outcome = await executor.enter({ symbol, direction, signals: [signal], atr: mark * 0.005, settings: merged.settings });
if (!outcome.ok) {
  console.log("  ✗ entry", outcome.stage, outcome.reason, outcome.detail);
  process.exit(1);
}
const t = outcome.trade;
ok("filled", `${t.quantity} @ ${t.entryPrice}, SL ${t.stopLoss} (${t.riskAtStopUsd}$), TP ${t.takeProfit}`);
ok("algo orders on exchange", (await api.getOpenAlgoOrders(symbol)).map((a) => `${a.orderType} ${a.quantity} @ ${a.triggerPrice}`).join(" | "));
await sleep(3000);
const closed = await flatten(api, symbol, t.id);
ok("closed", closed.flat ? "flat" : `NOT FLAT: ${closed.detail}`);
process.exit(closed.flat ? 0 : 1);
