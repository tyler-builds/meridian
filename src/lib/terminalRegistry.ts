/**
 * A tiny registry mapping a terminal pane id to a function that writes to that
 * pane's live PTY.
 *
 * Why this exists: each `TerminalPanel` mints its own PTY id internally
 * (`crypto.randomUUID()`), so nothing outside the component can address a
 * running terminal. The element-picker feature needs to push captured page
 * context into the project's Claude terminal, so each `TerminalPanel` registers
 * a writer here keyed by its (stable) pane id, and callers route to it by pane
 * id without ever learning the PTY id.
 */

type Injector = (data: string) => void;

const injectors = new Map<string, Injector>();

/** Register a pane's PTY writer. Re-registering replaces the prior one. */
export function registerTerminal(paneId: string, inject: Injector): void {
  injectors.set(paneId, inject);
}

/** Remove a pane's writer, but only if `inject` is still the registered one
 * (guards against a remount's cleanup clobbering the new registration). */
export function unregisterTerminal(paneId: string, inject: Injector): void {
  if (injectors.get(paneId) === inject) injectors.delete(paneId);
}

/** Write `data` to a pane's PTY. Returns false if no live terminal is registered. */
export function injectIntoTerminal(paneId: string, data: string): boolean {
  const inject = injectors.get(paneId);
  if (!inject) return false;
  inject(data);
  return true;
}

/** Wrap text in bracketed-paste markers so a TUI (Claude Code) ingests it as a
 * single paste — multi-line content lands in the prompt without submitting on
 * each newline. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}
