use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl,
};

mod jira;
#[cfg(windows)]
mod webview_procs;

/// A single running pseudo-terminal session.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
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
struct LspSession {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
}

/// Holds every live language server keyed by project root path.
#[derive(Default)]
struct LspManager {
    sessions: Mutex<HashMap<String, LspSession>>,
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

/// Recursively collect relative POSIX file paths under `root`.
/// Directories are derived by the tree from the file paths (path-first model),
/// so only files are emitted.
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
            walk(root, &path, out, depth + 1);
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

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Read a UTF-8 text file (project root + relative path) for the editor.
#[tauri::command]
fn read_file_text(root: String, rel: String) -> Result<String, String> {
    let mut path = std::path::PathBuf::from(&root);
    path.push(&rel);
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Err("File is too large to open in the editor".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "Binary or non-UTF-8 file".to_string())
}

/// Write text content to a file (project root + relative path).
#[tauri::command]
fn write_file_text(root: String, rel: String, content: String) -> Result<(), String> {
    let mut path = std::path::PathBuf::from(&root);
    path.push(&rel);
    std::fs::write(&path, content).map_err(|e| e.to_string())
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

        let spawned = Command::new("node")
            .arg(&entry)
            .arg("--stdin-filepath")
            .arg(&file_path)
            .current_dir(&file_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

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

/// Run `git` inside `root` and capture its output. On Windows the
/// CREATE_NO_WINDOW flag keeps a console from flashing on each invocation.
fn run_git(root: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(root).args(args);
    // Never let git block on an interactive auth/credential prompt: with no TTY
    // (and CREATE_NO_WINDOW on Windows) such a prompt can't be answered and
    // would hang. Force git to fail fast instead so the error surfaces in the UI.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
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
#[tauri::command]
fn git_stage(path: String, files: Vec<String>) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(files.iter().map(String::as_str));
    run_git_checked(&path, &args).map(|_| ())
}

/// Unstage the given paths. Uses `git restore --staged` normally, falling back
/// to `git rm --cached` in a fresh repo with no commits (where there's no HEAD
/// for `restore` to resolve against). A no-op when the list is empty.
#[tauri::command]
fn git_unstage(path: String, files: Vec<String>) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
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
}

/// Commit the staged changes with `message`. Rejects an empty message.
#[tauri::command]
fn git_commit(path: String, message: String) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Commit message is empty".to_string());
    }
    run_git_checked(&path, &["commit", "-m", &message]).map(|_| ())
}

/// Push the current branch. When the branch has no upstream yet, push with
/// `-u` to the `origin` remote (or the first remote if `origin` is absent),
/// which sets the upstream for subsequent pushes. Runs async so a slow network
/// push doesn't block the UI thread; `GIT_TERMINAL_PROMPT=0` keeps an
/// unauthenticated push from hanging (it errors with the git message instead).
#[tauri::command]
async fn git_push(path: String) -> Result<(), String> {
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
}

