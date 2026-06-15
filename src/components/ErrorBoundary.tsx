import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** Identifies the boundary's region; included in the log line. */
  label?: string;
  /**
   * Custom fallback. Receives the caught error and a `reset` that clears the
   * error state so the subtree re-renders. Defaults to the built-in panel.
   */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors in its subtree and shows a recoverable panel
 * instead of letting the exception unmount the whole React root — an unhandled
 * render error otherwise tears down the entire UI and presents as a blank
 * window (looking like lost data even though the session file is untouched).
 *
 * Errors are forwarded to the Rust log (matching the global handlers in
 * main.tsx) so they survive the webview. Use one per independently-recoverable
 * region — e.g. each project's content area — so a crash in one doesn't take
 * down the rest of the app. Reset/remount it by giving it a `key` that changes
 * with the region's identity.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const where = this.props.label ? ` [${this.props.label}]` : "";
    void invoke("frontend_log", {
      level: "error",
      message:
        `render error${where}: ${error.message}\n${error.stack ?? ""}\n${
          info.componentStack ?? ""
        }`.slice(0, 2000),
    }).catch(() => {});
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return <ErrorFallback error={error} onReset={this.reset} />;
  }
}

/** Default recoverable error panel, styled to match the app surfaces. */
function ErrorFallback({
  error,
  onReset,
}: {
  error: Error;
  onReset: () => void;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-bg p-6 text-fg">
      <div className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-border bg-bg-elevated p-6 shadow-2xl">
        <div className="flex items-center gap-2">
          <TriangleAlert
            size={18}
            strokeWidth={1.8}
            className="shrink-0 text-amber-500"
          />
          <h2 className="text-sm font-medium text-fg">Something went wrong</h2>
        </div>
        <p className="text-[13px] leading-relaxed text-fg-subtle">
          A component failed to render. Your open projects and session are safe.
          Try again to re-render this view, or reload the app.
        </p>
        <pre className="max-h-32 w-full overflow-auto rounded-md border border-border-subtle bg-bg p-2 text-[11px] leading-relaxed text-fg-faint">
          {error.message || String(error)}
        </pre>
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => window.location.reload()}
          >
            Reload app
          </Button>
          <Button size="sm" onClick={onReset}>
            <RotateCcw size={14} strokeWidth={2} />
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
