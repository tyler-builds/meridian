import { useEffect, useMemo, useRef, useState } from "react";
import { Check, GitBranch, Loader2, Plus, TriangleAlert } from "lucide-react";

import {
  gitBranches,
  gitCheckout,
  gitStatus,
  jiraResolveBranch,
} from "@/lib/tauri";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * Match a Jira-style issue key and normalize the project part to uppercase
 * (`abc-12` → `ABC-12`), or null if it isn't one. Project keys are 2–10
 * alphanumeric chars starting with a letter; an issue number follows the dash.
 * Mirrors the backend's `normalize_key` so the UI gates on the same shape.
 */
function matchIssueKey(input: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/.exec(input.trim());
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

/** State of the async issue-key → branch-name lookup. */
type Resolved =
  | { loading: true }
  | { loading: false; branch: string; summary: string }
  | { loading: false; error: string };

/**
 * Branch switcher popup anchored above the status bar's branch item. Type to
 * filter, arrow keys to move, Enter to switch. When the filter matches nothing,
 * Enter creates a new branch of that name and checks it out — unless the working
 * tree is dirty, in which case a dialog asks the user to deal with changes first.
 */
export function BranchSwitcher({
  path,
  current,
  anchor,
  onClose,
  onSwitched,
}: {
  path: string;
  current: string | null;
  /** Viewport rect of the branch item the popup hangs above. */
  anchor: DOMRect;
  onClose: () => void;
  onSwitched: () => void;
}) {
  const { jira } = useSettings();
  const [branches, setBranches] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Resolved | null>(null);
  // Set to the attempted action when a switch/create is blocked by local changes.
  const [dirtyAction, setDirtyAction] = useState<
    { branch: string; create: boolean } | null
  >(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load the branch list once.
  useEffect(() => {
    let active = true;
    gitBranches(path)
      .then((b) => {
        if (active) setBranches(b);
      })
      .catch(() => {
        if (active) setBranches([]);
      });
    return () => {
      active = false;
    };
  }, [path]);

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    const q = trimmed.toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.toLowerCase().includes(q));
  }, [branches, trimmed]);

  // An exact (case-insensitive) match means Enter switches rather than creates.
  const exactExists = useMemo(
    () => branches.some((b) => b.toLowerCase() === trimmed.toLowerCase()),
    [branches, trimmed],
  );
  const canCreate = trimmed.length > 0 && !exactExists;

  // When the query is an issue key and Jira is connected, offer a "create from
  // Jira" row instead of the plain create row (and resolve the branch name).
  const issueKey = useMemo(() => matchIssueKey(trimmed), [trimmed]);
  const jiraApplicable = !!issueKey && !!jira?.connected && !exactExists;
  const showCreateRow = canCreate && filtered.length === 0 && !jiraApplicable;

  // Combined, keyboard-navigable rows: the Jira row (when applicable) sits above
  // the matching branches so it's the default Enter action.
  type Row = { kind: "jira" } | { kind: "branch"; name: string };
  const items = useMemo<Row[]>(() => {
    const rows: Row[] = [];
    if (jiraApplicable) rows.push({ kind: "jira" });
    for (const b of filtered) rows.push({ kind: "branch", name: b });
    return rows;
  }, [jiraApplicable, filtered]);

  // Debounced lookup of the issue summary → branch name while it's an issue key.
  useEffect(() => {
    if (!jiraApplicable || !issueKey) {
      setResolved(null);
      return;
    }
    setResolved({ loading: true });
    let active = true;
    const t = setTimeout(() => {
      jiraResolveBranch(issueKey)
        .then((r) => {
          if (active)
            setResolved({ loading: false, branch: r.branch, summary: r.summary });
        })
        .catch((e) => {
          if (active) setResolved({ loading: false, error: String(e) });
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [jiraApplicable, issueKey]);

  // Keep the selection in range as the row set narrows.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items.length]);

  // Scroll the highlighted row into view as the selection moves.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Close on outside click. Suspended while the dirty dialog is up so clicking
  // it doesn't also tear down the switcher behind it.
  useEffect(() => {
    if (dirtyAction !== null) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose, dirtyAction]);

  // Switch to (or create + switch to) a branch. Either way, a dirty working tree
  // is committed/stashed first — uncommitted changes block the action and raise
  // the dialog rather than risk git carrying them across or refusing mid-checkout.
  const attempt = async (branch: string, create: boolean) => {
    if (!create && branch === current) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const status = await gitStatus(path);
      if (status.files.length > 0) {
        setDirtyAction({ branch, create });
        setBusy(false);
        return;
      }
      await gitCheckout(path, branch, create);
      onSwitched();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  // Create + switch to the branch for the typed issue key. Prefer the resolved
  // Jira name; if the lookup hasn't finished, resolve once more on demand, and
  // if Jira can't resolve it (not found / offline), fall back to the bare key.
  const createFromJira = async () => {
    if (!issueKey || busy) return;
    let branch =
      resolved && !resolved.loading
        ? "branch" in resolved
          ? resolved.branch
          : issueKey
        : undefined;
    if (!branch) {
      try {
        branch = (await jiraResolveBranch(issueKey)).branch;
      } catch {
        branch = issueKey;
      }
    }
    await attempt(branch, true);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, items.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (busy) return;
      const item = items[Math.min(selected, items.length - 1)];
      if (item?.kind === "branch") {
        void attempt(item.name, false);
      } else if (item?.kind === "jira") {
        void createFromJira();
      } else if (canCreate) {
        void attempt(trimmed, true);
      }
    }
  };

  // Hang the popup above the branch item, clamped to the viewport's left edge.
  const left = Math.max(8, anchor.left);
  const bottom = window.innerHeight - anchor.top + 6;

  return (
    <>
      <div
        ref={rootRef}
        className="fixed z-[80] flex max-h-[320px] w-64 flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated text-[13px] shadow-2xl"
        style={{ left, bottom }}
      >
        <div className="border-b border-border p-1.5">
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Switch or create branch…"
            spellCheck={false}
            className="w-full rounded-md bg-bg px-2 py-1.5 text-fg placeholder:text-fg-faint outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
          {items.map((item, i) => {
            const isSel = i === selected;
            if (item.kind === "jira") {
              return (
                <JiraRow
                  key="__jira__"
                  index={i}
                  issueKey={issueKey as string}
                  resolved={resolved}
                  selected={isSel}
                  onHover={() => setSelected(i)}
                  onClick={() => void createFromJira()}
                />
              );
            }
            const b = item.name;
            const isCurrent = b === current;
            return (
              <button
                key={b}
                type="button"
                data-index={i}
                onMouseEnter={() => setSelected(i)}
                onClick={() => void attempt(b, false)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none",
                  isSel ? "bg-bg-hover text-fg" : "text-fg-subtle",
                )}
              >
                <GitBranch size={13} strokeWidth={1.8} className="shrink-0 text-fg-faint" />
                <span className="min-w-0 flex-1 truncate">{b}</span>
                {isCurrent && (
                  <Check size={13} strokeWidth={2} className="shrink-0 text-accent" />
                )}
              </button>
            );
          })}

          {showCreateRow && (
            <button
              type="button"
              onClick={() => void attempt(trimmed, true)}
              className="flex w-full items-center gap-2 rounded-md bg-bg-hover px-2 py-1.5 text-left text-fg outline-none"
            >
              <Plus size={13} strokeWidth={2} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">
                Create branch <span className="text-fg">“{trimmed}”</span>
              </span>
            </button>
          )}

          {items.length === 0 && !showCreateRow && (
            <div className="px-2 py-3 text-center text-fg-faint">
              {branches.length === 0 ? "No branches" : "No matching branches"}
            </div>
          )}
        </div>

        {error && (
          <div className="border-t border-border px-2.5 py-1.5 text-[12px] text-red-400">
            {error}
          </div>
        )}
      </div>

      {dirtyAction !== null && (
        <DirtyDialog
          onClose={() => setDirtyAction(null)}
          message={
            <>
              You have uncommitted changes in this project. Commit or stash them
              before{" "}
              {dirtyAction.create ? "creating the new branch" : "switching to"}{" "}
              <span className="text-fg">“{dirtyAction.branch}”</span>.
            </>
          }
        />
      )}
    </>
  );
}

/**
 * The "create a branch from this Jira issue" row. Shows the resolution state:
 * a spinner while looking the key up, the resolved Jira-style branch name once
 * known, or — when Jira can't resolve it — a note that Enter still creates a
 * branch named after the bare key.
 */
function JiraRow({
  index,
  issueKey,
  resolved,
  selected,
  onHover,
  onClick,
}: {
  index: number;
  issueKey: string;
  resolved: Resolved | null;
  selected: boolean;
  onHover: () => void;
  onClick: () => void;
}) {
  const loading = !resolved || resolved.loading;
  const error = resolved && !resolved.loading && "error" in resolved;
  const branch =
    resolved && !resolved.loading && "branch" in resolved ? resolved.branch : null;
  const summary =
    resolved && !resolved.loading && "summary" in resolved
      ? resolved.summary
      : null;

  return (
    <button
      type="button"
      data-index={index}
      onMouseEnter={onHover}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none",
        selected ? "bg-bg-hover" : "",
      )}
    >
      <span className="mt-0.5 shrink-0">
        {loading ? (
          <Loader2 size={13} strokeWidth={2} className="animate-spin text-fg-faint" />
        ) : error ? (
          <TriangleAlert size={13} strokeWidth={2} className="text-amber-400" />
        ) : (
          <Plus size={13} strokeWidth={2} className="text-accent" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {loading ? (
          <span className="truncate text-fg-subtle">
            Looking up <span className="font-mono text-fg">{issueKey}</span> in Jira…
          </span>
        ) : branch ? (
          <>
            <span className="truncate text-fg">
              Create <span className="font-mono">{branch}</span>
            </span>
            {summary && (
              <span className="truncate text-xs text-fg-faint">{summary}</span>
            )}
          </>
        ) : (
          <>
            <span className="truncate text-fg-subtle">
              Create branch <span className="font-mono text-fg">“{issueKey}”</span>
            </span>
            <span className="truncate text-xs text-amber-400/80">
              {resolved && !resolved.loading && "error" in resolved
                ? resolved.error
                : "Couldn't reach Jira"}
            </span>
          </>
        )}
      </span>
    </button>
  );
}

/**
 * Blocks an action that can't run while the working tree has uncommitted
 * changes (branch switch/create, pull). `message` describes the blocked action;
 * dismissing it returns to the popup so the user can commit or stash first.
 */
export function DirtyDialog({
  message,
  onClose,
}: {
  message: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[400px] max-w-[calc(100vw-32px)] rounded-xl border border-border bg-bg-elevated p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-medium text-fg">Uncommitted changes</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-subtle">
          {message}
        </p>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="h-8 rounded-md bg-fg px-3 text-[13px] font-medium text-bg transition-colors hover:bg-fg/90 active:bg-fg/80"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
