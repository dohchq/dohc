use super::{Paths, RehearsalError};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) const DB_TRIPLET: [&str; 3] = ["engine.db", "engine.db-wal", "engine.db-shm"];
const COPY_BUFFER_BYTES: usize = 64 * 1024;
const SWAP_ATTEMPTS: usize = 6;
const MOVED_ASIDE_DIR: &str = "moved-aside-cutover-rehearsal";
const PROOF_DIR: &str = "triplet-proof";

#[derive(Debug, Clone)]
pub(crate) struct VerifiedTriplet {
    entries: Vec<VerifiedTripletEntry>,
}

#[derive(Debug, Clone)]
struct VerifiedTripletEntry {
    name: &'static str,
    source: PathBuf,
    proof: PathBuf,
    sha256: String,
    size_bytes: u64,
}

/// Phase A: acquire every present triplet handle, retain the platform's
/// exclusive lock while streaming each source into the proof copy, then close
/// all handles. The returned proof is the close-to-rename race baseline.
pub(crate) fn acquire_copy_hash_close(
    paths: &Paths,
    recovery_dir: &Path,
) -> Result<VerifiedTriplet, RehearsalError> {
    let proof_dir = recovery_dir.join(PROOF_DIR);
    // Proof copies are per-attempt scratch rebuilt from the live triplet; a
    // leftover dir from a crashed attempt must not wedge the resume.
    if proof_dir.exists() {
        std::fs::remove_dir_all(&proof_dir)
            .map_err(|e| RehearsalError::io("triplet-proof-clear", e))?;
    }
    std::fs::create_dir(&proof_dir).map_err(|e| RehearsalError::io("triplet-proof-create", e))?;

    let mut held = Vec::new();
    for name in DB_TRIPLET {
        let source = paths.engine.join(name);
        // Validate the path BEFORE opening: a sidecar replaced by a
        // FIFO/device would block a plain open forever instead of failing.
        match std::fs::symlink_metadata(&source) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(RehearsalError::io("triplet-source-metadata", error)),
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
                    return Err(RehearsalError::Io {
                        code: "triplet-source-not-regular",
                    });
                }
                if super::metadata_is_hard_linked(&metadata) {
                    return Err(RehearsalError::Io {
                        code: "triplet-source-hardlink-refused",
                    });
                }
            }
        }
        match open_exclusive(&source) {
            Ok(file) => held.push((name, source, file)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(RehearsalError::io("triplet-exclusive-open", error)),
        }
    }
    if held.iter().all(|(name, _, _)| *name != "engine.db") {
        return Err(RehearsalError::Io {
            code: "triplet-primary-missing",
        });
    }

    let mut entries = Vec::with_capacity(held.len());
    for (name, source, input) in &mut held {
        let name = *name;
        let proof = proof_dir.join(name);
        let (sha256, size_bytes) = copy_held_and_hash(input, &proof)?;
        entries.push(VerifiedTripletEntry {
            name,
            source: source.clone(),
            proof,
            sha256,
            size_bytes,
        });
    }
    // Every handle remains in `held` until all copies have been streamed. The
    // vector drops only after the proof set is complete, closing/unlocking the
    // whole triplet immediately before Phase B can begin.
    Ok(VerifiedTriplet { entries })
}

