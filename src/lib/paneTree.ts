import type { PaneNode } from "@/types";

export function newPaneId(): string {
  return crypto.randomUUID();
}

export function leafNode(id: string = newPaneId()): PaneNode {
  return { type: "leaf", id };
}

export function firstLeafId(node: PaneNode): string {
  return node.type === "leaf" ? node.id : firstLeafId(node.children[0]);
}

/** Replace the target leaf with a split of [target, newLeaf]. */
export function splitLeaf(
  node: PaneNode,
  targetId: string,
  newLeafId: string,
  direction: "row" | "column",
): PaneNode {
  if (node.type === "leaf") {
    if (node.id !== targetId) return node;
    return {
      type: "split",
      id: newPaneId(),
      direction,
      children: [node, leafNode(newLeafId)],
      sizes: [50, 50],
    };
  }
  return {
    ...node,
    children: node.children.map((c) =>
      splitLeaf(c, targetId, newLeafId, direction),
    ),
  };
}

/** Remove a leaf, collapsing single-child splits. Returns null if empty. */
export function removeLeaf(node: PaneNode, targetId: string): PaneNode | null {
  if (node.type === "leaf") return node.id === targetId ? null : node;
  const mapped = node.children.map((c) => removeLeaf(c, targetId));
  const kept: { child: PaneNode; size: number }[] = [];
  mapped.forEach((c, i) => {
    if (c !== null) kept.push({ child: c, size: node.sizes[i] ?? 1 });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].child;
  return {
    ...node,
    children: kept.map((k) => k.child),
    sizes: kept.map((k) => k.size),
  };
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
