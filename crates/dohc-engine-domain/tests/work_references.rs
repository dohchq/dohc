//! Work references: made once per target on this device, kept across reopen,
//! renames, and moves, and committed with their outbox entry or not at all.

use dohc_engine_domain::work_references::{
    MadeWorkReference, TransactionalRecordId, WorkReferenceRegistration, WorkReferenceResolution,
    WorkTarget, WorkTargetInput, WorkTargetState, make_work_reference, resolve_work_reference,
};
use dohc_engine_domain::{
    ChatActorKind, ChatChannelKind, ChatThreadLane, CreateNamedVersion, DeleteTextFile,
    DomainError, LinkedChatStore, NoFaults, RenameTextFile, StartChannelThread, TxnOutcome,
    VersionedTextStore, WriteText, reconcile_collections_in_tx,
};
use dohc_engine_storage::{EngineStore, FaultPoint, StorageError};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use rusqlite::params;

const WS: &str = "refs-workspace";
const MAIN: &str = "main";
const RECORD: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const DATASET: &str = "0b5e8f0e-4c1a-4d36-9a52-1f0c2b7d9e10";
const TABLE: &str = "6f1d2c3b-8a9e-4f70-b1c2-d3e4f5a6b7c8";

fn fresh() -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, MAIN, 1, &NoFaults)
        .expect("main version");
    (scratch, db, store)
}

fn write(store: &mut EngineStore, version: &str, path: &str, object: &str, text: &str, at: i64) {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: WS.to_owned(),
                version_id: version.to_owned(),
                object_id: object.to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: format!("write-{at}"),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: at,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("write");
}

fn rename(store: &mut EngineStore, version: &str, from: &str, to: &str, at: i64) {
    VersionedTextStore::new(store)
        .rename_text_file(
            &RenameTextFile {
                workspace_id: WS.to_owned(),
                version_id: version.to_owned(),
                from_path: from.to_owned(),
                to_path: to.to_owned(),
                moment_id: format!("rename-{at}"),
                request_id: None,
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: at,
            },
            &NoFaults,
        )
        .expect("rename");
}

fn delete(store: &mut EngineStore, path: &str, at: i64) {
    VersionedTextStore::new(store)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: WS.to_owned(),
                version_id: MAIN.to_owned(),
                path: path.to_owned(),
                moment_id: format!("delete-{at}"),
                request_id: None,
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: at,
            },
            &NoFaults,
        )
        .expect("delete");
}

fn reconcile(store: &mut EngineStore) {
    let outcome = store
        .write_with(&NoFaults, |tx| reconcile_collections_in_tx(tx, WS, MAIN))
        .expect("reconcile");
    assert!(matches!(outcome, TxnOutcome::Committed(_)));
}

fn file_by_path(path: &str) -> WorkTargetInput {
    WorkTargetInput::File {
        version_id: None,
        object_id: None,
        path: Some(path.to_owned()),
    }
}

fn make(store: &mut EngineStore, input: &WorkTargetInput, at: i64) -> MadeWorkReference {
    make_work_reference(store, WS, input, at, &NoFaults).expect("make reference")
}

fn found(store: &EngineStore, reference: &str) -> (WorkTarget, WorkTargetState, Option<String>) {
    match resolve_work_reference(store, WS, reference).expect("resolve") {
        WorkReferenceResolution::Found {
            target,
            state,
            path,
            ..
        } => (target, state, path),
        WorkReferenceResolution::Unknown => panic!("{reference} is unknown"),
    }
}

fn count(store: &EngineStore, table: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
        })
        .expect("count")
}

