//! Cross-platform engine path policy: tracked, ignored, or secret.
//!
//! This is deliberately distinct from [`crate::floor`]. The scan floor asks
//! whether a real on-disk entry participates in a local scan and therefore
//! applies case/trailing-alias folding only on Windows. This module ports the
//! relay-facing TypeScript security contract (`enginePathFloor.ts` plus Check A
//! in `paths.ts`): every platform strips Win32 trailing aliases and folds case
//! for reserved comparisons. That intentional non-parity makes classification
//! stable across peers, so a POSIX relay and a Windows desktop cannot disagree
//! about which path contains secret material.
//!
//! Only Check A lives here: absolute/traversal/NUL rejection, stable percent
//! decoding, ignored/reserved segments, and reserved 8.3 aliases. NTFS ADS,
//! device basenames, and generic 8.3-shaped materialization hazards are Check B
//! concerns at actual disk-write sinks and are intentionally out of scope,
//! except for the win32-only read ADS-colon floor matching
//! `validateUserReadPath`.

/// The security disposition of a workspace-relative file path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathClassification {
    /// Ordinary workspace content.
    Tracked,
    /// Invalid, reserved, or ignored engine/system content.
    Ignored,
    /// Content that must be routed only through the encrypted secret store.
    Secret,
}

const DOHC_SHORT_NAME_STEM: &str = "DOHC";
const SHARED_WITH_ME_SHORT_NAME_STEM: &str = "SHARED";

/// Maximum UTF-8 byte length of one canonical workspace-relative path.
pub const MAX_CANONICAL_WORKSPACE_PATH_BYTES: usize = 1_024;

/// Return whether a canonical workspace path meets the shared byte and
/// character bounds. Structural canonicalization remains the caller's job.
pub fn canonical_workspace_path_meets_shared_bounds(path: &str) -> bool {
    path.len() <= MAX_CANONICAL_WORKSPACE_PATH_BYTES
        && !path.bytes().any(|byte| byte.is_ascii_control())
}

/// Classify a write/capture path using the platform-independent Check-A floor.
pub fn classify_engine_file_path(path: &str) -> PathClassification {
    classify_engine_file_path_normalized(path).0
}

/// Classify a write/capture path and return the canonical relative path used
/// for durable keys. Invalid, reserved, and ignored paths have no normalized
/// form because callers must not address or persist them.
pub fn classify_engine_file_path_normalized(path: &str) -> (PathClassification, Option<String>) {
    let Some(normalized) = validate_workspace_path(path, ReservedMode::Write) else {
        return (PathClassification::Ignored, None);
    };
    // Kept as a separate check to mirror the TS classifier's own guard even
    // though validation also rejects ignored segments by default.
    if has_ignored_segment(path) {
        return (PathClassification::Ignored, None);
    }
    (classify_normalized_secret(&normalized), Some(normalized))
}

/// Read-side classification. `shared-with-me` is readable, then classified
/// relative to its mount: a secret-shaped label taints the whole mount;
/// otherwise the remainder is recursively classified by the write floor.
pub fn classify_engine_file_path_for_read(path: &str) -> PathClassification {
    let Some(candidate) = validate_workspace_path(path, ReservedMode::Read) else {
        return PathClassification::Ignored;
    };
    if has_ignored_segment(path) {
        return PathClassification::Ignored;
    }
    #[cfg(windows)]
    if candidate.split('/').any(|segment| segment.contains(':')) {
        return PathClassification::Ignored;
    }
    if is_shared_with_me_path(&candidate) {
        let segments: Vec<&str> = candidate.split('/').collect();
        if segments.len() == 1 {
            return PathClassification::Tracked;
        }
        let label = segments.get(1).copied().unwrap_or_default();
        if segments.len() == 2 {
            return classify_engine_file_path(label);
        }
        if classify_engine_file_path(label) == PathClassification::Secret {
            return PathClassification::Secret;
        }
        return classify_engine_file_path(&segments[2..].join("/"));
    }
    classify_engine_file_path(&candidate)
}

