# Server: quét nến, Telegram, API

Code nằm trong `apps/server/src`: `app/` (quét nến, cài đặt, runtime), `telegram/`, `api/`, `db/`. Luật đặt lệnh và giữ SL/TP xem [EXECUTION.md](EXECUTION.md).

## Chạy

```bash
npm run hash-password   # in ra ADMIN_PASSWORD_HASH và SESSION_SECRET, tự dán vào .env
npm run dev             # chạy từ mã nguồn
npm run build && npm start
```

Bot đọc `.env` gần nhất (thư mục gốc repo), hoặc file ở `ENV_FILE`. Mức độ chạy tuỳ `.env`:

| `.env` | Bot làm gì |
|---|---|
| Không có khoá API | Chỉ phân tích bằng dữ liệu công khai, báo 2/3 và 3/3 lên Telegram. Không gọi endpoint tài khoản nào |
| Có khoá, `TRADING_ENABLED=false` (mặc định) | Như trên, cộng watchdog giữ SL/TP cho lệnh bot đã mở. 3/3 chỉ báo "không vào lệnh: tự vào lệnh đang tắt" |
| Có khoá, `TRADING_ENABLED=true` | 3/3 tự vào lệnh (nếu "Tự vào lệnh" trong cài đặt cũng bật và bot không tạm dừng) |

Mỗi database chỉ cho **một bot** chạy: file `bot.db.lock` cạnh database giữ pid. Nếu bot trước chết đột ngột, khoá của nó được lấy lại; nếu nó còn sống, bản thứ hai từ chối khởi động.

## Vòng quét (`Scanner`)

1. Lúc khởi động quét ngay nến vừa đóng, sau đó quét **2 giây sau mỗi lần nến `entryTf` đóng** (nến Binance tính theo giờ UTC).
2. Với từng symbol trong watchlist:
   - lấy 499 nến đã đóng của `entryTf` và `trendTf`; tham số chậm hơn (EMA200 dài hơn) thì lấy nhiều hơn, tối đa 1500;
   - nếu Binance chưa trả nến vừa đóng thì thử lại 5 lần, cách nhau 1.5 giây;
   - chạy 3 phương pháp và đồng thuận (xem [STRATEGIES.md](STRATEGIES.md)).
3. Chống spam theo "đợt" (`advanceEpisode`): mỗi đợt chỉ báo SẴN SÀNG một lần và vào lệnh một lần.
   - Đợt được lưu trong DB nên khởi động lại không báo lặp.
   - Bot nghỉ quá 1 nến thì coi là đợt mới.
4. Gặp 3/3, bot kiểm tra các giới hạn trước khi gọi executor:
   - tự vào lệnh đang bật, bot không tạm dừng;
   - symbol chưa có lệnh của bot, đã qua `cooldownBars` nến kể từ lệnh trước;
   - số vị thế mở, số lệnh trong ngày, mức lỗ R trong ngày (tính từ 00:00 giờ Việt Nam).

   Bị chặn thì ghi sự kiện `ENTRY_SKIPPED` kèm lý do và báo Telegram.
5. Symbol lỗi (mạng, thiếu nến) được gom lại: một lỗi giống nhau chỉ thành một sự kiện cho cả lượt quét.

## Watchdog và user stream

- Chỉ chạy khi có khoá API.
- `Watchdog.reconcile` chạy:
  - lúc khởi động, trước lần quét đầu;
  - sau đó mỗi 15 giây;
  - 300 ms sau mỗi đợt sự kiện từ user data stream.
- Binance mất kết nối thì báo **một lần** "Không gọi được Binance", và báo lại khi gọi được, không báo mỗi 15 giây.
- Vị thế không phải của bot (ví dụ của bot v2 dùng chung tài khoản) chỉ được ghi vào nhật ký, không báo Telegram.

## Telegram

**Cài đặt:**

1. Tạo bot với @BotFather, đặt `TELEGRAM_BOT_TOKEN` trong `.env`, để trống `TELEGRAM_CHAT_ID`.
2. Khởi động bot, gửi `/start` cho bot trên Telegram. Bot trả lời chat id của bạn; trang Telegram trên UI cũng hiện id này.
3. Đặt `TELEGRAM_CHAT_ID` rồi khởi động lại. Từ đó bot chỉ nghe lệnh từ đúng chat này.

**Lưu ý:**

- Hai tiến trình không thể cùng đọc một token: Telegram trả lỗi 409, bot chờ 30 giây rồi thử lại. Bản chạy trên máy cá nhân nên dùng token bot khác.
- Lệnh gửi lúc bot đang tắt (cũ hơn 2 phút) bị bỏ qua, để `/pause` của hôm qua không chạy lúc khởi động.

**Thông báo** (bật/tắt trong cài đặt Telegram):

| Sự kiện | Cờ |
|---|---|
| 🟡 SẴN SÀNG 2/3: từng phương pháp, chiều, SL, lý do | `notifyReady` |
| 🟢 ĐÃ VÀO LỆNH 3/3: khối lượng, SL (lỗ $ và R), TP (lãi ròng $ và R) | `notifyEntry` |
| ⚪ 3/3 nhưng không vào lệnh, kèm lý do | `notifyEntry` |
| ✅ CHẠM TP / ❌ CHẠM SL / ✋ đóng tay / 🚨 đóng khẩn: giá thoát, lãi/lỗ ròng, R, kết quả hôm nay | `notifyExit` |
| 🔴 không vào được lệnh, 🛠 đặt lại SL/TP, ⚠️ lỗi, Binance mất kết nối | `notifyError` |
| 🚨 không đặt được SL/TP | luôn gửi |
| bot khởi động, dừng, tạm dừng, chạy lại, đổi cài đặt | luôn gửi |

