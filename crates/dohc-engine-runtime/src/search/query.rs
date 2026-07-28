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
    MAX_FTS_FETCH, MAX_GRANULAR_CHAT_RESULT_LIMIT, MAX_QUERY_CHARS, MAX_RESULT_LIMIT,
    MIN_TRIGRAM_QUERY_CHARS, SearchError, THREAD_HEADER_MESSAGE_ID,
};
use dohc_engine_domain::is_js_trim_ws;
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

/// Whether the live head for `object_id` in this version is a BINARY head. Used
/// by the file-search reader to filter a stale text FTS row whose path has since
/// been overwritten by binary content (the index freezes such rows; the reader
/// drops them). A genuinely absent snapshot is not binary — its staleness (a
/// deleted file) is out of scope here and cleaned by a full rebuild.
fn live_head_is_binary(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<bool, SearchError> {
    let kind: Option<String> = conn
        .query_row(
            "SELECT content_kind FROM snapshots \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            params![workspace_id, version_id, object_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(kind.as_deref() == Some("binary"))
}

/// An indexed candidate before line-preview extraction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchCandidate {
    File {
        rowid: i64,
        path: String,
        object_id: String,
        text: String,
    },
    Chat {
        rowid: i64,
        thread_id: String,
        message_id: String,
    },
}

/// Stable candidate-stream coordinate used by daemon search pagination.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchCandidateAnchor {
    pub surface: crate::search::SearchSurface,
    pub rowid: i64,
}

/// A keyset page of indexed candidates. `has_more` is true when the caller
/// should continue after the last returned candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchCandidateBatch {
    pub candidates: Vec<SearchCandidate>,
    pub has_more: bool,
}

/// A granular chat-message search hit (`GranularChatMessageSearchResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GranularChatMessageSearchResult {
    pub thread_id: String,
    /// `None` for a thread-header row (the sentinel `__thread__` message id).
    pub message_id: Option<String>,
    pub text: String,
}

/// A granular result batch whose owned strings were bounded while rows were
/// stepped, before they crossed the store-actor boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GranularChatMessageSearchBatch {
    pub results: Vec<GranularChatMessageSearchResult>,
    pub saturated_by_bytes: bool,
}

/// How a raw query classifies against the trigram/length bounds.
enum QueryTerm {
    /// Under [`MIN_TRIGRAM_QUERY_CHARS`]: the trigram index cannot serve it. The
    /// caller MAY fall back to a linear scan (`None` at the public boundary).
    TooShort,
    /// Over [`MAX_QUERY_CHARS`]: a Rust-added DoS bound. This FAILS CLOSED (empty
    /// results, never a linear-scan fallback) so a pathological query cannot turn
    /// into an expensive full scan in an adapter.
    TooLong,
    /// A usable FTS MATCH phrase (embedded `"` doubled).
    Match(String),
}

/// Classify a substring query. Ports `ftsQueryForSubstring` for the phrase
/// construction, but distinguishes too-short (fallback-eligible) from too-long
/// (fail-closed) so the two never share the ambiguous `None` sentinel. The
/// length bound is set far above any real query, so normal search is
/// byte-identical to TS.
fn classify_query(query: &str) -> QueryTerm {
    let normalized = query.trim_matches(is_js_trim_ws);
    let char_count = normalized.chars().count();
    if char_count < MIN_TRIGRAM_QUERY_CHARS {
        return QueryTerm::TooShort;
    }
    if char_count > MAX_QUERY_CHARS {
        return QueryTerm::TooLong;
    }
    QueryTerm::Match(format!("\"{}\"", normalized.replace('"', "\"\"")))
}

/// Clamp an incoming result limit to the DoS ceiling. A non-positive limit
/// yields `None` (no work).
fn clamp_limit(limit: i64, maximum: usize) -> Option<usize> {
    if limit <= 0 {
        return None;
    }
    let limit = usize::try_from(limit).unwrap_or(maximum);
    Some(limit.min(maximum))
}

/// The bounded FTS fetch size for an over-fetch multiplier.
fn fetch_size(limit: usize, multiplier: usize) -> i64 {
    let raw = limit.saturating_mul(multiplier).min(MAX_FTS_FETCH);
    i64::try_from(raw).unwrap_or(i64::MAX)
}

