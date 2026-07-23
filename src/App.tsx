import { useCallback, useEffect, useRef, useState } from "react";

import type { ContentItem, ProjectTab } from "@/types";
import {
  claudeBrowserMcpConfig,
  claudeHooksConfig,
  findProjectFavicon,
  frontendLog,
  onClaudeAttentionEvent,
  onProjectTreeChange,
  pickProjectFolder,
  readProjectTree,
  unwatchProjectTree,
  watchProjectTree,
  type PickedElement,
} from "@/lib/tauri";
import { bracketedPaste, injectIntoTerminal } from "@/lib/terminalRegistry";
import { claudeBaseCommand, isClaudeCommand } from "@/lib/claude";
import { ensureNotificationPermission, notifyAttention } from "@/lib/notify";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { homeDir } from "@tauri-apps/api/path";
import { loadSession, saveSession } from "@/lib/session";
import { setObstruction } from "@/lib/nativeSurface";
import { useSettings } from "@/lib/settings";
import { moveById } from "@/lib/reorder";
import { persist } from "@/lib/persist";
import {
  findLeaf,
  firstLeafId,
  newContentId,
  visibleContentIds,
  type DropSide,
} from "@/lib/paneTree";
import {
  closeContent,
  findContentByKind,
  focusPane as focusPaneModel,
  moveTab as moveTabModel,
  openContent,
  patchContent,
  resizeSplit,
  revealContent,
  selectTab as selectTabModel,
  splitNewContent,
  splitWith,
} from "@/lib/paneModel";
import { TabBar } from "@/components/TabBar";
import { ProjectRail } from "@/components/ProjectRail";
import { Toaster } from "@/components/Toaster";
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

