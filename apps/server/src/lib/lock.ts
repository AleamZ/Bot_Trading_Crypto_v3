import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * One bot per database: a second copy would trade the same account twice. Takes `file` (holding
 * this pid) or throws if a live process holds it; a lock left by a crashed process is taken over.
 * Returns the release function.
 */
export function acquireLock(file: string): () => void {
  // A fresh install has no data/ folder yet; the database would create it a moment later.
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
        throw new Error(`Một bot khác (pid ${pid}) đang chạy với cùng database (${file}). Dừng nó trước.`);
      }
      unlinkSync(file);
    }
  }
  throw new Error(`Không lấy được ${file}`);
}
