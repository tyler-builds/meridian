/**
 * System notifications for Claude attention events (turn finished / needs input)
 * raised when the Meridian window is unfocused. Wraps the Tauri notification
 * plugin with a cached permission check, and always flashes the taskbar / bounces
 * the Dock as a reliable nudge even when OS notification permission is denied.
 */

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";

// null = not yet resolved. Cached so we don't hit the permission API on every
// notification (and so we prompt at most once).
let granted: boolean | null = null;

/** Resolve (and cache) whether we may post OS notifications, prompting once. */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (granted !== null) return granted;
  try {
    granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
  } catch {
    granted = false; // plugin unavailable (e.g. unsupported platform)
  }
  return granted;
}

/**
 * Raise a system notification and flash the taskbar (Windows) / bounce the Dock
 * (macOS). Best-effort: any failure is swallowed so a notification hiccup never
 * disrupts the app. Callers should gate on the window being unfocused.
 */
export async function notifyAttention(
  title: string,
  body: string,
): Promise<void> {
  // Taskbar/Dock attention is independent of notification permission — a
  // dependable cross-platform signal on its own. Informational is a single
  // flash/bounce (Critical would repeat until focus, which is too aggressive for
  // a turn-completion nudge).
  void getCurrentWindow()
    .requestUserAttention(UserAttentionType.Informational)
    .catch(() => {});
  try {
    if (await ensureNotificationPermission()) {
      sendNotification({ title, body });
    }
  } catch {
    /* notifications unavailable */
  }
}
