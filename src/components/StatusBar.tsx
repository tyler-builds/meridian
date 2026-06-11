import { useEffect, useRef, useState } from "react";
import { Check, FileMinus, FilePen, FilePlus, GitBranch } from "lucide-react";

import {
  claudeUsage,
  gitCurrentBranch,
  gitStatus,
  type ClaudeUsage,
  type ClaudeUsageWindow,
  type GitFile,
} from "@/lib/tauri";
import { ClaudeIcon } from "@/components/ClaudeIcon";
import { BranchSwitcher } from "@/components/BranchSwitcher";
import { DIFF_ADDITION_COLOR, DIFF_DELETION_COLOR } from "@/lib/diffTheme";
import { persist } from "@/lib/persist";

/** Amber used for "modified" — matches the M badge in the Source Control panel. */
const MODIFIED_COLOR = "#d29922";

/** The toggleable status bar components, in display/menu order. */
type StatusItem = "branch" | "changes" | "usage";

const STATUS_ITEMS: { key: StatusItem; label: string }[] = [
  { key: "branch", label: "Git Branch" },
  { key: "changes", label: "Git Changes" },
  { key: "usage", label: "Claude Usage" },
];

const DEFAULT_VISIBLE: Record<StatusItem, boolean> = {
  branch: true,
  changes: true,
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

/**
 * Poll the active project's working-tree status and reduce it to per-category
 * file counts. Refreshes on the same cadence as the branch, plus on window
 * focus so it picks up changes made while the app was in the background.
 */
function useGitChanges(
  path: string | undefined,
  enabled: boolean,
  nonce: number,
): ChangeCounts | null {
  const [counts, setCounts] = useState<ChangeCounts | null>(null);

  useEffect(() => {
    if (!path) {
      setCounts(null);
      return;
    }
    // Keep the last value when merely toggled off (see useGitBranch).
    if (!enabled) return;
    let active = true;
    const refresh = () => {
      gitStatus(path)
        .then((s) => {
          if (active) setCounts(countChanges(s.files));
        })
        .catch(() => {
          if (active) setCounts(null);
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

  return counts;
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
    // the brief window where `claude` rewrites ~/.claude/.credentials.json on a
    // token refresh — into `available:false`. Blanking on a single such result
    // makes the bar flicker away mid-session, so tolerate a few consecutive
    // misses (keeping the last good value) before hiding. Sustained
    // unavailability (a real sign-out) still clears it after the threshold.
    let misses = 0;
    const refresh = () => {
      claudeUsage()
        .then((u) => {
          if (!active) return;
          if (u.available) {
            misses = 0;
            setUsage(u);
          } else if (++misses >= 3) {
            setUsage(null);
          }
        })
        .catch(() => {
          if (active && ++misses >= 3) setUsage(null);
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

/** Per-category changed-file counts: colored icon + number for each non-zero bucket. */
function GitChanges({ counts }: { counts: ChangeCounts }) {
  const { added, modified, deleted } = counts;
  const total = added + modified + deleted;
  if (total === 0) return null;

  return (
    <div
      className="flex items-center gap-2"
      title={`${total} file${total === 1 ? "" : "s"} changed${
        added ? ` · ${added} added` : ""
      }${modified ? ` · ${modified} modified` : ""}${
        deleted ? ` · ${deleted} deleted` : ""
      }`}
    >
      {added > 0 && (
        <span
          className="flex items-center gap-0.5"
          style={{ color: DIFF_ADDITION_COLOR }}
        >
          <FilePlus size={12} strokeWidth={1.8} className="shrink-0" />
          {added}
        </span>
      )}
      {modified > 0 && (
        <span
          className="flex items-center gap-0.5"
          style={{ color: MODIFIED_COLOR }}
        >
          <FilePen size={12} strokeWidth={1.8} className="shrink-0" />
          {modified}
        </span>
      )}
      {deleted > 0 && (
        <span
          className="flex items-center gap-0.5"
          style={{ color: DIFF_DELETION_COLOR }}
        >
          <FileMinus size={12} strokeWidth={1.8} className="shrink-0" />
          {deleted}
        </span>
      )}
    </div>
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

/** Full-width status bar pinned to the bottom of the window. */
export function StatusBar({ projectPath }: { projectPath?: string }) {
  const { visible, toggle } = useStatusBarVisibility();
  const [reloadNonce, setReloadNonce] = useState(0);
  const branch = useGitBranch(projectPath, visible.branch, reloadNonce);
  const changes = useGitChanges(projectPath, visible.changes, reloadNonce);
  const usage = useClaudeUsage(visible.usage);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Viewport rect of the branch item while the switcher is open (null = closed).
  const [switcherAnchor, setSwitcherAnchor] = useState<DOMRect | null>(null);

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

      {visible.changes && changes && <GitChanges counts={changes} />}

      {visible.usage && usage?.available && (
        <div className="ml-auto flex items-center gap-3">
          <ClaudeIcon size={12} className="shrink-0" />
          <UsageBar label="5hr" window={usage.fiveHour} />
          <UsageBar label="wk" window={usage.sevenDay} />
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
    </footer>
  );
}
