import { z } from "zod";
import { METHOD_COMBOS, METHOD_IDS, METHOD_LETTERS } from "../types.js";

/**
 * The single source of truth for every setting the UI can change. Titles, descriptions and units
 * live in `.meta()` so the server can hand the UI a JSON Schema and the form is generated from it.
 * Safety switches that must come from the environment (BINANCE_ENV, TRADING_ENABLED, keys) are
 * deliberately not part of this schema.
 */

export const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
};

const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}USDT$/;

const timeframe = z.enum(TIMEFRAMES);
const int = (min: number, max: number) => z.int().min(min).max(max);
const num = (min: number, max: number) => z.number().min(min).max(max);

const generalSchema = z
  .object({
    watchlist: z
      .array(z.string().trim().toUpperCase().regex(SYMBOL_PATTERN, "Symbol phải có dạng XXXUSDT"))
      .min(1)
      .max(50)
      .refine((list) => new Set(list).size === list.length, "Danh sách có symbol bị trùng")
      .default(["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"])
      .meta({ title: "Danh sách symbol", description: "Các cặp USDT-M bot phân tích" }),
    entryTf: timeframe.default("15m").meta({ title: "Khung vào lệnh" }),
    trendTf: timeframe.default("1h").meta({ title: "Khung xu hướng", description: "Phải lớn hơn hoặc bằng khung vào lệnh" }),
    atrPeriod: int(2, 100).default(14).meta({ title: "Chu kỳ ATR" }),
    signalTtlBars: int(1, 20)
      .default(4)
      .meta({ title: "Hiệu lực tín hiệu (nến)", description: "Một tín hiệu được tính vào đồng thuận trong bấy nhiêu nến" }),
    alertThreshold: int(1, 4)
      .default(2)
      .meta({ title: "Ngưỡng báo SẴN SÀNG", description: "Số phương pháp cùng chiều để gửi Telegram, không vào lệnh" }),
    autoEntryThreshold: int(1, 4)
      .default(3)
      .meta({ title: "Ngưỡng tự vào lệnh", description: "Số phương pháp cùng chiều để bot tự vào lệnh. Không dùng khi đã chọn tổ hợp bên dưới" }),
    alertWhenOpposed: z
      .boolean()
      .default(true)
      .meta({ title: "Vẫn báo khi có phương pháp ngược chiều" }),
    entryCombos: z
      .array(z.enum(METHOD_COMBOS as [string, ...string[]]))
      .default([])
      .refine((list) => new Set(list).size === list.length, "Có tổ hợp bị trùng")
      .meta({
        title: "Tổ hợp được tự vào lệnh",
        description:
          "Chọn các tổ hợp phương pháp cùng chiều được vào lệnh (A: xu hướng + hồi EMA, B: phá kênh Donchian, C: SMC, D: hộp). Có thêm phương pháp khác cùng chiều vẫn tính. Để trống thì dùng ngưỡng số phương pháp bên trên",
      }),
    entryRequires: z
      .enum(["NONE", "trendPullback", "donchianBreakout", "smcSweep", "boxTheory"])
      .default("NONE")
      .meta({
        title: "Phương pháp bắt buộc khi vào lệnh",
        description: "Chỉ tự vào lệnh khi phương pháp này nằm trong nhóm đồng thuận; thiếu thì chỉ báo SẴN SÀNG. NONE: không bắt buộc",
      }),
    autoTrade: z
      .boolean()
      .default(true)
      .meta({ title: "Tự vào lệnh", description: "Chỉ có tác dụng khi TRADING_ENABLED=true trong .env" }),
    cooldownBars: int(0, 100)
      .default(4)
      .meta({ title: "Nghỉ sau khi đóng lệnh (nến)", description: "Symbol vừa đóng lệnh không vào lại trong bấy nhiêu nến" }),
  })
  .meta({ title: "Chung" });

