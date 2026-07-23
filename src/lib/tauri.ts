import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

// --- App metadata ---
//
// `appVersion()` is the version from tauri.conf.json, which CI stamps from the
// release tag (see scripts/ci-set-version.mjs). In dev it's the committed
// placeholder. Both are covered by `core:default`, so no extra capability.
export { getVersion as appVersion, getTauriVersion } from "@tauri-apps/api/app";

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

/**
 * Start a recursive filesystem watcher on a project root. When files are
 * created/deleted/renamed on disk, the refreshed path list is emitted on
 * `tree://change/{id}` (attach via `onProjectTreeChange`). `id` is an opaque,
 * event-safe identifier (the project tab id). Idempotent per id.
 */
export function watchProjectTree(id: string, path: string): Promise<void> {
  return invoke("watch_project_tree", { id, path });
}

/** Stop and release the filesystem watcher for `id`. */
export function unwatchProjectTree(id: string): Promise<void> {
  return invoke("unwatch_project_tree", { id });
}

/**
 * Fired with the project's new relative POSIX file paths whenever its tree
 * changes on disk. Only emits when the *set* of paths changes — content-only
 * edits and churn under ignored dirs (node_modules/.git/build output) don't.
 */
export function onProjectTreeChange(
  id: string,
  cb: (paths: string[]) => void,
): Promise<UnlistenFn> {
  return listen<string[]>(`tree://change/${id}`, (e) => cb(e.payload));
}

/**
 * Fired by a project's tree watcher with the relative POSIX paths that changed
 * on disk (created/deleted/renamed *and* content-only edits — unlike
 * `onProjectTreeChange`, which only fires when the path set changes). One
 * global event for all watched projects; filter on `root`, which is echoed
 * verbatim from the `watchProjectTree` call. Lets open editors reload files
 * modified outside the app.
 */
export function onProjectFilesChange(
  cb: (change: { root: string; paths: string[] }) => void,
): Promise<UnlistenFn> {
  return listen<{ root: string; paths: string[] }>("files://change", (e) =>
    cb(e.payload),
  );
}

/** One matching line from a full-repo search. */
export interface SearchMatch {
  /** Path relative to the search root, POSIX separators. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** The matched line (long lines are windowed around the first match). */
  text: string;
  /** [start, end) match offsets into `text`, in JS string (UTF-16) indices. */
  spans: [number, number][];
}

export interface SearchResults {
  matches: SearchMatch[];
  /** Number of distinct files with at least one match. */
  files: number;
  /** True when the result cap was hit — more matches exist on disk. */
  truncated: boolean;
}

/**
 * Full-repo content search (ripgrep's engine in-process; respects .gitignore).
 * `regex:false` treats the query as a literal. `include`/`exclude` are
 * comma-separated globs relative to the root (empty string = no filter).
 */
export function searchProject(
  root: string,
  query: string,
  opts: {
    regex: boolean;
    caseSensitive: boolean;
    include: string;
    exclude: string;
  },
): Promise<SearchResults> {
  return invoke<SearchResults>("search_project", {
    root,
    query,
    regex: opts.regex,
    caseSensitive: opts.caseSensitive,
    include: opts.include,
    exclude: opts.exclude,
  });
}

/** Read a UTF-8 text file (project root + relative path) for the editor. */
export function readFileText(root: string, rel: string): Promise<string> {
  return invoke<string>("read_file_text", { root, rel });
}

/**
 * Read a file as raw bytes (project root + relative path) for media preview.
 * Resolves to an `ArrayBuffer` (the command returns a binary IPC response).
 */
