import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { api, errorMessage } from "../api";
import { dateTime, rMultiple, signed, usd } from "../format";
import { useLoad, type Live, type Route } from "../hooks";
import type { AllStats, DayStats, GroupStats, MeasureStats, MonthStats, PeriodStats, TradePoint } from "../types";
import { Button, ConfirmButton, DirectionChip, Notice, Panel, Stat, Tabs, useToast } from "../ui";

type Unit = "usd" | "r";
const UNIT_KEY = "bot3.statsUnit";

function readUnit(): Unit {
  try {
    return localStorage.getItem(UNIT_KEY) === "r" ? "r" : "usd";
  } catch {
    return "usd";
  }
}

const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const inUnit = (unit: Unit, value: number | null) => (value === null ? "—" : unit === "r" ? rMultiple(value) : usd(value));
const pick = (unit: Unit, x: { r: number; pnl: number }) => (unit === "r" ? x.r : x.pnl);
const tone = (value: number | null) => (value === null ? undefined : value > 0 ? "up" : value < 0 ? "down" : undefined);

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + by, 1)).toISOString().slice(0, 7);
}

const monthLabel = (month: string) => `Tháng ${Number(month.slice(5, 7))}/${month.slice(0, 4)}`;
const shortMonth = (month: string) => `${month.slice(5, 7)}/${month.slice(2, 4)}`;
const dayLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const weekday = (day: string) => WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];

/** `#/stats` this month, `#/stats/2026-09` another month, `#/stats/all` every trade since the start. */
export function StatsPage({ live, month, go }: { live: Live; month: string | null; go: (route: Route, param?: string) => void }) {
  const [unit, setUnit] = useState<Unit>(readUnit);
  const all = month === "all";

  useEffect(() => {
    try {
      localStorage.setItem(UNIT_KEY, unit);
    } catch {
      // storage blocked: the choice lasts until reload
    }
  }, [unit]);

  return (
    <>
      <div className="row between">
        <Tabs
          label="Khoảng thống kê"
          value={all ? "all" : "month"}
          onChange={(id) => go("stats", id === "all" ? "all" : undefined)}
          items={[
            { id: "month", label: "Theo tháng" },
            { id: "all", label: "Toàn bộ" },
          ]}
        />
        <div className="unit-tabs">
          <Tabs
            label="Đơn vị"
            value={unit}
            onChange={setUnit}
            items={[
              { id: "usd", label: "Tiền ($)" },
              { id: "r", label: "Theo R" },
            ]}
          />
        </div>
      </div>
      <ClearBar since={live.status?.statsSince ?? null} />
      {all ? <AllView live={live} unit={unit} /> : <MonthView live={live} month={month} unit={unit} go={go} />}
    </>
  );
}

/** Clears the P&L figures (stats and the trade list start again now) or brings them back. */
function ClearBar({ since }: { since: number | null }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
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
    <div className="row between clear-bar">
      <span className="soft">
        {since
          ? `Đang tính từ ${dateTime(since)}: lệnh xong trước đó không còn trong thống kê và trang Lệnh. Bài AI phân tích vẫn giữ.`
          : "Xoá số liệu lãi/lỗ để thống kê và trang Lệnh bắt đầu lại từ lúc này. Bài AI phân tích được giữ nguyên, lệnh đang mở vẫn được theo dõi."}
      </span>
      <div className="row">
        {since && (
          <Button tone="plain" small disabled={busy} onClick={() => run(api.restoreStats, "Đã khôi phục số liệu cũ")}>
            Khôi phục số liệu cũ
          </Button>
        )}
        <ConfirmButton tone="heart" small disabled={busy} confirmLabel="Bấm lần nữa để xoá" onConfirm={() => run(api.resetStats, "Đã xoá số liệu lãi/lỗ")}>
          Xoá số liệu lãi/lỗ
        </ConfirmButton>
      </div>
    </div>
  );
}

// ---------- one month

