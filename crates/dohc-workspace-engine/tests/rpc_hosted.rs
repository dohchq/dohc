//! The session host's hosted replica through the daemon RPCs, against a relay
//! that serves only the hosted feed. Any other route fails the test.

mod common;

use base64::Engine as _;
use common::*;
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use dohc_engine_collab::live_update_application::{ApplicationHostCoordinate, ImportedOwnerSource};
use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    transport::{
        ConnectionOwner, EngineService as _, InProcessTransport, OutputGuard, RequestContext,
    },
    wire::WorkspaceHandle,
};
use dohc_engine_storage::hex_sha256;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::{
    ConfiguredLiveHostConfig, EngineService, LiveApplicationHostConfig,
    live_application_ingress::LiveApplicationIngress, root_binding::write_root_binding,
};
use rusqlite::Connection;
use serde_json::{Value, json};

const BEARER: &str = "relay-test-token";
const WORKSPACE: &str = "hosted-ws";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_departed_reader_hold_does_not_stop_native_parking_or_the_hosted_pass() {
    use dohc_engine_collab::{ContentKind, DocKey, Ydoc};
    use dohc_engine_storage::{EngineStore, NoFaults};
    let data: Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/reader-resolver.json"
    ))
    .unwrap();
    let source = data["source"].as_str().unwrap();
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-a", "a.md", source);
    relay.create("owner", 2, "doc-z", "z.txt", "Native note");
    relay.share("doc-a", "a.md");
    relay.share("doc-z", "z.txt");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().unwrap();
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 2_000).unwrap();
    let key = DocKey::new(WORKSPACE, "main", "doc-a").unwrap();
    let checkpoint = base64::engine::general_purpose::STANDARD
        .decode(data["claimedCheckpoint"].as_str().unwrap())
        .unwrap();
    dohc_engine_collab::claim_base_at_relay(
        &mut store,
        &key,
        ContentKind::Richdoc,
        &checkpoint,
        &dohc_engine_collab::BaseRelayCoordinate {
            origin_id: "owner".into(),
            origin_seq: 3,
            relay_seq: 4,
        },
        &NoFaults,
        2_001,
    )
    .unwrap();
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let update = doc.richdoc_append_paragraph("Unsettled reader body");
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::record_update_in_tx(tx, &key, &update, None, None, 2_002)
        })
        .unwrap();
    drop(store);
    {
        let mut relay = relay.relay();
        relay.unshare("doc-a");
        relay.unshare("doc-z");
    }
    let pass = host.pull().await;
    assert_eq!(pass["departed"], json!(["doc-a"]), "{pass}");
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("ready"));
    assert_eq!(document_state(&scratch, "doc-z").as_deref(), Some("parked"));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("a.md")).unwrap(),
        source
    );
    assert!(!scratch.path().join("z.txt").exists());
}

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
    /// Every push that carried ops.
    pushed: Vec<Value>,
    /// Every empty push: the origin probe each `sync.createHostedReplica` sends.
    probes: Vec<Value>,
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

    fn unshare(&mut self, object_id: &str) {
        self.shared.remove(object_id);
        self.revision += 1;
    }

    /// A text write that creates `object_id`, with its bytes on the relay.
    fn create(&mut self, origin: &str, seq: i64, object_id: &str, path: &str, text: &str) {
        self.write(
            origin,
            seq,
            object_id,
            path,
            text,
            json!({"beforePresent": "absent"}),
        );
    }

    /// A text write of `object_id` at `path` replacing another object's head
    /// there: its id, text and latest moment. The relay holds only the after
    /// bytes.
    fn replace(
        &mut self,
        origin: &str,
        seq: i64,
        object_id: &str,
        path: &str,
        text: &str,
        before: (&str, &str, &str),
    ) {
        let (before_object_id, before_text, before_moment_id) = before;
        let before_sha256 = hex_sha256(before_text.as_bytes());
        self.write(
            origin,
            seq,
            object_id,
            path,
            text,
            json!({
                "payloadBeforeBlobSha256": before_sha256,
                "payloadBeforePath": path,
                "beforePresent": "present",
                "beforeObjectId": before_object_id,
                "beforeVersionId": "main",
                "beforePath": path,
                "beforeBlobSha256": before_sha256,
                "beforeContentKind": "text",
                "beforeUpdatedAtMs": 1_500,
                "beforeLatestMomentId": before_moment_id,
                "beforeMetadata": {"origin": "sync"}
            }),
        );
    }

    /// A rename of `object_id`, holding `text`, from `from` to `to`. Its
    /// before side is the object's own head, last written by `before_moment_id`.
    #[allow(clippy::too_many_arguments)]
    fn rename(
        &mut self,
        origin: &str,
        seq: i64,
        object_id: &str,
        from: &str,
        to: &str,
        text: &str,
        before_moment_id: &str,
    ) {
        self.own_head_change(
            "rename",
            origin,
            seq,
            object_id,
            from,
            to,
            text,
            before_moment_id,
        );
    }

    /// A delete of `object_id`, holding `text`, at `path`.
    fn delete(
        &mut self,
        origin: &str,
        seq: i64,
        object_id: &str,
        path: &str,
        text: &str,
        before_moment_id: &str,
    ) {
        self.own_head_change(
            "delete",
            origin,
            seq,
            object_id,
            path,
            path,
            text,
            before_moment_id,
        );
    }

    /// A change of `object_id` whose before side is its own head at `from`.
    #[allow(clippy::too_many_arguments)]
    fn own_head_change(
        &mut self,
        operation: &str,
        origin: &str,
        seq: i64,
        object_id: &str,
        from: &str,
        to: &str,
        text: &str,
        before_moment_id: &str,
    ) {
        let sha256 = hex_sha256(text.as_bytes());
        self.write(
            origin,
            seq,
            object_id,
            to,
            text,
            json!({
                "operation": operation,
                "payloadBeforeBlobSha256": sha256,
                "payloadBeforePath": from,
                "beforePresent": "present",
                "beforeObjectId": object_id,
                "beforeVersionId": "main",
                "beforePath": from,
                "beforeBlobSha256": sha256,
                "beforeContentKind": "text",
                "beforeUpdatedAtMs": 1_500,
                "beforeLatestMomentId": before_moment_id,
                "beforeMetadata": {"origin": "sync"}
            }),
        );
    }

    /// An ordinary rich document Y.Doc `update` of `object_id` at `path` on
    /// `lineage`, with its bytes on the relay. A base names its own lineage.
    fn ydoc(
        &mut self,
        origin: &str,
        seq: i64,
        object_id: &str,
        path: &str,
        update: &[u8],
        lineage: &str,
    ) {
        let sha256 = hex_sha256(update);
        self.blobs.insert(sha256.clone(), update.to_vec());
        let relay_seq = self.log.len() as i64 + 1;
        self.log.push(json!({
            "relaySeq": relay_seq, "workspaceId": WORKSPACE, "originId": origin,
            "originSeq": seq, "opKind": "ydoc.update",
            "payload": {"versionId": "main", "objectId": object_id, "path": path,
                "contentKind": "richdoc", "updateBlobSha256": sha256,
                "lineageClaimId": lineage, "isBaseState": sha256 == lineage},
            "recordedAtMs": 1_000 + relay_seq,
        }));
    }

    fn write(
        &mut self,
        origin: &str,
        seq: i64,
        object_id: &str,
        path: &str,
        text: &str,
        before: Value,
    ) {
        let sha256 = hex_sha256(text.as_bytes());
        self.blobs.insert(sha256.clone(), text.as_bytes().to_vec());
        let relay_seq = self.log.len() as i64 + 1;
        let mut payload = json!({
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
            "metadata": {"origin": "sync"}
        });
        for (name, value) in before.as_object().expect("before fields") {
            payload[name] = value.clone();
        }
        self.log.push(json!({
            "relaySeq": relay_seq,
            "workspaceId": WORKSPACE,
            "originId": origin,
            "originSeq": seq,
            "opKind": "moment.append",
            "payload": payload,
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
                let origin = body["originId"].clone();
                if ops.is_empty() {
                    self.probes.push(body);
                } else {
                    self.pushed.push(body);
                }
                let last = self
                    .pushed
                    .iter()
                    .filter(|push| push["originId"] == origin)
                    .flat_map(|push| push["ops"].as_array().expect("push ops"))
                    .filter_map(|op| op["originSeq"].as_i64())
                    .max()
                    .unwrap_or(-1);
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

/// A daemon that pulls the hosted feed under the namespace a configured
/// live host would name, while its ordinary methods stay open to the test.
fn hosted_service() -> EngineService {
    EngineService::with_hosted_feed_for_harness("hosted-relay")
}

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    relay: &FakeRelay,
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

    /// Materialize and commit a pass's cursor, answering the commit.
    async fn commit_answer(&mut self, pending: &Value) -> Value {
        let params = json!({"workspaceId": WORKSPACE, "pendingCursor": pending});
        assert_eq!(
            self.call("sync.materializePendingCursor", params.clone())
                .await,
            json!({"materialized": true})
        );
        self.call("sync.commitCursor", params).await
    }

    /// Materialize and commit a pass's cursor, answering whether it committed.
    async fn commit(&mut self, pending: &Value) -> bool {
        self.commit_answer(pending).await["committed"]
            .as_bool()
            .expect("committed")
    }

    /// Pass, materialize and commit until neither the feed nor a commit has
    /// anything more.
    async fn sync(&mut self) {
        // A pass backfills one document, so a scope of many takes a pass each.
        for _ in 0..64 {
            let pass = self.pull().await;
            let mut more = pass["hasMore"] == true;
            if pass["pendingCursor"].is_object() {
                let commit = self.commit_answer(&pass["pendingCursor"]).await;
                assert_eq!(commit["committed"], true);
                assert_eq!(commit["retirement"], Value::Null, "{commit}");
                more |= commit["hasMore"] == true;
            }
            if !more {
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

/// The path of the document's head on the hosted replica.
fn head_path(scratch: &ScratchDir, object_id: &str) -> Option<String> {
    let conn = Connection::open(engine_db_path(scratch).expect("db path")).expect("open db");
    conn.query_row(
        "SELECT path FROM snapshots WHERE workspace_id=?1 AND object_id=?2",
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
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
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
    {
        let relay = relay.relay();
        assert_eq!(
            relay.requests,
            vec![format!("POST /sync/{WORKSPACE}/hosted/log"); 2],
            "each create probes the hosted log, and nothing else"
        );
        let origins = relay
            .probes
            .iter()
            .map(|probe| {
                assert_eq!(probe["ops"], json!([]));
                probe["originId"].as_str().expect("probe origin").to_owned()
            })
            .collect::<Vec<_>>();
        assert!(origins[0].starts_with("service-host:host_"), "{origins:?}");
        assert_eq!(origins[0], origins[1], "the replica keeps its origin");
    }

    // The first pass learns the scope and applies nothing.
    let learned = host.pull().await;
    assert_eq!(
        (
            &learned["pendingCursor"],
            &learned["hasMore"],
            &learned["departed"]
        ),
        (&Value::Null, &json!(true), &json!([]))
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
    for method in ["sync.recoverOrigin", "sync.pull"] {
        assert_eq!(
            host.error(method).await,
            (ErrorCode::InvalidParams, HOSTED_FEED_ONLY.to_owned()),
            "{method}"
        );
    }
}

/// #2088: the relay holds more of the replica's origin than the replica
/// numbered, as after its store lost pushed commits. The next attach's
/// create refuses, and nothing past its probe reaches the relay.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn create_refuses_a_replica_whose_relay_holds_more_of_its_origin() {
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
    relay.relay().diverge = true;
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
        (ErrorCode::InvalidParams, "relay-origin-diverged")
    );
    let relay = relay.relay();
    assert_eq!(
        relay.requests,
        vec![format!("POST /sync/{WORKSPACE}/hosted/log"); 2]
    );
    assert!(relay.pushed.is_empty());
}

const HOSTED_FEED_ONLY: &str = "invalid-input: a hosted replica uses only its hosted feed";

/// Sol's slice-4 review: ordinary relay RPCs reached ordinary routes from a
/// hosted replica, and a refused claim left `pending` behind to hold back
/// hosted pushes. Each is refused with its reason before it reaches the
/// relay or writes, and the replica keeps pushing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ordinary_relay_rpcs_leave_a_hosted_replica_untouched() {
    let relay = rotated_relay();
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    let requests = relay.relay().requests.len();

    let workspace = || json!({"workspaceId": WORKSPACE});
    for (method, params) in [
        ("sync.probe", workspace()),
        (
            "sync.claim",
            json!({"workspaceId": WORKSPACE, "accountId": "account"}),
        ),
        (
            "sync.adoptJoinIdentity",
            json!({"workspaceId": WORKSPACE, "replicationEpoch": "epoch-2", "streamIdentity": "stream-2"}),
        ),
        ("sync.pull", workspace()),
        ("sync.recoverOrigin", workspace()),
        (
            "keys.upload",
            json!({"workspaceId": WORKSPACE, "envelopeJson": "{}"}),
        ),
        ("keys.download", workspace()),
    ] {
        host.id += 1;
        let refused = call_error(&host.transport, &host.handle, host.id, method, params).await;
        assert_eq!(
            (refused.code, refused.message.as_str()),
            (ErrorCode::InvalidParams, HOSTED_FEED_ONLY),
            "{method}"
        );
    }
    assert_eq!(
        relay.relay().requests.len(),
        requests,
        "no refusal reached the relay"
    );
    let conn = Connection::open(engine_db_path(&scratch).expect("db path")).expect("open db");
    let claim: (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT claim_state,claim_account_id FROM sync_identity WHERE workspace_id=?1",
            [WORKSPACE],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("identity");
    assert_eq!(claim, (None, None));

    journal_live_update(&scratch, "doc-a", "a.md", b"live update");
    assert_eq!(
        host.call("sync.push", json!({"workspaceId": WORKSPACE}))
            .await["pushed"],
        1
    );
}

/// A document that leaves the scope parks once nothing of it is pending: its
/// head and file go, and the document that replaced it at its path takes it.
/// A file holding anything but its head is a bug in a service root, so
/// parking stops and names it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_departed_document_parks_and_frees_its_file_for_its_replacement() {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-b", "a.md", "hosted b");
    relay.share("doc-b", "a.md");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    let file = scratch.path().join("a.md");
    assert_eq!(std::fs::read_to_string(&file).expect("a.md"), "hosted b");

    {
        let mut relay = relay.relay();
        relay.unshare("doc-b");
        relay.replace(
            "owner",
            2,
            "doc-a",
            "a.md",
            "hosted a",
            ("doc-b", "hosted b", "moment-owner-1"),
        );
        relay.share("doc-a", "a.md");
    }
    std::fs::write(&file, "not the head").expect("write a.md");
    let (code, message) = host.error("sync.pullHosted").await;
    assert_eq!(code, ErrorCode::Internal);
    assert!(
        message.contains("hosted-file-unexpected: a.md"),
        "{message}"
    );
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("ready"));
    assert_eq!(
        std::fs::read_to_string(&file).expect("a.md"),
        "not the head"
    );

    // The durability review: a commit lands whether or not parking after it
    // fails, and says both.
    let commits = || {
        Connection::open(engine_db_path(&scratch).expect("db path"))
            .expect("open db")
            .query_row("SELECT cursor_commits FROM hosted_replicas", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("cursor commits")
    };
    let before = commits();
    for _ in 0..2 {
        let pass = host.pull().await;
        assert_eq!(pass["departed"], json!(["doc-b"]));
        let commit = host.commit_answer(&pass["pendingCursor"]).await;
        assert_eq!(commit["committed"], true, "{commit}");
        assert_eq!(commit["departed"], json!(["doc-b"]));
        assert_eq!(commit["retirement"]["code"], json!(ErrorCode::Internal));
        assert!(
            commit["retirement"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("hosted-file-unexpected: a.md")),
            "{commit}"
        );
    }
    assert_eq!(commits(), before + 2);

    // With its head back on disk, doc-b parks after the next commit, and
    // doc-a's waiting write applies and takes the path. doc-b keeps its
    // object and history for its return.
    std::fs::write(&file, "hosted b").expect("write a.md");
    host.sync().await;
    assert_eq!(std::fs::read_to_string(&file).expect("a.md"), "hosted a");
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("parked"));
    assert_eq!(host.pull().await["departed"], json!([]));
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("ready"));
    let conn = Connection::open(engine_db_path(&scratch).expect("db path")).expect("open db");
    let (objects, heads, conflicts): (i64, i64, i64) = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM file_objects WHERE object_id='doc-b'), \
                    (SELECT COUNT(*) FROM snapshots WHERE object_id='doc-b'), \
                    (SELECT COUNT(*) FROM conflicts)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("count");
    assert_eq!((objects, heads, conflicts), (1, 0, 0));
}

/// A parked document's file goes, and when it is shared again its head
/// comes back and its file with it, with nothing applied twice.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_parked_document_comes_back_with_its_file_when_it_returns() {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-b", "notes/a.md", "hosted b");
    relay.share("doc-b", "notes/a.md");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    let file = scratch.path().join("notes/a.md");
    assert_eq!(std::fs::read_to_string(&file).expect("a.md"), "hosted b");

    relay.relay().unshare("doc-b");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("parked"));
    assert!(!file.exists());
    assert_eq!(host.pull().await["departed"], json!([]));

    relay.relay().share("doc-b", "notes/a.md");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("ready"));
    assert_eq!(std::fs::read_to_string(&file).expect("a.md"), "hosted b");
    let conn = Connection::open(engine_db_path(&scratch).expect("db path")).expect("open db");
    let (moments, parked): (i64, i64) = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM moments WHERE object_id='doc-b'), \
                    (SELECT COUNT(*) FROM hosted_parked_snapshots)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("count");
    assert_eq!((moments, parked), (1, 0));
}

