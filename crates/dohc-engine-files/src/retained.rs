//! Off-writer inspection of staged POSIX originals.
//! Changed bytes must be durably imported before the quiet clock restarts.
use super::materialize::{
    MAX_MATERIALIZE_BYTES, MaterializeError, ensure_target_symlink_free, open_displaced,
    stored_name, stored_path,
};
use dohc_engine_storage::{DisplacementSpec, EngineStore, RetainedDisplacement, hex_sha256};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
pub const QUIET_PERIOD_MS: i64 = 30_000;
type Stamp = (String, String, i64, String, String);
fn stamp(metadata: &std::fs::Metadata) -> Stamp {
    (
        metadata.dev().to_string(),
        metadata.ino().to_string(),
        metadata.len().min(i64::MAX as u64) as i64,
        format!("{}:{}", metadata.mtime(), metadata.mtime_nsec()),
        format!("{}:{}", metadata.ctime(), metadata.ctime_nsec()),
    )
}
pub(super) fn retain_known(
    store: &EngineStore,
    root: &Path,
    path: &Path,
    file: &std::fs::File,
    digest: &str,
    spec: &DisplacementSpec,
    now_ms: i64,
) -> Result<(), MaterializeError> {
    let (id, links) = register_known(store, root, path, file, digest, spec, now_ms)?;
    release_linked(store, path, id, links)
}

pub(super) fn register_known(
    store: &EngineStore,
    root: &Path,
    path: &Path,
    file: &std::fs::File,
    digest: &str,
    spec: &DisplacementSpec,
    now_ms: i64,
) -> Result<(i64, u64), MaterializeError> {
    let meta = file
        .metadata()
        .map_err(|e| MaterializeError::io(path, &e))?;
    let (device, inode, size, mtime, ctime) = stamp(&meta);
    let source_path = stored_name(store.database_path(), root, path)?;
    let id = store.retain_displacement(&RetainedDisplacement {
        displacement_id: 0,
        job_id: spec.job_id.clone(),
        workspace_id: spec.workspace_id.clone(),
        target_path: spec.target_path.clone(),
        source_path,
        device,
        inode,
        digest: digest.to_owned(),
        size,
        mtime,
        ctime,
        changed_at_ms: now_ms,
    })?;
    Ok((id, meta.nlink()))
}

pub(super) fn release_linked(
    store: &EngineStore,
    path: &Path,
    id: i64,
    links: u64,
) -> Result<(), MaterializeError> {
    if links > 1 {
        // Unlinking this staged name leaves the other hard link reachable.
        std::fs::remove_file(path).map_err(|e| MaterializeError::io(path, &e))?;
        store.release_retained(id)?;
    }
    Ok(())
}

pub enum Inspection {
    Missing,
    Keep,
    /// Keep the complete source through the kept-copy API; do not read a prefix.
    Oversized,
    Changed {
        current: RetainedDisplacement,
        bytes: Vec<u8>,
    },
    Release(Release),
}
/// Owns the descriptor until the last identity check and unlink. On macOS it
/// closes the descriptor just before the unlink, which an open file refuses.
/// `remove` returns false when the source stays: its stamp changed, or, on
/// macOS, a process has it open or its file system cannot tell.
pub struct Release {
    path: PathBuf,
    file: std::fs::File,
    stamp: Stamp,
}
impl Release {
    pub fn remove(self) -> Result<bool, MaterializeError> {
        let current = match std::fs::symlink_metadata(&self.path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(e) => return Err(MaterializeError::io(&self.path, &e)),
        };
        if stamp(&current) != self.stamp
            || stamp(
                &self
                    .file
                    .metadata()
                    .map_err(|e| MaterializeError::io(&self.path, &e))?,
            ) != self.stamp
        {
            return Ok(false);
        }
        // macOS cannot list another process's writers, but the file systems
        // it knows refuse to unlink a file any process has open.
        #[cfg(target_vendor = "apple")]
        {
            dohc_macos_files::remove_unless_open(self.file, &self.path)
                .map_err(|e| MaterializeError::io(&self.path, &e))
        }
        #[cfg(not(target_vendor = "apple"))]
        {
            std::fs::remove_file(&self.path).map_err(|e| MaterializeError::io(&self.path, &e))?;
            Ok(true)
        }
    }
}

/// An unchanged source is kept, unread, until both its quiet period and
/// `retry_at_ms` have passed. The caller backs off a refused release with
/// `retry_at_ms`. A changed stamp is read at once. The source is reached
/// through the engine folder the store at `database` opened through.
pub fn inspect(
    root: &Path,
    database: &Path,
    row: &RetainedDisplacement,
    now_ms: i64,
    held: bool,
    retry_at_ms: i64,
) -> Result<Inspection, MaterializeError> {
    inspect_with_reader(root, database, row, now_ms, held, retry_at_ms, read_source)
}

