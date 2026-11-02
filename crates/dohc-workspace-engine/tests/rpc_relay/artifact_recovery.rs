use super::*;
use dohc_engine_collab::{CollabError, ContentKind, DocKey, reader_resolver::ReaderResolver};

const WORKSPACE: &str = "rpc-note-recovery";

const RECOVERY_FAILURE: &str = "dohc could not write this document's changes to its file. Open the document and try saving again.";

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
) -> (
    Arc<ReaderResolver>,
    Arc<dohc_engine_reader::Reader>,
    dohc_engine_reader::Config,
) {
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
    let reader = Arc::new(dohc_engine_reader::Reader::new(Some(config.clone())));
    let resolver = Arc::new(ReaderResolver::new(Arc::clone(&reader)));
    for (path, key, doc) in notes {
        assert!(doc.has_markdown_witness(), "every note keeps its witness");
        assert!(
            matches!(
                resolver.check_witness(doc, key, path),
                Err(CollabError::MarkdownWitnessCheckPending { .. })
            ),
            "the note's check must still be pending before recovery"
        );
    }
    (resolver, reader, config)
}

/// Give the running workspace a cold reader whose checks of `notes` are
/// still to run, as configuring a reader at launch does.
async fn install_cold_reader(
    scratch: &ScratchDir,
    reader_root: &ScratchDir,
    notes: &[(String, DocKey, Ydoc)],
    reader_state: ReaderState,
) -> (Arc<ReaderResolver>, Arc<dohc_engine_reader::Reader>) {
    let (resolver, reader, _) = cold_reader(reader_root, notes, reader_state);
    let opened = WorkspaceSupervisor::global()
        .open(&engine_db_path(scratch).unwrap(), 100)
        .unwrap();
    opened
        .actor
        .configure_reader_resolver(Arc::clone(&resolver))
        .await
        .unwrap();
    (resolver, reader)
}

/// Device B writes notes with Markdown witnesses. Device A had the first
/// `waiting` of them open when B's next edit arrived, so their files wait for
/// sync on A. A never opened the rest.
struct Notes {
    relay: FakeRelay,
    reader_root: ScratchDir,
    b_scratch: ScratchDir,
    b_service: Arc<EngineService>,
    b_transport: InProcessTransport<EngineService>,
    b: WorkspaceHandle,
    b_id: u64,
    a_scratch: ScratchDir,
    a_service: Arc<EngineService>,
    a_transport: InProcessTransport<EngineService>,
    a: WorkspaceHandle,
    a_id: u64,
    notes: Vec<(String, DocKey, Ydoc)>,
    /// B's session, lineage claim and first text for each note.
    sessions_b: Vec<(String, Value, String)>,
    sessions_a: Vec<String>,
}

impl Notes {
    async fn new(waiting: usize, closed: usize) -> Self {
        let relay = FakeRelay::start(RelayState::default());
        let reader_root = ScratchDir::new().unwrap();
        let b_scratch = ScratchDir::new().unwrap();
        let b_service = Arc::new(EngineService::new());
        b_service.configure_reader(witness_reader(&reader_root, "witness-safe"));
        let b_transport = InProcessTransport::new(Arc::clone(&b_service));
        let b = open_uncaptured_workspace(&b_transport, &b_scratch, &relay, WORKSPACE).await;
        let mut b_id = 1;
        seed_main(&b_transport, &b, &mut b_id, WORKSPACE).await;
        seed_sync_identity(&b_transport, &b, &mut b_id, WORKSPACE).await;
        call(
            &b_transport,
            &b,
            &mut b_id,
            "sync.push",
            json!({"workspaceId":WORKSPACE}),
        )
        .await;
        let mut notes = Vec::new();
        let mut sessions_b = Vec::new();
        for index in 0..waiting + closed {
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
            let update = doc
                .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, &source)
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
            journal_editor_settlement(&b_scratch, WORKSPACE, settled["momentId"].as_str().unwrap());
            let db = Connection::open(engine_db_path(&b_scratch).unwrap()).unwrap();
            let object: String = db
                .query_row(
                    "SELECT object_id FROM ydoc_docs WHERE path=?1",
                    [&path],
                    |r| r.get(0),
                )
                .unwrap();
            notes.push((path, DocKey::new(WORKSPACE, "main", object).unwrap(), doc));
            sessions_b.push((session, claim, source));
        }
        call(
            &b_transport,
            &b,
            &mut b_id,
            "sync.push",
            json!({"workspaceId":WORKSPACE}),
        )
        .await;
        publish_pushed_ops(&relay, WORKSPACE, &b_scratch);
        let a_scratch = ScratchDir::new().unwrap();
        let a_service = Arc::new(EngineService::new());
        let a_transport = InProcessTransport::new(Arc::clone(&a_service));
        let a = open_uncaptured_workspace(&a_transport, &a_scratch, &relay, WORKSPACE).await;
        let mut a_id = 1;
        seed_main(&a_transport, &a, &mut a_id, WORKSPACE).await;
        seed_sync_identity(&a_transport, &a, &mut a_id, WORKSPACE).await;
        call(
            &a_transport,
            &a,
            &mut a_id,
            "sync.claim",
            json!({"workspaceId":WORKSPACE}),
        )
        .await;
        pull_materialize_and_commit(&a_transport, &a, &mut a_id, WORKSPACE).await;
        let mut sessions_a = Vec::new();
        for (path, _, _) in &notes[..waiting] {
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
        let mut notes = Self {
            relay,
            reader_root,
            b_scratch,
            b_service,
            b_transport,
            b,
            b_id,
            a_scratch,
            a_service,
            a_transport,
            a,
            a_id,
            notes,
            sessions_b,
            sessions_a,
        };
        notes.edit_on_b(0..waiting).await;
        notes.pull().await;
        for index in 0..waiting {
            assert_eq!(
                notes.file(index),
                notes.sessions_b[index].2,
                "the live session still holds the file"
            );
        }
        assert_eq!(notes.pending_artifacts(), waiting as i64);
        notes
    }

