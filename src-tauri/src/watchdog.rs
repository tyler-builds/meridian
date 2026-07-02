//! Native main-thread watchdog — the Rust-side counterpart of the frontend's
//! `watchdog.ts`. The JS watchdog runs in the WebView2 renderer, a separate
//! process, so it keeps ticking while the *native* main thread is blocked and
//! never sees that class of freeze. This one does: a background thread posts a
//! heartbeat closure to the main thread every second and logs when the pong
//! goes stale, along with which command (if any) is currently executing there —
//! sync `#[tauri::command]`s run on the main thread, so a stalled heartbeat
//! usually has a named culprit.
//!
//! Detection is intentionally cheap (one thread, one atomic, one queued closure
//! per second) so the watchdog can never contribute to the problem it watches.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::AppHandle;

/// The command currently executing on the calling thread of the invoke handler
/// (name + start time). Set/cleared around every command dispatch; only sync
/// commands hold it for their full duration (async ones dispatch and return),
/// which is exactly the set that can block the main thread.
static CURRENT: Mutex<Option<(String, Instant)>> = Mutex::new(None);

pub fn command_started(name: &str) {
    if let Ok(mut guard) = CURRENT.lock() {
        *guard = Some((name.to_string(), Instant::now()));
    }
}

pub fn command_finished(name: &str) {
    if let Ok(mut guard) = CURRENT.lock() {
        if guard.as_ref().is_some_and(|(n, _)| n == name) {
            *guard = None;
        }
    }
}

/// Heartbeat cadence, and the staleness that counts as a stall (mirrors the
/// frontend watchdog's thresholds).
const TICK: Duration = Duration::from_secs(1);
const STALL_MS: u64 = 2_000;
/// While a stall persists, re-log its growing duration this often — so a freeze
/// the user ends with Task Manager still leaves its last known length on disk.
const RELOG_MS: u64 = 10_000;

/// Start the watchdog thread. Call once from setup.
pub fn start(app: AppHandle) {
    let epoch = Instant::now();
    // Millis since `epoch` at which the main thread last ran our heartbeat.
    let pong = Arc::new(AtomicU64::new(0));

    std::thread::spawn(move || {
        // Start of the current stall (pong value when it began), if one is
        // ongoing, plus the staleness we last logged for it.
        let mut stalled_since: Option<u64> = None;
        let mut last_logged: u64 = 0;
        loop {
            let pong_writer = pong.clone();
            let _ = app.run_on_main_thread(move || {
                pong_writer.store(epoch.elapsed().as_millis() as u64, Ordering::Relaxed);
            });
            std::thread::sleep(TICK);

            let now = epoch.elapsed().as_millis() as u64;
            let last = pong.load(Ordering::Relaxed);
            let staleness = now.saturating_sub(last);

            if staleness > STALL_MS {
                let first = stalled_since.is_none();
                if first || staleness.saturating_sub(last_logged) >= RELOG_MS {
                    stalled_since.get_or_insert(last);
                    last_logged = staleness;
                    let cmd = CURRENT.lock().ok().and_then(|g| g.clone());
                    match cmd {
                        Some((name, started)) => log::error!(
                            "native watchdog: main thread unresponsive ~{staleness}ms; \
                             command '{name}' running for {}ms",
                            started.elapsed().as_millis()
                        ),
                        None => log::error!(
                            "native watchdog: main thread unresponsive ~{staleness}ms; \
                             no command executing (event-loop/webview work, or a \
                             callback such as emit/with_webview)"
                        ),
                    }
                }
            } else if let Some(since) = stalled_since.take() {
                last_logged = 0;
                log::warn!(
                    "native watchdog: main thread recovered after ~{}ms",
                    last.saturating_sub(since)
                );
            }
        }
    });
}
