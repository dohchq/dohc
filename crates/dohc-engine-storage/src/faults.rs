//! Named fault points for the in-process crash-injection tier (`TEST_ORACLE.md`
//! §3, tier 1). CAL-1 implements the two highest-leverage storage-lane points;
//! the registry grows one row per point as capability shards land.
//!
//! The trait seam lives here (not in the testkit) so `dohc-engine-storage`
//! stays independent of its test harness while the *positions* — which are
//! properties of the storage write lane — are defined next to the code they
//! guard. The testkit depends on this crate and supplies a [`FaultInjector`]
//! implementation.

/// A stable-named position in the storage write pipeline. Names mirror the
/// registry in `TEST_ORACLE.md` §3.1 (`family.position`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FaultPoint {
    /// Inside the open `BEGIN IMMEDIATE`, all mutation SQL issued, **before**
    /// the commit is made durable. A crash here ⇒ ROLLBACK ⇒ restart shows
    /// the pre-op state (atomic rollback). `TEST_ORACLE.md` §3.1 point 2/3.
    StorageBeforePersist,
    /// The transaction is durably committed but the response has **not** been
    /// delivered. A crash here ⇒ restart shows the post-op state; a retry with
    /// the same idempotency key must be exactly-once. `TEST_ORACLE.md` §3.1
    /// point 4 (the highest-priority gap in the TS engine).
    StorageAfterCommitBeforeAck,

    // ---- migration runner (TEST_ORACLE §3.2 points 10/11) -----------------
    /// Migration N committed, before migration N+1 begins. A crash here ⇒
    /// restart resumes idempotently from the ledger; no consumer observes the
    /// gap. `migrate.between-steps`.
    MigrateBetweenSteps,
    /// A migration body has been applied inside its transaction but the ledger
    /// row is not yet committed. A crash here ⇒ the transaction rolls back and
    /// restart re-runs (transactional) or re-runs idempotently from the
    /// started-but-incomplete row (non-transactional); the integrity check
    /// passes either way. `migrate.before-ledger-commit`.
    MigrateBeforeLedgerCommit,

    // ---- backup pipeline (TEST_ORACLE §3.9 points 33/34) ------------------
    /// Backup bytes copied, manifest not yet written. A crash here ⇒ the backup
    /// is invalid-by-absence-of-manifest; retention never counts it; retry
    /// produces a fresh verified backup. `backup.after-copy-before-manifest`.
    BackupAfterCopyBeforeManifest,
    /// Mid restore-test verification. A crash here ⇒ the source is untouched and
    /// the "verified" flag is never set. `backup.during-restore-verify`.
    BackupDuringRestoreVerify,

    // ---- materialization pipeline (TEST_ORACLE §3.3 points 12-16) ---------
    // These positions live on the filesystem side (`dohc-engine-files`) but the
    // fault registry is shared and owned here, the core crate the testkit
    // depends on, so there is exactly ONE `FaultPoint` enum across the engine.
    /// Job row durable, nothing on disk yet. A crash here ⇒ restart replays the
    /// job to completion. `materialize.after-job-commit`.
    MaterializeAfterJobCommit,
    /// Temp sibling written, not flushed/renamed. A crash here ⇒ restart
    /// discards or completes per job state; the temp is never captured as user
    /// content. `materialize.after-temp-write`.
    MaterializeAfterTempWrite,
    /// Flushed per the per-OS durability policy, not yet renamed. A crash here ⇒
    /// same recovery contract as after-temp-write; distinct because the flush
    /// policy is itself under test. `materialize.after-flush-before-rename`.
    MaterializeAfterFlushBeforeRename,
    /// Immediately before the atomic replace, after the preimage would be
    /// revalidated. A trace mutating the target here proves the engine observes
    /// newer external content and does NOT overwrite (capture + preserve-both).
    /// `materialize.before-preimage-revalidate`.
    MaterializeBeforePreimageRevalidate,
    /// File replaced, job not yet marked complete. A crash here ⇒ restart replay
    /// is idempotent (preimage hash now matches the new content; no second
    /// write, no duplicate). `materialize.after-rename-before-complete`.
    MaterializeAfterRenameBeforeComplete,

    // ---- rollback post-commit response -----------------------------------
    /// The rollback transaction is durable, immediately before the runtime
    /// reads the active version to decide whether to materialize its restore
    /// job inline. A simulated failure here must degrade to a committed
    /// response; it must never turn the successful rollback into an RPC error.
    /// `rollback.before-active-version-lookup`.
    RollbackBeforeActiveVersionLookup,

    // ---- capture apply/ack (TEST_ORACLE §3.8 point 36) -------------------
    // This position lives on the filesystem/capture side
    // (`dohc-engine-files`) but the registry is shared here so the engine and
    // testkit still have exactly ONE `FaultPoint` enum.
    /// One capture op reached its idempotent domain sink, but the reconcile
    /// manifest has not acknowledged that path. Restart retries safely.
    /// `capture.after-op-apply-before-ack`.
    CaptureAfterOpApplyBeforeAck,

    // ---- search index rebuild (R12) ---------------------------------------
    /// Inside `ensure_search_index_for_version`'s SAVEPOINT, after the chat FTS
    /// wipe and before the rebuild inserts complete. A crash here MUST roll the
    /// whole rebuild back (no torn/partial FTS generation, no state row), even
    /// when the caller ran the ensure on an autocommit (read-only-borrow)
    /// connection — the savepoint is what makes that hold. `search.mid-rebuild`.
    SearchIndexMidRebuild,

    // ---- replication (TEST_ORACLE §3.5 points 22-26) --------------------
    /// Inside the compound domain-mutation + replication-journal transaction.
    /// A crash leaves neither half visible. `sync.during-journal-txn`.
    SyncDuringJournalTxn,
    /// Imported state, applied-op record, and peer ack are staged but not yet
    /// committed. A crash leaves all three absent. `sync.before-apply-commit`.
    SyncBeforeApplyCommit,
    /// The imported-op transaction committed but its fetch cursor did not. A
    /// restart refetches and idempotently skips it.
    /// `sync.between-apply-and-cursor-commit`.
    SyncBetweenApplyAndCursorCommit,
    /// Relay accepted a pushed batch before the local high-water mark became
    /// durable. Retrying relies on coordinate dedup.
    /// `sync.after-push-before-cursor-persist`.
    SyncAfterPushBeforeCursorPersist,
    /// Referenced blobs are staged but hydration has not committed. A crash
    /// applies no op and advances no cursor. `sync.before-blob-hydrate-commit`.
    SyncBeforeBlobHydrateCommit,
}