/// Phase B: immediately move the old live files into the retained sibling and
/// verify the moved bytes against Phase A. On any rename or verification
/// failure, missing live paths are restored from the proof copies; moved files
/// are retained for diagnosis and never deleted.
pub(crate) fn swap_and_verify(
    paths: &Paths,
    verified: &VerifiedTriplet,
) -> Result<PathBuf, RehearsalError> {
    // A triplet file that exists now but was not captured by Phase A appeared
    // after the proof — nothing has been moved yet, so refuse outright. Only
    // a definite NotFound counts as absent; any other metadata error must
    // fail closed rather than let an unverified sidecar ride along.
    for name in DB_TRIPLET {
        if verified.entries.iter().any(|entry| entry.name == name) {
            continue;
        }
        match std::fs::symlink_metadata(paths.engine.join(name)) {
            Ok(_) => {
                return Err(RehearsalError::Io {
                    code: "triplet-unverified-sidecar",
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(RehearsalError::io("triplet-sidecar-metadata", error)),
        }
    }

    let moved = paths.engine.join(MOVED_ASIDE_DIR);
    match std::fs::create_dir(&moved) {
        Ok(()) => {}
        // An EMPTY leftover dir is the crash window right after create_dir —
        // nothing was moved, so reuse it. A non-empty one is a real partial
        // move and stays a refusal.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let mut entries = std::fs::read_dir(&moved)
                .map_err(|e| RehearsalError::io("moved-aside-inspect", e))?;
            if entries.next().is_some() {
                return Err(RehearsalError::Io {
                    code: "moved-aside-not-clean",
                });
            }
        }
        Err(error) => return Err(RehearsalError::io("moved-aside-create", error)),
    }
    for entry in &verified.entries {
        let destination = moved.join(entry.name);
        if let Err(error) = rename_with_retry(&entry.source, &destination) {
            return Err(fail_swap(
                verified,
                RehearsalError::io("triplet-swap-timeout", error),
            ));
        }
    }

    // EVERY verification failure — including an IO error while inspecting the
    // moved bytes — must route through the rollback, never bypass it. The
    // parent-dir fsyncs make the renames durable BEFORE the MovedAside state
    // is recorded, so a power loss cannot persist the marker without the move.
    if let Err(error) = verify_moved_entries(&moved, verified)
        .and_then(|()| super::fsync_dir(&paths.engine))
        .and_then(|()| super::fsync_dir(&moved))
    {
        return Err(fail_swap(verified, error));
    }
    Ok(moved)
}

fn verify_moved_entries(moved: &Path, verified: &VerifiedTriplet) -> Result<(), RehearsalError> {
    for entry in &verified.entries {
        let destination = moved.join(entry.name);
        let metadata = std::fs::symlink_metadata(&destination)
            .map_err(|e| RehearsalError::io("moved-aside-metadata", e))?;
        if !metadata.file_type().is_file() || metadata.len() != entry.size_bytes {
            return Err(RehearsalError::Io {
                code: "moved-aside-identity-mismatch",
            });
        }
        let (hash, bytes) = hash_file(&destination)?;
        if hash != entry.sha256 || bytes != entry.size_bytes {
            return Err(RehearsalError::Io {
                code: "moved-aside-hash-mismatch",
            });
        }
    }
    Ok(())
}

/// Roll back after a failed swap without masking the swap error. Only when the
/// rollback ITSELF also fails is a combined code surfaced instead.
fn fail_swap(verified: &VerifiedTriplet, primary: RehearsalError) -> RehearsalError {
    match restore_missing_live(verified) {
        Ok(()) => primary,
        Err(_) => RehearsalError::Io {
            code: "triplet-swap-failed-and-rollback-failed",
        },
    }
}

pub(crate) fn move_aside(paths: &Paths, recovery_dir: &Path) -> Result<PathBuf, RehearsalError> {
    let verified = acquire_copy_hash_close(paths, recovery_dir)?;
    swap_and_verify(paths, &verified)
}

#[cfg(windows)]
fn open_exclusive(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new().read(true).share_mode(0).open(path)
}

#[cfg(unix)]
fn open_exclusive(path: &Path) -> std::io::Result<File> {
    let file = OpenOptions::new().read(true).open(path)?;
    // Bounded advisory-lock acquisition: contention means a foreign holder
    // (the rehearsal fixture has no live engine writers — force-settle is
    // TS-owned and runs before this harness), so fail closed instead of
    // blocking forever. The real `--cutover` tier must add a SQLite-level
    // exclusive gate; flock cannot stop a live SQLite writer.
    for attempt in 0..SWAP_ATTEMPTS {
        // fs4 rather than std's `File::try_lock`: same OS lock, but available
        // at the workspace MSRV (std stabilized it in 1.89).
        match fs4::FileExt::try_lock(&file) {
            Ok(()) => return Ok(file),
            Err(fs4::TryLockError::Error(error)) => return Err(error),
            Err(fs4::TryLockError::WouldBlock) => {
                if attempt + 1 < SWAP_ATTEMPTS {
                    std::thread::sleep(Duration::from_millis(10_u64 << attempt));
                }
            }
        }
    }
    Err(std::io::Error::from(std::io::ErrorKind::WouldBlock))
}

#[cfg(not(any(windows, unix)))]
fn open_exclusive(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

fn copy_held_and_hash(
    input: &mut File,
    destination: &Path,
) -> Result<(String, u64), RehearsalError> {
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|e| RehearsalError::io("triplet-proof-open", e))?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|e| RehearsalError::io("triplet-held-read", e))?;
        if read == 0 {
            break;
        }
        let chunk = buffer.get(..read).ok_or(RehearsalError::State)?;
        output
            .write_all(chunk)
            .map_err(|e| RehearsalError::io("triplet-proof-write", e))?;
        hasher.update(chunk);
        bytes = bytes.saturating_add(read as u64);
    }
    output
        .sync_all()
        .map_err(|e| RehearsalError::io("triplet-proof-sync", e))?;
    Ok((to_hex(&hasher.finalize()), bytes))
}

