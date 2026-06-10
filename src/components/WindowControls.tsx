import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

// Crisp inline glyphs for window chrome (sharper than icon-font shapes at this size).
const MinimizeGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
    <line x1="0" y1="5.5" x2="10" y2="5.5" />
  </svg>
);

const MaximizeGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
    <rect x="0.5" y="0.5" width="9" height="9" />
  </svg>
);

const RestoreGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
    <rect x="0.5" y="2.5" width="7" height="7" />
    <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" />
  </svg>
);

const CloseGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1">
    <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" />
    <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" />
  </svg>
);

/** Custom min/max/close controls for the frameless window. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void appWindow.isMaximized().then(setMaximized);
    void appWindow
      .onResized(() => {
        void appWindow.isMaximized().then(setMaximized);
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  return (
    <div className="flex h-full shrink-0 items-stretch">
      <button
        onClick={() => void appWindow.minimize()}
        className="flex w-[46px] items-center justify-center text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
        aria-label="Minimize"
        title="Minimize"
      >
        <MinimizeGlyph />
      </button>
      <button
        onClick={() => void appWindow.toggleMaximize()}
        className="flex w-[46px] items-center justify-center text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        onClick={() => void appWindow.close()}
        className="flex w-[46px] items-center justify-center text-fg-subtle transition-colors hover:bg-[#e81123] hover:text-white"
        aria-label="Close"
        title="Close"
      >
        <CloseGlyph />
      </button>
    </div>
  );
}
