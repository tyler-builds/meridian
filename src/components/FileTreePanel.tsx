import { useEffect, useRef } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { themeToTreeStyles, type FileTree as FileTreeModel } from "@pierre/trees";

const TREE_STYLE = themeToTreeStyles({
  type: "dark",
  bg: "#1c1c1c",
  fg: "#e5e5e5",
  colors: {
    "foreground.muted": "#a1a1a1",
    "list.hoverBackground": "#2a2a2a",
    "list.activeSelectionBackground": "#2e2e2e",
    "list.activeSelectionForeground": "#e5e5e5",
  },
});

/** trees.software (@pierre/trees) file tree for a loaded project. */
export function FileTreePanel({
  paths,
  activeRelPath,
  onSelect,
}: {
  paths: string[];
  /** Active editor file (or null) — keeps the tree highlight in sync. */
  activeRelPath?: string | null;
  onSelect?: (path: string) => void;
}) {
  const modelRef = useRef<FileTreeModel | null>(null);
  const activeRef = useRef<string | null>(activeRelPath ?? null);
  activeRef.current = activeRelPath ?? null;

  const { model } = useFileTree({
    paths,
    icons: { set: "complete", colored: true },
    density: "compact",
    initialExpansion: 0,
    onSelectionChange: (selected) => {
      const path = selected[0];
      if (!path) return;
      // Selecting a folder expands it; only files open in the editor.
      if (modelRef.current?.getItem(path)?.isDirectory()) return;
      // The active file is already open; ignore re-selecting it (avoids the
      // programmatic sync below from reopening, and no-op clicks).
      if (path === activeRef.current) return;
      onSelect?.(path);
    },
  });
  modelRef.current = model;

  // `useFileTree` builds the model exactly once and intentionally ignores later
  // `paths` changes (see its source), so live updates from the FS watcher — App
  // hands us a fresh `paths` array on every add/delete/rename — won't show
  // unless we push them into the model with `resetPaths`. Preserve which folders
  // are expanded across the reset so an on-disk change doesn't collapse the tree
  // the user is working in.
  const prevPathsRef = useRef(paths);
  useEffect(() => {
    if (prevPathsRef.current === paths) return; // initial render, or no change
    const dirs = new Set<string>();
    for (const p of prevPathsRef.current) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i += 1) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    }
    const expanded: string[] = [];
    for (const d of dirs) {
      // getItem returns a file | directory union; only directories expand.
      const item = model.getItem(d);
      if (item && "isExpanded" in item && item.isExpanded()) expanded.push(d);
    }
    model.resetPaths(paths, { initialExpandedPaths: expanded });
    prevPathsRef.current = paths;
  }, [model, paths]);

  // Mirror the active editor tab into the tree selection. Clearing the
  // selection when a file is closed lets clicking it again re-open it. Also runs
  // after a `resetPaths` (paths changed), which drops the prior selection.
  useEffect(() => {
    const m = modelRef.current;
    if (!m) return;
    const current = m.getSelectedPaths();
    if (activeRelPath) {
      if (!(current.length === 1 && current[0] === activeRelPath)) {
        for (const p of current) {
          if (p !== activeRelPath) m.getItem(p)?.deselect();
        }
        m.getItem(activeRelPath)?.select();
      }
    } else {
      for (const p of current) m.getItem(p)?.deselect();
    }
  }, [activeRelPath, paths]);

  return (
    <div className="h-full overflow-hidden text-[13px]">
      <FileTree model={model} style={{ ...TREE_STYLE, height: "100%" }} />
    </div>
  );
}
