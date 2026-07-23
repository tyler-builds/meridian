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
import {
  Copy,
  FolderOpen,
  Plus,
  Settings,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { ProjectTab } from "@/types";
import { cn, isMac } from "@/lib/utils";
import { setObstruction } from "@/lib/nativeSurface";
import { WindowControls } from "@/components/WindowControls";
import { ProjectAvatar } from "@/components/ProjectAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Right-click menu for a project tab. Cursor-anchored, grows downward (the tab
 * bar is at the top of the window). Closes on outside click or Escape.
 */
export function TabContextMenu({
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

/** A project tab's icon: a glyph for a scratch space, else the project avatar. */
function TabIcon({ tab, active }: { tab: ProjectTab; active: boolean }) {
  if (tab.scratch) {
    return (
      <SquareTerminal
        size={15}
        strokeWidth={1.8}
        className={cn("shrink-0", active ? "text-fg" : "text-fg-subtle")}
      />
    );
  }
  return (
    <ProjectAvatar
      favicon={tab.favicon}
      name={tab.name}
      size={15}
      active={active}
    />
  );
}

/**
 * The visual of one tab. `dnd` is supplied for draggable project tabs; scratch
 * tabs render pinned (no `dnd`), so they can't be dragged or reordered.
 */
function TabView({
  tab,
  active,
  dnd,
  onSelect,
  onClose,
  onContextMenu,
}: {
  tab: ProjectTab;
  active: boolean;
  dnd?: {
    setNodeRef: (node: HTMLElement | null) => void;
    style: CSSProperties;
    handleProps: Record<string, unknown>;
    isDragging: boolean;
  };
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, tab: ProjectTab) => void;
}) {
  return (
    <div
      ref={dnd?.setNodeRef}
      style={dnd?.style}
      {...(dnd?.handleProps ?? {})}
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
        dnd?.isDragging ? "opacity-50" : "",
        active
          ? "bg-bg-elevated text-fg"
          : "text-fg-subtle hover:bg-bg-hover hover:text-fg",
      )}
    >
      <TabIcon tab={tab} active={active} />
      <span className="min-w-0 truncate">{tab.name}</span>
      <span className="relative -mr-1 flex h-4 w-4 shrink-0 items-center justify-center">
        {/* Attention dot when a Claude tab inside this (non-active) project is
            waiting; derived from its main tabs so it clears once they're viewed.
            Fades on hover so the close button takes the slot. */}
        {!active && Object.values(tab.contents).some((c) => c.attention) && (
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

/** A draggable, reorderable project tab. */
function SortableProjectTab(props: {
  tab: ProjectTab;
  active: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, tab: ProjectTab) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.tab.id });
  return (
    <TabView
      {...props}
      dnd={{
        setNodeRef,
        // Lock dragging to the horizontal axis: the tab strip is a horizontal
        // list, but the dragged tab otherwise follows the pointer vertically too
        // (the sort strategy only lays out the siblings, not the dragged item).
        style: {
          transform: CSS.Transform.toString(
            transform && { ...transform, y: 0 },
          ),
          transition,
        },
        handleProps: { ...attributes, ...listeners },
        isDragging,
      }}
    />
  );
}

export function TabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onReorder,
  onOpenProject,
  onOpenScratch,
  onOpenSettings,
  showProjectTabs = true,
}: {
  tabs: ProjectTab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onOpenProject: () => void;
  onOpenScratch: () => void;
  onOpenSettings: () => void;
  /**
   * Render the project tabs (and the new-project button) in the strip. When
   * false, they live in the vertical rail instead, so the strip is just an
   * empty drag region holding Settings and the window controls.
   */
  showProjectTabs?: boolean;
}) {
  // A small distance threshold so a plain click still selects/closes a tab
  // rather than starting a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const scratchTabs = tabs.filter((t) => t.scratch);
  const projectTabs = tabs.filter((t) => !t.scratch);

  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);

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
      className={cn(
        "flex h-10 shrink-0 items-stretch border-b border-border bg-bg",
        // On macOS the native traffic lights overlay the top-left, so inset the
        // tab strip clear of them; elsewhere the custom controls sit on the right.
        isMac ? "pl-[78px]" : "pl-2",
      )}
    >
      {showProjectTabs && (
        <>
          <div className="no-scrollbar flex h-full min-w-0 items-center gap-1 overflow-x-auto">
            {/* Scratch spaces are pinned first (non-draggable) and set off with a
                divider, so folder-less workspaces read apart from projects. */}
            {scratchTabs.map((tab) => (
              <TabView
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                onSelect={onSelect}
                onClose={onClose}
                onContextMenu={onContextMenu}
              />
            ))}
            {scratchTabs.length > 0 && projectTabs.length > 0 && (
              <span className="mx-1 h-5 w-px shrink-0 self-center bg-border" />
            )}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd}
            >
              <SortableContext
                items={projectTabs.map((t) => t.id)}
                strategy={horizontalListSortingStrategy}
              >
                {projectTabs.map((tab) => (
                  <SortableProjectTab
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTabId}
                    onSelect={onSelect}
                    onClose={onClose}
                    onContextMenu={onContextMenu}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>

          {/* New-workspace menu sits right next to the last tab. */}
          <DropdownMenu
            onOpenChange={(o) => setObstruction("new-workspace", o)}
          >
            <DropdownMenuTrigger asChild>
              <button
                className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg data-[state=open]:bg-bg-hover data-[state=open]:text-fg"
                aria-label="New workspace"
                title="New workspace"
              >
                <Plus size={16} strokeWidth={2} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={onOpenProject}>
                <FolderOpen size={15} strokeWidth={1.8} />
                Open folder…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onOpenScratch}>
                <SquareTerminal size={15} strokeWidth={1.8} />
                New scratch space
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

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

      {/* macOS uses native traffic lights (titleBarStyle: Overlay); our custom
          min/max/close controls render only on Windows and Linux. */}
      {!isMac && <WindowControls />}

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
