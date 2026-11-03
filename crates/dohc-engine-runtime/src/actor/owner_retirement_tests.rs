//! A writable open closes the owner bindings an earlier build stranded.
use crate::WorkspaceSupervisor;
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::owner_outbox::{
    OwnerOutboxLimits,
    draft::{ObservedOwnerBinding, install_observed_binding_in_tx},
};
use dohc_engine_collab::{ContentKind, DocKey, Ydoc};
use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::path::Path;

/// Owner-bound pages whose lineage a 167.1 build deleted with their owner rows kept.
fn stranded(db: &Path, objects: &[&str]) {
    let mut store = EngineStore::open(db, 1_000).unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .unwrap();
    for object in objects {
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: "ws".into(),
                    version_id: "main".into(),
                    object_id: (*object).into(),
                    path: format!("{object}.md"),
                    text: "owned\n".into(),
                    moment_id: format!("owned-{object}"),
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1_000,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    }
    dohc_engine_sync::adopt_join_identity(
        &mut store, "ws", "local", "epoch", "stream", 1, &NoFaults,
    )
    .unwrap();
    for object in objects {
        let path = format!("{object}.md");
        let key = DocKey::new("ws", "main", *object).unwrap();
        let base = Ydoc::wire();
        let _ = base.richdoc_append_paragraph(object);
        let original = base.encode_full_state();
        dohc_engine_collab::claim_base(
            &mut store,
            &key,
            ContentKind::Richdoc,
            &original,
            &NoFaults,
            2,
        )
        .unwrap();
        store
            .read_with(|conn| {
                conn.execute(
                    "UPDATE ydoc_docs SET path=?1 WHERE object_id=?2",
                    [&path, &(*object).to_owned()],
                )
            })
            .unwrap();
        let checkpoint = store
            .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
            .unwrap()
            .encode_full_state();
        let observed = ObservedOwnerBinding {
            binding: LiveObjectBinding {
                workspace_id: "ws".into(),
                main_version_id: "main".into(),
                object_id: (*object).into(),
                lineage_claim_id: hex_sha256(&original),
                current_path: path.clone(),
                selector_paths: vec![path],
                restore_fence_generation: 0,
            },
            relay_database_namespace: "relay".into(),
            revision: 1,
            accepted_cursor: 0,
            native_head_sequence: store
                .read_with(|conn| dohc_engine_collab::read_marker_in(conn, &key))
                .unwrap()
                .unwrap()
                .head_update_seq,
            checkpoint_digest: hex_sha256(&checkpoint),
            limits: OwnerOutboxLimits {
                max_pending_bytes: 1_000_000,
                max_pending_age_ms: 60_000,
            },
        };
        store
            .write_with(&NoFaults, |tx| {
                install_observed_binding_in_tx(tx, "ws", &observed, &checkpoint)
            })
            .unwrap();
    }
    store
        .read_with(|conn| {
            conn.execute_batch(
                "DELETE FROM ydoc_updates; DELETE FROM ydoc_snapshots; DELETE FROM ydoc_docs;",
            )
        })
        .unwrap();
}

/// Owner bindings, and queues closed as retired.
fn owner_rows(db: &Path) -> (i64, i64) {
    EngineStore::open_read_only(db)
        .unwrap()
        .read_with(|conn| {
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM ydoc_owner_bindings),\
                 (SELECT COUNT(*) FROM owner_ydoc_outboxes WHERE state='quarantined' AND quarantine_reason='retired')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap()
}

#[test]
fn only_a_writable_open_closes_a_stranded_owner_binding() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    stranded(&db, &["object"]);
    assert_eq!(owner_rows(&db), (1, 0));
    let supervisor = WorkspaceSupervisor::new();
    drop(supervisor.open_read_only(&db).unwrap());
    supervisor.close(&db).unwrap();
    assert_eq!(owner_rows(&db), (1, 0), "a read-only open never writes");
    for _ in 0..2 {
        drop(supervisor.open(&db, 50).unwrap());
        supervisor.close(&db).unwrap();
        assert_eq!(owner_rows(&db), (0, 1));
    }
}

#[test]
fn a_corrupt_owner_binding_keeps_only_its_own_page() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    stranded(&db, &["a-corrupt", "b-good"]);
    EngineStore::open(&db, 1_000)
        .unwrap()
        .read_with(|conn| {
            conn.execute(
                "UPDATE ydoc_owner_bindings SET binding_json='{}' WHERE object_id='a-corrupt'",
                [],
            )
        })
        .unwrap();
    assert_eq!(owner_rows(&db), (2, 0));
    let supervisor = WorkspaceSupervisor::new();
    drop(supervisor.open(&db, 50).unwrap());
    supervisor.close(&db).unwrap();
    assert_eq!(owner_rows(&db), (1, 1));
    let kept: String = EngineStore::open_read_only(&db)
        .unwrap()
        .read_with(|conn| {
            conn.query_row(
                "SELECT object_id FROM ydoc_owner_bindings",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(kept, "a-corrupt");
}
