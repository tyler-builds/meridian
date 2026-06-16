import { useRef, type MouseEvent as ReactMouseEvent } from "react";

import type { PaneNode } from "@/types";
import { computeLayout, type DividerBox } from "@/lib/paneTree";
import { cn } from "@/lib/utils";
import { TerminalPanel } from "@/components/TerminalPanel";

const MIN_RATIO = 0.08;

/**
 * Renders a terminal tab's recursive split layout. Terminals are kept in a flat
 * keyed list and positioned absolutely from the computed layout, so splitting or
 * resizing never remounts (and never kills) an existing terminal's PTY.
 */
export function TerminalSplit({
  tree,
  activePaneId,
  cwd,
  shell,
  initialCommands,
  onFocusPane,
  onClosePane,
  onClaudeAttention,
  onResize,
}: {
  tree: PaneNode;
  activePaneId: string | undefined;
  cwd: string;
  shell: string;
  /** Per-pane command to run on first spawn, keyed by pane id. */
  initialCommands?: Record<string, string>;
  onFocusPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  /** Claude in this pane finished its turn / started waiting on the user. */
  onClaudeAttention: (paneId: string) => void;
  onResize: (splitId: string, sizes: number[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { leaves, dividers } = computeLayout(tree);
  const multiplePanes = leaves.length > 1;

  const startResize = (d: DividerBox) => (e: ReactMouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const isRow = d.direction === "row";
    const startPos = isRow ? e.clientX : e.clientY;
    const startSizes = [...d.sizes];
    const total = startSizes.reduce((a, b) => a + b, 0) || startSizes.length;
    const splitPx =
      ((isRow ? d.splitRect.width : d.splitRect.height) / 100) *
      (isRow ? bounds.width : bounds.height);

    const onMove = (ev: MouseEvent) => {
      if (splitPx <= 0) return;
      const pos = isRow ? ev.clientX : ev.clientY;
      const deltaUnits = ((pos - startPos) / splitPx) * total;
      const min = total * MIN_RATIO;
      let a = startSizes[d.index] + deltaUnits;
      let b = startSizes[d.index + 1] - deltaUnits;
      if (a < min) {
        b -= min - a;
        a = min;
      }
      if (b < min) {
        a -= min - b;
        b = min;
      }
      const sizes = [...startSizes];
      sizes[d.index] = a;
      sizes[d.index + 1] = b;
      onResize(d.splitId, sizes);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = isRow ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {leaves.map(({ id, rect }) => {
        const active = id === activePaneId;
        return (
          <div
            key={id}
            onMouseDown={() => onFocusPane(id)}
            style={{
              position: "absolute",
              left: `${rect.left}%`,
              top: `${rect.top}%`,
              width: `${rect.width}%`,
              height: `${rect.height}%`,
            }}
            className={cn(
              "group/pane overflow-hidden",
              multiplePanes &&
                (active
                  ? "ring-1 ring-inset ring-accent"
                  : "ring-1 ring-inset ring-border-subtle"),
            )}
          >
            <TerminalPanel
              cwd={cwd}
              shell={shell}
              initialCommand={initialCommands?.[id]}
              onExit={() => onClosePane(id)}
              onClaudeAttention={() => onClaudeAttention(id)}
            />
          </div>
        );
      })}

      {/* Resize handles */}
      {dividers.map((d) => {
        const isRow = d.direction === "row";
        return (
          <div
            key={`${d.splitId}:${d.index}`}
            onMouseDown={startResize(d)}
            style={
              isRow
                ? {
                    position: "absolute",
                    left: `${d.rect.left}%`,
                    top: `${d.rect.top}%`,
                    height: `${d.rect.height}%`,
                    width: 7,
                    transform: "translateX(-3.5px)",
                  }
                : {
                    position: "absolute",
                    top: `${d.rect.top}%`,
                    left: `${d.rect.left}%`,
                    width: `${d.rect.width}%`,
                    height: 7,
                    transform: "translateY(-3.5px)",
                  }
            }
            className={cn(
              "group/divider z-10",
              isRow ? "cursor-col-resize" : "cursor-row-resize",
            )}
          >
            <div
              className={cn(
                "bg-border transition-colors group-hover/divider:bg-fg-faint",
                isRow ? "mx-auto h-full w-px" : "my-auto h-px w-full",
              )}
            />
          </div>
        );
      })}
    </div>
  );
}
