//! A message the relay deleted. The relay is the only writer: it rewrites the
//! message's append into a `chat.message.tombstone` at the same coordinate and
//! appends a `chat.message.delete` from a `relay:message-delete:` origin. A
//! deleted message keeps its line, with its author and time and an empty body,
//! and loses its mentions, attachments and search row. Replies keep pointing
//! at it.

use super::{
    CHAT_THREAD_HEADER_MESSAGE_ID, bump_chat_conversation_revision, chat_thread_display_title,
    mark_live_bookmarks_pending, upsert_chat_search_index_row,
};
use crate::error::DomainError;
use rusqlite::{OptionalExtension, Transaction, params};

pub const MESSAGE_TOMBSTONE_OP_KIND: &str = "chat.message.tombstone";
pub const MESSAGE_DELETE_OP_KIND: &str = "chat.message.delete";
pub const MESSAGE_DELETE_ORIGIN_PREFIX: &str = "relay:message-delete:";

/// The thread a deleted message was in, and when the relay deleted it.
pub fn deleted_message(
    tx: &Transaction<'_>,
    workspace_id: &str,
    message_id: &str,
) -> Result<Option<(String, i64)>, DomainError> {
    tx.query_row(
        "SELECT thread_id, deleted_at_ms FROM chat_deleted_messages \
         WHERE workspace_id=?1 AND message_id=?2",
        params![workspace_id, message_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

/// Keeps the delete, so an append that applies later goes in deleted. Returns
/// false when an earlier delete of the message named another thread.
pub fn record_message_delete(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
    deleted_at_ms: i64,
) -> Result<bool, DomainError> {
    tx.execute(
        "INSERT OR IGNORE INTO chat_deleted_messages \
         (workspace_id, message_id, thread_id, deleted_at_ms) VALUES (?1, ?2, ?3, ?4)",
        params![workspace_id, message_id, thread_id, deleted_at_ms],
    )
    .map_err(DomainError::sql_persist)?;
    let (held, _) =
        deleted_message(tx, workspace_id, message_id)?.ok_or(DomainError::StateCorrupt {
            reason: "a recorded message delete is missing",
        })?;
    Ok(held == thread_id)
}

/// Clears a stored message the relay deleted: its body, work report, reported
/// agent, mentions, attachments and search row. Returns false when the stored
/// message is in another thread. A message not stored yet changes nothing.
pub fn erase_deleted_message(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
    deleted_at_ms: i64,
) -> Result<bool, DomainError> {
    let stored: Option<(String, Option<i64>)> = tx
        .query_row(
            "SELECT thread_id, deleted_at_ms FROM chat_messages \
             WHERE workspace_id=?1 AND message_id=?2",
            params![workspace_id, message_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    let Some((stored_thread, stored_deleted)) = stored else {
        return Ok(true);
    };
    if stored_thread != thread_id {
        return Ok(false);
    }
    if stored_deleted.is_some() {
        return Ok(true);
    }
    tx.execute(
        "UPDATE chat_messages SET body='', work=NULL, author_reported=NULL, deleted_at_ms=?3 \
         WHERE workspace_id=?1 AND message_id=?2",
        params![workspace_id, message_id, deleted_at_ms],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "DELETE FROM chat_mentions WHERE workspace_id=?1 AND message_id=?2",
        params![workspace_id, message_id],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "DELETE FROM chat_attachments WHERE workspace_id=?1 AND thread_id=?2 AND message_id=?3",
        params![workspace_id, thread_id, message_id],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "DELETE FROM engine_search_chat_messages_fts \
         WHERE workspace_id=?1 AND thread_id=?2 AND message_id=?3",
        params![workspace_id, thread_id, message_id],
    )
    .map_err(DomainError::sql_persist)?;
    reindex_header_without(tx, workspace_id, thread_id, message_id)?;
    bump_chat_conversation_revision(tx, workspace_id, thread_id)?;
    Ok(true)
}

/// The fields a deleted message's line keeps.
pub struct DeletedMessageLine<'a> {
    pub thread_id: &'a str,
    pub message_id: &'a str,
    pub author_kind: &'a str,
    pub author_display_name: &'a str,
    pub author_user_id: Option<&'a str>,
    pub author_owner_display_name: Option<&'a str>,
    pub author_agent_id: Option<&'a str>,
    pub parent_message_id: Option<&'a str>,
    pub created_at_ms: i64,
    pub deleted_at_ms: i64,
}

/// Stores a deleted message's line in a thread that exists, with none of a
/// message's side effects: no body, mention, search row, Notice or
/// automation claim. A stored message is left for `erase_deleted_message`.
pub fn insert_deleted_message(
    tx: &Transaction<'_>,
    workspace_id: &str,
    line: &DeletedMessageLine<'_>,
) -> Result<(), DomainError> {
    let previous: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(message_order), -1) FROM chat_messages \
             WHERE workspace_id=?1 AND thread_id=?2",
            params![workspace_id, line.thread_id],
            |row| row.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    let order = previous.checked_add(1).ok_or(DomainError::StateCorrupt {
        reason: "deleted chat message order overflowed",
    })?;
    let parent_exists = if let Some(parent) = line.parent_message_id {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_messages \
             WHERE workspace_id=?1 AND thread_id=?2 AND message_id=?3)",
            params![workspace_id, line.thread_id, parent],
            |row| row.get::<_, bool>(0),
        )
        .map_err(DomainError::sql_corrupt)?
    } else {
        false
    };
    // The relay drops a link message's link from its tombstone. The schema
    // asks a link message to name one, and an empty one names none.
    let link = (line.author_kind == "link").then_some("");
    let inserted = tx
        .execute(
            "INSERT OR IGNORE INTO chat_messages \
             (workspace_id,thread_id,message_order,message_id,author_kind,author_display_name, \
              author_user_id,parent_message_id,body,created_at_ms,author_owner_display_name, \
              link_grant_id,link_principal_id,author_agent_id,deleted_at_ms) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'',?9,?10,?11,?11,?12,?13)",
            params![
                workspace_id,
                line.thread_id,
                order,
                line.message_id,
                line.author_kind,
                line.author_display_name,
                line.author_user_id,
                line.parent_message_id.filter(|_| parent_exists),
                line.created_at_ms,
                line.author_owner_display_name,
                link,
                line.author_agent_id,
                line.deleted_at_ms,
            ],
        )
        .map_err(DomainError::sql_persist)?;
    if inserted == 0 {
        return Ok(());
    }
    if let Some(parent) = line.parent_message_id.filter(|_| !parent_exists)
        && parent != line.message_id
    {
        tx.execute(
            "INSERT OR IGNORE INTO chat_pending_message_parents \
             (workspace_id,child_message_id,thread_id,parent_message_id) VALUES (?1,?2,?3,?4)",
            params![workspace_id, line.message_id, line.thread_id, parent],
        )
        .map_err(DomainError::sql_persist)?;
    }
    // A reply that arrived first still answers it.
    tx.execute(
        "UPDATE chat_messages SET parent_message_id=?3 \
         WHERE workspace_id=?1 AND thread_id=?2 AND message_id IN (\
           SELECT child_message_id FROM chat_pending_message_parents \
           WHERE workspace_id=?1 AND thread_id=?2 AND parent_message_id=?3)",
        params![workspace_id, line.thread_id, line.message_id],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "DELETE FROM chat_pending_message_parents \
         WHERE workspace_id=?1 AND thread_id=?2 AND parent_message_id=?3",
        params![workspace_id, line.thread_id, line.message_id],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "UPDATE chat_threads SET updated_at_ms=MAX(updated_at_ms,?3) \
         WHERE workspace_id=?1 AND thread_id=?2",
        params![workspace_id, line.thread_id, line.created_at_ms],
    )
    .map_err(DomainError::sql_persist)?;
    mark_live_bookmarks_pending(tx, workspace_id, line.thread_id, line.created_at_ms)?;
    reindex_header_without(tx, workspace_id, line.thread_id, line.message_id)?;
    bump_chat_conversation_revision(tx, workspace_id, line.thread_id)
}

/// An untitled thread's search header shows its first message's text. When
/// that message is deleted, the header shows the untitled title.
fn reindex_header_without(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
    message_id: &str,
) -> Result<(), DomainError> {
    let (stored_title, first_message_id): (String, Option<String>) = tx
        .query_row(
            "SELECT title, (SELECT message_id FROM chat_messages \
               WHERE workspace_id=?1 AND thread_id=?2 \
               ORDER BY created_at_ms,message_id LIMIT 1) \
             FROM chat_threads WHERE workspace_id=?1 AND thread_id=?2",
            params![workspace_id, thread_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(DomainError::sql_corrupt)?;
    if stored_title.is_empty() && first_message_id.as_deref() == Some(message_id) {
        upsert_chat_search_index_row(
            tx,
            workspace_id,
            thread_id,
            CHAT_THREAD_HEADER_MESSAGE_ID,
            &chat_thread_display_title("", None),
        )
        .map_err(DomainError::sql_persist)?;
    }
    Ok(())
}
