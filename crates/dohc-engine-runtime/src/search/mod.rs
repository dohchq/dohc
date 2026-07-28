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
    query_chat_messages_granular, query_chat_messages_granular_bounded, query_search_index,
};

use dohc_engine_domain::{
    ChatActorKind, ChatMessage, ChatProjectionFileAccess, ChatThread, linked_chat_projection_path,
    render_chat_thread_projection,
};
use rusqlite::Connection;
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

/// The UTF-8 byte offset of the `n`-th char in `s` (or `s.len()` if past the
/// end). Used to convert a char position into a byte offset into the preview so
/// the returned offsets are safe to byte-slice.
fn char_to_byte(s: &str, char_index: usize) -> usize {
    s.char_indices()
        .nth(char_index)
        .map_or_else(|| s.len(), |(byte, _)| byte)
}

/// A single line's preview window (`previewForLine`). The window is centered by
/// CHAR position (matching the JS char/UTF-16 windowing for BMP text; astral
/// text can shift the window a few code units — the match itself is always
/// correct). The returned offsets are UTF-8 **byte** offsets into the preview
/// string so a Rust consumer can byte-slice them without panicking.
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
    let preview_char_len = window_end.saturating_sub(window_start);
    let match_start_char = match_index
        .saturating_sub(window_start)
        .min(preview_char_len);
    let match_end_char = match_index
        .saturating_add(query_len)
        .saturating_sub(window_start)
        .min(preview_char_len)
        .max(match_start_char);
    let match_start = char_to_byte(&preview, match_start_char);
    let match_end = char_to_byte(&preview, match_end_char);
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

/// Ensure the index for `version_id` is built, then run `query`, returning
/// line-level results capped at `limit` (default [`DEFAULT_SEARCH_LIMIT`]). This
/// is the index-backed orchestration: file results carry inline text and are
/// previewed directly; chat candidates are hydrated into the same read-only
/// Markdown projection the TypeScript workspace-search contract scans.
///
/// A too-short query (under [`MIN_TRIGRAM_QUERY_CHARS`]) yields no results here
/// rather than a linear fallback. Custom visibility hooks remain an adapter
/// concern; the daemon-owned desktop surface uses the engine's live file policy.
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

    index::ensure_search_index_for_version(
        conn,
        root_dir,
        workspace_id,
        version_id,
        now_ms,
        &dohc_engine_storage::NoFaults,
    )?;
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
                let (path, title, projection) =
                    chat_thread_search_projection(conn, workspace_id, &thread_id)?;
                let remaining = cap.saturating_sub(results.len());
                for hit in preview_line_matches(&projection, &normalized, remaining) {
                    results.push(SearchResult {
                        surface: SearchSurface::Chat,
                        path: path.clone(),
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
    results.truncate(cap);
    Ok(results)
}

fn chat_thread_search_projection(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
) -> Result<(String, String, String), SearchError> {
    let (mut thread, first_body) = conn
        .query_row(
            "SELECT t.title, t.created_at_ms, t.updated_at_ms, t.channel_id, \
                    t.linked_object_id, t.linked_path_hint, t.linked_at_ms, \
                    (SELECT m.body FROM chat_messages m \
                     WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id \
                     ORDER BY m.message_order LIMIT 1) \
             FROM chat_threads t WHERE t.workspace_id = ?1 AND t.thread_id = ?2",
            rusqlite::params![workspace_id, thread_id],
            |row| {
                Ok((
                    ChatThread {
                        workspace_id: workspace_id.to_owned(),
                        thread_id: thread_id.to_owned(),
                        title: row.get(0)?,
                        created_at_ms: row.get(1)?,
                        updated_at_ms: row.get(2)?,
                        channel_id: row.get(3)?,
                        linked_object_id: row.get(4)?,
                        linked_path_hint: row.get(5)?,
                        linked_at_ms: row.get(6)?,
                    },
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .map_err(SearchError::from)?;
    thread.title = index::display_title_for(&thread.title, first_body.as_deref());
    let mut messages = Vec::new();
    let mut statement = conn.prepare(
        "SELECT message_order, message_id, author_kind, author_display_name, \
                author_user_id, parent_message_id, origin, body, created_at_ms \
         FROM chat_messages WHERE workspace_id = ?1 AND thread_id = ?2 \
         ORDER BY message_order",
    )?;
    let mut rows = statement.query(rusqlite::params![workspace_id, thread_id])?;
    while let Some(row) = rows.next()? {
        let author_kind = match row.get::<_, String>(2)?.as_str() {
            "human" => ChatActorKind::Human,
            "agent" => ChatActorKind::Agent,
            _ => {
                return Err(SearchError::Corrupt(
                    "chat message has an unknown author kind",
                ));
            }
        };
        messages.push(ChatMessage {
            workspace_id: workspace_id.to_owned(),
            thread_id: thread_id.to_owned(),
            message_order: row.get(0)?,
            message_id: row.get(1)?,
            author_kind,
            author_display_name: row.get(3)?,
            author_user_id: row.get(4)?,
            parent_message_id: row.get(5)?,
            origin: row.get(6)?,
            body: row.get(7)?,
            created_at_ms: row.get(8)?,
            attachments: Vec::new(),
        });
    }
    let path = linked_chat_projection_path(workspace_id, thread_id, None)
        .map_err(|_| SearchError::Corrupt("chat projection path is invalid"))?;
    let projection =
        render_chat_thread_projection(&thread, &messages, &ChatProjectionFileAccess::Unknown)
            .map_err(|_| SearchError::Corrupt("chat projection is invalid"))?;
    Ok((path, thread.title, projection))
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
}
