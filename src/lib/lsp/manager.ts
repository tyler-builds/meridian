import type { SemanticTokensLegend } from "vscode-languageserver-protocol/browser";

import { monaco } from "@/lib/monaco";
import { getModelFile } from "@/lib/format";
import { frontendLog } from "@/lib/tauri";
import { LspClient } from "@/lib/lsp/client";

/** What the status bar popup shows for one running server. */
export interface ServerInfo {
  root: string;
  /** Friendly language names the server is currently serving. */
  languages: string[];
  /** False while the server is still starting up (initializing). */
  ready: boolean;
}

/**
 * Owns the set of language-server clients (one per project root) and the global
 * coordination that can't live on an individual client: enabling/disabling the
 * feature as a whole, and suppressing Monaco's built-in TypeScript worker
 * features while ≥1 LSP client is live (so completions/diagnostics don't double
 * up). The built-in toggle is global to Monaco, so in a mixed session where one
 * project has an LSP and another has none, the no-LSP project loses built-in
 * single-file completion — an accepted v1 tradeoff.
 */

const TS_FEATURES_ON: monaco.languages.typescript.ModeConfiguration = {
  completionItems: true,
  hovers: true,
  documentSymbols: true,
  definitions: true,
  references: true,
  documentHighlights: true,
  rename: true,
  diagnostics: true,
  documentRangeFormattingEdits: true,
  signatureHelp: true,
  onTypeFormattingEdits: true,
  codeActions: true,
  inlayHints: true,
};
const TS_FEATURES_OFF: monaco.languages.typescript.ModeConfiguration = {
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: false,
  signatureHelp: false,
  onTypeFormattingEdits: false,
  codeActions: false,
  inlayHints: false,
};

class LspManager {
  private readonly clients = new Map<string, LspClient>();
  /** Roots whose server failed to start — skipped until session restart. */
  private readonly failed = new Set<string>();
  private enabled = true;
  private builtinsDisabled = false;
  private legendHandler: ((legend: SemanticTokensLegend) => void) | undefined;

  /** Set by the Monaco bridge so the manager can register the semantic-tokens
   *  provider once the first server reports its legend. */
  setLegendHandler(fn: (legend: SemanticTokensLegend) => void): void {
    this.legendHandler = fn;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      for (const client of this.clients.values()) void client.dispose();
      this.clients.clear();
      this.failed.clear();
      this.updateBuiltins();
    }
  }

  getClient(root: string): LspClient | undefined {
    return this.clients.get(root);
  }

  /** Detail for every client this manager is tracking (for the status popup). */
  listServers(): ServerInfo[] {
    return [...this.clients.entries()].map(([root, client]) => ({
      root,
      languages: client.openLanguages(),
      ready: client.isReady(),
    }));
  }

  /**
   * Stop a project's server and start a fresh one, re-opening the documents that
   * were open in it. Awaits the old client's teardown first so the backend's
   * spawn (which is idempotent per root) doesn't see the dying session and skip
   * starting the replacement.
   */
  async restartClient(root: string): Promise<void> {
    if (!this.enabled) return;
    const existing = this.clients.get(root);
    this.clients.delete(root);
    this.failed.delete(root);
    if (existing) {
      try {
        await existing.dispose();
      } catch {
        /* already gone */
      }
    }
    this.ensureClient(root);
    const client = this.clients.get(root);
    if (!client) return;
    // Re-open the TS/JS models that belong to this project.
    for (const model of monaco.editor.getModels()) {
      const lang = model.getLanguageId();
      if (
        getModelFile(model.uri.toString())?.root === root &&
        (lang === "typescript" || lang === "javascript")
      ) {
        client.sync(model);
      }
    }
  }

  /** Lazily start a client for a project root (idempotent, fire-and-forget). */
  ensureClient(root: string): void {
    if (!this.enabled || this.failed.has(root) || this.clients.has(root)) return;
    const client = new LspClient(
      root,
      (r) => this.handleExit(r),
      (legend) => this.legendHandler?.(legend),
    );
    this.clients.set(root, client);
    this.updateBuiltins();
    client.start().catch((e) => {
      console.warn(`Language server failed to start for ${root}:`, e);
      void frontendLog("warn", `LSP start failed for ${root}: ${String(e)}`);
      this.clients.delete(root);
      this.failed.add(root);
      void client.dispose();
      this.updateBuiltins();
    });
  }

  /** Stop a project's server. Resolves once it has been fully torn down. */
  disposeClient(root: string): Promise<void> {
    const client = this.clients.get(root);
    if (!client) return Promise.resolve();
    this.clients.delete(root);
    this.updateBuiltins();
    return client.dispose();
  }

  private handleExit(root: string): void {
    if (this.clients.delete(root)) this.updateBuiltins();
  }

  private updateBuiltins(): void {
    const shouldDisable = this.clients.size > 0;
    if (shouldDisable === this.builtinsDisabled) return;
    this.builtinsDisabled = shouldDisable;
    const cfg = shouldDisable ? TS_FEATURES_OFF : TS_FEATURES_ON;
    monaco.languages.typescript.typescriptDefaults.setModeConfiguration(cfg);
    monaco.languages.typescript.javascriptDefaults.setModeConfiguration(cfg);
  }
}

export const lspManager = new LspManager();
