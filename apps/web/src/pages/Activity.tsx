import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { ALL_DATES, DateFilter, inRange, rangeBounds, type DateRange } from "../DateFilter";
import type { Live } from "../hooks";
import { Feed } from "../parts";
import type { LogEntry, LogLevel } from "../types";
import { Button, Notice, Panel, Tabs } from "../ui";

const FILTERS: { id: string; label: string; levels: LogLevel[] }[] = [
  { id: "all", label: "Tất cả", levels: [] },
  { id: "warn", label: "Cảnh báo + lỗi", levels: ["warn", "error"] },
  { id: "error", label: "Chỉ lỗi", levels: ["error"] },
];

export function Activity({ live }: { live: Live }) {
  const [filter, setFilter] = useState("all");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dates, setDates] = useState<DateRange>(ALL_DATES);
  const levels = FILTERS.find((f) => f.id === filter)!.levels;

  async function load(before?: number) {
    setBusy(true);
    try {
      const page = await api.events({ limit: 100, level: levels.join(","), ...rangeBounds(dates), ...(before ? { before } : {}) });
      setEntries((current) => (before ? [...current, ...page.items] : page.items));
      setMore(page.items.length === 100);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, dates.from, dates.to]);

  // New entries from the live stream go on top.
  useEffect(() => {
    const fresh = live.logs.filter((e) => (levels.length === 0 || levels.includes(e.level)) && inRange(dates, e.time) && !entries.some((x) => x.id === e.id) && e.id > (entries[0]?.id ?? 0));
    if (fresh.length) setEntries((current) => [...fresh, ...current]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.lastLogId]);

  return (
    <>
      <Tabs label="Lọc nhật ký" value={filter} onChange={setFilter} items={FILTERS.map((f) => ({ id: f.id, label: f.label }))} />
      <DateFilter value={dates} onChange={setDates} />
      {error && <Notice tone="heart">{error}</Notice>}
      <Panel title="Nhật ký hoạt động" sub="giữ 60 ngày · giờ Việt Nam" flush>
        <Feed entries={entries} empty={busy ? "Đang tải…" : "Chưa có gì."} />
      </Panel>
      {more && entries.length > 0 && (
        <div>
          <Button tone="plain" disabled={busy} onClick={() => load(entries.at(-1)!.id)}>
            {busy ? "Đang tải…" : "Tải thêm"}
          </Button>
        </div>
      )}
    </>
  );
}
