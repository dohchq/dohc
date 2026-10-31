//! Lossless recovery for an independently-created Y.Doc lineage that loses
//! relay arbitration.
//!
//! Recovery is an ordinary text moment. The decision row only makes the
//! choice exactly-once across crash-redelivery; it is not a second file model.

use dohc_engine_collab::DocKey;
use dohc_engine_domain::{
    DomainError, WriteText, enqueue_write, select_snapshot_by_path_in_tx, store::CAPTURE_ORIGIN,
    write_text_in_tx,
};
use dohc_engine_files::{
    MAX_CANONICAL_WORKSPACE_PATH_BYTES, PathClassification, classify_engine_file_path_normalized,
    search_policy::SearchPolicySnapshot,
};
use dohc_engine_storage::text;
use dohc_engine_storage::{EngineStore, FaultInjector, Preimage, StorageError, TxnOutcome};
use rusqlite::{OptionalExtension, params};

use crate::error::local_corruption;
use crate::file_search::{
    search_policy_for_connection, search_policy_for_store, upsert_file_search_index,
};
use crate::{MomentMaterializationChange, ReplicationEnvelope, SyncError};

mod released;

pub use released::{
    CopyPublication, CopyPublicationState, CopyResolutionOutcome, KeepRetainedVersion,
    KeptRetainedVersion, RELEASED_COPY_MOMENT_PREFIX, RedundantRecovery, keep_retained_version,
};
pub(crate) use released::{
    ReceivedCreation, equivalent_released_copy_in_tx, record_redundant_publication,
    record_released_copy_acceptance_in_tx, record_released_copy_echo_in_tx,
    validate_redundant_recoveries,
};

const MAX_RECOVERED_NAME_BYTES: usize = 255;
const MAX_RECOVERED_NAME_UTF16_UNITS: usize = 255;
const LOCAL_RECOVERY_CORRELATION_PREFIX: &str = "ydoc-local-recovery:v1:";

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
    recovery_author_json: Option<String>,
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

/// Why a lineage's projection becomes a recovered sibling file. The cause
/// decides the moment's origin and its History summary.
#[derive(Clone, Copy)]
enum RecoveryCause {
    /// An independently created lineage lost relay arbitration.
    RelayArbitration,
    /// A local write replaced text a closed lineage held but never settled.
    LocalUnsettled,
    /// The owner kept what a hosted replica holds for a released chain
    /// before a later change could remove it.
    ReleasedRetained,
}

impl RecoveryCause {
    fn origin(self) -> &'static str {
        match self {
            RecoveryCause::RelayArbitration | RecoveryCause::ReleasedRetained => "sync",
            RecoveryCause::LocalUnsettled => "ydoc",
        }
    }

    fn summary_parts(self) -> (&'static str, &'static str) {
        match self {
            RecoveryCause::RelayArbitration => (
                "Recovered from ",
                " after this file was created on two machines.",
            ),
            RecoveryCause::LocalUnsettled => (
                "Recovered unsaved edits from ",
                " after a later write changed the file.",
            ),
            RecoveryCause::ReleasedRetained => (
                "Kept unsaved edits from ",
                " before a later change could remove them.",
            ),
        }
    }
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
                    recovery_collision_ordinal,recovery_object_id,recovery_moment_id,recorded_at_ms,recovery_author_json
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
                    row.get::<_, Option<String>>(13)?,
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
        recovery_author_json,
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
        recovery_author_json,
    }))
}

fn recovery_identity(
    key: &DocKey,
    original_path: &str,
    losing_claim_id: &str,
    markdown: &str,
    collision_ordinal: u64,
    cause: RecoveryCause,
) -> RecoveryIdentity {
    let projection_sha256 = dohc_engine_storage::hex_sha256(markdown.as_bytes());
    let mut input = format!(
        "ydoc-recovery:v2\0{}\0{}\0{}\0{}\0{}\0{}",
        key.workspace_id,
        key.version_id,
        key.object_id,
        original_path,
        losing_claim_id,
        projection_sha256
    );
    if collision_ordinal > 0 {
        input.push('\0');
        input.push_str(&collision_ordinal.to_string());
    }
    let digest = dohc_engine_storage::hex_sha256(input.as_bytes());
    RecoveryIdentity {
        object_id: format!("ydoc-recovery-object-{digest}"),
        moment_id: format!("ydoc-recovery-moment-{digest}"),
        summary: recovery_summary(cause, original_path),
        correlation_id: format!("ydoc-recovery:v1:{losing_claim_id}"),
    }
}