function MonthView({ live, month, unit, go }: { live: Live; month: string | null; unit: Unit; go: (route: Route, param?: string) => void }) {
  const [scope, setScope] = useState<"month" | "all">("month");
  // A trade closing writes a log entry: reload then.
  const stats = useLoad(() => api.stats(month ?? undefined), [month, live.lastLogId]);
  const data = stats.data;
  if (!data) return stats.error ? <Notice tone="heart">{stats.error}</Notice> : <div className="empty-state">Đang tải…</div>;

  const thisMonth = data.today.slice(0, 7);
  const open = (target: string) => go("stats", target === thisMonth ? undefined : target);
  const elapsed = data.days.filter((d) => d.day <= data.today && d.count > 0);
  const green = elapsed.filter((d) => pick(unit, d) > 0).length;
  const red = elapsed.filter((d) => pick(unit, d) < 0).length;
  const best = elapsed.length ? elapsed.reduce((a, b) => (pick(unit, b) > pick(unit, a) ? b : a)) : null;
  const worst = elapsed.length ? elapsed.reduce((a, b) => (pick(unit, b) < pick(unit, a) ? b : a)) : null;
  const t = data.totals;
  const net = unit === "r" ? t.r.net : t.usd.net;

  return (
    <>
      <div className="row">
        <Button tone="plain" small icon={<CaretLeftIcon size={14} weight="bold" />} disabled={!data.firstMonth || data.month <= data.firstMonth} onClick={() => open(shiftMonth(data.month, -1))}>
          Tháng trước
        </Button>
        <strong>{monthLabel(data.month)}</strong>
        <Button tone="plain" small icon={<CaretRightIcon size={14} weight="bold" />} disabled={data.month >= thisMonth} onClick={() => open(shiftMonth(data.month, 1))}>
          Tháng sau
        </Button>
      </div>
      {stats.error && <Notice tone="heart">{stats.error}</Notice>}
      <div className="stats">
        <Stat label="Lãi/lỗ ròng tháng" value={inUnit(unit, net)} tone={tone(net)} hint={`${unit === "r" ? usd(t.usd.net) : rMultiple(t.r.net)} · phí ${t.usd.fees.toFixed(2)}$`} />
        <Stat label="Winrate theo lệnh" value={pct(t.winRate)} hint={`${t.wins} thắng · ${t.flats} hòa · ${t.losses} thua`} />
        <Stat label="Ngày lãi / ngày lỗ" value={`${green} / ${red}`} hint={`${elapsed.length} ngày có lệnh đóng`} />
        <Stat label="Ngày tốt nhất" value={best ? inUnit(unit, pick(unit, best)) : "—"} tone={best ? tone(pick(unit, best)) : undefined} hint={best ? dayLabel(best.day) : undefined} />
        <Stat label="Ngày tệ nhất" value={worst ? inUnit(unit, pick(unit, worst)) : "—"} tone={worst ? tone(pick(unit, worst)) : undefined} hint={worst ? dayLabel(worst.day) : undefined} />
      </div>
      <Panel title="Lãi/lỗ từng ngày" sub={`${monthLabel(data.month)} · ${unit === "r" ? "R" : "USDT"} · tài khoản ${live.status?.binanceEnv ?? "…"}`} flush>
        {t.count === 0 ? <div className="empty-state">{monthLabel(data.month)} chưa có lệnh nào đóng.</div> : <DailyChart data={data} unit={unit} />}
      </Panel>
      <Panel
        title="Winrate"
        sub={scope === "month" ? monthLabel(data.month) : data.firstMonth ? `từ ${monthLabel(data.firstMonth).toLowerCase()}` : "từ đầu"}
        actions={
          <Tabs
            label="Khoảng thời gian"
            value={scope}
            onChange={setScope}
            items={[
              { id: "month", label: `Tháng ${Number(data.month.slice(5, 7))}` },
              { id: "all", label: "Từ đầu" },
            ]}
          />
        }
      >
        <WinRates stats={scope === "month" ? t : data.allTime} />
      </Panel>
      {t.count > 0 && (
        <Panel title="Chi tiết từng ngày" sub={`${elapsed.length} ngày · mới nhất trước`} flush>
          <DayTable days={data.days} unit={unit} />
        </Panel>
      )}
    </>
  );
}

