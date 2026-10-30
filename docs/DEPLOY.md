# Deploy lên VPS: thay bot v2 bằng v3

Bot v3 thay hẳn v2 trên VPS. **Những gì giữ nguyên:**

| Thứ | Giữ thế nào |
|---|---|
| Tên miền https://bot-trade.aleam.io.vn, Cloudflare Tunnel, cấu hình nginx | không đụng tới |
| Cổng API `127.0.0.1:8787` (nginx chuyển `/api` vào đây) | v3 chạy đúng cổng này |
| Thư mục giao diện `/var/www/bot-trade` (nginx phục vụ `/`) | chép giao diện v3 vào thay giao diện v2 (dựng lại được từ git bất cứ lúc nào) |
| Khoá Binance DEMO trong `.env` của v2 | chép sang `.env` của v3 ngay trên VPS (khoá không rời máy) |
| Mọi thứ tự chạy khi VPS khởi động lại: dịch vụ systemd (`pm2-root`, nginx, cloudflared...) và các app pm2 khác ngoài v2 | không đụng tới; chỉ thay app v2 bằng `bot-v3` trong danh sách pm2 rồi `pm2 save` |

**Những gì thay đổi:**

| v2 | v3 |
|---|---|
| pm2 app `smc-futures-api` | pm2 app `bot-v3` |
| thư mục `~/Bot_trade/Bot_Trading_Crypto_v2` | `~/Bot_trade/Bot_Trading_Crypto_v3` |
| database Postgres | SQLite trong `data/bot.db` của v3 (Postgres để nguyên, không dùng nữa) |
| đăng nhập web theo tài khoản v2 | một tài khoản admin trong `.env` của v3 |

Mọi lệnh dưới đây bạn tự chạy sau khi SSH vào VPS (`ssh <user>@<máy-vps> -p <cổng>`, như khi deploy v2). Làm lần lượt từng bước.

## 0. Ghi lại những gì tự chạy khi VPS khởi động (chỉ xem)

```bash
pm2 ls
grep -o '"name":"[^"]*"' ~/.pm2/dump.pm2
systemctl list-unit-files --state=enabled | grep -Ei 'pm2|nginx|cloudflared|router|smew'
crontab -l 2>/dev/null | grep -i reboot
node -v
```

- `pm2 ls` là các app đang chạy.
- Dòng `"name"` là danh sách pm2 tự bật lại khi khởi động máy.
- `systemctl` là các dịch vụ hệ thống tự bật.

Chép kết quả ra đâu đó để so ở bước 6: sau khi xong, mọi thứ phải còn nguyên, chỉ có `smc-futures-api` đổi thành `bot-v3`.

## 1. Node 22

```bash
node -v
```

Bot v3 cần **Node 22.13 trở lên**. Nếu thấp hơn, cài thêm Node 22 bằng nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 22
```

**Không** chạy `nvm alias default 22`. Node hệ thống giữ nguyên, nên pm2 và các app khác vẫn chạy như cũ.

`deploy.sh` tự bật Node 22 cho riêng nó. Nó ghi đường dẫn đầy đủ của Node 22 vào app `bot-v3`, nên khi VPS khởi động lại, pm2 vẫn chạy bot bằng đúng Node đó.

## 2. Lấy code v3

```bash
cd ~/Bot_trade
git clone https://github.com/AleamZ/Bot_Trading_Crypto_v3.git
cd Bot_Trading_Crypto_v3
source ~/.nvm/nvm.sh 2>/dev/null; nvm use 22 >/dev/null 2>&1; node -v
npm ci
```

## 3. Tạo `.env` cho v3, mang cấu hình cũ sang

Chép mẫu, lấy khoá Binance từ `.env` của v2, rồi đặt tên miền và nơi chép giao diện:

```bash
cd ~/Bot_trade/Bot_Trading_Crypto_v3
cp .env.example .env
V2ENV=~/Bot_trade/Bot_Trading_Crypto_v2/.env
for k in BINANCE_API_KEY BINANCE_API_SECRET; do
  v=$(grep -E "^$k=" "$V2ENV" | tail -n1 | cut -d= -f2-)
  [ -n "$v" ] && sed -i "s|^$k=.*|$k=$v|" .env
