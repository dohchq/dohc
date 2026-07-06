//! Long-lived dohc workspace kernel sidecar.
//!
//! Wire protocol: newline-delimited JSON-RPC 2.0 over stdio, one JSON object
//! per line. This intentionally matches the existing agent bridge convention
//! in `apps/desktop/src/agents/JsonRpcTransport.ts`; it is the simplest shape
//! to pipe, log, and debug locally without length-prefix framing.
//!
//! Auth binding: the parent process generates a random session token, passes it
//! to this child in `DOHC_KERNEL_TOKEN`, and every request must echo that token
//! in a top-level `"token"` field next to `"method"` and `"id"`. Dispatch first
//! converts a raw request into an `AuthenticatedRequest`; method handlers only
//! accept that authenticated type, so filesystem work is unreachable before the
//! token check succeeds. Client-supplied actor/workspace/version identity claims
//! are not schema fields; unknown params such as `actorId`, `workspaceId`, or
//! `versionId` are ignored rather than trusted.
//!
//! Reconcile semantics: manifest `mtime` is accepted as informational input for
//! future optimization, but this implementation always hashes current files and
//! treats only size/hash differences as changed. Hashes, not timestamps, are the
//! source of truth.
//!
//! Cancellation semantics: `kernel.cancel` sets a cancellation flag for the
//! in-flight request id. Handlers check the flag between files and return a
//! JSON-RPC error with code `-32002` when cancellation is observed.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use walkdir::{DirEntry, WalkDir};

const PROTOCOL_VERSION: u32 = 1;
const AUTH_ERROR_CODE: i32 = -32001;
const CANCELLED_ERROR_CODE: i32 = -32002;
const INTERNAL_ERROR_CODE: i32 = -32603;
const INVALID_PARAMS_CODE: i32 = -32602;
const METHOD_NOT_FOUND_CODE: i32 = -32601;
const PARSE_ERROR_CODE: i32 = -32700;

const IGNORED_SEGMENTS: &[&str] = &[".dohc", ".git", "node_modules"];
const IGNORED_FILE_PREFIXES: &[&str] = &[".dohc-write-"];
const CAPABILITIES: &[&str] = &[
    "kernel.handshake",
    "kernel.scan",
    "kernel.hashChanged",
    "kernel.reconcile",
    "kernel.cancel",
];

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
enum RequestId {
    String(String),
    Number(i64),
}

#[derive(Debug, Deserialize)]
struct RawRequest {
    id: Option<RequestId>,
    method: Option<String>,
    params: Option<Value>,
    token: Option<String>,
}

struct AuthenticatedRequest {
    id: RequestId,
    method: String,
    params: Value,
}

#[derive(Debug, Serialize)]
struct RpcResponse {
    jsonrpc: &'static str,
    id: Option<RequestId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
    #[serde(rename = "timingMs")]
    timing_ms: TimingMs,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: i32,
    message: String,
}