function DailyChart({ data, unit }: { data: MonthStats; unit: Unit }) {
  const slots: Slot[] = data.days.map((d) => {
    const n = Number(d.day.slice(8, 10));
    return { key: d.day, value: d.count > 0 ? pick(unit, d) : null, label: String(n), major: n === 1 || n % 5 === 0, future: d.day > data.today, marker: d.day === data.today };
  });
  return (
    <PnlChart
      slots={slots}
      unit={unit}
      names={["Ngày lãi", "Ngày lỗ", "Lũy kế trong tháng"]}
      tip={(i, cum) => {
        const d = data.days[i]!;
        return (
          <>
            <strong>
              {weekday(d.day)} {dayLabel(d.day)}
            </strong>
            {d.day > data.today ? <div className="soft">Chưa tới</div> : d.count === 0 ? <div className="soft">Không có lệnh đóng</div> : <GroupLines g={d} fees={d.fees} />}
            {cum !== null && <div>Lũy kế {inUnit(unit, cum)}</div>}
          </>
        );
      }}
    />
  );
}

// ---------- every trade since the start

function AllView({ live, unit }: { live: Live; unit: Unit }) {
  const stats = useLoad(() => api.statsAll(), [live.lastLogId]);
  const data = stats.data;
  if (!data) return stats.error ? <Notice tone="heart">{stats.error}</Notice> : <div className="empty-state">Đang tải…</div>;
  const t = data.totals;
  if (t.count === 0) return <div className="empty-state">Chưa có lệnh nào đóng.</div>;

  const m = unit === "r" ? t.r : t.usd;
  let running = 0;
  let peak = 0;
  let drawdown = 0;
  for (const p of data.trades) {
    running += pick(unit, p);
    peak = Math.max(peak, running);
    drawdown = Math.max(drawdown, peak - running);
  }
  const days = new Set(data.trades.map((p) => new Date(p.closedAt + 7 * 3_600_000).toISOString().slice(0, 10))).size;

  return (
    <>
      {stats.error && <Notice tone="heart">{stats.error}</Notice>}
      <div className="stats">
        <Stat label="Lãi/lỗ ròng" value={inUnit(unit, m.net)} tone={tone(m.net)} hint={`${unit === "r" ? usd(t.usd.net) : rMultiple(t.r.net)} · phí ${t.usd.fees.toFixed(2)}$`} />
        <Stat label="Lệnh đã đóng" value={t.count} hint={`${days} ngày · từ ${data.firstClosedAt ? dateTime(data.firstClosedAt) : "—"}`} />
        <Stat label="Winrate theo lệnh" value={pct(t.winRate)} hint={`${t.wins} thắng · ${t.flats} hòa · ${t.losses} thua`} />
        <Stat label="Hệ số lãi" value={profitFactor(m)} hint="tổng thắng ÷ tổng thua" />
        <Stat label="Sụt giảm lớn nhất" value={inUnit(unit, -drawdown)} tone={drawdown > 0 ? "down" : undefined} hint="từ đỉnh lũy kế xuống đáy sau đó" />
      </div>
      <Panel title="Đường vốn qua từng lệnh" sub={`${t.count} lệnh · cũ nhất bên trái · ${unit === "r" ? "R" : "USDT"} · tài khoản ${live.status?.binanceEnv ?? "…"}`} flush>
        <TradesChart trades={data.trades} unit={unit} />
      </Panel>
      <Panel title="Lãi/lỗ theo tháng" sub={`${data.months.length} tháng`} flush>
        <MonthsChart months={data.months} unit={unit} />
      </Panel>
      <Panel title="Winrate" sub="từ đầu">
        <WinRates stats={t} />
      </Panel>
      <div className="grid2">
        <Panel title="Theo symbol" flush>
          <Breakdown rows={data.bySymbol} unit={unit} />
        </Panel>
        <Panel title="Theo phương pháp đồng thuận" flush>
          <Breakdown rows={data.byMethods} unit={unit} />
        </Panel>
        <Panel title="Theo chiều" flush>
          <Breakdown rows={data.byDirection} unit={unit} label={(key) => <DirectionChip direction={key === "SHORT" ? "SHORT" : "LONG"} />} />
        </Panel>
        <Panel title="Theo kiểu thoát" flush>
          <Breakdown rows={data.byExit} unit={unit} />
        </Panel>
      </div>
    </>
  );
}

