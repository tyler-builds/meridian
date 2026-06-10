import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { DiffPanel } from "@/components/DiffPanel";
import { SourceControlPanel } from "@/components/SourceControlPanel";

const MIN_PANEL_WIDTH = 220;
const MAX_PANEL_WIDTH = 560;
const DEFAULT_PANEL_WIDTH = 300;

/**
 * The Git tab: the working-tree diff (left) beside the Source Control panel
 * (right), separated by a drag-resizable splitter.
 *
 * GitPanel owns the shared refresh signal so a single reload keeps both halves
 * in sync. It bumps `reloadNonce` when the tab becomes active, when the window
 * regains focus (changes may have been made in a terminal), and after the
 * Source Control panel stages/commits/pushes. Clicking a file row in the panel
 * sets `focus`, which scrolls the diff to that file.
 */
export function GitPanel({ root, active }: { root: string; active: boolean }) {
  const [reloadNonce, setReloadNonce] = useState(0);
  const [focus, setFocus] = useState<{ path: string; nonce: number } | null>(
    null,
  );
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  const selectFile = useCallback((path: string) => {
    setFocus((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // Reload when the tab becomes active.
  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  // Reload whenever the app window regains focus, while this tab is active —
  // the working tree may have changed from a terminal or external editor.
  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) reload();
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active, reload]);

  // Splitter drag. The panel is right-anchored, so moving the pointer left
  // (toward the diff) widens it.
  const onResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = panelWidth;
      const onMove = (ev: MouseEvent) => {
        const next = startWidth + (startX - ev.clientX);
        setPanelWidth(
          Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, next)),
        );
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [panelWidth],
  );

  return (
    <div className="flex h-full w-full bg-bg">
      <div className="min-w-0 flex-1">
        <DiffPanel
          root={root}
          active={active}
          reloadNonce={reloadNonce}
          focus={focus}
        />
      </div>

      <div
        onMouseDown={onResizeStart}
        className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent"
        role="separator"
        aria-orientation="vertical"
      />

      <div className="shrink-0" style={{ width: panelWidth }}>
        <SourceControlPanel
          root={root}
          reloadNonce={reloadNonce}
          onChanged={reload}
          onSelectFile={selectFile}
        />
      </div>
    </div>
  );
}