#[derive(Debug, Serialize)]
struct TimingMs {
    total: f64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
struct FileMetadata {
    path: String,
    size: u64,
    sha256: String,
    #[serde(rename = "mediaType")]
    media_type: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct HashPathResult {
    path: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ScanParams {
    root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashChangedParams {
    root: String,
    paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ReconcileParams {
    root: String,
    manifest: Vec<ManifestEntry>,
}

#[derive(Debug, Deserialize)]
struct ManifestEntry {
    path: String,
    sha256: String,
    size: u64,
    #[allow(dead_code)]
    mtime: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelParams {
    request_id: RequestId,
}

struct HashedFile {
    sha256: String,
    bytes: u64,
}

type CancelFlag = Arc<AtomicBool>;

#[derive(Clone, Default)]
struct CancellationRegistry {
    requests: Arc<Mutex<HashMap<RequestId, CancelFlag>>>,
}

impl CancellationRegistry {
    fn register(&self, id: RequestId) -> RegisteredRequest {
        let flag = Arc::new(AtomicBool::new(false));
        self.requests
            .lock()
            .expect("cancel registry poisoned")
            .insert(id.clone(), flag.clone());
        RegisteredRequest {
            id,
            flag,
            registry: self.clone(),
        }
    }

    fn cancel(&self, id: &RequestId) -> bool {
        let Some(flag) = self
            .requests
            .lock()
            .expect("cancel registry poisoned")
            .get(id)
            .cloned()
        else {
            return false;
        };
        flag.store(true, Ordering::SeqCst);
        true
    }

    #[cfg(test)]
    fn flag_for_tests(&self) -> CancelFlag {
        Arc::new(AtomicBool::new(false))
    }
}

struct RegisteredRequest {
    id: RequestId,
    flag: CancelFlag,
    registry: CancellationRegistry,
}

impl Drop for RegisteredRequest {
    fn drop(&mut self) {
        self.registry
            .requests
            .lock()
            .expect("cancel registry poisoned")
            .remove(&self.id);
    }
}

fn main() {
    let token = match env::var("DOHC_KERNEL_TOKEN") {
        Ok(token) if !token.is_empty() => token,
        _ => {
            eprintln!("DOHC_KERNEL_TOKEN is required");
            std::process::exit(1);
        }
    };
    if let Err(error) = run_stdio(&token, io::stdin(), io::stdout()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run_stdio(
    expected_token: &str,
    input: impl Read + Send + 'static,
    output: impl Write + Send + 'static,
) -> io::Result<()> {
    let registry = CancellationRegistry::default();
    let output = Arc::new(Mutex::new(output));
    let reader = BufReader::new(input);

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let expected_token = expected_token.to_string();
        let registry = registry.clone();
        let output = output.clone();
        thread::spawn(move || {
            let response = dispatch_line(&line, &expected_token, &registry);
            let encoded = serde_json::to_string(&response).unwrap_or_else(|error| {
                format!(
                    "{{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{{\"code\":{},\"message\":\"serialization failed: {}\"}},\"timingMs\":{{\"total\":0.0}}}}",
                    INTERNAL_ERROR_CODE, error
                )
            });
            let mut out = output.lock().expect("stdio output poisoned");
            let _ = writeln!(out, "{encoded}");
            let _ = out.flush();
        });
    }

    Ok(())
}

fn dispatch_line(line: &str, expected_token: &str, registry: &CancellationRegistry) -> RpcResponse {
    let started = Instant::now();
    let raw = match serde_json::from_str::<RawRequest>(line) {
        Ok(raw) => raw,
        Err(_) => {
            return error_response(None, PARSE_ERROR_CODE, "Invalid JSON-RPC request.", started)
        }
    };
    dispatch_raw(raw, expected_token, registry, started)
}

fn dispatch_raw(
    raw: RawRequest,
    expected_token: &str,
    registry: &CancellationRegistry,
    started: Instant,
) -> RpcResponse {
    let request = match authenticate_request(raw, expected_token, started) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let registered = registry.register(request.id.clone());
    let result = handle_authenticated_request(&request, registry, &registered.flag);
    match result {
        Ok(result) => success_response(Some(request.id), result, started),
        Err(error) => error_response(Some(request.id), error.code, &error.message, started),
    }
}

fn authenticate_request(
    raw: RawRequest,
    expected_token: &str,
    started: Instant,
) -> Result<AuthenticatedRequest, RpcResponse> {
    let id = raw.id;
    match raw.token.as_deref() {
        Some(token) if !token.is_empty() && token == expected_token => {}
        _ => {
            return Err(error_response(
                id,
                AUTH_ERROR_CODE,
                "Kernel request authentication failed.",
                started,
            ))
        }
    }
    let Some(id) = id else {
        return Err(error_response(
            None,
            INVALID_PARAMS_CODE,
            "JSON-RPC request id is required.",
            started,
        ));
    };
    let Some(method) = raw.method else {
        return Err(error_response(
            Some(id),
            INVALID_PARAMS_CODE,
            "JSON-RPC method is required.",
            started,
        ));
    };
    Ok(AuthenticatedRequest {
        id,
        method,
        params: raw.params.unwrap_or(Value::Null),
    })
}

fn handle_authenticated_request(
    request: &AuthenticatedRequest,
    registry: &CancellationRegistry,
    cancel: &CancelFlag,
) -> Result<Value, HandlerError> {
    match request.method.as_str() {
        "kernel.handshake" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": CAPABILITIES,
        })),
        "kernel.scan" => {
            let params: ScanParams = parse_params(request.params.clone())?;
            let files = scan_workspace(Path::new(&params.root), cancel)?;
            Ok(json!({ "files": files }))
        }
        "kernel.hashChanged" => {
            let params: HashChangedParams = parse_params(request.params.clone())?;
            let files = hash_changed(Path::new(&params.root), &params.paths, cancel)?;
            Ok(json!({ "files": files }))
        }
        "kernel.reconcile" => {
            let params: ReconcileParams = parse_params(request.params.clone())?;
            let result = reconcile_workspace(Path::new(&params.root), params.manifest, cancel)?;
            Ok(result)
        }
        "kernel.cancel" => {
            let params: CancelParams = parse_params(request.params.clone())?;
            Ok(json!({ "cancelled": registry.cancel(&params.request_id) }))
        }
        other => Err(HandlerError::new(
            METHOD_NOT_FOUND_CODE,
            format!("Method not found: {other}"),
        )),
    }
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, HandlerError> {
    serde_json::from_value(params)
        .map_err(|error| HandlerError::new(INVALID_PARAMS_CODE, error.to_string()))
}

fn success_response(id: Option<RequestId>, result: Value, started: Instant) -> RpcResponse {
    RpcResponse {
        jsonrpc: "2.0",
        id,
        result: Some(result),
        error: None,
        timing_ms: elapsed(started),
    }
}

fn error_response(
    id: Option<RequestId>,
    code: i32,
    message: &str,
    started: Instant,
) -> RpcResponse {
    RpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(RpcError {
            code,
            message: message.to_string(),
        }),
        timing_ms: elapsed(started),
    }
}

fn elapsed(started: Instant) -> TimingMs {
    TimingMs {
        total: started.elapsed().as_secs_f64() * 1000.0,
    }
}

#[derive(Debug)]
struct HandlerError {
    code: i32,
    message: String,
}

impl HandlerError {
    fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<io::Error> for HandlerError {
    fn from(error: io::Error) -> Self {
        Self::new(INTERNAL_ERROR_CODE, error.to_string())
    }
}

fn check_cancelled(cancel: &CancelFlag) -> Result<(), HandlerError> {
    if cancel.load(Ordering::SeqCst) {
        return Err(HandlerError::new(
            CANCELLED_ERROR_CODE,
            "Kernel request cancelled.",
        ));
    }
    Ok(())
}

fn scan_workspace(root: &Path, cancel: &CancelFlag) -> Result<Vec<FileMetadata>, HandlerError> {
    let canonical_root = canonical_workspace_root(root)?;
    let mut files = Vec::new();
    let walker = WalkDir::new(&canonical_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_descend);

    for entry in walker {
        check_cancelled(cancel)?;
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if entry.path() == canonical_root {
            continue;
        }
        let relative = relative_display(&canonical_root, entry.path());
        if has_ignored_segment(&relative) {
            continue;
        }
        let file_type = entry.file_type();
        if file_type.is_symlink() || !file_type.is_file() || is_database_sidecar(entry.path()) {
            continue;
        }
        match entry.metadata() {
            Ok(metadata) if metadata.is_file() => {}
            _ => continue,
        }
        let hashed = match sha256_file(entry.path(), cancel) {
            Ok(hashed) => hashed,
            Err(_) => continue,
        };
        files.push(FileMetadata {
            path: relative.clone(),
            size: hashed.bytes,
            sha256: hashed.sha256,
            media_type: media_type_for_path(&relative).to_string(),
        });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn hash_changed(
    root: &Path,
    paths: &[String],
    cancel: &CancelFlag,
) -> Result<Vec<HashPathResult>, HandlerError> {
    let canonical_root = canonical_workspace_root(root)?;
    let mut results = Vec::new();
    for path in paths {
        check_cancelled(cancel)?;
        results.push(hash_candidate(&canonical_root, path, cancel));
    }
    Ok(results)
}

fn reconcile_workspace(
    root: &Path,
    manifest: Vec<ManifestEntry>,
    cancel: &CancelFlag,
) -> Result<Value, HandlerError> {
    let current = scan_workspace(root, cancel)?;
    let mut prior: HashMap<String, ManifestEntry> = manifest
        .into_iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect();
    let mut changed = Vec::new();
    let mut added = Vec::new();
    let mut seen = HashSet::new();

    for file in current {
        check_cancelled(cancel)?;
        seen.insert(file.path.clone());
        match prior.remove(&file.path) {
            Some(entry) if entry.size == file.size && entry.sha256 == file.sha256 => {}
            Some(_) => changed.push(file),
            None => added.push(file),
        }
    }

    let mut removed: Vec<String> = prior
        .into_keys()
        .filter(|path| !seen.contains(path))
        .collect();
    changed.sort_by(|a, b| a.path.cmp(&b.path));
    added.sort_by(|a, b| a.path.cmp(&b.path));
    removed.sort();

    Ok(json!({
        "changed": changed,
        "added": added,
        "removed": removed,
    }))
}

fn canonical_workspace_root(root: &Path) -> Result<PathBuf, HandlerError> {
    let canonical_root = fs::canonicalize(root)?;
    let metadata = fs::metadata(&canonical_root)?;
    if !metadata.is_dir() {
        return Err(HandlerError::new(
            INVALID_PARAMS_CODE,
            "workspace root is not a directory",
        ));
    }
    Ok(canonical_root)
}

fn hash_candidate(root: &Path, path: &str, cancel: &CancelFlag) -> HashPathResult {
    if path.trim().is_empty()
        || path.contains('\0')
        || path.starts_with('/')
        || Path::new(path).is_absolute()
        || path
            .replace('\\', "/")
            .split('/')
            .any(|segment| segment == "..")
    {
        return hash_error(path, "unsafe");
    }
    let relative = path.replace('\\', "/");
    if has_ignored_segment(&relative) || is_database_sidecar(Path::new(&relative)) {
        return hash_error(path, "ignored");
    }
    let absolute = root.join(&relative);
    let metadata = match fs::symlink_metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return hash_error(path, "missing")
        }
        Err(error) => return hash_error(path, &format!("io:{:?}", error.kind())),
    };
    if metadata.file_type().is_symlink() {
        return hash_error(path, "symlink");
    }
    if !metadata.is_file() {
        return hash_error(path, "not-file");
    }
    match sha256_file(&absolute, cancel) {
        Ok(hashed) => HashPathResult {
            path: relative,
            status: "ok".to_string(),
            size: Some(hashed.bytes),
            sha256: Some(hashed.sha256),
            error: None,
        },
        Err(error) => hash_error(path, &format!("io:{:?}", error.kind())),
    }
}

fn hash_error(path: &str, error: &str) -> HashPathResult {
    HashPathResult {
        path: path.replace('\\', "/"),
        status: "error".to_string(),
        size: None,
        sha256: None,
        error: Some(error.to_string()),
    }
}

fn should_descend(entry: &DirEntry) -> bool {
    let name = normalize_ignored_segment(&entry.file_name().to_string_lossy());
    !segment_is_ignored(&name)
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
        .map(normalize_ignored_segment)
        .any(|segment| segment_is_ignored(&segment))
}

fn segment_is_ignored(segment: &str) -> bool {
    IGNORED_SEGMENTS.contains(&segment)
        || IGNORED_FILE_PREFIXES
            .iter()
            .any(|prefix| segment.starts_with(prefix))
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

fn normalize_ignored_segment(segment: &str) -> String {
    segment.trim_end_matches(['.', ' ']).to_lowercase()
}

fn sha256_file(path: &Path, cancel: &CancelFlag) -> io::Result<HashedFile> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        hasher.update(&buffer[..read]);
    }
    Ok(HashedFile {
        sha256: format!("{:x}", hasher.finalize()),
        bytes,
    })
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

    const TOKEN: &str = "test-token";
    const FIXTURE_DIR: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/workspace-kernel"
    );

    #[derive(Debug, Deserialize)]
    struct ContractFixture {
        workspace: FixtureWorkspace,
        request: Option<Value>,
        expected: Value,
    }

    #[derive(Debug, Deserialize)]
    struct FixtureWorkspace {
        files: Vec<FixtureFile>,
        #[serde(default)]
        symlinks: Vec<FixtureSymlink>,
    }

    #[derive(Debug, Deserialize)]
    struct FixtureFile {
        path: String,
        text: String,
    }

    #[derive(Debug, Deserialize)]
    struct FixtureSymlink {
        path: String,
        target: String,
    }

    #[test]
    fn framing_round_trips_one_request_response() {
        let registry = CancellationRegistry::default();
        let response = dispatch_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"kernel.handshake","token":"test-token"}"#,
            TOKEN,
            &registry,
        );
        assert!(response.error.is_none());
        let encoded = serde_json::to_string(&response).unwrap();
        let decoded: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded["jsonrpc"], "2.0");
        assert_eq!(decoded["id"], 1);
        assert_eq!(decoded["result"]["protocolVersion"], 1);
        assert!(decoded["timingMs"]["total"].is_number());
    }

