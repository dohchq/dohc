//! Sol's r2c rulings, items B4, B5 and B6 and ruling 2: a held document's
//! proof runs off the actor, and the actor releases its answer only while
//! what it read still stands, comparing that with bounded reads. Callers
//! that ask the same share one proof; the last to leave stops it, and so
//! does closing the store, which waits for its reader.

use super::*;
use dohc_engine_runtime::RuntimeError;
use dohc_engine_sync::{HeldBindingStatus, HeldDocumentInspection};
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use std::sync::Mutex;
use std::time::Duration;

/// Run `sql` through a writer connection of its own, past the store's
/// checks, and answer how many rows it changed.
fn changed(w: &RetainedWindow, sql: &str) -> usize {
    let raw = rusqlite::Connection::open(engine_db_path(&w.root).unwrap()).unwrap();
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

type Answer = Result<Option<Arc<HeldDocumentInspection>>, RuntimeError>;

/// A read of the window document through the actor, until `token`.
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

/// What the read answers once its proof goes on.
async fn released(
    resume: Resume,
    request: tokio::task::JoinHandle<Answer>,
) -> Option<Arc<HeldDocumentInspection>> {
    drop(resume);
    request.await.unwrap().unwrap()
}

/// What `request` answers, which it must within 30 seconds.
async fn answered(request: tokio::task::JoinHandle<Answer>) -> Answer {
    tokio::time::timeout(Duration::from_secs(30), request)
        .await
        .expect("the read answers")
        .unwrap()
}

/// Completes once `reached` does, which it must within 30 seconds.
async fn reached(what: &str, reached: impl std::future::Future<Output = ()>) {
    tokio::time::timeout(Duration::from_secs(30), reached)
        .await
        .unwrap_or_else(|_| panic!("{what}"));
}

/// Ruling B, item 4: while a proof holds at its snapshot, the actor answers
/// other reads, and the held read answers once the proof goes on.
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

/// What one case changes, through another writer, while the proof holds at
/// its snapshot; it answers how many rows changed.
type Change = fn(&RetainedWindow) -> usize;

/// Ruling B, item 5, and ruling 2: once anything the proof read moves after
/// its snapshot, through another writer connection, the answer is stale and
/// carries no preservation, projection or artifact, and nothing proves
/// again. Each case changes one input alone: authorship a draft declares,
/// a native update's author, a seed's capture, the bytes a contribution
/// names, the hold, the path, the restore generation or fence, the
/// lineage's head, the workspace's main version or the workspace itself,
/// the feed, or the replica's scope, which leaves nothing held.
#[tokio::test]
async fn an_answer_whose_proof_inputs_moved_is_stale_and_keeps_nothing() {
    /// A restore of the document from generation 0 to 1: resumed, or still
    /// fencing it.
    fn fence(w: &RetainedWindow, resumed: bool) -> usize {
        let resume = if resumed {
            format!("'{{}}','{{}}','{{}}','restore-delivery','{{}}','settlement','{}'", "a".repeat(64))
        } else {
            "NULL,NULL,NULL,NULL,NULL,NULL,NULL".to_owned()
        };
        changed(
            w,
            &format!(
                "INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,
                   relay_database_namespace,operation_id,input_json,receipt_json,proposal_json,
                   application_json,application_delivery_id,resume_receipt_json,resume_settlement_id,
                   resume_evidence_digest)
                 VALUES ('workspace','main','object','relay','restore',
                   json_object('oldBinding',json_object('lineageClaimId','{}','restoreFenceGeneration',0),
                     'newFence',1),
                   '{{}}',{resume})",
                w.lineage
            ),
        )
    }
    // Each case: its name, the work the window retains, whether a draft only
    // the outbox holds joins it, and the change.
    let cases: [(&str, Retained, bool, Change); 14] = [
        ("draft authorship", Retained::Carried, true, |w| {
            changed(
                w,
                "UPDATE owner_ydoc_outbox_entries SET person_edit=1-COALESCE(person_edit,0)
                 WHERE delivery_id='outbox-only'",
            )
        }),
        ("native author", Retained::Carried, false, |w| {
            changed(
                w,
                &format!(
                    "UPDATE ydoc_updates SET actor_origin_id='another-device'
                     WHERE workspace_id='workspace' AND version_id='main' AND object_id='object'
                       AND seq IN (SELECT json_extract(native_source_json,'$.nativeSequence')
                         FROM owner_ydoc_outbox_entries WHERE update_digest='{}')",
                    w.retained_digest
                ),
            )
        }),
        ("seed capture", Retained::Seed, false, |w| {
            changed(
                w,
                "UPDATE ydoc_owner_activation_sources SET source_moment_id=source_moment_id||'-moved'
                 WHERE object_id='object'",
            )
        }),
        ("contribution bytes", Retained::Carried, true, |w| {
            changed(
                w,
                "DELETE FROM binary_blobs WHERE sha256=
                   (SELECT update_digest FROM owner_ydoc_outbox_entries WHERE delivery_id='outbox-only')",
            )
        }),
        ("hold continuation", Retained::Carried, false, |w| {
            changed(
                w,
                "UPDATE hosted_documents SET released_hold_continuation='dependency-drain'
                 WHERE object_id='object'",
            )
        }),
        ("hold stale flag", Retained::Carried, false, |w| {
            changed(
                w,
                "UPDATE hosted_documents SET released_hold_binding_stale=1 WHERE object_id='object'",
            )
        }),
        ("path", Retained::Carried, false, |w| {
            changed(
                w,
                "UPDATE path_aliases SET path='notes/renamed.md' WHERE object_id='object'",
            )
        }),
        ("restore generation", Retained::Carried, false, |w| fence(w, true)),
        ("restore fence", Retained::Carried, false, |w| fence(w, false)),
        ("lineage head", Retained::Carried, false, |w| {
            changed(
                w,
                "UPDATE ydoc_docs SET head_update_seq=head_update_seq+1 WHERE object_id='object'",
            )
        }),
        ("workspace main version", Retained::Carried, false, |w| {
            changed(
                w,
                "UPDATE versioned_workspaces SET main_version_id='elsewhere'
                 WHERE workspace_id='workspace'",
            )
        }),
        ("workspace removed", Retained::Carried, false, |w| {
            changed(
                w,
                "DELETE FROM versioned_workspaces WHERE workspace_id='workspace'",
            )
        }),
        ("feed", Retained::Carried, false, |w| {
            changed(
                w,
                "UPDATE sync_identity SET stream_identity='moved' WHERE workspace_id='workspace'",
            )
        }),
        ("replica scope", Retained::Carried, false, |w| {
            changed(
                w,
                "UPDATE hosted_replicas SET scope_generation=scope_generation+1
                 WHERE workspace_id='workspace'",
            )
        }),
    ];
    for (case, retained, draft, change) in cases {
        let (mut w, desktop, _client) = held_for_a_queued_fold_of(retained).await;
        if draft {
            outbox_only(&mut w, "Drafted.", Stored::TheUpdate);
            rebound(&mut w);
        }
        let before = inspected_window(&w.store);
        assert_eq!(before.status, HeldBindingStatus::Current, "{case}: current before");
        let (resume, request) = paused_inspection(&w).await;
        assert!(change(&w) > 0, "{case}: the change wrote nothing");
        match released(resume, request).await {
            None => assert_eq!(case, "replica scope", "{case}: still held"),
            Some(answer) => {
                assert_eq!(answer.status, HeldBindingStatus::Stale, "{case}");
                assert_eq!(answer.preservation, None, "{case}: no preservation");
                assert_eq!(answer.contributions, None, "{case}: no artifact");
            }
        }
        desktop.close().await;
        w.close().await;
    }
}