impl FaultPoint {
    /// The stable wire/registry name.
    pub const fn as_str(self) -> &'static str {
        match self {
            FaultPoint::StorageBeforePersist => "storage.before-persist",
            FaultPoint::StorageAfterCommitBeforeAck => "storage.after-commit-before-ack",
            FaultPoint::MigrateBetweenSteps => "migrate.between-steps",
            FaultPoint::MigrateBeforeLedgerCommit => "migrate.before-ledger-commit",
            FaultPoint::BackupAfterCopyBeforeManifest => "backup.after-copy-before-manifest",
            FaultPoint::BackupDuringRestoreVerify => "backup.during-restore-verify",
            FaultPoint::MaterializeAfterJobCommit => "materialize.after-job-commit",
            FaultPoint::MaterializeAfterTempWrite => "materialize.after-temp-write",
            FaultPoint::MaterializeAfterFlushBeforeRename => {
                "materialize.after-flush-before-rename"
            }
            FaultPoint::MaterializeBeforePreimageRevalidate => {
                "materialize.before-preimage-revalidate"
            }
            FaultPoint::MaterializeAfterRenameBeforeComplete => {
                "materialize.after-rename-before-complete"
            }
            FaultPoint::RollbackBeforeActiveVersionLookup => {
                "rollback.before-active-version-lookup"
            }
            FaultPoint::CaptureAfterOpApplyBeforeAck => "capture.after-op-apply-before-ack",
            FaultPoint::SearchIndexMidRebuild => "search.mid-rebuild",
            FaultPoint::SyncDuringJournalTxn => "sync.during-journal-txn",
            FaultPoint::SyncBeforeApplyCommit => "sync.before-apply-commit",
            FaultPoint::SyncBetweenApplyAndCursorCommit => "sync.between-apply-and-cursor-commit",
            FaultPoint::SyncAfterPushBeforeCursorPersist => "sync.after-push-before-cursor-persist",
            FaultPoint::SyncBeforeBlobHydrateCommit => "sync.before-blob-hydrate-commit",
        }
    }
}

/// What the pipeline should do when it reaches an armed fault point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultAction {
    /// Nothing armed here — proceed normally (the zero-cost-when-disarmed path).
    Continue,
    /// Simulate a process crash at this point. The pipeline abandons the
    /// in-flight ack; durability is whatever the point's position contract
    /// guarantees (before-persist ⇒ not committed; after-commit ⇒ committed).
    Crash,
}

/// The seam the write lane consults at each named point. Implementations must
/// be cheap: the common case is "no fault armed", returning
/// [`FaultAction::Continue`].
pub trait FaultInjector: Send + Sync {
    /// Called by the write lane when it reaches `point`. Returning
    /// [`FaultAction::Crash`] triggers the in-process crash simulation.
    fn poll(&self, point: FaultPoint) -> FaultAction;
}

/// The production injector: never faults. This is what non-test callers pass,
/// and it compiles down to a constant.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoFaults;

impl FaultInjector for NoFaults {
    #[inline]
    fn poll(&self, _point: FaultPoint) -> FaultAction {
        FaultAction::Continue
    }
}