#[test]
fn a_reference_survives_reopen_and_asking_again_returns_it() {
    let (_scratch, db, mut store) = fresh();
    write(&mut store, MAIN, "notes/plan.md", "plan", "Plan", 2);
    let first = make(&mut store, &file_by_path("notes/plan.md"), 3);
    assert!(first.created);
    assert_eq!(first.reference.len(), 43);
    let by_object = make(
        &mut store,
        &WorkTargetInput::File {
            version_id: Some(MAIN.to_owned()),
            object_id: Some("plan".to_owned()),
            path: None,
        },
        4,
    );
    assert_eq!(
        by_object,
        MadeWorkReference {
            reference: first.reference.clone(),
            created: false
        }
    );
    drop(store);

    let mut store = EngineStore::open(&db, 5).expect("reopen");
    assert_eq!(
        resolve_work_reference(&store, WS, &first.reference).expect("resolve"),
        WorkReferenceResolution::Found {
            reference: first.reference.clone(),
            target: WorkTarget::File {
                version_id: MAIN.to_owned(),
                object_id: "plan".to_owned()
            },
            state: WorkTargetState::Live,
            path: Some("notes/plan.md".to_owned()),
            created_at_ms: 3,
            registration: WorkReferenceRegistration::Pending,
        }
    );
    let again = make(&mut store, &file_by_path("notes/plan.md"), 6);
    assert_eq!(again.reference, first.reference);
    assert!(!again.created);
    assert_eq!(count(&store, "work_references"), 1);
    assert_eq!(count(&store, "work_reference_outbox"), 1);
}

#[test]
fn a_new_reference_waits_in_the_outbox() {
    let (_scratch, _db, mut store) = fresh();
    write(&mut store, MAIN, "a.md", "a", "A", 2);
    let made = make(&mut store, &file_by_path("a.md"), 7);
    let queued: (String, i64) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT reference, enqueued_at_ms FROM work_reference_outbox",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("outbox row");
    assert_eq!(queued, (made.reference, 7));
}

#[test]
fn rename_and_move_keep_the_target() {
    let (_scratch, _db, mut store) = fresh();
    write(&mut store, MAIN, "notes/plan.md", "plan", "Plan", 2);
    write(
        &mut store,
        MAIN,
        "people/collection.yaml",
        "schema",
        "name: People\n",
        3,
    );
    write(
        &mut store,
        MAIN,
        "people/ada.md",
        "ada",
        &format!("---\nid: {RECORD}\n---\n"),
        4,
    );
    reconcile(&mut store);
    let file = make(&mut store, &file_by_path("notes/plan.md"), 5).reference;
    let app = make(
        &mut store,
        &WorkTargetInput::App {
            version_id: None,
            object_id: None,
            path: Some("notes/plan.md".to_owned()),
        },
        5,
    )
    .reference;
    assert_ne!(app, file, "an app and a file are different targets");
    let record = make(
        &mut store,
        &WorkTargetInput::DocumentRecord {
            version_id: None,
            record_id: RECORD.to_owned(),
        },
        5,
    )
    .reference;
    let collection = make(
        &mut store,
        &WorkTargetInput::DocumentCollection {
            version_id: None,
            path: "people".to_owned(),
        },
        5,
    )
    .reference;

    rename(&mut store, MAIN, "notes/plan.md", "archive/old-plan.md", 6);
    rename(
        &mut store,
        MAIN,
        "people/collection.yaml",
        "team/collection.yaml",
        7,
    );
    rename(&mut store, MAIN, "people/ada.md", "team/ada-lovelace.md", 8);
    // The record's file gives its path before the Collection index catches up.
    assert_eq!(
        found(&store, &record),
        (
            WorkTarget::DocumentRecord {
                version_id: MAIN.to_owned(),
                record_id: RECORD.to_owned()
            },
            WorkTargetState::Live,
            Some("team/ada-lovelace.md".to_owned())
        )
    );
    reconcile(&mut store);

    let (target, state, path) = found(&store, &file);
    assert_eq!(
        target,
        WorkTarget::File {
            version_id: MAIN.to_owned(),
            object_id: "plan".to_owned()
        }
    );
    assert_eq!(state, WorkTargetState::Live);
    assert_eq!(path.as_deref(), Some("archive/old-plan.md"));
    assert_eq!(
        found(&store, &app).2.as_deref(),
        Some("archive/old-plan.md")
    );
    assert_eq!(
        found(&store, &record).2.as_deref(),
        Some("team/ada-lovelace.md")
    );
    let (target, state, path) = found(&store, &collection);
    assert_eq!(
        target,
        WorkTarget::DocumentCollection {
            version_id: MAIN.to_owned(),
            object_id: "schema".to_owned()
        }
    );
    assert_eq!(state, WorkTargetState::Live);
    assert_eq!(path.as_deref(), Some("team"));

    // The old path names nothing now; the new one names the same reference.
    assert!(matches!(
        make_work_reference(&mut store, WS, &file_by_path("notes/plan.md"), 9, &NoFaults),
        Err(DomainError::WorkTargetNotFound)
    ));
    assert_eq!(
        make(&mut store, &file_by_path("archive/old-plan.md"), 9).reference,
        file
    );
}

