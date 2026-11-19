use dohc_engine_crypto::{SecretDataKey, create_key_file};
use dohc_engine_domain::{
    CreateNamedVersion, DomainError, SecretDelete, SecretWrite, VersionedTextStore,
};
use dohc_engine_files::{
    DurabilityPolicy, JobOutcome, MAX_CAPTURE_TEXT_BYTES, MaterializeOptions, StdBackoff,
    StdReplacer, materialize_secret_one,
};
use dohc_engine_runtime::{
    ActorHandle, CancellationToken, NoFaults, RuntimeError, SecretWriteDisk, WorkspaceSupervisor,
};
use dohc_engine_storage::{EngineStore, FaultPoint, JobStatus, Preimage, hex_sha256};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const WS: &str = "secret-queued-jobs";

struct Workspace {
    root: ScratchDir,
    db: PathBuf,
    key: SecretDataKey,
    supervisor: WorkspaceSupervisor,
}

impl Workspace {
    fn new() -> Self {
        Self::in_root(ScratchDir::new().unwrap())
    }

    fn in_root(root: ScratchDir) -> Self {
        let db = engine_db_path(&root).unwrap();
        let key = create_key_file(&root.join(".dohc/engine")).unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WS, "main", 1, &NoFaults)
            .unwrap();
        Workspace {
            root,
            db,
            key,
            supervisor: WorkspaceSupervisor::new(),
        }
    }

    fn open(&self, now_ms: i64) -> ActorHandle {
        self.supervisor.open(&self.db, now_ms).unwrap().actor
    }

    fn close(&self) {
        self.supervisor.close(&self.db).unwrap();
    }

    fn fork(&self, version: &str) {
        VersionedTextStore::new(&mut EngineStore::open(&self.db, 2).unwrap())
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: WS.into(),
                    new_version_id: version.into(),
                    name: version.into(),
                    from_version_id: "main".into(),
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    }

    async fn write(
        &self,
        actor: &ActorHandle,
        version: &str,
        path: &str,
        text: &str,
        moment: &str,
        disk: SecretWriteDisk,
    ) -> Result<bool, RuntimeError> {
        actor
            .write_secret_file(
                SecretWrite {
                    workspace_id: WS.into(),
                    version_id: version.into(),
                    path: path.into(),
                    text: text.into(),
                    moment_id: moment.into(),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 3,
                },
                disk,
                self.key.clone(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .map(|result| result.changed)
    }

    fn queue(&self) -> SecretWriteDisk {
        SecretWriteDisk::Queue {
            root_dir: self.root.path().into(),
        }
    }

    async fn delete(
        &self,
        actor: &ActorHandle,
        version: &str,
        path: &str,
        moment: &str,
    ) -> Result<(), RuntimeError> {
        actor
            .delete_secret_file(
                self.root.path().into(),
                SecretDelete {
                    workspace_id: WS.into(),
                    version_id: version.into(),
                    path: path.into(),
                    moment_id: moment.into(),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 3,
                },
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .map(|moment| assert!(moment.is_some()))
    }

    async fn apply(
        &self,
        actor: &ActorHandle,
        path: &str,
        from: &str,
        to: &str,
        moment: &str,
    ) -> Result<(), RuntimeError> {
        actor
            .apply_secret_file(
                self.root.path().into(),
                WS.into(),
                path.into(),
                from.into(),
                to.into(),
                moment.into(),
                "api".into(),
                None,
                None,
                3,
                self.key.clone(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .map(|result| assert!(result.changed))
    }

    async fn restore(
        &self,
        actor: &ActorHandle,
        path: &str,
        before: &str,
        moment: &str,
    ) -> Result<(), RuntimeError> {
        actor
            .restore_secret_file(
                self.root.path().into(),
                WS.into(),
                path.into(),
                before.into(),
                moment.into(),
                "api".into(),
                None,
                None,
                3,
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .map(|_| ())
    }

    async fn replay(&self, actor: &ActorHandle) {
        actor
            .materialize_replay_pending(self.root.path().into(), WS.into(), 5)
            .await
            .unwrap();
    }

    fn job(&self, moment: &str) -> dohc_engine_storage::MaterializationJob {
        EngineStore::open(&self.db, 6)
            .unwrap()
            .load_materialization_job(&format!("secret-mat_{moment}"))
            .unwrap()
            .unwrap_or_else(|| panic!("no job for {moment}"))
    }

    fn file(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.root.join(path)).ok()
    }

    fn names(&self) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(&self.root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name != ".dohc")
            .collect();
        names.sort();
        names
    }

    fn recorded(&self) -> usize {
        let store = EngineStore::open(&self.db, 6).unwrap();
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT (SELECT count(*) FROM secret_moments) + \
                     (SELECT count(*) FROM materialization_jobs WHERE job_id GLOB 'secret-mat_*')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
            })
            .unwrap() as usize
    }
}

fn refused(result: Result<impl std::fmt::Debug, RuntimeError>) {
    assert!(
        matches!(
            result,
            Err(RuntimeError::Domain(DomainError::InvalidPath { .. }))
        ),
        "{result:?}"
    );
}

#[tokio::test]
async fn a_skipped_older_write_removes_the_temp_its_crash_left() {
    let workspace = Workspace::new();
    let actor = workspace.open(2);
    workspace
        .write(
            &actor,
            "main",
            ".env",
            "VALUE=first\n",
            "first",
            workspace.queue(),
        )
        .await
        .unwrap();
    workspace.close();
    {
        let store = EngineStore::open(&workspace.db, 3).unwrap();
        let crash = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterFlushBeforeRename);
        let outcome = materialize_secret_one(
            &store,
            workspace.root.path(),
            &workspace.job("first"),
            b"VALUE=first\n",
            &MaterializeOptions {
                policy: DurabilityPolicy::per_os(),
                replacer: &StdReplacer,
                backoff: &StdBackoff,
                now_ms: 3,
                faults: crash.as_ref(),
                holds: None,
            },
        )
        .unwrap();
        assert!(matches!(outcome, JobOutcome::Crashed(_)), "{outcome:?}");
    }
    let names = workspace.names();
    assert!(
        names.len() == 1 && names[0].starts_with(".dohc-write-"),
        "{names:?}"
    );

    let actor = workspace.open(4);
    workspace
        .write(
            &actor,
            "main",
            ".env",
            "VALUE=second\n",
            "second",
            workspace.queue(),
        )
        .await
        .unwrap();
    workspace.replay(&actor).await;
    workspace.close();

    assert_eq!(workspace.names(), [".env"]);
    assert_eq!(workspace.file(".env").as_deref(), Some("VALUE=second\n"));
    assert_eq!(workspace.job("first").status, JobStatus::Complete);
    assert_eq!(workspace.job("second").status, JobStatus::Complete);
}

