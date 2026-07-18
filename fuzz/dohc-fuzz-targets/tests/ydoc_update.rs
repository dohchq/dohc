//! Cutover-blocking fuzz family 2/3: Y.Doc update ingestion.
//!
//! Surface under test: `dohc_engine_collab::ydoc::Ydoc::apply` /
//! `Ydoc::validate_update` -- the entry point for an arbitrary byte payload
//! purporting to be a Yjs v1 CRDT update.
//!
//! # YRS-ABORT-SAFETY: the R14 hard-abort is closed (was: CRITICAL FINDING)
//!
//! R14's seeded property-based fuzzing (`StdRng::seed_from_u64(42)`, uniform
//! random byte vectors 0..64 bytes) found that yrs 0.27.3's `Update::decode_v1`
//! (called identically by both `Ydoc::apply` and `Ydoc::validate_update`) could
//! be driven into Rust's debug-mode "unsafe precondition violated" checker,
//! which **aborted the whole process** (`STATUS_STACK_BUFFER_OVERRUN` on
//! Windows) rather than unwinding -- `std::panic::catch_unwind` cannot catch
//! this. Root cause (confirmed by reading yrs 0.27.3's source,
//! `encoding/read.rs`'s default `Read::read_string`): every string-bearing v1
//! decode (`Any::decode`, `Decoder::read_key`/`read_json`, `TypeRef::decode`'s
//! XML tag, `Options::decode`'s guid) casts raw length-prefixed bytes straight
//! to `&str` via `std::str::from_utf8_unchecked`, WITHOUT validating them.
//! Malformed bytes produce a `&str` that violates Rust's UTF-8 invariant; the
//! first `.chars()` iteration over it can synthesize an out-of-range/surrogate
//! `u32` and hand it to an unchecked `char` construction -- UB, uncatchable.
//!
//! The fix: `dohc_engine_collab::replay_parity::scan_v1` (already used for the
//! replay-parity gate) is a from-scratch manual walk of the v1 wire that NEVER
//! calls `Update::decode_v1` and NEVER uses yrs' own unsafe string decode --
//! every string-bearing field is read via `read_buf` (safe, bounds-checked)
//! and validated with the CHECKED `std::str::from_utf8` (which by construction
//! can never accept a surrogate or out-of-range scalar). `Ydoc::apply` and
//! `Ydoc::validate_update` -- the ONLY two call sites of `Update::decode_v1` in
//! the crate -- now run this pre-validator FIRST, so malformed/adversarial
//! bytes are rejected fail-closed, before `decode_v1` (or anything else
//! unsafe) ever sees them. The durable choke point
//! (`durable::validate_update_bytes`, shared by the local edit path and the
//! remote replication path) also runs it explicitly as a second, redundant
//! guard at the policy layer.
//!
//! The deterministic 41-byte witness below now returns a clean `Err` and the
//! process survives -- see `known_crash_witness_yrs_char_decode_ub`, no longer
//! `#[ignore]`d. The broad property tests further down replay the same random-
//! byte search R14 used (uniform bytes, 0..128 length); the fact that a
//! proptest run COMPLETES (an abort would kill the whole test process, not
//! just fail one case) is itself the "no abort on a random corpus" evidence.
//! The gate runs them at the default case count; the shard's evidence run
//! scaled them to 20,000 cases per property via `PROPTEST_CASES`.

use dohc_engine_collab::ydoc::Ydoc;
use proptest::prelude::*;

