//! Secret-file domain traces (R08): encrypted round-trip, the
//! plaintext-never-leaks scan, R04-pipeline materialization intent,
//! crash-injection at the secret-write boundary, tamper fail-closed, fork, and a
//! TS-written-ciphertext-decrypts-in-Rust cross-engine check.

use dohc_engine_crypto::{SecretDataKey, aead};
use dohc_engine_domain::{
    NoFaults, SecretDiskIntent, SecretFileStore, SecretOp, SecretWrite, VersionedTextStore,
};
use dohc_engine_storage::{EngineStore, FaultPoint};
use dohc_engine_testkit::harness::wal_sidecar;
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use rusqlite::params;
use std::path::Path;

const NO_FAULTS: NoFaults = NoFaults;
const WS: &str = "ws-secret";

fn key() -> SecretDataKey {
    SecretDataKey::from_bytes(&[0x11u8; 32]).expect("key")
}

fn seed_version(db: &Path, workspace: &str) {
    let mut store = EngineStore::open(db, 1).expect("open");
    let mut vt = VersionedTextStore::new(&mut store);
    vt.ensure_main_version(workspace, "main", 1, &NO_FAULTS)
        .expect("main");
}

fn write(
    store: &mut EngineStore,
    key: &SecretDataKey,
    path: &str,
    text: &str,
    moment_id: &str,
    now_ms: i64,
) -> dohc_engine_domain::SecretWriteResult {
    let mut secrets = SecretFileStore::new(store, key);
    secrets
        .write_secret_file(
            &SecretWrite {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: moment_id.to_owned(),
                metadata_origin: "local-file".to_owned(),
                metadata_summary: Some("Updated .env".to_owned()),
                metadata_correlation_id: None,
                now_ms,
                disk_intent: SecretDiskIntent::Materialize,
            },
            &NO_FAULTS,
        )
        .expect("write secret")
}

#[test]
fn secret_write_and_delete_refuse_non_secret_paths() {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.engine_db_path().unwrap();
    seed_version(&db, WS);
    let key = key();
    let mut store = EngineStore::open(&db, 2).unwrap();
    let mut secrets = SecretFileStore::new(&mut store, &key);

    let write_err = secrets
        .write_secret_file(
            &SecretWrite {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: "notes/ordinary.md".to_owned(),
                text: "not a secret route".to_owned(),
                moment_id: "sm-non-secret-write".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 10,
                disk_intent: SecretDiskIntent::Materialize,
            },
            &NO_FAULTS,
        )
        .expect_err("ordinary path must not enter the secret store");
    assert_eq!(write_err.code(), "not-secret-path");

    let delete_err = secrets
        .delete_secret_file(
            &dohc_engine_domain::SecretDelete {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: "notes/ordinary.md".to_owned(),
                moment_id: "sm-non-secret-delete".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                now_ms: 11,
            },
            &NO_FAULTS,
        )
        .expect_err("ordinary path delete must fail at the store door");
    assert_eq!(delete_err.code(), "not-secret-path");
}

#[test]
fn secret_write_debug_redacts_cleartext() {
    // The one secret-bearing input type must never spill plaintext through
    // Debug (tracing, format!, panic messages, error context).
    let w = SecretWrite {
        workspace_id: WS.to_owned(),
        version_id: "main".to_owned(),
        path: ".env".to_owned(),
        text: "PASSWORD=hunter2".to_owned(),
        moment_id: "sm1".to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        now_ms: 1,
        disk_intent: SecretDiskIntent::Materialize,
    };
    let rendered = format!("{w:?}");
    assert!(
        !rendered.contains("hunter2"),
        "Debug must not leak cleartext"
    );
    assert!(rendered.contains("<redacted, 16 bytes>"));
    // Non-secret fields remain visible for diagnosability.
    assert!(rendered.contains(".env"));
}

#[test]
fn round_trips_through_the_single_materialization_accessor() {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.engine_db_path().unwrap();
    seed_version(&db, WS);
    let key = key();

    let mut store = EngineStore::open(&db, 2).unwrap();
    let text = "API_KEY=sk-live-abc123\nDB=postgres://x\n";
    let result = write(&mut store, &key, ".env", text, "sm1", 10);
    assert!(result.changed);
    assert_eq!(result.moment.as_ref().unwrap().operation, SecretOp::Write);

    let secrets = SecretFileStore::new(&mut store, &key);
    let materialized = secrets
        .materialize_secret_file(WS, "main", ".env")
        .unwrap()
        .expect("present");
    assert_eq!(materialized.into_utf8().unwrap(), text);

    // A second identical write is a content-equality no-op.
    let again = write(&mut store, &key, ".env", text, "sm2", 11);
    assert!(!again.changed);
    assert!(again.moment.is_none());
}

