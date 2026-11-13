//! A held document's proof runs off the actor, and the actor releases its
//! answer only while what it read still stands, comparing that with bounded
//! reads. Callers that ask the same share one proof; the last to leave stops
//! it, and so does closing the store, which waits for its reader.

use super::*;
use dohc_engine_runtime::RuntimeError;
use dohc_engine_sync::{HeldAnswer, HeldBindingStatus};
use std::time::Duration;

/// A writer connection of its own to the window's store, which waits on the
/// store's lock as long as the store's own connections do.
fn writer(w: &RetainedWindow) -> rusqlite::Connection {
    let raw = rusqlite::Connection::open(engine_db_path(&w.root).unwrap()).unwrap();
    raw.busy_timeout(Duration::from_millis(u64::from(
        dohc_engine_storage::ENGINE_SQLITE_BUSY_TIMEOUT_MS,
    )))
    .unwrap();
    raw
}

fn changed(w: &RetainedWindow, sql: &str) -> usize {
    let raw = writer(w);
    raw.execute_batch("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON")
        .unwrap();
    raw.execute(sql, []).unwrap()
}

/// Lets every proof of `0` go on when dropped, so a failing test never
/// leaves one held.
struct Resume(dohc_engine_sync::HeldProofs);

impl Drop for Resume {
    fn drop(&mut self) {
        self.0.resume_proofs();
    }
}

type Answer = Result<Option<HeldAnswer>, RuntimeError>;

fn inspection(w: &RetainedWindow, token: &CancellationToken) -> tokio::task::JoinHandle<Answer> {
    let (actor, token) = (w.actor.clone(), token.clone());
    tokio::spawn(async move {
        actor
            .held_document("workspace".into(), "object".into(), token)
            .await
    })
}

/// A read of the window document through the actor, whose proof holds at
/// its snapshot once this returns.
async fn paused_inspection(w: &RetainedWindow) -> (Resume, tokio::task::JoinHandle<Answer>) {
    let proofs = w.actor.held_proofs();
    proofs.pause_proofs();
    let resume = Resume(proofs.clone());
    let request = inspection(w, &CancellationToken::new());
    proofs.paused_proof().await;
    (resume, request)
}

async fn released(resume: Resume, request: tokio::task::JoinHandle<Answer>) -> Option<HeldAnswer> {
    drop(resume);
    request.await.unwrap().unwrap()
}

async fn answered(request: tokio::task::JoinHandle<Answer>) -> Answer {
    tokio::time::timeout(Duration::from_secs(30), request)
        .await
        .expect("the read answers")
        .unwrap()
}

async fn reached(what: &str, reached: impl std::future::Future<Output = ()>) {
    tokio::time::timeout(Duration::from_secs(30), reached)
        .await
        .unwrap_or_else(|_| panic!("{what}"));
}

/// While a proof holds at its snapshot, the actor answers other reads, and
/// the held read answers once the proof goes on.
#[tokio::test]
async fn the_actor_answers_other_work_while_a_held_proof_runs() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let (resume, request) = paused_inspection(&w).await;
    let page = tokio::time::timeout(
        Duration::from_secs(30),
        w.actor.held_documents("workspace".into(), None, 8),
    )
    .await
    .expect("the actor answers while the proof holds")
    .unwrap()
    .expect("a hosted replica");
    assert_eq!(page.documents.len(), 1);
    tokio::time::timeout(
        Duration::from_secs(30),
        w.actor.remote_changes_applied("workspace".into()),
    )
    .await
    .expect("the actor answers while the proof holds")
    .unwrap();
    assert!(!request.is_finished(), "the proof still holds");
    let answer = released(resume, request).await.expect("held");
    assert_eq!(answer.status, HeldBindingStatus::Current);
    assert!(answer.preservation.is_some() && answer.contributions.is_some());
    desktop.close().await;
    w.close().await;
}

type Change = fn(&RetainedWindow) -> usize;

type Prepare = fn(&mut RetainedWindow);

