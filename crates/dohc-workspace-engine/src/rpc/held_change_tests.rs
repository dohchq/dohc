use crate::EngineService;
use dohc_engine_collab::{ContentKind, DocKey, Ydoc, reader_resolver};
use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_protocol::{
    transport::RequestContext,
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_runtime::{CancellationToken, RuntimeError};
use dohc_engine_storage::{EngineStore, NoFaults, StorageError, hex_sha256};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use serde_json::{Value, json};
use std::sync::Arc;

async fn held_request(
    service: &EngineService,
    handle: &WorkspaceHandle,
    action: &str,
    token: Option<&str>,
) -> Value {
    let mut params = json!({"path":"note.md", "action":action});
    if let Some(token) = token {
        params["token"] = json!(token);
        params["author"] = if action == "undo" {
            json!({"kind":"agent","agentId":"undo-agent","onBehalfOf":"local-owner"})
        } else {
            json!({"kind":"human","humanId":"local-owner"})
        };
    }
    service
        .dispatch(
            RequestContext::unbounded(),
            Request {
                id: 1,
                method: "documents.heldChange".into(),
                workspace: Some(handle.clone()),
                deadline_ms: None,
                idempotency_key: None,
                params,
                progress: false,
            },
        )
        .await
        .expect("held change RPC must be available to the local owner")
        .response
        .result
}

// This case uses only pre-existing APIs and a wire method name, so the same
// test can run against main without copying the implementation under test.
#[tokio::test]
async fn held_drop_rpc_preserves_history_and_undo_without_writing_the_file() {
    let scratch = ScratchDir::new().unwrap();
    let binding_token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    crate::root_binding::write_root_binding(scratch.path(), binding_token).unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let source = "- parent\n  - child\n";
    let waiting = "Waiting edits to preserve in History";
    let key = DocKey::new("drop-proof", "main", "note").unwrap();
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
        .unwrap();
    doc.richdoc_append_paragraph(waiting);
    let claim;
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        store.bind_root_token(binding_token, &NoFaults).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("drop-proof", "main", 1, &NoFaults)
            .unwrap();
        dohc_engine_sync::create_claim_identity(
            &mut store,
            "drop-proof",
            "owner",
            "epoch",
            "stream",
            1,
            &NoFaults,
        )
        .unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "drop-proof".into(),
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
        dohc_engine_collab::claim_base(
            &mut store,
            &key,
            ContentKind::Richdoc,
            &doc.encode_full_state(),
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
        claim = dohc_engine_collab::read_marker(&store, &key)
            .unwrap()
            .unwrap()
            .lineage_claim_id;
    }
    let file = scratch.path().join("note.md");
    std::fs::write(&file, source).unwrap();
    let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
    let service = EngineService::new();
    let opened = service
        .workspace_open(
            &RequestContext::unbounded(),
            json!({
                "rootDir":scratch.path(), "workspaceId":"drop-proof", "captureMode":"none",
            }),
        )
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    open.actor
        .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(Arc::new(
            dohc_engine_reader::Reader::new(Some(super::markdown_recovery::tests::witness_reader(
                &scratch,
                "witness-unsafe",
            ))),
        ))))
        .await
        .unwrap();
    let held = open
        .actor
        .ydoc_settle(
            scratch.path().to_owned(),
            key.clone(),
            "note.md".into(),
            ContentKind::Richdoc,
            claim,
            Some(hex_sha256(source.as_bytes())),
            "proof-session".into(),
            Arc::new(()),
            10,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
            None,
        )
        .await;
    assert!(
        matches!(held, Err(RuntimeError::MarkdownWriteHeld { .. })),
        "{held:?}"
    );
    let review = held_request(&service, &handle, "review", None).await;
    let (session, egress) = service
        .ydoc_open(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            json!({"versionId":"main","path":"note.md","contentKind":"richdoc",
            "allowLossySourceSha256":hex_sha256(source.as_bytes())}),
            2,
        )
        .await
        .unwrap();
    drop(egress);
    let session_id = session["sessionId"].as_str().unwrap();
    let original_consent = crate::lock(&service.sessions)[session_id]
        .conversion_consent
        .clone()
        .unwrap();
    let refused = service
        .dispatch(
            RequestContext::unbounded(),
            Request {
                id: 3,
                method: "documents.heldChange".into(),
                workspace: Some(handle.clone()),
                deadline_ms: None,
                idempotency_key: None,
                progress: false,
                params: json!({"path":"note.md","action":"drop","token":"stale",
            "author":{"kind":"human","humanId":"local-owner"}}),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, dohc_engine_protocol::ErrorCode::InvalidParams);
    assert_eq!(refused.message, "held-change-stale");
    assert!(
        original_consent.is_consumed(),
        "in-flight consent clones stay revoked"
    );
    let restored_consent = {
        let sessions = crate::lock(&service.sessions);
        let session = &sessions[session_id];
        let consent = session
            .conversion_consent
            .clone()
            .expect("a refused Drop keeps session consent");
        let source_sha = hex_sha256(source.as_bytes());
        assert!(consent.permits(
            &key,
            session_id,
            session.lineage_claim_id.as_deref(),
            session.restore_generation,
            Some(&source_sha),
            session.open_head_sha.as_deref()
        ));
        assert!(!consent.permits(
            &key,
            "another-session",
            session.lineage_claim_id.as_deref(),
            session.restore_generation,
            Some(&source_sha),
            session.open_head_sha.as_deref()
        ));
        consent
    };
    let dropped = held_request(&service, &handle, "drop", review["token"].as_str()).await;
    assert_eq!(dropped["held"], false);
    assert!(restored_consent.is_consumed());
    assert!(
        crate::lock(&service.sessions)[session_id]
            .conversion_consent
            .is_none()
    );
    let history = dropped["historyMomentId"].as_str().unwrap().to_owned();
    {
        let mut store = EngineStore::open_read_only(&db).unwrap();
        let live = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap()
            .doc;
        assert!(
            !live
                .project(ContentKind::Richdoc)
                .unwrap()
                .content
                .contains(waiting)
        );
        assert!(
            store
                .read_with(
                    |conn| dohc_engine_collab::markdown_write_obligations::pending_in(
                        conn,
                        "drop-proof"
                    )
                )
                .unwrap()
                .is_empty()
        );
        let moment = VersionedTextStore::new(&mut store)
            .get_moment("drop-proof", &history)
            .unwrap()
            .unwrap();
        assert!(moment.before_text.unwrap().contains(waiting));
        assert_eq!(
            serde_json::from_str::<Value>(moment.author_json.as_deref().unwrap()).unwrap(),
            json!([{"kind":"human","humanId":"local-owner"}])
        );
        assert_eq!(store.table_row_count("materialization_jobs").unwrap(), 0);
    }
    let restored = held_request(&service, &handle, "undo", dropped["token"].as_str()).await;
    assert_eq!(restored["held"], true);
    assert!(
        crate::lock(&service.sessions)[session_id]
            .conversion_consent
            .is_none()
    );
    {
        let mut store = EngineStore::open_read_only(&db).unwrap();
        let moment = VersionedTextStore::new(&mut store)
            .get_moment("drop-proof", restored["historyMomentId"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(moment.author_json.as_deref().unwrap()).unwrap(),
            json!([{"kind":"agent","agentId":"undo-agent","onBehalfOf":"local-owner"}])
        );
        assert!(
            dohc_engine_collab::load_persisted(&store, &key)
                .unwrap()
                .unwrap()
                .doc
                .project(ContentKind::Richdoc)
                .unwrap()
                .content
                .contains(waiting)
        );
        assert!(
            !store
                .read_with(
                    |conn| dohc_engine_collab::markdown_write_obligations::pending_in(
                        conn,
                        "drop-proof"
                    )
                )
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            VersionedTextStore::new(&mut store)
                .read_text("drop-proof", "main", "note.md")
                .unwrap()
                .unwrap()
                .text,
            source
        );
        assert_eq!(store.table_row_count("materialization_jobs").unwrap(), 0);
    }
    assert_eq!(std::fs::read_to_string(&file).unwrap(), source);
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        modified
    );
    service.workspace_close(Some(handle)).await.unwrap();
}
