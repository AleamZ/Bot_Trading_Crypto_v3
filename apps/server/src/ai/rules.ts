import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILES = ["STRATEGIES.md", "EXECUTION.md"];
let cached: string | null = null;

/** The repository's docs folder, looked for upwards from this file (works from src/ and dist/). */
function docsDir(start = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = start;
  for (let depth = 0; depth < 7; depth++) {
    const candidate = path.join(dir, "docs");
    if (existsSync(path.join(candidate, "STRATEGIES.md"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The trading rules the chat can quote: docs/STRATEGIES.md and docs/EXECUTION.md. */
export function readRules(): string {
  if (cached !== null) return cached;
  const dir = docsDir();
  if (!dir) return "Không tìm thấy thư mục docs/ của bot.";
  cached = FILES.map((name) => {
    try {
      return readFileSync(path.join(dir, name), "utf8");
    } catch {
      return "";
    }
  })
    .filter(Boolean)
    .join("\n\n---\n\n");
  return cached;
}
