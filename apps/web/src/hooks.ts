import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { AnalysisView, LogEntry, Status } from "./types";

export type Route = "dashboard" | "analysis" | "reviews" | "trades" | "stats" | "activity" | "settings" | "telegram";
const ROUTES: Route[] = ["dashboard", "analysis", "reviews", "trades", "stats", "activity", "settings", "telegram"];

/** "#/analysis/BTCUSDT" → { route: "analysis", param: "BTCUSDT" }. */
function readHash(): { route: Route; param: string | null } {
  const [name = "", param] = window.location.hash.replace(/^#\/?/, "").split("?")[0]!.split("/");
  return { route: ROUTES.includes(name as Route) ? (name as Route) : "dashboard", param: param ? decodeURIComponent(param) : null };
}

/** Routing by #hash, so the server only ever serves index.html. */
export function useHashRoute(): [Route, (route: Route, param?: string) => void, string | null] {
  const [state, setState] = useState(readHash);
  useEffect(() => {
    const onChange = () => setState(readHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return [state.route, (next, param) => (window.location.hash = `/${next}${param ? `/${encodeURIComponent(param)}` : ""}`), state.param];
}

export type ThemeChoice = "auto" | "light" | "dark";
const THEME_KEY = "bot3.theme";

function readTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "auto";
  } catch {
    return "auto";
  }
}

/** Light/dark follows the system unless the viewer picks one (remembered in this browser only). */
export function useTheme(): [ThemeChoice, () => void] {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      if (theme === "auto") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // storage blocked: the choice lasts until reload
    }
  }, [theme]);
  const next = () => setTheme((t) => (t === "auto" ? "dark" : t === "dark" ? "light" : "auto"));
  return [theme, next];
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export interface Live {
  status: Status | null;
  analysis: AnalysisView[];
  logs: LogEntry[];
  connected: boolean;
  /** Changes every time a new log entry arrives; pages refetch on it. */
  lastLogId: number;
  refresh: () => Promise<void>;
}

const MAX_LOGS = 200;

/**
 * Status, analysis and the activity log, kept current by the SSE stream. The browser reconnects
 * on its own and sends Last-Event-ID, so the server replays entries missed meanwhile.
 */
export function useLive(): Live {
  const [status, setStatus] = useState<Status | null>(null);
  const [analysis, setAnalysis] = useState<Map<string, AnalysisView>>(new Map());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);

  const applyStatus = useCallback((next: Status) => {
    setStatus(next);
    setAnalysis(new Map(next.analysis.map((a) => [a.symbol, a])));
  }, []);

  const addLogs = useCallback((entries: LogEntry[]) => {
    setLogs((current) => {
      const seen = new Set(current.map((e) => e.id));
      const fresh = entries.filter((e) => e.id > 0 && !seen.has(e.id));
      if (fresh.length === 0) return current;
      return [...fresh, ...current].sort((a, b) => b.id - a.id).slice(0, MAX_LOGS);
    });
  }, []);

  const refresh = useCallback(async () => {
    const [s, events] = await Promise.all([api.status(), api.events({ limit: 60 })]);
    applyStatus(s);
    addLogs(events.items);
  }, [applyStatus, addLogs]);

  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    const open = () => {
      source = new EventSource("/api/events/stream");
      source.onopen = () => setConnected(true);
      source.onerror = () => {
        setConnected(false);
        if (source?.readyState === EventSource.CLOSED && !closed) {
          // A 401 or a server restart closes the stream for good: check the session, then reopen.
          retry.current = setTimeout(() => {
            api.me().then((me) => me.authenticated && !closed && open(), () => undefined);
          }, 5000);
        }
      };
      source.addEventListener("status", (e) => applyStatus(JSON.parse((e as MessageEvent).data) as Status));
      source.addEventListener("analysis", (e) => {
        const view = JSON.parse((e as MessageEvent).data) as AnalysisView;
        setAnalysis((current) => new Map(current).set(view.symbol, view));
      });
      source.addEventListener("log", (e) => addLogs([JSON.parse((e as MessageEvent).data) as LogEntry]));
    };
    refresh().catch(() => undefined);
    open();
    return () => {
      closed = true;
      if (retry.current) clearTimeout(retry.current);
      source?.close();
    };
  }, [applyStatus, addLogs, refresh]);

  const order = status?.analysis.map((a) => a.symbol) ?? [];
  const list = [...analysis.values()].sort((a, b) => order.indexOf(a.symbol) - order.indexOf(b.symbol));
  return { status, analysis: list, logs, connected, lastLogId: logs[0]?.id ?? 0, refresh };
}

/** Runs `load` now, whenever `deps` change, and every `intervalMs` if given. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    if (!intervalMs) return;
    const timer = setInterval(() => void reload(), intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs]);

  return { data, error, loading, reload, setData };
}
