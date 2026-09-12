//! A paired workspace and relay backup retains public creates and retry identity.
//! Relay rollback is refused using continuity stored outside its database volume.

mod common;

use base64::Engine as _;
use common::*;
use dohc_engine_collab::{ContentKind, Ydoc};
use dohc_engine_domain::{NoFaults, VersionedTextStore};
use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_runtime::{CancellationToken, WorkspaceSupervisor};
use dohc_engine_storage::{
    BackupOutcome, EngineStore, RealFreeSpace, create_verified_backup, hex_sha256,
    load_valid_backup,
};
use dohc_engine_sync::{
    ApplyDisposition, NoLiveLeases, ReplicationEnvelope, apply_replication_envelope,
    list_replication_ops,
};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use serde_json::{Value, json};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;

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
                .expect("insert relay text blob");
                Ok::<_, dohc_engine_storage::StorageError>(())
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

fn export_owner_journal(db: &Path, root: &Path, phase: &str, delete: &Value, request_id: &str) {
    let store = EngineStore::open(db, 40).expect("read native outgoing journal");
    let ops = list_replication_ops(&store, "w", "owner-device", -1, 100)
        .expect("export native replication page");
    assert!(!ops.is_empty() && ops.len() < 100);
    let ops: Vec<Value> = ops
        .iter()
        .map(|op| {
            json!({
                "originSeq": op.origin_seq, "opKind": op.op_kind,
                "recordedAtMs": op.recorded_at_ms,
                "payloadJson": serde_json::to_string(&op.payload).expect("wire payload"),
            })
        })
        .collect();
    let blobs = store
        .read_with(|conn| {
            let mut statement =
                conn.prepare("SELECT sha256,text FROM blobs WHERE text IS NOT NULL")?;
            statement
                .query_map([], |row| {
                    Ok(json!({
                        "sha256": row.get::<_, String>(0)?, "text": row.get::<_, String>(1)?,
                    }))
                })?
                .collect::<Result<Vec<Value>, rusqlite::Error>>()
        })
        .expect("native text blobs");
    std::fs::write(
        root.join(format!("{phase}.json")),
        serde_json::to_vec(&json!({
            "ops": ops, "blobs": blobs, "deleteMomentId": delete["moment"]["momentId"],
            "requestId": request_id,
        }))
        .expect("serialize outgoing native journal"),
    )
    .expect("write outgoing native journal");
    relay_phase(root, phase);
    let verdict: Value = serde_json::from_slice(
        &std::fs::read(root.join(format!("{phase}-verified.json"))).expect("relay undo verdict"),
    )
    .expect("relay undo verdict JSON");
    assert_eq!(
        verdict,
        json!({"nativeJournalApplied": true, "retryPreserved": true,
        "visibleRecords": if phase == "owner-deleted" { 0 } else { 1 }})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_response_native_owner_undo_syncs_and_history_restores() {
    let scratch = ScratchDir::new().expect("owner undo scratch");
    relay_phase(scratch.path(), "prepare");
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(scratch.path().join("fixture.json")).expect("accepted relay fixture"),
    )
    .expect("fixture JSON");
    // The selection comes from the relay's immutable owner acceptance API.
    let selected = &fixture["ownerSelection"]["acceptances"][0];
    let path = selected["path"].as_str().expect("selected response path");
    let object_id = selected["objectId"].as_str().expect("selected object");
    assert_eq!(selected["momentId"], fixture["receipt"]["momentId"]);
    let request_id = format!(
        "app-response-undo:{}",
        hex_sha256(
            serde_json::to_string(&json!([
                "w",
                "g",
                "owner-undo-proof",
                selected["acceptanceId"]
            ]))
            .expect("bulk undo request identity")
            .as_bytes()
        )
    );
    let owner_scratch = ScratchDir::new().expect("owner workspace");
    write_root_binding(owner_scratch.path(), TOKEN).expect("owner root binding");
    let db = engine_db_path(&owner_scratch).expect("engine db");
    let mut store = EngineStore::open(&db, 1).expect("native owner store");
    store
        .bind_root_token(TOKEN, &NoFaults)
        .expect("bind owner root");
    VersionedTextStore::new(&mut store)
        .ensure_main_version("w", "main", 1, &NoFaults)
        .expect("main version");
    let mut changes = Vec::new();
    for row in fixture["envelopes"].as_array().expect("relay envelopes") {
        let text = row["text"].as_str().expect("relay text");
        let sha = row["payload"]["payloadAfterBlobSha256"]
            .as_str()
            .expect("relay sha");
        assert_eq!(hex_sha256(text.as_bytes()), sha);
        store
            .write_with(&NoFaults, |conn| {
                conn.execute(
                    "INSERT INTO blobs(sha256,byte_length,text) VALUES (?1,?2,?3)",
                    rusqlite::params![sha, text.len() as i64, text],
                )
                .expect("hydrate relay blob");
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .expect("commit relay blob");
        let applied = apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &ReplicationEnvelope {
                workspace_id: "w".into(),
                origin_id: row["originId"].as_str().unwrap().into(),
                origin_seq: row["originSeq"].as_i64().unwrap(),
                relay_seq: row["relaySeq"].as_i64(),
                op_kind: "moment.append".into(),
                payload: row["payload"].clone(),
                recorded_at_ms: row["recordedAtMs"].as_i64().unwrap(),
            },
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("apply actual acceptance");
        assert!(
            applied.refusals.is_empty() && applied.sharing_declined.is_empty(),
            "{applied:?}"
        );
        let ApplyDisposition::Applied(routed) = applied.primary else {
            panic!("accepted moment not applied")
        };
        changes.extend(routed.materialization_changes);
    }
    store.write_with(&NoFaults, |conn| {
        conn.execute("INSERT INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms)
            VALUES ('w','owner-device','owner-epoch','owner-stream',1)", []).expect("owner identity");
        conn.execute("INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES ('w','owner-device',0)", [])
            .expect("owner journal enabled");
        Ok::<_, dohc_engine_storage::StorageError>(())
    }).expect("persist owner sync setup");
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    supervisor
        .open(&db, 2)
        .expect("owner actor")
        .actor
        .materialize_relay_page(
            "w".into(),
            owner_scratch.path().to_path_buf(),
            changes,
            Arc::new(()),
            20,
            CancellationToken::new(),
        )
        .await
        .expect("materialize accepted response and schema");
    supervisor.close(&db).expect("close materializer");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({"rootDir": owner_scratch.path().to_string_lossy(), "workspaceId": "w"}),
            ),
        )
        .await
        .expect("open native owner workspace");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("owner handle");
    reconcile_until_settled(&transport, &handle, 10).await;
    let pending = call(
        &transport,
        &handle,
        20,
        "collections.listPendingAdoptions",
        json!({}),
    )
    .await;
    assert_eq!(pending["adoptions"].as_array().unwrap().len(), 1);
    assert_eq!(pending["adoptions"][0]["objectId"], object_id);
    let record_id = pending["adoptions"][0]["recordId"]
        .as_str()
        .expect("native record identity")
        .to_owned();
    let seeded = call(&transport, &handle, 21, "ydoc.open", json!({
        "versionId": "main", "path": path, "contentKind": "richdoc", "expectedObjectId": object_id,
    })).await;
    assert_eq!(seeded["lineage"], "absent");
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(
        ContentKind::Richdoc,
        seeded["seedContent"].as_str().expect("accepted Markdown"),
    )
    .expect("seed owner adoption through native Y.Doc");
    call(
        &transport,
        &handle,
        22,
        "ydoc.recordUpdate",
        json!({"sessionId": seeded["sessionId"], "seed": true,
        "updateBase64": base64::engine::general_purpose::STANDARD.encode(doc.encode_full_state())}),
    )
    .await;
    call(
        &transport,
        &handle,
        23,
        "ydoc.evict",
        json!({"sessionId": seeded["sessionId"]}),
    )
    .await;
    reconcile_until_settled(&transport, &handle, 30).await;
    let adopted =
        std::fs::read_to_string(owner_scratch.path().join(path)).expect("adopted owner Markdown");
    assert!(adopted.contains(&record_id));
    let mismatch = call_error(&transport, &handle, 40, "versionedText.delete", json!({
        "versionId": "main", "path": path, "origin": "api", "expectedObjectId": "foreign-object",
        "requestId": "wrong-object-proof",
    })).await;
    assert_eq!(mismatch.message, "object-identity-mismatch");
    assert_eq!(
        std::fs::read_to_string(owner_scratch.path().join(path)).unwrap(),
        adopted
    );
    let delete_params = json!({"versionId": "main", "path": path, "origin": "api", "expectedObjectId": object_id,
        "requestId": request_id, "correlationId": request_id, "summary": "Removed app response"});
    let deleted = call(
        &transport,
        &handle,
        41,
        "versionedText.delete",
        delete_params.clone(),
    )
    .await;
    assert_eq!(deleted["moment"]["operation"], "delete");
    let retry = call(
        &transport,
        &handle,
        42,
        "versionedText.delete",
        delete_params.clone(),
    )
    .await;
    assert_eq!(retry["deduped"], true);
    assert_eq!(retry["moment"]["momentId"], deleted["moment"]["momentId"]);
    assert!(!owner_scratch.path().join(path).exists());
    reconcile_until_settled(&transport, &handle, 50).await;
    let empty = call(
        &transport,
        &handle,
        60,
        "collections.query",
        json!({"collectionPath": "responses"}),
    )
    .await;
    assert_eq!(empty["records"], json!([]));
    export_owner_journal(&db, scratch.path(), "owner-deleted", &deleted, &request_id);
    let restored = call(&transport, &handle, 61, "versionedText.rollback", json!({"versionId": "main", "path": path,
        "mutationMomentId": deleted["moment"]["momentId"], "origin": "restore", "requestId": "restore-owner-undo"})).await;
    assert_eq!(restored["rolledBack"], true);
    reconcile_until_settled(&transport, &handle, 70).await;
    assert_eq!(
        std::fs::read_to_string(owner_scratch.path().join(path)).unwrap(),
        adopted
    );
    let query = call(
        &transport,
        &handle,
        80,
        "collections.query",
        json!({"collectionPath": "responses"}),
    )
    .await;
    assert_eq!(query["records"].as_array().unwrap().len(), 1);
    assert_eq!(query["records"][0]["id"], record_id);
    // Retrying the completed delete must preserve the owner's history restore.
    let retry = call(
        &transport,
        &handle,
        81,
        "versionedText.delete",
        delete_params,
    )
    .await;
    assert_eq!(retry["deduped"], true);
    assert_eq!(
        std::fs::read_to_string(owner_scratch.path().join(path)).unwrap(),
        adopted
    );
    let original = call(
        &transport,
        &handle,
        82,
        "moments.get",
        json!({"momentId": selected["momentId"]}),
    )
    .await;
    assert_eq!(
        original["author"],
        fixture["envelopes"][1]["payload"]["author"]
    );
    call(&transport, &handle, 83, "workspace.close", json!({})).await;
    export_owner_journal(&db, scratch.path(), "owner-restored", &deleted, &request_id);
}
