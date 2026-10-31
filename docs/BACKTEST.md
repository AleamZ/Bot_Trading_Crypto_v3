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
