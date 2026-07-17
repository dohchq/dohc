//! FTS index maintenance: per-write upserts and the durable per-version
//! rebuild. Ports `searchIndex.ts`'s `upsertFileSearchIndex` /
//! `deleteFileSearchIndex` / `upsertThreadHeaderSearchIndex` /
//! `upsertChatMessageSearchIndex` / `ensureSearchIndexForVersion`.
//!
//! Every function here runs against the connection/transaction the caller hands
//! it, so a search-index change commits in the SAME transaction as the mutation
//! it accompanies (read-your-writes; no index/content divergence on crash). The
//! per-version rebuild is idempotent by an `engine_search_index_state` row — a
//! crash mid-rebuild leaves that row unwritten, so reopen repairs.

use crate::search::policy::{
    PathFloor, SearchPolicySnapshot, classify_engine_file_path, path_is_search_indexed,
    read_engine_search_policy,
};
use crate::search::{SearchError, THREAD_HEADER_MESSAGE_ID};
use rusqlite::{Connection, params};
use std::path::Path;

/// Untitled-thread snippet cap (`THREAD_SNIPPET_TITLE_MAX_CHARS`).
const THREAD_SNIPPET_TITLE_MAX_CHARS: usize = 80;
/// Untitled-thread fallback (`UNTITLED_THREAD_FALLBACK_TITLE`).
const UNTITLED_THREAD_FALLBACK_TITLE: &str = "New chat";

/// Hard ceiling on rows processed in one rebuild pass — a DoS bound the TS
/// engine lacks (approved-delta style). Far above any realistic per-version
/// file count / per-workspace message count; exceeding it fails the rebuild
/// closed rather than building an unbounded in-flight statement stream.
const MAX_REBUILD_ROWS: usize = 5_000_000;

/// First line of `body`, whitespace-collapsed and bounded — the untitled-thread
/// display title. Ports `threadSnippetTitle` (`chatThreadTitle.ts`).
fn thread_snippet_title(body: &str) -> String {
    let first_line_raw = body.split('\n').next().unwrap_or("");
    // Collapse every whitespace run to a single space, then trim.
    let mut collapsed = String::with_capacity(first_line_raw.len());
    let mut in_ws = false;
    for ch in first_line_raw.chars() {
        if ch.is_whitespace() {
            in_ws = true;
        } else {
            if in_ws && !collapsed.is_empty() {
                collapsed.push(' ');
            }
            in_ws = false;
            collapsed.push(ch);
        }
    }
    let first_line = collapsed.trim();
    if first_line.is_empty() {
        return UNTITLED_THREAD_FALLBACK_TITLE.to_owned();
    }
    if first_line.chars().count() <= THREAD_SNIPPET_TITLE_MAX_CHARS {
        return first_line.to_owned();
    }
    // Bound to MAX-1 chars + an ellipsis, trimming trailing space (JS
    // `slice(0, MAX-1).trimEnd()` + "…").
    let kept: String = first_line
        .chars()
        .take(THREAD_SNIPPET_TITLE_MAX_CHARS.saturating_sub(1))
        .collect();
    format!("{}\u{2026}", kept.trim_end())
}

/// Stored title (`""` = untitled) + first message body -> display title. Ports
/// `threadDisplayTitle` (`chatThreadTitle.ts`).
fn thread_display_title(stored_title: &str, first_body: Option<&str>) -> String {
    if !stored_title.is_empty() {
        return stored_title.to_owned();
    }
    match first_body {
        Some(body) => thread_snippet_title(body),
        None => UNTITLED_THREAD_FALLBACK_TITLE.to_owned(),
    }
}

/// The indexed text for a chat header row (title only). Ports `chatIndexText`
/// with only a title.
fn chat_header_text(title: &str) -> String {
    title.to_owned()
}

/// The indexed text for a chat message row. Ports `chatIndexText` with an
/// author + body: displayName, then `displayName (agent)` when the author is an
/// agent, then the body — newline-joined, empty parts dropped.
fn chat_message_text(display_name: &str, is_agent: bool, body: &str) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(3);
    if !display_name.is_empty() {
        parts.push(display_name.to_owned());
        if is_agent {
            parts.push(format!("{display_name} (agent)"));
        }
    }
    if !body.is_empty() {
        parts.push(body.to_owned());
    }
    parts.join("\n")
}

