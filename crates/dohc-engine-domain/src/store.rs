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
mod request_ledger;
mod rollback;

pub use binary_write::write_binary_in_tx;
use rollback::binary_rollback_job_version_prefix;
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
    BinaryBlobRead, BinaryHead, CaptureIngest, CaptureIngestBinary, CaptureIngestBinaryResult,
    CaptureRetire, CaptureRetireResult, CreateNamedVersion, DeleteResult, DeleteTextFile,
    FileObjectRecord, InbandBinary, InbandText, ListMomentsQuery, MomentOp, MomentPage,
    MomentRecord, RenameResult, RenameTextFile, SnapshotContent, SnapshotMetadata, SnapshotRecord,
    SnapshotView, TextBlobRead, TextSnapshot, VersionKind, VersionRecord, WriteResult, WriteText,
};
use dohc_engine_storage::{
    EngineStore, FaultInjector, MAX_IDENTIFIER_BYTES, MaterializationJobSpec, Preimage,
    StorageError, TxnOutcome, cancel_pending_jobs_for_path, hex, put_binary_blob,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use std::borrow::Cow;

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

    /// Autonomous binary capture ingest: same derived-id scheme and
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

// ============================================================================
// Free helpers (SQL over a borrowed connection/transaction).
// ============================================================================

/// A projected write can borrow every small field while transferring ownership
/// of its document body into the returned snapshot.
#[doc(hidden)]
pub struct ProjectedWriteText<'a> {
    pub workspace_id: &'a str,
    pub version_id: &'a str,
    pub object_id: &'a str,
    pub path: Cow<'a, str>,
    pub text: Cow<'a, str>,
    pub moment_id: &'a str,
    pub metadata_origin: &'a str,
    pub metadata_summary: Option<&'a str>,
    pub metadata_correlation_id: Option<&'a str>,
    pub author_json: Option<&'a str>,
    pub now_ms: i64,
    pub request_id: Option<&'a str>,
}

/// State the caller has already proved for one text mutation. Keeping this
/// private makes the domain write the only persistence implementation while
/// letting autonomous capture reuse the object binding, preimage, and moment
/// order it had to resolve before deriving its collision-resistant moment id.
struct PreparedTextWrite {
    object_id: String,
    before: Option<SnapshotRecord>,
    moment_order: i64,
    content_sha256: String,
    bind_object: bool,
    bind_alias: bool,
    known_object: Option<FileObjectRecord>,
}

struct ResolvedCaptureObject {
    object_id: String,
    reserved_moment_order: Option<i64>,
    known_object: Option<FileObjectRecord>,
}

/// Transaction-local facts shared by one actor-owned capture batch.
///
/// The runtime advances `next_moment_order` only after an item's effects have
/// been accepted by the surrounding rollback scope. Keeping the proposed order
/// immutable while an item runs makes a failed or deduped item consume nothing,
/// while still giving object disambiguation and moment derivation the same
/// candidate.
#[doc(hidden)]
pub struct CaptureIngestBatchContext {
    workspace_id: String,
    version_id: String,
    producer_id: Option<String>,
    moment_order_cursor: CaptureMomentOrderCursor,
}

#[derive(Clone, Copy)]
enum CaptureMomentOrderCursor {
    Uninitialized,
    Ready(i64),
    Exhausted,
}

impl CaptureIngestBatchContext {
    /// Establish the shared coordinate. Producer and order stay lazy so an
    /// all-dedupe replay keeps the legacy short-circuit and does not gain
    /// unrelated failure modes.
    pub fn new(
        tx: &Transaction<'_>,
        workspace_id: &str,
        version_id: &str,
    ) -> Result<Self, DomainError> {
        if !version_exists(tx, workspace_id, version_id)? {
            return Err(DomainError::VersionNotFound);
        }
        Ok(Self {
            workspace_id: workspace_id.to_owned(),
            version_id: version_id.to_owned(),
            producer_id: None,
            moment_order_cursor: CaptureMomentOrderCursor::Uninitialized,
        })
    }

    /// Advance after the surrounding rollback scope accepts the item's side
    /// effects. A dedupe points at an existing moment and consumes no order.
    pub fn commit_result(&mut self, result: &WriteResult) -> Result<(), DomainError> {
        if result.deduped {
            return Ok(());
        }
        let next_moment_order = match self.moment_order_cursor {
            CaptureMomentOrderCursor::Ready(next_moment_order) => next_moment_order,
            CaptureMomentOrderCursor::Uninitialized => {
                return Err(DomainError::StateCorrupt {
                    reason: "capture batch committed a moment without reserving an order",
                });
            }
            CaptureMomentOrderCursor::Exhausted => {
                return Err(DomainError::StateCorrupt {
                    reason: "capture batch committed a moment after order exhaustion",
                });
            }
        };
        if result.moment.moment_order != next_moment_order {
            return Err(DomainError::StateCorrupt {
                reason: "capture batch moment order diverged from its cursor",
            });
        }
        self.moment_order_cursor = match next_moment_order.checked_add(1) {
            Some(next_moment_order) => CaptureMomentOrderCursor::Ready(next_moment_order),
            None => CaptureMomentOrderCursor::Exhausted,
        };
        Ok(())
    }

    fn validates(&self, input: &CaptureIngest) -> bool {
        input.workspace_id == self.workspace_id && input.version_id == self.version_id
    }

    fn proposed_moment_order(&mut self, tx: &Transaction<'_>) -> Result<i64, DomainError> {
        match self.moment_order_cursor {
            CaptureMomentOrderCursor::Ready(next_moment_order) => Ok(next_moment_order),
            CaptureMomentOrderCursor::Uninitialized => {
                let next_moment_order = next_moment_order(tx)?;
                self.moment_order_cursor = CaptureMomentOrderCursor::Ready(next_moment_order);
                Ok(next_moment_order)
            }
            CaptureMomentOrderCursor::Exhausted => Err(DomainError::StateCorrupt {
                reason: "capture batch moment order overflowed",
            }),
        }
    }

    fn producer_id(&mut self, tx: &Transaction<'_>) -> Result<&str, DomainError> {
        if self.producer_id.is_none() {
            self.producer_id = Some(capture_producer_id(tx, &self.workspace_id)?);
        }
        Ok(self
            .producer_id
            .as_deref()
            .expect("capture producer was initialized"))
    }
}

impl<'a> From<&'a WriteText> for ProjectedWriteText<'a> {
    fn from(input: &'a WriteText) -> Self {
        Self {
            workspace_id: &input.workspace_id,
            version_id: &input.version_id,
            object_id: &input.object_id,
            path: Cow::Borrowed(&input.path),
            text: Cow::Borrowed(&input.text),
            moment_id: &input.moment_id,
            metadata_origin: &input.metadata_origin,
            metadata_summary: input.metadata_summary.as_deref(),
            metadata_correlation_id: input.metadata_correlation_id.as_deref(),
            author_json: input.author_json.as_deref(),
            now_ms: input.now_ms,
            request_id: input.request_id.as_deref(),
        }
    }
}

/// Validate a write and normalize only its path through the R07
/// plaintext-storable path floor. The document body stays borrowed or owned as
/// supplied, so validation never copies it.
fn normalized_write_input<'a>(
    mut input: ProjectedWriteText<'a>,
) -> Result<ProjectedWriteText<'a>, DomainError> {
    validate_identifier(input.workspace_id, "workspace_id")?;
    validate_identifier(input.version_id, "version_id")?;
    bounded_identifier(input.object_id, "object_id")?;
    validate_moment_id(input.moment_id)?;
    validate_moment_metadata(
        input.metadata_origin,
        input.metadata_summary,
        input.metadata_correlation_id,
        input.author_json,
    )?;
    input.path = Cow::Owned(validate_plaintext_storable_path(&input.path)?);
    validate_text(&input.text)?;
    Ok(input)
}

