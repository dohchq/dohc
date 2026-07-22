//! Crash-injection traces at the version-create and restore transaction
//! boundaries (CAL-2). Durability is proven by REOPENING, never by trusting an
//! in-process flag (`TEST_ORACLE.md` §3). The named storage fault points
//! (`storage.before-persist`, `storage.after-commit-before-ack`) are the same
//! seam CAL-1 pins; the versioning compound commits ride it via
//! `EngineStore::write_with`.

use dohc_engine_domain::{
    CreateNamedVersion, DeleteTextFile, NoFaults, RenameTextFile, RollbackTextFileMutation,
    VersionedTextStore, WriteText,
};
use dohc_engine_storage::{EngineStore, FaultPoint};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};

const NO_FAULTS: NoFaults = NoFaults;
const WS: &str = "ws-1";

fn seed_main_with_file(db: &std::path::Path) {
    let mut store = EngineStore::open(db, 1).expect("open");
    let mut vt = VersionedTextStore::new(&mut store);
    vt.ensure_main_version(WS, "main", 1, &NO_FAULTS)
        .expect("main");
    vt.write_text(
        &WriteText {
            workspace_id: WS.to_owned(),
            version_id: "main".to_owned(),
            object_id: "o1".to_owned(),
            path: "a.md".to_owned(),
            text: "base".to_owned(),
            moment_id: "m1".to_owned(),
            metadata_origin: "user".to_owned(),
            author_json: None,
            now_ms: 10,
            request_id: None,
        },
        &NO_FAULTS,
    )
    .expect("seed write");
    // drop → simulated clean close
}

fn fork_input(request_id: Option<&str>) -> CreateNamedVersion {
    CreateNamedVersion {
        workspace_id: WS.to_owned(),
        new_version_id: "feat".to_owned(),
        name: "feature".to_owned(),
        from_version_id: "main".to_owned(),
        now_ms: 20,
        request_id: request_id.map(str::to_owned),
    }
}

fn seed_overwrite(db: &std::path::Path) {
    seed_main_with_file(db);
    let mut store = EngineStore::open(db, 2).expect("reopen");
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                object_id: "o1".to_owned(),
                path: "a.md".to_owned(),
                text: "overwritten".to_owned(),
                moment_id: "m2".to_owned(),
                metadata_origin: "user".to_owned(),
                author_json: None,
                now_ms: 20,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("overwrite");
}

fn rollback_input() -> RollbackTextFileMutation {
    RollbackTextFileMutation {
        workspace_id: WS.to_owned(),
        version_id: "main".to_owned(),
        path: "a.md".to_owned(),
        mutation_moment_id: "m2".to_owned(),
        request_id: None,
        legacy_before_text: None,
    }
}

fn delete_input() -> DeleteTextFile {
    DeleteTextFile {
        workspace_id: WS.to_owned(),
        version_id: "main".to_owned(),
        path: "a.md".to_owned(),
        moment_id: "m2".to_owned(),
        request_id: None,
        metadata_origin: "user".to_owned(),
        author_json: None,
        now_ms: 20,
    }
}

fn rename_input() -> RenameTextFile {
    RenameTextFile {
        workspace_id: WS.to_owned(),
        version_id: "main".to_owned(),
        from_path: "a.md".to_owned(),
        to_path: "b.md".to_owned(),
        moment_id: "m2".to_owned(),
        request_id: None,
        metadata_origin: "user".to_owned(),
        author_json: None,
        now_ms: 20,
    }
}

// oracle: crash BEFORE persist during create-named-version → atomic rollback.
// Restart shows NO new version; a retry then applies cleanly.
#[test]
fn version_create_crash_before_persist_rolls_back() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    seed_main_with_file(&db);

    {
        let mut store = EngineStore::open(&db, 2).expect("reopen");
        let mut vt = VersionedTextStore::new(&mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
        // The crash surfaces as a persist-failed error; durable truth is checked
        // by reopening below.
        let err = vt
            .create_named_version(&fork_input(Some("req-fork")), faults.as_ref())
            .expect_err("crash before persist");
        assert_eq!(err.code(), "persist-failed");
        // store dropped → simulated crash
    }

    // Restart: the fork rolled back entirely.
    let mut store = EngineStore::open(&db, 3).expect("reopen after crash");
    let mut vt = VersionedTextStore::new(&mut store);
    assert!(
        vt.list_versions(WS)
            .expect("versions")
            .iter()
            .all(|v| v.version_id != "feat"),
        "rolled-back fork must not survive"
    );
    // A retry with the same request id now applies (nothing was recorded).
    let fork = vt
        .create_named_version(&fork_input(Some("req-fork")), &NO_FAULTS)
        .expect("retry applies");
    assert_eq!(fork.version_id, "feat");
    assert_eq!(
        vt.read_text(WS, "feat", "a.md").unwrap().unwrap().text,
        "base"
    );
}

