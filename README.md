# Meridian

Meridian is a terminal-forward agentic development environment (ADE) built with
Tauri. It pairs a native shell, an embedded browser, Git tooling, and a Monaco
editor in one window, with first-class support for running Claude in-app.

## Features

- **Projects and tabs** — open a folder, browse a virtualized file tree, and
  work across keep-alive tabs (terminals, files, browser, Git) whose state
  survives tab switches and app restarts.
- **Real terminals** — PTY-backed terminals (Windows ConPTY) with recursive
  row/column splits and drag-resizing.
- **Claude integration** — a "Claude" tab launches the `claude` CLI in a
  terminal; the status bar shows live 5-hour and weekly usage from the same
  source as the `/usage` command.
- **Embedded browser** — native webview browser tabs with history and new-tab
  interception (no IPC access from the page).
- **Git** — working-tree diff (via `@pierre/diffs`) plus a source-control panel
  for staging, committing, and pushing.
- **Monaco editor** — click a file to open it; one editor instance with
  per-file models, dirty tracking, and save.

## Tech stack

- **Shell:** Tauri v2 (Rust)
- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui
- **Terminal:** `portable-pty` (Rust) streamed to `@xterm/xterm`
- **Editor:** Monaco
- **File tree / diffs:** `@pierre/trees`, `@pierre/diffs`

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) (stable, 1.77.2+)
- Platform Tauri prerequisites — see the
  [Tauri v2 setup guide](https://v2.tauri.app/start/prerequisites/). On Windows
  this is the WebView2 runtime and the MSVC C++ build tools.

## Development

```bash
npm install
npm run tauri dev
```

## Production build

```bash
npm run tauri build
```

Artifacts are written to `src-tauri/target/release/`:

- Standalone executable: `meridian.exe`
- Installers: `bundle/msi/Meridian_<version>_x64_en-US.msi` and
  `bundle/nsis/Meridian_<version>_x64-setup.exe`

> Builds are unsigned by default, so Windows SmartScreen will warn on first
> launch. Configure code signing under `bundle.windows` in
> `src-tauri/tauri.conf.json` for distribution.

## Project structure

```
src/              React + TypeScript frontend
  components/     UI (tabs, panels, editor, terminal, status bar, ...)
  lib/            Tauri command wrappers, persistence, helpers
src-tauri/        Rust backend (Tauri commands, PTY, browser, Git)
```

Platform support is Windows- and macOS-primary; Linux is best-effort.
