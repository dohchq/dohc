//! The path floor: which workspace-relative paths a scan excludes.
//!
//! This ports the win32-safe classification *lessons* from the reference
//! accelerator (`crates/workspace-kernel/src/main.rs`) and the TS path floor
//! (`packages/workspace-engine/.../enginePathFloor.ts`, `paths.ts`): a path is
//! excluded if any segment is reserved (`.dohc`, `.git`, `node_modules`), a
//! segment carries an ignored write-temp prefix (`.dohc-write-`), or the file
//! is a SQLite sidecar (`*.db-wal` / `-shm` / `-journal`, and the `.sqlite`
//! variants).
//!
//! Segment comparison is normalized **per platform**. On Windows, Win32 strips
//! trailing dots/spaces on open and NTFS is case-insensitive, so `.dohc ` and
//! `.DOHC` both alias the reserved `.dohc` and must be excluded
//! (`LANGUAGE_SEMANTICS_MATRIX.md` 7.3 / 7.5). On case-sensitive POSIX hosts
//! those are **distinct real inodes** — a user's `.DOHC`, `.Dohc`, or `.dohc.`
//! directory is legitimate content, NOT the engine floor — so the strip and the
//! case-fold are gated behind `cfg(windows)` and only the EXACT `.dohc` (etc.)
//! is reserved on POSIX. The reference TS kernel lowercases + strips
//! unconditionally (`workspace-kernel/src/main.rs:683-684`), which silently
//! omits those real POSIX directories from the scan; Rust is corrected here per
//! the plan's "Rust is right, TS is platform-buggy → approved delta, don't
//! reproduce the bug" rule (recorded in `BEHAVIOR_DELTA.md`, CAL-3 section;
//! the TS kernel is flagged for a matching fix).
//!
//! We deliberately do NOT re-open the ADS-colon (7.2), device-name (7.10), or
//! 8.3-short-name (7.12) hazards here: those are `validateWorkspacePath`
//! admission concerns, not scan-floor concerns, and each is a separate
//! NEEDS-DECISION owned elsewhere. The floor's only job is to decide, given a
//! real on-disk relative path, whether the scan tracks it.

/// Reserved directory/segment names, matched case- and alias-insensitively at
/// any depth. `.dohc` at any depth is the engine's own storage floor.
const RESERVED_SEGMENTS: &[&str] = &[".dohc", ".git", "node_modules"];

/// Write-temp file prefixes: an in-progress `.dohc-write-*` staging file is
/// engine scratch, never user content.
const IGNORED_FILE_PREFIXES: &[&str] = &[".dohc-write-"];

/// SQLite sidecar suffixes; a sidecar is excluded only when its base ends in a
/// database extension, so a user's `notes/draft-wal` (no `.db` base) is kept.
const SIDECAR_SUFFIXES: &[&str] = &["-wal", "-shm", "-journal"];
const DB_BASE_EXTENSIONS: &[&str] = &[".db", ".sqlite", ".sqlite3"];

/// Normalize a single path segment for reserved/ignored comparison.
///
/// On Windows: strip trailing `.`/` ` (Win32 open-time aliasing), then
/// lowercase (NTFS case-insensitivity), so `.DOHC` / `.dohc ` alias `.dohc`.
/// On POSIX (case-sensitive): identity — the segment is compared exactly, so a
/// real `.DOHC` directory is user content, not the floor. (See module docs and
/// `BEHAVIOR_DELTA.md` CAL-3: this diverges from — and corrects — the TS
/// kernel, which strips+folds unconditionally.)
pub fn normalize_segment(segment: &str) -> String {
    #[cfg(windows)]
    {
        segment.trim_end_matches(['.', ' ']).to_lowercase()
    }
    #[cfg(not(windows))]
    {
        segment.to_owned()
    }
}

/// Whether a single normalized segment is reserved or carries an ignored
/// prefix.
pub fn segment_is_ignored(normalized: &str) -> bool {
    RESERVED_SEGMENTS.contains(&normalized)
        || IGNORED_FILE_PREFIXES
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
}

/// Whether a workspace-relative, forward-slash path has ANY ignored segment.
/// This is the `.dohc/**` (and `.git/**`, `node_modules/**`) exclusion.
pub fn has_ignored_segment(rel_path: &str) -> bool {
    rel_path
        .split('/')
        .map(normalize_segment)
        .any(|segment| segment_is_ignored(&segment))
}

/// Whether a file name is a SQLite sidecar for a database file (`x.db-wal`,
/// `x.sqlite-shm`, `x.db-journal`). The comparison is on the normalized
/// (alias-stripped, lowercased) file name.
pub fn is_database_sidecar(file_name: &str) -> bool {
    let lower = normalize_segment(file_name);
    SIDECAR_SUFFIXES.iter().any(|suffix| {
        lower
            .strip_suffix(suffix)
            .is_some_and(|base| DB_BASE_EXTENSIONS.iter().any(|ext| base.ends_with(ext)))
    })
}

/// Whether a whole file, addressed by its workspace-relative forward-slash
/// path, is excluded by the floor. Combines the ignored-segment check with the
/// sidecar check on the final segment.
pub fn is_excluded_file(rel_path: &str) -> bool {
    if has_ignored_segment(rel_path) {
        return true;
    }
    match rel_path.rsplit('/').next() {
        Some(name) => is_database_sidecar(name),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_segments_excluded_at_any_depth() {
        assert!(is_excluded_file(".dohc/engine/engine.db"));
        assert!(is_excluded_file("a/b/.git/config"));
        assert!(is_excluded_file("node_modules/pkg/index.js"));
        assert!(!is_excluded_file("notes/a.md"));
    }

    #[cfg(windows)]
    #[test]
    fn win32_trailing_alias_still_excluded() {
        // `.dohc ` (trailing space) and `.DOHC` alias `.dohc` on Win32.
        assert!(has_ignored_segment(".dohc /history.json"));
        assert!(has_ignored_segment(".DOHC/history.json"));
        assert!(has_ignored_segment(".git./config"));
    }

    #[cfg(not(windows))]
    #[test]
    fn posix_case_and_trailing_variants_are_distinct_content() {
        // Corrected POSIX behavior: only the EXACT reserved name is the floor.
        assert!(has_ignored_segment(".dohc/internal"));
        assert!(!has_ignored_segment(".DOHC/x.md"));
        assert!(!has_ignored_segment(".Dohc/x.md"));
        assert!(!has_ignored_segment(".dohc./x.md"));
        assert!(!has_ignored_segment(".git./config"));
    }

    #[test]
    fn write_temp_prefix_excluded() {
        assert!(is_excluded_file(".dohc-write-123.tmp"));
        assert!(is_excluded_file("sub/.dohc-write-abc"));
    }

    #[test]
    fn only_db_sidecars_excluded() {
        assert!(is_database_sidecar("ledger.sqlite-wal"));
        assert!(is_database_sidecar("engine.db-shm"));
        assert!(is_database_sidecar("x.sqlite3-journal"));
        // A user file that merely ends in `-wal` is kept.
        assert!(!is_database_sidecar("draft-wal"));
        assert!(!is_excluded_file("notes/draft-wal"));
    }
}
