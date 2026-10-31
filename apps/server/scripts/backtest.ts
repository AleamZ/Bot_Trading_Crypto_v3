/**
 * Replays the bot's rules over past candles and prints the results per symbol.
 *
 *   npm run backtest                                   last 90 days, default settings, DEMO candles
 *   npm run backtest -- --days 180 --symbols BTCUSDT,ETHUSDT
 *   npm run backtest -- --db                           use the settings saved by the bot (DB_PATH)
 *   npm run backtest -- --source binance               real Binance futures candles instead of DEMO
 *   npm run backtest -- --slippage 0.0002 --csv trades.csv
 *   npm run backtest -- --set risk.maxSlAtr=5 --set risk.slPolicy=MEDIAN   try other settings
 *   npm run backtest -- --compare risk.moveSl=false   run again on the same candles with one change
 *   npm run backtest -- --sweep risk.rr=1,1.5,2 --sweep risk.moveSl=true,false   every combination, same candles
 *
 * Read-only: only public market data endpoints are called.
 */
import { writeFileSync } from "node:fs";
import {
  defaultSettings,
  mergeSettings,
  runBacktest,
  signalSequence,
  summarize,
  TIMEFRAME_MINUTES,
  type BacktestSummary,
  type BacktestSymbol,
  type BacktestTrade,
  type MethodId,
  type Settings,
} from "@bot-v3/core";
import { candleLimits } from "../src/app/scanner.js";
import { BinanceFutures } from "../src/binance/futures.js";
import { BinanceRest } from "../src/binance/rest.js";
import { loadEnv } from "../src/config/env.js";
import { openDatabase } from "../src/db/database.js";
import { KeyValueStore } from "../src/db/stores.js";
import { createLogger } from "../src/lib/logger.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const env = loadEnv();
let settings: Settings = defaultSettings();
if (flag("db")) {
  const db = openDatabase(env.dbPath);
  const stored = new KeyValueStore(db).get<unknown>("settings", null);
  db.close();
  const merged = stored ? mergeSettings(defaultSettings(), stored) : null;
  if (merged && !merged.ok) throw new Error(`Cài đặt trong ${env.dbPath} không hợp lệ: ${JSON.stringify(merged.errors)}`);
  if (merged?.ok) settings = merged.settings;
  console.log(`Cài đặt lấy từ ${env.dbPath}${stored ? "" : " (chưa lưu gì, dùng mặc định)"}`);
}
const symbolsArg = option("symbols");
if (symbolsArg) {
  const merged = mergeSettings(settings, { general: { watchlist: symbolsArg.split(",").map((s) => s.trim().toUpperCase()) } });
  if (!merged.ok) throw new Error(JSON.stringify(merged.errors));
  settings = merged.settings;
}
/** Applies "section.key=value" to the settings, without saving it anywhere. */
function withSetting(base: Settings, assignment: string, flagName: string): Settings {
  const [path, raw = ""] = assignment.split("=");
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // plain text (enum values)
  }
  const patch = path!.split(".").reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
  const merged = mergeSettings(base, patch);
  if (!merged.ok) throw new Error(`--${flagName} ${assignment}: ${merged.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  return merged.settings;
}
// --set section.key=value (repeatable): try a setting.
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--set" && args[i + 1]) settings = withSetting(settings, args[i + 1]!, "set");
}
// --compare section.key=value (repeatable): a second run on the same candles with these changes.
let compared: Settings | null = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--compare" && args[i + 1]) compared = withSetting(compared ?? settings, args[i + 1]!, "compare");
}
const days = Number(option("days") ?? 90);
const slippage = Number(option("slippage") ?? 0);
const source = option("source") ?? "demo";
const restUrl = source === "binance" ? "https://fapi.binance.com" : env.binanceRestUrl;

const rest = new BinanceRest({ baseUrl: restUrl, logger: createLogger("warn", "backtest") });
const api = new BinanceFutures(rest);
await rest.syncTime();
const exchange = await api.getExchangeSymbols();

const { entryTf, trendTf } = settings.general;
const entryMs = TIMEFRAME_MINUTES[entryTf] * 60_000;
const trendMs = TIMEFRAME_MINUTES[trendTf] * 60_000;
const end = Math.floor(Date.now() / entryMs) * entryMs - 1;
const from = end + 1 - days * 86_400_000;
const limits = candleLimits(settings);

console.log(`Backtest ${days} ngày tới ${new Date(end + 1).toISOString().slice(0, 16)}Z · nến ${restUrl} · ${entryTf}/${trendTf}`);
console.log(`1R = ${settings.risk.riskUsd}$ · RR ${settings.risk.rr} · SL ${settings.risk.slPolicy}/${settings.risk.slMode} · phí ${settings.risk.includeFees ? `${settings.risk.feeRatePct}%` : "không tính"} · trượt giá ${slippage * 100}%`);

const data: BacktestSymbol[] = [];
for (const symbol of settings.general.watchlist) {
  const info = exchange.get(symbol);
  if (!info) {
    console.log(`  bỏ qua ${symbol}: không có trên ${restUrl}`);
    continue;
  }
  process.stdout.write(`  tải ${symbol}… `);
  const entry = await api.getCandlesBetween(symbol, entryTf, from - limits.entry * entryMs, end);
  const trend = trendTf === entryTf ? entry : await api.getCandlesBetween(symbol, trendTf, from - limits.trend * trendMs, end);
  console.log(`${entry.length} nến ${entryTf}, ${trend.length} nến ${trendTf}`);
  data.push({ symbol, market: { entry, trend }, filters: info.filters });
}

const result = runBacktest(data, { settings, from, slippage });

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const num = (x: number, d = 2) => (x >= 0 ? `+${x.toFixed(d)}` : `${x.toFixed(d)}`);
const row = (name: string, s: BacktestSummary) =>
  [
    name.padEnd(10),
    String(s.trades).padStart(6),
    pct(s.winRate).padStart(6),
    num(s.totalR).padStart(9),
    num(s.avgR, 3).padStart(8),
    (s.profitFactor === null ? "—" : s.profitFactor.toFixed(2)).padStart(6),
    s.maxDrawdownR.toFixed(2).padStart(7),
    num(s.netPnl).padStart(10),
    String(s.ambiguous).padStart(5),
  ].join(" ");

const header = (first: string) =>
  `${first.padEnd(10)} ${"Lệnh".padStart(6)} ${"Thắng".padStart(6)} ${"Tổng R".padStart(9)} ${"TB R".padStart(8)} ${"PF".padStart(6)} ${"DD R".padStart(7)} ${"Ròng $".padStart(10)} ${"Mơ hồ".padStart(5)}`;
console.log(`\n${header("Symbol")}`);
for (const [symbol, summary] of Object.entries(result.bySymbol)) console.log(row(symbol, summary));
console.log(row("TỔNG", result.total));

const LETTER: Record<MethodId, string> = { trendPullback: "A", donchianBreakout: "B", smcSweep: "C" };
const letters = (key: string) => key.split("+").map((m) => LETTER[m as MethodId]).join("+");
// "A=B": both fired on the same candle (likely one move); "A→B": A first, B later.
const sequence = (t: BacktestTrade) => signalSequence(t.signalTimes).map((group) => group.map((m) => LETTER[m]).join("=")).join("→");
const closed = result.trades.filter((t) => t.exitReason !== "OPEN");
if (closed.length) {
  console.log(`\n${header("Đồng thuận")}`);
  for (const [key, summary] of Object.entries(result.byMethods)) console.log(row(letters(key), summary));
  console.log(`\n${header("Thứ tự")}`);
  const bySequence = new Map<string, BacktestTrade[]>();
  for (const t of closed) bySequence.set(sequence(t), [...(bySequence.get(sequence(t)) ?? []), t]);
  for (const key of [...bySequence.keys()].sort()) console.log(row(key, summarize(bySequence.get(key)!)));
  console.log("Thứ tự: A=B là hai phương pháp kích hoạt cùng một nến, A→B là A trước, B ở nến sau.");
}
const { alertThreshold, autoEntryThreshold } = settings.general;
const readyLabel = alertThreshold < autoEntryThreshold ? `Báo SẴN SÀNG (${alertThreshold}/3): ${result.readyAlerts} lần · ` : "";
console.log(`\n${readyLabel}Đủ ${autoEntryThreshold}/3: ${result.enterSignals} lần · vào lệnh: ${result.trades.length}`);
const skipped = Object.entries(result.skipped);
if (skipped.length) console.log(`${autoEntryThreshold}/3 không vào được: ${skipped.map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (settings.risk.moveSl) {
  const stopped = (stage: number) => closed.filter((t) => t.exitReason === "SL" && t.stopStage === stage).length;
  const { breakEvenAtTpPct, lockAtTpPct, lockSlAtTpPct } = settings.risk;
  console.log(`Dời SL (về giá vào ở ${breakEvenAtTpPct}%, lên ${lockSlAtTpPct}% ở ${lockAtTpPct}% đường tới TP): chạm SL hoà vốn ${stopped(1)} lệnh, chạm SL khoá lãi ${stopped(2)} lệnh`);
}
if (compared) {
  const other = runBacktest(data, { settings: compared, from, slippage });
  const changes = args.flatMap((a, i) => (a === "--compare" && args[i + 1] ? [args[i + 1]] : [])).join(", ");
  console.log(`\n${header("So sánh")}`);
  console.log(row("hiện tại", result.total));
  console.log(row("thay đổi", other.total));
  console.log(`"thay đổi" = cùng nến, thêm ${changes}`);
}
// --sweep section.key=v1,v2 (repeatable): every combination of the values, on the same candles.
const sweeps = args.flatMap((a, i) => (a === "--sweep" && args[i + 1] ? [args[i + 1]!] : [])).map((s) => {
  const [path, values = ""] = s.split("=");
  if (/^general\.(entryTf|trendTf|watchlist)$/.test(path!)) throw new Error(`--sweep ${path}: cần tải nến khác, dùng --set cho từng lần chạy`);
  return values.split(",").map((v) => `${path}=${v}`);
});
if (sweeps.length) {
  const combos = sweeps.reduce<string[][]>((acc, list) => acc.flatMap((combo) => list.map((v) => [...combo, v])), [[]]);
  // --min-win 0.97: also the share of trades that won at least that much.
  const minWin = Number(option("min-win") ?? Number.NaN);
  const minLabel = Number.isFinite(minWin) ? `≥${minWin}R` : "";
  console.log(`\nQuét ${combos.length} tổ hợp trên cùng nến (Thắng* = bỏ lệnh hoà vốn, tức chạm SL đã dời về giá vào${minLabel ? `; ${minLabel} = lệnh thắng ít nhất ${minWin}R` : ""})`);
  console.log(
    `${"Tổ hợp".padEnd(48)} ${"Lệnh".padStart(5)} ${"Thắng".padStart(6)} ${"Thắng*".padStart(6)}${minLabel ? ` ${minLabel.padStart(7)}` : ""} ${"Tổng R".padStart(8)} ${"TB R".padStart(7)} ${"PF".padStart(5)} ${"DD R".padStart(6)}`,
  );
  for (const combo of combos) {
    const variant = combo.reduce((s, assignment) => withSetting(s, assignment, "sweep"), settings);
    const run = runBacktest(data, { settings: variant, from, slippage });
    const done = run.trades.filter((t) => t.exitReason !== "OPEN");
    const breakEven = done.filter((t) => t.exitReason === "SL" && t.stopStage === 1).length;
    const s = run.total;
    const decided = s.trades - breakEven;
    console.log(
      [
        combo.map((c) => c.replace(/^[a-zA-Z]+\./, "")).join(" ").padEnd(48),
        String(s.trades).padStart(5),
        pct(s.winRate).padStart(6),
        (decided ? pct(s.wins / decided) : "—").padStart(6),
        ...(minLabel ? [(s.trades ? pct(done.filter((t) => t.r >= minWin).length / s.trades) : "—").padStart(7)] : []),
        num(s.totalR).padStart(8),
        num(s.avgR, 3).padStart(7),
        (s.profitFactor === null ? "—" : s.profitFactor.toFixed(2)).padStart(5),
        s.maxDrawdownR.toFixed(1).padStart(6),
      ].join(" "),
    );
  }
}
const open = result.trades.filter((t) => t.exitReason === "OPEN").length;
if (open) console.log(`${open} lệnh còn mở ở cuối giai đoạn (không tính vào kết quả)`);
console.log("Mơ hồ = nến chạm cả SL lẫn TP, tính là thua. DD R = mức sụt giảm lớn nhất tính theo R.");

const csv = option("csv");
if (csv) {
  const columns = "symbol,direction,methods,sequence,stopStage,entryTime,entry,quantity,stopLoss,takeProfit,exitTime,exit,exitReason,netPnl,r,ambiguous,bars";
  const lines = result.trades.map((t) =>
    [
      t.symbol,
      t.direction,
      t.methods.join("+"),
      sequence(t),
      t.stopStage,
      new Date(t.entryTime + 1).toISOString(),
      t.entry,
      t.quantity,
      t.stopLoss,
      t.takeProfit,
      t.exitTime ? new Date(t.exitTime + 1).toISOString() : "",
      t.exit ?? "",
      t.exitReason,
      t.netPnl.toFixed(4),
      t.r.toFixed(4),
      t.ambiguous,
      t.bars,
    ].join(","),
  );
  writeFileSync(csv, [columns, ...lines].join("\n") + "\n");
  console.log(`Đã ghi ${result.trades.length} lệnh vào ${csv}`);
}
