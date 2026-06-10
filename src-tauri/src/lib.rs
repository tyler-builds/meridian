use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl,
};

/// A single running pseudo-terminal session.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Holds every live PTY keyed by a frontend-supplied id.
#[derive(Default)]
struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
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

#[tauri::command]
fn read_project_tree(path: String) -> Result<Vec<String>, String> {
    let root = std::path::PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    let mut out = Vec::new();
    walk(&root, &root, &mut out, 0);
    out.sort();
    Ok(out)
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
#[tauri::command]
fn git_diff(path: String, ignore_whitespace: bool) -> Result<String, String> {
    // Confirm it's a work tree; this also surfaces "git not installed".
    let check = run_git(&path, &["rev-parse", "--is-inside-work-tree"])?;
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
    let tracked = run_git(&path, &head_args)?;
    let mut patch = if tracked.status.success() {
        String::from_utf8_lossy(&tracked.stdout).into_owned()
    } else {
        let plain = run_git(&path, &tracked_args)?;
        String::from_utf8_lossy(&plain.stdout).into_owned()
    };

    // Append untracked files as additions so new files appear in the diff.
    // `--no-index` exits non-zero when files differ (the normal case here), so
    // its status is ignored — only stdout matters.
    let untracked = run_git(&path, &["ls-files", "--others", "--exclude-standard"])?;
    if untracked.status.success() {
        let list = String::from_utf8_lossy(&untracked.stdout).into_owned();
        for file in list.lines().filter(|l| !l.trim().is_empty()) {
            let out = run_git(&path, &["diff", "--no-index", "--", "/dev/null", file])?;
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
}

/// Structured status for the Git panel: the changed-file list (parsed from
/// `git status --porcelain=v1 -z`) plus branch/upstream/ahead-behind context.
/// Errs when the path isn't a git work tree or `git` isn't available.
#[tauri::command]
fn git_status(path: String) -> Result<GitStatus, String> {
    let check = run_git(&path, &["rev-parse", "--is-inside-work-tree"])?;
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
    let out = run_git(&path, &["status", "--porcelain=v1", "-z"])?;
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

    let has_commits = run_git(&path, &["rev-parse", "--verify", "HEAD"])
        .map(|o| o.status.success())
        .unwrap_or(false);
    let branch = git_str(&path, &["symbolic-ref", "--short", "HEAD"]);
    let detached = branch.is_none() && has_commits;
    let has_remote = git_str(&path, &["remote"])
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let has_upstream = git_str(
        &path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .is_some();

    // `git rev-list --left-right --count @{u}...HEAD` prints "<behind>\t<ahead>".
    let (mut ahead, mut behind) = (0u32, 0u32);
    if has_upstream {
        if let Some(counts) =
            git_str(&path, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])
        {
            let mut parts = counts.split_whitespace();
            behind = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
            ahead = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        }
    }

    Ok(GitStatus {
        files,
        branch,
        detached,
        ahead,
        behind,
        has_upstream,
        has_remote,
        has_commits,
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
        },
    );

    // Pump PTY output to the frontend on a dedicated thread.
    let app_handle = app.clone();
    let mut reader = reader;
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if app_handle.emit(&output_event, buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_handle.emit(&exit_event, ());
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(PtyManager::default())
        .manage(BrowserManager::default())
        .invoke_handler(tauri::generate_handler![
            read_project_tree,
            read_file_text,
            write_file_text,
            find_project_favicon,
            git_current_branch,
            git_diff,
            git_status,
            git_stage,
            git_unstage,
            git_commit,
            git_push,
            read_state,
            write_state,
            list_shells,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
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
            claude_usage
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
