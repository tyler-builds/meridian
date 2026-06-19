import { useEffect, useState, type ReactNode } from "react";
import {
  Cable,
  Check,
  Code2,
  GitCompare,
  Info,
  Loader2,
  Terminal,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";

import { useSettings } from "@/lib/settings";
import { useUpdater } from "@/lib/updater";
import { EDITOR_THEMES } from "@/lib/monaco";
import { appVersion, getTauriVersion, openExternal } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import logoUrl from "@/assets/logo.png";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SectionId = "terminal" | "editor" | "diff" | "connections" | "about";

const SECTIONS: {
  id: SectionId;
  label: string;
  icon: LucideIcon;
}[] = [
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "editor", label: "Code Editor", icon: Code2 },
  { id: "diff", label: "Diff Viewer", icon: GitCompare },
  { id: "connections", label: "Connections", icon: Cable },
  { id: "about", label: "About", icon: Info },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("terminal");

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex h-[460px] w-[680px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="text-sm font-medium text-fg">Settings</h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
            aria-label="Close settings"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Section selector */}
          <nav className="flex w-[184px] shrink-0 flex-col gap-0.5 border-r border-border p-2">
            {SECTIONS.map((s) => {
              const active = s.id === section;
              const Icon = s.icon;
              return (
                <button
                  key={s.id}
                  onClick={() => setSection(s.id)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
                    active
                      ? "bg-bg-active text-fg"
                      : "text-fg-subtle hover:bg-bg-hover hover:text-fg",
                  )}
                >
                  <Icon size={16} strokeWidth={1.8} />
                  {s.label}
                </button>
              );
            })}
          </nav>

          {/* Section content */}
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            {section === "terminal" ? (
              <TerminalSection />
            ) : section === "editor" ? (
              <EditorSection />
            ) : section === "diff" ? (
              <DiffSection />
            ) : section === "connections" ? (
              <ConnectionsSection />
            ) : (
              <AboutSection />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-[13px] text-fg">{title}</span>
        <span className="text-xs text-fg-subtle">{description}</span>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function TerminalSection() {
  const {
    shells,
    shellProgram,
    setShellProgram,
    dangerouslySkipPermissions,
    setDangerouslySkipPermissions,
  } = useSettings();
  return (
    <>
      <SettingRow
        title="Shell"
        description="Used for new terminals. Changing this restarts open terminals."
      >
        <Select
          value={shellProgram ?? undefined}
          onValueChange={setShellProgram}
        >
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Select a shell" />
          </SelectTrigger>
          <SelectContent>
            {shells.map((shell) => (
              <SelectItem
                key={shell.id}
                value={shell.program}
                disabled={!shell.available}
              >
                {shell.label}
                {!shell.available ? " (not installed)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        title="Allow Dangerously Skip Permissions"
        description="Launch Claude tabs with --dangerously-skip-permissions, bypassing its permission prompts. Only enable if you understand the risks."
      >
        <Switch
          checked={dangerouslySkipPermissions}
          onCheckedChange={setDangerouslySkipPermissions}
        />
      </SettingRow>
    </>
  );
}

function EditorSection() {
  const {
    showMinimap,
    setShowMinimap,
    formatOnSave,
    setFormatOnSave,
    editorTheme,
    setEditorTheme,
    lspEnabled,
    setLspEnabled,
  } = useSettings();
  return (
    <>
      <SettingRow
        title="Theme"
        description="Color theme for the code editor."
      >
        <Select value={editorTheme} onValueChange={setEditorTheme}>
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EDITOR_THEMES.map((theme) => (
              <SelectItem key={theme.id} value={theme.id}>
                {theme.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        title="Format on save"
        description="Format supported files (JS, TS, JSON, CSS, HTML, Markdown, YAML) on save, using the project's own Prettier and config when available."
      >
        <Switch checked={formatOnSave} onCheckedChange={setFormatOnSave} />
      </SettingRow>
      <SettingRow
        title="Show minimap"
        description="Display the code overview on the right edge of the editor."
      >
        <Switch checked={showMinimap} onCheckedChange={setShowMinimap} />
      </SettingRow>
      <SettingRow
        title="Language server"
        description="Project-wide types, errors, and IntelliSense for TypeScript/JavaScript (uses the project's own typescript-language-server when available)."
      >
        <Switch checked={lspEnabled} onCheckedChange={setLspEnabled} />
      </SettingRow>
    </>
  );
}

function DiffSection() {
  const {
    diffStyle,
    setDiffStyle,
    diffWrap,
    setDiffWrap,
    diffIgnoreWhitespace,
    setDiffIgnoreWhitespace,
  } = useSettings();
  return (
    <>
      <SettingRow
        title="View style"
        description="Show changes stacked (unified) or side by side (split)."
      >
        <Select
          value={diffStyle}
          onValueChange={(v) => setDiffStyle(v as "unified" | "split")}
        >
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unified">Unified</SelectItem>
            <SelectItem value="split">Split</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        title="Wrap long lines"
        description="Wrap lines that exceed the panel width instead of scrolling."
      >
        <Switch checked={diffWrap} onCheckedChange={setDiffWrap} />
      </SettingRow>
      <SettingRow
        title="Ignore whitespace"
        description="Hide whitespace-only changes when computing the diff."
      >
        <Switch
          checked={diffIgnoreWhitespace}
          onCheckedChange={setDiffIgnoreWhitespace}
        />
      </SettingRow>
    </>
  );
}

/**
 * Connections section — currently a single Jira card. Meridian ships its own
 * Atlassian OAuth app (credentials baked in at build time), so the user just
 * clicks Connect and consents in the browser; there's nothing to configure
 * here. Status reflects connected / not connected / reconnect-required straight
 * from the backend.
 */
function ConnectionsSection() {
  const { jira, jiraConnecting, connectJira, disconnectJira } = useSettings();

  const connected = jira?.connected ?? false;
  const needsReconnect = jira?.needsReconnect ?? false;
  const hasApp = jira?.hasApp ?? false;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-bg p-4">
        {/* Header: title + status pill */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-[13px] font-medium text-fg">Jira</span>
            <span className="text-xs text-fg-subtle">
              Turn an issue key into a branch name from the branch switcher.
            </span>
          </div>
          <StatusPill connected={connected} needsReconnect={needsReconnect} />
        </div>

        {connected ? (
          <div className="mt-4 space-y-3">
            <div className="text-[13px] text-fg-subtle">
              {jira?.accountName ? (
                <>
                  Connected as{" "}
                  <span className="text-fg">{jira.accountName}</span>
                </>
              ) : (
                "Connected"
              )}
              {jira?.siteUrl && (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => void openExternal(jira.siteUrl as string)}
                    className="text-accent hover:underline"
                  >
                    {jira.siteUrl.replace(/^https?:\/\//, "")}
                  </button>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => void disconnectJira()}
              className="h-8 rounded-md border border-border px-3 text-[13px] text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
            >
              Disconnect
            </button>
          </div>
        ) : hasApp ? (
          <div className="mt-4 space-y-3">
            {needsReconnect && (
              <p className="text-[12px] leading-relaxed text-amber-400">
                Your authorization expired or was revoked. Reconnect to keep
                using Jira features.
              </p>
            )}
            <button
              type="button"
              onClick={() => void connectJira()}
              disabled={jiraConnecting}
              className="flex h-8 items-center gap-2 rounded-md bg-fg px-3 text-[13px] font-medium text-bg transition-colors hover:bg-fg/90 active:bg-fg/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {jiraConnecting && (
                <Loader2 size={13} strokeWidth={2} className="animate-spin" />
              )}
              {jiraConnecting
                ? "Waiting for browser…"
                : needsReconnect
                  ? "Reconnect Jira"
                  : "Connect Jira"}
            </button>
            {jira?.error && (
              <p className="text-[12px] leading-relaxed text-red-400">
                {jira.error}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-4 text-[12px] leading-relaxed text-fg-faint">
            This build of Meridian isn’t configured with Jira credentials.
          </p>
        )}
      </div>
    </div>
  );
}

function StatusPill({
  connected,
  needsReconnect,
}: {
  connected: boolean;
  needsReconnect: boolean;
}) {
  if (connected) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
        <Check size={11} strokeWidth={2.5} />
        Connected
      </span>
    );
  }
  if (needsReconnect) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-400">
        <TriangleAlert size={11} strokeWidth={2.5} />
        Reconnect required
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-bg-hover px-2.5 py-1 text-[11px] font-medium text-fg-subtle">
      Not connected
    </span>
  );
}

/**
 * About section — app identity and build versions. The version comes from
 * tauri.conf.json, which CI stamps from the release tag (see
 * scripts/ci-set-version.mjs); locally it's the committed placeholder.
 */
function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void appVersion()
      .then((v) => !cancelled && setVersion(v))
      .catch(() => {});
    void getTauriVersion()
      .then((v) => !cancelled && setRuntime(v))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <img src={logoUrl} alt="Meridian" className="h-12 w-12 rounded-xl" />
        <div className="flex flex-col">
          <span className="text-[15px] font-medium text-fg">Meridian</span>
          <span className="text-xs text-fg-subtle">
            Agentic development environment
          </span>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-bg">
        <InfoRow label="Version" value={version ?? "—"} />
        <div className="border-t border-border" />
        <InfoRow label="Tauri runtime" value={runtime ?? "—"} />
      </div>

      <UpdateControl />

      <button
        type="button"
        onClick={() =>
          void openExternal("https://github.com/tyler-builds/meridian")
        }
        className="text-[13px] text-accent hover:underline"
      >
        View on GitHub
      </button>
    </div>
  );
}

/**
 * Manual update control for the About tab. Mirrors the silent launch check and
 * the status-bar CTA, but lets the user check on demand and shows the outcome
 * (up to date / available / error) inline.
 */
function UpdateControl() {
  const { status, check, installAndRestart } = useUpdater();
  const busy = status.kind === "checking" || status.kind === "downloading";

  const label =
    status.kind === "checking"
      ? "Checking…"
      : status.kind === "downloading"
        ? status.pct != null
          ? `Updating… ${status.pct}%`
          : "Updating…"
        : status.kind === "available"
          ? `Install ${status.version} & restart`
          : "Check for updates";

  const onClick = () => {
    if (status.kind === "available") void installAndRestart();
    else void check(true);
  };

  const message =
    status.kind === "uptodate"
      ? "You're on the latest version."
      : status.kind === "unsupported"
        ? "Updates are only available in installed (release) builds."
        : status.kind === "error"
          ? `Update failed: ${status.message}`
          : null;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={cn(
          "flex h-8 items-center gap-2 self-start rounded-md px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
          status.kind === "available"
            ? "bg-accent text-bg hover:bg-accent/90"
            : "border border-border text-fg-subtle hover:bg-bg-hover hover:text-fg",
        )}
      >
        {busy && (
          <Loader2 size={13} strokeWidth={2} className="animate-spin" />
        )}
        {label}
      </button>
      {message && (
        <p
          className={cn(
            "text-[12px] leading-relaxed",
            status.kind === "error" ? "text-red-400" : "text-fg-subtle",
          )}
        >
          {message}
        </p>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-[13px] text-fg-subtle">{label}</span>
      <span className="font-mono text-[13px] text-fg">{value}</span>
    </div>
  );
}
