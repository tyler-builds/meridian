import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Cpu,
  Download,
  FileMinus,
  FilePen,
  FilePlus,
  GitBranch,
  Loader2,
  MemoryStick,
  Power,
  RotateCw,
  Zap,
} from "lucide-react";

import {
  claudeUsage,
  gitCurrentBranch,
  gitStatus,
  lspStatus,
  resourceStats,
  type BrowserOwner,
  type ClaudeUsage,
  type ClaudeUsageWindow,
  type GitFile,
  type OwnerUsage,
  type ResourceReport,
  type Usage,
} from "@/lib/tauri";
import { lspManager } from "@/lib/lsp/manager";
import { useUpdater, type UpdaterStatus } from "@/lib/updater";
import { ClaudeIcon } from "@/components/ClaudeIcon";
import { BranchSwitcher } from "@/components/BranchSwitcher";
import { GitStatusPopup } from "@/components/GitStatusPopup";
import { DIFF_ADDITION_COLOR, DIFF_DELETION_COLOR } from "@/lib/diffTheme";
import { persist } from "@/lib/persist";

/** Amber used for "modified" — matches the M badge in the Source Control panel. */
const MODIFIED_COLOR = "#d29922";

/** The toggleable status bar components, in display/menu order. */
type StatusItem = "branch" | "changes" | "lsp" | "resources" | "usage";

const STATUS_ITEMS: { key: StatusItem; label: string }[] = [
  { key: "branch", label: "Git Branch" },
  { key: "changes", label: "Git Changes" },
  { key: "lsp", label: "Language Server" },
  { key: "resources", label: "Resource Manager" },
  { key: "usage", label: "Claude Usage" },
];

const DEFAULT_VISIBLE: Record<StatusItem, boolean> = {
  branch: true,
  changes: true,
  lsp: true,
  resources: true,
  usage: true,
};

/**
 * Which status bar components the user has enabled, persisted across sessions.
 * Returns the current map plus a `toggle` that flips one item and saves.
 */
function useStatusBarVisibility(): {
  visible: Record<StatusItem, boolean>;
  toggle: (item: StatusItem) => void;
} {
  const [visible, setVisible] = useState<Record<StatusItem, boolean>>(() => {
    try {
      const raw = persist.getItem("meridian.statusBarItems");
      if (raw) return { ...DEFAULT_VISIBLE, ...JSON.parse(raw) };
    } catch {
      /* malformed value; fall back to defaults */
    }
    return DEFAULT_VISIBLE;
  });

  const toggle = (item: StatusItem) => {
    setVisible((prev) => {
      const next = { ...prev, [item]: !prev[item] };
      persist.setItem("meridian.statusBarItems", JSON.stringify(next));
      return next;
    });
  };

  return { visible, toggle };
}

/**
 * Poll the active project's git branch. Re-reads on a short interval so the
 * status bar stays current when the branch is changed from a terminal.
 */
function useGitBranch(
  path: string | undefined,
  enabled: boolean,
  nonce: number,
): string | null {
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setBranch(null);
      return;
    }
    // Keep the last value when merely toggled off so re-enabling shows it
    // instantly; just stop polling until then.
    if (!enabled) return;
    let active = true;
    const refresh = () => {
      gitCurrentBranch(path)
        .then((b) => {
          if (active) setBranch(b);
        })
        .catch(() => {
          if (active) setBranch(null);
        });
    };
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [path, enabled, nonce]);

  return branch;
}

interface ChangeCounts {
  added: number;
  modified: number;
  deleted: number;
}

/** Per-category file counts plus the branch's ahead/behind state vs upstream. */
interface GitSummary {
  counts: ChangeCounts;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}

/** Bucket each changed file into added / deleted / modified (one bucket each). */
function countChanges(files: GitFile[]): ChangeCounts {
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const f of files) {
    if (f.untracked || f.index === "A") added++;
    else if (f.index === "D" || f.worktree === "D") deleted++;
    else modified++;
  }
  return { added, modified, deleted };
}

