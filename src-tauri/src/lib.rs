use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl,
};

mod jira;
mod mcp;
mod watchdog;
#[cfg(windows)]
mod webview_procs;

/// Work routed to a PTY session's dedicated writer thread.
enum PtyMsg {
    Data(Vec<u8>),
    Resize(PtySize),
}

/// A single running pseudo-terminal session.
///
/// Input and resizes go through `writer_tx` to a per-session writer thread that
/// owns the PTY master and writer. Writes into a ConPTY block indefinitely when
/// the child stops draining stdin (a paste into a busy program), and `pty_write`
/// is a sync command running on the main thread — writing there froze the whole
/// UI until the child read the input. The channel is unbounded, so a stalled
/// child just buffers the user's input in memory instead of the event loop.
struct PtySession {
    writer_tx: std::sync::mpsc::Sender<PtyMsg>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    /// The directory the shell was spawned in (the project root). Used by the
    /// resource monitor to attribute this terminal's CPU/RAM to a project.
    cwd: String,
}

/// Holds every live PTY keyed by a frontend-supplied id.
#[derive(Default)]
struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

/// One running language-server child process (keyed by project root path).
///
/// Outgoing messages go through `writer_tx` to a per-session writer thread that
/// owns the child's stdin. tsserver can stop reading stdin for long stretches
/// while it type-checks; once the pipe buffer fills, a write blocks — and
/// `lsp_send` is a sync command on the main thread, so writing there froze the
/// UI while the user typed. The writer thread absorbs that instead.
struct LspSession {
    child: std::process::Child,
    writer_tx: std::sync::mpsc::Sender<String>,
}

/// Holds every live language server keyed by project root path.
#[derive(Default)]
struct LspManager {
    sessions: Mutex<HashMap<String, LspSession>>,
}

/// The user's real login-shell `PATH`, resolved once at startup.
///
/// A GUI app launched from Finder/Dock inherits a minimal `PATH` that omits the
/// Homebrew/npm directories most CLI tools install into — those are added by
/// `~/.zprofile` (e.g. `eval "$(brew shellenv)"`), which only a *login* shell
/// sources. The PTY spawns its shell non-login, so `claude` and friends aren't
/// found even though they work in the user's own terminal. We resolve the real
/// `PATH` from the login shell once and inject it into every PTY. `None` on
/// Windows (GUI apps inherit the full `PATH` there) and when resolution fails or
/// times out — callers fall back to the inherited `PATH`.
#[derive(Default)]
struct ResolvedEnv {
    path: Mutex<Option<String>>,
}

const TREE_IGNORE: [&str; 8] = [
    "node_modules",
    ".git",
    "target",
    "dist",
    ".next",
    ".cache",
    ".turbo",
    ".venv",
];
const MAX_TREE_ENTRIES: usize = 20_000;

/// Recursively collect relative POSIX paths under `root`. Files are emitted as
/// plain paths; non-empty directories are derived by the tree from their files
/// (path-first model). An empty directory has no files to infer it from, so it
/// is emitted explicitly with a trailing slash — the tree's directory marker —
/// so empty dirs still appear.
fn walk(root: &Path, dir: &Path, out: &mut Vec<String>, depth: usize) {
    if depth > 12 || out.len() >= MAX_TREE_ENTRIES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_TREE_ENTRIES {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if TREE_IGNORE.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            let before = out.len();
            walk(root, &path, out, depth + 1);
            // The subtree added nothing, so it's empty: emit an explicit
            // trailing-slash directory entry so it still shows. Only the
            // shallowest empty dir in a chain needs emitting — its parents are
            // inferred from the slash-delimited path.
            if out.len() == before {
                if let Ok(rel) = path.strip_prefix(root) {
                    out.push(format!("{}/", rel.to_string_lossy().replace('\\', "/")));
                }
            }
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

/// Async + spawn_blocking: a full disk walk can take seconds on a big project,
/// and sync commands run on the main thread (blocking the UI).
#[tauri::command]
async fn read_project_tree(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::PathBuf::from(&path);
        if !root.is_dir() {
            return Err(format!("Not a directory: {path}"));
        }
        let mut out = Vec::new();
        walk(&root, &root, &mut out, 0);
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One project's watcher slot. `Pending` reserves the id while `watch_project_tree`
/// runs its seed walk (which can take seconds), so an unwatch arriving in that
/// window still has an entry to remove — otherwise the finished setup would
/// insert a watcher for an already-closed project and leak it until app exit.
enum TreeWatcher {
    Pending,
    Live(Debouncer<RecommendedWatcher>),
}

/// Holds one filesystem watcher per project (keyed by a frontend-supplied id).
/// Dropping a `Debouncer` stops its background thread and releases the OS
/// watch, so removing an entry is all that's needed to unwatch.
#[derive(Default)]
struct TreeWatcherManager {
    watchers: Mutex<HashMap<String, TreeWatcher>>,
}

/// True when a changed path is one the tree would actually show — i.e. it isn't
/// inside an ignored directory (node_modules/.git/build output). Mirrors `walk`'s
/// filter so routine git/build/install churn under those dirs doesn't trigger a
/// re-walk.
fn tree_path_relevant(root: &Path, changed: &Path) -> bool {
    let rel = changed.strip_prefix(root).unwrap_or(changed);
    !rel
        .components()
        .any(|c| TREE_IGNORE.iter().any(|&ig| ig == c.as_os_str().to_string_lossy().as_ref()))
}

/// Start watching a project root for filesystem changes and emit the refreshed
/// file list on `tree://change/{id}` whenever the set of paths changes. The
/// debouncer coalesces bursts; changes confined to ignored dirs, and edits that
/// don't alter the path set (a file's *contents* changing), are dropped so the
/// frontend tree isn't rebuilt needlessly. Idempotent per id.
#[tauri::command]
async fn watch_project_tree(
    app: AppHandle,
    state: State<'_, TreeWatcherManager>,
    id: String,
    path: String,
) -> Result<(), String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    // Reserve the id (atomically with the already-watched check) before the
    // slow seed walk, so an unwatch during setup has an entry to remove and the
    // insert below can tell the project was closed in the meantime.
    {
        let mut watchers = state.watchers.lock().unwrap();
        if watchers.contains_key(&id) {
            return Ok(());
        }
        watchers.insert(id.clone(), TreeWatcher::Pending);
    }

    // Seed the change-detection baseline with the current tree, walked off the
    // main thread (same reason `read_project_tree` is async): a full disk walk
    // can take seconds.
    let seed_root = root.clone();
    let seed = match tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        walk(&seed_root, &seed_root, &mut out, 0);
        out.sort();
        out
    })
    .await
    {
        Ok(seed) => seed,
        Err(e) => {
            state.watchers.lock().unwrap().remove(&id);
            return Err(e.to_string());
        }
    };
    let last: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(seed.clone()));

    let event_root = root.clone();
    let event_name = format!("tree://change/{id}");
    let app_handle = app.clone();

    let debouncer_result = new_debouncer(
        std::time::Duration::from_millis(300),
        move |res: DebounceEventResult| {
            // Errors (e.g. a watch-buffer overflow during a massive burst) are
            // skipped; the next change re-syncs.
            let Ok(events) = res else {
                return;
            };
            if !events
                .iter()
                .any(|e| tree_path_relevant(&event_root, &e.path))
            {
                return;
            }
            let mut out = Vec::new();
            walk(&event_root, &event_root, &mut out, 0);
            out.sort();
            let mut guard = last.lock().unwrap();
            if *guard == out {
                return; // only the contents of existing files changed
            }
            *guard = out.clone();
            drop(guard);
            let _ = app_handle.emit_to("main", &event_name, out);
        },
    );
    let mut debouncer = match debouncer_result {
        Ok(d) => d,
        Err(e) => {
            state.watchers.lock().unwrap().remove(&id);
            return Err(e.to_string());
        }
    };
    if let Err(e) = debouncer.watcher().watch(&root, RecursiveMode::Recursive) {
        state.watchers.lock().unwrap().remove(&id);
        return Err(e.to_string());
    }

    {
        let mut watchers = state.watchers.lock().unwrap();
        match watchers.get(&id) {
            // Still reserved — promote to the live watcher.
            Some(TreeWatcher::Pending) => {
                watchers.insert(id.clone(), TreeWatcher::Live(debouncer));
            }
            // Unwatched during setup — the project was closed. Drop the
            // debouncer off-thread (drop joins its worker) and don't emit.
            None => {
                drop(watchers);
                thread::spawn(move || drop(debouncer));
                return Ok(());
            }
            // Unreachable: only this function inserts, and a concurrent call
            // for the same id would have bailed on the Pending reservation.
            Some(TreeWatcher::Live(_)) => return Ok(()),
        }
    }

    // Emit the seed unconditionally: the frontend's tree came from an earlier
    // `read_project_tree` snapshot, and anything that changed between that walk
    // and this watcher attaching would otherwise match the baseline and never
    // be emitted — leaving the tree stale until the next disk change.
    let _ = app.emit_to("main", &format!("tree://change/{id}"), seed);
    Ok(())
}