- Tin nhắn đi theo hàng đợi, đúng thứ tự.
- Bị giới hạn 429 thì chờ đúng `retry_after` rồi gửi lại.
- Cùng một lỗi chỉ gửi một lần trong 30 phút.

**Lệnh:**

| Lệnh | Tác dụng |
|---|---|
| `/status` | Trạng thái, lý do tự vào lệnh đang tắt (nếu có), vị thế mở, kết quả hôm nay, tín hiệu từng symbol |
| `/positions` | Các lệnh đang mở với SL/TP |
| `/today` | Kết quả hôm nay |
| `/pause` / `/resume` | Tạm dừng / cho vào lệnh mới. SL/TP của lệnh đang mở vẫn hoạt động |

## Đăng nhập web

- Một tài khoản admin, lấy từ `.env`:
  - `ADMIN_USERNAME`;
  - `ADMIN_PASSWORD_HASH`: scrypt, dạng `scrypt:N:r:p:salt:key`, tạo bằng `npm run hash-password`.
- Phiên đăng nhập:
  - cookie `bot3_session` HttpOnly, SameSite=Strict, có `Secure` khi `PUBLIC_URL` là https;
  - sống 7 ngày, ký bằng `SESSION_SECRET`;
  - đổi mật khẩu trong `.env` thì mọi phiên cũ bị đăng xuất.
- Thiếu `SESSION_SECRET` thì bot tự tạo, nhưng phiên mất khi khởi động lại.
- Sai mật khẩu 5 lần trong 15 phút thì IP đó bị chặn tới hết 15 phút (tổng mọi IP: 30 lần).
- Chưa có hash thì mọi route cần đăng nhập trả `401 SETUP_REQUIRED`.

## Cài đặt

- Cài đặt sửa trên UI được lưu trong DB, kiểm tra bằng schema ở `packages/core/src/settings/schema.ts`. Cài đặt không hợp lệ thì không lưu gì và trả `422`.
- Mỗi lần đổi, bot ghi lại ai đổi mục nào.
- `BINANCE_ENV`, `TRADING_ENABLED`, khoá API và token Telegram **không** nằm trong schema, nên UI không bật được giao dịch thật hay đổi tài khoản.

## API

Mọi route dưới `/api` cần đăng nhập, trừ `/api/health` và `/api/auth/*`. Trả JSON.

| Route | Nội dung |
|---|---|
| `GET /health`, `/health/ready`, `/api/health` | Còn sống, không cần đăng nhập |
| `POST /api/auth/login` `{username, password}`, `POST /api/auth/logout`, `GET /api/auth/me` | Đăng nhập |
| `GET /api/status` | Trạng thái bot, cờ `.env`, Binance, user stream, Telegram, lượt quét gần nhất, kết quả hôm nay |
| `GET /api/analysis`, `POST /api/scan` | Phân tích mới nhất của từng symbol; quét lại ngay |
| `GET /api/settings`, `PUT /api/settings` (một phần), `POST /api/settings/reset` | Cài đặt, mặc định, JSON Schema để dựng form, cảnh báo |
| `POST /api/bot/pause`, `POST /api/bot/resume` | Tạm dừng / chạy lại |
| `GET /api/trades?status=OPEN,CLOSED&symbol=&limit=&offset=`, `GET /api/trades/:id` | Lệnh của bot, mới nhất trước |
| `POST /api/trades/:id/close` | Đóng lệnh bằng MARKET; watchdog ghi là đóng tay |
| `GET /api/positions` | Vị thế, lệnh chờ và lệnh algo đang có trên tài khoản |
| `GET /api/today` | Kết quả hôm nay |
| `GET /api/events?before=&limit=&level=error,warn&symbol=` | Nhật ký hoạt động |
| `GET /api/events/stream` | SSE (xem dưới) |
| `GET /api/telegram`, `POST /api/telegram/test` | Trạng thái Telegram, chat id tìm được; gửi tin thử |

**Mã lỗi:**

- Lỗi có thể xử lý trả 4xx với `{ error, message }`:
  - `400`: tham số sai;
  - `401`: chưa đăng nhập;
  - `404`: không có;
  - `409`: trạng thái không cho phép, ví dụ chưa có khoá API;
  - `422`: cài đặt sai, kèm `errors`;
  - `424`: Binance hoặc Telegram lỗi;
  - `429`: đăng nhập sai quá nhiều.
- Lỗi không lường trước trả `500`.
- Không có route nào trả `502`, vì Cloudflare thay nội dung của 502 bằng trang riêng và làm mất lỗi thật.

**SSE (`/api/events/stream`):**

- Gửi ba loại sự kiện:
  - `status`: ảnh chụp trạng thái;
  - `analysis`: từng symbol sau mỗi lượt quét;
  - `log`: mục nhật ký mới, có `id`.
- Kết nối lại với `Last-Event-ID` thì nhận lại các mục bị lỡ.
- Cứ 15 giây gửi một comment `: ping` để Cloudflare và nginx không đóng kết nối.
- Header `x-accel-buffering: no` để nginx không gom dữ liệu lại.

## Database

SQLite (`node:sqlite`, có sẵn trong Node 22.13+), WAL, file `DB_PATH` (mặc định `./data/bot.db`, tính từ thư mục chứa `.env`). Các bảng:

| Bảng | Nội dung |
|---|---|
| `trades` | Mỗi lệnh dạng JSON, kèm cột trạng thái và thời gian để lọc |
| `kv` | Cài đặt, trạng thái tạm dừng, đợt tín hiệu, offset Telegram, chat id tìm được |
| `events` | Nhật ký hoạt động, giữ 60 ngày |

Phiên bản schema nằm trong `PRAGMA user_version`; bot tự nâng cấp khi khởi động. Sao lưu: dừng bot rồi chép cả thư mục `data/`.
