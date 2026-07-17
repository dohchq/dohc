//! Verified, restore-tested backups (`plan §Backups`).
//!
//! A backup is not "done" when the bytes are copied — it is done when a
//! *restore test* proves the copy is openable and consistent. This module:
//!
//! 1. **Preflights free space** through the [`FreeSpaceProbe`] seam and refuses
//!    on disk-full BEFORE touching anything — it never deletes the only valid
//!    source to make room.
//! 2. **Copies** the live database with `VACUUM INTO` (a clean, WAL-free single-
//!    file snapshot) into a private recovery directory the caller places
//!    OUTSIDE the workspace root (owner-only where supported; the caller keeps
//!    it excluded from watch/search/sync).
//! 3. **Restore-tests**: opens the copy read-only, runs `integrity_check`, and
//!    compares row counts of the durable tables against the source. Only then
//!    is the manifest written and the backup declared valid.
//! 4. **Writes a redaction-safe manifest** (opaque engine id, build, schema
//!    fingerprint, checksum, size, retention) — never document content. A
//!    backup with no manifest is invalid-by-absence and never counted.
//! 5. **Reads back through [`load_valid_backup`]**, which ENFORCES those
//!    invariants: it returns `None` for a missing manifest (invalid-by-absence)
//!    or a checksum that no longer matches the db bytes (tamper / partial
//!    write). A backup is only trusted through this validated read path.
//!
//! Two named fault points make the crash boundary testable:
//! `backup.after-copy-before-manifest` and `backup.during-restore-verify`.
//!
//! **Same-stem republish window (documented, safe).** When a backup reuses an
//! existing stem, the copy is staged and verified first, then published by
//! atomic rename, and the prior manifest is cleared just before the rename so it
//! can never describe the newly published (still-unmanifested) db. This leaves a
//! narrow window in which *that stem* has a db but no manifest —
//! [`load_valid_backup`] correctly reports it invalid-by-absence, and a retry
//! self-heals by rewriting the manifest. The live source database is never
//! touched, and any OTHER-stem backup is untouched; the guarantee is precisely
//! "never destroy a valid restore point to make room for an unverified one",
//! not "the target stem is atomically valid at every instant".

use crate::error::StorageError;
use crate::faults::{FaultInjector, FaultPoint};
use crate::limits::ENGINE_SCHEMA_VERSION;
use crate::store::EngineStore;
use rusqlite::{Connection, OpenFlags};
use std::io::Read;
use std::path::{Path, PathBuf};

/// The durable tables whose row counts a restore test compares source-vs-copy.
/// A mismatch means the copy is not a faithful snapshot — the backup fails.
const COMPARED_TABLES: &[&str] = &[
    "engine_migrations",
    "engine_ownership",
    "engine_requests",
    "documents",
    "replication_journal",
    "versioned_workspaces",
    "versions",
    "active_versions",
    "file_objects",
    "blobs",
    "binary_blobs",
    "path_aliases",
    "snapshots",
    "fork_base_snapshots",
    "moments",
    "materialization_jobs",
    // R08 secret-backed-file tables: their ciphertext tips / fork bases /
    // history moments are durable state, so a backup missing or truncating them
    // must fail the restore-test row-count compare (never mark a lossy copy
    // verified).
    "secret_files",
    "secret_fork_bases",
    "secret_moments",
];

/// Extra headroom (bytes) required over the source size before a backup is
/// allowed — the copy plus its short-lived restore-test open.
const BACKUP_HEADROOM_BYTES: u64 = 4 * 1024 * 1024;

/// A seam over "how much free space does this volume have". Behind a trait so
/// the disk-full behavior is testable without actually filling a disk
/// (portability guardrail 2: fs access behind the same seams as the clock).
pub trait FreeSpaceProbe: Send + Sync {
    /// Bytes available to a non-privileged writer at `path` (or its nearest
    /// existing ancestor).
    fn available_bytes(&self, path: &Path) -> Result<u64, StorageError>;
}

