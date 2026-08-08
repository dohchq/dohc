use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint, TxnOutcome};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Deserializer};
use sha2::{Digest, Sha256};

use dohc_engine_domain::chats::{
    chat_thread_display_title, index_replicated_chat_message_search_rows,
    upsert_chat_search_index_row,
};
use dohc_engine_domain::{
    AGENT_CHANNEL_NAME, AGENT_CHANNEL_WIRE_ID, CHAT_THREAD_HEADER_MESSAGE_ID, DomainError,
    FeedCoordinateResolution, FollowTargetKind, FollowTargetResolution, GENERAL_CHANNEL_WIRE_ID,
    ThreadMessageResolution, attachment_id_for, channel_slug_for_name, has_projection_control_char,
    is_js_trim_ws, is_reaction_emoji_verbatim, normalize_author_user_id, normalize_body,
    normalize_channel_name, normalize_display_name, normalize_feed_identity,
    normalize_reaction_author_id, normalize_replicated_chat_id, parse_mention_handles,
    replay_ready_pending_chat_coordinates, resolve_feed_coordinate, resolve_follow_target,
    resolve_thread_message, validate_addressable_plaintext_path,
};

use crate::error::local_corruption;
use crate::journal::{ack_tx, crashes, read_ack_tx};
use crate::{ReplicationEnvelope, SyncError};

const DIRECT_RPC_REFUSAL_REPORT_ID: &str = "direct-rpc";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome<T> {
    Applied(T),
    Refused(ReplicationRefusal),
    Skipped,
    Crashed {
        committed: bool,
    },
    /// The envelope has the nested primary disposition, and applying it also
    /// surfaced refusals for older coordinates that were durably deferred.
    WithRefusals {
        outcome: Box<ApplyOutcome<T>>,
        refusals: Vec<ReplicationRefusal>,
    },
}

impl<T> ApplyOutcome<T> {
    pub(crate) fn map<U>(self, map: impl FnOnce(T) -> U) -> ApplyOutcome<U> {
        match self {
            Self::Applied(value) => ApplyOutcome::Applied(map(value)),
            Self::Refused(refusal) => ApplyOutcome::Refused(refusal),
            Self::Skipped => ApplyOutcome::Skipped,
            Self::Crashed { committed } => ApplyOutcome::Crashed { committed },
            Self::WithRefusals { outcome, refusals } => ApplyOutcome::WithRefusals {
                outcome: Box::new(outcome.map(map)),
                refusals,
            },
        }
    }

    pub(crate) fn with_refusals(self, refusals: Vec<ReplicationRefusal>) -> Self {
        if refusals.is_empty() {
            self
        } else {
            Self::WithRefusals {
                outcome: Box::new(self),
                refusals,
            }
        }
    }

