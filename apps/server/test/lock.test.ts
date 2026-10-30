import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireLock } from "../src/lib/lock.js";

const dir = mkdtempSync(path.join(tmpdir(), "bot-v3-lock-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("acquireLock", () => {
  it("creates the missing data folder on a fresh install, writes its pid and removes the file on release", () => {
    const file = path.join(dir, "fresh", "data", "bot.db.lock");
    const release = acquireLock(file);
    expect(readFileSync(file, "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(file)).toBe(false);
  });

  it("refuses while another live process holds the lock", () => {
    const file = path.join(dir, "busy.lock");
    writeFileSync(file, String(process.ppid));
    expect(() => acquireLock(file)).toThrow(`pid ${process.ppid}`);
  });

  it("takes over a lock left by a process that is gone", () => {
    const file = path.join(dir, "stale.lock");
    writeFileSync(file, "999999");
    const release = acquireLock(file);
    expect(readFileSync(file, "utf8")).toBe(String(process.pid));
    release();
  });
});
