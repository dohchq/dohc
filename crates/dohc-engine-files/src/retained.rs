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

/// Whether the volume that holds `file` refuses to unlink a file any process
/// has open, so the sweep can release a source without losing a later write.
/// Only macOS can answer no. Linux asks for a lease instead.
fn checks_busy(root: &Path, file: &std::fs::File) -> std::io::Result<bool> {
    #[cfg(feature = "fault-injection")]
    if unchecked::simulated(root) {
        return Ok(false);
    }
    let _ = root;
    #[cfg(target_vendor = "apple")]
    return dohc_macos_files::refuses_busy_unlink(file);
    #[cfg(not(target_vendor = "apple"))]
    {
        let _ = file;
        Ok(true)
    }
}

/// Test seam: volumes that cannot refuse to unlink an open file, such as a
/// macFUSE mount, simulated for every source below a workspace root.
#[cfg(feature = "fault-injection")]
pub mod unchecked {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    static ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
    /// The simulation lasts until this drops.
    pub struct Simulated(PathBuf);
    pub fn simulate(root: &Path) -> Simulated {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_owned());
        ROOTS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(root.clone());
        Simulated(root)
    }
    impl Drop for Simulated {
        fn drop(&mut self) {
            let mut roots = ROOTS.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(at) = roots.iter().position(|root| root == &self.0) {
                roots.remove(at);
            }
        }
    }
    pub(super) fn simulated(root: &Path) -> bool {
        let roots = ROOTS.lock().unwrap_or_else(|e| e.into_inner());
        if roots.is_empty() {
            return false;
        }
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_owned());
        roots.iter().any(|simulated| root.starts_with(simulated))
    }
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
    // A failed check must not fail the save. The sweep checks again.
    let busy_check_unsupported = checks_busy(root, file).is_ok_and(|checked| !checked);
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
        busy_check_unsupported,
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
    /// The source's volume can or cannot refuse to unlink an open file,
    /// unlike the row records. Record it; the source stays for now.
    BusyCheck {
        unsupported: bool,
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
        match unchanged(&self.path, &self.file, &self.stamp)? {
            None => return Ok(true),
            Some(false) => return Ok(false),
            Some(true) => {}
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

/// Whether `path` still names the file `file` read, with `stamp_then`, or
/// `None` when nothing is left at `path` to remove.
fn unchanged(
    path: &Path,
    file: &std::fs::File,
    stamp_then: &Stamp,
) -> Result<Option<bool>, MaterializeError> {
    let current = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(MaterializeError::io(path, &e)),
    };
    Ok(Some(
        stamp(&current) == *stamp_then
            && stamp(
                &file
                    .metadata()
                    .map_err(|e| MaterializeError::io(path, &e))?,
            ) == *stamp_then,
    ))
}

/// The canonical root, the path that reaches `row`'s source through the
/// engine folder the store at `database` opened through, and the open
/// source with its metadata. `None` when the source is gone.
fn open_source(
    root: &Path,
    database: &Path,
    row: &RetainedDisplacement,
) -> Result<Option<(PathBuf, PathBuf, std::fs::File, std::fs::Metadata)>, MaterializeError> {
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
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(MaterializeError::io(&path, &e)),
    };
    let meta = file
        .metadata()
        .map_err(|e| MaterializeError::io(&path, &e))?;
    if !meta.is_file() {
        return Err(MaterializeError::BlockedTarget);
    }
    Ok(Some((root, path, file, meta)))
}

/// Whether `file`'s volume cannot refuse to unlink an open file, when the
/// row records otherwise. Reads no content.
fn busy_check_change(
    root: &Path,
    file: &std::fs::File,
    path: &Path,
    row: &RetainedDisplacement,
) -> Result<Option<bool>, MaterializeError> {
    let unsupported = !checks_busy(root, file).map_err(|e| MaterializeError::io(path, &e))?;
    Ok((unsupported != row.busy_check_unsupported).then_some(unsupported))
}

