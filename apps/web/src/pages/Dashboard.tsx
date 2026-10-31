import { ArrowClockwiseIcon, PauseIcon, PlayIcon, XIcon } from "@phosphor-icons/react";
import { Fragment, useState } from "react";
import { api, errorMessage } from "../api";
import { clock, dateTime, duration, money, price, progress, rMultiple, signed, usd } from "../format";
import { useLoad, useNow, type Live, type Route } from "../hooks";
import { Feed } from "../parts";
import { METHODS, type AnalysisView, type Position, type Status, type Trade } from "../types";
import { Button, Chip, ConfirmButton, DirectionChip, LevelChip, Mascot, Meter, Notice, Panel, Stat, type Mood } from "../ui";
import { useToast } from "../ui";

export function Dashboard({ live, go }: { live: Live; go: (route: Route, param?: string) => void }) {
  const { status } = live;
  const trades = useLoad(() => api.trades({ status: "OPENING,OPEN", limit: 50 }), [live.lastLogId], 15_000);
  const hasKeys = status?.hasBinanceKeys ?? false;
  const openCount = trades.data?.trades.length ?? 0;
  // Live mark price and PnL while something is open; otherwise only the balance, now and then.
  const positions = useLoad(() => (hasKeys ? api.positions() : Promise.resolve(null)), [hasKeys, live.lastLogId], openCount > 0 ? 5_000 : 60_000);

  if (!status) return <div className="empty-state">Đang tải…</div>;
  return (
    <>
      <Alerts status={status} go={go} />
      <div className="stats">
        <Stat label="Số dư khả dụng" value={hasKeys ? money(positions.data?.availableBalance) : "—"} hint={hasKeys ? (positions.error ?? undefined) : "Chưa có khoá API"} />
        <Stat label="R hôm nay" value={rMultiple(status.today.closed.r)} tone={status.today.closed.r > 0 ? "up" : status.today.closed.r < 0 ? "down" : undefined} hint={usd(status.today.closed.pnl)} />
        <Stat label="Lệnh hôm nay" value={`${status.today.opened} / ${status.limits.maxTradesPerDay}`} hint={`Đóng ${status.today.closed.count}, thắng ${status.today.closed.wins}`} />
        <Stat label="Vị thế mở" value={`${status.openTrades} / ${status.limits.maxOpenPositions}`} />
      </div>
      <div className="grid3">
        <Panel
          className="span2"
          title="Tín hiệu"
          sub={status.lastScan ? `nến ${status.limits.entryTf} đóng ${clock(status.lastScan.expectedClose + 1)} · quét ${clock(status.lastScan.finishedAt)}` : "chưa quét"}
          flush
        >
          <SignalBoard rows={live.analysis} go={go} />
        </Panel>
        <BotPanel status={status} />
        <Panel className="span2" title="Vị thế đang mở" sub={trades.data ? `${openCount} lệnh` : undefined} flush>
          <OpenTrades trades={trades.data?.trades ?? []} positions={positions.data?.positions ?? []} onClosed={() => void trades.reload()} />
        </Panel>
        <Panel title="Tin gần đây" sub={<a href="#/activity">xem hết</a>} flush>
          <Feed entries={live.logs.slice(0, 12)} />
        </Panel>
      </div>
    </>
  );
}

