import type { PaneNode } from "@/types";

export function newPaneId(): string {
  return crypto.randomUUID();
}

export function newContentId(): string {
  return crypto.randomUUID();
}

/** A fresh leaf pane holding `tabs`, active on the first (or given) tab. */
export function leafNode(
  tabs: string[] = [],
  activeTabId: string | null = tabs[0] ?? null,
  id: string = newPaneId(),
): PaneNode {
  return { type: "leaf", id, tabs, activeTabId };
}

/** Side a drop lands on, mapped to a split direction + insertion order. */
export type DropSide = "left" | "right" | "up" | "down";

// --- Traversal ---

export function firstLeafId(node: PaneNode): string {
  return node.type === "leaf" ? node.id : firstLeafId(node.children[0]);
}

/** The leaf with the given pane id, or null. */
export function findLeaf(
  node: PaneNode,
  paneId: string,
): Extract<PaneNode, { type: "leaf" }> | null {
  if (node.type === "leaf") return node.id === paneId ? node : null;
  for (const c of node.children) {
    const found = findLeaf(c, paneId);
    if (found) return found;
  }
  return null;
}

/** The leaf pane whose tabs include `contentId`, or null. */
export function findPaneOfContent(
  node: PaneNode,
  contentId: string,
): Extract<PaneNode, { type: "leaf" }> | null {
  if (node.type === "leaf") {
    return node.tabs.includes(contentId) ? node : null;
  }
  for (const c of node.children) {
    const found = findPaneOfContent(c, contentId);
    if (found) return found;
  }
  return null;
}

/** The currently-shown content id of every pane (its active tab). */
export function visibleContentIds(node: PaneNode): string[] {
  if (node.type === "leaf") return node.activeTabId ? [node.activeTabId] : [];
  return node.children.flatMap(visibleContentIds);
}

// --- Structural edits (all return a new tree) ---

/** Map every leaf, rebuilding split nodes around the results. */
function mapLeaves(
  node: PaneNode,
  fn: (leaf: Extract<PaneNode, { type: "leaf" }>) => PaneNode,
): PaneNode {
  if (node.type === "leaf") return fn(node);
  return { ...node, children: node.children.map((c) => mapLeaves(c, fn)) };
}

/** Set which tab is active in a pane. */
export function setActiveTab(
  node: PaneNode,
  paneId: string,
  contentId: string,
): PaneNode {
  return mapLeaves(node, (leaf) =>
    leaf.id === paneId && leaf.tabs.includes(contentId)
      ? { ...leaf, activeTabId: contentId }
      : leaf,
  );
}

/** Add a content id as a tab in a pane (optionally at `index`), activating it. */
export function addTab(
  node: PaneNode,
  paneId: string,
  contentId: string,
  index?: number,
): PaneNode {
  return mapLeaves(node, (leaf) => {
    if (leaf.id !== paneId || leaf.tabs.includes(contentId)) return leaf;
    const tabs = [...leaf.tabs];
    tabs.splice(index ?? tabs.length, 0, contentId);
    return { ...leaf, tabs, activeTabId: contentId };
  });
}

/**
 * Remove a content id from whichever pane holds it. If that empties the pane,
 * the pane is dropped and single-child splits collapse. Returns the new tree
 * (null if the whole tree emptied) plus the id of a pane that was removed, so
 * callers can move focus off it.
 */
export function removeContent(
  node: PaneNode,
  contentId: string,
): { root: PaneNode | null; collapsedPaneId: string | null } {
  const pane = findPaneOfContent(node, contentId);
  if (!pane) return { root: node, collapsedPaneId: null };

  const tabs = pane.tabs.filter((t) => t !== contentId);
  if (tabs.length > 0) {
    // Pane survives — just drop the tab and pick a neighbour as active.
    const nextActive =
      pane.activeTabId === contentId
        ? (tabs[Math.min(pane.tabs.indexOf(contentId), tabs.length - 1)] ??
          tabs[0])
        : pane.activeTabId;
    const root = mapLeaves(node, (leaf) =>
      leaf.id === pane.id ? { ...leaf, tabs, activeTabId: nextActive } : leaf,
    );
    return { root, collapsedPaneId: null };
  }
  // Pane emptied — remove the leaf and collapse.
  return { root: removeLeaf(node, pane.id), collapsedPaneId: pane.id };
}

