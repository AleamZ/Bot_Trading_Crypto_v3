# Backtest

```bash
npm run backtest                                         # 90 ngày, cài đặt mặc định, nến DEMO
npm run backtest -- --days 180 --symbols BTCUSDT,ETHUSDT
npm run backtest -- --db                                 # dùng cài đặt bot đã lưu (DB_PATH)
npm run backtest -- --source binance                     # nến Binance thật thay vì DEMO
npm run backtest -- --set risk.maxSlAtr=6 --set general.signalTtlBars=8   # thử cài đặt khác, không lưu
npm run backtest -- --slippage 0.0002 --csv trades.csv   # trượt giá 0.02%, xuất từng lệnh
npm run backtest -- --compare risk.moveSl=false          # chạy lại trên cùng bộ nến với một thay đổi, so tổng
```

Lệnh này chỉ gọi endpoint dữ liệu công khai, không cần khoá API.

Ngoài bảng theo symbol, kết quả còn chia theo:

- **Đồng thuận:** các phương pháp cùng chiều lúc vào lệnh (A+B, A+C, B+C, A+B+C).
- **Thứ tự:** phương pháp nào kích hoạt trước. `A=B` là cùng một nến (nhiều khả năng cùng một nhịp giá), `A→B` là A trước, B ở nến sau. File `--csv` có cột `sequence` tương ứng.

## Cách mô phỏng

- **Vào lệnh LIMIT** (`risk.entryOrder=LIMIT`): lệnh đặt ở giá đóng cửa của nến tín hiệu và nằm chờ suốt nến sau. Chỉ khớp khi nến sau đi **xuyên qua** giá đó (LONG: đáy < giá đặt; SHORT: đỉnh > giá đặt), vì chạm đúng giá thì có thể còn lệnh khác xếp trước. Khớp thì không trượt giá, phí vào là maker. Không khớp thì ghi `LIMIT_NOT_FILLED` và đợt tín hiệu vẫn được thử lại ở nến sau. Trên nến khớp chỉ xét SL, không xét TP, vì đỉnh (LONG) có thể đến trước lúc khớp.

Code nằm ở `packages/core/src/backtest.ts`. Nó dùng **đúng code của bot live**:

- bộ phân tích 3 phương pháp, đồng thuận và chống báo lặp theo đợt (lần vào bị từ chối thì nến 3/3 sau thử lại; số lần bị từ chối chỉ đếm một lần mỗi đợt);
- giới hạn vào lệnh: số vị thế mở, số lệnh và mức lỗ trong ngày giờ Việt Nam, thời gian nghỉ;
- lập kế hoạch SL, khối lượng 1R, SL/TP sau khi khớp.

Các symbol được chạy theo thứ tự thời gian, nên giới hạn số vị thế áp dụng chung cho cả danh sách.

Giả định:

| Điểm | Cách tính |
|---|---|
| Giá vào | giá đóng cửa của nến đạt ngưỡng (bot live vào ngay sau khi nến đóng, theo giá mark) |
| Thoát | đúng giá SL/TP; nếu nến mở cửa đã vượt qua mức đó thì lấy giá mở cửa |
| Nến chạm cả SL lẫn TP | tính là **thua** (cột "Mơ hồ"), vì nến không cho biết cái nào chạm trước |
| Phí | taker 0.05% hai chiều (theo cài đặt) |
| Trượt giá | 0 nếu không truyền `--slippage` |
| Dời SL (`moveSl`) | tiến độ tới TP tính từ đỉnh/đáy của nến; SL mới chỉ có hiệu lực từ nến sau, và chỉ khi giá đóng cửa chưa qua SL mới (bot live kiểm tra giá mark mỗi 15 giây, nên dời sớm hơn một chút) |
| Ký quỹ, giá thanh lý | không mô phỏng |
| Lệnh còn mở cuối giai đoạn | không tính vào kết quả |

Có test kiểm tra mô phỏng không nhìn trước tương lai: cắt lịch sử ngay tại một lệnh thì vẫn ra đúng lệnh đó.

