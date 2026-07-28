//! [`VersionedTextStore`]: the versioning domain over the CAL-1 storage core.
//!
//! It borrows the actor's single [`EngineStore`] and composes its versioning
//! SQL through the storage seams — reads via [`EngineStore::read_with`], every
//! compound mutation via [`EngineStore::write_with`] so the domain write, its
//! replication-journal entry, and any idempotency-ledger row commit in ONE
//! transaction (plan §Storage and recovery model; PORTING.md §9). Storage owns
//! the connection, open ritual, transaction boundary, and the crash-injection
//! fault seam; the domain owns what a version/moment/fork/restore *means*.
//!
//! Validation (existence, name conflicts, duplicate moment ids) runs as reads
//! BEFORE `BEGIN IMMEDIATE`. That is sound here precisely because of the
//! single-writer invariant the runtime enforces (one writer thread per store):
//! no concurrent writer can invalidate a check between the read and the
//! transaction (`STATE_OWNERSHIP.tsv` `sqlite-conn-versioned-text`).

use crate::conflicts::{
    WriteBinaryFile, binary_delete_job_id, binary_rename_delete_job_id, binary_rename_write_job_id,
    write_binary_file_in_tx,
};
use crate::error::DomainError;
use crate::records::{
    BinaryBlobRead, BinaryHead, BinaryHeadMeta, BinaryWriteResult, CaptureIngest,
    CaptureIngestBinary, CaptureIngestBinaryResult, CaptureRetire, CaptureRetireResult,
    CreateNamedVersion, DeleteResult, DeleteTextFile, FileObjectRecord, InbandBinary, InbandText,
    ListMomentsQuery, MomentOp, MomentPage, MomentRecord, RenameResult, RenameTextFile,
    RollbackTextFileMutation, SnapshotContent, SnapshotMetadata, SnapshotRecord, SnapshotView,
    TextSnapshot, VersionKind, VersionRecord, WriteBinary, WriteResult, WriteText,
};
use dohc_engine_storage::{
    EngineStore, FaultInjector, MaterializationJobSpec, Preimage, StorageError, TxnOutcome,
    enqueue_delete_job, enqueue_job, put_binary_blob,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// Maximum text-file size accepted by [`VersionedTextStore::write_text`], in
/// UTF-8 bytes. Mirrors the TS engine's 10 MB text cap
/// (`versions-write-text-file`).
pub const MAX_TEXT_BYTES: usize = 10 * 1024 * 1024;

/// The in-band content cap every capped read binds into its SQL and every
/// RPC references — ONE definition, so the query guard and the wire
/// contract can never drift apart.
pub const INBAND_CONTENT_CAP_BYTES: usize = 48 * 1024;

// The moment-hydration SQL embeds the cap as a literal (prepare_cached
// wants a static string); this assertion pins the literal to the
// constant so they cannot drift.
const _: () = assert!(INBAND_CONTENT_CAP_BYTES == 49152);

/// The versioning domain bound to one workspace store. Cheap to construct per
/// call; holds only a mutable borrow of the writer.
pub struct VersionedTextStore<'a> {
    pub(crate) store: &'a mut EngineStore,
}

impl<'a> VersionedTextStore<'a> {
    /// Bind the domain to a storage writer.
    pub fn new(store: &'a mut EngineStore) -> Self {
        VersionedTextStore { store }
    }

    // ----------------------------------------------------------------- bootstrap

