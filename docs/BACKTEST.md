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
