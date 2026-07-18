use super::faults::{FaultAction, FaultInjector, FaultPoint};
use super::handles::DB_TRIPLET;
use super::state::BackupFingerprint;
use super::{Paths, RehearsalError};
use dohc_engine_storage::{
    BackupOutcome, EngineStore, RealFreeSpace, create_verified_backup, load_valid_backup,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

const DB_BACKUP_STEM: &str = "cutover-engine";
const DIRECTORY_BACKUP_NAME: &str = "cutover-files";
const DIRECTORY_MANIFEST_NAME: &str = "cutover-files.manifest.json";
const MIGRATION_PROBE_DIR: &str = "cutover-migration-probe";
const COPY_BUFFER_BYTES: usize = 64 * 1024;
const SIBLING_SNAPSHOTS: [&str; 3] = ["registry.json", "dm-homing.json", "agent-runs.json"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryBackupEntry {
    pub relative_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryBackupManifest {
    pub verified: bool,
    pub files: Vec<DirectoryBackupEntry>,
    /// Every source engine subdirectory (`engine/<rel>`), so EMPTY dirs are
    /// part of the restore-tested backup rather than silently lost.
    #[serde(default)]
    pub directories: Vec<String>,
}

pub fn load_valid_directory_backup(
    recovery_dir: &Path,
) -> Result<Option<DirectoryBackupManifest>, RehearsalError> {
    let manifest_path = recovery_dir.join(DIRECTORY_MANIFEST_NAME);
    // Alias-safe: a symlinked/hard-linked manifest makes the restore point
    // depend on a mutable file outside the recovery dir.
    if super::require_real_file(&manifest_path, "directory-manifest-alias-refused")?.is_none() {
        return Ok(None);
    }
    let bytes = match std::fs::read(&manifest_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(RehearsalError::io("directory-manifest-read", error)),
    };
    let manifest: DirectoryBackupManifest =
        serde_json::from_slice(&bytes).map_err(|_| RehearsalError::State)?;
    if !manifest.verified || manifest.files.is_empty() {
        return Ok(None);
    }
    let mut declared = BTreeSet::new();
    for entry in &manifest.files {
        if !declared.insert(entry.relative_path.as_str()) {
            return Ok(None);
        }
    }
    let root = recovery_dir.join(DIRECTORY_BACKUP_NAME);
    for entry in &manifest.files {
        let relative = Path::new(&entry.relative_path);
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            // A forged manifest path (absolute, `..`, drive prefix) must never
            // resolve outside the backup directory.
            return Ok(None);
        }
        let path = root.join(relative);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(RehearsalError::io("directory-backup-metadata", error)),
        };
        if !metadata.file_type().is_file() || metadata.len() != entry.size_bytes {
            return Ok(None);
        }
        let (hash, bytes) = hash_file(&path)?;
        if hash != entry.sha256 || bytes != entry.size_bytes {
            return Ok(None);
        }
    }
    for relative in &manifest.directories {
        let relative = Path::new(relative);
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Ok(None);
        }
        let path = root.join(relative);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Ok(None),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(RehearsalError::io("directory-backup-metadata", error)),
        }
    }
    // The backup dir must contain EXACTLY the declared set — files AND
    // directories: an undeclared extra file, empty dir, alias, or special
    // file leaves the manifest hash unchanged and must invalidate the backup
    // rather than ride along into a restore.
    let mut actual_files = Vec::new();
    let mut actual_dirs = Vec::new();
    if !collect_backup_paths(&root, &root, &mut actual_files, &mut actual_dirs)? {
        return Ok(None);
    }
    let actual_files: BTreeSet<&str> = actual_files.iter().map(String::as_str).collect();
    if actual_files != declared {
        return Ok(None);
    }
    let mut expected_dirs: BTreeSet<String> = BTreeSet::new();
    for dir in &manifest.directories {
        if !expected_dirs.insert(dir.clone()) {
            return Ok(None);
        }
        add_ancestor_dirs(dir, &mut expected_dirs);
    }
    for entry in &manifest.files {
        add_ancestor_dirs(&entry.relative_path, &mut expected_dirs);
    }
    let actual_dirs: BTreeSet<String> = actual_dirs.into_iter().collect();
    if actual_dirs != expected_dirs {
        return Ok(None);
    }
    Ok(Some(manifest))
}