fn generation(w: &RetainedWindow) -> i64 {
    w.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT generation FROM released_tail_generations
                 WHERE workspace_id='workspace' AND version_id='main' AND object_id='object'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

const LATEST_SNAPSHOT: &str = "object_id='object' AND up_to_seq=
    (SELECT max(up_to_seq) FROM ydoc_snapshots WHERE object_id='object')";

/// Once anything the proof read moves after its snapshot, through another
/// writer connection, the answer is stale and carries no preservation,
/// projection or artifact, and nothing proves again. Each case changes one
/// input alone, and moves the document's released tail generation only when
/// that is the input: authorship a draft declares, a native update's author,
/// a seed's capture, the bytes a contribution names, the store's identity,
/// the hold's binding, path, continuation and stale flag, the document's
/// path, the restore generation or fence, the head's kind, last row and
/// compaction, the head's snapshot row or its bytes, a journal row past the
/// head or inside what it loads, or that row's bytes. So does state that
/// changes and changes back, a newer snapshot folding the inner row before
/// both go, the latest snapshot rebound around damage to its bytes, or
/// reseeded as it was; and so do the workspace's main version or the
/// workspace itself, either coordinate of the feed, and the scope generation
/// of the replica and its documents together. Moving the hold's reason, or
/// the replica's scope alone, leaves nothing held.
mod changed_proof {
    use super::*;

    fn drafted(w: &mut RetainedWindow) {
        outbox_only(w, "Drafted.");
        rebound(w);
    }
    fn latest_snapshot(w: &RetainedWindow, column: &str) -> String {
        w.store
            .read_with(|conn| {
                conn.query_row(
                    &format!("SELECT {column} FROM ydoc_snapshots WHERE {LATEST_SNAPSHOT}"),
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap()
    }
    async fn assert_stale(
        case: &str,
        retained: Retained,
        prepare: Option<Prepare>,
        change: Change,
        moves: bool,
    ) {
        let (mut w, desktop, _client) = held_for_a_queued_fold_of(retained).await;
        if let Some(prepare) = prepare {
            prepare(&mut w);
        }
        let before = inspected_window(&w.store);
        assert_eq!(
            before.status,
            HeldBindingStatus::Current,
            "{case}: current before"
        );
        let (resume, request) = paused_inspection(&w).await;
        let proved = generation(&w);
        assert!(change(&w) > 0, "{case}: the change wrote nothing");
        assert_eq!(
            generation(&w) > proved,
            moves,
            "{case}: whether the generation moved"
        );
        let answer = released(resume, request).await;
        if matches!(case, "hold reason" | "replica scope") {
            assert_eq!(answer, None, "{case}: nothing held");
        } else {
            let answer = answer.unwrap_or_else(|| panic!("{case}: still held"));
            assert_eq!(answer.status, HeldBindingStatus::Stale, "{case}");
            assert_eq!(answer.preservation, None, "{case}: no preservation");
            assert_eq!(answer.contributions, None, "{case}: no artifact");
        }
        desktop.close().await;
        w.close().await;
    }

    macro_rules! stale_case {
        ($name:ident, $case:literal, $retained:expr, $prepare:expr, $change:expr, $moves:expr $(,)?) => {
            #[tokio::test]
            async fn $name() {
                assert_stale($case, $retained, $prepare, $change, $moves).await;
            }
        };
    }

    stale_case!(
        change_contribution_bytes,
        "contribution bytes",
        Retained::Carried,
        Some(drafted),
        |w| {
            changed(
                w,
                "DELETE FROM binary_blobs WHERE sha256=
                   (SELECT update_digest FROM owner_ydoc_outbox_entries WHERE delivery_id='outbox-only')",
            )
        },
        true,
    );

    stale_case!(
        change_engine_identity,
        "engine identity",
        Retained::Carried,
        None,
        |w| {
            changed(
                w,
                "UPDATE engine_ownership SET engine_uuid='another-engine' WHERE rowid_guard=1",
            )
        },
        false,
    );

    stale_case!(
        change_hold_reason,
        "hold reason",
        Retained::Carried,
        None,
        |w| {
            changed(
                w,
                "UPDATE hosted_documents SET held_reason='hosted-backfill-work-waiting' WHERE object_id='object'",
            )
        },
        false,
    );

    stale_case!(
        change_head_snapshot_rebound_and_back,
        "head snapshot rebound and back",
        Retained::Carried,
        None,
        |w| {
            let original = latest_snapshot(w, "snapshot_blob_sha256");
            let rebind = |digest: &str| {
                format!(
                    "UPDATE ydoc_snapshots SET snapshot_blob_sha256='{digest}' WHERE {LATEST_SNAPSHOT}"
                )
            };
            changed(w, &rebind("e".repeat(64).as_str()))
                + changed(
                    w,
                    &format!(
                        "UPDATE binary_blobs SET bytes=X'00',byte_length=1 WHERE sha256='{original}'"
                    ),
                )
                + changed(w, &rebind(original.as_str()))
        },
        true,
    );

    stale_case!(
        change_workspace_main_version,
        "workspace main version",
        Retained::Carried,
        None,
        |w| {
            changed(
                w,
                "UPDATE versioned_workspaces SET main_version_id='elsewhere'
                 WHERE workspace_id='workspace'",
            )
        },
        false,
    );
}

/// A proof reads the state of the document its binding names, so a binding
/// stored on another document's row proves nothing of that row. The window's
/// hold copied, binding and digest as they were, onto a second document
/// answers stale there, while the window's own still answers current.
#[tokio::test]
async fn a_binding_naming_another_document_is_stale() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let window = inspected_window(&w.store);
    assert_eq!(window.status, HeldBindingStatus::Current);
    writer(&w)
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             CREATE TEMP TABLE kept AS SELECT * FROM hosted_documents WHERE object_id='object';
             UPDATE temp.kept SET object_id='other',path='notes/other.md';
             INSERT INTO hosted_documents SELECT * FROM temp.kept;",
        )
        .unwrap();
    let other = dohc_engine_sync::inspect_held_document(&w.store, "workspace", "other")
        .unwrap()
        .expect("the copy is held");
    assert_eq!(
        other.document.binding_digest,
        window.document.binding_digest
    );
    assert_eq!(other.status, HeldBindingStatus::Stale);
    assert_eq!((&other.preservation, &other.contributions), (&None, &None));
    assert_eq!(inspected_window(&w.store), window);
    desktop.close().await;
    w.close().await;
}

/// Callers that ask the same of the same state share one proof, which runs
/// once and answers each of them alike. One that leaves early takes only its
/// own wait with it.
#[tokio::test]
async fn identical_callers_share_one_proof_and_one_leaving_stops_only_its_wait() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let proofs = w.actor.held_proofs();
    let (resume, first) = paused_inspection(&w).await;
    let leaving = CancellationToken::new();
    let early = inspection(&w, &leaving);
    let last = inspection(&w, &CancellationToken::new());
    reached("three callers wait", proofs.callers("workspace", 3)).await;
    leaving.cancel();
    assert!(matches!(
        answered(early).await,
        Err(RuntimeError::Cancelled)
    ));
    assert_eq!(
        proofs.open_readers(),
        1,
        "the others still wait for the proof"
    );
    drop(resume);
    let first = answered(first).await.unwrap().expect("held");
    let last = answered(last).await.unwrap().expect("held");
    assert_eq!(first.status, HeldBindingStatus::Current);
    assert!(first.contributions.is_some());
    assert_eq!(first, last, "one result for both");
    assert_eq!(proofs.proofs_admitted(), 1, "the proof ran once");
    desktop.close().await;
    w.close().await;
}

/// A proof stops inside a statement once its last caller leaves: the
/// reader's progress handler interrupts a statement no proof could finish,
/// and the reader closes before the caller answers.
#[tokio::test]
async fn a_proof_stops_inside_a_statement_once_its_caller_leaves() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let proofs = w.actor.held_proofs();
    proofs.stall_next_proof();
    let token = CancellationToken::new();
    let request = inspection(&w, &token);
    reached("the proof runs its statement", proofs.stalled_proof()).await;
    token.cancel();
    assert!(matches!(
        answered(request).await,
        Err(RuntimeError::Cancelled)
    ));
    assert_eq!(proofs.open_readers(), 0, "its reader closed");
    let next = answered(inspection(&w, &CancellationToken::new())).await;
    assert_eq!(
        next.unwrap().expect("held").status,
        HeldBindingStatus::Current
    );
    desktop.close().await;
    w.close().await;
}

