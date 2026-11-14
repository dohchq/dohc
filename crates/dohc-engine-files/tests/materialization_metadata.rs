//! An engine write keeps the group and permission bits of the file it
//! replaces, and on macOS its ACL and the extended attributes a save keeps.
//! When it cannot keep the group or the ACL, it keeps only the owner's bits.
//! A new file follows the umask, and a secret stays owner-only.
#![cfg(unix)]
use crate::common;

use common::Scratch;
use dohc_engine_files::{
    DurabilityPolicy, JobOutcome, MaterializeOptions, NoBackoff, StdReplacer, materialize_one,
    materialize_secret_one, materialize_write_conflict,
};
use dohc_engine_storage::{
    EngineStore, MaterializationJob, MaterializationJobSpec, NoFaults, Preimage, enqueue_job,
};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

fn options() -> MaterializeOptions<'static> {
    MaterializeOptions {
        holds: None,
        policy: DurabilityPolicy::none(),
        replacer: &StdReplacer,
        backoff: &NoBackoff,
        now_ms: 0,
        faults: &NoFaults,
    }
}

fn queue(
    store: &mut EngineStore,
    path: &str,
    content: &[u8],
    preimage: Preimage,
) -> MaterializationJob {
    let content_sha256 = store.put_binary_blob(content).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            enqueue_job(
                tx,
                &MaterializationJobSpec {
                    job_id: path.into(),
                    workspace_id: "ws".into(),
                    target_path: path.into(),
                    content_sha256,
                    preimage,
                    target_generation: 1,
                    now_ms: 0,
                },
            )
        })
        .unwrap();
    store.load_materialization_job(path).unwrap().unwrap()
}

fn write_job(db: &Path, root: &Path, path: &str, before: Option<&[u8]>) -> JobOutcome {
    let mut store = EngineStore::open(db, 0).unwrap();
    let preimage = match before {
        Some(before) => Preimage::Present(store.put_binary_blob(before).unwrap()),
        None => Preimage::Absent,
    };
    let job = queue(&mut store, path, b"after", preimage);
    materialize_one(&store, root, &job, &options()).unwrap()
}

fn engine_write(db: &Path, root: &Path, path: &str, before: Option<&[u8]>) {
    assert_eq!(write_job(db, root, path, before), JobOutcome::Completed);
    assert_eq!(std::fs::read(root.join(path)).unwrap(), b"after");
}

fn conflict_copy(dir: &Path) -> PathBuf {
    let copies: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "conflict"))
        .collect();
    assert_eq!(copies.len(), 1, "{copies:?}");
    assert_eq!(std::fs::read(&copies[0]).unwrap(), b"after");
    copies[0].clone()
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o7777
}

