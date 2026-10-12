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
//! - Valid secret puts reach storage; single-field mutations fail at the
//!   intended metadata/blob check without writing secret tips or moments.
//! - Serialized payloads at the relay byte cap apply; one byte over is
//!   refused before the mutation callback, including escaped JSON strings.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use dohc_engine_domain::{MAX_SECRET_FILE_BYTES, SECRET_IV_BYTES, SECRET_TAG_BYTES};
use dohc_engine_storage::{EngineStore, NoFaults, StorageError, TxnOutcome};
use dohc_engine_sync::{
    ApplyDisposition, ApplyOutcome, MAX_PAYLOAD_JSON_BYTES, MAX_WIRE_INTEGER, ReplicationEnvelope,
    SyncError, apply_envelope_with, apply_secret_envelope,
};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use proptest::prelude::*;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};

fn store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = engine_db_path(&scratch).expect("db path");
    let store = EngineStore::open(&path, 1_000).expect("open");
    (scratch, store)
}

fn copied_empty_store() -> (ScratchDir, EngineStore) {
    // Generated envelopes vary the input, not schema creation. Each case still
    // opens its own real database; only the closed, empty schema is shared.
    static IMAGE: OnceLock<Vec<u8>> = OnceLock::new();
    let bytes = IMAGE.get_or_init(|| {
        let (_scratch, engine) = store();
        let path = engine.database_path().to_path_buf();
        drop(engine);
        assert!(!path.with_file_name("engine.db-wal").exists());
        std::fs::read(path).expect("read closed empty database")
    });
    let scratch = ScratchDir::new().expect("scratch");
    let path = engine_db_path(&scratch).expect("db path");
    std::fs::write(&path, bytes).expect("copy empty database");
    let engine = EngineStore::open(&path, 1_000).expect("open copied database");
    (scratch, engine)
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
    bounded(&envelope.workspace_id)
        && bounded(&envelope.origin_id)
        && !envelope.op_kind.is_empty()
        && envelope.op_kind.len() <= 128
        && (0..=MAX_WIRE_INTEGER).contains(&envelope.origin_seq)
        && envelope
            .relay_seq
            .is_none_or(|value| (0..=MAX_WIRE_INTEGER).contains(&value))
        && serde_json::to_vec(&envelope.payload)
            .map(|bytes| bytes.len() <= MAX_PAYLOAD_JSON_BYTES)
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
        prop_oneof![Just(0i64), 1i64..=MAX_WIRE_INTEGER, any::<i64>()],
        prop::option::of(any::<i64>()),
        arbitrary_string(),
        prop_oneof![
            Just(serde_json::Value::Null),
            any::<i64>().prop_map(|value| serde_json::json!(value)),
            "[a-zA-Z0-9]{0,256}".prop_map(|value| serde_json::json!(value)),
        ],
        any::<i64>(),
    )
        .prop_map(
            |(workspace_id, origin_id, origin_seq, relay_seq, op_kind, payload, recorded_at_ms)| {
                ReplicationEnvelope {
                    settlement_admission: None,
                    admitted_author_snapshot: None,
                    workspace_id,
                    origin_id,
                    origin_seq,
                    relay_seq,
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
        prop::option::of(any::<i64>()),
        secret_op_kind(),
        arbitrary_secret_payload(),
        any::<i64>(),
    )
        .prop_map(
            |(workspace_id, origin_id, origin_seq, relay_seq, op_kind, payload, recorded_at_ms)| {
                ReplicationEnvelope {
                    settlement_admission: None,
                    admitted_author_snapshot: None,
                    workspace_id,
                    origin_id,
                    origin_seq,
                    relay_seq,
                    op_kind,
                    payload,
                    recorded_at_ms,
                }
            },
        )
}

fn valid_envelope(payload: serde_json::Value) -> ReplicationEnvelope {
    ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".to_owned(),
        origin_id: "peer-a".to_owned(),
        origin_seq: 0,
        relay_seq: None,
        op_kind: "fuzz.seed".to_owned(),
        payload,
        recorded_at_ms: 1_000,
    }
}

