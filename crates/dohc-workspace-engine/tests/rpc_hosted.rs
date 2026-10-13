//! The session host's hosted replica through the daemon RPCs, against a relay
//! that serves only the hosted feed. Any other route fails the test.

mod common;

use common::*;
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::hex_sha256;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{EngineService, root_binding::write_root_binding};
use rusqlite::Connection;
use serde_json::{Value, json};

const BEARER: &str = "relay-test-token";
const WORKSPACE: &str = "hosted-ws";

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

    fn query(&self, key: &str) -> Vec<&str> {
        self.target
            .split_once('?')
            .map_or("", |(_, query)| query)
            .split('&')
            .filter_map(|part| part.split_once('='))
            .filter(|(name, _)| *name == key)
            .map(|(_, value)| value)
            .collect()
    }
}

struct TestResponse {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}

impl TestResponse {
    fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: serde_json::to_vec(&body).expect("response JSON"),
        }
    }
}

/// The relay's scoped feed for one workspace: the documents it shares, under
/// one token, and the log above the epoch floor.
#[derive(Default)]
struct HostedRelay {
    log: Vec<Value>,
    blobs: HashMap<String, Vec<u8>>,
    shared: BTreeMap<String, String>,
    revision: usize,
    epoch_log_floor: i64,
    requests: Vec<String>,
    pushed: Vec<Value>,
    /// Answer pushes with an origin maximum past what was sent.
    diverge: bool,
}

impl HostedRelay {
    fn token(&self) -> String {
        format!("scope-{}", self.revision)
    }

    fn share(&mut self, object_id: &str, path: &str) {
        self.shared.insert(object_id.to_owned(), path.to_owned());
        self.revision += 1;
    }

    /// A text write that creates `object_id`, with its bytes on the relay.
    fn create(&mut self, origin: &str, seq: i64, object_id: &str, path: &str, text: &str) {
        let sha256 = hex_sha256(text.as_bytes());
        self.blobs.insert(sha256.clone(), text.as_bytes().to_vec());
        let relay_seq = self.log.len() as i64 + 1;
        self.log.push(json!({
            "relaySeq": relay_seq,
            "workspaceId": WORKSPACE,
            "originId": origin,
            "originSeq": seq,
            "opKind": "moment.append",
            "payload": {
                "momentId": format!("moment-{origin}-{seq}"),
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
                "payloadAfterContentKind": "text",
                "payloadAfterByteLength": text.len(),
                "metadata": {"origin": "sync"},
                "beforePresent": "absent"
            },
            "recordedAtMs": 1_000 + relay_seq,
        }));
    }

    fn respond(&mut self, request: &TestRequest) -> TestResponse {
        let route = request
            .path()
            .strip_prefix(&format!("/sync/{WORKSPACE}/hosted/"))
            .unwrap_or_else(|| panic!("a hosted replica left the hosted feed: {}", request.path()))
            .to_owned();
        match (request.method.as_str(), route.as_str()) {
            ("GET", "log") => self.page(request),
            ("POST", "log") => {
                let body: Value = serde_json::from_slice(&request.body).expect("push JSON");
                let ops = body["ops"].as_array().expect("push ops").clone();
                let last = ops
                    .last()
                    .and_then(|op| op["originSeq"].as_i64())
                    .unwrap_or(-1);
                self.pushed.push(body);
                TestResponse::json(
                    200,
                    json!({
                        "ok": true,
                        "accepted": ops.len(),
                        "inserted": ops.len(),
                        "skipped": 0,
                        "currentMaxOriginSeq": if self.diverge { last + 5 } else { last },
                    }),
                )
            }
            ("POST", "blobs/have") => {
                let body: Value = serde_json::from_slice(&request.body).expect("have JSON");
                let missing = body["sha256s"]
                    .as_array()
                    .expect("sha256s")
                    .iter()
                    .filter(|sha256| !self.blobs.contains_key(sha256.as_str().unwrap()))
                    .cloned()
                    .collect::<Vec<_>>();
                TestResponse::json(200, json!({"ok": true, "missing": missing}))
            }
            ("PUT", blob) => {
                let sha256 = blob.strip_prefix("blobs/").expect("blob route").to_owned();
                self.blobs.insert(sha256.clone(), request.body.clone());
                TestResponse::json(
                    200,
                    json!({"ok": true, "workspaceId": WORKSPACE, "sha256": sha256,
                        "byteLength": request.body.len(), "alreadyHad": false}),
                )
            }
            ("GET", blob) if blob.starts_with("blobs/") => {
                match self.blobs.get(blob.trim_start_matches("blobs/")) {
                    Some(bytes) => TestResponse {
                        status: 200,
                        content_type: "application/octet-stream",
                        body: bytes.clone(),
                    },
                    None => TestResponse::json(404, json!({"ok": false, "code": "blob_not_found"})),
                }
            }
            ("GET", coordinate) if coordinate.starts_with("log/") => {
                TestResponse::json(200, json!({"ok": true, "status": "absent"}))
            }
            other => panic!("unexpected hosted request {other:?}"),
        }
    }

