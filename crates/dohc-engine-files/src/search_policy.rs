//! Shared search visibility policy: the path floor, the `.dohc/*.toml` rule parser,
//! the effective-policy resolver, and the **fail-closed** policy reader.
//!
//! Ports `enginePathFloor.ts` (the `tracked`/`ignored`/`secret` floor),
//! `effectivePolicy.ts` (glob validation + matching, TOML rule parsing,
//! effective-policy resolution), and `searchIndex.ts`'s
//! `readEngineSearchPolicySync` / `pathIsSearchIndexed`.
//!
//! The `effectivePolicy.ts` half is held to that claim by
//! `tests/effective_policy.rs`, which asserts this port against a fixture
//! regenerated from the live TypeScript oracle and drift-checked by the Rust
//! gate. TypeScript is canonical: a disagreement is fixed here.
//!
//! ## The fail-closed contract (the hotfix this shard must preserve)
//!
//! An **absent** `.dohc/files.toml` / `.dohc/visibility.toml` is a valid
//! configuration: defaults apply (index normally). A policy file that **exists
//! but cannot be read or parsed** must NEVER widen search — it fails CLOSED: a
//! diagnostic is recorded and, while it is present, no FILE is searchable
//! (`path_is_search_indexed` returns `false`, the query path returns an empty —
//! not `None` — result so the caller cannot fall back to an unfiltered scan).
//! This is scoped to FILE search: a broken FILE policy never disables chat
//! search (chat visibility is not governed by these files) — see `index.rs` and
//! `query.rs` for how the scoping is carried through.
//!
//! ## The path floor and the Rust engine's per-platform posture
//!
//! The reserved/ignored/secret segment comparison uses the SAME per-platform
//! normalization as the sibling scan floor (`dohc_engine_files::floor`): on
//! Windows, Win32 strips trailing dots/spaces and NTFS folds case, so `.DOHC`
//! and `.dohc ` alias `.dohc`; on case-sensitive POSIX only the exact segment
//! is the floor. This keeps capture and search CONSISTENT within the Rust
//! engine (the TS engine lowercases unconditionally — a platform bug the Rust
//! engine corrects, recorded in `BEHAVIOR_DELTA.md` CAL-3). The `.env` secret
//! family is classified on the DECODED path so a percent-encoded `secrets%2eenv`
//! cannot slip through as tracked.

use std::path::Path;

/// The desktop policy reader's cap (`MAX_WORKSPACE_SETTINGS_FILE_BYTES`, 256
/// KiB). A file the desktop accepts and applies must not be treated as broken
/// here, or search would silently pause on a policy both layers consider valid.
pub const POLICY_FILE_MAX_BYTES: u64 = 256 * 1024;

/// Reserved directory/segment names, matched per-platform at any depth. Mirrors
/// `dohc_engine_files::floor::RESERVED_SEGMENTS` and `paths.ts`
/// `IGNORED_SEGMENTS`; kept in lockstep by `floor_parity` tests.
const RESERVED_SEGMENTS: &[&str] = &[".dohc", ".git", "node_modules"];

/// Write-temp file prefixes: in-progress `.dohc-write-*` staging is engine
/// scratch, never user content.
const IGNORED_FILE_PREFIXES: &[&str] = &[".dohc-write-"];

/// The shared-with-me projection root: a WRITE reservation that classifies as
/// non-tracked for the write-side floor search uses.
const SHARED_WITH_ME_ROOT: &str = "shared-with-me";

/// The path floor a search-visibility decision starts from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathFloor {
    /// Ordinary workspace content the engine owns.
    Tracked,
    /// Engine-internal / reserved / traversal / absolute — never searchable.
    Ignored,
    /// The `.env` secret family — never searchable, never surfaced.
    Secret,
}

/// Normalize a single path segment for reserved/ignored/secret comparison,
/// per platform (see module docs). Mirrors `dohc_engine_files::floor`.
fn normalize_segment(segment: &str) -> String {
    #[cfg(windows)]
    {
        segment.trim_end_matches(['.', ' ']).to_lowercase()
    }
    #[cfg(not(windows))]
    {
        segment.to_owned()
    }
}

