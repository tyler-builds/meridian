import type { MainTab, ProjectTab } from "@/types";
import { persist } from "@/lib/persist";

const KEY = "meridian.session";

export interface PersistedSession {
  projects: {
    id: string;
    name: string;
    path: string;
    mainTabs: MainTab[];
    activeMainTabId: string | null;
  }[];
  activeProjectId: string | null;
}

/** Load the persisted workspace, or null if none/corrupt. */
export function loadSession(): PersistedSession | null {
  try {
    const raw = persist.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!Array.isArray(parsed.projects)) return null;
    // Migrate the former "diff" tab kind to "git" (the Diff tab grew staging +
    // commit/push and was renamed). Old sessions persist kind:"diff"/title:"Diff".
    for (const project of parsed.projects) {
      if (!Array.isArray(project.mainTabs)) continue;
      for (const tab of project.mainTabs) {
        if ((tab.kind as string) === "diff") {
          tab.kind = "git";
          if (tab.title === "Diff") tab.title = "Git";
        }
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the open projects, their main tabs, and the active selections. */
export function saveSession(
  tabs: ProjectTab[],
  activeProjectId: string | null,
): void {
  const session: PersistedSession = {
    projects: tabs.map((t) => ({
      id: t.id,
      name: t.name,
      path: t.path,
      // Don't persist transient dirty flags — files are re-read on restore.
      // Pane trees persist so terminal splits survive restart (PTYs respawn).
      mainTabs: t.mainTabs.map((m) => ({
        id: m.id,
        kind: m.kind,
        title: m.title,
        relPath: m.relPath,
        paneTree: m.paneTree,
        activePaneId: m.activePaneId,
        // A "Claude" tab re-runs its command when restored terminals respawn.
        initialCommands: m.initialCommands,
        // Browser tabs restore at their last URL.
        url: m.url,
      })),
      activeMainTabId: t.activeMainTabId,
    })),
    activeProjectId,
  };
  try {
    persist.setItem(KEY, JSON.stringify(session));
  } catch {
    /* storage full or unavailable; non-fatal */
  }
}
