use super::*;
use crate::EngineService;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use dohc_engine_collab::{ContentKind, DocKey, Ydoc, reader_resolver};
use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_storage::{EngineStore, StorageError, hex_sha256};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use serde_json::{Value, json};
use std::path::PathBuf;
use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_recovery_undo_retries_an_already_attempted_collection_obligation() {
    use dohc_engine_domain::{
        DeleteTextFile, reconcile_collections_in_tx, set_collection_adoption_state_in_tx,
    };
    const RECORD: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TARGET: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    let scratch = ScratchDir::new().unwrap();
    let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    crate::root_binding::write_root_binding(scratch.path(), token).unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    store.bind_root_token(token, &NoFaults).unwrap();
    store.write_with(&NoFaults, |tx| tx.execute_batch(
        "INSERT INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES('w','origin','epoch','stream',1);
         INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES('w','origin',0);"
    ).map_err(StorageError::persist_public)).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("w", "main", 1, &NoFaults)
        .unwrap();
    let source = format!("---\nid: {RECORD}\nrelated: {TARGET}\n---\n\nHeld source\n");
    let target = format!("---\nid: {TARGET}\n---\n\nTarget\n");
    std::fs::create_dir_all(scratch.path().join("tasks")).unwrap();
    for (object, path, text) in [
        (
            "schema",
            "tasks/collection.yaml",
            "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
        ),
        ("held", "tasks/a.md", source.as_str()),
        ("target", "tasks/b.md", target.as_str()),
        ("other", "other.txt", "Original source\n"),
    ] {
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "w".into(),
                    version_id: "main".into(),
                    object_id: object.into(),
                    path: path.into(),
                    text: text.into(),
                    moment_id: object.into(),
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        std::fs::write(scratch.path().join(path), text).unwrap();
    }
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, "w", "main")?;
            set_collection_adoption_state_in_tx(tx, "w", "main", "tasks/a.md", RECORD, "adopted")?;
            set_collection_adoption_state_in_tx(tx, "w", "main", "tasks/b.md", TARGET, "adopted")?;
            Ok::<_, dohc_engine_domain::DomainError>(())
        })
        .unwrap();
    VersionedTextStore::new(&mut store)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: "w".into(),
                version_id: "main".into(),
                path: "tasks/b.md".into(),
                moment_id: "delete-target".into(),
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: Some("dohc-operation:delete-target".into()),
                author_json: None,
                now_ms: 3,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    std::fs::remove_file(scratch.path().join("tasks/b.md")).unwrap();
    let held = DocKey::new("w", "main", "held").unwrap();
    let other = DocKey::new("w", "main", "other").unwrap();
    let other_doc = Ydoc::wire();
    other_doc.plaintext_insert(0, "Original source\n");
    for (key, path, kind) in [
        (&held, "tasks/a.md", ContentKind::Richdoc),
        (&other, "other.txt", ContentKind::Plaintext),
    ] {
        let doc = Ydoc::wire();
        if kind == ContentKind::Richdoc {
            doc.rewrite_content_to_markdown(kind, &source).unwrap();
            doc.richdoc_append_paragraph("Accepted edits stay canonical");
            let wire = yrs::Doc::new();
            wire.get_or_insert_map("meta").insert(
                &mut wire.transact_mut(),
                "dohcMarkdownSourceSha256",
                hex_sha256(source.as_bytes()),
            );
            wire.get_or_insert_map("meta").insert(
                &mut wire.transact_mut(),
                "dohcMarkdownSourceProjectionSha256",
                "f".repeat(64),
            );
            doc.apply(
                &wire
                    .transact()
                    .encode_state_as_update_v1(&yrs::StateVector::default()),
            )
            .unwrap();
        } else {
            doc.apply(&other_doc.encode_full_state()).unwrap();
        }
        dohc_engine_collab::claim_base(
            &mut store,
            key,
            kind,
            &doc.encode_full_state(),
            &NoFaults,
            4,
        )
        .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
            "UPDATE ydoc_docs SET path=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            rusqlite::params![key.workspace_id,key.version_id,key.object_id,path])
            .map_err(StorageError::persist_public)
            })
            .unwrap();
    }
    let other_claim = dohc_engine_collab::read_marker(&store, &other)
        .unwrap()
        .unwrap()
        .lineage_claim_id;
    drop(store);
    let service = EngineService::new();
    let opened = service
        .workspace_open(
            &RequestContext::unbounded(),
            json!({
                "rootDir":scratch.path(),"workspaceId":"w","captureMode":"none",
            }),
        )
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    open.shutdown_capture().await;
    let result = open
        .actor
        .reconcile_collections(
            "w".into(),
            "main".into(),
            scratch.path().to_owned(),
            service.leases.clone(),
            Arc::new(()),
            10,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.held_documents.len(), 1);
    let pending = open
        .actor
        .markdown_recovery_candidates("w".into())
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].obligation.kind, Kind::RelationCleanup);
    let collection_order = pending[0].obligation.order;
    let cancel = CancellationToken::new();
    let (send, mut passes) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(run(
        Arc::downgrade(&open),
        handle.clone(),
        service.sessions.clone(),
        service.leases.clone(),
        service.self_writes.scoped(&open.root),
        service.events.clone(),
        cancel.clone(),
        Some(send),
    ));
    let wake = open.actor.markdown_recovery_wake();
    wake.notify_one();
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(10), passes.recv())
            .await
            .unwrap()
            .unwrap(),
        vec![held.clone()]
    );
    assert_eq!(
        open.actor
            .markdown_recovery_candidates("w".into())
            .await
            .unwrap()
            .len(),
        1
    );
    open.actor
        .history_undo_in_turns(
            "w".into(),
            "dohc-operation:delete-target".into(),
            "undo-delete".into(),
            None,
            open.root.clone(),
            Arc::new(NoFaults),
            11,
            [open.capture_apply_gate.clone(), open.session_ops.clone()],
            Arc::new(()),
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let capture = open.capture_apply_gate.lock().await;
    let sessions = open.session_ops.lock().await;
    let epoch = open.actor.markdown_recovery_epoch();
    open.actor
        .reconcile_collections(
            "w".into(),
            "main".into(),
            scratch.path().to_owned(),
            service.leases.clone(),
            Arc::new(()),
            12,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(open.actor.markdown_recovery_epoch() > epoch);
    drop(sessions);
    drop(capture);
    let retried = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let attempts = passes.recv().await.unwrap();
            if !attempts.is_empty() {
                break attempts;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(retried, vec![held.clone()]);
    let pending = open
        .actor
        .markdown_recovery_candidates("w".into())
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].obligation.kind, Kind::Session);
    assert_ne!(pending[0].obligation.order, collection_order);
    assert!(pending[0].obligation.operation_id.starts_with("settle:"));
    wake.notify_one();
    let settle_attempt = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let attempts = passes.recv().await.unwrap();
            if !attempts.is_empty() {
                break attempts;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(settle_attempt, vec![held.clone()]);
    let capture = open.capture_apply_gate.lock().await;
    let sessions = open.session_ops.lock().await;
    let mut head = hex_sha256(b"Original source\n");
    for turn in 0..2 {
        let update = other_doc.plaintext_insert(0, &format!("Edit {turn} "));
        open.actor
            .ydoc_record_update(
                other.clone(),
                "other.txt".into(),
                ContentKind::Plaintext,
                dohc_engine_collab::Regime::LocalOnly,
                update,
                None,
                None,
                other_claim.clone(),
                false,
                None,
                None,
                20 + turn,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
            )
            .await
            .unwrap();
        let saved = open
            .actor
            .ydoc_settle(
                scratch.path().to_owned(),
                other.clone(),
                "other.txt".into(),
                ContentKind::Plaintext,
                other_claim.clone(),
                Some(head),
                "other-owner".into(),
                Arc::new(()),
                30 + turn,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
                None,
            )
            .await
            .unwrap()
            .settled()
            .unwrap();
        head = saved.sha256;
        wake.notify_one();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(10), passes.recv())
                .await
                .expect("completed cleanup scans do not wait for either gate")
                .unwrap()
                .is_empty()
        );
    }
    cancel.cancel();
    task.await.unwrap();
    while let Ok(attempts) = passes.try_recv() {
        assert!(attempts.is_empty());
    }
    drop(sessions);
    drop(capture);
    let store = EngineStore::open_read_only(&db).unwrap();
    let pending = store
        .read_with(|conn| dohc_engine_collab::markdown_write_obligations::pending_in(conn, "w"))
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].kind, Kind::Session);
    assert_eq!(
        dohc_engine_sync::list_refusal_notices(&store, "w")
            .unwrap()
            .len(),
        1
    );
    let persisted = dohc_engine_collab::load_persisted(&store, &held)
        .unwrap()
        .unwrap();
    assert!(persisted.doc.frontmatter_json().get("related").is_none());
    assert!(
        persisted
            .doc
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("Accepted edits stay canonical")
    );
    assert!(store.read_with(|conn| conn.query_row(
        "SELECT settled_update_seq IS NOT head_update_seq FROM ydoc_docs WHERE object_id='held'", [],
        |row| row.get::<_, bool>(0))).unwrap());
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("tasks/a.md")).unwrap(),
        source
    );
    service.workspace_close(Some(handle)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_recovery_undo_keeps_a_dismissed_cleanup_notice_dismissed_while_settlement_is_owed()
 {
    use dohc_engine_domain::{
        DeleteTextFile, reconcile_collections_in_tx, set_collection_adoption_state_in_tx,
    };
    const RECORD: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TARGET: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    let scratch = ScratchDir::new().unwrap();
    let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    crate::root_binding::write_root_binding(scratch.path(), token).unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    store.bind_root_token(token, &NoFaults).unwrap();
    store.write_with(&NoFaults, |tx| tx.execute_batch(
        "INSERT INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES('w','origin','epoch','stream',1);
         INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES('w','origin',0);"
    ).map_err(StorageError::persist_public)).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("w", "main", 1, &NoFaults)
        .unwrap();
    let source = format!("---\nid: {RECORD}\nrelated: {TARGET}\n---\n\nHeld source\n");
    let target = format!("---\nid: {TARGET}\n---\n\nTarget\n");
    std::fs::create_dir_all(scratch.path().join("tasks")).unwrap();
    for (object, path, text) in [
        (
            "schema",
            "tasks/collection.yaml",
            "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
        ),
        ("held", "tasks/a.md", source.as_str()),
        ("target", "tasks/b.md", target.as_str()),
    ] {
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "w".into(),
                    version_id: "main".into(),
                    object_id: object.into(),
                    path: path.into(),
                    text: text.into(),
                    moment_id: object.into(),
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        std::fs::write(scratch.path().join(path), text).unwrap();
    }
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, "w", "main")?;
            set_collection_adoption_state_in_tx(tx, "w", "main", "tasks/a.md", RECORD, "adopted")?;
            set_collection_adoption_state_in_tx(tx, "w", "main", "tasks/b.md", TARGET, "adopted")?;
            Ok::<_, dohc_engine_domain::DomainError>(())
        })
        .unwrap();
    VersionedTextStore::new(&mut store)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: "w".into(),
                version_id: "main".into(),
                path: "tasks/b.md".into(),
                moment_id: "delete-target".into(),
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: Some("dohc-operation:delete-target".into()),
                author_json: None,
                now_ms: 3,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    std::fs::remove_file(scratch.path().join("tasks/b.md")).unwrap();
    let held = DocKey::new("w", "main", "held").unwrap();
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, &source)
        .unwrap();
    doc.richdoc_append_paragraph("Accepted edits stay canonical");
    let wire = yrs::Doc::new();
    wire.get_or_insert_map("meta").insert(
        &mut wire.transact_mut(),
        "dohcMarkdownSourceSha256",
        hex_sha256(source.as_bytes()),
    );
    wire.get_or_insert_map("meta").insert(
        &mut wire.transact_mut(),
        "dohcMarkdownSourceProjectionSha256",
        "f".repeat(64),
    );
    doc.apply(
        &wire
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default()),
    )
    .unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &held,
        ContentKind::Richdoc,
        &doc.encode_full_state(),
        &NoFaults,
        4,
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path='tasks/a.md'", [])
                .map_err(StorageError::persist_public)
        })
        .unwrap();
    drop(store);
    let service = EngineService::new();
    let opened = service
        .workspace_open(
            &RequestContext::unbounded(),
            json!({
                "rootDir":scratch.path(),"workspaceId":"w","captureMode":"none",
            }),
        )
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    open.shutdown_capture().await;
    let result = open
        .actor
        .reconcile_collections(
            "w".into(),
            "main".into(),
            scratch.path().to_owned(),
            service.leases.clone(),
            Arc::new(()),
            10,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.held_documents.len(), 1);
    let pending = open
        .actor
        .markdown_recovery_candidates("w".into())
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].obligation.kind, Kind::RelationCleanup);
    let collection_order = pending[0].obligation.order;
    let notices = open.actor.sync_refusal_notices("w".into()).await.unwrap();
    assert_eq!(notices.len(), 1);
    open.actor
        .dismiss_sync_refusal(
            "w".into(),
            notices[0].notice_id.clone(),
            notices[0].refusal_coordinates.clone(),
        )
        .await
        .unwrap();
    assert!(
        open.actor
            .sync_refusal_notices("w".into())
            .await
            .unwrap()
            .is_empty()
    );
    open.actor
        .history_undo_in_turns(
            "w".into(),
            "dohc-operation:delete-target".into(),
            "undo-delete".into(),
            None,
            open.root.clone(),
            Arc::new(NoFaults),
            11,
            [open.capture_apply_gate.clone(), open.session_ops.clone()],
            Arc::new(()),
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    let (send, mut passes) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(run(
        Arc::downgrade(&open),
        handle.clone(),
        service.sessions.clone(),
        service.leases.clone(),
        service.self_writes.scoped(&open.root),
        service.events.clone(),
        cancel.clone(),
        Some(send),
    ));
    open.actor.markdown_recovery_wake().notify_one();
    let attempts = tokio::time::timeout(std::time::Duration::from_secs(10), passes.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(attempts, vec![held.clone()]);
    cancel.cancel();
    task.await.unwrap();
    let pending = open
        .actor
        .markdown_recovery_candidates("w".into())
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].obligation.kind, Kind::Session);
    assert_ne!(pending[0].obligation.order, collection_order);
    let store = EngineStore::open_read_only(&db).unwrap();
    assert!(
        dohc_engine_sync::list_refusal_notices(&store, "w")
            .unwrap()
            .is_empty()
    );
    assert!(store.read_with(|conn| conn.query_row(
        "SELECT settled_update_seq IS NOT head_update_seq FROM ydoc_docs WHERE object_id='held'", [],
        |row| row.get::<_, bool>(0))).unwrap());
    let persisted = dohc_engine_collab::load_persisted(&store, &held)
        .unwrap()
        .unwrap();
    assert!(persisted.doc.frontmatter_json().get("related").is_none());
    assert!(
        persisted
            .doc
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("Accepted edits stay canonical")
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("tasks/a.md")).unwrap(),
        source
    );
    service.workspace_close(Some(handle)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_recovery_completed_blocker_retries_skipped_work_without_a_document_change() {
    let scratch = ScratchDir::new().unwrap();
    let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    crate::root_binding::write_root_binding(scratch.path(), token).unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    store.bind_root_token(token, &NoFaults).unwrap();
    store.write_with(&NoFaults, |tx| tx.execute_batch(
        "INSERT INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES('w','origin','epoch','stream',1);
         INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES('w','origin',0);"
    ).map_err(StorageError::persist_public)).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("w", "main", 1, &NoFaults)
        .unwrap();
    let held = DocKey::new("w", "main", "held").unwrap();
    let other = DocKey::new("w", "main", "other").unwrap();
    for (key, path, kind) in [
        (&held, "held.md", ContentKind::Richdoc),
        (&other, "other.txt", ContentKind::Plaintext),
    ] {
        let source = "Original source\n";
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "w".into(),
                    version_id: "main".into(),
                    object_id: key.object_id.clone(),
                    path: path.into(),
                    text: source.into(),
                    moment_id: key.object_id.clone(),
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        let doc = Ydoc::wire();
        if kind == ContentKind::Richdoc {
            doc.richdoc_append_paragraph("Held edits stay canonical");
            let wire = yrs::Doc::new();
            let meta = wire.get_or_insert_map("meta");
            meta.insert(
                &mut wire.transact_mut(),
                "dohcMarkdownSourceSha256",
                hex_sha256(source.as_bytes()),
            );
            meta.insert(
                &mut wire.transact_mut(),
                "dohcMarkdownSourceProjectionSha256",
                "f".repeat(64),
            );
            doc.apply(
                &wire
                    .transact()
                    .encode_state_as_update_v1(&yrs::StateVector::default()),
            )
            .unwrap();
        } else {
            doc.plaintext_insert(0, source);
        }
        dohc_engine_collab::claim_base(
            &mut store,
            key,
            kind,
            &doc.encode_full_state(),
            &NoFaults,
            3,
        )
        .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
            "UPDATE ydoc_docs SET path=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            rusqlite::params![key.workspace_id,key.version_id,key.object_id,path])
            .map_err(StorageError::persist_public)
            })
            .unwrap();
        std::fs::write(scratch.path().join(path), source).unwrap();
    }
    let held_claim = dohc_engine_collab::read_marker(&store, &held)
        .unwrap()
        .unwrap()
        .lineage_claim_id
        .unwrap();
    let other_claim = dohc_engine_collab::read_marker(&store, &other)
        .unwrap()
        .unwrap()
        .lineage_claim_id
        .unwrap();
    drop(store);
    let service = EngineService::new();
    let opened = service
        .workspace_open(
            &RequestContext::unbounded(),
            json!({
                "rootDir":scratch.path(),"workspaceId":"w","captureMode":"none",
            }),
        )
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    open.shutdown_capture().await;
    let original_sha = hex_sha256(b"Original source\n");
    assert!(matches!(
        open.actor
            .ydoc_settle(
                scratch.path().to_owned(),
                held.clone(),
                "held.md".into(),
                ContentKind::Richdoc,
                Some(held_claim.clone()),
                Some(original_sha.clone()),
                "held-owner".into(),
                Arc::new(()),
                10,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
                None
            )
            .await,
        Err(RuntimeError::MarkdownWriteHeld { .. })
    ));
    assert!(matches!(
        open.actor
            .ydoc_settle(
                scratch.path().to_owned(),
                held.clone(),
                "held.md".into(),
                ContentKind::Richdoc,
                Some(held_claim),
                Some(original_sha.clone()),
                "collection-relation-cleanup:held:related:target".into(),
                Arc::new(()),
                11,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
                None
            )
            .await,
        Err(RuntimeError::MarkdownWriteHeld { .. })
    ));
    let mut audit = {
        use dohc_engine_collab::markdown_write_obligations::{self as obligations, AuditedRetry};
        let conn = rusqlite::Connection::open(&db).unwrap();
        let owed = obligations::pending_in(&conn, "w")
            .unwrap()
            .into_iter()
            .find(|owed| owed.kind == Kind::Session)
            .unwrap();
        let retry = AuditedRetry {
            namespace: "relay".into(),
            binding: dohc_engine_collab::live_object_binding::LiveObjectBinding {
                workspace_id: "w".into(),
                main_version_id: "main".into(),
                object_id: "held".into(),
                lineage_claim_id: owed.lineage_claim_id.clone(),
                current_path: "held.md".into(),
                selector_paths: vec!["held.md".into()],
                restore_fence_generation: 0,
            },
            terminal_cursor: 1,
            head_update_seq: owed.retry_inputs["headUpdateSeq"].as_i64().unwrap(),
        };
        obligations::record_audited_in(
            &conn,
            &Obligation {
                kind: Kind::AuditedSettle,
                operation_id: retry.operation_id(),
                retry_inputs: serde_json::to_value(&retry).unwrap(),
                ..owed.clone()
            },
            12,
        )
        .unwrap();
        obligations::complete_in(&conn, &owed, 12).unwrap();
        retry
    };
    let cancel = CancellationToken::new();
    let (send, mut passes) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(run(
        Arc::downgrade(&open),
        handle.clone(),
        service.sessions.clone(),
        service.leases.clone(),
        service.self_writes.scoped(&open.root),
        service.events.clone(),
        cancel.clone(),
        Some(send),
    ));
    let wake = open.actor.markdown_recovery_wake();
    wake.notify_one();
    let first = tokio::time::timeout(std::time::Duration::from_secs(10), passes.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first, vec![held.clone()]);
    let capture = open.capture_apply_gate.lock().await;
    let sessions = open.session_ops.lock().await;
    let mut head = original_sha;
    for turn in 0..2 {
        let update = {
            let store = EngineStore::open_read_only(&db).unwrap();
            let doc = dohc_engine_collab::load_persisted(&store, &other)
                .unwrap()
                .unwrap()
                .doc;
            doc.plaintext_insert(0, &format!("Edit {turn} "))
        };
        open.actor
            .ydoc_record_update(
                other.clone(),
                "other.txt".into(),
                ContentKind::Plaintext,
                dohc_engine_collab::Regime::LocalOnly,
                update,
                None,
                None,
                Some(other_claim.clone()),
                false,
                None,
                None,
                20 + turn,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
            )
            .await
            .unwrap();
        let saved = open
            .actor
            .ydoc_settle(
                scratch.path().to_owned(),
                other.clone(),
                "other.txt".into(),
                ContentKind::Plaintext,
                Some(other_claim.clone()),
                Some(head),
                "other-owner".into(),
                Arc::new(()),
                30 + turn,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
                None,
            )
            .await
            .unwrap()
            .settled()
            .unwrap();
        head = saved.sha256;
        wake.notify_one();
        let attempts = tokio::time::timeout(std::time::Duration::from_secs(10), passes.recv())
            .await
            .expect("an unchanged hold scan does not wait for either gate")
            .unwrap();
        assert!(attempts.is_empty());
    }
    while let Ok(attempts) = passes.try_recv() {
        assert!(attempts.is_empty());
    }
    let before = open
        .actor
        .markdown_recovery_candidates("w".into())
        .await
        .unwrap();
    {
        use dohc_engine_collab::markdown_write_obligations as obligations;
        let conn = rusqlite::Connection::open(&db).unwrap();
        audit.terminal_cursor = 2;
        let owed = before
            .iter()
            .find(|row| row.obligation.kind == Kind::AuditedSettle)
            .unwrap()
            .obligation
            .clone();
        obligations::record_audited_in(
            &conn,
            &Obligation {
                retry_inputs: serde_json::to_value(&audit).unwrap(),
                ..owed
            },
            40,
        )
        .unwrap();
        conn.execute("INSERT INTO live_device_settlements VALUES \
            ('covered','relay','w','main','held',?1,0,2,0,?2,0,?3,'held',?3,?3,?4,'{}',40,'ordinary',NULL)",
            rusqlite::params![audit.binding.lineage_claim_id, audit.head_update_seq,
                hex_sha256(b"Original source\n"), serde_json::to_string(&audit.binding).unwrap()]).unwrap();
    }
    let after = open
        .actor
        .markdown_recovery_candidates("w".into())
        .await
        .unwrap();
    assert_ne!(before[0].fingerprint, after[0].fingerprint);
    assert_eq!(before[1].fingerprint, after[1].fingerprint);
    drop(sessions);
    drop(capture);
    wake.notify_one();
    let retried = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let attempts = passes.recv().await.unwrap();
            if !attempts.is_empty() {
                break attempts;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(retried, vec![held.clone(), held.clone()]);
    cancel.cancel();
    task.await.unwrap();
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("held.md")).unwrap(),
        "Original source\n"
    );
    let pending = open
        .actor
        .markdown_recovery_candidates("w".into())
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].obligation.kind, Kind::Session);
    let store = EngineStore::open_read_only(&db).unwrap();
    assert_eq!(
        dohc_engine_collab::read_marker(&store, &held)
            .unwrap()
            .unwrap()
            .head_update_seq,
        audit.head_update_seq
    );
    service.workspace_close(Some(handle)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_recovery_preparation_exhaustion_finishes_without_an_open_session() {
    for queued in [false, true] {
        preparation_exhaustion_without_session(queued, false).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_recovery_preparation_exhaustion_survives_workspace_restart_without_a_session() {
    for queued in [false, true] {
        preparation_exhaustion_without_session(queued, true).await;
    }
}

async fn preparation_exhaustion_without_session(queued: bool, restart: bool) {
    let scratch = ScratchDir::new().unwrap();
    let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    crate::root_binding::write_root_binding(scratch.path(), token).unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let data: Value = serde_json::from_str(include_str!(
        "../../../dohc-engine-collab/tests/reader-resolver.json"
    ))
    .unwrap();
    let source = data["source"].as_str().unwrap().to_owned();
    let key = DocKey::new("w", "main", "note").unwrap();
    let wire = yrs::Doc::new();
    wire.transact_mut()
        .apply_update(
            yrs::Update::decode_v1(
                &STANDARD
                    .decode(data["checkpoint"].as_str().unwrap())
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    wire.get_or_insert_map("meta")
        .remove(&mut wire.transact_mut(), "dohcLineageEpoch");
    let mut store = EngineStore::open(&db, 1).unwrap();
    store.bind_root_token(token, &NoFaults).unwrap();
    store.write_with(&NoFaults, |tx| tx.execute_batch(
        "INSERT INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES('w','origin','epoch','stream',1);
         INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES('w','origin',0);"
    ).map_err(StorageError::persist_public)).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("w", "main", 1, &NoFaults)
        .unwrap();
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "w".into(),
                version_id: "main".into(),
                object_id: "note".into(),
                path: "note.md".into(),
                text: source.clone(),
                moment_id: "source".into(),
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        ContentKind::Richdoc,
        &wire
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default()),
        &NoFaults,
        3,
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path='note.md'", [])
                .map_err(StorageError::persist_public)
        })
        .unwrap();
    let original = dohc_engine_collab::load_persisted(&store, &key)
        .unwrap()
        .unwrap()
        .doc;
    let resolver =
        reader_resolver::ReaderResolver::new(Arc::new(dohc_engine_reader::Reader::new(None)));
    let proof = match store.read_with(|conn| {
        reader_resolver::resolve(
            conn,
            &key,
            &original,
            &original.project(ContentKind::Richdoc)?.content,
            Some(&resolver),
        )
    }) {
        Err(dohc_engine_collab::CollabError::MarkdownReaderPending(proof)) => proof,
        _ => panic!("expected a preparation proof"),
    };
    let before = wire.transact().state_vector();
    wire.get_or_insert_map("meta")
        .remove(&mut wire.transact_mut(), "dohcMarkdownSourceReader");
    let doc = Ydoc::wire();
    doc.apply(&original.encode_full_state()).unwrap();
    doc.apply(&wire.transact().encode_state_as_update_v1(&before))
        .unwrap();
    doc.richdoc_append_paragraph("Accepted edit awaiting preparation");
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::record_update_in_tx(
                tx,
                &key,
                &doc.encode_full_state(),
                None,
                None,
                4,
            )
        })
        .unwrap();
    let marker = dohc_engine_collab::read_marker(&store, &key)
        .unwrap()
        .unwrap();
    drop(store);
    std::fs::write(scratch.path().join("note.md"), &source).unwrap();
    let modified = std::fs::metadata(scratch.path().join("note.md"))
        .unwrap()
        .modified()
        .unwrap();
    let service = EngineService::new();
    let opened = service
        .workspace_open(
            &RequestContext::unbounded(),
            json!({
                "rootDir":scratch.path(),"workspaceId":"w","captureMode":"none",
            }),
        )
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    let gate = open.session_ops.lock().await;
    let reader = Arc::new(dohc_engine_reader::Reader::new(Some(witness_reader(
        &scratch,
        "witness-safe",
    ))));
    open.actor
        .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(
            reader.clone(),
        )))
        .await
        .unwrap();
    let changed_key = key.clone();
    open.actor
        .markdown_settlement_fault_for_harness(
            move |_| Err(dohc_engine_collab::CollabError::MarkdownReaderPending(proof).into()),
            move |store| {
                let doc = dohc_engine_collab::load_persisted(store, &changed_key)?
                    .unwrap()
                    .doc;
                let wire = yrs::Doc::new();
                wire.transact_mut()
                    .apply_update(yrs::Update::decode_v1(&doc.encode_full_state()).unwrap())
                    .unwrap();
                let before = wire.transact().state_vector();
                wire.get_or_insert_map("meta").insert(
                    &mut wire.transact_mut(),
                    "dohcMarkdownSourceProjectionSha256",
                    "f".repeat(64),
                );
                store.write_with(&NoFaults, |tx| {
                    dohc_engine_collab::record_update_in_tx(
                        tx,
                        &changed_key,
                        &wire.transact().encode_state_as_update_v1(&before),
                        None,
                        None,
                        11,
                    )
                })?;
                Ok(())
            },
        )
        .await
        .unwrap();
    let result = if queued {
        open.actor
            .ydoc_settle_queued(
                scratch.path().to_owned(),
                key.clone(),
                "note.md".into(),
                ContentKind::Richdoc,
                marker.lineage_claim_id.clone(),
                Some(hex_sha256(source.as_bytes())),
                "closed-owner".into(),
                Arc::new(()),
                10,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
                None,
            )
            .await
    } else {
        open.actor
            .ydoc_settle(
                scratch.path().to_owned(),
                key.clone(),
                "note.md".into(),
                ContentKind::Richdoc,
                marker.lineage_claim_id.clone(),
                Some(hex_sha256(source.as_bytes())),
                "closed-owner".into(),
                Arc::new(()),
                10,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
                None,
            )
            .await
    };
    assert!(matches!(
        result,
        Err(RuntimeError::Collab(
            dohc_engine_collab::CollabError::MarkdownWitnessCheckPending { .. }
        ))
    ));
    assert!(lock(&service.sessions).is_empty());
    {
        let store = EngineStore::open_read_only(&db).unwrap();
        let owed = store
            .read_with(|conn| dohc_engine_collab::markdown_write_obligations::pending_in(conn, "w"))
            .unwrap();
        assert_eq!(owed.len(), 1);
        assert_eq!(owed[0].kind, Kind::Session);
        assert!(owed[0].held_checkpoint_sha256.is_none());
        assert!(
            dohc_engine_sync::list_refusal_notices(&store, "w")
                .unwrap()
                .is_empty()
        );
        assert_eq!(store.table_row_count("moments").unwrap(), 1);
        assert_eq!(store.table_row_count("materialization_jobs").unwrap(), 0);
        assert_eq!(store.table_row_count("live_device_settlements").unwrap(), 0);
    }
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("note.md")).unwrap(),
        source
    );
    assert_eq!(
        std::fs::metadata(scratch.path().join("note.md"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    let (open, handle, reader) = if restart {
        open.shutdown_capture().await;
        drop(gate);
        service.workspace_close(Some(handle)).await.unwrap();
        drop(open);
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir":scratch.path(),"workspaceId":"w","captureMode":"none",
                }),
            )
            .await
            .unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let open = service.open(Some(&handle)).unwrap();
        let reader = Arc::new(dohc_engine_reader::Reader::new(Some(witness_reader(
            &scratch,
            "witness-safe",
        ))));
        open.actor
            .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(
                reader.clone(),
            )))
            .await
            .unwrap();
        assert!(lock(&service.sessions).is_empty());
        (open, handle, reader)
    } else {
        drop(gate);
        (open, handle, reader)
    };
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            if open
                .actor
                .markdown_recovery_candidates("w".into())
                .await
                .unwrap()
                .is_empty()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the workspace worker completes the save without a session or explicit retry");
    let saved = std::fs::read_to_string(scratch.path().join("note.md")).unwrap();
    assert_eq!(
        saved.matches("Accepted edit awaiting preparation").count(),
        1
    );
    assert_eq!(reader.dispatch_count(), if restart { 1 } else { 2 });
    {
        let store = EngineStore::open_read_only(&db).unwrap();
        assert_eq!(store.table_row_count("moments").unwrap(), 2);
        assert_eq!(store.table_row_count("materialization_jobs").unwrap(), 1);
        assert_eq!(store.table_row_count("live_device_settlements").unwrap(), 0);
        assert_eq!(
            dohc_engine_collab::read_marker(&store, &key)
                .unwrap()
                .unwrap()
                .head_update_seq,
            marker.head_update_seq + 1
        );
    }
    service.workspace_close(Some(handle)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_recovery_notifies_when_reopened_local_consent_clears_the_old_session_hold() {
    let scratch = ScratchDir::new().unwrap();
    let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    crate::root_binding::write_root_binding(scratch.path(), token).unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let source = "- parent\n  - child\n";
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
        .unwrap();
    doc.richdoc_append_paragraph("Local edit awaiting consent");
    let key = DocKey::new("w", "main", "note").unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        store.bind_root_token(token, &NoFaults).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("w", "main", 1, &NoFaults)
            .unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "w".into(),
                    version_id: "main".into(),
                    object_id: "note".into(),
                    path: "note.md".into(),
                    text: source.into(),
                    moment_id: "source".into(),
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &doc.encode_full_state(),
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some("note.md"),
                    content_kind: ContentKind::Richdoc,
                    regime: dohc_engine_collab::Regime::LocalOnly,
                }),
                ..Default::default()
            },
            &NoFaults,
            3,
            |_, _, _| Ok(()),
        )
        .unwrap();
    }
    std::fs::write(scratch.path().join("note.md"), source).unwrap();
    let mut previous_session = None;
    for reopened in [false, true] {
        let service = EngineService::new();
        let mut events = service.events.subscribe_with_wakes();
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({"rootDir":scratch.path(),"workspaceId":"w","captureMode":"none"}),
            )
            .await
            .unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let open = service.open(Some(&handle)).unwrap();
        open.actor
            .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(Arc::new(
                dohc_engine_reader::Reader::new(Some(witness_reader(&scratch, "witness-unsafe"))),
            ))))
            .await
            .unwrap();
        let (session, egress) = service
            .ydoc_open(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({"versionId":"main","path":"note.md","contentKind":"richdoc"}),
                if reopened { 2 } else { 1 },
            )
            .await
            .unwrap();
        drop(egress);
        let id = session["sessionId"].as_str().unwrap().to_owned();
        if reopened {
            assert_ne!(previous_session.as_ref(), Some(&id));
            assert!(
                !open
                    .actor
                    .sync_refusal_notices("w".into())
                    .await
                    .unwrap()
                    .is_empty()
            );
            tokio::time::timeout(std::time::Duration::from_secs(60), async {
                loop {
                    let event = events.recv().await.unwrap();
                    if event.name == crate::events::SYNC_REFUSALS_CHANGED_EVENT
                        && event.payload["workspaceId"] == "w"
                    {
                        break;
                    }
                }
            })
            .await
            .expect("recovery reports the persisted hold before consent");
            let saved = service
                .ydoc_settle(
                    &RequestContext::unbounded(),
                    Some(handle.clone()),
                    json!({"sessionId":id,"allowLossySourceSha256":hex_sha256(source.as_bytes())}),
                )
                .await
                .unwrap();
            assert!(
                saved["content"]
                    .as_str()
                    .unwrap()
                    .contains("Local edit awaiting consent")
            );
            tokio::time::timeout(std::time::Duration::from_secs(60), async {
                loop {
                    let event = events.recv().await.unwrap();
                    if event.name == crate::events::SYNC_REFUSALS_CHANGED_EVENT
                        && event.payload["workspaceId"] == "w"
                        && open
                            .actor
                            .sync_refusal_notices("w".into())
                            .await
                            .unwrap()
                            .is_empty()
                    {
                        break;
                    }
                }
            })
            .await
            .expect("Notices is told when recovery clears the previous session's hold");
            service
                .ydoc_settle(
                    &RequestContext::unbounded(),
                    Some(handle.clone()),
                    json!({"sessionId":id}),
                )
                .await
                .unwrap();
            assert!(
                open
                    .actor
                    .sync_refusal_notices("w".into())
                    .await
                    .unwrap()
                    .is_empty()
            );
            let saved = std::fs::read_to_string(scratch.path().join("note.md")).unwrap();
            assert_eq!(saved.matches("Local edit awaiting consent").count(), 1);
        } else {
            let error = service
                .ydoc_settle(
                    &RequestContext::unbounded(),
                    Some(handle.clone()),
                    json!({"sessionId":id}),
                )
                .await
                .unwrap_err();
            assert_eq!(error.message, "markdown-write-held");
            assert!(
                !open
                    .actor
                    .sync_refusal_notices("w".into())
                    .await
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(
                std::fs::read_to_string(scratch.path().join("note.md")).unwrap(),
                source
            );
        }
        previous_session = Some(id);
        service.workspace_close(Some(handle)).await.unwrap();
    }
}

