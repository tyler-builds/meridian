import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

/** Open the native folder picker. Returns the chosen absolute path, or null if cancelled. */
export async function pickProjectFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open Project",
  });
  return typeof selected === "string" ? selected : null;
}

/** Read the project's file paths (relative, POSIX) for the tree. */
export function readProjectTree(path: string): Promise<string[]> {
  return invoke<string[]>("read_project_tree", { path });
}

/** Read a UTF-8 text file (project root + relative path) for the editor. */
export function readFileText(root: string, rel: string): Promise<string> {
  return invoke<string>("read_file_text", { root, rel });
}

/** Resolve a project's favicon as a data URL (t3code-style detection), or null. */
export function findProjectFavicon(root: string): Promise<string | null> {
  return invoke<string | null>("find_project_favicon", { root });
}

/** Current git branch for a project root, or null if it isn't a git repo. */
export function gitCurrentBranch(path: string): Promise<string | null> {
  return invoke<string | null>("git_current_branch", { path });
}

/** Local branch names, most-recently-committed first. Rejects if not a repo. */
export function gitBranches(path: string): Promise<string[]> {
  return invoke<string[]>("git_branches", { path });
}

/**
 * Switch to `branch`. With `create`, make it off the current HEAD first
 * (`checkout -b`). Rejects with git's message (e.g. when local changes block it).
 */
export function gitCheckout(
  path: string,
  branch: string,
  create = false,
): Promise<void> {
  return invoke("git_checkout", { path, branch, create });
}

/**
 * Unified diff of the current working-tree changes (tracked staged + unstaged
 * vs HEAD, plus untracked files). When `ignoreWhitespace` is true, whitespace-
 * only changes are dropped. Empty string when there are no changes; rejects
 * when the path isn't a git repo or `git` isn't installed.
 */
export function gitDiff(
  path: string,
  ignoreWhitespace = false,
): Promise<string> {
  return invoke<string>("git_diff", { path, ignoreWhitespace });
}

/** One changed path in the working tree (porcelain XY status). */
export interface GitFile {
  path: string;
  /** Index (staged) status code, e.g. "M", "A", "D", "R", "?", "U", " ". */
  index: string;
  /** Working-tree (unstaged) status code; "?" for untracked. */
  worktree: string;
  /** The index side has a change (the path is at least partly staged). */
  staged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

/** Working-tree status plus branch/remote context for the Git panel. */
export interface GitStatus {
  files: GitFile[];
  /** Current branch, or null on a detached HEAD. */
  branch: string | null;
  detached: boolean;
  /** Commits ahead of / behind the upstream branch. */
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  hasRemote: boolean;
  /** False in a fresh repo with no commits yet. */
  hasCommits: boolean;
  /** Local commits not on any remote — the number a push would send. */
  unpushed: number;
}

/** Structured git status driving the Source Control panel. Rejects when the path isn't a repo. */
export function gitStatus(path: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { path });
}

/** Stage the given paths (`git add`). */
export function gitStage(path: string, files: string[]): Promise<void> {
  return invoke("git_stage", { path, files });
}

/** Unstage the given paths (`git restore --staged`, or `rm --cached` pre-first-commit). */
export function gitUnstage(path: string, files: string[]): Promise<void> {
  return invoke("git_unstage", { path, files });
}

/** Commit the staged changes with the given message. */
export function gitCommit(path: string, message: string): Promise<void> {
  return invoke("git_commit", { path, message });
}

/** Push the current branch, setting the upstream automatically on first push. */
export function gitPush(path: string): Promise<void> {
  return invoke("git_push", { path });
}

/**
 * Pull the current branch from its upstream (`git pull --no-edit`). Rejects when
 * there's no upstream, when local changes would be overwritten, or on merge
 * conflicts — callers should gate this on a clean working tree.
 */
export function gitPull(path: string): Promise<void> {
  return invoke("git_pull", { path });
}

/**
 * Fetch from the remote (with prune) so ahead/behind counts reflect the latest
 * upstream, without modifying the working tree. Rejects when no remote is set.
 */
export function gitFetch(path: string): Promise<void> {
  return invoke("git_fetch", { path });
}

/**
 * Commit subjects (newest first) of the local commits a push would send.
 * Empty when there's no remote or nothing is unpushed.
 */
