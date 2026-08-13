//! Lossless recovery for an independently-created Y.Doc lineage that loses
//! relay arbitration.
//!
//! Recovery is an ordinary text moment. The decision row only makes the
//! choice exactly-once across crash-redelivery; it is not a second file model.

use dohc_engine_collab::DocKey;
use dohc_engine_domain::{
    DomainError, WriteText, enqueue_write, select_snapshot_by_path_in_tx, write_text_in_tx,
};
use dohc_engine_files::{
    PathClassification, classify_engine_file_path_normalized, search_policy::SearchPolicySnapshot,
};
use dohc_engine_storage::{EngineStore, FaultInjector, Preimage, StorageError, TxnOutcome};
use rusqlite::{OptionalExtension, params};

use crate::error::local_corruption;
use crate::file_search::{search_policy_for_store, upsert_file_search_index};
use crate::{MomentMaterializationChange, ReplicationEnvelope, SyncError};

const MAX_RECOVERED_NAME_BYTES: usize = 255;
const MAX_RECOVERED_NAME_UTF16_UNITS: usize = 255;

#[derive(Debug, Clone)]
pub(crate) struct RecoveryEnvelopeBinding<'a> {
    pub content_kind: &'a str,
    pub update_blob_sha256: &'a str,
    pub lineage_claim_id: &'a str,
    pub is_base_state: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CreatedRecovery {
    pub path: String,
    pub object_id: String,
    pub moment_id: String,
    collision_ordinal: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YdocRecoveryMaterialization {
    pub path: String,
    pub materialization_job_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RecoveryDecision {
    version_id: String,
    object_id: String,
    original_path: String,
    incoming_content_kind: String,
    incoming_update_blob_sha256: String,
    incoming_lineage_claim_id: String,
    incoming_is_base_state: bool,
    recovered_path: String,
    losing_claim_id: String,
    collision_ordinal: u64,
    recovery_object_id: String,
    recovery_moment_id: String,
    recorded_at_ms: i64,
}

struct RecoveryDecisionInsert<'a> {
    workspace_id: &'a str,
    origin_id: &'a str,
    origin_seq: i64,
    decision: &'a RecoveryDecision,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RecoveryIdentity {
    object_id: String,
    moment_id: String,
    summary: String,
    correlation_id: String,
}

fn valid_claim_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read_decision(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    origin_id: &str,
    origin_seq: i64,
) -> Result<Option<RecoveryDecision>, SyncError> {
    let row = conn
        .query_row(
            "SELECT version_id,object_id,original_path,incoming_content_kind,
                    incoming_update_blob_sha256,incoming_lineage_claim_id,
                    incoming_is_base_state,recovered_path,losing_claim_id,
                    recovery_collision_ordinal,recovery_object_id,recovery_moment_id,recorded_at_ms
               FROM ydoc_recovery_decisions
              WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![workspace_id, origin_id, origin_seq],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, i64>(12)?,
                ))
            },
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some((
        version_id,
        object_id,
        original_path,
        incoming_content_kind,
        incoming_update_blob_sha256,
        incoming_lineage_claim_id,
        incoming_is_base_state,
        recovered_path,
        losing_claim_id,
        collision_ordinal,
        recovery_object_id,
        recovery_moment_id,
        recorded_at_ms,
    )) = row
    else {
        return Ok(None);
    };
    let collision_ordinal = collision_ordinal
        .parse::<u64>()
        .map_err(|_| local_corruption("recorded Y.Doc recovery ordinal is malformed"))?;
    Ok(Some(RecoveryDecision {
        version_id,
        object_id,
        original_path,
        incoming_content_kind,
        incoming_update_blob_sha256,
        incoming_lineage_claim_id,
        incoming_is_base_state: incoming_is_base_state == 1,
        recovered_path,
        losing_claim_id,
        collision_ordinal,
        recovery_object_id,
        recovery_moment_id,
        recorded_at_ms,
    }))
}

fn recovery_identity(
    key: &DocKey,
    original_path: &str,
    losing_claim_id: &str,
    collision_ordinal: u64,
) -> RecoveryIdentity {
    let mut input = format!(
        "ydoc-recovery:v1\0{}\0{}\0{}\0{}\0{}",
        key.workspace_id, key.version_id, key.object_id, original_path, losing_claim_id
    );
    if collision_ordinal > 0 {
        input.push('\0');
        input.push_str(&collision_ordinal.to_string());
    }
    let digest = dohc_engine_storage::hex_sha256(input.as_bytes());
    RecoveryIdentity {
        object_id: format!("ydoc-recovery-object-{digest}"),
        moment_id: format!("ydoc-recovery-moment-{digest}"),
        summary: recovery_summary(original_path),
        correlation_id: format!("ydoc-recovery:v1:{losing_claim_id}"),
    }
}