#[tokio::test]
async fn a_write_its_delete_cancels_removes_the_temp_its_crash_left() {
    let workspace = Workspace::new();
    let actor = workspace.open(2);
    workspace
        .write(
            &actor,
            "main",
            ".env",
            "VALUE=first
",
            "first",
            workspace.queue(),
        )
        .await
        .unwrap();
    workspace.close();
    {
        let store = EngineStore::open(&workspace.db, 3).unwrap();
        let crash = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterFlushBeforeRename);
        let outcome = materialize_secret_one(
            &store,
            workspace.root.path(),
            &workspace.job("first"),
            b"VALUE=first
",
            &MaterializeOptions {
                policy: DurabilityPolicy::per_os(),
                replacer: &StdReplacer,
                backoff: &StdBackoff,
                now_ms: 3,
                faults: crash.as_ref(),
                holds: None,
            },
        )
        .unwrap();
        assert!(matches!(outcome, JobOutcome::Crashed(_)), "{outcome:?}");
    }

    let actor = workspace.open(4);
    workspace
        .delete(&actor, "main", ".env", "gone")
        .await
        .unwrap();
    workspace.replay(&actor).await;
    workspace.close();

    assert!(workspace.names().is_empty(), "{:?}", workspace.names());
    assert_eq!(workspace.job("first").status, JobStatus::Complete);
}

