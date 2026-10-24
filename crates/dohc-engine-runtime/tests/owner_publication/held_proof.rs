//! Sol's r2c rulings, items B4, B5 and B6 and ruling 2: a held document's
//! proof runs off the actor, and the actor releases its answer only while
//! what it read still stands, comparing that with bounded reads. Callers
//! that ask the same share one proof; the last to leave stops it, and so
//! does closing the store, which waits for its reader.

use super::*;
use dohc_engine_runtime::RuntimeError;
use dohc_engine_sync::{HeldAnswer, HeldBindingStatus};
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use std::sync::Mutex;
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

/// Run `sql` through a writer connection of its own, past the store's
/// checks, and answer how many rows it changed.
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
async fn released(resume: Resume, request: tokio::task::JoinHandle<Answer>) -> Option<HeldAnswer> {
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

/// What one case writes before its proof, whose answer must still be current.
type Prepare = fn(&mut RetainedWindow);

/// The window document's released tail generation.
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

/// An update that changes nothing.
const EMPTY_UPDATE: &[u8] = &[0, 0];

/// The window document's journal row below its last, as `sql` names it.
const INNER_ROW: &str = "object_id='object' AND seq=
    (SELECT head_update_seq-1 FROM ydoc_docs WHERE object_id='object')";

/// The window document's latest snapshot, as `sql` names it.
const LATEST_SNAPSHOT: &str = "object_id='object' AND up_to_seq=
    (SELECT max(up_to_seq) FROM ydoc_snapshots WHERE object_id='object')";

/// The columns of a snapshot row, in the order `sql` inserts them.
const SNAPSHOT_COLUMNS: &str = "workspace_id,version_id,object_id,up_to_seq,snapshot_blob_sha256,\
    state_vector_blob_sha256,recorded_at_ms";

/// Run `sql` through a writer connection of its own with foreign keys on.
fn changed_with_keys(w: &RetainedWindow, sql: &str) -> usize {
    let raw = writer(w);
    raw.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    raw.execute(sql, []).unwrap()
}

/// Append, past the store's checks, two updates that change nothing to the
/// window document's journal, so the head has a row inside the journal its
/// state loads from, and derive the hold again: the head's state, and so its
/// binding, stay as they were.
fn empty_appends(w: &mut RetainedWindow) {
    let empty = hex_sha256(EMPTY_UPDATE);
    changed(
        w,
        &format!("INSERT OR IGNORE INTO binary_blobs VALUES ('{empty}',2,X'0000')"),
    );
    for _ in 0..2 {
        let appended = changed(
            w,
            &format!(
                "INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms)
                 SELECT workspace_id,version_id,object_id,head_update_seq+1,'{empty}',0 FROM ydoc_docs
                 WHERE object_id='object'"
            ),
        );
        assert_eq!(appended, 1);
        changed(
            w,
            "UPDATE ydoc_docs SET head_update_seq=head_update_seq+1 WHERE object_id='object'",
        );
    }
    rebound(w);
}

/// Ruling B, item 5, ruling 2, and Sol's r2c-3c-1 findings 1 and 3: once
/// anything the proof read moves after its snapshot, through another writer
/// connection, the answer is stale and carries no preservation, projection
/// or artifact, and nothing proves again. Each case changes one input alone,
/// and moves the document's released tail generation only when that is the
/// input: authorship a draft declares, a native update's author, a seed's
/// capture, the bytes a contribution names, the store's identity, the hold's
/// binding, path, continuation and stale flag, the document's path, the
/// restore generation or fence, the head's kind, last row and compaction,
/// the head's snapshot row or its bytes, a journal row past the head or
/// inside what it loads, or that row's bytes. Sol's r2c-3c-3 finding 2 and
/// Opus's finding 1: so does state that changes and changes back, a newer
/// snapshot folding the inner row before both go, the latest snapshot
/// rebound around damage to its bytes, or reseeded as it was; and so do the
/// workspace's main version or the workspace itself, either coordinate of
/// the feed, and the scope generation of the replica and its documents
/// together. Moving the hold's reason, or the replica's scope alone, leaves
/// nothing held.
#[tokio::test]
async fn an_answer_whose_proof_inputs_moved_is_stale_and_keeps_nothing() {
    /// A restore of the document from generation 0 to 1: resumed, or still
    /// fencing it.
    fn fence(w: &RetainedWindow, resumed: bool) -> usize {
        let resume = if resumed {
            format!(
                "'{{}}','{{}}','restore-delivery','{{}}','settlement','{}'",
                "a".repeat(64)
            )
        } else {
            "NULL,NULL,NULL,NULL,NULL,NULL".to_owned()
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
    fn drafted(w: &mut RetainedWindow) {
        outbox_only(w, "Drafted.", Stored::TheUpdate);
        rebound(w);
    }
    /// The empty appends, the inner one gone again.
    fn one_missing(w: &mut RetainedWindow) {
        empty_appends(w);
        assert_eq!(
            changed(w, &format!("DELETE FROM ydoc_updates WHERE {INNER_ROW}")),
            1
        );
    }
    /// What the latest snapshot's `column` holds.
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
    /// Sol's r2c-3c-3 finding 2: a snapshot covering the head folds the
    /// inner row, which then goes, and the snapshot with it, so the latest
    /// snapshot, last row and head read as proved.
    fn folded_then_removed(w: &RetainedWindow) -> usize {
        let head = "(SELECT head_update_seq FROM ydoc_docs WHERE object_id='object')";
        changed(
            w,
            &format!(
                "INSERT INTO ydoc_snapshots({SNAPSHOT_COLUMNS})
                 SELECT workspace_id,version_id,object_id,{head},snapshot_blob_sha256,state_vector_blob_sha256,0
                 FROM ydoc_snapshots WHERE {LATEST_SNAPSHOT}"
            ),
        ) + changed(w, &format!("DELETE FROM ydoc_updates WHERE {INNER_ROW}"))
            + changed(
                w,
                &format!("DELETE FROM ydoc_snapshots WHERE object_id='object' AND up_to_seq={head}"),
            )
    }
    // Each case: its name, the work the window retains, what it writes
    // before the proof, the change, and whether that moves the generation.
    let cases: [(&str, Retained, Option<Prepare>, Change, bool); 33] = [
        (
            "draft authorship",
            Retained::Carried,
            Some(drafted),
            |w| {
                changed(
                    w,
                    "UPDATE owner_ydoc_outbox_entries SET person_edit=1-COALESCE(person_edit,0)
                 WHERE delivery_id='outbox-only'",
                )
            },
            true,
        ),
        (
            "native author",
            Retained::Carried,
            None,
            |w| {
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
            },
            true,
        ),
        (
            "seed capture",
            Retained::Seed,
            None,
            |w| {
                changed(
                w,
                "UPDATE ydoc_owner_activation_sources SET source_moment_id=source_moment_id||'-moved'
                 WHERE object_id='object'",
            )
            },
            true,
        ),
        (
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
        ),
        (
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
        ),
        (
            "hold binding",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    &format!(
                        "UPDATE hosted_documents SET released_hold_binding_digest='{}' WHERE object_id='object'",
                        "f".repeat(64)
                    ),
                )
            },
            false,
        ),
        (
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
        ),
        (
            "hold path",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    "UPDATE hosted_documents SET path='notes/elsewhere.md' WHERE object_id='object'",
                )
            },
            false,
        ),
        (
            "hold continuation",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    "UPDATE hosted_documents SET released_hold_continuation='dependency-drain'
                 WHERE object_id='object'",
                )
            },
            false,
        ),
        (
            "hold stale flag",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    "UPDATE hosted_documents SET released_hold_binding_stale=1 WHERE object_id='object'",
                )
            },
            false,
        ),
        (
            "path",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    "UPDATE path_aliases SET path='notes/renamed.md' WHERE object_id='object'",
                )
            },
            false,
        ),
        (
            "restore generation",
            Retained::Carried,
            None,
            |w| fence(w, true),
            false,
        ),
        (
            "restore fence",
            Retained::Carried,
            None,
            |w| fence(w, false),
            false,
        ),
        (
            "lineage head",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    "UPDATE ydoc_docs SET head_update_seq=head_update_seq+1 WHERE object_id='object'",
                )
            },
            false,
        ),
        (
            "head kind",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    "UPDATE ydoc_docs SET content_kind='plaintext' WHERE object_id='object'",
                )
            },
            false,
        ),
        // One below the compaction point, which no entry names.
        (
            "head compaction",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    "UPDATE ydoc_docs SET head_snapshot_seq=head_snapshot_seq-1 WHERE object_id='object'",
                )
            },
            false,
        ),
        // Only the proof's own read of the latest snapshot sees this.
        (
            "head snapshot added",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    &format!(
                        "INSERT INTO ydoc_snapshots({SNAPSHOT_COLUMNS})
                     SELECT workspace_id,version_id,object_id,up_to_seq+1,snapshot_blob_sha256,
                       state_vector_blob_sha256,0
                     FROM ydoc_snapshots WHERE {LATEST_SNAPSHOT}"
                    ),
                )
            },
            false,
        ),
        (
            "head snapshot replaced",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    &format!(
                        "UPDATE ydoc_snapshots SET snapshot_blob_sha256='{}' WHERE {LATEST_SNAPSHOT}",
                        "e".repeat(64)
                    ),
                )
            },
            true,
        ),
        // Sol's r2c-3c-3 finding 2: rebound, its bytes damaged while nothing
        // names them, and rebound back.
        (
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
        ),
        (
            "folded, then the snapshot removed",
            Retained::Carried,
            Some(empty_appends),
            folded_then_removed,
            true,
        ),
        // Opus's r2c-3c-3 finding 1: the latest snapshot removed and
        // reseeded to identical coordinates.
        (
            "head snapshot reseeded",
            Retained::Carried,
            None,
            |w| {
                let row = latest_snapshot(
                    w,
                    "printf('(%Q,%Q,%Q,%d,%Q,%Q,%d)',workspace_id,version_id,object_id,up_to_seq,
                   snapshot_blob_sha256,state_vector_blob_sha256,recorded_at_ms)",
                );
                changed(
                    w,
                    &format!("DELETE FROM ydoc_snapshots WHERE {LATEST_SNAPSHOT}"),
                ) + changed(
                    w,
                    &format!("INSERT INTO ydoc_snapshots({SNAPSHOT_COLUMNS}) VALUES {row}"),
                )
            },
            true,
        ),
        (
            "head snapshot bytes",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    "UPDATE binary_blobs SET bytes=X'00',byte_length=1 WHERE sha256=
                   (SELECT snapshot_blob_sha256 FROM ydoc_snapshots WHERE object_id='object'
                    ORDER BY up_to_seq DESC LIMIT 1)",
                )
            },
            true,
        ),
        // A row past the head, which the head's coordinates do not name but
        // its state loads.
        (
            "journal row past the head",
            Retained::Carried,
            None,
            |w| {
                changed(
                w,
                &format!(
                    "INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms)
                     SELECT workspace_id,version_id,object_id,head_update_seq+1,'{}',0 FROM ydoc_docs
                     WHERE object_id='object'",
                    hex_sha256(EMPTY_UPDATE)
                ),
            )
            },
            false,
        ),
        (
            "journal row removed",
            Retained::Carried,
            Some(empty_appends),
            |w| changed(w, &format!("DELETE FROM ydoc_updates WHERE {INNER_ROW}")),
            true,
        ),
        (
            "journal row rewritten",
            Retained::Carried,
            Some(empty_appends),
            |w| {
                changed(
                    w,
                    &format!(
                        "UPDATE ydoc_updates SET update_blob_sha256='{}' WHERE {INNER_ROW}",
                        "d".repeat(64)
                    ),
                )
            },
            true,
        ),
        (
            "journal row restored",
            Retained::Carried,
            Some(one_missing),
            |w| {
                changed(
                w,
                &format!(
                    "INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms)
                     SELECT workspace_id,version_id,object_id,head_update_seq-1,'{}',0 FROM ydoc_docs
                     WHERE object_id='object'",
                    hex_sha256(EMPTY_UPDATE)
                ),
            )
            },
            true,
        ),
        (
            "journal row bytes",
            Retained::Carried,
            Some(empty_appends),
            |w| {
                changed(
                    w,
                    &format!(
                        "UPDATE binary_blobs SET bytes=X'01',byte_length=1 WHERE sha256='{}'",
                        hex_sha256(EMPTY_UPDATE)
                    ),
                )
            },
            true,
        ),
        (
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
        ),
        (
            "workspace removed",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    "DELETE FROM versioned_workspaces WHERE workspace_id='workspace'",
                )
            },
            false,
        ),
        (
            "feed stream",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    "UPDATE sync_identity SET stream_identity='moved' WHERE workspace_id='workspace'",
                )
            },
            false,
        ),
        (
            "feed epoch",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    "UPDATE sync_identity SET replication_epoch='moved' WHERE workspace_id='workspace'",
                )
            },
            false,
        ),
        // The replica and its documents move scope together, so the hold
        // reads as it did, but in another scope.
        (
            "scope generation",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    "UPDATE hosted_replicas SET scope_generation=scope_generation+1
                 WHERE workspace_id='workspace'",
                ) + changed(
                    w,
                    "UPDATE hosted_documents SET scope_generation=scope_generation+1
                 WHERE workspace_id='workspace'",
                )
            },
            false,
        ),
        (
            "replica scope",
            Retained::Carried,
            None,
            |w| {
                changed(
                    w,
                    "UPDATE hosted_replicas SET scope_generation=scope_generation+1
                 WHERE workspace_id='workspace'",
                )
            },
            false,
        ),
    ];
    for (case, retained, prepare, change, moves) in cases {
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
}