/// `row` as `file` now reads: `stamp`, `digest`, and whether its volume can
/// refuse to unlink an open file.
fn current_row(
    root: &Path,
    row: &RetainedDisplacement,
    file: &std::fs::File,
    path: &Path,
    stamp: Stamp,
    digest: String,
) -> Result<RetainedDisplacement, MaterializeError> {
    let (device, inode, size, mtime, ctime) = stamp;
    Ok(RetainedDisplacement {
        device,
        inode,
        digest,
        size,
        mtime,
        ctime,
        busy_check_unsupported: !checks_busy(root, file)
            .map_err(|e| MaterializeError::io(path, &e))?,
        ..row.clone()
    })
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
    let Some((root, path, file, meta)) = open_source(root, database, row)? else {
        return Ok(Inspection::Missing);
    };
    let initial = stamp(&meta);
    let (device, inode, size, mtime, ctime) = &initial;
    // The descriptor was reopened by path. Device numbers can change on remount;
    // compare content instead of treating the old identity as an eternal fence.
    let identity_changed = *device != row.device || *inode != row.inode;
    let changed = (*size, mtime.as_str(), ctime.as_str())
        != (row.size, row.mtime.as_str(), row.ctime.as_str());
    // A hold forbids release, so an unchanged stamp needs no content read.
    // A changed stamp still reaches the durable observation path below. The
    // volume's capability is still recorded, so a held row is counted.
    if held && !identity_changed && !changed {
        return Ok(match busy_check_change(&root, &file, &path, row)? {
            Some(unsupported) => Inspection::BusyCheck { unsupported },
            None => Inspection::Keep,
        });
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
    if !identity_changed && !changed {
        #[cfg(target_os = "linux")]
        if writer_present(&file, &path)? {
            return Ok(Inspection::Keep);
        }
        // A volume that cannot refuse a busy unlink never releases its source,
        // so only a changed stamp needs a read there.
        if let Some(unsupported) = busy_check_change(&root, &file, &path, row)? {
            return Ok(Inspection::BusyCheck { unsupported });
        }
        if row.busy_check_unsupported {
            return Ok(Inspection::Keep);
        }
    }
    let bytes = read(&file, &path)?;
    if bytes.len() > MAX_MATERIALIZE_BYTES {
        return Ok(Inspection::Oversized);
    }
    let digest = hex_sha256(&bytes);
    // Even an unstable read is kept. Its new clock forces another comparison.
    // A new identity with the same bytes is recorded once, held or not, so a
    // backed-off source is not read again on every pass.
    if digest != row.digest
        || identity_changed
        || changed
        || stamp(
            &file
                .metadata()
                .map_err(|e| MaterializeError::io(&path, &e))?,
        ) != initial
    {
        let current = current_row(&root, row, &file, &path, initial, digest)?;
        return Ok(Inspection::Changed { current, bytes });
    }
    Ok(Inspection::Release(Release {
        path,
        file,
        stamp: initial,
    }))
}

/// What an explicit delete found at a retained row's source.
pub enum DeleteCheck {
    /// The source is already gone.
    Missing,
    /// The source stays: it is too large to read, unreadable, or its volume
    /// can tell whether a process has it open, so the sweep releases it.
    Skip,
    /// The source no longer matches its row. Record `bytes` durably; the
    /// source stays.
    Changed {
        current: RetainedDisplacement,
        bytes: Vec<u8>,
    },
    /// The source matches its row and its volume cannot tell whether a
    /// process has it open.
    Delete(Deletion),
}

/// Owns the descriptor of a source an explicit delete read, until the last
/// identity check and unlink.
pub struct Deletion {
    path: PathBuf,
    file: std::fs::File,
    stamp: Stamp,
}
impl Deletion {
    /// Unlink the source unless its stamp changed since it was read. Its
    /// volume cannot tell whether a process has it open, so this does not
    /// ask: a program that still has it open may lose what it writes next.
    /// Returns false when the source stays.
    pub fn remove(self) -> Result<bool, MaterializeError> {
        match unchanged(&self.path, &self.file, &self.stamp)? {
            None => return Ok(true),
            Some(false) => return Ok(false),
            Some(true) => {}
        }
        drop(self.file);
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(e) => Err(MaterializeError::io(&self.path, &e)),
        }
    }
}

