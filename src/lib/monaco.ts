import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

import {
  SUPPORTED_FORMAT_LANGUAGES,
  formatDocument,
  getModelFile,
} from "@/lib/format";

// Bundle Monaco's language workers locally (no CDN) so the editor works offline.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Monaco bundles the full TypeScript service and supports JSX/TSX, but its
// defaults don't enable the `jsx` flag, and it only sees the single open file
// (no tsconfig / node_modules). Enable JSX, and silence single-file semantic
// errors (false "cannot find module", "JSX flag", etc.) — real diagnostics
// will come from LSP later. Syntax errors and completions still work.
const tsCompilerOptions: monaco.languages.typescript.CompilerOptions = {
  target: monaco.languages.typescript.ScriptTarget.ESNext,
  module: monaco.languages.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
  jsxImportSource: "react",
  allowJs: true,
  allowNonTsExtensions: true,
  esModuleInterop: true,
  skipLibCheck: true,
};
const tsDiagnostics = {
  noSemanticValidation: true,
  noSyntaxValidation: false,
  noSuggestionDiagnostics: true,
};
monaco.languages.typescript.typescriptDefaults.setCompilerOptions(tsCompilerOptions);
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(tsDiagnostics);
monaco.languages.typescript.javascriptDefaults.setCompilerOptions(tsCompilerOptions);
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(tsDiagnostics);

// Semantic-token colors (used once the LSP provides semantic tokens). Monaco
// matches the token-type name against these rules; this is what makes
// variables / properties / functions / types visually distinct. Modeled on
// VS Code's Dark+ palette so it sits naturally on the vs-dark base.
const SEMANTIC_TOKEN_RULES: { token: string; foreground: string }[] = [
  { token: "function", foreground: "dcdcaa" },
  { token: "method", foreground: "dcdcaa" },
  { token: "macro", foreground: "dcdcaa" },
  { token: "decorator", foreground: "dcdcaa" },
  { token: "variable", foreground: "9cdcfe" },
  { token: "parameter", foreground: "9cdcfe" },
  { token: "property", foreground: "9cdcfe" },
  { token: "enumMember", foreground: "4fc1ff" },
  { token: "class", foreground: "4ec9b0" },
  { token: "interface", foreground: "4ec9b0" },
  { token: "type", foreground: "4ec9b0" },
  { token: "enum", foreground: "4ec9b0" },
  { token: "struct", foreground: "4ec9b0" },
  { token: "typeParameter", foreground: "4ec9b0" },
  { token: "namespace", foreground: "4ec9b0" },
];

monaco.editor.defineTheme("meridian-dark", {
  base: "vs-dark",
  inherit: true,
  rules: SEMANTIC_TOKEN_RULES,
  colors: {
    "editor.background": "#1c1c1c",
    "editor.foreground": "#e5e5e5",
    "editorGutter.background": "#1c1c1c",
    "editorLineNumber.foreground": "#6b6b6b",
    "editorLineNumber.activeForeground": "#a1a1a1",
    "editor.lineHighlightBackground": "#232323",
    "editor.selectionBackground": "#3a3a3a",
    "editorWidget.background": "#232323",
    "editorWidget.border": "#2e2e2e",
    "editorIndentGuide.background1": "#2a2a2a",
    "scrollbarSlider.background": "#33333380",
    "minimap.background": "#1c1c1c",
  },
});

// Wire Prettier into Monaco as a document formatter for each supported
// language. This powers the built-in "Format Document" command (Shift+Alt+F,
// the right-click menu) and the editor's format-on-save flow alike.
for (const languageId of SUPPORTED_FORMAT_LANGUAGES) {
  monaco.languages.registerDocumentFormattingEditProvider(languageId, {
    async provideDocumentFormattingEdits(model, options) {
      const code = model.getValue();
      const formatted = await formatDocument({
        code,
        languageId,
        file: getModelFile(model.uri.toString()),
        editorIndent: {
          tabWidth: options.tabSize,
          useTabs: !options.insertSpaces,
        },
      });
      if (formatted == null || formatted === code) return [];
      return [{ range: model.getFullModelRange(), text: formatted }];
    },
  });
}

/**
 * Editor themes offered in settings: Meridian's tuned dark theme plus Monaco's
 * built-in defaults. `id` is passed straight to Monaco's `theme` option.
 */
export const EDITOR_THEMES: { id: string; label: string }[] = [
  { id: "meridian-dark", label: "Meridian Dark" },
  { id: "vs-dark", label: "Dark (Visual Studio)" },
  { id: "vs", label: "Light (Visual Studio)" },
  { id: "hc-black", label: "High Contrast Dark" },
  { id: "hc-light", label: "High Contrast Light" },
];

export const DEFAULT_EDITOR_THEME = "meridian-dark";

export { monaco };