## Kết quả ngày 2026-10-30 (180 ngày, 5 symbol mặc định)

| Cài đặt | Nến | Lệnh | Thắng | Tổng R | Ghi chú |
|---|---|---|---|---|---|
| Mặc định (3/3, SL xa nhất, SL ≤ 3 ATR) | DEMO | 0 | — | 0 | 158 lần 2/3, chỉ 5 lần 3/3, cả 5 bị loại vì SL > 3 ATR |
| `risk.maxSlAtr=6` | DEMO | 4 | 0% | −4.0 | |
| `risk.maxSlAtr=6`, `signalTtlBars=12` | DEMO | 7 | 14% | −4.2 | |
| `autoEntryThreshold=2` (vào lệnh khi 2/3), `maxSlAtr=6` | DEMO | 127 | 34% | −12.7 | PF 0.85 |
| `autoEntryThreshold=2`, `maxSlAtr=6` | Binance thật | 164 | 38% | +8.3 | PF 1.08, sụt giảm tối đa 21R |

Đọc kết quả:

- Luật 3/3 rất hiếm khi xảy ra, nên số lệnh quá ít để kết luận gì.
- Vào lệnh khi 2/3 thì có nhiều lệnh hơn, nhưng chỉ quanh mức hoà vốn.
- Nến DEMO có volume khác hẳn sàn thật, làm thay đổi phương pháp B (phá kênh cần volume tăng), nên kết quả trên DEMO và trên Binance thật khác nhau.

## Theo cặp phương pháp (2026-10-30, 180 ngày, vào lệnh khi 2/3)

7 symbol `BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,LINKUSDT,AVAXUSDT`, `general.autoEntryThreshold=2`, `risk.maxSlAtr=6`, còn lại mặc định. Mỗi ô: số lệnh / tổng R.

| | 15m, nến thật | 15m, nến DEMO | 5m, nến thật |
|---|---|---|---|
| Tổng | 220 / +2.6R (PF 1.02) | 183 / −7.5R (PF 0.94) | 527 / −98.4R (PF 0.73, sụt giảm tối đa 113R) |
| A+B | 129 / +3.6R | 143 / +2.5R | 308 / −76.0R |
| A+C | 57 / −0.8R | 29 / −1.9R | 123 / −18.6R |
| B+C | 32 / −3.9R | 9 / −6.2R | 91 / −1.5R |
| A+B+C | 2 / +3.6R | 2 / −2.0R | 5 / −2.4R |
| A và B cùng nến (`A=B`) | 74 / +2.7R | 94 / −0.4R | 189 / −52.2R |
| A trước, B sau (`A→B`) | 50 / −2.3R | 44 / +2.4R | 109 / −26.4R |

Đọc kết quả:

- Trên 15m không cặp nào có lợi thế rõ. Với vài chục tới hơn trăm lệnh, tổng R tự dao động khoảng ±10–15R do ngẫu nhiên, lớn hơn chênh lệch giữa các cặp.
- "A trước, B xác nhận sau" không tốt hơn "A và B cùng nến": trên nến thật thì kém hơn, trên DEMO thì tốt hơn, tức là nhiễu.
- B+C âm trên cả hai nguồn nến 15m nhưng mẫu nhỏ (32 và 9 lệnh), chưa đủ để kết luận.
- **Khung 5m thua rõ:** −0.19R mỗi lệnh trên 527 lệnh, vượt xa mức ngẫu nhiên. A+B kém nhất.
  - Lý do chính là tỉ lệ thắng thấp hơn: 31%, so với 37% trên 15m.
  - Phí cũng nặng hơn: SL trung vị 0.68% giá (15m: 1.20%), nên phí hai chiều chiếm khoảng 15% của 1R (15m: 8%). Lệnh chạm TP chỉ còn lãi ròng khoảng +1.6R (15m: +1.76R). Vì vậy cần thắng khoảng 38% mới hoà vốn.
  - Các tham số mặc định (EMA, kênh 20 nến...) được chọn cho 15m.

