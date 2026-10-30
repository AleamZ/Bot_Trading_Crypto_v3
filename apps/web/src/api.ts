import type { JsonObject, LogEntry, Me, PositionsResponse, ScanReport, SettingsResponse, Status, TelegramInfo, Trade } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Fired when a request comes back 401, so the app can show the login screen. */
export const UNAUTHORIZED_EVENT = "bot:unauthorized";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Không kết nối được tới bot");
  }
  const data = (await response.json().catch(() => null)) as { error?: string; message?: string; errors?: { path: string; message: string }[] } | null;
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/auth/login") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(response.status, data?.error ?? `HTTP_${response.status}`, data?.message ?? `Lỗi ${response.status}`, data?.errors ?? []);
  }
  return data as T;
}

const query = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") q.set(key, String(value));
  const text = q.toString();
  return text ? `?${text}` : "";
};

export const api = {
  me: () => request<Me>("GET", "/api/auth/me"),
  login: (username: string, password: string) => request<Me>("POST", "/api/auth/login", { username, password }),
  logout: () => request<Me>("POST", "/api/auth/logout"),
  status: () => request<Status>("GET", "/api/status"),
  scan: () => request<ScanReport>("POST", "/api/scan"),
  pause: () => request<{ paused: boolean }>("POST", "/api/bot/pause"),
  resume: () => request<{ paused: boolean }>("POST", "/api/bot/resume"),
  settings: () => request<SettingsResponse>("GET", "/api/settings"),
  saveSettings: (patch: JsonObject) => request<{ settings: JsonObject; warnings: string[] }>("PUT", "/api/settings", patch),
  resetSettings: () => request<{ settings: JsonObject; warnings: string[] }>("POST", "/api/settings/reset"),
  trades: (params: { status?: string; symbol?: string; limit?: number; offset?: number } = {}) =>
    request<{ trades: Trade[]; total: number }>("GET", `/api/trades${query(params)}`),
  closeTrade: (id: string) => request<Trade>("POST", `/api/trades/${encodeURIComponent(id)}/close`),
  positions: () => request<PositionsResponse>("GET", "/api/positions"),
  events: (params: { before?: number; limit?: number; level?: string; symbol?: string } = {}) =>
    request<{ items: LogEntry[] }>("GET", `/api/events${query(params)}`),
  telegram: () => request<TelegramInfo>("GET", "/api/telegram"),
  telegramTest: () => request<{ sent: boolean }>("POST", "/api/telegram/test"),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
