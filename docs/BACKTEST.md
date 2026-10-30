# Backtest

```bash
npm run backtest                                         # 90 ngày, cài đặt mặc định, nến DEMO
npm run backtest -- --days 180 --symbols BTCUSDT,ETHUSDT
npm run backtest -- --db                                 # dùng cài đặt bot đã lưu (DB_PATH)
npm run backtest -- --source binance                     # nến Binance thật thay vì DEMO
npm run backtest -- --set risk.maxSlAtr=6 --set general.signalTtlBars=8   # thử cài đặt khác, không lưu
npm run backtest -- --slippage 0.0002 --csv trades.csv   # trượt giá 0.02%, xuất từng lệnh
```

Lệnh này chỉ gọi endpoint dữ liệu công khai, không cần khoá API.

Ngoài bảng theo symbol, kết quả còn chia theo:

- **Đồng thuận:** các phương pháp cùng chiều lúc vào lệnh (A+B, A+C, B+C, A+B+C).
- **Thứ tự:** phương pháp nào kích hoạt trước. `A=B` là cùng một nến (nhiều khả năng cùng một nhịp giá), `A→B` là A trước, B ở nến sau. File `--csv` có cột `sequence` tương ứng.

## Cách mô phỏng

Code nằm ở `packages/core/src/backtest.ts`. Nó dùng **đúng code của bot live**:

- bộ phân tích 3 phương pháp, đồng thuận và chống báo lặp theo đợt;
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
