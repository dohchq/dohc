//! Resource bounds for a scan / hash / diff run. This slice is largely ABOUT
//! bounds (`plan §Rust policy`: every buffer names its bound), so the config is
//! a first-class, explicit value — never a `num_cpus` guess in library code
//! (`PORTING.md` §14: pools sized by config, not the machine).

use std::num::NonZeroUsize;

/// Maximum UTF-8 text payload owned by workspace capture. This mirrors
/// `MAX_HISTORY_TEXT_SNAPSHOT_BYTES` in the dormant TypeScript oracle; the
/// larger [`ScanBounds::max_file_bytes`] remains the generic scan/hash ceiling.
pub const MAX_CAPTURE_TEXT_BYTES: u64 = 128 * 1024;

/// What to do when a file exceeds [`ScanBounds::max_file_bytes`]. The TS capture
/// path is tolerant — an over-cap file is skipped from the tracked listing, not
/// a hard failure (`workspaceEngineCapture.ts` demotes/skips over-cap content) —
/// so [`OverCapPolicy::Skip`] is the default; [`OverCapPolicy::Error`] is
/// available for callers that want a fail-closed cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverCapPolicy {
    /// Exclude the file from the hashed listing and record it in `skipped`.
    Skip,
    /// Fail the whole scan with [`crate::FilesError::FileTooLarge`].
    Error,
}

/// Fully-explicit resource bounds. Constructed via [`ScanBounds::builder`] or
/// the tuned [`ScanBounds::default`]; there is no way to leave a bound unset.
#[derive(Debug, Clone, Copy)]
pub struct ScanBounds {
    /// Hard cap on the number of tracked files. Exceeding it is a fail-closed
    /// [`crate::FilesError::TooManyFiles`], never a truncated listing. Over-cap
    /// *skipped* files count against this too, so a tree of millions of over-cap
    /// files also fails closed (bounded skipped set).
    pub max_files: usize,
    /// Hard cap on the TOTAL filesystem entries traversed (files + skipped +
    /// directories), bounding the DFS working set so a directory-heavy tree
    /// (millions of empty dirs) cannot grow the pending-directory stack or the
    /// walk unbounded. Exceeding it is [`crate::FilesError::TooManyEntries`].
    pub max_entries: usize,
    /// Inclusive cap on a single file's byte length. `size <= max_file_bytes`
    /// is hashed; a larger file follows [`ScanBounds::over_cap`].
    pub max_file_bytes: u64,
    /// The streaming read buffer size, in bytes. One buffer per hash worker;
    /// total hashing memory is bounded by `read_buffer_bytes * hash_workers`.
    pub read_buffer_bytes: NonZeroUsize,
    /// The fixed size of the hash-worker pool. In-flight hashes never exceed
    /// this — the pool is created once and reused, never spawned per file
    /// (`PORTING.md` §14: fixed-size, bounded queues).
    pub hash_workers: NonZeroUsize,
    /// Cap on the number of diff entries (added + changed + removed) held in
    /// memory. Exceeding it is [`crate::FilesError::DiffTooLarge`].
    pub max_diff_entries: usize,
    /// Over-cap file handling.
    pub over_cap: OverCapPolicy,
}

impl Default for ScanBounds {
    /// Tuned defaults for a desktop workspace: 200k files, 64 MiB per file,
    /// 64 KiB read buffer (matching the TS/kernel scan buffer,
    /// `workspace-kernel/src/main.rs`), 4 hash workers, 200k diff entries.
    fn default() -> Self {
        ScanBounds {
            max_files: 200_000,
            // Generous headroom over max_files for directories + skipped files;
            // still bounded so a pathological tree fails closed.
            max_entries: 5_000_000,
            max_file_bytes: 64 * 1024 * 1024,
            // Infallible: 64 * 1024 is non-zero.
            read_buffer_bytes: NonZeroUsize::new(64 * 1024).unwrap_or(NonZeroUsize::MIN),
            hash_workers: NonZeroUsize::new(4).unwrap_or(NonZeroUsize::MIN),
            max_diff_entries: 200_000,
            over_cap: OverCapPolicy::Skip,
        }
    }
}

impl ScanBounds {
    /// A builder seeded from [`ScanBounds::default`].
    pub fn builder() -> ScanBoundsBuilder {
        ScanBoundsBuilder {
            bounds: ScanBounds::default(),
        }
    }

    /// The number of hash workers as a plain `usize`.
    pub fn hash_workers(&self) -> usize {
        self.hash_workers.get()
    }

    /// The read buffer size as a plain `usize`.
    pub fn read_buffer_bytes(&self) -> usize {
        self.read_buffer_bytes.get()
    }
}

/// A small builder so tests can tighten one bound (e.g. `max_files = 3`) without
/// restating the rest.
#[derive(Debug, Clone, Copy)]
pub struct ScanBoundsBuilder {
    bounds: ScanBounds,
}

impl ScanBoundsBuilder {
    /// Set the max-files cap.
    pub fn max_files(mut self, cap: usize) -> Self {
        self.bounds.max_files = cap;
        self
    }

    /// Set the max-entries (total traversed) cap.
    pub fn max_entries(mut self, cap: usize) -> Self {
        self.bounds.max_entries = cap;
        self
    }

    /// Set the inclusive max-file-bytes cap.
    pub fn max_file_bytes(mut self, cap: u64) -> Self {
        self.bounds.max_file_bytes = cap;
        self
    }

    /// Set the streaming read buffer size (bytes).
    pub fn read_buffer_bytes(mut self, bytes: NonZeroUsize) -> Self {
        self.bounds.read_buffer_bytes = bytes;
        self
    }

    /// Set the fixed hash-worker pool size.
    pub fn hash_workers(mut self, workers: NonZeroUsize) -> Self {
        self.bounds.hash_workers = workers;
        self
    }

    /// Set the max-diff-entries cap.
    pub fn max_diff_entries(mut self, cap: usize) -> Self {
        self.bounds.max_diff_entries = cap;
        self
    }

    /// Set the over-cap policy.
    pub fn over_cap(mut self, policy: OverCapPolicy) -> Self {
        self.bounds.over_cap = policy;
        self
    }

    /// Finish building.
    pub fn build(self) -> ScanBounds {
        self.bounds
    }
}