## Dời SL về giá vào ở 50%, khoá lãi 50% ở 75% (2026-10-30)

Cùng 7 symbol, 180 ngày, nến Binance thật, vào lệnh khi 2/3, `maxSlAtr=6`. So sánh trên cùng bộ nến (`--compare risk.moveSl=false`):

| | Bật dời SL | Tắt dời SL |
|---|---|---|
| 15m | 235 lệnh, +9.2R, PF 1.08, sụt giảm tối đa 18.8R | 220 lệnh, +2.6R, PF 1.02, sụt giảm tối đa 20.6R |
| 5m | 569 lệnh, −87.8R, PF 0.72 | 527 lệnh, −98.4R, PF 0.73 |

- Trên 15m: 36 lệnh chạm SL hoà vốn, 24 lệnh chạm SL khoá lãi.
- Dời SL tốt hơn ở cả hai khung, nhưng chênh lệch (+6.6R trên khoảng 230 lệnh ở 15m) vẫn nằm trong mức dao động ngẫu nhiên.
- Có nhiều lệnh hơn vì lệnh đóng sớm hơn, bot rảnh để vào lệnh tiếp.
- Không làm khung 5m có lãi.

## Hiệu lực tín hiệu và bỏ cặp A+B (2026-10-31, khung 5m)

Nến Binance thật, 6 symbol `BTCUSDT,SOLUSDT,BNBUSDT,XRPUSDT,LINKUSDT,NEARUSDT`. Cài đặt gốc giống bot trên VPS lúc đó: `entryTf=5m`, `autoEntryThreshold=2`, `signalTtlBars=20`, `maxSlAtr=6`; còn lại mặc định (dời SL bật).

| Thay đổi so với gốc | Ngày | Lệnh | Thắng | Tổng R | TB R | PF | Sụt giảm tối đa |
|---|---|---|---|---|---|---|---|
| (gốc) | 90 | 379 | 34% | −47.1 | −0.12 | 0.77 | 53.9R |
| `signalTtlBars=4` | 90 | 254 | 32% | −44.0 | −0.17 | 0.70 | 47.0R |
| `signalTtlBars=4`, `maxSlAtr=3` | 90 | 152 | 28% | −41.9 | −0.28 | 0.55 | 45.8R |
| `signalTtlBars=2`, `maxSlAtr=3` | 90 | 116 | 27% | −35.6 | −0.31 | 0.51 | 38.1R |
| `entryRequires=smcSweep` (không vào khi chỉ có A+B) | 90 | 163 | 35% | −15.4 | −0.09 | 0.83 | 21.7R |
| `entryRequires=smcSweep`, `signalTtlBars=4` | 90 | 112 | 35% | −10.0 | −0.09 | 0.84 | 16.8R |
| (gốc) | 180 | 762 | 34% | −83.7 | −0.11 | 0.79 | 92.7R |
| `entryRequires=smcSweep` | 180 | 344 | 35% | −25.1 | −0.07 | 0.86 | 41.1R |
| `trendPullback.enabled=false` (chỉ B+C) | 180 | 189 | 39% | −2.0 | −0.01 | 0.98 | 24.5R |
| chỉ B+C, `signalTtlBars=4` | 180 | 90 | 42% | +4.8 | +0.05 | 1.11 | 14.2R |
| chỉ B+C, `signalTtlBars=4`, `maxSlAtr=3` | 180 | 30 | 30% | −2.3 | −0.08 | 0.84 | 10.6R |

Ở bản gốc 180 ngày, theo cặp: A+B 474 lệnh −74.9R, A+C 155 lệnh −18.0R, B+C 124 lệnh +2.1R, A+B+C 9 lệnh +7.1R.

