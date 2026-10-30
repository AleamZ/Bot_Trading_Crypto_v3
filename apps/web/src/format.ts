/** Display helpers. Times are shown in Vietnam time whatever the browser's zone. */

const VN_OFFSET_MS = 7 * 3_600_000;
const pad = (n: number) => String(n).padStart(2, "0");

function vnParts(time: number) {
  const d = new Date(time + VN_OFFSET_MS);
  return { day: pad(d.getUTCDate()), month: pad(d.getUTCMonth() + 1), year: d.getUTCFullYear(), hh: pad(d.getUTCHours()), mm: pad(d.getUTCMinutes()), ss: pad(d.getUTCSeconds()) };
}

/** "14:15" */
export function clock(time: number | null | undefined): string {
  if (!time) return "—";
  const p = vnParts(time);
  return `${p.hh}:${p.mm}`;
}

/** "30/10 14:15" */
export function dateTime(time: number | null | undefined): string {
  if (!time) return "—";
  const p = vnParts(time);
  return `${p.day}/${p.month} ${p.hh}:${p.mm}`;
}

/** "30/10/2026 14:15:07" */
export function fullDateTime(time: number | null | undefined): string {
  if (!time) return "—";
  const p = vnParts(time);
  return `${p.day}/${p.month}/${p.year} ${p.hh}:${p.mm}:${p.ss}`;
}

/** "3 phút", "45 giây", "2 giờ 5 phút" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} giờ ${m % 60} phút` : `${h} giờ`;
}

/** Signed value with a real minus sign: "+1.80", "−5.00". */
export function signed(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(digits)}`;
}

export const rMultiple = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${signed(value)}R`);
export const usd = (value: number | string | null | undefined, digits = 2) => (value === null || value === undefined || value === "" ? "—" : `${signed(Number(value), digits)}$`);
export const money = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}$`;

/** Prices to 8 significant digits, with thousands separators: "78,080.5", "0.1470". */
export function price(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const precise = Number(n.toPrecision(8));
  const [int, frac] = String(precise).split(".");
  return `${Number(int).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/** Where `value` sits between `from` (0) and `to` (1), clamped. */
export function progress(value: number, from: number, to: number): number {
  if (!Number.isFinite(value) || from === to) return 0;
  return Math.min(1, Math.max(0, (value - from) / (to - from)));
}
