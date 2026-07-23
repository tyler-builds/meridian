import type { ContentItem, PaneNode, ProjectTab } from "@/types";
import { persist } from "@/lib/persist";
import { firstLeafId, leafNode } from "@/lib/paneTree";

const KEY = "meridian.session";

export interface PersistedProject {
  id: string;
  name: string;
  path: string;
  /** True for a folder-less scratch workspace (no file tree / Git / Search). */
  scratch?: boolean;
  /** Content units, as an array for stable JSON. */
  contents: ContentItem[];
  /** The split layout, or null when nothing is open. */
  root: PaneNode | null;
  activePaneId: string | null;
}

export interface PersistedSession {
  projects: PersistedProject[];
  activeProjectId: string | null;
}

// --- Legacy shape (pre content-host model) --------------------------------

type OldPaneNode =
  | { type: "leaf"; id: string }
  | {
      type: "split";
      id: string;
      direction: "row" | "column";
      children: OldPaneNode[];
      sizes: number[];
    };

interface OldMainTab {
  id: string;
  kind: string;
  title: string;
  relPath?: string;
  paneTree?: OldPaneNode;
  activePaneId?: string;
  initialCommands?: Record<string, string>;
  url?: string;
}

interface OldProject {
  id: string;
  name: string;
  path: string;
  mainTabs?: OldMainTab[];
  activeMainTabId?: string | null;
}

function oldLeafIds(node: OldPaneNode): string[] {
  return node.type === "leaf" ? [node.id] : node.children.flatMap(oldLeafIds);
}

/**
 * Migrate a legacy project (top-level `mainTabs`, terminal-only splits) into the
 * content-host model: every tab (and every pane of a terminal tab's old split)
 * becomes a content item, all collected into a single pane. Internal terminal
 * splits aren't preserved — terminals respawn on launch anyway — so restored
 * layout simplifies to one pane, matching the old single tab strip.
 */
function migrateProject(p: OldProject): PersistedProject {
  const contents: ContentItem[] = [];
  const tabOrder: string[] = [];
  let activeTabId: string | null = null;

  for (const tab of p.mainTabs ?? []) {
    const kind = tab.kind === "diff" ? "git" : tab.kind;
    const title =
      tab.kind === "diff" && tab.title === "Diff" ? "Git" : tab.title;

    if (kind === "terminal" && tab.paneTree) {
      const leaves = oldLeafIds(tab.paneTree);
      leaves.forEach((leafId, i) => {
        const id = crypto.randomUUID();
        contents.push({
          id,
          kind: "terminal",
          title: leaves.length > 1 && i > 0 ? `${title} ${i + 1}` : title,
          initialCommand: tab.initialCommands?.[leafId],
        });
        tabOrder.push(id);
        if (tab.id === p.activeMainTabId && i === 0) activeTabId = id;
      });
    } else {
      const id = crypto.randomUUID();
      contents.push({
        id,
        kind: kind as ContentItem["kind"],
        title,
        relPath: tab.relPath,
        url: tab.url,
        // A terminal tab with no paneTree still carries its launch command
        // (e.g. an old Claude tab) — keep it so it re-runs on respawn.
        initialCommand:
          kind === "terminal" && tab.initialCommands
            ? Object.values(tab.initialCommands)[0]
            : undefined,
      });
      tabOrder.push(id);
      if (tab.id === p.activeMainTabId) activeTabId = id;
    }
  }

  const root =
    tabOrder.length > 0 ? leafNode(tabOrder, activeTabId ?? tabOrder[0]) : null;
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    contents,
    root,
    activePaneId: root ? firstLeafId(root) : null,
  };
}

/** Load the persisted workspace, or null if none/corrupt. */
export function loadSession(): PersistedSession | null {
  try {
    const raw = persist.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      projects?: (PersistedProject & OldProject)[];
      activeProjectId?: string | null;
    };
    if (!Array.isArray(parsed.projects)) return null;

    const projects: PersistedProject[] = parsed.projects.map((p) =>
      Array.isArray(p.contents) && "root" in p
        ? {
            id: p.id,
            name: p.name,
            path: p.path,
            scratch: p.scratch,
            contents: p.contents,
            root: p.root ?? null,
            activePaneId: p.activePaneId ?? null,
          }
        : migrateProject(p),
    );
    return { projects, activeProjectId: parsed.activeProjectId ?? null };
  } catch {
    return null;
  }
}

/** Persist the open projects, their content + layout, and active selections. */
export function saveSession(
  tabs: ProjectTab[],
  activeProjectId: string | null,
): void {
  const session: PersistedSession = {
    projects: tabs.map((t) => ({
      id: t.id,
      name: t.name,
      path: t.path,
      scratch: t.scratch,
      // Strip transient flags — files are re-read and Claude attention is
      // recomputed on restore.
      contents: Object.values(t.contents).map((c) => ({
        id: c.id,
        kind: c.kind,
        title: c.title,
        relPath: c.relPath,
        url: c.url,
        initialCommand: c.initialCommand,
      })),
      root: t.root,
      activePaneId: t.activePaneId,
    })),
    activeProjectId,
  };
  try {
    persist.setItem(KEY, JSON.stringify(session));
  } catch {
    /* storage full or unavailable; non-fatal */
  }
}
