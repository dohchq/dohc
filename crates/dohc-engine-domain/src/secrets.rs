//! [`SecretFileStore`]: the secret-backed-file domain over the R04 storage core
//! and the R08 crypto core.
//!
//! Every guarantee the TS `secretFileStore` makes is preserved here, but with a
//! stronger type boundary:
//!
//! - **Ciphertext-only at rest.** A write encrypts plaintext with
//!   [`dohc_engine_crypto`] and stores ONLY the IV, tag, and ciphertext (base64
//!   TEXT) plus the plaintext byte length. No column, journal entry, or blob
//!   ever holds cleartext — proven by the plaintext-never-leaks scan.
//! - **One plaintext accessor.** [`SecretFileStore::materialize_secret_file`] is
//!   the sole method that decrypts, returning a zeroizing
//!   [`SecretPlaintext`](dohc_engine_crypto::SecretPlaintext). Every other method
//!   is metadata-only by type — [`SecretMomentRecord`] has no content field.
//! - **Fail closed.** A tampered ciphertext/tag, wrong key, or AAD mismatch
//!   surfaces as `decrypt-failed`, never garbage plaintext.
//! - **Durable materialization intent.** A write records its R04
//!   materialization row in the SAME transaction as the secret state, so the
//!   disk intent is crash-safe. [`SecretDiskIntent::Materialize`] enqueues a
//!   PENDING job (the secret-aware executor writes the plaintext file);
//!   [`SecretDiskIntent::AlreadyOnDisk`] (capture) records a COMPLETED marker
//!   instead — the plaintext came FROM disk, and the marker lets the
//!   staleness gate supersede older pending jobs. The row references the
//!   CIPHERTEXT blob (integrity anchor); plaintext is produced only at
//!   execution time by `materialize_secret_file` and lives only on disk.
//!
//! R07's platform-independent path floor is enforced at every caller-supplied
//! path entry point. The gate fails closed in BOTH directions: this encrypted
//! store refuses ordinary paths (`not-secret-path`), while the plaintext store
//! refuses secret-classified paths. Replication/apply callers cannot bypass the
//! same store-door rule by choosing a different host platform.
//!
//! **Delete is a tombstone, not a crypto-shred (documented decision).** Deleting
//! a secret removes the `secret_files` tip, but the prior WRITE moment in
//! `secret_moments` RETAINS its `after_ciphertext_base64` + `after_byte_length`.
//! So a deleted secret's ciphertext — and its exact plaintext SIZE — persist in
//! history (never plaintext: ciphertext-only-at-rest still holds). This is the
//! deliberate, TS-matching behavior: the versioned model preserves history, and
//! restore-to-before-a-moment depends on the retained sealed after-state. The
//! residual is that existence + size of a deleted secret remain visible to
//! anyone with DB access — acceptable because they already hold the ciphertext.
//! A future crypto-shred-on-delete (purge the retained after-state) is a
//! possible enhancement for the sync/retention shard; see BEHAVIOR_DELTA.md.

use crate::error::DomainError;
use crate::records::InbandSecret;
use crate::store::validate_path;
use dohc_engine_crypto::{SealedSecret, SecretDataKey, SecretPlaintext, aead, seal};
use dohc_engine_storage::{
    EngineStore, FaultInjector, MaterializationJobSpec, Preimage, StorageError, TxnOutcome,
    enqueue_job, put_binary_blob,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

/// The write origins the store accepts (parity with the TS `WRITE_ORIGINS` set).
const WRITE_ORIGINS: &[&str] = &["api", "local-file", "restore", "sync", "unknown"];

/// A secret write/delete operation kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretOp {
    /// The secret file was written (an after-state ciphertext exists).
    Write,
    /// The secret file was deleted (no after-state).
    Delete,
}

impl SecretOp {
    fn as_str(self) -> &'static str {
        match self {
            SecretOp::Write => "write",
            SecretOp::Delete => "delete",
        }
    }
    fn from_db(raw: &str) -> Result<Self, DomainError> {
        match raw {
            "write" => Ok(SecretOp::Write),
            "delete" => Ok(SecretOp::Delete),
            _ => Err(DomainError::StateCorrupt {
                reason: "secret moment has an unknown operation",
            }),
        }
    }
}

/// Inputs to a secret write. `text` is the cleartext (bounded to 1 MiB UTF-8);
/// it is encrypted before any of it touches storage.
///
/// `Debug` is HAND-WRITTEN to redact `text` — this is the one secret-bearing
/// input type, so a stray `tracing::debug!(?input)`, `format!("{write:?}")`,
/// panic message, or error context must never spill the cleartext (the
/// plaintext-never-leaks-into-logs invariant). `Clone` is deliberately NOT
/// derived: cleartext should live in as few copies as possible, so a caller
/// must consciously reconstruct the request rather than silently duplicate it.
pub struct SecretWrite {
    pub workspace_id: String,
    pub version_id: String,
    pub path: String,
    pub text: String,
    pub moment_id: String,
    pub metadata_origin: String,
    pub metadata_summary: Option<String>,
    pub metadata_correlation_id: Option<String>,
    pub now_ms: i64,
    pub disk_intent: SecretDiskIntent,
}

/// Whether a secret write's plaintext must REACH disk or is ALREADY there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretDiskIntent {
    /// Enqueue a pending materialization job: the secret-aware executor will
    /// decrypt the tip and write the plaintext to the workspace file.
    Materialize,
    /// Capture: the plaintext came FROM the workspace file, so nothing must
    /// ever run — but a COMPLETED job marker is recorded so the
    /// materializer's staleness gate supersedes any OLDER still-pending job
    /// for the path instead of letting it regress the captured bytes.
    AlreadyOnDisk,
}