#[derive(Clone, Copy)]
enum ReservedMode {
    Write,
    Read,
}

fn validate_workspace_path(path: &str, mode: ReservedMode) -> Option<String> {
    if path.bytes().any(|byte| byte.is_ascii_control()) || is_absolute_path_like(path) {
        return None;
    }
    let decoded = decode_until_stable(path);
    if is_absolute_path_like(&decoded) {
        return None;
    }
    let segments: Vec<&str> = decoded.split(['/', '\\']).collect();
    for segment in &segments {
        if segment.is_empty() || *segment == "." {
            continue;
        }
        if *segment == ".."
            || segment
                .chars()
                .all(|character| character == '.' || character == ' ')
        {
            return None;
        }
    }
    let normalized = segments
        .into_iter()
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        return None;
    }
    if !canonical_workspace_path_meets_shared_bounds(&normalized) {
        return None;
    }
    let reserved = match mode {
        ReservedMode::Write => is_reserved_path(&normalized),
        ReservedMode::Read => is_dohc_metadata_path(&normalized),
    };
    if reserved || has_ignored_segment(&normalized) {
        return None;
    }
    Some(normalized)
}

fn is_absolute_path_like(path: &str) -> bool {
    if path.starts_with('/') || path.starts_with("\\\\") {
        return true;
    }
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

fn decode_until_stable(path: &str) -> String {
    let mut decoded = path.to_owned();
    loop {
        let next = decode_one_pass(&decoded);
        if next == decoded {
            return decoded;
        }
        decoded = next;
    }
}

fn decode_one_pass(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = String::with_capacity(path.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let pair = [
                bytes[index + 1].to_ascii_lowercase(),
                bytes[index + 2].to_ascii_lowercase(),
            ];
            let replacement = match pair {
                [b'2', b'5'] => Some('%'),
                [b'2', b'e'] => Some('.'),
                [b'2', b'f'] => Some('/'),
                [b'5', b'c'] => Some('\\'),
                _ => None,
            };
            if let Some(replacement) = replacement {
                out.push(replacement);
                index += 3;
                continue;
            }
        }
        let Some(character) = path[index..].chars().next() else {
            break;
        };
        out.push(character);
        index += character.len_utf8();
    }
    out
}

fn strip_windows_alias_suffix(segment: &str) -> &str {
    segment.trim_end_matches(['.', ' '])
}

fn is_reserved_83_alias(segment: &str, stem: &str) -> bool {
    let Some((base, digits)) = segment.rsplit_once('~') else {
        return false;
    };
    if base.is_empty()
        || base.len() > 8
        || !base.bytes().all(|byte| byte.is_ascii_alphanumeric())
        || digits.is_empty()
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }
    let Some(width) = 7usize.checked_sub(digits.len()) else {
        return false;
    };
    let base_len = stem.len().min(width);
    base_len >= 1 && base.eq_ignore_ascii_case(&stem[..base_len])
}

fn normalized_segments(path: &str) -> impl Iterator<Item = String> + '_ {
    path.split(['/', '\\'])
        .map(strip_windows_alias_suffix)
        .map(str::to_lowercase)
}

fn is_dohc_metadata_path(path: &str) -> bool {
    normalized_segments(path)
        .any(|segment| segment == ".dohc" || is_reserved_83_alias(&segment, DOHC_SHORT_NAME_STEM))
}

fn is_shared_with_me_path(path: &str) -> bool {
    normalized_segments(path).next().is_some_and(|segment| {
        segment == "shared-with-me"
            || is_reserved_83_alias(&segment, SHARED_WITH_ME_SHORT_NAME_STEM)
    })
}

fn is_reserved_path(path: &str) -> bool {
    is_dohc_metadata_path(path) || is_shared_with_me_path(path)
}

fn has_ignored_segment(path: &str) -> bool {
    normalized_segments(path).any(|segment| {
        matches!(segment.as_str(), ".dohc" | ".git" | "node_modules")
            || segment.starts_with(".dohc-write-")
    })
}