/// The durability review: `doc-b` left the scope at `a.md/x/c.md` and
/// `doc-a` was created at `a.md`. Retirement removed the file but left the
/// empty folder `a.md`, so every materialization of `doc-a`'s write failed
/// and hosted pull stalled. The folders go with the file, and `doc-a` lands.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_retired_file_leaves_no_folder_in_its_replacements_way() {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-b", "a.md/x/c.md", "hosted b");
    relay.share("doc-b", "a.md/x/c.md");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("a.md/x/c.md")).expect("a.md/x/c.md"),
        "hosted b"
    );

    {
        let mut relay = relay.relay();
        relay.unshare("doc-b");
        relay.create("owner", 2, "doc-a", "a.md", "hosted a");
        relay.share("doc-a", "a.md");
    }
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("parked"));
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("ready"));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("a.md")).expect("a.md"),
        "hosted a"
    );
    assert_eq!(host.pull().await["departed"], json!([]));
}

/// Sol's retirement review: a file that could not go after its document
/// retired stayed forever. `a.md` is locked when `doc-b` retires, and the
/// host restarts. `doc-b`'s file keeps `a.md` held, so `doc-a`'s write
/// waits; once the lock goes, a later pass removes the file and `doc-a`
/// takes the path. Until then, every reply reports `doc-b` as departed, so
/// the host does not release it while its file remains.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_retired_file_that_could_not_go_holds_its_path_until_it_goes() {
    use std::os::windows::fs::OpenOptionsExt;
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-b", "a.md", "hosted b");
    relay.share("doc-b", "a.md");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    {
        let mut relay = relay.relay();
        relay.unshare("doc-b");
        relay.replace(
            "owner",
            2,
            "doc-a",
            "a.md",
            "hosted a",
            ("doc-b", "hosted b", "moment-owner-1"),
        );
        relay.share("doc-a", "a.md");
    }
    let file = scratch.path().join("a.md");
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2) // read | write, no delete
        .open(&file)
        .expect("lock a.md");

    // doc-b parks; its file cannot go.
    let (_, message) = host.error("sync.pullHosted").await;
    assert!(!message.contains("hosted-file-unexpected"), "{message}");
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("parked"));
    host.call("workspace.close", json!({})).await;
    drop(host);

    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    let pass = host.pull().await;
    assert_eq!(
        pass["departed"],
        json!(["doc-b"]),
        "it parked; its file remains"
    );
    let commit = host.commit_answer(&pass["pendingCursor"]).await;
    assert_eq!(commit["committed"], true);
    assert!(commit["retirement"].is_object(), "{commit}");
    assert_eq!(commit["departed"], json!(["doc-b"]));
    assert_eq!(std::fs::read_to_string(&file).expect("a.md"), "hosted b");
    let conn = Connection::open(engine_db_path(&scratch).expect("db path")).expect("open db");
    let (heads, retired): (i64, i64) = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM snapshots), (SELECT COUNT(*) FROM hosted_retired_files)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("count");
    assert_eq!((heads, retired), (0, 1), "doc-a's write waits for the file");

    drop(lock);
    host.sync().await;
    assert_eq!(std::fs::read_to_string(&file).expect("a.md"), "hosted a");
    let retired: i64 = conn
        .query_row("SELECT COUNT(*) FROM hosted_retired_files", [], |row| {
            row.get(0)
        })
        .expect("count");
    assert_eq!(retired, 0);
    assert_eq!(host.pull().await["departed"], json!([]));
}

