# Đặt lệnh và giữ SL/TP

Code nằm trong `apps/server/src/engine` và `apps/server/src/binance`.

**Luật bất biến:** vị thế của bot không bao giờ được tồn tại thiếu SL hoặc TP. Nếu không đặt được, bot đóng vị thế bằng lệnh MARKET reduce-only.

## Vào lệnh (`Executor.enter`)

Mỗi symbol có một khoá (`KeyedLock`), nên executor và watchdog không bao giờ cùng thao tác trên một symbol.

1. **Kiểm tra:**
   - tài khoản ở One-way mode (Hedge mode không cho gửi `reduceOnly`);
   - symbol đang `TRADING`;
   - symbol **không có vị thế, lệnh chờ hay lệnh algo nào**, kể cả lệnh không phải của bot.
2. **Lập kế hoạch theo giá mark hiện tại:**
   - SL gộp, khoảng SL, khối lượng 1R và TP (xem `STRATEGIES.md`);
   - đòn bẩy: `AUTO` chọn mức nhỏ nhất đủ ký quỹ, `FIXED` dùng đúng cài đặt; cả hai không vượt mức sàn cho phép ở bậc ứng với giá trị lệnh (xem `STRATEGIES.md` mục 6);
   - kiểm tra ký quỹ và giá thanh lý.
3. **Ghi lệnh `OPENING` vào DB trước khi gửi bất cứ gì.** Nếu bot chết giữa chừng, watchdog sẽ nhận lại lệnh này.
4. **Đặt lệnh trên sàn:**
   - margin type (lỗi `-4046` "không cần đổi" thì bỏ qua) và đòn bẩy;
   - **MARKET** với `newClientOrderId = v3e-<id>`, `newOrderRespType=RESULT`.
5. Từ **giá khớp và khối lượng khớp thật**, tính SL/TP cuối (`finalizeAfterFill`, chế độ `EXACT_1R`). Binance DEMO trả kết quả lệnh MARKET **không có `avgPrice`**; khi đó giá vào lấy từ vị thế (`entryPrice`).
6. **Đặt SL trước, rồi TP**:
   - qua `POST /fapi/v1/algoOrder`, `algoType=CONDITIONAL`, `STOP_MARKET` / `TAKE_PROFIT_MARKET`;
   - bằng `quantity` + `reduceOnly=true` (không dùng `closePosition`), `workingType=MARK_PRICE`;
   - client id `v3s-<id>-<n>` và `v3t-<id>-<n>`.
7. Đọc lại `openAlgoOrders`, xác nhận đủ cả hai lệnh với đúng khối lượng, rồi chuyển lệnh sang `OPEN`.

## Khi có lỗi

| Tình huống | Bot làm gì |
|---|---|
| Binance từ chối lệnh vào (4xx) | Lệnh thành `FAILED`; không có vị thế nào được mở |
| Lệnh vào trả **không rõ kết quả** (timeout, mạng, 5xx "unknown") | **Không gửi lại.** Tra theo `v3e-<id>` tối đa 3 lần. Có lệnh thì bảo vệ vị thế; không có lệnh và không có vị thế thì `FAILED`; không thấy lệnh nhưng có vị thế thì vẫn bảo vệ |
| Đặt SL/TP lỗi | Thử lại `protectionRetries` lần (mặc định 2). Nếu không rõ kết quả thì tra theo client id trước khi thử lại, để không tạo lệnh trùng |
| `-2021` (giá đã vượt qua mức SL/TP) | Không thử lại; đóng vị thế ngay |
| Vẫn không đặt được SL hoặc TP | Huỷ lệnh algo của bot, đóng vị thế bằng MARKET reduce-only (thử 3 lần), kiểm tra vị thế về 0. Gửi `PROTECTION_FAILED`; lệnh thành `CLOSED` với lý do `EMERGENCY` |
| Lỗi bất ngờ bất kỳ sau khi lệnh vào đã gửi (dữ liệu lạ từ sàn, lỗi code) | Coi như không đặt được SL/TP: đóng vị thế, gửi `PROTECTION_FAILED` với lý do `UNEXPECTED_ERROR` |
| Đóng khẩn cũng lỗi | Gửi `PROTECTION_FAILED` (flattened = false); lệnh giữ trạng thái mở để watchdog tiếp tục bảo vệ hoặc đóng |

REST client:
- Chỉ tự gửi lại **lệnh đặt** khi Binance khẳng định chưa xử lý: 503 "Service Unavailable", `-1008`, 429/418 (chờ theo Retry-After).
- Lỗi `-1021` (lệch giờ): đồng bộ giờ rồi gửi lại một lần.
- Các lệnh đọc được thử lại cả khi gặp lỗi mạng.

## Watchdog (`Watchdog.reconcile`)

Chạy lúc khởi động, mỗi 15 giây, và ngay sau mỗi sự kiện từ user data stream (xem [SERVER.md](SERVER.md)). Mỗi lượt:

