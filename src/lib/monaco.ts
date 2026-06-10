import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

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

monaco.editor.defineTheme("meridian-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
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

export { monaco };
