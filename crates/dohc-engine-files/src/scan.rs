//! The workspace scanner: walk a root into a normalized file listing
//! (path, size, mtime, content hash), respecting the path floor and every
//! resource bound, cooperatively cancellable.
//!
//! The walk is an explicit bounded stack (no recursion — a deep tree cannot
//! blow the call stack) and never follows a symlink: a symlinked directory is
//! not descended and a symlink leaf is untracked (`lstat`, never `stat`). A
//! file that vanishes
//! mid-walk is a benign race and is skipped. Other per-entry readability
//! failures are bounded and reported in [`ScanListing::failed`] while the walk
//! continues, matching the TS capture posture. The workspace root and all
//! structural/resource bounds remain fail-closed.

use crate::bounds::{OverCapPolicy, ScanBounds};
use crate::diff::ScanManifest;
use crate::error::FilesError;
use crate::floor;
use crate::hash::{
    HashInput, HashOutcome, HashPool, HashRun, PostHashExpectation, PostHashProbe, mtime_ms,
};
use crate::media::media_type_for_path;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// One tracked file in a normalized listing.
///
/// N8, amended (formerly `TEST_ORACLE.md` "N8: mtimes never compared"; the
/// oracle doc was retired from main, so the rule lives here): the content hash
/// stays the source of truth — the diff classifies added/changed/removed by
/// size and sha256, never by mtime. `mtime_ms` has exactly one job: when a
/// file's size AND mtime both equal a prior manifest entry's recorded pairing
/// (both non-zero), [`Scanner::scan_with_prior`] reuses that entry's hash
/// without reading the file. Any size or mtime difference, and any entry
/// without a recorded mtime, re-hashes the bytes. This is the standard git
/// tradeoff: a same-size edit that forges its mtime back to the recorded value
/// goes unseen until the next event changes the file's size or mtime.
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
/// workspace actor (pool created once, reused, bounded).
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

    /// Scan `root` into a normalized listing, hashing every tracked file.
    pub fn scan(&self, root: &Path, token: &CancellationToken) -> Result<ScanOutcome, FilesError> {
        self.scan_with_prior(root, &ScanManifest::empty(), token)
    }

    /// Scan `root`, short-circuiting the hash for any file whose size and
    /// mtime both match its `prior` manifest entry: the entry's recorded hash
    /// is reused and the file is never read. A zero mtime on either side
    /// always hashes (no recorded pairing exists — see the amended N8 rule on
    /// [`FileEntry`]). A reused file cannot surface a read failure, so a file
    /// that became unreadable without changing size or mtime stays tracked at
    /// its last-known-good content instead of degrading the scan.
    pub fn scan_with_prior(
        &self,
        root: &Path,
        prior: &ScanManifest,
        token: &CancellationToken,
    ) -> Result<ScanOutcome, FilesError> {
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

        // The hash-reuse short-circuit (amended N8): a candidate whose size
        // and mtime both match its prior entry keeps the recorded hash; every
        // other candidate becomes a hash input. Inputs stay in candidate
        // order, so `outcomes` (indexed by input) can be consumed sequentially
        // against the non-reused candidates below.
        let mut reused: Vec<Option<String>> = Vec::with_capacity(candidates.files.len());
        let mut inputs: Vec<HashInput> = Vec::new();
        let mut post_hash: Vec<PostHashExpectation> = Vec::new();
        for candidate in &candidates.files {
            let hash = prior.get(&candidate.rel).and_then(|entry| {
                (candidate.mtime_ms != 0
                    && entry.mtime_ms == candidate.mtime_ms
                    && entry.size == candidate.size)
                    .then(|| entry.sha256.clone())
            });
            if hash.is_none() {
                inputs.push(HashInput {
                    index: inputs.len(),
                    abs: candidate.abs.clone(),
                });
                post_hash.push(PostHashExpectation {
                    probe_path: self.io_faults.as_ref().map(|_| candidate.rel.clone()),
                    size: candidate.size,
                    mtime_ms: candidate.mtime_ms,
                });
            }
            reused.push(hash);
        }

        let post_hash_probe = self.io_faults.as_ref().map(|faults| {
            let faults = Arc::clone(faults);
            Arc::new(move |path: &str| faults.error_kind(path, ScanIoOperation::Hash))
                as PostHashProbe
        });
        let outcomes = match self.pool.hash_batched_with_post_stat(
            &inputs,
            &post_hash,
            post_hash_probe,
            token,
        )? {
            HashRun::Cancelled => return Ok(ScanOutcome::Cancelled),
            HashRun::Completed { outcomes } => outcomes,
        };

        let Enumerated {
            files: candidate_files,
            mut skipped,
            mut failed,
        } = candidates;
        let mut files = Vec::with_capacity(candidate_files.len());
        let mut outcomes = outcomes.into_iter();
        for (index, candidate) in candidate_files.into_iter().enumerate() {
            if let Some(sha256) = reused[index].take() {
                files.push(FileEntry {
                    media_type: media_type_for_path(&candidate.rel),
                    path: candidate.rel,
                    size: candidate.size,
                    mtime_ms: candidate.mtime_ms,
                    sha256,
                });
                continue;
            }
            let Some(outcome) = outcomes.next() else {
                // One outcome per non-reused candidate; a shortfall is an
                // internal accounting bug, surfaced rather than panicking.
                return Err(FilesError::PoolUnavailable {
                    reason: "hash pool dropped a result",
                });
            };
            match outcome {
                HashOutcome::Hashed {
                    sha256,
                    bytes,
                    stable_mtime_ms,
                } => {
                    // The candidate mtime comes from the enumerate-time stat,
                    // but the hashed bytes come from a later read. A same-size
                    // write inside that gap would pair the stale mtime with the
                    // new bytes' hash, and an mtime-preserving restore of the
                    // original bytes would then reuse the wrong hash forever.
                    // Re-stat after hashing: the entry carries the enumerate
                    // mtime only when the post-hash (size, mtime) equals the
                    // enumerate observation — the file provably sat still
                    // across the whole stat→read→stat window. Any drift, or a
                    // failed re-stat, records 0 (no pairing) and the next scan
                    // re-hashes. The hash worker performs that path stat
                    // immediately after the byte stream, retaining the race
                    // fence without a serial second pass here.
                    files.push(FileEntry {
                        media_type: media_type_for_path(&candidate.rel),
                        path: candidate.rel,
                        // The metadata size and the streamed byte count agree in
                        // the absence of a concurrent truncation; trust the streamed
                        // count (what was actually hashed).
                        size: bytes,
                        mtime_ms: stable_mtime_ms,
                        sha256,
                    })
                }
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

        // Two-sided accounting: one outcome per non-reused candidate means the
        // iterator must be exactly exhausted here, not merely never short.
        if outcomes.next().is_some() {
            return Err(FilesError::PoolUnavailable {
                reason: "hash pool produced an extra result",
            });
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
        // Carry the normalized parent path so descendants only convert their
        // own names. The filesystem still receives the original PathBuf.
        let mut stack = vec![(root.to_path_buf(), String::new())];
        let mut files: Vec<Candidate> = Vec::new();
        let mut skipped: Vec<SkippedPath> = Vec::new();
        let mut failed: Vec<FailedPath> = Vec::new();
        // Total filesystem entries traversed (files + skipped + directories +
        // anything else iterated). Bounds the DFS working set so a
        // directory-heavy tree cannot grow the stack unbounded.
        let mut entries: usize = 0;

        while let Some((dir, dir_rel)) = stack.pop() {
            if token.is_cancelled() {
                return Ok(EnumOutcome::Cancelled);
            }
            let injected_read_dir = self.injected(&dir_rel, ScanIoOperation::ReadDir);
            let read_dir = match injected_read_dir {
                Some(kind) if dir == root => {
                    return Err(FilesError::ScanIo {
                        path: display(&dir),
                        kind,
                    });
                }
                Some(kind) => {
                    failed.push(FailedPath {
                        path: dir_rel,
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
                            path: dir_rel,
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
                            path: dir_rel.clone(),
                            kind: err.kind(),
                        });
                        self.check_file_bound(files.len(), skipped.len(), failed.len())?;
                        continue;
                    }
                };
                let name = entry.file_name();
                let path = dir.join(&name);
                let name = name.to_string_lossy();
                let normalized_name = normalized_path(&name);
                let mut rel = String::with_capacity(dir_rel.len() + 1 + normalized_name.len());
                if !dir_rel.is_empty() {
                    rel.push_str(&dir_rel);
                    rel.push('/');
                }
                rel.push_str(&normalized_name);
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
                if file_type.is_dir() {
                    if !floor::segment_is_ignored(&floor::normalize_segment(&name)) {
                        stack.push((path, rel));
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
                    size,
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
    size: u64,
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
/// `canonical_workspace_root` intent (reject a non-directory), but does not
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

fn normalized_path(path: &str) -> String {
    #[cfg(test)]
    NORMALIZED_COMPONENTS
        .with(|count| count.set(count.get() + Path::new(path).components().count()));
    path.replace('\\', "/")
}

fn display(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
thread_local! {
    static NORMALIZED_COMPONENTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod traversal_tests {
    use super::*;
    use dohc_test_scratch::ScratchDir;

    #[test]
    fn deep_scan_normalizes_each_component_once() {
        let scratch = ScratchDir::new_named("deep-scan-components").unwrap();
        let relative = "one/two/three/four/five/six/seven/eight/note.md";
        let path = scratch.path().join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "before").unwrap();
        let scanner = Scanner::new(ScanBounds::default()).unwrap();
        NORMALIZED_COMPONENTS.with(|count| count.set(0));
        let ScanOutcome::Completed(listing) = scanner
            .scan(scratch.path(), &CancellationToken::new())
            .unwrap()
        else {
            panic!("scan cancelled");
        };
        assert_eq!(listing.files.len(), 1);
        assert_eq!(listing.files[0].path, relative);
        let normalized = NORMALIZED_COMPONENTS.with(|count| count.get());
        assert_eq!(
            normalized, 9,
            "ancestor components must not be normalized again for each descendant"
        );

        std::fs::write(&path, "external edit").unwrap();
        let ScanOutcome::Completed(changed) = scanner
            .scan(scratch.path(), &CancellationToken::new())
            .unwrap()
        else {
            panic!("scan cancelled");
        };
        assert_ne!(listing.files[0].sha256, changed.files[0].sha256);
        assert_eq!(changed.files[0].size, 13);
    }

    #[test]
    fn scan_rebuilds_paths_after_external_directory_rename() {
        let scratch = ScratchDir::new_named("scan-renamed-paths").unwrap();
        for relative in ["old/深い/note.md", "sibling/note.md", "old/.dohc/hidden.md"] {
            let path = scratch.path().join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, relative).unwrap();
        }
        let scanner = Scanner::new(ScanBounds::default()).unwrap();
        let token = CancellationToken::new();
        let ScanOutcome::Completed(before) = scanner.scan(scratch.path(), &token).unwrap() else {
            panic!("scan cancelled");
        };
        assert_eq!(before.files.len(), 2);
        let prior = ScanManifest::from_entries(before.files.iter().map(|file| {
            (
                file.path.clone(),
                crate::diff::ManifestEntry {
                    size: file.size,
                    sha256: file.sha256.clone(),
                    mtime_ms: file.mtime_ms,
                },
            )
        }));
        std::fs::rename(scratch.path().join("old"), scratch.path().join("new")).unwrap();
        std::fs::write(scratch.path().join("new/深い/note.md"), "external change").unwrap();
        let ScanOutcome::Completed(after) = scanner
            .scan_with_prior(scratch.path(), &prior, &token)
            .unwrap()
        else {
            panic!("scan cancelled");
        };
        assert_eq!(
            after
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["new/深い/note.md", "sibling/note.md"]
        );
        assert_ne!(before.files[0].sha256, after.files[0].sha256);
        assert_eq!(before.files[1], after.files[1]);
    }
}
