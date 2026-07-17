//! The workspace scanner: walk a root into a normalized file listing
//! (path, size, mtime, content hash), respecting the path floor and every
//! resource bound, cooperatively cancellable.
//!
//! The walk is an explicit bounded stack (no recursion — a deep tree cannot
//! blow the call stack) and never follows a symlink: a symlinked directory is
//! not descended and a symlink leaf is untracked (`lstat`, never `stat` —
//! `LANGUAGE_SEMANTICS_MATRIX.md` 8.1, `PORTING.md` §10). A file that vanishes
//! mid-walk is a benign race and is skipped. Other per-entry readability
//! failures are bounded and reported in [`ScanListing::failed`] while the walk
//! continues, matching the TS capture posture. The workspace root and all
//! structural/resource bounds remain fail-closed.

use crate::bounds::{OverCapPolicy, ScanBounds};
use crate::error::FilesError;
use crate::floor;
use crate::hash::{HashInput, HashOutcome, HashPool, HashRun};
use crate::media::media_type_for_path;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tokio_util::sync::CancellationToken;

/// One tracked file in a normalized listing. `mtime_ms` is captured for the
/// listing but is NEVER used for change detection or differential comparison
/// (hashes are the source of truth; `TEST_ORACLE.md` N8: mtimes never
/// compared).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub sha256: String,
    pub media_type: &'static str,
}

/// Why a seen file was excluded from the tracked listing (bounded, reported —
/// never silent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// The file exceeded `max_file_bytes` under [`OverCapPolicy::Skip`].
    OverCap,
}

/// A file that was seen but not tracked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedPath {
    pub path: String,
    pub size: u64,
    pub reason: SkipReason,
}

/// A path the scan could not inspect or hash. A failed directory path protects
/// every prior manifest entry below it from retirement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedPath {
    pub path: String,
    pub kind: ErrorKind,
}

/// Injectable read seam for deterministic cross-platform unreadable-path
/// tests. Production scanners have no injector and perform the real operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanIoOperation {
    ReadDir,
    FileType,
    Metadata,
    Hash,
}

/// Supplies a synthetic io error for a specific bounded scan unit.
pub trait ScanIoFaultInjector: Send + Sync {
    fn error_kind(&self, path: &str, operation: ScanIoOperation) -> Option<ErrorKind>;
}

/// A completed scan: the tracked files (sorted by path) plus the seen-but-
/// skipped set (sorted by path).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanListing {
    pub files: Vec<FileEntry>,
    pub skipped: Vec<SkippedPath>,
    pub failed: Vec<FailedPath>,
}

impl ScanListing {
    /// Whether the scan completed with one or more unreadable paths. Callers
    /// surface this as a degraded capture outcome while still applying every
    /// safe, independently-observed path.
    pub fn degraded(&self) -> bool {
        !self.failed.is_empty()
    }
}

/// The outcome of a scan.
#[derive(Debug)]
pub enum ScanOutcome {
    /// The scan finished and produced a listing.
    Completed(ScanListing),
    /// The token tripped at a between-unit boundary; NO listing is produced, so
    /// no downstream capture/reconcile can act on a partial view.
    Cancelled,
}

/// Owns the fixed hash-worker pool and the resource bounds. One scanner per
/// workspace actor (`PORTING.md` §14: pool created once, reused, bounded).
pub struct Scanner {
    bounds: ScanBounds,
    pool: HashPool,
    io_faults: Option<Arc<dyn ScanIoFaultInjector>>,
}

impl Scanner {
    /// Build a scanner with the given bounds, spinning up the fixed hash pool.
    pub fn new(bounds: ScanBounds) -> Result<Self, FilesError> {
        let pool = HashPool::new(
            bounds.hash_workers(),
            bounds.read_buffer_bytes(),
            bounds.max_file_bytes,
        )?;
        Ok(Scanner {
            bounds,
            pool,
            io_faults: None,
        })
    }

