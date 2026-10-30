export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** One JSON object per line on stdout/stderr, which pm2 keeps in its log files. */
export function createLogger(level: LogLevel = "info", component = "bot"): Logger {
  const write = (lvl: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: lvl, component, message, ...fields }, errorReplacer);
    if (lvl === "error" || lvl === "warn") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, ...(value as unknown as Record<string, unknown>) };
  return value;
}
