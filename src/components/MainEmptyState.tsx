import { GitBranch, Globe, NotebookPen, Terminal } from "lucide-react";

import { ClaudeIcon } from "@/components/ClaudeIcon";

/** Shown in the main panel when a project has no open tabs. */
export function MainEmptyState({
  scratch = false,
  onNewTerminal,
  onNewBrowser,
  onNewClaude,
  onNewGit,
  onNewNotes,
}: {
  /** A folder-less scratch space: no Git, and no file-tree hint. */
  scratch?: boolean;
  onNewTerminal: () => void;
  onNewBrowser: () => void;
  onNewClaude: () => void;
  onNewGit: () => void;
  onNewNotes: () => void;
}) {
  const options = [
    {
      label: "New terminal",
      icon: <Terminal size={16} strokeWidth={1.8} />,
      onClick: onNewTerminal,
    },
    {
      label: "New browser tab",
      icon: <Globe size={16} strokeWidth={1.8} />,
      onClick: onNewBrowser,
    },
    // Git needs a repo root, so it's project-only.
    ...(scratch
      ? []
      : [
          {
            label: "Git",
            icon: <GitBranch size={16} strokeWidth={1.8} />,
            onClick: onNewGit,
          },
        ]),
    {
      label: "Notes",
      icon: <NotebookPen size={16} strokeWidth={1.8} />,
      onClick: onNewNotes,
    },
    {
      label: "Claude",
      icon: <ClaudeIcon size={16} />,
      onClick: onNewClaude,
    },
  ];

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h2 className="text-sm font-medium text-fg">No tabs open</h2>
        <p className="max-w-xs text-[13px] leading-relaxed text-fg-subtle">
          {scratch
            ? "Open a terminal, browser, or Claude below — this space isn't tied to a project."
            : "Open a new tab below, or select a file in the sidebar."}
        </p>
      </div>
      <div className="grid w-full max-w-[260px] grid-cols-2 gap-2">
        {options.map((opt) => (
          <button
            key={opt.label}
            onClick={opt.onClick}
            className="flex h-9 items-center gap-2 rounded-md border border-border bg-bg-elevated px-3 text-[13px] text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
          >
            <span className="shrink-0 text-fg-faint">{opt.icon}</span>
            <span className="truncate">{opt.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
