//! Windows-only: map WebView2 renderer processes to the page URLs they host, so
//! the Resource Manager can attribute each embedded browser tab's CPU/RAM to its
//! owning project instead of lumping all web content into "App core".
//!
//! WebView2 doesn't tell wry/Tauri which renderer process backs which webview,
//! but `ICoreWebView2Environment13::GetProcessExtendedInfos` lists every process
//! sharing our user-data folder along with the frame "source" URLs running in
//! each. We join those URLs to the known browser-tab URLs (host match) on the
//! Rust side. All WebView2 COM calls must happen on the UI thread, and the API
//! is async (completion-handler callback), so we refresh a shared cache that the
//! synchronous `resource_stats` command reads — one poll stale at worst.

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment13, ICoreWebView2ProcessExtendedInfoCollection, ICoreWebView2_2,
};
use webview2_com::{take_pwstr, GetProcessExtendedInfosCompletedHandler};
use windows_core::{Interface, BOOL, PWSTR};

/// (renderer pid, frame source URLs hosted in it).
pub type RendererInfo = (u32, Vec<String>);

/// Kick off an async refresh of the renderer→URLs map. Fire-and-forget: the
/// completion handler runs later on the UI thread and overwrites `out`. The
/// caller reads the previous snapshot, which is at most one poll stale.
pub fn refresh(app: &AppHandle, out: Arc<Mutex<Vec<RendererInfo>>>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // COM/WebView2 access must be on the UI thread; with_webview schedules there.
    let _ = window.with_webview(move |platform| unsafe {
        let _op = crate::watchdog::MainOpGuard::new("webview_procs::refresh");
        let controller = platform.controller();
        let Ok(core) = controller.CoreWebView2() else {
            return;
        };
        let Ok(core2) = core.cast::<ICoreWebView2_2>() else {
            return;
        };
        let Ok(env) = core2.Environment() else {
            return;
        };
        let Ok(env13) = env.cast::<ICoreWebView2Environment13>() else {
            return; // older WebView2 runtime — leave web content in App core
        };

        let handler = GetProcessExtendedInfosCompletedHandler::create(Box::new(
            move |result: windows_core::Result<()>,
                  collection: Option<ICoreWebView2ProcessExtendedInfoCollection>|
                  -> windows_core::Result<()> {
                let _op = crate::watchdog::MainOpGuard::new("webview_procs::refresh(callback)");
                if result.is_err() {
                    return Ok(());
                }
                // Already inside the outer `unsafe` block from `with_webview`,
                // which covers these COM calls in the handler body too.
                let mut renderers: Vec<RendererInfo> = Vec::new();
                if let Some(collection) = collection {
                    let mut count = 0u32;
                    if collection.Count(&mut count).is_ok() {
                        for i in 0..count {
                            let Ok(info) = collection.GetValueAtIndex(i) else {
                                continue;
                            };
                            let mut pid = 0i32;
                            let Ok(pinfo) = info.ProcessInfo() else {
                                continue;
                            };
                            if pinfo.ProcessId(&mut pid).is_err() {
                                continue;
                            }
                            // Only renderer processes carry associated frames; for
                            // browser/GPU/utility processes this collection is empty,
                            // so they fall through with no sources and are skipped.
                            let Ok(frames) = info.AssociatedFrameInfos() else {
                                continue;
                            };
                            let mut sources = Vec::new();
                            if let Ok(iter) = frames.GetIterator() {
                                let mut has = BOOL::default();
                                while iter.HasCurrent(&mut has).is_ok() && has.as_bool() {
                                    if let Ok(frame) = iter.GetCurrent() {
                                        let mut src = PWSTR::null();
                                        if frame.Source(&mut src).is_ok() && !src.is_null() {
                                            let s = take_pwstr(src);
                                            if !s.is_empty() {
                                                sources.push(s);
                                            }
                                        }
                                    }
                                    let mut next = BOOL::default();
                                    if iter.MoveNext(&mut next).is_err() {
                                        break;
                                    }
                                }
                            }
                            if !sources.is_empty() {
                                renderers.push((pid as u32, sources));
                            }
                        }
                    }
                }
                if let Ok(mut guard) = out.lock() {
                    *guard = renderers;
                }
                Ok(())
            },
        ));
        let _ = env13.GetProcessExtendedInfos(&handler);
    });
}
