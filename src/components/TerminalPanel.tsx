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

    // GPU renderer with customGlyphs: draws box-drawing/block characters
    // programmatically so panel borders (e.g. Claude Code's UI) connect
    // cleanly instead of rendering as broken dashes. Falls back to the DOM
    // renderer automatically if WebGL is unavailable or the context is lost.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* WebGL unavailable; DOM renderer remains */
    }

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
      term.onData((data) => void ptyWrite(ptyId, data));
      // Run the tab's initial command (e.g. `claude`). The shell buffers stdin
      // until its prompt is ready, so sending it now is safe.
      if (initialCommand) {
        void ptyWrite(ptyId, `${initialCommand}\r`);
      }
    })();

    const resizeObserver = new ResizeObserver(() => {
      safeFit();
      syncPtySize();
    });
    resizeObserver.observe(el);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      unlistenOutput?.();
      unlistenExit?.();
      if (spawned) void ptyKill(ptyId);
      term.dispose();
    };
  }, [cwd, shell, initialCommand]);

  return <div ref={containerRef} className="h-full w-full" />;
}
