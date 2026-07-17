//! Policy-filtered FTS query. Ports `searchIndex.ts`'s `ftsQueryForSubstring`,
//! `querySearchIndex`, and `queryChatMessagesGranular`.
//!
//! Candidates are ordered by FTS `rowid` (insertion order), never by relevance
//! rank — the exact TS ordering, which sidesteps any bm25 cross-engine drift.
//! File candidates are re-checked LIVE against the current policy at read time
//! (a policy changed after indexing must still be honored) and de-duped; a
//! broken FILE policy fails the file half closed while chat search stays live.
//!
//! ## Reader invariant (defense in depth) — DO NOT REMOVE
//!
//! The degraded-window "freeze, don't drop" model deliberately LEAVES file rows
//! in `engine_search_files_fts` while the FILE policy is broken. The no-leak
//! guarantee therefore rests on EVERY reader of that table re-checking
//! [`path_is_search_indexed`] against the freshly-read policy before returning a
//! row — which fails closed (returns nothing) while degraded. Any new reader of
//! `engine_search_files_fts` MUST apply the same re-check, or it will serve
//! frozen rows a broken policy is supposed to hide. `query_search_index` is
//! currently the sole reader and does this; keep it that way.

use crate::search::policy::{path_is_search_indexed, read_engine_search_policy};
use crate::search::{
    MAX_FTS_FETCH, MAX_QUERY_CHARS, MAX_RESULT_LIMIT, MIN_TRIGRAM_QUERY_CHARS, SearchError,
    THREAD_HEADER_MESSAGE_ID,
};
use rusqlite::{Connection, params};
use std::collections::HashSet;
use std::path::Path;

/// An indexed candidate before line-preview extraction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchCandidate {
    File {
        path: String,
        object_id: String,
        text: String,
    },
    Chat {
        thread_id: String,
    },
}

/// A granular chat-message search hit (`GranularChatMessageSearchResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GranularChatMessageSearchResult {
    pub thread_id: String,
    /// `None` for a thread-header row (the sentinel `__thread__` message id).
    pub message_id: Option<String>,
    pub text: String,
}

/// Build the FTS MATCH expression for a substring query. Ports
/// `ftsQueryForSubstring`: trim; a query under [`MIN_TRIGRAM_QUERY_CHARS`]
/// chars returns `None` (too short for the trigram index); otherwise a quoted
/// phrase with embedded `"` doubled. A query over [`MAX_QUERY_CHARS`] also
/// returns `None` — a Rust-added DoS bound (approved-delta), set far above any
/// real query so normal search is byte-identical to TS.
fn fts_query_for_substring(query: &str) -> Option<String> {
    let normalized = query.trim();
    let char_count = normalized.chars().count();
    if !(MIN_TRIGRAM_QUERY_CHARS..=MAX_QUERY_CHARS).contains(&char_count) {
        return None;
    }
    Some(format!("\"{}\"", normalized.replace('"', "\"\"")))
}

/// Clamp an incoming result limit to the DoS ceiling. A non-positive limit
/// yields `None` (no work).
fn clamp_limit(limit: i64) -> Option<usize> {
    if limit <= 0 {
        return None;
    }
    let limit = usize::try_from(limit).unwrap_or(MAX_RESULT_LIMIT);
    Some(limit.min(MAX_RESULT_LIMIT))
}

/// The bounded FTS fetch size for an over-fetch multiplier.
fn fetch_size(limit: usize, multiplier: usize) -> i64 {
    let raw = limit.saturating_mul(multiplier).min(MAX_FTS_FETCH);
    i64::try_from(raw).unwrap_or(i64::MAX)
}