    /// Ensure the workspace's `main` version exists, returning it. Idempotent:
    /// a repeat call returns the existing main version (`ensureWorkspaceRow`
    /// posture — `versions-ensure-main-version`).
    pub fn ensure_main_version(
        &mut self,
        workspace_id: &str,
        main_version_id: &str,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<VersionRecord, DomainError> {
        non_empty(workspace_id, "workspace_id")?;
        non_empty(main_version_id, "version_id")?;

        if let Some(existing_main) = self
            .store
            .read_with(|conn| workspace_main_version_id(conn, workspace_id))?
        {
            return self.require_version(workspace_id, &existing_main);
        }

        let ws = workspace_id.to_owned();
        let ver = main_version_id.to_owned();
        let outcome = self.store.write_with(faults, |tx| {
            tx.execute(
                "INSERT INTO versioned_workspaces (workspace_id, main_version_id) VALUES (?1, ?2)",
                params![ws, ver],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "INSERT INTO versions \
                 (workspace_id, version_id, kind, name, created_at_ms, fork_version_id, fork_moment_id) \
                 VALUES (?1, ?2, 'main', 'main', ?3, NULL, NULL)",
                params![ws, ver, now_ms],
            )
            .map_err(DomainError::sql_persist)?;
            Ok::<_, DomainError>(VersionRecord {
                workspace_id: ws.clone(),
                version_id: ver.clone(),
                kind: VersionKind::Main,
                name: "main".to_owned(),
                created_at_ms: now_ms,
                fork_version_id: None,
                fork_moment_id: None,
            })
        })?;
        committed(outcome)
    }

    /// Return the workspace's main version without bootstrapping it. A workspace
    /// with no `versioned_workspaces` row returns `None`
    /// (`versions-get-main-version`).
    pub fn get_main_version(
        &self,
        workspace_id: &str,
    ) -> Result<Option<VersionRecord>, DomainError> {
        non_empty(workspace_id, "workspace_id")?;
        self.store.read_with(|conn| {
            let row = conn
                .query_row(
                    "SELECT v.workspace_id, v.version_id, v.kind, v.name, v.created_at_ms, \
                     v.fork_version_id, v.fork_moment_id FROM versioned_workspaces w \
                     JOIN versions v ON v.workspace_id = w.workspace_id \
                       AND v.version_id = w.main_version_id WHERE w.workspace_id = ?1",
                    params![workspace_id],
                    map_version_row,
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            row.transpose()
        })
    }

    // --------------------------------------------------------------------- writes

    /// Write text to `path` in `version`. Creates the object + a `write` moment
    /// on first write to the path, else updates the object in place with a new
    /// moment (`versions-write-text-file`). A caller-supplied `moment_id`
    /// duplicate in the workspace is rejected. When `request_id` is set the
    /// write is exactly-once (a committed retry replays to the recorded result).
    pub fn write_text(
        &mut self,
        input: &WriteText,
        faults: &dyn FaultInjector,
    ) -> Result<WriteResult, DomainError> {
        // RESERVED ORIGIN, enforced at the PUBLIC door. This is the method
        // the RPC surface calls; capture's own primitive reaches
        // `write_text_in_tx` directly, so the reservation cannot be forged
        // from outside while capture keeps writing its own origin. Without
        // it a caller could mark DB-only content capture-owned and have the
        // next disk-driven pass retire it.
        reject_reserved_capture_origin(&input.metadata_origin)?;
        let outcome = self
            .store
            .write_with(faults, |tx| write_text_in_tx(tx, input))?;
        committed(outcome)
    }

    /// Write a binary head and enqueue its materialization intent in the same
    /// transaction. Equal binary content is an idempotent no-op.
    pub fn write_binary(
        &mut self,
        input: &WriteBinary,
        faults: &dyn FaultInjector,
    ) -> Result<BinaryWriteResult, DomainError> {
        let outcome = self
            .store
            .write_with(faults, |tx| write_binary_in_tx(tx, input))?;
        committed(outcome)
    }

    /// Capture a text file without caller-supplied object or moment ids.
    ///
    /// Every capture id hashes fields framed as `u64-LE byte length || bytes`,
    /// so embedded delimiter bytes cannot make distinct inputs collide. New
    /// paths first derive `object-<sha256(workspace_id, version_id, path)>`. An
    /// existing row with that id is reused only when it has no live alias in
    /// the workspace (retire/recreate continuity). If it is still live at
    /// another path, capture mints a disambiguated object id by also framing
    /// the next monotonic moment order. Write and retire moments both derive
    /// `moment-<sha256(workspace_id, object_id, next_moment_order)>`.
    pub fn capture_ingest(
        &mut self,
        input: &CaptureIngest,
        faults: &dyn FaultInjector,
    ) -> Result<WriteResult, DomainError> {
        let outcome = self
            .store
            .write_with(faults, |tx| capture_ingest_in_tx(tx, input))?;
        committed(outcome)
    }

    /// Autonomous BINARY capture ingest: same derived-id scheme and
    /// idempotency posture as [`VersionedTextStore::capture_ingest`], but the
    /// content persists as a BINHEAD binary head (moment + snapshot with
    /// `content_kind = 'binary'`) and NO materialization job is enqueued —
    /// the bytes came FROM disk, matching the TS oracle, which never writes
    /// disk on capture. Content-equality (same `binary_sha256` head) is a
    /// deduped no-op.
    pub fn capture_ingest_binary(
        &mut self,
        input: &CaptureIngestBinary,
        faults: &dyn FaultInjector,
    ) -> Result<CaptureIngestBinaryResult, DomainError> {
        let outcome = self
            .store
            .write_with(faults, |tx| capture_ingest_binary_in_tx(tx, input))?;
        committed(outcome)
    }

    /// Retire a captured path, returning an absent result when it is untracked.
    pub fn capture_retire(
        &mut self,
        input: &CaptureRetire,
        faults: &dyn FaultInjector,
    ) -> Result<CaptureRetireResult, DomainError> {
        let outcome = self
            .store
            .write_with(faults, |tx| capture_retire_in_tx(tx, input))?;
        committed(outcome)
    }

    /// Delete a materialized text file from one version, preserving other
    /// versions of the same object and appending a `delete` moment
    /// (`versions-delete-text-file`).
    pub fn delete_text_file(
        &mut self,
        input: &DeleteTextFile,
        faults: &dyn FaultInjector,
    ) -> Result<DeleteResult, DomainError> {
        let outcome = self
            .store
            .write_with(faults, |tx| delete_text_in_tx(tx, input))?;
        committed(outcome)
    }

    /// Move a text file's version-local alias without changing its object or
    /// content, appending a `rename` moment (`versions-rename-text-file`).
    pub fn rename_text_file(
        &mut self,
        input: &RenameTextFile,
        faults: &dyn FaultInjector,
    ) -> Result<RenameResult, DomainError> {
        self.rename_text_file_with(input, faults, |_, _| Ok(()))
    }

    /// Rename with a caller-supplied same-transaction side effect (the runtime
    /// uses this for FTS maintenance).
    pub fn rename_text_file_with<F>(
        &mut self,
        input: &RenameTextFile,
        faults: &dyn FaultInjector,
        after: F,
    ) -> Result<RenameResult, DomainError>
    where
        F: FnOnce(&Transaction<'_>, &RenameResult) -> Result<(), DomainError>,
    {
        non_empty(&input.workspace_id, "workspace_id")?;
        non_empty(&input.version_id, "version_id")?;
        validate_moment_id(&input.moment_id)?;
        let mut normalized_input = input.clone();
        normalized_input.from_path = validate_addressable_plaintext_path(&input.from_path)?;
        normalized_input.to_path = validate_plaintext_storable_path(&input.to_path)?;
        let input = &normalized_input;
        if input.from_path == input.to_path {
            return Err(DomainError::InvalidPath {
                reason: "rename source and destination must differ",
            });
        }

        let (author_kind, author_json) = hash_author_fields(input.author_json.as_deref());
        let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary.as_deref());
        let (correlation_kind, correlation_id) =
            hash_optional_text_fields(input.metadata_correlation_id.as_deref());
        let payload_hash = hash_fields(&[
            input.workspace_id.as_bytes(),
            input.version_id.as_bytes(),
            input.from_path.as_bytes(),
            input.to_path.as_bytes(),
            input.moment_id.as_bytes(),
            input.metadata_origin.as_bytes(),
            summary_kind,
            summary,
            correlation_kind,
            correlation_id,
            author_kind,
            author_json,
        ]);

        let ws = &input.workspace_id;
        if let Some(request_id) = &input.request_id
            && let Some(recorded) = self
                .store
                .read_with(|conn| lookup_request(conn, request_id))?
        {
            if recorded.payload_hash != payload_hash {
                return Err(DomainError::IdempotencyKeyReuseMismatch);
            }
            return self.store.read_with(|conn| reconstruct_rename(conn, input));
        }
        let (object, before) = self.store.read_with(|conn| {
            if !version_exists(conn, ws, &input.version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            let object_id = alias_object_id(conn, ws, &input.version_id, &input.from_path)?
                .ok_or(DomainError::FileNotFound)?;
            let before = get_snapshot(conn, ws, &input.version_id, &object_id)?
                .ok_or(DomainError::FileNotFound)?;
            if let Some(target_object_id) =
                alias_object_id(conn, ws, &input.version_id, &input.to_path)?
                && target_object_id != object_id
            {
                return Err(DomainError::TargetPathExists);
            }
            if moment_exists(conn, ws, &input.moment_id)? {
                return Err(DomainError::DuplicateMomentId);
            }
            let object =
                get_file_object(conn, ws, &object_id)?.ok_or(DomainError::StateCorrupt {
                    reason: "snapshot points at a missing object",
                })?;
            Ok((object, before))
        })?;

        let after_snapshot = SnapshotRecord {
            workspace_id: ws.clone(),
            version_id: input.version_id.clone(),
            object_id: before.object_id.clone(),
            path: input.to_path.clone(),
            text: before.text.clone(),
            blob_sha256: before.blob_sha256.clone(),
            content_kind: before.content_kind.clone(),
            binary_sha256: before.binary_sha256.clone(),
            updated_at_ms: input.now_ms,
            latest_moment_id: input.moment_id.clone(),
            metadata_origin: input.metadata_origin.clone(),
            metadata_summary: input.metadata_summary.clone(),
            metadata_correlation_id: input.metadata_correlation_id.clone(),
        };
        let outcome = self.store.write_with(faults, |tx| {
            let moment_order = next_moment_order(tx)?;
            tx.execute(
                "INSERT INTO moments \
                 (workspace_id, moment_order, moment_id, version_id, object_id, path, \
                  recorded_at_ms, operation, after_blob_sha256, before_present, \
                  before_blob_sha256, before_latest_moment_id, metadata_origin, \
                  metadata_summary, metadata_correlation_id, author_json, \
                  sync_record_only, after_content_kind, after_binary_sha256, \
                  before_content_kind, before_binary_sha256, \
                  payload_before_path, payload_before_content_kind, \
                  payload_before_blob_sha256, \
                  payload_after_path, payload_after_content_kind, \
                  payload_after_blob_sha256) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'rename', ?8, 2, ?8, ?9, ?10, \
                         ?11, ?12, ?13, NULL, ?14, ?15, ?14, ?15, ?16, ?14, \
                         CASE ?14 WHEN 'binary' THEN ?15 ELSE ?8 END, ?6, ?14, \
                         CASE ?14 WHEN 'binary' THEN ?15 ELSE ?8 END)",
                params![
                    ws,
                    moment_order,
                    input.moment_id,
                    input.version_id,
                    before.object_id,
                    input.to_path,
                    input.now_ms,
                    before.blob_sha256,
                    before.latest_moment_id,
                    input.metadata_origin,
                    input.metadata_summary,
                    input.metadata_correlation_id,
                    input.author_json,
                    before.content_kind,
                    before.binary_sha256,
                    // The payload a rename carries moved FROM here; the row's
                    // own path is where it landed.
                    input.from_path,
                ],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "INSERT INTO replication_journal (doc_id, op_kind, created_at_ms) \
                 VALUES (?1, 'moment.append', ?2)",
                params![before.object_id, input.now_ms],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "DELETE FROM path_aliases WHERE workspace_id = ?1 AND version_id = ?2 \
                 AND path = ?3 AND object_id = ?4",
                params![ws, input.version_id, input.from_path, before.object_id],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id, version_id, path, object_id) \
                 VALUES (?1, ?2, ?3, ?4) ON CONFLICT(workspace_id, version_id, path) \
                 DO UPDATE SET object_id = excluded.object_id",
                params![ws, input.version_id, input.to_path, before.object_id],
            )
            .map_err(DomainError::sql_persist)?;
            upsert_snapshot(tx, &after_snapshot)?;

            let result = RenameResult {
                object: object.clone(),
                before: snapshot_text_view(&before),
                after: snapshot_text_view(&after_snapshot),
                moment: get_moment(tx, ws, &input.moment_id)?.ok_or(DomainError::StateCorrupt {
                    reason: "moment vanished within its own write transaction",
                })?,
                deduped: false,
            };
            after(tx, &result)?;
            record_request(
                tx,
                input.request_id.as_deref(),
                &payload_hash,
                moment_order,
                input.now_ms,
            )?;
            Ok::<_, DomainError>(result)
        })?;
        committed(outcome)
    }

    /// Remove one latest local mutation and restore its recorded preimage.
    /// This is local-only history surgery and deliberately does not journal a
    /// replication operation (`versions-rollback-text-file-mutation`).
    pub fn rollback_text_file_mutation(
        &mut self,
        input: &RollbackTextFileMutation,
        faults: &dyn FaultInjector,
    ) -> Result<bool, DomainError> {
        self.rollback_text_file_mutation_with(input, faults, |_, _, _| Ok(()))
    }

    /// Roll back with a caller-supplied same-transaction side effect. The
    /// callback receives the mutated object id and the restored text head, if
    /// the rollback restores text (binary/absent restores pass `None`).
    pub fn rollback_text_file_mutation_with<F>(
        &mut self,
        input: &RollbackTextFileMutation,
        faults: &dyn FaultInjector,
        after: F,
    ) -> Result<bool, DomainError>
    where
        F: FnOnce(&Transaction<'_>, &str, Option<(&str, &str)>) -> Result<(), DomainError>,
    {
        non_empty(&input.workspace_id, "workspace_id")?;
        non_empty(&input.version_id, "version_id")?;
        non_empty(&input.mutation_moment_id, "moment_id")?;
        let mut normalized_input = input.clone();
        normalized_input.path = validate_addressable_plaintext_path(&input.path)?;
        let input = &normalized_input;

        let (author_kind, author_json) = hash_author_fields(input.author_json.as_deref());
        // legacy_before_text determines the restored snapshot when the moment
        // carries no stored preimage — a different legacy text is a different
        // rollback, never a replay.
        let (legacy_kind, legacy_text): (&[u8], &[u8]) = match &input.legacy_before_text {
            Some(text) => (b"some", text.as_bytes()),
            None => (b"none", b""),
        };
        let payload_hash = hash_fields(&[
            input.workspace_id.as_bytes(),
            input.version_id.as_bytes(),
            input.path.as_bytes(),
            input.mutation_moment_id.as_bytes(),
            legacy_kind,
            legacy_text,
            input.metadata_origin.as_bytes(),
            author_kind,
            author_json,
        ]);

        let ws = &input.workspace_id;
        if let Some(request_id) = &input.request_id
            && let Some(recorded) = self
                .store
                .read_with(|conn| lookup_request(conn, request_id))?
        {
            if recorded.payload_hash != payload_hash {
                return Err(DomainError::IdempotencyKeyReuseMismatch);
            }
            return Ok(true);
        }
        let prep = self.store.read_with(|conn| {
            if !version_exists(conn, ws, &input.version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            let moment = get_moment(conn, ws, &input.mutation_moment_id)?
                .filter(|m| m.version_id == input.version_id && m.path == input.path)
                .ok_or(DomainError::FileNotFound)?;
            if moment.sync_record_only {
                return Err(DomainError::InvalidInput {
                    reason: "sync record-only moments cannot be rolled back",
                });
            }

            let before_state = moment_before_state(conn, ws, &input.mutation_moment_id)?;
            let before = resolve_rollback_before(conn, input, &moment, before_state)?;
            if let Some(before) = &before {
                if before.version_id != input.version_id
                    || before.object_id != moment.object_id
                    || (before.path != input.path && moment.operation != MomentOp::Rename)
                {
                    return Err(DomainError::InvalidInput {
                        reason: "rollback snapshot does not match the target file",
                    });
                }
            }
            if later_materialized_object_moment_exists(conn, ws, &moment)? {
                return Err(DomainError::InvalidInput {
                    reason: "mutation moment is not the latest mutation for the object",
                });
            }
            if rollback_moment_has_dependents(conn, ws, &moment)? {
                return Err(DomainError::InvalidInput {
                    reason: "mutation moment has dependent versions",
                });
            }
            if let Some(before) = &before
                && let Some(target_object_id) =
                    alias_object_id(conn, ws, &input.version_id, &before.path)?
                && target_object_id != before.object_id
            {
                return Err(DomainError::TargetPathExists);
            }
            Ok(RollbackPrep { moment, before })
        })?;

        let outcome = self.store.write_with(faults, |tx| {
            // A rollback restore is a new disk intent even though history
            // surgery removes (rather than appends) a moment. Reserve the same
            // store-global now-generation a fresh mutation would receive while
            // the rolled-back moment is still present. Reusing that moment's
            // historical generation lets any later completed job for the same
            // path supersede the compensator before it can restore disk.
            let restore_generation = next_moment_order(tx)?;
            tx.execute(
                "DELETE FROM moments WHERE workspace_id = ?1 AND moment_id = ?2",
                params![ws, input.mutation_moment_id],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "DELETE FROM engine_requests WHERE result_seq = ?1 AND kind IN ('versioned', 'merge')",
                params![prep.moment.moment_order],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "DELETE FROM path_aliases WHERE workspace_id = ?1 AND version_id = ?2 \
                 AND path = ?3 AND object_id = ?4",
                params![ws, input.version_id, input.path, prep.moment.object_id],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "DELETE FROM snapshots WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                params![ws, input.version_id, prep.moment.object_id],
            )
            .map_err(DomainError::sql_persist)?;
            // Cancel every pending disk intent produced by the moment being
            // removed. This is deliberately NOT active-version-gated: a job was
            // enqueued while this version was active and can otherwise replay
            // after another version becomes active. Match the moment generation,
            // path, and content so a malformed same-id row is never swept.
            let merge_sha = match prep.moment.operation {
                MomentOp::Write if prep.moment.after_content_kind == "text" => {
                    prep.moment.after_blob_sha256.as_deref()
                }
                MomentOp::Delete if prep.moment.before_content_kind == "text" => {
                    prep.moment.before_blob_sha256.as_deref()
                }
                MomentOp::Write | MomentOp::Delete | MomentOp::Rename => None,
            };
            if let Some(sha256) = merge_sha {
                cancel_pending_materialization(
                    tx,
                    &format!("merge-mat_{}", input.mutation_moment_id),
                    &prep.moment.path,
                    prep.moment.moment_order,
                    sha256,
                )?;
            }
            if prep.moment.operation == MomentOp::Delete
                && prep.moment.before_content_kind == "binary"
                && let Some(sha256) = prep.moment.before_binary_sha256.as_deref()
            {
                cancel_pending_materialization(
                    tx,
                    &binary_delete_job_id(input.mutation_moment_id.as_str()),
                    &prep.moment.path,
                    prep.moment.moment_order,
                    sha256,
                )?;
            }
            if prep.moment.operation == MomentOp::Rename
                && prep.moment.after_content_kind == "binary"
                && let Some(sha256) = prep.moment.after_binary_sha256.as_deref()
            {
                cancel_pending_materialization(
                    tx,
                    &binary_rename_write_job_id(input.mutation_moment_id.as_str()),
                    &prep.moment.path,
                    prep.moment.moment_order,
                    sha256,
                )?;
                if let Some(before) = &prep.before {
                    cancel_pending_materialization(
                        tx,
                        &binary_rename_delete_job_id(input.mutation_moment_id.as_str()),
                        &before.path,
                        prep.moment.moment_order,
                        sha256,
                    )?;
                }
            }

            // A completed binary delete/rename already changed DISK, so
            // cancelling the original PENDING intent is insufficient. Commit
            // the inverse intent beside the restored DB head. These jobs are
            // durable even when the version is currently inactive; the
            // runtime executes them only while their restored state is active,
            // otherwise activation/open replay leaves them PENDING.
            if prep.moment.operation == MomentOp::Delete
                && prep.moment.before_content_kind == "binary"
            {
                let before = prep.before.as_ref().ok_or(DomainError::StateCorrupt {
                    reason: "binary delete rollback has no restored snapshot",
                })?;
                enqueue_binary_delete_rollback_restore(
                    tx,
                    input,
                    before,
                    restore_generation,
                    prep.moment.recorded_at_ms,
                )?;
            }
            if prep.moment.operation == MomentOp::Rename
                && prep.moment.after_content_kind == "binary"
            {
                let before = prep.before.as_ref().ok_or(DomainError::StateCorrupt {
                    reason: "binary rename rollback has no restored snapshot",
                })?;
                enqueue_binary_rename_rollback_restore(
                    tx,
                    input,
                    before,
                    &prep.moment.path,
                    restore_generation,
                    prep.moment.recorded_at_ms,
                )?;
            }

            // Reconcile DISK with an active-version rolled-back binary WRITE:
            //   * a PENDING job does NOT prove disk is clean — the materializer
            //     can crash AFTER the atomic rename lands but BEFORE marking the
            //     job complete (`MaterializeAfterRenameBeforeComplete`), leaving
            //     the written bytes ON DISK with a still-pending job. So always
            //     enqueue the compensating restore (delete for a first write, else
            //     the previous content); it is a harmless preimage-guarded no-op
            //     if the bytes never actually reached disk.
            //   * additionally cancel a still-pending original job so it can never
            //     race the compensator and re-materialize the rolled-back bytes.
            if prep.moment.operation == MomentOp::Write
                && prep.moment.after_content_kind == "binary"
                && let Some(written_moment_sha) = prep.moment.after_binary_sha256.as_deref()
            {
                let active = version_is_active(tx, ws, &input.version_id)?;
                let job: Option<(String, i64, String, String, String)> = tx
                    .query_row(
                        "SELECT status, target_generation, content_sha256, target_path, operation \
                         FROM materialization_jobs WHERE job_id = ?1",
                        params![input.mutation_moment_id],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(DomainError::sql_corrupt)?;
                match job {
                    // Only cancel/compensate against a job whose content is
                    // exactly this write's bytes — never an unrelated
                    // same-id job.
                    Some((status, generation, written_sha256, target_path, operation))
                        if generation == prep.moment.moment_order
                            && written_sha256.as_str() == written_moment_sha
                            && target_path == prep.moment.path
                            && operation == "write" =>
                    {
                        if active {
                            enqueue_binary_rollback_restore(
                                tx,
                                input,
                                &prep.before,
                                restore_generation,
                                &written_sha256,
                                prep.moment.recorded_at_ms,
                            )?;
                        }
                        if status == "pending" {
                            tx.execute(
                                "DELETE FROM materialization_jobs WHERE job_id = ?1",
                                params![input.mutation_moment_id],
                            )
                            .map_err(DomainError::sql_persist)?;
                        }
                    }
                    Some(_) => {}
                    // No job at all: a CAPTURE-origin binary write (its bytes
                    // came FROM disk, so nothing was ever enqueued). The
                    // rolled-back head still must be reconciled TO disk —
                    // without a restore, disk keeps the newer bytes while the
                    // reconcile manifest records them as already captured, so
                    // the DB head would silently diverge forever. Restore
                    // against the write's own generation (the same peer rule
                    // BINHEAD uses for its compensators).
                    None if active => {
                        enqueue_binary_rollback_restore(
                            tx,
                            input,
                            &prep.before,
                            restore_generation,
                            written_moment_sha,
                            prep.moment.recorded_at_ms,
                        )?;
                    }
                    None => {}
                }
            }

            if let Some(before) = &prep.before {
                if before.content_kind == "text" {
                    let blob_sha256 = before.blob_sha256.as_ref().ok_or(
                        DomainError::StateCorrupt {
                            reason: "text rollback snapshot has no text blob",
                        },
                    )?;
                    tx.execute(
                        "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
                        params![blob_sha256, before.text.len() as i64, before.text],
                    )
                    .map_err(DomainError::sql_persist)?;
                }
                tx.execute(
                    "INSERT INTO path_aliases (workspace_id, version_id, path, object_id) \
                     VALUES (?1, ?2, ?3, ?4) ON CONFLICT(workspace_id, version_id, path) \
                     DO UPDATE SET object_id = excluded.object_id",
                    params![ws, input.version_id, before.path, before.object_id],
                )
                .map_err(DomainError::sql_persist)?;
                upsert_snapshot(tx, before)?;
            }

            if !object_has_references(tx, ws, &prep.moment.object_id)? {
                tx.execute(
                    "DELETE FROM file_objects WHERE workspace_id = ?1 AND object_id = ?2",
                    params![ws, prep.moment.object_id],
                )
                .map_err(DomainError::sql_persist)?;
            }
            let restored_text = prep.before.as_ref().and_then(|before| {
                (before.content_kind == "text").then_some((before.path.as_str(), before.text.as_str()))
            });
            after(tx, &prep.moment.object_id, restored_text)?;
            record_request(
                tx,
                input.request_id.as_deref(),
                &payload_hash,
                0,
                prep.moment.recorded_at_ms,
            )?;
            Ok::<_, DomainError>(false)
        })?;
        committed(outcome)
    }

    // -------------------------------------------------------------------- reads

    /// Resolve the stable object currently bound to a version-local path.
    pub fn object_id_for_path(
        &self,
        workspace_id: &str,
        version_id: &str,
        path: &str,
    ) -> Result<Option<String>, DomainError> {
        let path = validate_addressable_plaintext_path(path)?;
        self.store.read_with(|conn| {
            if !version_exists(conn, workspace_id, version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            alias_object_id(conn, workspace_id, version_id, &path)
        })
    }

    /// Read the current text snapshot for `path` in `version`, or `None`. Fails
    /// closed (`VersionNotFound`) on an unknown version so a bad version never
    /// looks like a missing file (`versions-read-text-file` contract).
    ///
    /// FAIL-CLOSED ON BINARY: a live binary head at `path` is NOT text, so this
    /// text-only surface returns [`DomainError::BinaryHeadNotText`] rather than
    /// projecting it as an empty [`TextSnapshot`]. Serving a binary head as a
    /// blank text document would invite a silent overwrite and hide the real
    /// content. `Ok(None)` still means genuinely absent; `Ok(Some(_))` is always
    /// a real text head.
    pub fn read_text(
        &self,
        workspace_id: &str,
        version_id: &str,
        path: &str,
    ) -> Result<Option<TextSnapshot>, DomainError> {
        let path = validate_addressable_plaintext_path(path)?;
        self.store.read_with(|conn| {
            if !version_exists(conn, workspace_id, version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            let Some(object_id) = alias_object_id(conn, workspace_id, version_id, &path)? else {
                return Ok(None);
            };
            let Some(snapshot) = get_snapshot(conn, workspace_id, version_id, &object_id)? else {
                return Ok(None);
            };
            if snapshot.content_kind == "binary" {
                return Err(DomainError::BinaryHeadNotText);
            }
            Ok(Some(snapshot_text_view(&snapshot)))
        })
    }

    /// Read the BINARY head at `path`: the stored sha plus the blob bytes.
    /// `Ok(None)` when the path has no head; a TEXT head is refused the same
    /// way a binary head is refused by [`Self::read_text`] — the caller asked
    /// the wrong question, and silently returning empty bytes would hide it.
    pub fn read_binary(
        &self,
        workspace_id: &str,
        version_id: &str,
        path: &str,
    ) -> Result<Option<BinaryHead>, DomainError> {
        let path = validate_addressable_plaintext_path(path)?;
        self.store.read_with(|conn| {
            if !version_exists(conn, workspace_id, version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            let Some(object_id) = alias_object_id(conn, workspace_id, version_id, &path)? else {
                return Ok(None);
            };
            let Some(snapshot) = get_snapshot(conn, workspace_id, version_id, &object_id)? else {
                return Ok(None);
            };
            if snapshot.content_kind != "binary" {
                return Err(DomainError::TextHeadNotBinary);
            }
            let sha256 = snapshot.binary_sha256.ok_or(DomainError::StateCorrupt {
                reason: "binary head without a binary sha",
            })?;
            let bytes = dohc_engine_storage::get_binary_blob(conn, &sha256)
                .map_err(DomainError::from)?
                .ok_or(DomainError::StateCorrupt {
                    reason: "binary head references a missing blob",
                })?;
            Ok(Some(BinaryHead {
                object_id,
                sha256,
                bytes,
            }))
        })
    }

    /// Read a binary blob only when the caller's workspace has a durable head,
    /// moment, or conflict-side reference to it. An unreferenced digest is indistinguishable
    /// from an unknown digest so this content-addressed read is not an
    /// existence oracle across workspace boundaries.
    pub fn read_binary_blob(
        &self,
        workspace_id: &str,
        sha256: &str,
    ) -> Result<Option<BinaryBlobRead>, DomainError> {
        self.read_binary_blob_with_hydration(workspace_id, sha256, false)
    }

    /// Read a workspace-referenced blob with bytes hydrated even above the
    /// in-band cap. The framed daemon uses this only for bounded chunk egress;
    /// workspace reference checks remain identical to `read_binary_blob`.
    pub fn read_binary_blob_for_egress(
        &self,
        workspace_id: &str,
        sha256: &str,
    ) -> Result<Option<BinaryBlobRead>, DomainError> {
        self.read_binary_blob_with_hydration(workspace_id, sha256, true)
    }

    fn read_binary_blob_with_hydration(
        &self,
        workspace_id: &str,
        sha256: &str,
        hydrate_over_cap: bool,
    ) -> Result<Option<BinaryBlobRead>, DomainError> {
        non_empty(workspace_id, "workspace_id")?;
        self.store.read_with(|conn| {
            let referenced: bool = conn
                .query_row(
                    "SELECT EXISTS(\
                         SELECT 1 FROM snapshots \
                         WHERE workspace_id = ?1 AND binary_sha256 = ?2\
                     ) OR EXISTS(\
                         SELECT 1 FROM moments \
                         WHERE workspace_id = ?1 \
                           AND (after_binary_sha256 = ?2 OR before_binary_sha256 = ?2)\
                     ) OR EXISTS(\
                         SELECT 1 FROM conflicts \
                         WHERE workspace_id = ?1 \
                           AND (base_binary_sha256 = ?2 \
                                OR current_binary_sha256 = ?2 \
                                OR incoming_binary_sha256 = ?2)\
                     )",
                    params![workspace_id, sha256],
                    |row| row.get(0),
                )
                .map_err(DomainError::sql_corrupt)?;
            if !referenced {
                return Ok(None);
            }
            // Metadata first: an over-cap answer must not hydrate (and
            // re-verify) up to a 64 MiB blob just to discard the bytes.
            let lengths: Option<(i64, i64)> = conn
                .query_row(
                    "SELECT byte_length, LENGTH(bytes) FROM binary_blobs WHERE sha256 = ?1",
                    params![sha256],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            // The workspace holds a durable reference to this digest: a
            // missing blob row is store corruption, not an absent digest.
            let Some((byte_length, actual_length)) = lengths else {
                return Err(DomainError::StateCorrupt {
                    reason: "referenced binary blob is missing",
                });
            };
            if byte_length < 0 {
                return Err(DomainError::StateCorrupt {
                    reason: "binary blob has a negative recorded length",
                });
            }
            if byte_length != actual_length {
                return Err(DomainError::StateCorrupt {
                    reason: "binary blob length does not match its bytes",
                });
            }
            if byte_length as usize > INBAND_CONTENT_CAP_BYTES && !hydrate_over_cap {
                return Ok(Some(BinaryBlobRead {
                    byte_length,
                    bytes: None,
                }));
            }
            let bytes = dohc_engine_storage::get_binary_blob(conn, sha256)
                .map_err(DomainError::from)?
                .ok_or(DomainError::StateCorrupt {
                    reason: "referenced binary blob is missing",
                })?;
            Ok(Some(BinaryBlobRead {
                byte_length,
                bytes: Some(bytes),
            }))
        })
    }

    /// The binary head's METADATA — object id, sha, and the blob's byte
    /// length sized in SQL — without materializing a single content byte.
    /// The over-cap in-band answer needs exactly this, and loading a large
    /// blob just to discard it is a needless copy per request.
    ///
    /// DELIBERATELY NOT RE-HASHED: the sha IS the content address the blob
    /// was stored and verified under at write; re-hashing here would load
    /// the bytes and resurrect the hydration cost this read exists to
    /// avoid. Metadata reads report the recorded content address; every
    /// byte-SERVING path re-verifies before handing bytes out.
    pub fn read_binary_meta(
        &self,
        workspace_id: &str,
        version_id: &str,
        path: &str,
    ) -> Result<Option<BinaryHeadMeta>, DomainError> {
        let path = validate_addressable_plaintext_path(path)?;
        self.store.read_with(|conn| {
            if !version_exists(conn, workspace_id, version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            let Some(object_id) = alias_object_id(conn, workspace_id, version_id, &path)? else {
                return Ok(None);
            };
            let Some(snapshot) = get_snapshot(conn, workspace_id, version_id, &object_id)? else {
                return Ok(None);
            };
            if snapshot.content_kind != "binary" {
                return Err(DomainError::TextHeadNotBinary);
            }
            let sha256 = snapshot.binary_sha256.ok_or(DomainError::StateCorrupt {
                reason: "binary head without a binary sha",
            })?;
            // Fail closed like get_binary_blob does: the RECORDED length
            // must match the stored bytes, and the row must exist — for an
            // over-cap read this is the only storage access that runs, so
            // it carries the integrity check itself.
            let lengths: Option<(i64, i64)> = conn
                .query_row(
                    "SELECT byte_length, LENGTH(bytes) FROM binary_blobs WHERE sha256 = ?1",
                    [&sha256],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let Some((recorded, actual)) = lengths else {
                return Err(DomainError::StateCorrupt {
                    reason: "binary head references a missing blob",
                });
            };
            if recorded != actual {
                return Err(DomainError::StateCorrupt {
                    reason: "binary blob length does not match its bytes",
                });
            }
            let byte_length = recorded;
            Ok(Some(BinaryHeadMeta {
                object_id,
                sha256,
                byte_length,
            }))
        })
    }

    /// Read a text head with the body hydrated ONLY under `cap` bytes —
    /// the byte length always returns. One query, one actor turn: no
    /// window where a concurrent write can grow the body between a size
    /// probe and the load, and an over-cap body never leaves SQLite.
    pub fn read_text_inband(
        &self,
        workspace_id: &str,
        version_id: &str,
        path: &str,
        cap: usize,
    ) -> Result<Option<InbandText>, DomainError> {
        let path = validate_addressable_plaintext_path(path)?;
        self.store.read_with(|conn| {
            if !version_exists(conn, workspace_id, version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            let Some(object_id) = alias_object_id(conn, workspace_id, version_id, &path)? else {
                return Ok(None);
            };
            let Some(snapshot) = get_snapshot_meta(conn, workspace_id, version_id, &object_id)?
            else {
                return Ok(None);
            };
            if snapshot.content_kind == "binary" {
                let sha = snapshot.binary_sha256.ok_or(DomainError::StateCorrupt {
                    reason: "binary head without a binary sha",
                })?;
                let lengths: Option<(i64, i64)> = conn
                    .query_row(
                        "SELECT byte_length, LENGTH(bytes) FROM binary_blobs WHERE sha256 = ?1",
                        [&sha],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(DomainError::sql_corrupt)?;
                let Some((byte_length, actual_length)) = lengths else {
                    return Err(DomainError::StateCorrupt {
                        reason: "binary head references a missing blob",
                    });
                };
                if byte_length != actual_length {
                    return Err(DomainError::StateCorrupt {
                        reason: "binary blob length does not match its bytes",
                    });
                }
                return Ok(Some(InbandText {
                    workspace_id: workspace_id.to_owned(),
                    version_id: version_id.to_owned(),
                    object_id,
                    path,
                    content_kind: "binary".to_owned(),
                    text: Some(String::new()),
                    byte_length,
                    blob_sha256: sha,
                    updated_at_ms: snapshot.updated_at_ms,
                    latest_moment_id: snapshot.latest_moment_id,
                    metadata_origin: snapshot.metadata_origin,
                    metadata_summary: snapshot.metadata_summary,
                    metadata_correlation_id: snapshot.metadata_correlation_id,
                }));
            }
            if snapshot.content_kind != "text" {
                return Err(DomainError::StateCorrupt {
                    reason: "snapshot has an unknown content kind",
                });
            }
            let sha = snapshot.blob_sha256.ok_or(DomainError::StateCorrupt {
                reason: "text head without a text blob",
            })?;
            let row: Option<(i64, i64, Option<String>)> = conn
                .query_row(
                    "SELECT byte_length, LENGTH(CAST(text AS BLOB)), \
                     CASE WHEN byte_length <= ?2 AND LENGTH(CAST(text AS BLOB)) <= ?2 THEN text END \
                     FROM blobs WHERE sha256 = ?1",
                    rusqlite::params![sha, cap as i64],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let Some((byte_length, actual_length, text)) = row else {
                return Err(DomainError::StateCorrupt {
                    reason: "text head references a missing blob",
                });
            };
            if byte_length != actual_length {
                return Err(DomainError::StateCorrupt {
                    reason: "text blob length does not match its text",
                });
            }
            Ok(Some(InbandText {
                workspace_id: workspace_id.to_owned(),
                version_id: version_id.to_owned(),
                object_id,
                path,
                content_kind: "text".to_owned(),
                text,
                byte_length,
                blob_sha256: sha,
                updated_at_ms: snapshot.updated_at_ms,
                latest_moment_id: snapshot.latest_moment_id,
                metadata_origin: snapshot.metadata_origin,
                metadata_summary: snapshot.metadata_summary,
                metadata_correlation_id: snapshot.metadata_correlation_id,
            }))
        })
    }

    /// Read a binary head with the bytes hydrated ONLY under `cap` — the
    /// recorded byte length (integrity-checked against the stored bytes)
    /// always returns. One query, one actor turn, same rationale as
    /// [`Self::read_text_inband`].
    pub fn read_binary_inband(
        &self,
        workspace_id: &str,
        version_id: &str,
        path: &str,
        cap: usize,
    ) -> Result<Option<InbandBinary>, DomainError> {
        let path = validate_addressable_plaintext_path(path)?;
        self.store.read_with(|conn| {
            if !version_exists(conn, workspace_id, version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            let Some(object_id) = alias_object_id(conn, workspace_id, version_id, &path)? else {
                return Ok(None);
            };
            let Some(snapshot) = get_snapshot_meta(conn, workspace_id, version_id, &object_id)?
            else {
                return Ok(None);
            };
            if snapshot.content_kind != "binary" {
                return Err(DomainError::TextHeadNotBinary);
            }
            let sha256 = snapshot.binary_sha256.ok_or(DomainError::StateCorrupt {
                reason: "binary head without a binary sha",
            })?;
            // BOTH guards in the hydration CASE: a corrupt row whose
            // recorded length lies small must not smuggle big bytes into
            // memory before the integrity check rejects it.
            let row: Option<(i64, i64, Option<Vec<u8>>)> = conn
                .query_row(
                    "SELECT byte_length, LENGTH(bytes), \
                     CASE WHEN byte_length <= ?2 AND LENGTH(bytes) <= ?2 THEN bytes END \
                     FROM binary_blobs WHERE sha256 = ?1",
                    rusqlite::params![sha256, cap as i64],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let Some((recorded, actual, bytes)) = row else {
                return Err(DomainError::StateCorrupt {
                    reason: "binary head references a missing blob",
                });
            };
            if recorded != actual {
                return Err(DomainError::StateCorrupt {
                    reason: "binary blob length does not match its bytes",
                });
            }
            // Bytes that will be SERVED are re-hashed (get_binary_blob
            // parity): bit-rot or tampering that preserves the length must
            // fail closed, never ship under the original content address.
            // Under-cap only — hashing <=48 KiB is trivial.
            if let Some(bytes) = &bytes {
                let mut hasher = Sha256::new();
                hasher.update(bytes);
                if hex(&hasher.finalize()) != sha256 {
                    return Err(DomainError::StateCorrupt {
                        reason: "binary blob bytes do not match their content address",
                    });
                }
            }
            Ok(Some(InbandBinary {
                object_id,
                sha256,
                byte_length: recorded,
                bytes,
            }))
        })
    }

    /// Read `path` in the workspace's currently-active version.
    pub fn read_text_active(
        &self,
        workspace_id: &str,
        path: &str,
    ) -> Result<Option<TextSnapshot>, DomainError> {
        let active = self.get_active_version(workspace_id)?;
        self.read_text(workspace_id, &active.version_id, path)
    }

    /// List every version in the workspace, ordered by
    /// `(created_at_ms, name, version_id)` (`versions-list-versions`).
    pub fn list_versions(&self, workspace_id: &str) -> Result<Vec<VersionRecord>, DomainError> {
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT workspace_id, version_id, kind, name, created_at_ms, \
                     fork_version_id, fork_moment_id FROM versions WHERE workspace_id = ?1 \
                     ORDER BY created_at_ms, name, version_id",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(params![workspace_id], map_version_row)
                .map_err(DomainError::sql_corrupt)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(DomainError::sql_corrupt)??);
            }
            Ok(out)
        })
    }

    /// A keyset page of moments, newest first, with a `limit + 1` probe cursor
    /// (`versions-list-moments`). Filters on version and/or object; a version
    /// filter that names an unknown version fails closed (`VersionNotFound`).
    pub fn list_moments(&self, query: &ListMomentsQuery) -> Result<MomentPage, DomainError> {
        if query.limit <= 0 {
            return Err(DomainError::InvalidInput {
                reason: "limit must be positive",
            });
        }
        self.store.read_with(|conn| {
            if let Some(version_id) = &query.version_id
                && !version_exists(conn, &query.workspace_id, version_id)?
            {
                return Err(DomainError::VersionNotFound);
            }

            // latest_moment_order under the same filter, ignoring the cursor.
            let latest = latest_moment_order(conn, query)?;

            // Probe limit+1 to detect a following page.
            let probe = query.limit.saturating_add(1);
            let mut sql = String::from(
                "SELECT moment_order, moment_id, version_id, object_id, path, recorded_at_ms, \
                 operation, after_blob_sha256, before_present, before_blob_sha256, \
                 before_latest_moment_id, metadata_origin, metadata_summary, \
                 metadata_correlation_id, author_json, sync_record_only, \
                 COALESCE(after_content_kind, 'text'), after_binary.sha256, \
                 COALESCE(before_content_kind, 'text'), before_binary.sha256, \n             CASE WHEN after_text_blob.byte_length <= 131072 AND LENGTH(CAST(after_text_blob.text AS BLOB)) <= 131072 THEN after_text_blob.text END, \n             COALESCE(after_text_blob.byte_length, after_binary.byte_length), \n             CASE WHEN before_text_blob.byte_length <= 131072 AND LENGTH(CAST(before_text_blob.text AS BLOB)) <= 131072 THEN before_text_blob.text END, \n             COALESCE(before_text_blob.byte_length, before_binary.byte_length), \
             COALESCE(LENGTH(CAST(after_text_blob.text AS BLOB)), LENGTH(after_binary.bytes)), \
             COALESCE(LENGTH(CAST(before_text_blob.text AS BLOB)), LENGTH(before_binary.bytes)), \
             m.payload_before_path \
                 FROM moments m \
                 LEFT JOIN binary_blobs after_binary ON after_binary.sha256 = m.after_binary_sha256 \
                 LEFT JOIN binary_blobs before_binary ON before_binary.sha256 = m.before_binary_sha256 \n             LEFT JOIN blobs after_text_blob ON after_text_blob.sha256 = m.after_blob_sha256 \n             LEFT JOIN blobs before_text_blob ON before_text_blob.sha256 = m.before_blob_sha256 \
                 WHERE workspace_id = ?1",
            );
            let mut binds: Vec<Box<dyn rusqlite::ToSql>> =
                vec![Box::new(query.workspace_id.clone())];
            if let Some(version_id) = &query.version_id {
                sql.push_str(" AND version_id = ?");
                sql.push_str(&(binds.len() + 1).to_string());
                binds.push(Box::new(version_id.clone()));
            }
            if let Some(object_id) = &query.object_id {
                sql.push_str(" AND object_id = ?");
                sql.push_str(&(binds.len() + 1).to_string());
                binds.push(Box::new(object_id.clone()));
            }
            if let Some(before) = query.before_moment_order {
                sql.push_str(" AND moment_order < ?");
                sql.push_str(&(binds.len() + 1).to_string());
                binds.push(Box::new(before));
            }
            sql.push_str(" ORDER BY moment_order DESC LIMIT ?");
            sql.push_str(&(binds.len() + 1).to_string());
            binds.push(Box::new(probe));

            let mut stmt = conn.prepare(&sql).map_err(DomainError::sql_corrupt)?;
            let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
            let rows = stmt
                .query_map(bind_refs.as_slice(), map_moment_row)
                .map_err(DomainError::sql_corrupt)?;
            let mut moments = Vec::new();
            for row in rows {
                moments.push(row.map_err(DomainError::sql_corrupt)??);
            }

            let next_before_moment_order = if moments.len() as i64 > query.limit {
                moments.truncate(query.limit as usize);
                moments.last().map(|m| m.moment_order)
            } else {
                None
            };
            Ok(MomentPage {
                moments,
                next_before_moment_order,
                latest_moment_order: latest,
            })
        })
    }

    /// List every snapshot in `version`, ordered by path.
    pub fn list_snapshots(
        &self,
        workspace_id: &str,
        version_id: &str,
    ) -> Result<Vec<SnapshotView>, DomainError> {
        self.list_snapshot_records(workspace_id, version_id)?
            .iter()
            .map(snapshot_view)
            .collect()
    }

    /// One PAGE of snapshot metadata in `version`, ordered by path, with NO
    /// body hydration — `LENGTH(CAST(text AS BLOB))` sizes a text head in
    /// bytes without copying it out of the row. Keyset: strictly after
    /// `after_path` (None = from the start).
    pub fn list_snapshot_metadata(
        &self,
        workspace_id: &str,
        version_id: &str,
        after_path: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SnapshotMetadata>, DomainError> {
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT s.object_id, s.path, \
                     CASE COALESCE(s.content_kind, 'text') \
                       WHEN 'binary' THEN bb.sha256 ELSE s.blob_sha256 END, \
                     CASE COALESCE(s.content_kind, 'text') \
                       WHEN 'binary' THEN bb.byte_length \
                       ELSE LENGTH(CAST(b.text AS BLOB)) END, \
                     s.updated_at_ms, s.latest_moment_id, s.metadata_origin, \
                     s.metadata_summary, s.metadata_correlation_id, \
                     COALESCE(s.content_kind, 'text'), bb.sha256 FROM snapshots s \
                     LEFT JOIN blobs b ON b.sha256 = s.blob_sha256 \
                     LEFT JOIN binary_blobs bb ON bb.sha256 = s.binary_sha256 \
                     WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.path > ?3 \
                     ORDER BY s.path LIMIT ?4",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    rusqlite::params![
                        workspace_id,
                        version_id,
                        after_path.unwrap_or(""),
                        limit as i64
                    ],
                    |row| {
                        Ok(SnapshotMetadata {
                            object_id: row.get(0)?,
                            path: row.get(1)?,
                            sha256: row.get(2)?,
                            byte_length: row.get(3)?,
                            updated_at_ms: row.get(4)?,
                            latest_moment_id: row.get(5)?,
                            metadata_origin: row.get(6)?,
                            metadata_summary: row.get(7)?,
                            metadata_correlation_id: row.get(8)?,
                            content_kind: row.get(9)?,
                            binary_sha256: row.get(10)?,
                        })
                    },
                )
                .map_err(DomainError::sql_corrupt)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(DomainError::sql_corrupt)?;
            // The LEFT JOINs exist to classify kind — never to launder a
            // broken FK into nulls: a text head must have sized text, a
            // binary head its sha (get_snapshot raises the same invariant).
            for row in &rows {
                let sound = match row.content_kind.as_str() {
                    "text" => true,
                    "binary" => row.binary_sha256.is_some(),
                    _ => false,
                };
                if !sound {
                    return Err(DomainError::StateCorrupt {
                        reason: "snapshot references a missing blob row",
                    });
                }
            }
            Ok(rows)
        })
    }

    /// Durable snapshot records for `version`, ordered by path.
    pub(crate) fn list_snapshot_records(
        &self,
        workspace_id: &str,
        version_id: &str,
    ) -> Result<Vec<SnapshotRecord>, DomainError> {
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT s.object_id, s.path, b.text, s.blob_sha256, s.updated_at_ms, \
                     s.latest_moment_id, s.metadata_origin, s.metadata_summary, \
                     s.metadata_correlation_id, COALESCE(s.content_kind, 'text'), \
                     bb.sha256 FROM snapshots s \
                     LEFT JOIN blobs b ON b.sha256 = s.blob_sha256 \
                     LEFT JOIN binary_blobs bb ON bb.sha256 = s.binary_sha256 \
                     WHERE s.workspace_id = ?1 AND s.version_id = ?2 ORDER BY s.path",
                )
                .map_err(DomainError::sql_corrupt)?;
            let ws = workspace_id.to_owned();
            let ver = version_id.to_owned();
            let rows = stmt
                .query_map(params![workspace_id, version_id], move |row| {
                    map_snapshot_row(row, &ws, &ver)
                })
                .map_err(DomainError::sql_corrupt)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(DomainError::sql_corrupt)??);
            }
            Ok(out)
        })
    }

    /// List the durable fork-base snapshots frozen for `version` at fork time,
    /// ordered by path. The fork base is the three-way-merge anchor a later
    /// compare/merge shard builds on; exposing it lets the differential harness
    /// catch a wrong/leaked/missing base.
    pub fn list_fork_base_snapshots(
        &self,
        workspace_id: &str,
        version_id: &str,
    ) -> Result<Vec<SnapshotView>, DomainError> {
        self.list_fork_base_records(workspace_id, version_id)?
            .iter()
            .map(snapshot_view)
            .collect()
    }

    /// Content-aware fork-base records for `version` (see
    /// [`Self::list_snapshot_records`]).
    pub(crate) fn list_fork_base_records(
        &self,
        workspace_id: &str,
        version_id: &str,
    ) -> Result<Vec<SnapshotRecord>, DomainError> {
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT f.object_id, f.path, b.text, f.blob_sha256, f.updated_at_ms, \
                     f.latest_moment_id, f.metadata_origin, f.metadata_summary, \
                     f.metadata_correlation_id, COALESCE(f.content_kind, 'text'), \
                     bb.sha256 FROM fork_base_snapshots f \
                     LEFT JOIN blobs b ON b.sha256 = f.blob_sha256 \
                     LEFT JOIN binary_blobs bb ON bb.sha256 = f.binary_sha256 \
                     WHERE f.workspace_id = ?1 AND f.version_id = ?2 ORDER BY f.path",
                )
                .map_err(DomainError::sql_corrupt)?;
            let ws = workspace_id.to_owned();
            let ver = version_id.to_owned();
            let rows = stmt
                .query_map(params![workspace_id, version_id], move |row| {
                    map_snapshot_row(row, &ws, &ver)
                })
                .map_err(DomainError::sql_corrupt)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(DomainError::sql_corrupt)??);
            }
            Ok(out)
        })
    }

    /// Fetch a single moment by id, or `None`.
    pub fn get_moment(
        &self,
        workspace_id: &str,
        moment_id: &str,
    ) -> Result<Option<MomentRecord>, DomainError> {
        self.store
            .read_with(|conn| get_moment(conn, workspace_id, moment_id))
    }

    /// The workspace's active version, resolving a missing `active_versions` row
    /// to the main version (`versions-get-active-version`). Fails closed if
    /// neither resolves.
    pub fn get_active_version(&self, workspace_id: &str) -> Result<VersionRecord, DomainError> {
        self.store.read_with(|conn| {
            let active_id: Option<String> = conn
                .query_row(
                    "SELECT version_id FROM active_versions WHERE workspace_id = ?1",
                    params![workspace_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let version_id = match active_id {
                Some(id) if version_exists(conn, workspace_id, &id)? => id,
                _ => workspace_main_version_id(conn, workspace_id)?
                    .ok_or(DomainError::WorkspaceNotFound)?,
            };
            get_version(conn, workspace_id, &version_id)?.ok_or(DomainError::StateCorrupt {
                reason: "active version row resolves to no version",
            })
        })
    }

    // -------------------------------------------------------------- named version

    /// Validate a named-version request without mutating the store.
    ///
    /// Returns the existing version for an exact idempotent replay. Callers
    /// that perform expensive or destructive preparation before the fork use
    /// this as a preflight, then call [`Self::create_named_version`] afterward
    /// so the same checks run again at the mutation boundary.
    pub fn preflight_create_named_version(
        &self,
        input: &CreateNamedVersion,
    ) -> Result<Option<VersionRecord>, DomainError> {
        non_empty(&input.workspace_id, "workspace_id")?;
        non_empty(&input.new_version_id, "version_id")?;
        non_empty(&input.from_version_id, "version_id")?;
        if input.name.is_empty() || input.name.trim() != input.name {
            return Err(DomainError::InvalidVersionName);
        }

        let payload_hash = hash_fields(&[
            input.new_version_id.as_bytes(),
            input.name.as_bytes(),
            input.from_version_id.as_bytes(),
        ]);
        let ws = &input.workspace_id;
        self.store.read_with(|conn| {
            if !version_exists(conn, ws, &input.from_version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            if let Some(request_id) = &input.request_id
                && let Some(recorded) = lookup_request(conn, request_id)?
            {
                if recorded.payload_hash != payload_hash {
                    return Err(DomainError::IdempotencyKeyReuseMismatch);
                }
                return get_version(conn, ws, &input.new_version_id)?
                    .map(Some)
                    .ok_or(DomainError::StateCorrupt {
                        reason: "version request ledger resolves to no version",
                    });
            }
            if name_taken(conn, ws, &input.name)? {
                return Err(DomainError::VersionNameConflict);
            }
            if version_exists(conn, ws, &input.new_version_id)? {
                return Err(DomainError::DuplicateId);
            }
            Ok(None)
        })
    }

    /// Fork a new named version from `from_version_id`, copying its snapshots
    /// and path aliases and recording durable `fork_base_snapshots`
    /// (`versions-create-named-version`). Journals a `version.create` op. The
    /// fork point is the latest NON-`sync_record_only` moment, so a peer
    /// divergence marker can never become the fork point (`PORTING.md` §1).
    pub fn create_named_version(
        &mut self,
        input: &CreateNamedVersion,
        faults: &dyn FaultInjector,
    ) -> Result<VersionRecord, DomainError> {
        self.create_named_version_with(input, faults, |_, _| Ok(()))
    }

    /// Fork a named version with a caller-supplied same-transaction side effect.
    pub fn create_named_version_with<F>(
        &mut self,
        input: &CreateNamedVersion,
        faults: &dyn FaultInjector,
        after: F,
    ) -> Result<VersionRecord, DomainError>
    where
        F: FnOnce(&Transaction<'_>, &VersionRecord) -> Result<(), DomainError>,
    {
        non_empty(&input.workspace_id, "workspace_id")?;
        non_empty(&input.new_version_id, "version_id")?;
        non_empty(&input.from_version_id, "version_id")?;
        if input.name.is_empty() || input.name.trim() != input.name {
            return Err(DomainError::InvalidVersionName);
        }

        let payload_hash = hash_fields(&[
            input.new_version_id.as_bytes(),
            input.name.as_bytes(),
            input.from_version_id.as_bytes(),
        ]);

        let ws = &input.workspace_id;
        let prep = self.store.read_with(|conn| {
            if !version_exists(conn, ws, &input.from_version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            if let Some(request_id) = &input.request_id
                && let Some(recorded) = lookup_request(conn, request_id)?
            {
                if recorded.payload_hash != payload_hash {
                    return Err(DomainError::IdempotencyKeyReuseMismatch);
                }
                return Ok(ForkPrep::Deduped);
            }
            if name_taken(conn, ws, &input.name)? {
                return Err(DomainError::VersionNameConflict);
            }
            if version_exists(conn, ws, &input.new_version_id)? {
                return Err(DomainError::DuplicateId);
            }
            let fork_moment_id = latest_materialized_moment_id(conn, ws, &input.from_version_id)?;
            Ok(ForkPrep::Apply { fork_moment_id })
        })?;

        let fork_moment_id = match prep {
            ForkPrep::Deduped => {
                return self.require_version(ws, &input.new_version_id);
            }
            ForkPrep::Apply { fork_moment_id } => fork_moment_id,
        };

        let record = VersionRecord {
            workspace_id: ws.clone(),
            version_id: input.new_version_id.clone(),
            kind: VersionKind::Named,
            name: input.name.clone(),
            created_at_ms: input.now_ms,
            fork_version_id: Some(input.from_version_id.clone()),
            fork_moment_id: fork_moment_id.clone(),
        };

        let outcome = self.store.write_with(faults, |tx| {
            tx.execute(
                "INSERT INTO versions \
                 (workspace_id, version_id, kind, name, created_at_ms, fork_version_id, fork_moment_id) \
                 VALUES (?1, ?2, 'named', ?3, ?4, ?5, ?6)",
                params![
                    ws,
                    input.new_version_id,
                    input.name,
                    input.now_ms,
                    input.from_version_id,
                    fork_moment_id,
                ],
            )
            .map_err(DomainError::sql_persist)?;
            // Copy the fork point's aliases and snapshots into the new version,
            // and freeze a durable fork-base snapshot for later three-way compare.
            tx.execute(
                "INSERT INTO path_aliases (workspace_id, version_id, path, object_id) \
                 SELECT workspace_id, ?2, path, object_id FROM path_aliases \
                 WHERE workspace_id = ?1 AND version_id = ?3",
                params![ws, input.new_version_id, input.from_version_id],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "INSERT INTO snapshots \
                  (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, \
                   latest_moment_id, metadata_origin, metadata_summary, \
                   metadata_correlation_id, content_kind, binary_sha256) \
                  SELECT workspace_id, ?2, object_id, path, blob_sha256, updated_at_ms, \
                   latest_moment_id, metadata_origin, metadata_summary, \
                   metadata_correlation_id, content_kind, binary_sha256 FROM snapshots \
                 WHERE workspace_id = ?1 AND version_id = ?3",
                params![ws, input.new_version_id, input.from_version_id],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "INSERT INTO fork_base_snapshots \
                  (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, \
                   latest_moment_id, metadata_origin, metadata_summary, \
                   metadata_correlation_id, content_kind, binary_sha256) \
                  SELECT workspace_id, ?2, object_id, path, blob_sha256, updated_at_ms, \
                   latest_moment_id, metadata_origin, metadata_summary, \
                   metadata_correlation_id, content_kind, binary_sha256 FROM snapshots \
                 WHERE workspace_id = ?1 AND version_id = ?3",
                params![ws, input.new_version_id, input.from_version_id],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "INSERT INTO replication_journal (doc_id, op_kind, created_at_ms) \
                 VALUES (?1, 'version.create', ?2)",
                params![input.new_version_id, input.now_ms],
            )
            .map_err(DomainError::sql_persist)?;
            crate::secrets::fork_version_in_tx(
                tx,
                ws,
                &input.from_version_id,
                &input.new_version_id,
                input.now_ms,
            )?;
            record_request(tx, input.request_id.as_deref(), &payload_hash, 0, input.now_ms)?;
            after(tx, &record)?;
            Ok::<_, DomainError>(record.clone())
        })?;
        committed(outcome)
    }

    // ---------------------------------------------------------------- restore

    /// Set the workspace's active version (the restore primitive). Both the
    /// restored version and the previously-active one keep all their rows — the
    /// conflict invariant that restore preserves both sides (`versions-set-active-version`).
    /// Not journaled.
    pub fn set_active_version(
        &mut self,
        workspace_id: &str,
        version_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<VersionRecord, DomainError> {
        let record = self.require_version(workspace_id, version_id)?;
        let ws = workspace_id.to_owned();
        let ver = version_id.to_owned();
        let outcome = self.store.write_with(faults, |tx| {
            tx.execute(
                "INSERT INTO active_versions (workspace_id, version_id) VALUES (?1, ?2) \
                 ON CONFLICT(workspace_id) DO UPDATE SET version_id = excluded.version_id",
                params![ws, ver],
            )
            .map_err(DomainError::sql_persist)?;
            Ok::<_, DomainError>(())
        })?;
        committed(outcome)?;
        Ok(record)
    }

    // ------------------------------------------------------------- differential

    /// A deterministic, normalized snapshot of the workspace's version graph,
    /// moment order, active version, and per-version snapshots (blob hashes) —
    /// the comparison surface for the differential harness (`TEST_ORACLE.md` §2).
    pub fn normalized_snapshot(
        &self,
        workspace_id: &str,
    ) -> Result<crate::normalize::NormalizedState, DomainError> {
        crate::normalize::capture(self, workspace_id)
    }

    // --------------------------------------------------------------- internals

    fn require_version(
        &self,
        workspace_id: &str,
        version_id: &str,
    ) -> Result<VersionRecord, DomainError> {
        self.store
            .read_with(|conn| get_version(conn, workspace_id, version_id))?
            .ok_or(DomainError::VersionNotFound)
    }
}

struct RollbackPrep {
    moment: MomentRecord,
    before: Option<SnapshotRecord>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MomentBeforeState {
    LegacyUnset,
    Absent,
    Present,
}

impl MomentBeforeState {
    fn from_db(value: i64) -> Result<Self, DomainError> {
        match value {
            0 => Ok(MomentBeforeState::LegacyUnset),
            1 => Ok(MomentBeforeState::Absent),
            2 => Ok(MomentBeforeState::Present),
            _ => Err(DomainError::StateCorrupt {
                reason: "unknown moment before-present state",
            }),
        }
    }
}

/// Pre-transaction decision for a fork.
enum ForkPrep {
    Deduped,
    Apply { fork_moment_id: Option<String> },
}

/// A prior request recovered from the idempotency ledger.
pub(crate) struct RecordedRequest {
    pub(crate) payload_hash: String,
    pub(crate) result_seq: i64,
}

// ============================================================================
// Free helpers (SQL over a borrowed connection/transaction).
// ============================================================================

/// Validate a write and return the input with its path normalized through the
/// R07 plaintext-storable path floor (a secret/ignored path is rejected here).
/// Shared by direct writes and merge/resolve writes so plaintext never lands on
/// a protected path via any route.
fn normalized_write_input(input: &WriteText) -> Result<WriteText, DomainError> {
    non_empty(&input.workspace_id, "workspace_id")?;
    non_empty(&input.version_id, "version_id")?;
    validate_moment_id(&input.moment_id)?;
    let mut normalized = input.clone();
    normalized.path = validate_plaintext_storable_path(&input.path)?;
    validate_text(&normalized.text)?;
    Ok(normalized)
}

#[doc(hidden)]
pub fn validate_write_input(input: &WriteText) -> Result<(), DomainError> {
    reject_reserved_capture_origin(&input.metadata_origin)?;
    normalized_write_input(input).map(|_| ())
}

/// The shared reservation check for the capture-owned metadata origin.
fn reject_reserved_capture_origin(metadata_origin: &str) -> Result<(), DomainError> {
    if metadata_origin == CAPTURE_ORIGIN {
        return Err(DomainError::InvalidInput {
            reason: "metadata origin 'capture' is reserved for autonomous capture",
        });
    }
    Ok(())
}

/// Validate a delete and return the input with its path normalized through the
/// R07 addressable-plaintext floor (only an ignored path is rejected — an
/// existing tracked or secret-shadowed file is still deletable).
fn normalized_delete_input(input: &DeleteTextFile) -> Result<DeleteTextFile, DomainError> {
    non_empty(&input.workspace_id, "workspace_id")?;
    non_empty(&input.version_id, "version_id")?;
    validate_moment_id(&input.moment_id)?;
    let mut normalized = input.clone();
    normalized.path = validate_addressable_plaintext_path(&input.path)?;
    Ok(normalized)
}

#[doc(hidden)]
pub fn validate_delete_input(input: &DeleteTextFile) -> Result<(), DomainError> {
    normalized_delete_input(input).map(|_| ())
}

fn normalized_capture_ingest(input: &CaptureIngest) -> Result<CaptureIngest, DomainError> {
    non_empty(&input.workspace_id, "workspace_id")?;
    non_empty(&input.version_id, "version_id")?;
    let mut normalized = input.clone();
    normalized.path = validate_plaintext_storable_path(&input.path)?;
    validate_text(&normalized.text)?;
    Ok(normalized)
}

fn normalized_capture_retire(input: &CaptureRetire) -> Result<CaptureRetire, DomainError> {
    non_empty(&input.workspace_id, "workspace_id")?;
    non_empty(&input.version_id, "version_id")?;
    let mut normalized = input.clone();
    normalized.path = validate_addressable_plaintext_path(&input.path)?;
    Ok(normalized)
}

#[doc(hidden)]
pub fn capture_ingest_in_tx(
    tx: &Transaction<'_>,
    input: &CaptureIngest,
) -> Result<WriteResult, DomainError> {
    let input = normalized_capture_ingest(input)?;
    if !version_exists(tx, &input.workspace_id, &input.version_id)? {
        return Err(DomainError::VersionNotFound);
    }
    let (author_kind, author_json) = match input.author_json.as_deref() {
        Some(author_json) => (b"some".as_slice(), author_json.as_bytes()),
        None => (b"none".as_slice(), b"".as_slice()),
    };
    let payload_hash = hash_fields(&[
        b"capture-ingest",
        input.workspace_id.as_bytes(),
        input.version_id.as_bytes(),
        input.path.as_bytes(),
        input.text.as_bytes(),
        input.metadata_origin.as_bytes(),
        author_kind,
        author_json,
        if input.claim_foreign_head {
            b"claim-foreign".as_slice()
        } else {
            b"own-only".as_slice()
        },
    ]);
    if let Some(request_id) = &input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        return reconstruct_capture_write(tx, &input.workspace_id, recorded.result_seq);
    }

    let (object_id, reserved_moment_order) = resolve_capture_object(
        tx,
        &input.workspace_id,
        &input.version_id,
        &input.path,
        input.now_ms,
    )?;
    let before = get_snapshot(tx, &input.workspace_id, &input.version_id, &object_id)?;
    // OWNERSHIP: capture only overwrites heads written with ITS OWN origin.
    // A head that arrived by another route (RPC, replication) may have no
    // disk counterpart at all, so letting disk bytes overwrite it would
    // silently revert that write.
    if let Some(existing) = &before
        && existing.metadata_origin != input.metadata_origin
        && !input.claim_foreign_head
    {
        return Err(DomainError::CaptureNotOwned);
    }
    let content_sha256 = text_blob_sha256(&input.text);
    if let Some(before) = &before
        && before.content_kind == "text"
        && before.blob_sha256.as_deref() == Some(content_sha256.as_str())
    {
        // A CLAIMED dedupe transfers ownership: capture observed the disk
        // transition and the content already matches, so the head becomes
        // capture-owned. Without this the head would stay foreign forever
        // and later disk-driven retires would be refused.
        if input.claim_foreign_head && before.metadata_origin != input.metadata_origin {
            tx.execute(
                "UPDATE snapshots SET metadata_origin = ?1, \
                 metadata_summary = NULL, metadata_correlation_id = NULL \
                 WHERE workspace_id = ?2 AND version_id = ?3 AND object_id = ?4",
                params![
                    input.metadata_origin,
                    input.workspace_id,
                    input.version_id,
                    object_id
                ],
            )
            .map_err(DomainError::sql_persist)?;
        }
        let result = write_result_for_existing_head(tx, before)?;
        record_request(
            tx,
            input.request_id.as_deref(),
            &payload_hash,
            result.moment.moment_order,
            input.now_ms,
        )?;
        return Ok(result);
    }

    let next_order = match reserved_moment_order {
        Some(next_order) => next_order,
        None => next_moment_order(tx)?,
    };
    let moment_id = derive_capture_moment_id(&input.workspace_id, &object_id, next_order);
    let write = WriteText {
        workspace_id: input.workspace_id.clone(),
        version_id: input.version_id.clone(),
        object_id,
        path: input.path.clone(),
        text: input.text.clone(),
        moment_id,
        metadata_origin: input.metadata_origin.clone(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: input.author_json.clone(),
        now_ms: input.now_ms,
        request_id: None,
    };
    let result = write_text_in_tx(tx, &write)?;
    if result.moment.moment_order != next_order {
        return Err(DomainError::StateCorrupt {
            reason: "capture moment order diverged from reserved order",
        });
    }
    record_request(
        tx,
        input.request_id.as_deref(),
        &payload_hash,
        result.moment.moment_order,
        input.now_ms,
    )?;
    Ok(result)
}

#[doc(hidden)]
pub fn capture_retire_in_tx(
    tx: &Transaction<'_>,
    input: &CaptureRetire,
) -> Result<CaptureRetireResult, DomainError> {
    let input = normalized_capture_retire(input)?;
    if !version_exists(tx, &input.workspace_id, &input.version_id)? {
        return Err(DomainError::VersionNotFound);
    }
    // Frame extended (head-scope discriminator) pre-cutover while capture is
    // DORMANT: no store outside tests has recorded capture-retire requests
    // (the sink passes request_id: None), and R15 resets shadow data, so no
    // legacy-hash compatibility shim is owed.
    let payload_hash = hash_fields(&[
        b"capture-retire",
        input.workspace_id.as_bytes(),
        input.version_id.as_bytes(),
        input.path.as_bytes(),
        b"capture",
        b"none",
        b"",
        if input.only_if_text_head {
            b"text-only".as_slice()
        } else {
            b"any-head".as_slice()
        },
        if input.only_if_capture_origin {
            b"capture-origin-only".as_slice()
        } else {
            b"any-origin".as_slice()
        },
    ]);
    if let Some(request_id) = &input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        let retired = if recorded.result_seq == 0 {
            None
        } else {
            Some(reconstruct_capture_delete(
                tx,
                &input.workspace_id,
                recorded.result_seq,
            )?)
        };
        return Ok(CaptureRetireResult {
            retired,
            deduped: true,
        });
    }

    let Some(object_id) = alias_object_id(tx, &input.workspace_id, &input.version_id, &input.path)?
    else {
        record_request(
            tx,
            input.request_id.as_deref(),
            &payload_hash,
            0,
            input.now_ms,
        )?;
        return Ok(CaptureRetireResult {
            retired: None,
            deduped: false,
        });
    };
    if input.only_if_text_head || input.only_if_capture_origin {
        let head = get_snapshot(tx, &input.workspace_id, &input.version_id, &object_id)?.ok_or(
            DomainError::StateCorrupt {
                reason: "path alias points at a missing snapshot",
            },
        )?;
        // A head this caller does not own (written by RPC/replication) is
        // never destroyed by a disk-driven retire. DISK-OWNED origins pass:
        // capture heads, and materialized Y.Doc heads — the manifest seeds
        // 'ydoc' rows precisely so the baseline scanner tracks their files,
        // and a file deleted while the daemon was down must retire the head
        // rather than leave a stale snapshot readable forever.
        if input.only_if_capture_origin
            && head.metadata_origin != CAPTURE_ORIGIN
            && head.metadata_origin != YDOC_ORIGIN
        {
            record_request(
                tx,
                input.request_id.as_deref(),
                &payload_hash,
                0,
                input.now_ms,
            )?;
            return Ok(CaptureRetireResult {
                retired: None,
                deduped: false,
            });
        }
        if input.only_if_text_head && head.content_kind != "text" {
            // A live non-text head is not the caller's to retire; settle as a
            // no-op exactly like an absent path.
            record_request(
                tx,
                input.request_id.as_deref(),
                &payload_hash,
                0,
                input.now_ms,
            )?;
            return Ok(CaptureRetireResult {
                retired: None,
                deduped: false,
            });
        }
    }
    let next_order = next_moment_order(tx)?;
    let moment_id = derive_capture_retire_moment_id(&input.workspace_id, &object_id, next_order);
    let delete = DeleteTextFile {
        workspace_id: input.workspace_id.clone(),
        version_id: input.version_id.clone(),
        path: input.path,
        moment_id,
        request_id: None,
        metadata_origin: "capture".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: input.now_ms,
    };
    let result = delete_text_in_tx(tx, &delete)?;
    if result.moment.moment_order != next_order {
        return Err(DomainError::StateCorrupt {
            reason: "capture moment order diverged from reserved order",
        });
    }
    record_request(
        tx,
        input.request_id.as_deref(),
        &payload_hash,
        result.moment.moment_order,
        input.now_ms,
    )?;
    Ok(CaptureRetireResult {
        retired: Some(result),
        deduped: false,
    })
}

/// The metadata origin every capture write records. Ownership of a head is
/// determined by this value: capture only ever overwrites or retires heads
/// it wrote itself.
///
/// RESERVED: `normalized_write_input` — which EVERY plaintext write path
/// runs, including `write_text_in_tx` behind the RPC surface — rejects this
/// origin, so a caller cannot forge capture ownership and have its own
/// content retired by a disk-driven pass. Only the capture primitives in
/// this module may write it.
pub const CAPTURE_ORIGIN: &str = "capture";

/// The metadata origin stamped by Y.Doc settles. Materialized Y.Doc heads are
/// DISK-OWNED like capture heads: the manifest seeds them into the baseline
/// scanner, and disk-driven retires may destroy them.
pub const YDOC_ORIGIN: &str = "ydoc";

/// Maximum binary payload a capture ingest may persist. Mirrors
/// `MAX_VERSIONED_BINARY_FILE_BYTES` (`versionedTextStore.ts`) and the files
/// crate's `MAX_CAPTURE_BINARY_BYTES`; the storage blob cap (64 MiB) stays
/// the generic ceiling for non-capture writers.
pub const MAX_CAPTURE_BINARY_FILE_BYTES: usize = 5 * 1024 * 1024;

#[doc(hidden)]
pub fn capture_ingest_binary_in_tx(
    tx: &Transaction<'_>,
    input: &CaptureIngestBinary,
) -> Result<CaptureIngestBinaryResult, DomainError> {
    use crate::conflicts::{PersistBinaryHead, persist_binary_head_in_tx};

    non_empty(&input.workspace_id, "workspace_id")?;
    non_empty(&input.version_id, "version_id")?;
    let path = validate_plaintext_storable_path(&input.path)?;
    if input.bytes.len() > MAX_CAPTURE_BINARY_FILE_BYTES {
        return Err(DomainError::InvalidInput {
            reason: "binary bytes exceed the capture cap",
        });
    }
    if !version_exists(tx, &input.workspace_id, &input.version_id)? {
        return Err(DomainError::VersionNotFound);
    }
    let binary_sha256 = dohc_engine_storage::hex_sha256(&input.bytes);
    let (author_kind, author_json) = match input.author_json.as_deref() {
        Some(author_json) => (b"some".as_slice(), author_json.as_bytes()),
        None => (b"none".as_slice(), b"".as_slice()),
    };
    let payload_hash = hash_fields(&[
        b"capture-ingest-binary",
        input.workspace_id.as_bytes(),
        input.version_id.as_bytes(),
        path.as_bytes(),
        binary_sha256.as_bytes(),
        input.metadata_origin.as_bytes(),
        author_kind,
        author_json,
        if input.claim_foreign_head {
            b"claim-foreign".as_slice()
        } else {
            b"own-only".as_slice()
        },
    ]);
    if let Some(request_id) = &input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        return reconstruct_capture_binary(tx, &input.workspace_id, recorded.result_seq);
    }

    let (object_id, reserved_moment_order) = resolve_capture_object(
        tx,
        &input.workspace_id,
        &input.version_id,
        &path,
        input.now_ms,
    )?;
    let before = get_snapshot(tx, &input.workspace_id, &input.version_id, &object_id)?;
    if let Some(existing) = &before
        && existing.metadata_origin != input.metadata_origin
        && !input.claim_foreign_head
    {
        return Err(DomainError::CaptureNotOwned);
    }
    if let Some(before) = &before {
        // Fail closed on partial head identity, mirroring the binary writer.
        match before.content_kind.as_str() {
            "text" if before.blob_sha256.is_some() => {}
            "binary" if before.binary_sha256.is_some() => {}
            "text" => {
                return Err(DomainError::StateCorrupt {
                    reason: "text snapshot is missing its blob",
                });
            }
            "binary" => {
                return Err(DomainError::StateCorrupt {
                    reason: "binary snapshot is missing its blob",
                });
            }
            _ => {
                return Err(DomainError::StateCorrupt {
                    reason: "snapshot has an unknown content kind",
                });
            }
        }
        if before.content_kind == "binary"
            && before.binary_sha256.as_deref() == Some(binary_sha256.as_str())
        {
            // Content-equality no-op: the interleave-safety guarantee.
            let result_sha = binary_sha256.clone();
            let moment = get_moment(tx, &input.workspace_id, &before.latest_moment_id)?.ok_or(
                DomainError::StateCorrupt {
                    reason: "snapshot points at a missing moment",
                },
            )?;
            // The head's bytes are VERIFIED on disk right now, so record the
            // head generation as materialized (upsert: the creating write's
            // own job may still be pending — its content is this same sha —
            // and flipping it complete both records reality and lets the
            // staleness gate supersede any OLDER pending job that could
            // otherwise regress disk behind the confirmed head).
            dohc_engine_storage::record_completed_job(
                tx,
                &MaterializationJobSpec {
                    job_id: moment.moment_id.clone(),
                    workspace_id: input.workspace_id.clone(),
                    target_path: path.clone(),
                    content_sha256: result_sha.clone(),
                    preimage: Preimage::Present(result_sha.clone()),
                    target_generation: moment.moment_order,
                    now_ms: input.now_ms,
                },
            )?;
            let result = CaptureIngestBinaryResult {
                object_id: object_id.clone(),
                moment_id: moment.moment_id.clone(),
                moment_order: moment.moment_order,
                binary_sha256: result_sha,
                deduped: true,
            };
            record_request(
                tx,
                input.request_id.as_deref(),
                &payload_hash,
                result.moment_order,
                input.now_ms,
            )?;
            return Ok(result);
        }
    }

    put_binary_blob(tx, &input.bytes)?;
    let next_order = match reserved_moment_order {
        Some(next_order) => next_order,
        None => next_moment_order(tx)?,
    };
    let moment_id = derive_capture_moment_id(&input.workspace_id, &object_id, next_order);
    if moment_exists(tx, &input.workspace_id, &moment_id)? {
        return Err(DomainError::DuplicateMomentId);
    }
    let before_head = before.map(|before| {
        (
            before.content_kind,
            before.blob_sha256,
            before.binary_sha256,
            before.latest_moment_id,
        )
    });
    let moment_order = persist_binary_head_in_tx(
        tx,
        &PersistBinaryHead {
            workspace_id: &input.workspace_id,
            version_id: &input.version_id,
            object_id: &object_id,
            path: &path,
            binary_sha256: &binary_sha256,
            moment_id: &moment_id,
            metadata_origin: &input.metadata_origin,
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: input.author_json.as_deref(),
            now_ms: input.now_ms,
        },
        before_head,
    )?;
    if moment_order != next_order {
        return Err(DomainError::StateCorrupt {
            reason: "capture moment order diverged from reserved order",
        });
    }
    // Disk ALREADY holds these bytes, so record the materialization as a
    // COMPLETED job (never runnable). The marker is what the materializer's
    // staleness gate reads: an OLDER still-pending job for this path — whose
    // preimage may match the very bytes just captured — is superseded instead
    // of later running and regressing disk behind this head.
    dohc_engine_storage::record_completed_job(
        tx,
        &MaterializationJobSpec {
            job_id: moment_id.clone(),
            workspace_id: input.workspace_id.clone(),
            target_path: path.clone(),
            content_sha256: binary_sha256.clone(),
            preimage: Preimage::Present(binary_sha256.clone()),
            target_generation: moment_order,
            now_ms: input.now_ms,
        },
    )?;
    record_request(
        tx,
        input.request_id.as_deref(),
        &payload_hash,
        moment_order,
        input.now_ms,
    )?;
    Ok(CaptureIngestBinaryResult {
        object_id,
        moment_id,
        moment_order,
        binary_sha256,
        deduped: false,
    })
}

/// One rehydration-seed entry for the files-layer scan manifest: the path,
/// the CAPTURED content's byte size, and its lowercase-hex sha256 in the
/// scanner's own terms (text = the blob bytes, binary = the binary blob).
/// Secrets carry a sentinel sha (plaintext hashes are deliberately never
/// stored), so a reopened workspace re-offers each secret once and the
/// encrypted store's content-equality dedupe settles it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureManifestSeedEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// The sentinel recorded for secret seeds (never a valid hex digest, so the
/// first scan always re-offers the path).
pub const SECRET_SEED_SENTINEL_SHA: &str = "rehydrated-secret";

/// Every CAPTURE-ORIGIN path in `version_id` with its content identity, for
/// seeding a fresh files-layer manifest on workspace (re)open. Without this
/// seed the baseline scan diffs against EMPTY and can never emit a Retire
/// for a file deleted while the daemon was down — the stale captured head
/// would stay readable forever (`ReconcileController::rehydrated`'s
/// documented follow-up: the rehydration SOURCE lives above the files
/// crate, which is here).
///
/// CAPTURE-ORIGIN ONLY, deliberately: the manifest states what CAPTURE
/// believes is on disk. Content that arrived any other way (an RPC
/// `versionedText.write`, a replication/sync apply) may legitimately have
/// no disk counterpart yet, and seeding it would make the next baseline
/// scan diff it as "removed" and RETIRE it — capture deleting content it
/// never owned.
///
/// Matching pending rollback deletes are emitted as transient last-known-disk
/// entries. This keeps a surviving delete target out of capture until the
/// compensating job becomes terminal, without crossing version boundaries or
/// creating a database head for that path.
pub fn capture_manifest_seed(
    store: &EngineStore,
    workspace_id: &str,
    version_id: &str,
) -> Result<Vec<CaptureManifestSeedEntry>, DomainError> {
    let ws = workspace_id.to_owned();
    let version = version_id.to_owned();
    let rollback_version_prefix = binary_rollback_job_version_prefix(&ws, &version);
    store.read_with(move |conn| {
        let mut entries = Vec::new();
        let mut stmt = conn
            .prepare(
                "SELECT a.path, COALESCE(s.content_kind, 'text'), \
                        s.blob_sha256, tb.byte_length, \
                        s.binary_sha256, bb.byte_length \
                 FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id = a.workspace_id \
                   AND s.version_id = a.version_id AND s.object_id = a.object_id \
                 LEFT JOIN blobs tb ON tb.sha256 = s.blob_sha256 \
                 LEFT JOIN binary_blobs bb ON bb.sha256 = s.binary_sha256 \
                 WHERE a.workspace_id = ?1 AND a.version_id = ?2 \
                   AND (s.metadata_origin = 'capture' \
                        OR (s.metadata_origin = 'ydoc' \
                            AND NOT EXISTS ( \
                                SELECT 1 FROM materialization_jobs j \
                                WHERE j.job_id = 'ydoc-mat_' || s.latest_moment_id \
                                  AND j.status = 'pending'))) \
                   AND NOT EXISTS ( \
                       SELECT 1 FROM materialization_jobs j \
                        WHERE j.status = 'pending' AND j.operation = 'write' \
                          AND j.workspace_id = ?1 \
                          AND j.target_path = a.path \
                         AND j.content_sha256 = CASE COALESCE(s.content_kind, 'text') \
                             WHEN 'binary' THEN s.binary_sha256 ELSE s.blob_sha256 END \
                         AND (substr(j.job_id, 1, length(?3)) = ?3 \
                              OR substr(j.job_id, \
                                    length('binary-rename-0-write-mat_') + 1, \
                                    length(?3)) = ?3 \
                              OR ((j.job_id GLOB 'rollback-restore_*' \
                                   OR j.job_id GLOB \
                                      'binary-rename-0-write-mat_rollback-restore_*') \
                                  AND instr(j.job_id, char(31)) = 0 \
                                  AND NOT EXISTS ( \
                                      SELECT 1 FROM moments rollback_spoof \
                                      WHERE rollback_spoof.moment_id = CASE \
                                            WHEN j.job_id GLOB \
                                                'binary-rename-0-write-mat_*' \
                                            THEN substr(j.job_id, \
                                                length( \
                                                    'binary-rename-0-write-mat_') + 1) \
                                            ELSE j.job_id END)))) \
                 UNION ALL \
                 SELECT j.target_path, 'binary', NULL, NULL, \
                        j.content_sha256, bb.byte_length \
                 FROM materialization_jobs j \
                 JOIN binary_blobs bb ON bb.sha256 = j.content_sha256 \
                  WHERE j.status = 'pending' AND j.operation = 'delete' \
                    AND j.workspace_id = ?1 \
                     AND (substr(j.job_id, 1, length(?3)) = ?3 \
                         OR substr(j.job_id, \
                               length('binary-rename-1-delete-mat_') + 1, \
                               length(?3)) = ?3 \
                         OR (j.job_id GLOB \
                                'binary-rename-1-delete-mat_rollback-restore_*' \
                             AND instr(j.job_id, char(31)) = 0 \
                             AND EXISTS ( \
                                 SELECT 1 \
                                 FROM materialization_jobs restore \
                                 JOIN path_aliases restore_alias \
                                   ON restore_alias.workspace_id = ?1 \
                                  AND restore_alias.version_id = ?2 \
                                  AND restore_alias.path = restore.target_path \
                                 JOIN snapshots restore_snapshot \
                                   ON restore_snapshot.workspace_id = restore_alias.workspace_id \
                                  AND restore_snapshot.version_id = restore_alias.version_id \
                                  AND restore_snapshot.object_id = restore_alias.object_id \
                                  WHERE restore.job_id = \
                                      'binary-rename-0-write-mat_' || \
                                     substr(j.job_id, \
                                         length('binary-rename-1-delete-mat_') + 1) \
                                    AND restore.operation = 'write' \
                                    AND restore.workspace_id = ?1 \
                                    AND restore.content_sha256 = j.content_sha256 \
                                   AND CASE COALESCE(restore_snapshot.content_kind, 'text') \
                                       WHEN 'binary' THEN restore_snapshot.binary_sha256 \
                                       ELSE restore_snapshot.blob_sha256 END = \
                                       restore.content_sha256))) \
                    AND NOT EXISTS ( \
                        SELECT 1 FROM path_aliases a \
                        WHERE a.workspace_id = ?1 AND a.version_id = ?2 \
                         AND a.path = j.target_path) \
                 ORDER BY 1",
            )
            .map_err(DomainError::sql_corrupt)?;
        let rows = stmt
            .query_map(params![ws, version, rollback_version_prefix], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            })
            .map_err(DomainError::sql_corrupt)?;
        for row in rows {
            let (path, kind, text_sha, text_len, binary_sha, binary_len) =
                row.map_err(DomainError::sql_corrupt)?;
            let (sha256, size) = match kind.as_str() {
                "binary" => match (binary_sha, binary_len) {
                    (Some(sha), Some(len)) => (sha, len.max(0) as u64),
                    _ => continue,
                },
                _ => match (text_sha, text_len) {
                    (Some(sha), Some(len)) => (sha, len.max(0) as u64),
                    _ => continue,
                },
            };
            entries.push(CaptureManifestSeedEntry { path, size, sha256 });
        }
        // Same capture-ownership rule for the encrypted store: a tip written
        // by the API or replication may legitimately have no plaintext on
        // disk, and seeding it would make the baseline diff RETIRE it. Keyed
        // on the engine-stamped `capture_owned` column, never on the
        // caller-supplied origin string.
        let mut secrets = conn
            .prepare(
                "SELECT f.path, f.byte_length FROM secret_files f \
                 JOIN secret_moments m ON m.workspace_id = f.workspace_id \
                   AND m.moment_id = f.latest_moment_id \
                 WHERE f.workspace_id = ?1 AND f.version_id = ?2 \
                   AND m.capture_owned = 1",
            )
            .map_err(DomainError::sql_corrupt)?;
        let rows = secrets
            .query_map(params![ws, version], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(DomainError::sql_corrupt)?;
        for row in rows {
            let (path, len) = row.map_err(DomainError::sql_corrupt)?;
            entries.push(CaptureManifestSeedEntry {
                path,
                size: len.max(0) as u64,
                sha256: SECRET_SEED_SENTINEL_SHA.to_owned(),
            });
        }
        Ok(entries)
    })
}

fn reconstruct_capture_binary(
    conn: &Connection,
    workspace_id: &str,
    moment_order: i64,
) -> Result<CaptureIngestBinaryResult, DomainError> {
    let moment =
        moment_by_order(conn, workspace_id, moment_order)?.ok_or(DomainError::StateCorrupt {
            reason: "deduped capture has no moment",
        })?;
    if moment.after_content_kind != "binary" {
        return Err(DomainError::StateCorrupt {
            reason: "deduped binary capture points at non-binary content",
        });
    }
    let binary_sha256 = moment
        .after_binary_sha256
        .clone()
        .ok_or(DomainError::StateCorrupt {
            reason: "deduped binary capture moment has no binary blob",
        })?;
    Ok(CaptureIngestBinaryResult {
        object_id: moment.object_id,
        moment_id: moment.moment_id,
        moment_order: moment.moment_order,
        binary_sha256,
        deduped: true,
    })
}

/// Apply an R05 text write inside a caller-owned compound transaction. R06
/// uses this seam so the canonical mutation, conflict transition, and durable
/// materialization intent commit together rather than becoming three writes.
#[doc(hidden)]
pub fn write_text_in_tx(
    tx: &Transaction<'_>,
    input: &WriteText,
) -> Result<WriteResult, DomainError> {
    write_text_in_tx_with_journal(tx, input, true, false)
}

/// Apply a projected text write without appending `moment.append` to the
/// replication journal. A Y.Doc settle has already durably recorded the CRDT
/// edits that produced this projection, so journaling the derived markdown a
/// second time would create a competing replication mutation.
#[doc(hidden)]
pub fn write_projected_text_in_tx(
    tx: &Transaction<'_>,
    input: &WriteText,
) -> Result<WriteResult, DomainError> {
    // allow_preallocated_object: the live Y.Doc seed pre-creates the
    // file_objects row (FK parent for the marker) before any snapshot or
    // alias exists — the settle that follows is binding ITS OWN object,
    // not colliding with another.
    write_text_in_tx_with_journal(tx, input, false, true)
}

fn write_text_in_tx_with_journal(
    tx: &Transaction<'_>,
    input: &WriteText,
    journal: bool,
    allow_preallocated_object: bool,
) -> Result<WriteResult, DomainError> {
    let normalized_input = normalized_write_input(input)?;
    let input = &normalized_input;
    let ws = &input.workspace_id;
    if !version_exists(tx, ws, &input.version_id)? {
        return Err(DomainError::VersionNotFound);
    }

    let blob = text_blob_sha256(&input.text);
    let (author_kind, author_json) = hash_author_fields(input.author_json.as_deref());
    let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary.as_deref());
    let (correlation_kind, correlation_id) =
        hash_optional_text_fields(input.metadata_correlation_id.as_deref());
    let payload_hash = hash_fields(&[
        input.version_id.as_bytes(),
        input.path.as_bytes(),
        input.text.as_bytes(),
        input.moment_id.as_bytes(),
        input.object_id.as_bytes(),
        input.metadata_origin.as_bytes(),
        summary_kind,
        summary,
        correlation_kind,
        correlation_id,
        author_kind,
        author_json,
    ]);
    if let Some(request_id) = &input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        return reconstruct_write(tx, input);
    }
    if let Some(existing) = get_moment(tx, ws, &input.moment_id)? {
        let exact = existing.version_id == input.version_id
            && existing.path == input.path
            && existing.operation == MomentOp::Write
            && existing.after_content_kind == "text"
            && existing.after_blob_sha256.as_deref() == Some(blob.as_str())
            && existing.metadata_origin == input.metadata_origin
            && existing.metadata_summary == input.metadata_summary
            && existing.metadata_correlation_id == input.metadata_correlation_id
            && existing.author_json == input.author_json;
        if exact {
            return write_result_from_moment(tx, ws, existing, true);
        }
        // The oracle's contract: a caller-supplied moment id reused with
        // DIFFERENT content is duplicate-moment-id (the exact-match arm
        // above is the idempotent replay; only requestId reuse maps to the
        // idempotency-mismatch code).
        return Err(DomainError::DuplicateMomentId);
    }
    // Text and protected history share one workspace-wide moment-id namespace.
    // `get_moment` intentionally resolves only plaintext history, so retain
    // the exact-text replay above and then reject a secret-table collision in
    // this same transaction before inserting the text row.
    if moment_exists(tx, ws, &input.moment_id)? {
        return Err(DomainError::DuplicateMomentId);
    }

    let existing_object = alias_object_id(tx, ws, &input.version_id, &input.path)?;
    let before = match &existing_object {
        Some(object_id) => get_snapshot(tx, ws, &input.version_id, object_id)?,
        None => {
            if input.object_id.is_empty() {
                return Err(DomainError::InvalidInput {
                    reason: "object_id must not be empty for a new path",
                });
            }
            if object_exists(tx, ws, &input.object_id)? {
                let bare_preallocation =
                    allow_preallocated_object && !object_has_any_binding(tx, ws, &input.object_id)?;
                if !bare_preallocation {
                    return Err(DomainError::InvalidInput {
                        reason: "object_id is already bound to another object",
                    });
                }
            }
            None
        }
    };
    let is_new_object = existing_object.is_none();
    let object_id = existing_object.unwrap_or_else(|| input.object_id.clone());
    let before_blob = before.as_ref().and_then(|s| s.blob_sha256.clone());
    let before_content_kind = before
        .as_ref()
        .map_or_else(|| "text".to_owned(), |s| s.content_kind.clone());
    let before_binary_sha256 = before.as_ref().and_then(|s| s.binary_sha256.clone());
    let before_latest_moment_id = before.as_ref().map(|s| s.latest_moment_id.clone());
    let moment_order = next_moment_order(tx)?;

    if is_new_object {
        // OR IGNORE: the preallocated-object path (live Y.Doc seed) already
        // holds this row; every other new-object path inserts fresh.
        tx.execute(
            "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)              VALUES (?1, ?2, ?3)",
            params![ws, object_id, input.now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
        params![blob, input.text.len() as i64, input.text],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "INSERT OR IGNORE INTO path_aliases (workspace_id, version_id, path, object_id) \
         VALUES (?1, ?2, ?3, ?4)",
        params![ws, input.version_id, input.path, object_id],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "INSERT INTO moments \
         (workspace_id, moment_order, moment_id, version_id, object_id, path, recorded_at_ms, \
           operation, after_blob_sha256, before_present, before_blob_sha256, \
           before_latest_moment_id, metadata_origin, metadata_summary, \
           metadata_correlation_id, author_json, sync_record_only, \
           after_content_kind, after_binary_sha256, before_content_kind, before_binary_sha256, \
           payload_before_path, payload_before_content_kind, payload_before_blob_sha256, \
           payload_after_path, payload_after_content_kind, \
           payload_after_blob_sha256) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'write', ?8, ?9, ?10, ?11, ?12, \
                  ?13, ?14, ?15, NULL, 'text', NULL, ?16, ?17, \
                  CASE WHEN ?9 = 2 THEN ?6 END, CASE WHEN ?9 = 2 THEN ?16 END, \
                  CASE ?16 WHEN 'binary' THEN ?17 ELSE ?10 END, ?6, 'text', ?8)",
        params![
            ws,
            moment_order,
            input.moment_id,
            input.version_id,
            object_id,
            input.path,
            input.now_ms,
            blob,
            if before.is_some() { 2 } else { 1 },
            before_blob,
            before_latest_moment_id,
            input.metadata_origin,
            input.metadata_summary,
            input.metadata_correlation_id,
            input.author_json,
            before_content_kind,
            before_binary_sha256,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "INSERT INTO snapshots \
         (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, \
           latest_moment_id, metadata_origin, metadata_summary, \
           metadata_correlation_id, content_kind, binary_sha256) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'text', NULL) \
         ON CONFLICT(workspace_id, version_id, object_id) DO UPDATE SET \
           path = excluded.path, blob_sha256 = excluded.blob_sha256, \
           updated_at_ms = excluded.updated_at_ms, latest_moment_id = excluded.latest_moment_id, \
           metadata_origin = excluded.metadata_origin, \
           metadata_summary = excluded.metadata_summary, \
           metadata_correlation_id = excluded.metadata_correlation_id, \
           content_kind = excluded.content_kind, \
           binary_sha256 = excluded.binary_sha256",
        params![
            ws,
            input.version_id,
            object_id,
            input.path,
            blob,
            input.now_ms,
            input.moment_id,
            input.metadata_origin,
            input.metadata_summary,
            input.metadata_correlation_id,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    if journal {
        tx.execute(
            "INSERT INTO replication_journal (doc_id, op_kind, created_at_ms) \
             VALUES (?1, 'moment.append', ?2)",
            params![object_id, input.now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    }
    record_request(
        tx,
        input.request_id.as_deref(),
        &payload_hash,
        moment_order,
        input.now_ms,
    )?;

    Ok(WriteResult {
        object: get_file_object(tx, ws, &object_id)?.ok_or(DomainError::StateCorrupt {
            reason: "written snapshot points at a missing object",
        })?,
        snapshot: TextSnapshot {
            workspace_id: ws.clone(),
            version_id: input.version_id.clone(),
            object_id: object_id.clone(),
            path: input.path.clone(),
            text: input.text.clone(),
            blob_sha256: blob.clone(),
            updated_at_ms: input.now_ms,
            latest_moment_id: input.moment_id.clone(),
            metadata_origin: input.metadata_origin.clone(),
            metadata_summary: input.metadata_summary.clone(),
            metadata_correlation_id: input.metadata_correlation_id.clone(),
        },
        moment: get_moment(tx, ws, &input.moment_id)?.ok_or(DomainError::StateCorrupt {
            reason: "moment vanished within its own write transaction",
        })?,
        deduped: false,
    })
}

fn reconstruct_write(conn: &Connection, input: &WriteText) -> Result<WriteResult, DomainError> {
    let moment = get_moment(conn, &input.workspace_id, &input.moment_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "deduped write has no moment",
        },
    )?;
    write_result_from_moment(conn, &input.workspace_id, moment, true)
}

/// Apply a caller-originated binary write inside a caller-owned transaction.
/// The runtime uses this seam to keep the binary FTS deletion atomic with the
/// head/moment/materialization intent.
#[doc(hidden)]
pub fn write_binary_in_tx(
    tx: &Transaction<'_>,
    input: &WriteBinary,
) -> Result<BinaryWriteResult, DomainError> {
    // RESERVED ORIGIN at the door, like the text write: capture's binary
    // primitive never routes through this fn, so the reservation cannot be
    // forged while capture keeps stamping its own origin.
    reject_reserved_capture_origin(&input.metadata_origin)?;
    non_empty(&input.workspace_id, "workspace_id")?;
    non_empty(&input.version_id, "version_id")?;
    validate_moment_id(&input.moment_id)?;
    let path = validate_plaintext_storable_path(&input.path)?;
    if !version_exists(tx, &input.workspace_id, &input.version_id)? {
        return Err(DomainError::VersionNotFound);
    }
    let sha256 = dohc_engine_storage::hex_sha256(&input.bytes);
    let (author_kind, author_json) = hash_author_fields(input.author_json.as_deref());
    let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary.as_deref());
    let (correlation_kind, correlation_id) =
        hash_optional_text_fields(input.metadata_correlation_id.as_deref());
    let payload_hash = hash_fields(&[
        b"versioned-binary-write",
        input.workspace_id.as_bytes(),
        input.version_id.as_bytes(),
        path.as_bytes(),
        sha256.as_bytes(),
        input.moment_id.as_bytes(),
        input.object_id.as_bytes(),
        input.metadata_origin.as_bytes(),
        summary_kind,
        summary,
        correlation_kind,
        correlation_id,
        author_kind,
        author_json,
    ]);
    if let Some(request_id) = &input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        return reconstruct_binary_write(tx, &input.workspace_id, recorded.result_seq);
    }
    put_binary_blob(tx, &input.bytes).map_err(DomainError::from)?;
    let existing_object = alias_object_id(tx, &input.workspace_id, &input.version_id, &path)?;
    let before = existing_object
        .as_deref()
        .map(|object_id| get_snapshot(tx, &input.workspace_id, &input.version_id, object_id))
        .transpose()?
        .flatten();

    if let Some(before) = &before
        && before.content_kind == "binary"
        && before.binary_sha256.as_deref() == Some(sha256.as_str())
    {
        let moment = get_moment(tx, &input.workspace_id, &before.latest_moment_id)?.ok_or(
            DomainError::StateCorrupt {
                reason: "deduped binary write points at a missing moment",
            },
        )?;
        let object = get_file_object(tx, &input.workspace_id, &before.object_id)?.ok_or(
            DomainError::StateCorrupt {
                reason: "deduped binary write points at a missing object",
            },
        )?;
        record_request(
            tx,
            input.request_id.as_deref(),
            &payload_hash,
            moment.moment_order,
            input.now_ms,
        )?;
        return Ok(BinaryWriteResult {
            object,
            object_id: before.object_id.clone(),
            path,
            sha256,
            byte_length: input.bytes.len() as i64,
            updated_at_ms: before.updated_at_ms,
            moment,
            deduped: true,
            materialize_enqueued: false,
        });
    }

    let object_id = existing_object.unwrap_or_else(|| input.object_id.clone());
    let preimage = before.as_ref().map_or(Preimage::Absent, |snapshot| {
        if snapshot.content_kind == "binary" {
            Preimage::Present(snapshot.binary_sha256.clone().unwrap_or_default())
        } else {
            Preimage::Present(snapshot.blob_sha256.clone().unwrap_or_default())
        }
    });
    let version_is_active = version_is_active(tx, &input.workspace_id, &input.version_id)?;
    write_binary_file_in_tx(
        tx,
        &WriteBinaryFile {
            workspace_id: input.workspace_id.clone(),
            version_id: input.version_id.clone(),
            object_id: object_id.clone(),
            path: path.clone(),
            binary_sha256: sha256.clone(),
            moment_id: input.moment_id.clone(),
            metadata_origin: input.metadata_origin.clone(),
            metadata_summary: input.metadata_summary.clone(),
            metadata_correlation_id: input.metadata_correlation_id.clone(),
            author_json: input.author_json.clone(),
            // ACTIVE version only: disk mirrors the active version, so a
            // non-active write must not enqueue a job — the open-time replay
            // would land another version's bytes for the capture baseline to
            // ingest into the active head.
            materialize: version_is_active.then_some(preimage),
            now_ms: input.now_ms,
        },
    )?;
    let moment = get_moment(tx, &input.workspace_id, &input.moment_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "binary write moment vanished within its transaction",
        },
    )?;
    let object =
        get_file_object(tx, &input.workspace_id, &object_id)?.ok_or(DomainError::StateCorrupt {
            reason: "binary write snapshot points at a missing object",
        })?;
    record_request(
        tx,
        input.request_id.as_deref(),
        &payload_hash,
        moment.moment_order,
        input.now_ms,
    )?;
    Ok(BinaryWriteResult {
        object,
        object_id,
        path,
        sha256,
        byte_length: input.bytes.len() as i64,
        updated_at_ms: input.now_ms,
        moment,
        deduped: false,
        materialize_enqueued: version_is_active,
    })
}

/// Whether `version_id` is the workspace version mirrored by the working tree.
/// A missing explicit active row falls back to the canonical main version.
pub(crate) fn version_is_active(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<bool, DomainError> {
    let active_version: Option<String> = conn
        .query_row(
            "SELECT COALESCE(                (SELECT version_id FROM active_versions WHERE workspace_id = ?1),                (SELECT main_version_id FROM versioned_workspaces WHERE workspace_id = ?1))",
            params![workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(active_version.as_deref() == Some(version_id))
}

fn reconstruct_binary_write(
    conn: &Connection,
    workspace_id: &str,
    moment_order: i64,
) -> Result<BinaryWriteResult, DomainError> {
    let moment =
        moment_by_order(conn, workspace_id, moment_order)?.ok_or(DomainError::StateCorrupt {
            reason: "deduped binary write has no recorded moment",
        })?;
    if moment.after_content_kind != "binary" {
        return Err(DomainError::StateCorrupt {
            reason: "deduped binary write points at non-binary content",
        });
    }
    let sha256 = moment
        .after_binary_sha256
        .clone()
        .ok_or(DomainError::StateCorrupt {
            reason: "deduped binary write moment has no binary blob",
        })?;
    let byte_length: i64 = conn
        .query_row(
            "SELECT byte_length FROM binary_blobs WHERE sha256 = ?1",
            [&sha256],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?
        .ok_or(DomainError::StateCorrupt {
            reason: "deduped binary write moment blob missing",
        })?;
    let object = get_file_object(conn, workspace_id, &moment.object_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "deduped binary write moment object missing",
        },
    )?;
    Ok(BinaryWriteResult {
        object,
        object_id: moment.object_id.clone(),
        path: moment.path.clone(),
        sha256,
        byte_length,
        updated_at_ms: moment.recorded_at_ms,
        moment,
        deduped: true,
        materialize_enqueued: false,
    })
}

/// The ONE locked implementation of autonomous capture's object/alias
/// resolution, shared by the text and binary primitives so the length-framed,
/// security-sensitive id scheme can never silently diverge between them:
/// reuse a live alias; else derive the framed object id and reuse it ONLY when
/// it has no live alias anywhere; else mint an order-disambiguated id, with
/// that reserved order returned so the caller can pin it against the moment
/// the write actually persists.
fn resolve_capture_object(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    path: &str,
    now_ms: i64,
) -> Result<(String, Option<i64>), DomainError> {
    let mut reserved_moment_order = None;
    let object_id = match alias_object_id(tx, workspace_id, version_id, path)? {
        Some(object_id) => object_id,
        None => {
            let derived_object_id = derive_capture_object_id(workspace_id, version_id, path);
            let object_id = if !object_exists(tx, workspace_id, &derived_object_id)? {
                tx.execute(
                    "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                     VALUES (?1, ?2, ?3)",
                    params![workspace_id, derived_object_id, now_ms],
                )
                .map_err(DomainError::sql_persist)?;
                derived_object_id
            } else if !object_has_live_alias(tx, workspace_id, &derived_object_id)? {
                derived_object_id
            } else {
                let next_order = next_moment_order(tx)?;
                let disambiguated_object_id = derive_disambiguated_capture_object_id(
                    workspace_id,
                    version_id,
                    path,
                    next_order,
                );
                tx.execute(
                    "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                     VALUES (?1, ?2, ?3)",
                    params![workspace_id, disambiguated_object_id, now_ms],
                )
                .map_err(DomainError::sql_persist)?;
                reserved_moment_order = Some(next_order);
                disambiguated_object_id
            };
            tx.execute(
                "INSERT INTO path_aliases (workspace_id, version_id, path, object_id) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![workspace_id, version_id, path, object_id],
            )
            .map_err(DomainError::sql_persist)?;
            object_id
        }
    };
    Ok((object_id, reserved_moment_order))
}

fn reconstruct_capture_write(
    conn: &Connection,
    workspace_id: &str,
    moment_order: i64,
) -> Result<WriteResult, DomainError> {
    let moment =
        moment_by_order(conn, workspace_id, moment_order)?.ok_or(DomainError::StateCorrupt {
            reason: "deduped capture has no moment",
        })?;
    write_result_from_moment(conn, workspace_id, moment, true)
}

fn write_result_for_existing_head(
    conn: &Connection,
    snapshot: &SnapshotRecord,
) -> Result<WriteResult, DomainError> {
    let moment = get_moment(conn, &snapshot.workspace_id, &snapshot.latest_moment_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "snapshot points at a missing moment",
        },
    )?;
    write_result_from_moment(conn, &snapshot.workspace_id, moment, true)
}

pub(crate) fn write_result_from_moment(
    conn: &Connection,
    workspace_id: &str,
    moment: MomentRecord,
    deduped: bool,
) -> Result<WriteResult, DomainError> {
    if moment.after_content_kind != "text" {
        return Err(DomainError::StateCorrupt {
            reason: "deduped text write points at non-text content",
        });
    }
    let blob_sha256 = moment
        .after_blob_sha256
        .clone()
        .ok_or(DomainError::StateCorrupt {
            reason: "deduped text write moment has no text blob",
        })?;
    let text = blob_text(conn, &blob_sha256)?.ok_or(DomainError::StateCorrupt {
        reason: "deduped write moment blob missing",
    })?;
    let object = get_file_object(conn, workspace_id, &moment.object_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "deduped write moment object missing",
        },
    )?;
    Ok(WriteResult {
        object,
        snapshot: TextSnapshot {
            workspace_id: workspace_id.to_owned(),
            version_id: moment.version_id.clone(),
            object_id: moment.object_id.clone(),
            path: moment.path.clone(),
            text,
            blob_sha256,
            updated_at_ms: moment.recorded_at_ms,
            latest_moment_id: moment.moment_id.clone(),
            metadata_origin: moment.metadata_origin.clone(),
            metadata_summary: moment.metadata_summary.clone(),
            metadata_correlation_id: moment.metadata_correlation_id.clone(),
        },
        moment,
        deduped,
    })
}

fn reconstruct_rename(
    conn: &Connection,
    input: &RenameTextFile,
) -> Result<RenameResult, DomainError> {
    let moment = get_moment(conn, &input.workspace_id, &input.moment_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "deduped rename has no moment",
        },
    )?;
    if moment.operation != MomentOp::Rename
        || moment.version_id != input.version_id
        || moment.path != input.to_path
        || !moment.before_present
    {
        return Err(DomainError::StateCorrupt {
            reason: "deduped rename moment does not match its request",
        });
    }
    let object = get_file_object(conn, &input.workspace_id, &moment.object_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "deduped rename points at a missing object",
        },
    )?;
    let before = snapshot_from_moment_before(conn, &input.workspace_id, &moment, &input.from_path)?;
    let after = snapshot_from_moment_after(conn, &input.workspace_id, &moment, &input.to_path)?;
    Ok(RenameResult {
        object,
        before,
        after,
        moment,
        deduped: true,
    })
}

fn snapshot_from_moment_before(
    conn: &Connection,
    workspace_id: &str,
    moment: &MomentRecord,
    path: &str,
) -> Result<TextSnapshot, DomainError> {
    let producer_id =
        moment
            .before_latest_moment_id
            .as_deref()
            .ok_or(DomainError::StateCorrupt {
                reason: "deduped mutation has no preimage producer",
            })?;
    let producer =
        get_moment(conn, workspace_id, producer_id)?.ok_or(DomainError::StateCorrupt {
            reason: "deduped mutation preimage producer is missing",
        })?;
    let (text, sha) = snapshot_content_from_moment_side(
        conn,
        &moment.before_content_kind,
        moment.before_blob_sha256.as_deref(),
        moment.before_binary_sha256.as_deref(),
    )?;
    Ok(TextSnapshot {
        workspace_id: workspace_id.to_owned(),
        version_id: moment.version_id.clone(),
        object_id: moment.object_id.clone(),
        path: path.to_owned(),
        text,
        blob_sha256: sha,
        updated_at_ms: producer.recorded_at_ms,
        latest_moment_id: producer.moment_id,
        metadata_origin: producer.metadata_origin,
        metadata_summary: producer.metadata_summary,
        metadata_correlation_id: producer.metadata_correlation_id,
    })
}

fn snapshot_from_moment_after(
    conn: &Connection,
    workspace_id: &str,
    moment: &MomentRecord,
    path: &str,
) -> Result<TextSnapshot, DomainError> {
    let (text, sha) = snapshot_content_from_moment_side(
        conn,
        &moment.after_content_kind,
        moment.after_blob_sha256.as_deref(),
        moment.after_binary_sha256.as_deref(),
    )?;
    Ok(TextSnapshot {
        workspace_id: workspace_id.to_owned(),
        version_id: moment.version_id.clone(),
        object_id: moment.object_id.clone(),
        path: path.to_owned(),
        text,
        blob_sha256: sha,
        updated_at_ms: moment.recorded_at_ms,
        latest_moment_id: moment.moment_id.clone(),
        metadata_origin: moment.metadata_origin.clone(),
        metadata_summary: moment.metadata_summary.clone(),
        metadata_correlation_id: moment.metadata_correlation_id.clone(),
    })
}

fn snapshot_content_from_moment_side(
    conn: &Connection,
    content_kind: &str,
    text_sha: Option<&str>,
    binary_sha: Option<&str>,
) -> Result<(String, String), DomainError> {
    match content_kind {
        "text" => {
            let sha = text_sha.ok_or(DomainError::StateCorrupt {
                reason: "deduped mutation text side has no blob",
            })?;
            let text = blob_text(conn, sha)?.ok_or(DomainError::StateCorrupt {
                reason: "deduped mutation text blob is missing",
            })?;
            Ok((text, sha.to_owned()))
        }
        "binary" => Ok((
            String::new(),
            binary_sha
                .ok_or(DomainError::StateCorrupt {
                    reason: "deduped mutation binary side has no blob",
                })?
                .to_owned(),
        )),
        _ => Err(DomainError::StateCorrupt {
            reason: "deduped mutation has an unknown content kind",
        }),
    }
}

/// Apply an R05 text delete inside a caller-owned compound transaction.
#[doc(hidden)]
pub fn delete_text_in_tx(
    tx: &Transaction<'_>,
    input: &DeleteTextFile,
) -> Result<DeleteResult, DomainError> {
    let normalized_input = normalized_delete_input(input)?;
    let input = &normalized_input;
    let ws = &input.workspace_id;
    let (author_kind, author_json) = hash_author_fields(input.author_json.as_deref());
    let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary.as_deref());
    let (correlation_kind, correlation_id) =
        hash_optional_text_fields(input.metadata_correlation_id.as_deref());
    let payload_hash = hash_fields(&[
        input.workspace_id.as_bytes(),
        input.version_id.as_bytes(),
        input.path.as_bytes(),
        input.moment_id.as_bytes(),
        input.metadata_origin.as_bytes(),
        summary_kind,
        summary,
        correlation_kind,
        correlation_id,
        author_kind,
        author_json,
    ]);
    if let Some(request_id) = &input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        return reconstruct_delete(tx, input);
    }
    if !version_exists(tx, ws, &input.version_id)? {
        return Err(DomainError::VersionNotFound);
    }
    let object_id = alias_object_id(tx, ws, &input.version_id, &input.path)?
        .ok_or(DomainError::FileNotFound)?;
    let before =
        get_snapshot(tx, ws, &input.version_id, &object_id)?.ok_or(DomainError::FileNotFound)?;
    if moment_exists(tx, ws, &input.moment_id)? {
        return Err(DomainError::DuplicateMomentId);
    }
    let object = get_file_object(tx, ws, &object_id)?.ok_or(DomainError::StateCorrupt {
        reason: "snapshot points at a missing object",
    })?;
    let moment_order = next_moment_order(tx)?;
    tx.execute(
        "INSERT INTO moments \
         (workspace_id, moment_order, moment_id, version_id, object_id, path, recorded_at_ms, \
           operation, after_blob_sha256, before_present, before_blob_sha256, \
           before_latest_moment_id, metadata_origin, metadata_summary, \
           metadata_correlation_id, author_json, sync_record_only, \
           after_content_kind, after_binary_sha256, before_content_kind, before_binary_sha256, \
           payload_before_path, payload_before_content_kind, payload_before_blob_sha256, \
           payload_after_path, payload_after_content_kind, \
           payload_after_blob_sha256) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'delete', ?8, 2, ?8, ?9, ?10, \
                  ?11, ?12, ?13, NULL, ?14, ?15, ?14, ?15, ?6, ?14, \
                  CASE ?14 WHEN 'binary' THEN ?15 ELSE ?8 END, ?6, ?14, \
                  CASE ?14 WHEN 'binary' THEN ?15 ELSE ?8 END)",
        params![
            ws,
            moment_order,
            input.moment_id,
            input.version_id,
            before.object_id,
            input.path,
            input.now_ms,
            before.blob_sha256,
            before.latest_moment_id,
            input.metadata_origin,
            input.metadata_summary,
            input.metadata_correlation_id,
            input.author_json,
            before.content_kind,
            before.binary_sha256,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "INSERT INTO replication_journal (doc_id, op_kind, created_at_ms) \
         VALUES (?1, 'moment.append', ?2)",
        params![before.object_id, input.now_ms],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "DELETE FROM path_aliases WHERE workspace_id = ?1 AND version_id = ?2 \
         AND path = ?3 AND object_id = ?4",
        params![ws, input.version_id, input.path, before.object_id],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "DELETE FROM snapshots WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
        params![ws, input.version_id, before.object_id],
    )
    .map_err(DomainError::sql_persist)?;

    let result = DeleteResult {
        object,
        before: snapshot_text_view(&before),
        moment: get_moment(tx, ws, &input.moment_id)?.ok_or(DomainError::StateCorrupt {
            reason: "moment vanished within its own write transaction",
        })?,
        deduped: false,
    };
    record_request(
        tx,
        input.request_id.as_deref(),
        &payload_hash,
        moment_order,
        input.now_ms,
    )?;
    Ok(result)
}

fn reconstruct_capture_delete(
    conn: &Connection,
    workspace_id: &str,
    moment_order: i64,
) -> Result<DeleteResult, DomainError> {
    let moment =
        moment_by_order(conn, workspace_id, moment_order)?.ok_or(DomainError::StateCorrupt {
            reason: "deduped capture retire has no moment",
        })?;
    delete_result_from_moment(conn, workspace_id, moment, true)
}

fn reconstruct_delete(
    conn: &Connection,
    input: &DeleteTextFile,
) -> Result<DeleteResult, DomainError> {
    let moment = get_moment(conn, &input.workspace_id, &input.moment_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "deduped delete has no moment",
        },
    )?;
    if moment.version_id != input.version_id || moment.path != input.path {
        return Err(DomainError::StateCorrupt {
            reason: "deduped delete moment does not match its request",
        });
    }
    delete_result_from_moment(conn, &input.workspace_id, moment, true)
}

pub(crate) fn delete_result_from_moment(
    conn: &Connection,
    workspace_id: &str,
    moment: MomentRecord,
    deduped: bool,
) -> Result<DeleteResult, DomainError> {
    if moment.operation != MomentOp::Delete || !moment.before_present {
        return Err(DomainError::StateCorrupt {
            reason: "deduped delete points at a non-delete moment",
        });
    }
    let object = get_file_object(conn, workspace_id, &moment.object_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "deduped capture retire points at a missing object",
        },
    )?;
    let producer_id =
        moment
            .before_latest_moment_id
            .as_deref()
            .ok_or(DomainError::StateCorrupt {
                reason: "deduped capture retire has no preimage producer",
            })?;
    let producer =
        get_moment(conn, workspace_id, producer_id)?.ok_or(DomainError::StateCorrupt {
            reason: "deduped capture retire preimage producer is missing",
        })?;
    let (text, blob_sha256) = match moment.before_content_kind.as_str() {
        "text" => {
            let sha = moment
                .before_blob_sha256
                .clone()
                .ok_or(DomainError::StateCorrupt {
                    reason: "deduped capture retire has no text preimage",
                })?;
            let text = blob_text(conn, &sha)?.ok_or(DomainError::StateCorrupt {
                reason: "deduped capture retire preimage blob is missing",
            })?;
            (text, sha)
        }
        "binary" => (
            String::new(),
            moment
                .before_binary_sha256
                .clone()
                .ok_or(DomainError::StateCorrupt {
                    reason: "deduped capture retire has no binary preimage",
                })?,
        ),
        _ => {
            return Err(DomainError::StateCorrupt {
                reason: "deduped capture retire has an unknown preimage kind",
            });
        }
    };
    Ok(DeleteResult {
        object,
        before: TextSnapshot {
            workspace_id: workspace_id.to_owned(),
            version_id: moment.version_id.clone(),
            object_id: moment.object_id.clone(),
            path: moment.path.clone(),
            text,
            blob_sha256,
            updated_at_ms: producer.recorded_at_ms,
            latest_moment_id: producer.moment_id,
            metadata_origin: producer.metadata_origin,
            metadata_summary: producer.metadata_summary,
            metadata_correlation_id: producer.metadata_correlation_id,
        },
        moment,
        deduped,
    })
}

fn committed<T>(outcome: TxnOutcome<T>) -> Result<T, DomainError> {
    match outcome {
        TxnOutcome::Committed(value) => Ok(value),
        // A crash fault fired: surface it as persist-failed so a caller that did
        // not opt into fault handling still fails closed. The crash traces use
        // the storage seam directly (via the store) to assert the durable truth.
        TxnOutcome::Crashed { .. } => Err(DomainError::Storage(StorageError::persist_public(
            std::io::Error::other("crash fault fired before ack"),
        ))),
    }
}

fn non_empty(value: &str, field: &'static str) -> Result<(), DomainError> {
    if value.is_empty() {
        Err(DomainError::InvalidInput {
            reason: match field {
                "workspace_id" => "workspace_id must not be empty",
                "moment_id" => "moment_id must not be empty",
                _ => "version_id must not be empty",
            },
        })
    } else {
        Ok(())
    }
}

pub(crate) fn validate_moment_id(value: &str) -> Result<(), DomainError> {
    non_empty(value, "moment_id")?;
    if value.contains('\u{1f}') {
        return Err(DomainError::InvalidInput {
            reason: "moment_id contains a reserved character",
        });
    }
    Ok(())
}

/// Minimal path floor for the calibration slice. This is NOT the full
/// `validateUserWritePath` parity — normalization (NFC, forward-slash),
/// percent-decoding, and the complete reserved-name set are owned by the
/// `dohc-engine-files` path-floor shard. It rejects the high-value cases so a
/// clearly-unsafe path never becomes a durable alias/moment here.
pub(crate) fn validate_path(path: &str) -> Result<(), DomainError> {
    if path.is_empty() {
        return Err(DomainError::InvalidPath {
            reason: "path must not be empty",
        });
    }
    if path.contains('\0') {
        return Err(DomainError::InvalidPath {
            reason: "path must not contain NUL",
        });
    }
    // POSIX-absolute, Windows backslash / UNC, or drive-letter absolute.
    if path.starts_with('/') || path.contains('\\') || path.as_bytes().get(1) == Some(&b':') {
        return Err(DomainError::InvalidPath {
            reason: "path must be workspace-relative (no absolute or backslash forms)",
        });
    }
    if path.contains("..") {
        return Err(DomainError::InvalidPath {
            reason: "path must not contain traversal segments",
        });
    }
    // The engine's own directory is reserved; a file must never alias into it.
    if path == ".dohc" || path.starts_with(".dohc/") {
        return Err(DomainError::InvalidPath {
            reason: "path must not target the reserved .dohc directory",
        });
    }
    Ok(())
}

/// Store-door guard for operations that introduce a plaintext alias. Only a
/// tracked classification is eligible, and the returned key is canonical.
fn validate_plaintext_storable_path(path: &str) -> Result<String, DomainError> {
    use dohc_engine_files::policy::{PathClassification, classify_engine_file_path_normalized};

    let (classification, normalized) = classify_engine_file_path_normalized(path);
    if classification != PathClassification::Tracked {
        return Err(DomainError::InvalidPath {
            reason: "path is not eligible for plaintext storage",
        });
    }
    validate_path(path)?;
    normalized.ok_or(DomainError::InvalidPath {
        reason: "tracked path is missing its normalized form",
    })
}

/// Normalize a path used only to address an existing plaintext alias. Secret
/// paths are allowed so an absent/secret lookup reports absence honestly;
/// structurally invalid, reserved, and ignored paths remain rejected.
pub fn validate_addressable_plaintext_path(path: &str) -> Result<String, DomainError> {
    use dohc_engine_files::policy::{PathClassification, classify_engine_file_path_normalized};

    let (classification, normalized) = classify_engine_file_path_normalized(path);
    if classification == PathClassification::Ignored {
        return Err(DomainError::InvalidPath {
            reason: "path is not addressable plaintext content",
        });
    }
    validate_path(path)?;
    normalized.ok_or(DomainError::InvalidPath {
        reason: "addressable path is missing its normalized form",
    })
}

fn validate_text(text: &str) -> Result<(), DomainError> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(DomainError::InvalidText {
            reason: "text exceeds the size cap",
        });
    }
    Ok(())
}