    /// Build a scanner with an injectable per-unit io-error seam. This exists
    /// for the `env.permission-denied` oracle because reliable ACL denial is
    /// not portable across the test hosts; production uses [`Scanner::new`].
    pub fn new_with_io_faults(
        bounds: ScanBounds,
        io_faults: Arc<dyn ScanIoFaultInjector>,
    ) -> Result<Self, FilesError> {
        let mut scanner = Self::new(bounds)?;
        scanner.io_faults = Some(io_faults);
        Ok(scanner)
    }

    /// The bounds this scanner enforces.
    pub fn bounds(&self) -> &ScanBounds {
        &self.bounds
    }

    /// The hash pool (exposed so a bound test can read the concurrency gauge).
    pub fn pool(&self) -> &HashPool {
        &self.pool
    }

    /// Scan `root` into a normalized listing.
    pub fn scan(&self, root: &Path, token: &CancellationToken) -> Result<ScanOutcome, FilesError> {
        let root = canonical_dir(root)?;
        let candidates = match self.enumerate(&root, token)? {
            EnumOutcome::Cancelled => return Ok(ScanOutcome::Cancelled),
            EnumOutcome::Completed {
                mut files,
                skipped,
                failed,
            } => {
                // Deterministic order: sort by path before hashing so result
                // indices are stable regardless of readdir order.
                files.sort_by(|a, b| a.rel.cmp(&b.rel));
                let mut skipped = skipped;
                skipped.sort_by(|a, b| a.path.cmp(&b.path));
                let mut failed = failed;
                failed.sort_by(|a, b| a.path.cmp(&b.path));
                Enumerated {
                    files,
                    skipped,
                    failed,
                }
            }
        };

        let inputs: Vec<HashInput> = candidates
            .files
            .iter()
            .enumerate()
            .map(|(index, c)| HashInput {
                index,
                abs: c.abs.clone(),
            })
            .collect();

        let outcomes = match self.pool.hash_batched(&inputs, token)? {
            HashRun::Cancelled => return Ok(ScanOutcome::Cancelled),
            HashRun::Completed { outcomes } => outcomes,
        };

        let Enumerated {
            files: candidate_files,
            mut skipped,
            mut failed,
        } = candidates;
        let mut files = Vec::with_capacity(candidate_files.len());
        for (candidate, outcome) in candidate_files.into_iter().zip(outcomes) {
            if let Some(kind) = self.injected(&candidate.rel, ScanIoOperation::Hash) {
                failed.push(FailedPath {
                    path: candidate.rel,
                    kind,
                });
                continue;
            }
            match outcome {
                HashOutcome::Hashed { sha256, bytes } => files.push(FileEntry {
                    media_type: media_type_for_path(&candidate.rel),
                    path: candidate.rel,
                    // The metadata size and the streamed byte count agree in
                    // the absence of a concurrent truncation; trust the streamed
                    // count (what was actually hashed).
                    size: bytes,
                    mtime_ms: candidate.mtime_ms,
                    sha256,
                }),
                // Vanished between enumeration and hashing: benign race, skip.
                HashOutcome::Vanished => {}
                // Grew past the cap after enumeration measured it under: move it
                // to the skipped set (re-stat for the current size), same
                // disposition enumeration gives an over-cap file.
                HashOutcome::OverCap => {
                    let size = std::fs::metadata(&candidate.abs)
                        .map(|m| m.len())
                        .unwrap_or(0);
                    skipped.push(SkippedPath {
                        path: candidate.rel,
                        size,
                        reason: SkipReason::OverCap,
                    });
                }
                HashOutcome::Cancelled => return Ok(ScanOutcome::Cancelled),
                HashOutcome::Io { kind } => {
                    failed.push(FailedPath {
                        path: candidate.rel,
                        kind,
                    });
                }
                // Defensive: hash_batched already fails closed on a worker
                // panic, so this arm is unreachable in practice.
                HashOutcome::Panicked => {
                    return Err(FilesError::PoolUnavailable {
                        reason: "a hash worker panicked",
                    });
                }
            }
        }

        // A stream-detected over-cap may have appended to `skipped` out of
        // order; restore the by-path sort.
        skipped.sort_by(|a, b| a.path.cmp(&b.path));
        failed.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(ScanOutcome::Completed(ScanListing {
            files,
            skipped,
            failed,
        }))
    }

