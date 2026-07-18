use super::faults::{FaultAction, FaultInjector, FaultPoint};
use super::handles::DB_TRIPLET;
use super::state::BackupFingerprint;
use super::{Paths, RehearsalError};
use dohc_engine_storage::{
    BackupOutcome, EngineStore, RealFreeSpace, create_verified_backup, load_valid_backup,
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
}

pub fn load_valid_directory_backup(
    recovery_dir: &Path,
) -> Result<Option<DirectoryBackupManifest>, RehearsalError> {
    let manifest_path = recovery_dir.join(DIRECTORY_MANIFEST_NAME);
    let bytes = match std::fs::read(&manifest_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(RehearsalError::io("directory-manifest-read", error)),
    };
    let manifest: DirectoryBackupManifest =
        serde_json::from_slice(&bytes).map_err(|_| RehearsalError::State)?;
    if !manifest.verified {
        return Ok(None);
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
    Ok(Some(manifest))
}

pub(crate) fn create_restore_tested_backup(
    paths: &Paths,
    recovery_dir: &Path,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<(), RehearsalError> {
    ensure_outside_root(&paths.root, recovery_dir)?;
    std::fs::create_dir_all(recovery_dir)
        .map_err(|e| RehearsalError::io("recovery-dir-create", e))?;

    let db_valid = load_valid_backup(recovery_dir, DB_BACKUP_STEM)?.is_some();
    let directory_valid = load_valid_directory_backup(recovery_dir)?.is_some();
    if db_valid && directory_valid {
        return Ok(());
    }
    if directory_valid || recovery_dir.join(DIRECTORY_MANIFEST_NAME).exists() {
        return Err(RehearsalError::Io {
            code: "prior-directory-backup-inconsistent",
        });
    }

    if !db_valid {
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
    }

    create_directory_backup(paths, recovery_dir, faults)
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
    let applied = {
        let conn =
            Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| {
                RehearsalError::Io {
                    code: "backup-source-open-read-only-failed",
                }
            })?;
        let (applied, incomplete): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COUNT(*) FILTER (WHERE completed_at IS NULL) \
                 FROM engine_migrations",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| RehearsalError::Io {
                code: "backup-source-migrations-unreadable",
            })?;
        if incomplete != 0 {
            return Err(RehearsalError::Io {
                code: "backup-source-pending-migrations",
            });
        }
        applied
    };

    let probe_dir = recovery_dir.join(MIGRATION_PROBE_DIR);
    if probe_dir.exists() {
        std::fs::remove_dir_all(&probe_dir)
            .map_err(|e| RehearsalError::io("migration-probe-clean", e))?;
    }
    std::fs::create_dir(&probe_dir).map_err(|e| RehearsalError::io("migration-probe-create", e))?;
    let expected = {
        let probe = EngineStore::open(&probe_dir.join("engine.db"), now_ms)?;
        probe.migration_ledger_len()?
    };
    let _ = std::fs::remove_dir_all(&probe_dir);

    if applied != expected {
        return Err(RehearsalError::Io {
            code: "backup-source-pending-migrations",
        });
    }
    Ok(())
}

/// Read-and-VALIDATE both backups at `recovery_dir` and return their identity.
/// Errors (never silently `None`) when either backup is missing or invalid.
pub(crate) fn fingerprint_backup(recovery_dir: &Path) -> Result<BackupFingerprint, RehearsalError> {
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
    if staging.exists() || published.exists() {
        return Err(RehearsalError::Io {
            code: "directory-backup-staging-not-clean",
        });
    }
    std::fs::create_dir(&staging)
        .map_err(|e| RehearsalError::io("directory-backup-staging-create", e))?;
    let mut sources = Vec::new();
    collect_engine_files(&paths.engine, &paths.engine, &mut sources)?;
    for sibling in SIBLING_SNAPSHOTS {
        let source = paths.root.join(".dohc").join(sibling);
        let metadata = std::fs::symlink_metadata(&source)
            .map_err(|e| RehearsalError::io("snapshot-metadata", e))?;
        if !metadata.file_type().is_file() {
            return Err(RehearsalError::Io {
                code: "snapshot-not-regular",
            });
        }
        sources.push((format!("dohc/{sibling}"), source));
    }
    sources.sort_by(|left, right| left.0.cmp(&right.0));
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
    };
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
            let relative = path
                .strip_prefix(engine_root)
                .map_err(|_| RehearsalError::State)?;
            // The whole live triplet is excluded: the vacuumed DB backup is the
            // complete database state, and a copied WAL/SHM restored beside it
            // would be replayed by SQLite into silent corruption.
            if DB_TRIPLET.iter().any(|name| relative == Path::new(name)) {
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
    std::fs::rename(temp, path).map_err(|e| RehearsalError::io("directory-manifest-publish", e))
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
