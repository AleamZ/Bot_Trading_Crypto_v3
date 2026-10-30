import WebSocket from "ws";
import { silentLogger, type Logger } from "../lib/logger.js";

export type UserStreamEvent =
  | {
      type: "ORDER_UPDATE";
      symbol: string;
      clientOrderId: string;
      side: string;
      orderType: string;
      status: string;
      executionType: string;
      lastPrice: string;
      lastQty: string;
      realizedPnl: string;
      time: number;
    }
  | { type: "ALGO_UPDATE"; symbol: string; clientAlgoId: string; status: string; time: number }
  | { type: "ACCOUNT_UPDATE"; reason: string; positions: { symbol: string; amount: string; entryPrice: string }[]; time: number }
  | { type: "LISTEN_KEY_EXPIRED"; time: number };

type Json = Record<string, unknown>;
const str = (value: unknown) => (value === undefined || value === null ? "" : String(value));

/** Turns a raw user-data message into a typed event, or null for events the bot does not use. */
export function parseUserEvent(raw: unknown): UserStreamEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Json;
  const time = Number(msg.E ?? msg.T ?? Date.now());
  switch (msg.e) {
    case "ORDER_TRADE_UPDATE": {
      const o = (msg.o ?? {}) as Json;
      return {
        type: "ORDER_UPDATE",
        symbol: str(o.s),
        clientOrderId: str(o.c),
        side: str(o.S),
        orderType: str(o.o),
        status: str(o.X),
        executionType: str(o.x),
        lastPrice: str(o.L),
        lastQty: str(o.l),
        realizedPnl: str(o.rp),
        time,
      };
    }
    case "ALGO_UPDATE": {
      const o = (msg.o ?? {}) as Json;
      return { type: "ALGO_UPDATE", symbol: str(o.s), clientAlgoId: str(o.caid), status: str(o.X), time };
    }
    case "ACCOUNT_UPDATE": {
      const a = (msg.a ?? {}) as Json;
      const rows = Array.isArray(a.P) ? (a.P as Json[]) : [];
      return {
        type: "ACCOUNT_UPDATE",
        reason: str(a.m),
        positions: rows.map((p) => ({ symbol: str(p.s), amount: str(p.pa), entryPrice: str(p.ep) })),
        time,
      };
    }
    case "listenKeyExpired":
      return { type: "LISTEN_KEY_EXPIRED", time };
    default:
      return null;
  }
}

export interface SocketLike {
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  close(): void;
}

export interface UserStreamOptions {
  wsBaseUrl: string;
  createListenKey: () => Promise<string>;
  keepAliveListenKey: () => Promise<void>;
  onEvent: (event: UserStreamEvent) => void;
  onStatus?: (connected: boolean, detail?: string) => void;
  createSocket?: (url: string) => SocketLike;
  logger?: Logger;
  keepAliveMs?: number;
  /** Binance closes connections after 24h; reconnect a little earlier. */
  rotateMs?: number;
  maxBackoffMs?: number;
}

/**
 * Account events over WebSocket (fills, algo order updates, positions). It only speeds things up:
 * the watchdog also polls REST, so a dropped stream never loses an exit.
 */
export class UserStream {
  private socket: SocketLike | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private rotate: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = true;
  private readonly logger: Logger;

  constructor(private readonly options: UserStreamOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  get connected(): boolean {
    return this.socket !== null && this.failures === 0;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let listenKey: string;
    try {
      listenKey = await this.options.createListenKey();
    } catch (error) {
      this.scheduleReconnect(`Không tạo được listenKey: ${(error as Error).message}`);
      return;
    }
    if (this.stopped) return;
    const create = this.options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    const socket = create(`${this.options.wsBaseUrl.replace(/\/$/, "")}/${listenKey}`);
    this.socket = socket;
    let closed = false;
    const onGone = (detail: string) => {
      if (closed) return;
      closed = true;
      if (this.socket === socket) this.teardown();
      this.scheduleReconnect(detail);
    };

    socket.on("open", () => {
      this.failures = 0;
      this.options.onStatus?.(true);
      this.logger.info("User stream connected");
      this.keepAlive = setInterval(() => {
        this.options.keepAliveListenKey().catch((error) => this.logger.warn("listenKey keepalive failed", { error: (error as Error).message }));
      }, this.options.keepAliveMs ?? 30 * 60_000);
      this.rotate = setTimeout(() => onGone("Kết nối lại định kỳ"), this.options.rotateMs ?? 23 * 60 * 60_000);
    });
    socket.on("message", (data) => {
      let event: UserStreamEvent | null = null;
      try {
        event = parseUserEvent(JSON.parse(String(data)));
      } catch {
        return;
      }
      if (!event) return;
      if (event.type === "LISTEN_KEY_EXPIRED") {
        onGone("listenKey hết hạn");
        return;
      }
      this.options.onEvent(event);
    });
    socket.on("close", () => onGone("WebSocket đóng"));
    socket.on("error", (error) => onGone(`WebSocket lỗi: ${error.message}`));
  }

  private teardown(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.rotate) clearTimeout(this.rotate);
    this.keepAlive = null;
    this.rotate = null;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
  }

  private scheduleReconnect(detail: string): void {
    if (this.stopped) return;
    this.failures++;
    this.options.onStatus?.(false, detail);
    const delay = Math.min(this.options.maxBackoffMs ?? 60_000, 1000 * 2 ** Math.min(this.failures - 1, 6));
    this.logger.warn("User stream reconnecting", { detail, delay });
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, delay);
  }
}