#[test]
fn a_deleted_target_resolves_as_deleted() {
    let (_scratch, _db, mut store) = fresh();
    write(&mut store, MAIN, "gone.md", "gone", "Gone", 2);
    let file = make(&mut store, &file_by_path("gone.md"), 3).reference;
    let mut chats = LinkedChatStore::new(&mut store);
    chats
        .create_channel(
            WS,
            "chan",
            "General",
            ChatChannelKind::Channel,
            3,
            &NoFaults,
        )
        .expect("channel");
    chats
        .start_channel_thread(
            &StartChannelThread {
                automation: None,
                workspace_id: WS.to_owned(),
                channel_id: "chan".to_owned(),
                thread_id: "thread".to_owned(),
                message_id: "message".to_owned(),
                title: None,
                lane: ChatThreadLane::Posts,
                own_thread: false,
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_owner_display_name: None,
                author_user_id: Some("user-ada".to_owned()),
                origin: None,
                body: "Look at this".to_owned(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                now_ms: 4,
                request_id: None,
                author_agent_id: None,
                named_agent_ids: Vec::new(),
            },
            &NoFaults,
        )
        .expect("thread");
    let message = make(
        &mut store,
        &WorkTargetInput::Message {
            message_id: "message".to_owned(),
        },
        5,
    )
    .reference;
    let message_target = WorkTarget::Message {
        message_id: "message".to_owned(),
        thread_id: "thread".to_owned(),
        channel_id: Some("chan".to_owned()),
    };
    assert_eq!(
        found(&store, &message),
        (message_target.clone(), WorkTargetState::Live, None)
    );

    delete(&mut store, "gone.md", 6);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM chat_messages WHERE workspace_id = ?1 AND message_id = 'message'",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("drop message");

    assert_eq!(
        found(&store, &file),
        (
            WorkTarget::File {
                version_id: MAIN.to_owned(),
                object_id: "gone".to_owned()
            },
            WorkTargetState::Deleted,
            None
        )
    );
    assert_eq!(
        found(&store, &message),
        (message_target, WorkTargetState::Deleted, None)
    );
    // A deleted target cannot get a new reference, and the old one stays.
    assert!(matches!(
        make_work_reference(&mut store, WS, &file_by_path("gone.md"), 7, &NoFaults),
        Err(DomainError::WorkTargetNotFound)
    ));
    assert_eq!(count(&store, "work_references"), 2);
}

#[test]
fn a_new_file_at_a_deleted_path_is_a_new_target() {
    let (_scratch, _db, mut store) = fresh();
    write(&mut store, MAIN, "notes/plan.md", "first", "First", 2);
    let old = make(&mut store, &file_by_path("notes/plan.md"), 3).reference;
    delete(&mut store, "notes/plan.md", 4);
    write(&mut store, MAIN, "notes/plan.md", "second", "Second", 5);

    assert_eq!(
        found(&store, &old),
        (
            WorkTarget::File {
                version_id: MAIN.to_owned(),
                object_id: "first".to_owned()
            },
            WorkTargetState::Deleted,
            None
        )
    );
    let new = make(&mut store, &file_by_path("notes/plan.md"), 6);
    assert!(new.created);
    assert_ne!(new.reference, old);
    assert_eq!(
        found(&store, &new.reference),
        (
            WorkTarget::File {
                version_id: MAIN.to_owned(),
                object_id: "second".to_owned()
            },
            WorkTargetState::Live,
            Some("notes/plan.md".to_owned())
        )
    );
}

#[test]
fn a_deleted_record_collection_or_app_resolves_as_deleted() {
    let (_scratch, _db, mut store) = fresh();
    write(
        &mut store,
        MAIN,
        "people/collection.yaml",
        "schema",
        "name: People\n",
        2,
    );
    write(
        &mut store,
        MAIN,
        "people/ada.md",
        "ada",
        &format!("---\nid: {RECORD}\n---\n"),
        3,
    );
    write(
        &mut store,
        MAIN,
        "apps/trip/index.html",
        "trip",
        "<p>Trip</p>",
        4,
    );
    reconcile(&mut store);
    let record = make(
        &mut store,
        &WorkTargetInput::DocumentRecord {
            version_id: None,
            record_id: RECORD.to_owned(),
        },
        5,
    )
    .reference;
    let collection = make(
        &mut store,
        &WorkTargetInput::DocumentCollection {
            version_id: None,
            path: "people".to_owned(),
        },
        5,
    )
    .reference;
    let app = make(
        &mut store,
        &WorkTargetInput::App {
            version_id: None,
            object_id: None,
            path: Some("apps/trip/index.html".to_owned()),
        },
        5,
    )
    .reference;
    for reference in [&record, &collection, &app] {
        assert_eq!(found(&store, reference).1, WorkTargetState::Live);
    }

    // Each reads as deleted as soon as its file is gone, and stays deleted
    // once the Collection index catches up.
    delete(&mut store, "people/ada.md", 6);
    assert_eq!(found(&store, &record).1, WorkTargetState::Deleted);
    delete(&mut store, "people/collection.yaml", 7);
    assert_eq!(found(&store, &collection).1, WorkTargetState::Deleted);
    delete(&mut store, "apps/trip/index.html", 8);
    reconcile(&mut store);
    assert_eq!(
        found(&store, &record),
        (
            WorkTarget::DocumentRecord {
                version_id: MAIN.to_owned(),
                record_id: RECORD.to_owned()
            },
            WorkTargetState::Deleted,
            None
        )
    );
    assert_eq!(
        found(&store, &collection),
        (
            WorkTarget::DocumentCollection {
                version_id: MAIN.to_owned(),
                object_id: "schema".to_owned()
            },
            WorkTargetState::Deleted,
            None
        )
    );
    assert_eq!(
        found(&store, &app),
        (
            WorkTarget::App {
                version_id: MAIN.to_owned(),
                object_id: "trip".to_owned()
            },
            WorkTargetState::Deleted,
            None
        )
    );
}

#[test]
fn each_version_of_a_file_has_its_own_reference() {
    let (_scratch, _db, mut store) = fresh();
    write(&mut store, MAIN, "plan.md", "plan", "Plan", 2);
    VersionedTextStore::new(&mut store)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: WS.to_owned(),
                new_version_id: "draft".to_owned(),
                name: "Draft".to_owned(),
                from_version_id: MAIN.to_owned(),
                now_ms: 3,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("draft version");
    let in_main = make(&mut store, &file_by_path("plan.md"), 4).reference;
    let draft_input = WorkTargetInput::File {
        version_id: Some("draft".to_owned()),
        object_id: None,
        path: Some("plan.md".to_owned()),
    };
    let in_draft = make(&mut store, &draft_input, 4);
    assert!(in_draft.created);
    assert_ne!(in_draft.reference, in_main);

    rename(&mut store, "draft", "plan.md", "draft-plan.md", 5);
    assert_eq!(found(&store, &in_main).2.as_deref(), Some("plan.md"));
    let (target, _, path) = found(&store, &in_draft.reference);
    assert_eq!(
        target,
        WorkTarget::File {
            version_id: "draft".to_owned(),
            object_id: "plan".to_owned()
        }
    );
    assert_eq!(path.as_deref(), Some("draft-plan.md"));
    assert!(matches!(
        make_work_reference(
            &mut store,
            WS,
            &WorkTargetInput::File {
                version_id: Some("missing".to_owned()),
                object_id: Some("plan".to_owned()),
                path: None,
            },
            6,
            &NoFaults
        ),
        Err(DomainError::VersionNotFound)
    ));
}

#[test]
fn a_crash_leaves_both_rows_or_neither() {
    let (_scratch, db, mut store) = fresh();
    write(&mut store, MAIN, "a.md", "a", "A", 2);
    let before = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
    assert!(
        make_work_reference(&mut store, WS, &file_by_path("a.md"), 3, before.as_ref()).is_err()
    );
    assert!(before.fired());
    drop(store);
    let mut store = EngineStore::open(&db, 4).expect("reopen");
    assert_eq!(count(&store, "work_references"), 0);
    assert_eq!(count(&store, "work_reference_outbox"), 0);

    let after = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
    assert!(make_work_reference(&mut store, WS, &file_by_path("a.md"), 5, after.as_ref()).is_err());
    assert!(after.fired());
    drop(store);
    let mut store = EngineStore::open(&db, 6).expect("reopen");
    assert_eq!(count(&store, "work_references"), 1);
    assert_eq!(count(&store, "work_reference_outbox"), 1);
    let stored: String = store
        .read_with(|conn| {
            conn.query_row("SELECT reference FROM work_references", [], |row| {
                row.get(0)
            })
        })
        .expect("stored reference");
    let retried = make(&mut store, &file_by_path("a.md"), 7);
    assert_eq!(
        retried,
        MadeWorkReference {
            reference: stored,
            created: false
        }
    );
}

#[test]
fn the_store_refuses_a_second_or_changed_reference_and_registration_clears_the_outbox() {
    let (_scratch, _db, mut store) = fresh();
    write(&mut store, MAIN, "a.md", "a", "A", 2);
    let made = make(&mut store, &file_by_path("a.md"), 3).reference;
    let second = store.write_with(&NoFaults, |tx| {
        tx.execute(
            "INSERT INTO work_references(reference, workspace_id, target_kind, target_id, \
             version_id, created_at_ms) \
             VALUES (?1, ?2, 'file', 'a', 'main', 4)",
            params!["B".repeat(43), WS],
        )
        .map_err(StorageError::persist_public)
    });
    assert!(second.is_err(), "one target has one reference");
    for change in [
        "UPDATE work_references SET target_id = 'b' WHERE reference = ?1",
        "UPDATE work_references SET created_at_ms = 9 WHERE reference = ?1",
    ] {
        let changed = store.write_with(&NoFaults, |tx| {
            tx.execute(change, [&made])
                .map_err(StorageError::persist_public)
        });
        assert!(changed.is_err(), "a reference never changes: {change}");
    }
    let registered = store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM work_reference_outbox WHERE reference = ?1",
                [&made],
            )
            .map_err(StorageError::persist_public)
        })
        .expect("registration removes the outbox row");
    assert!(matches!(registered, TxnOutcome::Committed(1)));
    let resolution = resolve_work_reference(&store, WS, &made).expect("resolve");
    assert!(matches!(
        resolution,
        WorkReferenceResolution::Found {
            registration: WorkReferenceRegistration::Registered,
            ..
        }
    ));
}