/// Delete a file's FTS row by its exact key.
fn delete_file_index_row(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<(), SearchError> {
    conn.execute(
        "DELETE FROM engine_search_files_fts \
         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
        params![workspace_id, version_id, object_id],
    )?;
    Ok(())
}

/// Insert a file's FTS row.
fn insert_file_index_row(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
    text: &str,
) -> Result<(), SearchError> {
    conn.execute(
        "INSERT INTO engine_search_files_fts \
         (workspace_id, version_id, object_id, path, text) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![workspace_id, version_id, object_id, path, text],
    )?;
    Ok(())
}

/// Upsert a single text file's FTS row, respecting the fail-closed FILE policy
/// freeze. Ports `upsertFileSearchIndex` (`searchIndex.ts`). Reads the policy
/// off `root_dir`; a broken policy FREEZES the file index (rows untouched) and
/// invalidates `engine_search_index_state` for the version so a later fix
/// triggers a full rebuild. Otherwise the row is delete-then-conditionally-
/// re-inserted (a policy-excluded path ends delete-only).
pub fn upsert_file_search_index(
    conn: &Connection,
    root_dir: &Path,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
    text: &str,
) -> Result<(), SearchError> {
    let policy = read_engine_search_policy(root_dir);
    if policy.is_degraded() {
        // Freeze, don't drop: leave FTS rows, but invalidate index_state so a
        // fix rebuilds everything written during the degraded window.
        conn.execute(
            "DELETE FROM engine_search_index_state WHERE workspace_id = ?1 AND version_id = ?2",
            params![workspace_id, version_id],
        )?;
        return Ok(());
    }
    delete_file_index_row(conn, workspace_id, version_id, object_id)?;
    if !path_is_search_indexed(&policy, path) {
        return Ok(());
    }
    insert_file_index_row(conn, workspace_id, version_id, object_id, path, text)
}

/// Unconditionally delete a file's FTS row (`deleteFileSearchIndex`).
pub fn delete_file_search_index(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<(), SearchError> {
    delete_file_index_row(conn, workspace_id, version_id, object_id)
}

/// Upsert a thread's header FTS row (`upsertThreadHeaderSearchIndex`). `title`
/// must already be the display title (the caller derives it the same way the
/// rebuild does, via [`thread_display_title`], so a rebuild reproduces
/// byte-identical rows).
pub fn upsert_thread_header_search_index(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
    title: &str,
) -> Result<(), SearchError> {
    conn.execute(
        "DELETE FROM engine_search_chat_messages_fts \
         WHERE workspace_id = ?1 AND thread_id = ?2 AND message_id = ?3",
        params![workspace_id, thread_id, THREAD_HEADER_MESSAGE_ID],
    )?;
    conn.execute(
        "INSERT INTO engine_search_chat_messages_fts \
         (workspace_id, thread_id, message_id, text) VALUES (?1, ?2, ?3, ?4)",
        params![
            workspace_id,
            thread_id,
            THREAD_HEADER_MESSAGE_ID,
            chat_header_text(title)
        ],
    )?;
    Ok(())
}

/// Upsert a chat message's FTS row (`upsertChatMessageSearchIndex`).
pub fn upsert_chat_message_search_index(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
    display_name: &str,
    is_agent: bool,
    body: &str,
) -> Result<(), SearchError> {
    conn.execute(
        "DELETE FROM engine_search_chat_messages_fts \
         WHERE workspace_id = ?1 AND thread_id = ?2 AND message_id = ?3",
        params![workspace_id, thread_id, message_id],
    )?;
    conn.execute(
        "INSERT INTO engine_search_chat_messages_fts \
         (workspace_id, thread_id, message_id, text) VALUES (?1, ?2, ?3, ?4)",
        params![
            workspace_id,
            thread_id,
            message_id,
            chat_message_text(display_name, is_agent, body)
        ],
    )?;
    Ok(())
}

fn rebuild_file_index_for_version(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
) -> Result<(), SearchError> {
    // Snapshots (text) UNION the fork-base fallback for objects not re-owned in
    // this version, joined to the text blob, ORDER BY path — the exact TS
    // candidate set and order. All Rust `snapshots` rows are text (no
    // content_kind column; binary content lives in `binary_blobs`, never here).
    let mut stmt = conn.prepare(
        "SELECT candidate.object_id, candidate.path, b.text \
         FROM ( \
           SELECT s.object_id, s.path, s.blob_sha256 \
           FROM snapshots s \
           WHERE s.workspace_id = ?1 AND s.version_id = ?2 \
           UNION ALL \
           SELECT fb.object_id, fb.path, fb.blob_sha256 \
           FROM fork_base_snapshots fb \
           WHERE fb.workspace_id = ?1 AND fb.version_id = ?2 \
             AND NOT EXISTS ( \
               SELECT 1 FROM snapshots s \
               WHERE s.workspace_id = fb.workspace_id \
                 AND s.version_id = fb.version_id \
                 AND s.object_id = fb.object_id \
             ) \
         ) candidate \
         JOIN blobs b ON b.sha256 = candidate.blob_sha256 \
         ORDER BY candidate.path",
    )?;
    let mut rows = stmt.query(params![workspace_id, version_id])?;
    let mut processed = 0usize;
    while let Some(row) = rows.next()? {
        processed = processed.saturating_add(1);
        if processed > MAX_REBUILD_ROWS {
            return Err(SearchError::Bounds("file rebuild exceeded row ceiling"));
        }
        let object_id: String = row.get(0)?;
        let path: String = row.get(1)?;
        let text: String = row.get(2)?;
        if !path_is_search_indexed(policy, &path) {
            continue;
        }
        insert_file_index_row(conn, workspace_id, version_id, &object_id, &path, &text)?;
    }
    Ok(())
}

fn rebuild_chat_index_for_workspace(
    conn: &Connection,
    workspace_id: &str,
) -> Result<(), SearchError> {
    // Header rows: one per thread, ORDER BY created_at_ms, thread_id. The
    // ownership validation is fail-closed (both/neither owner, or a channel
    // owner that no longer exists, is corrupt state — never a search row).
    {
        let mut stmt = conn.prepare(
            "SELECT t.thread_id, t.title, t.linked_object_id, t.channel_id, \
                    (SELECT m.body FROM chat_messages m \
                     WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id \
                     ORDER BY m.created_at_ms, m.message_id LIMIT 1) AS first_body, \
                    EXISTS(SELECT 1 FROM chat_channels c \
                     WHERE c.workspace_id = t.workspace_id AND c.channel_id = t.channel_id) \
                      AS channel_owner_exists \
             FROM chat_threads t \
             WHERE t.workspace_id = ?1 \
             ORDER BY t.created_at_ms, t.thread_id",
        )?;
        let mut rows = stmt.query(params![workspace_id])?;
        let mut processed = 0usize;
        while let Some(row) = rows.next()? {
            processed = processed.saturating_add(1);
            if processed > MAX_REBUILD_ROWS {
                return Err(SearchError::Bounds(
                    "chat header rebuild exceeded row ceiling",
                ));
            }
            let thread_id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let linked_object_id: Option<String> = row.get(2)?;
            let channel_id: Option<String> = row.get(3)?;
            let first_body: Option<String> = row.get(4)?;
            let channel_owner_exists: i64 = row.get(5)?;
            if thread_id.is_empty() {
                return Err(SearchError::Corrupt("thread search row missing thread_id"));
            }
            // Exactly one owner (the fail-closed XOR).
            match (linked_object_id.is_some(), channel_id.is_some()) {
                (true, true) | (false, false) => {
                    return Err(SearchError::Corrupt("thread has both or neither owner"));
                }
                _ => {}
            }
            if channel_id.is_some() && channel_owner_exists != 1 {
                return Err(SearchError::Corrupt("channel thread owner missing"));
            }
            let display = thread_display_title(&title, first_body.as_deref());
            conn.execute(
                "INSERT INTO engine_search_chat_messages_fts \
                 (workspace_id, thread_id, message_id, text) VALUES (?1, ?2, ?3, ?4)",
                params![
                    workspace_id,
                    thread_id,
                    THREAD_HEADER_MESSAGE_ID,
                    chat_header_text(&display)
                ],
            )?;
        }
    }
    // Message rows: ORDER BY thread_id, message_order.
    {
        let mut stmt = conn.prepare(
            "SELECT thread_id, message_id, author_kind, author_display_name, body \
             FROM chat_messages WHERE workspace_id = ?1 \
             ORDER BY thread_id, message_order",
        )?;
        let mut rows = stmt.query(params![workspace_id])?;
        let mut processed = 0usize;
        while let Some(row) = rows.next()? {
            processed = processed.saturating_add(1);
            if processed > MAX_REBUILD_ROWS {
                return Err(SearchError::Bounds(
                    "chat message rebuild exceeded row ceiling",
                ));
            }
            let thread_id: String = row.get(0)?;
            let message_id: String = row.get(1)?;
            let author_kind: String = row.get(2)?;
            let display_name: String = row.get(3)?;
            let body: String = row.get(4)?;
            let is_agent = author_kind == "agent";
            conn.execute(
                "INSERT INTO engine_search_chat_messages_fts \
                 (workspace_id, thread_id, message_id, text) VALUES (?1, ?2, ?3, ?4)",
                params![
                    workspace_id,
                    thread_id,
                    message_id,
                    chat_message_text(&display_name, is_agent, &body)
                ],
            )?;
        }
    }
    Ok(())
}

/// Ensure the FTS index for `version_id` is built, repairing durably. Ports
/// `ensureSearchIndexForVersion` (`searchIndex.ts`).
///
/// A committed `engine_search_index_state` row for `(workspace, version)` short-
/// circuits (idempotent). Otherwise the file index for the version and the chat
/// index for the WHOLE workspace (chat is not versioned) are wiped and rebuilt,
/// then the state row is written — but ONLY when the FILE policy is healthy:
/// while degraded, the file index is intentionally skipped and the state row is
/// left unset (fail-closed, scoped to files) so fixing the policy triggers a
/// full rebuild. Chat indexing runs regardless of the FILE policy.
///
/// MUST run inside the caller's single transaction so a query never observes a
/// torn mid-index state, and so a crash mid-rebuild rolls back to leave the
/// state row unwritten (reopen repairs).
pub fn ensure_search_index_for_version(
    conn: &Connection,
    root_dir: &Path,
    workspace_id: &str,
    version_id: &str,
    now_ms: i64,
) -> Result<(), SearchError> {
    let already: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM engine_search_index_state \
             WHERE workspace_id = ?1 AND version_id = ?2",
            params![workspace_id, version_id],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(SearchError::from(other)),
        })?;
    if already.is_some() {
        return Ok(());
    }

    let policy = read_engine_search_policy(root_dir);
    conn.execute(
        "DELETE FROM engine_search_files_fts WHERE workspace_id = ?1 AND version_id = ?2",
        params![workspace_id, version_id],
    )?;
    let policy_ok = !policy.is_degraded();
    if policy_ok {
        rebuild_file_index_for_version(conn, &policy, workspace_id, version_id)?;
    }

    conn.execute(
        "DELETE FROM engine_search_chat_messages_fts WHERE workspace_id = ?1",
        params![workspace_id],
    )?;
    rebuild_chat_index_for_workspace(conn, workspace_id)?;

    // Only certify the version indexed when the FILE index is authoritative.
    if policy_ok {
        conn.execute(
            "INSERT INTO engine_search_index_state (workspace_id, version_id, indexed_at_ms) \
             VALUES (?1, ?2, ?3) \
             ON CONFLICT(workspace_id, version_id) DO UPDATE SET indexed_at_ms = excluded.indexed_at_ms",
            params![workspace_id, version_id, now_ms],
        )?;
    }
    Ok(())
}

