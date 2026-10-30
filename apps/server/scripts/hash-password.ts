/**
 * The two .env lines for the web login (ADMIN_PASSWORD_HASH, SESSION_SECRET):
 *
 *   npm run hash-password                 print them, to paste into .env yourself
 *   npm run hash-password -- --write      write them into the .env the bot uses (no pasting)
 *
 * Type the password when asked (it is not shown). Never send the password or the hash to anyone.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { hashPassword } from "../src/api/auth.js";
import { findEnvFile } from "../src/config/env.js";

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY ?? false });
  const muted = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let prompted = false;
  muted._writeToOutput = (s: string) => {
    // Show the question once, hide every keystroke after it.
    if (!prompted) {
      process.stdout.write(s);
      prompted = true;
    }
  };
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    }),
  );
}

const password = await ask("Mật khẩu đăng nhập web: ");
if (password.length < 10) {
  console.error("Mật khẩu cần ít nhất 10 ký tự.");
  process.exit(1);
}
if (process.stdin.isTTY && (await ask("Nhập lại: ")) !== password) {
  console.error("Hai lần nhập không khớp.");
  process.exit(1);
}

const lines: Record<string, string> = {
  ADMIN_PASSWORD_HASH: await hashPassword(password),
  SESSION_SECRET: randomBytes(32).toString("base64url"),
};

if (process.argv.includes("--write")) {
  const file = process.env.ENV_FILE ?? findEnvFile();
  if (!file) {
    console.error("Không tìm thấy .env (chạy cp .env.example .env trước).");
    process.exit(1);
  }
  let text = readFileSync(file, "utf8");
  for (const [key, value] of Object.entries(lines)) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    // A replacer function, so "$" in the value is never read as a replacement pattern.
    text = pattern.test(text) ? text.replace(pattern, () => `${key}=${value}`) : `${text.replace(/\n?$/, "\n")}${key}=${value}\n`;
  }
  writeFileSync(file, text);
  console.log(`\nĐã ghi ADMIN_PASSWORD_HASH và SESSION_SECRET vào ${file}. Khởi động lại bot để dùng mật khẩu mới.`);
} else {
  console.log("\nThêm (hoặc thay) hai dòng này trong .env, rồi khởi động lại bot:\n");
  for (const [key, value] of Object.entries(lines)) console.log(`${key}=${value}`);
}
