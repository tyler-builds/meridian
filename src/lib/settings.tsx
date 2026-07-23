import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import {
  detectClaudePath,
  jiraConnect,
  jiraDisconnect,
  jiraStatus,
  listShells,
  type JiraStatus,
  type ShellInfo,
} from "@/lib/tauri";
import { persist } from "@/lib/persist";
import { DEFAULT_EDITOR_THEME } from "@/lib/monaco";

const STORAGE_KEY = "meridian.shell";

interface SettingsContextValue {
  /** True once the available shells have been queried from the backend. */
  loaded: boolean;
  shells: ShellInfo[];
  /** Selected shell program (e.g. "powershell.exe"), or null before load. */
  shellProgram: string | null;
  setShellProgram: (program: string) => void;
  /** Code editor: show the minimap. */
  showMinimap: boolean;
  setShowMinimap: (value: boolean) => void;
  /** Code editor: run Prettier on the active file before saving. */
  formatOnSave: boolean;
  setFormatOnSave: (value: boolean) => void;
  /** Code editor: active Monaco theme id (see EDITOR_THEMES). */
  editorTheme: string;
  setEditorTheme: (value: string) => void;
  /** Code editor: enable the TypeScript/JavaScript language server. */
  lspEnabled: boolean;
  setLspEnabled: (value: boolean) => void;
  /**
   * Code editor: open Markdown files as a rendered preview only (no editor,
   * no split toggle). Off by default — the editor with an optional split
   * preview is the normal mode.
   */
  markdownPreviewOnly: boolean;
  setMarkdownPreviewOnly: (value: boolean) => void;
  /** Run the `claude` command with --dangerously-skip-permissions. */
  dangerouslySkipPermissions: boolean;
  setDangerouslySkipPermissions: (value: boolean) => void;
  /**
   * User-specified absolute path to the `claude` binary. Empty means "auto":
   * use `detectedClaudePath` if found, else the bare `claude` command on PATH.
   * Set this when Claude tabs report "command not found".
   */
  claudePath: string;
  setClaudePath: (value: string) => void;
  /** Auto-detected `claude` path (backend probe), or "" if none was found. */
  detectedClaudePath: string;
  /** The path Claude tabs actually launch: `claudePath` if set, else detected. */
  effectiveClaudePath: string;
  /**
   * Let the in-app Claude see and control this app's embedded browser tabs via
   * the `@browser` MCP server (list/read tabs, navigate, click, screenshot).
   */
  browserMcpEnabled: boolean;
  setBrowserMcpEnabled: (value: boolean) => void;
  /**
   * Additionally expose the `eval_js` tool, letting Claude run arbitrary
   * JavaScript in a page. Powerful and risky (can read page secrets) — off by
   * default, independent of the master toggle.
   */
  browserMcpEvalJs: boolean;
  setBrowserMcpEvalJs: (value: boolean) => void;
  /**
   * Show project tabs as a vertical list on the far-left edge instead of a
   * horizontal strip in the title bar. Off by default (horizontal strip).
   */
  verticalProjectTabs: boolean;
  setVerticalProjectTabs: (value: boolean) => void;
  /**
   * When `verticalProjectTabs` is on, collapse the rail to a narrow icon-only
   * column (~48px): each project shows its favicon, or generated initials when
   * it has none, with no text label. Ignored in horizontal mode. Off by default.
   */
  projectRailIconsOnly: boolean;
  setProjectRailIconsOnly: (value: boolean) => void;
  /** Diff view: stacked (unified) vs side-by-side (split). */
  diffStyle: "unified" | "split";
  setDiffStyle: (value: "unified" | "split") => void;
  /** Diff view: wrap long lines instead of scrolling. */
  diffWrap: boolean;
  setDiffWrap: (value: boolean) => void;
  /** Diff view: ignore whitespace-only changes (re-runs git). */
  diffIgnoreWhitespace: boolean;
  setDiffIgnoreWhitespace: (value: boolean) => void;
  /** Jira connection status, or null before the first load. */
  jira: JiraStatus | null;
  /** True while a connect flow (browser consent) is in progress. */
  jiraConnecting: boolean;
  /** Re-read the connection status from the backend. */
  refreshJira: () => Promise<void>;
  /** Run the OAuth consent flow and update status. */
  connectJira: () => Promise<void>;
  /** Forget the Jira authorization. */
  disconnectJira: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [shellProgram, setShellProgramState] = useState<string | null>(() =>
    persist.getItem(STORAGE_KEY),
  );
  const [showMinimap, setShowMinimapState] = useState<boolean>(
    () => persist.getItem("meridian.showMinimap") !== "0",
  );
  // Off by default — formatting can rewrite a file the user didn't expect to
  // change, so it's opt-in.
  const [formatOnSave, setFormatOnSaveState] = useState<boolean>(
    () => persist.getItem("meridian.formatOnSave") === "1",
  );
  const [editorTheme, setEditorThemeState] = useState<string>(
    () => persist.getItem("meridian.editorTheme") ?? DEFAULT_EDITOR_THEME,
  );
  // On by default — provides project-wide types, diagnostics, and IntelliSense.
  const [lspEnabled, setLspEnabledState] = useState<boolean>(
    () => persist.getItem("meridian.lspEnabled") !== "0",
  );
  // Off by default — Markdown files open in the editor (with an optional split
  // preview); this makes them open as a rendered preview only.
  const [markdownPreviewOnly, setMarkdownPreviewOnlyState] = useState<boolean>(
    () => persist.getItem("meridian.markdownPreviewOnly") === "1",
  );
  // Off by default — this bypasses Claude's permission prompts.
  const [dangerouslySkipPermissions, setDangerSkipState] = useState<boolean>(
    () => persist.getItem("meridian.dangerouslySkipPermissions") === "1",
  );
  // Empty by default — the backend auto-detects `claude`. A non-empty value is
  // an explicit override (e.g. when the install lives off the resolved PATH).
  const [claudePath, setClaudePathState] = useState<string>(
    () => persist.getItem("meridian.claudePath") ?? "",
  );
  const [detectedClaudePath, setDetectedClaudePath] = useState<string>("");
  // On by default — gives the in-app Claude `@browser` access to the embedded
  // browser tabs (browser tools are auto-allowed per project; the localhost
  // endpoint is gated by a per-install secret).
  const [browserMcpEnabled, setBrowserMcpEnabledState] = useState<boolean>(
    () => persist.getItem("meridian.browserMcpEnabled") !== "0",
  );
  // Off by default — arbitrary JS execution in a page is the most dangerous tool.
  const [browserMcpEvalJs, setBrowserMcpEvalJsState] = useState<boolean>(
    () => persist.getItem("meridian.browserMcpEvalJs") === "1",
  );
  // Off by default — project tabs live in a horizontal strip in the title bar.
  const [verticalProjectTabs, setVerticalProjectTabsState] = useState<boolean>(
    () => persist.getItem("meridian.verticalProjectTabs") === "1",
  );
  // Off by default — the vertical rail shows project names alongside icons.
  const [projectRailIconsOnly, setProjectRailIconsOnlyState] = useState<boolean>(
    () => persist.getItem("meridian.projectRailIconsOnly") === "1",
  );
  // Diff view preferences (default: unified, no wrap, show whitespace).
  const [diffStyle, setDiffStyleState] = useState<"unified" | "split">(() =>
    persist.getItem("meridian.diffStyle") === "split" ? "split" : "unified",
  );
  const [diffWrap, setDiffWrapState] = useState<boolean>(
    () => persist.getItem("meridian.diffWrap") === "1",
  );
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespaceState] = useState<boolean>(
    () => persist.getItem("meridian.diffIgnoreWhitespace") === "1",
  );
  // Jira connection state lives in the backend (keychain-backed), so it's
  // fetched rather than read from `persist` like the preference settings above.
  const [jira, setJira] = useState<JiraStatus | null>(null);
  const [jiraConnecting, setJiraConnecting] = useState(false);

  useEffect(() => {
    let active = true;
    void jiraStatus()
      .then((s) => {
        if (active) setJira(s);
      })
      .catch(() => {
        /* not fatal — the Connections card just shows "not connected" */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void listShells().then((list) => {
      if (!active) return;
      setShells(list);
      setShellProgramState((current) => {
        // Keep the saved choice if it's still installed; otherwise fall back
        // to the first available shell.
        if (current && list.some((s) => s.program === current && s.available)) {
          return current;
        }
        const fallback = list.find((s) => s.available) ?? list[0];
        const program = fallback?.program ?? null;
        if (program) persist.setItem(STORAGE_KEY, program);
        return program;
      });
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  // Probe for the `claude` binary once on startup so the setting can show what
  // it found (and use it as the launch path when the user hasn't set one).
  useEffect(() => {
    let active = true;
    void detectClaudePath()
      .then((p) => {
        if (active) setDetectedClaudePath(p ?? "");
      })
      .catch(() => {
        /* detection is best-effort; the field falls back to bare `claude` */
      });
    return () => {
      active = false;
    };
  }, []);

  const setShellProgram = (program: string) => {
    persist.setItem(STORAGE_KEY, program);
    setShellProgramState(program);
  };

  const setClaudePath = (value: string) => {
    persist.setItem("meridian.claudePath", value);
    setClaudePathState(value);
  };

  const effectiveClaudePath = claudePath.trim() || detectedClaudePath;

  const setShowMinimap = (value: boolean) => {
    persist.setItem("meridian.showMinimap", value ? "1" : "0");
    setShowMinimapState(value);
  };

  const setFormatOnSave = (value: boolean) => {
    persist.setItem("meridian.formatOnSave", value ? "1" : "0");
    setFormatOnSaveState(value);
  };

  const setEditorTheme = (value: string) => {
    persist.setItem("meridian.editorTheme", value);
    setEditorThemeState(value);
  };

  const setLspEnabled = (value: boolean) => {
    persist.setItem("meridian.lspEnabled", value ? "1" : "0");
    setLspEnabledState(value);
  };

  const setMarkdownPreviewOnly = (value: boolean) => {
    persist.setItem("meridian.markdownPreviewOnly", value ? "1" : "0");
    setMarkdownPreviewOnlyState(value);
  };

  const setDangerouslySkipPermissions = (value: boolean) => {
    persist.setItem(
      "meridian.dangerouslySkipPermissions",
      value ? "1" : "0",
    );
    setDangerSkipState(value);
  };

  const setBrowserMcpEnabled = (value: boolean) => {
    persist.setItem("meridian.browserMcpEnabled", value ? "1" : "0");
    setBrowserMcpEnabledState(value);
  };

  const setBrowserMcpEvalJs = (value: boolean) => {
    persist.setItem("meridian.browserMcpEvalJs", value ? "1" : "0");
    setBrowserMcpEvalJsState(value);
  };

  const setVerticalProjectTabs = (value: boolean) => {
    persist.setItem("meridian.verticalProjectTabs", value ? "1" : "0");
    setVerticalProjectTabsState(value);
  };

  const setProjectRailIconsOnly = (value: boolean) => {
    persist.setItem("meridian.projectRailIconsOnly", value ? "1" : "0");
    setProjectRailIconsOnlyState(value);
  };

  const setDiffStyle = (value: "unified" | "split") => {
    persist.setItem("meridian.diffStyle", value);
    setDiffStyleState(value);
  };

  const setDiffWrap = (value: boolean) => {
    persist.setItem("meridian.diffWrap", value ? "1" : "0");
    setDiffWrapState(value);
  };

  const setDiffIgnoreWhitespace = (value: boolean) => {
    persist.setItem("meridian.diffIgnoreWhitespace", value ? "1" : "0");
    setDiffIgnoreWhitespaceState(value);
  };

  const refreshJira = async () => {
    setJira(await jiraStatus());
  };

  const connectJira = async () => {
    setJiraConnecting(true);
    try {
      // The backend reports connect failures in `status.error` rather than
      // rejecting, so a thrown error here is an unexpected/transport failure.
      setJira(await jiraConnect());
    } catch (e) {
      setJira((prev) =>
        prev ? { ...prev, error: String(e) } : prev,
      );
    } finally {
      setJiraConnecting(false);
    }
  };

  const disconnectJira = async () => {
    setJira(await jiraDisconnect());
  };

  return (
    <SettingsContext.Provider
      value={{
        loaded,
        shells,
        shellProgram,
        setShellProgram,
        showMinimap,
        setShowMinimap,
        formatOnSave,
        setFormatOnSave,
        editorTheme,
        setEditorTheme,
        lspEnabled,
        setLspEnabled,
        markdownPreviewOnly,
        setMarkdownPreviewOnly,
        verticalProjectTabs,
        setVerticalProjectTabs,
        projectRailIconsOnly,
        setProjectRailIconsOnly,
        dangerouslySkipPermissions,
        setDangerouslySkipPermissions,
        claudePath,
        setClaudePath,
        detectedClaudePath,
        effectiveClaudePath,
        browserMcpEnabled,
        setBrowserMcpEnabled,
        browserMcpEvalJs,
        setBrowserMcpEvalJs,
        diffStyle,
        setDiffStyle,
        diffWrap,
        setDiffWrap,
        diffIgnoreWhitespace,
        setDiffIgnoreWhitespace,
        jira,
        jiraConnecting,
        refreshJira,
        connectJira,
        disconnectJira,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
