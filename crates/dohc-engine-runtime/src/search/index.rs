//! FTS index maintenance: per-write upserts and the durable per-version
//! rebuild. Ports the TS `upsertFileSearchIndex` /
//! `deleteFileSearchIndex` / `upsertThreadHeaderSearchIndex` /
//! `upsertChatMessageSearchIndex` / `ensureSearchIndexForVersion`.
//!
//! Every function here runs against the connection/transaction the caller hands
//! it, so a search-index change commits in the same transaction as the mutation
//! it accompanies (read-your-writes; no index/content divergence on crash). The
//! per-version rebuild is idempotent by an `engine_search_index_state` row — a
//! crash mid-rebuild leaves that row unwritten, so reopen repairs.

use crate::search::policy::{
    SearchPolicySnapshot, path_is_search_indexed, read_engine_search_policy,
};
use crate::search::{SearchError, THREAD_HEADER_MESSAGE_ID};
use dohc_engine_domain::chats::{
    chat_message_search_text, chat_thread_display_title, upsert_chat_search_index_row,
};
use dohc_engine_files::search_text::extract_search_text;
use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint};
use rusqlite::{Connection, params};
use std::path::Path;

/// Consult the mid-rebuild crash point. Unlike the storage crate's per-op write
/// lane (cfg-gated to be provably zero-cost), this is polled once per index
/// rebuild — an infrequent, heavy operation — so a single `NoFaults` poll (a
/// trivial match returning `Continue`) is negligible and left ungated. Ungated
/// also keeps the crash regression testable via a `ScriptedFaults` injector
/// without depending on the runtime crate's `fault-injection` feature being
/// unified on for `cargo test`.
#[inline]
fn should_crash(faults: &dyn FaultInjector, point: FaultPoint) -> bool {
    faults.poll(point) == FaultAction::Crash
}

/// Hard ceiling on rows processed in one rebuild pass — a DoS bound the TS
/// engine lacks (approved-delta style). Far above any realistic per-version
/// file count / per-workspace message count; exceeding it fails the rebuild
/// closed rather than building an unbounded in-flight statement stream.
const MAX_REBUILD_ROWS: usize = 5_000_000;

/// Reserved `indexed_at_ms` value certifying the current file and chat index
/// generation. The previous `-1` generation indexed raw Excalidraw JSON, so it
/// must rebuild once. A future index-format change can bump this sentinel again.
const SEARCH_INDEX_CERTIFICATION: i64 = -2;

/// Stored title (`""` = untitled) + first message body -> display title. Ports
/// the TS `threadDisplayTitle`.
fn thread_display_title(stored_title: &str, first_body: Option<&str>) -> String {
    chat_thread_display_title(stored_title, first_body)
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
    chat_message_search_text(display_name, is_agent, body)
}

/// Delete a file's FTS row by its exact key.
fn delete_file_index_row(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<(), SearchError> {
    conn.prepare_cached(
        "DELETE FROM engine_search_files_fts \
         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
    )?
    .execute(params![workspace_id, version_id, object_id])?;
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
    conn.prepare_cached(
        "INSERT INTO engine_search_files_fts \
         (workspace_id, version_id, object_id, path, text) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?
    .execute(params![workspace_id, version_id, object_id, path, text])?;
    Ok(())
}

/// Upsert a single text file's FTS row, respecting the fail-closed FILE policy
/// freeze. Ports `upsertFileSearchIndex`. Reads the policy
/// off `root_dir`; a broken policy freezes the file index — the FTS rows and the
/// existing FTS rows are left untouched, so nothing is dropped while degraded.
/// Any existing healthy `engine_search_index_state` row is marked degraded in
/// the same transaction, so the later degraded→healthy transition rebuilds the
/// file index and picks up everything written during the degraded window.
/// Query-time `path_is_search_indexed` fails file search closed meanwhile.
///
/// Under a healthy policy the row is delete-then-conditionally-re-inserted (a
/// binary/policy-excluded path ends delete-only).
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
    maintain_file_search_index_with_policy(
        conn,
        &policy,
        workspace_id,
        version_id,
        object_id,
        path,
        text,
        true,
    )
}

/// Maintain the FTS row for a newly committed capture moment.
///
/// A non-deduped moment minted by the current schema records whether it had a
/// concrete live preimage. A version fork can still have an indexed fallback
/// from `fork_base_snapshots`, so that indexed preimage is checked by its
/// primary key before skipping the otherwise full-table FTS5 metadata-key
/// DELETE. Public upsert callers stay conservative and always remove an
/// existing row first.
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_file_search_index_for_capture(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
    text: &str,
    had_preimage: bool,
) -> Result<(), SearchError> {
    let inherited_preimage = if had_preimage || policy.is_degraded() {
        false
    } else {
        conn.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM fork_base_snapshots \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3)",
        )?
        .query_row(params![workspace_id, version_id, object_id], |row| {
            row.get::<_, bool>(0)
        })?
    };
    maintain_file_search_index_with_policy(
        conn,
        policy,
        workspace_id,
        version_id,
        object_id,
        path,
        text,
        had_preimage || inherited_preimage,
    )
}

