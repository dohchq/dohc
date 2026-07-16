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
    CreateNamedVersion, ListMomentsQuery, MomentOp, MomentPage, MomentRecord, TextSnapshot,
    VersionKind, VersionRecord, WriteResult, WriteText,
};
use dohc_engine_storage::{EngineStore, FaultInjector, StorageError, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

/// Maximum text-file size accepted by [`VersionedTextStore::write_text`], in
/// UTF-8 bytes. Mirrors the TS engine's 10 MB text cap
/// (`versions-write-text-file`).
pub const MAX_TEXT_BYTES: usize = 10 * 1024 * 1024;

/// The versioning domain bound to one workspace store. Cheap to construct per
/// call; holds only a mutable borrow of the writer.
pub struct VersionedTextStore<'a> {
    store: &'a mut EngineStore,
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
        non_empty(&input.workspace_id, "workspace_id")?;
        non_empty(&input.version_id, "version_id")?;
        non_empty(&input.moment_id, "moment_id")?;
        validate_path(&input.path)?;
        validate_text(&input.text)?;

        // `object_id` is part of the durable result for a first write, so it is
        // in the idempotency payload: a retry with a different generated id is a
        // reuse-mismatch, not a silent replay.
        let payload_hash = hash_fields(&[
            input.version_id.as_bytes(),
            input.path.as_bytes(),
            input.text.as_bytes(),
            input.moment_id.as_bytes(),
            input.object_id.as_bytes(),
        ]);

        // Pre-transaction validation + idempotency (single-writer: authoritative).
        let ws = &input.workspace_id;
        let prep = self.store.read_with(|conn| {
            if !version_exists(conn, ws, &input.version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            if let Some(request_id) = &input.request_id
                && let Some(recorded) = lookup_request(conn, request_id)?
            {
                if recorded.payload_hash != payload_hash {
                    return Err(DomainError::IdempotencyKeyReuseMismatch);
                }
                return Ok(WritePrep::Deduped);
            }
            if moment_exists(conn, ws, &input.moment_id)? {
                return Err(DomainError::DuplicateMomentId);
            }
            let existing_object = alias_object_id(conn, ws, &input.version_id, &input.path)?;
            let before = match &existing_object {
                Some(object_id) => get_snapshot(conn, ws, &input.version_id, object_id)?,
                None => {
                    // New path → mint a NEW object. The supplied id must be
                    // non-empty and not already bound; otherwise the snapshot
                    // upsert (keyed by object_id) would silently clobber another
                    // file's state. Fail closed instead.
                    if input.object_id.is_empty() {
                        return Err(DomainError::InvalidInput {
                            reason: "object_id must not be empty for a new path",
                        });
                    }
                    if object_exists(conn, ws, &input.object_id)? {
                        return Err(DomainError::InvalidInput {
                            reason: "object_id is already bound to another object",
                        });
                    }
                    None
                }
            };
            Ok(WritePrep::Apply(Box::new(WriteApply {
                existing_object,
                before,
            })))
        })?;

        let (existing_object, before) = match prep {
            WritePrep::Deduped => return self.reconstruct_write(input),
            WritePrep::Apply(apply) => (apply.existing_object, apply.before),
        };

        let is_new_object = existing_object.is_none();
        let object_id = existing_object.unwrap_or_else(|| input.object_id.clone());
        let blob = text_blob_sha256(&input.text);
        let before_blob = before.as_ref().map(|s| s.blob_sha256.clone());

        let outcome = self.store.write_with(faults, |tx| {
            let moment_order = next_moment_order(tx)?;
            if is_new_object {
                // Plain INSERT (not OR IGNORE): a collision here — after the
                // pre-check — must roll the whole write back, never reuse an
                // existing object.
                tx.execute(
                    "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                     VALUES (?1, ?2, ?3)",
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
                 (workspace_id, moment_order, moment_id, version_id, object_id, path, \
                  recorded_at_ms, operation, after_blob_sha256, before_present, \
                  before_blob_sha256, metadata_origin, author_json, sync_record_only) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'write', ?8, ?9, ?10, ?11, ?12, NULL)",
                params![
                    ws,
                    moment_order,
                    input.moment_id,
                    input.version_id,
                    object_id,
                    input.path,
                    input.now_ms,
                    blob,
                    before.is_some() as i64,
                    before_blob,
                    input.metadata_origin,
                    input.author_json,
                ],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "INSERT INTO snapshots \
                 (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, \
                  latest_moment_id, metadata_origin) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                 ON CONFLICT(workspace_id, version_id, object_id) DO UPDATE SET \
                  path = excluded.path, blob_sha256 = excluded.blob_sha256, \
                  updated_at_ms = excluded.updated_at_ms, \
                  latest_moment_id = excluded.latest_moment_id, \
                  metadata_origin = excluded.metadata_origin",
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
            // Compound-commit invariant: the replication journal entry rides the
            // same transaction (PORTING.md §9).
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

            Ok::<_, DomainError>(WriteResult {
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
                    object_id: object_id.clone(),
                    path: input.path.clone(),
                    recorded_at_ms: input.now_ms,
                    operation: MomentOp::Write,
                    after_blob_sha256: blob.clone(),
                    before_present: before.is_some(),
                    before_blob_sha256: before_blob.clone(),
                    metadata_origin: input.metadata_origin.clone(),
                    author_json: input.author_json.clone(),
                    sync_record_only: false,
                },
                deduped: false,
            })
        })?;
        committed(outcome)
    }

    /// Reconstruct the result of a previously-committed write for an
    /// exactly-once replay. Rebuilds the snapshot from the RECORDED moment's
    /// after-blob, NOT the live snapshot: if a later write updated the same
    /// path, its text/latest-moment must never leak into a timed-out client's
    /// replay (the exactly-once contract).
    fn reconstruct_write(&self, input: &WriteText) -> Result<WriteResult, DomainError> {
        let ws = &input.workspace_id;
        self.store.read_with(|conn| {
            let moment =
                get_moment(conn, ws, &input.moment_id)?.ok_or(DomainError::StateCorrupt {
                    reason: "deduped write has no moment",
                })?;
            let text =
                blob_text(conn, &moment.after_blob_sha256)?.ok_or(DomainError::StateCorrupt {
                    reason: "deduped write moment blob missing",
                })?;
            let snapshot = TextSnapshot {
                workspace_id: ws.clone(),
                version_id: moment.version_id.clone(),
                object_id: moment.object_id.clone(),
                path: moment.path.clone(),
                text,
                blob_sha256: moment.after_blob_sha256.clone(),
                updated_at_ms: moment.recorded_at_ms,
                latest_moment_id: moment.moment_id.clone(),
                metadata_origin: moment.metadata_origin.clone(),
            };
            Ok(WriteResult {
                snapshot,
                moment,
                deduped: true,
            })
        })
    }

    // -------------------------------------------------------------------- reads

    /// Read the current text snapshot for `path` in `version`, or `None`. Fails
    /// closed (`VersionNotFound`) on an unknown version so a bad version never
    /// looks like a missing file (`versions-read-text-file` contract).
    pub fn read_text(
        &self,
        workspace_id: &str,
        version_id: &str,
        path: &str,
    ) -> Result<Option<TextSnapshot>, DomainError> {
        self.store.read_with(|conn| {
            if !version_exists(conn, workspace_id, version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            let Some(object_id) = alias_object_id(conn, workspace_id, version_id, path)? else {
                return Ok(None);
            };
            get_snapshot(conn, workspace_id, version_id, &object_id)
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
                 metadata_origin, author_json, sync_record_only FROM moments WHERE workspace_id = ?1",
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
                     s.latest_moment_id, s.metadata_origin FROM snapshots s \
                     JOIN blobs b ON b.sha256 = s.blob_sha256 \
                     WHERE s.workspace_id = ?1 AND s.version_id = ?2 ORDER BY s.path",
                )
                .map_err(DomainError::sql_corrupt)?;
            let ws = workspace_id.to_owned();
            let ver = version_id.to_owned();
            let rows = stmt
                .query_map(params![workspace_id, version_id], move |row| {
                    Ok(TextSnapshot {
                        workspace_id: ws.clone(),
                        version_id: ver.clone(),
                        object_id: row.get(0)?,
                        path: row.get(1)?,
                        text: row.get(2)?,
                        blob_sha256: row.get(3)?,
                        updated_at_ms: row.get(4)?,
                        latest_moment_id: row.get(5)?,
                        metadata_origin: row.get(6)?,
                    })
                })
                .map_err(DomainError::sql_corrupt)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(DomainError::sql_corrupt)?);
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
                     f.latest_moment_id, f.metadata_origin FROM fork_base_snapshots f \
                     JOIN blobs b ON b.sha256 = f.blob_sha256 \
                     WHERE f.workspace_id = ?1 AND f.version_id = ?2 ORDER BY f.path",
                )
                .map_err(DomainError::sql_corrupt)?;
            let ws = workspace_id.to_owned();
            let ver = version_id.to_owned();
            let rows = stmt
                .query_map(params![workspace_id, version_id], move |row| {
                    Ok(TextSnapshot {
                        workspace_id: ws.clone(),
                        version_id: ver.clone(),
                        object_id: row.get(0)?,
                        path: row.get(1)?,
                        text: row.get(2)?,
                        blob_sha256: row.get(3)?,
                        updated_at_ms: row.get(4)?,
                        latest_moment_id: row.get(5)?,
                        metadata_origin: row.get(6)?,
                    })
                })
                .map_err(DomainError::sql_corrupt)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(DomainError::sql_corrupt)?);
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
                  latest_moment_id, metadata_origin) \
                 SELECT workspace_id, ?2, object_id, path, blob_sha256, updated_at_ms, \
                  latest_moment_id, metadata_origin FROM snapshots \
                 WHERE workspace_id = ?1 AND version_id = ?3",
                params![ws, input.new_version_id, input.from_version_id],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "INSERT INTO fork_base_snapshots \
                 (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, \
                  latest_moment_id, metadata_origin) \
                 SELECT workspace_id, ?2, object_id, path, blob_sha256, updated_at_ms, \
                  latest_moment_id, metadata_origin FROM snapshots \
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

