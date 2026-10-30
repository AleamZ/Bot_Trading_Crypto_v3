import { dateTime } from "./format";
import type { LogEntry } from "./types";
import { Chip, eventChip } from "./ui";

/** Activity-log entries with a chip per type. */
export function Feed({ entries, empty = "Chưa có gì." }: { entries: LogEntry[]; empty?: string }) {
  if (entries.length === 0) return <div className="empty-state">{empty}</div>;
  return (
    <ul className="feed">
      {entries.map((entry) => {
        const chip = eventChip(entry);
        return (
          <li key={entry.id}>
            <Chip tone={chip.tone}>{chip.label}</Chip>
            <span className="what">
              {entry.title} <span className="when">· {dateTime(entry.time)}</span>
            </span>
            {entry.message && <span className="msg">{entry.message}</span>}
          </li>
        );
      })}
    </ul>
  );
}
