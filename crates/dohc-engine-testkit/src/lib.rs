//! dohc engine testkit — CAL-1 calibration slice.
//!
//! Fixtures and the in-process crash/restart harness that produce the
//! calibration signal for the storage + runtime slices:
//!
//! - [`scratch::ScratchDir`] — a self-cleaning temp workspace with a canonical
//!   `.dohc/engine/engine.db` path, plus [`scratch::try_make_dir_alias`] for
//!   the symlink/junction identity-convergence fixture.
//! - [`faults::ScriptedFaults`] — a single-shot injector for the named storage
//!   fault points (`storage.before-persist`,
//!   `storage.after-commit-before-ack`).
//! - [`harness`] — crash-during-write simulation and adversarial
//!   database builders (foreign v1 fingerprint, unversioned foreign store).
//!
//! This is dormant test infrastructure; nothing here is reachable from product
//! code. The integration traces that consume it live in `tests/`.

#![forbid(unsafe_code)]

pub mod faults;
pub mod harness;
pub mod scratch;

pub use faults::ScriptedFaults;
pub use scratch::{ScratchDir, try_make_dir_alias};