#[tokio::test]
async fn a_dead_actors_reader_keeps_its_store_fenced() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let proofs = w.actor.held_proofs();
    let resume = Resume(proofs.clone());
    proofs.set_close_bound(Duration::ZERO);
    proofs.pause_proofs_at(ProofStage::Validation);
    proofs.linger_stopped_proofs();
    let request = inspection(&w, &CancellationToken::new());
    reached("the proof validates", proofs.paused_proof()).await;
    let died = w.actor.on_connection(|_| panic!("the worker dies")).await;
    assert!(
        matches!(died, Err(RuntimeError::ActorUnavailable)),
        "{died:?}"
    );
    reached("the worker exits", w.actor.worker_exited()).await;
    let RetainedWindow {
        owner,
        supervisor,
        store,
        root,
        ..
    } = w;
    drop(store);
    let closed = owner.close().await;
    assert!(
        matches!(closed, Err(RuntimeError::ActorUnavailable)),
        "{closed:?}"
    );
    let db = engine_db_path(&root).unwrap();
    for what in ["evicting the dead actor", "while it drains"] {
        let refused = supervisor.open(&db, 2).map(drop);
        assert!(
            matches!(refused, Err(RuntimeError::StoreInUse)),
            "{what}: {refused:?}"
        );
        assert_eq!(supervisor.actor_count(), 0, "{what}: no successor started");
    }
    assert!(!proofs.drained(), "the reader is still open");
    drop(resume);
    let answered = answered(request).await;
    assert!(
        matches!(answered, Err(RuntimeError::ActorUnavailable)),
        "{answered:?}"
    );
    proofs.wait_for_drained();
    let reopened = supervisor.open(&db, 3).unwrap();
    assert!(reopened.created_actor, "the drained store opens again");
    drop(reopened);
    supervisor.close_all().unwrap();
    desktop.close().await;
}

