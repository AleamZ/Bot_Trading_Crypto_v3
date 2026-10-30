import { Fragment, useState } from "react";
import { api } from "../api";
import { dateTime, fullDateTime, price, rMultiple, usd } from "../format";
import { useLoad, type Live, type Route } from "../hooks";
import { METHODS, type Trade } from "../types";
import { Button, DirectionChip, ExitChip, Notice, Panel, Stat, Tabs, TradeStatusChip } from "../ui";

const FILTERS = [
  { id: "all", label: "Tất cả", status: "" },
  { id: "open", label: "Đang mở", status: "OPENING,OPEN" },
  { id: "closed", label: "Đã đóng", status: "CLOSED" },
  { id: "failed", label: "Không vào được", status: "FAILED" },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

const PAGE = 50;

export function Trades({ live, go }: { live: Live; go: (route: Route, param?: string) => void }) {
  const [filter, setFilter] = useState<FilterId>("all");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const status = FILTERS.find((f) => f.id === filter)!.status;
  const result = useLoad(() => api.trades({ status, limit: PAGE, offset: page * PAGE }), [status, page, live.lastLogId]);
  const trades = result.data?.trades ?? [];
  const total = result.data?.total ?? 0;
  const closed = trades.filter((t) => t.status === "CLOSED");
  const sumR = closed.reduce((s, t) => s + (t.pnlR ?? 0), 0);
  const sumPnl = closed.reduce((s, t) => s + Number(t.netPnl ?? 0), 0);
  const wins = closed.filter((t) => (t.pnlR ?? 0) > 0).length;

  return (
    <>
      <Tabs
        label="Lọc lệnh"
        value={filter}
        onChange={(id) => {
          setFilter(id);
          setPage(0);
        }}
        items={FILTERS.map((f) => ({ id: f.id, label: f.label }))}
      />
      {closed.length > 0 && (
        <div className="stats">
          <Stat label="Lệnh đã đóng (trang này)" value={closed.length} />
          <Stat label="Tỉ lệ thắng" value={`${Math.round((wins / closed.length) * 100)}%`} hint={`${wins} thắng / ${closed.length - wins} thua`} />
          <Stat label="Tổng R" value={rMultiple(sumR)} tone={sumR > 0 ? "up" : sumR < 0 ? "down" : undefined} />
          <Stat label="Lãi/lỗ ròng" value={usd(sumPnl)} tone={sumPnl > 0 ? "up" : sumPnl < 0 ? "down" : undefined} />
        </div>
      )}
      {result.error && <Notice tone="heart">{result.error}</Notice>}
      <Panel title="Lệnh của bot" sub={`${total} lệnh · mới nhất trước`} flush>
        {trades.length === 0 ? (
          <div className="empty-state">{result.loading ? "Đang tải…" : "Chưa có lệnh nào."}</div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Thời gian</th>
                  <th>Symbol</th>
                  <th>Chiều</th>
                  <th>Trạng thái</th>
                  <th className="right">Khối lượng</th>
                  <th className="right">Giá vào</th>
                  <th className="right">SL</th>
                  <th className="right">TP</th>
                  <th>Thoát</th>
                  <th className="right">Lãi/lỗ</th>
                  <th className="right">R</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <Fragment key={t.id}>
                    <tr onClick={() => setOpen(open === t.id ? null : t.id)} aria-expanded={open === t.id}>
                      <td className="num">{dateTime(t.openedAt ?? t.createdAt)}</td>
                      <td>
                        <strong>{t.symbol}</strong>
                      </td>
                      <td>
                        <DirectionChip direction={t.direction} />
                      </td>
                      <td>
                        <TradeStatusChip status={t.status} />
                      </td>
                      <td className="right num">{t.quantity === "0" ? "—" : t.quantity}</td>
                      <td className="right num">{price(t.entryPrice)}</td>
                      <td className="right num">{price(t.stopLoss)}</td>
                      <td className="right num">{price(t.takeProfit)}</td>
                      <td>
                        {t.status === "CLOSED" ? (
                          <span className="row" style={{ gap: 6 }}>
                            <ExitChip reason={t.exitReason} /> <span className="num">{price(t.exitPrice)}</span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={`right num ${Number(t.netPnl) > 0 ? "up" : Number(t.netPnl) < 0 ? "down" : ""}`}>{usd(t.netPnl)}</td>
                      <td className={`right num ${(t.pnlR ?? 0) > 0 ? "up" : (t.pnlR ?? 0) < 0 ? "down" : ""}`}>{rMultiple(t.pnlR)}</td>
                    </tr>
                    {open === t.id && (
                      <tr className="detail">
                        <td colSpan={11}>
                          <TradeDetail trade={t} go={go} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {total > PAGE && (
        <div className="row">
          <Button tone="plain" small disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Trang trước
          </Button>
          <span className="soft">
            Trang {page + 1} / {Math.ceil(total / PAGE)}
          </span>
          <Button tone="plain" small disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)}>
            Trang sau
          </Button>
        </div>
      )}
    </>
  );
}

function TradeDetail({ trade: t, go }: { trade: Trade; go: (route: Route, param?: string) => void }) {
  const rows: [string, string][] = [
    ["Mã lệnh", t.id],
    ["Phương pháp", t.methods.map((m) => METHODS.find((x) => x.id === m)?.letter ?? m).join(", ")],
    ["Tạo lúc", fullDateTime(t.createdAt)],
    ["Vào lúc", fullDateTime(t.openedAt)],
    ["Đóng lúc", fullDateTime(t.closedAt)],
    ["Giá dự kiến / SL cấu trúc", `${price(t.plannedEntry)} / ${price(t.structuralStop)}`],
    ["Cách tính SL", t.stopMode ?? "—"],
    ["1R / RR / đòn bẩy", `${t.riskUsd}$ / ${t.rr} / ${t.leverage}x`],
    ["Lỗ nếu chạm SL", t.riskAtStopUsd ? `${t.riskAtStopUsd}$ (${rMultiple(t.riskAtStopR === null ? null : -t.riskAtStopR)})` : "—"],
    ["Lãi ròng nếu chạm TP", t.rewardAtTpUsd ? `${t.rewardAtTpUsd}$ (${rMultiple(t.rewardAtTpR)})` : "—"],
    ["Phí", t.fees ? `${t.fees}$` : "—"],
    ["Client id", [t.entryClientId, t.slClientId, t.tpClientId].filter(Boolean).join(" · ")],
  ];
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <span className="label">{k}</span>
            <span className="num">{v}</span>
          </div>
        ))}
      </div>
      {t.note && <Notice tone={t.status === "FAILED" || t.exitReason === "EMERGENCY" ? "coin" : "sky"}>{t.note}</Notice>}
      {t.status === "CLOSED" && t.entryPrice && (
        <div className="row">
          <Button tone="sky" small onClick={() => go("reviews", t.id)}>
            Xem AI phân tích lệnh này
          </Button>
          <Button tone="plain" small onClick={() => go("analysis", t.symbol)}>
            Xem chart
          </Button>
        </div>
      )}
    </div>
  );
}
