import { adx, createAnalyzer, METHOD_IDS, TIMEFRAME_MINUTES, tradePath, type Candle, type MethodId, type Settings } from "@bot-v3/core";
import { z } from "zod";
import { candleLimits } from "../app/scanner.js";
import type { EventHub } from "../app/events.js";
import { errorText } from "../binance/errors.js";
import type { KeyValueStore, ReviewOutcome, ReviewRecord, ReviewStore, SqliteTradeStore } from "../db/stores.js";
import { tradeOutcome, type Trade } from "../engine/types.js";
import { silentLogger, type Logger } from "../lib/logger.js";
import { extractJson, type AiClient } from "./client.js";

export interface CandleSource {
  getCandlesBetween(symbol: string, interval: string, startTime: number, endTime: number): Promise<Candle[]>;
}

export interface ReviewDeps {
  ai: AiClient | null;
  store: ReviewStore;
  trades: SqliteTradeStore;
  market: CandleSource;
  settings: () => Settings;
  hub: EventHub;
  kv: KeyValueStore;
  logger?: Logger;
  now?: () => number;
}

const AREAS = ["trendPullback", "donchianBreakout", "smcSweep", "risk", "consensus", "general"] as const;
const text = z.string().catch("");
const list = z.array(z.string()).catch([]);

/** What the AI must answer about one trade (lenient: a missing field becomes empty, not an error). */
export const reviewSchema = z.object({
  summary: text,
  whyEntered: text,
  whatHappened: text,
  causes: list,
  methodNotes: z.array(z.object({ method: z.string(), note: z.string() })).catch([]),
  lessons: list,
  suggestions: z
    .array(z.object({ area: z.enum(AREAS).catch("general"), change: z.string(), confidence: z.enum(["thấp", "vừa", "cao"]).catch("vừa") }))
    .catch([]),
  tags: list,
});
export type TradeReview = z.output<typeof reviewSchema>;

export const insightsSchema = z.object({
  overview: text,
  patterns: list,
  weaknesses: list,
  recommendations: z
    .array(z.object({ area: z.enum(AREAS).catch("general"), change: z.string(), why: z.string().catch(""), confidence: z.enum(["thấp", "vừa", "cao"]).catch("vừa") }))
    .catch([]),
  nextExperiments: list,
});
export type Insights = z.output<typeof insightsSchema>;

const LABEL: Record<MethodId, string> = { trendPullback: "A. Xu hướng + hồi EMA", donchianBreakout: "B. Phá kênh Donchian", smcSweep: "C. SMC quét thanh khoản" };

const REVIEW_PROMPT = `Bạn là chuyên gia phân tích giao dịch crypto futures, đang rà soát MỘT lệnh do bot tự động đặt trên Binance USDT-M.
Bot dùng 3 phương pháp: A. Xu hướng + hồi EMA (trendPullback), B. Phá kênh Donchian (donchianBreakout), C. SMC quét thanh khoản (smcSweep). Bot vào lệnh khi đủ số phương pháp cùng chiều, SL gộp từ SL các phương pháp, khối lượng theo 1R, TP = giá vào ± RR × khoảng SL.
Dữ kiện JSON do code tính sẵn: lệnh, điều kiện từng phương pháp lúc vào (checks), diễn biến giá trong lệnh (path: MFE/MAE theo R, tiến độ tới TP), bối cảnh (ATR %, ADX, xu hướng khung lớn lúc vào và lúc thoát), và chuỗi nến quanh lệnh.
Yêu cầu:
- Chỉ dựa trên dữ kiện được cung cấp. Không bịa tin tức, sự kiện hay số liệu ngoài.
- Giải thích VÌ SAO lệnh thắng hoặc thua, nêu rõ vai trò của từng phương pháp và của SL/TP (ví dụ: SL quá sát so với ATR, vào khi xu hướng khung lớn đã yếu, giá đã đi +0.8R rồi quay đầu...).
- Đề xuất thay đổi CỤ THỂ cho logic hoặc tham số (tên tham số, ngưỡng), kèm mức độ tự tin. Một lệnh là mẫu nhỏ: đừng tự tin cao nếu chỉ dựa trên một lệnh.
- Viết tiếng Việt, ngắn, có số liệu.
Trả về DUY NHẤT một object JSON:
{"summary":"1-2 câu kết luận","whyEntered":"vì sao bot vào lệnh","whatHappened":"diễn biến giá sau khi vào","causes":["nguyên nhân chính"],"methodNotes":[{"method":"trendPullback|donchianBreakout|smcSweep","note":"nhận xét"}],"lessons":["bài học"],"suggestions":[{"area":"trendPullback|donchianBreakout|smcSweep|risk|consensus|general","change":"đề xuất cụ thể","confidence":"thấp|vừa|cao"}],"tags":["nhãn ngắn"]}`;

