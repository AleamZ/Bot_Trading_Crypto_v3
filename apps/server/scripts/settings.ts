/**
 * Reads or changes the settings the bot keeps in its database (DB_PATH from .env).
 *
 *   npm run settings                                   show the main settings
 *   npm run settings -- apply config/presets/x.json    merge a preset (stop the bot first)
 *
 * A preset is a partial settings object, like a PUT /api/settings body: keys it leaves out keep
 * their current value. Nothing is saved when the result is invalid.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { entryRuleText, METHOD_IDS, METHOD_LETTERS, type Settings } from "@bot-v3/core";
import { SettingsService } from "../src/app/control.js";
import { loadEnv } from "../src/config/env.js";
import { openDatabase } from "../src/db/database.js";
import { KeyValueStore } from "../src/db/stores.js";
import { acquireLock } from "../src/lib/lock.js";

const [command = "show", file] = process.argv.slice(2);
const env = loadEnv();

function summary(s: Settings): string[] {
  const g = s.general;
  const r = s.risk;
  const on = METHOD_IDS.filter((id) => s.methods[id].enabled).map((id) => METHOD_LETTERS[id]);
  return [
    `Khung: ${g.entryTf} (xu hướng ${g.trendTf}) · hiệu lực tín hiệu ${g.signalTtlBars} nến`,
    `Phương pháp bật: ${on.join(", ")} · báo khi ${g.alertThreshold} cùng chiều · vào lệnh khi ${entryRuleText(g)}`,
    `1R = ${r.riskUsd}$ · RR ${r.rr} · SL tối đa ${r.maxSlAtr} ATR / ${r.maxSlPct}% · dời SL ${r.moveSl ? "bật" : "tắt"} · tối đa ${r.maxOpenPositions} vị thế, ${r.maxTradesPerDay} lệnh/ngày, lỗ ${r.maxDailyLossR}R/ngày`,
    `${g.watchlist.length} symbol: ${g.watchlist.join(", ")}`,
  ];
}

if (command === "show") {
  const db = openDatabase(env.dbPath);
  const service = new SettingsService(new KeyValueStore(db));
  console.log(`Cài đặt trong ${env.dbPath}${service.loadErrors.length ? " (không hợp lệ, bot đang dùng mặc định)" : ""}:`);
  for (const line of summary(service.get())) console.log(`  ${line}`);
  db.close();
} else if (command === "apply" && file) {
  const patch = JSON.parse(readFileSync(path.resolve(process.env.INIT_CWD ?? process.cwd(), file), "utf8")) as unknown;
  // The running bot keeps its settings in memory and would overwrite these: it must be stopped.
  const release = acquireLock(`${env.dbPath}.lock`);
  try {
    const db = openDatabase(env.dbPath);
    const service = new SettingsService(new KeyValueStore(db));
    const result = service.update(patch);
    db.close();
    if (!result.ok) {
      console.error("Preset không hợp lệ, không lưu gì:");
      for (const e of result.errors) console.error(`  ${e.path}: ${e.message}`);
      process.exitCode = 1;
    } else {
      console.log(result.changed.length ? `Đã lưu vào ${env.dbPath}, đổi: ${result.changed.join(", ")}` : "Không có gì thay đổi.");
      for (const line of summary(result.settings)) console.log(`  ${line}`);
      console.log("Chạy lại bot để dùng cài đặt mới.");
    }
  } finally {
    release();
  }
} else {
  console.error("Dùng: npm run settings  |  npm run settings -- apply <file.json>");
  process.exitCode = 1;
}
