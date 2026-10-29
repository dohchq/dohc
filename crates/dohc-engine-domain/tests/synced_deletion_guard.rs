use dohc_engine_domain::{
    ConflictChoice, ConflictFileState, ConflictMetadata, ConflictStatus, DeleteTextFile,
    DomainError, NoFaults, ResolveConflictKind, ResolveTextConflict, TextConflict,
    VersionedTextStore, WriteText, insert_text_conflict_if_absent, write_history_text_in_tx,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::params;

fn write(moment: &str, text: &str) -> WriteText {
    WriteText {
        workspace_id: "ws".into(),
        version_id: "main".into(),
        object_id: "note".into(),
        path: "trip.md".into(),
        text: text.into(),
        moment_id: moment.into(),
        metadata_origin: "restore".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 1,
        request_id: None,
    }
}

fn setup(store: &mut EngineStore, absent_current: bool) -> TextConflict {
    let mut files = VersionedTextStore::new(store);
    files
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .unwrap();
    files
        .write_text(&write("create", "Paris"), &NoFaults)
        .unwrap();
    files
        .write_text(&write("edit", "Tokyo"), &NoFaults)
        .unwrap();
    let present =
        ConflictFileState::text("trip.md", files.read_text("ws", "main", "trip.md").unwrap());
    let absent = ConflictFileState::text("trip.md", None);
    if absent_current {
        delete(&mut files);
    }
    let conflict = TextConflict {
        conflict_id: "conflict".into(),
        workspace_id: "ws".into(),
        path: "trip.md".into(),
        target_version_id: "main".into(),
        source_version_id: "main".into(),
        created_at_ms: 2,
        updated_at_ms: 2,
        status: ConflictStatus::Open,
        chosen_from: ConflictChoice::Current,
        resolution: None,
        metadata: ConflictMetadata::origin("sync"),
        base: present.clone(),
        current: if absent_current {
            absent.clone()
        } else {
            present.clone()
        },
        incoming: if absent_current { present } else { absent },
    };
    store
        .write_with(&NoFaults, |tx| {
            insert_text_conflict_if_absent(tx, &conflict)
        })
        .unwrap();
    conflict
}

fn delete(files: &mut VersionedTextStore<'_>) {
    delete_as(files, "user");
}

fn delete_as(files: &mut VersionedTextStore<'_>, origin: &str) {
    files
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                path: "trip.md".into(),
                moment_id: "delete".into(),
                request_id: None,
                metadata_origin: origin.into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 3,
            },
            &NoFaults,
        )
        .unwrap();
}

fn choice(resolution: ResolveConflictKind) -> ResolveTextConflict {
    ResolveTextConflict {
        workspace_id: "ws".into(),
        conflict_id: "conflict".into(),
        resolution,
        object_id: "fresh".into(),
        write_moment_id: "choice-write".into(),
        delete_moment_id: "choice-delete".into(),
        metadata_origin: "user".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 4,
        request_id: Some("choice-request".into()),
        conflict_answer_budget_bytes: usize::MAX,
    }
}

fn resolve(store: &mut EngineStore, resolution: ResolveConflictKind) -> Result<(), DomainError> {
    VersionedTextStore::new(store)
        .resolve_text_conflict_with(
            &choice(resolution),
            &NoFaults,
            |_, _, _| Ok(()),
            |_, _, _| Ok(()),
        )
        .map(|_| ())
}

fn counts(store: &mut EngineStore) -> (i64, i64, i64, i64) {
    store
        .read_with(|conn| {
            Ok::<_, DomainError>((
                conn.query_row("SELECT COUNT(*) FROM moments", [], |r| r.get(0))
                    .unwrap(),
                conn.query_row("SELECT COUNT(*) FROM engine_requests", [], |r| r.get(0))
                    .unwrap(),
                conn.query_row("SELECT COUNT(*) FROM blobs", [], |r| r.get(0))
                    .unwrap(),
                conn.query_row("SELECT COUNT(*) FROM materialization_jobs", [], |r| {
                    r.get(0)
                })
                .unwrap(),
            ))
        })
        .unwrap()
}

fn refuse_restore(store: &mut EngineStore, source: &str, text: &str) {
    let before = counts(store);
    let mut input = write("restore", text);
    input.request_id = Some("restore-request".into());
    let result = store.write_with(&NoFaults, |tx| write_history_text_in_tx(tx, &input, source));
    assert_eq!(
        result.unwrap_err().code(),
        "synced-deletion-revival-refused"
    );
    assert_eq!(
        counts(store),
        before,
        "refusal must leave no write, blob, job, or receipt"
    );
    assert!(
        VersionedTextStore::new(store)
            .read_text("ws", "main", "trip.md")
            .unwrap()
            .is_none()
    );
}

