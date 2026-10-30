import { ChatCircleDotsIcon, PaperPlaneRightIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "./api";
import type { Live } from "./hooks";
import { Button } from "./ui";

interface Message {
  role: "user" | "assistant";
  content: string;
  tools?: string[];
}

const STORAGE_KEY = "bot-v3.chat";
const MAX_SENT = 30; // the server takes at most 30 messages per question
const SUGGESTIONS = ["Hôm nay bot thế nào?", "Vì sao chưa vào lệnh BTCUSDT?", "Lệnh thua gần nhất do đâu?", "Giải thích cách bot tính SL và TP"];

const TOOL_LABEL: Record<string, string> = {
  bot_status: "trạng thái",
  bot_settings: "cài đặt",
  symbol_analysis: "phân tích symbol",
  list_trades: "danh sách lệnh",
  trade_detail: "chi tiết lệnh",
  trade_reviews: "bài phân tích",
  review_insights: "bài học tổng hợp",
  recent_events: "nhật ký",
  bot_rules: "luật giao dịch",
  snapshot: "ảnh chụp trạng thái",
};

function loadMessages(): Message[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Message[]) : [];
  } catch {
    return [];
  }
}

function saveMessages(messages: Message[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-60)));
  } catch {
    // Private mode or full storage: the chat still works, it just is not kept.
  }
}

/** Floating "ask the AI" chat about the bot; the server gives the AI read-only tools over the bot. */
export function ChatWidget({ live }: { live: Live }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>(loadMessages);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ai = live.status?.ai;
  const ready = Boolean(ai?.enabled && ai.chatEnabled);

  useEffect(() => saveMessages(messages), [messages]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, busy, open]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  async function send(text: string, history = messages) {
    const question = text.trim().slice(0, 4000);
    if (!question || busy) return;
    const next = [...history, { role: "user" as const, content: question }];
    setMessages(next);
    setDraft("");
    setError(null);
    setBusy(true);
    try {
      const reply = await api.chat(next.slice(-MAX_SENT).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })));
      setMessages([...next, { role: "assistant", content: reply.reply, tools: reply.tools }]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="chat-fab" onClick={() => setOpen(true)} aria-label="Mở chat hỏi AI về bot">
        <ChatCircleDotsIcon size={22} weight="bold" />
        <span>Hỏi AI</span>
      </button>
    );
  }

  return (
    <section className="chat-panel" aria-label="Chat hỏi AI về bot">
      <header className="chat-head">
        <div>
          <div className="panel-title">Hỏi AI về bot</div>
          <div className="soft" style={{ fontSize: 11 }}>
            {ai?.model ? `${ai.model} · chỉ đọc, không đặt lệnh` : "chỉ đọc, không đặt lệnh"}
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {messages.length > 0 && (
            <Button tone="plain" small onClick={() => (setMessages([]), setError(null))} icon={<TrashIcon size={12} weight="bold" />} title="Xoá cuộc trò chuyện">
              Xoá
            </Button>
          )}
          <Button tone="plain" small onClick={() => setOpen(false)} icon={<XIcon size={12} weight="bold" />} aria-label="Đóng chat" />
        </div>
      </header>
      <div className="chat-list" ref={listRef}>
        {!ready && (
          <div className="notice coin">
            {ai && !ai.enabled ? (ai.hint ?? "AI đang tắt.") : ai && !ai.chatEnabled ? "Chat AI đang tắt trong Cài đặt → AI." : "Đang tải trạng thái AI…"}
          </div>
        )}
        {ready && messages.length === 0 && (
          <div className="chat-empty">
            <div className="soft">Hỏi bất cứ điều gì về bot: trạng thái, vì sao chưa vào lệnh, lệnh thắng thua, cài đặt, cách tính SL/TP… AI đọc dữ liệu thật của bot để trả lời.</div>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="chat-suggestion" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-bubble">{m.role === "assistant" ? <RichText text={m.content} /> : m.content}</div>
            {m.tools && m.tools.length > 0 && <div className="chat-tools">đã xem: {m.tools.map((t) => TOOL_LABEL[t] ?? t).join(", ")}</div>}
          </div>
        ))}
        {busy && (
          <div className="chat-msg assistant">
            <div className="chat-bubble soft">AI đang xem dữ liệu bot…</div>
          </div>
        )}
        {error && (
          <div className="notice heart">
            {error}{" "}
            <Button tone="plain" small onClick={() => void retry()}>
              Thử lại
            </Button>
          </div>
        )}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          rows={2}
          maxLength={4000}
          disabled={!ready}
          placeholder={ready ? "Hỏi về bot… (Enter để gửi, Shift+Enter xuống dòng)" : "AI đang tắt"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <Button type="submit" small disabled={!ready || busy || !draft.trim()} icon={<PaperPlaneRightIcon size={14} weight="bold" />} aria-label="Gửi" />
      </form>
    </section>
  );

  // Ask the last question again after an error.
  async function retry() {
    const last = messages.at(-1);
    if (last?.role === "user") await send(last.content, messages.slice(0, -1));
  }
}

/** Light formatting for AI replies: paragraphs, "- " lists, **bold** and `code`; never raw HTML. */
function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>);
    list = [];
  };
  for (const line of text.split("\n")) {
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      list.push(item[1]!);
      continue;
    }
    flush();
    if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line.replace(/^#+\s*/, ""))}</p>);
  }
  flush();
  return <>{blocks}</>;
}

function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={i}>{part.slice(1, -1)}</code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
