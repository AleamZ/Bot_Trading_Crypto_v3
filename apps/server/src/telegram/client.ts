/** Minimal Telegram Bot API client over fetch. The token never appears in errors or logs. */

export class TelegramError extends Error {
  constructor(
    message: string,
    /** HTTP status, 0 when the request never got an answer. */
    readonly status: number,
    /** Seconds Telegram asks to wait (429), or null. */
    readonly retryAfterSec: number | null,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  /** Unix seconds. */
  date: number;
  chat: TelegramChat;
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Per request, except long polls which wait their own timeout plus 10s. */
  timeoutMs?: number;
}

export const TELEGRAM_TEXT_LIMIT = 4096;

export class TelegramClient {
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly token: string,
    options: TelegramClientOptions = {},
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async call<T>(method: string, params: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });
    } catch (error) {
      const name = (error as Error).name;
      const reason = name === "TimeoutError" ? "hết thời gian chờ" : name === "AbortError" ? "đã huỷ" : (error as Error).message;
      throw new TelegramError(`Telegram ${method}: ${reason}`, 0, null);
    }
    const body = (await response.json().catch(() => null)) as
      | { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }
      | null;
    if (!response.ok || !body?.ok) {
      throw new TelegramError(
        `Telegram ${method} ${response.status}: ${body?.description ?? "phản hồi không hợp lệ"}`,
        response.status,
        body?.parameters?.retry_after ?? null,
      );
    }
    return body.result as T;
  }

  sendMessage(chatId: string, html: string): Promise<TelegramMessage> {
    const text = html.length > TELEGRAM_TEXT_LIMIT ? `${html.slice(0, TELEGRAM_TEXT_LIMIT - 20)}\n…(đã cắt bớt)` : html;
    return this.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }

  /** Long poll: waits up to `timeoutSec` for new messages. */
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call(
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message"] },
      { ...(signal ? { signal } : {}), timeoutMs: (timeoutSec + 10) * 1000 },
    );
  }

  getMe(): Promise<{ id: number; username: string }> {
    return this.call("getMe", {});
  }

  setMyCommands(commands: { command: string; description: string }[]): Promise<boolean> {
    return this.call("setMyCommands", { commands });
  }
}