// oracle: crash AFTER commit before ack during create-named-version → the fork
// is durable; an exactly-once retry (same request id) replays to the recorded
// result without minting a second version.
#[test]
fn version_create_crash_after_commit_is_exactly_once() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    seed_main_with_file(&db);

    {
        let mut store = EngineStore::open(&db, 2).expect("reopen");
        let mut vt = VersionedTextStore::new(&mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
        let err = vt
            .create_named_version(&fork_input(Some("req-fork")), faults.as_ref())
            .expect_err("crash after commit");
        assert_eq!(err.code(), "persist-failed");
        // store dropped → simulated crash AFTER the durable commit
    }

    // Restart: the fork committed durably.
    let mut store = EngineStore::open(&db, 3).expect("reopen after crash");
    let mut vt = VersionedTextStore::new(&mut store);
    let versions = vt.list_versions(WS).expect("versions");
    assert_eq!(
        versions.iter().filter(|v| v.version_id == "feat").count(),
        1
    );

    // Exactly-once retry: dedupes to the recorded fork, no second version.
    let replayed = vt
        .create_named_version(&fork_input(Some("req-fork")), &NO_FAULTS)
        .expect("retry replays");
    assert_eq!(replayed.version_id, "feat");
    let versions = vt.list_versions(WS).expect("versions");
    assert_eq!(
        versions.iter().filter(|v| v.version_id == "feat").count(),
        1,
        "exactly-once: retry must not fork twice"
    );
}

// oracle: crash BEFORE persist during restore (set-active-version) → the active
// pointer is unchanged on restart.
#[test]
fn restore_crash_before_persist_leaves_active_unchanged() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    seed_main_with_file(&db);
    // Create a fork to switch to.
    {
        let mut store = EngineStore::open(&db, 2).expect("reopen");
        let mut vt = VersionedTextStore::new(&mut store);
        vt.create_named_version(&fork_input(None), &NO_FAULTS)
            .expect("fork");
        vt.set_active_version(WS, "feat", &NO_FAULTS)
            .expect("activate feat");
    }

    {
        let mut store = EngineStore::open(&db, 3).expect("reopen");
        let mut vt = VersionedTextStore::new(&mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
        let err = vt
            .set_active_version(WS, "main", faults.as_ref())
            .expect_err("crash before persist");
        assert_eq!(err.code(), "persist-failed");
    }

    // Restart: the restore rolled back — feat is still active.
    let mut store = EngineStore::open(&db, 4).expect("reopen after crash");
    let vt = VersionedTextStore::new(&mut store);
    assert_eq!(
        vt.get_active_version(WS).expect("active").version_id,
        "feat",
        "rolled-back restore must not move the active pointer"
    );
}

// oracle: versions-rollback-text-file-mutation at storage.before-persist rolls
// the entire history surgery back; reopening shows the overwrite and m2 intact.
#[test]
fn rollback_crash_before_persist_leaves_mutation_intact() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    seed_overwrite(&db);

    {
        let mut store = EngineStore::open(&db, 3).expect("reopen");
        let mut vt = VersionedTextStore::new(&mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
        let err = vt
            .rollback_text_file_mutation(&rollback_input(), faults.as_ref())
            .expect_err("crash before persist");
        assert_eq!(err.code(), "persist-failed");
    }

    let mut store = EngineStore::open(&db, 4).expect("reopen after crash");
    let vt = VersionedTextStore::new(&mut store);
    assert_eq!(
        vt.read_text(WS, "main", "a.md").unwrap().unwrap().text,
        "overwritten"
    );
    assert!(vt.get_moment(WS, "m2").expect("moment").is_some());
}