/// Inputs to [`SecretFileStore::capture_secret`]: the autonomous secret
/// capture-write. The moment id is derived internally via the length-framed
/// capture scheme. `Debug` redacts the plaintext (same invariant as
/// [`SecretWrite`]) and `Clone` is deliberately not derived.
pub struct CaptureSecret {
    pub workspace_id: String,
    pub version_id: String,
    pub path: String,
    pub text: String,
    pub metadata_origin: String,
    pub now_ms: i64,
    /// Whether this write may overwrite a tip written by a DIFFERENT origin
    /// (API, replication). Capture sets it only when it OBSERVED the disk
    /// transition; on first sight it must not silently revert another
    /// writer whose plaintext may never have reached disk. Mirrors
    /// [`crate::CaptureIngest::claim_foreign_head`].
    pub claim_foreign_head: bool,
}

impl core::fmt::Debug for CaptureSecret {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("CaptureSecret")
            .field("workspace_id", &self.workspace_id)
            .field("version_id", &self.version_id)
            .field("path", &self.path)
            .field(
                "text",
                &format_args!("<redacted, {} bytes>", self.text.len()),
            )
            .field("metadata_origin", &self.metadata_origin)
            .field("now_ms", &self.now_ms)
            .finish()
    }
}

/// Inputs to [`capture_secret_retire`]: the autonomous, KEYLESS secret retire
/// (a delete never decrypts, so it works without the workspace key).
#[derive(Debug, Clone)]
pub struct CaptureSecretRetire {
    pub workspace_id: String,
    pub version_id: String,
    pub path: String,
    pub metadata_origin: String,
    pub now_ms: i64,
    /// Retire ONLY a tip whose latest moment carries `metadata_origin` — i.e.
    /// one THIS writer produced. The capture sink sets it so a disk delete
    /// can never destroy an API/replication-written tip whose plaintext may
    /// legitimately have never been on disk. A foreign tip is a no-op.
    pub only_if_own_origin: bool,
}

impl core::fmt::Debug for SecretWrite {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SecretWrite")
            .field("workspace_id", &self.workspace_id)
            .field("version_id", &self.version_id)
            .field("path", &self.path)
            .field(
                "text",
                &format_args!("<redacted, {} bytes>", self.text.len()),
            )
            .field("moment_id", &self.moment_id)
            .field("metadata_origin", &self.metadata_origin)
            .field("metadata_summary", &self.metadata_summary)
            .field("metadata_correlation_id", &self.metadata_correlation_id)
            .field("now_ms", &self.now_ms)
            .finish()
    }
}

/// A secret history moment — METADATA ONLY, by construction. There is no content
/// field: a moment can describe *that* `.env` changed, never *what* it holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretMomentRecord {
    pub moment_order: i64,
    pub moment_id: String,
    pub workspace_id: String,
    pub version_id: String,
    pub path: String,
    pub recorded_at_ms: i64,
    pub operation: SecretOp,
    pub metadata_origin: String,
    pub metadata_summary: Option<String>,
    pub metadata_correlation_id: Option<String>,
}

/// A secret-file tip stat — metadata only (byte length, not content).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretFileStat {
    pub workspace_id: String,
    pub version_id: String,
    pub path: String,
    pub byte_length: i64,
    pub updated_at_ms: i64,
    pub latest_moment_id: String,
}

/// The outcome of a secret write: `changed=false` is a content-equality no-op
/// (no new moment); otherwise the recorded moment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretWriteResult {
    pub changed: bool,
    pub moment: Option<SecretMomentRecord>,
}

/// Inputs to a secret delete.
#[derive(Debug, Clone)]
pub struct SecretDelete {
    pub workspace_id: String,
    pub version_id: String,
    pub path: String,
    pub moment_id: String,
    pub metadata_origin: String,
    pub metadata_summary: Option<String>,
    pub now_ms: i64,
}

/// The secret domain bound to one workspace store + its data key. Cheap to
/// construct per call; holds a mutable borrow of the writer and a shared borrow
/// of the key.
pub struct SecretFileStore<'a> {
    store: &'a mut EngineStore,
    key: &'a SecretDataKey,
}

impl<'a> SecretFileStore<'a> {
    /// Bind the secret domain to a storage writer and the workspace data key.
    pub fn new(store: &'a mut EngineStore, key: &'a SecretDataKey) -> Self {
        SecretFileStore { store, key }
    }

    // --------------------------------------------------------------- writes