    /// B adds a paragraph to each note in `indexes` and publishes it.
    async fn edit_on_b(&mut self, indexes: std::ops::Range<usize>) {
        for index in indexes {
            let session = &self.sessions_b[index].0;
            self.b_id += 1;
            let loaded = service_call_with_busy_retry(
                self.b_service.as_ref(),
                RequestContext::unbounded().with_capability("blobs"),
                request(
                    self.b_id,
                    "ydoc.resync",
                    Some(self.b.clone()),
                    json!({"sessionId":session}),
                ),
            )
            .await
            .unwrap();
            let doc = &self.notes[index].2;
            doc.apply(&loaded.blob_egress.unwrap().bytes).unwrap();
            let claim = &loaded.response.result["lineageClaimId"];
            call(&self.b_transport, &self.b, &mut self.b_id, "ydoc.recordUpdate", json!({"expectedLineageClaimId":claim,"sessionId":session,"updateBase64":base64::engine::general_purpose::STANDARD.encode(doc.richdoc_append_paragraph("Accepted remote edit"))})).await;
            let settled = call(
                &self.b_transport,
                &self.b,
                &mut self.b_id,
                "ydoc.settle",
                json!({"sessionId":session}),
            )
            .await;
            journal_editor_settlement(
                &self.b_scratch,
                WORKSPACE,
                settled["momentId"].as_str().unwrap(),
            );
        }
        self.push_on_b().await;
    }

    async fn push_on_b(&mut self) {
        call(
            &self.b_transport,
            &self.b,
            &mut self.b_id,
            "sync.push",
            json!({"workspaceId":WORKSPACE}),
        )
        .await;
        publish_pushed_ops(&self.relay, WORKSPACE, &self.b_scratch);
    }

    /// End A's sessions without a restart.
    async fn evict_on_a(&mut self) {
        for session in std::mem::take(&mut self.sessions_a) {
            call(
                &self.a_transport,
                &self.a,
                &mut self.a_id,
                "ydoc.evict",
                json!({"sessionId":session}),
            )
            .await;
        }
    }

    /// Quit A and open it again with a cold reader. Answers how long the open
    /// took.
    async fn restart_a(&mut self, reader_state: ReaderState) -> Duration {
        self.sessions_a.clear();
        let (_, _, config) = cold_reader(&self.reader_root, &self.notes, reader_state);
        let service = std::mem::replace(&mut self.a_service, Arc::new(EngineService::new()));
        let transport = std::mem::replace(
            &mut self.a_transport,
            InProcessTransport::new(Arc::clone(&self.a_service)),
        );
        drop(transport);
        drop(service);
        let db = engine_db_path(&self.a_scratch).unwrap();
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
        self.a_service.configure_reader(config);
        write_root_binding(self.a_scratch.path(), TOKEN).unwrap();
        let started = std::time::Instant::now();
        let opened = call_with_busy_retry(
            &self.a_transport,
            RequestContext::unbounded(),
            request(1, "workspace.open", None, json!({
                "rootDir":self.a_scratch.path().to_string_lossy(),
                "workspaceId":WORKSPACE,
                "captureMode":"none",
                "reconcileCollections":false,
                "relay":{"baseUrl":self.relay.base_url,"bearerToken":BEARER,"allowInsecureLoopbackForTests":true}
            })),
        )
        .await;
        let elapsed = started.elapsed();
        self.a = serde_json::from_value(
            opened.expect("open workspace").result["workspace"].clone(),
        )
        .unwrap();
        elapsed
    }