/// Fetch from the remote so the local ahead/behind counts reflect the latest
/// upstream, without touching the working tree. Prunes deleted remote branches.
/// Runs async (network) with `GIT_TERMINAL_PROMPT=0` so an unauthenticated
/// fetch fails fast instead of hanging. Errs when there's no remote configured.
#[tauri::command]
async fn git_fetch(path: String) -> Result<(), String> {
    let has_remote = git_str(&path, &["remote"])
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if !has_remote {
        return Err("No git remote configured".to_string());
    }
    run_git_checked(&path, &["fetch", "--prune"]).map(|_| ())
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
fn git_branches(path: String) -> Result<Vec<String>, String> {
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
}

/// Switch to `branch`. When `create` is set, make it first (`checkout -b`) so a
/// brand-new branch is created off the current HEAD and checked out. Git's own
/// error (e.g. local changes would be overwritten) is surfaced to the caller.
#[tauri::command]
fn git_checkout(path: String, branch: String, create: bool) -> Result<(), String> {
    let trimmed = branch.trim();
    if trimmed.is_empty() {
        return Err("Branch name is empty".to_string());
    }
    let args: Vec<&str> = if create {
        vec!["checkout", "-b", trimmed]
    } else {
        vec!["checkout", trimmed]
    };
    run_git_checked(&path, &args).map(|_| ())
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
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
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

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Release the slave handle so the PTY closes cleanly when the child exits.
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let output_event = format!("pty://output/{id}");
    let exit_event = format!("pty://exit/{id}");

    // Register the session before the reader thread emits, so the first bytes
    // (the shell banner/prompt) are never dropped. The frontend attaches its
    // listener before calling this command.
    state.sessions.lock().unwrap().insert(
        id,
        PtySession {
            master: pair.master,
            writer,
            child,
            cwd,
        },
    );

    // Pump PTY output to the frontend on a dedicated thread. Target the main
    // webview only — a bare `emit` broadcasts every chunk to ALL webviews,
    // including the embedded browser tabs' external pages, which can't use the
    // events and just burn renderer CPU evaluating them.
    let app_handle = app.clone();
    let mut reader = reader;
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if app_handle
                        .emit_to("main", &output_event, buf[..n].to_vec())
                        .is_err()
                    {
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
fn pty_write(state: State<PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&id) {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(state: State<PtyManager>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&id) {
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
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
fn save_pasted_image(data_base64: String, ext: String) -> Result<String, String> {
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

    let mut child = Command::new("node")
        .arg(denormalize(&server))
        .arg("--stdio")
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            log::warn!("LSP: failed to launch node for {root}: {e}");
            format!("Could not launch the language server via Node: {e}")
        })?;
    log::info!("LSP: spawned server for {root}");

    let stdout = child.stdout.take().ok_or("language server has no stdout")?;
    let stdin = child.stdin.take().ok_or("language server has no stdin")?;

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
        .insert(root.clone(), LspSession { child, stdin });

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
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&root) {
        // Content-Length is the byte length of the UTF-8 payload.
        let header = format!("Content-Length: {}\r\n\r\n", message.len());
        session
            .stdin
            .write_all(header.as_bytes())
            .map_err(|e| e.to_string())?;
        session
            .stdin
            .write_all(message.as_bytes())
            .map_err(|e| e.to_string())?;
        session.stdin.flush().map_err(|e| e.to_string())?;
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
}

/// Holds every live browser webview keyed by a frontend-supplied id.
#[derive(Default)]
struct BrowserManager {
    sessions: Mutex<HashMap<String, BrowserSession>>,
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

#[tauri::command]
async fn browser_create(
    app: AppHandle,
    state: State<'_, BrowserManager>,
    id: String,
    url: String,
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
        },
    );

    let nav_event = format!("browser://navstate/{id}");
    let title_event = format!("browser://title/{id}");
    let newtab_event = format!("browser://newtab/{id}");
    let nav_app = app.clone();
    let nav_id = id.clone();

    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .initialization_script(BROWSER_INIT_SCRIPT)
        .on_navigation(move |url| {
            // The injected script funnels window.open / target=_blank through
            // this sentinel host; turn it into a new in-app tab and cancel the
            // navigation so the current page stays put.
            if url.host_str() == Some(NEWTAB_HOST) {
                if let Some((_, target)) = url.query_pairs().find(|(k, _)| k == "url") {
                    let _ = nav_app.emit(&newtab_event, target.into_owned());
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

#[tauri::command]
async fn browser_get_url(app: AppHandle, id: String) -> Result<String, String> {
    let webview = app
        .get_webview(&browser_label(&id))
        .ok_or_else(|| "browser not found".to_string())?;
    webview.url().map(|u| u.to_string()).map_err(|e| e.to_string())
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
/// rather than erroring, so the status bar just hides the bars.
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
    let Ok(resp) = resp else {
        return ClaudeUsage::default();
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
#[tauri::command]
fn resource_stats(
    app: AppHandle,
    monitor: State<ResourceMonitor>,
    pty: State<PtyManager>,
    lsp: State<LspManager>,
    wv: State<WebviewProcessMap>,
    roots: Vec<String>,
    browsers: Vec<BrowserOwner>,
) -> ResourceReport {
    // Kick off an async refresh of the WebView2 renderer map (Windows only) and
    // read the latest snapshot. The first poll sees an empty map (browsers fold
    // into App core) and self-corrects on the next tick.
    #[cfg(windows)]
    webview_procs::refresh(&app, wv.renderers.clone());
    #[cfg(not(windows))]
    let _ = &app;
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
    sys.refresh_processes(ProcessesToUpdate::All, true);
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

    // Load command lines for just the terminal pids (the default refresh skips
    // cmd) so we can tell a Claude session from a plain shell — a Node-hosted
    // `claude` only shows "claude" in its cmd-line script path.
    let term_pid_list: Vec<Pid> = proj_pids
        .iter()
        .flat_map(|p| p.pty_subtrees.iter().flatten().copied())
        .map(Pid::from_u32)
        .collect();
    if !term_pid_list.is_empty() {
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&term_pid_list),
            false,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(PtyManager::default())
        .manage(LspManager::default())
        .manage(BrowserManager::default())
        .manage(ResourceMonitor::default())
        .manage(WebviewProcessMap::default())
        .manage(jira::JiraState::default())
        .invoke_handler(tauri::generate_handler![
            read_project_tree,
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
            claude_usage,
            resource_stats,
            frontend_log,
            jira::jira_status,
            jira::jira_connect,
            jira::jira_disconnect,
            jira::jira_resolve_branch,
            jira::open_external
        ])
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
            log::info!(
                "Meridian v{} started (debug={})",
                env!("CARGO_PKG_VERSION"),
                cfg!(debug_assertions)
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
