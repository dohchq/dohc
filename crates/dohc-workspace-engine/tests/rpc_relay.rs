mod common;

#[path = "rpc_relay/artifact_recovery.rs"]
mod artifact_recovery;

use common::*;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::Engine as _;
use dohc_engine_collab::Ydoc;
use dohc_engine_domain::{VersionedTextStore, WriteText, reconcile_collections_in_tx};
use dohc_engine_protocol::{
    error::ErrorCode,
    supervisor::{Supervisor, SupervisorConfig},
    transport::{
        EngineService as ProtocolEngineService, EngineTransport, InProcessTransport, RequestContext,
    },
    wire::WorkspaceHandle,
};
use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_storage::{
    ENGINE_SQLITE_BUSY_TIMEOUT_MS, EngineStore, NoFaults, TxnOutcome, hex_sha256,
};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde_json::{Value, json};

const BEARER: &str = "relay-test-token";
const ETAG: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[derive(Debug)]
struct TestRequest {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl TestRequest {
    fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or(&self.target)
    }

    fn query_i64(&self, key: &str) -> i64 {
        self.target
            .split_once('?')
            .map(|(_, query)| query)
            .into_iter()
            .flat_map(|query| query.split('&'))
            .filter_map(|part| part.split_once('='))
            .find(|(name, _)| *name == key)
            .and_then(|(_, value)| value.parse().ok())
            .unwrap_or(0)
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("request JSON")
    }
}

struct TestResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl TestResponse {
    fn json(body: Value) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: serde_json::to_vec(&body).expect("response JSON"),
        }
    }

    fn bytes(bytes: impl Into<Vec<u8>>) -> Self {
        Self {
            status: 200,
            headers: vec![(
                "content-type".to_owned(),
                "application/octet-stream".to_owned(),
            )],
            body: bytes.into(),
        }
    }

    fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }
}

#[derive(Default)]
struct RelayState {
    workspace_ops: Vec<Value>,
    workspace_blobs: HashMap<String, Vec<u8>>,
    share_ops: HashMap<String, Vec<Value>>,
    share_blobs: HashMap<(String, String), Vec<u8>>,
    requests: Vec<(String, String)>,
    pushed_workspace_ops: Vec<Value>,
    local_origin_id: Option<String>,
    share_posts: HashMap<String, usize>,
    workspace_log_delay: Option<Duration>,
    workspace_log_started: Option<Arc<AtomicBool>>,
    workspace_page_limit: Option<usize>,
    // Refuse every claim for good.
    refuse_claims: bool,
}

struct FakeRelay {
    base_url: String,
    state: Arc<Mutex<RelayState>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl FakeRelay {
    fn start(state: RelayState) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake relay");
        listener
            .set_nonblocking(true)
            .expect("nonblocking fake relay");
        let address = listener.local_addr().expect("fake relay address");
        let state = Arc::new(Mutex::new(state));
        let thread_state = Arc::clone(&state);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread = thread::spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if stream.set_nonblocking(false).is_err() {
                            continue;
                        }
                        if let Ok(request) = read_request(&mut stream) {
                            let response = handle_request(&thread_state, request);
                            let _ = write_response(&mut stream, response);
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            base_url: format!("http://{address}"),
            state,
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for FakeRelay {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let address = self
            .base_url
            .strip_prefix("http://")
            .expect("fake relay URL");
        let _ = TcpStream::connect(address);
        if let Some(thread) = self.thread.take() {
            thread.join().expect("join fake relay");
        }
    }
}

fn handle_request(state: &Arc<Mutex<RelayState>>, request: TestRequest) -> TestResponse {
    assert_eq!(
        request.header("authorization"),
        Some("Bearer relay-test-token")
    );
    let path = request.path().to_owned();
    let method = request.method.clone();
    let mut state = state.lock().expect("relay state");
    state.requests.push((method.clone(), path.clone()));

    if method == "POST" && path == "/sync/workspaces" {
        if state.refuse_claims {
            return TestResponse {
                status: 409,
                ..TestResponse::json(json!({ "code": "stream_identity_mismatch" }))
            };
        }
        return TestResponse::json(json!({ "ok": true }));
    }
    if path.ends_with("/keys") {
        if method == "PUT" {
            return TestResponse::bytes(Vec::new()).with_header("etag", &format!("\"{ETAG}\""));
        }
        return TestResponse::bytes(br#"{"ciphertext":"opaque"}"#.to_vec())
            .with_header("etag", &format!("\"{ETAG}\""));
    }
    if let Some(rest) = path.strip_prefix("/sync/shares/") {
        let (share_id, suffix) = rest.split_once('/').expect("share route");
        if let Some(sha256) = suffix.strip_prefix("blobs/") {
            let bytes = state
                .share_blobs
                .get(&(share_id.to_owned(), sha256.to_owned()))
                .cloned()
                .expect("share blob");
            return TestResponse::bytes(bytes);
        }
        assert_eq!(suffix, "log");
        if method == "POST" {
            let body = request.json();
            let ops = body["ops"].as_array().expect("share push ops");
            *state.share_posts.entry(share_id.to_owned()).or_default() += 1;
            let current = ops
                .last()
                .and_then(|op| op["originSeq"].as_i64())
                .unwrap_or(-1);
            return TestResponse::json(json!({
                "accepted": ops.len(),
                "inserted": ops.len(),
                "skipped": 0,
                "currentMaxOriginSeq": current,
            }));
        }
        let since = request.query_i64("since");
        let rows = state
            .share_ops
            .get(share_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|row| row["relaySeq"].as_i64().unwrap_or(0) > since)
            .collect::<Vec<_>>();
        let next = rows
            .last()
            .and_then(|row| row["relaySeq"].as_i64())
            .unwrap_or(since);
        return TestResponse::json(json!({
            "ops": rows,
            "ownOriginId": "relay:share-member:authenticated-origin",
            "nextCursor": next,
            "hasMore": false,
        }));
    }
    if path.ends_with("/blobs/have") {
        return TestResponse::json(json!({ "missing": [] }));
    }
    if method == "GET"
        && let Some((_, sha256)) = path.rsplit_once("/blobs/")
    {
        return TestResponse::bytes(
            state
                .workspace_blobs
                .get(sha256)
                .cloned()
                .expect("workspace blob"),
        );
    }
    if method == "GET"
        && let Some((_, coordinate)) = path.split_once("/log/")
    {
        let (origin, seq) = coordinate.rsplit_once('/').unwrap();
        let seq: i64 = seq.parse().unwrap();
        return TestResponse::json(
            match state
                .workspace_ops
                .iter()
                .find(|op| op["originId"] == origin && op["originSeq"] == seq)
            {
                Some(op) => json!({"status":"present","op":op}),
                None => json!({"status":"absent"}),
            },
        );
    }
    if path.ends_with("/log") {
        if method == "POST" {
            let body = request.json();
            let origin = body["originId"].as_str().expect("origin id").to_owned();
            state.local_origin_id.get_or_insert(origin);
            let ops = body["ops"].as_array().expect("workspace push ops");
            state.pushed_workspace_ops.extend(ops.iter().cloned());
            let current = ops
                .last()
                .and_then(|op| op["originSeq"].as_i64())
                .unwrap_or(-1);
            return TestResponse::json(json!({
                "accepted": ops.len(),
                "inserted": ops.len(),
                "skipped": 0,
                "currentMaxOriginSeq": current,
            }));
        }
        if let Some(started) = &state.workspace_log_started {
            started.store(true, Ordering::SeqCst);
        }
        if let Some(delay) = state.workspace_log_delay {
            thread::sleep(delay);
        }
        let since = request.query_i64("since");
        let matching = state
            .workspace_ops
            .iter()
            .filter(|row| row["relaySeq"].as_i64().unwrap_or(0) > since)
            .cloned()
            .collect::<Vec<_>>();
        let requested_limit = usize::try_from(request.query_i64("limit")).unwrap_or(usize::MAX);
        let page_limit = state
            .workspace_page_limit
            .map_or(requested_limit, |limit| limit.min(requested_limit));
        let has_more = matching.len() > page_limit;
        let rows = matching.into_iter().take(page_limit).collect::<Vec<_>>();
        let next = rows
            .last()
            .and_then(|row| row["relaySeq"].as_i64())
            .unwrap_or(since);
        return TestResponse::json(json!({
            "ops": rows,
            "nextCursor": next,
            "hasMore": has_more,
        }));
    }
    panic!("unexpected fake relay request: {method} {path}");
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<TestRequest> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut bytes = Vec::new();
    let header_end = loop {
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        let mut chunk = [0_u8; 8192];
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        bytes.extend_from_slice(&chunk[..count]);
    };
    let headers_text =
        std::str::from_utf8(&bytes[..header_end]).map_err(|_| std::io::ErrorKind::InvalidData)?;
    let mut lines = headers_text.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_owned();
    let target = request_line.next().unwrap_or_default().to_owned();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned()))
        .collect::<Vec<_>>();
    let content_length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    while bytes.len() < header_end + content_length {
        let mut chunk = [0_u8; 8192];
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    if bytes.len() < header_end + content_length {
        return Err(std::io::ErrorKind::UnexpectedEof.into());
    }
    Ok(TestRequest {
        method,
        target,
        headers,
        body: bytes[header_end..header_end + content_length].to_vec(),
    })
}

#[test]
fn truncated_test_request_body_returns_unexpected_eof_without_panicking() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let address = listener.local_addr().expect("address");
    let sender = thread::spawn(move || {
        let mut stream = TcpStream::connect(address).expect("connect");
        stream
            .write_all(b"POST / HTTP/1.1\r\ncontent-length: 10\r\n\r\nshort")
            .expect("write truncated request");
        stream
            .shutdown(std::net::Shutdown::Write)
            .expect("shutdown writer");
    });
    let (mut stream, _) = listener.accept().expect("accept");
    let outcome =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read_request(&mut stream)));
    sender.join().expect("sender");
    assert!(
        outcome.is_ok(),
        "slicing to content-length panics instead of returning a read error"
    );
    let error = outcome
        .expect("read must not panic")
        .expect_err("truncated body must be rejected");
    assert_eq!(
        error.kind(),
        std::io::ErrorKind::UnexpectedEof,
        "truncation must surface as the precise read error"
    );
}

fn write_response(stream: &mut TcpStream, response: TestResponse) -> std::io::Result<()> {
    write!(stream, "HTTP/1.1 {} OK\r\n", response.status)?;
    for (name, value) in response.headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(
        stream,
        "content-length: {}\r\nconnection: close\r\n\r\n",
        response.body.len()
    )?;
    stream.write_all(&response.body)?;
    stream.flush()
}

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    relay: &FakeRelay,
    id: u64,
    workspace_id: &str,
) -> WorkspaceHandle {
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let opened = call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        request(
            id,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace_id,
                "relay": {
                    "baseUrl": relay.base_url,
                    "bearerToken": BEARER,
                    "allowInsecureLoopbackForTests": true,
                },
            }),
        ),
    )
    .await
    .expect("open workspace");
    serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle")
}

async fn call(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
    method: &str,
    params: Value,
) -> Value {
    *id += 1;
    call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        request(*id, method, Some(handle.clone()), params),
    )
    .await
    .unwrap_or_else(|error| panic!("{method} failed: {error:?}"))
    .result
}

async fn close(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
) {
    let _ = call(transport, handle, id, "workspace.close", json!({})).await;
}

