//! [`VersionedTextStore`]: the versioning domain over the storage core.
//!
//! It borrows the actor's single [`EngineStore`] and composes its versioning
//! SQL through the storage seams — reads via [`EngineStore::read_with`], every
//! compound mutation via [`EngineStore::write_with`] so the domain write and
//! any idempotency-ledger row commit in one transaction. Storage owns
//! the connection, open ritual, transaction boundary, and the crash-injection
//! fault seam; the domain owns what a version/moment/fork/restore *means*.
//!
//! Validation (existence, name conflicts, duplicate moment ids) runs as reads
//! before `BEGIN IMMEDIATE`. That is sound here precisely because of the
//! single-writer invariant the runtime enforces (one writer thread per store):
//! no concurrent writer can invalidate a check between the read and the
//! transaction.

mod binary_write;
mod capture_write;
mod request_ledger;
mod rollback;

pub use binary_write::write_binary_in_tx;
pub use capture_write::{
    CAPTURE_ORIGIN, CaptureIngestBatchContext, CaptureManifestSeedEntry,
    MAX_CAPTURE_BINARY_FILE_BYTES, ProjectedWriteText, SECRET_SEED_SENTINEL_SHA, YDOC_ORIGIN,
    capture_ingest_binary_in_tx, capture_ingest_binary_with_admission_in_tx,
    capture_ingest_in_batch_with_admission_in_tx, capture_ingest_in_tx,
    capture_ingest_with_admission_in_tx, capture_manifest_seed, capture_retire_in_tx,
    derive_capture_moment_id, derive_capture_object_id, derive_capture_retire_moment_id,
    validate_write_input, write_projected_text_in_tx, write_text_in_tx,
};

pub use rollback::{
    binary_rollback_job_identity, decode_binary_rollback_job_identity,
    rollback_compensating_moment_id,
};

pub(crate) use request_ledger::{
    hash_author_fields, hash_fields, hash_optional_text_fields, lookup_request,
    record_merge_request, record_request,
};

use crate::error::DomainError;
use crate::records::{
    BinaryBlobRead, BinaryHead, CreateNamedVersion, DeleteResult, DeleteTextFile, FileObjectRecord,
    InbandBinary, InbandText, ListMomentsQuery, MomentOp, MomentPage, MomentRecord, RenameResult,
    RenameTextFile, SnapshotContent, SnapshotMetadata, SnapshotRecord, SnapshotView, TextBlobRead,
    TextSnapshot, VersionKind, VersionRecord, WriteResult,
};
use dohc_engine_storage::{
    EngineStore, FaultInjector, MAX_IDENTIFIER_BYTES, StorageError, TxnOutcome,
    cancel_pending_jobs_for_path, hex,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};

/// Maximum text-file size accepted by [`VersionedTextStore::write_text`], in
/// UTF-8 bytes. Mirrors the TS engine's 10 MB text cap
/// (`versions-write-text-file`).
pub const MAX_TEXT_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_METADATA_FIELD_BYTES: usize = 16 * 1024;
pub const MAX_AUTHOR_FIELD_BYTES: usize = MAX_IDENTIFIER_BYTES;
pub const MAX_AUTHOR_JSON_BYTES: usize = 10 * 1024;

/// The in-band content cap every capped read binds into its SQL and every
/// RPC references — one definition, so the query guard and the wire
/// contract can never drift apart.
pub const INBAND_CONTENT_CAP_BYTES: usize = 48 * 1024;

// The moment-hydration SQL embeds the cap as a literal (prepare_cached
// wants a static string); this assertion pins the literal to the
// constant so they cannot drift.
const _: () = assert!(INBAND_CONTENT_CAP_BYTES == 49152);