fn recovery_summary(original_path: &str) -> String {
    const PREFIX: &str = "Recovered from ";
    const SUFFIX: &str = " after this file was created on two machines.";
    let full = format!("{PREFIX}{original_path}{SUFFIX}");
    if full.len() <= dohc_engine_domain::MAX_METADATA_FIELD_BYTES {
        return full;
    }
    let digest = dohc_engine_storage::hex_sha256(original_path.as_bytes());
    let marker = format!("… [path sha256 {digest}]");
    let budget = dohc_engine_domain::MAX_METADATA_FIELD_BYTES
        .saturating_sub(PREFIX.len() + marker.len() + SUFFIX.len());
    let visible = truncate_stem(original_path, budget, usize::MAX);
    format!("{PREFIX}{visible}{marker}{SUFFIX}")
}

fn truncate_stem(stem: &str, max_bytes: usize, max_units: usize) -> String {
    let mut result = String::new();
    let mut bytes = 0;
    let mut units = 0;
    for character in stem.chars() {
        let next_bytes = character.len_utf8();
        let next_units = character.len_utf16();
        if bytes + next_bytes > max_bytes || units + next_units > max_units {
            break;
        }
        result.push(character);
        bytes += next_bytes;
        units += next_units;
    }
    result
}

fn file_parts(file_name: &str) -> (&str, &str) {
    let extension_start = file_name
        .rfind('.')
        .filter(|index| *index > 0)
        .filter(|_| !file_name.starts_with('.') || file_name[1..].contains('.'));
    extension_start.map_or((file_name, ""), |index| {
        (&file_name[..index], &file_name[index..])
    })
}

fn recovered_path_candidate(
    original_path: &str,
    losing_claim_id: &str,
    ordinal: u64,
) -> Result<String, SyncError> {
    if !valid_claim_id(losing_claim_id) || ordinal == 0 {
        return Err(local_corruption("Y.Doc recovery identity is malformed"));
    }
    let (parent, file_name) = original_path
        .rsplit_once('/')
        .map_or(("", original_path), |(parent, file_name)| {
            (parent, file_name)
        });
    let (stem, extension) = file_parts(file_name);
    let suffix = if ordinal == 1 {
        format!(" (recovered {})", &losing_claim_id[..8])
    } else {
        format!(" (recovered {} {ordinal})", &losing_claim_id[..8])
    };
    let extension_fits = suffix.len() + extension.len() <= MAX_RECOVERED_NAME_BYTES
        && suffix.encode_utf16().count() + extension.encode_utf16().count()
            <= MAX_RECOVERED_NAME_UTF16_UNITS;
    let extension = if extension_fits { extension } else { "" };
    let fixed_bytes = suffix.len() + extension.len();
    let fixed_units = suffix.encode_utf16().count() + extension.encode_utf16().count();
    let stem = truncate_stem(
        stem,
        MAX_RECOVERED_NAME_BYTES - fixed_bytes,
        MAX_RECOVERED_NAME_UTF16_UNITS - fixed_units,
    );
    let name = format!("{stem}{suffix}{extension}");
    let candidate = if parent.is_empty() {
        name
    } else {
        format!("{parent}/{name}")
    };
    let (classification, normalized) = classify_engine_file_path_normalized(&candidate);
    if classification != PathClassification::Tracked
        || normalized.as_deref() != Some(candidate.as_str())
    {
        return Err(local_corruption("generated Y.Doc recovery path is invalid"));
    }
    Ok(candidate)
}