#[test]
fn committed_write_retry_with_same_moment_id_is_idempotent_not_duplicate() {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.engine_db_path().unwrap();
    seed_version(&db, WS);
    let key = key();
    let mut store = EngineStore::open(&db, 2).unwrap();

    let text = "SECRET=v1";
    let first = write(&mut store, &key, ".env", text, "sm1", 10);
    assert!(first.changed);

    // Exactly-once retry: same moment_id + same text (a committed-but-not-acked
    // write re-driven). Desired-state-first makes this an idempotent no-op, NOT
    // a DuplicateMomentId error.
    let mut secrets = SecretFileStore::new(&mut store, &key);
    let retry = secrets
        .write_secret_file(
            &SecretWrite {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                text: text.to_owned(),
                moment_id: "sm1".to_owned(),
                metadata_origin: "local-file".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 11,
                disk_intent: SecretDiskIntent::Materialize,
            },
            &NO_FAULTS,
        )
        .expect("retry");
    assert!(!retry.changed, "committed retry is an idempotent no-op");

    // A genuine duplicate-id conflict (same id, DIFFERENT content) still fails.
    let conflict = secrets.write_secret_file(
        &SecretWrite {
            workspace_id: WS.to_owned(),
            version_id: "main".to_owned(),
            path: ".env".to_owned(),
            text: "SECRET=v2-different".to_owned(),
            moment_id: "sm1".to_owned(),
            metadata_origin: "local-file".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            now_ms: 12,
            disk_intent: SecretDiskIntent::Materialize,
        },
        &NO_FAULTS,
    );
    assert_eq!(conflict.unwrap_err().code(), "duplicate-moment-id");
}

#[test]
fn plaintext_never_leaks_into_engine_db_or_wal() {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.engine_db_path().unwrap();
    seed_version(&db, WS);
    let key = key();

    // A highly distinctive marker so any leak is unmistakable in a byte scan.
    let marker = "MARKER_2f9c1e7b_TOP_SECRET_VALUE";
    let text = format!("PASSWORD={marker}\nTOKEN={marker}-2\n");

    {
        let mut store = EngineStore::open(&db, 2).unwrap();
        write(&mut store, &key, ".env", &text, "sm1", 10);
        // Also list files + moments to exercise the metadata-only surfaces.
        let secrets = SecretFileStore::new(&mut store, &key);
        let stats = secrets.list_secret_files(WS, "main").unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].byte_length, text.len() as i64);
        let moments = secrets.list_secret_moments(WS, Some("main")).unwrap();
        assert_eq!(moments.len(), 1);
        // Store dropped → WAL flushed on close.
    }

    let marker_bytes = marker.as_bytes();
    for candidate in [db.clone(), wal_sidecar(&db), shm_sidecar(&db)] {
        if let Ok(bytes) = std::fs::read(&candidate) {
            assert!(
                !contains(&bytes, marker_bytes),
                "plaintext marker leaked into {}",
                candidate.display()
            );
        }
    }

    // Sanity: the ciphertext IS present somewhere (proves we scanned real data
    // and the secret was actually stored — just never as plaintext).
    let store = EngineStore::open(&db, 3).unwrap();
    let ct_present: i64 = store
        .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM secret_files", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(ct_present, 1, "the encrypted tip must be stored");
}

#[test]
fn materialization_job_is_enqueued_atomically_and_references_ciphertext() {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.engine_db_path().unwrap();
    seed_version(&db, WS);
    let key = key();

    let text = "SECRET=materialize-me";
    let mut store = EngineStore::open(&db, 2).unwrap();
    write(&mut store, &key, ".env", text, "sm1", 10);

    // A pending R04 materialization job was committed in the same txn.
    let jobs = store.list_pending_materialization_jobs().unwrap();
    assert_eq!(jobs.len(), 1, "one durable materialization intent");
    let job = &jobs[0];
    assert_eq!(job.target_path, ".env");

    // The job references the CIPHERTEXT blob — decrypting it under the key
    // yields the plaintext, and the blob bytes themselves are NOT plaintext.
    let blob = store
        .get_binary_blob(&job.content_sha256)
        .unwrap()
        .expect("blob present");
    assert!(
        !contains(&blob, text.as_bytes()),
        "materialization blob must be ciphertext, not plaintext"
    );
    assert_eq!(
        blob.len(),
        text.len(),
        "GCM ciphertext is length-preserving"
    );

    // And the secret-aware materializer produces the plaintext to write to disk.
    let secrets = SecretFileStore::new(&mut store, &key);
    let plaintext = secrets
        .materialize_secret_file(WS, "main", ".env")
        .unwrap()
        .unwrap();
    assert_eq!(plaintext.as_bytes(), text.as_bytes());
}

