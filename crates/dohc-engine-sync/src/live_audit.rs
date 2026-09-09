//! Ordinary sync carries historical native evidence, never live authority.

use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::NativeAcceptedCheckpoint;
use dohc_engine_collab::{ContentKind, DocKey};
use dohc_engine_storage::{EngineStore, FaultInjector, hex_sha256};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::apply::{MutationOutcome, apply_envelope_with_mutation_outcome};
use crate::{ApplyOutcome, ReplicationEnvelope, SyncError, journal_local_op_in_tx};

mod application_record;
mod chunks;
pub(crate) mod enrollment;
mod origin_record;
mod restore_record;
mod settlement_record;
pub use application_record::journal_live_event_in_tx;
pub use enrollment::journal_live_event_or_defer_in_tx;
pub use settlement_record::journal_live_settlement_in_tx;

pub(crate) fn apply_audit_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    match envelope.op_kind.as_str() {
        BASE_OP => apply_base_envelope(store, envelope, faults),
        application_record::EVENT_OP => {
            application_record::apply_event_envelope(store, envelope, faults)
        }
        settlement_record::SETTLEMENT_OP => {
            settlement_record::apply_settlement_envelope(store, envelope, faults)
        }
        _ => Err(SyncError::UnsupportedOperation),
    }
}