/// Decode percent-encoded dots/separators until stable, matching
/// `validateUserWritePath` (`paths.ts`): `%2e`→`.`, `%2f`→`/`, `%5c`→`\`,
/// `%25`→`%`, case-insensitive, so double-encoding (`%252e`→`%2e`→`.`) cannot
/// slip an encoded `.env` / `.dohc` past the floor.
fn percent_decode_stable(input: &str) -> String {
    let mut decoded = input.to_owned();
    loop {
        let next = replace_ci(&decoded, "%25", "%");
        let next = replace_ci(&next, "%2e", ".");
        let next = replace_ci(&next, "%2f", "/");
        let next = replace_ci(&next, "%5c", "\\");
        if next == decoded {
            return decoded;
        }
        decoded = next;
    }
}

/// Case-insensitive literal replace (the needle is ASCII).
fn replace_ci(haystack: &str, needle_lower: &str, replacement: &str) -> String {
    let hay_lower = haystack.to_ascii_lowercase();
    let mut out = String::with_capacity(haystack.len());
    let mut idx = 0usize;
    while idx < haystack.len() {
        if hay_lower[idx..].starts_with(needle_lower) {
            out.push_str(replacement);
            idx = idx.saturating_add(needle_lower.len());
        } else {
            // Advance one full UTF-8 char to never split a multibyte boundary.
            let ch = haystack[idx..].chars().next().unwrap_or('\u{FFFD}');
            out.push(ch);
            idx = idx.saturating_add(ch.len_utf8());
        }
    }
    out
}

/// POSIX absolute, Windows drive-qualified (`C:\`/`C:/`), or UNC (`\\server`).
/// Ports `isAbsolutePathLike` (`paths.ts`) — NOT `Path::is_absolute`.
fn is_absolute_path_like(path: &str) -> bool {
    if path.starts_with('/') || path.starts_with("\\\\") {
        return true;
    }
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// Whether a normalized (forward-slash) path has ANY reserved/ignored segment.
fn has_ignored_segment(rel_path: &str) -> bool {
    rel_path.split('/').any(|segment| {
        let normalized = normalize_segment(segment);
        RESERVED_SEGMENTS.contains(&normalized.as_str())
            || IGNORED_FILE_PREFIXES
                .iter()
                .any(|prefix| normalized.starts_with(prefix))
    })
}

/// The engine path floor. Ports `classifyEngineFilePath` (`enginePathFloor.ts`)
/// with the security-relevant write-admission subset of `validateUserWritePath`
/// (`paths.ts`): null-byte / absolute / traversal / reserved / ignored paths are
/// `Ignored`; the `.env` family is `Secret`; everything else is `Tracked`.
///
/// The Windows host-unsafe admission checks (ADS colon, device names, 8.3
/// aliases) are intentionally NOT re-litigated here: those reject a path at the
/// WRITE gate (a separate path shard, `LANGUAGE_SEMANTICS_MATRIX.md` 7.x), so a
/// stored snapshot path has already cleared them. Re-running them would only
/// hide MORE (the fail-closed-safe direction); omitting them never surfaces a
/// secret, because the secret/ignored classification below is independent.
pub fn classify_engine_file_path(path: &str) -> PathFloor {
    if path.contains('\0') || is_absolute_path_like(path) {
        return PathFloor::Ignored;
    }
    let decoded = percent_decode_stable(path);
    if is_absolute_path_like(&decoded) {
        return PathFloor::Ignored;
    }
    let forward = decoded.replace('\\', "/");
    // Reject traversal / dots-only segments; collect the kept segments.
    let mut kept: Vec<&str> = Vec::new();
    for segment in forward.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return PathFloor::Ignored;
        }
        if segment.chars().all(|c| c == '.' || c == ' ') {
            // Dots/spaces-only segment: a Win32 `..`/`.` alias, rejected.
            return PathFloor::Ignored;
        }
        kept.push(segment);
    }
    if kept.is_empty() {
        return PathFloor::Ignored;
    }
    let normalized = kept.join("/");
    // Reserved: `.dohc` at any depth OR the `shared-with-me` projection root.
    let first_norm = normalize_segment(kept[0]);
    if first_norm == SHARED_WITH_ME_ROOT || has_ignored_segment(&normalized) {
        return PathFloor::Ignored;
    }
    // Secret: the shared rule (`policy::segments_are_secret`), over search's
    // per-platform normalization (see module docs). Search deliberately does
    // NOT call `normalized_path_is_secret`, which folds Win32 aliases on every
    // platform — only the rule is shared, so a class added to it reaches
    // search without importing the relay-facing normalization.
    let normalized_segments: Vec<String> = kept
        .iter()
        .map(|s| normalize_segment(s).to_ascii_lowercase())
        .collect();
    if crate::policy::segments_are_secret(&normalized_segments) {
        return PathFloor::Secret;
    }
    PathFloor::Tracked
}