/** Remove a leaf by pane id, collapsing single-child splits. Null if empty. */
export function removeLeaf(
  node: PaneNode,
  paneId: string,
): PaneNode | null {
  if (node.type === "leaf") return node.id === paneId ? null : node;
  const kept: { child: PaneNode; size: number }[] = [];
  node.children.forEach((c, i) => {
    const mapped = removeLeaf(c, paneId);
    if (mapped !== null) kept.push({ child: mapped, size: node.sizes[i] ?? 1 });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].child;
  return {
    ...node,
    children: kept.map((k) => k.child),
    sizes: kept.map((k) => k.size),
  };
}

/** Move a content id into `targetPaneId` (optionally at `index`). Handles the
 * same-pane reorder case and collapses the source pane if it empties. */
export function moveContentToPane(
  node: PaneNode,
  contentId: string,
  targetPaneId: string,
  index?: number,
): PaneNode {
  const source = findPaneOfContent(node, contentId);
  if (!source) return node;

  // Reorder within the same pane.
  if (source.id === targetPaneId) {
    return mapLeaves(node, (leaf) => {
      if (leaf.id !== targetPaneId) return leaf;
      const without = leaf.tabs.filter((t) => t !== contentId);
      const at = index ?? without.length;
      without.splice(at, 0, contentId);
      return { ...leaf, tabs: without, activeTabId: contentId };
    });
  }

  const removed = removeContent(node, contentId);
  if (!removed.root) return node;
  return addTab(removed.root, targetPaneId, contentId, index);
}

/** Split `targetPaneId`, placing `contentId` alone in a new pane on `side`.
 * The content is first removed from its current pane (which may collapse). A
 * no-op when it would just move a lone tab onto its own pane's edge. */
export function splitPaneWithContent(
  node: PaneNode,
  targetPaneId: string,
  contentId: string,
  side: DropSide,
): PaneNode {
  const source = findPaneOfContent(node, contentId);
  const target = findLeaf(node, targetPaneId);
  if (!target) return node;
  // Dragging the sole tab of a pane onto that same pane's edge changes nothing.
  if (source && source.id === targetPaneId && source.tabs.length === 1) {
    return node;
  }

  const removed = source ? removeContent(node, contentId) : { root: node };
  const base = removed.root;
  if (!base) return node;

  const newLeaf = leafNode([contentId], contentId);
  const direction = side === "left" || side === "right" ? "row" : "column";
  const newFirst = side === "left" || side === "up";

  return mapLeaves(base, (leaf) => {
    if (leaf.id !== targetPaneId) return leaf;
    return {
      type: "split",
      id: newPaneId(),
      direction,
      children: newFirst ? [newLeaf, leaf] : [leaf, newLeaf],
      sizes: [50, 50],
    };
  });
}

/** Update a split node's size ratios. */
export function setSizes(
  node: PaneNode,
  splitId: string,
  sizes: number[],
): PaneNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) return { ...node, sizes };
  return {
    ...node,
    children: node.children.map((c) => setSizes(c, splitId, sizes)),
  };
}

// --- Layout (percentages within the container) ---

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LeafBox {
  /** Pane (leaf) id. */
  id: string;
  rect: Rect;
}

export interface DividerBox {
  splitId: string;
  index: number;
  direction: "row" | "column";
  sizes: number[];
  rect: Rect;
  /** The split node's own rect (for px<->ratio conversion while dragging). */
  splitRect: Rect;
}

export function computeLayout(
  node: PaneNode,
  rect: Rect = { left: 0, top: 0, width: 100, height: 100 },
  leaves: LeafBox[] = [],
  dividers: DividerBox[] = [],
): { leaves: LeafBox[]; dividers: DividerBox[] } {
  if (node.type === "leaf") {
    leaves.push({ id: node.id, rect });
    return { leaves, dividers };
  }
  const total =
    node.sizes.reduce((a, b) => a + b, 0) || node.children.length || 1;
  const isRow = node.direction === "row";
  let offset = isRow ? rect.left : rect.top;
  node.children.forEach((child, i) => {
    const frac = (node.sizes[i] ?? total / node.children.length) / total;
    const span = (isRow ? rect.width : rect.height) * frac;
    const childRect: Rect = isRow
      ? { left: offset, top: rect.top, width: span, height: rect.height }
      : { left: rect.left, top: offset, width: rect.width, height: span };
    computeLayout(child, childRect, leaves, dividers);
    offset += span;
    if (i < node.children.length - 1) {
      dividers.push({
        splitId: node.id,
        index: i,
        direction: node.direction,
        sizes: node.sizes,
        rect: isRow
          ? { left: offset, top: rect.top, width: 0, height: rect.height }
          : { left: rect.left, top: offset, width: rect.width, height: 0 },
        splitRect: rect,
      });
    }
  });
  return { leaves, dividers };
}
