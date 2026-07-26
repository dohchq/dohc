use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_storage::hex_sha256;
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
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
    Ok(TestRequest {
        method,
        target,
        headers,
        body: bytes[header_end..header_end + content_length].to_vec(),
    })
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

fn request(id: u64, method: &str, workspace: Option<WorkspaceHandle>, params: Value) -> Request {
    Request {
        id,
        method: method.to_owned(),
        workspace,
        deadline_ms: None,
        idempotency_key: None,
        params,
    }
}

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    relay: &FakeRelay,
    id: u64,
    workspace_id: &str,
) -> WorkspaceHandle {
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("shadow marker");
    let opened = transport
        .call(
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
    transport
        .call(
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

async fn seed_sync_identity(
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
            "pathPrefix": "notes",
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
async fn multi_page_pull_rpc_surfaces_conflicts_opened_and_reconstructed_pending_resolves() {
    let workspace_id = "rpc-relay-pull-details";
    let side = |path: &str| {
        json!({
            "exists": false,
            "path": path,
            "contentKind": "text",
        })
    };
    let relay = FakeRelay::start(RelayState {
        workspace_ops: vec![
            workspace_row(
                1,
                workspace_id,
                "open-peer",
                0,
                "conflict.open",
                json!({
                    "id": "rpc-multi-page-conflict",
                    "workspaceId": workspace_id,
                    "path": "notes/conflict.md",
                    "targetVersionId": "main",
                    "sourceVersionId": "peer",
                    "createdAtMs": 9,
                    "updatedAtMs": 9,
                    "base": side("notes/conflict.md"),
                    "current": side("notes/conflict.md"),
                    "incoming": side("notes/conflict.md"),
                    "status": "open",
                    "chosenFrom": "current",
                    "metadata": {"origin": "sync"},
                }),
            ),
            workspace_row(
                2,
                workspace_id,
                "resolve-peer",
                0,
                "conflict.resolve",
                json!({
                    "conflictId": "missing-conflict",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "keep-current",
                    "updatedAtMs": 10,
                    "path": "notes/missing.md",
                }),
            ),
        ],
        workspace_page_limit: Some(1),
        ..RelayState::default()
    });
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 1, workspace_id).await;
    let mut id = 1;
    seed_main(&transport, &handle, &mut id, workspace_id).await;
    seed_sync_identity(&transport, &handle, &mut id).await;

    let pull = call(
        &transport,
        &handle,
        &mut id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(pull["fetched"], 2);
    assert_eq!(pull["applied"], 2);
    assert_eq!(pull["conflictsOpened"], 1);
    assert_eq!(pull["pendingResolves"].as_array().map(Vec::len), Some(1));
    assert_eq!(pull["pendingResolves"][0]["reason"], "unmatched-target");

    let redelivered = call(
        &transport,
        &handle,
        &mut id,
        "sync.pull",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    assert_eq!(redelivered["conflictsOpened"], 0);
    assert_eq!(
        redelivered["pendingResolves"], pull["pendingResolves"],
        "the skipped resolution on an uncommitted redelivery must reconstruct its pending resolve"
    );
    let get_count = relay
        .state
        .lock()
        .expect("relay state")
        .requests
        .iter()
        .filter(|(method, path)| method == "GET" && path == &format!("/sync/{workspace_id}/log"))
        .count();
    assert_eq!(get_count, 4, "each pull must traverse both relay pages");
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
    seed_sync_identity(&transport, &handle, &mut id).await;

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
                "path": "assets/remote.bin",
                "operation": "write",
                "contentKind": "binary",
            },
            {
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
    seed_sync_identity(&transport, &handle, &mut id).await;

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
    seed_sync_identity(&transport, &handle, &mut id).await;
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

    let db_path = scratch.engine_db_path().expect("engine db path");
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
    seed_sync_identity(&transport, &handle, &mut id).await;
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
async fn every_new_rpc_refuses_a_cross_workspace_handle_before_transport() {
    let relay = FakeRelay::start(RelayState::default());
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay, 1, "bound-workspace").await;
    let methods = [
        ("sync.push", json!({ "workspaceId": "other" })),
        ("sync.pull", json!({ "workspaceId": "other" })),
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
            json!({ "workspaceId": "other", "shareId": "share", "pathPrefix": "notes" }),
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
        "sync.push",
        json!({ "workspaceId": workspace_id }),
    )
    .await;
    {
        let mut state = relay.state.lock().expect("relay state");
        let origin = state.local_origin_id.clone().expect("local origin");
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
                    &format!("share:shared-channel:{origin}"),
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

    let db = Connection::open(scratch.engine_db_path().expect("engine db path"))
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
async fn shared_channel_stale_selector_does_not_advance_rejected_cursor() {
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

    let _ = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "share.channel.pull",
                Some(handle.clone()),
                json!({
                    "workspaceId": workspace_id,
                    "shareId": share_id,
                    "channelWireId": "wire-stale",
                }),
            ),
        )
        .await;
    close(&transport, &handle, &mut id).await;

    let db = Connection::open(scratch.engine_db_path().expect("engine db path"))
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
        cursor, None,
        "a selector-rejected entry was not consumed and cannot advance the cursor"
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
            "pathPrefix": "notes",
        }),
    )
    .await;
    assert_eq!(pulled["fetched"], 2);
    assert_eq!(pulled["applied"], 1);
    assert_eq!(pulled["changedPaths"][0]["path"], "notes/view.md");
    assert_eq!(pulled["pendingCursor"]["kind"], "shareView");
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

    let db_path = scratch.engine_db_path().expect("engine db path");
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
            "pathPrefix": "notes",
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
            "pathPrefix": "notes",
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
                "operation": "rename",
                "path": "notes/new.md",
                "payloadBeforePath": "notes/old.md",
                "payloadAfterPath": "notes/new.md",
                "payloadAfterBlobSha256": replacement_sha.clone(),
                "payloadAfterContentKind": "text",
            }),
        ));

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
                    "pathPrefix": "notes",
                }),
            ),
        )
        .await
        .expect_err("corrupt replacement must reject the rename");
    assert_eq!(rename.code, ErrorCode::InvalidParams);

    let db = Connection::open(scratch.engine_db_path().expect("engine db path"))
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
            "pathPrefix": "notes",
        }),
    )
    .await;
    assert_eq!(retried["changedPaths"].as_array().map(Vec::len), Some(2));
    close(&transport, &handle, &mut id).await;

    let db = Connection::open(scratch.engine_db_path().expect("engine db path"))
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