/// Insert every ancestor directory of a relative path (portable separators).
fn add_ancestor_dirs(relative: &str, output: &mut BTreeSet<String>) {
    let mut path = Path::new(relative);
    while let Some(parent) = path.parent() {
        if parent.as_os_str().is_empty() {
            break;
        }
        if let Some(text) = parent.to_str() {
            output.insert(portable_separators(text));
        }
        path = parent;
    }
}

/// Walk the published backup dir collecting files AND directories;
/// `Ok(false)` means the tree contains an alias/special/hard-linked/non-UTF-8
/// entry and the backup is invalid.
fn collect_backup_paths(
    root: &Path,
    directory: &Path,
    files: &mut Vec<String>,
    dirs: &mut Vec<String>,
) -> Result<bool, RehearsalError> {
    let entries = std::fs::read_dir(directory)
        .map_err(|e| RehearsalError::io("directory-backup-enumerate", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| RehearsalError::io("directory-backup-entry", e))?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| RehearsalError::io("directory-backup-walk-metadata", e))?;
        if metadata.file_type().is_symlink() {
            return Ok(false);
        }
        if metadata.is_dir() {
            let Some(relative) = path.strip_prefix(root).ok().and_then(Path::to_str) else {
                return Ok(false);
            };
            dirs.push(portable_separators(relative));
            if !collect_backup_paths(root, &path, files, dirs)? {
                return Ok(false);
            }
        } else if metadata.is_file() {
            if super::metadata_is_hard_linked(&metadata) {
                return Ok(false);
            }
            let Some(relative) = path.strip_prefix(root).ok().and_then(Path::to_str) else {
                return Ok(false);
            };
            files.push(portable_separators(relative));
        } else {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn create_restore_tested_backup(
    paths: &Paths,
    recovery_dir: &Path,
    shadow_token: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<(), RehearsalError> {
    ensure_outside_root(&paths.root, recovery_dir)?;
    create_private_dir_all(recovery_dir)?;

    // A pre-existing DB backup at this stem must be a REAL file pair, and is
    // never adopted OR overwritten unless the copy itself proves — via its
    // own shadow_clone binding — that it came from THIS clone.
    require_real_backup_pair(recovery_dir)?;
    if let Some(existing) = load_valid_backup(recovery_dir, DB_BACKUP_STEM)? {
        verify_reused_backup_binding(&existing.backup_path, shadow_token)?;
    }

    // The directory-backup freshness gate runs BEFORE the DB republish, so a
    // stale restore point is refused while the previous DB/directory pair is
    // still coherent.
    let directory_fresh = match load_valid_directory_backup(recovery_dir)? {
        Some(manifest) => {
            if !directory_backup_matches_live(paths, &manifest)? {
                return Err(RehearsalError::Io {
                    code: "prior-directory-backup-stale",
                });
            }
            true
        }
        None => {
            if recovery_dir.join(DIRECTORY_MANIFEST_NAME).exists() {
                return Err(RehearsalError::Io {
                    code: "prior-directory-backup-inconsistent",
                });
            }
            false
        }
    };

    // The DB backup is ALWAYS rebuilt from the current live source (the
    // staged same-stem republish never destroys the prior valid copy until
    // the new one verifies), so the recorded restore point can never be a
    // stale first-pass artifact.
    ensure_no_pending_migrations(&paths.db, recovery_dir, now_ms)?;
    let store = EngineStore::open(&paths.db, now_ms)?;
    let adapter = StorageFaultAdapter { faults };
    match create_verified_backup(
        &store,
        recovery_dir,
        DB_BACKUP_STEM,
        "cutover-rehearsal",
        now_ms,
        &RealFreeSpace,
        &adapter,
    )? {
        BackupOutcome::Verified(_) => {}
        BackupOutcome::Crashed { .. } => {
            return Err(RehearsalError::Io {
                code: "database-backup-crashed",
            });
        }
    }
    drop(store);
    // The backup pair's CONTENTS (the storage helper publishes by rename
    // without a file sync) and its directory entries must all be durable
    // before the BackedUp marker can ever be recorded over them.
    super::fsync_file(&db_backup_path(recovery_dir), "backup-db-sync")?;
    super::fsync_file(&db_manifest_path(recovery_dir), "backup-manifest-sync")?;
    super::fsync_dir(recovery_dir)?;
    if let Some(parent) = recovery_dir.parent() {
        super::fsync_dir(parent)?;
    }

    if directory_fresh {
        Ok(())
    } else {
        create_directory_backup(paths, recovery_dir, faults)
    }
}

fn db_backup_path(recovery_dir: &Path) -> PathBuf {
    recovery_dir.join(format!("{DB_BACKUP_STEM}.db"))
}

fn db_manifest_path(recovery_dir: &Path) -> PathBuf {
    recovery_dir.join(format!("{DB_BACKUP_STEM}.manifest.json"))
}

/// The DB backup pair may only be trusted (or replaced) as REAL files inside
/// the recovery dir; a symlinked/hard-linked half is an external dependency.
fn require_real_backup_pair(recovery_dir: &Path) -> Result<(), RehearsalError> {
    super::require_real_file(&db_backup_path(recovery_dir), "backup-db-alias-refused")?;
    super::require_real_file(&db_manifest_path(recovery_dir), "backup-db-alias-refused")?;
    Ok(())
}

/// Whether a validated directory-backup manifest still describes exactly the
/// current live source set, byte for byte.
fn directory_backup_matches_live(
    paths: &Paths,
    manifest: &DirectoryBackupManifest,
) -> Result<bool, RehearsalError> {
    let sources = collect_directory_sources(paths)?;
    if sources.len() != manifest.files.len() {
        return Ok(false);
    }
    let mut live_dirs = Vec::new();
    collect_engine_dirs(&paths.engine, &paths.engine, &mut live_dirs)?;
    live_dirs.sort();
    if live_dirs != manifest.directories {
        return Ok(false);
    }
    let mut declared: Vec<&DirectoryBackupEntry> = manifest.files.iter().collect();
    declared.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    for ((relative, source), entry) in sources.iter().zip(declared) {
        if *relative != entry.relative_path {
            return Ok(false);
        }
        let (hash, bytes) = hash_file(source)?;
        if hash != entry.sha256 || bytes != entry.size_bytes {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The sorted (relative-path, source-path) set the directory backup protects:
/// the engine dir (minus the live triplet) plus the optional `.dohc` sibling
/// snapshots.
fn collect_directory_sources(paths: &Paths) -> Result<Vec<(String, PathBuf)>, RehearsalError> {
    let mut sources = Vec::new();
    collect_engine_files(&paths.engine, &paths.engine, &mut sources)?;
    for sibling in SIBLING_SNAPSHOTS {
        let source = paths.root.join(".dohc").join(sibling);
        let metadata = match std::fs::symlink_metadata(&source) {
            Ok(metadata) => metadata,
            // The sibling snapshots are optional workspace files; absent means
            // there is nothing to protect, not a broken fixture.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(RehearsalError::io("snapshot-metadata", error)),
        };
        if !metadata.file_type().is_file() || super::metadata_is_hard_linked(&metadata) {
            return Err(RehearsalError::Io {
                code: "snapshot-not-regular",
            });
        }
        sources.push((format!("dohc/{sibling}"), source));
    }
    sources.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(sources)
}

/// The capture gate re-verifies the protected `.dohc` sibling snapshots
/// against the recorded backup: a snapshot that drifted (or vanished) after
/// the backup was taken must fail the rehearsal, not silently leave a stale
/// restore point behind a Complete marker.
pub(crate) fn verify_protected_snapshots(
    paths: &Paths,
    recovery_dir: &Path,
) -> Result<(), RehearsalError> {
    let manifest = load_valid_directory_backup(recovery_dir)?.ok_or(RehearsalError::Io {
        code: "backup-directory-not-valid",
    })?;
    let mut manifested = BTreeSet::new();
    for entry in &manifest.files {
        let Some(name) = entry.relative_path.strip_prefix("dohc/") else {
            continue;
        };
        manifested.insert(name);
        let live = paths.root.join(".dohc").join(name);
        // Alias-safe: a snapshot replaced by a same-content symlink or (Unix)
        // hard link is no longer the protected workspace file.
        if super::require_real_file(&live, "capture-snapshot-alias-refused")?.is_none() {
            return Err(RehearsalError::Io {
                code: "capture-snapshot-missing",
            });
        }
        let (hash, bytes) = match hash_file(&live) {
            Ok(hashed) => hashed,
            Err(_) => {
                return Err(RehearsalError::Io {
                    code: "capture-snapshot-missing",
                });
            }
        };
        if hash != entry.sha256 || bytes != entry.size_bytes {
            return Err(RehearsalError::Io {
                code: "capture-snapshot-drifted",
            });
        }
    }
    // Set compare, not just entry re-hash: a protected sibling that APPEARED
    // after the backup has no restore point and must fail the capture.
    for sibling in SIBLING_SNAPSHOTS {
        match std::fs::symlink_metadata(paths.root.join(".dohc").join(sibling)) {
            Ok(_) if !manifested.contains(sibling) => {
                return Err(RehearsalError::Io {
                    code: "capture-snapshot-unprotected",
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(RehearsalError::io("capture-snapshot-metadata", error)),
        }
    }
    Ok(())
}

/// The recorded original-store identity from the DB backup's manifest — the
/// reference a freshly-reset store must DIFFER from.
pub(crate) fn recorded_backup_engine_uuid(recovery_dir: &Path) -> Result<String, RehearsalError> {
    Ok(load_valid_backup(recovery_dir, DB_BACKUP_STEM)?
        .ok_or(RehearsalError::Io {
            code: "backup-db-not-valid",
        })?
        .manifest
        .engine_uuid)
}

/// The recovery dir holds a full copy of the workspace database, so it must be
/// private. Unix: 0700 (created and tightened). Windows: a hardened owner-only
/// DACL needs Win32 calls that require `unsafe` (forbidden by this crate), so
/// the profile-inherited owner ACL is accepted — the rehearsal runs on a
/// trusted local machine against a fixture clone, and true DACL hardening is
/// deferred to the real `--cutover` tier.
pub(crate) fn create_private_dir_all(dir: &Path) -> Result<(), RehearsalError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| RehearsalError::io("recovery-dir-create", e))?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| RehearsalError::io("recovery-dir-restrict", e))?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir).map_err(|e| RehearsalError::io("recovery-dir-create", e))?;
    Ok(())
}

/// Open the backup COPY read-only and require its `shadow_clone` binding to
/// match this run's validated token — a valid backup from another workspace or
/// clone must never be adopted as this rehearsal's safety net.
fn verify_reused_backup_binding(
    backup_db: &Path,
    shadow_token: &str,
) -> Result<(), RehearsalError> {
    let conn =
        Connection::open_with_flags(backup_db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| {
            RehearsalError::Io {
                code: "backup-reuse-open-failed",
            }
        })?;
    let token: Option<String> = conn
        .query_row(
            "SELECT token FROM shadow_clone WHERE rowid_guard = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| RehearsalError::Io {
            code: "backup-reuse-binding-unreadable",
        })?;
    if token.as_deref() != Some(shadow_token) {
        return Err(RehearsalError::Io {
            code: "backup-reuse-foreign-clone",
        });
    }
    Ok(())
}

/// `EngineStore::open` applies any pending migration to the store it opens.
/// The backup source must be opened write-free, so a source whose applied
/// migration ledger differs from this build's expectation is refused BEFORE
/// the read-write open. The expectation comes from a throwaway probe store
/// created by the same build in the recovery dir.
fn ensure_no_pending_migrations(
    db: &Path,
    recovery_dir: &Path,
    now_ms: i64,
) -> Result<(), RehearsalError> {
    let (applied, incomplete) = {
        let conn =
            Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| {
                RehearsalError::Io {
                    code: "backup-source-open-read-only-failed",
                }
            })?;
        migration_ledger_rows(&conn).map_err(|_| RehearsalError::Io {
            code: "backup-source-migrations-unreadable",
        })?
    };
    if incomplete {
        return Err(RehearsalError::Io {
            code: "backup-source-pending-migrations",
        });
    }

    let probe_dir = recovery_dir.join(MIGRATION_PROBE_DIR);
    if probe_dir.exists() {
        std::fs::remove_dir_all(&probe_dir)
            .map_err(|e| RehearsalError::io("migration-probe-clean", e))?;
    }
    std::fs::create_dir(&probe_dir).map_err(|e| RehearsalError::io("migration-probe-create", e))?;
    let (expected, _) = {
        let probe = EngineStore::open(&probe_dir.join("engine.db"), now_ms)?;
        probe
            .read_with(migration_ledger_rows)
            .map_err(|_| RehearsalError::Io {
                code: "migration-probe-unreadable",
            })?
    };
    let _ = std::fs::remove_dir_all(&probe_dir);

    // Identity compare, not a count: a ledger with one expected migration
    // missing and one unrelated row present has the same LENGTH but is still
    // pending work for `EngineStore::open`.
    if applied != expected {
        return Err(RehearsalError::Io {
            code: "backup-source-pending-migrations",
        });
    }
    Ok(())
}

/// The ordered `(ordinal, id, checksum)` ledger identity plus whether any row
/// is incomplete.
#[allow(clippy::type_complexity, reason = "local ledger-row triple")]
fn migration_ledger_rows(
    conn: &Connection,
) -> Result<(Vec<(i64, String, String)>, bool), rusqlite::Error> {
    let mut statement = conn.prepare(
        "SELECT ordinal, id, checksum, completed_at IS NULL FROM engine_migrations ORDER BY ordinal",
    )?;
    let mut rows = statement.query([])?;
    let mut ledger = Vec::new();
    let mut incomplete = false;
    while let Some(row) = rows.next()? {
        ledger.push((row.get(0)?, row.get(1)?, row.get(2)?));
        incomplete |= row.get::<_, bool>(3)?;
    }
    Ok((ledger, incomplete))
}

/// Read-and-VALIDATE both backups at `recovery_dir` and return their identity.
/// Errors (never silently `None`) when either backup is missing or invalid.
pub(crate) fn fingerprint_backup(recovery_dir: &Path) -> Result<BackupFingerprint, RehearsalError> {
    require_real_backup_pair(recovery_dir)?;
    let recovery = recovery_dir
        .to_str()
        .ok_or(RehearsalError::Io {
            code: "recovery-dir-non-utf8",
        })?
        .to_owned();
    let db = load_valid_backup(recovery_dir, DB_BACKUP_STEM)?.ok_or(RehearsalError::Io {
        code: "backup-db-not-valid",
    })?;
    if load_valid_directory_backup(recovery_dir)?.is_none() {
        return Err(RehearsalError::Io {
            code: "backup-directory-not-valid",
        });
    }
    let (manifest_hash, _) = hash_file(&recovery_dir.join(DIRECTORY_MANIFEST_NAME))?;
    Ok(BackupFingerprint {
        recovery_dir: recovery,
        db_checksum: db.manifest.checksum,
        directory_manifest_sha256: manifest_hash,
    })
}

/// The resume gate in front of every destructive step: the recovery dir passed
/// to THIS invocation must be the recorded one, and both backups there must
/// still validate byte-for-byte against the recorded fingerprint.
pub(crate) fn verify_recorded_backup(
    recovery_dir: &Path,
    recorded: Option<&BackupFingerprint>,
) -> Result<(), RehearsalError> {
    let recorded = recorded.ok_or(RehearsalError::Io {
        code: "resume-backup-unrecorded",
    })?;
    if recovery_dir.to_str() != Some(recorded.recovery_dir.as_str()) {
        return Err(RehearsalError::Io {
            code: "resume-recovery-dir-mismatch",
        });
    }
    let actual = fingerprint_backup(recovery_dir)?;
    if actual != *recorded {
        return Err(RehearsalError::Io {
            code: "resume-backup-mismatch",
        });
    }
    Ok(())
}

struct StorageFaultAdapter<'a> {
    faults: &'a dyn FaultInjector,
}

impl dohc_engine_storage::FaultInjector for StorageFaultAdapter<'_> {
    fn poll(&self, point: dohc_engine_storage::FaultPoint) -> dohc_engine_storage::FaultAction {
        let local = match point {
            dohc_engine_storage::FaultPoint::BackupAfterCopyBeforeManifest => {
                Some(FaultPoint::BackupAfterDatabaseCopy)
            }
            dohc_engine_storage::FaultPoint::BackupDuringRestoreVerify => {
                Some(FaultPoint::BackupDuringDatabaseVerify)
            }
            _ => None,
        };
        match local.map(|point| self.faults.poll(point)) {
            Some(FaultAction::Crash) => dohc_engine_storage::FaultAction::Crash,
            _ => dohc_engine_storage::FaultAction::Continue,
        }
    }
}

fn create_directory_backup(
    paths: &Paths,
    recovery_dir: &Path,
    faults: &dyn FaultInjector,
) -> Result<(), RehearsalError> {
    let staging = recovery_dir.join(format!("{DIRECTORY_BACKUP_NAME}.staging"));
    let published = recovery_dir.join(DIRECTORY_BACKUP_NAME);
    // Reaching this point means no valid manifest exists, so any leftover
    // staging dir or unmanifested published dir is an uncommitted artifact of
    // a crashed attempt — clear it and rebuild instead of wedging forever.
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|e| RehearsalError::io("directory-backup-staging-clear", e))?;
    }
    if published.exists() {
        std::fs::remove_dir_all(&published)
            .map_err(|e| RehearsalError::io("directory-backup-unmanifested-clear", e))?;
    }
    std::fs::create_dir(&staging)
        .map_err(|e| RehearsalError::io("directory-backup-staging-create", e))?;
    // Recreate every source engine subdirectory up front, so EMPTY dirs are
    // carried by the backup instead of silently lost.
    let mut directories = Vec::new();
    collect_engine_dirs(&paths.engine, &paths.engine, &mut directories)?;
    directories.sort();
    for relative in &directories {
        std::fs::create_dir_all(staging.join(Path::new(relative)))
            .map_err(|e| RehearsalError::io("directory-backup-subdir-create", e))?;
    }
    let sources = collect_directory_sources(paths)?;
    let mut entries = Vec::with_capacity(sources.len());
    for (relative, source) in sources {
        if faults.poll(FaultPoint::BackupDuringDirectoryCopy) == FaultAction::Crash {
            return Err(RehearsalError::Io {
                code: "directory-backup-crashed",
            });
        }
        let destination = staging.join(Path::new(&relative));
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| RehearsalError::io("directory-backup-parent", e))?;
        }
        let (source_hash, source_bytes) = copy_and_hash(&source, &destination)?;
        let (copy_hash, copy_bytes) = hash_file(&destination)?;
        if source_hash != copy_hash || source_bytes != copy_bytes {
            return Err(RehearsalError::Io {
                code: "directory-backup-restore-test-mismatch",
            });
        }
        entries.push(DirectoryBackupEntry {
            relative_path: relative,
            size_bytes: copy_bytes,
            sha256: copy_hash,
        });
    }
    let manifest = DirectoryBackupManifest {
        verified: true,
        files: entries,
        directories,
    };
    // Every directory entry in the staged tree must be durable BEFORE the
    // publish rename can be recorded; otherwise a power loss could keep the
    // manifest while dropping the files it describes.
    fsync_tree(&staging)?;
    std::fs::rename(&staging, &published)
        .map_err(|e| RehearsalError::io("directory-backup-publish", e))?;
    write_manifest_atomic(&recovery_dir.join(DIRECTORY_MANIFEST_NAME), &manifest)?;
    if load_valid_directory_backup(recovery_dir)?.as_ref() != Some(&manifest) {
        return Err(RehearsalError::Io {
            code: "directory-backup-readback-failed",
        });
    }
    Ok(())
}

