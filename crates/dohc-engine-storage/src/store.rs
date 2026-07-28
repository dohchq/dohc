//! [`EngineStore`]: sole owner of one writable SQLite connection to a
//! workspace's `engine.db`. Exposes the day-one open ritual and one generic
//! transactional write API — the compound commit — that exercises atomicity
//! (domain mutation + replication journal entry + idempotency-ledger row all
//! commit together, or none do).

use crate::error::StorageError;
use crate::faults::{FaultInjector, FaultPoint};
use crate::limits::{MAX_DOCUMENT_BODY_BYTES, MAX_IDENTIFIER_BYTES};
use crate::materialize::MaterializationJob;
use crate::schema::{open_engine_db, open_engine_db_read_only};
use crate::{blob, materialize};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Whether a string is a safe bare SQL identifier (ASCII alnum + underscore,
/// non-empty). Used to guard the one place a table name is interpolated rather
/// than bound (`table_row_count`), so a caller cannot inject SQL through it.
fn is_safe_identifier(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// A single owned writable connection. Not `Sync`, not cloneable: the workspace
/// actor owns exactly one and never lets it cross threads
/// (`STATE_OWNERSHIP.tsv` row `sqlite-conn-versioned-text` → Rust: one writer
/// per actor). Dropping it closes the connection deterministically.
#[derive(Debug)]
pub struct EngineStore {
    conn: Connection,
    freshly_created: bool,
    database_path: PathBuf,
}

/// Inputs to one compound write. A faithful minimal analog of the engine's
/// compound-commit invariant: a domain mutation (`documents` upsert) plus its
/// replication journal entry, recorded exactly-once under `request_id`.
#[derive(Debug, Clone)]
pub struct CompoundWrite {
    /// Idempotency key. A retry carrying the same key is exactly-once.
    pub request_id: String,
    /// The document being written.
    pub doc_id: String,
    /// The document body (UTF-8; bounded by [`MAX_DOCUMENT_BODY_BYTES`]).
    pub body: String,
    /// The replication op kind journaled alongside the mutation.
    pub op_kind: String,
    /// Injected wall-clock timestamp (`PORTING.md` §3: one injected clock;
    /// negative/fractional-in-f64 values are the domain's concern, here the
    /// calibration slice uses integral millis).
    pub now_ms: i64,
}

impl CompoundWrite {
    fn validate(&self) -> Result<(), StorageError> {
        check_identifier(&self.request_id, "request_id")?;
        check_identifier(&self.doc_id, "doc_id")?;
        check_identifier(&self.op_kind, "op_kind")?;
        if self.body.len() > MAX_DOCUMENT_BODY_BYTES {
            return Err(StorageError::DocumentTooLarge {
                actual: self.body.len(),
            });
        }
        Ok(())
    }
}

fn check_identifier(value: &str, field: &'static str) -> Result<(), StorageError> {
    if value.is_empty() {
        return Err(StorageError::InvalidInput {
            reason: match field {
                "request_id" => "request_id must not be empty",
                "doc_id" => "doc_id must not be empty",
                _ => "op_kind must not be empty",
            },
        });
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(StorageError::InvalidInput {
            reason: match field {
                "request_id" => "request_id exceeds the identifier length limit",
                "doc_id" => "doc_id exceeds the identifier length limit",
                _ => "op_kind exceeds the identifier length limit",
            },
        });
    }
    Ok(())
}

/// The outcome of a generic transactional unit run through
/// [`EngineStore::write_with`]. Mirrors [`WriteOutcome`] but carries the
/// closure's value on success, so the versioning domain
/// (`dohc-engine-domain`) can commit a compound mutation + its journal entry
/// in ONE transaction and still learn what it produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxnOutcome<T> {
    /// The transaction committed durably and the ack was delivered.
    Committed(T),
    /// A crash fault fired at a named point. `committed` reports the durable
    /// truth for test assertions only — durability is proven by reopening.
    Crashed { committed: bool },
}

/// The outcome of a compound write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteOutcome {
    /// The transaction committed durably and the ack was delivered. `deduped`
    /// is true when the request key was already recorded (a retry replayed to
    /// the stored result without re-applying).
    Acked { seq: i64, deduped: bool },
    /// A crash fault fired before the ack was delivered. `committed` reports
    /// the durable truth for test assertions only — durability is proven by
    /// reopening, never by trusting this flag.
    Crashed { committed: bool },
}