- Rút ngắn hiệu lực tín hiệu hay siết SL theo ATR chỉ làm ít lệnh hơn; mỗi lệnh lỗ nhiều hơn.
- Bỏ A+B giảm lỗ khoảng 2/3 nhưng vẫn âm. A+C vẫn lỗ; chỉ B+C và A+B+C quanh hoà hoặc dương, mẫu còn nhỏ.
- Tắt A (chỉ vào khi B+C) đưa kết quả về quanh hoà; thêm hiệu lực 4 nến là phương án đầu tiên dương (+4.8R qua 90 lệnh), nhưng +0.05R mỗi lệnh vẫn nằm trong sai số của mẫu này.

## Tìm winrate 70% với lệnh thắng ≥ 0.97R (2026-10-31)

Quét bằng `--sweep … --min-win 0.97` trên nến Binance thật, 6 symbol như trên, `autoEntryThreshold=2`, `signalTtlBars=4`, `maxSlAtr=6` (trừ khi ghi khác). "≥0.97R" là phần trăm lệnh thắng ít nhất 0.97R sau phí; "Thắng" tính mọi lệnh có lãi, kể cả lệnh khoá lãi nhỏ.

Tốt nhất mỗi khung:

| Khung | Cài đặt | Ngày | Lệnh | Thắng | ≥0.97R | Tổng R | PF | Sụt giảm |
|---|---|---|---|---|---|---|---|---|
| 5m | chỉ B+C, RR 1.5, không dời SL | 180 | 89 | 45% | 44% | 0.0 | 1.00 | 16.1R |
| 15m | chỉ B+C, RR 1.5, không dời SL, `maxSlAtr=3` | 180 | 15 | 60% | 60% | +5.7 | 1.95 | 2.0R |
| 15m | chỉ B+C, RR 1.3, không dời SL | 180 | 32 | 53% | 44% | +3.6 | 1.24 | 5.6R |
| 15m | đủ 3 phương pháp, RR 1.2, không dời SL | 180 | 204 | 50% | 38% | +4.1 | 1.04 | 23.9R |
| 1h (xu hướng 4h) | đủ 3 phương pháp, RR 1.2, không dời SL | 365 | 62 | 58% | 53% | +13.9 | 1.56 | 8.0R |
| 1h (xu hướng 4h) | đủ 3 phương pháp, RR 1.1, không dời SL | 365 | 62 | 60% | 45% | +12.5 | 1.52 | 7.0R |

- Không tổ hợp nào đạt 70% lệnh thắng ≥ 0.97R. Cao nhất 60%, nhưng chỉ 15 lệnh trong 180 ngày.
- RR 1 cho winrate cao hơn nhưng sau phí không lệnh nào thắng đủ 0.97R; cần RR khoảng 1.1–1.2 trở lên.
- Dời SL làm "Thắng" (tính cả hoà vốn bị loại) và PF thấp hơn ở RR gần 1, vì nhiều lệnh bị đóng ở giá vào hoặc khoá lãi nhỏ.
- Khung lớn hơn tốt hơn rõ: 5m lỗ hoặc hoà, 15m dương nhẹ, 1h dương nhất. Phí và nhiễu chiếm phần nhỏ hơn của 1R khi SL rộng hơn.

## Phương pháp D, cả 4 phương pháp, 20 symbol, phí (2026-10-31)

Nến Binance thật, `signalTtlBars=4`, không dời SL trừ khi ghi khác. "R/30n" là tổng R chia đều mỗi 30 ngày.

**D (hộp) một mình** (`entryCombos=["D"]`, `maxSlAtr=40`): lỗ trên mọi khung. 3m 90 ngày −119R tốt nhất; 5m 180 ngày −192R; 15m 180 ngày −178R; 1h 365 ngày −28R. Winrate cao nhất ~50% ở RR 1.

**D trong tổ hợp, 1h, 365 ngày:**

| Tổ hợp | 6 symbol | 20 symbol |
|---|---|---|
| A+D, RR 1.5 | 12 lệnh, 67% thắng, +7.2R | 34 lệnh, 53% thắng, +8.7R |
| C+D, RR 1.5 | 13 lệnh, 62% thắng, +5.6R | 34 lệnh, 41% thắng, −1.1R |

