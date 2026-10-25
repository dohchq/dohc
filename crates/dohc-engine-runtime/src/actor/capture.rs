use super::ActorHandle;
use super::journal::{
    journal_moment_outbound_in_tx, journal_moment_outbound_with_batch_in_tx,
    journal_secret_delete_outbound_in_tx, journal_secret_put_outbound_in_tx,
};
use super::materialization::SelfWriteRecorder;
use super::versioned::{
    delete_owned_scene_assets_in_tx, materialize_scene_asset_deletes,
    with_local_file_mutation_cache_reset,
};
use super::versions::ensure_mutation_version_on_store;
use crate::error::RuntimeError;
use crate::search::index::update_file_search_index_for_capture;
use crate::search::{SearchPolicySnapshot, delete_file_search_index, upsert_file_search_index};
use dohc_engine_collab::{DocKey, LeaseRegistry};
use dohc_engine_crypto::SecretDataKey;
use dohc_engine_domain::{
    CaptureIngest, CaptureIngestBatchContext, CaptureIngestBinary, CaptureIngestBinaryResult,
    CaptureManifestSeedEntry, CaptureRetire, CaptureRetireResult, CaptureSecret,
    CaptureSecretRetire, DomainError, SecretFileStore, SecretMomentRecord, SecretWriteResult,
    VersionedTextStore, WriteResult, capture_ingest_binary_with_admission_in_tx,
    capture_ingest_in_batch_with_admission_in_tx, capture_ingest_with_admission_in_tx,
    capture_manifest_seed, capture_retire_in_tx, capture_retire_respelled_in_tx,
    capture_secret_retire_with, ensure_main_version_in_tx,
};
use dohc_engine_files::floor::path_collision_key;
use dohc_engine_storage::capture_file_holds::{self, CaptureFileHold};
use dohc_engine_storage::{EngineStore, FaultInjector, StorageError, TxnOutcome};
use rusqlite::{Connection, Transaction, params};
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[path = "capture_reader.rs"]
mod reader;

#[cfg(test)]
mod capture_file_hold_tests {
    use super::*;
    use dohc_engine_collab::{
        ContentKind, LocalAppend, MarkerCreation, Regime, WriterDocCache, Ydoc,
    };
    use dohc_engine_storage::NoFaults;
    use dohc_engine_testkit::{ScratchDir, engine_db_path};

