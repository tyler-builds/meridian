/**
 * A node in a terminal tab's split layout. Leaves are terminals; splits are
 * recursive containers (a binary tree, like tmux/iTerm/VS Code).
 */
export type PaneNode =
  | { type: "leaf"; id: string }
  | {
      type: "split";
      id: string;
      direction: "row" | "column";
      children: PaneNode[];
      /** Size ratios per child (sum is arbitrary; normalized at layout). */
      sizes: number[];
    };

/** A tab inside a project's main panel. */
export interface MainTab {
  id: string;
  kind: "terminal" | "file" | "browser" | "git" | "notes";
  title: string;
  /** For file tabs: path relative to the project root (POSIX). */
  relPath?: string;
  /** For file tabs: unsaved changes in the editor. */
  dirty?: boolean;
  /**
   * For terminal tabs: Claude (in one of this tab's panes) finished its turn or
   * is awaiting input while this tab wasn't the one being viewed. Shown as a dot
   * on the tab and cleared when the tab is viewed. Ephemeral — not persisted.
   */
  attention?: boolean;
  /** For terminal tabs: the split layout tree. */
  paneTree?: PaneNode;
  /** For terminal tabs: the focused terminal pane. */
  activePaneId?: string;
  /**
   * For terminal tabs: a command to run once in a pane when it first spawns,
   * keyed by pane id (e.g. a "Claude" tab runs `claude`). Only the pane(s)
   * present at creation get a command; panes added later by splitting don't.
   */
  initialCommands?: Record<string, string>;
  /** For browser tabs: the current URL (persisted so it restores on launch). */
  url?: string;
}

export interface ProjectTab {
  /** Stable client-side id for the tab. */
  id: string;
  /** Display name (folder basename). */
  name: string;
  /** Absolute path to the project root. */
  path: string;
  /** Detected project favicon as a data URL, shown in the tab. */
  favicon?: string | null;
  /** Relative POSIX file paths for the tree, once loaded. */
  paths: string[];
  loading: boolean;
  error?: string;
  /** Tabs open in the main panel (terminals + files). */
  mainTabs: MainTab[];
  /** Active main-panel tab, or null when none are open (empty state). */
  activeMainTabId: string | null;
}
