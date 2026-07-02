import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, ChevronRight, Loader2, Regex, SlidersHorizontal } from "lucide-react";

import { searchProject, type SearchMatch, type SearchResults } from "@/lib/tauri";
import { openProjectFile } from "@/lib/lsp/monacoBridge";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "@/components/FileTypeIcon";

/** Debounce between the last keystroke and the search request. */
const DEBOUNCE_MS = 250;

interface FileGroup {
  path: string;
  matches: SearchMatch[];
}

/** Group the flat, path-sorted match list by file. */
function groupByFile(matches: SearchMatch[]): FileGroup[] {
  const groups: FileGroup[] = [];
  for (const m of matches) {
    const last = groups[groups.length - 1];
    if (last && last.path === m.path) last.matches.push(m);
    else groups.push({ path: m.path, matches: [m] });
  }
  return groups;
}

/** A result line with its match ranges highlighted. */
function HighlightedLine({ text, spans }: { text: string; spans: [number, number][] }) {
  const parts = useMemo(() => {
    const out: { text: string; hit: boolean }[] = [];
    let pos = 0;
    for (const [start, end] of spans) {
      if (start > pos) out.push({ text: text.slice(pos, start), hit: false });
      out.push({ text: text.slice(start, end), hit: true });
      pos = end;
    }
    if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
    return out;
  }, [text, spans]);

  return (
    <span className="whitespace-pre">
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-[2px] bg-accent/25 text-inherit">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}

/**
 * Full-repo content search tab (Mod+Shift+F). A debounced query runs ripgrep's
 * engine over the project (respecting .gitignore); results are grouped by file
 * and clicking a line opens the file at that match. Include/exclude glob
 * filters and regex/case toggles mirror VS Code's search.
 *
 * Kept mounted across tab switches (like GitPanel) so the query, options, and
 * results survive; `focusNonce` refocuses the input when the tab is (re)opened
 * via the shortcut.
 */
export function SearchPanel({
  root,
  active,
  focusNonce,
  onOpenFile,
}: {
  root: string;
  active: boolean;
  focusNonce: number;
  /** Open a file tab for `rel` (the reveal itself rides the monacoBridge). */
  onOpenFile: (rel: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Discards responses of superseded requests (out-of-order resolution).
  const requestSeq = useRef(0);

  // Focus the query input whenever the tab is opened/re-focused via Mod+Shift+F
  // (and on first mount, since opening the tab makes it active).
  useEffect(() => {
    if (active) inputRef.current?.select();
  }, [active, focusNonce]);

  // Debounced search over (query, options). Cleared results for a cleared query.
  useEffect(() => {
    if (!query) {
      setResults(null);
      setError(null);
      setSearching(false);
      return;
    }
    const seq = ++requestSeq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      searchProject(root, query, { regex: useRegex, caseSensitive, include, exclude })
        .then((r) => {
          if (requestSeq.current !== seq) return;
          setResults(r);
          setError(null);
          setCollapsed(new Set());
          setSearching(false);
        })
        .catch((e) => {
          if (requestSeq.current !== seq) return;
          setError(String(e));
          setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [root, query, useRegex, caseSensitive, include, exclude]);

  const openMatch = useCallback(
    (m: SearchMatch) => {
      const col = (m.spans[0]?.[0] ?? 0) + 1;
      // With an editor mounted this stashes the reveal and raises the file tab
      // (the registered handler calls the app's openFile); otherwise the
      // fallback opens the tab and the reveal replays when the editor mounts.
      openProjectFile(
        root,
        m.path,
        { lineNumber: m.line, column: col },
        () => onOpenFile(m.path),
      );
    },
    [root, onOpenFile],
  );

  const groups = useMemo(
    () => (results ? groupByFile(results.matches) : []),
    [results],
  );

  const toggleGroup = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const optionButton = (
    pressed: boolean,
    onClick: () => void,
    title: string,
    children: React.ReactNode,
  ) => (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded",
        pressed
          ? "bg-accent/20 text-accent"
          : "text-fg-faint hover:bg-bg-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Query row */}
      <div className="shrink-0 space-y-2 border-b border-border-subtle p-3">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-bg-elevated px-2 py-1 focus-within:border-accent/60">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            spellCheck={false}
            className="h-6 min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-faint"
          />
          {searching && (
            <Loader2 size={13} strokeWidth={2} className="shrink-0 animate-spin text-fg-faint" />
          )}
          {optionButton(caseSensitive, () => setCaseSensitive((v) => !v), "Match case", (
            <CaseSensitive size={14} strokeWidth={1.8} />
          ))}
          {optionButton(useRegex, () => setUseRegex((v) => !v), "Use regular expression", (
            <Regex size={13} strokeWidth={1.8} />
          ))}
          {optionButton(filtersOpen, () => setFiltersOpen((v) => !v), "Include/exclude files", (
            <SlidersHorizontal size={13} strokeWidth={1.8} />
          ))}
        </div>

        {filtersOpen && (
          <div className="space-y-1.5">
            <input
              value={include}
              onChange={(e) => setInclude(e.target.value)}
              placeholder="Files to include (e.g. src/**/*.ts, *.rs)"
              spellCheck={false}
              className="h-6 w-full rounded-md border border-border bg-bg-elevated px-2 text-[12px] text-fg outline-none placeholder:text-fg-faint focus:border-accent/60"
            />
            <input
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
              placeholder="Files to exclude (e.g. *.test.ts, vendor/**)"
              spellCheck={false}
              className="h-6 w-full rounded-md border border-border bg-bg-elevated px-2 text-[12px] text-fg outline-none placeholder:text-fg-faint focus:border-accent/60"
            />
          </div>
        )}

        {/* Status line */}
        {error ? (
          <p className="text-[12px] leading-relaxed text-red-400">{error}</p>
        ) : results ? (
          <p className="text-[12px] text-fg-faint">
            {results.matches.length === 0
              ? "No results."
              : `${results.matches.length}${results.truncated ? "+" : ""} result${
                  results.matches.length === 1 ? "" : "s"
                } in ${results.files} file${results.files === 1 ? "" : "s"}`}
            {results.truncated && " — refine the search to see the rest"}
          </p>
        ) : null}
      </div>

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.path);
          return (
            <div key={g.path}>
              <button
                type="button"
                onClick={() => toggleGroup(g.path)}
                className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[13px] text-fg hover:bg-bg-hover"
                title={g.path}
              >
                <ChevronRight
                  size={12}
                  strokeWidth={2}
                  className={cn(
                    "shrink-0 text-fg-faint transition-transform",
                    !isCollapsed && "rotate-90",
                  )}
                />
                <FileTypeIcon path={g.path} size={14} className="shrink-0" />
                <span className="min-w-0 truncate">{g.path}</span>
                <span className="ml-auto shrink-0 rounded-full bg-bg-active px-1.5 text-[11px] text-fg-faint">
                  {g.matches.length}
                </span>
              </button>
              {!isCollapsed &&
                g.matches.map((m) => (
                  <button
                    key={`${m.path}:${m.line}`}
                    type="button"
                    onClick={() => openMatch(m)}
                    className="flex w-full items-baseline gap-2 py-0.5 pl-9 pr-3 text-left font-mono text-[12px] text-fg-subtle hover:bg-bg-hover hover:text-fg"
                  >
                    <span className="w-8 shrink-0 text-right tabular-nums text-fg-faint">
                      {m.line}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <HighlightedLine text={m.text} spans={m.spans} />
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
