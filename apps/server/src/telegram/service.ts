import type { Settings } from "@bot-v3/core";
import type { AppEvent, EventHub } from "../app/events.js";
import type { KeyValueStore } from "../db/stores.js";
import { sleep as realSleep } from "../engine/support.js";
import { silentLogger, type Logger } from "../lib/logger.js";
import { TelegramError, type TelegramClient, type TelegramUpdate } from "./client.js";
import { BOT_COMMANDS, escapeHtml, formatEvent, HELP_TEXT } from "./format.js";

const OFFSET_KEY = "telegram.offset";
const CANDIDATES_KEY = "telegram.candidates";
/** Commands older than this (sent while the bot was down) are ignored. */
const MAX_COMMAND_AGE_MS = 120_000;
/** The same error text is sent at most once per window. */
const DEDUPE_MS = 30 * 60_000;
const DEDUPED: ReadonlySet<AppEvent["type"]> = new Set(["ERROR", "SCAN_FAILED", "EXCHANGE_STATUS", "ENTRY_FAILED"]);

export interface TelegramCommands {
  status(): Promise<string>;
  positions(): Promise<string>;
  today(): Promise<string>;
  /** Return false when nothing changed (already paused / already running). */
  pause(by: string): boolean;
  resume(by: string): boolean;
}

export interface ChatCandidate {
  chatId: string;
  name: string;
  type: string;
  lastSeenAt: number;
}

export interface TelegramServiceDeps {
  client: TelegramClient;
  /** TELEGRAM_CHAT_ID; null until the user puts it in .env. */
  chatId: string | null;
  kv: KeyValueStore;
  hub: EventHub;
  settings: () => Settings;
  commands: TelegramCommands;
  todayLine?: () => string;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Long-poll timeout in seconds (default 25). */
  pollTimeoutSec?: number;
}

export interface TelegramStatus {
  configured: true;
  chatIdSet: boolean;
  polling: boolean;
  queued: number;
  lastSentAt: number | null;
  lastError: string | null;
}

/**
 * Sends the notifications (one queue, in order, honouring 429 retry_after) and answers commands
 * from the configured chat only. Without TELEGRAM_CHAT_ID it tells whoever writes to the bot their
 * chat id, so the user can put it in .env; nothing is ever read from the chat into the settings.
 */