fn rename_with_retry(source: &Path, destination: &Path) -> std::io::Result<()> {
    let mut last_error = None;
    for attempt in 0..SWAP_ATTEMPTS {
        match std::fs::rename(source, destination) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if !retryable_rename_error(&error) || attempt + 1 == SWAP_ATTEMPTS {
                    return Err(error);
                }
                last_error = Some(error);
                std::thread::sleep(Duration::from_millis(10_u64 << attempt));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::other("swap retry exhausted")))
}

fn retryable_rename_error(error: &std::io::Error) -> bool {
    // ERROR_SHARING_VIOLATION (32) is the Windows contention this retry
    // targets; it maps to no stable `ErrorKind`.
    const WINDOWS_SHARING_VIOLATION: i32 = 32;
    matches!(
        error.kind(),
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
    ) || (cfg!(windows) && error.raw_os_error() == Some(WINDOWS_SHARING_VIOLATION))
}

fn restore_missing_live(verified: &VerifiedTriplet) -> Result<(), RehearsalError> {
    for entry in &verified.entries {
        if entry.source.exists() {
            continue;
        }
        let mut input = File::open(&entry.proof)
            .map_err(|e| RehearsalError::io("triplet-rollback-proof-open", e))?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&entry.source)
            .map_err(|e| RehearsalError::io("triplet-rollback-live-open", e))?;
        std::io::copy(&mut input, &mut output)
            .map_err(|e| RehearsalError::io("triplet-rollback-copy", e))?;
        output
            .sync_all()
            .map_err(|e| RehearsalError::io("triplet-rollback-sync", e))?;
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<(String, u64), RehearsalError> {
    let mut file = File::open(path).map_err(|e| RehearsalError::io("triplet-verify-open", e))?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| RehearsalError::io("triplet-verify-read", e))?;
        if read == 0 {
            break;
        }
        let chunk = buffer.get(..read).ok_or(RehearsalError::State)?;
        hasher.update(chunk);
        bytes = bytes.saturating_add(read as u64);
    }
    Ok((to_hex(&hasher.finalize()), bytes))
}

fn to_hex(digest: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

/// Whether the retained (moved-aside) old store is present — the artifact a
/// persisted `Complete` state implies.
pub(crate) fn moved_aside_db_present(paths: &Paths) -> bool {
    paths
        .engine
        .join(MOVED_ASIDE_DIR)
        .join("engine.db")
        .is_file()
}

#[cfg(test)]
pub(crate) fn moved_aside_path(paths: &Paths) -> PathBuf {
    paths.engine.join(MOVED_ASIDE_DIR)
}
