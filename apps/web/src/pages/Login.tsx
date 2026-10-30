import { SignInIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { api, ApiError } from "../api";
import type { Me } from "../types";
import { Button, Mascot, Notice, Panel, PixelLogo } from "../ui";

export function Login({ me, onLogin }: { me: Me; onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login(username, password));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không đăng nhập được");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <Panel
        title={
          <span className="row">
            <PixelLogo size={20} /> Bot V3
          </span>
        }
        sub="Đăng nhập"
        flush
      >
        <div className="stripes">
          <Mascot mood={me.passwordConfigured ? "running" : "off"} />
        </div>
        <div className="panel-body">
          {me.passwordConfigured ? (
            <form className="form" onSubmit={submit}>
              <label className="field">
                <span className="label">Tên đăng nhập</span>
                <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">Mật khẩu</span>
                <input className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              {error && <Notice tone="heart">{error}</Notice>}
              <Button type="submit" disabled={busy || !password} icon={<SignInIcon size={16} weight="bold" />}>
                {busy ? "Đang kiểm tra…" : "Vào"}
              </Button>
            </form>
          ) : (
            <Notice tone="coin" title="Chưa đặt mật khẩu">
              Chạy <code>npm run hash-password</code> trong thư mục bot, dán hai dòng nó in ra vào <code>.env</code>, rồi khởi động lại bot.
            </Notice>
          )}
        </div>
      </Panel>
    </div>
  );
}