done
sed -i 's|^PORT=.*|PORT=8787|; s|^PUBLIC_URL=.*|PUBLIC_URL=https://bot-trade.aleam.io.vn|; s|^TRADING_ENABLED=.*|TRADING_ENABLED=false|; s|^DEPLOY_WEB_ROOT=.*|DEPLOY_WEB_ROOT=/var/www/bot-trade|' .env
grep -cE '^BINANCE_API_(KEY|SECRET)=.+' .env
```

Dòng cuối phải in `2` (đã có đủ hai khoá).

**Mật khẩu web:**

```bash
npm run hash-password
nano .env
```

Trong `nano`:

- dán đè hai dòng `ADMIN_PASSWORD_HASH=` và `SESSION_SECRET=` bằng hai dòng lệnh vừa in;
- điền `TELEGRAM_BOT_TOKEN=` bằng token của **một bot Telegram dành cho VPS**, khác token bạn dùng trên máy (tạo thêm bằng `/newbot` ở @BotFather);
- để trống `TELEGRAM_CHAT_ID=`.

`Ctrl+O`, `Enter`, `Ctrl+X` để lưu và thoát.

`TRADING_ENABLED=false` ở lần chạy đầu: bot chỉ báo tín hiệu cho tới khi bạn kiểm tra xong.

## 4. Xem tài khoản trước khi tắt v2

```bash
npm run smoke:demo -w @bot-v3/server
```

Chỉ đọc. Xem dòng `open positions` và `open algo orders`. Vị thế v2 đang mở sẽ **không còn ai quản lý** sau khi tắt v2:

- v3 chỉ báo "vị thế không phải của bot" và không đụng vào;
- đóng chúng trên https://demo.binance.com, hoặc đặt SL/TP tay, trước hoặc ngay sau bước 5;
- vị thế AVAXUSDT −294 thấy ngày 2026-10-30 không có SL/TP nào trên sàn.

## 5. Chuyển sang v3

```bash
cd ~/Bot_trade/Bot_Trading_Crypto_v3
pm2 stop smc-futures-api
bash deploy.sh
pm2 delete smc-futures-api
pm2 save
curl -s https://bot-trade.aleam.io.vn/api/health
```

`deploy.sh` chạy lần lượt:

1. `git pull`, `npm ci`, typecheck, test, build;
2. khởi động `bot-v3` trên cổng 8787 và chờ `/health/ready`;
3. thay giao diện trong `/var/www/bot-trade` bằng giao diện v3.

`pm2 delete smc-futures-api` gỡ v2 khỏi pm2. `pm2 save` ghi lại danh sách tự bật khi khởi động: `bot-v3` cùng mọi app pm2 khác đang có.

Mở https://bot-trade.aleam.io.vn và đăng nhập bằng mật khẩu ở bước 3.

- Tệp giao diện có hash trong tên, nên không cần `?v=` như v2; `index.html` không bị cache.
- nginx giữ nguyên: `/api` vẫn sang cổng 8787, kể cả luồng SSE `/api/events/stream`. Bot gửi `x-accel-buffering: no` và cứ 15 giây gửi một nhịp, nên nginx không gom dữ liệu và không cắt kết nối.
- Nếu trang không lên, xem cấu hình nginx: `nginx -T 2>/dev/null | grep -n "location /api" -A8`. Phải thấy `proxy_pass http://127.0.0.1:8787;`.

## 6. Kiểm tra tự khởi động

```bash
pm2 ls
grep -o '"name":"[^"]*"' ~/.pm2/dump.pm2
systemctl list-unit-files --state=enabled | grep -Ei 'pm2|nginx|cloudflared|router|smew'
```

So với bước 0: phải giống hệt, chỉ `smc-futures-api` thay bằng `bot-v3`.

Nếu dòng `pm2-root.service` không còn `enabled` (hiếm khi xảy ra), bật lại trong **một phiên SSH mới**, để pm2 dùng Node hệ thống:

```bash
pm2 startup systemd -u root --hp /root
pm2 save
```

Muốn chắc chắn hơn thì khởi động lại VPS: `reboot`. Đợi 1–2 phút, SSH lại, rồi chạy:

```bash
pm2 ls
curl -s https://bot-trade.aleam.io.vn/api/health
```

## 7. Telegram

1. Mở bot Telegram dành cho VPS, bấm **Start**. Bot trả lời chat id.
2. Điền `TELEGRAM_CHAT_ID=` trong `.env` (`nano .env`).
3. Chạy `pm2 restart bot-v3`.
4. Telegram nhận "🤖 Bot v3 đã khởi động". Gửi `/status` để thử.

## 8. Bật tự vào lệnh trên DEMO

Tài khoản phải ở **One-way mode**. Bước 4 đã in ra chế độ này.

```bash
sed -i 's|^TRADING_ENABLED=.*|TRADING_ENABLED=true|' .env
pm2 restart bot-v3
```

Telegram báo "Tự vào lệnh: BẬT". Từ đây, mỗi lần 3/3:

1. bot vào lệnh MARKET theo 1R;
2. đặt SL và TP;
3. báo Telegram.

Không đặt được SL/TP thì bot đóng vị thế ngay (xem [EXECUTION.md](EXECUTION.md)).

## 9. Xoá thư mục v2

Khi v3 đã chạy ổn (khoá Binance đã nằm trong `.env` của v3):

```bash
rm -rf ~/Bot_trade/Bot_Trading_Crypto_v2
```

## Hằng ngày

| Việc | Lệnh |
|---|---|
| Cập nhật code | `cd ~/Bot_trade/Bot_Trading_Crypto_v3 && bash deploy.sh` (tự chép giao diện vào `DEPLOY_WEB_ROOT`) |
| Xem log | `pm2 logs bot-v3 --lines 100` (tệp ở `logs/bot-v3/`) |
| Khởi động lại sau khi sửa `.env` | `pm2 restart bot-v3` |
| Tạm dừng vào lệnh mới | `/pause` trên Telegram, hoặc nút Tạm dừng trên web |
| Thử một lệnh thật nhỏ (mở rồi tự đóng) | `npm run smoke:demo -w @bot-v3/server -- --trade --symbol LINKUSDT --risk 1 --yes-demo` |
| Backtest với cài đặt đang dùng | `npm run backtest -- --db --days 90` |

**Lưu ý:**

- Để không mất cấu hình tự khởi động:
  - không chạy `pm2 kill`, `pm2 delete all`, `pm2 unstartup`;
  - không cài pm2 lần nữa bằng Node 22 (`npm i -g pm2`);
  - mỗi lần thêm hay gỡ app pm2, chạy `pm2 save`.
- Dừng bot (`pm2 stop bot-v3`) không đóng vị thế. SL/TP đã nằm trên Binance; khi bot chạy lại, watchdog đối chiếu và tiếp tục quản lý.
- Mỗi database chỉ một bot chạy được. Không chạy bản thứ hai cùng tài khoản DEMO, kể cả trên máy bạn khi đã bật `TRADING_ENABLED`.