const riskSchema = z
  .object({
    riskUsd: num(0.1, 10_000).default(5).meta({ title: "1R", unit: "$", description: "Số tiền mất khi chạm SL" }),
    rr: num(0.5, 10).default(2).meta({ title: "R:R mục tiêu", description: "TP = giá vào ± RR × khoảng SL" }),
    includeFees: z.boolean().default(true).meta({ title: "Tính phí vào 1R" }),
    feeRatePct: num(0, 1).default(0.05).meta({ title: "Phí taker mỗi chiều", unit: "%" }),
    makerFeePct: num(0, 1).default(0.02).meta({ title: "Phí maker mỗi chiều", unit: "%", description: "Dùng cho lệnh vào khi kiểu lệnh vào là LIMIT" }),
    entryOrder: z
      .enum(["MARKET", "LIMIT"])
      .default("MARKET")
      .meta({
        title: "Kiểu lệnh vào",
        description:
          "MARKET: khớp ngay, phí taker. LIMIT: lệnh post-only ở giá mua (LONG) hoặc bán (SHORT) tốt nhất, phí maker; đặt lại khi giá chạy, không khớp trong thời gian chờ thì coi như chưa vào và thử lại ở nến sau. SL vẫn là lệnh market",
      }),
    limitWaitSec: int(5, 600).default(120).meta({ title: "Chờ lệnh limit khớp tối đa", unit: "giây" }),
    limitMaxChaseAtr: num(0, 5)
      .default(0.3)
      .meta({ title: "Đuổi giá tối đa (lệnh limit)", unit: "× ATR", description: "Giá đã chạy xa hơn mức này khỏi giá lúc quyết định thì thôi, không đặt lại" }),
    slPolicy: z
      .enum(["WIDEST", "MEDIAN", "TIGHTEST"])
      .default("WIDEST")
      .meta({ title: "SL gộp", description: "WIDEST: xa nhất, MEDIAN: trung vị, TIGHTEST: gần nhất" }),
    slMode: z
      .enum(["EXACT_1R", "KEEP_STRUCTURE"])
      .default("EXACT_1R")
      .meta({
        title: "SL sau khi khớp",
        description: "EXACT_1R: tính lại SL theo giá khớp để lỗ đúng 1R. KEEP_STRUCTURE: giữ SL cấu trúc, lỗ ≤ 1R",
      }),
    maxSlWidenPct: num(0, 200)
      .default(25)
      .meta({ title: "Nới SL tối đa (EXACT_1R)", unit: "%", description: "Quá mức này thì giữ SL cấu trúc" }),
    minSlPct: num(0.01, 20).default(0.2).meta({ title: "Khoảng SL tối thiểu", unit: "%" }),
    maxSlPct: num(0.05, 50).default(3).meta({ title: "Khoảng SL tối đa", unit: "%" }),
    maxSlAtr: num(0.5, 100)
      .default(3)
      .meta({ title: "Khoảng SL tối đa theo ATR", unit: "× ATR", description: "Phương pháp D đặt SL ngoài hộp nên thường cần mức cao hơn nhiều, ví dụ 20–40 trên khung 5m" }),
    triggerPrice: z
      .enum(["MARK_PRICE", "CONTRACT_PRICE"])
      .default("MARK_PRICE")
      .meta({ title: "Giá kích hoạt SL/TP", description: "MARK_PRICE ít bị râu nến quét hơn CONTRACT_PRICE" }),
    protectionRetries: int(0, 5).default(2).meta({ title: "Số lần thử lại khi đặt SL/TP lỗi" }),
    moveSl: z
      .boolean()
      .default(true)
      .meta({ title: "Dời SL khi giá chạy về phía TP", description: "Bot kiểm tra giá mark khoảng 15 giây một lần" }),
    breakEvenAtTpPct: int(0, 100)
      .default(50)
      .meta({ title: "Dời SL về giá vào khi đạt", unit: "% đường tới TP", description: "0 = không dời. Lệnh chạm SL này lỗ khoảng bằng phí" }),
    lockAtTpPct: int(0, 100)
      .default(75)
      .meta({ title: "Dời SL lên khoá lãi khi đạt", unit: "% đường tới TP", description: "0 = không dời" }),
    lockSlAtTpPct: int(0, 100)
      .default(50)
      .meta({ title: "Mức SL khoá lãi", unit: "% đường tới TP", description: "Với RR 2, 50% đường tới TP là +1R trước phí" }),
    leverageMode: z
      .enum(["AUTO", "FIXED"])
      .default("AUTO")
      .meta({
        title: "Cách chọn đòn bẩy",
        description: "AUTO: mỗi lệnh dùng đòn bẩy nhỏ nhất đủ ký quỹ, không quá mức tối đa. FIXED: luôn dùng đúng mức đòn bẩy bên dưới",
      }),
    leverage: int(1, 125)
      .default(10)
      .meta({
        title: "Đòn bẩy tối đa",
        unit: "x",
        description: "AUTO: mức trần. FIXED: mức dùng cho mọi lệnh. Đòn bẩy không đổi số tiền lỗ ở SL, chỉ đổi ký quỹ và giá thanh lý",
      }),
    marginType: z.enum(["ISOLATED", "CROSSED"]).default("ISOLATED").meta({ title: "Loại ký quỹ" }),
    maxMarginUsagePct: num(1, 100)
      .default(50)
      .meta({ title: "Ký quỹ tối đa mỗi lệnh", unit: "% số dư khả dụng" }),
    liqBufferMultiple: num(1, 10)
      .default(1.5)
      .meta({ title: "Khoảng cách thanh lý tối thiểu", unit: "× khoảng SL" }),
    maxOpenPositions: int(1, 50).default(3).meta({ title: "Số vị thế tối đa cùng lúc" }),
    maxDailyLossR: num(0.5, 100).default(3).meta({ title: "Lỗ tối đa mỗi ngày", unit: "R" }),
    maxTradesPerDay: int(1, 200).default(10).meta({ title: "Số lệnh tối đa mỗi ngày" }),
  })
  .meta({ title: "Quản lý vốn" });