function TradesChart({ trades, unit }: { trades: TradePoint[]; unit: Unit }) {
  // Number every k-th trade when there is no room for all.
  const every = trades.length <= 20 ? 1 : trades.length <= 60 ? 5 : trades.length <= 150 ? 10 : trades.length <= 400 ? 25 : 50;
  const slots: Slot[] = trades.map((p, i) => ({ key: p.id, value: pick(unit, p), label: String(i + 1), major: i === 0 || (i + 1) % every === 0 }));
  return (
    <PnlChart
      slots={slots}
      unit={unit}
      names={["Lệnh lãi", "Lệnh lỗ", "Lũy kế (đường vốn)"]}
      tip={(i, cum) => {
        const p = trades[i]!;
        return (
          <>
            <strong>
              #{i + 1} {p.symbol} {p.direction}
            </strong>
            <div className="soft">
              {dateTime(p.closedAt)} · {p.methods} · {p.exit}
            </div>
            <div>
              <span className={tone(p.pnl) ?? ""}>{usd(p.pnl)}</span> · <span className={tone(p.r) ?? ""}>{rMultiple(p.r)}</span>
            </div>
            {cum !== null && <div>Lũy kế {inUnit(unit, cum)}</div>}
          </>
        );
      }}
    />
  );
}

function MonthsChart({ months, unit }: { months: AllStats["months"]; unit: Unit }) {
  const slots: Slot[] = months.map((g) => ({ key: g.key, value: pick(unit, g), label: shortMonth(g.key), major: true }));
  return (
    <PnlChart
      slots={slots}
      unit={unit}
      names={["Tháng lãi", "Tháng lỗ", "Lũy kế"]}
      tip={(i, cum) => {
        const g = months[i]!;
        return (
          <>
            <strong>{monthLabel(g.key)}</strong>
            <GroupLines g={g} fees={g.fees} />
            {cum !== null && <div>Lũy kế {inUnit(unit, cum)}</div>}
          </>
        );
      }}
    />
  );
}

/** Result lines of a group of trades for a tooltip. */
function GroupLines({ g, fees }: { g: { count: number; wins: number; flats: number; losses: number; r: number; pnl: number }; fees: number }) {
  return (
    <>
      <div>
        Ròng <span className={tone(g.pnl) ?? ""}>{usd(g.pnl)}</span> · <span className={tone(g.r) ?? ""}>{rMultiple(g.r)}</span>
      </div>
      <div>
        {g.count} lệnh: {g.wins} thắng · {g.flats} hòa · {g.losses} thua
      </div>
      <div className="soft">Phí {fees.toFixed(2)}$</div>
    </>
  );
}