function Alerts({ status, go }: { status: Status; go: (route: Route) => void }) {
  return (
    <>
      {!status.exchange.ok && (
        <Notice tone="heart" title="Không gọi được Binance">
          {status.exchange.error}. Watchdog vẫn thử lại mỗi 15 giây.
        </Notice>
      )}
      {status.riskCheck?.message && (
        <Notice tone={status.riskCheck.level === "none" ? "heart" : "coin"} title={status.riskCheck.level === "none" ? "1R lớn hơn mức số dư cho phép" : "1R chỉ hợp với một phần lệnh"}>
          {status.riskCheck.message}
          <div style={{ marginTop: 8 }}>
            <Button tone="plain" small onClick={() => go("settings")}>
              Mở cài đặt
            </Button>
          </div>
        </Notice>
      )}
      {status.autoTradeBlockers.length > 0 && (
        <Notice tone="coin" title={`Tự vào lệnh đang tắt: ${status.limits.autoEntryThreshold}/3 chỉ được báo, không đặt lệnh`}>
          <ul>
            {status.autoTradeBlockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Notice>
      )}
      {status.warnings.length > 0 && (
        <Notice tone="coin" title="Cài đặt cần xem lại">
          <ul>
            {status.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <Button tone="plain" small onClick={() => go("settings")}>
            Mở cài đặt
          </Button>
        </Notice>
      )}
    </>
  );
}

function SignalBoard({ rows, go }: { rows: AnalysisView[]; go: (route: Route, param?: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (rows.length === 0) return <div className="empty-state">Chưa có lượt quét nào. Bot quét ngay khi khởi động, rồi sau mỗi nến đóng.</div>;
  return (
    <div className="scroll-x">
      <table className="board">
        <thead>
          <tr>
            <th>Symbol</th>
            {METHODS.map((m) => (
              <th key={m.id} title={m.label}>
                {m.letter}
              </th>
            ))}
            <th>Đồng thuận</th>
            <th>Mức</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const c = a.consensus;
            const best = Math.max(c.longCount, c.shortCount);
            const expanded = open === a.symbol;
            return (
              <Fragment key={a.symbol}>
                <tr onClick={() => setOpen(expanded ? null : a.symbol)} style={{ cursor: "pointer" }} aria-expanded={expanded}>
                  <td>
                    <div className="sym">{a.symbol}</div>
                    <div className="soft num" style={{ fontSize: 12 }}>
                      {price(a.price)}
                    </div>
                  </td>
                  {METHODS.map((m) => {
                    const state = a.methods[m.id];
                    if (!state.enabled) return <td key={m.id}><Chip tone="empty">Tắt</Chip></td>;
                    const s = state.signal;
                    return <td key={m.id}>{s ? <DirectionChip direction={s.direction} title={`${s.reason} · SL ${price(s.stopLoss)}`} /> : <Chip tone="empty">—</Chip>}</td>;
                  })}
                  <td>
                    <Meter label={c.direction ?? "—"} value={best} max={3} tone={c.direction === "SHORT" ? "heart" : "quest"} display={`${best}/3`} />
                  </td>
                  <td>
                    <LevelChip level={c.level} />
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={6} style={{ background: "var(--well)" }}>
                      <div style={{ display: "grid", gap: 6 }}>
                        {METHODS.map((m) => {
                          const s = a.methods[m.id].signal;
                          return (
                            <div key={m.id}>
                              <strong>
                                {m.letter}. {m.label}:
                              </strong>{" "}
                              {s ? `${s.direction} · SL ${price(s.stopLoss)} · ${s.reason} · nến ${dateTime(s.time + 1)}` : a.methods[m.id].enabled ? "chưa có tín hiệu" : "đang tắt"}
                            </div>
                          );
                        })}
                        <div>
                          <Button tone="sky" small onClick={() => go("analysis", a.symbol)}>
                            Xem chart và điều kiện
                          </Button>
                        </div>
                        <div className="soft">
                          ATR {price(a.atr)} · nến {a.timeframe} đóng {dateTime(a.time + 1)}
                          {a.episode && ` · đợt ${a.episode.direction} ${a.episode.level} từ ${dateTime(a.episode.startedAt + 1)}`}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function moodOf(status: Status): Mood {
  if (!status.exchange.ok) return "error";
  if (status.paused) return "paused";
  if (!status.autoTradeAllowed) return "off";
  return "running";
}

const moodText = (mood: Mood, status: Status): string =>
  ({
    running: `Đang chạy: ${status.limits.autoEntryThreshold}/3 sẽ tự vào lệnh`,
    paused: "Tạm dừng: không vào lệnh mới",
    error: "Đang gặp lỗi kết nối",
    off: "Chỉ báo tín hiệu, không tự vào lệnh",
  })[mood];

function BotPanel({ status }: { status: Status }) {
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const mood = moodOf(status);
  const lossUsed = Math.max(0, -status.today.closed.r);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await action();
      toast(done, "quest");
    } catch (e) {
      toast(errorMessage(e), "heart");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Bot" sub={`v${status.version}`} flush>
      <div className="stripes">
        <Mascot mood={mood} />
        <strong style={{ marginTop: 8 }}>{moodText(mood, status)}</strong>
      </div>
      <div className="panel-body" style={{ display: "grid", gap: 14 }}>
        <Meter label="Lỗ trong ngày" value={Number(lossUsed.toFixed(2))} max={status.limits.maxDailyLossR} cells={Math.max(3, Math.round(status.limits.maxDailyLossR * 2))} tone="heart" display={`${lossUsed.toFixed(2)} / ${status.limits.maxDailyLossR}R`} />
        <Meter label="Vị thế mở" value={status.openTrades} max={status.limits.maxOpenPositions} tone="sky" />
        <Meter label="Lệnh hôm nay" value={status.today.opened} max={status.limits.maxTradesPerDay} tone="coin" />
        <div className="soft" style={{ fontSize: 12 }}>
          {status.scanning ? "Đang quét…" : status.nextScanAt ? `Lần quét tới ${clock(status.nextScanAt)} (còn ${duration(status.nextScanAt - now)})` : "Chưa lên lịch quét"}
          {status.userStream && ` · user stream ${status.userStream.connected ? "đã nối" : "mất kết nối"}`}
        </div>
        <div className="row">
          {status.paused ? (
            <Button disabled={busy} icon={<PlayIcon size={14} weight="fill" />} onClick={() => run(api.resume, "Đã cho vào lệnh lại")}>
              Chạy lại
            </Button>
          ) : (
            <Button tone="coin" disabled={busy} icon={<PauseIcon size={14} weight="fill" />} onClick={() => run(api.pause, "Đã tạm dừng vào lệnh mới")}>
              Tạm dừng
            </Button>
          )}
          <Button tone="plain" disabled={busy || status.scanning} icon={<ArrowClockwiseIcon size={14} weight="bold" />} onClick={() => run(api.scan, "Đã quét lại nến vừa đóng")}>
            Quét ngay
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function OpenTrades({ trades, positions, onClosed }: { trades: Trade[]; positions: Position[]; onClosed: () => void }) {
  const toast = useToast();
  if (trades.length === 0) return <div className="empty-state">Không có lệnh nào đang mở.</div>;
  return (
    <div>
      {trades.map((t) => {
        const p = positions.find((x) => x.symbol === t.symbol);
        const mark = p ? Number(p.markPrice) : null;
        const sl = Number(t.stopLoss);
        const tp = Number(t.takeProfit);
        const entry = Number(t.entryPrice);
        const ready = t.stopLoss && t.takeProfit && t.entryPrice;
        const pnl = p ? Number(p.unRealizedProfit) : null;
        return (
          <div className="position" key={t.id}>
            <div className="row between">
              <div className="row">
                <strong>{t.symbol}</strong>
                <DirectionChip direction={t.direction} />
                {t.status === "OPENING" && <Chip tone="coin">Đang vào</Chip>}
                <span className="soft">{t.methods.map((m) => METHODS.find((x) => x.id === m)?.letter).join(" ")} · {dateTime(t.openedAt ?? t.createdAt)}</span>
              </div>
              <ConfirmButton
                tone="plain"
                small
                icon={<XIcon size={12} weight="bold" />}
                confirmLabel="Bấm lần nữa để đóng"
                onConfirm={async () => {
                  try {
                    const closed = await api.closeTrade(t.id);
                    toast(`Đã đóng ${t.symbol}: ${usd(closed.netPnl)} (${rMultiple(closed.pnlR)})`, "quest");
                  } catch (e) {
                    toast(errorMessage(e), "heart");
                  }
                  onClosed();
                }}
              >
                Đóng lệnh
              </ConfirmButton>
            </div>
            <div className="kv">
              <div>
                <span className="label">Khối lượng</span>
                <strong>{t.quantity}</strong>
              </div>
              <div>
                <span className="label">Giá vào</span>
                <strong>{price(t.entryPrice)}</strong>
              </div>
              <div>
                <span className="label">SL</span>
                <strong className="down">{price(t.stopLoss)}</strong>
                <span className="soft">{t.riskAtStopR !== null ? rMultiple(-t.riskAtStopR) : ""}</span>
              </div>
              <div>
                <span className="label">TP</span>
                <strong className="up">{price(t.takeProfit)}</strong>
                <span className="soft">{rMultiple(t.rewardAtTpR)}</span>
              </div>
              <div>
                <span className="label">Giá mark</span>
                <strong>{mark ? price(mark) : "—"}</strong>
              </div>
              <div>
                <span className="label">Lãi/lỗ chưa chốt</span>
                <strong className={pnl === null ? "" : pnl >= 0 ? "up" : "down"}>{pnl === null ? "—" : `${signed(pnl)}$`}</strong>
                <span className="soft">{pnl !== null && t.riskUsd ? rMultiple(pnl / t.riskUsd) : ""}</span>
              </div>
            </div>
            {ready && (
              <div>
                <div className="row between soft" style={{ fontSize: 12, marginBottom: 10 }}>
                  <span>SL {price(sl)}</span>
                  <span>TP {price(tp)}</span>
                </div>
                <div className="track" style={{ ["--entry" as string]: `${progress(entry, sl, tp) * 100}%` }} aria-label="Giá hiện tại giữa SL và TP">
                  <span className="track-entry" style={{ left: `${progress(entry, sl, tp) * 100}%` }} />
                  {mark && <span className="track-marker" style={{ left: `${progress(mark, sl, tp) * 100}%` }} />}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
