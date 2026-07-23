/**
 * Minimal in-app toast store. A module-level singleton (subscribe/emit) so any
 * module can raise a toast without threading a context through the tree — the
 * `<Toaster />` mounted at the app root renders whatever is pushed here.
 */

export type ToastKind = "error" | "info" | "success";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  /** Optional secondary line (e.g. an error detail). */
  message?: string;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function emit(): void {
  for (const l of listeners) l(toasts);
}

/** Subscribe to the toast list; the listener fires immediately with current state. */
export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Raise a toast. Auto-dismisses after `ttlMs` (0 keeps it until dismissed).
 * Errors default to a longer, sticky-ish lifetime since they warrant a read.
 */
export function pushToast(
  kind: ToastKind,
  title: string,
  message?: string,
  ttlMs = kind === "error" ? 8000 : 4000,
): number {
  const id = nextId++;
  toasts = [...toasts, { id, kind, title, message }];
  emit();
  if (ttlMs > 0) {
    setTimeout(() => dismissToast(id), ttlMs);
  }
  return id;
}

export function dismissToast(id: number): void {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}