/// Query the FTS index for `query`, returning policy-filtered candidates capped
/// at `limit`. Ports `querySearchIndex` (`searchIndex.ts`).
///
/// Returns `None` ONLY when the query is too short for the trigram index AND the
/// FILE policy is healthy — the caller may then fall back to a linear scan.
/// Under a broken FILE policy a too-short query returns `Some(empty)` instead,
/// suppressing that fallback (which would fail OPEN). An OVER-long query always
/// returns `Some(empty)` (fail closed — never the fallback sentinel, so a
/// pathological query cannot become a linear scan). A well-formed query always
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
    match classify_query(query) {
        QueryTerm::TooShort => {
            return Ok(if read_engine_search_policy(root_dir).is_degraded() {
                Some(Vec::new())
            } else {
                None
            });
        }
        QueryTerm::TooLong => return Ok(Some(Vec::new())),
        QueryTerm::Match(_) => {}
    }
    Ok(query_search_index_keyset(
        conn,
        root_dir,
        workspace_id,
        version_id,
        query,
        limit,
        None,
        usize::MAX,
        usize::MAX,
    )?
    .map(|batch| batch.candidates))
}

/// Keyset form of [`query_search_index`] used by the bounded daemon page.
///
/// Queries under the trigram minimum use the legacy linear fallback over the
/// stored FTS content. That fallback inspects candidate byte lengths before
/// materializing text and stops at both a per-row and per-page budget.
#[allow(clippy::too_many_arguments)]
pub fn query_search_index_keyset(
    conn: &Connection,
    root_dir: &Path,
    workspace_id: &str,
    version_id: &str,
    query: &str,
    limit: i64,
    after: Option<SearchCandidateAnchor>,
    short_query_row_byte_budget: usize,
    short_query_page_byte_budget: usize,
) -> Result<Option<SearchCandidateBatch>, SearchError> {
    let policy = read_engine_search_policy(root_dir);
    // A too-short query is the only case that may fall back to a linear scan (and
    // only under a healthy policy). Everything else that yields no FTS term
    // (over-long, non-positive limit) fails closed with an empty, non-`None`
    // result so no unfiltered fallback runs.
    let fallback_or_empty = || {
        if policy.is_degraded() {
            Some(Vec::new())
        } else {
            None
        }
    };
    let Some(limit) = clamp_limit(limit, MAX_RESULT_LIMIT) else {
        return Ok(fallback_or_empty().map(|candidates| SearchCandidateBatch {
            candidates,
            has_more: false,
        }));
    };
    let query_term = classify_query(query);
    if matches!(query_term, QueryTerm::TooShort) && policy.is_degraded() {
        return Ok(Some(SearchCandidateBatch {
            candidates: Vec::new(),
            has_more: false,
        }));
    }
    if matches!(query_term, QueryTerm::TooLong) {
        return Ok(Some(SearchCandidateBatch {
            candidates: Vec::new(),
            has_more: false,
        }));
    }
    let normalized = query.trim_matches(is_js_trim_ws).to_lowercase();
    let after_surface = after.map(|value| value.surface);
    let after_rowid = after.map_or(0, |value| value.rowid);
    let probe_limit = limit
        .saturating_add(1)
        .min(MAX_RESULT_LIMIT.saturating_add(1));
    let probe_limit_i64 = i64::try_from(probe_limit).unwrap_or(i64::MAX);
    let mut short_query_materialized_bytes = 0usize;
    let is_short = matches!(query_term, QueryTerm::TooShort);

    let file_after = if after_surface == Some(crate::search::SearchSurface::File) {
        after_rowid
    } else {
        0
    };

    let mut candidates: Vec<SearchCandidate> = Vec::new();
    let skip_files = after_surface == Some(crate::search::SearchSurface::Chat);
    if !skip_files {
        let sql = if is_short {
            "SELECT rowid, path, object_id, length(CAST(text AS BLOB)), text \
             FROM engine_search_files_fts \
             WHERE workspace_id = ?1 AND version_id = ?2 AND rowid >= ?3 \
               AND instr(lower(text), ?4) > 0 \
             ORDER BY rowid LIMIT ?5"
        } else {
            "SELECT rowid, path, object_id, length(CAST(text AS BLOB)), text \
             FROM engine_search_files_fts \
             WHERE engine_search_files_fts MATCH ?4 \
               AND workspace_id = ?1 AND version_id = ?2 AND rowid >= ?3 \
             ORDER BY rowid LIMIT ?5"
        };
        let mut stmt = conn.prepare(sql)?;
        let term = match &query_term {
            QueryTerm::Match(term) => term.as_str(),
            QueryTerm::TooShort => normalized.as_str(),
            QueryTerm::TooLong => unreachable!("handled above"),
        };
        let mut rows = stmt.query(params![
            workspace_id,
            version_id,
            file_after,
            term,
            fetch_size(probe_limit, 4).max(probe_limit_i64),
        ])?;
        while let Some(row) = rows.next()? {
            let rowid: i64 = row.get(0)?;
            let path: String = row.get(1)?;
            // Live re-check: a policy changed after indexing still applies. A
            // degraded policy makes this false for every path (file half closed).
            if !path_is_search_indexed(&policy, &path) {
                continue;
            }
            let object_id: String = row.get(2)?;
            // Live re-check (reader invariant): a path indexed while it was TEXT
            // but now backed by a BINARY head must not be served by its stale
            // former text. The file index "freezes, doesn't drop" (rebuild-time
            // binary exclusion never cleans an already-built index), so — exactly
            // as for the policy re-check above — the reader filters a now-binary
            // head out here.
            if live_head_is_binary(conn, workspace_id, version_id, &object_id)? {
                continue;
            }
            let text_bytes = usize::try_from(row.get::<_, i64>(3)?)
                .map_err(|_| SearchError::Corrupt("negative search candidate length"))?;
            if is_short {
                if text_bytes > short_query_row_byte_budget {
                    return Err(SearchError::Bounds(
                        "short-query candidate exceeded per-result byte budget",
                    ));
                }
                if text_bytes
                    > short_query_page_byte_budget.saturating_sub(short_query_materialized_bytes)
                {
                    return Ok(Some(SearchCandidateBatch {
                        candidates,
                        has_more: true,
                    }));
                }
                short_query_materialized_bytes =
                    short_query_materialized_bytes.saturating_add(text_bytes);
            }
            let text: String = row.get(4)?;
            candidates.push(SearchCandidate::File {
                rowid,
                path,
                object_id,
                text,
            });
            if candidates.len() >= probe_limit {
                candidates.truncate(limit);
                return Ok(Some(SearchCandidateBatch {
                    candidates,
                    has_more: true,
                }));
            }
        }
    }

    let chat_after = if after_surface == Some(crate::search::SearchSurface::Chat) {
        after_rowid
    } else {
        0
    };
    {
        let sql = if is_short {
            "SELECT rowid, thread_id, message_id \
             FROM engine_search_chat_messages_fts \
             WHERE workspace_id = ?1 AND rowid >= ?2 AND instr(lower(text), ?3) > 0 \
             ORDER BY rowid LIMIT ?4"
        } else {
            "SELECT rowid, thread_id, message_id \
             FROM engine_search_chat_messages_fts \
             WHERE engine_search_chat_messages_fts MATCH ?3 \
               AND workspace_id = ?1 AND rowid >= ?2 \
             ORDER BY rowid LIMIT ?4"
        };
        let mut stmt = conn.prepare(sql)?;
        let term = match &query_term {
            QueryTerm::Match(term) => term.as_str(),
            QueryTerm::TooShort => normalized.as_str(),
            QueryTerm::TooLong => unreachable!("handled above"),
        };
        let remaining_probe = probe_limit.saturating_sub(candidates.len());
        let mut rows = stmt.query(params![
            workspace_id,
            chat_after,
            term,
            fetch_size(remaining_probe.max(1), 8)
                .max(i64::try_from(remaining_probe).unwrap_or(i64::MAX)),
        ])?;
        while let Some(row) = rows.next()? {
            candidates.push(SearchCandidate::Chat {
                rowid: row.get(0)?,
                thread_id: row.get(1)?,
                message_id: row.get(2)?,
            });
            if candidates.len() >= probe_limit {
                candidates.truncate(limit);
                return Ok(Some(SearchCandidateBatch {
                    candidates,
                    has_more: true,
                }));
            }
        }
    }
    Ok(Some(SearchCandidateBatch {
        candidates,
        has_more: false,
    }))
}