/// Reopen `row`'s source for an explicit delete and compare its identity
/// and content with the row. Only a source on a volume that cannot refuse to
/// unlink an open file can be deleted this way.
pub fn check_for_delete(
    root: &Path,
    database: &Path,
    row: &RetainedDisplacement,
) -> Result<DeleteCheck, MaterializeError> {
    check_for_delete_with_reader(root, database, row, read_source)
}

fn check_for_delete_with_reader(
    root: &Path,
    database: &Path,
    row: &RetainedDisplacement,
    read: impl FnOnce(&std::fs::File, &Path) -> Result<Vec<u8>, MaterializeError>,
) -> Result<DeleteCheck, MaterializeError> {
    let (root, path, file, meta) = match open_source(root, database, row) {
        Ok(Some(source)) => source,
        Ok(None) => return Ok(DeleteCheck::Missing),
        Err(MaterializeError::Io { .. }) => return Ok(DeleteCheck::Skip),
        Err(error) => return Err(error),
    };
    // The sweep moves an oversized source to the kept copies.
    if meta.len() > MAX_MATERIALIZE_BYTES as u64 {
        return Ok(DeleteCheck::Skip);
    }
    if checks_busy(&root, &file).unwrap_or(true) {
        return Ok(DeleteCheck::Skip);
    }
    let initial = stamp(&meta);
    let Ok(bytes) = read(&file, &path) else {
        return Ok(DeleteCheck::Skip);
    };
    if bytes.len() > MAX_MATERIALIZE_BYTES {
        return Ok(DeleteCheck::Skip);
    }
    let digest = hex_sha256(&bytes);
    let recorded = (
        row.device.clone(),
        row.inode.clone(),
        row.size,
        row.mtime.clone(),
        row.ctime.clone(),
    );
    let Ok(after) = file.metadata() else {
        return Ok(DeleteCheck::Skip);
    };
    if digest != row.digest || initial != recorded || stamp(&after) != initial {
        let current = current_row(&root, row, &file, &path, initial, digest)?;
        return Ok(DeleteCheck::Changed { current, bytes });
    }
    Ok(DeleteCheck::Delete(Deletion {
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
        busy_check_unsupported: false,
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
        busy_check_unsupported: false,
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

#[cfg(test)]
fn row_for(source: &Path, rel: &str, bytes: &[u8]) -> RetainedDisplacement {
    let (device, inode, size, mtime, ctime) = stamp(&std::fs::metadata(source).unwrap());
    RetainedDisplacement {
        displacement_id: 1,
        job_id: "job".into(),
        workspace_id: "ws".into(),
        target_path: "notes.md".into(),
        source_path: rel.into(),
        device,
        inode,
        digest: hex_sha256(bytes),
        size,
        mtime,
        ctime,
        changed_at_ms: 0,
        busy_check_unsupported: false,
    }
}

/// #2205: after a remount gives a source a new device number and the same
/// bytes, its identity is recorded once, held or not. A release backed off
/// for minutes then keeps the source without reading it on every pass.
#[cfg(all(test, feature = "fault-injection"))]
#[test]
fn a_remounted_source_is_read_once_while_its_release_is_backed_off() {
    use std::cell::Cell;
    for simulate_unchecked in [false, true] {
        let scratch = dohc_test_scratch::ScratchDir::new_named("remounted-reads").unwrap();
        let root = scratch.path();
        let db = &root.join("engine.db");
        let source = root.join("source");
        std::fs::write(&source, b"before").unwrap();
        let _unchecked = simulate_unchecked.then(|| unchecked::simulate(root));
        let mut row = row_for(&source, "source", b"before");
        row.device = "previous mount".into();
        let reads = Cell::new(0);
        let read = |file: &std::fs::File, path: &Path| {
            reads.set(reads.get() + 1);
            read_source(file, path)
        };
        let backed_off = 60_000 + 15 * 60_000;
        match inspect_with_reader(root, db, &row, 60_000, false, backed_off, read).unwrap() {
            Inspection::Changed { current, bytes } => {
                assert_eq!(bytes, b"before");
                assert_eq!(current.digest, row.digest);
                assert_eq!(current.busy_check_unsupported, simulate_unchecked);
                row = current;
                // As record_retained_read stamps it.
                row.changed_at_ms = 60_000;
            }
            _ => panic!("a new identity is recorded once"),
        }
        for now in (61_000..120_000).step_by(1_000) {
            assert!(matches!(
                inspect_with_reader(root, db, &row, now, false, backed_off, read).unwrap(),
                Inspection::Keep
            ));
        }
        println!(
            "remount, unchecked volume {simulate_unchecked}: 60 backed-off passes, {} read",
            reads.get()
        );
        assert_eq!(reads.get(), 1, "a recorded remount is not read again");
        let after_backoff =
            inspect_with_reader(root, db, &row, backed_off, false, backed_off, read).unwrap();
        if simulate_unchecked {
            assert!(matches!(after_backoff, Inspection::Keep));
            assert_eq!(
                reads.get(),
                1,
                "an unchecked volume's source is never read to release"
            );
        } else {
            assert!(matches!(after_backoff, Inspection::Release(_)));
            assert_eq!(reads.get(), 2);
        }
    }
}

/// The sweep records once that a source's volume cannot refuse to unlink an
/// open file, then keeps it unread.
#[cfg(all(test, feature = "fault-injection"))]
#[test]
fn an_unchecked_volume_is_recorded_once_and_its_source_kept_unread() {
    let scratch = dohc_test_scratch::ScratchDir::new_named("unchecked-volume").unwrap();
    let root = scratch.path();
    let db = &root.join("engine.db");
    let source = root.join("source");
    std::fs::write(&source, b"before").unwrap();
    let mut row = row_for(&source, "source", b"before");
    let unread = |_: &std::fs::File, _: &Path| -> Result<Vec<u8>, MaterializeError> {
        panic!("an unchanged source on an unchecked volume is not read")
    };
    let simulated = unchecked::simulate(root);
    assert!(matches!(
        inspect_with_reader(root, db, &row, 60_000, false, 0, unread).unwrap(),
        Inspection::BusyCheck { unsupported: true }
    ));
    row.busy_check_unsupported = true;
    assert!(matches!(
        inspect_with_reader(root, db, &row, 60_000, false, 0, unread).unwrap(),
        Inspection::Keep
    ));
    drop(simulated);
    assert!(matches!(
        inspect_with_reader(root, db, &row, 60_000, false, 0, unread).unwrap(),
        Inspection::BusyCheck { unsupported: false }
    ));
}

/// An explicit delete reads the source and deletes it only when it matches
/// its row on a volume that cannot refuse to unlink an open file.
#[cfg(all(test, feature = "fault-injection"))]
#[test]
fn an_explicit_delete_checks_the_volume_identity_and_content() {
    let scratch = dohc_test_scratch::ScratchDir::new_named("delete-check").unwrap();
    let root = scratch.path();
    let db = &root.join("engine.db");
    let source = root.join("source");
    std::fs::write(&source, b"before").unwrap();
    let mut row = row_for(&source, "source", b"before");
    row.busy_check_unsupported = true;
    assert!(
        matches!(check_for_delete(root, db, &row).unwrap(), DeleteCheck::Skip),
        "a volume that can tell is the sweep's"
    );
    let _simulated = unchecked::simulate(root);
    std::fs::write(&source, b"late write").unwrap();
    let DeleteCheck::Changed { current, bytes } = check_for_delete(root, db, &row).unwrap() else {
        panic!("changed bytes are recorded, not deleted");
    };
    assert_eq!(bytes, b"late write");
    assert!(current.busy_check_unsupported);
    let row = current;
    let DeleteCheck::Delete(deletion) = check_for_delete(root, db, &row).unwrap() else {
        panic!("a source that matches its row can be deleted");
    };
    // A write between the check and the unlink keeps the source.
    std::fs::write(&source, b"later still").unwrap();
    assert!(!deletion.remove().unwrap());
    assert!(source.exists());
    let row = row_for(&source, "source", b"later still");
    let DeleteCheck::Delete(deletion) = check_for_delete(root, db, &row).unwrap() else {
        panic!("a source that matches its row can be deleted");
    };
    assert!(deletion.remove().unwrap());
    assert!(!source.exists());
    assert!(matches!(
        check_for_delete(root, db, &row).unwrap(),
        DeleteCheck::Missing
    ));
    std::fs::File::create(&source)
        .unwrap()
        .set_len(MAX_MATERIALIZE_BYTES as u64 + 1)
        .unwrap();
    assert!(matches!(
        check_for_delete(root, db, &row).unwrap(),
        DeleteCheck::Skip
    ));
}

/// A source another step removed between the check and the unlink counts as
/// gone, for the sweep and for an explicit delete.
#[cfg(all(test, feature = "fault-injection"))]
#[test]
fn a_source_gone_before_its_unlink_counts_as_removed() {
    let scratch = dohc_test_scratch::ScratchDir::new_named("gone-before-unlink").unwrap();
    let root = scratch.path();
    let db = &root.join("engine.db");
    let source = root.join("source");
    std::fs::write(&source, b"before").unwrap();
    let row = row_for(&source, "source", b"before");
    let Inspection::Release(release) =
        inspect_with_reader(root, db, &row, 60_000, false, 0, read_source).unwrap()
    else {
        panic!("a quiet unchanged source is released");
    };
    std::fs::remove_file(&source).unwrap();
    assert!(release.remove().unwrap());
    std::fs::write(&source, b"before").unwrap();
    let row = row_for(&source, "source", b"before");
    let _simulated = unchecked::simulate(root);
    let DeleteCheck::Delete(deletion) = check_for_delete(root, db, &row).unwrap() else {
        panic!("a source that matches its row can be deleted");
    };
    std::fs::remove_file(&source).unwrap();
    assert!(deletion.remove().unwrap());
}

/// A held source's volume is still checked, without reading the source, so
/// a row from before migration 67 that stays held is counted.
#[cfg(all(test, feature = "fault-injection"))]
#[test]
fn a_held_source_records_its_volume_without_a_read() {
    let scratch = dohc_test_scratch::ScratchDir::new_named("held-volume").unwrap();
    let root = scratch.path();
    let db = &root.join("engine.db");
    let source = root.join("source");
    std::fs::write(&source, b"before").unwrap();
    let mut row = row_for(&source, "source", b"before");
    let unread = |_: &std::fs::File, _: &Path| -> Result<Vec<u8>, MaterializeError> {
        panic!("an unchanged held source is not read")
    };
    let simulated = unchecked::simulate(root);
    assert!(matches!(
        inspect_with_reader(root, db, &row, 1_000, true, 0, unread).unwrap(),
        Inspection::BusyCheck { unsupported: true }
    ));
    row.busy_check_unsupported = true;
    assert!(matches!(
        inspect_with_reader(root, db, &row, 1_000, true, 0, unread).unwrap(),
        Inspection::Keep
    ));
    drop(simulated);
    assert!(matches!(
        inspect_with_reader(root, db, &row, 1_000, true, 0, unread).unwrap(),
        Inspection::BusyCheck { unsupported: false }
    ));
}
