use super::*;
use dohc_engine_storage::{MaterializationJobSpec, NoFaults, StagedDacl, enqueue_job};
use dohc_test_scratch::ScratchDir;
use dohc_windows_files::{read_staged, restore_dacl};
use std::sync::Mutex;

fn options(now_ms: i64, replacer: &dyn AtomicReplacer) -> MaterializeOptions<'_> {
    MaterializeOptions {
        holds: None,
        policy: DurabilityPolicy::none(),
        replacer,
        backoff: &NoBackoff,
        now_ms,
        faults: &NoFaults,
    }
}

fn job(store: &mut EngineStore, path: &str, before: &[u8], after: &[u8]) -> MaterializationJob {
    let preimage = store.put_binary_blob(before).unwrap();
    let content = store.put_binary_blob(after).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            enqueue_job(
                tx,
                &MaterializationJobSpec {
                    job_id: "settle".into(),
                    workspace_id: "ws".into(),
                    target_path: path.into(),
                    content_sha256: content,
                    preimage: Preimage::Present(preimage),
                    target_generation: 1,
                    now_ms: 1,
                },
            )
        })
        .unwrap();
    store.load_materialization_job("settle").unwrap().unwrap()
}

fn icacls(path: &Path, args: &[&str]) {
    let status = std::process::Command::new("icacls")
        .arg(path)
        .args(args)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "icacls {args:?}");
}

/// A workspace whose folder gives Users read access, as a shared one might,
/// and `notes.md` in it with an entry of its own for Authenticated Users.
/// Returns the root and the file's DACL.
fn shared_workspace(scratch: &ScratchDir) -> (PathBuf, String) {
    let root = std::fs::canonicalize(scratch.path()).unwrap();
    icacls(&root, &["/grant", "*S-1-5-32-545:(OI)(CI)R"]);
    let notes = root.join("notes.md");
    std::fs::write(&notes, b"before").unwrap();
    icacls(&notes, &["/grant", "*S-1-5-11:(M)"]);
    let dacl = own_dacl(&notes);
    assert!(
        dacl.contains("(A;ID;FR;;;BU)") && dacl.contains(";;;AU)"),
        "{dacl}"
    );
    (root, dacl)
}

fn staged(path: &Path) -> dohc_windows_files::StagedFile {
    read_staged(path).unwrap().unwrap()
}

/// The DACL of the file at `path`, which must be its own to save.
fn own_dacl(path: &Path) -> String {
    let staged = staged(path);
    assert!(staged.left.is_none(), "{staged:?}");
    staged.dacl
}

fn is_private(path: &Path) -> bool {
    staged(path).private
}

fn identity(path: &Path) -> String {
    staged(path).identity
}

fn is_staging(path: &Path) -> bool {
    path.parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name == "displaced" || name == ".dohc-write-displaced")
}

/// Another program writes the target just before the stage takes it, and
/// creates the target again just before its file would go back, so the
/// file it wrote stays staged.
struct Racing {
    cross_volume: bool,
    wrote: std::sync::atomic::AtomicBool,
    sibling: Mutex<Option<String>>,
}

/// The access the folder at `path` gives, as `icacls` shows it.
fn shown_access(path: &Path) -> String {
    let output = std::process::Command::new("icacls")
        .arg(path)
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).into_owned()
}

impl AtomicReplacer for Racing {
    fn displace(&self, target: &Path, staged: &Path) -> std::io::Result<()> {
        if self.cross_volume
            && staged.parent().unwrap().file_name() == Some(OsStr::new("displaced"))
        {
            return Err(std::io::Error::from(ErrorKind::CrossesDevices));
        }
        if !self.wrote.swap(true, std::sync::atomic::Ordering::Relaxed) {
            std::fs::write(target, b"outside")?;
            if self.cross_volume {
                *self.sibling.lock().unwrap() = Some(shown_access(staged.parent().unwrap()));
            }
        }
        std::fs::rename(target, staged)
    }

    fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<Placement> {
        if is_staging(incoming)
            && target.file_name() == Some(OsStr::new("notes.md"))
            && std::fs::read(incoming)? == b"outside"
        {
            std::fs::write(target, b"newer")?;
            return Err(std::io::Error::from(ErrorKind::AlreadyExists));
        }
        StdReplacer.place(incoming, target)
    }
}

/// A write that keeps an outside version staged. Returns the store, the
/// root, the version's DACL and its staged path.
fn kept_outside_version(
    scratch: &ScratchDir,
    cross_volume: bool,
) -> (EngineStore, PathBuf, String, PathBuf) {
    let (root, dacl) = shared_workspace(scratch);
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let j = job(&mut store, "notes.md", b"before", b"after");
    let replacer = Racing {
        cross_volume,
        wrote: Default::default(),
        sibling: Mutex::new(None),
    };
    assert_eq!(
        materialize_one(&store, &root, &j, &options(1, &replacer)).unwrap(),
        JobOutcome::Conflict
    );
    assert_eq!(std::fs::read(root.join("notes.md")).unwrap(), b"newer");
    let kept = store.list_kept_displacements("ws").unwrap();
    assert_eq!(kept.len(), 1);
    let staging = job_staging_dir(&store, &root, "settle", false).unwrap();
    let staged = staging.join(&kept[0].displaced_name);
    assert_eq!(std::fs::read(&staged).unwrap(), b"outside");
    if let Some(shown) = replacer.sibling.lock().unwrap().take() {
        assert!(
            !shown.contains("(I)") && !shown.contains("BUILTIN\\Users"),
            "{shown}"
        );
    }
    (store, root, dacl, staged)
}

fn save(store: &EngineStore, root: &Path) -> PathBuf {
    let id = store.list_kept_displacements("ws").unwrap()[0].displacement_id;
    match save_kept_displacement(store, root, "ws", id, &options(2, &StdReplacer)).unwrap() {
        KeptCopySave::Saved(copy) => root.join(copy),
        other => panic!("{other:?}"),
    }
}

/// A version kept staged is private, with its DACL saved before it was
/// changed, and the copy Save makes of it has that DACL back.
#[test]
fn a_kept_version_is_private_until_its_copy_gets_its_dacl_back() {
    let scratch = ScratchDir::new_named("staged-dacl-kept").unwrap();
    let (store, root, dacl, staged) = kept_outside_version(&scratch, false);
    assert!(is_private(&staged));
    assert_eq!(
        store.staged_dacl(&identity(&staged)).unwrap(),
        Some(StagedDacl::Saved(dacl.clone()))
    );
    let copy = save(&store, &root);
    assert_eq!(std::fs::read(&copy).unwrap(), b"outside");
    assert_eq!(own_dacl(&copy), dacl);
    assert!(store.staged_dacl_identities().unwrap().is_empty());
}

/// A drive the workspace's staging folder is not on stages beside the
/// target, in a folder that admits only this user, SYSTEM and
/// Administrators.
#[test]
fn a_version_staged_beside_its_target_is_private() {
    let scratch = ScratchDir::new_named("staged-dacl-sibling").unwrap();
    let (store, root, dacl, staged) = kept_outside_version(&scratch, true);
    let sibling = staged.parent().unwrap();
    assert_eq!(
        sibling.file_name(),
        Some(OsStr::new(".dohc-write-displaced"))
    );
    let shown = shown_access(sibling);
    assert!(
        !shown.contains("(I)") && !shown.contains("BUILTIN\\Users"),
        "{shown}"
    );
    assert!(is_private(&staged));
    assert_eq!(own_dacl(&save(&store, &root)), dacl);
}