/// Every subdirectory of the engine tree as `engine/<rel>` (aliases refused).
fn collect_engine_dirs(
    engine_root: &Path,
    directory: &Path,
    output: &mut Vec<String>,
) -> Result<(), RehearsalError> {
    let entries = std::fs::read_dir(directory)
        .map_err(|e| RehearsalError::io("engine-backup-enumerate", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| RehearsalError::io("engine-backup-entry", e))?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| RehearsalError::io("engine-backup-metadata", e))?;
        if metadata.file_type().is_symlink() {
            return Err(RehearsalError::Io {
                code: "engine-backup-alias-refused",
            });
        }
        if metadata.is_dir() {
            let relative = path
                .strip_prefix(engine_root)
                .map_err(|_| RehearsalError::State)?;
            let text = relative.to_str().ok_or(RehearsalError::Io {
                code: "engine-backup-non-utf8-path",
            })?;
            output.push(format!("engine/{}", portable_separators(text)));
            collect_engine_dirs(engine_root, &path, output)?;
        }
    }
    Ok(())
}

fn collect_engine_files(
    engine_root: &Path,
    directory: &Path,
    output: &mut Vec<(String, PathBuf)>,
) -> Result<(), RehearsalError> {
    let entries = std::fs::read_dir(directory)
        .map_err(|e| RehearsalError::io("engine-backup-enumerate", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| RehearsalError::io("engine-backup-entry", e))?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| RehearsalError::io("engine-backup-metadata", e))?;
        if metadata.file_type().is_symlink() {
            return Err(RehearsalError::Io {
                code: "engine-backup-alias-refused",
            });
        }
        if metadata.is_dir() {
            collect_engine_files(engine_root, &path, output)?;
        } else if metadata.is_file() {
            if super::metadata_is_hard_linked(&metadata) {
                return Err(RehearsalError::Io {
                    code: "engine-backup-hardlink-refused",
                });
            }
            let relative = path
                .strip_prefix(engine_root)
                .map_err(|_| RehearsalError::State)?;
            // The whole live triplet is excluded: the vacuumed DB backup is the
            // complete database state, and a copied WAL/SHM restored beside it
            // would be replayed by SQLite into silent corruption. The held
            // advisory lock file is runtime-only state, not workspace content.
            if DB_TRIPLET.iter().any(|name| relative == Path::new(name))
                || relative == Path::new(super::ROOT_LOCK_FILE)
            {
                continue;
            }
            let text = relative.to_str().ok_or(RehearsalError::Io {
                code: "engine-backup-non-utf8-path",
            })?;
            output.push((format!("engine/{}", portable_separators(text)), path));
        } else {
            return Err(RehearsalError::Io {
                code: "engine-backup-special-file-refused",
            });
        }
    }
    Ok(())
}

