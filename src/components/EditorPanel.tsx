import { useCallback, useEffect, useRef } from "react";

import { monaco } from "@/lib/monaco";
import { readFileText, writeFileText } from "@/lib/tauri";
import { useSettings } from "@/lib/settings";

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
}: {
  root: string;
  openRelPaths: string[];
  activeRelPath: string | null;
  onDirtyChange?: (relPath: string, dirty: boolean) => void;
}) {
  const { showMinimap } = useSettings();
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
    const editor = monaco.editor.create(containerRef.current, {
      theme: "meridian-dark",
      automaticLayout: true,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.5,
      fontLigatures: true,
      smoothScrolling: true,
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      minimap: { enabled: showMinimap },
      padding: { top: 8 },
    });
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveActive();
    });
    return () => {
      editor.dispose();
      listenersRef.current.forEach((d) => d.dispose());
      listenersRef.current.clear();
      modelsRef.current.forEach((m) => m.dispose());
      modelsRef.current.clear();
      viewStatesRef.current.clear();
      savedVersionRef.current.clear();
      lastDirtyRef.current.clear();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply the minimap setting live.
  useEffect(() => {
    editorRef.current?.updateOptions({ minimap: { enabled: showMinimap } });
  }, [showMinimap]);

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
        model.dispose();
        modelsRef.current.delete(rel);
      }
    }
  }, [openRelPaths]);

  return <div ref={containerRef} className="h-full w-full" />;
}
