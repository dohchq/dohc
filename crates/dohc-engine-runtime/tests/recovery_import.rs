use crate::support;
use dohc_engine_collab::{ContentKind, LeaseRegistry, Regime, Ydoc};
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
        admitted_base: state.initial_update.clone(),
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
                agent_run_id: Some("outage-run".into()),
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
                // The outage typing's agent run survives the restart.
                assert!(authors.contains(r#""agentRunId":"outage-run""#));
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
async fn a_remote_human_is_a_typed_refusal_without_writing() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    let mut input = checkpoint(&state, &doc, bytes);
    // Only an agent names a run, so the human here names none.
    let attribution = input.updates[0].attribution.as_mut().unwrap();
    attribution.actor_kind = ChangeActorKind::Human;
    attribution.agent_run_id = None;
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
async fn deleted_object_imports_typing_into_history_without_restoring_file() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    delete(&actor, scratch.path()).await;
    let result = import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
        .await
        .unwrap();
    assert!(matches!(result, RecoveryImportOutcome::Imported { .. }));
    let rows = actor.capture_recoveries(WS.into()).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].object_id, state.key.object_id);
    assert!(rows[0].deleted);

    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        "base\n"
    );
    supervisor.close(&db).unwrap();
    inspect(&db, |store| {
        store.read_with(|c| {
      let (operation, before, after, after_path, after_kind): (String,String,String,String,String) = c.query_row(
        "SELECT m.operation,b.text,a.text,m.payload_after_path,m.payload_after_content_kind FROM moments m JOIN blobs b ON b.sha256=m.payload_before_blob_sha256 JOIN blobs a ON a.sha256=m.payload_after_blob_sha256 WHERE m.metadata_origin='capture-recovery'", [], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
      assert_eq!(operation,"write"); assert_eq!(before,"outage\nbase\n"); assert_eq!(after,""); assert_eq!(after_path,FILE); assert_eq!(after_kind,"text");
      Ok::<_,StorageError>(())
    }).unwrap();
    });
}

async fn delete(actor: &ActorHandle, root: &Path) {
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
            root.to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
}

// dohc's own settlement can write the base's text after a checkpoint names
// the earlier file. That write is not an outside change.

fn agent() -> Option<ChangeAttribution> {
    Some(ChangeAttribution {
        actor_kind: ChangeActorKind::Agent,
        on_behalf_of: Some("owner".into()),
        depth: 0,
        run: None,
        agent_run_id: None,
    })
}
fn typed(request_id: &str, update: Vec<u8>) -> RecoveryUpdate {
    RecoveryUpdate {
        request_id: request_id.into(),
        update,
        actor_origin_id: Some("writer".into()),
        attribution: agent(),
    }
}
fn disk(root: &Path, path: &str) -> Vec<u8> {
    std::fs::read(root.join(path)).unwrap()
}
async fn settle(
    actor: &ActorHandle,
    root: &Path,
    state: &YdocOpenState,
    path: &str,
    kind: ContentKind,
    now_ms: i64,
) {
    actor
        .ydoc_settle(
            root.to_path_buf(),
            state.key.clone(),
            path.into(),
            kind,
            state.lineage_claim_id.clone(),
            Some(hex_sha256(&disk(root, path))),
            format!("settle-{now_ms}"),
            Arc::new(()),
            now_ms,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .unwrap();
}
async fn record(
    actor: &ActorHandle,
    state: &YdocOpenState,
    path: &str,
    kind: ContentKind,
    update: Vec<u8>,
    request_id: &str,
    now_ms: i64,
) {
    actor
        .ydoc_record_update(
            state.key.clone(),
            path.into(),
            kind,
            state.regime,
            update,
            Some("writer".into()),
            agent(),
            state.lineage_claim_id.clone(),
            false,
            None,
            Some(request_id.into()),
            now_ms,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
}
/// A checkpoint taken after `doc`'s acknowledged state, naming `disk_sha256`.
fn checkpoint_at(
    state: &YdocOpenState,
    path: &str,
    doc: &Ydoc,
    disk_sha256: String,
) -> RecoveryImport {
    RecoveryImport {
        key: state.key.clone(),
        path: path.into(),
        expected_claim_id: state.lineage_claim_id.clone(),
        expected_state_vector_sha256: hex_sha256(&doc.encode_state_vector()),
        expected_disk_sha256: Some(disk_sha256),
        admitted_base: doc.encode_full_state(),
        text: String::new(),
        updates: Vec::new(),
    }
}
fn receipts(db: &Path, request_id: &str) -> i64 {
    inspect(db, |store| {
        store
            .read_with(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM engine_requests WHERE request_id=?1",
                    [request_id],
                    |r| r.get(0),
                )
                .map_err(StorageError::corrupt_public)
            })
            .unwrap()
    })
}