#[test]
fn crash_before_persist_rolls_back_secret_write() {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.engine_db_path().unwrap();
    seed_version(&db, WS);
    let key = key();

    {
        let mut store = EngineStore::open(&db, 2).unwrap();
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
        let mut secrets = SecretFileStore::new(&mut store, &key);
        let result = secrets.write_secret_file(
            &SecretWrite {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                text: "SECRET=v1".to_owned(),
                moment_id: "sm1".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 10,
                disk_intent: SecretDiskIntent::Materialize,
            },
            faults.as_ref(),
        );
        assert!(result.is_err(), "crash before persist surfaces as an error");
        assert!(faults.fired());
    }

    // Reopen: the rolled-back write left NOTHING — no tip, no moment, no job.
    let store = EngineStore::open(&db, 3).unwrap();
    assert_eq!(store.table_row_count("secret_files").unwrap(), 0);
    assert_eq!(store.table_row_count("secret_moments").unwrap(), 0);
    assert_eq!(store.pending_materialization_count().unwrap(), 0);
}

#[test]
fn crash_after_commit_is_durable() {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.engine_db_path().unwrap();
    seed_version(&db, WS);
    let key = key();

    {
        let mut store = EngineStore::open(&db, 2).unwrap();
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
        let mut secrets = SecretFileStore::new(&mut store, &key);
        let _ = secrets.write_secret_file(
            &SecretWrite {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                text: "SECRET=durable".to_owned(),
                moment_id: "sm1".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 10,
                disk_intent: SecretDiskIntent::Materialize,
            },
            faults.as_ref(),
        );
        assert!(faults.fired());
    }

    // Reopen: the committed state is durably present, and materialize works.
    let mut store = EngineStore::open(&db, 3).unwrap();
    assert_eq!(store.table_row_count("secret_files").unwrap(), 1);
    assert_eq!(store.pending_materialization_count().unwrap(), 1);
    let secrets = SecretFileStore::new(&mut store, &key);
    let text = secrets
        .materialize_secret_file(WS, "main", ".env")
        .unwrap()
        .unwrap();
    assert_eq!(text.into_utf8().unwrap(), "SECRET=durable");
}

