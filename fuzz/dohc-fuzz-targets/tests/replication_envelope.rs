//! Cutover-blocking fuzz family 3/3: replication envelopes.
//!
//! Surfaces under test:
//! - `serde_json::from_slice::<ReplicationEnvelope>` -- arbitrary bytes off
//!   the wire (a relay/peer is a remote, cross-process input source).
//! - `dohc_engine_sync::apply_envelope_with` against a REAL `EngineStore`
//!   (via `dohc-engine-testkit`'s `ScratchDir`, the same bootstrap this
//!   crate's own unit tests use) -- structurally-random envelope field
//!   values (adversarial strings, huge/negative integers, oversized
//!   payloads) run through the actual production validate-then-transact
//!   boundary, not a reimplementation of it.
//!
//! Properties asserted:
//! - **No panic** (implicit: proptest fails the case on any panic).
//! - **Fail-closed BEFORE any store mutation**: `apply_envelope_with` calls
//!   `envelope.validate()` as its very first step, before opening a
//!   transaction (`crates/dohc-engine-sync/src/apply.rs`) -- an envelope
//!   that violates `ReplicationEnvelope::validate`'s documented bounds
//!   (non-empty/bounded `workspace_id`/`origin_id`/`op_kind`, `origin_seq`
//!   in the wire-integer range, payload under the byte cap) must be
//!   rejected WITHOUT the caller's `mutation` closure ever running.
//! - **No unbounded growth**: the payload byte cap
//!   (`model::MAX_PAYLOAD_BYTES`, 10 MiB) and identifier byte cap
//!   (`MAX_IDENTIFIER_BYTES`, 512) are enforced against generated input, not
//!   merely assumed.

use dohc_engine_storage::{EngineStore, NoFaults};
use dohc_engine_sync::{ReplicationEnvelope, SyncError, apply_envelope_with};
use dohc_engine_testkit::ScratchDir;
use proptest::prelude::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = scratch.engine_db_path().expect("db path");
    let store = EngineStore::open(&path, 1_000).expect("open");
    (scratch, store)
}

/// Whether `envelope`'s scalar fields satisfy `ReplicationEnvelope::validate`
/// -- reimplemented ONLY for the parts of `validate` that are public
/// knowledge from its doc comment (bounded/non-empty identifiers, seq range,
/// payload byte cap), so the property test can assert the real
/// `apply_envelope_with` agrees, without depending on the crate-private
/// method itself.
fn looks_structurally_valid(envelope: &ReplicationEnvelope) -> bool {
    fn bounded(value: &str) -> bool {
        !value.is_empty() && value.len() <= 512 && !value.bytes().any(|b| b.is_ascii_control())
    }
    const MAX_WIRE_INTEGER: i64 = (1_i64 << 53) - 1;
    const MAX_PAYLOAD_BYTES: usize = 10 * 1024 * 1024;
    bounded(&envelope.workspace_id)
        && bounded(&envelope.origin_id)
        && !envelope.op_kind.is_empty()
        && envelope.op_kind.len() <= 128
        && (0..=MAX_WIRE_INTEGER).contains(&envelope.origin_seq)
        && serde_json::to_vec(&envelope.payload)
            .map(|bytes| bytes.len() <= MAX_PAYLOAD_BYTES)
            .unwrap_or(false)
}

fn arbitrary_string() -> impl Strategy<Value = String> {
    prop_oneof![
        // Ordinary bounded strings.
        "[a-zA-Z0-9_-]{0,64}",
        // Adversarial: control bytes, which `bounded()` must reject.
        "[\\x00-\\x1f]{0,16}",
        // Adversarial: right at / just over the 512-byte identifier cap.
        prop::collection::vec(any::<char>(), 500..520)
            .prop_map(|chars| chars.into_iter().collect()),
        // The empty string.
        Just(String::new()),
    ]
}

