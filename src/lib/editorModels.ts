import { lspManager } from "@/lib/lsp/manager";

/**
 * Ref-counts the per-project language-server client across the (now multiple)
 * file editors of a project. Each split can hold its own `FileEditor`, so the
 * client must survive until the *last* editor for a root unmounts — the old
 * single-editor design could dispose it on any editor closing.
 */

const rootCounts = new Map<string, number>();

/** Note that a file editor for `root` needs the LSP client. */
export function acquireLspClient(root: string): void {
  rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
  lspManager.ensureClient(root);
}

/** Release a file editor's hold; disposes the client when none remain. */
export function releaseLspClient(root: string): void {
  const next = (rootCounts.get(root) ?? 1) - 1;
  if (next <= 0) {
    rootCounts.delete(root);
    lspManager.disposeClient(root);
  } else {
    rootCounts.set(root, next);
  }
}
