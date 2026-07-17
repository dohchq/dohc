//! Workspace search (R12): an FTS index over file text and chat messages, with
//! policy-filtered visibility, a fail-closed FILE policy, and read-your-writes
//! semantics on the single writer.
//!
//! This ports the TS `searchIndex.ts` (FTS maintenance + policy-filtered query)
//! and the pure preview slice of `workspaceSearch.ts`. The FTS tables are
//! created by the storage migration ledger (ordinal 4, `v1-search`); this module
//! is the logic that fills and reads them, composed through the storage seams
//! (`EngineStore::write_with` / `read_with`) exactly like the versioning and
//! chat domains — the connection never leaves the actor thread.
//!
//! Layers:
//! - [`policy`] — the path floor, the `.dohc/*.toml` rule parser, the
//!   effective-policy resolver, and the **fail-closed** policy reader.
//! - [`index`] — per-write FTS upserts and the durable per-version rebuild.
//! - [`query`] — the policy-filtered, `rowid`-ordered candidate query.
//!
//! ## Fail-closed, scoped to files
//!
//! A `.dohc/files.toml` / `.dohc/visibility.toml` that EXISTS but cannot be read
//! or parsed never widens search: FILE results go empty (a hidden/secret/`.dohc`
//! path can never appear), while CHAT search — which the FILE policy does not
//! govern — stays fully available. An ABSENT policy file is defaults. This is
//! the hotfix posture (`searchIndex.ts` after the fail-open→fail-closed fix),
//! preserved here verbatim.

pub mod index;
pub mod policy;
pub mod query;

pub use index::{
    delete_file_search_index, ensure_search_index_for_version, floor_of,
    upsert_chat_message_search_index, upsert_file_search_index, upsert_thread_header_search_index,
};
pub use policy::{
    DiagnosticReason, EffectivePolicy, Export, FilesPolicyRule, PathFloor, PolicyDiagnostic,
    SearchPolicySnapshot, Visibility, VisibilityPolicyRule, classify_engine_file_path,
    parse_files_policy, parse_visibility_policy, path_is_search_indexed, policy_glob_matches,
    read_engine_search_policy, resolve_effective_policy, validate_policy_glob,
};
pub use query::{
    GranularChatMessageSearchResult, SearchCandidate, query_chat_messages_granular,
    query_search_index,
};

use rusqlite::Connection;
use std::path::Path;

/// The sentinel message id for a thread's header row.
pub(crate) const THREAD_HEADER_MESSAGE_ID: &str = "__thread__";

/// Minimum query length the trigram index can serve (`MIN_TRIGRAM_QUERY_CHARS`).
pub const MIN_TRIGRAM_QUERY_CHARS: usize = 3;

/// DoS ceiling on query length — a Rust-added bound the TS engine lacks (set far
/// above any real query so normal search stays byte-identical to TS).
pub const MAX_QUERY_CHARS: usize = 4096;

/// DoS ceiling on the caller-facing result limit.
pub const MAX_RESULT_LIMIT: usize = 1000;

/// DoS ceiling on a single FTS over-fetch (the `limit * multiplier` fetch is
/// clamped to this).
pub const MAX_FTS_FETCH: usize = 20_000;

/// Default result limit when the caller supplies none (`workspaceSearch.ts`).
pub const DEFAULT_SEARCH_LIMIT: i64 = 100;

/// Preview-window width in chars (`WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS`).
pub const WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS: usize = 180;

/// Errors from the search index/query surface. Policy read failures are NOT
/// errors — they fail closed and surface as diagnostics; only storage faults and
/// fail-closed corruption are errors here.
#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    /// A rusqlite failure while maintaining or reading the index.
    #[error("search storage failure: {0}")]
    Storage(#[from] rusqlite::Error),
    /// A storage-seam failure (transaction begin/commit) surfaced when a search
    /// mutation is composed inside `EngineStore::write_with`. This `From` is what
    /// lets the index functions run in the caller's single transaction.
    #[error("search storage-core failure: {0}")]
    Store(#[from] dohc_engine_storage::StorageError),
    /// Fail-closed corrupt state (e.g. a chat thread that owns both/neither a
    /// channel and a linked file, or a channel thread whose owner is gone).
    /// Ports the chat store's `corrupt()` posture: never a silent search row.
    #[error("search index corrupt: {0}")]
    Corrupt(&'static str),
    /// A bounded scan or query exceeded its DoS ceiling — fail closed rather than
    /// build an unbounded in-flight statement stream.
    #[error("search bounds exceeded: {0}")]
    Bounds(&'static str),
}

impl SearchError {
    /// A stable diagnostic code (parity with the storage/domain error taxonomy).
    pub fn code(&self) -> &'static str {
        match self {
            SearchError::Storage(_) => "search-storage",
            SearchError::Store(_) => "search-storage-core",
            SearchError::Corrupt(_) => "search-corrupt",
            SearchError::Bounds(_) => "search-bounds",
        }
    }
}

/// The surface a search result came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchSurface {
    File,
    Chat,
}

/// One line-level search result (`WorkspaceEngineSearchResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchResult {
    pub surface: SearchSurface,
    /// The file path (file surface) or a chat locator (`chat/<thread_id>`).
    pub path: String,
    pub title: String,
    /// 1-based line number of the match within the candidate text.
    pub line: usize,
    pub preview: String,
    pub match_start: usize,
    pub match_end: usize,
    /// Present on chat results.
    pub thread_id: Option<String>,
    /// Present on file results.
    pub object_id: Option<String>,
}

