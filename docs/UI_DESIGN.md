# Thiết kế giao diện: phong cách "pixel game UI"

Nguồn: ảnh mẫu "Spritecraft — Light pixel-art game UI kit" bạn gửi ngày 2026-10-30. Màu dưới đây là màu mình ước lượng từ ảnh.

Đã dựng ở `apps/web` (mốc 3d): token và thành phần nằm trong `src/styles.css` và `src/ui.tsx`, các trang trong `src/pages/`.

## Tinh thần

- Nền giấy da (parchment), viền mực đen dày, bevel 8-bit vuông: không bo góc, không đổ bóng mờ.
- Bóng là **khối đặc lệch xuống dưới**, không blur.
- Chữ mono. Nhãn VIẾT HOA có giãn chữ. Đường kẻ phân cách dạng nét đứt.
- Màu nhấn ít nhưng rõ nghĩa: xanh lá = LONG/OK, đỏ = SHORT/lỗi/lỗ, cam = READY/cảnh báo, xanh dương = thông tin/ENTER.

## Token màu

| Token | Màu | Dùng cho |
|---|---|---|
| `--parch` | `#f3e7c9` | nền trang (có lưới mờ 24px) |
| `--vell` | `#fbf6e8` | mặt panel |
| `--sunk` | `#e6d5a8` | ô nhập lõm, ô trống của thanh đo |
| `--ink` | `#1c1b19` | viền, chữ chính, header |
| `--ink-soft` | `#6f6146` | chữ phụ, nhãn |
| `--shadow` | `#cdbf9c` | khối bóng dưới panel |
| `--quest` | `#2f9e44` | xanh lá: LONG, thắng, đang chạy |
| `--coin` | `#f0a12f` | cam: READY, cảnh báo |
| `--heart` | `#d9413f` | đỏ: SHORT, lỗi, lỗ |
| `--sky` | `#3a9be0` | xanh dương: thông tin, ENTER |

Mỗi màu nhấn có thêm một tông sáng (viền trên/trái) và một tông tối (viền dưới/phải) để làm bevel.

Có giao diện tối: nền `--ink`, panel `#2a2823`, chữ `#f3e7c9`, giữ nguyên các màu nhấn.

## Chữ

- Chữ chính: `IBM Plex Mono`, tự host font trong `apps/web` để không phụ thuộc CDN.
- Số liệu lớn (giá, R, PnL): đậm, `font-variant-numeric: tabular-nums`.
- Nhãn panel: 12px, VIẾT HOA, `letter-spacing: .12em`. Tiêu đề panel nằm trái, phụ đề nằm phải, màu `--ink-soft`.

## Thành phần

| Thành phần | Mô tả | Dùng trong bot |
|---|---|---|
| **Header** | Dải đen có vân scanline. Bên trái: logo pixel lưới 4×4 và tên bot. Giữa: dòng mô tả. Bên phải: chip kem viền đen | `BOT V3`, `DEMO`, `AUTO ON/OFF`, `TELEGRAM OK` |
| **Panel** | Viền mực 4px, mặt `--vell`, khối bóng `--shadow` 6px bên dưới, header có gạch nét đứt | mọi khối trên dashboard |
| **Nút (bevel 4 cạnh)** | Nền màu nhấn, cạnh trên/trái sáng, dưới/phải tối. Hover thì nhô lên 2px, nhấn thì lún xuống 4px | Bắt đầu / Tạm dừng / Lưu / Gửi thử / Đóng lệnh |
| **Ô nhập (bevel lõm)** | Nền `--sunk`, viền trong tối ở trên/trái | form cài đặt |
| **Checkbox** | Ô vuông lõm; khi bật thì nền xanh lá, dấu tick trắng | bật/tắt phương pháp, loại thông báo |
| **Tab** | Thanh phân đoạn, tab đang chọn nổi lên màu xanh lá | Chung / Quản lý vốn / Phương pháp / Telegram |
| **Ô số liệu** | Ô nhỏ viền đen: số đậm, nhãn nhỏ viết hoa bên dưới | số dư, R hôm nay, lệnh hôm nay, vị thế mở |
| **Thanh đo phân ô (HUD meter)** | Dãy ô vuông, ô đầy theo màu, ô trống `--sunk`; nhãn trái, giá trị `x / y` phải | đồng thuận 0-3 / 3, lỗ ngày đã dùng / tối đa (đỏ), số vị thế / tối đa, khoảng cách tới SL và TP |
| **Chip** | Khối màu đặc, icon + chữ trắng viết hoa, bevel | LONG, SHORT, READY, ENTER, SL HIT, TP HIT, LỖI |
| **Ô icon** | Icon Phosphor (regular) trong ô vuông viền đen | điều hướng, thao tác nhanh |
| **Panel nhân vật** | Nền sọc ngang, hình pixel ở giữa | trang trống hoặc trạng thái bot (mascot đổi màu theo trạng thái) |

