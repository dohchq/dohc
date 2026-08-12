use dohc_engine_collab::{ContentKind, Regime, Ydoc};
use dohc_engine_crypto::create_key_file;
use dohc_engine_domain::{
    CreateNamedVersion, SecretDelete, SecretDiskIntent, SecretWrite, VersionedTextStore, WriteText,
};
use dohc_engine_runtime::{
    ActiveVersionSwitch, CancellationToken, CaptureIngestBinary, NoFaults, RuntimeError,
    SelfWriteRecorder, WorkspaceSupervisor,
};
use dohc_engine_storage::{
    EngineStore, FaultAction, FaultInjector, FaultPoint, StorageError, TxnOutcome,
};
use dohc_engine_testkit::{EngineDbScan, ScratchDir, ScriptedFaults};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const WORKSPACE: &str = "ws-switch-ordering";

struct NoRecorder;

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

fn write(version_id: &str, text: &str, moment_id: &str, now_ms: i64) -> WriteText {
    write_for(WORKSPACE, version_id, "ordered.md", text, moment_id, now_ms)
}

fn write_for(
    workspace_id: &str,
    version_id: &str,
    path: &str,
    text: &str,
    moment_id: &str,
    now_ms: i64,
) -> WriteText {
    WriteText {
        workspace_id: workspace_id.to_owned(),
        version_id: version_id.to_owned(),
        object_id: format!("switch-object-{workspace_id}-{path}"),
        path: path.to_owned(),
        text: text.to_owned(),
        moment_id: moment_id.to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn binary_head_is_reported_as_unsettled_instead_of_failing_internally() {
    const WS: &str = "ws-binary-unsettled";
    const PATH: &str = "notes/binary.md";
    let scratch = ScratchDir::new().expect("scratch");
    let database = scratch.engine_db_path().expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 1).expect("actor").actor;
    actor
        .ensure_main_version(
            WS.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");
    let open = actor
        .ydoc_open_state(
            WS.to_owned(),
            2,
            true,
            None,
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open ydoc");
    actor
        .ydoc_record_update(
            open.key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            Ydoc::wire().plaintext_insert(0, "durable text"),
            None,
            true,
            None,
            3,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("record ydoc update");
    actor
        .capture_ingest_binary(
            CaptureIngestBinary {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: PATH.to_owned(),
                bytes: vec![0xff, 0xfe, 0x00],
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
                request_id: None,
                claim_foreign_head: true,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture binary head");

    let content_kind = actor
        .ydoc_version_unsettled_content_kind(
            WS.to_owned(),
            "main".to_owned(),
            Vec::new(),
            CancellationToken::new(),
        )
        .await
        .expect("binary head must produce an honest unsettled result");
    assert_eq!(content_kind, Some(ContentKind::Plaintext));
    supervisor.close(&database).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pathless_settled_scene_is_not_reported_as_unsettled() {
    const WS: &str = "ws-pathless-settled-scene";
    const PATH: &str = "drawings/settled.excalidraw";
    const OBJECT: &str = "pathless-scene-object";
    let scratch = ScratchDir::new().expect("scratch");
    let database = scratch.engine_db_path().expect("database");
    let imported = dohc_engine_collab::import_portable_scene(
        r#"{"type":"excalidraw","version":2,"source":"https://excalidraw.com","elements":[],"appState":{},"files":{}}"#,
    )
    .expect("scene import");
    let scene = Ydoc::wire();
    scene.apply(&imported.initial_update).expect("scene seed");
    let projection = scene
        .project(ContentKind::Scene)
        .expect("scene projection")
        .content;

    {
        let mut store = EngineStore::open(&database, 1).expect("store");
        {
            let mut versions = VersionedTextStore::new(&mut store);
            versions
                .ensure_main_version(WS, "main", 1, &NoFaults)
                .expect("main");
            versions
                .write_text(
                    &WriteText {
                        workspace_id: WS.to_owned(),
                        version_id: "main".to_owned(),
                        object_id: OBJECT.to_owned(),
                        path: PATH.to_owned(),
                        text: projection,
                        moment_id: "pathless-scene-head".to_owned(),
                        metadata_origin: "test".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .expect("scene head");
        }
        let key = dohc_engine_collab::DocKey::new(WS, "main", OBJECT).expect("doc key");
        dohc_engine_collab::claim_base(
            &mut store,
            &key,
            ContentKind::Scene,
            &scene.encode_full_state(),
            &NoFaults,
            3,
        )
        .expect("scene base");
        let removed = store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "DELETE FROM path_aliases WHERE workspace_id=?1 AND version_id='main' \
                     AND object_id=?2",
                    rusqlite::params![WS, OBJECT],
                )
                .map_err(StorageError::persist_public)
            })
            .expect("remove scene path");
        assert!(matches!(removed, TxnOutcome::Committed(1)));
    }

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 4).expect("actor").actor;
    let content_kind = actor
        .ydoc_version_unsettled_content_kind(
            WS.to_owned(),
            "main".to_owned(),
            Vec::new(),
            CancellationToken::new(),
        )
        .await
        .expect("compare the pathless scene with its snapshot");
    assert_eq!(content_kind, None);
    supervisor.close(&database).expect("close actor");
}

struct RewriteAtJobStart {
    target: PathBuf,
    replacement: &'static [u8],
    fired: AtomicBool,
}

impl RewriteAtJobStart {
    fn new(target: PathBuf, replacement: &'static [u8]) -> Self {
        Self {
            target,
            replacement,
            fired: AtomicBool::new(false),
        }
    }
}

impl FaultInjector for RewriteAtJobStart {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::MaterializeAfterJobCommit
            && !self.fired.swap(true, Ordering::AcqRel)
        {
            std::fs::write(&self.target, self.replacement)
                .expect("inject edit between planning and phase two");
        }
        FaultAction::Continue
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn destination_is_active_when_switch_materialization_fails() {
    // MUTATION: materialize before updating active_versions, or restore the
    // database-only switch, and the error/active-version assertions fail.
    let scratch = ScratchDir::new().expect("scratch");
    let database = scratch.engine_db_path().expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 1).expect("actor").actor;
    actor
        .ensure_main_version(
            WORKSPACE.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");
    actor
        .versioned_text_write(
            write("main", "main", "switch-main", 2),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main write");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 3,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature");
    actor
        .versioned_text_write(
            write("feature", "feature", "switch-feature", 4),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature write");
    std::fs::write(scratch.path().join("ordered.md"), "main").expect("seed disk");
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);

    let error = actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "feature".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 5,
            },
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("materialization fault must fail the switch");

    assert!(matches!(
        error,
        RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs: 1 }
    ));
    assert!(faults.fired(), "the materialization seam must be reached");
    assert_eq!(
        actor
            .active_version(WORKSPACE.to_owned())
            .await
            .expect("active version")
            .version_id,
        "feature"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("ordered.md")).expect("disk"),
        "main"
    );
    supervisor.close(&database).expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_switch_write_preserves_an_edit_between_planning_and_phase_two() {
    let scratch = ScratchDir::new().expect("scratch");
    let database = scratch.engine_db_path().expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 1).expect("actor").actor;
    actor
        .ensure_main_version(
            WORKSPACE.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");
    let key = create_key_file(scratch.path()).expect("secret key");
    actor
        .write_secret_file(
            SecretWrite {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                text: "MODE=main\n".to_owned(),
                moment_id: "switch-race-main".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 2,
                disk_intent: SecretDiskIntent::AlreadyOnDisk,
            },
            key,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main secret");
    std::fs::write(scratch.path().join(".env"), b"MODE=main\n").expect("seed disk");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 3,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature");
    let key = dohc_engine_crypto::load_key_file(scratch.path())
        .expect("load key")
        .expect("key exists");
    actor
        .write_secret_file(
            SecretWrite {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "feature".to_owned(),
                path: ".env".to_owned(),
                text: "MODE=feature\n".to_owned(),
                moment_id: "switch-race-feature".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 4,
                disk_intent: SecretDiskIntent::Materialize,
            },
            key,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature secret");
    let faults = Arc::new(RewriteAtJobStart::new(
        scratch.path().join(".env"),
        b"MODE=external\n",
    ));

    let error = actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "feature".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 5,
            },
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("the changed secret preimage must conflict");

    assert!(matches!(
        error,
        RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs: 1 }
    ));
    assert!(faults.fired.load(Ordering::Acquire));
    assert_eq!(
        std::fs::read(scratch.path().join(".env")).expect("preserved disk"),
        b"MODE=external\n"
    );
    supervisor.close(&database).expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_switch_delete_preserves_an_edit_between_planning_and_phase_two() {
    let scratch = ScratchDir::new().expect("scratch");
    let database = scratch.engine_db_path().expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 1).expect("actor").actor;
    actor
        .ensure_main_version(
            WORKSPACE.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");
    let key = create_key_file(scratch.path()).expect("secret key");
    actor
        .write_secret_file(
            SecretWrite {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                text: "MODE=main\n".to_owned(),
                moment_id: "switch-delete-race-main".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 2,
                disk_intent: SecretDiskIntent::AlreadyOnDisk,
            },
            key,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main secret");
    std::fs::write(scratch.path().join(".env"), b"MODE=main\n").expect("seed disk");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 3,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature");
    actor
        .delete_secret_file(
            SecretDelete {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "feature".to_owned(),
                path: ".env".to_owned(),
                moment_id: "switch-delete-race-feature".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 4,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete feature secret");
    let faults = Arc::new(RewriteAtJobStart::new(
        scratch.path().join(".env"),
        b"MODE=external\n",
    ));

    let error = actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "feature".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 5,
            },
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("the changed secret delete preimage must conflict");

    assert!(matches!(
        error,
        RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs: 1 }
    ));
    assert!(faults.fired.load(Ordering::Acquire));
    assert_eq!(
        std::fs::read(scratch.path().join(".env")).expect("preserved disk"),
        b"MODE=external\n"
    );
    supervisor.close(&database).expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switch_jobs_are_distinct_and_match_their_active_workspace() {
    const FIRST: &str = "ws-switch-first";
    const SECOND: &str = "ws-switch-second";

    let first_root = ScratchDir::new().expect("first root");
    let second_root = ScratchDir::new().expect("second root");
    let database = first_root.engine_db_path().expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 1).expect("actor").actor;
    for workspace_id in [FIRST, SECOND] {
        actor
            .ensure_main_version(
                workspace_id.to_owned(),
                1,
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("main");
        actor
            .versioned_text_write(
                write_for(
                    workspace_id,
                    "main",
                    "shared.md",
                    "main",
                    &format!("{workspace_id}-main"),
                    2,
                ),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("main write");
        actor
            .create_named_version(
                CreateNamedVersion {
                    workspace_id: workspace_id.to_owned(),
                    new_version_id: "feature".to_owned(),
                    name: "Feature".to_owned(),
                    from_version_id: "main".to_owned(),
                    now_ms: 3,
                    request_id: None,
                },
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("feature");
        actor
            .versioned_text_write(
                write_for(
                    workspace_id,
                    "feature",
                    "shared.md",
                    "feature",
                    &format!("{workspace_id}-feature"),
                    4,
                ),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("feature write");
    }
    std::fs::write(first_root.path().join("shared.md"), "main").expect("first disk");
    std::fs::write(second_root.path().join("shared.md"), "main").expect("second disk");

    for (workspace_id, root) in [(FIRST, first_root.path()), (SECOND, second_root.path())] {
        actor
            .set_active_version(
                ActiveVersionSwitch {
                    workspace_id: workspace_id.to_owned(),
                    version_id: "feature".to_owned(),
                    root_dir: root.to_path_buf(),
                    self_writes: Arc::new(NoRecorder),
                    now_ms: 1_700_000_000_000,
                },
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("switch");
    }

    assert_eq!(
        std::fs::read_to_string(first_root.path().join("shared.md")).expect("first switched"),
        "feature"
    );
    assert_eq!(
        std::fs::read_to_string(second_root.path().join("shared.md")).expect("second switched"),
        "feature"
    );
    supervisor.close(&database).expect("close");
    let connection = Connection::open(&database).expect("sqlite");
    let jobs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM materialization_jobs \
             WHERE job_id LIKE 'version-switch-mat_%' AND target_path = 'shared.md'",
            [],
            |row| row.get(0),
        )
        .expect("switch jobs");
    assert_eq!(
        jobs, 2,
        "each workspace needs its own durable switch projection identity"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switch_projection_generation_does_not_advance_moment_order() {
    let scratch = ScratchDir::new().expect("scratch");
    let database = scratch.engine_db_path().expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 1).expect("actor").actor;
    actor
        .ensure_main_version(
            WORKSPACE.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");
    actor
        .versioned_text_write(
            write("main", "main", "watermark-main", 2),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main write");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "watermark-feature".to_owned(),
                name: "Watermark feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 3,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature");
    actor
        .versioned_text_write(
            write(
                "watermark-feature",
                "feature",
                "watermark-feature-write",
                i64::MAX,
            ),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("timestamp-scale snapshot");
    std::fs::write(scratch.path().join("ordered.md"), "main").expect("seed disk");
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "watermark-feature".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(NoRecorder),
                now_ms: 4,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("switch with maximum projection generation");
    actor
        .versioned_text_write(
            write(
                "watermark-feature",
                "after switch",
                "watermark-post-switch",
                5,
            ),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("post-switch mutation");

    supervisor.close(&database).expect("close");
    let connection = Connection::open(&database).expect("sqlite");
    let projection_generation: i64 = connection
        .query_row(
            "SELECT MAX(target_generation) FROM materialization_jobs \
             WHERE job_id GLOB 'version-switch-mat_*'",
            [],
            |row| row.get(0),
        )
        .expect("projection generation");
    let mutation_order: i64 = connection
        .query_row(
            "SELECT moment_order FROM moments \
             WHERE workspace_id = ?1 AND moment_id = 'watermark-post-switch'",
            [WORKSPACE],
            |row| row.get(0),
        )
        .expect("post-switch moment order");
    assert_eq!(projection_generation, i64::MAX);
    assert_eq!(
        mutation_order, 3,
        "projection timestamps must not enter the moment-order sequence"
    );
}

/// Seal one secret into `version_id` at `.env`.
async fn write_secret(
    actor: &dohc_engine_runtime::ActorHandle,
    version_id: &str,
    text: &str,
    moment_id: &str,
    now_ms: i64,
    key: dohc_engine_crypto::SecretDataKey,
    disk_intent: SecretDiskIntent,
) {
    actor
        .write_secret_file(
            SecretWrite {
                workspace_id: WORKSPACE.to_owned(),
                version_id: version_id.to_owned(),
                path: ".env".to_owned(),
                text: text.to_owned(),
                moment_id: moment_id.to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms,
                disk_intent,
            },
            key,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write secret");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plaintext_never_leaks_across_a_version_switch_and_back() {
    // A switch is the one place the engine holds a secret plaintext outside a
    // write: `plan_secret_switch` decrypts the target tip to compare it with the
    // file on disk. The projection it plans must still reference the stored
    // CIPHERTEXT, so the plaintext lives only in memory and on the projected
    // file — never in the database.
    //
    // MUTATION: in `plan_secret_switch`, leave the decrypted plaintext behind as
    // a stray blob — `store.write_with(…, |tx| put_binary_blob(tx, &leaked))`
    // beside the existing `drop(plaintext)`. Nothing reads that blob, so every
    // other assertion here still passes and only the scan fails.
    //
    // Planning the projection with the plaintext INLINE also fails this test,
    // but for the wrong reason: the secret executor then cannot decrypt what it
    // was handed, so the switch itself errors before the scan runs.
    let scratch = ScratchDir::new().expect("scratch");
    let database = scratch.engine_db_path().expect("database");
    let env_path = scratch.path().join(".env");

    // One distinctive marker per version, so a leak names the side it came from.
    let main_marker = "MARKER_4be1c07d_SWITCH_MAIN";
    let feature_marker = "MARKER_a93f5d28_SWITCH_FEATURE";
    let main_text = format!("PASSWORD={main_marker}\n");
    let feature_text = format!("PASSWORD={feature_marker}\nTOKEN={feature_marker}-2\n");

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 1).expect("actor").actor;
    actor
        .ensure_main_version(
            WORKSPACE.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");

    let key = create_key_file(scratch.path()).expect("secret key");
    write_secret(
        &actor,
        "main",
        &main_text,
        "switch-scan-main",
        2,
        key,
        SecretDiskIntent::AlreadyOnDisk,
    )
    .await;
    std::fs::write(&env_path, main_text.as_bytes()).expect("seed disk");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 3,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature");
    let key = dohc_engine_crypto::load_key_file(scratch.path())
        .expect("load key")
        .expect("key exists");
    write_secret(
        &actor,
        "feature",
        &feature_text,
        "switch-scan-feature",
        4,
        key,
        SecretDiskIntent::Materialize,
    )
    .await;

    // Switch to the fork, then back. Each switch re-projects the secret, and
    // the on-disk file proves the switch really ran rather than no-opping.
    for (version_id, expected, now_ms) in [("feature", &feature_text, 5), ("main", &main_text, 6)] {
        actor
            .set_active_version(
                ActiveVersionSwitch {
                    workspace_id: WORKSPACE.to_owned(),
                    version_id: version_id.to_owned(),
                    root_dir: scratch.path().to_path_buf(),
                    self_writes: Arc::new(NoRecorder),
                    now_ms,
                },
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("switch to {version_id}: {error}"));
        assert_eq!(
            std::fs::read_to_string(&env_path).expect("projected secret"),
            **expected,
            "the switch to {version_id} must project that version's secret"
        );
    }

    // The WAL is part of the evidence, so the scan runs BEFORE the close: closing
    // the last connection checkpoints the WAL into the main file and normally
    // deletes it, and plaintext that reached a WAL page and was later overwritten
    // would be gone before this could look. `assert_scanned_wal` fails if that
    // ordering is ever undone.
    let scan = EngineDbScan::read(&database);
    scan.assert_secret_plaintext_absent(&main_text);
    scan.assert_secret_plaintext_absent(&feature_text);
    scan.assert_absent_in_every_form("main marker", main_marker);
    scan.assert_absent_in_every_form("feature marker", feature_marker);
    // Positive control: the ciphertext both tips hold IS in the scanned bytes.
    scan.assert_stored_ciphertext_scanned(&database);
    scan.assert_scanned_wal();

    supervisor.close(&database).expect("close");
}
