# Luật giao dịch

Tài liệu này mô tả đúng những gì code trong `packages/core` đang làm. Mọi con số là **mặc định**: chỉnh được trong cài đặt (`packages/core/src/settings/schema.ts`).

## Quy ước

- Chỉ dùng **nến đã đóng**. Khung vào lệnh `entryTf` mặc định 15m, khung xu hướng `trendTf` mặc định 1h.
- Một nến của khung xu hướng chỉ được dùng khi `closeTime` của nó ≤ `closeTime` của nến 15m đang xét, để không nhìn trước tương lai. Có test kiểm tra: phân tích trên lịch sử bị cắt ngắn phải ra đúng kết quả cũ.
- ATR = ATR Wilder (`atrPeriod` = 14). EMA dùng SMA làm điểm khởi đầu, RSI và ADX theo Wilder, giống TradingView.
- Mỗi phương pháp trả về: chiều, SL cấu trúc, lý do, và các mức giá dùng để vẽ hoặc huỷ tín hiệu.

## A. Xu hướng + hồi EMA (`trendPullback`)

LONG (SHORT là ảnh gương):

1. **Khung xu hướng:** close > EMA200, EMA50 > EMA200, và EMA50 hiện tại > EMA50 của 5 nến trước.
2. **Khung vào lệnh:** EMA20 > EMA50.
3. **Nhịp hồi:** trong 5 nến gần nhất (tính cả nến hiện tại) có nến có low ≤ EMA20, và không nến nào đóng cửa dưới EMA50.
4. **Kích hoạt:** nến tăng, close > EMA20, close > high của nến trước, RSI(14) trong khoảng 50 đến 70 và cao hơn nến trước. SHORT dùng khoảng RSI 30 đến 50 và RSI đang giảm.
5. **SL** = low thấp nhất của 5 nến đó − 0.2 × ATR.
6. **Huỷ tín hiệu:** có nến đóng cửa dưới EMA50.

## B. Phá kênh Donchian (`donchianBreakout`)

LONG (SHORT là ảnh gương):

1. close > high cao nhất của 20 nến trước (không tính nến hiện tại).
2. volume ≥ 1.5 × trung bình volume 20 nến trước nến phá.
3. ADX(14) ≥ 20.
4. Nến tăng, thân ≥ 50% biên độ, close nằm trong 25% trên cùng của nến.
5. close − đỉnh kênh ≤ 1 × ATR (không đuổi giá).
6. **SL** = close − 1.5 × ATR.
7. **Huỷ tín hiệu:** có nến đóng cửa dưới đường giữa kênh tại thời điểm phá.

## C. SMC quét thanh khoản (`smcSweep`)

LONG (SHORT là ảnh gương):

1. **Swing** là fractal độ mạnh 3: low thấp hơn hẳn 3 nến mỗi bên. Một swing ở nến k chỉ được dùng từ nến k + 3 trở đi.
2. **Cú quét (nến w):** nằm trong 10 nến trước nến kích hoạt. low[w] < swing low gần nhất (đã xác nhận, không quá 50 nến), close[w] > swing low đó, và từ lúc swing hình thành tới w chưa có nến nào xuyên qua nó.
3. **Đổi cấu trúc:** nến kích hoạt là nến **đầu tiên** đóng cửa trên swing high gần nhất hình thành trước w.
4. **FVG:** trong nhịp từ w tới nến kích hoạt có FVG tăng (low[f] > high[f−2]) cao ≥ 0.1 × ATR. close − đỉnh FVG ≤ 1.5 × ATR.
5. **SL** = low[w] − 0.2 × ATR.
6. **Huỷ tín hiệu:** giá chạm low[w].

## Tín hiệu còn hiệu lực

Tín hiệu của một phương pháp được tính vào đồng thuận nếu:

- nó là lần kích hoạt **gần nhất** trong `signalTtlBars` (4) nến gần đây; lần kích hoạt mới thay lần cũ;
- sau nó **chưa có nến nào chạm SL** của nó, và phương pháp chưa huỷ nó.

Phần này tính lại hoàn toàn từ nến, không lưu trạng thái, nên bot khởi động lại vẫn ra cùng kết quả.

## Đồng thuận

Gọi L và S là số phương pháp đang có tín hiệu LONG và SHORT:

| Điều kiện | Kết quả |
|---|---|
| L = S | NONE (không chiều) |
| phía đông hơn ≥ `autoEntryThreshold` (3) và phía kia = 0 | **ENTER**: tự vào lệnh |
| phía đông hơn ≥ `alertThreshold` (2) | **READY**: báo Telegram. Nếu có phương pháp ngược chiều thì chỉ báo khi `alertWhenOpposed` bật |
| còn lại | NONE |