/// Ruling 2: the retirement, binding and accepted checkpoint tables are not
/// what the held proof reads. A write to any one of them alone, while the
/// proof holds at its snapshot, leaves the answer exactly as proved.
#[tokio::test]
async fn writes_the_proof_never_reads_leave_its_answer_current() {
    let cases: [(&str, Change); 3] = [
        ("live_owner_retirements", |w| {
            changed(
                w,
                &format!(
                    "INSERT INTO live_owner_retirements (relay_database_namespace,activation_id,workspace_id,
                       main_version_id,object_id,lineage_claim_id,restore_fence_generation)
                     VALUES ('relay','unrelated-activation','workspace','main','object','{}',0)",
                    w.lineage
                ),
            )
        }),
        ("live_device_application_bindings", |w| {
            changed(
                w,
                &format!(
                    "INSERT INTO live_device_application_bindings (relay_database_namespace,workspace_id,
                       main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,
                       restore_fence_generation,host_id,host_epoch,instance_id,connection_id,available)
                     VALUES ('unrelated','workspace','main','object','{}','{}','[]',0,'host',1,'instance',
                       'connection',0)",
                    w.lineage, WINDOW_PATH
                ),
            )
        }),
        ("live_accepted_checkpoints", |w| {
            changed(
                w,
                &format!(
                    "INSERT INTO live_accepted_checkpoints (relay_database_namespace,workspace_id,main_version_id,
                       object_id,lineage_claim_id,event_count,journal_cursor,terminal_json,binding_json,
                       origin_stamp,state_sha256,evidence_digest)
                     VALUES ('relay','workspace','main','object','{}',999,999,'{{}}','{{}}','{}','{}','{}')",
                    w.lineage,
                    "a".repeat(64),
                    w.lineage,
                    "b".repeat(64)
                ),
            )
        }),
    ];
    for (table, change) in cases {
        let (w, desktop, _client) = held_for_a_queued_fold().await;
        let proved = inspected_window(&w.store);
        assert_eq!(proved.status, HeldBindingStatus::Current, "{table}");
        let (resume, request) = paused_inspection(&w).await;
        assert!(change(&w) > 0, "{table}: the change wrote nothing");
        let answer = released(resume, request).await.expect("held");
        assert_eq!(*answer, proved, "{table}");
        desktop.close().await;
        w.close().await;
    }
}