/// A proof's reader still opening past the close bound keeps its store's
/// location once close failed, its caller was answered, and the actor and
/// every handle went. On Linux the reader opens by this process's descriptor
/// for the store's folder, so while a second workspace opens, that path
/// still names the first store, and the reader opens it once it goes on.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_reader_opening_past_the_close_bound_keeps_its_store() {
    use std::os::unix::fs::MetadataExt;
    let file = |path: &std::path::Path| {
        let found = std::fs::metadata(path).unwrap();
        (found.dev(), found.ino())
    };
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let proofs = w.actor.held_proofs();
    let resume = Resume(proofs.clone());
    proofs.set_close_bound(Duration::ZERO);
    proofs.pause_inside_reader_opens();
    let request = inspection(&w, &CancellationToken::new());
    let opening = proofs.clone();
    reached("the reader opens", async move {
        tokio::task::spawn_blocking(move || opening.wait_for_paused_inside_open())
            .await
            .unwrap();
    })
    .await;
    let location = std::sync::Arc::downgrade(&w.actor.location());
    let held = w.actor.database_path().to_path_buf();
    let RetainedWindow {
        owner,
        actor,
        supervisor,
        store,
        root,
        ..
    } = w;
    drop(store);
    owner.close().await.unwrap();
    let db = engine_db_path(&root).unwrap();
    let closed = supervisor.close_all();
    assert!(
        matches!(closed, Err(RuntimeError::StoreInUse)),
        "{closed:?}"
    );
    let answered = answered(request).await;
    assert!(
        matches!(answered, Err(RuntimeError::ActorUnavailable)),
        "{answered:?}"
    );
    drop(actor);
    assert!(
        location.upgrade().is_some(),
        "the reader let its store's folder go"
    );
    let other = ScratchDir::new().unwrap();
    let other_db = engine_db_path(&other).unwrap();
    let second = supervisor.open(&other_db, 2).unwrap();
    assert_ne!(file(&other_db), file(&db));
    assert_eq!(
        file(&held),
        file(&db),
        "the reader's path names the first store"
    );
    drop(resume);
    proofs.wait_for_drained();
    drop(second);
    supervisor.close_all().unwrap();
    desktop.close().await;
}