#[test]
fn tampered_ciphertext_fails_closed_on_materialize() {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.engine_db_path().unwrap();
    seed_version(&db, WS);
    let key = key();

    {
        let mut store = EngineStore::open(&db, 2).unwrap();
        write(&mut store, &key, ".env", "SECRET=intact", "sm1", 10);
    }

    // Flip a byte in the stored ciphertext (simulating on-disk corruption).
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        let ct: String = conn
            .query_row("SELECT ciphertext_base64 FROM secret_files", [], |r| {
                r.get(0)
            })
            .unwrap();
        let mut bytes = aead::SealedSecret::from_base64(
            &conn
                .query_row("SELECT iv_base64 FROM secret_files", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
            &conn
                .query_row("SELECT auth_tag_base64 FROM secret_files", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
            &ct,
            "SECRET=intact".len(),
        )
        .unwrap()
        .ciphertext()
        .to_vec();
        bytes[0] ^= 0x01;
        let tampered = dohc_engine_crypto::base64::encode_standard(&bytes);
        conn.execute(
            "UPDATE secret_files SET ciphertext_base64 = ?1",
            params![tampered],
        )
        .unwrap();
    }

    let mut store = EngineStore::open(&db, 3).unwrap();
    let secrets = SecretFileStore::new(&mut store, &key);
    let err = secrets
        .materialize_secret_file(WS, "main", ".env")
        .unwrap_err();
    assert_eq!(err.code(), "decrypt-failed", "tamper must fail closed");
}

#[test]
fn fork_copies_secret_tips_verbatim() {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.engine_db_path().unwrap();
    seed_version(&db, WS);
    let key = key();

    let mut store = EngineStore::open(&db, 2).unwrap();
    write(&mut store, &key, ".env", "SECRET=on-main", "sm1", 10);

    // Create the destination version, then fork secrets into it.
    {
        let mut vt = VersionedTextStore::new(&mut store);
        vt.create_named_version(
            &dohc_engine_domain::CreateNamedVersion {
                workspace_id: WS.to_owned(),
                new_version_id: "feat".to_owned(),
                name: "feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 20,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("named version");
    }
    {
        let mut secrets = SecretFileStore::new(&mut store, &key);
        secrets
            .fork_version(WS, "main", "feat", 21, &NO_FAULTS)
            .expect("fork secrets");
    }

    // The forked version decrypts to the same plaintext (AAD is path-, not
    // version-bound, so ciphertext copies verbatim).
    let secrets = SecretFileStore::new(&mut store, &key);
    let text = secrets
        .materialize_secret_file(WS, "feat", ".env")
        .unwrap()
        .unwrap();
    assert_eq!(text.into_utf8().unwrap(), "SECRET=on-main");
    // Fork base was seeded too.
    assert_eq!(
        store.table_row_count("secret_fork_bases").unwrap(),
        1,
        "fork base copy seeded"
    );
}

#[test]
fn delete_removes_the_tip() {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.engine_db_path().unwrap();
    seed_version(&db, WS);
    let key = key();

    let mut store = EngineStore::open(&db, 2).unwrap();
    write(&mut store, &key, ".env", "SECRET=x", "sm1", 10);
    {
        let mut secrets = SecretFileStore::new(&mut store, &key);
        let moment = secrets
            .delete_secret_file(
                &dohc_engine_domain::SecretDelete {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    path: ".env".to_owned(),
                    moment_id: "sm2".to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    now_ms: 11,
                },
                &NO_FAULTS,
            )
            .unwrap()
            .expect("delete moment");
        assert_eq!(moment.operation, SecretOp::Delete);
    }
    let secrets = SecretFileStore::new(&mut store, &key);
    assert!(
        secrets
            .materialize_secret_file(WS, "main", ".env")
            .unwrap()
            .is_none()
    );
}

#[test]
fn ts_written_ciphertext_decrypts_in_the_rust_store() {
    // The load-bearing cross-engine store check: a secret sealed by the TS
    // engine (the committed Node fixture) is inserted directly into
    // `secret_files` — as if TS wrote it — and the Rust domain's authorized
    // materializer decrypts it byte-exact.
    let fixture_path = format!(
        "{}/../dohc-engine-crypto/tests/fixtures/ts_secret_ciphertext.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let raw = std::fs::read_to_string(&fixture_path).expect("read fixture");
    let fixture: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let entry = &fixture["entries"][0]; // path ".env"
    let ts_ws = entry["workspaceId"].as_str().unwrap();
    let ts_path = entry["path"].as_str().unwrap();
    let plaintext = entry["plaintext"].as_str().unwrap();
    let iv_b64 = entry["ivBase64"].as_str().unwrap();
    let tag_b64 = entry["authTagBase64"].as_str().unwrap();
    let ct_b64 = entry["ciphertextBase64"].as_str().unwrap();
    let byte_length = entry["byteLength"].as_u64().unwrap() as i64;
    let key = SecretDataKey::from_bytes(&hex(entry["dataKeyHex"].as_str().unwrap())).unwrap();

    let scratch = ScratchDir::new().unwrap();
    let db = scratch.engine_db_path().unwrap();
    seed_version(&db, ts_ws);

    // Insert the TS-produced sealed row directly (bypassing Rust encryption).
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute("PRAGMA foreign_keys = ON", []).unwrap();
        conn.execute(
            "INSERT INTO secret_files (workspace_id, version_id, path, iv_base64, auth_tag_base64, \
             ciphertext_base64, byte_length, updated_at_ms, latest_moment_id) \
             VALUES (?1, 'main', ?2, ?3, ?4, ?5, ?6, 100, 'ts-moment')",
            params![ts_ws, ts_path, iv_b64, tag_b64, ct_b64, byte_length],
        )
        .unwrap();
    }

    let mut store = EngineStore::open(&db, 2).unwrap();
    let secrets = SecretFileStore::new(&mut store, &key);
    let materialized = secrets
        .materialize_secret_file(ts_ws, "main", ts_path)
        .unwrap()
        .expect("present");
    assert_eq!(
        materialized.into_utf8().unwrap(),
        plaintext,
        "a TS-written secret must decrypt byte-exact in the Rust store"
    );
}

// --- helpers ----------------------------------------------------------------

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn shm_sidecar(db: &Path) -> std::path::PathBuf {
    let mut s = db.as_os_str().to_owned();
    s.push("-shm");
    std::path::PathBuf::from(s)
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn capture_secret_derives_ids_marks_complete_and_retires_keylessly() {
    use dohc_engine_domain::{CaptureSecret, CaptureSecretRetire, capture_secret_retire};

    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    seed_version(&db, WS);
    let mut store = EngineStore::open(&db, 1).expect("open");
    let key = key();

    let first = SecretFileStore::new(&mut store, &key)
        .capture_secret(
            &CaptureSecret {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                text: "TOKEN=alpha".to_owned(),
                metadata_origin: "local-file".to_owned(),
                now_ms: 10,
                claim_foreign_head: true,
            },
            &NO_FAULTS,
        )
        .expect("first capture");
    assert!(first.changed);
    let moment = first.moment.expect("moment");
    assert!(moment.moment_id.starts_with("moment-"));
    assert_eq!(
        moment.metadata_summary.as_deref(),
        Some("Updated .env"),
        "TS-parity capture summary"
    );

    // Capture records a COMPLETED marker, never a runnable job.
    let (pending, complete): (i64, i64) = store
        .read_with(|conn| {
            let pending = conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )?;
            let complete = conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs WHERE status = 'complete'",
                [],
                |row| row.get(0),
            )?;
            Ok::<_, rusqlite::Error>((pending, complete))
        })
        .expect("job counts");
    assert_eq!(pending, 0, "capture never enqueues runnable work");
    assert_eq!(complete, 1, "capture records the completed marker");

    // Content-equality dedupe: no new moment, marker refreshed not duplicated.
    let deduped = SecretFileStore::new(&mut store, &key)
        .capture_secret(
            &CaptureSecret {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                text: "TOKEN=alpha".to_owned(),
                metadata_origin: "local-file".to_owned(),
                now_ms: 20,
                claim_foreign_head: true,
            },
            &NO_FAULTS,
        )
        .expect("deduped capture");
    assert!(!deduped.changed);

    // KEYLESS retire with a derived id removes the tip.
    let retired = capture_secret_retire(
        &mut store,
        &CaptureSecretRetire {
            workspace_id: WS.to_owned(),
            version_id: "main".to_owned(),
            path: ".env".to_owned(),
            metadata_origin: "local-file".to_owned(),
            now_ms: 30,
            only_if_own_origin: false,
        },
        &NO_FAULTS,
    )
    .expect("keyless retire");
    let retire_moment = retired.expect("retire recorded a moment");
    assert!(retire_moment.moment_id.starts_with("moment-"));
    assert_ne!(retire_moment.moment_id, moment.moment_id);

    // Idempotent: an absent tip is a clean no-op.
    let absent = capture_secret_retire(
        &mut store,
        &CaptureSecretRetire {
            workspace_id: WS.to_owned(),
            version_id: "main".to_owned(),
            path: ".env".to_owned(),
            metadata_origin: "local-file".to_owned(),
            now_ms: 40,
            only_if_own_origin: false,
        },
        &NO_FAULTS,
    )
    .expect("no-op retire");
    assert!(absent.is_none());
}

#[test]
fn capture_retire_supersedes_a_stale_pending_secret_job() {
    use dohc_engine_domain::{CaptureSecretRetire, capture_secret_retire};

    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    seed_version(&db, WS);
    let mut store = EngineStore::open(&db, 1).expect("open");
    let key = key();

    // A Materialize-intent write leaves a PENDING secret job.
    write(&mut store, &key, ".env", "TOKEN=alpha", "sm-1", 10);
    let pending_before: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )
        })
        .expect("count");
    assert_eq!(pending_before, 1);

    // Capture retire (plaintext gone from disk) must record a completed
    // marker at the delete's generation so the stale pending job can never
    // later re-write the retired plaintext.
    capture_secret_retire(
        &mut store,
        &CaptureSecretRetire {
            workspace_id: WS.to_owned(),
            version_id: "main".to_owned(),
            path: ".env".to_owned(),
            metadata_origin: "local-file".to_owned(),
            now_ms: 20,
            only_if_own_origin: false,
        },
        &NO_FAULTS,
    )
    .expect("capture retire")
    .expect("tip existed");

    // The marker's generation must EXCEED the stale pending job's (secret
    // orders are 0-based) so the staleness gate supersedes it on drain.
    let (pending_gen, marker_gen): (i64, i64) = store
        .read_with(|conn| {
            let pending = conn.query_row(
                "SELECT target_generation FROM materialization_jobs \
                 WHERE status = 'pending' AND target_path = '.env'",
                [],
                |row| row.get(0),
            )?;
            let marker = conn.query_row(
                "SELECT target_generation FROM materialization_jobs \
                 WHERE status = 'complete' AND target_path = '.env'",
                [],
                |row| row.get(0),
            )?;
            Ok::<_, rusqlite::Error>((pending, marker))
        })
        .expect("marker rows");
    assert!(
        marker_gen > pending_gen,
        "the marker's generation ({marker_gen}) must exceed the stale pending job's ({pending_gen})"
    );
}

