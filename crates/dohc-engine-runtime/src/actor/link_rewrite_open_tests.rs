use super::*;
use dohc_engine_collab::{ContentKind, Lease, LocalAppend, Regime, Ydoc};

impl Fixture {
    pub(super) async fn open_document(&self, object: &str) -> (Lease, Ydoc) {
        self.open_document_with_elements(object, true).await
    }
    async fn open_document_with_elements(&self, object: &str, elements: bool) -> (Lease, Ydoc) {
        let key = DocKey::new(&self.ws, "main", object).unwrap();
        let lease = self.leases.acquire(&key).unwrap();
        let object = object.to_owned();
        let ws = self.ws.clone();
        let bytes = self
            .actor
            .run(move |store, cache| {
                let head = VersionedTextStore::new(store)
                    .read_text(&ws, "main", &format!("{object}.md"))?
                    .unwrap();
                let doc = Ydoc::wire();
                let seed = if elements {
                    doc.richdoc_wikilinks_for_test(&head.text)?
                } else {
                    doc.rewrite_content_to_markdown_preserving_source(
                        ContentKind::Richdoc,
                        &head.text,
                    )?
                };
                dohc_engine_collab::ensure_marker(
                    store,
                    &key,
                    ContentKind::Richdoc,
                    Regime::LocalOnly,
                    &NoFaults,
                    3,
                )?;
                dohc_engine_collab::record_local_update(
                    store,
                    cache,
                    &key,
                    &seed,
                    LocalAppend {
                        is_seed: true,
                        seed_source_sha256: Some(&head.blob_sha256),
                        ..Default::default()
                    },
                    &NoFaults,
                    3,
                    |_, _, _| Ok(()),
                )?;
                Ok(doc.encode_full_state())
            })
            .await
            .unwrap();
        let doc = Ydoc::wire();
        doc.apply(&bytes).unwrap();
        (lease, doc)
    }
    async fn document(&self, object: &str) -> Ydoc {
        let key = DocKey::new(&self.ws, "main", object).unwrap();
        let bytes = self
            .actor
            .run(move |store, _| {
                Ok(store
                    .read_with(|c| dohc_engine_collab::load_doc_in(c, &key))?
                    .encode_full_state())
            })
            .await
            .unwrap();
        let doc = Ydoc::wire();
        doc.apply(&bytes).unwrap();
        doc
    }
    async fn type_document(&self, object: &str, text: &str) {
        let doc = self.document(object).await;
        let update = doc.richdoc_wikilinks_for_test(text).unwrap();
        let key = DocKey::new(&self.ws, "main", object).unwrap();
        self.actor
            .run(move |store, cache| {
                dohc_engine_collab::record_local_update(
                    store,
                    cache,
                    &key,
                    &update,
                    LocalAppend::default(),
                    &NoFaults,
                    8,
                    |_, _, _| Ok(()),
                )?;
                Ok(())
            })
            .await
            .unwrap();
    }
    async fn settle_document(&self, object: &str) {
        let config = super::super::super::reader_tests::fake_reader(&self.root, "witness-safe");
        self.actor
            .configure_reader_resolver(Arc::new(
                dohc_engine_collab::reader_resolver::ReaderResolver::new(Arc::new(
                    dohc_engine_reader::Reader::new(Some(config)),
                )),
            ))
            .await
            .unwrap();
        let key = DocKey::new(&self.ws, "main", object).unwrap();
        let path = format!("{object}.md");
        let root = self.root.to_path_buf();
        self.actor
            .run_with_reader_retry(move |store, cache| {
                assert!(super::super::super::link_documents::baseline(
                    store,
                    cache,
                    &root,
                    &key,
                    &path,
                    &CancellationToken::new(),
                    &(),
                    |_| true
                )?);
                Ok(())
            })
            .await
            .unwrap();
    }
    async fn undo_open(
        &self,
    ) -> Result<super::super::super::history_operations::HistoryUndoResult, RuntimeError> {
        let leases = self.leases.clone();
        self.actor
            .history_undo_in_turns(
                self.ws.clone(),
                OP.into(),
                format!("{}-undo", self.ws),
                None,
                self.root.to_path_buf(),
                Arc::new(NoFaults),
                10,
                [Arc::default(), self.serial.clone()],
                Arc::new(()),
                Some((Arc::new(move |key| leases.is_held(key)), Arc::new(|_| {}))),
                CancellationToken::new(),
            )
            .await
    }
    async fn undo_open_with_busy_retry(
        &self,
    ) -> Result<super::super::super::history_operations::HistoryUndoResult, RuntimeError> {
        retry_undo(&self.ws, || self.undo_open()).await
    }
    async fn adopt(&self, object: &str) {
        let ws = self.ws.clone();
        let object = object.to_owned();
        self.actor.run(move |store,_| {
            store.write_with(&NoFaults,|tx| {
                let sha=hex_sha256(b"adoption");
                tx.execute("INSERT OR IGNORE INTO binary_blobs(sha256,bytes,byte_length) VALUES(?1,?2,8)",params![sha,b"adoption".as_slice()]).unwrap();
                let digest:String=tx.query_row("SELECT blob_sha256 FROM snapshots WHERE workspace_id=?1 AND object_id=?2",params![ws,object],|r|r.get(0)).unwrap();
                let binding=json!({"currentPath":format!("{object}.md")}).to_string();
                tx.execute("INSERT INTO live_owner_adoptions VALUES('relay','adoption',?1,'main',?2,?3,?4,'source',?5,0,1,0,?3,?3,0,0,0,'null','{}',1000000,60000)",params![ws,object,sha,binding,digest]).unwrap();
                // The activation the adoption makes current.
                tx.execute("INSERT INTO live_owner_activations(relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,origin_adoption_id,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms) SELECT relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id,adoption_id,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms FROM live_owner_adoptions WHERE adoption_id='adoption'",[]).unwrap();
                Ok::<_,StorageError>(())
            })?;Ok(())
        }).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_open_rewrite_and_inverse_preserve_typing_labels_and_new_links() {
    let f = Fixture::new(3, 3).await;
    let (lease, _) = f.open_document("source-0000").await;
    let start = Instant::now();
    assert_eq!(
        f.pass("open-forward", Arc::new(NoFaults)).await.unwrap()["documents"],
        3
    );
    let forward_ns = start.elapsed().as_nanos();
    let projected = f
        .document("source-0000")
        .await
        .project(ContentKind::Richdoc)
        .unwrap()
        .content;
    assert!(projected.contains("[[new#part|label]]"));
    assert!(
        f.leases
            .is_held(&DocKey::new(&f.ws, "main", "source-0000").unwrap())
    );
    let body = "typing [[new#part|edited label]] [[./new.md]] [old](old.md) [[new]]";
    f.type_document("source-0000", body).await;
    f.settle_document("source-0000").await;
    let start = Instant::now();
    let result = f.undo_open_with_busy_retry().await.unwrap();
    let undo_ns = start.elapsed().as_nanos();
    assert!(result.not_restored.is_empty());
    let expected = "typing [[old#part|edited label]] [[./old.md]] [old](old.md) [[new]]\n";
    assert_eq!(f.text("source-0000.md").await, expected);
    assert!(
        f.document("source-0000")
            .await
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains(expected)
    );
    assert!(
        f.leases
            .is_held(&DocKey::new(&f.ws, "main", "source-0000").unwrap())
    );
    if let Ok(dir) = std::env::var("DOHC_LINK_REWRITE_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join("open-turns.json"),
            json!({"forwardNs":forward_ns,"undoNs":undo_ns}).to_string(),
        )
        .unwrap();
    }
    drop(lease);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adopted_open_source_stays_untouched_and_adoption_before_undo_refuses() {
    for after in [false, true] {
        let f = Fixture::new(1, 1).await;
        let (lease, _) = f.open_document("source-0000").await;
        if after {
            f.pass("adopt-after", Arc::new(NoFaults)).await.unwrap();
        }
        let before = f.document("source-0000").await.encode_state_vector();
        let text = f.text("source-0000.md").await;
        f.adopt("source-0000").await;
        if after {
            assert!(f.undo_open().await.is_err());
            assert_eq!(f.text("new.md").await, "[[old]]");
        } else {
            let result = f.pass("adopted", Arc::new(NoFaults)).await.unwrap();
            assert_eq!(result["documents"], 0);
            assert_eq!(result["uncheckedCount"], 1);
        }
        assert_eq!(f.text("source-0000.md").await, text);
        assert_eq!(
            f.document("source-0000").await.encode_state_vector(),
            before
        );
        assert!(
            f.leases
                .is_held(&DocKey::new(&f.ws, "main", "source-0000").unwrap())
        );
        drop(lease);
        f.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_update_and_history_moment_commit_or_roll_back_together() {
    for crash in 0..3 {
        let point = if crash == 1 {
            FaultPoint::StorageBeforePersist
        } else {
            FaultPoint::StorageAfterCommitBeforeAck
        };
        let mut f = Fixture::new(1, 1).await;
        let (lease, _) = f.open_document("source-0000").await;
        let ws = f.ws.clone();
        let root = f.root.to_path_buf();
        let before = f.document("source-0000").await.encode_state_vector();
        let committed = crash == 2;
        f.actor
            .run(move |store, cache| {
                let key = DocKey::new(&ws, "main", "source-0000")?;
                let after = BODY
                    .replace("old#part", "new#part")
                    .replace("./old.md", "./new.md");
                let edit = store
                    .read_with(|c| {
                        super::super::super::link_documents::prepare(c, &key, BODY, &after)
                    })?
                    .unwrap();
                let mut input = write(&ws, "source-0000", "source-0000.md", &after, "atomic-open");
                input.metadata_correlation_id = Some(OP.into());
                let fault = dohc_engine_testkit::ScriptedFaults::crash_at(point);
                if crash == 0 {
                    super::super::super::link_documents::CRASH_AFTER_APPEND.set(true);
                }
                let outcome = super::super::super::versioned::with_local_file_mutation_cache_reset(
                    cache,
                    || {
                        super::super::super::link_documents::write(
                            store,
                            &input,
                            &root,
                            &key,
                            &edit,
                            &hex_sha256(BODY.as_bytes()),
                            &|_| Ok(()),
                            fault.as_ref(),
                        )
                    },
                );
                assert!(matches!(outcome, Err(RuntimeError::OperationCrashed)));
                assert_eq!(fault.fired(), crash != 0);
                Ok(())
            })
            .await
            .unwrap();
        f.restart().await;
        let members = f
            .actor
            .history_operation(f.ws.clone(), OP.into())
            .await
            .unwrap()
            .moments;
        assert_eq!(members.len(), if committed { 2 } else { 1 });
        let doc = f.document("source-0000").await;
        assert_eq!(doc.encode_state_vector() != before, committed);
        assert_eq!(
            doc.project(ContentKind::Richdoc)
                .unwrap()
                .content
                .contains("[[new#part"),
            committed
        );
        drop(lease);
        f.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn literal_wikilinks_without_editor_elements_stay_unchecked() {
    let f = Fixture::new(1, 1).await;
    let (lease, doc) = f.open_document_with_elements("source-0000", false).await;
    let before = doc.encode_state_vector();
    let result = f.pass("literal-open", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(result["documents"], 0);
    assert_eq!(result["unchecked"], json!(["source-0000.md"]));
    assert_eq!(f.text("source-0000.md").await, BODY);
    assert_eq!(
        f.document("source-0000").await.encode_state_vector(),
        before
    );
    assert!(
        f.leases
            .is_held(&DocKey::new(&f.ws, "main", "source-0000").unwrap())
    );
    drop(lease);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unmappable_open_inverse_is_not_restored_and_other_members_continue() {
    let f = Fixture::new(2, 2).await;
    f.pass("unmapped-inverse", Arc::new(NoFaults))
        .await
        .unwrap();
    f.publish().await;
    let (lease, _) = f.open_document_with_elements("source-0000", false).await;
    let result = f.undo_open().await;
    let request = format!("{}-undo", f.ws);
    let reasons = f
        .actor
        .run(move |store, _| {
            let reasons: String = store
                .read_with(|c| {
                    c.query_row(
                        "SELECT errors_json FROM history_undo_plans WHERE request_id=?1",
                        [request],
                        |r| r.get(0),
                    )
                    .optional()
                })
                .unwrap()
                .unwrap_or_default();
            Ok(reasons)
        })
        .await
        .unwrap();
    let restored = f.text("source-0001.md").await;
    let untouched = f.text("source-0000.md").await;
    drop(lease);
    f.close().await;
    let result = result.unwrap();
    assert_eq!(result.not_restored, ["source-0000.md"]);
    assert!(reasons.contains("wikilink element unavailable"));
    assert_eq!(restored, BODY);
    assert!(untouched.contains("[[new#part"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preflight_checkpoint_wait_releases_editor_gates() {
    let f = Fixture::new(1, 1).await;
    let (lease, _) = f.open_document("source-0000").await;
    f.pass("preflight-lock", Arc::new(NoFaults)).await.unwrap();
    f.publish().await;
    f.type_document(
        "source-0000",
        "typing [[new#part|label]] [[./new.md]] [old](old.md)",
    )
    .await;
    f.actor
        .run(|store, _| {
            store
                .read_with(|c| c.busy_timeout(Duration::ZERO))
                .map_err(StorageError::persist_public)?;
            Ok(())
        })
        .await
        .unwrap();
    let writer = rusqlite::Connection::open(engine_db_path(&f.root).unwrap()).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let request = format!("{}-undo", f.ws);
    let [entered, release] = undo_probe::pause_checkpoint(&request);
    let capture = Arc::new(tokio::sync::Mutex::new(()));
    let leases = f.leases.clone();
    let undo = f.actor.history_undo_in_turns(
        f.ws.clone(),
        OP.into(),
        request,
        None,
        f.root.to_path_buf(),
        Arc::new(NoFaults),
        10,
        [capture.clone(), f.serial.clone()],
        Arc::new(()),
        Some((Arc::new(move |key| leases.is_held(key)), Arc::new(|_| {}))),
        CancellationToken::new(),
    );
    let edit = async {
        entered.notified().await;
        writer.execute_batch("ROLLBACK").unwrap();
        let updated = tokio::time::timeout(Duration::from_secs(5), async {
            let _capture = capture.lock().await;
            let _sessions = f.serial.lock().await;
            f.type_document(
                "source-0000",
                "typing during wait [[new#part|label]] [[./new.md]] [old](old.md)",
            )
            .await;
        })
        .await
        .is_ok();
        release.notify_one();
        updated
    };
    let (result, updated) = tokio::join!(undo, edit);
    let text = f
        .document("source-0000")
        .await
        .project(ContentKind::Richdoc)
        .unwrap()
        .content;
    drop(lease);
    drop(writer);
    f.close().await;
    assert!(updated, "preflight checkpoint wait held the editor gates");
    assert!(result.unwrap().not_restored.is_empty());
    assert!(text.contains("typing during wait"));
}

impl Fixture {
    async fn outside_head(&self, object: &str, text: &str, moment: &str) {
        let path = format!("{object}.md");
        let input = write(&self.ws, object, &path, text, moment);
        self.actor
            .run(move |store, _| {
                VersionedTextStore::new(store).write_text(&input, &NoFaults)?;
                Ok(())
            })
            .await
            .unwrap();
        std::fs::write(self.root.join(path), text).unwrap();
    }

    async fn rewrite_receipt(&self, request: &str) -> (bool, Value) {
        let receipt = Receipt {
            key: request.into(),
            binding: hex_sha256(json!([self.ws, OP, None::<String>]).to_string().as_bytes()),
        };
        self.actor
            .run(move |store, _| store.read_with(|conn| receipt.read(conn)))
            .await
            .unwrap()
            .unwrap()
    }

    async fn captured(&self, path: &str) {
        self.actor
            .offer_captured_link_rewrites(&self.ws, &[path.into()]);
        self.actor.retry_pending_link_rewrites(&self.ws).await;
    }

}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_capture_retries_only_that_note_and_undo_keeps_prose() {
    let f = Fixture::new(3, 3).await;
    let (first, _) = f.open_document("source-0000").await;
    let (second, _) = f.open_document("source-0001").await;
    let agent = "agent prose [[old]]\n";
    let human = "human prose [[old]]\n";
    std::fs::write(f.root.join("source-0000.md"), agent).unwrap();
    std::fs::write(f.root.join("source-0001.md"), human).unwrap();
    let initial = f.pass("two-outside", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(initial["documents"], 1);
    assert!(!f.rewrite_receipt("two-outside").await.0);
    f.captured("source-0000.md").await;
    assert_eq!(
        f.text("source-0000.md").await,
        BODY,
        "a lease still excludes the retry"
    );
    drop(first);
    f.captured("source-0000.md").await;
    assert_eq!(
        f.text("source-0000.md").await,
        BODY,
        "disk bytes must first become the head"
    );
    assert_eq!(f.rewrite_receipt("two-outside").await.1, initial);
    f.outside_head("source-0000", agent, "outside-agent").await;
    let read = Arc::new(Mutex::new(Vec::new()));
    let observed = read.clone();
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(move |_, object| {
        observed.lock().unwrap().push(object.to_owned())
    }));
    f.captured("source-0000.md").await;
    assert_eq!(*read.lock().unwrap(), vec!["source-0000"]);
    assert_eq!(f.text("source-0000.md").await, "agent prose [[new]]\n");
    assert_eq!(
        std::fs::read_to_string(f.root.join("source-0001.md")).unwrap(),
        human
    );
    let (done, result) = f.rewrite_receipt("two-outside").await;
    assert!(!done);
    assert_eq!(result["documents"], 2);
    assert_eq!(result["unchecked"], json!(["source-0001.md"]));
    drop(second);
    f.outside_head("source-0001", human, "outside-human").await;
    f.captured("source-0001.md").await;
    let (done, result) = f.rewrite_receipt("two-outside").await;
    assert!(done);
    assert_eq!(result["documents"], 3);
    assert_eq!(result["complete"], true);
    assert_eq!(
        f.pass("two-outside", Arc::new(NoFaults)).await.unwrap(),
        result
    );
    f.publish().await;
    let undone = f.undo().await.unwrap();
    assert!(undone.not_restored.is_empty());
    let placed = f
        .actor
        .history_undo_place(
            f.ws.clone(),
            undone,
            f.root.to_path_buf(),
            Arc::new(()),
            11,
            |_| {},
        )
        .await;
    assert!(placed.materialized);
    assert_eq!(f.text("source-0000.md").await, agent);
    assert_eq!(f.text("source-0001.md").await, human);
    assert_eq!(
        std::fs::read_to_string(f.root.join("source-0000.md")).unwrap(),
        agent
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("source-0001.md")).unwrap(),
        human
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_retry_failure_keeps_pending_work_and_durable_progress() {
    for (point, nth) in [
        (FaultPoint::StorageBeforePersist, 4),
        (FaultPoint::StorageAfterCommitBeforeAck, 4),
        (FaultPoint::StorageAfterCommitBeforeAck, 5),
    ] {
        let f = Fixture::new(1, 1).await;
        let (lease, _) = f.open_document("source-0000").await;
        let outside = "agent prose [[old]]\n";
        std::fs::write(f.root.join("source-0000.md"), outside).unwrap();
        let faults = Arc::new(CrashNth {
            point,
            // Initial reserve/reply, retry reserve, then write and completion.
            nth,
            seen: AtomicUsize::new(0),
        });
        f.pass("outside-retry-fault", faults).await.unwrap();
        drop(lease);
        f.outside_head("source-0000", outside, "outside-before-fault")
            .await;
        f.captured("source-0000.md").await;
        assert_eq!(
            f.rewrite_receipt("outside-retry-fault").await.0,
            nth == 5 && point == FaultPoint::StorageAfterCommitBeforeAck
        );
        assert!(
            f.actor.link_rewrites.deferred.lock().unwrap()["outside-retry-fault"]
                .sources
                .contains_key("source-0000")
        );
        f.captured("source-0000.md").await;
        let (done, result) = f.rewrite_receipt("outside-retry-fault").await;
        assert!(done);
        assert_eq!(result["documents"], 1);
        assert_eq!(result["complete"], true);
        assert!(f.actor.link_rewrites.deferred.lock().unwrap().is_empty());
        assert_eq!(f.text("source-0000.md").await, "agent prose [[new]]\n");
        f.publish().await;
        f.undo().await.unwrap();
        assert_eq!(f.text("source-0000.md").await, outside);
        f.close().await;
    }
}

