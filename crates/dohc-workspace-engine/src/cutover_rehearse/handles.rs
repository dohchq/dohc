use super::{Paths, RehearsalError};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const TRIPLET: [&str; 3] = ["engine.db", "engine.db-wal", "engine.db-shm"];
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
    if proof_dir.exists() {
        return Err(RehearsalError::Io {
            code: "triplet-proof-already-exists",
        });
    }
    std::fs::create_dir(&proof_dir).map_err(|e| RehearsalError::io("triplet-proof-create", e))?;

    let mut held = Vec::new();
    for name in TRIPLET {
        let source = paths.engine.join(name);
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
    let moved = paths.engine.join(MOVED_ASIDE_DIR);
    std::fs::create_dir(&moved).map_err(|e| RehearsalError::io("moved-aside-create", e))?;
    for entry in &verified.entries {
        let destination = moved.join(entry.name);
        if let Err(error) = rename_with_retry(&entry.source, &destination) {
            restore_missing_live(verified)?;
            return Err(RehearsalError::io("triplet-swap-timeout", error));
        }
    }

    for entry in &verified.entries {
        let destination = moved.join(entry.name);
        let metadata = std::fs::symlink_metadata(&destination)
            .map_err(|e| RehearsalError::io("moved-aside-metadata", e))?;
        if !metadata.file_type().is_file() || metadata.len() != entry.size_bytes {
            restore_missing_live(verified)?;
            return Err(RehearsalError::Io {
                code: "moved-aside-identity-mismatch",
            });
        }
        let (hash, bytes) = hash_file(&destination)?;
        if hash != entry.sha256 || bytes != entry.size_bytes {
            restore_missing_live(verified)?;
            return Err(RehearsalError::Io {
                code: "moved-aside-hash-mismatch",
            });
        }
    }
    Ok(moved)
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
    use fs4::FileExt as _;
    let file = OpenOptions::new().read(true).open(path)?;
    file.lock()?;
    Ok(file)
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
                let retryable = matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
                );
                if !retryable || attempt + 1 == SWAP_ATTEMPTS {
                    return Err(error);
                }
                last_error = Some(error);
                std::thread::sleep(Duration::from_millis(10_u64 << attempt));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::other("swap retry exhausted")))
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

#[cfg(test)]
pub(crate) fn moved_aside_path(paths: &Paths) -> PathBuf {
    paths.engine.join(MOVED_ASIDE_DIR)
}