/// Stop watching a project root and release its OS watch. Removing a `Pending`
/// entry (setup still running) is enough on its own: `watch_project_tree` sees
/// the missing reservation when it finishes and discards its watcher.
#[tauri::command]
fn unwatch_project_tree(state: State<TreeWatcherManager>, id: String) {
    if let Some(TreeWatcher::Live(watcher)) = state.watchers.lock().unwrap().remove(&id) {
        // Dropping a Debouncer joins its worker thread, which may be mid
        // full-disk walk of a large project — drop it off the main thread so
        // closing a project can't stall the UI for the rest of the walk.
        thread::spawn(move || drop(watcher));
    }
}

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Read a UTF-8 text file (project root + relative path) for the editor.
/// Async + spawn_blocking: files can be up to 5 MB and live on slow/network
/// disks — reading on the main thread stalls the UI.
#[tauri::command]
async fn read_file_text(root: String, rel: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut path = std::path::PathBuf::from(&root);
        path.push(&rel);
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > MAX_FILE_BYTES {
            return Err("File is too large to open in the editor".to_string());
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        String::from_utf8(bytes).map_err(|_| "Binary or non-UTF-8 file".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write text content to a file (project root + relative path).
#[tauri::command]
async fn write_file_text(root: String, rel: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut path = std::path::PathBuf::from(&root);
        path.push(&rel);
        std::fs::write(&path, content).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- Prettier (project-local) ---
//
// Format-on-save and the editor's Format Document command prefer the project's
// *own* installed Prettier so every config form is honored exactly as the
// project expects (JS/TS configs, plugins, `extends`, overrides, .prettierignore
// — none of which the bundled in-app formatter can do). When no local Prettier
// is found, the command reports `source: "none"` and the frontend falls back to
// the bundled standalone Prettier plus its own config resolver.

#[derive(serde::Serialize)]
struct PrettierResult {
    /// Formatted text, or null when no local Prettier could be run.
    formatted: Option<String>,
    /// "local" when the project's Prettier produced the output, else "none".
    source: String,
}

/// One config file found while walking up from the formatted file's directory.
#[derive(serde::Serialize)]
struct PrettierConfigFile {
    /// Path relative to the project root (POSIX separators).
    rel: String,
    contents: String,
}

/// Locate the project's Prettier entry script (`bin/prettier.cjs`) by walking up
/// from the file's directory, mirroring Node's `node_modules` resolution so a
/// monorepo's hoisted Prettier is found too. Bounded to avoid runaway walks.
fn find_local_prettier(start_dir: &Path) -> Option<PathBuf> {
    let mut dir = Some(start_dir);
    let mut hops = 0;
    while let Some(d) = dir {
        hops += 1;
        if hops > 64 {
            break;
        }
        for entry in ["bin/prettier.cjs", "bin/prettier.js"] {
            let candidate = d.join("node_modules").join("prettier").join(entry);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        dir = d.parent();
    }
    None
}

/// Format `content` as if it were the file at `path`, using the project's local
/// Prettier via `--stdin-filepath` (so Prettier resolves config, parser, and
/// ignore rules from that path). Rejects with Prettier's stderr on a parse error
/// so the caller can save the file unchanged.
#[tauri::command]
async fn prettier_format(path: String, content: String) -> Result<PrettierResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file_path = PathBuf::from(&path);
        let file_dir = file_path.parent().unwrap_or(Path::new(".")).to_path_buf();

        let Some(entry) = find_local_prettier(&file_dir) else {
            return Ok(PrettierResult {
                formatted: None,
                source: "none".to_string(),
            });
        };

        let mut cmd = Command::new("node");
        cmd.arg(&entry)
            .arg("--stdin-filepath")
            .arg(&file_path)
            .current_dir(&file_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut cmd);
        let spawned = cmd.spawn();

        // Node missing from PATH (or unlaunchable) is not fatal — fall back to
        // the bundled formatter rather than surfacing an error.
        let Ok(mut child) = spawned else {
            return Ok(PrettierResult {
                formatted: None,
                source: "none".to_string(),
            });
        };

        // Write stdin on a separate thread so a large formatted result filling
        // the stdout pipe can't deadlock us while we're still writing stdin.
        if let Some(mut stdin) = child.stdin.take() {
            thread::spawn(move || {
                let _ = stdin.write_all(content.as_bytes());
                // `stdin` drops here, closing the pipe so Prettier can finish.
            });
        }

        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if output.status.success() {
            let formatted = String::from_utf8(output.stdout)
                .map_err(|_| "Prettier returned non-UTF-8 output".to_string())?;
            Ok(PrettierResult {
                formatted: Some(formatted),
                source: "local".to_string(),
            })
        } else {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if err.is_empty() {
                "Prettier failed".to_string()
            } else {
                err
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Collect declarative Prettier config files (nearest first) by walking up from
/// the formatted file's directory to the project root. Used only by the bundled
/// fallback formatter; the frontend parses and merges them. JS/TS configs are
/// intentionally omitted — they can't be evaluated without the project's
/// Prettier, which the fallback path is precisely the absence of.
#[tauri::command]
fn read_prettier_config_files(root: String, rel: String) -> Result<Vec<PrettierConfigFile>, String> {
    const NAMES: [&str; 6] = [
        "package.json",
        ".prettierrc",
        ".prettierrc.json",
        ".prettierrc.json5",
        ".prettierrc.yaml",
        ".prettierrc.yml",
    ];
    const MAX_CONFIG_BYTES: u64 = 256 * 1024;

    let root_path = PathBuf::from(&root);
    let mut start = root_path.clone();
    start.push(&rel);
    let start_dir = start.parent().unwrap_or(&root_path).to_path_buf();

    let mut out = Vec::new();
    let mut dir = Some(start_dir.as_path());
    let mut hops = 0;
    while let Some(d) = dir {
        hops += 1;
        if hops > 64 {
            break;
        }
        for name in NAMES {
            let p = d.join(name);
            let Ok(meta) = std::fs::metadata(&p) else {
                continue;
            };
            if !meta.is_file() || meta.len() > MAX_CONFIG_BYTES {
                continue;
            }
            if let Ok(bytes) = std::fs::read(&p) {
                if let Ok(text) = String::from_utf8(bytes) {
                    if let Ok(relp) = p.strip_prefix(&root_path) {
                        out.push(PrettierConfigFile {
                            rel: relp.to_string_lossy().replace('\\', "/"),
                            contents: text,
                        });
                    }
                }
            }
        }
        if d == root_path {
            break;
        }
        dir = d.parent();
    }
    Ok(out)
}

// --- Project favicon (mirrors pingdotgg/t3code's ProjectFaviconResolver) ---

/// Well-known favicon paths checked in order.
const FAVICON_CANDIDATES: [&str; 21] = [
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "public/favicon.svg",
    "public/favicon.ico",
    "public/favicon.png",
    "app/favicon.ico",
    "app/favicon.png",
    "app/icon.svg",
    "app/icon.png",
    "app/icon.ico",
    "src/favicon.ico",
    "src/favicon.svg",
    "src/app/favicon.ico",
    "src/app/icon.svg",
    "src/app/icon.png",
    "assets/icon.svg",
    "assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
    ".idea/icon.svg",
];

/// Files that may declare a `<link rel="icon">` (HTML) or icon metadata (object).
const ICON_SOURCE_FILES: [&str; 7] = [
    "index.html",
    "public/index.html",
    "app/routes/__root.tsx",
    "src/routes/__root.tsx",
    "app/root.tsx",
    "src/root.tsx",
    "src/index.html",
];

const MAX_FAVICON_BYTES: u64 = 512 * 1024;

fn favicon_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

fn favicon_data_url(path: &Path) -> Option<String> {
    use base64::Engine;
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FAVICON_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", favicon_mime(path), encoded))
}

/// Read the value of `href="..."` / `href='...'` from a single `<link ...>` tag.
fn tag_attr(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(rel) = lower[from..].find(attr) {
        let i = from + rel;
        let after = tag[i + attr.len()..].trim_start();
        if let Some(rest) = after.strip_prefix('=') {
            let rest = rest.trim_start();
            let quote = rest.chars().next();
            if quote == Some('"') || quote == Some('\'') {
                let q = quote.unwrap();
                if let Some(end) = rest[1..].find(q) {
                    return Some(rest[1..=end].to_string());
                }
            }
        }
        from = i + attr.len();
    }
    None
}

/// Extract an icon href from HTML `<link rel="icon">` or object-style metadata.
fn extract_icon_href(source: &str) -> Option<String> {
    let lower = source.to_ascii_lowercase();

    // HTML <link rel="icon"|"shortcut icon" href="...">
    let mut from = 0;
    while let Some(rel) = lower[from..].find("<link") {
        let start = from + rel;
        let end = lower[start..]
            .find('>')
            .map(|e| start + e + 1)
            .unwrap_or(source.len());
        let tag = &source[start..end];
        let tag_lower = &lower[start..end];
        let is_icon = tag_lower.contains("rel=\"icon\"")
            || tag_lower.contains("rel='icon'")
            || tag_lower.contains("rel=\"shortcut icon\"")
            || tag_lower.contains("rel='shortcut icon'");
        if is_icon {
            if let Some(href) = tag_attr(tag, "href") {
                let clean = href.split('?').next().unwrap_or(&href).trim();
                if !clean.is_empty() {
                    return Some(clean.to_string());
                }
            }
        }
        from = end;
    }

    // Object-style metadata: { rel: "icon", href: "..." } (TanStack/Remix).
    let compact: String = source.chars().filter(|c| !c.is_whitespace()).collect();
    let needle = compact.find("rel:\"icon\"").or_else(|| compact.find("rel:'icon'"));
    if let Some(idx) = needle {
        if let Some(hpos) = compact[idx..].find("href:") {
            let rest = &compact[idx + hpos + "href:".len()..];
            let quote = rest.chars().next();
            if quote == Some('"') || quote == Some('\'') {
                let q = quote.unwrap();
                if let Some(end) = rest[1..].find(q) {
                    let href = &rest[1..=end];
                    let clean = href.split('?').next().unwrap_or(href).trim();
                    if !clean.is_empty() {
                        return Some(clean.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Resolve a project's favicon to a data URL, or null if none is found.
#[tauri::command]
fn find_project_favicon(root: String) -> Option<String> {
    let base = std::path::PathBuf::from(&root);

    for candidate in FAVICON_CANDIDATES {
        let path = base.join(candidate);
        if path.is_file() {
            if let Some(url) = favicon_data_url(&path) {
                return Some(url);
            }
        }
    }

    for source_file in ICON_SOURCE_FILES {
        let source_path = base.join(source_file);
        let Ok(source) = std::fs::read_to_string(&source_path) else {
            continue;
        };
        let Some(href) = extract_icon_href(&source) else {
            continue;
        };
        let clean = href.trim_start_matches('/');
        for candidate in [base.join("public").join(clean), base.join(clean)] {
            if candidate.is_file() {
                if let Some(url) = favicon_data_url(&candidate) {
                    return Some(url);
                }
            }
        }
    }

    None
}

/// The current git branch for a project root, or None if it isn't a git repo.
/// Reads `.git/HEAD` directly (no git binary or dependency); falls back to a
/// short commit hash for a detached HEAD.
#[tauri::command]
fn git_current_branch(path: String) -> Option<String> {
    let root = std::path::PathBuf::from(&path);
    let git = root.join(".git");
    let git_dir = if git.is_dir() {
        git
    } else if git.is_file() {
        // Worktrees/submodules store ".git" as a file: "gitdir: <path>".
        let content = std::fs::read_to_string(&git).ok()?;
        let rest = content.lines().next()?.strip_prefix("gitdir:")?.trim();
        let p = std::path::PathBuf::from(rest);
        if p.is_absolute() {
            p
        } else {
            root.join(p)
        }
    } else {
        return None;
    };

    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(branch) = head.strip_prefix("ref: refs/heads/") {
        Some(branch.to_string())
    } else if head.len() >= 7 {
        // Detached HEAD — show a short commit hash.
        Some(head[..7].to_string())
    } else {
        None
    }
}

/// Apply the Windows CREATE_NO_WINDOW flag so spawning a child process doesn't
/// flash (or leave open) a console window. No-op on other platforms. Use this
/// for every child process we launch — `git`, `node`, the language server — so
/// none of them surface a stray terminal in the packaged app.
fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run `git` inside `root` and capture its output. On Windows the
/// CREATE_NO_WINDOW flag keeps a console from flashing on each invocation.
fn run_git(root: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(root).args(args);
    // Never let git block on an interactive auth/credential prompt: with no TTY
    // (and CREATE_NO_WINDOW on Windows) such a prompt can't be answered and
    // would hang. Force git to fail fast instead so the error surfaces in the UI.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    hide_console(&mut cmd);
    cmd.output().map_err(|e| e.to_string())
}

/// Unified diff of the current working-tree changes for a project root: tracked
/// changes (staged + unstaged) against HEAD, followed by untracked files shown
/// as additions. When `ignore_whitespace` is set, whitespace-only changes are
/// dropped from the tracked diff (`-w`). Returns an empty string when there are
/// no changes. Errs when the path isn't a git work tree or `git` isn't
/// available.
/// Async + spawn_blocking: spawns one `git diff --no-index` per untracked file,
/// which on the main thread would freeze the UI for large change sets.
#[tauri::command]
async fn git_diff(path: String, ignore_whitespace: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_blocking(&path, ignore_whitespace))
        .await
        .map_err(|e| e.to_string())?
}

fn git_diff_blocking(path: &str, ignore_whitespace: bool) -> Result<String, String> {
    // Confirm it's a work tree; this also surfaces "git not installed".
    let check = run_git(path, &["rev-parse", "--is-inside-work-tree"])?;
    if !check.status.success() {
        let err = String::from_utf8_lossy(&check.stderr);
        let err = err.trim();
        return Err(if err.is_empty() {
            "Not a git repository".to_string()
        } else {
            err.to_string()
        });
    }

    // Tracked changes vs HEAD. In a repo with no commits yet `diff HEAD` fails,
    // so fall back to a plain `diff` (index vs working tree).
    let mut tracked_args = vec!["diff"];
    if ignore_whitespace {
        tracked_args.push("-w");
    }
    let mut head_args = tracked_args.clone();
    head_args.push("HEAD");
    let tracked = run_git(path, &head_args)?;
    let mut patch = if tracked.status.success() {
        String::from_utf8_lossy(&tracked.stdout).into_owned()
    } else {
        let plain = run_git(path, &tracked_args)?;
        String::from_utf8_lossy(&plain.stdout).into_owned()
    };

    // Append untracked files as additions so new files appear in the diff.
    // `--no-index` exits non-zero when files differ (the normal case here), so
    // its status is ignored — only stdout matters.
    let untracked = run_git(path, &["ls-files", "--others", "--exclude-standard"])?;
    if untracked.status.success() {
        let list = String::from_utf8_lossy(&untracked.stdout).into_owned();
        for file in list.lines().filter(|l| !l.trim().is_empty()) {
            let out = run_git(path, &["diff", "--no-index", "--", "/dev/null", file])?;
            patch.push_str(&String::from_utf8_lossy(&out.stdout));
        }
    }

    Ok(patch)
}

/// Run `git` inside `root` and return trimmed stdout, or None if it failed.
/// Used for the small read-only queries that make up the status header.
fn git_str(root: &str, args: &[&str]) -> Option<String> {
    let out = run_git(root, args).ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

/// Run `git` inside `root` and map a non-zero exit to its stderr as an `Err`.
/// Used for the mutating commands (stage/unstage/commit/push) so failures
/// surface a useful message in the UI.
fn run_git_checked(root: &str, args: &[&str]) -> Result<String, String> {
    let out = run_git(root, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        Err(if err.is_empty() {
            "git command failed".to_string()
        } else {
            err.to_string()
        })
    }
}

/// One changed path in the working tree. `index`/`worktree` are the porcelain
/// XY status codes (e.g. "M", "A", "D", "?", "U"); `staged` means the index
/// side has a change, and a path modified in both index and working tree
/// reports a code on each side (so the UI can list it under both groups).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFileStatus {
    path: String,
    index: String,
    worktree: String,
    staged: bool,
    untracked: bool,
    conflicted: bool,
}

/// Working-tree status plus the branch/remote context the Git panel needs to
/// decide between the Commit and Push actions.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatus {
    files: Vec<GitFileStatus>,
    /// Current branch name, or None on a detached HEAD.
    branch: Option<String>,
    detached: bool,
    /// Commits the local branch is ahead of / behind its upstream.
    ahead: u32,
    behind: u32,
    has_upstream: bool,
    has_remote: bool,
    /// Whether HEAD resolves (false in a fresh repo with no commits yet).
    has_commits: bool,
    /// Local commits not on any remote — the number a push would send. Defined
    /// even before the first push (when `ahead` is 0 for lack of an upstream),
    /// and 0 when there is nothing to push.
    unpushed: u32,
}

/// Structured status for the Git panel: the changed-file list (parsed from
/// `git status --porcelain=v1 -z`) plus branch/upstream/ahead-behind context.
/// Errs when the path isn't a git work tree or `git` isn't available.
/// Async + spawn_blocking: the status bar polls this every 5s and it spawns a
/// handful of git subprocesses; on the main thread each poll stalled the UI.
#[tauri::command]
async fn git_status(path: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_blocking(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn git_status_blocking(path: &str) -> Result<GitStatus, String> {
    let check = run_git(path, &["rev-parse", "--is-inside-work-tree"])?;
    if !check.status.success() {
        let err = String::from_utf8_lossy(&check.stderr);
        let err = err.trim();
        return Err(if err.is_empty() {
            "Not a git repository".to_string()
        } else {
            err.to_string()
        });
    }

    // NUL-delimited porcelain v1. Each entry is "XY <path>"; rename/copy entries
    // are followed by a separate token for the original path, which we consume.
    // `--untracked-files=all` lists each new file individually rather than
    // collapsing a wholly-untracked directory into one entry — otherwise a new
    // folder of N files reports as a single addition (and the diff panel, which
    // uses `ls-files --others`, would disagree with the file list / counter).
    let out = run_git(path, &["status", "--porcelain=v1", "--untracked-files=all", "-z"])?;
    let raw = String::from_utf8_lossy(&out.stdout);
    let mut tokens = raw.split('\0');
    let mut files = Vec::new();
    while let Some(entry) = tokens.next() {
        if entry.len() < 3 {
            continue;
        }
        let bytes = entry.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let file_path = entry[3..].to_string();
        // A rename/copy carries the source path in the following token.
        if x == 'R' || x == 'C' {
            let _ = tokens.next();
        }
        let untracked = x == '?' && y == '?';
        let conflicted = x == 'U'
            || y == 'U'
            || (x == 'A' && y == 'A')
            || (x == 'D' && y == 'D');
        let staged = !untracked && x != ' ';
        files.push(GitFileStatus {
            path: file_path,
            index: x.to_string(),
            worktree: y.to_string(),
            staged,
            untracked,
            conflicted,
        });
    }

    let has_commits = run_git(path, &["rev-parse", "--verify", "HEAD"])
        .map(|o| o.status.success())
        .unwrap_or(false);
    let branch = git_str(path, &["symbolic-ref", "--short", "HEAD"]);
    let detached = branch.is_none() && has_commits;
    let has_remote = git_str(path, &["remote"])
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let has_upstream = git_str(
        path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .is_some();

    // `git rev-list --left-right --count @{u}...HEAD` prints "<behind>\t<ahead>".
    let (mut ahead, mut behind) = (0u32, 0u32);
    if has_upstream {
        if let Some(counts) =
            git_str(path, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])
        {
            let mut parts = counts.split_whitespace();
            behind = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
            ahead = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        }
    }

    // Commits on HEAD not reachable from any remote-tracking branch — what a
    // push would actually send. Unlike `ahead` (which requires an upstream)
    // this is meaningful before the first push and is 0 when nothing is
    // unpushed, so the Source Control button can show a count and won't offer
    // to push an unchanged branch. Gated on a remote: with none configured,
    // `--remotes` expands to nothing and the count would be every commit.
    let unpushed = if has_commits && has_remote {
        git_str(path, &["rev-list", "--count", "HEAD", "--not", "--remotes"])
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0)
    } else {
        0
    };

    Ok(GitStatus {
        files,
        branch,
        detached,
        ahead,
        behind,
        has_upstream,
        has_remote,
        has_commits,
        unpushed,
    })
}

/// Stage the given paths (`git add`). A no-op when the list is empty.
/// Async + spawn_blocking (like every command that spawns git): a git run on
/// the main thread stalls the UI for the whole subprocess.
#[tauri::command]
async fn git_stage(path: String, files: Vec<String>) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<&str> = vec!["add", "--"];
        args.extend(files.iter().map(String::as_str));
        run_git_checked(&path, &args).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Unstage the given paths. Uses `git restore --staged` normally, falling back
/// to `git rm --cached` in a fresh repo with no commits (where there's no HEAD
/// for `restore` to resolve against). A no-op when the list is empty.
#[tauri::command]
async fn git_unstage(path: String, files: Vec<String>) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let has_head = run_git(&path, &["rev-parse", "--verify", "HEAD"])
            .map(|o| o.status.success())
            .unwrap_or(false);
        let mut args: Vec<&str> = if has_head {
            vec!["restore", "--staged", "--"]
        } else {
            vec!["rm", "--cached", "--quiet", "--"]
        };
        args.extend(files.iter().map(String::as_str));
        run_git_checked(&path, &args).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Commit the staged changes with `message`. Rejects an empty message.
/// Async + spawn_blocking: commit hooks (husky/lint-staged) can run for
/// seconds to minutes — on the main thread that froze the app for the
/// entire hook run.
#[tauri::command]
async fn git_commit(path: String, message: String) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Commit message is empty".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        run_git_checked(&path, &["commit", "-m", &message]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Push the current branch. When the branch has no upstream yet, push with
/// `-u` to the `origin` remote (or the first remote if `origin` is absent),
/// which sets the upstream for subsequent pushes. Runs async so a slow network
/// push doesn't block the UI thread; `GIT_TERMINAL_PROMPT=0` keeps an
/// unauthenticated push from hanging (it errors with the git message instead).
#[tauri::command]
async fn git_push(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let has_upstream = run_git(
            &path,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        )
        .map(|o| o.status.success())
        .unwrap_or(false);

        if has_upstream {
            return run_git_checked(&path, &["push"]).map(|_| ());
        }

        let branch = git_str(&path, &["symbolic-ref", "--short", "HEAD"])
            .ok_or_else(|| "Not on a branch (detached HEAD)".to_string())?;
        let remotes = git_str(&path, &["remote"]).unwrap_or_default();
        let remote = remotes
            .lines()
            .find(|r| *r == "origin")
            .or_else(|| remotes.lines().next())
            .ok_or_else(|| "No git remote configured".to_string())?
            .to_string();
        run_git_checked(&path, &["push", "-u", &remote, &branch]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pull the current branch from its upstream (`git pull --no-edit`, so a merge
/// commit is created non-interactively rather than opening an editor and
/// hanging). Runs async so a slow network fetch doesn't block the UI thread;
/// `GIT_TERMINAL_PROMPT=0` keeps an unauthenticated pull from hanging. Git's own
/// error (e.g. local changes would be overwritten, or merge conflicts) is
/// surfaced to the caller. The caller is expected to gate this on a clean
/// working tree, but git's overwrite protection is the real backstop.
#[tauri::command]
async fn git_pull(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let has_upstream = run_git(
            &path,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        )
        .map(|o| o.status.success())
        .unwrap_or(false);
        if !has_upstream {
            return Err("No upstream branch to pull from".to_string());
        }
        run_git_checked(&path, &["pull", "--no-edit"]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch from the remote so the local ahead/behind counts reflect the latest
/// upstream, without touching the working tree. Prunes deleted remote branches.
/// Runs async (network) with `GIT_TERMINAL_PROMPT=0` so an unauthenticated
/// fetch fails fast instead of hanging. Errs when there's no remote configured.
#[tauri::command]
async fn git_fetch(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let has_remote = git_str(&path, &["remote"])
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        if !has_remote {
            return Err("No git remote configured".to_string());
        }
        run_git_checked(&path, &["fetch", "--prune"]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Commit subjects (one per entry, newest first) of the local commits a push
/// would send: those on HEAD not yet on the upstream, or — before the first
/// push — not on any remote-tracking branch. Empty when there's no remote or
/// nothing to push. Runs locally (no network), so it's cheap to poll.
#[tauri::command]
async fn git_unpushed_commits(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || git_unpushed_commits_blocking(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn git_unpushed_commits_blocking(path: &str) -> Result<Vec<String>, String> {
    let has_remote = git_str(path, &["remote"])
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if !has_remote {
        return Ok(Vec::new());
    }
    let has_upstream = git_str(
        path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .is_some();
    // With an upstream, what a push sends is `@{u}..HEAD`. Without one (the
    // first-push case), it's every commit not already on a remote — the same
    // set `--not --remotes` counts for the `unpushed` field.
    let out = if has_upstream {
        run_git(path, &["log", "--format=%s", "@{u}..HEAD"])?
    } else {
        run_git(path, &["log", "--format=%s", "HEAD", "--not", "--remotes"])?
    };
    if !out.status.success() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text
        .lines()
        .map(|l| l.to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// Local branch names, ordered by most-recent commit first (the same order the
/// branch switcher shows). Errs when the path isn't a git work tree.
#[tauri::command]
async fn git_branches(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = run_git_checked(
            &path,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname:short)",
                "refs/heads",
            ],
        )?;
        Ok(out
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Switch to `branch`. When `create` is set, make it first (`checkout -b`) so a
/// brand-new branch is created off the current HEAD and checked out. Git's own
/// error (e.g. local changes would be overwritten) is surfaced to the caller.
#[tauri::command]
async fn git_checkout(path: String, branch: String, create: bool) -> Result<(), String> {
    if branch.trim().is_empty() {
        return Err("Branch name is empty".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = branch.trim();
        let args: Vec<&str> = if create {
            vec!["checkout", "-b", trimmed]
        } else {
            vec!["checkout", trimmed]
        };
        run_git_checked(&path, &args).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Path to the persisted app-state file in the app data dir. The directory is
/// keyed by the app identifier, so it's the same for dev and packaged builds —
/// unlike webview localStorage, which is scoped to the (differing) page origin.
fn state_file_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
}

/// Read the persisted app state (a JSON blob), or None if it doesn't exist yet.
#[tauri::command]
fn read_state(app: AppHandle) -> Result<Option<String>, String> {
    let path = state_file_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write the persisted app state (a JSON blob).
#[tauri::command]
fn write_state(app: AppHandle, contents: String) -> Result<(), String> {
    let path = state_file_path(&app)?;
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        "powershell.exe".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// The current user's home directory, used to probe well-known install paths.
fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// Resolve the user's real login-shell `PATH` (see `ResolvedEnv`). Runs the
/// login shell as an *interactive login* shell (`-ilc`) so it sources both
/// `~/.zprofile` (Homebrew's `PATH`) and `~/.zshrc`, then prints `$PATH` behind a
/// sentinel so profile chatter — banners, the `oh-my-posh`/autosuggestions errors
/// seen in the wild — can't corrupt the value. Guarded by a timeout so a hanging
/// profile can't block startup. `None` on Windows, on timeout, or on any failure.
#[cfg(not(target_os = "windows"))]
fn resolve_login_path() -> Option<String> {
    use std::sync::mpsc;

    const SENTINEL: &str = "__MERIDIAN_PATH__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // Run the probe off-thread so a misbehaving profile (one that blocks on
    // input or never returns) can't hang the resolver past the timeout below.
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let script = format!("printf '%s%s\\n' '{SENTINEL}' \"$PATH\"");
        let out = Command::new(&shell)
            .args(["-ilc", &script])
            .stdin(Stdio::null())
            .output();
        let _ = tx.send(out);
    });

    let output = rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .ok()?
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let path = stdout
        .lines()
        .find_map(|line| line.strip_prefix(SENTINEL))?
        .trim()
        .to_string();
    (!path.is_empty()).then_some(path)
}

#[cfg(target_os = "windows")]
fn resolve_login_path() -> Option<String> {
    None
}

/// A shell the user can choose for new terminals.
#[derive(serde::Serialize)]
struct ShellInfo {
    /// Stable id used by the frontend setting.
    id: String,
    /// Human-readable label.
    label: String,
    /// Executable resolved on PATH (passed back to `pty_spawn` as `shell`).
    program: String,
    /// Whether the executable was found on this machine.
    available: bool,
}

/// Candidate shells per platform: (id, label, program).
fn shell_candidates() -> &'static [(&'static str, &'static str, &'static str)] {
    #[cfg(target_os = "windows")]
    {
        &[
            ("powershell", "Windows PowerShell", "powershell.exe"),
            ("pwsh", "PowerShell 7", "pwsh.exe"),
            ("cmd", "Command Prompt", "cmd.exe"),
            ("bash", "Git Bash", "bash.exe"),
        ]
    }
    #[cfg(not(target_os = "windows"))]
    {
        &[
            ("bash", "Bash", "bash"),
            ("zsh", "Zsh", "zsh"),
            ("fish", "Fish", "fish"),
            ("sh", "sh", "sh"),
        ]
    }
}

#[tauri::command]
fn list_shells() -> Vec<ShellInfo> {
    shell_candidates()
        .iter()
        .map(|(id, label, program)| ShellInfo {
            id: id.to_string(),
            label: label.to_string(),
            program: program.to_string(),
            available: which::which(program).is_ok(),
        })
        .collect()
}

/// Locate the `claude` binary for the "Claude binary path" setting's auto-detect.
///
/// Searches the resolved login `PATH` first — the inherited process `PATH` is the
/// very thing that's often missing Homebrew/npm dirs — then probes well-known
/// install locations a `PATH` search would still miss. Returns the first match
/// that exists, or `None` so the UI can prompt for a manual path.
#[tauri::command]
fn detect_claude_path(resolved: State<ResolvedEnv>) -> Option<String> {
    let exe = if cfg!(target_os = "windows") {
        "claude.cmd"
    } else {
        "claude"
    };

    // 1. Resolve on PATH (the login PATH if we have it, else the process PATH).
    let login_path = resolved.path.lock().unwrap().clone();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let on_path = match &login_path {
        Some(p) => which::which_in("claude", Some(p), &cwd).ok(),
        None => which::which("claude").ok(),
    };
    if let Some(p) = on_path {
        return Some(p.to_string_lossy().into_owned());
    }

    // 2. Probe well-known locations (Homebrew, the native installer, npm globals).
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin").join(exe),
        PathBuf::from("/usr/local/bin").join(exe),
    ];
    if let Some(home) = home_dir() {
        candidates.push(home.join(".claude/local").join(exe));
        candidates.push(home.join(".local/bin").join(exe));
        candidates.push(home.join(".npm-global/bin").join(exe));
        #[cfg(target_os = "windows")]
        candidates.push(home.join("AppData/Roaming/npm").join(exe));
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// True if `path` points at an existing file, for live validation feedback in
/// the "Claude binary path" setting. An empty path is "not set", not invalid.
#[tauri::command]
fn validate_claude_path(path: String) -> bool {
    let trimmed = path.trim();
    !trimmed.is_empty() && Path::new(trimmed).is_file()
}

/// Use the requested shell if it's non-empty and resolvable, else the default.
fn resolve_shell(shell: Option<String>) -> String {
    match shell {
        Some(s) if !s.trim().is_empty() && which::which(&s).is_ok() => s,
        _ => default_shell(),
    }
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<PtyManager>,
    resolved: State<ResolvedEnv>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(resolve_shell(shell));
    if Path::new(&cwd).is_dir() {
        cmd.cwd(&cwd);
    }
    // Baseline PATH from the user's login shell (see ResolvedEnv) so PTYs can find
    // Homebrew/npm tools like `claude` even when Meridian was launched from
    // Finder/Dock with a minimal PATH. Set before the per-tab env below so an
    // explicit override still wins, and before spawn so the shell's own startup
    // files can still prepend/append to it as usual.
    if let Some(path) = resolved.path.lock().unwrap().as_ref() {
        cmd.env("PATH", path);
    }
    // Extra environment for the shell (and anything it launches, e.g. a Claude
    // tab sets CLAUDE_CODE_NO_FLICKER so `claude` starts in fullscreen).
    if let Some(env) = env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Release the slave handle so the PTY closes cleanly when the child exits.
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let output_event = format!("pty://output/{id}");
    let exit_event = format!("pty://exit/{id}");

    // Dedicated writer thread (see PtySession): owns the master and writer so a
    // blocking ConPTY write can never run on the main thread. Exits when the
    // session is removed (the sender drops, closing the channel) or a write
    // fails (the child side of the pipe is gone); dropping the master here then
    // closes the PTY.
    let (writer_tx, writer_rx) = std::sync::mpsc::channel::<PtyMsg>();
    let master: Box<dyn MasterPty + Send> = pair.master;
    thread::spawn(move || {
        for msg in writer_rx {
            match msg {
                PtyMsg::Data(bytes) => {
                    if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                        break;
                    }
                }
                PtyMsg::Resize(size) => {
                    let _ = master.resize(size);
                }
            }
        }
    });

    // Register the session before the reader thread emits, so the first bytes
    // (the shell banner/prompt) are never dropped. The frontend attaches its
    // listener before calling this command.
    state.sessions.lock().unwrap().insert(
        id,
        PtySession {
            writer_tx,
            child,
            cwd,
        },
    );

    // Pump PTY output to the frontend. Target the main webview only — a bare
    // `emit` broadcasts every chunk to ALL webviews, including the embedded
    // browser tabs' external pages, which can't use the events and just burn
    // renderer CPU evaluating them.
    //
    // Two threads with a channel between them, so output is COALESCED before it
    // crosses IPC: a chatty program (build, `npm install`, `cat` of a large
    // file, Claude streaming) produces back-to-back 8 KB reads, and emitting one
    // event per read floods the webview's single JS thread — the cause of
    // output-driven UI freezes. The reader pulls bytes as fast as the PTY
    // yields; the emitter batches them into at most one event per ~frame (16 ms)
    // or 64 KB, and base64-encodes the payload. (Bytes sent as a `Vec<u8>` cross
    // Tauri IPC as a JSON number-array — `[27,91,...]` — inflating each chunk
    // ~6-10x and forcing a per-element parse on the frontend; a base64 string is
    // compact and decodes in one pass.)
    let app_handle = app.clone();
    let mut reader = reader;
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();

    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Channel closed means the emitter stopped (webview gone).
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // Dropping `tx` here signals the emitter to flush and emit the exit event.
    });

    thread::spawn(move || {
        use base64::Engine;
        use std::sync::mpsc::RecvTimeoutError;
        const FLUSH_BYTES: usize = 64 * 1024;
        const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(16);

        let mut acc: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
        let flush = |acc: &mut Vec<u8>| -> bool {
            if acc.is_empty() {
                return true;
            }
            let encoded = base64::engine::general_purpose::STANDARD.encode(&acc);
            acc.clear();
            app_handle.emit_to("main", &output_event, encoded).is_ok()
        };

        loop {
            // Block with no timeout while idle (zero CPU); once bytes are
            // buffered, race the flush timer so a burst is delivered within one
            // frame instead of being held until the next read.
            let recv = if acc.is_empty() {
                rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
            } else {
                rx.recv_timeout(FLUSH_INTERVAL)
            };
            match recv {
                Ok(chunk) => {
                    acc.extend_from_slice(&chunk);
                    if acc.len() >= FLUSH_BYTES && !flush(&mut acc) {
                        return;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if !flush(&mut acc) {
                        return;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    let _ = flush(&mut acc);
                    break;
                }
            }
        }
        let _ = app_handle.emit_to("main", &exit_event, ());
    });

    Ok(())
}

#[tauri::command]
fn pty_write(state: State<PtyManager>, id: String, data: String) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&id) {
        // Enqueue only — the writer thread does the (possibly blocking) write.
        // A send error means the writer thread already exited (child gone);
        // the reader side will emit the exit event, so drop it silently.
        let _ = session.writer_tx.send(PtyMsg::Data(data.into_bytes()));
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(state: State<PtyManager>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&id) {
        let _ = session.writer_tx.send(PtyMsg::Resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        }));
    }
    Ok(())
}

#[tauri::command]
fn pty_kill(state: State<PtyManager>, id: String) -> Result<(), String> {
    if let Some(mut session) = state.sessions.lock().unwrap().remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

/// Save a base64-encoded pasted image to a temp file and return its absolute
/// path. The terminal hands this path to a running program like Claude Code,
/// which loads images by path — so an image pasted into the webview reaches
/// Claude even on machines where its own clipboard reader (`powershell.exe
/// Get-Clipboard`) is blocked. Old files are pruned so the directory can't grow
/// without bound.
#[tauri::command]
async fn save_pasted_image(data_base64: String, ext: String) -> Result<String, String> {
    // Async + spawn_blocking: a pasted screenshot is a multi-MB base64 decode
    // plus a temp-dir prune and disk write — noticeable jank on the main thread.
    tauri::async_runtime::spawn_blocking(move || save_pasted_image_blocking(data_base64, ext))
        .await
        .map_err(|e| e.to_string())?
}

fn save_pasted_image_blocking(data_base64: String, ext: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("invalid image data: {e}"))?;

    // Restrict to formats Claude Code accepts; default to png (screenshots).
    let ext = match ext.to_lowercase().as_str() {
        "png" | "jpeg" | "jpg" | "gif" | "webp" => ext.to_lowercase(),
        _ => "png".to_string(),
    };

    let dir = std::env::temp_dir().join("meridian-pasted-images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Prune anything older than a day (pastes are ephemeral once Claude has read
    // them; this keeps the temp dir from accumulating across sessions).
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let now = std::time::SystemTime::now();
        for entry in entries.flatten() {
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| now.duration_since(t).ok())
                .map(|age| age.as_secs() > 86_400)
                .unwrap_or(false);
            if stale {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("pasted-image-{nanos}.{ext}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(denormalize(&path))
}

// --- Language server (LSP) ---
//
// One `typescript-language-server --stdio` process per project root, run via the
// system `node` (the same Node the Prettier integration relies on). The Rust side
// owns the LSP `Content-Length` framing: it parses framed messages off stdout and
// emits each complete JSON message as a string on `lsp://message/{root}`, and on
// `lsp_send` it prepends the header before writing to stdin. The frontend speaks
// plain JSON-RPC and never deals with framing. Mirrors the PTY lifecycle.

/// Strip Windows' `\\?\` verbatim (extended-length) prefix from a path. Node's
/// module loader can't parse `\\?\C:\…` (it misreads the drive and fails), and
/// `resource_dir()` hands back verbatim paths, so normalize before spawning.
/// A no-op on non-verbatim paths and non-Windows platforms.
fn denormalize(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.into_owned()
    }
}

/// `…/node_modules/typescript-language-server/lib/cli.mjs` under `base`.
fn tls_entry(base: &Path) -> PathBuf {
    base.join("node_modules")
        .join("typescript-language-server")
        .join("lib")
        .join("cli.mjs")
}

/// Resolve the language-server entry script. Order:
///  1. The project's own install (walking up, like `find_local_prettier`) — so a
///     project that pins a specific version gets it.
///  2. The copy bundled with the app as a resource (packaged builds).
///  3. The app's own `node_modules` next to the crate (dev builds) — so it works
///     in `tauri dev` for any project, not just the Meridian repo itself.
/// In every case the server is run with `cwd` = the project root, so it still
/// resolves the project's `tsconfig` and installed `typescript` from disk.
fn find_language_server(root: &Path, app: &AppHandle) -> Option<PathBuf> {
    // 1. Project-local (and monorepo-hoisted) install.
    let mut dir = Some(root);
    let mut hops = 0;
    while let Some(d) = dir {
        hops += 1;
        if hops > 64 {
            break;
        }
        let candidate = tls_entry(d);
        if candidate.is_file() {
            log::info!("LSP: using project-local server {}", candidate.display());
            return Some(candidate);
        }
        dir = d.parent();
    }
    // 2. Bundled fallback shipped as an app resource (packaged builds).
    if let Ok(res) = app.path().resource_dir() {
        let bundled = tls_entry(&res);
        if bundled.is_file() {
            log::info!("LSP: using bundled server {}", bundled.display());
            return Some(bundled);
        }
    }
    // 3. Dev fallback: the app's own node_modules beside the crate. The baked-in
    //    path won't exist on a user's machine in a packaged build, so this only
    //    resolves in `tauri dev`.
    if let Some(repo) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        let dev = tls_entry(repo);
        if dev.is_file() {
            log::info!("LSP: using dev server {}", dev.display());
            return Some(dev);
        }
    }
    log::warn!(
        "LSP: no typescript-language-server found for {}",
        root.display()
    );
    None
}

#[tauri::command]
fn lsp_spawn(
    app: AppHandle,
    state: State<LspManager>,
    // Opaque, event-safe id supplied by the frontend for the message/exit event
    // names — the project root can't be used directly because Tauri event names
    // forbid `\` and `.`, which Windows paths contain.
    id: String,
    root: String,
) -> Result<(), String> {
    // Idempotent: a client already running for this root is reused.
    if state.sessions.lock().unwrap().contains_key(&root) {
        return Ok(());
    }

    let server = find_language_server(Path::new(&root), &app)
        .ok_or_else(|| "No TypeScript language server found".to_string())?;

    let mut cmd = Command::new("node");
    cmd.arg(denormalize(&server))
        .arg("--stdio")
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        log::warn!("LSP: failed to launch node for {root}: {e}");
        format!("Could not launch the language server via Node: {e}")
    })?;
    log::info!("LSP: spawned server for {root}");

    let stdout = child.stdout.take().ok_or("language server has no stdout")?;
    let mut stdin = child.stdin.take().ok_or("language server has no stdin")?;

    // Dedicated writer thread (see LspSession): owns stdin, prepends the LSP
    // Content-Length framing, and absorbs pipe-full blocking off the main
    // thread. Exits when the session is removed (sender drops) or a write
    // fails (server exited); dropping stdin then closes the pipe.
    let (writer_tx, writer_rx) = std::sync::mpsc::channel::<String>();
    thread::spawn(move || {
        for message in writer_rx {
            // Content-Length is the byte length of the UTF-8 payload.
            let header = format!("Content-Length: {}\r\n\r\n", message.len());
            if stdin.write_all(header.as_bytes()).is_err()
                || stdin.write_all(message.as_bytes()).is_err()
                || stdin.flush().is_err()
            {
                break;
            }
        }
    });

    // Drain stderr so it can't fill the pipe and block the server, and so its
    // diagnostics surface in the log.
    if let Some(stderr) = child.stderr.take() {
        let tag = root.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::warn!(target: "lsp", "[{tag}] {line}");
            }
        });
    }

    let msg_event = format!("lsp://message/{id}");
    let exit_event = format!("lsp://exit/{id}");

    // Register before the reader thread emits (the frontend attaches its listener
    // before calling this, mirroring the PTY pattern).
    state
        .sessions
        .lock()
        .unwrap()
        .insert(root.clone(), LspSession { child, writer_tx });

    // Parse Content-Length framed messages and relay each to the main webview.
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        'outer: loop {
            // Headers, terminated by a blank line.
            let mut content_length = 0usize;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break 'outer, // EOF
                    Ok(_) => {
                        let trimmed = line.trim_end();
                        if trimmed.is_empty() {
                            break;
                        }
                        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                            content_length = rest.trim().parse().unwrap_or(0);
                        }
                    }
                    Err(_) => break 'outer,
                }
            }
            if content_length == 0 {
                continue;
            }
            let mut body = vec![0u8; content_length];
            if reader.read_exact(&mut body).is_err() {
                break;
            }
            match String::from_utf8(body) {
                Ok(text) => {
                    if app_handle.emit_to("main", &msg_event, text).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_handle.emit_to("main", &exit_event, ());
    });

    Ok(())
}

#[tauri::command]
fn lsp_send(state: State<LspManager>, root: String, message: String) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&root) {
        // Enqueue only — the writer thread frames and does the (possibly
        // blocking) write. A send error means the server already exited; the
        // reader side emits the exit event, so drop it silently.
        let _ = session.writer_tx.send(message);
    }
    Ok(())
}

#[tauri::command]
fn lsp_kill(state: State<LspManager>, root: String) -> Result<(), String> {
    if let Some(mut session) = state.sessions.lock().unwrap().remove(&root) {
        let _ = session.child.kill();
    }
    Ok(())
}

/// Roots whose language-server process is actually alive right now. Probes each
/// child with `try_wait` and drops any that have exited, so the result reflects
/// real running processes rather than what the frontend believes it started.
#[tauri::command]
fn lsp_status(state: State<LspManager>) -> Vec<String> {
    let mut sessions = state.sessions.lock().unwrap();
    let mut alive = Vec::new();
    sessions.retain(|root, session| match session.child.try_wait() {
        Ok(Some(_)) => false, // process exited — drop it
        _ => {
            // Still running, or status indeterminate (treat as running).
            alive.push(root.clone());
            true
        }
    });
    alive.sort();
    alive
}

// --- Embedded browser webviews ---
//
// Each browser tab is a native child webview added to the main window via
// `Window::add_child` (requires the `unstable` Tauri feature). The child loads
// remote content and is intentionally given NO Tauri IPC access, so a loaded
// page cannot reach Meridian's commands. All control (navigate/reload/bounds/
// show/hide) is driven from these custom commands rather than the page.
//
// There is no native back/forward API, so we drive `history.back()/forward()`
// via `eval` and keep a best-effort host-side history list to derive the
// enabled state of the toolbar buttons. SPA in-page route changes (pushState)
// don't fire `on_navigation`, so they aren't tracked — a known limitation.

/// Which kind of navigation we just asked the webview to perform, so the
/// resulting `on_navigation` event updates history correctly.
#[derive(PartialEq)]
enum NavIntent {
    None,
    Back,
    Forward,
}

/// One embedded browser webview and its best-effort navigation history.
struct BrowserSession {
    /// Visited URLs in order; `index` points at the current entry.
    history: Vec<String>,
    index: usize,
    pending: NavIntent,
    /// Last document title seen (mirrors what's emitted to the frontend). Used
    /// by the MCP server's `list_tabs` so the in-app Claude sees tab names.
    title: String,
    /// Absolute root of the project this tab belongs to. The MCP server scopes a
    /// Claude session to only the tabs of its own project.
    project_root: String,
    /// Whether this is the visible/active surface (set by the frontend). Lets
    /// `read_tab`/`screenshot` default to the tab the user is looking at.
    active: bool,
}

/// Holds every live browser webview keyed by a frontend-supplied id.
#[derive(Default)]
pub(crate) struct BrowserManager {
    sessions: Mutex<HashMap<String, BrowserSession>>,
}

/// A browser tab as the MCP server reports it (`list_tabs`, resource listing).
pub(crate) struct TabSnapshot {
    pub id: String,
    pub title: String,
    pub url: String,
    pub active: bool,
}

/// Snapshot the open browser tabs belonging to `root` (most-specific-root match
/// would over-reach here — tabs store their exact owning root, so compare it
/// directly). Returned in id order is not guaranteed; the caller sorts if needed.
pub(crate) fn browser_tabs_for_root(app: &AppHandle, root: &str) -> Vec<TabSnapshot> {
    let Some(state) = app.try_state::<BrowserManager>() else {
        return Vec::new();
    };
    let sessions = state.sessions.lock().unwrap();
    sessions
        .iter()
        .filter(|(_, s)| norm_path(&s.project_root) == norm_path(root))
        .map(|(id, s)| TabSnapshot {
            id: id.clone(),
            title: s.title.clone(),
            url: s.history.get(s.index).cloned().unwrap_or_default(),
            active: s.active,
        })
        .collect()
}

/// True when `id` is a browser tab owned by `root` — the MCP server's guard so a
/// Claude session can't drive another project's tabs by guessing an id.
pub(crate) fn browser_tab_in_root(app: &AppHandle, id: &str, root: &str) -> bool {
    app.try_state::<BrowserManager>()
        .and_then(|state| {
            let sessions = state.sessions.lock().unwrap();
            sessions
                .get(id)
                .map(|s| norm_path(&s.project_root) == norm_path(root))
        })
        .unwrap_or(false)
}

/// Navigation state pushed to the frontend so the toolbar can render the
/// current URL and enable/disable the back/forward buttons.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NavState {
    url: String,
    can_back: bool,
    can_forward: bool,
}

/// The webview label for a browser tab id (`add_child` requires a label).
fn browser_label(id: &str) -> String {
    format!("browser-{id}")
}

/// Sentinel host the injected script navigates to so the host can intercept
/// "open a new tab" requests in `on_navigation` without giving the page IPC.
const NEWTAB_HOST: &str = "meridian.invalid";

/// Injected into every browser page before its own scripts run. Reroutes
/// `window.open`, `target="_blank"` clicks, and middle-clicks through a sentinel
/// navigation so they open as a new in-app tab instead of a detached OS window.
const BROWSER_INIT_SCRIPT: &str = r#"
(function () {
  var SENTINEL = "https://meridian.invalid/open?url=";
  function requestOpen(url) {
    try {
      if (!url) return;
      var abs = new URL(url, location.href).href;
      location.href = SENTINEL + encodeURIComponent(abs);
    } catch (e) {}
  }
  window.open = function (url) {
    requestOpen(url);
    return null;
  };
  document.addEventListener("click", function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[target="_blank"]') : null;
    if (a && a.href) {
      e.preventDefault();
      requestOpen(a.href);
    }
  }, true);
  document.addEventListener("auxclick", function (e) {
    if (e.button !== 1) return;
    var t = e.target;
    var a = t && t.closest ? t.closest("a[href]") : null;
    if (a && a.href) {
      e.preventDefault();
      requestOpen(a.href);
    }
  }, true);
})();
"#;

/// Injected on demand to enter "element selector" mode: hovering outlines the
/// element under the cursor, a left click captures a descriptor of it and sends
/// it to the host through the same sentinel-navigation channel `window.open`
/// uses (so the IPC-less page still has no access to Meridian's commands), and
/// Escape cancels. `window.__meridianPickerStop` tears it down (the toolbar
/// toggle calls it). Re-entrant-safe.
const PICKER_SCRIPT: &str = r##"
(function () {
  if (window.__meridianPicker) return;
  window.__meridianPicker = true;
  var PICK = "https://meridian.invalid/pick?data=";
  var CANCEL = "https://meridian.invalid/pick?cancel=1";
  var overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4f9cff;" +
    "background:rgba(79,156,255,0.14);box-shadow:0 0 0 1px rgba(0,0,0,0.35);" +
    "border-radius:2px;top:0;left:0;width:0;height:0;transition:all 40ms ease;";
  var label = document.createElement("div");
  label.style.cssText =
    "position:fixed;z-index:2147483647;pointer-events:none;font:12px/1.5 ui-monospace," +
    "SFMono-Regular,Menlo,monospace;background:#10141a;color:#e6edf3;padding:2px 6px;" +
    "border-radius:4px;max-width:80vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(label);
  var current = null;

  function describe(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.classList && el.classList.length) s += "." + Array.prototype.join.call(el.classList, ".");
    return s;
  }
  function cssPath(el) {
    if (el.id) return "#" + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      var seg = el.tagName.toLowerCase();
      if (el.id) { parts.unshift("#" + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id)); break; }
      var p = el.parentElement;
      if (p) {
        var same = Array.prototype.filter.call(p.children, function (c) { return c.tagName === el.tagName; });
        if (same.length > 1) seg += ":nth-of-type(" + (Array.prototype.indexOf.call(same, el) + 1) + ")";
      }
      parts.unshift(seg);
      el = p;
    }
    return parts.join(" > ");
  }
  function onMove(e) {
    var el = e.target;
    if (!el || el === overlay || el === label) return;
    current = el;
    var r = el.getBoundingClientRect();
    overlay.style.top = r.top + "px";
    overlay.style.left = r.left + "px";
    overlay.style.width = r.width + "px";
    overlay.style.height = r.height + "px";
    label.textContent = describe(el);
    var ly = r.top - 22;
    label.style.top = (ly < 0 ? r.top + 4 : ly) + "px";
    label.style.left = Math.max(0, r.left) + "px";
  }
  function teardown() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("contextmenu", onCtx, true);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (label.parentNode) label.parentNode.removeChild(label);
    window.__meridianPicker = null;
    window.__meridianPickerStop = null;
  }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = current || e.target;
    var r = el.getBoundingClientRect();
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) attrs[el.attributes[i].name] = el.attributes[i].value;
    var html = el.outerHTML || "";
    if (html.length > 4000) html = html.slice(0, 4000) + "…";
    var text = (el.innerText || el.textContent || "").trim();
    if (text.length > 1500) text = text.slice(0, 1500) + "…";
    var payload = {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: el.classList ? Array.prototype.join.call(el.classList, " ") : "",
      attributes: attrs,
      text: text,
      html: html,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      url: location.href,
      title: document.title
    };
    // Stay in selector mode so the user can pick several elements in a row;
    // Escape or the toolbar toggle tears it down. The host shows a confirmation
    // toast in the page (see browser_pick_toast).
    try { location.href = PICK + encodeURIComponent(JSON.stringify(payload)); } catch (err) {}
  }
  function onKey(e) { if (e.key === "Escape") { teardown(); try { location.href = CANCEL; } catch (err) {} } }
  function onCtx(e) { e.preventDefault(); }
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("contextmenu", onCtx, true);
  window.__meridianPickerStop = teardown;
})();
"##;

#[tauri::command]
async fn browser_create(
    app: AppHandle,
    state: State<'_, BrowserManager>,
    id: String,
    url: String,
    project_root: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let parsed: Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    let label = browser_label(&id);

    // Register the session before the webview loads so the initial navigation
    // event has somewhere to record the URL (the listen-first order the PTY
    // commands also rely on).
    state.sessions.lock().unwrap().insert(
        id.clone(),
        BrowserSession {
            history: vec![url.clone()],
            index: 0,
            pending: NavIntent::None,
            title: String::new(),
            project_root,
            active: false,
        },
    );

    let nav_event = format!("browser://navstate/{id}");
    let title_event = format!("browser://title/{id}");
    let newtab_event = format!("browser://newtab/{id}");
    let pick_event = format!("browser://pick/{id}");
    let nav_app = app.clone();
    let nav_id = id.clone();
    let title_id = id.clone();

    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .initialization_script(BROWSER_INIT_SCRIPT)
        .on_navigation(move |url| {
            // The injected scripts funnel host requests through this sentinel
            // host (the page keeps no IPC access); branch on the path and cancel
            // the navigation so the current page stays put.
            if url.host_str() == Some(NEWTAB_HOST) {
                match url.path() {
                    // Element picker: a captured element (or a cancel) from
                    // selector mode (see PICKER_SCRIPT).
                    "/pick" => {
                        if url.query_pairs().any(|(k, _)| k == "cancel") {
                            let _ = nav_app.emit(&pick_event, serde_json::json!({ "cancel": true }));
                        } else if let Some((_, data)) =
                            url.query_pairs().find(|(k, _)| k == "data")
                        {
                            let _ = nav_app.emit(
                                &pick_event,
                                serde_json::json!({ "cancel": false, "data": data.into_owned() }),
                            );
                        }
                    }
                    // window.open / target=_blank / middle-click → new in-app tab.
                    _ => {
                        if let Some((_, target)) = url.query_pairs().find(|(k, _)| k == "url") {
                            let _ = nav_app.emit(&newtab_event, target.into_owned());
                        }
                    }
                }
                return false;
            }
            if let Some(state) = nav_app.try_state::<BrowserManager>() {
                let mut sessions = state.sessions.lock().unwrap();
                if let Some(s) = sessions.get_mut(&nav_id) {
                    let u = url.to_string();
                    match s.pending {
                        NavIntent::Back => {
                            s.index = s.index.saturating_sub(1);
                            s.pending = NavIntent::None;
                        }
                        NavIntent::Forward => {
                            if s.index + 1 < s.history.len() {
                                s.index += 1;
                            }
                            s.pending = NavIntent::None;
                        }
                        NavIntent::None => {
                            // New navigation (URL bar or in-page link click).
                            // Skip reloads (same URL) so they don't grow history.
                            if s.history.get(s.index).map(String::as_str) != Some(u.as_str()) {
                                s.history.truncate(s.index + 1);
                                s.history.push(u.clone());
                                s.index = s.history.len() - 1;
                            }
                        }
                    }
                    let _ = nav_app.emit(
                        &nav_event,
                        NavState {
                            url: u,
                            can_back: s.index > 0,
                            can_forward: s.index + 1 < s.history.len(),
                        },
                    );
                }
            }
            true
        })
        .on_document_title_changed(move |_webview, title| {
            // Mirror the title into the session so the MCP `list_tabs` tool can
            // name tabs, then notify the frontend toolbar as before.
            if let Some(state) = app.try_state::<BrowserManager>() {
                if let Some(s) = state.sessions.lock().unwrap().get_mut(&title_id) {
                    s.title = title.clone();
                }
            }
            let _ = app.emit(&title_event, title);
        });

    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    let webview = app
        .get_webview(&browser_label(&id))
        .ok_or_else(|| "browser not found".to_string())?;
    webview.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
async fn browser_reload(app: AppHandle, id: String) -> Result<(), String> {
    let webview = app
        .get_webview(&browser_label(&id))
        .ok_or_else(|| "browser not found".to_string())?;
    webview.reload().map_err(|e| e.to_string())
}

#[tauri::command]
async fn browser_back(
    app: AppHandle,
    state: State<'_, BrowserManager>,
    id: String,
) -> Result<(), String> {
    {
        let mut sessions = state.sessions.lock().unwrap();
        match sessions.get_mut(&id) {
            Some(s) if s.index > 0 => s.pending = NavIntent::Back,
            Some(_) => return Ok(()), // already at the oldest entry
            None => return Err("browser not found".into()),
        }
    }
    let webview = app
        .get_webview(&browser_label(&id))
        .ok_or_else(|| "browser not found".to_string())?;
    webview.eval("history.back()").map_err(|e| e.to_string())
}

#[tauri::command]
async fn browser_forward(
    app: AppHandle,
    state: State<'_, BrowserManager>,
    id: String,
) -> Result<(), String> {
    {
        let mut sessions = state.sessions.lock().unwrap();
        match sessions.get_mut(&id) {
            Some(s) if s.index + 1 < s.history.len() => s.pending = NavIntent::Forward,
            Some(_) => return Ok(()), // already at the newest entry
            None => return Err("browser not found".into()),
        }
    }
    let webview = app
        .get_webview(&browser_label(&id))
        .ok_or_else(|| "browser not found".to_string())?;
    webview.eval("history.forward()").map_err(|e| e.to_string())
}

#[tauri::command]
async fn browser_set_bounds(
    app: AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser_label(&id)) {
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn browser_show(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser_label(&id)) {
        webview.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn browser_hide(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser_label(&id)) {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn browser_close(
    app: AppHandle,
    state: State<'_, BrowserManager>,
    id: String,
) -> Result<(), String> {
    state.sessions.lock().unwrap().remove(&id);
    if let Some(webview) = app.get_webview(&browser_label(&id)) {
        let _ = webview.hide();
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Enter element-selector mode in a tab: inject the picker overlay script. The
/// captured element (on click) arrives back on `browser://pick/{id}`.
#[tauri::command]
async fn browser_pick_start(app: AppHandle, id: String) -> Result<(), String> {
    browser_webview(&app, &id)?
        .eval(PICKER_SCRIPT)
        .map_err(|e| e.to_string())
}

/// Leave element-selector mode (the toolbar toggle, or a tab switch): tear down
/// the injected overlay if it's still present.
#[tauri::command]
async fn browser_pick_stop(app: AppHandle, id: String) -> Result<(), String> {
    browser_webview(&app, &id)?
        .eval("window.__meridianPickerStop && window.__meridianPickerStop()")
        .map_err(|e| e.to_string())
}

// Self-contained in-page toast (split around the JSON-encoded message). Rendered
// inside the page rather than in the DOM because the browser is a native surface
// layered over the DOM — a React toast would sit behind it. Auto-dismisses.
const TOAST_PRE: &str = "(function(){var m=";
const TOAST_POST: &str = ";var id='__meridianToast';var old=document.getElementById(id);if(old)old.remove();var t=document.createElement('div');t.id=id;t.textContent=m;t.style.cssText='position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;background:#10141a;color:#e6edf3;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.4);pointer-events:none;opacity:0;transition:opacity 120ms ease;';document.documentElement.appendChild(t);requestAnimationFrame(function(){t.style.opacity=\"1\";});setTimeout(function(){t.style.opacity=\"0\";},1400);setTimeout(function(){if(t.parentNode)t.parentNode.removeChild(t);},1700);})();";

/// Show a brief, auto-dismissing toast inside a browser tab's page. Used to
/// confirm an element was added to the Claude prompt without switching tabs.
#[tauri::command]
async fn browser_pick_toast(app: AppHandle, id: String, message: String) -> Result<(), String> {
    let msg = serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".to_string());
    let script = format!("{TOAST_PRE}{msg}{TOAST_POST}");
    browser_webview(&app, &id)?
        .eval(&script)
        .map_err(|e| e.to_string())
}

/// Mark a browser tab as the visible/active surface (or not). The frontend calls
/// this from its show/hide effect so the MCP server can default `read_tab` and
/// `screenshot` to the tab the user is actually looking at.
#[tauri::command]
fn browser_set_active(state: State<BrowserManager>, id: String, active: bool) {
    let mut sessions = state.sessions.lock().unwrap();
    if active {
        // Exactly one active tab per project root at a time.
        if let Some(root) = sessions.get(&id).map(|s| s.project_root.clone()) {
            for (sid, s) in sessions.iter_mut() {
                if norm_path(&s.project_root) == norm_path(&root) {
                    s.active = sid == &id;
                }
            }
        }
    } else if let Some(s) = sessions.get_mut(&id) {
        s.active = false;
    }
}

#[tauri::command]
async fn browser_get_url(
    app: AppHandle,
    state: State<'_, BrowserManager>,
    id: String,
) -> Result<String, String> {
    let webview = app
        .get_webview(&browser_label(&id))
        .ok_or_else(|| "browser not found".to_string())?;
    // Prefer the webview's live URL (catches in-page SPA navigations the
    // on_navigation delegate never sees). When it isn't available yet — the
    // window between tab creation and the first committed navigation — fall back
    // to the URL on_navigation last recorded instead of letting the platform
    // getter panic on an empty URL.
    if let Some(url) = read_live_url(&webview) {
        return Ok(url);
    }
    let url = state
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .and_then(|s| s.history.get(s.index).cloned())
        .unwrap_or_default();
    Ok(url)
}

/// The webview's committed URL, or `None` when no navigation has committed yet.
///
/// On macOS, wry's `Webview::url()` calls `WKWebView.URL().unwrap()` on the main
/// event-loop thread, which panics for an uncommitted webview. We read the
/// `WKWebView` URL ourselves via `with_webview` so the null case is recoverable.
/// Other platforms return a real `Result`, so the existing getter is used there.
#[cfg(target_os = "macos")]
fn read_live_url(webview: &tauri::Webview) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    webview
        .with_webview(move |platform| {
            use objc2_web_kit::WKWebView;
            let ptr = platform.inner() as *mut WKWebView;
            let url = if ptr.is_null() {
                None
            } else {
                // SAFETY: `with_webview` runs this on the main thread with a live
                // WKWebView for the lifetime of the call.
                let wk: &WKWebView = unsafe { &*ptr };
                unsafe { wk.URL() }
                    .and_then(|u| u.absoluteString())
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty())
            };
            let _ = tx.send(url);
        })
        .ok()?;
    // The closure runs on the main thread; bound the wait so a busy main thread
    // can't stall the command (the caller falls back to the tracked URL).
    rx.recv_timeout(std::time::Duration::from_millis(500))
        .ok()
        .flatten()
}

#[cfg(not(target_os = "macos"))]
fn read_live_url(webview: &tauri::Webview) -> Option<String> {
    webview
        .url()
        .ok()
        .map(|u| u.to_string())
        .filter(|s| !s.is_empty())
}

// --- MCP browser bridge ---
//
// Helpers the in-process MCP server (mcp.rs) uses to drive and read the embedded
// browser tabs on behalf of the in-app Claude. Navigation/back/forward/reload
// reuse the same logic the user-facing commands do (so history stays correct);
// reading content and capturing a screenshot need a value back from the page,
// which `eval()` can't give — so they go through platform "evaluate-with-result"
// APIs, mirroring the `read_live_url` precedent.

/// Resolve a browser tab id to its webview, erroring if it's gone.
pub(crate) fn browser_webview(
    app: &AppHandle,
    id: &str,
) -> Result<tauri::Webview, String> {
    app.get_webview(&browser_label(id))
        .ok_or_else(|| format!("browser tab '{id}' not found"))
}

/// Navigate a tab to `url` (records history via the on_navigation delegate).
pub(crate) fn browser_do_navigate(app: &AppHandle, id: &str, url: &str) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    browser_webview(app, id)?
        .navigate(parsed)
        .map_err(|e| e.to_string())
}

/// Reload a tab.
pub(crate) fn browser_do_reload(app: &AppHandle, id: &str) -> Result<(), String> {
    browser_webview(app, id)?.reload().map_err(|e| e.to_string())
}

/// Step a tab back/forward in its history. `forward` selects the direction.
/// Sets the pending intent (so the resulting on_navigation updates the index
/// correctly) exactly like the user-facing back/forward commands.
pub(crate) fn browser_do_history(app: &AppHandle, id: &str, forward: bool) -> Result<(), String> {
    if let Some(state) = app.try_state::<BrowserManager>() {
        let mut sessions = state.sessions.lock().unwrap();
        match sessions.get_mut(id) {
            Some(s) if forward && s.index + 1 < s.history.len() => s.pending = NavIntent::Forward,
            Some(s) if !forward && s.index > 0 => s.pending = NavIntent::Back,
            Some(_) => return Ok(()), // already at an end — no-op
            None => return Err(format!("browser tab '{id}' not found")),
        }
    }
    let script = if forward { "history.forward()" } else { "history.back()" };
    browser_webview(app, id)?.eval(script).map_err(|e| e.to_string())
}

/// Evaluate `script` in a tab's top frame and return the result as a JSON string
/// (exactly what the platform's evaluate-with-result API yields). Blocks up to
/// `timeout_ms` for the page to answer. The script should evaluate to a
/// JSON-serializable value; non-serializable results come back as `"null"`.
///
/// Windows (WebView2) is implemented; macOS/Linux return a clear error pending a
/// tested WKWebView/WebKitGTK implementation (matching the README's platform
/// posture — navigation and tab listing still work everywhere; only content
/// reading, screenshots, and eval_js are gated to Windows for now).
#[cfg(windows)]
pub(crate) fn browser_eval_with_result(
    app: &AppHandle,
    id: &str,
    script: &str,
    timeout_ms: u64,
) -> Result<String, String> {
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows_core::HSTRING;

    let webview = browser_webview(app, id)?;
    let script = HSTRING::from(script);
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();

    webview
        .with_webview(move |platform| unsafe {
            let controller = platform.controller();
            let core = match controller.CoreWebView2() {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                    return;
                }
            };
            let tx_handler = tx.clone();
            let handler = ExecuteScriptCompletedHandler::create(Box::new(
                move |result: windows_core::Result<()>, json: String| -> windows_core::Result<()> {
                    let _ = match result {
                        Ok(()) => tx_handler.send(Ok(json)),
                        Err(e) => tx_handler.send(Err(e.to_string())),
                    };
                    Ok(())
                },
            ));
            if let Err(e) = core.ExecuteScript(&script, &handler) {
                let _ = tx.send(Err(e.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;

    rx.recv_timeout(std::time::Duration::from_millis(timeout_ms))
        .map_err(|_| "page did not respond (eval timed out)".to_string())?
}

#[cfg(not(windows))]
pub(crate) fn browser_eval_with_result(
    _app: &AppHandle,
    _id: &str,
    _script: &str,
    _timeout_ms: u64,
) -> Result<String, String> {
    // TODO(macos): WKWebView `evaluateJavaScript:completionHandler:` via objc2 +
    // block2, wrapping the script so it returns a JSON string (the completion
    // handler yields a native object, unlike WebView2's JSON string).
    // TODO(linux): WebKitGTK `webkit_web_view_evaluate_javascript` (async, with a
    // GAsyncReadyCallback) + `webkit_javascript_result_get_js_value`.
    Err("reading browser page content is currently only implemented on Windows".to_string())
}

/// Capture a PNG screenshot of a tab's current viewport. Windows uses WebView2's
/// `CapturePreview` into an in-memory stream; other platforms return a clear
/// error for now (see `browser_eval_with_result`).
#[cfg(windows)]
pub(crate) fn browser_screenshot_png(
    app: &AppHandle,
    id: &str,
    timeout_ms: u64,
) -> Result<Vec<u8>, String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use webview2_com::CapturePreviewCompletedHandler;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{IStream, STREAM_SEEK_END, STREAM_SEEK_SET};
    use windows::Win32::Foundation::HGLOBAL;

    let webview = browser_webview(app, id)?;
    // The IStream is COM (`!Send`), so we can't carry it back across the channel.
    // Instead the capture, and the read-out of the resulting bytes, both happen on
    // the UI thread inside the completion handler; only the finished `Vec<u8>`
    // (which is `Send`) crosses back to this thread.
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();

    /// Read an entire IStream into a Vec: seek to the end to learn the size, then
    /// to the start and read it in one pass.
    unsafe fn read_stream(stream: &IStream) -> Result<Vec<u8>, String> {
        let mut end: u64 = 0;
        stream
            .Seek(0, STREAM_SEEK_END, Some(&mut end))
            .map_err(|e| e.to_string())?;
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; end as usize];
        let mut off = 0usize;
        while off < buf.len() {
            let want = (buf.len() - off).min(u32::MAX as usize) as u32;
            let mut read: u32 = 0;
            // `Read` returns an HRESULT (S_FALSE at EOF is valid), so `.ok()`.
            stream
                .Read(buf[off..].as_mut_ptr() as *mut _, want, Some(&mut read))
                .ok()
                .map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            off += read as usize;
        }
        buf.truncate(off);
        Ok(buf)
    }

    webview
        .with_webview(move |platform| unsafe {
            let controller = platform.controller();
            let core = match controller.CoreWebView2() {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                    return;
                }
            };
            // An auto-growing HGLOBAL-backed stream the PNG is written into.
            let stream = match CreateStreamOnHGlobal(HGLOBAL::default(), true) {
                Ok(s) => s,
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                    return;
                }
            };
            let stream_for_handler = stream.clone();
            let tx_handler = tx.clone();
            let handler = CapturePreviewCompletedHandler::create(Box::new(
                move |result: windows_core::Result<()>| -> windows_core::Result<()> {
                    let _ = match result {
                        Ok(()) => tx_handler.send(read_stream(&stream_for_handler)),
                        Err(e) => tx_handler.send(Err(e.to_string())),
                    };
                    Ok(())
                },
            ));
            if let Err(e) =
                core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler)
            {
                let _ = tx.send(Err(e.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;

    rx.recv_timeout(std::time::Duration::from_millis(timeout_ms))
        .map_err(|_| "screenshot timed out".to_string())?
}

#[cfg(not(windows))]
pub(crate) fn browser_screenshot_png(
    _app: &AppHandle,
    _id: &str,
    _timeout_ms: u64,
) -> Result<Vec<u8>, String> {
    // TODO(macos): WKWebView `takeSnapshotWithConfiguration:completionHandler:`
    // → NSImage → PNG bytes. TODO(linux): WebKitGTK `webkit_web_view_snapshot`.
    Err("browser screenshots are currently only implemented on Windows".to_string())
}

/// Percent-encode a string for use as a URL query value (the project root, which
/// contains drive letters, backslashes, colons, and spaces on Windows).
fn url_query_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Write (or rewrite) the MCP config the in-app `claude` uses to reach the
/// browser server for `project_root`, and return its absolute path. The file is
/// stable per project (named by a hash of the root) so a Claude tab restored from
/// saved state — which re-runs its persisted `claude --mcp-config <file>` launch
/// command — keeps pointing at a valid config. The endpoint's port and secret are
/// themselves persisted (see mcp.rs), so the file stays valid across restarts.
#[tauri::command]
fn claude_browser_mcp_config(
    app: AppHandle,
    mcp: State<mcp::McpState>,
    project_root: String,
    eval_js: bool,
) -> Result<String, String> {
    use std::hash::{Hash, Hasher};

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mcp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    norm_path(&project_root).hash(&mut hasher);
    let file = dir.join(format!("browser-{:016x}.json", hasher.finish()));

    // The root + eval flag ride in the endpoint URL's query so the server scopes
    // this session to this project's tabs; the secret gates access (browser tools
    // are auto-allowed, so the secret is the real boundary).
    let url = format!(
        "http://127.0.0.1:{}/mcp?root={}&eval={}",
        mcp.port,
        url_query_encode(&project_root),
        if eval_js { "1" } else { "0" }
    );
    let config = serde_json::json!({
        "mcpServers": {
            "browser": {
                "type": "http",
                "url": url,
                "headers": { "Authorization": format!("Bearer {}", mcp.secret) }
            }
        }
    });
    std::fs::write(&file, config.to_string()).map_err(|e| e.to_string())?;
    Ok(denormalize(&file))
}

/// One rate-limit window's state as reported by the Claude usage endpoint.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UsageWindow {
    /// Percent of the window's limit consumed (0–100), as shown by `/usage`.
    utilization: u32,
    /// ISO-8601 instant the window resets, or None if not provided.
    resets_at: Option<String>,
}

/// Claude subscription usage for the rolling 5-hour and weekly (7-day) windows.
/// These are the authoritative figures `/usage` displays — fetched from the
/// same OAuth endpoint Claude Code uses, not estimated locally.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct ClaudeUsage {
    /// True when the endpoint answered; false if not signed in / offline / error.
    available: bool,
    five_hour: UsageWindow,
    seven_day: UsageWindow,
}

/// Build a UsageWindow from a `{ "utilization": n, "resets_at": "..." }` node.
fn parse_window(node: Option<&serde_json::Value>) -> UsageWindow {
    UsageWindow {
        // The endpoint reports utilization as a float (e.g. 40.0), so read it
        // as f64 and round — as_u64() would reject a float and yield 0.
        utilization: node
            .and_then(|n| n.get("utilization"))
            .and_then(|u| u.as_f64())
            .map(|f| f.round().clamp(0.0, 100.0) as u32)
            .unwrap_or(0),
        resets_at: node
            .and_then(|n| n.get("resets_at"))
            .and_then(|r| r.as_str())
            .map(str::to_string),
    }
}

/// Read the Claude OAuth access token from `~/.claude/.credentials.json`. On
/// macOS Claude Code keeps credentials in the Keychain instead, so this may be
/// absent there; that simply yields no usage (the bars hide).
///
/// Deliberately read-only and passive: Meridian never refreshes this token
/// itself (that would mean impersonating the CLI against an undocumented OAuth
/// endpoint and racing its token rotation). If the token has expired between
/// CLI runs, the fetch fails and the frontend keeps showing the last good
/// value until the CLI refreshes the file.
fn read_claude_token() -> Option<String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)?;
    let raw = std::fs::read_to_string(home.join(".claude").join(".credentials.json")).ok()?;
    let cred: serde_json::Value = serde_json::from_str(&raw).ok()?;
    cred.get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(str::to_string)
}

/// Blocking fetch of the authoritative usage figures. Any failure (no token,
/// expired token → 401, offline, schema change) returns an unavailable result
/// rather than erroring; the frontend keeps the last good value on screen.
fn fetch_claude_usage() -> ClaudeUsage {
    let Some(token) = read_claude_token() else {
        return ClaudeUsage::default();
    };
    // Same endpoint + headers Claude Code's `/usage` uses (discovered from the
    // bundled CLI). The token is the user's own; it goes only to Anthropic.
    let resp = ureq::get("https://api.anthropic.com/api/oauth/usage")
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", "oauth-2025-04-20")
        .set("anthropic-version", "2023-06-01")
        .call();
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            // Expired-token 401s land here; log at debug so a sustained outage
            // is diagnosable without spamming the log every poll.
            log::debug!("claude usage: request failed: {e}");
            return ClaudeUsage::default();
        }
    };
    let Ok(text) = resp.into_string() else {
        return ClaudeUsage::default();
    };
    let Ok(body) = serde_json::from_str::<serde_json::Value>(&text) else {
        return ClaudeUsage::default();
    };
    ClaudeUsage {
        available: true,
        five_hour: parse_window(body.get("five_hour")),
        seven_day: parse_window(body.get("seven_day")),
    }
}

#[tauri::command]
async fn claude_usage() -> ClaudeUsage {
    // Run the blocking HTTP call off the main thread so the UI never stalls.
    tauri::async_runtime::spawn_blocking(fetch_claude_usage)
        .await
        .unwrap_or_default()
}

/// Sink for frontend `window.onerror` / `unhandledrejection` reports so JS
/// failures land in the same log file as the Rust side (the webview console
/// is gone once the app dies, the log file isn't).
#[tauri::command]
fn frontend_log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!(target: "frontend", "{message}"),
        "warn" => log::warn!(target: "frontend", "{message}"),
        _ => log::info!(target: "frontend", "{message}"),
    }
}

/// Install a panic hook that appends every Rust panic (message + backtrace)
/// to `crash.log` in the app log dir before the process dies. Panics on the
/// main thread kill the app with nothing in the regular log — this file is
/// the post-mortem. Written raw (not via `log`) so it works even if the
/// logger itself is wedged.
fn install_panic_hook(log_dir: std::path::PathBuf) {
    let _ = std::fs::create_dir_all(&log_dir);
    let crash_path = log_dir.join("crash.log");
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        let backtrace = std::backtrace::Backtrace::force_capture();
        let entry = format!(
            "==== panic at unix:{ts} on thread '{thread}' ====\n{info}\nbacktrace:\n{backtrace}\n\n"
        );
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&crash_path)
        {
            let _ = f.write_all(entry.as_bytes());
        }
        // Also try the regular log; harmless if the logger is already dead.
        log::error!("PANIC on thread '{thread}': {info}");
        default_hook(info);
    }));
}