fn recovery_summary(cause: RecoveryCause, original_path: &str) -> String {
    let (prefix, suffix) = cause.summary_parts();
    let full = format!("{prefix}{original_path}{suffix}");
    if full.len() <= dohc_engine_domain::MAX_METADATA_FIELD_BYTES {
        return full;
    }
    let digest = dohc_engine_storage::hex_sha256(original_path.as_bytes());
    let marker = format!("… [path sha256 {digest}]");
    let budget = dohc_engine_domain::MAX_METADATA_FIELD_BYTES
        .saturating_sub(prefix.len() + marker.len() + suffix.len());
    let visible = truncate_stem(original_path, budget, usize::MAX);
    format!("{prefix}{visible}{marker}{suffix}")
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

/// The pieces of a recovered name. The original file's pieces place its copy;
/// a collided copy's own pieces place the copy that replaces it.
#[derive(Clone, Copy)]
struct RecoveredNameParts<'a> {
    parent: &'a str,
    stem: &'a str,
    extension: &'a str,
}

impl<'a> RecoveredNameParts<'a> {
    fn of_original(original_path: &'a str) -> Self {
        let (parent, file_name) = original_path
            .rsplit_once('/')
            .map_or(("", original_path), |(parent, file_name)| {
                (parent, file_name)
            });
        let (stem, extension) = file_parts(file_name);
        Self {
            parent,
            stem,
            extension,
        }
    }

    /// Read a recovered path back into its pieces and ordinal. `None` when
    /// the name does not carry this claim's and projection's marker.
    fn of_recovered(
        recovered_path: &'a str,
        losing_claim_id: &str,
        projection_sha256: &str,
    ) -> Option<(Self, u64)> {
        let (parent, name) = recovered_path
            .rsplit_once('/')
            .map_or(("", recovered_path), |(parent, name)| (parent, name));
        let marker = format!(" (recovered {} {projection_sha256}", &losing_claim_id[..8]);
        let marker_start = name.rfind(&marker)?;
        let rest = &name[marker_start + marker.len()..];
        let close = rest.find(')')?;
        let ordinal = if close == 0 {
            1
        } else {
            rest[..close]
                .strip_prefix(' ')?
                .parse::<u64>()
                .ok()
                .filter(|ordinal| *ordinal >= 2)?
        };
        Some((
            Self {
                parent,
                stem: &name[..marker_start],
                extension: &rest[close + 1..],
            },
            ordinal,
        ))
    }
}

fn recovered_path_candidate(
    original_path: &str,
    losing_claim_id: &str,
    projection_sha256: &str,
    ordinal: u64,
) -> Result<String, SyncError> {
    recovered_path_from_parts(
        RecoveredNameParts::of_original(original_path),
        losing_claim_id,
        projection_sha256,
        ordinal,
    )
}