#[test]
fn transactional_targets_keep_their_record_id_type() {
    let (_scratch, _db, mut store) = fresh();
    let table = WorkTargetInput::TransactionalCollection {
        dataset_id: DATASET.to_owned(),
        table_id: TABLE.to_owned(),
    };
    let record = |id: TransactionalRecordId| WorkTargetInput::TransactionalRecord {
        dataset_id: DATASET.to_owned(),
        table_id: TABLE.to_owned(),
        record_id: id,
    };
    let table_reference = make(&mut store, &table, 2).reference;
    let number = make(&mut store, &record(TransactionalRecordId::Number(7)), 2).reference;
    let text = make(
        &mut store,
        &record(TransactionalRecordId::Text("7".to_owned())),
        2,
    )
    .reference;
    assert_ne!(number, text);
    // A dataset accepts any nonempty text key; the request cap bounds it.
    let long_id = TransactionalRecordId::Text("r".repeat(4096));
    let long = make(&mut store, &record(long_id.clone()), 2);
    assert!(long.created);
    assert_eq!(
        found(&store, &long.reference).0,
        WorkTarget::TransactionalRecord {
            dataset_id: DATASET.to_owned(),
            table_id: TABLE.to_owned(),
            record_id: long_id
        }
    );
    assert_eq!(
        make(&mut store, &record(TransactionalRecordId::Number(7)), 3).reference,
        number
    );
    assert_eq!(
        found(&store, &table_reference),
        (
            WorkTarget::TransactionalCollection {
                dataset_id: DATASET.to_owned(),
                table_id: TABLE.to_owned()
            },
            WorkTargetState::Unchecked,
            None
        )
    );
    assert_eq!(
        found(&store, &text).0,
        WorkTarget::TransactionalRecord {
            dataset_id: DATASET.to_owned(),
            table_id: TABLE.to_owned(),
            record_id: TransactionalRecordId::Text("7".to_owned())
        }
    );
    for refused in [
        WorkTargetInput::TransactionalCollection {
            dataset_id: "not-a-uuid".to_owned(),
            table_id: TABLE.to_owned(),
        },
        record(TransactionalRecordId::Number(1 << 60)),
        record(TransactionalRecordId::Number(i64::MIN)),
        record(TransactionalRecordId::Text(String::new())),
    ] {
        assert!(
            make_work_reference(&mut store, WS, &refused, 4, &NoFaults).is_err(),
            "{refused:?}"
        );
    }
}

