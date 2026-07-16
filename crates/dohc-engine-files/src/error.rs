//! Typed error taxonomy for the files slice. Every variant carries a stable
//! kebab-case machine `code()` (the compatibility contract; `PORTING.md` §4),
//! and messages stay redaction-safe: a path may appear (the TS engine already
//! embeds offending paths in `normalizeWritePath`-style errors,
//! `LANGUAGE_SEMANTICS_MATRIX.md` 14.3), never file content or secrets.

/// A files-layer failure.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum FilesError {
    /// The scan exceeded the configured `max_files` bound. This is a hard,
    /// fail-closed error — never a silent truncation: a truncated listing fed
    /// into reconcile would look like a mass deletion and retire every file
    /// past the cap (`plan §Rust policy`: bounded everything, fail closed).
    #[error("workspace scan exceeded the max-files bound of {cap}")]
    TooManyFiles { cap: usize },

    /// The scan traversed more filesystem entries (files + skipped +
    /// directories) than `max_entries`. Bounds the DFS working set so a
    /// directory-heavy or over-cap-heavy tree fails closed rather than growing
    /// memory unbounded.
    #[error("workspace scan exceeded the max-entries bound of {cap}")]
    TooManyEntries { cap: usize },

    /// A file exceeded `max_file_bytes` and the configured over-cap policy is
    /// [`crate::bounds::OverCapPolicy::Error`]. (The default policy skips such
    /// files into the listing's `skipped` set instead.)
    #[error("file exceeds the max-file-bytes cap of {cap}: {path} ({size} bytes)")]
    FileTooLarge { path: String, size: u64, cap: u64 },

    /// The in-memory diff exceeded `max_diff_entries`. Bounded working set — a
    /// diff this large means the prior generation is stale enough that a full
    /// resynchronisation is the safe path, not an unbounded op list.
    #[error("scan diff exceeded the max-diff-entries bound of {cap}")]
    DiffTooLarge { cap: usize },

    /// A directory or file could not be read for a reason other than a benign
    /// mid-scan vanish (which is skipped). Surfaces the offending path and the
    /// io error kind, never content.
    #[error("workspace scan failed at {path}: {kind:?}")]
    ScanIo {
        path: String,
        kind: std::io::ErrorKind,
    },

    /// The workspace root does not resolve to a readable directory.
    #[error("workspace root is not a readable directory: {reason}")]
    InvalidRoot { reason: &'static str },

    /// The bounded hash-worker pool could not be spawned or has been torn down.
    #[error("hash worker pool is unavailable: {reason}")]
    PoolUnavailable { reason: &'static str },

    /// The files actor is no longer accepting commands (closed or its worker
    /// ended). Treat the handle as stale.
    #[error("files actor is unavailable")]
    ActorUnavailable,

    /// The files actor's bounded command queue is full — explicit backpressure
    /// (the protocol's `OVERLOADED`).
    #[error("files actor command queue is full")]
    Overloaded,

    /// A request's deadline elapsed before the operation completed. Any scan in
    /// flight was cancelled at its next between-unit boundary; no partial
    /// listing is committed.
    #[error("request deadline elapsed")]
    DeadlineExceeded,
}

impl FilesError {
    /// Construct a [`FilesError::ScanIo`] from a path and io error.
    pub(crate) fn scan_io(path: impl Into<String>, err: &std::io::Error) -> Self {
        FilesError::ScanIo {
            path: path.into(),
            kind: err.kind(),
        }
    }

    /// The stable machine code (kebab-case), asserted by ported tests.
    pub fn code(&self) -> &'static str {
        match self {
            FilesError::TooManyFiles { .. } => "too-many-files",
            FilesError::TooManyEntries { .. } => "too-many-entries",
            FilesError::FileTooLarge { .. } => "file-too-large",
            FilesError::DiffTooLarge { .. } => "diff-too-large",
            FilesError::ScanIo { .. } => "scan-io",
            FilesError::InvalidRoot { .. } => "invalid-root",
            FilesError::PoolUnavailable { .. } => "pool-unavailable",
            FilesError::ActorUnavailable => "actor-unavailable",
            FilesError::Overloaded => "overloaded",
            FilesError::DeadlineExceeded => "deadline-exceeded",
        }
    }
}