/** True when the summary has anything worth surfacing (changes or out-of-sync). */
function hasGitActivity(s: GitSummary): boolean {
  const { added, modified, deleted } = s.counts;
  return added + modified + deleted > 0 || s.ahead > 0 || s.behind > 0;
}

/**
 * Poll the active project's working-tree status and reduce it to per-category
 * file counts plus ahead/behind state. Refreshes on the same cadence as the
 * branch, plus on window focus so it picks up changes made while the app was in
 * the background.
 */
function useGitSummary(
  path: string | undefined,
  enabled: boolean,
  nonce: number,
): GitSummary | null {
  const [summary, setSummary] = useState<GitSummary | null>(null);

  useEffect(() => {
    if (!path) {
      setSummary(null);
      return;
    }
    // Keep the last value when merely toggled off (see useGitBranch).
    if (!enabled) return;
    let active = true;
    const refresh = () => {
      gitStatus(path)
        .then((s) => {
          if (active)
            setSummary({
              counts: countChanges(s.files),
              ahead: s.ahead,
              behind: s.behind,
              hasUpstream: s.hasUpstream,
            });
        })
        .catch(() => {
          if (active) setSummary(null);
        });
    };
    refresh();
    const interval = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [path, enabled, nonce]);

  return summary;
}

/**
 * Poll Claude subscription usage from the OAuth usage endpoint. Refreshes on a
 * slow interval (utilization moves only as `claude` runs) and on window focus.
 */
function useClaudeUsage(enabled: boolean): ClaudeUsage | null {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);

  useEffect(() => {
    // Keep the last value when toggled off so re-enabling shows it immediately
    // rather than blanking until the network fetch returns; just pause polling.
    if (!enabled) return;
    let active = true;
    // The backend collapses every failure mode — network blip, rate-limit, and
    // an on-disk access token that expired between CLI runs (Meridian reads
    // Claude Code's token passively and never refreshes it) — into
    // `available:false`. None of those mean usage stopped mattering, so keep
    // showing the last good value rather than hiding the bars; they update
    // again as soon as a fetch succeeds. The bars only ever disappear if no
    // fetch has succeeded since launch (e.g. genuinely signed out).
    const refresh = () => {
      claudeUsage()
        .then((u) => {
          if (active && u.available) setUsage(u);
        })
        .catch(() => {
          /* transient failure; keep the last good value */
        });
    };
    refresh();
    const interval = setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled]);

  return usage;
}

/**
 * Poll the backend for the project roots whose language-server process is
 * actually alive. This is authoritative (the backend probes each child), not an
 * assumption from the open file. Polls only while enabled (on a file tab).
 */
function useLspServers(enabled: boolean): string[] {
  const [servers, setServers] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const refresh = () => {
      lspStatus()
        .then((s) => {
          if (active) setServers(s);
        })
        .catch(() => {
          /* backend unavailable; keep the last value */
        });
    };
    refresh();
    const interval = setInterval(refresh, 4000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled]);

  return servers;
}

/**
 * Poll the backend for the whole app's CPU/RAM, attributed to App core and each
 * open project. Refreshes on a short interval while enabled and on window focus.
 * `roots` is the list of open project roots used for attribution. A faster
 * cadence is used while the detail popup is open for a more live feel.
 */
