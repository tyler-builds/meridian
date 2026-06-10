import { invoke } from "@tauri-apps/api/core";

/**
 * Durable key-value persistence backed by a JSON file in the app data dir
 * (via the `read_state`/`write_state` Rust commands), with a synchronous
 * localStorage mirror.
 *
 * Why not plain localStorage: it's scoped to the webview's page origin, which
 * differs between dev (`http://localhost:1420`) and packaged builds
 * (`http://tauri.localhost`), so switching builds appears to wipe everything.
 * The state file lives in the app data dir keyed by the app identifier, which
 * is identical across builds, so it survives that switch.
 *
 * The API mirrors localStorage (sync get/set/remove) so callers don't change
 * shape. Reads come from an in-memory cache hydrated once at startup by
 * `initPersistence()`; writes update the cache, mirror to localStorage
 * immediately, and debounce a write of the whole blob to the file.
 */

/** Keys we persist (used for one-time migration from localStorage). */
const KEYS = [
  "meridian.session",
  "meridian.shell",
  "meridian.showMinimap",
  "meridian.dangerouslySkipPermissions",
  "meridian.sidebarWidth",
  "meridian.sidebarCollapsed",
  "meridian.browserHistory",
];

let cache: Record<string, string> = {};
let ready = false;
let writeTimer: ReturnType<typeof setTimeout> | undefined;

async function readStateFile(): Promise<Record<string, string> | null> {
  try {
    const raw = await invoke<string | null>("read_state");
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return null;
  } catch {
    return null;
  }
}

function flush(): void {
  writeTimer = undefined;
  void invoke("write_state", { contents: JSON.stringify(cache) }).catch(() => {
    /* disk unavailable; the localStorage mirror still holds the data */
  });
}

function scheduleWrite(): void {
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 200);
}

/**
 * Hydrate the cache from the state file before the app renders. Any key the
 * file is missing is back-filled from this origin's localStorage — that both
 * migrates pre-existing data on first run and recovers data stranded in the
 * other origin's bucket the next time that build is launched.
 */
export async function initPersistence(): Promise<void> {
  const fromFile = await readStateFile();
  cache = fromFile ?? {};

  let changed = fromFile === null;
  for (const key of KEYS) {
    if (!(key in cache)) {
      const existing = window.localStorage.getItem(key);
      if (existing !== null) {
        cache[key] = existing;
        changed = true;
      }
    }
  }

  ready = true;
  if (changed) flush();

  // Best-effort flush of any pending write when the window is closing.
  window.addEventListener("pagehide", () => {
    if (writeTimer !== undefined) flush();
  });
}

export const persist = {
  getItem(key: string): string | null {
    if (ready && key in cache) return cache[key];
    return window.localStorage.getItem(key);
  },
  setItem(key: string, value: string): void {
    cache[key] = value;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* quota/unavailable; the file write below is the durable copy */
    }
    if (ready) scheduleWrite();
  },
  removeItem(key: string): void {
    delete cache[key];
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    if (ready) scheduleWrite();
  },
};