#[doc(hidden)]
pub fn validate_write_input(input: &WriteText) -> Result<(), DomainError> {
    reject_reserved_capture_origin(&input.metadata_origin)?;
    normalized_write_input(input.into()).map(|_| ())
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

fn normalized_capture_ingest(input: &CaptureIngest) -> Result<CaptureIngest, DomainError> {
    validate_identifier(&input.workspace_id, "workspace_id")?;
    validate_identifier(&input.version_id, "version_id")?;
    validate_moment_metadata(
        input.metadata_origin.as_str(),
        input.metadata_summary.as_deref(),
        input.metadata_correlation_id.as_deref(),
        input.author_json.as_deref(),
    )?;
    let mut normalized = input.clone();
    normalized.path = validate_plaintext_storable_path(&input.path)?;
    validate_text(&normalized.text)?;
    Ok(normalized)
}

fn normalized_capture_retire(input: &CaptureRetire) -> Result<CaptureRetire, DomainError> {
    validate_identifier(&input.workspace_id, "workspace_id")?;
    validate_identifier(&input.version_id, "version_id")?;
    validate_moment_metadata(
        CAPTURE_ORIGIN,
        input.metadata_summary.as_deref(),
        input.metadata_correlation_id.as_deref(),
        None,
    )?;
    let mut normalized = input.clone();
    normalized.path = validate_addressable_plaintext_path(&input.path)?;
    Ok(normalized)
}

#[doc(hidden)]
pub fn capture_ingest_in_tx(
    tx: &Transaction<'_>,
    input: &CaptureIngest,
) -> Result<WriteResult, DomainError> {
    capture_ingest_with_admission_in_tx(tx, input, |_, _, _| Ok::<(), DomainError>(()))
}

#[doc(hidden)]
pub fn capture_ingest_with_admission_in_tx<E>(
    tx: &Transaction<'_>,
    input: &CaptureIngest,
    admit: impl FnOnce(&str, &str, &str) -> Result<(), E>,
) -> Result<WriteResult, E>
where
    E: From<DomainError>,
{
    capture_ingest_with_context_and_admission_in_tx(tx, input, None, admit)
}

/// Capture one item using facts reserved by its actor-owned batch.
#[doc(hidden)]
pub fn capture_ingest_in_batch_with_admission_in_tx<E>(
    tx: &Transaction<'_>,
    input: &CaptureIngest,
    batch: &mut CaptureIngestBatchContext,
    admit: impl FnOnce(&str, &str, &str) -> Result<(), E>,
) -> Result<WriteResult, E>
where
    E: From<DomainError>,
{
    capture_ingest_with_context_and_admission_in_tx(tx, input, Some(batch), admit)
}

fn capture_ingest_with_context_and_admission_in_tx<E>(
    tx: &Transaction<'_>,
    input: &CaptureIngest,
    mut batch: Option<&mut CaptureIngestBatchContext>,
    admit: impl FnOnce(&str, &str, &str) -> Result<(), E>,
) -> Result<WriteResult, E>
where
    E: From<DomainError>,
{
    let input = normalized_capture_ingest(input)?;
    if batch
        .as_deref()
        .is_some_and(|batch| !batch.validates(&input))
    {
        return Err(DomainError::InvalidInput {
            reason: "capture batch coordinates do not match",
        }
        .into());
    }
    if batch.is_none() && !version_exists(tx, &input.workspace_id, &input.version_id)? {
        return Err(DomainError::VersionNotFound.into());
    }
    let (author_kind, author_json) = match input.author_json.as_deref() {
        Some(author_json) => (b"some".as_slice(), author_json.as_bytes()),
        None => (b"none".as_slice(), b"".as_slice()),
    };
    // Frame extended with the summary/correlation provenance fields: the
    // capture sink passes request_id: None, so no store holds recorded
    // capture-ingest requests and no legacy-hash compatibility shim is owed
    // (same reasoning as the capture-retire frame below).
    let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary.as_deref());
    let (correlation_kind, correlation) =
        hash_optional_text_fields(input.metadata_correlation_id.as_deref());
    let payload_hash = hash_request_fields(
        input.request_id.as_deref(),
        &[
            b"capture-ingest",
            input.workspace_id.as_bytes(),
            input.version_id.as_bytes(),
            input.path.as_bytes(),
            input.text.as_bytes(),
            input.metadata_origin.as_bytes(),
            summary_kind,
            summary,
            correlation_kind,
            correlation,
            author_kind,
            author_json,
            if input.claim_foreign_head {
                b"claim-foreign".as_slice()
            } else {
                b"own-only".as_slice()
            },
        ],
    );
    if let Some(request_id) = &input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch.into());
        }
        return reconstruct_capture_write(tx, &input.workspace_id, recorded.result_seq)
            .map_err(E::from);
    }

    let existing_alias = alias_object_id(tx, &input.workspace_id, &input.version_id, &input.path)?;
    let target_object_id = existing_alias.clone().unwrap_or_else(|| {
        derive_capture_object_id(&input.workspace_id, &input.version_id, &input.path)
    });
    admit(&input.workspace_id, &input.version_id, &target_object_id)?;

    let resolved = resolve_capture_object(
        tx,
        &input.workspace_id,
        &input.version_id,
        &input.path,
        input.now_ms,
        existing_alias,
        batch.as_deref_mut(),
    )?;
    let before = if resolved.known_object.is_some() {
        None
    } else {
        get_snapshot(
            tx,
            &input.workspace_id,
            &input.version_id,
            &resolved.object_id,
        )?
    };
    // OWNERSHIP: capture only overwrites heads written with its own origin.
    // A head that arrived by another route (RPC, replication) may have no
    // disk counterpart at all, so letting disk bytes overwrite it would
    // silently revert that write.
    if let Some(existing) = &before
        && existing.metadata_origin != input.metadata_origin
        && !input.claim_foreign_head
    {
        return Err(DomainError::CaptureNotOwned.into());
    }
    let content_sha256 = text_blob_sha256(&input.text);
    if let Some(before) = &before
        && before.content_kind == "text"
        && before.blob_sha256.as_deref() == Some(content_sha256.as_str())
    {
        // A claimed dedupe transfers ownership: capture observed the disk
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
                    resolved.object_id
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

    // TS `writeIfChanged` parity: an explicit pass summary (a reconcile)
    // always wins; otherwise a binary-tracked path whose bytes round-trip as
    // UTF-8 again gets the honest transition label, and a plain live text
    // update carries NO summary (the renderer's copy for null is
    // "Edited <basename>").
    let metadata_summary = match &input.metadata_summary {
        Some(summary) => Some(summary.clone()),
        None => before
            .as_ref()
            .is_some_and(|head| head.content_kind == "binary")
            .then(|| "Became a text file".to_owned()),
    };
    let now_ms = input.now_ms.to_string();
    let (actual_summary_kind, actual_summary) =
        hash_optional_text_fields(metadata_summary.as_deref());
    let mutation_identity = hash_fields(&[
        input.path.as_bytes(),
        content_sha256.as_bytes(),
        input.metadata_origin.as_bytes(),
        actual_summary_kind,
        actual_summary,
        correlation_kind,
        correlation,
        author_kind,
        author_json,
        now_ms.as_bytes(),
    ]);
    let next_order = match resolved.reserved_moment_order {
        Some(next_order) => next_order,
        None => match batch.as_deref_mut() {
            Some(batch) => batch.proposed_moment_order(tx)?,
            None => next_moment_order(tx)?,
        },
    };
    let producer_id = match batch {
        Some(batch) => Cow::Borrowed(batch.producer_id(tx)?),
        None => Cow::Owned(capture_producer_id(tx, &input.workspace_id)?),
    };
    let moment_id = derive_capture_moment_id(
        producer_id.as_ref(),
        &input.workspace_id,
        &resolved.object_id,
        next_order,
        "write",
        &mutation_identity,
    );
    let write = normalized_write_input(ProjectedWriteText {
        workspace_id: &input.workspace_id,
        version_id: &input.version_id,
        object_id: &resolved.object_id,
        path: Cow::Borrowed(&input.path),
        text: Cow::Borrowed(&input.text),
        moment_id: &moment_id,
        metadata_origin: &input.metadata_origin,
        metadata_summary: metadata_summary.as_deref(),
        metadata_correlation_id: input.metadata_correlation_id.as_deref(),
        author_json: input.author_json.as_deref(),
        now_ms: input.now_ms,
        request_id: None,
    })?;
    let result = write_normalized_text_in_tx(
        tx,
        write,
        false,
        Some(PreparedTextWrite {
            object_id: resolved.object_id.clone(),
            before,
            moment_order: next_order,
            content_sha256,
            bind_object: false,
            bind_alias: false,
            known_object: resolved.known_object,
        }),
    )?;
    if result.moment.moment_order != next_order {
        return Err(DomainError::StateCorrupt {
            reason: "capture moment order diverged from reserved order",
        }
        .into());
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
    // Frame extended (head-scope discriminator, then the summary/correlation
    // provenance fields): no store outside tests has recorded capture-retire
    // requests (the sink passes request_id: None), so no legacy-hash
    // compatibility shim is owed.
    let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary.as_deref());
    let (correlation_kind, correlation) =
        hash_optional_text_fields(input.metadata_correlation_id.as_deref());
    let payload_hash = hash_fields(&[
        b"capture-retire",
        input.workspace_id.as_bytes(),
        input.version_id.as_bytes(),
        input.path.as_bytes(),
        b"capture",
        summary_kind,
        summary,
        correlation_kind,
        correlation,
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
            && !(input.allow_ydoc_origin && head.metadata_origin == YDOC_ORIGIN)
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
    let producer_id = capture_producer_id(tx, &input.workspace_id)?;
    let now_ms = input.now_ms.to_string();
    let mutation_identity = hash_fields(&[
        input.path.as_bytes(),
        summary_kind,
        summary,
        correlation_kind,
        correlation,
        now_ms.as_bytes(),
    ]);
    let moment_id = derive_capture_retire_moment_id(
        &producer_id,
        &input.workspace_id,
        &object_id,
        next_order,
        "delete",
        &mutation_identity,
    );
    let delete = DeleteTextFile {
        workspace_id: input.workspace_id.clone(),
        version_id: input.version_id.clone(),
        path: input.path,
        moment_id,
        request_id: None,
        metadata_origin: "capture".to_owned(),
        metadata_summary: input.metadata_summary.clone(),
        metadata_correlation_id: input.metadata_correlation_id.clone(),
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
/// Reserved: `normalized_write_input` — which every plaintext write path
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
/// crate's `MAX_CAPTURE_BINARY_BYTES`. Replication applies it too: blob ingest
/// and share replay both refuse a binary above this ceiling. The storage blob
/// cap (64 MiB) is what remains for writers neither path covers.
pub const MAX_CAPTURE_BINARY_FILE_BYTES: usize = 5 * 1024 * 1024;

#[doc(hidden)]
pub fn capture_ingest_binary_in_tx(
    tx: &Transaction<'_>,
    input: &CaptureIngestBinary,
) -> Result<CaptureIngestBinaryResult, DomainError> {
    capture_ingest_binary_with_admission_in_tx(tx, input, |_, _, _| Ok::<(), DomainError>(()))
}

#[doc(hidden)]
pub fn capture_ingest_binary_with_admission_in_tx<E>(
    tx: &Transaction<'_>,
    input: &CaptureIngestBinary,
    admit: impl FnOnce(&str, &str, &str) -> Result<(), E>,
) -> Result<CaptureIngestBinaryResult, E>
where
    E: From<DomainError>,
{
    use crate::conflicts::{PersistBinaryHead, persist_binary_head_in_tx};

    validate_identifier(&input.workspace_id, "workspace_id")?;
    validate_identifier(&input.version_id, "version_id")?;
    let path = validate_plaintext_storable_path(&input.path)?;
    if input.bytes.len() > MAX_CAPTURE_BINARY_FILE_BYTES {
        return Err(DomainError::InvalidInput {
            reason: "binary bytes exceed the capture cap",
        }
        .into());
    }
    if !version_exists(tx, &input.workspace_id, &input.version_id)? {
        return Err(DomainError::VersionNotFound.into());
    }
    let binary_sha256 = dohc_engine_storage::hex_sha256(&input.bytes);
    let (author_kind, author_json) = match input.author_json.as_deref() {
        Some(author_json) => (b"some".as_slice(), author_json.as_bytes()),
        None => (b"none".as_slice(), b"".as_slice()),
    };
    // Frame extended with summary/correlation; see `capture_ingest_in_tx`.
    let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary.as_deref());
    let (correlation_kind, correlation) =
        hash_optional_text_fields(input.metadata_correlation_id.as_deref());
    let payload_hash = hash_fields(&[
        b"capture-ingest-binary",
        input.workspace_id.as_bytes(),
        input.version_id.as_bytes(),
        path.as_bytes(),
        binary_sha256.as_bytes(),
        input.metadata_origin.as_bytes(),
        summary_kind,
        summary,
        correlation_kind,
        correlation,
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
            return Err(DomainError::IdempotencyKeyReuseMismatch.into());
        }
        return reconstruct_capture_binary(tx, &input.workspace_id, recorded.result_seq)
            .map_err(E::from);
    }

    let existing_alias = alias_object_id(tx, &input.workspace_id, &input.version_id, &path)?;
    let target_object_id = existing_alias
        .clone()
        .unwrap_or_else(|| derive_capture_object_id(&input.workspace_id, &input.version_id, &path));
    admit(&input.workspace_id, &input.version_id, &target_object_id)?;

    let ResolvedCaptureObject {
        object_id,
        reserved_moment_order,
        ..
    } = resolve_capture_object(
        tx,
        &input.workspace_id,
        &input.version_id,
        &path,
        input.now_ms,
        existing_alias,
        None,
    )?;
    let before = get_snapshot(tx, &input.workspace_id, &input.version_id, &object_id)?;
    if let Some(existing) = &before
        && existing.metadata_origin != input.metadata_origin
        && !input.claim_foreign_head
    {
        return Err(DomainError::CaptureNotOwned.into());
    }
    if let Some(before) = &before {
        // Fail closed on partial head identity, mirroring the binary writer.
        match before.content_kind.as_str() {
            "text" if before.blob_sha256.is_some() => {}
            "binary" if before.binary_sha256.is_some() => {}
            "text" => {
                return Err(DomainError::StateCorrupt {
                    reason: "text snapshot is missing its blob",
                }
                .into());
            }
            "binary" => {
                return Err(DomainError::StateCorrupt {
                    reason: "binary snapshot is missing its blob",
                }
                .into());
            }
            _ => {
                return Err(DomainError::StateCorrupt {
                    reason: "snapshot has an unknown content kind",
                }
                .into());
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
            // The head's bytes are verified on disk right now, so record the
            // head generation as materialized (upsert: the creating write's
            // own job may still be pending — its content is this same sha —
            // and flipping it complete both records reality and lets the
            // staleness gate supersede any older pending job that could
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
            )
            .map_err(DomainError::from)?;
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

    put_binary_blob(tx, &input.bytes).map_err(DomainError::from)?;
    let next_order = match reserved_moment_order {
        Some(next_order) => next_order,
        None => next_moment_order(tx)?,
    };
    // TS `writeIfChanged` parity: pass summary wins; a text-tracked path
    // whose bytes stop round-tripping as UTF-8 keeps its object identity and
    // the moment says so honestly; a plain binary update is labeled per file.
    let metadata_summary = input.metadata_summary.clone().unwrap_or_else(|| {
        if before
            .as_ref()
            .is_some_and(|head| head.content_kind != "binary")
        {
            "Became a binary file".to_owned()
        } else {
            format!("Updated {}", path_basename(&path))
        }
    });
    let now_ms = input.now_ms.to_string();
    let mutation_identity = hash_fields(&[
        path.as_bytes(),
        binary_sha256.as_bytes(),
        input.metadata_origin.as_bytes(),
        metadata_summary.as_bytes(),
        correlation_kind,
        correlation,
        author_kind,
        author_json,
        now_ms.as_bytes(),
    ]);
    let producer_id = capture_producer_id(tx, &input.workspace_id)?;
    let moment_id = derive_capture_moment_id(
        &producer_id,
        &input.workspace_id,
        &object_id,
        next_order,
        "write-binary",
        &mutation_identity,
    );
    if moment_exists(tx, &input.workspace_id, &moment_id)? {
        return Err(DomainError::DuplicateMomentId.into());
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
            metadata_summary: Some(metadata_summary.as_str()),
            metadata_correlation_id: input.metadata_correlation_id.as_deref(),
            author_json: input.author_json.as_deref(),
            now_ms: input.now_ms,
        },
        before_head,
    )?;
    if moment_order != next_order {
        return Err(DomainError::StateCorrupt {
            reason: "capture moment order diverged from reserved order",
        }
        .into());
    }
    // Disk already holds these bytes, so record the materialization as a
    // completed job (never runnable). The marker is what the materializer's
    // staleness gate reads: an older still-pending job for this path — whose
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
    )
    .map_err(DomainError::from)?;
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
/// the captured content's byte size, and its lowercase-hex sha256 in the
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
/// seed the baseline scan diffs against empty and can never emit a Retire
/// for a file deleted while the daemon was down — the stale captured head
/// would stay readable forever (`ReconcileController::rehydrated`'s
/// documented follow-up: the rehydration SOURCE lives above the files
/// crate, which is here).
///
/// CAPTURE-ORIGIN ONLY, deliberately: the manifest states what CAPTURE
/// believes is on disk. Content that arrived any other way (an RPC
/// `versionedText.write`, a replication/sync apply) may legitimately have
/// no disk counterpart yet, and seeding it would make the next baseline
/// scan diff it as "removed" and retire it — capture deleting content it
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
                                JOIN moments producer \
                                  ON producer.workspace_id = a.workspace_id \
                                 AND producer.version_id = a.version_id \
                                 AND producer.object_id = a.object_id \
                                 AND producer.moment_id = s.latest_moment_id \
                                 AND producer.moment_order = j.target_generation \
                                 AND producer.operation = 'write' \
                                WHERE j.status = 'pending' \
                                  AND j.operation = 'write' \
                                  AND (j.workspace_id = ?1 \
                                       OR j.workspace_id = '') \
                                  AND j.target_path = a.path \
                                  AND j.content_sha256 = \
                                      CASE COALESCE(s.content_kind, 'text') \
                                      WHEN 'binary' THEN s.binary_sha256 \
                                      ELSE s.blob_sha256 END))) \
                   AND NOT EXISTS ( \
                       SELECT 1 FROM materialization_jobs j \
                        WHERE j.status = 'pending' AND j.operation = 'write' \
                          AND (j.workspace_id = ?1 OR j.workspace_id = '') \
                          AND j.target_path = a.path \
                         AND j.content_sha256 = CASE COALESCE(s.content_kind, 'text') \
                             WHEN 'binary' THEN s.binary_sha256 ELSE s.blob_sha256 END \
                         AND (substr(j.job_id, 1, length(?3)) = ?3 \
                              OR substr(j.job_id, \
                                    length('binary-rename-0-write-mat_') + 1, \
                                    length(?3)) = ?3)) \
                 UNION ALL \
                 SELECT j.target_path, 'binary', NULL, NULL, \
                        j.content_sha256, bb.byte_length \
                 FROM materialization_jobs j \
                 JOIN binary_blobs bb ON bb.sha256 = j.content_sha256 \
                  WHERE j.status = 'pending' AND j.operation = 'delete' \
                    AND (j.workspace_id = ?1 OR j.workspace_id = '') \
                     AND (substr(j.job_id, 1, length(?3)) = ?3 \
                         OR substr(j.job_id, \
                               length('binary-rename-1-delete-mat_') + 1, \
                               length(?3)) = ?3) \
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
        // disk, and seeding it would make the baseline diff retire it. Keyed
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
    let input = normalized_write_input(input.into())?;
    write_normalized_text_in_tx(tx, input, false, None)
}