    /// Encrypt and write `input.text` to a secret path. Content-equality against
    /// the current tip is a no-op (one moment per real change). On a real change:
    /// inserts a moment, upserts the encrypted tip, persists the ciphertext blob,
    /// enqueues an R04 materialization job, and journals the op — all in ONE
    /// transaction.
    pub fn write_secret_file(
        &mut self,
        input: &SecretWrite,
        faults: &dyn FaultInjector,
    ) -> Result<SecretWriteResult, DomainError> {
        non_empty(&input.workspace_id, "workspace_id")?;
        non_empty(&input.version_id, "version_id")?;
        non_empty(&input.moment_id, "moment_id")?;
        validate_secret_path(&input.path)?;
        validate_text(&input.text)?;
        validate_origin(&input.metadata_origin)?;

        let ws = &input.workspace_id;
        // Pre-transaction reads (single-writer: authoritative). Check the
        // DESIRED STATE FIRST: if the tip already equals `text`, this is an
        // idempotent no-op — including an exactly-once retry of a write that
        // committed but crashed before the ack. Only a genuine content change
        // reaches the duplicate-moment-id guard, so a committed retry is never
        // misreported as `DuplicateMomentId`.
        let no_op = self.store.read_with(|conn| {
            require_version(conn, ws, &input.version_id)?;
            if let Some(tip) = select_tip(conn, ws, &input.version_id, &input.path)? {
                let current = aead::open(self.key, ws, &input.path, &tip)?;
                if current.as_bytes() == input.text.as_bytes() {
                    return Ok(true);
                }
            }
            if secret_moment_exists(conn, ws, &input.moment_id)? {
                return Err(DomainError::DuplicateMomentId);
            }
            Ok::<bool, DomainError>(false)
        })?;
        if no_op {
            return Ok(SecretWriteResult {
                changed: false,
                moment: None,
            });
        }

        let sealed = seal(self.key, ws, &input.path, input.text.as_bytes())?;
        let moment = SecretMomentRecord {
            moment_order: 0, // filled in-txn
            moment_id: input.moment_id.clone(),
            workspace_id: ws.clone(),
            version_id: input.version_id.clone(),
            path: input.path.clone(),
            recorded_at_ms: input.now_ms,
            operation: SecretOp::Write,
            metadata_origin: input.metadata_origin.clone(),
            metadata_summary: input.metadata_summary.clone(),
            metadata_correlation_id: input.metadata_correlation_id.clone(),
        };

        let outcome = self.store.write_with(faults, |tx| {
            let moment_order = next_secret_moment_order(tx, ws)?;
            insert_moment(tx, &moment, moment_order, Some(&sealed))?;
            upsert_tip(tx, &moment, moment_order, &sealed)?;
            // Persist the ciphertext blob (never plaintext), then enqueue the
            // durable materialization intent referencing it. Blob before job so
            // the job's `content_sha256` FK is satisfied inside the txn.
            let ciphertext_sha = put_binary_blob(tx, sealed.ciphertext())?;
            let spec = MaterializationJobSpec {
                job_id: format!("secret-mat_{}", input.moment_id),
                target_path: input.path.clone(),
                content_sha256: ciphertext_sha,
                // The secret-aware executor decrypts the tip and writes
                // plaintext; preimage revalidation is its concern (it knows
                // the plaintext it is about to write), so the durable intent
                // records no on-disk preimage here.
                preimage: Preimage::Absent,
                target_generation: moment_order,
                now_ms: input.now_ms,
            };
            match input.disk_intent {
                SecretDiskIntent::Materialize => enqueue_job(tx, &spec)?,
                SecretDiskIntent::AlreadyOnDisk => {
                    dohc_engine_storage::record_completed_job(tx, &spec)?;
                }
            }
            journal(tx, &input.path, "secret.file.put", input.now_ms)?;
            Ok::<SecretMomentRecord, DomainError>(SecretMomentRecord {
                moment_order,
                ..moment.clone()
            })
        })?;
        let moment = committed(outcome)?;
        Ok(SecretWriteResult {
            changed: true,
            moment: Some(moment),
        })
    }

    /// Delete a secret file: records a delete moment and removes the tip. A
    /// no-op (no moment) when there is no current tip. No key required.
    pub fn delete_secret_file(
        &mut self,
        input: &SecretDelete,
        faults: &dyn FaultInjector,
    ) -> Result<Option<SecretMomentRecord>, DomainError> {
        delete_secret_file_keyless(self.store, input, faults)
    }

    // -------------------------------------------------------------- capture

    /// Autonomous secret capture: derives the moment id via the length-framed
    /// capture scheme (no caller-supplied ids), writes with
    /// [`SecretDiskIntent::AlreadyOnDisk`] (the plaintext came FROM the
    /// workspace file — a completed marker, never a runnable job), and pins
    /// the reserved secret moment order against the persisted one. A deduped
    /// (content-equality) capture still marks the CONFIRMED tip's generation
    /// as materialized so an older stale pending job cannot regress bytes
    /// capture just verified on disk.
    pub fn capture_secret(
        &mut self,
        input: &CaptureSecret,
        faults: &dyn FaultInjector,
    ) -> Result<SecretWriteResult, DomainError> {
        non_empty(&input.workspace_id, "workspace_id")?;
        non_empty(&input.version_id, "version_id")?;
        validate_secret_path(&input.path)?;
        let ws = input.workspace_id.clone();
        // OWNERSHIP: a tip written by another origin (API, replication) may
        // legitimately have no plaintext on disk, so capture only claims it
        // when it OBSERVED the disk transition.
        if !input.claim_foreign_head {
            let version = input.version_id.clone();
            let path = input.path.clone();
            let owner_ws = ws.clone();
            let foreign = self
                .store
                .read_with(move |conn| secret_tip_origin(conn, &owner_ws, &version, &path))?;
            if let Some(origin) = foreign
                && origin != input.metadata_origin
            {
                return Err(DomainError::CaptureNotOwned);
            }
        }
        // Single-writer: this pre-read reservation is authoritative; the
        // post-write pin makes the assumption release-checked.
        let reserved = self
            .store
            .read_with(|conn| next_secret_moment_order(conn, &ws))?;
        let moment_id = derive_capture_secret_moment_id(
            &input.workspace_id,
            &input.version_id,
            &input.path,
            reserved,
        );
        let basename = input
            .path
            .rsplit('/')
            .next()
            .unwrap_or(input.path.as_str())
            .to_owned();
        let result = self.write_secret_file(
            &SecretWrite {
                workspace_id: input.workspace_id.clone(),
                version_id: input.version_id.clone(),
                path: input.path.clone(),
                text: input.text.clone(),
                moment_id,
                metadata_origin: input.metadata_origin.clone(),
                metadata_summary: Some(format!("Updated {basename}")),
                metadata_correlation_id: None,
                now_ms: input.now_ms,
                disk_intent: SecretDiskIntent::AlreadyOnDisk,
            },
            faults,
        )?;
        match &result.moment {
            Some(moment) => {
                if moment.moment_order != reserved {
                    return Err(DomainError::StateCorrupt {
                        reason: "secret capture moment order diverged from reserved order",
                    });
                }
            }
            None => {
                // Deduped: the tip's plaintext is VERIFIED on disk right now.
                //
                // NOTE — ownership is deliberately NOT transferred here, unlike
                // the plaintext path (`capture_ingest_in_tx`). A secret tip's
                // origin lives on its MOMENT, so transferring would mean either
                // rewriting history or appending a moment for a no-op change;
                // both are worse than the consequence of not transferring,
                // which is that a claimed-but-deduped FOREIGN tip stays foreign
                // and a later disk delete will not retire it. That errs toward
                // PRESERVING another writer's secret — the safe direction, and
                // consistent with how an api-written secret with no disk file
                // is already treated. Resolved properly by the dedicated
                // ownership-marker column tracked for GATE6.
                //
                // Mark the tip's generation materialized (upsert) so the
                // staleness gate supersedes any older pending job — the same
                // regression class the binary capture marker closes.
                self.mark_tip_materialized(
                    &input.workspace_id,
                    &input.version_id,
                    &input.path,
                    input.now_ms,
                    faults,
                )?;
            }
        }
        Ok(result)
    }

