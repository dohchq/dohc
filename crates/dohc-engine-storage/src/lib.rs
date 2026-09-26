//! dohc engine storage: SQLite ownership and transactions.
//!
//! Owns exactly one writable `rusqlite` connection per workspace `engine.db`
//! and the engine schema.
//!
//! - **One writer per store.** [`EngineStore`] owns a single [`rusqlite`]
//!   connection; it is neither `Sync` nor cloneable, so a second writer to the
//!   same file is a type error, not a convention. The low-level open primitive
//!   is crate-private; `dohc-engine-runtime`'s file-id-keyed supervisor is the
//!   enforced single entry point.
//! - **The open ritual lives in one place** ([`EngineStore::open`]):
//!   `busy_timeout`, `foreign_keys = ON`, then the fingerprint fence, then —
//!   only for an accepted store — WAL, `synchronous`, validate-or-init,
//!   `quick_check`. A rejected store is left byte-unchanged.
//! - **The v1-vs-v2 fence.** A database stamped with any schema version other
//!   than `2` is rejected with [`StorageError::UnsupportedFingerprint`] — never
//!   auto-migrated, never written over.
//! - **One transactional seam** ([`EngineStore::write_with`]) runs a domain
//!   mutation in one transaction, consulting the named storage fault points
//!   [`faults::FaultPoint::StorageBeforePersist`] and
//!   [`faults::FaultPoint::StorageAfterCommitBeforeAck`].

#![forbid(unsafe_code)]

pub mod backup;
pub mod blob;
pub mod diagnostics;
pub mod error;
pub mod faults;
pub mod limits;
pub mod materialize;
pub mod remote_changes;
pub mod store;

pub(crate) mod migration;
pub(crate) mod schema;

pub use backup::{
    BackupManifest, BackupOutcome, BackupRecord, FreeSpaceProbe, RealFreeSpace,
    create_verified_backup, load_valid_backup,
};
pub use blob::{
    get_binary_blob, has_binary_blob, hex, hex_sha256, put_binary_blob, put_binary_blob_verified,
    put_binary_blob_with_sha,
};
pub use diagnostics::{CorruptionKind, DiagnosticBundle, classify};
pub use error::StorageError;
pub use faults::{FaultAction, FaultInjector, FaultPoint, NoFaults};
pub use limits::{
    ENGINE_BUILD, ENGINE_SCHEMA_VERSION, ENGINE_SQLITE_BUSY_TIMEOUT_MS,
    ENGINE_STORAGE_PROTOCOL_VERSION, MAX_BLOB_BYTES, MAX_IDENTIFIER_BYTES, MAX_MATERIALIZE_BYTES,
    MAX_REPLACE_ATTEMPTS, SQLITE_DATABASE_HEADER_BYTES,
};
pub use materialize::{
    Displacement, DisplacementResolution, DisplacementSpec, DisplacementState, JobStatus,
    MaterializationJob, MaterializationJobSpec, MaterializationOperation, Preimage,
    cancel_pending_jobs_for_path, enqueue_delete_job, enqueue_job, record_completed_job,
    stamp_secret_capture_owned, upsert_projection_job,
};
pub use remote_changes::{count_remote_change_in_tx, remote_changes_applied_in};
pub use store::{EngineStore, TxnOutcome};