export function readFileBytes(root: string, rel: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_file_bytes", { root, rel });
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

/** Create an empty file (project root + relative path). Rejects if it exists. */
export function createFile(root: string, rel: string): Promise<void> {
  return invoke("create_file", { root, rel });
}

/** Create a directory (project root + relative path). Rejects if it exists. */
export function createDirectory(root: string, rel: string): Promise<void> {
  return invoke("create_directory", { root, rel });
}

/** Delete a file, or a directory and all its contents (project root + relative). */
export function deletePath(root: string, rel: string): Promise<void> {
  return invoke("delete_path", { root, rel });
}

/** Rename/move a file or directory within a project (relative paths). */
export function renamePath(
  root: string,
  from: string,
  to: string,
): Promise<void> {
  return invoke("rename_path", { root, from, to });
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

// --- Claude binary ---

/**
 * Auto-detect the `claude` binary's absolute path: searches the resolved login
 * PATH, then well-known install locations. Returns null if nothing is found (the
 * user must then set the path manually). Backs the "Claude binary path" setting.
 */
export function detectClaudePath(): Promise<string | null> {
  return invoke<string | null>("detect_claude_path");
}

/** True if `path` points at an existing file (live validation for the setting). */
export function validateClaudePath(path: string): Promise<boolean> {
  return invoke<boolean>("validate_claude_path", { path });
}

/** Open the native file picker to choose the Claude binary. Null if cancelled. */
export async function pickClaudeBinary(): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    title: "Select Claude binary",
  });
  return typeof selected === "string" ? selected : null;
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
  env?: Record<string, string>,
): Promise<void> {
  return invoke("pty_spawn", { id, cwd, cols, rows, shell, env });
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function ptyResize(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
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
  projectRoot: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return invoke("browser_create", {
    id,
    url,
    projectRoot,
    x,
    y,
    width,
    height,
  });
}

/**
 * Mark a browser tab as the visible/active surface (or not) so the MCP server's
 * browser tools default to the tab the user is looking at.
 */
export function browserSetActive(id: string, active: boolean): Promise<void> {
  return invoke("browser_set_active", { id, active });
}

/**
 * Write (or rewrite) the MCP config the in-app `claude` uses to reach Meridian's
 * browser server for `projectRoot`, and resolve with its absolute path. Pass it
 * to `claude --mcp-config <path>`. Rejects if the MCP server isn't running (the
 * caller should fall back to launching plain `claude`). `evalJs` registers the
 * powerful `eval_js` tool for this session.
 */
export function claudeBrowserMcpConfig(
  projectRoot: string,
  evalJs: boolean,
): Promise<string> {
  return invoke<string>("claude_browser_mcp_config", { projectRoot, evalJs });
}

/**
 * Write (or rewrite) the Claude Code `--settings` file that registers Meridian's
 * Stop/Notification hooks for the Claude tab `tabId`, and resolve with its
 * absolute path. Pass it to `claude --settings <path>`; it merges with (never
 * replaces) the user's own settings/hooks. The hooks POST to the localhost
 * server's `/attention` route, which is the authoritative "Claude finished / needs
 * you" signal. Rejects if the MCP server isn't running or `curl` isn't found — the
 * caller then launches `claude` without hooks (the title heuristic still applies).
 */
export function claudeHooksConfig(tabId: string): Promise<string> {
  return invoke<string>("claude_hooks_config", { tabId });
}

/**
 * Fired when a Claude tab's Stop/Notification hook calls back: `tab` is the
 * content id, `event` is `"stop"` (turn finished) or `"notification"` (permission/
 * input prompt — Claude needs you). One global event for all projects.
 */
export function onClaudeAttentionEvent(
  cb: (payload: { tab: string; event: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ tab: string; event: string }>("claude://attention", (e) =>
    cb(e.payload),
  );
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

/**
 * Enter element-selector mode in a browser tab: hovering outlines elements and a
 * left click captures one, delivered via `onBrowserPick`. Escape cancels.
 */
export function browserPickStart(id: string): Promise<void> {
  return invoke("browser_pick_start", { id });
}

/** Leave element-selector mode (toolbar toggle off / tab switch). */
export function browserPickStop(id: string): Promise<void> {
  return invoke("browser_pick_stop", { id });
}

/**
 * Show a brief, auto-dismissing toast inside a browser tab's page. Rendered in
 * the page (not the DOM) because the browser is a native surface over the DOM.
 */
export function browserPickToast(id: string, message: string): Promise<void> {
  return invoke("browser_pick_toast", { id, message });
}

/** A page element captured in selector mode. */
export interface PickedElement {
  /** A CSS selector path to the element (best-effort, id-anchored when possible). */
  selector: string;
  tag: string;
  id: string | null;
  classes: string;
  attributes: Record<string, string>;
  /** Visible text, truncated. */
  text: string;
  /** outerHTML, truncated. */
  html: string;
  rect: { x: number; y: number; w: number; h: number };
  url: string;
  title: string;
}

/**
 * Fired when the user picks an element (or cancels) in a tab's selector mode.
 * On a pick the payload carries the element; on cancel/Escape it's `null`.
 */
export function onBrowserPick(
  id: string,
  cb: (element: PickedElement | null) => void,
): Promise<UnlistenFn> {
  return listen<{ cancel: boolean; data?: string }>(
    `browser://pick/${id}`,
    (e) => {
      if (e.payload.cancel || !e.payload.data) {
        cb(null);
        return;
      }
      try {
        cb(JSON.parse(e.payload.data) as PickedElement);
      } catch {
        cb(null);
      }
    },
  );
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

/**
 * macOS only: show or hide the native traffic lights. Used by the icon-only
 * project rail, which is narrower than the buttons' span — they stay hidden
 * except while the pointer is near the top-left corner. No-op elsewhere.
 */
export function setTrafficLightsVisible(visible: boolean): Promise<void> {
  return invoke("set_traffic_lights_visible", { visible });
}
