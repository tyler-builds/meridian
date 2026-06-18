import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { frontendLog } from "@/lib/tauri";

// The plugin modules are imported lazily (inside the actions) so a dev session,
// which never updates, doesn't pull them into the initial bundle.
type UpdateHandle = import("@tauri-apps/plugin-updater").Update;

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes: string | null }
  | { kind: "downloading"; version: string; pct: number | null }
  | { kind: "uptodate" }
  /** Running under `tauri dev` (or a non-packaged build) — nothing to update. */
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

interface UpdaterContextValue {
  status: UpdaterStatus;
  /** Check the release feed. `manual` surfaces "up to date"/errors in the UI. */
  check: (manual?: boolean) => Promise<void>;
  /** Download + install the pending update, then relaunch into it. */
  installAndRestart: () => Promise<void>;
}

const UpdaterContext = createContext<UpdaterContextValue | null>(null);

export function useUpdater(): UpdaterContextValue {
  const ctx = useContext(UpdaterContext);
  if (!ctx) throw new Error("useUpdater must be used within <UpdaterProvider>");
  return ctx;
}

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });
  // The pending Update handle from a successful check(), reused by install.
  const pending = useRef<UpdateHandle | null>(null);
  // Serialize check/install so an auto-check and a manual click can't overlap.
  const busy = useRef(false);

  const check = useCallback(async (manual = false) => {
    // The updater only works in a packaged build pointed at a real release
    // feed. Under `tauri dev` there's no target and checking would compare the
    // dev version against the latest release and offer to "update" it — wrong.
    if (!import.meta.env.PROD) {
      if (manual) setStatus({ kind: "unsupported" });
      return;
    }
    if (busy.current) return;
    busy.current = true;
    if (manual) setStatus({ kind: "checking" });
    try {
      const { check: runCheck } = await import("@tauri-apps/plugin-updater");
      const update = await runCheck();
      if (update) {
        pending.current = update;
        setStatus({
          kind: "available",
          version: update.version,
          notes: update.body ?? null,
        });
      } else {
        pending.current = null;
        if (manual) setStatus({ kind: "uptodate" });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      void frontendLog("warn", `update check failed: ${message}`);
      // A failed silent check stays silent (offline, no release yet, etc.);
      // only a user-initiated check shows the error.
      if (manual) setStatus({ kind: "error", message });
    } finally {
      busy.current = false;
    }
  }, []);

  const installAndRestart = useCallback(async () => {
    const update = pending.current;
    if (!update || busy.current) return;
    busy.current = true;
    setStatus({ kind: "downloading", version: update.version, pct: null });
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setStatus({
              kind: "downloading",
              version: update.version,
              pct: total > 0 ? Math.round((downloaded / total) * 100) : null,
            });
            break;
          case "Finished":
            setStatus({ kind: "downloading", version: update.version, pct: 100 });
            break;
        }
      });
      // Installed — relaunch into the new version. (On Windows the NSIS
      // installer may already restart the app; relaunch is harmless there.)
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      void frontendLog("error", `update install failed: ${message}`);
      setStatus({ kind: "error", message });
      busy.current = false; // recover; on success the process relaunches instead
    }
  }, []);

  // Silent check shortly after launch (production only). The small delay keeps
  // first paint snappy and lets the network settle before we hit GitHub.
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const t = setTimeout(() => void check(false), 4000);
    return () => clearTimeout(t);
  }, [check]);

  return (
    <UpdaterContext.Provider value={{ status, check, installAndRestart }}>
      {children}
    </UpdaterContext.Provider>
  );
}
