//! dohc engine testkit — CAL-1 calibration slice.
//!
//! Fixtures and the in-process crash/restart harness that produce the
//! calibration signal for the storage + runtime slices:
//!
//! - [`scratch::ScratchDir`] — a self-cleaning temp workspace with a canonical
//!   `.dohc/engine/engine.db` path, plus alias fixtures for identity
//!   convergence: [`scratch::try_make_dir_alias`] (symlink/junction),
//!   [`scratch::try_make_file_symlink`], and [`scratch::make_hardlink`].
//! - [`faults::ScriptedFaults`] / [`faults::PanicFaults`] /
//!   [`faults::GateFaults`] — injectors for the named storage fault points
//!   (`storage.before-persist`, `storage.after-commit-before-ack`) that crash,
//!   panic, or wedge the worker respectively.
//! - [`harness`] — crash-during-write simulation and adversarial
//!   database builders (foreign v1 fingerprint, unversioned foreign store).
//!
//! This is dormant test infrastructure; nothing here is reachable from product
//! code. The integration traces that consume it live in `tests/`.

#![forbid(unsafe_code)]

pub mod faults;
pub mod harness;
pub mod scratch;

pub use faults::{GateFaults, PanicFaults, ScriptedFaults};
pub use scratch::{ScratchDir, make_hardlink, try_make_dir_alias, try_make_file_symlink};