/// The durability review: `doc-b` left the scope at `a.md/x/c.md` and
/// `doc-a` was created at `a.md`. When `a.md/x` could not go, its file was
/// forgotten anyway, so `doc-a`'s write met the empty folder and hosted pull
/// stalled for good. The file keeps `a.md` held while its empty folder
/// stays, and once the folder can go, a later pass removes it and `doc-a`
/// lands.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_retired_file_holds_its_path_while_its_empty_folder_cannot_go() {
    retired_file_holds_its_path_while_a_folder_is_locked("a.md/x").await;
}

/// The next durability review: with `a.md` locked instead, the first pass
/// removed `a.md/x`, and the next one stopped at the missing folder and
/// forgot the file while `a.md` stayed. A later pass walks past the folders
/// already gone, so the file keeps `a.md` held across passes.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_retired_file_holds_its_path_while_an_upper_empty_folder_cannot_go() {
    retired_file_holds_its_path_while_a_folder_is_locked("a.md").await;
}

#[cfg(windows)]
async fn retired_file_holds_its_path_while_a_folder_is_locked(locked: &str) {
    use std::os::windows::fs::OpenOptionsExt;
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-b", "a.md/x/c.md", "hosted b");
    relay.share("doc-b", "a.md/x/c.md");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    {
        let mut relay = relay.relay();
        relay.unshare("doc-b");
        relay.create("owner", 2, "doc-a", "a.md", "hosted a");
        relay.share("doc-a", "a.md");
    }
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(0x0200_0000) // FILE_FLAG_BACKUP_SEMANTICS, to open a folder
        .share_mode(0x1 | 0x2) // read | write, no delete
        .open(scratch.path().join(locked))
        .expect("lock folder");

    // doc-b parks; its file goes, but the locked folder cannot, across
    // passes.
    let conn = Connection::open(engine_db_path(&scratch).expect("db path")).expect("open db");
    for _ in 0..2 {
        host.sync().await;
        assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("parked"));
        assert!(!scratch.path().join("a.md/x/c.md").exists());
        let pass = host.pull().await;
        assert_eq!(pass["departed"], json!(["doc-b"]));
        if pass["pendingCursor"].is_object() {
            let commit = host.commit_answer(&pass["pendingCursor"]).await;
            assert_eq!(commit["committed"], true, "{commit}");
        }
        let (heads, retired): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM snapshots WHERE object_id='doc-a'), \
                        (SELECT COUNT(*) FROM hosted_retired_files)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("count");
        assert_eq!(
            (heads, retired),
            (0, 1),
            "doc-a's write waits for the folder"
        );
        assert!(scratch.path().join(locked).is_dir());
    }

    drop(lock);
    host.sync().await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("a.md")).expect("a.md"),
        "hosted a"
    );
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("ready"));
    let retired: i64 = conn
        .query_row("SELECT COUNT(*) FROM hosted_retired_files", [], |row| {
            row.get(0)
        })
        .expect("count");
    assert_eq!(retired, 0);
    assert_eq!(host.pull().await["departed"], json!([]));
}

/// The retirement round's open case, on disk: `doc-b` left the scope at
/// `a.md`, the owner moved it to `b.md`, and `doc-a` took `a.md`. When
/// `doc-b` returns, it is held without touching `doc-a` or its file, and the
/// pass says so. Once the owner moves `doc-a`, `doc-b` lands at `b.md`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_returning_document_is_held_off_another_documents_path_until_it_moves() {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-b", "a.md", "hosted b");
    relay.share("doc-b", "a.md");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;

    {
        let mut relay = relay.relay();
        relay.unshare("doc-b");
        relay.rename(
            "owner",
            2,
            "doc-b",
            "a.md",
            "b.md",
            "hosted b",
            "moment-owner-1",
        );
        relay.create("owner", 3, "doc-a", "a.md", "hosted a");
        relay.share("doc-a", "a.md");
    }
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("parked"));
    let read = |path: &str| std::fs::read_to_string(scratch.path().join(path)).ok();
    assert_eq!(read("a.md").as_deref(), Some("hosted a"));

    relay.relay().share("doc-b", "b.md");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("held"));
    assert_eq!(read("a.md").as_deref(), Some("hosted a"));
    assert_eq!(read("b.md"), None);
    let pass = host.pull().await;
    assert_eq!(
        pass["held"],
        json!([{
            "objectId": "doc-b", "reason": "hosted-backfill-path-held",
            "path": "a.md", "heldBy": "doc-a",
        }])
    );
    assert_eq!(pass["heldThrough"], Value::Null, "the list is complete");
    assert_eq!(pass["newlyHeld"], json!([]), "it was held before the pass");
    assert!(host.commit(&pass["pendingCursor"]).await);

    relay.relay().rename(
        "owner",
        4,
        "doc-a",
        "a.md",
        "c.md",
        "hosted a",
        "moment-owner-3",
    );
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("ready"));
    assert_eq!(read("a.md"), None);
    assert_eq!(read("b.md").as_deref(), Some("hosted b"));
    assert_eq!(read("c.md").as_deref(), Some("hosted a"));
    let conn = Connection::open(engine_db_path(&scratch).expect("db path")).expect("open db");
    let conflicts: i64 = conn
        .query_row("SELECT COUNT(*) FROM conflicts", [], |row| row.get(0))
        .expect("count");
    assert_eq!(conflicts, 0);
}

/// Sol's park review, on disk: `doc-b` parked at `a.md`, the owner moved it
/// to `b.md`, and `doc-a` took `a.md/child.md`, so `a.md` is a folder. When
/// `doc-b` returned, the decision its journaled creation stored named `a.md`,
/// whose materialization failed, so no pass of the workspace could commit.
/// The pass now materializes and commits with `doc-b` held, and `doc-a`
/// keeps syncing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_return_whose_old_path_became_a_folder_holds_only_its_document() {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-b", "a.md", "hosted b");
    relay.share("doc-b", "a.md");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;

    {
        let mut relay = relay.relay();
        relay.unshare("doc-b");
        relay.rename(
            "owner",
            2,
            "doc-b",
            "a.md",
            "b.md",
            "hosted b",
            "moment-owner-1",
        );
        relay.create("owner", 3, "doc-a", "a.md/child.md", "hosted a");
        relay.share("doc-a", "a.md/child.md");
    }
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("parked"));
    let read = |path: &str| std::fs::read_to_string(scratch.path().join(path)).ok();
    assert_eq!(read("a.md/child.md").as_deref(), Some("hosted a"));

    relay.relay().share("doc-b", "b.md");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("held"));
    assert!(scratch.path().join("a.md").is_dir());
    relay.relay().replace(
        "owner",
        4,
        "doc-a",
        "a.md/child.md",
        "edited a",
        ("doc-a", "hosted a", "moment-owner-3"),
    );
    let pass = host.pull().await;
    assert_eq!(
        pass["held"],
        json!([{
            "objectId": "doc-b", "reason": "hosted-backfill-path-held",
            "path": "a.md", "heldBy": "doc-a",
        }])
    );
    assert!(host.commit(&pass["pendingCursor"]).await);
    assert_eq!(read("a.md/child.md").as_deref(), Some("edited a"));
    assert_eq!(read("b.md"), None);
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("held"));
}

/// Sol's second park review, on disk: the host applied `doc-b`'s move from
/// `x.md` to `a.md` and closed before materializing it, then `doc-b` left and
/// parked at `a.md`, which `doc-a` took. On its return, the pass dropped
/// every decision its history stored, the delete of `x.md` included, so
/// `x.md` stayed behind once `doc-b` came back at `a.md`, and a document
/// created at `x.md/child.md` could not materialize. Parking now finishes
/// the move, and the held return keeps `x.md` free.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_interrupted_move_is_finished_by_the_documents_held_return() {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-b", "x.md", "hosted b");
    relay.share("doc-b", "x.md");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    let read = |path: &str| std::fs::read_to_string(scratch.path().join(path)).ok();
    assert_eq!(read("x.md").as_deref(), Some("hosted b"));

    {
        let mut relay = relay.relay();
        relay.rename(
            "owner",
            2,
            "doc-b",
            "x.md",
            "a.md",
            "hosted b",
            "moment-owner-1",
        );
        relay.share("doc-b", "a.md");
    }
    assert!(
        host.pull().await["pendingCursor"].is_null(),
        "adopts the scope"
    );
    // This pass applies the move; the host closes before materializing it.
    assert!(host.pull().await["pendingCursor"].is_object());
    host.call("workspace.close", json!({})).await;
    drop(host);
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };

    assert_eq!(
        read("x.md").as_deref(),
        Some("hosted b"),
        "the move never landed"
    );
    relay.relay().unshare("doc-b");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("parked"));
    assert_eq!(read("x.md"), None, "parking finished the move");
    assert_eq!(read("a.md"), None, "and its file went with the document");
    {
        let mut relay = relay.relay();
        relay.create("owner", 3, "doc-a", "a.md", "hosted a");
        relay.share("doc-a", "a.md");
    }
    host.sync().await;
    assert_eq!(read("a.md").as_deref(), Some("hosted a"));

    relay.relay().share("doc-b", "a.md");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("held"));
    assert_eq!(read("x.md"), None, "its history removed the file it left");
    assert_eq!(read("a.md").as_deref(), Some("hosted a"));

    relay.relay().rename(
        "owner",
        4,
        "doc-a",
        "a.md",
        "c.md",
        "hosted a",
        "moment-owner-3",
    );
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("ready"));
    assert_eq!(read("a.md").as_deref(), Some("hosted b"));
    assert_eq!(read("c.md").as_deref(), Some("hosted a"));
    assert!(!scratch.path().join("x.md").exists());

    {
        let mut relay = relay.relay();
        relay.create("owner", 5, "doc-c", "x.md/child.md", "hosted c");
        relay.share("doc-c", "x.md/child.md");
    }
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-c").as_deref(), Some("ready"));
    assert_eq!(read("x.md/child.md").as_deref(), Some("hosted c"));
}

