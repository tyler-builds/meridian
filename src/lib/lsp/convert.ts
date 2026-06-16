import { monaco } from "@/lib/monaco";
import {
  CompletionItemKind as LspCompletionItemKind,
  DiagnosticSeverity,
  InsertTextFormat,
  type CompletionItem as LspCompletionItem,
  type Diagnostic as LspDiagnostic,
  type Hover as LspHover,
  type MarkedString,
  type MarkupContent,
  type Position as LspPosition,
  type Range as LspRange,
  type TextEdit as LspTextEdit,
} from "vscode-languageserver-protocol/browser";

/**
 * Pure conversions between LSP wire types (0-based line/character) and Monaco
 * editor types (1-based lineNumber/column). No I/O — kept separate so both the
 * client and the Monaco providers can share them.
 */

export function toMonacoPosition(p: LspPosition): monaco.IPosition {
  return { lineNumber: p.line + 1, column: p.character + 1 };
}

export function toLspPosition(p: monaco.IPosition): LspPosition {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

export function toMonacoRange(r: LspRange): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

function toMarkerSeverity(s?: DiagnosticSeverity): monaco.MarkerSeverity {
  switch (s) {
    case DiagnosticSeverity.Error:
      return monaco.MarkerSeverity.Error;
    case DiagnosticSeverity.Warning:
      return monaco.MarkerSeverity.Warning;
    case DiagnosticSeverity.Hint:
      return monaco.MarkerSeverity.Hint;
    case DiagnosticSeverity.Information:
    default:
      return monaco.MarkerSeverity.Info;
  }
}

export function toMarkerData(d: LspDiagnostic): monaco.editor.IMarkerData {
  const code = d.code == null ? undefined : String(d.code);
  const message = typeof d.message === "string" ? d.message : d.message.value;
  return {
    severity: toMarkerSeverity(d.severity),
    message,
    source: d.source,
    code,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
  };
}

// LSP CompletionItemKind (1-based, see spec) → Monaco's CompletionItemKind enum.
const COMPLETION_KIND: Record<number, monaco.languages.CompletionItemKind> = {
  [LspCompletionItemKind.Text]: monaco.languages.CompletionItemKind.Text,
  [LspCompletionItemKind.Method]: monaco.languages.CompletionItemKind.Method,
  [LspCompletionItemKind.Function]: monaco.languages.CompletionItemKind.Function,
  [LspCompletionItemKind.Constructor]:
    monaco.languages.CompletionItemKind.Constructor,
  [LspCompletionItemKind.Field]: monaco.languages.CompletionItemKind.Field,
  [LspCompletionItemKind.Variable]: monaco.languages.CompletionItemKind.Variable,
  [LspCompletionItemKind.Class]: monaco.languages.CompletionItemKind.Class,
  [LspCompletionItemKind.Interface]:
    monaco.languages.CompletionItemKind.Interface,
  [LspCompletionItemKind.Module]: monaco.languages.CompletionItemKind.Module,
  [LspCompletionItemKind.Property]: monaco.languages.CompletionItemKind.Property,
  [LspCompletionItemKind.Unit]: monaco.languages.CompletionItemKind.Unit,
  [LspCompletionItemKind.Value]: monaco.languages.CompletionItemKind.Value,
  [LspCompletionItemKind.Enum]: monaco.languages.CompletionItemKind.Enum,
  [LspCompletionItemKind.Keyword]: monaco.languages.CompletionItemKind.Keyword,
  [LspCompletionItemKind.Snippet]: monaco.languages.CompletionItemKind.Snippet,
  [LspCompletionItemKind.Color]: monaco.languages.CompletionItemKind.Color,
  [LspCompletionItemKind.File]: monaco.languages.CompletionItemKind.File,
  [LspCompletionItemKind.Reference]:
    monaco.languages.CompletionItemKind.Reference,
  [LspCompletionItemKind.Folder]: monaco.languages.CompletionItemKind.Folder,
  [LspCompletionItemKind.EnumMember]:
    monaco.languages.CompletionItemKind.EnumMember,
  [LspCompletionItemKind.Constant]: monaco.languages.CompletionItemKind.Constant,
  [LspCompletionItemKind.Struct]: monaco.languages.CompletionItemKind.Struct,
  [LspCompletionItemKind.Event]: monaco.languages.CompletionItemKind.Event,
  [LspCompletionItemKind.Operator]: monaco.languages.CompletionItemKind.Operator,
  [LspCompletionItemKind.TypeParameter]:
    monaco.languages.CompletionItemKind.TypeParameter,
};

function toMonacoCompletionKind(
  k?: LspCompletionItemKind,
): monaco.languages.CompletionItemKind {
  return (
    (k != null ? COMPLETION_KIND[k] : undefined) ??
    monaco.languages.CompletionItemKind.Text
  );
}

/** Normalize LSP hover/markup content to Monaco markdown strings. */
export function markupToMarkdown(
  contents: LspHover["contents"],
): monaco.IMarkdownString[] {
  const items: (MarkedString | MarkupContent)[] = Array.isArray(contents)
    ? contents
    : [contents];
  return items.map((c) => {
    if (typeof c === "string") return { value: c };
    if ("language" in c)
      return { value: "```" + c.language + "\n" + c.value + "\n```" };
    return { value: c.value };
  });
}

function toMonacoTextEdit(e: LspTextEdit): monaco.languages.TextEdit {
  return { range: toMonacoRange(e.range), text: e.newText };
}

/**
 * Convert one LSP completion item to a Monaco completion item. `defaultRange` is
 * the word-range to replace when the item carries no explicit `textEdit`.
 */
export function toMonacoCompletionItem(
  item: LspCompletionItem,
  defaultRange: monaco.IRange,
): monaco.languages.CompletionItem {
  let range: monaco.languages.CompletionItem["range"] = defaultRange;
  let insertText = item.insertText ?? item.label;

  const edit = item.textEdit;
  if (edit) {
    insertText = edit.newText;
    if ("range" in edit) {
      range = toMonacoRange(edit.range);
    } else {
      // InsertReplaceEdit
      range = {
        insert: toMonacoRange(edit.insert),
        replace: toMonacoRange(edit.replace),
      };
    }
  }

  const documentation =
    item.documentation == null
      ? undefined
      : typeof item.documentation === "string"
        ? item.documentation
        : { value: item.documentation.value };

  return {
    label: item.label,
    kind: toMonacoCompletionKind(item.kind),
    insertText,
    range,
    detail: item.detail,
    documentation,
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
    commitCharacters: item.commitCharacters,
    insertTextRules:
      item.insertTextFormat === InsertTextFormat.Snippet
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    additionalTextEdits: item.additionalTextEdits?.map(toMonacoTextEdit),
  };
}