    /// Enumerate every tracked candidate under `root`, bounded and cancellable.
    fn enumerate(&self, root: &Path, token: &CancellationToken) -> Result<EnumOutcome, FilesError> {
        let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
        let mut files: Vec<Candidate> = Vec::new();
        let mut skipped: Vec<SkippedPath> = Vec::new();
        let mut failed: Vec<FailedPath> = Vec::new();
        // Total filesystem entries traversed (files + skipped + directories +
        // anything else iterated). Bounds the DFS working set so a
        // directory-heavy tree cannot grow the stack unbounded.
        let mut entries: usize = 0;

        while let Some(dir) = stack.pop() {
            if token.is_cancelled() {
                return Ok(EnumOutcome::Cancelled);
            }
            let injected_read_dir = self.injected(&relative(root, &dir), ScanIoOperation::ReadDir);
            let read_dir = match injected_read_dir {
                Some(kind) if dir == root => {
                    return Err(FilesError::ScanIo {
                        path: display(&dir),
                        kind,
                    });
                }
                Some(kind) => {
                    failed.push(FailedPath {
                        path: relative(root, &dir),
                        kind,
                    });
                    self.check_file_bound(files.len(), skipped.len(), failed.len())?;
                    continue;
                }
                None => match std::fs::read_dir(&dir) {
                    Ok(rd) => rd,
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(err) if dir == root => {
                        return Err(FilesError::scan_io(display(&dir), &err));
                    }
                    Err(err) => {
                        failed.push(FailedPath {
                            path: relative(root, &dir),
                            kind: err.kind(),
                        });
                        self.check_file_bound(files.len(), skipped.len(), failed.len())?;
                        continue;
                    }
                },
            };
            for entry in read_dir {
                // Between-unit cancellation: per directory entry.
                if token.is_cancelled() {
                    return Ok(EnumOutcome::Cancelled);
                }
                // Bound the total traversal (dirs included) — fail closed rather
                // than grow the working set unbounded.
                entries = entries.saturating_add(1);
                if entries > self.bounds.max_entries {
                    return Err(FilesError::TooManyEntries {
                        cap: self.bounds.max_entries,
                    });
                }
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(err) => {
                        failed.push(FailedPath {
                            path: relative(root, &dir),
                            kind: err.kind(),
                        });
                        self.check_file_bound(files.len(), skipped.len(), failed.len())?;
                        continue;
                    }
                };
                let path = entry.path();
                let rel = relative(root, &path);
                let file_type = match self.injected(&rel, ScanIoOperation::FileType) {
                    Some(kind) => {
                        failed.push(FailedPath { path: rel, kind });
                        self.check_file_bound(files.len(), skipped.len(), failed.len())?;
                        continue;
                    }
                    None => match entry.file_type() {
                        Ok(ft) => ft,
                        Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(err) => {
                            failed.push(FailedPath {
                                path: rel,
                                kind: err.kind(),
                            });
                            self.check_file_bound(files.len(), skipped.len(), failed.len())?;
                            continue;
                        }
                    },
                };
                // Never follow a symlink: leaf untracked, symlinked dir not
                // descended.
                if file_type.is_symlink() {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if file_type.is_dir() {
                    if !floor::segment_is_ignored(&floor::normalize_segment(&name)) {
                        stack.push(path);
                    }
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }
                if floor::is_excluded_file(&rel) {
                    continue;
                }
                let metadata = match self.injected(&rel, ScanIoOperation::Metadata) {
                    Some(kind) => {
                        failed.push(FailedPath { path: rel, kind });
                        self.check_file_bound(files.len(), skipped.len(), failed.len())?;
                        continue;
                    }
                    None => match entry.metadata() {
                        Ok(md) => md,
                        Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(err) => {
                            failed.push(FailedPath {
                                path: rel,
                                kind: err.kind(),
                            });
                            self.check_file_bound(files.len(), skipped.len(), failed.len())?;
                            continue;
                        }
                    },
                };
                // A symlink race (entry became a link after file_type): skip.
                if !metadata.is_file() {
                    continue;
                }
                let size = metadata.len();
                if size > self.bounds.max_file_bytes {
                    match self.bounds.over_cap {
                        OverCapPolicy::Skip => {
                            skipped.push(SkippedPath {
                                path: rel,
                                size,
                                reason: SkipReason::OverCap,
                            });
                            // Over-cap skipped files count toward max_files too,
                            // so a tree of millions of over-cap files also fails
                            // closed instead of growing the skipped set.
                            self.check_file_bound(files.len(), skipped.len(), failed.len())?;
                            continue;
                        }
                        OverCapPolicy::Error => {
                            return Err(FilesError::FileTooLarge {
                                path: rel,
                                size,
                                cap: self.bounds.max_file_bytes,
                            });
                        }
                    }
                }
                files.push(Candidate {
                    rel,
                    abs: path,
                    mtime_ms: mtime_ms(&metadata),
                });
                // Fail closed on the max-files bound — never truncate.
                self.check_file_bound(files.len(), skipped.len(), failed.len())?;
            }
        }

        Ok(EnumOutcome::Completed {
            files,
            skipped,
            failed,
        })
    }

