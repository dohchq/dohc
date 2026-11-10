use dohc_engine_collab::{ContentKind, Regime, Ydoc, read_marker};
use dohc_engine_crypto::create_key_file;
use dohc_engine_domain::{
    CreateNamedVersion, SecretDelete, SecretDiskIntent, SecretWrite, VersionedTextStore, WriteText,
};
use dohc_engine_runtime::{
    ActiveVersionSwitch, CancellationToken, CaptureIngestBinary, NoFaults, RuntimeError,
    WorkspaceSupervisor,
};
use dohc_engine_storage::{
    EngineStore, FaultAction, FaultInjector, FaultPoint, StorageError, TxnOutcome,
    capture_file_holds::{self, CaptureFileHold},
};
use dohc_engine_testkit::{EngineDbScan, ScratchDir, ScriptedFaults, engine_db_path};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const WORKSPACE: &str = "ws-switch-ordering";

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
async fn binary_head_retires_its_ydoc_lineage_before_the_unsettled_scan() {
    const WS: &str = "ws-binary-unsettled";
    const PATH: &str = "notes/binary.md";
    let scratch = ScratchDir::new().expect("scratch");
    let database = engine_db_path(&scratch).expect("database");
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
            None,
            None,
            true,
            None,
            None,
            3,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
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
            dohc_engine_collab::LeaseRegistry::new(),
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
    assert_eq!(
        content_kind, None,
        "a binary artifact has no live text lineage to block a version operation"
    );
    supervisor.close(&database).expect("close actor");
    let store = EngineStore::open(&database, 5).expect("inspect retired lineage");
    assert_eq!(
        read_marker(&store, &open.key).expect("read Y.Doc marker"),
        None,
        "the binary capture and lineage retirement must commit together"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pathless_settled_scene_is_not_reported_as_unsettled() {
    const WS: &str = "ws-pathless-settled-scene";
    const PATH: &str = "drawings/settled.excalidraw";
    const OBJECT: &str = "pathless-scene-object";
    let scratch = ScratchDir::new().expect("scratch");
    let database = engine_db_path(&scratch).expect("database");
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
    let scratch = ScratchDir::new().expect("scratch");
    let database = engine_db_path(&scratch).expect("database");
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
                self_writes: Arc::new(()),
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
    let database = engine_db_path(&scratch).expect("database");
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
    let key = create_key_file(&scratch.path().join(".dohc/engine")).expect("secret key");
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
    let key = dohc_engine_crypto::load_key_file(&scratch.path().join(".dohc/engine"))
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
                self_writes: Arc::new(()),
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
    let database = engine_db_path(&scratch).expect("database");
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
    let key = create_key_file(&scratch.path().join(".dohc/engine")).expect("secret key");
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
                self_writes: Arc::new(()),
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
    let database = engine_db_path(&first_root).expect("database");
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
                    self_writes: Arc::new(()),
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
    let database = engine_db_path(&scratch).expect("database");
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
                self_writes: Arc::new(()),
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

/// Seal one secret into `version_id` at `path`.
#[allow(
    clippy::too_many_arguments,
    reason = "each secret fixture field varies"
)]
async fn write_secret(
    actor: &dohc_engine_runtime::ActorHandle,
    version_id: &str,
    path: &str,
    text: &str,
    moment_id: &str,
    now_ms: i64,
    key: dohc_engine_crypto::SecretDataKey,
    disk_intent: SecretDiskIntent,
) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    let mut delay = std::time::Duration::from_millis(5);
    loop {
        let result = actor
            .write_secret_file(
                SecretWrite {
                    workspace_id: WORKSPACE.to_owned(),
                    version_id: version_id.to_owned(),
                    path: path.to_owned(),
                    text: text.to_owned(),
                    moment_id: moment_id.to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms,
                    disk_intent,
                },
                key.clone(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await;
        match result {
            Ok(_) => return,
            Err(dohc_engine_runtime::RuntimeError::Storage(
                dohc_engine_storage::StorageError::FileLocked,
            ))
            | Err(dohc_engine_runtime::RuntimeError::Domain(
                dohc_engine_domain::DomainError::Storage(
                    dohc_engine_storage::StorageError::FileLocked,
                ),
            )) => {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                assert!(
                    !remaining.is_zero(),
                    "secret fixture stayed busy until its deadline"
                );
                tokio::time::sleep(delay.min(remaining)).await;
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "secret fixture stayed busy until its deadline"
                );
                delay = (delay * 2).min(std::time::Duration::from_millis(200));
            }
            Err(error) => panic!("secret fixture failed: {error:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plaintext_never_leaks_across_a_version_switch_and_back() {
    // A switch is the one place the engine holds a secret plaintext outside a
    // write: `plan_secret_switch` decrypts the target tip to compare it with the
    // file on disk. The projection it plans must still reference the stored
    // CIPHERTEXT, so the plaintext lives only in memory and on the projected
    // file — never in the database.
    //
    //
    // Planning the projection with the plaintext INLINE also fails this test,
    // but for the wrong reason: the secret executor then cannot decrypt what it
    // was handed, so the switch itself errors before the scan runs.
    let scratch = ScratchDir::new().expect("scratch");
    let database = engine_db_path(&scratch).expect("database");
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

    let key = create_key_file(&scratch.path().join(".dohc/engine")).expect("secret key");
    write_secret(
        &actor,
        "main",
        ".env",
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
    let key = dohc_engine_crypto::load_key_file(&scratch.path().join(".dohc/engine"))
        .expect("load key")
        .expect("key exists");
    write_secret(
        &actor,
        "feature",
        ".env",
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
                    self_writes: Arc::new(()),
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

    // The WAL is part of the evidence, so the scan runs before the close: closing
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

// dohc#3112. A crash before a switch writes a captured secret leaves the write
// pending with no file. The capture seed at the next start leaves the secret
// out, so the first scan doesn't record it as deleted, and replay writes it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_secret_the_switch_has_not_written_stays_out_of_the_capture_seed() {
    let scratch = ScratchDir::new().expect("scratch");
    let database = engine_db_path(&scratch).expect("database");
    let env = scratch.path().join(".env");
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
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 2,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature");
    let key = create_key_file(&scratch.path().join(".dohc/engine")).expect("secret key");
    actor
        .capture_secret(
            dohc_engine_domain::CaptureSecret {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "feature".to_owned(),
                path: ".env".to_owned(),
                text: "TOKEN=feature\n".to_owned(),
                metadata_origin: "local-file".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 3,
                claim_foreign_head: true,
            },
            key,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("captured secret");
    let seeded = |actor: dohc_engine_runtime::ActorHandle| async move {
        actor
            .capture_manifest_seed(WORKSPACE.to_owned(), "feature".to_owned())
            .await
            .expect("seed")
            .iter()
            .any(|entry| entry.path == ".env")
    };
    assert!(seeded(actor.clone()).await, "a captured secret is seeded");

    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "feature".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(()),
                now_ms: 4,
            },
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("the crash fails the switch");
    assert!(faults.fired(), "the secret write starts");
    supervisor.close(&database).expect("close");
    assert!(!env.exists());
    let pending: i64 = Connection::open(&database)
        .expect("sqlite")
        .query_row(
            "SELECT COUNT(*) FROM materialization_jobs \
             WHERE target_path = '.env' AND status = 'pending'",
            [],
            |row| row.get(0),
        )
        .expect("pending jobs");
    assert_eq!(pending, 1, "the secret write waits for replay");

    let actor = supervisor.open(&database, 5).expect("reopen").actor;
    assert!(
        !seeded(actor.clone()).await,
        "an unwritten secret stays out of the seed"
    );
    actor
        .materialize_replay_pending(scratch.path().to_path_buf(), WORKSPACE.to_owned(), 6)
        .await
        .expect("replay");
    assert_eq!(
        std::fs::read_to_string(&env).expect("written secret"),
        "TOKEN=feature\n"
    );
    assert!(seeded(actor).await, "a written secret is seeded again");
    supervisor.close(&database).expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switch_leaves_the_same_bytes_alone_when_only_their_kind_differs() {
    const WS: &str = "ws-switch-kind-only";
    const PATH: &str = "trip/automations.yaml";
    const BYTES: &[u8] = b"version: 1\nautomations: []\n";
    let scratch = ScratchDir::new().expect("scratch");
    let database = engine_db_path(&scratch).expect("database");
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
    // A Collection file stored as binary before capture read it as text. The
    // disk probe now reads the same bytes as text.
    actor
        .capture_ingest_binary(
            CaptureIngestBinary {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: PATH.to_owned(),
                bytes: BYTES.to_vec(),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
                claim_foreign_head: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("binary head");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WS.to_owned(),
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
    std::fs::create_dir_all(scratch.path().join("trip")).expect("trip folder");
    std::fs::write(scratch.path().join(PATH), BYTES).expect("disk");

    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WS.to_owned(),
                version_id: "feature".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(()),
                now_ms: 1_700_000_000_000,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("switch");

    assert_eq!(
        std::fs::read(scratch.path().join(PATH)).expect("disk"),
        BYTES
    );
    supervisor.close(&database).expect("close");
    let connection = Connection::open(&database).expect("sqlite");
    let jobs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM materialization_jobs \
             WHERE job_id LIKE 'version-switch-mat_%' AND target_path = ?1",
            [PATH],
            |row| row.get(0),
        )
        .expect("switch jobs");
    assert_eq!(jobs, 0, "equal bytes need no switch write");
}

/// `main` has `plans/trip.md` on disk and `later` has a file at `plans`,
/// before the switch to `later`.
struct FolderToFile {
    scratch: ScratchDir,
    database: PathBuf,
    supervisor: WorkspaceSupervisor,
    actor: dohc_engine_runtime::ActorHandle,
    workspace_id: String,
}

impl FolderToFile {
    fn plans(&self) -> PathBuf {
        self.scratch.path().join("plans")
    }

    async fn switch(&self, faults: Arc<dyn FaultInjector>) -> Result<(), RuntimeError> {
        self.actor
            .set_active_version(
                ActiveVersionSwitch {
                    workspace_id: self.workspace_id.clone(),
                    version_id: "later".to_owned(),
                    root_dir: self.scratch.path().to_path_buf(),
                    self_writes: Arc::new(()),
                    now_ms: 5,
                },
                faults,
                CancellationToken::new(),
            )
            .await
            .map(drop)
    }

    /// Close the workspace, which releases the database to read its jobs.
    fn close(&self) {
        self.supervisor.close(&self.database).expect("close");
    }

    /// Open the closed workspace and replay every pending job, as at start.
    async fn reopen_and_replay(&mut self, now_ms: i64) {
        self.actor = self
            .supervisor
            .open(&self.database, now_ms)
            .expect("reopen")
            .actor;
        self.actor
            .materialize_replay_pending(
                self.scratch.path().to_path_buf(),
                self.workspace_id.clone(),
                now_ms,
            )
            .await
            .expect("replay");
    }
}

/// The switch jobs at `path` still waiting to run.
fn pending_switch_jobs(database: &std::path::Path, path: &str) -> i64 {
    Connection::open(database)
        .expect("sqlite")
        .query_row(
            "SELECT COUNT(*) FROM materialization_jobs \
             WHERE job_id GLOB 'version-switch-*' AND target_path = ?1 \
             AND status = 'pending'",
            [path],
            |row| row.get(0),
        )
        .expect("switch jobs")
}

/// Switch to `later`, with `untracked` also in the folder when given.
async fn switch_folder_to_file(
    workspace_id: &str,
    untracked: Option<&str>,
) -> (ScratchDir, PathBuf) {
    let fixture = folder_to_file(workspace_id).await;
    if let Some(name) = untracked {
        std::fs::write(fixture.plans().join(name), "mine\n").expect("untracked");
    }
    fixture.switch(Arc::new(NoFaults)).await.expect("switch");
    fixture.close();
    (fixture.scratch, fixture.database)
}

async fn folder_to_file(workspace_id: &str) -> FolderToFile {
    let scratch = ScratchDir::new().expect("scratch");
    let database = engine_db_path(&scratch).expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 1).expect("actor").actor;
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
        .create_named_version(
            CreateNamedVersion {
                workspace_id: workspace_id.to_owned(),
                new_version_id: "later".to_owned(),
                name: "Later".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 2,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("later");
    for (version_id, path, text, moment_id, now_ms) in [
        ("later", "plans", "target\n", "folder-to-file-later", 3),
        ("main", "plans/trip.md", "trip\n", "folder-to-file-main", 4),
    ] {
        actor
            .versioned_text_write(
                write_for(workspace_id, version_id, path, text, moment_id, now_ms),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("write");
    }
    std::fs::create_dir_all(scratch.path().join("plans")).expect("plans folder");
    std::fs::write(scratch.path().join("plans/trip.md"), "trip\n").expect("trip");
    FolderToFile {
        scratch,
        database,
        supervisor,
        actor,
        workspace_id: workspace_id.to_owned(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_a_folder_to_a_same_named_file_places_the_file() {
    let (scratch, _) = switch_folder_to_file("ws-folder-to-file", None).await;
    let plans = scratch.path().join("plans");
    assert!(plans.is_file(), "the folder gives way to the file");
    assert_eq!(std::fs::read_to_string(plans).expect("plans"), "target\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_untracked_file_keeps_its_folder_and_the_file_unwritten() {
    // The helper expects the switch to succeed.
    let (scratch, database) =
        switch_folder_to_file("ws-folder-keeps-untracked", Some("notes.txt")).await;
    let plans = scratch.path().join("plans");
    assert!(plans.is_dir(), "a folder with an untracked file stays");
    assert_eq!(
        std::fs::read_to_string(plans.join("notes.txt")).expect("untracked"),
        "mine\n"
    );
    assert!(
        !plans.join("trip.md").exists(),
        "the switch deletes main's file"
    );
    let connection = Connection::open(&database).expect("sqlite");
    let jobs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM materialization_jobs \
             WHERE job_id GLOB 'version-switch-*' AND target_path = 'plans'",
            [],
            |row| row.get(0),
        )
        .expect("switch jobs");
    assert_eq!(jobs, 0, "no write of the file waits for the folder");
}

// On a disk that tells names apart by case, deleting `trip.md` leaves an
// untracked `TRIP.md`, which keeps the folder.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_differing_only_in_case_keeps_its_folder() {
    let (scratch, database) =
        switch_folder_to_file("ws-folder-keeps-case-twin", Some("TRIP.md")).await;
    let plans = scratch.path().join("plans");
    assert!(plans.is_dir(), "a folder with an untracked file stays");
    assert_eq!(
        std::fs::read_to_string(plans.join("TRIP.md")).expect("untracked"),
        "mine\n"
    );
    let connection = Connection::open(&database).expect("sqlite");
    let jobs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM materialization_jobs \
             WHERE job_id GLOB 'version-switch-*' AND target_path = 'plans'",
            [],
            |row| row.get(0),
        )
        .expect("switch jobs");
    assert_eq!(jobs, 0, "no write of the file waits for the folder");
}

// Only macOS removes a folder that Finder's files alone keep. Elsewhere such
// a file keeps the folder like any other.
#[cfg(not(target_vendor = "apple"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_os_metadata_file_keeps_its_folder_off_macos() {
    let (scratch, database) =
        switch_folder_to_file("ws-folder-keeps-metadata", Some(".DS_Store")).await;
    let plans = scratch.path().join("plans");
    assert!(plans.is_dir(), "a folder this platform cannot remove stays");
    assert!(plans.join(".DS_Store").is_file());
    let connection = Connection::open(&database).expect("sqlite");
    let jobs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM materialization_jobs \
             WHERE job_id GLOB 'version-switch-*' AND target_path = 'plans'",
            [],
            |row| row.get(0),
        )
        .expect("switch jobs");
    assert_eq!(jobs, 0, "no write of the file waits for the folder");
}

#[cfg(target_vendor = "apple")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn finder_metadata_lets_its_folder_become_a_file_on_macos() {
    let (scratch, _) = switch_folder_to_file("ws-folder-drops-metadata", Some(".DS_Store")).await;
    let plans = scratch.path().join("plans");
    assert!(plans.is_file(), "the folder gives way to the file");
    assert_eq!(std::fs::read_to_string(plans).expect("plans"), "target\n");
}

// The folder and the file need not be the same kind. Every path inside a
// `.env` folder is a secret, but a folder named `deploy.env` can hold plain
// files. A stray file keeps the folder whatever the kinds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_gives_way_to_a_file_of_either_kind_only_when_the_switch_clears_it() {
    for (folder, folder_secret, inner, inner_secret, stray) in [
        (".env", true, ".env/trip", true, false),
        ("keys", false, "keys/.env", true, false),
        ("deploy.env", true, "deploy.env/notes.md", false, false),
        ("keys", false, "keys/.env", true, true),
        ("deploy.env", true, "deploy.env/notes.md", false, true),
    ] {
        let scratch = ScratchDir::new().expect("scratch");
        let database = engine_db_path(&scratch).expect("database");
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
            .create_named_version(
                CreateNamedVersion {
                    workspace_id: WORKSPACE.to_owned(),
                    new_version_id: "later".to_owned(),
                    name: "Later".to_owned(),
                    from_version_id: "main".to_owned(),
                    now_ms: 2,
                    request_id: None,
                },
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("later");
        let key_dir = scratch.path().join(".dohc/engine");
        create_key_file(&key_dir).expect("secret key");
        for (version_id, path, secret, text, disk_intent, now_ms) in [
            (
                "later",
                folder,
                folder_secret,
                "MODE=later\n",
                SecretDiskIntent::Materialize,
                3,
            ),
            (
                "main",
                inner,
                inner_secret,
                "TRIP=main\n",
                SecretDiskIntent::AlreadyOnDisk,
                4,
            ),
        ] {
            let moment_id = format!("folder-to-file-{version_id}-{now_ms}");
            if secret {
                let key = dohc_engine_crypto::load_key_file(&key_dir)
                    .expect("load key")
                    .expect("key exists");
                write_secret(
                    &actor,
                    version_id,
                    path,
                    text,
                    &moment_id,
                    now_ms,
                    key,
                    disk_intent,
                )
                .await;
            } else {
                actor
                    .versioned_text_write(
                        write_for(WORKSPACE, version_id, path, text, &moment_id, now_ms),
                        Arc::new(NoFaults),
                        CancellationToken::new(),
                    )
                    .await
                    .expect("write");
            }
        }
        std::fs::create_dir_all(scratch.path().join(folder)).expect("folder");
        std::fs::write(scratch.path().join(inner), "TRIP=main\n").expect("inner file");
        let stray_file = scratch.path().join(folder).join("stray.txt");
        if stray {
            std::fs::write(&stray_file, "mine\n").expect("stray file");
        }
        actor
            .set_active_version(
                ActiveVersionSwitch {
                    workspace_id: WORKSPACE.to_owned(),
                    version_id: "later".to_owned(),
                    root_dir: scratch.path().to_path_buf(),
                    self_writes: Arc::new(()),
                    now_ms: 5,
                },
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("switch");
        supervisor.close(&database).expect("close");
        let file = scratch.path().join(folder);
        if stray {
            assert!(file.is_dir(), "a stray file keeps the folder {folder}");
            assert_eq!(
                std::fs::read_to_string(&stray_file).expect("stray"),
                "mine\n"
            );
        } else {
            assert!(file.is_file(), "the folder {folder} gives way to the file");
            assert_eq!(std::fs::read_to_string(file).expect(folder), "MODE=later\n");
        }
        let connection = Connection::open(&database).expect("sqlite");
        let pending: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM materialization_jobs \
                 WHERE job_id GLOB 'version-switch-*' AND target_path = ?1 \
                 AND status = 'pending'",
                [folder],
                |row| row.get(0),
            )
            .expect("switch jobs");
        assert_eq!(pending, 0, "the write over {folder} does not wait");
    }
}

/// Crashes the first job that starts once `inner` is gone, which is the
/// write of the file after the switch deleted what was in its folder.
struct CrashOnceGone {
    inner: PathBuf,
    fired: AtomicBool,
}

impl FaultInjector for CrashOnceGone {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::MaterializeAfterJobCommit
            && !self.inner.exists()
            && !self.fired.swap(true, Ordering::AcqRel)
        {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crash_between_the_folder_deletes_and_the_write_finishes_at_the_next_start() {
    let mut fixture = folder_to_file("ws-folder-to-file-crash").await;
    let plans = fixture.plans();
    let faults = Arc::new(CrashOnceGone {
        inner: plans.join("trip.md"),
        fired: AtomicBool::new(false),
    });
    let error = fixture
        .switch(faults.clone())
        .await
        .expect_err("the crash fails the switch");
    assert!(
        matches!(
            error,
            RuntimeError::ActiveVersionMaterializationIncomplete { .. }
        ),
        "{error:?}"
    );
    assert!(
        faults.fired.load(Ordering::Acquire),
        "the write starts after the deletes"
    );
    fixture.close();
    assert!(
        !plans.join("trip.md").exists(),
        "the switch deleted main's file"
    );
    assert!(!plans.is_file(), "the file is not written yet");
    assert_eq!(pending_switch_jobs(&fixture.database, "plans"), 1);

    fixture.reopen_and_replay(6).await;
    fixture.close();
    assert!(plans.is_file(), "the replay places the file");
    assert_eq!(std::fs::read_to_string(&plans).expect("plans"), "target\n");
    assert_eq!(pending_switch_jobs(&fixture.database, "plans"), 0);
}

// Content that lands in the folder after planning, with no hold over it,
// keeps the file's write waiting. Each full replay, as at the next start,
// checks again, and places the file once the folder clears.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_waiting_on_late_content_is_placed_by_the_next_full_replay() {
    let mut fixture = folder_to_file("ws-folder-late-content").await;
    let plans = fixture.plans();
    let late = plans.join("late.txt");
    // The first job is the delete of `plans/trip.md`.
    let faults = Arc::new(RewriteAtJobStart::new(late.clone(), b"late\n"));
    fixture.switch(faults.clone()).await.expect("switch");
    assert!(
        faults.fired.load(Ordering::Acquire),
        "content lands after planning"
    );
    fixture.close();
    assert!(plans.is_dir(), "late content keeps the folder");
    assert_eq!(
        pending_switch_jobs(&fixture.database, "plans"),
        1,
        "the write waits"
    );

    fixture.reopen_and_replay(6).await;
    fixture.close();
    assert_eq!(std::fs::read_to_string(&late).expect("late"), "late\n");
    assert_eq!(
        pending_switch_jobs(&fixture.database, "plans"),
        1,
        "still waiting"
    );

    std::fs::remove_file(&late).expect("move the late file away");
    fixture.reopen_and_replay(7).await;
    fixture.close();
    assert!(plans.is_file(), "the replay places the file");
    assert_eq!(std::fs::read_to_string(&plans).expect("plans"), "target\n");
    assert_eq!(pending_switch_jobs(&fixture.database, "plans"), 0);
}

// A link never clears a folder. Windows gets a junction, which needs no
// privilege to make.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_link_keeps_its_folder_and_the_file_unwritten() {
    let fixture = folder_to_file("ws-folder-keeps-link").await;
    // An empty target, so a switch that followed the link would find nothing
    // there to keep the folder.
    let elsewhere = fixture.scratch.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).expect("elsewhere");
    let link = fixture.plans().join("link");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&elsewhere, &link).expect("link");
    #[cfg(windows)]
    assert!(
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&elsewhere)
            .status()
            .expect("mklink")
            .success(),
        "junction"
    );
    fixture.switch(Arc::new(NoFaults)).await.expect("switch");
    fixture.close();
    let plans = fixture.plans();
    assert!(plans.is_dir(), "a folder with a link stays");
    assert!(
        std::fs::symlink_metadata(&link)
            .expect("link")
            .file_type()
            .is_symlink(),
        "the link stays a link"
    );
    assert!(elsewhere.is_dir(), "the link's target stays");
    assert_eq!(pending_switch_jobs(&fixture.database, "plans"), 0);
}

// A tracked file the switch leaves alone, here because policy no longer
// tracks it, keeps its folder.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_the_switch_leaves_alone_keeps_its_folder() {
    let fixture = folder_to_file("ws-folder-keeps-policy").await;
    let dohc = fixture.scratch.path().join(".dohc");
    std::fs::create_dir_all(&dohc).expect(".dohc");
    std::fs::write(
        dohc.join("files.toml"),
        "version = 1\n[[rule]]\npath = \"plans/trip.md\"\ntracked = false\n",
    )
    .expect("policy");
    fixture.switch(Arc::new(NoFaults)).await.expect("switch");
    fixture.close();
    let plans = fixture.plans();
    assert!(plans.is_dir(), "the folder stays");
    assert_eq!(
        std::fs::read_to_string(plans.join("trip.md")).expect("trip"),
        "trip\n"
    );
    assert_eq!(pending_switch_jobs(&fixture.database, "plans"), 0);
}

// A held plain file keeps its folder from a secret write, and the secret
// write does not wait for the hold.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_plain_file_keeps_its_folder_from_a_secret_write() {
    let scratch = ScratchDir::new().expect("scratch");
    let database = engine_db_path(&scratch).expect("database");
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
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "later".to_owned(),
                name: "Later".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 2,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("later");
    let key_dir = scratch.path().join(".dohc/engine");
    create_key_file(&key_dir).expect("secret key");
    let key = dohc_engine_crypto::load_key_file(&key_dir)
        .expect("load key")
        .expect("key exists");
    write_secret(
        &actor,
        "later",
        "deploy.env",
        "MODE=later\n",
        "held-folder-later",
        3,
        key,
        SecretDiskIntent::Materialize,
    )
    .await;
    let inner = "deploy.env/notes.md";
    actor
        .versioned_text_write(
            write_for(WORKSPACE, "main", inner, "notes\n", "held-folder-main", 4),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main write");
    supervisor.close(&database).expect("close");
    // Capture holds the file: the bytes on disk are ones it could not record.
    let outside = "edited outside\n";
    let mut store = EngineStore::open(&database, 5).expect("store");
    store
        .write_with(&NoFaults, |tx| {
            capture_file_holds::record_in(
                tx,
                &CaptureFileHold {
                    workspace_id: WORKSPACE.to_owned(),
                    source_version_id: "main".to_owned(),
                    object_id: format!("switch-object-{WORKSPACE}-{inner}"),
                    path: inner.to_owned(),
                    observed_sha256: dohc_engine_storage::hex_sha256(outside.as_bytes()),
                    observed_size: outside.len() as u64,
                    reason: capture_file_holds::NOT_REPRESENTABLE.to_owned(),
                    observed_at_ms: 5,
                    attempt_count: 1,
                    retry_requested: false,
                },
            )
        })
        .expect("hold");
    drop(store);
    let folder = scratch.path().join("deploy.env");
    std::fs::create_dir_all(&folder).expect("folder");
    std::fs::write(scratch.path().join(inner), outside).expect("held file");
    let actor = supervisor.open(&database, 6).expect("reopen").actor;
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "later".to_owned(),
                root_dir: scratch.path().to_path_buf(),
                self_writes: Arc::new(()),
                now_ms: 7,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("switch");
    supervisor.close(&database).expect("close");
    assert!(folder.is_dir(), "the hold keeps the folder");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(inner)).expect("held file"),
        outside
    );
    assert_eq!(
        pending_switch_jobs(&database, "deploy.env"),
        0,
        "the secret write does not wait"
    );
}