    /// Mark the current tip's secret materialization as complete (capture
    /// verified the plaintext on disk). A missing tip is a no-op.
    fn mark_tip_materialized(
        &mut self,
        workspace_id: &str,
        version_id: &str,
        path: &str,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<(), DomainError> {
        let ws = workspace_id.to_owned();
        let version = version_id.to_owned();
        let secret_path = path.to_owned();
        let tip = self.store.read_with(move |conn| {
            conn.query_row(
                "SELECT f.latest_moment_id, f.ciphertext_base64, m.moment_order \
                 FROM secret_files f \
                 JOIN secret_moments m ON m.workspace_id = f.workspace_id \
                   AND m.moment_id = f.latest_moment_id \
                 WHERE f.workspace_id = ?1 AND f.version_id = ?2 AND f.path = ?3",
                params![ws, version, secret_path],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(DomainError::sql_corrupt)
        })?;
        let Some((latest_moment_id, ciphertext_base64, moment_order)) = tip else {
            return Ok(());
        };
        let ciphertext = dohc_engine_crypto::base64::forgiving_decode(&ciphertext_base64);
        let ciphertext_sha = dohc_engine_storage::hex_sha256(&ciphertext);
        let target_path = path.to_owned();
        let outcome = self.store.write_with(faults, move |tx| {
            dohc_engine_storage::record_completed_job(
                tx,
                &MaterializationJobSpec {
                    job_id: format!("secret-mat_{latest_moment_id}"),
                    target_path: target_path.clone(),
                    content_sha256: ciphertext_sha.clone(),
                    preimage: Preimage::Absent,
                    target_generation: moment_order,
                    now_ms,
                },
            )
            .map_err(DomainError::from)
        })?;
        committed(outcome)
    }

    // ----------------------------------------------------------- materialize

    /// THE single authorized plaintext accessor. Decrypts the current tip for a
    /// secret path, returning a zeroizing [`SecretPlaintext`], or `None` when no
    /// tip exists. Fails closed (`decrypt-failed`) on tamper/wrong-key/AAD. The
    /// secret-aware materialization pipeline calls this to obtain the bytes it
    /// writes to disk.
    /// Materialize with the in-band cap decided IN this read: an over-cap
    /// tip answers its recorded length WITHOUT decrypting — no window
    /// where the secret can grow between a size probe and the decrypt,
    /// and over-cap plaintext never exists on the heap.
    pub fn materialize_secret_file_inband(
        &self,
        workspace_id: &str,
        version_id: &str,
        path: &str,
        cap: usize,
    ) -> Result<Option<InbandSecret>, DomainError> {
        validate_secret_path(path)?;
        let key = self.key;
        self.store.read_with(|conn| {
            require_version(conn, workspace_id, version_id)?;
            let Some(tip) = select_tip(conn, workspace_id, version_id, path)? else {
                return Ok(None);
            };
            let byte_length = tip.byte_length() as i64;
            if tip.byte_length() > cap {
                // AUTHENTICATE even what we withhold: a wrong key,
                // tampered ciphertext/tag, or AAD-spliced row must fail
                // closed, never read as a valid over-cap secret. The
                // plaintext is decrypted into a zeroizing buffer and
                // dropped immediately — bounded by the 1 MiB domain cap,
                // never converted to an ordinary String.
                let _verified = aead::open(key, workspace_id, path, &tip)?;
                return Ok(Some(InbandSecret {
                    text: None,
                    byte_length,
                }));
            }
            let plaintext = aead::open(key, workspace_id, path, &tip)?;
            let text = plaintext
                .into_utf8()
                .map_err(|_| DomainError::StateCorrupt {
                    reason: "secret plaintext is not utf-8",
                })?;
            Ok(Some(InbandSecret {
                byte_length,
                text: Some(text),
            }))
        })
    }

    pub fn materialize_secret_file(
        &self,
        workspace_id: &str,
        version_id: &str,
        path: &str,
    ) -> Result<Option<SecretPlaintext>, DomainError> {
        validate_secret_path(path)?;
        let key = self.key;
        self.store.read_with(|conn| {
            require_version(conn, workspace_id, version_id)?;
            let Some(tip) = select_tip(conn, workspace_id, version_id, path)? else {
                return Ok(None);
            };
            let plaintext = aead::open(key, workspace_id, path, &tip)?;
            Ok(Some(plaintext))
        })
    }

    // ---------------------------------------------------------------- reads

    /// List secret-file tips in a version (metadata only), ordered by path.
    pub fn list_secret_files(
        &self,
        workspace_id: &str,
        version_id: &str,
    ) -> Result<Vec<SecretFileStat>, DomainError> {
        list_secret_files_keyless(self.store, workspace_id, version_id)
    }

    /// List secret moments, newest first, optionally scoped to a version.
    pub fn list_secret_moments(
        &self,
        workspace_id: &str,
        version_id: Option<&str>,
    ) -> Result<Vec<SecretMomentRecord>, DomainError> {
        self.store.read_with(|conn| {
            let mut sql = String::from(
                "SELECT moment_order, moment_id, workspace_id, version_id, path, recorded_at_ms, \
                 operation, metadata_origin, metadata_summary, metadata_correlation_id \
                 FROM secret_moments WHERE workspace_id = ?1",
            );
            let mut binds: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(workspace_id.to_owned())];
            if let Some(version_id) = version_id {
                require_version(conn, workspace_id, version_id)?;
                sql.push_str(" AND version_id = ?2");
                binds.push(Box::new(version_id.to_owned()));
            }
            sql.push_str(" ORDER BY moment_order DESC");
            let mut stmt = conn.prepare(&sql).map_err(DomainError::sql_corrupt)?;
            let refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
            let rows = stmt
                .query_map(refs.as_slice(), map_moment_row)
                .map_err(DomainError::sql_corrupt)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(DomainError::sql_corrupt)??);
            }
            Ok(out)
        })
    }

    /// Fetch a single secret moment by id (metadata only), or `None`.
    pub fn get_secret_moment(
        &self,
        workspace_id: &str,
        moment_id: &str,
    ) -> Result<Option<SecretMomentRecord>, DomainError> {
        if moment_id.is_empty() {
            return Err(DomainError::InvalidInput {
                reason: "moment_id must not be empty",
            });
        }
        self.store.read_with(|conn| {
            conn.query_row(
                "SELECT moment_order, moment_id, workspace_id, version_id, path, recorded_at_ms, \
                 operation, metadata_origin, metadata_summary, metadata_correlation_id \
                 FROM secret_moments WHERE workspace_id = ?1 AND moment_id = ?2",
                params![workspace_id, moment_id],
                map_moment_row,
            )
            .optional()
            .map_err(DomainError::sql_corrupt)?
            .transpose()
        })
    }

    // ----------------------------------------------------------------- fork

    /// Fork a version's secret files into `to_version_id`: copies every tip
    /// verbatim as ciphertext (no decryption — the AAD is not version-bound) and
    /// seeds `secret_fork_bases` with the same copy. Existing destination secret
    /// rows are cleared first. Journals one `secret.version.fork` op when the
    /// source had any secret files.
    pub fn fork_version(
        &mut self,
        workspace_id: &str,
        from_version_id: &str,
        to_version_id: &str,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<(), DomainError> {
        non_empty(workspace_id, "workspace_id")?;
        if from_version_id == to_version_id {
            return Err(DomainError::InvalidInput {
                reason: "fork source and destination versions must differ",
            });
        }
        let ws = workspace_id.to_owned();
        let from = from_version_id.to_owned();
        let to = to_version_id.to_owned();
        self.store.read_with(|conn| {
            require_version(conn, &ws, &from)?;
            require_version(conn, &ws, &to)
        })?;
        let outcome = self.store.write_with(faults, |tx| {
            tx.execute(
                "DELETE FROM secret_files WHERE workspace_id = ?1 AND version_id = ?2",
                params![ws, to],
            )
            .map_err(DomainError::sql_persist)?;
            tx.execute(
                "DELETE FROM secret_fork_bases WHERE workspace_id = ?1 AND version_id = ?2",
                params![ws, to],
            )
            .map_err(DomainError::sql_persist)?;
            let copied = tx
                .execute(
                    "INSERT INTO secret_files (workspace_id, version_id, path, iv_base64, \
                     auth_tag_base64, ciphertext_base64, byte_length, updated_at_ms, \
                     latest_moment_id) \
                     SELECT workspace_id, ?2, path, iv_base64, auth_tag_base64, ciphertext_base64, \
                     byte_length, updated_at_ms, latest_moment_id FROM secret_files \
                     WHERE workspace_id = ?1 AND version_id = ?3",
                    params![ws, to, from],
                )
                .map_err(DomainError::sql_persist)?;
            tx.execute(
                "INSERT INTO secret_fork_bases (workspace_id, version_id, path, iv_base64, \
                 auth_tag_base64, ciphertext_base64, byte_length) \
                 SELECT workspace_id, ?2, path, iv_base64, auth_tag_base64, ciphertext_base64, \
                 byte_length FROM secret_files WHERE workspace_id = ?1 AND version_id = ?3",
                params![ws, to, from],
            )
            .map_err(DomainError::sql_persist)?;
            // Empty secret forks are a no-op for replicas: skip the journal.
            if copied > 0 {
                journal(tx, &to, "secret.version.fork", now_ms)?;
            }
            Ok::<(), DomainError>(())
        })?;
        committed(outcome)
    }

    // ------------------------------------------------------------- internals
}

