use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint, TxnOutcome};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;

use dohc_engine_domain::{
    AGENT_CHANNEL_NAME, AGENT_CHANNEL_WIRE_ID, attachment_id_for, channel_slug_for_name,
    is_reaction_emoji_verbatim, parse_mention_handles, validate_addressable_plaintext_path,
};

use crate::journal::{ack_tx, crashes, read_ack_tx};
use crate::{ReplicationEnvelope, SyncError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome<T> {
    Applied(T),
    Skipped,
    Crashed { committed: bool },
}

enum Admission<T> {
    Applied(T),
    Skipped,
}

/// Validate and atomically apply one imported coordinate. `mutation` must make
/// the domain change using the supplied transaction; the imported log row and
/// monotonic peer ack are committed in that same transaction.
pub fn apply_envelope_with<T>(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    mutation: impl FnOnce(&Transaction<'_>, &ReplicationEnvelope) -> Result<T, SyncError>,
) -> Result<ApplyOutcome<T>, SyncError> {
    envelope.validate()?;
    let payload_json = envelope.payload_json()?;
    let result = store.write_with(faults, |tx| {
        let acked = read_ack_tx(tx, &envelope.workspace_id, &envelope.origin_id)?;
        if envelope.origin_seq <= acked {
            // A redelivered coordinate at or below the ack. It must byte-match
            // the row already journaled; a divergent replay (same coordinate,
            // different payload/kind) is a misbehaving origin and fails closed
            // rather than silently advancing the cursor over the divergence —
            // the same check the acked+1 redelivery path below makes.
            let existing: Option<(String, String, i64)> = tx
                .query_row(
                    "SELECT op_kind, payload_json, recorded_at_ms FROM replication_log \
                     WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq = ?3",
                    params![envelope.workspace_id, envelope.origin_id, envelope.origin_seq],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(SyncError::corrupt)?;
            if let Some(row) = existing
                && row != (envelope.op_kind.clone(), payload_json.clone(), envelope.recorded_at_ms)
            {
                return Err(SyncError::CoordinateDiverged);
            }
            return Ok(Admission::Skipped);
        }
        let expected = acked.checked_add(1).ok_or(SyncError::CoordinateDiverged)?;
        if envelope.origin_seq != expected {
            return Err(SyncError::SequenceGap);
        }
        let existing: Option<(String, String, i64)> = tx
            .query_row(
                "SELECT op_kind, payload_json, recorded_at_ms FROM replication_log \
                 WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq = ?3",
                params![envelope.workspace_id, envelope.origin_id, envelope.origin_seq],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        if let Some(row) = existing {
            if row != (envelope.op_kind.clone(), payload_json.clone(), envelope.recorded_at_ms) {
                return Err(SyncError::CoordinateDiverged);
            }
            ack_tx(tx, &envelope.workspace_id, &envelope.origin_id, envelope.origin_seq)?;
            return Ok(Admission::Skipped);
        }
        let value = mutation(tx, envelope)?;
        tx.execute(
            "INSERT INTO replication_log \
             (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, imported) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
            params![
                envelope.workspace_id,
                envelope.origin_id,
                envelope.origin_seq,
                envelope.op_kind,
                payload_json,
                envelope.recorded_at_ms
            ],
        )
        .map_err(SyncError::persist)?;
        ack_tx(tx, &envelope.workspace_id, &envelope.origin_id, envelope.origin_seq)?;
        if crashes(faults, FaultPoint::SyncBeforeApplyCommit) {
            return Err(SyncError::FaultCrash);
        }
        Ok(Admission::Applied(value))
    });
    match result {
        Ok(TxnOutcome::Committed(Admission::Applied(value))) => Ok(ApplyOutcome::Applied(value)),
        Ok(TxnOutcome::Committed(Admission::Skipped)) => Ok(ApplyOutcome::Skipped),
        Ok(TxnOutcome::Crashed { committed }) => Ok(ApplyOutcome::Crashed { committed }),
        Err(SyncError::FaultCrash) => Ok(ApplyOutcome::Crashed { committed: false }),
        Err(err) => Err(err),
    }
}

/// R10's built-in `chat.*` receiver apply dispatch. Structural rows use
/// first-authoritative-writer semantics; reaction/decision/follow/feed cells
/// use deterministic LWW tuples that include the remote origin coordinate.
pub fn apply_chat_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    if !envelope.op_kind.starts_with("chat.") {
        return Err(SyncError::UnsupportedOperation);
    }
    apply_envelope_with(store, envelope, faults, apply_chat_tx)
}

fn decode<T: for<'de> Deserialize<'de>>(value: &serde_json::Value) -> Result<T, SyncError> {
    serde_json::from_value(value.clone()).map_err(|_| SyncError::InvalidInput {
        reason: "chat replication payload is malformed",
    })
}

fn non_empty(value: &str) -> Result<(), SyncError> {
    crate::model::bounded(value, "chat identifier must be non-empty and bounded")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelCreate {
    channel_id: String,
    name: String,
    slug: String,
    kind: String,
    created_at_ms: i64,
    wire_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadCreate {
    thread_id: String,
    title: String,
    created_at_ms: i64,
    linked_object_id: Option<String>,
    linked_path_hint: Option<String>,
    linked_at_ms: Option<i64>,
    channel_slug: Option<String>,
    channel_wire_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageAppend {
    message_id: String,
    thread_id: String,
    author_kind: String,
    author_display_name: String,
    body: String,
    created_at_ms: i64,
    author_user_id: Option<String>,
    parent_message_id: Option<String>,
    origin: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecisionSet {
    thread_id: String,
    message_id: String,
    state: String,
    at_ms: i64,
    resolved_by_message_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReactionSet {
    reaction_id: String,
    message_id: String,
    thread_id: String,
    emoji: String,
    author_id: String,
    author_kind: String,
    author_display_name: String,
    at_ms: i64,
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FollowSet {
    owner_user_id: String,
    target_kind: String,
    target_id: String,
    state: String,
    at_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedReadSet {
    owner_user_id: String,
    last_seen_created_at_ms: i64,
    last_seen_message_id: String,
    at_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentAdd {
    attachment_id: String,
    thread_id: String,
    message_id: String,
    target_kind: String,
    object_id: Option<String>,
    path_hint: Option<String>,
    heading_text: Option<String>,
    heading_anchor: Option<String>,
    heading_occurrence: Option<i64>,
    created_at_ms: i64,
}

pub(crate) fn apply_chat_tx(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    match op.op_kind.as_str() {
        "chat.channel.create" => apply_channel(tx, op, decode(&op.payload)?),
        "chat.thread.create" => apply_thread(tx, op, decode(&op.payload)?),
        "chat.message.append" => apply_message(tx, op, decode(&op.payload)?),
        "chat.decision.set" => apply_decision(tx, op, decode(&op.payload)?),
        "chat.reaction.set" => apply_reaction(tx, op, decode(&op.payload)?),
        "chat.follow.set" => apply_follow(tx, op, decode(&op.payload)?),
        "chat.feed.read.set" => apply_feed_read(tx, op, decode(&op.payload)?),
        "chat.attachment.add" => apply_attachment(tx, op, decode(&op.payload)?),
        _ => Err(SyncError::UnsupportedOperation),
    }
}

fn apply_channel(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    payload: ChannelCreate,
) -> Result<(), SyncError> {
    non_empty(&payload.channel_id)?;
    non_empty(&payload.name)?;
    non_empty(&payload.slug)?;
    if !matches!(payload.kind.as_str(), "channel" | "dm" | "agent") {
        return Err(SyncError::InvalidInput {
            reason: "chat channel kind is invalid",
        });
    }
    // Reserved agent-channel invariant (linkedChatStore.ts replicated apply):
    // the agent kind, the reserved "My agent" name, and its canonical slug all
    // hold IFF the op carries the reserved agent wire id — so a remote op can
    // neither mint a rogue agent-dispatch channel under a non-agent wire nor
    // squat the reserved name/slug on an ordinary channel.
    let carries_agent_wire = payload.wire_id.as_deref() == Some(AGENT_CHANNEL_WIRE_ID);
    let canonical_agent_slug = channel_slug_for_name(AGENT_CHANNEL_NAME);
    if (payload.kind == "agent") != carries_agent_wire
        || (payload.slug == canonical_agent_slug) != carries_agent_wire
        || (payload.name == AGENT_CHANNEL_NAME) != carries_agent_wire
        || (carries_agent_wire
            && (payload.name != AGENT_CHANNEL_NAME || payload.slug != canonical_agent_slug))
    {
        return Err(SyncError::InvalidInput {
            reason: "reserved agent-channel invariant violated",
        });
    }
    let wire_id = payload
        .wire_id
        .clone()
        .unwrap_or_else(|| payload.channel_id.clone());
    non_empty(&wire_id)?;
    let mapped: Option<String> = tx
        .query_row(
            "SELECT channel_id FROM chat_channel_wire_ids WHERE workspace_id = ?1 AND wire_id = ?2",
            params![op.workspace_id, wire_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    if let Some(channel_id) = mapped {
        let placeholder: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_channel_placeholders WHERE workspace_id = ?1 AND channel_id = ?2)",
                params![op.workspace_id, channel_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if placeholder {
            tx.execute(
                "UPDATE chat_channels SET name = ?3, slug = ?4, kind = ?5, created_at_ms = ?6, updated_at_ms = ?6 \
                 WHERE workspace_id = ?1 AND channel_id = ?2",
                params![op.workspace_id, channel_id, payload.name, payload.slug, payload.kind, payload.created_at_ms],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "DELETE FROM chat_channel_placeholders WHERE workspace_id = ?1 AND channel_id = ?2",
                params![op.workspace_id, channel_id],
            )
            .map_err(SyncError::persist)?;
        }
        return Ok(());
    }
    let slug = free_slug(tx, &op.workspace_id, &payload.slug)?;
    tx.execute(
        "INSERT OR IGNORE INTO chat_channels \
         (workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            op.workspace_id,
            payload.channel_id,
            payload.name,
            slug,
            payload.kind,
            payload.created_at_ms
        ],
    )
    .map_err(SyncError::persist)?;
    tx.execute(
        "INSERT OR IGNORE INTO chat_channel_wire_ids (workspace_id, wire_id, channel_id) VALUES (?1, ?2, ?3)",
        params![op.workspace_id, wire_id, payload.channel_id],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn free_slug(
    tx: &Transaction<'_>,
    workspace_id: &str,
    requested: &str,
) -> Result<String, SyncError> {
    for suffix in 1_i64..=100_i64 {
        let candidate = if suffix == 1 {
            requested.to_owned()
        } else {
            format!("{requested}-{suffix}")
        };
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_channels WHERE workspace_id = ?1 AND slug = ?2)",
                params![workspace_id, candidate],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if !exists {
            return Ok(candidate);
        }
    }
    Err(SyncError::InvalidInput {
        reason: "channel slug collision limit exceeded",
    })
}

fn apply_thread(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    payload: ThreadCreate,
) -> Result<(), SyncError> {
    non_empty(&payload.thread_id)?;
    let channel_shape = payload.channel_slug.is_some() || payload.channel_wire_id.is_some();
    if channel_shape == payload.linked_object_id.is_some() {
        return Err(SyncError::InvalidInput {
            reason: "chat thread owner shape is invalid",
        });
    }
    if payload.linked_object_id.is_none()
        && (payload.linked_path_hint.is_some() || payload.linked_at_ms.is_some())
    {
        return Err(SyncError::InvalidInput {
            reason: "chat thread linked owner shape is invalid",
        });
    }
    if let Some(path) = payload.linked_path_hint.as_deref()
        && !matches!(validate_addressable_plaintext_path(path), Ok(normalized) if normalized == path)
    {
        return Err(SyncError::InvalidInput {
            reason: "chat thread linked path is invalid",
        });
    }
    let channel_id = if channel_shape {
        Some(resolve_or_create_placeholder(tx, op, &payload)?)
    } else {
        None
    };
    tx.execute(
        "INSERT OR IGNORE INTO chat_threads \
         (workspace_id, thread_id, title, created_at_ms, updated_at_ms, linked_object_id, linked_path_hint, linked_at_ms, channel_id) \
          VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8)",
        params![op.workspace_id, payload.thread_id, payload.title, payload.created_at_ms, payload.linked_object_id, payload.linked_path_hint, payload.linked_at_ms, channel_id],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn resolve_or_create_placeholder(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    payload: &ThreadCreate,
) -> Result<String, SyncError> {
    let wire = payload
        .channel_wire_id
        .as_deref()
        .or(payload.channel_slug.as_deref())
        .ok_or(SyncError::InvalidInput {
            reason: "channel thread lacks an identity",
        })?;
    if let Some(id) = tx
        .query_row(
            "SELECT channel_id FROM chat_channel_wire_ids WHERE workspace_id = ?1 AND wire_id = ?2",
            params![op.workspace_id, wire],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
    {
        return Ok(id);
    }
    let channel_id = format!("placeholder:{}:{}", op.origin_id, wire);
    let requested_slug = payload.channel_slug.as_deref().unwrap_or("shared-channel");
    let slug = free_slug(tx, &op.workspace_id, requested_slug)?;
    tx.execute(
        "INSERT OR IGNORE INTO chat_channels \
         (workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms) \
         VALUES (?1, ?2, ?3, ?4, 'channel', ?5, ?5)",
        params![
            op.workspace_id,
            channel_id,
            requested_slug,
            slug,
            payload.created_at_ms
        ],
    )
    .map_err(SyncError::persist)?;
    tx.execute(
        "INSERT OR IGNORE INTO chat_channel_wire_ids (workspace_id, wire_id, channel_id) VALUES (?1, ?2, ?3)",
        params![op.workspace_id, wire, channel_id],
    )
    .map_err(SyncError::persist)?;
    tx.execute(
        "INSERT OR IGNORE INTO chat_channel_placeholders (workspace_id, channel_id, wire_id) VALUES (?1, ?2, ?3)",
        params![op.workspace_id, channel_id, wire],
    )
    .map_err(SyncError::persist)?;
    Ok(channel_id)
}

fn apply_message(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    payload: MessageAppend,
) -> Result<(), SyncError> {
    non_empty(&payload.message_id)?;
    non_empty(&payload.thread_id)?;
    if !matches!(payload.author_kind.as_str(), "human" | "agent") {
        return Err(SyncError::InvalidInput {
            reason: "chat author kind is invalid",
        });
    }
    let thread_exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_threads WHERE workspace_id = ?1 AND thread_id = ?2)",
            params![op.workspace_id, payload.thread_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !thread_exists {
        return Err(SyncError::InvalidInput {
            reason: "chat message thread is missing",
        });
    }
    let previous: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(message_order), -1) FROM chat_messages WHERE workspace_id = ?1 AND thread_id = ?2",
            params![op.workspace_id, payload.thread_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    let order = previous
        .checked_add(1)
        .ok_or(SyncError::CoordinateDiverged)?;
    let parent_exists = if let Some(parent) = &payload.parent_message_id {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_messages WHERE workspace_id = ?1 AND thread_id = ?2 AND message_id = ?3)",
            params![op.workspace_id, payload.thread_id, parent],
            |row| row.get::<_, bool>(0),
        )
        .map_err(SyncError::corrupt)?
    } else {
        false
    };
    let stored_parent = if parent_exists {
        payload.parent_message_id.as_deref()
    } else {
        None
    };
    let inserted = tx.execute(
        "INSERT OR IGNORE INTO chat_messages \
         (workspace_id, thread_id, message_order, message_id, author_kind, author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![op.workspace_id, payload.thread_id, order, payload.message_id, payload.author_kind, payload.author_display_name, payload.author_user_id, stored_parent, payload.origin, payload.body, payload.created_at_ms],
    )
    .map_err(SyncError::persist)?;
    if inserted == 0 {
        return Ok(());
    }
    for handle in parse_mention_handles(&payload.body) {
        tx.execute(
            "INSERT OR IGNORE INTO chat_mentions \
             (workspace_id, thread_id, message_id, handle, author_kind, created_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                op.workspace_id,
                payload.thread_id,
                payload.message_id,
                handle,
                payload.author_kind,
                payload.created_at_ms
            ],
        )
        .map_err(SyncError::persist)?;
    }
    if let Some(parent) = payload
        .parent_message_id
        .as_deref()
        .filter(|_| !parent_exists)
    {
        if parent != payload.message_id {
            tx.execute(
                "INSERT OR IGNORE INTO chat_pending_message_parents \
                 (workspace_id, child_message_id, thread_id, parent_message_id) VALUES (?1, ?2, ?3, ?4)",
                params![op.workspace_id, payload.message_id, payload.thread_id, parent],
            )
            .map_err(SyncError::persist)?;
        }
    }
    tx.execute(
        "UPDATE chat_messages SET parent_message_id = ?3 WHERE workspace_id = ?1 AND thread_id = ?2 \
         AND message_id IN (SELECT child_message_id FROM chat_pending_message_parents \
             WHERE workspace_id = ?1 AND thread_id = ?2 AND parent_message_id = ?3)",
        params![op.workspace_id, payload.thread_id, payload.message_id],
    )
    .map_err(SyncError::persist)?;
    tx.execute(
        "DELETE FROM chat_pending_message_parents WHERE workspace_id = ?1 AND thread_id = ?2 AND parent_message_id = ?3",
        params![op.workspace_id, payload.thread_id, payload.message_id],
    )
    .map_err(SyncError::persist)?;
    tx.execute(
        "UPDATE chat_threads SET updated_at_ms = MAX(updated_at_ms, ?3) WHERE workspace_id = ?1 AND thread_id = ?2",
        params![op.workspace_id, payload.thread_id, payload.created_at_ms],
    )
    .map_err(SyncError::persist)?;
    mark_live_bookmarks_pending(
        tx,
        &op.workspace_id,
        &payload.thread_id,
        payload.created_at_ms,
    )?;
    Ok(())
}

fn apply_decision(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    p: DecisionSet,
) -> Result<(), SyncError> {
    if p.thread_id.is_empty()
        || p.message_id.is_empty()
        || p.at_ms < 0
        || !matches!(p.state.as_str(), "open" | "resolved")
        || p.resolved_by_message_id
            .as_ref()
            .is_some_and(String::is_empty)
        || (p.state == "resolved") != p.resolved_by_message_id.is_some()
    {
        return Err(SyncError::InvalidInput {
            reason: "chat decision payload is invalid",
        });
    }
    tx.execute(
        "INSERT INTO chat_decisions \
         (workspace_id, thread_id, message_id, state, resolved_by_message_id, at_ms, origin_id, origin_seq) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
         ON CONFLICT(workspace_id, message_id) DO UPDATE SET \
           thread_id=excluded.thread_id, state=excluded.state, resolved_by_message_id=excluded.resolved_by_message_id, \
           at_ms=excluded.at_ms, origin_id=excluded.origin_id, origin_seq=excluded.origin_seq \
         WHERE (excluded.at_ms, excluded.state='resolved', excluded.origin_id, excluded.origin_seq) > \
               (at_ms, state='resolved', origin_id, origin_seq)",
        params![op.workspace_id, p.thread_id, p.message_id, p.state, p.resolved_by_message_id, p.at_ms, op.origin_id, op.origin_seq],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn apply_reaction(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    p: ReactionSet,
) -> Result<(), SyncError> {
    if p.reaction_id.is_empty()
        || p.message_id.is_empty()
        || p.thread_id.is_empty()
        || p.emoji.is_empty()
        || p.author_id.is_empty()
        || p.author_display_name.is_empty()
        || p.at_ms < 0
        || !is_reaction_emoji_verbatim(&p.emoji)
        || !matches!(p.author_kind.as_str(), "human" | "agent")
        || !matches!(p.state.as_str(), "added" | "removed")
    {
        return Err(SyncError::InvalidInput {
            reason: "chat reaction payload is invalid",
        });
    }
    tx.execute(
        "INSERT INTO chat_reactions \
         (workspace_id,reaction_id,thread_id,message_id,emoji,author_id,author_kind,author_display_name,state,at_ms,origin_id,origin_seq) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) \
         ON CONFLICT(workspace_id,message_id,emoji,author_id) DO UPDATE SET \
           reaction_id=excluded.reaction_id,thread_id=excluded.thread_id,author_kind=excluded.author_kind,
           author_display_name=excluded.author_display_name,state=excluded.state,at_ms=excluded.at_ms,
           origin_id=excluded.origin_id,origin_seq=excluded.origin_seq \
         WHERE (excluded.at_ms, excluded.state, excluded.origin_id, excluded.origin_seq) > \
               (at_ms, state, origin_id, origin_seq)",
        params![op.workspace_id,p.reaction_id,p.thread_id,p.message_id,p.emoji,p.author_id,p.author_kind,p.author_display_name,p.state,p.at_ms,op.origin_id,op.origin_seq],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn apply_follow(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    p: FollowSet,
) -> Result<(), SyncError> {
    if !matches!(
        p.target_kind.as_str(),
        "person" | "agent" | "channel" | "thread"
    ) || !matches!(p.state.as_str(), "following" | "unfollowed")
    {
        return Err(SyncError::InvalidInput {
            reason: "chat follow payload is invalid",
        });
    }
    tx.execute(
        "INSERT INTO chat_follows \
         (workspace_id,owner_user_id,target_kind,target_id,state,updated_at_ms,origin_id,origin_seq) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8) \
         ON CONFLICT(workspace_id,owner_user_id,target_kind,target_id) DO UPDATE SET \
           state=excluded.state,updated_at_ms=excluded.updated_at_ms,origin_id=excluded.origin_id,origin_seq=excluded.origin_seq \
         WHERE (excluded.updated_at_ms, excluded.state, excluded.origin_id, excluded.origin_seq) > \
               (updated_at_ms, state, origin_id, origin_seq)",
        params![op.workspace_id,p.owner_user_id,p.target_kind,p.target_id,p.state,p.at_ms,op.origin_id,op.origin_seq],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn apply_feed_read(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    p: FeedReadSet,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT INTO chat_feed_read_state \
         (workspace_id,owner_user_id,last_seen_created_at_ms,last_seen_message_id,updated_at_ms,origin_id,origin_seq) \
         VALUES (?1,?2,?3,?4,?5,?6,?7) \
         ON CONFLICT(workspace_id,owner_user_id) DO UPDATE SET \
           last_seen_created_at_ms=excluded.last_seen_created_at_ms,last_seen_message_id=excluded.last_seen_message_id,
           updated_at_ms=excluded.updated_at_ms,origin_id=excluded.origin_id,origin_seq=excluded.origin_seq \
         WHERE (excluded.last_seen_created_at_ms, excluded.last_seen_message_id, excluded.updated_at_ms, excluded.origin_id, excluded.origin_seq) > \
               (last_seen_created_at_ms, last_seen_message_id, updated_at_ms, origin_id, origin_seq)",
        params![op.workspace_id,p.owner_user_id,p.last_seen_created_at_ms,p.last_seen_message_id,p.at_ms,op.origin_id,op.origin_seq],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn apply_attachment(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    p: AttachmentAdd,
) -> Result<(), SyncError> {
    let heading_parts_present = [
        p.heading_text.is_some(),
        p.heading_anchor.is_some(),
        p.heading_occurrence.is_some(),
    ];
    let has_heading = heading_parts_present.iter().any(|present| *present);
    let all_heading = heading_parts_present.iter().all(|present| *present);
    let valid_path = p.path_hint.as_deref().is_none_or(|path| {
        matches!(validate_addressable_plaintext_path(path), Ok(normalized) if normalized == path)
    });
    let valid_object = p.object_id.as_deref().is_none_or(|object_id| {
        !object_id.is_empty()
            && object_id.encode_utf16().count() <= 200
            && p.attachment_id
                == attachment_id_for(
                    &p.message_id,
                    object_id,
                    p.heading_anchor.as_deref(),
                    p.heading_occurrence,
                )
    });
    let valid_heading = !has_heading
        || (all_heading
            && p.object_id.is_some()
            && p.heading_text.as_deref().is_some_and(|value| {
                !value.is_empty()
                    && value.encode_utf16().count() <= 300
                    && !has_projection_control_char(value)
            })
            && p.heading_anchor.as_deref().is_some_and(|value| {
                !value.is_empty()
                    && value.encode_utf16().count() <= 400
                    && !has_projection_control_char(value)
            })
            && p.heading_occurrence
                .is_some_and(|value| (0..=9_007_199_254_740_991).contains(&value)));
    if p.attachment_id.is_empty()
        || p.thread_id.is_empty()
        || p.message_id.is_empty()
        || p.target_kind != "file"
        || !valid_object
        || !valid_path
        || !valid_heading
    {
        return Err(SyncError::InvalidInput {
            reason: "chat attachment payload is invalid",
        });
    }
    tx.execute(
        "INSERT OR IGNORE INTO chat_attachments \
         (workspace_id,attachment_id,thread_id,message_id,target_kind,object_id,path_hint,heading_text,heading_anchor,heading_occurrence,created_at_ms) \
         VALUES (?1,?2,?3,?4,'file',?5,?6,?7,?8,?9,?10)",
        params![op.workspace_id,p.attachment_id,p.thread_id,p.message_id,p.object_id,p.path_hint,p.heading_text,p.heading_anchor,p.heading_occurrence,p.created_at_ms],
    )
    .map_err(SyncError::persist)?;
    mark_live_bookmarks_pending(tx, &op.workspace_id, &p.thread_id, p.created_at_ms)?;
    Ok(())
}

fn has_projection_control_char(value: &str) -> bool {
    value
        .chars()
        .any(|character| (character as u32) <= 0x1f || (character as u32) == 0x7f)
}

fn mark_live_bookmarks_pending(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
    at_ms: i64,
) -> Result<(), SyncError> {
    tx.execute(
        "UPDATE chat_bookmark_outbox \
         SET generation = generation + 1, projection_state = 'pending', \
             failure_reason = NULL, updated_at_ms = ?3 \
         WHERE workspace_id = ?1 AND bookmark_id IN ( \
           SELECT bookmark_id FROM chat_bookmarks \
           WHERE workspace_id = ?1 AND thread_id = ?2 AND mode = 'live' AND state = 'active')",
        params![workspace_id, thread_id, at_ms],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}
