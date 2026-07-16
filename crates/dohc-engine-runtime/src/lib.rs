//! dohc engine runtime — CAL-1 calibration slice.
//!
//! The workspace actor model: each open workspace is a dedicated OS thread
//! owning exactly one storage writer connection, addressed by clonable
//! message-only handles. This crate proves the state-ownership story the
//! rewrite depends on (`plan §Workspace actor model`):
//!
//! - **One writer, one owner.** [`actor::WorkspaceActor`] owns the connection
//!   on its worker thread; it never crosses threads and there is no second
//!   connection to the same file.
//! - **Canonical-identity keying.** [`identity::EngineDbIdentity`] resolves any
//!   alias (redundant components, relative forms, symlinks, Windows junctions /
//!   8.3 names) to one identity via `std::fs::canonicalize`, so
//!   [`supervisor::WorkspaceSupervisor`] returns the *same* actor for aliased
//!   paths.
//! - **Explicit lifecycle + deterministic Drop.** `open → ready → draining →
//!   closed`; dropping an actor or the supervisor joins the worker and releases
//!   the connection — no detached task outlives its owner.
//!
//! The crate is dormant: nothing here is reachable from product code.

#![forbid(unsafe_code)]

pub mod actor;
pub mod error;
pub mod identity;
pub mod supervisor;

pub use actor::{ActorHandle, LifecycleState, StoreSnapshot, WorkspaceActor};
pub use error::RuntimeError;
pub use identity::EngineDbIdentity;
pub use supervisor::WorkspaceSupervisor;

// Re-export the storage surface callers need so a downstream host depends on
// one crate for the common path.
pub use dohc_engine_storage::{
    CompoundWrite, Document, EngineStore, FaultInjector, NoFaults, StorageError, WriteOutcome,
    faults::{FaultAction, FaultPoint},
};
