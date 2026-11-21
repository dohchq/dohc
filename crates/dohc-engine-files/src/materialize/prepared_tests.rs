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

#[test]
fn each_job_places_the_temp_prepared_for_it() {
    let mut ws = Workspace::new("taken");
    let jobs = [
        ws.job(0, "notes/a.md", Some(b"before a"), b"after a"),
        ws.job(1, "notes/b.md", None, b"after b"),
    ];
    let prepared = ws.prepare(&jobs.iter().collect::<Vec<_>>());
    let temps: Vec<_> = jobs
        .iter()
        .map(|job| same_file::Handle::from_path(ws.temp(job)).unwrap())
        .collect();
    for job in &jobs {
        assert_eq!(ws.run(job, &prepared), JobOutcome::Completed);
    }
    for (path, temp) in ["notes/a.md", "notes/b.md"].into_iter().zip(temps) {
        assert!(same_file::Handle::from_path(ws.root.join(path)).unwrap() == temp);
    }
    assert_eq!(ws.read("notes/a.md"), b"after a");
    assert_eq!(ws.read("notes/b.md"), b"after b");
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
fn a_temp_replaced_since_it_was_prepared_is_written_again() {
    let mut ws = Workspace::new("replaced");
    let job = ws.job(0, "a.md", Some(b"before"), b"after");
    let prepared = ws.prepare(&[&job]);
    let temp = ws.temp(&job);
    let modified = std::fs::metadata(&temp).unwrap().modified().unwrap();
    std::fs::remove_file(&temp).unwrap();
    std::fs::write(&temp, b"AFTER").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&temp)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    assert_eq!(ws.run(&job, &prepared), JobOutcome::Completed);
    assert_eq!(ws.read("a.md"), b"after");
}

#[test]
fn a_job_whose_folder_is_missing_gets_no_temp() {
    let mut ws = Workspace::new("missing");
    let deep = ws.job(0, "new/deep/a.md", None, b"a");
    let kept = ws.job(1, "notes/b.md", Some(b"before"), b"b");
    let prepared = ws.prepare(&[&deep, &kept]);
    assert!(!ws.root.join("new").exists());
    assert!(ws.temp(&kept).is_file());
    drop(prepared);
    assert!(!ws.temp(&kept).exists());
    assert_eq!(ws.read("notes/b.md"), b"before");
}

#[test]
fn a_file_that_already_holds_the_content_is_left_and_its_temp_removed_first() {
    let mut ws = Workspace::new("already");
    let job = ws.job(0, "a.md", Some(b"same"), b"same");
    let prepared = ws.prepare(&[&job]);
    assert_eq!(ws.run(&job, &prepared), JobOutcome::AlreadyMaterialized);
    assert!(!ws.temp(&job).exists());
    assert_eq!(ws.read("a.md"), b"same");
}

#[test]
fn a_folder_a_file_replaces_gets_no_temp() {
    let mut ws = Workspace::new("folder");
    std::fs::create_dir_all(ws.root.join("a.md")).unwrap();
    let job = ws.job(0, "a.md", None, b"a");
    let _prepared = ws.prepare(&[&job]);
    assert!(!ws.temp(&job).exists());
}
