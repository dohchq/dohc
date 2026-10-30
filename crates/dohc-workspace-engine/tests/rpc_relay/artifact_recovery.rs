use super::*;
use dohc_engine_collab::{CollabError, ContentKind, DocKey, reader_resolver::ReaderResolver};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReaderState {
    Ready,
    Unavailable,
    Unresponsive,
}

fn witness_reader(scratch: &ScratchDir, mode: &str) -> dohc_engine_reader::Config {
    static NEXT_READER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let reader_id = NEXT_READER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let node = std::env::var_os("DOHC_READER_TEST_NODE").unwrap_or_else(|| "node".into());
    let output = std::process::Command::new(node).args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output().unwrap();
    assert!(output.status.success());
    let mut runtime: Value = serde_json::from_slice(&output.stdout).unwrap();
    let node = std::path::PathBuf::from(
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
    let bundle = scratch.path().join(format!("reader-{reader_id}.cjs"));
    std::fs::write(&bundle, &script).unwrap();
    manifest["bundleSha256"] = hex_sha256(script.as_bytes()).into();
    manifest["sources"] = json!([]);
    let manifest_path = scratch
        .path()
        .join(format!("reader-manifest-{reader_id}.json"));
    std::fs::write(&manifest_path, manifest.to_string()).unwrap();
    dohc_engine_reader::Config {
        node,
        bundle,
        manifest: manifest_path,
    }
}

fn cold_reader(
    reader_root: &ScratchDir,
    notes: &[(String, DocKey, Ydoc)],
    reader_state: ReaderState,
) -> (Arc<ReaderResolver>, dohc_engine_reader::Config) {
    let mut config = witness_reader(
        reader_root,
        if reader_state == ReaderState::Unresponsive {
            "startup-hang"
        } else {
            "witness-safe"
        },
    );
    if reader_state == ReaderState::Unavailable {
        config.node = reader_root.path().join("missing-reader");
    }
    let resolver = Arc::new(ReaderResolver::new(Arc::new(
        dohc_engine_reader::Reader::new(Some(config.clone())),
    )));
    for (path, key, doc) in notes {
        if !doc.has_markdown_witness() {
            continue;
        }
        assert!(
            matches!(
                resolver.check_witness(doc, key, path),
                Err(CollabError::MarkdownWitnessCheckPending { .. })
            ),
            "the note's check must still be pending before recovery"
        );
    }
    (resolver, config)
}

async fn install_cold_reader(
    scratch: &ScratchDir,
    reader_root: &ScratchDir,
    notes: &[(String, DocKey, Ydoc)],
    reader_state: ReaderState,
) {
    let (resolver, _) = cold_reader(reader_root, notes, reader_state);
    let opened = WorkspaceSupervisor::global()
        .open(&engine_db_path(scratch).unwrap(), 100)
        .unwrap();
    opened
        .actor
        .configure_reader_resolver(resolver)
        .await
        .unwrap();
}

async fn assert_note_recovery(restart: bool, workaround: bool, reader_state: ReaderState) {
    let unavailable = reader_state != ReaderState::Ready;
    let workspace = "rpc-note-recovery";
    let relay = FakeRelay::start(RelayState::default());
    let reader_root = ScratchDir::new().unwrap();
    let b_scratch = ScratchDir::new().unwrap();
    let b_service = Arc::new(EngineService::new());
    b_service.configure_reader(witness_reader(&reader_root, "witness-safe"));
    let b_transport = InProcessTransport::new(Arc::clone(&b_service));
    let b = open_uncaptured_workspace(&b_transport, &b_scratch, &relay, workspace).await;
    let mut b_id = 1;
    seed_main(&b_transport, &b, &mut b_id, workspace).await;
    seed_sync_identity(&b_transport, &b, &mut b_id, workspace).await;
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({"workspaceId":workspace}),
    )
    .await;
    let mut notes = Vec::new();
    let mut sessions_b = Vec::new();
    // Opening several notes must keep all their files recoverable.
    for index in 0..if restart {
        if unavailable { 4 } else { 6 }
    } else if workaround {
        1
    } else {
        2
    } {
        let path = format!("notes/shared-{index}.md");
        let opened = call(
            &b_transport,
            &b,
            &mut b_id,
            "ydoc.open",
            json!({"versionId":"main","path":path,"contentKind":"richdoc"}),
        )
        .await;
        let session = opened["sessionId"].as_str().unwrap().to_owned();
        let doc = Ydoc::wire();
        let source = format!("Before {index}");
        let update = if unavailable && index > 0 {
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, &source)
        } else {
            doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, &source)
        }
        .unwrap();
        let claim = call(&b_transport, &b, &mut b_id, "ydoc.recordUpdate", json!({"expectedLineageClaimId":opened["lineageClaimId"],"sessionId":session,"updateBase64":base64::engine::general_purpose::STANDARD.encode(update)})).await["lineageClaimId"].clone();
        let settled = call(
            &b_transport,
            &b,
            &mut b_id,
            "ydoc.settle",
            json!({"sessionId":session}),
        )
        .await;
        journal_editor_settlement(&b_scratch, workspace, settled["momentId"].as_str().unwrap());
        let db = Connection::open(engine_db_path(&b_scratch).unwrap()).unwrap();
        let object: String = db
            .query_row(
                "SELECT object_id FROM ydoc_docs WHERE path=?1",
                [&path],
                |r| r.get(0),
            )
            .unwrap();
        notes.push((path, DocKey::new(workspace, "main", object).unwrap(), doc));
        sessions_b.push((session, claim, source));
    }
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({"workspaceId":workspace}),
    )
    .await;
    publish_pushed_ops(&relay, workspace, &b_scratch);
    let a_scratch = ScratchDir::new().unwrap();
    let mut a_service = Arc::new(EngineService::new());
    let mut a_transport = InProcessTransport::new(Arc::clone(&a_service));
    let mut a = open_uncaptured_workspace(&a_transport, &a_scratch, &relay, workspace).await;
    let mut a_id = 1;
    seed_main(&a_transport, &a, &mut a_id, workspace).await;
    seed_sync_identity(&a_transport, &a, &mut a_id, workspace).await;
    call(
        &a_transport,
        &a,
        &mut a_id,
        "sync.claim",
        json!({"workspaceId":workspace}),
    )
    .await;
    pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
    let mut sessions_a = Vec::new();
    for (path, _, _) in &notes {
        let opened = call(
            &a_transport,
            &a,
            &mut a_id,
            "ydoc.open",
            json!({"versionId":"main","path":path,"contentKind":"richdoc"}),
        )
        .await;
        sessions_a.push(opened["sessionId"].as_str().unwrap().to_owned());
    }
    for ((_, _, doc), (session, _, _)) in notes.iter().zip(&sessions_b) {
        b_id += 1;
        let loaded = service_call_with_busy_retry(
            b_service.as_ref(),
            RequestContext::unbounded().with_capability("blobs"),
            request(
                b_id,
                "ydoc.resync",
                Some(b.clone()),
                json!({"sessionId":session}),
            ),
        )
        .await
        .unwrap();
        doc.apply(&loaded.blob_egress.unwrap().bytes).unwrap();
        let claim = &loaded.response.result["lineageClaimId"];
        call(&b_transport, &b, &mut b_id, "ydoc.recordUpdate", json!({"expectedLineageClaimId":claim,"sessionId":session,"updateBase64":base64::engine::general_purpose::STANDARD.encode(doc.richdoc_append_paragraph("Accepted remote edit"))})).await;
        let settled = call(
            &b_transport,
            &b,
            &mut b_id,
            "ydoc.settle",
            json!({"sessionId":session}),
        )
        .await;
        journal_editor_settlement(&b_scratch, workspace, settled["momentId"].as_str().unwrap());
    }
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({"workspaceId":workspace}),
    )
    .await;
    publish_pushed_ops(&relay, workspace, &b_scratch);
    pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
    for ((path, _, _), (_, _, source)) in notes.iter().zip(&sessions_b) {
        assert_eq!(
            std::fs::read_to_string(a_scratch.path().join(path)).unwrap(),
            *source,
            "the live session still holds the file"
        );
    }
    let db = Connection::open(engine_db_path(&a_scratch).unwrap()).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM ydoc_pending_artifacts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        notes.len() as i64
    );
    drop(db);
    if restart {
        drop(a_transport);
        drop(a_service);
        let db = engine_db_path(&a_scratch).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while WorkspaceSupervisor::global()
                .generation_of(&db)
                .unwrap()
                .is_some()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropped engine must release its store actor");
        let (_, config) = cold_reader(&reader_root, &notes, reader_state);
        a_service = Arc::new(EngineService::new());
        a_service.configure_reader(config);
        a_transport = InProcessTransport::new(Arc::clone(&a_service));
        write_root_binding(a_scratch.path(), TOKEN).unwrap();
        let started = std::time::Instant::now();
        let opened = call_with_busy_retry(
            &a_transport,
            RequestContext::unbounded(),
            request(1, "workspace.open", None, json!({
                "rootDir":a_scratch.path().to_string_lossy(),
                "workspaceId":workspace,
                "captureMode":"none",
                "reconcileCollections":false,
                "relay":{"baseUrl":relay.base_url,"bearerToken":BEARER,"allowInsecureLoopbackForTests":true}
            })),
        ).await;
        eprintln!(
            "full workspace.open ({reader_state:?}): {:?}; success={}",
            started.elapsed(),
            opened.is_ok()
        );
        a = serde_json::from_value(opened.expect("open workspace").result["workspace"].clone())
            .unwrap();
        if !unavailable {
            let waiting = notes
                .iter()
                .filter(|(path, _, _)| {
                    !std::fs::read_to_string(a_scratch.path().join(path))
                        .unwrap()
                        .contains("Accepted remote edit")
                })
                .count();
            assert_eq!(
                waiting,
                notes.len(),
                "open leaves every cold note's file waiting for sync"
            );
            for _ in 0..waiting {
                pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
            }
        } else {
            pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
        }
    } else {
        for session in sessions_a {
            call(
                &a_transport,
                &a,
                &mut a_id,
                "ydoc.evict",
                json!({"sessionId":session}),
            )
            .await;
        }
        install_cold_reader(&a_scratch, &reader_root, &notes, reader_state).await;
        if workaround {
            a_id += 1;
            let first = call_with_busy_retry(
                &a_transport,
                RequestContext::unbounded(),
                request(
                    a_id,
                    "sync.pull",
                    Some(a.clone()),
                    json!({"workspaceId":workspace}),
                ),
            )
            .await;
            eprintln!("sync before opening the note: {first:?}");
            if let Err(error) = first {
                assert_eq!(error.code, ErrorCode::Internal);
            }
            let opened = call(
                &a_transport,
                &a,
                &mut a_id,
                "ydoc.open",
                json!({"versionId":"main","path":notes[0].0,"contentKind":"richdoc"}),
            )
            .await;
            let session = opened["sessionId"].as_str().unwrap();
            a_id += 1;
            let loaded = service_call_with_busy_retry(
                a_service.as_ref(),
                RequestContext::unbounded().with_capability("blobs"),
                request(
                    a_id,
                    "ydoc.resync",
                    Some(a.clone()),
                    json!({"sessionId":session}),
                ),
            )
            .await
            .unwrap();
            let doc = Ydoc::wire();
            doc.apply(&loaded.blob_egress.unwrap().bytes).unwrap();
            assert!(
                doc.project(ContentKind::Richdoc)
                    .unwrap()
                    .content
                    .contains("Accepted remote edit")
            );
            call(
                &a_transport,
                &a,
                &mut a_id,
                "ydoc.settle",
                json!({"sessionId":session}),
            )
            .await;
            call(
                &a_transport,
                &a,
                &mut a_id,
                "ydoc.close",
                json!({"sessionId":session}),
            )
            .await;
        }
        pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
        if !workaround {
            assert_eq!(
                std::fs::read_to_string(a_scratch.path().join(&notes[0].0)).unwrap(),
                notes[0].2.project(ContentKind::Richdoc).unwrap().content,
                "sync writes the ready note while another note's check waits"
            );
            // A later pass finishes the other note's waiting file.
            pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
        }
    }
    for (index, (path, _, doc)) in notes.iter().enumerate() {
        let expected = doc.project(ContentKind::Richdoc).unwrap().content;
        assert!(expected.contains("Accepted remote edit"));
        let file = std::fs::read_to_string(a_scratch.path().join(path)).unwrap();
        if unavailable && index == 0 {
            assert_eq!(file, sessions_b[0].2);
        } else {
            assert_eq!(file, expected);
        }
    }
    call(&b_transport,&b,&mut b_id,"versionedText.write",json!({"versionId":"main","objectId":"other","path":"other.md","text":"Later incoming work","momentId":"other-moment","origin":"api","nowMs":210})).await;
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({"workspaceId":workspace}),
    )
    .await;
    publish_pushed_ops(&relay, workspace, &b_scratch);
    pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
    assert_eq!(
        std::fs::read_to_string(a_scratch.path().join("other.md")).unwrap(),
        "Later incoming work"
    );
    let db = Connection::open(engine_db_path(&a_scratch).unwrap()).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM ydoc_pending_artifacts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        i64::from(unavailable)
    );
    call(&a_transport, &a, &mut a_id, "workspace.close", json!({})).await;
    call(&b_transport, &b, &mut b_id, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_workspace_keeps_syncing_after_a_live_note_session_ends() {
    assert_note_recovery(false, false, ReaderState::Ready).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_workspace_opens_after_a_restart_with_notes_waiting_for_their_files() {
    assert_note_recovery(true, false, ReaderState::Ready).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn opening_and_saving_a_note_lets_the_workspace_sync_again() {
    assert_note_recovery(false, true, ReaderState::Ready).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_workspace_opens_when_a_note_check_never_finishes() {
    assert_note_recovery(true, false, ReaderState::Unavailable).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_workspace_opens_when_its_note_reader_does_not_answer() {
    assert_note_recovery(true, false, ReaderState::Unresponsive).await;
}
