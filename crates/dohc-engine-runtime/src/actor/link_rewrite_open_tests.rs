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
        let key = DocKey::new(&self.ws, "main", object).unwrap();
        let path = format!("{object}.md");
        let root = self.root.to_path_buf();
        self.actor
            .run(move |store, cache| {
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
                Ok::<_,StorageError>(())
            })?;Ok(())
        }).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_open_rewrite_and_inverse_preserve_typing_labels_and_new_links() {
    let f = Fixture::new(3, 3);
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
    let expected = "typing [[old#part|edited label]] [[./old.md]] [old](old.md) [[new]]";
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
async fn target_edit_in_open_document_refuses_before_any_compensation() {
    let f = Fixture::new(3, 3);
    let (lease, _) = f.open_document("source-0000").await;
    f.pass("target-forward", Arc::new(NoFaults)).await.unwrap();
    f.type_document(
        "source-0000",
        "[[different#part|label]] [[./new.md]] [old](old.md)",
    )
    .await;
    f.settle_document("source-0000").await;
    assert!(
        matches!(f.undo_open().await,Err(RuntimeError::Domain(DomainError::UndoRefused {
        reason:"link changed after rename",path
    })) if path=="source-0000.md")
    );
    assert!(f.text("new.md").await.contains("[[old]]"));
    assert_eq!(
        f.actor
            .history_operation(f.ws.clone(), OP.into())
            .await
            .unwrap()
            .moments
            .len(),
        4
    );
    drop(lease);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closed_forward_open_inverse_and_open_forward_closed_inverse() {
    for open_forward in [false, true] {
        let f = Fixture::new(1, 1);
        let mut lease = if open_forward {
            Some(f.open_document("source-0000").await.0)
        } else {
            None
        };
        f.pass("transition", Arc::new(NoFaults)).await.unwrap();
        f.publish().await;
        if open_forward {
            f.settle_document("source-0000").await;
            drop(lease.take());
            let key = DocKey::new(&f.ws, "main", "source-0000").unwrap();
            f.actor
                .ydoc_close_session_materialized(
                    f.root.to_path_buf(),
                    key,
                    Arc::new(()),
                    9,
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
        } else {
            lease = Some(f.open_document("source-0000").await.0);
        }
        let undone = f.undo_open().await.unwrap();
        assert!(undone.not_restored.is_empty());
        assert_eq!(f.text("source-0000.md").await, BODY);
        drop(lease);
        f.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adopted_open_source_stays_untouched_and_adoption_before_undo_refuses() {
    for after in [false, true] {
        let f = Fixture::new(1, 1);
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
        let mut f = Fixture::new(1, 1);
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
async fn linking_document_updates_wait_at_most_one_turn_and_mid_undo_edits_are_not_restored() {
    let f = Fixture::new(2000, 4999);
    let _index_hold = f.actor.hold_link_drain();
    let ws = f.ws.clone();
    f.actor.run(move |store, _| {
        store.write_with(&NoFaults, |tx| tx.execute(
            "INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) SELECT workspace_id,version_id,object_id,1 FROM snapshots WHERE workspace_id=?1 AND version_id='main' ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1", [&ws]
        ).map_err(StorageError::persist_public))?;
        Ok(())
    }).await.unwrap();
    let (lease, doc) = f.open_document("source-0000").await;
    let key = DocKey::new(&f.ws, "main", "source-0000").unwrap();
    let update = doc.richdoc_append_paragraph("forward typing");
    let committed = Arc::new(tokio::sync::Notify::new());
    probes().lock().unwrap().get_mut(&f.ws).unwrap().committed = Some(committed.clone());
    let (actor, serial, ws, k) = (f.actor.clone(), f.serial.clone(), f.ws.clone(), key.clone());
    let typing = tokio::spawn(async move {
        committed.notified().await;
        let before = undo_probe::turn_count(&ws);
        let start = Instant::now();
        let _guard = serial.lock().await;
        actor
            .ydoc_record_update(
                k,
                "source-0000.md".into(),
                ContentKind::Richdoc,
                Regime::LocalOnly,
                update,
                None,
                None,
                None,
                false,
                None,
                Some("queued-forward-typing".into()),
                5,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
            )
            .await
            .unwrap();
        (
            undo_probe::turn_count(&ws) - before,
            start.elapsed().as_nanos(),
        )
    });
    assert_eq!(
        f.pass("open-contention", Arc::new(NoFaults)).await.unwrap()["documents"],
        2000
    );
    let (forward_gap, forward_wait) = typing.await.unwrap();
    assert!(forward_gap <= 1);
    f.settle_document("source-0000").await;
    let doc = f.document("source-0000").await;
    let update = doc.richdoc_append_paragraph("undo typing");
    let request = format!("{}-undo", f.ws);
    let (receive, barrier) = undo_probe::pause_inverse(&request);
    let (actor, serial) = (f.actor.clone(), f.serial.clone());
    let typing = async move {
        tokio::task::spawn_blocking(move || receive.recv().unwrap())
            .await
            .unwrap();
        let before = undo_probe::turn_count(&request);
        let start = Instant::now();
        let _guard = serial.lock().await;
        let future = actor.ydoc_record_update(
            key,
            "source-0000.md".into(),
            ContentKind::Richdoc,
            Regime::LocalOnly,
            update,
            None,
            None,
            None,
            false,
            None,
            Some("queued-undo-typing".into()),
            11,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        );
        tokio::pin!(future);
        std::future::poll_fn(|cx| {
            assert!(
                future.as_mut().poll(cx).is_pending(),
                "update answered while actor was paused"
            );
            std::task::Poll::Ready(())
        })
        .await;
        tokio::task::spawn_blocking(move || barrier.wait())
            .await
            .unwrap();
        future.await.unwrap();
        (
            undo_probe::turn_count(&request) - before,
            start.elapsed().as_nanos(),
        )
    };
    let (result, (undo_gap, undo_wait)) = tokio::join!(f.undo_open_with_busy_retry(), typing);
    let result = result.unwrap();

    assert!(undo_gap <= 1);
    assert_eq!(result.not_restored, vec!["source-0000.md"]);
    let text = f
        .document("source-0000")
        .await
        .project(ContentKind::Richdoc)
        .unwrap()
        .content;
    assert!(text.contains("[[new#part"));
    assert!(text.contains("forward typing"));
    assert!(text.contains("undo typing"));
    if let Ok(dir) = std::env::var("DOHC_LINK_REWRITE_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join("open-contention.json"),
            json!({"forwardGap":forward_gap,"undoGap":undo_gap,
                "forwardWaitNs":forward_wait,"undoWaitNs":undo_wait})
            .to_string(),
        )
        .unwrap();
    }
    drop(lease);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn literal_wikilinks_without_editor_elements_stay_unchecked() {
    let f = Fixture::new(1, 1);
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
async fn an_editor_opened_after_read_uses_its_ydoc_and_stays_open() {
    let f = Fixture::new(1, 1);
    let (lease, _) = f.open_document("source-0000").await;
    drop(lease);
    let key = DocKey::new(&f.ws, "main", "source-0000").unwrap();
    let leases = f.leases.clone();
    let held = Arc::new(Mutex::new(None));
    let owned = held.clone();
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(move |_, object| {
        if object == "source-0000" {
            *owned.lock().unwrap() = Some(leases.acquire(&key).unwrap());
        }
    }));
    let result = f.pass("late-editor", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(result["documents"], 1);
    assert!(
        f.document("source-0000")
            .await
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("[[new#part|label]]")
    );
    assert!(
        f.leases
            .is_held(&DocKey::new(&f.ws, "main", "source-0000").unwrap())
    );
    drop(held.lock().unwrap().take());
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn typing_after_fence_settlement_before_preflight_preserves_the_edit() {
    let f = Fixture::new(1, 1);
    let (lease, _) = f.open_document("source-0000").await;
    f.pass("fence-gap", Arc::new(NoFaults)).await.unwrap();
    f.settle_document("source-0000").await;
    f.type_document(
        "source-0000",
        "typing [[new#part|label]] [[./new.md]] [old](old.md)",
    )
    .await;
    let result = f.undo_open_with_busy_retry().await;
    let text = f.text("source-0000.md").await;
    drop(lease);
    f.close().await;
    assert!(result.unwrap().not_restored.is_empty());
    assert_eq!(text, "typing [[old#part|label]] [[./old.md]] [old](old.md)");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forward_does_not_write_through_another_undos_internal_lease() {
    let f = Fixture::new(1, 1);
    let before = format!("{BODY} [[other-old]]");
    let after = format!("{BODY} [[other-new]]");
    f.edit("source-0000", "source-0000.md", &before).await;
    let (ws, body, root) = (f.ws.clone(), after.clone(), f.root.to_path_buf());
    f.actor
        .run(move |store, _| {
            let mut versions = VersionedTextStore::new(store);
            versions.write_text(
                &write(&ws, "other-target", "other-old.md", "other", "other-seed"),
                &NoFaults,
            )?;
            versions.rename_text_file(
                &RenameTextFile {
                    workspace_id: ws.clone(),
                    version_id: "main".into(),
                    from_path: "other-old.md".into(),
                    to_path: "other-new.md".into(),
                    moment_id: "other-rename".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: Some("dohc-operation:other".into()),
                    author_json: None,
                    now_ms: 3,
                },
                &NoFaults,
            )?;
            let mut input = write(&ws, "source-0000", "source-0000.md", &body, "other-links");
            input.metadata_correlation_id = Some("dohc-operation:other".into());
            versions.write_text(&input, &NoFaults)?;
            std::fs::write(root.join("other-new.md"), "other").unwrap();
            std::fs::write(root.join("source-0000.md"), body).unwrap();
            Ok(())
        })
        .await
        .unwrap();
    let (session, _) = f.open_document("source-0000").await;
    f.settle_document("source-0000").await;
    drop(session);
    let key = DocKey::new(&f.ws, "main", "source-0000").unwrap();
    let lease = f.leases.acquire_internal(&key).unwrap();
    let request = format!("{}-other-undo", f.ws);
    let (receive, barrier) = undo_probe::pause_inverse(&request);
    let (actor, ws, root, serial) = (
        f.actor.clone(),
        f.ws.clone(),
        f.root.to_path_buf(),
        f.serial.clone(),
    );
    let capture: Arc<tokio::sync::Mutex<()>> = Arc::default();
    let undo_capture = capture.clone();
    let undo = tokio::spawn(async move {
        actor
            .history_undo_in_turns(
                ws,
                "dohc-operation:other".into(),
                request,
                None,
                root,
                Arc::new(NoFaults),
                10,
                [undo_capture, serial],
                Arc::new(()),
                Some((Arc::new(|_| false), Arc::new(|_| {}))),
                CancellationToken::new(),
            )
            .await
    });
    tokio::task::spawn_blocking(move || receive.recv().unwrap())
        .await
        .unwrap();
    let held = capture.lock_owned().await;
    tokio::task::spawn_blocking(move || barrier.wait())
        .await
        .unwrap();
    let result = f.pass("other-undo-lease", Arc::new(NoFaults)).await;
    drop(held);
    let undone = undo.await.unwrap();
    let text = f.text("source-0000.md").await;
    drop(lease);
    f.close().await;
    let result = result.unwrap();
    assert_eq!(result["documents"], 0);
    assert_eq!(result["unchecked"], json!(["source-0000.md"]));
    assert!(undone.unwrap().not_restored.is_empty());
    assert_eq!(text, before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reopen_after_preflight_uses_the_live_inverse_without_retiring_lineage() {
    let f = Fixture::new(1, 1);
    let (lease, _) = f.open_document("source-0000").await;
    f.pass("reopen-gap", Arc::new(NoFaults)).await.unwrap();
    f.publish().await;
    f.settle_document("source-0000").await;
    drop(lease);
    let request = format!("{}-undo", f.ws);
    let (receive, barrier) = undo_probe::pause_inverse(&request);
    let key = DocKey::new(&f.ws, "main", "source-0000").unwrap();
    let leases = f.leases.clone();
    let reopen = async move {
        tokio::task::spawn_blocking(move || receive.recv().unwrap())
            .await
            .unwrap();
        let lease = leases.acquire(&key).unwrap();
        tokio::task::spawn_blocking(move || barrier.wait())
            .await
            .unwrap();
        lease
    };
    let (result, lease) = tokio::join!(f.undo_open(), reopen);
    let doc = f.document("source-0000").await;
    let text = f.text("source-0000.md").await;
    drop(lease);
    f.close().await;
    assert!(result.unwrap().not_restored.is_empty());
    assert!(
        doc.project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("[[old#part")
    );
    assert_eq!(
        doc.wikilink_spans().unwrap().1.len(),
        2,
        "reopened editor lost its native wikilink elements"
    );
    assert_eq!(text, BODY);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn marked_projection_over_the_limit_is_unchecked_instead_of_an_error() {
    let f = Fixture::new(1, 1);
    let (lease, _) = f.open_document("source-0000").await;
    let key = DocKey::new(&f.ws, "main", "source-0000").unwrap();
    let result = f
        .actor
        .run(move |store, _| {
            let marker = store
                .read_with(|c| dohc_engine_collab::read_marker_in(c, &key))?
                .unwrap();
            let doc = Ydoc::wire();
            doc.richdoc_wikilinks_for_test(&"[[a]] ".repeat(16))?;
            doc.richdoc_append_paragraph(
                &"x".repeat(dohc_engine_collab::limits::MAX_PROJECTION_BYTES - 450),
            );
            let before = doc
                .project(ContentKind::Richdoc)
                .expect("unmarked projection must fit")
                .content;
            assert!(matches!(
                doc.wikilink_spans(),
                Err(dohc_engine_collab::CollabError::ProjectionTooLarge { .. })
            ));
            let after = before.replacen("[[a]]", "[[b]]", 1);
            assert!(
                super::super::super::link_documents::prepare_doc(&doc, marker, &before, &after)?
                    .is_none()
            );
            Ok(())
        })
        .await;
    drop(lease);
    f.close().await;
    result.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unmappable_open_inverse_is_not_restored_and_other_members_continue() {
    let f = Fixture::new(2, 2);
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

#[derive(Default)]
struct BaselineWrites(std::sync::atomic::AtomicUsize);
impl super::super::super::materialization::SelfWriteRecorder for BaselineWrites {
    fn record(&self, _workspace: &str, _path: &str, _sha: &str) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
    fn retract(&self, _workspace: &str, _path: &str, _sha: &str) {}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn baseline_records_self_writes_and_leaves_unrelated_live_edits_unsettled() {
    for relevant in [false, true] {
        let f = Fixture::new(1, 1);
        let (lease, _) = f.open_document("source-0000").await;
        let body = if relevant {
            "typing [[old]]"
        } else {
            "typing [[elsewhere]]"
        };
        f.type_document("source-0000", body).await;
        let key = DocKey::new(&f.ws, "main", "source-0000").unwrap();
        let root = f.root.to_path_buf();
        let recorder = Arc::new(BaselineWrites::default());
        let writes = recorder.clone();
        let usable = f
            .actor
            .run(move |store, cache| {
                super::super::super::link_documents::baseline(
                    store,
                    cache,
                    &root,
                    &key,
                    "source-0000.md",
                    &CancellationToken::new(),
                    writes.as_ref(),
                    |text| text.contains("[[old]]"),
                )
            })
            .await
            .unwrap();
        let text = f.text("source-0000.md").await;
        drop(lease);
        f.close().await;
        assert_eq!(usable, relevant);
        assert_eq!(recorder.0.load(Ordering::SeqCst) > 0, relevant);
        assert_eq!(text, if relevant { body } else { BODY });
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_preflight_leaves_parked_peer_updates_for_the_session_drain() {
    let f = Fixture::new(1, 1);
    let (lease, _) = f.open_document("source-0000").await;
    f.pass("parked-peer", Arc::new(NoFaults)).await.unwrap();
    f.publish().await;
    let key = DocKey::new(&f.ws, "main", "source-0000").unwrap();
    let peer = f.document("source-0000").await;
    let base = peer.encode_full_state();
    let update = peer.richdoc_append_paragraph("parked peer typing");
    let ws = f.ws.clone();
    let leases = f.leases.clone();
    let queued_key = key.clone();
    f.actor
        .run(move |store, cache| {
            dohc_engine_sync::create_claim_identity(
                store, &ws, "local", "epoch", "stream", 8, &NoFaults,
            )?;
            dohc_engine_collab::claim_base(
                store,
                &queued_key,
                ContentKind::Richdoc,
                &base,
                &NoFaults,
                8,
            )?;
            let claim = dohc_engine_collab::hex_sha256(&base);
            let blob = store.put_binary_blob(&update)?;
            let envelope = dohc_engine_sync::ReplicationEnvelope {
                workspace_id: ws,
                origin_id: "parked-peer".into(),
                origin_seq: 0,
                relay_seq: Some(1),
                op_kind: "ydoc.update".into(),
                recorded_at_ms: 8,
                settlement_admission: None,
                admitted_author_snapshot: None,
                payload: json!({"versionId":"main","objectId":"source-0000",
                "path":"source-0000.md","contentKind":"richdoc",
                "updateBlobSha256":blob,"lineageClaimId":claim,"isBaseState":false}),
            };
            dohc_engine_sync::apply_replication_envelope(
                store, cache, &envelope, &NoFaults, &leases,
            )?;
            let queued: i64 = store.read_with(|c| {
                c.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |r| {
                    r.get(0)
                })
                .map_err(StorageError::corrupt_public)
            })?;
            assert_eq!(queued, 1);
            Ok(())
        })
        .await
        .unwrap();
    let undone = f.undo_open().await;
    let text = f.text("source-0000.md").await;
    let (queued, drained, projected) = f
        .actor
        .run(move |store, cache| {
            let queued: i64 = store.read_with(|c| {
                c.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |r| {
                    r.get(0)
                })
                .map_err(StorageError::corrupt_public)
            })?;
            let drained =
                dohc_engine_sync::drain_deferred_ydoc_for_key(store, cache, &key, &NoFaults)?;
            let projected = store
                .read_with(|c| dohc_engine_collab::load_doc_in(c, &key))?
                .project(ContentKind::Richdoc)?
                .content;
            Ok((queued, drained.drained, projected))
        })
        .await
        .unwrap();
    drop(lease);
    f.close().await;
    assert!(undone.unwrap().not_restored.is_empty());
    assert_eq!(text, BODY);
    assert_eq!(queued, 1, "preflight consumed the peer's only event route");
    assert_eq!(drained, 1);
    assert!(projected.contains("parked peer typing"));
    assert!(projected.contains("[[old#part"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unmappable_preflight_then_close_uses_the_disk_inverse() {
    let f = Fixture::new(1, 1);
    f.pass("close-unmappable", Arc::new(NoFaults))
        .await
        .unwrap();
    f.publish().await;
    let (lease, _) = f.open_document_with_elements("source-0000", false).await;
    let request = format!("{}-undo", f.ws);
    let (receive, barrier) = undo_probe::pause_inverse(&request);
    let close = async move {
        tokio::task::spawn_blocking(move || receive.recv().unwrap())
            .await
            .unwrap();
        drop(lease);
        tokio::task::spawn_blocking(move || barrier.wait())
            .await
            .unwrap();
    };
    let (result, ()) = tokio::join!(f.undo_open(), close);
    let text = f.text("source-0000.md").await;
    f.close().await;
    assert!(result.unwrap().not_restored.is_empty());
    assert_eq!(text, BODY);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preflight_settle_failure_is_durable_and_other_members_continue() {
    let f = Fixture::new(2, 2);
    let (lease, _) = f.open_document("source-0000").await;
    f.pass("settle-error", Arc::new(NoFaults)).await.unwrap();
    f.publish().await;
    f.type_document(
        "source-0000",
        "typing [[new#part|label]] [[./new.md]] [old](old.md)",
    )
    .await;
    f.actor.run(|store,_| {
        store.write_with(&NoFaults, |tx| {
            tx.execute_batch("CREATE TRIGGER fail_preflight_settle BEFORE INSERT ON moments WHEN NEW.object_id='source-0000' BEGIN SELECT RAISE(ABORT,'settle unavailable'); END;").map_err(StorageError::persist_public)?;
            Ok::<_,RuntimeError>(())
        })?;
        Ok(())
    }).await.unwrap();
    let result = f.undo_open().await;
    let request = format!("{}-undo", f.ws);
    let errors: String = f
        .actor
        .run(move |store, _| {
            Ok(store.read_with(|c| {
                c.query_row(
                    "SELECT errors_json FROM history_undo_plans WHERE request_id=?1",
                    [request],
                    |r| r.get(0),
                )
                .map_err(StorageError::corrupt_public)
            })?)
        })
        .await
        .unwrap();
    let restored = f.text("source-0001.md").await;
    drop(lease);
    f.close().await;
    assert_eq!(result.unwrap().not_restored, ["source-0000.md"]);
    let errors: serde_json::Value = serde_json::from_str(&errors).unwrap();
    let errors = errors.as_object().unwrap();
    assert_eq!(errors.len(), 1);
    assert_eq!(
        errors.values().next().unwrap(),
        "domain error: storage error: write failed to persist"
    );
    assert_eq!(restored, BODY);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preflight_checkpoint_wait_releases_editor_gates() {
    let f = Fixture::new(1, 1);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forward_read_retries_a_locked_baseline_without_replaying_the_pass() {
    forward_lock_proof(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forward_commit_retries_a_locked_writer_without_losing_the_source() {
    forward_lock_proof(true).await;
}

async fn forward_lock_proof(lock_at_commit: bool) {
    let f = Fixture::new(1, 1);
    let (lease, _) = f.open_document("source-0000").await;
    f.actor
        .run(|store, _| {
            store
                .read_with(|c| c.busy_timeout(Duration::ZERO))
                .map_err(StorageError::persist_public)?;
            Ok(())
        })
        .await
        .unwrap();
    let writer = Arc::new(Mutex::new(
        rusqlite::Connection::open(engine_db_path(&f.root).unwrap()).unwrap(),
    ));
    let lock_once = Arc::new(AtomicUsize::new(0));
    if lock_at_commit {
        let writer = writer.clone();
        let lock_once = lock_once.clone();
        probes()
            .lock()
            .unwrap()
            .entry(f.ws.clone())
            .or_default()
            .hook = Some(Arc::new(move |_, _| {
            if lock_once.fetch_add(1, Ordering::SeqCst) == 0 {
                writer
                    .lock()
                    .unwrap()
                    .execute_batch("BEGIN IMMEDIATE")
                    .unwrap();
            }
        }));
    }
    let writer2 = writer.clone();
    let leases = f.leases.clone();
    let open = Arc::new(move |key: &DocKey| {
        if !lock_at_commit && lock_once.fetch_add(1, Ordering::SeqCst) == 0 {
            writer2
                .lock()
                .unwrap()
                .execute_batch("BEGIN IMMEDIATE")
                .unwrap();
        }
        leases.is_held(key)
    });
    let [entered, release] = undo_probe::pause_checkpoint(&f.ws);
    let pass = f.actor.history_rewrite_links(
        f.ws.clone(),
        OP.into(),
        "forward-read-lock".into(),
        None,
        f.root.to_path_buf(),
        f.leases.clone(),
        [f.capture.clone(), f.serial.clone()],
        Arc::new(NoFaults),
        (open, Arc::new(|_| {})),
        Arc::new(()),
        CancellationToken::new(),
    );
    let done = Arc::new(tokio::sync::Notify::new());
    let unlock = async {
        // The old pass returns FileLocked without reaching the wait hook.
        tokio::select! {
            () = entered.notified() => {
                writer.lock().unwrap().execute_batch("ROLLBACK").unwrap();
                release.notify_one();
            }
            () = done.notified() => {
                writer.lock().unwrap().execute_batch("ROLLBACK").unwrap();
            }
        }
    };
    let pass = async {
        let result = pass.await;
        done.notify_one();
        result
    };
    let (result, ()) = tokio::join!(pass, unlock);
    drop(lease);
    drop(writer);
    f.close().await;
    assert_eq!(
        result.expect("forward read must wait for the checkpoint lock")["documents"],
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_write_defers_only_the_stale_source() {
    let f = Fixture::new(2, 2);
    let (lease, _) = f.open_document("source-0000").await;
    let outside = "agent text [[old]]\n";
    std::fs::write(f.root.join("source-0000.md"), outside).unwrap();
    let result = f.pass("outside-write", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(result["documents"], 1);
    assert_eq!(result["complete"], false);
    assert_eq!(result["unchecked"], json!(["source-0000.md"]));
    assert_eq!(
        std::fs::read_to_string(f.root.join("source-0000.md")).unwrap(),
        outside
    );
    assert!(
        f.text("source-0001.md")
            .await
            .contains("[[new#part|label]]")
    );
    drop(lease);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_write_same_request_resumes_unwritten_sources_after_reopen() {
    let mut f = Fixture::new(20, 20);
    let (lease, _) = f.open_document("source-0019").await;
    let outside = "agent text [[old]]\n";
    std::fs::write(f.root.join("source-0019.md"), outside).unwrap();
    let first = f.pass("outside-resume", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(first["complete"], false);
    assert_eq!(first["unchecked"], json!(["source-0019.md"]));
    let before = f
        .actor
        .history_operation(f.ws.clone(), OP.into())
        .await
        .unwrap();
    assert!(
        before.moments.len() > 1,
        "some healthy sources committed before the stale source"
    );
    drop(lease);
    f.restart().await;
    f.edit("source-0019", "source-0019.md", outside).await;
    let read = Arc::new(Mutex::new(Vec::new()));
    let observed = read.clone();
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(move |_, object| {
        observed.lock().unwrap().push(object.to_owned())
    }));
    let result = f.pass("outside-resume", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(result["documents"], 20);
    assert_eq!(result["complete"], true);
    for moment in before.moments.iter().filter(|m| m.operation == "write") {
        assert!(
            !read.lock().unwrap().contains(&moment.object_id),
            "finished source was read again"
        );
    }
    assert_eq!(f.text("source-0019.md").await, "agent text [[new]]\n");
    f.close().await;
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

    async fn released(&self) {
        self.actor.offer_released_link_rewrites(&self.ws);
        self.actor.retry_pending_link_rewrites(&self.ws).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_capture_retries_only_that_note_and_undo_keeps_prose() {
    let f = Fixture::new(3, 3);
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
async fn outside_undo_before_capture_cancels_retry() {
    let f = Fixture::new(2, 2);
    let (lease, _) = f.open_document("source-0000").await;
    let outside = "agent text [[old]]\n";
    std::fs::write(f.root.join("source-0000.md"), outside).unwrap();
    f.pass("undo-before-capture", Arc::new(NoFaults))
        .await
        .unwrap();
    drop(lease);
    f.publish().await;
    f.undo().await.unwrap();
    f.outside_head("source-0000", outside, "outside-after-undo")
        .await;
    f.captured("source-0000.md").await;
    assert_eq!(f.text("source-0000.md").await, outside);
    assert!(f.actor.link_rewrites.deferred.lock().unwrap().is_empty());
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_newer_write_waits_for_next_capture_without_polling() {
    let f = Fixture::new(1, 1);
    let (lease, _) = f.open_document("source-0000").await;
    let first = "first prose [[old]]\n";
    let second = "second prose [[old]]\n";
    std::fs::write(f.root.join("source-0000.md"), first).unwrap();
    f.pass("newer-outside", Arc::new(NoFaults)).await.unwrap();
    drop(lease);
    f.outside_head("source-0000", first, "first-outside").await;
    let path = f.root.join("source-0000.md");
    let reads = Arc::new(AtomicUsize::new(0));
    let observed = reads.clone();
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(move |_, _| {
        observed.fetch_add(1, Ordering::SeqCst);
        std::fs::write(&path, second).unwrap();
    }));
    f.captured("source-0000.md").await;
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert!(!f.rewrite_receipt("newer-outside").await.0);
    f.released().await;
    assert_eq!(
        reads.load(Ordering::SeqCst),
        1,
        "a newer outside write needs another capture"
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("source-0000.md")).unwrap(),
        second
    );
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = None;
    f.outside_head("source-0000", second, "second-outside")
        .await;
    f.captured("source-0000.md").await;
    assert_eq!(f.text("source-0000.md").await, "second prose [[new]]\n");
    assert!(f.rewrite_receipt("newer-outside").await.0);
    f.publish().await;
    f.undo().await.unwrap();
    assert_eq!(f.text("source-0000.md").await, second);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_capture_waits_for_a_reopened_lease_to_release() {
    let f = Fixture::new(1, 1);
    let (lease, _) = f.open_document("source-0000").await;
    let outside = "agent prose [[old]]\n";
    std::fs::write(f.root.join("source-0000.md"), outside).unwrap();
    f.pass("reopened-outside", Arc::new(NoFaults))
        .await
        .unwrap();
    drop(lease);
    let reads = Arc::new(AtomicUsize::new(0));
    let observed = reads.clone();
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(move |_, _| {
        observed.fetch_add(1, Ordering::SeqCst);
    }));
    f.released().await;
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "capture must offer the note first"
    );
    f.outside_head("source-0000", outside, "outside-before-reopen")
        .await;
    let key = DocKey::new(&f.ws, "main", "source-0000").unwrap();
    let reopened = f.leases.acquire(&key).unwrap();
    f.captured("source-0000.md").await;
    assert_eq!(f.text("source-0000.md").await, outside);
    assert!(!f.rewrite_receipt("reopened-outside").await.0);
    drop(reopened);
    f.released().await;
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert_eq!(f.text("source-0000.md").await, "agent prose [[new]]\n");
    assert!(f.rewrite_receipt("reopened-outside").await.0);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_retry_failure_keeps_pending_work_and_durable_progress() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        for nth in [4, 5] {
            let f = Fixture::new(1, 1);
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
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_refused_undo_keeps_the_deferred_retry() {
    let f = Fixture::new(2, 2);
    let (lease, _) = f.open_document("source-0000").await;
    let outside = "agent prose [[old]]\n";
    std::fs::write(f.root.join("source-0000.md"), outside).unwrap();
    f.pass("outside-refused-undo", Arc::new(NoFaults))
        .await
        .unwrap();
    f.publish().await;
    std::fs::write(f.root.join("source-0001.md"), "new outside prose [[new]]\n").unwrap();
    assert!(matches!(
        f.undo().await,
        Err(RuntimeError::Domain(DomainError::UndoRefused { .. }))
    ));
    drop(lease);
    f.outside_head("source-0000", outside, "outside-after-refused-undo")
        .await;
    f.captured("source-0000.md").await;
    assert_eq!(f.text("source-0000.md").await, "agent prose [[new]]\n");
    assert!(f.rewrite_receipt("outside-refused-undo").await.0);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_retry_yields_to_another_pass_and_keeps_its_offer() {
    let f = Fixture::new(1, 1);
    let (lease, _) = f.open_document("source-0000").await;
    let outside = "agent prose [[old]]\n";
    std::fs::write(f.root.join("source-0000.md"), outside).unwrap();
    f.pass("outside-busy-pass", Arc::new(NoFaults))
        .await
        .unwrap();
    drop(lease);
    f.outside_head("source-0000", outside, "outside-before-busy-pass")
        .await;
    f.actor
        .offer_captured_link_rewrites(&f.ws, &["source-0000.md".into()]);
    let other_pass = f.actor.link_rewrites.gate.clone().lock_owned().await;
    tokio::time::timeout(
        Duration::from_secs(5),
        f.actor.retry_pending_link_rewrites(&f.ws),
    )
    .await
    .expect("capture must yield to a running link pass");
    assert_eq!(f.text("source-0000.md").await, outside);
    assert!(!f.rewrite_receipt("outside-busy-pass").await.0);
    drop(other_pass);
    f.actor.retry_pending_link_rewrites(&f.ws).await;
    assert_eq!(f.text("source-0000.md").await, "agent prose [[new]]\n");
    assert!(f.rewrite_receipt("outside-busy-pass").await.0);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_retry_paused_mid_turn_resumes_after_undo_is_cancelled() {
    let f = Fixture::new(1, 1);
    let (lease, _) = f.open_document("source-0000").await;
    let outside = "agent prose [[old]]\n";
    std::fs::write(f.root.join("source-0000.md"), outside).unwrap();
    f.pass("outside-cancelled-undo", Arc::new(NoFaults))
        .await
        .unwrap();
    drop(lease);
    f.outside_head("source-0000", outside, "outside-before-paused-undo")
        .await;
    let stopped = Arc::new(Mutex::new(None));
    let observed = stopped.clone();
    let actor = f.actor.clone();
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(move |_, _| {
        *observed.lock().unwrap() = Some(actor.stop_link_rewrites(OP));
    }));
    f.captured("source-0000.md").await;
    assert_eq!(f.text("source-0000.md").await, outside);
    assert!(!f.rewrite_receipt("outside-cancelled-undo").await.0);
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = None;
    stopped.lock().unwrap().take();
    f.actor.retry_pending_link_rewrites(&f.ws).await;
    assert_eq!(f.text("source-0000.md").await, "agent prose [[new]]\n");
    assert!(f.rewrite_receipt("outside-cancelled-undo").await.0);
    f.close().await;
}
