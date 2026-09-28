use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_storage::{EngineStore, NoFaults};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use serde_json::json;

#[tokio::test]
async fn refusal_notices_survive_restart_and_dismiss_with_workspace_scope() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = EngineStore::open(&db, 0).unwrap();
    let claim = store.put_binary_blob(b"successor").unwrap();
    let correlation = format!(
        "ydoc-inactive-recovery:{}",
        dohc_engine_storage::hex_sha256(format!("ws\0main\0object-a\0{claim}").as_bytes())
    );
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 0, &NoFaults)
        .unwrap();
    let recovery = dohc_engine_domain::VersionedTextStore::new(&mut store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "recovery".into(),
                path: "renamed (recovered).md".into(),
                text: "recovered".into(),
                moment_id: "recovery-moment".into(),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: Some(correlation),
                author_json: None,
                now_ms: 1,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('ws','object-a',0)", [])
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
        tx.execute("INSERT INTO ydoc_inactive_lineages (workspace_id,version_id,object_id,lineage_claim_id,disposition,content_kind,path,full_state_blob_sha256,state_vector_blob_sha256,last_surfaced_projection_sha256,recorded_at_ms,updated_at_ms) VALUES ('ws','main','object-a',?1,'rejected-base','plaintext','renamed.md',?1,?1,?2,0,0)",
            rusqlite::params![claim, recovery.snapshot.blob_sha256]).map_err(dohc_engine_storage::StorageError::persist_public)?;
        for (workspace, payload) in [
            ("ws", json!({"targetVersionId":"main","paths":["old.md","renamed.md"],
                "transition":{"result":{"objectId":"object-a","pathRef":1}},"lineageTransition":{"successor":{"lineageClaimId":claim}}})),
            ("other", json!({"versionId":"private","path":"secret.md","objectId":"secret"})),
        ] {
            tx.execute("INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES (?1,'peer',0,'conflict.resolve',?2,0,1)",
                rusqlite::params![workspace, payload.to_string()]).map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute("INSERT INTO replication_pending_refusals (workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) VALUES (?1,'peer',0,'conflict.resolve','invalid-input','projection exceeds limit')",
                [workspace]).map_err(dohc_engine_storage::StorageError::persist_public)?;
        }
        Ok::<_, dohc_engine_storage::StorageError>(())
    }).unwrap();
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let result = actor.sync_refusal_notices("ws".into()).await.unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(
        serde_json::to_value(result[0].document.as_ref().unwrap()).unwrap(),
        json!({"versionId":"main","path":"renamed.md","objectId":"object-a","lineageClaimId":claim,"conflictId":null})
    );
    let id = result[0].notice_id.clone();
    actor
        .dismiss_sync_refusal(
            "other".into(),
            id.clone(),
            result[0].refusal_coordinates.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        actor.sync_refusal_notices("ws".into()).await.unwrap().len(),
        1
    );
    actor
        .dismiss_sync_refusal("ws".into(), id, result[0].refusal_coordinates.clone())
        .await
        .unwrap();
    assert!(
        actor
            .sync_refusal_notices("ws".into())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        actor
            .sync_refusal_notices("other".into())
            .await
            .unwrap()
            .len(),
        1
    );
}