/// Sol's r2c-3c-1 findings 1 and 3, on the archived-hold fixture: an
/// archived hold's answer stands only while its archive does. The archive's
/// digest or kind moving, its bytes damaged, or bytes the proof found damaged
/// repaired, while the proof holds at its snapshot, each make it stale. Sol's
/// r2c-3c-3 findings 1 and 2: so do an archive the proof found missing
/// restored, with foreign keys on, and its digest rebound around damage to
/// its bytes and back. All but the kind move the generation.
#[tokio::test]
async fn an_archived_answer_whose_archive_moved_is_stale() {
    for case in [
        "archive digest",
        "archive kind",
        "archive damaged",
        "archive repaired",
        "archive restored",
        "archive rebound and back",
    ] {
        let (mut w, desktop, client, queued, archive) = archived_window(2).await;
        let first = committed_pass(&mut w.store, &client);
        assert!(
            holds_archived(first.held.get("object"), &w.lineage, &archive, &queued[0]),
            "{case}: {first:?}"
        );
        let bytes = w.store.get_binary_blob(&archive).unwrap().unwrap();
        let hex = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let damage =
            format!("UPDATE binary_blobs SET bytes=X'00',byte_length=1 WHERE sha256='{archive}'");
        let repair = format!(
            "UPDATE binary_blobs SET bytes=X'{hex}',byte_length={} WHERE sha256='{archive}'",
            bytes.len()
        );
        let rebind = |digest: &str| {
            format!(
                "UPDATE ydoc_inactive_lineages SET full_state_blob_sha256='{digest}' WHERE lineage_claim_id='{}'",
                w.lineage
            )
        };
        match case {
            "archive repaired" => assert_eq!(changed(&w, &damage), 1),
            "archive restored" => assert_eq!(
                changed(
                    &w,
                    &format!("DELETE FROM binary_blobs WHERE sha256='{archive}'")
                ),
                1
            ),
            _ => {}
        }
        let before = inspected_window(&w.store);
        assert_eq!(
            before.status,
            HeldBindingStatus::Current,
            "{case}: current before"
        );
        let (resume, request) = paused_inspection(&w).await;
        let proved = generation(&w);
        match case {
            "archive digest" => assert_eq!(changed(&w, &rebind("f".repeat(64).as_str())), 1),
            "archive kind" => assert_eq!(
                changed(
                    &w,
                    &format!(
                        "UPDATE ydoc_inactive_lineages SET content_kind='plaintext' WHERE lineage_claim_id='{}'",
                        w.lineage
                    ),
                ),
                1
            ),
            "archive damaged" => assert_eq!(changed(&w, &damage), 1),
            "archive repaired" => assert_eq!(changed(&w, &repair), 1),
            "archive restored" => assert_eq!(
                changed_with_keys(
                    &w,
                    &format!(
                        "INSERT INTO binary_blobs VALUES ('{archive}',{},X'{hex}')",
                        bytes.len()
                    ),
                ),
                1
            ),
            _ => {
                assert_eq!(changed(&w, &rebind("f".repeat(64).as_str())), 1);
                assert_eq!(changed(&w, &damage), 1);
                assert_eq!(changed(&w, &rebind(archive.as_str())), 1);
            }
        }
        let moved = case != "archive kind";
        assert_eq!(
            generation(&w) > proved,
            moved,
            "{case}: whether the generation moved"
        );
        let answer = released(resume, request).await.expect("held");
        assert_eq!(answer.status, HeldBindingStatus::Stale, "{case}");
        assert_eq!(answer.preservation, None, "{case}: no preservation");
        assert_eq!(answer.contributions, None, "{case}: no artifact");
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

/// Sol's r2c-3c-3 finding 3: the release compares the hold's digest, never
/// its binding, so the binding cannot change while its digest stays. A
/// writer that tries it, past the store's other checks, while the proof
/// holds at its snapshot, is refused, and the answer is the one proved.
#[tokio::test]
async fn a_binding_changed_under_its_digest_is_refused() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let proved = inspected_window(&w.store);
    assert_eq!(proved.status, HeldBindingStatus::Current);
    let (resume, request) = paused_inspection(&w).await;
    let raw = writer(&w);
    raw.execute_batch("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON")
        .unwrap();
    let refused = raw
        .execute(
            "UPDATE hosted_documents SET released_hold_binding_json='{}' WHERE object_id='object'",
            [],
        )
        .expect_err("the binding changes only with its digest");
    assert!(
        refused
            .to_string()
            .contains("a released hold binding changes with its digest"),
        "{refused}"
    );
    drop(raw);
    let answer = released(resume, request).await.expect("held");
    assert_eq!(*answer, proved);
    desktop.close().await;
    w.close().await;
}

/// The window document's hold revision.
fn hold_revision(w: &RetainedWindow) -> i64 {
    w.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT revision FROM released_hold_revisions
                 WHERE workspace_id='workspace' AND object_id='object'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// Sol's and Opus's r2c-3c-5 finding 1, as Sol's r2c-3c-7 ruling keeps it:
/// writes that change the hold's binding with its digest can leave the
/// digest the proof read beside a binding it never read: two rewrites, the
/// hold moved to another document and back, or the hold removed and
/// restored with another binding. Each advances the document's hold
/// revision, so while the proof holds at its snapshot the answer turns stale
/// and keeps nothing. None moves the document's released tail generation.
#[tokio::test]
async fn a_binding_changed_back_to_its_digest_is_stale() {
    for case in ["rewritten twice", "moved and back", "removed and restored"] {
        let (w, desktop, _client) = held_for_a_queued_fold().await;
        assert_eq!(
            inspected_window(&w.store).status,
            HeldBindingStatus::Current,
            "{case}"
        );
        let (resume, request) = paused_inspection(&w).await;
        let proved: String = w
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT released_hold_binding_digest FROM hosted_documents WHERE object_id='object'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        let tails = generation(&w);
        let mut before = hold_revision(&w);
        match case {
            "rewritten twice" => {
                for (json, digest) in [
                    ("{\"rebound\":2}", "e".repeat(64)),
                    ("{\"rebound\":3}", proved.clone()),
                ] {
                    let rebound = changed(
                        &w,
                        &format!(
                            "UPDATE hosted_documents SET released_hold_binding_json='{json}',
                               released_hold_binding_digest='{digest}' WHERE object_id='object'"
                        ),
                    );
                    assert_eq!(rebound, 1, "{json}");
                    assert!(hold_revision(&w) > before, "{json} advances the revision");
                    before = hold_revision(&w);
                }
            }
            "moved and back" => {
                for (from, to) in [("object", "elsewhere"), ("elsewhere", "object")] {
                    let moved = changed(
                        &w,
                        &format!(
                            "UPDATE hosted_documents SET object_id='{to}' WHERE object_id='{from}'"
                        ),
                    );
                    assert_eq!(moved, 1, "to {to}");
                }
                assert!(hold_revision(&w) > before, "{case} advances the revision");
            }
            _ => {
                writer(&w)
                    .execute_batch(
                        "PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON;
                         CREATE TEMP TABLE kept AS SELECT * FROM hosted_documents WHERE object_id='object';
                         DELETE FROM hosted_documents WHERE object_id='object';
                         UPDATE temp.kept SET released_hold_binding_json='{\"rebound\":4}';
                         INSERT INTO hosted_documents SELECT * FROM temp.kept;",
                    )
                    .unwrap();
                assert!(hold_revision(&w) > before, "{case} advances the revision");
            }
        }
        assert_eq!(generation(&w), tails, "{case} leaves the generation");
        let answer = released(resume, request).await.expect("held");
        assert_eq!(answer.document.binding_digest, proved, "{case}");
        assert_eq!(answer.status, HeldBindingStatus::Stale, "{case}");
        assert_eq!(answer.preservation, None, "{case}: no preservation");
        assert_eq!(answer.contributions, None, "{case}: no artifact");
        desktop.close().await;
        w.close().await;
    }
}

/// Opus's r2c-3c-7 finding 2: a proof reads the state of the document its
/// binding names, so a binding stored on another document's row proves
/// nothing of that row. The window's hold copied, binding and digest as they
/// were, onto a second document answers stale there, while the window's own
/// still answers current.
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

/// Every statement the store's connection ran while a proof was released.
static RELEASING: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn releasing(event: TraceEvent<'_>) {
    if let TraceEvent::Stmt(_, text) = event {
        RELEASING.lock().unwrap().push(text.to_owned());
    }
}

/// Ruling B, item 5, and Sol's r2c-3c-1 finding 2: releasing a proof on the
/// store's writer reads by key alone: none of the tables the proof
/// enumerates or loads bytes from, the journal and its snapshots only for
/// their last row, never the hold's binding, and a handful of statements
/// however much the hold covers. A change another writer connection makes
/// between the proof and its release, and a proof of an earlier open of the
/// store, release as stale.
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
        "binary_blobs",
        "live_owner_activations",
        "live_accepted_updates",
        "live_device_update_applications",
        "ydoc_owner_activation_sources",
        "released_hold_binding_json",
    ] {
        assert!(
            !statements.iter().any(|statement| statement.contains(table)),
            "{table}: {statements:#?}"
        );
    }
    for table in ["ydoc_updates", "ydoc_snapshots"] {
        assert!(
            statements
                .iter()
                .filter(|statement| statement.contains(table))
                .all(|statement| statement.contains("DESC LIMIT 1")),
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
    assert_eq!(
        reopened.status,
        HeldBindingStatus::Stale,
        "a proof of an earlier open"
    );
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

/// Ruling B, item 6: the last caller to leave stops the proof it waited for,
/// wherever the proof is. Held at each stage in turn, the proof passes no
/// further check once its caller leaves, and its reader closes before that
/// caller answers; the workspace then takes the next proof. Sol's r2c-3c-2
/// finding 3: that holds inside replay once it applied the head's first
/// blob, its fourth check, and inside the artifact's encoding, at the start
/// of its first list, its second.
#[tokio::test]
async fn the_last_caller_leaving_stops_a_running_proof() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let proofs = w.actor.held_proofs();
    let resume = Resume(proofs.clone());
    let stages = [
        (ProofStage::Replay, 1),
        (ProofStage::Replay, 4),
        (ProofStage::Validation, 1),
        (ProofStage::Merge, 1),
        (ProofStage::Projection, 1),
        (ProofStage::Encoding, 1),
        (ProofStage::Encoding, 2),
    ];
    for (stage, nth) in stages {
        let stage = (stage, nth);
        proofs.pause_proofs_at_check(stage.0, nth);
        let token = CancellationToken::new();
        let request = inspection(&w, &token);
        reached(
            &format!("{stage:?}: the proof holds there"),
            proofs.paused_proof(),
        )
        .await;
        let passed = proofs.checks_passed();
        token.cancel();
        let left = answered(request).await;
        assert!(
            matches!(left, Err(RuntimeError::Cancelled)),
            "{stage:?}: {left:?}"
        );
        assert_eq!(
            proofs.open_readers(),
            0,
            "{stage:?}: its reader closed first"
        );
        assert_eq!(
            proofs.checks_passed(),
            passed,
            "{stage:?}: it went no further"
        );
        proofs.resume_proofs();
        let next = answered(inspection(&w, &CancellationToken::new())).await;
        assert_eq!(
            next.unwrap().expect("held").status,
            HeldBindingStatus::Current,
            "{stage:?}"
        );
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

/// Ruling B, items 6 and 7: while a proof runs, a request for its workspace
/// beyond the callers one proof answers, or asking anything else, here the
/// same document once its hold moved, is refused as busy at once, never
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
    reached(
        "every caller joined",
        proofs.callers("workspace", MAX_PROOF_WAITERS),
    )
    .await;
    let refuse = || {
        tokio::time::timeout(
            Duration::from_secs(30),
            w.actor.held_document(
                "workspace".into(),
                "object".into(),
                CancellationToken::new(),
            ),
        )
    };
    let full = refuse().await.expect("refused at once");
    assert!(matches!(full, Err(RuntimeError::HeldReadBusy)), "{full:?}");
    let sql = "UPDATE hosted_documents SET released_hold_continuation='dependency-drain'
               WHERE object_id='object'";
    assert_eq!(changed(&w, sql), 1);
    let other = refuse().await.expect("refused at once");
    assert!(
        matches!(other, Err(RuntimeError::HeldReadBusy)),
        "{other:?}"
    );
    drop(resume);
    for caller in callers {
        let answer = answered(caller).await.unwrap().expect("held");
        assert_eq!(answer.status, HeldBindingStatus::Stale, "its hold moved");
    }
    assert!(matches!(
        answered(inspection(&w, &CancellationToken::new())).await,
        Ok(Some(_))
    ));
    assert_eq!(proofs.proofs_admitted(), 2);
    desktop.close().await;
    w.close().await;
}

/// Ruling B, item 6, and r2c-3c-1's open item: closing the store during a
/// proof stops it and returns only once its reader closed, so the store's
/// files can be replaced, and the proof's caller answers that the workspace
/// is gone. The stopped proof keeps its reader open until close waits for it.
/// Opus's r2c-3c-2 finding 1: once close returns, `engine.db` and its WAL
/// move.
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
    let RetainedWindow {
        owner,
        supervisor,
        store,
        root,
        ..
    } = w;
    // The test's own writer goes first, so only the proof holds the store.
    drop(store);
    owner.close().await.unwrap();
    supervisor
        .close_all()
        .expect("close returns once the reader closed");
    assert_eq!(
        proofs.open_readers(),
        0,
        "close returned after the reader closed"
    );
    release.join().unwrap();
    let closed = answered(request).await;
    assert!(
        matches!(closed, Err(RuntimeError::ActorUnavailable)),
        "{closed:?}"
    );
    let db = engine_db_path(&root).unwrap();
    for suffix in ["", "-wal"] {
        let mut from = db.clone().into_os_string();
        from.push(suffix);
        let from = std::path::PathBuf::from(from);
        if from.exists() {
            let moved = root.path().join(format!("moved{suffix}"));
            std::fs::rename(&from, &moved).unwrap_or_else(|error| panic!("{suffix}: {error}"));
            std::fs::rename(&moved, &from).unwrap();
        }
    }
    drop(resume);
    desktop.close().await;
}

/// Sol's and Opus's r2c-3c-2 finding 1: a proof's reader still open past the
/// close bound fails close, which still closes the writer, so nothing
/// replaces the store's files under it. The caller answers that the
/// workspace is gone, and the reader closes once the proof goes on. Sol's
/// and Opus's r2c-3c-4 finding 1: until then the store drains. Closing it
/// again, one store or all, answers that it is in use, and so does opening
/// or restarting it; once its reader closed, closing finds nothing to close
/// and the store opens again. Opus's finding 6: the close bound is the
/// test's, not ten seconds.
#[tokio::test]
async fn closing_with_a_reader_past_the_bound_fails() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let proofs = w.actor.held_proofs();
    let resume = Resume(proofs.clone());
    proofs.set_close_bound(Duration::ZERO);
    proofs.pause_proofs_at(ProofStage::Validation);
    proofs.linger_stopped_proofs();
    let request = inspection(&w, &CancellationToken::new());
    reached("the proof validates", proofs.paused_proof()).await;
    let RetainedWindow {
        owner,
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
    assert!(!proofs.drained(), "the reader is still open");
    for (what, refused) in [
        ("closed again", supervisor.close(&db).map(drop)),
        ("all closed again", supervisor.close_all()),
        ("reopened", supervisor.open(&db, 2).map(drop)),
        ("restarted", supervisor.restart(&db, 2).map(drop)),
    ] {
        assert!(
            matches!(refused, Err(RuntimeError::StoreInUse)),
            "{what}: {refused:?}"
        );
    }
    assert_eq!(supervisor.actor_count(), 0, "no successor started");
    drop(resume);
    let answered = answered(request).await;
    assert!(
        matches!(answered, Err(RuntimeError::ActorUnavailable)),
        "{answered:?}"
    );
    proofs.wait_for_drained();
    assert!(!supervisor.close(&db).unwrap(), "nothing left to close");
    supervisor.close_all().unwrap();
    let reopened = supervisor.open(&db, 3).unwrap();
    assert!(reopened.created_actor, "the drained store opens again");
    drop(reopened);
    supervisor.close_all().unwrap();
    desktop.close().await;
}

/// Sol's r2c-3c-6 finding 1 and Opus's finding 2: a proof runs off the
/// actor, so its worker's death stops none of it. While its reader stays
/// open past the close bound, opening the store again evicts and closes the
/// dead actor and answers that the store is in use, with no successor, and
/// so does every open until the reader closes; then the store opens again.
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
    // Its worker is gone, so closing the owner reaches no actor; the owner
    // still retires its token as it drops.
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

/// Sol's and Opus's merge-review finding 1: a proof's reader still opening
/// past the close bound keeps its store's location once close failed, its
/// caller was answered, and the actor and every handle went. On Linux the
/// reader opens by this process's descriptor for the store's folder, so
/// while a second workspace opens, that path still names the first store,
/// and the reader opens it once it goes on.
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

/// Sol's r2c-3c-2 finding 4 and Opus's "old finding 2": a proof held at its
/// merge while writes through the actor push the WAL past the mark where
/// held readers give way. Every write succeeds; a new proof is busy while the
/// WAL stays there; the held proof gives way at its next check and answers
/// busy, not unavailable or corrupt; and writes go on succeeding past the
/// length the store refuses writes at while a reader holds the WAL.
#[tokio::test]
async fn a_proof_gives_way_when_the_wal_presses_and_writes_keep_succeeding() {
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
        w.actor
            .write_for_test(WRITE)
            .await
            .expect("every write succeeds");
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
        w.actor
            .write_for_test(WRITE)
            .await
            .expect("writes go on succeeding");
    }
    desktop.close().await;
    w.close().await;
}

/// Opus's r2c-3c-4 finding 2: once a proof gave way to the WAL, an idle
/// store proves again with no write after it. Each admission that finds the
/// WAL pressing runs the writer's bounded checkpoint and asks the background
/// worker for the rest, so a caller that asks again once that checkpoint
/// finished is soon answered; with nothing checkpointing, every ask would
/// stay busy. Opus's r2c-3c-6 finding 4: it asks again only then.
#[tokio::test]
async fn an_idle_store_proves_again_after_a_proof_gave_way() {
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
        w.actor
            .write_for_test(WRITE)
            .await
            .expect("every write succeeds");
        writes += 1;
    }
    drop(resume);
    let gave_way = answered(request).await;
    assert!(
        matches!(gave_way, Err(RuntimeError::HeldReadBusy)),
        "{gave_way:?}"
    );
    let mut asked = 0;
    let answer = loop {
        let completed = w.actor.checkpoints_completed_for_test().await.unwrap();
        match answered(inspection(&w, &CancellationToken::new())).await {
            Err(RuntimeError::HeldReadBusy) => {
                asked += 1;
                assert!(asked < 100, "the idle store never proved again");
                w.actor
                    .wait_for_checkpoint_completion_for_test(completed)
                    .await
                    .unwrap();
            }
            answer => break answer,
        }
    };
    assert_eq!(
        answer.unwrap().expect("held").status,
        HeldBindingStatus::Current
    );
    desktop.close().await;
    w.close().await;
}