fn secret_fixture(
    ciphertext: &[u8],
    iv: &[u8; SECRET_IV_BYTES],
    tag: &[u8; SECRET_TAG_BYTES],
) -> (ScratchDir, EngineStore, ReplicationEnvelope) {
    let (scratch, mut engine) = copied_empty_store();
    let seeded = engine
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "INSERT INTO versioned_workspaces (workspace_id, main_version_id) VALUES ('ws','v1')",
                [],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO versions (workspace_id, version_id, kind, name, created_at_ms) VALUES ('ws','v1','main','Main',1)",
                [],
            )
            .map_err(StorageError::persist_public)?;
            Ok(())
        })
        .expect("seed target version");
    assert_eq!(seeded, TxnOutcome::Committed(()));
    let sha = engine
        .put_binary_blob(ciphertext)
        .expect("hydrate ciphertext");
    let mut envelope = valid_envelope(serde_json::json!({
        "versionId": "v1",
        "path": "app/.env",
        "metadata": { "origin": "sync" },
        "ivBase64": STANDARD.encode(iv),
        "authTagBase64": STANDARD.encode(tag),
        "ciphertextSha256": sha,
        "byteLength": ciphertext.len(),
    }));
    envelope.op_kind = "secret.file.put".to_owned();
    (scratch, engine, envelope)
}

fn assert_secret_applies(
    engine: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    ciphertext: &[u8],
) {
    let outcome = apply_secret_envelope(engine, envelope, &NoFaults).expect("valid secret put");
    assert_eq!(outcome, ApplyOutcome::new(ApplyDisposition::Applied(())));
    let tip: (String, String, String, i64) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT iv_base64,auth_tag_base64,ciphertext_base64,byte_length FROM secret_files \
                 WHERE workspace_id='ws' AND version_id='v1' AND path='app/.env'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
        })
        .expect("read applied tip");
    assert_eq!(tip.0, envelope.payload["ivBase64"].as_str().unwrap());
    assert_eq!(tip.1, envelope.payload["authTagBase64"].as_str().unwrap());
    assert_eq!(tip.2, STANDARD.encode(ciphertext));
    assert_eq!(tip.3, ciphertext.len() as i64);
    assert_eq!(
        apply_secret_envelope(engine, envelope, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Skipped,
        "redelivery must preserve the applied tip"
    );
}

#[derive(Clone, Copy, Debug)]
enum SecretMutation {
    IvEncoding,
    IvLength,
    TagEncoding,
    TagLength,
    MissingHash,
    BlobIntegrity,
    DeclaredLength,
    NegativeLength,
    OversizedLength,
}

const SECRET_MUTATIONS: [SecretMutation; 9] = [
    SecretMutation::IvEncoding,
    SecretMutation::IvLength,
    SecretMutation::TagEncoding,
    SecretMutation::TagLength,
    SecretMutation::MissingHash,
    SecretMutation::BlobIntegrity,
    SecretMutation::DeclaredLength,
    SecretMutation::NegativeLength,
    SecretMutation::OversizedLength,
];

fn assert_secret_mutation_refused(
    ciphertext: &[u8],
    iv: &[u8; SECRET_IV_BYTES],
    tag: &[u8; SECRET_TAG_BYTES],
    mutation: SecretMutation,
) {
    let (_scratch, mut engine, mut envelope) = secret_fixture(ciphertext, iv, tag);
    let expected_reason = match mutation {
        SecretMutation::IvEncoding => {
            envelope.payload["ivBase64"] = serde_json::json!("!");
            Some("secret iv is invalid")
        }
        SecretMutation::IvLength => {
            envelope.payload["ivBase64"] = serde_json::json!(STANDARD.encode(&iv[..iv.len() - 1]));
            Some("secret ciphertext metadata is invalid")
        }
        SecretMutation::TagEncoding => {
            envelope.payload["authTagBase64"] = serde_json::json!("!");
            Some("secret auth tag is invalid")
        }
        SecretMutation::TagLength => {
            envelope.payload["authTagBase64"] =
                serde_json::json!(STANDARD.encode(&tag[..tag.len() - 1]));
            Some("secret ciphertext metadata is invalid")
        }
        SecretMutation::MissingHash => {
            let mut sha = envelope.payload["ciphertextSha256"]
                .as_str()
                .unwrap()
                .to_owned();
            sha.replace_range(..1, if sha.starts_with('0') { "1" } else { "0" });
            envelope.payload["ciphertextSha256"] = serde_json::json!(sha);
            None
        }
        SecretMutation::BlobIntegrity => {
            // Keep the valid address and byte count; only stored bytes change.
            let sha = envelope.payload["ciphertextSha256"].as_str().unwrap();
            let mut corrupted = ciphertext.to_vec();
            corrupted[0] ^= 1;
            assert_eq!(
                engine
                    .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
                        tx.execute(
                            "UPDATE binary_blobs SET bytes=?1 WHERE sha256=?2",
                            (&corrupted, sha),
                        )
                        .map_err(StorageError::persist_public)?;
                        Ok(())
                    })
                    .unwrap(),
                TxnOutcome::Committed(())
            );
            None
        }
        SecretMutation::DeclaredLength => {
            envelope.payload["byteLength"] = serde_json::json!(ciphertext.len() + 1);
            Some("secret ciphertext blob does not match declared metadata")
        }
        SecretMutation::NegativeLength => {
            envelope.payload["byteLength"] = serde_json::json!(-1);
            Some("secret ciphertext metadata is invalid")
        }
        SecretMutation::OversizedLength => {
            envelope.payload["byteLength"] = serde_json::json!(MAX_SECRET_FILE_BYTES + 1);
            Some("secret ciphertext metadata is invalid")
        }
    };
    let result = apply_secret_envelope(&mut engine, &envelope, &NoFaults);
    if let Some(reason) = expected_reason {
        let outcome = result.expect("invalid metadata is recorded as a refusal");
        let ApplyDisposition::Refused(refusal) = outcome.primary else {
            panic!("{mutation:?} did not reach its intended refusal: {outcome:?}");
        };
        assert_eq!(refusal.reason.message(), reason, "{mutation:?}");
    } else {
        match mutation {
            SecretMutation::MissingHash => assert!(matches!(result, Err(SyncError::BlobInvalid))),
            SecretMutation::BlobIntegrity => assert!(matches!(
                result,
                Err(SyncError::Storage(StorageError::BlobIntegrity { .. }))
            )),
            _ => unreachable!(),
        }
    }
    let counts: (i64, i64) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM secret_files), (SELECT COUNT(*) FROM secret_moments)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(counts, (0, 0), "{mutation:?} must not write secret state");
}