// ------------------------------------------------------------------ glob rules

/// A `.dohc/files.toml` rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilesPolicyRule {
    pub path: String,
    pub tracked: Option<bool>,
    pub searchable: Option<bool>,
}

/// A `.dohc/visibility.toml` rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisibilityPolicyRule {
    pub path: String,
    pub visibility: Option<Visibility>,
    pub export: Option<Export>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    Visible,
    Hidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Export {
    Included,
    Excluded,
    Redacted,
}

/// Validate the intentionally small policy glob subset (`validatePolicyGlob`,
/// `effectivePolicy.ts`). Returns the failure reason on rejection.
pub fn validate_policy_glob(pattern: &str) -> Result<(), String> {
    if pattern.is_empty() {
        return Err("glob must not be empty".to_owned());
    }
    if pattern.starts_with('/') {
        return Err("glob must be workspace-relative, without a leading slash".to_owned());
    }
    if pattern.starts_with('!') {
        return Err("glob negation is not supported".to_owned());
    }
    if pattern.contains('\\') {
        return Err("glob backslash escapes are not supported".to_owned());
    }
    if pattern.contains(['?', '[', '{', ']', '}']) {
        return Err("glob character classes, braces, and ? are not supported".to_owned());
    }
    let segments: Vec<&str> = pattern.split('/').collect();
    for (index, segment) in segments.iter().enumerate() {
        if segment.is_empty() {
            return Err("glob must not contain empty path segments".to_owned());
        }
        if *segment == ".." {
            return Err("glob must not contain .. segments".to_owned());
        }
        if *segment == "**" {
            if index != segments.len().saturating_sub(1) {
                return Err("** is only supported as the final segment".to_owned());
            }
            continue;
        }
        if segment.contains("**") {
            return Err("** must occupy a complete final segment".to_owned());
        }
        if segment.chars().filter(|c| *c == '*').count() > 1 {
            return Err("only one * is supported per path segment".to_owned());
        }
    }
    Ok(())
}

fn segment_matches(pattern_segment: &str, path_segment: &str) -> bool {
    match pattern_segment.find('*') {
        None => pattern_segment == path_segment,
        Some(star) => {
            let prefix = &pattern_segment[..star];
            let suffix = &pattern_segment[star.saturating_add(1)..];
            path_segment.len() >= prefix.len().saturating_add(suffix.len())
                && path_segment.starts_with(prefix)
                && path_segment.ends_with(suffix)
        }
    }
}

/// Match a policy glob that already passed [`validate_policy_glob`]. Ports
/// `policyGlobMatches` (`effectivePolicy.ts`).
pub fn policy_glob_matches(pattern: &str, path: &str) -> bool {
    if pattern == "**" {
        return !path.is_empty();
    }
    let pattern_segments: Vec<&str> = pattern.split('/').collect();
    let path_segments: Vec<&str> = path.split('/').collect();
    let final_pattern = pattern_segments.last().copied().unwrap_or("");
    if final_pattern == "**" {
        let prefix = &pattern_segments[..pattern_segments.len().saturating_sub(1)];
        if path_segments.len() <= prefix.len() {
            return false;
        }
        return prefix.iter().enumerate().all(|(index, segment)| {
            segment_matches(segment, path_segments.get(index).copied().unwrap_or(""))
        });
    }
    if pattern_segments.len() != path_segments.len() {
        return false;
    }
    pattern_segments.iter().enumerate().all(|(index, segment)| {
        segment_matches(segment, path_segments.get(index).copied().unwrap_or(""))
    })
}