fn read_source(file: &std::fs::File, path: &Path) -> Result<Vec<u8>, MaterializeError> {
    let mut bytes = Vec::new();
    file.take(MAX_MATERIALIZE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| MaterializeError::io(path, &e))?;
    Ok(bytes)
}

fn inspect_with_reader(
    root: &Path,
    database: &Path,
    row: &RetainedDisplacement,
    now_ms: i64,
    held: bool,
    retry_at_ms: i64,
    read: impl FnOnce(&std::fs::File, &Path) -> Result<Vec<u8>, MaterializeError>,
) -> Result<Inspection, MaterializeError> {
    let rel = Path::new(&row.source_path);
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(MaterializeError::UnsafeTargetPath);
    }
    let root = std::fs::canonicalize(root).map_err(|e| MaterializeError::io(root, &e))?;
    let (base, path) = stored_path(database, &root, rel);
    ensure_target_symlink_free(&base, &path)?;
    let file = match open_displaced(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Inspection::Missing),
        Err(e) => return Err(MaterializeError::io(&path, &e)),
    };
    let meta = file
        .metadata()
        .map_err(|e| MaterializeError::io(&path, &e))?;
    let initial = stamp(&meta);
    let (device, inode, size, mtime, ctime) = initial.clone();
    if !meta.is_file() {
        return Err(MaterializeError::BlockedTarget);
    }
    // The descriptor was reopened by path. Device numbers can change on remount;
    // compare content instead of treating the old identity as an eternal fence.
    let identity_changed = device != row.device || inode != row.inode;
    let changed = (size, mtime.as_str(), ctime.as_str())
        != (row.size, row.mtime.as_str(), row.ctime.as_str());
    // A hold forbids release, so an unchanged stamp needs no content read.
    // A changed stamp still reaches the durable observation path below.
    if held && !identity_changed && !changed {
        return Ok(Inspection::Keep);
    }
    if !held && !identity_changed && meta.nlink() > 1 && now_ms >= retry_at_ms {
        return Ok(Inspection::Release(Release {
            path,
            file,
            stamp: initial,
        }));
    }
    let quiet =
        now_ms.saturating_sub(row.changed_at_ms) >= QUIET_PERIOD_MS && now_ms >= retry_at_ms;
    if !identity_changed && !quiet && !changed {
        return Ok(Inspection::Keep);
    }
    if meta.len() > MAX_MATERIALIZE_BYTES as u64 {
        return Ok(Inspection::Oversized);
    }
    #[cfg(target_os = "linux")]
    let lease_checked = !identity_changed && !changed;
    #[cfg(target_os = "linux")]
    if lease_checked && writer_present(&file, &path)? {
        return Ok(Inspection::Keep);
    }
    // A volume that cannot refuse a busy unlink never releases its source,
    // so only a changed stamp needs a read there.
    #[cfg(target_vendor = "apple")]
    if !identity_changed
        && !changed
        && !dohc_macos_files::refuses_busy_unlink(&file)
            .map_err(|e| MaterializeError::io(&path, &e))?
    {
        return Ok(Inspection::Keep);
    }
    let bytes = read(&file, &path)?;
    if bytes.len() > MAX_MATERIALIZE_BYTES {
        return Ok(Inspection::Oversized);
    }
    let digest = hex_sha256(&bytes);
    // Even an unstable read is kept. Its new clock forces another comparison.
    if digest != row.digest
        || (held && identity_changed)
        || (!identity_changed && changed)
        || stamp(
            &file
                .metadata()
                .map_err(|e| MaterializeError::io(&path, &e))?,
        ) != initial
    {
        let mut current = row.clone();
        current.device = device;
        current.inode = inode;
        current.digest = digest;
        current.size = size;
        current.mtime = mtime;
        current.ctime = ctime;
        return Ok(Inspection::Changed { current, bytes });
    }
    if identity_changed && !quiet {
        return Ok(Inspection::Keep);
    }
    #[cfg(target_os = "linux")]
    if !lease_checked && writer_present(&file, &path)? {
        return Ok(Inspection::Keep);
    }
    Ok(Inspection::Release(Release {
        path,
        file,
        stamp: initial,
    }))
}

#[cfg(target_os = "linux")]
fn writer_present(file: &std::fs::File, path: &Path) -> Result<bool, MaterializeError> {
    Ok(
        dohc_linux_files::probe(file).map_err(|e| MaterializeError::io(path, &e))?
            == dohc_linux_files::LeaseProbe::WriterPresent,
    )
}