/// Opus's r2c-3c-6 finding 1: a hold whose contribution artifact passes its
/// cap still answers current, with the preservation, Markdown included, it
/// answers within the cap, and names no artifact, which it says is too
/// large. Only the artifact is refused. Opus's r2c-3c-8 finding 4: its merged
/// list's commitment is the one the artifact within the cap names.
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

/// Sol's r2c-3c-2 finding 4: a proof that outlasts its fixed deadline, here
/// inside a statement it could never finish, gives way and answers busy;
/// the next proof answers.
#[tokio::test]
async fn a_proof_past_its_deadline_answers_busy() {
    let (w, desktop, _client) = held_for_a_queued_fold().await;
    let proofs = w.actor.held_proofs();
    proofs.set_proof_deadline(Duration::from_millis(500));
    proofs.stall_next_proof();
    let request = inspection(&w, &CancellationToken::new());
    reached("the proof runs its statement", proofs.stalled_proof()).await;
    let expired = answered(request).await;
    assert!(
        matches!(expired, Err(RuntimeError::HeldReadBusy)),
        "{expired:?}"
    );
    assert_eq!(proofs.open_readers(), 0, "its reader closed");
    proofs.set_proof_deadline(dohc_engine_collab::live_update_application::HELD_PROOF_DEADLINE);
    let next = answered(inspection(&w, &CancellationToken::new())).await;
    assert_eq!(
        next.unwrap().expect("held").status,
        HeldBindingStatus::Current
    );
    desktop.close().await;
    w.close().await;
}