#[test]
fn an_unknown_or_foreign_reference_resolves_as_unknown() {
    let (_scratch, _db, mut store) = fresh();
    write(&mut store, MAIN, "a.md", "a", "A", 2);
    let made = make(&mut store, &file_by_path("a.md"), 3).reference;
    for unknown in [
        String::new(),
        "short".to_owned(),
        "C".repeat(43),
        format!("{made}x"),
    ] {
        assert_eq!(
            resolve_work_reference(&store, WS, &unknown).expect("resolve"),
            WorkReferenceResolution::Unknown
        );
    }
    assert_eq!(
        resolve_work_reference(&store, "other-workspace", &made).expect("resolve"),
        WorkReferenceResolution::Unknown
    );
    for refused in [
        WorkTargetInput::File {
            version_id: None,
            object_id: Some("a".to_owned()),
            path: Some("a.md".to_owned()),
        },
        WorkTargetInput::File {
            version_id: None,
            object_id: None,
            path: None,
        },
        WorkTargetInput::DocumentRecord {
            version_id: None,
            record_id: "not-a-record".to_owned(),
        },
        WorkTargetInput::Message {
            message_id: "missing".to_owned(),
        },
    ] {
        assert!(
            make_work_reference(&mut store, WS, &refused, 4, &NoFaults).is_err(),
            "{refused:?}"
        );
    }
}