#[cfg(test)]
#[test]
fn materialize_held_source_reads_only_after_stamp_changes() {
    use std::cell::Cell;
    let scratch = dohc_test_scratch::ScratchDir::new_named("held-inspection-reads").unwrap();
    let root = scratch.path();
    let db = &root.join("engine.db");
    let source = root.join("source");
    std::fs::write(&source, b"before").unwrap();
    let (device, inode, size, mtime, ctime) = stamp(&std::fs::metadata(&source).unwrap());
    let mut row = RetainedDisplacement {
        displacement_id: 1,
        job_id: "held".into(),
        workspace_id: "ws".into(),
        target_path: "notes.md".into(),
        source_path: "source".into(),
        device,
        inode,
        digest: hex_sha256(b"before"),
        size,
        mtime,
        ctime,
        changed_at_ms: 0,
    };
    let reads = Cell::new(0);
    let read = |file: &std::fs::File, path: &Path| {
        reads.set(reads.get() + 1);
        read_source(file, path)
    };
    for _ in 0..10 {
        assert!(matches!(
            inspect_with_reader(root, db, &row, 60_000, true, 0, read).unwrap(),
            Inspection::Keep
        ));
    }
    println!("10 quiet held inspections: {} reads", reads.get());
    assert_eq!(reads.get(), 0, "quiet held sources must not be read");
    std::fs::write(&source, b"late outside write").unwrap();
    match inspect_with_reader(root, db, &row, 60_000, true, 0, read).unwrap() {
        Inspection::Changed { current, bytes } => {
            assert_eq!(bytes, b"late outside write");
            row = current;
            row.changed_at_ms = 60_000;
        }
        _ => panic!("held changes must still import"),
    }
    assert_eq!(reads.get(), 1);
    for _ in 0..10 {
        assert!(matches!(
            inspect_with_reader(root, db, &row, 90_000, true, 0, read).unwrap(),
            Inspection::Keep
        ));
    }
    assert_eq!(reads.get(), 1, "imported held sources must not be re-read");
    row.device = "previous mount".into();
    match inspect_with_reader(root, db, &row, 90_000, true, 0, read).unwrap() {
        Inspection::Changed { current, bytes } => {
            assert_eq!(bytes, b"late outside write");
            row = current;
        }
        _ => panic!("held remounts must refresh the stamp once"),
    }
    assert!(matches!(
        inspect_with_reader(root, db, &row, 90_000, true, 0, read).unwrap(),
        Inspection::Keep
    ));
    assert_eq!(reads.get(), 2);
    assert!(matches!(
        inspect_with_reader(root, db, &row, 90_000, false, 0, read).unwrap(),
        Inspection::Release(_)
    ));
    assert_eq!(reads.get(), 3);
    println!(
        "20 quiet held inspections: 0 reads; changed source, remount and cleared hold: 1 read each"
    );
}

#[cfg(test)]
#[test]
fn a_backed_off_source_is_read_only_after_its_retry_time_or_a_change() {
    use std::cell::Cell;
    let scratch = dohc_test_scratch::ScratchDir::new_named("backed-off-reads").unwrap();
    let root = scratch.path();
    let db = &root.join("engine.db");
    let source = root.join("source");
    std::fs::write(&source, b"before").unwrap();
    let (device, inode, size, mtime, ctime) = stamp(&std::fs::metadata(&source).unwrap());
    let row = RetainedDisplacement {
        displacement_id: 1,
        job_id: "backed-off".into(),
        workspace_id: "ws".into(),
        target_path: "notes.md".into(),
        source_path: "source".into(),
        device,
        inode,
        digest: hex_sha256(b"before"),
        size,
        mtime,
        ctime,
        changed_at_ms: 0,
    };
    let reads = Cell::new(0);
    let read = |file: &std::fs::File, path: &Path| {
        reads.set(reads.get() + 1);
        read_source(file, path)
    };
    let reader = std::fs::File::open(&source).unwrap();
    let Inspection::Release(release) =
        inspect_with_reader(root, db, &row, 60_000, false, 0, read).unwrap()
    else {
        panic!("a quiet unchanged source is released");
    };
    assert_eq!(reads.get(), 1);
    #[cfg(target_vendor = "apple")]
    assert!(!release.remove().unwrap(), "an open source stays on macOS");
    #[cfg(not(target_vendor = "apple"))]
    drop(release);
    for now in 60_001..60_011 {
        assert!(matches!(
            inspect_with_reader(root, db, &row, now, false, 90_000, read).unwrap(),
            Inspection::Keep
        ));
    }
    assert_eq!(reads.get(), 1, "a backed-off source is not read");
    assert!(matches!(
        inspect_with_reader(root, db, &row, 90_000, false, 90_000, read).unwrap(),
        Inspection::Release(_)
    ));
    assert_eq!(reads.get(), 2, "every release attempt reads first");
    drop(reader);
    std::fs::write(&source, b"changed").unwrap();
    assert!(matches!(
        inspect_with_reader(root, db, &row, 90_001, false, 1_000_000, read).unwrap(),
        Inspection::Changed { .. }
    ));
    assert_eq!(reads.get(), 3, "a changed stamp is read at once");
}
