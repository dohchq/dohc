//! Cutover-blocking fuzz family 2/3: Y.Doc update ingestion.
//!
//! Surface under test: `dohc_engine_collab::ydoc::Ydoc::apply` /
//! `Ydoc::validate_update` -- the entry point for an arbitrary byte payload
//! purporting to be a Yjs v1 CRDT update.
//!
//! # CRITICAL FINDING (R14): yrs 0.27.3 can hard-abort the process on
//! malformed input -- this surface is NOT currently fuzzable with random
//! bytes, and is NOT SAFE to expose to untrusted remote input yet
//!
//! Property-based fuzzing in this session (seeded, deterministic;
//! `StdRng::seed_from_u64(42)`, uniform random byte vectors 0..64 bytes)
//! found that `Update::decode_v1` (called identically by both
//! `Ydoc::apply` and `Ydoc::validate_update` -- there is no safer of the two)
//! can be driven into Rust's debug-mode "unsafe precondition violated"
//! checker, which **aborts the whole process** (`STATUS_STACK_BUFFER_OVERRUN`
//! / SIGABRT on this run) rather than unwinding -- `std::panic::catch_unwind`
//! CANNOT catch this. Two distinct crash shapes were observed across a few
//! hundred random attempts:
//! - `core::str::validations.rs`: "unsafe precondition(s) violated:
//!   hint::unreachable_unchecked must never be reached" -- consistent with
//!   an unchecked UTF-8 string decode inside yrs trusting a length/validity
//!   invariant that adversarial bytes violate.
//! - `core::char::methods.rs:239`: "unsafe precondition(s) violated: invalid
//!   value for `char`" -- consistent with yrs decoding a `char` from a raw
//!   `u32` via an unchecked conversion (e.g. `char::from_u32_unchecked`)
//!   without validating it is a legal Unicode scalar value first.
//!
//! A DETERMINISTIC, MINIMAL WITNESS for the second shape is captured below
//! (`known_crash_witness_yrs_char_decode_ub`) -- 41 bytes, reproducible on
//! this machine/toolchain/lockfile. It is marked `#[ignore]` so it never
//! runs as part of the required `cargo test --workspace` gate (an aborting
//! test process cannot be part of a required gate), but it stays in the
//! tree as a concrete, byte-exact regression target: `cargo test -p
//! dohc-fuzz-targets --test ydoc_update -- --ignored` reproduces it.
//!
//! **This means, as of R14, NO random-byte fuzzing of `Ydoc::apply`/
//! `Ydoc::validate_update` can safely run in the required gate** -- any
//! entry point that reaches `Update::decode_v1` is equally exposed. This
//! file therefore contains only deterministic, known-valid round-trip
//! coverage plus the ignored crash witness; it does NOT claim "no panic /
//! bounded / fail-closed" for this surface the way `protocol_framing.rs`
//! and `replication_envelope.rs` do for theirs.
//!
//! **Severity and required follow-up (not fixed in this shard -- this is a
//! third-party dependency bug, not something `#![forbid(unsafe_code)]` in
//! OUR crates can patch, and reimplementing yrs's decoder as a pre-
//! validator is a much larger undertaking than this shard's scope):**
//! - In a **release** build these debug-only precondition checks are
//!   compiled out entirely -- the same malformed input would not abort, it
//!   would silently execute the underlying undefined behavior (out-of-bounds
//!   read/invalid-value construction), which is potentially WORSE than a
//!   clean crash.
//! - `Ydoc::apply` is the real-time ingestion path for `ydoc.apply` requests
//!   (`crates/dohc-workspace-engine/src/lib.rs::ydoc_apply`) and for
//!   replicated Y.Doc envelopes (`crates/dohc-engine-sync/src/ydoc_apply.rs`)
//!   -- both are remote/cross-process input surfaces once R13's shadow-only
//!   fence is lifted. **This MUST be resolved (upgrade `yrs`, add a
//!   pre-validation layer, or get an upstream fix) before any live/remote
//!   Y.Doc ingestion path is trusted with untrusted input** -- exactly the
//!   scenario the plan's "cutover-blocking" fuzz priority exists to catch.

use dohc_engine_collab::ydoc::Ydoc;

/// Deterministic, byte-exact regression witness for the `char`-decode UB
/// abort described above. `#[ignore]`d because running it aborts the whole
/// test process by design -- that IS the finding. Run explicitly with
/// `cargo test -p dohc-fuzz-targets --test ydoc_update -- --ignored` to
/// reproduce, e.g. after attempting a fix (an upgraded `yrs`, or added
/// pre-validation) to confirm it no longer aborts.
#[test]
#[ignore = "known yrs 0.27.3 UB abort (unsafe precondition violated: invalid value for char) -- see the module doc comment. Aborts the process by design; must never run in the default/required suite."]
fn known_crash_witness_yrs_char_decode_ub() {
    let bytes: [u8; 41] = [
        0x0a, 0x06, 0x08, 0x94, 0x4b, 0x44, 0xa1, 0x2f, 0x63, 0x19, 0x03, 0x5f, 0xcb, 0xa3, 0xfc,
        0xb8, 0x5e, 0x48, 0xdd, 0xd4, 0xb4, 0xe5, 0x09, 0x27, 0x56, 0x51, 0xd9, 0xa8, 0xeb, 0x9f,
        0xf6, 0xfc, 0xae, 0x1d, 0xbd, 0x17, 0xee, 0x48, 0x42, 0xb4, 0x02,
    ];
    let doc = Ydoc::wire();
    // This call is expected to abort the process (UB precondition violation
    // inside yrs), not return an `Err`. If a fix lands, this line becomes a
    // normal `Err(MalformedUpdate)` (or, if yrs starts accepting it as
    // structurally valid, an `Ok(())`) instead of an abort -- flip this test
    // back to a normal (non-ignored) assertion at that point.
    let _ = doc.apply(&bytes);
}

/// Seed-corpus sanity: a real, valid update from the doc's own edit surface
/// applies cleanly and round-trips. Safe -- exercises only well-formed,
/// self-produced update bytes, never adversarial ones.
#[test]
fn seed_valid_update_applies_and_round_trips() {
    let doc = Ydoc::wire();
    let update = doc.plaintext_insert(0, "hello fuzz seed");
    Ydoc::validate_update(&update).expect("seed update validates");
    let target = Ydoc::wire();
    target.apply(&update).expect("seed update applies");
    assert_eq!(target.plaintext_string(), "hello fuzz seed");
}

/// Seed-corpus sanity: the empty byte slice specifically is safe and
/// rejected cleanly (the shortest possible input; not part of the crash
/// class above, which needs a structurally-plausible near-valid encoding).
#[test]
fn seed_empty_bytes_are_rejected_without_crashing() {
    let doc = Ydoc::wire();
    assert!(doc.apply(&[]).is_err());
}

/// Seed-corpus sanity: multiple independently-produced valid updates from
/// different edit surfaces all apply and merge cleanly on one doc.
#[test]
fn seed_multiple_valid_updates_compose() {
    let doc = Ydoc::wire();
    doc.apply(&doc.frontmatter_set("title", "fuzz"))
        .expect("first");
    doc.apply(&doc.richdoc_append_paragraph("seed paragraph"))
        .expect("second");
    assert_eq!(doc.frontmatter_json()["title"], "fuzz");
}