/** A new terminal ContentItem titled "Terminal" / "Terminal N" by count. */
function terminalItem(t: ProjectTab, id: string): ContentItem {
  const count = Object.values(t.contents).filter(
    (c) => c.kind === "terminal",
  ).length;
  return {
    id,
    kind: "terminal",
    title: count === 0 ? "Terminal" : `Terminal ${count + 1}`,
  };
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
    projectRailIconsOnly,
  } = useSettings();
  const [tabs, setTabs] = useState<ProjectTab[]>([]);
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
    const tab: ProjectTab = {
      id,
      name: basename(path),
      path,
      paths: [],
      loading: true,
      contents: {},
      root: null,
      activePaneId: null,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);

    void findProjectFavicon(path)
      .then((favicon) =>
        setTabs((prev) =>
          prev.map((t) => (t.id === id ? { ...t, favicon } : t)),
        ),
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
          t.id === id ? { ...t, loading: false, error: String(err) } : t,
        ),
      );
    }
  }, []);

  // Open (or focus, if it already exists) the single folder-less scratch space —
  // a workspace with no project root, for ad-hoc terminals/browsers/Claude. Its
  // `path` is the home dir so its terminals spawn somewhere sensible.
  const openScratch = useCallback(async () => {
    const existing = tabsRef.current.find((t) => t.scratch);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    let path = "";
    try {
      path = await homeDir();
    } catch {
      /* no home dir available; terminals fall back to the shell's default */
    }
    const id = crypto.randomUUID();
    const tab: ProjectTab = {
      id,
      name: "Scratch",
      path,
      scratch: true,
      paths: [],
      loading: false,
      contents: {},
      root: null,
      activePaneId: null,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
  }, []);

  const closeTab = useCallback((id: string) => {
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
  }, []);

  const updateProject = useCallback(
    (projectId: string, updater: (t: ProjectTab) => ProjectTab) => {
      setTabs((prev) => prev.map((t) => (t.id === projectId ? updater(t) : t)));
    },
    [],
  );

  const reorderProjects = useCallback((fromId: string, toId: string) => {
    setTabs((prev) => moveById(prev, fromId, toId));
  }, []);

  const openFile = useCallback(
    (projectId: string, relPath: string) => {
      const id = newContentId();
      updateProject(projectId, (t) => {
        const existing = Object.values(t.contents).find(
          (c) => c.kind === "file" && c.relPath === relPath,
        );
        if (existing) return revealContent(t, existing.id);
        const item: ContentItem = {
          id,
          kind: "file",
          title: relPath.split("/").pop() ?? relPath,
          relPath,
        };
        return openContent(t, item);
      });
    },
    [updateProject],
  );

  const newTerminal = useCallback(
    (projectId: string, paneId?: string) => {
      const id = newContentId();
      updateProject(projectId, (t) =>
        openContent(t, terminalItem(t, id), paneId),
      );
    },
    [updateProject],
  );

  const newClaude = useCallback(
    async (projectId: string, paneId?: string) => {
      const id = newContentId();
      const base = claudeBaseCommand(effectiveClaudePath, shellProgram);
      let command = dangerouslySkipPermissions
        ? `${base} --dangerously-skip-permissions`
        : base;

      const root = tabsRef.current.find((t) => t.id === projectId)?.path;
      if (browserMcpEnabled && root) {
        try {
          const configPath = await claudeBrowserMcpConfig(
            root,
            browserMcpEvalJs,
          );
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

      // Register the Stop/Notification hooks that authoritatively flag this tab
      // when Claude finishes a turn or needs input (see claude_hooks_config). It
      // merges with the user's own settings; on failure we launch without hooks
      // and fall back to the terminal-title heuristic in TerminalPanel.
      try {
        const hooksPath = await claudeHooksConfig(id);
        command += ` --settings "${hooksPath}"`;
      } catch (e) {
        void frontendLog(
          "warn",
          `Claude attention hooks unavailable, using title heuristic: ${String(e)}`,
        );
      }

      updateProject(projectId, (t) =>
        openContent(
          t,
          { id, kind: "terminal", title: "Claude", initialCommand: command },
          paneId,
        ),
      );
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
  const pickElement = useCallback(
    (projectId: string, element: PickedElement): boolean => {
      const project = tabsRef.current.find((t) => t.id === projectId);
      if (!project) return false;

      const claudeContents = Object.values(project.contents).filter(
        (c) => c.kind === "terminal" && isClaudeCommand(c.initialCommand),
      );
      const visible = project.root ? visibleContentIds(project.root) : [];
      const chosen =
        claudeContents.find((c) => visible.includes(c.id)) ??
        claudeContents[claudeContents.length - 1];
      if (!chosen) {
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

      if (injectIntoTerminal(chosen.id, bracketedPaste(block))) return true;
      void frontendLog(
        "warn",
        "Element picker: the Claude terminal isn't ready to receive the element.",
      );
      return false;
    },
    [],
  );

  /** Open (or focus, if already present) a "one per project" content kind. */
  const openSingleton = useCallback(
    (
      projectId: string,
      kind: Extract<ContentItem["kind"], "git" | "notes" | "search">,
      title: string,
      paneId: string | undefined,
    ) => {
      const id = newContentId();
      updateProject(projectId, (t) => {
        const existing = findContentByKind(t, kind);
        if (existing) return revealContent(t, existing.id);
        return openContent(t, { id, kind, title }, paneId);
      });
    },
    [updateProject],
  );

  const newGit = useCallback(
    (projectId: string, paneId?: string) =>
      openSingleton(projectId, "git", "Git", paneId),
    [openSingleton],
  );
  const newNotes = useCallback(
    (projectId: string, paneId?: string) =>
      openSingleton(projectId, "notes", "Notes", paneId),
    [openSingleton],
  );

  const [searchFocusNonce, setSearchFocusNonce] = useState(0);
  const newSearch = useCallback(
    (projectId: string, paneId?: string) => {
      openSingleton(projectId, "search", "Search", paneId);
      setSearchFocusNonce((n) => n + 1);
    },
    [openSingleton],
  );

  const newBrowser = useCallback(
    (projectId: string, paneId?: string) => {
      const id = newContentId();
      updateProject(projectId, (t) =>
        openContent(
          t,
          { id, kind: "browser", title: "New Tab", url: "about:blank" },
          paneId,
        ),
      );
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
      const id = newContentId();
      updateProject(projectId, (t) =>
        openContent(t, { id, kind: "browser", title, url }),
      );
    },
    [updateProject],
  );

  const setBrowserUrl = useCallback(
    (projectId: string, contentId: string, url: string) => {
      updateProject(projectId, (t) =>
        t.contents[contentId]?.url === url
          ? t
          : patchContent(t, contentId, { url }),
      );
    },
    [updateProject],
  );

  const setBrowserTitle = useCallback(
    (projectId: string, contentId: string, title: string) => {
      const next = title.trim() || "New Tab";
      updateProject(projectId, (t) =>
        t.contents[contentId]?.title === next
          ? t
          : patchContent(t, contentId, { title: next }),
      );
    },
    [updateProject],
  );

  const selectTab = useCallback(
    (projectId: string, paneId: string, contentId: string) => {
      updateProject(projectId, (t) => selectTabModel(t, paneId, contentId));
    },
    [updateProject],
  );

  const closeContentTab = useCallback(
    (projectId: string, contentId: string) => {
      updateProject(projectId, (t) => closeContent(t, contentId));
    },
    [updateProject],
  );

  const setFileDirty = useCallback(
    (projectId: string, relPath: string, dirty: boolean) => {
      updateProject(projectId, (t) => {
        const c = Object.values(t.contents).find(
          (x) => x.kind === "file" && x.relPath === relPath,
        );
        if (!c || !!c.dirty === dirty) return t;
        return patchContent(t, c.id, { dirty });
      });
    },
    [updateProject],
  );

  const focusPane = useCallback(
    (projectId: string, paneId: string) => {
      updateProject(projectId, (t) => focusPaneModel(t, paneId));
    },
    [updateProject],
  );

  const splitNewTerminal = useCallback(
    (projectId: string, paneId: string, side: DropSide) => {
      const id = newContentId();
      updateProject(projectId, (t) =>
        splitNewContent(t, paneId, terminalItem(t, id), side),
      );
    },
    [updateProject],
  );

  const moveTab = useCallback(
    (
      projectId: string,
      contentId: string,
      targetPaneId: string,
      index?: number,
    ) => {
      updateProject(projectId, (t) =>
        moveTabModel(t, contentId, targetPaneId, index),
      );
    },
    [updateProject],
  );

  const splitWithTab = useCallback(
    (
      projectId: string,
      targetPaneId: string,
      contentId: string,
      side: DropSide,
    ) => {
      updateProject(projectId, (t) =>
        splitWith(t, targetPaneId, contentId, side),
      );
    },
    [updateProject],
  );

  const resizePane = useCallback(
    (projectId: string, splitId: string, sizes: number[]) => {
      updateProject(projectId, (t) => resizeSplit(t, splitId, sizes));
    },
    [updateProject],
  );

  // Whether Meridian's window is focused. A tab only counts as "viewed" (no
  // attention needed) when it's visible AND the window is focused; when the app
  // is in the background, even the active tab warrants a system notification.
  const [windowFocused, setWindowFocused] = useState(true);
  const windowFocusedRef = useRef(windowFocused);
  windowFocusedRef.current = windowFocused;
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    const w = getCurrentWindow();
    void w
      .isFocused()
      .then(setWindowFocused)
      .catch(() => {});
    w.onFocusChanged(({ payload }) => setWindowFocused(payload))
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  // Ask for notification permission once at startup, while the window is focused
  // and the user is present. Otherwise the first (macOS) permission prompt would
  // appear only when a notification fires — which is always while the window is
  // unfocused — so the user would miss both the prompt and that first alert.
  // No-ops after the grant is cached (see ensureNotificationPermission).
  useEffect(() => {
    void ensureNotificationPermission();
  }, []);

  // Content ids we've already raised a system notification for this "episode"
  // (i.e. since the tab was last viewed). Prevents a duplicate toast when both
  // the Stop hook and the fallback title heuristic fire, and when several
  // notifications arrive before the user looks. Cleared on view (below).
  const notifiedRef = useRef<Set<string>>(new Set());

  // Claude (in `contentId` of `projectId`) finished its turn (`event: "stop"`)
  // or needs input (`event: "notification"`). Flags the tab's attention dot
  // unless it's currently viewed, and raises a system notification when the
  // window is unfocused. Driven by the Claude Code hooks (authoritative) and, as
  // a fallback, the terminal-title heuristic in TerminalPanel.
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const claudeAttention = useCallback(
    (projectId: string, contentId: string, event?: string) => {
      const t = tabsRef.current.find((x) => x.id === projectId);
      const c = t?.contents[contentId];
      if (!t || !c) return;
      const visible = t.root ? visibleContentIds(t.root) : [];
      const onScreen =
        projectId === activeTabIdRef.current && visible.includes(contentId);
      // Fully "viewed" (visible + focused) → nothing to signal at all.
      if (onScreen && windowFocusedRef.current) return;

      // Attention dot: pointless on the visible tab, useful everywhere else.
      if (!onScreen && !c.attention) {
        setTabs((prev) =>
          prev.map((x) =>
            x.id === projectId
              ? {
                  ...x,
                  contents: {
                    ...x.contents,
                    [contentId]: { ...x.contents[contentId], attention: true },
                  },
                }
              : x,
          ),
        );
      }

      // System notification only when the window is unfocused, at most once per
      // episode (see notifiedRef).
      if (!windowFocusedRef.current && !notifiedRef.current.has(contentId)) {
        notifiedRef.current.add(contentId);
        const what =
          event === "notification" ? "needs your input" : "finished its turn";
        void notifyAttention(`Claude ${what}`, t.name);
      }
    },
    [],
  );

  // A Claude hook fired: map the content id to its project and flag attention.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    onClaudeAttentionEvent(({ tab, event }) => {
      const project = tabsRef.current.find((t) => tab in t.contents);
      if (project) claudeAttention(project.id, tab, event);
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  }, [claudeAttention]);

  // Viewing a content clears its attention dot and notification record. A tab
  // only counts as viewed while the window is focused, so returning to the app
  // (refocus) re-arms notifications for its visible tabs. Clears every currently-
  // visible content of the active project (splits can show several at once).
  const activeProject = tabs.find((t) => t.id === activeTabId);
  const visibleKey = activeProject?.root
    ? visibleContentIds(activeProject.root).join(",")
    : "";
  useEffect(() => {
    if (activeTabId == null || !windowFocused) return;
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== activeTabId || !t.root) return t;
        const vis = visibleContentIds(t.root);
        let changed = false;
        const contents = { ...t.contents };
        for (const id of vis) {
          notifiedRef.current.delete(id);
          if (contents[id]?.attention) {
            contents[id] = { ...contents[id], attention: false };
            changed = true;
          }
        }
        return changed ? { ...t, contents } : t;
      }),
    );
  }, [activeTabId, visibleKey, windowFocused]);

  const restoredRef = useRef(false);

  // Restore the previous workspace on launch (projects + active project).
  useEffect(() => {
    const session = loadSession();
    if (session && session.projects.length > 0) {
      const restored: ProjectTab[] = session.projects.map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        scratch: p.scratch,
        paths: [],
        // Scratch spaces have no folder to read, so they're never "loading".
        loading: !p.scratch,
        contents: Object.fromEntries(p.contents.map((c) => [c.id, c])),
        root: p.root,
        activePaneId:
          p.root && p.activePaneId && findLeaf(p.root, p.activePaneId)
            ? p.activePaneId
            : p.root
              ? firstLeafId(p.root)
              : null,
      }));
      setTabs(restored);
      setActiveTabId(
        session.activeProjectId &&
          restored.some((t) => t.id === session.activeProjectId)
          ? session.activeProjectId
          : (restored[0]?.id ?? null),
      );
      for (const t of restored) {
        if (t.scratch) continue; // no folder → no favicon or file tree
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

  // Live file-tree updates: one recursive FS watcher per open project.
  const treeWatchersRef = useRef<Map<string, UnlistenFn>>(new Map());
  useEffect(() => {
    const watchers = treeWatchersRef.current;
    const present = new Set(tabs.map((t) => t.id));

    for (const t of tabs) {
      if (t.scratch) continue; // no folder to watch
      if (watchers.has(t.id)) continue;
      watchers.set(t.id, () => {});
      const { id, path } = t;
      void onProjectTreeChange(id, (paths) => {
        setTabs((prev) => prev.map((x) => (x.id === id ? { ...x, paths } : x)));
      }).then((unlisten) => {
        if (!treeWatchersRef.current.has(id)) {
          unlisten();
          return;
        }
        treeWatchersRef.current.set(id, unlisten);
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

  useEffect(() => {
    setObstruction("modal", settingsOpen || finderOpen);
  }, [settingsOpen, finderOpen]);

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

  // Shortcuts that must work even while typing in a terminal.
  //   Mod+D / Mod+Shift+D : split the focused pane (new terminal) right / down
  //   Mod+W               : close the focused pane's active tab
  //   Mod+B               : toggle the sidebar
  //   Mod+P / Mod+Shift+F : file finder / search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (finderOpen) return;
      const key = e.key.toLowerCase();
      const project = tabs.find((t) => t.id === activeTabId);
      const activePaneId = project?.activePaneId ?? null;
      const activePane =
        project?.root && activePaneId
          ? findLeaf(project.root, activePaneId)
          : null;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      };

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

      if (key === "f" && e.shiftKey) {
        if (!project) return;
        stop();
        newSearch(project.id);
        return;
      }

      if (key === "d") {
        if (!project || !activePaneId) return;
        stop();
        splitNewTerminal(
          project.id,
          activePaneId,
          e.shiftKey ? "down" : "right",
        );
        return;
      }

      if (key === "w") {
        if (!project || !activePane?.activeTabId) return;
        stop();
        closeContentTab(project.id, activePane.activeTabId);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [
    tabs,
    activeTabId,
    finderOpen,
    splitNewTerminal,
    closeContentTab,
    toggleSidebar,
    newSearch,
  ]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg text-fg">
      {(!verticalProjectTabs || tabs.length === 0) && (
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={setActiveTabId}
          onClose={closeTab}
          onReorder={reorderProjects}
          onOpenProject={openProject}
          onOpenScratch={openScratch}
          onOpenSettings={() => setSettingsOpen(true)}
          showProjectTabs={!verticalProjectTabs}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {verticalProjectTabs && tabs.length > 0 && (
          <ProjectRail
            tabs={tabs}
            activeTabId={activeTabId}
            iconsOnly={projectRailIconsOnly}
            onSelect={setActiveTabId}
            onClose={closeTab}
            onReorder={reorderProjects}
            onOpenProject={openProject}
            onOpenScratch={openScratch}
          />
        )}

        <div className="relative flex min-h-0 flex-1">
          {tabs.length === 0 ? (
            <EmptyState onOpenProject={openProject} />
          ) : (
            tabs.map((tab) => (
              <div
                key={tab.id}
                className={cn(
                  "absolute inset-0",
                  tab.id === activeTabId ? "flex" : "hidden",
                )}
              >
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
                    onCloseContent={closeContentTab}
                    onSelectTab={selectTab}
                    onFocusPane={focusPane}
                    onSplitNewTerminal={splitNewTerminal}
                    onResizePane={resizePane}
                    onFileDirtyChange={setFileDirty}
                    onBrowserUrlChange={setBrowserUrl}
                    onBrowserTitleChange={setBrowserTitle}
                    onOpenBrowserUrl={openBrowserUrl}
                    onPickElement={pickElement}
                    onClaudeAttention={claudeAttention}
                    onMoveTab={moveTab}
                    onSplitWithTab={splitWithTab}
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
          !!at?.root &&
          !!at.activePaneId &&
          (() => {
            const pane = findLeaf(at.root!, at.activePaneId!);
            const active = pane?.activeTabId
              ? at.contents[pane.activeTabId]
              : undefined;
            return active?.kind === "file";
          })();
        return (
          <StatusBar
            projectPath={at?.path}
            onFileTab={!!onFile}
            projectRoots={tabs.map((t) => t.path)}
            browserTabs={tabs.flatMap((t) =>
              Object.values(t.contents)
                .filter((c) => c.kind === "browser" && c.url)
                .map((c) => ({ url: c.url as string, root: t.path })),
            )}
          />
        );
      })()}

      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      )}

      <Toaster />

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
