//! Corruption behavior and redacted diagnostics (`plan §Corruption behavior`).
//!
//! The store never auto-creates an empty replacement over a corrupt database
//! (the open path refuses to init over any non-empty/foreign file, so the
//! original DB + WAL evidence is preserved by construction). When an open fails,
//! this module classifies *why* into distinct kinds — unsupported-fingerprint,
//! migration-failure, corruption, permission, disk-full, transient-lock — so a
//! recovery surface can react correctly instead of treating every failure as
//! "corrupt", and it builds a **redacted** diagnostic bundle that carries
//! integrity metadata and evidence file *names* but never document bodies,
//! secrets, keys, chat content, or tokens.

use crate::error::StorageError;
use std::path::{Path, PathBuf};

/// The distinct recovery classifications an open/verify failure maps to. Each is
/// handled differently by a recovery surface (retry vs. export/reset vs. free
/// space vs. fix permissions), so they must never collapse into one bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorruptionKind {
    /// The schema fingerprint is not one this build recognizes (e.g. a v1 TS
    /// database). Recovery: export/reset — never migrate or overwrite.
    UnsupportedFingerprint,
    /// A migration failed to apply (or the ledger is incompatible). Recovery:
    /// investigate the migration; the store is at its prior consistent state.
    MigrationFailure,
    /// Structural corruption (bad rows, failed integrity check, foreign store).
    /// Recovery: read-only diagnostics / restore from backup.
    Corruption,
    /// A filesystem permission problem. Recovery: fix ACLs; the store is intact.
    Permission,
    /// Out of disk space. Recovery: free space; the source was never destroyed.
    DiskFull,
    /// A transient lock (Windows AV/indexer, busy SQLite handle). Recovery:
    /// retry; NOT corruption.
    TransientLock,
}

impl CorruptionKind {
    /// A stable kebab-case code (the machine surface a recovery tool switches on).
    pub const fn code(self) -> &'static str {
        match self {
            CorruptionKind::UnsupportedFingerprint => "unsupported-fingerprint",
            CorruptionKind::MigrationFailure => "migration-failure",
            CorruptionKind::Corruption => "corruption",
            CorruptionKind::Permission => "permission",
            CorruptionKind::DiskFull => "disk-full",
            CorruptionKind::TransientLock => "transient-lock",
        }
    }
}

/// Classify a storage failure into a recovery kind. The mapping is total and
/// deliberately distinct per kind so a caller never misclassifies (e.g. a
/// transient AV lock must not read as corruption — `LANGUAGE_SEMANTICS_MATRIX`
/// 7.8).
pub fn classify(err: &StorageError) -> CorruptionKind {
    match err {
        StorageError::UnsupportedFingerprint { .. } => CorruptionKind::UnsupportedFingerprint,
        StorageError::MigrationFailed { .. } => CorruptionKind::MigrationFailure,
        StorageError::DiskFull { .. } => CorruptionKind::DiskFull,
        StorageError::PermissionDenied { .. } => CorruptionKind::Permission,
        StorageError::FileLocked => CorruptionKind::TransientLock,
        // ForeignDatabase, StateCorrupt, BlobIntegrity, and the persist/backup/
        // input families all mean "the store as read is not usable as ours" —
        // corruption for recovery purposes.
        _ => CorruptionKind::Corruption,
    }
}

/// A redacted, machine-readable diagnostic bundle. Contains ONLY integrity and
/// classification metadata and evidence file *basenames* — never absolute
/// paths (which can embed a username), document bodies, secrets, or keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagnosticBundle {
    /// Opaque engine identity if it could be read; `None` if the store was too
    /// broken to read it.
    pub engine_uuid: Option<String>,
    /// The recovery classification.
    pub classification: CorruptionKind,
    /// The stable machine error code (`StorageError::code`).
    pub error_code: &'static str,
    /// A constant, redaction-safe human message (never interpolated user data).
    pub message: &'static str,
    /// Basenames of the preserved evidence files (e.g. `engine.db`,
    /// `engine.db-wal`). Never full paths.
    pub evidence: Vec<String>,
    pub created_at_ms: i64,
}

impl DiagnosticBundle {
    /// Build a bundle for a failed open. `db_path` is used only to enumerate
    /// which evidence files exist (their basenames); its directory is never
    /// recorded.
    pub fn for_open_failure(
        err: &StorageError,
        engine_uuid: Option<String>,
        db_path: &Path,
        now_ms: i64,
    ) -> Self {
        DiagnosticBundle {
            engine_uuid,
            classification: classify(err),
            error_code: err.code(),
            message: redacted_message(err),
            evidence: evidence_basenames(db_path),
            created_at_ms: now_ms,
        }
    }

    /// Compact, dependency-free JSON. Safe to write to a bundle file or log.
    pub fn to_json(&self) -> String {
        let uuid = match &self.engine_uuid {
            Some(u) => json_string(u),
            None => "null".to_owned(),
        };
        let evidence = {
            let items: Vec<String> = self.evidence.iter().map(|s| json_string(s)).collect();
            format!("[{}]", items.join(","))
        };
        format!(
            "{{\"engine_uuid\":{uuid},\"classification\":{},\"error_code\":{},\
             \"message\":{},\"evidence\":{evidence},\"created_at_ms\":{}}}",
            json_string(self.classification.code()),
            json_string(self.error_code),
            json_string(self.message),
            self.created_at_ms,
        )
    }
}

/// The SQLite file triplet whose presence we record as evidence. The original
/// files are never deleted (preservation by non-destruction), so recording
/// their basenames suffices for a recovery tool to find them.
fn evidence_basenames(db_path: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for suffix in ["", "-wal", "-shm"] {
        let candidate = sidecar(db_path, suffix);
        if candidate.exists()
            && let Some(name) = candidate.file_name().and_then(|n| n.to_str())
        {
            out.push(name.to_owned());
        }
    }
    out
}

fn sidecar(db_path: &Path, suffix: &str) -> PathBuf {
    if suffix.is_empty() {
        return db_path.to_path_buf();
    }
    let mut os = db_path.as_os_str().to_owned();
    os.push(suffix);
    PathBuf::from(os)
}

/// A constant, redaction-safe message per error family. Never interpolates the
/// dynamic fields (which are numbers/hashes here, but keep the discipline).
fn redacted_message(err: &StorageError) -> &'static str {
    match err {
        StorageError::UnsupportedFingerprint { .. } => {
            "database schema is from an unsupported version; export and reset is required"
        }
        StorageError::ForeignDatabase => "the file is not a dohc engine database",
        StorageError::MigrationFailed { .. } => "a schema migration failed to apply",
        StorageError::DiskFull { .. } => "insufficient free space",
        StorageError::PermissionDenied { .. } => "permission denied accessing the database",
        StorageError::FileLocked => "the database is transiently locked; retry",
        StorageError::BlobIntegrity { .. } => "a stored blob failed its integrity check",
        _ => "the engine store could not be opened",
    }
}

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
