/**
 * How sure we are about what happened to a request:
 * - REJECTED:    Binance answered with an error; nothing was executed.
 * - UNAVAILABLE: Binance says it did not process the request (503 "Service Unavailable", -1008); safe to retry.
 * - RATE_LIMIT:  429/418; nothing executed; back off before retrying.
 * - UNKNOWN:     timeout, network error or 5xx "unknown error": the request MAY have been executed.
 *                For orders, look the order up before deciding (Binance's own guidance).
 */
export type BinanceErrorKind = "REJECTED" | "UNAVAILABLE" | "RATE_LIMIT" | "UNKNOWN";

export class BinanceError extends Error {
  readonly kind: BinanceErrorKind;
  readonly status: number;
  readonly code: number | null;
  readonly retryAfterMs: number | null;

  constructor(init: { kind: BinanceErrorKind; status: number; code: number | null; message: string; retryAfterMs?: number | null }) {
    super(init.message);
    this.name = "BinanceError";
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.retryAfterMs = init.retryAfterMs ?? null;
  }

  /** Nothing was executed and trying again later may work. */
  get safeToRetry(): boolean {
    return this.kind === "UNAVAILABLE" || this.kind === "RATE_LIMIT";
  }
}

export const ERROR_CODES = {
  TIMESTAMP_OUTSIDE_RECV_WINDOW: -1021,
  THROTTLED: -1008,
  UNKNOWN_ORDER_SENT: -2011,
  NO_SUCH_ORDER: -2013,
  WOULD_IMMEDIATELY_TRIGGER: -2021,
  REDUCE_ONLY_REJECTED: -2022,
  /** A post-only order that would have taken liquidity. */
  POST_ONLY_REJECTED: -5022,
  NO_NEED_TO_CHANGE_MARGIN_TYPE: -4046,
} as const;

export function classifyResponse(status: number, body: unknown, retryAfterHeader: string | null): BinanceError {
  const payload = typeof body === "object" && body !== null ? (body as { code?: unknown; msg?: unknown }) : {};
  const code = typeof payload.code === "number" ? payload.code : null;
  const msg = typeof payload.msg === "string" ? payload.msg : typeof body === "string" ? body.slice(0, 300) : "";
  const message = `Binance ${status}${code !== null ? ` (${code})` : ""}: ${msg || "không có nội dung"}`;
  if (status === 429 || status === 418) {
    const seconds = Number(retryAfterHeader);
    return new BinanceError({ kind: "RATE_LIMIT", status, code, message, retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : null });
  }
  if (code === ERROR_CODES.THROTTLED || (status === 503 && /service unavailable/i.test(msg))) {
    return new BinanceError({ kind: "UNAVAILABLE", status, code, message });
  }
  if (status >= 500) return new BinanceError({ kind: "UNKNOWN", status, code, message });
  return new BinanceError({ kind: "REJECTED", status, code, message });
}

export function networkError(error: unknown): BinanceError {
  const message = error instanceof Error ? error.message : String(error);
  return new BinanceError({ kind: "UNKNOWN", status: 0, code: null, message: `Không gọi được Binance: ${message}` });
}

export function isBinanceError(error: unknown, code?: number): error is BinanceError {
  return error instanceof BinanceError && (code === undefined || error.code === code);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