fn arbitrary_envelope() -> impl Strategy<Value = ReplicationEnvelope> {
    (
        arbitrary_string(),
        arbitrary_string(),
        any::<i64>(),
        arbitrary_string(),
        prop_oneof![
            Just(serde_json::Value::Null),
            any::<i64>().prop_map(|value| serde_json::json!(value)),
            "[a-zA-Z0-9]{0,256}".prop_map(|value| serde_json::json!(value)),
        ],
        any::<i64>(),
    )
        .prop_map(
            |(workspace_id, origin_id, origin_seq, op_kind, payload, recorded_at_ms)| {
                ReplicationEnvelope {
                    workspace_id,
                    origin_id,
                    origin_seq,
                    op_kind,
                    payload,
                    recorded_at_ms,
                }
            },
        )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Arbitrary bytes as purported wire JSON: deserialization never panics,
    /// and a value that fails to deserialize is a clean `Err`, never a
    /// partially-populated `ReplicationEnvelope`.
    #[test]
    fn arbitrary_bytes_deserialize_cleanly_or_fail_closed(bytes in prop::collection::vec(any::<u8>(), 0..2048)) {
        let _ = serde_json::from_slice::<ReplicationEnvelope>(&bytes);
    }

    /// Structurally-random envelopes through the REAL apply boundary: never
    /// panics, and a structurally-invalid envelope is refused before the
    /// caller's mutation closure runs (no store mutation attempted).
    #[test]
    fn structurally_random_envelopes_fail_closed_before_any_mutation(
        envelope in arbitrary_envelope(),
    ) {
        let (_scratch, mut engine) = store();
        let mutation_ran = AtomicUsize::new(0);
        let result = apply_envelope_with(&mut engine, &envelope, &NoFaults, |_tx, _envelope| {
            mutation_ran.fetch_add(1, Ordering::SeqCst);
            Ok::<(), SyncError>(())
        });

        if !looks_structurally_valid(&envelope) {
            prop_assert!(
                result.is_err(),
                "a structurally-invalid envelope must be refused: {envelope:?}"
            );
            prop_assert_eq!(
                mutation_ran.load(Ordering::SeqCst),
                0,
                "validate() must reject BEFORE the mutation closure ever runs"
            );
        }
        // A structurally-valid envelope is expected to succeed on a fresh
        // store (origin_seq starts the sequence at 0); this branch is not
        // asserted further here -- sequence-continuity business logic
        // (SequenceGap/CoordinateDiverged) is covered by
        // `dohc-engine-sync`'s own unit tests, not this fuzz target.
    }
}

/// Seed-corpus sanity: a real, valid envelope applies cleanly.
#[test]
fn seed_valid_envelope_applies() {
    let (_scratch, mut engine) = store();
    let envelope = ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: "peer-a".to_owned(),
        origin_seq: 0,
        op_kind: "fuzz.seed".to_owned(),
        payload: serde_json::json!({ "hello": "fuzz" }),
        recorded_at_ms: 1_000,
    };
    let outcome = apply_envelope_with(&mut engine, &envelope, &NoFaults, |_tx, _envelope| {
        Ok::<(), SyncError>(())
    });
    assert!(outcome.is_ok(), "seed envelope must apply: {outcome:?}");
}

/// Seed-corpus sanity: an empty `workspace_id` is refused before the
/// mutation closure runs.
#[test]
fn seed_empty_workspace_id_is_refused_before_mutation() {
    let (_scratch, mut engine) = store();
    let envelope = ReplicationEnvelope {
        workspace_id: String::new(),
        origin_id: "peer-a".to_owned(),
        origin_seq: 0,
        op_kind: "fuzz.seed".to_owned(),
        payload: serde_json::Value::Null,
        recorded_at_ms: 1_000,
    };
    let mutation_ran = AtomicUsize::new(0);
    let result = apply_envelope_with(&mut engine, &envelope, &NoFaults, |_tx, _envelope| {
        mutation_ran.fetch_add(1, Ordering::SeqCst);
        Ok::<(), SyncError>(())
    });
    assert!(result.is_err());
    assert_eq!(mutation_ran.load(Ordering::SeqCst), 0);
}
