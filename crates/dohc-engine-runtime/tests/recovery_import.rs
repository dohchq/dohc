use dohc_engine_collab::{ContentKind, DocKey, LeaseRegistry, Regime, Ydoc};
use dohc_engine_domain::{CaptureIngest, ChangeActorKind, ChangeAttribution};
use dohc_engine_runtime::{ActorHandle, CancellationToken, WorkspaceSupervisor, YdocOpenState};
use dohc_engine_storage::{EngineStore, FaultPoint, NoFaults, StorageError};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::{path::Path, sync::Arc};

const WS: &str = "capture-recovery";
const FILE: &str = "note.txt";

fn input(text: &str, now_ms: i64) -> CaptureIngest {
    CaptureIngest {
        workspace_id: WS.into(),
        version_id: "main".into(),
        path: FILE.into(),
        text: text.into(),
        metadata_origin: "capture".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
        claim_foreign_head: true,
    }
}
async fn capture(actor: &ActorHandle, text: &str) {
    actor
        .capture_ingest(
            input(text, 10),
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture");
}
async fn open(actor: &ActorHandle) -> YdocOpenState {
    actor
        .ydoc_open_state(
            WS.into(),
            1,
            true,
            None,
            "main".into(),
            FILE.into(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open")
}
async fn append(actor: &ActorHandle, key: &DocKey, bytes: Vec<u8>) {
    actor
        .ydoc_record_update(
            key.clone(),
            FILE.into(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            bytes,
            Some("writer".into()),
            Some(ChangeAttribution {
                actor_kind: ChangeActorKind::Agent,
                on_behalf_of: Some("owner".into()),
                depth: 0,
                run: None,
            }),
            None,
            false,
            None,
            None,
            2,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("append");
}
fn inspect<T>(db: &Path, f: impl FnOnce(&mut EngineStore) -> T) -> T {
    f(&mut EngineStore::open(db, 30).expect("inspect"))
}

use dohc_engine_runtime::actor::{RecoveryImport, RecoveryImportOutcome, RecoveryUpdate};
use dohc_engine_storage::hex_sha256;

fn checkpoint(state: &YdocOpenState, doc: &Ydoc, bytes: Vec<u8>) -> RecoveryImport {
    RecoveryImport {
        key: state.key.clone(),
        path: FILE.into(),
        expected_claim_id: state.lineage_claim_id.clone(),
        expected_state_vector_sha256: {
            let base = Ydoc::wire();
            base.apply(&state.initial_update).unwrap();
            hex_sha256(&base.encode_state_vector())
        },
        expected_disk_sha256: Some(hex_sha256(b"base\n")),
        text: doc.plaintext_string(),
        updates: vec![RecoveryUpdate {
            request_id: "outage-update".into(),
            update: bytes,
            actor_origin_id: Some("writer".into()),
            attribution: Some(ChangeAttribution {
                actor_kind: ChangeActorKind::Agent,
                on_behalf_of: Some("owner".into()),
                depth: 0,
                run: None,
            }),
        }],
    }
}
async fn setup() -> (
    ScratchDir,
    std::path::PathBuf,
    WorkspaceSupervisor,
    ActorHandle,
    YdocOpenState,
    Ydoc,
    Vec<u8>,
) {
    let scratch = ScratchDir::new().unwrap();
    std::fs::write(scratch.path().join(FILE), "base\n").unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    capture(&actor, "base\n").await;
    let first = open(&actor).await;
    let seed = Ydoc::wire();
    seed.apply(&first.initial_update).unwrap();
    actor
        .ydoc_record_update(
            first.key.clone(),
            FILE.into(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            seed.plaintext_insert(0, "base\n"),
            None,
            None,
            first.lineage_claim_id.clone(),
            true,
            first.owner_seed_source.clone(),
            None,
            2,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
    actor
        .ydoc_settle(
            scratch.path().to_path_buf(),
            first.key.clone(),
            FILE.into(),
            ContentKind::Plaintext,
            first.lineage_claim_id.clone(),
            first.head_blob_sha256.clone(),
            "seed-session".into(),
            Arc::new(()),
            3,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
    let state = open(&actor).await;
    let doc = Ydoc::wire();
    doc.apply(&state.initial_update).unwrap();
    let bytes = doc.plaintext_insert(0, "outage\n");
    (scratch, db, supervisor, actor, state, doc, bytes)
}
async fn import(
    actor: &ActorHandle,
    root: &Path,
    input: RecoveryImport,
) -> Result<RecoveryImportOutcome, dohc_engine_runtime::RuntimeError> {
    actor
        .capture_import_recovery(root.to_path_buf(), input, 20, Arc::new(NoFaults))
        .await
        .map(|result| result.outcome)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unchanged_lineage_replays_once_and_preserves_original_author_and_request() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    assert_eq!(
        import(
            &actor,
            scratch.path(),
            checkpoint(&state, &doc, bytes.clone())
        )
        .await
        .unwrap(),
        RecoveryImportOutcome::Replayed
    );
    assert_eq!(
        import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
            .await
            .unwrap(),
        RecoveryImportOutcome::Replayed
    );
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        "base\n"
    );
    supervisor.close(&db).unwrap();
    inspect(&db, |store| {
        store
            .read_with(|c| {
                let key = &state.key;
                let actual = dohc_engine_collab::load_doc_in(c, key).unwrap();
                assert_eq!(actual.plaintext_string(), "outage\nbase\n");
                let count: i64 = c
                    .query_row(
                        "SELECT COUNT(*) FROM engine_requests WHERE request_id='outage-update'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(count, 1);
                let authors = dohc_engine_collab::author_coverage::recovery_in(c, key)
                    .unwrap()
                    .json();
                assert!(authors.contains("writer"));
                Ok::<_, StorageError>(())
            })
            .unwrap()
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_capture_imports_without_merging_and_a_dismissal_never_returns() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    std::fs::write(scratch.path().join(FILE), "outside\n").unwrap();
    capture(&actor, "outside\n").await;
    let outcome = import(
        &actor,
        scratch.path(),
        checkpoint(&state, &doc, bytes.clone()),
    )
    .await
    .unwrap();
    let RecoveryImportOutcome::Imported { moment_id } = outcome else {
        panic!("must import")
    };
    let moment = actor
        .get_moment(WS.into(), moment_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(moment.before_text.as_deref(), Some("outage\nbase\n"));
    assert_eq!(moment.after_text.as_deref(), Some("outside\n"));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        "outside\n"
    );
    let opened = open(&actor).await;
    assert_eq!(opened.head_blob_sha256, Some(hex_sha256(b"outside\n")));
    actor
        .clear_capture_recovery(WS.into(), moment_id.clone())
        .await
        .unwrap();
    assert_eq!(
        import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
            .await
            .unwrap(),
        RecoveryImportOutcome::Imported { moment_id }
    );
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_update_is_covered_without_another_append_or_moment() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    append(&actor, &state.key, bytes.clone()).await;
    assert_eq!(
        import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
            .await
            .unwrap(),
        RecoveryImportOutcome::Covered
    );
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_crash_retry_keeps_one_moment_across_a_changed_head() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
        std::fs::write(scratch.path().join(FILE), "outside\n").unwrap();
        capture(&actor, "outside\n").await;
        let failed = actor
            .capture_import_recovery(
                scratch.path().to_path_buf(),
                checkpoint(&state, &doc, bytes.clone()),
                20,
                ScriptedFaults::crash_at(point),
            )
            .await;
        assert!(failed.is_err());
        supervisor.close(&db).unwrap();
        let actor = supervisor.open(&db, 21).unwrap().actor;
        capture(&actor, "later\n").await;
        import(
            &actor,
            scratch.path(),
            checkpoint(&state, &doc, bytes.clone()),
        )
        .await
        .unwrap();
        import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
            .await
            .unwrap();
        assert_eq!(actor.capture_recoveries(WS.into()).await.unwrap().len(), 1);
        supervisor.close(&db).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn racing_capture_and_import_leave_outside_head_and_one_recovery() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    std::fs::write(scratch.path().join(FILE), "outside\n").unwrap();
    let (_, result) = tokio::join!(
        capture(&actor, "outside\n"),
        import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
    );
    result.unwrap();
    let opened = open(&actor).await;
    assert_eq!(opened.head_blob_sha256, Some(hex_sha256(b"outside\n")));
    assert_eq!(actor.capture_recoveries(WS.into()).await.unwrap().len(), 1);
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remote_human_is_a_typed_refusal_without_writing() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    let mut input = checkpoint(&state, &doc, bytes);
    input.updates[0].attribution.as_mut().unwrap().actor_kind = ChangeActorKind::Human;
    let error = import(&actor, scratch.path(), input).await.unwrap_err();
    assert!(matches!(
        error,
        dohc_engine_runtime::RuntimeError::RecoveryImportRefused {
            reason: "remote-human-author"
        }
    ));
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renamed_object_recovers_at_its_current_path() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    actor
        .versioned_text_rename(
            dohc_engine_domain::RenameTextFile {
                workspace_id: WS.into(),
                version_id: "main".into(),
                from_path: FILE.into(),
                to_path: "renamed.txt".into(),
                moment_id: "rename".into(),
                request_id: None,
                metadata_origin: "human".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 12,
            },
            scratch.path().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let result = import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
        .await
        .unwrap();
    assert!(matches!(
        result,
        RecoveryImportOutcome::Imported { .. } | RecoveryImportOutcome::Replayed
    ));
    for recovery in actor.capture_recoveries(WS.into()).await.unwrap() {
        assert_eq!(recovery.path, "renamed.txt");
    }
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        "base\n"
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleted_object_refuses_without_discarding_typing() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    actor
        .versioned_text_delete(
            dohc_engine_domain::DeleteTextFile {
                workspace_id: WS.into(),
                version_id: "main".into(),
                path: FILE.into(),
                moment_id: "delete".into(),
                request_id: None,
                metadata_origin: "human".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 12,
            },
            scratch.path().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let error = import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        dohc_engine_runtime::RuntimeError::RecoveryImportRefused {
            reason: "object-deleted"
        }
    ));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        "base\n"
    );
    supervisor.close(&db).unwrap();
}
