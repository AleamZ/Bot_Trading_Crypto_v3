import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Admin login: one user from .env (ADMIN_USERNAME + ADMIN_PASSWORD_HASH). The hash is scrypt in the
 * form "scrypt:N:r:p:salt:key" (base64url, no "$" so .env files and shells leave it alone).
 */

const scryptAsync = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key))));

const DEFAULT_COST = { N: 16_384, r: 8, p: 1 };

export async function hashPassword(password: string, cost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize("NFKC"), salt, 64, { ...cost, maxmem: 256 * cost.N * cost.r });
  return ["scrypt", cost.N, cost.r, cost.p, salt.toString("base64url"), key.toString("base64url")].join(":");
}

export function isPasswordHash(value: string): boolean {
  return parseHash(value) !== null;
}

function parseHash(value: string) {
  const parts = value.trim().split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const valid = Number.isInteger(N) && N >= 1024 && N <= 1_048_576 && (N & (N - 1)) === 0 && Number.isInteger(r) && r >= 1 && r <= 32 && Number.isInteger(p) && p >= 1 && p <= 16;
  if (!valid) return null;
  const salt = Buffer.from(parts[4]!, "base64url");
  const key = Buffer.from(parts[5]!, "base64url");
  if (salt.length < 8 || key.length < 32) return null;
  return { N, r, p, salt, key };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const { N, r, p, salt, key } = parsed;
  const actual = await scryptAsync(password.normalize("NFKC"), salt, key.length, { N, r, p, maxmem: 256 * N * r });
  return timingSafeEqual(actual, key);
}

export function safeEqual(a: string, b: string): boolean {
  const x = createHmac("sha256", "compare").update(a).digest();
  const y = createHmac("sha256", "compare").update(b).digest();
  return timingSafeEqual(x, y);
}

export interface Session {
  username: string;
  expiresAt: number;
}

/**
 * Stateless session tokens: base64url(JSON) + "." + HMAC. The key includes the password hash, so
 * changing the password in .env logs every session out.
 */
export class SessionSigner {
  private readonly key: Buffer;

  constructor(
    secret: string,
    passwordHash: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.key = createHmac("sha256", secret).update(passwordHash).digest();
  }

  sign(username: string): { token: string; expiresAt: number } {
    const expiresAt = this.now() + this.ttlMs;
    const payload = Buffer.from(JSON.stringify({ u: username, e: expiresAt })).toString("base64url");
    return { token: `${payload}.${this.mac(payload)}`, expiresAt };
  }

  verify(token: string | undefined): Session | null {
    if (!token) return null;
    const [payload, mac] = token.split(".");
    if (!payload || !mac) return null;
    const expected = Buffer.from(this.mac(payload));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: unknown; e?: unknown };
      if (typeof data.u !== "string" || typeof data.e !== "number" || data.e <= this.now()) return null;
      return { username: data.u, expiresAt: data.e };
    } catch {
      return null;
    }
  }

  private mac(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }
}

/** Failed logins per IP and in total over a sliding window. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  private all: number[] = [];

  constructor(
    private readonly maxPerIp = 5,
    private readonly maxTotal = 30,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until this IP may try again, or 0. */
  retryAfter(ip: string): number {
    const now = this.now();
    const mine = this.recent(this.failures.get(ip) ?? [], now);
    this.all = this.recent(this.all, now);
    const waits: number[] = [];
    if (mine.length >= this.maxPerIp) waits.push(mine[0]! + this.windowMs - now);
    if (this.all.length >= this.maxTotal) waits.push(this.all[0]! + this.windowMs - now);
    return waits.length ? Math.max(...waits) : 0;
  }

  fail(ip: string): void {
    const now = this.now();
    this.failures.set(ip, [...this.recent(this.failures.get(ip) ?? [], now), now]);
    this.all.push(now);
  }

  succeed(ip: string): void {
    this.failures.delete(ip);
  }

  private recent(times: number[], now: number): number[] {
    return times.filter((t) => now - t < this.windowMs);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function sessionCookie(name: string, token: string, maxAgeSec: number, secure: boolean): string {
  return [`${name}=${encodeURIComponent(token)}`, "Path=/", `Max-Age=${maxAgeSec}`, "HttpOnly", "SameSite=Strict", secure ? "Secure" : ""].filter(Boolean).join("; ");
}

export function clearedCookie(name: string, secure: boolean): string {
  return sessionCookie(name, "", 0, secure);
}