/// Normalize a query the way the search entry point does: trim + lowercase.
/// Matching is case-insensitive substring, so callers pass the normalized query
/// to [`preview_line_matches`].
pub fn normalize_query(query: &str) -> String {
    query.trim().to_lowercase()
}

/// Split `text` into lines the way `workspaceSearch.ts` does: `\r\n` and a lone
/// `\r` both become `\n`, then split on `\n`.
fn split_lines(text: &str) -> Vec<&str> {
    // Do the newline canonicalization by iterating; a lone `\r` or `\r\n` ends a
    // line. Avoids allocating a normalized copy.
    let mut lines: Vec<&str> = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0usize;
    let mut idx = 0usize;
    while idx < bytes.len() {
        match bytes[idx] {
            b'\n' => {
                lines.push(&text[start..idx]);
                idx = idx.saturating_add(1);
                start = idx;
            }
            b'\r' => {
                lines.push(&text[start..idx]);
                idx = idx.saturating_add(1);
                if idx < bytes.len() && bytes[idx] == b'\n' {
                    idx = idx.saturating_add(1);
                }
                start = idx;
            }
            _ => idx = idx.saturating_add(1),
        }
    }
    lines.push(&text[start..]);
    lines
}

/// A single line's preview window (`previewForLine`). Indices are char-based
/// (Rust) rather than UTF-16 (JS); identical for ASCII/BMP text, with a small
/// known divergence in window centering for astral-plane text (the match itself
/// is always correct — the FTS differential does not depend on preview offsets).
fn preview_for_line(line: &str, match_index: usize, query_len: usize) -> (String, usize, usize) {
    let chars: Vec<char> = line.chars().collect();
    let line_len = chars.len();
    let mut window_start = 0usize;
    if line_len > WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS {
        window_start = match_index.saturating_sub(WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS / 3);
        window_start = window_start.min(line_len - WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS);
    }
    let window_end = window_start
        .saturating_add(WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS)
        .min(line_len);
    let preview: String = chars[window_start..window_end].iter().collect();
    let preview_len = window_end.saturating_sub(window_start);
    let match_start = match_index.saturating_sub(window_start).min(preview_len);
    let match_end = match_index
        .saturating_add(query_len)
        .saturating_sub(window_start)
        .min(preview_len)
        .max(match_start);
    (preview, match_start, match_end)
}

/// A raw preview hit before it is wrapped in a [`SearchResult`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewMatch {
    pub line: usize,
    pub preview: String,
    pub match_start: usize,
    pub match_end: usize,
}

/// Line-level substring matches within `text` for a normalized (lowercased)
/// `query`, capped at `remaining`. Ports `textMatches` (`workspaceSearch.ts`):
/// case-insensitive per line via first-occurrence, windowed preview centered on
/// the match. Pure.
pub fn preview_line_matches(text: &str, query: &str, remaining: usize) -> Vec<PreviewMatch> {
    let mut out: Vec<PreviewMatch> = Vec::new();
    if query.is_empty() || remaining == 0 {
        return out;
    }
    let query_len = query.chars().count();
    for (index, line) in split_lines(text).into_iter().enumerate() {
        let lowered = line.to_lowercase();
        let Some(byte_idx) = lowered.find(query) else {
            continue;
        };
        // Convert the byte offset in the lowercased line to a char index. For
        // ASCII/BMP this equals the JS UTF-16 offset.
        let match_index = lowered[..byte_idx].chars().count();
        let (preview, match_start, match_end) = preview_for_line(line, match_index, query_len);
        out.push(PreviewMatch {
            line: index.saturating_add(1),
            preview,
            match_start,
            match_end,
        });
        if out.len() >= remaining {
            break;
        }
    }
    out
}