const trendPullbackSchema = z
  .object({
    enabled: z.boolean().default(true).meta({ title: "Bật" }),
    emaFast: int(2, 400).default(20).meta({ title: "EMA nhanh (khung vào lệnh)" }),
    emaMid: int(2, 400).default(50).meta({ title: "EMA giữa (cả hai khung)" }),
    emaSlow: int(2, 1000).default(200).meta({ title: "EMA chậm (khung xu hướng)" }),
    slopeLookback: int(1, 50).default(5).meta({ title: "Số nến đo độ dốc EMA giữa" }),
    pullbackLookback: int(1, 50).default(5).meta({ title: "Số nến tìm nhịp hồi" }),
    rsiPeriod: int(2, 100).default(14).meta({ title: "Chu kỳ RSI" }),
    rsiMin: num(0, 100).default(50).meta({ title: "RSI tối thiểu (LONG)", description: "SHORT dùng 100 − giá trị này" }),
    rsiMax: num(0, 100).default(70).meta({ title: "RSI tối đa (LONG)", description: "SHORT dùng 100 − giá trị này" }),
    slAtrBuffer: num(0, 5).default(0.2).meta({ title: "Đệm SL", unit: "× ATR" }),
  })
  .meta({ title: "A. Xu hướng + hồi EMA" });