#[tokio::test]
async fn a_respelling_after_a_cancelled_write_waits_for_the_old_spellings_delete() {
    let workspace = Workspace::new();
    if !ignores_case(&workspace.root) {
        eprintln!("skipping: this disk keeps case apart");
        return;
    }
    std::fs::write(workspace.root.join("foo.env"), "TOKEN=base").unwrap();
    let actor = workspace.open(2);
    workspace
        .write(
            &actor,
            "main",
            "foo.env",
            "TOKEN=base",
            "base",
            SecretWriteDisk::AlreadyOnDisk,
        )
        .await
        .unwrap();
    workspace
        .write(
            &actor,
            "main",
            "foo.env",
            "TOKEN=edited",
            "edited",
            workspace.queue(),
        )
        .await
        .unwrap();
    workspace
        .write(
            &actor,
            "main",
            "Foo.env",
            "TOKEN=respelled",
            "respell",
            workspace.queue(),
        )
        .await
        .unwrap();
    workspace
        .delete(&actor, "main", "foo.env", "old-spelling")
        .await
        .unwrap();
    workspace.replay(&actor).await;
    workspace.close();

    assert_eq!(workspace.names(), ["Foo.env"]);
    assert_eq!(
        workspace.file("Foo.env").as_deref(),
        Some("TOKEN=respelled")
    );
    assert_eq!(workspace.job("respell").status, JobStatus::Complete);
    assert_eq!(workspace.job("edited").status, JobStatus::Complete);
}

#[tokio::test]
async fn a_write_the_disk_already_holds_removes_the_temp_its_crash_left() {
    let workspace = Workspace::new();
    let actor = workspace.open(2);
    workspace
        .write(
            &actor,
            "main",
            ".env",
            "VALUE=first
",
            "first",
            workspace.queue(),
        )
        .await
        .unwrap();
    workspace.close();
    {
        let store = EngineStore::open(&workspace.db, 3).unwrap();
        let crash = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterFlushBeforeRename);
        let outcome = materialize_secret_one(
            &store,
            workspace.root.path(),
            &workspace.job("first"),
            b"VALUE=first
",
            &MaterializeOptions {
                policy: DurabilityPolicy::per_os(),
                replacer: &StdReplacer,
                backoff: &StdBackoff,
                now_ms: 3,
                faults: crash.as_ref(),
                holds: None,
            },
        )
        .unwrap();
        assert!(matches!(outcome, JobOutcome::Crashed(_)), "{outcome:?}");
    }
    std::fs::write(
        workspace.root.join(".env"),
        "VALUE=first
",
    )
    .unwrap();

    let actor = workspace.open(4);
    workspace.replay(&actor).await;
    workspace.close();

    assert_eq!(workspace.names(), [".env"]);
    assert_eq!(workspace.job("first").status, JobStatus::Complete);
}

#[cfg(windows)]
#[tokio::test]
async fn a_respelling_waits_while_the_old_spellings_delete_is_held_up() {
    use std::os::windows::fs::OpenOptionsExt;
    let workspace = Workspace::new();
    std::fs::write(workspace.root.join("foo.env"), "TOKEN=base").unwrap();
    let actor = workspace.open(2);
    workspace
        .write(
            &actor,
            "main",
            "foo.env",
            "TOKEN=base",
            "base",
            SecretWriteDisk::AlreadyOnDisk,
        )
        .await
        .unwrap();
    workspace
        .write(
            &actor,
            "main",
            "Foo.env",
            "TOKEN=respelled",
            "respell",
            workspace.queue(),
        )
        .await
        .unwrap();
    workspace
        .delete(&actor, "main", "foo.env", "old-spelling")
        .await
        .unwrap();

    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(workspace.root.join("foo.env"))
        .unwrap();
    workspace.replay(&actor).await;
    assert_eq!(workspace.job("respell").status, JobStatus::Pending);
    assert_eq!(workspace.file("foo.env").as_deref(), Some("TOKEN=base"));
    drop(held);

    workspace.replay(&actor).await;
    workspace.close();
    assert_eq!(workspace.names(), ["Foo.env"]);
    assert_eq!(
        workspace.file("Foo.env").as_deref(),
        Some("TOKEN=respelled")
    );
    assert_eq!(workspace.job("respell").status, JobStatus::Complete);
}