/** Groups as rows, each with a bar for its result around zero. */
function Breakdown({ rows, unit, label }: { rows: GroupStats[]; unit: Unit; label?: (key: string) => ReactNode }) {
  const max = Math.max(...rows.map((g) => Math.abs(pick(unit, g))), 1e-9);
  return (
    <div className="scroll-x">
      <table className="table static">
        <thead>
          <tr>
            <th>Nhóm</th>
            <th className="right">Lệnh</th>
            <th className="right">Winrate</th>
            <th className="right">{unit === "r" ? "R" : "Lãi/lỗ"}</th>
            <th aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => {
            const v = pick(unit, g);
            const width = `${(Math.abs(v) / max) * 50}%`;
            return (
              <tr key={g.key}>
                <td>{label ? label(g.key) : <strong>{g.key}</strong>}</td>
                <td className="right num">{g.count}</td>
                <td className="right num" title={`${g.wins} thắng · ${g.flats} hòa · ${g.losses} thua`}>
                  {pct(g.winRate)}
                </td>
                <td className={`right num ${tone(v) ?? ""}`}>{inUnit(unit, v)}</td>
                <td className="mini-bar-cell" aria-hidden="true">
                  <div className="mini-bar">
                    <span style={v >= 0 ? { left: "50%", width, background: "var(--quest)" } : { right: "50%", width, background: "var(--heart)" }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- win rates

const profitFactor = (m: MeasureStats) => (m.profitFactor !== null ? m.profitFactor.toFixed(2) : m.won > 0 ? "∞ (chưa có lệnh lỗ)" : "—");

function WinRates({ stats: s }: { stats: PeriodStats }) {
  if (s.count === 0) return <div className="soft">Chưa có lệnh nào đóng trong khoảng này.</div>;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="rate-grid">
        <RateCard
          title="Theo lệnh"
          rate={pct(s.winRate)}
          hint={`${s.wins} / ${s.count} lệnh thắng`}
          parts={[
            { value: s.wins, color: "var(--quest)", label: `${s.wins} thắng` },
            { value: s.flats, color: "var(--stone)", label: `${s.flats} hòa` },
            { value: s.losses, color: "var(--heart)", label: `${s.losses} thua` },
          ]}
          rows={[
            ["Bỏ lệnh hòa", pct(s.winRateDecided)],
            ["Chuỗi thắng dài nhất", `${s.longestWinStreak} lệnh`],
            ["Chuỗi thua dài nhất", `${s.longestLossStreak} lệnh`],
          ]}
        />
        <RateCard
          title="Theo R"
          rate={pct(s.r.winShare)}
          hint="phần R thắng trong tổng R thắng + thua"
          parts={[
            { value: s.r.won, color: "var(--quest)", label: `${rMultiple(s.r.won)} thắng` },
            { value: -s.r.lost, color: "var(--heart)", label: `${rMultiple(s.r.lost)} thua` },
          ]}
          rows={[
            ["R ròng", rMultiple(s.r.net), tone(s.r.net)],
            ["Trung bình mỗi lệnh", rMultiple(s.r.perTrade), tone(s.r.perTrade)],
            ["TB lệnh thắng", rMultiple(s.r.avgWin)],
            ["TB lệnh thua", rMultiple(s.r.avgLoss)],
            ["Hệ số lãi (thắng ÷ thua)", profitFactor(s.r)],
            ["Lệnh tốt / tệ nhất", `${rMultiple(s.r.best)} / ${rMultiple(s.r.worst)}`],
          ]}
        />
        <RateCard
          title="Theo tiền thật"
          rate={pct(s.usd.winShare)}
          hint="phần tiền thắng trong tổng tiền thắng + thua"
          parts={[
            { value: s.usd.won, color: "var(--quest)", label: `${usd(s.usd.won)} thắng` },
            { value: -s.usd.lost, color: "var(--heart)", label: `${usd(s.usd.lost)} thua` },
          ]}
          rows={[
            ["Lãi/lỗ ròng", usd(s.usd.net), tone(s.usd.net)],
            ["Phí đã trả", `${s.usd.fees.toFixed(2)}$`],
            ["Trung bình mỗi lệnh", usd(s.usd.perTrade), tone(s.usd.perTrade)],
            ["TB lệnh thắng", usd(s.usd.avgWin)],
            ["TB lệnh thua", usd(s.usd.avgLoss)],
            ["Hệ số lãi (thắng ÷ thua)", profitFactor(s.usd)],
            ["Lệnh tốt / tệ nhất", `${usd(s.usd.best)} / ${usd(s.usd.worst)}`],
          ]}
        />
      </div>
      <div className="soft" style={{ fontSize: 12 }}>
        Hòa: lệnh thoát ở SL đã dời về giá vào, hoặc kết quả trong ±0.05R. Mọi số đã trừ phí. Lệnh tính vào ngày đóng, giờ Việt Nam.
      </div>
    </div>
  );
}

function RateCard(props: { title: string; rate: string; hint: string; parts: { value: number; color: string; label: string }[]; rows: [string, ReactNode, ("up" | "down" | undefined)?][] }) {
  const total = props.parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  return (
    <div className="rate-card">
      <div className="label">{props.title}</div>
      <div className="rate-value">{props.rate}</div>
      <div className="soft" style={{ fontSize: 12 }}>
        {props.hint}
      </div>
      <div className="split" role="img" aria-label={props.parts.map((p) => p.label).join(", ")}>
        {total > 0 && props.parts.map((p) => (p.value > 0 ? <span key={p.label} style={{ flexGrow: p.value, background: p.color }} /> : null))}
      </div>
      <div className="split-legend">
        {props.parts.map((p) => (
          <span key={p.label}>
            <span className="swatch" style={{ background: p.color }} />
            {p.label}
          </span>
        ))}
      </div>
      <dl className="rate-rows">
        {props.rows.map(([k, v, t]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={t ?? ""}>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------- day table

function DayTable({ days, unit }: { days: DayStats[]; unit: Unit }) {
  let running = 0;
  const rows = days.map((d) => ({ d, cum: (running += pick(unit, d)) })).filter((r) => r.d.count > 0).reverse();
  return (
    <div className="scroll-x">
      <table className="table static">
        <thead>
          <tr>
            <th>Ngày</th>
            <th className="right">Lệnh</th>
            <th>Thắng · hòa · thua</th>
            <th className="right">Winrate</th>
            <th className="right">R</th>
            <th className="right">Lãi/lỗ</th>
            <th className="right">Phí</th>
            <th className="right">Lũy kế ({unit === "r" ? "R" : "$"})</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ d, cum }) => (
            <tr key={d.day}>
              <td className="num">
                {weekday(d.day)} {dayLabel(d.day)}
              </td>
              <td className="right num">{d.count}</td>
              <td className="num">
                {d.wins} · {d.flats} · {d.losses}
              </td>
              <td className="right num">{pct(d.wins / d.count)}</td>
              <td className={`right num ${tone(d.r) ?? ""}`}>{rMultiple(d.r)}</td>
              <td className={`right num ${tone(d.pnl) ?? ""}`}>{usd(d.pnl)}</td>
              <td className="right num soft">{d.fees.toFixed(2)}$</td>
              <td className={`right num ${tone(cum) ?? ""}`}>{inUnit(unit, cum)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- chart

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const f = raw / power;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * power;
}

/** Linear scale over [min, max] (0 always inside) with round ticks, top → bottom in pixels. */
function niceScale(min: number, max: number, top: number, bottom: number, fallback: number, tickCount: number) {
  let lo = Math.min(0, min);
  let hi = Math.max(0, max);
  if (hi - lo < 1e-9) {
    lo = -fallback;
    hi = fallback;
  }
  const step = niceStep((hi - lo) / tickCount);
  lo = Math.floor(lo / step - 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { y: (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top), ticks, step };
}

function axisLabel(value: number, step: number, unit: Unit): string {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return `${signed(value, digits)}${unit === "r" ? "R" : "$"}`;
}

/** One bar position of a P&L chart: a day, a trade or a month. */
interface Slot {
  key: string;
  /** The bar; null when there is nothing in that slot (a day without trades). */
  value: number | null;
  /** Axis text, shown on every slot when there is room, otherwise only on major slots. */
  label: string;
  major: boolean;
  /** Not reached yet: no bar and no running total. */
  future?: boolean;
  /** Marked under the axis (today). */
  marker?: boolean;
}

const LEFT = 58;
const RIGHT = 16;
const TOP = 14;
const BARS_H = 190;
const LABELS_H = 30;
const CUM_H = 110;
const BOTTOM = 10;
const TIP_W = 250;

/** Results as bars above / below zero, with their running total underneath. */
function PnlChart({ slots, unit, names, tip }: { slots: Slot[]; unit: Unit; names: [string, string, string]; tip: (i: number, cum: number | null) => ReactNode }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = slots.length;
  const values = slots.map((s) => s.value ?? 0);
  let running = 0;
  const cum = values.map((v) => (running += v));
  const shown = slots.filter((s) => !s.future).length;
  const plotW = Math.max(0, width - LEFT - RIGHT);
  const band = n ? plotW / n : 0;
  const barW = Math.max(1, Math.min(26, band > 4 ? band - 2 : band));
  const x = (i: number) => LEFT + i * band + band / 2;
  const fallback = unit === "r" ? 1 : 5;
  const bars = niceScale(Math.min(...values), Math.max(...values), TOP, TOP + BARS_H, fallback, 4);
  const cumTop = TOP + BARS_H + LABELS_H;
  const shownCum = cum.slice(0, shown);
  const cumScale = niceScale(Math.min(0, ...shownCum), Math.max(0, ...shownCum), cumTop + 6, cumTop + CUM_H, fallback, 2);
  const height = cumTop + CUM_H + BOTTOM;
  const zero = bars.y(0);
  const filled = slots.map((s, i) => (s.value !== null ? i : -1)).filter((i) => i >= 0);
  const bestIdx = filled.reduce((a, i) => (a < 0 || values[i]! > values[a]! ? i : a), -1);
  const worstIdx = filled.reduce((a, i) => (a < 0 || values[i]! < values[a]! ? i : a), -1);
  const allLabels = band >= 18 + Math.max(...slots.map((s) => s.label.length)) * 3;
  const cumPoints = [`${LEFT},${cumScale.y(0)}`, ...shownCum.map((v, i) => `${x(i)},${cumScale.y(v)}`)].join(" ");
  const pointAt = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setHover(Math.min(n - 1, Math.max(0, Math.floor((e.clientX - box.left) / band))));
  };

  return (
    <div>
      <div className="chart-legend">
        <span>
          <span className="swatch" style={{ background: "var(--quest)" }} />
          {names[0]}
        </span>
        <span>
          <span className="swatch" style={{ background: "var(--heart)" }} />
          {names[1]}
        </span>
        <span>
          <span className="swatch line" style={{ background: "var(--sky)" }} />
          {names[2]}
        </span>
      </div>
      <div className="pnl-chart" ref={ref} onPointerLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`${names[0]} và ${names[1].toLowerCase()}, lũy kế ${inUnit(unit, shownCum.at(-1) ?? 0)}`}>
            {bars.ticks.map((v) => (
              <g key={`b${v}`}>
                <line x1={LEFT} x2={width - RIGHT} y1={bars.y(v)} y2={bars.y(v)} className="grid-line" />
                <text x={LEFT - 6} y={bars.y(v) + 4} textAnchor="end" className="axis-text">
                  {axisLabel(v, bars.step, unit)}
                </text>
              </g>
            ))}
            {hover !== null && <rect x={LEFT + hover * band} y={TOP} width={Math.max(band, 2)} height={cumTop + CUM_H - TOP} className="hover-band" />}
            {slots.map((s, i) => {
              if (s.value === null) return null;
              const v = s.value;
              const y = bars.y(v);
              return <rect key={s.key} x={x(i) - barW / 2} y={Math.min(y, zero)} width={barW} height={Math.max(2, Math.abs(y - zero))} style={{ fill: v > 0 ? "var(--quest)" : v < 0 ? "var(--heart)" : "var(--stone)" }} />;
            })}
            <line x1={LEFT} x2={width - RIGHT} y1={zero} y2={zero} className="zero-line" />
            {[bestIdx, worstIdx]
              .filter((i, k, list) => i >= 0 && list.indexOf(i) === k && values[i] !== 0)
              .map((i) => {
                const v = values[i]!;
                return (
                  <text key={`l${i}`} x={Math.min(Math.max(x(i), LEFT + 24), width - RIGHT - 24)} y={v > 0 ? bars.y(v) - 5 : bars.y(v) + 14} textAnchor="middle" className="value-text">
                    {inUnit(unit, v)}
                  </text>
                );
              })}
            {slots.map((s, i) =>
              allLabels || s.major ? (
                <text key={`d${s.key}`} x={x(i)} y={TOP + BARS_H + 19} textAnchor="middle" className={`axis-text${s.marker ? " today" : ""}${s.future ? " future" : ""}`}>
                  {s.label}
                </text>
              ) : null,
            )}
            {slots.map((s, i) => (s.marker ? <rect key={`m${s.key}`} x={x(i) - 3} y={TOP + BARS_H + 24} width={6} height={4} style={{ fill: "var(--coin)" }} /> : null))}
            {cumScale.ticks.map((v) => (
              <g key={`c${v}`}>
                <line x1={LEFT} x2={width - RIGHT} y1={cumScale.y(v)} y2={cumScale.y(v)} className={v === 0 ? "zero-line soft" : "grid-line"} />
                <text x={LEFT - 6} y={cumScale.y(v) + 4} textAnchor="end" className="axis-text">
                  {axisLabel(v, cumScale.step, unit)}
                </text>
              </g>
            ))}
            {shown > 0 && <polyline points={cumPoints} className="cum-line" />}
            {shownCum.map((v, i) => ((slots[i]!.value !== null && band >= 6) || i === hover ? <circle key={`p${i}`} cx={x(i)} cy={cumScale.y(v)} r={4} className="cum-dot" /> : null))}
            {/* one hit target over the plot; the slot under the pointer is hovered */}
            <rect x={LEFT} y={TOP} width={plotW} height={cumTop + CUM_H - TOP} fill="transparent" onPointerMove={pointAt} onPointerDown={pointAt} />
          </svg>
        )}
        {hover !== null && (
          <div className="pnl-tip" style={{ left: x(hover) + 14 + TIP_W <= width ? x(hover) + 14 : Math.max(0, x(hover) - 14 - TIP_W), top: 6 }}>
            {tip(hover, hover < shown ? cum[hover]! : null)}
          </div>
        )}
      </div>
    </div>
  );
}