#[allow(clippy::too_many_arguments)]
fn maintain_file_search_index_with_policy(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
    text: &str,
    remove_existing: bool,
) -> Result<(), SearchError> {
    if policy.is_degraded() {
        // Freeze, don't drop. Invalidate an existing healthy certification in
        // this mutation transaction; no row already means ensure must rebuild.
        conn.execute(
            "UPDATE engine_search_index_state SET file_policy_degraded = 1 \
             WHERE workspace_id = ?1 AND version_id = ?2",
            params![workspace_id, version_id],
        )?;
        return Ok(());
    }
    if remove_existing {
        delete_file_index_row(conn, workspace_id, version_id, object_id)?;
    }
    if !path_is_search_indexed(policy, path) {
        return Ok(());
    }
    let search_text = extract_search_text(path, text);
    insert_file_index_row(
        conn,
        workspace_id,
        version_id,
        object_id,
        path,
        &search_text,
    )
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
fn upsert_thread_header_search_index(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
    title: &str,
) -> Result<(), SearchError> {
    upsert_chat_search_index_row(
        conn,
        workspace_id,
        thread_id,
        THREAD_HEADER_MESSAGE_ID,
        &chat_header_text(title),
    )?;
    Ok(())
}

/// Upsert a chat message's FTS row (`upsertChatMessageSearchIndex`).
fn upsert_chat_message_search_index(
    conn: &Connection,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
    display_name: &str,
    is_agent: bool,
    body: &str,
) -> Result<(), SearchError> {
    upsert_chat_search_index_row(
        conn,
        workspace_id,
        thread_id,
        message_id,
        &chat_message_text(display_name, is_agent, body),
    )?;
    Ok(())
}

fn rebuild_file_index_for_version(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
) -> Result<(), SearchError> {
    // Snapshots (text) union the fork-base fallback for objects not re-owned in
    // this version, joined to the text blob, ORDER BY path — the exact TS
    // candidate set and order. Since BINHEAD, `snapshots`/`fork_base_snapshots`
    // carry a `content_kind` column and can hold binary heads (text `blob_sha256`
    // NULL, `binary_sha256` set); those must not enter the file FTS index — the TS
    // oracle deletes a path's file-search row on a binary write. The exclusion is
    // made explicit via `content_kind IS NOT 'binary'` in each candidate branch so
    // a future refactor of the text-blob JOIN (e.g. Inner -> left) cannot leak a
    // binary path into the file index; the inner `JOIN blobs` below also drops
    // NULL-blob binary rows, but that is now a belt-and-suspenders backstop, not
    // the sole guarantee. `IS NOT 'binary'` (not `= 'text'`) preserves today's
    // behavior for a defensively-NULL content_kind row that still carries a text
    // blob — those are treated as text everywhere else via COALESCE and must stay
    // indexed; only an explicit binary head is excluded.
    let mut stmt = conn.prepare(
        "SELECT candidate.object_id, candidate.path, b.text \
         FROM ( \
           SELECT s.object_id, s.path, s.blob_sha256 \
           FROM snapshots s \
           WHERE s.workspace_id = ?1 AND s.version_id = ?2 \
             AND s.content_kind IS NOT 'binary' \
           UNION ALL \
           SELECT fb.object_id, fb.path, fb.blob_sha256 \
           FROM fork_base_snapshots fb \
           WHERE fb.workspace_id = ?1 AND fb.version_id = ?2 \
             AND fb.content_kind IS NOT 'binary' \
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
        let search_text = extract_search_text(&path, &text);
        insert_file_index_row(
            conn,
            workspace_id,
            version_id,
            &object_id,
            &path,
            &search_text,
        )?;
    }
    Ok(())
}

fn rebuild_chat_index_for_workspace(
    conn: &Connection,
    workspace_id: &str,
) -> Result<(), SearchError> {
    // Header rows: one per thread, ORDER BY created_at_ms, thread_id. A thread
    // whose ownership is malformed (both/neither owner) or whose channel owner
    // is gone (an orphan left by a channel delete — `chat_threads.channel_id`
    // has no FK/cascade, and a replicated store can be transiently inconsistent)
    // is skipped, never a hard error: one bad thread must at most omit its own
    // header row, not disable search workspace-wide. (Diverges from the TS
    // `validatedThreadSearchRow` throw; recorded as a robustness delta — the
    // skip is strictly fail-safe: a skipped thread simply is not searchable by
    // title until repaired, and its messages still index in the loop below,
    // matching the TS message loop which never validates ownership.)
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
                // A row with no id cannot key an FTS row at all — skip it.
                continue;
            }
            // Exactly one owner (the XOR). A malformed thread is skipped, not a
            // hard error.
            if linked_object_id.is_some() == channel_id.is_some() {
                continue;
            }
            // A channel thread whose channel row is gone is an orphan: skip its
            // header (its messages still index below), never break all search.
            if channel_id.is_some() && channel_owner_exists != 1 {
                continue;
            }
            let display = thread_display_title(&title, first_body.as_deref());
            upsert_thread_header_search_index(conn, workspace_id, &thread_id, &display)?;
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
            upsert_chat_message_search_index(
                conn,
                workspace_id,
                &thread_id,
                &message_id,
                &display_name,
                is_agent,
                &body,
            )?;
        }
    }
    Ok(())
}