    pub(crate) fn into_primary_and_refusals(self) -> (Self, Vec<ReplicationRefusal>) {
        match self {
            Self::WithRefusals { outcome, refusals } => {
                let (primary, mut nested) = outcome.into_primary_and_refusals();
                nested.extend(refusals);
                (primary, nested)
            }
            primary => (primary, Vec::new()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplicationRefusal {
    pub workspace_id: String,
    pub origin_id: String,
    pub origin_seq: i64,
    pub op_kind: String,
    pub reason: RefusalReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefusalReason {
    InvalidInput { reason: String },
}

impl RefusalReason {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput { .. } => "invalid-input",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::InvalidInput { reason } => reason,
        }
    }
}

enum Admission<T> {
    Applied(T),
    Refused(ReplicationRefusal),
    Skipped,
}

pub(crate) enum MutationOutcome<T> {
    Applied(T),
    RefusedRetainingMutation { reason: &'static str },
}

/// Validate and atomically handle one imported coordinate. Ordinary
/// mutation-level invalid input is rolled back to a savepoint, then journaled
/// and acked as a refusal. `RefusedRetainingMutation` is the deliberate
/// exception: its domain mutation stays committed while only its nested
/// projection savepoint is rolled back. Structural, ordering, storage, and
/// hydration failures abort.
pub fn apply_envelope_with<T>(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    mutation: impl FnOnce(&Transaction<'_>, &ReplicationEnvelope) -> Result<T, SyncError>,
) -> Result<ApplyOutcome<T>, SyncError> {
    apply_envelope_with_mutation_outcome(store, envelope, faults, |tx, op| {
        mutation(tx, op).map(MutationOutcome::Applied)
    })
}

pub(crate) fn apply_envelope_with_mutation_outcome<T>(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    mutation: impl FnOnce(
        &Transaction<'_>,
        &ReplicationEnvelope,
    ) -> Result<MutationOutcome<T>, SyncError>,
) -> Result<ApplyOutcome<T>, SyncError> {
    envelope.validate()?;
    let payload_json = envelope.payload_json()?;
    let result = store.write_with(faults, |tx| {
        let acked = read_ack_tx(tx, &envelope.workspace_id, &envelope.origin_id)?;
        if envelope.origin_seq <= acked {
            // A redelivered coordinate at or below the ack must match the row
            // already journaled after relay-compatible JSON canonicalization.
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
                let canonical_payload = crate::relay::canonical_json_bytes(&envelope.payload)?;
                if !coordinate_matches(&row, envelope, &canonical_payload)? {
                    return Err(SyncError::CoordinateDiverged);
                }
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
            let canonical_payload = crate::relay::canonical_json_bytes(&envelope.payload)?;
            if !coordinate_matches(&row, envelope, &canonical_payload)? {
                return Err(SyncError::CoordinateDiverged);
            }
            ack_tx(tx, &envelope.workspace_id, &envelope.origin_id, envelope.origin_seq)?;
            return Ok(Admission::Skipped);
        }
        tx.execute_batch("SAVEPOINT dohc_replication_mutation")
            .map_err(SyncError::persist)?;
        let admission = match mutation(tx, envelope) {
            Ok(MutationOutcome::Applied(value)) => {
                tx.execute_batch("RELEASE dohc_replication_mutation")
                    .map_err(SyncError::persist)?;
                Admission::Applied(value)
            }
            Ok(MutationOutcome::RefusedRetainingMutation { reason }) => {
                tx.execute_batch("RELEASE dohc_replication_mutation")
                    .map_err(SyncError::persist)?;
                Admission::Refused(ReplicationRefusal {
                    workspace_id: envelope.workspace_id.clone(),
                    origin_id: envelope.origin_id.clone(),
                    origin_seq: envelope.origin_seq,
                    op_kind: envelope.op_kind.clone(),
                    reason: RefusalReason::InvalidInput {
                        reason: reason.to_owned(),
                    },
                })
            }
            Err(error) => {
                let Some(reason) = refusal_reason(&error) else {
                    return Err(error);
                };
                tx.execute_batch(
                    "ROLLBACK TO dohc_replication_mutation; \
                     RELEASE dohc_replication_mutation",
                )
                .map_err(SyncError::persist)?;
                Admission::Refused(ReplicationRefusal {
                    workspace_id: envelope.workspace_id.clone(),
                    origin_id: envelope.origin_id.clone(),
                    origin_seq: envelope.origin_seq,
                    op_kind: envelope.op_kind.clone(),
                    reason,
                })
            }
        };
        if let Admission::Refused(refusal) = &admission {
            persist_refusal(tx, refusal)?;
        }
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
        Ok(admission)
    });
    match result {
        Ok(TxnOutcome::Committed(Admission::Applied(value))) => Ok(ApplyOutcome::Applied(value)),
        Ok(TxnOutcome::Committed(Admission::Refused(refusal))) => {
            Ok(ApplyOutcome::Refused(refusal))
        }
        Ok(TxnOutcome::Committed(Admission::Skipped)) => Ok(ApplyOutcome::Skipped),
        Ok(TxnOutcome::Crashed { committed }) => Ok(ApplyOutcome::Crashed { committed }),
        Err(SyncError::FaultCrash) => Ok(ApplyOutcome::Crashed { committed: false }),
        Err(err) => Err(err),
    }
}

fn refusal_reason(error: &SyncError) -> Option<RefusalReason> {
    match error {
        SyncError::InvalidInput { reason } => Some(RefusalReason::InvalidInput {
            reason: (*reason).to_owned(),
        }),
        SyncError::UnsupportedOperation => Some(RefusalReason::InvalidInput {
            reason: "operation kind is not supported by this client".to_owned(),
        }),
        _ => None,
    }
}

pub(crate) fn persist_refusal(
    tx: &Transaction<'_>,
    refusal: &ReplicationRefusal,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT INTO replication_pending_refusals \
         (workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) \
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            refusal.workspace_id,
            refusal.origin_id,
            refusal.origin_seq,
            refusal.op_kind,
            refusal.reason.code(),
            refusal.reason.message(),
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

pub fn read_replayed_refusal(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<Option<ReplicationRefusal>, SyncError> {
    store.read_with(|conn| {
        conn.query_row(
            "SELECT op_kind, reason_code, reason_message \
             FROM replication_pending_refusals \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![
                envelope.workspace_id,
                envelope.origin_id,
                envelope.origin_seq
            ],
            |row| {
                let op_kind: String = row.get(0)?;
                let code: String = row.get(1)?;
                let message: String = row.get(2)?;
                let reason = match (code.as_str(), message.as_str()) {
                    ("invalid-input", _) => RefusalReason::InvalidInput { reason: message },
                    _ => return Err(rusqlite::Error::InvalidQuery),
                };
                Ok(ReplicationRefusal {
                    workspace_id: envelope.workspace_id.clone(),
                    origin_id: envelope.origin_id.clone(),
                    origin_seq: envelope.origin_seq,
                    op_kind,
                    reason,
                })
            },
        )
        .optional()
        .map_err(SyncError::corrupt)
    })
}

pub fn retain_refusal_for_direct_retry(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<(), SyncError> {
    match store.write_with(faults, |tx| {
        tx.execute(
            "UPDATE replication_pending_refusals SET report_id=?4 \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![
                envelope.workspace_id,
                envelope.origin_id,
                envelope.origin_seq,
                DIRECT_RPC_REFUSAL_REPORT_ID
            ],
        )
        .map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    })? {
        TxnOutcome::Committed(()) => Ok(()),
        TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
    }
}

pub(crate) fn claim_pending_refusals(
    store: &mut EngineStore,
    workspace_id: &str,
    faults: &dyn FaultInjector,
) -> Result<(Vec<ReplicationRefusal>, Option<String>), SyncError> {
    match store.write_with(faults, |tx| {
        let report_id: Option<String> = tx
            .query_row(
                "SELECT CASE WHEN EXISTS(SELECT 1 FROM replication_pending_refusals \
                 WHERE workspace_id=?1 AND COALESCE(report_id,'') != ?2) \
                 THEN lower(hex(randomblob(16))) END",
                params![workspace_id, DIRECT_RPC_REFUSAL_REPORT_ID],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        let Some(report_id) = report_id else {
            return Ok::<_, SyncError>((Vec::new(), None));
        };
        // A new pull supersedes any older uncommitted report. Retagging every
        // pending row makes crash retry reconstruct all unread refusals, while
        // the old cursor's report token can no longer sweep them.
        tx.execute(
            "UPDATE replication_pending_refusals SET report_id=?2 \
             WHERE workspace_id=?1 AND COALESCE(report_id,'') != ?3",
            params![workspace_id, report_id, DIRECT_RPC_REFUSAL_REPORT_ID],
        )
        .map_err(SyncError::persist)?;
        let refusals = {
            let mut stmt = tx
                .prepare(
                    "SELECT origin_id, origin_seq, op_kind, reason_code, reason_message \
                 FROM replication_pending_refusals \
                 WHERE workspace_id=?1 AND report_id=?2 \
                 ORDER BY origin_id, origin_seq",
                )
                .map_err(SyncError::corrupt)?;
            let rows = stmt
                .query_map(params![workspace_id, report_id], |row| {
                    let origin_id: String = row.get(0)?;
                    let origin_seq: i64 = row.get(1)?;
                    let op_kind: String = row.get(2)?;
                    let code: String = row.get(3)?;
                    let message: String = row.get(4)?;
                    let reason = match (code.as_str(), message.as_str()) {
                        ("invalid-input", _) => RefusalReason::InvalidInput { reason: message },
                        _ => return Err(rusqlite::Error::InvalidQuery),
                    };
                    Ok(ReplicationRefusal {
                        workspace_id: workspace_id.to_owned(),
                        origin_id,
                        origin_seq,
                        op_kind,
                        reason,
                    })
                })
                .map_err(SyncError::corrupt)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(SyncError::corrupt)?
        };
        Ok((refusals, Some(report_id)))
    })? {
        TxnOutcome::Committed(claimed) => Ok(claimed),
        TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
    }
}

fn coordinate_matches(
    existing: &(String, String, i64),
    envelope: &ReplicationEnvelope,
    canonical_payload: &[u8],
) -> Result<bool, SyncError> {
    if existing.0 != envelope.op_kind || existing.2 != envelope.recorded_at_ms {
        return Ok(false);
    }
    let existing_payload: serde_json::Value =
        serde_json::from_str(&existing.1).map_err(|_| SyncError::CoordinateDiverged)?;
    Ok(crate::relay::canonical_json_bytes(&existing_payload)? == canonical_payload)
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
    apply_envelope_with(store, envelope, faults, apply_chat_tx).map(|outcome| {
        let (primary, nested_refusals) = outcome.into_primary_and_refusals();
        match primary {
            ApplyOutcome::Applied(replay_refusals) => ApplyOutcome::Applied(())
                .with_refusals(nested_refusals.into_iter().chain(replay_refusals).collect()),
            ApplyOutcome::Refused(refusal) => {
                ApplyOutcome::Refused(refusal).with_refusals(nested_refusals)
            }
            ApplyOutcome::Skipped => ApplyOutcome::Skipped.with_refusals(nested_refusals),
            ApplyOutcome::Crashed { committed } => {
                ApplyOutcome::Crashed { committed }.with_refusals(nested_refusals)
            }
            ApplyOutcome::WithRefusals { .. } => unreachable!("refusals were flattened"),
        }
    })
}

fn decode<T: for<'de> Deserialize<'de>>(value: &serde_json::Value) -> Result<T, SyncError> {
    serde_json::from_value(value.clone()).map_err(|_| SyncError::InvalidInput {
        reason: "chat replication payload is malformed",
    })
}

fn deserialize_present_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

fn map_chat_rule(error: DomainError, reason: &'static str) -> SyncError {
    match error {
        DomainError::Storage(storage) => SyncError::Storage(storage),
        hard @ (DomainError::StateCorrupt { .. } | DomainError::Crypto(_)) => {
            SyncError::Storage(dohc_engine_storage::StorageError::corrupt_public(hard))
        }
        _ => SyncError::InvalidInput { reason },
    }
}

fn is_bounded_replicated_id(value: &str, max_utf16_units: usize) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= max_utf16_units
        && value.trim_matches(is_js_trim_ws) == value
        && !has_projection_control_char(value)
}

fn is_replicated_timestamp(value: i64) -> bool {
    (0..=crate::MAX_WIRE_INTEGER).contains(&value)
}

fn is_persisted_safe_integer(value: i64) -> bool {
    (-crate::MAX_WIRE_INTEGER..=crate::MAX_WIRE_INTEGER).contains(&value)
}

pub(crate) fn is_replicated_channel_slug(value: &str) -> bool {
    is_bounded_replicated_id(value, 200)
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
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
    #[serde(default, deserialize_with = "deserialize_present_string")]
    author_user_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present_string")]
    parent_message_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present_string")]
    origin: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecisionSet {
    thread_id: String,
    message_id: String,
    state: String,
    at_ms: i64,
    #[serde(default, deserialize_with = "deserialize_present_string")]
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
) -> Result<Vec<ReplicationRefusal>, SyncError> {
    apply_chat_mutation(tx, op)?;
    let replay_refusals = replay_ready_pending_chat_coordinates(tx, &op.workspace_id)
        .map_err(|error| map_chat_rule(error, "pending chat coordinate replay failed"))?;
    Ok(replay_refusals
        .into_iter()
        .map(|refusal| ReplicationRefusal {
            workspace_id: op.workspace_id.clone(),
            origin_id: refusal.origin_id,
            origin_seq: refusal.origin_seq,
            op_kind: refusal.op_kind,
            reason: RefusalReason::InvalidInput {
                reason: refusal.reason.to_owned(),
            },
        })
        .collect())
}

fn apply_chat_mutation(tx: &Transaction<'_>, op: &ReplicationEnvelope) -> Result<(), SyncError> {
    match op.op_kind.as_str() {
        "chat.channel.create" => apply_channel(tx, op, decode(&op.payload)?),
        "chat.thread.create" => apply_thread(tx, op, decode(&op.payload)?),
        "chat.message.append" => apply_message(tx, op, decode(&op.payload)?),
        "chat.decision.set" | "chat.reaction.set" | "chat.follow.set" | "chat.feed.read.set" => {
            apply_chat_lww_projection_tx(tx, op)
        }
        "chat.attachment.add" => apply_attachment(tx, op, decode(&op.payload)?),
        _ => Err(SyncError::UnsupportedOperation),
    }
}

pub(crate) fn apply_chat_lww_projection_tx(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    match op.op_kind.as_str() {
        "chat.decision.set" => apply_decision(tx, op, decode(&op.payload)?),
        "chat.reaction.set" => apply_reaction(tx, op, decode(&op.payload)?),
        "chat.follow.set" => apply_follow(tx, op, decode(&op.payload)?),
        "chat.feed.read.set" => apply_feed_read(tx, op, decode(&op.payload)?),
        _ => Err(SyncError::UnsupportedOperation),
    }
}

fn park_chat_coordinate(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    dependency_kind: &'static str,
    dependency_id: &str,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT OR IGNORE INTO chat_pending_replication \
         (workspace_id,origin_id,origin_seq,dependency_kind,dependency_id) \
         VALUES (?1,?2,?3,?4,?5)",
        params![
            op.workspace_id,
            op.origin_id,
            op.origin_seq,
            dependency_kind,
            dependency_id
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn apply_channel(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    payload: ChannelCreate,
) -> Result<(), SyncError> {
    let channel_id = normalize_replicated_chat_id(&payload.channel_id, "channel id is invalid")
        .map_err(|error| map_chat_rule(error, "chat channel id is invalid"))?;
    if channel_id != payload.channel_id
        || matches!(
            channel_id.as_str(),
            GENERAL_CHANNEL_WIRE_ID | AGENT_CHANNEL_WIRE_ID
        )
    {
        return Err(SyncError::InvalidInput {
            reason: "chat channel id is invalid",
        });
    }
    let name = normalize_channel_name(&payload.name)
        .map_err(|error| map_chat_rule(error, "chat channel name is invalid"))?;
    if !is_replicated_channel_slug(&payload.slug) {
        return Err(SyncError::InvalidInput {
            reason: "chat channel slug is invalid",
        });
    }
    let requested_slug = channel_slug_for_name(&name);
    if requested_slug.is_empty() {
        return Err(SyncError::InvalidInput {
            reason: "chat channel name has no usable slug",
        });
    }
    if !matches!(payload.kind.as_str(), "channel" | "dm" | "agent") {
        return Err(SyncError::InvalidInput {
            reason: "chat channel kind is invalid",
        });
    }
    if !is_replicated_timestamp(payload.created_at_ms) {
        return Err(SyncError::InvalidInput {
            reason: "chat channel timestamp is invalid",
        });
    }
    let carries_agent_wire = payload.wire_id.as_deref() == Some(AGENT_CHANNEL_WIRE_ID);
    let canonical_agent_slug = channel_slug_for_name(AGENT_CHANNEL_NAME);
    if (payload.kind == "agent") != carries_agent_wire
        || (payload.slug == canonical_agent_slug) != carries_agent_wire
        || (requested_slug == canonical_agent_slug) != carries_agent_wire
        || (name == AGENT_CHANNEL_NAME) != carries_agent_wire
    {
        return Err(SyncError::InvalidInput {
            reason: "reserved agent-channel invariant violated",
        });
    }
    let wire_id = match payload.wire_id.as_deref() {
        Some(value) => {
            let normalized = normalize_replicated_chat_id(value, "channel wire id is invalid")
                .map_err(|error| map_chat_rule(error, "chat channel wire id is invalid"))?;
            if normalized != value {
                return Err(SyncError::InvalidInput {
                    reason: "chat channel wire id is invalid",
                });
            }
            normalized
        }
        None => channel_id.clone(),
    };
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
            let slug = allocate_channel_slug(
                tx,
                &op.workspace_id,
                &requested_slug,
                &channel_id,
                &wire_id,
            )?;
            debug_assert!(is_replicated_channel_slug(&slug));
            tx.execute(
                "UPDATE chat_channels SET name = ?3, slug = ?4, kind = ?5, created_at_ms = ?6, updated_at_ms = ?6 \
                 WHERE workspace_id = ?1 AND channel_id = ?2",
                params![op.workspace_id, channel_id, name, slug, payload.kind, payload.created_at_ms],
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
    let slug = allocate_channel_slug(tx, &op.workspace_id, &requested_slug, &channel_id, &wire_id)?;
    debug_assert!(is_replicated_channel_slug(&slug));
    tx.execute(
        "INSERT OR IGNORE INTO chat_channels \
         (workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            op.workspace_id,
            channel_id,
            name,
            slug,
            payload.kind,
            payload.created_at_ms
        ],
    )
    .map_err(SyncError::persist)?;
    tx.execute(
        "INSERT OR IGNORE INTO chat_channel_wire_ids (workspace_id, wire_id, channel_id) VALUES (?1, ?2, ?3)",
        params![op.workspace_id, wire_id, channel_id],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn allocate_channel_slug(
    tx: &Transaction<'_>,
    workspace_id: &str,
    requested: &str,
    channel_id: &str,
    allocation_identity: &str,
) -> Result<String, SyncError> {
    let base = channel_allocation_base(requested);
    // Slugs are local occupancy aliases, not replicated identity. Excluding the
    // materializing row lets it rename itself; no other channel is ever moved.
    if !channel_slug_is_occupied(tx, workspace_id, &base, channel_id)? {
        debug_assert!(is_replicated_channel_slug(&base));
        return Ok(base);
    }
    let mut attempt = 0;
    loop {
        let candidate = channel_collision_slug(&base, allocation_identity, attempt);
        if !channel_slug_is_occupied(tx, workspace_id, &candidate, channel_id)? {
            debug_assert!(is_replicated_channel_slug(&candidate));
            return Ok(candidate);
        }
        attempt = attempt.saturating_add(1);
    }
}

fn channel_slug_is_occupied(
    tx: &Transaction<'_>,
    workspace_id: &str,
    slug: &str,
    allocating_channel_id: &str,
) -> Result<bool, SyncError> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_channels \
         WHERE workspace_id=?1 AND slug=?2 AND channel_id<>?3)",
        params![workspace_id, slug, allocating_channel_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

fn channel_collision_slug(requested: &str, allocation_identity: &str, attempt: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(requested.as_bytes());
    hasher.update([0]);
    hasher.update(allocation_identity.as_bytes());
    if attempt > 0 {
        hasher.update([0]);
        hasher.update(attempt.to_be_bytes());
    }
    let suffix = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    const MAX_COLLISION_BASE_UTF16_UNITS: usize = 200 - 1 - 64;
    let bounded_requested = truncate_slug_base(requested, MAX_COLLISION_BASE_UTF16_UNITS);
    let slug = format!("{bounded_requested}-{suffix}");
    debug_assert!(is_replicated_channel_slug(&slug));
    slug
}

fn truncate_slug_base(value: &str, max_utf16_units: usize) -> String {
    let mut utf16_units = 0;
    let mut end = 0;
    for (index, ch) in value.char_indices() {
        if utf16_units + ch.len_utf16() > max_utf16_units {
            break;
        }
        utf16_units += ch.len_utf16();
        end = index + ch.len_utf8();
    }
    value[..end].trim_end_matches('-').to_owned()
}

fn channel_allocation_base(name: &str) -> String {
    let slug = channel_slug_for_name(name);
    let base = if slug.is_empty() {
        format!(
            "channel-{}",
            dohc_engine_storage::hex_sha256(name.as_bytes())
        )
    } else {
        slug
    };
    let bounded = truncate_slug_base(&base, 200);
    debug_assert!(is_replicated_channel_slug(&bounded));
    bounded
}

fn apply_thread(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    payload: ThreadCreate,
) -> Result<(), SyncError> {
    if !is_bounded_replicated_id(&payload.thread_id, 256)
        || payload.title.encode_utf16().count() > 200
        || (!payload.title.is_empty() && payload.title.trim_matches(is_js_trim_ws) != payload.title)
        || !is_replicated_timestamp(payload.created_at_ms)
        || payload
            .linked_object_id
            .as_deref()
            .is_some_and(|value| !is_bounded_replicated_id(value, 200))
        || payload
            .linked_at_ms
            .is_some_and(|value| !is_replicated_timestamp(value))
        || payload
            .channel_slug
            .as_deref()
            .is_some_and(|value| !is_replicated_channel_slug(value))
        || payload
            .channel_wire_id
            .as_deref()
            .is_some_and(|value| !is_bounded_replicated_id(value, 256))
    {
        return Err(SyncError::InvalidInput {
            reason: "chat thread payload is invalid",
        });
    }
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
    // A file-linked thread MUST carry its linkedAtMs. The oracle accepts this
    // op (storing linked_at_ms NULL) but then its OWN reader throws corruptStore
    // (threadFromRow numberValue(null)) — a latent oracle bug that bricks the
    // read surface on both engines. We reject the malformed op at apply
    // (fail-closed), which is deliberately stricter than the oracle; honest
    // mint always pairs the fields, so only a corrupt/hostile op is refused.
    // See the CROSS-ENGINE DELTA note in RPC_GAP.md.
    if payload.linked_object_id.is_some() && payload.linked_at_ms.is_none() {
        return Err(SyncError::InvalidInput {
            reason: "chat thread linked owner requires a linked timestamp",
        });
    }
    if let Some(path) = payload.linked_path_hint.as_deref()
        && !matches!(validate_addressable_plaintext_path(path), Ok(normalized) if normalized == path)
    {
        return Err(SyncError::InvalidInput {
            reason: "chat thread linked path is invalid",
        });
    }
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_threads WHERE workspace_id = ?1 AND thread_id = ?2)",
            params![op.workspace_id, payload.thread_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if exists {
        return Ok(());
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
    upsert_chat_search_index_row(
        tx,
        &op.workspace_id,
        &payload.thread_id,
        CHAT_THREAD_HEADER_MESSAGE_ID,
        &chat_thread_display_title(&payload.title, None),
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn resolve_or_create_placeholder(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    payload: &ThreadCreate,
) -> Result<String, SyncError> {
    let canonical_agent_slug = channel_slug_for_name(AGENT_CHANNEL_NAME);
    let agent_placeholder = payload.channel_wire_id.as_deref() == Some(AGENT_CHANNEL_WIRE_ID);
    if payload
        .channel_slug
        .as_deref()
        .is_some_and(|slug| (slug == canonical_agent_slug) != agent_placeholder)
    {
        return Err(SyncError::InvalidInput {
            reason: "reserved agent-channel invariant violated",
        });
    }

    let mapped_channel_id = if let Some(wire_id) = payload.channel_wire_id.as_deref() {
        tx.query_row(
            "SELECT m.channel_id FROM chat_channel_wire_ids m \
             JOIN chat_channels c ON c.workspace_id = m.workspace_id AND c.channel_id = m.channel_id \
             WHERE m.workspace_id = ?1 AND m.wire_id = ?2",
            params![op.workspace_id, wire_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
    } else {
        None
    };
    if let Some(channel_id) = mapped_channel_id {
        if agent_placeholder {
            let mapped: Option<(String, String, String)> = tx
                .query_row(
                    "SELECT kind, name, slug FROM chat_channels \
                     WHERE workspace_id = ?1 AND channel_id = ?2",
                    params![op.workspace_id, channel_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(SyncError::corrupt)?;
            if !matches!(
                mapped,
                Some((ref kind, ref name, ref slug))
                    if kind == "agent"
                        && name == AGENT_CHANNEL_NAME
                        && slug == &canonical_agent_slug
            ) {
                return Err(local_corruption(
                    "reserved agent-channel mapping is corrupt",
                ));
            }
        }
        return Ok(channel_id);
    }

    if payload.channel_wire_id.is_none()
        && let Some(channel_slug) = payload.channel_slug.as_deref()
        && let Some(channel_id) = tx
            .query_row(
                "SELECT channel_id FROM chat_channels WHERE workspace_id = ?1 AND slug = ?2",
                params![op.workspace_id, channel_slug],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?
    {
        return Ok(channel_id);
    }

    if agent_placeholder
        && let Some((channel_id, kind, name)) = tx
            .query_row(
                "SELECT channel_id, kind, name FROM chat_channels \
                 WHERE workspace_id = ?1 AND slug = ?2",
                params![op.workspace_id, canonical_agent_slug],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(SyncError::corrupt)?
    {
        if kind != "agent" || name != AGENT_CHANNEL_NAME {
            return Err(local_corruption(
                "reserved agent-channel slug owner is corrupt",
            ));
        }
        tx.execute(
            "INSERT OR IGNORE INTO chat_channel_wire_ids \
             (workspace_id, wire_id, channel_id) VALUES (?1, ?2, ?3)",
            params![op.workspace_id, AGENT_CHANNEL_WIRE_ID, channel_id],
        )
        .map_err(SyncError::persist)?;
        return Ok(channel_id);
    }

    let identity = payload
        .channel_wire_id
        .as_deref()
        .or(payload.channel_slug.as_deref())
        .ok_or(SyncError::InvalidInput {
            reason: "channel thread lacks an identity",
        })?;
    let channel_id = format!("placeholder:{}:{}", op.origin_id, identity);
    let requested_slug = payload.channel_slug.as_deref().unwrap_or(identity);
    let placeholder_name = channel_allocation_base(requested_slug);
    let allocation_identity = payload.channel_wire_id.as_deref().unwrap_or(&channel_id);
    let slug = if agent_placeholder {
        canonical_agent_slug
    } else {
        allocate_channel_slug(
            tx,
            &op.workspace_id,
            &placeholder_name,
            &channel_id,
            allocation_identity,
        )?
    };
    debug_assert!(is_replicated_channel_slug(&slug));
    let name = if agent_placeholder {
        AGENT_CHANNEL_NAME.to_owned()
    } else {
        placeholder_name
    };
    let kind = if agent_placeholder {
        "agent"
    } else {
        "channel"
    };
    tx.execute(
        "INSERT OR IGNORE INTO chat_channels \
         (workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            op.workspace_id,
            channel_id,
            name,
            slug,
            kind,
            payload.created_at_ms
        ],
    )
    .map_err(SyncError::persist)?;
    if let Some(wire_id) = payload.channel_wire_id.as_deref() {
        tx.execute(
            "INSERT OR IGNORE INTO chat_channel_wire_ids \
             (workspace_id, wire_id, channel_id) VALUES (?1, ?2, ?3)",
            params![op.workspace_id, wire_id, channel_id],
        )
        .map_err(SyncError::persist)?;
        tx.execute(
            "INSERT OR IGNORE INTO chat_channel_placeholders \
             (workspace_id, channel_id, wire_id) VALUES (?1, ?2, ?3)",
            params![op.workspace_id, channel_id, wire_id],
        )
        .map_err(SyncError::persist)?;
    }
    Ok(channel_id)
}

fn apply_message(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    payload: MessageAppend,
) -> Result<(), SyncError> {
    if payload.message_id.is_empty()
        || payload.message_id == CHAT_THREAD_HEADER_MESSAGE_ID
        || payload.thread_id.is_empty()
        || !matches!(payload.author_kind.as_str(), "human" | "agent")
        || payload
            .parent_message_id
            .as_ref()
            .is_some_and(String::is_empty)
        || payload
            .origin
            .as_deref()
            .is_some_and(|origin| origin != "cli")
        || !is_persisted_safe_integer(payload.created_at_ms)
    {
        return Err(SyncError::InvalidInput {
            reason: "chat message payload is invalid",
        });
    }
    let author_display_name = normalize_display_name(&payload.author_display_name)
        .map_err(|error| map_chat_rule(error, "chat message display name is invalid"))?;
    let author_user_id = normalize_author_user_id(payload.author_user_id.as_deref())
        .map_err(|error| map_chat_rule(error, "chat message author id is invalid"))?;
    if author_user_id != payload.author_user_id {
        return Err(SyncError::InvalidInput {
            reason: "chat message author id is invalid",
        });
    }
    let body = normalize_body(&payload.body)
        .map_err(|error| map_chat_rule(error, "chat message body is invalid"))?;
    let thread_exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_threads WHERE workspace_id = ?1 AND thread_id = ?2)",
            params![op.workspace_id, payload.thread_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !thread_exists {
        return park_chat_coordinate(tx, op, "message-thread", &payload.thread_id);
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
        params![op.workspace_id, payload.thread_id, order, payload.message_id, payload.author_kind, author_display_name, author_user_id, stored_parent, payload.origin, body, payload.created_at_ms],
    )
    .map_err(SyncError::persist)?;
    if inserted == 0 {
        return Ok(());
    }
    for handle in parse_mention_handles(&body) {
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
    index_replicated_chat_message_search_rows(
        tx,
        &op.workspace_id,
        &payload.thread_id,
        &payload.message_id,
        &author_display_name,
        payload.author_kind == "agent",
        &body,
    )
    .map_err(|error| map_chat_rule(error, "replicated chat search index maintenance failed"))?;
    Ok(())
}

fn apply_decision(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    p: DecisionSet,
) -> Result<(), SyncError> {
    if p.thread_id.is_empty()
        || p.message_id.is_empty()
        || !matches!(p.state.as_str(), "open" | "resolved")
        || !is_persisted_safe_integer(p.at_ms)
        || p.resolved_by_message_id
            .as_ref()
            .is_some_and(String::is_empty)
        || (p.state == "open" && p.resolved_by_message_id.is_some())
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
        || !is_reaction_emoji_verbatim(&p.emoji)
        || !matches!(p.author_kind.as_str(), "human" | "agent")
        || !matches!(p.state.as_str(), "added" | "removed")
        || !is_persisted_safe_integer(p.at_ms)
    {
        return Err(SyncError::InvalidInput {
            reason: "chat reaction payload is invalid",
        });
    }
    let author_id = normalize_reaction_author_id(&p.author_id)
        .map_err(|error| map_chat_rule(error, "chat reaction author id is invalid"))?;
    if author_id != p.author_id {
        return Err(SyncError::InvalidInput {
            reason: "chat reaction author id is invalid",
        });
    }
    let author_display_name = normalize_display_name(&p.author_display_name)
        .map_err(|error| map_chat_rule(error, "chat reaction display name is invalid"))?;
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
        params![op.workspace_id,p.reaction_id,p.thread_id,p.message_id,p.emoji,author_id,p.author_kind,author_display_name,p.state,p.at_ms,op.origin_id,op.origin_seq],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn apply_follow(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    p: FollowSet,
) -> Result<(), SyncError> {
    let target_kind = match p.target_kind.as_str() {
        "person" => FollowTargetKind::Person,
        "agent" => FollowTargetKind::Agent,
        "channel" => FollowTargetKind::Channel,
        "thread" => FollowTargetKind::Thread,
        _ => {
            return Err(SyncError::InvalidInput {
                reason: "chat follow payload is invalid",
            });
        }
    };
    if !matches!(p.state.as_str(), "following" | "unfollowed")
        || !is_persisted_safe_integer(p.at_ms)
    {
        return Err(SyncError::InvalidInput {
            reason: "chat follow payload is invalid",
        });
    }
    let owner_user_id = normalize_feed_identity(&p.owner_user_id, "Feed owner")
        .map_err(|error| map_chat_rule(error, "chat follow owner is invalid"))?;
    let target_id = normalize_feed_identity(&p.target_id, "Follow target")
        .map_err(|error| map_chat_rule(error, "chat follow target is invalid"))?;
    if owner_user_id != p.owner_user_id || target_id != p.target_id {
        return Err(SyncError::InvalidInput {
            reason: "chat follow identity is invalid",
        });
    }
    match resolve_follow_target(tx, &op.workspace_id, target_kind, &target_id)
        .map_err(|error| map_chat_rule(error, "chat follow target is not followable"))?
    {
        FollowTargetResolution::Followable => {}
        FollowTargetResolution::Missing => {
            return park_chat_coordinate(tx, op, "follow-target", &target_id);
        }
        FollowTargetResolution::Disallowed => {
            return Err(SyncError::InvalidInput {
                reason: "chat follow target is not followable",
            });
        }
    }
    tx.execute(
        "INSERT INTO chat_follows \
         (workspace_id,owner_user_id,target_kind,target_id,state,updated_at_ms,origin_id,origin_seq) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8) \
         ON CONFLICT(workspace_id,owner_user_id,target_kind,target_id) DO UPDATE SET \
           state=excluded.state,updated_at_ms=excluded.updated_at_ms,origin_id=excluded.origin_id,origin_seq=excluded.origin_seq \
         WHERE (excluded.updated_at_ms, excluded.state, excluded.origin_id, excluded.origin_seq) > \
               (updated_at_ms, state, origin_id, origin_seq)",
        params![op.workspace_id,owner_user_id,p.target_kind,target_id,p.state,p.at_ms,op.origin_id,op.origin_seq],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn apply_feed_read(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    p: FeedReadSet,
) -> Result<(), SyncError> {
    if p.last_seen_message_id.is_empty()
        || p.last_seen_message_id.encode_utf16().count() > 256
        || !is_persisted_safe_integer(p.last_seen_created_at_ms)
        || !is_persisted_safe_integer(p.at_ms)
    {
        return Err(SyncError::InvalidInput {
            reason: "chat feed read payload is invalid",
        });
    }
    let owner_user_id = normalize_feed_identity(&p.owner_user_id, "Feed owner")
        .map_err(|error| map_chat_rule(error, "chat feed read owner is invalid"))?;
    if owner_user_id != p.owner_user_id {
        return Err(SyncError::InvalidInput {
            reason: "chat feed read owner is invalid",
        });
    }
    let resolution = resolve_feed_coordinate(
        tx,
        &op.workspace_id,
        &owner_user_id,
        p.last_seen_created_at_ms,
        &p.last_seen_message_id,
    )
    .map_err(|error| map_chat_rule(error, "chat feed read coordinate is invalid"))?;
    match resolution {
        FeedCoordinateResolution::Visible => {}
        FeedCoordinateResolution::Missing => {
            return park_chat_coordinate(tx, op, "feed-message", &p.last_seen_message_id);
        }
        FeedCoordinateResolution::Disallowed => {
            return Err(SyncError::InvalidInput {
                reason: "chat feed read coordinate is not visible",
            });
        }
    }
    tx.execute(
        "INSERT INTO chat_feed_read_state \
         (workspace_id,owner_user_id,last_seen_created_at_ms,last_seen_message_id,updated_at_ms,origin_id,origin_seq) \
         VALUES (?1,?2,?3,?4,?5,?6,?7) \
         ON CONFLICT(workspace_id,owner_user_id) DO UPDATE SET \
           last_seen_created_at_ms=excluded.last_seen_created_at_ms,last_seen_message_id=excluded.last_seen_message_id,
           updated_at_ms=excluded.updated_at_ms,origin_id=excluded.origin_id,origin_seq=excluded.origin_seq \
         WHERE (excluded.last_seen_created_at_ms, excluded.last_seen_message_id, excluded.updated_at_ms, excluded.origin_id, excluded.origin_seq) > \
               (last_seen_created_at_ms, last_seen_message_id, updated_at_ms, origin_id, origin_seq)",
        params![op.workspace_id,owner_user_id,p.last_seen_created_at_ms,p.last_seen_message_id,p.at_ms,op.origin_id,op.origin_seq],
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
                .is_some_and(|value| (0..=crate::MAX_WIRE_INTEGER).contains(&value)));
    if p.attachment_id.is_empty()
        || p.thread_id.is_empty()
        || p.message_id.is_empty()
        || p.target_kind != "file"
        || !valid_object
        || !valid_path
        || !valid_heading
        || !is_persisted_safe_integer(p.created_at_ms)
    {
        return Err(SyncError::InvalidInput {
            reason: "chat attachment payload is invalid",
        });
    }
    let target = resolve_thread_message(tx, &op.workspace_id, &p.thread_id, &p.message_id)
        .map_err(|error| map_chat_rule(error, "chat attachment target is invalid"))?;
    match target {
        ThreadMessageResolution::Present => {}
        ThreadMessageResolution::Missing => {
            return park_chat_coordinate(tx, op, "attachment-message", &p.message_id);
        }
        ThreadMessageResolution::DifferentThread => {
            return Err(SyncError::InvalidInput {
                reason: "chat attachment target message belongs to another thread",
            });
        }
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
