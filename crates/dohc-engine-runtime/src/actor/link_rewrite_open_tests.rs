use super::*;
use dohc_engine_collab::{ContentKind, Lease, LocalAppend, Regime, Ydoc};

impl Fixture {
    async fn open_document(&self, object: &str) -> (Lease, Ydoc) {
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
                let seed = doc.rewrite_content_to_markdown_preserving_source(
                    ContentKind::Richdoc,
                    &head.text,
                )?;
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
        let update = doc
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, text)
            .unwrap();
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
                    &CancellationToken::new()
                )?);
                Ok(())
            })
            .await
            .unwrap();
    }
    async fn undo_open(
        &self,
    ) -> Result<super::super::super::history_operations::HistoryUndoResult, RuntimeError> {
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
                Some((self.leases.clone(), Arc::new(|_| {}))),
                CancellationToken::new(),
            )
            .await
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
    let result = f.undo_open().await.unwrap();
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
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let mut f = Fixture::new(1, 1);
        let (lease, _) = f.open_document("source-0000").await;
        let ws = f.ws.clone();
        let root = f.root.to_path_buf();
        let before = f.document("source-0000").await.encode_state_vector();
        let committed = point == FaultPoint::StorageAfterCommitBeforeAck;
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
                assert!(fault.fired());
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