async fn inactive_version_ignores_the_active_file(block: impl Fn(&Path)) {
    let workspace = Workspace::new();
    std::fs::write(workspace.root.join(".env"), "VALUE=main\n").unwrap();
    let actor = workspace.open(2);
    workspace
        .write(
            &actor,
            "main",
            ".env",
            "VALUE=main\n",
            "main",
            SecretWriteDisk::AlreadyOnDisk,
        )
        .await
        .unwrap();
    workspace.close();
    workspace.fork("draft");
    std::fs::remove_file(workspace.root.join(".env")).unwrap();
    block(&workspace.root.join(".env"));
    let actor = workspace.open(3);

    workspace
        .write(
            &actor,
            "draft",
            ".env",
            "VALUE=draft\n",
            "d-write",
            workspace.queue(),
        )
        .await
        .unwrap();
    workspace
        .apply(&actor, ".env", "main", "draft", "d-apply")
        .await
        .unwrap();
    workspace
        .restore(&actor, ".env", "d-apply", "d-restore")
        .await
        .unwrap();
    workspace
        .delete(&actor, "draft", ".env", "d-delete")
        .await
        .unwrap();
    refused(
        workspace
            .write(
                &actor,
                "main",
                ".env",
                "VALUE=next\n",
                "m-write",
                workspace.queue(),
            )
            .await,
    );
    workspace.close();
}

#[tokio::test]
async fn an_inactive_version_changes_while_the_active_file_is_a_folder() {
    inactive_version_ignores_the_active_file(|path| std::fs::create_dir(path).unwrap()).await;
}

#[tokio::test]
async fn an_inactive_version_changes_while_the_active_file_is_too_large() {
    inactive_version_ignores_the_active_file(|path| {
        std::fs::write(path, vec![b'a'; MAX_CAPTURE_TEXT_BYTES as usize + 1]).unwrap()
    })
    .await;
}

#[tokio::test]
async fn an_unchanged_write_ignores_what_the_disk_holds() {
    let workspace = Workspace::new();
    std::fs::write(workspace.root.join(".env"), "VALUE=same\n").unwrap();
    let actor = workspace.open(2);
    workspace
        .write(
            &actor,
            "main",
            ".env",
            "VALUE=same\n",
            "first",
            SecretWriteDisk::AlreadyOnDisk,
        )
        .await
        .unwrap();
    std::fs::remove_file(workspace.root.join(".env")).unwrap();
    std::fs::create_dir(workspace.root.join(".env")).unwrap();
    let recorded = workspace.recorded();

    let changed = workspace
        .write(
            &actor,
            "main",
            ".env",
            "VALUE=same\n",
            "again",
            workspace.queue(),
        )
        .await
        .unwrap();
    workspace.close();

    assert!(!changed);
    assert_eq!(workspace.recorded(), recorded);
}

#[tokio::test]
async fn a_refused_write_records_nothing() {
    let workspace = Workspace::new();
    std::fs::write(workspace.root.join(".env"), [0xff, 0xfe, b'\n']).unwrap();
    let actor = workspace.open(2);

    refused(
        workspace
            .write(
                &actor,
                "main",
                ".env",
                "VALUE=new\n",
                "new",
                workspace.queue(),
            )
            .await,
    );
    workspace.close();

    assert_eq!(workspace.recorded(), 0);
    assert_eq!(
        std::fs::read(workspace.root.join(".env")).unwrap(),
        [0xff, 0xfe, b'\n']
    );
}

async fn fence_settles_a_conflict(delete: bool) {
    let workspace = Workspace::new();
    let actor = workspace.open(2);
    if delete {
        std::fs::write(workspace.root.join(".env"), "VALUE=first\n").unwrap();
        workspace
            .write(
                &actor,
                "main",
                ".env",
                "VALUE=first\n",
                "first",
                SecretWriteDisk::AlreadyOnDisk,
            )
            .await
            .unwrap();
        workspace
            .delete(&actor, "main", ".env", "queued")
            .await
            .unwrap();
    } else {
        workspace
            .write(
                &actor,
                "main",
                ".env",
                "VALUE=queued\n",
                "queued",
                workspace.queue(),
            )
            .await
            .unwrap();
    }
    std::fs::write(workspace.root.join(".env"), "VALUE=edited\n").unwrap();

    actor
        .materialize_replay_pending_for_fence(
            workspace.root.path().into(),
            WS.into(),
            Arc::new(()),
            4,
        )
        .await
        .unwrap();
    workspace.close();

    assert_eq!(workspace.file(".env").as_deref(), Some("VALUE=edited\n"));
    assert_eq!(workspace.names(), [".env"]);
    assert_eq!(workspace.job("queued").status, JobStatus::Conflict);
}

#[tokio::test]
async fn a_fence_settles_a_protected_write_over_a_newer_edit() {
    fence_settles_a_conflict(false).await;
}