    fn input(path: &str, text: &str) -> CaptureIngest {
        CaptureIngest {
            workspace_id: "hold-proof".into(),
            version_id: "main".into(),
            path: path.into(),
            text: text.into(),
            metadata_origin: "capture".into(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 5,
            request_id: None,
            claim_foreign_head: false,
        }
    }

    fn seeded() -> (ScratchDir, EngineStore, CaptureIngest) {
        let scratch = ScratchDir::new().unwrap();
        let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("hold-proof", "main", 1, &NoFaults)
            .unwrap();
        let seed = input("held.md", "Before.\n");
        let head = VersionedTextStore::new(&mut store)
            .capture_ingest(&seed, &NoFaults)
            .unwrap()
            .snapshot;
        let key = DocKey::new("hold-proof", "main", &head.object_id).unwrap();
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, &seed.text)
            .unwrap();
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut WriterDocCache::new(),
            &key,
            &doc.encode_full_state(),
            LocalAppend {
                marker: Some(MarkerCreation {
                    path: Some("held.md"),
                    content_kind: ContentKind::Richdoc,
                    regime: Regime::LocalOnly,
                }),
                is_seed: true,
                seed_source_sha256: Some(&head.blob_sha256),
                ..Default::default()
            },
            &NoFaults,
            3,
            |_tx, _outcome, _sha| Ok(()),
        )
        .unwrap();
        (
            scratch,
            store,
            input("held.md", &format!("{} too deep\n", "> ".repeat(121))),
        )
    }

    #[test]
    fn review2_unowned_release_only_reports_an_exact_hold() {
        let (_scratch, mut store, refused) = seeded();
        assert_eq!(
            offer(&mut store, &refused).unwrap_err().code(),
            "capture-file-held"
        );
        for path in ["HELD.MD", "held.md/trip.md"] {
            assert!(
                !clear_unowned_capture_hold(&mut store, "hold-proof", path, &NoFaults).unwrap()
            );
            assert!(
                store
                    .read_with(|conn| capture_file_holds::hold_in(conn, "hold-proof", "held.md"))
                    .unwrap()
                    .is_some()
            );
        }
        assert!(
            clear_unowned_capture_hold(&mut store, "hold-proof", "held.md", &NoFaults).unwrap()
        );
    }

    fn offer(store: &mut EngineStore, input: &CaptureIngest) -> Result<WriteResult, RuntimeError> {
        capture_ingest_on_store(
            store,
            input,
            &CaptureIndexing::Skip,
            &LeaseRegistry::new(),
            &NoFaults,
            &CancellationToken::new(),
        )
    }

    #[test]
    fn fix2_recreated_unrepresentable_file_is_durably_held() {
        let (scratch, mut store, refused) = seeded();
        VersionedTextStore::new(&mut store)
            .delete_text_file(
                &dohc_engine_domain::DeleteTextFile {
                    workspace_id: "hold-proof".into(),
                    version_id: "main".into(),
                    path: "held.md".into(),
                    moment_id: "delete-before-recreate".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 4,
                },
                &NoFaults,
            )
            .unwrap();
        let error = offer(&mut store, &refused).unwrap_err();
        drop(store);
        let reopened = EngineStore::open(&engine_db_path(&scratch).unwrap(), 6).unwrap();
        let held = reopened
            .read_with(|conn| capture_file_holds::hold_in(conn, "hold-proof", "held.md"))
            .unwrap();
        assert_eq!(error.code(), "capture-file-held");
        assert_eq!(
            held.unwrap().observed_sha256,
            dohc_engine_storage::hex_sha256(refused.text.as_bytes())
        );
    }

    #[test]
    fn fix3_recreated_hold_retires_atomically_without_a_snapshot() {
        let (scratch, mut store, refused) = seeded();
        VersionedTextStore::new(&mut store)
            .delete_text_file(
                &dohc_engine_domain::DeleteTextFile {
                    workspace_id: "hold-proof".into(),
                    version_id: "main".into(),
                    path: "held.md".into(),
                    moment_id: "delete-before-recreate".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 4,
                },
                &NoFaults,
            )
            .unwrap();
        assert_eq!(
            offer(&mut store, &refused).unwrap_err().code(),
            "capture-file-held"
        );
        let retire = CaptureRetire {
            workspace_id: "hold-proof".into(),
            version_id: "main".into(),
            path: "held.md".into(),
            metadata_summary: None,
            metadata_correlation_id: None,
            now_ms: 6,
            request_id: None,
            only_if_text_head: true,
            only_if_capture_origin: true,
            allow_ydoc_origin: true,
        };
        let result = capture_retire_on_store(
            &mut store,
            &retire,
            None,
            scratch.path(),
            &Root,
            true,
            &(),
            &LeaseRegistry::new(),
            &NoFaults,
        );
        assert!(
            result.is_ok(),
            "snapshotless held alias must retire: {result:?}"
        );
        assert_unheld(&store);
        let aliases: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT count(*) FROM path_aliases WHERE path='held.md'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(aliases, 0);
        assert_eq!(
            offer(&mut store, &input("held.md", "Recreated normally.\n"))
                .unwrap()
                .snapshot
                .text,
            "Recreated normally.\n"
        );
    }

    #[test]
    fn fix2_unheld_foreign_text_and_binary_do_not_clear_a_hold() {
        use rusqlite::hooks::{AuthAction, Authorization};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (_scratch, mut store, mut input) = seeded();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE snapshots SET metadata_origin='sync' WHERE path='held.md'",
                    [],
                )
                .map_err(StorageError::persist_public)
            })
            .unwrap();
        let deletes = Arc::new(AtomicUsize::new(0));
        let observed = deletes.clone();
        store
            .read_with(|conn| {
                conn.authorizer(Some(move |ctx: rusqlite::hooks::AuthContext<'_>| {
                    if matches!(
                        ctx.action,
                        AuthAction::Delete {
                            table_name: "capture_file_holds"
                        }
                    ) {
                        observed.fetch_add(1, Ordering::Relaxed);
                    }
                    Authorization::Allow
                }))
            })
            .unwrap();
        input.text = "Outside.\n".into();
        assert!(matches!(
            offer(&mut store, &input),
            Err(RuntimeError::Domain(DomainError::CaptureNotOwned))
        ));
        assert!(matches!(
            capture_ingest_binary_on_store(
                &mut store,
                &CaptureIngestBinary {
                    workspace_id: input.workspace_id,
                    version_id: input.version_id,
                    path: input.path,
                    bytes: b"binary".to_vec(),
                    metadata_origin: "capture".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 7,
                    request_id: None,
                    claim_foreign_head: false,
                },
                &LeaseRegistry::new(),
                &NoFaults,
                &CancellationToken::new()
            ),
            Err(RuntimeError::Domain(DomainError::CaptureNotOwned))
        ));
        assert_eq!(
            deletes.load(Ordering::Relaxed),
            0,
            "unheld ownership refusals must not open a hold-clearing transaction"
        );
    }

    fn assert_unheld(store: &EngineStore) {
        assert!(
            store
                .read_with(|conn| capture_file_holds::hold_in(conn, "hold-proof", "held.md"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn fix1_hold_released_by_rename() {
        let (_scratch, mut store, refused) = seeded();
        assert_eq!(
            offer(&mut store, &refused).unwrap_err().code(),
            "capture-file-held"
        );
        VersionedTextStore::new(&mut store)
            .rename_text_file(
                &dohc_engine_domain::RenameTextFile {
                    workspace_id: "hold-proof".into(),
                    version_id: "main".into(),
                    from_path: "held.md".into(),
                    to_path: "moved.md".into(),
                    moment_id: "rename-held".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 6,
                },
                &NoFaults,
            )
            .unwrap();
        assert_unheld(&store);
        let captured = offer(&mut store, &input("held.md", "New file.\n")).unwrap();
        assert_eq!(captured.snapshot.text, "New file.\n");
    }

    #[test]
    fn fix1_hold_released_by_rollback_removing_alias() {
        let (_scratch, mut store, refused) = seeded();
        let initial = VersionedTextStore::new(&mut store)
            .read_text("hold-proof", "main", "held.md")
            .unwrap()
            .unwrap();
        assert_eq!(
            offer(&mut store, &refused).unwrap_err().code(),
            "capture-file-held"
        );
        VersionedTextStore::new(&mut store)
            .rollback_text_file_mutation(
                &dohc_engine_domain::RollbackTextFileMutation {
                    workspace_id: "hold-proof".into(),
                    version_id: "main".into(),
                    path: "held.md".into(),
                    mutation_moment_id: initial.latest_moment_id,
                    request_id: None,
                    metadata_origin: "api".into(),
                    author_json: None,
                },
                &NoFaults,
            )
            .unwrap();
        assert_unheld(&store);
        assert_eq!(
            offer(&mut store, &input("held.md", "New file.\n"))
                .unwrap()
                .snapshot
                .text,
            "New file.\n"
        );
    }

    #[test]
    fn fix1_hold_does_not_claim_foreign_text_or_binary_head() {
        for binary in [false, true] {
            let (scratch, mut store, refused) = seeded();
            assert_eq!(
                offer(&mut store, &refused).unwrap_err().code(),
                "capture-file-held"
            );
            let head = VersionedTextStore::new(&mut store)
                .read_text("hold-proof", "main", "held.md")
                .unwrap()
                .unwrap();
            let remote = VersionedTextStore::new(&mut store)
                .write_text(
                    &dohc_engine_domain::WriteText {
                        workspace_id: "hold-proof".into(),
                        version_id: "main".into(),
                        object_id: head.object_id,
                        path: "held.md".into(),
                        text: "Remote edit.\n".into(),
                        moment_id: "remote-edit".into(),
                        metadata_origin: "sync".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 6,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
            std::fs::write(scratch.path().join("held.md"), &refused.text).unwrap();
            store
                .write_with(&NoFaults, |tx| {
                    dohc_engine_storage::enqueue_job(
                        tx,
                        &dohc_engine_storage::MaterializationJobSpec {
                            job_id: "relay-remote-edit".into(),
                            workspace_id: "hold-proof".into(),
                            target_path: "held.md".into(),
                            content_sha256: remote.snapshot.blob_sha256.clone(),
                            preimage: dohc_engine_storage::Preimage::Present(
                                dohc_engine_storage::hex_sha256(refused.text.as_bytes()),
                            ),
                            target_generation: remote.moment.moment_order,
                            now_ms: 6,
                        },
                    )
                })
                .unwrap();
            let job = store
                .load_materialization_job("relay-remote-edit")
                .unwrap()
                .unwrap();
            assert_eq!(
                dohc_engine_files::materialize_one(
                    &store,
                    scratch.path(),
                    &job,
                    &dohc_engine_files::MaterializeOptions {
                        holds: None,
                        policy: dohc_engine_files::DurabilityPolicy::per_os(),
                        replacer: &dohc_engine_files::StdReplacer,
                        backoff: &dohc_engine_files::NoBackoff,
                        now_ms: 6,
                        faults: &NoFaults,
                    }
                )
                .unwrap(),
                dohc_engine_files::JobOutcome::Parked
            );
            let error = if binary {
                capture_ingest_binary_on_store(
                    &mut store,
                    &CaptureIngestBinary {
                        workspace_id: "hold-proof".into(),
                        version_id: "main".into(),
                        path: "held.md".into(),
                        bytes: vec![0, 1, 2],
                        metadata_origin: "capture".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 7,
                        request_id: None,
                        claim_foreign_head: false,
                    },
                    &LeaseRegistry::new(),
                    &NoFaults,
                    &CancellationToken::new(),
                )
                .unwrap_err()
            } else {
                offer(&mut store, &input("held.md", "Outside edit.\n")).unwrap_err()
            };
            assert!(
                matches!(error, RuntimeError::CaptureNotOwnedAfterHold { .. }),
                "{error:?}"
            );
            assert_unheld(&store);
            assert_eq!(
                VersionedTextStore::new(&mut store)
                    .read_text("hold-proof", "main", "held.md")
                    .unwrap()
                    .unwrap()
                    .text,
                "Remote edit.\n"
            );
        }
    }

    #[test]
    fn fix1_missing_alias_refusal_does_not_abort_batch() {
        let (scratch, mut store, refused) = seeded();
        // Capture can recreate an alias over an existing lineage. If its fold
        // refuses, rolling back the item also removes that provisional alias.
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("DELETE FROM path_aliases WHERE path='held.md'", [])
                    .map_err(StorageError::persist_public)
            })
            .unwrap();
        let results = capture_ingest_batch_on_store(
            &mut store,
            &[refused, input("sibling.txt", "Sibling.\n")],
            &Arc::new(crate::search::read_engine_search_policy(scratch.path())),
            &LeaseRegistry::new(),
            &NoFaults,
            &CancellationToken::new(),
            (scratch.path(), &Root),
        )
        .unwrap();
        assert!(results[0].is_err());
        assert!(results[1].is_ok());
        assert_eq!(results[0].as_ref().unwrap_err().code(), "capture-file-held");
        assert!(
            store
                .read_with(|conn| capture_file_holds::hold_in(conn, "hold-proof", "held.md"))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn fix1_hold_batch_ownership_refusal_releases_only_its_hold() {
        let (scratch, mut store, refused) = seeded();
        assert_eq!(
            offer(&mut store, &refused).unwrap_err().code(),
            "capture-file-held"
        );
        let head = VersionedTextStore::new(&mut store)
            .read_text("hold-proof", "main", "held.md")
            .unwrap()
            .unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: "hold-proof".into(),
                    version_id: "main".into(),
                    object_id: head.object_id,
                    path: "held.md".into(),
                    text: "Remote edit.\n".into(),
                    moment_id: "remote-edit".into(),
                    metadata_origin: "sync".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 6,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        let results = capture_ingest_batch_on_store(
            &mut store,
            &[
                input("held.md", "Outside edit.\n"),
                input("sibling.txt", "Sibling.\n"),
            ],
            &Arc::new(crate::search::read_engine_search_policy(scratch.path())),
            &LeaseRegistry::new(),
            &NoFaults,
            &CancellationToken::new(),
            (scratch.path(), &Root),
        )
        .unwrap();
        assert!(matches!(
            results[0],
            Err(RuntimeError::CaptureNotOwnedAfterHold { .. })
        ));
        assert!(results[1].is_ok());
        assert_unheld(&store);
        assert_eq!(
            VersionedTextStore::new(&mut store)
                .read_text("hold-proof", "main", "held.md")
                .unwrap()
                .unwrap()
                .text,
            "Remote edit.\n"
        );
    }

    #[test]
    fn capture_file_hold_single_operation_acknowledges_without_a_moment() {
        let (_scratch, mut store, refused) = seeded();
        let error = offer(&mut store, &refused).unwrap_err();
        assert_eq!(error.code(), "capture-file-held");
        let (sha, count): (String, i64) = store.read_with(|conn| conn.query_row(
            "SELECT h.observed_sha256,(SELECT COUNT(*) FROM moments WHERE workspace_id=h.workspace_id AND path=h.path) FROM capture_file_holds h",
            [], |r| Ok((r.get(0)?, r.get(1)?)))).unwrap();
        assert_eq!(
            sha,
            dohc_engine_storage::hex_sha256(refused.text.as_bytes())
        );
        assert_eq!(count, 1);
        assert_eq!(
            VersionedTextStore::new(&mut store)
                .read_text("hold-proof", "main", "held.md")
                .unwrap()
                .unwrap()
                .text,
            "Before.\n"
        );
    }

    fn operation_rename(store: &mut EngineStore) {
        VersionedTextStore::new(store)
            .rename_text_file_with(
                &dohc_engine_domain::RenameTextFile {
                    workspace_id: "hold-proof".into(),
                    version_id: "main".into(),
                    from_path: "held.md".into(),
                    to_path: "moved.md".into(),
                    moment_id: "operation-rename".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: Some("dohc-operation:hold-proof".into()),
                    author_json: None,
                    now_ms: 4,
                },
                &NoFaults,
                |tx, result| {
                    dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                        tx,
                        "hold-proof",
                        "main",
                        &result.object.object_id,
                        dohc_engine_sync::ResultingHead::Text {
                            path: "moved.md",
                            text: &result.after.text,
                        },
                        None,
                        None,
                        4,
                    )
                    .map_err(|e| {
                        DomainError::Storage(StorageError::persist_public(std::io::Error::other(e)))
                    })?;
                    Ok(())
                },
            )
            .unwrap();
    }
    fn operation_undo(
        store: &mut EngineStore,
        root: &std::path::Path,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<super::super::history_operations::HistoryUndoResult, RuntimeError> {
        super::super::history_operations::test_undo_in_turns(
            store,
            "hold-proof",
            "dohc-operation:hold-proof",
            "undo-hold-proof",
            None,
            root,
            faults,
            10,
        )
    }
    #[test]
    fn history_operation_held_rename_refuses_without_compensators_or_hold_changes() {
        let (scratch, mut store, mut refused) = seeded();
        operation_rename(&mut store);
        refused.path = "moved.md".into();
        refused.claim_foreign_head = true;
        std::fs::write(scratch.path().join("moved.md"), &refused.text).unwrap();
        assert_eq!(
            offer(&mut store, &refused).unwrap_err().code(),
            "capture-file-held"
        );
        let before = store
            .read_with(|conn| capture_file_holds::list_in(conn, "hold-proof"))
            .unwrap();
        let n: i64 = store
            .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM moments", [], |r| r.get(0)))
            .unwrap();
        assert!(
            matches!(operation_undo(&mut store,scratch.path(),Arc::new(NoFaults)),Err(RuntimeError::Domain(DomainError::UndoRefused {path,reason:"capture hold"})) if path=="moved.md")
        );
        assert_eq!(
            store
                .read_with(|conn| capture_file_holds::list_in(conn, "hold-proof"))
                .unwrap(),
            before
        );
        assert_eq!(
            store
                .read_with(|conn| conn
                    .query_row("SELECT COUNT(*) FROM moments", [], |r| r.get::<_, i64>(0)))
                .unwrap(),
            n
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("moved.md")).unwrap(),
            refused.text
        );
        assert!(!scratch.path().join("held.md").exists());
    }
    #[test]
    fn history_operation_held_restoration_target_refuses_whole_undo() {
        let (scratch, mut store, refused) = seeded();
        VersionedTextStore::new(&mut store)
            .delete_text_file(
                &dohc_engine_domain::DeleteTextFile {
                    workspace_id: "hold-proof".into(),
                    version_id: "main".into(),
                    path: "held.md".into(),
                    moment_id: "operation-delete".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: Some("dohc-operation:hold-proof".into()),
                    author_json: None,
                    now_ms: 4,
                },
                &NoFaults,
            )
            .unwrap();
        std::fs::write(scratch.path().join("held.md"), &refused.text).unwrap();
        assert_eq!(
            offer(&mut store, &refused).unwrap_err().code(),
            "capture-file-held"
        );
        let before = store
            .read_with(|conn| capture_file_holds::list_in(conn, "hold-proof"))
            .unwrap();
        assert!(
            matches!(operation_undo(&mut store,scratch.path(),Arc::new(NoFaults)),Err(RuntimeError::Domain(DomainError::UndoRefused {path,reason:"capture hold"})) if path=="held.md")
        );
        assert_eq!(
            store
                .read_with(|conn| capture_file_holds::list_in(conn, "hold-proof"))
                .unwrap(),
            before
        );
        assert_eq!(
            store
                .read_with(|conn| conn
                    .query_row("SELECT COUNT(*) FROM moments", [], |r| r.get::<_, i64>(0)))
                .unwrap(),
            2
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("held.md")).unwrap(),
            refused.text
        );
    }
    #[test]
    fn history_operation_unrelated_hold_does_not_block_undo() {
        let (scratch, mut store, refused) = seeded();
        std::fs::write(scratch.path().join("held.md"), &refused.text).unwrap();
        assert_eq!(
            offer(&mut store, &refused).unwrap_err().code(),
            "capture-file-held"
        );
        let before = store
            .read_with(|conn| capture_file_holds::list_in(conn, "hold-proof"))
            .unwrap();
        offer(&mut store, &input("other.txt", "Other")).unwrap();
        VersionedTextStore::new(&mut store)
            .rename_text_file(
                &dohc_engine_domain::RenameTextFile {
                    workspace_id: "hold-proof".into(),
                    version_id: "main".into(),
                    from_path: "other.txt".into(),
                    to_path: "renamed.txt".into(),
                    moment_id: "operation-rename".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: Some("dohc-operation:hold-proof".into()),
                    author_json: None,
                    now_ms: 4,
                },
                &NoFaults,
            )
            .unwrap();
        std::fs::write(scratch.path().join("renamed.txt"), "Other").unwrap();
        assert!(
            operation_undo(&mut store, scratch.path(), Arc::new(NoFaults))
                .unwrap()
                .materialized
        );
        assert_eq!(
            store
                .read_with(|conn| capture_file_holds::list_in(conn, "hold-proof"))
                .unwrap(),
            before
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("other.txt")).unwrap(),
            "Other"
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("held.md")).unwrap(),
            refused.text
        );
    }
    #[test]
    fn history_operation_pending_inverse_defers_capture_at_both_endpoints() {
        #[derive(Default)]
        struct Crash(std::sync::atomic::AtomicUsize);
        impl FaultInjector for Crash {
            fn poll(&self, p: dohc_engine_storage::FaultPoint) -> dohc_engine_storage::FaultAction {
                if p == dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck
                    && self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1
                {
                    dohc_engine_storage::FaultAction::Crash
                } else {
                    dohc_engine_storage::FaultAction::Continue
                }
            }
        }
        let (scratch, mut store, _) = seeded();
        operation_rename(&mut store);
        std::fs::write(scratch.path().join("moved.md"), "Before.\n").unwrap();
        assert!(matches!(
            operation_undo(&mut store, scratch.path(), Arc::new(Crash::default())),
            Err(RuntimeError::OperationCrashed)
        ));
        let count = store
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM moments", [], |r| r.get::<_, i64>(0))
            })
            .unwrap();
        for path in ["moved.md", "held.md"] {
            assert!(matches!(
                offer(&mut store, &input(path, "Before.\n")),
                Err(RuntimeError::Sync(
                    dohc_engine_sync::SyncError::RetryableState {
                        reason: "history-undo-placement-pending"
                    }
                ))
            ));
        }
        let retire = CaptureRetire {
            workspace_id: "hold-proof".into(),
            version_id: "main".into(),
            path: "held.md".into(),
            metadata_summary: None,
            metadata_correlation_id: None,
            now_ms: 6,
            request_id: None,
            only_if_text_head: true,
            only_if_capture_origin: false,
            allow_ydoc_origin: true,
        };
        assert!(matches!(
            capture_retire_on_store(
                &mut store,
                &retire,
                None,
                scratch.path(),
                &Root,
                true,
                &(),
                &LeaseRegistry::new(),
                &NoFaults
            ),
            Err(RuntimeError::Sync(
                dohc_engine_sync::SyncError::RetryableState {
                    reason: "history-undo-placement-pending"
                }
            ))
        ));
        assert_eq!(
            store
                .read_with(|conn| conn
                    .query_row("SELECT COUNT(*) FROM moments", [], |r| r.get::<_, i64>(0)))
                .unwrap(),
            count
        );
        assert_unheld(&store);
        assert_eq!(
            std::fs::read(scratch.path().join("moved.md")).unwrap(),
            b"Before.\n"
        );
        assert!(!scratch.path().join("held.md").exists());
        assert!(
            operation_undo(&mut store, scratch.path(), Arc::new(NoFaults))
                .unwrap()
                .materialized
        );
    }

    #[test]
    fn history_operation_restart_parked_placement_never_reports_restored() {
        #[derive(Default)]
        struct Crash(std::sync::atomic::AtomicUsize);
        impl FaultInjector for Crash {
            fn poll(&self, p: dohc_engine_storage::FaultPoint) -> dohc_engine_storage::FaultAction {
                if p == dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck
                    && self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1
                {
                    dohc_engine_storage::FaultAction::Crash
                } else {
                    dohc_engine_storage::FaultAction::Continue
                }
            }
        }
        let (scratch, mut store, mut refused) = seeded();
        refused.claim_foreign_head = true;
        operation_rename(&mut store);
        std::fs::write(scratch.path().join("moved.md"), "Before.\n").unwrap();
        assert!(matches!(
            operation_undo(&mut store, scratch.path(), Arc::new(Crash::default())),
            Err(RuntimeError::OperationCrashed)
        ));
        drop(store);
        let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 11).unwrap();
        std::fs::write(scratch.path().join("held.md"), &refused.text).unwrap();
        assert_eq!(
            offer(&mut store, &refused).unwrap_err().code(),
            "capture-file-held"
        );
        let before = store
            .read_with(|conn| capture_file_holds::list_in(conn, "hold-proof"))
            .unwrap();
        let result = operation_undo(&mut store, scratch.path(), Arc::new(NoFaults)).unwrap();
        assert!(result.deduped && !result.materialized);
        assert_eq!(
            store
                .read_with(|conn| capture_file_holds::list_in(conn, "hold-proof"))
                .unwrap(),
            before
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("held.md")).unwrap(),
            refused.text
        );
        assert_eq!(
            store
                .read_with(|conn| conn
                    .query_row("SELECT COUNT(*) FROM moments", [], |r| r.get::<_, i64>(0)))
                .unwrap(),
            3
        );
        refused.text = "Repaired.\n".into();
        std::fs::write(scratch.path().join("held.md"), &refused.text).unwrap();
        assert_eq!(
            offer(&mut store, &refused).unwrap().snapshot.text,
            refused.text
        );
        assert_unheld(&store);
        // Superseded Undo jobs no longer reserve the repaired path.
        refused.text = "Continued.\n".into();
        assert_eq!(
            offer(&mut store, &refused).unwrap().snapshot.text,
            refused.text
        );
    }

    struct Root;
    impl WorkspaceRootGuard for Root {
        fn validate(&self, _: &std::path::Path) -> Result<(), RuntimeError> {
            Ok(())
        }
    }

    #[test]
    fn capture_file_hold_batch_savepoint_commits_both_siblings() {
        let (scratch, mut store, refused) = seeded();
        let inputs = [
            input("first.txt", "First.\n"),
            refused,
            input("last.txt", "Last.\n"),
        ];
        let policy = Arc::new(crate::search::read_engine_search_policy(scratch.path()));
        let results = capture_ingest_batch_on_store(
            &mut store,
            &inputs,
            &policy,
            &LeaseRegistry::new(),
            &NoFaults,
            &CancellationToken::new(),
            (scratch.path(), &Root),
        )
        .unwrap();
        assert!(results[0].is_ok());
        assert_eq!(results[1].as_ref().unwrap_err().code(), "capture-file-held");
        assert!(results[2].is_ok());
        assert_eq!(
            results[2].as_ref().unwrap().moment.moment_order,
            results[0].as_ref().unwrap().moment.moment_order + 1
        );
        let holds: i64 = store
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM capture_file_holds", [], |r| r.get(0))
            })
            .unwrap();
        assert_eq!(holds, 1);
    }

    #[test]
    fn capture_file_hold_changed_bytes_remain_pinned_to_the_source_version() {
        let (_scratch, mut store, refused) = seeded();
        assert_eq!(
            offer(&mut store, &refused).unwrap_err().code(),
            "capture-file-held"
        );
        store.write_with(&NoFaults, |tx| tx.execute(
            "INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES ('hold-proof','later','named','Later',4)",
            []).map_err(StorageError::persist_public)).unwrap();
        let mut changed = input("held.md", "Representable.\n");
        changed.version_id = "later".into();
        let recovered = offer(&mut store, &changed).unwrap();
        assert_eq!(recovered.snapshot.version_id, "main");
        assert!(
            VersionedTextStore::new(&mut store)
                .read_text("hold-proof", "later", "held.md")
                .unwrap()
                .is_none()
        );
        let holds: i64 = store
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM capture_file_holds", [], |r| r.get(0))
            })
            .unwrap();
        assert_eq!(holds, 0);
    }
}

