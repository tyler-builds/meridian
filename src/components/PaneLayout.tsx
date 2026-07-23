import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

import type { ContentItem, PaneNode } from "@/types";
import {
  computeLayout,
  findLeaf,
  type DividerBox,
  type DropSide,
} from "@/lib/paneTree";
import { cn } from "@/lib/utils";
import { setObstruction } from "@/lib/nativeSurface";
import { PaneTabStrip, type NewTabActions } from "@/components/PaneTabStrip";

const MIN_RATIO = 0.08;
/** Height of each pane's tab strip, in px. */
export const STRIP_H = 36;

type Zone = DropSide | "center";

/** A drop target overlaying part of a pane; measured by dnd-kit, not clicked. */
function DropZone({
  paneId,
  zone,
  style,
}: {
  paneId: string;
  zone: Zone;
  style: CSSProperties;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `${paneId}::${zone}`,
    data: { paneId, zone },
  });
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "pointer-events-none absolute rounded-sm transition-colors",
        isOver && "bg-accent/25 ring-1 ring-inset ring-accent",
      )}
    />
  );
}

/** The five drop zones (4 edges + center) filling one pane. */
function PaneDropZones({ paneId }: { paneId: string }) {
  return (
    <>
      <DropZone
        paneId={paneId}
        zone="up"
        style={{ top: 0, left: 0, right: 0, height: "25%" }}
      />
      <DropZone
        paneId={paneId}
        zone="down"
        style={{ left: 0, right: 0, bottom: 0, height: "25%" }}
      />
      <DropZone
        paneId={paneId}
        zone="left"
        style={{ top: "25%", bottom: "25%", left: 0, width: "25%" }}
      />
      <DropZone
        paneId={paneId}
        zone="right"
        style={{ top: "25%", bottom: "25%", right: 0, width: "25%" }}
      />
      <DropZone paneId={paneId} zone="center" style={{ inset: "25%" }} />
    </>
  );
}

/**
 * A tab that is both draggable (to move/split) and, for reordering, two drop
 * slots: its left half inserts before it, its right half inserts after it. The
 * accent bar renders on whichever half is hovered, so the preview always
 * matches where the tab will land — including "after the last tab" (end).
 */
function StripTab({
  contentId,
  paneId,
  index,
  children,
}: {
  contentId: string;
  paneId: string;
  index: number;
  children: ReactNode;
}) {
  const drag = useDraggable({
    id: `tab:${contentId}`,
    data: { contentId, paneId },
  });
  // `index` here is the insertion position in the pane's tab array.
  const before = useDroppable({
    id: `slot:${paneId}:${index}:before`,
    data: { type: "reorder", paneId, index },
  });
  const after = useDroppable({
    id: `slot:${paneId}:${index}:after`,
    data: { type: "reorder", paneId, index: index + 1 },
  });
  const self = drag.isDragging;
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      className={cn("relative shrink-0", self && "opacity-40")}
    >
      {children}
      {/* Invisible drop halves (measured by rect); bars preview the insert. */}
      <div
        ref={before.setNodeRef}
        className="pointer-events-none absolute inset-y-0 left-0 w-1/2"
      >
        {before.isOver && !self && (
          <span className="absolute inset-y-1 -left-px z-10 w-0.5 rounded bg-accent" />
        )}
      </div>
      <div
        ref={after.setNodeRef}
        className="pointer-events-none absolute inset-y-0 right-0 w-1/2"
      >
        {after.isOver && !self && (
          <span className="absolute inset-y-1 -right-px z-10 w-0.5 rounded bg-accent" />
        )}
      </div>
    </div>
  );
}

/** The slack after the last tab — a drop target that appends to the pane end. */
function StripEnd({ paneId, index }: { paneId: string; index: number }) {
  const drop = useDroppable({
    id: `slot:${paneId}:end`,
    data: { type: "reorder", paneId, index },
  });
  return (
    <div ref={drop.setNodeRef} className="relative min-w-0 flex-1 self-stretch">
      {drop.isOver && (
        <span className="pointer-events-none absolute inset-y-1 left-0 z-10 w-0.5 rounded bg-accent" />
      )}
    </div>
  );
}