/// The production probe. Uses `fs4`'s safe wrapper over the platform statvfs /
/// `GetDiskFreeSpaceEx` call, so the engine crate keeps `forbid(unsafe_code)`.
#[derive(Debug, Clone, Copy, Default)]
pub struct RealFreeSpace;

impl FreeSpaceProbe for RealFreeSpace {
    fn available_bytes(&self, path: &Path) -> Result<u64, StorageError> {
        // Walk to the nearest existing ancestor: the recovery dir may not exist
        // yet at preflight time.
        let mut probe = path;
        loop {
            if probe.exists() {
                return fs4::available_space(probe).map_err(StorageError::classify_io);
            }
            match probe.parent() {
                Some(parent) => probe = parent,
                None => {
                    return Err(StorageError::backup(std::io::Error::other(
                        "no volume root",
                    )));
                }
            }
        }
    }
}

/// A redaction-safe backup manifest. No document bodies, secrets, keys, or user
/// file paths — only opaque identity and integrity metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupManifest {
    /// Opaque engine identity (the `engine_ownership.engine_uuid`), NOT a path.
    pub engine_uuid: String,
    pub engine_build: String,
    pub schema_fingerprint: i64,
    /// sha-256 of the backup database file.
    pub checksum: String,
    pub size_bytes: u64,
    pub created_at_ms: i64,
    /// Retention class (caller policy, e.g. "cutover" / "periodic"). Opaque.
    pub retention: String,
    /// Set true only after the restore test passes.
    pub verified: bool,
}

impl BackupManifest {
    /// Serialize to a compact, dependency-free JSON object. Every field is a
    /// number, bool, or a string escaped for JSON — no nested user data.
    fn to_json(&self) -> String {
        format!(
            "{{\"engine_uuid\":{},\"engine_build\":{},\"schema_fingerprint\":{},\
             \"checksum\":{},\"size_bytes\":{},\"created_at_ms\":{},\
             \"retention\":{},\"verified\":{}}}",
            json_string(&self.engine_uuid),
            json_string(&self.engine_build),
            self.schema_fingerprint,
            json_string(&self.checksum),
            self.size_bytes,
            self.created_at_ms,
            json_string(&self.retention),
            self.verified,
        )
    }
}

impl BackupManifest {
    /// Parse a manifest from its JSON text. Returns `None` if the JSON is
    /// malformed or a required field is missing/mistyped (a malformed manifest
    /// is treated as no manifest — invalid-by-absence).
    fn from_json(text: &str) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        let obj = value.as_object()?;
        Some(BackupManifest {
            engine_uuid: obj.get("engine_uuid")?.as_str()?.to_owned(),
            engine_build: obj.get("engine_build")?.as_str()?.to_owned(),
            schema_fingerprint: obj.get("schema_fingerprint")?.as_i64()?,
            checksum: obj.get("checksum")?.as_str()?.to_owned(),
            size_bytes: obj.get("size_bytes")?.as_u64()?,
            created_at_ms: obj.get("created_at_ms")?.as_i64()?,
            retention: obj.get("retention")?.as_str()?.to_owned(),
            verified: obj.get("verified")?.as_bool()?,
        })
    }
}

/// Load and VALIDATE a backup pair `(<stem>.db, <stem>.manifest.json)` from
/// `recovery_dir`. Returns `Some(record)` only when the manifest is present,
/// well-formed, marked `verified`, and its recorded checksum matches the current
/// db bytes. Returns `None` for:
/// - a missing manifest (invalid-by-absence — including the same-stem republish
///   crash window),
/// - a missing db,
/// - an unverified manifest,
/// - a checksum mismatch (tampered or partially-written bytes).
///
/// This is the ONLY sanctioned way to trust a backup; the documented invariants
/// are enforced here rather than assumed by a reader.
pub fn load_valid_backup(
    recovery_dir: &Path,
    backup_stem: &str,
) -> Result<Option<BackupRecord>, StorageError> {
    let backup_path = recovery_dir.join(format!("{backup_stem}.db"));
    let manifest_path = recovery_dir.join(format!("{backup_stem}.manifest.json"));

    let manifest_text = match std::fs::read_to_string(&manifest_path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(StorageError::classify_io(err)),
    };
    let Some(manifest) = BackupManifest::from_json(&manifest_text) else {
        return Ok(None);
    };
    if !manifest.verified || !backup_path.exists() {
        return Ok(None);
    }
    // Integrity: the db bytes must still hash to the recorded checksum.
    let actual = hash_file(&backup_path)?;
    if actual != manifest.checksum {
        return Ok(None);
    }
    Ok(Some(BackupRecord {
        backup_path,
        manifest_path,
        manifest,
    }))
}