/// Query chat-message rows granularly (`queryChatMessagesGranular`). Returns
/// `[]` for a too-short OR over-long query or a non-positive limit; maps the
/// sentinel header message id to `None`. Independent of the FILE policy — chat
/// search survives a broken file policy.
pub fn query_chat_messages_granular(
    conn: &Connection,
    workspace_id: &str,
    query: &str,
    limit: i64,
) -> Result<Vec<GranularChatMessageSearchResult>, SearchError> {
    Ok(query_chat_messages_granular_bounded(conn, workspace_id, query, limit, usize::MAX)?.results)
}

/// The daemon-facing granular reader. SQLite byte lengths are inspected before
/// any matching text is copied into an owned `String`, so a broad query cannot
/// accumulate an unbounded actor message before the wire layer applies its
/// exact serialized-byte cut.
pub fn query_chat_messages_granular_bounded(
    conn: &Connection,
    workspace_id: &str,
    query: &str,
    limit: i64,
    materialized_byte_budget: usize,
) -> Result<GranularChatMessageSearchBatch, SearchError> {
    let Some(limit) = clamp_limit(limit, MAX_GRANULAR_CHAT_RESULT_LIMIT) else {
        return Ok(GranularChatMessageSearchBatch {
            results: Vec::new(),
            saturated_by_bytes: false,
        });
    };
    let QueryTerm::Match(match_expr) = classify_query(query) else {
        // Too short or too long: nothing to serve (no fallback surface here).
        return Ok(GranularChatMessageSearchBatch {
            results: Vec::new(),
            saturated_by_bytes: false,
        });
    };
    let mut stmt = conn.prepare(
        "SELECT length(CAST(thread_id AS BLOB)), \
                length(CAST(message_id AS BLOB)), \
                length(CAST(text AS BLOB)), \
                thread_id, message_id, text \
         FROM engine_search_chat_messages_fts \
         WHERE engine_search_chat_messages_fts MATCH ?1 AND workspace_id = ?2 \
         ORDER BY rowid LIMIT ?3",
    )?;
    let cap = i64::try_from(limit).unwrap_or(i64::MAX);
    let mut rows = stmt.query(params![match_expr, workspace_id, cap])?;
    let mut out: Vec<GranularChatMessageSearchResult> = Vec::new();
    let mut materialized_bytes = 0usize;
    let mut saturated_by_bytes = false;
    while let Some(row) = rows.next()? {
        let thread_id_bytes = usize::try_from(row.get::<_, i64>(0)?)
            .map_err(|_| SearchError::Corrupt("negative granular thread-id length"))?;
        let message_id_bytes = usize::try_from(row.get::<_, i64>(1)?)
            .map_err(|_| SearchError::Corrupt("negative granular message-id length"))?;
        let text_bytes = usize::try_from(row.get::<_, i64>(2)?)
            .map_err(|_| SearchError::Corrupt("negative granular text length"))?;
        let row_bytes = thread_id_bytes
            .saturating_add(message_id_bytes)
            .saturating_add(text_bytes);
        if row_bytes > materialized_byte_budget.saturating_sub(materialized_bytes) {
            saturated_by_bytes = true;
            break;
        }
        let thread_id: String = row.get(3)?;
        let message_id: String = row.get(4)?;
        let text: String = row.get(5)?;
        materialized_bytes = materialized_bytes.saturating_add(row_bytes);
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
    Ok(GranularChatMessageSearchBatch {
        results: out,
        saturated_by_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_query_is_too_short() {
        assert!(matches!(classify_query("ab"), QueryTerm::TooShort));
        assert!(matches!(classify_query("  a "), QueryTerm::TooShort));
    }

    #[test]
    fn quotes_and_escapes() {
        assert!(matches!(classify_query("abc"), QueryTerm::Match(t) if t == "\"abc\""));
        assert!(matches!(classify_query("a\"b\"c"), QueryTerm::Match(t) if t == "\"a\"\"b\"\"c\""));
    }

    #[test]
    fn query_trim_matches_ecmascript_whitespace() {
        assert!(matches!(
            classify_query("\u{0085}ab"),
            QueryTerm::Match(t) if t == "\"\u{0085}ab\""
        ));
        assert!(matches!(
            classify_query("\u{feff}ab\u{feff}"),
            QueryTerm::TooShort
        ));
    }

    #[test]
    fn over_long_query_is_too_long_not_short() {
        // Over-long must classify distinctly from too-short so it can fail closed
        // rather than share the fallback sentinel.
        let long = "a".repeat(MAX_QUERY_CHARS + 1);
        assert!(matches!(classify_query(&long), QueryTerm::TooLong));
    }

    #[test]
    fn limit_clamped() {
        assert_eq!(clamp_limit(0, MAX_RESULT_LIMIT), None);
        assert_eq!(clamp_limit(-5, MAX_RESULT_LIMIT), None);
        assert_eq!(clamp_limit(10, MAX_RESULT_LIMIT), Some(10));
        assert_eq!(
            clamp_limit(i64::MAX, MAX_RESULT_LIMIT),
            Some(MAX_RESULT_LIMIT)
        );
        assert_eq!(
            clamp_limit(50_000, MAX_GRANULAR_CHAT_RESULT_LIMIT),
            Some(50_000)
        );
    }
}