/// A version Windows could not delete stays staged, so its DACL is saved
/// and it is made private, and it gets that DACL back if it ever returns.
#[test]
fn a_known_version_that_cannot_be_deleted_is_private() {
    struct Held(Mutex<Option<std::fs::File>>);
    impl AtomicReplacer for Held {
        fn displace(&self, target: &Path, staged: &Path) -> std::io::Result<()> {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::rename(target, staged)?;
            let held = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0x1)
                .open(staged)?;
            *self.0.lock().unwrap() = Some(held);
            Ok(())
        }
    }
    let scratch = ScratchDir::new_named("staged-dacl-known").unwrap();
    let (root, dacl) = shared_workspace(&scratch);
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let j = job(&mut store, "notes.md", b"before", b"after");
    let held = Held(Mutex::new(None));
    assert_eq!(
        materialize_one(&store, &root, &j, &options(1, &held)).unwrap(),
        JobOutcome::Completed
    );
    drop(held.0.lock().unwrap().take());
    let staged = staging_dir(store.database_path(), &root, false)
        .unwrap()
        .join(staged_name("settle", 0));
    assert_eq!(std::fs::read(&staged).unwrap(), b"before");
    assert!(is_private(&staged));
    let back = root.join("back.md");
    assert!(return_displaced(&store, &back, &staged, &options(2, &StdReplacer)).unwrap());
    assert_eq!(own_dacl(&back), dacl);
    assert!(store.staged_dacl_identities().unwrap().is_empty());
}

/// A file an earlier version staged, which no row names, is made private by
/// the sweep at startup. One with other names is left as it is, with the
/// reason saved.
#[test]
fn startup_makes_files_an_earlier_version_staged_private() {
    let scratch = ScratchDir::new_named("staged-dacl-startup").unwrap();
    let (root, _) = shared_workspace(&scratch);
    let store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let staging = staging_dir(store.database_path(), &root, true).unwrap();
    let alone = staging.join(staged_name("gone", 0));
    let linked = staging.join(staged_name("gone", 1));
    std::fs::write(&alone, b"alone").unwrap();
    std::fs::write(&linked, b"linked").unwrap();
    std::fs::hard_link(&linked, root.join("linked.md")).unwrap();
    let (alone_dacl, linked_dacl) = (sddl_of(&alone), sddl_of(&linked));
    assert!(alone_dacl.contains("(A;ID;FR;;;BU)"), "{alone_dacl}");
    recover_displacements(&store, &root, None, &options(1, &StdReplacer)).unwrap();
    assert!(is_private(&alone));
    assert_eq!(
        store.staged_dacl(&identity(&alone)).unwrap(),
        Some(StagedDacl::Saved(alone_dacl))
    );
    assert_eq!(sddl_of(&linked), linked_dacl);
    assert_eq!(
        store.staged_dacl(&identity(&linked)).unwrap(),
        Some(StagedDacl::Left("hard-links".into()))
    );
}