/// Sol's third park review: `doc-b` moved from `x.md` to `x.md/child.md`,
/// which the host materialized, then to `a.md`, which it applied and closed
/// before materializing. `doc-b` parked, `doc-a` took `a.md`, and `doc-b`
/// returned held. Its history stored deletes of both `x.md` and
/// `x.md/child.md`, and the delete of `x.md`, a folder on disk, failed every
/// pass, so the file it left stayed and the pass never committed. Parking
/// now finishes the move, and the held return's deletes land too, so later
/// documents take `x.md/child.md` and then `x.md`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_held_returns_nested_history_clears_its_files_and_their_folder() {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-b", "x.md", "hosted b");
    relay.rename(
        "owner",
        2,
        "doc-b",
        "x.md",
        "x.md/child.md",
        "hosted b",
        "moment-owner-1",
    );
    relay.share("doc-b", "x.md/child.md");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    let read = |path: &str| std::fs::read_to_string(scratch.path().join(path)).ok();
    assert_eq!(read("x.md/child.md").as_deref(), Some("hosted b"));

    {
        let mut relay = relay.relay();
        relay.rename(
            "owner",
            3,
            "doc-b",
            "x.md/child.md",
            "a.md",
            "hosted b",
            "moment-owner-2",
        );
        relay.share("doc-b", "a.md");
    }
    assert!(
        host.pull().await["pendingCursor"].is_null(),
        "adopts the scope"
    );
    // This pass applies the move; the host closes before materializing it.
    assert!(host.pull().await["pendingCursor"].is_object());
    host.call("workspace.close", json!({})).await;
    drop(host);
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };

    assert_eq!(
        read("x.md/child.md").as_deref(),
        Some("hosted b"),
        "the move never landed"
    );
    relay.relay().unshare("doc-b");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("parked"));
    assert!(
        !scratch.path().join("x.md").exists(),
        "parking finished the move, and its file went with the document"
    );
    {
        let mut relay = relay.relay();
        relay.create("owner", 4, "doc-a", "a.md", "hosted a");
        relay.share("doc-a", "a.md");
    }
    host.sync().await;
    assert_eq!(read("a.md").as_deref(), Some("hosted a"));

    relay.relay().share("doc-b", "a.md");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("held"));
    assert!(
        !scratch.path().join("x.md").exists(),
        "its history removed the file it left, and the folder that held it"
    );
    assert_eq!(read("a.md").as_deref(), Some("hosted a"));

    {
        let mut relay = relay.relay();
        relay.create("owner", 5, "doc-c", "x.md/child.md", "hosted c");
        relay.share("doc-c", "x.md/child.md");
    }
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-c").as_deref(), Some("ready"));
    assert_eq!(read("x.md/child.md").as_deref(), Some("hosted c"));

    {
        let mut relay = relay.relay();
        relay.rename(
            "owner",
            6,
            "doc-c",
            "x.md/child.md",
            "c.md",
            "hosted c",
            "moment-owner-5",
        );
        relay.share("doc-c", "c.md");
    }
    host.sync().await;
    assert_eq!(read("c.md").as_deref(), Some("hosted c"));
    assert!(!scratch.path().join("x.md").exists(), "{:?}", read("x.md"));
    {
        let mut relay = relay.relay();
        relay.create("owner", 7, "doc-d", "x.md", "hosted d");
        relay.share("doc-d", "x.md");
    }
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-d").as_deref(), Some("ready"));
    assert_eq!(read("x.md").as_deref(), Some("hosted d"));
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("held"));
}

/// One step of a document's history on the relay.
#[derive(Clone, Copy)]
enum Step {
    Create(&'static str),
    Move(&'static str, &'static str),
    Delete(&'static str),
}

/// Each history a returning document runs through: into a child path, out
/// of one, out of two levels, a case-only rename, a delete then a recreate,
/// a plain move, and out of a child path into its folder's name in another
/// case. The first step is synced before the rest.
const HISTORIES: [&[Step]; 7] = [
    &[Step::Create("x.md"), Step::Move("x.md", "x.md/child.md")],
    &[
        Step::Create("x.md/child.md"),
        Step::Move("x.md/child.md", "x.md"),
    ],
    &[
        Step::Create("x.md/sub/child.md"),
        Step::Move("x.md/sub/child.md", "x.md"),
    ],
    &[Step::Create("p.md"), Step::Move("p.md", "P.md")],
    &[
        Step::Create("x.md"),
        Step::Delete("x.md"),
        Step::Create("x.md"),
    ],
    &[Step::Create("x.md"), Step::Move("x.md", "y.md")],
    &[
        Step::Create("X.md/child.md"),
        Step::Move("X.md/child.md", "x.md"),
    ],
];

/// Where the host stops in the matrix.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stop {
    None,
    /// After applying the rest of the history, before materializing it. The
    /// pass after the restart finishes it.
    BeforeLastMaterialized,
    /// The same, having removed the file the history left but not the
    /// folders above it.
    BetweenFileAndFolder,
    /// After applying the rest of the history, before materializing it; the
    /// documents leave the scope before any pass retries, so parking
    /// finishes it.
    ParkedBeforeRetry,
    /// The same, with parking's finish stopped after removing the file the
    /// history left but not the folders above it.
    ParkedMidFinish,
    /// After applying the return's first pass, before materializing it.
    InReturn,
}

impl Stop {
    /// Whether the host stops after applying the rest of the history.
    fn before_materialized(self) -> bool {
        !matches!(self, Self::None | Self::InReturn)
    }

    /// Whether the documents leave the scope before a pass retries.
    fn parks_first(self) -> bool {
        matches!(self, Self::ParkedBeforeRetry | Self::ParkedMidFinish)
    }
}

/// What holds a returning document's path when it returns.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Occupant {
    Free,
    /// Another document's file.
    File,
    /// Another document's folder.
    Folder,
    /// A retired file of another document whose folder cannot go yet.
    #[cfg(windows)]
    Retired,
}

const OCCUPANTS: &[Occupant] = &[
    Occupant::Free,
    Occupant::File,
    Occupant::Folder,
    #[cfg(windows)]
    Occupant::Retired,
];

/// One returning document, `b-<prefix>`, and what holds its path, `o-<prefix>`,
/// under their own folder.
struct Row {
    prefix: String,
    history: &'static [Step],
    occupant: Occupant,
}

impl Row {
    fn doc(&self) -> String {
        format!("b-{}", self.prefix)
    }

    fn other(&self) -> String {
        format!("o-{}", self.prefix)
    }

    fn at(&self, path: &str) -> String {
        format!("{}/{path}", self.prefix)
    }

    fn start(&self) -> String {
        match self.history[0] {
            Step::Create(path) => self.at(path),
            _ => unreachable!("a history starts with its creation"),
        }
    }

    fn end(&self) -> String {
        self.history
            .iter()
            .rev()
            .find_map(|step| match step {
                Step::Create(path) | Step::Move(_, path) => Some(self.at(path)),
                Step::Delete(_) => None,
            })
            .expect("a history ends at a path")
    }

    /// Where its occupant's file sits while it holds the path.
    fn occupant_at(&self) -> Option<String> {
        match self.occupant {
            Occupant::Free => None,
            Occupant::File => Some(self.end()),
            Occupant::Folder => Some(format!("{}/child.md", self.end())),
            #[cfg(windows)]
            Occupant::Retired => Some(format!("{}/r/c.md", self.end())),
        }
    }

    fn moved(&self) -> String {
        self.at("moved.md")
    }
}

/// The owner's writes to the relay, with each document's text and latest
/// moment.
#[derive(Default)]
struct Owner {
    seq: i64,
    latest: HashMap<String, (String, String)>,
}

impl Owner {
    fn step(&mut self, relay: &mut HostedRelay, object_id: &str, prefix: &str, step: Step) {
        let at = |path: &str| format!("{prefix}/{path}");
        match step {
            Step::Create(path) => self.create(relay, object_id, &at(path)),
            Step::Move(from, to) => self.rename(relay, object_id, &at(from), &at(to)),
            Step::Delete(path) => {
                self.seq += 1;
                let (text, before) = &self.latest[object_id];
                relay.delete("owner", self.seq, object_id, &at(path), text, before);
            }
        }
    }

    fn create(&mut self, relay: &mut HostedRelay, object_id: &str, path: &str) {
        self.seq += 1;
        let text = format!("{object_id} {}", self.seq);
        relay.create("owner", self.seq, object_id, path, &text);
        self.latest.insert(
            object_id.to_owned(),
            (text, format!("moment-owner-{}", self.seq)),
        );
    }

    fn rename(&mut self, relay: &mut HostedRelay, object_id: &str, from: &str, to: &str) {
        self.seq += 1;
        let (text, before) = self.latest[object_id].clone();
        relay.rename("owner", self.seq, object_id, from, to, &text, &before);
        self.latest.insert(
            object_id.to_owned(),
            (text, format!("moment-owner-{}", self.seq)),
        );
    }

    fn text(&self, object_id: &str) -> String {
        self.latest[object_id].0.clone()
    }

    /// Each row's document at the end of its history, with its text.
    fn heads<'r>(&self, rows: impl IntoIterator<Item = &'r Row>) -> BTreeMap<String, String> {
        rows.into_iter()
            .map(|row| (row.end(), self.text(&row.doc())))
            .collect()
    }
}

/// Every file under the root but the engine's own, with its text, and every
/// empty folder.
fn disk(root: &std::path::Path) -> (BTreeMap<String, String>, Vec<String>) {
    fn walk(
        root: &std::path::Path,
        dir: &std::path::Path,
        files: &mut BTreeMap<String, String>,
        empty: &mut Vec<String>,
    ) {
        let relative = |path: &std::path::Path| {
            path.strip_prefix(root)
                .expect("under the root")
                .to_string_lossy()
                .replace('\\', "/")
        };
        let mut any = false;
        for entry in std::fs::read_dir(dir).expect("read folder") {
            let path = entry.expect("entry").path();
            any = true;
            if dir == root && relative(&path).starts_with('.') {
                continue;
            }
            if std::fs::symlink_metadata(&path).expect("metadata").is_dir() {
                walk(root, &path, files, empty);
            } else {
                files.insert(
                    relative(&path),
                    std::fs::read_to_string(&path).expect("text"),
                );
            }
        }
        if !any {
            empty.push(relative(dir));
        }
    }
    let (mut files, mut empty) = (BTreeMap::new(), Vec::new());
    walk(root, root, &mut files, &mut empty);
    empty.sort();
    (files, empty)
}

async fn reopen(host: Host, scratch: &ScratchDir, relay: &FakeRelay) -> Host {
    let mut host = host;
    host.call("workspace.close", json!({})).await;
    drop(host);
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, scratch, relay).await;
    Host {
        transport,
        handle,
        id: 1,
    }
}

