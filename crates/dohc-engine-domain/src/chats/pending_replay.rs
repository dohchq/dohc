use super::{
    FeedCoordinateResolution, FollowTargetKind, FollowTargetResolution,
    PENDING_CHAT_WORKSPACE_EXISTS_SQL, PendingChatRefusal, PendingChatReplay,
    ThreadMessageResolution, bump_chat_conversation_revision,
    index_replicated_chat_message_search_rows, mark_live_bookmarks_pending,
    normalize_agent_owner_name, normalize_author_user_id, normalize_body, normalize_display_name,
    parse_mention_handles, resolve_feed_coordinate, resolve_follow_target, resolve_thread_message,
};
use crate::AutomationClaim;
use crate::automations::{AutomationGroupMessage, claim_group_message_in_tx};
use crate::error::DomainError;
use rusqlite::{OptionalExtension, Transaction, params};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingFollowSet {
    owner_user_id: String,
    target_kind: String,
    target_id: String,
    state: String,
    at_ms: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingFeedReadSet {
    owner_user_id: String,
    last_seen_created_at_ms: i64,
    last_seen_message_id: String,
    at_ms: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingAttachmentAdd {
    attachment_id: String,
    thread_id: String,
    message_id: String,
    object_id: Option<String>,
    path_hint: Option<String>,
    heading_text: Option<String>,
    heading_anchor: Option<String>,
    heading_occurrence: Option<i64>,
    created_at_ms: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingMessageAppend {
    message_id: String,
    thread_id: String,
    author_kind: String,
    author_display_name: String,
    author_owner_display_name: Option<String>,
    author_user_id: Option<String>,
    parent_message_id: Option<String>,
    origin: Option<String>,
    body: String,
    created_at_ms: i64,
    /// Another computer's automation or agent message sends its chain depth;
    /// sync apply checked it before parking the message.
    chain_depth: Option<u32>,
}

#[derive(Debug)]
struct PendingChatOperation {
    origin_id: String,
    origin_seq: i64,
    op_kind: String,
    payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PendingChatDependency {
    kind: &'static str,
    id: String,
}

enum PendingReplayOutcome {
    Applied,
    Deferred,
    Refused(&'static str),
}

/// Replay only parked chat coordinates whose dependency was changed by one
/// authoritative local or imported mutation.
pub fn replay_pending_chat_coordinates_for_change(
    tx: &Transaction<'_>,
    workspace_id: &str,
    op_kind: &str,
    payload: &serde_json::Value,
) -> Result<PendingChatReplay, DomainError> {
    let mut refusals = Vec::new();
    let mut automation_claims = Vec::new();
    let mut dependencies = changed_chat_dependencies(tx, workspace_id, op_kind, payload)?;
    while let Some(dependency) = dependencies.pop() {
        let pending = pending_chat_operations(tx, workspace_id, &dependency)?;
        for operation in pending {
            tx.execute(
                "DELETE FROM chat_pending_replication \
                 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                params![workspace_id, operation.origin_id, operation.origin_seq],
            )
            .map_err(DomainError::sql_persist)?;
            match replay_pending_chat_operation(
                tx,
                workspace_id,
                &operation,
                &mut automation_claims,
            )? {
                PendingReplayOutcome::Applied => {
                    dependencies.extend(changed_chat_dependencies(
                        tx,
                        workspace_id,
                        &operation.op_kind,
                        &operation.payload,
                    )?);
                }
                PendingReplayOutcome::Deferred => {}
                PendingReplayOutcome::Refused(reason) => {
                    persist_pending_chat_refusal(tx, workspace_id, &operation, reason)?;
                    refusals.push(pending_chat_refusal(&operation, reason));
                }
            }
        }
    }
    Ok(PendingChatReplay {
        refusals,
        automation_claims,
    })
}

/// Re-evaluate every parked coordinate in one workspace against the committed
/// row state visible in the caller's transaction. Domain write boundaries use
/// this after their mutation, so non-journal writers cannot omit a wake-up.
pub fn replay_ready_pending_chat_coordinates(
    tx: &Transaction<'_>,
    workspace_id: &str,
) -> Result<PendingChatReplay, DomainError> {
    let has_pending: bool = tx
        .query_row(PENDING_CHAT_WORKSPACE_EXISTS_SQL, [workspace_id], |row| {
            row.get(0)
        })
        .map_err(DomainError::sql_corrupt)?;
    if !has_pending {
        return Ok(PendingChatReplay::default());
    }

    let mut replay = PendingChatReplay::default();
    loop {
        let pending = pending_chat_operations_for_workspace(tx, workspace_id)?;
        let mut applied = false;
        for operation in pending {
            match replay_pending_chat_operation(
                tx,
                workspace_id,
                &operation,
                &mut replay.automation_claims,
            )? {
                PendingReplayOutcome::Deferred => {}
                PendingReplayOutcome::Applied => {
                    delete_pending_chat_operation(tx, workspace_id, &operation)?;
                    applied = true;
                }
                PendingReplayOutcome::Refused(reason) => {
                    persist_pending_chat_refusal(tx, workspace_id, &operation, reason)?;
                    delete_pending_chat_operation(tx, workspace_id, &operation)?;
                    replay
                        .refusals
                        .push(pending_chat_refusal(&operation, reason));
                }
            }
        }
        if !applied {
            return Ok(replay);
        }
    }
}

fn pending_chat_refusal(
    operation: &PendingChatOperation,
    reason: &'static str,
) -> PendingChatRefusal {
    PendingChatRefusal {
        origin_id: operation.origin_id.clone(),
        origin_seq: operation.origin_seq,
        op_kind: operation.op_kind.clone(),
        reason,
    }
}

fn persist_pending_chat_refusal(
    tx: &Transaction<'_>,
    workspace_id: &str,
    operation: &PendingChatOperation,
    reason: &'static str,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT OR IGNORE INTO replication_pending_refusals \
         (workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) \
         VALUES (?1,?2,?3,?4,'invalid-input',?5)",
        params![
            workspace_id,
            operation.origin_id,
            operation.origin_seq,
            operation.op_kind,
            reason
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn pending_chat_operations_for_workspace(
    tx: &Transaction<'_>,
    workspace_id: &str,
) -> Result<Vec<PendingChatOperation>, DomainError> {
    let mut stmt = tx
        .prepare(
            "SELECT log.origin_id,log.origin_seq,log.op_kind,log.payload_json \
             FROM chat_pending_replication pending \
             JOIN replication_log log \
               ON log.workspace_id=pending.workspace_id \
              AND log.origin_id=pending.origin_id \
              AND log.origin_seq=pending.origin_seq \
             WHERE pending.workspace_id=?1 \
             ORDER BY log.recorded_at_ms,log.origin_id,log.origin_seq",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map([workspace_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(DomainError::sql_corrupt)?;
    let mut operations = Vec::new();
    for row in rows {
        let (origin_id, origin_seq, op_kind, payload_json) =
            row.map_err(DomainError::sql_corrupt)?;
        let payload =
            serde_json::from_str(&payload_json).map_err(|_| DomainError::StateCorrupt {
                reason: "pending chat replication payload is corrupt",
            })?;
        operations.push(PendingChatOperation {
            origin_id,
            origin_seq,
            op_kind,
            payload,
        });
    }
    Ok(operations)
}

fn delete_pending_chat_operation(
    tx: &Transaction<'_>,
    workspace_id: &str,
    operation: &PendingChatOperation,
) -> Result<(), DomainError> {
    tx.execute(
        "DELETE FROM chat_pending_replication \
         WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
        params![workspace_id, operation.origin_id, operation.origin_seq],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn pending_chat_operations(
    tx: &Transaction<'_>,
    workspace_id: &str,
    dependency: &PendingChatDependency,
) -> Result<Vec<PendingChatOperation>, DomainError> {
    let mut stmt = tx
        .prepare(
            "SELECT log.origin_id,log.origin_seq,log.op_kind,log.payload_json \
             FROM chat_pending_replication pending \
             JOIN replication_log log \
               ON log.workspace_id=pending.workspace_id \
              AND log.origin_id=pending.origin_id \
              AND log.origin_seq=pending.origin_seq \
             WHERE pending.workspace_id=?1 \
               AND pending.dependency_kind=?2 AND pending.dependency_id=?3 \
             ORDER BY log.recorded_at_ms,log.origin_id,log.origin_seq",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(
            params![workspace_id, dependency.kind, dependency.id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(DomainError::sql_corrupt)?;
    let mut operations = Vec::new();
    for row in rows {
        let (origin_id, origin_seq, op_kind, payload_json) =
            row.map_err(DomainError::sql_corrupt)?;
        let payload =
            serde_json::from_str(&payload_json).map_err(|_| DomainError::StateCorrupt {
                reason: "pending chat replication payload is corrupt",
            })?;
        operations.push(PendingChatOperation {
            origin_id,
            origin_seq,
            op_kind,
            payload,
        });
    }
    Ok(operations)
}

/// Replay one parked coordinate. A stored message adds its Group automation
/// claims to `automation_claims`.
fn replay_pending_chat_operation(
    tx: &Transaction<'_>,
    workspace_id: &str,
    operation: &PendingChatOperation,
    automation_claims: &mut Vec<AutomationClaim>,
) -> Result<PendingReplayOutcome, DomainError> {
    match operation.op_kind.as_str() {
        "chat.follow.set" => {
            let payload: PendingFollowSet = serde_json::from_value(operation.payload.clone())
                .map_err(|_| DomainError::StateCorrupt {
                    reason: "pending chat follow payload is corrupt",
                })?;
            let target_kind = match payload.target_kind.as_str() {
                "person" => FollowTargetKind::Person,
                "agent" => FollowTargetKind::Agent,
                "channel" => FollowTargetKind::Channel,
                "thread" => FollowTargetKind::Thread,
                _ => {
                    return Ok(PendingReplayOutcome::Refused(
                        "chat follow payload is invalid",
                    ));
                }
            };
            match resolve_follow_target(tx, workspace_id, target_kind, &payload.target_id)? {
                FollowTargetResolution::Missing => {
                    park_pending_chat_operation(
                        tx,
                        workspace_id,
                        operation,
                        "follow-target",
                        &payload.target_id,
                    )?;
                    Ok(PendingReplayOutcome::Deferred)
                }
                FollowTargetResolution::Disallowed => Ok(PendingReplayOutcome::Refused(
                    "chat follow target is not followable",
                )),
                FollowTargetResolution::Followable => {
                    tx.execute(
                        "INSERT INTO chat_follows \
                         (workspace_id,owner_user_id,target_kind,target_id,state,updated_at_ms,origin_id,origin_seq) \
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8) \
                         ON CONFLICT(workspace_id,owner_user_id,target_kind,target_id) DO UPDATE SET \
                           state=excluded.state,updated_at_ms=excluded.updated_at_ms, \
                           origin_id=excluded.origin_id,origin_seq=excluded.origin_seq \
                         WHERE (excluded.updated_at_ms, excluded.state, excluded.origin_id, excluded.origin_seq) > \
                               (updated_at_ms, state, origin_id, origin_seq)",
                        params![
                            workspace_id,
                            payload.owner_user_id,
                            payload.target_kind,
                            payload.target_id,
                            payload.state,
                            payload.at_ms,
                            operation.origin_id,
                            operation.origin_seq
                        ],
                    )
                    .map_err(DomainError::sql_persist)?;
                    Ok(PendingReplayOutcome::Applied)
                }
            }
        }
        "chat.feed.read.set" => {
            let payload: PendingFeedReadSet = serde_json::from_value(operation.payload.clone())
                .map_err(|_| DomainError::StateCorrupt {
                    reason: "pending chat feed-read payload is corrupt",
                })?;
            match resolve_feed_coordinate(
                tx,
                workspace_id,
                &payload.owner_user_id,
                payload.last_seen_created_at_ms,
                &payload.last_seen_message_id,
            )? {
                FeedCoordinateResolution::Missing => {
                    park_pending_chat_operation(
                        tx,
                        workspace_id,
                        operation,
                        "feed-message",
                        &payload.last_seen_message_id,
                    )?;
                    Ok(PendingReplayOutcome::Deferred)
                }
                FeedCoordinateResolution::Disallowed => Ok(PendingReplayOutcome::Refused(
                    "chat feed read coordinate is not visible",
                )),
                FeedCoordinateResolution::Visible => {
                    tx.execute(
                        "INSERT INTO chat_feed_read_state \
                         (workspace_id,owner_user_id,last_seen_created_at_ms,last_seen_message_id,updated_at_ms,origin_id,origin_seq) \
                         VALUES (?1,?2,?3,?4,?5,?6,?7) \
                         ON CONFLICT(workspace_id,owner_user_id) DO UPDATE SET \
                           last_seen_created_at_ms=excluded.last_seen_created_at_ms, \
                           last_seen_message_id=excluded.last_seen_message_id, \
                           updated_at_ms=excluded.updated_at_ms,origin_id=excluded.origin_id, \
                           origin_seq=excluded.origin_seq \
                         WHERE (excluded.last_seen_created_at_ms, excluded.last_seen_message_id, \
                                excluded.updated_at_ms, excluded.origin_id, excluded.origin_seq) > \
                               (last_seen_created_at_ms, last_seen_message_id, updated_at_ms, \
                                origin_id, origin_seq)",
                        params![
                            workspace_id,
                            payload.owner_user_id,
                            payload.last_seen_created_at_ms,
                            payload.last_seen_message_id,
                            payload.at_ms,
                            operation.origin_id,
                            operation.origin_seq
                        ],
                    )
                    .map_err(DomainError::sql_persist)?;
                    Ok(PendingReplayOutcome::Applied)
                }
            }
        }
        "chat.attachment.add" => {
            let payload: PendingAttachmentAdd = serde_json::from_value(operation.payload.clone())
                .map_err(|_| DomainError::StateCorrupt {
                reason: "pending chat attachment payload is corrupt",
            })?;
            match resolve_thread_message(tx, workspace_id, &payload.thread_id, &payload.message_id)?
            {
                ThreadMessageResolution::Missing => {
                    park_pending_chat_operation(
                        tx,
                        workspace_id,
                        operation,
                        "attachment-message",
                        &payload.message_id,
                    )?;
                    Ok(PendingReplayOutcome::Deferred)
                }
                ThreadMessageResolution::DifferentThread => Ok(PendingReplayOutcome::Refused(
                    "chat attachment target message belongs to another thread",
                )),
                ThreadMessageResolution::Present => {
                    let inserted = tx
                        .execute(
                            "INSERT OR IGNORE INTO chat_attachments \
                         (workspace_id,attachment_id,thread_id,message_id,target_kind,object_id, \
                          path_hint,heading_text,heading_anchor,heading_occurrence,created_at_ms) \
                         VALUES (?1,?2,?3,?4,'file',?5,?6,?7,?8,?9,?10)",
                            params![
                                workspace_id,
                                payload.attachment_id,
                                payload.thread_id,
                                payload.message_id,
                                payload.object_id,
                                payload.path_hint,
                                payload.heading_text,
                                payload.heading_anchor,
                                payload.heading_occurrence,
                                payload.created_at_ms
                            ],
                        )
                        .map_err(DomainError::sql_persist)?;
                    if inserted > 0 {
                        bump_chat_conversation_revision(tx, workspace_id, &payload.thread_id)?;
                    }
                    mark_live_bookmarks_pending(
                        tx,
                        workspace_id,
                        &payload.thread_id,
                        payload.created_at_ms,
                    )?;
                    Ok(PendingReplayOutcome::Applied)
                }
            }
        }
        "chat.message.append" => {
            let payload: PendingMessageAppend = serde_json::from_value(operation.payload.clone())
                .map_err(|_| DomainError::StateCorrupt {
                reason: "pending chat message payload is corrupt",
            })?;
            let thread_exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM chat_threads \
                     WHERE workspace_id=?1 AND thread_id=?2)",
                    params![workspace_id, payload.thread_id],
                    |row| row.get(0),
                )
                .map_err(DomainError::sql_corrupt)?;
            if !thread_exists {
                park_pending_chat_operation(
                    tx,
                    workspace_id,
                    operation,
                    "message-thread",
                    &payload.thread_id,
                )?;
                return Ok(PendingReplayOutcome::Deferred);
            }
            automation_claims.extend(apply_pending_message(tx, workspace_id, payload)?);
            Ok(PendingReplayOutcome::Applied)
        }
        _ => Ok(PendingReplayOutcome::Refused(
            "pending chat operation kind is invalid",
        )),
    }
}

fn apply_pending_message(
    tx: &Transaction<'_>,
    workspace_id: &str,
    payload: PendingMessageAppend,
) -> Result<Vec<AutomationClaim>, DomainError> {
    let owner_name = normalize_agent_owner_name(
        payload.author_kind != "human",
        payload.author_owner_display_name.as_deref(),
    )
    .map_err(|_| DomainError::StateCorrupt {
        reason: "chat message owner display name is invalid",
    })?;
    let author_display_name =
        normalize_display_name(&payload.author_display_name).map_err(|_| {
            DomainError::StateCorrupt {
                reason: "pending chat message display name is invalid",
            }
        })?;
    let author_user_id =
        normalize_author_user_id(payload.author_user_id.as_deref()).map_err(|_| {
            DomainError::StateCorrupt {
                reason: "pending chat message author id is invalid",
            }
        })?;
    if author_user_id != payload.author_user_id {
        return Err(DomainError::StateCorrupt {
            reason: "pending chat message author id changed during replay",
        });
    }
    let body = normalize_body(&payload.body).map_err(|_| DomainError::StateCorrupt {
        reason: "pending chat message body is invalid",
    })?;
    let previous: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(message_order), -1) FROM chat_messages \
             WHERE workspace_id=?1 AND thread_id=?2",
            params![workspace_id, payload.thread_id],
            |row| row.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    let order = previous.checked_add(1).ok_or(DomainError::StateCorrupt {
        reason: "pending chat message order overflowed",
    })?;
    let parent_exists = if let Some(parent) = &payload.parent_message_id {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_messages \
             WHERE workspace_id=?1 AND thread_id=?2 AND message_id=?3)",
            params![workspace_id, payload.thread_id, parent],
            |row| row.get::<_, bool>(0),
        )
        .map_err(DomainError::sql_corrupt)?
    } else {
        false
    };
    let stored_parent = if parent_exists {
        payload.parent_message_id.as_deref()
    } else {
        None
    };
    let inserted = tx
        .execute(
            "INSERT OR IGNORE INTO chat_messages \
             (workspace_id,thread_id,message_order,message_id,author_kind,author_display_name, \
              author_user_id,parent_message_id,origin,body,created_at_ms,author_owner_display_name) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                workspace_id,
                payload.thread_id,
                order,
                payload.message_id,
                payload.author_kind,
                author_display_name,
                author_user_id,
                stored_parent,
                payload.origin,
                body,
                payload.created_at_ms,
                owner_name
            ],
        )
        .map_err(DomainError::sql_persist)?;
    if inserted == 0 {
        return Ok(Vec::new());
    }
    for handle in parse_mention_handles(&body) {
        tx.execute(
            "INSERT OR IGNORE INTO chat_mentions \
             (workspace_id,thread_id,message_id,handle,author_kind,created_at_ms) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                workspace_id,
                payload.thread_id,
                payload.message_id,
                handle,
                payload.author_kind,
                payload.created_at_ms
            ],
        )
        .map_err(DomainError::sql_persist)?;
    }
    if let Some(parent) = payload
        .parent_message_id
        .as_deref()
        .filter(|_| !parent_exists)
        && parent != payload.message_id
    {
        tx.execute(
            "INSERT OR IGNORE INTO chat_pending_message_parents \
             (workspace_id,child_message_id,thread_id,parent_message_id) \
             VALUES (?1,?2,?3,?4)",
            params![workspace_id, payload.message_id, payload.thread_id, parent],
        )
        .map_err(DomainError::sql_persist)?;
    }
    tx.execute(
        "UPDATE chat_messages SET parent_message_id=?3 \
         WHERE workspace_id=?1 AND thread_id=?2 AND message_id IN (\
           SELECT child_message_id FROM chat_pending_message_parents \
           WHERE workspace_id=?1 AND thread_id=?2 AND parent_message_id=?3)",
        params![workspace_id, payload.thread_id, payload.message_id],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "DELETE FROM chat_pending_message_parents \
         WHERE workspace_id=?1 AND thread_id=?2 AND parent_message_id=?3",
        params![workspace_id, payload.thread_id, payload.message_id],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "UPDATE chat_threads SET updated_at_ms=MAX(updated_at_ms,?3) \
         WHERE workspace_id=?1 AND thread_id=?2",
        params![workspace_id, payload.thread_id, payload.created_at_ms],
    )
    .map_err(DomainError::sql_persist)?;
    mark_live_bookmarks_pending(tx, workspace_id, &payload.thread_id, payload.created_at_ms)?;
    index_replicated_chat_message_search_rows(
        tx,
        workspace_id,
        &payload.thread_id,
        &payload.message_id,
        &author_display_name,
        &payload.author_kind,
        &body,
    )?;
    bump_chat_conversation_revision(tx, workspace_id, &payload.thread_id)?;
    claim_group_message_in_tx(
        tx,
        workspace_id,
        &AutomationGroupMessage {
            message_id: &payload.message_id,
            thread_id: &payload.thread_id,
            parent_message_id: payload.parent_message_id.as_deref(),
            author_kind: &payload.author_kind,
            author_display_name: &author_display_name,
            author_owner_display_name: owner_name.as_deref(),
            author_user_id: author_user_id.as_deref(),
            body: &body,
            created_at_ms: payload.created_at_ms,
            automation_id: None,
            chain_depth: payload.chain_depth,
        },
    )
}

fn park_pending_chat_operation(
    tx: &Transaction<'_>,
    workspace_id: &str,
    operation: &PendingChatOperation,
    dependency_kind: &'static str,
    dependency_id: &str,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT OR IGNORE INTO chat_pending_replication \
         (workspace_id,origin_id,origin_seq,dependency_kind,dependency_id) \
         VALUES (?1,?2,?3,?4,?5)",
        params![
            workspace_id,
            operation.origin_id,
            operation.origin_seq,
            dependency_kind,
            dependency_id
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn changed_chat_dependencies(
    tx: &Transaction<'_>,
    workspace_id: &str,
    op_kind: &str,
    payload: &serde_json::Value,
) -> Result<Vec<PendingChatDependency>, DomainError> {
    let mut dependencies = Vec::new();
    match op_kind {
        "chat.channel.create" => {
            let wire_id = payload
                .get("wireId")
                .and_then(serde_json::Value::as_str)
                .or_else(|| payload.get("channelId").and_then(serde_json::Value::as_str));
            let Some(wire_id) = wire_id else {
                return Ok(dependencies);
            };
            dependencies.push(PendingChatDependency {
                kind: "follow-target",
                id: wire_id.to_owned(),
            });
            let channel_id: Option<String> = tx
                .query_row(
                    "SELECT channel_id FROM chat_channel_wire_ids \
                     WHERE workspace_id=?1 AND wire_id=?2",
                    params![workspace_id, wire_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            if let Some(channel_id) = channel_id {
                collect_dependency_ids(
                    tx,
                    "SELECT thread_id FROM chat_threads \
                     WHERE workspace_id=?1 AND channel_id=?2",
                    workspace_id,
                    &channel_id,
                    "follow-target",
                    &mut dependencies,
                )?;
                collect_dependency_ids(
                    tx,
                    "SELECT DISTINCT m.author_user_id FROM chat_messages m \
                     JOIN chat_threads t \
                       ON t.workspace_id=m.workspace_id AND t.thread_id=m.thread_id \
                     WHERE m.workspace_id=?1 AND t.channel_id=?2 \
                       AND m.author_user_id IS NOT NULL",
                    workspace_id,
                    &channel_id,
                    "follow-target",
                    &mut dependencies,
                )?;
                collect_dependency_ids(
                    tx,
                    "SELECT m.message_id FROM chat_messages m \
                     JOIN chat_threads t \
                       ON t.workspace_id=m.workspace_id AND t.thread_id=m.thread_id \
                     WHERE m.workspace_id=?1 AND t.channel_id=?2",
                    workspace_id,
                    &channel_id,
                    "feed-message",
                    &mut dependencies,
                )?;
            }
        }
        "chat.thread.create" => {
            if let Some(thread_id) = payload.get("threadId").and_then(serde_json::Value::as_str) {
                for kind in ["follow-target", "message-thread"] {
                    dependencies.push(PendingChatDependency {
                        kind,
                        id: thread_id.to_owned(),
                    });
                }
            }
        }
        "chat.message.append" => {
            if let Some(message_id) = payload.get("messageId").and_then(serde_json::Value::as_str) {
                for kind in ["feed-message", "attachment-message"] {
                    dependencies.push(PendingChatDependency {
                        kind,
                        id: message_id.to_owned(),
                    });
                }
            }
            if let Some(author_user_id) = payload
                .get("authorUserId")
                .and_then(serde_json::Value::as_str)
            {
                dependencies.push(PendingChatDependency {
                    kind: "follow-target",
                    id: author_user_id.to_owned(),
                });
            }
        }
        "chat.follow.set" => {
            let payload: PendingFollowSet = match serde_json::from_value(payload.clone()) {
                Ok(payload) => payload,
                Err(_) => return Ok(dependencies),
            };
            let state: Option<String> = tx
                .query_row(
                    "SELECT state FROM chat_follows \
                     WHERE workspace_id=?1 AND owner_user_id=?2 \
                       AND target_kind=?3 AND target_id=?4",
                    params![
                        workspace_id,
                        payload.owner_user_id,
                        payload.target_kind,
                        payload.target_id
                    ],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            if state.as_deref() == Some("following") {
                collect_feed_dependencies_for_follow(
                    tx,
                    workspace_id,
                    &payload,
                    &mut dependencies,
                )?;
            }
        }
        _ => {}
    }
    Ok(dependencies)
}

fn collect_dependency_ids(
    tx: &Transaction<'_>,
    sql: &str,
    workspace_id: &str,
    changed_id: &str,
    dependency_kind: &'static str,
    dependencies: &mut Vec<PendingChatDependency>,
) -> Result<(), DomainError> {
    let mut stmt = tx.prepare(sql).map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(params![workspace_id, changed_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(DomainError::sql_corrupt)?;
    for row in rows {
        dependencies.push(PendingChatDependency {
            kind: dependency_kind,
            id: row.map_err(DomainError::sql_corrupt)?,
        });
    }
    Ok(())
}

fn collect_feed_dependencies_for_follow(
    tx: &Transaction<'_>,
    workspace_id: &str,
    follow: &PendingFollowSet,
    dependencies: &mut Vec<PendingChatDependency>,
) -> Result<(), DomainError> {
    let target_clause = match follow.target_kind.as_str() {
        "person" => "m.author_kind='human' AND m.author_user_id=?3",
        "agent" => "m.author_kind='agent' AND m.author_user_id=?3",
        "thread" => "m.thread_id=?3",
        "channel" => {
            "EXISTS (SELECT 1 FROM chat_channel_wire_ids w \
               WHERE w.workspace_id=m.workspace_id AND w.channel_id=t.channel_id AND w.wire_id=?3) \
             AND m.message_id=(SELECT first.message_id FROM chat_messages first \
               WHERE first.workspace_id=m.workspace_id AND first.thread_id=m.thread_id \
               ORDER BY first.created_at_ms,first.message_id LIMIT 1)"
        }
        _ => return Ok(()),
    };
    let sql = format!(
        "SELECT pending.dependency_id \
         FROM chat_pending_replication pending \
         JOIN replication_log log \
           ON log.workspace_id=pending.workspace_id \
          AND log.origin_id=pending.origin_id AND log.origin_seq=pending.origin_seq \
         JOIN chat_messages m \
           ON m.workspace_id=pending.workspace_id AND m.message_id=pending.dependency_id \
         JOIN chat_threads t \
           ON t.workspace_id=m.workspace_id AND t.thread_id=m.thread_id \
         WHERE pending.workspace_id=?1 AND pending.dependency_kind='feed-message' \
           AND json_extract(log.payload_json,'$.ownerUserId')=?2 AND {target_clause}"
    );
    let mut stmt = tx.prepare(&sql).map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(
            params![workspace_id, follow.owner_user_id, follow.target_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    for row in rows {
        dependencies.push(PendingChatDependency {
            kind: "feed-message",
            id: row.map_err(DomainError::sql_corrupt)?,
        });
    }
    Ok(())
}