/// A proof held at its merge gives way when actor writes press the WAL.
/// Callers retry only storage FileLocked after checkpoint completion, within
/// the client's busy budget. A new proof is busy while the WAL presses; the
/// held proof answers busy and closes its reader. Further writes succeed
/// with the same bounded retries past the length the store refuses writes at
/// while a reader holds the WAL.
#[tokio::test]
async fn a_proof_gives_way_when_the_wal_presses_and_writes_keep_succeeding() {
    async fn write_with_checkpoint_retry(w: &RetainedWindow, sql: &'static str, budget: Duration) {
        tokio::time::timeout(budget, async {
            loop {
                let completed = w
                    .actor
                    .checkpoints_completed_for_test()
                    .await
                    .expect("read the checkpoint sequence");
                match w.actor.write_for_test(sql).await {
                    Ok(()) => return,
                    Err(RuntimeError::Storage(dohc_engine_storage::StorageError::FileLocked)) => {
                        w.actor
                            .wait_for_checkpoint_completion_for_test(completed)
                            .await
                            .expect("the checkpoint completes after write admission refuses");
                    }
                    Err(error) => panic!("write failed: {error:?}"),
                }
            }
        })
        .await
        .expect("write admission resumes within the client's busy budget");
    }

    let budget = client_busy_budget();
    const WRITE: &str = "INSERT INTO binary_blobs(sha256,byte_length,bytes)
        SELECT lower(hex(randomblob(32))),65536,randomblob(65536)";
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let proofs = w.actor.held_proofs();
    let resume = Resume(proofs.clone());
    proofs.pause_proofs_at(ProofStage::Merge);
    let request = inspection(&w, &CancellationToken::new());
    reached("the proof merges", proofs.paused_proof()).await;
    let mut writes = 0;
    while !proofs.wal_pressed("workspace") {
        assert!(writes < 1_000, "the WAL never pressed");
        write_with_checkpoint_retry(&w, WRITE, budget).await;
        writes += 1;
    }
    let refused = w
        .actor
        .held_document(
            "elsewhere".into(),
            "object".into(),
            CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(refused, Err(RuntimeError::HeldReadBusy)),
        "{refused:?}"
    );
    drop(resume);
    let gave_way = answered(request).await;
    assert!(
        matches!(gave_way, Err(RuntimeError::HeldReadBusy)),
        "{gave_way:?}"
    );
    assert_eq!(proofs.open_readers(), 0, "its reader closed");
    for _ in 0..2 * writes {
        write_with_checkpoint_retry(&w, WRITE, budget).await;
    }
    desktop.close().await;
    w.close().await;
}

/// A hold whose contribution artifact passes its cap still answers current,
/// with the preservation, Markdown included, it answers within the cap, and
/// names no artifact, which it says is too large. Only the artifact is
/// refused. Its merged list's commitment is the one the artifact within the
/// cap names.
#[tokio::test]
async fn an_artifact_past_its_cap_leaves_the_preservation_answering() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let within = answered(inspection(&w, &CancellationToken::new()))
        .await
        .unwrap()
        .expect("held");
    let Some(dohc_engine_sync::HeldContributions::Artifact(artifact)) = &within.contributions
    else {
        panic!("an artifact within its cap: {:?}", within.contributions)
    };
    let merged = artifact.merged.clone();
    w.actor.held_proofs().set_artifact_cap(1);
    let past = answered(inspection(&w, &CancellationToken::new()))
        .await
        .unwrap()
        .expect("held");
    assert_eq!(past.status, HeldBindingStatus::Current);
    assert!(past.preservation.is_some());
    assert_eq!(
        past.preservation, within.preservation,
        "the preservation, Markdown included"
    );
    assert_eq!(
        past.contributions,
        Some(dohc_engine_sync::HeldContributions::TooLarge { merged })
    );
    desktop.close().await;
    w.close().await;
}