/// Ensure the FTS index for `version_id` is built, repairing durably. Ports
/// `ensureSearchIndexForVersion` with two hardening deltas.
///
/// **Atomic on any connection.** The whole rebuild (FTS wipes + inserts + the
/// state row) runs inside its own `SAVEPOINT`, so it is atomic and crash-safe
/// regardless of whether the caller is inside a transaction (`write_with`) or on
/// an autocommit borrow (`read_with`). A crash mid-rebuild rolls the savepoint
/// back — no reader ever observes a torn/partial generation, and no state row is
/// certified. (The TS engine relied on its `serialize()` single BEGIN/COMMIT;
/// the Rust query path can run on a bare connection, so the savepoint carries
/// the guarantee instead of the caller.)
///
/// **Durable generation markers.**
/// `engine_search_index_state.file_policy_degraded` records whether a generation
/// was built under a broken FILE policy, while `indexed_at_ms` carries the
/// reserved [`SEARCH_INDEX_CERTIFICATION`] sentinel for the current index
/// generation. Older rows force one rebuild after an index-format change.
/// Work happens only when there is no current
/// certification OR the degraded status changed since the last build:
/// - healthy build: wipe+rebuild the version's files, rebuild chat, mark `0`.
/// - degraded build: freeze the file FTS (leave every row — nothing dropped),
///   rebuild chat (chat is independent of the FILE policy), mark `1`.
/// - a degraded→healthy transition rebuilds files (picking up degraded-window
///   writes); a stable degraded window is a cheap early-return, so chat is not
///   re-wiped+rebuilt on every query (the TS per-query rebuild is avoided).
///
/// Query-time `path_is_search_indexed` still fails FILE search closed while
/// degraded regardless of what the frozen file index holds.
pub fn ensure_search_index_for_version(
    conn: &Connection,
    root_dir: &Path,
    workspace_id: &str,
    version_id: &str,
    _now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<(), SearchError> {
    let policy = read_engine_search_policy(root_dir);
    let current_degraded = policy.is_degraded();

    // The last-built degraded status and index generation for this version, if
    // any. An older marker is deliberately not a current certification.
    let stored_state: Option<(bool, bool)> = conn
        .query_row(
            "SELECT file_policy_degraded, indexed_at_ms FROM engine_search_index_state \
             WHERE workspace_id = ?1 AND version_id = ?2",
            params![workspace_id, version_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)? != 0,
                    row.get::<_, i64>(1)? == SEARCH_INDEX_CERTIFICATION,
                ))
            },
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(SearchError::from(other)),
        })?;
    if stored_state == Some((current_degraded, true)) {
        // Up to date: healthy-stable or degraded-stable. No rebuild, no per-query
        // chat wipe.
        return Ok(());
    }

    // Atomic rebuild in its own savepoint so a crash rolls the whole thing back
    // even on an autocommit connection.
    const SAVEPOINT: &str = "dohc_search_ensure";
    conn.execute_batch(&format!("SAVEPOINT {SAVEPOINT}"))?;
    match rebuild_within_savepoint(
        conn,
        &policy,
        workspace_id,
        version_id,
        current_degraded,
        faults,
    ) {
        Ok(true) => {
            conn.execute_batch(&format!("RELEASE {SAVEPOINT}"))?;
            Ok(())
        }
        Ok(false) => {
            // Crash-injection fired mid-rebuild: undo everything, leave no torn
            // generation and no state row.
            conn.execute_batch(&format!("ROLLBACK TO {SAVEPOINT}; RELEASE {SAVEPOINT}"))?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute_batch(&format!("ROLLBACK TO {SAVEPOINT}; RELEASE {SAVEPOINT}"));
            Err(err)
        }
    }
}

