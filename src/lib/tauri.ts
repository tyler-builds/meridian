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

// --- Prettier ---

export interface PrettierResult {
  /** Formatted text, or null when no project-local Prettier could be run. */
  formatted: string | null;
  /** "local" when the project's Prettier produced the output, else "none". */
  source: "local" | "none";
}

/**
 * Format `content` with the project's own installed Prettier, treating it as the
 * file at the absolute `path` (so Prettier resolves its config, parser, and
 * .prettierignore from there). Resolves with `source: "none"` when no local
 * Prettier exists (caller should fall back); rejects with Prettier's message on
 * a parse error.
 */
export function prettierFormatLocal(
  path: string,
  content: string,
): Promise<PrettierResult> {
  return invoke<PrettierResult>("prettier_format", { path, content });
}

/** One declarative Prettier config file discovered up the directory tree. */
export interface PrettierConfigFile {
  /** Path relative to the project root (POSIX separators). */
  rel: string;
  contents: string;
}

/**
 * Collect declarative Prettier config files (nearest first) from the formatted
 * file's directory up to the project root. Used by the bundled fallback
 * formatter to honor a project's config when it has no local Prettier.
 */
export function readPrettierConfigFiles(
  root: string,
  rel: string,
): Promise<PrettierConfigFile[]> {
  return invoke<PrettierConfigFile[]>("read_prettier_config_files", {
    root,
    rel,
  });
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

// --- Resource monitor ---

/** CPU/RAM figures for one owner, normalized to the whole machine. */
export interface Usage {
  /** Percent of total machine CPU capacity (0–100 across all cores). */
  cpuPct: number;
  /** Percent of total system memory. */
  memPct: number;
  /** Resident set size in bytes. */
  memBytes: number;
}

/** A category of resource use within a project (terminals, language server…). */
export interface ResourceComponent {
  /** Stable kind for icon selection: "terminal" | "lsp" | "browser". */
  kind: string;
  /** Human label, e.g. "3 terminals" or "Language server". */
  label: string;
  usage: Usage;
}

/** Resource use for one owner — "App core" or an open project. */
export interface OwnerUsage {
  /** "App core", or the project's folder name. */
  label: string;
  /** Absolute project root, or null for App core. */
  root: string | null;
  usage: Usage;
  /** What inside this owner is consuming resources (empty for App core). */
  breakdown: ResourceComponent[];
}

/**
 * CPU and memory for the entire Meridian process tree, attributed to App core
 * (host + WebView2 UI/GPU/renderers) and each open project (its terminal
 * subtrees + language server). `total` is the exact sum of `app` + `projects`.
 */
export interface ResourceReport {
  total: Usage;
  app: OwnerUsage;
  projects: OwnerUsage[];
}

/** One open browser tab and the project it belongs to (for renderer attribution). */
export interface BrowserOwner {
  url: string;
  root: string;
}

/**
 * Snapshot resource usage. Pass the currently-open project roots, and the open
 * browser tabs (url + owning root) so Windows can attribute each tab's renderer
 * to its project; elsewhere `browsers` is ignored and web content stays in App
 * core.
 */
export function resourceStats(
  roots: string[],
  browsers: BrowserOwner[] = [],
): Promise<ResourceReport> {
  return invoke<ResourceReport>("resource_stats", { roots, browsers });
}

// --- Jira integration ---

/** Connection state for the Jira card in Settings → Connections. */
export interface JiraStatus {
  /** Authorized and ready to make API calls. */
  connected: boolean;
  /** Was connected, but the refresh token expired/was revoked — re-auth needed. */
  needsReconnect: boolean;
  /** A client id + secret have been saved (an app to connect *with*). */
  hasApp: boolean;
  /** The connected site's base URL, e.g. "https://acme.atlassian.net". */
  siteUrl: string | null;
  /** Display name of the authorized account. */
  accountName: string | null;
  /** Last connect error, if any (only set by the connect flow). */
  error: string | null;
}

/** Read the current Jira connection status (reads metadata + keychain). */
export function jiraStatus(): Promise<JiraStatus> {
  return invoke<JiraStatus>("jira_status");
}

/**
 * Run the OAuth 3LO loopback flow: opens the system browser to Atlassian's
 * consent screen, catches the callback locally, exchanges + stores tokens.
 * Resolves with the resulting status; connect failures come back in `error`.
 */
export function jiraConnect(): Promise<JiraStatus> {
  return invoke<JiraStatus>("jira_connect");
}

/** Forget the authorization (clears the refresh token), keeping the saved app. */
export function jiraDisconnect(): Promise<JiraStatus> {
  return invoke<JiraStatus>("jira_disconnect");
}

/** A Jira issue key resolved to its summary and the branch name to create. */
export interface JiraBranch {
  /** Normalized issue key, e.g. "OWS-12345". */
  key: string;
  summary: string;
  /** e.g. "OWS-12345-fix-the-login-timeout". */
  branch: string;
}

/**
 * Look up an issue's summary and build its Jira-style branch name. Rejects when
 * the key is malformed, the issue isn't found, or Jira isn't connected.
 */
export function jiraResolveBranch(issueKey: string): Promise<JiraBranch> {
  return invoke<JiraBranch>("jira_resolve_branch", { issueKey });
}

/** Open an http(s) URL in the system browser. */
export function openExternal(url: string): Promise<void> {
  return invoke("open_external", { url });
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

/**
 * Save a pasted image (base64, no `data:` prefix) to a temp file and return its
 * absolute path. The terminal then hands the path to the running program (e.g.
 * Claude Code) as a bracketed paste, so it loads the image by path.
 */
export function savePastedImage(
  dataBase64: string,
  ext: string,
): Promise<string> {
  return invoke<string>("save_pasted_image", { dataBase64, ext });
}

// Rolling terminal-output counters the freeze watchdog samples to attribute a
// main-thread stall to its likely cause — PTY output flooding the JS event loop
// is the dominant one. The watchdog resets these each tick (see watchdog.ts).
let ptyWindowBytes = 0;
let ptyWindowEvents = 0;
export function ptyOutputWindow(): { bytes: number; events: number } {
  return { bytes: ptyWindowBytes, events: ptyWindowEvents };
}
export function resetPtyOutputWindow(): void {
  ptyWindowBytes = 0;
  ptyWindowEvents = 0;
}

export function onPtyOutput(
  id: string,
  cb: (data: Uint8Array) => void,
): Promise<UnlistenFn> {
  // Backend sends coalesced, base64-encoded chunks (see the PTY emitter in
  // lib.rs). Decode in one pass — far cheaper than rebuilding a Uint8Array from
  // a JSON number-array element by element.
  return listen<string>(`pty://output/${id}`, (e) => {
    const bin = atob(e.payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    ptyWindowBytes += bytes.length;
    ptyWindowEvents += 1;
    cb(bytes);
  });
}

export function onPtyExit(id: string, cb: () => void): Promise<UnlistenFn> {
  return listen(`pty://exit/${id}`, () => cb());
}

// --- Language server (LSP) ---
//
// One `typescript-language-server` process per project root. The backend owns
// the Content-Length framing, so messages cross this boundary as plain JSON-RPC
// strings. The frontend attaches `onLspMessage`/`onLspExit` BEFORE calling
// `lspSpawn`, the same listen-first order the PTY commands use.

/**
 * Spawn (or reuse) the language server for a project root. Rejects if none is
 * found. `id` is an opaque, event-safe identifier the backend uses for the
 * message/exit event names (the project path can't be — Tauri event names
 * forbid `\` and `.`). Attach `onLspMessage(id, …)` before calling this.
 */
export function lspSpawn(id: string, root: string): Promise<void> {
  return invoke("lsp_spawn", { id, root });
}

/** Send one JSON-RPC message (no framing) to the server for `root`. */
export function lspSend(root: string, message: string): Promise<void> {
  return invoke("lsp_send", { root, message });
}

/** Stop and forget the language server for `root`. */
export function lspKill(root: string): Promise<void> {
  return invoke("lsp_kill", { root });
}

/**
 * Project roots whose language-server process is actually alive right now
 * (probed in the backend, dead processes pruned) — the source of truth for the
 * status bar, not an assumption from the open file.
 */
export function lspStatus(): Promise<string[]> {
  return invoke<string[]>("lsp_status");
}

/** Write a line to Meridian's durable log file (mirrors main.tsx's reporter). */
export function frontendLog(
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  return invoke<void>("frontend_log", { level, message }).catch(() => {});
}

/** Incoming JSON-RPC messages (complete, unframed) for the client with this id. */
export function onLspMessage(
  id: string,
  cb: (message: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`lsp://message/${id}`, (e) => cb(e.payload));
}

/** Fired when the server process for the client with this id exits. */
export function onLspExit(id: string, cb: () => void): Promise<UnlistenFn> {
  return listen(`lsp://exit/${id}`, () => cb());
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