fn restore_after_restart(absent_current: bool, older: bool) {
    let dir = ScratchDir::new().unwrap();
    let db = engine_db_path(&dir).unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    setup(&mut store, absent_current);
    resolve(
        &mut store,
        if absent_current {
            ResolveConflictKind::KeepCurrent
        } else {
            ResolveConflictKind::ApplyIncoming
        },
    )
    .unwrap();
    drop(store);
    let mut store = EngineStore::open(&db, 5).unwrap();
    if older {
        refuse_restore(&mut store, "edit", "Paris");
    } else {
        refuse_restore(
            &mut store,
            if absent_current {
                "delete"
            } else {
                "choice-delete"
            },
            "Tokyo",
        );
    }
    let mut new_note = write("new-note", if older { "Paris" } else { "Tokyo" });
    new_note.object_id = "new-object".into();
    new_note.metadata_origin = "user".into();
    assert_eq!(
        VersionedTextStore::new(&mut store)
            .write_text(&new_note, &NoFaults)
            .unwrap()
            .object
            .object_id,
        "new-object"
    );
}

#[test]
fn synced_deletion_restore_after_applying_absent_incoming() {
    restore_after_restart(false, false);
}
#[test]
fn synced_deletion_restore_after_keeping_absent_current() {
    restore_after_restart(true, false);
}
#[test]
fn synced_deletion_older_moment_after_applying_absent_incoming() {
    restore_after_restart(false, true);
}
#[test]
fn synced_deletion_older_moment_after_keeping_absent_current() {
    restore_after_restart(true, true);
}

fn refuse_choice_before_preflight(resolution: ResolveConflictKind) {
    let dir = ScratchDir::new().unwrap();
    let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 1).unwrap();
    setup(&mut store, true);
    let before = counts(&mut store);
    let mut preflight = false;
    let result = VersionedTextStore::new(&mut store).resolve_text_conflict_with(
        &choice(resolution),
        &NoFaults,
        |_, _, _| {
            preflight = true;
            Ok(())
        },
        |_, _, _| Ok(()),
    );
    assert_eq!(
        result.unwrap_err().code(),
        "synced-deletion-revival-refused"
    );
    assert!(!preflight);
    assert_eq!(counts(&mut store), before);
}

#[test]
fn synced_deletion_incoming_choice_is_refused_before_preflight() {
    refuse_choice_before_preflight(ResolveConflictKind::ApplyIncoming);
}
#[test]
fn synced_deletion_combined_choice_is_refused_before_preflight() {
    refuse_choice_before_preflight(ResolveConflictKind::ApplyMerged {
        text: "Tokyo combined".into(),
    });
}

#[test]
fn receiver_both_absent_review_guards_the_base_object() {
    let dir = ScratchDir::new().unwrap();
    let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 1).unwrap();
    setup(&mut store, true);
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE conflicts SET incoming_exists=0, incoming_object_id=NULL, incoming_blob_sha256=NULL", []).unwrap();
        Ok::<_, DomainError>(())
    }).unwrap();
    refuse_restore(&mut store, "delete", "Tokyo");
    assert_eq!(
        resolve(
            &mut store,
            ResolveConflictKind::ApplyMerged {
                text: "combined".into()
            }
        )
        .unwrap_err()
        .code(),
        "synced-deletion-revival-refused"
    );
}

#[test]
fn both_absent_review_allows_either_nonwriting_choice() {
    for resolution in [
        ResolveConflictKind::KeepCurrent,
        ResolveConflictKind::ApplyIncoming,
    ] {
        let dir = ScratchDir::new().unwrap();
        let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 1).unwrap();
        setup(&mut store, true);
        store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE conflicts SET incoming_exists=0, incoming_object_id=NULL, incoming_blob_sha256=NULL", []).unwrap();
            Ok::<_, DomainError>(())
        }).unwrap();
        let before = counts(&mut store);
        resolve(&mut store, resolution).unwrap();
        assert!(
            VersionedTextStore::new(&mut store)
                .read_text("ws", "main", "trip.md")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            counts(&mut store).0,
            before.0,
            "closing the review must not write a moment"
        );
        store
            .read_with(|conn| {
                assert_eq!(
                    conn.query_row(
                        "SELECT status FROM conflicts WHERE conflict_id='conflict'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                    "resolved"
                );
                Ok::<_, DomainError>(())
            })
            .unwrap();
    }
}

