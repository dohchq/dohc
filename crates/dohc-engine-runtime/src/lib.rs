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
//! - **File-identity keying.** [`identity::EngineDbIdentity`] keys on the OS
//!   file identity (POSIX `dev`+`ino`, Windows volume+file-index), so every
//!   alias that addresses the same bytes — filename-case aliases, file
//!   symlinks, junctions, and hard links — converges on one actor.
//!   [`supervisor::WorkspaceSupervisor`] dedups on it and never holds its lock
//!   across the blocking open; [`WorkspaceSupervisor::global`] makes the
//!   guarantee process-wide.
//! - **Explicit lifecycle + deterministic Drop.** `open → ready → draining →
//!   closed`; dropping an actor or the supervisor joins the worker and releases
//!   the connection — no detached task outlives its owner, and a panicking
//!   worker still publishes `Closed`.
//!
//! The crate is dormant: nothing here is reachable from product code.

#![forbid(unsafe_code)]

pub mod actor;
pub mod error;
pub mod identity;
pub mod search;
pub mod supervisor;

pub use actor::{
    ActiveVersionSwitch, ActorHandle, BinaryWriteExecutionResult, LifecycleState,
    MergeExecutionResult, PostCommitMaterializeOutcome, RelayConfiguration, RelayOperation,
    RelayOperationOutcome, RollbackExecutionResult, SelfWriteRecorder, SharingDeclined,
    StoreSnapshot, UnitsOutcome, WorkspaceActor, YdocAppend, YdocOpenState, YdocSettlement,
};
pub use error::RuntimeError;
pub use identity::EngineDbIdentity;
pub use search::{
    SearchCandidate, SearchError, SearchPageDisposition, SearchResult, SearchResultKey,
    SearchSurface,
};
pub use supervisor::{SupervisorOpen, WorkspaceSupervisor};

// Re-export the storage surface callers need so a downstream host depends on
// one crate for the common path.
pub use dohc_engine_storage::{
    CompoundWrite, Document, EngineStore, FaultInjector, NoFaults, StorageError, TxnOutcome,
    WriteOutcome,
    faults::{FaultAction, FaultPoint},
};

// The cancellation primitive the async actor loop consumes. Re-exported so a
// caller drives cancellation through one crate.
pub use dohc_engine_crypto::SecretDataKey;
pub use tokio_util::sync::CancellationToken;

pub use dohc_engine_collab::{AppendOutcome, ContentKind, DocKey};
pub use dohc_engine_domain::{
    BinaryWriteResult, CaptureIngest, CaptureIngestBinary, CaptureIngestBinaryResult,
    CaptureManifestSeedEntry, CaptureRetire, CaptureRetireResult, CaptureSecret,
    CaptureSecretRetire, CompareTextFileVersions, DeleteResult, DeleteTextFile,
    MergeTextFileFromVersion, MergeTextFileResult, RenameResult, RenameTextFile,
    ResolveTextConflict, ResolveTextConflictResult, RollbackTextFileMutation, TextConflict,
    TextSnapshot, VersionFileChange, VersionedTextComparison, WriteBinary, WriteResult, WriteText,
};
pub use dohc_engine_sync::{ApplyOutcome, ConflictApplyResult, ReplicationEnvelope};
