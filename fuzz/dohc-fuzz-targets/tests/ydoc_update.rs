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
//! can never accept a surrogate or out-of-range scalar). `Ydoc::apply`,
//! `Ydoc::validate_update`, and `merge_updates` -- the crate's
//! `Update::decode_v1` call sites -- each run this pre-validator FIRST, so
//! malformed/adversarial bytes are rejected fail-closed, before `decode_v1`
//! (or anything else unsafe) ever sees them. `scan_v1` also bounds `Any`
//! container nesting (`MAX_ANY_DEPTH`) so a deeply-nested `ContentAny`/sub-doc
//! payload cannot overflow the stack (an uncatchable abort) inside the
//! validator or the downstream decode. The durable choke point
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

/// LEB128 unsigned varint, matching yrs' `write_var` wire encoding.
fn push_varint(out: &mut Vec<u8>, mut n: u64) {
    loop {
        let byte = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
}

/// Emit one v1-wire `Any` value driven by `script` (a proptest-random byte
/// tape), bounded at `depth`. This is deliberately structure-AWARE: it reaches
/// the exact fields uniform-random/byte-flip corpora almost never hit -- every
/// numeric variant (`i64`/`f32`/`f64`/`BigInt`), strings (including invalid
/// UTF-8, so the pre-validator's checked decode is exercised), and arbitrarily
/// nested `Array`/`Map`. A returned value is always a completely-consumable
/// `Any` on the wire, so the surrounding update stays structurally valid up to
/// the content payload.
fn emit_any(out: &mut Vec<u8>, script: &[u8], pos: &mut usize, depth: usize) {
    let tag = script.get(*pos).copied().unwrap_or(126);
    *pos += 1;
    // Past the depth budget, force a scalar so the value always terminates.
    let selector = if depth == 0 { tag % 8 } else { tag % 10 };
    match selector {
        0 => out.push(127), // Undefined
        1 => out.push(126), // Null
        2 => {
            out.push(125); // Number(i64 as f64)
            push_varint(out, next_u64(script, pos));
        }
        3 => {
            out.push(124); // Number(f32)
            out.extend_from_slice(&next_u32(script, pos).to_le_bytes());
        }
        4 => {
            out.push(123); // Number(f64)
            out.extend_from_slice(&next_u64(script, pos).to_le_bytes());
        }
        5 => {
            out.push(122); // BigInt(i64)
            out.extend_from_slice(&next_u64(script, pos).to_le_bytes());
        }
        6 => out.push(if next_u64(script, pos) & 1 == 0 { 121 } else { 120 }), // Bool
        7 => {
            out.push(119); // String -- length-prefixed raw bytes (maybe invalid UTF-8)
            let len = (script.get(*pos).copied().unwrap_or(0) % 6) as usize;
            *pos += 1;
            push_varint(out, len as u64);
            for _ in 0..len {
                out.push(script.get(*pos).copied().unwrap_or(0xff));
                *pos += 1;
            }
        }
        8 => {
            out.push(117); // Array
            let n = (script.get(*pos).copied().unwrap_or(0) % 4) as u64;
            *pos += 1;
            push_varint(out, n);
            for _ in 0..n {
                emit_any(out, script, pos, depth - 1);
            }
        }
        _ => {
            out.push(118); // Map
            let n = (script.get(*pos).copied().unwrap_or(0) % 4) as u64;
            *pos += 1;
            push_varint(out, n);
            for i in 0..n {
                // Key: a short ASCII string (always valid UTF-8).
                let key = [b'k', b'0' + (i as u8 % 10)];
                push_varint(out, key.len() as u64);
                out.extend_from_slice(&key);
                emit_any(out, script, pos, depth - 1);
            }
        }
    }
}

fn next_u64(script: &[u8], pos: &mut usize) -> u64 {
    let mut v = 0u64;
    for _ in 0..8 {
        v = (v << 8) | script.get(*pos).copied().unwrap_or(0) as u64;
        *pos += 1;
    }
    v
}

fn next_u32(script: &[u8], pos: &mut usize) -> u32 {
    let mut v = 0u32;
    for _ in 0..4 {
        v = (v << 8) | script.get(*pos).copied().unwrap_or(0) as u32;
        *pos += 1;
    }
    v
}

/// A valid v1 outer frame (1 client / 1 block / named root) wrapping a single
/// content block of `kind`, whose payload is generated by `emit_any` from
/// `script`. Covers `ContentAny` (kind 8) and `ContentDoc`/sub-document options
/// (kind 9 -- a guid string plus an options `Any`), the two content kinds
/// CodeRabbit flagged that random corpora almost never reach.
fn structured_update(kind: u8, script: &[u8], depth: usize) -> Vec<u8> {
    let mut out: Vec<u8> = vec![
        0x01, // clients_len
        0x01, // blocks_len
        0x09, // client
        0x00, // clock
        kind, // info == content ref (no origins, no parent-sub)
        0x01, // parent_info: named root follows
        0x01, b'r', // root name "r"
    ];
    let mut pos = 0usize;
    match kind {
        0x08 => {
            // ContentAny: a length-prefixed list of Any values.
            let n = (script.first().copied().unwrap_or(1) % 3 + 1) as u64;
            push_varint(&mut out, n);
            let mut p = 1usize;
            for _ in 0..n {
                emit_any(&mut out, script, &mut p, depth);
            }
            pos = p;
        }
        _ => {
            // ContentDoc: a guid string then an options Any (a map on the wire).
            let guid = b"guid";
            push_varint(&mut out, guid.len() as u64);
            out.extend_from_slice(guid);
            emit_any(&mut out, script, &mut pos, depth);
        }
    }
    let _ = pos;
    out.push(0x00); // empty delete set
    out
}

proptest! {
    // Default case count (256, like `replication_envelope.rs`) so the required
    // `cargo test --workspace` gate stays fast; `ProptestConfig::default()`
    // honors the standard `PROPTEST_CASES` env var, which is how the
    // YRS-ABORT-SAFETY evidence run scaled this family to a 20,000-case
    // malformed corpus per property (recorded in the shard's PR/EXECUTION_LOG).
    #![proptest_config(ProptestConfig::default())]

    /// Structure-aware never-abort: valid-outer-frame updates whose CONTENT is a
    /// generator-built `Any` reaching every numeric variant, (in)valid-UTF-8
    /// strings, deep nested arrays/maps, AND sub-document options -- exactly the
    /// parser-deep fields short random blobs and fixed byte-flips almost never
    /// reach. Either the pre-validator cleanly rejects it (`Err`) or -- when the
    /// whole frame happens to be structurally valid -- it applies (`Ok`); the
    /// only forbidden outcome is a process abort, which a completing run
    /// disproves.
    #[test]
    fn structured_content_never_aborts(
        kind_any in prop::bool::ANY,
        script in prop::collection::vec(any::<u8>(), 0..96),
        depth in 0usize..8,
    ) {
        let kind = if kind_any { 0x08 } else { 0x09 };
        let bytes = structured_update(kind, &script, depth);
        let doc = Ydoc::wire();
        // Exercise BOTH decode_v1 call sites. Their results may legitimately
        // differ -- `validate_update` only pre-validates + decodes, while
        // `apply` additionally integrates (`txn.apply_update`), which can `Err`
        // on a structurally-decodable but not-integratable update (e.g. a parent
        // id that resolves to a non-type item). The property under test is
        // never-abort, which the mere COMPLETION of both calls proves; the
        // accept/reject verdicts are deliberately NOT asserted equal.
        let _ = Ydoc::validate_update(&bytes);
        let _ = doc.apply(&bytes);
    }

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

    /// Same never-abort property against `Ydoc::validate_update` (another of
    /// the crate's `Update::decode_v1` call sites). It and `apply` may
    /// legitimately DISAGREE on accept/reject -- `validate_update` only decodes,
    /// `apply` also integrates and can `Err` on a decodable-but-not-integratable
    /// update -- so only the never-abort property (proven by completion) is
    /// exercised here, not verdict equality.
    #[test]
    fn arbitrary_bytes_never_abort_validate_update(bytes in prop::collection::vec(any::<u8>(), 0..128)) {
        let doc = Ydoc::wire();
        let _ = Ydoc::validate_update(&bytes);
        let _ = doc.apply(&bytes);
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

    /// A `ContentAny` block whose payload is an attacker-controlled chain of
    /// length-1 `Any::Array`s (2 bytes per level) must NEVER abort -- an
    /// unbounded decode recursion overflows the stack, which is uncatchable
    /// (not a Rust panic), the same severity class as the char-decode UB. The
    /// pre-validator's `MAX_ANY_DEPTH` bound rejects these fail-closed; this
    /// property proves it across a wide depth range including well past the
    /// bound. Uniform/mutation fuzzing never synthesizes multi-thousand-deep
    /// nesting, so this dedicated generator is what actually exercises the hole.
    #[test]
    fn nested_any_never_aborts(depth in 0usize..20_000) {
        // clients_len=1, blocks_len=1, client=9, clock=0,
        // info=0x08 (ContentAny), parent_info=1, root name "t", ContentAny len=1
        let mut bytes: Vec<u8> = vec![0x01, 0x01, 0x09, 0x00, 0x08, 0x01, 0x01, b't', 0x01];
        for _ in 0..depth {
            bytes.push(117); // Any::Array
            bytes.push(0x01); // len = 1
        }
        bytes.push(126); // innermost Any::Null
        bytes.push(0x00); // empty delete set
        let doc = Ydoc::wire();
        // Must return (Err beyond the bound, possibly Ok when shallow) -- never abort.
        let _ = doc.apply(&bytes);
    }
}
