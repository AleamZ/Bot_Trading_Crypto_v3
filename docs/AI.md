# AI: phân tích lệnh và chat

AI là phần phụ trợ: nó **không** đặt lệnh, đóng lệnh hay đổi cài đặt. Nó làm hai việc:

1. **Phân tích từng lệnh** khi lệnh chạm TP hoặc SL: vì sao thắng, vì sao thua, nên đổi gì. Kết quả lưu ở trang **AI phân tích** để dùng khi sửa logic bot.
2. **Chat hỗ trợ**: hỏi bất cứ điều gì về bot (nút **Hỏi AI** ở góc phải mọi trang, hoặc `/ask` trên Telegram). AI đọc dữ liệu thật của bot để trả lời.

## Bật AI

AI dùng một endpoint kiểu OpenAI `/chat/completions`. Trên VPS là router ở `http://localhost:20128/v1`.

Thêm vào `.env` rồi `pm2 restart bot-v3`:

```bash
AI_BASE_URL=http://localhost:20128/v1
AI_API_KEY=          # để trống nếu router không cần key
AI_MODEL=cx/gpt-5.6-sol
AI_TIMEOUT_MS=120000
```

- Để trống `AI_BASE_URL` thì AI tắt; bot vẫn giao dịch bình thường.
- Key chỉ nằm trong `.env`, không bao giờ hiện trong log hay thông báo lỗi.
- Log khởi động ghi `AI on` (kèm host và model) hoặc `AI off`.

Trong **Cài đặt → AI**:

| Cờ | Mặc định | Ý nghĩa |
|---|---|---|
| `autoReview` | bật | Tự phân tích mỗi lệnh chạm TP hoặc SL |
| `reviewManualExits` | tắt | Phân tích cả lệnh đóng tay hoặc đóng khẩn |
| `notifyReview` | bật | Gửi tóm tắt phân tích lên Telegram (🧠) |
| `chatEnabled` | bật | Cho phép chat trên web và `/ask` |

## Phân tích lệnh

Khi lệnh đóng, bot tính **dữ kiện bằng code** rồi mới đưa cho AI, để AI không phải tự đoán số:

- **Lệnh:** chiều, giá vào/thoát, SL/TP, khoảng SL theo % và theo ATR, R thực tế, thời gian giữ lệnh.
- **Lúc vào:** từng điều kiện ✓/✗ của 3 phương pháp trên nến vào lệnh (giống trang Phân tích), ATR %, ADX, xu hướng khung lớn, đồng thuận.
- **Lúc thoát:** xu hướng khung lớn.
- **Diễn biến trong lệnh:** đi có lợi nhất và bất lợi nhất (theo R), đã đi được bao nhiêu % tới TP, số nến.
- **Nến quanh lệnh:** tối đa 80 nến, giờ Việt Nam.

AI trả về JSON: kết luận, vì sao vào, diễn biến, nguyên nhân, nhận xét từng phương pháp, bài học, đề xuất thay đổi (kèm mức tự tin thấp/vừa/cao), nhãn.

- Phân tích chạy lần lượt, không chặn vòng quét hay việc đặt lệnh.
- Lỗi (AI không trả lời, trả sai JSON) thì lưu trạng thái `FAILED` kèm lỗi; bấm **Phân tích lại** trên trang.
- Bot khởi động lại giữa chừng thì các phân tích đang chờ được chạy lại.
- Lệnh cũ (trước khi bật AI) hoặc lệnh đóng tay: mở lệnh ở trang **Lệnh** → **Xem AI phân tích lệnh này** → **Phân tích ngay**.

**Bài học tổng hợp:** nút **Tổng hợp** trên trang AI phân tích gửi thống kê (tỉ lệ thắng, tổng R theo phương pháp, theo kiểu thoát, theo symbol, theo chiều) cùng các bài phân tích gần nhất cho AI. AI trả về mẫu lặp lại, điểm yếu, đề xuất thay đổi và thử nghiệm nên chạy.

> Đề xuất của AI dựa trên mẫu nhỏ. Kiểm tra bằng backtest ([BACKTEST.md](BACKTEST.md)) trước khi đổi cài đặt.

## Chat

AI trả lời bằng cách gọi các công cụ **chỉ đọc** của bot:

| Công cụ | Đọc gì |
|---|---|
| `bot_status` | Trạng thái, lý do tự vào lệnh đang tắt, vị thế mở, kết quả hôm nay, đồng thuận từng symbol |
| `bot_settings` | Cài đặt hiện tại |
| `symbol_analysis` | Điều kiện ✓/✗ từng phương pháp của một symbol bất kỳ trên nến vừa đóng |
| `list_trades`, `trade_detail` | Lệnh của bot |
| `trade_reviews`, `review_insights` | Các bài phân tích AI và bài học tổng hợp |
| `recent_events` | Nhật ký hoạt động |
| `bot_rules` | Luật giao dịch ([STRATEGIES.md](STRATEGIES.md), [EXECUTION.md](EXECUTION.md)) |

- Model không hỗ trợ gọi công cụ thì bot gửi kèm một ảnh chụp trạng thái và lệnh gần đây thay thế.
- Lịch sử chat trên web nằm trong tab trình duyệt (đóng tab là mất), tối đa 30 tin mỗi lần hỏi.
- Trên Telegram: `/ask vì sao chưa vào lệnh BTCUSDT?`

## Dữ liệu

- Bảng `trade_reviews` trong SQLite: mỗi lệnh một dòng (dữ kiện, kết quả AI, model, lỗi).
- Bài học tổng hợp gần nhất nằm trong bảng `kv` (khoá `ai.insights`).
- Dữ liệu gửi cho AI: số liệu lệnh, nến, cài đặt, nhật ký. Không gửi khoá Binance, token Telegram hay mật khẩu.
