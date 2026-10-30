import { z } from "zod";

/**
 * The single source of truth for every setting the UI can change. Titles, descriptions and units
 * live in `.meta()` so the server can hand the UI a JSON Schema and the form is generated from it.
 * Safety switches that must come from the environment (BINANCE_ENV, TRADING_ENABLED, keys) are
 * deliberately not part of this schema.
 */

export const TIMEFRAMES = ["5m", "15m", "30m", "1h", "2h", "4h"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
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
    alertThreshold: int(1, 3)
      .default(2)
      .meta({ title: "Ngưỡng báo SẴN SÀNG", description: "Số phương pháp cùng chiều để gửi Telegram, không vào lệnh" }),
    autoEntryThreshold: int(1, 3)
      .default(3)
      .meta({ title: "Ngưỡng tự vào lệnh", description: "Số phương pháp cùng chiều để bot tự vào lệnh" }),
    alertWhenOpposed: z
      .boolean()
      .default(true)
      .meta({ title: "Vẫn báo khi có phương pháp ngược chiều" }),
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
    maxSlAtr: num(0.5, 20).default(3).meta({ title: "Khoảng SL tối đa theo ATR", unit: "× ATR" }),
    triggerPrice: z
      .enum(["MARK_PRICE", "CONTRACT_PRICE"])
      .default("MARK_PRICE")
      .meta({ title: "Giá kích hoạt SL/TP", description: "MARK_PRICE ít bị râu nến quét hơn CONTRACT_PRICE" }),
    protectionRetries: int(0, 5).default(2).meta({ title: "Số lần thử lại khi đặt SL/TP lỗi" }),
    leverage: int(1, 125).default(10).meta({ title: "Đòn bẩy", unit: "x" }),
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

const methodsSchema = z
  .object({
    trendPullback: trendPullbackSchema.prefault({}),
    donchianBreakout: donchianBreakoutSchema.prefault({}),
    smcSweep: smcSweepSchema.prefault({}),
  })
  .meta({ title: "Phương pháp" });

const telegramSchema = z
  .object({
    notifyReady: z.boolean().default(true).meta({ title: "Báo SẴN SÀNG" }),
    notifyEntry: z.boolean().default(true).meta({ title: "Báo ĐÃ VÀO LỆNH" }),
    notifyExit: z.boolean().default(true).meta({ title: "Báo chạm TP / SL" }),
    notifyError: z.boolean().default(true).meta({ title: "Báo LỖI" }),
  })
  .meta({ title: "Telegram" });

export const settingsSchema = z
  .object({
    general: generalSchema.prefault({}),
    risk: riskSchema.prefault({}),
    methods: methodsSchema.prefault({}),
    telegram: telegramSchema.prefault({}),
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
    const tp = s.methods.trendPullback;
    if (!(tp.emaFast < tp.emaMid && tp.emaMid < tp.emaSlow)) {
      issue(["methods", "trendPullback", "emaFast"], "Cần EMA nhanh < EMA giữa < EMA chậm");
    }
    if (tp.rsiMin >= tp.rsiMax) issue(["methods", "trendPullback", "rsiMin"], "RSI tối thiểu phải nhỏ hơn RSI tối đa");
    if (!s.methods.trendPullback.enabled && !s.methods.donchianBreakout.enabled && !s.methods.smcSweep.enabled) {
      issue(["methods"], "Cần bật ít nhất một phương pháp");
    }
  });

export type Settings = z.output<typeof settingsSchema>;
export type SettingsInput = z.input<typeof settingsSchema>;
export type GeneralSettings = Settings["general"];
export type RiskSettings = Settings["risk"];
export type TrendPullbackParams = Settings["methods"]["trendPullback"];
export type DonchianBreakoutParams = Settings["methods"]["donchianBreakout"];
export type SmcSweepParams = Settings["methods"]["smcSweep"];
