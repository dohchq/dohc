//! Durable text-conflict objects and exact-head resolution gates.

use crate::error::DomainError;
use crate::records::{DeleteResult, DeleteTextFile, TextSnapshot, WriteResult, WriteText};
use crate::store::{
    VersionedTextStore, delete_text_in_tx, hash_fields, lookup_request, record_request,
    validate_delete_input, validate_write_input, write_text_in_tx,
};
use dohc_engine_storage::{
    FaultInjector, MaterializationJobSpec, Preimage, StorageError, TxnOutcome, enqueue_delete_job,
    enqueue_job, has_binary_blob, put_binary_blob, put_binary_blob_verified,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictContentKind {
    Text,
    Binary,
}

impl ConflictContentKind {
    fn as_str(self) -> &'static str {
        match self {
            ConflictContentKind::Text => "text",
            ConflictContentKind::Binary => "binary",
        }
    }

    fn parse(raw: &str) -> Result<Self, DomainError> {
        match raw {
            "text" => Ok(ConflictContentKind::Text),
            "binary" => Ok(ConflictContentKind::Binary),
            _ => Err(DomainError::StateCorrupt {
                reason: "unknown conflict content kind",
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictMetadata {
    pub origin: String,
    pub summary: Option<String>,
    pub correlation_id: Option<String>,
}

impl ConflictMetadata {
    pub fn origin(origin: impl Into<String>) -> Self {
        ConflictMetadata {
            origin: origin.into(),
            summary: None,
            correlation_id: None,
        }
    }
}

/// One conflict side. Text and binary content are mutually exclusive: text is
/// carried by `snapshot`, while binary is carried by `binary_sha256`. `path`
/// remains explicit because an absent side and a divergent move still carry a
/// meaningful destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictFileState {
    pub path: String,
    pub snapshot: Option<TextSnapshot>,
    pub binary_sha256: Option<String>,
    pub content_kind: ConflictContentKind,
    pub metadata_summary: Option<String>,
    pub metadata_correlation_id: Option<String>,
}

impl ConflictFileState {
    pub fn text(path: impl Into<String>, snapshot: Option<TextSnapshot>) -> Self {
        ConflictFileState {
            path: path.into(),
            snapshot,
            binary_sha256: None,
            content_kind: ConflictContentKind::Text,
            metadata_summary: None,
            metadata_correlation_id: None,
        }
    }

    pub fn binary(path: impl Into<String>, binary_sha256: impl Into<String>) -> Self {
        ConflictFileState {
            path: path.into(),
            snapshot: None,
            binary_sha256: Some(binary_sha256.into()),
            content_kind: ConflictContentKind::Binary,
            metadata_summary: None,
            metadata_correlation_id: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictStatus {
    Open,
    Resolved,
}

impl ConflictStatus {
    fn as_str(self) -> &'static str {
        match self {
            ConflictStatus::Open => "open",
            ConflictStatus::Resolved => "resolved",
        }
    }

    fn parse(raw: &str) -> Result<Self, DomainError> {
        match raw {
            "open" => Ok(ConflictStatus::Open),
            "resolved" => Ok(ConflictStatus::Resolved),
            _ => Err(DomainError::StateCorrupt {
                reason: "unknown conflict status",
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictChoice {
    Current,
    Incoming,
    Merged,
}

impl ConflictChoice {
    fn as_str(self) -> &'static str {
        match self {
            ConflictChoice::Current => "current",
            ConflictChoice::Incoming => "incoming",
            ConflictChoice::Merged => "merged",
        }
    }

    fn parse(raw: &str) -> Result<Self, DomainError> {
        match raw {
            "current" => Ok(ConflictChoice::Current),
            "incoming" => Ok(ConflictChoice::Incoming),
            "merged" => Ok(ConflictChoice::Merged),
            _ => Err(DomainError::StateCorrupt {
                reason: "unknown conflict choice",
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictResolution {
    KeptCurrent,
    AppliedIncoming,
    AppliedMerged,
}

impl ConflictResolution {
    fn as_str(self) -> &'static str {
        match self {
            ConflictResolution::KeptCurrent => "kept-current",
            ConflictResolution::AppliedIncoming => "applied-incoming",
            ConflictResolution::AppliedMerged => "applied-merged",
        }
    }

    fn parse(raw: &str) -> Result<Self, DomainError> {
        match raw {
            "kept-current" => Ok(ConflictResolution::KeptCurrent),
            "applied-incoming" => Ok(ConflictResolution::AppliedIncoming),
            "applied-merged" => Ok(ConflictResolution::AppliedMerged),
            _ => Err(DomainError::StateCorrupt {
                reason: "unknown conflict resolution",
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextConflict {
    pub conflict_id: String,
    pub workspace_id: String,
    pub path: String,
    pub target_version_id: String,
    pub source_version_id: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub status: ConflictStatus,
    pub chosen_from: ConflictChoice,
    pub resolution: Option<ConflictResolution>,
    pub metadata: ConflictMetadata,
    pub base: ConflictFileState,
    pub current: ConflictFileState,
    pub incoming: ConflictFileState,
}

#[derive(Debug, Clone)]
pub struct ConflictRowUpdate {
    pub status: ConflictStatus,
    pub chosen_from: ConflictChoice,
    pub resolution: Option<ConflictResolution>,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone)]
pub enum ResolveConflictKind {
    ApplyIncoming,
    KeepCurrent,
    ApplyMerged { text: String },
}

#[derive(Debug, Clone)]
pub struct ResolveTextConflict {
    pub workspace_id: String,
    pub conflict_id: String,
    pub resolution: ResolveConflictKind,
    /// Fresh object identity used only when resolution writes to an unoccupied path.
    pub object_id: String,
    pub write_moment_id: String,
    pub delete_moment_id: String,
    pub metadata_origin: String,
    pub author_json: Option<String>,
    pub now_ms: i64,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveTextConflictResult {
    pub conflict: TextConflict,
    pub write: Option<WriteResult>,
    pub delete: Option<DeleteResult>,
}

/// Exact live-head gate shared by local resolution and R10 mirror apply.
pub fn live_state_matches_conflict_current(
    live: &ConflictFileState,
    recorded: &ConflictFileState,
) -> bool {
    if live.content_kind != recorded.content_kind {
        return false;
    }
    match live.content_kind {
        ConflictContentKind::Text => match (&live.snapshot, &recorded.snapshot) {
            (None, None) => true,
            (Some(live_snapshot), Some(recorded_snapshot)) => {
                live.path == recorded.path
                    && live_snapshot.object_id == recorded_snapshot.object_id
                    && live_snapshot.latest_moment_id == recorded_snapshot.latest_moment_id
                    && live_snapshot.text == recorded_snapshot.text
            }
            _ => false,
        },
        ConflictContentKind::Binary => {
            live.path == recorded.path && live.binary_sha256 == recorded.binary_sha256
        }
    }
}

/// Insert a fully-formed conflict received locally or over replication. A row
/// with the same workspace/id is left untouched and reports `false`.
pub fn insert_text_conflict_if_absent(
    tx: &Transaction<'_>,
    conflict: &TextConflict,
) -> Result<bool, DomainError> {
    let exists: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM conflicts WHERE workspace_id = ?1 AND conflict_id = ?2",
            params![conflict.workspace_id, conflict.conflict_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if exists.is_some() {
        return Ok(false);
    }
    for side in [&conflict.base, &conflict.current, &conflict.incoming] {
        match side.content_kind {
            ConflictContentKind::Text => {
                if side.binary_sha256.is_some() {
                    return Err(DomainError::InvalidInput {
                        reason: "text conflict side cannot reference a binary blob",
                    });
                }
            }
            ConflictContentKind::Binary => {
                if side.snapshot.is_some() {
                    return Err(DomainError::InvalidInput {
                        reason: "binary conflict side cannot carry a text snapshot",
                    });
                }
                let sha256 = side
                    .binary_sha256
                    .as_deref()
                    .ok_or(DomainError::InvalidInput {
                        reason: "binary conflict side is missing its blob reference",
                    })?;
                if !has_binary_blob(tx, sha256)? {
                    return Err(DomainError::InvalidInput {
                        reason: "binary conflict side references a missing binary blob",
                    });
                }
            }
        }
    }
    // Mirror TS `insertConflictFileState`: persist each existing text side's blob
    // so the row's blob FKs hold on a peer that has not yet materialized them.
    for side in [&conflict.base, &conflict.current, &conflict.incoming] {
        if let Some(snapshot) = &side.snapshot {
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
                params![
                    snapshot.blob_sha256,
                    snapshot.text.len() as i64,
                    snapshot.text
                ],
            )
            .map_err(DomainError::sql_persist)?;
        }
    }
    let base = side_bindings(&conflict.base);
    let current = side_bindings(&conflict.current);
    let incoming = side_bindings(&conflict.incoming);
    tx.execute(
        "INSERT INTO conflicts (
          workspace_id, conflict_id, path, target_version_id, source_version_id,
          created_at_ms, updated_at_ms, status, chosen_from, resolution,
          metadata_origin, metadata_summary, metadata_correlation_id,
          base_exists, base_path, base_object_id, base_content_kind, base_blob_sha256,
          base_updated_at_ms, base_latest_moment_id, base_metadata_origin,
          base_metadata_summary, base_metadata_correlation_id,
          current_exists, current_path, current_object_id, current_content_kind,
          current_blob_sha256, current_updated_at_ms, current_latest_moment_id,
          current_metadata_origin, current_metadata_summary, current_metadata_correlation_id,
          incoming_exists, incoming_path, incoming_object_id, incoming_content_kind,
          incoming_blob_sha256, incoming_updated_at_ms, incoming_latest_moment_id,
          incoming_metadata_origin, incoming_metadata_summary, incoming_metadata_correlation_id,
          base_binary_sha256, current_binary_sha256, incoming_binary_sha256
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
          ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23,
          ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33,
          ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41, ?42, ?43,
          ?44, ?45, ?46)",
        params![
            conflict.workspace_id,
            conflict.conflict_id,
            conflict.path,
            conflict.target_version_id,
            conflict.source_version_id,
            conflict.created_at_ms,
            conflict.updated_at_ms,
            conflict.status.as_str(),
            conflict.chosen_from.as_str(),
            conflict.resolution.map(ConflictResolution::as_str),
            conflict.metadata.origin,
            conflict.metadata.summary,
            conflict.metadata.correlation_id,
            base.exists,
            base.path,
            base.object_id,
            base.content_kind,
            base.blob_sha256,
            base.updated_at_ms,
            base.latest_moment_id,
            base.metadata_origin,
            base.metadata_summary,
            base.metadata_correlation_id,
            current.exists,
            current.path,
            current.object_id,
            current.content_kind,
            current.blob_sha256,
            current.updated_at_ms,
            current.latest_moment_id,
            current.metadata_origin,
            current.metadata_summary,
            current.metadata_correlation_id,
            incoming.exists,
            incoming.path,
            incoming.object_id,
            incoming.content_kind,
            incoming.blob_sha256,
            incoming.updated_at_ms,
            incoming.latest_moment_id,
            incoming.metadata_origin,
            incoming.metadata_summary,
            incoming.metadata_correlation_id,
            base.binary_sha256,
            current.binary_sha256,
            incoming.binary_sha256,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(true)
}

/// Update only the resolution columns. R10 mirror apply can reuse this without
/// duplicating local row-shape SQL.
pub fn update_text_conflict_row(
    tx: &Transaction<'_>,
    workspace_id: &str,
    conflict_id: &str,
    update: &ConflictRowUpdate,
) -> Result<bool, DomainError> {
    let changed = tx
        .execute(
            "UPDATE conflicts SET status = ?3, chosen_from = ?4, resolution = ?5, \
             updated_at_ms = ?6 WHERE workspace_id = ?1 AND conflict_id = ?2",
            params![
                workspace_id,
                conflict_id,
                update.status.as_str(),
                update.chosen_from.as_str(),
                update.resolution.map(ConflictResolution::as_str),
                update.updated_at_ms,
            ],
        )
        .map_err(DomainError::sql_persist)?;
    Ok(changed != 0)
}

impl VersionedTextStore<'_> {
    pub fn list_text_conflicts(
        &self,
        workspace_id: &str,
        status: Option<&str>,
    ) -> Result<Vec<TextConflict>, DomainError> {
        if !matches!(status, None | Some("open") | Some("resolved")) {
            return Err(DomainError::InvalidInput {
                reason: "conflict status is invalid",
            });
        }
        self.store
            .read_with(|conn| list_conflicts(conn, workspace_id, status))
    }

    pub fn resolve_text_conflict(
        &mut self,
        input: &ResolveTextConflict,
        faults: &dyn FaultInjector,
    ) -> Result<ResolveTextConflictResult, DomainError> {
        validate_path_like_id(&input.workspace_id, "workspace_id")?;
        validate_path_like_id(&input.conflict_id, "conflict_id")?;
        let (resolution_kind, merged_text) = match &input.resolution {
            ResolveConflictKind::KeepCurrent => ("keep-current", ""),
            ResolveConflictKind::ApplyIncoming => ("apply-incoming", ""),
            ResolveConflictKind::ApplyMerged { text } => ("apply-merged", text.as_str()),
        };
        let payload_hash = hash_fields(&[
            input.workspace_id.as_bytes(),
            input.conflict_id.as_bytes(),
            resolution_kind.as_bytes(),
            merged_text.as_bytes(),
            input.write_moment_id.as_bytes(),
            input.delete_moment_id.as_bytes(),
        ]);
        let outcome = self.store.write_with(faults, |tx| {
            if let Some(request_id) = &input.request_id
                && let Some(recorded) = lookup_request(tx, request_id)?
            {
                if recorded.payload_hash != payload_hash {
                    return Err(DomainError::IdempotencyKeyReuseMismatch);
                }
                let conflict =
                    load_text_conflict_in_tx(tx, &input.workspace_id, &input.conflict_id)?
                        .ok_or(DomainError::ConflictNotFound)?;
                return Ok(ResolveTextConflictResult {
                    conflict,
                    write: None,
                    delete: None,
                });
            }
            let mut conflict =
                load_text_conflict_in_tx(tx, &input.workspace_id, &input.conflict_id)?
                    .ok_or(DomainError::ConflictNotFound)?;
            let live_snapshot = select_text_snapshot_by_path_in_tx(
                tx,
                &conflict.workspace_id,
                &conflict.target_version_id,
                &conflict.path,
            )?;
            let live = ConflictFileState::text(conflict.path.clone(), live_snapshot);
            if !live_state_matches_conflict_current(&live, &conflict.current) {
                return Err(DomainError::ConflictStaleTarget);
            }

            let mut write = None;
            let mut deletion = None;
            let (choice, resolution) = match &input.resolution {
                ResolveConflictKind::KeepCurrent => {
                    (ConflictChoice::Current, ConflictResolution::KeptCurrent)
                }
                ResolveConflictKind::ApplyIncoming => {
                    if conflict.incoming.content_kind == ConflictContentKind::Binary {
                        // Binary APPLY lands in R10-CONFLICT-COMPLETE.
                        return Err(binary_conflicts_unsupported());
                    }
                    if let Some(incoming) = &conflict.incoming.snapshot {
                        let destination = conflict.incoming.path.clone();
                        if destination != conflict.path {
                            if select_text_snapshot_by_path_in_tx(
                                tx,
                                &conflict.workspace_id,
                                &conflict.target_version_id,
                                &destination,
                            )?
                            .is_some()
                            {
                                return Err(DomainError::TargetPathExists);
                            }
                            if conflict.current.snapshot.is_some() {
                                let delete_input = delete_input(
                                    input,
                                    &conflict.target_version_id,
                                    &conflict.path,
                                );
                                validate_delete_input(&delete_input)?;
                                let result = delete_text_in_tx(tx, &delete_input)?;
                                enqueue_delete(tx, &result, "resolve")?;
                                deletion = Some(result);
                            }
                        }
                        let write_input = write_input(
                            input,
                            &conflict.target_version_id,
                            &destination,
                            &incoming.text,
                            &input.write_moment_id,
                        );
                        validate_write_input(&write_input)?;
                        let result = write_text_in_tx(tx, &write_input)?;
                        let preimage = if destination == conflict.path {
                            conflict
                                .current
                                .snapshot
                                .as_ref()
                                .map_or(Preimage::Absent, |snapshot| {
                                    Preimage::Present(snapshot.blob_sha256.clone())
                                })
                        } else {
                            Preimage::Absent
                        };
                        enqueue_write(tx, &result, preimage, "resolve")?;
                        write = Some(result);
                    } else if conflict.current.snapshot.is_some() {
                        let delete_input =
                            delete_input(input, &conflict.target_version_id, &conflict.path);
                        validate_delete_input(&delete_input)?;
                        let result = delete_text_in_tx(tx, &delete_input)?;
                        enqueue_delete(tx, &result, "resolve")?;
                        deletion = Some(result);
                    }
                    (
                        ConflictChoice::Incoming,
                        ConflictResolution::AppliedIncoming,
                    )
                }
                ResolveConflictKind::ApplyMerged { text } => {
                    // Binary APPLY lands in R10-CONFLICT-COMPLETE.
                    if [
                        conflict.base.content_kind,
                        conflict.current.content_kind,
                        conflict.incoming.content_kind,
                    ]
                    .contains(&ConflictContentKind::Binary)
                    {
                        return Err(DomainError::InvalidInput {
                            reason: "binary conflicts cannot be resolved with combined text",
                        });
                    }
                    let write_input = write_input(
                        input,
                        &conflict.target_version_id,
                        &conflict.path,
                        text,
                        &input.write_moment_id,
                    );
                    validate_write_input(&write_input)?;
                    let result = write_text_in_tx(tx, &write_input)?;
                    let preimage = conflict
                        .current
                        .snapshot
                        .as_ref()
                        .map_or(Preimage::Absent, |snapshot| {
                            Preimage::Present(snapshot.blob_sha256.clone())
                        });
                    enqueue_write(tx, &result, preimage, "resolve")?;
                    write = Some(result);
                    (ConflictChoice::Merged, ConflictResolution::AppliedMerged)
                }
            };

            let update = ConflictRowUpdate {
                status: ConflictStatus::Resolved,
                chosen_from: choice,
                resolution: Some(resolution),
                updated_at_ms: input.now_ms,
            };
            if !update_text_conflict_row(tx, &input.workspace_id, &input.conflict_id, &update)? {
                return Err(DomainError::ConflictNotFound);
            }
            tx.execute(
                "INSERT INTO replication_journal (doc_id, op_kind, created_at_ms) \
                 VALUES (?1, 'conflict.resolve', ?2)",
                params![conflict.conflict_id, input.now_ms],
            )
            .map_err(DomainError::sql_persist)?;
            record_request(
                tx,
                input.request_id.as_deref(),
                &payload_hash,
                0,
                input.now_ms,
            )?;
            conflict.status = update.status;
            conflict.chosen_from = update.chosen_from;
            conflict.resolution = update.resolution;
            conflict.updated_at_ms = update.updated_at_ms;
            Ok::<_, DomainError>(ResolveTextConflictResult {
                conflict,
                write,
                delete: deletion,
            })
        })?;
        committed(outcome)
    }
}

#[doc(hidden)]
pub fn enqueue_write(
    tx: &Transaction<'_>,
    result: &WriteResult,
    preimage: Preimage,
    prefix: &str,
) -> Result<(), DomainError> {
    let sha = put_binary_blob(tx, result.snapshot.text.as_bytes())?;
    enqueue_job(
        tx,
        &MaterializationJobSpec {
            job_id: format!("{prefix}-mat_{}", result.moment.moment_id),
            target_path: result.snapshot.path.clone(),
            content_sha256: sha,
            preimage,
            target_generation: result.moment.moment_order,
            now_ms: result.moment.recorded_at_ms,
        },
    )?;
    Ok(())
}

#[doc(hidden)]
pub fn enqueue_delete(
    tx: &Transaction<'_>,
    result: &DeleteResult,
    prefix: &str,
) -> Result<(), DomainError> {
    let sha = put_binary_blob(tx, result.before.text.as_bytes())?;
    enqueue_delete_job(
        tx,
        &MaterializationJobSpec {
            job_id: format!("{prefix}-mat_{}", result.moment.moment_id),
            target_path: result.before.path.clone(),
            content_sha256: sha,
            preimage: Preimage::Present(result.before.blob_sha256.clone()),
            target_generation: result.moment.moment_order,
            now_ms: result.moment.recorded_at_ms,
        },
    )?;
    Ok(())
}

fn write_input(
    input: &ResolveTextConflict,
    version_id: &str,
    path: &str,
    text: &str,
    moment_id: &str,
) -> WriteText {
    WriteText {
        workspace_id: input.workspace_id.clone(),
        version_id: version_id.to_owned(),
        object_id: input.object_id.clone(),
        path: path.to_owned(),
        text: text.to_owned(),
        moment_id: moment_id.to_owned(),
        metadata_origin: input.metadata_origin.clone(),
        author_json: input.author_json.clone(),
        now_ms: input.now_ms,
        request_id: None,
    }
}

fn delete_input(input: &ResolveTextConflict, version_id: &str, path: &str) -> DeleteTextFile {
    DeleteTextFile {
        workspace_id: input.workspace_id.clone(),
        version_id: version_id.to_owned(),
        path: path.to_owned(),
        moment_id: input.delete_moment_id.clone(),
        metadata_origin: input.metadata_origin.clone(),
        author_json: input.author_json.clone(),
        now_ms: input.now_ms,
    }
}

fn validate_path_like_id(value: &str, reason: &'static str) -> Result<(), DomainError> {
    if value.is_empty() {
        Err(DomainError::InvalidInput { reason })
    } else {
        Ok(())
    }
}

fn committed<T>(outcome: TxnOutcome<T>) -> Result<T, DomainError> {
    match outcome {
        TxnOutcome::Committed(value) => Ok(value),
        TxnOutcome::Crashed { .. } => Err(DomainError::Storage(StorageError::persist_public(
            std::io::Error::other("conflict transaction crashed before acknowledgement"),
        ))),
    }
}

struct SideBindings<'a> {
    exists: i64,
    path: &'a str,
    object_id: Option<&'a str>,
    content_kind: &'static str,
    blob_sha256: Option<&'a str>,
    binary_sha256: Option<&'a str>,
    updated_at_ms: Option<i64>,
    latest_moment_id: Option<&'a str>,
    metadata_origin: Option<&'a str>,
    metadata_summary: Option<&'a str>,
    metadata_correlation_id: Option<&'a str>,
}

fn side_bindings(side: &ConflictFileState) -> SideBindings<'_> {
    SideBindings {
        exists: i64::from(side.snapshot.is_some() || side.binary_sha256.is_some()),
        path: &side.path,
        object_id: side
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.object_id.as_str()),
        content_kind: side.content_kind.as_str(),
        blob_sha256: side
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.blob_sha256.as_str()),
        binary_sha256: side.binary_sha256.as_deref(),
        updated_at_ms: side
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.updated_at_ms),
        latest_moment_id: side
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.latest_moment_id.as_str()),
        metadata_origin: side
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.metadata_origin.as_str()),
        metadata_summary: side.metadata_summary.as_deref(),
        metadata_correlation_id: side.metadata_correlation_id.as_deref(),
    }
}

fn list_conflicts(
    conn: &Connection,
    workspace_id: &str,
    status: Option<&str>,
) -> Result<Vec<TextConflict>, DomainError> {
    let mut sql = String::from(CONFLICT_SELECT);
    sql.push_str(" WHERE c.workspace_id = ?1");
    if status.is_some() {
        sql.push_str(" AND c.status = ?2");
    }
    sql.push_str(" ORDER BY c.created_at_ms, c.conflict_id");
    let mut stmt = conn.prepare(&sql).map_err(DomainError::sql_corrupt)?;
    let mut out = Vec::new();
    if let Some(status) = status {
        let rows = stmt
            .query_map(params![workspace_id, status], map_conflict_row)
            .map_err(DomainError::sql_corrupt)?;
        for row in rows {
            out.push(row.map_err(DomainError::sql_corrupt)??);
        }
    } else {
        let rows = stmt
            .query_map(params![workspace_id], map_conflict_row)
            .map_err(DomainError::sql_corrupt)?;
        for row in rows {
            out.push(row.map_err(DomainError::sql_corrupt)??);
        }
    }
    Ok(out)
}

#[doc(hidden)]
pub fn load_text_conflict_in_tx(
    conn: &Connection,
    workspace_id: &str,
    conflict_id: &str,
) -> Result<Option<TextConflict>, DomainError> {
    let sql = format!("{CONFLICT_SELECT} WHERE c.workspace_id = ?1 AND c.conflict_id = ?2");
    conn.query_row(&sql, params![workspace_id, conflict_id], map_conflict_row)
        .optional()
        .map_err(DomainError::sql_corrupt)?
        .transpose()
}

const CONFLICT_SELECT: &str = "SELECT c.*,
    base_blob.text AS base_text,
    current_blob.text AS current_text,
    incoming_blob.text AS incoming_text
    FROM conflicts c
    LEFT JOIN blobs base_blob ON base_blob.sha256 = c.base_blob_sha256
    LEFT JOIN blobs current_blob ON current_blob.sha256 = c.current_blob_sha256
    LEFT JOIN blobs incoming_blob ON incoming_blob.sha256 = c.incoming_blob_sha256";

fn map_conflict_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<TextConflict, DomainError>> {
    let workspace_id: String = row.get("workspace_id")?;
    let target_version_id: String = row.get("target_version_id")?;
    let source_version_id: String = row.get("source_version_id")?;
    Ok((|| {
        let resolution_raw: Option<String> =
            row.get("resolution").map_err(DomainError::sql_corrupt)?;
        Ok(TextConflict {
            conflict_id: row.get("conflict_id").map_err(DomainError::sql_corrupt)?,
            workspace_id: workspace_id.clone(),
            path: row.get("path").map_err(DomainError::sql_corrupt)?,
            target_version_id: target_version_id.clone(),
            source_version_id: source_version_id.clone(),
            created_at_ms: row_ms(row, "created_at_ms")?,
            updated_at_ms: row_ms(row, "updated_at_ms")?,
            status: ConflictStatus::parse(
                &row.get::<_, String>("status")
                    .map_err(DomainError::sql_corrupt)?,
            )?,
            chosen_from: ConflictChoice::parse(
                &row.get::<_, String>("chosen_from")
                    .map_err(DomainError::sql_corrupt)?,
            )?,
            resolution: resolution_raw
                .as_deref()
                .map(ConflictResolution::parse)
                .transpose()?,
            metadata: ConflictMetadata {
                origin: row
                    .get("metadata_origin")
                    .map_err(DomainError::sql_corrupt)?,
                summary: row
                    .get("metadata_summary")
                    .map_err(DomainError::sql_corrupt)?,
                correlation_id: row
                    .get("metadata_correlation_id")
                    .map_err(DomainError::sql_corrupt)?,
            },
            base: map_side(row, "base", &workspace_id, &source_version_id)?,
            current: map_side(row, "current", &workspace_id, &target_version_id)?,
            incoming: map_side(row, "incoming", &workspace_id, &source_version_id)?,
        })
    })())
}

fn map_side(
    row: &rusqlite::Row<'_>,
    prefix: &str,
    workspace_id: &str,
    version_id: &str,
) -> Result<ConflictFileState, DomainError> {
    let column = |suffix: &str| format!("{prefix}_{suffix}");
    let path: String = row
        .get(column("path").as_str())
        .map_err(DomainError::sql_corrupt)?;
    let exists: i64 = row
        .get(column("exists").as_str())
        .map_err(DomainError::sql_corrupt)?;
    let content_kind_raw: Option<String> = row
        .get(column("content_kind").as_str())
        .map_err(DomainError::sql_corrupt)?;
    let content_kind = ConflictContentKind::parse(content_kind_raw.as_deref().unwrap_or("text"))?;
    let text_blob_sha256: Option<String> = row
        .get(column("blob_sha256").as_str())
        .map_err(DomainError::sql_corrupt)?;
    let binary_sha256: Option<String> = row
        .get(column("binary_sha256").as_str())
        .map_err(DomainError::sql_corrupt)?;
    let snapshot = match content_kind {
        ConflictContentKind::Text if exists == 0 => {
            if binary_sha256.is_some() {
                return Err(DomainError::StateCorrupt {
                    reason: "text conflict side references a binary blob",
                });
            }
            None
        }
        ConflictContentKind::Text => {
            if binary_sha256.is_some() {
                return Err(DomainError::StateCorrupt {
                    reason: "text conflict side references a binary blob",
                });
            }
            Some(TextSnapshot {
                workspace_id: workspace_id.to_owned(),
                version_id: version_id.to_owned(),
                object_id: row
                    .get(column("object_id").as_str())
                    .map_err(DomainError::sql_corrupt)?,
                path: path.clone(),
                text: row
                    .get(format!("{prefix}_text").as_str())
                    .map_err(DomainError::sql_corrupt)?,
                blob_sha256: text_blob_sha256.ok_or(DomainError::StateCorrupt {
                    reason: "text conflict side is missing its blob reference",
                })?,
                updated_at_ms: row_ms(row, column("updated_at_ms").as_str())?,
                latest_moment_id: row
                    .get(column("latest_moment_id").as_str())
                    .map_err(DomainError::sql_corrupt)?,
                metadata_origin: row
                    .get(column("metadata_origin").as_str())
                    .map_err(DomainError::sql_corrupt)?,
            })
        }
        ConflictContentKind::Binary => {
            if text_blob_sha256.is_some() {
                return Err(DomainError::StateCorrupt {
                    reason: "binary conflict side references a text blob",
                });
            }
            if exists == 0 && binary_sha256.is_some() {
                return Err(DomainError::StateCorrupt {
                    reason: "absent binary conflict side references a blob",
                });
            }
            if exists != 0 && binary_sha256.is_none() {
                return Err(DomainError::StateCorrupt {
                    reason: "binary conflict side is missing its blob reference",
                });
            }
            None
        }
    };
    Ok(ConflictFileState {
        path,
        snapshot,
        binary_sha256,
        content_kind,
        metadata_summary: row
            .get(column("metadata_summary").as_str())
            .map_err(DomainError::sql_corrupt)?,
        metadata_correlation_id: row
            .get(column("metadata_correlation_id").as_str())
            .map_err(DomainError::sql_corrupt)?,
    })
}

/// Hydrate replicated binary conflict bytes only when their claimed content
/// address matches. Conflict rows can then safely reference the verified blob.
pub fn hydrate_binary_conflict_blob(
    conn: &Connection,
    claimed_sha256: &str,
    bytes: &[u8],
) -> Result<String, DomainError> {
    put_binary_blob_verified(conn, claimed_sha256, bytes).map_err(DomainError::from)
}

fn row_ms(row: &rusqlite::Row<'_>, column: &str) -> Result<i64, DomainError> {
    row.get::<_, i64>(column).map_err(DomainError::sql_corrupt)
}

fn binary_conflicts_unsupported() -> DomainError {
    DomainError::InvalidInput {
        reason: "binary conflict sides are not supported yet",
    }
}

#[doc(hidden)]
pub fn select_text_snapshot_by_path_in_tx(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<TextSnapshot>, DomainError> {
    conn.query_row(
        "SELECT s.object_id, s.path, b.text, s.blob_sha256, s.updated_at_ms,
         s.latest_moment_id, s.metadata_origin FROM snapshots s
         JOIN blobs b ON b.sha256 = s.blob_sha256
         WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.path = ?3",
        params![workspace_id, version_id, path],
        |row| {
            Ok(TextSnapshot {
                workspace_id: workspace_id.to_owned(),
                version_id: version_id.to_owned(),
                object_id: row.get(0)?,
                path: row.get(1)?,
                text: row.get(2)?,
                blob_sha256: row.get(3)?,
                updated_at_ms: row.get(4)?,
                latest_moment_id: row.get(5)?,
                metadata_origin: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256};
    use dohc_engine_testkit::ScratchDir;

    const WORKSPACE_ID: &str = "binary-conflict-tests";

    fn open_store() -> (ScratchDir, EngineStore) {
        let scratch = ScratchDir::new().expect("scratch directory");
        let path = scratch.engine_db_path().expect("database path");
        let mut store = EngineStore::open(&path, 1).expect("open engine store");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO versioned_workspaces (workspace_id, main_version_id)
                     VALUES (?1, 'main')",
                    [WORKSPACE_ID],
                )
                .map_err(DomainError::sql_persist)?;
                Ok::<_, DomainError>(())
            })
            .expect("seed workspace");
        (scratch, store)
    }

    fn conflict(
        conflict_id: &str,
        base: ConflictFileState,
        current: ConflictFileState,
        incoming: ConflictFileState,
    ) -> TextConflict {
        TextConflict {
            conflict_id: conflict_id.to_owned(),
            workspace_id: WORKSPACE_ID.to_owned(),
            path: current.path.clone(),
            target_version_id: "main".to_owned(),
            source_version_id: "feature".to_owned(),
            created_at_ms: 10,
            updated_at_ms: 11,
            status: ConflictStatus::Open,
            chosen_from: ConflictChoice::Current,
            resolution: None,
            metadata: ConflictMetadata::origin("sync"),
            base,
            current,
            incoming,
        }
    }

    fn text_snapshot(path: &str, text: &str) -> TextSnapshot {
        TextSnapshot {
            workspace_id: WORKSPACE_ID.to_owned(),
            version_id: "main".to_owned(),
            object_id: "object-1".to_owned(),
            path: path.to_owned(),
            text: text.to_owned(),
            blob_sha256: hex_sha256(text.as_bytes()),
            updated_at_ms: 9,
            latest_moment_id: "moment-1".to_owned(),
            metadata_origin: "user".to_owned(),
        }
    }

    #[test]
    fn binary_conflict_sides_round_trip() {
        let (_scratch, mut store) = open_store();
        let base_bytes = b"binary base";
        let current_bytes = b"binary current";
        let incoming_bytes = b"binary incoming";
        let base_sha = hex_sha256(base_bytes);
        let current_sha = hex_sha256(current_bytes);
        let incoming_sha = hex_sha256(incoming_bytes);
        let expected = conflict(
            "both-binary",
            ConflictFileState::binary("asset.bin", base_sha.clone()),
            ConflictFileState::binary("asset.bin", current_sha.clone()),
            ConflictFileState::binary("asset.bin", incoming_sha.clone()),
        );

        let outcome = store
            .write_with(&NoFaults, |tx| {
                hydrate_binary_conflict_blob(tx, &base_sha, base_bytes)?;
                hydrate_binary_conflict_blob(tx, &current_sha, current_bytes)?;
                hydrate_binary_conflict_blob(tx, &incoming_sha, incoming_bytes)?;
                insert_text_conflict_if_absent(tx, &expected)
            })
            .expect("insert binary conflict");
        assert_eq!(outcome, TxnOutcome::Committed(true));

        let loaded = store
            .read_with(|conn| load_text_conflict_in_tx(conn, WORKSPACE_ID, "both-binary"))
            .expect("load binary conflict")
            .expect("binary conflict row");
        assert_eq!(loaded, expected);

        let persisted: (String, String, String, String, String, String) = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT base_content_kind, base_binary_sha256,
                            current_content_kind, current_binary_sha256,
                            incoming_content_kind, incoming_binary_sha256
                     FROM conflicts WHERE workspace_id = ?1 AND conflict_id = 'both-binary'",
                    [WORKSPACE_ID],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
            })
            .expect("read persisted binary bindings");
        assert_eq!(
            persisted,
            (
                "binary".to_owned(),
                base_sha,
                "binary".to_owned(),
                current_sha,
                "binary".to_owned(),
                incoming_sha,
            )
        );
    }

    #[test]
    fn mixed_text_and_binary_conflict_sides_round_trip() {
        let (_scratch, mut store) = open_store();
        let incoming_bytes = b"incoming binary";
        let incoming_sha = hex_sha256(incoming_bytes);
        let expected = conflict(
            "mixed",
            ConflictFileState::text("mixed.dat", None),
            ConflictFileState::text(
                "mixed.dat",
                Some(text_snapshot("mixed.dat", "current text")),
            ),
            ConflictFileState::binary("mixed.dat", incoming_sha.clone()),
        );

        let outcome = store
            .write_with(&NoFaults, |tx| {
                hydrate_binary_conflict_blob(tx, &incoming_sha, incoming_bytes)?;
                insert_text_conflict_if_absent(tx, &expected)
            })
            .expect("insert mixed conflict");
        assert_eq!(outcome, TxnOutcome::Committed(true));

        let loaded = store
            .read_with(|conn| load_text_conflict_in_tx(conn, WORKSPACE_ID, "mixed"))
            .expect("load mixed conflict")
            .expect("mixed conflict row");
        assert_eq!(loaded, expected);
        assert!(loaded.current.binary_sha256.is_none());
        assert!(loaded.incoming.snapshot.is_none());
    }

    #[test]
    fn missing_binary_blob_is_rejected_before_conflict_insert() {
        let (_scratch, mut store) = open_store();
        let missing_sha = hex_sha256(b"not hydrated");
        let expected = conflict(
            "missing-binary",
            ConflictFileState::text("missing.bin", None),
            ConflictFileState::text("missing.bin", None),
            ConflictFileState::binary("missing.bin", missing_sha),
        );

        let error = store
            .write_with(&NoFaults, |tx| {
                insert_text_conflict_if_absent(tx, &expected)
            })
            .expect_err("missing binary blob must fail closed");
        assert_eq!(error.code(), "invalid-input");

        let count: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM conflicts WHERE workspace_id = ?1",
                    [WORKSPACE_ID],
                    |row| row.get(0),
                )
            })
            .expect("conflict count");
        assert_eq!(count, 0);
    }
}
