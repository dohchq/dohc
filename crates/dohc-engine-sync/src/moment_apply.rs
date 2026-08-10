use dohc_engine_files::{
    PathClassification, classify_engine_file_path_normalized, search_policy::SearchPolicySnapshot,
};
use dohc_engine_storage::{EngineStore, FaultInjector, get_binary_blob, hex_sha256};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;

use crate::file_search::{
    delete_file_search_index, search_policy_for_store, upsert_file_search_index,
};
use crate::{ApplyOutcome, ReplicationEnvelope, SyncError, apply_envelope_with};

/// The stored origin for every replicated snapshot head.
///
/// Wire origins describe the originating peer's provenance. Local capture and
/// close guards treat `snapshots.metadata_origin` as proof of local disk state,
/// so replicated heads must carry the established replication origin instead.
pub(crate) const REPLICATED_SNAPSHOT_ORIGIN: &str = "sync";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MomentAppendPayload {
    moment_id: String,
    version_id: String,
    object_id: String,
    object_created_at_ms: Option<i64>,
    path: String,
    recorded_at_ms: i64,
    operation: String,
    payload_before_blob_sha256: Option<String>,
    payload_before_path: Option<String>,
    payload_after_blob_sha256: String,
    payload_after_path: String,
    payload_before_content_kind: Option<String>,
    payload_before_byte_length: Option<i64>,
    payload_after_content_kind: Option<String>,
    payload_after_byte_length: Option<i64>,
    metadata: Metadata,
    author: Option<MomentAuthor>,
    before_present: String,
    before_object_id: Option<String>,
    before_version_id: Option<String>,
    before_path: Option<String>,
    before_blob_sha256: Option<String>,
    before_content_kind: Option<String>,
    before_byte_length: Option<i64>,
    before_updated_at_ms: Option<i64>,
    before_latest_moment_id: Option<String>,
    before_metadata: Option<Metadata>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Metadata {
    pub(crate) origin: String,
    pub(crate) summary: Option<String>,
    pub(crate) correlation_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MomentAuthor {
    kind: String,
    agent_id: String,
    on_behalf_of: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_run_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContentKind {
    Text,
    Binary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MomentMaterializationChange {
    pub path: String,
    pub operation: &'static str,
    pub content_kind: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MomentApplyResult {
    pub conflicts_opened: i64,
    pub materialization_changes: Vec<MomentMaterializationChange>,
}

impl ContentKind {
    fn from_wire(value: Option<&str>) -> Self {
        if value == Some("binary") {
            Self::Binary
        } else {
            Self::Text
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Binary => "binary",
        }
    }
}

#[derive(Debug, Clone)]
struct Snapshot {
    object_id: String,
    path: String,
    kind: ContentKind,
    digest: String,
    text: String,
    updated_at_ms: i64,
    latest_moment_id: String,
    metadata: Metadata,
}

#[derive(Debug, Clone)]
enum MomentBefore {
    Absent,
    Null,
    Present(Box<Snapshot>),
}

#[derive(Debug, Clone)]
pub(crate) struct ConflictSide {
    pub(crate) exists: bool,
    pub(crate) path: String,
    pub(crate) object_id: Option<String>,
    pub(crate) kind: Option<ContentKind>,
    pub(crate) digest: Option<String>,
    pub(crate) updated_at_ms: Option<i64>,
    pub(crate) latest_moment_id: Option<String>,
    pub(crate) metadata: Option<Metadata>,
}

impl ConflictSide {
    pub(crate) fn absent(path: impl Into<String>) -> Self {
        Self {
            exists: false,
            path: path.into(),
            object_id: None,
            kind: None,
            digest: None,
            updated_at_ms: None,
            latest_moment_id: None,
            metadata: None,
        }
    }

    fn text_digest(&self) -> Option<&str> {
        (self.kind == Some(ContentKind::Text))
            .then_some(self.digest.as_deref())
            .flatten()
    }

    fn binary_digest(&self) -> Option<&str> {
        (self.kind == Some(ContentKind::Binary))
            .then_some(self.digest.as_deref())
            .flatten()
    }
}

pub(crate) enum CoalesceAnchor<'a> {
    SameObject {
        diverging_object_id: &'a str,
        incoming_branch_base: Option<&'a str>,
    },
    Occupancy {
        occupant_object_id: &'a str,
        incoming_branch_base: Option<&'a str>,
    },
}

pub(crate) struct OpenConflict<'a> {
    pub(crate) version_id: &'a str,
    pub(crate) anchor: CoalesceAnchor<'a>,
    pub(crate) conflict_id: &'a str,
    pub(crate) path: &'a str,
    pub(crate) base: &'a ConflictSide,
    pub(crate) current: &'a ConflictSide,
    pub(crate) incoming: &'a ConflictSide,
    pub(crate) recorded_at_ms: i64,
}

pub fn apply_moment_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<i64>, SyncError> {
    apply_moment_envelope_detailed(store, envelope, faults)
        .map(|outcome| outcome.map(|result| result.conflicts_opened))
}

pub fn apply_moment_envelope_detailed(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<MomentApplyResult>, SyncError> {
    if envelope.op_kind != "moment.append" {
        return Err(SyncError::UnsupportedOperation);
    }
    envelope.validate()?;
    let search_policy = search_policy_for_store(store);
    apply_envelope_with(store, envelope, faults, |tx, envelope| {
        let payload: MomentAppendPayload = serde_json::from_value(envelope.payload.clone())
            .map_err(|_| SyncError::InvalidInput {
                reason: "moment.append payload is malformed",
            })?;
        validate_payload_bounds(&payload)?;
        apply_moment_append(tx, envelope, &payload, search_policy.as_ref())
    })
}

pub(crate) fn redelivered_materialization_changes(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<Vec<MomentMaterializationChange>, SyncError> {
    if envelope.op_kind != "moment.append" {
        return Ok(Vec::new());
    }
    let decision_id = materialization_decision_id(envelope);
    let encoded = store.read_with(|conn| {
        conn.query_row(
            "SELECT payload_hash FROM engine_requests \
             WHERE request_id=?1 AND kind='sync-materialization'",
            [&decision_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(SyncError::corrupt)
    })?;
    let Some(encoded) = encoded else {
        return Ok(Vec::new());
    };
    let values: Vec<serde_json::Value> =
        serde_json::from_str(&encoded).map_err(|_| SyncError::CoordinateDiverged)?;
    values
        .into_iter()
        .map(|value| {
            let path = value
                .get("path")
                .and_then(serde_json::Value::as_str)
                .ok_or(SyncError::CoordinateDiverged)?
                .to_owned();
            let operation = match value.get("operation").and_then(serde_json::Value::as_str) {
                Some("write") => "write",
                Some("delete") => "delete",
                _ => return Err(SyncError::CoordinateDiverged),
            };
            let content_kind = match value.get("contentKind").and_then(serde_json::Value::as_str) {
                Some("text") => "text",
                Some("binary") => "binary",
                _ => return Err(SyncError::CoordinateDiverged),
            };
            Ok(MomentMaterializationChange {
                path,
                operation,
                content_kind,
            })
        })
        .collect()
}

fn materialization_decision_id(envelope: &ReplicationEnvelope) -> String {
    let coordinate = format!(
        "{}\0{}\0{}",
        envelope.workspace_id, envelope.origin_id, envelope.origin_seq
    );
    format!(
        "sync-materialization:{}",
        dohc_engine_storage::hex_sha256(coordinate.as_bytes())
    )
}

fn record_materialization_changes(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    changes: &[MomentMaterializationChange],
) -> Result<(), SyncError> {
    if changes.is_empty() {
        return Ok(());
    }
    let encoded = serde_json::to_string(
        &changes
            .iter()
            .map(|change| {
                serde_json::json!({
                    "path": change.path,
                    "operation": change.operation,
                    "contentKind": change.content_kind,
                })
            })
            .collect::<Vec<_>>(),
    )
    .map_err(|_| SyncError::CoordinateDiverged)?;
    tx.execute(
        "INSERT INTO engine_requests \
         (request_id,payload_hash,result_seq,committed_at,kind) \
         VALUES (?1,?2,?3,?4,'sync-materialization')",
        params![
            materialization_decision_id(envelope),
            encoded,
            envelope.origin_seq,
            envelope.recorded_at_ms,
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

pub(crate) fn redelivered_conflicts_opened(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<i64, SyncError> {
    if envelope.op_kind != "moment.append" {
        return Ok(0);
    }
    let payload: MomentAppendPayload =
        serde_json::from_value(envelope.payload.clone()).map_err(|_| SyncError::InvalidInput {
            reason: "moment.append payload is malformed",
        })?;
    store.read_with(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM conflicts \
             WHERE workspace_id=?1 AND metadata_origin='sync' \
               AND incoming_latest_moment_id=?2 AND created_at_ms=?3",
            params![
                envelope.workspace_id,
                payload.moment_id,
                payload.recorded_at_ms
            ],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)
    })
}

fn apply_moment_append(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    payload: &MomentAppendPayload,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<MomentApplyResult, SyncError> {
    validate_payload(payload)?;
    require_version(tx, &envelope.workspace_id, &payload.version_id)?;

    let duplicate: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM moments WHERE workspace_id=?1 AND moment_id=?2) \
                 OR EXISTS(SELECT 1 FROM secret_moments \
                           WHERE workspace_id=?1 AND moment_id=?2)",
            params![envelope.workspace_id, payload.moment_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if duplicate {
        return Err(SyncError::InvalidInput {
            reason: "replicated plaintext moment id collides with existing history",
        });
    }

    let local = select_snapshot_by_object(
        tx,
        &envelope.workspace_id,
        &payload.version_id,
        &payload.object_id,
    )?;
    let path_occupant = if payload.operation == "delete" {
        None
    } else {
        select_snapshot_by_path(
            tx,
            &envelope.workspace_id,
            &payload.version_id,
            &payload.payload_after_path,
        )?
    };
    let conflicting_occupant =
        path_occupant.filter(|snapshot| snapshot.object_id != payload.object_id);

    let origin_saw_absent = matches!(payload.before_present.as_str(), "absent" | "null");
    let head_fast_forward = if origin_saw_absent {
        local.is_none() && conflicting_occupant.is_none()
    } else {
        local.as_ref().is_some_and(|snapshot| {
            Some(snapshot.latest_moment_id.as_str()) == payload.before_latest_moment_id.as_deref()
                || equivalent_ydoc_settlement_preimage(snapshot, payload)
        }) && conflicting_occupant.is_none()
    };
    let after_kind = ContentKind::from_wire(payload.payload_after_content_kind.as_deref());
    let after_text = if after_kind == ContentKind::Text {
        Some(require_blob_text(tx, &payload.payload_after_blob_sha256)?)
    } else {
        require_binary_blob(tx, &payload.payload_after_blob_sha256)?;
        None
    };
    let content_fast_forward = !head_fast_forward
        && if payload.operation == "delete" {
            local.is_none() && conflicting_occupant.is_none()
        } else {
            local.as_ref().is_some_and(|snapshot| {
                conflicting_occupant.is_none()
                    && snapshot.path == payload.payload_after_path
                    && snapshot.kind == after_kind
                    && match after_kind {
                        ContentKind::Text => Some(snapshot.text.as_str()) == after_text.as_deref(),
                        ContentKind::Binary => snapshot.digest == payload.payload_after_blob_sha256,
                    }
            })
        };

    validate_payload_sides(tx, payload)?;
    let remote_before = moment_before_from_payload(tx, payload)?;

    if content_fast_forward && payload.operation == "delete" {
        ensure_file_object(tx, &envelope.workspace_id, payload)?;
        insert_moment(tx, &envelope.workspace_id, payload, &remote_before, true)?;
        return Ok(MomentApplyResult {
            conflicts_opened: 0,
            materialization_changes: Vec::new(),
        });
    }

    if head_fast_forward || content_fast_forward {
        let active = is_active_version(tx, &envelope.workspace_id, &payload.version_id)?;
        let adopted_before = if content_fast_forward && !head_fast_forward {
            local.as_ref().map_or(remote_before.clone(), |snapshot| {
                MomentBefore::Present(Box::new(snapshot.clone()))
            })
        } else {
            remote_before
        };
        ensure_file_object(tx, &envelope.workspace_id, payload)?;
        insert_moment(tx, &envelope.workspace_id, payload, &adopted_before, false)?;
        if payload.operation == "delete" {
            let alias_path = local
                .as_ref()
                .map_or(payload.path.as_str(), |snapshot| snapshot.path.as_str());
            tx.execute(
                "DELETE FROM path_aliases \
                 WHERE workspace_id=?1 AND version_id=?2 AND path=?3 AND object_id=?4",
                params![
                    envelope.workspace_id,
                    payload.version_id,
                    alias_path,
                    payload.object_id
                ],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "DELETE FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![envelope.workspace_id, payload.version_id, payload.object_id],
            )
            .map_err(SyncError::persist)?;
            delete_file_search_index(
                tx,
                &envelope.workspace_id,
                &payload.version_id,
                &payload.object_id,
            )?;
            let materialization_changes = active
                .then(|| MomentMaterializationChange {
                    path: payload.path.clone(),
                    operation: "delete",
                    content_kind: after_kind.as_str(),
                })
                .into_iter()
                .collect::<Vec<_>>();
            record_materialization_changes(tx, envelope, &materialization_changes)?;
            return Ok(MomentApplyResult {
                conflicts_opened: 0,
                materialization_changes,
            });
        }

        if payload.operation == "rename" {
            let before_path = local.as_ref().map_or_else(
                || payload.payload_before_path.as_deref(),
                |snapshot| Some(snapshot.path.as_str()),
            );
            if let Some(before_path) = before_path {
                tx.execute(
                    "DELETE FROM path_aliases \
                 WHERE workspace_id=?1 AND version_id=?2 AND path=?3 AND object_id=?4",
                    params![
                        envelope.workspace_id,
                        payload.version_id,
                        before_path,
                        payload.object_id
                    ],
                )
                .map_err(SyncError::persist)?;
            }
        }
        tx.execute(
            "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
             VALUES (?1,?2,?3,?4) \
             ON CONFLICT(workspace_id,version_id,path) DO UPDATE SET object_id=excluded.object_id",
            params![
                envelope.workspace_id,
                payload.version_id,
                payload.payload_after_path,
                payload.object_id
            ],
        )
        .map_err(SyncError::persist)?;
        let byte_length = match after_kind {
            ContentKind::Text => after_text
                .as_ref()
                .map(|text| text.len() as i64)
                .ok_or(SyncError::BlobInvalid)?,
            ContentKind::Binary => payload
                .payload_after_byte_length
                .unwrap_or(require_binary_blob(tx, &payload.payload_after_blob_sha256)?),
        };
        upsert_snapshot(tx, &envelope.workspace_id, payload, after_kind, byte_length)?;
        upsert_search_row(
            tx,
            &envelope.workspace_id,
            payload,
            after_kind,
            after_text.as_deref().unwrap_or(""),
            search_policy,
        )?;
        let mut materialization_changes = Vec::new();
        if active {
            if payload.operation == "rename"
                && let Some(before_path) = payload.payload_before_path.as_deref()
                && before_path != payload.payload_after_path
            {
                materialization_changes.push(MomentMaterializationChange {
                    path: before_path.to_owned(),
                    operation: "delete",
                    content_kind: after_kind.as_str(),
                });
            }
            materialization_changes.push(MomentMaterializationChange {
                path: payload.payload_after_path.clone(),
                operation: "write",
                content_kind: after_kind.as_str(),
            });
        }
        record_materialization_changes(tx, envelope, &materialization_changes)?;
        return Ok(MomentApplyResult {
            conflicts_opened: 0,
            materialization_changes,
        });
    }

    ensure_file_object(tx, &envelope.workspace_id, payload)?;
    insert_moment(tx, &envelope.workspace_id, payload, &remote_before, true)?;
    let current_snapshot = local.as_ref().or(conflicting_occupant.as_ref());
    let current = current_snapshot.map_or_else(
        || {
            ConflictSide::absent(
                payload
                    .before_path
                    .as_deref()
                    .or(payload.payload_before_path.as_deref())
                    .unwrap_or(&payload.path),
            )
        },
        side_from_snapshot,
    );
    let incoming = incoming_side(payload);
    let base_moment_id = payload.before_latest_moment_id.as_deref();
    let local_root = local_branch_root(
        tx,
        &envelope.workspace_id,
        &payload.version_id,
        &payload.object_id,
        base_moment_id,
    )?;
    let conflict_id = sync_conflict_id(
        &envelope.workspace_id,
        &payload.version_id,
        &payload.object_id,
        base_moment_id,
        Some((local_root.as_deref(), Some(payload.moment_id.as_str()))),
    );
    let base = before_conflict_side(payload);
    let mut opened = open_or_coalesce(
        tx,
        &envelope.workspace_id,
        OpenConflict {
            version_id: &payload.version_id,
            anchor: CoalesceAnchor::SameObject {
                diverging_object_id: &payload.object_id,
                incoming_branch_base: base_moment_id,
            },
            conflict_id: &conflict_id,
            path: &current.path,
            base: &base,
            current: &current,
            incoming: &incoming,
            recorded_at_ms: payload.recorded_at_ms,
        },
    )?;

    if let (Some(_), Some(occupant)) = (local.as_ref(), conflicting_occupant.as_ref()) {
        let occupancy_id = sync_conflict_id(
            &envelope.workspace_id,
            &payload.version_id,
            &occupant.object_id,
            Some(&occupant.latest_moment_id),
            Some((
                Some(occupant.latest_moment_id.as_str()),
                Some(payload.moment_id.as_str()),
            )),
        );
        let occupancy_base = ConflictSide::absent(&occupant.path);
        let occupancy_current = side_from_snapshot(occupant);
        opened += open_or_coalesce(
            tx,
            &envelope.workspace_id,
            OpenConflict {
                version_id: &payload.version_id,
                anchor: CoalesceAnchor::Occupancy {
                    occupant_object_id: &occupant.object_id,
                    incoming_branch_base: base_moment_id,
                },
                conflict_id: &occupancy_id,
                path: &occupant.path,
                base: &occupancy_base,
                current: &occupancy_current,
                incoming: &incoming,
                recorded_at_ms: payload.recorded_at_ms,
            },
        )?;
    }
    Ok(MomentApplyResult {
        conflicts_opened: opened,
        materialization_changes: Vec::new(),
    })
}

fn equivalent_ydoc_settlement_preimage(snapshot: &Snapshot, payload: &MomentAppendPayload) -> bool {
    snapshot.kind == ContentKind::Text
        && is_ydoc_settlement_moment_id(&snapshot.latest_moment_id)
        && payload
            .before_latest_moment_id
            .as_deref()
            .is_some_and(is_ydoc_settlement_moment_id)
        && payload.before_object_id.as_deref() == Some(snapshot.object_id.as_str())
        && payload.before_version_id.as_deref() == Some(payload.version_id.as_str())
        && payload.before_path.as_deref() == Some(snapshot.path.as_str())
        && payload.before_blob_sha256.as_deref() == Some(snapshot.digest.as_str())
        && ContentKind::from_wire(payload.before_content_kind.as_deref()) == snapshot.kind
        && payload.payload_before_path.as_deref() == Some(snapshot.path.as_str())
        && payload.payload_before_blob_sha256.as_deref() == Some(snapshot.digest.as_str())
        && ContentKind::from_wire(payload.payload_before_content_kind.as_deref()) == snapshot.kind
}

fn is_ydoc_settlement_moment_id(moment_id: &str) -> bool {
    moment_id
        .strip_prefix("moment-ydoc-apply-")
        .or_else(|| moment_id.strip_prefix("moment-ydoc-"))
        .is_some_and(|digest| {
            digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn is_active_version(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
) -> Result<bool, SyncError> {
    let active: Option<String> = tx
        .query_row(
            "SELECT COALESCE( \
               (SELECT version_id FROM active_versions WHERE workspace_id=?1), \
               (SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1) \
             )",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    Ok(active.as_deref() == Some(version_id))
}

fn validate_payload(payload: &MomentAppendPayload) -> Result<(), SyncError> {
    if !matches!(payload.operation.as_str(), "write" | "rename" | "delete")
        || !matches!(
            payload.before_present.as_str(),
            "absent" | "null" | "present"
        )
        || payload.version_id.is_empty()
        || payload.path.is_empty()
        || payload.payload_after_path.is_empty()
        || !valid_replicated_origin(&payload.metadata.origin)
        || payload
            .before_metadata
            .as_ref()
            .is_some_and(|metadata| !valid_replicated_origin(&metadata.origin))
        || payload.author.as_ref().is_some_and(|author| {
            author.kind != "agent"
                || author.agent_id.is_empty()
                || author.on_behalf_of.is_empty()
                || author.agent_run_id.as_ref().is_some_and(String::is_empty)
        })
    {
        return Err(SyncError::InvalidInput {
            reason: "moment.append payload is invalid",
        });
    }
    match (
        payload.payload_before_path.as_deref(),
        payload.payload_before_blob_sha256.as_deref(),
    ) {
        (None, None) => {}
        (Some(path), Some(sha)) if !path.is_empty() && !sha.is_empty() => {}
        _ => {
            return Err(SyncError::InvalidInput {
                reason: "moment.append payload-before path and digest must appear together",
            });
        }
    }
    validate_every_path_field(payload)?;
    Ok(())
}

fn validate_payload_bounds(payload: &MomentAppendPayload) -> Result<(), SyncError> {
    crate::model::bounded(
        &payload.moment_id,
        "moment.append moment id must be non-empty and bounded",
    )?;
    crate::model::bounded(
        &payload.object_id,
        "moment.append object id must be non-empty and bounded",
    )?;
    Ok(())
}

fn valid_replicated_origin(origin: &str) -> bool {
    matches!(
        origin,
        "api" | "local-file" | "restore" | "sync" | "unknown"
    )
}

fn validate_every_path_field(payload: &MomentAppendPayload) -> Result<(), SyncError> {
    let MomentAppendPayload {
        moment_id: _,
        version_id: _,
        object_id: _,
        object_created_at_ms: _,
        path,
        recorded_at_ms: _,
        operation: _,
        payload_before_blob_sha256: _,
        payload_before_path,
        payload_after_blob_sha256: _,
        payload_after_path,
        payload_before_content_kind: _,
        payload_before_byte_length: _,
        payload_after_content_kind: _,
        payload_after_byte_length: _,
        metadata: _,
        author: _,
        before_present: _,
        before_object_id: _,
        before_version_id: _,
        before_path,
        before_blob_sha256: _,
        before_content_kind: _,
        before_byte_length: _,
        before_updated_at_ms: _,
        before_latest_moment_id: _,
        before_metadata: _,
    } = payload;

    [
        Some(path.as_str()),
        payload_before_path.as_deref(),
        Some(payload_after_path.as_str()),
        before_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    .try_for_each(validate_canonical_tracked_path)
}

fn validate_canonical_tracked_path(path: &str) -> Result<(), SyncError> {
    let (classification, normalized) = classify_engine_file_path_normalized(path);
    if classification != PathClassification::Tracked || normalized.as_deref() != Some(path) {
        return Err(SyncError::InvalidInput {
            reason: "moment.append path must be canonical tracked plaintext",
        });
    }
    Ok(())
}

fn require_version(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
) -> Result<(), SyncError> {
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM versions WHERE workspace_id=?1 AND version_id=?2)",
            params![workspace_id, version_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if exists {
        return Ok(());
    }
    // A cross-origin moment can arrive before its version.create. Refusing and
    // acking here would make that ordering race permanent instead of retryable.
    Err(SyncError::RetryableState {
        reason: "moment.append target version is missing",
    })
}

fn validate_payload_sides(
    tx: &Transaction<'_>,
    payload: &MomentAppendPayload,
) -> Result<(), SyncError> {
    if let (Some(sha), Some(_path)) = (
        payload.payload_before_blob_sha256.as_deref(),
        payload.payload_before_path.as_deref(),
    ) {
        hydrate_wire_side(
            tx,
            sha,
            ContentKind::from_wire(payload.payload_before_content_kind.as_deref()),
            payload.payload_before_byte_length,
        )?;
    }
    hydrate_wire_side(
        tx,
        &payload.payload_after_blob_sha256,
        ContentKind::from_wire(payload.payload_after_content_kind.as_deref()),
        payload.payload_after_byte_length,
    )?;
    Ok(())
}

fn hydrate_wire_side(
    tx: &Transaction<'_>,
    sha: &str,
    kind: ContentKind,
    _byte_length: Option<i64>,
) -> Result<(), SyncError> {
    if kind == ContentKind::Binary {
        require_binary_blob(tx, sha)?;
    } else {
        require_blob_text(tx, sha)?;
    }
    Ok(())
}

fn moment_before_from_payload(
    tx: &Transaction<'_>,
    payload: &MomentAppendPayload,
) -> Result<MomentBefore, SyncError> {
    match payload.before_present.as_str() {
        "absent" => Ok(MomentBefore::Absent),
        "null" => Ok(MomentBefore::Null),
        "present" => {
            let kind = ContentKind::from_wire(payload.before_content_kind.as_deref());
            let digest = payload.before_blob_sha256.clone().unwrap_or_default();
            let (text, byte_length) = match kind {
                ContentKind::Text => {
                    let text = require_blob_text(tx, &digest)?;
                    let length = text.len() as i64;
                    (text, length)
                }
                ContentKind::Binary => {
                    let length = match payload.before_byte_length {
                        Some(length) => length,
                        None => require_binary_blob(tx, &digest)?,
                    };
                    (String::new(), length)
                }
            };
            payload
                .before_version_id
                .as_ref()
                .ok_or(SyncError::InvalidInput {
                    reason: "moment.append before version is missing",
                })?;
            let _ = byte_length;
            Ok(MomentBefore::Present(Box::new(Snapshot {
                object_id: payload
                    .before_object_id
                    .clone()
                    .ok_or(SyncError::InvalidInput {
                        reason: "moment.append before object is missing",
                    })?,
                path: payload.before_path.clone().ok_or(SyncError::InvalidInput {
                    reason: "moment.append before path is missing",
                })?,
                kind,
                digest,
                text,
                updated_at_ms: payload
                    .before_updated_at_ms
                    .ok_or(SyncError::InvalidInput {
                        reason: "moment.append before timestamp is missing",
                    })?,
                latest_moment_id: payload.before_latest_moment_id.clone().ok_or(
                    SyncError::InvalidInput {
                        reason: "moment.append before head is missing",
                    },
                )?,
                metadata: payload.before_metadata.clone().unwrap_or(Metadata {
                    origin: "unknown".to_owned(),
                    summary: None,
                    correlation_id: None,
                }),
            })))
        }
        _ => Err(SyncError::InvalidInput {
            reason: "moment.append before presence is invalid",
        }),
    }
}

fn require_blob_text(tx: &Transaction<'_>, sha: &str) -> Result<String, SyncError> {
    let row: Option<(i64, String)> = tx
        .query_row(
            "SELECT byte_length,text FROM blobs WHERE sha256=?1",
            [sha],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let (byte_length, text) = row.ok_or(SyncError::BlobInvalid)?;
    if usize::try_from(byte_length).ok() != Some(text.len()) {
        return Err(SyncError::corrupt(std::io::Error::other(
            "text blob byte length mismatch",
        )));
    }
    if hex_sha256(text.as_bytes()) != sha {
        return Err(SyncError::BlobInvalid);
    }
    Ok(text)
}

fn require_binary_blob(tx: &Transaction<'_>, sha: &str) -> Result<i64, SyncError> {
    get_binary_blob(tx, sha)?
        .map(|bytes| bytes.len() as i64)
        .ok_or(SyncError::BlobInvalid)
}

fn select_snapshot_by_object(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<Option<Snapshot>, SyncError> {
    tx.query_row(
        "SELECT s.object_id,s.version_id,s.path,COALESCE(s.content_kind,'text'), \
                s.blob_sha256,s.binary_sha256,b.text,COALESCE(b.byte_length,bb.byte_length), \
                s.updated_at_ms,s.latest_moment_id,s.metadata_origin,
                s.metadata_summary,s.metadata_correlation_id \
         FROM snapshots s \
         LEFT JOIN blobs b ON b.sha256=s.blob_sha256 AND COALESCE(s.content_kind,'text')='text' \
         LEFT JOIN binary_blobs bb ON bb.sha256=s.binary_sha256 AND COALESCE(s.content_kind,'text')='binary' \
         WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3",
        params![workspace_id, version_id, object_id],
        snapshot_from_row,
    )
    .optional()
    .map_err(SyncError::corrupt)?
    .transpose()
}

fn select_snapshot_by_path(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<Snapshot>, SyncError> {
    let aliased = tx
        .query_row(
            "SELECT s.object_id,s.version_id,s.path,COALESCE(s.content_kind,'text'), \
                    s.blob_sha256,s.binary_sha256,b.text,COALESCE(b.byte_length,bb.byte_length), \
                    s.updated_at_ms,s.latest_moment_id,s.metadata_origin,
                    s.metadata_summary,s.metadata_correlation_id \
             FROM path_aliases a \
             JOIN snapshots s ON s.workspace_id=a.workspace_id AND s.version_id=a.version_id AND s.object_id=a.object_id \
             LEFT JOIN blobs b ON b.sha256=s.blob_sha256 AND COALESCE(s.content_kind,'text')='text' \
             LEFT JOIN binary_blobs bb ON bb.sha256=s.binary_sha256 AND COALESCE(s.content_kind,'text')='binary' \
             WHERE a.workspace_id=?1 AND a.version_id=?2 AND a.path=?3",
            params![workspace_id, version_id, path],
            snapshot_from_row,
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .transpose()?;
    if let Some(snapshot) = aliased {
        if snapshot.path != path {
            return Err(SyncError::CoordinateDiverged);
        }
        return Ok(Some(snapshot));
    }
    let mut statement = tx
        .prepare(
            "SELECT s.object_id,s.version_id,s.path,COALESCE(s.content_kind,'text'), \
                    s.blob_sha256,s.binary_sha256,b.text,COALESCE(b.byte_length,bb.byte_length), \
                    s.updated_at_ms,s.latest_moment_id,s.metadata_origin,
                    s.metadata_summary,s.metadata_correlation_id \
             FROM snapshots s \
             LEFT JOIN blobs b ON b.sha256=s.blob_sha256 AND COALESCE(s.content_kind,'text')='text' \
             LEFT JOIN binary_blobs bb ON bb.sha256=s.binary_sha256 AND COALESCE(s.content_kind,'text')='binary' \
             WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.path=?3 LIMIT 2",
        )
        .map_err(SyncError::corrupt)?;
    let rows = statement
        .query_map(params![workspace_id, version_id, path], snapshot_from_row)
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    if rows.len() > 1 {
        return Err(SyncError::CoordinateDiverged);
    }
    rows.into_iter().next().transpose()
}

fn snapshot_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Snapshot, SyncError>> {
    let kind: String = row.get(3)?;
    let kind = match kind.as_str() {
        "text" => ContentKind::Text,
        "binary" => ContentKind::Binary,
        _ => {
            return Ok(Err(SyncError::CoordinateDiverged));
        }
    };
    let text: Option<String> = row.get(6)?;
    let digest = match kind {
        ContentKind::Text => row.get::<_, Option<String>>(4)?,
        ContentKind::Binary => row.get::<_, Option<String>>(5)?,
    };
    let Some(digest) = digest else {
        return Ok(Err(SyncError::CoordinateDiverged));
    };
    let text = match (kind, text) {
        (ContentKind::Text, Some(text)) => text,
        (ContentKind::Binary, _) => String::new(),
        _ => return Ok(Err(SyncError::CoordinateDiverged)),
    };
    let byte_length: Option<i64> = row.get(7)?;
    if byte_length.is_none() {
        return Ok(Err(SyncError::CoordinateDiverged));
    }
    let _version_id: String = row.get(1)?;
    Ok(Ok(Snapshot {
        object_id: row.get(0)?,
        path: row.get(2)?,
        kind,
        digest,
        text,
        updated_at_ms: row.get(8)?,
        latest_moment_id: row.get(9)?,
        metadata: Metadata {
            origin: row.get(10)?,
            summary: row.get(11)?,
            correlation_id: row.get(12)?,
        },
    }))
}

fn ensure_file_object(
    tx: &Transaction<'_>,
    workspace_id: &str,
    payload: &MomentAppendPayload,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT OR IGNORE INTO file_objects (workspace_id,object_id,created_at_ms) \
         VALUES (?1,?2,?3)",
        params![
            workspace_id,
            payload.object_id,
            payload
                .object_created_at_ms
                .unwrap_or(payload.recorded_at_ms)
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn insert_moment(
    tx: &Transaction<'_>,
    workspace_id: &str,
    payload: &MomentAppendPayload,
    before: &MomentBefore,
    record_only: bool,
) -> Result<(), SyncError> {
    let order: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(moment_order),-1)+1 FROM moments WHERE workspace_id=?1",
            [workspace_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    let after_kind = ContentKind::from_wire(payload.payload_after_content_kind.as_deref());
    let (after_text_sha, after_binary_sha) = match after_kind {
        ContentKind::Text => (Some(payload.payload_after_blob_sha256.as_str()), None),
        ContentKind::Binary if payload.payload_after_blob_sha256.is_empty() => {
            return Err(SyncError::BlobInvalid);
        }
        ContentKind::Binary => (None, Some(payload.payload_after_blob_sha256.as_str())),
    };
    let (before_present, before_kind, before_text_sha, before_binary_sha, before_latest) =
        match before {
            MomentBefore::Absent => (0_i64, ContentKind::Text, None, None, None),
            MomentBefore::Null => (1_i64, ContentKind::Text, None, None, None),
            MomentBefore::Present(snapshot) => match snapshot.kind {
                ContentKind::Text => (
                    2,
                    snapshot.kind,
                    Some(snapshot.digest.as_str()),
                    None,
                    Some(snapshot.latest_moment_id.as_str()),
                ),
                ContentKind::Binary if snapshot.digest.is_empty() => {
                    return Err(SyncError::BlobInvalid);
                }
                ContentKind::Binary => (
                    2,
                    snapshot.kind,
                    None,
                    Some(snapshot.digest.as_str()),
                    Some(snapshot.latest_moment_id.as_str()),
                ),
            },
        };
    let (
        before_object_id,
        before_version_id,
        before_path,
        before_updated_at_ms,
        before_metadata_origin,
        before_metadata_summary,
        before_metadata_correlation_id,
    ) = match before {
        MomentBefore::Present(snapshot) => (
            Some(snapshot.object_id.as_str()),
            Some(payload.version_id.as_str()),
            Some(snapshot.path.as_str()),
            Some(snapshot.updated_at_ms),
            Some(snapshot.metadata.origin.as_str()),
            snapshot.metadata.summary.as_deref(),
            snapshot.metadata.correlation_id.as_deref(),
        ),
        MomentBefore::Absent | MomentBefore::Null => (None, None, None, None, None, None, None),
    };
    let author_json = payload
        .author
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| SyncError::InvalidInput {
            reason: "moment.append author is invalid",
        })?;
    let payload_before_kind = payload
        .payload_before_path
        .as_ref()
        .map(|_| ContentKind::from_wire(payload.payload_before_content_kind.as_deref()).as_str());
    tx.execute(
        "INSERT INTO moments (
           workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms,
           operation,after_blob_sha256,before_present,before_blob_sha256,
           before_latest_moment_id,metadata_origin,metadata_summary,
           metadata_correlation_id,author_json,sync_record_only,
           after_content_kind,after_binary_sha256,before_content_kind,before_binary_sha256,
           payload_before_path,payload_before_content_kind,payload_before_blob_sha256,
           payload_after_path,payload_after_content_kind,payload_after_blob_sha256,
           before_object_id,before_version_id,before_path,before_updated_at_ms,
           before_metadata_origin,before_metadata_summary,before_metadata_correlation_id
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,
                   ?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34)",
        params![
            workspace_id,
            order,
            payload.moment_id,
            payload.version_id,
            payload.object_id,
            payload.path,
            payload.recorded_at_ms,
            payload.operation,
            after_text_sha,
            before_present,
            before_text_sha,
            before_latest,
            payload.metadata.origin,
            payload.metadata.summary,
            payload.metadata.correlation_id,
            author_json,
            record_only.then_some(1_i64),
            after_kind.as_str(),
            after_binary_sha,
            before_kind.as_str(),
            before_binary_sha,
            payload.payload_before_path,
            payload_before_kind,
            payload.payload_before_blob_sha256,
            payload.payload_after_path,
            after_kind.as_str(),
            payload.payload_after_blob_sha256,
            before_object_id,
            before_version_id,
            before_path,
            before_updated_at_ms,
            before_metadata_origin,
            before_metadata_summary,
            before_metadata_correlation_id,
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn upsert_snapshot(
    tx: &Transaction<'_>,
    workspace_id: &str,
    payload: &MomentAppendPayload,
    kind: ContentKind,
    _byte_length: i64,
) -> Result<(), SyncError> {
    let (text_sha, binary_sha) = match kind {
        ContentKind::Text => (Some(payload.payload_after_blob_sha256.as_str()), None),
        ContentKind::Binary => (None, Some(payload.payload_after_blob_sha256.as_str())),
    };
    tx.execute(
        "INSERT INTO snapshots (
           workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,
           latest_moment_id,metadata_origin,metadata_summary,
           metadata_correlation_id,content_kind,binary_sha256
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET
           path=excluded.path,blob_sha256=excluded.blob_sha256,
           updated_at_ms=excluded.updated_at_ms,latest_moment_id=excluded.latest_moment_id,
           metadata_origin=excluded.metadata_origin,
           metadata_summary=excluded.metadata_summary,
           metadata_correlation_id=excluded.metadata_correlation_id,
           content_kind=excluded.content_kind,
           binary_sha256=excluded.binary_sha256",
        params![
            workspace_id,
            payload.version_id,
            payload.object_id,
            payload.payload_after_path,
            text_sha,
            payload.recorded_at_ms,
            payload.moment_id,
            REPLICATED_SNAPSHOT_ORIGIN,
            payload.metadata.summary,
            payload.metadata.correlation_id,
            kind.as_str(),
            binary_sha
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn upsert_search_row(
    tx: &Transaction<'_>,
    workspace_id: &str,
    payload: &MomentAppendPayload,
    kind: ContentKind,
    text: &str,
    policy: Option<&SearchPolicySnapshot>,
) -> Result<(), SyncError> {
    upsert_file_search_index(
        tx,
        workspace_id,
        &payload.version_id,
        &payload.object_id,
        &payload.payload_after_path,
        (kind == ContentKind::Text).then_some(text),
        policy,
    )
}

fn side_from_snapshot(snapshot: &Snapshot) -> ConflictSide {
    ConflictSide {
        exists: true,
        path: snapshot.path.clone(),
        object_id: Some(snapshot.object_id.clone()),
        kind: Some(snapshot.kind),
        digest: Some(snapshot.digest.clone()),
        updated_at_ms: Some(snapshot.updated_at_ms),
        latest_moment_id: Some(snapshot.latest_moment_id.clone()),
        metadata: Some(snapshot.metadata.clone()),
    }
}

fn before_conflict_side(payload: &MomentAppendPayload) -> ConflictSide {
    if payload.before_present != "present" {
        return ConflictSide::absent(
            payload
                .payload_before_path
                .as_deref()
                .unwrap_or(&payload.path),
        );
    }
    ConflictSide {
        exists: true,
        path: payload
            .before_path
            .clone()
            .unwrap_or_else(|| payload.path.clone()),
        object_id: payload.before_object_id.clone(),
        kind: Some(ContentKind::from_wire(
            payload.before_content_kind.as_deref(),
        )),
        digest: Some(payload.before_blob_sha256.clone().unwrap_or_default()),
        updated_at_ms: payload.before_updated_at_ms,
        latest_moment_id: payload.before_latest_moment_id.clone(),
        metadata: Some(payload.before_metadata.clone().unwrap_or(Metadata {
            origin: "unknown".to_owned(),
            summary: None,
            correlation_id: None,
        })),
    }
}

fn incoming_side(payload: &MomentAppendPayload) -> ConflictSide {
    if payload.operation == "delete" {
        return ConflictSide::absent(&payload.payload_after_path);
    }
    ConflictSide {
        exists: true,
        path: payload.payload_after_path.clone(),
        object_id: Some(payload.object_id.clone()),
        kind: Some(ContentKind::from_wire(
            payload.payload_after_content_kind.as_deref(),
        )),
        digest: Some(payload.payload_after_blob_sha256.clone()),
        updated_at_ms: Some(payload.recorded_at_ms),
        latest_moment_id: Some(payload.moment_id.clone()),
        metadata: Some(payload.metadata.clone()),
    }
}

fn local_branch_root(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    base_moment_id: Option<&str>,
) -> Result<Option<String>, SyncError> {
    tx.query_row(
        "SELECT moment_id FROM moments \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
           AND before_latest_moment_id IS ?4 \
           AND (sync_record_only IS NULL OR sync_record_only=0) \
         ORDER BY moment_order LIMIT 1",
        params![workspace_id, version_id, object_id, base_moment_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(SyncError::corrupt)
}

pub(crate) fn sync_conflict_id(
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    base_moment_id: Option<&str>,
    roots: Option<(Option<&str>, Option<&str>)>,
) -> String {
    let mut input = format!(
        "{workspace_id}\0{version_id}\0{object_id}\0{}",
        base_moment_id.unwrap_or("\0absent-base")
    );
    if let Some((local, incoming)) = roots {
        let local = local.unwrap_or("\0absent-local-root");
        let incoming = incoming.unwrap_or("\0absent-incoming-root");
        let (low, high) = if js_string_cmp(local, incoming) != Ordering::Greater {
            (local, incoming)
        } else {
            (incoming, local)
        };
        input.push('\0');
        input.push_str(low);
        input.push('\0');
        input.push_str(high);
    }
    let digest = Sha256::digest(input.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    format!("conflict_sync_{}", &hex[..32])
}

fn js_string_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

pub(crate) fn open_or_coalesce(
    tx: &Transaction<'_>,
    workspace_id: &str,
    conflict: OpenConflict<'_>,
) -> Result<i64, SyncError> {
    let existing = match conflict.anchor {
        CoalesceAnchor::SameObject {
            diverging_object_id,
            incoming_branch_base,
        } => tx
            .query_row(
                "SELECT conflict_id FROM conflicts \
                 WHERE workspace_id=?1 AND status='open' AND metadata_origin='sync' \
                   AND target_version_id=?2 AND incoming_object_id IS ?3 \
                   AND incoming_latest_moment_id IS ?4 \
                 ORDER BY (current_object_id IS ?3) DESC,created_at_ms,conflict_id LIMIT 1",
                params![
                    workspace_id,
                    conflict.version_id,
                    diverging_object_id,
                    incoming_branch_base
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?,
        CoalesceAnchor::Occupancy {
            occupant_object_id,
            incoming_branch_base,
        } => tx
            .query_row(
                "SELECT conflict_id FROM conflicts \
                 WHERE workspace_id=?1 AND status='open' AND metadata_origin='sync' \
                   AND target_version_id=?2 AND current_object_id IS ?3 \
                   AND incoming_latest_moment_id IS ?4 \
                 ORDER BY created_at_ms,conflict_id LIMIT 1",
                params![
                    workspace_id,
                    conflict.version_id,
                    occupant_object_id,
                    incoming_branch_base
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?,
    };
    if let Some(conflict_id) = existing {
        coalesce_conflict_sides(
            tx,
            workspace_id,
            &conflict_id,
            conflict.incoming,
            conflict.recorded_at_ms,
        )?;
        return Ok(0);
    }

    let duplicate: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM conflicts WHERE workspace_id=?1 AND conflict_id=?2)",
            params![workspace_id, conflict.conflict_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if duplicate {
        return Ok(0);
    }
    insert_conflict(tx, workspace_id, &conflict)?;
    Ok(1)
}

pub(crate) fn coalesce_conflict_sides(
    tx: &Transaction<'_>,
    workspace_id: &str,
    conflict_id: &str,
    incoming: &ConflictSide,
    updated_at_ms: i64,
) -> Result<(), SyncError> {
    tx.execute(
        "UPDATE conflicts SET updated_at_ms=?3,
           incoming_exists=?4,incoming_path=?5,incoming_object_id=?6,
           incoming_content_kind=?7,incoming_blob_sha256=?8,incoming_binary_sha256=?9,
           incoming_updated_at_ms=?10,incoming_latest_moment_id=?11,
           incoming_metadata_origin=?12,incoming_metadata_summary=?13,
           incoming_metadata_correlation_id=?14
         WHERE workspace_id=?1 AND conflict_id=?2",
        params![
            workspace_id,
            conflict_id,
            updated_at_ms,
            i64::from(incoming.exists),
            incoming.path,
            incoming.object_id,
            incoming.kind.map(ContentKind::as_str),
            incoming.text_digest(),
            incoming.binary_digest(),
            incoming.updated_at_ms,
            incoming.latest_moment_id,
            incoming
                .metadata
                .as_ref()
                .map(|value| value.origin.as_str()),
            incoming
                .metadata
                .as_ref()
                .and_then(|value| value.summary.as_deref()),
            incoming
                .metadata
                .as_ref()
                .and_then(|value| value.correlation_id.as_deref()),
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn insert_conflict(
    tx: &Transaction<'_>,
    workspace_id: &str,
    conflict: &OpenConflict<'_>,
) -> Result<(), SyncError> {
    let b = conflict.base;
    let c = conflict.current;
    let i = conflict.incoming;
    tx.execute(
        "INSERT INTO conflicts (
          workspace_id,conflict_id,path,target_version_id,source_version_id,
          created_at_ms,updated_at_ms,status,chosen_from,resolution,
          metadata_origin,metadata_summary,metadata_correlation_id,
          base_exists,base_path,base_object_id,base_content_kind,base_blob_sha256,
          base_updated_at_ms,base_latest_moment_id,base_metadata_origin,
          base_metadata_summary,base_metadata_correlation_id,
          current_exists,current_path,current_object_id,current_content_kind,current_blob_sha256,
          current_updated_at_ms,current_latest_moment_id,current_metadata_origin,
          current_metadata_summary,current_metadata_correlation_id,
          incoming_exists,incoming_path,incoming_object_id,incoming_content_kind,incoming_blob_sha256,
          incoming_updated_at_ms,incoming_latest_moment_id,incoming_metadata_origin,
          incoming_metadata_summary,incoming_metadata_correlation_id,
          base_binary_sha256,current_binary_sha256,incoming_binary_sha256
        ) VALUES (
          ?1,?2,?3,?4,?4,?5,?5,'open','current',NULL,'sync',NULL,NULL,
          ?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,
          ?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,
          ?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,
          ?36,?37,?38)",
        params![
            workspace_id,
            conflict.conflict_id,
            conflict.path,
            conflict.version_id,
            conflict.recorded_at_ms,
            i64::from(b.exists),
            b.path,
            b.object_id,
            b.kind.map(ContentKind::as_str),
            b.text_digest(),
            b.updated_at_ms,
            b.latest_moment_id,
            b.metadata.as_ref().map(|value| value.origin.as_str()),
            b.metadata
                .as_ref()
                .and_then(|value| value.summary.as_deref()),
            b.metadata
                .as_ref()
                .and_then(|value| value.correlation_id.as_deref()),
            i64::from(c.exists),
            c.path,
            c.object_id,
            c.kind.map(ContentKind::as_str),
            c.text_digest(),
            c.updated_at_ms,
            c.latest_moment_id,
            c.metadata.as_ref().map(|value| value.origin.as_str()),
            c.metadata
                .as_ref()
                .and_then(|value| value.summary.as_deref()),
            c.metadata
                .as_ref()
                .and_then(|value| value.correlation_id.as_deref()),
            i64::from(i.exists),
            i.path,
            i.object_id,
            i.kind.map(ContentKind::as_str),
            i.text_digest(),
            i.updated_at_ms,
            i.latest_moment_id,
            i.metadata.as_ref().map(|value| value.origin.as_str()),
            i.metadata
                .as_ref()
                .and_then(|value| value.summary.as_deref()),
            i.metadata
                .as_ref()
                .and_then(|value| value.correlation_id.as_deref()),
            b.binary_digest(),
            c.binary_digest(),
            i.binary_digest(),
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}
