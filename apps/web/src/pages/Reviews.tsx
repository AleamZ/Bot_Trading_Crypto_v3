import { ArrowsClockwiseIcon, LightbulbIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { dateTime, price, rMultiple } from "../format";
import { ALL_DATES, DateFilter, rangeBounds, type DateRange } from "../DateFilter";
import { useLoad, type Live, type Route } from "../hooks";
import { METHODS, type InsightsRecord, type ReviewItem } from "../types";
import { Button, Chip, DirectionChip, ExitChip, Notice, Panel, Stat, Tabs, useToast } from "../ui";

const FILTERS = [
  { id: "all", label: "Tất cả", outcome: "" },
  { id: "LOSS", label: "Lệnh thua", outcome: "LOSS" },
  { id: "WIN", label: "Lệnh thắng", outcome: "WIN" },
] as const;

const AREA_LABEL: Record<string, string> = {
  trendPullback: "A. Xu hướng + hồi EMA",
  donchianBreakout: "B. Phá kênh Donchian",
  smcSweep: "C. SMC quét thanh khoản",
  risk: "Quản lý vốn",
  consensus: "Đồng thuận",
  general: "Chung",
};

const CONFIDENCE_TONE = { thấp: "stone", vừa: "coin", cao: "quest" } as const;

export function Reviews({ live, focus, go }: { live: Live; focus: string | null; go: (route: Route, param?: string) => void }) {
  const toast = useToast();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const outcome = FILTERS.find((f) => f.id === filter)!.outcome;
  const [dates, setDates] = useState<DateRange>(ALL_DATES);
  const reviews = useLoad(() => api.reviews({ limit: 100, outcome, ...rangeBounds(dates) }), [outcome, dates.from, dates.to, live.lastLogId]);
  const insights = useLoad(() => api.insights(), [live.lastLogId]);
  const [busy, setBusy] = useState<string | null>(null);
  const ai = live.status?.ai;

  async function rerun(tradeId: string) {
    setBusy(tradeId);
    try {
      const r = await api.reviewTrade(tradeId);
      toast(r.status === "DONE" ? "AI đã phân tích xong" : `AI chưa phân tích được: ${r.error}`, r.status === "DONE" ? "quest" : "heart");
      void reviews.reload();
    } catch (e) {
      toast(errorMessage(e), "heart");
    } finally {
      setBusy(null);
    }
  }

  async function makeInsights() {
    setBusy("insights");
    try {
      await api.makeInsights();
      void insights.reload();
      toast("Đã tổng hợp bài học", "quest");
    } catch (e) {
      toast(errorMessage(e), "heart");
    } finally {
      setBusy(null);
    }
  }

  const items = reviews.data?.items ?? [];
  const shown = focus ? [...items].sort((a, b) => (a.tradeId === focus ? -1 : b.tradeId === focus ? 1 : 0)) : items;
  // Opened from a trade that has no review yet (an older trade, or a manual close): offer to run one.
  const unreviewed = focus && filter === "all" && reviews.data && !items.some((r) => r.tradeId === focus);
  return (
    <>
      {ai && !ai.enabled && (
        <Notice tone="coin" title="AI đang tắt">
          {ai.hint} Trên VPS, router AI chạy ở <code>http://localhost:20128/v1</code>.
        </Notice>
      )}
      <Panel
        title="Bài học tổng hợp"
        sub={insights.data?.insights ? `${insights.data.insights.reviewCount} lệnh · ${dateTime(insights.data.insights.createdAt)}` : "chưa có"}
        actions={
          <Button tone="sky" small disabled={busy !== null || !ai?.enabled} onClick={makeInsights} icon={<LightbulbIcon size={12} weight="bold" />}>
            {busy === "insights" ? "Đang tổng hợp…" : "Tổng hợp"}
          </Button>
        }
      >
        {insights.data?.insights ? (
          <InsightsView insights={insights.data.insights} />
        ) : (
          <div className="soft">Bấm "Tổng hợp" để AI đọc các lệnh đã phân tích, tìm mẫu thắng/thua lặp lại và đề xuất thay đổi logic để thử.</div>
        )}
      </Panel>
      {unreviewed && (
        <Notice tone="sky" title="Lệnh này chưa được AI phân tích">
          <div className="row" style={{ marginTop: 6 }}>
            <span className="soft">Lệnh {focus}</span>
            <Button tone="sky" small disabled={busy !== null || !ai?.enabled} onClick={() => rerun(focus)} icon={<ArrowsClockwiseIcon size={12} weight="bold" />}>
              {busy === focus ? "Đang phân tích…" : "Phân tích ngay"}
            </Button>
          </div>
        </Notice>
      )}
      <Tabs label="Lọc" value={filter} onChange={setFilter} items={FILTERS.map((f) => ({ id: f.id, label: f.label }))} />
      <DateFilter value={dates} onChange={setDates} />
      {reviews.error && <Notice tone="heart">{reviews.error}</Notice>}
      {shown.length === 0 ? (
        <Panel title="Phân tích từng lệnh">
          <div className="soft">
            {reviews.loading ? "Đang tải…" : "Chưa có lệnh nào được phân tích. Mỗi lệnh chạm TP hoặc SL sẽ được AI phân tích tự động (Cài đặt → AI)."}
          </div>
        </Panel>
      ) : (
        <div className="stack">
          {shown.map((r) => (
            <ReviewCard key={r.tradeId} item={r} focused={r.tradeId === focus} busy={busy === r.tradeId} canRun={Boolean(ai?.enabled) && busy === null} onRerun={() => rerun(r.tradeId)} go={go} />
          ))}
        </div>
      )}
    </>
  );
}

function InsightsView({ insights }: { insights: InsightsRecord }) {
  const s = insights.stats;
  const r = insights.result;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="stats">
        <Stat label="Lệnh đã phân tích" value={s.overall.trades} hint={`thắng ${s.overall.wins} · thua ${s.overall.losses}`} />
        <Stat label="Tỉ lệ thắng" value={`${Math.round(s.overall.winRate * 100)}%`} />
        <Stat label="Tổng R" value={rMultiple(s.overall.totalR)} tone={s.overall.totalR >= 0 ? "up" : "down"} />
        {METHODS.map((m) => {
          const x = s.byMethod[m.id];
          return x ? <Stat key={m.id} label={`Có ${m.letter}`} value={rMultiple(x.totalR)} tone={x.totalR >= 0 ? "up" : "down"} hint={`${x.trades} lệnh · thắng ${Math.round(x.winRate * 100)}%`} /> : null;
        })}
      </div>
      <div>{r.overview}</div>
      <TwoLists left={["Mẫu lặp lại", r.patterns]} right={["Điểm yếu", r.weaknesses]} />
      {r.recommendations.length > 0 && (
        <div>
          <div className="label">Đề xuất thay đổi để thử</div>
          <ul className="plain-list">
            {r.recommendations.map((x, i) => (
              <li key={i}>
                <Chip tone={CONFIDENCE_TONE[x.confidence as keyof typeof CONFIDENCE_TONE] ?? "stone"}>{x.confidence}</Chip> <strong>{AREA_LABEL[x.area] ?? x.area}:</strong> {x.change}
                {x.why && <span className="soft"> · {x.why}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.nextExperiments.length > 0 && <TwoLists left={["Thử nghiệm nên chạy", r.nextExperiments]} />}
      <div className="soft" style={{ fontSize: 12 }}>
        Mô hình {insights.model}. Đây là gợi ý từ AI trên mẫu nhỏ: kiểm tra bằng backtest (<code>npm run backtest -- --set ...</code>) trước khi đổi cài đặt.
      </div>
    </div>
  );
}

function TwoLists({ left, right }: { left: [string, string[]]; right?: [string, string[]] }) {
  return (
    <div className="grid3" style={{ gap: 14 }}>
      {[left, right].map((pair) =>
        pair && pair[1].length > 0 ? (
          <div key={pair[0]} className={right ? "" : "span3"}>
            <div className="label">{pair[0]}</div>
            <ul className="plain-list">
              {pair[1].map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </div>
  );
}

function ReviewCard({ item, focused, busy, canRun, onRerun, go }: { item: ReviewItem; focused: boolean; busy: boolean; canRun: boolean; onRerun: () => void; go: (route: Route, param?: string) => void }) {
  const t = item.trade;
  const r = item.review;
  const path = item.facts?.path;
  const tone = item.outcome === "WIN" ? "quest" : item.outcome === "LOSS" ? "heart" : "stone";
  return (
    <section className={`panel review-card ${focused ? "focused" : ""}`}>
      <header className="panel-head">
        <h2 className="panel-title row">
          {item.symbol}
          {t && <DirectionChip direction={t.direction} />}
          <Chip tone={tone}>{item.outcome === "WIN" ? "Thắng" : item.outcome === "LOSS" ? "Thua" : "Hoà"}</Chip>
          {t && <ExitChip reason={t.exitReason} trade={t} />}
          {t && <span className="num">{rMultiple(t.pnlR)}</span>}
        </h2>
        <div className="row">
          <span className="panel-sub">{t ? `${dateTime(t.openedAt)} → ${dateTime(t.closedAt)}` : dateTime(item.updatedAt)}</span>
          <Button tone="plain" small onClick={() => go("analysis", item.symbol)}>
            Chart
          </Button>
          <Button tone="plain" small disabled={!canRun} onClick={onRerun} icon={<ArrowsClockwiseIcon size={12} weight="bold" />}>
            {busy ? "Đang phân tích…" : "Phân tích lại"}
          </Button>
        </div>
      </header>
      <div className="panel-body" style={{ display: "grid", gap: 12 }}>
        {t && (
          <div className="kv">
            <div>
              <span className="label">Vào → thoát</span>
              <strong>
                {price(t.entryPrice)} → {price(t.exitPrice)}
              </strong>
            </div>
            <div>
              <span className="label">SL / TP</span>
              <strong>
                {price(t.slMoves?.[0]?.from ?? t.stopLoss)} / {price(t.takeProfit)}
              </strong>
              {t.slMoves?.length ? <span className="soft">SL dời tới {price(t.stopLoss)}</span> : null}
              {item.facts?.trade?.stopDistancePct !== undefined && (
                <span className="soft">
                  SL {item.facts.trade.stopDistancePct}% · {item.facts.trade.stopDistanceAtr} ATR
                </span>
              )}
            </div>
            {path && (
              <div>
                <span className="label">Có lợi / bất lợi nhất</span>
                <strong>
                  {rMultiple(path.maxFavourableR)} / {rMultiple(path.maxAdverseR === null ? null : -path.maxAdverseR)}
                </strong>
                <span className="soft">
                  {path.candlesHeld} nến · tới TP {path.maxProgressToTp === null ? "?" : Math.round(path.maxProgressToTp * 100)}%
                </span>
              </div>
            )}
            <div>
              <span className="label">Phương pháp</span>
              <strong>{t.methods.map((m) => METHODS.find((x) => x.id === m)?.letter).join(" ")}</strong>
              {item.facts?.atEntry && <span className="soft">khung lớn {item.facts.atEntry.higherTimeframeTrend} · ADX {item.facts.atEntry.adx ?? "?"}</span>}
            </div>
          </div>
        )}
        {item.status === "PENDING" && <div className="soft">AI đang phân tích…</div>}
        {item.status === "FAILED" && <Notice tone="heart" title="AI chưa phân tích được">{item.error}</Notice>}
        {r && (
          <>
            <div className="review-summary">{r.summary}</div>
            <div className="grid3" style={{ gap: 14 }}>
              <div>
                <div className="label">Vì sao vào lệnh</div>
                <div>{r.whyEntered}</div>
              </div>
              <div>
                <div className="label">Diễn biến</div>
                <div>{r.whatHappened}</div>
              </div>
              <div>
                <div className="label">Nguyên nhân</div>
                <ul className="plain-list">
                  {r.causes.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            </div>
            {r.methodNotes.length > 0 && (
              <div>
                <div className="label">Từng phương pháp</div>
                <ul className="plain-list">
                  {r.methodNotes.map((n, i) => (
                    <li key={i}>
                      <strong>{AREA_LABEL[n.method] ?? n.method}:</strong> {n.note}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid3" style={{ gap: 14 }}>
              <div>
                <div className="label">Bài học</div>
                <ul className="plain-list">
                  {r.lessons.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
              <div className="span2">
                <div className="label">Đề xuất thay đổi</div>
                <ul className="plain-list">
                  {r.suggestions.map((x, i) => (
                    <li key={i}>
                      <Chip tone={CONFIDENCE_TONE[x.confidence] ?? "stone"}>{x.confidence}</Chip> <strong>{AREA_LABEL[x.area] ?? x.area}:</strong> {x.change}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {r.tags.length > 0 && (
              <div className="row" style={{ gap: 6 }}>
                {r.tags.map((x) => (
                  <Chip key={x} tone="empty">
                    {x}
                  </Chip>
                ))}
                <span className="soft" style={{ fontSize: 11 }}>
                  {item.model}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
