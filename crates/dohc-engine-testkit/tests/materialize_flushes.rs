//! Which flush each materialization runs, and on which file or folder. On
//! Apple silicon a file on the database's device takes a barrier and leaves
//! one drain owed; any other file is drained at once. Elsewhere every flush
//! is `sync_all` and nothing is owed. Every flush runs while its job is still
//! pending: the file comes before the row.
#![cfg(unix)]

use dohc_engine_files::{
    DurabilityPolicy, JobOutcome, KeptCopySave, MaterializeOptions, NoBackoff, StdReplacer,
    materialize::cleanup_staging_directory, materialize_one, materialize_secret_delete_one,
    materialize_secret_one, remove_empty_directory_target, remove_file_holding, run_pending_jobs,
    save_kept_displacement,
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
            dohc_engine_storage::sqlite_path((self.path(".dohc/engine/engine.db")).as_ref()),
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
fn a_new_file_flushes_its_temp_and_then_its_folder() {
    let mut ws = Workspace::new("new");
    ws.enqueue("j1", "notes/a.md", b"new", Preimage::Absent, false);
    ws.run_one("j1", |job| {
        materialize_one(&ws.store, &ws.path(""), job, &options()).expect("write")
    });
    // The temp file became `notes/a.md`, so its inode names the temp flush.
    assert_eq!(
        ws.flushes(&["notes/a.md", "notes"]),
        ordered(&["notes/a.md", "notes"])
    );
    ws.assert_drains_once();
}

#[test]
fn a_replace_flushes_its_temp_and_its_folder_but_not_staging() {
    let mut ws = Workspace::new("replace");
    std::fs::write(ws.path("a.md"), b"before").expect("preimage");
    ws.store.put_binary_blob(b"before").expect("preimage blob");
    let before = Preimage::Present(hex_sha256(b"before"));
    ws.enqueue("j1", "a.md", b"after", before, false);
    ws.run_one("j1", |job| {
        materialize_one(&ws.store, &ws.path(""), job, &options()).expect("write")
    });
    assert_eq!(
        ws.flushes(&["a.md", "", ".dohc/engine/displaced"]),
        ordered(&["a.md", ""])
    );
    ws.assert_drains_once();
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
fn a_secret_delete_flushes_the_pinned_folder() {
    let mut ws = Workspace::new("secret-delete");
    std::fs::write(ws.path(".env"), b"TOKEN=plaintext").expect("secret");
    let before = Preimage::Present(hex_sha256(b"TOKEN=plaintext"));
    ws.enqueue("secret-mat_1", ".env", b"placeholder", before, true);
    ws.run_one("secret-mat_1", |job| {
        materialize_secret_delete_one(&ws.store, &ws.path(""), job, &options())
            .expect("secret delete")
    });
    assert!(!ws.path(".env").exists());
    assert_eq!(ws.flushes(&[""]), ordered(&[""]));
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

#[test]
fn removing_sibling_staging_flushes_its_parent() {
    let ws = Workspace::new("cleanup");
    std::fs::create_dir_all(ws.path("notes/.dohc-write-displaced")).expect("sibling staging");
    ws.store
        .remember_staging("j1", "notes/.dohc-write-displaced")
        .expect("remember");
    let staging = ws.path("notes/.dohc-write-displaced");
    cleanup_staging_directory(&ws.store, &ws.path(""), &staging).expect("cleanup");
    assert!(!staging.exists());
    assert_eq!(ws.flushes(&["notes"]), ordered(&["notes"]));
    ws.assert_drains_once();
}

#[test]
fn retiring_a_relay_file_flushes_each_folder_it_changes() {
    let ws = Workspace::new("retire");
    std::fs::create_dir_all(ws.path("shared/notes")).expect("folders");
    std::fs::write(ws.path("shared/notes/a.md"), b"head").expect("file");
    let root = ws.path("");
    let head = hex_sha256(b"head");
    assert!(remove_file_holding(&ws.store, &root, "shared/notes/a.md", &head).unwrap());
    assert_eq!(ws.flushes(&["shared/notes"]), ordered(&["shared/notes"]));
    assert!(remove_empty_directory_target(&ws.store, &root, "shared/notes").unwrap());
    assert_eq!(ws.flushes(&["shared"]), ordered(&["shared"]));
    ws.assert_drains_once();
}

/// A barrier orders writes only on its own device. A file on a device the
/// database does not live on is drained at once, and leaves nothing owed.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn a_file_on_another_device_is_drained_at_once() {
    let mut ws = Workspace::new("other-device");
    ws.store.order_flushes_on_device(Some(u64::MAX));
    ws.enqueue("j1", "notes/a.md", b"new", Preimage::Absent, false);
    let outcome = materialize_one(&ws.store, &ws.path(""), &ws.job("j1"), &options());
    assert_eq!(outcome.expect("write"), JobOutcome::Completed);
    assert_eq!(
        ws.flushes(&["notes/a.md", "notes"]),
        vec![
            ("notes/a.md".to_owned(), FlushKind::Full),
            ("notes".to_owned(), FlushKind::Full)
        ]
    );
    ws.store.drain_flushes().expect("nothing owed");
    assert!(ws.store.take_flush_trace().is_empty());
}

/// A version switch replaces every file it changes. 1,000 replaced files
/// take 2,000 barriers, a temp and a folder each, and one drain pays for all
/// of them.
#[test]
fn a_thousand_file_switch_takes_two_thousand_barriers_and_one_drain() {
    let mut ws = Workspace::new("switch-count");
    for n in 0..1000 {
        let rel = format!("d{}/f{n}.md", n / 100);
        std::fs::create_dir_all(ws.path(&format!("d{}", n / 100))).expect("folder");
        let before = format!("before {n}");
        std::fs::write(ws.path(&rel), &before).expect("preimage");
        ws.store
            .put_binary_blob(before.as_bytes())
            .expect("preimage blob");
        let preimage = Preimage::Present(hex_sha256(before.as_bytes()));
        let id = format!("version-switch-mat_{n:04}");
        ws.enqueue(&id, &rel, format!("after {n}").as_bytes(), preimage, false);
    }
    let ended = ws.watch_ended_jobs();
    let results = run_pending_jobs(&ws.store, &ws.path(""), &options()).expect("switch");
    assert_eq!(results.len(), 1000);
    // Job n flushes its temp and folder while the n jobs before it have ended
    // and it has not.
    let ended = ended.lock().unwrap().clone();
    let expected: Vec<i64> = (0..2000).map(|flush| flush / 2).collect();
    assert_eq!(ended, expected);
    assert!(
        results
            .iter()
            .all(|result| result.outcome == JobOutcome::Completed)
    );
    ws.store.drain_flushes().expect("drain");
    let trace = ws.store.take_flush_trace();
    let count = |kind| trace.iter().filter(|event| event.kind == kind).count();
    assert_eq!(count(ORDERED), 2000);
    assert_eq!(count(FlushKind::Drain), usize::from(BARRIERS));
    assert_eq!(trace.len(), 2000 + count(FlushKind::Drain));
}