export class TelegramService {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly queue: string[] = [];
  private readonly recent = new Map<string, number>();
  private draining: Promise<void> | null = null;
  private polling: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private stopped = true;
  private unsubscribe: (() => void) | null = null;
  private startedAt = 0;
  private lastSentAt: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: TelegramServiceDeps) {
    this.logger = deps.logger ?? silentLogger;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? realSleep;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.startedAt = this.now();
    this.unsubscribe = this.deps.hub.onEvent((event) => this.notify(event));
    this.deps.client.setMyCommands(BOT_COMMANDS).catch((error) => this.logger.warn("Telegram setMyCommands failed", { error: String(error) }));
    this.polling = this.pollLoop();
  }

  /** Stops polling and gives queued messages a few seconds to go out. */
  async stop(graceMs = 5000): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.abort?.abort();
    await Promise.race([Promise.allSettled([this.draining, this.polling]), this.sleep(graceMs)]);
  }

  status(): TelegramStatus {
    return {
      configured: true,
      chatIdSet: this.deps.chatId !== null,
      polling: !this.stopped,
      queued: this.queue.length,
      lastSentAt: this.lastSentAt,
      lastError: this.lastError,
    };
  }

  candidates(): ChatCandidate[] {
    return this.deps.kv.get<ChatCandidate[]>(CANDIDATES_KEY, []);
  }

  /** Sends right away (not queued) so the caller learns whether it worked. */
  async sendTest(): Promise<void> {
    if (!this.deps.chatId) throw new TelegramError("Chưa có TELEGRAM_CHAT_ID trong .env", 0, null);
    await this.deps.client.sendMessage(this.deps.chatId, "🔔 Tin nhắn thử từ bot v3. Telegram đã hoạt động.");
    this.lastSentAt = this.now();
  }

  /** Formats and queues the event if the settings ask for it. */
  notify(event: AppEvent): void {
    if (!this.deps.chatId) return;
    const text = formatEvent(event, { settings: this.deps.settings(), ...(this.deps.todayLine ? { todayLine: this.deps.todayLine } : {}) });
    if (!text) return;
    if (DEDUPED.has(event.type)) {
      const now = this.now();
      const seen = this.recent.get(text);
      if (seen !== undefined && now - seen < DEDUPE_MS) return;
      this.recent.set(text, now);
      for (const [key, at] of this.recent) if (now - at >= DEDUPE_MS) this.recent.delete(key);
    }
    this.enqueue(text);
  }

  private enqueue(text: string): void {
    this.queue.push(text);
    if (!this.draining) this.draining = this.drain().finally(() => (this.draining = null));
  }

  private async drain(): Promise<void> {
    const chatId = this.deps.chatId!;
    while (this.queue.length > 0) {
      const text = this.queue[0]!;
      for (let attempt = 0; ; attempt++) {
        try {
          await this.deps.client.sendMessage(chatId, text);
          this.lastSentAt = this.now();
          this.lastError = null;
          break;
        } catch (error) {
          const e = error as TelegramError;
          this.lastError = e.message;
          if (e.retryAfterSec !== null && e.retryAfterSec !== undefined && attempt < 5) {
            await this.sleep((e.retryAfterSec + 1) * 1000);
            continue;
          }
          // 4xx other than 429 will not get better by retrying (bad chat id, blocked bot, bad HTML).
          const permanent = e.status >= 400 && e.status < 500;
          if (permanent || attempt >= 2) {
            this.logger.error("Telegram message dropped", { error: e.message });
            break;
          }
          await this.sleep(2000 * (attempt + 1));
        }
      }
      this.queue.shift();
      if (this.queue.length > 0) await this.sleep(1000);
    }
  }

  private async pollLoop(): Promise<void> {
    let offset = this.deps.kv.get<number>(OFFSET_KEY, 0);
    let backoff = 1000;
    let conflictReported = false;
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const updates = await this.deps.client.getUpdates(offset, this.deps.pollTimeoutSec ?? 25, this.abort.signal);
        backoff = 1000;
        conflictReported = false;
        for (const update of updates) {
          offset = update.update_id + 1;
          this.deps.kv.set(OFFSET_KEY, offset);
          await this.handle(update).catch((error) => this.logger.error("Telegram command failed", { error: String(error) }));
        }
      } catch (error) {
        if (this.stopped) break;
        const e = error as TelegramError;
        if (e.status === 409) {
          // Another process (a local copy of the bot?) polls the same token.
          if (!conflictReported) this.logger.error("Telegram: another process is polling this bot token", { error: e.message });
          conflictReported = true;
          await this.sleep(30_000);
        } else if (e.status === 401 || e.status === 404) {
          this.logger.error("Telegram token rejected; check TELEGRAM_BOT_TOKEN", { error: e.message });
          this.lastError = e.message;
          await this.sleep(300_000);
        } else {
          this.logger.warn("Telegram poll failed", { error: e.message, retryInMs: backoff });
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    }
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.text) return;
    const chatId = String(message.chat.id);
    if (!this.deps.chatId) {
      this.rememberCandidate(message.chat, message.date * 1000);
      await this.deps.client.sendMessage(
        chatId,
        `Chat id của bạn là <code>${escapeHtml(chatId)}</code>.\nThêm dòng <code>TELEGRAM_CHAT_ID=${escapeHtml(chatId)}</code> vào file .env rồi khởi động lại bot.`,
      );
      return;
    }
    if (chatId !== this.deps.chatId) return; // not ours: stay silent
    if (message.date * 1000 < Math.max(this.startedAt, this.now()) - MAX_COMMAND_AGE_MS) return;

    const command = message.text.trim().split(/\s+/)[0]!.toLowerCase().replace(/@.*$/, "");
    const reply = (text: string) => this.deps.client.sendMessage(chatId, text);
    const by = `Telegram${message.from?.username ? ` @${message.from.username}` : ""}`;
    switch (command) {
      case "/status":
        return void (await reply(await this.deps.commands.status()));
      case "/positions":
        return void (await reply(await this.deps.commands.positions()));
      case "/today":
        return void (await reply(await this.deps.commands.today()));
      case "/pause":
        // The hub event sends the confirmation when something changed.
        if (!this.deps.commands.pause(by)) await reply("Bot đã tạm dừng từ trước.");
        return;
      case "/resume":
        if (!this.deps.commands.resume(by)) await reply("Bot đang chạy, không cần /resume.");
        return;
      default:
        await reply(HELP_TEXT);
    }
  }

  private rememberCandidate(chat: { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string }, at: number): void {
    const name = chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : String(chat.id)));
    const list = this.candidates().filter((c) => c.chatId !== String(chat.id));
    list.unshift({ chatId: String(chat.id), name, type: chat.type, lastSeenAt: at });
    this.deps.kv.set(CANDIDATES_KEY, list.slice(0, 10));
    this.logger.info("Telegram chat id discovered", { chatId: String(chat.id), name });
  }
}
