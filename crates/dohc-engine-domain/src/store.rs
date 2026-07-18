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

use crate::error::DomainError;
use crate::records::{
    CreateNamedVersion, DeleteResult, DeleteTextFile, FileObjectRecord, ListMomentsQuery, MomentOp,
    MomentPage, MomentRecord, RenameResult, RenameTextFile, RollbackTextFileMutation,
    SnapshotRecord, TextSnapshot, VersionKind, VersionRecord, WriteResult, WriteText,
};
use dohc_engine_storage::{EngineStore, FaultInjector, StorageError, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// Maximum text-file size accepted by [`VersionedTextStore::write_text`], in
/// UTF-8 bytes. Mirrors the TS engine's 10 MB text cap
/// (`versions-write-text-file`).
pub const MAX_TEXT_BYTES: usize = 10 * 1024 * 1024;

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
        let outcome = self
            .store
            .write_with(faults, |tx| write_text_in_tx(tx, input))?;
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
        non_empty(&input.workspace_id, "workspace_id")?;
        non_empty(&input.version_id, "version_id")?;
        non_empty(&input.moment_id, "moment_id")?;
        let mut normalized_input = input.clone();
        normalized_input.from_path = validate_addressable_plaintext_path(&input.from_path)?;
        normalized_input.to_path = validate_plaintext_storable_path(&input.to_path)?;
        let input = &normalized_input;
        if input.from_path == input.to_path {
            return Err(DomainError::InvalidPath {
                reason: "rename source and destination must differ",
            });
        }

        let ws = &input.workspace_id;
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

        let after = SnapshotRecord {
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
        };
        let outcome = self.store.write_with(faults, |tx| {
            let moment_order = next_moment_order(tx)?;
            tx.execute(
                "INSERT INTO moments \
                 (workspace_id, moment_order, moment_id, version_id, object_id, path, \
                  recorded_at_ms, operation, after_blob_sha256, before_present, \
                  before_blob_sha256, before_latest_moment_id, metadata_origin, author_json, \
                  sync_record_only, after_content_kind, after_binary_sha256, \
                  before_content_kind, before_binary_sha256) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'rename', ?8, 2, ?8, ?9, ?10, ?11, \
                         NULL, ?12, ?13, ?12, ?13)",
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
            upsert_snapshot(tx, &after)?;

            Ok::<_, DomainError>(RenameResult {
                object: object.clone(),
                before: snapshot_text_view(&before),
                after: snapshot_text_view(&after),
                moment: MomentRecord {
                    moment_order,
                    moment_id: input.moment_id.clone(),
                    version_id: input.version_id.clone(),
                    object_id: before.object_id.clone(),
                    path: input.to_path.clone(),
                    recorded_at_ms: input.now_ms,
                    operation: MomentOp::Rename,
                    after_content_kind: before.content_kind.clone(),
                    after_blob_sha256: before.blob_sha256.clone(),
                    after_binary_sha256: before.binary_sha256.clone(),
                    before_present: true,
                    before_blob_sha256: before.blob_sha256.clone(),
                    before_content_kind: before.content_kind.clone(),
                    before_binary_sha256: before.binary_sha256.clone(),
                    before_latest_moment_id: Some(before.latest_moment_id.clone()),
                    metadata_origin: input.metadata_origin.clone(),
                    author_json: input.author_json.clone(),
                    sync_record_only: false,
                },
            })
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
    ) -> Result<(), DomainError> {
        non_empty(&input.workspace_id, "workspace_id")?;
        non_empty(&input.version_id, "version_id")?;
        non_empty(&input.mutation_moment_id, "moment_id")?;
        let mut normalized_input = input.clone();
        normalized_input.path = validate_addressable_plaintext_path(&input.path)?;
        let input = &normalized_input;

        let ws = &input.workspace_id;
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
            tx.execute(
                "DELETE FROM moments WHERE workspace_id = ?1 AND moment_id = ?2",
                params![ws, input.mutation_moment_id],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "DELETE FROM engine_requests WHERE result_seq = ?1",
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
            Ok::<_, DomainError>(())
        })?;
        committed(outcome)
    }

    // -------------------------------------------------------------------- reads

    /// Read the current text snapshot for `path` in `version`, or `None`. Fails
    /// closed (`VersionNotFound`) on an unknown version so a bad version never
    /// looks like a missing file (`versions-read-text-file` contract).
    ///
    /// BINARY-HEAD FOOTGUN: for a binary head this returns a [`TextSnapshot`]
    /// whose `text` is `""` and whose `blob_sha256` carries the BINARY sha (a
    /// `binary_blobs` ref, NOT a `blobs` ref). An empty `text` here does NOT mean
    /// an empty text file — a caller that must distinguish binary from empty text
    /// has to consult `content_kind` on the underlying snapshot, which this
    /// text-compatibility view does not surface.
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
            get_snapshot(conn, workspace_id, version_id, &object_id)
                .map(|snapshot| snapshot.map(|value| snapshot_text_view(&value)))
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
                 before_latest_moment_id, metadata_origin, author_json, sync_record_only, \
                 COALESCE(after_content_kind, 'text'), after_binary.sha256, \
                 COALESCE(before_content_kind, 'text'), before_binary.sha256 \
                 FROM moments m \
                 LEFT JOIN binary_blobs after_binary ON after_binary.sha256 = m.after_binary_sha256 \
                 LEFT JOIN binary_blobs before_binary ON before_binary.sha256 = m.before_binary_sha256 \
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

    /// List every text snapshot in `version`, ordered by path.
    pub fn list_snapshots(
        &self,
        workspace_id: &str,
        version_id: &str,
    ) -> Result<Vec<TextSnapshot>, DomainError> {
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT s.object_id, s.path, b.text, s.blob_sha256, s.updated_at_ms, \
                     s.latest_moment_id, s.metadata_origin, \
                     COALESCE(s.content_kind, 'text'), bb.sha256 FROM snapshots s \
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
                let snapshot = row.map_err(DomainError::sql_corrupt)??;
                out.push(snapshot_text_view(&snapshot));
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
    ) -> Result<Vec<TextSnapshot>, DomainError> {
        self.store.read_with(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT f.object_id, f.path, b.text, f.blob_sha256, f.updated_at_ms, \
                     f.latest_moment_id, f.metadata_origin, \
                     COALESCE(f.content_kind, 'text'), bb.sha256 FROM fork_base_snapshots f \
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
                let snapshot = row.map_err(DomainError::sql_corrupt)??;
                out.push(snapshot_text_view(&snapshot));
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
        non_empty(&input.workspace_id, "workspace_id")?;
        non_empty(&input.new_version_id, "version_id")?;
        non_empty(&input.from_version_id, "version_id")?;
        if input.name.is_empty() {
            return Err(DomainError::InvalidInput {
                reason: "version name must not be empty",
            });
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
                return Err(DomainError::InvalidInput {
                    reason: "new version id already exists",
                });
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
                   latest_moment_id, metadata_origin, content_kind, binary_sha256) \
                  SELECT workspace_id, ?2, object_id, path, blob_sha256, updated_at_ms, \
                   latest_moment_id, metadata_origin, content_kind, binary_sha256 FROM snapshots \
                 WHERE workspace_id = ?1 AND version_id = ?3",
                params![ws, input.new_version_id, input.from_version_id],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "INSERT INTO fork_base_snapshots \
                  (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, \
                   latest_moment_id, metadata_origin, content_kind, binary_sha256) \
                  SELECT workspace_id, ?2, object_id, path, blob_sha256, updated_at_ms, \
                   latest_moment_id, metadata_origin, content_kind, binary_sha256 FROM snapshots \
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
            record_request(tx, input.request_id.as_deref(), &payload_hash, 0, input.now_ms)?;
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
    non_empty(&input.moment_id, "moment_id")?;
    let mut normalized = input.clone();
    normalized.path = validate_plaintext_storable_path(&input.path)?;
    validate_text(&normalized.text)?;
    Ok(normalized)
}

#[doc(hidden)]
pub fn validate_write_input(input: &WriteText) -> Result<(), DomainError> {
    normalized_write_input(input).map(|_| ())
}

/// Validate a delete and return the input with its path normalized through the
/// R07 addressable-plaintext floor (only an ignored path is rejected — an
/// existing tracked or secret-shadowed file is still deletable).
fn normalized_delete_input(input: &DeleteTextFile) -> Result<DeleteTextFile, DomainError> {
    non_empty(&input.workspace_id, "workspace_id")?;
    non_empty(&input.version_id, "version_id")?;
    non_empty(&input.moment_id, "moment_id")?;
    let mut normalized = input.clone();
    normalized.path = validate_addressable_plaintext_path(&input.path)?;
    Ok(normalized)
}

#[doc(hidden)]
pub fn validate_delete_input(input: &DeleteTextFile) -> Result<(), DomainError> {
    normalized_delete_input(input).map(|_| ())
}

/// Apply an R05 text write inside a caller-owned compound transaction. R06
/// uses this seam so the canonical mutation, conflict transition, and durable
/// materialization intent commit together rather than becoming three writes.
#[doc(hidden)]
pub fn write_text_in_tx(
    tx: &Transaction<'_>,
    input: &WriteText,
) -> Result<WriteResult, DomainError> {
    let normalized_input = normalized_write_input(input)?;
    let input = &normalized_input;
    let ws = &input.workspace_id;
    if !version_exists(tx, ws, &input.version_id)? {
        return Err(DomainError::VersionNotFound);
    }

    let payload_hash = hash_fields(&[
        input.version_id.as_bytes(),
        input.path.as_bytes(),
        input.text.as_bytes(),
        input.moment_id.as_bytes(),
        input.object_id.as_bytes(),
    ]);
    if let Some(request_id) = &input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        return reconstruct_write(tx, input);
    }
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
                return Err(DomainError::InvalidInput {
                    reason: "object_id is already bound to another object",
                });
            }
            None
        }
    };
    let is_new_object = existing_object.is_none();
    let object_id = existing_object.unwrap_or_else(|| input.object_id.clone());
    let blob = text_blob_sha256(&input.text);
    let before_blob = before.as_ref().and_then(|s| s.blob_sha256.clone());
    let before_content_kind = before
        .as_ref()
        .map_or_else(|| "text".to_owned(), |s| s.content_kind.clone());
    let before_binary_sha256 = before.as_ref().and_then(|s| s.binary_sha256.clone());
    let before_latest_moment_id = before.as_ref().map(|s| s.latest_moment_id.clone());
    let moment_order = next_moment_order(tx)?;

    if is_new_object {
        tx.execute(
            "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) VALUES (?1, ?2, ?3)",
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
           before_latest_moment_id, metadata_origin, author_json, sync_record_only, \
           after_content_kind, after_binary_sha256, before_content_kind, before_binary_sha256) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'write', ?8, ?9, ?10, ?11, ?12, ?13, \
                  NULL, 'text', NULL, ?14, ?15)",
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
            input.author_json,
            before_content_kind,
            before_binary_sha256,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "INSERT INTO snapshots \
         (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, \
           latest_moment_id, metadata_origin, content_kind, binary_sha256) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'text', NULL) \
         ON CONFLICT(workspace_id, version_id, object_id) DO UPDATE SET \
           path = excluded.path, blob_sha256 = excluded.blob_sha256, \
           updated_at_ms = excluded.updated_at_ms, latest_moment_id = excluded.latest_moment_id, \
           metadata_origin = excluded.metadata_origin, content_kind = excluded.content_kind, \
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
        ],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "INSERT INTO replication_journal (doc_id, op_kind, created_at_ms) \
         VALUES (?1, 'moment.append', ?2)",
        params![object_id, input.now_ms],
    )
    .map_err(DomainError::sql_persist)?;
    record_request(
        tx,
        input.request_id.as_deref(),
        &payload_hash,
        moment_order,
        input.now_ms,
    )?;

    Ok(WriteResult {
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
        },
        moment: MomentRecord {
            moment_order,
            moment_id: input.moment_id.clone(),
            version_id: input.version_id.clone(),
            object_id,
            path: input.path.clone(),
            recorded_at_ms: input.now_ms,
            operation: MomentOp::Write,
            after_content_kind: "text".to_owned(),
            after_blob_sha256: Some(blob),
            after_binary_sha256: None,
            before_present: before.is_some(),
            before_blob_sha256: before_blob,
            before_content_kind,
            before_binary_sha256,
            before_latest_moment_id,
            metadata_origin: input.metadata_origin.clone(),
            author_json: input.author_json.clone(),
            sync_record_only: false,
        },
        deduped: false,
    })
}