function useResourceStats(
  enabled: boolean,
  roots: string[],
  browsers: BrowserOwner[],
  fast: boolean,
): ResourceReport | null {
  const [report, setReport] = useState<ResourceReport | null>(null);
  // Pass roots/browsers by value but key the effect on their identity so
  // adding/closing a project or browser tab re-attributes immediately.
  const rootsKey = roots.join(" ");
  const browsersKey = browsers.map((b) => `${b.root} ${b.url}`).join(" ");

  useEffect(() => {
    // Keep the last value when toggled off (see useClaudeUsage); just pause.
    if (!enabled) return;
    let active = true;
    const refresh = () => {
      resourceStats(roots, browsers)
        .then((r) => {
          if (active) setReport(r);
        })
        .catch(() => {
          /* transient backend error; keep the last good value */
        });
    };
    refresh();
    // 10 s at rest — the scan enumerates every process on the machine, so keep
    // it infrequent; 2 s while the detail popup is open for a live feel.
    const interval = setInterval(refresh, fast ? 2000 : 10_000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fast, rootsKey, browsersKey]);

  return report;
}

/** Format a byte count as a compact "512 MB" / "1.3 GB" string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Tailwind text color for a percentage: subtle until it climbs, then warns. */
function pctColor(pct: number): string {
  if (pct >= 80) return "text-red-400";
  if (pct >= 50) return "text-amber-400";
  return "text-fg-subtle";
}

/** Normalize a path for comparison (case-insensitive, separator-agnostic). */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Basename of an absolute path (handles both separators). */
function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** Human-friendly "resets in 3h 20m" from an ISO instant, or null. */
function formatReset(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return `resets in ${hours}h${rem ? ` ${rem}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `resets in ${days}d ${hours % 24}h`;
}

/** A small filled progress bar with a label, showing one usage window. */
function UsageBar({ label, window }: { label: string; window: ClaudeUsageWindow }) {
  const pct = Math.max(0, Math.min(100, Math.round(window.utilization)));
  // Stay subtle until usage climbs; warn as the window approaches its ceiling.
  const fill =
    pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-accent";
  const reset = formatReset(window.resetsAt);

  return (
    <div
      className="flex items-center gap-1.5"
      title={`Claude ${label} usage — ${pct}% used${reset ? ` (${reset})` : ""}`}
    >
      <span className="text-fg-faint">{label}</span>
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-bg-active">
        <div
          className={`h-full rounded-full ${fill} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Clickable status item: per-category changed-file counts plus the branch's
 * ahead/behind state. Renders nothing when the tree is clean and in sync. Click
 * opens the git status popup (sync actions + scrollable file list).
 */
function GitStatusItem({
  summary,
  onOpen,
}: {
  summary: GitSummary;
  onOpen: (rect: DOMRect) => void;
}) {
  if (!hasGitActivity(summary)) return null;

  const { added, modified, deleted } = summary.counts;
  const { ahead, behind, hasUpstream } = summary;
  const total = added + modified + deleted;
  const showSync = hasUpstream && (ahead > 0 || behind > 0);

  const title =
    `${total} file${total === 1 ? "" : "s"} changed${
      added ? ` · ${added} added` : ""
    }${modified ? ` · ${modified} modified` : ""}${
      deleted ? ` · ${deleted} deleted` : ""
    }${behind ? ` · ${behind} behind` : ""}${
      ahead ? ` · ${ahead} ahead` : ""
    } — click for details`.replace(/^0 files changed · /, "");

  return (
    <button
      type="button"
      className="flex items-center gap-2 rounded px-1 -mx-1 text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
      title={title}
      onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect())}
    >
      {added > 0 && (
        <span className="flex items-center gap-0.5" style={{ color: DIFF_ADDITION_COLOR }}>
          <FilePlus size={12} strokeWidth={1.8} className="shrink-0" />
          {added}
        </span>
      )}
      {modified > 0 && (
        <span className="flex items-center gap-0.5" style={{ color: MODIFIED_COLOR }}>
          <FilePen size={12} strokeWidth={1.8} className="shrink-0" />
          {modified}
        </span>
      )}
      {deleted > 0 && (
        <span className="flex items-center gap-0.5" style={{ color: DIFF_DELETION_COLOR }}>
          <FileMinus size={12} strokeWidth={1.8} className="shrink-0" />
          {deleted}
        </span>
      )}
      {showSync && (
        <span className="flex items-center gap-1.5 text-fg-faint">
          {behind > 0 && (
            <span className="flex items-center gap-0.5">
              <ArrowDown size={12} strokeWidth={1.8} className="shrink-0" />
              {behind}
            </span>
          )}
          {ahead > 0 && (
            <span className="flex items-center gap-0.5">
              <ArrowUp size={12} strokeWidth={1.8} className="shrink-0" />
              {ahead}
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/**
 * Right-click menu to enable/disable individual status bar components. Anchored
 * at the click point and grown upward (the bar sits at the bottom of the window).
 * Closes on outside click or Escape.
 */
function StatusBarMenu({
  x,
  y,
  visible,
  onToggle,
  onClose,
}: {
  x: number;
  y: number;
  visible: Record<StatusItem, boolean>;
  onToggle: (item: StatusItem) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-[80] min-w-[11rem] overflow-hidden rounded-lg border border-border bg-bg-elevated p-1 text-fg shadow-lg"
      style={{
        left: Math.min(x, window.innerWidth - 188),
        bottom: window.innerHeight - y,
      }}
    >
      {STATUS_ITEMS.map((it) => (
        <button
          key={it.key}
          type="button"
          className="flex w-full cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg-subtle outline-none transition-colors hover:bg-bg-hover hover:text-fg"
          onClick={() => onToggle(it.key)}
        >
          <Check
            size={13}
            strokeWidth={2}
            className={`shrink-0 text-accent ${
              visible[it.key] ? "opacity-100" : "opacity-0"
            }`}
          />
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Lightning-bolt "LSP" status item. The bolt is lit (accent) when a language
 * server is running for the current project, muted otherwise. Click opens the
 * running-servers popup.
 */
function LspStatusItem({
  running,
  onOpen,
}: {
  running: boolean;
  onOpen: (rect: DOMRect) => void;
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded px-1 -mx-1 text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
      title={
        running
          ? "Language server running — click for details"
          : "No language server running for this project — click for details"
      }
      onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect())}
    >
      <Zap
        size={12}
        strokeWidth={1.8}
        className={`shrink-0 ${running ? "text-accent" : "text-fg-faint"}`}
      />
      <span>LSP</span>
    </button>
  );
}

interface RunningServer {
  root: string;
  languages: string[];
  ready: boolean;
}

/**
 * Popup listing the language servers that are actually running. Liveness comes
 * from the backend (`lspStatus`, which probes each process); the per-server
 * detail — the languages it's serving and ready state — comes from the client
 * manager. Each server can be restarted or stopped. Hung above the LSP item.
 */
function LspPopup({
  anchor,
  currentPath,
  onClose,
}: {
  anchor: DOMRect;
  currentPath?: string;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [servers, setServers] = useState<RunningServer[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const alive = await lspStatus();
      const byRoot = new Map(
        lspManager.listServers().map((d) => [normPath(d.root), d]),
      );
      setServers(
        alive.map((root) => {
          const d = byRoot.get(normPath(root));
          return {
            root,
            languages: d?.languages ?? [],
            ready: d?.ready ?? true,
          };
        }),
      );
    } catch {
      setServers([]);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (active) void refresh();
    };
    tick();
    const interval = setInterval(tick, 2000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [refresh]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const restart = async (root: string) => {
    setBusy(root);
    try {
      await lspManager.restartClient(root);
    } finally {
      setBusy(null);
      void refresh();
    }
  };
  const stop = async (root: string) => {
    setBusy(root);
    try {
      await lspManager.disposeClient(root);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const WIDTH = 320;
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - WIDTH - 8);
  const bottom = window.innerHeight - anchor.top + 6;

  return (
    <div
      ref={rootRef}
      className="fixed z-[80] flex max-h-[340px] w-[320px] flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated text-[13px] shadow-2xl"
      style={{ left, bottom }}
    >
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-2 text-fg">
        <Zap size={13} strokeWidth={1.8} className="shrink-0 text-accent" />
        <span className="font-medium">Language Servers</span>
        {servers && (
          <span className="ml-auto text-fg-faint">{servers.length}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {servers === null ? (
          <div className="px-2.5 py-2 text-fg-faint">Checking…</div>
        ) : servers.length === 0 ? (
          <div className="px-2.5 py-2 text-fg-faint">
            No language servers running.
          </div>
        ) : (
          servers.map((s) => {
            const isCurrent =
              currentPath != null && normPath(s.root) === normPath(currentPath);
            const detail = !s.ready
              ? "starting…"
              : s.languages.length > 0
                ? s.languages.join(", ")
                : "no files open";
            return (
              <div key={s.root} className="px-2.5 py-2" title={s.root}>
                <div className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      s.ready ? "bg-emerald-500" : "bg-amber-500"
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-fg">
                    {baseName(s.root)}
                    {isCurrent && (
                      <span className="text-fg-faint"> · current</span>
                    )}
                  </span>
                  {busy === s.root ? (
                    <Loader2
                      size={13}
                      strokeWidth={2}
                      className="shrink-0 animate-spin text-fg-faint"
                    />
                  ) : (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        title="Restart server"
                        onClick={() => void restart(s.root)}
                        className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
                      >
                        <RotateCw size={12} strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        title="Stop server"
                        onClick={() => void stop(s.root)}
                        className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-bg-hover hover:text-red-400"
                      >
                        <Power size={12} strokeWidth={1.8} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="mt-0.5 truncate pl-4 text-[11px] text-fg-subtle">
                  {detail}
                </div>
                <div className="truncate pl-4 text-[11px] text-fg-faint">
                  typescript-language-server · {s.root}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * Compact CPU% + RAM% for the whole app, shown on the right of the bar. Click
 * opens the detailed per-project popup.
 */
function ResourceItem({
  total,
  onOpen,
}: {
  total: Usage;
  onOpen: (rect: DOMRect) => void;
}) {
  const cpu = Math.round(total.cpuPct);
  const mem = Math.round(total.memPct);
  return (
    <button
      type="button"
      className="flex items-center gap-2 rounded px-1 -mx-1 text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
      title={`Meridian is using ${cpu}% CPU and ${mem}% RAM (${formatBytes(
        total.memBytes,
      )}) — click for a per-project breakdown`}
      onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect())}
    >
      <span className={`flex items-center gap-1 ${pctColor(total.cpuPct)}`}>
        <Cpu size={12} strokeWidth={1.8} className="shrink-0" />
        {cpu}%
      </span>
      <span className={`flex items-center gap-1 ${pctColor(total.memPct)}`}>
        <MemoryStick size={12} strokeWidth={1.8} className="shrink-0" />
        {mem}%
      </span>
    </button>
  );
}

/** The CPU% / RAM% pair shown on the right of every popup row. */
function UsageFigures({ usage, dim }: { usage: Usage; dim?: boolean }) {
  const base = dim ? "text-fg-faint" : "text-fg-subtle";
  return (
    <span className="flex shrink-0 items-center gap-2 tabular-nums">
      <span className="flex w-12 items-center justify-end gap-1">
        <Cpu size={11} strokeWidth={1.8} className={`shrink-0 ${base}`} />
        <span className={dim ? "text-fg-faint" : pctColor(usage.cpuPct)}>
          {usage.cpuPct.toFixed(usage.cpuPct < 10 ? 1 : 0)}%
        </span>
      </span>
      <span className="flex w-[4.5rem] items-center justify-end gap-1">
        <MemoryStick size={11} strokeWidth={1.8} className={`shrink-0 ${base}`} />
        <span
          className={`whitespace-nowrap ${
            dim ? "text-fg-faint" : pctColor(usage.memPct)
          }`}
        >
          {formatBytes(usage.memBytes)}
        </span>
      </span>
    </span>
  );
}

/** One owner row (App core or a project) with an optional expandable breakdown. */
function OwnerRow({ owner }: { owner: OwnerUsage }) {
  const [open, setOpen] = useState(false);
  const expandable = owner.breakdown.length > 0;

  return (
    <div>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => expandable && setOpen((o) => !o)}
        className={`flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors ${
          expandable ? "hover:bg-bg-hover" : "cursor-default"
        }`}
        title={owner.root ?? "The app host process plus the UI, GPU and web content"}
      >
        <ChevronRight
          size={12}
          strokeWidth={2}
          className={`shrink-0 text-fg-faint transition-transform ${
            expandable ? "" : "opacity-0"
          } ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1 truncate text-fg">{owner.label}</span>
        <UsageFigures usage={owner.usage} />
      </button>
      {open &&
        owner.breakdown.map((c) => (
          <div
            key={c.kind}
            className="flex items-center gap-1.5 py-1 pl-7 pr-2.5 text-[12px]"
          >
            <span className="min-w-0 flex-1 truncate text-fg-subtle">
              {c.label}
            </span>
            <UsageFigures usage={c.usage} dim />
          </div>
        ))}
    </div>
  );
}

/**
 * Detail popup for the Resource Manager: the app-wide total at the top, then a
 * row per owner (App core + each open project), each expandable to show what
 * inside it is consuming resources. Hung above the resource item; polls its own
 * faster copy while open. Closes on outside click or Escape.
 */
function ResourcePopup({
  anchor,
  report,
  onClose,
}: {
  anchor: DOMRect;
  report: ResourceReport | null;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const WIDTH = 340;
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - WIDTH - 8);
  const bottom = window.innerHeight - anchor.top + 6;

  return (
    <div
      ref={rootRef}
      className="fixed z-[80] flex max-h-[380px] w-[340px] flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated text-[13px] shadow-2xl"
      style={{ left, bottom }}
    >
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-2 text-fg">
        <Cpu size={13} strokeWidth={1.8} className="shrink-0 text-accent" />
        <span className="font-medium">Resource Manager</span>
        {report && <UsageFigures usage={report.total} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {report === null ? (
          <div className="px-2.5 py-2 text-fg-faint">Measuring…</div>
        ) : (
          <>
            <OwnerRow owner={report.app} />
            {report.projects.length > 0 && (
              <div className="mt-1 border-t border-border/60 pt-1">
                {report.projects.map((p) => (
                  <OwnerRow key={p.root ?? p.label} owner={p} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Self-update call-to-action. Hidden unless an update is available or actively
 * downloading; clicking it downloads, installs, and relaunches. `ml-auto` pins
 * it (and the resource/usage cluster after it) to the right of the bar.
 */
function UpdateStatusItem({
  status,
  onInstall,
}: {
  status: UpdaterStatus;
  onInstall: () => void;
}) {
  if (status.kind === "downloading") {
    return (
      <span
        className="ml-auto flex items-center gap-1.5 text-accent"
        title={`Downloading Meridian ${status.version}…`}
      >
        <Loader2 size={12} strokeWidth={2} className="shrink-0 animate-spin" />
        {status.pct != null ? `Updating… ${status.pct}%` : "Updating…"}
      </span>
    );
  }
  if (status.kind === "available") {
    return (
      <button
        type="button"
        className="ml-auto flex items-center gap-1.5 rounded px-1 -mx-1 text-accent transition-colors hover:bg-bg-hover"
        title={`Meridian ${status.version} is available — click to install and restart`}
        onClick={onInstall}
      >
        <Download size={12} strokeWidth={1.8} className="shrink-0" />
        Update to {status.version}
      </button>
    );
  }
  return null;
}

/** Full-width status bar pinned to the bottom of the window. */
export function StatusBar({
  projectPath,
  onFileTab,
  projectRoots = [],
  browserTabs = [],
}: {
  projectPath?: string;
  onFileTab?: boolean;
  projectRoots?: string[];
  browserTabs?: BrowserOwner[];
}) {
  const { visible, toggle } = useStatusBarVisibility();
  const updater = useUpdater();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Viewport rect of the branch item while the switcher is open (null = closed).
  const [switcherAnchor, setSwitcherAnchor] = useState<DOMRect | null>(null);
  // Viewport rect of the changes item while the status popup is open (null = closed).
  const [statusAnchor, setStatusAnchor] = useState<DOMRect | null>(null);
  // Viewport rect of the LSP item while its popup is open (null = closed).
  const [lspAnchor, setLspAnchor] = useState<DOMRect | null>(null);
  // Viewport rect of the resource item while its popup is open (null = closed).
  const [resAnchor, setResAnchor] = useState<DOMRect | null>(null);

  const branch = useGitBranch(projectPath, visible.branch, reloadNonce);
  const summary = useGitSummary(projectPath, visible.changes, reloadNonce);
  const usage = useClaudeUsage(visible.usage);
  // The LSP item only shows on a file tab; poll the running servers while it
  // does — but pause while the popup is open, since the popup polls its own
  // (richer) copy and would otherwise duplicate the lspStatus calls.
  const showLsp = Boolean(visible.lsp && onFileTab);
  const lspServers = useLspServers(showLsp && lspAnchor === null);
  const lspRunning =
    projectPath != null &&
    lspServers.some((r) => normPath(r) === normPath(projectPath));
  // Resource stats poll faster while the popup is open for a live feel.
  const resources = useResourceStats(
    visible.resources,
    projectRoots,
    browserTabs,
    resAnchor !== null,
  );

  return (
    <footer
      className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-bg-elevated px-3 text-[11px] text-fg-subtle"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {visible.branch && branch && (
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded px-1 -mx-1 text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
          title={`Git branch: ${branch} — click to switch`}
          onClick={(e) =>
            setSwitcherAnchor(e.currentTarget.getBoundingClientRect())
          }
        >
          <GitBranch size={12} strokeWidth={1.8} className="shrink-0 text-accent" />
          <span className="truncate">{branch}</span>
        </button>
      )}

      {visible.changes && summary && (
        <GitStatusItem summary={summary} onOpen={setStatusAnchor} />
      )}

      {showLsp && (
        <LspStatusItem running={lspRunning} onOpen={setLspAnchor} />
      )}

      <UpdateStatusItem
        status={updater.status}
        onInstall={() => void updater.installAndRestart()}
      />

      {(visible.resources || (visible.usage && usage?.available)) && (
        <div className="ml-auto flex items-center gap-3">
          {visible.resources && resources && (
            <ResourceItem total={resources.total} onOpen={setResAnchor} />
          )}
          {visible.usage && usage?.available && (
            <div className="flex items-center gap-3">
              <ClaudeIcon size={12} className="shrink-0" />
              <UsageBar label="5hr" window={usage.fiveHour} />
              <UsageBar label="wk" window={usage.sevenDay} />
            </div>
          )}
        </div>
      )}

      {menu && (
        <StatusBarMenu
          x={menu.x}
          y={menu.y}
          visible={visible}
          onToggle={toggle}
          onClose={() => setMenu(null)}
        />
      )}

      {switcherAnchor && projectPath && (
        <BranchSwitcher
          path={projectPath}
          current={branch}
          anchor={switcherAnchor}
          onClose={() => setSwitcherAnchor(null)}
          onSwitched={() => setReloadNonce((n) => n + 1)}
        />
      )}

      {statusAnchor && projectPath && (
        <GitStatusPopup
          path={projectPath}
          anchor={statusAnchor}
          onClose={() => setStatusAnchor(null)}
          onChanged={() => setReloadNonce((n) => n + 1)}
        />
      )}

      {lspAnchor && (
        <LspPopup
          anchor={lspAnchor}
          currentPath={projectPath}
          onClose={() => setLspAnchor(null)}
        />
      )}

      {resAnchor && (
        <ResourcePopup
          anchor={resAnchor}
          report={resources}
          onClose={() => setResAnchor(null)}
        />
      )}
    </footer>
  );
}
