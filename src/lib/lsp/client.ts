import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/browser";
import {
  CompletionRequest,
  CompletionResolveRequest,
  ConfigurationRequest,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  MarkupKind,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  SemanticTokensLegend,
  SemanticTokensRequest,
  ShutdownRequest,
  SignatureHelpRequest,
  UnregistrationRequest,
  WorkDoneProgressCreateRequest,
  type CompletionItem,
  type CompletionList,
  type Definition,
  type DefinitionLink,
  type Hover,
  type InitializeParams,
  type Position,
  type SemanticTokens,
  type SignatureHelp,
} from "vscode-languageserver-protocol/browser";

import { monaco } from "@/lib/monaco";
import { lspKill, lspSend, lspSpawn, onLspExit, onLspMessage } from "@/lib/tauri";
import { toMarkerData } from "@/lib/lsp/convert";
import { TauriMessageReader, TauriMessageWriter } from "@/lib/lsp/transport";

const MARKER_OWNER = "lsp";

/** LSP textDocument languageId for a file path. */
function lspLanguageId(path: string): string {
  if (path.endsWith(".tsx")) return "typescriptreact";
  if (path.endsWith(".jsx")) return "javascriptreact";
  if (path.endsWith(".mts") || path.endsWith(".cts") || path.endsWith(".ts"))
    return "typescript";
  return "javascript"; // .js .mjs .cjs
}

/** Display names for the languageIds the server may be serving. */
const FRIENDLY_LANGUAGE: Record<string, string> = {
  typescript: "TypeScript",
  typescriptreact: "TypeScript (TSX)",
  javascript: "JavaScript",
  javascriptreact: "JavaScript (JSX)",
};

/**
 * One language-server connection for a single project root. Owns the JSON-RPC
 * connection over the Tauri transport, document sync (full-text), request
 * wrappers used by the Monaco providers, and diagnostics → Monaco markers.
 */
export class LspClient {
  private connection: MessageConnection | undefined;
  private reader: TauriMessageReader | undefined;
  private unlistenMsg: (() => void) | undefined;
  private unlistenExit: (() => void) | undefined;
  private initialized = false;
  private disposed = false;
  // Opaque, event-safe id for the backend event names (the project path isn't
  // usable — Tauri event names forbid `\` and `.`).
  private readonly eventId = crypto.randomUUID();
  private readonly openDocs = new Map<
    string,
    {
      model: monaco.editor.ITextModel;
      /** LSP document version (monotonic). */
      lspVersion: number;
      /** Monaco model versionId at last sync, to detect unsent edits. */
      monacoVersion: number;
      /** Whether didOpen has actually been sent (deferred until initialized). */
      opened: boolean;
    }
  >();

