//! R14 robustness closure: input-validation regression coverage over the
//! engine's remote/cross-process input surfaces.
//!
//! Per the program plan's "Fuzzing -- prioritized by input trust" section,
//! this covers the three cutover-blocking families (remote/cross-process
//! input): IPC framing/protocol validation (`tests/protocol_framing.rs`),
//! Y.Doc update ingestion (`tests/ydoc_update.rs`), and replication
//! envelopes (`tests/replication_envelope.rs`).
//!
//! Every test in this crate asserts the same three properties against
//! arbitrary and structurally-mutated input:
//!
//! - **No panic.** `proptest` itself fails a case on any panic/unwind, so
//!   this is implicit in every property below -- no explicit assertion
//!   needed, it's what makes a property test a property test.
//! - **No unbounded growth.** Every surface here is already bounded by the
//!   production code (`WireLimits`, `CollabError::UpdateTooLarge`, the
//!   replication envelope's own byte caps); the tests assert those bounds
//!   are actually enforced against generated input, not merely assumed.
//! - **Fail-closed on malformed input.** Malformed/adversarial input always
//!   yields a typed `Err` and never a corrupted, partially-applied, or
//!   silently-desynced success.
//!
//! Windows-native constraint (read before adding a target): `cargo-fuzz`
//! (libFuzzer) does not reliably build/run on `x86_64-pc-windows-msvc`, the
//! target this repo's Windows evidence runs on. This crate is deliberately
//! `proptest`-based so `tools/rust-engine-program/run-rust-checks.mjs`'s
//! plain `cargo test --workspace` exercises it identically on native Windows
//! and Linux/WSL. Do not add a `cargo-fuzz` target to this workspace's
//! `Cargo.toml` members list -- if one is ever added under `fuzz/**` for
//! opportunistic nightly/WSL use, it must stay a separate, un-workspaced
//! `fuzz/Cargo.toml` (the standard cargo-fuzz layout) so it can never become
//! part of the required gate.
#![forbid(unsafe_code)]
