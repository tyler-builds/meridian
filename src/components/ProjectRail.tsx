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
import { FolderOpen, Plus, SquareTerminal, X } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

import type { ProjectTab } from "@/types";
import { cn, isMac } from "@/lib/utils";
import { setObstruction } from "@/lib/nativeSurface";
import { setTrafficLightsVisible } from "@/lib/tauri";
import { TabContextMenu } from "@/components/TabBar";
import { ProjectAvatar } from "@/components/ProjectAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** A rail tab's icon: a glyph for a scratch space, else the project avatar. */
function RailIcon({
  tab,
  active,
  iconsOnly,
}: {
  tab: ProjectTab;
  active: boolean;
  iconsOnly: boolean;
}) {
  if (tab.scratch) {
    return (
      <SquareTerminal
        size={iconsOnly ? 18 : 15}
        strokeWidth={1.8}
        className={cn("shrink-0", active ? "text-fg" : "text-fg-subtle")}
      />
    );
  }
  return iconsOnly ? (
    <ProjectAvatar
      favicon={tab.favicon}
      name={tab.name}
      size={18}
      badgeSize={28}
      active={active}
    />
  ) : (
    <ProjectAvatar
      favicon={tab.favicon}
      name={tab.name}
      size={15}
      active={active}
    />
  );
}

/**
 * The visual of one rail tab. `dnd` is supplied for draggable project tabs;
 * scratch tabs render pinned (no `dnd`), so they can't be dragged or reordered.
 */