/// The fourth park review: each round found another edge in replaying a
/// returning document's stored decisions. Every history above runs, beside
/// every occupant, through one stop. Each pass commits, a document is ready
/// only once its path is free, the disk holds exactly the heads, and no file
/// or empty folder of a history stays at a free path, also when a document
/// parks before its interrupted history was retried.
async fn returning_document_matrix(stop: Stop) {
    let rows: Vec<Row> = HISTORIES
        .iter()
        .enumerate()
        .flat_map(|(h, history)| {
            OCCUPANTS.iter().map(move |occupant| Row {
                prefix: format!("h{h}-{occupant:?}").to_lowercase(),
                history,
                occupant: *occupant,
            })
        })
        .collect();
    let mut owner = Owner::default();
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    for row in &rows {
        owner.step(&mut relay, &row.doc(), &row.prefix, row.history[0]);
        relay.share(&row.doc(), &row.start());
    }
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    let started = rows
        .iter()
        .map(|row| (row.start(), owner.text(&row.doc())))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(disk(scratch.path()), (started.clone(), vec![]));

    {
        let mut relay = relay.relay();
        for row in &rows {
            for step in &row.history[1..] {
                owner.step(&mut relay, &row.doc(), &row.prefix, *step);
            }
            relay.share(&row.doc(), &row.end());
        }
    }
    let ended = owner.heads(&rows);
    if stop.before_materialized() {
        assert!(
            host.pull().await["pendingCursor"].is_null(),
            "adopts the scope"
        );
        assert!(host.pull().await["pendingCursor"].is_object());
        // The pass applied the rest of every history and wrote none of it.
        for row in &rows {
            assert_eq!(head_path(&scratch, &row.doc()), Some(row.end()));
        }
        assert_eq!(disk(scratch.path()), (started, vec![]));
        if matches!(stop, Stop::BetweenFileAndFolder | Stop::ParkedMidFinish) {
            // The file the history left is gone, and each folder above it
            // but the outermost.
            for row in &rows {
                let left = row.history[1..]
                    .iter()
                    .find_map(|step| match step {
                        Step::Move(from, _) | Step::Delete(from) => Some(*from),
                        Step::Create(_) => None,
                    })
                    .expect("a history leaves a path");
                let path = row.at(left);
                std::fs::remove_file(scratch.path().join(&path)).expect("remove the left file");
                let mut folder = path.as_str();
                while let Some((parent, _)) = folder.rsplit_once('/')
                    && parent.matches('/').count() > 1
                {
                    std::fs::remove_dir(scratch.path().join(parent)).expect("remove its folder");
                    folder = parent;
                }
            }
        }
        host = reopen(host, &scratch, &relay).await;
    }
    if !stop.parks_first() {
        host.sync().await;
        for row in &rows {
            assert_eq!(
                document_state(&scratch, &row.doc()).as_deref(),
                Some("ready"),
                "{}",
                row.prefix
            );
        }
        assert_eq!(disk(scratch.path()), (ended.clone(), vec![]));
    }

    {
        let mut relay = relay.relay();
        for row in &rows {
            relay.unshare(&row.doc());
        }
    }
    host.sync().await;
    for row in &rows {
        assert_eq!(
            document_state(&scratch, &row.doc()).as_deref(),
            Some("parked"),
            "{}",
            row.prefix
        );
    }
    assert_eq!(disk(scratch.path()), (BTreeMap::new(), vec![]));

    {
        let mut relay = relay.relay();
        for row in &rows {
            if let Some(at) = row.occupant_at() {
                owner.create(&mut relay, &row.other(), &at);
                relay.share(&row.other(), &at);
            }
        }
    }
    host.sync().await;
    #[cfg(windows)]
    let locks = {
        use std::os::windows::fs::OpenOptionsExt;
        let locks = rows
            .iter()
            .filter(|row| row.occupant == Occupant::Retired)
            .map(|row| {
                std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(0x0200_0000) // FILE_FLAG_BACKUP_SEMANTICS, to open a folder
                    .share_mode(0x1 | 0x2) // read | write, no delete
                    .open(scratch.path().join(format!("{}/r", row.end())))
                    .expect("lock folder")
            })
            .collect::<Vec<_>>();
        {
            let mut relay = relay.relay();
            for row in rows.iter().filter(|row| row.occupant == Occupant::Retired) {
                relay.unshare(&row.other());
            }
        }
        host.sync().await;
        locks
    };
    // Another document's file or folder stays where it is; a retired file's
    // folder stays empty while it cannot go.
    let mut stuck = Vec::new();
    let mut returned = owner.heads(rows.iter().filter(|row| row.occupant == Occupant::Free));
    for row in &rows {
        match row.occupant {
            Occupant::Free => {}
            Occupant::File | Occupant::Folder => {
                returned.insert(row.occupant_at().unwrap(), owner.text(&row.other()));
            }
            #[cfg(windows)]
            Occupant::Retired => stuck.push(format!("{}/r", row.end())),
        }
    }
    stuck.sort();

    {
        let mut relay = relay.relay();
        for row in &rows {
            relay.share(&row.doc(), &row.end());
        }
    }
    if stop == Stop::InReturn {
        assert!(
            host.pull().await["pendingCursor"].is_null(),
            "adopts the scope"
        );
        assert!(host.pull().await["pendingCursor"].is_object());
        host = reopen(host, &scratch, &relay).await;
    }
    host.sync().await;
    for row in &rows {
        let state = if row.occupant == Occupant::Free {
            "ready"
        } else {
            "held"
        };
        assert_eq!(
            document_state(&scratch, &row.doc()).as_deref(),
            Some(state),
            "{}",
            row.prefix
        );
    }
    assert_eq!(disk(scratch.path()), (returned, stuck));

    {
        let mut relay = relay.relay();
        for row in &rows {
            if matches!(row.occupant, Occupant::File | Occupant::Folder) {
                let at = row.occupant_at().unwrap();
                owner.rename(&mut relay, &row.other(), &at, &row.moved());
                relay.share(&row.other(), &row.moved());
            }
        }
    }
    #[cfg(windows)]
    drop(locks);
    host.sync().await;
    for row in &rows {
        assert_eq!(
            document_state(&scratch, &row.doc()).as_deref(),
            Some("ready"),
            "{}",
            row.prefix
        );
    }
    let mut settled = ended;
    settled.extend(
        rows.iter()
            .filter(|row| matches!(row.occupant, Occupant::File | Occupant::Folder))
            .map(|row| (row.moved(), owner.text(&row.other()))),
    );
    assert_eq!(disk(scratch.path()), (settled, vec![]));
    let conn = Connection::open(engine_db_path(&scratch).expect("db path")).expect("open db");
    let retired: i64 = conn
        .query_row("SELECT COUNT(*) FROM hosted_retired_files", [], |row| {
            row.get(0)
        })
        .expect("count");
    assert_eq!(retired, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_returning_document_settles_with_no_stop() {
    returning_document_matrix(Stop::None).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_returning_document_settles_after_a_stop_before_its_last_change_materialized() {
    returning_document_matrix(Stop::BeforeLastMaterialized).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_returning_document_settles_after_a_stop_between_a_file_and_its_folder() {
    returning_document_matrix(Stop::BetweenFileAndFolder).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_returning_document_settles_after_a_stop_in_its_return() {
    returning_document_matrix(Stop::InReturn).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_document_parked_before_a_retry_settles() {
    returning_document_matrix(Stop::ParkedBeforeRetry).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_document_whose_finish_stopped_while_parking_settles() {
    returning_document_matrix(Stop::ParkedMidFinish).await;
}

/// Sol's fifth park review: the host applied the deletion of `x.md` and
/// closed before materializing it, then `doc-x` left the scope. Parking
/// checked only its heads, of which it had none, so `doc-x` parked and
/// `x.md` stayed on disk with no document. Parking now finishes the
/// deletion first.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_deletion_applied_before_a_restart_lands_when_its_document_parks() {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-x", "x.md", "hosted x");
    relay.share("doc-x", "x.md");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    let x = BTreeMap::from([("x.md".to_owned(), "hosted x".to_owned())]);
    assert_eq!(disk(scratch.path()), (x.clone(), vec![]));

    relay
        .relay()
        .delete("owner", 2, "doc-x", "x.md", "hosted x", "moment-owner-1");
    assert!(host.pull().await["pendingCursor"].is_object());
    assert_eq!(head_path(&scratch, "doc-x"), None, "the deletion applied");
    assert_eq!(disk(scratch.path()), (x, vec![]), "and never landed");
    host = reopen(host, &scratch, &relay).await;

    relay.relay().unshare("doc-x");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-x").as_deref(), Some("parked"));
    assert_eq!(disk(scratch.path()), (BTreeMap::new(), vec![]));
}

/// The durability review of parking, on disk: a return held at its path
/// wrote its file only in the pass that unparked it, so a host that stopped
/// after that pass and before materializing it made `doc-b` ready on the
/// next pass with no file. `doc-b` returns to `a.txt` while `doc-a` holds
/// it; `doc-a` moves, the next pass unparks `doc-b`, and the host closes
/// before materializing. After it reopens, `doc-b` is ready only once its
/// file holds its head. With `settled`, that head was last written by the
/// host's own settlement of a live edit, which no row of the feed carries.
async fn held_return_interrupted_after_unparking_writes_its_file_after_a_restart(settled: bool) {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-b", "a.txt", "hosted b");
    relay.share("doc-b", "a.txt");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    if settled {
        let session = host
            .call(
                "ydoc.open",
                json!({"versionId": "main", "path": "a.txt", "contentKind": "plaintext",
                    "seedFromArtifact": false}),
            )
            .await["sessionId"]
            .clone();
        let edit = base64::engine::general_purpose::STANDARD
            .encode(dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "settled "));
        host.call(
            "ydoc.recordUpdate",
            json!({ "expectedLineageClaimId": null, "sessionId": session, "updateBase64": edit}),
        )
        .await;
        host.call("ydoc.settle", json!({"sessionId": session}))
            .await;
        host.call("ydoc.close", json!({"sessionId": session})).await;
        host.call("sync.push", json!({"workspaceId": WORKSPACE}))
            .await;
    }
    let file = scratch.path().join("a.txt");
    let head = std::fs::read_to_string(&file).expect("a.txt");
    assert_eq!(head != "hosted b", settled, "{head}");

    relay.relay().unshare("doc-b");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("parked"));
    assert!(!file.exists());
    {
        let mut relay = relay.relay();
        relay.create("owner", 2, "doc-a", "a.txt", "hosted a");
        relay.share("doc-a", "a.txt");
    }
    host.sync().await;
    relay.relay().share("doc-b", "a.txt");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("held"));

    relay.relay().rename(
        "owner",
        3,
        "doc-a",
        "a.txt",
        "c.txt",
        "hosted a",
        "moment-owner-2",
    );
    let freed = host.pull().await;
    assert_eq!(freed["hasMore"], true);
    assert!(host.commit(&freed["pendingCursor"]).await);
    assert!(!file.exists());
    // This pass unparks doc-b; the host closes before materializing it.
    let unparked = host.pull().await;
    assert!(unparked["pendingCursor"].is_object());
    host.call("workspace.close", json!({})).await;
    drop(host);

    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    let pass = host.pull().await;
    assert_eq!(pass["held"], json!([]));
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("held"));
    assert!(!file.exists());
    assert!(host.commit(&pass["pendingCursor"]).await);
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("ready"));
    assert_eq!(std::fs::read_to_string(&file).expect("a.txt"), head);
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("c.txt")).expect("c.txt"),
        "hosted a"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_held_return_interrupted_after_unparking_writes_its_file_after_a_restart() {
    held_return_interrupted_after_unparking_writes_its_file_after_a_restart(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_settled_head_interrupted_after_unparking_writes_its_file_after_a_restart() {
    held_return_interrupted_after_unparking_writes_its_file_after_a_restart(true).await;
}

/// The slice-3 re-review's first reproduction, through a live session:
/// `doc-b` has an unsettled edit when the scope moves to `doc-a`. It keeps
/// its head and its file while its session holds that edit, and retires once
/// the edit settles, the relay has the host's rows and the session closes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_departed_document_keeps_its_head_until_its_session_settles() {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-b", "a.txt", "hosted b");
    relay.share("doc-b", "a.txt");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    let opened = host
        .call(
            "ydoc.open",
            json!({"versionId": "main", "path": "a.txt", "contentKind": "plaintext",
                "seedFromArtifact": false}),
        )
        .await;
    let session = opened["sessionId"].clone();
    let edit = base64::engine::general_purpose::STANDARD
        .encode(dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "unsettled "));
    host.call(
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": null, "sessionId": session, "updateBase64": edit}),
    )
    .await;
    // Nothing waits for the relay, so only the session keeps doc-b.
    assert_eq!(
        host.call("sync.push", json!({"workspaceId": WORKSPACE}))
            .await["pushed"],
        0
    );

    {
        let mut relay = relay.relay();
        relay.unshare("doc-b");
        relay.replace(
            "owner",
            2,
            "doc-a",
            "a.txt",
            "hosted a",
            ("doc-b", "hosted b", "moment-owner-1"),
        );
        relay.share("doc-a", "a.txt");
    }
    host.sync().await;
    let file = scratch.path().join("a.txt");
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("ready"));
    assert_eq!(std::fs::read_to_string(&file).expect("a.txt"), "hosted b");

    host.call("ydoc.settle", json!({"sessionId": session}))
        .await;
    host.call("ydoc.close", json!({"sessionId": session})).await;
    host.call("sync.push", json!({"workspaceId": WORKSPACE}))
        .await;
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("parked"));
    assert_eq!(std::fs::read_to_string(&file).expect("a.txt"), "hosted a");
}