fn copy_and_hash(source: &Path, destination: &Path) -> Result<(String, u64), RehearsalError> {
    let mut input = File::open(source).map_err(|e| RehearsalError::io("backup-source-open", e))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|e| RehearsalError::io("backup-copy-open", e))?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|e| RehearsalError::io("backup-source-read", e))?;
        if read == 0 {
            break;
        }
        let chunk = buffer.get(..read).ok_or(RehearsalError::State)?;
        output
            .write_all(chunk)
            .map_err(|e| RehearsalError::io("backup-copy-write", e))?;
        hasher.update(chunk);
        bytes = bytes.saturating_add(read as u64);
    }
    output
        .sync_all()
        .map_err(|e| RehearsalError::io("backup-copy-sync", e))?;
    Ok((to_hex(&hasher.finalize()), bytes))
}

fn hash_file(path: &Path) -> Result<(String, u64), RehearsalError> {
    let mut file = File::open(path).map_err(|e| RehearsalError::io("backup-verify-open", e))?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| RehearsalError::io("backup-verify-read", e))?;
        if read == 0 {
            break;
        }
        let chunk = buffer.get(..read).ok_or(RehearsalError::State)?;
        hasher.update(chunk);
        bytes = bytes.saturating_add(read as u64);
    }
    Ok((to_hex(&hasher.finalize()), bytes))
}