/// Every statement the store's connection ran while a proof was released.
static RELEASING: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn releasing(event: TraceEvent<'_>) {
    if let TraceEvent::Stmt(_, text) = event {
        RELEASING.lock().unwrap().push(text.to_owned());
    }
}

/// Ruling B, item 5: releasing a proof on the store's writer reads by key
/// alone: none of the tables the proof enumerates, replays or loads bytes
/// from, and a handful of statements however much the hold covers. A change
/// another writer connection makes between the proof and its release, and a
/// proof of an earlier open of the store, release as stale.
#[tokio::test]
async fn the_writer_releases_a_proof_with_bounded_reads_alone() {
    let (mut w, desktop, _client) = held_for_a_queued_fold().await;
    outbox_only(&mut w, "Drafted.", Stored::TheUpdate);
    rebound(&mut w);
    let prove = |store: &EngineStore| {
        dohc_engine_sync::prove_held_document(&HeldProofJob::of(store), "workspace", "object")
            .unwrap()
    };
    let release = |store: &EngineStore, proof: dohc_engine_sync::HeldProof| {
        dohc_engine_sync::release_held_proof(store, &proof)
            .unwrap()
            .expect("held")
    };
    let trace = |store: &EngineStore, on: bool| {
        store
            .read_with(|conn| {
                if on {
                    conn.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(releasing));
                } else {
                    conn.trace_v2(TraceEventCodes::empty(), None);
                }
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
    };

    let proof = prove(&w.store);
    RELEASING.lock().unwrap().clear();
    trace(&w.store, true);
    let answer = release(&w.store, proof);
    trace(&w.store, false);
    assert_eq!(answer.status, HeldBindingStatus::Current);
    assert!(answer.contributions.is_some());
    let statements = std::mem::take(&mut *RELEASING.lock().unwrap());
    for table in [
        "owner_ydoc_outbox_entries",
        "owner_ydoc_outboxes",
        "ydoc_updates",
        "ydoc_snapshots",
        "binary_blobs",
        "live_owner_activations",
        "live_accepted_updates",
        "live_device_update_applications",
        "ydoc_owner_activation_sources",
    ] {
        assert!(
            !statements.iter().any(|statement| statement.contains(table)),
            "{table}: {statements:#?}"
        );
    }
    assert!(statements.len() <= 20, "{statements:#?}");

    let rename = |path: &str| {
        let sql = format!("UPDATE path_aliases SET path='{path}' WHERE object_id='object'");
        assert_eq!(changed(&w, &sql), 1);
    };
    let proof = prove(&w.store);
    rename("notes/renamed.md");
    let moved = release(&w.store, proof);
    assert_eq!(moved.status, HeldBindingStatus::Stale);
    assert_eq!((&moved.preservation, &moved.contributions), (&None, &None));
    rename(WINDOW_PATH);

    let proof = prove(&w.store);
    w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
    let reopened = release(&w.store, proof);
    assert_eq!(reopened.status, HeldBindingStatus::Stale, "a proof of an earlier open");
    assert_eq!(release(&w.store, prove(&w.store)), answer);
    desktop.close().await;
    w.close().await;
}

/// Ruling B, item 6: callers that ask the same of the same state share one
/// proof, which runs once and answers each of them alike. One that leaves
/// early takes only its own wait with it.
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
    assert!(matches!(answered(early).await, Err(RuntimeError::Cancelled)));
    assert_eq!(proofs.running_proofs(), 1, "the others still wait for the proof");
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

/// Ruling B, item 6: the last caller to leave stops the proof it waited for,
/// wherever the proof is. Held at each stage in turn, the proof passes no
/// further check once its caller leaves, and its reader closes before that
/// caller answers; the workspace then takes the next proof.
#[tokio::test]
async fn the_last_caller_leaving_stops_a_running_proof() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let proofs = w.actor.held_proofs();
    let resume = Resume(proofs.clone());
    let stages = [
        ProofStage::Replay,
        ProofStage::Validation,
        ProofStage::Merge,
        ProofStage::Encoding,
    ];
    for stage in stages {
        proofs.pause_proofs_at(stage);
        let token = CancellationToken::new();
        let request = inspection(&w, &token);
        reached(&format!("{stage:?}: the proof holds there"), proofs.paused_proof()).await;
        let passed = proofs.checks_passed();
        token.cancel();
        let left = answered(request).await;
        assert!(matches!(left, Err(RuntimeError::Cancelled)), "{stage:?}: {left:?}");
        assert_eq!(proofs.running_proofs(), 0, "{stage:?}: its reader closed first");
        assert_eq!(proofs.checks_passed(), passed, "{stage:?}: it went no further");
        proofs.resume_proofs();
        let next = answered(inspection(&w, &CancellationToken::new())).await;
        assert_eq!(next.unwrap().expect("held").status, HeldBindingStatus::Current, "{stage:?}");
    }
    assert_eq!(proofs.proofs_admitted(), 2 * stages.len() as u64);
    drop(resume);
    desktop.close().await;
    w.close().await;
}

