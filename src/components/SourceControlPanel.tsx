import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  GitBranch,
  Minus,
  Plus,
} from "lucide-react";

import {
  gitCommit,
  gitPush,
  gitStage,
  gitStatus,
  gitUnstage,
  type GitFile,
  type GitStatus,
} from "@/lib/tauri";
import { DIFF_ADDITION_COLOR, DIFF_DELETION_COLOR } from "@/lib/diffTheme";
import { Button } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/FileTypeIcon";

type Busy = null | "stage" | "commit" | "push";

/** Single-letter status badge (color-coded) for a file's git status code. */
function statusBadge(code: string): { letter: string; color: string; title: string } {
  switch (code) {
    case "M":
      return { letter: "M", color: "#d29922", title: "Modified" };
    case "A":
      return { letter: "A", color: DIFF_ADDITION_COLOR, title: "Added" };
    case "D":
      return { letter: "D", color: DIFF_DELETION_COLOR, title: "Deleted" };
    case "R":
      return { letter: "R", color: "#539bf5", title: "Renamed" };
    case "C":
      return { letter: "C", color: "#539bf5", title: "Copied" };
    case "?":
      return { letter: "U", color: DIFF_ADDITION_COLOR, title: "Untracked" };
    case "U":
      return { letter: "U", color: "#e0823d", title: "Conflict" };
    default:
      return { letter: code.trim() || "•", color: "#a1a1a1", title: "Changed" };
  }
}

