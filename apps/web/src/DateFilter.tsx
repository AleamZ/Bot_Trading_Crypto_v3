import { Button } from "./ui";

/** A range of Vietnam days, "YYYY-MM-DD"; an empty side is open. */
export interface DateRange {
  from: string;
  to: string;
}

export const ALL_DATES: DateRange = { from: "", to: "" };

const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const vnDay = (time: number) => new Date(time + VN_OFFSET_MS).toISOString().slice(0, 10);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) - VN_OFFSET_MS;

/** The range as API bounds in ms; `to` is exclusive, the end of the last day. */
export function rangeBounds(range: DateRange): { from?: number; to?: number } {
  return { ...(range.from ? { from: dayStart(range.from) } : {}), ...(range.to ? { to: dayStart(range.to) + DAY_MS } : {}) };
}

/** Whether a time falls inside the range (for entries that arrive live). */
export function inRange(range: DateRange, time: number): boolean {
  const { from, to } = rangeBounds(range);
  return (from === undefined || time >= from) && (to === undefined || time < to);
}

function presets(now: number): { label: string; range: DateRange }[] {
  const today = vnDay(now);
  return [
    { label: "Hôm nay", range: { from: today, to: today } },
    { label: "7 ngày", range: { from: vnDay(now - 6 * DAY_MS), to: today } },
    { label: "Tháng này", range: { from: `${today.slice(0, 7)}-01`, to: today } },
    { label: "Tất cả", range: ALL_DATES },
  ];
}

/** From / to date inputs (Vietnam days) with quick ranges. */
export function DateFilter({ value, onChange }: { value: DateRange; onChange: (range: DateRange) => void }) {
  return (
    <div className="date-filter">
      <label className="date-field">
        <span className="label">Từ ngày</span>
        <input type="date" className="input" value={value.from} max={value.to || undefined} onChange={(e) => onChange({ ...value, from: e.target.value })} />
      </label>
      <label className="date-field">
        <span className="label">Đến ngày</span>
        <input type="date" className="input" value={value.to} min={value.from || undefined} onChange={(e) => onChange({ ...value, to: e.target.value })} />
      </label>
      <div className="row">
        {presets(Date.now()).map((p) => {
          const active = p.range.from === value.from && p.range.to === value.to;
          return (
            <Button key={p.label} tone={active ? "sky" : "plain"} small aria-pressed={active} onClick={() => onChange(p.range)}>
              {p.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