/// Deterministic, byte-exact regression witness for the yrs 0.27.3 `char`-
/// decode UB abort described above. Was `#[ignore]`d because running it used
/// to abort the whole test process by design; now that the pre-validator
/// guards `Ydoc::apply`, this is an ordinary passing test: a clean `Err`, not
/// an abort. Kept byte-exact as a permanent regression pin.
#[test]
fn known_crash_witness_yrs_char_decode_ub() {
    let bytes: [u8; 41] = [
        0x0a, 0x06, 0x08, 0x94, 0x4b, 0x44, 0xa1, 0x2f, 0x63, 0x19, 0x03, 0x5f, 0xcb, 0xa3, 0xfc,
        0xb8, 0x5e, 0x48, 0xdd, 0xd4, 0xb4, 0xe5, 0x09, 0x27, 0x56, 0x51, 0xd9, 0xa8, 0xeb, 0x9f,
        0xf6, 0xfc, 0xae, 0x1d, 0xbd, 0x17, 0xee, 0x48, 0x42, 0xb4, 0x02,
    ];
    let doc = Ydoc::wire();
    // Previously: this call aborted the process (UB precondition violation
    // inside yrs). Now: the pre-validator rejects the malformed bytes before
    // `Update::decode_v1` ever runs -- a clean, fail-closed `Err`, and the
    // process survives to make (and pass) this assertion.
    let result = doc.apply(&bytes);
    assert!(
        result.is_err(),
        "the known UB-triggering witness must be rejected fail-closed, not silently accepted"
    );
    // `Ydoc::validate_update` shares the exact same guard (it is the other of
    // the crate's two `Update::decode_v1` call sites) -- must agree.
    assert!(Ydoc::validate_update(&bytes).is_err());
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

proptest! {
    // Default case count (256, like `replication_envelope.rs`) so the required
    // `cargo test --workspace` gate stays fast; `ProptestConfig::default()`
    // honors the standard `PROPTEST_CASES` env var, which is how the
    // YRS-ABORT-SAFETY evidence run scaled this family to a 20,000-case
    // malformed corpus per property (recorded in the shard's PR/EXECUTION_LOG).
    #![proptest_config(ProptestConfig::default())]

    /// The R14 property under test, now actually provable: arbitrary bytes
    /// through `Ydoc::apply` NEVER abort the process. A random byte vector is
    /// either cleanly rejected (`Err`) or -- on the rare chance it happens to
    /// be a structurally valid update -- applies cleanly (`Ok`); either
    /// outcome is fine. What matters, and what this test's mere COMPLETION
    /// proves (an abort kills the whole binary, it does not fail one case),
    /// is that none of the generated cases reached yrs' uncatchable
    /// `Update::decode_v1` UB.
    #[test]
    fn arbitrary_bytes_never_abort_ydoc_apply(bytes in prop::collection::vec(any::<u8>(), 0..128)) {
        let doc = Ydoc::wire();
        let _ = doc.apply(&bytes);
    }

    /// Same property against `Ydoc::validate_update` (the crate's other, and
    /// only other, `Update::decode_v1` call site) -- it must agree with
    /// `apply` on accept/reject and never abort either.
    #[test]
    fn arbitrary_bytes_never_abort_validate_update(bytes in prop::collection::vec(any::<u8>(), 0..128)) {
        let doc = Ydoc::wire();
        let validated = Ydoc::validate_update(&bytes).is_ok();
        let applied = doc.apply(&bytes).is_ok();
        prop_assert_eq!(
            validated, applied,
            "validate_update and apply must agree on accept/reject for the same bytes"
        );
    }

    /// A denser search near the witness's own shape: near-valid updates built
    /// by taking a REAL valid update and flipping random bytes -- much more
    /// likely to reach deep into content decoding (string/JSON/embed/type/doc
    /// fields) than uniform random bytes, which mostly fail the earliest
    /// length checks. Never aborts; a mutated-but-still-valid update may
    /// legitimately still `Ok`.
    #[test]
    fn mutated_valid_updates_never_abort(
        mutations in prop::collection::vec((any::<usize>(), any::<u8>()), 0..12),
    ) {
        let seed_doc = Ydoc::wire();
        seed_doc.frontmatter_set("title", "mutation seed \u{1F600}");
        seed_doc.richdoc_append_paragraph("mutation seed paragraph \u{10437}");
        let mut bytes = seed_doc.encode_full_state();
        for (idx, value) in mutations {
            if bytes.is_empty() {
                break;
            }
            let at = idx % bytes.len();
            bytes[at] = value;
        }
        let doc = Ydoc::wire();
        let _ = doc.apply(&bytes);
    }
}