fn set_mode(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

#[test]
fn a_write_keeps_the_replaced_files_permission_bits() {
    let scratch = Scratch::new();
    let script = scratch.path().join("run.sh");
    std::fs::write(&script, b"before").unwrap();
    set_mode(&script, 0o4755);

    engine_write(
        &scratch.path().join("engine.db"),
        scratch.path(),
        "run.sh",
        Some(b"before"),
    );

    assert_eq!(mode(&script), 0o755, "the exec bits stay and setuid goes");
}

#[test]
fn a_secret_stays_owner_only_over_a_shared_file() {
    let scratch = Scratch::new();
    let env = scratch.path().join(".env");
    std::fs::write(&env, b"OLD=1\n").unwrap();
    set_mode(&env, 0o644);
    let mut store = EngineStore::open(&scratch.path().join("engine.db"), 0).unwrap();
    let job = queue(&mut store, ".env", b"encrypted", Preimage::Absent);

    assert_eq!(
        materialize_secret_one(&store, scratch.path(), &job, b"SECRET=1\n", &options()).unwrap(),
        JobOutcome::Completed
    );

    assert_eq!(std::fs::read(&env).unwrap(), b"SECRET=1\n");
    assert_eq!(mode(&env), 0o600);
}

#[test]
fn an_unreadable_target_never_widens_its_conflict_copy() {
    let scratch = Scratch::new();
    let locked = scratch.path().join("locked.md");
    std::fs::write(&locked, b"before").unwrap();
    set_mode(&locked, 0o200);
    let mut store = EngineStore::open(&scratch.path().join("engine.db"), 0).unwrap();
    let before = store.put_binary_blob(b"before").unwrap();
    let job = queue(&mut store, "locked.md", b"after", Preimage::Present(before));

    assert_eq!(
        materialize_write_conflict(&store, scratch.path(), &job, &options()).unwrap(),
        JobOutcome::Conflict
    );

    // The owner cannot read the file, so the copy is owner-only. A process
    // that can read it, such as root, gives the copy the file's own mode.
    let copy_mode = mode(&conflict_copy(scratch.path()));
    assert!(matches!(copy_mode, 0o600 | 0o200), "{copy_mode:o}");
}

/// Set a POSIX ACL, given as (tag, permissions, id) entries, as the xattr
/// `name`. `false` when the file system refuses it.
#[cfg(target_os = "linux")]
fn set_posix_acl(path: &Path, name: &str, entries: &[(u16, u16, u32)]) -> bool {
    let mut acl = 2u32.to_le_bytes().to_vec();
    for (tag, permissions, id) in entries {
        acl.extend(tag.to_le_bytes());
        acl.extend(permissions.to_le_bytes());
        acl.extend(id.to_le_bytes());
    }
    match rustix::fs::setxattr(path, name, &acl, rustix::fs::XattrFlags::empty()) {
        Ok(()) => true,
        Err(err) => {
            eprintln!("SKIP: this file system refused a POSIX ACL: {err}");
            false
        }
    }
}

// The tags of POSIX ACL entries, and the id of an entry that names no one.
#[cfg(target_os = "linux")]
const USER_OBJ: u16 = 0x01;
#[cfg(target_os = "linux")]
const USER: u16 = 0x02;
#[cfg(target_os = "linux")]
const GROUP_OBJ: u16 = 0x04;
#[cfg(target_os = "linux")]
const MASK: u16 = 0x10;
#[cfg(target_os = "linux")]
const OTHER: u16 = 0x20;
#[cfg(target_os = "linux")]
const UNDEFINED: u32 = u32::MAX;

/// Linux reports a POSIX ACL's mask as the group bits. The ACL is not
/// copied, so the mask must not become access for the file's group.
#[cfg(target_os = "linux")]
#[test]
fn a_posix_acl_mask_does_not_become_group_access() {
    let scratch = Scratch::new();
    let report = scratch.path().join("report.md");
    std::fs::write(&report, b"before").unwrap();
    set_mode(&report, 0o600);
    let entries = [
        (USER_OBJ, 6, UNDEFINED),
        (USER, 4, 4242),
        (GROUP_OBJ, 4, UNDEFINED),
        (MASK, 4, UNDEFINED),
        (OTHER, 0, UNDEFINED),
    ];
    if !set_posix_acl(&report, "system.posix_acl_access", &entries) {
        return;
    }
    assert_eq!(mode(&report), 0o640, "the mask shows as the group bits");

    engine_write(
        &scratch.path().join("engine.db"),
        scratch.path(),
        "report.md",
        Some(b"before"),
    );

    assert_eq!(mode(&report), 0o600);
}

#[cfg(target_vendor = "apple")]
const TAGS: &str = "com.apple.metadata:_kMDItemUserTags";

/// Finder's binary property list for the one tag "Red".
#[cfg(target_vendor = "apple")]
const RED_TAG: &[u8] = b"bplist00\xa1\x01URed\n6\x08\x0a\x00\x00\x00\x00\x00\x00\x01\x01\
    \x00\x00\x00\x00\x00\x00\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\
    \x00\x10";

#[cfg(target_vendor = "apple")]
fn set_xattr(path: &Path, name: &str, value: &[u8]) {
    rustix::fs::setxattr(path, name, value, rustix::fs::XattrFlags::empty()).unwrap();
}

#[cfg(target_vendor = "apple")]
fn xattr(path: &Path, name: &str) -> Option<Vec<u8>> {
    let mut value = [0u8; 256];
    match rustix::fs::getxattr(path, name, &mut value[..]) {
        Ok(len) => Some(value[..len].to_vec()),
        Err(rustix::io::Errno::NOATTR) => None,
        Err(err) => panic!("read {name}: {err}"),
    }
}

#[cfg(target_vendor = "apple")]
fn add_acl_entry(path: &Path, entry: &str) {
    let added = std::process::Command::new("/bin/chmod")
        .args(["+a", entry])
        .arg(path)
        .status()
        .unwrap();
    assert!(added.success());
}

#[cfg(target_vendor = "apple")]
fn acl(path: &Path) -> String {
    let listing = std::process::Command::new("/bin/ls")
        .arg("-led")
        .arg(path)
        .output()
        .unwrap();
    assert!(listing.status.success());
    String::from_utf8(listing.stdout)
        .unwrap()
        .lines()
        .skip(1)
        .collect::<Vec<_>>()
        .join("\n")
}

/// macOS keeps a Finder tag when an app saves a file, but not the text
/// encoding of the old content.
#[cfg(target_vendor = "apple")]
#[test]
fn a_write_keeps_finder_tags_and_the_acl_but_not_the_text_encoding() {
    let scratch = Scratch::new();
    let note = scratch.path().join("note.md");
    std::fs::write(&note, b"before").unwrap();
    set_xattr(&note, TAGS, RED_TAG);
    set_xattr(&note, "com.apple.TextEncoding", b"macintosh;0");
    add_acl_entry(&note, "group:everyone allow readextattr,readsecurity");
    let entries = acl(&note);
    assert!(!entries.is_empty());

    engine_write(
        &scratch.path().join("engine.db"),
        scratch.path(),
        "note.md",
        Some(b"before"),
    );

    assert_eq!(xattr(&note, TAGS).as_deref(), Some(RED_TAG));
    assert_eq!(xattr(&note, "com.apple.TextEncoding"), None);
    assert_eq!(acl(&note), entries);
}

/// A folder entry that gives every new file in it read access for everyone.
#[cfg(target_vendor = "apple")]
const SHARED_FOLDER: &str = "group:everyone allow read,file_inherit,directory_inherit";

/// A secret's temp is the file the secret becomes, so a grant the folder
/// gives the temp at creation would let everyone read the plaintext.
#[cfg(target_vendor = "apple")]
#[test]
fn a_folders_inherited_grant_never_reaches_a_secret() {
    let scratch = Scratch::new();
    let root = scratch.path().join("ws");
    std::fs::create_dir_all(root.join("app")).unwrap();
    add_acl_entry(&root, SHARED_FOLDER);
    add_acl_entry(&root.join("app"), SHARED_FOLDER);
    let mut store = EngineStore::open(&scratch.path().join("engine.db"), 0).unwrap();
    let job = queue(&mut store, ".env", b"encrypted", Preimage::Absent);
    assert_eq!(
        materialize_secret_one(&store, &root, &job, b"SECRET=1\n", &options()).unwrap(),
        JobOutcome::Completed
    );
    drop(store);
    engine_write(&scratch.path().join("engine.db"), &root, "app/.env", None);

    for env in [root.join(".env"), root.join("app/.env")] {
        assert_eq!(acl(&env), "", "{} took the folder's grant", env.display());
        assert_eq!(mode(&env), 0o600);
    }
}
