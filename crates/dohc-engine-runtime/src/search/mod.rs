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
    DiagnosticReason, EffectivePolicy, Export, FilesPolicyRule, POLICY_FILE_MAX_BYTES, PathFloor,
    PolicyDiagnostic, SearchPolicySnapshot, Visibility, VisibilityPolicyRule,
    classify_engine_file_path, parse_files_policy, parse_visibility_policy, path_is_search_indexed,
    policy_glob_matches, read_engine_search_policy, resolve_effective_policy, validate_policy_glob,
};
pub use query::{
    GranularChatMessageSearchBatch, GranularChatMessageSearchResult, SearchCandidate,
    SearchCandidateAnchor, SearchCandidateBatch, query_chat_messages_granular,
    query_chat_messages_granular_bounded, query_search_index, query_search_index_keyset,
};

use dohc_engine_domain::{MAX_MESSAGE_BODY_BYTES, is_js_trim_ws, linked_chat_projection_path};
use rusqlite::{Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// The sentinel message id for a thread's header row, shared with domain writes.
pub(crate) use dohc_engine_domain::chats::CHAT_THREAD_HEADER_MESSAGE_ID as THREAD_HEADER_MESSAGE_ID;

/// Minimum query length the trigram index can serve (`MIN_TRIGRAM_QUERY_CHARS`).
pub const MIN_TRIGRAM_QUERY_CHARS: usize = 3;

/// DoS ceiling on query length — a Rust-added bound the TS engine lacks (set far
/// above any real query so normal search stays byte-identical to TS).
pub const MAX_QUERY_CHARS: usize = 4096;

/// DoS ceiling on the caller-facing result limit.
pub const MAX_RESULT_LIMIT: usize = 1000;

/// The CLI's exhaustive chat-message prefilter cap. Returning exactly this
/// many rows means saturation, so the caller falls back to a full scan.
pub const MAX_GRANULAR_CHAT_RESULT_LIMIT: usize = 50_000;

/// DoS ceiling on a single FTS over-fetch (the `limit * multiplier` fetch is
/// clamped to this).
pub const MAX_FTS_FETCH: usize = 20_000;

/// Default result limit when the caller supplies none (`workspaceSearch.ts`).
pub const DEFAULT_SEARCH_LIMIT: i64 = 100;

/// Preview-window width in JavaScript UTF-16 code units
/// (`WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS` in the TypeScript oracle).
pub const WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS: usize = 180;

/// File candidate source is bounded before text is copied out of SQLite. Short
/// queries additionally cap every raw FTS row inspected, including non-matches.
pub const FILE_SEARCH_RESULT_SOURCE_BYTE_BUDGET: usize = 1024 * 1024;
pub const FILE_SEARCH_PAGE_SOURCE_BYTE_BUDGET: usize = 4 * 1024 * 1024;
pub const SHORT_QUERY_PAGE_ROW_BUDGET: usize = 1024;

/// A chat hit hydrates one message at most, and one actor page owns only this
/// much chat source text before returning a keyset continuation.
pub const CHAT_SEARCH_RESULT_SOURCE_BYTE_BUDGET: usize = MAX_MESSAGE_BODY_BYTES + 8 * 1024;
pub const CHAT_SEARCH_PAGE_SOURCE_BYTE_BUDGET: usize = 256 * 1024;
const UNPAGED_SEARCH_PAGE_CEILING: usize = MAX_RESULT_LIMIT + 1;

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
    /// UTF-8 **byte** offsets into `preview` bounding the matched substring:
    /// `&preview[match_start..match_end]` is always a valid slice on a char
    /// boundary (safe to byte-slice, unlike a char/UTF-16 index). See
    /// [`preview_line_matches`] for the contract.
    pub match_start: usize,
    pub match_end: usize,
    /// Present on chat results.
    pub thread_id: Option<String>,
    /// Present on file results.
    pub object_id: Option<String>,
}

/// Opaque-to-wire key for one line-level result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchResultKey {
    pub surface: SearchSurface,
    pub rowid: i64,
    pub line: usize,
}

/// One result plus the key the daemon cursor resumes after.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyedSearchResult {
    pub result: SearchResult,
    pub key: SearchResultKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchPageDisposition {
    Results,
    Restart,
}