// ============================================================================
// Free helpers.
// ============================================================================

/// The keyless secret delete: records a delete moment and removes the tip. A
/// no-op (no moment) when there is no current tip. Free-standing because a
/// delete never decrypts — capture retire must work even when the workspace
/// key is unavailable.
pub fn delete_secret_file_keyless(
    store: &mut EngineStore,
    input: &SecretDelete,
    faults: &dyn FaultInjector,
) -> Result<Option<SecretMomentRecord>, DomainError> {
    delete_secret_file_inner(store, input, faults, false)
}

fn delete_secret_file_inner(
    store: &mut EngineStore,
    input: &SecretDelete,
    faults: &dyn FaultInjector,
    supersede_materialization: bool,
) -> Result<Option<SecretMomentRecord>, DomainError> {
    non_empty(&input.workspace_id, "workspace_id")?;
    non_empty(&input.version_id, "version_id")?;
    non_empty(&input.moment_id, "moment_id")?;
    validate_secret_path(&input.path)?;
    validate_origin(&input.metadata_origin)?;

    let ws = &input.workspace_id;
    // Desired-state first: an already-absent tip is an idempotent no-op
    // (including an exactly-once retry of a delete that committed then
    // crashed before the ack), so a committed retry is never misreported as
    // `DuplicateMomentId`. Only a delete that will actually change state
    // reaches the duplicate-moment-id guard.
    let has_tip = store.read_with(|conn| {
        require_version(conn, ws, &input.version_id)?;
        if select_tip(conn, ws, &input.version_id, &input.path)?.is_none() {
            return Ok(false);
        }
        if secret_moment_exists(conn, ws, &input.moment_id)? {
            return Err(DomainError::DuplicateMomentId);
        }
        Ok::<bool, DomainError>(true)
    })?;
    if !has_tip {
        return Ok(None);
    }

    let record = SecretMomentRecord {
        moment_order: 0,
        moment_id: input.moment_id.clone(),
        workspace_id: ws.clone(),
        version_id: input.version_id.clone(),
        path: input.path.clone(),
        recorded_at_ms: input.now_ms,
        operation: SecretOp::Delete,
        metadata_origin: input.metadata_origin.clone(),
        metadata_summary: input.metadata_summary.clone(),
        metadata_correlation_id: None,
    };
    let outcome = store.write_with(faults, |tx| {
        let moment_order = next_secret_moment_order(tx, ws)?;
        insert_moment(tx, &record, moment_order, None)?;
        if supersede_materialization {
            // Capture retire: the on-disk plaintext is GONE, so record the
            // delete's generation as a completed marker (anchored to the
            // outgoing tip's ciphertext blob — deletes carry no bytes of
            // their own). Without it, an older still-pending secret job for
            // this path could later re-write the retired plaintext to disk.
            let tip_sha: Option<String> = tx
                .query_row(
                    "SELECT ciphertext_base64 FROM secret_files                      WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
                    params![ws, input.version_id, input.path],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(DomainError::sql_corrupt)?
                .map(|ciphertext_base64| {
                    dohc_engine_storage::hex_sha256(&dohc_engine_crypto::base64::forgiving_decode(
                        &ciphertext_base64,
                    ))
                });
            if let Some(content_sha256) = tip_sha {
                dohc_engine_storage::record_completed_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: format!("secret-mat_{}", input.moment_id),
                        target_path: input.path.clone(),
                        content_sha256,
                        preimage: Preimage::Absent,
                        target_generation: moment_order,
                        now_ms: input.now_ms,
                    },
                )?;
            }
        }
        tx.execute(
            "DELETE FROM secret_files WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
            params![ws, input.version_id, input.path],
        )
        .map_err(DomainError::sql_persist)?;
        journal(tx, &input.path, "secret.file.delete", input.now_ms)?;
        Ok::<SecretMomentRecord, DomainError>(SecretMomentRecord {
            moment_order,
            ..record.clone()
        })
    })?;
    Ok(Some(committed(outcome)?))
}

