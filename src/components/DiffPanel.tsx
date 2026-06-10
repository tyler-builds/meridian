import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { PatchDiff } from "@pierre/diffs/react";
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  GitCompare,
  Pilcrow,
  Rows2,
  WrapText,
} from "lucide-react";

import { gitDiff } from "@/lib/tauri";
import {
  DIFF_ADDITION_COLOR,
  DIFF_DELETION_COLOR,
  DIFF_THEME,
} from "@/lib/diffTheme";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "@/components/FileTypeIcon";

interface DiffFileInfo {
  /** Display path (the new path, falling back to the old path for deletions). */
  path: string;
  additions: number;
  deletions: number;
  /** The single-file patch slice fed to one `PatchDiff`. */
  patch: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; files: DiffFileInfo[] }
  | { status: "error"; message: string };

type DiffOptions = ComponentProps<typeof PatchDiff>["options"];

/**
 * Split a multi-file unified git patch into per-file patch strings. Each file
 * section starts with a `diff --git ` line at column 0; content/hunk/metadata
 * lines never do, so the line-anchored lookahead split is safe.
 */
function splitPatchByFile(patch: string): string[] {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((section) => section.startsWith("diff --git "));
}

/** Parse a single-file patch slice into a path + add/remove line counts. */
function parseFile(chunk: string): DiffFileInfo {
  const lines = chunk.split("\n");
  let oldPath: string | undefined;
  let newPath: string | undefined;

  const git = lines[0].match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (git) {
    oldPath = git[1];
    newPath = git[2];
  }

  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") oldPath = p.replace(/^a\//, "");
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") newPath = p.replace(/^b\//, "");
    } else if (line.startsWith("+")) {
      additions++;
    } else if (line.startsWith("-")) {
      deletions++;
    }
  }

  return {
    path: newPath ?? oldPath ?? "unknown",
    additions,
    deletions,
    patch: chunk,
  };
}

/** A small icon toggle for the diff toolbar. */
function ToolButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-bg-elevated text-fg"
          : "text-fg-faint hover:bg-bg-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/** One collapsible file in the diff, with its own header and change counts. */
function DiffFile({
  info,
  options,
  collapsed,
  onToggle,
}: {
  info: DiffFileInfo;
  options: DiffOptions;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle">
      <button
        onClick={onToggle}
        title={info.path}
        className="flex h-8 w-full items-center gap-2 bg-bg-elevated px-2 text-left transition-colors hover:bg-bg-hover"
      >
        {collapsed ? (
          <ChevronRight size={14} strokeWidth={1.8} className="shrink-0 text-fg-faint" />
        ) : (
          <ChevronDown size={14} strokeWidth={1.8} className="shrink-0 text-fg-faint" />
        )}
        <FileTypeIcon path={info.path} size={14} className="shrink-0" />
        <span className="truncate text-[12px] text-fg">{info.path}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[11px] tabular-nums">
          {info.additions > 0 && (
            <span style={{ color: DIFF_ADDITION_COLOR }}>+{info.additions}</span>
          )}
          {info.deletions > 0 && (
            <span style={{ color: DIFF_DELETION_COLOR }}>−{info.deletions}</span>
          )}
        </span>
      </button>
      {!collapsed && (
        <div className="border-t border-border-subtle">
          <PatchDiff patch={info.patch} disableWorkerPool options={options} />
        </div>
      )}
    </div>
  );
}

/**
 * Renders the project's current git changes as a multi-file unified diff via
 * `@pierre/diffs`. The patch comes from the `git_diff` Rust command (tracked
 * staged + unstaged vs HEAD, plus untracked files). Refetches when the tab
 * becomes active and whenever the app window regains focus, so the view stays
 * current with edits made elsewhere.
 *
 * Toolbar controls: stacked (unified) vs split view, line wrapping, and ignore-
 * whitespace (the last re-runs git). Each file collapses independently.
 *
 * The worker pool is disabled so syntax highlighting runs on the main thread —
 * this avoids bundling a web worker into the Tauri webview and is fine for the
 * size of a typical working-tree diff.
 *
 * The owning `GitPanel` drives reloads via `reloadNonce` (bumped on tab-activate,
 * window-focus, and after staging/commit/push) and can scroll a file into view
 * via `focus` (when its row is clicked in the Source Control panel).
 */
