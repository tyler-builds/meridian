import { useSyncExternalStore } from "react";

/**
 * A tiny global store tracking whether native overlay surfaces (embedded
 * browser webviews) are free to show, or whether a DOM overlay is currently
 * painted over the content area.
 *
 * Native child webviews are OS surfaces that ignore DOM z-index — they always
 * paint on top of the HTML. So whenever a DOM overlay (Settings dialog, file
 * finder, etc.) opens over the content region, the webview must be hidden or it
 * would cover the overlay. Overlays register themselves here by key; a browser
 * panel shows its webview only while no obstruction is active.
 */

const obstructions = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Register/clear a named obstruction (idempotent per key). */
export function setObstruction(key: string, active: boolean): void {
  const had = obstructions.has(key);
  if (active === had) return;
  if (active) obstructions.add(key);
  else obstructions.delete(key);
  emit();
}

/** True when nothing is obstructing the content area. */
export function isSurfaceClear(): boolean {
  return obstructions.size === 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe a component to the "is the content area clear" signal. */
export function useSurfaceClear(): boolean {
  return useSyncExternalStore(subscribe, isSurfaceClear, isSurfaceClear);
}