pub(crate) const BASE_OP: &str = "live.audit.base";
const SCOPE: &str = "relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BaseCoordinate {
    origin_id: String,
    origin_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BaseRecord {
    relay_database_namespace: String,
    checkpoint: NativeAcceptedCheckpoint,
    origin_stamp: String,
    origin: origin_record::OriginRecord,
    base_byte_length: usize,
    base_coordinate: BaseCoordinate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BasePayload {
    format_version: u32,
    record_digest: String,
    record: BaseRecord,
}

fn invalid(reason: &'static str) -> SyncError {
    SyncError::InvalidInput { reason }
}

fn scope<'a>(namespace: &'a str, binding: &'a LiveObjectBinding) -> [&'a str; 5] {
    [
        namespace,
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
        &binding.lineage_claim_id,
    ]
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl BaseRecord {
    fn canonical_json(&self) -> Result<String, SyncError> {
        serde_json::to_string(self).map_err(SyncError::corrupt)
    }

    fn validate(&self, workspace_id: &str) -> Result<(), SyncError> {
        let checkpoint = &self.checkpoint;
        let binding = &checkpoint.binding;
        binding.validate_canonical().map_err(invalid)?;
        if binding.workspace_id != workspace_id
            || self.relay_database_namespace.is_empty()
            || self.relay_database_namespace.len() > 1024
            || self
                .relay_database_namespace
                .bytes()
                .any(|byte| byte.is_ascii_control())
            || checkpoint.event_count != 0
            || checkpoint.terminal.is_some()
            || checkpoint.restore_operation_id.is_some()
            || checkpoint.state_digest != binding.lineage_claim_id
            || !digest(&checkpoint.state_digest)
            || !digest(&self.origin_stamp)
            || self.base_byte_length == 0
            || self.base_byte_length > dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES
            || self
                .base_coordinate
                .origin_id
                .bytes()
                .any(|byte| byte.is_ascii_control())
            || !(0..=crate::MAX_WIRE_INTEGER).contains(&self.base_coordinate.origin_seq)
        {
            return Err(invalid("invalid native event-zero audit"));
        }
        crate::model::bounded(&self.base_coordinate.origin_id, "invalid audit base origin")?;
        let initial = serde_json::to_vec(&(
            "accepted-history-v1",
            scope(&self.relay_database_namespace, binding),
        ))
        .map_err(SyncError::corrupt)?;
        if checkpoint.evidence_digest != hex_sha256(&initial) {
            return Err(invalid("native event-zero evidence differs"));
        }
        Ok(())
    }

    fn payload(&self) -> Result<serde_json::Value, SyncError> {
        serde_json::to_value(BasePayload {
            format_version: 1,
            record_digest: hex_sha256(self.canonical_json()?.as_bytes()),
            record: self.clone(),
        })
        .map_err(SyncError::corrupt)
    }
}

/// Verifies a historical coordinate without claiming that its base won arbitration.
fn require_base_coordinate(conn: &Connection, record: &BaseRecord) -> Result<(), SyncError> {
    let binding = &record.checkpoint.binding;
    let operation: Option<(String, String)> = conn.query_row(
        "SELECT op_kind,payload_json FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
        params![binding.workspace_id,record.base_coordinate.origin_id,record.base_coordinate.origin_seq],
        |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional().map_err(SyncError::corrupt)?;
    let Some((kind, json)) = operation else {
        return Err(SyncError::RetryableState {
            reason: "native audit base coordinate is unavailable",
        });
    };
    let payload: serde_json::Value = serde_json::from_str(&json).map_err(SyncError::corrupt)?;
    if kind != "ydoc.update"
        || payload.get("versionId").and_then(serde_json::Value::as_str)
            != Some(&binding.main_version_id)
        || payload.get("objectId").and_then(serde_json::Value::as_str) != Some(&binding.object_id)
        || payload
            .get("lineageClaimId")
            .and_then(serde_json::Value::as_str)
            != Some(&binding.lineage_claim_id)
        || payload
            .get("updateBlobSha256")
            .and_then(serde_json::Value::as_str)
            != Some(&record.checkpoint.state_digest)
        || payload
            .get("contentKind")
            .and_then(serde_json::Value::as_str)
            != Some("richdoc")
        || payload
            .get("isBaseState")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
    {
        return Err(invalid("native audit base coordinate differs"));
    }
    Ok(())
}

fn require_base_blob(conn: &Connection, record: &BaseRecord) -> Result<(), SyncError> {
    let lengths: Option<(i64, i64)> = conn
        .query_row(
            "SELECT byte_length,length(bytes) FROM binary_blobs WHERE sha256=?1",
            [&record.checkpoint.state_digest],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    if lengths
        != Some((
            record.base_byte_length as i64,
            record.base_byte_length as i64,
        ))
    {
        return Err(SyncError::BlobInvalid);
    }
    let mut hash = Sha256::new();
    for offset in (0..record.base_byte_length).step_by(1_048_576) {
        let length = (record.base_byte_length - offset).min(1_048_576);
        let bytes: Vec<u8> = conn
            .query_row(
                "SELECT substr(bytes,?2,?3) FROM binary_blobs WHERE sha256=?1",
                params![
                    record.checkpoint.state_digest,
                    offset as i64 + 1,
                    length as i64
                ],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if bytes.len() != length {
            return Err(SyncError::BlobInvalid);
        }
        hash.update(bytes);
    }
    if dohc_engine_storage::hex(&hash.finalize()) != record.checkpoint.state_digest {
        return Err(SyncError::BlobInvalid);
    }
    Ok(())
}

/// Called after native event zero exists, inside the same bootstrap transaction.
/// A later enrollment caller must preserve predecessor ordering before calling this.
pub fn journal_live_base_in_tx(
    tx: &Transaction<'_>,
    namespace: &str,
    binding: &LiveObjectBinding,
    now_ms: i64,
) -> Result<Option<i64>, SyncError> {
    if !crate::workspace_replicates_with_relay_in_tx(tx, &binding.workspace_id)? {
        return Ok(None);
    }
    let p = scope(namespace, binding);
    let checkpoint = tx.query_row(
        &format!("SELECT binding_json,state_sha256,evidence_digest,origin_stamp,terminal_json,journal_cursor,restore_operation_id FROM live_accepted_checkpoints WHERE {SCOPE} AND event_count=0"),
        p, |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,i64>(5)?,row.get::<_,Option<String>>(6)?)),
    ).optional().map_err(SyncError::corrupt)?.ok_or_else(|| invalid("native event zero is unavailable"))?;
    let source_binding: LiveObjectBinding =
        serde_json::from_str(&checkpoint.0).map_err(SyncError::corrupt)?;
    if scope(namespace, &source_binding) != p
        || checkpoint.4 != "null"
        || checkpoint.5 != 0
        || checkpoint.6.is_some()
    {
        return Err(invalid("native event zero differs"));
    }
    let base_byte_length: i64 = tx
        .query_row(
            "SELECT byte_length FROM binary_blobs WHERE sha256=?1",
            [&checkpoint.1],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .ok_or(SyncError::BlobInvalid)?;
    let base_byte_length = usize::try_from(base_byte_length).map_err(SyncError::corrupt)?;
    let origin = origin_record::read(tx, namespace, &source_binding)?;
    if origin.stamp(tx, &source_binding)? != checkpoint.3 {
        return Err(invalid("native origin stamp differs"));
    }
    let make_record = |base_coordinate| BaseRecord {
        relay_database_namespace: namespace.to_owned(),
        checkpoint: NativeAcceptedCheckpoint {
            restore_operation_id: None,
            event_count: 0,
            terminal: None,
            binding: source_binding.clone(),
            state_digest: checkpoint.1.clone(),
            evidence_digest: checkpoint.2.clone(),
        },
        origin_stamp: checkpoint.3.clone(),
        origin: origin.clone(),
        base_byte_length,
        base_coordinate,
    };

    let published: Option<(String,String,i64)> = tx.query_row(
        &format!("SELECT record_json,origin_id,origin_seq FROM live_audit_base_publications WHERE {SCOPE}"), p,
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).optional().map_err(SyncError::corrupt)?;
    if let Some((json, origin, sequence)) = published {
        let saved: BaseRecord = serde_json::from_str(&json).map_err(SyncError::corrupt)?;
        let record = make_record(saved.base_coordinate.clone());
        if record != saved {
            return Err(invalid("published native event zero changed"));
        }
        saved.validate(&binding.workspace_id)?;
        require_base_blob(tx, &saved)?;
        require_base_coordinate(tx, &saved)?;
        let payload: String = tx.query_row("SELECT payload_json FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 AND op_kind=?4",
            params![binding.workspace_id,origin,sequence,BASE_OP], |row| row.get(0)).map_err(SyncError::corrupt)?;
        if serde_json::from_str::<serde_json::Value>(&payload).map_err(SyncError::corrupt)?
            != saved.payload()?
        {
            return Err(invalid("published native audit coordinate changed"));
        }
        return Ok(Some(sequence));
    }

    let key = DocKey::new(
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )
    .map_err(SyncError::corrupt)?;
    let marker = dohc_engine_collab::read_marker_in(tx, &key).map_err(SyncError::corrupt)?;
    let current = marker
        .filter(|marker| marker.lineage_claim_id.as_deref() == Some(&binding.lineage_claim_id));
    let base_coordinate = if let Some(marker) = current {
        if marker.content_kind != ContentKind::Richdoc
            || marker.lineage_claim_status != dohc_engine_collab::LineageClaimStatus::Exact
            || marker.regime != dohc_engine_collab::Regime::Replicated
        {
            return Err(invalid(
                "native audit lineage differs from the ordinary base",
            ));
        }
        match (marker.base_origin_id, marker.base_origin_seq) {
            (Some(origin_id), Some(origin_seq)) => BaseCoordinate {
                origin_id,
                origin_seq,
            },
            (None, None) => {
                let existing: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM ydoc_base_relay_candidates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4)",
                params![key.workspace_id,key.version_id,key.object_id,binding.lineage_claim_id], |row| row.get(0)).map_err(SyncError::corrupt)?;
                if existing {
                    return Err(invalid(
                        "native base has an unresolved publication coordinate",
                    ));
                }
                let origin_id: String = tx
                    .query_row(
                        "SELECT origin_id FROM sync_identity WHERE workspace_id=?1",
                        [&binding.workspace_id],
                        |row| row.get(0),
                    )
                    .map_err(SyncError::corrupt)?;
                let origin_seq = journal_local_op_in_tx(
                    tx,
                    &binding.workspace_id,
                    "ydoc.update",
                    &crate::ydoc_update_payload(
                        &key,
                        &source_binding.current_path,
                        ContentKind::Richdoc,
                        &checkpoint.1,
                        &binding.lineage_claim_id,
                        None,
                        None,
                        true,
                    ),
                    now_ms,
                )?;
                dohc_engine_collab::record_base_coordinate_in_tx(
                    tx,
                    dohc_engine_collab::BaseCoordinateRecord {
                        key: &key,
                        lineage_claim_id: &binding.lineage_claim_id,
                        origin_id: &origin_id,
                        origin_seq,
                        relay_seq: None,
                        now_ms,
                    },
                )
                .map_err(SyncError::corrupt)?;
                tx.execute("INSERT INTO ydoc_base_relay_candidates(workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq) VALUES (?1,?2,?3,?4,?5,?6)",
                params![key.workspace_id,key.version_id,key.object_id,binding.lineage_claim_id,origin_id,origin_seq]).map_err(SyncError::persist)?;
                BaseCoordinate {
                    origin_id,
                    origin_seq,
                }
            }
            _ => return Err(invalid("native base coordinate is incomplete")),
        }
    } else {
        // A retained predecessor may have no active marker after replacement.
        // Its publication must not stamp or mutate the current lineage.
        let existing:Option<BaseCoordinate>=tx.query_row("SELECT origin_id,origin_seq FROM replication_log WHERE workspace_id=?1 AND op_kind='ydoc.update' AND json_extract(payload_json,'$.versionId')=?2 AND json_extract(payload_json,'$.objectId')=?3 AND json_extract(payload_json,'$.lineageClaimId')=?4 AND json_extract(payload_json,'$.updateBlobSha256')=?4 AND json_extract(payload_json,'$.contentKind')='richdoc' AND json_extract(payload_json,'$.isBaseState')=1 ORDER BY origin_id,origin_seq LIMIT 1",params![key.workspace_id,key.version_id,key.object_id,binding.lineage_claim_id],|r|Ok(BaseCoordinate{origin_id:r.get(0)?,origin_seq:r.get(1)?})).optional().map_err(SyncError::corrupt)?;
        if let Some(existing) = existing {
            existing
        } else {
            let origin_id = tx
                .query_row(
                    "SELECT origin_id FROM sync_identity WHERE workspace_id=?1",
                    [&binding.workspace_id],
                    |r| r.get(0),
                )
                .map_err(SyncError::corrupt)?;
            let origin_seq = journal_local_op_in_tx(
                tx,
                &binding.workspace_id,
                "ydoc.update",
                &crate::ydoc_update_payload(
                    &key,
                    &source_binding.current_path,
                    ContentKind::Richdoc,
                    &checkpoint.1,
                    &binding.lineage_claim_id,
                    None,
                    None,
                    true,
                ),
                now_ms,
            )?;
            BaseCoordinate {
                origin_id,
                origin_seq,
            }
        }
    };
    let record = make_record(base_coordinate);
    record.validate(&binding.workspace_id)?;
    require_base_blob(tx, &record)?;
    require_base_coordinate(tx, &record)?;
    let sequence = journal_local_op_in_tx(
        tx,
        &binding.workspace_id,
        BASE_OP,
        &record.payload()?,
        now_ms,
    )?;
    tx.execute("INSERT INTO live_audit_base_publications(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,record_json,base_blob_sha256,origin_id,origin_seq) VALUES (?1,?2,?3,?4,?5,?6,?7,(SELECT origin_id FROM sync_identity WHERE workspace_id=?2),?8)",
        params![p[0],p[1],p[2],p[3],p[4],record.canonical_json()?,record.checkpoint.state_digest,sequence]).map_err(SyncError::persist)?;
    Ok(Some(sequence))
}

pub(crate) fn apply_base_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    apply_envelope_with_mutation_outcome(store, envelope, faults, |tx, op| {
        let payload: BasePayload = serde_json::from_value(op.payload.clone())
            .map_err(|_| invalid("invalid native base audit payload"))?;
        if payload.format_version != 1 {
            return Err(invalid("unsupported native base audit format"));
        }
        if serde_json::to_value(&payload).map_err(SyncError::corrupt)? != op.payload {
            return Err(invalid("noncanonical native base audit"));
        }
        let record = payload.record;
        record.validate(&op.workspace_id)?;
        if record.origin.stamp(tx, &record.checkpoint.binding)? != record.origin_stamp {
            return Err(invalid("historical origin stamp differs"));
        }
        let json = record.canonical_json()?;
        if payload.record_digest != hex_sha256(json.as_bytes()) {
            return Err(invalid("native base audit digest differs"));
        }
        require_base_blob(tx, &record)?;
        require_base_coordinate(tx, &record)?;
        let p = scope(&record.relay_database_namespace, &record.checkpoint.binding);
        let existing: Option<(String, String)> = tx
            .query_row(
                &format!("SELECT record_digest,record_json FROM live_audit_bases WHERE {SCOPE}"),
                p,
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        if let Some((saved_digest, saved_json)) = existing {
            if saved_digest == payload.record_digest && saved_json == json {
                return Ok(MutationOutcome::Applied(()));
            }
            tx.execute("INSERT INTO live_audit_base_conflicts(workspace_id,origin_id,origin_seq,record_digest,record_json,base_blob_sha256) VALUES (?1,?2,?3,?4,?5,?6)",
                params![op.workspace_id,op.origin_id,op.origin_seq,payload.record_digest,json,record.checkpoint.state_digest]).map_err(SyncError::persist)?;
            return Ok(MutationOutcome::RefusedRetainingMutation {
                reason: "native event-zero audit identity contains different evidence".to_owned(),
            });
        }
        tx.execute("INSERT INTO live_audit_bases(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,record_digest,record_json,base_blob_sha256) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![p[0],p[1],p[2],p[3],p[4],payload.record_digest,json,record.checkpoint.state_digest]).map_err(SyncError::persist)?;
        Ok(MutationOutcome::Applied(()))
    })
}

#[cfg(test)]
mod tests;