async fn seed_main(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
    workspace_id: &str,
) {
    let _ = call(
        transport,
        handle,
        id,
        "versions.ensureMain",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
}

async fn seed_local_identity(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
) {
    let _ = call(
        transport,
        handle,
        id,
        "chats.channels.create",
        json!({
            "channelId": "identity-channel",
            "name": "Identity",
            "kind": "channel",
            "nowMs": 10,
        }),
    )
    .await;
}

async fn seed_sync_identity(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
    workspace_id: &str,
) {
    seed_local_identity(transport, handle, id).await;
    call(
        transport,
        handle,
        id,
        "sync.claim",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
}

async fn flush_capture(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let state = call(transport, handle, id, "capture.flush", json!({})).await;
        if state["settled"] == json!(true) {
            return;
        }
        if state["degraded"] == json!(true) {
            panic!("capture degraded before settling: {state}");
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "capture did not settle before its deadline: {state}"
        );
        tokio::task::yield_now().await;
    }
}

fn workspace_row(
    relay_seq: i64,
    workspace_id: &str,
    origin_id: &str,
    origin_seq: i64,
    op_kind: &str,
    payload: Value,
) -> Value {
    json!({
        "relaySeq": relay_seq,
        "workspaceId": workspace_id,
        "originId": origin_id,
        "originSeq": origin_seq,
        "opKind": op_kind,
        "payload": payload,
        "recordedAtMs": 1000 + relay_seq,
    })
}

fn share_row(
    relay_seq: i64,
    origin_id: &str,
    origin_seq: i64,
    op_kind: &str,
    payload: Value,
) -> Value {
    json!({
        "relaySeq": relay_seq,
        "originId": origin_id,
        "originSeq": origin_seq,
        "opKind": op_kind,
        "payload": payload,
        "recordedAtMs": 1000 + relay_seq,
    })
}

fn absent_moment_payload(
    moment_id: &str,
    object_id: &str,
    path: &str,
    sha256: &str,
    content_kind: &str,
    byte_length: usize,
) -> Value {
    json!({
        "momentId": moment_id,
        "versionId": "main",
        "objectId": object_id,
        "objectCreatedAtMs": 1,
        "path": path,
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": null,
        "payloadBeforePath": null,
        "payloadAfterBlobSha256": sha256,
        "payloadAfterPath": path,
        "payloadAfterContentKind": content_kind,
        "payloadAfterByteLength": byte_length,
        "metadata": {"origin": "sync"},
        "beforePresent": "absent"
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn first_push_backfills_an_api_text_write_from_the_rpc_surface() {
    let relay = FakeRelay::start(RelayState::default());
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let workspace_id = "rpc-relay-api-write-enrolment";
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;

    call(
        &transport,
        &handle,
        &mut id,
        "versionedText.write",
        json!({
            "versionId": "main",
            "objectId": "api-object",
            "path": "notes/api.md",
            "text": "written before enrollment",
            "momentId": "moment-api-before-enrollment",
            "origin": "api",
            "nowMs": 10,
        }),
    )
    .await;
    seed_sync_identity(&transport, &handle, &mut id, workspace_id).await;
    call(
        &transport,
        &handle,
        &mut id,
        "sync.push",
        json!({ "workspaceId": workspace_id }),
    )
    .await;

    let state = relay.state.lock().expect("relay state");
    assert_eq!(
        state
            .pushed_workspace_ops
            .iter()
            .filter(|op| {
                op["opKind"] == "moment.append"
                    && op["payload"]["momentId"] == "moment-api-before-enrollment"
            })
            .count(),
        1,
        "the first push must backfill the pre-enrollment RPC write"
    );
}

// The document stays open and idle when sync turns on. Its last record came
// before enrollment, so no record claimed it. The push that makes enrollment
// ready claims it through its session and requests a continuation. The session's next
// write then succeeds under that claim.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bounded_push_publishes_an_idle_open_document_and_its_next_edit_succeeds() {
    let relay = FakeRelay::start(RelayState::default());
    let scratch = ScratchDir::new().expect("scratch");
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
    let workspace_id = "rpc-relay-unsettled-ydoc-enrolment";
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;

    let opened = call(
        &transport,
        &handle,
        &mut id,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/live-before-enrollment.md",
            "contentKind": "plaintext",
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id");
    let doc = Ydoc::wire();
    let update = base64::engine::general_purpose::STANDARD
        .encode(doc.plaintext_insert(0, "edited before enrollment"));
    call(
        &transport,
        &handle,
        &mut id,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": opened["lineageClaimId"], "sessionId": session_id, "updateBase64": update }),
    )
    .await;
    seed_sync_identity(&transport, &handle, &mut id, workspace_id).await;
    let first = call(
        &transport,
        &handle,
        &mut id,
        "sync.push",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(first["hasMore"], json!(true));
    let continued = call(
        &transport,
        &handle,
        &mut id,
        "sync.push",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(continued["hasMore"], json!(false));
    assert!(
        relay
            .state
            .lock()
            .expect("relay state")
            .pushed_workspace_ops
            .iter()
            .any(|op| op["opKind"] == "ydoc.update"),
        "the continuation must send the open document without another edit: {continued}"
    );

    // The push claimed the lineage under the session. An edit that still
    // expects the unclaimed lineage is refused; the engine does not infer
    // that the claim continues the editor's document.
    let next =
        base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(24, " and after"));
    id += 1;
    let stale = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "ydoc.recordUpdate",
                Some(handle.clone()),
                json!({ "expectedLineageClaimId": null, "sessionId": session_id, "updateBase64": next }),
            ),
        )
        .await
        .expect_err("an unclaimed expectation must not write into the claimed lineage");
    assert_eq!(stale.message, "ydoc-lineage-stale");

    // The resync shows the editor the claim this device made from its own
    // history, so the editor keeps its document and writes under that claim.
    id += 1;
    let resynced = ProtocolEngineService::call(
        service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            id,
            "ydoc.resync",
            Some(handle.clone()),
            json!({ "sessionId": session_id }),
        ),
    )
    .await
    .expect("resync the editor");
    let claim = resynced.response.result["lineageClaimId"].clone();
    assert!(claim.is_string());
    assert_eq!(
        resynced.response.result["lineageOriginatedHere"],
        json!(true)
    );
    drop(resynced);

    // The open session writes and saves again, with nothing refused as stale.
    let recorded = call(
        &transport,
        &handle,
        &mut id,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": claim, "sessionId": session_id, "updateBase64": next }),
    )
    .await;
    assert_eq!(recorded["lineageClaimId"], claim);
    assert_eq!(recorded["lineageOriginatedHere"], json!(true));
    let settled = call(
        &transport,
        &handle,
        &mut id,
        "ydoc.settle",
        json!({ "sessionId": session_id }),
    )
    .await;
    assert_eq!(
        settled["content"],
        json!("edited before enrollment and after")
    );

    let (origin_id, pushed) = {
        let state = relay.state.lock().expect("relay state");
        (
            state.local_origin_id.clone().expect("local origin id"),
            state.pushed_workspace_ops.clone(),
        )
    };
    let source_db = Connection::open(engine_db_path(&scratch).expect("source db path"))
        .expect("open source db");
    let peer_scratch = ScratchDir::new().expect("peer scratch");
    let mut peer = EngineStore::open(&engine_db_path(&peer_scratch).expect("peer db path"), 1_000)
        .expect("open peer");
    VersionedTextStore::new(&mut peer)
        .ensure_main_version(workspace_id, "main", 1, &NoFaults)
        .expect("peer main version");
    for op in &pushed {
        if op["opKind"] == "ydoc.update" {
            let sha = op["payload"]["updateBlobSha256"]
                .as_str()
                .expect("Y.Doc update sha");
            let bytes: Vec<u8> = source_db
                .query_row(
                    "SELECT bytes FROM binary_blobs WHERE sha256=?1",
                    [sha],
                    |row| row.get(0),
                )
                .expect("source Y.Doc blob");
            assert_eq!(peer.put_binary_blob(&bytes).expect("copy Y.Doc blob"), sha);
        }
        dohc_engine_sync::apply_replication_envelope(
            &mut peer,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &dohc_engine_sync::ReplicationEnvelope {
                settlement_admission: None,
                admitted_author_snapshot: None,
                workspace_id: workspace_id.to_owned(),
                origin_id: origin_id.clone(),
                origin_seq: op["originSeq"].as_i64().expect("origin seq"),
                relay_seq: Some(op["originSeq"].as_i64().expect("origin seq")),
                op_kind: op["opKind"].as_str().expect("op kind").to_owned(),
                payload: op["payload"].clone(),
                recorded_at_ms: op["recordedAtMs"].as_i64().expect("recorded at"),
            },
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        )
        .expect("peer applies source operation");
    }
    let peer_text: Option<String> = peer
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                 WHERE s.workspace_id=?1 AND s.version_id='main' \
                   AND s.path='notes/live-before-enrollment.md'",
                [workspace_id],
                |row| row.get(0),
            )
            .optional()
        })
        .expect("read clean peer head");
    assert_eq!(
        peer_text.as_deref(),
        Some("edited before enrollment"),
        "the first push must replicate a live lineage before its first settle"
    );
}

/// Opens a relay workspace without the capture driver, so only the RPCs a
/// test sends change the store.
async fn open_uncaptured_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    relay: &FakeRelay,
    workspace_id: &str,
) -> WorkspaceHandle {
    open_uncaptured_workspace_options(transport, scratch, relay, workspace_id, false).await
}

async fn open_uncaptured_workspace_options(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    relay: &FakeRelay,
    workspace_id: &str,
    reconcile_collections: bool,
) -> WorkspaceHandle {
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let opened = call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        request(
            1,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace_id,
                "captureMode": "none",
                "reconcileCollections": reconcile_collections,
                "relay": {
                    "baseUrl": relay.base_url,
                    "bearerToken": BEARER,
                    "allowInsecureLoopbackForTests": true,
                },
            }),
        ),
    )
    .await
    .expect("open workspace");
    serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle")
}

/// Moves what the source device pushed into the log other devices pull, with
/// the blobs its operations name. The fake relay acknowledges a push without
/// keeping it.
fn publish_pushed_ops(relay: &FakeRelay, workspace_id: &str, source: &ScratchDir) {
    let db =
        Connection::open(engine_db_path(source).expect("source db path")).expect("open source db");
    let mut state = relay.state.lock().expect("relay state");
    let origin_id: String = db
        .query_row(
            "SELECT origin_id FROM sync_identity WHERE workspace_id=?1",
            [workspace_id],
            |row| row.get(0),
        )
        .expect("source origin id");
    for op in std::mem::take(&mut state.pushed_workspace_ops) {
        for (field, value) in op["payload"].as_object().into_iter().flatten() {
            let Some(sha256) = value.as_str().filter(|_| field.ends_with("BlobSha256")) else {
                continue;
            };
            let binary: Option<Vec<u8>> = db
                .query_row(
                    "SELECT bytes FROM binary_blobs WHERE sha256=?1",
                    [sha256],
                    |row| row.get(0),
                )
                .optional()
                .expect("read binary blob");
            let bytes = match binary {
                Some(bytes) => bytes,
                None => db
                    .query_row("SELECT text FROM blobs WHERE sha256=?1", [sha256], |row| {
                        row.get::<_, String>(0)
                    })
                    .expect("read text blob")
                    .into_bytes(),
            };
            state.workspace_blobs.insert(sha256.to_owned(), bytes);
        }
        let relay_seq = i64::try_from(state.workspace_ops.len()).expect("relay seq") + 1;
        state.workspace_ops.push(json!({
            "relaySeq": relay_seq,
            "workspaceId": workspace_id,
            "originId": origin_id,
            "originSeq": op["originSeq"],
            "opKind": op["opKind"],
            "payload": op["payload"],
            "recordedAtMs": op["recordedAtMs"],
        }));
    }
}

