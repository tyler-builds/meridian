import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  FileMinus,
  FilePen,
  FilePlus,
  GitBranch,
  Loader2,
  RefreshCw,
  Upload,
  type LucideIcon,
} from "lucide-react";

import {
  gitFetch,
  gitPull,
  gitPush,
  gitStatus,
  gitUnpushedCommits,
  type GitFile,
  type GitStatus,
} from "@/lib/tauri";
import { DIFF_ADDITION_COLOR, DIFF_DELETION_COLOR } from "@/lib/diffTheme";
import { DirtyDialog } from "@/components/BranchSwitcher";
import { cn } from "@/lib/utils";

/** Amber for "modified" — matches the status bar counter and Source Control panel. */
const MODIFIED_COLOR = "#d29922";

type FileCategory = "added" | "modified" | "deleted";

/** Bucket one changed file for its row icon (same rule as the status bar counter). */
function fileCategory(f: GitFile): FileCategory {
  if (f.untracked || f.index === "A") return "added";
  if (f.index === "D" || f.worktree === "D") return "deleted";
  return "modified";
}

const CATEGORY_ICON = {
  added: FilePlus,
  modified: FilePen,
  deleted: FileMinus,
} as const;

const CATEGORY_COLOR: Record<FileCategory, string> = {
  added: DIFF_ADDITION_COLOR,
  modified: MODIFIED_COLOR,
  deleted: DIFF_DELETION_COLOR,
};

type SyncMode = "publish" | "sync" | "pull" | "push" | "fetch";

interface SyncAction {
  mode: SyncMode;
  label: string;
  icon: LucideIcon;
  /** Whether the action touches the working tree and so needs a clean tree. */
  gated: boolean;
}

/**
 * The single contextual sync action for the current state — the GitHub Desktop
 * model: publish an unpublished branch, sync a diverged one (pull then push),
 * pull when only behind, push when only ahead, otherwise fetch to refresh the
 * counts. Returns null when there's no remote to talk to at all.
 */
function syncAction(s: GitStatus): SyncAction | null {
  if (!s.hasRemote) return null;
  if (!s.hasUpstream)
    return { mode: "publish", label: "Publish branch", icon: Upload, gated: false };
  if (s.behind > 0 && s.ahead > 0)
    return { mode: "sync", label: "Sync", icon: RefreshCw, gated: true };
  if (s.behind > 0)
    return { mode: "pull", label: `Pull ${s.behind}`, icon: ArrowDown, gated: true };
  if (s.ahead > 0)
    return { mode: "push", label: `Push ${s.ahead}`, icon: ArrowUp, gated: false };
  return { mode: "fetch", label: "Fetch", icon: RefreshCw, gated: false };
}

/**
 * Status popup anchored above the status bar's changes item. Shows the current
 * branch with its ahead/behind state, Pull/Push actions driven by those counts,
 * and a scrollable list of working-tree changes. Pull is gated against
 * uncommitted changes (a dirty tree raises a dialog) just like branch switching;
 * push is allowed regardless since committed work pushes fine with a dirty tree.
 */
