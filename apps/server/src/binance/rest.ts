import { createHmac } from "node:crypto";
import { silentLogger, type Logger } from "../lib/logger.js";
import { BinanceError, classifyResponse, ERROR_CODES, networkError } from "./errors.js";

export type Params = Record<string, string | number | boolean | undefined>;
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RestOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  apiSecret?: string | undefined;
  recvWindow?: number;
  timeoutMs?: number;
  /** Extra attempts for retryable failures. */
  maxRetries?: number;
  /** Resynchronize the clock with Binance this often. */
  timeSyncIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export interface RequestOptions {
  signed?: boolean;
  /**
   * True for reads and other requests that can safely run twice: retried on UNKNOWN too.
   * False for order placement: only retried when Binance says nothing was executed.
   */
  idempotent?: boolean;
}

export function sign(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

/**
 * Low-level USDⓈ-M Futures REST client: HMAC signing, server time offset, retries with backoff,
 * and the used request weight. Every parameter goes in the query string, which Binance accepts for
 * all methods.
 */
export class BinanceRest {
  private readonly opts: Required<Omit<RestOptions, "apiKey" | "apiSecret">> & Pick<RestOptions, "apiKey" | "apiSecret">;
  private offsetMs = 0;
  private lastSyncAt = Number.NEGATIVE_INFINITY;
  private syncing: Promise<void> | null = null;
  /** Last X-MBX-USED-WEIGHT-1M value seen. */
  usedWeight = 0;

  constructor(options: RestOptions) {
    this.opts = {
      recvWindow: 5000,
      timeoutMs: 10_000,
      maxRetries: 3,
      timeSyncIntervalMs: 30 * 60_000,
      fetchImpl: (...args) => fetch(...args),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      logger: silentLogger,
      ...options,
    };
  }

  get hasKeys(): boolean {
    return Boolean(this.opts.apiKey && this.opts.apiSecret);
  }

  get apiKey(): string | undefined {
    return this.opts.apiKey;
  }

  /** Local clock plus the measured offset to Binance's clock. */
  serverNow(): number {
    return Math.round(this.opts.now() + this.offsetMs);
  }

  get clockOffsetMs(): number {
    return this.offsetMs;
  }

  async syncTime(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const before = this.opts.now();
      const { serverTime } = await this.request<{ serverTime: number }>("GET", "/fapi/v1/time", {}, { idempotent: true });
      const after = this.opts.now();
      this.offsetMs = serverTime - (before + after) / 2;
      this.lastSyncAt = after;
      this.opts.logger.debug("Binance clock synced", { offsetMs: Math.round(this.offsetMs) });
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  get<T>(path: string, params: Params = {}, signed = false): Promise<T> {
    return this.request<T>("GET", path, params, { signed, idempotent: true });
  }

  async request<T>(method: HttpMethod, path: string, params: Params = {}, options: RequestOptions = {}): Promise<T> {
    const { signed = false, idempotent = method === "GET" } = options;
    let resynced = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send<T>(method, path, params, signed);
      } catch (error) {
        const err = error instanceof BinanceError ? error : networkError(error);
        // A timestamp rejection is never executed: fix the clock and try once more.
        if (signed && err.code === ERROR_CODES.TIMESTAMP_OUTSIDE_RECV_WINDOW && !resynced) {
          resynced = true;
          await this.syncTime();
          continue;
        }
        const retryable = err.safeToRetry || (idempotent && err.kind === "UNKNOWN");
        if (!retryable || attempt >= this.opts.maxRetries) throw err;
        const delay = err.retryAfterMs ?? Math.min(8000, 250 * 2 ** attempt);
        this.opts.logger.warn("Binance request retry", { method, path, attempt: attempt + 1, delay, error: err.message });
        await this.opts.sleep(delay);
      }
    }
  }

  private async send<T>(method: HttpMethod, path: string, params: Params, signed: boolean): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers["X-MBX-APIKEY"] = this.opts.apiKey;
    if (signed) {
      if (!this.opts.apiKey || !this.opts.apiSecret) {
        throw new BinanceError({ kind: "REJECTED", status: 0, code: null, message: "Thiếu BINANCE_API_KEY hoặc BINANCE_API_SECRET trong .env" });
      }
      if (this.opts.now() - this.lastSyncAt > this.opts.timeSyncIntervalMs) await this.syncTime();
      query.set("timestamp", String(this.serverNow()));
      query.set("recvWindow", String(this.opts.recvWindow));
      query.set("signature", sign(query.toString(), this.opts.apiSecret));
    }
    const qs = query.toString();
    const url = `${this.opts.baseUrl}${path}${qs ? `?${qs}` : ""}`;

    let response: Response;
    try {
      response = await this.opts.fetchImpl(url, { method, headers, signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (error) {
      throw networkError(error);
    }
    const weight = Number(response.headers.get("x-mbx-used-weight-1m"));
    if (Number.isFinite(weight) && weight > 0) this.usedWeight = weight;

    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Keep the raw text (HTML error pages from proxies).
    }
    if (!response.ok) throw classifyResponse(response.status, body, response.headers.get("retry-after"));
    return body as T;
  }
}