/// A materialized document row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Document {
    pub doc_id: String,
    pub body: String,
    pub updated_at_ms: i64,
}

/// A prior request recovered from the idempotency ledger.
struct RecordedRequest {
    payload_hash: String,
    result_seq: i64,
}

/// Deterministic fingerprint of a write's payload (`doc_id`, `body`, `op_kind`)
/// as lowercase-hex SHA-256 over NUL-separated fields — the plan's
/// content-addressing discipline (`PORTING.md` §10/§11). Stored in the
/// idempotency ledger so a retry can be checked for payload equality.
fn payload_fingerprint(write: &CompoundWrite) -> String {
    let mut hasher = Sha256::new();
    hasher.update(write.doc_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(write.body.as_bytes());
    hasher.update([0u8]);
    hasher.update(write.op_kind.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        // Infallible: writing to a String never fails.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Consult a named fault point. **cfg-gated**: only the `fault-injection`
/// feature compiles the actual `poll` call. In a release build without the
/// feature this is a `const false`, so the crash branch it guards is dead code
/// the optimizer removes — provably zero release overhead on the write lane
/// (`plan §Rust policy`; the injection seam is dev/test-only). The
/// [`FaultInjector`] trait and [`crate::NoFaults`] stay in the public API for
/// callers (`dohc-engine-runtime` threads an `Arc<dyn FaultInjector>`), but
/// their `poll` is never invoked in production.
#[cfg(feature = "fault-injection")]
#[inline]
fn should_crash(faults: &dyn FaultInjector, point: FaultPoint) -> bool {
    faults.poll(point) == crate::faults::FaultAction::Crash
}

#[cfg(not(feature = "fault-injection"))]
#[inline(always)]
fn should_crash(_faults: &dyn FaultInjector, _point: FaultPoint) -> bool {
    false
}

impl EngineStore {
    /// Open-or-create the store at `path`, applying the full open ritual and
    /// the v1-vs-v2 fingerprint fence (`open_engine_db`). This is the low-level
    /// writer primitive — the single-writer-per-file contract is enforced by
    /// `dohc-engine-runtime`'s supervisor, which is the intended entry point.
    pub fn open(path: &Path, now_ms: i64) -> Result<Self, StorageError> {
        let opened = open_engine_db(path, now_ms)?;
        Ok(EngineStore {
            conn: opened.conn,
            freshly_created: opened.freshly_created,
            database_path: path.to_path_buf(),
        })
    }

    /// Open an existing, current store for queries only. Unlike [`Self::open`],
    /// this never creates the database, changes persistent pragmas, or runs the
    /// migration ledger.
    pub fn open_read_only(path: &Path) -> Result<Self, StorageError> {
        let opened = open_engine_db_read_only(path)?;
        Ok(EngineStore {
            conn: opened.conn,
            freshly_created: false,
            database_path: path.to_path_buf(),
        })
    }

    /// Whether this open initialized a fresh database rather than reopening an
    /// existing v2 store.
    pub fn was_freshly_created(&self) -> bool {
        self.freshly_created
    }

    /// The path used to open this store. Higher layers use the canonical
    /// `.dohc/engine/engine.db` location to recover the workspace root for
    /// filesystem-backed policy reads.
    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    /// Bind a fresh store to a shadow marker, or verify an existing binding.
    /// The actor calls this before exposing a shadow workspace for writes.
    pub fn bind_shadow_clone_token(&mut self, token: &str) -> Result<bool, StorageError> {
        if self.freshly_created {
            match self.write_with(&crate::NoFaults, |tx| -> Result<(), StorageError> {
                tx.execute(
                    "INSERT INTO shadow_clone (rowid_guard, token) VALUES (1, ?1) \
                     ON CONFLICT(rowid_guard) DO NOTHING",
                    [token],
                )
                .map_err(StorageError::persist)?;
                Ok(())
            })? {
                TxnOutcome::Committed(()) => {}
                TxnOutcome::Crashed { .. } => {
                    return Err(StorageError::PersistFailed { source: None });
                }
            }
        }
        let stored: Option<String> = self
            .conn
            .query_row(
                "SELECT token FROM shadow_clone WHERE rowid_guard = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(StorageError::corrupt)?;
        Ok(stored.as_deref() == Some(token))
    }

    /// The one generic transactional write API. Applies the domain mutation,
    /// appends the replication journal entry, and records the idempotency
    /// ledger row atomically, consulting the two named storage fault points.
    pub fn commit_compound(
        &mut self,
        write: &CompoundWrite,
        faults: &dyn FaultInjector,
    ) -> Result<WriteOutcome, StorageError> {
        write.validate()?;
        let payload_hash = payload_fingerprint(write);

        // Idempotency pre-check: a retry whose ledger row was committed by a
        // prior attempt replays to the recorded result and never re-applies.
        // A key reused with a DIFFERENT payload is rejected — replaying would
        // drop the new write or return a stale result.
        if let Some(recorded) = self.lookup_request(&write.request_id)? {
            if recorded.payload_hash != payload_hash {
                return Err(StorageError::IdempotencyKeyReuseMismatch);
            }
            return Ok(WriteOutcome::Acked {
                seq: recorded.result_seq,
                deduped: true,
            });
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StorageError::persist)?;

        tx.execute(
            "INSERT INTO documents (doc_id, body, updated_at_ms) VALUES (?1, ?2, ?3) \
             ON CONFLICT(doc_id) DO UPDATE SET body = excluded.body, \
             updated_at_ms = excluded.updated_at_ms",
            rusqlite::params![write.doc_id, write.body, write.now_ms],
        )
        .map_err(StorageError::persist)?;

        tx.execute(
            "INSERT INTO replication_journal (doc_id, op_kind, created_at_ms) \
             VALUES (?1, ?2, ?3)",
            rusqlite::params![write.doc_id, write.op_kind, write.now_ms],
        )
        .map_err(StorageError::persist)?;
        let seq = tx.last_insert_rowid();

        tx.execute(
            "INSERT INTO engine_requests \
             (request_id, payload_hash, result_seq, committed_at, kind) \
             VALUES (?1, ?2, ?3, ?4, 'compound')",
            rusqlite::params![write.request_id, payload_hash, seq, write.now_ms],
        )
        .map_err(StorageError::persist)?;

        // Fault point: inside the open transaction, before commit. A crash
        // here rolls back (dropping the transaction) — restart shows no
        // partial state.
        if should_crash(faults, FaultPoint::StorageBeforePersist) {
            drop(tx); // explicit rollback
            return Ok(WriteOutcome::Crashed { committed: false });
        }

        tx.commit().map_err(StorageError::persist)?;

        // Fault point: durably committed, ack not yet delivered. A crash here
        // leaves the committed state; a retry is exactly-once via the ledger.
        if should_crash(faults, FaultPoint::StorageAfterCommitBeforeAck) {
            return Ok(WriteOutcome::Crashed { committed: true });
        }

        Ok(WriteOutcome::Acked {
            seq,
            deduped: false,
        })
    }

    /// Borrow the owned connection for a read-only closure (read-your-writes on
    /// the single writer). The versioning domain composes its history/read SQL
    /// through this seam so the connection never leaves the actor thread.
    ///
    /// Generic over the closure's error so a caller (e.g. `dohc-engine-domain`)
    /// maps `rusqlite` errors into its own taxonomy. By contract the closure
    /// only reads; writes go through [`Self::write_with`] so the fault seam and
    /// single-transaction discipline always apply.
    pub fn read_with<T, E>(&self, f: impl FnOnce(&Connection) -> Result<T, E>) -> Result<T, E> {
        f(&self.conn)
    }

    /// Run a compound domain mutation inside exactly ONE `BEGIN IMMEDIATE`
    /// transaction, consulting the two named storage fault points around the
    /// commit boundary. The closure issues every mutation — the domain write,
    /// its replication-journal entry, and any idempotency-ledger row — against
    /// the same `&Transaction`, so they commit together or not at all (plan
    /// §Storage and recovery model; PORTING.md §9).
    ///
    /// A `StorageBeforePersist` fault rolls back (drop-is-rollback) and reports
    /// `Crashed { committed: false }`; a `StorageAfterCommitBeforeAck` fault
    /// reports `Crashed { committed: true }` after a durable commit. An `Err`
    /// from the closure rolls the transaction back and propagates. Generic over
    /// the closure's error `E` (which must absorb the transaction's own
    /// begin/commit [`StorageError`]s) so the caller keeps its taxonomy.
    pub fn write_with<T, E>(
        &mut self,
        faults: &dyn FaultInjector,
        f: impl FnOnce(&Transaction<'_>) -> Result<T, E>,
    ) -> Result<TxnOutcome<T>, E>
    where
        E: From<StorageError>,
    {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StorageError::persist)?;

        let value = match f(&tx) {
            Ok(value) => value,
            Err(err) => {
                // Explicit rollback of the domain mutation before surfacing the
                // error; the typed `Transaction` would roll back on drop too.
                drop(tx);
                return Err(err);
            }
        };

        // Cancel/crash point is BETWEEN durable steps, never mid-commit
        // (PORTING.md §12): the closure has issued all SQL but nothing is
        // durable yet.
        if should_crash(faults, FaultPoint::StorageBeforePersist) {
            drop(tx); // explicit rollback
            return Ok(TxnOutcome::Crashed { committed: false });
        }

        tx.commit().map_err(StorageError::persist)?;

        if should_crash(faults, FaultPoint::StorageAfterCommitBeforeAck) {
            return Ok(TxnOutcome::Crashed { committed: true });
        }

        Ok(TxnOutcome::Committed(value))
    }

    fn lookup_request(&self, request_id: &str) -> Result<Option<RecordedRequest>, StorageError> {
        self.conn
            .query_row(
                "SELECT payload_hash, result_seq FROM engine_requests WHERE request_id = ?1",
                [request_id],
                |row| {
                    Ok(RecordedRequest {
                        payload_hash: row.get(0)?,
                        result_seq: row.get(1)?,
                    })
                },
            )
            .map(Some)
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(StorageError::corrupt(other)),
            })
    }

    /// The database's `PRAGMA synchronous` setting (`1` = NORMAL). Exposed so a
    /// weakened-durability configuration is directly assertable.
    pub fn synchronous_setting(&self) -> Result<i64, StorageError> {
        self.conn
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .map_err(StorageError::corrupt)
    }

    /// Read a document by id (read-your-writes on the owned connection).
    pub fn read_document(&self, doc_id: &str) -> Result<Option<Document>, StorageError> {
        self.conn
            .query_row(
                "SELECT doc_id, body, updated_at_ms FROM documents WHERE doc_id = ?1",
                [doc_id],
                |row| {
                    Ok(Document {
                        doc_id: row.get(0)?,
                        body: row.get(1)?,
                        updated_at_ms: row.get(2)?,
                    })
                },
            )
            .map(Some)
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(StorageError::corrupt(other)),
            })
    }

    /// Number of `documents` rows.
    pub fn document_count(&self) -> Result<i64, StorageError> {
        self.scalar_count("SELECT COUNT(*) FROM documents")
    }

    /// Number of `replication_journal` rows.
    pub fn journal_len(&self) -> Result<i64, StorageError> {
        self.scalar_count("SELECT COUNT(*) FROM replication_journal")
    }

    /// Number of `engine_requests` (idempotency ledger) rows.
    pub fn request_ledger_len(&self) -> Result<i64, StorageError> {
        self.scalar_count("SELECT COUNT(*) FROM engine_requests")
    }

    /// Number of `engine_migrations` (migration ledger) rows.
    pub fn migration_ledger_len(&self) -> Result<i64, StorageError> {
        self.scalar_count("SELECT COUNT(*) FROM engine_migrations")
    }

    fn scalar_count(&self, sql: &str) -> Result<i64, StorageError> {
        self.conn
            .query_row(sql, [], |row| row.get(0))
            .map_err(StorageError::corrupt)
    }

    // ---- R04: blob store -------------------------------------------------

    /// Store `bytes` as a content-addressed binary blob (dedup by hash),
    /// returning its sha-256 key.
    pub fn put_binary_blob(&self, bytes: &[u8]) -> Result<String, StorageError> {
        blob::put_binary_blob(&self.conn, bytes)
    }

    /// Fetch a binary blob by key, verifying integrity on read.
    pub fn get_binary_blob(&self, sha256: &str) -> Result<Option<Vec<u8>>, StorageError> {
        blob::get_binary_blob(&self.conn, sha256)
    }

    /// Whether a binary blob with this key exists.
    pub fn has_binary_blob(&self, sha256: &str) -> Result<bool, StorageError> {
        blob::has_binary_blob(&self.conn, sha256)
    }

    /// The number of distinct binary blobs.
    pub fn binary_blob_count(&self) -> Result<i64, StorageError> {
        blob::binary_blob_count(&self.conn)
    }

    // ---- R04: materialization jobs --------------------------------------

    /// Every pending materialization job, oldest first — the set the filesystem
    /// pipeline replays at startup and executes on enqueue.
    pub fn list_pending_materialization_jobs(
        &self,
    ) -> Result<Vec<MaterializationJob>, StorageError> {
        materialize::list_pending_jobs(&self.conn)
    }

    /// Load a single materialization job by id.
    pub fn load_materialization_job(
        &self,
        job_id: &str,
    ) -> Result<Option<MaterializationJob>, StorageError> {
        materialize::load_job(&self.conn, job_id)
    }

    /// Mark a job complete (content durably on disk).
    pub fn mark_materialization_complete(
        &self,
        job_id: &str,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        materialize::mark_complete(&self.conn, job_id, now_ms)
    }

    /// Mark a job in conflict (newer external content was preserved).
    pub fn mark_materialization_conflict(
        &self,
        job_id: &str,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        materialize::mark_conflict(&self.conn, job_id, now_ms)
    }

    /// The number of pending materialization jobs.
    pub fn pending_materialization_count(&self) -> Result<i64, StorageError> {
        materialize::pending_job_count(&self.conn)
    }

    /// The highest COMPLETE `target_generation` for `path` in `workspace_id`
    /// (staleness gate for the materialization pipeline), or `None` if nothing
    /// is materialized there.
    pub fn max_completed_generation_for_path(
        &self,
        workspace_id: &str,
        path: &str,
    ) -> Result<Option<i64>, StorageError> {
        materialize::max_completed_generation_for_path(&self.conn, workspace_id, path)
    }

    // ---- R04: backup support --------------------------------------------

    /// The on-disk size of the main database file, from `page_count * page_size`
    /// (the free-space preflight budget). Does not require the file path.
    pub fn database_size_bytes(&self) -> Result<u64, StorageError> {
        let page_count: i64 = self
            .conn
            .pragma_query_value(None, "page_count", |r| r.get(0))
            .map_err(StorageError::corrupt)?;
        let page_size: i64 = self
            .conn
            .pragma_query_value(None, "page_size", |r| r.get(0))
            .map_err(StorageError::corrupt)?;
        let bytes = page_count.max(0) as u64 * page_size.max(0) as u64;
        Ok(bytes)
    }

    /// Copy the live database into `dest` as a clean single-file snapshot
    /// (`VACUUM INTO`). `dest` must not already exist. Used by the backup
    /// pipeline; not a general-purpose export.
    pub fn vacuum_into(&self, dest: &Path) -> Result<(), StorageError> {
        let dest_str = dest.to_str().ok_or(StorageError::InvalidInput {
            reason: "backup destination path is not valid UTF-8",
        })?;
        self.conn
            .execute("VACUUM INTO ?1", [dest_str])
            .map_err(StorageError::backup)?;
        Ok(())
    }

    /// The engine ownership record `(engine_uuid, engine_build)`.
    pub fn ownership(&self) -> Result<(String, String), StorageError> {
        self.conn
            .query_row(
                "SELECT engine_uuid, engine_build FROM engine_ownership WHERE rowid_guard = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(StorageError::corrupt)
    }

    /// The engine ownership UUID, if the store is readable (best-effort; used by
    /// diagnostics on a failed open).
    pub fn engine_uuid(&self) -> Result<String, StorageError> {
        self.conn
            .query_row(
                "SELECT engine_uuid FROM engine_ownership WHERE rowid_guard = 1",
                [],
                |r| r.get(0),
            )
            .map_err(StorageError::corrupt)
    }

    /// Row count of a single table (backup restore-test compare). The table name
    /// is interpolated (not bindable), so it is guarded to a safe identifier.
    pub fn table_row_count(&self, table: &str) -> Result<i64, StorageError> {
        if !is_safe_identifier(table) {
            return Err(StorageError::InvalidInput {
                reason: "table name is not a safe identifier",
            });
        }
        self.conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .map_err(StorageError::corrupt)
    }
}
