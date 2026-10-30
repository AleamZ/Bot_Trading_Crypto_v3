import {
  ChartLineUpIcon,
  CircleHalfIcon,
  GaugeIcon,
  GearSixIcon,
  ListBulletsIcon,
  MoonIcon,
  ReceiptIcon,
  SignOutIcon,
  SunIcon,
  TelegramLogoIcon,
} from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { api, UNAUTHORIZED_EVENT } from "./api";
import { useHashRoute, useLive, useTheme, type Live, type Route } from "./hooks";
import { Activity } from "./pages/Activity";
import { Dashboard } from "./pages/Dashboard";
import { Login } from "./pages/Login";
import { SettingsPage } from "./pages/Settings";
import { TelegramPage } from "./pages/Telegram";
import { Trades } from "./pages/Trades";
import type { Me, Status } from "./types";
import { Button, PixelLogo, ToastProvider } from "./ui";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.me().then(setMe, () => setFailed(true));
    const onUnauthorized = () => setMe((current) => (current ? { ...current, authenticated: false, username: null } : current));
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (failed) {
    return (
      <div className="login">
        <div className="notice heart">Không kết nối được tới bot. Kiểm tra bot có đang chạy không rồi tải lại trang.</div>
      </div>
    );
  }
  if (!me) return null;
  return <ToastProvider>{me.authenticated ? <Shell me={me} onLogout={() => setMe({ ...me, authenticated: false, username: null })} /> : <Login me={me} onLogin={setMe} />}</ToastProvider>;
}

// The chart library is big: load the analysis page only when it is opened.
const Analysis = lazy(() => import("./pages/Analysis").then((m) => ({ default: m.Analysis })));

const NAV: { id: Route; label: string; icon: ReactNode }[] = [
  { id: "dashboard", label: "Bảng điều khiển", icon: <GaugeIcon size={16} weight="bold" /> },
  { id: "analysis", label: "Phân tích", icon: <ChartLineUpIcon size={16} weight="bold" /> },
  { id: "trades", label: "Lệnh", icon: <ReceiptIcon size={16} weight="bold" /> },
  { id: "activity", label: "Nhật ký", icon: <ListBulletsIcon size={16} weight="bold" /> },
  { id: "settings", label: "Cài đặt", icon: <GearSixIcon size={16} weight="bold" /> },
  { id: "telegram", label: "Telegram", icon: <TelegramLogoIcon size={16} weight="bold" /> },
];

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const live = useLive();
  const [route, go, param] = useHashRoute();
  const [theme, nextTheme] = useTheme();

  useEffect(() => {
    const page = NAV.find((n) => n.id === route)?.label ?? "";
    document.title = `${page} · Bot V3`;
  }, [route]);

  return (
    <>
      <TopBar status={live.status} connected={live.connected} />
      <nav className="nav" aria-label="Trang">
        {NAV.map((item) => (
          <a key={item.id} className="nav-item" href={`#/${item.id}`} aria-current={item.id === route ? "page" : undefined}>
            <span className="icon-cell">{item.icon}</span>
            {item.label}
          </a>
        ))}
        <span className="nav-spacer" />
        <Button tone="plain" small onClick={nextTheme} icon={theme === "dark" ? <MoonIcon size={14} /> : theme === "light" ? <SunIcon size={14} /> : <CircleHalfIcon size={14} />} title="Đổi giao diện sáng / tối">
          {theme === "auto" ? "Tự động" : theme === "dark" ? "Tối" : "Sáng"}
        </Button>
        <Button
          tone="plain"
          small
          icon={<SignOutIcon size={14} />}
          onClick={async () => {
            await api.logout().catch(() => undefined);
            onLogout();
          }}
        >
          {me.username ?? "Thoát"}
        </Button>
      </nav>
      <main className="page">
        <Page route={route} live={live} go={go} param={param} />
      </main>
    </>
  );
}

function Page({ route, live, go, param }: { route: Route; live: Live; go: (r: Route, param?: string) => void; param: string | null }) {
  switch (route) {
    case "analysis":
      return (
        <Suspense fallback={<div className="empty-state">Đang tải trang phân tích…</div>}>
          <Analysis live={live} symbol={param} go={go} />
        </Suspense>
      );
    case "trades":
      return <Trades live={live} />;
    case "activity":
      return <Activity live={live} />;
    case "settings":
      return <SettingsPage live={live} />;
    case "telegram":
      return <TelegramPage live={live} go={go} />;
    default:
      return <Dashboard live={live} go={go} />;
  }
}

function TopBar({ status, connected }: { status: Status | null; connected: boolean }) {
  const auto = status?.autoTradeAllowed && !status.paused;
  const telegram = status?.telegram;
  const telegramOk = telegram?.configured && telegram.chatIdSet && !telegram.lastError;
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <PixelLogo />
          BOT V3
        </div>
        <div className="tagline">
          Binance USDT-M · 3 phương pháp · 2/3 báo, 3/3 vào lệnh
          {status && ` · 1R = ${status.limits.riskUsd}$ · RR ${status.limits.rr}`}
        </div>
        <div className="bar-chips">
          <span className="bar-chip">
            <span className="dot" style={{ ["--c" as string]: "var(--sky)" }} />
            {status?.binanceEnv ?? "…"}
          </span>
          <span className="bar-chip" title={status?.autoTradeBlockers.join("\n") || (status?.paused ? "Đang tạm dừng" : "Tự vào lệnh khi 3/3")}>
            <span className="dot" style={{ ["--c" as string]: auto ? "var(--quest)" : status?.paused ? "var(--coin)" : "var(--heart)" }} />
            Auto {auto ? "on" : status?.paused ? "pause" : "off"}
          </span>
          <span className="bar-chip" title={telegram?.configured ? (telegram.lastError ?? "Telegram hoạt động") : "Chưa cài Telegram"}>
            <span className="dot" style={{ ["--c" as string]: telegramOk ? "var(--quest)" : telegram?.configured ? "var(--coin)" : "var(--stone)" }} />
            Telegram {telegramOk ? "ok" : telegram?.configured ? "!" : "off"}
          </span>
          <span className="bar-chip" title={connected ? "Đang nhận cập nhật trực tiếp" : "Mất kết nối trực tiếp, đang thử lại"}>
            <span className="dot" style={{ ["--c" as string]: connected ? "var(--quest)" : "var(--heart)" }} />
            {connected ? "Live" : "Offline"}
          </span>
        </div>
      </div>
    </header>
  );
}