function RailTabView({
  tab,
  active,
  iconsOnly,
  dnd,
  onSelect,
  onClose,
  onContextMenu,
}: {
  tab: ProjectTab;
  active: boolean;
  iconsOnly: boolean;
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
  const hasAttention =
    !active && Object.values(tab.contents).some((c) => c.attention);

  const handlers = {
    onClick: () => onSelect(tab.id),
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        onClose(tab.id);
      }
    },
    onContextMenu: (e: React.MouseEvent) => onContextMenu(e, tab),
  };

  if (iconsOnly) {
    return (
      <div
        ref={dnd?.setNodeRef}
        style={dnd?.style}
        {...(dnd?.handleProps ?? {})}
        {...handlers}
        title={tab.name}
        className={cn(
          "group relative flex h-9 w-9 shrink-0 cursor-default items-center justify-center rounded-md transition-colors",
          dnd?.isDragging ? "opacity-50" : "",
          active
            ? "bg-bg-elevated text-fg"
            : "text-fg-subtle hover:bg-bg-hover hover:text-fg",
        )}
      >
        <RailIcon tab={tab} active={active} iconsOnly />
        {/* Attention dot: a Claude tab in this (non-active) project is waiting.
            Top-left so it never overlaps the top-right close button. Ringed so
            it reads over the icon. */}
        {hasAttention && (
          <span className="pointer-events-none absolute left-0.5 top-0.5 h-[7px] w-[7px] rounded-full bg-accent ring-2 ring-bg" />
        )}
        {/* Close button — a red circle centered on the top-right corner. Off the
            tile center so a click still selects the project. */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
          className="absolute -right-[3px] -top-[3px] flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-700 text-white opacity-0 shadow-sm ring-2 ring-bg transition hover:bg-red-800 group-hover:opacity-100"
          aria-label={`Close ${tab.name}`}
        >
          <X size={9} strokeWidth={2.5} />
        </button>
      </div>
    );
  }

  return (
    <div
      ref={dnd?.setNodeRef}
      style={dnd?.style}
      {...(dnd?.handleProps ?? {})}
      {...handlers}
      title={tab.name}
      className={cn(
        "group flex h-8 w-full cursor-default items-center gap-2 rounded-md px-2 text-[13px] transition-colors",
        dnd?.isDragging ? "opacity-50" : "",
        active
          ? "bg-bg-elevated text-fg"
          : "text-fg-subtle hover:bg-bg-hover hover:text-fg",
      )}
    >
      <RailIcon tab={tab} active={active} iconsOnly={false} />
      <span className="min-w-0 flex-1 truncate">{tab.name}</span>
      <span className="relative -mr-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {/* Attention dot when a Claude tab inside this (non-active) project is
            waiting; derived from its main tabs so it clears once they're viewed.
            Fades on hover so the close button takes the slot. */}
        {hasAttention && (
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

/** A draggable, reorderable project tab in the rail. */
function SortableRailTab(props: {
  tab: ProjectTab;
  active: boolean;
  iconsOnly: boolean;
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
    <RailTabView
      {...props}
      dnd={{
        setNodeRef,
        // Lock dragging to the vertical axis: the rail is a vertical list, so
        // pin the dragged item's x to 0 (the sort strategy only lays out the
        // siblings, not the dragged item itself).
        style: {
          transform: CSS.Transform.toString(
            transform && { ...transform, x: 0 },
          ),
          transition,
        },
        handleProps: { ...attributes, ...listeners },
        isDragging,
      }}
    />
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
  iconsOnly = false,
  onSelect,
  onClose,
  onReorder,
  onOpenProject,
  onOpenScratch,
}: {
  tabs: ProjectTab[];
  activeTabId: string | null;
  /** Collapse the rail to a narrow icon-only column (favicons or initials). */
  iconsOnly?: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onOpenProject: () => void;
  onOpenScratch: () => void;
}) {
  // In icon-only mode the rail (54px) is narrower than the macOS traffic
  // lights (~72px span), which would overlap the file-tree header. Hide them
  // and reveal only while the pointer is near the top-left corner. Tracked via
  // window mousemove rather than hover on the rail: the native buttons sit
  // above the webview and swallow pointer events, so a rail mouseleave would
  // hide the buttons under the cursor mid-click. No mousemove fires while the
  // pointer is over the buttons themselves, which keeps them visible there.
  useEffect(() => {
    if (!(isMac && iconsOnly)) return;
    let visible = true;
    const set = (next: boolean) => {
      if (next === visible) return;
      visible = next;
      setTrafficLightsVisible(next).catch(() => {
        /* not running under Tauri */
      });
    };
    set(false);
    const onMove = (e: MouseEvent) =>
      set(e.clientX <= 84 && e.clientY <= 36);
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      set(true);
    };
  }, [iconsOnly]);

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
    <aside
      data-tauri-drag-region
      className={cn(
        "flex shrink-0 flex-col border-r border-border bg-bg",
        iconsOnly ? "w-[54px]" : "w-[204px]",
        // The rail is now the top-left corner of the window; on macOS the native
        // traffic lights are drawn there, so inset the list clear of them.
        isMac && "pt-6",
      )}
    >
      <div
        className={cn(
          "no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2",
          iconsOnly && "items-center",
        )}
      >
        {/* Scratch spaces are pinned at the top (non-draggable) and set off with
            a divider, so folder-less workspaces read apart from projects. */}
        {scratchTabs.map((tab) => (
          <RailTabView
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            iconsOnly={iconsOnly}
            onSelect={onSelect}
            onClose={onClose}
            onContextMenu={onContextMenu}
          />
        ))}
        {scratchTabs.length > 0 && projectTabs.length > 0 && (
          <span
            className={cn(
              "my-1 h-px shrink-0 bg-border",
              iconsOnly ? "w-6" : "w-full",
            )}
          />
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={projectTabs.map((t) => t.id)}
            strategy={verticalListSortingStrategy}
          >
            {projectTabs.map((tab) => (
              <SortableRailTab
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                iconsOnly={iconsOnly}
                onSelect={onSelect}
                onClose={onClose}
                onContextMenu={onContextMenu}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* New-workspace menu pinned below the list. */}
      <div
        className={cn("shrink-0 p-2 pt-0", iconsOnly && "flex justify-center")}
      >
        <DropdownMenu onOpenChange={(o) => setObstruction("new-workspace", o)}>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "flex h-8 items-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg data-[state=open]:bg-bg-hover data-[state=open]:text-fg",
                iconsOnly
                  ? "w-9 justify-center"
                  : "w-full gap-2 px-2 text-[13px]",
              )}
              aria-label="New workspace"
              title="New workspace"
            >
              <Plus size={15} strokeWidth={2} className="shrink-0" />
              {!iconsOnly && <span className="truncate">New workspace</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
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