/// Minimal JSON string escaper (control chars, quote, backslash). The manifest
/// fields are engine-controlled identifiers, but escape defensively anyway.
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A completed, verified backup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupRecord {
    pub backup_path: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest: BackupManifest,
}

/// The outcome of a backup attempt.
#[derive(Debug)]
pub enum BackupOutcome {
    /// Restore-tested and manifested.
    Verified(BackupRecord),
    /// A crash fault fired. `after_copy` distinguishes the two boundaries: with
    /// it true the backup bytes exist but no manifest was written (invalid-by-
    /// absence); with it false the crash was during restore verification and no
    /// manifest / verified flag was ever set. Either way the source is intact.
    Crashed { after_copy: bool },
}

#[cfg(feature = "fault-injection")]
#[inline]
fn should_crash(faults: &dyn FaultInjector, point: FaultPoint) -> bool {
    faults.poll(point) == crate::faults::FaultAction::Crash
}

#[cfg(not(feature = "fault-injection"))]
#[inline(always)]
fn should_crash(_faults: &dyn FaultInjector, _point: FaultPoint) -> bool {
    false
}

/// Create a verified backup of `store` into `recovery_dir` (which the caller
/// keeps OUTSIDE the workspace root). `backup_stem` names the pair
/// (`<stem>.db` + `<stem>.manifest.json`).
pub fn create_verified_backup(
    store: &EngineStore,
    recovery_dir: &Path,
    backup_stem: &str,
    retention: &str,
    now_ms: i64,
    probe: &dyn FreeSpaceProbe,
    faults: &dyn FaultInjector,
) -> Result<BackupOutcome, StorageError> {
    let source_size = store.database_size_bytes()?;
    let needed = source_size.saturating_add(BACKUP_HEADROOM_BYTES);

    // 1. Preflight free space BEFORE touching disk. Fail closed on disk-full;
    //    never delete the only valid source to make room.
    let available = probe.available_bytes(recovery_dir)?;
    if available < needed {
        return Err(StorageError::DiskFull { needed, available });
    }

    // 2. Ensure the recovery dir (owner-only where supported).
    create_recovery_dir(recovery_dir)?;

    let backup_path = recovery_dir.join(format!("{backup_stem}.db"));
    let manifest_path = recovery_dir.join(format!("{backup_stem}.manifest.json"));
    // Copy into a disposable STAGING path first, so any existing verified backup
    // with this stem is only replaced AFTER the new copy is restore-tested — a
    // crash never destroys the last valid restore point to make room for an
    // unverified one. VACUUM INTO also refuses a pre-existing target, so a stale
    // staging file is cleared (staging is scratch, safe to delete).
    let staging_path = recovery_dir.join(format!("{backup_stem}.db.staging"));
    remove_if_exists(&staging_path)?;

    // Copy the live DB as a clean single-file snapshot into staging.
    store.vacuum_into(&staging_path)?;

    // Fault: bytes copied to staging, nothing published or manifested.
    if should_crash(faults, FaultPoint::BackupAfterCopyBeforeManifest) {
        return Ok(BackupOutcome::Crashed { after_copy: true });
    }

    // 3. Restore test the STAGING copy: integrity + row-count compare. A crash
    //    mid-verify publishes nothing (source and any prior backup untouched).
    if !restore_test(store, &staging_path, faults)? {
        return Ok(BackupOutcome::Crashed { after_copy: false });
    }

    // 4. Compute checksum + size on the verified staging copy.
    let size_bytes = std::fs::metadata(&staging_path)
        .map_err(StorageError::classify_io)?
        .len();
    let checksum = hash_file(&staging_path)?;
    let (engine_uuid, engine_build) = store.ownership()?;
    let manifest = BackupManifest {
        engine_uuid,
        engine_build,
        schema_fingerprint: ENGINE_SCHEMA_VERSION,
        checksum,
        size_bytes,
        created_at_ms: now_ms,
        retention: retention.to_owned(),
        verified: true,
    };

    // 5. Publish: the verified staging copy is atomically renamed into place
    //    FIRST (a prior backup's bytes are replaced only by verified bytes),
    //    then the manifest is written LAST. The manifest is the validity marker,
    //    so a crash after the db-rename but before the manifest leaves the new
    //    verified db invalid-by-absence-of-manifest; a retry re-manifests and no
    //    verified data is lost. A stale prior manifest is cleared before the
    //    db-rename so it can never describe the newly published (unmanifested) db.
    remove_if_exists(&manifest_path)?;
    std::fs::rename(&staging_path, &backup_path).map_err(StorageError::classify_io)?;
    write_manifest_atomic(&manifest_path, &manifest)?;

    Ok(BackupOutcome::Verified(BackupRecord {
        backup_path,
        manifest_path,
        manifest,
    }))
}

