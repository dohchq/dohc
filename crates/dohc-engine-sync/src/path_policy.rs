//! Minimal share-boundary path floor for R10.
//!
//! This is intentionally not a port of `@dohc/workspace-core` path
//! normalization. R07 (`dohc-engine-files::{watch,policy}`) owns the definitive
//! Rust path floor, including percent decoding, host-specific aliases, device
//! names, Unicode/path normalization, and containment. R10 only recognizes
//! already-normalized, slash-separated relative paths needed to prevent secret
//! materialization across share boundaries. Any path outside that narrow
//! grammar is [`PathClass::Unsafe`] and therefore fails closed.
//!
//! Which paths hold secret material is not decided here. That narrow grammar
//! is exactly the input contract of
//! [`dohc_engine_files::policy::normalized_path_is_secret`], so this module
//! calls it. A restated copy of the rules would agree with the floor only by
//! coincidence, and a class added to the floor alone would leave relayed
//! deletes of it replayable (#484).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathClass {
    Tracked,
    Secret,
    Ignored,
    Unsafe,
}

pub fn classify_share_path(path: &str) -> PathClass {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains('%')
        || path.contains(':')
        || path.bytes().any(|byte| byte.is_ascii_control())
    {
        return PathClass::Unsafe;
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return PathClass::Unsafe;
    }
    let normalized: Vec<String> = segments
        .iter()
        .map(|segment| segment.trim_end_matches(['.', ' ']).to_ascii_lowercase())
        .collect();
    if normalized.iter().any(|segment| {
        segment == ".dohc"
            || segment == ".git"
            || segment == "node_modules"
            || segment.starts_with(".dohc-write-")
    }) {
        return PathClass::Ignored;
    }
    // The grammar checks above are exactly this predicate's input contract:
    // the path is relative, slash-separated, and free of `.`, `..`, and
    // percent-encoding. It folds case and Win32 trailing aliases itself.
    if dohc_engine_files::policy::normalized_path_is_secret(path) {
        return PathClass::Secret;
    }
    PathClass::Tracked
}
