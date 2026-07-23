import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { FilePlus, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  themeToTreeStyles,
  type FileTree as FileTreeModel,
} from "@pierre/trees";
import type {
  ContextMenuItem as FileTreeContextMenuItem,
  ContextMenuOpenContext as FileTreeContextMenuOpenContext,
  FileTreeRenameEvent,
} from "@pierre/trees";

import { cn } from "@/lib/utils";
import { setObstruction } from "@/lib/nativeSurface";
import { pushToast } from "@/lib/toast";

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

/** Imperative API the sidebar header uses to start a root-level create. */
export interface FileTreeHandle {
  /** Begin inline creation of a file (in `dir`, or the project root). */
  newFile: (dir?: string) => void;
  /** Begin inline creation of a folder (in `dir`, or the project root). */
  newFolder: (dir?: string) => void;
}

/** Strip a single trailing slash — directory public ids may carry one. */
function noSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** The directory a create should target from a right-clicked row: inside a
 *  folder, or alongside a file. */
function targetDir(item: FileTreeContextMenuItem): string {
  const p = noSlash(item.path);
  if (item.kind === "directory") return p;
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/** trees.software (@pierre/trees) file tree for a loaded project. */
export const FileTreePanel = forwardRef<
  FileTreeHandle,
  {
    paths: string[];
    /** Active editor file (or null) — keeps the tree highlight in sync. */
    activeRelPath?: string | null;
    onSelect?: (path: string) => void;
    /** Create an empty file at the given project-relative path. */
    onCreateFile: (relPath: string) => Promise<void>;
    /** Create a directory at the given project-relative path. */
    onCreateFolder: (relPath: string) => Promise<void>;
    /** Rename/move a file or directory (project-relative paths). */
    onRenamePath: (from: string, to: string) => Promise<void>;
    /** Delete a file or directory (project-relative path). */
    onDeletePath: (relPath: string) => Promise<void>;
  }
>(function FileTreePanel(
  {
    paths,
    activeRelPath,
    onSelect,
    onCreateFile,
    onCreateFolder,
    onRenamePath,
    onDeletePath,
  },
  ref,
) {
  const modelRef = useRef<FileTreeModel | null>(null);
  const activeRef = useRef<string | null>(activeRelPath ?? null);
  activeRef.current = activeRelPath ?? null;
  // The paths currently reflected in the model (updated on each resetPaths
  // below). Used to tell a create placeholder from a real entry, and to keep new
  // names from colliding.
  const prevPathsRef = useRef(paths);

  // Latest handlers/paths, read from the tree's build-once callbacks below.
  const handlersRef = useRef({
    onSelect,
    onCreateFile,
    onCreateFolder,
    onRenamePath,
    onDeletePath,
  });
  handlersRef.current = {
    onSelect,
    onCreateFile,
    onCreateFolder,
    onRenamePath,
    onDeletePath,
  };

  // The library owns the context-menu open/close state for row clicks; it hands
  // us `close()` when it opens so an action can dismiss it. Empty-area clicks
  // (below the rows) are ours alone, so `close` is null for those.
  const menuCloseRef = useRef<(() => void) | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{
    item: FileTreeContextMenuItem;
    x: number;
    y: number;
  } | null>(null);
  const [confirm, setConfirm] = useState<{
    path: string;
    name: string;
    isFolder: boolean;
  } | null>(null);

  // Hide native browser webviews (which paint over the DOM) while a menu or the
  // confirm dialog is open, so they don't cover it.
  useEffect(() => setObstruction("filetree-menu", !!menu), [menu]);
  useEffect(() => setObstruction("filetree-confirm", !!confirm), [confirm]);

  // Starting/committing a rename (and F2) selects the affected row, which fires
  // onSelectionChange just like a click — but we must NOT open the file then, or
  // renaming a non-active file would switch the editor to it. This flag gates the
  // open for the current tick around any programmatic selection change.
  const suppressOpenRef = useRef(false);
  const suppressOpen = useCallback(() => {
    suppressOpenRef.current = true;
    setTimeout(() => {
      suppressOpenRef.current = false;
    }, 0);
  }, []);

  // Begin an inline create: add a uniquely-named placeholder row, then drop it
  // straight into rename mode (removed if the user cancels or clears the name).
  const startCreate = useCallback(
    (kind: "file" | "folder", dir: string) => {
      const model = modelRef.current;
      if (!model) return;
      const prefix = dir ? `${noSlash(dir)}/` : "";
      const existing = prevPathsRef.current;
      const taken = (candidate: string) =>
        existing.includes(candidate) ||
        existing.includes(`${candidate}/`) ||
        existing.some((p) => p.startsWith(`${candidate}/`));
      const base = kind === "folder" ? "new-folder" : "new-file";
      let name = base;
      for (let n = 2; taken(prefix + name); n += 1) name = `${base}-${n}`;
      const canonical = `${prefix}${name}${kind === "folder" ? "/" : ""}`;
      suppressOpen();
      model.add(canonical);
      model.startRenaming(canonical, { removeIfCanceled: true });
    },
    [suppressOpen],
  );

  useImperativeHandle(
    ref,
    () => ({
      newFile: (dir?: string) => startCreate("file", dir ?? ""),
      newFolder: (dir?: string) => startCreate("folder", dir ?? ""),
    }),
    [startCreate],
  );

  const closeMenu = useCallback(() => {
    menuCloseRef.current?.();
    menuCloseRef.current = null;
    setMenu(null);
  }, []);

  // Dismiss the menu on outside click / Escape. Covers empty-area menus (which
  // the library doesn't track); for row menus the library also dismisses, but
  // both paths just clear the same state so it's harmless.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, closeMenu]);

  // Right-clicking the empty space below the rows acts like right-clicking the
  // project root: offer New file / New folder there. The tree renders its rows
  // in a shadow root and calls preventDefault on row right-clicks; a native
  // listener on the wrapper reliably receives the composed, bubbling event and
  // can tell an already-handled row click (defaultPrevented) from empty space.
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented) return; // a row already handled it
      e.preventDefault();
      menuCloseRef.current = null;
      setMenu({
        item: { kind: "directory", name: "", path: "" },
        x: e.clientX,
        y: e.clientY,
      });
    };
    // F2 triggers the library's own rename; capture it before that so the
    // resulting selection change doesn't open the file (see suppressOpen).
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key === "F2") suppressOpen();
    };
    el.addEventListener("contextmenu", onContext);
    el.addEventListener("keydown", onKeyDownCapture, true);
    return () => {
      el.removeEventListener("contextmenu", onContext);
      el.removeEventListener("keydown", onKeyDownCapture, true);
    };
  }, [suppressOpen]);

  // Committed rename input. A path that isn't already on disk is one of our
  // create placeholders; anything else is a real rename of an existing entry.
  const onRenameCommit = useCallback(
    (event: FileTreeRenameEvent) => {
      // Committing moves the row, reselecting it — don't let that open the file.
      suppressOpen();
      const { sourcePath, destinationPath, isFolder } = event;
      const model = modelRef.current;
      const canonical = (p: string) =>
        isFolder && !p.endsWith("/") ? `${p}/` : p;
      const paths = prevPathsRef.current;
      const isExisting = isFolder
        ? paths.some(
            (p) =>
              p === sourcePath ||
              p === `${sourcePath}/` ||
              p.startsWith(`${sourcePath}/`),
          )
        : paths.includes(sourcePath);
      const h = handlersRef.current;

      if (!isExisting) {
        const op = isFolder
          ? h.onCreateFolder(destinationPath)
          : h.onCreateFile(destinationPath);
        op.catch((err: unknown) => {
          pushToast("error", "Couldn't create", String(err));
          // Roll back the optimistic row the tree already inserted.
          model?.remove(
            canonical(destinationPath),
            isFolder ? { recursive: true } : undefined,
          );
        });
      } else {
        h.onRenamePath(sourcePath, destinationPath).catch((err: unknown) => {
          pushToast("error", "Couldn't rename", String(err));
          model?.move(canonical(destinationPath), canonical(sourcePath));
        });
      }
    },
    [suppressOpen],
  );

  const onRenameError = useCallback((error: string) => {
    pushToast("error", "Invalid name", error);
  }, []);

  const onContextOpen = useCallback(
    (item: FileTreeContextMenuItem, ctx: FileTreeContextMenuOpenContext) => {
      menuCloseRef.current = () => ctx.close();
      setMenu({ item, x: ctx.anchorRect.left, y: ctx.anchorRect.top });
    },
    [],
  );

  const { model } = useFileTree({
    paths,
    icons: { set: "complete", colored: true },
    density: "compact",
    initialExpansion: 0,
    renaming: { onRename: onRenameCommit, onError: onRenameError },
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: "right-click",
        onOpen: onContextOpen,
        onClose: () => setMenu(null),
      },
    },
    onSelectionChange: (selected) => {
      const path = selected[0];
      if (!path) return;
      // A rename/create selected this row programmatically — don't open it.
      if (suppressOpenRef.current) return;
      // Selecting a folder expands it; only files open in the editor.
      if (modelRef.current?.getItem(path)?.isDirectory()) return;
      // The active file is already open; ignore re-selecting it (avoids the
      // programmatic sync below from reopening, and no-op clicks).
      if (path === activeRef.current) return;
      // Only open files that exist on disk. Starting an inline create selects a
      // placeholder row that isn't a real file yet — opening it would try to
      // read a missing path (and steal focus from the rename input).
      if (!prevPathsRef.current.includes(path)) return;
      handlersRef.current.onSelect?.(path);
    },
  });
  modelRef.current = model;

  // `useFileTree` builds the model exactly once and intentionally ignores later
  // `paths` changes (see its source), so live updates from the FS watcher — App
  // hands us a fresh `paths` array on every add/delete/rename — won't show
  // unless we push them into the model with `resetPaths`. Preserve which folders
  // are expanded across the reset so an on-disk change doesn't collapse the tree
  // the user is working in.
  useEffect(() => {
    if (prevPathsRef.current === paths) return; // initial render, or no change
    // Consider directories from both the old and new path sets: a renamed folder
    // only exists under its new name in `paths`, and the model (already carrying
    // the optimistic rename) knows it's still expanded — so it's preserved
    // instead of collapsing on commit.
    const dirs = new Set<string>();
    for (const p of [...prevPathsRef.current, ...paths]) {
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
    <div ref={wrapperRef} className="h-full overflow-hidden text-[13px]">
      <FileTree model={model} style={{ ...TREE_STYLE, height: "100%" }} />

      {menu &&
        createPortal(
          // Marked as a context-menu root so the tree's outside-click handler
          // doesn't treat clicks inside the menu as a dismissal.
          <div
            ref={menuRef}
            data-file-tree-context-menu-root="true"
            className="fixed z-[80] min-w-[11rem] overflow-hidden rounded-lg border border-border bg-bg-elevated p-1 text-fg shadow-lg"
            style={{
              left: Math.min(menu.x, window.innerWidth - 188),
              top: Math.min(menu.y, window.innerHeight - 160),
            }}
          >
            <MenuButton
              icon={<FilePlus size={13} strokeWidth={1.8} />}
              label="New file"
              onClick={() => {
                startCreate("file", targetDir(menu.item));
                closeMenu();
              }}
            />
            <MenuButton
              icon={<FolderPlus size={13} strokeWidth={1.8} />}
              label="New folder"
              onClick={() => {
                startCreate("folder", targetDir(menu.item));
                closeMenu();
              }}
            />
            {/* The synthetic root target (empty path) can't be renamed or
                deleted, so those actions only show for real rows. */}
            {menu.item.path !== "" && (
              <>
                <div className="my-1 h-px bg-border" />
                <MenuButton
                  icon={<Pencil size={13} strokeWidth={1.8} />}
                  label="Rename"
                  onClick={() => {
                    suppressOpen();
                    modelRef.current?.startRenaming(menu.item.path);
                    closeMenu();
                  }}
                />
                <MenuButton
                  icon={<Trash2 size={13} strokeWidth={1.8} />}
                  label="Delete"
                  danger
                  onClick={() => {
                    setConfirm({
                      path: noSlash(menu.item.path),
                      name: menu.item.name,
                      isFolder: menu.item.kind === "directory",
                    });
                    closeMenu();
                  }}
                />
              </>
            )}
          </div>,
          document.body,
        )}

      {confirm &&
        createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40"
            onMouseDown={() => setConfirm(null)}
          >
            <div
              className="mx-4 w-full max-w-sm rounded-xl border border-border bg-bg-elevated p-4 text-fg shadow-2xl"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <h2 className="text-sm font-medium">
                Delete {confirm.isFolder ? "folder" : "file"}?
              </h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-fg-subtle">
                <span className="font-medium text-fg">{confirm.name}</span>
                {confirm.isFolder
                  ? " and everything inside it will be permanently deleted."
                  : " will be permanently deleted."}{" "}
                This can't be undone.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setConfirm(null)}
                  className="rounded-md px-3 py-1.5 text-[13px] text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    const rel = confirm.path;
                    setConfirm(null);
                    handlersRef.current
                      .onDeletePath(rel)
                      .catch((err: unknown) =>
                        pushToast("error", "Couldn't delete", String(err)),
                      );
                  }}
                  className="rounded-md bg-red-700 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-red-800"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
});

function MenuButton({
  icon,
  label,
  danger = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] outline-none transition-colors",
        danger
          ? "text-red-400 hover:bg-red-950/40 hover:text-red-300"
          : "text-fg-subtle hover:bg-bg-hover hover:text-fg",
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
