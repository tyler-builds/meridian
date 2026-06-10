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

  // Mirror the active editor tab into the tree selection. Clearing the
  // selection when a file is closed lets clicking it again re-open it.
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
  }, [activeRelPath]);

  return (
    <div className="h-full overflow-hidden text-[13px]">
      <FileTree model={model} style={{ ...TREE_STYLE, height: "100%" }} />
    </div>
  );
}