const INSIGHTS_PROMPT = `Bạn là chuyên gia tối ưu bot giao dịch. Dưới đây là thống kê và các bài phân tích AI của nhiều lệnh gần đây của cùng một bot (3 phương pháp A/B/C, vào lệnh theo đồng thuận, khối lượng theo 1R).
Hãy tìm các mẫu lặp lại (khi nào thắng, khi nào thua), điểm yếu của từng phương pháp và của quản lý vốn, rồi đề xuất thay đổi logic/tham số cụ thể để thử nghiệm (ưu tiên những gì có nhiều lệnh ủng hộ; nói rõ khi mẫu còn ít).
Chỉ dựa trên dữ liệu được cung cấp. Viết tiếng Việt, ngắn, có số liệu.
Trả về DUY NHẤT một object JSON:
{"overview":"tóm tắt","patterns":["mẫu lặp lại"],"weaknesses":["điểm yếu"],"recommendations":[{"area":"trendPullback|donchianBreakout|smcSweep|risk|consensus|general","change":"thay đổi cụ thể","why":"dựa trên bằng chứng nào","confidence":"thấp|vừa|cao"}],"nextExperiments":["thử nghiệm nên chạy, ví dụ backtest với tham số X"]}`;

const INSIGHTS_KEY = "ai.insights";

export function outcomeOf(trade: Trade): ReviewOutcome {
  return tradeOutcome(trade);
}

/**
 * After a trade closes, rebuilds what the bot saw when it entered and how the price moved while it
 * was open (all computed by code, the same analyzer as live), then asks the AI why it won or lost
 * and what to change. Reviews run one at a time and are kept in the database; a failed one can be
 * run again from the UI.
 */
