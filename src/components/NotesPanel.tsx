import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bold,
  Code,
  Heading,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  NotebookPen,
  Quote,
  SquareSplitHorizontal,
} from "lucide-react";

import { persist } from "@/lib/persist";
import { cn } from "@/lib/utils";

/** Persist key for a project's notes, scoped by repo path so they survive a
 * restart and reattach when the same folder is reopened (even with a new tab id). */
function notesKey(root: string): string {
  return `meridian.notes:${root}`;
}

/** A compact icon button for the formatting toolbar / preview toggle. */
function ToolButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // Keep focus in the textarea so selection-based edits work on click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-bg-elevated text-fg"
          : "text-fg-faint hover:bg-bg-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/** Result of a toolbar transform: the new text plus the selection to restore. */
interface EditResult {
  value: string;
  start: number;
  end: number;
}

/**
 * A per-repo note pad with Markdown support, a formatting toolbar, and an
 * optional side-by-side preview. The text is keyed by the project's absolute
 * path and saved through the shared `persist` layer (in-memory cache + debounced
 * write to the app-data state file), so notes are durable across restarts and
 * independent of the session's tab list.
 *
 * Preview renders GitHub-flavored Markdown (react-markdown + remark-gfm — raw
 * HTML is not rendered, so it's XSS-safe). Links open in an in-app browser tab
 * via `onOpenUrl` rather than navigating the app window away (a bare anchor
 * would replace the whole React root).
 */
export function NotesPanel({
  root,
  onOpenUrl,
}: {
  root: string;
  onOpenUrl?: (url: string) => void;
}) {
  const [text, setText] = useState<string>(() => persist.getItem(notesKey(root)) ?? "");
  const [showPreview, setShowPreview] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Re-read when the panel is pointed at a different repo (defensive — each
  // project mounts its own instance, but a key change shouldn't show stale text).
  useEffect(() => {
    setText(persist.getItem(notesKey(root)) ?? "");
  }, [root]);

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  const onChange = (value: string) => {
    setText(value);
    persist.setItem(notesKey(root), value);
    setSavedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setSavedFlash(false), 1200);
  };

  // Apply a transform over the current textarea selection, then restore the
  // resulting selection so consecutive edits feel continuous.
  const applyEdit = (transform: (sel: EditResult) => EditResult) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const next = transform({
      value: text,
      start: ta.selectionStart,
      end: ta.selectionEnd,
    });
    onChange(next.value);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(next.start, next.end);
    });
  };

  // Wrap the selection (or a placeholder) with inline markers, e.g. **bold**.
  const wrap = (marker: string, placeholder: string) =>
    applyEdit(({ value, start, end }) => {
      const selected = value.slice(start, end) || placeholder;
      const value2 =
        value.slice(0, start) + marker + selected + marker + value.slice(end);
      const selStart = start + marker.length;
      return { value: value2, start: selStart, end: selStart + selected.length };
    });

  // Prefix each line in the selection (headings, quotes, lists).
  const prefixLines = (make: (index: number) => string) =>
    applyEdit(({ value, start, end }) => {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      let lineEnd = value.indexOf("\n", end);
      if (lineEnd === -1) lineEnd = value.length;
      const block = value
        .slice(lineStart, lineEnd)
        .split("\n")
        .map((line, i) => make(i) + line)
        .join("\n");
      const value2 = value.slice(0, lineStart) + block + value.slice(lineEnd);
      return { value: value2, start: lineStart, end: lineStart + block.length };
    });

  const insertLink = () =>
    applyEdit(({ value, start, end }) => {
      const selected = value.slice(start, end) || "text";
      const md = `[${selected}](url)`;
      const value2 = value.slice(0, start) + md + value.slice(end);
      // Select the "url" placeholder for immediate typing.
      const urlStart = start + 1 + selected.length + 2;
      return { value: value2, start: urlStart, end: urlStart + 3 };
    });

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <NotebookPen size={14} strokeWidth={1.8} className="shrink-0 text-fg-faint" />
        <span className="text-[12px] text-fg-subtle">Notes</span>
        <span
          className={cn(
            "text-[11px] text-fg-faint transition-opacity",
            savedFlash ? "opacity-100" : "opacity-0",
          )}
        >
          Saved
        </span>
        <div className="ml-auto">
          <ToolButton
            active={showPreview}
            onClick={() => setShowPreview((v) => !v)}
            title={showPreview ? "Hide preview" : "Show preview (split)"}
          >
            <SquareSplitHorizontal size={15} strokeWidth={1.8} />
          </ToolButton>
        </div>
      </header>

      {/* Formatting toolbar — acts on the editor's current selection. */}
      <div className="no-scrollbar flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border-subtle px-2">
        <ToolButton title="Bold" onClick={() => wrap("**", "bold")}>
          <Bold size={14} strokeWidth={2} />
        </ToolButton>
        <ToolButton title="Italic" onClick={() => wrap("*", "italic")}>
          <Italic size={14} strokeWidth={2} />
        </ToolButton>
        <ToolButton title="Inline code" onClick={() => wrap("`", "code")}>
          <Code size={14} strokeWidth={2} />
        </ToolButton>
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolButton title="Heading" onClick={() => prefixLines(() => "# ")}>
          <Heading size={14} strokeWidth={2} />
        </ToolButton>
        <ToolButton title="Quote" onClick={() => prefixLines(() => "> ")}>
          <Quote size={14} strokeWidth={2} />
        </ToolButton>
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolButton title="Bulleted list" onClick={() => prefixLines(() => "- ")}>
          <List size={14} strokeWidth={2} />
        </ToolButton>
        <ToolButton
          title="Numbered list"
          onClick={() => prefixLines((i) => `${i + 1}. `)}
        >
          <ListOrdered size={14} strokeWidth={2} />
        </ToolButton>
        <ToolButton title="Task list" onClick={() => prefixLines(() => "- [ ] ")}>
          <ListChecks size={14} strokeWidth={2} />
        </ToolButton>
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolButton title="Link" onClick={insertLink}>
          <LinkIcon size={14} strokeWidth={2} />
        </ToolButton>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Editor */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          spellCheck
          placeholder="Project notes — Markdown supported, saved automatically, kept per repo."
          className={cn(
            "min-h-0 flex-1 resize-none bg-bg px-4 py-3 font-mono text-[12.5px] leading-relaxed text-fg placeholder:font-sans placeholder:text-fg-faint focus:outline-none",
            showPreview && "border-r border-border-subtle",
          )}
        />

        {/* Side-by-side preview */}
        {showPreview && (
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            {text.trim() ? (
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
                            if (href) onOpenUrl?.(href);
                          }}
                        >
                          {children}
                        </a>
                      );
                    },
                  }}
                >
                  {text}
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
