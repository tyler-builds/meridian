import { useCallback, useEffect, useRef, useState } from "react";

import type { MainTab, ProjectTab } from "@/types";
import {
  findProjectFavicon,
  pickProjectFolder,
  readProjectTree,
} from "@/lib/tauri";
import { loadSession, saveSession } from "@/lib/session";
import { setObstruction } from "@/lib/nativeSurface";
import { useSettings } from "@/lib/settings";
import { moveById } from "@/lib/reorder";
import { persist } from "@/lib/persist";
import {
  firstLeafId,
  leafNode,
  newPaneId,
  removeLeaf,
  setSizes,
  splitLeaf,
} from "@/lib/paneTree";
import { TabBar } from "@/components/TabBar";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ProjectView } from "@/components/ProjectView";
import { StatusBar } from "@/components/StatusBar";
import { SettingsDialog } from "@/components/SettingsDialog";
import { FileFinder } from "@/components/FileFinder";
import { cn } from "@/lib/utils";

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 264;

export default function App() {
  const { dangerouslySkipPermissions } = useSettings();
  const [tabs, setTabs] = useState<ProjectTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = Number(persist.getItem("meridian.sidebarWidth"));
    return v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : SIDEBAR_DEFAULT;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => persist.getItem("meridian.sidebarCollapsed") === "1",
  );

  const resizeSidebar = useCallback((width: number) => {
    const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width));
    setSidebarWidth(clamped);
    persist.setItem("meridian.sidebarWidth", String(clamped));
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => {
      const next = !c;
      persist.setItem("meridian.sidebarCollapsed", next ? "1" : "0");
      return next;
    });
  }, []);

  const openProject = useCallback(async () => {
    const path = await pickProjectFolder();
    if (!path) return;

    const id = crypto.randomUUID();
    // Open new projects with no tabs; the main panel shows an empty state that
    // offers the new-tab options (terminal, browser, git, Claude).
    const tab: ProjectTab = {
      id,
      name: basename(path),
      path,
      paths: [],
      loading: true,
      mainTabs: [],
      activeMainTabId: null,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);

    void findProjectFavicon(path)
      .then((favicon) =>
        setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, favicon } : t))),
      )
      .catch(() => {});

    try {
      const paths = await readProjectTree(path);
      setTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, paths, loading: false } : t)),
      );
    } catch (err) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, loading: false, error: String(err) }
            : t,
        ),
      );
    }
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        setActiveTabId((current) => {
          if (current !== id) return current;
          const idx = prev.findIndex((t) => t.id === id);
          const fallback = next[idx] ?? next[idx - 1] ?? next[0];
          return fallback?.id ?? null;
        });
        return next;
      });
    },
    [],
  );

  const updateProject = useCallback(
    (projectId: string, updater: (t: ProjectTab) => ProjectTab) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === projectId ? updater(t) : t)),
      );
    },
    [],
  );

  const reorderProjects = useCallback((fromId: string, toId: string) => {
    setTabs((prev) => moveById(prev, fromId, toId));
  }, []);

  const reorderMainTab = useCallback(
    (projectId: string, fromId: string, toId: string) => {
      updateProject(projectId, (t) => ({
        ...t,
        mainTabs: moveById(t.mainTabs, fromId, toId),
      }));
    },
    [updateProject],
  );

  const openFile = useCallback(
    (projectId: string, relPath: string) => {
      updateProject(projectId, (t) => {
        const existing = t.mainTabs.find(
          (m) => m.kind === "file" && m.relPath === relPath,
        );
        if (existing) return { ...t, activeMainTabId: existing.id };
        const newTab: MainTab = {
          id: crypto.randomUUID(),
          kind: "file",
          title: relPath.split("/").pop() ?? relPath,
          relPath,
        };
        return {
          ...t,
          mainTabs: [...t.mainTabs, newTab],
          activeMainTabId: newTab.id,
        };
      });
    },
    [updateProject],
  );

  const newTerminal = useCallback(
    (projectId: string) => {
      updateProject(projectId, (t) => {
        const count = t.mainTabs.filter((m) => m.kind === "terminal").length;
        const paneId = newPaneId();
        const newTab: MainTab = {
          id: crypto.randomUUID(),
          kind: "terminal",
          title: count === 0 ? "Terminal" : `Terminal ${count + 1}`,
          paneTree: leafNode(paneId),
          activePaneId: paneId,
        };
        return {
          ...t,
          mainTabs: [...t.mainTabs, newTab],
          activeMainTabId: newTab.id,
        };
      });
    },
    [updateProject],
  );

  const newClaude = useCallback(
    (projectId: string) => {
      const paneId = newPaneId();
      const command = dangerouslySkipPermissions
        ? "claude --dangerously-skip-permissions"
        : "claude";
      const newTab: MainTab = {
        id: crypto.randomUUID(),
        kind: "terminal",
        title: "Claude",
        paneTree: leafNode(paneId),
        activePaneId: paneId,
        initialCommands: { [paneId]: command },
      };
      updateProject(projectId, (t) => ({
        ...t,
        mainTabs: [...t.mainTabs, newTab],
        activeMainTabId: newTab.id,
      }));
    },
    [updateProject, dangerouslySkipPermissions],
  );

  const newGit = useCallback(
    (projectId: string) => {
      updateProject(projectId, (t) => {
        // One git tab per project is plenty; focus the existing one if present.
        const existing = t.mainTabs.find((m) => m.kind === "git");
        if (existing) return { ...t, activeMainTabId: existing.id };
        const newTab: MainTab = {
          id: crypto.randomUUID(),
          kind: "git",
          title: "Git",
        };
        return {
          ...t,
          mainTabs: [...t.mainTabs, newTab],
          activeMainTabId: newTab.id,
        };
      });
    },
    [updateProject],
  );

  const newNotes = useCallback(
    (projectId: string) => {
      updateProject(projectId, (t) => {
        // One notes tab per project; focus the existing one if present.
        const existing = t.mainTabs.find((m) => m.kind === "notes");
        if (existing) return { ...t, activeMainTabId: existing.id };
        const newTab: MainTab = {
          id: crypto.randomUUID(),
          kind: "notes",
          title: "Notes",
        };
        return {
          ...t,
          mainTabs: [...t.mainTabs, newTab],
          activeMainTabId: newTab.id,
        };
      });
    },
    [updateProject],
  );

  const newBrowser = useCallback(
    (projectId: string) => {
      updateProject(projectId, (t) => {
        const newTab: MainTab = {
          id: crypto.randomUUID(),
          kind: "browser",
          title: "New Tab",
          url: "about:blank",
        };
        return {
          ...t,
          mainTabs: [...t.mainTabs, newTab],
          activeMainTabId: newTab.id,
        };
      });
    },
    [updateProject],
  );

  const openBrowserUrl = useCallback(
    (projectId: string, url: string) => {
      let title = "New Tab";
      try {
        title = new URL(url).host || title;
      } catch {
        /* keep default */
      }
      updateProject(projectId, (t) => {
        const newTab: MainTab = {
          id: crypto.randomUUID(),
          kind: "browser",
          title,
          url,
        };
        return {
          ...t,
          mainTabs: [...t.mainTabs, newTab],
          activeMainTabId: newTab.id,
        };
      });
    },
    [updateProject],
  );

  const setBrowserUrl = useCallback(
    (projectId: string, mainTabId: string, url: string) => {
      updateProject(projectId, (t) => {
        let changed = false;
        const mainTabs = t.mainTabs.map((m) => {
          if (m.id === mainTabId && m.kind === "browser" && m.url !== url) {
            changed = true;
            return { ...m, url };
          }
          return m;
        });
        return changed ? { ...t, mainTabs } : t;
      });
    },
    [updateProject],
  );

  const setBrowserTitle = useCallback(
    (projectId: string, mainTabId: string, title: string) => {
      const next = title.trim() || "New Tab";
      updateProject(projectId, (t) => {
        let changed = false;
        const mainTabs = t.mainTabs.map((m) => {
          if (m.id === mainTabId && m.kind === "browser" && m.title !== next) {
            changed = true;
            return { ...m, title: next };
          }
          return m;
        });
        return changed ? { ...t, mainTabs } : t;
      });
    },
    [updateProject],
  );

  const selectMainTab = useCallback(
    (projectId: string, mainTabId: string) => {
      updateProject(projectId, (t) => ({ ...t, activeMainTabId: mainTabId }));
    },
    [updateProject],
  );

  const closeMainTab = useCallback(
    (projectId: string, mainTabId: string) => {
      updateProject(projectId, (t) => {
        const idx = t.mainTabs.findIndex((m) => m.id === mainTabId);
        if (idx === -1) return t;
        const nextTabs = t.mainTabs.filter((m) => m.id !== mainTabId);
        let active = t.activeMainTabId;
        if (active === mainTabId) {
          const fallback = nextTabs[idx] ?? nextTabs[idx - 1] ?? nextTabs[0];
          active = fallback?.id ?? null;
        }
        return { ...t, mainTabs: nextTabs, activeMainTabId: active };
      });
    },
    [updateProject],
  );

  const setFileDirty = useCallback(
    (projectId: string, relPath: string, dirty: boolean) => {
      updateProject(projectId, (t) => {
        let changed = false;
        const mainTabs = t.mainTabs.map((m) => {
          if (m.kind === "file" && m.relPath === relPath && !!m.dirty !== dirty) {
            changed = true;
            return { ...m, dirty };
          }
          return m;
        });
        return changed ? { ...t, mainTabs } : t;
      });
    },
    [updateProject],
  );

  const splitPane = useCallback(
    (
      projectId: string,
      mainTabId: string,
      paneId: string,
      direction: "row" | "column",
    ) => {
      updateProject(projectId, (t) => ({
        ...t,
        mainTabs: t.mainTabs.map((m) => {
          if (m.id !== mainTabId || !m.paneTree) return m;
          const newId = newPaneId();
          return {
            ...m,
            paneTree: splitLeaf(m.paneTree, paneId, newId, direction),
            activePaneId: newId,
          };
        }),
      }));
    },
    [updateProject],
  );

  const focusPane = useCallback(
    (projectId: string, mainTabId: string, paneId: string) => {
      setTabs((prev) => {
        const t = prev.find((x) => x.id === projectId);
        const m = t?.mainTabs.find((x) => x.id === mainTabId);
        if (!m || m.activePaneId === paneId) return prev; // no change
        return prev.map((x) =>
          x.id === projectId
            ? {
                ...x,
                mainTabs: x.mainTabs.map((mm) =>
                  mm.id === mainTabId ? { ...mm, activePaneId: paneId } : mm,
                ),
              }
            : x,
        );
      });
    },
    [],
  );

  const resizePane = useCallback(
    (
      projectId: string,
      mainTabId: string,
      splitId: string,
      sizes: number[],
    ) => {
      updateProject(projectId, (t) => ({
        ...t,
        mainTabs: t.mainTabs.map((m) =>
          m.id === mainTabId && m.paneTree
            ? { ...m, paneTree: setSizes(m.paneTree, splitId, sizes) }
            : m,
        ),
      }));
    },
    [updateProject],
  );

  // Closing the last pane closes the whole terminal tab.
  const closePane = useCallback(
    (projectId: string, mainTabId: string, paneId: string) => {
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== projectId) return t;
          const target = t.mainTabs.find((m) => m.id === mainTabId);
          if (!target?.paneTree) return t;
          const next = removeLeaf(target.paneTree, paneId);
          if (next) {
            return {
              ...t,
              mainTabs: t.mainTabs.map((m) =>
                m.id === mainTabId
                  ? {
                      ...m,
                      paneTree: next,
                      activePaneId:
                        m.activePaneId === paneId
                          ? firstLeafId(next)
                          : m.activePaneId,
                    }
                  : m,
              ),
            };
          }
          // Tree emptied: drop the main tab.
          const idx = t.mainTabs.findIndex((m) => m.id === mainTabId);
          const mainTabs = t.mainTabs.filter((m) => m.id !== mainTabId);
          let activeMainTabId = t.activeMainTabId;
          if (t.activeMainTabId === mainTabId) {
            const fallback = mainTabs[idx] ?? mainTabs[idx - 1] ?? mainTabs[0];
            activeMainTabId = fallback?.id ?? null;
          }
          return { ...t, mainTabs, activeMainTabId };
        }),
      );
    },
    [],
  );

  const restoredRef = useRef(false);

  // Restore the previous workspace on launch (projects + active project).
  useEffect(() => {
    const session = loadSession();
    if (session && session.projects.length > 0) {
      const restored: ProjectTab[] = session.projects.map((p) => {
        const makeTerminal = (): MainTab => {
          const paneId = newPaneId();
          return {
            id: crypto.randomUUID(),
            kind: "terminal",
            title: "Terminal",
            paneTree: leafNode(paneId),
            activePaneId: paneId,
          };
        };
        // Older sessions had no mainTabs / no pane trees; backfill them.
        const mainTabs: MainTab[] = (
          Array.isArray(p.mainTabs) ? p.mainTabs : [makeTerminal()]
        ).map((m) => {
          if (m.kind === "terminal" && !m.paneTree) {
            const paneId = newPaneId();
            return { ...m, paneTree: leafNode(paneId), activePaneId: paneId };
          }
          return m;
        });
        const activeMainTabId =
          p.activeMainTabId && mainTabs.some((m) => m.id === p.activeMainTabId)
            ? p.activeMainTabId
            : (mainTabs[0]?.id ?? null);
        return {
          id: p.id,
          name: p.name,
          path: p.path,
          paths: [],
          loading: true,
          mainTabs,
          activeMainTabId,
        };
      });
      setTabs(restored);
      setActiveTabId(
        session.activeProjectId &&
          restored.some((t) => t.id === session.activeProjectId)
          ? session.activeProjectId
          : (restored[0]?.id ?? null),
      );
      for (const t of restored) {
        void findProjectFavicon(t.path)
          .then((favicon) =>
            setTabs((prev) =>
              prev.map((x) => (x.id === t.id ? { ...x, favicon } : x)),
            ),
          )
          .catch(() => {});
        readProjectTree(t.path)
          .then((paths) =>
            setTabs((prev) =>
              prev.map((x) =>
                x.id === t.id ? { ...x, paths, loading: false } : x,
              ),
            ),
          )
          .catch((err) =>
            setTabs((prev) =>
              prev.map((x) =>
                x.id === t.id
                  ? { ...x, loading: false, error: String(err) }
                  : x,
              ),
            ),
          );
      }
    }
    restoredRef.current = true;
  }, []);

  // Persist the workspace whenever it changes (after the initial restore).
  useEffect(() => {
    if (!restoredRef.current) return;
    saveSession(tabs, activeTabId);
  }, [tabs, activeTabId]);

  // DOM overlays paint over the content area; native browser webviews ignore
  // DOM z-index, so flag these as obstructions to hide any visible webview
  // while they're open.
  useEffect(() => {
    setObstruction("modal", settingsOpen || finderOpen);
  }, [settingsOpen, finderOpen]);

  // Ctrl/Cmd+O to open a project.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openProject();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openProject]);

  // Shortcuts that must work even while typing in a terminal. Capture phase runs
  // before xterm's key handling; on a match we stop propagation so the shell
  // never sees the keystroke.
  //   Mod+D / Mod+Shift+D : split focused terminal pane right / down
  //   Mod+W               : close focused pane (or the active file tab)
  //   Mod+B               : toggle the sidebar
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (finderOpen) return; // let the finder own the keyboard while open
      const key = e.key.toLowerCase();
      const project = tabs.find((t) => t.id === activeTabId);
      const main = project?.mainTabs.find(
        (m) => m.id === project.activeMainTabId,
      );
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      };

      // Mod+P: quick-open file finder for the active project.
      if (key === "p" && !e.shiftKey) {
        if (!project) return;
        stop();
        setFinderOpen(true);
        return;
      }

      if (key === "b") {
        stop();
        toggleSidebar();
        return;
      }

      if (key === "d") {
        // Split only applies to terminals; leave Mod+D for Monaco otherwise.
        if (!project || main?.kind !== "terminal" || !main.activePaneId) return;
        stop();
        splitPane(
          project.id,
          main.id,
          main.activePaneId,
          e.shiftKey ? "column" : "row",
        );
        return;
      }

      if (key === "w") {
        if (!project || !main) return;
        stop();
        if (main.kind === "terminal" && main.activePaneId) {
          closePane(project.id, main.id, main.activePaneId);
        } else {
          closeMainTab(project.id, main.id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [
    tabs,
    activeTabId,
    finderOpen,
    splitPane,
    closePane,
    closeMainTab,
    toggleSidebar,
  ]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg text-fg">
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={setActiveTabId}
        onClose={closeTab}
        onReorder={reorderProjects}
        onOpenProject={openProject}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="relative flex min-h-0 flex-1">
        {tabs.length === 0 ? (
          <EmptyState onOpenProject={openProject} />
        ) : (
          // Keep every tab mounted so its terminal/PTY survives tab switches;
          // hide inactive ones rather than unmounting.
          tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "absolute inset-0",
                tab.id === activeTabId ? "flex" : "hidden",
              )}
            >
              {/* Per-project boundary: a render error in one project's
                  content shows a recoverable panel there instead of unmounting
                  the whole app (tab bar, sidebar, and sibling projects stay). */}
              <ErrorBoundary label={`project:${tab.name}`}>
                <ProjectView
                  tab={tab}
                  active={tab.id === activeTabId}
                  sidebarWidth={sidebarWidth}
                  sidebarCollapsed={sidebarCollapsed}
                  onToggleSidebar={toggleSidebar}
                  onResizeSidebar={resizeSidebar}
                  onOpenFile={openFile}
                  onNewTerminal={newTerminal}
                  onNewBrowser={newBrowser}
                  onNewClaude={newClaude}
                  onNewGit={newGit}
                  onNewNotes={newNotes}
                  onCloseMainTab={closeMainTab}
                  onReorderMainTab={reorderMainTab}
                  onSelectMainTab={selectMainTab}
                  onFileDirtyChange={setFileDirty}
                  onBrowserUrlChange={setBrowserUrl}
                  onBrowserTitleChange={setBrowserTitle}
                  onOpenBrowserUrl={openBrowserUrl}
                  onSplitPane={splitPane}
                  onClosePane={closePane}
                  onFocusPane={focusPane}
                  onResizePane={resizePane}
                />
              </ErrorBoundary>
            </div>
          ))
        )}
      </div>

      <StatusBar
        projectPath={tabs.find((t) => t.id === activeTabId)?.path}
      />

      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      )}

      {finderOpen &&
        (() => {
          const project = tabs.find((t) => t.id === activeTabId);
          if (!project) return null;
          return (
            <FileFinder
              paths={project.paths}
              onClose={() => setFinderOpen(false)}
              onSelect={(rel) => {
                openFile(project.id, rel);
                setFinderOpen(false);
              }}
            />
          );
        })()}
    </div>
  );
}