// ------------------------------------------------------------------ toml parse

/// The key order the oracle reports one unknown-key error per key in.
///
/// The oracle walks `Object.keys` of the parsed table, so its order is JavaScript
/// property enumeration order (`OrdinaryOwnPropertyKeys`): every ARRAY INDEX key
/// first in ascending numeric order, then every remaining key in insertion order.
/// TOML allows bare integer keys, so a policy file can reach that rule, and the
/// first error is what a user's agent reads back from a rejected policy file.
fn js_property_order(table: &toml::Table) -> Vec<&str> {
    let mut indexed: Vec<(u32, &str)> = Vec::new();
    let mut named: Vec<&str> = Vec::new();
    for key in table.keys() {
        match array_index(key) {
            // Duplicate keys cannot reach here: TOML rejects them as a syntax
            // error, so no two entries share an index and the sort is total.
            Some(index) => indexed.push((index, key.as_str())),
            None => named.push(key.as_str()),
        }
    }
    indexed.sort_unstable_by_key(|(index, _)| *index);
    indexed
        .into_iter()
        .map(|(_, key)| key)
        .chain(named)
        .collect()
}

/// A JavaScript ARRAY INDEX: the canonical decimal form of an integer in
/// `0..=4294967294`. A key that does not round-trip through `ToString(ToUint32)`
/// — `01`, `+1`, `1.0`, `-1` — is an ordinary string key, and so is `4294967295`,
/// which is one past the last index.
fn array_index(key: &str) -> Option<u32> {
    if key.starts_with('+') || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    let index: u32 = key.parse().ok()?;
    if index == u32::MAX { None } else { Some(index) }
}

/// Parse `.dohc/files.toml`. Collects ALL shape errors in one pass (never a
/// partial application), matching `parseFilesPolicy` (`effectivePolicy.ts`).
pub fn parse_files_policy(toml_text: &str) -> Result<Vec<FilesPolicyRule>, Vec<String>> {
    let value = match toml_text.parse::<toml::Table>() {
        Ok(table) => table,
        Err(err) => return Err(vec![format!("invalid TOML: {err}")]),
    };
    let mut errors: Vec<String> = Vec::new();
    let rule_value = validate_top_level(&value, &mut errors);
    let mut rules: Vec<FilesPolicyRule> = Vec::new();
    if let Some(toml::Value::Array(array)) = rule_value {
        for (index, entry) in array.iter().enumerate() {
            let label = format!("rule {}", index.saturating_add(1));
            let Some(rule) = entry.as_table() else {
                errors.push(format!("{label}: rule entry must be an object"));
                continue;
            };
            for key in js_property_order(rule) {
                if !matches!(key, "path" | "tracked" | "searchable") {
                    errors.push(format!("{label}: unknown key: {key}"));
                }
            }
            let path = validate_rule_path(rule, &label, &mut errors);
            let tracked =
                validate_optional_bool(rule.get("tracked"), &label, "tracked", &mut errors);
            let searchable =
                validate_optional_bool(rule.get("searchable"), &label, "searchable", &mut errors);
            if let (Some(path), Ok(tracked), Ok(searchable)) = (path, tracked, searchable) {
                rules.push(FilesPolicyRule {
                    path,
                    tracked,
                    searchable,
                });
            }
        }
    }
    if errors.is_empty() {
        Ok(rules)
    } else {
        Err(errors)
    }
}

