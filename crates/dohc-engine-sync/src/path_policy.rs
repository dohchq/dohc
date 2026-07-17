//! Minimal share-boundary path floor for R10.
//!
//! This is intentionally not a port of `@dohc/workspace-core` path
//! normalization. R07 (`dohc-engine-files::{watch,policy}`) owns the definitive
//! Rust path floor, including percent decoding, host-specific aliases, device
//! names, Unicode/path normalization, and containment. R10 only recognizes
//! already-normalized, slash-separated relative paths needed to prevent secret
//! materialization across share boundaries. Any path outside that narrow
//! grammar is [`PathClass::Unsafe`] and therefore fails closed.

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
    if normalized.iter().any(|segment| segment == ".env") {
        return PathClass::Secret;
    }
    let basename = normalized.last().map(String::as_str).unwrap_or("");
    if basename.ends_with(".env") || basename.starts_with(".env.") {
        return PathClass::Secret;
    }
    PathClass::Tracked
}
