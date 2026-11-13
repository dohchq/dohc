use super::*;

pub(super) fn prepared_stores(path: &std::path::Path, scratch: &ScratchDir) -> Vec<EngineStore> {
    let wal = std::path::PathBuf::from(format!("{}-wal", path.display()));
    assert!(
        !wal.exists() || wal.metadata().unwrap().len() == 0,
        "closed template must have checkpointed its WAL"
    );
    let paths: Vec<_> = (0..21)
        .map(|sample| scratch.path().join(format!("sample-{sample}.db")))
        .collect();
    for copy in &paths {
        std::fs::copy(path, copy).unwrap();
        sync_file(copy);
    }
    let stores: Vec<_> = paths
        .iter()
        .map(|copy| EngineStore::open_passive(copy, 0, None, None).unwrap())
        .collect();
    // Opening can create SQLite sidecars. Flush these too before any sample.
    for copy in &paths {
        sync_file(copy);
        for suffix in ["-wal", "-shm"] {
            let sidecar = std::path::PathBuf::from(format!("{}{suffix}", copy.display()));
            if sidecar.exists() {
                sync_file(&sidecar);
            }
        }
    }
    println!("PAGE_PREPARED stores=21 sync_all=true before_timing=true");
    stores
}

fn sync_file(path: &std::path::Path) {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap()
        .sync_all()
        .unwrap();
}

pub(super) fn measured_page(
    store: &mut EngineStore,
    after: i64,
    rows: &[ReplicaJournalRow],
    sample: usize,
) -> (ReplicaPageResult, [f64; 5]) {
    let commits = CommitTimer::default();
    let start = std::time::Instant::now();
    let result = apply_page(store, "ws", after, rows, &commits).unwrap();
    let total = start.elapsed().as_secs_f64() * 1000.0;
    let phases = dohc_engine_collab::live_update_application::passive::page_timings::take_last()
        .expect("test-support phase timer");
    let values = [
        total,
        phases.row_loop_ms,
        phases.dependency_check_ms,
        commits.first_commit_ms(),
        total - phases.row_loop_ms - phases.dependency_check_ms - commits.first_commit_ms(),
    ];
    println!(
        "PAGE_PHASE_SAMPLE {}",
        json!({"sample":sample,"total":values[0],"row_loop":values[1],
            "dependency_check":values[2],"commit":values[3],"other":values[4]})
    );
    (result, values)
}

#[derive(Default)]
struct CommitTimer(std::sync::Mutex<(Option<std::time::Instant>, Option<f64>)>);

impl CommitTimer {
    fn first_commit_ms(&self) -> f64 {
        self.0.lock().unwrap().1.expect("page committed")
    }
}

impl FaultInjector for CommitTimer {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if matches!(
            point,
            FaultPoint::StorageBeforePersist | FaultPoint::StorageAfterCommitBeforeAck
        ) {
            let mut state = self.0.lock().unwrap();
            if state.1.is_none() {
                if point == FaultPoint::StorageBeforePersist {
                    state.0 = Some(std::time::Instant::now());
                } else {
                    state.1 = Some(
                        state
                            .0
                            .take()
                            .expect("before commit")
                            .elapsed()
                            .as_secs_f64()
                            * 1000.0,
                    );
                }
            }
        }
        FaultAction::Continue
    }
}

pub(super) fn print_phases(workload: &str, samples: &[[f64; 5]]) {
    assert_eq!(samples.len(), 21);
    let phases: serde_json::Map<_, _> =
        ["total", "row_loop", "dependency_check", "commit", "other"]
            .into_iter()
            .enumerate()
            .map(|(column, name)| {
                let mut values: Vec<_> = samples.iter().map(|sample| sample[column]).collect();
                values.sort_by(f64::total_cmp);
                (
                    name.to_owned(),
                    json!({"median":values[10],"p95":values[19]}),
                )
            })
            .collect();
    println!(
        "PAGE_PHASE_MS {}",
        json!({"workload":workload,"samples":21,"phases":phases})
    );
}
