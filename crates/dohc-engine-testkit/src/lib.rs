//! dohc engine testkit: fixtures and the crash harness for the engine crates.
//!
//! - [`scratch::ScratchDir`] — a self-cleaning temp workspace with a canonical
//!   `.dohc/engine/engine.db` path, plus alias fixtures for identity
//!   convergence: [`scratch::try_make_dir_alias`] (symlink/junction),
//!   [`scratch::try_make_file_symlink`], and [`scratch::make_hardlink`].
//! - [`faults::ScriptedFaults`] / [`faults::PanicFaults`] /
//!   [`faults::GateFaults`] — injectors for the named storage fault points
//!   (`storage.before-persist`, `storage.after-commit-before-ack`) that crash,
//!   panic, or wedge the worker respectively.
//! - [`harness`] — adversarial database builders (foreign v1 fingerprint,
//!   unversioned foreign store) and WAL sidecar helpers.
//! - [`db_scan::EngineDbScan`] — the on-disk byte scan that proves a secret
//!   file's plaintext never reaches `engine.db`, its `-wal`, or its `-shm`,
//!   with the positive control that keeps the scan honest.
//!
//! The integration tests that consume it live in each crate's `tests/`.

#![forbid(unsafe_code)]

pub mod db_scan;
pub mod faults;
pub mod harness;
pub mod scratch;

pub use db_scan::{EngineDbScan, bytes_contain};
pub use faults::{GateFaults, PanicFaults, ScriptedFaults};
pub use scratch::{
    ScratchDir, engine_db_path, make_hardlink, try_make_dir_alias, try_make_file_symlink,
};