## Bố cục dashboard

- Lưới 3 cột trên desktop, 1 cột trên mobile.
- Hàng đầu có các ô số liệu và các thanh đo rủi ro trong ngày.
- Bảng **symbol × A/B/C/D**: mỗi ô là một chip (LONG xanh, SHORT đỏ, trống thì ô lõm). Cuối hàng là thanh đo đồng thuận, mỗi ô một phương pháp đang bật.
- Panel vị thế đang mở: giá vào, SL, TP và PnL realtime. Một thanh đo cho thấy giá đang nằm ở đâu giữa SL và TP.
- Bảng tin báo gần đây, dùng chip theo loại tin.

## Chuyển động

- Chỉ dùng chuyển động ngắn kiểu "bậc": `steps()` khoảng 80-120ms cho hover và nhấn.
- Ô thanh đo bật sáng lần lượt khi giá trị đổi.
- Tôn trọng `prefers-reduced-motion`.

## Trang đã có

| Trang | Nội dung |
|---|---|
| Đăng nhập | Mascot, ô tên và mật khẩu; chưa có hash thì hướng dẫn `npm run hash-password` |
| Bảng điều khiển | Cảnh báo (tự vào lệnh tắt và vì sao, Binance lỗi, cài đặt cần xem lại); ô số liệu; bảng symbol × A/B/C (bấm vào hàng để xem lý do và SL từng phương pháp); panel Bot (mascot theo trạng thái, thanh đo lỗ ngày / vị thế / lệnh ngày, giờ quét tới, Tạm dừng / Chạy lại, Quét ngay); vị thế đang mở (SL, TP kèm R, giá mark, lãi/lỗ chưa chốt, thanh SL → TP, nút Đóng lệnh bấm hai lần); tin gần đây |
| Phân tích | Chart nến (TradingView lightweight-charts, Apache-2.0, giờ Việt Nam) vẽ những gì bot nhìn: EMA của A (cả EMA khung lớn), kênh Donchian của B, swing và vùng FVG của C, hộp hôm trước của D (vùng mua xanh, vùng bán đỏ), mũi tên mỗi lần A/B/C/D kích hoạt, mốc Báo và Vào, lệnh của bot (vào, vùng TP xanh và vùng SL đỏ, đường SL đã dời, đường SL/TP lệnh đang mở) và vùng SL/TP dự kiến bên phải nến cuối. FVG là hộp có viền (nhạt khi đã lấp). Các vùng vẽ dưới nến bằng primitive riêng (`chartZones.ts`); độ đậm vùng TP/SL chỉnh được (mặc định 70%, nhớ trong trình duyệt). Bật/tắt từng lớp. Bên cạnh: "Bot đang thấy gì" (đồng thuận, tín hiệu còn hiệu lực; trang có thể thấy nến mới vài giây trước khi bot quét, khi đó ghi "sẽ báo" thay vì "đã báo"), "Nếu vào lệnh lúc này" (SL gộp, % và ATR, khối lượng 1R, TP, đòn bẩy, ký quỹ, giá thanh lý, có bị giới hạn nào chặn không). Dưới: từng phương pháp với mọi điều kiện ✓/✗ cho LONG và SHORT kèm số liệu, và các lần kích hoạt gần đây |
| Lệnh | Lọc theo trạng thái và theo ngày (Từ ngày / Đến ngày, nút Hôm nay / 7 ngày / Tháng này / Tất cả), tổng kết trang, bảng lệnh; bấm vào hàng để xem chi tiết (SL cấu trúc, lỗ/lãi dự kiến, phí, client id, ghi chú); lệnh đã đóng có nút sang bài AI phân tích và chart |
| Thống kê | Hai tab: **Theo tháng** và **Toàn bộ** (`#/stats/all`). Theo tháng: chọn tháng (Tháng trước / Tháng sau, `#/stats/2026-10`), đổi đơn vị Tiền ($) / Theo R (nhớ trong trình duyệt). Ô số liệu: lãi/lỗ ròng tháng, winrate theo lệnh, số ngày lãi / lỗ, ngày tốt và tệ nhất. Biểu đồ SVG: cột lãi (xanh) / lỗ (đỏ) mỗi ngày quanh trục 0, ghi số ở ngày tốt và tệ nhất, đánh dấu hôm nay; bên dưới là đường lũy kế trong tháng (trục riêng, cùng đơn vị); rê chuột hoặc chạm vào ngày để xem ròng $ và R, số lệnh thắng / hòa / thua, phí, lũy kế. Panel Winrate (tháng đang xem hoặc từ đầu) có ba thẻ: theo lệnh, theo R, theo tiền thật, mỗi thẻ một thanh tỉ lệ thắng / thua. Bảng từng ngày có lệnh, mới nhất trước. Toàn bộ: ô số liệu (lãi/lỗ ròng, số lệnh, winrate, hệ số lãi, sụt giảm lớn nhất), đường vốn qua từng lệnh (cột lãi/lỗ mỗi lệnh, đường lũy kế, rê chuột xem symbol, chiều, phương pháp, kiểu thoát), lãi/lỗ theo tháng, ba thẻ winrate, bốn bảng chia theo symbol / phương pháp đồng thuận / chiều / kiểu thoát, mỗi hàng có thanh lãi/lỗ quanh 0. Nút **Xoá số liệu lãi/lỗ** (bấm hai lần) cho thống kê và trang Lệnh bắt đầu lại từ lúc đó, giữ bài AI phân tích; **Khôi phục số liệu cũ** bỏ mốc |
| AI phân tích | Bài học tổng hợp (ô số liệu theo phương pháp, mẫu lặp lại, điểm yếu, đề xuất kèm mức tự tin, thử nghiệm nên chạy; nút Tổng hợp). Lọc Tất cả / Thua / Thắng và theo ngày. Mỗi lệnh một thẻ: chiều, thắng/thua, kiểu thoát, R, giá vào → thoát, SL/TP (% và ATR), đi có lợi / bất lợi nhất, phương pháp, xu hướng khung lớn, rồi kết luận, vì sao vào, diễn biến, nguyên nhân, từng phương pháp, bài học, đề xuất, nhãn; nút Chart và Phân tích lại |
| Chat AI | Nút "Hỏi AI" cố định góc phải dưới mọi trang. Khung chat: câu hỏi gợi ý, trả lời có đậm/danh sách/mã, dòng "đã xem" liệt kê dữ liệu AI đã đọc, Enter để gửi, lỗi có nút Thử lại. AI tắt thì hiện hướng dẫn bật. Thông báo nổi (toast) chuyển sang góc trái để không đè nút |
| Nhật ký | Mọi sự kiện, lọc cảnh báo/lỗi và theo ngày, tải thêm; sự kiện mới hiện ngay qua SSE |
| Cài đặt | Tab Chung / Quản lý vốn / Phương pháp / Telegram sinh từ JSON Schema của server: tiêu đề, mô tả, đơn vị, khoảng hợp lệ, giá trị mặc định. Đánh dấu ô đã sửa, chặn lưu khi ô số sai, lỗi 422 hiện đúng ô. Chỉ gửi phần đã đổi. Danh sách chọn nhiều (tổ hợp được tự vào lệnh) hiện thành các ô tick |
| Telegram | Trạng thái, lỗi gần nhất, chat id tìm được (nút chép), gửi tin thử, danh sách lệnh chat |

Giao diện sáng/tối theo hệ thống, đổi được bằng nút trên thanh điều hướng (nhớ trong trình duyệt). Định tuyến bằng `#/...` nên server chỉ cần trả `index.html`.