// oracle: versions-rollback-text-file-mutation at
// storage.after-commit-before-ack is already durable; reopening shows m2 gone
// and the prior snapshot restored.
#[test]
fn rollback_crash_after_commit_is_durable() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    seed_overwrite(&db);

    {
        let mut store = EngineStore::open(&db, 3).expect("reopen");
        let mut vt = VersionedTextStore::new(&mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
        let err = vt
            .rollback_text_file_mutation(&rollback_input(), faults.as_ref())
            .expect_err("crash after commit");
        assert_eq!(err.code(), "persist-failed");
    }

    let mut store = EngineStore::open(&db, 4).expect("reopen after crash");
    let vt = VersionedTextStore::new(&mut store);
    let restored = vt.read_text(WS, "main", "a.md").unwrap().unwrap();
    assert_eq!(restored.text, "base");
    assert_eq!(restored.latest_moment_id, "m1");
    assert!(vt.get_moment(WS, "m2").expect("moment").is_none());
}

#[test]
fn delete_crash_before_persist_leaves_file_intact() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    seed_main_with_file(&db);

    {
        let mut store = EngineStore::open(&db, 2).expect("reopen");
        let mut vt = VersionedTextStore::new(&mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
        let err = vt
            .delete_text_file(&delete_input(), faults.as_ref())
            .expect_err("crash before persist");
        assert_eq!(err.code(), "persist-failed");
    }

    let mut store = EngineStore::open(&db, 3).expect("reopen after crash");
    let vt = VersionedTextStore::new(&mut store);
    assert_eq!(
        vt.read_text(WS, "main", "a.md").unwrap().unwrap().text,
        "base"
    );
    assert!(vt.get_moment(WS, "m2").expect("moment").is_none());
}

#[test]
fn delete_crash_after_commit_is_durable() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    seed_main_with_file(&db);

    {
        let mut store = EngineStore::open(&db, 2).expect("reopen");
        let mut vt = VersionedTextStore::new(&mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
        let err = vt
            .delete_text_file(&delete_input(), faults.as_ref())
            .expect_err("crash after commit");
        assert_eq!(err.code(), "persist-failed");
    }

    let mut store = EngineStore::open(&db, 3).expect("reopen after crash");
    let vt = VersionedTextStore::new(&mut store);
    assert!(vt.read_text(WS, "main", "a.md").unwrap().is_none());
    assert!(vt.get_moment(WS, "m2").expect("moment").is_some());
}

#[test]
fn rename_crash_before_persist_leaves_source_intact() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    seed_main_with_file(&db);

    {
        let mut store = EngineStore::open(&db, 2).expect("reopen");
        let mut vt = VersionedTextStore::new(&mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
        let err = vt
            .rename_text_file(&rename_input(), faults.as_ref())
            .expect_err("crash before persist");
        assert_eq!(err.code(), "persist-failed");
    }

    let mut store = EngineStore::open(&db, 3).expect("reopen after crash");
    let vt = VersionedTextStore::new(&mut store);
    assert_eq!(
        vt.read_text(WS, "main", "a.md").unwrap().unwrap().text,
        "base"
    );
    assert!(vt.read_text(WS, "main", "b.md").unwrap().is_none());
    assert!(vt.get_moment(WS, "m2").expect("moment").is_none());
}

#[test]
fn rename_crash_after_commit_is_durable() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    seed_main_with_file(&db);

    {
        let mut store = EngineStore::open(&db, 2).expect("reopen");
        let mut vt = VersionedTextStore::new(&mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
        let err = vt
            .rename_text_file(&rename_input(), faults.as_ref())
            .expect_err("crash after commit");
        assert_eq!(err.code(), "persist-failed");
    }

    let mut store = EngineStore::open(&db, 3).expect("reopen after crash");
    let vt = VersionedTextStore::new(&mut store);
    assert!(vt.read_text(WS, "main", "a.md").unwrap().is_none());
    assert_eq!(
        vt.read_text(WS, "main", "b.md").unwrap().unwrap().text,
        "base"
    );
    assert!(vt.get_moment(WS, "m2").expect("moment").is_some());
}
