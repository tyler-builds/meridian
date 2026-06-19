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
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, FolderCode, Plus, Settings, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ProjectTab } from "@/types";
import { cn } from "@/lib/utils";
import { WindowControls } from "@/components/WindowControls";

/**
 * Right-click menu for a project tab. Cursor-anchored, grows downward (the tab
 * bar is at the top of the window). Closes on outside click or Escape.
 */
function TabContextMenu({
  x,
  y,
  onCopyPath,
  onClose,
}: {
  x: number;
  y: number;
  onCopyPath: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-[80] min-w-[10rem] overflow-hidden rounded-lg border border-border bg-bg-elevated p-1 text-fg shadow-lg"
      style={{ left: Math.min(x, window.innerWidth - 172), top: y }}
    >
      <button
        type="button"
        className="flex w-full cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg-subtle outline-none transition-colors hover:bg-bg-hover hover:text-fg"
        onClick={() => {
          onCopyPath();
          onClose();
        }}
      >
        <Copy size={13} strokeWidth={1.8} className="shrink-0" />
        <span>Copy path</span>
      </button>
    </div>
  );
}

function ProjectTabItem({
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
        // Lock dragging to the horizontal axis: the tab strip is a horizontal
        // list, but the dragged tab otherwise follows the pointer vertically too
        // (the sort strategy only lays out the siblings, not the dragged item).
        transform: CSS.Transform.toString(transform && { ...transform, y: 0 }),
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
        // Tabs size to their name and only shrink+truncate (down to a readable
        // minimum) once the row runs out of room.
        "group flex h-7 min-w-[88px] cursor-default items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors",
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
      <span className="min-w-0 truncate">{tab.name}</span>
      <span className="relative -mr-1 flex h-4 w-4 shrink-0 items-center justify-center">
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

export function TabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onReorder,
  onOpenProject,
  onOpenSettings,
}: {
  tabs: ProjectTab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onOpenProject: () => void;
  onOpenSettings: () => void;
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
    // The whole bar is the window drag region (frameless title bar). Interactive
    // children below don't carry the attribute, so they stay clickable.
    <div
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-stretch border-b border-border bg-bg pl-2"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={tabs.map((t) => t.id)}
          strategy={horizontalListSortingStrategy}
        >
          <div className="no-scrollbar flex h-full min-w-0 items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <ProjectTabItem
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

      {/* New tab sits right next to the last tab. */}
      <button
        onClick={onOpenProject}
        className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
        aria-label="Open project"
        title="Open project"
      >
        <Plus size={16} strokeWidth={2} />
      </button>

      {/* Draggable spacer fills the gap between controls. */}
      <div data-tauri-drag-region className="h-full min-w-2 flex-1" />

      {/* Settings sits on the right, next to the window controls. */}
      <button
        onClick={onOpenSettings}
        className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
        aria-label="Settings"
        title="Settings"
      >
        <Settings size={16} strokeWidth={1.8} />
      </button>

      <WindowControls />

      {menu && (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          onCopyPath={() => copyPath(menu.path)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