**Cả 4 phương pháp, 6 symbol** (`maxSlAtr=40`): 2/4 trên 15m (180 ngày) tốt nhất +16.3R ở RR 1.5 (370 lệnh, +2.7R/30n); trên 1h (365 ngày) +15.1R ở RR 1.2 (90 lệnh, +1.2R/30n). 3/4 chỉ 5–41 lệnh. 5m lỗ.

**Phí, 20 symbol, 15m, A+B+C 2/3, RR 1.2, 180 ngày:** phí 0.05% (taker) +6R; 0.02% (maker) +38R (+6.4R/30n, sụt giảm 36R); 0% +59R. Cùng thử trên 5m: −132R / −62R / −3R, tức 5m không có lợi thế kể cả khi không mất phí.

**Ý từ AI tổng hợp, 6 symbol, A+B+C 2/3:**
- RSI cho SHORT không dưới 35 (`trendPullback.rsiMax=65`): khác biệt nhỏ, không rõ hướng.
- Dời SL về giá vào ở +0.5R (`breakEvenAtTpPct=25`, RR 2) trên 1h: +13.6R/năm, PF 2.0, sụt giảm 4.5R (không dời: +8.3R, PF 1.25, sụt giảm 9.1R). Trên 15m thì kém hơn không dời.

Không phương án nào đạt 20R/tháng; tháng tốt nhất ở phương án phí maker trên 15m có một tháng vượt 20R trong 6 tháng.

## Preset 15m với lệnh vào LIMIT (2026-10-31)

`config/presets/15m-abc-2of3-20sym.json`, 20 symbol, 180 ngày, nến Binance thật. LIMIT mô phỏng như mục "Cách mô phỏng": vào phí maker 0.02%, SL/TP phí taker 0.05%, lệnh không khớp thì bỏ.

| Lệnh vào | RR | Lệnh | Thắng | Tổng R | R/30n | Sụt giảm |
|---|---|---|---|---|---|---|
| MARKET | 1.2 | 622 | 50% | +6.1 | +1.0 | 44.0R |
| **LIMIT** | **1.2** | **616** | **50%** | **+21.0** | **+3.5** | **39.2R** |
| MARKET | 1.5 | 599 | 44% | +2.8 | +0.5 | 40.9R |
| LIMIT | 1.5 | 594 | 43% | +12.2 | +2.0 | 37.7R |

- Mô hình cho lệnh chờ suốt một nến 15m nên gần như lệnh nào cũng khớp. Bot thật chỉ chờ `limitWaitSec` (120 giây, có đặt lại khi giá chạy), nên số lệnh khớp thật có thể ít hơn.
- Dòng phí 0% ở bảng trước (+59R) là trần lý thuyết: SL luôn là lệnh market, phí taker.

## Theo chân BTC (2026-11-02)

Preset 15m ở trên (20 symbol, A+B+C vào ở 2/3, RR 1.2, LIMIT), 180 ngày tới 02/11, nến Binance thật, cùng một bộ nến cho cả ba dòng (`--sweep general.followBtc=OFF,NOT_AGAINST,WITH`). Xu hướng BTC lấy ở khung 1h như mục "Theo chân BTC" trong STRATEGIES.md.

| `followBtc` | Lệnh | Thắng | Tổng R | R/30n | PF | Sụt giảm |
|---|---|---|---|---|---|---|
| OFF | 614 | 50% | +18.8 | +3.1 | 1.06 | 39.2R |
| **NOT_AGAINST** | **563** | **50%** | **+24.3** | **+4.1** | **1.09** | **35.8R** |
| WITH | 391 | 50% | +19.9 | +3.3 | 1.10 | 31.5R |

