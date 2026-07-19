//! Extension → media-type mapping, ported byte-for-byte from the reference
//! accelerator (`crates/workspace-kernel/src/main.rs::media_type_for_path`) so
//! a CAL-3 scan listing is comparable to the accelerator's documented output in
//! the differential harness. The mapping is deliberately small and
//! extension-driven; unknown extensions are `application/octet-stream`.

/// The media type for a workspace-relative path, by its lowercased extension.
pub fn media_type_for_path(rel_path: &str) -> &'static str {
    let basename = rel_path.rsplit(['/', '\\']).next().unwrap_or(rel_path);
    let extension = basename
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "cjs" | "mjs" | "js" | "jsx" => "text/javascript",
        "cts" | "mts" | "ts" | "tsx" => "application/typescript",
        "csv" => "text/csv",
        "css" | "scss" => "text/css",
        "db" | "sqlite" | "sqlite3" => "application/vnd.sqlite3",
        "htm" | "html" => "text/html",
        "jpeg" | "jpg" => "image/jpeg",
        "json" => "application/json",
        "jsonl" | "ndjson" => "application/x-ndjson",
        "m4a" => "audio/mp4",
        "markdown" | "md" => "text/markdown",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "sh" | "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// The text/binary routing decision the capture pipeline makes BEFORE any
/// UTF-8 sniffing. Ports `isTextMediaType` (`packages/workspace-fs/src/metadata.ts`)
/// byte-for-byte, including its quirks (a `.ts` file outside a site source
/// tree routes as binary; `.js` routes as text): the differential harness
/// compares against the TS oracle, so the quirks are the contract.
pub fn is_text_media_type(media_type: &str, rel_path: &str) -> bool {
    if is_sqlite_media_type(media_type, rel_path) {
        return false;
    }
    let lower = format!("{media_type} {rel_path}").to_lowercase();
    lower.contains("text/")
        || lower.contains("json")
        || lower.contains("csv")
        || is_site_source_path(rel_path)
        || lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".sh")
        || lower.ends_with(".txt")
}

/// Ports `isSqliteMediaType` (`packages/workspace-fs/src/metadata.ts`).
fn is_sqlite_media_type(media_type: &str, rel_path: &str) -> bool {
    let media = media_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let basename = rel_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(rel_path)
        .to_lowercase();
    let extension = basename
        .rfind('.')
        .map(|index| &basename[index..])
        .unwrap_or_default();
    matches!(
        media.as_str(),
        "application/vnd.sqlite3"
            | "application/x-sqlite3"
            | "application/x-sqlite"
            | "application/sqlite3"
            | "application/sqlite"
            | "sqlite"
    ) || media.ends_with("+sqlite")
        || media.ends_with("/sqlite")
        || matches!(extension, ".sqlite" | ".sqlite3" | ".db")
}

/// Ports `isSiteSourcePath` (`packages/workspace-core/src/paths.ts`): a source
/// file at least two segments below a `sites` segment, with a site source-code
/// extension (`SITE_SOURCE_CODE_EXT_RE`).
fn is_site_source_path(rel_path: &str) -> bool {
    let normalized = rel_path.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    let Some(site_index) = segments
        .iter()
        .position(|segment| segment.eq_ignore_ascii_case("sites"))
    else {
        return false;
    };
    if site_index.saturating_add(2) >= segments.len() {
        return false;
    }
    let lower = normalized.to_lowercase();
    [
        "ts", "tsx", "js", "jsx", "cjs", "cts", "mjs", "mts", "css", "scss", "json", "htm", "html",
    ]
    .iter()
    .any(|ext| {
        lower
            .strip_suffix(ext)
            .is_some_and(|rest| rest.ends_with('.'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_media_matches_the_ts_oracle_table() {
        let text: &[(&str, &str)] = &[
            ("text/markdown", "notes/a.md"),
            ("text/plain", "notes.txt"),
            ("text/javascript", "app.js"),
            ("application/json", "x.json"),
            ("application/x-ndjson", "x.jsonl"),
            ("text/csv", "d.csv"),
            ("text/html", "page.html"),
            ("application/octet-stream", "README.markdown"),
            ("application/octet-stream", "run.sh"),
            ("application/typescript", "sites/mysite/src/x.ts"),
        ];
        for (media, path) in text {
            assert!(is_text_media_type(media, path), "{media} {path}");
        }
        let binary: &[(&str, &str)] = &[
            ("image/png", "x.png"),
            ("application/pdf", "x.pdf"),
            ("application/vnd.sqlite3", "x.db"),
            ("application/vnd.sqlite3", "x.sqlite3"),
            ("application/octet-stream", "Makefile"),
            ("application/octet-stream", "x.bin"),
            ("application/typescript", "x.ts"),
            ("application/typescript", "sites/x.ts"),
            ("audio/mp4", "song.m4a"),
        ];
        for (media, path) in binary {
            assert!(!is_text_media_type(media, path), "{media} {path}");
        }
    }

    #[test]
    fn sqlite_shapes_are_never_text_even_with_texty_names() {
        assert!(!is_text_media_type("application/vnd.sqlite3", "notes.db"));
        assert!(!is_text_media_type("application/x-sqlite3; charset=x", "a"));
        assert!(!is_text_media_type("application/vnd+sqlite", "a"));
        // The `.db` extension outranks a text-shaped media type (TS parity).
        assert!(!is_text_media_type("text/plain", "backup.db"));
    }

    #[test]
    fn site_source_requires_depth_below_the_sites_segment() {
        assert!(is_site_source_path("sites/blog/src/index.ts"));
        assert!(is_site_source_path("work/SITES/blog/app.tsx"));
        assert!(!is_site_source_path("sites/index.ts"));
        assert!(!is_site_source_path("sites/blog/notes.rs"));
        assert!(!is_site_source_path("notes/index.ts"));
    }
}
