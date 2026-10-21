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
        self.open_path("source-0000.md").await
    }
    async fn open_path(&self, path: &str) -> String {
        let (session, blob) = self
            .service
            .ydoc_open(
                &RequestContext::unbounded(),
                Some(self.handle.clone()),
                json!({"versionId":"main","path":path,"contentKind":"richdoc"}),
                101,
            )
            .await
            .unwrap();
        let doc = Ydoc::wire();
        doc.apply(&blob.bytes).unwrap();
        if let Some(seed) = session["seedContent"].as_str() {
            let update = doc.richdoc_wikilinks_for_test(seed).unwrap();
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
        let update = doc.richdoc_wikilinks_for_test(text).unwrap();
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
    open_session_proof(false, "open-rpc-timings.json").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stays_open_oracle_kills_closing_write_sessions_in_the_fence() {
    let started = Instant::now();
    let mutant = tokio::spawn(open_session_proof(true, "unused")).await;
    let mutant_ns = started.elapsed().as_nanos();
    let error = mutant.expect_err("close-write-session mutation survived");
    assert!(error.is_panic());
    let panic = error.into_panic();
    let message = panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&str>().copied());
    assert_eq!(message, Some("Undo closed the write member's session"));
    let started = Instant::now();
    open_session_proof(false, "open-rpc-reverted-timings.json").await;
    let reverted_ns = started.elapsed().as_nanos();
    if let Ok(dir) = std::env::var("DOHC_LINK_REWRITE_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join("open-session-mutation.json"),
            json!({"closeWriteSessions":"killed","reverted":"passed","mutantNs":mutant_ns,"revertedNs":reverted_ns}).to_string(),
        )
        .unwrap();
    }
}
async fn open_session_proof(mutate: bool, timing_file: &str) {
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
        crate::rpc::versions::mutate_close_write_session(sid.clone());
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
                std::path::Path::new(&dir).join(timing_file),
                json!({"forwardNs":forward_ns,"undoNs":undo_ns}).to_string(),
            )
            .unwrap();
        }
    }
    assert!(stays_open, "Undo closed the write member's session");
    assert!(inverse_resync);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_undo_closes_an_untouched_copy_before_removing_it() {
    duplicate_open_copy_proof(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_undo_closes_an_edited_copy_and_preserves_mains_guard() {
    duplicate_open_copy_proof(true).await;
}

async fn duplicate_open_copy_proof(edited: bool) {
    let f = fixture().await;
    let operation = "dohc-operation:open-copy";
    let copy = f
        .open
        .actor
        .duplicate_file(
            dohc_engine_domain::DuplicateFile {
                workspace_id: WS.into(),
                version_id: "main".into(),
                from_path: "source-0000.md".into(),
                to_path: "copy.md".into(),
                operation_id: operation.into(),
                author_json: None,
                now_ms: 5,
            },
            f.open.root.clone(),
            Arc::new(NoFaults),
        )
        .await
        .unwrap();
    let object = copy.moments[0].object_id.clone();
    let original = copy.moments[0].moment_id.clone();
    let placed = f
        .open
        .actor
        .history_undo_place(
            WS.into(),
            dohc_engine_runtime::HistoryUndoResult {
                operation_id: operation.into(),
                version_id: copy.version_id,
                moments: copy.moments,
                compensation_operation_id: operation.into(),
                deduped: false,
                materialized: false,
                not_restored: vec![],
            },
            f.open.root.clone(),
            Arc::new(f.service.self_writes.scoped(&f.open.root)),
            6,
            |_| {},
        )
        .await;
    assert!(placed.materialized);
    let sid = f.open_path("copy.md").await;
    if edited {
        f.edit(&sid, "typed copy [[old#part|label]]").await;
    }
    let key = lock(&f.service.sessions).get(&sid).unwrap().key.clone();
    let reader = EngineStore::open_read_only(&engine_db_path(&f.root).unwrap()).unwrap();
    let projection = reader
        .read_with(|c| dohc_engine_collab::load_doc_in(c, &key))
        .unwrap()
        .project(ContentKind::Richdoc)
        .unwrap();
    let expected_settle = format!(
        "moment-ydoc-{}",
        dohc_engine_storage::hex_sha256(
            format!(
                "{}\0main\0{}\0copy.md\0{}\0{}\0{}",
                WS, object, sid, original, projection.source_state_vector_sha256
            )
            .as_bytes()
        )
    );
    let result = f
        .transport
        .call(
            RequestContext::unbounded(),
            Request {
                id: 110,
                method: "history.undo".into(),
                workspace: Some(f.handle.clone()),
                deadline_ms: None,
                idempotency_key: Some("undo-open-copy".into()),
                progress: false,
                params: json!({"operationId": operation}),
            },
        )
        .await;
    let closed = !lock(&f.service.sessions).contains_key(&sid);
    if closed && !edited && result.is_ok() {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while f.service.leases.scoped(&f.open.root).is_held(&key) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Duplicate Undo placement did not release its lease");
    }
    let exists = f.root.join("copy.md").exists();
    let moments: Vec<String> = reader
        .read_with(|c| {
            c.prepare(
                "SELECT moment_id FROM moments WHERE object_id=?1 AND metadata_origin='ydoc'",
            )?
            .query_map([object], |r| r.get(0))?
            .collect::<Result<_, _>>()
        })
        .unwrap();
    drop(reader);
    f.service.workspace_close(Some(f.handle)).await.unwrap();
    assert!(closed, "Duplicate Undo left the copy's session open");
    assert_eq!(
        moments,
        if edited {
            vec![expected_settle]
        } else {
            vec![]
        },
        "Duplicate must only settle in its closing fence, never as a link baseline"
    );
    if edited {
        let error = result.expect_err("changed copy must retain main's guarded delete");
        assert!(
            error.message.contains("copy changed after Duplicate"),
            "{error:?}"
        );
        assert!(exists);
    } else {
        assert_eq!(result.unwrap().result["notRestored"], json!([]));
        assert!(!exists);
    }
}