/// Parse `.dohc/visibility.toml` (`parseVisibilityPolicy`).
pub fn parse_visibility_policy(toml_text: &str) -> Result<Vec<VisibilityPolicyRule>, Vec<String>> {
    let value = match toml_text.parse::<toml::Table>() {
        Ok(table) => table,
        Err(err) => return Err(vec![format!("invalid TOML: {err}")]),
    };
    let mut errors: Vec<String> = Vec::new();
    let rule_value = validate_top_level(&value, &mut errors);
    let mut rules: Vec<VisibilityPolicyRule> = Vec::new();
    if let Some(toml::Value::Array(array)) = rule_value {
        for (index, entry) in array.iter().enumerate() {
            let label = format!("rule {}", index.saturating_add(1));
            let Some(rule) = entry.as_table() else {
                errors.push(format!("{label}: rule entry must be an object"));
                continue;
            };
            for key in js_property_order(rule) {
                if !matches!(key, "path" | "visibility" | "export") {
                    errors.push(format!("{label}: unknown key: {key}"));
                }
            }
            let path = validate_rule_path(rule, &label, &mut errors);
            let visibility = match rule.get("visibility") {
                None => Ok(None),
                Some(toml::Value::String(s)) if s == "visible" => Ok(Some(Visibility::Visible)),
                Some(toml::Value::String(s)) if s == "hidden" => Ok(Some(Visibility::Hidden)),
                Some(_) => {
                    errors.push(format!(
                        "{label}: visibility must be \"visible\" or \"hidden\""
                    ));
                    Err(())
                }
            };
            let export = match rule.get("export") {
                None => Ok(None),
                Some(toml::Value::String(s)) if s == "included" => Ok(Some(Export::Included)),
                Some(toml::Value::String(s)) if s == "excluded" => Ok(Some(Export::Excluded)),
                Some(toml::Value::String(s)) if s == "redacted" => Ok(Some(Export::Redacted)),
                Some(_) => {
                    errors.push(format!(
                        "{label}: export must be \"included\", \"excluded\", or \"redacted\""
                    ));
                    Err(())
                }
            };
            if let (Some(path), Ok(visibility), Ok(export)) = (path, visibility, export) {
                rules.push(VisibilityPolicyRule {
                    path,
                    visibility,
                    export,
                });
            }
        }
    }
    if errors.is_empty() {
        Ok(rules)
    } else {
        Err(errors)
    }
}

fn validate_top_level<'a>(
    parsed: &'a toml::Table,
    errors: &mut Vec<String>,
) -> Option<&'a toml::Value> {
    for key in js_property_order(parsed) {
        if key != "rule" {
            errors.push(format!("unknown top-level key: {key}"));
        }
    }
    if parsed.len() != 1 || !parsed.contains_key("rule") {
        errors.push("policy must contain exactly one top-level key: rule".to_owned());
    }
    // An ABSENT `rule` key also earns this error, not only a present non-array
    // one: the oracle tests `Array.isArray(parsed.rule)`, so an empty policy
    // file reports both the missing top-level key AND the array shape.
    let rule = parsed.get("rule");
    if !rule.is_some_and(|value| value.is_array()) {
        errors.push("rule must be an array of tables".to_owned());
    }
    rule
}

fn validate_rule_path(rule: &toml::Table, label: &str, errors: &mut Vec<String>) -> Option<String> {
    match rule.get("path") {
        Some(toml::Value::String(path)) if !path.is_empty() => match validate_policy_glob(path) {
            Ok(()) => Some(path.clone()),
            Err(reason) => {
                errors.push(format!("{label}: invalid path glob \"{path}\": {reason}"));
                None
            }
        },
        _ => {
            errors.push(format!(
                "{label}: path is required and must be a non-empty string"
            ));
            None
        }
    }
}

fn validate_optional_bool(
    value: Option<&toml::Value>,
    label: &str,
    field: &str,
    errors: &mut Vec<String>,
) -> Result<Option<bool>, ()> {
    match value {
        None => Ok(None),
        Some(toml::Value::Boolean(b)) => Ok(Some(*b)),
        Some(_) => {
            errors.push(format!("{label}: {field} must be a boolean"));
            Err(())
        }
    }
}

// -------------------------------------------------------------- effective policy

/// The resolved effective policy for a path (`resolveEffectivePolicy`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectivePolicy {
    pub tracked: bool,
    pub searchable: bool,
    pub visibility: Visibility,
    pub export: Export,
    pub floor: PathFloor,
}

