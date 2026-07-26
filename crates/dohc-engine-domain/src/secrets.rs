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
use crate::merge::VersionFileChangeStatus;
use crate::records::{ApplySecretFileFromVersion, InbandSecret};
use crate::store::validate_path;
use dohc_engine_crypto::{SealedSecret, SecretDataKey, SecretPlaintext, aead, seal};
use dohc_engine_storage::{
    EngineStore, FaultInjector, MaterializationJobSpec, Preimage, StorageError, TxnOutcome,
    enqueue_delete_job, enqueue_job, put_binary_blob,
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
    pub fn as_str(self) -> &'static str {
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
    /// Retire ONLY a tip the engine recorded as being on disk. The capture
    /// sink sets it so a disk delete can never destroy a tip whose plaintext
    /// legitimately never reached the workspace file — a replicated secret,
    /// or one written to a non-active version. A tip capture does not own is
    /// a no-op. Ownership rides the engine-stamped marker, NOT the origin
    /// this call passes.
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

/// Metadata-only whole-version secret comparison entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretCompareEntry {
    pub path: String,
    pub status: VersionFileChangeStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretComparePage {
    pub entries: Vec<SecretCompareEntry>,
    pub next_after_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretMomentPage {
    pub moments: Vec<SecretMomentRecord>,
    pub next_before_moment_order: Option<i64>,
}

/// The outcome of a secret write: `changed=false` is a content-equality no-op
/// (no new moment); otherwise the recorded moment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretWriteResult {
    pub changed: bool,
    pub moment: Option<SecretMomentRecord>,
}

/// Outcome of restoring a secret to the state before a protected moment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretRestoreResult {
    pub restored: &'static str,
    pub restored_moment_id: String,
    pub path: String,
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
    pub metadata_correlation_id: Option<String>,
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
        let path = validate_secret_path(&input.path)?;
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
            if let Some(tip) = select_tip(conn, ws, &input.version_id, &path)? {
                let current = aead::open(self.key, ws, &path, &tip)?;
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

        let sealed = seal(self.key, ws, &path, input.text.as_bytes())?;
        let moment = SecretMomentRecord {
            moment_order: 0, // filled in-txn
            moment_id: input.moment_id.clone(),
            workspace_id: ws.clone(),
            version_id: input.version_id.clone(),
            path: path.clone(),
            recorded_at_ms: input.now_ms,
            operation: SecretOp::Write,
            metadata_origin: input.metadata_origin.clone(),
            metadata_summary: input.metadata_summary.clone(),
            metadata_correlation_id: input.metadata_correlation_id.clone(),
        };

        let outcome = self.store.write_with(faults, |tx| {
            let moment_order = next_secret_moment_order(tx, ws)?;
            insert_moment(
                tx,
                &moment,
                moment_order,
                Some(&sealed),
                matches!(input.disk_intent, SecretDiskIntent::AlreadyOnDisk),
            )?;
            upsert_tip(tx, &moment, moment_order, &sealed)?;
            // Persist the ciphertext blob (never plaintext), then enqueue the
            // durable materialization intent referencing it. Blob before job so
            // the job's `content_sha256` FK is satisfied inside the txn.
            let ciphertext_sha = put_binary_blob(tx, sealed.ciphertext())?;
            let spec = MaterializationJobSpec {
                job_id: format!("secret-mat_{}", input.moment_id),
                target_path: path.clone(),
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
            journal(tx, &path, "secret.file.put", input.now_ms)?;
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
        let path = validate_secret_path(&input.path)?;
        let ws = input.workspace_id.clone();
        // OWNERSHIP: a tip written any other way (API, replication) may
        // legitimately have no plaintext on disk, so capture only claims it
        // when it OBSERVED the disk transition.
        if !input.claim_foreign_head {
            let version = input.version_id.clone();
            let path = path.clone();
            let owner_ws = ws.clone();
            let owned = self.store.read_with(move |conn| {
                secret_tip_capture_owned(conn, &owner_ws, &version, &path)
            })?;
            if owned == Some(false) {
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
            &path,
            reserved,
        );
        let basename = path.rsplit('/').next().unwrap_or(path.as_str()).to_owned();
        let result = self.write_secret_file(
            &SecretWrite {
                workspace_id: input.workspace_id.clone(),
                version_id: input.version_id.clone(),
                path: path.clone(),
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
                // Deduped: the tip's plaintext is VERIFIED on disk right now,
                // so recording the completed job also stamps disk ownership on
                // the tip — a later disk delete can retire it. Ownership rides
                // an engine-stamped column rather than the moment's origin, so
                // this needs no history rewrite and no no-op moment.
                //
                // Mark the tip's generation materialized (upsert) so the
                // staleness gate supersedes any older pending job — the same
                // regression class the binary capture marker closes.
                self.mark_tip_materialized(
                    &input.workspace_id,
                    &input.version_id,
                    &path,
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
        let owner_ws = workspace_id.to_owned();
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
            )?;
            dohc_engine_storage::stamp_secret_capture_owned(tx, &owner_ws, &latest_moment_id)
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
        let path = validate_secret_path(path)?;
        let key = self.key;
        self.store.read_with(|conn| {
            require_version(conn, workspace_id, version_id)?;
            let Some(tip) = select_tip(conn, workspace_id, version_id, &path)? else {
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
                let _verified = aead::open(key, workspace_id, &path, &tip)?;
                return Ok(Some(InbandSecret {
                    text: None,
                    byte_length,
                }));
            }
            let plaintext = aead::open(key, workspace_id, &path, &tip)?;
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
        let path = validate_secret_path(path)?;
        let key = self.key;
        self.store.read_with(|conn| {
            require_version(conn, workspace_id, version_id)?;
            let Some(tip) = select_tip(conn, workspace_id, version_id, &path)? else {
                return Ok(None);
            };
            let plaintext = aead::open(key, workspace_id, &path, &tip)?;
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
        path: Option<&str>,
    ) -> Result<Vec<SecretMomentRecord>, DomainError> {
        list_secret_moments_keyless(self.store, workspace_id, version_id, path)
    }

    /// Fetch a single secret moment by id (metadata only), or `None`.
    pub fn get_secret_moment(
        &self,
        workspace_id: &str,
        moment_id: &str,
    ) -> Result<Option<SecretMomentRecord>, DomainError> {
        get_secret_moment_keyless(self.store, workspace_id, moment_id)
    }

    /// Compare secret tips across two versions. Ciphertext-equal rows skip the
    /// key entirely; ciphertext-different rows decrypt only inside the domain
    /// to distinguish re-encryption from a real plaintext modification.
    pub fn compare_secret_files_page(
        &self,
        workspace_id: &str,
        source_version_id: &str,
        target_version_id: &str,
        after_path: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SecretCompareEntry>, DomainError> {
        Ok(compare_secret_files_page_keyless(
            self.store,
            Some(self.key),
            workspace_id,
            source_version_id,
            target_version_id,
            after_path,
            limit,
        )?
        .entries)
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
        let outcome = self
            .store
            .write_with(faults, |tx| fork_version_in_tx(tx, &ws, &from, &to, now_ms))?;
        committed(outcome)
    }

    // ------------------------------------------------------------- internals
}

/// Copy a version's secret tips and fork bases inside a caller-owned
/// transaction. Used by named-version creation so plaintext and secret heads
/// cannot be forked in separate commits.
pub(crate) fn fork_version_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    from_version_id: &str,
    to_version_id: &str,
    now_ms: i64,
) -> Result<(), DomainError> {
    tx.execute(
        "DELETE FROM secret_files WHERE workspace_id = ?1 AND version_id = ?2",
        params![workspace_id, to_version_id],
    )
    .map_err(DomainError::sql_persist)?;
    tx.execute(
        "DELETE FROM secret_fork_bases WHERE workspace_id = ?1 AND version_id = ?2",
        params![workspace_id, to_version_id],
    )
    .map_err(DomainError::sql_persist)?;
    let copied = tx
        .execute(
            "INSERT INTO secret_files (workspace_id, version_id, path, iv_base64, \
             auth_tag_base64, ciphertext_base64, byte_length, updated_at_ms, latest_moment_id) \
             SELECT workspace_id, ?2, path, iv_base64, auth_tag_base64, ciphertext_base64, \
             byte_length, updated_at_ms, latest_moment_id FROM secret_files \
             WHERE workspace_id = ?1 AND version_id = ?3",
            params![workspace_id, to_version_id, from_version_id],
        )
        .map_err(DomainError::sql_persist)?;
    tx.execute(
        "INSERT INTO secret_fork_bases (workspace_id, version_id, path, iv_base64, \
         auth_tag_base64, ciphertext_base64, byte_length) \
         SELECT workspace_id, ?2, path, iv_base64, auth_tag_base64, ciphertext_base64, \
         byte_length FROM secret_files WHERE workspace_id = ?1 AND version_id = ?3",
        params![workspace_id, to_version_id, from_version_id],
    )
    .map_err(DomainError::sql_persist)?;
    if copied > 0 {
        journal(tx, to_version_id, "secret.version.fork", now_ms)?;
    }
    Ok(())
}

/// Keyless standalone secret fork. Ciphertext is copied verbatim and both
/// version references are validated before entering the write transaction.
pub fn fork_version_keyless(
    store: &mut EngineStore,
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
    store.read_with(|conn| {
        require_version(conn, workspace_id, from_version_id)?;
        require_version(conn, workspace_id, to_version_id)
    })?;
    let outcome = store.write_with(faults, |tx| {
        fork_version_in_tx(tx, workspace_id, from_version_id, to_version_id, now_ms)
    })?;
    committed(outcome)
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
    delete_secret_file_inner(store, input, SecretDeleteDiskIntent::Materialize, faults)
}

/// Keyless secret-moment listing, newest first, optionally scoped to a
/// version and path. A path filter always passes the secret-floor gate.
pub fn list_secret_moments_keyless(
    store: &EngineStore,
    workspace_id: &str,
    version_id: Option<&str>,
    path: Option<&str>,
) -> Result<Vec<SecretMomentRecord>, DomainError> {
    let path = path.map(validate_secret_path).transpose()?;
    store.read_with(|conn| {
        let mut sql = String::from(
            "SELECT moment_order, moment_id, workspace_id, version_id, path, recorded_at_ms, \
             operation, metadata_origin, metadata_summary, metadata_correlation_id \
             FROM secret_moments WHERE workspace_id = ?1",
        );
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(workspace_id.to_owned())];
        if let Some(version_id) = version_id {
            require_version(conn, workspace_id, version_id)?;
            sql.push_str(&format!(" AND version_id = ?{}", binds.len() + 1));
            binds.push(Box::new(version_id.to_owned()));
        }
        if let Some(path) = path.as_deref() {
            sql.push_str(&format!(" AND path = ?{}", binds.len() + 1));
            binds.push(Box::new(path.to_owned()));
        }
        sql.push_str(" ORDER BY moment_order DESC");
        let mut stmt = conn.prepare(&sql).map_err(DomainError::sql_corrupt)?;
        let refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|bind| bind.as_ref()).collect();
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

/// Keyset-paged secret-moment listing, newest first. The cursor is an
/// exclusive upper bound on workspace-global `moment_order`.
pub fn list_secret_moments_page_keyless(
    store: &EngineStore,
    workspace_id: &str,
    version_id: Option<&str>,
    path: Option<&str>,
    before_moment_order: Option<i64>,
    limit: usize,
) -> Result<SecretMomentPage, DomainError> {
    let path = path.map(validate_secret_path).transpose()?;
    if limit == 0 {
        return Err(DomainError::InvalidInput {
            reason: "secret moment page limit must be positive",
        });
    }
    store.read_with(|conn| {
        let mut sql = String::from(
            "SELECT moment_order, moment_id, workspace_id, version_id, path, recorded_at_ms, \
             operation, metadata_origin, metadata_summary, metadata_correlation_id \
             FROM secret_moments WHERE workspace_id = ?1",
        );
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(workspace_id.to_owned())];
        if let Some(version_id) = version_id {
            require_version(conn, workspace_id, version_id)?;
            sql.push_str(&format!(" AND version_id = ?{}", binds.len() + 1));
            binds.push(Box::new(version_id.to_owned()));
        }
        if let Some(path) = path.as_deref() {
            sql.push_str(&format!(" AND path = ?{}", binds.len() + 1));
            binds.push(Box::new(path.to_owned()));
        }
        if let Some(before) = before_moment_order {
            if before < 0 {
                return Err(DomainError::InvalidInput {
                    reason: "before_moment_order must be nonnegative",
                });
            }
            sql.push_str(&format!(" AND moment_order < ?{}", binds.len() + 1));
            binds.push(Box::new(before));
        }
        sql.push_str(&format!(
            " ORDER BY moment_order DESC LIMIT ?{}",
            binds.len() + 1
        ));
        let probe =
            i64::try_from(limit.saturating_add(1)).map_err(|_| DomainError::InvalidInput {
                reason: "secret moment page limit is too large",
            })?;
        binds.push(Box::new(probe));
        let mut stmt = conn.prepare(&sql).map_err(DomainError::sql_corrupt)?;
        let refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|bind| bind.as_ref()).collect();
        let rows = stmt
            .query_map(refs.as_slice(), map_moment_row)
            .map_err(DomainError::sql_corrupt)?;
        let mut moments = Vec::new();
        for row in rows {
            moments.push(row.map_err(DomainError::sql_corrupt)??);
        }
        let has_more = moments.len() > limit;
        moments.truncate(limit);
        let next_before_moment_order = has_more
            .then(|| moments.last().map(|moment| moment.moment_order))
            .flatten();
        Ok(SecretMomentPage {
            moments,
            next_before_moment_order,
        })
    })
}

/// Fetch a secret moment without requiring the data key.
pub fn get_secret_moment_keyless(
    store: &EngineStore,
    workspace_id: &str,
    moment_id: &str,
) -> Result<Option<SecretMomentRecord>, DomainError> {
    if moment_id.is_empty() {
        return Err(DomainError::InvalidInput {
            reason: "moment_id must not be empty",
        });
    }
    store.read_with(|conn| {
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

/// Whole-version secret comparison that can run keyless when no encrypted
/// state exists. A key is only consulted for ciphertext-different rows.
pub fn compare_secret_files_page_keyless(
    store: &EngineStore,
    key: Option<&SecretDataKey>,
    workspace_id: &str,
    source_version_id: &str,
    target_version_id: &str,
    after_path: Option<&str>,
    limit: usize,
) -> Result<SecretComparePage, DomainError> {
    if limit == 0 {
        return Err(DomainError::InvalidInput {
            reason: "limit must be positive",
        });
    }
    store.read_with(|conn| {
        require_version(conn, workspace_id, source_version_id)?;
        require_version(conn, workspace_id, target_version_id)?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT t.path, t.iv_base64, t.auth_tag_base64, t.ciphertext_base64, t.byte_length, \
                        s.path, s.iv_base64, s.auth_tag_base64, s.ciphertext_base64, s.byte_length \
                 FROM (SELECT path, iv_base64, auth_tag_base64, ciphertext_base64, byte_length \
                       FROM secret_files WHERE workspace_id = ?1 AND version_id = ?2) AS t \
                 FULL OUTER JOIN \
                      (SELECT path, iv_base64, auth_tag_base64, ciphertext_base64, byte_length \
                       FROM secret_files WHERE workspace_id = ?1 AND version_id = ?3) AS s \
                   ON t.path = s.path \
                 WHERE COALESCE(t.path, s.path) > ?4 \
                 ORDER BY COALESCE(t.path, s.path) LIMIT ?5",
            )
            .map_err(DomainError::sql_corrupt)?;
        let rows = stmt
            .query_map(
                params![
                    workspace_id,
                    target_version_id,
                    source_version_id,
                    after_path.unwrap_or(""),
                    limit as i64
                ],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<i64>>(9)?,
                    ))
                },
            )
            .map_err(DomainError::sql_corrupt)?;
        let mut entries = Vec::new();
        let mut rows_fetched = 0usize;
        let mut last_scanned_path = None;
        for row in rows {
            let (t_path, t_iv, t_tag, t_ct, t_len, s_path, s_iv, s_tag, s_ct, s_len) =
                row.map_err(DomainError::sql_corrupt)?;
            let path = t_path.as_ref().or(s_path.as_ref()).ok_or(DomainError::StateCorrupt {
                reason: "secret comparison row has no path",
            })?;
            rows_fetched += 1;
            last_scanned_path = Some(path.clone());
            match (&t_path, &s_path) {
                (None, Some(_)) => entries.push(SecretCompareEntry {
                    path: path.clone(),
                    status: VersionFileChangeStatus::Added,
                }),
                (Some(_), None) => entries.push(SecretCompareEntry {
                    path: path.clone(),
                    status: VersionFileChangeStatus::Deleted,
                }),
                (Some(_), Some(_)) => {
                    if t_iv == s_iv && t_tag == s_tag && t_ct == s_ct {
                        continue;
                    }
                    let key = key.ok_or(DomainError::StateCorrupt {
                        reason: "secret comparison needs a missing data key",
                    })?;
                    let target = SealedSecret::from_base64(
                        t_iv.as_deref().ok_or(DomainError::StateCorrupt { reason: "secret tip is incomplete" })?,
                        t_tag.as_deref().ok_or(DomainError::StateCorrupt { reason: "secret tip is incomplete" })?,
                        t_ct.as_deref().ok_or(DomainError::StateCorrupt { reason: "secret tip is incomplete" })?,
                        usize::try_from(t_len.ok_or(DomainError::StateCorrupt { reason: "secret tip is incomplete" })?)
                            .map_err(|_| DomainError::StateCorrupt { reason: "secret tip has a negative byte length" })?,
                    )?;
                    let source = SealedSecret::from_base64(
                        s_iv.as_deref().ok_or(DomainError::StateCorrupt { reason: "secret tip is incomplete" })?,
                        s_tag.as_deref().ok_or(DomainError::StateCorrupt { reason: "secret tip is incomplete" })?,
                        s_ct.as_deref().ok_or(DomainError::StateCorrupt { reason: "secret tip is incomplete" })?,
                        usize::try_from(s_len.ok_or(DomainError::StateCorrupt { reason: "secret tip is incomplete" })?)
                            .map_err(|_| DomainError::StateCorrupt { reason: "secret tip has a negative byte length" })?,
                    )?;
                    if aead::open(key, workspace_id, path, &target)?.as_bytes()
                        != aead::open(key, workspace_id, path, &source)?.as_bytes()
                    {
                        entries.push(SecretCompareEntry {
                            path: path.clone(),
                            status: VersionFileChangeStatus::Modified,
                        });
                    }
                }
                (None, None) => unreachable!(),
            }
        }
        Ok(SecretComparePage {
            entries,
            next_after_path: (rows_fetched == limit).then_some(last_scanned_path).flatten(),
        })
    })
}

/// Three-way-apply one source-version secret state to the destination. The key
/// is used only for equality/base comparisons; writes copy sealed fields.
pub fn apply_secret_file_from_version(
    store: &mut EngineStore,
    key: &SecretDataKey,
    input: &ApplySecretFileFromVersion,
    faults: &dyn FaultInjector,
) -> Result<SecretWriteResult, DomainError> {
    let ApplySecretFileFromVersion {
        workspace_id,
        path,
        from_version_id,
        to_version_id,
        moment_id,
        metadata_origin,
        metadata_summary,
        metadata_correlation_id,
        now_ms,
    } = input;
    let now_ms = *now_ms;
    non_empty(workspace_id, "workspace_id")?;
    non_empty(from_version_id, "version_id")?;
    non_empty(to_version_id, "version_id")?;
    non_empty(moment_id, "moment_id")?;
    validate_origin(metadata_origin)?;
    let path = validate_secret_path(path)?;
    let outcome = store.write_with(faults, |tx| {
        require_version(tx, workspace_id, from_version_id)?;
        require_version(tx, workspace_id, to_version_id)?;
        let source = select_tip(tx, workspace_id, from_version_id, &path)?;
        let target = select_tip(tx, workspace_id, to_version_id, &path)?;
        let base = select_fork_base(tx, workspace_id, from_version_id, &path)?;
        if source.is_none() && target.is_none() {
            return Ok(SecretWriteResult {
                changed: false,
                moment: None,
            });
        }
        if source.as_ref() == target.as_ref() {
            return Ok(SecretWriteResult {
                changed: false,
                moment: None,
            });
        }
        let source_text = source
            .as_ref()
            .map(|sealed| aead::open(key, workspace_id, &path, sealed))
            .transpose()?;
        let target_text = target
            .as_ref()
            .map(|sealed| aead::open(key, workspace_id, &path, sealed))
            .transpose()?;
        let base_text = base
            .as_ref()
            .map(|sealed| aead::open(key, workspace_id, &path, sealed))
            .transpose()?;
        if secret_plaintexts_equal(source_text.as_ref(), target_text.as_ref())
            || secret_plaintexts_equal(source_text.as_ref(), base_text.as_ref())
        {
            return Ok(SecretWriteResult {
                changed: false,
                moment: None,
            });
        }
        if secret_moment_exists(tx, workspace_id, moment_id)? {
            return Err(DomainError::DuplicateMomentId);
        }
        let moment_order = next_secret_moment_order(tx, workspace_id)?;
        let moment = SecretMomentRecord {
            moment_order,
            moment_id: moment_id.to_owned(),
            workspace_id: workspace_id.to_owned(),
            version_id: to_version_id.to_owned(),
            path: path.clone(),
            recorded_at_ms: now_ms,
            operation: if source.is_some() {
                SecretOp::Write
            } else {
                SecretOp::Delete
            },
            metadata_origin: metadata_origin.to_owned(),
            metadata_summary: metadata_summary.clone(),
            metadata_correlation_id: metadata_correlation_id.clone(),
        };
        // Cross-version apply always materializes: the plaintext has never
        // been observed on disk here.
        insert_moment(tx, &moment, moment_order, source.as_ref(), false)?;
        if let Some(source) = source.as_ref() {
            upsert_tip(tx, &moment, moment_order, source)?;
            let ciphertext_sha = put_binary_blob(tx, source.ciphertext())?;
            enqueue_job(
                tx,
                &MaterializationJobSpec {
                    job_id: format!("secret-mat_{moment_id}"),
                    target_path: path.clone(),
                    content_sha256: ciphertext_sha,
                    preimage: Preimage::Absent,
                    target_generation: moment_order,
                    now_ms,
                },
            )?;
            journal(tx, &path, "secret.file.put", now_ms)?;
        } else {
            let target = target.ok_or(DomainError::StateCorrupt {
                reason: "secret delete apply has no target preimage",
            })?;
            let target_text = target_text.ok_or(DomainError::StateCorrupt {
                reason: "secret delete apply has no target plaintext",
            })?;
            let ciphertext_sha = put_binary_blob(tx, target.ciphertext())?;
            enqueue_delete_job(
                tx,
                &MaterializationJobSpec {
                    job_id: format!("secret-mat_{moment_id}"),
                    target_path: path.clone(),
                    content_sha256: ciphertext_sha,
                    preimage: Preimage::Present(dohc_engine_storage::hex_sha256(
                        target_text.as_bytes(),
                    )),
                    target_generation: moment_order,
                    now_ms,
                },
            )?;
            tx.execute(
                "DELETE FROM secret_files WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
                params![workspace_id, to_version_id, path],
            )
            .map_err(DomainError::sql_persist)?;
            journal(tx, &path, "secret.file.delete", now_ms)?;
        }
        Ok(SecretWriteResult {
            changed: true,
            moment: Some(moment),
        })
    })?;
    committed(outcome)
}

fn secret_plaintexts_equal(
    left: Option<&SecretPlaintext>,
    right: Option<&SecretPlaintext>,
) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left.as_bytes() == right.as_bytes(),
        _ => false,
    }
}

/// Restore the sealed state that existed immediately before a secret moment.
/// The prior ciphertext is copied forward verbatim; history is append-only.
pub fn restore_secret_file_verbatim(
    store: &mut EngineStore,
    workspace_id: &str,
    path: &str,
    before_moment_id: &str,
    moment_id: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<SecretRestoreResult, DomainError> {
    restore_secret_file_verbatim_with_metadata(
        store,
        workspace_id,
        path,
        before_moment_id,
        moment_id,
        "restore",
        None,
        None,
        now_ms,
        faults,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn restore_secret_file_verbatim_with_metadata(
    store: &mut EngineStore,
    workspace_id: &str,
    path: &str,
    before_moment_id: &str,
    moment_id: &str,
    metadata_origin: &str,
    metadata_summary: Option<String>,
    metadata_correlation_id: Option<String>,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<SecretRestoreResult, DomainError> {
    non_empty(workspace_id, "workspace_id")?;
    non_empty(before_moment_id, "moment_id")?;
    non_empty(moment_id, "moment_id")?;
    validate_origin(metadata_origin)?;
    let path = validate_secret_path(path)?;
    let outcome = store.write_with(faults, |tx| {
        let before = tx
            .query_row(
                "SELECT moment_order, moment_id, workspace_id, version_id, path, recorded_at_ms, \
                 operation, metadata_origin, metadata_summary, metadata_correlation_id \
                 FROM secret_moments WHERE workspace_id = ?1 AND moment_id = ?2",
                params![workspace_id, before_moment_id],
                map_moment_row,
            )
            .optional()
            .map_err(DomainError::sql_corrupt)?
            .ok_or(DomainError::SecretMomentNotFound)??;
        if before.path != path {
            return Err(DomainError::InvalidInput {
                reason: "path does not match the protected history moment",
            });
        }
        let previous = tx
            .query_row(
                "SELECT after_present, after_iv_base64, after_auth_tag_base64, \
                 after_ciphertext_base64, after_byte_length FROM secret_moments \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3 \
                   AND moment_order < ?4 ORDER BY moment_order DESC LIMIT 1",
                params![workspace_id, before.version_id, before.path, before.moment_order],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(DomainError::sql_corrupt)?;
        let target = match previous {
            None | Some((0, _, _, _, _)) => None,
            Some((1, iv, tag, ciphertext, byte_length)) => Some(SealedSecret::from_base64(
                iv.as_deref().ok_or(DomainError::StateCorrupt { reason: "secret moment is incomplete" })?,
                tag.as_deref().ok_or(DomainError::StateCorrupt { reason: "secret moment is incomplete" })?,
                ciphertext.as_deref().ok_or(DomainError::StateCorrupt { reason: "secret moment is incomplete" })?,
                usize::try_from(byte_length.ok_or(DomainError::StateCorrupt { reason: "secret moment is incomplete" })?)
                    .map_err(|_| DomainError::StateCorrupt { reason: "secret moment has a negative byte length" })?,
            )?),
            Some(_) => return Err(DomainError::StateCorrupt { reason: "secret moment has invalid presence" }),
        };
        let current = select_tip(tx, workspace_id, &before.version_id, &before.path)?;
        if target.as_ref() == current.as_ref() {
            return Ok(SecretRestoreResult {
                restored: if target.is_some() { "text" } else { "deleted" },
                restored_moment_id: before.moment_id,
                path: before.path,
            });
        }
        if secret_moment_exists(tx, workspace_id, moment_id)? {
            return Err(DomainError::DuplicateMomentId);
        }
        let moment_order = next_secret_moment_order(tx, workspace_id)?;
        let record = SecretMomentRecord {
            moment_order,
            moment_id: moment_id.to_owned(),
            workspace_id: workspace_id.to_owned(),
            version_id: before.version_id,
            path: before.path,
            recorded_at_ms: now_ms,
            operation: if target.is_some() { SecretOp::Write } else { SecretOp::Delete },
            metadata_origin: metadata_origin.to_owned(),
            metadata_summary,
            metadata_correlation_id,
        };
        // Restore always materializes; capture never observed this state.
        insert_moment(tx, &record, moment_order, target.as_ref(), false)?;
        if let Some(sealed) = target.as_ref() {
            upsert_tip(tx, &record, moment_order, sealed)?;
            let ciphertext_sha = put_binary_blob(tx, sealed.ciphertext())?;
            enqueue_job(
                tx,
                &MaterializationJobSpec {
                    job_id: format!("secret-mat_{moment_id}"),
                    target_path: record.path.clone(),
                    content_sha256: ciphertext_sha,
                    preimage: Preimage::Absent,
                    target_generation: moment_order,
                    now_ms,
                },
            )?;
            journal(tx, &record.path, "secret.file.put", now_ms)?;
        } else {
            let outgoing = current.as_ref().ok_or(DomainError::StateCorrupt {
                reason: "secret restore delete has no outgoing tip",
            })?;
            let content_sha256 = put_binary_blob(tx, outgoing.ciphertext())?;
            enqueue_delete_job(
                tx,
                &MaterializationJobSpec {
                    job_id: format!("secret-mat_{moment_id}"),
                    target_path: record.path.clone(),
                    content_sha256,
                    preimage: Preimage::Absent,
                    target_generation: moment_order,
                    now_ms,
                },
            )?;
            tx.execute(
                "DELETE FROM secret_files WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
                params![workspace_id, record.version_id, record.path],
            )
            .map_err(DomainError::sql_persist)?;
            journal(tx, &record.path, "secret.file.delete", now_ms)?;
        }
        Ok(SecretRestoreResult {
            restored: if target.is_some() { "text" } else { "deleted" },
            restored_moment_id: record.moment_id,
            path: record.path,
        })
    })?;
    committed(outcome)
}

#[derive(Debug, Clone, Copy)]
enum SecretDeleteDiskIntent {
    Materialize,
    AlreadyAbsent,
}

fn delete_secret_file_inner(
    store: &mut EngineStore,
    input: &SecretDelete,
    disk_intent: SecretDeleteDiskIntent,
    faults: &dyn FaultInjector,
) -> Result<Option<SecretMomentRecord>, DomainError> {
    non_empty(&input.workspace_id, "workspace_id")?;
    non_empty(&input.version_id, "version_id")?;
    non_empty(&input.moment_id, "moment_id")?;
    let path = validate_secret_path(&input.path)?;
    validate_origin(&input.metadata_origin)?;

    let ws = &input.workspace_id;
    // Desired-state first: an already-absent tip is an idempotent no-op
    // (including an exactly-once retry of a delete that committed then
    // crashed before the ack), so a committed retry is never misreported as
    // `DuplicateMomentId`. Only a delete that will actually change state
    // reaches the duplicate-moment-id guard.
    let has_tip = store.read_with(|conn| {
        require_version(conn, ws, &input.version_id)?;
        if select_tip(conn, ws, &input.version_id, &path)?.is_none() {
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
        path: path.clone(),
        recorded_at_ms: input.now_ms,
        operation: SecretOp::Delete,
        metadata_origin: input.metadata_origin.clone(),
        metadata_summary: input.metadata_summary.clone(),
        metadata_correlation_id: input.metadata_correlation_id.clone(),
    };
    let outcome = store.write_with(faults, |tx| {
        let moment_order = next_secret_moment_order(tx, ws)?;
        insert_moment(
            tx,
            &record,
            moment_order,
            None,
            matches!(disk_intent, SecretDeleteDiskIntent::AlreadyAbsent),
        )?;
        {
            // Deletes are anchored to the outgoing tip's ciphertext blob
            // because they carry no bytes of their own. RPC deletes enqueue a
            // pending delete so open replay removes the active disk
            // projection. Capture retire records a completed marker because
            // its triggering filesystem removal already satisfied that work.
            let tip_sha: Option<String> = tx
                .query_row(
                    "SELECT ciphertext_base64 FROM secret_files                      WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
                    params![ws, input.version_id, path],
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
                let spec = MaterializationJobSpec {
                    job_id: format!("secret-mat_{}", input.moment_id),
                    target_path: path.clone(),
                    content_sha256,
                    // The keyless RPC delete cannot derive a plaintext hash.
                    // The secret-only executor adopts the current disk file
                    // and never emits a plaintext conflict artifact.
                    preimage: Preimage::Absent,
                    target_generation: moment_order,
                    now_ms: input.now_ms,
                };
                match disk_intent {
                    SecretDeleteDiskIntent::Materialize => enqueue_delete_job(tx, &spec)?,
                    SecretDeleteDiskIntent::AlreadyAbsent => {
                        dohc_engine_storage::record_completed_job(tx, &spec)?;
                    }
                }
            }
        }
        tx.execute(
            "DELETE FROM secret_files WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
            params![ws, input.version_id, path],
        )
        .map_err(DomainError::sql_persist)?;
        journal(tx, &path, "secret.file.delete", input.now_ms)?;
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
    let path = validate_secret_path(&input.path)?;
    let ws = input.workspace_id.clone();
    // OWNERSHIP: a disk-driven retire must never destroy a tip written any
    // other way (API, replication) — its plaintext may never have been on disk
    // at all, so absence proves nothing about it.
    if input.only_if_own_origin {
        let version = input.version_id.clone();
        let path = path.clone();
        let owner_ws = ws.clone();
        let owned = store
            .read_with(move |conn| secret_tip_capture_owned(conn, &owner_ws, &version, &path))?;
        if owned == Some(false) {
            return Ok(None);
        }
    }
    // Single-writer: the pre-read reservation is authoritative; the post-write
    // pin makes the assumption release-checked.
    let reserved = store.read_with(|conn| next_secret_moment_order(conn, &ws))?;
    let moment_id = derive_capture_secret_retire_moment_id(
        &input.workspace_id,
        &input.version_id,
        &path,
        reserved,
    );
    let basename = path.rsplit('/').next().unwrap_or(path.as_str()).to_owned();
    let result = delete_secret_file_inner(
        store,
        &SecretDelete {
            workspace_id: input.workspace_id.clone(),
            version_id: input.version_id.clone(),
            path,
            moment_id,
            metadata_origin: input.metadata_origin.clone(),
            metadata_summary: Some(format!("Deleted {basename}")),
            metadata_correlation_id: None,
            now_ms: input.now_ms,
        },
        SecretDeleteDiskIntent::AlreadyAbsent,
        faults,
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
        crate::store::hash_fields(&[
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
        crate::store::hash_fields(&[
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
/// Whether the tip for `path` is one capture put on disk itself. `None` means
/// there is no tip. Reads the engine-stamped `capture_owned` column rather
/// than `metadata_origin`: the origin string is caller-supplied over RPC and
/// replication, so keying disk ownership on it lets a remote writer claim it.
fn secret_tip_capture_owned(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<bool>, DomainError> {
    conn.query_row(
        "SELECT m.capture_owned FROM secret_files f          JOIN secret_moments m ON m.workspace_id = f.workspace_id            AND m.moment_id = f.latest_moment_id          WHERE f.workspace_id = ?1 AND f.version_id = ?2 AND f.path = ?3",
        params![workspace_id, version_id, path],
        |row| row.get::<_, i64>(0).map(|owned| owned != 0),
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

fn select_fork_base(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<SealedSecret>, DomainError> {
    let row = conn
        .query_row(
            "SELECT iv_base64, auth_tag_base64, ciphertext_base64, byte_length \
             FROM secret_fork_bases WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
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
    row.map(|(iv, tag, ciphertext, byte_length)| {
        let byte_length = usize::try_from(byte_length).map_err(|_| DomainError::StateCorrupt {
            reason: "secret fork base has a negative byte length",
        })?;
        SealedSecret::from_base64(&iv, &tag, &ciphertext, byte_length).map_err(DomainError::from)
    })
    .transpose()
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
///
/// No in-place legacy-row rewrite is attempted: pre-R15 cutover destroys the
/// pre-release Rust/TS secret rows, and ciphertext AAD is path-bound, so a
/// keyless schema migration could not safely rename an old non-canonical key.
fn validate_secret_path(path: &str) -> Result<String, DomainError> {
    validate_path(path)?;
    let (classification, normalized) =
        dohc_engine_files::policy::classify_engine_file_path_normalized(path);
    if classification != dohc_engine_files::policy::PathClassification::Secret {
        return Err(DomainError::NotSecretPath);
    }
    normalized.ok_or(DomainError::NotSecretPath)
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
        Err(DomainError::InvalidVersion)
    }
}

fn secret_moment_exists(
    conn: &Connection,
    workspace_id: &str,
    moment_id: &str,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 WHERE \
             EXISTS (SELECT 1 FROM secret_moments WHERE workspace_id = ?1 AND moment_id = ?2) OR \
             EXISTS (SELECT 1 FROM moments WHERE workspace_id = ?1 AND moment_id = ?2)",
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
/// (base64 fields), or `None` for a delete. `capture_owned` records whether
/// the plaintext for this moment lives on disk *because capture observed it
/// there* — never inferred from the caller-supplied origin string.
fn insert_moment(
    tx: &Transaction<'_>,
    moment: &SecretMomentRecord,
    moment_order: i64,
    after: Option<&SealedSecret>,
    capture_owned: bool,
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
         after_byte_length, capture_owned) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
            i64::from(capture_owned),
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
    let path = validate_secret_path(path)?;
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
