import {
  useCallback,
  useEffect,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { PanelLeft, Settings } from "lucide-react";

import type { ContentItem, ProjectTab } from "@/types";
import type { PickedElement } from "@/lib/tauri";
import { findLeaf, type DropSide } from "@/lib/paneTree";
import { useSettings } from "@/lib/settings";
import { cn, isMac } from "@/lib/utils";
import { registerOpenFileHandler } from "@/lib/lsp/monacoBridge";
import { stashReveal } from "@/lib/editorReveal";
import { WindowControls } from "@/components/WindowControls";
import { FileTreePanel } from "@/components/FileTreePanel";
import { TerminalPanel } from "@/components/TerminalPanel";
import { FileEditor } from "@/components/FileEditor";
import { BrowserPanel } from "@/components/BrowserPanel";
import { GitPanel } from "@/components/GitPanel";
import { NotesPanel } from "@/components/NotesPanel";
import { SearchPanel } from "@/components/SearchPanel";
import { PaneLayout } from "@/components/PaneLayout";
import type { NewTabActions } from "@/components/PaneTabStrip";
import { MainEmptyState } from "@/components/MainEmptyState";

export function ProjectView({
  tab,
  active,
  verticalProjectTabs,
  onOpenSettings,
  sidebarWidth,
  sidebarCollapsed,
  onToggleSidebar,
  onResizeSidebar,
  onOpenFile,
  onNewTerminal,
  onNewBrowser,
  onNewClaude,
  onNewGit,
  onNewNotes,
  onNewSearch,
  searchFocusNonce,
  onCloseContent,
  onSelectTab,
  onFocusPane,
  onSplitNewTerminal,
  onResizePane,
  onFileDirtyChange,
  onBrowserUrlChange,
  onBrowserTitleChange,
  onOpenBrowserUrl,
  onPickElement,
  onClaudeAttention,
  onMoveTab,
  onSplitWithTab,
}: {
  tab: ProjectTab;
  active: boolean;
  verticalProjectTabs: boolean;
  onOpenSettings: () => void;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onResizeSidebar: (width: number) => void;
  onOpenFile: (projectId: string, relPath: string) => void;
  onNewTerminal: (projectId: string, paneId?: string) => void;
  onNewBrowser: (projectId: string, paneId?: string) => void;
  onNewClaude: (projectId: string, paneId?: string) => void;
  onNewGit: (projectId: string, paneId?: string) => void;
  onNewNotes: (projectId: string, paneId?: string) => void;
  onNewSearch: (projectId: string, paneId?: string) => void;
  searchFocusNonce: number;
  onCloseContent: (projectId: string, contentId: string) => void;
  onSelectTab: (projectId: string, paneId: string, contentId: string) => void;
  onFocusPane: (projectId: string, paneId: string) => void;
  onSplitNewTerminal: (projectId: string, paneId: string, side: DropSide) => void;
  onResizePane: (projectId: string, splitId: string, sizes: number[]) => void;
  onFileDirtyChange: (projectId: string, relPath: string, dirty: boolean) => void;
  onBrowserUrlChange: (projectId: string, contentId: string, url: string) => void;
  onBrowserTitleChange: (projectId: string, contentId: string, title: string) => void;
  onOpenBrowserUrl: (projectId: string, url: string) => void;
  onPickElement: (projectId: string, element: PickedElement) => boolean;
  onClaudeAttention: (projectId: string, contentId: string) => void;
  onMoveTab: (
    projectId: string,
    contentId: string,
    targetPaneId: string,
    index?: number,
  ) => void;
  onSplitWithTab: (
    projectId: string,
    targetPaneId: string,
    contentId: string,
    side: DropSide,
  ) => void;
}) {
  const { loaded, shellProgram } = useSettings();

  // Route cross-file go-to-definition / search reveals for this project to the
  // app's file opener; the target FileEditor drains the stashed reveal.
  useEffect(() => {
    return registerOpenFileHandler(tab.path, (rel, selection) => {
      stashReveal(tab.path, rel, selection);
      onOpenFile(tab.id, rel);
    });
  }, [tab.path, tab.id, onOpenFile]);

  const onResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      const onMove = (ev: MouseEvent) =>
        onResizeSidebar(startWidth + (ev.clientX - startX));
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
    [sidebarWidth, onResizeSidebar],
  );

  // The active file (for tree highlight) is the focused pane's active tab.
  const activeFileRelPath = (() => {
    if (!tab.root || !tab.activePaneId) return null;
    const cid = findLeaf(tab.root, tab.activePaneId)?.activeTabId;
    const c = cid ? tab.contents[cid] : undefined;
    return c?.kind === "file" ? (c.relPath ?? null) : null;
  })();

  const canRunTerminals = loaded && !!shellProgram;

  const newTabActions = useCallback(
    (paneId: string): NewTabActions => ({
      terminal: () => onNewTerminal(tab.id, paneId),
      browser: () => onNewBrowser(tab.id, paneId),
      claude: () => onNewClaude(tab.id, paneId),
      git: () => onNewGit(tab.id, paneId),
      notes: () => onNewNotes(tab.id, paneId),
      search: () => onNewSearch(tab.id, paneId),
    }),
    [tab.id, onNewTerminal, onNewBrowser, onNewClaude, onNewGit, onNewNotes, onNewSearch],
  );

  const renderContent = useCallback(
    (content: ContentItem, ctx: { visible: boolean; active: boolean }) => {
      switch (content.kind) {
        case "terminal":
          return canRunTerminals ? (
            <TerminalPanel
              paneId={content.id}
              cwd={tab.path}
              shell={shellProgram!}
              initialCommand={content.initialCommand}
              onExit={() => onCloseContent(tab.id, content.id)}
              onClaudeAttention={() => onClaudeAttention(tab.id, content.id)}
            />
          ) : null;
        case "file":
          return content.relPath ? (
            <FileEditor
              root={tab.path}
              relPath={content.relPath}
              active={ctx.active}
              onDirtyChange={(rel, dirty) => onFileDirtyChange(tab.id, rel, dirty)}
              onOpenUrl={(url) => onOpenBrowserUrl(tab.id, url)}
            />
          ) : null;
        case "browser":
          return (
            <BrowserPanel
              id={content.id}
              initialUrl={content.url ?? "about:blank"}
              projectRoot={tab.path}
              active={active && ctx.visible}
              onUrlChange={(url) => onBrowserUrlChange(tab.id, content.id, url)}
              onTitleChange={(title) =>
                onBrowserTitleChange(tab.id, content.id, title)
              }
              onOpenUrl={(url) => onOpenBrowserUrl(tab.id, url)}
              onPickElement={(element) => onPickElement(tab.id, element)}
            />
          );
        case "git":
          return <GitPanel root={tab.path} active={active && ctx.visible} />;
        case "notes":
          return (
            <NotesPanel
              root={tab.path}
              onOpenUrl={(url) => onOpenBrowserUrl(tab.id, url)}
            />
          );
        case "search":
          return (
            <SearchPanel
              root={tab.path}
              active={active && ctx.visible}
              focusNonce={searchFocusNonce}
              onOpenFile={(rel) => onOpenFile(tab.id, rel)}
            />
          );
        default:
          return null;
      }
    },
    [
      tab.id,
      tab.path,
      active,
      canRunTerminals,
      shellProgram,
      searchFocusNonce,
      onCloseContent,
      onClaudeAttention,
      onFileDirtyChange,
      onOpenBrowserUrl,
      onBrowserUrlChange,
      onBrowserTitleChange,
      onPickElement,
      onOpenFile,
    ],
  );

  // A slim chrome bar is needed only in vertical-tabs mode (to host the window
  // controls the hidden title bar would otherwise provide) or when the sidebar
  // is collapsed (to host the expand button). Otherwise panes fill the area.
  const showChrome = verticalProjectTabs || sidebarCollapsed;

  return (
    <div className="flex flex-1 overflow-hidden">
      {!sidebarCollapsed && (
        <>
          <aside
            style={{ width: sidebarWidth }}
            className="flex shrink-0 flex-col bg-bg"
          >
            <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border-subtle pl-3 pr-1.5">
              <span className="truncate text-[11px] font-medium uppercase tracking-wide text-fg-faint">
                {tab.name}
              </span>
              <button
                onClick={onToggleSidebar}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-bg-hover hover:text-fg"
                aria-label="Collapse sidebar"
                title="Collapse sidebar (Ctrl+B)"
              >
                <PanelLeft size={15} strokeWidth={1.8} />
              </button>
            </header>
            <div className="min-h-0 flex-1">
              {tab.loading ? (
                <p className="px-3 py-2 text-[13px] text-fg-faint">Loading…</p>
              ) : tab.error ? (
                <p className="px-3 py-2 text-[13px] text-fg-subtle">{tab.error}</p>
              ) : (
                <FileTreePanel
                  paths={tab.paths}
                  activeRelPath={activeFileRelPath}
                  onSelect={(rel) => onOpenFile(tab.id, rel)}
                />
              )}
            </div>
          </aside>

          <div
            onMouseDown={onResizeStart}
            className="group relative w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-fg-faint"
          >
            <div className="absolute inset-y-0 -left-1 -right-1" />
          </div>
        </>
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        {showChrome && (
          <div
            className={cn(
              "flex h-10 shrink-0 items-center gap-1.5 border-b border-border-subtle",
              verticalProjectTabs ? "pl-2 pr-0" : "px-2",
            )}
          >
            {sidebarCollapsed && (
              <button
                onClick={onToggleSidebar}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
                aria-label="Expand sidebar"
                title="Expand sidebar (Ctrl+B)"
              >
                <PanelLeft size={15} strokeWidth={1.8} />
              </button>
            )}

            {/* Draggable spacer (window drag region) fills the slack. */}
            <div data-tauri-drag-region className="h-full min-w-2 flex-1" />

            {verticalProjectTabs && active && (
              <div className="flex h-full shrink-0 items-stretch">
                <button
                  onClick={onOpenSettings}
                  className="mx-1 flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
                  aria-label="Settings"
                  title="Settings"
                >
                  <Settings size={16} strokeWidth={1.8} />
                </button>
                {!isMac && <WindowControls />}
              </div>
            )}
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          {!tab.root ? (
            <MainEmptyState
              onNewTerminal={() => onNewTerminal(tab.id)}
              onNewBrowser={() => onNewBrowser(tab.id)}
              onNewClaude={() => onNewClaude(tab.id)}
              onNewGit={() => onNewGit(tab.id)}
              onNewNotes={() => onNewNotes(tab.id)}
            />
          ) : (
            <PaneLayout
              root={tab.root}
              contents={tab.contents}
              activePaneId={tab.activePaneId}
              projectActive={active}
              renderContent={renderContent}
              onSelectTab={(paneId, cid) => onSelectTab(tab.id, paneId, cid)}
              onCloseTab={(cid) => onCloseContent(tab.id, cid)}
              onFocusPane={(paneId) => onFocusPane(tab.id, paneId)}
              onSplit={(paneId, side) => onSplitNewTerminal(tab.id, paneId, side)}
              onResize={(splitId, sizes) => onResizePane(tab.id, splitId, sizes)}
              onMoveTab={(cid, paneId, index) =>
                onMoveTab(tab.id, cid, paneId, index)
              }
              onSplitWithTab={(paneId, cid, side) =>
                onSplitWithTab(tab.id, paneId, cid, side)
              }
              newTabActions={newTabActions}
            />
          )}
        </div>
      </main>
    </div>
  );
}
