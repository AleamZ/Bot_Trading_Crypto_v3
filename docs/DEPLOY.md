# Deploy lên VPS

VPS hiện chạy bot v2:

- pm2 app `smc-futures-api`, cổng `8787`, thư mục `~/Bot_trade/Bot_Trading_Crypto_v2`;
- nginx phục vụ giao diện từ `/var/www/bot-trade` và chuyển `/api` sang `127.0.0.1:8787`;
- Cloudflare Tunnel đưa ra ngoài ở https://bot-trade.aleam.io.vn.

Bot v3 nằm ở thư mục riêng, `.env` riêng, database riêng. Làm theo 3 giai đoạn, giai đoạn nào cũng quay lại được:

| Giai đoạn | v2 | v3 | Rủi ro |
|---|---|---|---|
| 1. Chạy song song | chạy như cũ | cổng `8788`, chỉ báo tín hiệu (`TRADING_ENABLED=false`), bot Telegram riêng | không đụng tới v2 hay tài khoản |
| 2. Chuyển hẳn | dừng | cổng `8787`, giao diện mới ở tên miền cũ | trang web đổi; quay lại v2 bằng 3 lệnh |
| 3. Bật giao dịch DEMO | — | thêm khoá DEMO, `TRADING_ENABLED=true` | bot tự vào lệnh 3/3 trên DEMO |

Mọi lệnh dưới đây bạn tự chạy sau khi SSH vào VPS (`ssh <user>@<máy-vps> -p <cổng>`, như khi deploy v2).

## 0. Kiểm tra máy

```bash
node -v
pm2 -v
```

Bot v3 cần **Node 22.13 trở lên** (dùng `node:sqlite` có sẵn trong Node).

Nếu `node -v` thấp hơn, đừng nâng Node hệ thống: v2 dùng module native (argon2) build cho Node hiện tại, nâng lên sẽ làm v2 lỗi. Cài Node 22 riêng bằng nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 22
node -v
```

`deploy.sh` tự dùng Node 22 của nvm và báo cho pm2 chạy v3 bằng Node đó. v2 vẫn chạy bằng Node hệ thống.

## 1. Chạy song song (chỉ báo tín hiệu)

```bash
cd ~/Bot_trade
git clone https://github.com/AleamZ/Bot_Trading_Crypto_v3.git
cd Bot_Trading_Crypto_v3
source ~/.nvm/nvm.sh 2>/dev/null; nvm use 22 2>/dev/null
npm ci
cp .env.example .env
npm run hash-password
```

Mở `.env` (`nano .env`) và sửa:

| Dòng | Giá trị |
|---|---|
| `PORT` | `8788` (v2 đang giữ 8787) |
| `PUBLIC_URL` | để trống trong giai đoạn này |
| `TRADING_ENABLED` | `false` |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | để trống (chưa cần) |
| `TELEGRAM_BOT_TOKEN` | token của **một bot Telegram mới** dành cho VPS (không dùng token của bản trên máy bạn) |
| `TELEGRAM_CHAT_ID` | để trống, lấy ở bước dưới |
| `ADMIN_PASSWORD_HASH`, `SESSION_SECRET` | hai dòng `npm run hash-password` vừa in |

Rồi chạy:

```bash
bash deploy.sh
```

**Lấy chat id:**

1. Mở bot Telegram mới, bấm **Start**. Bot trả lời chat id.
2. Điền `TELEGRAM_CHAT_ID=` trong `.env`.
3. Khởi động lại: `pm2 restart bot-v3`.
4. Telegram nhận "🤖 Bot v3 đã khởi động". Gửi `/status` để thử.

**Mở giao diện** trong giai đoạn này (chưa có tên miền). Trên máy bạn, mở một cửa sổ terminal và giữ nó mở:

```bash
ssh -L 8788:127.0.0.1:8788 <user>@<máy-vps> -p <cổng>
```

Sau đó vào http://localhost:8788 và đăng nhập.

Để bot chạy vài ngày. Kiểm tra:

- Telegram nhận SẴN SÀNG 2/3 khi có tín hiệu;
- `pm2 logs bot-v3` không có lỗi lặp lại.

## 2. Chuyển hẳn sang v3

**Trước khi dừng v2,** xem tài khoản DEMO còn vị thế hay lệnh chờ của v2 không. Vị thế v2 để lại vẫn giữ SL/TP trên Binance, nhưng không còn bot nào quản lý nó. Bot v3 chỉ báo "vị thế không phải của bot" và không đụng vào.

```bash
cd ~/Bot_trade/Bot_Trading_Crypto_v3
cp -a /var/www/bot-trade /root/bot-trade-web-backup-$(date +%Y%m%d-%H%M%S)
pm2 stop smc-futures-api
sed -i 's/^PORT=.*/PORT=8787/; s#^PUBLIC_URL=.*#PUBLIC_URL=https://bot-trade.aleam.io.vn#' .env
WEB_ROOT=/var/www/bot-trade bash deploy.sh
curl -s https://bot-trade.aleam.io.vn/api/health
```

- `deploy.sh` với `WEB_ROOT` sao lưu thư mục web một lần nữa rồi chép giao diện v3 vào.
- Tệp của giao diện có hash trong tên, nên không cần `?v=` như v2; `index.html` không bị cache.
- nginx giữ nguyên: `/api` vẫn sang cổng 8787, kể cả luồng SSE `/api/events/stream`. Bot gửi `x-accel-buffering: no` và cứ 15 giây gửi một nhịp, nên nginx không gom dữ liệu và không cắt kết nối.

Nếu muốn chắc, xem cấu hình nginx:

```bash
nginx -T 2>/dev/null | grep -n "location /api" -A8
```

Thấy `proxy_pass http://127.0.0.1:8787;` (không có `/` ở cuối) là đúng.