    /// `GET /hosted/log`, as `serviceHostFeed.ts` answers it.
    fn page(&self, request: &TestRequest) -> TestResponse {
        assert_eq!(request.query("replicationEpoch"), ["epoch-2"]);
        assert_eq!(request.query("streamIdentity"), ["stream-2"]);
        let requested: i64 = request.query("since")[0].parse().expect("since");
        let scope = json!({
            "token": self.token(),
            "documents": self.shared.iter()
                .map(|(object_id, path)| json!({"objectId": object_id, "path": path}))
                .collect::<Vec<_>>(),
        });
        if request.query("scope") != [self.token().as_str()] {
            return TestResponse::json(
                200,
                json!({"ok": true, "scope": scope, "ops": [], "nextCursor": requested, "hasMore": false}),
            );
        }
        let object = request.query("object");
        let since = requested.max(self.epoch_log_floor);
        let scanned = self
            .log
            .iter()
            .filter(|row| row["relaySeq"].as_i64().unwrap() > since)
            .collect::<Vec<_>>();
        let ops = scanned
            .iter()
            .filter(|row| {
                let named = row["payload"]["objectId"].as_str();
                match (named, object.first()) {
                    (Some(named), Some(object)) => named == *object,
                    (Some(named), None) => self.shared.contains_key(named),
                    (None, None) => row["opKind"] == "workspace.init",
                    (None, Some(_)) => false,
                }
            })
            .cloned()
            .cloned()
            .collect::<Vec<_>>();
        let next = scanned
            .last()
            .map_or(requested, |row| row["relaySeq"].as_i64().unwrap());
        TestResponse::json(
            200,
            json!({"ok": true, "scope": scope, "ops": ops, "nextCursor": next, "hasMore": false}),
        )
    }
}

