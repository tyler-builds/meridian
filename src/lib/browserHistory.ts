import { persist } from "@/lib/persist";

const KEY = "meridian.browserHistory";
const MAX_ENTRIES = 200;

/** Load the visited-URL list, most-recent-first. */
function load(): string[] {
  try {
    const raw = persist.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Record a navigated URL for address-bar suggestions. The list is shared across
 * all browser tabs and persists across restarts. Blank/internal pages are
 * ignored, and re-visiting a URL moves it to the front (most recent).
 */
export function recordUrl(url: string): void {
  const u = url.trim();
  if (!u || u === "about:blank" || u.startsWith("about:")) return;
  try {
    const list = load().filter((existing) => existing !== u);
    list.unshift(u);
    persist.setItem(KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage full or unavailable; suggestions are non-essential */
  }
}

/**
 * Suggest previously-visited URLs matching `query` (case-insensitive substring),
 * most-recent-first. An empty query returns the most recent entries.
 */
export function suggestUrls(query: string, limit = 6): string[] {
  const q = query.trim().toLowerCase();
  const list = load();
  const matches = q
    ? list.filter((u) => u.toLowerCase().includes(q) && u.toLowerCase() !== q)
    : list;
  return matches.slice(0, limit);
}
