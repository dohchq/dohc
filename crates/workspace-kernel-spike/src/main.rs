use serde::Serialize;
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::Instant;
use walkdir::{DirEntry, WalkDir};

const IGNORED_SEGMENTS: &[&str] = &[".dohc", ".git", "node_modules"];

#[derive(Debug, Serialize)]
struct ScanOutput {
    root: String,
    files: Vec<ScannedFile>,
    skipped: Vec<SkippedPath>,
    metrics: ScanMetrics,
}

#[derive(Debug, Serialize)]
struct ScannedFile {
    path: String,
    size: u64,
    sha256: String,
    media_type: String,
}

#[derive(Debug, Serialize)]
struct SkippedPath {
    path: String,
    reason: String,
}

#[derive(Debug, Serialize)]
struct ScanMetrics {
    files: usize,
    bytes: u64,
    scan_ms: f64,
}

#[derive(Debug)]
struct Args {
    root: PathBuf,
    json: bool,
}

enum ParsedArgs {
    Help,
    Scan(Args),
}

fn main() {
    match run() {
        Ok(()) => {}
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<(), String> {
    let args = match parse_args(env::args().skip(1))? {
        ParsedArgs::Help => {
            println!("{}", usage());
            return Ok(());
        }
        ParsedArgs::Scan(args) => args,
    };
    let output = scan_workspace(&args.root).map_err(|error| error.to_string())?;

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&output).map_err(|error| error.to_string())?
        );
    } else {
        println!(
            "scanned {} files / {} bytes in {:.2}ms",
            output.metrics.files, output.metrics.bytes, output.metrics.scan_ms
        );
    }

    Ok(())
}

fn parse_args<I>(mut args: I) -> Result<ParsedArgs, String>
where
    I: Iterator<Item = String>,
{
    let command = args.next().ok_or_else(usage)?;
    if command == "--help" || command == "-h" {
        return Ok(ParsedArgs::Help);
    }
    if command != "scan" {
        return Err(usage());
    }

    let mut root: Option<PathBuf> = None;
    let mut json = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--root requires a path".to_string())?;
                root = Some(PathBuf::from(value));
            }
            "--json" => json = true,
            "--help" | "-h" => return Ok(ParsedArgs::Help),
            other => return Err(format!("unknown argument: {other}\n{}", usage())),
        }
    }

    Ok(ParsedArgs::Scan(Args {
        root: root.ok_or_else(|| "--root is required".to_string())?,
        json,
    }))
}

fn usage() -> String {
    "usage: dohc-workspace-kernel-spike scan --root <workspace-root> [--json]".to_string()
}

fn scan_workspace(root: &Path) -> io::Result<ScanOutput> {
    let start = Instant::now();
    let canonical_root = fs::canonicalize(root)?;
    let metadata = fs::metadata(&canonical_root)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace root is not a directory",
        ));
    }

    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let walker = WalkDir::new(&canonical_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_descend);

    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                let path = error
                    .path()
                    .map(|path| relative_display(&canonical_root, path))
                    .unwrap_or_else(|| "<unknown>".to_string());
                skipped.push(SkippedPath {
                    path,
                    reason: error.to_string(),
                });
                continue;
            }
        };

        if entry.path() == canonical_root {
            continue;
        }

        let relative = relative_display(&canonical_root, entry.path());
        if has_ignored_segment(&relative) {
            continue;
        }

        let file_type = entry.file_type();
        if file_type.is_symlink() {
            skipped.push(SkippedPath {
                path: relative,
                reason: "symlink".to_string(),
            });
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if is_database_sidecar(entry.path()) {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                skipped.push(SkippedPath {
                    path: relative.clone(),
                    reason: error.to_string(),
                });
                continue;
            }
        };
        let sha = match sha256_file(entry.path()) {
            Ok(sha) => sha,
            Err(error) => {
                skipped.push(SkippedPath {
                    path: relative.clone(),
                    reason: error.to_string(),
                });
                continue;
            }
        };
        files.push(ScannedFile {
            path: relative.clone(),
            size: metadata.len(),
            sha256: sha,
            media_type: media_type_for_path(&relative).to_string(),
        });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    skipped.sort_by(|a, b| a.path.cmp(&b.path));
    let bytes = files.iter().map(|file| file.size).sum();
    let scan_ms = start.elapsed().as_secs_f64() * 1000.0;

    Ok(ScanOutput {
        root: canonical_root.display().to_string(),
        metrics: ScanMetrics {
            files: files.len(),
            bytes,
            scan_ms,
        },
        files,
        skipped,
    })
}

