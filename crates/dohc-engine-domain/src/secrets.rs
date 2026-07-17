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
//! - **Durable materialization intent.** A write enqueues an R04
//!   materialization job in the SAME transaction as the secret state
//!   (`enqueue_job` in `write_with`), so the intent to write the plaintext file
//!   is crash-safe. The job references the CIPHERTEXT blob (integrity anchor);
//!   the plaintext is produced only at execution time by the secret-aware
//!   materializer (`materialize_secret_file`) and lives only on disk.
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
            if let Some(tip) = self.select_tip(conn, ws, &input.version_id, &input.path)? {
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
            enqueue_job(
                tx,
                &MaterializationJobSpec {
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
                },
            )?;
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
        let has_tip = self.store.read_with(|conn| {
            require_version(conn, ws, &input.version_id)?;
            if self
                .select_tip(conn, ws, &input.version_id, &input.path)?
                .is_none()
            {
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
            metadata_summary: None,
            metadata_correlation_id: None,
        };
        let outcome = self.store.write_with(faults, |tx| {
            let moment_order = next_secret_moment_order(tx, ws)?;
            insert_moment(tx, &record, moment_order, None)?;
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

    // ----------------------------------------------------------- materialize

    /// THE single authorized plaintext accessor. Decrypts the current tip for a
    /// secret path, returning a zeroizing [`SecretPlaintext`], or `None` when no
    /// tip exists. Fails closed (`decrypt-failed`) on tamper/wrong-key/AAD. The
    /// secret-aware materialization pipeline calls this to obtain the bytes it
    /// writes to disk.
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
            let Some(tip) = self.select_tip(conn, workspace_id, version_id, path)? else {
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
        self.store.read_with(|conn| {
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

    fn select_tip(
        &self,
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
}

// ============================================================================
// Free helpers.
// ============================================================================

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
