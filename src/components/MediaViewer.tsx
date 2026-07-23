import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { readFileBytes } from "@/lib/tauri";
import { type MediaKind } from "@/lib/media";
import { cn } from "@/lib/utils";

const MIN_SCALE = 0.05;
const MAX_SCALE = 64;

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

interface View {
  /** Absolute scale: 1 = the image's real pixels (100%). */
  scale: number;
  /** Pan translation in px, relative to a centered image. */
  offset: { x: number; y: number };
}

/**
 * Renders an image or video file directly instead of its bytes-as-text. Images
 * get zoom/pan/fit controls (toolbar buttons, cursor-anchored wheel zoom, drag
 * to pan, double-click to toggle fit/100%); videos use the native player
 * controls. The file is loaded once as a Blob URL, revoked on unmount.
 */
export function MediaViewer({
  root,
  relPath,
  kind,
  mime,
}: {
  root: string;
  relPath: string;
  kind: MediaKind;
  mime: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    readFileBytes(root, relPath)
      .then((buf) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(new Blob([buf], { type: mime }));
        setUrl(objectUrl);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [root, relPath, mime]);

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg p-6 text-center text-[13px] text-fg-subtle">
        Could not open this file: {error}
      </div>
    );
  }

  if (!url) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg text-[13px] text-fg-faint">
        Loading…
      </div>
    );
  }

  return kind === "image" ? (
    <ImageView url={url} />
  ) : (
    <VideoView url={url} />
  );
}

function ImageView({ url }: { url: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, offset: { x: 0, y: 0 } });
  const dragging = useRef(false);
  const [grabbing, setGrabbing] = useState(false);

  // Scale that fits the whole image within the viewport (contain).
  const computeFit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || !natural) return 1;
    return Math.min(vp.clientWidth / natural.w, vp.clientHeight / natural.h);
  }, [natural]);

  const fit = useCallback(() => {
    setView({ scale: computeFit(), offset: { x: 0, y: 0 } });
  }, [computeFit]);

  const actual = useCallback(() => {
    setView({ scale: 1, offset: { x: 0, y: 0 } });
  }, []);

  // On first load, show the image fully: fit if it overflows, else 100%.
  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const w = e.currentTarget.naturalWidth;
    const h = e.currentTarget.naturalHeight;
    setNatural({ w, h });
    const vp = viewportRef.current;
    const fitScale = vp ? Math.min(vp.clientWidth / w, vp.clientHeight / h) : 1;
    setView({ scale: Math.min(fitScale, 1), offset: { x: 0, y: 0 } });
  };

  // Zoom about the viewport center (offset scales with it so the centered point
  // stays put).
  const zoomBy = (factor: number) =>
    setView((v) => {
      const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      const r = scale / v.scale;
      return { scale, offset: { x: v.offset.x * r, y: v.offset.y * r } };
    });

  // Cursor-anchored wheel zoom: keep the image point under the cursor fixed.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      setView((v) => {
        const scale = clamp(v.scale * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
        const r = scale / v.scale;
        return {
          scale,
          offset: { x: dx - (dx - v.offset.x) * r, y: dy - (dy - v.offset.y) * r },
        };
      });
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, []);

  const percent = Math.round(view.scale * 100);

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
        <ToolbarButton title="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
          <ZoomOut size={15} strokeWidth={1.8} />
        </ToolbarButton>
        <button
          onClick={actual}
          title="Actual size (100%)"
          className="min-w-[52px] rounded px-1.5 py-1 text-center text-xs tabular-nums text-fg-subtle transition hover:bg-bg-hover hover:text-fg"
        >
          {percent}%
        </button>
        <ToolbarButton title="Zoom in" onClick={() => zoomBy(1.25)}>
          <ZoomIn size={15} strokeWidth={1.8} />
        </ToolbarButton>
        <div className="mx-1 h-4 w-px bg-border" />
        <ToolbarButton title="Fit to window" onClick={fit}>
          <Maximize2 size={14} strokeWidth={1.8} />
        </ToolbarButton>
        <button
          onClick={actual}
          title="Actual size"
          className="rounded px-1.5 py-1 text-xs text-fg-subtle transition hover:bg-bg-hover hover:text-fg"
        >
          1:1
        </button>
        {natural && (
          <span className="ml-auto pr-1 text-xs tabular-nums text-fg-faint">
            {natural.w} × {natural.h}
          </span>
        )}
      </div>

      <div
        ref={viewportRef}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden",
          grabbing ? "cursor-grabbing" : "cursor-grab",
        )}
        onDoubleClick={() => (percent === 100 ? fit() : actual())}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragging.current = true;
          setGrabbing(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          setView((v) => ({
            scale: v.scale,
            offset: { x: v.offset.x + e.movementX, y: v.offset.y + e.movementY },
          }));
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          setGrabbing(false);
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      >
        {/* Centered wrapper; the image is transformed within it. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <img
            src={url}
            alt=""
            draggable={false}
            onLoad={onImgLoad}
            style={{
              transform: `translate(${view.offset.x}px, ${view.offset.y}px) scale(${view.scale})`,
              // Scale from real pixels so `scale` maps to true zoom %.
              width: natural ? natural.w : undefined,
              height: natural ? natural.h : undefined,
              maxWidth: "none",
              imageRendering: view.scale >= 3 ? "pixelated" : "auto",
            }}
          />
        </div>
      </div>
    </div>
  );
}

function VideoView({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex h-full w-full items-center justify-center bg-black p-2">
      {failed ? (
        <div className="max-w-md text-center text-[13px] text-fg-subtle">
          This video can't be played by the built-in player — its format or
          codec may be unsupported.
        </div>
      ) : (
        <video
          src={url}
          controls
          className="max-h-full max-w-full"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

function ToolbarButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-7 w-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-bg-hover hover:text-fg"
    >
      {children}
    </button>
  );
}