    /// One sync on A. Answers how long it took.
    async fn pull(&mut self) -> Duration {
        let started = std::time::Instant::now();
        pull_materialize_and_commit(&self.a_transport, &self.a, &mut self.a_id, WORKSPACE).await;
        started.elapsed()
    }

    fn file(&self, index: usize) -> String {
        std::fs::read_to_string(self.a_scratch.path().join(&self.notes[index].0)).unwrap()
    }

    /// Every note's file on A has B's edit, or every one still has its first
    /// text.
    fn assert_files(&self, caught_up: bool) {
        for (index, (path, _, doc)) in self.notes.iter().enumerate() {
            let expected = if caught_up {
                let expected = doc.project(ContentKind::Richdoc).unwrap().content;
                assert!(expected.contains("Accepted remote edit"));
                expected
            } else {
                self.sessions_b[index].2.clone()
            };
            assert_eq!(self.file(index), expected, "{path}");
        }
    }

    fn pending_artifacts(&self) -> i64 {
        let db = Connection::open(engine_db_path(&self.a_scratch).unwrap()).unwrap();
        let sql = "SELECT COUNT(*) FROM ydoc_pending_artifacts";
        db.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// The paths Notices names, each row with the recovery failure message.
    async fn notice_paths(&mut self) -> Vec<String> {
        let listed = call(
            &self.a_transport,
            &self.a,
            &mut self.a_id,
            "sync.refusalNotices",
            json!({"workspaceId":WORKSPACE}),
        )
        .await;
        let mut paths: Vec<String> = listed["notices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|notice| {
                assert_eq!(notice["reason"], RECOVERY_FAILURE, "{notice}");
                notice["document"]["path"].as_str().unwrap().to_owned()
            })
            .collect();
        paths.sort();
        paths
    }

    async fn assert_a_notice_per_note(&mut self) {
        let mut expected: Vec<String> =
            self.notes.iter().map(|(path, _, _)| path.clone()).collect();
        expected.sort();
        assert_eq!(self.notice_paths().await, expected);
    }

    /// A change to another file still reaches A.
    async fn assert_sync_continues(&mut self) {
        call(&self.b_transport,&self.b,&mut self.b_id,"versionedText.write",json!({"versionId":"main","objectId":"other","path":"other.md","text":"Later incoming work","momentId":"other-moment","origin":"api","nowMs":210})).await;
        self.push_on_b().await;
        self.pull().await;
        assert_eq!(
            std::fs::read_to_string(self.a_scratch.path().join("other.md")).unwrap(),
            "Later incoming work"
        );
    }

