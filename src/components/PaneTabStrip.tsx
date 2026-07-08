import {
  GitBranch,
  Globe,
  MoreHorizontal,
  NotebookPen,
  Plus,
  Search,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Terminal,
  X,
} from "lucide-react";

import type { ContentItem, PaneNode } from "@/types";
import type { DropSide } from "@/lib/paneTree";
import { cn } from "@/lib/utils";
import { setObstruction } from "@/lib/nativeSurface";
import { isClaudeCommand } from "@/lib/claude";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { ClaudeIcon } from "@/components/ClaudeIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Leaf = Extract<PaneNode, { type: "leaf" }>;

export interface NewTabActions {
  terminal: () => void;
  browser: () => void;
  claude: () => void;
  git: () => void;
  notes: () => void;
  search: () => void;
}

function isClaudeContent(c: ContentItem): boolean {
  return c.kind === "terminal" && isClaudeCommand(c.initialCommand);
}

function ContentIcon({ content, active }: { content: ContentItem; active: boolean }) {
  const cls = cn("shrink-0", active ? "text-fg-subtle" : "text-fg-faint");
  if (isClaudeContent(content)) return <ClaudeIcon size={14} />;
  switch (content.kind) {
    case "terminal":
      return <Terminal size={14} strokeWidth={1.8} className={cls} />;
    case "browser":
      return <Globe size={14} strokeWidth={1.8} className={cls} />;
    case "git":
      return <GitBranch size={14} strokeWidth={1.8} className={cls} />;
    case "notes":
      return <NotebookPen size={14} strokeWidth={1.8} className={cls} />;
    case "search":
      return <Search size={14} strokeWidth={1.8} className={cls} />;
    default:
      return (
        <FileTypeIcon
          path={content.relPath ?? content.title}
          size={14}
          className="shrink-0"
        />
      );
  }
}

/** The tab strip for one pane: its tabs, a new-tab menu, and a split menu. */
export function PaneTabStrip({
  pane,
  contents,
  renderTab,
  stripEnd,
  onSelectTab,
  onCloseTab,
  onSplit,
  onNew,
}: {
  pane: Leaf;
  contents: Record<string, ContentItem>;
  /** Wrap each tab (used by the drag layer to make tabs draggable + reorderable). */
  renderTab?: (
    contentId: string,
    index: number,
    node: React.ReactNode,
  ) => React.ReactNode;
  /** Fills the empty space after the last tab (drag layer: "drop at end"). */
  stripEnd?: React.ReactNode;
  onSelectTab: (contentId: string) => void;
  onCloseTab: (contentId: string) => void;
  onSplit: (side: DropSide) => void;
  onNew: NewTabActions;
}) {
  const canSplit = pane.activeTabId != null;
  return (
    <div className="flex h-full min-w-0 items-center gap-1 px-1.5">
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {pane.tabs.map((id, index) => {
          const content = contents[id];
          if (!content) return null;
          const active = id === pane.activeTabId;
          const tab = (
            <div
              key={id}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseTab(id);
                } else {
                  onSelectTab(id);
                }
              }}
              title={content.relPath ?? content.title}
              className={cn(
                "group flex h-7 max-w-[200px] shrink-0 cursor-default items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors",
                active
                  ? "bg-bg-elevated text-fg"
                  : "text-fg-subtle hover:bg-bg-hover hover:text-fg",
              )}
            >
              <ContentIcon content={content} active={active} />
              <span className="truncate">{content.title}</span>
              <div className="relative -mr-1 flex h-4 w-4 shrink-0 items-center justify-center">
                {(content.dirty || content.attention) && (
                  <span className="pointer-events-none absolute h-[7px] w-[7px] rounded-full bg-accent transition-opacity group-hover:opacity-0" />
                )}
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(id);
                  }}
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded text-fg-faint transition hover:bg-bg-active hover:text-fg group-hover:opacity-100",
                    content.dirty || content.attention
                      ? "opacity-0"
                      : active
                        ? "opacity-60"
                        : "opacity-0",
                  )}
                  aria-label={`Close ${content.title}`}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            </div>
          );
          return renderTab ? renderTab(id, index, tab) : tab;
        })}
        {stripEnd}
      </div>

      <div className="flex shrink-0 items-center">
        <DropdownMenu onOpenChange={(o) => setObstruction(`newtab-${pane.id}`, o)}>
          <DropdownMenuTrigger asChild>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg data-[state=open]:bg-bg-hover data-[state=open]:text-fg"
              aria-label="New tab"
              title="New tab"
            >
              <Plus size={16} strokeWidth={2} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onNew.terminal}>
              <Terminal size={15} strokeWidth={1.8} />
              New terminal
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onNew.browser}>
              <Globe size={15} strokeWidth={1.8} />
              New browser tab
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onNew.git}>
              <GitBranch size={15} strokeWidth={1.8} />
              Git
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onNew.notes}>
              <NotebookPen size={15} strokeWidth={1.8} />
              Notes
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onNew.search}>
              <Search size={15} strokeWidth={1.8} />
              Search
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onNew.claude}>
              <ClaudeIcon size={15} />
              Claude
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {canSplit && (
          <DropdownMenu onOpenChange={(o) => setObstruction(`split-${pane.id}`, o)}>
            <DropdownMenuTrigger asChild>
              <button
                className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg data-[state=open]:bg-bg-hover data-[state=open]:text-fg"
                aria-label="Split pane"
                title="Split pane"
              >
                <MoreHorizontal size={16} strokeWidth={1.8} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onSplit("right")}>
                <SplitSquareHorizontal size={15} strokeWidth={1.8} />
                Split right
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onSplit("down")}>
                <SplitSquareVertical size={15} strokeWidth={1.8} />
                Split down
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  pane.activeTabId && onCloseTab(pane.activeTabId)
                }
              >
                <X size={15} strokeWidth={2} />
                Close tab
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