#[test]
fn resolution_parent_guards_without_local_row_pending_and_journaled() {
    for pending in [true, false] {
        for chosen in ["current", "incoming"] {
            let dir = ScratchDir::new().unwrap();
            let db = engine_db_path(&dir).unwrap();
            let mut store = EngineStore::open(&db, 1).unwrap();
            setup(&mut store, true);
            let absent = serde_json::json!({"present": false, "pathRef": 0});
            let present = serde_json::json!({"present": true, "pathRef": 0, "objectId": "note", "contentKind": "text"});
            let payload = serde_json::json!({"formatVersion": 1, "workspaceId": "ws", "targetVersionId": "main", "conflictId": "conflict",
                "status": "resolved", "chosenFrom": chosen,
                "transition": {"current": if chosen == "current" { &absent } else { &present },
                    "incoming": if chosen == "incoming" { &absent } else { &present }, "result": absent}}).to_string();
            store.write_with(&NoFaults, |tx| {
                tx.execute("DELETE FROM conflicts", []).unwrap();
                if pending {
                    tx.execute("INSERT INTO replication_pending_conflict_bundles (workspace_id,conflict_id,format_version,pre_effect_moment_order,created_at_ms) VALUES ('ws','conflict',1,3,4)", []).unwrap();
                    tx.execute("INSERT INTO replication_pending_conflict_ops (bundle_order,op_index,op_kind,payload_json,recorded_at_ms) VALUES (?1,0,'conflict.resolve',?2,4)", params![tx.last_insert_rowid(), payload]).unwrap();
                } else {
                    tx.execute("INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES ('ws','peer',0,'conflict.resolve',?1,4,1)", [payload]).unwrap();
                }
                Ok::<_, DomainError>(())
            }).unwrap();
            drop(store);
            let mut store = EngineStore::open(&db, 5).unwrap();
            refuse_restore(&mut store, "delete", "Tokyo");
        }
    }
}

#[test]
fn surviving_note_noop_removal_and_plain_undelete_remain_allowed() {
    let dir = ScratchDir::new().unwrap();
    let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 1).unwrap();
    setup(&mut store, false);
    // Retained deletion evidence must not prevent a surviving note's rollback.
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE conflicts SET status='resolved', chosen_from='incoming', resolution='applied-incoming'", []).unwrap();
        Ok::<_, DomainError>(())
    }).unwrap();
    let mut input = write("rollback", "Paris");
    input.request_id = Some("committed-restore".into());
    store
        .write_with(&NoFaults, |tx| write_history_text_in_tx(tx, &input, "edit"))
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            write_history_text_in_tx(tx, &write("noop", "Paris"), "edit")
        })
        .unwrap();
    // A committed request/moment still replays after the object becomes dormant.
    delete_as(&mut VersionedTextStore::new(&mut store), "restore");
    let before_replay = counts(&mut store);
    store
        .write_with(&NoFaults, |tx| write_history_text_in_tx(tx, &input, "edit"))
        .unwrap();
    assert_eq!(counts(&mut store), before_replay);
    input.request_id = None;
    store
        .write_with(&NoFaults, |tx| write_history_text_in_tx(tx, &input, "edit"))
        .unwrap();
    assert_eq!(counts(&mut store), before_replay);
    // No sync delete/edit evidence: ordinary deleted-note History restore is safe.
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM conflicts", []).unwrap();
            Ok::<_, DomainError>(())
        })
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            write_history_text_in_tx(tx, &write("undelete", "Paris"), "delete")
        })
        .unwrap();
}

#[test]
fn deletion_evidence_is_scoped_to_sync_version_and_object() {
    for change in [
        "metadata_origin='merge'",
        "target_version_id='other'",
        "incoming_object_id='other'",
    ] {
        let dir = ScratchDir::new().unwrap();
        let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 1).unwrap();
        setup(&mut store, true);
        resolve(&mut store, ResolveConflictKind::KeepCurrent).unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(&format!("UPDATE conflicts SET {change}"), [])
                    .unwrap();
                Ok::<_, DomainError>(())
            })
            .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                write_history_text_in_tx(tx, &write("restore", "Tokyo"), "delete")
            })
            .unwrap();
    }
}