/// Resolve the effective policy for `path` under the given rule sets. Ports
/// `resolveEffectivePolicy` (`effectivePolicy.ts`): the floor short-circuits to
/// fully untracked/hidden when it is not `Tracked`; otherwise last-matching-rule
/// wins per field, files rules then visibility rules, in array order.
pub fn resolve_effective_policy(
    path: &str,
    files_policy: Option<&[FilesPolicyRule]>,
    visibility_policy: Option<&[VisibilityPolicyRule]>,
) -> EffectivePolicy {
    let floor = classify_engine_file_path(path);
    if floor != PathFloor::Tracked {
        return EffectivePolicy {
            tracked: false,
            searchable: false,
            visibility: Visibility::Hidden,
            export: Export::Excluded,
            floor,
        };
    }
    let mut tracked = true;
    let mut searchable = true;
    let mut visibility = Visibility::Visible;
    let mut export = Export::Included;
    for rule in files_policy.unwrap_or(&[]) {
        if !policy_glob_matches(&rule.path, path) {
            continue;
        }
        if let Some(t) = rule.tracked {
            tracked = t;
        }
        if let Some(s) = rule.searchable {
            searchable = s;
        }
    }
    for rule in visibility_policy.unwrap_or(&[]) {
        if !policy_glob_matches(&rule.path, path) {
            continue;
        }
        if let Some(v) = rule.visibility {
            visibility = v;
        }
        if let Some(e) = rule.export {
            export = e;
        }
    }
    EffectivePolicy {
        tracked,
        searchable,
        visibility,
        export,
        floor,
    }
}

// ----------------------------------------------------------- fail-closed reader

/// A diagnostic recorded for a policy file that exists but cannot be read or
/// parsed. Its presence puts FILE search into the fail-closed freeze.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyDiagnostic {
    pub file: &'static str,
    pub reason: DiagnosticReason,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticReason {
    Unreadable,
    Invalid,
}

/// The read snapshot of both policy files. `diagnostics` is empty when both are
/// absent or valid; a non-empty `diagnostics` means FILE search must fail closed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchPolicySnapshot {
    pub files_policy: Option<Vec<FilesPolicyRule>>,
    pub visibility_policy: Option<Vec<VisibilityPolicyRule>>,
    pub diagnostics: Vec<PolicyDiagnostic>,
}

impl SearchPolicySnapshot {
    /// Whether FILE search must fail closed (a policy file is broken).
    pub fn is_degraded(&self) -> bool {
        !self.diagnostics.is_empty()
    }
}

enum PolicyRead<T> {
    Rules(Option<Vec<T>>),
    Broken(PolicyDiagnostic),
}

fn read_policy_file<T>(
    root_dir: &Path,
    file_name: &'static str,
    parse: impl FnOnce(&str) -> Result<Vec<T>, Vec<String>>,
) -> PolicyRead<T> {
    let broken = |reason: DiagnosticReason, detail: String| {
        PolicyRead::Broken(PolicyDiagnostic {
            file: file_name,
            reason,
            detail,
        })
    };
    let path = root_dir.join(".dohc").join(file_name);
    // `symlink_metadata` does NOT follow the final symlink, so a symlinked
    // policy file is rejected as unreadable (parity with the TS `lstatSync`
    // symlink refusal) rather than followed off-tree.
    //
    // TOCTOU: this is a stat-then-open double-open (a symlink could be swapped
    // in between), matching the TS `lstatSync`-then-`readFileSync` behavior. It
    // is NOT a leak vector — the bytes are only ever consumed AS policy, and a
    // non-TOML / oversize / non-file result fails CLOSED (a diagnostic that
    // freezes FILE search), never widens it. Left as-is for TS parity rather
    // than hardened to an open-by-handle read.
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(err) => {
            // Absent = defaults (no diagnostic). Anything else (EACCES/EIO/…) is
            // a policy file we may have failed to read: fail closed.
            if err.kind() == std::io::ErrorKind::NotFound {
                return PolicyRead::Rules(None);
            }
            return broken(DiagnosticReason::Unreadable, describe_io(&err));
        }
    };
    if meta.file_type().is_symlink() || !meta.file_type().is_file() {
        return broken(
            DiagnosticReason::Unreadable,
            "policy file must be a regular file".to_owned(),
        );
    }
    if meta.len() > POLICY_FILE_MAX_BYTES {
        return broken(
            DiagnosticReason::Unreadable,
            format!("policy file exceeds {POLICY_FILE_MAX_BYTES} bytes"),
        );
    }
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) => return broken(DiagnosticReason::Unreadable, describe_io(&err)),
    };
    // Non-UTF-8 content is MALFORMED (the user's file is bad), not an access
    // failure: consumers that hold on Unreadable (capture's unknown-policy
    // hold) must not stall forever on a byte-level typo — Invalid routes it
    // to the WS-F floor-only rule instead, same as a TOML parse error.
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => {
            return broken(
                DiagnosticReason::Invalid,
                "policy file is not valid UTF-8".to_owned(),
            );
        }
    };
    match parse(&text) {
        Ok(rules) => PolicyRead::Rules(Some(rules)),
        Err(errors) => broken(DiagnosticReason::Invalid, errors.join("; ")),
    }
}