/// Autonomous, KEYLESS secret retire: derives the delete moment id via the
/// length-framed capture scheme (no caller-supplied ids) and removes the tip.
/// An absent tip is an idempotent no-op. The reserved secret moment order is
/// pinned against the one the delete actually persisted (release-safe).
pub fn capture_secret_retire(
    store: &mut EngineStore,
    input: &CaptureSecretRetire,
    faults: &dyn FaultInjector,
) -> Result<Option<SecretMomentRecord>, DomainError> {
    non_empty(&input.workspace_id, "workspace_id")?;
    non_empty(&input.version_id, "version_id")?;
    validate_secret_path(&input.path)?;
    let ws = input.workspace_id.clone();
    // OWNERSHIP: a disk-driven retire must never destroy a tip written by
    // another origin (API, replication) — its plaintext may never have been
    // on disk at all, so absence proves nothing about it.
    if input.only_if_own_origin {
        let version = input.version_id.clone();
        let path = input.path.clone();
        let owner_ws = ws.clone();
        let origin =
            store.read_with(move |conn| secret_tip_origin(conn, &owner_ws, &version, &path))?;
        if let Some(origin) = origin
            && origin != input.metadata_origin
        {
            return Ok(None);
        }
    }
    // Single-writer: the pre-read reservation is authoritative; the post-write
    // pin makes the assumption release-checked.
    let reserved = store.read_with(|conn| next_secret_moment_order(conn, &ws))?;
    let moment_id = derive_capture_secret_retire_moment_id(
        &input.workspace_id,
        &input.version_id,
        &input.path,
        reserved,
    );
    let basename = input
        .path
        .rsplit('/')
        .next()
        .unwrap_or(input.path.as_str())
        .to_owned();
    let result = delete_secret_file_inner(
        store,
        &SecretDelete {
            workspace_id: input.workspace_id.clone(),
            version_id: input.version_id.clone(),
            path: input.path.clone(),
            moment_id,
            metadata_origin: input.metadata_origin.clone(),
            metadata_summary: Some(format!("Deleted {basename}")),
            now_ms: input.now_ms,
        },
        faults,
        true,
    )?;
    if let Some(moment) = &result
        && moment.moment_order != reserved
    {
        return Err(DomainError::StateCorrupt {
            reason: "secret capture moment order diverged from reserved order",
        });
    }
    Ok(result)
}

/// Derive an autonomous secret capture WRITE moment id: length-framed over
/// (workspace, version, path, reserved secret order), same scheme family as
/// the plaintext capture ids but tagged so the two can never collide.
pub fn derive_capture_secret_moment_id(
    workspace_id: &str,
    version_id: &str,
    path: &str,
    next_secret_moment_order: i64,
) -> String {
    let order = next_secret_moment_order.to_string();
    format!(
        "moment-{}",
        crate::store::hash_framed_fields(&[
            b"capture-secret-write",
            workspace_id.as_bytes(),
            version_id.as_bytes(),
            path.as_bytes(),
            order.as_bytes(),
        ])
    )
}