export class ReviewService {
  private readonly logger: Logger;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: ReviewDeps) {
    this.logger = deps.logger ?? silentLogger;
    this.now = deps.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.deps.ai !== null;
  }

  /** Reviews trades as they close, and finishes reviews a restart interrupted. */
  start(): void {
    this.unsubscribe = this.deps.hub.onEvent((event) => {
      if (event.type === "TRADE_CLOSED" && this.shouldReview(event.trade)) this.enqueue(event.trade.id);
    });
    if (!this.enabled) return;
    for (const pending of this.deps.store.list({ status: "PENDING", limit: 20 })) this.enqueue(pending.tradeId);
  }

  stop(): void {
    this.unsubscribe?.();
  }

  shouldReview(trade: Trade): boolean {
    const ai = this.deps.settings().ai;
    if (!this.enabled || !ai.autoReview || trade.status !== "CLOSED" || !trade.entryPrice) return false;
    return trade.exitReason === "TP" || trade.exitReason === "SL" || ai.reviewManualExits;
  }

  /** Queues a review; resolves when it is done. */
  enqueue(tradeId: string): Promise<ReviewRecord> {
    const run = this.chain.then(() => this.review(tradeId));
    this.chain = run.catch(() => undefined);
    return run;
  }

  async review(tradeId: string): Promise<ReviewRecord> {
    const trade = this.deps.trades.getSync(tradeId);
    if (!trade) throw new Error(`Không có lệnh ${tradeId}`);
    if (!this.deps.ai) throw new Error("AI đang tắt (chưa có AI_BASE_URL trong .env)");
    const previous = this.deps.store.get(tradeId);
    const base: ReviewRecord = {
      tradeId,
      symbol: trade.symbol,
      status: "PENDING",
      outcome: outcomeOf(trade),
      createdAt: previous?.createdAt ?? this.now(),
      updatedAt: this.now(),
      model: null,
      facts: previous?.facts ?? null,
      review: null,
      error: null,
    };
    this.deps.store.save(base);
    try {
      const facts = await this.buildFacts(trade, this.deps.settings());
      const reply = await this.deps.ai.chat(
        [
          { role: "system", content: REVIEW_PROMPT },
          { role: "user", content: JSON.stringify(facts) },
        ],
        { json: true, temperature: 0.2 },
      );
      const review = reviewSchema.parse(extractJson(reply.content));
      const done: ReviewRecord = { ...base, status: "DONE", facts, review, model: reply.model, updatedAt: this.now() };
      this.deps.store.save(done);
      this.deps.hub.emit({
        type: "REVIEW_DONE",
        tradeId,
        symbol: trade.symbol,
        direction: trade.direction,
        outcome: done.outcome!,
        pnlR: trade.pnlR,
        exitReason: trade.exitReason,
        summary: review.summary,
      });
      return done;
    } catch (error) {
      const failed: ReviewRecord = { ...base, status: "FAILED", error: errorText(error), updatedAt: this.now() };
      this.deps.store.save(failed);
      this.deps.hub.emit({ type: "REVIEW_FAILED", tradeId, symbol: trade.symbol, detail: failed.error! });
      this.logger.warn("Trade review failed", { tradeId, error: failed.error });
      return failed;
    }
  }

  /** The facts a review is based on, all computed by code from candles around the trade. */
  async buildFacts(trade: Trade, settings: Settings) {
    const { entryTf, trendTf } = settings.general;
    const tfMs = TIMEFRAME_MINUTES[entryTf] * 60_000;
    const trendMs = TIMEFRAME_MINUTES[trendTf] * 60_000;
    const openedAt = trade.openedAt ?? trade.createdAt;
    const closedAt = trade.closedAt ?? this.now();
    const limits = candleLimits(settings);
    const entry = await this.deps.market.getCandlesBetween(trade.symbol, entryTf, openedAt - limits.entry * tfMs, closedAt + 4 * tfMs);
    const trend = trendTf === entryTf ? entry : await this.deps.market.getCandlesBetween(trade.symbol, trendTf, openedAt - limits.trend * trendMs, closedAt + trendMs);
    if (entry.length < 2) throw new Error(`Không lấy được nến ${entryTf} quanh lệnh`);

    // The candle that gave the signal closed just before the entry; the exit candle contains the exit.
    let entryIdx = -1;
    for (let i = 0; i < entry.length; i++) if (entry[i]!.closeTime < openedAt) entryIdx = i;
    let exitIdx = entryIdx;
    for (let i = 0; i < entry.length; i++) if (entry[i]!.openTime <= closedAt) exitIdx = i;
    if (entryIdx < 0) throw new Error("Không có nến trước lúc vào lệnh");

    const analyzer = createAnalyzer({ entry, trend }, settings);
    const atEntry = analyzer.at(entryIdx);
    const atExit = analyzer.at(exitIdx);
    const explanation = analyzer.explain(entryIdx);
    const adxSeries = adx(entry, settings.methods.donchianBreakout.adxPeriod).adx;
    const trendSide = (idx: number) => {
      const sides = analyzer.explain(idx).trendPullback?.sides;
      if (!sides) return "không rõ (A đang tắt)";
      const up = sides[0].checks.slice(0, 3).every((c) => c.pass === true);
      const down = sides[1].checks.slice(0, 3).every((c) => c.pass === true);
      return up ? "tăng" : down ? "giảm" : "không rõ xu hướng";
    };
    const entryPrice = Number(trade.entryPrice);
    const path = tradePath(trade.direction, entryPrice, Number(trade.stopLoss), Number(trade.takeProfit), entry.slice(entryIdx + 1, exitIdx + 1));
    const round = (x: number, digits = 4) => (Number.isFinite(x) ? Number(x.toFixed(digits)) : null);
    const vn = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");

    const methods: Record<string, unknown> = {};
    for (const id of METHOD_IDS) {
      const state = atEntry.methods[id];
      const exp = explanation[id];
      methods[id] = {
        name: LABEL[id],
        enabled: state.enabled,
        activeSignal: state.signal ? { direction: state.signal.direction, stopLoss: round(state.signal.stopLoss, 8), reason: state.signal.reason } : null,
        conditions: exp?.sides.map((s) => ({
          direction: s.direction,
          passed: `${s.passed}/${s.checks.length}`,
          checks: s.checks.map((c) => `${c.pass === true ? "✓" : c.pass === false ? "✗" : "?"} ${c.label}${c.detail ? ` (${c.detail})` : ""}`),
        })),
      };
    }

    const from = Math.max(0, entryIdx - 12);
    const to = Math.min(entry.length - 1, exitIdx + 3);
    let window = entry.slice(from, to + 1);
    if (window.length > 80) window = [...window.slice(0, 30), ...window.slice(-50)];

    return {
      trade: {
        id: trade.id,
        symbol: trade.symbol,
        direction: trade.direction,
        methods: trade.methods,
        openedAt: vn(openedAt),
        closedAt: vn(closedAt),
        heldMinutes: Math.round((closedAt - openedAt) / 60_000),
        entry: trade.entryPrice,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        exit: trade.exitPrice,
        exitReason: trade.exitReason,
        netPnlUsd: trade.netPnl,
        resultR: trade.pnlR === null ? null : round(trade.pnlR, 3),
        lossAtStopR: trade.riskAtStopR,
        winAtTpR: trade.rewardAtTpR,
        stopMode: trade.stopMode,
        leverage: trade.leverage,
        stopDistancePct: round((Math.abs(entryPrice - Number(trade.stopLoss)) / entryPrice) * 100, 3),
        stopDistanceAtr: round(Math.abs(entryPrice - Number(trade.stopLoss)) / atEntry.atr, 2),
      },
      atEntry: {
        signalCandleClosed: vn(atEntry.time + 1),
        price: atEntry.price,
        atr: round(atEntry.atr, 6),
        atrPct: round((atEntry.atr / atEntry.price) * 100, 3),
        adx: round(adxSeries[entryIdx] ?? Number.NaN, 1),
        trendTimeframe: trendTf,
        higherTimeframeTrend: trendSide(entryIdx),
        consensus: { level: atEntry.consensus.level, direction: atEntry.consensus.direction, long: atEntry.consensus.longCount, short: atEntry.consensus.shortCount },
        methods,
      },
      atExit: {
        higherTimeframeTrend: trendSide(exitIdx),
        consensus: { level: atExit.consensus.level, direction: atExit.consensus.direction, long: atExit.consensus.longCount, short: atExit.consensus.shortCount },
        activeSignals: METHOD_IDS.flatMap((id) => (atExit.methods[id].signal ? [`${LABEL[id]}: ${atExit.methods[id].signal!.direction}`] : [])),
      },
      path: {
        candlesHeld: path.bars,
        maxFavourableR: round(path.mfeR, 2),
        maxAdverseR: round(path.maeR, 2),
        maxProgressToTp: round(path.maxTpProgress, 2),
        bestPrice: path.bestPrice,
        worstPrice: path.worstPrice,
      },
      rules: {
        entryTimeframe: entryTf,
        rr: settings.risk.rr,
        slPolicy: settings.risk.slPolicy,
        slMode: settings.risk.slMode,
        thresholds: `${settings.general.alertThreshold}/3 báo, ${settings.general.autoEntryThreshold}/3 vào lệnh`,
        signalTtlBars: settings.general.signalTtlBars,
        note: "Cài đặt hiện tại; có thể khác lúc vào lệnh nếu đã sửa",
      },
      candles: {
        timeframe: entryTf,
        columns: "giờ VN, open, high, low, close, volume",
        rows: window.map((c) => [vn(c.openTime), c.open, c.high, c.low, c.close, Math.round(c.volume)]),
      },
    };
  }

  latestInsights(): { createdAt: number; model: string; reviewCount: number; stats: unknown; result: Insights } | null {
    return this.deps.kv.get(INSIGHTS_KEY, null);
  }

  /** Looks across the latest reviewed trades for patterns and what to change. */
  async insights(limit = 40) {
    if (!this.deps.ai) throw new Error("AI đang tắt (chưa có AI_BASE_URL trong .env)");
    const reviews = this.deps.store.list({ status: "DONE", limit });
    if (reviews.length === 0) throw new Error("Chưa có lệnh nào được AI phân tích");
    const trades = reviews.flatMap((r) => this.deps.trades.getSync(r.tradeId) ?? []);
    const stats = tradeStats(trades);
    const items = reviews.map((r) => {
      const t = trades.find((x) => x.id === r.tradeId);
      const review = r.review as TradeReview | null;
      return {
        symbol: r.symbol,
        direction: t?.direction,
        methods: t?.methods,
        resultR: t?.pnlR === null || t?.pnlR === undefined ? null : Number(t.pnlR.toFixed(2)),
        exitReason: t?.exitReason,
        summary: review?.summary,
        causes: review?.causes,
        suggestions: review?.suggestions?.map((s) => `${s.area}: ${s.change}`),
        tags: review?.tags,
      };
    });
    const reply = await this.deps.ai.chat(
      [
        { role: "system", content: INSIGHTS_PROMPT },
        { role: "user", content: JSON.stringify({ stats, reviews: items }) },
      ],
      { json: true, temperature: 0.2 },
    );
    const result = insightsSchema.parse(extractJson(reply.content));
    const saved = { createdAt: this.now(), model: reply.model, reviewCount: reviews.length, stats, result };
    this.deps.kv.set(INSIGHTS_KEY, saved);
    return saved;
  }
}

/** Win rate and R overall, per method that took part, per exit reason and per symbol. */
export function tradeStats(trades: readonly Trade[]) {
  const sum = (list: readonly Trade[]) => {
    const r = list.map((t) => t.pnlR ?? 0);
    const wins = r.filter((x) => x > 0.05).length;
    return {
      trades: list.length,
      wins,
      losses: r.filter((x) => x < -0.05).length,
      winRate: list.length ? Number((wins / list.length).toFixed(2)) : 0,
      totalR: Number(r.reduce((a, b) => a + b, 0).toFixed(2)),
    };
  };
  const group = <K extends string>(key: (t: Trade) => K[]) => {
    const out: Record<string, ReturnType<typeof sum>> = {};
    const keys = new Set(trades.flatMap(key));
    for (const k of keys) out[k] = sum(trades.filter((t) => key(t).includes(k)));
    return out;
  };
  return {
    overall: sum(trades),
    byMethod: group((t) => t.methods),
    byExit: group((t) => (t.exitReason ? [t.exitReason] : [])),
    bySymbol: group((t) => [t.symbol]),
    byDirection: group((t) => [t.direction]),
  };
}
