import { useCallback, useEffect, useRef } from "react";

import { monaco } from "@/lib/monaco";
import { registerModelFile, unregisterModelFile } from "@/lib/format";
import { lspManager } from "@/lib/lsp/manager";
import { registerLspProviders, registerOpenFileHandler } from "@/lib/lsp/monacoBridge";
import { readFileText, writeFileText } from "@/lib/tauri";
import { useSettings } from "@/lib/settings";

/** Files the TypeScript/JavaScript language server handles. */
const LSP_FILE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;

/**
 * A single Monaco editor instance shared across all open file tabs of a
 * project. Each file gets its own text model; switching tabs swaps the model
 * and preserves per-file scroll/cursor (view state). Tracks unsaved changes
 * (dirty) per file and saves on Ctrl/Cmd+S. Closed files' models are disposed.
 */
export function EditorPanel({
  root,
  openRelPaths,
  activeRelPath,
  onDirtyChange,
  onOpenFile,
}: {
  root: string;
  openRelPaths: string[];
  activeRelPath: string | null;
  onDirtyChange?: (relPath: string, dirty: boolean) => void;
  /** Open another file in this project (used for cross-file go-to-definition). */
  onOpenFile?: (relPath: string) => void;
}) {
  const { showMinimap, formatOnSave, editorTheme, lspEnabled } = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  const viewStatesRef = useRef<
    Map<string, monaco.editor.ICodeEditorViewState | null>
  >(new Map());
  const currentRef = useRef<string | null>(null);

  // Saved baseline version id per file (present only for successfully loaded
  // files), the last-reported dirty value, and each model's change listener.
  const savedVersionRef = useRef<Map<string, number>>(new Map());
  const lastDirtyRef = useRef<Map<string, boolean>>(new Map());
  const listenersRef = useRef<Map<string, monaco.IDisposable>>(new Map());

  // Keep latest props reachable from stable callbacks.
  const rootRef = useRef(root);
  rootRef.current = root;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const formatOnSaveRef = useRef(formatOnSave);
  formatOnSaveRef.current = formatOnSave;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const lspEnabledRef = useRef(lspEnabled);
  lspEnabledRef.current = lspEnabled;

  // Debounced LSP didChange timers per file, and pending go-to-definition
  // reveals to apply once the target file's model becomes active.
  const lspTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const pendingRevealRef = useRef<
    Map<string, monaco.IRange | monaco.IPosition>
  >(new Map());

  const reportDirty = useCallback((rel: string, dirty: boolean) => {
    if (lastDirtyRef.current.get(rel) === dirty) return;
    lastDirtyRef.current.set(rel, dirty);
    onDirtyChangeRef.current?.(rel, dirty);
  }, []);

  const saveActive = useCallback(async () => {
    const rel = currentRef.current;
    if (!rel) return;
    const model = modelsRef.current.get(rel);
    // Only save real (successfully loaded) files, never error buffers.
    if (!model || !savedVersionRef.current.has(rel)) return;
    try {
      // Format-on-save: run Monaco's formatter (Prettier) before writing. The
      // action no-ops for languages without a formatter, and a failed format
      // must not block the save, so swallow its errors.
      if (formatOnSaveRef.current && editorRef.current?.getModel() === model) {
        try {
          await editorRef.current
            .getAction("editor.action.formatDocument")
            ?.run();
        } catch {
          /* formatting failed (e.g. syntax error); save the file as-is */
        }
      }
      await writeFileText(rootRef.current, rel, model.getValue());
      savedVersionRef.current.set(rel, model.getAlternativeVersionId());
      reportDirty(rel, false);
    } catch (err) {
      console.error("Failed to save file:", err);
    }
  }, [reportDirty]);

  // Create the editor once.
  useEffect(() => {
    if (!containerRef.current) return;
    // Register the LSP Monaco providers (idempotent — global, once per app).
    registerLspProviders();
    const editor = monaco.editor.create(containerRef.current, {
      theme: editorTheme,
      automaticLayout: true,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.5,
      fontLigatures: true,
      smoothScrolling: true,
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      minimap: { enabled: showMinimap },
      "semanticHighlighting.enabled": true,
      padding: { top: 8 },
    });
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveActive();
    });

    // Route cross-file go-to-definition for this project back to the app's tab
    // opener, stashing the target position to reveal once the file is active.
    const unregisterOpener = registerOpenFileHandler(
      rootRef.current,
      (rel, selection) => {
        if (selection) pendingRevealRef.current.set(rel, selection);
        onOpenFileRef.current?.(rel);
      },
    );

    return () => {
      unregisterOpener();
      lspManager.disposeClient(rootRef.current);
      lspTimersRef.current.forEach((t) => clearTimeout(t));
      lspTimersRef.current.clear();
      pendingRevealRef.current.clear();
      editor.dispose();
      listenersRef.current.forEach((d) => d.dispose());
      listenersRef.current.clear();
      modelsRef.current.forEach((m, rel) => {
        unregisterModelFile(monaco.Uri.file(`${rootRef.current}/${rel}`).toString());
        m.dispose();
      });
      modelsRef.current.clear();
      viewStatesRef.current.clear();
      savedVersionRef.current.clear();
      lastDirtyRef.current.clear();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Enable/disable the language server feature globally per the setting.
  useEffect(() => {
    lspManager.setEnabled(lspEnabled);
  }, [lspEnabled]);

  // Apply the minimap setting live.
  useEffect(() => {
    editorRef.current?.updateOptions({ minimap: { enabled: showMinimap } });
  }, [showMinimap]);

  // Apply the theme live. `theme` is a per-instance option here, so this won't
  // disturb other Monaco instances (e.g. the diff viewer's own theme).
  useEffect(() => {
    editorRef.current?.updateOptions({ theme: editorTheme });
  }, [editorTheme]);

  // Swap to the active file.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let cancelled = false;

    // Save the outgoing file's view state.
    if (currentRef.current) {
      viewStatesRef.current.set(currentRef.current, editor.saveViewState());
    }

    const rel = activeRelPath;
    if (!rel) {
      currentRef.current = null;
      return;
    }

    void (async () => {
      let model = modelsRef.current.get(rel);
      if (!model) {
        const uri = monaco.Uri.file(`${root}/${rel}`);
        try {
          const content = await readFileText(root, rel);
          if (cancelled) return;
          model =
            monaco.editor.getModel(uri) ??
            monaco.editor.createModel(content, undefined, uri);
          // Let the formatter resolve this model back to its project file.
          registerModelFile(uri.toString(), root, rel);
          // Open the file in the language server, if it handles this type.
          if (lspEnabledRef.current && LSP_FILE.test(rel)) {
            lspManager.ensureClient(root);
            lspManager.getClient(root)?.sync(model);
          }
          // Establish the clean baseline and watch for edits.
          savedVersionRef.current.set(rel, model.getAlternativeVersionId());
          const watched = model;
          const listener = watched.onDidChangeContent(() => {
            const saved = savedVersionRef.current.get(rel);
            reportDirty(
              rel,
              saved !== undefined &&
                watched.getAlternativeVersionId() !== saved,
            );
            // Debounce a full-text sync so the server recomputes diagnostics.
            if (lspEnabledRef.current && LSP_FILE.test(rel)) {
              const prev = lspTimersRef.current.get(rel);
              if (prev) clearTimeout(prev);
              lspTimersRef.current.set(
                rel,
                setTimeout(() => {
                  lspTimersRef.current.delete(rel);
                  lspManager.getClient(rootRef.current)?.sync(watched);
                }, 150),
              );
            }
          });
          listenersRef.current.set(rel, listener);
        } catch (err) {
          if (cancelled) return;
          model = monaco.editor.createModel(
            `// Could not open ${rel}\n// ${err}`,
            "plaintext",
          );
        }
        modelsRef.current.set(rel, model);
      }
      if (cancelled) return;
      editor.setModel(model);
      const vs = viewStatesRef.current.get(rel);
      if (vs) editor.restoreViewState(vs);
      // Apply a pending go-to-definition reveal for this file, if any.
      const reveal = pendingRevealRef.current.get(rel);
      if (reveal) {
        pendingRevealRef.current.delete(rel);
        if ("startLineNumber" in reveal) {
          editor.setSelection(reveal);
          editor.revealRangeInCenter(reveal, monaco.editor.ScrollType.Smooth);
        } else {
          editor.setPosition(reveal);
          editor.revealPositionInCenter(reveal, monaco.editor.ScrollType.Smooth);
        }
      }
      editor.focus();
      currentRef.current = rel;
    })();

    return () => {
      cancelled = true;
    };
  }, [root, activeRelPath, reportDirty]);

  // Dispose models/listeners for files whose tabs were closed.
  useEffect(() => {
    const open = new Set(openRelPaths);
    for (const [rel, model] of modelsRef.current) {
      if (!open.has(rel)) {
        listenersRef.current.get(rel)?.dispose();
        listenersRef.current.delete(rel);
        viewStatesRef.current.delete(rel);
        savedVersionRef.current.delete(rel);
        lastDirtyRef.current.delete(rel);
        const uriKey = monaco.Uri.file(`${rootRef.current}/${rel}`).toString();
        unregisterModelFile(uriKey);
        const timer = lspTimersRef.current.get(rel);
        if (timer) {
          clearTimeout(timer);
          lspTimersRef.current.delete(rel);
        }
        lspManager.getClient(rootRef.current)?.didClose(uriKey);
        pendingRevealRef.current.delete(rel);
        model.dispose();
        modelsRef.current.delete(rel);
      }
    }
  }, [openRelPaths]);

  return <div ref={containerRef} className="h-full w-full" />;
}
