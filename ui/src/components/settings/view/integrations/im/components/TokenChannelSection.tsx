import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../../../shared/view/ui";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Info,
  Loader2,
  Radio,
  XCircle,
} from "../icons";
import { authenticatedFetch } from "../../../../../../utils/api";
import { showSettingsSuccess } from "../../../../shared/SettingsSuccessToast";
import { cn } from "../../../../../../lib/utils";
import type { ChannelRuntime, TestResult } from "../types";

export type TokenChannelField = {
  /** Request body key sent to /api/gateway/:channel/{test,save}. */
  name: string;
  label: string;
  placeholder: string;
  hint?: string;
  /** A value is already stored server-side, so the field may stay blank. */
  configured: boolean;
};

type TokenChannelSectionProps = {
  channel: "slack" | "telegram";
  icon: ReactNode;
  enabled: boolean;
  /** Masked token shown when no runtime account name is known yet. */
  accountHint: string;
  runtime?: ChannelRuntime | null;
  fields: TokenChannelField[];
  onSaved: () => void;
};

const inputClassName =
  "h-9 w-full rounded-lg border border-border bg-muted px-3 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-ring focus:ring-1 focus:ring-ring";

/**
 * Settings section for channels configured purely with tokens (Slack,
 * Telegram): paste tokens, verify them against the platform, save.
 */
export default function TokenChannelSection({
  channel,
  icon,
  enabled,
  accountHint,
  runtime,
  fields,
  onSaved,
}: TokenChannelSectionProps) {
  const { t } = useTranslation("settings");
  const [expanded, setExpanded] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TestResult>(null);

  const ready = fields.every((field) => field.configured || (values[field.name] ?? "").trim());
  const failed = enabled && runtime?.state === "failed";
  const connected = enabled && runtime?.state === "connected";

  const summary = !enabled
    ? t(`gateway.${channel}.summary`)
    : failed
      ? `${t("gateway.connectionFailed")}${runtime?.error ? ` · ${runtime.error}` : ""}`
      : connected
        ? `${t("gateway.connected")} · ${runtime?.accountId || accountHint}`
        : t("gateway.connecting");

  const post = async (action: "test" | "save" | "disable") => {
    const res = await authenticatedFetch(`/api/gateway/${channel}/${action}`, {
      method: "POST",
      ...(action === "disable" ? {} : { body: JSON.stringify(values) }),
    });
    return res.json().catch(() => ({ ok: res.ok }));
  };

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await post("test"));
    } catch (err: any) {
      setResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setResult(null);
    try {
      const data = await post("save");
      if (data.ok) {
        showSettingsSuccess(t(`gateway.${channel}.saveSuccess`));
        setValues({});
        setExpanded(false);
        onSaved();
      } else {
        setResult({ ok: false, error: data.error || "Failed" });
      }
    } catch (err: any) {
      setResult({ ok: false, error: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleDisable = async () => {
    try {
      const data = await post("disable");
      if (!data.ok) return;
      showSettingsSuccess();
      onSaved();
    } catch {
      // ignore
    }
  };

  return (
    <section className={`integration-channel${expanded ? " expanded" : ""}`}>
      <button
        className="integration-channel-summary"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`integration-platform-icon ${channel}`}>{icon}</span>
        <span className="integration-channel-copy">
          <strong>{t(`gateway.${channel}.title`)}</strong>
          <small className={cn(failed && "text-red-600 dark:text-red-400")}>{summary}</small>
        </span>
        <span className={`integration-status${enabled ? " enabled" : ""}`}>
          {enabled ? <i /> : null}
          {enabled ? t("gateway.enabled") : t("gateway.notConfigured")}
        </span>
        <span className="integration-channel-toggle">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>

      {expanded ? (
        <div className="integration-channel-detail">
          <div className="space-y-3 border-t border-border pt-4">
            <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="whitespace-pre-line">{t(`gateway.${channel}.guide`)}</span>
            </div>

            {fields.map((field) => (
              <label key={field.name} className="block space-y-1">
                <span className="text-xs font-medium text-muted-foreground">{field.label}</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={values[field.name] ?? ""}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [field.name]: event.target.value.trim() }))
                  }
                  placeholder={field.configured ? t("gateway.keepSavedToken") : field.placeholder}
                  className={inputClassName}
                />
                {field.hint ? (
                  <span className="block text-[11px] leading-4 text-muted-foreground">{field.hint}</span>
                ) : null}
              </label>
            ))}

            {result && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-lg px-3 py-2 text-xs",
                  result.ok
                    ? "bg-green-500/10 text-green-700 dark:text-green-400"
                    : "bg-red-500/10 text-red-700 dark:text-red-400",
                )}
              >
                {result.ok ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                <span>
                  {result.ok
                    ? `${t("gateway.verified")}${result.message ? ` · ${result.message}` : ""}`
                    : result.error}
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={handleTest} disabled={!ready || testing}>
                {testing ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : (
                  <Radio className="mr-1.5 h-3 w-3" />
                )}
                {t("gateway.testConnection")}
              </Button>
              <Button size="sm" onClick={handleSave} disabled={!ready || saving}>
                {saving ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : (
                  <Check className="mr-1.5 h-3 w-3" />
                )}
                {t("gateway.save")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
                {t("gateway.cancel")}
              </Button>
              {enabled ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-red-500 hover:text-red-600"
                  onClick={handleDisable}
                >
                  {t("gateway.disable")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
