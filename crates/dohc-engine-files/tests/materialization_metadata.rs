//! An engine write keeps the group and permission bits of the file it
//! replaces, and on macOS its ACL and the extended attributes a save keeps.
//! When it cannot keep the group or the ACL, it keeps only the owner's bits.
//! A new file follows the umask, and a secret stays owner-only.
#![cfg(unix)]
mod common;

#[cfg(target_vendor = "apple")]
use common::FatVolume;
use common::Scratch;
use dohc_engine_files::{
    DurabilityPolicy, JobOutcome, MaterializeOptions, NoBackoff, StdReplacer, materialize_one,
    materialize_secret_one, materialize_write_conflict,
};
use dohc_engine_storage::{
    EngineStore, MaterializationJob, MaterializationJobSpec, NoFaults, Preimage, enqueue_job,
};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
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

/// Write "after" to `path` under `root`, as a peer's edit arrives, expecting
/// the file to hold `before`, or not to exist when `before` is `None`.
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

/// The one `.conflict` copy in `dir`.
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

fn gid(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().gid()
}

/// The groups this process belongs to.
fn groups() -> Vec<u32> {
    let listed = std::process::Command::new("id").arg("-G").output().unwrap();
    assert!(listed.status.success());
    String::from_utf8(listed.stdout)
        .unwrap()
        .split_whitespace()
        .map(|group| group.parse().unwrap())
        .collect()
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
fn a_new_file_follows_the_umask() {
    let scratch = Scratch::new();
    let probe = scratch.path().join("umask-probe");
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o666)
        .open(&probe)
        .unwrap();
    let umask_mode = mode(&probe);

    engine_write(
        &scratch.path().join("engine.db"),
        scratch.path(),
        "new.md",
        None,
    );

    assert_eq!(mode(&scratch.path().join("new.md")), umask_mode);
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
fn a_secret_path_written_as_an_ordinary_job_stays_owner_only() {
    let scratch = Scratch::new();
    let env = scratch.path().join(".env");
    std::fs::write(&env, b"before").unwrap();
    set_mode(&env, 0o644);

    engine_write(
        &scratch.path().join("engine.db"),
        scratch.path(),
        ".env",
        Some(b"before"),
    );

    assert_eq!(mode(&env), 0o600);
}

#[test]
fn a_conflict_copy_takes_the_mode_of_the_file_it_sits_beside() {
    let scratch = Scratch::new();
    let script = scratch.path().join("run.sh");
    std::fs::write(&script, b"an outside edit").unwrap();
    set_mode(&script, 0o755);

    let outcome = write_job(
        &scratch.path().join("engine.db"),
        scratch.path(),
        "run.sh",
        Some(b"before"),
    );

    assert_eq!(outcome, JobOutcome::Conflict);
    assert_eq!(std::fs::read(&script).unwrap(), b"an outside edit");
    assert_eq!(mode(&conflict_copy(scratch.path())), 0o755);
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

#[test]
fn a_write_keeps_the_replaced_files_group() {
    let scratch = Scratch::new();
    let probe = scratch.path().join("group-probe");
    std::fs::write(&probe, b"").unwrap();
    let new_file_gid = gid(&probe);
    let candidates = if std::fs::metadata(&probe).unwrap().uid() == 0 {
        vec![new_file_gid + 1]
    } else {
        // macOS's admin group (80) first, for an administrator in a staff folder.
        let mut groups = groups();
        groups.sort_by_key(|&group| group != 80);
        groups
    };
    let report = scratch.path().join("report.md");
    std::fs::write(&report, b"before").unwrap();
    let Some(other) = candidates.into_iter().find(|&group| {
        group != new_file_gid && std::os::unix::fs::chown(&report, None, Some(group)).is_ok()
    }) else {
        eprintln!("SKIP: this process can give a file no other group");
        return;
    };
    set_mode(&report, 0o640);

    engine_write(
        &scratch.path().join("engine.db"),
        scratch.path(),
        "report.md",
        Some(b"before"),
    );

    assert_eq!(gid(&report), other);
    assert_eq!(mode(&report), 0o640);
}

/// Make `report.md` in `root` with `mode` and a group this user does not
/// belong to. A file keeps its group when it moves, so a file made in
/// `/private/tmp` keeps that folder's group. `None` when this user belongs
/// to it or the move fails.
#[cfg(target_vendor = "apple")]
fn file_in_a_foreign_group(root: &Path, mode: u32) -> Option<PathBuf> {
    let shared = Path::new("/private/tmp");
    let foreign = gid(shared);
    if gid(root) == foreign || groups().contains(&foreign) {
        eprintln!("SKIP: this process belongs to the group of {shared:?}");
        return None;
    }
    let made = shared.join(format!("dohc-group-{}-{mode:o}", std::process::id()));
    std::fs::write(&made, b"before").unwrap();
    set_mode(&made, mode);
    let report = root.join("report.md");
    if std::fs::rename(&made, &report).is_err() {
        let _ = std::fs::remove_file(&made);
        eprintln!("SKIP: {shared:?} is on another volume");
        return None;
    }
    assert_eq!(gid(&report), foreign);
    Some(report)
}

/// The temp cannot take a group this user does not belong to. A member of it
/// who is not the owner cannot read a 0604 file, so the temp must not give
/// "other" read access either.
#[cfg(target_vendor = "apple")]
#[test]
fn only_the_owner_bits_stay_when_the_temp_cannot_take_the_files_group() {
    let scratch = Scratch::new();
    let Some(report) = file_in_a_foreign_group(scratch.path(), 0o604) else {
        return;
    };

    engine_write(
        &scratch.path().join("engine.db"),
        scratch.path(),
        "report.md",
        Some(b"before"),
    );

    assert_ne!(gid(&report), gid(Path::new("/private/tmp")));
    assert_eq!(mode(&report), 0o600);
}

/// With equal group and other bits, a member of the old group loses nothing
/// by counting as other, so a 0755 script stays public.
#[cfg(target_vendor = "apple")]
#[test]
fn equal_group_and_other_bits_stay_when_the_temp_cannot_take_the_files_group() {
    let scratch = Scratch::new();
    let Some(script) = file_in_a_foreign_group(scratch.path(), 0o755) else {
        return;
    };

    engine_write(
        &scratch.path().join("engine.db"),
        scratch.path(),
        "report.md",
        Some(b"before"),
    );

    assert_ne!(gid(&script), gid(Path::new("/private/tmp")));
    assert_eq!(mode(&script), 0o755);
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
    // User 4242 and the group read, and others get nothing.
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

/// User 4242 may not read the file, but others may. The ACL is not copied,
/// so the temp must not give "other" read access, which 4242 would get.
#[cfg(target_os = "linux")]
#[test]
fn a_named_user_deny_entry_leaves_only_the_owner_bits() {
    let scratch = Scratch::new();
    let report = scratch.path().join("report.md");
    std::fs::write(&report, b"before").unwrap();
    let entries = [
        (USER_OBJ, 6, UNDEFINED),
        (USER, 0, 4242),
        (GROUP_OBJ, 0, UNDEFINED),
        (MASK, 0, UNDEFINED),
        (OTHER, 4, UNDEFINED),
    ];
    if !set_posix_acl(&report, "system.posix_acl_access", &entries) {
        return;
    }
    assert_eq!(mode(&report), 0o604);

    engine_write(
        &scratch.path().join("engine.db"),
        scratch.path(),
        "report.md",
        Some(b"before"),
    );

    assert_eq!(mode(&report), 0o600);
}

/// A default ACL added to the folder after the file exists gives every new
/// file, and so the temp, an entry for user 4242 under an empty mask. The
/// file's 0640 must not open that mask.
#[cfg(target_os = "linux")]
#[test]
fn a_folder_default_acl_added_later_leaves_only_the_owner_bits() {
    let scratch = Scratch::new();
    let root = scratch.path().join("ws");
    std::fs::create_dir(&root).unwrap();
    let report = root.join("report.md");
    std::fs::write(&report, b"before").unwrap();
    set_mode(&report, 0o640);
    let entries = [
        (USER_OBJ, 7, UNDEFINED),
        (USER, 6, 4242),
        (GROUP_OBJ, 5, UNDEFINED),
        (MASK, 7, UNDEFINED),
        (OTHER, 0, UNDEFINED),
    ];
    if !set_posix_acl(&root, "system.posix_acl_default", &entries) {
        return;
    }

    engine_write(
        &scratch.path().join("engine.db"),
        &root,
        "report.md",
        Some(b"before"),
    );

    assert_eq!(mode(&report), 0o600, "the mask shows as the group bits");
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

/// fcopyfile carries a quarantine over whatever it is asked to copy, so a
/// file downloaded from the internet stays quarantined after a write.
#[cfg(target_vendor = "apple")]
#[test]
fn a_quarantined_file_stays_quarantined() {
    let scratch = Scratch::new();
    let download = scratch.path().join("download.sh");
    std::fs::write(&download, b"before").unwrap();
    set_xattr(&download, "com.apple.quarantine", b"0081;00000000;Safari;");

    engine_write(
        &scratch.path().join("engine.db"),
        scratch.path(),
        "download.sh",
        Some(b"before"),
    );

    assert!(xattr(&download, "com.apple.quarantine").is_some());
}

/// A folder entry that every new file inherits denies writing extended
/// attributes, so the tag cannot be copied to the temp. The file's own deny
/// entry must still reach the new file before its mode does.
#[cfg(target_vendor = "apple")]
#[test]
fn an_acl_deny_entry_holds_when_an_xattr_cannot_be_copied() {
    let scratch = Scratch::new();
    let root = scratch.path().join("ws");
    std::fs::create_dir(&root).unwrap();
    let note = root.join("note.md");
    std::fs::write(&note, b"before").unwrap();
    set_mode(&note, 0o644);
    set_xattr(&note, TAGS, RED_TAG);
    add_acl_entry(&note, "user:nobody deny read");
    add_acl_entry(&root, "everyone deny writeextattr,file_inherit");

    engine_write(
        &scratch.path().join("engine.db"),
        &root,
        "note.md",
        Some(b"before"),
    );

    assert!(acl(&note).contains("deny read"), "{}", acl(&note));
    assert_eq!(mode(&note), 0o644);
    assert_eq!(xattr(&note, TAGS), None, "the folder entry blocks the copy");
}

/// FAT32 has no extended attributes of its own. macOS keeps them in a `._`
/// file beside each file, and the write must still succeed.
#[cfg(target_vendor = "apple")]
#[test]
fn a_write_on_fat32_succeeds_and_keeps_finder_tags() {
    let scratch = Scratch::new();
    let Some(volume) = FatVolume::attach(scratch.path()) else {
        eprintln!("SKIP: hdiutil could not attach a FAT32 image here");
        return;
    };
    let root = volume.mount.join("ws");
    std::fs::create_dir(&root).unwrap();
    let note = root.join("note.md");
    std::fs::write(&note, b"before").unwrap();
    set_xattr(&note, TAGS, RED_TAG);

    engine_write(
        &scratch.path().join("engine.db"),
        &root,
        "note.md",
        Some(b"before"),
    );

    assert_eq!(xattr(&note, TAGS).as_deref(), Some(RED_TAG));
}