/**
 * Collision priority: a reorder slot (in the tab strip) wins over the pane's
 * move/split zones (in the body), so the strip reorders while the body
 * moves/splits. Zones already sit below the strip, so this only disambiguates
 * the shared boundary.
 */
const collisionDetection: typeof pointerWithin = (args) => {
  const hits = pointerWithin(args);
  if (hits.length <= 1) return hits;
  const rank = (id: string | number) =>
    String(id).startsWith("slot:") ? 0 : 1;
  return [...hits].sort((a, b) => rank(a.id) - rank(b.id));
};

export function PaneLayout({
  root,
  contents,
  activePaneId,
  projectActive,
  scratch,
  renderContent,
  onSelectTab,
  onCloseTab,
  onFocusPane,
  onSplit,
  onResize,
  onMoveTab,
  onSplitWithTab,
  newTabActions,
}: {
  root: PaneNode;
  contents: Record<string, ContentItem>;
  activePaneId: string | null;
  projectActive: boolean;
  /** Folder-less scratch space: its strips hide the project-only Git/Search. */
  scratch?: boolean;
  renderContent: (
    content: ContentItem,
    ctx: { visible: boolean; active: boolean },
  ) => ReactNode;
  onSelectTab: (paneId: string, contentId: string) => void;
  onCloseTab: (contentId: string) => void;
  onFocusPane: (paneId: string) => void;
  onSplit: (paneId: string, side: DropSide) => void;
  onResize: (splitId: string, sizes: number[]) => void;
  onMoveTab: (contentId: string, targetPaneId: string, index?: number) => void;
  onSplitWithTab: (
    targetPaneId: string,
    contentId: string,
    side: DropSide,
  ) => void;
  newTabActions: (paneId: string) => NewTabActions;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { leaves, dividers } = computeLayout(root);
  const multi = leaves.length > 1;

  // Resolve layout once per render: pane boxes by id, leaf nodes, and which
  // pane holds each content — replacing repeated full-tree walks in the maps
  // below (they run on every resize/drag re-render).
  type Leaf = Extract<PaneNode, { type: "leaf" }>;
  const boxById = new Map(leaves.map((l) => [l.id, l] as const));
  const leafNodes = leaves
    .map((l) => findLeaf(root, l.id))
    .filter((n): n is Leaf => n !== null);
  const paneOfContent = new Map<string, Leaf>();
  leafNodes.forEach((leaf) =>
    leaf.tabs.forEach((t) => paneOfContent.set(t, leaf)),
  );

  const [dragging, setDragging] = useState<string | null>(null);
  // Failsafe: if this layout unmounts mid-drag (e.g. the project tab is closed
  // while dragging), endDrag never fires — clear the webview-hiding obstruction.
  useEffect(() => () => setObstruction("pane-drag", false), []);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const onDragStart = (e: DragStartEvent) => {
    const contentId = e.active.data.current?.contentId as string | undefined;
    if (!contentId) return;
    setDragging(contentId);
    // Native webviews paint over DOM drop indicators — hide them for the drag.
    setObstruction("pane-drag", true);
  };

  const endDrag = () => {
    setDragging(null);
    setObstruction("pane-drag", false);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const contentId = e.active.data.current?.contentId as string | undefined;
    const fromPaneId = e.active.data.current?.paneId as string | undefined;
    const over = e.over?.data.current as
      | { type: "reorder"; paneId: string; index: number }
      | { paneId: string; zone: Zone }
      | undefined;
    endDrag();
    if (!contentId || !over) return;

    if ("type" in over && over.type === "reorder") {
      // over.index is the insertion position. Within the same pane the source
      // tab is removed first, so a rightward move shifts it left by one.
      let index = over.index;
      if (fromPaneId === over.paneId) {
        const from = findLeaf(root, over.paneId)?.tabs.indexOf(contentId) ?? -1;
        if (from !== -1 && from < index) index -= 1;
      }
      onMoveTab(contentId, over.paneId, index);
      return;
    }
    if ("zone" in over) {
      if (over.zone === "center") {
        // Dropping on the tab's own pane body is a no-op (nothing moved).
        if (fromPaneId !== over.paneId) onMoveTab(contentId, over.paneId);
      } else {
        onSplitWithTab(over.paneId, contentId, over.zone);
      }
    }
  };

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

  const draggingContent = dragging ? contents[dragging] : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={endDrag}
    >
      <div ref={containerRef} className="relative h-full w-full">
        {/* Content host: every content mounted once, positioned into its pane's
            content area and shown only when it's that pane's active tab. */}
        {Object.values(contents).map((content) => {
          const leaf = paneOfContent.get(content.id) ?? null;
          const box = leaf ? boxById.get(leaf.id) : undefined;
          const visible = !!leaf && !!box && leaf.activeTabId === content.id;
          const active = visible && projectActive && leaf!.id === activePaneId;
          return (
            <div
              key={content.id}
              onMouseDown={() => box && onFocusPane(box.id)}
              style={
                box
                  ? {
                      position: "absolute",
                      left: `${box.rect.left}%`,
                      top: `${box.rect.top}%`,
                      width: `${box.rect.width}%`,
                      height: `${box.rect.height}%`,
                      paddingTop: STRIP_H,
                      display: visible ? "block" : "none",
                    }
                  : { display: "none" }
              }
            >
              <div className="h-full w-full overflow-hidden">
                {renderContent(content, { visible, active })}
              </div>
            </div>
          );
        })}

        {/* Chrome: per-pane tab strip + focus ring + (while dragging) drop zones. */}
        {leafNodes.map((leaf) => {
          const box = boxById.get(leaf.id);
          if (!box) return null;
          const { id } = leaf;
          const { rect } = box;
          const focused = id === activePaneId;
          return (
            <div
              key={id}
              className="pointer-events-none absolute"
              style={{
                left: `${rect.left}%`,
                top: `${rect.top}%`,
                width: `${rect.width}%`,
                height: `${rect.height}%`,
              }}
            >
              {multi && (
                <div
                  className={cn(
                    "pointer-events-none absolute inset-0 ring-1 ring-inset",
                    focused ? "ring-accent" : "ring-border-subtle",
                  )}
                />
              )}
              <div
                onMouseDown={() => onFocusPane(id)}
                className="pointer-events-auto absolute inset-x-0 top-0 border-b border-border-subtle bg-bg"
                style={{ height: STRIP_H }}
              >
                <PaneTabStrip
                  pane={leaf}
                  contents={contents}
                  scratch={scratch}
                  renderTab={(cid, index, node) => (
                    <StripTab
                      key={cid}
                      contentId={cid}
                      paneId={id}
                      index={index}
                    >
                      {node}
                    </StripTab>
                  )}
                  stripEnd={
                    dragging ? (
                      <StripEnd paneId={id} index={leaf.tabs.length} />
                    ) : null
                  }
                  onSelectTab={(cid) => onSelectTab(id, cid)}
                  onCloseTab={onCloseTab}
                  onSplit={(side) => onSplit(id, side)}
                  onNew={newTabActions(id)}
                />
              </div>
              {/* Move/split zones cover only the body (below the strip), so
                  the strip is free to reorder. */}
              {dragging && (
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0"
                  style={{ top: STRIP_H }}
                >
                  <PaneDropZones paneId={id} />
                </div>
              )}
            </div>
          );
        })}

        {/* Resize handles. */}
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

      <DragOverlay dropAnimation={null}>
        {draggingContent && (
          <div className="flex h-7 items-center gap-2 rounded-md border border-border bg-bg-elevated px-2.5 text-[13px] text-fg shadow-lg">
            <span className="truncate">{draggingContent.title}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
