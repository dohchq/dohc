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
}

impl FaultPoint {
    /// The stable wire/registry name.
    pub const fn as_str(self) -> &'static str {
        match self {
            FaultPoint::StorageBeforePersist => "storage.before-persist",
            FaultPoint::StorageAfterCommitBeforeAck => "storage.after-commit-before-ack",
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
