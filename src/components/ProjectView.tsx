import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
import {
  MoreHorizontal,
  PanelLeft,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
} from "lucide-react";

import type { ProjectTab } from "@/types";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { FileTreePanel } from "@/components/FileTreePanel";
import { TerminalSplit } from "@/components/TerminalSplit";
import { EditorPanel } from "@/components/EditorPanel";
import { BrowserPanel } from "@/components/BrowserPanel";
import { GitPanel } from "@/components/GitPanel";
import { NotesPanel } from "@/components/NotesPanel";
import { MainTabBar } from "@/components/MainTabBar";
import { MainEmptyState } from "@/components/MainEmptyState";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ProjectView({
  tab,
  active,
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
  onCloseMainTab,
  onReorderMainTab,
  onSelectMainTab,
  onFileDirtyChange,
  onBrowserUrlChange,
  onBrowserTitleChange,
  onOpenBrowserUrl,
  onSplitPane,
  onClosePane,
  onFocusPane,
  onClaudeAttention,
  onResizePane,
}: {
  tab: ProjectTab;
  /** Whether this project tab is the active one (drives native webview show). */
  active: boolean;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onResizeSidebar: (width: number) => void;
  onOpenFile: (projectId: string, relPath: string) => void;
  onNewTerminal: (projectId: string) => void;
  onNewBrowser: (projectId: string) => void;
  onNewClaude: (projectId: string) => void;
  onNewGit: (projectId: string) => void;
  onNewNotes: (projectId: string) => void;
  onCloseMainTab: (projectId: string, mainTabId: string) => void;
  onReorderMainTab: (projectId: string, fromId: string, toId: string) => void;
  onSelectMainTab: (projectId: string, mainTabId: string) => void;
  onFileDirtyChange: (projectId: string, relPath: string, dirty: boolean) => void;
  onBrowserUrlChange: (projectId: string, mainTabId: string, url: string) => void;
  onBrowserTitleChange: (
    projectId: string,
    mainTabId: string,
    title: string,
  ) => void;
  onOpenBrowserUrl: (projectId: string, url: string) => void;
  onSplitPane: (
    projectId: string,
    mainTabId: string,
    paneId: string,
    direction: "row" | "column",
  ) => void;
  onClosePane: (projectId: string, mainTabId: string, paneId: string) => void;
  onFocusPane: (projectId: string, mainTabId: string, paneId: string) => void;
  onClaudeAttention: (
    projectId: string,
    mainTabId: string,
    paneId: string,
  ) => void;
  onResizePane: (
    projectId: string,
    mainTabId: string,
    splitId: string,
    sizes: number[],
  ) => void;
}) {
  const { loaded, shellProgram } = useSettings();

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

  const fileTabs = tab.mainTabs.filter((t) => t.kind === "file");
  const openRelPaths = fileTabs.map((t) => t.relPath ?? "");
  const activeTab = tab.mainTabs.find((t) => t.id === tab.activeMainTabId);
  const activeIsFile = activeTab?.kind === "file";
  const activeFileRelPath = activeIsFile ? (activeTab?.relPath ?? null) : null;
  const canRunTerminals = loaded && !!shellProgram;
  const activeTerminal =
    activeTab?.kind === "terminal" && activeTab.activePaneId
      ? { mainTabId: activeTab.id, paneId: activeTab.activePaneId }
      : null;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left sidebar: file tree */}
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
                <p className="px-3 py-2 text-[13px] text-fg-subtle">
                  {tab.error}
                </p>
              ) : (
                <FileTreePanel
                  paths={tab.paths}
                  activeRelPath={activeFileRelPath}
                  onSelect={(rel) => onOpenFile(tab.id, rel)}
                />
              )}
            </div>
          </aside>

          {/* Resize handle */}
          <div
            onMouseDown={onResizeStart}
            className="group relative w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-fg-faint"
          >
            <div className="absolute inset-y-0 -left-1 -right-1" />
          </div>
        </>
      )}

      {/* Main panel: tabbed terminals + editor */}
      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2">
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
          <MainTabBar
            tabs={tab.mainTabs}
            activeId={tab.activeMainTabId}
            onSelect={(id) => onSelectMainTab(tab.id, id)}
            onClose={(id) => onCloseMainTab(tab.id, id)}
            onReorder={(fromId, toId) => onReorderMainTab(tab.id, fromId, toId)}
            onNewTerminal={() => onNewTerminal(tab.id)}
            onNewBrowser={() => onNewBrowser(tab.id)}
            onNewClaude={() => onNewClaude(tab.id)}
            onNewGit={() => onNewGit(tab.id)}
            onNewNotes={() => onNewNotes(tab.id)}
          />

          {activeTerminal && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg data-[state=open]:bg-bg-hover data-[state=open]:text-fg"
                  aria-label="Terminal options"
                  title="Terminal options"
                >
                  <MoreHorizontal size={16} strokeWidth={1.8} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  onSelect={() =>
                    onSplitPane(
                      tab.id,
                      activeTerminal.mainTabId,
                      activeTerminal.paneId,
                      "row",
                    )
                  }
                >
                  <SplitSquareHorizontal size={15} strokeWidth={1.8} />
                  Split right
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    onSplitPane(
                      tab.id,
                      activeTerminal.mainTabId,
                      activeTerminal.paneId,
                      "column",
                    )
                  }
                >
                  <SplitSquareVertical size={15} strokeWidth={1.8} />
                  Split down
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() =>
                    onClosePane(
                      tab.id,
                      activeTerminal.mainTabId,
                      activeTerminal.paneId,
                    )
                  }
                >
                  <X size={15} strokeWidth={2} />
                  Close pane
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="relative min-h-0 flex-1">
          {tab.mainTabs.length === 0 ? (
            <MainEmptyState
              onNewTerminal={() => onNewTerminal(tab.id)}
              onNewBrowser={() => onNewBrowser(tab.id)}
              onNewClaude={() => onNewClaude(tab.id)}
              onNewGit={() => onNewGit(tab.id)}
              onNewNotes={() => onNewNotes(tab.id)}
            />
          ) : (
            <>
              {/* Terminals stay mounted so their PTYs survive tab switches. */}
              {tab.mainTabs
                .filter((t) => t.kind === "terminal")
                .map((t) => (
                  <div
                    key={t.id}
                    className={cn(
                      "absolute inset-0",
                      tab.activeMainTabId === t.id ? "block" : "hidden",
                    )}
                  >
                    {canRunTerminals && t.paneTree ? (
                      <TerminalSplit
                        tree={t.paneTree}
                        activePaneId={t.activePaneId}
                        cwd={tab.path}
                        shell={shellProgram!}
                        initialCommands={t.initialCommands}
                        onFocusPane={(paneId) =>
                          onFocusPane(tab.id, t.id, paneId)
                        }
                        onClosePane={(paneId) =>
                          onClosePane(tab.id, t.id, paneId)
                        }
                        onClaudeAttention={(paneId) =>
                          onClaudeAttention(tab.id, t.id, paneId)
                        }
                        onResize={(splitId, sizes) =>
                          onResizePane(tab.id, t.id, splitId, sizes)
                        }
                      />
                    ) : null}
                  </div>
                ))}

              {/* Browser tabs stay mounted so their native webviews persist
                  across tab switches; each shows/hides its own surface. */}
              {tab.mainTabs
                .filter((t) => t.kind === "browser")
                .map((t) => (
                  <div
                    key={t.id}
                    className={cn(
                      "absolute inset-0",
                      tab.activeMainTabId === t.id ? "block" : "hidden",
                    )}
                  >
                    <BrowserPanel
                      id={t.id}
                      initialUrl={t.url ?? "about:blank"}
                      active={active && tab.activeMainTabId === t.id}
                      onUrlChange={(url) =>
                        onBrowserUrlChange(tab.id, t.id, url)
                      }
                      onTitleChange={(title) =>
                        onBrowserTitleChange(tab.id, t.id, title)
                      }
                      onOpenUrl={(url) => onOpenBrowserUrl(tab.id, url)}
                    />
                  </div>
                ))}

              {/* Git tabs: working-tree diff plus the Source Control panel
                  (staging + commit/push). Kept mounted so scroll position and
                  the commit message survive tab switches; each refetches when
                  it becomes the active tab or the window regains focus. */}
              {tab.mainTabs
                .filter((t) => t.kind === "git")
                .map((t) => (
                  <div
                    key={t.id}
                    className={cn(
                      "absolute inset-0",
                      tab.activeMainTabId === t.id ? "block" : "hidden",
                    )}
                  >
                    <GitPanel
                      root={tab.path}
                      active={active && tab.activeMainTabId === t.id}
                    />
                  </div>
                ))}

              {/* Notes tabs: a per-repo note pad. Kept mounted so the caret
                  and scroll position survive tab switches; content autosaves
                  per project path independent of the session. */}
              {tab.mainTabs
                .filter((t) => t.kind === "notes")
                .map((t) => (
                  <div
                    key={t.id}
                    className={cn(
                      "absolute inset-0",
                      tab.activeMainTabId === t.id ? "block" : "hidden",
                    )}
                  >
                    <NotesPanel
                      root={tab.path}
                      onOpenUrl={(url) => onOpenBrowserUrl(tab.id, url)}
                    />
                  </div>
                ))}

              {/* One shared editor for all file tabs. */}
              {fileTabs.length > 0 && (
                <div
                  className={cn(
                    "absolute inset-0",
                    activeIsFile ? "block" : "hidden",
                  )}
                >
                  <EditorPanel
                    root={tab.path}
                    openRelPaths={openRelPaths}
                    activeRelPath={activeFileRelPath}
                    onDirtyChange={(rel, dirty) =>
                      onFileDirtyChange(tab.id, rel, dirty)
                    }
                    onOpenFile={(rel) => onOpenFile(tab.id, rel)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