/// The session host's live host on a hosted replica: the trusted owner of its
/// registrations, called as the relay calls it.
struct LiveHost {
    service: Arc<EngineService>,
    owner: ConnectionOwner,
    workspace: WorkspaceHandle,
    main_version_id: String,
}

impl LiveHost {
    async fn provision(service: Arc<EngineService>, host: &Host, scratch: &ScratchDir) -> Self {
        let owner = ConnectionOwner::authenticated();
        service
            .provision_live_application(
                owner.handle(),
                LiveApplicationHostConfig {
                    workspace: host.handle.clone(),
                    namespace: "hosted-relay".into(),
                    coordinate: ApplicationHostCoordinate {
                        host_id: "host".into(),
                        host_epoch: 1,
                        instance_id: "instance".into(),
                        connection_id: "connection".into(),
                    },
                    max_registrations: 4,
                },
            )
            .await
            .expect("provision live host");
        let main_version_id = Connection::open(engine_db_path(scratch).expect("db path"))
            .expect("open db")
            .query_row(
                "SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1",
                [WORKSPACE],
                |row| row.get(0),
            )
            .expect("main version");
        Self {
            service,
            owner,
            workspace: host.handle.clone(),
            main_version_id,
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, WireError> {
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(self.owner.handle());
        service_call_with_busy_retry(
            &self.service,
            ctx,
            request(900, method, Some(self.workspace.clone()), params),
        )
        .await
        .map(|response| response.response.result)
    }

    /// Register `object_id` under the lineage [`journal_live_update`] names.
    async fn register(&self, object_id: &str, path: &str) -> Result<Value, WireError> {
        let binding = json!({
            "workspaceId": WORKSPACE, "mainVersionId": self.main_version_id,
            "objectId": object_id, "lineageClaimId": "0".repeat(64),
            "currentPath": path, "selectorPaths": [path], "restoreFenceGeneration": 0,
        });
        self.call("liveApplication.register", json!({"binding": binding}))
            .await
            .map(|registered| registered["registrationId"].clone())
    }

    /// Whether the registration still answers its owner.
    async fn registered(&self, registration: &Value) -> bool {
        self.output(registration).await.is_ok()
    }

    /// The guard on the registration's output to its owner, as an
    /// acknowledgement read leaves it.
    async fn output(&self, registration: &Value) -> Result<Arc<dyn OutputGuard>, WireError> {
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(self.owner.handle());
        let read = request(
            900,
            "liveApplication.ack",
            Some(self.workspace.clone()),
            json!({"registrationId": registration, "deliveryId": "probe",
                "updateDigest": "00".repeat(32)}),
        );
        service_call_with_busy_retry(&self.service, ctx, read)
            .await
            .map(|response| response.output_guard.expect("output guard"))
    }
}

/// Each live binding the writer holds for the hosted replica, and whether it
/// is available.
fn native_bindings(scratch: &ScratchDir) -> Vec<(String, bool)> {
    let conn = Connection::open(engine_db_path(scratch).expect("db path")).expect("open db");
    let mut statement = conn
        .prepare(
            "SELECT object_id,available FROM live_device_application_bindings \
             WHERE workspace_id=?1 ORDER BY object_id",
        )
        .expect("bindings");
    statement
        .query_map([WORKSPACE], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("bindings")
        .collect::<Result<_, _>>()
        .expect("bindings")
}

/// Part 5's held fence. `doc-a` and `doc-b` are ready, each with a live
/// registration and an editor session, when the scope moves `doc-a` off its
/// head's path. The pass that holds it drops its registration and session
/// before it replies; `doc-b` keeps both, and `doc-a`'s accepted work still
/// reaches the relay. `doc-a` registers again only once a commit settles it
/// ready at its new path.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_document_held_while_live_loses_its_registration_and_session_in_the_same_pass() {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-a", "a.txt", "hosted a");
    relay.create("owner", 2, "doc-b", "b.txt", "hosted b");
    relay.share("doc-a", "a.txt");
    relay.share("doc-b", "b.txt");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let service = Arc::new(hosted_service());
    let transport = InProcessTransport::new(Arc::clone(&service));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    let live = LiveHost::provision(service, &host, &scratch).await;
    let registration_a = live.register("doc-a", "a.txt").await.expect("register a");
    let registration_b = live.register("doc-b", "b.txt").await.expect("register b");
    let mut sessions = Vec::new();
    for path in ["a.txt", "b.txt"] {
        let opened = host
            .call(
                "ydoc.open",
                json!({"versionId": "main", "path": path, "contentKind": "plaintext",
                    "seedFromArtifact": false}),
            )
            .await;
        sessions.push(opened["sessionId"].clone());
    }
    let edit = |text: &str| {
        base64::engine::general_purpose::STANDARD
            .encode(dohc_engine_collab::Ydoc::wire().plaintext_insert(0, text))
    };
    // An accepted live update of doc-a, journaled for the relay.
    journal_live_update(&scratch, "doc-a", "a.txt", b"accepted");
    let output_a = live.output(&registration_a).await.expect("output a");
    let output_b = live.output(&registration_b).await.expect("output b");

    relay.relay().share("doc-a", "moved.txt");
    let adopted = host.pull().await;
    assert_eq!(adopted["pendingCursor"], Value::Null);
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("held"));
    assert!(!output_a.is_current());
    assert!(output_b.is_current());
    assert!(!live.registered(&registration_a).await);
    assert!(live.registered(&registration_b).await);
    // The release is in memory: the binding stays available, so doc-a's
    // accepted work still proves and pushes.
    assert_eq!(
        native_bindings(&scratch),
        [("doc-a".to_owned(), true), ("doc-b".to_owned(), true)]
    );
    host.id += 1;
    call_error(
        &host.transport,
        &host.handle,
        host.id,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": null, "sessionId": sessions[0], "updateBase64": edit("closed ")}),
    )
    .await;

    // Its accepted work stays, waiting for the relay.
    let outbox: i64 = Connection::open(engine_db_path(&scratch).expect("db path"))
        .expect("open db")
        .query_row(
            "SELECT COUNT(*) FROM replication_log WHERE workspace_id=?1 AND imported=0 \
             AND op_kind='ydoc.update' AND json_extract(payload_json,'$.objectId')='doc-a'",
            [WORKSPACE],
            |row| row.get(0),
        )
        .expect("outbox");
    assert_eq!(outbox, 1);

    // Held, it registers nowhere until a commit settles it ready, and a
    // commit that leaves it held closes a session opened since its pass. The
    // refusal says it is not ready, so the session host waits rather than stops.
    assert_eq!(
        live.register("doc-a", "moved.txt")
            .await
            .map_err(|error| (error.code, error.message)),
        Err((ErrorCode::Conflict, "hosted-document-unready".to_owned()))
    );
    let still_held = host.pull().await;
    let reopened = host
        .call(
            "ydoc.open",
            json!({"versionId": "main", "path": "a.txt", "contentKind": "plaintext",
                "seedFromArtifact": false}),
        )
        .await["sessionId"]
        .clone();
    assert!(host.commit(&still_held["pendingCursor"]).await);
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("held"));
    host.id += 1;
    call_error(
        &host.transport,
        &host.handle,
        host.id,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": null, "sessionId": reopened, "updateBase64": edit("closed ")}),
    )
    .await;
    relay.relay().rename(
        "owner",
        3,
        "doc-a",
        "a.txt",
        "moved.txt",
        "hosted a",
        "moment-owner-1",
    );
    let pass = host.pull().await;
    assert_eq!(pass["held"], json!([]));
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("held"));
    assert!(live.register("doc-a", "moved.txt").await.is_err());
    assert!(host.commit(&pass["pendingCursor"]).await);
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("ready"));
    let registered = live.register("doc-a", "moved.txt").await.expect("ready");
    assert!(live.registered(&registered).await);
    assert!(live.registered(&registration_b).await);
    host.call(
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": null, "sessionId": sessions[1], "updateBase64": edit("still open ")}),
    )
    .await;
}

