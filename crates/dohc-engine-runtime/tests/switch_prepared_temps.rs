use dohc_engine_domain::{CaptureIngest, CreateNamedVersion, VersionedTextStore};
use dohc_engine_runtime::{
    ActiveVersionSwitch, CancellationToken, NoFaults, SelfWriteRecorder, WorkspaceSupervisor,
};
use dohc_engine_storage::{EngineStore, FaultAction, FaultInjector, FaultPoint};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
    let faults = Arc::new(StopFirstWrite {
        root: scratch.path().to_path_buf(),
        temps: Mutex::default(),
    });
    let stopped = actor
        .set_active_version(
            switch(&scratch, "target", 6),
            faults.clone(),
            CancellationToken::new(),
        )
        .await;
    assert!(stopped.is_err());
    let at_stop = faults
        .temps
        .lock()
        .unwrap()
        .clone()
        .expect("a write stopped");
    assert_eq!(
        at_stop.len(),
        2,
        "the stopped job's temp and the one prepared beside it: {at_stop:?}"
    );
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

/// Stops the first write just before it replaces its file, noting the temps
/// on disk then.
struct StopFirstWrite {
    root: PathBuf,
    temps: Mutex<Option<Vec<PathBuf>>>,
}

impl FaultInjector for StopFirstWrite {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        let mut temps = self.temps.lock().unwrap();
        if point == FaultPoint::MaterializeBeforePreimageRevalidate && temps.is_none() {
            *temps = Some(self::temps(&self.root));
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

/// Stops every write just before it replaces its file.
struct StopEveryWrite;

impl FaultInjector for StopEveryWrite {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::MaterializeBeforePreimageRevalidate {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

/// The temps on disk as each job begins, by the job's path.
struct TempsAtEachJob {
    root: PathBuf,
    seen: Mutex<Vec<(String, Vec<PathBuf>)>>,
}

impl SelfWriteRecorder for TempsAtEachJob {
    fn record(&self, _workspace_id: &str, path: &str, _sha256: &str) {
        let temps = temps(&self.root);
        self.seen.lock().unwrap().push((path.to_owned(), temps));
    }

    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

#[tokio::test]
async fn a_switch_job_made_stale_removes_its_temp_before_the_next_job() {
    let scratch = fixture();
    let database = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 5).unwrap().actor;
    let stopped = actor
        .set_active_version(
            switch(&scratch, "target", 6),
            Arc::new(StopEveryWrite),
            CancellationToken::new(),
        )
        .await;
    assert!(stopped.is_err());
    supervisor.close(&database).unwrap();
    let mut store = EngineStore::open(&database, 7).unwrap();
    let mut pending = store.list_pending_materialization_jobs().unwrap();
    pending.sort_by(|a, b| (a.created_at_ms, &a.job_id).cmp(&(b.created_at_ms, &b.job_id)));
    let [first, stale, later] = &pending[..] else {
        panic!("three pending jobs, found {}", pending.len());
    };
    let (first, stale, later) = (
        first.target_path.clone(),
        stale.clone(),
        later.target_path.clone(),
    );
    seed(
        &mut store,
        "target",
        &stale.target_path,
        "edited since
",
        8,
    );
    drop(store);
    let reopened = supervisor.open(&database, 9).unwrap().actor;
    let recorder = Arc::new(TempsAtEachJob {
        root: scratch.path().to_path_buf(),
        seen: Mutex::default(),
    });
    reopened
        .materialize_replay_pending_for_fence(
            scratch.path().to_path_buf(),
            WS.into(),
            recorder.clone(),
            10,
        )
        .await
        .unwrap();
    let seen = recorder.seen.lock().unwrap();
    let (_, stale_hash) = stale.job_id.rsplit_once('_').unwrap();
    let at = |path: &str| {
        let (_, temps) = seen
            .iter()
            .find(|(seen, _)| seen == path)
            .unwrap_or_else(|| panic!("{path} ran"));
        temps
            .iter()
            .any(|temp| temp.to_string_lossy().contains(stale_hash))
    };
    assert!(at(&first), "the stale job had a prepared temp");
    assert!(!at(&later), "the stale job's temp outlived it");
    supervisor.close(&database).unwrap();
}
