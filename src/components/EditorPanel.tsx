import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SquareSplitHorizontal } from "lucide-react";

import { monaco } from "@/lib/monaco";
import { registerModelFile, unregisterModelFile } from "@/lib/format";
import { lspManager } from "@/lib/lsp/manager";
import { registerLspProviders, registerOpenFileHandler } from "@/lib/lsp/monacoBridge";
import { onProjectFilesChange, readFileText, writeFileText } from "@/lib/tauri";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

/** Files the TypeScript/JavaScript language server handles. */
const LSP_FILE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;

/** Files the Markdown preview can render. */
const MARKDOWN_FILE = /\.(md|markdown)$/i;

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
  onOpenUrl,
}: {
  root: string;
  openRelPaths: string[];
  activeRelPath: string | null;
  onDirtyChange?: (relPath: string, dirty: boolean) => void;
  /** Open another file in this project (used for cross-file go-to-definition). */
  onOpenFile?: (relPath: string) => void;
  /** Open a web URL in an in-app browser tab (Markdown preview links). */
  onOpenUrl?: (url: string) => void;
}) {
  const { showMinimap, formatOnSave, editorTheme, lspEnabled, markdownPreviewOnly } =
    useSettings();
  // Markdown preview: a side-by-side pane rendering the active file's live text.
  // `showPreview` is a session-wide toggle; the pane only appears for Markdown.
  const [showPreview, setShowPreview] = useState(false);
  const [previewText, setPreviewText] = useState("");
  const isMarkdown = !!activeRelPath && MARKDOWN_FILE.test(activeRelPath);
  // When "Markdown preview only" is on, Markdown files render as preview alone —
  // no editor, no split toggle. Otherwise the split toggle drives an optional
  // side-by-side preview next to the editor.
  const previewOnly = isMarkdown && markdownPreviewOnly;
  const showToggle = isMarkdown && !markdownPreviewOnly;
  const splitPreview = showToggle && showPreview;
  const previewVisible = previewOnly || splitPreview;
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
  // Content of each file's most recent in-app save, so the watcher echo of our
  // own write isn't mistaken for an external change (see the reload effect).
  const selfWriteRef = useRef<Map<string, string>>(new Map());

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
      const written = model.getValue();
      await writeFileText(rootRef.current, rel, written);
      selfWriteRef.current.set(rel, written);
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
      selfWriteRef.current.clear();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload open files when they change on disk outside the app (an AI agent,
  // VS Code, git checkout…). The project's tree watcher emits the changed
  // relative paths; any matching open model is re-read and, if the disk
  // content differs from the buffer, replaced. The disk version wins even over
  // unsaved local edits (deliberate: external tools are the primary writers) —
  // but the replacement goes through pushEditOperations, so Ctrl+Z can recover
  // a clobbered buffer. Our own saves are naturally skipped by the
  // content-equality check.
  useEffect(() => {
    let active = true;
    const reload = async (rel: string) => {
      const model = modelsRef.current.get(rel);
      // Only successfully loaded files — never error buffers.
      if (!model || !savedVersionRef.current.has(rel)) return;
      let content: string;
      try {
        content = await readFileText(rootRef.current, rel);
      } catch {
        // Deleted or unreadable: keep the buffer so its contents aren't lost
        // (the user can still save to recreate the file).
        return;
      }
      if (!active || model.isDisposed()) return;
      // The echo of our own save arriving via the watcher (up to a debounce
      // period after Ctrl+S). The buffer may already be ahead of it again —
      // "reloading" would revert keystrokes typed since the save — so skip by
      // matching what we wrote, not the current buffer.
      if (selfWriteRef.current.get(rel) === content) {
        selfWriteRef.current.delete(rel);
        return;
      }
      if (content === model.getValue()) return;
      const editor = editorRef.current;
      const isActive = editor?.getModel() === model;
      const viewState = isActive ? editor.saveViewState() : null;
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: content }],
        () => null,
      );
      // New clean baseline: the buffer now mirrors the disk.
      savedVersionRef.current.set(rel, model.getAlternativeVersionId());
      reportDirty(rel, false);
      // The full-range replace moves the cursor; put the user back where they
      // were (Monaco clamps positions that no longer exist).
      if (isActive && viewState) editor.restoreViewState(viewState);
    };

    const unlistenPromise = onProjectFilesChange(({ root: evRoot, paths }) => {
      if (evRoot !== rootRef.current) return;
      for (const rel of paths) void reload(rel);
    });
    return () => {
      active = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [reportDirty]);

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

  // Keep the preview in sync with the active model's live content while the
  // preview is showing for a Markdown file. Rebinds on model swap (tab change),
  // which may complete after this effect runs since the swap is async.
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
    const modelSub = editor.onDidChangeModel(bind);
    return () => {
      modelSub.dispose();
      contentSub?.dispose();
    };
  }, [previewVisible, activeRelPath]);

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
        selfWriteRef.current.delete(rel);
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
        {/* The single Monaco container — always mounted, never re-created; just
            hidden in preview-only mode so the editor instance survives. */}
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
                            // Never let a link navigate the app window itself.
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