/// The rebuild body, run inside the caller's savepoint. Returns `Ok(true)` on a
/// complete rebuild, `Ok(false)` when the mid-rebuild crash fault fired (the
/// caller rolls back).
fn rebuild_within_savepoint(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
    current_degraded: bool,
    faults: &dyn FaultInjector,
) -> Result<bool, SearchError> {
    if !current_degraded {
        // Healthy: the file index is authoritative — wipe and rebuild it.
        conn.execute(
            "DELETE FROM engine_search_files_fts WHERE workspace_id = ?1 AND version_id = ?2",
            params![workspace_id, version_id],
        )?;
        rebuild_file_index_for_version(conn, policy, workspace_id, version_id)?;
    }
    // Degraded: freeze the file FTS (no wipe, no rebuild) — nothing is dropped.

    // Chat is independent of the FILE policy and is rebuilt on every (re)index.
    conn.execute(
        "DELETE FROM engine_search_chat_messages_fts WHERE workspace_id = ?1",
        params![workspace_id],
    )?;
    // Crash-injection point: chat FTS is wiped but not yet rebuilt. Without the
    // savepoint an autocommit connection would leave this DELETE durable (a torn
    // empty chat index); the rollback proves it does not.
    if should_crash(faults, FaultPoint::SearchIndexMidRebuild) {
        return Ok(false);
    }
    rebuild_chat_index_for_workspace(conn, workspace_id)?;

    conn.execute(
        "INSERT INTO engine_search_index_state \
         (workspace_id, version_id, indexed_at_ms, file_policy_degraded) \
         VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(workspace_id, version_id) DO UPDATE SET \
           indexed_at_ms = excluded.indexed_at_ms, \
           file_policy_degraded = excluded.file_policy_degraded",
        params![
            workspace_id,
            version_id,
            SEARCH_INDEX_CERTIFICATION,
            i64::from(current_degraded)
        ],
    )?;
    Ok(true)
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
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn snippet_title_collapses_and_bounds() {
        assert_eq!(thread_display_title("", Some("")), "New chat");
        assert_eq!(
            thread_display_title("", Some("hello   world\nsecond")),
            "hello world"
        );
        let long = "a".repeat(200);
        let title = thread_display_title("", Some(long.as_str()));
        assert!(title.ends_with('\u{2026}'));
        assert_eq!(
            title.chars().count(),
            dohc_engine_domain::chats::THREAD_SNIPPET_TITLE_MAX_CHARS
        );
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

    #[test]
    fn fifteen_thousand_fresh_capture_rows_issue_no_fts_delete() {
        const ROWS: usize = 15_000;
        let scratch = dohc_engine_testkit::ScratchDir::new().expect("scratch");
        let policy = read_engine_search_policy(scratch.path());
        let mut conn = Connection::open_in_memory().expect("open memory database");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE engine_search_files_fts USING fts5(\
                 workspace_id UNINDEXED, version_id UNINDEXED, \
                 object_id UNINDEXED, path UNINDEXED, text, tokenize='trigram'\
             );\
             CREATE TABLE fork_base_snapshots (\
                 workspace_id TEXT NOT NULL, version_id TEXT NOT NULL, \
                 object_id TEXT NOT NULL, \
                 PRIMARY KEY (workspace_id, version_id, object_id)\
             );",
        )
        .expect("create file FTS");

        // The authorizer runs when SQLite prepares a statement. Denying a
        // top-level DELETE on the FTS table makes this a direct execution-path
        // proof rather than a timing assertion: one attempted per-file delete
        // fails the test immediately.
        let deletes = Arc::new(AtomicUsize::new(0));
        let observed_deletes = Arc::clone(&deletes);
        conn.authorizer(Some(move |context: AuthContext<'_>| match context.action {
            AuthAction::Delete {
                table_name: "engine_search_files_fts",
            } => {
                observed_deletes.fetch_add(1, Ordering::Relaxed);
                Authorization::Deny
            }
            _ => Authorization::Allow,
        }))
        .expect("install delete guard");

        let tx = conn.transaction().expect("begin fresh index transaction");
        for index in 0..ROWS {
            let object_id = format!("fresh-object-{index:05}");
            let path = format!("note-{index:05}.md");
            update_file_search_index_for_capture(
                &tx,
                &policy,
                "fresh-workspace",
                "main",
                &object_id,
                &path,
                "fresh capture body",
                false,
            )
            .expect("insert fresh capture row");
        }
        tx.commit().expect("commit fresh index transaction");

        let (rows, objects): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COUNT(DISTINCT object_id) \
                 FROM engine_search_files_fts",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("count fresh FTS rows");
        assert_eq!((rows, objects), (ROWS as i64, ROWS as i64));
        assert_eq!(deletes.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn fork_base_capture_replaces_its_fallback_fts_row() {
        let scratch = dohc_engine_testkit::ScratchDir::new().expect("scratch");
        let policy = read_engine_search_policy(scratch.path());
        let conn = Connection::open_in_memory().expect("open memory database");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE engine_search_files_fts USING fts5(\
                 workspace_id UNINDEXED, version_id UNINDEXED, \
                 object_id UNINDEXED, path UNINDEXED, text, tokenize='trigram'\
             );\
             CREATE TABLE fork_base_snapshots (\
                 workspace_id TEXT NOT NULL, version_id TEXT NOT NULL, \
                 object_id TEXT NOT NULL, \
                 PRIMARY KEY (workspace_id, version_id, object_id)\
             );\
             INSERT INTO fork_base_snapshots (workspace_id, version_id, object_id) \
             VALUES ('workspace', 'branch', 'object');\
             INSERT INTO engine_search_files_fts \
             (workspace_id, version_id, object_id, path, text) \
             VALUES ('workspace', 'branch', 'object', 'old.md', 'stale fallback text');",
        )
        .expect("seed fork fallback index");

        update_file_search_index_for_capture(
            &conn,
            &policy,
            "workspace",
            "branch",
            "object",
            "new.md",
            "replacement text",
            false,
        )
        .expect("replace fallback index row");

        let rows: Vec<(String, String)> = conn
            .prepare(
                "SELECT path, text FROM engine_search_files_fts \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            )
            .expect("prepare index query")
            .query_map(params!["workspace", "branch", "object"], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .expect("query index")
            .collect::<rusqlite::Result<_>>()
            .expect("read index rows");
        assert_eq!(
            rows,
            vec![("new.md".to_owned(), "replacement text".to_owned())]
        );
    }

    #[test]
    fn public_file_upsert_remains_conservative_delete_first() {
        let scratch = dohc_engine_testkit::ScratchDir::new().expect("scratch");
        let conn = Connection::open_in_memory().expect("open memory database");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE engine_search_files_fts USING fts5(\
                 workspace_id UNINDEXED, version_id UNINDEXED, \
                 object_id UNINDEXED, path UNINDEXED, text, tokenize='trigram'\
             );",
        )
        .expect("create file FTS");
        let deletes = Arc::new(AtomicUsize::new(0));
        let observed_deletes = Arc::clone(&deletes);
        conn.authorizer(Some(move |context: AuthContext<'_>| match context.action {
            AuthAction::Delete {
                table_name: "engine_search_files_fts",
            } => {
                observed_deletes.fetch_add(1, Ordering::Relaxed);
                Authorization::Deny
            }
            _ => Authorization::Allow,
        }))
        .expect("install delete guard");

        let error = upsert_file_search_index(
            &conn,
            scratch.path(),
            "workspace",
            "main",
            "object",
            "note.md",
            "body",
        )
        .expect_err("public upsert must attempt its conservative delete");
        assert!(matches!(error, SearchError::Storage(_)));
        assert_eq!(deletes.load(Ordering::Relaxed), 1);
    }
}