#[test]
fn secret_mutations_reach_their_intended_validation() {
    let (_scratch, mut engine, envelope) =
        secret_fixture(b"ciphertext", &[1; SECRET_IV_BYTES], &[2; SECRET_TAG_BYTES]);
    assert_secret_applies(&mut engine, &envelope, b"ciphertext");
    for mutation in SECRET_MUTATIONS {
        assert_secret_mutation_refused(
            b"ciphertext",
            &[1; SECRET_IV_BYTES],
            &[2; SECRET_TAG_BYTES],
            mutation,
        );
    }
}

#[test]
fn serialized_payload_boundary_is_enforced_before_mutation() {
    // Both ordinary and escape-heavy strings have exact serialized sizes.
    for unit in ["x", "\u{0000}", "界"] {
        for bytes in [
            MAX_PAYLOAD_JSON_BYTES - 1,
            MAX_PAYLOAD_JSON_BYTES,
            MAX_PAYLOAD_JSON_BYTES + 1,
        ] {
            let unit_bytes = serde_json::to_vec(unit).unwrap().len() - 2;
            let body_bytes = bytes - 2;
            let text = format!(
                "{}{}",
                unit.repeat(body_bytes / unit_bytes),
                "x".repeat(body_bytes % unit_bytes)
            );
            let envelope = valid_envelope(serde_json::json!(text));
            assert_eq!(serde_json::to_vec(&envelope.payload).unwrap().len(), bytes);
            let (_scratch, mut engine) = copied_empty_store();
            let calls = AtomicUsize::new(0);
            let result = apply_envelope_with(&mut engine, &envelope, &NoFaults, |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok::<(), SyncError>(())
            });
            if bytes <= MAX_PAYLOAD_JSON_BYTES {
                assert_eq!(result.unwrap().primary, ApplyDisposition::Applied(()));
                assert_eq!(calls.load(Ordering::SeqCst), 1);
            } else {
                assert!(matches!(
                    result,
                    Err(SyncError::InvalidInput {
                        reason: "payload exceeds the relay limit"
                    })
                ));
                assert_eq!(calls.load(Ordering::SeqCst), 0);
            }
        }
    }
}