fn workspace_main_version_id(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Option<String>, DomainError> {
    conn.query_row(
        "SELECT main_version_id FROM versioned_workspaces WHERE workspace_id = ?1",
        params![workspace_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

fn version_exists(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM versions WHERE workspace_id = ?1 AND version_id = ?2",
            params![workspace_id, version_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

fn name_taken(conn: &Connection, workspace_id: &str, name: &str) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM versions WHERE workspace_id = ?1 AND name = ?2",
            params![workspace_id, name],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

pub(crate) fn moment_exists(
    conn: &Connection,
    workspace_id: &str,
    moment_id: &str,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 WHERE \
             EXISTS (SELECT 1 FROM moments WHERE workspace_id = ?1 AND moment_id = ?2) OR \
             EXISTS (SELECT 1 FROM secret_moments WHERE workspace_id = ?1 AND moment_id = ?2)",
            params![workspace_id, moment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

/// Whether an object owns ANY binding (a path alias in any version or a
/// snapshot row). A bare row with none is a Y.Doc seed preallocation.
fn object_has_any_binding(
    tx: &Transaction<'_>,
    workspace_id: &str,
    object_id: &str,
) -> Result<bool, DomainError> {
    let bound: Option<i64> = tx
        .query_row(
            "SELECT 1 WHERE EXISTS (SELECT 1 FROM path_aliases WHERE workspace_id = ?1 AND object_id = ?2)              OR EXISTS (SELECT 1 FROM snapshots WHERE workspace_id = ?1 AND object_id = ?2)",
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(bound.is_some())
}

fn object_exists(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM file_objects WHERE workspace_id = ?1 AND object_id = ?2",
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

/// True when the object id owns a live `path_aliases` row anywhere in the
/// workspace. Public so ydoc.open can refuse reusing a derived id that
/// capture's locked resolution would disambiguate instead (rename edge).
pub fn object_has_live_alias(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM path_aliases WHERE workspace_id = ?1 AND object_id = ?2 LIMIT 1",
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

fn get_file_object(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<FileObjectRecord>, DomainError> {
    conn.query_row(
        "SELECT workspace_id, object_id, created_at_ms FROM file_objects \
         WHERE workspace_id = ?1 AND object_id = ?2",
        params![workspace_id, object_id],
        |row| {
            Ok(FileObjectRecord {
                workspace_id: row.get(0)?,
                object_id: row.get(1)?,
                created_at_ms: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

fn blob_text(conn: &Connection, sha256: &str) -> Result<Option<String>, DomainError> {
    conn.query_row(
        "SELECT text FROM blobs WHERE sha256 = ?1",
        params![sha256],
        |row| row.get(0),
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

fn alias_object_id(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<String>, DomainError> {
    conn.query_row(
        "SELECT object_id FROM path_aliases WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
        params![workspace_id, version_id, path],
        |row| row.get(0),
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

pub(crate) fn next_moment_order(conn: &Connection) -> Result<i64, DomainError> {
    // Ordinary materialization rows are the durable high-water mark when
    // rollback history surgery removes a tip moment. Pending and terminal
    // mutation/restore jobs guarantee that every later mutation is strictly
    // newer than an already-issued compensating restore. Version-switch
    // projections use snapshot timestamps as generations, so they are a
    // separate ordering domain and must not advance the mutation sequence.
    let max: Option<i64> = conn
        .query_row(
            "SELECT MAX(generation) FROM ( \
                 SELECT moment_order AS generation FROM moments \
                 UNION ALL \
                 SELECT target_generation AS generation FROM materialization_jobs \
                 WHERE job_id NOT GLOB 'version-switch-mat_*' \
                   AND job_id NOT GLOB 'version-switch-secret-mat_*')",
            [],
            |row| row.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    Ok(max.unwrap_or(0) + 1)
}

fn latest_moment_order(
    conn: &Connection,
    query: &ListMomentsQuery,
) -> Result<Option<i64>, DomainError> {
    let mut sql = String::from("SELECT MAX(moment_order) FROM moments WHERE workspace_id = ?1");
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(query.workspace_id.clone())];
    if let Some(version_id) = &query.version_id {
        sql.push_str(" AND version_id = ?");
        sql.push_str(&(binds.len() + 1).to_string());
        binds.push(Box::new(version_id.clone()));
    }
    if let Some(object_id) = &query.object_id {
        sql.push_str(" AND object_id = ?");
        sql.push_str(&(binds.len() + 1).to_string());
        binds.push(Box::new(object_id.clone()));
    }
    let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    conn.query_row(&sql, bind_refs.as_slice(), |row| row.get(0))
        .map_err(DomainError::sql_corrupt)
}

/// The fork point: the latest materialized moment **belonging to the source
/// version** (`versionedTextStore.ts:4877-4884` — "it never touched THIS
/// version's snapshots, so it must never become the fork point"). Scoping to
/// `version_id` is load-bearing: the global-latest moment can belong to a
/// sibling fork, and using it would record a merge base that never described
/// this version's state. `sync_record_only` marker rows (a peer-divergence
/// record) are excluded — a materialized moment is NULL or `0` (PORTING.md §1;
/// the `= 0` arm is latent until a sync shard writes 0).
fn latest_materialized_moment_id(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<Option<String>, DomainError> {
    conn.query_row(
        "SELECT moment_id FROM moments \
         WHERE workspace_id = ?1 AND version_id = ?2 \
           AND (sync_record_only IS NULL OR sync_record_only = 0) \
         ORDER BY moment_order DESC LIMIT 1",
        params![workspace_id, version_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

/// The snapshot row WITHOUT the text join — the in-band reads resolve
/// heads through this so an over-cap body is never copied out of SQLite
/// by the head lookup itself.
struct SnapshotMeta {
    content_kind: String,
    blob_sha256: Option<String>,
    binary_sha256: Option<String>,
    updated_at_ms: i64,
    latest_moment_id: String,
    metadata_origin: String,
    metadata_summary: Option<String>,
    metadata_correlation_id: Option<String>,
}

fn get_snapshot_meta(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<Option<SnapshotMeta>, DomainError> {
    conn.query_row(
        "SELECT COALESCE(content_kind, 'text'), blob_sha256, binary_sha256, \
         updated_at_ms, latest_moment_id, metadata_origin, metadata_summary, \
         metadata_correlation_id FROM snapshots \
         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
        params![workspace_id, version_id, object_id],
        |row| {
            Ok(SnapshotMeta {
                content_kind: row.get(0)?,
                blob_sha256: row.get(1)?,
                binary_sha256: row.get(2)?,
                updated_at_ms: row.get(3)?,
                latest_moment_id: row.get(4)?,
                metadata_origin: row.get(5)?,
                metadata_summary: row.get(6)?,
                metadata_correlation_id: row.get(7)?,
            })
        },
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

fn get_snapshot(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<Option<SnapshotRecord>, DomainError> {
    let row = conn
        .query_row(
            "SELECT s.object_id, s.path, b.text, s.blob_sha256, s.updated_at_ms, \
         s.latest_moment_id, s.metadata_origin, s.metadata_summary, \
         s.metadata_correlation_id, COALESCE(s.content_kind, 'text'), \
         bb.sha256 FROM snapshots s \
         LEFT JOIN blobs b ON b.sha256 = s.blob_sha256 \
         LEFT JOIN binary_blobs bb ON bb.sha256 = s.binary_sha256 \
         WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.object_id = ?3",
            params![workspace_id, version_id, object_id],
            |row| map_snapshot_row(row, workspace_id, version_id),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    row.transpose()
}

/// Enqueue the compensating materialization job that restores DISK to the
/// rolled-back-to state after a binary write whose original job already reached
/// disk (COMPLETE) or was preserved-both (CONFLICT). Mirrors the text write/
/// resolve path (`enqueue_write`/`enqueue_delete`): content bytes live in
/// `binary_blobs` (what the materializer reads) and the job carries the current
/// store-global mutation generation so the newest-wins gate cannot discard an
/// active restore behind a later completed job from another lineage.
///
/// The preimage is the WRITTEN bytes (`written_sha256`): the compensator only
/// acts if disk still holds exactly what the rolled-back write put there, so an
/// external edit after materialization is preserved (conflict), never clobbered.
fn enqueue_binary_rollback_restore(
    tx: &Transaction<'_>,
    input: &RollbackTextFileMutation,
    before: &Option<SnapshotRecord>,
    generation: i64,
    written_sha256: &str,
    now_ms: i64,
) -> Result<(), DomainError> {
    let job_id = binary_rollback_job_identity(
        &input.workspace_id,
        &input.version_id,
        &input.mutation_moment_id,
    );
    let preimage = Preimage::Present(written_sha256.to_owned());
    match before {
        // First write: the rolled-back-to state is ABSENT → delete the file.
        // `content_sha256` must reference an existing `binary_blobs` row (FK); the
        // written bytes still qualify and are unused by a delete job.
        None => enqueue_delete_job(
            tx,
            &MaterializationJobSpec {
                job_id,
                workspace_id: input.workspace_id.clone(),
                target_path: input.path.clone(),
                content_sha256: written_sha256.to_owned(),
                preimage,
                target_generation: generation,
                now_ms,
            },
        )
        .map_err(DomainError::from)?,
        // Overwrite: restore the PREVIOUS content. Text lives in `blobs`; copy its
        // bytes into `binary_blobs` (mirroring `enqueue_write`) and materialize
        // that sha. A previous binary head's bytes are already in `binary_blobs`.
        Some(before) => {
            let content_sha256 = if before.content_kind == "binary" {
                before
                    .binary_sha256
                    .clone()
                    .ok_or(DomainError::StateCorrupt {
                        reason: "binary rollback snapshot has no binary hash",
                    })?
            } else {
                put_binary_blob(tx, before.text.as_bytes()).map_err(DomainError::from)?
            };
            enqueue_job(
                tx,
                &MaterializationJobSpec {
                    job_id,
                    workspace_id: input.workspace_id.clone(),
                    target_path: input.path.clone(),
                    content_sha256,
                    preimage,
                    target_generation: generation,
                    now_ms,
                },
            )
            .map_err(DomainError::from)?;
        }
    }
    Ok(())
}

fn enqueue_binary_delete_rollback_restore(
    tx: &Transaction<'_>,
    input: &RollbackTextFileMutation,
    before: &SnapshotRecord,
    generation: i64,
    now_ms: i64,
) -> Result<(), DomainError> {
    let sha256 = before
        .binary_sha256
        .clone()
        .ok_or(DomainError::StateCorrupt {
            reason: "binary delete rollback snapshot has no binary hash",
        })?;
    enqueue_job(
        tx,
        &MaterializationJobSpec {
            job_id: binary_rollback_job_identity(
                &input.workspace_id,
                &input.version_id,
                &input.mutation_moment_id,
            ),
            workspace_id: input.workspace_id.clone(),
            target_path: before.path.clone(),
            content_sha256: sha256,
            preimage: Preimage::Absent,
            target_generation: generation,
            now_ms,
        },
    )
    .map_err(DomainError::from)
}

fn enqueue_binary_rename_rollback_restore(
    tx: &Transaction<'_>,
    input: &RollbackTextFileMutation,
    before: &SnapshotRecord,
    renamed_path: &str,
    generation: i64,
    now_ms: i64,
) -> Result<(), DomainError> {
    let sha256 = before
        .binary_sha256
        .clone()
        .ok_or(DomainError::StateCorrupt {
            reason: "binary rename rollback snapshot has no binary hash",
        })?;
    let rollback_id = binary_rollback_job_identity(
        &input.workspace_id,
        &input.version_id,
        &input.mutation_moment_id,
    );
    enqueue_job(
        tx,
        &MaterializationJobSpec {
            job_id: binary_rename_write_job_id(&rollback_id),
            workspace_id: input.workspace_id.clone(),
            target_path: before.path.clone(),
            content_sha256: sha256.clone(),
            preimage: Preimage::Absent,
            target_generation: generation,
            now_ms,
        },
    )
    .map_err(DomainError::from)?;
    enqueue_delete_job(
        tx,
        &MaterializationJobSpec {
            job_id: binary_rename_delete_job_id(&rollback_id),
            workspace_id: input.workspace_id.clone(),
            target_path: renamed_path.to_owned(),
            content_sha256: sha256.clone(),
            preimage: Preimage::Present(sha256),
            target_generation: generation,
            now_ms,
        },
    )
    .map_err(DomainError::from)
}

/// Keep binary rollback materialization identities outside caller namespaces
/// and bind them to the version whose disk state they compensate.
#[doc(hidden)]
pub fn binary_rollback_job_identity(
    workspace_id: &str,
    version_id: &str,
    mutation_moment_id: &str,
) -> String {
    format!(
        "{}{mutation_moment_id}",
        binary_rollback_job_version_prefix(workspace_id, version_id)
    )
}

/// Recover the workspace, version, and mutation moment bound into a rollback
/// materialization identity. Legacy identities intentionally return `None`.
#[doc(hidden)]
pub fn decode_binary_rollback_job_identity(job_id: &str) -> Option<(&str, &str, &str)> {
    let encoded = job_id.strip_prefix("rollback-restore_\u{1f}")?;
    let (workspace_len, encoded) = encoded.split_once(':')?;
    let workspace_len = workspace_len.parse::<usize>().ok()?;
    let workspace_id = encoded.get(..workspace_len)?;
    let encoded = encoded.get(workspace_len..)?;
    let (version_len, encoded) = encoded.split_once(':')?;
    let version_len = version_len.parse::<usize>().ok()?;
    let version_id = encoded.get(..version_len)?;
    let mutation_moment_id = encoded.get(version_len..)?.strip_prefix(':')?;
    if mutation_moment_id.is_empty() {
        return None;
    }
    Some((workspace_id, version_id, mutation_moment_id))
}

fn binary_rollback_job_version_prefix(workspace_id: &str, version_id: &str) -> String {
    format!(
        "rollback-restore_\u{1f}{}:{workspace_id}{}:{version_id}:",
        workspace_id.len(),
        version_id.len()
    )
}

/// Remove a still-replayable disk intent only when it is provably owned by the
/// moment being rolled back. Terminal rows remain as generation evidence.
fn cancel_pending_materialization(
    tx: &Transaction<'_>,
    job_id: &str,
    target_path: &str,
    target_generation: i64,
    content_sha256: &str,
) -> Result<(), DomainError> {
    tx.execute(
        "DELETE FROM materialization_jobs \
         WHERE job_id = ?1 AND target_path = ?2 AND target_generation = ?3 \
           AND content_sha256 = ?4 AND status = 'pending'",
        params![job_id, target_path, target_generation, content_sha256],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn upsert_snapshot(conn: &Connection, snapshot: &SnapshotRecord) -> Result<(), DomainError> {
    conn.execute(
        "INSERT INTO snapshots \
         (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, \
          latest_moment_id, metadata_origin, metadata_summary, \
          metadata_correlation_id, content_kind, binary_sha256) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         ON CONFLICT(workspace_id, version_id, object_id) DO UPDATE SET \
          path = excluded.path, blob_sha256 = excluded.blob_sha256, \
          updated_at_ms = excluded.updated_at_ms, latest_moment_id = excluded.latest_moment_id, \
          metadata_origin = excluded.metadata_origin, \
          metadata_summary = excluded.metadata_summary, \
          metadata_correlation_id = excluded.metadata_correlation_id, \
          content_kind = excluded.content_kind, \
          binary_sha256 = excluded.binary_sha256",
        params![
            snapshot.workspace_id,
            snapshot.version_id,
            snapshot.object_id,
            snapshot.path,
            snapshot.blob_sha256,
            snapshot.updated_at_ms,
            snapshot.latest_moment_id,
            snapshot.metadata_origin,
            snapshot.metadata_summary,
            snapshot.metadata_correlation_id,
            snapshot.content_kind,
            snapshot.binary_sha256,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn snapshot_view(snapshot: &SnapshotRecord) -> Result<SnapshotView, DomainError> {
    let content = match snapshot.content_kind.as_str() {
        "text" => {
            if snapshot.blob_sha256.is_none() {
                return Err(DomainError::StateCorrupt {
                    reason: "text snapshot is missing its blob",
                });
            }
            SnapshotContent::Text {
                text: snapshot.text.clone(),
            }
        }
        "binary" => SnapshotContent::Binary {
            sha256: snapshot
                .binary_sha256
                .clone()
                .ok_or(DomainError::StateCorrupt {
                    reason: "binary snapshot is missing its blob",
                })?,
        },
        _ => {
            return Err(DomainError::StateCorrupt {
                reason: "snapshot has an unknown content kind",
            });
        }
    };
    Ok(SnapshotView {
        workspace_id: snapshot.workspace_id.clone(),
        version_id: snapshot.version_id.clone(),
        object_id: snapshot.object_id.clone(),
        path: snapshot.path.clone(),
        content,
        updated_at_ms: snapshot.updated_at_ms,
        latest_moment_id: snapshot.latest_moment_id.clone(),
        metadata_origin: snapshot.metadata_origin.clone(),
        metadata_summary: snapshot.metadata_summary.clone(),
        metadata_correlation_id: snapshot.metadata_correlation_id.clone(),
    })
}

fn snapshot_text_view(snapshot: &SnapshotRecord) -> TextSnapshot {
    TextSnapshot {
        workspace_id: snapshot.workspace_id.clone(),
        version_id: snapshot.version_id.clone(),
        object_id: snapshot.object_id.clone(),
        path: snapshot.path.clone(),
        text: snapshot.text.clone(),
        blob_sha256: snapshot
            .blob_sha256
            .clone()
            .or_else(|| snapshot.binary_sha256.clone())
            .unwrap_or_default(),
        updated_at_ms: snapshot.updated_at_ms,
        latest_moment_id: snapshot.latest_moment_id.clone(),
        metadata_origin: snapshot.metadata_origin.clone(),
        metadata_summary: snapshot.metadata_summary.clone(),
        metadata_correlation_id: snapshot.metadata_correlation_id.clone(),
    }
}

fn select_moment_by_order(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    max_order: i64,
) -> Result<Option<MomentRecord>, DomainError> {
    let row = conn
        .query_row(
            "SELECT moment_order, moment_id, version_id, object_id, path, recorded_at_ms, \
             operation, after_blob_sha256, before_present, before_blob_sha256, \
             before_latest_moment_id, metadata_origin, metadata_summary, \
             metadata_correlation_id, author_json, sync_record_only, \
             COALESCE(after_content_kind, 'text'), after_binary.sha256, \
             COALESCE(before_content_kind, 'text'), before_binary.sha256, \n             CASE WHEN after_text_blob.byte_length <= 131072 AND LENGTH(CAST(after_text_blob.text AS BLOB)) <= 131072 THEN after_text_blob.text END, \n             COALESCE(after_text_blob.byte_length, after_binary.byte_length), \n             CASE WHEN before_text_blob.byte_length <= 131072 AND LENGTH(CAST(before_text_blob.text AS BLOB)) <= 131072 THEN before_text_blob.text END, \n             COALESCE(before_text_blob.byte_length, before_binary.byte_length), \
             COALESCE(LENGTH(CAST(after_text_blob.text AS BLOB)), LENGTH(after_binary.bytes)), \
             COALESCE(LENGTH(CAST(before_text_blob.text AS BLOB)), LENGTH(before_binary.bytes)), \
             m.payload_before_path \
             FROM moments m \
             LEFT JOIN binary_blobs after_binary ON after_binary.sha256 = m.after_binary_sha256 \
             LEFT JOIN binary_blobs before_binary ON before_binary.sha256 = m.before_binary_sha256 \n             LEFT JOIN blobs after_text_blob ON after_text_blob.sha256 = m.after_blob_sha256 \n             LEFT JOIN blobs before_text_blob ON before_text_blob.sha256 = m.before_blob_sha256 \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
               AND moment_order <= ?4 AND (sync_record_only IS NULL OR sync_record_only = 0) \
             ORDER BY moment_order DESC LIMIT 1",
            params![workspace_id, version_id, object_id, max_order],
            map_moment_row,
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    row.transpose()
}

fn inherited_object_moment(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    seen: &mut HashSet<String>,
) -> Result<Option<MomentRecord>, DomainError> {
    if !seen.insert(version_id.to_owned()) {
        return Err(DomainError::StateCorrupt {
            reason: "version fork lineage contains a cycle",
        });
    }
    let version =
        get_version(conn, workspace_id, version_id)?.ok_or(DomainError::StateCorrupt {
            reason: "fork lineage points at a missing version",
        })?;
    let Some(parent_id) = version.fork_version_id else {
        return Ok(None);
    };
    let fork_order = match version.fork_moment_id {
        Some(moment_id) => conn
            .query_row(
                "SELECT moment_order FROM moments WHERE workspace_id = ?1 AND moment_id = ?2",
                params![workspace_id, moment_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(DomainError::sql_corrupt)?
            .ok_or(DomainError::StateCorrupt {
                reason: "fork lineage points at a missing moment",
            })?,
        None => -1,
    };
    if let Some(moment) =
        select_moment_by_order(conn, workspace_id, &parent_id, object_id, fork_order)?
    {
        return Ok(Some(moment));
    }
    inherited_object_moment(conn, workspace_id, &parent_id, object_id, seen)
}

struct RollbackPreimageIdentity {
    object_id: String,
    version_id: String,
    path: String,
    updated_at_ms: i64,
    latest_moment_id: String,
    metadata_origin: String,
    metadata_summary: Option<String>,
    metadata_correlation_id: Option<String>,
}

fn persisted_rollback_preimage_identity(
    conn: &Connection,
    workspace_id: &str,
    moment: &MomentRecord,
) -> Result<Option<RollbackPreimageIdentity>, DomainError> {
    type StoredIdentity = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let stored: StoredIdentity = conn
        .query_row(
            "SELECT before_object_id, before_version_id, before_path, \
             before_updated_at_ms, before_metadata_origin, before_metadata_summary, \
             before_metadata_correlation_id FROM moments \
             WHERE workspace_id = ?1 AND moment_id = ?2",
            params![workspace_id, moment.moment_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map_err(DomainError::sql_corrupt)?;
    let (object_id, version_id, path, updated_at_ms, metadata_origin, summary, correlation_id) =
        stored;
    if path.is_none() && updated_at_ms.is_none() && metadata_origin.is_none() {
        return Ok(None);
    }
    let identity = RollbackPreimageIdentity {
        object_id: object_id.ok_or(DomainError::StateCorrupt {
            reason: "stored moment preimage is missing its object",
        })?,
        version_id: version_id.ok_or(DomainError::StateCorrupt {
            reason: "stored moment preimage is missing its version",
        })?,
        path: path.ok_or(DomainError::StateCorrupt {
            reason: "stored moment preimage is missing its path",
        })?,
        updated_at_ms: updated_at_ms.ok_or(DomainError::StateCorrupt {
            reason: "stored moment preimage is missing its timestamp",
        })?,
        latest_moment_id: moment.before_latest_moment_id.clone().ok_or(
            DomainError::StateCorrupt {
                reason: "stored moment preimage is missing its head",
            },
        )?,
        metadata_origin: metadata_origin.ok_or(DomainError::StateCorrupt {
            reason: "stored moment preimage is missing its metadata origin",
        })?,
        metadata_summary: summary,
        metadata_correlation_id: correlation_id,
    };
    Ok(Some(identity))
}

fn resolve_rollback_before(
    conn: &Connection,
    input: &RollbackTextFileMutation,
    moment: &MomentRecord,
    before_state: MomentBeforeState,
) -> Result<Option<SnapshotRecord>, DomainError> {
    if before_state == MomentBeforeState::Present {
        let identity =
            match persisted_rollback_preimage_identity(conn, &input.workspace_id, moment)? {
                Some(identity) => identity,
                None => {
                    let producer =
                        match &moment.before_latest_moment_id {
                            Some(before_latest_moment_id) => {
                                get_moment(conn, &input.workspace_id, before_latest_moment_id)?
                                    .ok_or(DomainError::StateCorrupt {
                                        reason: "moment preimage producer is missing",
                                    })?
                            }
                            None => previous_object_moment_for_rollback(conn, input, moment)?
                                .ok_or(DomainError::StateCorrupt {
                                    reason: "moment preimage is missing its producer",
                                })?,
                        };
                    RollbackPreimageIdentity {
                        object_id: producer.object_id,
                        version_id: input.version_id.clone(),
                        path: producer.path,
                        updated_at_ms: producer.recorded_at_ms,
                        latest_moment_id: producer.moment_id,
                        metadata_origin: producer.metadata_origin,
                        metadata_summary: producer.metadata_summary,
                        metadata_correlation_id: producer.metadata_correlation_id,
                    }
                }
            };
        if identity.object_id != moment.object_id {
            return Err(DomainError::StateCorrupt {
                reason: "moment preimage producer belongs to another object",
            });
        }
        if identity.version_id != input.version_id {
            return Err(DomainError::StateCorrupt {
                reason: "moment preimage belongs to another version",
            });
        }
        let (text, blob_sha256, binary_sha256) = match moment.before_content_kind.as_str() {
            "text" => {
                let sha = moment
                    .before_blob_sha256
                    .clone()
                    .ok_or(DomainError::StateCorrupt {
                        reason: "text moment preimage is missing its blob",
                    })?;
                let text = blob_text(conn, &sha)?.ok_or(DomainError::StateCorrupt {
                    reason: "moment preimage blob is missing",
                })?;
                (text, Some(sha), None)
            }
            "binary" => {
                let sha = moment
                    .before_binary_sha256
                    .clone()
                    .ok_or(DomainError::StateCorrupt {
                        reason: "binary moment preimage is missing its blob",
                    })?;
                let exists: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM binary_blobs WHERE sha256 = ?1",
                        params![sha],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(DomainError::sql_corrupt)?;
                if exists.is_none() {
                    return Err(DomainError::StateCorrupt {
                        reason: "binary moment preimage blob is missing",
                    });
                }
                (String::new(), None, Some(sha))
            }
            _ => {
                return Err(DomainError::StateCorrupt {
                    reason: "moment preimage has an unknown content kind",
                });
            }
        };
        return Ok(Some(SnapshotRecord {
            workspace_id: input.workspace_id.clone(),
            version_id: input.version_id.clone(),
            object_id: moment.object_id.clone(),
            path: identity.path,
            text,
            blob_sha256,
            content_kind: moment.before_content_kind.clone(),
            binary_sha256,
            updated_at_ms: identity.updated_at_ms,
            latest_moment_id: identity.latest_moment_id,
            metadata_origin: identity.metadata_origin,
            metadata_summary: identity.metadata_summary,
            metadata_correlation_id: identity.metadata_correlation_id,
        }));
    }
    if before_state == MomentBeforeState::Absent {
        return Ok(None);
    }

    let previous = previous_object_moment_for_rollback(conn, input, moment)?;

    if let Some(legacy_before_text) = &input.legacy_before_text {
        validate_text(legacy_before_text)?;
        let previous = previous
            .filter(|candidate| candidate.operation != MomentOp::Delete)
            .ok_or(DomainError::InvalidInput {
                reason: "legacy mutation has no earlier snapshot to restore",
            })?;
        let path = if moment.operation == MomentOp::Rename {
            previous.path.clone()
        } else {
            input.path.clone()
        };
        return Ok(Some(SnapshotRecord {
            workspace_id: input.workspace_id.clone(),
            version_id: input.version_id.clone(),
            object_id: moment.object_id.clone(),
            path,
            text: legacy_before_text.clone(),
            blob_sha256: Some(text_blob_sha256(legacy_before_text)),
            content_kind: "text".to_owned(),
            binary_sha256: None,
            updated_at_ms: previous.recorded_at_ms,
            latest_moment_id: previous.moment_id,
            metadata_origin: previous.metadata_origin,
            metadata_summary: previous.metadata_summary,
            metadata_correlation_id: previous.metadata_correlation_id,
        }));
    }
    Err(DomainError::InvalidInput {
        reason: "legacy mutation is missing a rollback preimage",
    })
}

fn previous_object_moment_for_rollback(
    conn: &Connection,
    input: &RollbackTextFileMutation,
    moment: &MomentRecord,
) -> Result<Option<MomentRecord>, DomainError> {
    let previous = select_moment_by_order(
        conn,
        &input.workspace_id,
        &input.version_id,
        &moment.object_id,
        moment.moment_order.saturating_sub(1),
    )?;
    let previous = match previous {
        Some(previous) => Some(previous),
        None => inherited_object_moment(
            conn,
            &input.workspace_id,
            &input.version_id,
            &moment.object_id,
            &mut HashSet::new(),
        )?,
    };
    Ok(previous)
}

fn moment_before_state(
    conn: &Connection,
    workspace_id: &str,
    moment_id: &str,
) -> Result<MomentBeforeState, DomainError> {
    let value: i64 = conn
        .query_row(
            "SELECT before_present FROM moments WHERE workspace_id = ?1 AND moment_id = ?2",
            params![workspace_id, moment_id],
            |row| row.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    MomentBeforeState::from_db(value)
}

fn later_materialized_object_moment_exists(
    conn: &Connection,
    workspace_id: &str,
    moment: &MomentRecord,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM moments WHERE workspace_id = ?1 AND version_id = ?2 \
             AND object_id = ?3 AND moment_order > ?4 \
             AND (sync_record_only IS NULL OR sync_record_only = 0) LIMIT 1",
            params![
                workspace_id,
                moment.version_id,
                moment.object_id,
                moment.moment_order
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

struct ObjectMomentDependency {
    version_id: String,
    moment_order: i64,
    before_present: bool,
}

fn rollback_moment_has_dependents(
    conn: &Connection,
    workspace_id: &str,
    moment: &MomentRecord,
) -> Result<bool, DomainError> {
    let snapshot_reference: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM snapshots WHERE workspace_id = ?1 AND version_id <> ?2 \
             AND latest_moment_id = ?3 LIMIT 1",
            params![workspace_id, moment.version_id, moment.moment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if snapshot_reference.is_some() {
        return Ok(true);
    }
    let fork_base_reference: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM fork_base_snapshots WHERE workspace_id = ?1 \
             AND latest_moment_id = ?2 LIMIT 1",
            params![workspace_id, moment.moment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if fork_base_reference.is_some() {
        return Ok(true);
    }
    let moment_reference: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM moments WHERE workspace_id = ?1 AND moment_id <> ?2 \
             AND object_id = ?3 AND before_latest_moment_id = ?2 \
             AND (sync_record_only IS NULL OR sync_record_only = 0) LIMIT 1",
            params![workspace_id, moment.moment_id, moment.object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if moment_reference.is_some() {
        return Ok(true);
    }
    // Fail closed if a concrete preimage has no resolved producer link.
    let unresolved_reference: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM moments WHERE workspace_id = ?1 AND object_id = ?2 \
             AND before_present = 2 AND before_latest_moment_id IS NULL LIMIT 1",
            params![workspace_id, moment.object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if unresolved_reference.is_some() {
        return Ok(true);
    }

    let mut versions = HashMap::new();
    let mut version_stmt = conn
        .prepare_cached(
            "SELECT workspace_id, version_id, kind, name, created_at_ms, fork_version_id, \
             fork_moment_id FROM versions WHERE workspace_id = ?1",
        )
        .map_err(DomainError::sql_corrupt)?;
    let version_rows = version_stmt
        .query_map(params![workspace_id], map_version_row)
        .map_err(DomainError::sql_corrupt)?;
    for row in version_rows {
        let version = row.map_err(DomainError::sql_corrupt)??;
        versions.insert(version.version_id.clone(), version);
    }

    let fork_moment_ids: HashSet<&str> = versions
        .values()
        .filter_map(|version| version.fork_moment_id.as_deref())
        .collect();
    let mut moment_orders = HashMap::with_capacity(fork_moment_ids.len());
    let mut order_stmt = conn
        .prepare_cached(
            "SELECT moment_order FROM moments WHERE workspace_id = ?1 AND moment_id = ?2",
        )
        .map_err(DomainError::sql_corrupt)?;
    for moment_id in fork_moment_ids {
        let moment_order = order_stmt
            .query_row(params![workspace_id, moment_id], |row| row.get(0))
            .optional()
            .map_err(DomainError::sql_corrupt)?;
        if let Some(moment_order) = moment_order {
            moment_orders.insert(moment_id.to_owned(), moment_order);
        }
    }

    let mut object_moments = Vec::new();
    let mut object_stmt = conn
        .prepare_cached(
            "SELECT version_id, moment_order, before_present FROM moments \
             WHERE workspace_id = ?1 AND object_id = ?2 \
               AND (sync_record_only IS NULL OR sync_record_only = 0) ORDER BY moment_order",
        )
        .map_err(DomainError::sql_corrupt)?;
    let object_rows = object_stmt
        .query_map(params![workspace_id, moment.object_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(DomainError::sql_corrupt)?;
    for row in object_rows {
        let (version_id, moment_order, before_present) = row.map_err(DomainError::sql_corrupt)?;
        object_moments.push(ObjectMomentDependency {
            version_id,
            moment_order,
            before_present: MomentBeforeState::from_db(before_present)?
                == MomentBeforeState::Present,
        });
    }

    for version in versions.values() {
        if version.version_id == moment.version_id {
            continue;
        }
        let Some(fork_order) =
            fork_order_from_version(version, &versions, &moment_orders, &moment.version_id)
        else {
            continue;
        };
        if fork_order >= moment.moment_order
            && (fork_order == moment.moment_order
                || !lineage_has_independent_object_mutation(
                    &version.version_id,
                    fork_order,
                    &moment.version_id,
                    &versions,
                    &moment_orders,
                    &object_moments,
                ))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn fork_order_from_version(
    version: &VersionRecord,
    versions: &HashMap<String, VersionRecord>,
    moment_orders: &HashMap<String, i64>,
    target_version_id: &str,
) -> Option<i64> {
    let mut cursor = Some(version);
    let mut seen = HashSet::new();
    while let Some(version) = cursor {
        let parent_id = version.fork_version_id.as_deref()?;
        if !seen.insert(version.version_id.as_str()) {
            return None;
        }
        if parent_id == target_version_id {
            return version
                .fork_moment_id
                .as_ref()
                .and_then(|id| moment_orders.get(id).copied());
        }
        cursor = versions.get(parent_id);
    }
    None
}

fn lineage_has_independent_object_mutation(
    candidate_version_id: &str,
    after_order: i64,
    target_version_id: &str,
    versions: &HashMap<String, VersionRecord>,
    moment_orders: &HashMap<String, i64>,
    object_moments: &[ObjectMomentDependency],
) -> bool {
    let mut cursor = versions.get(candidate_version_id);
    let mut at_or_before_order = i64::MAX;
    let mut seen = HashSet::new();
    while let Some(version) = cursor {
        if !seen.insert(version.version_id.as_str()) {
            return false;
        }
        // TS value 2 is a concrete preimage (reachable for R05 update/delete/
        // rename); Rust's bool represents it as `true`. Rust intentionally
        // collapses TS legacy-unset (0) and explicit-absent (1) to `false`;
        // this dependency check only needs the concrete-preimage distinction.
        if object_moments.iter().any(|candidate| {
            candidate.version_id == version.version_id
                && candidate.moment_order > after_order
                && candidate.moment_order <= at_or_before_order
                && candidate.before_present
        }) {
            return true;
        }
        let Some(parent_id) = version.fork_version_id.as_deref() else {
            return false;
        };
        if parent_id == target_version_id {
            return false;
        }
        at_or_before_order = version
            .fork_moment_id
            .as_ref()
            .and_then(|id| moment_orders.get(id).copied())
            .unwrap_or(-1);
        cursor = versions.get(parent_id);
    }
    false
}

fn object_has_references(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 WHERE \
             EXISTS (SELECT 1 FROM path_aliases WHERE workspace_id = ?1 AND object_id = ?2) OR \
             EXISTS (SELECT 1 FROM snapshots WHERE workspace_id = ?1 AND object_id = ?2) OR \
             EXISTS (SELECT 1 FROM fork_base_snapshots WHERE workspace_id = ?1 AND object_id = ?2) OR \
             EXISTS (SELECT 1 FROM moments WHERE workspace_id = ?1 AND object_id = ?2) LIMIT 1",
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

fn get_version(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<Option<VersionRecord>, DomainError> {
    let row = conn
        .query_row(
            "SELECT workspace_id, version_id, kind, name, created_at_ms, fork_version_id, \
             fork_moment_id FROM versions WHERE workspace_id = ?1 AND version_id = ?2",
            params![workspace_id, version_id],
            map_version_row,
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    row.transpose()
}

pub(crate) fn get_moment(
    conn: &Connection,
    workspace_id: &str,
    moment_id: &str,
) -> Result<Option<MomentRecord>, DomainError> {
    let row = conn
        .query_row(
            "SELECT moment_order, moment_id, version_id, object_id, path, recorded_at_ms, \
             operation, after_blob_sha256, before_present, before_blob_sha256, \
             before_latest_moment_id, metadata_origin, metadata_summary, \
             metadata_correlation_id, author_json, sync_record_only, \
             COALESCE(after_content_kind, 'text'), after_binary.sha256, \
             COALESCE(before_content_kind, 'text'), before_binary.sha256, \n             CASE WHEN after_text_blob.byte_length <= 131072 AND LENGTH(CAST(after_text_blob.text AS BLOB)) <= 131072 THEN after_text_blob.text END, \n             COALESCE(after_text_blob.byte_length, after_binary.byte_length), \n             CASE WHEN before_text_blob.byte_length <= 131072 AND LENGTH(CAST(before_text_blob.text AS BLOB)) <= 131072 THEN before_text_blob.text END, \n             COALESCE(before_text_blob.byte_length, before_binary.byte_length), \
             COALESCE(LENGTH(CAST(after_text_blob.text AS BLOB)), LENGTH(after_binary.bytes)), \
             COALESCE(LENGTH(CAST(before_text_blob.text AS BLOB)), LENGTH(before_binary.bytes)), \
             m.payload_before_path \
             FROM moments m \
             LEFT JOIN binary_blobs after_binary ON after_binary.sha256 = m.after_binary_sha256 \
             LEFT JOIN binary_blobs before_binary ON before_binary.sha256 = m.before_binary_sha256 \n             LEFT JOIN blobs after_text_blob ON after_text_blob.sha256 = m.after_blob_sha256 \n             LEFT JOIN blobs before_text_blob ON before_text_blob.sha256 = m.before_blob_sha256 \
             WHERE workspace_id = ?1 AND moment_id = ?2",
            params![workspace_id, moment_id],
            map_moment_row,
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    row.transpose()
}

fn moment_by_order(
    conn: &Connection,
    workspace_id: &str,
    moment_order: i64,
) -> Result<Option<MomentRecord>, DomainError> {
    let moment_id = conn
        .query_row(
            "SELECT moment_id FROM moments WHERE workspace_id = ?1 AND moment_order = ?2",
            params![workspace_id, moment_order],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    match moment_id {
        Some(moment_id) => get_moment(conn, workspace_id, &moment_id),
        None => Ok(None),
    }
}

pub(crate) fn lookup_request(
    conn: &Connection,
    request_id: &str,
) -> Result<Option<RecordedRequest>, DomainError> {
    conn.query_row(
        "SELECT payload_hash, result_seq FROM engine_requests WHERE request_id = ?1",
        params![request_id],
        |row| {
            Ok(RecordedRequest {
                payload_hash: row.get(0)?,
                result_seq: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

pub(crate) fn record_request(
    tx: &Connection,
    request_id: Option<&str>,
    payload_hash: &str,
    result_seq: i64,
    now_ms: i64,
) -> Result<(), DomainError> {
    if let Some(request_id) = request_id {
        tx.execute(
            "INSERT INTO engine_requests \
             (request_id, payload_hash, result_seq, committed_at, kind) \
             VALUES (?1, ?2, ?3, ?4, 'versioned')",
            params![request_id, payload_hash, result_seq, now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    }
    Ok(())
}

pub(crate) fn record_merge_request(
    tx: &Connection,
    request_id: Option<&str>,
    payload_hash: &str,
    result_seq: i64,
    now_ms: i64,
) -> Result<(), DomainError> {
    if let Some(request_id) = request_id {
        tx.execute(
            "INSERT INTO engine_requests \
             (request_id, payload_hash, result_seq, committed_at, kind) \
             VALUES (?1, ?2, ?3, ?4, 'merge')",
            params![request_id, payload_hash, result_seq, now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    }
    Ok(())
}

/// Row mapper for `versions`. Reads the raw columns at the rusqlite level
/// (outer `?`), then maps the enum column into `DomainError` (a bad value is
/// `state-corrupt`) — a nested `Result` the caller flattens.
fn map_version_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<VersionRecord, DomainError>> {
    let workspace_id: String = row.get(0)?;
    let version_id: String = row.get(1)?;
    let kind_str: String = row.get(2)?;
    let name: String = row.get(3)?;
    let created_at_ms: i64 = row.get(4)?;
    let fork_version_id: Option<String> = row.get(5)?;
    let fork_moment_id: Option<String> = row.get(6)?;
    Ok(VersionKind::from_db(&kind_str).map(|kind| VersionRecord {
        workspace_id,
        version_id,
        kind,
        name,
        created_at_ms,
        fork_version_id,
        fork_moment_id,
    }))
}

fn map_snapshot_row(
    row: &rusqlite::Row<'_>,
    workspace_id: &str,
    version_id: &str,
) -> rusqlite::Result<Result<SnapshotRecord, DomainError>> {
    let object_id: String = row.get(0)?;
    let path: String = row.get(1)?;
    let text: Option<String> = row.get(2)?;
    let blob_sha256: Option<String> = row.get(3)?;
    let updated_at_ms: i64 = row.get(4)?;
    let latest_moment_id: String = row.get(5)?;
    let metadata_origin: String = row.get(6)?;
    let metadata_summary: Option<String> = row.get(7)?;
    let metadata_correlation_id: Option<String> = row.get(8)?;
    let content_kind: String = row.get(9)?;
    let binary_sha256: Option<String> = row.get(10)?;
    let text = match content_kind.as_str() {
        "text" => text.ok_or(DomainError::StateCorrupt {
            reason: "text snapshot is missing its blob",
        }),
        "binary" if binary_sha256.is_some() => Ok(String::new()),
        "binary" => Err(DomainError::StateCorrupt {
            reason: "binary snapshot is missing its blob",
        }),
        _ => Err(DomainError::StateCorrupt {
            reason: "snapshot has an unknown content kind",
        }),
    };
    Ok(text.map(|text| SnapshotRecord {
        workspace_id: workspace_id.to_owned(),
        version_id: version_id.to_owned(),
        object_id,
        path,
        text,
        blob_sha256,
        content_kind,
        binary_sha256,
        updated_at_ms,
        latest_moment_id,
        metadata_origin,
        metadata_summary,
        metadata_correlation_id,
    }))
}

fn map_moment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<MomentRecord, DomainError>> {
    let moment_order: i64 = row.get(0)?;
    let moment_id: String = row.get(1)?;
    let version_id: String = row.get(2)?;
    let object_id: String = row.get(3)?;
    let path: String = row.get(4)?;
    let recorded_at_ms: i64 = row.get(5)?;
    let op_str: String = row.get(6)?;
    let after_blob_sha256: Option<String> = row.get(7)?;
    let before_present_raw: i64 = row.get(8)?;
    let before_blob_sha256: Option<String> = row.get(9)?;
    let before_latest_moment_id: Option<String> = row.get(10)?;
    let metadata_origin: String = row.get(11)?;
    let metadata_summary: Option<String> = row.get(12)?;
    let metadata_correlation_id: Option<String> = row.get(13)?;
    let author_json: Option<String> = row.get(14)?;
    let sync_record_only: Option<i64> = row.get(15)?;
    let after_content_kind: String = row.get(16)?;
    let after_binary_sha256: Option<String> = row.get(17)?;
    let before_content_kind: String = row.get(18)?;
    let before_binary_sha256: Option<String> = row.get(19)?;
    let after_text: Option<String> = row.get(20)?;
    let after_byte_length: Option<i64> = row.get(21)?;
    let before_text: Option<String> = row.get(22)?;
    let before_byte_length: Option<i64> = row.get(23)?;
    let after_actual_length: Option<i64> = row.get(24)?;
    let before_actual_length: Option<i64> = row.get(25)?;
    let before_path: Option<String> = row.get(26)?;
    // Recorded and ACTUAL lengths must agree per side — a corrupted
    // recorded length (lying small or large) fails closed for text and
    // binary alike, matching the in-band reads.
    if after_byte_length != after_actual_length || before_byte_length != before_actual_length {
        return Ok(Err(DomainError::StateCorrupt {
            reason: "moment blob length does not match its content",
        }));
    }
    // Byte lengths ALWAYS hydrate (only the text is capped): a side whose
    // sha is set but whose joined length is NULL references a missing
    // blob row — corrupt state, never "over-cap".
    if (after_blob_sha256.is_some() || after_binary_sha256.is_some()) && after_byte_length.is_none()
    {
        return Ok(Err(DomainError::StateCorrupt {
            reason: "moment after side references a missing blob row",
        }));
    }
    if (before_blob_sha256.is_some() || before_binary_sha256.is_some())
        && before_byte_length.is_none()
    {
        return Ok(Err(DomainError::StateCorrupt {
            reason: "moment before side references a missing blob row",
        }));
    }
    Ok(MomentOp::from_db(&op_str).and_then(|operation| {
        let before_state = MomentBeforeState::from_db(before_present_raw)?;
        match after_content_kind.as_str() {
            "text" if after_blob_sha256.is_some() => {}
            "binary" if after_binary_sha256.is_some() => {}
            "text" => {
                return Err(DomainError::StateCorrupt {
                    reason: "text moment is missing its after blob",
                });
            }
            "binary" => {
                return Err(DomainError::StateCorrupt {
                    reason: "binary moment is missing its after blob",
                });
            }
            _ => {
                return Err(DomainError::StateCorrupt {
                    reason: "moment has an unknown after content kind",
                });
            }
        }
        if before_state == MomentBeforeState::Present {
            match before_content_kind.as_str() {
                "text" if before_blob_sha256.is_some() => {}
                "binary" if before_binary_sha256.is_some() => {}
                "text" => {
                    return Err(DomainError::StateCorrupt {
                        reason: "text moment preimage is missing its blob",
                    });
                }
                "binary" => {
                    return Err(DomainError::StateCorrupt {
                        reason: "binary moment preimage is missing its blob",
                    });
                }
                _ => {
                    return Err(DomainError::StateCorrupt {
                        reason: "moment has an unknown before content kind",
                    });
                }
            }
        }
        Ok(MomentRecord {
            moment_order,
            moment_id,
            version_id,
            object_id,
            path,
            recorded_at_ms,
            operation,
            after_content_kind,
            after_blob_sha256,
            after_binary_sha256,
            before_present: before_state == MomentBeforeState::Present,
            before_blob_sha256,
            before_content_kind,
            before_binary_sha256,
            before_latest_moment_id,
            metadata_origin,
            metadata_summary,
            metadata_correlation_id,
            author_json,
            // A record-only marker is a non-NULL, NON-ZERO value; NULL or 0 both
            // mean 'materialized' (PORTING.md §1, matching the aligned fork SQL).
            sync_record_only: matches!(sync_record_only, Some(v) if v != 0),
            after_text,
            after_byte_length,
            before_text,
            before_byte_length,
            before_path,
        })
    }))
}

/// Content-addressed sha256 (lowercase hex) of a text blob. Public so the
/// differential harness can derive the expected content hashes (N8).
pub fn text_blob_sha256(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex(&hasher.finalize())
}

/// Derive the stable workspace-scoped object id for a captured version-local
/// path: `object-` plus lowercase-hex SHA-256 over length-prefixed
/// `workspace_id`, `version_id`, and `path` fields.
pub fn derive_capture_object_id(workspace_id: &str, version_id: &str, path: &str) -> String {
    format!(
        "object-{}",
        hash_fields(&[
            workspace_id.as_bytes(),
            version_id.as_bytes(),
            path.as_bytes(),
        ])
    )
}

fn derive_disambiguated_capture_object_id(
    workspace_id: &str,
    version_id: &str,
    path: &str,
    next_moment_order: i64,
) -> String {
    let next_moment_order = next_moment_order.to_string();
    format!(
        "object-{}",
        hash_fields(&[
            workspace_id.as_bytes(),
            version_id.as_bytes(),
            path.as_bytes(),
            next_moment_order.as_bytes(),
        ])
    )
}

/// Derive a capture moment id from its workspace, object, and next monotonic
/// moment order: `moment-` plus lowercase-hex SHA-256 over those length-prefixed
/// fields. The store allocates the same order inside the caller-owned write
/// transaction, so delete/recreate cycles never reuse an id.
pub fn derive_capture_moment_id(
    workspace_id: &str,
    object_id: &str,
    next_moment_order: i64,
) -> String {
    let next_moment_order = next_moment_order.to_string();
    format!(
        "moment-{}",
        hash_fields(&[
            workspace_id.as_bytes(),
            object_id.as_bytes(),
            next_moment_order.as_bytes(),
        ])
    )
}

/// Derive a capture delete moment id with the same order-based scheme as a
/// capture write.
pub fn derive_capture_retire_moment_id(
    workspace_id: &str,
    object_id: &str,
    next_moment_order: i64,
) -> String {
    derive_capture_moment_id(workspace_id, object_id, next_moment_order)
}

/// Deterministic fingerprint over length-framed fields (idempotency
/// payloads). Length framing means a NUL or any other byte inside a
/// caller-supplied field can never shift field boundaries and collide two
/// different payloads.
pub(crate) fn hash_fields(fields: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for field in fields {
        hasher.update((field.len() as u64).to_le_bytes());
        hasher.update(field);
    }
    hex(&hasher.finalize())
}

fn hash_author_fields(author_json: Option<&str>) -> (&'static [u8], &[u8]) {
    match author_json {
        Some(author_json) => (b"some", author_json.as_bytes()),
        None => (b"none", b""),
    }
}

fn hash_optional_text_fields(value: Option<&str>) -> (&'static [u8], &[u8]) {
    match value {
        Some(value) => (b"some", value.as_bytes()),
        None => (b"none", b""),
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}