fn should_descend(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy().to_lowercase();
    !IGNORED_SEGMENTS.contains(&name.as_str())
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn has_ignored_segment(path: &str) -> bool {
    path.replace('\\', "/")
        .split('/')
        .map(|segment| segment.trim_end_matches(['.', ' ']).to_lowercase())
        .any(|segment| IGNORED_SEGMENTS.contains(&segment.as_str()))
}

fn is_database_sidecar(path: &Path) -> bool {
    let Some(file_name) = path.file_name().map(|name| name.to_string_lossy()) else {
        return false;
    };
    let lower = file_name.to_lowercase();
    ["-wal", "-shm", "-journal"].iter().any(|suffix| {
        if !lower.ends_with(suffix) {
            return false;
        }
        let base = &lower[..lower.len() - suffix.len()];
        base.ends_with(".db") || base.ends_with(".sqlite") || base.ends_with(".sqlite3")
    })
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn media_type_for_path(path: &str) -> &'static str {
    let basename = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let extension = basename
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_lowercase())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn scans_files_and_skips_internal_segments() {
        let temp = tempfile::tempdir().unwrap();
        write_file(temp.path().join("notes/a.md"), b"# A\n");
        write_file(temp.path().join("scripts/run.sh"), b"#!/bin/sh\ntrue\n");
        write_file(temp.path().join(".dohc/history.json"), b"hidden");
        write_file(temp.path().join(".git/config"), b"hidden");
        write_file(temp.path().join(".DOHC/history.json"), b"hidden");
        write_file(temp.path().join(".GIT/config"), b"hidden");
        write_file(temp.path().join("node_modules/pkg/index.js"), b"hidden");
        write_file(
            temp.path().join("finance/ledger.sqlite"),
            b"SQLite format 3\0",
        );
        write_file(temp.path().join("finance/ledger.sqlite-wal"), b"transient");
        write_file(temp.path().join("finance/ledger.sqlite-shm"), b"transient");
        write_file(
            temp.path().join("finance/ledger.sqlite-journal"),
            b"transient",
        );
        write_file(temp.path().join("finance/cache"), b"SQLite format 3\0");
        write_file(temp.path().join("finance/cache-wal"), b"transient");
        write_file(temp.path().join("finance/cache-shm"), b"transient");
        write_file(temp.path().join("finance/cache-journal"), b"transient");
        write_file(temp.path().join("finance/archive.db"), b"plain export");
        write_file(temp.path().join("finance/archive.db-journal"), b"transient");
        write_file(temp.path().join("notes/draft-wal"), b"not a sqlite sidecar");

        let output = scan_workspace(temp.path()).unwrap();
        let paths: Vec<_> = output.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "finance/archive.db",
                "finance/cache",
                "finance/cache-journal",
                "finance/cache-shm",
                "finance/cache-wal",
                "finance/ledger.sqlite",
                "notes/a.md",
                "notes/draft-wal",
                "scripts/run.sh"
            ]
        );
        assert_eq!(
            output
                .files
                .iter()
                .find(|file| file.path == "finance/ledger.sqlite")
                .unwrap()
                .media_type,
            "application/vnd.sqlite3"
        );
        assert_eq!(
            output
                .files
                .iter()
                .find(|file| file.path == "notes/a.md")
                .unwrap()
                .media_type,
            "text/markdown"
        );
        assert_eq!(
            output
                .files
                .iter()
                .find(|file| file.path == "scripts/run.sh")
                .unwrap()
                .media_type,
            "text/plain"
        );
        assert_eq!(output.metrics.files, 9);
    }

    #[test]
    fn rejects_non_directory_roots() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("note.md");
        write_file(&file, b"not a directory");

        let err = scan_workspace(&file).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn help_is_a_successful_parse() {
        assert!(matches!(
            parse_args(vec!["scan".to_string(), "--help".to_string()].into_iter()).unwrap(),
            ParsedArgs::Help
        ));
        assert!(matches!(
            parse_args(vec!["--help".to_string()].into_iter()).unwrap(),
            ParsedArgs::Help
        ));
    }

    fn write_file(path: impl AsRef<Path>, bytes: &[u8]) {
        let path = path.as_ref();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = File::create(path).unwrap();
        file.write_all(bytes).unwrap();
    }
}
