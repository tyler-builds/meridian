import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FolderCode, Plus, X } from "lucide-react";
import { useState } from "react";

import type { ProjectTab } from "@/types";
import { cn, isMac } from "@/lib/utils";
import { TabContextMenu } from "@/components/TabBar";

function RailTabItem({
  tab,
  active,
  onSelect,
  onClose,
  onContextMenu,
}: {
  tab: ProjectTab;
  active: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, tab: ProjectTab) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: tab.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        // Lock dragging to the vertical axis: the rail is a vertical list, so
        // pin the dragged item's x to 0 (the sort strategy only lays out the
        // siblings, not the dragged item itself).
        transform: CSS.Transform.toString(transform && { ...transform, x: 0 }),
        transition,
      }}
      {...attributes}
      {...listeners}
      onClick={() => onSelect(tab.id)}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose(tab.id);
        }
      }}
      onContextMenu={(e) => onContextMenu(e, tab)}
      title={tab.name}
      className={cn(
        "group flex h-8 w-full cursor-default items-center gap-2 rounded-md px-2 text-[13px] transition-colors",
        isDragging ? "opacity-50" : "",
        active
          ? "bg-bg-elevated text-fg"
          : "text-fg-subtle hover:bg-bg-hover hover:text-fg",
      )}
    >
      {tab.favicon ? (
        <img
          src={tab.favicon}
          alt=""
          className="h-[15px] w-[15px] shrink-0 rounded-[3px] object-contain"
        />
      ) : (
        <FolderCode
          size={15}
          strokeWidth={1.8}
          className={cn("shrink-0", active ? "text-fg-subtle" : "text-fg-faint")}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{tab.name}</span>
      <span className="relative -mr-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {/* Attention dot when a Claude tab inside this (non-active) project is
            waiting; derived from its main tabs so it clears once they're viewed.
            Fades on hover so the close button takes the slot. */}
        {!active && tab.mainTabs.some((m) => m.attention) && (
          <span className="pointer-events-none absolute h-[7px] w-[7px] rounded-full bg-accent transition-opacity group-hover:opacity-0" />
        )}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
          className={cn(
            "flex h-4 w-4 items-center justify-center rounded text-fg-faint opacity-0 transition hover:bg-bg-active hover:text-fg group-hover:opacity-100",
            active && "opacity-60",
          )}
          aria-label={`Close ${tab.name}`}
        >
          <X size={12} strokeWidth={2} />
        </button>
      </span>
    </div>
  );
}

/**
 * Vertical project-tab rail: the left-most column shown when the "Vertical
 * project tabs" setting is on (replacing the horizontal strip in the title
 * bar). Sits left of the collapsible file-tree sidebar. Mirrors the horizontal
 * TabBar's behavior — select, middle-click / hover-X close, drag to reorder,
 * right-click to copy path — laid out as a list.
 */
export function ProjectRail({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onReorder,
  onOpenProject,
}: {
  tabs: ProjectTab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onOpenProject: () => void;
}) {
  // A small distance threshold so a plain click still selects/closes a tab
  // rather than starting a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(
    null,
  );

  const onContextMenu = (e: React.MouseEvent, tab: ProjectTab) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, path: tab.path });
  };

  const copyPath = (path: string) => {
    navigator.clipboard.writeText(path).catch(() => {
      /* clipboard unavailable */
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (over && active.id !== over.id) {
      onReorder(String(active.id), String(over.id));
    }
  };

  return (
    <aside
      data-tauri-drag-region
      className={cn(
        "flex w-[204px] shrink-0 flex-col border-r border-border bg-bg",
        // The rail is now the top-left corner of the window; on macOS the native
        // traffic lights are drawn there, so inset the list clear of them.
        isMac && "pt-6",
      )}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={tabs.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
            {tabs.map((tab) => (
              <RailTabItem
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                onSelect={onSelect}
                onClose={onClose}
                onContextMenu={onContextMenu}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Open-project action pinned below the list. */}
      <div className="shrink-0 p-2 pt-0">
        <button
          onClick={onOpenProject}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
          aria-label="Open project"
          title="Open project"
        >
          <Plus size={15} strokeWidth={2} className="shrink-0" />
          <span className="truncate">Open project</span>
        </button>
      </div>

      {menu && (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          onCopyPath={() => copyPath(menu.path)}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  );
}