fn describe_io(err: &std::io::Error) -> String {
    match err.raw_os_error() {
        Some(code) => format!("os error {code}"),
        None => err.kind().to_string(),
    }
}

/// Read `.dohc/files.toml` + `.dohc/visibility.toml` under `root_dir`,
/// fail-closed. Ports `readEngineSearchPolicySync` with the hotfix posture:
/// absent → defaults; exists-but-unreadable/invalid → diagnostic (FILE search
/// frozen), never a silent widen.
pub fn read_engine_search_policy(root_dir: &Path) -> SearchPolicySnapshot {
    let mut snapshot = SearchPolicySnapshot::default();
    match read_policy_file(root_dir, "files.toml", parse_files_policy) {
        PolicyRead::Rules(rules) => snapshot.files_policy = rules,
        PolicyRead::Broken(diag) => snapshot.diagnostics.push(diag),
    }
    match read_policy_file(root_dir, "visibility.toml", parse_visibility_policy) {
        PolicyRead::Rules(rules) => snapshot.visibility_policy = rules,
        PolicyRead::Broken(diag) => snapshot.diagnostics.push(diag),
    }
    snapshot
}

/// Whether `path` is search-indexed under `policy`. Ports `pathIsSearchIndexed`
/// (`searchIndex.ts`): a degraded policy fails CLOSED (`false`); otherwise the
/// path must be tracked AND searchable AND not hidden (the stricter answer of
/// `files.toml` and `visibility.toml` wins).
pub fn path_is_search_indexed(policy: &SearchPolicySnapshot, path: &str) -> bool {
    if policy.is_degraded() {
        return false;
    }
    let resolved = resolve_effective_policy(
        path,
        policy.files_policy.as_deref(),
        policy.visibility_policy.as_deref(),
    );
    resolved.tracked && resolved.searchable && resolved.visibility != Visibility::Hidden
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_classifies_env_secret_and_dohc_ignored() {
        assert_eq!(
            classify_engine_file_path("notes/plan.md"),
            PathFloor::Tracked
        );
        assert_eq!(classify_engine_file_path(".env"), PathFloor::Secret);
        assert_eq!(
            classify_engine_file_path("app/.env.local"),
            PathFloor::Secret
        );
        assert_eq!(
            classify_engine_file_path("config/db.env"),
            PathFloor::Secret
        );
        assert_eq!(
            classify_engine_file_path("secrets/.env/nested.md"),
            PathFloor::Secret
        );
        assert_eq!(
            classify_engine_file_path(".dohc/engine/x"),
            PathFloor::Ignored
        );
        assert_eq!(
            classify_engine_file_path("node_modules/p/i.js"),
            PathFloor::Ignored
        );
        assert_eq!(
            classify_engine_file_path("shared-with-me/a/brief.md"),
            PathFloor::Ignored
        );
    }

    #[test]
    fn floor_decodes_encoded_env_and_dohc() {
        // A percent-encoded `.env` must still classify secret, an encoded
        // `.dohc` still ignored — the encoded-bypass guard.
        assert_eq!(
            classify_engine_file_path("secrets%2eenv"),
            PathFloor::Secret
        );
        assert_eq!(classify_engine_file_path("%2edohc/x"), PathFloor::Ignored);
        assert_eq!(
            classify_engine_file_path("a%2f%2e%2e%2fb"),
            PathFloor::Ignored
        );
    }

    #[test]
    fn search_floor_reads_the_shared_secret_rule() {
        // Alias-free vectors (no trailing dots/spaces) inside both domains
        // (relative, no reserved segments): there search's per-platform
        // normalization reduces to lowercasing, the same as the shared
        // predicate's, so the search floor and `normalized_path_is_secret`
        // must agree exactly. A class added to either side alone fails here
        // on the vectors that carry it (#543, the #484 shape one surface
        // over).
        for path in [
            ".env",
            "app/.env.local",
            "config/db.env",
            "config/.ENV",
            "deploy/.env.production",
            "secrets/.env/nested.md",
            "notes/plan.md",
            "environments.md",
            "notes/envelope.md",
            "backup/env.bak",
        ] {
            assert_eq!(
                classify_engine_file_path(path) == PathFloor::Secret,
                crate::policy::normalized_path_is_secret(path),
                "search floor and the shared secret rule disagree for {path}"
            );
        }
    }

    #[test]
    fn floor_rejects_absolute_and_traversal() {
        assert_eq!(classify_engine_file_path("/etc/passwd"), PathFloor::Ignored);
        assert_eq!(classify_engine_file_path("C:/Windows"), PathFloor::Ignored);
        assert_eq!(classify_engine_file_path("a/../b"), PathFloor::Ignored);
    }

    #[test]
    fn glob_matches_port() {
        assert!(policy_glob_matches("**", "a/b"));
        assert!(!policy_glob_matches("**", ""));
        assert!(policy_glob_matches("dir/**", "dir/a/b"));
        assert!(!policy_glob_matches("dir/**", "dir"));
        assert!(policy_glob_matches("*.md", "notes.md"));
        assert!(!policy_glob_matches("*.md", "a/notes.md"));
    }

    #[test]
    fn files_policy_collects_all_errors() {
        let toml = "[[rule]]\npath = \"a.md\"\ntracked = \"nope\"\nbogus = 1\n";
        let err = parse_files_policy(toml).unwrap_err();
        assert!(err.iter().any(|e| e.contains("tracked must be a boolean")));
        assert!(err.iter().any(|e| e.contains("unknown key: bogus")));
    }

    #[test]
    fn non_array_rule_is_reported_once() {
        for errors in [
            parse_files_policy("rule = \"oops\"").unwrap_err(),
            parse_visibility_policy("rule = \"oops\"").unwrap_err(),
        ] {
            assert_eq!(errors, ["rule must be an array of tables"]);
        }
    }

    #[test]
    fn files_policy_valid() {
        let toml = "[[rule]]\npath = \"secret/**\"\nsearchable = false\n";
        let rules = parse_files_policy(toml).unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].searchable, Some(false));
    }

    #[test]
    fn visibility_hidden_overrides_searchable() {
        let files = vec![FilesPolicyRule {
            path: "notes/**".to_owned(),
            tracked: None,
            searchable: Some(true),
        }];
        let vis = vec![VisibilityPolicyRule {
            path: "notes/secret.md".to_owned(),
            visibility: Some(Visibility::Hidden),
            export: None,
        }];
        let snapshot = SearchPolicySnapshot {
            files_policy: Some(files),
            visibility_policy: Some(vis),
            diagnostics: Vec::new(),
        };
        assert!(path_is_search_indexed(&snapshot, "notes/plan.md"));
        assert!(!path_is_search_indexed(&snapshot, "notes/secret.md"));
    }

    #[test]
    fn degraded_policy_fails_closed() {
        let snapshot = SearchPolicySnapshot {
            files_policy: None,
            visibility_policy: None,
            diagnostics: vec![PolicyDiagnostic {
                file: "files.toml",
                reason: DiagnosticReason::Invalid,
                detail: "boom".to_owned(),
            }],
        };
        // Even a plainly-tracked path is not indexed while degraded.
        assert!(!path_is_search_indexed(&snapshot, "notes/plan.md"));
    }
}
