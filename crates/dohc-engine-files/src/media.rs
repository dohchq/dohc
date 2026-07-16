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
