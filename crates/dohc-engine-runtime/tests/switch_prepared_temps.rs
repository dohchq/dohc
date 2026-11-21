use dohc_engine_domain::{CaptureIngest, CreateNamedVersion, VersionedTextStore};
use dohc_engine_runtime::{ActiveVersionSwitch, CancellationToken, NoFaults, WorkspaceSupervisor};
use dohc_engine_storage::{EngineStore, FaultPoint};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const WS: &str = "ws-switch-prepared";
const MAIN: [(&str, &str); 2] = [("a.txt", "main a\n"), ("docs/b.txt", "main b\n")];
const TARGET: [(&str, &str); 3] = [
    ("a.txt", "target a\n"),
    ("docs/b.txt", "target b\n"),
    ("new/deep/c.txt", "target c\n"),
];

fn seed(store: &mut EngineStore, version: &str, path: &str, text: &str, now: i64) {
    VersionedTextStore::new(store)
        .capture_ingest(
            &CaptureIngest {
                workspace_id: WS.into(),
                version_id: version.into(),
                path: path.into(),
                text: text.into(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: now,
                request_id: None,
                claim_foreign_head: false,
            },
            &NoFaults,
        )
        .unwrap();
}

fn fixture() -> ScratchDir {
    let scratch = ScratchDir::new().unwrap();
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .unwrap();
    for (path, text) in MAIN {
        seed(&mut store, "main", path, text, 2);
        let file = scratch.path().join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }
    VersionedTextStore::new(&mut store)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: WS.into(),
                new_version_id: "target".into(),
                name: "Target".into(),
                from_version_id: "main".into(),
                now_ms: 3,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    for (path, text) in TARGET {
        seed(&mut store, "target", path, text, 4);
    }
    scratch
}

fn switch(scratch: &ScratchDir, version: &str, now: i64) -> ActiveVersionSwitch {
    ActiveVersionSwitch {
        workspace_id: WS.into(),
        version_id: version.into(),
        root_dir: scratch.path().to_path_buf(),
        self_writes: Arc::new(()),
        now_ms: now,
    }
}

/// Every temp a write left beside the workspace's files.
fn temps(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut folders = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if path.is_dir() {
                if name != ".dohc" {
                    folders.push(path);
                }
            } else if name.starts_with(".dohc-write-") {
                found.push(path);
            }
        }
    }
    found
}

fn assert_files(root: &Path, files: &[(&str, &str)]) {
    for (path, text) in files {
        assert_eq!(
            std::fs::read_to_string(root.join(path)).unwrap(),
            *text,
            "{path}"
        );
    }
}

#[tokio::test]
async fn a_switch_places_every_file_and_leaves_no_temp() {
    let scratch = fixture();
    let database = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 5).unwrap().actor;
    actor
        .set_active_version(
            switch(&scratch, "target", 6),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_files(scratch.path(), &TARGET);
    assert_eq!(temps(scratch.path()), Vec::<PathBuf>::new());
    actor
        .set_active_version(
            switch(&scratch, "main", 7),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_files(scratch.path(), &MAIN);
    assert!(!scratch.path().join("new/deep/c.txt").exists());
    assert_eq!(temps(scratch.path()), Vec::<PathBuf>::new());
    supervisor.close(&database).unwrap();
}

#[tokio::test]
async fn a_job_stopped_after_taking_its_temp_finishes_on_replay() {
    let scratch = fixture();
    let database = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 5).unwrap().actor;
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeBeforePreimageRevalidate);
    let stopped = actor
        .set_active_version(
            switch(&scratch, "target", 6),
            faults.clone(),
            CancellationToken::new(),
        )
        .await;
    assert!(stopped.is_err());
    assert!(faults.fired());
    let left = temps(scratch.path());
    assert_eq!(
        left.len(),
        1,
        "only the stopped job leaves its temp: {left:?}"
    );
    supervisor.close(&database).unwrap();
    let reopened = supervisor.open(&database, 8).unwrap().actor;
    reopened
        .materialize_replay_pending(scratch.path().to_path_buf(), WS.into(), 9)
        .await
        .unwrap();
    assert_files(scratch.path(), &TARGET);
    assert_eq!(temps(scratch.path()), Vec::<PathBuf>::new());
    supervisor.close(&database).unwrap();
}
