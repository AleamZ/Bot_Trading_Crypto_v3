import { ArrowClockwiseIcon, CheckIcon, MinusIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { ChartView, DEFAULT_LAYERS, type Layers } from "../ChartView";
import { clock, dateTime, duration, price, rMultiple, usd } from "../format";
import { useLoad, useNow, type Live, type Route } from "../hooks";
import { METHODS, type ChartResponse, type Check, type EntryPreview, type MethodId, type SideExplanation } from "../types";
import { Button, Chip, DirectionChip, LevelChip, Meter, Notice, Panel, Tabs } from "../ui";

const LAYER_LABELS: [keyof Layers, string][] = [
  ["ema", "A · EMA"],
  ["donchian", "B · Kênh Donchian"],
  ["smc", "C · Swing + FVG"],
  ["signals", "Tín hiệu A/B/C"],
  ["episodes", "2/3 · 3/3"],
  ["trades", "Lệnh của bot"],
  ["volume", "Volume"],
];

const LAYERS_KEY = "bot3.chartLayers";
const OPACITY_KEY = "bot3.zoneOpacity";

function readOpacity(): number {
  try {
    const stored = Number(localStorage.getItem(OPACITY_KEY));
    return stored >= 10 && stored <= 100 ? stored : 70;
  } catch {
    return 70;
  }
}

function readLayers(): Layers {
  try {
    return { ...DEFAULT_LAYERS, ...(JSON.parse(localStorage.getItem(LAYERS_KEY) ?? "{}") as Partial<Layers>) };
  } catch {
    return DEFAULT_LAYERS;
  }
}

export function Analysis({ live, symbol, go }: { live: Live; symbol: string | null; go: (route: Route, param?: string) => void }) {
  const symbols = live.analysis.map((a) => a.symbol);
  const current = symbol ?? symbols[0] ?? "BTCUSDT";
  const view = live.analysis.find((a) => a.symbol === current);
  // Reload when the bot finishes a new scan of this symbol.
  const chart = useLoad(() => api.chart(current, 300), [current, view?.time]);
  const [layers, setLayers] = useState<Layers>(readLayers);
  const [opacity, setOpacity] = useState(readOpacity);
  const [other, setOther] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(LAYERS_KEY, JSON.stringify(layers));
    } catch {
      // storage blocked: the choice lasts until reload
    }
  }, [layers]);

  useEffect(() => {
    try {
      localStorage.setItem(OPACITY_KEY, String(opacity));
    } catch {
      // storage blocked: the choice lasts until reload
    }
  }, [opacity]);

  const data = chart.data?.symbol === current ? chart.data : null;
  return (
    <>
      <div className="row between">
        <Tabs label="Symbol" value={current} onChange={(s) => go("analysis", s)} items={[...new Set([...symbols, current])].map((s) => ({ id: s, label: s }))} />
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (other.trim()) go("analysis", other.trim().toUpperCase());
            setOther("");
          }}
        >
          <input className="input" style={{ width: 150 }} placeholder="Symbol khác" value={other} onChange={(e) => setOther(e.target.value)} aria-label="Xem symbol khác" />
          <Button tone="plain" small type="submit">
            Xem
          </Button>
        </form>
      </div>
      {chart.error && <Notice tone="heart">{chart.error}</Notice>}
      <div className="grid3">
        <Panel
          className="span2"
          title={`${current} · nến ${data?.timeframe ?? ""}`}
          sub={data ? `giờ Việt Nam · ${data.candles.length} nến` : chart.loading ? "đang tải…" : ""}
          actions={
            <Button tone="plain" small icon={<ArrowClockwiseIcon size={12} weight="bold" />} onClick={() => void chart.reload()} title="Tải lại">
              Tải lại
            </Button>
          }
          flush
        >
          <div className="layer-bar">
            {LAYER_LABELS.map(([key, label]) => (
              <label key={key} className="check-row layer">
                <input type="checkbox" className="check small" checked={layers[key]} onChange={(e) => setLayers({ ...layers, [key]: e.target.checked })} />
                {label}
              </label>
            ))}
            <label className="check-row layer">
              Độ đậm vùng TP/SL
              <input type="range" className="range" min={10} max={100} step={5} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Độ đậm vùng TP/SL" />
              <span className="num">{opacity}%</span>
            </label>
          </div>
          {data ? <ChartView data={data} layers={layers} zoneOpacity={opacity / 100} /> : <div className="chart-host empty-state">{chart.loading ? "Đang tải nến…" : "Chưa có dữ liệu"}</div>}
          <Legend />
        </Panel>
        <div className="stack">{data && <Verdict data={data} />}</div>
      </div>
      {data && (
        <div className="grid3">
          {METHODS.map((m) => (
            <MethodCard key={m.id} id={m.id} data={data} />
          ))}
        </div>
      )}
      {data && <RecentTriggers data={data} />}
    </>
  );
}

