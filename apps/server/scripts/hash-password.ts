/**
 * Prints the two .env lines for the web login:
 *
 *   npm run hash-password -w @bot-v3/server
 *
 * Type the password when asked (it is not shown). Paste the output into .env yourself; never send
 * the password or the hash to anyone.
 */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { hashPassword } from "../src/api/auth.js";

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

console.log("\nThêm (hoặc thay) hai dòng này trong .env, rồi khởi động lại bot:\n");
console.log(`ADMIN_PASSWORD_HASH=${await hashPassword(password)}`);
console.log(`SESSION_SECRET=${randomBytes(32).toString("base64url")}`);
