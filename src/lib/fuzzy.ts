export interface FuzzyMatch {
  /** Score; higher is better. */
  score: number;
  /** Indices in the target string that matched the query. */
  matches: number[];
}

const SEPARATOR = /[/\\._\- ]/;

function isWordStart(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1];
  if (SEPARATOR.test(prev)) return true;
  // camelCase boundary: lower/digit followed by upper.
  return prev === prev.toLowerCase() && target[i] !== target[i].toLowerCase();
}

/**
 * Subsequence fuzzy match with VS Code-ish scoring: rewards consecutive runs,
 * word/segment starts (after / _ - . or camelCase), and matches in the
 * basename. Returns null if the query isn't a subsequence of the target.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, matches: [] };

  const lower = target.toLowerCase();
  const lastSlash = target.lastIndexOf("/");
  const matches: number[] = [];
  let qi = 0;
  let score = 0;
  let prevMatch = -2;

  for (let ti = 0; ti < target.length && qi < q.length; ti++) {
    if (lower[ti] !== q[qi]) continue;
    let s = 1;
    if (ti === prevMatch + 1) s += 6; // consecutive
    if (isWordStart(target, ti)) s += 9; // segment / camelCase boundary
    if (ti > lastSlash) s += 4; // inside the basename
    if (ti === lastSlash + 1) s += 6; // first char of the basename
    score += s;
    matches.push(ti);
    prevMatch = ti;
    qi++;
  }

  if (qi < q.length) return null; // not all query chars matched
  score -= target.length * 0.05; // mild preference for shorter paths
  return { score, matches };
}