// `get_moment` hydrates text payloads through this larger history-only cap.
// Its SQL is static, so keep the construction path for prepared capture
// results pinned to the same literal.
const MOMENT_TEXT_HYDRATION_CAP_BYTES: usize = 128 * 1024;
const _: () = assert!(MOMENT_TEXT_HYDRATION_CAP_BYTES == 131072);

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
        validate_identifier(workspace_id, "workspace_id")?;
        validate_identifier(main_version_id, "version_id")?;

        if let Some(existing_main) = self
            .store
            .read_with(|conn| workspace_main_version_id(conn, workspace_id))?
        {
            return self.require_version(workspace_id, &existing_main);
        }

        let ws = workspace_id.to_owned();
        let ver = main_version_id.to_owned();
        let outcome = self.store.write_with(faults, |tx| {
            ensure_main_version_in_tx(tx, &ws, &ver, now_ms)
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
        validate_identifier(workspace_id, "workspace_id")?;
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
        validate_identifier(&input.workspace_id, "workspace_id")?;
        validate_identifier(&input.version_id, "version_id")?;
        validate_moment_id(&input.moment_id)?;
        validate_moment_metadata(
            input.metadata_origin.as_str(),
            input.metadata_summary.as_deref(),
            input.metadata_correlation_id.as_deref(),
            input.author_json.as_deref(),
        )?;
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
            crate::collections::index_historical_record_owner_moment_in_tx(tx, ws, moment_order)?;
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
    /// FAIL-CLOSED ON BINARY: a live binary head at `path` is not text, so this
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

    /// Read the binary head at `path`: the stored sha plus the blob bytes.
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
        validate_identifier(workspace_id, "workspace_id")?;
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

    /// Read a text blob only when the caller's workspace has a durable head,
    /// fork base, moment, or conflict-side reference to it.
    pub fn read_text_blob(
        &self,
        workspace_id: &str,
        sha256: &str,
    ) -> Result<Option<TextBlobRead>, DomainError> {
        self.read_text_blob_with_hydration(workspace_id, sha256, false)
    }

    /// Read a workspace-referenced text blob hydrated even above the in-band cap.
    pub fn read_text_blob_for_egress(
        &self,
        workspace_id: &str,
        sha256: &str,
    ) -> Result<Option<TextBlobRead>, DomainError> {
        self.read_text_blob_with_hydration(workspace_id, sha256, true)
    }

    fn read_text_blob_with_hydration(
        &self,
        workspace_id: &str,
        sha256: &str,
        hydrate_over_cap: bool,
    ) -> Result<Option<TextBlobRead>, DomainError> {
        validate_identifier(workspace_id, "workspace_id")?;
        self.store.read_with(|conn| {
            let referenced: bool = conn
                .query_row(
                    "SELECT EXISTS(\
                         SELECT 1 FROM snapshots \
                         WHERE workspace_id = ?1 AND blob_sha256 = ?2\
                     ) OR EXISTS(\
                         SELECT 1 FROM fork_base_snapshots \
                         WHERE workspace_id = ?1 AND blob_sha256 = ?2\
                     ) OR EXISTS(\
                         SELECT 1 FROM moments \
                         WHERE workspace_id = ?1 \
                           AND (after_blob_sha256 = ?2 OR before_blob_sha256 = ?2)\
                     ) OR EXISTS(\
                         SELECT 1 FROM conflicts \
                         WHERE workspace_id = ?1 \
                           AND (base_blob_sha256 = ?2 \
                                OR current_blob_sha256 = ?2 \
                                OR incoming_blob_sha256 = ?2)\
                     )",
                    params![workspace_id, sha256],
                    |row| row.get(0),
                )
                .map_err(DomainError::sql_corrupt)?;
            if !referenced {
                return Ok(None);
            }
            let lengths: Option<(i64, i64)> = conn
                .query_row(
                    "SELECT byte_length, LENGTH(CAST(text AS BLOB)) \
                     FROM blobs WHERE sha256 = ?1",
                    params![sha256],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?;
            let Some((byte_length, actual_length)) = lengths else {
                return Err(DomainError::StateCorrupt {
                    reason: "referenced text blob is missing",
                });
            };
            if byte_length < 0 {
                return Err(DomainError::StateCorrupt {
                    reason: "text blob has a negative recorded length",
                });
            }
            if byte_length != actual_length {
                return Err(DomainError::StateCorrupt {
                    reason: "text blob length does not match its text",
                });
            }
            if byte_length as usize > INBAND_CONTENT_CAP_BYTES && !hydrate_over_cap {
                return Ok(Some(TextBlobRead {
                    byte_length,
                    text: None,
                }));
            }
            let text = blob_text(conn, sha256)?.ok_or(DomainError::StateCorrupt {
                reason: "referenced text blob is missing",
            })?;
            if text_blob_sha256(&text) != sha256 {
                return Err(DomainError::StateCorrupt {
                    reason: "text blob digest does not match its text",
                });
            }
            Ok(Some(TextBlobRead {
                byte_length,
                text: Some(text),
            }))
        })
    }

    /// Read a text head with the body hydrated only under `cap` bytes —
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

    /// Read a binary head with the bytes hydrated only under `cap` — the
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
            // Both guards in the hydration CASE: a corrupt row whose
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
            // Bytes that will be served are re-hashed (get_binary_blob
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
                     COALESCE(s.content_kind, 'text'), bb.sha256, \
                     EXISTS (SELECT 1 FROM ydoc_docs d \
                       WHERE d.workspace_id = s.workspace_id \
                         AND d.version_id = s.version_id \
                         AND d.object_id = s.object_id) FROM snapshots s \
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
                            has_ydoc_marker: row.get(11)?,
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
        validate_identifier(&input.workspace_id, "workspace_id")?;
        validate_identifier(&input.new_version_id, "version_id")?;
        validate_identifier(&input.from_version_id, "version_id")?;
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
    /// divergence marker can never become the fork point.
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
        validate_identifier(&input.workspace_id, "workspace_id")?;
        validate_identifier(&input.new_version_id, "version_id")?;
        validate_identifier(&input.from_version_id, "version_id")?;
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
            crate::secrets::fork_version_in_tx(
                tx,
                ws,
                &input.from_version_id,
                &input.new_version_id,
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

/// Ensure the workspace's main version inside the caller's transaction.
///
/// Capture uses this seam so root-identity validation, first-version
/// bootstrap, and the captured file commit share one rollback boundary.
pub fn ensure_main_version_in_tx(
    tx: &Connection,
    workspace_id: &str,
    main_version_id: &str,
    now_ms: i64,
) -> Result<VersionRecord, DomainError> {
    validate_identifier(workspace_id, "workspace_id")?;
    validate_identifier(main_version_id, "version_id")?;

    if let Some(existing_main) = workspace_main_version_id(tx, workspace_id)? {
        return get_version(tx, workspace_id, &existing_main)?.ok_or(DomainError::VersionNotFound);
    }

    tx.execute(
        "INSERT INTO versioned_workspaces (workspace_id, main_version_id) VALUES (?1, ?2)",
        params![workspace_id, main_version_id],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "INSERT INTO versions \
         (workspace_id, version_id, kind, name, created_at_ms, fork_version_id, fork_moment_id) \
         VALUES (?1, ?2, 'main', 'Main', ?3, NULL, NULL)",
        params![workspace_id, main_version_id, now_ms],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(VersionRecord {
        workspace_id: workspace_id.to_owned(),
        version_id: main_version_id.to_owned(),
        kind: VersionKind::Main,
        name: "Main".to_owned(),
        created_at_ms: now_ms,
        fork_version_id: None,
        fork_moment_id: None,
    })
}

/// `moments.before_present`. A replicated moment whose payload carries no
/// `before` is `Unrecorded`; it cannot be rolled back.
#[derive(Clone, Copy, PartialEq, Eq)]
enum MomentBeforeState {
    Unrecorded,
    Absent,
    Present,
}

impl MomentBeforeState {
    fn from_db(value: i64) -> Result<Self, DomainError> {
        match value {
            0 => Ok(MomentBeforeState::Unrecorded),
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
    validate_identifier(&input.workspace_id, "workspace_id")?;
    validate_identifier(&input.version_id, "version_id")?;
    validate_moment_id(&input.moment_id)?;
    validate_moment_metadata(
        input.metadata_origin.as_str(),
        input.metadata_summary.as_deref(),
        input.metadata_correlation_id.as_deref(),
        input.author_json.as_deref(),
    )?;
    let mut normalized = input.clone();
    normalized.path = validate_addressable_plaintext_path(&input.path)?;
    Ok(normalized)
}

#[doc(hidden)]
pub fn validate_delete_input(input: &DeleteTextFile) -> Result<(), DomainError> {
    normalized_delete_input(input).map(|_| ())
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

/// Apply a text delete inside a caller-owned compound transaction.
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
    crate::collections::index_historical_record_owner_moment_in_tx(tx, ws, moment_order)?;
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
    // Must run in this same transaction as the path_aliases removal
    // above — see `cancel_pending_jobs_for_path` for why. Materialization
    // jobs carry no version identity — they mirror the active version's
    // working tree only, the same gate `enqueue_binary_delete` applies to
    // its own job — so an inactive version's delete must not touch them: a
    // named version deleting its own `note.md` must never cancel a pending
    // job that belongs to `main`'s `note.md` of the same name.
    if version_is_active(tx, ws, &input.version_id)? {
        cancel_pending_jobs_for_path(tx, ws, &input.path, input.now_ms)?;
    }

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

/// Validates a required caller-minted write identifier: non-empty and inside
/// the engine-wide length bound, so no route can store one an answer could not
/// then carry. The identifiers a caller may leave empty take
/// [`bounded_identifier`] instead.
pub(crate) fn validate_identifier(value: &str, field: &'static str) -> Result<(), DomainError> {
    if value.is_empty() {
        return Err(DomainError::InvalidInput {
            reason: match field {
                "workspace_id" => "workspace_id must not be empty",
                "moment_id" => "moment_id must not be empty",
                "object_id" => "object_id must not be empty",
                _ => "version_id must not be empty",
            },
        });
    }
    bounded_identifier(value, field)
}

/// The length half alone, for the identifiers a caller may legitimately leave
/// empty: `object_id` is minted only when a write lands on an unaliased path,
/// and the resolve moment ids are spent only by the branch that writes or
/// deletes.
pub(crate) fn bounded_identifier(value: &str, field: &'static str) -> Result<(), DomainError> {
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(DomainError::IdentifierTooLong {
            field,
            limit_bytes: MAX_IDENTIFIER_BYTES,
            observed_bytes: value.len(),
        });
    }
    Ok(())
}

pub(crate) fn validate_moment_id(value: &str) -> Result<(), DomainError> {
    validate_identifier(value, "moment_id")?;
    if value.contains('\u{1f}') {
        return Err(DomainError::InvalidInput {
            reason: "moment_id contains a reserved character",
        });
    }
    Ok(())
}

pub(crate) fn validate_moment_metadata(
    metadata_origin: &str,
    summary: Option<&str>,
    correlation_id: Option<&str>,
    author_json: Option<&str>,
) -> Result<(), DomainError> {
    for field in [Some(metadata_origin), summary, correlation_id]
        .into_iter()
        .flatten()
    {
        if field.len() > MAX_METADATA_FIELD_BYTES {
            return Err(DomainError::PayloadTooLarge {
                constraint: "MAX_METADATA_FIELD_BYTES",
                limit_bytes: MAX_METADATA_FIELD_BYTES,
                observed_bytes: field.len(),
            });
        }
    }
    let Some(author_json) = author_json else {
        return Ok(());
    };
    if author_json.len() > MAX_AUTHOR_JSON_BYTES {
        return Err(DomainError::PayloadTooLarge {
            constraint: "MAX_AUTHOR_JSON_BYTES",
            limit_bytes: MAX_AUTHOR_JSON_BYTES,
            observed_bytes: author_json.len(),
        });
    }
    let Ok(author) = serde_json::from_str::<serde_json::Value>(author_json) else {
        return Ok(());
    };
    let Some(author) = author.as_object() else {
        return Ok(());
    };
    for field in ["agentId", "onBehalfOf", "agentRunId"] {
        let Some(value) = author.get(field).and_then(serde_json::Value::as_str) else {
            continue;
        };
        if value.len() > MAX_AUTHOR_FIELD_BYTES {
            return Err(DomainError::PayloadTooLarge {
                constraint: "MAX_AUTHOR_FIELD_BYTES",
                limit_bytes: MAX_AUTHOR_FIELD_BYTES,
                observed_bytes: value.len(),
            });
        }
    }
    Ok(())
}

/// Minimal path floor for the calibration slice. This is not the full
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

/// Normalize a tracked workspace path through the shared engine-files policy.
pub fn normalize_tracked_workspace_path(path: &str) -> Result<String, DomainError> {
    use dohc_engine_files::policy::{PathClassification, classify_engine_file_path_normalized};

    let (classification, normalized) = classify_engine_file_path_normalized(path);
    if classification != PathClassification::Tracked {
        return Err(DomainError::InvalidPath {
            reason: "path is not eligible for plaintext storage",
        });
    }
    normalized.ok_or(DomainError::InvalidPath {
        reason: "tracked path is missing its normalized form",
    })
}

/// Store-door guard for operations that introduce a plaintext alias. Only a
/// tracked classification is eligible, and the returned key is canonical.
pub fn validate_plaintext_storable_path(path: &str) -> Result<String, DomainError> {
    let normalized = normalize_tracked_workspace_path(path)?;
    validate_path(path)?;
    Ok(normalized)
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

pub(crate) fn get_file_object(
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

const NEXT_MOMENT_ORDER_SQL: &str = "\
SELECT MAX(
    COALESCE((SELECT MAX(moment_order) FROM moments), 0),
    COALESCE((
        SELECT MAX(target_generation)
        FROM materialization_jobs
        WHERE job_id NOT GLOB 'version-switch-mat_*'
          AND job_id NOT GLOB 'version-switch-secret-mat_*'
    ), 0)
)";

pub(crate) fn next_moment_order(conn: &Connection) -> Result<i64, DomainError> {
    // Ordinary materialization rows are the durable high-water mark when
    // rollback history surgery removes a tip moment. Pending and terminal
    // mutation/restore jobs guarantee that every later mutation is strictly
    // newer than an already-issued compensating restore. Version-switch
    // projections use snapshot timestamps as generations, so they are a
    // separate ordering domain and must not advance the mutation sequence.
    let max: i64 = conn
        .query_row(NEXT_MOMENT_ORDER_SQL, [], |row| row.get(0))
        .map_err(DomainError::sql_corrupt)?;
    max.checked_add(1).ok_or(DomainError::StateCorrupt {
        reason: "moment order high water is exhausted",
    })
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
/// version** (`versionedTextStore.ts:4877-4884` — "it never touched this
/// version's snapshots, so it must never become the fork point"). Scoping to
/// `version_id` is load-bearing: the global-latest moment can belong to a
/// sibling fork, and using it would record a merge base that never described
/// this version's state. `sync_record_only` marker rows (a peer-divergence
/// record) are excluded — a materialized moment is NULL or `0` (the `= 0`
/// arm is latent until sync writes 0).
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

/// The snapshot row without the text join — the in-band reads resolve
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
    // Recorded and actual lengths must agree per side — a corrupted
    // recorded length (lying small or large) fails closed for text and
    // binary alike, matching the in-band reads.
    if after_byte_length != after_actual_length || before_byte_length != before_actual_length {
        return Ok(Err(DomainError::StateCorrupt {
            reason: "moment blob length does not match its content",
        }));
    }
    // Byte lengths always hydrate (only the text is capped): a side whose
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
            // mean 'materialized' (matching the aligned fork SQL).
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

#[cfg(test)]
mod tests {
    use super::{NEXT_MOMENT_ORDER_SQL, next_moment_order};
    use crate::DomainError;
    use dohc_engine_storage::EngineStore;
    use dohc_engine_testkit::ScratchDir;
    use rusqlite::Connection;

    fn moment_order_semantics_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE moments (moment_order INTEGER NOT NULL); \
             CREATE TABLE materialization_jobs ( \
                 job_id TEXT PRIMARY KEY, \
                 target_generation INTEGER NOT NULL \
             );",
        )
        .expect("create moment-order tables");
        conn
    }

    #[test]
    fn next_moment_order_preserves_global_and_job_high_water_semantics() {
        let mut conn = moment_order_semantics_connection();
        assert_eq!(next_moment_order(&conn).expect("empty order"), 1);

        conn.execute_batch(
            "INSERT INTO moments (moment_order) VALUES (7), (12); \
             INSERT INTO materialization_jobs (job_id, target_generation) VALUES \
                 ('mutation-mat_a', 40), \
                 ('version-switch-mat_ignored', 100), \
                 ('version-switch-secret-mat_ignored', 101);",
        )
        .expect("seed global order domains");
        assert_eq!(next_moment_order(&conn).expect("job high water"), 41);

        let transaction = conn.transaction().expect("begin rollback probe");
        transaction
            .execute(
                "INSERT INTO materialization_jobs (job_id, target_generation) VALUES (?1, ?2)",
                ("mutation-mat_rolled_back", 70),
            )
            .expect("reserve rolled-back generation");
        assert_eq!(
            next_moment_order(&transaction).expect("transaction high water"),
            71
        );
        transaction.rollback().expect("roll back generation probe");

        assert_eq!(
            next_moment_order(&conn).expect("high water after rollback"),
            41,
            "a rolled-back transaction must not reserve a generation"
        );

        conn.execute("INSERT INTO moments (moment_order) VALUES (80)", [])
            .expect("seed moment high water");
        assert_eq!(
            next_moment_order(&conn).expect("moment high water"),
            81,
            "the global moment maximum must win when it exceeds every job generation"
        );
    }

    #[test]
    fn next_moment_order_fails_closed_when_the_high_water_is_exhausted() {
        let conn = moment_order_semantics_connection();
        conn.execute("INSERT INTO moments (moment_order) VALUES (?1)", [i64::MAX])
            .expect("seed exhausted moment order");

        assert!(matches!(
            next_moment_order(&conn),
            Err(DomainError::StateCorrupt {
                reason: "moment order high water is exhausted"
            })
        ));
    }

    #[test]
    fn next_moment_order_uses_generation_first_indexes() {
        let scratch = ScratchDir::new().expect("scratch");
        let store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        let details = store
            .read_with(|conn| {
                let mut statement =
                    conn.prepare(&format!("EXPLAIN QUERY PLAN {NEXT_MOMENT_ORDER_SQL}"))?;
                statement
                    .query_map([], |row| row.get::<_, String>(3))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .expect("query plan against migrated schema");

        assert!(
            details
                .iter()
                .any(|detail| detail.contains("idx_moments_global_order")),
            "moment maximum must use its global generation index: {details:?}"
        );
        assert!(
            details
                .iter()
                .any(|detail| { detail.contains("idx_materialization_jobs_mutation_generation") }),
            "materialization maximum must use its filtered generation index: {details:?}"
        );
        assert!(
            details.iter().all(|detail| {
                !detail.starts_with("SCAN moments")
                    && !detail.starts_with("SCAN materialization_jobs")
            }),
            "the high-water query must not scan either growing table: {details:?}"
        );
    }
}
