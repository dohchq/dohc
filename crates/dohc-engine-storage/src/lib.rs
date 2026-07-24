//! dohc engine storage — CAL-1 calibration slice.
//!
//! Owns exactly one writable `rusqlite` connection per workspace `engine.db`
//! and the day-one v2 schema. This is the first production-destined Rust of
//! the engine's storage core (`plan §Storage and recovery model`), reduced to
//! the smallest real vertical that still proves the invariants:
//!
//! - **One writer per store.** [`EngineStore`] owns a single [`rusqlite`]
//!   connection; it is neither `Sync` nor cloneable, so a second writer to the
//!   same file is a type error, not a convention (`PORTING.md` §5, §9). The
//!   low-level open primitive is crate-private; `dohc-engine-runtime`'s
//!   file-id-keyed supervisor is the enforced single entry point.
//! - **The open ritual lives in one place** ([`EngineStore::open`]):
//!   `busy_timeout`, `foreign_keys = ON`, then the fingerprint fence, then —
//!   only for an accepted store — WAL, `synchronous`, validate-or-init,
//!   `quick_check`. A rejected store is left byte-unchanged.
//! - **The v1-vs-v2 fence.** A database stamped with any schema version other
//!   than `2` is rejected with [`StorageError::UnsupportedFingerprint`] — never
//!   auto-migrated, never written over (`plan §Day-one Rust schema`).
//! - **Day-one ledgers.** The migration ledger and the request/idempotency
//!   ledger are created eagerly at init, even though CAL-1 exercises them
//!   minimally.
//! - **One compound-commit API** ([`EngineStore::commit_compound`]) commits a
//!   domain mutation, its replication journal entry, and the idempotency
//!   ledger row in one transaction, consulting the named storage fault points
//!   [`faults::FaultPoint::StorageBeforePersist`] and
//!   [`faults::FaultPoint::StorageAfterCommitBeforeAck`].
//!
//! The crate is dormant: nothing here is reachable from product code.

#![forbid(unsafe_code)]

pub mod backup;
pub mod blob;
pub mod diagnostics;
pub mod error;
pub mod faults;
pub mod limits;
pub mod materialize;
pub mod store;

pub(crate) mod migration;
pub(crate) mod schema;

pub use backup::{
    BackupManifest, BackupOutcome, BackupRecord, FreeSpaceProbe, RealFreeSpace,
    create_verified_backup, load_valid_backup,
};
pub use blob::{
    get_binary_blob, has_binary_blob, hex_sha256, put_binary_blob, put_binary_blob_verified,
};
pub use diagnostics::{CorruptionKind, DiagnosticBundle, classify};
pub use error::StorageError;
pub use faults::{FaultAction, FaultInjector, FaultPoint, NoFaults};
pub use limits::{
    ENGINE_BUILD, ENGINE_SCHEMA_VERSION, ENGINE_SQLITE_BUSY_TIMEOUT_MS,
    ENGINE_STORAGE_PROTOCOL_VERSION, MAX_BLOB_BYTES, MAX_DOCUMENT_BODY_BYTES, MAX_IDENTIFIER_BYTES,
    MAX_MATERIALIZE_BYTES, MAX_REPLACE_ATTEMPTS,
};
pub use materialize::{
    JobStatus, MaterializationJob, MaterializationJobSpec, MaterializationOperation, Preimage,
    enqueue_delete_job, enqueue_job, record_completed_job, stamp_secret_capture_owned,
};
pub use store::{CompoundWrite, Document, EngineStore, TxnOutcome, WriteOutcome};