/// Derive an autonomous secret capture RETIRE moment id (distinct tag from
/// the write derivation).
pub fn derive_capture_secret_retire_moment_id(
    workspace_id: &str,
    version_id: &str,
    path: &str,
    next_secret_moment_order: i64,
) -> String {
    let order = next_secret_moment_order.to_string();
    format!(
        "moment-{}",
        crate::store::hash_framed_fields(&[
            b"capture-secret-retire",
            workspace_id.as_bytes(),
            version_id.as_bytes(),
            path.as_bytes(),
            order.as_bytes(),
        ])
    )
}

/// Whether the workspace holds ANY encrypted secret state (moments or tips).
/// The capture layer consults this before ever MINTING a key: a missing key
/// file over live secret rows (a backup restored without the key, an
/// accidental deletion) must fail closed, not silently strand the history
/// under a fresh key.
pub fn has_secret_state(store: &mut EngineStore, workspace_id: &str) -> Result<bool, DomainError> {
    let ws = workspace_id.to_owned();
    store.read_with(move |conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM secret_moments WHERE workspace_id = ?1)              OR EXISTS(SELECT 1 FROM secret_files WHERE workspace_id = ?1)",
            [ws.as_str()],
            |row| row.get::<_, bool>(0),
        )
        .map_err(DomainError::sql_corrupt)
    })
}