    fn injected(&self, path: &str, operation: ScanIoOperation) -> Option<ErrorKind> {
        self.io_faults
            .as_ref()
            .and_then(|faults| faults.error_kind(path, operation))
    }

    fn check_file_bound(
        &self,
        files: usize,
        skipped: usize,
        failed: usize,
    ) -> Result<(), FilesError> {
        if files.saturating_add(skipped).saturating_add(failed) > self.bounds.max_files {
            return Err(FilesError::TooManyFiles {
                cap: self.bounds.max_files,
            });
        }
        Ok(())
    }
}

struct Candidate {
    rel: String,
    abs: PathBuf,
    mtime_ms: i64,
}

struct Enumerated {
    files: Vec<Candidate>,
    skipped: Vec<SkippedPath>,
    failed: Vec<FailedPath>,
}

enum EnumOutcome {
    Completed {
        files: Vec<Candidate>,
        skipped: Vec<SkippedPath>,
        failed: Vec<FailedPath>,
    },
    Cancelled,
}

/// Resolve the root to a readable directory. Mirrors the kernel's
/// `canonical_workspace_root` intent (reject a non-directory), but does NOT
/// canonicalize to a `\\?\` path — the scan works with the caller's root and
/// produces root-relative paths, so canonicalization (and its 7.4 prefix
/// hazard) is unnecessary here.
fn canonical_dir(root: &Path) -> Result<PathBuf, FilesError> {
    let metadata = std::fs::metadata(root).map_err(|_| FilesError::InvalidRoot {
        reason: "workspace root does not exist or is unreadable",
    })?;
    if !metadata.is_dir() {
        return Err(FilesError::InvalidRoot {
            reason: "workspace root is not a directory",
        });
    }
    Ok(root.to_path_buf())
}

/// Workspace-relative, forward-slash path of `path` under `root`.
fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn display(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Milliseconds since the Unix epoch for a file's mtime, or `0` when the
/// platform cannot supply it or the time predates the epoch. Never compared, so
/// the fallback is harmless.
fn mtime_ms(metadata: &std::fs::Metadata) -> i64 {
    let Ok(modified) = metadata.modified() else {
        return 0;
    };
    let Ok(since_epoch) = modified.duration_since(UNIX_EPOCH) else {
        return 0;
    };
    i64::try_from(since_epoch.as_millis()).unwrap_or(i64::MAX)
}