#[tokio::test]
async fn a_fence_settles_a_protected_delete_of_a_newer_edit() {
    fence_settles_a_conflict(true).await;
}

fn ignores_case(root: &Path) -> bool {
    std::fs::write(root.join("probe.md"), "probe").unwrap();
    let ignores_case = std::fs::metadata(root.join("PROBE.md")).is_ok();
    std::fs::remove_file(root.join("probe.md")).unwrap();
    ignores_case
}

#[tokio::test]
async fn another_versions_pending_delete_leaves_the_file_in_place() {
    let workspace = Workspace::new();
    if !ignores_case(&workspace.root) {
        eprintln!("skipping: this disk keeps case apart");
        return;
    }
    std::fs::write(workspace.root.join("foo.env"), "TOKEN=base").unwrap();
    let actor = workspace.open(2);
    workspace
        .write(
            &actor,
            "main",
            "foo.env",
            "TOKEN=base",
            "base",
            SecretWriteDisk::AlreadyOnDisk,
        )
        .await
        .unwrap();
    workspace.close();
    workspace.fork("draft");
    workspace.fork("empty");
    let actor = workspace.open(3);
    workspace
        .delete(&actor, "empty", "foo.env", "empty-delete")
        .await
        .unwrap();
    workspace
        .apply(&actor, "foo.env", "empty", "draft", "draft-delete")
        .await
        .unwrap();
    let base = Preimage::Present(hex_sha256(b"TOKEN=base"));
    assert_eq!(workspace.job("draft-delete").preimage, base);

    workspace
        .write(
            &actor,
            "main",
            "Foo.env",
            "TOKEN=target",
            "respell",
            workspace.queue(),
        )
        .await
        .unwrap();
    workspace.close();

    assert_eq!(workspace.job("respell").preimage, base);
}

async fn case_sensitive_merge(delete_first: bool) {
    let root = ScratchDir::new().unwrap();
    #[cfg(windows)]
    {
        let status = std::process::Command::new("fsutil")
            .args(["file", "setCaseSensitiveInfo"])
            .arg(root.path())
            .arg("enable")
            .output()
            .unwrap();
        assert!(status.status.success(), "{status:?}");
    }
    if ignores_case(&root) {
        eprintln!("skipping: this disk ignores case");
        return;
    }
    let workspace = Workspace::in_root(root);
    let actor = workspace.open(2);
    for path in ["foo.env", "Foo.env"] {
        std::fs::write(workspace.root.join(path), "TOKEN=base").unwrap();
        workspace
            .write(
                &actor,
                "main",
                path,
                "TOKEN=base",
                &format!("base-{path}"),
                SecretWriteDisk::AlreadyOnDisk,
            )
            .await
            .unwrap();
    }
    workspace.close();
    workspace.fork("draft");
    let actor = workspace.open(3);
    workspace
        .delete(&actor, "draft", "foo.env", "draft-delete")
        .await
        .unwrap();
    workspace
        .write(
            &actor,
            "draft",
            "Foo.env",
            "TOKEN=target",
            "draft-write",
            workspace.queue(),
        )
        .await
        .unwrap();
    let paths = if delete_first {
        ["foo.env", "Foo.env"]
    } else {
        ["Foo.env", "foo.env"]
    };
    for path in paths {
        workspace
            .apply(&actor, path, "draft", "main", &format!("merge-{path}"))
            .await
            .unwrap();
    }
    let base = Preimage::Present(hex_sha256(b"TOKEN=base"));
    assert_eq!(workspace.job("merge-foo.env").preimage, base);
    assert_eq!(workspace.job("merge-Foo.env").preimage, base);

    workspace.replay(&actor).await;
    workspace.close();

    assert_eq!(workspace.names(), ["Foo.env"]);
    assert_eq!(workspace.file("Foo.env").as_deref(), Some("TOKEN=target"));
    assert_eq!(workspace.job("merge-foo.env").status, JobStatus::Complete);
    assert_eq!(workspace.job("merge-Foo.env").status, JobStatus::Complete);
}

#[tokio::test]
async fn a_case_sensitive_merge_keeps_two_files_apart() {
    case_sensitive_merge(false).await;
}

#[tokio::test]
async fn a_case_sensitive_merge_deleting_first_keeps_two_files_apart() {
    case_sensitive_merge(true).await;
}
