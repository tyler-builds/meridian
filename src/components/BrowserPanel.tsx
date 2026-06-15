import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";

import {
  browserBack,
  browserClose,
  browserCreate,
  browserForward,
  browserGetUrl,
  browserNavigate,
  browserReload,
  browserSetBounds,
  browserShow,
  browserHide,
  onBrowserNavState,
  onBrowserNewTab,
  onBrowserTitle,
  type BrowserNavState,
} from "@/lib/tauri";
import { useNativeSurfaceBounds } from "@/lib/useNativeSurfaceBounds";
import { setObstruction, useSurfaceClear } from "@/lib/nativeSurface";
import { recordUrl, suggestUrls } from "@/lib/browserHistory";
import { cn } from "@/lib/utils";

/** Turn user-typed text into a navigable URL (default scheme https). */
function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith("about:")) {
    return text;
  }
  return `https://${text}`;
}

/**
 * A browser tab: a DOM toolbar (back/forward/reload/address) above a native
 * child webview. The webview is an OS surface positioned over the placeholder
 * `div`; it does not live in the DOM, so it is shown only while this is the
 * active, unobstructed surface and is repositioned whenever the placeholder
 * moves or resizes.
 */
export function BrowserPanel({
  id,
  initialUrl,
  active,
  onUrlChange,
  onTitleChange,
  onOpenUrl,
}: {
  id: string;
  initialUrl: string;
  /** This browser is the active tab of the active project. */
  active: boolean;
  onUrlChange: (url: string) => void;
  onTitleChange: (title: string) => void;
  /** The page requested a new tab (window.open / target=_blank). */
  onOpenUrl: (url: string) => void;
}) {
  const placeholderRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [created, setCreated] = useState(false);
  const [nav, setNav] = useState<BrowserNavState>({
    url: initialUrl === "about:blank" ? "" : initialUrl,
    canBack: false,
    canForward: false,
  });
  const [address, setAddress] = useState(
    initialUrl === "about:blank" ? "" : initialUrl,
  );
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  const surfaceClear = useSurfaceClear();
  const visible = active && surfaceClear;

  // Refs so async callbacks read live values without re-subscribing.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const focusedRef = useRef(false);
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onOpenUrlRef = useRef(onOpenUrl);
  onOpenUrlRef.current = onOpenUrl;
  // Last URL we reflected, so on_navigation events and the reconcile poll don't
  // redundantly re-report the same URL.
  const lastUrlRef = useRef(initialUrl);

  // Create the native webview once, mirroring TerminalPanel's listen-first
  // lifecycle so the first navigation/title events aren't dropped.
  useEffect(() => {
    const el = placeholderRef.current;
    if (!el) return;

    let disposed = false;
    let waitRo: ResizeObserver | undefined;
    let unlistenNav: (() => void) | undefined;
    let unlistenTitle: (() => void) | undefined;
    let unlistenNewTab: (() => void) | undefined;

    void (async () => {
      unlistenNav = await onBrowserNavState(id, (state) => {
        if (disposed) return;
        lastUrlRef.current = state.url;
        setNav(state);
        // Don't clobber what the user is typing in the address bar.
        if (!focusedRef.current) {
          setAddress(state.url === "about:blank" ? "" : state.url);
        }
        recordUrl(state.url);
        onUrlChangeRef.current(state.url);
      });
      unlistenTitle = await onBrowserTitle(id, (title) => {
        if (!disposed) onTitleChangeRef.current(title);
      });
      unlistenNewTab = await onBrowserNewTab(id, (url) => {
        if (!disposed) onOpenUrlRef.current(url);
      });
      if (disposed) {
        unlistenNav?.();
        unlistenTitle?.();
        unlistenNewTab?.();
        return;
      }
      // A hidden placeholder (inactive main tab or background project, both
      // kept mounted with display:none) measures 0×0, and WebView2 rejects
      // zero-size bounds (E_INVALIDARG "The parameter is incorrect"), so wait
      // for the first real layout before creating the webview.
      const r = await new Promise<DOMRect>((resolve) => {
        const initial = el.getBoundingClientRect();
        if (initial.width > 0 && initial.height > 0) {
          resolve(initial);
          return;
        }
        waitRo = new ResizeObserver(() => {
          const next = el.getBoundingClientRect();
          if (next.width > 0 && next.height > 0) {
            waitRo?.disconnect();
            resolve(next);
          }
        });
        waitRo.observe(el);
      });
      if (disposed) return;
      try {
        await browserCreate(id, initialUrl, r.left, r.top, r.width, r.height);
        if (disposed) {
          void browserClose(id);
          return;
        }
        setCreated(true);
        // Created shown by default — hide immediately if we're not the active
        // surface (e.g. restored into a background project tab).
        if (!visibleRef.current) void browserHide(id);
      } catch {
        /* webview creation failed; toolbar still renders */
      }
    })();

    return () => {
      disposed = true;
      waitRo?.disconnect();
      unlistenNav?.();
      unlistenTitle?.();
      unlistenNewTab?.();
      void browserClose(id);
    };
    // Create exactly once per tab id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Keep the webview aligned with the placeholder.
  const syncBounds = useCallback(
    (rect: { left: number; top: number; width: number; height: number }) => {
      if (created) {
        void browserSetBounds(id, rect.left, rect.top, rect.width, rect.height);
      }
    },
    [id, created],
  );
  useNativeSurfaceBounds(placeholderRef, syncBounds, [created]);

  // Show/hide the native surface as visibility changes, re-asserting bounds
  // right before showing (show() can reset position on some platforms).
  useEffect(() => {
    if (!created) return;
    if (visible) {
      const el = placeholderRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          void browserSetBounds(id, r.left, r.top, r.width, r.height);
        }
      }
      void browserShow(id);
    } else {
      void browserHide(id);
    }
  }, [visible, created, id]);

  // on_navigation misses in-page navigations (SPA pushState/replaceState, hash
  // changes), so the address bar can drift after a site auto-navigates. Poll
  // the webview's real URL while this tab is active and reconcile.
  useEffect(() => {
    if (!created || !active) return;
    let polling = true;
    const tick = () => {
      browserGetUrl(id)
        .then((url) => {
          if (!polling || !url || url === lastUrlRef.current) return;
          lastUrlRef.current = url;
          setNav((prev) => ({ ...prev, url }));
          if (!focusedRef.current) {
            setAddress(url === "about:blank" ? "" : url);
          }
          recordUrl(url);
          onUrlChangeRef.current(url);
        })
        .catch(() => {});
    };
    const interval = setInterval(tick, 1000);
    return () => {
      polling = false;
      clearInterval(interval);
    };
  }, [created, active, id]);

  // Fresh blank tabs focus the address bar, ready to type.
  useEffect(() => {
    if (initialUrl === "about:blank") inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The suggestions popup drops into the native-webview region; flag it as an
  // obstruction so the webview hides and the popup stays visible.
  useEffect(() => {
    setObstruction(`browser-suggest-${id}`, showSuggest);
    return () => setObstruction(`browser-suggest-${id}`, false);
  }, [showSuggest, id]);

  const refreshSuggestions = useCallback((value: string) => {
    const list = value.trim() ? suggestUrls(value) : [];
    setSuggestions(list);
    setShowSuggest(list.length > 0);
    setHighlight(-1);
  }, []);

  const closeSuggestions = useCallback(() => {
    setShowSuggest(false);
    setHighlight(-1);
  }, []);

  const navigateTo = useCallback(
    (url: string) => {
      void browserNavigate(id, url);
      closeSuggestions();
      inputRef.current?.blur();
    },
    [id, closeSuggestions],
  );

  const submit = useCallback(() => {
    if (highlight >= 0 && highlight < suggestions.length) {
      const url = suggestions[highlight];
      setAddress(url);
      navigateTo(url);
      return;
    }
    const url = normalizeUrl(address);
    if (url) navigateTo(url);
  }, [address, highlight, suggestions, navigateTo]);

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2">
        <button
          onClick={() => void browserBack(id)}
          disabled={!nav.canBack}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg disabled:cursor-default disabled:text-fg-faint/40 disabled:hover:bg-transparent"
          aria-label="Back"
          title="Back"
        >
          <ArrowLeft size={16} strokeWidth={1.8} />
        </button>
        <button
          onClick={() => void browserForward(id)}
          disabled={!nav.canForward}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg disabled:cursor-default disabled:text-fg-faint/40 disabled:hover:bg-transparent"
          aria-label="Forward"
          title="Forward"
        >
          <ArrowRight size={16} strokeWidth={1.8} />
        </button>
        <button
          onClick={() => void browserReload(id)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
          aria-label="Reload"
          title="Reload"
        >
          <RotateCw size={15} strokeWidth={1.8} />
        </button>
        <div className="relative min-w-0 flex-1">
          <input
            ref={inputRef}
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              refreshSuggestions(e.target.value);
            }}
            onFocus={(e) => {
              focusedRef.current = true;
              e.target.select();
              refreshSuggestions(e.target.value);
            }}
            onBlur={() => {
              focusedRef.current = false;
              // Restore the real URL if the user edited but didn't navigate.
              setAddress(nav.url === "about:blank" ? "" : nav.url);
              closeSuggestions();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                if (showSuggest) closeSuggestions();
                else e.currentTarget.blur();
              } else if (e.key === "ArrowDown" && suggestions.length > 0) {
                e.preventDefault();
                setShowSuggest(true);
                setHighlight((h) => (h + 1) % suggestions.length);
              } else if (e.key === "ArrowUp" && suggestions.length > 0) {
                e.preventDefault();
                setHighlight((h) =>
                  h <= 0 ? suggestions.length - 1 : h - 1,
                );
              }
            }}
            placeholder="Enter a URL"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={cn(
              "h-7 w-full rounded-md bg-bg-elevated px-3 text-[13px] text-fg",
              "placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent",
            )}
          />
          {showSuggest && suggestions.length > 0 && (
            <ul className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-border bg-bg-elevated py-1 shadow-lg">
              {suggestions.map((url, i) => (
                <li key={url}>
                  <button
                    // Prevent the input's blur from firing before the click.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setAddress(url);
                      navigateTo(url);
                    }}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn(
                      "flex w-full items-center px-3 py-1.5 text-left text-[13px] text-fg-subtle",
                      i === highlight ? "bg-bg-active text-fg" : "hover:bg-bg-hover",
                    )}
                  >
                    <span className="truncate">{url}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Anchor for the native webview surface. */}
      <div ref={placeholderRef} className="min-h-0 flex-1 bg-bg" />
    </div>
  );
}
