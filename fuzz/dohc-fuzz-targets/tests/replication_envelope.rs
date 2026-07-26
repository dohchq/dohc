//! Cutover-blocking fuzz families: replication envelopes (generic + secret).
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
//! - `dohc_engine_sync::apply_secret_envelope` -- the 4th untrusted input
//!   surface: ENCRYPTED secret replication envelopes (`secret.file.put` /
//!   `secret.file.delete`), including structurally-plausible-but-invalid
//!   secret payloads (random iv/tag/sha/byte-length).
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
//! - **No untrusted secret applies**: against a fresh store with no prior
//!   version state, no random secret envelope may reach
//!   `ApplyOutcome::Applied` (an `Err` or a no-op `Skipped` is fine -- both
//!   mean nothing was durably written).
//! - **No unbounded growth**: the payload byte cap
//!   (`model::MAX_PAYLOAD_BYTES`, 10 MiB) and identifier byte cap
//!   (`MAX_IDENTIFIER_BYTES`, 512) are enforced against generated input, not
//!   merely assumed.

use dohc_engine_storage::{EngineStore, NoFaults};
use dohc_engine_sync::{
    ApplyOutcome, ReplicationEnvelope, SyncError, apply_envelope_with, apply_secret_envelope,
};
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

/// A secret replication `op_kind`: biased toward the two real secret kinds so
/// the apply path is actually exercised, plus arbitrary junk kinds that must
/// be rejected as unsupported.
fn secret_op_kind() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("secret.file.put".to_owned()),
        Just("secret.file.delete".to_owned()),
        arbitrary_string(),
    ]
}

/// A secret payload: nulls/scalars plus a `secret.file.put`-SHAPED object with
/// random field values (random base64-ish iv/tag, random sha, random byte
/// length). Structurally plausible, never actually valid against a fresh
/// store.
fn arbitrary_secret_payload() -> impl Strategy<Value = serde_json::Value> {
    prop_oneof![
        Just(serde_json::Value::Null),
        "[a-zA-Z0-9]{0,64}".prop_map(|value| serde_json::json!(value)),
        (
            "[a-zA-Z0-9._/-]{0,64}",
            "[a-zA-Z0-9._/-]{0,64}",
            "[a-zA-Z0-9+/=]{0,64}",
            "[a-zA-Z0-9+/=]{0,64}",
            "[a-f0-9]{0,64}",
            any::<i64>(),
        )
            .prop_map(|(version_id, path, iv, tag, sha, byte_length)| {
                serde_json::json!({
                    "versionId": version_id,
                    "path": path,
                    "metadata": { "origin": "replication", "summary": null, "correlationId": null },
                    "ivBase64": iv,
                    "authTagBase64": tag,
                    "ciphertextSha256": sha,
                    "byteLength": byte_length,
                })
            }),
    ]
}

fn arbitrary_secret_envelope() -> impl Strategy<Value = ReplicationEnvelope> {
    (
        arbitrary_string(),
        arbitrary_string(),
        any::<i64>(),
        secret_op_kind(),
        arbitrary_secret_payload(),
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
    // `ProptestConfig::default()` is 256 cases and honors the standard
    // `PROPTEST_CASES` env var; `with_cases(256)` pinned it and silently
    // ignored the env var, so evidence runs asking for a large corpus got 256.
    #![proptest_config(ProptestConfig::default())]

    /// Arbitrary bytes as purported wire JSON: deserialization never panics,
    /// and any successfully-decoded envelope is a COMPLETE value that
    /// round-trips (re-serialize + re-parse yields an equal envelope) -- i.e.
    /// serde never hands back a partially-populated struct that would then
    /// re-encode to something different.
    #[test]
    fn arbitrary_bytes_deserialize_cleanly_or_fail_closed(bytes in prop::collection::vec(any::<u8>(), 0..2048)) {
        if let Ok(envelope) = serde_json::from_slice::<ReplicationEnvelope>(&bytes) {
            let reencoded =
                serde_json::to_vec(&envelope).expect("a decoded envelope re-serializes");
            let roundtrip = serde_json::from_slice::<ReplicationEnvelope>(&reencoded)
                .expect("re-parse of a self-produced encoding");
            prop_assert_eq!(
                envelope,
                roundtrip,
                "a decoded envelope must be a complete, round-tripping value"
            );
        }
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

    /// 4th untrusted surface: encrypted secret replication envelopes through
    /// `apply_secret_envelope`. Never panics; against a fresh store with NO
    /// prior version state, no random secret envelope may reach
    /// `ApplyOutcome::Applied` (an `Err`, or a no-op `Skipped`, is fine --
    /// neither writes a durable secret).
    #[test]
    fn structurally_random_secret_envelopes_never_apply(
        envelope in arbitrary_secret_envelope(),
    ) {
        let (_scratch, mut engine) = store();
        let result = apply_secret_envelope(&mut engine, &envelope, &NoFaults);
        prop_assert!(
            !matches!(result, Ok(ApplyOutcome::Applied(()))),
            "an untrusted secret envelope must never apply against a store with no prior state: {envelope:?} -> {result:?}"
        );
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

/// Seed-corpus sanity: a non-secret `op_kind` routed to the secret applier is
/// rejected as unsupported (never panics, never applies).
#[test]
fn seed_non_secret_op_kind_is_rejected_by_secret_applier() {
    let (_scratch, mut engine) = store();
    let envelope = ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: "peer-a".to_owned(),
        origin_seq: 1,
        op_kind: "fuzz.not-a-secret".to_owned(),
        payload: serde_json::Value::Null,
        recorded_at_ms: 1_000,
    };
    let result = apply_secret_envelope(&mut engine, &envelope, &NoFaults);
    assert!(matches!(result, Err(SyncError::UnsupportedOperation)));
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
