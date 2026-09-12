//! A paired workspace and relay backup retains public creates and retry identity.
//! Relay rollback is refused using continuity stored outside its database volume.

use dohc_engine_domain::{NoFaults, VersionedTextStore};
use dohc_engine_storage::{
    BackupOutcome, EngineStore, RealFreeSpace, create_verified_backup, hex_sha256,
    load_valid_backup,
};
use dohc_engine_sync::{
    ApplyDisposition, NoLiveLeases, ReplicationEnvelope, apply_replication_envelope,
};
use dohc_engine_testkit::ScratchDir;
use serde_json::{Value, json};
use std::path::Path;
use std::process::{Command, Stdio};

fn relay_phase(root: &Path, phase: &str) {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let mut command = Command::new("node");
    command
        .current_dir(repo.join("services/sync-relay"))
        .args(["--import", "tsx", "src/testing/appCollectionRecovery.ts"])
        .arg(root)
        .arg(phase)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let child = command.spawn().expect("launch relay recovery fixture");
    eprintln!("relay recovery {phase}: child PID {}", child.id());
    let result = child
        .wait_with_output()
        .expect("wait for relay recovery fixture");
    assert!(
        result.status.success(),
        "relay recovery {phase}: {}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn paired_public_collection_backup_preserves_acceptance_and_refuses_stale_relay() {
    let scratch = ScratchDir::new().expect("paired recovery scratch");
    relay_phase(scratch.path(), "prepare");
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(scratch.path().join("fixture.json")).expect("relay fixture"),
    )
    .expect("relay fixture JSON");
    let mut store = EngineStore::open(&scratch.path().join("workspace.db"), 1).expect("workspace");
    VersionedTextStore::new(&mut store)
        .ensure_main_version("w", "main", 1, &NoFaults)
        .expect("main version");
    let rows = fixture["envelopes"]
        .as_array()
        .expect("accepted relay envelopes");
    assert_eq!(rows.len(), 2);
    let mut accepted = None;
    for row in rows {
        let text = row["text"].as_str().expect("relay text blob");
        let sha = row["payload"]["payloadAfterBlobSha256"]
            .as_str()
            .expect("blob digest");
        assert_eq!(hex_sha256(text.as_bytes()), sha);
        store
            .write_with(&NoFaults, |conn| {
                conn.execute(
                    "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    rusqlite::params![sha, text.len() as i64, text],
                )
            })
            .expect("hydrate relay text blob");
        let envelope = ReplicationEnvelope {
            workspace_id: "w".to_owned(),
            origin_id: row["originId"].as_str().expect("origin").to_owned(),
            origin_seq: row["originSeq"].as_i64().expect("origin sequence"),
            relay_seq: Some(row["relaySeq"].as_i64().expect("relay sequence")),
            op_kind: "moment.append".to_owned(),
            payload: row["payload"].clone(),
            recorded_at_ms: row["recordedAtMs"].as_i64().expect("recorded time"),
        };
        let result = apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &envelope,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("apply real relay moment");
        assert!(
            matches!(result.primary, ApplyDisposition::Applied(_)),
            "{result:?}"
        );
        assert!(result.refusals.is_empty(), "{result:?}");
        assert!(result.sharing_declined.is_empty(), "{result:?}");
        if envelope.origin_id == "relay:collection-create:g" {
            accepted = Some(envelope);
        }
    }
    let accepted = accepted.expect("public accepted moment");
    let recovery = scratch.path().join("native-recovery");
    let BackupOutcome::Verified(created) = create_verified_backup(
        &store,
        &recovery,
        "accepted",
        "test",
        30,
        &RealFreeSpace,
        &NoFaults,
    )
    .expect("create native verified backup") else {
        panic!("native backup interrupted")
    };
    drop(store);
    let verified = load_valid_backup(&recovery, "accepted")
        .expect("validate backup manifest")
        .expect("native backup checksum and manifest match");
    assert_eq!(verified, created);
    // Open a working copy so replay never mutates the verified recovery point.
    let restored_path = scratch.path().join("restored-workspace.db");
    std::fs::copy(&verified.backup_path, &restored_path).expect("restore native working copy");
    let mut restored = EngineStore::open(&restored_path, 40).expect("open native backup");
    let path = fixture["receipt"]["path"].as_str().expect("accepted path");
    let snapshot = VersionedTextStore::new(&mut restored)
        .read_text("w", "main", path)
        .expect("read restored response")
        .expect("response survives native backup");
    assert_eq!(snapshot.object_id, fixture["receipt"]["objectId"]);
    assert_eq!(snapshot.text, rows[1]["text"]);
    for _ in 0..2 {
        let retry = apply_replication_envelope(
            &mut restored,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &accepted,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("retry accepted response against restored native state");
        assert!(
            matches!(retry.primary, ApplyDisposition::Skipped),
            "{retry:?}"
        );
        assert!(retry.refusals.is_empty());
    }
    let moment_id = fixture["receipt"]["momentId"]
        .as_str()
        .expect("accepted moment");
    let (author, moment_count, imported_count): (String, i64, i64) = restored.read_with(|conn| conn.query_row(
        "SELECT author_json, \
         (SELECT count(*) FROM moments WHERE workspace_id='w' AND moment_id=?1), \
         (SELECT count(*) FROM replication_log WHERE workspace_id='w' AND origin_id='relay:collection-create:g' AND imported=1) \
         FROM moments WHERE workspace_id='w' AND moment_id=?1",
        [moment_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )).expect("read restored acceptance and public provenance");
    assert_eq!((moment_count, imported_count), (1, 1));
    let author: Value = serde_json::from_str(&author).expect("public author JSON");
    assert_eq!(author, accepted.payload["author"]);
    drop(restored);
    std::fs::write(scratch.path().join("native-restored.json"), serde_json::to_vec(&json!({
        "momentId": moment_id, "objectId": snapshot.object_id, "text": snapshot.text, "author": author,
        "importedCount": imported_count, "momentCount": moment_count,
    })).expect("native restore receipt")).expect("write native restore receipt");
    relay_phase(scratch.path(), "verify");
    let verdict: Value = serde_json::from_slice(
        &std::fs::read(scratch.path().join("verified.json")).expect("paired restore verdict"),
    )
    .expect("paired restore verdict JSON");
    assert_eq!(
        verdict,
        json!({"pairedRestored": true, "divergentRelayRefused": true, "continuityUnchanged": true})
    );
}
