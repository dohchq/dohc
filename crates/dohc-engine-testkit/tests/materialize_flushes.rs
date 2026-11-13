//! Which flush each materialization runs, and on which file or folder. On
//! Apple silicon a file on the database's device takes a barrier and leaves
//! one drain owed; any other file is drained at once. Elsewhere every flush
//! is `sync_all` and nothing is owed. Every flush runs while its job is still
//! pending: the file comes before the row.
#![cfg(unix)]

use dohc_engine_files::{
    DurabilityPolicy, JobOutcome, KeptCopySave, MaterializeOptions, NoBackoff, StdReplacer,
    materialize_one, materialize_secret_one, run_pending_jobs, save_kept_displacement,
};
use dohc_engine_storage::{
    DisplacementResolution, DisplacementSpec, EngineStore, FlushKind, MaterializationJob,
    MaterializationJobSpec, NoFaults, Preimage, enqueue_delete_job, enqueue_job, hex_sha256,
};
use dohc_test_scratch::ScratchDir;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const BARRIERS: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));

/// The flush that orders a file before the commits after it.
const ORDERED: FlushKind = if BARRIERS {
    FlushKind::Barrier
} else {
    FlushKind::Full
};

struct Workspace {
    root: ScratchDir,
    store: EngineStore,
}

impl Workspace {
    fn new(tag: &str) -> Self {
        let root = ScratchDir::new_named(&format!("mat-flush-{tag}")).expect("scratch");
        std::fs::create_dir_all(root.join(".dohc/engine")).expect("engine folder");
        let store = EngineStore::open(&root.join(".dohc/engine/engine.db"), 1).expect("open");
        assert!(
            store.take_flush_trace().is_empty(),
            "opening flushes nothing"
        );
        Workspace { root, store }
    }