fn reconstruct_write(conn: &Connection, input: &WriteText) -> Result<WriteResult, DomainError> {
    let moment = get_moment(conn, &input.workspace_id, &input.moment_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "deduped write has no moment",
        },
    )?;
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
    Ok(WriteResult {
        snapshot: TextSnapshot {
            workspace_id: input.workspace_id.clone(),
            version_id: moment.version_id.clone(),
            object_id: moment.object_id.clone(),
            path: moment.path.clone(),
            text,
            blob_sha256,
            updated_at_ms: moment.recorded_at_ms,
            latest_moment_id: moment.moment_id.clone(),
            metadata_origin: moment.metadata_origin.clone(),
        },
        moment,
        deduped: true,
    })
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
           before_latest_moment_id, metadata_origin, author_json, sync_record_only, \
           after_content_kind, after_binary_sha256, before_content_kind, before_binary_sha256) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'delete', ?8, 2, ?8, ?9, ?10, ?11, \
                  NULL, ?12, ?13, ?12, ?13)",
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

    Ok(DeleteResult {
        object,
        before: snapshot_text_view(&before),
        moment: MomentRecord {
            moment_order,
            moment_id: input.moment_id.clone(),
            version_id: input.version_id.clone(),
            object_id: before.object_id.clone(),
            path: input.path.clone(),
            recorded_at_ms: input.now_ms,
            operation: MomentOp::Delete,
            after_content_kind: before.content_kind.clone(),
            after_blob_sha256: before.blob_sha256.clone(),
            after_binary_sha256: before.binary_sha256.clone(),
            before_present: true,
            before_blob_sha256: before.blob_sha256.clone(),
            before_content_kind: before.content_kind.clone(),
            before_binary_sha256: before.binary_sha256.clone(),
            before_latest_moment_id: Some(before.latest_moment_id.clone()),
            metadata_origin: input.metadata_origin.clone(),
            author_json: input.author_json.clone(),
            sync_record_only: false,
        },
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
fn validate_addressable_plaintext_path(path: &str) -> Result<String, DomainError> {
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

fn moment_exists(
    conn: &Connection,
    workspace_id: &str,
    moment_id: &str,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM moments WHERE workspace_id = ?1 AND moment_id = ?2",
            params![workspace_id, moment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
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
    // Store-global MAX+1. Correct for one-workspace-per-engine.db (global ==
    // per-workspace); a future multi-workspace / share-mount shard MUST add a
    // `WHERE workspace_id = ?` bound here (see the `moments` schema comment).
    let max: Option<i64> = conn
        .query_row("SELECT MAX(moment_order) FROM moments", [], |row| {
            row.get(0)
        })
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

fn get_snapshot(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<Option<SnapshotRecord>, DomainError> {
    let row = conn
        .query_row(
            "SELECT s.object_id, s.path, b.text, s.blob_sha256, s.updated_at_ms, \
         s.latest_moment_id, s.metadata_origin, COALESCE(s.content_kind, 'text'), \
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
          latest_moment_id, metadata_origin, content_kind, binary_sha256) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
         ON CONFLICT(workspace_id, version_id, object_id) DO UPDATE SET \
          path = excluded.path, blob_sha256 = excluded.blob_sha256, \
          updated_at_ms = excluded.updated_at_ms, latest_moment_id = excluded.latest_moment_id, \
          metadata_origin = excluded.metadata_origin, content_kind = excluded.content_kind, \
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
            snapshot.content_kind,
            snapshot.binary_sha256,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

/// Project a [`SnapshotRecord`] into the text-compatibility [`TextSnapshot`].
///
/// BINARY-HEAD FOOTGUN: a binary head maps to `text: ""` with `blob_sha256` set
/// to the record's BINARY sha (`binary_sha256`, a `binary_blobs` ref — NOT a
/// `blobs` text ref). The empty `text` is therefore ambiguous: it does not mean
/// "empty text file". This view drops `content_kind`, so a caller that needs to
/// tell a binary head apart from an empty text file must read `content_kind`
/// from the `SnapshotRecord` directly rather than trusting this projection.
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
             before_latest_moment_id, metadata_origin, author_json, sync_record_only, \
             COALESCE(after_content_kind, 'text'), after_binary.sha256, \
             COALESCE(before_content_kind, 'text'), before_binary.sha256 \
             FROM moments m \
             LEFT JOIN binary_blobs after_binary ON after_binary.sha256 = m.after_binary_sha256 \
             LEFT JOIN binary_blobs before_binary ON before_binary.sha256 = m.before_binary_sha256 \
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

fn resolve_rollback_before(
    conn: &Connection,
    input: &RollbackTextFileMutation,
    moment: &MomentRecord,
    before_state: MomentBeforeState,
) -> Result<Option<SnapshotRecord>, DomainError> {
    if before_state == MomentBeforeState::Present {
        let producer = match &moment.before_latest_moment_id {
            Some(before_latest_moment_id) => {
                get_moment(conn, &input.workspace_id, before_latest_moment_id)?.ok_or(
                    DomainError::StateCorrupt {
                        reason: "moment preimage producer is missing",
                    },
                )?
            }
            None => previous_object_moment_for_rollback(conn, input, moment)?.ok_or(
                DomainError::StateCorrupt {
                    reason: "moment preimage is missing its producer",
                },
            )?,
        };
        if producer.object_id != moment.object_id {
            return Err(DomainError::StateCorrupt {
                reason: "moment preimage producer belongs to another object",
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
            path: producer.path,
            text,
            blob_sha256,
            content_kind: moment.before_content_kind.clone(),
            binary_sha256,
            updated_at_ms: producer.recorded_at_ms,
            latest_moment_id: producer.moment_id,
            metadata_origin: producer.metadata_origin,
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

fn get_moment(
    conn: &Connection,
    workspace_id: &str,
    moment_id: &str,
) -> Result<Option<MomentRecord>, DomainError> {
    let row = conn
        .query_row(
            "SELECT moment_order, moment_id, version_id, object_id, path, recorded_at_ms, \
             operation, after_blob_sha256, before_present, before_blob_sha256, \
             before_latest_moment_id, metadata_origin, author_json, sync_record_only, \
             COALESCE(after_content_kind, 'text'), after_binary.sha256, \
             COALESCE(before_content_kind, 'text'), before_binary.sha256 \
             FROM moments m \
             LEFT JOIN binary_blobs after_binary ON after_binary.sha256 = m.after_binary_sha256 \
             LEFT JOIN binary_blobs before_binary ON before_binary.sha256 = m.before_binary_sha256 \
             WHERE workspace_id = ?1 AND moment_id = ?2",
            params![workspace_id, moment_id],
            map_moment_row,
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    row.transpose()
}

pub(crate) fn lookup_request(
    conn: &Connection,
    request_id: &str,
) -> Result<Option<RecordedRequest>, DomainError> {
    conn.query_row(
        "SELECT payload_hash FROM engine_requests WHERE request_id = ?1",
        params![request_id],
        |row| {
            Ok(RecordedRequest {
                payload_hash: row.get(0)?,
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
            "INSERT INTO engine_requests (request_id, payload_hash, result_seq, committed_at) \
             VALUES (?1, ?2, ?3, ?4)",
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
    let content_kind: String = row.get(7)?;
    let binary_sha256: Option<String> = row.get(8)?;
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
    let author_json: Option<String> = row.get(12)?;
    let sync_record_only: Option<i64> = row.get(13)?;
    let after_content_kind: String = row.get(14)?;
    let after_binary_sha256: Option<String> = row.get(15)?;
    let before_content_kind: String = row.get(16)?;
    let before_binary_sha256: Option<String> = row.get(17)?;
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
            author_json,
            // A record-only marker is a non-NULL, NON-ZERO value; NULL or 0 both
            // mean 'materialized' (PORTING.md §1, matching the aligned fork SQL).
            sync_record_only: matches!(sync_record_only, Some(v) if v != 0),
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

/// Deterministic fingerprint over NUL-separated fields (idempotency payloads).
pub(crate) fn hash_fields(fields: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for field in fields {
        hasher.update(field);
        hasher.update([0u8]);
    }
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}