/** Basename for the row label; the full path is the row title. */
function basename(path: string): string {
  const trimmed = path.replace(/\/$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function FileRow({
  file,
  code,
  actionIcon,
  actionTitle,
  onAction,
  onSelect,
  disabled,
}: {
  file: GitFile;
  code: string;
  actionIcon: React.ReactNode;
  actionTitle: string;
  onAction: () => void;
  onSelect: () => void;
  disabled: boolean;
}) {
  const badge = statusBadge(code);
  const dir = file.path.includes("/")
    ? file.path.slice(0, file.path.replace(/\/$/, "").lastIndexOf("/"))
    : "";

  return (
    <div
      onClick={onSelect}
      title={file.path}
      className="group flex h-7 cursor-default items-center gap-1.5 rounded-md px-2 text-[12px] text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
    >
      <FileTypeIcon path={file.path} size={13} className="shrink-0" />
      <span className="truncate">{basename(file.path)}</span>
      {dir && (
        <span className="truncate text-[11px] text-fg-faint">{dir}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1 pl-1">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAction();
          }}
          disabled={disabled}
          title={actionTitle}
          aria-label={actionTitle}
          className="flex h-5 w-5 items-center justify-center rounded text-fg-faint opacity-0 transition hover:bg-bg-active hover:text-fg group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
        >
          {actionIcon}
        </button>
        <span
          className="w-3 text-center font-medium tabular-nums"
          style={{ color: badge.color }}
          title={badge.title}
        >
          {badge.letter}
        </span>
      </span>
    </div>
  );
}

function GroupHeader({
  label,
  count,
  actionLabel,
  onAction,
  disabled,
}: {
  label: string;
  count: number;
  actionLabel: string;
  onAction: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex h-7 items-center gap-2 px-2 text-[11px] font-medium uppercase tracking-wide text-fg-faint">
      <span>{label}</span>
      <span className="tabular-nums">{count}</span>
      <button
        onClick={onAction}
        disabled={disabled}
        className="ml-auto rounded px-1.5 py-0.5 text-[11px] normal-case tracking-normal text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30"
      >
        {actionLabel}
      </button>
    </div>
  );
}

/**
 * Source Control panel for the Git tab: staged / unstaged file lists with
 * stage-unstage actions, a commit message box, and a primary action that
 * morphs between Commit and Push.
 *
 * Button logic (confirmed): with staged changes and a message it Commits; with
 * nothing staged but local commits to push (ahead of the upstream, or commits
 * on a branch with a remote but no upstream yet) it Pushes — the first push
 * sets the upstream automatically. Otherwise the action is disabled.
 *
 * `reloadNonce` (from GitPanel) re-fetches status on tab-activate, window-focus,
 * and after a sibling action. `onChanged` bumps that signal so the diff and
 * this panel refresh together after staging/commit/push. `onSelectFile` scrolls
 * the diff to a clicked file.
 */
export function SourceControlPanel({
  root,
  reloadNonce,
  onChanged,
  onSelectFile,
}: {
  root: string;
  reloadNonce: number;
  onChanged: () => void;
  onSelectFile: (path: string) => void;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    try {
      const s = await gitStatus(root);
      if (reqRef.current === req) {
        setStatus(s);
        setError(null);
      }
    } catch (err) {
      if (reqRef.current === req) {
        setStatus(null);
        setError(String(err));
      }
    }
  }, [root]);

  useEffect(() => {
    void load();
  }, [load, reloadNonce]);

  // Run a mutating git action, then signal a shared refresh (which re-fetches
  // both this panel and the diff). Errors surface inline.
  const run = useCallback(
    async (kind: Busy, fn: () => Promise<void>) => {
      setBusy(kind);
      setError(null);
      try {
        await fn();
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(null);
        onChanged();
      }
    },
    [onChanged],
  );

  const staged = useMemo(
    () => (status ? status.files.filter((f) => f.staged) : []),
    [status],
  );
  // Anything with a working-tree change (a non-space worktree code), which
  // includes untracked ("?"). A file edited in both index and tree appears here
  // and under staged.
  const changes = useMemo(
    () => (status ? status.files.filter((f) => f.worktree !== " ") : []),
    [status],
  );

  const hasStaged = staged.length > 0;
  const detached = status?.detached ?? false;
  // Local commits that aren't on the remote: ahead of upstream, or commits on a
  // branch that has a remote but no upstream set yet (the first-push case).
  const unpushed =
    !!status &&
    !detached &&
    (status.ahead > 0 ||
      (status.hasCommits && status.hasRemote && !status.hasUpstream));
  const mode: "commit" | "push" = hasStaged ? "commit" : unpushed ? "push" : "commit";

  const canCommit = hasStaged && message.trim().length > 0 && busy === null;
  const canPush = mode === "push" && busy === null;

  const stage = (files: string[]) => run("stage", () => gitStage(root, files));
  const unstage = (files: string[]) =>
    run("stage", () => gitUnstage(root, files));
  const commit = () =>
    run("commit", async () => {
      await gitCommit(root, message);
      setMessage("");
    });
  const push = () => run("push", () => gitPush(root));

  const buttonLabel =
    busy === "commit"
      ? "Committing…"
      : busy === "push"
        ? "Pushing…"
        : mode === "push"
          ? "Push"
          : "Commit";

  return (
    <div className="flex h-full flex-col border-l border-border-subtle bg-bg">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <GitBranch size={14} strokeWidth={1.8} className="shrink-0 text-fg-faint" />
        <span className="truncate text-[12px] text-fg-subtle">
          {detached
            ? "Detached HEAD"
            : (status?.branch ?? "Source Control")}
        </span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-fg-faint">
            {status.ahead > 0 && (
              <span className="flex items-center gap-0.5" title="Commits to push">
                <ArrowUp size={11} strokeWidth={2} />
                {status.ahead}
              </span>
            )}
            {status.behind > 0 && (
              <span
                className="flex items-center gap-0.5"
                title="Commits behind the remote"
              >
                <ArrowDown size={11} strokeWidth={2} />
                {status.behind}
              </span>
            )}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error ? (
          <p className="px-3 py-2 text-[12px] text-fg-subtle">{error}</p>
        ) : !status ? (
          <p className="px-3 py-2 text-[12px] text-fg-faint">Loading…</p>
        ) : staged.length === 0 && changes.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-fg-faint">
            No changes in the working tree.
          </p>
        ) : (
          <>
            {staged.length > 0 && (
              <section>
                <GroupHeader
                  label="Staged Changes"
                  count={staged.length}
                  actionLabel="Unstage all"
                  onAction={() => unstage(staged.map((f) => f.path))}
                  disabled={busy !== null}
                />
                <div className="px-1">
                  {staged.map((file) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      code={file.index}
                      actionIcon={<Minus size={13} strokeWidth={2} />}
                      actionTitle="Unstage"
                      onAction={() => unstage([file.path])}
                      onSelect={() => onSelectFile(file.path)}
                      disabled={busy !== null}
                    />
                  ))}
                </div>
              </section>
            )}

            {changes.length > 0 && (
              <section>
                <GroupHeader
                  label="Changes"
                  count={changes.length}
                  actionLabel="Stage all"
                  onAction={() => stage(changes.map((f) => f.path))}
                  disabled={busy !== null}
                />
                <div className="px-1">
                  {changes.map((file) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      code={file.untracked ? "?" : file.worktree}
                      actionIcon={<Plus size={13} strokeWidth={2} />}
                      actionTitle="Stage"
                      onAction={() => stage([file.path])}
                      onSelect={() => onSelectFile(file.path)}
                      disabled={busy !== null}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-border-subtle p-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={detached ? "Commit message (detached HEAD)" : "Commit message"}
          rows={3}
          spellCheck={false}
          disabled={busy !== null}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter commits, matching common editors.
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canCommit) {
              e.preventDefault();
              commit();
            }
          }}
          className="w-full resize-none rounded-md border border-border bg-bg-elevated px-2 py-1.5 text-[12px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-60"
        />
        <Button
          size="sm"
          className="mt-2 w-full"
          disabled={mode === "push" ? !canPush : !canCommit}
          onClick={mode === "push" ? push : commit}
        >
          {mode === "push" ? (
            <ArrowUp size={14} strokeWidth={2} />
          ) : (
            <Check size={14} strokeWidth={2} />
          )}
          {buttonLabel}
        </Button>
      </div>
    </div>
  );
}