/// The `metadata_origin` of the current secret tip, or `None` when no tip
/// exists. ONE definition shared by the capture write and retire ownership
/// checks — a schema change to the join must not need two edits.
fn secret_tip_origin(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<String>, DomainError> {
    conn.query_row(
        "SELECT m.metadata_origin FROM secret_files f          JOIN secret_moments m ON m.workspace_id = f.workspace_id            AND m.moment_id = f.latest_moment_id          WHERE f.workspace_id = ?1 AND f.version_id = ?2 AND f.path = ?3",
        params![workspace_id, version_id, path],
        |row| row.get(0),
    )
    .optional()
    .map_err(DomainError::sql_corrupt)
}

/// Read the encrypted tip for a secret path. Free-standing (no key borrow) so
/// keyless flows — deletes, capture retires — can share it.
fn select_tip(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<SealedSecret>, DomainError> {
    let row = conn
        .query_row(
            "SELECT iv_base64, auth_tag_base64, ciphertext_base64, byte_length \
             FROM secret_files WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
            params![workspace_id, version_id, path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    match row {
        None => Ok(None),
        Some((iv, tag, ct, len)) => {
            let byte_length = usize::try_from(len).map_err(|_| DomainError::StateCorrupt {
                reason: "secret tip has a negative byte length",
            })?;
            let sealed = SealedSecret::from_base64(&iv, &tag, &ct, byte_length)?;
            Ok(Some(sealed))
        }
    }
}

fn committed<T>(outcome: TxnOutcome<T>) -> Result<T, DomainError> {
    match outcome {
        TxnOutcome::Committed(value) => Ok(value),
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

/// Fail-closed secret-store routing gate, mirroring TS `normalizeSecretPath`.
/// Structural validation runs first; a safe path that is not classified
/// secret gets the dedicated compatibility error rather than being hidden in
/// encrypted storage where normal history/search would no longer see it.
fn validate_secret_path(path: &str) -> Result<(), DomainError> {
    validate_path(path)?;
    if dohc_engine_files::policy::classify_engine_file_path(path)
        != dohc_engine_files::policy::PathClassification::Secret
    {
        return Err(DomainError::NotSecretPath);
    }
    Ok(())
}

fn validate_text(text: &str) -> Result<(), DomainError> {
    if text.len() > aead::MAX_SECRET_FILE_BYTES {
        return Err(DomainError::InvalidText {
            reason: "protected contents exceed the secret file size limit",
        });
    }
    Ok(())
}

fn validate_origin(origin: &str) -> Result<(), DomainError> {
    if WRITE_ORIGINS.contains(&origin) {
        Ok(())
    } else {
        Err(DomainError::InvalidInput {
            reason: "write metadata origin is invalid",
        })
    }
}

fn require_version(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<(), DomainError> {
    if version_id.is_empty() {
        return Err(DomainError::InvalidInput {
            reason: "version_id must not be empty",
        });
    }
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM versions WHERE workspace_id = ?1 AND version_id = ?2",
            params![workspace_id, version_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if found.is_some() {
        Ok(())
    } else {
        Err(DomainError::VersionNotFound)
    }
}

fn secret_moment_exists(
    conn: &Connection,
    workspace_id: &str,
    moment_id: &str,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM secret_moments WHERE workspace_id = ?1 AND moment_id = ?2",
            params![workspace_id, moment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

fn next_secret_moment_order(conn: &Connection, workspace_id: &str) -> Result<i64, DomainError> {
    let max: Option<i64> = conn
        .query_row(
            "SELECT MAX(moment_order) FROM secret_moments WHERE workspace_id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    Ok(max.map_or(0, |m| m + 1))
}

/// Insert a secret moment. `after` carries the sealed after-state for a write
/// (base64 fields), or `None` for a delete.
fn insert_moment(
    tx: &Transaction<'_>,
    moment: &SecretMomentRecord,
    moment_order: i64,
    after: Option<&SealedSecret>,
) -> Result<(), DomainError> {
    let (present, iv, tag, ct, len) = match after {
        Some(s) => (
            1i64,
            Some(s.iv_base64()),
            Some(s.auth_tag_base64()),
            Some(s.ciphertext_base64()),
            Some(s.byte_length() as i64),
        ),
        None => (0, None, None, None, None),
    };
    tx.execute(
        "INSERT INTO secret_moments (workspace_id, moment_order, moment_id, version_id, path, \
         recorded_at_ms, operation, metadata_origin, metadata_summary, metadata_correlation_id, \
         after_present, after_iv_base64, after_auth_tag_base64, after_ciphertext_base64, \
         after_byte_length) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            moment.workspace_id,
            moment_order,
            moment.moment_id,
            moment.version_id,
            moment.path,
            moment.recorded_at_ms,
            moment.operation.as_str(),
            moment.metadata_origin,
            moment.metadata_summary,
            moment.metadata_correlation_id,
            present,
            iv,
            tag,
            ct,
            len,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn upsert_tip(
    tx: &Transaction<'_>,
    moment: &SecretMomentRecord,
    _moment_order: i64,
    sealed: &SealedSecret,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT INTO secret_files (workspace_id, version_id, path, iv_base64, auth_tag_base64, \
         ciphertext_base64, byte_length, updated_at_ms, latest_moment_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
         ON CONFLICT(workspace_id, version_id, path) DO UPDATE SET \
           iv_base64 = excluded.iv_base64, auth_tag_base64 = excluded.auth_tag_base64, \
           ciphertext_base64 = excluded.ciphertext_base64, byte_length = excluded.byte_length, \
           updated_at_ms = excluded.updated_at_ms, latest_moment_id = excluded.latest_moment_id",
        params![
            moment.workspace_id,
            moment.version_id,
            moment.path,
            sealed.iv_base64(),
            sealed.auth_tag_base64(),
            sealed.ciphertext_base64(),
            sealed.byte_length() as i64,
            moment.recorded_at_ms,
            moment.moment_id,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

/// Append the compound-commit journal entry (op kind + path, never content).
fn journal(
    tx: &Transaction<'_>,
    doc_id: &str,
    op_kind: &str,
    now_ms: i64,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT INTO replication_journal (doc_id, op_kind, created_at_ms) VALUES (?1, ?2, ?3)",
        params![doc_id, op_kind, now_ms],
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

fn map_moment_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<SecretMomentRecord, DomainError>> {
    let moment_order: i64 = row.get(0)?;
    let moment_id: String = row.get(1)?;
    let workspace_id: String = row.get(2)?;
    let version_id: String = row.get(3)?;
    let path: String = row.get(4)?;
    let recorded_at_ms: i64 = row.get(5)?;
    let op_str: String = row.get(6)?;
    let metadata_origin: String = row.get(7)?;
    let metadata_summary: Option<String> = row.get(8)?;
    let metadata_correlation_id: Option<String> = row.get(9)?;
    Ok(
        SecretOp::from_db(&op_str).map(|operation| SecretMomentRecord {
            moment_order,
            moment_id,
            workspace_id,
            version_id,
            path,
            recorded_at_ms,
            operation,
            metadata_origin,
            metadata_summary,
            metadata_correlation_id,
        }),
    )
}
/// Keyless tip listing: the metadata never touches the AEAD, so a caller
/// without the data key (the RPC surface of a workspace that has never
/// minted one) can still enumerate. ONE query definition — the keyed store
/// method delegates here.
/// One secret tip's RECORDED byte length — keyless, no ciphertext read, no
/// decrypt. The RPC's in-band cap check runs on this so an over-cap secret
/// is never decrypted into a heap String just to be discarded.
pub fn secret_file_len_keyless(
    store: &EngineStore,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<i64>, DomainError> {
    validate_secret_path(path)?;
    store.read_with(|conn| {
        require_version(conn, workspace_id, version_id)?;
        conn.query_row(
            "SELECT byte_length FROM secret_files \
             WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
            rusqlite::params![workspace_id, version_id, path],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)
    })
}

/// One PAGE of secret-file tips (metadata only), ordered by path, keyset
/// after `after_path` — the listing RPC pages here so a many-secret
/// workspace never loads every tip per request.
pub fn list_secret_files_keyless_page(
    store: &EngineStore,
    workspace_id: &str,
    version_id: &str,
    after_path: Option<&str>,
    limit: usize,
) -> Result<Vec<SecretFileStat>, DomainError> {
    store.read_with(|conn| {
        require_version(conn, workspace_id, version_id)?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT workspace_id, version_id, path, byte_length, updated_at_ms, \
                 latest_moment_id FROM secret_files \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND path > ?3 \
                 ORDER BY path LIMIT ?4",
            )
            .map_err(DomainError::sql_corrupt)?;
        let rows = stmt
            .query_map(
                params![
                    workspace_id,
                    version_id,
                    after_path.unwrap_or(""),
                    limit as i64
                ],
                |row| {
                    Ok(SecretFileStat {
                        workspace_id: row.get(0)?,
                        version_id: row.get(1)?,
                        path: row.get(2)?,
                        byte_length: row.get(3)?,
                        updated_at_ms: row.get(4)?,
                        latest_moment_id: row.get(5)?,
                    })
                },
            )
            .map_err(DomainError::sql_corrupt)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(DomainError::sql_corrupt)?);
        }
        Ok(out)
    })
}

pub fn list_secret_files_keyless(
    store: &EngineStore,
    workspace_id: &str,
    version_id: &str,
) -> Result<Vec<SecretFileStat>, DomainError> {
    store.read_with(|conn| {
        require_version(conn, workspace_id, version_id)?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT workspace_id, version_id, path, byte_length, updated_at_ms, \
                 latest_moment_id FROM secret_files \
                 WHERE workspace_id = ?1 AND version_id = ?2 ORDER BY path",
            )
            .map_err(DomainError::sql_corrupt)?;
        let rows = stmt
            .query_map(params![workspace_id, version_id], |row| {
                Ok(SecretFileStat {
                    workspace_id: row.get(0)?,
                    version_id: row.get(1)?,
                    path: row.get(2)?,
                    byte_length: row.get(3)?,
                    updated_at_ms: row.get(4)?,
                    latest_moment_id: row.get(5)?,
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