/// Apply a projected text write. A Y.Doc settle has already durably recorded
/// the CRDT edits that produced this projection.
#[doc(hidden)]
pub fn write_projected_text_in_tx<'a>(
    tx: &Transaction<'_>,
    input: impl Into<ProjectedWriteText<'a>>,
) -> Result<WriteResult, DomainError> {
    // allow_preallocated_object: the live Y.Doc seed pre-creates the
    // file_objects row (FK parent for the marker) before any snapshot or
    // alias exists — the settle that follows is binding its own object,
    // not colliding with another.
    let input = normalized_write_input(input.into())?;
    write_normalized_text_in_tx(tx, input, true, None)
}

fn write_normalized_text_in_tx(
    tx: &Transaction<'_>,
    input: ProjectedWriteText<'_>,
    allow_preallocated_object: bool,
    prepared: Option<PreparedTextWrite>,
) -> Result<WriteResult, DomainError> {
    let ws = input.workspace_id;
    if prepared.is_none() && !version_exists(tx, ws, input.version_id)? {
        return Err(DomainError::VersionNotFound);
    }

    let blob = prepared
        .as_ref()
        .map(|prepared| prepared.content_sha256.clone())
        .unwrap_or_else(|| text_blob_sha256(&input.text));
    let (author_kind, author_json) = hash_author_fields(input.author_json);
    let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary);
    let (correlation_kind, correlation_id) =
        hash_optional_text_fields(input.metadata_correlation_id);
    let payload_hash = hash_request_fields(
        input.request_id,
        &[
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
        ],
    );
    if let Some(request_id) = input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        return reconstruct_write(tx, input.workspace_id, input.moment_id);
    }
    if moment_exists(tx, ws, input.moment_id)? {
        let Some(existing) = get_moment(tx, ws, input.moment_id)? else {
            // Text and protected history share one workspace-wide moment-id
            // namespace, while `get_moment` resolves only plaintext history.
            return Err(DomainError::DuplicateMomentId);
        };
        let exact = existing.version_id == input.version_id
            && existing.path == input.path.as_ref()
            && existing.operation == MomentOp::Write
            && existing.after_content_kind == "text"
            && existing.after_blob_sha256.as_deref() == Some(blob.as_str())
            && existing.metadata_origin == input.metadata_origin
            && existing.metadata_summary.as_deref() == input.metadata_summary
            && existing.metadata_correlation_id.as_deref() == input.metadata_correlation_id
            && existing.author_json.as_deref() == input.author_json;
        if exact {
            return write_result_from_moment(tx, ws, existing, true);
        }
        // The oracle's contract: a caller-supplied moment id reused with
        // different content is duplicate-moment-id (the exact-match arm above
        // is the idempotent replay; only requestId reuse maps to mismatch).
        return Err(DomainError::DuplicateMomentId);
    }

    let prepared = match prepared {
        Some(prepared) => prepared,
        None => {
            let existing_object = alias_object_id(tx, ws, input.version_id, &input.path)?;
            let before = match &existing_object {
                Some(object_id) => get_snapshot(tx, ws, input.version_id, object_id)?,
                None => {
                    if input.object_id.is_empty() {
                        return Err(DomainError::InvalidInput {
                            reason: "object_id must not be empty for a new path",
                        });
                    }
                    if object_exists(tx, ws, input.object_id)? {
                        let bare_preallocation = allow_preallocated_object
                            && !object_has_any_binding(tx, ws, input.object_id)?;
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
            PreparedTextWrite {
                object_id: existing_object.unwrap_or_else(|| input.object_id.to_owned()),
                before,
                moment_order: next_moment_order(tx)?,
                content_sha256: blob.clone(),
                bind_object: is_new_object,
                bind_alias: true,
                known_object: None,
            }
        }
    };
    let PreparedTextWrite {
        object_id,
        before,
        moment_order,
        content_sha256: _,
        bind_object,
        bind_alias,
        known_object,
    } = prepared;
    let before_blob = before.as_ref().and_then(|s| s.blob_sha256.clone());
    let before_content_kind = before
        .as_ref()
        .map_or_else(|| "text".to_owned(), |s| s.content_kind.clone());
    let before_binary_sha256 = before.as_ref().and_then(|s| s.binary_sha256.clone());
    let before_latest_moment_id = before.as_ref().map(|s| s.latest_moment_id.clone());

    if bind_object {
        // OR IGNORE: the preallocated-object path (live Y.Doc seed) already
        // holds this row; every other new-object path inserts fresh.
        tx.execute(
            "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)              VALUES (?1, ?2, ?3)",
            params![input.workspace_id, object_id, input.now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    }
    let blob_inserted = tx
        .execute(
            "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
            params![blob, input.text.len() as i64, input.text.as_ref()],
        )
        .map_err(DomainError::sql_persist)?
        != 0;
    if bind_alias {
        tx.execute(
            "INSERT OR IGNORE INTO path_aliases (workspace_id, version_id, path, object_id) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                input.workspace_id,
                input.version_id,
                input.path.as_ref(),
                object_id
            ],
        )
        .map_err(DomainError::sql_persist)?;
    }
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
            input.workspace_id,
            moment_order,
            input.moment_id,
            input.version_id,
            object_id,
            input.path.as_ref(),
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
    crate::collections::index_historical_record_owner_moment_in_tx(tx, ws, moment_order)?;
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
            input.workspace_id,
            input.version_id,
            object_id,
            input.path.as_ref(),
            blob,
            input.now_ms,
            input.moment_id,
            input.metadata_origin,
            input.metadata_summary,
            input.metadata_correlation_id,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    record_request(
        tx,
        input.request_id,
        &payload_hash,
        moment_order,
        input.now_ms,
    )?;

    // A reused content-addressed row may be corrupt. Preserve the hydration
    // check that the prepared fast path replaces unless this write inserted
    // the blob and therefore established its text and recorded byte length.
    let read_back = !blob_inserted || known_object.is_none();

    let result_path = input.path.into_owned();
    let result_text = input.text.into_owned();
    let (object, moment) = if read_back {
        let object = get_file_object(tx, input.workspace_id, &object_id)?.ok_or(
            DomainError::StateCorrupt {
                reason: "written snapshot points at a missing object",
            },
        )?;
        let moment = get_moment(tx, input.workspace_id, input.moment_id)?.ok_or(
            DomainError::StateCorrupt {
                reason: "moment vanished within its own write transaction",
            },
        )?;
        (object, moment)
    } else {
        let object = known_object.ok_or(DomainError::StateCorrupt {
            reason: "prepared capture result is missing its known object",
        })?;
        let byte_length = result_text.len() as i64;
        let after_text =
            (result_text.len() <= MOMENT_TEXT_HYDRATION_CAP_BYTES).then(|| result_text.clone());
        let moment = MomentRecord {
            moment_order,
            moment_id: input.moment_id.to_owned(),
            version_id: input.version_id.to_owned(),
            object_id: object_id.clone(),
            path: result_path.clone(),
            recorded_at_ms: input.now_ms,
            operation: MomentOp::Write,
            after_content_kind: "text".to_owned(),
            after_blob_sha256: Some(blob.clone()),
            after_binary_sha256: None,
            before_present: false,
            before_blob_sha256: None,
            before_content_kind: "text".to_owned(),
            before_binary_sha256: None,
            before_latest_moment_id: None,
            metadata_origin: input.metadata_origin.to_owned(),
            metadata_summary: input.metadata_summary.map(str::to_owned),
            metadata_correlation_id: input.metadata_correlation_id.map(str::to_owned),
            author_json: input.author_json.map(str::to_owned),
            sync_record_only: false,
            after_text,
            after_byte_length: Some(byte_length),
            before_text: None,
            before_byte_length: None,
            before_path: None,
        };
        (object, moment)
    };
    Ok(WriteResult {
        object,
        snapshot: TextSnapshot {
            workspace_id: input.workspace_id.to_owned(),
            version_id: input.version_id.to_owned(),
            object_id: object_id.clone(),
            path: result_path,
            text: result_text,
            blob_sha256: blob.clone(),
            updated_at_ms: input.now_ms,
            latest_moment_id: input.moment_id.to_owned(),
            metadata_origin: input.metadata_origin.to_owned(),
            metadata_summary: input.metadata_summary.map(str::to_owned),
            metadata_correlation_id: input.metadata_correlation_id.map(str::to_owned),
        },
        moment,
        deduped: false,
    })
}

fn reconstruct_write(
    conn: &Connection,
    workspace_id: &str,
    moment_id: &str,
) -> Result<WriteResult, DomainError> {
    let moment = get_moment(conn, workspace_id, moment_id)?.ok_or(DomainError::StateCorrupt {
        reason: "deduped write has no moment",
    })?;
    write_result_from_moment(conn, workspace_id, moment, true)
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

/// The one locked implementation of autonomous capture's object/alias
/// resolution, shared by the text and binary primitives so the length-framed,
/// security-sensitive id scheme can never silently diverge between them:
/// reuse a live alias; else derive the framed object id and reuse it only when
/// it has no live alias anywhere; else mint an order-disambiguated id, with
/// that reserved order returned so the caller can pin it against the moment
/// the write actually persists. A freshly inserted object record is returned
/// too, so capture does not have to read back state it just established.
fn resolve_capture_object(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    path: &str,
    now_ms: i64,
    existing_alias: Option<String>,
    batch: Option<&mut CaptureIngestBatchContext>,
) -> Result<ResolvedCaptureObject, DomainError> {
    let mut reserved_moment_order = None;
    let mut known_object = None;
    let object_id = match existing_alias {
        Some(object_id) => object_id,
        None => {
            let derived_object_id = derive_capture_object_id(workspace_id, version_id, path);
            let inserted = tx
                .execute(
                    "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                     VALUES (?1, ?2, ?3) \
                     ON CONFLICT (workspace_id, object_id) DO NOTHING",
                    params![workspace_id, derived_object_id, now_ms],
                )
                .map_err(DomainError::sql_persist)?
                != 0;
            let object_id = if inserted {
                known_object = Some(FileObjectRecord {
                    workspace_id: workspace_id.to_owned(),
                    object_id: derived_object_id.clone(),
                    created_at_ms: now_ms,
                });
                derived_object_id
            } else if !object_has_live_alias(tx, workspace_id, &derived_object_id)? {
                derived_object_id
            } else {
                let next_order = match batch {
                    Some(batch) => batch.proposed_moment_order(tx)?,
                    None => next_moment_order(tx)?,
                };
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
                known_object = Some(FileObjectRecord {
                    workspace_id: workspace_id.to_owned(),
                    object_id: disambiguated_object_id.clone(),
                    created_at_ms: now_ms,
                });
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
    Ok(ResolvedCaptureObject {
        object_id,
        reserved_moment_order,
        known_object,
    })
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

fn validate_text(text: &str) -> Result<(), DomainError> {
    if text.len() > MAX_TEXT_BYTES {
        // Name the cap, not just the fact of it. "text exceeds the
        // size cap" told a caller nothing it could act on: which cap, how
        // large, in what unit, and by how much it overshot were all missing.
        // The sync side already reports this same limit as
        // ("MAX_TEXT_BYTES", MAX_TEXT_BYTES) with observed bytes at its
        // ingest boundary; the store's own write path was the outlier.
        return Err(DomainError::PayloadTooLarge {
            constraint: "MAX_TEXT_BYTES",
            limit_bytes: MAX_TEXT_BYTES,
            observed_bytes: text.len(),
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

/// Whether an object owns any binding (a path alias in any version or a
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

fn capture_producer_id(tx: &Transaction<'_>, workspace_id: &str) -> Result<String, DomainError> {
    tx.query_row(
        "SELECT COALESCE(\
             (SELECT origin_id FROM sync_identity WHERE workspace_id = ?1), \
             (SELECT engine_uuid FROM engine_ownership WHERE rowid_guard = 1))",
        [workspace_id],
        |row| row.get(0),
    )
    .map_err(DomainError::sql_corrupt)
}

/// Derive a capture moment id from its producer, coordinate, operation, and
/// mutation identity. The producer is the replica origin when the workspace
/// has one and the durable engine id before that. The operation and content
/// fields keep two divergent writes from cloned engines distinct even before
/// one clone recovers its origin.
pub fn derive_capture_moment_id(
    producer_id: &str,
    workspace_id: &str,
    object_id: &str,
    next_moment_order: i64,
    operation: &str,
    mutation_identity: &str,
) -> String {
    let next_moment_order = next_moment_order.to_string();
    format!(
        "moment-{}",
        hash_fields(&[
            producer_id.as_bytes(),
            workspace_id.as_bytes(),
            object_id.as_bytes(),
            next_moment_order.as_bytes(),
            operation.as_bytes(),
            mutation_identity.as_bytes(),
        ])
    )
}

/// Derive a capture delete moment id with the same order-based scheme as a
/// capture write.
pub fn derive_capture_retire_moment_id(
    producer_id: &str,
    workspace_id: &str,
    object_id: &str,
    next_moment_order: i64,
    operation: &str,
    mutation_identity: &str,
) -> String {
    derive_capture_moment_id(
        producer_id,
        workspace_id,
        object_id,
        next_moment_order,
        operation,
        mutation_identity,
    )
}

fn hash_request_fields(request_id: Option<&str>, fields: &[&[u8]]) -> String {
    request_id.map_or_else(String::new, |_| hash_fields(fields))
}

/// The path's final segment, for per-file capture summaries (TS
/// `pathBasename` parity — paths are stored with `/` separators).
fn path_basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use super::{
        CaptureIngestBatchContext, MOMENT_TEXT_HYDRATION_CAP_BYTES, NEXT_MOMENT_ORDER_SQL,
        ProjectedWriteText, VersionedTextStore, capture_ingest_in_batch_with_admission_in_tx,
        derive_capture_moment_id, derive_capture_object_id, derive_disambiguated_capture_object_id,
        hash_fields, hash_optional_text_fields, next_moment_order, text_blob_sha256,
        write_projected_text_in_tx, write_text_in_tx,
    };
    use crate::{
        CaptureIngest, CaptureRetire, DomainError, RenameTextFile, WriteResult, WriteText,
    };
    use dohc_engine_storage::{
        EngineStore, MaterializationJobSpec, NoFaults, Preimage, TxnOutcome, put_binary_blob,
        record_completed_job,
    };
    use dohc_engine_testkit::ScratchDir;
    use rusqlite::{Connection, params};

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

    fn capture_input(path: &str, text: String, now_ms: i64) -> CaptureIngest {
        CaptureIngest {
            workspace_id: "ws".to_owned(),
            version_id: "main".to_owned(),
            path: path.to_owned(),
            text,
            metadata_origin: "capture".to_owned(),
            metadata_summary: Some("Captured test file".to_owned()),
            metadata_correlation_id: Some("capture-pass-1".to_owned()),
            author_json: Some(r#"{"kind":"capture-test"}"#.to_owned()),
            now_ms,
            request_id: None,
            claim_foreign_head: false,
        }
    }

    fn capture_text(store: &mut EngineStore, path: &str, text: String, now_ms: i64) -> WriteResult {
        VersionedTextStore::new(store)
            .capture_ingest(&capture_input(path, text, now_ms), &NoFaults)
            .expect("capture text")
    }

    fn assert_capture_matches_hydrated(store: &mut EngineStore, captured: &WriteResult) {
        let versioned = VersionedTextStore::new(store);
        let hydrated_moment = versioned
            .get_moment("ws", &captured.moment.moment_id)
            .expect("read captured moment")
            .expect("captured moment exists");
        let hydrated_snapshot = versioned
            .read_text("ws", "main", &captured.snapshot.path)
            .expect("read captured snapshot")
            .expect("captured snapshot exists");

        assert_eq!(captured.moment, hydrated_moment);
        assert_eq!(captured.snapshot, hydrated_snapshot);
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

    #[test]
    fn capture_batch_preserves_producer_and_global_high_water_parity() {
        fn initialized_store(db: &std::path::Path) -> EngineStore {
            let mut store = EngineStore::open(db, 1).expect("open store");
            VersionedTextStore::new(&mut store)
                .ensure_main_version("ws", "main", 1, &NoFaults)
                .expect("ensure main version");
            let outcome = store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "INSERT INTO sync_identity \
                         (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
                         VALUES ('ws', 'origin-capture-parity', 'epoch', 'stream', 1)",
                        [],
                    )
                    .map_err(DomainError::sql_persist)?;
                    let content_sha256 =
                        put_binary_blob(tx, b"capture high-water fixture")
                            .map_err(DomainError::from)?;
                    record_completed_job(
                        tx,
                        &MaterializationJobSpec {
                            job_id: "mutation-mat_capture-high-water".to_owned(),
                            workspace_id: "ws".to_owned(),
                            target_path: "notes/high-water.md".to_owned(),
                            content_sha256,
                            preimage: Preimage::Absent,
                            target_generation: 40,
                            now_ms: 1,
                        },
                    )
                    .map_err(DomainError::from)?;
                    Ok::<_, DomainError>(())
                })
                .expect("seed producer and high water");
            super::committed(outcome).expect("commit producer and high water");
            store
        }

        let sequential_scratch = ScratchDir::new().expect("sequential scratch");
        let batch_scratch = ScratchDir::new().expect("batch scratch");
        let mut sequential = initialized_store(
            &dohc_engine_testkit::engine_db_path(&sequential_scratch).expect("sequential db"),
        );
        let mut batched = initialized_store(
            &dohc_engine_testkit::engine_db_path(&batch_scratch).expect("batch db"),
        );
        let inputs = vec![
            capture_input("notes/a.md", "alpha".to_owned(), 10),
            capture_input("notes/b.md", "bravo".to_owned(), 11),
            capture_input("notes/c.md", "charlie".to_owned(), 12),
        ];

        let expected = inputs
            .iter()
            .map(|input| {
                VersionedTextStore::new(&mut sequential)
                    .capture_ingest(input, &NoFaults)
                    .expect("sequential capture")
            })
            .collect::<Vec<_>>();

        let outcome = batched
            .write_with(&NoFaults, |tx| {
                let mut context = CaptureIngestBatchContext::new(tx, "ws", "main")?;
                let mut results = Vec::with_capacity(inputs.len());
                for input in &inputs {
                    tx.execute_batch("SAVEPOINT capture_batch_parity")
                        .map_err(DomainError::sql_persist)?;
                    let result = capture_ingest_in_batch_with_admission_in_tx(
                        tx,
                        input,
                        &mut context,
                        |_, _, _| Ok::<_, DomainError>(()),
                    )?;
                    tx.execute_batch("RELEASE capture_batch_parity")
                        .map_err(DomainError::sql_persist)?;
                    context.commit_result(&result)?;
                    results.push(result);
                }
                Ok::<_, DomainError>(results)
            })
            .expect("capture batch");
        let actual = super::committed(outcome).expect("commit capture batch");

        assert_eq!(actual, expected);
        assert_eq!(
            actual
                .iter()
                .map(|result| result.moment.moment_order)
                .collect::<Vec<_>>(),
            vec![41, 42, 43],
            "the materialization-job high-water must seed the shared cursor"
        );
    }

    #[test]
    fn capture_batch_reuses_candidate_after_item_savepoint_rollback() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        let outcome = store
            .write_with(&NoFaults, |tx| {
                let mut context = CaptureIngestBatchContext::new(tx, "ws", "main")?;
                tx.execute_batch("SAVEPOINT capture_batch_failed_item")
                    .map_err(DomainError::sql_persist)?;
                let rolled_back = capture_ingest_in_batch_with_admission_in_tx(
                    tx,
                    &capture_input("notes/rolled-back.md", "first".to_owned(), 10),
                    &mut context,
                    |_, _, _| Ok::<_, DomainError>(()),
                )?;
                let candidate = rolled_back.moment.moment_order;
                tx.execute_batch(
                    "ROLLBACK TO capture_batch_failed_item; \
                     RELEASE capture_batch_failed_item",
                )
                .map_err(DomainError::sql_persist)?;

                tx.execute_batch("SAVEPOINT capture_batch_retry_candidate")
                    .map_err(DomainError::sql_persist)?;
                let captured = capture_ingest_in_batch_with_admission_in_tx(
                    tx,
                    &capture_input("notes/committed.md", "second".to_owned(), 11),
                    &mut context,
                    |_, _, _| Ok::<_, DomainError>(()),
                )?;
                tx.execute_batch("RELEASE capture_batch_retry_candidate")
                    .map_err(DomainError::sql_persist)?;
                context.commit_result(&captured)?;
                Ok::<_, DomainError>((candidate, captured))
            })
            .expect("capture around rolled-back item");
        let (candidate, captured) =
            super::committed(outcome).expect("commit surviving capture item");

        assert_eq!(captured.moment.moment_order, candidate);
        assert_eq!(captured.snapshot.path, "notes/committed.md");
        assert!(
            VersionedTextStore::new(&mut store)
                .read_text("ws", "main", "notes/rolled-back.md")
                .expect("read rolled-back path")
                .is_none(),
            "the failed item's savepoint must leave no state behind"
        );
    }

    #[test]
    fn capture_batch_accepts_a_final_maximum_moment_order() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");
        let outcome = store
            .write_with(&NoFaults, |tx| {
                let content_sha256 = put_binary_blob(tx, b"moment-order exhaustion fixture")
                    .map_err(DomainError::from)?;
                record_completed_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: "mutation-mat_before-order-exhaustion".to_owned(),
                        workspace_id: "ws".to_owned(),
                        target_path: "notes/before-order-exhaustion.md".to_owned(),
                        content_sha256,
                        preimage: Preimage::Absent,
                        target_generation: i64::MAX - 1,
                        now_ms: 1,
                    },
                )
                .map_err(DomainError::from)?;
                Ok::<_, DomainError>(())
            })
            .expect("seed maximum high-water");
        super::committed(outcome).expect("commit maximum high-water");

        let outcome = store
            .write_with(&NoFaults, |tx| {
                let mut context = CaptureIngestBatchContext::new(tx, "ws", "main")?;
                tx.execute_batch("SAVEPOINT capture_maximum_order")
                    .map_err(DomainError::sql_persist)?;
                let captured = capture_ingest_in_batch_with_admission_in_tx(
                    tx,
                    &capture_input("notes/final.md", "final".to_owned(), 2),
                    &mut context,
                    |_, _, _| Ok::<_, DomainError>(()),
                )?;
                tx.execute_batch("RELEASE capture_maximum_order")
                    .map_err(DomainError::sql_persist)?;
                context.commit_result(&captured)?;
                assert!(
                    matches!(
                        context.proposed_moment_order(tx),
                        Err(DomainError::StateCorrupt {
                            reason: "capture batch moment order overflowed"
                        })
                    ),
                    "only a later mutation should observe cursor exhaustion"
                );
                Ok::<_, DomainError>(captured)
            })
            .expect("capture final maximum-order item");
        let captured = super::committed(outcome).expect("commit final maximum-order item");
        assert_eq!(captured.moment.moment_order, i64::MAX);
    }

    #[test]
    fn direct_write_borrows_text_and_projected_write_moves_owned_text() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        let direct = WriteText {
            workspace_id: "ws".to_owned(),
            version_id: "main".to_owned(),
            object_id: "direct-object".to_owned(),
            path: "direct.md".to_owned(),
            text: "direct body".to_owned(),
            moment_id: "direct-moment".to_owned(),
            metadata_origin: "test".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 2,
            request_id: None,
        };
        let direct_outcome = store
            .write_with(&NoFaults, |tx| write_text_in_tx(tx, &direct))
            .expect("direct write");
        assert!(matches!(direct_outcome, TxnOutcome::Committed(_)));

        let projected_text = "projected body".repeat(4_096);
        let projected_allocation = projected_text.as_ptr();
        let projected_outcome = store
            .write_with(&NoFaults, |tx| {
                write_projected_text_in_tx(
                    tx,
                    ProjectedWriteText {
                        workspace_id: "ws",
                        version_id: "main",
                        object_id: "projected-object",
                        path: Cow::Borrowed("projected.md"),
                        text: Cow::Owned(projected_text),
                        moment_id: "projected-moment",
                        metadata_origin: "ydoc",
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 3,
                        request_id: None,
                    },
                )
            })
            .expect("projected write");
        let projected = match projected_outcome {
            TxnOutcome::Committed(projected) => projected,
            TxnOutcome::Crashed { .. } => panic!("projected write crashed"),
        };

        assert_eq!(
            projected.snapshot.text.as_ptr(),
            projected_allocation,
            "the projected body allocation must move into the returned snapshot"
        );
    }

    #[test]
    fn fresh_capture_reuses_prepared_state_without_result_readback() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        let text = "prepared capture body";
        let captured = VersionedTextStore::new(&mut store)
            .capture_ingest(
                &CaptureIngest {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path: "notes/fresh.md".to_owned(),
                    text: text.to_owned(),
                    metadata_origin: "capture".to_owned(),
                    metadata_summary: Some("Captured fresh file".to_owned()),
                    metadata_correlation_id: Some("capture-pass-1".to_owned()),
                    author_json: Some(r#"{"kind":"capture-test"}"#.to_owned()),
                    now_ms: 2,
                    request_id: None,
                    claim_foreign_head: false,
                },
                &NoFaults,
            )
            .expect("capture fresh text");

        let expected_blob_sha256 = text_blob_sha256(text);
        assert_eq!(captured.snapshot.blob_sha256, expected_blob_sha256);
        assert_eq!(
            captured.moment.after_blob_sha256.as_deref(),
            Some(expected_blob_sha256.as_str())
        );
        let versioned = VersionedTextStore::new(&mut store);
        let hydrated_moment = versioned
            .get_moment("ws", &captured.moment.moment_id)
            .expect("read captured moment")
            .expect("captured moment exists");
        let hydrated_snapshot = versioned
            .read_text("ws", "main", "notes/fresh.md")
            .expect("read captured snapshot")
            .expect("captured snapshot exists");

        assert_eq!(captured.moment, hydrated_moment);
        assert_eq!(captured.snapshot, hydrated_snapshot);
    }

    #[test]
    fn fresh_capture_reused_corrupt_blob_fails_closed_and_rolls_back() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        let text = "prepared capture body";
        let blob_sha256 = text_blob_sha256(text);
        let seed = store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
                    params![blob_sha256, text.len() as i64, "corrupt"],
                )
                .map_err(DomainError::sql_persist)?;
                Ok::<_, DomainError>(())
            })
            .expect("seed corrupt blob");
        assert!(matches!(seed, TxnOutcome::Committed(())));

        let error = VersionedTextStore::new(&mut store)
            .capture_ingest(
                &capture_input("notes/corrupt.md", text.to_owned(), 2),
                &NoFaults,
            )
            .expect_err("capture must reject the corrupt reused blob");

        assert!(matches!(
            error,
            DomainError::StateCorrupt {
                reason: "moment blob length does not match its content"
            }
        ));

        let durable_rows = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT \
                       (SELECT COUNT(*) FROM file_objects WHERE workspace_id = 'ws'), \
                       (SELECT COUNT(*) FROM path_aliases WHERE workspace_id = 'ws'), \
                       (SELECT COUNT(*) FROM snapshots WHERE workspace_id = 'ws'), \
                       (SELECT COUNT(*) FROM moments WHERE workspace_id = 'ws')",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )
            })
            .expect("inspect rolled-back capture");
        assert_eq!(
            durable_rows,
            (0, 0, 0, 0),
            "the integrity failure must roll back every capture row"
        );
        let corrupt_blob = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT byte_length, text FROM blobs WHERE sha256 = ?1",
                    [&blob_sha256],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
            })
            .expect("read corrupt seed after rollback");
        assert_eq!(corrupt_blob, (text.len() as i64, "corrupt".to_owned()));
    }

    #[test]
    fn fresh_capture_fast_path_matches_hydration_at_history_text_cap() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        for (index, byte_length) in [
            MOMENT_TEXT_HYDRATION_CAP_BYTES,
            MOMENT_TEXT_HYDRATION_CAP_BYTES + 1,
        ]
        .into_iter()
        .enumerate()
        {
            let captured = capture_text(
                &mut store,
                &format!("notes/history-cap-{index}.md"),
                "x".repeat(byte_length),
                index as i64 + 2,
            );

            assert_eq!(
                captured.moment.after_text.is_some(),
                byte_length == MOMENT_TEXT_HYDRATION_CAP_BYTES
            );
            assert_capture_matches_hydrated(&mut store, &captured);
        }
    }

    #[test]
    fn renamed_capture_path_uses_disambiguated_object_fast_path() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        let original_path = "notes/renamed.md";
        let first = capture_text(&mut store, original_path, "first body".to_owned(), 2);
        assert_eq!(
            first.object.object_id,
            derive_capture_object_id("ws", "main", original_path)
        );
        VersionedTextStore::new(&mut store)
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    from_path: original_path.to_owned(),
                    to_path: "notes/archive.md".to_owned(),
                    moment_id: "rename-captured-file".to_owned(),
                    request_id: None,
                    metadata_origin: "test".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 3,
                },
                &NoFaults,
            )
            .expect("rename captured file");

        let replacement = capture_input(original_path, "replacement body".to_owned(), 4);
        let outcome = store
            .write_with(&NoFaults, |tx| {
                let proposed_order = next_moment_order(tx)?;
                let mut context = CaptureIngestBatchContext::new(tx, "ws", "main")?;
                tx.execute_batch("SAVEPOINT capture_disambiguation")
                    .map_err(DomainError::sql_persist)?;
                let captured = capture_ingest_in_batch_with_admission_in_tx(
                    tx,
                    &replacement,
                    &mut context,
                    |_, _, _| Ok::<_, DomainError>(()),
                )?;
                tx.execute_batch("RELEASE capture_disambiguation")
                    .map_err(DomainError::sql_persist)?;
                context.commit_result(&captured)?;
                Ok::<_, DomainError>((proposed_order, captured))
            })
            .expect("capture disambiguated path");
        let (proposed_order, captured) =
            super::committed(outcome).expect("commit disambiguated capture");

        assert_ne!(captured.object.object_id, first.object.object_id);
        assert_eq!(captured.moment.moment_order, proposed_order);
        assert_eq!(
            captured.object.object_id,
            derive_disambiguated_capture_object_id("ws", "main", original_path, proposed_order),
            "object disambiguation and the persisted moment must share one order candidate"
        );
        let producer_id = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT engine_uuid FROM engine_ownership WHERE rowid_guard=1",
                    [],
                    |row| row.get::<_, String>(0),
                )
            })
            .expect("read capture producer");
        let (summary_kind, summary) = hash_optional_text_fields(Some("Captured test file"));
        let (correlation_kind, correlation) = hash_optional_text_fields(Some("capture-pass-1"));
        let mutation_identity = hash_fields(&[
            original_path.as_bytes(),
            text_blob_sha256("replacement body").as_bytes(),
            b"capture",
            summary_kind,
            summary,
            correlation_kind,
            correlation,
            b"some",
            br#"{"kind":"capture-test"}"#,
            b"4",
        ]);
        assert_eq!(
            captured.moment.moment_id,
            derive_capture_moment_id(
                &producer_id,
                "ws",
                &captured.object.object_id,
                proposed_order,
                "write",
                &mutation_identity,
            ),
            "moment derivation must use the same order candidate as object disambiguation"
        );

        assert_capture_matches_hydrated(&mut store, &captured);
    }

    #[test]
    fn retired_capture_reuses_unaliased_object_with_result_hydration() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        let path = "notes/recreated.md";
        let first = capture_text(&mut store, path, "first body".to_owned(), 2);
        VersionedTextStore::new(&mut store)
            .capture_retire(
                &CaptureRetire {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path: path.to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 3,
                    request_id: None,
                    only_if_text_head: true,
                    only_if_capture_origin: true,
                    allow_ydoc_origin: false,
                },
                &NoFaults,
            )
            .expect("retire captured file");

        let captured = capture_text(&mut store, path, "recreated body".to_owned(), 4);

        assert_eq!(captured.object.object_id, first.object.object_id);

        assert_capture_matches_hydrated(&mut store, &captured);
    }
}
