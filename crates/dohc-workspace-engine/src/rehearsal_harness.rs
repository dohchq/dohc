//! Harness-only dispatcher for a real-tree clone/reset rehearsal.
//!
//! This module is compiled only by the `harness` feature. It never opens the
//! source workspace for writing: all markers, stores, and rehearsal state are
//! created beneath a byte clone, and a full source hash/mtime snapshot is
//! compared before evidence can be banked.

use crate::cutover_rehearse::{
    BackupFingerprint, NoFaults, RehearsalConfig, RehearsalError, RehearsalOutcome, RehearsalState,
    StateRecord, run_rehearsal, validate_rehearsal_root, write_rehearsal_token_for_harness,
};
use crate::shadow_fence::{ShadowFenceError, write_shadow_marker_for_harness};
use dohc_engine_storage::{EngineStore, StorageError};
use filetime::FileTime;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{File, Metadata};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const EVIDENCE_FILE: &str = "REHEARSAL_EVIDENCE.json";
const TYPESCRIPT_STORE_DIR: &str = "typescript-engine-byte-clone";
const SQLITE_SOURCE_FILES: [&str; 4] = [
    "engine.db",
    "engine.db-wal",
    "engine.db-shm",
    "engine.db-journal",
];
const COPY_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct HarnessConfig<'a> {
    pub source: &'a Path,
    pub scratch: &'a Path,
    pub recovery: &'a Path,
}