/// Ruling B, item 6: a proof stops inside a statement once its last caller
/// leaves: the reader's progress handler interrupts a statement no proof
/// could finish, and the reader closes before the caller answers.
#[tokio::test]
async fn a_proof_stops_inside_a_statement_once_its_caller_leaves() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let proofs = w.actor.held_proofs();
    proofs.stall_next_proof();
    let token = CancellationToken::new();
    let request = inspection(&w, &token);
    reached("the proof runs its statement", proofs.stalled_proof()).await;
    token.cancel();
    assert!(matches!(answered(request).await, Err(RuntimeError::Cancelled)));
    assert_eq!(proofs.running_proofs(), 0, "its reader closed");
    let next = answered(inspection(&w, &CancellationToken::new())).await;
    assert_eq!(next.unwrap().expect("held").status, HeldBindingStatus::Current);
    desktop.close().await;
    w.close().await;
}

/// Ruling B, items 6 and 7: while a proof runs, a request for its workspace
/// beyond the callers one proof answers, or asking anything else, here the
/// same document once its path moved, is refused as busy at once, never
/// queued. Once the proof ends, the workspace proves again.
#[tokio::test]
async fn a_different_request_for_a_workspace_with_a_running_proof_is_busy() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let proofs = w.actor.held_proofs();
    let (resume, first) = paused_inspection(&w).await;
    let mut callers = vec![first];
    for _ in 1..MAX_PROOF_WAITERS {
        callers.push(inspection(&w, &CancellationToken::new()));
    }
    reached("every caller joined", proofs.callers("workspace", MAX_PROOF_WAITERS)).await;
    let refuse = || {
        tokio::time::timeout(
            Duration::from_secs(30),
            w.actor
                .held_document("workspace".into(), "object".into(), CancellationToken::new()),
        )
    };
    let full = refuse().await.expect("refused at once");
    assert!(matches!(full, Err(RuntimeError::HeldReadBusy)), "{full:?}");
    let sql = "UPDATE path_aliases SET path='notes/renamed.md' WHERE object_id='object'";
    assert_eq!(changed(&w, sql), 1);
    let other = refuse().await.expect("refused at once");
    assert!(matches!(other, Err(RuntimeError::HeldReadBusy)), "{other:?}");
    drop(resume);
    for caller in callers {
        let answer = answered(caller).await.unwrap().expect("held");
        assert_eq!(answer.status, HeldBindingStatus::Stale, "its path moved");
    }
    assert!(matches!(answered(inspection(&w, &CancellationToken::new())).await, Ok(Some(_))));
    assert_eq!(proofs.proofs_admitted(), 2);
    desktop.close().await;
    w.close().await;
}

/// Ruling B, item 6, and r2c-3c-1's open item: closing the store during a
/// proof stops it and returns only once its reader closed, so the store's
/// files can be replaced, and the proof's caller answers that the workspace
/// is gone. The stopped proof keeps its reader open until close waits for it.
#[tokio::test]
async fn closing_the_store_stops_a_running_proof_and_waits_for_its_reader() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let proofs = w.actor.held_proofs();
    let resume = Resume(proofs.clone());
    proofs.pause_proofs_at(ProofStage::Validation);
    proofs.linger_stopped_proofs();
    let request = inspection(&w, &CancellationToken::new());
    reached("the proof validates", proofs.paused_proof()).await;
    let releasing = proofs.clone();
    let release = std::thread::spawn(move || {
        releasing.wait_for_closing();
        releasing.resume_proofs();
    });
    w.close().await;
    assert_eq!(proofs.running_proofs(), 0, "close returned after the reader closed");
    release.join().unwrap();
    let closed = answered(request).await;
    assert!(matches!(closed, Err(RuntimeError::ActorUnavailable)), "{closed:?}");
    drop(resume);
    desktop.close().await;
}