/// The DACL of any regular file, its own or not.
fn sddl_of(path: &Path) -> String {
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command"])
        .arg(format!(
            "(Get-Acl -LiteralPath '{}').GetSecurityDescriptorSddlForm('Access')",
            path.display()
        ))
        .output()
        .unwrap();
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

/// Each state a crash can leave between saving a DACL and forgetting it
/// ends with the file private while staged, its own DACL saved and never
/// replaced, and that DACL back on it once it leaves.
#[test]
fn every_crash_state_keeps_the_saved_dacl() {
    let scratch = ScratchDir::new_named("staged-dacl-crash").unwrap();
    let (store, root, dacl, staged) = kept_outside_version(&scratch, false);
    let id = identity(&staged);
    let sweep = |now| recover_displacements(&store, &root, None, &options(now, &StdReplacer));
    let saved = || store.staged_dacl(&id).unwrap();

    // Saved, then stopped before the file was made private.
    restore_dacl(&staged, &id, &dacl).unwrap();
    sweep(3).unwrap();
    assert!(is_private(&staged));
    assert_eq!(saved(), Some(StagedDacl::Saved(dacl.clone())));

    // Private already: another sweep saves nothing over the file's DACL.
    sweep(4).unwrap();
    assert_eq!(saved(), Some(StagedDacl::Saved(dacl.clone())));

    // A return that found its path taken makes the file private again.
    std::fs::write(root.join("taken.md"), b"taken").unwrap();
    assert!(
        !return_displaced(
            &store,
            &root.join("taken.md"),
            &staged,
            &options(5, &StdReplacer)
        )
        .unwrap()
    );
    assert!(is_private(&staged));
    assert_eq!(saved(), Some(StagedDacl::Saved(dacl.clone())));

    // Linked at the copy's name with its DACL back, then stopped before the
    // staged name went: the copy keeps its DACL, and Save finishes.
    restore_dacl(&staged, &id, &dacl).unwrap();
    std::fs::hard_link(&staged, root.join("notes (kept copy).md")).unwrap();
    sweep(6).unwrap();
    assert_eq!(sddl_of(&root.join("notes (kept copy).md")), dacl);
    let copy = save(&store, &root);
    assert_eq!(copy, root.join("notes (kept copy).md"));
    assert!(!staged.exists());
    assert_eq!(own_dacl(&copy), dacl);
    assert_eq!(saved(), None);
}

/// A file with dohc's DACL gets its own back and what was saved is
/// forgotten before it leaves. So a crash just after, between linking its
/// new name and unlinking the staged one, leaves a file with its own DACL
/// and nothing saved, and Save finishes it.
#[test]
fn what_was_saved_is_forgotten_before_a_file_leaves() {
    struct Peek {
        store: Mutex<EngineStore>,
        saved: Mutex<Option<Vec<String>>>,
    }
    impl AtomicReplacer for Peek {
        fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<Placement> {
            let saved = self.store.lock().unwrap().staged_dacl_identities().unwrap();
            *self.saved.lock().unwrap() = Some(saved);
            StdReplacer.place(incoming, target)
        }
    }
    let scratch = ScratchDir::new_named("staged-dacl-forget").unwrap();
    let (store, root, dacl, staged) = kept_outside_version(&scratch, false);
    let peek = Peek {
        store: Mutex::new(EngineStore::open(&root.join("engine.db"), 0).unwrap()),
        saved: Mutex::new(None),
    };
    let back = root.join("back.md");
    assert!(return_displaced(&store, &back, &staged, &options(2, &peek)).unwrap());
    assert_eq!(peek.saved.lock().unwrap().take(), Some(Vec::new()));
    assert_eq!(own_dacl(&back), dacl);

    let scratch = ScratchDir::new_named("staged-dacl-forget-link").unwrap();
    let (store, root, dacl, staged) = kept_outside_version(&scratch, false);
    let id = identity(&staged);
    restore_dacl(&staged, &id, &dacl).unwrap();
    store
        .forget_staged_dacls(std::slice::from_ref(&id))
        .unwrap();
    let copy = root.join("notes (kept copy).md");
    std::fs::hard_link(&staged, &copy).unwrap();
    recover_displacements(&store, &root, None, &options(3, &StdReplacer)).unwrap();
    assert_eq!(
        store.staged_dacl(&id).unwrap(),
        Some(StagedDacl::Left("hard-links".into()))
    );
    assert_eq!(save(&store, &root), copy);
    assert!(!staged.exists());
    assert_eq!(own_dacl(&copy), dacl);
    assert_eq!(store.staged_dacl(&id).unwrap(), None);
}

/// A file that left staging some other way while its DACL was still saved,
/// and is staged again with a DACL changed since, saves the DACL it has
/// now, and gets that one back.
#[test]
fn a_file_staged_again_saves_the_dacl_it_has_then() {
    let scratch = ScratchDir::new_named("staged-dacl-again").unwrap();
    let (store, root, dacl, staged) = kept_outside_version(&scratch, false);
    let id = identity(&staged);
    restore_dacl(&staged, &id, &dacl).unwrap();
    let away = root.join("away.md");
    std::fs::rename(&staged, &away).unwrap();
    icacls(&away, &["/grant", "*S-1-5-32-545:(M)"]);
    let changed = own_dacl(&away);
    assert_ne!(changed, dacl);
    std::fs::rename(&away, &staged).unwrap();
    recover_displacements(&store, &root, None, &options(3, &StdReplacer)).unwrap();
    assert!(is_private(&staged));
    assert_eq!(
        store.staged_dacl(&id).unwrap(),
        Some(StagedDacl::Saved(changed.clone()))
    );
    let back = root.join("back.md");
    assert!(return_displaced(&store, &back, &staged, &options(4, &StdReplacer)).unwrap());
    assert_eq!(own_dacl(&back), changed);
}

/// A file dohc saved but could not make private, because its DACL denies
/// this user the right to change it, has nothing to undo, so it still
/// leaves.
#[test]
fn a_file_dohc_could_not_make_private_still_leaves() {
    let scratch = ScratchDir::new_named("staged-dacl-stuck").unwrap();
    let (store, root, _, staged) = kept_outside_version(&scratch, false);
    let id = identity(&staged);
    let no_change = "D:P(A;;0x1301ff;;;OW)";
    restore_dacl(&staged, &id, no_change).unwrap();
    store
        .save_staged_dacl(&id, &StagedDacl::Saved(no_change.into()), 3)
        .unwrap();
    let back = root.join("back.md");
    assert!(return_displaced(&store, &back, &staged, &options(4, &StdReplacer)).unwrap());
    assert_eq!(std::fs::read(&back).unwrap(), b"outside");
    assert_eq!(store.staged_dacl(&id).unwrap(), None);
}

/// A folder beside the workspace that dohc stages into and finds missing
/// may come back, so what was saved for the files in it is kept.
#[test]
fn a_missing_staging_folder_keeps_what_was_saved_for_its_files() {
    let scratch = ScratchDir::new_named("staged-dacl-missing").unwrap();
    let (store, root, dacl, staged) = kept_outside_version(&scratch, true);
    let id = identity(&staged);
    let sibling = staged.parent().unwrap().to_path_buf();
    let away = root.join("away");
    std::fs::rename(&sibling, &away).unwrap();
    staged_dacl::keep_all_private(&store, std::slice::from_ref(&sibling), true, 3).unwrap();
    assert_eq!(
        store.staged_dacl(&id).unwrap(),
        Some(StagedDacl::Saved(dacl))
    );
    std::fs::rename(&away, &sibling).unwrap();
    staged_dacl::keep_all_private(&store, &[sibling], true, 4).unwrap();
    assert!(store.staged_dacl(&id).unwrap().is_some());
}

/// Back in staging after leaving, before what was saved was forgotten: the
/// sweep forgets it once the file is no longer staged.
#[test]
fn a_file_that_left_before_its_dacl_was_forgotten_is_forgotten_by_the_sweep() {
    let scratch = ScratchDir::new_named("staged-dacl-left").unwrap();
    let (store, root, dacl, staged) = kept_outside_version(&scratch, false);
    let id = identity(&staged);
    restore_dacl(&staged, &id, &dacl).unwrap();
    let away = root.join("away.md");
    std::fs::rename(&staged, &away).unwrap();
    recover_displacements(&store, &root, None, &options(3, &StdReplacer)).unwrap();
    assert_eq!(store.staged_dacl(&id).unwrap(), None);
    assert_eq!(own_dacl(&away), dacl);
}

/// The recovery a path runs when capture or a delete looks at it makes what
/// stays staged private too.
#[test]
fn recovery_for_a_path_makes_staged_files_private() {
    let scratch = ScratchDir::new_named("staged-dacl-path").unwrap();
    let (root, _) = shared_workspace(&scratch);
    let store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let staging = staging_dir(store.database_path(), &root, true).unwrap();
    let staged = staging.join(staged_name("gone", 0));
    std::fs::write(&staged, b"staged").unwrap();
    let dacl = own_dacl(&staged);
    recover_path_displacements(&store, &root, "ws", "notes.md", &options(1, &StdReplacer)).unwrap();
    assert!(is_private(&staged));
    assert_eq!(
        store.staged_dacl(&identity(&staged)).unwrap(),
        Some(StagedDacl::Saved(dacl))
    );
}