/// Restore-test a backup file: open read-only, `integrity_check`, and compare
/// durable-table row counts against the source. Returns `Ok(true)` when the
/// copy is verified, `Ok(false)` when a crash fault fired mid-verify (the
/// caller then reports `Crashed` and never writes the manifest). Any real
/// inconsistency is `backup-failed`.
fn restore_test(
    store: &EngineStore,
    backup_path: &Path,
    faults: &dyn FaultInjector,
) -> Result<bool, StorageError> {
    let copy = Connection::open_with_flags(backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(StorageError::backup)?;

    let check: String = copy
        .pragma_query_value(None, "integrity_check", |row| row.get(0))
        .map_err(StorageError::backup)?;
    if !check.eq_ignore_ascii_case("ok") {
        return Err(StorageError::BackupFailed { source: None });
    }

    // `backup.during-restore-verify`: a crash between integrity and the row
    // compare — the verification never completes, so the copy is never declared
    // valid. Single poll (a one-shot injector fires here, not twice).
    if should_crash(faults, FaultPoint::BackupDuringRestoreVerify) {
        return Ok(false);
    }

    for table in COMPARED_TABLES {
        let source_count = store.table_row_count(table)?;
        let copy_count: i64 = copy
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .map_err(StorageError::backup)?;
        if source_count != copy_count {
            return Err(StorageError::BackupFailed { source: None });
        }
    }
    Ok(true)
}

fn create_recovery_dir(dir: &Path) -> Result<(), StorageError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        if !dir.exists() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)
                .map_err(StorageError::classify_io)?;
        }
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        // Windows: owner-only ACLs are a packaging concern; std has no portable
        // mode. Create the directory; the caller places it under a private
        // per-user recovery root.
        std::fs::create_dir_all(dir).map_err(StorageError::classify_io)
    }
}

fn remove_if_exists(path: &Path) -> Result<(), StorageError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(StorageError::classify_io(err)),
    }
}

/// Stream-hash a file with a bounded buffer (never loads the whole file).
fn hash_file(path: &Path) -> Result<String, StorageError> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(StorageError::classify_io)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buf).map_err(StorageError::classify_io)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

/// Write the manifest via temp-then-rename so a crash never leaves a half-
/// written manifest that would falsely validate the backup.
fn write_manifest_atomic(
    manifest_path: &Path,
    manifest: &BackupManifest,
) -> Result<(), StorageError> {
    let tmp = manifest_path.with_extension("json.tmp");
    std::fs::write(&tmp, manifest.to_json().as_bytes()).map_err(StorageError::classify_io)?;
    std::fs::rename(&tmp, manifest_path).map_err(StorageError::classify_io)?;
    Ok(())
}
