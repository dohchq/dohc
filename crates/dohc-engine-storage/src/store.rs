//! [`EngineStore`]: sole owner of one writable SQLite connection to a
//! workspace's `engine.db`. Exposes the open ritual and the transactional
//! write seam every domain composes through.

use crate::error::StorageError;
use crate::faults::{FaultInjector, FaultPoint};
use crate::materialize::{
    Displacement, DisplacementResolution, DisplacementSpec, JobStatus, MaterializationJob,
};
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

type CompletionBatch = Arc<std::sync::Mutex<Option<std::collections::HashMap<String, i64>>>>;

/// A single owned writable connection. Not `Sync`, not cloneable: the workspace
/// actor owns exactly one and never lets it cross threads
/// (one writer per actor). Dropping it closes the connection deterministically.
#[derive(Debug)]
pub struct EngineStore {
    conn: Connection,
    checkpoints: Option<crate::checkpoint::Checkpoints>,
    checkpoint_changes: u64,
    #[cfg(feature = "fault-injection")]
    harness_commits: u64,
    freshly_created: bool,
    database_path: PathBuf,
    passive: bool,
    completed_batch: CompletionBatch,
    flushes: crate::flush::Flushes,
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

pub(crate) fn install_passive_guards(conn: &Connection) -> Result<(), StorageError> {
    // Keep replica change keys within the child's address-space limit, without temporary disk files.
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(StorageError::persist)?;
    conn.execute_batch(
        "CREATE TEMP TRIGGER IF NOT EXISTS passive_no_file_jobs BEFORE INSERT ON main.materialization_jobs
         BEGIN SELECT RAISE(IGNORE); END;
         CREATE TEMP TRIGGER IF NOT EXISTS passive_no_automation_claims BEFORE INSERT ON main.automation_claims
         BEGIN SELECT RAISE(IGNORE); END;
         CREATE TEMP TRIGGER IF NOT EXISTS passive_no_local_ops BEFORE INSERT ON main.replication_log
         WHEN NEW.imported = 0
         BEGIN SELECT RAISE(ABORT, 'passive store cannot originate'); END;
         CREATE TEMP TRIGGER IF NOT EXISTS passive_no_audit_exports BEFORE INSERT ON main.live_audit_pending_exports
         BEGIN SELECT RAISE(ABORT, 'passive store cannot export live history'); END;"
    ).map_err(StorageError::persist)
}

impl EngineStore {
    /// A bounded wait for the next checkpoint cycle, run off the writer.
    pub fn checkpoint_cycle(&self) -> impl Fn() + Send + Sync + use<> {
        let wait = self.checkpoints.as_ref().map(|c| c.next_cycle());
        move || {
            if let Some(wait) = &wait {
                wait();
            }
        }
    }

    /// Open a passive store; existing owner stores are refused.
    pub fn open_passive(
        path: &Path,
        now_ms: i64,
        root_token: Option<&str>,
        work: Option<Arc<AtomicU64>>,
    ) -> Result<Self, StorageError> {
        let opened =
            crate::schema::open_engine_db_with_store_role(path, now_ms, root_token, work, true)?;
        let flushes = crate::flush::Flushes::for_database(&opened.conn);
        Ok(Self {
            conn: opened.conn,
            checkpoints: None,
            checkpoint_changes: 0,
            #[cfg(feature = "fault-injection")]
            harness_commits: 0,
            freshly_created: opened.freshly_created,
            database_path: path.to_path_buf(),
            passive: true,
            completed_batch: Arc::default(),
            flushes,
        })
    }

    pub fn is_passive(&self) -> bool {
        self.passive
    }

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
        let flushes = crate::flush::Flushes::for_database(&opened.conn);
        Ok(EngineStore {
            conn: opened.conn,
            checkpoints: None,
            checkpoint_changes: 0,
            freshly_created: opened.freshly_created,
            database_path: path.to_path_buf(),
            passive: false,
            #[cfg(feature = "fault-injection")]
            harness_commits: 0,
            completed_batch: Arc::default(),
            flushes,
        })
    }

