import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply, FastifyRequest } from "fastify";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Same-origin only; inline styles are allowed because React sets style attributes. */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** apps/web/dist, looked for upwards from this file (works from src/ with tsx and from dist/). */
export function findWebDir(start = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = start;
  for (let depth = 0; depth < 6; depth++) {
    for (const candidate of [path.join(dir, "web", "dist"), path.join(dir, "apps", "web", "dist")]) {
      if (existsSync(path.join(candidate, "index.html"))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Serves the built UI for GET requests no API route matched. Vite puts content-hashed files under
 * assets/, so those are cached for a year; index.html is never cached, so a deploy shows up at once.
 * Returns false when there is nothing to serve.
 */
export async function serveWeb(root: string, request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(request.url.split("?")[0]!);
  } catch {
    return false;
  }
  if (pathname.startsWith("/api/") || pathname.startsWith("/health")) return false;
  const base = path.resolve(root);
  let file = path.resolve(base, `.${path.posix.normalize(pathname)}`);
  if (file !== base && !file.startsWith(base + path.sep)) return false;
  // The UI routes with #hash, but any extension-less path still gets the app.
  if (file === base || !path.extname(file)) file = path.join(base, "index.html");
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return false;
  }
  const ext = path.extname(file).toLowerCase();
  reply.header("content-type", TYPES[ext] ?? "application/octet-stream");
  reply.header("x-content-type-options", "nosniff");
  if (ext === ".html") {
    reply.header("cache-control", "no-cache");
    reply.header("content-security-policy", CSP);
    reply.header("referrer-policy", "same-origin");
  } else {
    reply.header("cache-control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "public, max-age=3600");
  }
  await reply.status(200).send(body);
  return true;
}