export function gitUnpushedCommits(path: string): Promise<string[]> {
  return invoke<string[]>("git_unpushed_commits", { path });
}

/** Write text content to a file (project root + relative path). */
export function writeFileText(
  root: string,
  rel: string,
  content: string,
): Promise<void> {
  return invoke("write_file_text", { root, rel, content });
}

// --- Claude usage ---

/** One rate-limit window's state (the same figures `/usage` shows). */
export interface ClaudeUsageWindow {
  /** Percent of the window's limit consumed (0–100). */
  utilization: number;
  /** ISO-8601 instant the window resets, or null if unknown. */
  resetsAt: string | null;
}

/**
 * Authoritative Claude subscription usage for the rolling 5-hour and weekly
 * windows, fetched from the same OAuth endpoint Claude Code's `/usage` uses
 * (read from `~/.claude/.credentials.json`). `available` is false when not
 * signed in, offline, or the token has expired.
 */
export interface ClaudeUsage {
  available: boolean;
  fiveHour: ClaudeUsageWindow;
  sevenDay: ClaudeUsageWindow;
}

export function claudeUsage(): Promise<ClaudeUsage> {
  return invoke<ClaudeUsage>("claude_usage");
}

// --- Shells ---

export interface ShellInfo {
  id: string;
  label: string;
  program: string;
  available: boolean;
}

/** List candidate shells for this platform and whether each is installed. */
export function listShells(): Promise<ShellInfo[]> {
  return invoke<ShellInfo[]>("list_shells");
}

// --- PTY ---

/**
 * Spawn a PTY. The id is supplied by the caller so it can attach output
 * listeners *before* spawning (otherwise the shell banner/prompt is dropped).
 * `shell` is the program to launch; omit for the platform default.
 */
export function ptySpawn(
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  shell?: string,
): Promise<void> {
  return invoke("pty_spawn", { id, cwd, cols, rows, shell });
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

export function onPtyOutput(
  id: string,
  cb: (data: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listen<number[]>(`pty://output/${id}`, (e) =>
    cb(new Uint8Array(e.payload)),
  );
}

export function onPtyExit(id: string, cb: () => void): Promise<UnlistenFn> {
  return listen(`pty://exit/${id}`, () => cb());
}

// --- Embedded browser ---
//
// Each browser tab is a native child webview managed in Rust. The id is
// supplied by the caller so it can attach listeners before creating the
// webview (the same listen-first order the PTY commands use). All bounds are
// logical CSS pixels relative to the window's content origin.

export interface BrowserNavState {
  url: string;
  canBack: boolean;
  canForward: boolean;
}

export function browserCreate(
  id: string,
  url: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return invoke("browser_create", { id, url, x, y, width, height });
}

export function browserNavigate(id: string, url: string): Promise<void> {
  return invoke("browser_navigate", { id, url });
}

export function browserReload(id: string): Promise<void> {
  return invoke("browser_reload", { id });
}

export function browserBack(id: string): Promise<void> {
  return invoke("browser_back", { id });
}

export function browserForward(id: string): Promise<void> {
  return invoke("browser_forward", { id });
}

export function browserSetBounds(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return invoke("browser_set_bounds", { id, x, y, width, height });
}

export function browserShow(id: string): Promise<void> {
  return invoke("browser_show", { id });
}

export function browserHide(id: string): Promise<void> {
  return invoke("browser_hide", { id });
}

export function browserClose(id: string): Promise<void> {
  return invoke("browser_close", { id });
}

export function browserGetUrl(id: string): Promise<string> {
  return invoke<string>("browser_get_url", { id });
}

export function onBrowserNavState(
  id: string,
  cb: (state: BrowserNavState) => void,
): Promise<UnlistenFn> {
  return listen<BrowserNavState>(`browser://navstate/${id}`, (e) =>
    cb(e.payload),
  );
}

export function onBrowserTitle(
  id: string,
  cb: (title: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`browser://title/${id}`, (e) => cb(e.payload));
}

/**
 * Fired when the page tried to open a new tab/window (window.open,
 * target="_blank", middle-click) — the payload is the requested URL.
 */
export function onBrowserNewTab(
  id: string,
  cb: (url: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`browser://newtab/${id}`, (e) => cb(e.payload));
}