function Legend() {
  return (
    <div className="legend soft">
      <span>▲▼ A/B/C: lần phương pháp kích hoạt</span>
      <span>● 2/3: báo SẴN SÀNG</span>
      <span>■ 3/3: vào lệnh</span>
      <span>Đường đứt: EMA khung lớn</span>
      <span>Đường chấm: kênh Donchian</span>
      <span>Hộp có viền: vùng FVG còn mở (nhạt: đã lấp)</span>
      <span>Vùng xanh / đỏ: TP / SL</span>
      <span>Đường xanh đứt: SL đã dời</span>
    </div>
  );
}

/** What the bot concludes on the last closed candle, and what it would do. */
function Verdict({ data }: { data: ChartResponse }) {
  const now = useNow();
  const a = data.analysis;
  const c = a.consensus;
  const best = Math.max(c.longCount, c.shortCount);
  const need = c.level === "ENTER" ? null : best >= data.thresholds.alert ? data.thresholds.entry : data.thresholds.alert;
  // The page fetches candles itself, so it can show a new close a few seconds before the bot scans it.
  const scanned = data.lastScanAt !== null && data.lastScanAt >= a.time;
  const episode = scanned && a.episode && a.episode.direction === c.direction ? a.episode : null;
  const readyText = !scanned
    ? `Đủ ${best}/3: bot sẽ báo SẴN SÀNG khi quét nến này (vài giây sau khi nến đóng).`
    : episode && episode.startedAt < a.time
      ? `Đủ ${best}/3: đã báo SẴN SÀNG lúc ${clock(episode.startedAt + 1)} (mỗi đợt chỉ báo một lần).`
      : `Đủ ${best}/3: đã báo SẴN SÀNG.`;
  return (
    <>
      <Panel title="Bot đang thấy gì" sub={`nến đóng ${dateTime(a.time + 1)}`}>
        <div style={{ display: "grid", gap: 12 }}>
          <div className="row">
            <LevelChip level={c.level} />
            <DirectionChip direction={c.direction} />
            <span className="soft">
              LONG {c.longCount} · SHORT {c.shortCount}
            </span>
          </div>
          <Meter label="Đồng thuận" value={best} max={3} tone={c.direction === "SHORT" ? "heart" : "quest"} display={`${best}/3`} />
          <div>
            {c.level === "ENTER"
              ? scanned
                ? "Đủ 3/3 cùng chiều: bot thử vào lệnh (nếu các giới hạn cho phép)."
                : "Đủ 3/3 cùng chiều: bot sẽ thử vào lệnh khi quét nến này (nếu các giới hạn cho phép)."
              : c.level === "READY"
                ? `${readyText} Cần ${data.thresholds.entry}/3 và không có phương pháp ngược chiều để vào lệnh.`
                : need
                  ? `Chưa đủ: cần ${need}/3 cùng chiều${need === data.thresholds.alert ? " để báo SẴN SÀNG" : ""}.`
                  : "Chưa có tín hiệu."}
          </div>
          {METHODS.map((m) => {
            const s = a.methods[m.id];
            return (
              <div key={m.id} className="row" style={{ alignItems: "flex-start" }}>
                <strong style={{ width: 18 }}>{m.letter}</strong>
                {!s.enabled ? (
                  <span className="soft">đang tắt</span>
                ) : s.signal ? (
                  <span>
                    <DirectionChip direction={s.signal.direction} /> <span className="soft">{s.signal.reason} · SL {price(s.signal.stopLoss)}</span>
                  </span>
                ) : (
                  <span className="soft">không có tín hiệu còn hiệu lực</span>
                )}
              </div>
            );
          })}
          <div className="soft" style={{ fontSize: 12 }}>
            Quét gần nhất {clock(data.lastScanAt)}
            {data.nextScanAt ? ` · lần tới ${clock(data.nextScanAt)} (còn ${duration(data.nextScanAt - now)})` : ""}
            {!data.inWatchlist && " · symbol này không nằm trong danh sách bot quét"}
          </div>
        </div>
      </Panel>
      <Panel title="Nếu vào lệnh lúc này" sub={data.preview ? `${data.preview.direction} theo ${data.preview.agreeing} phương pháp` : undefined}>
        <Preview preview={data.preview} />
        <hr className="divider" />
        {data.guard.ok ? (
          <div className="row">
            <Chip tone="quest">Được phép</Chip>
            <span className="soft">Các giới hạn (vị thế, số lệnh, lỗ ngày, nghỉ, tạm dừng) không chặn symbol này.</span>
          </div>
        ) : (
          <div className="row">
            <Chip tone="heart">Bị chặn</Chip>
            <span>{data.guard.message}</span>
          </div>
        )}
      </Panel>
    </>
  );
}

