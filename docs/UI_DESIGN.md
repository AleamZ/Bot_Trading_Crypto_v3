# Thiết kế giao diện: phong cách "pixel game UI"

Nguồn: ảnh mẫu "Spritecraft — Light pixel-art game UI kit" bạn gửi ngày 2026-10-30. Màu dưới đây là màu mình ước lượng từ ảnh. Khi dựng UI ở mốc 3d sẽ chỉnh lại cho khớp.

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
- Bảng **symbol × A/B/C**: mỗi ô là một chip (LONG xanh, SHORT đỏ, trống thì ô lõm). Cuối hàng là thanh đo đồng thuận 3 ô.
- Panel vị thế đang mở: giá vào, SL, TP và PnL realtime. Một thanh đo cho thấy giá đang nằm ở đâu giữa SL và TP.
- Bảng tin báo gần đây, dùng chip theo loại tin.

## Chuyển động

- Chỉ dùng chuyển động ngắn kiểu "bậc": `steps()` khoảng 80-120ms cho hover và nhấn.
- Ô thanh đo bật sáng lần lượt khi giá trị đổi.
- Tôn trọng `prefers-reduced-motion`.