- **Vị thế mất SL hoặc TP** (bị huỷ tay, hết hạn): đặt lại với client id mới (`-<n+1>`) và gửi `PROTECTION_REPAIRED`. Không đặt lại được thì đóng vị thế.
- **Khối lượng lệnh bảo vệ lệch với vị thế** (bị đóng bớt bằng tay): huỷ rồi đặt lại theo khối lượng mới.
- **Vị thế đã về 0:**
  - xác định lý do đóng: TP, SL hay MANUAL. Ngay sau khi khớp, Binance có thể vẫn báo lệnh SL/TP là NEW hoặc chưa có khối lượng, nên watchdog hỏi lại tối đa 3 lần, cách nhau 1 giây, trước khi ghi là đóng tay. Khi bot khởi động, lệnh đóng trong 30 ngày qua bị ghi nhầm là đóng tay được kiểm tra lại và sửa nếu Binance cho thấy SL/TP đã khớp;
  - **huỷ lệnh còn lại**, vì Binance futures không có OCO;
  - tính giá thoát, phí, lãi/lỗ ròng và R từ `userTrades`;
  - gửi `TRADE_CLOSED`.
- **Lệnh `OPENING` sau khi bot khởi động lại:**
  - nếu có vị thế: tính SL/TP từ giá vào của vị thế rồi đặt;
  - nếu không: đánh dấu `FAILED`.
- **Dời SL** (khi SL và TP đều còn nguyên, cài `moveSl`):
  - Tiến độ tới TP tính từ **giá mark** của vị thế, mỗi lượt 15 giây; mức xa nhất được lưu vào lệnh (`bestProgress`).
  - Đủ mức thì đặt SL mới (client id `-<n+1>`) **trước**, rồi mới huỷ SL cũ, nên vị thế không lúc nào thiếu SL. Huỷ SL cũ lỗi thì cả hai cùng là reduce-only; SL mới gần hơn nên chạy trước, SL cũ bị huỷ khi lệnh đóng.
  - Giá đã quay lại qua mức SL mới (đặt sẽ khớp ngay) thì chưa dời, chờ lượt sau.
  - Đặt SL mới lỗi thì giữ SL cũ và báo lỗi.
  - Mỗi lần dời ghi vào `slMoves` của lệnh và gửi `STOP_MOVED`. Lệnh chạm SL đã dời được báo là "SL hoà vốn" hoặc "SL khoá lãi".
- **Lệnh đang kích hoạt** (`TRIGGERING`/`TRIGGERED`): không đụng vào, đợi lượt sau.
- **Vị thế không phải của bot:** chỉ báo `FOREIGN_POSITION` một lần, không đụng vào.
- **Lệnh algo `v3…` sót lại** ở symbol bot không còn giao dịch: huỷ.

## User data stream

- Mở WebSocket `wss://demo-fstream.binance.com/ws/<listenKey>`; đổi được bằng `BINANCE_WS_URL`.
- Gia hạn listenKey mỗi 30 phút và kết nối lại sau 23 giờ.
- Khi rớt kết nối thì kết nối lại với backoff (1 giây, tăng dần tới 60 giây).
- Sự kiện dùng: `ORDER_TRADE_UPDATE`, `ALGO_UPDATE`, `ACCOUNT_UPDATE`, `listenKeyExpired`.
- Stream chỉ giúp phản ứng nhanh hơn. Watchdog vẫn đối chiếu bằng REST, nên mất stream cũng không bỏ sót lệnh đóng.

## Kiểm tra trên DEMO

```bash
npm run smoke:demo -w @bot-v3/server
```

Chỉ đọc:
- đồng bộ giờ, bộ lọc của watchlist, nến 15m đã đóng, giá mark;
- khi có key: chế độ vị thế, số dư, vị thế và lệnh đang mở, kết nối user stream.

```bash
npm run smoke:demo -w @bot-v3/server -- --trade --symbol ETHUSDT --risk 1 --yes-demo
```

Đặt **một lệnh thật trên DEMO** qua executor (SL cách khoảng 1%), in ra SL/TP trên sàn, rồi đóng lệnh. Không chạy lệnh này trên symbol mà bot khác đang đánh cùng tài khoản.

## Đã thử thật trên DEMO (2026-10-30)

`smoke:demo --trade --symbol LINKUSDT --risk 1`:

- **Lần 1:** DEMO trả kết quả lệnh MARKET không có `avgPrice`. Executor khi đó lỗi trước khi đặt SL/TP, nên vị thế 8.21 LINK nằm trần khoảng một phút rồi mới được đóng tay.
- **Đã sửa hai chỗ:**
  - chuẩn hoá kết quả lệnh (`toOrderResult`);
  - mọi lỗi sau khi vào lệnh đều dẫn tới đóng vị thế.

  Có test cho cả hai.
- **Lần 2:** khớp 8.24 @ 11.041. Sàn có STOP_MARKET 8.24 @ 10.931 (lỗ 0.9969$ ≈ 1R) và TAKE_PROFIT_MARKET 8.24 @ 11.261 (= 11.041 + 2 × 0.110). Sau đó đóng sạch, không còn lệnh sót.