/// THE secret-path rule. `path` must already be normalized: relative,
/// slash-separated, with `.`, `..`, and percent-encoding resolved.
///
/// Exported so the share boundary reuses this rule instead of restating it.
/// `dohc_engine_sync::classify_share_path` decides which relayed ops may
/// replay, and `replay_share_delete` carries no floor of its own, so a delete
/// of secret material is refused only while the boundary and this floor name
/// the same secrets. They did, in two copies, by coincidence — a class added
/// here alone made deletes of it replayable (#484). One rule, one place, so a
/// new class reaches both callers at once.
///
/// The search floor (`search_policy.rs`) reads the same rule through
/// [`segments_are_secret`], keeping its own per-platform normalization
/// (#543): a class added there reaches search too.
pub fn normalized_path_is_secret(path: &str) -> bool {
    let segments: Vec<String> = path
        .split('/')
        .map(strip_windows_alias_suffix)
        .map(str::to_lowercase)
        .collect();
    segments_are_secret(&segments)
}

/// THE secret-segment rule, over segments the caller already normalized
/// (lowercased, with its own platform's alias folding applied). Add a new
/// secret class HERE, never in a caller: [`normalized_path_is_secret`] and the
/// search floor both read this rule, so one edit reaches the write floor, the
/// share boundary, and search at once.
pub fn segments_are_secret<S: AsRef<str>>(segments: &[S]) -> bool {
    let basename = segments.last().map(AsRef::as_ref).unwrap_or_default();
    segments.iter().any(|segment| segment.as_ref() == ".env")
        || basename.ends_with(".env")
        || basename.starts_with(".env.")
}