const donchianBreakoutSchema = z
  .object({
    enabled: z.boolean().default(true).meta({ title: "Bật" }),
    channelLength: int(5, 200).default(20).meta({ title: "Độ dài kênh Donchian" }),
    volumeSmaLength: int(2, 200).default(20).meta({ title: "Số nến trung bình volume" }),
    volumeMultiplier: num(0.5, 10).default(1.5).meta({ title: "Volume tối thiểu", unit: "× trung bình" }),
    adxPeriod: int(2, 100).default(14).meta({ title: "Chu kỳ ADX" }),
    adxMin: num(0, 100).default(20).meta({ title: "ADX tối thiểu" }),
    minBodyRatio: num(0, 1).default(0.5).meta({ title: "Thân nến tối thiểu", unit: "× biên độ" }),
    closeZoneRatio: num(0.05, 1)
      .default(0.25)
      .meta({ title: "Vùng đóng cửa", description: "Close phải nằm trong phần này của nến, phía đỉnh (LONG) hoặc đáy (SHORT)" }),
    maxChaseAtr: num(0, 10).default(1).meta({ title: "Cách kênh tối đa", unit: "× ATR" }),
    slAtrMultiplier: num(0.2, 10).default(1.5).meta({ title: "SL", unit: "× ATR" }),
  })
  .meta({ title: "B. Phá kênh Donchian" });

const smcSweepSchema = z
  .object({
    enabled: z.boolean().default(true).meta({ title: "Bật" }),
    swingStrength: int(1, 10).default(3).meta({ title: "Độ mạnh swing", description: "Số nến mỗi bên" }),
    sweepLookback: int(2, 50).default(10).meta({ title: "Số nến tìm cú quét" }),
    swingMaxAge: int(5, 500).default(50).meta({ title: "Tuổi tối đa của swing bị quét (nến)" }),
    minFvgAtr: num(0, 5).default(0.1).meta({ title: "FVG tối thiểu", unit: "× ATR" }),
    maxDistanceFromFvgAtr: num(0, 10).default(1.5).meta({ title: "Cách FVG tối đa", unit: "× ATR" }),
    slAtrBuffer: num(0, 5).default(0.2).meta({ title: "Đệm SL", unit: "× ATR" }),
  })
  .meta({ title: "C. SMC quét thanh khoản" });

const boxTheorySchema = z
  .object({
    enabled: z.boolean().default(false).meta({ title: "Bật" }),
    zonePct: int(5, 45)
      .default(20)
      .meta({ title: "Vùng mua / bán", unit: "% chiều cao hộp", description: "Mua khi nến chạm phần dưới cùng này của hộp hôm trước, bán khi chạm phần trên cùng" }),
    maxEntryPct: int(5, 50)
      .default(35)
      .meta({ title: "Giá vào cách cạnh hộp tối đa", unit: "% chiều cao hộp", description: "Không vào khi nến đóng cửa đã đi quá xa đáy (LONG) hoặc đỉnh (SHORT), tức là gần giữa hộp" }),
    minBoxAtr: num(1, 200).default(6).meta({ title: "Chiều cao hộp tối thiểu", unit: "× ATR", description: "Hộp hẹp quá thì bỏ qua" }),
    rejectRatio: num(0, 1)
      .default(0.5)
      .meta({ title: "Nến từ chối", unit: "× biên độ", description: "LONG: nến tăng, đóng cửa cách đáy nến ít nhất phần này của biên độ (SHORT ngược lại)" }),
    slBufferAtr: num(0, 5).default(0.3).meta({ title: "SL ngoài hộp", unit: "× ATR" }),
  })
  .meta({ title: "D. Hộp (Box Theory)" });

const methodsSchema = z
  .object({
    trendPullback: trendPullbackSchema.prefault({}),
    donchianBreakout: donchianBreakoutSchema.prefault({}),
    smcSweep: smcSweepSchema.prefault({}),
    boxTheory: boxTheorySchema.prefault({}),
  })
  .meta({ title: "Phương pháp" });

const telegramSchema = z
  .object({
    notifyReady: z.boolean().default(true).meta({ title: "Báo SẴN SÀNG" }),
    notifyEntry: z.boolean().default(true).meta({ title: "Báo ĐÃ VÀO LỆNH" }),
    notifyExit: z.boolean().default(true).meta({ title: "Báo chạm TP / SL" }),
    notifyStopMove: z.boolean().default(true).meta({ title: "Báo dời SL (hoà vốn, khoá lãi)" }),
    notifyError: z.boolean().default(true).meta({ title: "Báo LỖI" }),
  })
  .meta({ title: "Telegram" });

