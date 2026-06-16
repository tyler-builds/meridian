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
  selectionBackground: "#3a3a3a",
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
}: {
  cwd: string;
  shell: string;
  /** A command run once after the shell starts (e.g. `claude`). */
  initialCommand?: string;
  /** Called when the shell process exits on its own (e.g. user typed `exit`). */
  onExit?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

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

    // Let Ctrl+V / Ctrl+Shift+V (and Cmd+V) fall through to the browser's native
    // paste instead of xterm turning Ctrl+V into a 0x16 control byte. The native
    // paste fires the `paste` handler above (images) and xterm's own text paste —
    // the same path right-click → Paste already used, which is why that worked
    // while the shortcuts didn't. Every other key is left to xterm.
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        (e.ctrlKey || e.metaKey) &&
        (e.key === "v" || e.key === "V")
      ) {
        return false; // skip xterm; browser performs the paste
      }
      return true;
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
      try {
        await ptySpawn(ptyId, cwd, term.cols, term.rows, shell);
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