- NOT_AGAINST vào ít hơn 51 lệnh (lệnh altcoin ngược xu hướng BTC, kèm vài lệnh khác thay đổi theo vì vị thế và giới hạn) và tổng R tăng 5.5R, sụt giảm giảm 3.4R. Với chừng ấy lệnh, chênh lệch vẫn nằm trong mức ngẫu nhiên: đúng hướng, chưa phải bằng chứng chắc chắn.
- WITH (chỉ vào cùng chiều BTC) bỏ thêm 172 lệnh lúc BTC chưa rõ xu hướng: PF và sụt giảm tốt nhất, nhưng tổng R thấp hơn NOT_AGAINST vì ít lệnh hơn.
- Dòng OFF thấp hơn +21R ở mục trước vì khung 180 ngày đã dời tới 02/11.

## Bốn đề xuất của AI, kiểm tra trên hai giai đoạn (2026-11-02)

Preset 15m (20 symbol, A+B+C vào ở 2/3, RR 1.2, LIMIT, theo BTC NOT_AGAINST), nến Binance thật. Bốn đề xuất từ bản tổng hợp AI phân tích:

- `methods.donchianBreakout.invalidateOn=CHANNEL`: bỏ tín hiệu B khi giá đóng lại vào trong kênh. Mặc định MID là bỏ khi đóng qua giữa kênh.
- `methods.donchianBreakout.confirmBars=1`: chờ 1 nến xác nhận vẫn đóng ngoài kênh.
- `general.signalTtlBars=1,2`: tín hiệu chỉ còn hiệu lực 1–2 nến. Với TTL 1, các phương pháp phải kích hoạt **cùng một nến**.
- `risk.maxSlAtr=3,4`: trần SL 3–4 ATR.

**Giai đoạn chọn (180 ngày tới 02/11/2026), 36 tổ hợp.** Trích các dòng chính:

| TTL | Trần SL | Chờ xác nhận | Lệnh | Thắng | Tổng R | PF | Sụt giảm |
|---|---|---|---|---|---|---|---|
| 4 | 6 ATR | 0 (preset hiện tại) | 563 | 50% | +24.3 | 1.09 | 35.8R |
| 4 | 4 ATR | 0 | 525 | 52% | +45.5 | 1.18 | 25.7R |
| 1 | 6 ATR | 0 | 356 | 53% | +37.8 | 1.23 | 16.9R |
| 1 | 4 ATR | 0 | 343 | 54% | +40.4 | 1.25 | 14.9R |
| 1 | 3 ATR | 1 | 71 | 63% | +20.8 | 1.80 | 4.7R |
| 2 | 6 ATR | 0 | 456 | 49% | +12.1 | 1.05 | 28.4R |

- `invalidateOn=CHANNEL` gần như không đổi gì: lúc tốt hơn, lúc kém hơn MID một chút.
- Trần 3 ATR bỏ quá nhiều lệnh. TTL 2 kém hơn cả TTL 1 lẫn TTL 4.

**Kiểm tra trên 180 ngày trước đó (tới 06/05/2026), dữ liệu không dùng để chọn:**

| TTL | Trần SL | Chờ xác nhận | Lệnh | Thắng | Tổng R | PF | Sụt giảm | Cộng cả 360 ngày |
|---|---|---|---|---|---|---|---|---|
| 4 | 6 ATR | 0 (preset hiện tại) | 508 | 44% | −45.5 | 0.84 | 53.6R | **−21.2R** |
| 4 | 4 ATR | 0 | 475 | 44% | −36.2 | 0.86 | 44.4R | +9.3R |
| 4 | 6 ATR | 1 | 365 | 45% | −23.4 | 0.88 | 36.9R | +12.9R |
| 1 | 6 ATR | 0 | 320 | 45% | −23.2 | 0.87 | 28.1R | +14.6R |
| 1 | 4 ATR | 0 | 311 | 44% | −24.9 | 0.86 | 29.9R | **+15.6R** |
| 1 | 4 ATR | 1 | 94 | 43% | −10.8 | 0.80 | 16.9R | +11.1R |