fn write_manifest_atomic(
    path: &Path,
    manifest: &DirectoryBackupManifest,
) -> Result<(), RehearsalError> {
    let temp = path.with_extension("json.tmp");
    // A stale temp from a crashed attempt is uncommitted scratch; clear it so
    // the retry is not wedged by `create_new`.
    if std::fs::symlink_metadata(&temp).is_ok() {
        std::fs::remove_file(&temp)
            .map_err(|e| RehearsalError::io("directory-manifest-temp-clear", e))?;
    }
    let bytes = serde_json::to_vec(manifest).map_err(|_| RehearsalError::State)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| RehearsalError::io("directory-manifest-temp-open", e))?;
    file.write_all(&bytes)
        .map_err(|e| RehearsalError::io("directory-manifest-temp-write", e))?;
    file.sync_all()
        .map_err(|e| RehearsalError::io("directory-manifest-temp-sync", e))?;
    drop(file);
    std::fs::rename(&temp, path)
        .map_err(|e| RehearsalError::io("directory-manifest-publish", e))?;
    if let Some(parent) = path.parent() {
        super::fsync_dir(parent)?;
    }
    Ok(())
}

/// Recursively fsync every directory in `directory`'s tree (deepest last is
/// unnecessary — each dir entry set only needs its own sync).
fn fsync_tree(directory: &Path) -> Result<(), RehearsalError> {
    super::fsync_dir(directory)?;
    let entries =
        std::fs::read_dir(directory).map_err(|e| RehearsalError::io("backup-sync-enumerate", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| RehearsalError::io("backup-sync-entry", e))?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| RehearsalError::io("backup-sync-metadata", e))?;
        if metadata.is_dir() {
            fsync_tree(&path)?;
        }
    }
    Ok(())
}

/// `\` is a path separator only on Windows; on Unix a backslash is an ordinary
/// filename byte, and rewriting it would alias two distinct paths.
pub(crate) fn portable_separators(text: &str) -> String {
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.to_owned()
    }
}

pub(crate) fn ensure_outside_root(root: &Path, recovery_dir: &Path) -> Result<(), RehearsalError> {
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| RehearsalError::io("backup-root-canonicalize", e))?;
    let ancestor = recovery_dir
        .ancestors()
        .find(|candidate| candidate.exists())
        .ok_or(RehearsalError::Io {
            code: "backup-no-existing-ancestor",
        })?;
    let canonical_ancestor = std::fs::canonicalize(ancestor)
        .map_err(|e| RehearsalError::io("backup-ancestor-canonicalize", e))?;
    if canonical_ancestor.starts_with(&canonical_root) {
        return Err(RehearsalError::Io {
            code: "backup-must-be-outside-root",
        });
    }
    Ok(())
}

fn to_hex(digest: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
pub(crate) fn db_backup_stem() -> &'static str {
    DB_BACKUP_STEM
}
