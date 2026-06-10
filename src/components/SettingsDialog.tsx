import { useEffect, useState, type ReactNode } from "react";
import { Code2, Terminal, X, type LucideIcon } from "lucide-react";

import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SectionId = "terminal" | "editor";

const SECTIONS: {
  id: SectionId;
  label: string;
  icon: LucideIcon;
}[] = [
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "editor", label: "Code Editor", icon: Code2 },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("terminal");

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex h-[460px] w-[680px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="text-sm font-medium text-fg">Settings</h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg"
            aria-label="Close settings"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Section selector */}
          <nav className="flex w-[184px] shrink-0 flex-col gap-0.5 border-r border-border p-2">
            {SECTIONS.map((s) => {
              const active = s.id === section;
              const Icon = s.icon;
              return (
                <button
                  key={s.id}
                  onClick={() => setSection(s.id)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
                    active
                      ? "bg-bg-active text-fg"
                      : "text-fg-subtle hover:bg-bg-hover hover:text-fg",
                  )}
                >
                  <Icon size={16} strokeWidth={1.8} />
                  {s.label}
                </button>
              );
            })}
          </nav>

          {/* Section content */}
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            {section === "terminal" ? <TerminalSection /> : <EditorSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-[13px] text-fg">{title}</span>
        <span className="text-xs text-fg-subtle">{description}</span>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function TerminalSection() {
  const {
    shells,
    shellProgram,
    setShellProgram,
    dangerouslySkipPermissions,
    setDangerouslySkipPermissions,
  } = useSettings();
  return (
    <>
      <SettingRow
        title="Shell"
        description="Used for new terminals. Changing this restarts open terminals."
      >
        <Select
          value={shellProgram ?? undefined}
          onValueChange={setShellProgram}
        >
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Select a shell" />
          </SelectTrigger>
          <SelectContent>
            {shells.map((shell) => (
              <SelectItem
                key={shell.id}
                value={shell.program}
                disabled={!shell.available}
              >
                {shell.label}
                {!shell.available ? " (not installed)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        title="Allow Dangerously Skip Permissions"
        description="Launch Claude tabs with --dangerously-skip-permissions, bypassing its permission prompts. Only enable if you understand the risks."
      >
        <Switch
          checked={dangerouslySkipPermissions}
          onCheckedChange={setDangerouslySkipPermissions}
        />
      </SettingRow>
    </>
  );
}

function EditorSection() {
  const { showMinimap, setShowMinimap } = useSettings();
  return (
    <SettingRow
      title="Show minimap"
      description="Display the code overview on the right edge of the editor."
    >
      <Switch checked={showMinimap} onCheckedChange={setShowMinimap} />
    </SettingRow>
  );
}
