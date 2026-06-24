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
import { GitBranch, Globe, NotebookPen, Plus, Terminal, X } from "lucide-react";

import type { MainTab } from "@/types";
import { cn } from "@/lib/utils";
import { setObstruction } from "@/lib/nativeSurface";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { ClaudeIcon } from "@/components/ClaudeIcon";
import { isClaudeCommand } from "@/lib/claude";

/** A Claude tab is a terminal tab whose pane auto-runs the `claude` command. */
function isClaudeTab(tab: MainTab): boolean {
  return (
    tab.kind === "terminal" &&
    !!tab.initialCommands &&
    Object.values(tab.initialCommands).some(isClaudeCommand)
  );
}
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function MainTabItem({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: MainTab;
  active: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
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
      title={tab.relPath ?? tab.title}
      className={cn(
        "group flex h-7 max-w-[200px] cursor-default items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors",
        isDragging ? "opacity-50" : "",
        active
          ? "bg-bg-elevated text-fg"
          : "text-fg-subtle hover:bg-bg-hover hover:text-fg",
      )}
    >
      {isClaudeTab(tab) ? (
        <ClaudeIcon size={14} />
      ) : tab.kind === "terminal" ? (
        <Terminal
          size={14}
          strokeWidth={1.8}
          className={cn("shrink-0", active ? "text-fg-subtle" : "text-fg-faint")}
        />
      ) : tab.kind === "browser" ? (
        <Globe
          size={14}
          strokeWidth={1.8}
          className={cn("shrink-0", active ? "text-fg-subtle" : "text-fg-faint")}
        />
      ) : tab.kind === "git" ? (
        <GitBranch
          size={14}
          strokeWidth={1.8}
          className={cn("shrink-0", active ? "text-fg-subtle" : "text-fg-faint")}
        />
      ) : tab.kind === "notes" ? (
        <NotebookPen
          size={14}
          strokeWidth={1.8}
          className={cn("shrink-0", active ? "text-fg-subtle" : "text-fg-faint")}
        />
      ) : (
        <FileTypeIcon
          path={tab.relPath ?? tab.title}
          size={14}
          className="shrink-0"
        />
      )}
      <span className="truncate">{tab.title}</span>
      <div className="relative -mr-1 flex h-4 w-4 shrink-0 items-center justify-center">
        {/* Accent dot: unsaved file (dirty) or Claude waiting in this tab
            (attention). Fades on hover so the close button takes the slot. */}
        {(tab.dirty || tab.attention) && (
          <span className="pointer-events-none absolute h-[7px] w-[7px] rounded-full bg-accent transition-opacity group-hover:opacity-0" />
        )}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
          className={cn(
            "flex h-4 w-4 items-center justify-center rounded text-fg-faint transition hover:bg-bg-active hover:text-fg group-hover:opacity-100",
            tab.dirty || tab.attention
              ? "opacity-0"
              : active
                ? "opacity-60"
                : "opacity-0",
          )}
          aria-label={`Close ${tab.title}`}
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

export function MainTabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onReorder,
  onNewTerminal,
  onNewBrowser,
  onNewClaude,
  onNewGit,
  onNewNotes,
}: {
  tabs: MainTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onNewTerminal: () => void;
  onNewBrowser: () => void;
  onNewClaude: () => void;
  onNewGit: () => void;
  onNewNotes: () => void;
}) {
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
    <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={tabs.map((t) => t.id)}
          strategy={horizontalListSortingStrategy}
        >
          <div className="flex min-w-0 items-center gap-1">
            {tabs.map((tab) => (
              <MainTabItem
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                onSelect={onSelect}
                onClose={onClose}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <DropdownMenu
        onOpenChange={(open) => setObstruction("new-tab-menu", open)}
      >
        <DropdownMenuTrigger asChild>
          <button
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg data-[state=open]:bg-bg-hover data-[state=open]:text-fg"
            aria-label="New tab"
            title="New tab"
          >
            <Plus size={16} strokeWidth={2} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={onNewTerminal}>
            <Terminal size={15} strokeWidth={1.8} />
            New terminal
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewBrowser}>
            <Globe size={15} strokeWidth={1.8} />
            New browser tab
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewGit}>
            <GitBranch size={15} strokeWidth={1.8} />
            Git
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewNotes}>
            <NotebookPen size={15} strokeWidth={1.8} />
            Notes
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewClaude}>
            <ClaudeIcon size={15} />
            Claude
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
