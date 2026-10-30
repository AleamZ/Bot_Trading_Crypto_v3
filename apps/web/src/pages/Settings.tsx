import { ArrowCounterClockwiseIcon, FloppyDiskIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError, errorMessage } from "../api";
import { useLoad, type Live } from "../hooks";
import { changedPaths, diffPatch, errorsByPath, getAt, parseNumber, parseSymbols, sectionsFromSchema, setAt, type FieldDef } from "../schemaForm";
import type { JsonObject } from "../types";
import { Button, Chip, ConfirmButton, Notice, Panel, Tabs, useToast } from "../ui";

export function SettingsPage({ live }: { live: Live }) {
  const toast = useToast();
  const loaded = useLoad(() => api.settings(), []);
  const [draft, setDraft] = useState<JsonObject | null>(null);
  const [tab, setTab] = useState("general");
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [serverErrors, setServerErrors] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);

  const data = loaded.data;
  useEffect(() => {
    if (data) setDraft(data.settings);
  }, [data]);
  const sections = useMemo(() => (data ? sectionsFromSchema(data.schema) : []), [data]);
  const changed = useMemo(() => (data && draft ? changedPaths(data.settings, draft) : []), [data, draft]);

  if (loaded.error) return <Notice tone="heart">{loaded.error}</Notice>;
  if (!data || !draft) return <div className="empty-state">Đang tải…</div>;

  const section = sections.find((s) => s.key === tab) ?? sections[0]!;
  const setValue = (field: FieldDef, value: unknown) => {
    setDraft((d) => setAt(d, field.path, value));
    setServerErrors((m) => {
      if (!m.has(field.key)) return m;
      const next = new Map(m);
      next.delete(field.key);
      return next;
    });
  };
  const setFieldInvalid = (key: string, bad: boolean) =>
    setInvalid((s) => {
      if (s.has(key) === bad) return s;
      const next = new Set(s);
      if (bad) next.add(key);
      else next.delete(key);
      return next;
    });

  async function save() {
    const patch = diffPatch(data!.settings, draft);
    if (!patch) return;
    setSaving(true);
    try {
      const result = await api.saveSettings(patch);
      loaded.setData({ ...data!, settings: result.settings, warnings: result.warnings });
      setServerErrors(new Map());
      toast(`Đã lưu ${changed.length} thay đổi`, "quest");
      void live.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.errors.length) {
        setServerErrors(errorsByPath(e.errors));
        const first = e.errors[0]!.path.split(".")[0];
        if (first && sections.some((s) => s.key === first)) setTab(first);
      }
      toast(errorMessage(e), "heart");
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    try {
      const result = await api.resetSettings();
      loaded.setData({ ...data!, settings: result.settings, warnings: result.warnings });
      setDraft(result.settings);
      setInvalid(new Set());
      setServerErrors(new Map());
      toast("Đã khôi phục cài đặt mặc định", "quest");
      void live.refresh();
    } catch (e) {
      toast(errorMessage(e), "heart");
    }
  }

  const countIn = (key: string) => changed.filter((p) => p.startsWith(`${key}.`)).length;
  const otherErrors = [...serverErrors.entries()].filter(([path]) => !sections.some((s) => s.groups.some((g) => g.fields.some((f) => f.key === path))));

  return (
    <>
      <Notice tone="sky" title="Các cờ an toàn chỉ đổi được trong .env">
        <code>TRADING_ENABLED</code>, khoá API Binance, token Telegram và môi trường DEMO không có ở đây, nên trang này không bật được giao dịch thật.
      </Notice>
      {live.status?.riskCheck?.message && (
        <Notice tone={live.status.riskCheck.level === "none" ? "heart" : "coin"} title="1R so với số dư (cập nhật sau khi lưu)">
          {live.status.riskCheck.message}
        </Notice>
      )}
      {data.warnings.length > 0 && (
        <Notice tone="coin" title="Cảnh báo">
          <ul>
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
      <Tabs
        label="Nhóm cài đặt"
        value={section.key}
        onChange={setTab}
        items={sections.map((s) => ({
          id: s.key,
          label: (
            <>
              {s.title}
              {countIn(s.key) > 0 && <span className="count">{countIn(s.key)}</span>}
            </>
          ),
        }))}
      />
      {section.groups.map((group) => (
        <Panel key={group.key} title={group.title} sub={`${group.fields.length} mục`}>
          <div className="fields">
            {group.fields.map((field) => (
              <Field
                key={field.key}
                field={field}
                value={getAt(draft, field.path)}
                saved={getAt(data.settings, field.path)}
                defaultValue={getAt(data.defaults, field.path)}
                error={serverErrors.get(field.key) ?? null}
                onChange={(value) => setValue(field, value)}
                onValidity={(bad) => setFieldInvalid(field.key, bad)}
              />
            ))}
          </div>
        </Panel>
      ))}
      {otherErrors.length > 0 && (
        <Notice tone="heart" title="Cài đặt không hợp lệ">
          <ul>
            {otherErrors.map(([path, message]) => (
              <li key={path}>
                {path || "cài đặt"}: {message}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <div className="panel" style={{ position: "sticky", bottom: 12, zIndex: 5 }}>
        <div className="panel-body row between">
          <span className="soft">{changed.length ? `${changed.length} thay đổi chưa lưu: ${changed.slice(0, 4).join(", ")}${changed.length > 4 ? "…" : ""}` : "Không có thay đổi"}</span>
          <div className="row">
            <ConfirmButton tone="plain" small confirmLabel="Bấm lần nữa để khôi phục" icon={<ArrowCounterClockwiseIcon size={12} weight="bold" />} onConfirm={reset}>
              Mặc định
            </ConfirmButton>
            <Button tone="plain" disabled={!changed.length || saving} onClick={() => setDraft(data.settings)}>
              Huỷ
            </Button>
            <Button disabled={!changed.length || invalid.size > 0 || saving} onClick={save} icon={<FloppyDiskIcon size={14} weight="bold" />}>
              {saving ? "Đang lưu…" : invalid.size ? "Sửa ô lỗi trước" : "Lưu"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

interface FieldProps {
  field: FieldDef;
  value: unknown;
  saved: unknown;
  defaultValue: unknown;
  error: string | null;
  onChange: (value: unknown) => void;
  onValidity: (invalid: boolean) => void;
}

function Field(props: FieldProps) {
  const { field, value, saved, defaultValue, error } = props;
  const changed = JSON.stringify(value) !== JSON.stringify(saved);
  const id = `f-${field.key}`;
  const defaultText = Array.isArray(defaultValue) ? defaultValue.join(", ") : typeof defaultValue === "boolean" ? (defaultValue ? "bật" : "tắt") : String(defaultValue);

  if (field.kind === "boolean") {
    return (
      <div className={`field${changed ? " changed" : ""}`}>
        <label className="check-row" htmlFor={id}>
          <input id={id} type="checkbox" className="check" checked={Boolean(value)} onChange={(e) => props.onChange(e.target.checked)} />
          <span>
            <span className="field-title">{field.title}</span>
            {field.description && <span className="field-desc"> · {field.description}</span>}
          </span>
        </label>
        {error && <span className="field-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className={`field${changed ? " changed" : ""}`}>
      <div className="field-head">
        <label className="field-title" htmlFor={id}>
          {field.title}
        </label>
        <span className="soft" style={{ fontSize: 11 }} title="Giá trị mặc định">
          mặc định {defaultText}
        </span>
      </div>
      {field.kind === "enum" ? (
        <select id={id} className="select" value={String(value)} onChange={(e) => props.onChange(e.target.value)}>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : field.kind === "symbols" ? (
        <SymbolsInput id={id} value={Array.isArray(value) ? (value as string[]) : []} onChange={props.onChange} />
      ) : field.kind === "number" || field.kind === "integer" ? (
        <NumberInput id={id} field={field} value={typeof value === "number" ? value : null} onChange={props.onChange} onValidity={props.onValidity} serverError={error} />
      ) : (
        <input id={id} className="input" value={String(value ?? "")} onChange={(e) => props.onChange(e.target.value)} />
      )}
      {field.description && <span className="field-desc">{field.description}</span>}
      {error && field.kind !== "number" && field.kind !== "integer" && <span className="field-error">{error}</span>}
    </div>
  );
}

function NumberInput(props: { id: string; field: FieldDef; value: number | null; onChange: (v: number) => void; onValidity: (invalid: boolean) => void; serverError: string | null }) {
  const { field } = props;
  const [text, setText] = useState(props.value === null ? "" : String(props.value));
  const [error, setError] = useState<string | null>(null);
  // Follow outside changes (cancel, reset) without fighting what is being typed.
  useEffect(() => {
    const parsed = parseNumber(text, field);
    if (props.value !== null && (!parsed.ok || parsed.value !== props.value)) {
      setText(String(props.value));
      setError(null);
      props.onValidity(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  // Leaving the tab drops a half-typed value (the draft keeps the last valid one), so it no longer blocks saving.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => props.onValidity(false), []);

  const shown = error ?? props.serverError;
  const range = [field.min !== null ? `≥ ${field.min}` : null, field.max !== null ? `≤ ${field.max}` : null].filter(Boolean).join(", ");
  const input = (
    <input
      id={props.id}
      className="input num"
      inputMode="decimal"
      value={text}
      aria-invalid={shown ? true : undefined}
      onChange={(e) => {
        setText(e.target.value);
        const parsed = parseNumber(e.target.value, field);
        if (parsed.ok) {
          setError(null);
          props.onValidity(false);
          props.onChange(parsed.value);
        } else {
          setError(parsed.error);
          props.onValidity(true);
        }
      }}
    />
  );
  return (
    <>
      {field.unit ? (
        <div className="input-unit">
          {input}
          <span className="unit">{field.unit}</span>
        </div>
      ) : (
        input
      )}
      {shown ? <span className="field-error">{shown}</span> : range && <span className="soft" style={{ fontSize: 11 }}>{range}</span>}
    </>
  );
}

function SymbolsInput({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => {
    if (parseSymbols(text).join(",") !== value.join(",")) setText(value.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const bad = value.filter((s) => !/^[A-Z0-9]{2,20}USDT$/.test(s));
  return (
    <>
      <textarea
        id={id}
        className="input"
        rows={2}
        value={text}
        aria-invalid={bad.length ? true : undefined}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseSymbols(e.target.value));
        }}
      />
      <div className="row" style={{ gap: 6 }}>
        {value.map((s) => (
          <Chip key={s} tone={bad.includes(s) ? "heart" : "sky"}>
            {s}
          </Chip>
        ))}
      </div>
      {bad.length > 0 && <span className="field-error">Symbol phải có dạng XXXUSDT: {bad.join(", ")}</span>}
    </>
  );
}