    async fn close(mut self) {
        call(
            &self.a_transport,
            &self.a,
            &mut self.a_id,
            "workspace.close",
            json!({}),
        )
        .await;
        call(
            &self.b_transport,
            &self.b,
            &mut self.b_id,
            "workspace.close",
            json!({}),
        )
        .await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_workspace_keeps_syncing_after_a_live_note_session_ends() {
    let mut notes = Notes::new(2, 0).await;
    notes.evict_on_a().await;
    install_cold_reader(
        &notes.a_scratch,
        &notes.reader_root,
        &notes.notes,
        ReaderState::Ready,
    )
    .await;
    notes.pull().await;
    notes.assert_files(true);
    assert_eq!(notes.pending_artifacts(), 0);
    notes.assert_sync_continues().await;
    notes.close().await;
}

/// A sync finishes one note in its pass, then waits for the reader to check
/// another note's incoming edit. The sync still writes the first note's file.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sync_that_checks_a_later_note_still_writes_the_note_it_finished() {
    let mut notes = Notes::new(1, 1).await;
    notes.evict_on_a().await;
    // A never opened the second note, so it applies B's edit to it in the
    // sync below, after it finishes the first note.
    notes.edit_on_b(1..2).await;
    let (resolver, reader) = install_cold_reader(
        &notes.a_scratch,
        &notes.reader_root,
        &notes.notes[..1],
        ReaderState::Ready,
    )
    .await;
    let (path, key, doc) = &notes.notes[0];
    if let Err(CollabError::MarkdownWitnessCheckPending { pending, .. }) =
        resolver.check_witness(doc, key, path)
    {
        pending.resolve().await;
    }
    assert!(resolver.check_witness(doc, key, path).unwrap());
    let checked = reader.dispatch_count();
    notes.pull().await;
    assert!(
        reader.dispatch_count() > checked,
        "the sync checked the second note's edit"
    );
    notes.assert_files(true);
    assert_eq!(notes.pending_artifacts(), 0);
    notes.close().await;
}

async fn assert_restart_catches_up(waiting: usize) {
    let mut notes = Notes::new(waiting, 0).await;
    let opened = notes.restart_a(ReaderState::Ready).await;
    assert!(opened < Duration::from_secs(5), "open took {opened:?}");
    notes.assert_files(false);
    notes.pull().await;
    notes.assert_files(true);
    assert_eq!(notes.pending_artifacts(), 0);
    assert!(notes.notice_paths().await.is_empty());
    notes.assert_sync_continues().await;
    notes.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_workspace_opens_after_a_restart_with_notes_waiting_for_their_files() {
    assert_restart_catches_up(6).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn more_than_sixteen_waiting_notes_catch_up_in_one_sync() {
    assert_restart_catches_up(17).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn opening_and_saving_a_note_lets_the_workspace_sync_again() {
    let mut notes = Notes::new(1, 0).await;
    notes.evict_on_a().await;
    install_cold_reader(
        &notes.a_scratch,
        &notes.reader_root,
        &notes.notes,
        ReaderState::Ready,
    )
    .await;
    notes.a_id += 1;
    let first = call_with_busy_retry(
        &notes.a_transport,
        RequestContext::unbounded(),
        request(
            notes.a_id,
            "sync.pull",
            Some(notes.a.clone()),
            json!({"workspaceId":WORKSPACE}),
        ),
    )
    .await;
    eprintln!("sync before opening the note: {first:?}");
    if let Err(error) = first {
        assert_eq!(error.code, ErrorCode::Internal);
    }
    let opened = call(
        &notes.a_transport,
        &notes.a,
        &mut notes.a_id,
        "ydoc.open",
        json!({"versionId":"main","path":notes.notes[0].0,"contentKind":"richdoc"}),
    )
    .await;
    let session = opened["sessionId"].as_str().unwrap().to_owned();
    notes.a_id += 1;
    let loaded = service_call_with_busy_retry(
        notes.a_service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            notes.a_id,
            "ydoc.resync",
            Some(notes.a.clone()),
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
    for method in ["ydoc.settle", "ydoc.close"] {
        call(
            &notes.a_transport,
            &notes.a,
            &mut notes.a_id,
            method,
            json!({"sessionId":session}),
        )
        .await;
    }
    notes.pull().await;
    notes.assert_files(true);
    assert_eq!(notes.pending_artifacts(), 0);
    notes.assert_sync_continues().await;
    notes.close().await;
}

/// After a restart, the reader fails every note's check. One sync, with one
/// stall at most, names each note in Notices and keeps every older file.
async fn assert_reader_failure(reader_state: ReaderState) -> Notes {
    let mut notes = Notes::new(4, 0).await;
    let opened = notes.restart_a(reader_state).await;
    assert!(
        opened < Duration::from_secs(5),
        "open waits for no reader start: {opened:?}"
    );
    let pulled = notes.pull().await;
    assert!(
        pulled < Duration::from_secs(20),
        "a failing reader stalls the sync once, not once per note: {pulled:?}"
    );
    notes.assert_files(false);
    notes.assert_a_notice_per_note().await;
    assert_eq!(notes.pending_artifacts(), 4);
    notes.assert_sync_continues().await;
    notes
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_workspace_opens_when_a_note_check_never_finishes() {
    assert_reader_failure(ReaderState::Unavailable)
        .await
        .close()
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_workspace_opens_when_its_note_reader_does_not_answer() {
    assert_reader_failure(ReaderState::Unresponsive)
        .await
        .close()
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_note_check_waits_for_a_change_or_a_new_reader() {
    let mut notes = assert_reader_failure(ReaderState::Unresponsive).await;
    let pulled = notes.pull().await;
    assert!(
        pulled < Duration::from_secs(5),
        "a sync checks no unchanged note again: {pulled:?}"
    );
    notes.assert_a_notice_per_note().await;
    // The recovery record covers the note's row, so this stands in for an
    // edit to the note.
    let mut db = Connection::open(engine_db_path(&notes.a_scratch).unwrap()).unwrap();
    db.busy_timeout(Duration::from_millis(u64::from(
        ENGINE_SQLITE_BUSY_TIMEOUT_MS,
    )))
    .unwrap();
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    tx.execute(
        "UPDATE ydoc_docs SET updated_at_ms=updated_at_ms+1 WHERE object_id=?1",
        [&notes.notes[0].1.object_id],
    )
    .unwrap();
    tx.commit().unwrap();
    drop(db);
    let pulled = notes.pull().await;
    assert!(
        pulled >= Duration::from_secs(5),
        "a sync checks the changed note again: {pulled:?}"
    );
    notes.assert_a_notice_per_note().await;
    notes.assert_files(false);
    install_cold_reader(
        &notes.a_scratch,
        &notes.reader_root,
        &notes.notes,
        ReaderState::Ready,
    )
    .await;
    notes.pull().await;
    notes.assert_files(true);
    assert!(notes.notice_paths().await.is_empty());
    assert_eq!(notes.pending_artifacts(), 0);
    notes.close().await;
}
