import { useEffect, useRef, type RefObject } from "react";

export interface SurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Keeps a native surface (an embedded browser webview) aligned with a DOM
 * placeholder element. The native webview lives outside the DOM, so we measure
 * the placeholder's screen rect and report it whenever it changes.
 *
 * A `ResizeObserver` covers size changes, and a `resize` listener covers window
 * changes — but pure *position* shifts (e.g. dragging the sidebar divider,
 * which moves the content area without resizing the placeholder) don't trigger
 * either, so we run a `requestAnimationFrame` loop while the mouse is held
 * down. Reports are coalesced with a sub-pixel epsilon to avoid spamming the
 * backend (the terminal pane uses the same guard for PTY resizes).
 */
export function useNativeSurfaceBounds(
  ref: RefObject<HTMLElement | null>,
  onBounds: (rect: SurfaceRect) => void,
  deps: unknown[] = [],
): void {
  const cbRef = useRef(onBounds);
  cbRef.current = onBounds;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let last: SurfaceRect = { left: 0, top: 0, width: 0, height: 0 };
    const measure = () => {
      const r = el.getBoundingClientRect();
      // A hidden (display:none) placeholder measures 0×0 — skip it; the panel
      // hides the webview separately when it's not the active surface.
      if (r.width === 0 || r.height === 0) return;
      if (
        Math.abs(r.left - last.left) < 0.5 &&
        Math.abs(r.top - last.top) < 0.5 &&
        Math.abs(r.width - last.width) < 0.5 &&
        Math.abs(r.height - last.height) < 0.5
      ) {
        return;
      }
      last = { left: r.left, top: r.top, width: r.width, height: r.height };
      cbRef.current(last);
    };

    measure();

    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    window.addEventListener("resize", measure);

    let raf = 0;
    let dragging = false;
    const loop = () => {
      if (!dragging) return;
      measure();
      raf = requestAnimationFrame(loop);
    };
    const onDown = () => {
      dragging = true;
      raf = requestAnimationFrame(loop);
    };
    const onUp = () => {
      dragging = false;
      cancelAnimationFrame(raf);
      measure();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("mouseup", onUp, true);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mouseup", onUp, true);
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
