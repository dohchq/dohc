//! [`EngineStore`]: sole owner of one writable SQLite connection to a
//! workspace's `engine.db`. Exposes the open ritual and the transactional
//! write seam every domain composes through.

use crate::error::StorageError;
use crate::faults::{FaultInjector, FaultPoint};
use crate::materialize::MaterializationJob;
use crate::schema::{OPEN_WORK_STEP_OPS, open_engine_db, open_engine_db_read_only};
use crate::{blob, materialize};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};

/// Whether a string is a safe bare SQL identifier (ASCII alnum + underscore,
/// non-empty). Used to guard the one place a table name is interpolated rather
/// than bound (`table_row_count`), so a caller cannot inject SQL through it.
fn is_safe_identifier(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// A single owned writable connection. Not `Sync`, not cloneable: the workspace
/// actor owns exactly one and never lets it cross threads
/// (one writer per actor). Dropping it closes the connection deterministically.
#[derive(Debug)]
pub struct EngineStore {
    conn: Connection,
    freshly_created: bool,
    database_path: PathBuf,
}

/// The outcome of a transactional unit run through
/// [`EngineStore::write_with`]: the closure's value on success, or the crash
/// fault that fired.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxnOutcome<T> {
    /// The transaction committed durably and the ack was delivered.
    Committed(T),
    /// A crash fault fired at a named point. `committed` reports the durable
    /// truth for test assertions only — durability is proven by reopening.
    Crashed { committed: bool },
}

/// Consult a named fault point. **cfg-gated**: only the `fault-injection`
/// feature compiles the actual `poll` call. In a release build without the
/// feature this is a `const false`, so the optimizer removes the unreachable
/// crash branch — provably zero release overhead on the write lane
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
        Self::open_counting(path, now_ms, None)
    }

    /// [`Self::open`], counting its SQLite work into `work` while it runs. A
    /// migration or the integrity check on a large store can take long; the
    /// count lets a caller tell that from a stuck open.
    pub fn open_counting(
        path: &Path,
        now_ms: i64,
        work: Option<Arc<AtomicU64>>,
    ) -> Result<Self, StorageError> {
        let opened = open_engine_db(path, now_ms, work)?;
        Ok(EngineStore {
            conn: opened.conn,
            freshly_created: opened.freshly_created,
            database_path: path.to_path_buf(),
        })
    }

    /// Open a store, recording a fresh root binding in its initial schema transaction.
    /// The caller must persist the matching root marker before calling this.
    /// An existing store is never rebound; verify its binding before use.
    pub fn open_with_root_token(
        path: &Path,
        now_ms: i64,
        token: &str,
        work: Option<Arc<AtomicU64>>,
    ) -> Result<Self, StorageError> {
        let opened =
            crate::schema::open_engine_db_with_root_token(path, now_ms, Some(token), work)?;
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
        Self::open_read_only_counting(path, None)
    }

    /// [`Self::open_read_only`], counting its SQLite work into `work`.
    pub fn open_read_only_counting(
        path: &Path,
        work: Option<Arc<AtomicU64>>,
    ) -> Result<Self, StorageError> {
        let opened = open_engine_db_read_only(path, work)?;
        Ok(EngineStore {
            conn: opened.conn,
            freshly_created: false,
            database_path: path.to_path_buf(),
        })
    }

    /// Count this connection's SQLite work into `work` for as long as someone
    /// else holds it; `None` stops counting. The weak reference means the
    /// counter never outlives its owner, and a dead one costs one failed
    /// upgrade per step until the caller stops counting.
    pub fn count_work(&self, work: Option<Weak<AtomicU64>>) -> Result<(), StorageError> {
        match work {
            Some(work) => self.conn.progress_handler(
                OPEN_WORK_STEP_OPS,
                Some(move || {
                    if let Some(work) = work.upgrade() {
                        work.fetch_add(1, Ordering::Relaxed);
                    }
                    false
                }),
            ),
            None => self.conn.progress_handler(0, None::<fn() -> bool>),
        }
        .map_err(StorageError::corrupt)
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

    /// Bind a fresh store to its root's token, or verify an existing binding.
    /// The actor calls this before exposing a workspace for writes. The row
    /// lives in the `shadow_clone` table until the baseline schema is
    /// rewritten.
    pub fn bind_root_token(
        &mut self,
        token: &str,
        faults: &dyn FaultInjector,
    ) -> Result<bool, StorageError> {
        if self.freshly_created {
            match self.write_with(faults, |tx| -> Result<(), StorageError> {
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

    /// Run a compound domain mutation inside exactly one `BEGIN IMMEDIATE`
    /// transaction, consulting the two named storage fault points around the
    /// commit boundary. The closure issues every mutation — the domain write
    /// and any idempotency-ledger row — against the same `&Transaction`, so
    /// they commit together or not at all.
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

        // Cancel/crash point is between durable steps, never mid-commit: the
        // closure has issued all SQL but nothing is durable yet.
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

    /// Validate a mutation on a transaction that always rolls back.
    pub fn preview_write<T, E>(
        &mut self,
        f: impl FnOnce(&Transaction<'_>) -> Result<T, E>,
    ) -> Result<T, E>
    where
        E: From<StorageError>,
    {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StorageError::persist)?;
        let result = f(&tx);
        tx.rollback().map_err(StorageError::persist)?;
        result
    }

    /// The database's `PRAGMA synchronous` setting (`1` = normal). Exposed so a
    /// weakened-durability configuration is directly assertable.
    pub fn synchronous_setting(&self) -> Result<i64, StorageError> {
        self.conn
            .pragma_query_value(None, "synchronous", |row| row.get(0))
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

    /// Requeue one conflict whose external disk preimage was removed.
    pub fn requeue_materialization_conflict(&self, job_id: &str) -> Result<bool, StorageError> {
        materialize::requeue_conflict(&self.conn, job_id)
    }

    /// The number of pending materialization jobs.
    pub fn pending_materialization_count(&self) -> Result<i64, StorageError> {
        materialize::pending_job_count(&self.conn)
    }

    /// The highest complete `target_generation` for `path` in `workspace_id`
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
    pub(crate) fn database_size_bytes(&self) -> Result<u64, StorageError> {
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
    pub(crate) fn vacuum_into(&self, dest: &Path) -> Result<(), StorageError> {
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
