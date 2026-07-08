import type { ContentItem, ProjectTab } from "@/types";
import {
  addTab,
  findLeaf,
  findPaneOfContent,
  firstLeafId,
  leafNode,
  moveContentToPane,
  removeContent,
  setActiveTab,
  setSizes,
  splitPaneWithContent,
  type DropSide,
} from "@/lib/paneTree";

/**
 * Higher-level edits over a project's content map + pane tree. Each returns a
 * new ProjectTab (or the same reference when nothing changes), keeping the
 * reducers in App.tsx thin.
 */

/** The pane a new content should open into: the focused one, else the first. */
function targetPane(p: ProjectTab, preferred?: string | null): string | null {
  if (!p.root) return null;
  if (preferred && findLeaf(p.root, preferred)) return preferred;
  if (p.activePaneId && findLeaf(p.root, p.activePaneId)) return p.activePaneId;
  return firstLeafId(p.root);
}

/** Add a content item, opening it as a tab in `paneId` (default: focused pane). */
export function openContent(
  p: ProjectTab,
  item: ContentItem,
  paneId?: string | null,
): ProjectTab {
  const contents = { ...p.contents, [item.id]: item };
  if (!p.root) {
    const pane = leafNode([item.id], item.id);
    return { ...p, contents, root: pane, activePaneId: pane.id };
  }
  const target = targetPane(p, paneId)!;
  return {
    ...p,
    contents,
    root: addTab(p.root, target, item.id),
    activePaneId: target,
  };
}

/** Focus and show an already-open content (used for "one per project" tabs). */
export function revealContent(p: ProjectTab, contentId: string): ProjectTab {
  if (!p.root) return p;
  const pane = findPaneOfContent(p.root, contentId);
  if (!pane) return p;
  return {
    ...p,
    root: setActiveTab(p.root, pane.id, contentId),
    activePaneId: pane.id,
  };
}

/** The already-open content of a given kind, if any (git/notes/search are singletons). */
export function findContentByKind(
  p: ProjectTab,
  kind: ContentItem["kind"],
): ContentItem | undefined {
  return Object.values(p.contents).find((c) => c.kind === kind);
}

export function closeContent(p: ProjectTab, contentId: string): ProjectTab {
  if (!p.root || !p.contents[contentId]) return p;
  const { root, collapsedPaneId } = removeContent(p.root, contentId);
  const contents = { ...p.contents };
  delete contents[contentId];
  if (!root) return { ...p, contents, root: null, activePaneId: null };
  let activePaneId = p.activePaneId;
  if (!activePaneId || !findLeaf(root, activePaneId) || collapsedPaneId === activePaneId) {
    activePaneId = firstLeafId(root);
  }
  return { ...p, contents, root, activePaneId };
}

export function selectTab(
  p: ProjectTab,
  paneId: string,
  contentId: string,
): ProjectTab {
  if (!p.root) return p;
  return {
    ...p,
    root: setActiveTab(p.root, paneId, contentId),
    activePaneId: paneId,
  };
}

export function focusPane(p: ProjectTab, paneId: string): ProjectTab {
  if (p.activePaneId === paneId || !p.root || !findLeaf(p.root, paneId)) return p;
  return { ...p, activePaneId: paneId };
}

export function moveTab(
  p: ProjectTab,
  contentId: string,
  targetPaneId: string,
  index?: number,
): ProjectTab {
  if (!p.root) return p;
  const root = moveContentToPane(p.root, contentId, targetPaneId, index);
  const pane = findPaneOfContent(root, contentId);
  return { ...p, root, activePaneId: pane?.id ?? p.activePaneId };
}

/** Create a brand-new content alone in a new pane split off `targetPaneId`. */
export function splitNewContent(
  p: ProjectTab,
  targetPaneId: string,
  item: ContentItem,
  side: DropSide,
): ProjectTab {
  if (!p.root) return openContent(p, item);
  const contents = { ...p.contents, [item.id]: item };
  const root = splitPaneWithContent(p.root, targetPaneId, item.id, side);
  const pane = findPaneOfContent(root, item.id);
  return { ...p, contents, root, activePaneId: pane?.id ?? p.activePaneId };
}

export function splitWith(
  p: ProjectTab,
  targetPaneId: string,
  contentId: string,
  side: DropSide,
): ProjectTab {
  if (!p.root) return p;
  const root = splitPaneWithContent(p.root, targetPaneId, contentId, side);
  if (root === p.root) return p;
  const pane = findPaneOfContent(root, contentId);
  return { ...p, root, activePaneId: pane?.id ?? p.activePaneId };
}

export function resizeSplit(
  p: ProjectTab,
  splitId: string,
  sizes: number[],
): ProjectTab {
  if (!p.root) return p;
  return { ...p, root: setSizes(p.root, splitId, sizes) };
}

/** Patch a single content item's fields (title, url, dirty, attention…). */
export function patchContent(
  p: ProjectTab,
  contentId: string,
  patch: Partial<ContentItem>,
): ProjectTab {
  const existing = p.contents[contentId];
  if (!existing) return p;
  return { ...p, contents: { ...p.contents, [contentId]: { ...existing, ...patch } } };
}
