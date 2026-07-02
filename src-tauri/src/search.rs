//! Full-repo content search powering the Search tab.
//!
//! Built on ripgrep's own library crates: `grep` (regex matcher + line
//! searcher) and `ignore` (gitignore-aware parallel walker). Searching runs
//! in-process — no bundled binary, no stdout parsing — and returns structured
//! matches with per-line span offsets the frontend highlights directly.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

use grep::matcher::Matcher;
use grep::regex::RegexMatcherBuilder;
use grep::searcher::{sinks::UTF8, BinaryDetection, SearcherBuilder};
use ignore::overrides::OverrideBuilder;
use ignore::{WalkBuilder, WalkState};

/// Hard cap on returned matches: keeps the IPC payload and the results list
/// bounded on degenerate queries (e.g. `.` as a regex). The UI shows a
/// "results truncated" notice when hit.
const MAX_MATCHES: usize = 2000;
/// Skip files larger than this — matches in giant lockfiles/bundles are noise
/// and walking them dominates search time.
const MAX_FILESIZE: u64 = 10 * 1024 * 1024;
/// Longest line (in chars) shipped to the UI; longer lines are windowed around
/// the first match so minified bundles can't blow up the results list.
const MAX_LINE_CHARS: usize = 400;

/// One matching line. `spans` are [start, end) offsets into `text` in UTF-16
/// code units (JavaScript string indexing), one per match on the line.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// Path relative to the search root, POSIX separators.
    path: String,
    /// 1-based line number.
    line: u64,
    text: String,
    spans: Vec<[u32; 2]>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    matches: Vec<SearchMatch>,
    /// Number of distinct files with at least one match.
    files: u32,
    /// True when the match cap was hit — more results exist on disk.
    truncated: bool,
}

/// Search `root` for `query`. `regex:false` treats the query as a literal.
/// `include`/`exclude` are comma-separated globs relative to the root (VS Code
/// semantics: a non-empty include list restricts the search to matching paths).
/// Async + spawn_blocking: the walk saturates all cores and can take a while on
/// cold caches — never on the main thread.
#[tauri::command]
pub async fn search_project(
    root: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
    include: String,
    exclude: String,
) -> Result<SearchResults, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_search(&root, &query, regex, case_sensitive, &include, &exclude)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_search(
    root: &str,
    query: &str,
    regex: bool,
    case_sensitive: bool,
    include: &str,
    exclude: &str,
) -> Result<SearchResults, String> {
    if query.is_empty() {
        return Ok(SearchResults {
            matches: Vec::new(),
            files: 0,
            truncated: false,
        });
    }
    if !Path::new(root).is_dir() {
        return Err(format!("Not a directory: {root}"));
    }

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive)
        .fixed_strings(!regex)
        .build(query)
        .map_err(|e| format!("Invalid regular expression: {e}"))?;

    // Include/exclude via override globs. With any include present the
    // overrides act as a whitelist (VS Code's "files to include"); excludes are
    // the same globs negated. `.git` is excluded explicitly because the walker
    // is run with hidden files enabled (dotfiles are legitimate search targets).
    let mut ob = OverrideBuilder::new(root);
    ob.add("!**/.git/**").map_err(|e| e.to_string())?;
    for glob in split_globs(include) {
        ob.add(&glob)
            .map_err(|e| format!("Invalid include pattern: {e}"))?;
    }
    for glob in split_globs(exclude) {
        ob.add(&format!("!{glob}"))
            .map_err(|e| format!("Invalid exclude pattern: {e}"))?;
    }
    let overrides = ob.build().map_err(|e| e.to_string())?;

    let collected: Mutex<Vec<SearchMatch>> = Mutex::new(Vec::new());
    let files_with_matches = AtomicU32::new(0);
    let capped = AtomicBool::new(false);
    let root_path = Path::new(root);

    WalkBuilder::new(root)
        .overrides(overrides)
        .hidden(false)
        .max_filesize(Some(MAX_FILESIZE))
        .build_parallel()
        .run(|| {
            let matcher = &matcher;
            let collected = &collected;
            let files_with_matches = &files_with_matches;
            let capped = &capped;
            let mut searcher = SearcherBuilder::new()
                .line_number(true)
                .binary_detection(BinaryDetection::quit(0))
                .build();
            Box::new(move |entry| {
                if capped.load(Ordering::Relaxed) {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                let rel = entry
                    .path()
                    .strip_prefix(root_path)
                    .unwrap_or(entry.path())
                    .to_string_lossy()
                    .replace('\\', "/");

                let mut file_matches: Vec<SearchMatch> = Vec::new();
                let result = searcher.search_path(
                    matcher,
                    entry.path(),
                    UTF8(|line_number, line| {
                        let text = line.trim_end_matches(['\r', '\n']);
                        let mut byte_spans: Vec<(usize, usize)> = Vec::new();
                        // Errors from find_iter are regex-engine internals that
                        // can't occur for a compiled pattern; treat as no match.
                        let _ = matcher.find_iter(text.as_bytes(), |m| {
                            byte_spans.push((m.start(), m.end()));
                            true
                        });
                        // Note: a match that only spans the line terminator
                        // (e.g. a regex ending in `\n`) re-tests false on the
                        // trimmed text — the line is still kept, with no spans.
                        let (text, spans) = window_line(text, &byte_spans);
                        file_matches.push(SearchMatch {
                            path: rel.clone(),
                            line: line_number,
                            text,
                            spans,
                        });
                        // Stop reading this file once it alone could fill the
                        // remaining budget; the global cap is enforced below.
                        Ok(file_matches.len() < MAX_MATCHES)
                    }),
                );
                if result.is_err() || file_matches.is_empty() {
                    // Unreadable file or no matches — either way, move on.
                    return WalkState::Continue;
                }

                files_with_matches.fetch_add(1, Ordering::Relaxed);
                let mut guard = collected.lock().unwrap();
                let remaining = MAX_MATCHES.saturating_sub(guard.len());
                if file_matches.len() >= remaining {
                    file_matches.truncate(remaining);
                    capped.store(true, Ordering::Relaxed);
                }
                let quit = capped.load(Ordering::Relaxed);
                guard.extend(file_matches);
                drop(guard);
                if quit {
                    WalkState::Quit
                } else {
                    WalkState::Continue
                }
            })
        });

    let mut matches = collected.into_inner().unwrap();
    // The parallel walk returns files in nondeterministic order; sort for a
    // stable UI (per-file line order is already ascending from the searcher).
    matches.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    Ok(SearchResults {
        files: files_with_matches.load(Ordering::Relaxed),
        truncated: capped.load(Ordering::Relaxed),
        matches,
    })
}