async fn pull_and_commit(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
    workspace_id: &str,
) {
    let pull = call(
        transport,
        handle,
        id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(pull["hasMore"], false, "one page holds this test's log");
    if pull["pendingCursor"].is_object() {
        call(
            transport,
            handle,
            id,
            "sync.commitCursor",
            json!({ "workspaceId": workspace_id, "pendingCursor": pull["pendingCursor"] }),
        )
        .await;
    }
}

fn resync_requests(
    events: &mut tokio::sync::mpsc::Receiver<dohc_workspace_engine::EngineEventNotice>,
) -> Vec<Value> {
    std::iter::from_fn(|| events.try_recv().ok())
        .filter(|notice| notice.name == "ydoc.remoteUpdate")
        .map(|notice| notice.payload)
        .collect()
}

// Ordinary editor settlements do not export a companion moment through this
// uncaptured harness. Use the production exporter to exercise that wire pair.
fn journal_editor_settlement(scratch: &ScratchDir, workspace: &str, moment: &str) {
    let mut conn = Connection::open(engine_db_path(scratch).unwrap()).unwrap();
    // The engine writes this store at the same time. Wait for its write lock
    // as the engine's own connections do, rather than failing at once.
    conn.busy_timeout(Duration::from_millis(u64::from(
        ENGINE_SQLITE_BUSY_TIMEOUT_MS,
    )))
    .unwrap();
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    dohc_engine_sync::journal_moment_append_in_tx(&tx, workspace, moment).unwrap();
    tx.commit().unwrap();
}

async fn pull_materialize_and_commit(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
    workspace: &str,
) {
    let pull = call(
        transport,
        handle,
        id,
        "sync.pull",
        json!({"workspaceId":workspace}),
    )
    .await;
    assert_eq!(pull["hasMore"], false);
    if pull["pendingCursor"].is_object() {
        call(
            transport,
            handle,
            id,
            "sync.materializePendingCursor",
            json!({"workspaceId":workspace,"pendingCursor":pull["pendingCursor"]}),
        )
        .await;
        call(
            transport,
            handle,
            id,
            "sync.commitCursor",
            json!({"workspaceId":workspace,"pendingCursor":pull["pendingCursor"]}),
        )
        .await;
    }
}

async fn assert_open_document_artifact_recovery(exit: &str, local_edit: bool) {
    assert_open_document_artifact_recovery_inner(exit, local_edit, false, false).await;
}

async fn assert_open_document_artifact_recovery_inner(
    exit: &str,
    local_edit: bool,
    tail: bool,
    broken: bool,
) {
    let integrated = exit.starts_with("pending-") || exit.starts_with("integrated-");
    let workspace = "rpc-artifact-recovery";
    let path = "notes/shared.md";
    let relay = FakeRelay::start(RelayState::default());
    let b_scratch = ScratchDir::new().unwrap();
    let b_transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let b = open_uncaptured_workspace(&b_transport, &b_scratch, &relay, workspace).await;
    let mut b_id = 1;
    seed_main(&b_transport, &b, &mut b_id, workspace).await;
    seed_sync_identity(&b_transport, &b, &mut b_id, workspace).await;
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({"workspaceId":workspace}),
    )
    .await;
    let opened_b = call(
        &b_transport,
        &b,
        &mut b_id,
        "ydoc.open",
        json!({"versionId":"main","path":path,"contentKind":"plaintext"}),
    )
    .await;
    let session = opened_b["sessionId"].as_str().unwrap().to_owned();
    let doc = Ydoc::wire();
    let b_claim = call(&b_transport, &b, &mut b_id, "ydoc.recordUpdate", json!({ "expectedLineageClaimId": opened_b["lineageClaimId"], "sessionId":session,"updateBase64":base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0,"Before"))})).await["lineageClaimId"].clone();
    let settled = call(
        &b_transport,
        &b,
        &mut b_id,
        "ydoc.settle",
        json!({"sessionId":session}),
    )
    .await;
    journal_editor_settlement(&b_scratch, workspace, settled["momentId"].as_str().unwrap());
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({"workspaceId":workspace}),
    )
    .await;
    publish_pushed_ops(&relay, workspace, &b_scratch);

    let a_scratch = ScratchDir::new().unwrap();
    let mut a_service = Arc::new(EngineService::new());
    let mut a_transport = InProcessTransport::new(Arc::clone(&a_service));
    let mut a = open_uncaptured_workspace(&a_transport, &a_scratch, &relay, workspace).await;
    let mut a_id = 1;
    seed_main(&a_transport, &a, &mut a_id, workspace).await;
    seed_sync_identity(&a_transport, &a, &mut a_id, workspace).await;
    call(
        &a_transport,
        &a,
        &mut a_id,
        "sync.claim",
        json!({"workspaceId":workspace}),
    )
    .await;
    pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
    let session_a = call(
        &a_transport,
        &a,
        &mut a_id,
        "ydoc.open",
        json!({"versionId":"main","path":path,"contentKind":"plaintext"}),
    )
    .await["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    if local_edit {
        a_id += 1;
        let resync = service_call_with_busy_retry(
            a_service.as_ref(),
            RequestContext::unbounded().with_capability("blobs"),
            request(
                a_id,
                "ydoc.resync",
                Some(a.clone()),
                json!({"sessionId":session_a}),
            ),
        )
        .await
        .unwrap();
        let local = Ydoc::wire();
        local.apply(&resync.blob_egress.unwrap().bytes).unwrap();
        call(&a_transport, &a, &mut a_id, "ydoc.recordUpdate", json!({ "expectedLineageClaimId": resync.response.result["lineageClaimId"], "sessionId":session_a,"updateBase64":base64::engine::general_purpose::STANDARD.encode(local.plaintext_insert(0,"Local: "))})).await;
    }
    let b_claim = call(&b_transport, &b, &mut b_id, "ydoc.recordUpdate", json!({ "expectedLineageClaimId": b_claim, "sessionId":session,"updateBase64":base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(6," remote"))})).await["lineageClaimId"].clone();
    let settled = call(
        &b_transport,
        &b,
        &mut b_id,
        "ydoc.settle",
        json!({"sessionId":session}),
    )
    .await;
    if !integrated {
        journal_editor_settlement(&b_scratch, workspace, settled["momentId"].as_str().unwrap());
    }
    if tail {
        call(&b_transport, &b, &mut b_id, "ydoc.recordUpdate", json!({ "expectedLineageClaimId": b_claim, "sessionId":session,"updateBase64":base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(13," tail"))})).await;
    }
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({"workspaceId":workspace}),
    )
    .await;
    publish_pushed_ops(&relay, workspace, &b_scratch);
    pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
    assert_eq!(
        std::fs::read_to_string(a_scratch.path().join(path)).unwrap(),
        "Before"
    );
    if integrated {
        // Drain u1 into the live CRDT and publish the merged local/remote projection.
        a_id += 1;
        let resync = service_call_with_busy_retry(
            a_service.as_ref(),
            RequestContext::unbounded().with_capability("blobs"),
            request(
                a_id,
                "ydoc.resync",
                Some(a.clone()),
                json!({"sessionId":session_a}),
            ),
        )
        .await
        .unwrap();
        let merged = Ydoc::wire();
        merged.apply(&resync.blob_egress.unwrap().bytes).unwrap();
        assert_eq!(merged.plaintext_string(), "Local: Before remote");
        let db = Connection::open(engine_db_path(&a_scratch).unwrap()).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(
            db.query_row(
                "SELECT head_update_seq=settled_update_seq FROM ydoc_docs WHERE path=?1",
                [path],
                |r| r.get::<_, bool>(0)
            )
            .unwrap()
        );
        journal_editor_settlement(&b_scratch, workspace, settled["momentId"].as_str().unwrap());
        call(
            &b_transport,
            &b,
            &mut b_id,
            "sync.push",
            json!({"workspaceId":workspace}),
        )
        .await;
        publish_pushed_ops(&relay, workspace, &b_scratch);
        pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM ydoc_pending_artifacts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    let c_scratch = ScratchDir::new().unwrap();
    let c_transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let c = open_uncaptured_workspace(&c_transport, &c_scratch, &relay, workspace).await;
    let mut c_id = 1;
    seed_main(&c_transport, &c, &mut c_id, workspace).await;
    seed_sync_identity(&c_transport, &c, &mut c_id, workspace).await;
    call(
        &c_transport,
        &c,
        &mut c_id,
        "sync.claim",
        json!({"workspaceId":workspace}),
    )
    .await;
    pull_materialize_and_commit(&c_transport, &c, &mut c_id, workspace).await;
    let remote_text = std::fs::read_to_string(c_scratch.path().join(path)).unwrap();
    assert_eq!(
        remote_text,
        if tail {
            "Before remote tail"
        } else {
            "Before remote"
        }
    );
    let repaired_blobs = if broken {
        let db = Connection::open(engine_db_path(&a_scratch).unwrap()).unwrap();
        let saved=db.prepare("SELECT sha256,bytes FROM binary_blobs WHERE sha256 IN (SELECT json_extract(l.payload_json,'$.updateBlobSha256') FROM ydoc_deferred_updates d JOIN replication_log l USING(workspace_id,origin_id,origin_seq))").unwrap().query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Vec<u8>>(1)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        db.execute("UPDATE binary_blobs SET bytes=zeroblob(byte_length) WHERE sha256 IN (SELECT json_extract(l.payload_json,'$.updateBlobSha256') FROM ydoc_deferred_updates d JOIN replication_log l USING(workspace_id,origin_id,origin_seq))",[]).unwrap();
        call(&b_transport,&b,&mut b_id,"versionedText.write",json!({"versionId":"main","objectId":"healthy","path":"healthy.md","text":"Healthy file","momentId":"healthy-moment","origin":"api","nowMs":210})).await;
        call(
            &b_transport,
            &b,
            &mut b_id,
            "sync.push",
            json!({"workspaceId":workspace}),
        )
        .await;
        publish_pushed_ops(&relay, workspace, &b_scratch);
        saved
    } else {
        Vec::new()
    };
    let pending_attempt = exit.starts_with("pending-");
    if pending_attempt {
        let db = Connection::open(engine_db_path(&a_scratch).unwrap()).unwrap();
        // The real live resync above integrated u1. Reset its completed write to pending.
        db.execute("UPDATE ydoc_docs SET settle_prior_update_seq=0,settle_seq=(SELECT m.moment_order FROM moments m JOIN snapshots s ON s.latest_moment_id=m.moment_id WHERE s.path=?1)", [path]).unwrap();
        db.execute("INSERT INTO materialization_jobs(job_id,target_path,content_sha256,preimage_present,target_generation,created_at_ms,workspace_id) SELECT 'ydoc-mat_'||latest_moment_id,path,blob_sha256,1,999,0,workspace_id FROM snapshots WHERE path=?1 ON CONFLICT(job_id) DO UPDATE SET status='pending',completed_at_ms=NULL", [path]).unwrap();
    }
    let exit = match exit {
        "pending-pull" => "evict",
        "pending-open" | "integrated-open" => "workspace-close",
        "integrated-pull" => "evict",
        "integrated-crash" => "crash",
        other => other,
    };
    match exit {
        "evict" => {
            call(
                &a_transport,
                &a,
                &mut a_id,
                "ydoc.evict",
                json!({"sessionId":session_a}),
            )
            .await;
        }
        "workspace-close" => {
            call(&a_transport, &a, &mut a_id, "workspace.close", json!({})).await;
            a = open_uncaptured_workspace(&a_transport, &a_scratch, &relay, workspace).await;
        }
        "crash" => {
            drop(a_transport);
            drop(a_service);
            // Engine drop closes its store actor on a teardown thread. The
            // replacement open waits out a closing actor but would attach to a
            // registered one, so wait until the registry no longer holds it.
            let db = engine_db_path(&a_scratch).unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                while WorkspaceSupervisor::global()
                    .generation_of(&db)
                    .unwrap()
                    .is_some()
                {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("dropped engine must release its store actor");
            a_service = Arc::new(EngineService::new());
            a_transport = InProcessTransport::new(Arc::clone(&a_service));
            a = open_uncaptured_workspace(&a_transport, &a_scratch, &relay, workspace).await;
        }
        _ => unreachable!(),
    }
    if integrated {
        if pending_attempt && exit == "evict" {
            pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
            let db = Connection::open(engine_db_path(&a_scratch).unwrap()).unwrap();
            assert_eq!(
                db.query_row(
                    "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                    [],
                    |r| r.get::<_, Option<String>>(0)
                )
                .unwrap(),
                None
            );
            assert_eq!(
                db.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            call(&a_transport, &a, &mut a_id, "workspace.close", json!({})).await;
            a = open_uncaptured_workspace(&a_transport, &a_scratch, &relay, workspace).await;
        }
        if pending_attempt {
            let db = Connection::open(engine_db_path(&a_scratch).unwrap()).unwrap();
            assert_eq!(db.query_row("SELECT j.status FROM materialization_jobs j JOIN snapshots s ON j.job_id='ydoc-mat_'||s.latest_moment_id WHERE s.path=?1",[path],|r|r.get::<_,String>(0)).unwrap(),"complete");
        }
        // workspace.open has replayed the pending file job; pull reconciles the attempt.
        pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
        let db = Connection::open(engine_db_path(&a_scratch).unwrap()).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM ydoc_pending_artifacts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "completed live projection must release the mark"
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM replication_pending_refusals",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(db.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON s.blob_sha256=b.sha256 WHERE s.path=?1", [path], |r|r.get::<_,String>(0)).unwrap(),"Local: Before remote");
        if exit == "evict" && !pending_attempt {
            // Live resync already queued this projection's ordinary file job.
            // Reopening runs the production materialization replay for that job.
            call(&a_transport, &a, &mut a_id, "workspace.close", json!({})).await;
            a = open_uncaptured_workspace(&a_transport, &a_scratch, &relay, workspace).await;
        }
        assert_eq!(
            std::fs::read_to_string(a_scratch.path().join(path)).unwrap(),
            "Local: Before remote"
        );
        pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM ydoc_pending_artifacts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        call(&a_transport, &a, &mut a_id, "workspace.close", json!({})).await;
        call(&b_transport, &b, &mut b_id, "workspace.close", json!({})).await;
        call(&c_transport, &c, &mut c_id, "workspace.close", json!({})).await;
        return;
    }
    if exit != "evict" && !local_edit && !broken {
        assert_eq!(
            std::fs::read_to_string(a_scratch.path().join(path)).unwrap(),
            remote_text,
            "workspace open must recover without a pull"
        );
    }
    pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
    let db = Connection::open(engine_db_path(&a_scratch).unwrap()).unwrap();
    let head: String = db
        .query_row(
            "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.path=?1",
            [path],
            |r| r.get(0),
        )
        .unwrap();
    let expected = if local_edit || broken {
        "Before"
    } else {
        remote_text.as_str()
    };
    assert_eq!(head, expected, "{exit}");
    if !local_edit && !broken {
        let c_db = Connection::open(engine_db_path(&c_scratch).unwrap()).unwrap();
        let snapshot = |conn: &Connection| {
            conn.query_row(
                "SELECT latest_moment_id,blob_sha256,path FROM snapshots WHERE path=?1",
                [path],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap()
        };
        assert_eq!(
            snapshot(&db),
            snapshot(&c_db),
            "head matches the never-opened device after {exit}"
        );
    }
    let index: String = db
        .query_row(
            "SELECT text FROM engine_search_files_fts WHERE path=?1",
            [path],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(index, expected, "index after {exit}");
    assert_eq!(
        std::fs::read_to_string(a_scratch.path().join(path)).unwrap(),
        expected,
        "{exit}"
    );
    let marks = || {
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='ydoc_pending_artifacts')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        if exists {
            db.query_row("SELECT COUNT(*) FROM ydoc_pending_artifacts", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
        } else {
            0
        }
    };
    assert_eq!(marks(), i64::from(local_edit || broken));
    if local_edit {
        let reopened = call(
            &a_transport,
            &a,
            &mut a_id,
            "ydoc.open",
            json!({"versionId":"main","path":path,"contentKind":"plaintext"}),
        )
        .await;
        call(
            &a_transport,
            &a,
            &mut a_id,
            "ydoc.settle",
            json!({"sessionId":reopened["sessionId"]}),
        )
        .await;
        assert_eq!(
            std::fs::read_to_string(a_scratch.path().join(path)).unwrap(),
            "Local: Before remote"
        );
        assert_eq!(marks(), 0);
    }
    if broken {
        let notices = call(
            &a_transport,
            &a,
            &mut a_id,
            "sync.refusalNotices",
            json!({"workspaceId":workspace}),
        )
        .await;
        assert!(
            !notices["notices"].as_array().unwrap().is_empty(),
            "{notices:?}"
        );
        let parked: i64 = db
            .query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(parked > 0);
        assert_eq!(
            std::fs::read_to_string(a_scratch.path().join("healthy.md")).unwrap(),
            "Healthy file"
        );
        assert_eq!(notices["notices"][0]["document"]["path"], path);
        let attempted: String = db
            .query_row(
                "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                [],
                |r| r.get(0),
            )
            .unwrap();
        pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
        assert_eq!(marks(), 1);
        assert_eq!(
            db.query_row(
                "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            attempted
        );
        for (sha, bytes) in repaired_blobs {
            db.execute(
                "UPDATE binary_blobs SET bytes=?2 WHERE sha256=?1",
                rusqlite::params![sha, bytes],
            )
            .unwrap();
        }
        pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
        assert_eq!(marks(), 0);
        assert_eq!(
            std::fs::read_to_string(a_scratch.path().join(path)).unwrap(),
            remote_text
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let notices = call(
            &a_transport,
            &a,
            &mut a_id,
            "sync.refusalNotices",
            json!({"workspaceId":workspace}),
        )
        .await;
        assert!(notices["notices"].as_array().unwrap().is_empty());
    } else if tail {
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let settled = call(
            &b_transport,
            &b,
            &mut b_id,
            "ydoc.settle",
            json!({"sessionId":session}),
        )
        .await;
        journal_editor_settlement(&b_scratch, workspace, settled["momentId"].as_str().unwrap());
        call(
            &b_transport,
            &b,
            &mut b_id,
            "sync.push",
            json!({"workspaceId":workspace}),
        )
        .await;
        publish_pushed_ops(&relay, workspace, &b_scratch);
        pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace).await;
        assert_eq!(
            std::fs::read_to_string(a_scratch.path().join(path)).unwrap(),
            remote_text
        );
    }
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM conflicts", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM relay_deferred_ops", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn open_document_artifact_recovers_after_evict() {
    assert_open_document_artifact_recovery("evict", false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn open_document_artifact_recovers_after_workspace_close() {
    assert_open_document_artifact_recovery("workspace-close", false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn open_document_artifact_recovers_after_engine_drop() {
    assert_open_document_artifact_recovery("crash", false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn open_document_artifact_keeps_local_unsettled_edits() {
    assert_open_document_artifact_recovery("evict", true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn open_document_settlement_does_not_park_other_device_work() {
    let workspace_id = "rpc-relay-openhold";
    let path = "notes/shared.md";
    let relay = FakeRelay::start(RelayState::default());

    // Device B is signed in and synced before it starts the document, as a
    // desktop is. It then starts the document and pushes it.
    let b_scratch = ScratchDir::new().expect("device B scratch");
    let b_transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let b = open_uncaptured_workspace_options(&b_transport, &b_scratch, &relay, workspace_id, true)
        .await;
    let mut b_id = 1;
    seed_main(&b_transport, &b, &mut b_id, workspace_id).await;
    seed_sync_identity(&b_transport, &b, &mut b_id, workspace_id).await;
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    let b_opened = call(
        &b_transport,
        &b,
        &mut b_id,
        "ydoc.open",
        json!({ "versionId": "main", "path": path, "contentKind": "plaintext" }),
    )
    .await;
    let b_session = b_opened["sessionId"]
        .as_str()
        .expect("device B session id")
        .to_owned();
    let b_doc = Ydoc::wire();
    let record = |claim: &Value, update: Vec<u8>| {
        json!({
            "sessionId": b_session,
            "updateBase64": base64::engine::general_purpose::STANDARD.encode(update),
            "expectedLineageClaimId": claim,
        })
    };
    let b_claim = call(
        &b_transport,
        &b,
        &mut b_id,
        "ydoc.recordUpdate",
        record(
            &b_opened["lineageClaimId"],
            b_doc.plaintext_insert(0, "Starting together."),
        ),
    )
    .await["lineageClaimId"]
        .clone();
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    publish_pushed_ops(&relay, workspace_id, &b_scratch);

    let settlement = call(
        &b_transport,
        &b,
        &mut b_id,
        "ydoc.settle",
        json!({"sessionId":b_session}),
    )
    .await;
    journal_editor_settlement(
        &b_scratch,
        workspace_id,
        settlement["momentId"].as_str().unwrap(),
    );
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({"workspaceId":workspace_id}),
    )
    .await;
    publish_pushed_ops(&relay, workspace_id, &b_scratch);

    for (object, path, text, moment) in [
        (
            "schema",
            "tasks/collection.yaml",
            "fields:\n  title:\n    type: text\n",
            "schema-moment",
        ),
        (
            "record",
            "tasks/task.md",
            "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\ntitle: Before\n---\n",
            "record-before",
        ),
    ] {
        call(&b_transport, &b, &mut b_id, "versionedText.write", json!({"versionId":"main","objectId":object,"path":path,"text":text,"momentId":moment,"origin":"api","nowMs":150})).await;
    }
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({"workspaceId":workspace_id}),
    )
    .await;
    publish_pushed_ops(&relay, workspace_id, &b_scratch);

    // Device A pulls the document and opens it in an editor.
    let a_scratch = ScratchDir::new().expect("device A scratch");
    let a_service = Arc::new(EngineService::new());
    let a_transport = InProcessTransport::new(Arc::clone(&a_service));
    let a = open_uncaptured_workspace_options(&a_transport, &a_scratch, &relay, workspace_id, true)
        .await;
    let mut a_id = 1;
    seed_main(&a_transport, &a, &mut a_id, workspace_id).await;
    call(
        &a_transport,
        &a,
        &mut a_id,
        "chats.channels.create",
        json!({
            "channelId": "device-a-identity-channel",
            "name": "Device A",
            "kind": "channel",
            "nowMs": 10,
        }),
    )
    .await;
    call(
        &a_transport,
        &a,
        &mut a_id,
        "sync.claim",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace_id).await;
    let a_session = call(
        &a_transport,
        &a,
        &mut a_id,
        "ydoc.open",
        json!({ "versionId": "main", "path": path, "contentKind": "plaintext" }),
    )
    .await["sessionId"]
        .as_str()
        .expect("device A session id")
        .to_owned();
    let mut events = a_service.events().subscribe();

    let a_doc = Ydoc::wire();
    a_id += 1;
    let initial = ProtocolEngineService::call(
        a_service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            a_id,
            "ydoc.resync",
            Some(a.clone()),
            json!({"sessionId":a_session}),
        ),
    )
    .await
    .unwrap();
    let a_claim = initial.response.result["lineageClaimId"].clone();
    a_doc.apply(&initial.blob_egress.unwrap().bytes).unwrap();
    call(&a_transport, &a, &mut a_id, "ydoc.recordUpdate", json!({ "expectedLineageClaimId": a_claim, "sessionId":a_session,"updateBase64":base64::engine::general_purpose::STANDARD.encode(a_doc.plaintext_insert(0, "A: "))})).await;
    call(
        &b_transport,
        &b,
        &mut b_id,
        "ydoc.recordUpdate",
        record(&b_claim, b_doc.plaintext_insert(18, " Typed on B.")),
    )
    .await;
    let settlement = call(
        &b_transport,
        &b,
        &mut b_id,
        "ydoc.settle",
        json!({"sessionId":b_session}),
    )
    .await;
    journal_editor_settlement(
        &b_scratch,
        workspace_id,
        settlement["momentId"].as_str().unwrap(),
    );
    call(&b_transport, &b, &mut b_id, "versionedText.write", json!({"versionId":"main","objectId":"other","path":"other.md","text":"Later file","momentId":"other-moment","origin":"api","nowMs":210})).await;
    call(&b_transport, &b, &mut b_id, "versionedText.write", json!({"versionId":"main","objectId":"record","path":"tasks/task.md","text":"---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\ntitle: After\n---\n","momentId":"record-after","origin":"api","nowMs":215})).await;
    call(
        &b_transport,
        &b,
        &mut b_id,
        "chats.channels.create",
        json!({"channelId":"later-chat","name":"Later chat","kind":"channel","nowMs":220}),
    )
    .await;
    call(&b_transport, &b, &mut b_id, "chats.threads.start", json!({"channelId":"later-chat","threadId":"later-thread","messageId":"later-message","authorKind":"human","authorDisplayName":"B","authorUserId":"b","body":"Later message","needsDecision":false,"nowMs":230})).await;
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({"workspaceId":workspace_id}),
    )
    .await;
    publish_pushed_ops(&relay, workspace_id, &b_scratch);
    pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace_id).await;
    let notice = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let notice = events.recv().await.unwrap();
            if notice.name == "ydoc.remoteUpdate" {
                break notice;
            }
        }
    })
    .await
    .expect("remote update event");
    assert_eq!(notice.payload["sessionId"], a_session);
    assert_eq!(notice.payload["resyncRequired"], true);
    let db = Connection::open(engine_db_path(&a_scratch).unwrap()).unwrap();
    let later_file: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM snapshots WHERE path='other.md'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let later_message: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM chat_messages WHERE message_id='later-message'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let record_after: i64 = db.query_row("SELECT COUNT(*) FROM snapshots s JOIN blobs b ON s.blob_sha256=b.sha256 WHERE s.path='tasks/task.md' AND b.text LIKE '%title: After%'", [], |r|r.get(0)).unwrap();
    let deferred: i64 = db
        .query_row("SELECT COUNT(*) FROM relay_deferred_ops", [], |r| r.get(0))
        .unwrap();
    println!(
        "OPENHOLD rpc before-close file={later_file} record={record_after} message={later_message} deferred={deferred}"
    );
    let record = call(
        &a_transport,
        &a,
        &mut a_id,
        "collections.getRecord",
        json!({"collectionPath":"tasks","recordId":"rec_aaaaaaaaaaaaaaaaaaaaaaaaaa","historyLimit":50}),
    )
    .await;
    let title_after = record["record"]["values"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field["field"] == "title" && field["value"] == "After");
    a_id += 1;
    let resync = ProtocolEngineService::call(
        a_service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            a_id,
            "ydoc.resync",
            Some(a.clone()),
            json!({"sessionId":a_session}),
        ),
    )
    .await
    .unwrap();
    a_doc.apply(&resync.blob_egress.unwrap().bytes).unwrap();
    assert_eq!(
        a_doc.plaintext_string(),
        "A: Starting together. Typed on B."
    );
    a_id += 1;
    let settled = a_transport
        .call(
            RequestContext::unbounded(),
            request(
                a_id,
                "ydoc.settle",
                Some(a.clone()),
                json!({"sessionId":a_session}),
            ),
        )
        .await;

    a_id += 1;
    let closed = a_transport
        .call(
            RequestContext::unbounded(),
            request(
                a_id,
                "ydoc.close",
                Some(a.clone()),
                json!({"sessionId":a_session}),
            ),
        )
        .await;

    pull_materialize_and_commit(&a_transport, &a, &mut a_id, workspace_id).await;
    let conflicts: i64 = db
        .query_row("SELECT COUNT(*) FROM conflicts", [], |r| r.get(0))
        .unwrap();
    let after_deferred: i64 = db
        .query_row("SELECT COUNT(*) FROM relay_deferred_ops", [], |r| r.get(0))
        .unwrap();
    println!("OPENHOLD rpc after-close conflicts={conflicts} deferred={after_deferred}");
    assert!(title_after, "{record:?}");
    assert!(settled.is_ok(), "{settled:?}");
    assert!(closed.is_ok(), "{closed:?}");
    assert_eq!(
        (later_file, record_after, later_message, deferred),
        (1, 1, 1, 0)
    );
    {
        let state = relay.state.lock().unwrap();
        let last = state.workspace_ops.last().unwrap();
        let ack: i64 = db
            .query_row(
                "SELECT acked_seq FROM replication_peers WHERE workspace_id=?1 AND origin_id=?2",
                rusqlite::params![workspace_id, last["originId"].as_str().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ack, last["originSeq"].as_i64().unwrap());
    }
    assert_eq!((conflicts, after_deferred), (0, 0));
    assert_eq!(
        std::fs::read_to_string(a_scratch.path().join(path)).unwrap(),
        "A: Starting together. Typed on B."
    );

    let c_scratch = ScratchDir::new().unwrap();
    let c_transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let c = open_uncaptured_workspace_options(&c_transport, &c_scratch, &relay, workspace_id, true)
        .await;
    let mut c_id = 1;
    seed_main(&c_transport, &c, &mut c_id, workspace_id).await;
    seed_sync_identity(&c_transport, &c, &mut c_id, workspace_id).await;
    call(
        &c_transport,
        &c,
        &mut c_id,
        "sync.claim",
        json!({"workspaceId":workspace_id}),
    )
    .await;
    pull_materialize_and_commit(&c_transport, &c, &mut c_id, workspace_id).await;

    journal_editor_settlement(
        &a_scratch,
        workspace_id,
        settled.as_ref().unwrap().result["momentId"]
            .as_str()
            .unwrap(),
    );
    call(
        &a_transport,
        &a,
        &mut a_id,
        "sync.push",
        json!({"workspaceId":workspace_id}),
    )
    .await;
    publish_pushed_ops(&relay, workspace_id, &a_scratch);
    pull_materialize_and_commit(&b_transport, &b, &mut b_id, workspace_id).await;
    call(
        &b_transport,
        &b,
        &mut b_id,
        "ydoc.close",
        json!({"sessionId":b_session}),
    )
    .await;
    pull_materialize_and_commit(&c_transport, &c, &mut c_id, workspace_id).await;
    for (device, scratch) in [("A", &a_scratch), ("B", &b_scratch), ("C", &c_scratch)] {
        assert_eq!(
            std::fs::read_to_string(scratch.path().join(path)).unwrap(),
            "A: Starting together. Typed on B."
        );
        let conn = Connection::open(engine_db_path(scratch).unwrap()).unwrap();
        for table in ["conflicts", "relay_deferred_ops", "ydoc_deferred_updates"] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0,
                "{device} {table}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pull_asks_an_idle_open_editor_to_resync_and_the_resync_shows_the_other_device_edit() {
    let workspace_id = "rpc-relay-idle-editor";
    let path = "notes/shared.md";
    let relay = FakeRelay::start(RelayState::default());

    // Device B is signed in and synced before it starts the document, as a
    // desktop is. It then starts the document and pushes it.
    let b_scratch = ScratchDir::new().expect("device B scratch");
    let b_transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let b = open_uncaptured_workspace(&b_transport, &b_scratch, &relay, workspace_id).await;
    let mut b_id = 1;
    seed_main(&b_transport, &b, &mut b_id, workspace_id).await;
    seed_sync_identity(&b_transport, &b, &mut b_id, workspace_id).await;
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    let b_opened = call(
        &b_transport,
        &b,
        &mut b_id,
        "ydoc.open",
        json!({ "versionId": "main", "path": path, "contentKind": "plaintext" }),
    )
    .await;
    let b_session = b_opened["sessionId"]
        .as_str()
        .expect("device B session id")
        .to_owned();
    let b_doc = Ydoc::wire();
    let record = |claim: &Value, update: Vec<u8>| {
        json!({
            "sessionId": b_session,
            "updateBase64": base64::engine::general_purpose::STANDARD.encode(update),
            "expectedLineageClaimId": claim,
        })
    };
    let b_claim = call(
        &b_transport,
        &b,
        &mut b_id,
        "ydoc.recordUpdate",
        record(
            &b_opened["lineageClaimId"],
            b_doc.plaintext_insert(0, "Starting together."),
        ),
    )
    .await["lineageClaimId"]
        .clone();
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    publish_pushed_ops(&relay, workspace_id, &b_scratch);

    // Device A pulls the document and opens it in an editor.
    let a_scratch = ScratchDir::new().expect("device A scratch");
    let a_service = Arc::new(EngineService::new());
    let a_transport = InProcessTransport::new(Arc::clone(&a_service));
    let a = open_uncaptured_workspace(&a_transport, &a_scratch, &relay, workspace_id).await;
    let mut a_id = 1;
    seed_main(&a_transport, &a, &mut a_id, workspace_id).await;
    call(
        &a_transport,
        &a,
        &mut a_id,
        "chats.channels.create",
        json!({
            "channelId": "device-a-identity-channel",
            "name": "Device A",
            "kind": "channel",
            "nowMs": 10,
        }),
    )
    .await;
    call(
        &a_transport,
        &a,
        &mut a_id,
        "sync.claim",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    pull_and_commit(&a_transport, &a, &mut a_id, workspace_id).await;
    let a_session = call(
        &a_transport,
        &a,
        &mut a_id,
        "ydoc.open",
        json!({ "versionId": "main", "path": path, "contentKind": "plaintext" }),
    )
    .await["sessionId"]
        .as_str()
        .expect("device A session id")
        .to_owned();
    let mut events = a_service.events().subscribe();

    // A pull that parks nothing for the editor asks nothing of it.
    push_unrelated_change(&b_transport, &b, &mut b_id, workspace_id, "before-edit").await;
    publish_pushed_ops(&relay, workspace_id, &b_scratch);
    pull_and_commit(&a_transport, &a, &mut a_id, workspace_id).await;
    assert_eq!(resync_requests(&mut events), Vec::<Value>::new());

    // B types while A's editor sits idle. A's pull parks the edit under the
    // editor's lease and asks that editor to resync.
    call(
        &b_transport,
        &b,
        &mut b_id,
        "ydoc.recordUpdate",
        record(&b_claim, b_doc.plaintext_insert(18, " Typed on B.")),
    )
    .await;
    call(
        &b_transport,
        &b,
        &mut b_id,
        "sync.push",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    publish_pushed_ops(&relay, workspace_id, &b_scratch);
    pull_and_commit(&a_transport, &a, &mut a_id, workspace_id).await;
    let asked = vec![json!({ "sessionId": a_session, "resyncRequired": true })];
    assert_eq!(
        resync_requests(&mut events),
        asked,
        "the pull must ask the idle editor for the edit it parked"
    );

    // The request is lost: with no receiver the engine drops events, as it
    // does when the event queue is full. The next pull applies nothing and
    // still asks, because the edit is still parked.
    drop(events);
    pull_and_commit(&a_transport, &a, &mut a_id, workspace_id).await;
    let mut events = a_service.events().subscribe();
    pull_and_commit(&a_transport, &a, &mut a_id, workspace_id).await;
    assert_eq!(
        resync_requests(&mut events),
        asked,
        "a pull that applies nothing must ask again while the edit stays parked"
    );

    // The resync the request asks for carries B's edit to the editor.
    a_id += 1;
    let resync = ProtocolEngineService::call(
        a_service.as_ref(),
        RequestContext::unbounded().with_capability("blobs"),
        request(
            a_id,
            "ydoc.resync",
            Some(a.clone()),
            json!({ "sessionId": a_session }),
        ),
    )
    .await
    .expect("resync the editor");
    let shown = Ydoc::wire();
    shown
        .apply(&resync.blob_egress.expect("resync state").bytes)
        .expect("apply resync state");
    assert_eq!(shown.plaintext_string(), "Starting together. Typed on B.");

    // The resync drained what was parked, so the next pull asks nothing.
    pull_and_commit(&a_transport, &a, &mut a_id, workspace_id).await;
    assert_eq!(resync_requests(&mut events), Vec::<Value>::new());
}

/// Creates a channel on the device and pushes it: an applied pull on the
/// other device with no Y.Doc update in it.
async fn push_unrelated_change(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
    workspace_id: &str,
    channel_id: &str,
) {
    call(
        transport,
        handle,
        id,
        "chats.channels.create",
        json!({ "channelId": channel_id, "name": channel_id, "kind": "channel", "nowMs": 20 }),
    )
    .await;
    call(
        transport,
        handle,
        id,
        "sync.push",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
}

// The push that claims an idle open document can be dropped at any point:
// the supervisor drops a request on cancellation or deadline. Wherever the
// drop lands, the claim and its handover to the session happen together or
// not at all, so the session's next write, under the claim its resync shows,
// and its settle still succeed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_push_dropped_while_claiming_an_open_document_leaves_its_next_edit_working() {
    let relay = FakeRelay::start(RelayState::default());
    let drop_points: Vec<(u32, u64)> = [0, 1, 2, 4, 8, 16, 32, 64, 128]
        .into_iter()
        .map(|yields| (yields, 0))
        .chain([1, 2, 5, 10, 20].into_iter().map(|ms| (0, ms)))
        .collect();
    for (round, (yields, sleep_ms)) in drop_points.into_iter().enumerate() {
        let scratch = ScratchDir::new().expect("scratch");
        let service = Arc::new(EngineService::new());
        let transport = Arc::new(InProcessTransport::new(Arc::clone(&service)));
        let workspace_id = format!("rpc-relay-dropped-live-claim-{round}");
        let handle = open_workspace(&transport, &scratch, &relay, 1, &workspace_id).await;
        let mut id = 1;
        seed_main(&transport, &handle, &mut id, &workspace_id).await;
        let opened = call(
            &transport,
            &handle,
            &mut id,
            "ydoc.open",
            json!({
                "versionId": "main",
                "path": "notes/idle.md",
                "contentKind": "plaintext",
            }),
        )
        .await;
        let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
        let doc = Ydoc::wire();
        let first_edit =
            base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "idle"));
        call(
            &transport,
            &handle,
            &mut id,
            "ydoc.recordUpdate",
            json!({ "expectedLineageClaimId": opened["lineageClaimId"], "sessionId": session_id, "updateBase64": first_edit }),
        )
        .await;
        seed_sync_identity(&transport, &handle, &mut id, &workspace_id).await;

        id += 1;
        let pushing = Arc::clone(&transport);
        let push_request = request(
            id,
            "sync.push",
            Some(handle.clone()),
            json!({ "workspaceId": workspace_id }),
        );
        let push = tokio::spawn(async move {
            pushing
                .call(RequestContext::unbounded(), push_request)
                .await
        });
        for _ in 0..yields {
            tokio::task::yield_now().await;
        }
        if sleep_ms > 0 {
            tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
        }
        push.abort();
        let _ = push.await;

        id += 1;
        let resynced = ProtocolEngineService::call(
            service.as_ref(),
            RequestContext::unbounded().with_capability("blobs"),
            request(
                id,
                "ydoc.resync",
                Some(handle.clone()),
                json!({ "sessionId": session_id }),
            ),
        )
        .await
        .expect("resync the editor");
        let claim = resynced.response.result["lineageClaimId"].clone();
        drop(resynced);
        let next_edit =
            base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(4, " then"));
        call(
            &transport,
            &handle,
            &mut id,
            "ydoc.recordUpdate",
            json!({ "expectedLineageClaimId": claim, "sessionId": session_id, "updateBase64": next_edit }),
        )
        .await;
        let settled = call(
            &transport,
            &handle,
            &mut id,
            "ydoc.settle",
            json!({ "sessionId": session_id }),
        )
        .await;
        assert_eq!(
            settled["content"],
            json!("idle then"),
            "drop point {round}: yields {yields}, sleep {sleep_ms} ms"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_relay_rpc_round_trips_through_dispatch_against_fake_transport() {
    let relay = FakeRelay::start(RelayState::default());
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let workspace_id = "rpc-relay-roundtrip";
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.create",
        json!({ "channelId": "channel", "name": "Shared", "kind": "channel", "nowMs": 10 }),
    )
    .await;

    call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel", "threadId": "first-thread", "messageId": "first-message",
            "authorKind": "human", "authorDisplayName": "Ada", "authorUserId": "ada",
            "body": "Written before sync setup", "needsDecision": false, "nowMs": 20,
        }),
    )
    .await;

    id += 1;
    let missing = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "sync.push",
                Some(handle.clone()),
                json!({ "workspaceId": workspace_id }),
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(missing.code, ErrorCode::IdentityRequired);
    assert!(relay.state.lock().unwrap().requests.is_empty());
    call(
        &transport,
        &handle,
        &mut id,
        "sync.claim",
        json!({ "workspaceId": workspace_id }),
    )
    .await;

    assert_eq!(
        call(
            &transport,
            &handle,
            &mut id,
            "sync.push",
            json!({ "workspaceId": workspace_id }),
        )
        .await["status"],
        "complete"
    );
    let pull = call(
        &transport,
        &handle,
        &mut id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "sync.commitCursor",
        json!({ "workspaceId": workspace_id, "pendingCursor": pull["pendingCursor"] }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "sync.probe",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "sync.claim",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(
        call(
            &transport,
            &handle,
            &mut id,
            "keys.upload",
            json!({
                "workspaceId": workspace_id,
                "envelopeJson": "{\"ciphertext\":\"opaque\"}",
                "ifMatch": ETAG,
            }),
        )
        .await["etag"],
        ETAG
    );
    assert_eq!(
        call(
            &transport,
            &handle,
            &mut id,
            "keys.download",
            json!({ "workspaceId": workspace_id }),
        )
        .await["envelopeJson"],
        "{\"ciphertext\":\"opaque\"}"
    );
    call(
        &transport,
        &handle,
        &mut id,
        "share.channel.push",
        json!({
            "workspaceId": workspace_id,
            "shareId": "roundtrip-channel",
            "channelWireId": "channel",
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "share.channel.pull",
        json!({
            "workspaceId": workspace_id,
            "shareId": "roundtrip-channel",
            "channelWireId": "channel",
        }),
    )
    .await;
    let view = call(
        &transport,
        &handle,
        &mut id,
        "share.view.pull",
        json!({
            "workspaceId": workspace_id,
            "shareId": "roundtrip-view",
            "grantedSelector": { "paths": ["notes"], "versionId": "shared-version", "access": "view" },
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "sync.commitCursor",
        json!({ "workspaceId": workspace_id, "pendingCursor": view["pendingCursor"] }),
    )
    .await;
    let recovered = call(
        &transport,
        &handle,
        &mut id,
        "sync.recoverOrigin",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_ne!(recovered["oldOriginId"], recovered["newOriginId"]);

    let state = relay.state.lock().expect("relay state");
    assert!(
        state
            .requests
            .iter()
            .any(|row| row == &("POST".into(), format!("/sync/{workspace_id}/log")))
    );
    assert!(
        state
            .requests
            .iter()
            .any(|row| row == &("GET".into(), format!("/sync/{workspace_id}/log")))
    );
    assert!(
        state
            .requests
            .iter()
            .any(|row| row == &("POST".into(), "/sync/workspaces".into()))
    );
    assert!(
        state
            .requests
            .iter()
            .any(|row| row == &("PUT".into(), format!("/sync/{workspace_id}/keys")))
    );
    assert!(
        state
            .requests
            .iter()
            .any(|row| row == &("GET".into(), format!("/sync/{workspace_id}/keys")))
    );
    assert!(
        state
            .requests
            .iter()
            .any(|row| row == &("POST".into(), "/sync/shares/roundtrip-channel/log".into()))
    );
    assert!(
        state
            .requests
            .iter()
            .any(|row| row == &("GET".into(), "/sync/shares/roundtrip-channel/log".into()))
    );
    assert!(
        state
            .requests
            .iter()
            .any(|row| row == &("GET".into(), "/sync/shares/roundtrip-view/log".into()))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn join_identity_adoption_is_local_idempotent_and_refuses_non_pristine_rebinding() {
    let relay = FakeRelay::start(RelayState::default());
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let workspace_id = "rpc-relay-join-adoption";
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;

    id += 1;
    let invalid = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "sync.adoptJoinIdentity",
                Some(handle.clone()),
                json!({
                    "workspaceId": workspace_id,
                    "replicationEpoch": " epoch-relay",
                    "streamIdentity": "stream-relay",
                }),
            ),
        )
        .await
        .expect_err("relay identity text must use the canonical form");
    assert_eq!(invalid.code, ErrorCode::InvalidParams);
    let db = Connection::open(engine_db_path(&scratch).expect("engine db path"))
        .expect("open inspection connection");
    let identity_count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM sync_identity WHERE workspace_id=?1",
            [workspace_id],
            |row| row.get(0),
        )
        .expect("identity count after invalid adoption");
    assert_eq!(identity_count, 0, "invalid adoption must not write a row");

    let adopted = call(
        &transport,
        &handle,
        &mut id,
        "sync.adoptJoinIdentity",
        json!({
            "workspaceId": workspace_id,
            "replicationEpoch": "epoch-relay",
            "streamIdentity": "stream-relay",
        }),
    )
    .await;
    assert_eq!(adopted["adopted"], true);

    let identity: (String, String, String) = db
        .query_row(
            "SELECT origin_id,replication_epoch,stream_identity FROM sync_identity \
             WHERE workspace_id=?1",
            [workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("joined identity");
    assert!(identity.0.starts_with("origin_"));
    assert_eq!(identity.1, "epoch-relay");
    assert_eq!(identity.2, "stream-relay");

    let retry = call(
        &transport,
        &handle,
        &mut id,
        "sync.adoptJoinIdentity",
        json!({
            "workspaceId": workspace_id,
            "replicationEpoch": "epoch-relay",
            "streamIdentity": "stream-relay",
        }),
    )
    .await;
    assert_eq!(retry["adopted"], true);
    let retried_origin: String = db
        .query_row(
            "SELECT origin_id FROM sync_identity WHERE workspace_id=?1",
            [workspace_id],
            |row| row.get(0),
        )
        .expect("retried origin");
    assert_eq!(retried_origin, identity.0);

    seed_local_identity(&transport, &handle, &mut id).await;
    id += 1;
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "sync.adoptJoinIdentity",
                Some(handle.clone()),
                json!({
                    "workspaceId": workspace_id,
                    "replicationEpoch": "epoch-other",
                    "streamIdentity": "stream-other",
                }),
            ),
        )
        .await
        .expect_err("non-pristine coordinate replacement must fail closed");
    assert_eq!(refused.code, ErrorCode::InvalidParams);
    let unchanged: (String, String) = db
        .query_row(
            "SELECT replication_epoch,stream_identity FROM sync_identity WHERE workspace_id=?1",
            [workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("unchanged identity");
    assert_eq!(
        unchanged,
        ("epoch-relay".to_owned(), "stream-relay".to_owned())
    );
    assert!(
        relay.state.lock().expect("relay state").requests.is_empty(),
        "identity adoption is a local prerequisite and must not contact the relay"
    );
    drop(db);
    close(&transport, &handle, &mut id).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pull_returns_fast_forwarded_text_and_binary_paths_for_materialization() {
    let workspace_id = "rpc-relay-changed-paths";
    let text = b"remote text".to_vec();
    let binary = b"\0remote binary\xff".to_vec();
    let text_sha = hex_sha256(&text);
    let binary_sha = hex_sha256(&binary);
    let relay = FakeRelay::start(RelayState {
        workspace_ops: vec![
            workspace_row(
                1,
                workspace_id,
                "remote",
                0,
                "moment.append",
                absent_moment_payload(
                    "remote-text",
                    "text-object",
                    "notes/remote.md",
                    &text_sha,
                    "text",
                    text.len(),
                ),
            ),
            workspace_row(
                2,
                workspace_id,
                "remote",
                1,
                "moment.append",
                absent_moment_payload(
                    "remote-binary",
                    "binary-object",
                    "assets/remote.bin",
                    &binary_sha,
                    "binary",
                    binary.len(),
                ),
            ),
        ],
        workspace_blobs: HashMap::from([(text_sha, text), (binary_sha, binary)]),
        ..RelayState::default()
    });
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;
    seed_sync_identity(&transport, &handle, &mut id, workspace_id).await;

    let pull = call(
        &transport,
        &handle,
        &mut id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(
        pull["changedPaths"],
        json!([
            {
                "versionId": "main",
                "path": "assets/remote.bin",
                "operation": "write",
                "contentKind": "binary",
            },
            {
                "versionId": "main",
                "path": "notes/remote.md",
                "operation": "write",
                "contentKind": "text",
            },
        ])
    );
    assert!(pull["pendingCursor"].is_object());

    let redelivered = call(
        &transport,
        &handle,
        &mut id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(
        redelivered["changedPaths"], pull["changedPaths"],
        "an uncommitted redelivery must repeat every path still requiring materialization"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn slow_relay_pull_does_not_block_a_concurrent_workspace_write() {
    let workspace_id = "rpc-relay-nonblocking-http";
    let started = Arc::new(AtomicBool::new(false));
    let relay = FakeRelay::start(RelayState {
        workspace_log_delay: Some(Duration::from_secs(1)),
        workspace_log_started: Some(Arc::clone(&started)),
        ..RelayState::default()
    });
    let scratch = ScratchDir::new().expect("scratch");
    let service = Arc::new(EngineService::new());
    let transport = Arc::new(InProcessTransport::new(service));
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;
    seed_sync_identity(&transport, &handle, &mut id, workspace_id).await;

    let pulling_transport = Arc::clone(&transport);
    let pulling_handle = handle.clone();
    let pull = tokio::spawn(async move {
        pulling_transport
            .call(
                RequestContext::unbounded(),
                request(
                    10_000,
                    "sync.pull",
                    Some(pulling_handle),
                    json!({ "workspaceId": workspace_id }),
                ),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while !started.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("relay pull started");

    let write = transport.call(
        RequestContext::unbounded(),
        request(
            10_001,
            "chats.channels.create",
            Some(handle.clone()),
            json!({
                "channelId": "concurrent",
                "name": "Concurrent",
                "kind": "channel",
                "nowMs": 50,
            }),
        ),
    );
    tokio::time::timeout(Duration::from_millis(250), write)
        .await
        .expect("workspace write was blocked by relay HTTP")
        .expect("concurrent write");
    pull.await.expect("join pull").expect("pull");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pull_without_commit_keeps_persisted_cursor_unmoved_and_redelivers() {
    let workspace_id = "rpc-relay-deferred-cursor";
    let relay = FakeRelay::start(RelayState {
        workspace_ops: vec![workspace_row(
            1,
            workspace_id,
            "remote",
            0,
            "workspace.init",
            json!({}),
        )],
        ..RelayState::default()
    });
    let scratch = ScratchDir::new().expect("scratch");
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
    let mut id = 1;
    let handle = open_workspace(&transport, &scratch, &relay, id, workspace_id).await;
    seed_main(&transport, &handle, &mut id, workspace_id).await;
    seed_sync_identity(&transport, &handle, &mut id, workspace_id).await;
    let first = call(
        &transport,
        &handle,
        &mut id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(first["fetched"], 1);
    close(&transport, &handle, &mut id).await;

    let db_path = engine_db_path(&scratch).expect("engine db path");
    let db = Connection::open(&db_path).expect("open engine db");
    let persisted: Option<String> = db
        .query_row(
            "SELECT cursor FROM sync_relay_cursors WHERE workspace_id=?1",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()
        .expect("read relay cursor");
    assert_eq!(persisted, None);
    drop(db);

    let handle = open_workspace(&transport, &scratch, &relay, id + 1, workspace_id).await;
    let second = call(
        &transport,
        &handle,
        &mut id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(second["fetched"], 1);
    assert_eq!(second["skipped"], 1);
    call(
        &transport,
        &handle,
        &mut id,
        "sync.commitCursor",
        json!({ "workspaceId": workspace_id, "pendingCursor": second["pendingCursor"] }),
    )
    .await;
    close(&transport, &handle, &mut id).await;
    let db = Connection::open(db_path).expect("open engine db");
    let persisted: String = db
        .query_row(
            "SELECT cursor FROM sync_relay_cursors WHERE workspace_id=?1",
            [workspace_id],
            |row| row.get(0),
        )
        .expect("persisted relay cursor");
    assert_eq!(persisted, "1");
}

/// Commit a pulled cursor through the real supervisor while the session lock
/// is held. The commit's follow-up waits on that lock, so the request is
/// stopped after its cursor is durable and before it answers. A cancelled
/// commit keeps waiting for the lock; an expired one stops at its deadline
/// and answers while the lock is still held.
async fn commit_stopped_after_its_cursor_lands(expire: bool) {
    let workspace_id = if expire {
        "rpc-relay-commit-expired"
    } else {
        "rpc-relay-commit-cancelled"
    };
    let relay = FakeRelay::start(RelayState {
        workspace_ops: vec![workspace_row(
            1,
            workspace_id,
            "remote",
            0,
            "workspace.init",
            json!({}),
        )],
        ..RelayState::default()
    });
    let scratch = ScratchDir::new().expect("scratch");
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
    let mut id = 1;
    let handle = open_workspace(&transport, &scratch, &relay, id, workspace_id).await;
    seed_main(&transport, &handle, &mut id, workspace_id).await;
    seed_sync_identity(&transport, &handle, &mut id, workspace_id).await;
    let pulled = call(
        &transport,
        &handle,
        &mut id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    let db_path = engine_db_path(&scratch).expect("engine db path");
    let stored_cursor = || {
        Connection::open(&db_path)
            .expect("open engine db")
            .query_row(
                "SELECT cursor FROM sync_relay_cursors WHERE workspace_id=?1",
                [workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .expect("read relay cursor")
    };
    assert_eq!(stored_cursor(), None);

    let session_ops = service
        .session_ops_for_harness(&handle)
        .await
        .expect("session lock");
    let supervisor = Supervisor::new(SupervisorConfig::default(), Arc::clone(&service));
    id += 1;
    let mut commit = request(
        id,
        "sync.commitCursor",
        Some(handle.clone()),
        json!({ "workspaceId": workspace_id, "pendingCursor": pulled["pendingCursor"] }),
    );
    commit.deadline_ms = Some(60_000);
    let mut answer = supervisor.try_submit(commit).expect("admitted");
    let waiting = std::time::Instant::now();
    while stored_cursor().is_none() {
        assert!(
            waiting.elapsed() < Duration::from_secs(10),
            "the cursor commit never landed"
        );
        tokio::task::yield_now().await;
    }
    let held = if expire {
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(61)).await;
        Some(session_ops)
    } else {
        assert!(supervisor.cancel(id));
        tokio::task::yield_now().await;
        assert!(
            matches!(
                answer.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ),
            "the landed commit is answered by its handler"
        );
        drop(session_ops);
        None
    };
    let committed = answer
        .await
        .expect("answered")
        .expect("a commit stopped after its cursor landed answers committed");
    drop(held);
    if expire {
        tokio::time::resume();
    }
    assert_eq!(committed.response.result["committed"], json!(true));
    assert_eq!(stored_cursor().as_deref(), Some("1"));
    id += 1;
    let spent = supervisor
        .try_submit(request(
            id,
            "sync.commitCursor",
            Some(handle.clone()),
            json!({ "workspaceId": workspace_id, "pendingCursor": pulled["pendingCursor"] }),
        ))
        .expect("admitted")
        .await
        .expect("answered")
        .expect_err("a landed commit spends its token");
    assert_eq!(spent.message, "invalid-pending-cursor");
    close(&transport, &handle, &mut id).await;
}

#[tokio::test]
async fn a_commit_cancelled_after_its_cursor_lands_answers_committed() {
    commit_stopped_after_its_cursor_lands(false).await;
}

#[tokio::test]
async fn a_commit_expired_after_its_cursor_lands_answers_committed() {
    commit_stopped_after_its_cursor_lands(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_page_pull_keeps_relation_to_target_arriving_on_second_page() {
    const SOURCE_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TARGET_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    let workspace_id = "rpc-relay-two-page-relation";
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let db_path = engine_db_path(&scratch).expect("engine db path");
    let mut store = EngineStore::open(&db_path, 1_000).expect("open store");
    store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(workspace_id, "main", 1, &NoFaults)
        .expect("main version");
    let schema = "fields:\n  title:\n    type: text\n  related:\n    type: relation\n    collection: tasks\n    many: false\n";
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "two-page-relation-schema".to_owned(),
                path: "tasks/collection.yaml".to_owned(),
                text: schema.to_owned(),
                moment_id: "two-page-relation-schema-moment".to_owned(),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("seed collection schema");
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, workspace_id, "main")
        })
        .expect("reconcile schema");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));
    let collection_dir = scratch.path().join("tasks");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), schema).expect("schema file");
    drop(store);

    let source = format!("---\nid: {SOURCE_ID}\ntitle: Source\nrelated: {TARGET_ID}\n---\n");
    let target = format!("---\nid: {TARGET_ID}\ntitle: Target\n---\n");
    let source_sha = hex_sha256(source.as_bytes());
    let target_sha = hex_sha256(target.as_bytes());
    let pass_limit = i64::try_from(dohc_engine_sync::MAX_PULL_OPS).expect("pull pass limit");
    let mut workspace_ops =
        Vec::with_capacity(usize::try_from(pass_limit + 1).expect("two-page operation capacity"));
    workspace_ops.push(workspace_row(
        1,
        workspace_id,
        "remote-device",
        0,
        "moment.append",
        absent_moment_payload(
            "source-moment",
            "source-object",
            "tasks/source.md",
            &source_sha,
            "text",
            source.len(),
        ),
    ));
    for origin_seq in 1..pass_limit {
        workspace_ops.push(workspace_row(
            origin_seq + 1,
            workspace_id,
            "remote-device",
            origin_seq,
            "workspace.init",
            json!({}),
        ));
    }
    workspace_ops.push(workspace_row(
        pass_limit + 1,
        workspace_id,
        "remote-device",
        pass_limit,
        "moment.append",
        absent_moment_payload(
            "target-moment",
            "target-object",
            "tasks/target.md",
            &target_sha,
            "text",
            target.len(),
        ),
    ));
    let relay = FakeRelay::start(RelayState {
        workspace_ops,
        workspace_blobs: HashMap::from([
            (source_sha, source.into_bytes()),
            (target_sha, target.into_bytes()),
        ]),
        ..RelayState::default()
    });
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let mut id = 1;
    let handle = open_workspace(&transport, &scratch, &relay, id, workspace_id).await;
    seed_sync_identity(&transport, &handle, &mut id, workspace_id).await;
    flush_capture(&transport, &handle, &mut id).await;

    let first = call(
        &transport,
        &handle,
        &mut id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(first["fetched"], pass_limit);
    assert!(!first["pendingCursor"].is_null(), "page one must continue");
    flush_capture(&transport, &handle, &mut id).await;
    call(
        &transport,
        &handle,
        &mut id,
        "sync.commitCursor",
        json!({
            "workspaceId": workspace_id,
            "pendingCursor": first["pendingCursor"],
        }),
    )
    .await;

    let second = call(
        &transport,
        &handle,
        &mut id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(second["fetched"], 1);
    assert_eq!(second["hasMore"], false, "page two must finish the pull");
    assert!(
        !second["pendingCursor"].is_null(),
        "the final data page still requires cursor commit"
    );
    flush_capture(&transport, &handle, &mut id).await;
    call(
        &transport,
        &handle,
        &mut id,
        "sync.commitCursor",
        json!({
            "workspaceId": workspace_id,
            "pendingCursor": second["pendingCursor"],
        }),
    )
    .await;
    // The terminal commit ends the pull, and capture then reconciles.
    flush_capture(&transport, &handle, &mut id).await;

    let source_record = call(
        &transport,
        &handle,
        &mut id,
        "collections.getRecord",
        json!({
            "collectionPath": "tasks",
            "recordId": SOURCE_ID,
            "historyLimit": 50,
        }),
    )
    .await;
    let relation = source_record["record"]["values"]
        .as_array()
        .expect("source values")
        .iter()
        .find(|value| value["field"] == "related")
        .expect("source relation");
    assert_eq!(relation["value"], json!(TARGET_ID));
    assert!(
        source_record["history"]
            .as_array()
            .expect("source history")
            .iter()
            .all(|entry| entry["authorOriginId"] != "engine"),
        "a partial pull must not create an engine-authored relation drop"
    );
}

/// A watched workspace with an unfinished ordinary pull: capture saves a new
/// record's file, and its Collections update waits. The relay then refuses a
/// claim for good, which abandons the pull, and capture binds the record with
/// no other edit or request to reconcile.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_final_claim_refusal_wakes_capture_for_the_update_the_pull_held_back() {
    const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    let workspace_id = "rpc-relay-claim-refusal-wakes-capture";
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let db_path = engine_db_path(&scratch).expect("engine db path");
    let mut store = EngineStore::open(&db_path, 1_000).expect("open store");
    store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(workspace_id, "main", 1, &NoFaults)
        .expect("main version");
    drop(store);
    Connection::open(&db_path)
        .expect("engine db")
        .execute(
            "INSERT INTO sync_identity \
             (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms,ordinary_pull_token) \
             VALUES (?1,'local-origin','epoch','stream',1,'unfinished')",
            [workspace_id],
        )
        .expect("unfinished pull");
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"fields:\n  title:\n    type: text\n",
    );
    write_file(
        scratch.path(),
        "tasks/a.md",
        format!("---\nid: {RECORD_ID}\ntitle: First\n---\n").as_bytes(),
    );
    let relay = FakeRelay::start(RelayState::default());
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    flush_capture(&transport, &handle, &mut id).await;
    let db = Connection::open(&db_path).expect("engine db");
    let count = |query: &str| -> i64 {
        db.query_row(query, [], |row| row.get(0))
            .expect("count rows")
    };
    let bound = || count("SELECT COUNT(*) FROM collection_records WHERE file_path='tasks/a.md'");
    assert_eq!(
        count("SELECT COUNT(*) FROM snapshots WHERE path='tasks/a.md'"),
        1,
        "capture saved the file"
    );
    assert_eq!(bound(), 0, "the Collections update waits for the pull");

    relay.state.lock().expect("relay state").refuse_claims = true;
    id += 1;
    transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "sync.claim",
                Some(handle.clone()),
                json!({ "workspaceId": workspace_id }),
            ),
        )
        .await
        .expect_err("the claim answers with its refusal");
    assert_eq!(
        count("SELECT COUNT(*) FROM sync_identity WHERE ordinary_pull_token IS NULL"),
        1,
        "the refusal abandoned the pull"
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while bound() == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "capture never ran the woken update"
        );
        call(&transport, &handle, &mut id, "capture.flush", json!({})).await;
    }
    close(&transport, &handle, &mut id).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn commit_cursor_accepts_only_the_server_issued_pending_token() {
    let workspace_id = "rpc-relay-issued-cursor";
    let relay = FakeRelay::start(RelayState {
        workspace_ops: vec![workspace_row(
            1,
            workspace_id,
            "remote",
            0,
            "workspace.init",
            json!({}),
        )],
        ..RelayState::default()
    });
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;
    seed_sync_identity(&transport, &handle, &mut id, workspace_id).await;
    let pull = call(
        &transport,
        &handle,
        &mut id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    let issued = pull["pendingCursor"].clone();

    let mut forged_fields = issued.clone();
    forged_fields["cursor"] = json!(10_000);
    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                20_000,
                "sync.commitCursor",
                Some(handle.clone()),
                json!({
                    "workspaceId": workspace_id,
                    "pendingCursor": forged_fields,
                }),
            ),
        )
        .await
        .expect_err("mutated pending cursor must be rejected");
    assert_eq!(error.code, ErrorCode::InvalidParams);

    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                20_001,
                "sync.commitCursor",
                Some(handle.clone()),
                json!({
                    "workspaceId": workspace_id,
                    "pendingCursor": {
                        "kind": "relay",
                        "token": "never-issued",
                    },
                }),
            ),
        )
        .await
        .expect_err("unknown pending token must be rejected");
    assert_eq!(error.code, ErrorCode::InvalidParams);

    let committed = transport
        .call(
            RequestContext::unbounded(),
            request(
                20_002,
                "sync.commitCursor",
                Some(handle.clone()),
                json!({
                    "workspaceId": workspace_id,
                    "pendingCursor": issued,
                }),
            ),
        )
        .await
        .expect("issued pending token commits");
    assert_eq!(committed.result["committed"], true);

    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                20_003,
                "sync.commitCursor",
                Some(handle),
                json!({
                    "workspaceId": workspace_id,
                    "pendingCursor": issued,
                }),
            ),
        )
        .await
        .expect_err("consumed pending token must be stale");
    assert_eq!(error.code, ErrorCode::InvalidParams);
    assert_eq!(error.message, "invalid-pending-cursor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn newer_pull_token_supersedes_the_older_token_for_the_same_scope() {
    let workspace_id = "rpc-relay-superseded-cursor";
    let relay = FakeRelay::start(RelayState {
        workspace_ops: vec![workspace_row(
            1,
            workspace_id,
            "remote",
            0,
            "workspace.init",
            json!({}),
        )],
        ..RelayState::default()
    });
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;
    seed_sync_identity(&transport, &handle, &mut id, workspace_id).await;
    let first = call(
        &transport,
        &handle,
        &mut id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    let second = call(
        &transport,
        &handle,
        &mut id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    let stale = transport
        .call(
            RequestContext::unbounded(),
            request(
                id + 10,
                "sync.commitCursor",
                Some(handle.clone()),
                json!({
                    "workspaceId": workspace_id,
                    "pendingCursor": first["pendingCursor"].clone(),
                }),
            ),
        )
        .await
        .expect_err("older token must be superseded");
    assert_eq!(stale.message, "invalid-pending-cursor");
    let committed = call(
        &transport,
        &handle,
        &mut id,
        "sync.commitCursor",
        json!({
            "workspaceId": workspace_id,
            "pendingCursor": second["pendingCursor"].clone(),
        }),
    )
    .await;
    assert_eq!(
        committed["committed"], true,
        "keeping every issued token permits stale cursor commits and leaks abandoned entries"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_new_rpc_refuses_a_cross_workspace_handle_before_transport() {
    let relay = FakeRelay::start(RelayState::default());
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 1, "bound-workspace").await;
    let methods = [
        ("sync.push", json!({ "workspaceId": "other" })),
        ("sync.pull", json!({ "workspaceId": "other" })),
        ("sync.refusalNotices", json!({ "workspaceId": "other" })),
        (
            "sync.dismissRefusal",
            json!({ "workspaceId": "other", "noticeId": "sync-refusal-missing", "refusalCoordinates": [] }),
        ),
        (
            "sync.commitCursor",
            json!({
                "workspaceId": "other",
                "pendingCursor": {
                    "kind": "relay",
                    "token": "not-issued",
                },
            }),
        ),
        ("sync.probe", json!({ "workspaceId": "other" })),
        ("sync.claim", json!({ "workspaceId": "other" })),
        ("sync.resetClaimRefusal", json!({ "workspaceId": "other" })),
        (
            "sync.adoptJoinIdentity",
            json!({
                "workspaceId": "other",
                "replicationEpoch": "epoch",
                "streamIdentity": "stream",
            }),
        ),
        ("sync.recoverOrigin", json!({ "workspaceId": "other" })),
        (
            "keys.upload",
            json!({ "workspaceId": "other", "envelopeJson": "{}" }),
        ),
        ("keys.download", json!({ "workspaceId": "other" })),
        (
            "share.channel.pull",
            json!({ "workspaceId": "other", "shareId": "share", "channelWireId": "wire" }),
        ),
        (
            "share.channel.push",
            json!({ "workspaceId": "other", "shareId": "share", "channelWireId": "wire" }),
        ),
        (
            "share.view.pull",
            json!({ "workspaceId": "other", "shareId": "share", "grantedSelector": { "paths": ["notes"], "versionId": "shared-version", "access": "view" } }),
        ),
    ];
    for (index, (method, params)) in methods.into_iter().enumerate() {
        let error = transport
            .call(
                RequestContext::unbounded(),
                request(
                    u64::try_from(index + 2).expect("request id"),
                    method,
                    Some(handle.clone()),
                    params,
                ),
            )
            .await
            .expect_err("cross-workspace RPC must fail");
        assert_eq!(error.code, ErrorCode::InvalidParams, "{method}");
        assert_eq!(error.message, "invalid-workspace", "{method}");
    }
    assert!(relay.state.lock().expect("relay state").requests.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn account_change_resets_only_refused_claims_without_contacting_relay() {
    let relay = FakeRelay::start(RelayState::default());
    let scratch = ScratchDir::new().unwrap();
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let workspace_id = "reset-refusal";
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_local_identity(&transport, &handle, &mut id).await;
    let db = Connection::open(engine_db_path(&scratch).unwrap()).unwrap();
    for state in [Some("workspace-unavailable"), Some("pending"), None] {
        db.execute(
            "UPDATE sync_identity SET claim_state=?1 WHERE workspace_id=?2",
            rusqlite::params![state, workspace_id],
        )
        .unwrap();
        call(
            &transport,
            &handle,
            &mut id,
            "sync.resetClaimRefusal",
            json!({ "workspaceId": workspace_id }),
        )
        .await;
        let actual: Option<String> = db
            .query_row(
                "SELECT claim_state FROM sync_identity WHERE workspace_id=?1",
                [workspace_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(actual.as_deref(), state.map(|_| "pending"));
    }
    assert!(relay.state.lock().unwrap().requests.is_empty());
    db.execute(
        "UPDATE sync_identity SET claim_state='workspace-unavailable', claim_account_id='account-a' WHERE workspace_id=?1",
        [workspace_id],
    )
    .unwrap();
    close(&transport, &handle, &mut id).await;
    id += 1;
    let handle = open_workspace(&transport, &scratch, &relay, id, workspace_id).await;
    call(
        &transport,
        &handle,
        &mut id,
        "sync.resetClaimRefusal",
        json!({ "workspaceId": workspace_id, "accountId": "account-a" }),
    )
    .await;
    assert_eq!(
        db.query_row(
            "SELECT claim_state FROM sync_identity WHERE workspace_id=?1",
            [workspace_id],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "workspace-unavailable"
    );
    call(
        &transport,
        &handle,
        &mut id,
        "sync.resetClaimRefusal",
        json!({ "workspaceId": workspace_id, "accountId": "account-b" }),
    )
    .await;
    id += 1;
    let missing = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "sync.push",
                Some(handle.clone()),
                json!({ "workspaceId": workspace_id }),
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(missing.code, ErrorCode::IdentityRequired);
    call(
        &transport,
        &handle,
        &mut id,
        "sync.claim",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "sync.push",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shared_channel_pull_drops_own_echo_and_renumbers_each_source_densely() {
    let workspace_id = "rpc-shared-channel";
    let relay = FakeRelay::start(RelayState::default());
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.channels.create",
        json!({ "channelId": "channel", "name": "Shared", "kind": "channel", "nowMs": 10 }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "chats.threads.start",
        json!({
            "channelId": "channel",
            "threadId": "thread",
            "messageId": "message",
            "authorKind": "human",
            "authorDisplayName": "Ada",
            "authorUserId": "ada",
            "body": "hello",
            "needsDecision": false,
            "nowMs": 20,
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "sync.claim",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "sync.push",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    {
        let mut state = relay.state.lock().expect("relay state");
        let channel = state
            .pushed_workspace_ops
            .iter()
            .find(|op| op["opKind"] == "chat.channel.create")
            .cloned()
            .expect("channel op");
        let thread = state
            .pushed_workspace_ops
            .iter()
            .find(|op| op["opKind"] == "chat.thread.create")
            .cloned()
            .expect("thread op");
        state.share_ops.insert(
            "shared-channel".to_owned(),
            vec![
                share_row(
                    1,
                    "relay:share-member:authenticated-origin",
                    400,
                    channel["opKind"].as_str().expect("kind"),
                    channel["payload"].clone(),
                ),
                share_row(
                    2,
                    "member-a",
                    10,
                    channel["opKind"].as_str().expect("kind"),
                    channel["payload"].clone(),
                ),
                share_row(
                    3,
                    "member-a",
                    90,
                    thread["opKind"].as_str().expect("kind"),
                    thread["payload"].clone(),
                ),
                share_row(
                    4,
                    "member-b",
                    700,
                    channel["opKind"].as_str().expect("kind"),
                    channel["payload"].clone(),
                ),
            ],
        );
    }
    let pulled = call(
        &transport,
        &handle,
        &mut id,
        "share.channel.pull",
        json!({
            "workspaceId": workspace_id,
            "shareId": "shared-channel",
            "channelWireId": "channel",
        }),
    )
    .await;
    assert_eq!(pulled["applied"], 3);
    assert_eq!(pulled["skipped"], 1);
    close(&transport, &handle, &mut id).await;

    let db = Connection::open(engine_db_path(&scratch).expect("engine db path"))
        .expect("open engine db");
    let rows = db
        .prepare(
            "SELECT origin_id,origin_seq FROM replication_log \
             WHERE workspace_id=?1 AND origin_id LIKE 'shared:shared-channel:%' \
             ORDER BY origin_id,origin_seq",
        )
        .expect("prepare dense query")
        .query_map([workspace_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .expect("query dense rows")
        .collect::<Result<Vec<_>, _>>()
        .expect("dense rows");
    assert_eq!(
        rows,
        vec![
            ("shared:shared-channel:member-a".to_owned(), 0),
            ("shared:shared-channel:member-a".to_owned(), 1),
            ("shared:shared-channel:member-b".to_owned(), 0),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shared_channel_stale_selector_reports_refusal_and_advances_cursor() {
    let workspace_id = "rpc-shared-channel-stale-selector";
    let share_id = "stale-selector-share";
    let mut state = RelayState::default();
    state.share_ops.insert(
        share_id.to_owned(),
        vec![share_row(
            1,
            "granter",
            0,
            "chat.channel.create",
            json!({
                "channelId": "channel",
                "name": "Shared",
                "slug": "shared",
                "kind": "channel",
                "createdAtMs": 1,
                "wireId": "wire-current",
            }),
        )],
    );
    let relay = FakeRelay::start(state);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;

    let pulled = call(
        &transport,
        &handle,
        &mut id,
        "share.channel.pull",
        json!({
            "workspaceId": workspace_id,
            "shareId": share_id,
            "channelWireId": "wire-stale",
        }),
    )
    .await;
    assert_eq!(pulled["applied"], 0);
    assert_eq!(pulled["refused"], 1);
    assert_eq!(pulled["rejections"][0]["originId"], "granter");
    assert_eq!(pulled["rejections"][0]["originSeq"], 0);
    assert_eq!(
        pulled["rejections"][0]["reason"],
        "share-boundary-violation"
    );
    close(&transport, &handle, &mut id).await;

    let db = Connection::open(engine_db_path(&scratch).expect("engine db path"))
        .expect("open engine db");
    let cursor: Option<String> = db
        .query_row(
            "SELECT cursor FROM shared_channel_cursors WHERE workspace_id=?1 AND share_id=?2",
            [workspace_id, share_id],
            |row| row.get(0),
        )
        .optional()
        .expect("read shared channel cursor");
    assert_eq!(
        cursor.as_deref(),
        Some("1"),
        "a reported boundary rejection must be consumed so it cannot wedge the stream"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn share_view_pull_is_read_only_and_defers_its_persisted_cursor() {
    let workspace_id = "rpc-share-view";
    let share_id = "view-share";
    let bytes = b"shared view body".to_vec();
    let sha = hex_sha256(&bytes);
    let mut state = RelayState::default();
    state.share_ops.insert(
        share_id.to_owned(),
        vec![
            share_row(
                1,
                "granter",
                5,
                "version.create",
                json!({
                    "versionId": "shared-version",
                    "forkSnapshots": [{
                        "path": "notes/view.md",
                        "blobSha256": sha,
                        "contentKind": "text",
                    }],
                }),
            ),
            share_row(
                2,
                "granter",
                6,
                "moment.append",
                json!({
                    // The version this share granted: the secret-path refusal
                    // below must be what stops this op, not the version rule.
                    "versionId": "shared-version",
                    "operation": "write",
                    "path": ".env",
                    "payloadAfterPath": ".env",
                    "payloadAfterBlobSha256": sha,
                }),
            ),
        ],
    );
    state
        .share_blobs
        .insert((share_id.to_owned(), sha.clone()), bytes);
    let relay = FakeRelay::start(state);
    let scratch = ScratchDir::new().expect("scratch");
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
    let mut id = 1;
    let handle = open_workspace(&transport, &scratch, &relay, id, workspace_id).await;
    seed_main(&transport, &handle, &mut id, workspace_id).await;
    let pulled = call(
        &transport,
        &handle,
        &mut id,
        "share.view.pull",
        json!({
            "workspaceId": workspace_id,
            "shareId": share_id,
            "grantedSelector": { "paths": ["notes"], "versionId": "shared-version", "access": "view" },
        }),
    )
    .await;
    assert_eq!(pulled["fetched"], 2);
    assert_eq!(pulled["hasMore"], false);
    assert_eq!(pulled["applied"], 1);
    assert_eq!(pulled["changedPaths"][0]["path"], "notes/view.md");
    assert_eq!(pulled["pendingCursor"]["kind"], "shareView");
    // The skipped op's REASON crosses the wire. A pull that skips and keeps
    // going is the right call, and it is also how a shared view quietly stops
    // carrying part of what the granter shares — the client can only tell the
    // user because this rides along.
    assert_eq!(pulled["skipped"], 1);
    assert_eq!(pulled["refusals"][0]["opKind"], "moment.append");
    assert_eq!(
        pulled["refusals"][0]["code"], "share-boundary-violation",
        "dropping refusals from the wire leaves the client a bare count: {}",
        pulled["refusals"]
    );
    assert!(
        pulled["refusals"][0]["detail"]
            .as_str()
            .expect("refusal detail")
            .contains("outside the share boundary")
    );
    assert_eq!(
        relay
            .state
            .lock()
            .expect("relay state")
            .share_posts
            .get(share_id),
        None
    );
    let pending = pulled["pendingCursor"].clone();

    let db_path = engine_db_path(&scratch).expect("engine db path");
    let db = Connection::open(&db_path).expect("open engine db");
    let cursor: Option<String> = db
        .query_row(
            "SELECT cursor FROM share_view_cursors WHERE workspace_id=?1 AND share_id=?2",
            [workspace_id, share_id],
            |row| row.get(0),
        )
        .optional()
        .expect("read share view cursor");
    assert_eq!(cursor, None);
    let materialized: String = db
        .query_row(
            "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
             WHERE s.workspace_id=?1 AND s.version_id='main' AND s.path='notes/view.md'",
            [workspace_id],
            |row| row.get(0),
        )
        .expect("replayed share view content");
    assert_eq!(materialized, "shared view body");
    drop(db);

    call(
        &transport,
        &handle,
        &mut id,
        "sync.commitCursor",
        json!({ "workspaceId": workspace_id, "pendingCursor": pending }),
    )
    .await;
    close(&transport, &handle, &mut id).await;
    let db = Connection::open(db_path).expect("open engine db");
    let cursor: String = db
        .query_row(
            "SELECT cursor FROM share_view_cursors WHERE workspace_id=?1 AND share_id=?2",
            [workspace_id, share_id],
            |row| row.get(0),
        )
        .expect("persisted share view cursor");
    assert_eq!(cursor, "2");
}

/// Four wire states a permissive parser would let through, all refused
/// before the relay is called, so a pull that enforces no containment cannot
/// be requested at all:
///
/// 1. `grantedSelector` absent.
/// 2. `grantedSelector` explicitly `null` — what a permissive `Option` would
///    read as absent while looking declared.
/// 3. `access` absent.
/// 4. `access` naming a level this process cannot read.
///
/// A grant whose level cannot be read is not a narrower grant, it is an
/// unreadable one — see `ShareAccess::parse`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn share_view_pull_refuses_an_unreadable_granted_selector() {
    let workspace_id = "rpc-share-view-no-selector";
    let relay = FakeRelay::start(RelayState::default());
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let mut id = 1;
    let handle = open_workspace(&transport, &scratch, &relay, id, workspace_id).await;
    seed_main(&transport, &handle, &mut id, workspace_id).await;
    let unscoped = [
        json!({ "workspaceId": workspace_id, "shareId": "share" }),
        json!({ "workspaceId": workspace_id, "shareId": "share", "grantedSelector": null }),
        json!({
            "workspaceId": workspace_id,
            "shareId": "share",
            "grantedSelector": { "paths": ["notes"], "versionId": "shared-version" },
        }),
        json!({
            "workspaceId": workspace_id,
            "shareId": "share",
            "grantedSelector": { "paths": ["notes"], "versionId": "shared-version", "access": "View" },
        }),
    ];
    for params in unscoped {
        id += 1;
        let error = transport
            .call(
                RequestContext::unbounded(),
                request(id, "share.view.pull", Some(handle.clone()), params.clone()),
            )
            .await
            .expect_err("an unscoped share view pull is accepted");
        assert_eq!(error.code, ErrorCode::InvalidParams, "{params}");
    }
    assert!(
        relay.state.lock().expect("relay state").requests.is_empty(),
        "the pull reaches the relay before the selector is required"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn share_view_pull_skips_a_malformed_entry_and_reports_the_skip() {
    let workspace_id = "rpc-share-view-malformed";
    let share_id = "malformed-view-share";
    let bytes = b"valid after malformed".to_vec();
    let sha = hex_sha256(&bytes);
    let mut state = RelayState::default();
    state.share_ops.insert(
        share_id.to_owned(),
        vec![
            share_row(1, "", 0, "workspace.init", json!({})),
            share_row(
                2,
                "granter",
                0,
                "version.create",
                json!({
                    "versionId": "shared-version",
                    "forkSnapshots": [{
                        "path": "notes/after-malformed.md",
                        "blobSha256": sha,
                        "contentKind": "text",
                    }],
                }),
            ),
        ],
    );
    state.share_blobs.insert((share_id.to_owned(), sha), bytes);
    let relay = FakeRelay::start(state);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;

    let pulled = call(
        &transport,
        &handle,
        &mut id,
        "share.view.pull",
        json!({
            "workspaceId": workspace_id,
            "shareId": share_id,
            "grantedSelector": { "paths": ["notes"], "versionId": "shared-version", "access": "view" },
        }),
    )
    .await;
    assert_eq!(pulled["fetched"], 2);
    assert_eq!(pulled["applied"], 1);
    assert_eq!(pulled["skipped"], 1);
    assert_eq!(
        pulled["changedPaths"][0]["path"],
        "notes/after-malformed.md"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn share_view_rename_validates_replacement_before_removing_old_path() {
    let workspace_id = "rpc-share-view-rename-integrity";
    let share_id = "rename-integrity-share";
    let old_bytes = b"old shared content".to_vec();
    let old_sha = hex_sha256(&old_bytes);
    let replacement_sha = hex_sha256(b"expected replacement");
    let mut state = RelayState::default();
    state.share_ops.insert(
        share_id.to_owned(),
        vec![share_row(
            1,
            "granter",
            0,
            "version.create",
            json!({
                "versionId": "shared-version",
                "forkSnapshots": [{
                    "path": "notes/old.md",
                    "blobSha256": old_sha,
                    "contentKind": "text",
                }],
            }),
        )],
    );
    state
        .share_blobs
        .insert((share_id.to_owned(), old_sha), old_bytes);
    state.share_blobs.insert(
        (share_id.to_owned(), replacement_sha.clone()),
        b"corrupt replacement".to_vec(),
    );
    let relay = FakeRelay::start(state);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;

    let initial = call(
        &transport,
        &handle,
        &mut id,
        "share.view.pull",
        json!({
            "workspaceId": workspace_id,
            "shareId": share_id,
            "grantedSelector": { "paths": ["notes"], "versionId": "shared-version", "access": "view" },
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        &mut id,
        "sync.commitCursor",
        json!({
            "workspaceId": workspace_id,
            "pendingCursor": initial["pendingCursor"].clone(),
        }),
    )
    .await;
    relay
        .state
        .lock()
        .expect("relay state")
        .share_ops
        .get_mut(share_id)
        .expect("share log")
        .push(share_row(
            2,
            "granter",
            1,
            "moment.append",
            json!({
                // The version this share granted, so the corrupt replacement
                // below is what rejects the rename, not the version rule.
                "versionId": "shared-version",
                "operation": "rename",
                "path": "notes/new.md",
                "payloadBeforePath": "notes/old.md",
                "payloadAfterPath": "notes/new.md",
                "payloadAfterBlobSha256": replacement_sha.clone(),
                "payloadAfterContentKind": "text",
            }),
        ));

    // A body that does not hash to the sha its op named is repairable at the
    // relay, so the pull stops rather than committing past content that is
    // still coming. The retry below is the recovery, and it works because the
    // cursor never moved.
    let rename = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "share.view.pull",
                Some(handle.clone()),
                json!({
                    "workspaceId": workspace_id,
                    "shareId": share_id,
                    "grantedSelector": { "paths": ["notes"], "versionId": "shared-version", "access": "view" },
                }),
            ),
        )
        .await
        .expect_err("corrupt replacement must reject the rename");
    assert_eq!(rename.code, ErrorCode::BlobInvalid);

    let db = Connection::open(engine_db_path(&scratch).expect("engine db path"))
        .expect("open engine db");
    let old_exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM path_aliases \
             WHERE workspace_id=?1 AND version_id='main' AND path='notes/old.md')",
            [workspace_id],
            |row| row.get(0),
        )
        .expect("read old projection");
    assert!(
        old_exists,
        "a rejected rename must leave the old projected path intact"
    );
    drop(db);

    relay.state.lock().expect("relay state").share_blobs.insert(
        (share_id.to_owned(), replacement_sha),
        b"expected replacement".to_vec(),
    );
    let retried = call(
        &transport,
        &handle,
        &mut id,
        "share.view.pull",
        json!({
            "workspaceId": workspace_id,
            "shareId": share_id,
            "grantedSelector": { "paths": ["notes"], "versionId": "shared-version", "access": "view" },
        }),
    )
    .await;
    assert_eq!(retried["changedPaths"].as_array().map(Vec::len), Some(2));
    close(&transport, &handle, &mut id).await;

    let db = Connection::open(engine_db_path(&scratch).expect("engine db path"))
        .expect("open engine db");
    let paths: (bool, bool) = db
        .query_row(
            "SELECT \
               EXISTS(SELECT 1 FROM path_aliases WHERE workspace_id=?1 \
                 AND version_id='main' AND path='notes/old.md'), \
               EXISTS(SELECT 1 FROM path_aliases WHERE workspace_id=?1 \
                 AND version_id='main' AND path='notes/new.md')",
            [workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read retried rename projection");
    assert_eq!(paths, (false, true));
}

/// `sync.remoteChanges` answers the engine's durable count of changes from
/// elsewhere, with no relay configured, and the count survives reopening.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_changes_answer_the_durable_count_without_a_relay() {
    const WORKSPACE: &str = "ws-remote-changes";
    let scratch = ScratchDir::new().expect("scratch");
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    {
        let db = engine_db_path(&scratch).expect("engine db path");
        let mut store = EngineStore::open(&db, 1).expect("open store");
        store.bind_root_token(TOKEN, &NoFaults).expect("bind token");
        for _ in 0..2 {
            store
                .write_with(&NoFaults, |tx| {
                    dohc_engine_storage::count_remote_change_in_tx(tx, WORKSPACE)
                })
                .expect("count a change from elsewhere");
        }
    }
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let mut id = 0;
    for _ in 0..2 {
        id += 1;
        let opened = call_with_busy_retry(
            &transport,
            RequestContext::unbounded(),
            request(
                id,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": WORKSPACE,
                    "captureMode": "none",
                }),
            ),
        )
        .await
        .expect("open workspace");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle");
        assert_eq!(
            call(
                &transport,
                &handle,
                &mut id,
                "sync.remoteChanges",
                json!({})
            )
            .await,
            json!({ "applied": 2 })
        );
        call(&transport, &handle, &mut id, "workspace.close", json!({})).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refusal_notices_list_and_dismiss_without_a_relay() {
    let scratch = ScratchDir::new().unwrap();
    write_root_binding(scratch.path(), TOKEN).unwrap();
    let db = engine_db_path(&scratch).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        store.bind_root_token(TOKEN, &NoFaults).unwrap();
        let envelope = dohc_engine_sync::ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "ws-refusal".into(),
            origin_id: "peer".into(),
            origin_seq: 0,
            relay_seq: Some(1),
            op_kind: "ydoc.update".into(),
            recorded_at_ms: 1,
            payload: json!({"versionId":"main","objectId":"object-a","lineageClaimId":"inactive","path":"doc.md"}),
        };
        dohc_engine_sync::apply_envelope_with(&mut store, &envelope, &NoFaults, |_, _| {
            Err::<(), _>(dohc_engine_sync::SyncError::InvalidInput {
                reason: "projection exceeds limit",
            })
        })
        .unwrap();
    }
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let mut id = 0;
    for pass in 0..2 {
        id += 1;
        let opened = call_with_busy_retry(&transport,RequestContext::unbounded(), request(id, "workspace.open", None,
            json!({"rootDir":scratch.path().to_string_lossy(),"workspaceId":"ws-refusal","captureMode":"none"}))).await.unwrap();
        let handle: WorkspaceHandle =
            serde_json::from_value(opened.result["workspace"].clone()).unwrap();
        let listed = call(
            &transport,
            &handle,
            &mut id,
            "sync.refusalNotices",
            json!({"workspaceId":"ws-refusal"}),
        )
        .await;
        assert_eq!(
            listed["notices"].as_array().unwrap().len(),
            if pass == 0 { 1 } else { 0 }
        );
        if pass == 0 {
            call(
                &transport,
                &handle,
                &mut id,
                "sync.dismissRefusal",
                json!({"workspaceId":"ws-refusal","noticeId":listed["notices"][0]["noticeId"],"refusalCoordinates":listed["notices"][0]["refusalCoordinates"]}),
            )
            .await;
        }
        call(&transport, &handle, &mut id, "workspace.close", json!({})).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ended_session_recovers_typing_after_settlement_evict() {
    assert_open_document_artifact_recovery_inner("evict", false, true, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ended_session_recovers_typing_after_settlement_workspace_close() {
    assert_open_document_artifact_recovery_inner("workspace-close", false, true, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ended_session_recovers_typing_after_settlement_crash() {
    assert_open_document_artifact_recovery_inner("crash", false, true, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ended_session_failure_does_not_block_pull() {
    assert_open_document_artifact_recovery_inner("evict", false, false, true).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ended_session_failure_does_not_block_workspace_open() {
    assert_open_document_artifact_recovery_inner("workspace-close", false, false, true).await;
}

#[tokio::test]
async fn ended_session_pending_attempt_empty_queue_at_pull() {
    assert_open_document_artifact_recovery_inner("pending-pull", true, false, false).await;
}
#[tokio::test]
async fn ended_session_pending_attempt_empty_queue_at_workspace_open() {
    assert_open_document_artifact_recovery_inner("pending-open", true, false, false).await;
}

#[tokio::test]
async fn ended_session_integrated_empty_queue_at_pull() {
    assert_open_document_artifact_recovery_inner("integrated-pull", true, false, false).await;
}
#[tokio::test]
async fn ended_session_integrated_empty_queue_at_workspace_open() {
    assert_open_document_artifact_recovery_inner("integrated-open", true, false, false).await;
}
#[tokio::test]
async fn ended_session_integrated_empty_queue_after_crash() {
    assert_open_document_artifact_recovery_inner("integrated-crash", true, false, false).await;
}
