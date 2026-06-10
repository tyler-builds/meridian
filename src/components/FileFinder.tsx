import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { fuzzyMatch } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "@/components/FileTypeIcon";

const MAX_RESULTS = 100;

interface Result {
  path: string;
  matches: number[];
}

function highlight(text: string, offset: number, matches: Set<number>) {
  return [...text].map((ch, i) =>
    matches.has(offset + i) ? (
      <span key={i} className="font-semibold text-fg">
        {ch}
      </span>
    ) : (
      <span key={i}>{ch}</span>
    ),
  );
}

/** VS Code-style "Go to File" fuzzy finder over the project's file list. */
export function FileFinder({
  paths,
  onClose,
  onSelect,
}: {
  paths: string[];
  onClose: () => void;
  onSelect: (relPath: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo<Result[]>(() => {
    if (!query.trim()) {
      return paths.slice(0, MAX_RESULTS).map((path) => ({ path, matches: [] }));
    }
    const scored: { path: string; score: number; matches: number[] }[] = [];
    for (const path of paths) {
      const m = fuzzyMatch(query, path);
      if (m) scored.push({ path, score: m.score, matches: m.matches });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.path.length - b.path.length ||
        a.path.localeCompare(b.path),
    );
    return scored.slice(0, MAX_RESULTS);
  }, [query, paths]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${index}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[index];
      if (r) onSelect(r.path);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-black/50 pt-[14vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[60vh] w-[600px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-3.5">
          <Search size={16} strokeWidth={1.8} className="shrink-0 text-fg-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search files by name…"
            spellCheck={false}
            className="h-full flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-faint"
          />
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-2.5 py-6 text-center text-[13px] text-fg-subtle">
              No matching files
            </p>
          ) : (
            results.map((r, i) => {
              const slash = r.path.lastIndexOf("/");
              const dir = slash >= 0 ? r.path.slice(0, slash) : "";
              const base = slash >= 0 ? r.path.slice(slash + 1) : r.path;
              const matchSet = new Set(r.matches);
              const active = i === index;
              return (
                <button
                  key={r.path}
                  data-index={i}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => onSelect(r.path)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                    active ? "bg-bg-active" : "hover:bg-bg-hover",
                  )}
                >
                  <FileTypeIcon path={r.path} size={15} className="shrink-0" />
                  <span className="truncate text-[13px] text-fg-subtle">
                    {highlight(base, slash + 1, matchSet)}
                  </span>
                  {dir && (
                    <span className="truncate text-[11px] text-fg-faint">
                      {highlight(dir, 0, matchSet)}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