/// Ensure the index for `version_id` is built, then run `query`, returning
/// line-level results capped at `limit` (default [`DEFAULT_SEARCH_LIMIT`]). This
/// is the index-backed orchestration: file results carry inline text and are
/// previewed directly; chat results are previewed from the matching indexed
/// message/header text of each candidate thread.
///
/// This is deliberately the INDEX-backed subset of `searchWorkspaceEngine`; the
/// custom-visibility-hook and real-snapshot/projection re-read orchestration is
/// a desktop-adapter concern (R13b) that layers on top of these primitives. A
/// too-short query (under [`MIN_TRIGRAM_QUERY_CHARS`]) yields no results here
/// rather than a linear fallback.
///
/// MUST be called on the actor's writer connection (it ensures the index inside
/// the same connection it queries) so results are read-your-writes.
pub fn search_workspace(
    conn: &Connection,
    root_dir: &Path,
    workspace_id: &str,
    version_id: &str,
    query: &str,
    limit: Option<i64>,
    now_ms: i64,
) -> Result<Vec<SearchResult>, SearchError> {
    let normalized = normalize_query(query);
    if normalized.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
    if limit <= 0 {
        return Ok(Vec::new());
    }
    let cap = usize::try_from(limit)
        .unwrap_or(MAX_RESULT_LIMIT)
        .min(MAX_RESULT_LIMIT);

    index::ensure_search_index_for_version(conn, root_dir, workspace_id, version_id, now_ms)?;
    let Some(candidates) =
        query::query_search_index(conn, root_dir, workspace_id, version_id, query, limit)?
    else {
        // Too short for the trigram index and policy healthy: no index-backed
        // results (the linear fallback is a desktop-adapter concern).
        return Ok(Vec::new());
    };

    let mut results: Vec<SearchResult> = Vec::new();
    for candidate in candidates {
        if results.len() >= cap {
            break;
        }
        match candidate {
            SearchCandidate::File {
                path,
                object_id,
                text,
            } => {
                let remaining = cap.saturating_sub(results.len());
                for hit in preview_line_matches(&text, &normalized, remaining) {
                    results.push(SearchResult {
                        surface: SearchSurface::File,
                        path: path.clone(),
                        title: path.clone(),
                        line: hit.line,
                        preview: hit.preview,
                        match_start: hit.match_start,
                        match_end: hit.match_end,
                        thread_id: None,
                        object_id: Some(object_id.clone()),
                    });
                }
            }
            SearchCandidate::Chat { thread_id } => {
                let title = chat_thread_display_title(conn, workspace_id, &thread_id)?;
                // Preview each matching indexed row (header + messages) of this
                // thread, in rowid order.
                let rows = query::query_chat_messages_granular(
                    conn,
                    workspace_id,
                    query,
                    i64::try_from(MAX_FTS_FETCH).unwrap_or(i64::MAX),
                )?;
                for row in rows {
                    if row.thread_id != thread_id {
                        continue;
                    }
                    if results.len() >= cap {
                        break;
                    }
                    let remaining = cap.saturating_sub(results.len());
                    for hit in preview_line_matches(&row.text, &normalized, remaining) {
                        results.push(SearchResult {
                            surface: SearchSurface::Chat,
                            path: format!("chat/{thread_id}"),
                            title: title.clone(),
                            line: hit.line,
                            preview: hit.preview,
                            match_start: hit.match_start,
                            match_end: hit.match_end,
                            thread_id: Some(thread_id.clone()),
                            object_id: None,
                        });
                    }
                }
            }
        }
    }
    results.truncate(cap);
    Ok(results)
}

/// The display title for a thread, derived the same way the index rebuild does.
fn chat_thread_display_title(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
) -> Result<String, SearchError> {
    let row = conn
        .query_row(
            "SELECT t.title, \
                    (SELECT m.body FROM chat_messages m \
                     WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id \
                     ORDER BY m.created_at_ms, m.message_id LIMIT 1) \
             FROM chat_threads t WHERE t.workspace_id = ?1 AND t.thread_id = ?2",
            rusqlite::params![workspace_id, thread_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(SearchError::from(other)),
        })?;
    Ok(match row {
        Some((title, first_body)) => index::display_title_for(&title, first_body.as_deref()),
        None => thread_id.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_trims_and_lowercases() {
        assert_eq!(normalize_query("  HeLLo "), "hello");
    }

    #[test]
    fn split_lines_handles_crlf_and_cr() {
        assert_eq!(split_lines("a\r\nb\rc\nd"), vec!["a", "b", "c", "d"]);
        assert_eq!(split_lines("only"), vec!["only"]);
    }

    #[test]
    fn preview_finds_line_and_offsets() {
        let hits = preview_line_matches("first line\nsecond needle here\nthird", "needle", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        assert_eq!(
            &hits[0].preview[hits[0].match_start..hits[0].match_end],
            "needle"
        );
    }

    #[test]
    fn preview_windows_long_line() {
        let mut line = "x".repeat(300);
        line.push_str("NEEDLE");
        line.push_str(&"y".repeat(50));
        let hits = preview_line_matches(&line.to_lowercase(), "needle", 1);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].preview.chars().count() <= WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS);
        assert_eq!(
            &hits[0].preview[hits[0].match_start..hits[0].match_end],
            "needle"
        );
    }

    #[test]
    fn preview_respects_remaining_cap() {
        let text = "match\nmatch\nmatch";
        assert_eq!(preview_line_matches(text, "match", 2).len(), 2);
    }
}
