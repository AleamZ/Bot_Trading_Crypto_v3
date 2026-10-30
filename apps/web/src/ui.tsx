import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { ConsensusLevel, Direction, LogEntry, Trade } from "./types";

/** The pixel UI kit (docs/UI_DESIGN.md). Styles live in styles.css. */

export type Tone = "quest" | "coin" | "heart" | "sky" | "stone" | "empty";

export function Panel(props: { title: ReactNode; sub?: ReactNode; className?: string; flush?: boolean; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className={`panel ${props.className ?? ""}`}>
      <header className="panel-head">
        <h2 className="panel-title">{props.title}</h2>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {props.sub !== undefined && <span className="panel-sub">{props.sub}</span>}
          {props.actions}
        </div>
      </header>
      <div className={`panel-body${props.flush ? " flush" : ""}`}>{props.children}</div>
    </section>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "quest" | "coin" | "heart" | "sky" | "plain"; small?: boolean; icon?: ReactNode };

export function Button({ tone = "quest", small, icon, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={`btn ${tone === "quest" ? "" : tone} ${small ? "small" : ""} ${className ?? ""}`} {...rest}>
      {icon}
      {children}
    </button>
  );
}

/** Asks for a second click within 4 seconds before doing anything irreversible. */
export function ConfirmButton(props: Omit<ButtonProps, "onClick"> & { confirmLabel: string; onConfirm: () => void | Promise<void> }) {
  const { confirmLabel, onConfirm, children, disabled, ...rest } = props;
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Button
      {...rest}
      tone={armed ? "heart" : rest.tone}
      disabled={disabled || busy}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setArmed(false);
        setBusy(true);
        try {
          await onConfirm();
        } finally {
          setBusy(false);
        }
      }}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}

export function Chip({ tone = "stone", icon, children, title }: { tone?: Tone; icon?: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span className={`chip ${tone}`} title={title}>
      {icon}
      {children}
    </span>
  );
}

export function DirectionChip({ direction, title }: { direction: Direction | null; title?: string }) {
  if (!direction) return <Chip tone="empty">—</Chip>;
  return direction === "LONG" ? (
    <Chip tone="quest" icon={<ArrowUpIcon weight="bold" size={12} />} {...(title ? { title } : {})}>
      LONG
    </Chip>
  ) : (
    <Chip tone="heart" icon={<ArrowDownIcon weight="bold" size={12} />} {...(title ? { title } : {})}>
      SHORT
    </Chip>
  );
}

export function LevelChip({ level }: { level: ConsensusLevel | null }) {
  if (level === "ENTER") return <Chip tone="sky">ENTER</Chip>;
  if (level === "READY") return <Chip tone="coin">READY</Chip>;
  return <Chip tone="empty">CHỜ</Chip>;
}

const STATUS_CHIP: Record<Trade["status"], { tone: Tone; label: string }> = {
  OPENING: { tone: "coin", label: "Đang vào" },
  OPEN: { tone: "sky", label: "Đang mở" },
  CLOSED: { tone: "stone", label: "Đã đóng" },
  FAILED: { tone: "empty", label: "Không vào" },
};

export function TradeStatusChip({ status }: { status: Trade["status"] }) {
  const c = STATUS_CHIP[status];
  return <Chip tone={c.tone}>{c.label}</Chip>;
}

const EXIT_CHIP: Record<NonNullable<Trade["exitReason"]>, { tone: Tone; label: string }> = {
  TP: { tone: "quest", label: "TP hit" },
  SL: { tone: "heart", label: "SL hit" },
  MANUAL: { tone: "stone", label: "Đóng tay" },
  EMERGENCY: { tone: "heart", label: "Đóng khẩn" },
};

/** A stop hit after the bot moved it is a break-even or a locked win, not a loss. */
function exitChipOf(reason: NonNullable<Trade["exitReason"]>, trade?: Pick<Trade, "slMoves">): { tone: Tone; label: string } {
  const stage = trade?.slMoves?.at(-1)?.stage;
  if (reason === "SL" && stage === 1) return { tone: "stone", label: "SL hoà vốn" };
  if (reason === "SL" && stage === 2) return { tone: "quest", label: "SL khoá lãi" };
  return EXIT_CHIP[reason];
}

export function ExitChip({ reason, trade }: { reason: Trade["exitReason"]; trade?: Pick<Trade, "slMoves"> }) {
  if (!reason) return <Chip tone="empty">—</Chip>;
  const c = exitChipOf(reason, trade);
  return <Chip tone={c.tone}>{c.label}</Chip>;
}

/** Chip for an activity-log entry. */
export function eventChip(entry: LogEntry): { tone: Tone; label: string } {
  const data = entry.data as { trade?: Trade; ok?: boolean } | null;
  switch (entry.type) {
    case "SIGNAL_READY":
      return { tone: "coin", label: "Ready" };
    case "SIGNAL_ENTER":
      return { tone: "sky", label: "3/3" };
    case "ENTRY_FILLED":
      return { tone: "quest", label: "Vào lệnh" };
    case "ENTRY_SKIPPED":
      return { tone: "empty", label: "Bỏ qua" };
    case "ENTRY_FAILED": {
      // Refused by the stop-distance rules (see the server's isStopRuleRejection): a skip, not an error.
      const failed = entry.data as { stage?: string; reason?: string } | null;
      return failed?.stage === "PLAN" && failed.reason?.startsWith("STOP_") ? { tone: "empty", label: "Bỏ qua" } : { tone: "heart", label: "Lỗi lệnh" };
    }
    case "TRADE_CLOSED": {
      const reason = data?.trade?.exitReason;
      return reason ? exitChipOf(reason, data?.trade) : { tone: "stone", label: "Đóng" };
    }
    case "PROTECTION_FAILED":
      return { tone: "heart", label: "SL/TP lỗi" };
    case "PROTECTION_REPAIRED":
      return { tone: "coin", label: "Sửa SL/TP" };
    case "STOP_MOVED":
      return { tone: "sky", label: "Dời SL" };
    case "EXCHANGE_STATUS":
      return data?.ok ? { tone: "quest", label: "Binance" } : { tone: "heart", label: "Binance" };
    case "SETTINGS_CHANGED":
      return { tone: "sky", label: "Cài đặt" };
    case "FOREIGN_POSITION":
      return { tone: "stone", label: "Ngoài bot" };
    case "ERROR":
    case "SCAN_FAILED":
      return { tone: "heart", label: "Lỗi" };
    default:
      return { tone: entry.level === "error" ? "heart" : entry.level === "warn" ? "coin" : "stone", label: entry.type.startsWith("BOT_") ? "Bot" : entry.type.split("_")[0]! };
  }
}