/// Pre-transaction decision for a write. The apply payload is boxed so the two
/// variants stay similarly sized.
enum WritePrep {
    Deduped,
    Apply(Box<WriteApply>),
}

struct WriteApply {
    existing_object: Option<String>,
    before: Option<TextSnapshot>,
}

/// Pre-transaction decision for a fork.
enum ForkPrep {
    Deduped,
    Apply { fork_moment_id: Option<String> },
}

/// A prior request recovered from the idempotency ledger.
struct RecordedRequest {
    payload_hash: String,
}

// ============================================================================
// Free helpers (SQL over a borrowed connection/transaction).
// ============================================================================

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
fn validate_path(path: &str) -> Result<(), DomainError> {
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

fn next_moment_order(conn: &Connection) -> Result<i64, DomainError> {
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
) -> Result<Option<TextSnapshot>, DomainError> {
    conn.query_row(
        "SELECT s.object_id, s.path, b.text, s.blob_sha256, s.updated_at_ms, \
         s.latest_moment_id, s.metadata_origin FROM snapshots s \
         JOIN blobs b ON b.sha256 = s.blob_sha256 \
         WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.object_id = ?3",
        params![workspace_id, version_id, object_id],
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
             operation, after_blob_sha256, before_present, before_blob_sha256, metadata_origin, \
             author_json, sync_record_only FROM moments WHERE workspace_id = ?1 AND moment_id = ?2",
            params![workspace_id, moment_id],
            map_moment_row,
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    row.transpose()
}

fn lookup_request(
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

fn record_request(
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

fn map_moment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<MomentRecord, DomainError>> {
    let moment_order: i64 = row.get(0)?;
    let moment_id: String = row.get(1)?;
    let version_id: String = row.get(2)?;
    let object_id: String = row.get(3)?;
    let path: String = row.get(4)?;
    let recorded_at_ms: i64 = row.get(5)?;
    let op_str: String = row.get(6)?;
    let after_blob_sha256: String = row.get(7)?;
    let before_present: i64 = row.get(8)?;
    let before_blob_sha256: Option<String> = row.get(9)?;
    let metadata_origin: String = row.get(10)?;
    let author_json: Option<String> = row.get(11)?;
    let sync_record_only: Option<i64> = row.get(12)?;
    Ok(MomentOp::from_db(&op_str).map(|operation| MomentRecord {
        moment_order,
        moment_id,
        version_id,
        object_id,
        path,
        recorded_at_ms,
        operation,
        after_blob_sha256,
        before_present: before_present != 0,
        before_blob_sha256,
        metadata_origin,
        author_json,
        // A record-only marker is a non-NULL, NON-ZERO value; NULL or 0 both
        // mean 'materialized' (PORTING.md §1, matching the aligned fork SQL).
        sync_record_only: matches!(sync_record_only, Some(v) if v != 0),
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
fn hash_fields(fields: &[&[u8]]) -> String {
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