// --- Resource monitor ---
//
// Reports CPU and memory usage for the whole Meridian process tree, attributed
// to owners the user recognizes: an "App core" bucket (the Rust host process
// plus the WebView2 UI/GPU/renderer processes) and one bucket per open project
// (its terminal subtrees and its language server). Embedded browser tabs fold
// into App core today; on Windows they can later be split out per tab via the
// WebView2 process-info API.
//
// CPU is normalized to the whole machine: sysinfo reports a process's CPU as a
// percentage of ONE core (a process saturating two cores reads 200%), so the
// summed total is divided by the logical core count. The first poll after the
// monitor starts reads ~0% CPU (sysinfo needs two refreshes to compute a delta)
// and self-corrects on the next tick — the frontend polls every couple seconds.

/// Holds a long-lived `System` so CPU deltas are measured across polls.
#[derive(Default)]
struct ResourceMonitor {
    sys: Mutex<System>,
}

/// Cached WebView2 renderer→URLs map, refreshed asynchronously on Windows (see
/// `webview_procs`). Empty on other platforms, where browser tabs stay folded
/// into App core.
#[derive(Clone, Default)]
struct WebviewProcessMap {
    /// (renderer pid, frame source URLs).
    renderers: std::sync::Arc<Mutex<Vec<(u32, Vec<String>)>>>,
}

