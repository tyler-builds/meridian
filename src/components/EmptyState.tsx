import { FolderPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { isMac } from "@/lib/utils";

export function EmptyState({ onOpenProject }: { onOpenProject: () => void }) {
  return (
    <div className="flex flex-1 select-none flex-col items-center justify-center gap-6 px-6">
      <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-border bg-bg-elevated">
        <FolderPlus size={28} className="text-fg-subtle" strokeWidth={1.5} />
      </div>

      <div className="flex flex-col items-center gap-1.5 text-center">
        <h1 className="text-base font-medium text-fg">No project open</h1>
        <p className="max-w-xs text-[13px] leading-relaxed text-fg-subtle">
          Open a folder to start a new project tab with its file tree and a
          terminal.
        </p>
      </div>

      <Button size="lg" onClick={onOpenProject} className="gap-2">
        <FolderPlus size={18} strokeWidth={1.8} />
        Open Project
      </Button>

      <p className="text-xs text-fg-faint">
        or press{" "}
        <kbd className="rounded-[6px] border border-border bg-bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-fg-subtle">
          {isMac ? "⌘" : "Ctrl"} O
        </kbd>
      </p>
    </div>
  );
}
