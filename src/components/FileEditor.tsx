import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SquareSplitHorizontal } from "lucide-react";

import { monaco } from "@/lib/monaco";
import { registerModelFile, unregisterModelFile } from "@/lib/format";
import { lspManager } from "@/lib/lsp/manager";
import { registerLspProviders } from "@/lib/lsp/monacoBridge";
import { acquireLspClient, releaseLspClient } from "@/lib/editorModels";
import { subscribeReveal } from "@/lib/editorReveal";
import { onProjectFilesChange, readFileText, writeFileText } from "@/lib/tauri";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

/** Files the TypeScript/JavaScript language server handles. */
const LSP_FILE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;

/** Files the Markdown preview can render. */
const MARKDOWN_FILE = /\.(md|markdown)$/i;

/** Move the editor to a go-to-definition / search target and center it. */
function applyReveal(
  editor: monaco.editor.IStandaloneCodeEditor,
  pos: monaco.IRange | monaco.IPosition,
): void {
  if ("startLineNumber" in pos) {
    editor.setSelection(pos);
    editor.revealRangeInCenter(pos, monaco.editor.ScrollType.Smooth);
  } else {
    editor.setPosition(pos);
    editor.revealPositionInCenter(pos, monaco.editor.ScrollType.Smooth);
  }
}

/**
 * A single file's Monaco editor. Unlike the former shared EditorPanel, each
 * open file gets its own instance and its own text model, so files can live in
 * different panes side by side. The model is owned by this instance (a file is
 * only ever open in one pane), so it's disposed on unmount; the per-project LSP
 * client is ref-counted (see editorModels) so a sibling editor keeps it alive.
 */