    /// At each file flush, how many jobs had already ended, as a second
    /// connection sees committed rows.
    fn watch_ended_jobs(&self) -> Arc<Mutex<Vec<i64>>> {
        let reader = rusqlite::Connection::open_with_flags(
            self.path(".dohc/engine/engine.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("reader");
        let ended = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&ended);
        self.store.observe_flushes(move |event| {
            if event.kind == FlushKind::Drain {
                return;
            }
            let count = reader
                .query_row(
                    "SELECT count(*) FROM materialization_jobs WHERE status <> 'pending'",
                    [],
                    |row| row.get(0),
                )
                .expect("ended jobs");
            seen.lock().unwrap().push(count);
        });
        ended
    }

    /// Run one job, checking that it was still pending at every flush.
    fn run_one(&self, id: &str, run: impl FnOnce(&MaterializationJob) -> JobOutcome) {
        let ended = self.watch_ended_jobs();
        assert_eq!(run(&self.job(id)), JobOutcome::Completed);
        let ended = ended.lock().unwrap();
        assert!(!ended.is_empty(), "the job flushed");
        assert!(ended.iter().all(|&count| count == 0), "{ended:?}");
    }

    fn path(&self, rel: &str) -> PathBuf {
        if rel.is_empty() {
            self.root.to_path_buf()
        } else {
            self.root.join(rel)
        }
    }

    fn enqueue(&mut self, id: &str, rel: &str, content: &[u8], preimage: Preimage, delete: bool) {
        let spec = MaterializationJobSpec {
            job_id: id.to_owned(),
            workspace_id: "ws".to_owned(),
            target_path: rel.to_owned(),
            content_sha256: self.store.put_binary_blob(content).expect("blob"),
            preimage,
            target_generation: 1,
            now_ms: 10,
        };
        self.store
            .write_with(&NoFaults, |tx| {
                if delete {
                    enqueue_delete_job(tx, &spec)
                } else {
                    enqueue_job(tx, &spec)
                }
            })
            .expect("enqueue");
    }

    fn job(&self, id: &str) -> MaterializationJob {
        self.store
            .load_materialization_job(id)
            .expect("load")
            .expect("job")
    }

    /// The flushes since the last call, as workspace-relative names of the
    /// files and folders they ran on. `""` is the workspace root; anything
    /// not in `names` panics.
    fn flushes(&self, names: &[&str]) -> Vec<(String, FlushKind)> {
        let known: Vec<((u64, u64), String)> = names
            .iter()
            .map(|rel| {
                let metadata = std::fs::metadata(self.path(rel)).expect("named path");
                ((metadata.dev(), metadata.ino()), (*rel).to_owned())
            })
            .collect();
        self.store
            .take_flush_trace()
            .into_iter()
            .map(|event| {
                let name = known
                    .iter()
                    .find(|(identity, _)| *identity == (event.device, event.inode))
                    .map(|(_, name)| name.clone())
                    .unwrap_or_else(|| panic!("flush of an unnamed file: {event:?}"));
                (name, event.kind)
            })
            .collect()
    }

    /// Pay the owed drain, and check it ran on the database's folder exactly
    /// when a barrier made it owed.
    fn assert_drains_once(&self) {
        self.store.drain_flushes().expect("drain");
        let drains: Vec<(String, FlushKind)> = self.flushes(&[".dohc/engine"]);
        if BARRIERS {
            assert_eq!(drains, vec![(".dohc/engine".to_owned(), FlushKind::Drain)]);
        } else {
            assert!(drains.is_empty(), "{drains:?}");
        }
        self.store.drain_flushes().expect("nothing owed");
        assert!(self.store.take_flush_trace().is_empty());
    }
}

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

fn ordered(names: &[&str]) -> Vec<(String, FlushKind)> {
    names
        .iter()
        .map(|name| ((*name).to_owned(), ORDERED))
        .collect()
}

#[test]
fn a_delete_flushes_the_folder_it_emptied() {
    let mut ws = Workspace::new("delete");
    std::fs::create_dir(ws.path("notes")).expect("folder");
    std::fs::write(ws.path("notes/a.md"), b"before").expect("file");
    let before = Preimage::Present(hex_sha256(b"before"));
    ws.enqueue("j1", "notes/a.md", b"before", before, true);
    ws.run_one("j1", |job| {
        materialize_one(&ws.store, &ws.path(""), job, &options()).expect("delete")
    });
    assert!(!ws.path("notes/a.md").exists());
    assert_eq!(ws.flushes(&["notes", ""]), ordered(&["notes"]));
    ws.assert_drains_once();
}

#[test]
fn a_secret_write_flushes_through_the_pinned_folder() {
    let mut ws = Workspace::new("secret-write");
    ws.enqueue(
        "secret-mat_1",
        ".env",
        b"placeholder",
        Preimage::Absent,
        false,
    );
    ws.run_one("secret-mat_1", |job| {
        materialize_secret_one(&ws.store, &ws.path(""), job, b"TOKEN=plaintext", &options())
            .expect("secret write")
    });
    assert_eq!(ws.flushes(&[".env", ""]), ordered(&[".env", ""]));
    ws.assert_drains_once();
}

#[test]
fn a_saved_kept_copy_flushes_its_folder_and_staging() {
    let ws = Workspace::new("kept-copy");
    std::fs::create_dir_all(ws.path(".dohc/engine/displaced")).expect("staging");
    std::fs::write(ws.path(".dohc/engine/displaced/6a6f62.0"), b"outside").expect("kept");
    let id = ws
        .store
        .open_displacement(&DisplacementSpec {
            job_id: "job".to_owned(),
            workspace_id: "ws".to_owned(),
            target_path: "a.md".to_owned(),
            displaced_name: "6a6f62.0".to_owned(),
            expected_sha256: hex_sha256(b"before"),
            content_sha256: Some(hex_sha256(b"ours")),
            now_ms: 10,
        })
        .expect("open displacement");
    let keep = DisplacementResolution::Keep {
        displaced_sha256: Some(&hex_sha256(b"outside")),
    };
    ws.store
        .resolve_displacement(id, keep, None, 11)
        .expect("keep");
    let saved = save_kept_displacement(&ws.store, &ws.path(""), "ws", id, &options());
    assert_eq!(
        saved.expect("save"),
        KeptCopySave::Saved("a (kept copy).md".to_owned())
    );
    let names = ["", ".dohc/engine/displaced", ".dohc/engine", ".dohc"];
    assert_eq!(ws.flushes(&names), ordered(&names));
    ws.assert_drains_once();
}

/// A version switch replaces every file it changes. Each replaced file takes
/// a barrier on its temp and then on its folder while its job is still
/// pending, and one drain pays for all of them. Three files in two folders
/// show the order; more files repeat the same two flushes each.
#[test]
fn a_version_switch_flushes_each_file_then_its_folder_and_drains_once() {
    let mut ws = Workspace::new("switch-count");
    let files = ["d0/f0.md", "d0/f1.md", "d1/f2.md"];
    for (n, rel) in files.into_iter().enumerate() {
        std::fs::create_dir_all(ws.path(&rel[..2])).expect("folder");
        let before = format!("before {n}");
        std::fs::write(ws.path(rel), &before).expect("preimage");
        ws.store
            .put_binary_blob(before.as_bytes())
            .expect("preimage blob");
        let preimage = Preimage::Present(hex_sha256(before.as_bytes()));
        let id = format!("version-switch-mat_{n:04}");
        ws.enqueue(&id, rel, format!("after {n}").as_bytes(), preimage, false);
    }
    let ended = ws.watch_ended_jobs();
    let results = run_pending_jobs(&ws.store, &ws.path(""), &options()).expect("switch");
    assert_eq!(results.len(), files.len());
    assert!(
        results
            .iter()
            .all(|result| result.outcome == JobOutcome::Completed)
    );
    // Job n flushes its temp and folder while the n jobs before it have ended
    // and it has not.
    assert_eq!(*ended.lock().unwrap(), vec![0, 0, 1, 1, 2, 2]);
    let names = ["d0/f0.md", "d0/f1.md", "d1/f2.md", "d0", "d1"];
    assert_eq!(
        ws.flushes(&names),
        ordered(&["d0/f0.md", "d0", "d0/f1.md", "d0", "d1/f2.md", "d1"])
    );
    ws.assert_drains_once();
}