/// Split a comma-separated glob list, trimming blanks.
fn split_globs(input: &str) -> Vec<String> {
    input
        .split(',')
        .map(str::trim)
        .filter(|g| !g.is_empty())
        .map(str::to_string)
        .collect()
}

/// Clamp a matched line to `MAX_LINE_CHARS`, windowing around the first match
/// so it stays visible (minified JS can put a match a megabyte into the line).
/// Returns the display text and the byte spans converted to UTF-16 offsets
/// into it; spans outside the window are dropped.
fn window_line(text: &str, byte_spans: &[(usize, usize)]) -> (String, Vec<[u32; 2]>) {
    let char_count = text.chars().count();
    let (window_start, windowed): (usize, String) = if char_count <= MAX_LINE_CHARS {
        (0, text.to_string())
    } else {
        // Start the window ~80 chars before the first match (or at 0).
        let first_byte = byte_spans.first().map(|s| s.0).unwrap_or(0);
        let first_char = text[..first_byte].chars().count();
        let start_char = first_char.saturating_sub(80);
        let start_byte = char_to_byte(text, start_char);
        let end_char = (start_char + MAX_LINE_CHARS).min(char_count);
        let end_byte = char_to_byte(text, end_char);
        (start_byte, text[start_byte..end_byte].to_string())
    };

    let window_end = window_start + windowed.len();
    let spans = byte_spans
        .iter()
        .filter(|(s, e)| *s >= window_start && *e <= window_end)
        .filter_map(|(s, e)| {
            let (s, e) = (s - window_start, e - window_start);
            if !windowed.is_char_boundary(s) || !windowed.is_char_boundary(e) {
                return None;
            }
            Some([utf16_offset(&windowed, s), utf16_offset(&windowed, e)])
        })
        .collect();
    (windowed, spans)
}

/// Byte index of the `n`-th char (or the string's end).
fn char_to_byte(s: &str, n: usize) -> usize {
    s.char_indices().nth(n).map(|(i, _)| i).unwrap_or(s.len())
}

/// UTF-16 code-unit offset (JS string index) of byte offset `byte` in `s`.
fn utf16_offset(s: &str, byte: usize) -> u32 {
    s[..byte].encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::run_search;

    /// The crate root is a real project this test can search.
    fn root() -> &'static str {
        env!("CARGO_MANIFEST_DIR")
    }

    #[test]
    fn literal_search_finds_this_file() {
        let r = run_search(root(), "fn window_line", false, true, "", "").unwrap();
        assert!(r.matches.iter().any(|m| m.path == "src/search.rs"));
        assert!(r.files >= 1);
        // Spans must actually cover the query text.
        let m = r
            .matches
            .iter()
            .find(|m| m.path == "src/search.rs" && !m.spans.is_empty())
            .unwrap();
        let [s, e] = m.spans[0];
        let hit: String = m
            .text
            .encode_utf16()
            .skip(s as usize)
            .take((e - s) as usize)
            .map(|u| char::from_u32(u as u32).unwrap())
            .collect();
        assert_eq!(hit, "fn window_line");
    }

    #[test]
    fn include_glob_restricts_results() {
        let r = run_search(root(), "fn ", false, true, "*.toml", "").unwrap();
        assert!(r.matches.iter().all(|m| m.path.ends_with(".toml")));
    }

    #[test]
    fn regex_and_case_modes() {
        let re = run_search(root(), r"fn\s+window_line", true, true, "", "").unwrap();
        assert!(re.matches.iter().any(|m| m.path == "src/search.rs"));
        // Literal mode must not treat the pattern as regex.
        let lit = run_search(root(), r"fn\s+window_line", false, true, "", "").unwrap();
        assert!(lit.matches.iter().all(|m| m.path == "src/search.rs")); // only this test file mentions it
        // The uppercased form of `fn window_line`: case-insensitively it
        // matches the real code above; case-sensitively it matches nothing.
        // Built from parts (and not written out here) so the uppercase text
        // doesn't appear verbatim in this file — the search runs over this
        // crate, test sources included.
        let upper = format!("{}{}", "FN WINDOW", "_LINE");
        let insensitive = run_search(root(), &upper, false, false, "", "").unwrap();
        assert!(insensitive.matches.iter().any(|m| m.path == "src/search.rs"));
        let sensitive = run_search(root(), &upper, false, true, "", "").unwrap();
        assert!(sensitive.matches.is_empty());
        let bad = run_search(root(), "([unclosed", true, true, "", "");
        assert!(bad.is_err());
    }
}