- **Mọi tổ hợp đều lỗ ở giai đoạn này** (thắng 42–45%, dưới mức hoà vốn khoảng 46% của RR 1.2 có phí). Lãi ở 180 ngày gần nhất không lặp lại; chiến lược chưa có lợi thế ổn định.
- Preset hiện tại cộng cả năm là **−21R**.
- TTL 1 là thay đổi duy nhất tốt hơn ở **cả hai** giai đoạn: chỉ tính các phương pháp cùng kích hoạt một nến, khớp với bảng "Thứ tự" ở trên, nơi A=B và A=C lãi còn A→B lỗ. Chờ 1 nến xác nhận bớt lỗ ở giai đoạn kiểm tra, nhưng ở giai đoạn chọn thì lúc hơn lúc kém.
- Ngay cả tổ hợp tốt nhất cả năm (+15.6R trên khoảng 650 lệnh) vẫn nằm trong mức ngẫu nhiên.

## Vì sao nửa năm trước lỗ, nửa năm sau lãi (2026-11-02)

Chạy liền 360 ngày preset 15m (bản mới TTL 1 / SL 4 ATR, và bản cũ TTL 4 / SL 6 ATR). Mỗi lệnh được gắn trạng thái thị trường lúc vào:

- độ "đi thẳng" (efficiency ratio, ER = |giá đổi ròng| / tổng quãng đường) của coin trên 96 nến 15m và của BTC trên 24 nến 1h;
- ATR %, ADX;
- xu hướng BTC 1h;
- giờ vào lệnh;
- MFE, tức giá từng đi thuận bao xa.

Không phải nửa năm trước toàn giảm còn nửa năm sau toàn tăng: cả hai đều có tháng sập mạnh (BTC 11/2025 −15.6%, 02/2026 −19%, 06/2026 −20%) và tháng tăng mạnh (04/2026 +12.7%, 08/2026 +25%). Khác biệt nằm ở **tỉ lệ thắng** (44–45% so với 50–54%), tức các cú phá vỡ có chạy tiếp hay không.

**Đặc điểm lặp lại ở cả hai nửa năm** (bản mới, R tổng; "trước" là 11/2025–05/2026, "gần" là 05–11/2026):

| Lúc vào lệnh | Trước | Gần |
|---|---|---|
| Tất cả | 313 lệnh, −22.7R | 343 lệnh, +40.4R |
| Coin đi lòng vòng (ER 24h < 0.12) | −13.0R | −7.6R |
| BTC 1h chưa rõ xu hướng | 85 lệnh, thắng 35%, −23.2R | +6.4R |
| Coin đi có hướng (ER ≥ 0.15) **và** BTC 1h có xu hướng | 106 lệnh, +7.1R | 101 lệnh, +32.6R |
| Tổ hợp B+C | thắng 29%, −8.5R | +4.0R |

Bản cũ cho cùng kết luận: ER < 0.12 lỗ −28R và −24.6R; lọc ER ≥ 0.15 và BTC rõ thì +1.6R và +32.8R.

- Chiến lược là bắt xu hướng (phá kênh, hồi về EMA). Nó chỉ có lợi thế khi giá đang đi một chiều; lúc thị trường đi ngang lòng vòng thì liên tục dính phá vỡ giả.
- Lệnh thua phần lớn sai từ đầu: 126 trên 335 lệnh thua chưa từng đi thuận được 0.2R, nên vấn đề là chất lượng điểm vào chứ không phải SL.
- Bộ lọc trên vẫn lỗ ở 12/2025, 03/2026 và 04/2026. Tháng 4 lỗ chủ yếu do SHORT (−11.8R) khi BTC tăng 12.7% cả tháng, nên xu hướng BTC 1h là quá ngắn để thấy xu hướng tháng.
- Giờ 06–11h (giờ VN) tốt hơn ở cả hai nửa, 18–23h kém hơn; bằng chứng yếu hơn.
- Các con số này là **lọc lại danh sách lệnh sau khi chạy**, chưa tính việc bỏ một lệnh thì lệnh khác có chỗ vào. Cần làm thành cài đặt thật và backtest lại cả hai nửa năm.