  /** Resolves once `initialize` has completed (or rejects if startup fails). */
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: unknown) => void;

  semanticLegend: SemanticTokensLegend | undefined;

  /** True once local resources (listeners, connection) have been torn down. */
  private cleanedUp = false;

  constructor(
    readonly root: string,
    private readonly onExit: (root: string) => void,
    private readonly onLegend: (legend: SemanticTokensLegend) => void,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Callers attach their own handlers; this keeps a rejection on the teardown
    // path (no awaiter) from surfacing as an unhandled rejection.
    void this.ready.catch(() => {});
  }

  async start(): Promise<void> {
    this.reader = new TauriMessageReader();
    const writer = new TauriMessageWriter((m) => lspSend(this.root, m));
    this.connection = createMessageConnection(this.reader, writer);
    this.registerServerHandlers(this.connection);
    this.connection.onClose(() => this.handleExit());
    this.connection.listen();

    // Listen BEFORE spawning so the server's first messages aren't dropped.
    this.unlistenMsg = await onLspMessage(this.eventId, (raw) =>
      this.reader?.receive(raw),
    );
    this.unlistenExit = await onLspExit(this.eventId, () => this.handleExit());

    try {
      await lspSpawn(this.eventId, this.root);
      const result = await this.connection.sendRequest(
        InitializeRequest.type,
        this.initializeParams(),
      );
      const legend = result.capabilities.semanticTokensProvider
        ? "legend" in result.capabilities.semanticTokensProvider
          ? result.capabilities.semanticTokensProvider.legend
          : undefined
        : undefined;
      if (legend) {
        this.semanticLegend = legend;
        this.onLegend(legend);
      }
      this.connection.sendNotification(InitializedNotification.type, {});
      this.initialized = true;
      // Flush any documents opened before initialization completed, then signal
      // ready — so a provider awaiting `ready` sees didOpen before its request.
      for (const [uri, doc] of this.openDocs) {
        if (!doc.opened) this.sendOpen(uri, doc);
      }
      this.resolveReady();
    } catch (e) {
      this.rejectReady(e);
      throw e;
    }
  }

  private initializeParams(): InitializeParams {
    const rootUri = monaco.Uri.file(this.root).toString();
    const name = this.root.split(/[\\/]/).filter(Boolean).pop() ?? this.root;
    return {
      processId: null,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: [MarkupKind.Markdown, MarkupKind.PlainText],
              insertReplaceSupport: true,
              resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
            },
            contextSupport: true,
          },
          hover: { contentFormat: [MarkupKind.Markdown, MarkupKind.PlainText] },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: [MarkupKind.Markdown, MarkupKind.PlainText],
            },
          },
          definition: { linkSupport: true },
          semanticTokens: {
            requests: { full: true, range: false },
            formats: ["relative"],
            tokenTypes: [
              "namespace", "type", "class", "enum", "interface", "struct",
              "typeParameter", "parameter", "variable", "property",
              "enumMember", "event", "function", "method", "macro", "keyword",
              "modifier", "comment", "string", "number", "regexp", "operator",
              "decorator",
            ],
            tokenModifiers: [
              "declaration", "definition", "readonly", "static", "deprecated",
              "abstract", "async", "modification", "documentation",
              "defaultLibrary",
            ],
          },
        },
        workspace: { configuration: true, workspaceFolders: true },
      },
    };
  }

  // The server issues a handful of requests it expects answered; ignore the rest.
  private registerServerHandlers(conn: MessageConnection): void {
    conn.onNotification(PublishDiagnosticsNotification.type, (params) => {
      const model =
        this.openDocs.get(params.uri)?.model ??
        monaco.editor.getModel(monaco.Uri.parse(params.uri));
      if (model) {
        monaco.editor.setModelMarkers(
          model,
          MARKER_OWNER,
          params.diagnostics.map(toMarkerData),
        );
      }
    });
    conn.onRequest(ConfigurationRequest.type, (params) =>
      params.items.map(() => ({})),
    );
    conn.onRequest(RegistrationRequest.type, () => {});
    conn.onRequest(UnregistrationRequest.type, () => {});
    conn.onRequest(WorkDoneProgressCreateRequest.type, () => {});
  }

  /**
   * Idempotent local teardown: stop the Tauri listeners and dispose the JSON-RPC
   * connection (which rejects any in-flight requests rather than leaving them
   * hung), reject a not-yet-resolved `ready`, and clear per-document state.
   */
  private teardown(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.rejectReady(new Error(`Language server for ${this.root} stopped`));
    this.unlistenMsg?.();
    this.unlistenExit?.();
    this.unlistenMsg = undefined;
    this.unlistenExit = undefined;
    this.connection?.dispose();
    this.clearAllMarkers();
    this.openDocs.clear();
  }

  // The process exited or the connection closed on its own.
  private handleExit(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    // The process is already gone, but clear the backend's session map entry
    // promptly rather than waiting for the next status poll to prune it.
    void lspKill(this.root).catch(() => {});
    this.onExit(this.root);
  }

  // --- Document sync (full-text) ---

  /**
   * Ensure the server has this model open and synced to its current content.
   * Opens it on first call, then pushes a full-text change whenever the Monaco
   * model version advanced since the last sync. Called both on edits (so the
   * server recomputes diagnostics) and before each request (so completions/
   * hovers see the latest text).
   */
  sync(model: monaco.editor.ITextModel): void {
    const uri = model.uri.toString();
    let doc = this.openDocs.get(uri);
    if (!doc) {
      doc = {
        model,
        lspVersion: 1,
        monacoVersion: model.getVersionId(),
        opened: false,
      };
      this.openDocs.set(uri, doc);
      if (this.initialized) this.sendOpen(uri, doc);
      return;
    }
    if (!doc.opened) {
      // Open is still pending; it will carry the latest text when flushed.
      doc.monacoVersion = model.getVersionId();
      return;
    }
    const monacoVersion = model.getVersionId();
    if (monacoVersion === doc.monacoVersion) return;
    doc.monacoVersion = monacoVersion;
    doc.lspVersion++;
    this.connection?.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: doc.lspVersion },
      contentChanges: [{ text: model.getValue() }],
    });
  }

  private sendOpen(
    uri: string,
    doc: { model: monaco.editor.ITextModel; lspVersion: number; monacoVersion: number; opened: boolean },
  ): void {
    doc.opened = true;
    doc.lspVersion = 1;
    doc.monacoVersion = doc.model.getVersionId();
    this.connection?.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri,
        languageId: lspLanguageId(doc.model.uri.path),
        version: 1,
        text: doc.model.getValue(),
      },
    });
  }

  didClose(uri: string): void {
    const doc = this.openDocs.get(uri);
    if (!doc) return;
    this.openDocs.delete(uri);
    if (doc.opened) {
      this.connection?.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      });
    }
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  }

  // --- Requests (used by the Monaco providers) ---

  async completion(
    uri: string,
    position: Position,
    triggerCharacter?: string,
  ): Promise<CompletionList | CompletionItem[] | null> {
    await this.ready;
    return this.connection!.sendRequest(CompletionRequest.type, {
      textDocument: { uri },
      position,
      context: {
        triggerKind: triggerCharacter ? 2 : 1,
        triggerCharacter,
      },
    });
  }

  async resolveCompletion(item: CompletionItem): Promise<CompletionItem> {
    await this.ready;
    return this.connection!.sendRequest(CompletionResolveRequest.type, item);
  }

  async hover(uri: string, position: Position): Promise<Hover | null> {
    await this.ready;
    return this.connection!.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position,
    });
  }

  async signatureHelp(uri: string, position: Position): Promise<SignatureHelp | null> {
    await this.ready;
    return this.connection!.sendRequest(SignatureHelpRequest.type, {
      textDocument: { uri },
      position,
    });
  }

  async definition(
    uri: string,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    await this.ready;
    return this.connection!.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position,
    });
  }

  async semanticTokensFull(uri: string): Promise<SemanticTokens | null> {
    await this.ready;
    return this.connection!.sendRequest(SemanticTokensRequest.type, {
      textDocument: { uri },
    });
  }

  /** True once `initialize` has completed and the server is serving requests. */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Friendly names of the languages this server is actually serving right now,
   * derived from the documents currently open in it (not assumed from the
   * project's files). Empty when no files are open yet.
   */
  openLanguages(): string[] {
    const set = new Set<string>();
    for (const { model } of this.openDocs.values()) {
      const id = lspLanguageId(model.uri.path);
      set.add(FRIENDLY_LANGUAGE[id] ?? id);
    }
    return [...set].sort();
  }

  private clearAllMarkers(): void {
    for (const uri of this.openDocs.keys()) {
      const m = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (m) monaco.editor.setModelMarkers(m, MARKER_OWNER, []);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // Best-effort graceful shutdown, but never block teardown on it: a wedged
    // server can leave the request pending forever, so cap the wait and then
    // force-kill regardless.
    if (this.connection && this.initialized && !this.cleanedUp) {
      try {
        await Promise.race([
          this.connection.sendRequest(ShutdownRequest.type).catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
        this.connection.sendNotification(ExitNotification.type);
      } catch {
        /* server already gone or wedged */
      }
    }
    this.teardown();
    await lspKill(this.root).catch(() => {});
  }
}