**Chống spam (`advanceEpisode`):**

- Một "đợt" bắt đầu khi lên READY hoặc ENTER, và kết thúc khi về NONE hoặc đổi chiều.
- Mỗi đợt gửi READY tối đa 1 lần, ENTER tối đa 1 lần.
- Đi từ 2/3 lên 3/3 thì phát ENTER. Tụt từ 3/3 về 2/3 thì không báo lại.

## SL, TP và khối lượng

1. **SL gộp** từ SL của các phương pháp đồng thuận, theo `slPolicy`:
   - `WIDEST` (mặc định): xa giá vào nhất.
   - `MEDIAN`: trung vị; với số lượng chẵn thì lấy giá trị xa hơn trong hai giá trị giữa.
   - `TIGHTEST`: gần nhất.
2. **Kiểm tra SL:** khoảng SL trong `[minSlPct 0.2%, maxSlPct 3%]` và ≤ `maxSlAtr` (3) × ATR. Không đạt thì bỏ lệnh.
3. **Khối lượng:**
   - lỗ trên mỗi coin = |giá vào − SL| + phí × (giá vào + SL). Phí taker mặc định 0.05% mỗi chiều, tắt được bằng `includeFees`.
   - qty = 1R / lỗ trên mỗi coin, **làm tròn xuống** theo stepSize.
   - SL làm tròn theo tick, về phía xa giá vào.
   - Thiếu `minQty` hoặc `minNotional` thì **từ chối, không tăng khối lượng**, và báo 1R tối thiểu cần có.
   - Vượt `maxQty` thì giảm về `maxQty` (rủi ro chỉ nhỏ đi).
4. **TP** lấy đúng theo phân tích: `TP = giá vào ± RR × khoảng SL` (RR mặc định 2), làm tròn tới tick gần nhất.
   - Phí không được cộng vào TP. Vì 1R đã gồm phí, chạm TP lãi ròng hơi thấp hơn RR × 1R (BTC ví dụ dưới: khoảng 1.8R).
   - Bot ghi lại số lãi ròng dự kiến ở TP (`rewardAtTp`, `rewardR`) để báo trên Telegram và UI.
5. **Sau khi khớp (`finalizeAfterFill`):**
   - `EXACT_1R` (mặc định) giải SL sao cho lỗ đúng 1R với giá khớp và khối lượng khớp thật, rồi tính TP từ SL mới đó:
     - LONG: `SL = (Q·F·(1+phí) − R) / (Q·(1−phí))`, làm tròn **lên** theo tick.
     - SHORT: `SL = (R + Q·F·(1−phí)) / (Q·(1+phí))`, làm tròn **xuống** theo tick.
     - Nếu cách này nới SL quá `maxSlWidenPct` (25%) so với SL cấu trúc thì giữ SL cấu trúc và báo R thực tế.
   - `KEEP_STRUCTURE` giữ SL cấu trúc, lỗ ≤ 1R.
   - Giá khớp đã vượt qua SL thì trả lỗi `FILL_BEYOND_STOP`; phía server phải đóng vị thế ngay.
6. **Ký quỹ:**
   - margin = notional / đòn bẩy, phải ≤ `maxMarginUsagePct` × số dư khả dụng.
   - Giá thanh lý isolated ước tính phải cách giá vào ≥ `liqBufferMultiple` (1.5) × khoảng SL.
7. **Giới hạn:**
   - tự vào lệnh phải được bật cả trong cài đặt lẫn `TRADING_ENABLED`; bot không bị tạm dừng;
   - symbol không có vị thế hoặc lệnh chờ, không trong thời gian nghỉ;
   - số vị thế < `maxOpenPositions`, số lệnh trong ngày < `maxTradesPerDay`;
   - R đã lỗ trong ngày > −`maxDailyLossR`. Ngày giao dịch bắt đầu lúc 00:00 giờ Việt Nam.

**Ví dụ** BTCUSDT LONG, 1R = 5$, giá vào 68,000, SL 67,200, step 0.001, tick 0.1:

- qty = 0.005 BTC, notional 340$.
- Giữ SL cấu trúc thì lỗ 4.338$ (0.87R), TP = 68,000 + 2 × 800 = 69,600.0 (lãi ròng 7.656$ = 1.53R).
- `EXACT_1R`: SL = 67,067.6, lỗ 4.9997$, TP = 68,000 + 2 × 932.4 = 69,864.8 (lãi ròng 8.9793$ ≈ 1.80R).

Có test cho chính các con số này.
