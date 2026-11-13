//! Input-validation regression coverage over the engine's remote and
//! cross-process input surfaces, in order of input trust: IPC framing and
//! protocol validation (`tests/protocol_framing.rs`), Y.Doc update ingestion
//! (`tests/ydoc_update.rs`), and replication envelopes at the generic and
//! encrypted-secret apply boundaries (`tests/replication_envelope.rs`).
//!
//! `tests/document_lifecycle.rs` instead checks generated command histories
//! for one note against a reference model. Every other test in this crate
//! asserts the same three properties against arbitrary and
//! structurally-mutated input:
//!
//! - **No panic.** `proptest` fails a case on any panic, so every property
//!   checks this without an explicit assertion.
//! - **No unbounded growth.** The production bounds (`WireLimits`,
//!   `CollabError::UpdateTooLarge`, the replication envelope's byte caps)
//!   hold against generated input.
//! - **Fail-closed on malformed input.** Malformed input always yields a
//!   typed `Err`, never a corrupted, partially applied, or silently desynced
//!   success.
//!
//! This crate uses `proptest` because `cargo-fuzz` (libFuzzer) does not
//! reliably build or run on `x86_64-pc-windows-msvc`.
//! `tools/rust-engine-program/run-rust-checks.mjs` runs it with plain
//! `cargo test --workspace`, the same way on Windows and Linux. Keep any
//! `cargo-fuzz` target in its own un-workspaced `fuzz/Cargo.toml`, never in
//! the workspace members, so it stays out of the required gate.
#![forbid(unsafe_code)]
