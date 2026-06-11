import { useEffect, useMemo, useRef, useState } from "react";
import { Check, GitBranch, Plus } from "lucide-react";

import { gitBranches, gitCheckout, gitStatus } from "@/lib/tauri";
import { cn } from "@/lib/utils";

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
  const [branches, setBranches] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const showCreateRow = canCreate && filtered.length === 0;

  // Keep the selection in range as the filter narrows.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
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
      if (filtered.length > 0) {
        const target = filtered[Math.min(selected, filtered.length - 1)];
        if (target) void attempt(target, false);
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
          {filtered.map((b, i) => {
            const isSel = i === selected;
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

          {filtered.length === 0 && !showCreateRow && (
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
          branch={dirtyAction.branch}
          create={dirtyAction.create}
          onClose={() => setDirtyAction(null)}
        />
      )}
    </>
  );
}

/** Blocks switching/creating while the working tree has uncommitted changes. */
function DirtyDialog({
  branch,
  create,
  onClose,
}: {
  branch: string;
  create: boolean;
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
          You have uncommitted changes in this project. Commit or stash them
          before {create ? "creating the new branch" : "switching to"}{" "}
          <span className="text-fg">“{branch}”</span>.
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
