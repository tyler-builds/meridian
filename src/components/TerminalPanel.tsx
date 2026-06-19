import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";

import {
  onPtyExit,
  onPtyOutput,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  savePastedImage,
} from "@/lib/tauri";

const TERMINAL_THEME = {
  background: "#1c1c1c",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  cursorAccent: "#1c1c1c",
  // A clearly-visible selection: the old near-black #3a3a3a was almost
  // indistinguishable from the #1c1c1c background, so selections (and thus what
  // copy-on-select would grab) were invisible.
  selectionBackground: "#4b5563",
  black: "#1c1c1c",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#e5e5e5",
  brightBlack: "#6b6b6b",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
} as const;

/**
 * A live terminal backed by a Rust PTY rooted at `cwd`, running `shell`.
 * Recreated when `cwd` or `shell` changes.
 */
export function TerminalPanel({
  cwd,
  shell,
  initialCommand,
  onExit,
  onClaudeAttention,
}: {
  cwd: string;
  shell: string;
  /** A command run once after the shell starts (e.g. `claude`). */
  initialCommand?: string;
  /** Called when the shell process exits on its own (e.g. user typed `exit`). */
  onExit?: () => void;
  /**
   * Called when Claude Code (running in this terminal) finishes its turn and is
   * waiting on the user — detected by its title spinner stopping. Fires on that
   * transition, not continuously.
   */
  onClaudeAttention: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onClaudeAttentionRef = useRef(onClaudeAttention);
  onClaudeAttentionRef.current = onClaudeAttention;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    const ptyId = crypto.randomUUID();
    let spawned = false;
    let unlistenOutput: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    const isWindows = navigator.userAgent.includes("Windows");
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10_000,
      // When a fullscreen program (Claude Code) turns on mouse tracking, xterm
      // sends mouse drags to the program instead of selecting text. Holding a
      // modifier forces a local selection anyway: Shift+drag on Win/Linux (the
      // built-in default), and Option+drag on macOS once this is enabled.
      macOptionClickForcesSelection: true,
      theme: { ...TERMINAL_THEME },
      allowProposedApi: true,
      // Tell xterm the backend is ConPTY (portable-pty on Windows) so it doesn't
      // double-reflow on resize — that double reflow is what duplicated lines
      // when a pane was made very narrow.
      windowsPty: isWindows ? { backend: "conpty" } : undefined,
    });

    // Only resize the PTY when the grid actually changes, to avoid spamming
    // ConPTY with redundant resizes during a divider drag.
    let lastCols = 0;
    let lastRows = 0;
    const syncPtySize = () => {
      if (!spawned) return;
      if (term.cols === lastCols && term.rows === lastRows) return;
      lastCols = term.cols;
      lastRows = term.rows;
      void ptyResize(ptyId, term.cols, term.rows);
    };

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);

    // Image paste → running program (chiefly Claude Code). The browser only
    // hands xterm clipboard *text*, so an image-only clipboard is otherwise
    // silently dropped. Intercept the paste in the capture phase before xterm
    // sees it: for an image, save it to a temp file via Rust and feed the path
    // to the PTY wrapped in bracketed-paste markers (ESC[200~ … ESC[201~) — the
    // same way a drag-dropped/pasted path arrives — so Claude detects it and
    // renders its own "[Image #N]" placeholder instead of the raw path. Text
    // pastes fall through untouched to xterm's normal handling.
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      const image = items
        ? Array.from(items).find((it) => it.type.startsWith("image/"))
        : undefined;
      if (!image) return; // not an image — let xterm paste text as usual
      e.preventDefault();
      e.stopPropagation();
      const file = image.getAsFile();
      if (!file) return;
      void (async () => {
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
          const b64 = dataUrl.split(",", 2)[1] ?? "";
          const ext = dataUrl.match(/^data:image\/(\w+)/)?.[1] ?? "png";
          if (!b64 || disposed) return;
          const path = await savePastedImage(b64, ext);
          if (disposed) return;
          // Bracketed paste: the program treats it as a pasted path, not keystrokes.
          void ptyWrite(ptyId, `\x1b[200~${path}\x1b[201~`);
        } catch {
          /* clipboard read or save failed; nothing to paste */
        }
      })();
    };
    el.addEventListener("paste", handlePaste, true);

    // Copy the current terminal selection to the system clipboard. Returns
    // whether anything was copied. Used both by the copy keybinding below and by
    // copy-on-select (the mouse-up handler) — releasing a selection drag is what
    // delivers the "auto copy" behavior.
    const copySelection = (): boolean => {
      const sel = term.getSelection();
      if (!sel) return false;
      void navigator.clipboard.writeText(sel).catch(() => {
        /* clipboard unavailable */
      });
      return true;
    };

    // Auto copy: a finished selection (mouse released) goes straight to the
    // clipboard, so you never have to follow a drag with a copy command. A plain
    // click clears the selection, so getSelection() is empty and this no-ops.
    // Note: while Claude Code (or any program) has mouse tracking on, a *plain*
    // drag is consumed by that program — hold Shift (Option on macOS) to select.
    const handleMouseUp = () => {
      copySelection();
    };
    el.addEventListener("mouseup", handleMouseUp);

    // Keyboard copy/paste. Ctrl+Shift+C (Win/Linux) or Cmd+C (macOS) copies the
    // selection; plain Ctrl+C is left untouched so it still sends SIGINT to the
    // running program. Ctrl+V / Cmd+V fall through to the browser's native paste
    // instead of xterm turning Ctrl+V into a 0x16 control byte — the native paste
    // fires the `paste` handler above (images) and xterm's own text paste. Every
    // other key is left to xterm.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown") {
        const copyChord =
          ((e.ctrlKey && e.shiftKey) || (e.metaKey && !e.ctrlKey)) &&
          (e.key === "c" || e.key === "C");
        if (copyChord && copySelection()) {
          return false; // handled — don't pass the chord to the program
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) {
          return false; // skip xterm; browser performs the paste
        }
      }
      return true;
    });

    // Detect when Claude Code (running here) finishes a turn and is waiting on
    // the user. Claude reflects its state in the terminal title: an animated
    // braille spinner frame (U+2800-U+28FF) prefixes "Claude Code" while it's
    // working, and a static glyph when idle/awaiting input. We fire on the
    // transition from working to not-working (the spinner stopping), which is
    // exactly "Claude is done / now needs you". Titles without "Claude Code"
    // (the cmd.exe and launch titles) are ignored, so nothing else trips it.
    let claudeBusy = false;
    term.onTitleChange((title) => {
      if (!title.includes("Claude Code")) return;
      const busy = /[⠀-⣿]/.test(title); // braille spinner frame = working
      if (busy) {
        claudeBusy = true;
      } else if (claudeBusy) {
        claudeBusy = false;
        onClaudeAttentionRef.current();
      }
    });

    // GPU renderer: draws box-drawing/block characters programmatically so
    // panel borders (e.g. Claude Code's UI) connect cleanly instead of
    // rendering as broken dashes. Created lazily on the pane's first visible
    // layout — each instance holds one of the page's ~16 WebGL contexts, and
    // the app keeps every pane of every project mounted (hidden via CSS), so
    // eager creation exhausted contexts at session restore. Once created it is
    // kept while hidden: disposing/recreating on tab switches re-initializes
    // the renderer against a 0×0 container and leaves the terminal blank.
    let webgl: WebglAddon | undefined;
    let webglLosses = 0;
    const ensureWebgl = () => {
      if (disposed || webgl || webglLosses >= 2) return;
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          // Context lost (context-cap eviction or GPU-process reset): fall
          // back to the DOM renderer and retry on a later resize, but give up
          // after repeated losses (WebGL effectively unusable, e.g. over RDP).
          webglLosses += 1;
          addon.dispose();
          if (webgl === addon) webgl = undefined;
        });
        term.loadAddon(addon);
        webgl = addon;
      } catch {
        webglLosses = 2; // WebGL unavailable; keep the DOM renderer
      }
    };

    const safeFit = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          /* element not measurable yet */
        }
      }
    };
    safeFit();
    ensureWebgl();

    // xterm measures cell size at open(); if the terminal font loads afterward
    // the grid metrics are stale. Refit once JetBrains Mono (regular + bold) is
    // actually available.
    void Promise.all([
      document.fonts.load('400 13px "JetBrains Mono"'),
      document.fonts.load('700 13px "JetBrains Mono"'),
    ])
      .then(() => {
        if (disposed) return;
        safeFit();
        syncPtySize();
      })
      .catch(() => {
        /* font loading unsupported or failed; fall back to default metrics */
      });

    void (async () => {
      // Attach listeners BEFORE spawning so the shell's banner/prompt isn't lost.
      unlistenOutput = await onPtyOutput(ptyId, (data) => term.write(data));
      unlistenExit = await onPtyExit(ptyId, () => {
        if (disposed) return;
        // Shell exited on its own — close the pane (tmux/iTerm behavior).
        if (onExitRef.current) {
          onExitRef.current();
        } else {
          term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
        }
      });
      if (disposed) {
        unlistenOutput?.();
        unlistenExit?.();
        return;
      }
      // Wire keyboard → PTY BEFORE spawning. This is not just for typing:
      // ConPTY opens with an ESC[6n cursor-position query and prints nothing
      // until xterm's automatic reply — which xterm emits through onData. If
      // the query arrives before this handler exists, the reply is lost and
      // the shell waits forever (a permanently blank terminal). Writes to a
      // not-yet-spawned id are a no-op in the backend, so attaching early is
      // safe.
      term.onData((data) => void ptyWrite(ptyId, data));
      // A Claude tab launches `claude` as its initial command; start it in
      // fullscreen (alternate-screen) rendering by default. Scoped to this
      // pane's shell, so plain terminal tabs are unaffected.
      const isClaude =
        initialCommand === "claude" || initialCommand?.startsWith("claude ");
      const env = isClaude ? { CLAUDE_CODE_NO_FLICKER: "1" } : undefined;
      try {
        await ptySpawn(ptyId, cwd, term.cols, term.rows, shell, env);
        spawned = true;
        lastCols = term.cols;
        lastRows = term.rows;
      } catch (err) {
        term.write(`\r\n\x1b[31mFailed to start shell: ${err}\x1b[0m\r\n`);
        return;
      }
      if (disposed) {
        void ptyKill(ptyId);
        return;
      }
      // Run the tab's initial command (e.g. `claude`). The shell buffers stdin
      // until its prompt is ready, so sending it now is safe.
      if (initialCommand) {
        void ptyWrite(ptyId, `${initialCommand}\r`);
      }
    })();

    const resizeObserver = new ResizeObserver(() => {
      safeFit();
      syncPtySize();
      // Also fires when a hidden pane is first shown (0×0 → real size), which
      // is what creates the deferred WebGL renderer — after the fit above, so
      // it initializes against real dimensions.
      ensureWebgl();
    });
    resizeObserver.observe(el);

    return () => {
      disposed = true;
      el.removeEventListener("paste", handlePaste, true);
      el.removeEventListener("mouseup", handleMouseUp);
      resizeObserver.disconnect();
      unlistenOutput?.();
      unlistenExit?.();
      if (spawned) void ptyKill(ptyId);
      webgl?.dispose();
      webgl = undefined;
      term.dispose();
    };
  }, [cwd, shell, initialCommand]);

  return <div ref={containerRef} className="h-full w-full" />;
}