proptest! {
    // `ProptestConfig::default()` is 256 cases and honors the standard
    // `PROPTEST_CASES` env var; `with_cases(256)` pinned it and silently
    // ignored the env var, so evidence runs asking for a large corpus got 256.
    #![proptest_config(ProptestConfig::default())]

    #[test]
    fn valid_envelopes_invoke_mutation_once_and_redelivery_skips(
        workspace_id in "[a-zA-Z0-9_-]{1,64}",
        origin_id in "[a-zA-Z0-9_-]{1,64}",
        payload in prop::collection::vec(any::<char>(), 0..256),
    ) {
        let mut envelope = valid_envelope(serde_json::json!(payload.into_iter().collect::<String>()));
        envelope.workspace_id = workspace_id;
        envelope.origin_id = origin_id;
        let (_scratch, mut engine) = copied_empty_store();
        let calls = AtomicUsize::new(0);
        for expected in [ApplyDisposition::Applied(()), ApplyDisposition::Skipped] {
            let outcome = apply_envelope_with(&mut engine, &envelope, &NoFaults, |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok::<(), SyncError>(())
            }).unwrap();
            prop_assert_eq!(outcome.primary, expected);
            prop_assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn valid_secret_puts_apply_and_single_mutations_refuse(
        ciphertext in prop::collection::vec(any::<u8>(), 1..128),
        iv in any::<[u8; SECRET_IV_BYTES]>(),
        tag in any::<[u8; SECRET_TAG_BYTES]>(),
        mutation in prop::sample::select(SECRET_MUTATIONS.to_vec()),
    ) {
        let (_scratch, mut engine, envelope) = secret_fixture(&ciphertext, &iv, &tag);
        assert_secret_applies(&mut engine, &envelope, &ciphertext);
        assert_secret_mutation_refused(&ciphertext, &iv, &tag, mutation);
    }

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
        let (_scratch, mut engine) = copied_empty_store();
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
        else if envelope.origin_seq == 0 {
            prop_assert_eq!(result.unwrap().primary, ApplyDisposition::Applied(()));
            prop_assert_eq!(mutation_ran.load(Ordering::SeqCst), 1);
        } else {
            prop_assert!(matches!(result, Err(SyncError::SequenceGap)));
            prop_assert_eq!(mutation_ran.load(Ordering::SeqCst), 0);
        }
    }

    /// 4th untrusted surface: encrypted secret replication envelopes through
    /// `apply_secret_envelope`. Never panics; against a fresh store with NO
    /// prior version state, no random secret envelope may reach
    /// `ApplyDisposition::Applied` (an `Err`, or a no-op `Skipped`, is fine --
    /// neither writes a durable secret).
    #[test]
    fn structurally_random_secret_envelopes_never_apply(
        envelope in arbitrary_secret_envelope(),
    ) {
        let (_scratch, mut engine) = copied_empty_store();
        let result = apply_secret_envelope(&mut engine, &envelope, &NoFaults);
        prop_assert!(
            !matches!(result, Ok(ApplyOutcome { primary: ApplyDisposition::Applied(()), .. })),
            "an untrusted secret envelope must never apply against a store with no prior state: {envelope:?} -> {result:?}"
        );
    }
}

#[test]
fn copied_stores_apply_independently_and_keep_commits_after_reopen() {
    let (_first_scratch, mut first) = copied_empty_store();
    let (_second_scratch, mut second) = copied_empty_store();
    let envelope = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".to_owned(),
        origin_id: "peer-a".to_owned(),
        origin_seq: 0,
        relay_seq: None,
        op_kind: "fuzz.seed".to_owned(),
        payload: serde_json::json!({ "hello": "fuzz" }),
        recorded_at_ms: 1_000,
    };
    for engine in [&mut first, &mut second] {
        let outcome = apply_envelope_with(engine, &envelope, &NoFaults, |_tx, _envelope| {
            Ok::<(), SyncError>(())
        })
        .expect("apply to an independent empty store");
        assert!(matches!(outcome.primary, ApplyDisposition::Applied(())));
    }
    let path = first.database_path().to_path_buf();
    drop(first);
    let mut reopened = EngineStore::open(&path, 1_001).expect("reopen committed store");
    let replay: ApplyOutcome<()> =
        apply_envelope_with(&mut reopened, &envelope, &NoFaults, |_tx, _envelope| {
            panic!("a committed coordinate must not run its mutation again")
        })
        .expect("replay committed envelope");
    assert!(matches!(replay.primary, ApplyDisposition::Skipped));
}

/// Seed-corpus sanity: a real, valid envelope applies cleanly.
#[test]
fn seed_valid_envelope_applies() {
    let (_scratch, mut engine) = store();
    let envelope = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".to_owned(),
        origin_id: "peer-a".to_owned(),
        origin_seq: 0,
        relay_seq: None,
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
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".to_owned(),
        origin_id: "peer-a".to_owned(),
        origin_seq: 1,
        relay_seq: None,
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
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: String::new(),
        origin_id: "peer-a".to_owned(),
        origin_seq: 0,
        relay_seq: None,
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