/// How many cursors the hosted replica has committed.
fn cursor_commits(scratch: &ScratchDir) -> i64 {
    Connection::open(engine_db_path(scratch).expect("db path"))
        .expect("open db")
        .query_row(
            "SELECT cursor_commits FROM hosted_replicas WHERE workspace_id=?1",
            [WORKSPACE],
            |row| row.get(0),
        )
        .expect("cursor commits")
}

/// A landed commit is never reported as failed. The commit that leaves held
/// `doc-a` held lands while an editor step holds the session lock, so its
/// close of `doc-a`'s session waits. The caller cancelled then still gets the
/// commit once the close has run.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_commit_cancelled_after_it_lands_answers_committed_once_its_close_runs() {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-a", "a.txt", "hosted a");
    relay.share("doc-a", "a.txt");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let service = Arc::new(hosted_service());
    let transport = InProcessTransport::new(Arc::clone(&service));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.create().await;
    host.sync().await;
    relay.relay().share("doc-a", "moved.txt");
    host.pull().await;
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("held"));
    let pass = host.pull().await;
    let session = host
        .call(
            "ydoc.open",
            json!({"versionId": "main", "path": "a.txt", "contentKind": "plaintext",
                "seedFromArtifact": false}),
        )
        .await["sessionId"]
        .clone();
    let params = json!({"workspaceId": WORKSPACE, "pendingCursor": pass["pendingCursor"]});
    assert_eq!(
        host.call("sync.materializePendingCursor", params.clone())
            .await,
        json!({"materialized": true})
    );
    let before = cursor_commits(&scratch);

    let held = service
        .session_ops_for_harness(&host.handle)
        .await
        .expect("session lock");
    let ctx = RequestContext::unbounded();
    let cancel = ctx.cancel.clone();
    host.id += 1;
    let commit = request(
        host.id,
        "sync.commitCursor",
        Some(host.handle.clone()),
        params,
    );
    let mut committing = tokio::spawn({
        let service = Arc::clone(&service);
        async move {
            service
                .call(ctx, commit)
                .await
                .map(|response| response.response.result)
        }
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while cursor_commits(&scratch) == before {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the commit never landed"
        );
        tokio::task::yield_now().await;
    }
    cancel.cancel();
    assert!(
        tokio::time::timeout(Duration::from_millis(200), &mut committing)
            .await
            .is_err(),
        "the answer waits for the close"
    );
    drop(held);
    let answer = committing
        .await
        .expect("commit task")
        .expect("a landed commit answers");
    assert_eq!(answer["committed"], true);
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("held"));
    // The close ran before the answer.
    let edit = base64::engine::general_purpose::STANDARD
        .encode(dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "closed "));
    host.id += 1;
    call_error(
        &host.transport,
        &host.handle,
        host.id,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": null, "sessionId": session, "updateBase64": edit}),
    )
    .await;
}

/// The session host as it runs: a configured live host whose own connection
/// syncs the hosted replica under a real publication budget.
struct SessionHost {
    service: Arc<EngineService>,
    owner: ConnectionOwner,
    _ingress: LiveApplicationIngress,
    workspace: WorkspaceHandle,
    id: u64,
}

impl SessionHost {
    async fn start(scratch: &ScratchDir, relay: &FakeRelay) -> Self {
        let config: ConfiguredLiveHostConfig = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "hosted-relay",
            "host": {"hostId": "host", "hostEpoch": 1, "instanceId": "instance",
                "connectionId": "connection"},
            "workspaces": [{"root": scratch.path(), "workspaceId": WORKSPACE, "maxRegistrations": 4,
                "relay": {"baseUrl": relay.base_url, "bearerToken": BEARER,
                    "allowInsecureLoopbackForTests": true}}],
            "ingress": {"aggregateBytes": 512 * 1024 * 1024,
                "applicationWorkingReserveBytes": 8 * 1024 * 1024, "maxUploads": 2,
                "uploadDeadlineMs": 30_000},
            "sync": {"policy": {"maxClientVectorBytes": 100_000, "maxHostVectorBytes": 100_000,
                "maxOutputBytes": 1_000_000, "maxReadBytes": 4_000_000},
                "workingReserveBytes": 4_000_000},
        }))
        .expect("host configuration");
        let (service, owner, ingress) = EngineService::configured_live_host(config)
            .await
            .expect("session host");
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let hosts = service
            .call(ctx, request(1, "liveApplication.hosts", None, json!({})))
            .await
            .expect("hosts")
            .response
            .result;
        let workspace = serde_json::from_value(hosts["workspaces"][0]["workspaceHandle"].clone())
            .expect("workspace handle");
        Self {
            service,
            owner,
            _ingress: ingress,
            workspace,
            id: 1,
        }
    }

    fn context(&self) -> RequestContext {
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(self.owner.handle());
        ctx
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, WireError> {
        self.id += 1;
        let call = request(self.id, method, Some(self.workspace.clone()), params);
        service_call_with_busy_retry(&self.service, self.context(), call)
            .await
            .map(|response| response.response.result)
    }

    async fn sync(&mut self) {
        let workspace = json!({"workspaceId": WORKSPACE});
        for _ in 0..16 {
            let pass = self
                .call("sync.pullHosted", workspace.clone())
                .await
                .expect("pull");
            let mut more = pass["hasMore"] == true;
            if pass["pendingCursor"].is_object() {
                let cursor =
                    json!({"workspaceId": WORKSPACE, "pendingCursor": pass["pendingCursor"]});
                self.call("sync.materializePendingCursor", cursor.clone())
                    .await
                    .expect("materialize");
                let commit = self
                    .call("sync.commitCursor", cursor)
                    .await
                    .expect("commit");
                assert_eq!(
                    (&commit["committed"], &commit["retirement"]),
                    (&json!(true), &Value::Null)
                );
                more |= commit["hasMore"] == true;
            }
            if !more {
                return;
            }
        }
        panic!("the hosted replica did not catch up");
    }

    async fn register(&mut self, binding: &Value) -> Result<Value, WireError> {
        self.call("liveApplication.register", json!({"binding": binding}))
            .await
            .map(|registered| registered["registrationId"].clone())
    }

    /// Capture the document at `path` as the relay does, resuming the
    /// retained activation once it saved one.
    async fn capture(
        &mut self,
        path: &str,
        activation_id: Option<&str>,
    ) -> Result<Value, (ErrorCode, String)> {
        let mut params = json!({"path": path, "maxBytes": 1_000_000});
        if let Some(activation_id) = activation_id {
            params["activationId"] = json!(activation_id);
        }
        self.call("liveApplication.captureOwnerActivation", params)
            .await
            .map_err(|error| (error.code, error.message))
    }

    /// Detach the store and stop, as before a restart.
    async fn stop(mut self) {
        self.call("liveApplication.detachWorkspace", json!({}))
            .await
            .expect("detach");
    }
}

/// Retain an activation of `object_id` at `path`, whose head holds `text`, as
/// a capture leaves one in the store, and return its id.
fn retain_activation(scratch: &ScratchDir, object_id: &str, path: &str, text: &str) -> String {
    let mut conn = Connection::open(engine_db_path(scratch).expect("db path")).expect("open db");
    let tx = conn.transaction().expect("transaction");
    let baseline = dohc_engine_collab::Ydoc::wire().encode_full_state();
    let full_state = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, text);
    let lineage = dohc_engine_storage::put_binary_blob(&tx, &baseline).expect("baseline");
    let full_state_digest = dohc_engine_storage::put_binary_blob(&tx, &full_state).expect("state");
    let source = ImportedOwnerSource {
        version: 1,
        reader_source: false,
        relay_database_namespace: "hosted-relay".into(),
        workspace_id: WORKSPACE.into(),
        main_version_id: "main".into(),
        object_id: object_id.into(),
        lineage_claim_id: lineage.clone(),
        current_path: path.into(),
        replication_epoch: "epoch-2".into(),
        stream_identity: "stream-2".into(),
        committed_cursor: 2,
        base_origin_id: "owner".into(),
        base_origin_seq: 1,
        base_relay_seq: 2,
        source_moment_id: "moment-owner-1".into(),
        source_digest: hex_sha256(text.as_bytes()),
        source_byte_length: text.len() as i64,
        native_head_sequence: 1,
        full_state_digest: full_state_digest.clone(),
        full_state_byte_length: full_state.len(),
        predecessor_activation_id: None,
    };
    let descriptor = serde_json::to_string(&source).expect("descriptor");
    let activation_id = format!("ordinary-activation-{}", hex_sha256(descriptor.as_bytes()));
    tx.execute(
        "INSERT INTO ydoc_owner_activation_sources(activation_id,relay_database_namespace,\
         workspace_id,version_id,object_id,lineage_claim_id,source_moment_id,source_digest,\
         full_state_digest,descriptor_json) VALUES (?1,?2,?3,'main',?4,?5,?6,?7,?8,?9)",
        rusqlite::params![
            activation_id,
            source.relay_database_namespace,
            WORKSPACE,
            object_id,
            lineage,
            source.source_moment_id,
            source.source_digest,
            full_state_digest,
            descriptor
        ],
    )
    .expect("retain activation");
    tx.commit().expect("commit");
    activation_id
}

/// A relay sharing `doc-b` at `b.md`.
fn sharing_doc_b() -> FakeRelay {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-b", "b.md", "hosted b");
    relay.share("doc-b", "b.md");
    FakeRelay::start(relay)
}

/// Sol's review of the unready refusal: after a restart, a parked document has
/// no head and no session, so its resume finds it through the activation the
/// store retained and says it is not ready. The session host then forgets it,
/// rather than retrying an unavailable workspace on every pass.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_parked_documents_resume_after_a_restart_says_it_is_unready() {
    let relay = sharing_doc_b();
    let scratch = ScratchDir::new().expect("scratch");
    let mut host = SessionHost::start(&scratch, &relay).await;
    host.call(
        "sync.createHostedReplica",
        json!({"workspaceId": WORKSPACE, "replicationEpoch": "epoch-2", "streamIdentity": "stream-2"}),
    )
    .await
    .expect("create");
    host.sync().await;
    relay.relay().unshare("doc-b");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("parked"));
    assert_eq!(head_path(&scratch, "doc-b"), None);
    host.stop().await;
    let activation = retain_activation(&scratch, "doc-b", "b.md", "hosted b");

    let mut host = SessionHost::start(&scratch, &relay).await;
    assert_eq!(
        host.capture("b.md", Some(&activation)).await,
        Err((ErrorCode::Conflict, "hosted-document-unready".to_owned()))
    );
}

