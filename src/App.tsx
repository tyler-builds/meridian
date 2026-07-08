import { useCallback, useEffect, useRef, useState } from "react";

import type { MainTab, ProjectTab } from "@/types";
import {
  claudeBrowserMcpConfig,
  findProjectFavicon,
  frontendLog,
  onProjectTreeChange,
  pickProjectFolder,
  readProjectTree,
  unwatchProjectTree,
  watchProjectTree,
  type PickedElement,
} from "@/lib/tauri";
import { bracketedPaste, injectIntoTerminal } from "@/lib/terminalRegistry";
import { claudeBaseCommand, isClaudeCommand } from "@/lib/claude";
import type { UnlistenFn } from "@tauri-apps/api/event";
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
import { ProjectRail } from "@/components/ProjectRail";
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
  const {
    dangerouslySkipPermissions,
    browserMcpEnabled,
    browserMcpEvalJs,
    effectiveClaudePath,
    shellProgram,
    verticalProjectTabs,
  } = useSettings();
  const [tabs, setTabs] = useState<ProjectTab[]>([]);
  // Live mirror of `tabs` so callbacks can read the current project list without
  // taking `tabs` as a dependency (which would re-create them on every change).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
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
    async (projectId: string) => {
      const paneId = newPaneId();
      // Launch via the configured/auto-detected binary path (falls back to the
      // bare `claude` command on PATH). Detection fixes the common case where a
      // GUI-launched app can't see Homebrew/npm's `claude`.
      const base = claudeBaseCommand(effectiveClaudePath, shellProgram);
      let command = dangerouslySkipPermissions
        ? `${base} --dangerously-skip-permissions`
        : base;

      // Wire up `@browser`: generate a project-scoped MCP config and launch
      // `claude` pointed at it, auto-allowing the browser tools. Best-effort —
      // if the MCP server isn't running, fall back to launching plain `claude`.
      const root = tabsRef.current.find((t) => t.id === projectId)?.path;
      if (browserMcpEnabled && root) {
        try {
          const configPath = await claudeBrowserMcpConfig(root, browserMcpEvalJs);
          const tools = [
            "mcp__browser__list_tabs",
            "mcp__browser__read_tab",
            "mcp__browser__navigate",
            "mcp__browser__reload",
            "mcp__browser__back",
            "mcp__browser__forward",
            "mcp__browser__click",
            "mcp__browser__wait_for_load",
            "mcp__browser__screenshot_tab",
            ...(browserMcpEvalJs ? ["mcp__browser__eval_js"] : []),
          ];
          command += ` --mcp-config "${configPath}" --allowedTools ${tools.join(" ")}`;
        } catch (e) {
          void frontendLog(
            "warn",
            `@browser: MCP config generation failed, launching plain claude: ${String(e)}`,
          );
        }
      }

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
    [
      updateProject,
      dangerouslySkipPermissions,
      browserMcpEnabled,
      browserMcpEvalJs,
      effectiveClaudePath,
      shellProgram,
    ],
  );

  // An element picked in a browser tab's selector mode → paste it as context
  // into the project's Claude terminal (no submit; the user adds their prompt).
  // Returns whether it was delivered, so the browser can confirm with an in-page
  // toast and the user can keep picking without leaving the page.
  const pickElement = useCallback(
    (projectId: string, element: PickedElement): boolean => {
      const project = tabsRef.current.find((t) => t.id === projectId);
      if (!project) return false;

      // A terminal tab whose initial command launched Claude. Prefer the active
      // tab when it qualifies, else the most recently opened Claude tab.
      const claudeTabs = project.mainTabs.filter(
        (m) =>
          m.kind === "terminal" &&
          !!m.initialCommands &&
          Object.values(m.initialCommands).some(isClaudeCommand),
      );
      const chosen =
        claudeTabs.find((m) => m.id === project.activeMainTabId) ??
        claudeTabs[claudeTabs.length - 1];
      const cmds = chosen?.initialCommands;
      const paneId =
        cmds && Object.keys(cmds).find((p) => isClaudeCommand(cmds[p]));
      if (!chosen || !paneId) {
        void frontendLog(
          "warn",
          "Element picker: no Claude tab open in this project to receive the element.",
        );
        return false;
      }

      const attrs = Object.entries(element.attributes)
        .filter(([k]) => k !== "class" && k !== "id")
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      const block = [
        `Selected element from ${element.title || element.url}:`,
        `URL: ${element.url}`,
        `Selector: ${element.selector}`,
        attrs ? `Attributes: ${attrs}` : "",
        element.text ? `Text: ${element.text}` : "",
        "HTML:",
        element.html,
        "",
      ]
        .filter((l) => l !== "")
        .join("\n");

      // Don't switch tabs — the user stays on the page (often picking several
      // elements); the browser confirms with an in-page toast instead.
      if (injectIntoTerminal(paneId, bracketedPaste(block))) {
        return true;
      }
      void frontendLog(
        "warn",
        "Element picker: the Claude terminal isn't ready to receive the element.",
      );
      return false;
    },
    [],
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

  // Bumped whenever the search shortcut fires so an already-open SearchPanel
  // refocuses its input.
  const [searchFocusNonce, setSearchFocusNonce] = useState(0);
  const newSearch = useCallback(
    (projectId: string) => {
      updateProject(projectId, (t) => {
        // One search tab per project; focus the existing one if present.
        const existing = t.mainTabs.find((m) => m.kind === "search");
        if (existing) return { ...t, activeMainTabId: existing.id };
        const newTab: MainTab = {
          id: crypto.randomUUID(),
          kind: "search",
          title: "Search",
        };
        return {
          ...t,
          mainTabs: [...t.mainTabs, newTab],
          activeMainTabId: newTab.id,
        };
      });
      setSearchFocusNonce((n) => n + 1);
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

  // Claude (in main tab `mainTabId` of `projectId`) finished its turn / started
  // waiting on the user. Flag that specific main tab so you can tell which one it
  // was — unless it's the exact tab you're looking at (active project + active
  // main tab), where there's nothing to alert. The project tab's dot is derived
  // from its main tabs (see TabBar), so it lights up for free. Read the active
  // tab via a ref so the callback stays stable as you switch tabs.
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const claudeAttention = useCallback((projectId: string, mainTabId: string) => {
    setTabs((prev) => {
      const project = prev.find((t) => t.id === projectId);
      if (!project) return prev;
      const viewed =
        projectId === activeTabIdRef.current &&
        project.activeMainTabId === mainTabId;
      if (viewed) return prev; // looking right at it
      return prev.map((t) =>
        t.id === projectId
          ? {
              ...t,
              mainTabs: t.mainTabs.map((m) =>
                m.id === mainTabId && !m.attention
                  ? { ...m, attention: true }
                  : m,
              ),
            }
          : t,
      );
    });
  }, []);

  // Viewing a main tab clears its attention dot (and, since the project dot is
  // derived from its main tabs, that dot too). Keyed on the active project and
  // its viewed main tab, so it fires on every path to activation: clicking a
  // tab, opening a project, switching main tabs, or closing the active neighbor.
  const viewedMainTabId =
    tabs.find((t) => t.id === activeTabId)?.activeMainTabId ?? null;
  useEffect(() => {
    if (activeTabId == null || viewedMainTabId == null) return;
    setTabs((prev) => {
      const t = prev.find((x) => x.id === activeTabId);
      if (!t?.mainTabs.some((m) => m.id === viewedMainTabId && m.attention)) {
        return prev; // nothing flagged in view — skip re-render
      }
      return prev.map((x) =>
        x.id === activeTabId
          ? {
              ...x,
              mainTabs: x.mainTabs.map((m) =>
                m.id === viewedMainTabId ? { ...m, attention: false } : m,
              ),
            }
          : x,
      );
    });
  }, [activeTabId, viewedMainTabId]);

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

  // Live file-tree updates: keep one recursive FS watcher per open project so the
  // tree reflects files created/deleted/renamed on disk (the initial
  // `readProjectTree` is a one-time snapshot). The Rust watcher debounces bursts
  // and only emits when the set of paths actually changes. Reconciled against the
  // open projects — new ones get a watcher, closed ones have theirs released.
  // The map value is the event unlisten fn (a placeholder reserves the slot while
  // the async listener attaches, so a project can't be double-watched).
  const treeWatchersRef = useRef<Map<string, UnlistenFn>>(new Map());
  useEffect(() => {
    const watchers = treeWatchersRef.current;
    const present = new Set(tabs.map((t) => t.id));

    for (const t of tabs) {
      if (watchers.has(t.id)) continue;
      watchers.set(t.id, () => {}); // reserve while the listener attaches
      const { id, path } = t;
      void onProjectTreeChange(id, (paths) => {
        setTabs((prev) => prev.map((x) => (x.id === id ? { ...x, paths } : x)));
      }).then((unlisten) => {
        // Project closed during the async gap — undo and don't start the watcher.
        if (!treeWatchersRef.current.has(id)) {
          unlisten();
          return;
        }
        treeWatchersRef.current.set(id, unlisten);
        // Log a watch failure rather than swallowing it — a silent catch here is
        // what made this watcher hard to debug.
        void watchProjectTree(id, path).catch((e) =>
          frontendLog("error", `watchProjectTree failed for ${id}: ${e}`),
        );
      });
    }

    for (const [id, unlisten] of [...watchers.entries()]) {
      if (present.has(id)) continue;
      unlisten();
      watchers.delete(id);
      void unwatchProjectTree(id).catch((e) =>
        frontendLog("error", `unwatchProjectTree failed for ${id}: ${e}`),
      );
    }
  }, [tabs]);

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

      // Mod+Shift+F: full-repo search tab for the active project.
      if (key === "f" && e.shiftKey) {
        if (!project) return;
        stop();
        newSearch(project.id);
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
    newSearch,
  ]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg text-fg">
      {/* Horizontal mode always shows the title-bar strip. Vertical mode moves
          the tabs to the rail and the chrome (Settings + window controls) into
          the active project's tab row — except with no project open, where
          there's no such row, so fall back to the strip to keep the window
          controls reachable. */}
      {(!verticalProjectTabs || tabs.length === 0) && (
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={setActiveTabId}
          onClose={closeTab}
          onReorder={reorderProjects}
          onOpenProject={openProject}
          onOpenSettings={() => setSettingsOpen(true)}
          showProjectTabs={!verticalProjectTabs}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {verticalProjectTabs && tabs.length > 0 && (
          <ProjectRail
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActiveTabId}
            onClose={closeTab}
            onReorder={reorderProjects}
            onOpenProject={openProject}
          />
        )}

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
                  verticalProjectTabs={verticalProjectTabs}
                  onOpenSettings={() => setSettingsOpen(true)}
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
                  onNewSearch={newSearch}
                  searchFocusNonce={searchFocusNonce}
                  onCloseMainTab={closeMainTab}
                  onReorderMainTab={reorderMainTab}
                  onSelectMainTab={selectMainTab}
                  onFileDirtyChange={setFileDirty}
                  onBrowserUrlChange={setBrowserUrl}
                  onBrowserTitleChange={setBrowserTitle}
                  onOpenBrowserUrl={openBrowserUrl}
                  onPickElement={pickElement}
                  onSplitPane={splitPane}
                  onClosePane={closePane}
                  onFocusPane={focusPane}
                  onClaudeAttention={claudeAttention}
                  onResizePane={resizePane}
                />
              </ErrorBoundary>
            </div>
            ))
          )}
        </div>
      </div>

      {(() => {
        const at = tabs.find((t) => t.id === activeTabId);
        const onFile =
          at?.mainTabs.find((m) => m.id === at.activeMainTabId)?.kind ===
          "file";
        return (
          <StatusBar
            projectPath={at?.path}
            onFileTab={onFile}
            projectRoots={tabs.map((t) => t.path)}
            browserTabs={tabs.flatMap((t) =>
              t.mainTabs
                .filter((m) => m.kind === "browser" && m.url)
                .map((m) => ({ url: m.url as string, root: t.path })),
            )}
          />
        );
      })()}

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
