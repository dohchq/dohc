use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::params;
use serde_json::json;

use super::{MomentAppendPayload, origin_settled_on_held_claim};
use crate::{ReplicationEnvelope, SyncError};

fn claim() -> String {
    dohc_engine_storage::hex_sha256(b"claim")
}

fn closed_note_with_peer_edit() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1_000).unwrap();
    let mut text = VersionedTextStore::new(&mut store);
    text.ensure_main_version("ws", "main", 1_000, &NoFaults)
        .unwrap();
    text.write_text(
        &WriteText {
            workspace_id: "ws".into(),
            version_id: "main".into(),
            object_id: "doc".into(),
            moment_id: "seed".into(),
            path: "doc.md".into(),
            text: "one".into(),
            metadata_origin: "ydoc".into(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 1,
            request_id: None,
        },
        &NoFaults,
    )
    .unwrap();
    store.put_binary_blob(b"claim").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO ydoc_docs(workspace_id,version_id,object_id,content_kind,regime,lineage_claim_status,lineage_claim_id,updated_at_ms,path) \
                 VALUES ('ws','main','doc','plaintext','replicated','exact',?1,1,'doc.md')",
                [claim()],
            )
            .map_err(SyncError::persist)?;
            peer_update(tx, 2, "applied")
        })
        .unwrap();
    (scratch, store)
}

fn peer_update(
    tx: &rusqlite::Transaction<'_>,
    seq: i64,
    disposition: &str,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported,apply_disposition) \
         VALUES ('ws','peer',?1,'ydoc.update',?2,1,1,?3)",
        params![seq, json!({"versionId":"main","objectId":"doc","lineageClaimId":claim()}).to_string(), disposition],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn peer_save_is_history_only(store: &mut EngineStore) -> bool {
    let envelope = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".into(),
        origin_id: "peer".into(),
        origin_seq: 3,
        op_kind: "moment.append".into(),
        payload: json!({}),
        recorded_at_ms: 1,
        relay_seq: None,
    };
    let payload: MomentAppendPayload = serde_json::from_value(json!({
        "momentId": format!("moment-ydoc-{}", "a".repeat(64)),
        "versionId": "main",
        "objectId": "doc",
        "path": "doc.md",
        "recordedAtMs": 1,
        "operation": "write",
        "payloadAfterBlobSha256": "b".repeat(64),
        "payloadAfterPath": "doc.md",
        "payloadAfterContentKind": "text",
        "metadata": {"origin": "ydoc"},
        "beforePresent": "present",
    }))
    .unwrap();
    let TxnOutcome::Committed(held) = store
        .write_with(&NoFaults, |tx| {
            origin_settled_on_held_claim(tx, &envelope, &payload)
        })
        .unwrap()
    else {
        panic!("the check did not commit")
    };
    held
}

#[test]
fn a_closed_note_files_a_save_as_history_only_when_every_edit_arrived() {
    let (_scratch, mut store) = closed_note_with_peer_edit();
    assert!(peer_save_is_history_only(&mut store));
}

#[test]
fn a_closed_note_with_a_queued_edit_does_not_file_a_save_as_history_only() {
    let (_scratch, mut store) = closed_note_with_peer_edit();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO ydoc_deferred_updates(workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms,lineage_claim_id) \
                 VALUES ('ws','main','doc','peer',1,1,?1)",
                [claim()],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    assert!(!peer_save_is_history_only(&mut store));
}

#[test]
fn a_closed_note_with_a_refused_edit_does_not_file_a_save_as_history_only() {
    let (_scratch, mut store) = closed_note_with_peer_edit();
    store
        .write_with(&NoFaults, |tx| peer_update(tx, 1, "refused"))
        .unwrap();
    assert!(!peer_save_is_history_only(&mut store));
}