/// Sol's review of resume refusals: a workspace identity change selects a new
/// store, which never held the activation the relay retained. Once backfill
/// gives the document its head there, its resume is refused as a conflict, so
/// the session host blocks it rather than retrying an internal error.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_store_that_never_held_the_activation_refuses_its_resume_as_a_conflict() {
    let relay = sharing_doc_b();
    let scratch = ScratchDir::new().expect("scratch");
    let mut host = SessionHost::start(&scratch, &relay).await;
    host.call(
        "sync.createHostedReplica",
        json!({"workspaceId": WORKSPACE, "replicationEpoch": "epoch-2", "streamIdentity": "stream-2"}),
    )
    .await
    .expect("create");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("ready"));
    assert_eq!(head_path(&scratch, "doc-b").as_deref(), Some("b.md"));
    let elsewhere = format!("ordinary-activation-{}", "a".repeat(64));
    assert_eq!(
        host.capture("b.md", Some(&elsewhere)).await,
        Err((ErrorCode::Conflict, "live-application-conflict".to_owned()))
    );
}

/// A document written only as text has no Y.Doc lineage, so once its replica
/// is ready its first capture says there is nothing to activate, which the
/// session host stops on. While it is held, it may still change, so it waits.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_document_without_lineage_refuses_its_first_capture_only_once_ready() {
    let relay = sharing_doc_b();
    let scratch = ScratchDir::new().expect("scratch");
    let mut host = SessionHost::start(&scratch, &relay).await;
    host.call(
        "sync.createHostedReplica",
        json!({"workspaceId": WORKSPACE, "replicationEpoch": "epoch-2", "streamIdentity": "stream-2"}),
    )
    .await
    .expect("create");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("ready"));
    assert_eq!(
        host.capture("b.md", None).await,
        Err((
            ErrorCode::Conflict,
            "live-document-without-lineage".to_owned()
        ))
    );
    relay.relay().share("doc-b", "moved.md");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("held"));
    assert_eq!(
        host.capture("b.md", None).await,
        Err((ErrorCode::Conflict, "hosted-document-unready".to_owned()))
    );
}

/// The ready hold. Pause leaves `doc-b`'s live binding on the session host,
/// which keeps the owner's ordinary edit of its lineage queued, so its copy
/// here misses that edit. The queued edit holds it before the pass commits:
/// the pass reports it held, registration and capture say it is not ready,
/// and a restart keeps all of that. A refused edit of another lineage holds
/// nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unadmitted_owner_edit_holds_a_ready_document_across_a_restart() {
    let ydoc = dohc_engine_collab::Ydoc::wire();
    ydoc.richdoc_append_paragraph("hosted b");
    let base = ydoc.encode_full_state();
    let lineage = hex_sha256(&base);
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.ydoc("owner", 1, "doc-b", "b.md", &base, &lineage);
    relay.share("doc-b", "b.md");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let mut host = SessionHost::start(&scratch, &relay).await;
    let workspace = json!({"workspaceId": WORKSPACE});
    host.call(
        "sync.createHostedReplica",
        json!({"workspaceId": WORKSPACE, "replicationEpoch": "epoch-2", "streamIdentity": "stream-2"}),
    )
    .await
    .expect("create");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("ready"));
    let binding = json!({
        "workspaceId": WORKSPACE, "mainVersionId": "main", "objectId": "doc-b",
        "lineageClaimId": lineage, "currentPath": "b.md",
        "selectorPaths": ["b.md"], "restoreFenceGeneration": 0,
    });
    host.register(&binding).await.expect("register");
    let rows = |scratch: &ScratchDir, table: &str| -> i64 {
        Connection::open(engine_db_path(scratch).expect("db path"))
            .expect("open db")
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("rows")
    };
    let refused = |scratch: &ScratchDir| rows(scratch, "replication_refused_ydoc_blobs");
    let queued = |scratch: &ScratchDir| rows(scratch, "ydoc_deferred_updates");
    let unready = || Err((ErrorCode::Conflict, "hosted-document-unready".to_owned()));

    let elsewhere = dohc_engine_collab::Ydoc::wire().richdoc_append_paragraph("elsewhere");
    relay
        .relay()
        .ydoc("owner", 2, "doc-b", "b.md", &elsewhere, &"f".repeat(64));
    host.sync().await;
    assert_eq!(refused(&scratch), 1);
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("ready"));

    let edit = ydoc.richdoc_append_paragraph("edited while stopped");
    relay
        .relay()
        .ydoc("owner", 3, "doc-b", "b.md", &edit, &lineage);
    let pass = host
        .call("sync.pullHosted", workspace.clone())
        .await
        .expect("pull");
    let held = json!([{"objectId": "doc-b", "reason": "hosted-live-edit-unadmitted"}]);
    assert_eq!(pass["held"], held);
    assert_eq!((refused(&scratch), queued(&scratch)), (1, 1));
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("held"));
    assert_eq!(
        host.register(&binding)
            .await
            .map_err(|error| (error.code, error.message)),
        unready()
    );
    assert_eq!(host.capture("b.md", None).await, unready());
    host.stop().await;

    let mut host = SessionHost::start(&scratch, &relay).await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("held"));
    assert_eq!(host.capture("b.md", None).await, unready());
    let again = host.call("sync.pullHosted", workspace).await.expect("pull");
    assert_eq!(again["held"], held);
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-b").as_deref(), Some("held"));
    assert_eq!((refused(&scratch), queued(&scratch)), (1, 1));
}

/// Part 5's held fence under the session host's real publication budget. The
/// release is in memory: held `doc-a` keeps its binding available, so work it
/// accepted still proves, and the host's push carries the later write of
/// ready `doc-b`. Held, `doc-a` cannot register; once it leaves the scope, it
/// can, so work it accepted can settle and drain.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_held_document_leaves_the_push_running_and_registers_once_it_departs() {
    let mut relay = HostedRelay::default();
    relay.log.push(json!({
        "relaySeq": 1, "workspaceId": WORKSPACE, "originId": "owner", "originSeq": 0,
        "opKind": "workspace.init", "payload": {}, "recordedAtMs": 1_001,
    }));
    relay.create("owner", 1, "doc-a", "a.md", "hosted a");
    relay.create("owner", 2, "doc-b", "b.md", "hosted b");
    relay.share("doc-a", "a.md");
    relay.share("doc-b", "b.md");
    let relay = FakeRelay::start(relay);
    let scratch = ScratchDir::new().expect("scratch");
    let mut host = SessionHost::start(&scratch, &relay).await;
    let workspace = json!({"workspaceId": WORKSPACE});
    host.call(
        "sync.createHostedReplica",
        json!({"workspaceId": WORKSPACE, "replicationEpoch": "epoch-2", "streamIdentity": "stream-2"}),
    )
    .await
    .expect("create");
    host.sync().await;
    let main: String = Connection::open(engine_db_path(&scratch).expect("db path"))
        .expect("open db")
        .query_row(
            "SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1",
            [WORKSPACE],
            |row| row.get(0),
        )
        .expect("main version");
    let binding = json!({
        "workspaceId": WORKSPACE, "mainVersionId": main, "objectId": "doc-a",
        "lineageClaimId": "0".repeat(64), "currentPath": "a.md",
        "selectorPaths": ["a.md"], "restoreFenceGeneration": 0,
    });
    host.register(&binding).await.expect("register");

    relay.relay().share("doc-a", "moved.md");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("held"));
    assert_eq!(native_bindings(&scratch), [("doc-a".to_owned(), true)]);
    assert_eq!(
        host.register(&binding).await.map_err(|error| error.code),
        Err(ErrorCode::Conflict)
    );

    journal_live_update(&scratch, "doc-b", "b.md", b"later write");
    let pushed = host
        .call("sync.push", workspace.clone())
        .await
        .expect("push");
    assert_eq!(
        (&pushed["pushed"], &pushed["hasMore"]),
        (&json!(1), &json!(false))
    );
    assert_eq!(
        relay.relay().pushed[0]["ops"][0]["payload"]["objectId"],
        "doc-b"
    );

    // Work of doc-a still waits for the relay, so it does not retire when it
    // leaves the scope.
    journal_live_update(&scratch, "doc-a", "a.md", b"waiting write");
    relay.relay().unshare("doc-a");
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("held"));
    host.register(&binding)
        .await
        .expect("a departed document registers to settle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hosted_rpcs_refuse_a_replica_that_is_not_hosted_with_the_reason() {
    let relay = rotated_relay();
    let scratch = ScratchDir::new().expect("scratch");
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
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

/// What a hosted replica's store holds that a pass can change: its scope,
/// cursor and commits, its documents, and the work it journaled or keeps.
fn hosted_store_state(scratch: &ScratchDir) -> String {
    let conn = Connection::open(engine_db_path(scratch).expect("db path")).expect("open db");
    conn.query_row(
        "SELECT json_array( \
           (SELECT json_group_array(json_array(scope_token,scope_generation,main_cursor,cursor_commits)) \
            FROM hosted_replicas), \
           (SELECT json_group_array(json_array(object_id,state,backfill_cursor)) FROM hosted_documents), \
           (SELECT COUNT(*) FROM replication_log), \
           (SELECT COUNT(*) FROM relay_deferred_ops), \
           (SELECT COUNT(*) FROM ydoc_deferred_updates))",
        [],
        |row| row.get(0),
    )
    .expect("hosted store state")
}

/// Sol's sixth and Opus's eighth findings: a hosted pull no live host names a
/// feed for could adopt a scope and apply work before it failed. It is
/// refused before it reads the feed or changes the store, and the same
/// replica pulls once a feed is named.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_hosted_pull_no_live_host_configures_is_refused_before_it_reads_or_changes_anything() {
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
    let requests = relay.relay().requests.len();
    let before = hosted_store_state(&scratch);
    assert_eq!(
        host.error("sync.pullHosted").await,
        (
            ErrorCode::Forbidden,
            "live host is not configured".to_owned()
        )
    );
    assert_eq!(
        relay.relay().requests.len(),
        requests,
        "the refused pull read nothing"
    );
    assert_eq!(
        hosted_store_state(&scratch),
        before,
        "the refused pull changed nothing"
    );

    host.call("workspace.close", json!({})).await;
    drop(host);
    let transport = InProcessTransport::new(Arc::new(hosted_service()));
    let handle = open_workspace(&transport, &scratch, &relay).await;
    let mut host = Host {
        transport,
        handle,
        id: 1,
    };
    host.sync().await;
    assert_eq!(document_state(&scratch, "doc-a").as_deref(), Some("ready"));
}
