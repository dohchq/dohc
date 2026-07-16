//! dohc engine domain — CAL-2 calibration slice.
//!
//! The versioning domain: stable object identity, versioned text write/read,
//! moment history with keyset pagination, named-version fork, and restore
//! (set-active-version), built ON the CAL-1 storage core
//! (`dohc-engine-storage`) rather than around it. Storage owns the connection,
//! the open ritual, the single-transaction boundary, and the crash-injection
//! fault seam; this crate owns what a version, a moment, a fork, and a restore
//! *mean* (`plan §Target architecture`: `dohc-engine-domain` = version/merge
//! semantics; `dohc-engine-storage` = SQLite ownership + transactions).
//!
//! - **Compound commits.** Every mutation and its replication-journal entry (and
//!   idempotency-ledger row) commit in ONE transaction via
//!   [`dohc_engine_storage::EngineStore::write_with`] (`PORTING.md` §9).
//! - **Identity, not paths.** [`records::TextSnapshot`]/[`records::MomentRecord`]
//!   carry a stable `object_id`; a `path` is an alias onto it.
//! - **History as keyset pages.** [`VersionedTextStore::list_moments`] returns a
//!   `limit + 1` probe page with a `next_before_moment_order` cursor.
//! - **Restore preserves both sides.** [`VersionedTextStore::set_active_version`]
//!   moves the active pointer without destroying any version's rows.
//! - **Differential surface.** [`normalize::NormalizedState`] is a deterministic
//!   projection of the version graph, moment order, active version, and
//!   snapshot blob hashes for the TS-vs-Rust comparison.
//!
//! The crate is dormant: nothing here is reachable from product code.

#![forbid(unsafe_code)]

pub mod error;
pub mod normalize;
pub mod records;
pub mod store;

pub use error::DomainError;
pub use normalize::NormalizedState;
pub use records::{
    CreateNamedVersion, ListMomentsQuery, MomentOp, MomentPage, MomentRecord, TextSnapshot,
    VersionKind, VersionRecord, WriteResult, WriteText,
};
pub use store::{MAX_TEXT_BYTES, VersionedTextStore};

// Re-export the storage surface a domain caller needs on the common path.
pub use dohc_engine_storage::{EngineStore, FaultInjector, NoFaults, StorageError, TxnOutcome};
