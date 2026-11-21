use super::*;
use dohc_engine_storage::{MaterializationJobSpec, NoFaults, enqueue_job};
use dohc_test_scratch::ScratchDir;

fn options() -> MaterializeOptions<'static> {
    MaterializeOptions {
        holds: None,
        policy: DurabilityPolicy::per_os(),
        replacer: &StdReplacer,
        backoff: &NoBackoff,
        now_ms: 20,
        faults: &NoFaults,
    }
}

struct Workspace {
    store: EngineStore,
    root: ScratchDir,
}

impl Workspace {
    fn new(tag: &str) -> Self {
        let root = ScratchDir::new_named(&format!("prepared-{tag}")).unwrap();
        std::fs::create_dir_all(root.join(".dohc/engine")).unwrap();
        let store = EngineStore::open(&root.join(".dohc/engine/engine.db"), 1).unwrap();
        Workspace { store, root }
    }

    fn root(&self) -> &Path {
        &self.root
    }

    /// A switch job that replaces `before` at `path` with `after`, or creates
    /// the file when `before` is `None`.
    fn job(
        &mut self,
        n: usize,
        path: &str,
        before: Option<&[u8]>,
        after: &[u8],
    ) -> MaterializationJob {
        let id = format!("version-switch-mat_{n:04}");
        if let Some(before) = before {
            let file = self.root.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, before).unwrap();
        }
        let preimage = match before {
            Some(before) => Preimage::Present(self.store.put_binary_blob(before).unwrap()),
            None => Preimage::Absent,
        };
        let spec = MaterializationJobSpec {
            job_id: id.clone(),
            workspace_id: "ws".into(),
            target_path: path.into(),
            content_sha256: self.store.put_binary_blob(after).unwrap(),
            preimage,
            target_generation: 1,
            now_ms: 10,
        };
        self.store
            .write_with(&NoFaults, |tx| enqueue_job(tx, &spec))
            .unwrap();
        self.store.load_materialization_job(&id).unwrap().unwrap()
    }

    fn prepare(&self, jobs: &[&MaterializationJob]) -> PreparedTemps {
        PreparedTemps::prepare(&self.store, self.root(), jobs, DurabilityPolicy::per_os())
    }

    fn run(&self, job: &MaterializationJob, prepared: &PreparedTemps) -> JobOutcome {
        materialize_one_ordinary_prepared(&self.store, self.root(), job, &options(), prepared)
            .unwrap()
    }

    fn temp(&self, job: &MaterializationJob) -> PathBuf {
        temp_sibling(&self.root.join(&job.target_path), &job.job_id)
    }

    fn read(&self, path: &str) -> Vec<u8> {
        std::fs::read(self.root.join(path)).unwrap()
    }
}

/// Rewrite `path` with `bytes` of the same length and give it back its
/// modification time, so its size and time still match its preparation.
fn rewrite_keeping_stamp(path: &Path, bytes: &[u8]) {
    use std::io::Write as _;
    let modified = std::fs::metadata(path).unwrap().modified().unwrap();
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .unwrap();
    file.write_all(bytes).unwrap();
    file.set_modified(modified).unwrap();
}

#[test]
fn each_job_places_the_temp_prepared_for_it() {
    let mut ws = Workspace::new("taken");
    let jobs = [
        ws.job(0, "notes/a.md", Some(b"before a"), b"after a"),
        ws.job(1, "notes/b.md", None, b"after b"),
    ];
    let prepared = ws.prepare(&jobs.iter().collect::<Vec<_>>());
    // A temp the job wrote itself would hold "after".
    for job in &jobs {
        rewrite_keeping_stamp(&ws.temp(job), b"PREPARE");
    }
    for job in &jobs {
        assert_eq!(ws.run(job, &prepared), JobOutcome::Completed);
    }
    assert_eq!(ws.read("notes/a.md"), b"PREPARE");
    assert_eq!(ws.read("notes/b.md"), b"PREPARE");
    drop(prepared);
    let mut left: Vec<_> = std::fs::read_dir(ws.root.join("notes"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    left.sort();
    assert_eq!(left, ["a.md", "b.md"]);
}

#[test]
fn a_temp_changed_since_it_was_prepared_is_written_again() {
    let mut ws = Workspace::new("changed");
    let job = ws.job(0, "a.md", Some(b"before"), b"after");
    let prepared = ws.prepare(&[&job]);
    std::fs::write(ws.temp(&job), b"something else").unwrap();
    assert_eq!(ws.run(&job, &prepared), JobOutcome::Completed);
    assert_eq!(ws.read("a.md"), b"after");
    assert!(!ws.temp(&job).exists());
}

#[test]
fn temps_no_job_took_go_with_the_folders_made_for_them() {
    let mut ws = Workspace::new("untaken");
    let deep = ws.job(0, "new/deep/a.md", None, b"a");
    let kept = ws.job(1, "notes/b.md", Some(b"before"), b"b");
    let prepared = ws.prepare(&[&deep, &kept]);
    assert!(ws.temp(&deep).is_file());
    assert!(ws.temp(&kept).is_file());
    drop(prepared);
    assert!(!ws.root.join("new").exists());
    assert!(!ws.temp(&kept).exists());
    assert_eq!(ws.read("notes/b.md"), b"before");
}

#[test]
fn a_file_that_already_holds_the_content_gets_no_temp() {
    let mut ws = Workspace::new("already");
    let job = ws.job(0, "a.md", Some(b"same"), b"same");
    let prepared = ws.prepare(&[&job]);
    assert!(!ws.temp(&job).exists());
    assert_eq!(ws.run(&job, &prepared), JobOutcome::AlreadyMaterialized);
}