/// Maximum work accepted by one capture batch actor command. Keeping both
/// bounds here lets the actor serve queued interactive work between chunks.
pub const MAX_CAPTURE_INGEST_BATCH_OPS: usize = 256;
pub const MAX_CAPTURE_INGEST_BATCH_BYTES: usize = 4 * 1024 * 1024;

/// Capture-owned proof that a filesystem pathname still names the workspace
/// root selected before an actor command entered the queue.
pub trait WorkspaceRootGuard: Send + Sync {
    fn validate(&self, root_dir: &std::path::Path) -> Result<(), RuntimeError>;
}

pub(super) fn validate_workspace_root(
    root_dir: &std::path::Path,
    root_guard: Option<&dyn WorkspaceRootGuard>,
) -> Result<(), RuntimeError> {
    if let Some(root_guard) = root_guard {
        root_guard.validate(root_dir)?;
    }
    Ok(())
}

enum CaptureIndexing {
    Skip,
    ReadRoot(PathBuf),
    UseSnapshot(Arc<SearchPolicySnapshot>),
    Reader {
        indexing: Box<CaptureIndexing>,
        root: PathBuf,
        folds: Arc<Vec<dohc_engine_collab::reader_resolver::PreparedFold>>,
    },
}

impl CaptureIndexing {
    fn base(&self) -> &Self {
        match self {
            Self::Reader { indexing, .. } => indexing.base(),
            other => other,
        }
    }
}

pub struct CapturePlacementPath {
    pub path: String,
    pub released_hold: bool,
}

pub struct CapturePassSettlement {
    pub paths: Vec<CapturePlacementPath>,
    pub repair_recoveries: bool,
}

/// Matches job targets that name `path` on a disk that ignores case or
/// Unicode normalization, as capture holds match them.
fn names_path(path: &str) -> impl Fn(&str) -> bool {
    let path = path_collision_key(path);
    move |target| path_collision_key(target) == path
}

fn select_released_switch_jobs(
    conn: &Connection,
    workspace_id: &str,
    paths: &[CapturePlacementPath],
    selected: &mut std::collections::HashSet<String>,
) -> Result<(), RuntimeError> {
    let released: Vec<String> = paths
        .iter()
        .filter(|path| path.released_hold)
        .map(|path| path_collision_key(&path.path))
        .collect();
    for (id, target) in dohc_engine_storage::pending_switch_jobs_in(conn, workspace_id)? {
        let target = path_collision_key(&target);
        if released.iter().any(|path| {
            target == *path
                || target
                    .strip_prefix(path)
                    .is_some_and(|rest| rest.starts_with('/'))
        }) {
            selected.insert(id);
        }
    }
    Ok(())
}

impl ActorHandle {
    #[cfg(feature = "fault-injection")]
    pub async fn capture_phase_totals_for_harness(
        &self,
    ) -> Result<dohc_engine_storage::capture_phase::Snapshot, RuntimeError> {
        self.run(|_, _| Ok(dohc_engine_storage::capture_phase::snapshot()))
            .await
    }

    pub async fn capture_notices(
        &self,
        workspace_id: String,
    ) -> Result<
        (
            Vec<dohc_engine_domain::CaptureRecovery>,
            Vec<CaptureFileHold>,
        ),
        RuntimeError,
    > {
        self.run(move |store, _| {
            store.read_with(|conn| {
                Ok((
                    dohc_engine_domain::capture_recoveries_in(conn, &workspace_id)?,
                    capture_file_holds::list_in(conn, &workspace_id)?,
                ))
            })
        })
        .await
    }

    /// Drain intents for settled observations after their capture commit.
    /// A completed capture generation supersedes an older parked placement.
    pub async fn finish_capture_pass(
        &self,
        workspace_id: String,
        root_dir: PathBuf,
        settlement: CapturePassSettlement,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
        root_guard: Arc<dyn WorkspaceRootGuard>,
    ) -> Result<Vec<dohc_engine_sync::YdocRecoveryMaterialization>, RuntimeError> {
        self.run(move |store, cache| {
            let selected = if settlement.paths.is_empty() {
                std::collections::HashSet::new()
            } else {
                store.read_with(|conn| {
                    let mut query = conn.prepare_cached(
                        "SELECT job_id FROM materialization_jobs WHERE workspace_id IN (?1,'') AND target_path=?2 AND status='pending'"
                    ).map_err(StorageError::corrupt_public)?;
                    let mut selected = std::collections::HashSet::new();
                    let mut released = false;
                    for path in &settlement.paths {
                        released |= path.released_hold;
                        let jobs = query.query_map(params![workspace_id, path.path], |row| row.get::<_, String>(0))
                            .map_err(StorageError::corrupt_public)?;
                        for job in jobs { selected.insert(job.map_err(StorageError::corrupt_public)?); }
                    }
                    if released {
                        select_released_switch_jobs(conn, &workspace_id, &settlement.paths, &mut selected)?;
                    }
                    Ok::<_, RuntimeError>(selected)
                })?
            };
            if !selected.is_empty() {
                let released_hold_paths = settlement
                    .paths
                    .iter()
                    .filter(|path| path.released_hold)
                    .map(|path| path_collision_key(&path.path))
                    .collect();
                root_guard.validate(&root_dir)?;
                let replay = super::materialization::replay_pending_materializations(
                    store,
                    &root_dir,
                    super::materialization::MaterializationReplayScope {
                        holds: None,
                        workspace_id: &workspace_id,
                        self_writes: Some(self_writes.as_ref()),
                        progress: None,
                        file_outcomes_settled: true,
                        released_hold_paths: Some(&released_hold_paths),
                        planned_against_active_heads: false,
                    },
                    now_ms,
                    &dohc_engine_storage::NoFaults,
                    Some(&selected),
                    true,
                );
                cache.clear();
                let summary = replay?;
                if summary.failed > 0 {
                    return Err(RuntimeError::ActiveVersionMaterializationIncomplete {
                        failed_jobs: summary.failed,
                    });
                }
            }
            if !settlement.repair_recoveries {
                return Ok(Vec::new());
            }
            let outcome = dohc_engine_sync::repair_conflicted_ydoc_recoveries(
                store,
                &workspace_id,
                &dohc_engine_storage::NoFaults,
            )
            .map_err(RuntimeError::from);
            if !matches!(&outcome, Ok(recoveries) if recoveries.is_empty()) {
                cache.clear();
            }
            outcome
        })
        .await
    }

    pub async fn capture_file_holds(
        &self,
        workspace_id: String,
    ) -> Result<Vec<CaptureFileHold>, RuntimeError> {
        self.run(move |store, _| {
            Ok(store.read_with(|conn| capture_file_holds::list_in(conn, &workspace_id))?)
        })
        .await
    }

    pub async fn retry_capture_file(
        &self,
        workspace_id: String,
        path: String,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _| {
            match store.write_with(&dohc_engine_storage::NoFaults, |tx| {
                capture_file_holds::request_retry_in(tx, &workspace_id, &path)
            })? {
                TxnOutcome::Committed(retried) => Ok(retried),
                TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
            }
        })
        .await
    }
    pub async fn capture_recoveries(
        &self,
        workspace_id: String,
    ) -> Result<Vec<dohc_engine_domain::CaptureRecovery>, RuntimeError> {
        self.run(move |store, _| {
            store
                .read_with(|conn| dohc_engine_domain::capture_recoveries_in(conn, &workspace_id))
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn clear_capture_recovery(
        &self,
        workspace_id: String,
        moment_id: String,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            match store.write_with(&dohc_engine_storage::NoFaults, |tx| {
                dohc_engine_domain::clear_capture_recovery_in(tx, &workspace_id, &moment_id)
            })? {
                TxnOutcome::Committed(()) => Ok(()),
                TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
            }
        })
        .await
    }
    // --- Synchronous API (must be used outside a runtime) ---

    /// Capture and index text against one reconcile-owned policy snapshot.
    pub fn capture_ingest_with_search_policy_blocking(
        &self,
        input: CaptureIngest,
        root_dir: PathBuf,
        search_policy: Arc<SearchPolicySnapshot>,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<WriteResult, RuntimeError> {
        let token: CancellationToken = CancellationToken::new();
        let mut reader_deadline = None;
        for attempt in 0..=2 {
            let folds = if attempt < 2 {
                reader::prepare_blocking(
                    self,
                    Arc::from([input.clone()]),
                    &root_dir,
                    &mut reader_deadline,
                )
            } else {
                Arc::new(Vec::new())
            };
            let indexing = reader::indexing(
                CaptureIndexing::UseSnapshot(search_policy.clone()),
                root_dir.clone(),
                folds,
            );
            let (input, leases, faults, token) =
                (input.clone(), leases.clone(), faults.clone(), token.clone());
            let result = self.run_blocking(move |store, cache| {
                with_local_file_mutation_cache_reset(cache, || {
                    capture_ingest_on_store(
                        store,
                        &input,
                        &indexing,
                        &leases,
                        faults.as_ref(),
                        &token,
                    )
                })
            });
            if !reader::is_stale(&result) {
                return result;
            }
        }
        unreachable!()
    }

    /// Capture a bounded text chunk in one durable transaction. A clean chunk
    /// shares one rollback scope. If an item fails, the chunk is replayed with
    /// per-item savepoints so successful siblings still commit.
    pub fn capture_ingest_batch_blocking(
        &self,
        inputs: impl Into<Arc<[CaptureIngest]>>,
        search_policy: Arc<SearchPolicySnapshot>,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        root_dir: PathBuf,
        root_guard: Arc<dyn WorkspaceRootGuard>,
    ) -> Result<Vec<Result<WriteResult, RuntimeError>>, RuntimeError> {
        let mut inputs = inputs.into();
        #[cfg(feature = "fault-injection")]
        let mut roundtrip = dohc_engine_storage::capture_phase::Phase::new(
            "queued_capture_batch",
            inputs
                .first()
                .and_then(|i| i.metadata_correlation_id.as_deref()),
            inputs.len(),
            false,
        );
        let token: CancellationToken = CancellationToken::new();
        let mut result = Err(RuntimeError::ActorUnavailable);
        let mut completed: Vec<_> = inputs.iter().map(|_| None).collect();
        let mut indices: Vec<_> = (0..inputs.len()).collect();
        let mut reader_deadline = None;
        for attempt in 0..=2 {
            let folds = if attempt < 2 {
                reader::prepare_blocking(self, inputs.clone(), &root_dir, &mut reader_deadline)
            } else {
                Arc::new(Vec::new())
            };
            let (batch_inputs, search_policy, leases, faults, token, root_dir, root_guard) = (
                inputs.clone(),
                search_policy.clone(),
                leases.clone(),
                faults.clone(),
                token.clone(),
                root_dir.clone(),
                root_guard.clone(),
            );
            result = self.run_blocking(move |store, cache| {
                with_local_file_mutation_cache_reset(cache, || {
                    capture_ingest_batch_with_reader_on_store(
                        store,
                        &batch_inputs,
                        &search_policy,
                        &leases,
                        faults.as_ref(),
                        &token,
                        (&root_dir, root_guard.as_ref()),
                        folds,
                    )
                })
            });
            if result.is_err() && completed.iter().any(Option::is_some) {
                let error = Arc::new(result.unwrap_err());
                result = Ok(indices
                    .iter()
                    .map(|_| Err(RuntimeError::CaptureBatchPass(error.clone())))
                    .collect());
            }
            let Ok(items) = &mut result else {
                break;
            };
            let mut retry_inputs = Vec::new();
            let mut retry_indices = Vec::new();
            for ((index, input), item) in indices
                .into_iter()
                .zip(inputs.iter())
                .zip(std::mem::take(items))
            {
                if attempt < 2 && reader::is_stale(&item) {
                    retry_inputs.push(input.clone());
                    retry_indices.push(index);
                } else {
                    completed[index] = Some(item);
                }
            }
            if retry_inputs.is_empty() {
                result = Ok(completed
                    .into_iter()
                    .map(|item| item.expect("every capture item finished"))
                    .collect());
                break;
            }
            inputs = retry_inputs.into();
            indices = retry_indices;
        }
        #[cfg(feature = "fault-injection")]
        roundtrip.finish(if result.is_ok() { "returned" } else { "error" });
        result
    }

    /// Capture a binary file on the actor's writer, blocking the caller.
    pub fn capture_ingest_binary_blocking(
        &self,
        input: Arc<CaptureIngestBinary>,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<CaptureIngestBinaryResult, RuntimeError> {
        let token: CancellationToken = CancellationToken::new();
        self.run_blocking(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                capture_ingest_binary_on_store(store, &input, &leases, faults.as_ref(), &token)
            })
        })
    }

    /// Capture a secret file on the actor's writer, blocking the caller. The
    /// workspace data key travels with the request (the actor holds no key
    /// state; custody stays at the composition layer).
    pub fn capture_secret_blocking(
        &self,
        input: CaptureSecret,
        key: SecretDataKey,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<SecretWriteResult, RuntimeError> {
        let token: CancellationToken = CancellationToken::new();
        self.run_blocking(move |store, _cache| {
            capture_secret_on_store(store, &input, &key, faults.as_ref(), &token)
        })
    }

    /// Retire a captured secret path on the actor's writer, blocking the
    /// caller. Keyless: a delete never decrypts.
    pub fn capture_secret_retire_blocking_guarded(
        &self,
        input: CaptureSecretRetire,
        root_dir: PathBuf,
        faults: Arc<dyn FaultInjector>,
        root_guard: Arc<dyn WorkspaceRootGuard>,
    ) -> Result<Option<SecretMomentRecord>, RuntimeError> {
        self.run_blocking(move |store, _cache| {
            capture_secret_retire_on_store(
                store,
                &input,
                &root_dir,
                root_guard.as_ref(),
                faults.as_ref(),
            )
        })
    }

    /// Retire a captured path and immediately apply any durable disk cleanup
    /// that the mutation creates.
    ///
    /// `confirm_absent` marks a retire whose reason is that the file is gone
    /// from disk. The observation was made off the actor, where a replace
    /// that has moved the target aside and not yet put the new file in place
    /// looks exactly like a delete. The actor checks again on its own thread,
    /// where materialization also runs, and refuses with a retryable error
    /// while anything is at the path or an unfinished replace names it.
    #[allow(
        clippy::too_many_arguments,
        reason = "each seam is injected for testability"
    )]
    pub fn capture_retire_materialized_blocking_guarded(
        &self,
        input: CaptureRetire,
        root_dir: PathBuf,
        confirm_absent: bool,
        self_writes: Arc<dyn SelfWriteRecorder>,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        root_guard: Arc<dyn WorkspaceRootGuard>,
    ) -> Result<CaptureRetireResult, RuntimeError> {
        self.run_blocking(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                capture_retire_on_store(
                    store,
                    &input,
                    None,
                    &root_dir,
                    root_guard.as_ref(),
                    confirm_absent,
                    self_writes.as_ref(),
                    &leases,
                    faults.as_ref(),
                )
            })
        })
    }

    /// Retire `input.path`, whose file the disk shows stored under `to`, another
    /// spelling of it, with the bytes `to_sha256`. See
    /// [`dohc_engine_domain::capture_retire_respelled_in_tx`].
    #[allow(clippy::too_many_arguments)]
    pub fn capture_retire_respelled_blocking_guarded(
        &self,
        input: CaptureRetire,
        to: String,
        to_sha256: String,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        root_guard: Arc<dyn WorkspaceRootGuard>,
    ) -> Result<CaptureRetireResult, RuntimeError> {
        self.run_blocking(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                capture_retire_on_store(
                    store,
                    &input,
                    Some((&to, &to_sha256)),
                    &root_dir,
                    root_guard.as_ref(),
                    false,
                    self_writes.as_ref(),
                    &leases,
                    faults.as_ref(),
                )
            })
        })
    }

    /// Capture a text file on the actor's single writer thread.
    pub async fn capture_ingest(
        &self,
        input: CaptureIngest,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        self.capture_ingest_with_root(input, None, leases, faults, token)
            .await
    }

    /// Capture and index a text file when the owning workspace session can
    /// supply its authoritative root.
    pub async fn capture_ingest_indexed(
        &self,
        input: CaptureIngest,
        root_dir: PathBuf,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        self.capture_ingest_with_root(input, Some(root_dir), leases, faults, token)
            .await
    }

    async fn capture_ingest_with_root(
        &self,
        input: CaptureIngest,
        root_dir: Option<PathBuf>,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        let mut reader_deadline = None;
        for attempt in 0..=2 {
            let folds = if attempt < 2
                && let Some(root) = root_dir.as_ref()
            {
                reader::prepare(self, Arc::from([input.clone()]), root, &mut reader_deadline).await
            } else {
                Arc::new(Vec::new())
            };
            let base = root_dir
                .clone()
                .map_or(CaptureIndexing::Skip, CaptureIndexing::ReadRoot);
            let indexing = reader::indexing(base, root_dir.clone().unwrap_or_default(), folds);
            let (input, leases, faults, token) =
                (input.clone(), leases.clone(), faults.clone(), token.clone());
            let result = self
                .run(move |store, cache| {
                    with_local_file_mutation_cache_reset(cache, || {
                        capture_ingest_on_store(
                            store,
                            &input,
                            &indexing,
                            &leases,
                            faults.as_ref(),
                            &token,
                        )
                    })
                })
                .await;
            if !reader::is_stale(&result) {
                return result;
            }
        }
        unreachable!()
    }

    /// Capture a binary file on the actor's single writer thread.
    pub async fn capture_ingest_binary(
        &self,
        input: CaptureIngestBinary,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<CaptureIngestBinaryResult, RuntimeError> {
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                capture_ingest_binary_on_store(store, &input, &leases, faults.as_ref(), &token)
            })
        })
        .await
    }

    /// Every captured path with its content identity, for seeding a fresh
    /// files-layer manifest on workspace (re)open (deleted-while-closed
    /// files must retire against the seed, never survive an empty baseline).
    pub async fn capture_manifest_seed(
        &self,
        workspace_id: String,
        version_id: String,
    ) -> Result<Vec<CaptureManifestSeedEntry>, RuntimeError> {
        self.run(move |store, _| {
            let mut entries = capture_manifest_seed(store, &workspace_id, &version_id)?;
            let holds = store.read_with(|conn| capture_file_holds::list_in(conn, &workspace_id))?;
            let held_paths = dohc_engine_files::PlacementHolds::from_holds(&workspace_id, &holds);
            entries.retain(|entry| !held_paths.blocks(&entry.path));
            for hold in holds {
                entries.push(CaptureManifestSeedEntry {
                    path: hold.path,
                    size: hold.observed_size,
                    sha256: if hold.retry_requested {
                        "held-retry".to_owned()
                    } else {
                        hold.observed_sha256
                    },
                });
            }
            Ok(entries)
        })
        .await
    }

    /// Capture a secret file on the actor's single writer thread.
    pub async fn capture_secret(
        &self,
        input: CaptureSecret,
        key: SecretDataKey,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<SecretWriteResult, RuntimeError> {
        self.run(move |store, _cache| {
            capture_secret_on_store(store, &input, &key, faults.as_ref(), &token)
        })
        .await
    }
}

