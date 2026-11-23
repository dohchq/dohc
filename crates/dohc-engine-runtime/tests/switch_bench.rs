use dohc_engine_domain::{CreateNamedVersion, WriteText};
use dohc_engine_runtime::{ActiveVersionSwitch, CancellationToken, NoFaults, WorkspaceSupervisor};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::sync::Arc;
use std::time::Instant;

const WORKSPACE: &str = "ws-switch-bench";

fn write(version_id: &str, path: &str, text: String, moment: String, now_ms: i64) -> WriteText {
    WriteText {
        workspace_id: WORKSPACE.to_owned(),
        version_id: version_id.to_owned(),
        object_id: format!("bench-object-{path}"),
        path: path.to_owned(),
        text,
        moment_id: moment,
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
    }
}

/// How long a switch takes when every file differs, timed in release from a
/// disk that holds the version it leaves.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "manual release benchmark for switching many files"]
async fn switch_many_files_cost() {
    let files: usize = std::env::var("SWITCH_BENCH_FILES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1000);
    let rounds: usize = std::env::var("SWITCH_BENCH_ROUNDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4);
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
    let text =
        |version: &str, i: usize| format!("# Note {i}\n\n{version} body line for note {i}.\n");
    let setup = Instant::now();
    for i in 0..files {
        actor
            .versioned_text_write(
                write(
                    "main",
                    &format!("n{i}.md"),
                    text("main", i),
                    format!("m-main-{i}"),
                    2,
                ),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("main write");
    }
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
    for i in 0..files {
        actor
            .versioned_text_write(
                write(
                    "feature",
                    &format!("n{i}.md"),
                    text("feature", i),
                    format!("m-feature-{i}"),
                    4,
                ),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("feature write");
    }
    for i in 0..files {
        std::fs::write(scratch.path().join(format!("n{i}.md")), text("main", i)).expect("seed");
    }
    eprintln!(
        "[switch-bench] setup {files} files in {:?}",
        setup.elapsed()
    );
    for round in 0..rounds {
        let target = if round % 2 == 0 { "feature" } else { "main" };
        let started = Instant::now();
        actor
            .set_active_version(
                ActiveVersionSwitch {
                    workspace_id: WORKSPACE.to_owned(),
                    version_id: target.to_owned(),
                    root_dir: scratch.path().to_path_buf(),
                    self_writes: Arc::new(()),
                    now_ms: 10 + round as i64,
                },
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("switch");
        let elapsed = started.elapsed();
        eprintln!(
            "[switch-bench] round {round} to {target}: {elapsed:?} ({:.2} ms/file)",
            elapsed.as_secs_f64() * 1000.0 / files as f64
        );
        let sample = std::fs::read_to_string(scratch.path().join("n0.md")).expect("read");
        assert!(sample.contains(target), "disk shows {target}");
    }
}
