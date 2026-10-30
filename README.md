# Bot_Trading_Crypto_v3

Bot giao dịch Binance USDT-M Futures. Bot phân tích 3 phương pháp trên mỗi symbol:

- **2/3 cùng chiều:** gửi Telegram "SẴN SÀNG", không vào lệnh.
- **3/3 cùng chiều:** tự vào lệnh MARKET, kèm đủ SL và TP.

Khối lượng được tính theo R: chạm SL thì mất đúng 1R.

Luật giao dịch chi tiết: [docs/STRATEGIES.md](docs/STRATEGIES.md). Thiết kế giao diện: [docs/UI_DESIGN.md](docs/UI_DESIGN.md).

## Trạng thái

| Mốc | Nội dung | Trạng thái |
|---|---|---|
| 3a | `packages/core`: chỉ báo, 3 phương pháp, đồng thuận 2/3 và 3/3, tính khối lượng theo R, schema cài đặt | xong |
| 3b | `apps/server`: Binance client, executor (MARKET + SL/TP, đóng khẩn), watchdog, user stream, smoke test DEMO ([EXECUTION.md](docs/EXECUTION.md)) | xong |
| 3c | SQLite, quét nến 2/3 · 3/3, Telegram, API + đăng nhập + SSE ([SERVER.md](docs/SERVER.md)) | xong |
| 3d | Giao diện web pixel (Vite + React): bảng điều khiển, lệnh, nhật ký, cài đặt sinh từ schema, Telegram ([UI_DESIGN.md](docs/UI_DESIGN.md)) | xong |
| 3e | Backtest ([BACKTEST.md](docs/BACKTEST.md)), pm2 + `deploy.sh`, hướng dẫn thay v2 bằng v3 trên VPS ([DEPLOY.md](docs/DEPLOY.md)) | xong; đã thử một lệnh thật trên DEMO (LINKUSDT) |

## Cấu trúc

```
packages/core/   logic thuần (không I/O): indicators, strategies, consensus, risk, settings
apps/server/     Binance client, executor, watchdog (3b); quét nến, Telegram, API, SQLite (3c)
apps/web/        giao diện web (server phục vụ bản build tại /)
docs/            luật giao dịch, thiết kế UI, deploy
```

## Lệnh

```bash
npm install        # .npmrc bật legacy-peer-deps để tránh lỗi npm 10 với vite/vitest
npm test           # test mọi workspace
npm run typecheck
npm run build
npm run smoke:demo -w @bot-v3/server   # kiểm tra kết nối DEMO, chỉ đọc
npm run hash-password  # tạo ADMIN_PASSWORD_HASH và SESSION_SECRET cho .env
npm run backtest       # chạy lại luật của bot trên nến quá khứ (docs/BACKTEST.md)
npm run dev            # chạy bot từ mã nguồn (API ở http://127.0.0.1:8787)
npm run dev:web        # sửa giao diện: Vite ở http://localhost:5173, chuyển /api sang bot đang chạy
npm start              # chạy bản đã build (npm run build trước): API và giao diện ở http://127.0.0.1:8787
```

Cần Node.js 22.13 trở lên (bot dùng `node:sqlite` có sẵn trong Node).

## Cấu hình

Sao chép `.env.example` thành `.env` rồi điền. Không commit `.env`.

Mọi thông số giao dịch (1R, RR, ngưỡng, tham số từng phương pháp...) nằm trong schema `packages/core/src/settings/schema.ts` và sẽ chỉnh được trên UI. Các cờ an toàn (`BINANCE_ENV`, `TRADING_ENABLED`, khoá API, token Telegram) chỉ đọc từ `.env`; UI không đè được.