/// Actor-owned bounded page. `generation` is the monotonic SQLite connection
/// change counter captured after index ensure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchPageBatch {
    pub disposition: SearchPageDisposition,
    pub generation: u64,
    pub results: Vec<KeyedSearchResult>,
    pub has_more: bool,
    /// Cursor key for the next actor page. A line of zero is an exclusive scan
    /// cursor and need not correspond to a returned result.
    pub continuation: Option<SearchResultKey>,
}

/// Normalize a query the way the search entry point does: trim + lowercase.
/// Matching is case-insensitive substring, so callers pass the normalized query
/// to [`preview_line_matches`].
pub fn normalize_query(query: &str) -> String {
    query.trim_matches(is_js_trim_ws).to_lowercase()
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

/// A single line's preview window (`previewForLine`). The window is centered by
/// UTF-16 code units, so even an all-astral preview stays within the renderer's
/// string-length contract. Boundaries remain Unicode scalar boundaries; the
/// returned offsets are UTF-8 bytes into the resulting Rust string.
fn preview_for_line(line: &str, match_index: usize, query_len: usize) -> (String, usize, usize) {
    let chars: Vec<char> = line.chars().collect();
    let utf16_width = |range: std::ops::Range<usize>| -> usize {
        chars[range].iter().map(|ch| ch.len_utf16()).sum()
    };
    let line_units = utf16_width(0..chars.len());
    let mut window_start = 0usize;
    if line_units > WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS {
        let target_left = WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS / 3;
        window_start = match_index.min(chars.len());
        let mut left_units = 0usize;
        while window_start > 0 {
            let width = chars[window_start - 1].len_utf16();
            if left_units.saturating_add(width) > target_left {
                break;
            }
            left_units = left_units.saturating_add(width);
            window_start -= 1;
        }
    }
    let mut window_end = window_start;
    let mut window_units = 0usize;
    while window_end < chars.len() {
        let width = chars[window_end].len_utf16();
        if window_units.saturating_add(width) > WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS {
            break;
        }
        window_units = window_units.saturating_add(width);
        window_end += 1;
    }
    while window_end == chars.len() && window_start > 0 {
        let width = chars[window_start - 1].len_utf16();
        if window_units.saturating_add(width) > WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS {
            break;
        }
        window_units = window_units.saturating_add(width);
        window_start -= 1;
    }
    let preview: String = chars[window_start..window_end].iter().collect();
    let match_start_char = match_index
        .saturating_sub(window_start)
        .min(window_end - window_start);
    let match_end_char = match_index
        .saturating_add(query_len)
        .saturating_sub(window_start)
        .min(window_end - window_start)
        .max(match_start_char);
    let match_start = chars[window_start..window_start + match_start_char]
        .iter()
        .map(|ch| ch.len_utf8())
        .sum();
    let match_end = chars[window_start..window_start + match_end_char]
        .iter()
        .map(|ch| ch.len_utf8())
        .sum();
    (preview, match_start, match_end)
}

/// A raw preview hit before it is wrapped in a [`SearchResult`]. `match_start`
/// and `match_end` are UTF-8 byte offsets into `preview` (see
/// [`preview_line_matches`]).
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
/// the match. Pure. `match_start`/`match_end` are UTF-8 **byte** offsets into
/// each hit's `preview` — `&preview[match_start..match_end]` is the matched text
/// and is always on a char boundary.
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

/// Compatibility wrapper for the unpaged runtime surface.
pub fn search_workspace(
    conn: &Connection,
    root_dir: &Path,
    workspace_id: &str,
    version_id: &str,
    query: &str,
    limit: Option<i64>,
    now_ms: i64,
) -> Result<Vec<SearchResult>, SearchError> {
    let requested = limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
    let Some(cap) = query::clamp_limit(requested, MAX_RESULT_LIMIT) else {
        return Ok(Vec::new());
    };
    collect_search_pages(cap, |remaining, expected_generation, after| {
        search_workspace_page(
            conn,
            root_dir,
            workspace_id,
            version_id,
            query,
            Some(i64::try_from(remaining).unwrap_or(i64::MAX)),
            now_ms,
            expected_generation,
            after,
        )
    })
}

fn collect_search_pages(
    cap: usize,
    mut next_page: impl FnMut(
        usize,
        Option<u64>,
        Option<SearchResultKey>,
    ) -> Result<SearchPageBatch, SearchError>,
) -> Result<Vec<SearchResult>, SearchError> {
    let mut results = Vec::with_capacity(cap);
    let mut expected_generation = None;
    let mut after = None;
    let mut iterations = 0usize;
    loop {
        iterations = iterations.saturating_add(1);
        if iterations > UNPAGED_SEARCH_PAGE_CEILING {
            return Err(SearchError::Bounds(
                "search paging exceeded its page ceiling",
            ));
        }
        let remaining = cap.saturating_sub(results.len());
        let page = next_page(remaining, expected_generation, after)?;
        if page.disposition == SearchPageDisposition::Restart {
            return Err(SearchError::Corrupt(
                "search generation changed during an unpaged read",
            ));
        }
        expected_generation = Some(page.generation);
        results.extend(page.results.into_iter().map(|keyed| keyed.result));
        if results.len() >= cap || !page.has_more {
            break;
        }
        let Some(next) = page.continuation else {
            return Err(SearchError::Bounds(
                "search page made no progress while continuation was required",
            ));
        };
        if after == Some(next) {
            return Err(SearchError::Bounds(
                "search page repeated its continuation cursor",
            ));
        }
        after = Some(next);
    }
    results.truncate(cap);
    Ok(results)
}

/// Ensure the index, bind the read to a monotonic connection generation, and
/// return a keyset page. Chat candidates hydrate only the exact matching
/// message; canonical message placement is derived from `(created_at_ms,
/// message_id)` ranks without loading the rest of the thread.
#[allow(clippy::too_many_arguments)]
pub fn search_workspace_page(
    conn: &Connection,
    root_dir: &Path,
    workspace_id: &str,
    version_id: &str,
    query: &str,
    limit: Option<i64>,
    now_ms: i64,
    expected_generation: Option<u64>,
    after: Option<SearchResultKey>,
) -> Result<SearchPageBatch, SearchError> {
    let normalized = normalize_query(query);
    if normalized.is_empty() {
        return Ok(SearchPageBatch {
            disposition: SearchPageDisposition::Results,
            generation: conn.total_changes(),
            results: Vec::new(),
            has_more: false,
            continuation: None,
        });
    }
    let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
    if limit <= 0 {
        return Ok(SearchPageBatch {
            disposition: SearchPageDisposition::Results,
            generation: conn.total_changes(),
            results: Vec::new(),
            has_more: false,
            continuation: None,
        });
    }
    let cap = usize::try_from(limit)
        .unwrap_or(MAX_RESULT_LIMIT)
        .min(MAX_RESULT_LIMIT);

    index::ensure_search_index_for_version(
        conn,
        root_dir,
        workspace_id,
        version_id,
        now_ms,
        &dohc_engine_storage::NoFaults,
    )?;
    let generation = conn.total_changes();
    if expected_generation.is_some_and(|expected| expected != generation) {
        return Ok(SearchPageBatch {
            disposition: SearchPageDisposition::Restart,
            generation,
            results: Vec::new(),
            has_more: false,
            continuation: None,
        });
    }
    let candidate_after = after.map(|key| SearchCandidateAnchor {
        surface: key.surface,
        rowid: key.rowid,
        inclusive: key.line > 0,
    });
    let Some(candidate_batch) = query::query_search_index_keyset(
        conn,
        root_dir,
        workspace_id,
        version_id,
        query,
        limit,
        candidate_after,
        FILE_SEARCH_RESULT_SOURCE_BYTE_BUDGET,
        FILE_SEARCH_PAGE_SOURCE_BYTE_BUDGET,
        SHORT_QUERY_PAGE_ROW_BUDGET,
    )?
    else {
        return Ok(SearchPageBatch {
            disposition: SearchPageDisposition::Results,
            generation,
            results: Vec::new(),
            has_more: false,
            continuation: None,
        });
    };

    let batch_has_more = candidate_batch.has_more;
    let batch_resume_after = candidate_batch.resume_after;
    let candidates = candidate_batch.candidates;
    let candidate_count = candidates.len();
    let chat_projection_offsets =
        chat_projection_offsets_for_candidates(conn, workspace_id, &candidates)?;
    let mut results: Vec<KeyedSearchResult> = Vec::new();
    let mut has_more = false;
    let mut continuation: Option<SearchResultKey> = None;
    let mut processed_through: Option<SearchResultKey> = None;
    let mut processed_all_candidates = true;
    let mut chat_source_bytes = 0usize;
    for (candidate_index, candidate) in candidates.into_iter().enumerate() {
        if results.len() >= cap {
            has_more = true;
            continuation = processed_through.or_else(|| results.last().map(|row| row.key));
            processed_all_candidates = false;
            break;
        }
        match candidate {
            SearchCandidate::File {
                rowid,
                path,
                object_id,
                text,
            } => {
                let remaining = cap.saturating_sub(results.len());
                let anchored_lines = after.filter(|anchor| {
                    anchor.surface == SearchSurface::File
                        && anchor.rowid == rowid
                        && anchor.line > 0
                });
                let scan_cap = remaining
                    .saturating_add(anchored_lines.map_or(0, |anchor| anchor.line))
                    .saturating_add(1);
                let hits: Vec<_> = preview_line_matches(&text, &normalized, scan_cap)
                    .into_iter()
                    .filter(|hit| anchored_lines.is_none_or(|anchor| hit.line > anchor.line))
                    .collect();
                let candidate_has_more_lines = hits.len() > remaining;
                for hit in hits.into_iter().take(remaining) {
                    let key = SearchResultKey {
                        surface: SearchSurface::File,
                        rowid,
                        line: hit.line,
                    };
                    results.push(KeyedSearchResult {
                        key,
                        result: SearchResult {
                            surface: SearchSurface::File,
                            path: path.clone(),
                            title: path.clone(),
                            line: hit.line,
                            preview: hit.preview,
                            match_start: hit.match_start,
                            match_end: hit.match_end,
                            thread_id: None,
                            object_id: Some(object_id.clone()),
                        },
                    });
                }
                if candidate_has_more_lines {
                    has_more = true;
                    continuation = results.last().map(|row| row.key);
                    processed_all_candidates = false;
                    break;
                }
                processed_through = Some(SearchResultKey {
                    surface: SearchSurface::File,
                    rowid,
                    line: 0,
                });
            }
            SearchCandidate::Chat {
                rowid,
                thread_id,
                message_id,
            } => {
                let remaining_source =
                    CHAT_SEARCH_PAGE_SOURCE_BYTE_BUDGET.saturating_sub(chat_source_bytes);
                let fragment = match hydrate_chat_search_fragment(
                    conn,
                    workspace_id,
                    &thread_id,
                    &message_id,
                    chat_projection_offsets
                        .get(&thread_id)
                        .and_then(|offsets| offsets.get(&message_id))
                        .copied(),
                    remaining_source,
                )? {
                    ChatHydration::Ready(fragment) => fragment,
                    ChatHydration::Missing | ChatHydration::Oversized => {
                        processed_through = Some(SearchResultKey {
                            surface: SearchSurface::Chat,
                            rowid,
                            line: 0,
                        });
                        continue;
                    }
                    ChatHydration::PageFull => {
                        has_more = true;
                        continuation =
                            processed_through.or_else(|| results.last().map(|row| row.key));
                        processed_all_candidates = false;
                        break;
                    }
                };
                chat_source_bytes = chat_source_bytes.saturating_add(fragment.source_bytes);
                let remaining = cap.saturating_sub(results.len());
                let anchored_lines = after.filter(|anchor| {
                    anchor.surface == SearchSurface::Chat
                        && anchor.rowid == rowid
                        && anchor.line > 0
                });
                let scan_cap = remaining
                    .saturating_add(anchored_lines.map_or(0, |anchor| anchor.line))
                    .saturating_add(1);
                let hits: Vec<_> = preview_line_matches(&fragment.text, &normalized, scan_cap)
                    .into_iter()
                    .filter(|hit| anchored_lines.is_none_or(|anchor| hit.line > anchor.line))
                    .collect();
                let candidate_has_more_lines = hits.len() > remaining;
                for hit in hits.into_iter().take(remaining) {
                    let key = SearchResultKey {
                        surface: SearchSurface::Chat,
                        rowid,
                        line: hit.line,
                    };
                    results.push(KeyedSearchResult {
                        key,
                        result: SearchResult {
                            surface: SearchSurface::Chat,
                            path: fragment.path.clone(),
                            title: fragment.title.clone(),
                            line: fragment.line_offset.saturating_add(hit.line),
                            preview: hit.preview,
                            match_start: hit.match_start,
                            match_end: hit.match_end,
                            thread_id: Some(thread_id.clone()),
                            object_id: None,
                        },
                    });
                }
                if candidate_has_more_lines {
                    has_more = true;
                    continuation = results.last().map(|row| row.key);
                    processed_all_candidates = false;
                    break;
                }
                processed_through = Some(SearchResultKey {
                    surface: SearchSurface::Chat,
                    rowid,
                    line: 0,
                });
            }
        }
        if results.len() >= cap
            && (candidate_index.saturating_add(1) < candidate_count || batch_has_more)
        {
            has_more = true;
            continuation = processed_through;
            processed_all_candidates = false;
            break;
        }
    }
    if processed_all_candidates && batch_has_more {
        has_more = true;
        continuation = batch_resume_after.map(|anchor| SearchResultKey {
            surface: anchor.surface,
            rowid: anchor.rowid,
            line: 0,
        });
    }
    if has_more && continuation.is_none() {
        return Err(SearchError::Bounds(
            "search page made no progress while continuation was required",
        ));
    }
    results.truncate(cap);
    Ok(SearchPageBatch {
        disposition: SearchPageDisposition::Results,
        generation,
        results,
        has_more,
        continuation,
    })
}

struct ChatSearchFragment {
    path: String,
    title: String,
    text: String,
    line_offset: usize,
    source_bytes: usize,
}

enum ChatHydration {
    Ready(ChatSearchFragment),
    Missing,
    Oversized,
    PageFull,
}

fn chat_projection_targets(candidates: &[SearchCandidate]) -> HashMap<String, HashSet<String>> {
    let mut targets: HashMap<String, HashSet<String>> = HashMap::new();
    for candidate in candidates {
        let SearchCandidate::Chat {
            thread_id,
            message_id,
            ..
        } = candidate
        else {
            continue;
        };
        if message_id != THREAD_HEADER_MESSAGE_ID {
            targets
                .entry(thread_id.clone())
                .or_default()
                .insert(message_id.clone());
        }
    }
    targets
}

fn chat_projection_offsets_for_candidates(
    conn: &Connection,
    workspace_id: &str,
    candidates: &[SearchCandidate],
) -> Result<HashMap<String, HashMap<String, usize>>, SearchError> {
    let targets = chat_projection_targets(candidates);
    let mut offsets: HashMap<String, HashMap<String, usize>> =
        HashMap::with_capacity(targets.len());
    let mut statement = conn.prepare(
        "SELECT message_id, \
                4 + length(body) - length(replace(body, char(10), '')) \
         FROM chat_messages \
         WHERE workspace_id = ?1 AND thread_id = ?2 \
         ORDER BY created_at_ms, message_id",
    )?;
    for (thread_id, target_messages) in targets {
        let mut prior_projection_lines = 0usize;
        let mut thread_offsets = HashMap::with_capacity(target_messages.len());
        let mut rows = statement.query(rusqlite::params![workspace_id, thread_id])?;
        while let Some(row) = rows.next()? {
            let message_id: String = row.get(0)?;
            if target_messages.contains(&message_id) {
                thread_offsets.insert(message_id, prior_projection_lines);
            }
            let projection_lines = usize::try_from(row.get::<_, i64>(1)?)
                .map_err(|_| SearchError::Corrupt("negative chat projection line count"))?;
            prior_projection_lines = prior_projection_lines.saturating_add(projection_lines);
        }
        offsets.insert(thread_id, thread_offsets);
    }
    Ok(offsets)
}

fn hydrate_chat_search_fragment(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
    prior_projection_lines: Option<usize>,
    remaining_page_bytes: usize,
) -> Result<ChatHydration, SearchError> {
    if message_id != THREAD_HEADER_MESSAGE_ID && prior_projection_lines.is_none() {
        return Ok(ChatHydration::Missing);
    }
    let metadata = conn
        .query_row(
            "SELECT t.title, t.linked_object_id, \
                    (SELECT CASE WHEN instr(m.body, char(10)) = 0 THEN m.body \
                                 ELSE substr(m.body, 1, instr(m.body, char(10)) - 1) END \
                     FROM chat_messages m \
                     WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id \
                     ORDER BY m.created_at_ms, m.message_id LIMIT 1) \
             FROM chat_threads t WHERE t.workspace_id = ?1 AND t.thread_id = ?2",
            rusqlite::params![workspace_id, thread_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((stored_title, linked_object_id, first_body)) = metadata else {
        return Ok(ChatHydration::Missing);
    };
    let title = index::display_title_for(&stored_title, first_body.as_deref());
    let path = linked_chat_projection_path(workspace_id, thread_id, None)
        .map_err(|_| SearchError::Corrupt("chat projection path is invalid"))?;
    let metadata_bytes = path
        .len()
        .saturating_add(title.len())
        .saturating_add(thread_id.len())
        .saturating_add(message_id.len())
        .saturating_add(first_body.as_ref().map_or(0, String::len));

    if message_id == THREAD_HEADER_MESSAGE_ID {
        let text = if linked_object_id.is_some() {
            format!("# {title}\n\nRead-only chat projection.\n\nLinked file: unavailable\n")
        } else {
            format!("# {title}\n\nRead-only chat projection.\n")
        };
        let source_bytes = metadata_bytes.saturating_add(text.len());
        if source_bytes > CHAT_SEARCH_RESULT_SOURCE_BYTE_BUDGET {
            return Ok(ChatHydration::Oversized);
        }
        if source_bytes > remaining_page_bytes {
            return Ok(ChatHydration::PageFull);
        }
        return Ok(ChatHydration::Ready(ChatSearchFragment {
            path,
            title,
            text,
            line_offset: 0,
            source_bytes,
        }));
    }

    let mut statement = conn.prepare(
        "SELECT m.author_kind, m.author_display_name, \
                length(CAST(m.body AS BLOB)), m.body \
         FROM chat_messages m \
         WHERE m.workspace_id = ?1 AND m.thread_id = ?2 AND m.message_id = ?3",
    )?;
    let mut rows = statement.query(rusqlite::params![workspace_id, thread_id, message_id])?;
    let Some(row) = rows.next()? else {
        return Ok(ChatHydration::Missing);
    };
    let author_kind: String = row.get(0)?;
    let author_display_name: String = row.get(1)?;
    let body_bytes = usize::try_from(row.get::<_, i64>(2)?)
        .map_err(|_| SearchError::Corrupt("negative chat message body length"))?;
    let source_bytes = metadata_bytes
        .saturating_add(author_kind.len())
        .saturating_add(author_display_name.len())
        .saturating_add(body_bytes);
    if source_bytes > CHAT_SEARCH_RESULT_SOURCE_BYTE_BUDGET {
        return Ok(ChatHydration::Oversized);
    }
    if source_bytes > remaining_page_bytes {
        return Ok(ChatHydration::PageFull);
    }
    let body: String = row.get(3)?;
    let author = match author_kind.as_str() {
        "human" => author_display_name,
        "agent" => format!("{author_display_name} (agent)"),
        _ => {
            return Err(SearchError::Corrupt(
                "chat message has an unknown author kind",
            ));
        }
    };
    let line_offset =
        if linked_object_id.is_some() { 6 } else { 4 } + prior_projection_lines.unwrap_or(0);
    Ok(ChatHydration::Ready(ChatSearchFragment {
        path,
        title,
        text: format!("## {author}\n\n{body}"),
        line_offset,
        source_bytes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_trims_and_lowercases() {
        assert_eq!(normalize_query("  HeLLo "), "hello");
        assert_eq!(normalize_query("\u{feff}HeLLo\u{feff}"), "hello");
        assert_eq!(normalize_query("\u{0085}HeLLo"), "\u{0085}hello");
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
    fn preview_backfills_context_when_match_is_near_line_end() {
        let line = format!("{}needle", "x".repeat(300));
        let hit = preview_line_matches(&line, "needle", 1)
            .into_iter()
            .next()
            .expect("hit");
        assert_eq!(
            hit.preview.encode_utf16().count(),
            WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS
        );
        assert_eq!(hit.match_end, hit.preview.len());
        assert_eq!(&hit.preview[hit.match_start..hit.match_end], "needle");
    }

    #[test]
    fn preview_respects_remaining_cap() {
        let text = "match\nmatch\nmatch";
        assert_eq!(preview_line_matches(text, "match", 2).len(), 2);
    }

    #[test]
    fn preview_offsets_are_byte_offsets_safe_on_astral_text() {
        // A 4-byte emoji before the match: the returned offsets are UTF-8 byte
        // offsets into `preview`, so byte-slicing lands exactly on the match and
        // never panics on a char boundary.
        let hits = preview_line_matches("\u{1F600}\u{1F600} needle here", "needle", 10);
        assert_eq!(hits.len(), 1);
        let hit = &hits[0];
        // Byte-slice (would panic mid-emoji if the offsets were char indices).
        assert_eq!(&hit.preview[hit.match_start..hit.match_end], "needle");
    }

    #[test]
    fn preview_is_bounded_in_utf16_units_on_astral_text() {
        // MUTATION: window by Rust scalar count and this becomes 360 UTF-16
        // units, exceeding the renderer's 250-unit IPC contract.
        let line = format!(
            "{}needle{}",
            "\u{1f600}".repeat(120),
            "\u{1f680}".repeat(120)
        );
        let hits = preview_line_matches(&line, "needle", 1);
        let hit = hits.first().expect("astral hit");
        assert!(hit.preview.encode_utf16().count() <= WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS);
        let start_utf16 = hit.preview[..hit.match_start].encode_utf16().count();
        let end_utf16 = hit.preview[..hit.match_end].encode_utf16().count();
        assert_eq!(
            hit.preview
                .encode_utf16()
                .skip(start_utf16)
                .take(end_utf16 - start_utf16)
                .collect::<Vec<_>>(),
            "needle".encode_utf16().collect::<Vec<_>>()
        );
    }

    #[test]
    fn unpaged_search_rejects_runaway_alternating_continuations() {
        // MUTATION: remove the iteration ceiling and this finite pathological
        // pager eventually returns success after alternating beyond the bound.
        let mut calls = 0usize;
        let error = collect_search_pages(1, |_remaining, _generation, _after| {
            calls = calls.saturating_add(1);
            let has_more = calls <= UNPAGED_SEARCH_PAGE_CEILING.saturating_add(1);
            Ok(SearchPageBatch {
                disposition: SearchPageDisposition::Results,
                generation: 7,
                results: Vec::new(),
                has_more,
                continuation: has_more.then_some(SearchResultKey {
                    surface: SearchSurface::File,
                    rowid: if calls.is_multiple_of(2) { 2 } else { 1 },
                    line: 0,
                }),
            })
        })
        .expect_err("runaway pager must hit the hard page ceiling");

        assert!(matches!(
            error,
            SearchError::Bounds("search paging exceeded its page ceiling")
        ));
        assert_eq!(calls, UNPAGED_SEARCH_PAGE_CEILING);
    }

    #[test]
    fn chat_projection_targets_group_messages_by_thread() {
        let candidates = vec![
            SearchCandidate::Chat {
                rowid: 1,
                thread_id: "thread-a".to_owned(),
                message_id: "message-a1".to_owned(),
            },
            SearchCandidate::Chat {
                rowid: 2,
                thread_id: "thread-a".to_owned(),
                message_id: "message-a2".to_owned(),
            },
            SearchCandidate::Chat {
                rowid: 3,
                thread_id: "thread-a".to_owned(),
                message_id: THREAD_HEADER_MESSAGE_ID.to_owned(),
            },
            SearchCandidate::Chat {
                rowid: 4,
                thread_id: "thread-b".to_owned(),
                message_id: "message-b1".to_owned(),
            },
        ];

        let targets = chat_projection_targets(&candidates);
        assert_eq!(targets.len(), 2);
        assert_eq!(targets["thread-a"].len(), 2);
        assert!(targets["thread-a"].contains("message-a1"));
        assert!(targets["thread-a"].contains("message-a2"));
        assert_eq!(targets["thread-b"].len(), 1);
    }
}