## Bộ lọc đi có hướng và theo BTC WITH, chạy như cài đặt thật (2026-11-02)

Preset 15m hiện tại (TTL 1, SL tối đa 4 ATR, 20 symbol, LIMIT), hai nửa năm như trên, `--sweep general.minEfficiency=0,0.12,0.15,0.18 --sweep general.followBtc=NOT_AGAINST,WITH`. Khác mục trước, bot bỏ lệnh ngay lúc chạy nên lệnh khác có thể vào thay.

| Cấu hình | Trước (tới 06/05) | Gần (tới 02/11) | Cả năm | Lệnh / năm | Sụt giảm lớn nhất |
|---|---|---|---|---|---|
| NOT_AGAINST, ER tắt (preset hiện tại) | −24.9R | +40.4R | +15.6R | 654 | 29.9R |
| **WITH, ER tắt** | **−1.7R** | **+37.9R** | **+36.1R** | 468 | 18.8R |
| WITH, ER ≥ 0.12 | −4.2R | +30.2R | +26.0R | 295 | 14.8R |
| WITH, ER ≥ 0.15 | −7.5R | +22.9R | +15.4R | 226 | 16.3R |
| WITH, ER ≥ 0.18 | +5.7R | +22.4R | +28.0R | 157 | 12.1R |
| NOT_AGAINST, ER ≥ 0.15 | −17.9R | +23.5R | +5.6R | 304 | 20.1R |

- `followBtc=WITH` (chỉ vào cùng chiều khi BTC 1h có xu hướng rõ) là thay đổi ổn định nhất: nửa năm xấu từ −24.9R lên gần hoà vốn, nửa năm tốt gần như giữ nguyên.
- Bộ lọc ER khi chạy thật kém hơn mức lọc lại danh sách lệnh, và không đi một chiều theo ngưỡng (0.15 kém hơn cả 0.12 lẫn 0.18). ER ≥ 0.18 kèm WITH là dòng duy nhất lãi ở cả hai nửa và sụt giảm thấp nhất, nhưng chỉ khoảng 13 lệnh mỗi tháng và nằm ở mép lưới thử, nên bằng chứng yếu.

## Tạm dừng khi bot đang thua (2026-11-02)

Thử để bot tự đổi kiểu đánh theo kết quả gần đây của chính nó: dừng vào lệnh khi tổng R của N lệnh gần nhất (hoặc K ngày gần nhất) âm, vẫn theo dõi lệnh trên giấy để biết lúc nào chạy lại. Đây là lọc lại danh sách lệnh 360 ngày của preset TTL 1 / SL 4 ATR (NOT_AGAINST).

| Quy tắc | Trước | Gần | Cả năm |
|---|---|---|---|
| Luôn đánh | −22.7R | +40.4R | +17.7R |
| Dừng khi 10 lệnh gần nhất lỗ | −6.8R | +20.0R | +13.3R |
| Dừng khi 20 lệnh gần nhất lỗ | −41.6R | +11.9R | −29.7R |
| Dừng khi 50 lệnh gần nhất lỗ | −16.9R | +22.2R | +5.3R |
| Dừng khi 7 ngày gần nhất lỗ | −5.2R | +23.1R | +17.9R |
| Dừng khi 14 ngày gần nhất lỗ | −42.2R | +17.4R | −24.8R |
| Dừng khi 30 ngày gần nhất lỗ | −13.3R | +31.9R | +18.6R |

Kết quả nhảy lung tung theo độ dài cửa sổ: không quy tắc nào tốt hơn ổn định so với luôn đánh. Kết quả của chính bot không báo trước được giai đoạn xấu. Đổi kiểu theo lịch (nửa đầu năm / nửa cuối năm) càng không có cơ sở: ranh giới hai nửa ở đây chỉ là cách chia khung backtest.
