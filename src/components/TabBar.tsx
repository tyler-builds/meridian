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
import { FolderCode, Plus, Settings, X } from "lucide-react";

import type { ProjectTab } from "@/types";
import { cn } from "@/lib/utils";
import { WindowControls } from "@/components/WindowControls";

function ProjectTabItem({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: ProjectTab;
  active: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: tab.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() => onSelect(tab.id)}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose(tab.id);
        }
      }}
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
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        className={cn(
          "-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 transition hover:bg-bg-active hover:text-fg group-hover:opacity-100",
          active && "opacity-60",
        )}
        aria-label={`Close ${tab.name}`}
      >
        <X size={12} strokeWidth={2} />
      </button>
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
    </div>
  );
}
