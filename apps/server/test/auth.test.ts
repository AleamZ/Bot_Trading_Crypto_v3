import { describe, expect, it } from "vitest";
import { hashPassword, isPasswordHash, LoginLimiter, parseCookies, safeEqual, SessionSigner, sessionCookie, verifyPassword } from "../src/api/auth.js";

const FAST = { N: 1024, r: 8, p: 1 };

describe("password hash", () => {
  it("verifies the right password only, with a salt per hash", async () => {
    const hash = await hashPassword("correct horse battery", FAST);
    expect(hash).toMatch(/^scrypt:1024:8:1:[\w-]+:[\w-]+$/);
    expect(hash).not.toContain("$");
    expect(isPasswordHash(hash)).toBe(true);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
    expect(await hashPassword("correct horse battery", FAST)).not.toBe(hash);
  });

  it("rejects malformed hashes instead of throwing", async () => {
    for (const bad of ["", "plain-password", "scrypt:1000:8:1:abc:def", "bcrypt:1024:8:1:YWJjZGVmZ2g:YWJj"]) {
      expect(isPasswordHash(bad)).toBe(false);
      expect(await verifyPassword("x", bad)).toBe(false);
    }
  });

  it("compares usernames without leaking length", () => {
    expect(safeEqual("admin", "admin")).toBe(true);
    expect(safeEqual("admin", "admin2")).toBe(false);
  });
});

describe("SessionSigner", () => {
  it("signs, verifies, expires and refuses tampering", () => {
    let now = 1_000;
    const signer = new SessionSigner("secret", "hash-1", 60_000, () => now);
    const { token, expiresAt } = signer.sign("admin");
    expect(signer.verify(token)).toEqual({ username: "admin", expiresAt });
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "root", e: expiresAt })).toString("base64url");
    expect(signer.verify(`${forged}.${mac}`)).toBeNull();
    const flipped = (mac![0] === "A" ? "B" : "A") + mac!.slice(1);
    expect(signer.verify(`${payload}.${flipped}`)).toBeNull();
    expect(signer.verify(undefined)).toBeNull();
    expect(signer.verify("garbage")).toBeNull();
    // A new password hash in .env logs everyone out.
    expect(new SessionSigner("secret", "hash-2", 60_000, () => now).verify(token)).toBeNull();
    now += 60_001;
    expect(signer.verify(token)).toBeNull();
  });
});

describe("LoginLimiter", () => {
  it("blocks an IP after 5 failures for the rest of the window", () => {
    let now = 0;
    const limiter = new LoginLimiter(5, 30, 60_000, () => now);
    for (let i = 0; i < 5; i++) {
      expect(limiter.retryAfter("1.1.1.1")).toBe(0);
      limiter.fail("1.1.1.1");
      now += 1000;
    }
    expect(limiter.retryAfter("1.1.1.1")).toBe(55_000);
    expect(limiter.retryAfter("2.2.2.2")).toBe(0);
    now += 55_000;
    expect(limiter.retryAfter("1.1.1.1")).toBe(0);
  });

  it("blocks everyone after too many failures in total", () => {
    const limiter = new LoginLimiter(5, 3, 60_000, () => 0);
    ["a", "b", "c"].forEach((ip) => limiter.fail(ip));
    expect(limiter.retryAfter("d")).toBe(60_000);
  });
});

describe("cookies", () => {
  it("parses and writes the session cookie", () => {
    expect(parseCookies("a=1; bot3_session=x.y%3D; b")).toEqual({ a: "1", bot3_session: "x.y=" });
    expect(sessionCookie("s", "v", 60, true)).toBe("s=v; Path=/; Max-Age=60; HttpOnly; SameSite=Strict; Secure");
    expect(sessionCookie("s", "v", 60, false)).not.toContain("Secure");
  });
});