/** Segmented HUD meter: `cells` squares, filled in proportion to value / max. */
export function Meter({ label, value, max, cells, tone = "quest", display }: { label: ReactNode; value: number; max: number; cells?: number; tone?: Tone; display?: ReactNode }) {
  const count = Math.max(1, Math.min(24, cells ?? Math.round(max)));
  const filled = max > 0 ? Math.round(Math.min(1, Math.max(0, value / max)) * count) : 0;
  return (
    <div className={`meter ${tone}`} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={typeof label === "string" ? label : undefined}>
      <div className="meter-head">
        <span className="label">{label}</span>
        <span className="num">{display ?? `${value} / ${max}`}</span>
      </div>
      <div className="meter-cells">
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className={`cell${i < filled ? " on" : ""}`} style={{ transitionDelay: `${i * 40}ms` }} />
        ))}
      </div>
    </div>
  );
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: "up" | "down"; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className={`stat-value ${tone ?? ""}`}>{value}</div>
      <div className="label">{label}</div>
      {hint && <div className="soft" style={{ fontSize: 12 }}>{hint}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ items, value, onChange, label }: { items: { id: T; label: ReactNode }[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button key={item.id} type="button" role="tab" className="tab" aria-selected={item.id === value} onClick={() => onChange(item.id)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Notice({ tone = "sky", title, children }: { tone?: "sky" | "coin" | "heart" | "quest"; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === "heart" ? "alert" : "status"}>
      {title && <strong>{title}</strong>}
      {children && <div>{children}</div>}
    </div>
  );
}

const LOGO = ["q.c.", ".s.q", "c.h.", ".q.s"];
const LOGO_COLORS: Record<string, string> = { q: "var(--quest)", c: "var(--coin)", s: "var(--sky)", h: "var(--heart)" };

export function PixelLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 4 4" shapeRendering="crispEdges" aria-hidden="true">
      <rect width="4" height="4" fill="#000" />
      {LOGO.flatMap((row, y) => [...row].map((ch, x) => (ch === "." ? null : <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={LOGO_COLORS[ch]} />)))}
    </svg>
  );
}

export type Mood = "running" | "paused" | "error" | "off";

const MOOD_COLOR: Record<Mood, string> = { running: "var(--quest)", paused: "var(--coin)", error: "var(--heart)", off: "var(--stone)" };

/** 16×16 pixel robot; o = outline, f = face, e = eyes, m = mouth, b = body/antenna in the mood colour. */
const ROBOT = [
  ".......bb.......",
  ".......oo.......",
  "..oooooooooooo..",
  "..offffffffffo..",
  "..offeeffeeffo..",
  "..offeeffeeffo..",
  "..offffffffffo..",
  "..offmmmmmmffo..",
  "..offffffffffo..",
  "..oooooooooooo..",
  ".....oo..oo.....",
  "...oooooooooo...",
  "...obbbbbbbbo...",
  "...obbobbobbo...",
  "...obbbbbbbbo...",
  "...oooooooooo...",
];
const SMILE = ["..offmffffmffo..", "..offfmmmmfffo.."];
const FROWN = ["..offfmmmmfffo..", "..offmffffmffo.."];

export function Mascot({ mood }: { mood: Mood }) {
  const colors: Record<string, string> = { o: "#1c1b19", f: "#fbf6e8", e: mood === "error" ? "#d9413f" : "#1c1b19", m: "#1c1b19", b: MOOD_COLOR[mood] };
  const rows = [...ROBOT];
  const mouth = mood === "running" ? SMILE : mood === "error" ? FROWN : null;
  if (mouth) rows.splice(7, 2, ...mouth);
  return (
    <svg className="mascot" viewBox="0 0 16 16" shapeRendering="crispEdges" role="img" aria-label={MOOD_LABEL[mood]}>
      {rows.flatMap((row, y) => [...row!].map((ch, x) => (ch === "." ? null : <rect key={`${x}-${y}`} x={x} y={y} width="1.02" height="1.02" fill={colors[ch]} />)))}
    </svg>
  );
}

const MOOD_LABEL: Record<Mood, string> = { running: "Bot đang chạy", paused: "Bot đang tạm dừng", error: "Bot đang gặp lỗi", off: "Tự vào lệnh đang tắt" };

interface ToastState {
  id: number;
  tone: "sky" | "coin" | "heart" | "quest";
  text: string;
}

const ToastContext = createContext<(text: string, tone?: ToastState["tone"]) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((text: string, tone: ToastState["tone"] = "sky") => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ id: Date.now(), tone, text });
    timer.current = setTimeout(() => setToast(null), tone === "heart" ? 8000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      {toast && (
        <div className="toast" key={toast.id}>
          <Notice tone={toast.tone}>{toast.text}</Notice>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