**Quay lại v2** (thay `<thư-mục-sao-lưu>` bằng thư mục `/root/bot-trade-web-backup-...` vừa tạo):

```bash
pm2 stop bot-v3
pm2 start smc-futures-api
rm -rf /var/www/bot-trade/* && cp -r <thư-mục-sao-lưu>/. /var/www/bot-trade/
```

Khi v3 đã chạy ổn vài ngày: `pm2 delete smc-futures-api && pm2 save`.

## 3. Bật giao dịch trên DEMO

1. Tạo khoá API trên https://demo.binance.com (Futures). Tài khoản phải ở **One-way mode**.
2. Điền `BINANCE_API_KEY`, `BINANCE_API_SECRET` và `TRADING_ENABLED=true` vào `.env`.
3. Chạy:

```bash
pm2 restart bot-v3
npm run smoke:demo -w @bot-v3/server
```

`smoke:demo` chỉ đọc: kiểm tra khoá, chế độ vị thế, số dư và user stream.

Telegram sẽ báo "Tự vào lệnh: BẬT". Từ đây, mỗi lần 3/3:

1. bot vào lệnh MARKET theo 1R;
2. đặt SL và TP;
3. báo Telegram.

Không đặt được SL/TP thì bot đóng vị thế ngay (xem [EXECUTION.md](EXECUTION.md)).

Muốn thử một lệnh thật trước khi chờ tín hiệu (bot mở rồi tự đóng một lệnh nhỏ):

```bash
npm run smoke:demo -w @bot-v3/server -- --trade --symbol ETHUSDT --risk 1 --yes-demo
```

## Hằng ngày

| Việc | Lệnh |
|---|---|
| Cập nhật code | `cd ~/Bot_trade/Bot_Trading_Crypto_v3 && bash deploy.sh` (thêm `WEB_ROOT=/var/www/bot-trade` từ giai đoạn 2) |
| Xem log | `pm2 logs bot-v3 --lines 100` (tệp ở `logs/bot-v3/`) |
| Khởi động lại sau khi sửa `.env` | `pm2 restart bot-v3` |
| Tạm dừng vào lệnh mới | `/pause` trên Telegram, hoặc nút Tạm dừng trên web |
| Sao lưu database khi bot đang chạy | xem lệnh dưới bảng |
| Backtest với cài đặt đang dùng | `npm run backtest -- --db --days 90` |

Sao lưu database khi bot đang chạy:

```bash
node --disable-warning=ExperimentalWarning -e "new (require('node:sqlite').DatabaseSync)('data/bot.db').exec(\"VACUUM INTO 'data/backup-$(date +%F).db'\")"
```

**Lưu ý:**

- Dừng bot (`pm2 stop bot-v3`) không đóng vị thế. SL/TP đã nằm trên Binance; khi bot chạy lại, watchdog đối chiếu và tiếp tục quản lý.
- Mỗi database chỉ một bot chạy được. Không chạy bản thứ hai cùng tài khoản DEMO, kể cả trên máy bạn khi đã bật `TRADING_ENABLED`.
