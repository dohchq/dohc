//! Sol's r2c rulings, item B4 and B5 and ruling 2: a held document's proof
//! runs off the actor, and the actor releases its answer only while what it
//! read still stands, comparing that with bounded reads.

use super::*;
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
struct Resume(HeldProofs);

impl Drop for Resume {
    fn drop(&mut self) {
        self.0.resume_proofs();
    }
}

type Answer = Result<Option<HeldDocumentInspection>, dohc_engine_runtime::RuntimeError>;

/// A read of the window document through the actor, whose proof holds at
/// its snapshot once this returns.
async fn paused_inspection(w: &RetainedWindow) -> (Resume, tokio::task::JoinHandle<Answer>) {
    let proofs = w.actor.held_proofs();
    proofs.pause_proofs();
    let resume = Resume(proofs.clone());
    let actor = w.actor.clone();
    let request = tokio::spawn(async move {
        actor
            .held_document("workspace".into(), "object".into())
            .await
    });
    proofs.paused_proof().await;
    (resume, request)
}

/// What the read answers once its proof goes on.
async fn released(
    resume: Resume,
    request: tokio::task::JoinHandle<Answer>,
) -> Option<HeldDocumentInspection> {
    drop(resume);
    request.await.unwrap().unwrap()
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
        assert_eq!(answer, proved, "{table}");
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
        let job = HeldProofs::default().job(store);
        dohc_engine_sync::prove_held_document(&job, "workspace", "object").unwrap()
    };
    let release = |store: &EngineStore, proof| {
        dohc_engine_sync::release_held_proof(store, proof)
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
    assert_eq!((moved.preservation, moved.contributions), (None, None));
    rename(WINDOW_PATH);

    let proof = prove(&w.store);
    w.store = EngineStore::open(&engine_db_path(&w.root).unwrap(), 0).unwrap();
    let reopened = release(&w.store, proof);
    assert_eq!(reopened.status, HeldBindingStatus::Stale, "a proof of an earlier open");
    assert_eq!(release(&w.store, prove(&w.store)), answer);
    desktop.close().await;
    w.close().await;
}
