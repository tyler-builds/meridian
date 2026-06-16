import type {
  CompletionItem as LspCompletionItem,
  Definition,
  DefinitionLink,
  MarkupContent,
  SemanticTokensLegend,
  SignatureHelp as LspSignatureHelp,
} from "vscode-languageserver-protocol/browser";

import { monaco } from "@/lib/monaco";
import { getModelFile } from "@/lib/format";
import { lspManager } from "@/lib/lsp/manager";
import {
  markupToMarkdown,
  toLspPosition,
  toMonacoCompletionItem,
  toMonacoRange,
} from "@/lib/lsp/convert";

/**
 * Registers Monaco language-feature providers that delegate to the per-project
 * LSP client (resolved from the model's project via the format model→file
 * registry). Providers no-op for models with no client — so the diff editor and
 * untracked buffers are unaffected.
 */

const LANGS = ["typescript", "javascript"];

// Stash the originating LSP item + root on the Monaco completion item so
// resolveCompletionItem can fetch documentation/auto-imports lazily.
const LSP_ITEM = Symbol("lspItem");
type StashedItem = monaco.languages.CompletionItem & {
  [LSP_ITEM]?: { item: LspCompletionItem; root: string };
};

let providersRegistered = false;
let semanticRegistered = false;

/** root → handler that opens a file in that project (for cross-file go-to-def). */
const openFileHandlers = new Map<
  string,
  (rel: string, selection?: monaco.IRange | monaco.IPosition) => void
>();

export function registerOpenFileHandler(
  root: string,
  fn: (rel: string, selection?: monaco.IRange | monaco.IPosition) => void,
): () => void {
  openFileHandlers.set(root, fn);
  return () => openFileHandlers.delete(root);
}

function docToMarkdown(
  d: string | MarkupContent | undefined,
): string | monaco.IMarkdownString | undefined {
  if (d == null) return undefined;
  return typeof d === "string" ? d : { value: d.value };
}

export function registerLspProviders(): void {
  if (providersRegistered) return;
  providersRegistered = true;

  lspManager.setLegendHandler(ensureSemanticTokensProvider);

  monaco.languages.registerCompletionItemProvider(LANGS, {
    triggerCharacters: [".", '"', "'", "`", "/", "@", "<", "#", " "],
    async provideCompletionItems(model, position, context) {
      const file = getModelFile(model.uri.toString());
      const client = file && lspManager.getClient(file.root);
      if (!file || !client) return undefined;
      client.sync(model);
      const result = await client
        .completion(model.uri.toString(), toLspPosition(position), context.triggerCharacter)
        .catch(() => null);
      if (!result) return { suggestions: [] };
      const items = Array.isArray(result) ? result : result.items;
      const incomplete = Array.isArray(result) ? false : result.isIncomplete;
      const word = model.getWordUntilPosition(position);
      const defaultRange: monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      };
      const suggestions = items.map((it) => {
        const m = toMonacoCompletionItem(it, defaultRange) as StashedItem;
        m[LSP_ITEM] = { item: it, root: file.root };
        return m;
      });
      return { suggestions, incomplete };
    },
    async resolveCompletionItem(item) {
      const stash = (item as StashedItem)[LSP_ITEM];
      const client = stash && lspManager.getClient(stash.root);
      if (!stash || !client) return item;
      const resolved = await client.resolveCompletion(stash.item).catch(() => null);
      if (!resolved) return item;
      if (resolved.detail) item.detail = resolved.detail;
      item.documentation = docToMarkdown(resolved.documentation) ?? item.documentation;
      if (resolved.additionalTextEdits) {
        item.additionalTextEdits = resolved.additionalTextEdits.map((e) => ({
          range: toMonacoRange(e.range),
          text: e.newText,
        }));
      }
      return item;
    },
  });

  monaco.languages.registerHoverProvider(LANGS, {
    async provideHover(model, position) {
      const file = getModelFile(model.uri.toString());
      const client = file && lspManager.getClient(file.root);
      if (!file || !client) return null;
      client.sync(model);
      const result = await client
        .hover(model.uri.toString(), toLspPosition(position))
        .catch(() => null);
      if (!result) return null;
      return {
        contents: markupToMarkdown(result.contents),
        range: result.range ? toMonacoRange(result.range) : undefined,
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider(LANGS, {
    signatureHelpTriggerCharacters: ["(", ","],
    async provideSignatureHelp(model, position) {
      const file = getModelFile(model.uri.toString());
      const client = file && lspManager.getClient(file.root);
      if (!file || !client) return null;
      client.sync(model);
      const result = await client
        .signatureHelp(model.uri.toString(), toLspPosition(position))
        .catch(() => null);
      if (!result) return null;
      return { value: toMonacoSignatureHelp(result), dispose() {} };
    },
  });

  monaco.languages.registerDefinitionProvider(LANGS, {
    async provideDefinition(model, position) {
      const file = getModelFile(model.uri.toString());
      const client = file && lspManager.getClient(file.root);
      if (!file || !client) return null;
      client.sync(model);
      const result = await client
        .definition(model.uri.toString(), toLspPosition(position))
        .catch(() => null);
      return toMonacoLocations(result);
    },
  });

  // Cross-file navigation: Monaco can't open a model it doesn't know about, so
  // route go-to-definition into another file back to the app's tab opener.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      for (const [root, handler] of openFileHandlers) {
        const rootPath = monaco.Uri.file(root).path;
        const base = rootPath.endsWith("/") ? rootPath : rootPath + "/";
        if (resource.path.startsWith(base)) {
          handler(resource.path.slice(base.length), selectionOrPosition);
          return true;
        }
      }
      return false;
    },
  });
}

export function ensureSemanticTokensProvider(legend: SemanticTokensLegend): void {
  if (semanticRegistered) return;
  semanticRegistered = true;
  monaco.languages.registerDocumentSemanticTokensProvider(LANGS, {
    getLegend: () => ({
      tokenTypes: legend.tokenTypes,
      tokenModifiers: legend.tokenModifiers,
    }),
    async provideDocumentSemanticTokens(model) {
      const file = getModelFile(model.uri.toString());
      const client = file && lspManager.getClient(file.root);
      if (!file || !client) return null;
      client.sync(model);
      const result = await client
        .semanticTokensFull(model.uri.toString())
        .catch(() => null);
      if (!result) return null;
      return {
        data: new Uint32Array(result.data),
        resultId: result.resultId,
      };
    },
    releaseDocumentSemanticTokens() {},
  });
}

function toMonacoSignatureHelp(h: LspSignatureHelp): monaco.languages.SignatureHelp {
  return {
    activeSignature: h.activeSignature ?? 0,
    activeParameter: h.activeParameter ?? 0,
    signatures: h.signatures.map((s) => ({
      label: s.label,
      documentation: docToMarkdown(s.documentation),
      parameters:
        s.parameters?.map((p) => ({
          label: p.label,
          documentation: docToMarkdown(p.documentation),
        })) ?? [],
      activeParameter: s.activeParameter ?? undefined,
    })),
  };
}

function toMonacoLocations(
  result: Definition | DefinitionLink[] | null,
): monaco.languages.Location[] {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  return arr.map((loc) =>
    "targetUri" in loc
      ? {
          uri: monaco.Uri.parse(loc.targetUri),
          range: toMonacoRange(loc.targetSelectionRange),
        }
      : { uri: monaco.Uri.parse(loc.uri), range: toMonacoRange(loc.range) },
  );
}
