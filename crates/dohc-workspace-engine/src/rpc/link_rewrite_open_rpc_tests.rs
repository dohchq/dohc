use super::*;
use base64::Engine as _;
use dohc_engine_collab::{ContentKind, Ydoc};

struct OpenFixture {
    root: ScratchDir,
    service: Arc<EngineService>,
    transport: InProcessTransport<EngineService>,
    handle: WorkspaceHandle,
    open: Arc<crate::rpc::workspace::OpenWorkspace>,
}
async fn fixture() -> OpenFixture {
    let sources = 3;
    let root = ScratchDir::new().unwrap();
    let binding = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    crate::root_binding::write_root_binding(&root, binding).unwrap();
    let db = engine_db_path(&root).unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    store.bind_root_token(binding, &NoFaults).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .unwrap();
    let files = if sources == 2000 { 4999 } else { sources };
    store
        .write_with(&NoFaults, |tx| -> Result<(), DomainError> {
            for i in 0..files {
                let path = format!("source-{i:04}.md");
                let body = if i < sources { BODY } else { "no links" };
                write_text_in_tx(
                    tx,
                    &write(&format!("source-{i:04}"), &path, body, &format!("seed-{i}")),
                )?;
                std::fs::write(root.join(path), body).unwrap();
            }
            write_text_in_tx(tx, &write("target", "old.md", "target body", "seed-target"))?;
            tx.execute("INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) SELECT workspace_id,version_id,object_id,1 FROM snapshots WHERE workspace_id=?1 AND version_id='main' ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1", [WS]).unwrap();
            Ok(())
        })
        .unwrap();
    std::fs::write(root.join("old.md"), "target body").unwrap();
    drop(store);
    // Keep the pending-job proof independent of background watcher scheduling.
    // The RPC still runs its real fence, reconcile, compensation, and placement.
    let probe = crate::capture_driver::CaptureApplyProbe::default();
    let service = Arc::new(EngineService::with_capture_apply_probe_for_harness(
        probe.clone(),
    ));
    let transport = InProcessTransport::new(service.clone());
    let opened = service
        .workspace_open(
            &RequestContext::unbounded(),
            json!({"rootDir":root.to_string_lossy(),"workspaceId":WS}),
        )
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    let _links_hold = open.actor.hold_link_drain();
    lock(&open.capture).as_ref().unwrap().request_shutdown();
    // Wait for the in-flight apply to leave before creating pending jobs.
    drop(open.capture_apply_gate.lock().await);
    std::fs::rename(root.join("old.md"), root.join("new.md")).unwrap();
    open.actor
        .versioned_text_rename(
            RenameTextFile {
                workspace_id: WS.into(),
                version_id: "main".into(),
                from_path: "old.md".into(),
                to_path: "new.md".into(),
                moment_id: "rename".into(),
                request_id: None,
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: Some(OP.into()),
                author_json: None,
                now_ms: 2,
            },
            open.root.clone(),
            Arc::new(service.self_writes.scoped(&open.root)),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    OpenFixture {
        root,
        service,
        transport,
        handle,
        open,
    }
}
impl OpenFixture {
    async fn open_document(&self) -> String {
        let (session, blob) = self
            .service
            .ydoc_open(
                &RequestContext::unbounded(),
                Some(self.handle.clone()),
                json!({"versionId":"main","path":"source-0000.md","contentKind":"richdoc"}),
                101,
            )
            .await
            .unwrap();
        let doc = Ydoc::wire();
        doc.apply(&blob.bytes).unwrap();
        if let Some(seed) = session["seedContent"].as_str() {
            let update = doc
                .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, seed)
                .unwrap();
            self.service
                .ydoc_record_update(
                    &RequestContext::unbounded(),
                    Some(self.handle.clone()),
                    Some("ordinary-seed".into()),
                    json!({"sessionId":session["sessionId"],"seed":true,
                    "expectedLineageClaimId":session["lineageClaimId"],
                    "updateBase64":base64::engine::general_purpose::STANDARD.encode(update)}),
                )
                .await
                .unwrap();
        }
        session["sessionId"].as_str().unwrap().into()
    }
    async fn edit(&self, sid: &str, text: &str) {
        let key = lock(&self.service.sessions).get(sid).unwrap().key.clone();
        let reader = EngineStore::open_read_only(&engine_db_path(&self.root).unwrap()).unwrap();
        let doc = reader
            .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
            .unwrap();
        let update = doc
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, text)
            .unwrap();
        let claim = lock(&self.service.sessions)
            .get(sid)
            .unwrap()
            .lineage_claim_id
            .clone();
        self.service
            .ydoc_record_update(
                &RequestContext::unbounded(),
                Some(self.handle.clone()),
                Some("typing".into()),
                json!({"sessionId":sid,"expectedLineageClaimId":claim,
                "updateBase64":base64::engine::general_purpose::STANDARD.encode(update)}),
            )
            .await
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rpc_open_source_stays_open_through_rewrite_and_undo() {
    open_session_proof(false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stays_open_oracle_kills_closing_write_sessions_in_the_fence() {
    let mutant = tokio::spawn(open_session_proof(true)).await;
    let error = mutant.expect_err("close-write-session mutation survived");
    assert!(error.is_panic());
    let panic = error.into_panic();
    let message = panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&str>().copied());
    assert_eq!(message, Some("Undo closed the write member's session"));
    if let Ok(dir) = std::env::var("DOHC_LINK_REWRITE_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join("open-session-mutation.json"),
            r#"{"closeWriteSessions":"killed"}"#,
        )
        .unwrap();
    }
}
async fn open_session_proof(mutate: bool) {
    let f = fixture().await;
    let sid = f.open_document().await;
    let mut events = f.service.events().subscribe();
    let start = Instant::now();
    let rewritten = rpc(
        &f.transport,
        &f.handle,
        "history.rewriteLinks",
        "open-forward",
    )
    .await;
    let forward_ns = start.elapsed().as_nanos();
    assert_eq!(rewritten["documents"], 3);
    assert_eq!(rewritten["complete"], true);
    assert!(lock(&f.service.sessions).contains_key(&sid));
    let mut forward_resync = false;
    while let Ok(event) = events.try_recv() {
        forward_resync |= event.name == "ydoc.remoteUpdate"
            && event.payload["sessionId"] == sid
            && event.payload["resyncRequired"] == true;
    }
    assert!(forward_resync);
    f.edit(
        &sid,
        "typing [[new#part|edited label]] [[./new.md]] [old](old.md) [[new]]",
    )
    .await;
    if mutate {
        super::super::versions::mutate_close_write_session(sid.clone());
    }
    let start = Instant::now();
    let undone = rpc(&f.transport, &f.handle, "history.undo", "open-undo").await;
    let undo_ns = start.elapsed().as_nanos();
    assert_eq!(undone["notRestored"], json!([]));
    assert_eq!(undone["momentCount"], 4);
    let stays_open = lock(&f.service.sessions).contains_key(&sid);
    let mut inverse_resync = false;
    while let Ok(event) = events.try_recv() {
        inverse_resync |= event.name == "ydoc.remoteUpdate"
            && event.payload["sessionId"] == sid
            && event.payload["resyncRequired"] == true;
    }
    let text = f
        .open
        .actor
        .versioned_text_read(
            WS.into(),
            "main".into(),
            "source-0000.md".into(),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap()
        .text;
    assert_eq!(
        text,
        "typing [[old#part|edited label]] [[./old.md]] [old](old.md) [[new]]"
    );
    if !mutate {
        let key = lock(&f.service.sessions).get(&sid).unwrap().key.clone();
        let reader = EngineStore::open_read_only(&engine_db_path(&f.root).unwrap()).unwrap();
        let doc = reader
            .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
            .unwrap();
        assert!(
            doc.project(ContentKind::Richdoc)
                .unwrap()
                .content
                .contains(&text)
        );
    }
    f.service.workspace_close(Some(f.handle)).await.unwrap();
    if !mutate {
        if let Ok(dir) = std::env::var("DOHC_LINK_REWRITE_EVIDENCE_DIR") {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                std::path::Path::new(&dir).join("open-rpc-timings.json"),
                json!({"forwardNs":forward_ns,"undoNs":undo_ns}).to_string(),
            )
            .unwrap();
        }
    }
    assert!(stays_open, "Undo closed the write member's session");
    assert!(inverse_resync);
}