/// Whether a path would be indexed as a file at all, ignoring policy rules —
/// used by callers that need the bare floor (`classifyEngineFilePath` !=
/// `secret`/`ignored`). Exposed for parity checks and diagnostics.
pub fn floor_of(path: &str) -> PathFloor {
    classify_engine_file_path(path)
}

/// The display title for an untitled-or-titled thread, derived exactly as the
/// rebuild derives it. Exposed so the orchestration layer reproduces the same
/// title without re-implementing the snippet rule.
pub fn display_title_for(stored_title: &str, first_body: Option<&str>) -> String {
    thread_display_title(stored_title, first_body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_title_collapses_and_bounds() {
        assert_eq!(thread_snippet_title(""), "New chat");
        assert_eq!(thread_snippet_title("hello   world\nsecond"), "hello world");
        let long = "a".repeat(200);
        let title = thread_snippet_title(&long);
        assert!(title.ends_with('\u{2026}'));
        assert_eq!(title.chars().count(), THREAD_SNIPPET_TITLE_MAX_CHARS);
    }

    #[test]
    fn display_title_prefers_stored() {
        assert_eq!(thread_display_title("My thread", Some("body")), "My thread");
        assert_eq!(thread_display_title("", Some("first line")), "first line");
        assert_eq!(thread_display_title("", None), "New chat");
    }

    #[test]
    fn message_text_marks_agent() {
        assert_eq!(chat_message_text("Ada", false, "hi"), "Ada\nhi");
        assert_eq!(
            chat_message_text("Bot", true, "beep"),
            "Bot\nBot (agent)\nbeep"
        );
    }
}