const NOTE: &str = "note.md";

struct Rich {
    scratch: ScratchDir,
    db: std::path::PathBuf,
    supervisor: WorkspaceSupervisor,
    actor: ActorHandle,
    state: YdocOpenState,
    input: Option<RecoveryImport>,
    /// The file just before the import runs.
    settled: Vec<u8>,
}

/// A rich note seeded from `seed` and settled, then warmed and settled again
/// after the checkpoint's base, with typing that never reached the engine.
async fn rich(seed: &str) -> Rich {
    let scratch = ScratchDir::new().unwrap();
    std::fs::write(scratch.path().join(NOTE), seed).unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    support::configure_witness_reader(&actor, &scratch).await;
    actor
        .capture_ingest(
            CaptureIngest {
                path: NOTE.into(),
                ..input(seed, 1)
            },
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture");
    let state = actor
        .ydoc_open_state(
            WS.into(),
            2,
            true,
            None,
            "main".into(),
            NOTE.into(),
            Some(ContentKind::Richdoc),
            CancellationToken::new(),
        )
        .await
        .expect("open");
    let doc = Ydoc::wire();
    doc.apply(&state.initial_update).unwrap();
    if let Some(seed) = &state.seed_content {
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, seed)
            .unwrap();
    }
    let full = doc.encode_full_state();
    record(&actor, &state, NOTE, ContentKind::Richdoc, full, "seed", 3).await;
    settle(
        &actor,
        scratch.path(),
        &state,
        NOTE,
        ContentKind::Richdoc,
        4,
    )
    .await;
    let at_base = disk(scratch.path(), NOTE);
    let update = doc.richdoc_append_paragraph("Warm.");
    record(
        &actor,
        &state,
        NOTE,
        ContentKind::Richdoc,
        update,
        "warm",
        5,
    )
    .await;
    let mut input = checkpoint_at(&state, NOTE, &doc, hex_sha256(&at_base));
    settle(
        &actor,
        scratch.path(),
        &state,
        NOTE,
        ContentKind::Richdoc,
        6,
    )
    .await;
    input.updates.push(typed(
        "outage-typing",
        doc.richdoc_append_paragraph("Typed after the quit."),
    ));
    input.text = doc.project(ContentKind::Richdoc).unwrap().content;
    let settled = disk(scratch.path(), NOTE);
    Rich {
        scratch,
        db,
        supervisor,
        actor,
        state,
        input: Some(input),
        settled,
    }
}

/// The typing stays recoverable in exactly one place: the note, History, or
/// the checkpoint main still holds. The import never writes the file.
async fn assert_typing_kept(
    rich: Rich,
    text: &str,
    outcome: Result<RecoveryImportOutcome, dohc_engine_runtime::RuntimeError>,
) -> &'static str {
    let Rich {
        scratch,
        db,
        supervisor,
        actor,
        state,
        settled,
        ..
    } = rich;
    let recoveries = actor.capture_recoveries(WS.into()).await.unwrap();
    let kept = match outcome {
        Ok(RecoveryImportOutcome::Replayed) => {
            assert!(recoveries.is_empty());
            "replayed"
        }
        Ok(RecoveryImportOutcome::Imported { moment_id }) => {
            let moment = actor
                .get_moment(WS.into(), moment_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(moment.before_text.as_deref(), Some(text));
            "imported"
        }
        Err(dohc_engine_runtime::RuntimeError::RecoveryImportRefused {
            reason: "acknowledged-state-missing",
        }) => {
            assert!(recoveries.is_empty());
            "refused"
        }
        other => panic!("typing must stay recoverable, got {other:?}"),
    };
    assert_eq!(disk(scratch.path(), NOTE), settled);
    supervisor.close(&db).unwrap();
    let projected = inspect(&db, |store| {
        store
            .read_with(|c| {
                let doc = dohc_engine_collab::load_doc_in(c, &state.key).unwrap();
                Ok::<_, StorageError>(doc.project(ContentKind::Richdoc).unwrap().content)
            })
            .unwrap()
    });
    assert_eq!(projected == text, kept == "replayed");
    assert_eq!(
        receipts(&db, "outage-typing"),
        i64::from(kept == "replayed")
    );
    kept
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_checkpoint_from_another_serializer_is_refused_and_kept() {
    // Text from a serializer that adds a second final newline can't be
    // replayed to exactly that text, so main keeps the checkpoint.
    let mut rich = rich("# Note\n\nAnchor.\n").await;
    rich.input.as_mut().unwrap().text.push('\n');
    let input = rich.input.take().unwrap();
    let text = input.text.clone();
    let outcome = import(&rich.actor, rich.scratch.path(), input).await;
    assert_eq!(assert_typing_kept(rich, &text, outcome).await, "refused");
}