/// Query the FTS index for `query`, returning policy-filtered candidates capped
/// at `limit`. Ports `querySearchIndex` (`searchIndex.ts`).
///
/// Returns `None` when the query is too short for the trigram index AND the
/// FILE policy is healthy — the caller may then fall back to a linear scan.
/// Under a broken FILE policy a too-short query returns `Some(empty)` instead,
/// suppressing that fallback (which would fail OPEN). A well-formed query always
/// returns `Some`, with the file half empty while the policy is degraded and the
/// chat half unaffected.
pub fn query_search_index(
    conn: &Connection,
    root_dir: &Path,
    workspace_id: &str,
    version_id: &str,
    query: &str,
    limit: i64,
) -> Result<Option<Vec<SearchCandidate>>, SearchError> {
    let policy = read_engine_search_policy(root_dir);
    let Some(limit) = clamp_limit(limit) else {
        // A non-positive limit: nothing to do, but keep the fail-closed posture
        // (empty, not None) under a degraded policy so no linear fallback runs.
        return Ok(if policy.is_degraded() {
            Some(Vec::new())
        } else {
            None
        });
    };
    let Some(match_expr) = fts_query_for_substring(query) else {
        return Ok(if policy.is_degraded() {
            Some(Vec::new())
        } else {
            None
        });
    };

    let mut candidates: Vec<SearchCandidate> = Vec::new();
    let mut seen_files: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT path, object_id, text FROM engine_search_files_fts \
             WHERE engine_search_files_fts MATCH ?1 \
               AND workspace_id = ?2 AND version_id = ?3 \
             ORDER BY rowid LIMIT ?4",
        )?;
        let mut rows = stmt.query(params![
            match_expr,
            workspace_id,
            version_id,
            fetch_size(limit, 4)
        ])?;
        while let Some(row) = rows.next()? {
            let path: String = row.get(0)?;
            // Live re-check: a policy changed after indexing still applies. A
            // degraded policy makes this false for every path (file half closed).
            if !path_is_search_indexed(&policy, &path) {
                continue;
            }
            let object_id: String = row.get(1)?;
            let key = format!("{path}\u{0}{object_id}");
            if !seen_files.insert(key) {
                continue;
            }
            let text: String = row.get(2)?;
            candidates.push(SearchCandidate::File {
                path,
                object_id,
                text,
            });
            if candidates.len() >= limit {
                return Ok(Some(candidates));
            }
        }
    }

    let mut seen_threads: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT thread_id FROM engine_search_chat_messages_fts \
             WHERE engine_search_chat_messages_fts MATCH ?1 AND workspace_id = ?2 \
             ORDER BY rowid LIMIT ?3",
        )?;
        let mut rows = stmt.query(params![match_expr, workspace_id, fetch_size(limit, 8)])?;
        while let Some(row) = rows.next()? {
            let thread_id: String = row.get(0)?;
            if !seen_threads.insert(thread_id.clone()) {
                continue;
            }
            candidates.push(SearchCandidate::Chat { thread_id });
            if candidates.len() >= limit {
                return Ok(Some(candidates));
            }
        }
    }
    Ok(Some(candidates))
}

/// Query chat-message rows granularly (`queryChatMessagesGranular`). Returns
/// `[]` for a too-short query or a non-positive limit; maps the sentinel header
/// message id to `None`. Independent of the FILE policy — chat search survives a
/// broken file policy.
pub fn query_chat_messages_granular(
    conn: &Connection,
    workspace_id: &str,
    query: &str,
    limit: i64,
) -> Result<Vec<GranularChatMessageSearchResult>, SearchError> {
    let Some(limit) = clamp_limit(limit) else {
        return Ok(Vec::new());
    };
    let Some(match_expr) = fts_query_for_substring(query) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT thread_id, message_id, text FROM engine_search_chat_messages_fts \
         WHERE engine_search_chat_messages_fts MATCH ?1 AND workspace_id = ?2 \
         ORDER BY rowid LIMIT ?3",
    )?;
    let cap = i64::try_from(limit).unwrap_or(i64::MAX);
    let mut rows = stmt.query(params![match_expr, workspace_id, cap])?;
    let mut out: Vec<GranularChatMessageSearchResult> = Vec::new();
    while let Some(row) = rows.next()? {
        let thread_id: String = row.get(0)?;
        let message_id: String = row.get(1)?;
        let text: String = row.get(2)?;
        out.push(GranularChatMessageSearchResult {
            thread_id,
            message_id: if message_id == THREAD_HEADER_MESSAGE_ID {
                None
            } else {
                Some(message_id)
            },
            text,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_query_is_none() {
        assert_eq!(fts_query_for_substring("ab"), None);
        assert_eq!(fts_query_for_substring("  a "), None);
    }

    #[test]
    fn quotes_and_escapes() {
        assert_eq!(fts_query_for_substring("abc").as_deref(), Some("\"abc\""));
        assert_eq!(
            fts_query_for_substring("a\"b\"c").as_deref(),
            Some("\"a\"\"b\"\"c\"")
        );
    }

    #[test]
    fn over_long_query_bounded() {
        let long = "a".repeat(MAX_QUERY_CHARS + 1);
        assert_eq!(fts_query_for_substring(&long), None);
    }

    #[test]
    fn limit_clamped() {
        assert_eq!(clamp_limit(0), None);
        assert_eq!(clamp_limit(-5), None);
        assert_eq!(clamp_limit(10), Some(10));
        assert_eq!(clamp_limit(i64::MAX), Some(MAX_RESULT_LIMIT));
    }
}