fn capture_ingest_on_store(
    store: &mut EngineStore,
    input: &CaptureIngest,
    indexing: &CaptureIndexing,
    leases: &LeaseRegistry,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<WriteResult, RuntimeError> {
    #[cfg(feature = "fault-injection")]
    let mut phase = dohc_engine_storage::capture_phase::Phase::new(
        "actor_capture_text",
        input.metadata_correlation_id.as_deref(),
        1,
        true,
    );
    #[cfg(feature = "fault-injection")]
    phase.finish("attempted");
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let outcome = match store.write_with(faults, |tx| {
        capture_ingest_in_tx(tx, input, indexing, leases, None)
    }) {
        Err(error) if unrepresentable(&error) => {
            match store.write_with(faults, |tx| record_capture_file_hold_in(tx, input))? {
                TxnOutcome::Committed(()) => {
                    return Err(RuntimeError::CaptureFileHeld {
                        path: input.path.clone(),
                    });
                }
                TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
            }
        }
        Err(error @ RuntimeError::Domain(DomainError::CaptureNotOwned)) => {
            if clear_unowned_capture_hold(store, &input.workspace_id, &input.path, faults)? {
                return Err(RuntimeError::CaptureNotOwnedAfterHold {
                    path: input.path.clone(),
                });
            }
            return Err(error);
        }
        result => result?,
    };
    match outcome {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn pending_placement_in(
    tx: &Transaction<'_>,
    workspace_id: &str,
    path: &str,
    held: bool,
) -> Result<bool, RuntimeError> {
    if held {
        return Ok(true);
    }
    tx.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM materialization_jobs \
         WHERE workspace_id IN (?1,'') AND target_path=?2 AND status='pending')",
    )
    .map_err(StorageError::corrupt_public)?
    .query_row(params![workspace_id, path], |row| row.get(0))
    .map_err(StorageError::corrupt_public)
    .map_err(RuntimeError::from)
}

fn clear_unowned_capture_hold(
    store: &mut EngineStore,
    workspace_id: &str,
    path: &str,
    faults: &dyn FaultInjector,
) -> Result<bool, RuntimeError> {
    if store
        .read_with(|conn| capture_file_holds::hold_in(conn, workspace_id, path))?
        .is_none()
    {
        return Ok(false);
    }
    match store.write_with(faults, |tx| {
        capture_file_holds::clear_in(tx, workspace_id, path)
    })? {
        TxnOutcome::Committed(()) => Ok(true),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn unrepresentable(error: &RuntimeError) -> bool {
    matches!(error, RuntimeError::Sync(dohc_engine_sync::SyncError::InvalidInput { reason }) if *reason == capture_file_holds::NOT_REPRESENTABLE)
}

fn record_capture_file_hold_in(
    tx: &Transaction<'_>,
    input: &CaptureIngest,
) -> Result<(), RuntimeError> {
    let existing = capture_file_holds::pin_in(tx, &input.workspace_id, &input.path)?;
    let version = existing.as_ref().map_or(input.version_id.as_str(), |hold| {
        hold.source_version_id.as_str()
    });
    let object_id = dohc_engine_domain::ensure_capture_object_in_tx(
        tx,
        &input.workspace_id,
        version,
        &input.path,
        input.now_ms,
    )?;
    capture_file_holds::record_in(
        tx,
        &CaptureFileHold {
            workspace_id: input.workspace_id.clone(),
            source_version_id: version.to_owned(),
            object_id,
            path: input.path.clone(),
            observed_sha256: dohc_engine_storage::hex_sha256(input.text.as_bytes()),
            observed_size: input.text.len() as u64,
            reason: capture_file_holds::NOT_REPRESENTABLE.to_owned(),
            observed_at_ms: input.now_ms,
            attempt_count: 1,
            retry_requested: false,
        },
    )?;
    Ok(())
}

/// A held observation can only recover the object and version that refused it.
fn pinned_capture_input<'a>(
    tx: &Transaction<'_>,
    input: &'a CaptureIngest,
) -> Result<(std::borrow::Cow<'a, CaptureIngest>, bool), RuntimeError> {
    let Some(hold) = capture_file_holds::pin_in(tx, &input.workspace_id, &input.path)? else {
        return Ok((std::borrow::Cow::Borrowed(input), false));
    };
    if !hold.retry_requested
        && hold.observed_sha256 == dohc_engine_storage::hex_sha256(input.text.as_bytes())
    {
        return Err(RuntimeError::CaptureFileHeld {
            path: input.path.clone(),
        });
    }
    let mut pinned = input.clone();
    pinned.version_id = hold.source_version_id;
    Ok((std::borrow::Cow::Owned(pinned), true))
}

struct CaptureBatchSharedContext {
    capture: CaptureIngestBatchContext,
    has_ydoc_state: Option<bool>,
    journals_file_moments: Option<bool>,
    /// The item just ingested recovered a sibling file, whose moment took
    /// the order after the item's own.
    recovered_sibling: bool,
}

impl CaptureBatchSharedContext {
    fn new(tx: &Transaction<'_>, first: &CaptureIngest) -> Result<Self, RuntimeError> {
        Ok(Self {
            capture: CaptureIngestBatchContext::new(tx, &first.workspace_id, &first.version_id)?,
            has_ydoc_state: None,
            journals_file_moments: None,
            recovered_sibling: false,
        })
    }

    /// After an item that recovered a sibling, the batch's reserved moment
    /// order is behind the table. Read the high-water mark again before the
    /// next item, so it does not propose the order the sibling took. An item
    /// rolled back took its sibling with it; reading again then costs one
    /// query and changes nothing.
    fn settle_item(
        &mut self,
        tx: &Transaction<'_>,
        first: &CaptureIngest,
    ) -> Result<(), RuntimeError> {
        if std::mem::take(&mut self.recovered_sibling) {
            self.capture =
                CaptureIngestBatchContext::new(tx, &first.workspace_id, &first.version_id)?;
        }
        Ok(())
    }
}

struct PreparedCaptureRecovery {
    /// The admitted object the lineage was read for. Capture may resolve the
    /// path to a different, disambiguated object.
    object_id: String,
    lineage: dohc_engine_sync::PreparedLocalYdocLineage,
    preserve: bool,
    authors: Option<String>,
}

fn prepare_capture_recovery_in(
    tx: &Transaction<'_>,
    input: &CaptureIngest,
    object_id: &str,
    indexing: &CaptureIndexing,
) -> Result<PreparedCaptureRecovery, RuntimeError> {
    let key = DocKey::new(&input.workspace_id, &input.version_id, object_id)?;
    let mut prepared = PreparedCaptureRecovery {
        object_id: object_id.to_owned(),
        lineage: dohc_engine_sync::prepare_local_ydoc_lineage_in_tx(tx, &key)?,
        preserve: false,
        authors: None,
    };
    if let CaptureIndexing::Reader { folds, root, .. } = indexing
        && let Some(fold) = folds
            .iter()
            .find(|fold| fold.key == key && fold.path == input.path)
    {
        if !reader::file_matches(root, input) {
            return Err(reader::stale());
        }
        prepared
            .lineage
            .accept_outside_fold(tx, fold, &input.text)?;
    }
    let Some(projection) = prepared.lineage.projection() else {
        return Ok(prepared);
    };
    if projection.content == input.text {
        return Ok(prepared);
    }
    let sha = dohc_engine_storage::hex_sha256(projection.content.as_bytes());
    // Committed moments cover typing even when their file write is pending or
    // cancelled. Capture supersedes that write in this transaction. Only a
    // pristine seed needs the absence of a pending job to prove coverage.
    let covered: bool = tx.query_row(
        "SELECT (
          EXISTS(SELECT 1 FROM ydoc_docs d JOIN snapshots s ON s.workspace_id=d.workspace_id
            AND s.version_id=d.version_id AND s.object_id=d.object_id
            JOIN moments m ON m.workspace_id=s.workspace_id AND m.version_id=s.version_id
            AND m.object_id=s.object_id AND m.moment_id=s.latest_moment_id
            WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3
            AND d.settled_update_seq=d.head_update_seq AND m.after_blob_sha256=?5 AND s.blob_sha256=?5
            AND d.last_settled_sha=?5) OR
          EXISTS(SELECT 1 FROM live_device_settlements a JOIN moments m
            ON m.workspace_id=a.workspace_id AND m.moment_id=a.moment_id
            JOIN ydoc_docs d ON d.workspace_id=a.workspace_id AND d.version_id=a.main_version_id AND d.object_id=a.object_id
            WHERE a.workspace_id=?1 AND a.main_version_id=?2 AND a.object_id=?3
            AND a.lineage_claim_id=d.lineage_claim_id AND a.source_state_vector_digest=?6
            AND a.markdown_digest=?5 AND m.after_blob_sha256=?5) OR
          (NOT EXISTS(SELECT 1 FROM materialization_jobs WHERE workspace_id IN (?1,'') AND target_path=?4 AND status='pending') AND
          EXISTS(SELECT 1 FROM ydoc_docs d WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3
            AND d.last_settled_sha IS NULL AND d.head_update_seq=1 AND d.head_snapshot_seq IN (0,1)
            AND (SELECT COUNT(*) FROM ydoc_updates u WHERE u.workspace_id=?1 AND u.version_id=?2 AND u.object_id=?3)=1-d.head_snapshot_seq
            AND EXISTS(SELECT 1 FROM ydoc_snapshots s WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.up_to_seq=d.head_snapshot_seq)
            AND NOT EXISTS(SELECT 1 FROM ydoc_snapshots s WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.up_to_seq NOT IN (0,1))
            AND EXISTS(SELECT 1 FROM moments m WHERE m.workspace_id=?1 AND m.version_id=?2 AND m.object_id=?3 AND m.after_blob_sha256=d.seed_source_sha256))))",
        params![input.workspace_id,input.version_id,object_id,input.path,sha,projection.source_state_vector_sha256], |row| row.get(0),
    ).map_err(StorageError::corrupt_public)?;
    if covered {
        return Ok(prepared);
    }
    prepared.authors = dohc_engine_collab::author_coverage::recovery_in(tx, &key)?.moment_json();
    prepared.preserve = true;
    Ok(prepared)
}

fn capture_ingest_in_tx(
    tx: &Transaction<'_>,
    input: &CaptureIngest,
    indexing: &CaptureIndexing,
    leases: &LeaseRegistry,
    mut batch: Option<&mut CaptureBatchSharedContext>,
) -> Result<WriteResult, RuntimeError> {
    let (pinned, held) = pinned_capture_input(tx, input)?;
    let input = pinned.as_ref();
    let placement_admission = if held {
        Ok(())
    } else {
        match ensure_no_pending_undo_placement(tx, &input.workspace_id, &input.path) {
            Err(error)
                if input.claim_foreign_head
                    && matches!(
                        &error,
                        RuntimeError::Sync(dohc_engine_sync::SyncError::RetryableState {
                            reason: "history-undo-placement-pending"
                        })
                    ) =>
            {
                Err(error)
            }
            result => {
                result?;
                Ok(())
            }
        }
    };
    if held {
        if let Some(shared) = batch.as_deref_mut() {
            shared.recovered_sibling = true;
        }
        batch = None;
    }
    let (actor_origin_id, attribution) =
        dohc_engine_domain::moment_author_attribution(input.author_json.as_deref());
    let mut admitted = false;
    let mut recovery = None;
    let may_have_ydoc_state = batch
        .as_ref()
        .is_none_or(|batch| batch.has_ydoc_state != Some(false));
    #[cfg(feature = "fault-injection")]
    let domain_phase =
        dohc_engine_storage::capture_phase::Measure::new("domain_and_lease_recovery");
    let mut result = match batch.as_deref_mut() {
        Some(batch) => capture_ingest_in_batch_with_admission_in_tx(
            tx,
            input,
            &mut batch.capture,
            |workspace_id, version_id, object_id| {
                ensure_capture_target_not_leased(tx, leases, workspace_id, version_id, object_id)?;
                if may_have_ydoc_state {
                    recovery = Some(prepare_capture_recovery_in(tx, input, object_id, indexing)?);
                }
                admitted = true;
                Ok::<_, RuntimeError>(())
            },
        )?,
        None => capture_ingest_with_admission_in_tx(
            tx,
            input,
            |workspace_id, version_id, object_id| {
                ensure_capture_target_not_leased(tx, leases, workspace_id, version_id, object_id)?;
                if may_have_ydoc_state {
                    recovery = Some(prepare_capture_recovery_in(tx, input, object_id, indexing)?);
                }
                admitted = true;
                Ok::<_, RuntimeError>(())
            },
        )?,
    };
    #[cfg(feature = "fault-injection")]
    drop(domain_phase);
    if let Some(batch) = batch.as_deref_mut() {
        batch.capture.commit_result(&result)?;
    }
    // A lineage read for an object the path no longer resolves to belongs to
    // another file.
    let recovery = recovery.filter(|prepared| prepared.object_id == result.snapshot.object_id);
    if let Some(prepared) = recovery.as_ref().filter(|prepared| prepared.preserve) {
        let projection = prepared
            .lineage
            .projection()
            .expect("recovery has a projection");
        if let Some(order) = dohc_engine_domain::record_capture_recovery_in_tx(
            tx,
            &input.workspace_id,
            &result.snapshot,
            &projection.content,
            &projection.source_state_vector_sha256,
            prepared.authors.as_deref(),
            input.now_ms,
        )? {
            if let Some(batch) = batch.as_deref_mut() {
                batch.capture.commit_recovery_order(order)?;
            }
        }
    }
    if admitted {
        #[cfg(feature = "fault-injection")]
        let _collection_phase =
            dohc_engine_storage::capture_phase::Measure::new("collection_and_lineage");
        let has_ydoc_state = match batch.as_deref_mut() {
            Some(batch) => match batch.has_ydoc_state {
                Some(has_ydoc_state) => has_ydoc_state,
                None => {
                    let has_ydoc_state = dohc_engine_sync::workspace_has_ydoc_state_in_tx(
                        tx,
                        &input.workspace_id,
                        &input.version_id,
                    )?;
                    batch.has_ydoc_state = Some(has_ydoc_state);
                    has_ydoc_state
                }
            },
            None => true,
        };
        let changed = if has_ydoc_state {
            let resulting = dohc_engine_sync::ResultingHead::Text {
                path: &result.snapshot.path,
                text: &result.snapshot.text,
            };
            let reconciled = match recovery {
                Some(prepared) => dohc_engine_sync::reconcile_prepared_local_head_in_tx(
                    tx,
                    prepared.lineage,
                    resulting,
                    actor_origin_id.as_deref(),
                    attribution.as_ref(),
                    input.now_ms,
                )?,
                // Capture resolved the path to a new object, not the one admitted.
                None => dohc_engine_sync::reconcile_local_head_in_tx(
                    tx,
                    &input.workspace_id,
                    &input.version_id,
                    &result.snapshot.object_id,
                    resulting,
                    actor_origin_id.as_deref(),
                    attribution.as_ref(),
                    input.now_ms,
                )?,
            };
            if let Some(batch) = batch.as_deref_mut() {
                batch.recovered_sibling = reconciled.recovered_sibling;
            }
            reconciled.facts
        } else {
            // No Y.Doc lineage exists in this version, so the file alone
            // carries the write.
            dohc_engine_domain::index_collection_record_text_in_tx(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.snapshot.object_id,
                &result.snapshot.path,
                &result.snapshot.text,
                actor_origin_id.as_deref(),
                attribution.as_ref(),
                input.now_ms,
            )?
        };
        // A disk edit captured here is a change on this computer: claim the
        // automations it triggers in the capture's own transaction.
        if let Some(facts) = changed {
            result.automation_claims = dohc_engine_domain::claim_automation_triggers_in_tx(
                tx,
                &input.workspace_id,
                &facts,
                input.now_ms,
            )?;
        }
    }
    if !result.deduped {
        #[cfg(feature = "fault-injection")]
        let _search_phase = dohc_engine_storage::capture_phase::Measure::new("search");
        match indexing.base() {
            CaptureIndexing::Reader { .. } => unreachable!(),
            CaptureIndexing::Skip => {}
            CaptureIndexing::ReadRoot(root_dir) => upsert_file_search_index(
                tx,
                root_dir,
                &input.workspace_id,
                &input.version_id,
                &result.snapshot.object_id,
                &result.snapshot.path,
                &result.snapshot.text,
            )
            .map_err(RuntimeError::from)?,
            CaptureIndexing::UseSnapshot(policy) => update_file_search_index_for_capture(
                tx,
                policy,
                &input.workspace_id,
                &input.version_id,
                &result.snapshot.object_id,
                &result.snapshot.path,
                &result.snapshot.text,
                result.moment.before_present,
            )
            .map_err(RuntimeError::from)?,
        }
    }
    #[cfg(feature = "fault-injection")]
    let journal_phase = dohc_engine_storage::capture_phase::Measure::new("outbound_journal");
    match batch {
        Some(batch) => journal_moment_outbound_with_batch_in_tx(
            tx,
            &input.workspace_id,
            &result.moment.moment_id,
            result.deduped,
            &mut batch.journals_file_moments,
        ),
        None => journal_moment_outbound_in_tx(
            tx,
            &input.workspace_id,
            &result.moment.moment_id,
            result.deduped,
        ),
    }
    .map_err(RuntimeError::from)?;
    #[cfg(feature = "fault-injection")]
    drop(journal_phase);
    // An alias change may have released the hold before this observation.
    // Mark these captured bytes before replay can revive an older intent.
    let pending_placement = pending_placement_in(tx, &input.workspace_id, &input.path, held)?;
    if pending_placement {
        dohc_engine_storage::record_completed_job(
            tx,
            &dohc_engine_storage::MaterializationJobSpec {
                job_id: format!("capture-mat_{}", result.moment.moment_id),
                workspace_id: input.workspace_id.clone(),
                target_path: input.path.clone(),
                content_sha256: result.snapshot.blob_sha256.clone(),
                preimage: dohc_engine_storage::Preimage::Present(
                    result.snapshot.blob_sha256.clone(),
                ),
                target_generation: result.moment.moment_order,
                now_ms: input.now_ms,
            },
        )?;
    }
    if held {
        capture_file_holds::rebase_switch_jobs_in(
            tx,
            &input.workspace_id,
            names_path(&input.path),
            &dohc_engine_storage::Preimage::Present(result.snapshot.blob_sha256.clone()),
        )?;
        capture_file_holds::clear_in(tx, &input.workspace_id, &input.path)?;
    }
    result.pending_placement = pending_placement;
    result.released_capture_hold = held;
    // Projection refusal may establish a hold; a valid pending observation rolls back.
    placement_admission?;
    Ok(result)
}

#[cfg(test)]
fn capture_ingest_batch_on_store(
    store: &mut EngineStore,
    inputs: &[CaptureIngest],
    search_policy: &Arc<SearchPolicySnapshot>,
    leases: &LeaseRegistry,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
    workspace_root: (&std::path::Path, &dyn WorkspaceRootGuard),
) -> Result<Vec<Result<WriteResult, RuntimeError>>, RuntimeError> {
    capture_ingest_batch_with_reader_on_store(
        store,
        inputs,
        search_policy,
        leases,
        faults,
        token,
        workspace_root,
        Arc::new(Vec::new()),
    )
}

#[allow(clippy::too_many_arguments)]
fn capture_ingest_batch_with_reader_on_store(
    store: &mut EngineStore,
    inputs: &[CaptureIngest],
    search_policy: &Arc<SearchPolicySnapshot>,
    leases: &LeaseRegistry,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
    workspace_root: (&std::path::Path, &dyn WorkspaceRootGuard),
    folds: Arc<Vec<dohc_engine_collab::reader_resolver::PreparedFold>>,
) -> Result<Vec<Result<WriteResult, RuntimeError>>, RuntimeError> {
    #[cfg(feature = "fault-injection")]
    let mut phase = dohc_engine_storage::capture_phase::Phase::new(
        "actor_capture_batch",
        inputs
            .first()
            .and_then(|i| i.metadata_correlation_id.as_deref()),
        inputs.len(),
        true,
    );
    let (root_dir, root_guard) = workspace_root;
    let Some(first) = inputs.first() else {
        return Ok(Vec::new());
    };
    let total_bytes = inputs
        .iter()
        .try_fold(0usize, |total, input| total.checked_add(input.text.len()))
        .ok_or(DomainError::InvalidInput {
            reason: "capture batch byte count overflowed",
        })?;
    if inputs.len() > MAX_CAPTURE_INGEST_BATCH_OPS || total_bytes > MAX_CAPTURE_INGEST_BATCH_BYTES {
        return Err(DomainError::InvalidInput {
            reason: "capture batch exceeds actor bounds",
        }
        .into());
    }
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    if inputs.iter().any(|input| {
        input.workspace_id != first.workspace_id || input.version_id != first.version_id
    }) {
        return Err(DomainError::InvalidInput {
            reason: "capture batch coordinates do not match",
        }
        .into());
    }
    validate_workspace_root(root_dir, Some(root_guard))?;
    let bootstrap_main = {
        let versions = VersionedTextStore::new(store);
        let missing_main = versions.get_main_version(&first.workspace_id)?.is_none();
        if missing_main && first.version_id != "main" {
            return Err(DomainError::VersionNotFound.into());
        }
        missing_main
    };

    let outcome = store.write_with(faults, |tx| {
        if bootstrap_main {
            ensure_main_version_in_tx(tx, &first.workspace_id, &first.version_id, first.now_ms)?;
        }
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        validate_workspace_root(root_dir, Some(root_guard))?;
        let indexing = reader::indexing(
            CaptureIndexing::UseSnapshot(Arc::clone(search_policy)),
            root_dir.to_owned(),
            folds.clone(),
        );

        // Most startup batches are clean. Keep their database and FTS work in
        // one rollback scope instead of preparing and releasing a savepoint
        // for every file. If any item needs isolation, roll the optimistic
        // attempt back and replay through the existing partial-success path.
        // Callers therefore keep the same per-item result contract while the
        // common case pays one savepoint per batch rather than one per file.
        tx.execute_batch("SAVEPOINT dohc_capture_batch_fast")
            .map_err(StorageError::persist_public)?;
        match capture_ingest_batch_all_or_none_in_tx(tx, inputs, &indexing, leases) {
            Ok(results) => {
                tx.execute_batch("RELEASE dohc_capture_batch_fast")
                    .map_err(StorageError::persist_public)?;
                Ok(results.into_iter().map(Ok).collect())
            }
            Err(_) => {
                tx.execute_batch(
                    "ROLLBACK TO dohc_capture_batch_fast; \
                     RELEASE dohc_capture_batch_fast",
                )
                .map_err(StorageError::persist_public)?;
                capture_ingest_batch_with_item_savepoints_in_tx(tx, inputs, &indexing, leases)
            }
        }
    })?;
    match outcome {
        TxnOutcome::Committed(results) => {
            #[cfg(feature = "fault-injection")]
            {
                phase.field(
                    "failed_items",
                    results.iter().filter(|r| r.is_err()).count() as u64,
                );
                phase.finish("committed");
            }
            Ok(results)
        }
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn capture_ingest_batch_all_or_none_in_tx(
    tx: &Transaction<'_>,
    inputs: &[CaptureIngest],
    indexing: &CaptureIndexing,
    leases: &LeaseRegistry,
) -> Result<Vec<WriteResult>, RuntimeError> {
    let first = inputs.first().ok_or(DomainError::InvalidInput {
        reason: "capture batch is empty",
    })?;
    let mut results = Vec::with_capacity(inputs.len());
    let mut batch = CaptureBatchSharedContext::new(tx, first)?;
    for input in inputs {
        let result = capture_ingest_in_tx(tx, input, indexing, leases, Some(&mut batch))?;
        batch.settle_item(tx, first)?;
        results.push(result);
    }
    Ok(results)
}

fn capture_ingest_batch_with_item_savepoints_in_tx(
    tx: &Transaction<'_>,
    inputs: &[CaptureIngest],
    indexing: &CaptureIndexing,
    leases: &LeaseRegistry,
) -> Result<Vec<Result<WriteResult, RuntimeError>>, RuntimeError> {
    let first = inputs.first().ok_or(DomainError::InvalidInput {
        reason: "capture batch is empty",
    })?;
    let mut results = Vec::with_capacity(inputs.len());
    let mut batch = CaptureBatchSharedContext::new(tx, first)?;
    for input in inputs {
        let prior_capture = batch.capture.clone();
        tx.execute_batch("SAVEPOINT dohc_capture_batch_item")
            .map_err(StorageError::persist_public)?;
        match capture_ingest_in_tx(tx, input, indexing, leases, Some(&mut batch)) {
            Ok(result) => {
                tx.execute_batch("RELEASE dohc_capture_batch_item")
                    .map_err(StorageError::persist_public)?;
                results.push(Ok(result));
            }
            Err(error) => {
                tx.execute_batch(
                    "ROLLBACK TO dohc_capture_batch_item; \
                     RELEASE dohc_capture_batch_item",
                )
                .map_err(StorageError::persist_public)?;
                batch.capture = prior_capture;
                if unrepresentable(&error) {
                    record_capture_file_hold_in(tx, input)?;
                    results.push(Err(RuntimeError::CaptureFileHeld {
                        path: input.path.clone(),
                    }));
                } else {
                    if matches!(error, RuntimeError::Domain(DomainError::CaptureNotOwned))
                        && capture_file_holds::hold_in(tx, &input.workspace_id, &input.path)?
                            .is_some()
                    {
                        capture_file_holds::clear_in(tx, &input.workspace_id, &input.path)?;
                        results.push(Err(RuntimeError::CaptureNotOwnedAfterHold {
                            path: input.path.clone(),
                        }));
                        batch.settle_item(tx, first)?;
                        continue;
                    }
                    results.push(Err(error));
                }
            }
        }
        batch.settle_item(tx, first)?;
    }
    Ok(results)
}

#[cfg(test)]
mod capture_batch_fast_path_tests {
    use super::*;
    use crate::search::read_engine_search_policy;
    use dohc_engine_domain::derive_capture_object_id;
    use dohc_engine_storage::NoFaults;
    use dohc_engine_testkit::ScratchDir;
    use rusqlite::hooks::{AuthAction, Authorization, TransactionOperation};
    use std::sync::Mutex;

    struct ExistingRootGuard;

    impl WorkspaceRootGuard for ExistingRootGuard {
        fn validate(&self, root_dir: &std::path::Path) -> Result<(), RuntimeError> {
            root_dir
                .is_dir()
                .then_some(())
                .ok_or(RuntimeError::Identity {
                    reason: "test workspace root disappeared",
                    source: None,
                })
        }
    }

    #[test]
    fn clean_capture_batch_uses_one_batch_savepoint() {
        let scratch = ScratchDir::new().expect("scratch");
        let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine database path");
        let mut store = EngineStore::open(&db, 1).expect("open store");
        let begun_savepoints = Arc::new(Mutex::new(Vec::new()));
        let observed_savepoints = Arc::clone(&begun_savepoints);
        let trigger_compiles = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_compiles = Arc::clone(&trigger_compiles);
        store
            .read_with(|conn| {
                conn.authorizer(Some(move |context: rusqlite::hooks::AuthContext<'_>| {
                    if matches!(
                        context.action,
                        AuthAction::Insert {
                            table_name: "link_pending"
                        }
                    ) {
                        observed_compiles.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    if let AuthAction::Savepoint {
                        operation: TransactionOperation::Begin,
                        savepoint_name,
                    } = context.action
                    {
                        observed_savepoints
                            .lock()
                            .expect("record begun savepoint")
                            .push(savepoint_name.to_owned());
                    }
                    Authorization::Allow
                }))
            })
            .expect("install savepoint observer");
        let inputs = (0..3)
            .map(|index| CaptureIngest {
                workspace_id: "fresh-batch-workspace".to_owned(),
                version_id: "main".to_owned(),
                path: format!("note-{index}.md"),
                text: format!("body {index}"),
                metadata_origin: dohc_engine_domain::store::CAPTURE_ORIGIN.to_owned(),
                metadata_summary: Some("Reconciled offline edits".to_owned()),
                metadata_correlation_id: Some("fresh-batch".to_owned()),
                author_json: None,
                now_ms: 2,
                request_id: None,
                claim_foreign_head: false,
            })
            .collect::<Vec<_>>();
        let policy = Arc::new(read_engine_search_policy(scratch.path()));

        let results = capture_ingest_batch_on_store(
            &mut store,
            &inputs,
            &policy,
            &LeaseRegistry::new(),
            &NoFaults,
            &CancellationToken::new(),
            (scratch.path(), &ExistingRootGuard),
        )
        .expect("capture clean batch");

        assert!(results.iter().all(Result::is_ok));
        let compiles = trigger_compiles.load(std::sync::atomic::Ordering::Relaxed);
        assert!(
            compiles > 0 && compiles <= 4,
            "link queue trigger programs compiled {compiles} times for one capture batch"
        );
        assert_eq!(store.table_row_count("link_pending").unwrap(), 0);
        assert_eq!(store.table_row_count("link_aliases").unwrap(), 0);
        assert_eq!(
            *begun_savepoints.lock().expect("read begun savepoints"),
            vec!["dohc_capture_batch_fast"],
            "a clean batch must use one rollback scope instead of one per item"
        );
    }

    #[test]
    fn fallback_batch_commits_siblings_and_rolls_back_the_leased_item() {
        const WORKSPACE_ID: &str = "fallback-batch-workspace";
        const VERSION_ID: &str = "main";
        const FAILED_PATH: &str = "note-1.md";

        let scratch = ScratchDir::new().expect("scratch");
        let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine database path");
        let mut store = EngineStore::open(&db, 1).expect("open store");
        let inputs = (0..3)
            .map(|index| CaptureIngest {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: VERSION_ID.to_owned(),
                path: format!("note-{index}.md"),
                text: format!("body {index}"),
                metadata_origin: dohc_engine_domain::store::CAPTURE_ORIGIN.to_owned(),
                metadata_summary: Some("Reconciled offline edits".to_owned()),
                metadata_correlation_id: Some("fallback-batch".to_owned()),
                author_json: None,
                now_ms: 2,
                request_id: None,
                claim_foreign_head: false,
            })
            .collect::<Vec<_>>();
        let failed_object_id = derive_capture_object_id(WORKSPACE_ID, VERSION_ID, FAILED_PATH);
        let leases = LeaseRegistry::new();
        let failed_key =
            DocKey::new(WORKSPACE_ID, VERSION_ID, &failed_object_id).expect("failed item key");
        let _failed_lease = leases.acquire(&failed_key).expect("hold failed item lease");
        let policy = Arc::new(read_engine_search_policy(scratch.path()));

        let results = capture_ingest_batch_on_store(
            &mut store,
            &inputs,
            &policy,
            &leases,
            &NoFaults,
            &CancellationToken::new(),
            (scratch.path(), &ExistingRootGuard),
        )
        .expect("capture fallback batch");

        assert_eq!(results.len(), 3);
        assert!(results[0].is_ok(), "the first sibling must commit");
        assert!(matches!(
            &results[1],
            Err(RuntimeError::Sync(
                dohc_engine_sync::SyncError::RetryableState { reason }
            )) if *reason == CAPTURE_NEW_FILE_LIVE
        ));
        assert!(results[2].is_ok(), "the final sibling must commit");
        let first_order = results[0]
            .as_ref()
            .expect("first sibling result")
            .moment
            .moment_order;
        let final_order = results[2]
            .as_ref()
            .expect("final sibling result")
            .moment
            .moment_order;
        assert_eq!(
            final_order,
            first_order + 1,
            "the rolled-back item must not advance the shared moment cursor"
        );

        drop(store);
        let mut reopened = EngineStore::open(&db, 1).expect("reopen store");
        let versioned = VersionedTextStore::new(&mut reopened);
        assert_eq!(
            versioned
                .read_text(WORKSPACE_ID, VERSION_ID, "note-0.md")
                .expect("read first sibling")
                .expect("first sibling head")
                .text,
            "body 0"
        );
        assert_eq!(
            versioned
                .read_text(WORKSPACE_ID, VERSION_ID, "note-2.md")
                .expect("read final sibling")
                .expect("final sibling head")
                .text,
            "body 2"
        );
        assert!(
            versioned
                .read_text(WORKSPACE_ID, VERSION_ID, FAILED_PATH)
                .expect("read failed item")
                .is_none(),
            "the failed item must have no readable head"
        );
        let (snapshots, moments, search_rows): (i64, i64, i64) = reopened
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT COUNT(*) FROM snapshots WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                        (WORKSPACE_ID, VERSION_ID, &failed_object_id),
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM moments WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                        (WORKSPACE_ID, VERSION_ID, &failed_object_id),
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM engine_search_files_fts WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                        (WORKSPACE_ID, VERSION_ID, &failed_object_id),
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("read failed item durable rows");
        assert_eq!(
            (snapshots, moments, search_rows),
            (0, 0, 0),
            "the failed item must leave no snapshot, moment, or search row"
        );
    }
}

fn capture_ingest_binary_on_store(
    store: &mut EngineStore,
    input: &CaptureIngestBinary,
    leases: &LeaseRegistry,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<CaptureIngestBinaryResult, RuntimeError> {
    #[cfg(feature = "fault-injection")]
    let mut phase = dohc_engine_storage::capture_phase::Phase::new(
        "actor_capture_binary",
        input.metadata_correlation_id.as_deref(),
        1,
        true,
    );
    #[cfg(feature = "fault-injection")]
    phase.finish("attempted");
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let outcome = store.write_with(faults, |tx| {
        let hold = capture_file_holds::pin_in(tx, &input.workspace_id, &input.path)?;
        let mut pinned = std::borrow::Cow::Borrowed(input);
        if let Some(hold) = &hold {
            pinned
                .to_mut()
                .version_id
                .clone_from(&hold.source_version_id);
        }
        let input = pinned.as_ref();
        let mut admitted = false;
        if hold.is_none() {
            ensure_no_pending_undo_placement(tx, &input.workspace_id, &input.path)?;
        }
        let mut result = capture_ingest_binary_with_admission_in_tx(
            tx,
            input,
            |workspace_id, version_id, object_id| {
                ensure_capture_target_not_leased(tx, leases, workspace_id, version_id, object_id)?;
                admitted = true;
                Ok::<_, RuntimeError>(())
            },
        )?;
        if admitted {
            dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.object_id,
                dohc_engine_sync::ResultingHead::BinaryOrAbsent,
                None,
                None,
                input.now_ms,
            )?;
        }
        if !result.deduped {
            delete_file_search_index(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.object_id,
            )
            .map_err(RuntimeError::from)?;
        }
        journal_moment_outbound_in_tx(tx, &input.workspace_id, &result.moment_id, result.deduped)
            .map_err(RuntimeError::from)?;
        result.pending_placement =
            pending_placement_in(tx, &input.workspace_id, &input.path, hold.is_some())?;
        result.released_capture_hold = hold.is_some();
        if hold.is_some() {
            capture_file_holds::rebase_switch_jobs_in(
                tx,
                &input.workspace_id,
                names_path(&input.path),
                &dohc_engine_storage::Preimage::Present(dohc_engine_storage::hex_sha256(
                    &input.bytes,
                )),
            )?;
            capture_file_holds::clear_in(tx, &input.workspace_id, &input.path)?;
        }
        Ok::<_, RuntimeError>(result)
    });
    let outcome = match outcome {
        Err(error @ RuntimeError::Domain(DomainError::CaptureNotOwned)) => {
            if clear_unowned_capture_hold(store, &input.workspace_id, &input.path, faults)? {
                return Err(RuntimeError::CaptureNotOwnedAfterHold {
                    path: input.path.clone(),
                });
            }
            return Err(error);
        }
        result => result?,
    };
    match outcome {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

pub(super) fn ensure_no_pending_undo_placement(
    conn: &Connection,
    workspace: &str,
    path: &str,
) -> Result<(), RuntimeError> {
    let pending: bool = conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM materialization_jobs j
         JOIN moments m ON m.workspace_id=j.workspace_id AND m.moment_order=j.target_generation
         JOIN versioned_workspaces w ON w.workspace_id=m.workspace_id
         JOIN snapshots s ON s.workspace_id=m.workspace_id AND s.version_id=m.version_id
             AND s.object_id=m.object_id AND s.path=m.path
         WHERE j.workspace_id=?1 AND j.target_path=?2 AND j.status='pending'
             AND m.metadata_correlation_id GLOB 'dohc-operation:undo:*'
             AND m.version_id=coalesce((SELECT version_id FROM active_versions
                 WHERE workspace_id=m.workspace_id),w.main_version_id)
             AND coalesce(s.binary_sha256,s.blob_sha256)=j.content_sha256
             AND (j.operation='write' OR NOT EXISTS(SELECT 1 FROM path_aliases a
                 WHERE a.workspace_id=m.workspace_id AND a.version_id=m.version_id
                     AND a.path=j.target_path)))",
        )
        .map_err(StorageError::corrupt_public)?
        .query_row(params![workspace, path], |r| r.get(0))
        .map_err(StorageError::corrupt_public)?;
    if pending {
        return Err(RuntimeError::Sync(
            dohc_engine_sync::SyncError::RetryableState {
                reason: "history-undo-placement-pending",
            },
        ));
    }
    Ok(())
}

fn ensure_capture_target_not_leased(
    conn: &Connection,
    leases: &LeaseRegistry,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<(), RuntimeError> {
    let key = DocKey::new(workspace_id, version_id, object_id)?;
    // Session releases wake deferred capture. Internal leases still fail
    // and retry because their release does not wake the driver.
    let session = leases.is_held_by_session(&key);
    if !session && !leases.is_held(&key) {
        return Ok(());
    }
    let recorded = dohc_engine_domain::object_has_live_alias(conn, workspace_id, object_id)?;
    Err(RuntimeError::Sync(
        dohc_engine_sync::SyncError::RetryableState {
            reason: if recorded && session {
                CAPTURE_WRITE_WAITS_FOR_SESSION
            } else if recorded || !session {
                CAPTURE_RECORDED_FILE_LIVE
            } else {
                CAPTURE_NEW_FILE_LIVE
            },
        },
    ))
}

/// The capture refusal for a new file whose live session holds it before the
/// store has a head for it.
pub const CAPTURE_NEW_FILE_LIVE: &str = "ydoc-session-live-new-file";

/// An internal attempt holds the capture target; fail and retry on a later pass.
const CAPTURE_RECORDED_FILE_LIVE: &str = "ydoc-session-live";

/// An outside write waits until the open document releases its lease.
pub const CAPTURE_WRITE_WAITS_FOR_SESSION: &str = "capture-write-waits-for-session";

/// The capture refusal to retire a recorded file while a document session
/// holds it. The session's release wakes capture, which retires it then. An
/// internal attempt's release wakes nothing, so its lease refuses as
/// `ydoc-session-live` and capture retries as for any failure.
pub const CAPTURE_RETIRE_WAITS_FOR_SESSION: &str = "capture-retire-waits-for-session";

fn capture_secret_on_store(
    store: &mut EngineStore,
    input: &CaptureSecret,
    key: &SecretDataKey,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<SecretWriteResult, RuntimeError> {
    #[cfg(feature = "fault-injection")]
    let mut phase = dohc_engine_storage::capture_phase::Phase::new(
        "actor_capture_secret",
        input.metadata_correlation_id.as_deref(),
        1,
        true,
    );
    #[cfg(feature = "fault-injection")]
    phase.finish("attempted");
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    SecretFileStore::new(store, key)
        .capture_secret_with(input, faults, |tx, result| {
            journal_secret_put_outbound_in_tx(tx, result)
        })
        .map_err(RuntimeError::from)
}

fn capture_secret_retire_on_store(
    store: &mut EngineStore,
    input: &CaptureSecretRetire,
    root_dir: &std::path::Path,
    root_guard: &dyn WorkspaceRootGuard,
    faults: &dyn FaultInjector,
) -> Result<Option<SecretMomentRecord>, RuntimeError> {
    #[cfg(feature = "fault-injection")]
    let mut phase = dohc_engine_storage::capture_phase::Phase::new(
        "actor_capture_secret_retire",
        input.metadata_correlation_id.as_deref(),
        1,
        true,
    );
    #[cfg(feature = "fault-injection")]
    phase.finish("attempted");
    root_guard.validate(root_dir)?;
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    capture_secret_retire_with(store, input, faults, journal_secret_delete_outbound_in_tx)
        .map_err(RuntimeError::from)
}

/// Refuse, with a retryable error, an absence retire that the actor cannot
/// confirm: something is at the path, or an unfinished replace moved it aside.
/// Runs on the actor thread, so no materialization is between its two renames.
pub(super) fn confirm_absent_on_disk(
    store: &EngineStore,
    root_dir: &std::path::Path,
    workspace_id: &str,
    path: &str,
    now_ms: i64,
) -> Result<(), RuntimeError> {
    let refuse =
        |reason| RuntimeError::Sync(dohc_engine_sync::SyncError::RetryableState { reason });
    let displaced =
        || match dohc_engine_files::path_is_displaced(store, root_dir, workspace_id, path) {
            Err(dohc_engine_files::MaterializeError::Storage(err)) => Err(RuntimeError::from(err)),
            Err(_) => Err(refuse("absence-unconfirmed")),
            Ok(displaced) => Ok(displaced),
        };
    if displaced()? {
        // A replace could not put a staged file back when it ran. Try again
        // now, without sleeping on the actor thread; the sweep retries with
        // backoff. The check below then sees a file that returned.
        let _ = dohc_engine_files::recover_path_displacements(
            store,
            root_dir,
            workspace_id,
            path,
            &dohc_engine_files::MaterializeOptions {
                holds: None,
                policy: dohc_engine_files::DurabilityPolicy::per_os(),
                replacer: &dohc_engine_files::StdReplacer,
                backoff: &dohc_engine_files::NoBackoff,
                now_ms,
                faults: &dohc_engine_storage::NoFaults,
            },
        );
        if displaced()? {
            return Err(refuse("path-displaced-by-replace"));
        }
    }
    let mut absolute = root_dir.to_path_buf();
    absolute.extend(path.split('/'));
    match std::fs::symlink_metadata(&absolute) {
        Ok(_) => Err(refuse("path-present-on-disk")),
        Err(err)
            if matches!(
                err.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(())
        }
        Err(_) => Err(refuse("absence-unconfirmed")),
    }
}

#[allow(clippy::too_many_arguments)]
fn capture_retire_on_store(
    store: &mut EngineStore,
    input: &CaptureRetire,
    respelled_to: Option<(&str, &str)>,
    root_dir: &std::path::Path,
    root_guard: &dyn WorkspaceRootGuard,
    confirm_absent: bool,
    self_writes: &dyn SelfWriteRecorder,
    leases: &LeaseRegistry,
    faults: &dyn FaultInjector,
) -> Result<CaptureRetireResult, RuntimeError> {
    #[cfg(feature = "fault-injection")]
    let mut phase = dohc_engine_storage::capture_phase::Phase::new(
        "actor_capture_retire",
        input.metadata_correlation_id.as_deref(),
        1,
        true,
    );
    #[cfg(feature = "fault-injection")]
    phase.finish("attempted");
    root_guard.validate(root_dir)?;
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if confirm_absent {
        confirm_absent_on_disk(
            store,
            root_dir,
            &input.workspace_id,
            &input.path,
            input.now_ms,
        )?;
    }
    let outcome = store.write_with(faults, |tx| {
        let hold = capture_file_holds::pin_in(tx, &input.workspace_id, &input.path)?;
        let placement_admission = if hold.is_none() {
            ensure_no_pending_undo_placement(tx, &input.workspace_id, &input.path)
        } else {
            Ok(())
        };
        let mut pinned = std::borrow::Cow::Borrowed(input);
        if let Some(hold) = &hold {
            pinned
                .to_mut()
                .version_id
                .clone_from(&hold.source_version_id);
        }
        let input = pinned.as_ref();
        if let Some(hold) = &hold {
            // A refused recreation has an alias but has never recorded a head.
            // Remove only that held identity; the domain retire then sees absence.
            tx.prepare_cached(
                "DELETE FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 \
                 AND path=?3 AND object_id=?4 AND NOT EXISTS (\
                     SELECT 1 FROM snapshots WHERE workspace_id=?1 AND version_id=?2 \
                     AND object_id=?4)",
            )
            .map_err(StorageError::corrupt_public)?
            .execute(params![
                input.workspace_id,
                input.version_id,
                input.path,
                hold.object_id,
            ])
            .map_err(StorageError::persist_public)?;
        }
        let mut result = match respelled_to {
            Some((to, to_sha256)) => capture_retire_respelled_in_tx(tx, input, to, to_sha256),
            None => capture_retire_in_tx(tx, input),
        }
        .map_err(RuntimeError::from)?;
        if result.retired.is_some() {
            placement_admission?;
        }
        let mut asset_jobs = Vec::new();
        if !result.deduped
            && let Some(retired) = result.retired.as_ref()
        {
            let key = DocKey::new(
                &input.workspace_id,
                &input.version_id,
                &retired.object.object_id,
            )?;
            if leases.is_held(&key) {
                return Err(RuntimeError::Sync(
                    dohc_engine_sync::SyncError::RetryableState {
                        reason: if leases.is_held_by_session(&key) {
                            CAPTURE_RETIRE_WAITS_FOR_SESSION
                        } else {
                            CAPTURE_RECORDED_FILE_LIVE
                        },
                    },
                ));
            }
            delete_file_search_index(
                tx,
                &input.workspace_id,
                &input.version_id,
                &retired.object.object_id,
            )
            .map_err(RuntimeError::from)?;
        }
        if let Some(retired) = result.retired.as_ref() {
            if !result.deduped && !retired.deduped {
                journal_moment_outbound_in_tx(
                    tx,
                    &input.workspace_id,
                    &retired.moment.moment_id,
                    false,
                )
                .map_err(RuntimeError::from)?;
                asset_jobs = delete_owned_scene_assets_in_tx(tx, retired)?;
                dohc_engine_sync::retire_ydoc_lineage_in_tx(
                    tx,
                    &input.workspace_id,
                    &input.version_id,
                    &retired.object.object_id,
                )
                .map_err(RuntimeError::from)?;
            } else {
                journal_moment_outbound_in_tx(
                    tx,
                    &input.workspace_id,
                    &retired.moment.moment_id,
                    true,
                )
                .map_err(RuntimeError::from)?;
            }
        }
        result.pending_placement =
            pending_placement_in(tx, &input.workspace_id, &input.path, hold.is_some())?;
        result.released_capture_hold = hold.is_some();
        if hold.is_some() {
            capture_file_holds::rebase_switch_jobs_in(
                tx,
                &input.workspace_id,
                names_path(&input.path),
                &dohc_engine_storage::Preimage::Absent,
            )?;
            capture_file_holds::clear_in(tx, &input.workspace_id, &input.path)?;
        }
        Ok::<_, RuntimeError>((result, asset_jobs))
    })?;
    match outcome {
        TxnOutcome::Committed((result, asset_jobs)) => {
            root_guard.validate(root_dir)?;
            materialize_scene_asset_deletes(
                store,
                root_dir,
                &input.workspace_id,
                &asset_jobs,
                self_writes,
                faults,
                Some(root_guard),
                None,
            )?;
            Ok(result)
        }
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

#[cfg(test)]
mod capture_secret_root_guard_tests {
    use super::super::Command;
    use super::*;
    use crate::WorkspaceSupervisor;
    use crate::search::read_engine_search_policy;
    use dohc_engine_collab::{
        OwnerDeliveryReceipt, OwnerOutboxAppendInput, OwnerOutboxQuarantineInput,
        append_owner_outbox,
    };
    use dohc_engine_domain::secret_file_len_keyless;
    use dohc_engine_storage::NoFaults;
    use dohc_engine_testkit::ScratchDir;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::{Condvar, Mutex};
    use std::time::Duration;
    use tokio::sync::oneshot;

    const WORKSPACE_ID: &str = "workspace";
    const VERSION_ID: &str = "main";
    const SECRET_PATH: &str = ".env";

    struct BoundRootGuard {
        identity: file_id::FileId,
    }

    impl BoundRootGuard {
        fn bind(root: &std::path::Path) -> Self {
            Self {
                identity: file_id::get_file_id(root).expect("bind workspace root identity"),
            }
        }
    }

    impl WorkspaceRootGuard for BoundRootGuard {
        fn validate(&self, root_dir: &std::path::Path) -> Result<(), RuntimeError> {
            (file_id::get_file_id(root_dir).ok() == Some(self.identity))
                .then_some(())
                .ok_or(RuntimeError::Identity {
                    reason: "workspace root changed during capture",
                    source: None,
                })
        }
    }

    struct PausedRootGuard {
        bound: BoundRootGuard,
        reached: (Mutex<bool>, Condvar),
        released: (Mutex<bool>, Condvar),
    }

    impl PausedRootGuard {
        fn bind(root: &std::path::Path) -> Arc<Self> {
            Arc::new(Self {
                bound: BoundRootGuard::bind(root),
                reached: (Mutex::new(false), Condvar::new()),
                released: (Mutex::new(false), Condvar::new()),
            })
        }

        fn wait_until_reached(&self) {
            let reached = self.reached.0.lock().expect("lock reached state");
            let (reached, timeout) = self
                .reached
                .1
                .wait_timeout_while(reached, Duration::from_secs(10), |reached| !*reached)
                .expect("wait for actor blocker");
            assert!(*reached, "actor did not reach the blocking command");
            assert!(!timeout.timed_out(), "actor blocker timed out");
        }

        fn release(&self) {
            let mut released = self.released.0.lock().expect("lock release state");
            *released = true;
            self.released.1.notify_all();
        }
    }

    impl WorkspaceRootGuard for PausedRootGuard {
        fn validate(&self, root_dir: &std::path::Path) -> Result<(), RuntimeError> {
            {
                let mut reached = self.reached.0.lock().expect("lock reached state");
                *reached = true;
                self.reached.1.notify_all();
            }
            let released = self.released.0.lock().expect("lock release state");
            let (released, timeout) = self
                .released
                .1
                .wait_timeout_while(released, Duration::from_secs(10), |released| !*released)
                .expect("wait for root replacement");
            if timeout.timed_out() || !*released {
                return Err(RuntimeError::Identity {
                    reason: "test root guard release timed out",
                    source: None,
                });
            }
            self.bound.validate(root_dir)
        }
    }

    #[test]
    fn queued_owner_outbox_mutations_observe_cancellation_before_storage() {
        for method in ["append", "acknowledge", "quarantine"] {
            for abandon_reply in [false, true] {
                let store_scratch = ScratchDir::new().expect("store scratch");
                let root_scratch = ScratchDir::new().expect("root scratch");
                let root = root_scratch.path().to_path_buf();
                let db =
                    dohc_engine_testkit::engine_db_path(&store_scratch).expect("database path");
                let mut store = EngineStore::open(&db, 1).expect("seed store");
                VersionedTextStore::new(&mut store)
                    .ensure_main_version(WORKSPACE_ID, VERSION_ID, 1, &NoFaults)
                    .expect("main version");
                let input = OwnerOutboxAppendInput {
                    binding: dohc_engine_collab::LiveObjectBinding {
                        workspace_id: WORKSPACE_ID.to_owned(),
                        main_version_id: VERSION_ID.to_owned(),
                        object_id: "object-1".to_owned(),
                        lineage_claim_id: "lineage-1".to_owned(),
                        current_path: "owner.md".to_owned(),
                        selector_paths: vec!["owner.md".to_owned()],
                        restore_fence_generation: 0,
                    },
                    base_update: b"base".to_vec(),
                    update: b"seed".to_vec(),
                    append_key: "seed".to_owned(),
                    limits: dohc_engine_collab::OwnerOutboxLimits {
                        max_pending_bytes: 1000,
                        max_pending_age_ms: 1000,
                    },
                    created_at_ms: 1,
                };
                let appended = append_owner_outbox(&mut store, WORKSPACE_ID, input.clone())
                    .expect("seed append");
                let before = dohc_engine_collab::read_pending_owner_outbox(
                    &store,
                    WORKSPACE_ID,
                    &appended.outbox_id,
                )
                .expect("seed pending");
                drop(store);
                let supervisor = WorkspaceSupervisor::new();
                let actor = supervisor.open(&db, 1).expect("actor").actor;
                let blocker = PausedRootGuard::bind(&root);
                let blocker_guard: Arc<dyn WorkspaceRootGuard> = blocker.clone();
                let blocker_input = CaptureRetire {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    version_id: VERSION_ID.to_owned(),
                    path: "missing.md".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 2,
                    request_id: None,
                    only_if_text_head: false,
                    only_if_capture_origin: true,
                    allow_ydoc_origin: true,
                };
                let blocker_actor = actor.clone();
                let blocker_thread = std::thread::spawn(move || {
                    blocker_actor.capture_retire_materialized_blocking_guarded(
                        blocker_input,
                        root,
                        false,
                        Arc::new(()),
                        LeaseRegistry::new(),
                        Arc::new(NoFaults),
                        blocker_guard,
                    )
                });
                blocker.wait_until_reached();
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("runtime");
                let token = CancellationToken::new();
                let pending = async {
                    match method {
                        "append" => actor
                            .owner_ydoc_outbox_append(
                                WORKSPACE_ID.to_owned(),
                                OwnerOutboxAppendInput {
                                    append_key: "cancelled".to_owned(),
                                    update: b"cancelled update".to_vec(),
                                    ..input
                                },
                                token.clone(),
                            )
                            .await
                            .map(|outcome| outcome.map(|_| ())),
                        "acknowledge" => actor
                            .owner_ydoc_outbox_acknowledge(
                                WORKSPACE_ID.to_owned(),
                                appended.outbox_id.clone(),
                                vec![OwnerDeliveryReceipt {
                                    delivery_id: before.entries[0].delivery_id.clone(),
                                    update_digest: before.entries[0].update_digest.clone(),
                                    journal_cursor: 1,
                                    accepting_host_epoch: 1,
                                }],
                                token.clone(),
                            )
                            .await
                            .map(|outcome| outcome.map(|_| ())),
                        _ => {
                            actor
                                .owner_ydoc_outbox_quarantine(
                                    WORKSPACE_ID.to_owned(),
                                    OwnerOutboxQuarantineInput {
                                        outbox_id: appended.outbox_id.clone(),
                                        reason: "cancelled quarantine".to_owned(),
                                        observed_binding: None,
                                    },
                                    20,
                                    token.clone(),
                                )
                                .await
                        }
                    }
                };
                let mut pending = Some(Box::pin(pending));
                let was_pending = runtime.block_on(std::future::poll_fn(|cx| {
                    std::task::Poll::Ready(
                        std::future::Future::poll(pending.as_mut().expect("future").as_mut(), cx)
                            .is_pending(),
                    )
                }));
                // The empty actor channel accepted the command on that poll;
                // the earlier command still holds the writer. Service teardown
                // cancels this same token when its reply future is dropped.
                token.cancel();
                if abandon_reply || !was_pending {
                    drop(pending.take());
                }
                let (drained_reply, drained_rx) = oneshot::channel();
                actor
                    .tx
                    .blocking_send(Command::Run(Box::new(move |store, _cache| {
                        let outcome = capture_manifest_seed(store, WORKSPACE_ID, VERSION_ID)
                            .map_err(RuntimeError::from);
                        let _ = drained_reply.send(outcome);
                    })))
                    .expect("queue read barrier after cancelled mutation");
                blocker.release();
                let blocker_result = blocker_thread.join().expect("join blocker caller");
                let result = pending.map(|pending| runtime.block_on(pending));
                let drained_result = drained_rx.blocking_recv();
                drop(actor);
                supervisor
                    .close(&db)
                    .expect("close actor after queue drains");
                let store = EngineStore::open_read_only(&db).expect("read store");
                let after = dohc_engine_collab::read_pending_owner_outbox(
                    &store,
                    WORKSPACE_ID,
                    &appended.outbox_id,
                )
                .expect("retained pending");
                assert!(was_pending, "{method} must enter the held actor queue");
                assert!(blocker_result.is_ok(), "blocker reply must complete");
                assert!(
                    drained_result.is_ok(),
                    "read barrier must run before closing the actor"
                );
                if !abandon_reply {
                    assert!(
                        matches!(result, Some(Err(RuntimeError::Cancelled))),
                        "{method}"
                    );
                }
                assert_eq!(after, before, "{method}, abandoned reply={abandon_reply}");
            }
        }
    }

    fn wait_for_command_admission(actor: &ActorHandle, available_before: usize) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while actor.tx.capacity() == available_before {
            assert!(
                std::time::Instant::now() < deadline,
                "public call did not acquire an actor channel slot"
            );
            std::thread::yield_now();
        }
        assert_eq!(actor.tx.capacity(), available_before - 1);
    }

    struct RejectSecondValidation {
        calls: AtomicUsize,
    }

    impl WorkspaceRootGuard for RejectSecondValidation {
        fn validate(&self, _root_dir: &std::path::Path) -> Result<(), RuntimeError> {
            if self.calls.fetch_add(1, AtomicOrdering::SeqCst) == 0 {
                Ok(())
            } else {
                Err(RuntimeError::Identity {
                    reason: "workspace root changed during capture",
                    source: None,
                })
            }
        }
    }

    #[test]
    fn capture_batch_rolls_back_version_bootstrap_when_final_root_fence_rejects() {
        const PATH: &str = "notes/fenced.md";

        let store_scratch = ScratchDir::new().expect("store scratch");
        let root_scratch = ScratchDir::new().expect("workspace root scratch");
        let root = root_scratch.path();
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let mut store = EngineStore::open(&db, 1).expect("open store");
        let guard = RejectSecondValidation {
            calls: AtomicUsize::new(0),
        };
        let result = capture_ingest_batch_on_store(
            &mut store,
            &[CaptureIngest {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: VERSION_ID.to_owned(),
                path: PATH.to_owned(),
                text: "fenced body".to_owned(),
                metadata_origin: dohc_engine_domain::store::CAPTURE_ORIGIN.to_owned(),
                metadata_summary: Some("Reconciled offline edits".to_owned()),
                metadata_correlation_id: Some("second-root-fence".to_owned()),
                author_json: None,
                now_ms: 2,
                request_id: None,
                claim_foreign_head: false,
            }],
            &Arc::new(read_engine_search_policy(root)),
            &LeaseRegistry::new(),
            &NoFaults,
            &CancellationToken::new(),
            (root, &guard),
        );

        assert!(matches!(
            result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
        assert_eq!(guard.calls.load(AtomicOrdering::SeqCst), 2);
        assert!(
            VersionedTextStore::new(&mut store)
                .get_main_version(WORKSPACE_ID)
                .expect("read rolled-back version")
                .is_none(),
            "the rejected transaction must roll back its version bootstrap"
        );
        let durable_rows = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT \
                       (SELECT COUNT(*) FROM versions WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM path_aliases WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM snapshots WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM moments WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM file_objects WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM replication_log WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM engine_search_files_fts WHERE workspace_id=?1)",
                    [WORKSPACE_ID],
                    |row| row.get::<_, i64>(0),
                )
            })
            .expect("count rolled-back rows");
        assert_eq!(durable_rows, 0);
    }

    #[test]
    fn queued_capture_batch_refuses_a_replacement_workspace_root() {
        const PATH: &str = "notes/queued.md";

        let store_scratch = ScratchDir::new().expect("store scratch");
        let root_scratch = ScratchDir::new().expect("workspace root scratch");
        let moved_scratch = ScratchDir::new().expect("moved root scratch");
        let root = root_scratch.path().to_path_buf();
        let moved_root = moved_scratch.path().join("original-root");
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        std::fs::create_dir_all(root.join("notes")).expect("create original notes");
        std::fs::write(root.join(PATH), b"original body").expect("write original file");

        // Hold the writer until the public batch call acquires a channel slot.
        // Replace the root before that call can start its transaction.
        let blocker = PausedRootGuard::bind(&root);
        let blocker_guard: Arc<dyn WorkspaceRootGuard> = blocker.clone();
        let input: CaptureRetire = CaptureRetire {
            workspace_id: WORKSPACE_ID.to_owned(),
            version_id: VERSION_ID.to_owned(),
            path: "missing.md".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            now_ms: 2,
            request_id: None,
            only_if_text_head: false,
            only_if_capture_origin: true,
            allow_ydoc_origin: true,
        };
        let blocker_actor = actor.clone();
        let blocker_root = root.clone();
        let blocker_thread = std::thread::spawn(move || {
            blocker_actor.capture_retire_materialized_blocking_guarded(
                input,
                blocker_root,
                false,
                Arc::new(()),
                LeaseRegistry::new(),
                Arc::new(NoFaults),
                blocker_guard,
            )
        });
        blocker.wait_until_reached();

        let captured_guard: Arc<dyn WorkspaceRootGuard> = Arc::new(BoundRootGuard::bind(&root));
        let inputs: Vec<CaptureIngest> = vec![CaptureIngest {
            workspace_id: WORKSPACE_ID.to_owned(),
            version_id: VERSION_ID.to_owned(),
            path: PATH.to_owned(),
            text: "original body".to_owned(),
            metadata_origin: dohc_engine_domain::store::CAPTURE_ORIGIN.to_owned(),
            metadata_summary: Some("Reconciled offline edits".to_owned()),
            metadata_correlation_id: Some("queued-root-swap".to_owned()),
            author_json: None,
            now_ms: 3,
            request_id: None,
            claim_foreign_head: false,
        }];
        let search_policy: Arc<SearchPolicySnapshot> = Arc::new(read_engine_search_policy(&root));
        let batch_actor = actor.clone();
        let batch_root = root.clone();
        let available_before = actor.tx.capacity();
        let batch_thread = std::thread::spawn(move || {
            batch_actor.capture_ingest_batch_blocking(
                inputs,
                search_policy,
                LeaseRegistry::new(),
                Arc::new(NoFaults),
                batch_root,
                captured_guard,
            )
        });
        wait_for_command_admission(&actor, available_before);

        std::fs::rename(&root, &moved_root).expect("move original workspace root");
        std::fs::create_dir_all(root.join("notes")).expect("create replacement notes");
        std::fs::write(root.join(PATH), b"replacement body").expect("write replacement file");
        let replacement_before = std::fs::read(root.join(PATH)).expect("read replacement file");
        blocker.release();
        let blocker_result = blocker_thread.join().expect("join blocker caller");
        let batch_result = batch_thread.join().expect("join batch caller");
        let replacement_after = std::fs::read(root.join(PATH)).expect("reread replacement file");

        std::fs::remove_dir_all(&root).expect("remove replacement workspace root");
        std::fs::rename(&moved_root, &root).expect("restore original workspace root");
        drop(actor);
        supervisor.close(&db).expect("close actor");
        let mut store = EngineStore::open(&db, 5).expect("reopen store");
        let main_version = VersionedTextStore::new(&mut store)
            .get_main_version(WORKSPACE_ID)
            .expect("read refused workspace version");
        let durable_rows = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT \
                       (SELECT COUNT(*) FROM path_aliases WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM snapshots WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM moments WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM file_objects WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM replication_log WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM engine_search_files_fts WHERE workspace_id=?1)",
                    [WORKSPACE_ID],
                    |row| row.get::<_, i64>(0),
                )
            })
            .expect("count durable capture rows");

        assert!(matches!(
            blocker_result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
        assert!(matches!(
            batch_result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
        assert!(
            main_version.is_none(),
            "the queued batch must not create a version"
        );
        assert_eq!(
            durable_rows, 0,
            "snapshots, moments, replication, and search must remain unchanged"
        );
        assert_eq!(replacement_after, replacement_before);
    }

    #[test]
    fn queued_capture_secret_retire_refuses_a_replacement_workspace_root() {
        let store_scratch = ScratchDir::new().expect("store scratch");
        let root_scratch = ScratchDir::new().expect("workspace root scratch");
        let moved_scratch = ScratchDir::new().expect("moved root scratch");
        let root = root_scratch.path().to_path_buf();
        let moved_root = moved_scratch.path().join("original-root");
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        std::fs::write(root.join(SECRET_PATH), b"TOKEN=original").expect("write original secret");
        actor
            .capture_secret_blocking(
                CaptureSecret {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    version_id: VERSION_ID.to_owned(),
                    path: SECRET_PATH.to_owned(),
                    text: "TOKEN=original".to_owned(),
                    metadata_origin: "local-file".to_owned(),
                    metadata_correlation_id: None,
                    now_ms: 2,
                    claim_foreign_head: true,
                },
                SecretDataKey::from_bytes(&[0x41; 32]).expect("secret key"),
                Arc::new(NoFaults),
            )
            .expect("seed captured secret");
        std::fs::remove_file(root.join(SECRET_PATH)).expect("observe original secret removal");

        // Hold the writer until the public secret retire call acquires a channel
        // slot, then replace the root before the worker can validate it.
        let blocker = PausedRootGuard::bind(&root);
        let blocker_guard: Arc<dyn WorkspaceRootGuard> = blocker.clone();
        let input: CaptureRetire = CaptureRetire {
            workspace_id: WORKSPACE_ID.to_owned(),
            version_id: VERSION_ID.to_owned(),
            path: "missing.md".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            now_ms: 3,
            request_id: None,
            only_if_text_head: false,
            only_if_capture_origin: true,
            allow_ydoc_origin: true,
        };
        let blocker_actor = actor.clone();
        let blocker_root = root.clone();
        let blocker_thread = std::thread::spawn(move || {
            blocker_actor.capture_retire_materialized_blocking_guarded(
                input,
                blocker_root,
                false,
                Arc::new(()),
                LeaseRegistry::new(),
                Arc::new(NoFaults),
                blocker_guard,
            )
        });
        blocker.wait_until_reached();

        let captured_guard: Arc<dyn WorkspaceRootGuard> = Arc::new(BoundRootGuard::bind(&root));
        let input: CaptureSecretRetire = CaptureSecretRetire {
            workspace_id: WORKSPACE_ID.to_owned(),
            version_id: VERSION_ID.to_owned(),
            path: SECRET_PATH.to_owned(),
            metadata_origin: "local-file".to_owned(),
            metadata_correlation_id: None,
            now_ms: 4,
            only_if_own_origin: true,
        };
        let retire_actor = actor.clone();
        let retire_root = root.clone();
        let available_before = actor.tx.capacity();
        let retire_thread = std::thread::spawn(move || {
            retire_actor.capture_secret_retire_blocking_guarded(
                input,
                retire_root,
                Arc::new(NoFaults),
                captured_guard,
            )
        });
        wait_for_command_admission(&actor, available_before);

        std::fs::rename(&root, &moved_root).expect("move original workspace root");
        std::fs::create_dir(&root).expect("create replacement workspace root");
        std::fs::write(root.join(SECRET_PATH), b"TOKEN=replacement")
            .expect("write replacement secret");
        let replacement_before =
            std::fs::read(root.join(SECRET_PATH)).expect("read replacement secret");
        blocker.release();
        let blocker_result = blocker_thread.join().expect("join blocker caller");
        let retire_result = retire_thread.join().expect("join secret retire caller");
        let replacement_after =
            std::fs::read(root.join(SECRET_PATH)).expect("reread replacement secret");

        std::fs::remove_dir_all(&root).expect("remove replacement workspace root");
        std::fs::rename(&moved_root, &root).expect("restore original workspace root");
        drop(actor);
        supervisor.close(&db).expect("close actor");
        let store = EngineStore::open(&db, 5).expect("reopen store");
        let retained = secret_file_len_keyless(&store, WORKSPACE_ID, VERSION_ID, SECRET_PATH)
            .expect("read retained secret tip");

        assert!(matches!(
            blocker_result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
        assert_eq!(retained, Some(14), "the current encrypted tip must survive");
        assert_eq!(replacement_after, replacement_before);
        assert!(matches!(
            retire_result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
    }
}
