import { CircleAlert, Info, CheckCircle2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import {
  dismissToast,
  subscribeToasts,
  type Toast,
  type ToastKind,
} from "@/lib/toast";

const ICON: Record<ToastKind, typeof Info> = {
  error: CircleAlert,
  info: Info,
  success: CheckCircle2,
};

const ACCENT: Record<ToastKind, string> = {
  error: "text-red-400",
  info: "text-accent",
  success: "text-emerald-400",
};

/**
 * Bottom-right stack of transient notifications, fed by the `toast` store.
 * Mounted once at the app root; sits above every dialog/popup (z-[100]).
 */
export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setItems), []);

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {items.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <div
            key={t.id}
            role="alert"
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-bg-elevated p-3 shadow-2xl"
          >
            <Icon
              size={16}
              strokeWidth={2}
              className={cn("mt-px shrink-0", ACCENT[t.kind])}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13px] font-medium text-fg">{t.title}</span>
              {t.message && (
                <span className="break-words text-xs text-fg-subtle">
                  {t.message}
                </span>
              )}
            </div>
            <button
              onClick={() => dismissToast(t.id)}
              className="-mr-1 -mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint transition hover:bg-bg-active hover:text-fg"
              aria-label="Dismiss"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