fn recovered_path_from_parts(
    parts: RecoveredNameParts<'_>,
    losing_claim_id: &str,
    projection_sha256: &str,
    ordinal: u64,
) -> Result<String, SyncError> {
    if !valid_claim_id(losing_claim_id) || !valid_claim_id(projection_sha256) || ordinal == 0 {
        return Err(local_corruption("Y.Doc recovery identity is malformed"));
    }
    let RecoveredNameParts {
        parent,
        stem,
        extension,
    } = parts;
    let suffix = if ordinal == 1 {
        format!(" (recovered {} {projection_sha256})", &losing_claim_id[..8])
    } else {
        format!(
            " (recovered {} {projection_sha256} {ordinal})",
            &losing_claim_id[..8]
        )
    };
    let same_parent_bytes = if parent.is_empty() {
        0
    } else {
        parent.len() + 1
    };
    let same_parent_name_bytes = MAX_CANONICAL_WORKSPACE_PATH_BYTES
        .checked_sub(same_parent_bytes)
        .ok_or_else(|| local_corruption("Y.Doc recovery parent path is invalid"))?;
    // A valid original can leave less room than the recovery marker in its
    // directory. Keep the sibling beside it whenever possible; otherwise the
    // workspace root is the only canonical location that can preserve it.
    let parent = if suffix.len() <= same_parent_name_bytes {
        parent
    } else {
        ""
    };
    let parent_bytes = if parent.is_empty() {
        0
    } else {
        parent.len() + 1
    };
    let max_name_bytes = MAX_RECOVERED_NAME_BYTES.min(
        MAX_CANONICAL_WORKSPACE_PATH_BYTES
            .checked_sub(parent_bytes)
            .ok_or_else(|| local_corruption("Y.Doc recovery parent path is invalid"))?,
    );
    let extension_fits = suffix.len() + extension.len() <= max_name_bytes
        && suffix.encode_utf16().count() + extension.encode_utf16().count()
            <= MAX_RECOVERED_NAME_UTF16_UNITS;
    let extension = if extension_fits { extension } else { "" };
    let fixed_bytes = suffix.len() + extension.len();
    let fixed_units = suffix.encode_utf16().count() + extension.encode_utf16().count();
    if fixed_bytes > max_name_bytes {
        return Err(local_corruption(
            "Y.Doc recovery parent path has no room for a recovery name",
        ));
    }
    let stem = truncate_stem(
        stem,
        max_name_bytes - fixed_bytes,
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
    projection_sha256: &str,
    recovered_path: &str,
) -> Result<bool, SyncError> {
    if recovered_path_candidate(original_path, losing_claim_id, projection_sha256, 1)?
        == recovered_path
    {
        return Ok(true);
    }
    let recovered_name = recovered_path.rsplit('/').next().unwrap_or(recovered_path);
    let marker = format!(" (recovered {} {projection_sha256} ", &losing_claim_id[..8]);
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
    Ok(
        recovered_path_candidate(original_path, losing_claim_id, projection_sha256, ordinal)?
            == recovered_path,
    )
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
    let projection_sha256 = dohc_engine_storage::hex_sha256(markdown.as_bytes());
    if !valid_claim_id(&decision.losing_claim_id)
        || !is_recovered_path_candidate(
            &decision.original_path,
            &decision.losing_claim_id,
            &projection_sha256,
            &decision.recovered_path,
        )?
    {
        return Err(SyncError::CoordinateDiverged);
    }
    let identity = recovery_identity(
        key,
        &decision.original_path,
        &decision.losing_claim_id,
        markdown,
        decision.collision_ordinal,
        RecoveryCause::RelayArbitration,
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
                   AND moment.author_json IS ?11 AND moment.sync_record_only IS NULL
                   AND blob.byte_length=?10
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
                decision.recovery_author_json,
            ],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !exact || !text::equals(conn, &markdown_sha, markdown).map_err(SyncError::corrupt)? {
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
            "SELECT blob.sha256 FROM snapshots AS snapshot
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
            |row| text::from_row(tx, row, 0),
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
             recovery_object_id,recovery_moment_id,recorded_at_ms,recovery_author_json
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
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
            decision.recovery_author_json,
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
    author_json: Option<&str>,
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
                "SELECT blob.sha256 FROM snapshots AS snapshot
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
                |row| text::from_row(tx, row, 0),
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

    let created = create_recovery_with_correlation_in_tx(
        tx,
        key,
        original_path,
        losing_claim_id,
        markdown,
        0,
        recorded_at_ms,
        search_policy,
        None,
        author_json,
        RecoveryCause::RelayArbitration,
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
        recovery_author_json: author_json.map(str::to_owned),
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
pub(crate) fn create_recovery_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    original_path: &str,
    losing_claim_id: &str,
    markdown: &str,
    first_collision_ordinal: u64,
    recorded_at_ms: i64,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<CreatedRecovery, SyncError> {
    create_recovery_with_correlation_in_tx(
        tx,
        key,
        original_path,
        losing_claim_id,
        markdown,
        first_collision_ordinal,
        recorded_at_ms,
        search_policy,
        None,
        None,
        RecoveryCause::RelayArbitration,
    )
}

/// Keep text a closed lineage holds but never settled as an ordinary sibling
/// of `original_path`, before a local write folds the lineage onto other
/// text. The identity derives from the lineage and the text, so a write
/// retried after a rollback lands on the same sibling.
pub(crate) fn recover_unsettled_local_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    lineage_claim_id: Option<&str>,
    original_path: &str,
    markdown: &str,
    author_json: Option<&str>,
    now_ms: i64,
) -> Result<CreatedRecovery, SyncError> {
    // The identity and path helpers key on a 64-hex claim. An unclaimed local
    // lineage has none, so its coordinates stand in.
    let claim = lineage_claim_id.map_or_else(
        || {
            dohc_engine_storage::hex_sha256(
                format!(
                    "ydoc-local-recovery:v1\0{}\0{}\0{}",
                    key.workspace_id, key.version_id, key.object_id
                )
                .as_bytes(),
            )
        },
        str::to_owned,
    );
    let correlation = format!("{LOCAL_RECOVERY_CORRELATION_PREFIX}{claim}");
    let search_policy = search_policy_for_connection(tx);
    create_recovery_with_correlation_in_tx(
        tx,
        key,
        original_path,
        &claim,
        markdown,
        0,
        now_ms,
        search_policy.as_ref(),
        Some(&correlation),
        author_json,
        RecoveryCause::LocalUnsettled,
    )
}

#[allow(clippy::too_many_arguments)]
fn create_recovery_with_correlation_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    original_path: &str,
    losing_claim_id: &str,
    markdown: &str,
    first_collision_ordinal: u64,
    recorded_at_ms: i64,
    search_policy: Option<&SearchPolicySnapshot>,
    correlation: Option<&str>,
    author_json: Option<&str>,
    cause: RecoveryCause,
) -> Result<CreatedRecovery, SyncError> {
    let (mut identity, collision_ordinal) = available_identity(
        tx,
        key,
        original_path,
        losing_claim_id,
        markdown,
        first_collision_ordinal,
        cause,
    )?;
    if let Some(correlation) = correlation {
        identity.correlation_id = correlation.to_owned();
    }
    let projection_sha256 = dohc_engine_storage::hex_sha256(markdown.as_bytes());
    let recovered_path = free_recovered_path(
        tx,
        key,
        RecoveredNameParts::of_original(original_path),
        losing_claim_id,
        &projection_sha256,
        1,
    )?;
    write_recovery_in_tx(
        tx,
        key,
        &identity,
        &recovered_path,
        markdown,
        author_json,
        recorded_at_ms,
        cause,
        search_policy,
    )?;
    Ok(CreatedRecovery {
        path: recovered_path,
        object_id: identity.object_id,
        moment_id: identity.moment_id,
        collision_ordinal,
    })
}

/// The first unused identity of this lineage and text, from
/// `first_collision_ordinal`, with the ordinal it took.
fn available_identity(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    original_path: &str,
    losing_claim_id: &str,
    markdown: &str,
    first_collision_ordinal: u64,
    cause: RecoveryCause,
) -> Result<(RecoveryIdentity, u64), SyncError> {
    let mut collision_ordinal = first_collision_ordinal;
    loop {
        let candidate = recovery_identity(
            key,
            original_path,
            losing_claim_id,
            markdown,
            collision_ordinal,
            cause,
        );
        if identity_available(tx, &key.workspace_id, &candidate)? {
            return Ok((candidate, collision_ordinal));
        }
        collision_ordinal = collision_ordinal
            .checked_add(1)
            .ok_or_else(|| local_corruption("Y.Doc recovery identity sequence overflowed"))?;
    }
}

/// The first recovered path from `first_path_ordinal` that no alias, text
/// head or binary head occupies in this version.
fn free_recovered_path(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    parts: RecoveredNameParts<'_>,
    losing_claim_id: &str,
    projection_sha256: &str,
    first_path_ordinal: u64,
) -> Result<String, SyncError> {
    let mut path_ordinal = first_path_ordinal;
    loop {
        let candidate =
            recovered_path_from_parts(parts, losing_claim_id, projection_sha256, path_ordinal)?;
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
            return Ok(candidate);
        }
        path_ordinal = path_ordinal
            .checked_add(1)
            .ok_or_else(|| local_corruption("Y.Doc recovery path sequence overflowed"))?;
    }
}

/// Write the recovered text as a moment of a new object at `recovered_path`,
/// with its search row, its absent-preimage materialization and, where the
/// workspace journals file moments, its outbound entry.
#[allow(clippy::too_many_arguments)]
fn write_recovery_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    identity: &RecoveryIdentity,
    recovered_path: &str,
    markdown: &str,
    author_json: Option<&str>,
    recorded_at_ms: i64,
    cause: RecoveryCause,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<(), SyncError> {
    let result = write_text_in_tx(
        tx,
        &WriteText {
            workspace_id: key.workspace_id.clone(),
            version_id: key.version_id.clone(),
            object_id: identity.object_id.clone(),
            path: recovered_path.to_owned(),
            text: markdown.to_owned(),
            moment_id: identity.moment_id.clone(),
            metadata_origin: cause.origin().to_owned(),
            metadata_summary: Some(identity.summary.clone()),
            metadata_correlation_id: Some(identity.correlation_id.clone()),
            author_json: author_json.map(str::to_owned),
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
        // A recovered moment is a FILE moment, so it reads the same lane
        // question the ordinary moment journal reads: for an
        // edit share view it is drainable through the proposal submit, and
        // the two sites must agree or a recovery would strand a change the
        // recipient can see but never send.
        if crate::journal::workspace_journals_file_moments_in_tx(tx, &key.workspace_id)? {
            crate::outbound::journal_moment_append_in_tx(
                tx,
                &key.workspace_id,
                &result.moment.moment_id,
            )?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn recover_inactive_projection_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    path: &str,
    claim: &str,
    content: &str,
    previous_sha: &str,
    state_sha: &str,
    author_json: Option<&str>,
    now_ms: i64,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<(), SyncError> {
    let identity = dohc_engine_storage::hex_sha256(
        format!(
            "{}\0{}\0{}\0{}",
            key.workspace_id, key.version_id, key.object_id, claim
        )
        .as_bytes(),
    );
    let correlation = format!("ydoc-inactive-recovery:{identity}");
    let existing: Option<(String,String)> = tx.query_row(
        "SELECT object_id,path FROM snapshots WHERE workspace_id=?1 AND version_id=?2 \
         AND metadata_correlation_id=?3 AND blob_sha256=?4 \
         AND NOT EXISTS (SELECT 1 FROM ydoc_docs d WHERE d.workspace_id=snapshots.workspace_id \
          AND d.version_id=snapshots.version_id AND d.object_id=snapshots.object_id) ORDER BY updated_at_ms DESC LIMIT 1",
        params![key.workspace_id,key.version_id,correlation,previous_sha],|row| Ok((row.get(0)?,row.get(1)?)),
    ).optional().map_err(SyncError::corrupt)?;
    let Some((object_id, path)) = existing else {
        create_recovery_with_correlation_in_tx(
            tx,
            key,
            path,
            claim,
            content,
            0,
            now_ms,
            search_policy,
            Some(&correlation),
            author_json,
            RecoveryCause::RelayArbitration,
        )?;
        return Ok(());
    };
    let moment =
        dohc_engine_storage::hex_sha256(format!("{identity}\0{object_id}\0{state_sha}").as_bytes());
    let result = write_text_in_tx(
        tx,
        &WriteText {
            workspace_id: key.workspace_id.clone(),
            version_id: key.version_id.clone(),
            object_id,
            path: path.clone(),
            text: content.to_owned(),
            moment_id: format!("ydoc-inactive-recovery-{moment}"),
            metadata_origin: "sync".to_owned(),
            metadata_summary: Some(recovery_summary(
                RecoveryCause::RelayArbitration,
                path.as_str(),
            )),
            metadata_correlation_id: Some(correlation),
            author_json: author_json.map(str::to_owned),
            now_ms,
            request_id: None,
        },
    )
    .map_err(|error| map_domain_payload_error(error, "Y.Doc recovery update failed"))?;
    if !result.deduped {
        enqueue_write(
            tx,
            &result,
            Preimage::Present(previous_sha.to_owned()),
            "sync",
        )
        .map_err(map_domain_hard_error)?;
        upsert_file_search_index(
            tx,
            &key.workspace_id,
            &key.version_id,
            &result.snapshot.object_id,
            &result.snapshot.path,
            Some(content),
            search_policy,
        )?;
        if crate::journal::workspace_journals_file_moments_in_tx(tx, &key.workspace_id)? {
            crate::outbound::journal_moment_append_in_tx(
                tx,
                &key.workspace_id,
                &result.moment.moment_id,
            )?;
        }
    }
    Ok(())
}

/// Select the recovery jobs that must reach disk before their paths are
/// announced. A pending job is returned unchanged, including after a committed
/// repair lost its response. A conflicted absent-preimage write moves only
/// after capture makes the disk occupant authoritative in the database. A
/// later user rename or delete returns nothing and never rebuilds the sibling.
/// A local recovery of unsettled text has no decision row. Its collided copy
/// moves the same way, keyed by the copy's own moment, and its pending copy
/// is announced the same way.
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
        let outcome = match store.write_with(faults, |tx| {
            relocate_conflicted_recovery_in_tx(
                tx,
                workspace_id,
                &origin_id,
                origin_seq,
                &job_status,
                search_policy.as_ref(),
            )
        }) {
            Ok(outcome) => outcome,
            // Capture has not recorded this copy's occupant yet. The copy
            // waits for a later pass; the recoveries after it do not.
            Err(SyncError::RetryableState { .. }) => continue,
            Err(error) => return Err(error),
        };
        match outcome {
            TxnOutcome::Committed(Some(materialization)) => repaired.push(materialization),
            TxnOutcome::Committed(None) => {}
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
        }
    }
    for (job_id, moment_id) in collided_local_recoveries(store, workspace_id)? {
        let outcome = store.write_with(faults, |tx| {
            relocate_collided_local_recovery_in_tx(
                tx,
                workspace_id,
                &job_id,
                &moment_id,
                search_policy.as_ref(),
            )
        })?;
        if let TxnOutcome::Crashed { .. } = outcome {
            return Err(SyncError::FaultCrash);
        }
    }
    repaired.extend(pending_local_recoveries(store, workspace_id)?);
    Ok(repaired)
}

/// Refused writes of locally recovered text whose copy is still the object at
/// its path, displaced by a head capture recorded over the recovery moment: a
/// file another program created at the chosen name. A copy that was renamed
/// or deleted, replaced through the API, or whose occupant capture has not
/// recorded yet, is left alone. An occupant edited since capture recorded it
/// still moves the copy.
fn collided_local_recoveries(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<(String, String)>, SyncError> {
    store.read_with(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT job.job_id, moment.moment_id
                   FROM materialization_jobs AS job
                   JOIN moments AS moment
                     ON moment.workspace_id=?1
                    AND moment.moment_id=substr(job.job_id, length('sync-mat_')+1)
                   JOIN snapshots AS snapshot
                     ON snapshot.workspace_id=moment.workspace_id
                    AND snapshot.version_id=moment.version_id
                    AND snapshot.object_id=moment.object_id
                    AND snapshot.path=moment.path
                    AND snapshot.latest_moment_id<>moment.moment_id
                  WHERE job.workspace_id=?1
                    AND job.status='conflict'
                    AND job.operation='write'
                    AND job.job_id GLOB 'sync-mat_ydoc-recovery-moment-*'
                    AND moment.metadata_correlation_id GLOB 'ydoc-local-recovery:*'
                    AND EXISTS(SELECT 1 FROM moments AS occupant
                                WHERE occupant.workspace_id=moment.workspace_id
                                  AND occupant.version_id=moment.version_id
                                  AND occupant.object_id=moment.object_id
                                  AND occupant.path=moment.path
                                  AND occupant.before_latest_moment_id=moment.moment_id
                                  AND occupant.metadata_origin=?2)
                  ORDER BY job.target_generation",
            )
            .map_err(SyncError::corrupt)?;
        let rows = statement
            .query_map(params![workspace_id, CAPTURE_ORIGIN], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(SyncError::corrupt)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)
    })
}

/// Move one collided local copy to the next free recovered name. The new
/// moment keeps the copy's text, origin, summary, authors, correlation and
/// recorded time. The refused write is cancelled in the same transaction, so
/// a later pass finds nothing to move, and a crash after commit leaves one
/// pending copy for the next pass to announce.
fn relocate_collided_local_recovery_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    job_id: &str,
    moment_id: &str,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<(), SyncError> {
    // The pass selected this copy outside the transaction: read it again.
    let status: Option<String> = tx
        .query_row(
            "SELECT status FROM materialization_jobs
              WHERE job_id=?1 AND workspace_id=?2 AND operation='write'",
            params![job_id, workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    if status.as_deref() != Some("conflict") {
        return Ok(());
    }
    type CopyRow = (
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
    );
    let copy: Option<CopyRow> = tx
        .query_row(
            "SELECT moment.version_id, moment.object_id, moment.path, blob.sha256,
                    moment.metadata_summary, moment.metadata_correlation_id,
                    moment.author_json, moment.recorded_at_ms
               FROM moments AS moment
               JOIN blobs AS blob ON blob.sha256=moment.after_blob_sha256
              WHERE moment.workspace_id=?1 AND moment.moment_id=?2",
            params![workspace_id, moment_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    text::from_row(tx, row, 3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some((
        version_id,
        object_id,
        path,
        markdown,
        summary,
        correlation,
        author_json,
        recorded_at_ms,
    )) = copy
    else {
        return Ok(());
    };
    let (Some(correlation), Some(summary)) = (correlation, summary) else {
        return Err(local_corruption(
            "local Y.Doc recovery moment lost its metadata",
        ));
    };
    let Some(claim) = correlation
        .strip_prefix(LOCAL_RECOVERY_CORRELATION_PREFIX)
        .filter(|claim| valid_claim_id(claim))
    else {
        return Err(local_corruption(
            "local Y.Doc recovery correlation is malformed",
        ));
    };
    let collided: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM snapshots AS snapshot
               JOIN moments AS occupant
                 ON occupant.workspace_id=snapshot.workspace_id
                AND occupant.version_id=snapshot.version_id
                AND occupant.object_id=snapshot.object_id
                AND occupant.path=snapshot.path
                AND occupant.before_latest_moment_id=?5
                AND occupant.metadata_origin=?6
              WHERE snapshot.workspace_id=?1 AND snapshot.version_id=?2
                AND snapshot.object_id=?3 AND snapshot.path=?4
                AND snapshot.latest_moment_id<>?5)",
            params![
                workspace_id,
                version_id,
                object_id,
                path,
                moment_id,
                CAPTURE_ORIGIN
            ],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !collided {
        return Ok(());
    }
    let projection_sha256 = dohc_engine_storage::hex_sha256(markdown.as_bytes());
    let Some((parts, ordinal)) = RecoveredNameParts::of_recovered(&path, claim, &projection_sha256)
    else {
        return Err(local_corruption(
            "local Y.Doc recovery path lost its marker",
        ));
    };
    let next_path_ordinal = ordinal
        .checked_add(1)
        .ok_or_else(|| local_corruption("Y.Doc recovery path sequence overflowed"))?;
    // The moved copy's identity derives from the copy it replaces and the
    // text, so a retry after a rollback lands on the same sibling. Its
    // summary still names the file the text came from.
    let key = DocKey::new(workspace_id.to_owned(), version_id, object_id)
        .map_err(map_collab_hard_error)?;
    let cause = RecoveryCause::LocalUnsettled;
    let (mut identity, _) = available_identity(tx, &key, &path, claim, &markdown, 0, cause)?;
    identity.correlation_id = correlation.clone();
    identity.summary = summary;
    let recovered_path = free_recovered_path(
        tx,
        &key,
        parts,
        claim,
        &projection_sha256,
        next_path_ordinal,
    )?;
    write_recovery_in_tx(
        tx,
        &key,
        &identity,
        &recovered_path,
        &markdown,
        author_json.as_deref(),
        recorded_at_ms,
        cause,
        search_policy,
    )?;
    let cancelled = tx
        .execute(
            "UPDATE materialization_jobs SET status='cancelled'
              WHERE job_id=?1 AND status='conflict'",
            [job_id],
        )
        .map_err(SyncError::persist)?;
    if cancelled != 1 {
        return Err(SyncError::CoordinateDiverged);
    }
    Ok(())
}

/// Pending writes of locally recovered unsettled text whose sibling still
/// stands at the path the recovery chose. They were written to a free path,
/// so they only need to reach disk and be announced. A renamed or deleted
/// sibling is left alone.
fn pending_local_recoveries(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<YdocRecoveryMaterialization>, SyncError> {
    store.read_with(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT job.job_id, moment.path
                   FROM materialization_jobs AS job
                   JOIN moments AS moment
                     ON moment.workspace_id=?1
                    AND moment.moment_id=substr(job.job_id, length('sync-mat_')+1)
                   JOIN snapshots AS snapshot
                     ON snapshot.workspace_id=moment.workspace_id
                    AND snapshot.version_id=moment.version_id
                    AND snapshot.object_id=moment.object_id
                    AND snapshot.path=moment.path
                    AND snapshot.latest_moment_id=moment.moment_id
                  WHERE job.workspace_id=?1
                    AND job.status='pending'
                    AND job.operation='write'
                    AND job.job_id GLOB 'sync-mat_ydoc-recovery-moment-*'
                    AND moment.metadata_correlation_id GLOB 'ydoc-local-recovery:*'
                  ORDER BY job.target_generation",
            )
            .map_err(SyncError::corrupt)?;
        let rows = statement
            .query_map([workspace_id], |row| {
                Ok(YdocRecoveryMaterialization {
                    materialization_job_id: row.get(0)?,
                    path: row.get(1)?,
                })
            })
            .map_err(SyncError::corrupt)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)
    })
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
    let recovery_markdown: Option<String> = tx
        .query_row(
            "SELECT blob.sha256 FROM moments AS moment
             JOIN blobs AS blob ON blob.sha256=moment.after_blob_sha256
             WHERE moment.workspace_id=?1 AND moment.moment_id=?2",
            params![workspace_id, decision.recovery_moment_id],
            |row| text::from_row(tx, row, 0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some(recovery_markdown) = recovery_markdown else {
        return Ok(None);
    };
    let projection_sha256 = dohc_engine_storage::hex_sha256(recovery_markdown.as_bytes());
    if !valid_claim_id(&decision.losing_claim_id)
        || !is_recovered_path_candidate(
            &decision.original_path,
            &decision.losing_claim_id,
            &projection_sha256,
            &decision.recovered_path,
        )?
    {
        return Err(SyncError::CoordinateDiverged);
    }
    let expected_identity = recovery_identity(
        &key,
        &decision.original_path,
        &decision.losing_claim_id,
        &recovery_markdown,
        decision.collision_ordinal,
        RecoveryCause::RelayArbitration,
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
                        "SELECT blob.sha256 FROM snapshots AS snapshot
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
                        |row| text::from_row(tx, row, 0),
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
    verify_recovery(tx, &key, &decision, &recovery_markdown)?;
    let first_collision_ordinal = decision
        .collision_ordinal
        .checked_add(1)
        .ok_or_else(|| local_corruption("Y.Doc recovery identity sequence overflowed"))?;
    let created = create_recovery_in_tx(
        tx,
        &key,
        &decision.original_path,
        &decision.losing_claim_id,
        &recovery_markdown,
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
        version_id: decision.version_id,
        path: decision.recovered_path,
        operation: "write",
        content_kind: "text",
    }))
}

fn map_domain_payload_error(error: DomainError, reason: &'static str) -> SyncError {
    match error {
        DomainError::PayloadTooLarge {
            constraint,
            limit_bytes,
            observed_bytes,
        } => SyncError::ProjectionTooLarge {
            constraint,
            limit_bytes,
            actual_bytes: observed_bytes,
        },
        DomainError::InvalidText { .. }
        | DomainError::InvalidPath { .. }
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
    use dohc_engine_collab::DocKey;
    use dohc_engine_files::{
        MAX_CANONICAL_WORKSPACE_PATH_BYTES, PathClassification,
        classify_engine_file_path_normalized,
    };

    use super::{
        RecoveredNameParts, RecoveryCause, recovered_path_candidate, recovered_path_from_parts,
        recovery_identity,
    };

    const CLAIM: &str = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

    #[test]
    fn recovered_path_is_deterministic_and_keeps_the_extension() {
        let projection = dohc_engine_storage::hex_sha256(b"draft");
        assert_eq!(
            recovered_path_candidate("notes/draft.md", CLAIM, &projection, 1).unwrap(),
            format!("notes/draft (recovered 12345678 {projection}).md")
        );
        assert_eq!(
            recovered_path_candidate("notes/draft.md", CLAIM, &projection, 2).unwrap(),
            format!("notes/draft (recovered 12345678 {projection} 2).md")
        );
    }

    #[test]
    fn a_collided_copy_reads_back_into_the_pieces_that_place_its_replacement() {
        let projection = dohc_engine_storage::hex_sha256(b"draft");
        let first = recovered_path_candidate("notes/draft.md", CLAIM, &projection, 1).unwrap();
        let (parts, ordinal) =
            RecoveredNameParts::of_recovered(&first, CLAIM, &projection).expect("marker");
        assert_eq!(
            (parts.parent, parts.stem, parts.extension, ordinal),
            ("notes", "draft", ".md", 1)
        );
        let second = recovered_path_candidate("notes/draft.md", CLAIM, &projection, 2).unwrap();
        assert_eq!(
            recovered_path_from_parts(parts, CLAIM, &projection, 2).unwrap(),
            second
        );
        assert_eq!(
            RecoveredNameParts::of_recovered(&second, CLAIM, &projection)
                .map(|(_, ordinal)| ordinal),
            Some(2)
        );
        assert!(RecoveredNameParts::of_recovered("notes/draft.md", CLAIM, &projection).is_none());
    }

    #[test]
    fn recovered_path_stays_within_the_full_canonical_path_limit() {
        let parent = [
            "a".repeat(240),
            "b".repeat(240),
            "c".repeat(240),
            "d".repeat(177),
        ]
        .join("/");
        assert_eq!(parent.len(), 900);
        let original = format!("{parent}/{}.md", "e".repeat(120));
        assert_eq!(original.len(), MAX_CANONICAL_WORKSPACE_PATH_BYTES);

        let projection = dohc_engine_storage::hex_sha256(b"draft");
        let recovered = recovered_path_candidate(&original, CLAIM, &projection, 1).unwrap();

        assert_eq!(recovered.len(), MAX_CANONICAL_WORKSPACE_PATH_BYTES);
        assert!(recovered.starts_with(&format!("{parent}/")));
        assert!(recovered.ends_with(&format!(" (recovered 12345678 {projection}).md")));
        assert_eq!(
            classify_engine_file_path_normalized(&recovered),
            (PathClassification::Tracked, Some(recovered.clone()))
        );
    }

    #[test]
    fn recovered_path_uses_the_workspace_root_when_its_parent_has_no_name_budget() {
        let parent = [
            "a".repeat(250),
            "b".repeat(250),
            "c".repeat(250),
            "d".repeat(250),
        ]
        .join("/");
        assert_eq!(parent.len(), 1_003);
        let original = format!("{parent}/{}", "e".repeat(20));
        assert_eq!(original.len(), MAX_CANONICAL_WORKSPACE_PATH_BYTES);

        let projection = dohc_engine_storage::hex_sha256(b"draft");
        let recovered = recovered_path_candidate(&original, CLAIM, &projection, 1).unwrap();

        assert_eq!(
            recovered,
            format!("{} (recovered 12345678 {projection})", "e".repeat(20))
        );
        assert_eq!(
            classify_engine_file_path_normalized(&recovered),
            (PathClassification::Tracked, Some(recovered.clone()))
        );
    }

    #[test]
    fn recovery_identity_distinguishes_distinct_recovered_projections() {
        let key = DocKey::new("ws", "main", "object").expect("key");
        let first_projection = dohc_engine_storage::hex_sha256(b"peer A draft");
        let second_projection = dohc_engine_storage::hex_sha256(b"peer B draft");
        let first = recovery_identity(
            &key,
            "notes/draft.md",
            CLAIM,
            "peer A draft",
            0,
            RecoveryCause::RelayArbitration,
        );
        let second = recovery_identity(
            &key,
            "notes/draft.md",
            CLAIM,
            "peer B draft",
            0,
            RecoveryCause::RelayArbitration,
        );

        assert_ne!(
            (first.object_id, first.moment_id),
            (second.object_id, second.moment_id),
            "distinct recovered bodies must not alias durable identities"
        );
        assert_ne!(
            recovered_path_candidate("notes/draft.md", CLAIM, &first_projection, 1).unwrap(),
            recovered_path_candidate("notes/draft.md", CLAIM, &second_projection, 1).unwrap(),
            "distinct recovered bodies must not alias visible paths"
        );
    }

    #[test]
    fn recovery_identity_converges_same_projection_and_is_stable_for_redelivery() {
        let key = DocKey::new("ws", "main", "object").expect("key");
        let projection = dohc_engine_storage::hex_sha256(b"same draft");

        assert_eq!(
            recovery_identity(
                &key,
                "notes/draft.md",
                CLAIM,
                "same draft",
                0,
                RecoveryCause::RelayArbitration,
            ),
            recovery_identity(
                &key,
                "notes/draft.md",
                CLAIM,
                "same draft",
                0,
                RecoveryCause::RelayArbitration,
            ),
        );
        assert_eq!(
            recovered_path_candidate("notes/draft.md", CLAIM, &projection, 1).unwrap(),
            recovered_path_candidate("notes/draft.md", CLAIM, &projection, 1).unwrap(),
        );
    }
}
