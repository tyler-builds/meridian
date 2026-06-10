import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";

import {
  claudeUsage,
  gitCurrentBranch,
  type ClaudeUsage,
  type ClaudeUsageWindow,
} from "@/lib/tauri";
import { ClaudeIcon } from "@/components/ClaudeIcon";

/**
 * Poll the active project's git branch. Re-reads on a short interval so the
 * status bar stays current when the branch is changed from a terminal.
 */
function useGitBranch(path: string | undefined): string | null {
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setBranch(null);
      return;
    }
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
  }, [path]);

  return branch;
}

/**
 * Poll Claude subscription usage from the OAuth usage endpoint. Refreshes on a
 * slow interval (utilization moves only as `claude` runs) and on window focus.
 */
function useClaudeUsage(): ClaudeUsage | null {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      claudeUsage()
        .then((u) => {
          if (active) setUsage(u);
        })
        .catch(() => {
          if (active) setUsage(null);
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
  }, []);

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

/** Full-width status bar pinned to the bottom of the window. */
export function StatusBar({ projectPath }: { projectPath?: string }) {
  const branch = useGitBranch(projectPath);
  const usage = useClaudeUsage();

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-bg-elevated px-3 text-[11px] text-fg-subtle">
      {branch && (
        <div
          className="flex min-w-0 items-center gap-1.5"
          title={`Git branch: ${branch}`}
        >
          <GitBranch size={12} strokeWidth={1.8} className="shrink-0 text-accent" />
          <span className="truncate">{branch}</span>
        </div>
      )}

      {usage?.available && (
        <div className="ml-auto flex items-center gap-3">
          <ClaudeIcon size={12} className="shrink-0" />
          <UsageBar label="5hr" window={usage.fiveHour} />
          <UsageBar label="wk" window={usage.sevenDay} />
        </div>
      )}
    </footer>
  );
}
