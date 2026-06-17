import { frontendLog, ptyOutputWindow, resetPtyOutputWindow } from "./tauri";

// Freeze watchdog. Meridian's UI runs on a single JS thread; when something
// monopolizes it the whole app stops painting and responding. This module
// detects those stalls from inside the webview and writes them to Meridian's
// durable log file (via frontendLog -> the Rust `frontend_log` command), so a
// freeze can be reviewed AFTER the fact — the devtools console is unavailable
// once the app is wedged. It also records the likely CAUSE: the volume of
// terminal output in the window leading up to the stall (the dominant freeze
// vector) and the longest blocking task seen.
//
// Detection is intentionally cheap (one PerformanceObserver + one 1 s interval)
// so the watchdog can never itself contribute to the problem it watches for.

// A single task holding the thread longer than this is user-visible jank...
const JANK_TASK_MS = 200;
// ...and longer than this is effectively a freeze.
const FREEZE_TASK_MS = 1000;

// Heartbeat cadence and the lateness that counts as a stall. A 1 s interval
// that fires >2 s late means the event loop was blocked in between (e.g. across
// many tasks, or in native/IPC work a single long-task entry wouldn't capture).
const TICK_MS = 1000;
const STALL_MS = 2000;

let lastLongTaskMs = 0;
let lastLongTaskAt = 0;

/** Install the freeze detectors. Call once, as early as possible at startup. */
export function initFreezeWatchdog(): void {
  // 1. Long-task observer — catches a single synchronous block (a huge diff
  // highlight, a parse, a flood of `term.write`). Logged with the terminal
  // throughput in the current window so a build/stream that drove it is visible.
  if (typeof PerformanceObserver !== "undefined") {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const dur = Math.round(entry.duration);
          lastLongTaskMs = dur;
          lastLongTaskAt = performance.now();
          if (dur >= FREEZE_TASK_MS) {
            const { bytes, events } = ptyOutputWindow();
            void frontendLog(
              "error",
              `freeze: single task blocked UI thread ${dur}ms; ` +
                `pty ${bytes}B/${events}ev in window`,
            );
          } else if (dur >= JANK_TASK_MS) {
            void frontendLog("warn", `jank: task blocked UI thread ${dur}ms`);
          }
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
    } catch {
      /* longtask entry type unsupported in this webview build */
    }
  }

  // 2. Heartbeat drift detector — catches stalls the long-task observer misses
  // (work spread across many tasks, or native/IPC stalls). While the thread is
  // blocked this callback can't run; when it finally does, `drift` is how late
  // it was, i.e. roughly how long the app was frozen. The pty window is summed
  // across the stall, so it reports how much terminal output piled up during it.
  let expected = performance.now() + TICK_MS;
  setInterval(() => {
    const now = performance.now();
    const drift = now - expected;
    expected = now + TICK_MS;
    if (drift > STALL_MS) {
      const { bytes, events } = ptyOutputWindow();
      const sinceLong =
        lastLongTaskAt > 0 ? Math.round(now - lastLongTaskAt) : -1;
      void frontendLog(
        "error",
        `freeze: UI thread stalled ~${Math.round(drift)}ms; ` +
          `pty ${bytes}B/${events}ev during stall; ` +
          `last long task ${lastLongTaskMs}ms (${sinceLong}ms ago)`,
      );
    }
    // Reset the rolling window each tick so the numbers logged on a stall reflect
    // only the period leading up to (or spanning) it, not all-time totals.
    resetPtyOutputWindow();
  }, TICK_MS);
}
