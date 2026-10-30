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
| 3b | Binance client, đặt lệnh, watchdog SL/TP | chưa |
| 3c | SQLite, API, SSE, Telegram | chưa |
| 3d | Giao diện web | chưa |
| 3e | Backtest, smoke test DEMO, hướng dẫn deploy | chưa |

## Cấu trúc

```
packages/core/   logic thuần (không I/O): indicators, strategies, consensus, risk, settings
apps/server/     (3b-3c) engine + API + Telegram
apps/web/        (3d) giao diện
docs/            luật giao dịch, thiết kế UI, deploy
```

## Lệnh

```bash
npm install        # .npmrc bật legacy-peer-deps để tránh lỗi npm 10 với vite/vitest
npm test           # test mọi workspace
npm run typecheck
npm run build
```

Cần Node.js 22.

## Cấu hình

Sao chép `.env.example` thành `.env` rồi điền. Không commit `.env`.

Mọi thông số giao dịch (1R, RR, ngưỡng, tham số từng phương pháp...) nằm trong schema `packages/core/src/settings/schema.ts` và sẽ chỉnh được trên UI. Các cờ an toàn (`BINANCE_ENV`, `TRADING_ENABLED`, khoá API, token Telegram) chỉ đọc từ `.env`; UI không đè được.