const aiSchema = z
  .object({
    autoReview: z
      .boolean()
      .default(true)
      .meta({ title: "AI phân tích lệnh khi chạm TP / SL", description: "Cần AI_BASE_URL trong .env" }),
    reviewManualExits: z.boolean().default(false).meta({ title: "Phân tích cả lệnh đóng tay / đóng khẩn" }),
    notifyReview: z.boolean().default(true).meta({ title: "Gửi tóm tắt phân tích lên Telegram" }),
    chatEnabled: z.boolean().default(true).meta({ title: "Bật chat AI (web và /ask trên Telegram)" }),
  })
  .meta({ title: "AI" });

export const settingsSchema = z
  .object({
    general: generalSchema.prefault({}),
    risk: riskSchema.prefault({}),
    methods: methodsSchema.prefault({}),
    telegram: telegramSchema.prefault({}),
    ai: aiSchema.prefault({}),
  })
  .superRefine((s, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (TIMEFRAME_MINUTES[s.general.trendTf] < TIMEFRAME_MINUTES[s.general.entryTf]) {
      issue(["general", "trendTf"], "Khung xu hướng phải lớn hơn hoặc bằng khung vào lệnh");
    }
    if (s.general.alertThreshold > s.general.autoEntryThreshold) {
      issue(["general", "alertThreshold"], "Ngưỡng báo phải nhỏ hơn hoặc bằng ngưỡng tự vào lệnh");
    }
    if (s.risk.minSlPct >= s.risk.maxSlPct) issue(["risk", "minSlPct"], "Khoảng SL tối thiểu phải nhỏ hơn tối đa");
    if (s.risk.lockAtTpPct > 0 && s.risk.lockSlAtTpPct >= s.risk.lockAtTpPct) {
      issue(["risk", "lockSlAtTpPct"], "Mức SL khoá lãi phải thấp hơn mức kích hoạt khoá lãi");
    }
    if (s.risk.breakEvenAtTpPct > 0 && s.risk.lockAtTpPct > 0 && s.risk.breakEvenAtTpPct >= s.risk.lockAtTpPct) {
      issue(["risk", "breakEvenAtTpPct"], "Mức dời về giá vào phải thấp hơn mức khoá lãi");
    }
    const tp = s.methods.trendPullback;
    if (!(tp.emaFast < tp.emaMid && tp.emaMid < tp.emaSlow)) {
      issue(["methods", "trendPullback", "emaFast"], "Cần EMA nhanh < EMA giữa < EMA chậm");
    }
    if (tp.rsiMin >= tp.rsiMax) issue(["methods", "trendPullback", "rsiMin"], "RSI tối thiểu phải nhỏ hơn RSI tối đa");
    const m = s.methods;
    if (!m.trendPullback.enabled && !m.donchianBreakout.enabled && !m.smcSweep.enabled && !m.boxTheory.enabled) {
      issue(["methods"], "Cần bật ít nhất một phương pháp");
    }
    const enabledLetters = new Set(METHOD_IDS.filter((id) => m[id].enabled).map((id) => METHOD_LETTERS[id]));
    const usable = s.general.entryCombos.filter((combo) => combo.split("+").every((letter) => enabledLetters.has(letter)));
    if (s.general.entryCombos.length > 0 && usable.length === 0) {
      issue(["general", "entryCombos"], "Không tổ hợp nào chỉ gồm các phương pháp đang bật: bot sẽ không bao giờ vào lệnh");
    }
  });

export type Settings = z.output<typeof settingsSchema>;
export type SettingsInput = z.input<typeof settingsSchema>;
export type GeneralSettings = Settings["general"];
export type RiskSettings = Settings["risk"];
export type AiSettings = Settings["ai"];
export type TrendPullbackParams = Settings["methods"]["trendPullback"];
export type DonchianBreakoutParams = Settings["methods"]["donchianBreakout"];
export type SmcSweepParams = Settings["methods"]["smcSweep"];
export type BoxTheoryParams = Settings["methods"]["boxTheory"];
