import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { rMultiple, signed, usd } from "../format";
import { useLoad, type Live, type Route } from "../hooks";
import type { DayStats, MeasureStats, PeriodStats } from "../types";
import { Button, Notice, Panel, Stat, Tabs } from "../ui";

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
const valueOf = (day: DayStats, unit: Unit) => (unit === "r" ? day.r : day.pnl);
const tone = (value: number | null) => (value === null ? undefined : value > 0 ? "up" : value < 0 ? "down" : undefined);

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + by, 1)).toISOString().slice(0, 7);
}

const monthLabel = (month: string) => `Tháng ${Number(month.slice(5, 7))}/${month.slice(0, 4)}`;
const dayLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const weekday = (day: string) => WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];

export function StatsPage({ live, month, go }: { live: Live; month: string | null; go: (route: Route, param?: string) => void }) {
  const [unit, setUnit] = useState<Unit>(readUnit);
  const [scope, setScope] = useState<"month" | "all">("month");
  // A trade closing writes a log entry: reload then.
  const stats = useLoad(() => api.stats(month ?? undefined), [month, live.lastLogId]);

  useEffect(() => {
    try {
      localStorage.setItem(UNIT_KEY, unit);
    } catch {
      // storage blocked: the choice lasts until reload
    }
  }, [unit]);

  const data = stats.data;
  if (!data) return stats.error ? <Notice tone="heart">{stats.error}</Notice> : <div className="empty-state">Đang tải…</div>;

  const thisMonth = data.today.slice(0, 7);
  const open = (target: string) => go("stats", target === thisMonth ? undefined : target);
  const elapsed = data.days.filter((d) => d.day <= data.today && d.count > 0);
  const green = elapsed.filter((d) => valueOf(d, unit) > 0).length;
  const red = elapsed.filter((d) => valueOf(d, unit) < 0).length;
  const best = elapsed.length ? elapsed.reduce((a, b) => (valueOf(b, unit) > valueOf(a, unit) ? b : a)) : null;
  const worst = elapsed.length ? elapsed.reduce((a, b) => (valueOf(b, unit) < valueOf(a, unit) ? b : a)) : null;
  const t = data.totals;
  const net = unit === "r" ? t.r.net : t.usd.net;

  return (
    <>
      <div className="row between">
        <div className="row">
          <Button tone="plain" small icon={<CaretLeftIcon size={14} weight="bold" />} disabled={!data.firstMonth || data.month <= data.firstMonth} onClick={() => open(shiftMonth(data.month, -1))}>
            Tháng trước
          </Button>
          <strong>{monthLabel(data.month)}</strong>
          <Button tone="plain" small icon={<CaretRightIcon size={14} weight="bold" />} disabled={data.month >= thisMonth} onClick={() => open(shiftMonth(data.month, 1))}>
            Tháng sau
          </Button>
        </div>
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
      {stats.error && <Notice tone="heart">{stats.error}</Notice>}
      <div className="stats">
        <Stat label="Lãi/lỗ ròng tháng" value={inUnit(unit, net)} tone={tone(net)} hint={`${unit === "r" ? usd(t.usd.net) : rMultiple(t.r.net)} · phí ${t.usd.fees.toFixed(2)}$`} />
        <Stat label="Winrate theo lệnh" value={pct(t.winRate)} hint={`${t.wins} thắng · ${t.flats} hòa · ${t.losses} thua`} />
        <Stat label="Ngày lãi / ngày lỗ" value={`${green} / ${red}`} hint={`${elapsed.length} ngày có lệnh đóng`} />
        <Stat label="Ngày tốt nhất" value={best ? inUnit(unit, valueOf(best, unit)) : "—"} tone={best ? tone(valueOf(best, unit)) : undefined} hint={best ? dayLabel(best.day) : undefined} />
        <Stat label="Ngày tệ nhất" value={worst ? inUnit(unit, valueOf(worst, unit)) : "—"} tone={worst ? tone(valueOf(worst, unit)) : undefined} hint={worst ? dayLabel(worst.day) : undefined} />
      </div>
      <Panel title="Lãi/lỗ từng ngày" sub={`${monthLabel(data.month)} · ${unit === "r" ? "R" : "USDT"} · tài khoản ${live.status?.binanceEnv ?? "…"}`} flush>
        {t.count === 0 ? <div className="empty-state">{monthLabel(data.month)} chưa có lệnh nào đóng.</div> : <DailyChart days={data.days} unit={unit} today={data.today} />}
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
  const rows = days.map((d) => ({ d, cum: (running += valueOf(d, unit)) })).filter((r) => r.d.count > 0).reverse();
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

const LEFT = 58;
const RIGHT = 16;
const TOP = 14;
const BARS_H = 190;
const LABELS_H = 30;
const CUM_H = 110;
const BOTTOM = 10;
const TIP_W = 250;

/** Daily net result as bars above / below zero, with the running total of the month underneath. */
function DailyChart({ days, unit, today }: { days: DayStats[]; unit: Unit; today: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = days.length;
  const values = days.map((d) => valueOf(d, unit));
  let running = 0;
  const cum = values.map((v) => (running += v));
  // Days up to today (the whole month once it is over).
  const shown = days.filter((d) => d.day <= today).length;
  const plotW = Math.max(0, width - LEFT - RIGHT);
  const band = n ? plotW / n : 0;
  const barW = Math.max(2, Math.min(26, band - 2));
  const x = (i: number) => LEFT + i * band + band / 2;
  const fallback = unit === "r" ? 1 : 5;
  const traded = days.map((d, i) => (d.count > 0 ? values[i]! : 0));
  const bars = niceScale(Math.min(...traded), Math.max(...traded), TOP, TOP + BARS_H, fallback, 4);
  const cumTop = TOP + BARS_H + LABELS_H;
  const shownCum = cum.slice(0, shown);
  const cumScale = niceScale(Math.min(0, ...shownCum), Math.max(0, ...shownCum), cumTop + 6, cumTop + CUM_H, fallback, 2);
  const height = cumTop + CUM_H + BOTTOM;
  const zero = bars.y(0);
  const tradedIdx = days.map((d, i) => (d.count > 0 ? i : -1)).filter((i) => i >= 0);
  const bestIdx = tradedIdx.reduce((a, i) => (a < 0 || values[i]! > values[a]! ? i : a), -1);
  const worstIdx = tradedIdx.reduce((a, i) => (a < 0 || values[i]! < values[a]! ? i : a), -1);
  const everyDay = band >= 18;
  const todayIdx = days.findIndex((d) => d.day === today);
  const cumPoints = [`${LEFT},${cumScale.y(0)}`, ...shownCum.map((v, i) => `${x(i)},${cumScale.y(v)}`)].join(" ");
  const hovered = hover !== null ? days[hover] : null;

  return (
    <div>
      <div className="chart-legend">
        <span>
          <span className="swatch" style={{ background: "var(--quest)" }} />
          Ngày lãi
        </span>
        <span>
          <span className="swatch" style={{ background: "var(--heart)" }} />
          Ngày lỗ
        </span>
        <span>
          <span className="swatch line" style={{ background: "var(--sky)" }} />
          Lũy kế trong tháng
        </span>
      </div>
      <div className="pnl-chart" ref={ref} onPointerLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`Lãi lỗ từng ngày, lũy kế ${inUnit(unit, shownCum.at(-1) ?? 0)}`}>
            {/* bars: grid, zero line, bars */}
            {bars.ticks.map((v) => (
              <g key={`b${v}`}>
                <line x1={LEFT} x2={width - RIGHT} y1={bars.y(v)} y2={bars.y(v)} className="grid-line" />
                <text x={LEFT - 6} y={bars.y(v) + 4} textAnchor="end" className="axis-text">
                  {axisLabel(v, bars.step, unit)}
                </text>
              </g>
            ))}
            {hover !== null && <rect x={LEFT + hover * band} y={TOP} width={band} height={cumTop + CUM_H - TOP} className="hover-band" />}
            {days.map((d, i) => {
              if (d.count === 0) return null;
              const v = values[i]!;
              const y = bars.y(v);
              return <rect key={d.day} x={x(i) - barW / 2} y={Math.min(y, zero)} width={barW} height={Math.max(2, Math.abs(y - zero))} style={{ fill: v > 0 ? "var(--quest)" : v < 0 ? "var(--heart)" : "var(--stone)" }} />;
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
            {/* day numbers */}
            {days.map((d, i) => {
              const dayNo = Number(d.day.slice(8, 10));
              if (!everyDay && dayNo !== 1 && dayNo % 5 !== 0) return null;
              return (
                <text key={`d${d.day}`} x={x(i)} y={TOP + BARS_H + 19} textAnchor="middle" className={`axis-text${i === todayIdx ? " today" : ""}${d.day > today ? " future" : ""}`}>
                  {dayNo}
                </text>
              );
            })}
            {todayIdx >= 0 && <rect x={x(todayIdx) - 3} y={TOP + BARS_H + 24} width={6} height={4} style={{ fill: "var(--coin)" }} />}
            {/* running total */}
            {cumScale.ticks.map((v) => (
              <g key={`c${v}`}>
                <line x1={LEFT} x2={width - RIGHT} y1={cumScale.y(v)} y2={cumScale.y(v)} className={v === 0 ? "zero-line soft" : "grid-line"} />
                <text x={LEFT - 6} y={cumScale.y(v) + 4} textAnchor="end" className="axis-text">
                  {axisLabel(v, cumScale.step, unit)}
                </text>
              </g>
            ))}
            {shown > 0 && <polyline points={cumPoints} className="cum-line" />}
            {shownCum.map((v, i) => (days[i]!.count > 0 || i === hover ? <circle key={`p${i}`} cx={x(i)} cy={cumScale.y(v)} r={4} className="cum-dot" /> : null))}
            {/* hit targets, wider than the bars */}
            {days.map((d, i) => (
              <rect key={`h${d.day}`} x={LEFT + i * band} y={TOP} width={band} height={cumTop + CUM_H - TOP} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
            ))}
          </svg>
        )}
        {hovered && hover !== null && (
          <div className="pnl-tip" style={{ left: x(hover) + 14 + TIP_W <= width ? x(hover) + 14 : Math.max(0, x(hover) - 14 - TIP_W), top: 6 }}>
            <strong>
              {weekday(hovered.day)} {dayLabel(hovered.day)}
            </strong>
            {hovered.day > today ? (
              <div className="soft">Chưa tới</div>
            ) : hovered.count === 0 ? (
              <div className="soft">Không có lệnh đóng</div>
            ) : (
              <>
                <div>
                  Ròng <span className={tone(hovered.pnl) ?? ""}>{usd(hovered.pnl)}</span> · <span className={tone(hovered.r) ?? ""}>{rMultiple(hovered.r)}</span>
                </div>
                <div>
                  {hovered.count} lệnh: {hovered.wins} thắng · {hovered.flats} hòa · {hovered.losses} thua
                </div>
                <div className="soft">Phí {hovered.fees.toFixed(2)}$</div>
              </>
            )}
            {hovered.day <= today && <div>Lũy kế {inUnit(unit, cum[hover]!)}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
