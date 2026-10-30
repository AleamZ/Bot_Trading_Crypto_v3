import { CopyIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { dateTime } from "../format";
import { useLoad, type Live, type Route } from "../hooks";
import { Button, Chip, Notice, Panel, useToast } from "../ui";

const COMMANDS: [string, string][] = [
  ["/status", "Trạng thái, tín hiệu hiện tại"],
  ["/positions", "Lệnh đang mở với SL/TP"],
  ["/today", "Kết quả hôm nay"],
  ["/pause", "Tạm dừng vào lệnh mới (lệnh đang mở vẫn giữ SL/TP)"],
  ["/resume", "Cho vào lệnh lại"],
];

export function TelegramPage({ live, go }: { live: Live; go: (route: Route) => void }) {
  const toast = useToast();
  const info = useLoad(() => api.telegram(), [live.lastLogId], 10_000);
  const [sending, setSending] = useState(false);
  const t = info.data;

  async function sendTest() {
    setSending(true);
    try {
      await api.telegramTest();
      toast("Đã gửi tin thử, kiểm tra Telegram", "quest");
    } catch (e) {
      toast(errorMessage(e), "heart");
    } finally {
      setSending(false);
      void info.reload();
    }
  }

  if (info.error) return <Notice tone="heart">{info.error}</Notice>;
  if (!t) return <div className="empty-state">Đang tải…</div>;

  return (
    <div className="grid3">
      <div className="span2 stack">
        <Panel
          title="Telegram"
          sub={
            t.configured ? (
              <Chip tone={t.chatIdSet && !t.lastError ? "quest" : "coin"}>{t.chatIdSet ? (t.lastError ? "có lỗi" : "hoạt động") : "chưa có chat id"}</Chip>
            ) : (
              <Chip tone="empty">chưa cài</Chip>
            )
          }
        >
          {!t.configured ? (
            <Steps />
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              <div className="kv">
                <div>
                  <span className="label">Đọc lệnh</span>
                  <strong>{t.polling ? "đang chạy" : "đã dừng"}</strong>
                </div>
                <div>
                  <span className="label">Gửi gần nhất</span>
                  <strong>{dateTime(t.lastSentAt)}</strong>
                </div>
                <div>
                  <span className="label">Đang chờ gửi</span>
                  <strong>{t.queued ?? 0}</strong>
                </div>
              </div>
              {t.lastError && <Notice tone="heart" title="Lỗi gần nhất">{t.lastError}</Notice>}
              {!t.chatIdSet && <Candidates candidates={t.candidates ?? []} />}
              <div className="row">
                <Button tone="sky" disabled={sending || !t.chatIdSet} onClick={sendTest} icon={<PaperPlaneTiltIcon size={14} weight="bold" />}>
                  {sending ? "Đang gửi…" : "Gửi tin thử"}
                </Button>
                <Button tone="plain" onClick={() => go("settings")}>
                  Chọn loại thông báo
                </Button>
              </div>
            </div>
          )}
        </Panel>
      </div>
      <Panel title="Lệnh trong chat" sub="chỉ từ chat id đã cài">
        <div style={{ display: "grid", gap: 10 }}>
          {COMMANDS.map(([cmd, text]) => (
            <div key={cmd}>
              <code>{cmd}</code> <span className="soft">{text}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function Steps() {
  return (
    <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8 }}>
      <li>
        Trên Telegram, mở <strong>@BotFather</strong>, gửi <code>/newbot</code>, đặt tên và username (kết thúc bằng <code>bot</code>).
      </li>
      <li>
        Dán token BotFather trả về vào <code>TELEGRAM_BOT_TOKEN=</code> trong file <code>.env</code> của bot (không gửi token cho ai).
      </li>
      <li>
        Khởi động lại bot, mở bot của bạn trên Telegram và bấm <strong>Start</strong>. Bot trả lời chat id, trang này cũng hiện nó.
      </li>
      <li>
        Điền <code>TELEGRAM_CHAT_ID=</code> trong <code>.env</code> rồi khởi động lại.
      </li>
    </ol>
  );
}

function Candidates({ candidates }: { candidates: { chatId: string; name: string; type: string; lastSeenAt: number }[] }) {
  const toast = useToast();
  if (candidates.length === 0) {
    return (
      <Notice tone="coin" title="Chưa có chat id">
        Mở bot của bạn trên Telegram và bấm <strong>Start</strong> (hoặc gửi <code>/start</code>). Chat id sẽ hiện ở đây.
      </Notice>
    );
  }
  return (
    <Notice tone="coin" title="Chat đã nhắn cho bot: chép id của bạn vào TELEGRAM_CHAT_ID trong .env, rồi khởi động lại bot">
      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
        {candidates.map((c) => (
          <div key={c.chatId} className="row">
            <code>{c.chatId}</code>
            <span>{c.name}</span>
            <span className="soft">
              {c.type} · {dateTime(c.lastSeenAt)}
            </span>
            <Button
              tone="plain"
              small
              icon={<CopyIcon size={12} />}
              onClick={() =>
                navigator.clipboard.writeText(`TELEGRAM_CHAT_ID=${c.chatId}`).then(
                  () => toast("Đã chép dòng TELEGRAM_CHAT_ID", "quest"),
                  () => toast("Trình duyệt chặn chép, hãy chép tay", "coin"),
                )
              }
            >
              Chép
            </Button>
          </div>
        ))}
      </div>
    </Notice>
  );
}