function Preview({ preview }: { preview: EntryPreview | null }) {
  if (!preview) return <div className="soft">Chưa có phương pháp nào đang có tín hiệu, nên chưa có lệnh để tính.</div>;
  const s = preview.sizing;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="kv">
        <div>
          <span className="label">Giá vào (mark)</span>
          <strong>{price(preview.entryPrice)}</strong>
        </div>
        <div>
          <span className="label">SL gộp</span>
          <strong className="down">{price(s?.stopLoss ?? preview.stopLoss)}</strong>
          <span className="soft">
            {preview.stopPct.toFixed(2)}%{preview.atrMultiple !== null ? ` · ${preview.atrMultiple.toFixed(2)} ATR` : ""}
          </span>
        </div>
        {s && (
          <>
            <div>
              <span className="label">TP</span>
              <strong className="up">{price(s.takeProfit)}</strong>
              <span className="soft">{rMultiple(s.rewardR)} ròng</span>
            </div>
            <div>
              <span className="label">Khối lượng</span>
              <strong>{s.quantity}</strong>
              <span className="soft">{usd(s.notional)} giá trị</span>
            </div>
            <div>
              <span className="label">Lỗ nếu chạm SL</span>
              <strong>{s.riskAtStop}$</strong>
              <span className="soft">{rMultiple(-s.riskR)}</span>
            </div>
          </>
        )}
        {preview.margin && (
          <div>
            <span className="label">Đòn bẩy · ký quỹ</span>
            <strong>
              {preview.margin.leverage}x · {preview.margin.margin.toFixed(2)}$
            </strong>
            <span className="soft">
              tối đa {preview.margin.maxLeverage}x · thanh lý ~{price(preview.margin.liquidationPrice)}
            </span>
          </div>
        )}
      </div>
      {preview.ok ? (
        <Chip tone="quest">Lệnh hợp lệ</Chip>
      ) : (
        <Notice tone="heart" title={`Không vào được: ${preview.reason}`}>
          {preview.detail}
        </Notice>
      )}
      {preview.notes.map((n) => (
        <div key={n} className="soft" style={{ fontSize: 12 }}>
          {n}
        </div>
      ))}
    </div>
  );
}

const ICON = {
  true: <CheckIcon size={12} weight="bold" />,
  false: <XIcon size={12} weight="bold" />,
  null: <MinusIcon size={12} weight="bold" />,
};

function CheckRow({ check }: { check: Check }) {
  const state = check.pass === null ? "null" : check.pass ? "true" : "false";
  return (
    <li className={`check-item ${state === "true" ? "ok" : state === "false" ? "no" : "unknown"}`}>
      <span className="check-icon">{ICON[state]}</span>
      <span>
        {check.label}
        {check.detail && <span className="soft"> · {check.detail}</span>}
      </span>
    </li>
  );
}

function SideList({ side }: { side: SideExplanation }) {
  return (
    <div className={`side ${side.ready ? "ready" : ""}`}>
      <div className="row between">
        <DirectionChip direction={side.direction} />
        <span className="num soft">
          {side.passed}/{side.checks.length} điều kiện{side.ready ? " · KÍCH HOẠT" : ""}
        </span>
      </div>
      <ul className="checklist">
        {side.checks.map((c, i) => (
          <CheckRow key={i} check={c} />
        ))}
      </ul>
    </div>
  );
}

function MethodCard({ id, data }: { id: MethodId; data: ChartResponse }) {
  const method = METHODS.find((m) => m.id === id)!;
  const explanation = data.explanation[id];
  const closest = useMemo(() => (explanation ? [...explanation.sides].sort((a, b) => b.passed - a.passed) : []), [explanation]);
  return (
    <Panel title={`${method.letter}. ${method.label}`} sub={explanation ? "điều kiện trên nến vừa đóng" : "đang tắt"}>
      {explanation ? (
        <div style={{ display: "grid", gap: 14 }}>
          {closest.map((side) => (
            <SideList key={side.direction} side={side} />
          ))}
        </div>
      ) : (
        <div className="soft">Bật phương pháp này trong Cài đặt để bot dùng nó.</div>
      )}
    </Panel>
  );
}

function RecentTriggers({ data }: { data: ChartResponse }) {
  const recent = [...data.overlays.signals].reverse().slice(0, 12);
  return (
    <Panel title="Các lần kích hoạt gần đây" sub={`trên ${data.candles.length} nến của chart`} flush>
      {recent.length === 0 ? (
        <div className="empty-state">Không phương pháp nào kích hoạt trong khoảng này.</div>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Nến</th>
                <th>PP</th>
                <th>Chiều</th>
                <th className="right">Giá</th>
                <th className="right">SL</th>
                <th>Lý do</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((s) => (
                <tr key={`${s.method}-${s.index}`} style={{ cursor: "default" }}>
                  <td className="num">{dateTime(s.openTime)}</td>
                  <td>{METHODS.find((m) => m.id === s.method)?.letter}</td>
                  <td>
                    <DirectionChip direction={s.direction} />
                  </td>
                  <td className="right num">{price(s.price)}</td>
                  <td className="right num">{price(s.stopLoss)}</td>
                  <td style={{ whiteSpace: "normal" }}>{s.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