pub(in crate::rpc) fn witness_reader(
    scratch: &ScratchDir,
    mode: &str,
) -> dohc_engine_reader::Config {
    let node = std::env::var_os("DOHC_READER_TEST_NODE").unwrap_or_else(|| "node".into());
    let output = std::process::Command::new(node).args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output().unwrap();
    assert!(output.status.success());
    let mut runtime: Value = serde_json::from_slice(&output.stdout).unwrap();
    let node = PathBuf::from(
        runtime
            .as_object_mut()
            .unwrap()
            .remove("path")
            .unwrap()
            .as_str()
            .unwrap(),
    );
    runtime["sha256"] = hex_sha256(&std::fs::read(&node).unwrap()).into();
    let mut manifest = json!({"version":1,"runtime":runtime,"buildSha256":"test","parentCwd":std::env::current_dir().unwrap()});
    let script = include_str!("../../../dohc-engine-reader/src/fake.cjs")
        .replace("MANIFEST", &manifest.to_string())
        .replace("MODE", &serde_json::to_string(mode).unwrap());
    static NEXT_READER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = NEXT_READER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let bundle = scratch.path().join(format!("reader-{id}.cjs"));
    std::fs::write(&bundle, &script).unwrap();
    manifest["bundleSha256"] = hex_sha256(script.as_bytes()).into();
    manifest["sources"] = json!([]);
    let manifest_path = scratch.path().join(format!("reader-{id}-manifest.json"));
    std::fs::write(&manifest_path, manifest.to_string()).unwrap();
    dohc_engine_reader::Config {
        node,
        bundle,
        manifest: manifest_path,
    }
}
