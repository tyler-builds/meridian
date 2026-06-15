import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { listShells, type ShellInfo } from "@/lib/tauri";
import { persist } from "@/lib/persist";

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
  /** Run the `claude` command with --dangerously-skip-permissions. */
  dangerouslySkipPermissions: boolean;
  setDangerouslySkipPermissions: (value: boolean) => void;
  /** Diff view: stacked (unified) vs side-by-side (split). */
  diffStyle: "unified" | "split";
  setDiffStyle: (value: "unified" | "split") => void;
  /** Diff view: wrap long lines instead of scrolling. */
  diffWrap: boolean;
  setDiffWrap: (value: boolean) => void;
  /** Diff view: ignore whitespace-only changes (re-runs git). */
  diffIgnoreWhitespace: boolean;
  setDiffIgnoreWhitespace: (value: boolean) => void;
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
  // Off by default — this bypasses Claude's permission prompts.
  const [dangerouslySkipPermissions, setDangerSkipState] = useState<boolean>(
    () => persist.getItem("meridian.dangerouslySkipPermissions") === "1",
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

  const setShellProgram = (program: string) => {
    persist.setItem(STORAGE_KEY, program);
    setShellProgramState(program);
  };

  const setShowMinimap = (value: boolean) => {
    persist.setItem("meridian.showMinimap", value ? "1" : "0");
    setShowMinimapState(value);
  };

  const setDangerouslySkipPermissions = (value: boolean) => {
    persist.setItem(
      "meridian.dangerouslySkipPermissions",
      value ? "1" : "0",
    );
    setDangerSkipState(value);
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

  return (
    <SettingsContext.Provider
      value={{
        loaded,
        shells,
        shellProgram,
        setShellProgram,
        showMinimap,
        setShowMinimap,
        dangerouslySkipPermissions,
        setDangerouslySkipPermissions,
        diffStyle,
        setDiffStyle,
        diffWrap,
        setDiffWrap,
        diffIgnoreWhitespace,
        setDiffIgnoreWhitespace,
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