#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
    #[error("source workspace must contain a real .dohc directory")]
    SourceDohcMissing,
    #[error("{which} must be outside the source workspace")]
    PathInsideSource { which: &'static str },
    #[error("scratch and recovery must be separate, non-nested directories")]
    ScratchRecoveryOverlap,
    #[error("source workspace changed during the rehearsal")]
    SourceChanged,
    #[error("the initial clone did not exactly match the source hash/mtime snapshot")]
    CloneMismatch,
    #[error("the clone contains an unsupported alias or special file: {path}")]
    UnsupportedEntry { path: String },
    #[error("the clone already contains the reserved TypeScript-store retention directory")]
    RetentionDirectoryExists,
    #[error("the freshly initialized Rust store did not accept its shadow-clone binding")]
    ShadowBindingRefused,
    #[error("the operating system did not provide a random marker token")]
    RandomToken,
    #[error("rehearsal returned a non-complete outcome: {0}")]
    IncompleteOutcome(String),
    #[error("filesystem operation failed during {operation}")]
    Io {
        operation: &'static str,
        #[source]
        source: std::io::Error,
    },
    #[error("shadow marker operation failed")]
    ShadowMarker(#[from] ShadowFenceError),
    #[error("rehearsal marker operation failed")]
    RehearsalMarker(#[from] crate::cutover_rehearse::FenceError),
    #[error("Rust store initialization failed")]
    Storage(#[from] StorageError),
    #[error("clone-reset rehearsal failed")]
    Rehearsal(#[from] RehearsalError),
    #[error("evidence serialization failed")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TreeSummary {
    /// Includes the tree root itself.
    pub directory_count: usize,
    pub file_count: usize,
    pub total_file_bytes: u64,
    pub snapshot_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceUnchangedProof {
    pub verified: bool,
    pub before_snapshot_sha256: String,
    pub after_snapshot_sha256: String,
    pub before: TreeSummary,
    pub after: TreeSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtifactEntry {
    pub relative_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PreservedSourceStoreEntry {
    pub original_relative_path: String,
    pub retained_relative_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Timings {
    pub source_snapshot_before_ms: u64,
    pub byte_clone_ms: u64,
    pub clone_preparation_ms: u64,
    pub rehearsal_ms: u64,
    pub source_verification_ms: u64,
    pub total_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RehearsalEvidence {
    pub schema_version: u32,
    pub criterion: String,
    pub recorded_interpretation: String,
    pub started_at_unix_ms: i64,
    pub finished_at_unix_ms: i64,
    pub source_path: String,
    pub clone_path: String,
    pub recovery_path: String,
    pub outcome: String,
    pub state_record: StateRecord,
    pub backup_fingerprint: BackupFingerprint,
    pub fresh_engine_uuid: String,
    pub source_unchanged: SourceUnchangedProof,
    pub source_counts: TreeSummary,
    pub initial_byte_clone_counts: TreeSummary,
    pub final_clone_counts: TreeSummary,
    pub ui_state_tmp_orphans: Vec<ArtifactEntry>,
    pub preserved_typescript_store: Vec<PreservedSourceStoreEntry>,
    pub recovery_artifacts: Vec<ArtifactEntry>,
    pub timings: Timings,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TreeEntry {
    relative_path: String,
    kind: EntryKind,
    size_bytes: u64,
    modified_seconds: i64,
    modified_nanoseconds: u32,
    sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    Directory,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TreeSnapshot {
    entries: Vec<TreeEntry>,
    summary: TreeSummary,
}

struct PreparedClone {
    preserved_store: Vec<PreservedSourceStoreEntry>,
}

/// Run one clone/reset rehearsal and bank its evidence.
///
/// The source is read only. Evidence is published only after a second complete
/// source snapshot proves every relative path, file hash, size, and mtime is
/// unchanged.
pub fn run(config: HarnessConfig<'_>) -> Result<RehearsalEvidence, HarnessError> {
    let total_started = Instant::now();
    let started_at_unix_ms = unix_now_ms()?;
    let (source, scratch, recovery) = validate_paths(config)?;

    let source_snapshot_started = Instant::now();
    let source_before = snapshot_tree(&source)?;
    let source_snapshot_before_ms = elapsed_ms(source_snapshot_started);

    let operation = run_on_clone(
        &source,
        &scratch,
        &recovery,
        &source_before,
        started_at_unix_ms,
    );

    // This assertion runs even when cloning, preparation, or rehearsal failed.
    // A source mutation is always the primary safety failure.
    let source_verification_started = Instant::now();
    let source_after = snapshot_tree(&source)?;
    if source_before != source_after {
        return Err(HarnessError::SourceChanged);
    }
    let source_verification_ms = elapsed_ms(source_verification_started);

    let mut completed = operation?;
    let source_unchanged = SourceUnchangedProof {
        verified: true,
        before_snapshot_sha256: source_before.summary.snapshot_sha256.clone(),
        after_snapshot_sha256: source_after.summary.snapshot_sha256.clone(),
        before: source_before.summary.clone(),
        after: source_after.summary,
    };
    let finished_at_unix_ms = unix_now_ms()?;
    let backup_fingerprint = completed.state_record.backup.clone().ok_or_else(|| {
        HarnessError::IncompleteOutcome("complete record lacks backup".to_owned())
    })?;
    let fresh_engine_uuid = completed
        .state_record
        .fresh_engine_uuid
        .clone()
        .ok_or_else(|| {
            HarnessError::IncompleteOutcome("complete record lacks fresh engine UUID".to_owned())
        })?;
    let evidence = RehearsalEvidence {
        schema_version: 1,
        criterion: "GATE6 end-to-end clone-reset rehearsal on real dogfood workspace byte-clones"
            .to_owned(),
        recorded_interpretation: "The live dogfood engine.db is TypeScript-authored and the Rust fence correctly refuses its foreign fingerprint. The authorized cutover is a reset: retain the source SQLite files inside the byte clone, initialize and bind a fresh Rust store in the clone, write the two harness-only markers, then exercise run_rehearsal(NoFaults). Ice accepted the data wipe; this interpretation remains flagged for Ice's post-hoc review.".to_owned(),
        started_at_unix_ms,
        finished_at_unix_ms,
        source_path: display_path(&source),
        clone_path: display_path(&completed.clone_path),
        recovery_path: display_path(&recovery),
        outcome: "complete".to_owned(),
        state_record: completed.state_record,
        backup_fingerprint,
        fresh_engine_uuid,
        source_unchanged,
        source_counts: source_before.summary,
        initial_byte_clone_counts: completed.initial_clone.summary,
        final_clone_counts: completed.final_clone.summary,
        ui_state_tmp_orphans: completed.ui_state_tmp_orphans,
        preserved_typescript_store: completed.prepared.preserved_store,
        recovery_artifacts: std::mem::take(&mut completed.recovery_artifacts),
        timings: Timings {
            source_snapshot_before_ms,
            byte_clone_ms: completed.byte_clone_ms,
            clone_preparation_ms: completed.clone_preparation_ms,
            rehearsal_ms: completed.rehearsal_ms,
            source_verification_ms,
            total_ms: elapsed_ms(total_started),
        },
    };
    write_evidence(&recovery, &evidence)?;
    Ok(evidence)
}

struct CompletedClone {
    clone_path: PathBuf,
    initial_clone: TreeSnapshot,
    final_clone: TreeSnapshot,
    prepared: PreparedClone,
    state_record: StateRecord,
    ui_state_tmp_orphans: Vec<ArtifactEntry>,
    recovery_artifacts: Vec<ArtifactEntry>,
    byte_clone_ms: u64,
    clone_preparation_ms: u64,
    rehearsal_ms: u64,
}

fn run_on_clone(
    source: &Path,
    scratch: &Path,
    recovery: &Path,
    source_before: &TreeSnapshot,
    started_at_unix_ms: i64,
) -> Result<CompletedClone, HarnessError> {
    create_dir_all(scratch, "create scratch directory")?;
    create_dir_all(recovery, "create recovery directory")?;
    let scratch = canonicalize(scratch, "canonicalize scratch directory")?;
    let recovery = canonicalize(recovery, "canonicalize recovery directory")?;
    ensure_outside(source, &scratch, "scratch")?;
    ensure_outside(source, &recovery, "recovery")?;
    ensure_disjoint(&scratch, &recovery)?;

    let clone_path = scratch.join(format!("clone-{started_at_unix_ms}"));
    ensure_outside(source, &clone_path, "clone")?;

    let clone_started = Instant::now();
    clone_tree(source, &clone_path)?;
    let initial_clone = snapshot_tree(&clone_path)?;
    let byte_clone_ms = elapsed_ms(clone_started);
    if source_before.entries != initial_clone.entries {
        return Err(HarnessError::CloneMismatch);
    }
    let ui_state_tmp_orphans = debris_entries(&initial_clone);

    let preparation_started = Instant::now();
    let prepared = prepare_clone(&clone_path, started_at_unix_ms)?;
    let clone_preparation_ms = elapsed_ms(preparation_started);

    let rehearsal_started = Instant::now();
    let outcome = run_rehearsal(RehearsalConfig {
        root: &clone_path,
        recovery_dir: &recovery,
        now_ms: started_at_unix_ms.saturating_add(1),
        faults: &NoFaults,
    })?;
    let rehearsal_ms = elapsed_ms(rehearsal_started);
    let state_record = match outcome {
        RehearsalOutcome::Complete(record) if record.current == RehearsalState::Complete => record,
        RehearsalOutcome::Complete(record) => {
            return Err(HarnessError::IncompleteOutcome(format!(
                "Complete variant carried {:?}",
                record.current
            )));
        }
        RehearsalOutcome::Failed(record) => {
            return Err(HarnessError::IncompleteOutcome(format!(
                "failed at {:?}",
                record.current
            )));
        }
        RehearsalOutcome::Crashed(record) => {
            return Err(HarnessError::IncompleteOutcome(format!(
                "crashed at {:?}",
                record.current
            )));
        }
    };

    let final_clone = snapshot_tree(&clone_path)?;
    let recovery_artifacts = artifact_manifest(&recovery, Some(EVIDENCE_FILE))?;
    Ok(CompletedClone {
        clone_path,
        initial_clone,
        final_clone,
        prepared,
        state_record,
        ui_state_tmp_orphans,
        recovery_artifacts,
        byte_clone_ms,
        clone_preparation_ms,
        rehearsal_ms,
    })
}

fn validate_paths(config: HarnessConfig<'_>) -> Result<(PathBuf, PathBuf, PathBuf), HarnessError> {
    let source = canonicalize(config.source, "canonicalize source workspace")?;
    let source_meta = symlink_metadata(&source, "inspect source workspace")?;
    if !source_meta.is_dir() {
        return Err(HarnessError::SourceDohcMissing);
    }
    let dohc = source.join(".dohc");
    let dohc_meta = match std::fs::symlink_metadata(&dohc) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(HarnessError::SourceDohcMissing);
        }
        Err(source) => {
            return Err(HarnessError::Io {
                operation: "inspect source .dohc directory",
                source,
            });
        }
    };
    if !dohc_meta.is_dir() || dohc_meta.file_type().is_symlink() {
        return Err(HarnessError::SourceDohcMissing);
    }

    let scratch = resolve_intended(config.scratch)?;
    let recovery = resolve_intended(config.recovery)?;
    ensure_outside(&source, &scratch, "scratch")?;
    ensure_outside(&source, &recovery, "recovery")?;
    ensure_disjoint(&scratch, &recovery)?;
    Ok((source, scratch, recovery))
}

fn ensure_outside(
    source: &Path,
    candidate: &Path,
    which: &'static str,
) -> Result<(), HarnessError> {
    if is_within(candidate, source) {
        return Err(HarnessError::PathInsideSource { which });
    }
    Ok(())
}

fn ensure_disjoint(scratch: &Path, recovery: &Path) -> Result<(), HarnessError> {
    if is_within(scratch, recovery) || is_within(recovery, scratch) {
        return Err(HarnessError::ScratchRecoveryOverlap);
    }
    Ok(())
}

fn prepare_clone(clone_path: &Path, now_ms: i64) -> Result<PreparedClone, HarnessError> {
    let engine = clone_path.join(".dohc").join("engine");
    create_dir_all(&engine, "create clone engine directory")?;
    let retention = engine.join(TYPESCRIPT_STORE_DIR);
    if std::fs::symlink_metadata(&retention).is_ok() {
        return Err(HarnessError::RetentionDirectoryExists);
    }

    let mut present = Vec::new();
    for name in SQLITE_SOURCE_FILES {
        let source = engine.join(name);
        match std::fs::symlink_metadata(&source) {
            Ok(metadata) if metadata.file_type().is_file() => present.push((name, source)),
            Ok(_) => {
                return Err(HarnessError::UnsupportedEntry {
                    path: display_path(&source),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(HarnessError::Io {
                    operation: "inspect cloned TypeScript store",
                    source,
                });
            }
        }
    }
    let mut preserved_store = Vec::new();
    if !present.is_empty() {
        create_dir(&retention, "create TypeScript-store retention directory")?;
        for (name, source) in present {
            let destination = retention.join(name);
            std::fs::rename(&source, &destination).map_err(|source| HarnessError::Io {
                operation: "retain cloned TypeScript store",
                source,
            })?;
            let (sha256, size_bytes) = hash_file(&destination)?;
            preserved_store.push(PreservedSourceStoreEntry {
                original_relative_path: format!(".dohc/engine/{name}"),
                retained_relative_path: format!(".dohc/engine/{TYPESCRIPT_STORE_DIR}/{name}"),
                size_bytes,
                sha256,
            });
        }
    }

    let shadow_token = issue_token()?;
    let rehearsal_token = issue_token()?;
    write_shadow_marker_for_harness(clone_path, &shadow_token)?;
    write_rehearsal_token_for_harness(clone_path, &rehearsal_token)?;
    let validated = validate_rehearsal_root(clone_path)?;
    if validated.shadow_token != shadow_token || validated.rehearsal_token != rehearsal_token {
        return Err(HarnessError::IncompleteOutcome(
            "marker round-trip validation mismatch".to_owned(),
        ));
    }

    let db = engine.join("engine.db");
    let mut store = EngineStore::open(&db, now_ms)?;
    if !store.bind_shadow_clone_token(&shadow_token)? {
        return Err(HarnessError::ShadowBindingRefused);
    }
    drop(store);

    Ok(PreparedClone { preserved_store })
}

fn issue_token() -> Result<String, HarnessError> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| HarnessError::RandomToken)?;
    Ok(to_hex(&bytes))
}

fn clone_tree(source: &Path, destination: &Path) -> Result<(), HarnessError> {
    create_dir(destination, "create clone root")?;
    clone_directory(source, destination)
}

fn clone_directory(source: &Path, destination: &Path) -> Result<(), HarnessError> {
    let metadata = symlink_metadata(source, "inspect source directory during clone")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(HarnessError::UnsupportedEntry {
            path: display_path(source),
        });
    }
    let mut entries = read_dir_sorted(source)?;
    for entry in entries.drain(..) {
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = symlink_metadata(&source_path, "inspect source entry during clone")?;
        if metadata.file_type().is_symlink() {
            return Err(HarnessError::UnsupportedEntry {
                path: display_path(&source_path),
            });
        }
        if metadata.is_dir() {
            create_dir(&destination_path, "create cloned directory")?;
            clone_directory(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            std::fs::copy(&source_path, &destination_path).map_err(|source| HarnessError::Io {
                operation: "copy source file into clone",
                source,
            })?;
            preserve_times(&metadata, &destination_path)?;
        } else {
            return Err(HarnessError::UnsupportedEntry {
                path: display_path(&source_path),
            });
        }
    }
    preserve_times(&metadata, destination)
}

fn preserve_times(metadata: &Metadata, destination: &Path) -> Result<(), HarnessError> {
    filetime::set_file_times(
        destination,
        FileTime::from_last_access_time(metadata),
        FileTime::from_last_modification_time(metadata),
    )
    .map_err(|source| HarnessError::Io {
        operation: "preserve cloned entry timestamps",
        source,
    })
}

fn snapshot_tree(root: &Path) -> Result<TreeSnapshot, HarnessError> {
    let metadata = symlink_metadata(root, "inspect snapshot root")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(HarnessError::UnsupportedEntry {
            path: display_path(root),
        });
    }
    let mut entries = Vec::new();
    snapshot_entry(root, root, &metadata, &mut entries)?;
    snapshot_directory(root, root, &mut entries)?;
    let summary = summarize(&entries);
    Ok(TreeSnapshot { entries, summary })
}

fn snapshot_directory(
    root: &Path,
    directory: &Path,
    output: &mut Vec<TreeEntry>,
) -> Result<(), HarnessError> {
    for entry in read_dir_sorted(directory)? {
        let path = entry.path();
        let metadata = symlink_metadata(&path, "inspect snapshot entry")?;
        snapshot_entry(root, &path, &metadata, output)?;
        if metadata.is_dir() {
            snapshot_directory(root, &path, output)?;
        }
    }
    Ok(())
}

fn snapshot_entry(
    root: &Path,
    path: &Path,
    metadata: &Metadata,
    output: &mut Vec<TreeEntry>,
) -> Result<(), HarnessError> {
    if metadata.file_type().is_symlink() {
        return Err(HarnessError::UnsupportedEntry {
            path: display_path(path),
        });
    }
    let modified = FileTime::from_last_modification_time(metadata);
    let relative_path = if path == root {
        ".".to_owned()
    } else {
        portable_relative(path.strip_prefix(root).map_err(|_| {
            HarnessError::IncompleteOutcome("snapshot path escaped root".to_owned())
        })?)?
    };
    if metadata.is_dir() {
        output.push(TreeEntry {
            relative_path,
            kind: EntryKind::Directory,
            size_bytes: 0,
            modified_seconds: modified.unix_seconds(),
            modified_nanoseconds: modified.nanoseconds(),
            sha256: String::new(),
        });
    } else if metadata.is_file() {
        let (sha256, size_bytes) = hash_file(path)?;
        output.push(TreeEntry {
            relative_path,
            kind: EntryKind::File,
            size_bytes,
            modified_seconds: modified.unix_seconds(),
            modified_nanoseconds: modified.nanoseconds(),
            sha256,
        });
    } else {
        return Err(HarnessError::UnsupportedEntry {
            path: display_path(path),
        });
    }
    Ok(())
}

fn summarize(entries: &[TreeEntry]) -> TreeSummary {
    let mut hasher = Sha256::new();
    let mut directory_count = 0;
    let mut file_count = 0;
    let mut total_file_bytes = 0_u64;
    for entry in entries {
        match entry.kind {
            EntryKind::Directory => {
                directory_count += 1;
                hasher.update(b"d");
            }
            EntryKind::File => {
                file_count += 1;
                total_file_bytes = total_file_bytes.saturating_add(entry.size_bytes);
                hasher.update(b"f");
            }
        }
        hash_field(&mut hasher, entry.relative_path.as_bytes());
        hasher.update(entry.size_bytes.to_le_bytes());
        hasher.update(entry.modified_seconds.to_le_bytes());
        hasher.update(entry.modified_nanoseconds.to_le_bytes());
        hash_field(&mut hasher, entry.sha256.as_bytes());
    }
    TreeSummary {
        directory_count,
        file_count,
        total_file_bytes,
        snapshot_sha256: to_hex(&hasher.finalize()),
    }
}

fn hash_field(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

fn debris_entries(snapshot: &TreeSnapshot) -> Vec<ArtifactEntry> {
    snapshot
        .entries
        .iter()
        .filter(|entry| {
            entry.kind == EntryKind::File
                && entry.relative_path.starts_with(".dohc/")
                && Path::new(&entry.relative_path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("ui-state.json.tmp-"))
        })
        .map(|entry| ArtifactEntry {
            relative_path: entry.relative_path.clone(),
            size_bytes: entry.size_bytes,
            sha256: entry.sha256.clone(),
        })
        .collect()
}

fn artifact_manifest(
    root: &Path,
    skip_root_file: Option<&str>,
) -> Result<Vec<ArtifactEntry>, HarnessError> {
    let snapshot = snapshot_tree(root)?;
    Ok(snapshot
        .entries
        .into_iter()
        .filter(|entry| {
            entry.kind == EntryKind::File
                && skip_root_file.is_none_or(|skip| entry.relative_path != skip)
        })
        .map(|entry| ArtifactEntry {
            relative_path: entry.relative_path,
            size_bytes: entry.size_bytes,
            sha256: entry.sha256,
        })
        .collect())
}

fn write_evidence(root: &Path, evidence: &RehearsalEvidence) -> Result<(), HarnessError> {
    let destination = root.join(EVIDENCE_FILE);
    if std::fs::symlink_metadata(&destination).is_ok() {
        return Err(HarnessError::Io {
            operation: "refuse to overwrite existing rehearsal evidence",
            source: std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "REHEARSAL_EVIDENCE.json already exists",
            ),
        });
    }
    let temp = root.join(format!(".{EVIDENCE_FILE}.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(evidence)?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|source| HarnessError::Io {
            operation: "create rehearsal evidence staging file",
            source,
        })?;
    file.write_all(&bytes).map_err(|source| HarnessError::Io {
        operation: "write rehearsal evidence",
        source,
    })?;
    file.write_all(b"\n").map_err(|source| HarnessError::Io {
        operation: "terminate rehearsal evidence",
        source,
    })?;
    file.sync_all().map_err(|source| HarnessError::Io {
        operation: "sync rehearsal evidence",
        source,
    })?;
    drop(file);
    std::fs::rename(&temp, &destination).map_err(|source| HarnessError::Io {
        operation: "publish rehearsal evidence",
        source,
    })
}

fn hash_file(path: &Path) -> Result<(String, u64), HarnessError> {
    let mut file = File::open(path).map_err(|source| HarnessError::Io {
        operation: "open file for hashing",
        source,
    })?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(|source| HarnessError::Io {
            operation: "read file for hashing",
            source,
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes = bytes.saturating_add(read as u64);
    }
    Ok((to_hex(&hasher.finalize()), bytes))
}

fn read_dir_sorted(path: &Path) -> Result<Vec<std::fs::DirEntry>, HarnessError> {
    let entries = std::fs::read_dir(path).map_err(|source| HarnessError::Io {
        operation: "enumerate directory",
        source,
    })?;
    let mut entries = entries
        .map(|entry| {
            entry.map_err(|source| HarnessError::Io {
                operation: "read directory entry",
                source,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    Ok(entries)
}

fn resolve_intended(path: &Path) -> Result<PathBuf, HarnessError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        current_dir()?.join(path)
    };
    let mut cursor = absolute.as_path();
    let mut missing = Vec::<OsString>::new();
    loop {
        match std::fs::canonicalize(cursor) {
            Ok(mut resolved) => {
                for component in missing.iter().rev() {
                    resolved.push(component);
                }
                return Ok(normalize_lexically(&resolved));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = cursor.file_name().ok_or(HarnessError::Io {
                    operation: "resolve intended path",
                    source: error,
                })?;
                missing.push(name.to_os_string());
                cursor = cursor.parent().ok_or(HarnessError::Io {
                    operation: "resolve intended path parent",
                    source: std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "path has no existing ancestor",
                    ),
                })?;
            }
            Err(source) => {
                return Err(HarnessError::Io {
                    operation: "resolve intended path",
                    source,
                });
            }
        }
    }
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            other => output.push(other.as_os_str()),
        }
    }
    output
}

fn is_within(candidate: &Path, parent: &Path) -> bool {
    let candidate = comparable_components(candidate);
    let parent = comparable_components(parent);
    candidate.starts_with(&parent)
}

fn comparable_components(path: &Path) -> Vec<String> {
    path.components()
        .map(|component| {
            let text = component.as_os_str().to_string_lossy();
            if cfg!(windows) {
                text.to_lowercase()
            } else {
                text.into_owned()
            }
        })
        .collect()
}

fn portable_relative(path: &Path) -> Result<String, HarnessError> {
    let text = path
        .to_str()
        .ok_or_else(|| HarnessError::UnsupportedEntry {
            path: display_path(path),
        })?;
    Ok(if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.to_owned()
    })
}

fn unix_now_ms() -> Result<i64, HarnessError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|source| HarnessError::Io {
            operation: "read system clock",
            source: std::io::Error::other(source),
        })?;
    Ok(i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn to_hex(digest: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn current_dir() -> Result<PathBuf, HarnessError> {
    std::env::current_dir().map_err(|source| HarnessError::Io {
        operation: "read current directory",
        source,
    })
}

fn canonicalize(path: &Path, operation: &'static str) -> Result<PathBuf, HarnessError> {
    std::fs::canonicalize(path).map_err(|source| HarnessError::Io { operation, source })
}

fn symlink_metadata(path: &Path, operation: &'static str) -> Result<Metadata, HarnessError> {
    std::fs::symlink_metadata(path).map_err(|source| HarnessError::Io { operation, source })
}

fn create_dir(path: &Path, operation: &'static str) -> Result<(), HarnessError> {
    std::fs::create_dir(path).map_err(|source| HarnessError::Io { operation, source })
}

fn create_dir_all(path: &Path, operation: &'static str) -> Result<(), HarnessError> {
    std::fs::create_dir_all(path).map_err(|source| HarnessError::Io { operation, source })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_testkit::ScratchDir;

    fn fixture_source() -> ScratchDir {
        let source = ScratchDir::new().expect("source scratch");
        let engine = source.join(".dohc").join("engine");
        std::fs::create_dir_all(&engine).expect("engine directory");
        std::fs::write(engine.join("engine.db"), b"typescript-authored-db").expect("foreign db");
        std::fs::write(source.join(".dohc").join("registry.json"), b"{}").expect("registry");
        std::fs::write(source.join("note.md"), b"dogfood fixture\n").expect("note");
        source
    }

    #[test]
    fn scratch_and_recovery_inside_source_are_refused_before_creation() {
        let source = fixture_source();
        let outside = ScratchDir::new().expect("outside");
        let scratch_inside = source.join("new-scratch");
        let recovery_inside = source.join("new-recovery");

        let scratch_error = validate_paths(HarnessConfig {
            source: source.path(),
            scratch: &scratch_inside,
            recovery: outside.path(),
        })
        .expect_err("scratch inside source must fail");
        assert!(matches!(
            scratch_error,
            HarnessError::PathInsideSource { which: "scratch" }
        ));
        assert!(!scratch_inside.exists(), "guard must not create the path");

        let recovery_error = validate_paths(HarnessConfig {
            source: source.path(),
            scratch: outside.path(),
            recovery: &recovery_inside,
        })
        .expect_err("recovery inside source must fail");
        assert!(matches!(
            recovery_error,
            HarnessError::PathInsideSource { which: "recovery" }
        ));
        assert!(!recovery_inside.exists(), "guard must not create the path");
    }

    #[test]
    fn source_untouched_assertion_detects_hash_changes() {
        let source = fixture_source();
        let before = snapshot_tree(source.path()).expect("before");
        std::fs::write(source.join("note.md"), b"changed behind harness\n").expect("change");
        let after = snapshot_tree(source.path()).expect("after");
        assert_ne!(before, after);
        assert_ne!(
            before.summary.snapshot_sha256,
            after.summary.snapshot_sha256
        );
    }

    #[test]
    fn issued_markers_round_trip_and_malformed_markers_are_refused() {
        let source = fixture_source();
        let clone = ScratchDir::new().expect("clone");
        snapshot_tree(source.path()).expect("snapshot");
        let shadow = issue_token().expect("shadow token");
        let rehearsal = issue_token().expect("rehearsal token");
        assert_eq!(shadow.len(), 64);
        assert_eq!(rehearsal.len(), 64);
        assert_ne!(shadow, rehearsal);
        assert!(shadow.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(rehearsal.bytes().all(|byte| byte.is_ascii_hexdigit()));

        write_shadow_marker_for_harness(clone.path(), &shadow).expect("shadow marker");
        write_rehearsal_token_for_harness(clone.path(), &rehearsal).expect("rehearsal marker");
        validate_rehearsal_root(clone.path()).expect("valid marker pair");
        std::fs::write(
            clone
                .join(".dohc")
                .join("engine")
                .join("CUTOVER_REHEARSAL_TOKEN"),
            b"not-64-hex",
        )
        .expect("corrupt marker");
        assert!(validate_rehearsal_root(clone.path()).is_err());
    }

    #[test]
    fn real_tree_fixture_completes_and_reports_dohc_debris_without_touching_source() {
        let source = fixture_source();
        for index in 0..17 {
            std::fs::write(
                source
                    .join(".dohc")
                    .join(format!("ui-state.json.tmp-{index}")),
                format!("orphan-{index}"),
            )
            .expect("debris");
        }
        let scratch_parent = ScratchDir::new().expect("scratch parent");
        let recovery_parent = ScratchDir::new().expect("recovery parent");
        let scratch = scratch_parent.join("clones");
        let recovery = recovery_parent.join("artifacts");
        let before = snapshot_tree(source.path()).expect("source before");

        let evidence = run(HarnessConfig {
            source: source.path(),
            scratch: &scratch,
            recovery: &recovery,
        })
        .expect("complete rehearsal");

        assert_eq!(evidence.outcome, "complete");
        assert_eq!(evidence.state_record.current, RehearsalState::Complete);
        assert!(evidence.source_unchanged.verified);
        assert_eq!(evidence.ui_state_tmp_orphans.len(), 17);
        assert_eq!(
            evidence.source_counts, evidence.initial_byte_clone_counts,
            "mtime-preserving clone must exactly match the source snapshot"
        );
        assert_eq!(snapshot_tree(source.path()).expect("source after"), before);
        assert!(
            recovery.join(EVIDENCE_FILE).is_file(),
            "evidence must be banked outside the clone"
        );
        assert!(
            evidence
                .preserved_typescript_store
                .iter()
                .any(|entry| entry.original_relative_path == ".dohc/engine/engine.db")
        );
    }
}