/// One open browser tab and the project it belongs to (sent by the frontend so
/// renderer source URLs can be joined back to a project by host).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserOwner {
    url: String,
    root: String,
}

/// Host (lowercased) of a URL, for matching renderer frame URLs to browser tabs.
fn url_host(url: &str) -> Option<String> {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    /// Percent of total machine CPU capacity (0–100 across all cores).
    cpu_pct: f32,
    /// Percent of total system memory.
    mem_pct: f32,
    /// Resident set size in bytes.
    mem_bytes: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Component {
    kind: String,
    label: String,
    usage: Usage,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnerUsage {
    label: String,
    root: Option<String>,
    usage: Usage,
    breakdown: Vec<Component>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceReport {
    total: Usage,
    app: OwnerUsage,
    projects: Vec<OwnerUsage>,
}

/// Normalize a path for prefix comparison (case-insensitive, `/`-separated, no
/// trailing slash) — mirrors the frontend's `normPath`.
fn norm_path(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// True when `child` is `root` or lives beneath it.
fn path_under(child: &str, root: &str) -> bool {
    let c = norm_path(child);
    let r = norm_path(root);
    c == r || c.starts_with(&format!("{r}/"))
}

/// The most specific open root that contains `cwd` (longest match wins, so a
/// nested project in a monorepo attributes to itself, not its parent).
fn best_root(cwd: &str, roots: &[String]) -> Option<String> {
    roots
        .iter()
        .filter(|r| path_under(cwd, r))
        .max_by_key(|r| norm_path(r).len())
        .cloned()
}

/// Last path segment of an absolute path (the folder name shown as a label).
fn base_name(p: &str) -> String {
    p.replace('\\', "/")
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(p)
        .to_string()
}

/// Collect a process and all its descendants, skipping pids already claimed by
/// another owner (and not descending into them, since their whole subtree was
/// already attributed). Marks each collected pid claimed so nothing is counted
/// twice. Project subtrees must be claimed before the App-core host walk, since
/// terminals and language servers are descendants of the host process.
fn collect_subtree(
    root: u32,
    children: &HashMap<u32, Vec<u32>>,
    present: &HashMap<u32, (f32, u64)>,
    claimed: &mut std::collections::HashSet<u32>,
    out: &mut Vec<u32>,
) {
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if claimed.contains(&pid) || !present.contains_key(&pid) {
            continue;
        }
        claimed.insert(pid);
        out.push(pid);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
}

/// Accurate per-process memory. On Windows this is the **private working set**
/// — the resident pages unique to the process, matching Task Manager's "Memory"
/// column — so summing it across a process tree does NOT double-count the memory
/// Chromium shares between its browser and renderer processes (which the resident
/// set / `sysinfo::Process::memory()` does). Falls back to `rss` if the OS query
/// fails (access denied, process already exited).
#[cfg(windows)]
fn process_memory(pid: u32, rss: u64) -> u64 {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return rss;
        };
        let mut counters = PROCESS_MEMORY_COUNTERS_EX2::default();
        let cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
        counters.cb = cb;
        let ok = GetProcessMemoryInfo(
            handle,
            &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
            cb,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if ok && counters.PrivateWorkingSetSize > 0 {
            counters.PrivateWorkingSetSize as u64
        } else {
            rss
        }
    }
}

/// Non-Windows: resident set (no cheap private-working-set query available).
#[cfg(not(windows))]
fn process_memory(_pid: u32, rss: u64) -> u64 {
    rss
}

/// True if a process looks like the `claude` CLI — checked across its name, exe
/// path, and command line (the Node-hosted install only reveals "claude" in the
/// cmd-line script path, while the native binary shows it in the name/exe).
fn proc_is_claude(p: &sysinfo::Process) -> bool {
    if p.name().to_string_lossy().to_lowercase().contains("claude") {
        return true;
    }
    if let Some(exe) = p.exe() {
        if exe.to_string_lossy().to_lowercase().contains("claude") {
            return true;
        }
    }
    p.cmd()
        .iter()
        .any(|a| a.to_string_lossy().to_lowercase().contains("claude"))
}

/// True if any process in a terminal's subtree is the `claude` CLI — i.e. this
/// terminal is currently running a Claude session (reflects what's actually live,
/// so a "Claude" tab where claude has since exited counts as a plain terminal).
fn subtree_is_claude(pids: &[u32], sys: &System) -> bool {
    pids.iter()
        .any(|&pid| sys.process(Pid::from_u32(pid)).is_some_and(proc_is_claude))
}

/// Sum CPU/RAM over a set of pids, normalized to whole-machine percentages. CPU
/// comes from `present`; memory comes from the pre-resolved accurate `mem_map`
/// (private working set on Windows, see `process_memory`).
fn sum_usage(
    pids: &[u32],
    present: &HashMap<u32, (f32, u64)>,
    mem_map: &HashMap<u32, u64>,
    ncpu: f32,
    total_mem: u64,
) -> Usage {
    let mut cpu = 0f32;
    let mut mem = 0u64;
    for &p in pids {
        if let Some(&(c, _)) = present.get(&p) {
            cpu += c;
        }
        mem += mem_map.get(&p).copied().unwrap_or(0);
    }
    Usage {
        cpu_pct: cpu / ncpu,
        mem_pct: (mem as f64 / total_mem as f64 * 100.0) as f32,
        mem_bytes: mem,
    }
}

/// CPU + memory for the whole app, attributed to App core and each open project.
/// Async + spawn_blocking: the system-wide process refresh below opens a handle
/// to (potentially) every process on the machine, which on Windows — especially
/// under AV/EDR hooking — can take hundreds of ms per poll. As a sync command it
/// ran on the main thread every few seconds and was the largest single source of
/// recurring UI stalls.
#[tauri::command]
async fn resource_stats(
    app: AppHandle,
    roots: Vec<String>,
    browsers: Vec<BrowserOwner>,
) -> Result<ResourceReport, String> {
    tauri::async_runtime::spawn_blocking(move || resource_stats_blocking(&app, roots, browsers))
        .await
        .map_err(|e| e.to_string())
}

fn resource_stats_blocking(
    app: &AppHandle,
    roots: Vec<String>,
    browsers: Vec<BrowserOwner>,
) -> ResourceReport {
    let monitor = app.state::<ResourceMonitor>();
    let pty = app.state::<PtyManager>();
    let lsp = app.state::<LspManager>();
    let wv = app.state::<WebviewProcessMap>();
    // Kick off an async refresh of the WebView2 renderer map (Windows only) and
    // read the latest snapshot. The first poll sees an empty map (browsers fold
    // into App core) and self-corrects on the next tick.
    //
    // Only enumerate when browser tabs actually exist: `webview_procs::refresh`
    // marshals a `GetProcessExtendedInfos` COM walk (over every renderer and its
    // frame URLs) onto the GUI thread, so running it every poll tick when there
    // are no browser tabs spends UI-thread time on work whose result is unused
    // (with no browsers, `host_root` is empty and nothing gets attributed). This
    // keeps the status-bar poll off the paint/input path in the common case.
    #[cfg(windows)]
    if !browsers.is_empty() {
        webview_procs::refresh(app, wv.renderers.clone());
    }
    let renderer_map = wv.renderers.lock().unwrap().clone();

    // Renderer pid -> owning project root, joined by frame-URL host. Browser
    // tabs of a host we don't own (e.g. the main UI webview) stay unattributed
    // and therefore land in App core.
    let mut host_root: HashMap<String, String> = HashMap::new();
    for b in &browsers {
        if let Some(h) = url_host(&b.url) {
            host_root.insert(h, b.root.clone());
        }
    }
    let mut renderer_root: HashMap<u32, String> = HashMap::new();
    for (pid, sources) in &renderer_map {
        for s in sources {
            if let Some(root) = url_host(s).and_then(|h| host_root.get(&h)) {
                renderer_root.insert(*pid, root.clone());
                break;
            }
        }
    }

    // Snapshot the pids we own (and their owners) without holding the sysinfo
    // lock, then release these locks before the heavier process walk.
    let pty_pids: Vec<(u32, String)> = {
        let sessions = pty.sessions.lock().unwrap();
        sessions
            .values()
            .filter_map(|s| s.child.process_id().map(|pid| (pid, s.cwd.clone())))
            .collect()
    };
    let lsp_pids: Vec<(u32, String)> = {
        let sessions = lsp.sessions.lock().unwrap();
        sessions
            .iter()
            .map(|(root, s)| (s.child.id(), root.clone()))
            .collect()
    };
    let host = std::process::id();

    let mut sys = monitor.sys.lock().unwrap();
    sys.refresh_memory();
    // Minimal per-process refresh: CPU + memory only. The default "everything"
    // refresh also reads each process's exe path, command line, environment,
    // and cwd — an OpenProcess + PEB read for every process on the system,
    // which is what made this poll expensive. Name and parent pid (all the
    // tree walk needs) come with the base process listing; command lines are
    // loaded separately below for just the terminal subtrees.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );
    let ncpu = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1) as f32;
    let total_mem = sys.total_memory().max(1);

    // Process tree: parent -> children, plus each pid's (cpu%, rss).
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut present: HashMap<u32, (f32, u64)> = HashMap::new();
    for proc in sys.processes().values() {
        let pid = proc.pid().as_u32();
        present.insert(pid, (proc.cpu_usage(), proc.memory()));
        if let Some(parent) = proc.parent() {
            children.entry(parent.as_u32()).or_default().push(pid);
        }
    }

    let mut claimed = std::collections::HashSet::new();

    // The pids attributed to one project, collected before any summing so we can
    // resolve accurate per-process memory for just our tree afterwards. Each PTY
    // keeps its own subtree so it can be classified (Claude vs plain shell).
    struct ProjectPids {
        root: String,
        pty_subtrees: Vec<Vec<u32>>,
        lsp: Vec<u32>,
        browser: Vec<u32>,
        browser_count: usize,
    }

    // Per project: claim terminal subtrees + the language server (+ browser-tab
    // renderers on Windows) FIRST, before the App-core host walk below.
    let mut proj_pids: Vec<ProjectPids> = Vec::new();
    for root in &roots {
        let mut pty_subtrees: Vec<Vec<u32>> = Vec::new();
        for (pid, cwd) in &pty_pids {
            if best_root(cwd, &roots).as_deref() == Some(root.as_str()) {
                let mut sub = Vec::new();
                collect_subtree(*pid, &children, &present, &mut claimed, &mut sub);
                pty_subtrees.push(sub);
            }
        }
        let mut lsp_subtree = Vec::new();
        for (pid, lroot) in &lsp_pids {
            if norm_path(lroot) == norm_path(root) {
                collect_subtree(*pid, &children, &present, &mut claimed, &mut lsp_subtree);
            }
        }
        // Browser-tab renderers (Windows only; the map is empty elsewhere, so web
        // content stays in App core).
        let mut browser = Vec::new();
        for (pid, rroot) in &renderer_root {
            if norm_path(rroot) == norm_path(root) {
                collect_subtree(*pid, &children, &present, &mut claimed, &mut browser);
            }
        }
        let browser_count = browsers
            .iter()
            .filter(|b| norm_path(&b.root) == norm_path(root))
            .count();
        proj_pids.push(ProjectPids {
            root: root.clone(),
            pty_subtrees,
            lsp: lsp_subtree,
            browser,
            browser_count,
        });
    }

    // App core: the host subtree minus everything claimed above (host process,
    // the WebView2 UI/GPU processes, and any unattributed renderers).
    let mut app_pids = Vec::new();
    collect_subtree(host, &children, &present, &mut claimed, &mut app_pids);

    // Load command lines + exe paths for just the terminal pids (the minimal
    // refresh above skips both) so we can tell a Claude session from a plain
    // shell — a Node-hosted `claude` only shows "claude" in its cmd-line script
    // path, while the native binary shows it in the exe.
    let term_pid_list: Vec<Pid> = proj_pids
        .iter()
        .flat_map(|p| p.pty_subtrees.iter().flatten().copied())
        .map(Pid::from_u32)
        .collect();
    if !term_pid_list.is_empty() {
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&term_pid_list),
            false,
            ProcessRefreshKind::nothing()
                .with_cmd(UpdateKind::Always)
                .with_exe(UpdateKind::Always),
        );
    }

    // Resolve accurate memory (private working set on Windows) for ONLY the
    // processes we attribute — so the OS is queried for our ~handful of pids, not
    // every process on the machine.
    let mut mem_map: HashMap<u32, u64> = HashMap::with_capacity(claimed.len());
    for &pid in &claimed {
        let rss = present.get(&pid).map(|&(_, m)| m).unwrap_or(0);
        mem_map.insert(pid, process_memory(pid, rss));
    }

    // Now build usages from cpu (present) + accurate memory (mem_map).
    let projects: Vec<OwnerUsage> = proj_pids
        .iter()
        .map(|p| {
            // Split this project's terminals into Claude sessions vs plain shells
            // by what's actually running in each PTY's subtree.
            let mut claude_pids = Vec::new();
            let mut claude_count = 0usize;
            let mut term_pids = Vec::new();
            let mut term_count = 0usize;
            for sub in &p.pty_subtrees {
                if subtree_is_claude(sub, &sys) {
                    claude_count += 1;
                    claude_pids.extend(sub.iter().copied());
                } else {
                    term_count += 1;
                    term_pids.extend(sub.iter().copied());
                }
            }

            let mut breakdown = Vec::new();
            if claude_count > 0 {
                breakdown.push(Component {
                    kind: "claude".into(),
                    label: format!(
                        "{claude_count} Claude{}",
                        if claude_count == 1 { "" } else { "s" }
                    ),
                    usage: sum_usage(&claude_pids, &present, &mem_map, ncpu, total_mem),
                });
            }
            if term_count > 0 {
                breakdown.push(Component {
                    kind: "terminal".into(),
                    label: format!(
                        "{term_count} terminal{}",
                        if term_count == 1 { "" } else { "s" }
                    ),
                    usage: sum_usage(&term_pids, &present, &mem_map, ncpu, total_mem),
                });
            }
            if !p.lsp.is_empty() {
                breakdown.push(Component {
                    kind: "lsp".into(),
                    label: "Language server".into(),
                    usage: sum_usage(&p.lsp, &present, &mem_map, ncpu, total_mem),
                });
            }
            // Only surface a browser line when renderers were actually measured
            // (so off-Windows the tabs don't appear with a misleading zero —
            // they're counted in App core instead).
            if !p.browser.is_empty() {
                breakdown.push(Component {
                    kind: "browser".into(),
                    label: format!(
                        "{} browser tab{}",
                        p.browser_count,
                        if p.browser_count == 1 { "" } else { "s" }
                    ),
                    usage: sum_usage(&p.browser, &present, &mem_map, ncpu, total_mem),
                });
            }
            let mut all = claude_pids;
            all.extend(term_pids);
            all.extend(&p.lsp);
            all.extend(&p.browser);
            OwnerUsage {
                label: base_name(&p.root),
                root: Some(p.root.clone()),
                usage: sum_usage(&all, &present, &mem_map, ncpu, total_mem),
                breakdown,
            }
        })
        .collect();

    let app = OwnerUsage {
        label: "App core".into(),
        root: None,
        usage: sum_usage(&app_pids, &present, &mem_map, ncpu, total_mem),
        breakdown: Vec::new(),
    };

    // Total = app + projects (disjoint by construction, so summing is exact).
    let total = Usage {
        cpu_pct: app.usage.cpu_pct + projects.iter().map(|p| p.usage.cpu_pct).sum::<f32>(),
        mem_pct: app.usage.mem_pct + projects.iter().map(|p| p.usage.mem_pct).sum::<f32>(),
        mem_bytes: app.usage.mem_bytes + projects.iter().map(|p| p.usage.mem_bytes).sum::<u64>(),
    };

    ResourceReport {
        total,
        app,
        projects,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Boxed with an explicit signature: the macro's closure is generic over the
    // runtime, which can't be inferred at a plain `let` binding.
    let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![
        read_project_tree,
        watch_project_tree,
        unwatch_project_tree,
        read_file_text,
        write_file_text,
        prettier_format,
        read_prettier_config_files,
        find_project_favicon,
        git_current_branch,
        git_diff,
        git_status,
        git_stage,
        git_unstage,
        git_commit,
        git_push,
        git_pull,
        git_fetch,
        git_unpushed_commits,
        git_branches,
        git_checkout,
        read_state,
        write_state,
        list_shells,
        detect_claude_path,
        validate_claude_path,
        pty_spawn,
        pty_write,
        pty_resize,
        pty_kill,
        save_pasted_image,
        lsp_spawn,
        lsp_send,
        lsp_kill,
        lsp_status,
        browser_create,
        browser_navigate,
        browser_reload,
        browser_back,
        browser_forward,
        browser_set_bounds,
        browser_show,
        browser_hide,
        browser_close,
        browser_get_url,
        browser_set_active,
        browser_pick_start,
        browser_pick_stop,
        browser_pick_toast,
        claude_browser_mcp_config,
        claude_usage,
        resource_stats,
        frontend_log,
        jira::jira_status,
        jira::jira_connect,
        jira::jira_disconnect,
        jira::jira_resolve_branch,
        jira::open_external
    ]);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Persist window size/position/etc., but NOT decorations: the window's
        // decorated state is a per-platform config decision (macOS uses the
        // native title bar via titleBarStyle: Overlay; Windows/Linux are
        // borderless with custom controls). Left in, the plugin would restore a
        // stale `decorated` value saved from an earlier run and override the
        // config — leaving macOS without traffic lights or rounded corners.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
        // Self-update (desktop only): the frontend drives check/download via the
        // updater JS API; `process` provides the relaunch after install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PtyManager::default())
        .manage(ResolvedEnv::default())
        .manage(TreeWatcherManager::default())
        .manage(LspManager::default())
        .manage(BrowserManager::default())
        .manage(ResourceMonitor::default())
        .manage(WebviewProcessMap::default())
        .manage(jira::JiraState::default())
        // Wrap the generated handler so the native watchdog knows which command
        // is executing. Sync commands run to completion inside this call (on
        // the main thread — the very thing the watchdog monitors); async ones
        // just dispatch, so their entry is set and cleared in microseconds.
        .invoke_handler(move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
            let cmd = invoke.message.command().to_string();
            watchdog::command_started(&cmd);
            let handled = handler(invoke);
            watchdog::command_finished(&cmd);
            handled
        })
        // Lifecycle breadcrumbs: a crash leaves no CloseRequested before the
        // process ends, a normal quit logs one — that distinction is the first
        // thing to check in the log after an unexpected exit.
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                log::info!("window '{}' close requested (user quit)", window.label());
            }
            tauri::WindowEvent::Destroyed => {
                log::info!("window '{}' destroyed", window.label());
            }
            _ => {}
        })
        .setup(|app| {
            // File logging in ALL builds (it was debug-only, so released-build
            // crashes left no trace). Default targets: stdout, the log dir
            // (…\AppData\Local\com.meridian.ade\logs), and the webview console.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
            let log_dir = app
                .path()
                .app_log_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            install_panic_hook(log_dir);
            // Native main-thread watchdog: logs when the event loop stops
            // responding and which command was running (see watchdog.rs) —
            // the counterpart of the frontend watchdog, which only sees
            // JS-thread stalls.
            watchdog::start(app.handle().clone());
            log::info!(
                "Meridian v{} started (debug={})",
                env!("CARGO_PKG_VERSION"),
                cfg!(debug_assertions)
            );
            // Start the in-process MCP server backing the `@browser` feature. If
            // it can't bind a port, the feature stays off: McpState is left
            // unmanaged, so `claude_browser_mcp_config` errors and the frontend
            // falls back to launching plain `claude`.
            match mcp::start(app.handle().clone()) {
                Some(state) => {
                    app.manage(state);
                }
                None => log::warn!("MCP browser server failed to start; @browser disabled"),
            }
            // Resolve the login-shell PATH off the main thread (see ResolvedEnv)
            // so a slow profile can't delay window paint. PTYs opened before it
            // lands just use the inherited PATH, as before; in practice the user
            // opens a terminal seconds later, by which point it's ready.
            let env_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Some(path) = resolve_login_path() {
                    log::info!("resolved login PATH ({} chars)", path.len());
                    *env_handle.state::<ResolvedEnv>().path.lock().unwrap() = Some(path);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