    #[test]
    fn missing_empty_and_wrong_token_reject_before_filesystem_work() {
        let registry = CancellationRegistry::default();
        for (id, token_field) in [(1, ""), (2, r#","token":"""#), (3, r#","token":"wrong""#)] {
            let response = dispatch_line(
                &format!(
                    r#"{{"jsonrpc":"2.0","id":{id},"method":"kernel.scan","params":{{"root":"/definitely/not/here"}}{token_field}}}"#
                ),
                TOKEN,
                &registry,
            );
            let error = response.error.unwrap();
            assert_eq!(error.code, AUTH_ERROR_CODE);
            assert!(error.message.contains("authentication"));
        }
    }

    #[test]
    fn forged_identity_params_are_ignored_after_auth() {
        let temp = tempfile::tempdir().unwrap();
        write_file(temp.path().join("notes/a.md"), b"# A\n");
        let registry = CancellationRegistry::default();
        let clean = scan_request(temp.path(), None);
        let forged = scan_request(
            temp.path(),
            Some(
                r#","actorId":"forged-admin","workspaceId":"forged-workspace","versionId":"forged-version""#,
            ),
        );
        let clean_response = dispatch_line(&clean, TOKEN, &registry);
        let forged_response = dispatch_line(&forged, TOKEN, &registry);
        assert!(clean_response.error.is_none());
        assert!(forged_response.error.is_none());
        assert_eq!(clean_response.result, forged_response.result);
    }

    #[test]
    fn scan_skips_ignored_sidecars_and_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        write_file(temp.path().join("notes/a.md"), b"# A\n");
        write_file(temp.path().join(".dohc/history.json"), b"hidden");
        write_file(temp.path().join(".git/config"), b"hidden");
        write_file(temp.path().join("node_modules/pkg/index.js"), b"hidden");
        write_file(temp.path().join("node_modules /pkg/index.js"), b"hidden");
        write_file(temp.path().join(".git./config"), b"hidden");
        write_file(temp.path().join(".dohc-write-123.tmp"), b"hidden");
        write_file(
            temp.path().join("finance/ledger.sqlite"),
            b"SQLite format 3\0",
        );
        write_file(temp.path().join("finance/ledger.sqlite-wal"), b"transient");
        write_file(temp.path().join("notes/draft-wal"), b"not a sqlite sidecar");
        #[cfg(unix)]
        std::os::unix::fs::symlink("/tmp/outside-secret", temp.path().join("notes/outside.md"))
            .unwrap();

        let files = scan_workspace(
            temp.path(),
            &CancellationRegistry::default().flag_for_tests(),
        )
        .unwrap();
        let paths: Vec<_> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["finance/ledger.sqlite", "notes/a.md", "notes/draft-wal"]
        );
    }

    #[test]
    fn hash_changed_reports_per_path_errors() {
        let temp = tempfile::tempdir().unwrap();
        write_file(temp.path().join("notes/a.md"), b"# A\n");
        let results = hash_changed(
            temp.path(),
            &[
                "notes/a.md".to_string(),
                "missing.md".to_string(),
                "../escape.md".to_string(),
            ],
            &CancellationRegistry::default().flag_for_tests(),
        )
        .unwrap();
        assert_eq!(results[0].status, "ok");
        assert_eq!(results[1].error.as_deref(), Some("missing"));
        assert_eq!(results[2].error.as_deref(), Some("unsafe"));
    }

    #[test]
    fn reconcile_lists_changed_added_and_removed() {
        let temp = tempfile::tempdir().unwrap();
        write_file(temp.path().join("changed.md"), b"after\n");
        write_file(temp.path().join("added.md"), b"new\n");
        let result = reconcile_workspace(
            temp.path(),
            vec![
                ManifestEntry {
                    path: "changed.md".to_string(),
                    sha256: "old".to_string(),
                    size: 1,
                    mtime: 0.0,
                },
                ManifestEntry {
                    path: "removed.md".to_string(),
                    sha256: "gone".to_string(),
                    size: 4,
                    mtime: 0.0,
                },
            ],
            &CancellationRegistry::default().flag_for_tests(),
        )
        .unwrap();
        assert_eq!(result["changed"][0]["path"], "changed.md");
        assert_eq!(result["added"][0]["path"], "added.md");
        assert_eq!(result["removed"][0], "removed.md");
    }

    #[test]
    fn shared_scan_contract_fixture_matches() {
        let fixture = read_fixture("scan.json");
        let temp = tempfile::tempdir().unwrap();
        write_fixture_workspace(temp.path(), &fixture.workspace);
        let files = scan_workspace(
            temp.path(),
            &CancellationRegistry::default().flag_for_tests(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(files).unwrap(),
            fixture.expected["files"]
        );
    }

    #[test]
    fn shared_hash_changed_contract_fixture_matches() {
        let fixture = read_fixture("hashChanged.json");
        let temp = tempfile::tempdir().unwrap();
        write_fixture_workspace(temp.path(), &fixture.workspace);
        let paths: Vec<String> = fixture.request.unwrap()["paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        let files = hash_changed(
            temp.path(),
            &paths,
            &CancellationRegistry::default().flag_for_tests(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(files).unwrap(),
            fixture.expected["files"]
        );
    }

    #[test]
    fn shared_reconcile_contract_fixture_matches() {
        let fixture = read_fixture("reconcile.json");
        let temp = tempfile::tempdir().unwrap();
        write_fixture_workspace(temp.path(), &fixture.workspace);
        let manifest: Vec<ManifestEntry> =
            serde_json::from_value(fixture.request.unwrap()["manifest"].clone()).unwrap();
        let result = reconcile_workspace(
            temp.path(),
            manifest,
            &CancellationRegistry::default().flag_for_tests(),
        )
        .unwrap();
        assert_eq!(result, fixture.expected);
    }

    fn scan_request(root: &Path, extra_fields: Option<&str>) -> String {
        format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"kernel.scan","token":"test-token","params":{{"root":"{}"{}}}}}"#,
            root.to_string_lossy(),
            extra_fields.unwrap_or("")
        )
    }

    fn read_fixture(name: &str) -> ContractFixture {
        let path = Path::new(FIXTURE_DIR).join(name);
        let text = fs::read_to_string(path).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    fn write_fixture_workspace(root: &Path, workspace: &FixtureWorkspace) {
        for file in &workspace.files {
            write_file(root.join(&file.path), file.text.as_bytes());
        }
        for symlink in &workspace.symlinks {
            #[cfg(unix)]
            {
                let path = root.join(&symlink.path);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(&symlink.target, path).unwrap();
            }
        }
    }

    fn write_file(path: impl AsRef<Path>, bytes: &[u8]) {
        let path = path.as_ref();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = File::create(path).unwrap();
        file.write_all(bytes).unwrap();
    }
}