    /// Open the actor's writer with automatic checkpoints disabled before migrations.
    /// Startup fails if its background checkpoint connection cannot start.
    pub fn open_for_actor(
        path: &Path,
        now_ms: i64,
        root_token: Option<&str>,
        work: Option<Arc<AtomicU64>>,
    ) -> Result<Self, StorageError> {
        let opened = crate::schema::open_engine_db_for_actor(path, now_ms, root_token, work)?;
        let flushes = crate::flush::Flushes::for_database(&opened.conn);
        Ok(EngineStore {
            checkpoint_changes: opened.conn.total_changes(),
            conn: opened.conn,
            checkpoints: opened.checkpoints,
            freshly_created: opened.freshly_created,
            database_path: path.to_path_buf(),
            #[cfg(feature = "fault-injection")]
            harness_commits: 0,
            passive: false,
            completed_batch: Arc::default(),
            flushes,
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
        let flushes = crate::flush::Flushes::for_database(&opened.conn);
        Ok(EngineStore {
            conn: opened.conn,
            checkpoints: None,
            checkpoint_changes: 0,
            freshly_created: opened.freshly_created,
            database_path: path.to_path_buf(),
            #[cfg(feature = "fault-injection")]
            harness_commits: 0,
            passive: false,
            completed_batch: Arc::default(),
            flushes,
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
        let opened = open_engine_db_read_only(path, work, None)?;
        let passive = crate::schema::store_is_passive(&opened.conn)?;
        Ok(Self::from_read_only(opened.conn, path, passive))
    }

    /// A store for queries only over `conn`, a checked connection to a current
    /// store at `path` that this open neither migrates nor writes.
    pub(crate) fn from_read_only(conn: Connection, path: &Path, passive: bool) -> Self {
        EngineStore {
            conn,
            checkpoints: None,
            checkpoint_changes: 0,
            freshly_created: false,
            database_path: path.to_path_buf(),
            #[cfg(feature = "fault-injection")]
            harness_commits: 0,
            passive,
            completed_batch: Arc::default(),
            flushes: crate::flush::Flushes::read_only(),
        }
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

    /// Request background work and finish only bounded writer-side tails.
    pub fn request_checkpoint(&mut self) {
        self.request_checkpoint_mode(false);
    }
    fn request_checkpoint_mode(&mut self, background: bool) {
        #[cfg(feature = "fault-injection")]
        let _checkpoint = crate::capture_phase::Measure::new("writer_checkpoint_and_request");
        let changes = self.conn.total_changes();
        if self.checkpoints.is_none() || changes == self.checkpoint_changes {
            return;
        }
        self.checkpoint_changes = changes;
        if let Some(checkpoints) = &self.checkpoints {
            if background {
                checkpoints.request_full();
            } else {
                checkpoints.checkpoint_on_writer_if_needed(&self.conn);
                checkpoints.request();
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn checkpoint_worker_running_for_test(&self) -> bool {
        self.checkpoints.as_ref().is_some_and(|c| !c.has_stopped())
    }

    #[cfg(test)]
    pub(crate) fn stop_checkpoint_worker_for_test(&mut self) {
        self.checkpoints.as_mut().unwrap().stop_for_test();
    }

    #[cfg(test)]
    pub(crate) fn checkpoint_work_for_test(&self) -> (u64, i64) {
        self.checkpoints
            .as_ref()
            .map_or((0, 0), |c| c.writer_work_for_test())
    }

    #[cfg(test)]
    pub(crate) fn startup_checkpoint_work_for_test(&self) -> (u64, i64) {
        self.checkpoints
            .as_ref()
            .map_or((0, 0), |c| c.startup_work_for_test())
    }

    #[cfg(test)]
    pub(crate) fn checkpoint_completed_for_test(&self) -> u64 {
        self.checkpoints.as_ref().unwrap().completed_for_test()
    }

    #[cfg(test)]
    pub(crate) fn wait_for_checkpoint_completion_for_test(&self, before: u64) {
        self.checkpoints
            .as_ref()
            .unwrap()
            .wait_for_completion_for_test(before);
    }

    fn prepare_write(&mut self, background: bool) -> Result<(), StorageError> {
        #[cfg(feature = "fault-injection")]
        let _admission = crate::capture_phase::Measure::new("prepare_write");
        if self.checkpoints.as_ref().is_some_and(|c| c.has_stopped()) {
            let replacement = crate::checkpoint::Checkpoints::start(&self.database_path)?;
            replacement.request();
            self.checkpoints.replace(replacement);
        }
        if let Some(checkpoints) = &self.checkpoints {
            checkpoints.prepare_for_write(&self.conn, background)?;
        }

        Ok(())
    }

    /// Admit a connection-level mutation that manages its own savepoint.
    pub fn mutate_with_connection<T, E>(
        &mut self,
        f: impl FnOnce(&Connection) -> Result<T, E>,
    ) -> Result<T, E>
    where
        E: From<StorageError>,
    {
        self.prepare_write(false).map_err(E::from)?;
        let result = f(&self.conn);
        self.request_checkpoint();
        result
    }

    /// Committed writer transactions, excluding schema initialization.
    #[cfg(feature = "fault-injection")]
    pub fn commit_count_for_harness(&self) -> u64 {
        self.harness_commits
    }

    /// The path used to open this store. Higher layers use the canonical
    /// `.dohc/engine/engine.db` location to recover the workspace root for
    /// filesystem-backed policy reads.
    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    /// Flush `file` so that it persists before every later commit of this
    /// store. On Apple silicon a file whose `st_dev` matches the database
    /// file's takes a barrier and leaves a drain owed for
    /// [`Self::drain_flushes`]; any other file is drained now. Elsewhere this
    /// is `sync_all`.
    pub fn flush_before_commits(&self, file: &std::fs::File) -> std::io::Result<()> {
        self.flushes.flush(file)
    }

    /// Make every file flushed with a barrier durable by draining the drive
    /// cache once, through the database's real folder. A no-op when no drain
    /// is owed. A failed drain stays owed until one succeeds. It does not
    /// sync the WAL, so NORMAL commits are no more durable after it.
    pub fn drain_flushes(&self) -> std::io::Result<()> {
        self.flushes.drain()
    }

    /// Take the flushes recorded since the last call.
    #[cfg(feature = "fault-injection")]
    pub fn take_flush_trace(&self) -> Vec<crate::FlushEvent> {
        self.flushes.take_trace()
    }

    /// Make the next owed drain fail.
    #[cfg(feature = "fault-injection")]
    pub fn fail_next_drain(&self) {
        self.flushes.fail_next_drain();
    }

    /// Call `observer` with each flush as it runs, in place of any earlier one.
    #[cfg(feature = "fault-injection")]
    pub fn observe_flushes(&self, observer: impl Fn(crate::FlushEvent) + Send + 'static) {
        self.flushes
            .observe(crate::flush::FlushObserver(Box::new(observer)));
    }

    /// Order flushes on `device` instead of the database file's, as if the
    /// database lived there. `None` drains every file.
    #[cfg(all(
        feature = "fault-injection",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    pub fn order_flushes_on_device(&self, device: Option<u64>) {
        self.flushes.order_on_device(device);
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
        #[cfg(feature = "fault-injection")]
        let mut phase = crate::capture_phase::Phase::new("storage_transaction", None, 0, true);
        #[cfg(feature = "fault-injection")]
        let changes = self.conn.total_changes();
        #[cfg(feature = "fault-injection")]
        crate::capture_phase::wal(&self.conn, &mut phase, true);
        self.prepare_write(false).map_err(E::from)?;
        let outcome = Self::write_on_connection(&self.conn, faults, f)?;
        self.record_write_outcome(&outcome, false);
        #[cfg(feature = "fault-injection")]
        {
            crate::capture_phase::wal(&self.conn, &mut phase, false);
            phase.field(
                "total_changes_delta",
                self.conn.total_changes().saturating_sub(changes),
            );
            phase.finish(match &outcome {
                TxnOutcome::Committed(_) => "committed",
                TxnOutcome::Crashed { committed: true } => "committed-before-crash",
                _ => "rolled-back",
            });
        }
        Ok(outcome)
    }

    /// Commit atomically, with WAL backfill on the checkpoint worker. A full
    /// WAL refuses before BEGIN; an async caller can retry between actor turns.
    pub fn write_background_with<T, E>(
        &mut self,
        faults: &dyn FaultInjector,
        f: impl FnOnce(&Transaction<'_>) -> Result<T, E>,
    ) -> Result<TxnOutcome<T>, E>
    where
        E: From<StorageError>,
    {
        self.prepare_write(true).map_err(E::from)?;
        let outcome = Self::write_on_connection(&self.conn, faults, f)?;
        self.record_write_outcome(&outcome, true);
        Ok(outcome)
    }

    /// One FULL commit syncs this transaction and every earlier WAL commit.
    pub fn write_durable_with<T, E>(
        &mut self,
        faults: &dyn FaultInjector,
        f: impl FnOnce(&Transaction<'_>) -> Result<T, E>,
    ) -> Result<TxnOutcome<T>, E>
    where
        E: From<StorageError>,
    {
        self.prepare_write(false).map_err(E::from)?;
        let outcome = crate::durability::with_full_synchronous(&self.conn, |conn| {
            Self::write_on_connection(conn, faults, f)
        })?;
        self.record_write_outcome(&outcome, false);
        Ok(outcome)
    }

    fn record_write_outcome<T>(&mut self, outcome: &TxnOutcome<T>, background: bool) {
        if matches!(
            outcome,
            TxnOutcome::Committed(_) | TxnOutcome::Crashed { committed: true }
        ) {
            self.request_checkpoint_mode(background);
            #[cfg(feature = "fault-injection")]
            {
                self.harness_commits += 1;
                crate::capture_phase::count("commits", 1);
            }
        }
    }

    fn write_on_connection<T, E>(
        conn: &Connection,
        faults: &dyn FaultInjector,
        f: impl FnOnce(&Transaction<'_>) -> Result<T, E>,
    ) -> Result<TxnOutcome<T>, E>
    where
        E: From<StorageError>,
    {
        #[cfg(feature = "fault-injection")]
        let begin_phase = crate::capture_phase::Measure::new("BEGIN");
        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
            .map_err(StorageError::persist)?;

        #[cfg(feature = "fault-injection")]
        drop(begin_phase);
        #[cfg(feature = "fault-injection")]
        let callback_phase = crate::capture_phase::Measure::new("transaction_callback");
        let value = match f(&tx) {
            Ok(value) => value,
            Err(err) => {
                // Explicit rollback of the domain mutation before surfacing the
                // error; the typed `Transaction` would roll back on drop too.
                drop(tx);
                return Err(err);
            }
        };

        #[cfg(feature = "fault-injection")]
        drop(callback_phase);
        // Cancel/crash point is between durable steps, never mid-commit: the
        // closure has issued all SQL but nothing is durable yet.
        if should_crash(faults, FaultPoint::StorageBeforePersist) {
            drop(tx); // explicit rollback
            return Ok(TxnOutcome::Crashed { committed: false });
        }

        #[cfg(feature = "fault-injection")]
        let commit_phase = crate::capture_phase::Measure::new("COMMIT");
        tx.commit().map_err(StorageError::persist)?;
        #[cfg(feature = "fault-injection")]
        drop(commit_phase);

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

    /// Read a materialization payload from its existing text or binary blob.
    pub fn get_materialization_blob(&self, sha256: &str) -> Result<Option<Vec<u8>>, StorageError> {
        let row: Option<(i64, String)> = crate::text::with_length(&self.conn, sha256)
            .optional()
            .map_err(StorageError::corrupt)?;
        if let Some((byte_length, text)) = row {
            if byte_length as usize != text.len()
                || text.len() > crate::limits::MAX_BLOB_BYTES
                || blob::hex_sha256(text.as_bytes()) != sha256
            {
                return Err(StorageError::BlobIntegrity {
                    sha256: sha256.to_owned(),
                });
            }
            return Ok(Some(text.into_bytes()));
        }
        crate::get_binary_blob(&self.conn, sha256)
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

    /// Generic pending jobs, oldest first. Checked deletes are owned by the
    /// runtime publication state machine and must never enter generic replay.
    pub fn list_pending_materialization_jobs(
        &self,
    ) -> Result<Vec<MaterializationJob>, StorageError> {
        materialize::list_pending_jobs(&self.conn)
    }

    /// Retained jobs, including terminal jobs, for resolving staged identities.
    pub fn list_materialization_jobs(&self) -> Result<Vec<MaterializationJob>, StorageError> {
        materialize::list_jobs(&self.conn, false)
    }

    /// Whether a pending job could explain a path's rowless staged file.
    pub fn has_pending_materialization_for_path(
        &self,
        workspace_id: &str,
        path: &str,
    ) -> Result<bool, StorageError> {
        materialize::has_pending_job_for_path(&self.conn, workspace_id, path)
    }

    /// Pending merge deletes in a workspace that expect these bytes at their
    /// path, oldest first.
    pub fn pending_merge_deletes_expecting(
        &self,
        workspace_id: &str,
        preimage_sha256: &str,
    ) -> Result<Vec<MaterializationJob>, StorageError> {
        materialize::pending_merge_deletes_expecting(&self.conn, workspace_id, preimage_sha256)
    }

    /// Load a single materialization job by id.
    pub fn load_materialization_job(
        &self,
        job_id: &str,
    ) -> Result<Option<MaterializationJob>, StorageError> {
        let mut job = materialize::load_job(&self.conn, job_id)?;
        if self
            .completed_batch
            .lock()
            .expect("status batch mutex")
            .as_ref()
            .is_some_and(|batch| batch.contains_key(job_id))
            && let Some(job) = job.as_mut()
        {
            job.status = JobStatus::Complete;
        }
        Ok(job)
    }

    /// Finish file IO before publishing its completion statuses in one durable commit.
    /// A crash before publication leaves replayable pending jobs.
    pub fn with_materialization_status_batch<T, E>(
        &mut self,
        body: impl FnOnce(&mut Self) -> Result<T, E>,
    ) -> Result<T, E>
    where
        E: From<StorageError>,
    {
        struct Reset(CompletionBatch);
        impl Drop for Reset {
            fn drop(&mut self) {
                *self.0.lock().expect("status batch mutex") = None;
            }
        }
        let nested = self
            .completed_batch
            .lock()
            .expect("status batch mutex")
            .is_some();
        if nested {
            return body(self);
        }
        *self.completed_batch.lock().expect("status batch mutex") =
            Some(std::collections::HashMap::new());
        let reset = Reset(Arc::clone(&self.completed_batch));
        let result = body(self)?;
        let completed = self
            .completed_batch
            .lock()
            .expect("status batch mutex")
            .take()
            .unwrap_or_default();
        drop(reset);
        if !completed.is_empty() {
            let outcome = self.write_with(&crate::NoFaults, |tx| {
                for (id, now) in completed {
                    materialize::mark_complete(tx, &id, now)?;
                }
                Ok::<_, StorageError>(())
            })?;
            if !matches!(outcome, TxnOutcome::Committed(())) {
                return Err(StorageError::persist_public(std::io::Error::other(
                    "status batch commit interrupted",
                ))
                .into());
            }
        }
        Ok(result)
    }

    /// Mark a job complete (content durably on disk).
    pub fn mark_materialization_complete(
        &self,
        job_id: &str,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        if let Some(batch) = self
            .completed_batch
            .lock()
            .expect("status batch mutex")
            .as_mut()
        {
            batch.insert(job_id.to_owned(), now_ms);
            return Ok(());
        }
        materialize::mark_complete(&self.conn, job_id, now_ms)
    }

    /// Mark an unpublished job superseded by a newer durable generation.
    pub fn mark_materialization_cancelled(
        &self,
        job_id: &str,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        materialize::mark_cancelled(&self.conn, job_id, now_ms)
    }

    /// Record a superseded job's keyed write as unpublished. Call it before
    /// the job is marked complete.
    pub fn record_superseded_publication(
        &self,
        job: &MaterializationJob,
    ) -> Result<(), StorageError> {
        materialize::record_superseded_publication(&self.conn, job)
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

    /// Record, in one synced commit, that a staged file holds bytes the store
    /// does not have. Returns the id later transitions name.
    pub fn open_displacement(&self, spec: &DisplacementSpec) -> Result<i64, StorageError> {
        materialize::open_displacement(&self.conn, spec)
    }

    /// Adopt unknown staged files with one FULL commit.
    pub fn open_displacements(&self, specs: &[DisplacementSpec]) -> Result<Vec<i64>, StorageError> {
        materialize::open_displacements(&self.conn, specs)
    }

    /// Record a staged file that stays where it is as a kept row.
    pub fn keep_displacement(
        &self,
        spec: &DisplacementSpec,
        displaced_sha256: Option<&str>,
    ) -> Result<(), StorageError> {
        materialize::keep_displacement(&self.conn, spec, displaced_sha256)
    }

    /// Names held by displacement rows, including retained copies.
    pub fn displacement_names(&self) -> Result<std::collections::HashSet<String>, StorageError> {
        materialize::displacement_names(&self.conn)
    }

    /// End a displacement row and, in the same transaction, give `job` a
    /// terminal status.
    pub fn resolve_displacement(
        &self,
        displacement_id: i64,
        resolution: DisplacementResolution<'_>,
        job: Option<(&str, JobStatus)>,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        materialize::resolve_displacement(&self.conn, displacement_id, resolution, job, now_ms)
    }

    /// Open displacements, and kept ones whose bytes could not be read: the
    /// rows a replay resolves or inspects again, newest first.
    pub fn list_unsettled_displacements(&self) -> Result<Vec<Displacement>, StorageError> {
        materialize::list_unsettled_displacements(&self.conn)
    }

    /// The open displacements of one path, from any job, newest first.
    pub fn list_unsettled_displacements_for_path(
        &self,
        workspace_id: &str,
        path: &str,
    ) -> Result<Vec<Displacement>, StorageError> {
        materialize::list_unsettled_displacements_for_path(&self.conn, workspace_id, path)
    }

    /// Every displacement of one job, in any state, newest first.
    pub fn list_displacements_for_job(
        &self,
        job_id: &str,
    ) -> Result<Vec<Displacement>, StorageError> {
        materialize::list_displacements_for_job(&self.conn, job_id)
    }

    /// The kept displacements of one workspace, which are outside changes the
    /// engine has not captured yet.
    pub fn list_kept_displacements(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<Displacement>, StorageError> {
        materialize::list_kept_displacements(&self.conn, workspace_id)
    }

    /// Whether an open row says a replace moved bytes the store lacks off
    /// `path`, so that its absence on disk is not a delete.
    pub fn path_is_displaced(&self, workspace_id: &str, path: &str) -> Result<bool, StorageError> {
        materialize::path_is_displaced(&self.conn, workspace_id, path)
    }

    /// Whether the store holds content with this hash, as a text or binary
    /// blob.
    pub fn holds_content(&self, sha256: &str) -> Result<bool, StorageError> {
        materialize::holds_content(&self.conn, sha256)
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
        let dest_str = crate::sqlite_path(dest)
            .to_str()
            .ok_or(StorageError::InvalidInput {
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

impl EngineStore {
    fn require_materialization_owner(&self) -> Result<(), StorageError> {
        if self.is_passive() {
            return Err(StorageError::InvalidInput {
                reason: "passive store cannot materialize",
            });
        }
        Ok(())
    }

    /// Read at most 128 retained originals after the stable cursor.
    pub fn retained_displacements_after(
        &self,
        after: i64,
    ) -> Result<Vec<crate::RetainedDisplacement>, StorageError> {
        materialize::retained_rows(&self.conn, after)
    }
    pub fn retain_displacement(
        &self,
        row: &crate::RetainedDisplacement,
    ) -> Result<i64, StorageError> {
        self.require_materialization_owner()?;
        materialize::retain(&self.conn, row)
    }
    /// FULL-commit exact changed bytes and their new quiet-period baseline together.
    pub fn record_retained_read(
        &self,
        old: &crate::RetainedDisplacement,
        new: &crate::RetainedDisplacement,
        bytes: &[u8],
        now_ms: i64,
    ) -> Result<(), StorageError> {
        self.require_materialization_owner()?;
        materialize::record_retained_read(&self.conn, old, new, bytes, now_ms)
    }
    /// The retained row with `id`, if it is still retained.
    pub fn retained_displacement(
        &self,
        id: i64,
    ) -> Result<Option<crate::RetainedDisplacement>, StorageError> {
        materialize::retained_row_by_id(&self.conn, id)
    }
    /// How many of the workspace's retained originals the sweep can never
    /// release, and their logical size.
    pub fn retained_summary(
        &self,
        workspace_id: &str,
    ) -> Result<crate::RetainedSummary, StorageError> {
        materialize::retained_summary(&self.conn, workspace_id)
    }
    /// At most `limit` of the workspace's retained originals the sweep can
    /// never release, after `after`, quiet since `quiet_before_ms`.
    pub fn blocked_retained_displacements(
        &self,
        workspace_id: &str,
        quiet_before_ms: i64,
        after: i64,
        limit: i64,
    ) -> Result<Vec<crate::RetainedDisplacement>, StorageError> {
        materialize::blocked_retained_rows(&self.conn, workspace_id, quiet_before_ms, after, limit)
    }
    /// Whether recovery may still need `row`'s original.
    pub fn retained_original_needed(
        &self,
        row: &crate::RetainedDisplacement,
    ) -> Result<bool, StorageError> {
        materialize::retained_original_needed(&self.conn, row)
    }
    /// Record whether `row`'s volume can refuse to unlink an open file.
    pub fn record_retained_busy_check(
        &self,
        row: &crate::RetainedDisplacement,
        unsupported: bool,
    ) -> Result<(), StorageError> {
        self.require_materialization_owner()?;
        materialize::record_retained_busy_check(&self.conn, row, unsupported)
    }
    pub fn release_retained(&self, id: i64) -> Result<(), StorageError> {
        self.require_materialization_owner()?;
        self.conn
            .execute(
                "DELETE FROM materialization_retained WHERE displacement_id=?1",
                [id],
            )
            .map_err(StorageError::persist)?;
        Ok(())
    }
    /// FULL precedes a rename outside the default staging tree. Without this
    /// location recovery cannot find the surviving source after a power loss.
    pub fn remember_staging(&self, job_id: &str, directory: &str) -> Result<(), StorageError> {
        self.require_materialization_owner()?;
        materialize::with_full_commit(&self.conn, |tx| {
            tx.execute("INSERT INTO materialization_staging_locations(job_id,directory) VALUES(?1,?2) ON CONFLICT(job_id) DO UPDATE SET directory=excluded.directory",rusqlite::params![job_id,directory]).map_err(StorageError::persist)?;
            Ok(())
        })
    }
    pub fn staging_location(&self, job_id: &str) -> Result<Option<String>, StorageError> {
        use rusqlite::OptionalExtension;
        self.conn
            .query_row(
                "SELECT directory FROM materialization_staging_locations WHERE job_id=?1",
                [job_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(StorageError::corrupt)
    }
    pub fn staging_locations(&self) -> Result<Vec<String>, StorageError> {
        let mut q = self
            .conn
            .prepare("SELECT DISTINCT directory FROM materialization_staging_locations ORDER BY directory")
            .map_err(StorageError::corrupt)?;
        q.query_map([], |r| r.get(0))
            .map_err(StorageError::corrupt)?
            .collect::<Result<_, _>>()
            .map_err(StorageError::corrupt)
    }
}

impl EngineStore {
    pub fn is_retained_source(&self, path: &str) -> Result<bool, StorageError> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM materialization_retained WHERE source_path=?1)",
                [path],
                |r| r.get(0),
            )
            .map_err(StorageError::corrupt)
    }
    pub fn retained_names_for_job(&self, job_id: &str) -> Result<Vec<String>, StorageError> {
        let mut q = self
            .conn
            .prepare_cached("SELECT source_path FROM materialization_retained WHERE job_id=?1")
            .map_err(StorageError::corrupt)?;
        let paths = q
            .query_map([job_id], |r| r.get::<_, String>(0))
            .map_err(StorageError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::corrupt)?;
        Ok(paths
            .into_iter()
            .filter_map(|p| p.rsplit('/').next().map(str::to_owned))
            .collect())
    }
}

impl EngineStore {
    /// Promote an oversized retained source to the existing kept-copy path.
    /// FULL preserves its unreadable-source record before ending retention.
    pub fn keep_oversized_retained(
        &self,
        row: &crate::RetainedDisplacement,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        self.require_materialization_owner()?;
        let name = row
            .source_path
            .rsplit('/')
            .next()
            .ok_or(StorageError::InvalidInput {
                reason: "retained source has no name",
            })?;
        materialize::with_full_commit(&self.conn, |tx| {
            tx.execute("INSERT INTO materialization_displacements (job_id,workspace_id,target_path,displaced_name,expected_sha256,content_sha256,state,displaced_sha256,created_at_ms,resolved_at_ms) SELECT ?1,?2,?3,?4,'',NULL,'kept',NULL,?5,?5 WHERE EXISTS(SELECT 1 FROM materialization_retained WHERE displacement_id=?6)",rusqlite::params![row.job_id,row.workspace_id,row.target_path,name,now_ms,row.displacement_id]).map_err(StorageError::persist)?;
            tx.execute(
                "DELETE FROM materialization_retained WHERE displacement_id=?1",
                [row.displacement_id],
            )
            .map_err(StorageError::persist)?;
            Ok(())
        })
    }
    pub fn forget_staging_directory(&self, directory: &str) -> Result<(), StorageError> {
        self.require_materialization_owner()?;
        self.conn
            .execute(
                "DELETE FROM materialization_staging_locations WHERE directory=?1",
                [directory],
            )
            .map_err(StorageError::persist)?;
        Ok(())
    }
}

impl Drop for EngineStore {
    fn drop(&mut self) {
        // Best effort. The actor drains before each reply; this covers work no
        // reply covered.
        if let Err(error) = self.drain_flushes() {
            eprintln!("engine store: drain on close: {error}");
        }
        // Join the checkpointer before closing the writer and its ownership lock.
        self.checkpoints.take();
    }
}

#[cfg(test)]
#[path = "store/background_checkpoint_tests.rs"]
mod background_checkpoint_tests;