export function DiffPanel({
  root,
  active,
  reloadNonce,
  focus,
}: {
  root: string;
  active: boolean;
  reloadNonce: number;
  focus: { path: string; nonce: number } | null;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [wrap, setWrap] = useState(false);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const reqRef = useRef(0);
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    try {
      const patch = await gitDiff(root, ignoreWhitespace);
      if (reqRef.current !== req) return;
      setState({ status: "ready", files: splitPatchByFile(patch).map(parseFile) });
    } catch (err) {
      if (reqRef.current === req)
        setState({ status: "error", message: String(err) });
    }
  }, [root, ignoreWhitespace]);

  // Load when the tab is active and on every reload signal from GitPanel, plus
  // whenever the whitespace option flips (which changes `load`'s identity).
  useEffect(() => {
    if (active) void load();
  }, [active, reloadNonce, load]);

  // Scroll a file into view (expanding it first) when its row is clicked in the
  // Source Control panel. Keyed on `focus.nonce` so re-clicking the same file
  // re-triggers the scroll.
  useEffect(() => {
    if (!focus) return;
    setCollapsed((prev) =>
      prev[focus.path] ? { ...prev, [focus.path]: false } : prev,
    );
    fileRefs.current[focus.path]?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [focus]);

  const options = useMemo<DiffOptions>(
    () => ({
      theme: DIFF_THEME,
      themeType: "dark",
      diffStyle,
      overflow: wrap ? "wrap" : "scroll",
      diffIndicators: "bars",
      // The panel renders its own collapsible file headers.
      disableFileHeader: true,
    }),
    [diffStyle, wrap],
  );

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));
  }, []);

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <GitCompare size={14} strokeWidth={1.8} className="text-fg-faint" />
        <span className="text-[12px] text-fg-subtle">Working tree changes</span>

        <div className="ml-auto flex items-center gap-1">
          <div className="flex items-center gap-0.5 rounded-md">
            <ToolButton
              active={diffStyle === "unified"}
              onClick={() => setDiffStyle("unified")}
              title="Stacked (unified) view"
            >
              <Rows2 size={14} strokeWidth={1.8} />
            </ToolButton>
            <ToolButton
              active={diffStyle === "split"}
              onClick={() => setDiffStyle("split")}
              title="Split view"
            >
              <Columns2 size={14} strokeWidth={1.8} />
            </ToolButton>
          </div>

          <span className="mx-0.5 h-4 w-px bg-border" />

          <ToolButton
            active={wrap}
            onClick={() => setWrap((w) => !w)}
            title="Wrap long lines"
          >
            <WrapText size={14} strokeWidth={1.8} />
          </ToolButton>
          <ToolButton
            active={ignoreWhitespace}
            onClick={() => setIgnoreWhitespace((w) => !w)}
            title="Ignore whitespace changes"
          >
            <Pilcrow size={14} strokeWidth={1.8} />
          </ToolButton>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === "loading" ? (
          <p className="px-3 py-2 text-[13px] text-fg-faint">Loading diff…</p>
        ) : state.status === "error" ? (
          <p className="px-3 py-2 text-[13px] text-fg-subtle">{state.message}</p>
        ) : state.files.length === 0 ? (
          <p className="px-3 py-2 text-[13px] text-fg-faint">
            No changes in the working tree.
          </p>
        ) : (
          <div className="flex flex-col gap-2 p-2">
            {state.files.map((info) => (
              <div
                key={info.path}
                ref={(el) => {
                  fileRefs.current[info.path] = el;
                }}
              >
                <DiffFile
                  info={info}
                  options={options}
                  collapsed={!!collapsed[info.path]}
                  onToggle={() => toggleCollapsed(info.path)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