#[test]
fn capture_secret_ownership_is_enforced_in_both_directions() {
    use dohc_engine_domain::{CaptureSecret, CaptureSecretRetire, capture_secret_retire};

    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    seed_version(&db, WS);
    let mut store = EngineStore::open(&db, 1).expect("open");
    let key = key();

    // A FOREIGN writer (api) establishes the tip.
    write(&mut store, &key, ".env", "TOKEN=from-api", "sm-api", 10);
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "UPDATE secret_moments SET metadata_origin = 'api' WHERE moment_id = 'sm-api'",
                [],
            )
            .expect("mark the tip foreign");
            Ok::<_, dohc_engine_domain::DomainError>(())
        })
        .expect("mark the tip foreign");

    // FIRST SIGHT (claim_foreign_head = false): capture must refuse.
    let refused = SecretFileStore::new(&mut store, &key).capture_secret(
        &CaptureSecret {
            workspace_id: WS.to_owned(),
            version_id: "main".to_owned(),
            path: ".env".to_owned(),
            text: "TOKEN=from-disk".to_owned(),
            metadata_origin: "local-file".to_owned(),
            now_ms: 20,
            claim_foreign_head: false,
        },
        &NO_FAULTS,
    );
    assert!(
        matches!(
            refused,
            Err(dohc_engine_domain::DomainError::CaptureNotOwned)
        ),
        "first sight must not claim a foreign secret tip"
    );

    // RETIRE must refuse too — the plaintext may never have been on disk.
    let retired = capture_secret_retire(
        &mut store,
        &CaptureSecretRetire {
            workspace_id: WS.to_owned(),
            version_id: "main".to_owned(),
            path: ".env".to_owned(),
            metadata_origin: "local-file".to_owned(),
            now_ms: 30,
            only_if_own_origin: true,
        },
        &NO_FAULTS,
    )
    .expect("keyless retire");
    assert!(
        retired.is_none(),
        "a foreign secret tip must never be retired by a disk-driven pass"
    );

    // The foreign plaintext survives both.
    let plaintext = SecretFileStore::new(&mut store, &key)
        .materialize_secret_file(WS, "main", ".env")
        .expect("materialize")
        .expect("tip present");
    assert_eq!(plaintext.into_utf8().expect("utf8"), "TOKEN=from-api");

    // An OBSERVED transition (claim_foreign_head = true) may claim it.
    let claimed = SecretFileStore::new(&mut store, &key)
        .capture_secret(
            &CaptureSecret {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                text: "TOKEN=user-edited".to_owned(),
                metadata_origin: "local-file".to_owned(),
                now_ms: 40,
                claim_foreign_head: true,
            },
            &NO_FAULTS,
        )
        .expect("an observed edit is authoritative");
    assert!(claimed.changed);
    let plaintext = SecretFileStore::new(&mut store, &key)
        .materialize_secret_file(WS, "main", ".env")
        .expect("materialize")
        .expect("tip present");
    assert_eq!(plaintext.into_utf8().expect("utf8"), "TOKEN=user-edited");

    // Now capture-owned: the disk-driven retire works.
    let retired = capture_secret_retire(
        &mut store,
        &CaptureSecretRetire {
            workspace_id: WS.to_owned(),
            version_id: "main".to_owned(),
            path: ".env".to_owned(),
            metadata_origin: "local-file".to_owned(),
            now_ms: 50,
            only_if_own_origin: true,
        },
        &NO_FAULTS,
    )
    .expect("keyless retire");
    assert!(retired.is_some(), "capture retires the tip it owns");
}