fn is_recovered_path_candidate(
    original_path: &str,
    losing_claim_id: &str,
    recovered_path: &str,
) -> Result<bool, SyncError> {
    if recovered_path_candidate(original_path, losing_claim_id, 1)? == recovered_path {
        return Ok(true);
    }
    let recovered_name = recovered_path.rsplit('/').next().unwrap_or(recovered_path);
    let marker = format!(" (recovered {} ", &losing_claim_id[..8]);
    let Some(marker_start) = recovered_name.rfind(&marker) else {
        return Ok(false);
    };
    let ordinal_start = marker_start + marker.len();
    let Some(ordinal_end) = recovered_name[ordinal_start..].find(')') else {
        return Ok(false);
    };
    let Some(ordinal) = recovered_name[ordinal_start..ordinal_start + ordinal_end]
        .parse::<u64>()
        .ok()
        .filter(|ordinal| *ordinal >= 2)
    else {
        return Ok(false);
    };
    Ok(recovered_path_candidate(original_path, losing_claim_id, ordinal)? == recovered_path)
}

fn identity_available(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    identity: &RecoveryIdentity,
) -> Result<bool, SyncError> {
    tx.query_row(
        "SELECT
             NOT EXISTS(SELECT 1 FROM file_objects WHERE workspace_id=?1 AND object_id=?2)
         AND NOT EXISTS(SELECT 1 FROM moments WHERE workspace_id=?1 AND moment_id=?3)
         AND NOT EXISTS(
             SELECT 1 FROM ydoc_recovery_decisions
              WHERE workspace_id=?1
                AND (recovery_object_id=?2 OR recovery_moment_id=?3)
         )",
        params![workspace_id, identity.object_id, identity.moment_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

fn verify_recovery(
    conn: &rusqlite::Connection,
    key: &DocKey,
    decision: &RecoveryDecision,
    markdown: &str,
) -> Result<(), SyncError> {
    if !valid_claim_id(&decision.losing_claim_id)
        || !is_recovered_path_candidate(
            &decision.original_path,
            &decision.losing_claim_id,
            &decision.recovered_path,
        )?
    {
        return Err(SyncError::CoordinateDiverged);
    }
    let identity = recovery_identity(
        key,
        &decision.original_path,
        &decision.losing_claim_id,
        decision.collision_ordinal,
    );
    if identity.object_id != decision.recovery_object_id
        || identity.moment_id != decision.recovery_moment_id
    {
        return Err(SyncError::CoordinateDiverged);
    }
    let markdown_sha = dohc_engine_storage::hex_sha256(markdown.as_bytes());
    let exact: bool = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM moments AS moment
                 JOIN blobs AS blob ON blob.sha256=moment.after_blob_sha256
                 WHERE moment.workspace_id=?1 AND moment.moment_id=?2
                   AND moment.version_id=?3 AND moment.object_id=?4
                   AND moment.path=?5 AND moment.recorded_at_ms=?6
                   AND moment.operation='write' AND moment.after_content_kind='text'
                   AND moment.after_blob_sha256=?7 AND moment.after_binary_sha256 IS NULL
                   AND moment.metadata_origin='sync' AND moment.metadata_summary=?8
                   AND moment.metadata_correlation_id=?9
                   AND moment.author_json IS NULL AND moment.sync_record_only IS NULL
                   AND blob.byte_length=?10 AND blob.text=?11
             )",
            params![
                key.workspace_id,
                decision.recovery_moment_id,
                key.version_id,
                decision.recovery_object_id,
                decision.recovered_path,
                decision.recorded_at_ms,
                markdown_sha,
                identity.summary,
                identity.correlation_id,
                markdown.len() as i64,
                markdown,
            ],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !exact {
        return Err(SyncError::CoordinateDiverged);
    }
    Ok(())
}

fn validate_decision_binding(
    decision: &RecoveryDecision,
    key: &DocKey,
    original_path: &str,
    incoming: &RecoveryEnvelopeBinding<'_>,
    recorded_at_ms: i64,
) -> Result<(), SyncError> {
    if decision.version_id != key.version_id
        || decision.object_id != key.object_id
        || decision.original_path != original_path
        || decision.incoming_content_kind != incoming.content_kind
        || decision.incoming_update_blob_sha256 != incoming.update_blob_sha256
        || decision.incoming_lineage_claim_id != incoming.lineage_claim_id
        || decision.incoming_is_base_state != incoming.is_base_state
        || decision.recorded_at_ms != recorded_at_ms
        || !decision.incoming_is_base_state
    {
        return Err(SyncError::CoordinateDiverged);
    }
    Ok(())
}

pub(crate) fn recorded_recovery_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    original_path: &str,
    incoming: &RecoveryEnvelopeBinding<'_>,
    origin_id: &str,
    origin_seq: i64,
    recorded_at_ms: i64,
) -> Result<Option<CreatedRecovery>, SyncError> {
    let Some(decision) = read_decision(tx, &key.workspace_id, origin_id, origin_seq)? else {
        return Ok(None);
    };
    validate_decision_binding(&decision, key, original_path, incoming, recorded_at_ms)?;
    let current: Option<String> = tx
        .query_row(
            "SELECT blob.text FROM snapshots AS snapshot
             JOIN path_aliases AS alias
               ON alias.workspace_id=snapshot.workspace_id
              AND alias.version_id=snapshot.version_id
              AND alias.path=snapshot.path
              AND alias.object_id=snapshot.object_id
             JOIN blobs AS blob ON blob.sha256=snapshot.blob_sha256
             WHERE snapshot.workspace_id=?1 AND snapshot.version_id=?2
               AND snapshot.object_id=?3 AND snapshot.path=?4
               AND snapshot.latest_moment_id=?5",
            params![
                key.workspace_id,
                key.version_id,
                decision.recovery_object_id,
                decision.recovered_path,
                decision.recovery_moment_id,
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some(current) = current else {
        // The decision remains authoritative after a later rename, edit,
        // delete, or rollback, but that stale path must not be announced.
        return Ok(None);
    };
    verify_recovery(tx, key, &decision, &current)?;
    Ok(Some(CreatedRecovery {
        path: decision.recovered_path,
        object_id: decision.recovery_object_id,
        moment_id: decision.recovery_moment_id,
        collision_ordinal: decision.collision_ordinal,
    }))
}

fn record_decision(
    tx: &rusqlite::Transaction<'_>,
    insert: &RecoveryDecisionInsert<'_>,
) -> Result<(), SyncError> {
    let decision = insert.decision;
    tx.execute(
        "INSERT OR IGNORE INTO ydoc_recovery_decisions (
             workspace_id,origin_id,origin_seq,version_id,object_id,original_path,
             incoming_content_kind,incoming_update_blob_sha256,
             incoming_lineage_claim_id,incoming_is_base_state,
             losing_claim_id,recovered_path,recovery_collision_ordinal,
             recovery_object_id,recovery_moment_id,recorded_at_ms
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        params![
            insert.workspace_id,
            insert.origin_id,
            insert.origin_seq,
            decision.version_id,
            decision.object_id,
            decision.original_path,
            decision.incoming_content_kind,
            decision.incoming_update_blob_sha256,
            decision.incoming_lineage_claim_id,
            if decision.incoming_is_base_state {
                1_i64
            } else {
                0_i64
            },
            decision.losing_claim_id,
            decision.recovered_path,
            decision.collision_ordinal.to_string(),
            decision.recovery_object_id,
            decision.recovery_moment_id,
            decision.recorded_at_ms,
        ],
    )
    .map_err(SyncError::persist)?;
    let stored = read_decision(tx, insert.workspace_id, insert.origin_id, insert.origin_seq)?
        .ok_or(SyncError::CoordinateDiverged)?;
    if stored != *decision {
        return Err(SyncError::CoordinateDiverged);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn recover_lineage_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    original_path: &str,
    incoming: RecoveryEnvelopeBinding<'_>,
    losing_claim_id: &str,
    markdown: &str,
    origin_id: &str,
    origin_seq: i64,
    recorded_at_ms: i64,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<CreatedRecovery, SyncError> {
    if let Some(decision) = read_decision(tx, &key.workspace_id, origin_id, origin_seq)? {
        validate_decision_binding(&decision, key, original_path, &incoming, recorded_at_ms)?;
        if decision.losing_claim_id != losing_claim_id {
            return Err(SyncError::CoordinateDiverged);
        }
        // A decision is authoritative even if a later user action has renamed
        // or deleted the sibling. Never recreate it on redelivery.
        let current: Option<String> = tx
            .query_row(
                "SELECT blob.text FROM snapshots AS snapshot
                 JOIN blobs AS blob ON blob.sha256=snapshot.blob_sha256
                 WHERE snapshot.workspace_id=?1 AND snapshot.version_id=?2
                   AND snapshot.object_id=?3 AND snapshot.path=?4
                   AND snapshot.latest_moment_id=?5",
                params![
                    key.workspace_id,
                    key.version_id,
                    decision.recovery_object_id,
                    decision.recovered_path,
                    decision.recovery_moment_id,
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        if let Some(current) = current {
            verify_recovery(tx, key, &decision, &current)?;
        }
        return Ok(CreatedRecovery {
            path: decision.recovered_path,
            object_id: decision.recovery_object_id,
            moment_id: decision.recovery_moment_id,
            collision_ordinal: decision.collision_ordinal,
        });
    }

    let created = create_recovery_in_tx(
        tx,
        key,
        original_path,
        losing_claim_id,
        markdown,
        0,
        recorded_at_ms,
        search_policy,
    )?;
    let decision = RecoveryDecision {
        version_id: key.version_id.clone(),
        object_id: key.object_id.clone(),
        original_path: original_path.to_owned(),
        incoming_content_kind: incoming.content_kind.to_owned(),
        incoming_update_blob_sha256: incoming.update_blob_sha256.to_owned(),
        incoming_lineage_claim_id: incoming.lineage_claim_id.to_owned(),
        incoming_is_base_state: incoming.is_base_state,
        recovered_path: created.path.clone(),
        losing_claim_id: losing_claim_id.to_owned(),
        collision_ordinal: created.collision_ordinal,
        recovery_object_id: created.object_id.clone(),
        recovery_moment_id: created.moment_id.clone(),
        recorded_at_ms,
    };
    verify_recovery(tx, key, &decision, markdown)?;
    record_decision(
        tx,
        &RecoveryDecisionInsert {
            workspace_id: &key.workspace_id,
            origin_id,
            origin_seq,
            decision: &decision,
        },
    )?;
    Ok(created)
}

#[allow(clippy::too_many_arguments)]
fn create_recovery_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    original_path: &str,
    losing_claim_id: &str,
    markdown: &str,
    first_collision_ordinal: u64,
    recorded_at_ms: i64,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<CreatedRecovery, SyncError> {
    let mut collision_ordinal = first_collision_ordinal;
    let identity = loop {
        let candidate = recovery_identity(key, original_path, losing_claim_id, collision_ordinal);
        if identity_available(tx, &key.workspace_id, &candidate)? {
            break candidate;
        }
        collision_ordinal = collision_ordinal
            .checked_add(1)
            .ok_or_else(|| local_corruption("Y.Doc recovery identity sequence overflowed"))?;
    };
    let mut path_ordinal = 1_u64;
    let recovered_path = loop {
        let candidate = recovered_path_candidate(original_path, losing_claim_id, path_ordinal)?;
        let alias_occupied: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM path_aliases
                  WHERE workspace_id=?1 AND version_id=?2 AND path=?3)",
                params![key.workspace_id, key.version_id, candidate.as_str()],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        let current =
            select_snapshot_by_path_in_tx(tx, &key.workspace_id, &key.version_id, &candidate)
                .map_err(map_domain_hard_error)?;
        if !alias_occupied && current.snapshot.is_none() && current.binary_sha256.is_none() {
            break candidate;
        }
        path_ordinal = path_ordinal
            .checked_add(1)
            .ok_or_else(|| local_corruption("Y.Doc recovery path sequence overflowed"))?;
    };
    let result = write_text_in_tx(
        tx,
        &WriteText {
            workspace_id: key.workspace_id.clone(),
            version_id: key.version_id.clone(),
            object_id: identity.object_id.clone(),
            path: recovered_path.clone(),
            text: markdown.to_owned(),
            moment_id: identity.moment_id.clone(),
            metadata_origin: "sync".to_owned(),
            metadata_summary: Some(identity.summary.clone()),
            metadata_correlation_id: Some(identity.correlation_id.clone()),
            author_json: None,
            now_ms: recorded_at_ms,
            request_id: None,
        },
    )
    .map_err(|error| map_domain_payload_error(error, "Y.Doc recovery write failed"))?;
    if !result.deduped {
        upsert_file_search_index(
            tx,
            &key.workspace_id,
            &key.version_id,
            &result.snapshot.object_id,
            &result.snapshot.path,
            Some(&result.snapshot.text),
            search_policy,
        )?;
        enqueue_write(tx, &result, Preimage::Absent, "sync").map_err(map_domain_hard_error)?;
        if crate::journal::workspace_replicates_with_relay_in_tx(tx, &key.workspace_id)? {
            crate::outbound::journal_moment_append_in_tx(
                tx,
                &key.workspace_id,
                &result.moment.moment_id,
            )?;
        }
    }
    Ok(CreatedRecovery {
        path: recovered_path,
        object_id: identity.object_id,
        moment_id: identity.moment_id,
        collision_ordinal,
    })
}

/// Select the recovery jobs that must reach disk before their paths are
/// announced. A pending job is returned unchanged, including after a committed
/// repair lost its response. A conflicted absent-preimage write moves only
/// after capture makes the disk occupant authoritative in the database. A
/// later user rename or delete returns nothing and never rebuilds the sibling.
pub fn repair_conflicted_ydoc_recoveries(
    store: &mut EngineStore,
    workspace_id: &str,
    faults: &dyn FaultInjector,
) -> Result<Vec<YdocRecoveryMaterialization>, SyncError> {
    let coordinates: Vec<(String, i64, String)> = store.read_with(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT decision.origin_id,decision.origin_seq,job.status
                   FROM ydoc_recovery_decisions AS decision
                   JOIN materialization_jobs AS job
                     ON job.job_id='sync-mat_' || decision.recovery_moment_id
                  WHERE decision.workspace_id=?1
                    AND job.status IN ('conflict','pending')
                  ORDER BY decision.origin_id,decision.origin_seq",
            )
            .map_err(SyncError::corrupt)?;
        let rows = statement
            .query_map([workspace_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(SyncError::corrupt)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)
    })?;
    let search_policy = search_policy_for_store(store);
    let mut repaired = Vec::new();
    for (origin_id, origin_seq, job_status) in coordinates {
        let outcome = store.write_with(faults, |tx| {
            relocate_conflicted_recovery_in_tx(
                tx,
                workspace_id,
                &origin_id,
                origin_seq,
                &job_status,
                search_policy.as_ref(),
            )
        })?;
        match outcome {
            TxnOutcome::Committed(Some(materialization)) => repaired.push(materialization),
            TxnOutcome::Committed(None) => {}
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
        }
    }
    Ok(repaired)
}

fn relocate_conflicted_recovery_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    origin_id: &str,
    origin_seq: i64,
    job_status: &str,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<Option<YdocRecoveryMaterialization>, SyncError> {
    let Some(decision) = read_decision(tx, workspace_id, origin_id, origin_seq)? else {
        return Ok(None);
    };
    let key = DocKey::new(
        workspace_id.to_owned(),
        decision.version_id.clone(),
        decision.object_id.clone(),
    )
    .map_err(map_collab_hard_error)?;
    if !valid_claim_id(&decision.losing_claim_id)
        || !is_recovered_path_candidate(
            &decision.original_path,
            &decision.losing_claim_id,
            &decision.recovered_path,
        )?
    {
        return Err(SyncError::CoordinateDiverged);
    }
    let expected_identity = recovery_identity(
        &key,
        &decision.original_path,
        &decision.losing_claim_id,
        decision.collision_ordinal,
    );
    if expected_identity.object_id != decision.recovery_object_id
        || expected_identity.moment_id != decision.recovery_moment_id
    {
        return Err(SyncError::CoordinateDiverged);
    }
    let current: Option<(String, String)> = tx
        .query_row(
            "SELECT object_id,latest_moment_id FROM snapshots
              WHERE workspace_id=?1 AND version_id=?2 AND path=?3",
            params![workspace_id, key.version_id, decision.recovered_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    match current {
        Some((object_id, moment_id))
            if object_id == decision.recovery_object_id
                && moment_id == decision.recovery_moment_id =>
        {
            if job_status == "pending" {
                let markdown: String = tx
                    .query_row(
                        "SELECT blob.text FROM snapshots AS snapshot
                         JOIN blobs AS blob ON blob.sha256=snapshot.blob_sha256
                         WHERE snapshot.workspace_id=?1 AND snapshot.version_id=?2
                           AND snapshot.object_id=?3 AND snapshot.path=?4
                           AND snapshot.latest_moment_id=?5",
                        params![
                            workspace_id,
                            key.version_id,
                            decision.recovery_object_id,
                            decision.recovered_path,
                            decision.recovery_moment_id,
                        ],
                        |row| row.get(0),
                    )
                    .map_err(SyncError::corrupt)?;
                verify_recovery(tx, &key, &decision, &markdown)?;
                return Ok(Some(YdocRecoveryMaterialization {
                    path: decision.recovered_path,
                    materialization_job_id: format!("sync-mat_{}", decision.recovery_moment_id),
                }));
            }
            if job_status != "conflict" {
                return Err(local_corruption(
                    "Y.Doc recovery materialization status is invalid",
                ));
            }
            return Err(SyncError::RetryableState {
                reason: "recovery disk occupant has not been captured",
            });
        }
        None => return Ok(None),
        Some(_) if job_status == "pending" => return Ok(None),
        Some(_) if job_status == "conflict" => {}
        Some(_) => {
            return Err(local_corruption(
                "Y.Doc recovery materialization status is invalid",
            ));
        }
    }
    let markdown: Option<String> = tx
        .query_row(
            "SELECT blob.text FROM moments AS moment
             JOIN blobs AS blob ON blob.sha256=moment.after_blob_sha256
             WHERE moment.workspace_id=?1 AND moment.moment_id=?2",
            params![workspace_id, decision.recovery_moment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some(markdown) = markdown else {
        return Ok(None);
    };
    verify_recovery(tx, &key, &decision, &markdown)?;
    let first_collision_ordinal = decision
        .collision_ordinal
        .checked_add(1)
        .ok_or_else(|| local_corruption("Y.Doc recovery identity sequence overflowed"))?;
    let created = create_recovery_in_tx(
        tx,
        &key,
        &decision.original_path,
        &decision.losing_claim_id,
        &markdown,
        first_collision_ordinal,
        decision.recorded_at_ms,
        search_policy,
    )?;
    let changed = tx
        .execute(
            "UPDATE ydoc_recovery_decisions
                SET recovered_path=?4,recovery_collision_ordinal=?5,
                    recovery_object_id=?6,recovery_moment_id=?7
              WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3
                AND recovered_path=?8 AND recovery_object_id=?9
                AND recovery_moment_id=?10",
            params![
                workspace_id,
                origin_id,
                origin_seq,
                created.path,
                created.collision_ordinal.to_string(),
                created.object_id,
                created.moment_id,
                decision.recovered_path,
                decision.recovery_object_id,
                decision.recovery_moment_id,
            ],
        )
        .map_err(SyncError::persist)?;
    if changed != 1 {
        return Err(SyncError::CoordinateDiverged);
    }
    Ok(Some(YdocRecoveryMaterialization {
        path: created.path,
        materialization_job_id: format!("sync-mat_{}", created.moment_id),
    }))
}

pub(crate) fn redelivered_change(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<Option<MomentMaterializationChange>, SyncError> {
    let decision = store.read_with(|conn| {
        read_decision(
            conn,
            &envelope.workspace_id,
            &envelope.origin_id,
            envelope.origin_seq,
        )
    })?;
    let Some(decision) = decision else {
        return Ok(None);
    };
    let still_exact: bool = store.read_with(|conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM snapshots
              WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND path=?4
                AND latest_moment_id=?5)",
            params![
                envelope.workspace_id,
                decision.version_id,
                decision.recovery_object_id,
                decision.recovered_path,
                decision.recovery_moment_id,
            ],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)
    })?;
    Ok(still_exact.then_some(MomentMaterializationChange {
        path: decision.recovered_path,
        operation: "write",
        content_kind: "text",
    }))
}

fn map_domain_payload_error(error: DomainError, reason: &'static str) -> SyncError {
    match error {
        DomainError::InvalidText { .. }
        | DomainError::InvalidPath { .. }
        | DomainError::PayloadTooLarge { .. }
        | DomainError::InvalidInput { .. } => SyncError::InvalidInput { reason },
        hard => map_domain_hard_error(hard),
    }
}

fn map_collab_hard_error(error: dohc_engine_collab::CollabError) -> SyncError {
    match error {
        dohc_engine_collab::CollabError::Storage(storage) => SyncError::Storage(storage),
        hard => SyncError::Storage(StorageError::corrupt_public(hard)),
    }
}

fn map_domain_hard_error(error: DomainError) -> SyncError {
    match error {
        DomainError::Storage(storage) => SyncError::Storage(storage),
        hard => SyncError::Storage(StorageError::corrupt_public(hard)),
    }
}

#[cfg(test)]
mod tests {
    use super::recovered_path_candidate;

    #[test]
    fn recovered_path_is_deterministic_and_keeps_the_extension() {
        let claim = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        assert_eq!(
            recovered_path_candidate("notes/draft.md", claim, 1).unwrap(),
            "notes/draft (recovered 12345678).md"
        );
        assert_eq!(
            recovered_path_candidate("notes/draft.md", claim, 2).unwrap(),
            "notes/draft (recovered 12345678 2).md"
        );
    }
}