export function GitStatusPopup({
  path,
  anchor,
  onClose,
  onChanged,
}: {
  path: string;
  /** Viewport rect of the changes item the popup hangs above. */
  anchor: DOMRect;
  onClose: () => void;
  /** Fired after a pull/push so the status bar can re-poll. */
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  // Subjects of the commits a push would send, newest first.
  const [commits, setCommits] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set to the dialog message when a pull is blocked by local changes.
  const [dirtyMessage, setDirtyMessage] = useState<React.ReactNode | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    // Refresh the unpushed commit list alongside the status; a failure here just
    // empties the list rather than surfacing as a popup-wide error.
    void gitUnpushedCommits(path)
      .then(setCommits)
      .catch(() => setCommits([]));
    return gitStatus(path)
      .then((s) => {
        setStatus(s);
        return s;
      })
      .catch((e) => {
        setError(String(e));
        return null;
      });
  }, [path]);

  // Load once on open. The status bar keeps polling behind the popup, but the
  // popup reads its own copy so the file list and counts stay self-consistent.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Close on outside click / Escape — suspended while the dirty dialog is up so
  // dismissing it doesn't also tear down the popup behind it.
  useEffect(() => {
    if (dirtyMessage !== null) return;
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
  }, [onClose, dirtyMessage]);

  const run = async (action: SyncAction) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // A pull/sync rewrites the working tree, so re-check right before acting
      // (the tree may have changed since the popup opened) and block on local
      // edits rather than risk an aborted merge — the same gate as switching.
      if (action.gated) {
        const fresh = await gitStatus(path);
        setStatus(fresh);
        if (fresh.files.length > 0) {
          setDirtyMessage(
            <>
              You have uncommitted changes in this project. Commit or stash them
              before {action.mode === "sync" ? "syncing with" : "pulling from"}{" "}
              <span className="text-fg">the upstream branch</span>.
            </>,
          );
          return;
        }
      }
      switch (action.mode) {
        case "pull":
          await gitPull(path);
          break;
        case "push":
        case "publish":
          await gitPush(path);
          break;
        case "sync":
          await gitPull(path);
          await gitPush(path);
          break;
        case "fetch":
          await gitFetch(path);
          break;
      }
      await refresh();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Hang the popup above the changes item, clamped so its full width stays on
  // screen (the changes item sits mid-bar, not pinned to the left edge).
  const WIDTH = 288; // w-72
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - WIDTH - 8);
  const bottom = window.innerHeight - anchor.top + 6;

  const files = status?.files ?? [];
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const hasUpstream = status?.hasUpstream ?? false;
  const action = status ? syncAction(status) : null;

  return (
    <>
      <div
        ref={rootRef}
        className="fixed z-[80] flex max-h-[360px] w-72 flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated text-[13px] shadow-2xl"
        style={{ left, bottom }}
      >
        {/* Header: branch + ahead/behind */}
        <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
          <GitBranch size={13} strokeWidth={1.8} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-fg" title={status?.branch ?? undefined}>
            {status?.branch ?? (status?.detached ? "detached HEAD" : "—")}
          </span>
          {hasUpstream && (behind > 0 || ahead > 0) && (
            <span className="flex shrink-0 items-center gap-1.5 text-fg-faint">
              {behind > 0 && (
                <span className="flex items-center gap-0.5" title={`${behind} behind upstream`}>
                  <ArrowDown size={12} strokeWidth={1.8} />
                  {behind}
                </span>
              )}
              {ahead > 0 && (
                <span className="flex items-center gap-0.5" title={`${ahead} ahead of upstream`}>
                  <ArrowUp size={12} strokeWidth={1.8} />
                  {ahead}
                </span>
              )}
            </span>
          )}
        </div>

        {/* Single contextual sync action (GitHub Desktop style). */}
        <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
          {action ? (
            <>
              <SyncButton
                label={action.label}
                icon={action.icon}
                busy={busy}
                disabled={busy}
                onClick={() => void run(action)}
              />
              {action.mode === "fetch" && (
                <span className="text-[12px] text-fg-faint">Up to date</span>
              )}
            </>
          ) : (
            <span className="text-[12px] text-fg-faint">No remote configured</span>
          )}
        </div>

        {/* Commits the current push/sync would send, one subject per line. */}
        {commits.length > 0 && (
          <div className="max-h-28 shrink-0 overflow-y-auto border-b border-border px-2.5 py-1.5">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-fg-faint">
              {commits.length} commit{commits.length === 1 ? "" : "s"} to push
            </div>
            {commits.map((msg, i) => (
              <div
                key={i}
                className="truncate py-0.5 text-[12px] text-fg-subtle"
                title={msg}
              >
                {msg}
              </div>
            ))}
          </div>
        )}

        {/* Scrollable file list */}
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {files.length === 0 ? (
            <div className="px-2 py-3 text-center text-fg-faint">No changes</div>
          ) : (
            files.map((f) => {
              const cat = fileCategory(f);
              const Icon = CATEGORY_ICON[cat];
              return (
                <div
                  key={f.path}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-fg-subtle"
                  title={f.path}
                >
                  <Icon
                    size={13}
                    strokeWidth={1.8}
                    className="shrink-0"
                    style={{ color: CATEGORY_COLOR[cat] }}
                  />
                  <span className="min-w-0 flex-1 truncate" dir="rtl">
                    {f.path}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {error && (
          <div className="border-t border-border px-2.5 py-1.5 text-[12px] text-red-400">
            {error}
          </div>
        )}
      </div>

      {dirtyMessage !== null && (
        <DirtyDialog message={dirtyMessage} onClose={() => setDirtyMessage(null)} />
      )}
    </>
  );
}

/** A compact pull/push action button with a spinner while its action runs. */
function SyncButton({
  label,
  icon: Icon,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] text-fg-subtle outline-none transition-colors",
        "hover:bg-bg-hover hover:text-fg disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-fg-subtle",
      )}
    >
      {busy ? (
        <Loader2 size={12} strokeWidth={1.8} className="shrink-0 animate-spin" />
      ) : (
        <Icon size={12} strokeWidth={1.8} className="shrink-0" />
      )}
      {label}
    </button>
  );
}