fn classify_normalized_secret(path: &str) -> PathClassification {
    if normalized_path_is_secret(path) {
        PathClassification::Secret
    } else {
        PathClassification::Tracked
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_cases(expected: PathClassification, paths: &[&str]) {
        for path in paths {
            assert_eq!(classify_engine_file_path(path), expected, "{path}");
        }
    }

    #[test]
    fn workspace_search_golden_tracks_ordinary_and_check_a_host_legal_names() {
        assert_cases(
            PathClassification::Tracked,
            &[
                "notes/today.md",
                "environment.md",
                "report~1.pdf",
                "notes/meeting 9:30.md",
                "con.py",
                "DOHC~1.md",
            ],
        );
    }

    #[test]
    fn workspace_search_golden_secret_family_at_any_depth_and_case() {
        assert_cases(
            PathClassification::Secret,
            &[
                ".env",
                "config/.ENV",
                "apps/site/.env/local",
                "deploy/prod.env",
                ".env.local",
                ".env.production",
                "apps/site/.env.development",
                "config/.ENV.LOCAL",
                ".env.example",
                "secrets/.env",
            ],
        );
        assert_cases(
            PathClassification::Tracked,
            &["notes/envelope.md", "environments.md"],
        );
    }

    #[test]
    fn workspace_search_golden_windows_aliases_are_platform_independent() {
        assert_cases(
            PathClassification::Secret,
            &[
                ".env ",
                ".env.",
                ".ENV ",
                "secret.env ",
                "secret.env.",
                "config/.env ",
                "deploy/prod.env ",
                ".env.local ",
                "apps/site/.env /local.md",
            ],
        );
        assert_eq!(
            classify_engine_file_path("notes/today.md "),
            PathClassification::Tracked
        );
    }

    #[test]
    fn workspace_search_golden_decodes_percent_disguises_until_stable() {
        assert_cases(
            PathClassification::Secret,
            &[
                "secrets%2eenv",
                "secrets%252eenv",
                "config%2f.env",
                "%2eenv",
            ],
        );
        assert_cases(
            PathClassification::Ignored,
            &["%2fetc/passwd", "%252fetc/passwd", "a%2f..%2fb.md"],
        );
    }

    #[test]
    fn workspace_search_golden_ignores_invalid_reserved_and_ignored_paths() {
        assert_cases(
            PathClassification::Ignored,
            &[
                ".dohc/engine/engine.db",
                "node_modules/pkg/index.js",
                ".git/HEAD",
                ".dohc-write-1.tmp",
                "../outside.md",
                "a/.../b.md",
                "a/   /b.md",
                "C:\\outside.md",
                "\\\\server\\share",
                "",
            ],
        );
    }

    #[test]
    fn canonical_workspace_paths_enforce_the_shared_utf8_ceiling() {
        let exact_ascii = "a".repeat(1_024);
        assert_eq!(
            classify_engine_file_path_normalized(&exact_ascii),
            (PathClassification::Tracked, Some(exact_ascii.clone()))
        );

        let exact_multibyte = "é".repeat(512);
        assert_eq!(exact_multibyte.len(), 1_024);
        assert_eq!(
            classify_engine_file_path_normalized(&exact_multibyte),
            (PathClassification::Tracked, Some(exact_multibyte.clone()))
        );

        for over_limit in ["a".repeat(1_025), "é".repeat(513)] {
            assert_eq!(
                classify_engine_file_path_normalized(&over_limit),
                (PathClassification::Ignored, None),
                "canonical paths over the 1,024-byte UTF-8 limit must be refused"
            );
            assert_eq!(
                classify_engine_file_path_for_read(&over_limit),
                PathClassification::Ignored
            );
        }

        for byte in (0_u8..=31).chain(std::iter::once(127)) {
            let control_path = format!("notes/a{}b.md", char::from(byte));
            assert_eq!(
                classify_engine_file_path_normalized(&control_path),
                (PathClassification::Ignored, None),
                "ASCII control byte 0x{byte:02x} must be refused"
            );
            assert_eq!(
                classify_engine_file_path_for_read(&control_path),
                PathClassification::Ignored,
                "read ingress must refuse ASCII control byte 0x{byte:02x}"
            );
        }
    }

    #[test]
    fn reserved_83_aliases_are_ignored_but_generic_shapes_are_tracked() {
        assert_cases(
            PathClassification::Ignored,
            &[
                "DOHC~1",
                "dohc~1",
                "notes/DOHC~1/x.md",
                "DOHC~100",
                "SHARED~1/x.md",
            ],
        );
        assert_cases(
            PathClassification::Tracked,
            &["report~1.pdf", "DOHC~1.md", "OTHER~1/x.md"],
        );
        assert_cases(
            PathClassification::Secret,
            &["SECRET~1.ENV", "config/PRODUC~1.ENV"],
        );
    }

    #[test]
    fn read_side_shared_mount_recursion_matches_the_ts_oracle() {
        assert_eq!(
            classify_engine_file_path("shared-with-me/alex/.env"),
            PathClassification::Ignored
        );
        assert_cases_read(
            PathClassification::Secret,
            &[
                "shared-with-me/alex/.env",
                "shared-with-me/alex/config/prod.env",
                "shared-with-me/alex/%2eenv",
                "shared-with-me/alex/prod.env ",
                "Shared-With-Me/alex/.env",
                "shared-with-me/.env",
                "shared-with-me/prod.env",
                "shared-with-me/.env/notes.md",
            ],
        );
        assert_cases_read(
            PathClassification::Tracked,
            &[
                "shared-with-me",
                "shared-with-me/alex",
                "shared-with-me/alex/brief.md",
                "SHARED~1/alex/brief.md",
            ],
        );
        assert_cases_read(
            PathClassification::Ignored,
            &[".dohc/engine/engine.db", "../escape.md"],
        );
    }

    #[cfg(windows)]
    #[test]
    fn read_side_rejects_win32_ads_colons_before_shared_mount_recursion() {
        assert_cases_read(
            PathClassification::Ignored,
            &[
                ".env::$DATA",
                "notes/a:b.md",
                "shared-with-me/alex/.env::$DATA",
            ],
        );
    }

    fn assert_cases_read(expected: PathClassification, paths: &[&str]) {
        for path in paths {
            assert_eq!(classify_engine_file_path_for_read(path), expected, "{path}");
        }
    }
}