export function FileEditor({
  root,
  relPath,
  active,
  onDirtyChange,
  onOpenUrl,
}: {
  root: string;
  relPath: string;
  /** This editor is the visible, focused tab (drives autofocus). */
  active: boolean;
  onDirtyChange?: (relPath: string, dirty: boolean) => void;
  /** Open a web URL in an in-app browser tab (Markdown preview links). */
  onOpenUrl?: (url: string) => void;
}) {
  const { showMinimap, formatOnSave, editorTheme, lspEnabled, markdownPreviewOnly } =
    useSettings();
  const [showPreview, setShowPreview] = useState(false);
  const [previewText, setPreviewText] = useState("");
  const isMarkdown = MARKDOWN_FILE.test(relPath);
  const previewOnly = isMarkdown && markdownPreviewOnly;
  const showToggle = isMarkdown && !markdownPreviewOnly;
  const splitPreview = showToggle && showPreview;
  const previewVisible = previewOnly || splitPreview;

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const ownsModelRef = useRef(false);
  const isLsp = LSP_FILE.test(relPath);

  // Saved baseline version id (set only once the file successfully loads), the
  // last-reported dirty value, and the content of our most recent save (so the
  // watcher echo of our own write isn't mistaken for an external edit).
  const savedVersionRef = useRef<number | null>(null);
  const lastDirtyRef = useRef<boolean | null>(null);
  const selfWriteRef = useRef<string | null>(null);
  const lspTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rootRef = useRef(root);
  rootRef.current = root;
  const relRef = useRef(relPath);
  relRef.current = relPath;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const formatOnSaveRef = useRef(formatOnSave);
  formatOnSaveRef.current = formatOnSave;
  const lspEnabledRef = useRef(lspEnabled);
  lspEnabledRef.current = lspEnabled;
  const activeRef = useRef(active);
  activeRef.current = active;
  // Whether we hold an LSP-client ref, so release exactly matches acquire even
  // if the file failed to load or the LSP setting toggled during its lifetime.
  const acquiredLspRef = useRef(false);

  const uriKey = monaco.Uri.file(`${root}/${relPath}`).toString();

  const reportDirty = useCallback((dirty: boolean) => {
    if (lastDirtyRef.current === dirty) return;
    lastDirtyRef.current = dirty;
    onDirtyChangeRef.current?.(relRef.current, dirty);
  }, []);

  const saveActive = useCallback(async () => {
    const model = modelRef.current;
    if (!model || savedVersionRef.current === null) return;
    try {
      if (formatOnSaveRef.current && editorRef.current?.getModel() === model) {
        try {
          await editorRef.current
            .getAction("editor.action.formatDocument")
            ?.run();
        } catch {
          /* formatting failed (e.g. syntax error); save the file as-is */
        }
      }
      const written = model.getValue();
      await writeFileText(rootRef.current, relRef.current, written);
      selfWriteRef.current = written;
      savedVersionRef.current = model.getAlternativeVersionId();
      reportDirty(false);
    } catch (err) {
      console.error("Failed to save file:", err);
    }
  }, [reportDirty]);

  // Create the editor + model once, for this file.
  useEffect(() => {
    if (!containerRef.current) return;
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

    let cancelled = false;
    let changeSub: monaco.IDisposable | undefined;
    let revealUnsub: (() => void) | undefined;
    const root0 = rootRef.current;
    const rel0 = relRef.current;

    void (async () => {
      let model: monaco.editor.ITextModel;
      try {
        const content = await readFileText(root0, rel0);
        if (cancelled) return;
        const uri = monaco.Uri.file(`${root0}/${rel0}`);
        const existing = monaco.editor.getModel(uri);
        model = existing ?? monaco.editor.createModel(content, undefined, uri);
        ownsModelRef.current = !existing;
        registerModelFile(uri.toString(), root0, rel0);
        if (lspEnabledRef.current && isLsp) {
          acquireLspClient(root0);
          acquiredLspRef.current = true;
          lspManager.getClient(root0)?.sync(model);
        }
        savedVersionRef.current = model.getAlternativeVersionId();
        changeSub = model.onDidChangeContent(() => {
          const saved = savedVersionRef.current;
          reportDirty(saved !== null && model.getAlternativeVersionId() !== saved);
          if (lspEnabledRef.current && isLsp) {
            if (lspTimerRef.current) clearTimeout(lspTimerRef.current);
            lspTimerRef.current = setTimeout(() => {
              lspTimerRef.current = null;
              lspManager.getClient(rootRef.current)?.sync(model);
            }, 150);
          }
        });
      } catch (err) {
        if (cancelled) return;
        model = monaco.editor.createModel(
          `// Could not open ${rel0}\n// ${err}`,
          "plaintext",
        );
        ownsModelRef.current = true;
      }
      if (cancelled) {
        if (ownsModelRef.current) model.dispose();
        return;
      }
      modelRef.current = model;
      editor.setModel(model);
      // Apply go-to-definition / search reveals for this file — both any
      // pending one (drained on subscribe) and later ones while it stays open
      // (an already-open file is re-activated, not remounted).
      revealUnsub = subscribeReveal(root0, rel0, (pos) => {
        const ed = editorRef.current;
        if (ed) applyReveal(ed, pos);
      });
      // Only grab focus if this is the visible/focused tab — several editors
      // mount at once on session restore and must not fight over focus.
      if (activeRef.current) editor.focus();
    })();

    return () => {
      cancelled = true;
      if (lspTimerRef.current) clearTimeout(lspTimerRef.current);
      changeSub?.dispose();
      revealUnsub?.();
      const model = modelRef.current;
      if (acquiredLspRef.current) {
        lspManager.getClient(rootRef.current)?.didClose(uriKey);
        releaseLspClient(rootRef.current);
        acquiredLspRef.current = false;
      }
      unregisterModelFile(uriKey);
      editor.dispose();
      if (model && ownsModelRef.current && !model.isDisposed()) model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // Bound to this file: root/relPath are stable for an instance's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload when this file changes on disk outside the app.
  useEffect(() => {
    let alive = true;
    const reload = async () => {
      const model = modelRef.current;
      if (!model || savedVersionRef.current === null) return;
      let content: string;
      try {
        content = await readFileText(rootRef.current, relRef.current);
      } catch {
        return; // deleted/unreadable: keep the buffer
      }
      if (!alive || model.isDisposed()) return;
      if (selfWriteRef.current === content) {
        selfWriteRef.current = null;
        return;
      }
      if (content === model.getValue()) return;
      const editor = editorRef.current;
      const isActive = editor?.getModel() === model;
      const viewState = isActive ? editor!.saveViewState() : null;
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: content }],
        () => null,
      );
      savedVersionRef.current = model.getAlternativeVersionId();
      reportDirty(false);
      if (isActive && viewState) editor!.restoreViewState(viewState);
    };
    const unlistenPromise = onProjectFilesChange(({ root: evRoot, paths }) => {
      if (evRoot !== rootRef.current) return;
      if (paths.includes(relRef.current)) void reload();
    });
    return () => {
      alive = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [reportDirty]);

  // Enable/disable the language server feature globally per the setting.
  useEffect(() => {
    lspManager.setEnabled(lspEnabled);
  }, [lspEnabled]);

  // Live-apply minimap / theme.
  useEffect(() => {
    editorRef.current?.updateOptions({ minimap: { enabled: showMinimap } });
  }, [showMinimap]);
  useEffect(() => {
    editorRef.current?.updateOptions({ theme: editorTheme });
  }, [editorTheme]);

  // Refocus when this editor becomes the active tab.
  useEffect(() => {
    if (active) editorRef.current?.focus();
  }, [active]);

  // Keep the preview in sync with the model's live content while showing.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !previewVisible) return;
    let contentSub: monaco.IDisposable | undefined;
    const bind = () => {
      contentSub?.dispose();
      const model = editor.getModel();
      setPreviewText(model ? model.getValue() : "");
      contentSub = model?.onDidChangeContent(() => setPreviewText(model.getValue()));
    };
    bind();
    return () => contentSub?.dispose();
  }, [previewVisible]);

  return (
    <div className="flex h-full w-full flex-col">
      {showToggle && (
        <div className="flex h-9 shrink-0 items-center justify-end border-b border-border-subtle px-2">
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            title={showPreview ? "Hide preview" : "Show preview (split)"}
            aria-label={showPreview ? "Hide preview" : "Show preview"}
            aria-pressed={showPreview}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              showPreview
                ? "bg-bg-elevated text-fg"
                : "text-fg-faint hover:bg-bg-hover hover:text-fg",
            )}
          >
            <SquareSplitHorizontal size={15} strokeWidth={1.8} />
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div
          ref={containerRef}
          className={cn(
            "min-h-0 min-w-0 flex-1",
            previewOnly && "hidden",
            splitPreview && "border-r border-border-subtle",
          )}
        />
        {previewVisible && (
          <div className="min-h-0 min-w-0 flex-1 overflow-auto px-6 py-4">
            {previewText.trim() ? (
              <div className="md">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a({ href, children }) {
                      return (
                        <a
                          href={href}
                          onClick={(e) => {
                            e.preventDefault();
                            if (href && /^https?:\/\//i.test(href)) onOpenUrl?.(href);
                          }}
                        >
                          {children}
                        </a>
                      );
                    },
                  }}
                >
                  {previewText}
                </Markdown>
              </div>
            ) : (
              <p className="text-[13px] text-fg-faint">Nothing to preview yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
