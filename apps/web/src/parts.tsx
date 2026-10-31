import { clock, dateTime } from "./format";
import type { LogEntry } from "./types";
import { Chip, eventChip } from "./ui";

/** Runs of the same event (same type, title and message), newest first, kept once with how many and since when. */
export function collapseRepeats(entries: LogEntry[]): { entry: LogEntry; count: number; since: number }[] {
  const out: { entry: LogEntry; count: number; since: number }[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    if (last && last.entry.type === entry.type && last.entry.title === entry.title && last.entry.message === entry.message) {
      last.count++;
      last.since = entry.time;
    } else out.push({ entry, count: 1, since: entry.time });
  }
  return out;
}

/** "30/10 15:48 → 20:22", with the day on both ends when it changed. */
function span(from: number, to: number): string {
  const start = dateTime(from);
  const end = dateTime(to);
  return `${start} → ${start.slice(0, 5) === end.slice(0, 5) ? clock(to) : end}`;
}

/** Activity-log entries with a chip per type. `collapse` folds repeats in a row into one line, up to `limit` lines. */
export function Feed({ entries, empty = "Chưa có gì.", collapse, limit }: { entries: LogEntry[]; empty?: string; collapse?: boolean; limit?: number }) {
  const items = (collapse ? collapseRepeats(entries) : entries.map((entry) => ({ entry, count: 1, since: entry.time }))).slice(0, limit);
  if (items.length === 0) return <div className="empty-state">{empty}</div>;
  return (
    <ul className="feed">
      {items.map(({ entry, count, since }) => {
        const chip = eventChip(entry);
        return (
          <li key={entry.id}>
            <Chip tone={chip.tone}>{chip.label}</Chip>
            <span className="what">
              {entry.title}
              {count > 1 && <span className="repeat"> ×{count}</span>} <span className="when">· {count > 1 ? span(since, entry.time) : dateTime(entry.time)}</span>
            </span>
            {entry.message && <span className="msg">{entry.message}</span>}
          </li>
        );
      })}
    </ul>
  );
}
