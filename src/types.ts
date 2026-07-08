/**
 * A node in a project's split layout. Splits are recursive containers (a binary
 * tree, like tmux/iTerm/VS Code editor groups). Leaves are *pane groups*: each
 * holds an ordered list of content ids (its tabs) and which one is showing.
 *
 * The tree owns only layout — it never owns content lifecycle. The living
 * content (a terminal's PTY, a browser's webview, a Monaco editor) is a
 * `ContentItem` mounted exactly once at the project level and positioned by the
 * rect this tree computes for its pane. Moving a content id between panes (a
 * drag) is therefore a pure tree edit and never remounts the content.
 */
export type PaneNode =
  | {
      type: "leaf";
      /** Stable pane id. */
      id: string;
      /** Content ids shown as tabs in this pane, in tab order. */
      tabs: string[];
      /** The visible tab, or null for an (transient) empty pane. */
      activeTabId: string | null;
    }
  | {
      type: "split";
      id: string;
      direction: "row" | "column";
      children: PaneNode[];
      /** Size ratios per child (sum is arbitrary; normalized at layout). */
      sizes: number[];
    };

/** The kind of content a tab hosts. */
export type ContentKind =
  | "terminal"
  | "file"
  | "browser"
  | "git"
  | "notes"
  | "search";

/**
 * A living, mountable unit of content — one terminal, one file editor, one
 * browser, etc. Mounted once per project and positioned into whichever pane
 * currently holds it. This is the unit a tab represents.
 */
export interface ContentItem {
  /** Stable id; also the tab id in a pane's `tabs`, and the terminal registry key. */
  id: string;
  kind: ContentKind;
  /** Display name shown on the tab. */
  title: string;
  /** For file content: path relative to the project root (POSIX). */
  relPath?: string;
  /** For file content: unsaved changes in the editor. Ephemeral — not persisted. */
  dirty?: boolean;
  /**
   * For terminal content: Claude (in this terminal) finished its turn or is
   * awaiting input while this tab wasn't being viewed. Shown as a dot on the tab
   * and cleared when viewed. Ephemeral — not persisted.
   */
  attention?: boolean;
  /**
   * For terminal content: a command to run once when the terminal first spawns
   * (e.g. a "Claude" tab runs `claude`). Persisted so a restored terminal
   * re-runs it when its PTY respawns.
   */
  initialCommand?: string;
  /** For browser content: the current URL (persisted so it restores on launch). */
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
  /** Every open content unit in this project, keyed by content id. */
  contents: Record<string, ContentItem>;
  /** The split layout, or null when nothing is open (empty state). */
  root: PaneNode | null;
  /** The focused pane (leaf id), or null when nothing is open. */
  activePaneId: string | null;
}