struct FakeRelay {
    base_url: String,
    state: Arc<Mutex<HostedRelay>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl FakeRelay {
    fn start(relay: HostedRelay) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake relay");
        listener
            .set_nonblocking(true)
            .expect("nonblocking fake relay");
        let address = listener.local_addr().expect("fake relay address");
        let state = Arc::new(Mutex::new(relay));
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
                            let authorization = request
                                .headers
                                .iter()
                                .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                                .map(|(_, value)| value.clone());
                            assert_eq!(authorization.as_deref(), Some("Bearer relay-test-token"));
                            let mut relay = thread_state.lock().expect("relay state");
                            relay
                                .requests
                                .push(format!("{} {}", request.method, request.path()));
                            let response = relay.respond(&request);
                            drop(relay);
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

    fn relay(&self) -> std::sync::MutexGuard<'_, HostedRelay> {
        self.state.lock().expect("relay state")
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
            let joined = thread.join();
            if !std::thread::panicking() {
                joined.expect("join fake relay");
            }
        }
    }
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
            return Err(std::io::ErrorKind::UnexpectedEof.into());
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
    write!(
        stream,
        "HTTP/1.1 {} OK\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        response.status,
        response.content_type,
        response.body.len()
    )?;
    stream.write_all(&response.body)?;
    stream.flush()
}

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    relay: &FakeRelay,
) -> WorkspaceHandle {
    write_root_binding(scratch.path(), TOKEN).expect("root binding");
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": WORKSPACE,
                    "captureMode": "none",
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

struct Host {
    transport: InProcessTransport<EngineService>,
    handle: WorkspaceHandle,
    id: u64,
}

impl Host {
    async fn call(&mut self, method: &str, params: Value) -> Value {
        self.id += 1;
        call(&self.transport, &self.handle, self.id, method, params).await
    }

    async fn error(&mut self, method: &str) -> (ErrorCode, String) {
        self.id += 1;
        let error = call_error(
            &self.transport,
            &self.handle,
            self.id,
            method,
            json!({"workspaceId": WORKSPACE}),
        )
        .await;
        (error.code, error.message)
    }

    async fn create(&mut self) -> Value {
        self.call(
            "sync.createHostedReplica",
            json!({"workspaceId": WORKSPACE, "replicationEpoch": "epoch-2", "streamIdentity": "stream-2"}),
        )
        .await
    }

    async fn pull(&mut self) -> Value {
        self.call("sync.pullHosted", json!({"workspaceId": WORKSPACE}))
            .await
    }

    /// Materialize and commit a pass's cursor, answering whether it committed.
    async fn commit(&mut self, pending: &Value) -> bool {
        let params = json!({"workspaceId": WORKSPACE, "pendingCursor": pending});
        assert_eq!(
            self.call("sync.materializePendingCursor", params.clone())
                .await,
            json!({"materialized": true})
        );
        self.call("sync.commitCursor", params).await["committed"]
            .as_bool()
            .expect("committed")
    }

    /// Pass, materialize and commit until the feed has nothing more.
    async fn sync(&mut self) {
        for _ in 0..16 {
            let pass = self.pull().await;
            if pass["pendingCursor"].is_object() {
                assert!(self.commit(&pass["pendingCursor"]).await);
            }
            if pass["hasMore"] == false {
                return;
            }
        }
        panic!("the hosted replica did not catch up");
    }
}

/// The document's state on the hosted replica.
fn document_state(scratch: &ScratchDir, object_id: &str) -> Option<String> {
    let conn = Connection::open(engine_db_path(scratch).expect("db path")).expect("open db");
    conn.query_row(
        "SELECT state FROM hosted_documents WHERE workspace_id=?1 AND object_id=?2",
        [WORKSPACE, object_id],
        |row| row.get(0),
    )
    .ok()
}

/// Journal a live Y.Doc update of `object_id` as its session would.
fn journal_live_update(scratch: &ScratchDir, object_id: &str, path: &str, update: &[u8]) -> i64 {
    let mut conn = Connection::open(engine_db_path(scratch).expect("db path")).expect("open db");
    let tx = conn.transaction().expect("transaction");
    let sha256 = dohc_engine_storage::put_binary_blob(&tx, update).expect("update blob");
    let key = dohc_engine_collab::DocKey::new(WORKSPACE, "main", object_id).expect("doc key");
    let seq = dohc_engine_sync::journal_local_op_in_tx(
        &tx,
        WORKSPACE,
        "ydoc.update",
        &dohc_engine_sync::ydoc_update_payload(
            &key,
            path,
            dohc_engine_collab::ContentKind::Richdoc,
            &sha256,
            &"0".repeat(64),
            None,
            None,
            false,
        ),
        3_000,
    )
    .expect("journal live update");
    tx.commit().expect("commit");
    seq
}

/// A relay whose epoch rotated after the workspace began: the feed reads
/// above its floor and never serves the original `workspace.init`.
fn rotated_relay() -> FakeRelay {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.epoch_log_floor = 1;
    relay.create("owner", 1, "doc-a", "a.md", "hosted a");
    relay.create("owner", 2, "private", "private.md", "private");
    relay.create("owner", 3, "doc-b", "b.md", "hosted b");
    relay.share("doc-a", "a.md");
    FakeRelay::start(relay)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_hosted_replica_pulls_its_documents_and_pushes_live_writes_to_the_hosted_feed() {
    let relay = rotated_relay();
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    assert_eq!(host.create().await, json!({"hosted": true}));
    assert_eq!(
        host.create().await,
        json!({"hosted": true}),
        "the same coordinate answers the same"
    );

    // The first pass learns the scope and applies nothing.
    let learned = host.pull().await;
    assert_eq!(
        (&learned["pendingCursor"], &learned["hasMore"]),
        (&Value::Null, &json!(true))
    );
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("ready"));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("a.md")).expect("a.md"),
        "hosted a"
    );
    assert!(!scratch.path().join("private.md").exists());
    assert!(!scratch.path().join("b.md").exists());

    // A pass fetched before the scope moved commits nothing; the next pass
    // learns the new scope, and the document that joined backfills.
    let stale = host.pull().await;
    assert!(stale["pendingCursor"].is_object());
    relay.relay().share("doc-b", "b.md");
    let adopted = host.pull().await;
    assert_eq!(
        (&adopted["pendingCursor"], &adopted["hasMore"]),
        (&Value::Null, &json!(true))
    );
    assert!(!host.commit(&stale["pendingCursor"]).await);
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("ready"));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("b.md")).expect("b.md"),
        "hosted b"
    );

    // A live write pushes to the hosted log under the service-host origin,
    // with its bytes uploaded to the hosted feed.
    assert_eq!(
        journal_live_update(&scratch, "doc-a", "a.md", b"live update"),
        0
    );
    let pushed = host
        .call("sync.push", json!({"workspaceId": WORKSPACE}))
        .await;
    assert_eq!(pushed["pushed"], 1);
    {
        let relay = relay.relay();
        let [push] = relay.pushed.as_slice() else {
            panic!("one hosted push: {:?}", relay.pushed);
        };
        assert!(
            push["originId"]
                .as_str()
                .is_some_and(|origin| origin.starts_with("service-host:host_")),
            "{push}"
        );
        assert_eq!(push["ops"][0]["opKind"], "ydoc.update");
        assert!(relay.blobs.contains_key(&hex_sha256(b"live update")));
        assert!(
            relay
                .requests
                .iter()
                .any(|request| request.starts_with("PUT /sync/hosted-ws/hosted/blobs/"))
        );
    }

    // The relay holds more of this origin than the replica wrote: a hard
    // failure, since a hosted origin is never rebased.
    relay.relay().diverge = true;
    journal_live_update(&scratch, "doc-a", "a.md", b"second live update");
    assert_eq!(
        host.error("sync.push").await,
        (ErrorCode::InvalidParams, "relay-origin-diverged".to_owned())
    );
    assert_eq!(
        host.error("sync.recoverOrigin").await,
        (
            ErrorCode::InvalidParams,
            "invalid-input: a hosted replica never rebases its origin".to_owned()
        )
    );
    assert_eq!(
        host.error("sync.pull").await,
        (
            ErrorCode::InvalidParams,
            "invalid-input: a hosted replica pulls with pull_hosted_workspace".to_owned()
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hosted_rpcs_refuse_a_replica_that_is_not_hosted_with_the_reason() {
    let relay = rotated_relay();
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    assert_eq!(
        host.error("sync.pullHosted").await,
        (
            ErrorCode::InvalidParams,
            "invalid-input: workspace is not a hosted replica".to_owned()
        )
    );

    // An ordinary identity, as any other first write would give it.
    host.call(
        "sync.adoptJoinIdentity",
        json!({"workspaceId": WORKSPACE, "replicationEpoch": "epoch-2", "streamIdentity": "stream-2"}),
    )
    .await;
    host.id += 1;
    let refused = call_error(
        &host.transport,
        &host.handle,
        host.id,
        "sync.createHostedReplica",
        json!({"workspaceId": WORKSPACE, "replicationEpoch": "epoch-2", "streamIdentity": "stream-2"}),
    )
    .await;
    assert_eq!(
        (refused.code, refused.message.as_str()),
        (
            ErrorCode::InvalidParams,
            "invalid-input: a replica cannot change between hosted and ordinary"
        )
    );
    assert!(
        relay.relay().requests.is_empty(),
        "no refusal reached the relay"
    );
}
