use std::collections::{BTreeSet, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use dohc_engine_storage::{EngineStore, NoFaults, StorageError, TxnOutcome, hex_sha256};
use dohc_engine_sync::{
    BlobDownloadRequest, BlobHaveRequest, BlobKind, BlobUploadRequest, ClaimRequest, EpochRequest,
    KeyEnvelopeDownloadRequest, KeyEnvelopeRequest, NoLiveLeases, ObservedBytes, ProbeRequest,
    PullRequest, RelayError, RelaySyncClient, RelayTransport, ReplicationEnvelope,
    ShareBlobRequest, ShareReplicationEnvelope, ShareViewRequest, SharedChannelRequest,
    SyncPassOutcome, blob_ceiling, journal_local_replication_op, read_pushed_seq,
    read_relay_cursor,
};
use dohc_engine_sync_http::HttpRelayTransport;
use dohc_engine_testkit::ScratchDir;
use serde_json::{Value, json};

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
    fn json(status: u16, body: Value) -> Self {
        Self {
            status,
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

    fn redirect(location: impl Into<String>) -> Self {
        Self {
            status: 302,
            headers: vec![("location".to_owned(), location.into())],
            body: Vec::new(),
        }
    }

    fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }
}

struct FakeServer {
    base_url: String,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl FakeServer {
    fn start(handler: impl Fn(TestRequest) -> TestResponse + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake relay");
        listener
            .set_nonblocking(true)
            .expect("nonblocking fake relay");
        let address = listener.local_addr().expect("fake relay address");
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let handler = Arc::new(handler);
        let thread = thread::spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if stream.set_nonblocking(false).is_err() {
                            continue;
                        }
                        if let Ok(request) = read_request(&mut stream) {
                            let response = handler(request);
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
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for FakeServer {
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
        if let Some(index) = find_subslice(&bytes, b"\r\n\r\n") {
            break index + 4;
        }
        let mut chunk = [0_u8; 8192];
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "request headers ended early",
            ));
        }
        bytes.extend_from_slice(&chunk[..count]);
    };
    let headers_text = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "request headers"))?;
    let mut lines = headers_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_owned();
    let target = request_parts.next().unwrap_or_default().to_owned();
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
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "request body ended early",
        ));
    }
    Ok(TestRequest {
        method,
        target,
        headers,
        body: bytes[header_end..header_end + content_length].to_vec(),
    })
}

fn write_response(stream: &mut TcpStream, response: TestResponse) -> std::io::Result<()> {
    let reason = match response.status {
        200 => "OK",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        _ => "Internal Server Error",
    };
    write!(stream, "HTTP/1.1 {} {}\r\n", response.status, reason)?;
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

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn transport(server: &FakeServer) -> HttpRelayTransport {
    HttpRelayTransport::new_insecure_loopback_for_tests(&server.base_url, "test-token")
        .expect("HTTP relay transport")
}

fn probe(transport: &HttpRelayTransport) -> Result<dohc_engine_sync::ProbeResponse, RelayError> {
    transport.probe(ProbeRequest {
        workspace_id: "ws".to_owned(),
        replication_epoch: "epoch".to_owned(),
        stream_identity: "stream".to_owned(),
    })
}

fn store() -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = scratch.engine_db_path().expect("engine db path");
    let store = EngineStore::open(&path, 1_000).expect("open engine store");
    (scratch, path, store)
}

fn seed_identity(store: &mut EngineStore, payload: &Value) {
    seed_identity_with_kind(store, "probe.local", payload);
}

fn seed_identity_with_kind(store: &mut EngineStore, op_kind: &str, payload: &Value) {
    assert_eq!(
        journal_local_replication_op(
            store, "ws", "local", "epoch-1", "stream-1", op_kind, payload, 1_000, &NoFaults,
        )
        .expect("seed sync identity"),
        TxnOutcome::Committed(0)
    );
}

fn remote_row(origin_id: &str, origin_seq: i64, op_kind: &str, payload: Value) -> Value {
    json!({
        "relaySeq": origin_seq + 1,
        "workspaceId": "ws",
        "originId": origin_id,
        "originSeq": origin_seq,
        "opKind": op_kind,
        "payload": payload,
        "recordedAtMs": 2_000
    })
}

fn log_page(ops: Vec<Value>, next_cursor: i64, has_more: bool) -> TestResponse {
    TestResponse::json(
        200,
        json!({
            "ok": true,
            "ops": ops,
            "nextCursor": next_cursor,
            "hasMore": has_more
        }),
    )
}

#[derive(Default)]
struct PushBoundaryState {
    have_sizes: Vec<usize>,
    log_sizes: Vec<usize>,
    blob_puts: usize,
    auth_failures: usize,
}

#[test]
fn push_chunks_ops_and_blob_have_at_server_boundaries() {
    // MUTATION AUDIT: removing blob-have chunking sends 2,001 hashes and fails
    // [2,000, 1]. Removing the inner push chunking still passes because the
    // outer replication-log read already caps each iteration at 500 ops.
    let (_scratch, _path, mut engine) = store();
    let mut snapshots = Vec::new();
    let mut blobs = Vec::new();
    for index in 0..2_001 {
        let text = format!("blob-{index}");
        let sha256 = hex_sha256(text.as_bytes());
        snapshots.push(json!({"blobSha256": sha256}));
        blobs.push((sha256, text));
    }
    seed_identity_with_kind(
        &mut engine,
        "version.create",
        &json!({"forkSnapshots": snapshots}),
    );
    engine
        .write_with(&NoFaults, |transaction| {
            for (sha256, text) in &blobs {
                transaction
                    .execute(
                        "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                        rusqlite::params![sha256, text.len() as i64, text],
                    )
                    .map_err(StorageError::persist_public)?;
            }
            Ok::<(), StorageError>(())
        })
        .expect("seed referenced blobs");
    for index in 0..500 {
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "probe.local",
            &json!({"index": index}),
            1_001 + index,
            &NoFaults,
        )
        .expect("append local op");
    }

    let state = Arc::new(Mutex::new(PushBoundaryState::default()));
    let handler_state = Arc::clone(&state);
    let server = FakeServer::start(move |request| {
        let mut state = handler_state.lock().expect("push state");
        if request.header("authorization") != Some("Bearer test-token") {
            state.auth_failures += 1;
        }
        match (request.method.as_str(), request.path()) {
            ("POST", "/sync/ws/blobs/have") => {
                let body = request.json();
                let sha256s = body["sha256s"].as_array().expect("sha array");
                assert_eq!(body["replicationEpoch"], "epoch-1");
                assert_eq!(body["streamIdentity"], "stream-1");
                state.have_sizes.push(sha256s.len());
                TestResponse::json(200, json!({"ok": true, "missing": [sha256s[0].clone()]}))
            }
            ("PUT", path) if path.starts_with("/sync/ws/blobs/") => {
                let sha256 = path.rsplit('/').next().expect("sha path");
                assert_eq!(hex_sha256(&request.body), sha256);
                state.blob_puts += 1;
                TestResponse::json(200, json!({"ok": true}))
            }
            ("POST", "/sync/ws/log") => {
                let body = request.json();
                assert_eq!(body["replicationEpoch"], "epoch-1");
                assert_eq!(body["streamIdentity"], "stream-1");
                let ops = body["ops"].as_array().expect("ops array");
                state.log_sizes.push(ops.len());
                let current = ops
                    .last()
                    .and_then(|op| op["originSeq"].as_i64())
                    .unwrap_or(-1);
                TestResponse::json(
                    200,
                    json!({
                        "ok": true,
                        "accepted": ops.len(),
                        "inserted": ops.len(),
                        "skipped": 0,
                        "currentMaxOriginSeq": current
                    }),
                )
            }
            _ => TestResponse::json(500, json!({"code": "internal_error"})),
        }
    });

    let outcome = RelaySyncClient::new(transport(&server))
        .push_workspace(&mut engine, "ws", &NoFaults)
        .expect("push workspace");
    assert!(matches!(
        outcome,
        SyncPassOutcome::Complete { pushed: 501, .. }
    ));
    assert_eq!(
        read_pushed_seq(&engine, "ws", "local").expect("pushed seq"),
        500
    );
    let state = state.lock().expect("push state");
    assert_eq!(state.have_sizes, [2_000, 1]);
    assert_eq!(state.log_sizes, [500, 1]);
    assert_eq!(state.blob_puts, 2);
    assert_eq!(state.auth_failures, 0);
}

#[test]
fn push_rejects_relay_origin_ahead_of_local_max() {
    // MUTATION: accepting currentMaxOriginSeq above the local maximum changes
    // this from OriginDiverged and advances state past local reality.
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine, &json!({}));
    let server = FakeServer::start(|request| match (request.method.as_str(), request.path()) {
        ("POST", "/sync/ws/log") => TestResponse::json(
            200,
            json!({
                "ok": true,
                "accepted": 1,
                "inserted": 1,
                "skipped": 0,
                "currentMaxOriginSeq": 1
            }),
        ),
        _ => TestResponse::json(500, json!({"code": "internal_error"})),
    });
    let error = RelaySyncClient::new(transport(&server))
        .push_workspace(&mut engine, "ws", &NoFaults)
        .expect_err("ahead relay must diverge");
    assert_eq!(error, RelayError::OriginDiverged);
    assert_eq!(
        read_pushed_seq(&engine, "ws", "local").expect("pushed seq"),
        -1
    );
}

#[test]
fn push_conflict_probes_empty_ops_rewinds_and_retries_once() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine, &json!({"index": 0}));
    journal_local_replication_op(
        &mut engine,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "probe.local",
        &json!({"index": 1}),
        1_001,
        &NoFaults,
    )
    .expect("second op");
    engine
        .write_with(&NoFaults, |transaction| {
            transaction
                .execute(
                    "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                 VALUES ('ws','local',0)",
                    [],
                )
                .map_err(StorageError::persist_public)?;
            Ok::<(), StorageError>(())
        })
        .expect("seed pushed cursor");
    let calls = Arc::new(Mutex::new(Vec::new()));
    let handler_calls = Arc::clone(&calls);
    let server = FakeServer::start(move |request| {
        let body = request.json();
        let ops = body["ops"].as_array().expect("ops");
        let call_index = {
            let mut calls = handler_calls.lock().expect("calls");
            calls.push(ops.len());
            calls.len()
        };
        match call_index {
            1 => TestResponse::json(409, json!({"ok": false, "code": "conflict"})),
            2 => TestResponse::json(
                200,
                json!({
                    "ok": true,
                    "accepted": 0,
                    "inserted": 0,
                    "skipped": 0,
                    "currentMaxOriginSeq": -1
                }),
            ),
            _ => {
                let current = ops.last().and_then(|op| op["originSeq"].as_i64()).unwrap();
                TestResponse::json(
                    200,
                    json!({
                        "ok": true,
                        "accepted": ops.len(),
                        "inserted": ops.len(),
                        "skipped": 0,
                        "currentMaxOriginSeq": current
                    }),
                )
            }
        }
    });
    let outcome = RelaySyncClient::new(transport(&server))
        .push_workspace(&mut engine, "ws", &NoFaults)
        .expect("rewind retry");
    assert!(matches!(
        outcome,
        SyncPassOutcome::Complete { pushed: 2, .. }
    ));
    assert_eq!(*calls.lock().expect("calls"), [1, 0, 2]);
    assert_eq!(
        read_pushed_seq(&engine, "ws", "local").expect("pushed seq"),
        1
    );
}

#[test]
fn push_rewind_is_durable_before_a_failed_retry() {
    // MUTATION: using the monotonic cursor helper for the rewind leaves 0
    // persisted after the retry fails instead of the relay's probed -1.
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine, &json!({"index": 0}));
    journal_local_replication_op(
        &mut engine,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "probe.local",
        &json!({"index": 1}),
        1_001,
        &NoFaults,
    )
    .expect("second op");
    engine
        .write_with(&NoFaults, |transaction| {
            transaction
                .execute(
                    "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                     VALUES ('ws','local',0)",
                    [],
                )
                .map_err(StorageError::persist_public)?;
            Ok::<(), StorageError>(())
        })
        .expect("seed pushed cursor");
    let calls = Arc::new(Mutex::new(0_usize));
    let handler_calls = Arc::clone(&calls);
    let server = FakeServer::start(move |request| {
        let call = {
            let mut calls = handler_calls.lock().expect("calls");
            *calls += 1;
            *calls
        };
        match call {
            1 => TestResponse::json(409, json!({"ok": false, "code": "conflict"})),
            2 => TestResponse::json(
                200,
                json!({
                    "ok": true,
                    "accepted": 0,
                    "inserted": 0,
                    "skipped": 0,
                    "currentMaxOriginSeq": -1
                }),
            ),
            3 => {
                assert_eq!(request.json()["ops"].as_array().expect("ops").len(), 2);
                TestResponse::json(500, json!({"ok": false, "code": "internal_error"}))
            }
            _ => panic!("unexpected retry"),
        }
    });

    assert_eq!(
        RelaySyncClient::new(transport(&server)).push_workspace(&mut engine, "ws", &NoFaults),
        Err(RelayError::ServerInternal)
    );
    assert_eq!(
        read_pushed_seq(&engine, "ws", "local").expect("rewound state"),
        -1,
        "the lower probe result must survive a process stop before retry success"
    );
}

#[test]
fn pull_aborts_when_has_more_cursor_does_not_advance() {
    // MUTATION: removing the forward-progress guard makes this fake page loop
    // until the test process is killed instead of returning NoProgress.
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine, &json!({}));
    let server = FakeServer::start(|_| log_page(Vec::new(), 0, true));
    let error = RelaySyncClient::new(transport(&server))
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect_err("non-advancing page must abort");
    assert_eq!(error, RelayError::NoProgress);
    assert!(read_relay_cursor(&engine, "ws").expect("cursor").is_none());
}

#[test]
fn pull_rejects_byte_different_coordinate_collision_before_apply() {
    // MUTATION: coordinate-only dedup treats the different payload as a skip;
    // the preflight byte comparison is what makes this fail closed.
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine, &json!({}));
    engine
        .write_with(&NoFaults, |transaction| {
            transaction
                .execute(
                    "INSERT INTO replication_log \
                 (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                 VALUES ('ws','peer',0,'probe.remote','{\"value\":1}',2000,1)",
                    [],
                )
                .map_err(StorageError::persist_public)?;
            Ok::<(), StorageError>(())
        })
        .expect("seed colliding row");
    let server = FakeServer::start(|_| {
        log_page(
            vec![remote_row("peer", 0, "probe.remote", json!({"value": 2}))],
            1,
            false,
        )
    });
    let error = RelaySyncClient::new(transport(&server))
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect_err("a foreign coordinate collision must fail closed");
    assert_eq!(error, RelayError::InvalidResponse);
    assert!(read_relay_cursor(&engine, "ws").expect("cursor").is_none());
}

#[test]
fn pull_accepts_the_relays_integral_float_normalization() {
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine, &json!({}));
    engine
        .write_with(&NoFaults, |transaction| {
            transaction
                .execute(
                    "INSERT INTO replication_log \
                     (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                     VALUES ('ws','peer',0,'workspace.init','{\"value\":1.0}',2000,1)",
                    [],
                )
                .map_err(StorageError::persist_public)?;
            Ok::<(), StorageError>(())
        })
        .expect("seed normalized coordinate");
    let server = FakeServer::start(|_| {
        log_page(
            vec![remote_row("peer", 0, "workspace.init", json!({"value": 1}))],
            1,
            false,
        )
    });

    let outcome = RelaySyncClient::new(transport(&server))
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("semantically identical number");
    assert!(matches!(
        outcome,
        SyncPassOutcome::Complete {
            applied: 0,
            skipped: 1,
            ..
        }
    ));
}

#[test]
fn pull_deserializes_rows_without_the_discarded_relay_sequence() {
    let server = FakeServer::start(|_| {
        log_page(
            vec![json!({
                "workspaceId": "ws",
                "originId": "peer",
                "originSeq": 0,
                "opKind": "workspace.init",
                "payload": {},
                "recordedAtMs": 1
            })],
            1,
            false,
        )
    });
    let response = transport(&server)
        .pull(PullRequest {
            workspace_id: "ws".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            cursor: 0,
            limit: 1,
        })
        .expect("relaySeq is not part of the client contract");
    assert_eq!(response.ops.len(), 1);
}

#[test]
fn direct_transport_rejects_fractional_wire_timestamps_without_rounding() {
    let mut row = remote_row("peer", 0, "workspace.init", json!({}));
    row["recordedAtMs"] = json!(1.5);
    let server = FakeServer::start(move |_| log_page(vec![row.clone()], 1, false));

    let error = transport(&server)
        .pull(PullRequest {
            workspace_id: "ws".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            cursor: 0,
            limit: 1,
        })
        .expect_err("fractional timestamps are outside the i64 wire contract");
    assert_eq!(error, RelayError::InvalidResponse);
    // MUTATION: accepting through f64 plus a cast/truncation makes this return
    // recordedAtMs=1 and admits different bytes than the sender supplied.
}

#[test]
fn direct_transport_rejects_an_oversized_outbound_payload_before_io() {
    // MUTATION: restoring the core's former 10 MiB allowance reaches the fake
    // network with a row the relay's 256 KiB contract can never accept.
    let server = FakeServer::start(|_| panic!("oversized payload reached the network"));
    let overhead = br#"{"data":""}"#.len();
    let payload =
        json!({"data": "x".repeat(dohc_engine_sync::MAX_PAYLOAD_JSON_BYTES - overhead + 1)});
    let error = transport(&server)
        .push(dohc_engine_sync::PushRequest {
            workspace_id: "ws".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            origin_id: "local".to_owned(),
            after_seq: -1,
            ops: vec![ReplicationEnvelope {
                workspace_id: "ws".to_owned(),
                origin_id: "local".to_owned(),
                origin_seq: 0,
                op_kind: "workspace.init".to_owned(),
                payload,
                recorded_at_ms: 1,
            }],
        })
        .expect_err("relay-oversized payload");
    assert_eq!(error, RelayError::PayloadTooLarge);
}

#[test]
fn pull_rejects_fetched_blob_with_wrong_sha() {
    // MUTATION AUDIT: removing the transport-layer re-hash still passes because
    // hydrate_blob_content independently hash-verifies. This test proves
    // end-to-end rejection, not that the transport check itself remains present.
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine, &json!({}));
    let claimed = hex_sha256(b"expected bytes");
    let handler_claimed = claimed.clone();
    let server = FakeServer::start(move |request| match request.path() {
        "/sync/ws/log" => log_page(
            vec![remote_row(
                "peer",
                0,
                "ydoc.update",
                json!({"updateBlobSha256": handler_claimed}),
            )],
            1,
            false,
        ),
        path if path.starts_with("/sync/ws/blobs/") => TestResponse::bytes(b"wrong bytes"),
        _ => TestResponse::json(500, json!({"code": "internal_error"})),
    });
    let error = RelaySyncClient::new(transport(&server))
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect_err("wrong blob content must fail");
    assert_eq!(error, RelayError::BlobInvalid);
    assert!(read_relay_cursor(&engine, "ws").expect("cursor").is_none());
    assert!(
        !engine
            .has_binary_blob(&claimed)
            .expect("binary blob presence")
    );
}

#[test]
fn pull_cursor_stays_deferred_across_crash_and_refetches_ops() {
    // MUTATION: committing at apply time persists cursor 1 before the caller
    // materializes to disk, so reopening after the simulated crash does not
    // redeliver the op and the durable-cursor assertions fail.
    let (_scratch, path, mut engine) = store();
    seed_identity(&mut engine, &json!({}));
    let server = FakeServer::start(move |request| {
        let query = request
            .target
            .split_once('?')
            .map(|(_, query)| query)
            .unwrap_or("");
        let since = query
            .split('&')
            .find_map(|part| part.strip_prefix("since="))
            .and_then(|value| value.parse::<i64>().ok())
            .expect("since query");
        if since == 0 {
            log_page(
                vec![remote_row(
                    "peer",
                    0,
                    "chat.reaction.set",
                    json!({
                        "reactionId": "r",
                        "messageId": "m",
                        "threadId": "t",
                        "emoji": "👍",
                        "authorId": "u",
                        "authorKind": "human",
                        "authorDisplayName": "U",
                        "atMs": 10,
                        "state": "added"
                    }),
                )],
                1,
                false,
            )
        } else {
            log_page(Vec::new(), since, false)
        }
    });
    let client = RelaySyncClient::new(transport(&server));
    let first = client
        .pull_chat_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases)
        .expect("first pull");
    assert!(matches!(
        first,
        SyncPassOutcome::Complete {
            applied: 1,
            pending_cursor: Some(_),
            ..
        }
    ));
    assert!(
        read_relay_cursor(&engine, "ws")
            .expect("durable cursor before crash")
            .is_none(),
        "pull must not persist the cursor before disk materialization"
    );

    // Discard the in-memory outcome and reopen the same durable store: this is
    // the crash window between database apply and disk materialization.
    drop(first);
    drop(engine);
    let mut reopened = EngineStore::open(&path, 2_000).expect("reopen after simulated crash");
    assert!(
        read_relay_cursor(&reopened, "ws")
            .expect("durable cursor after crash")
            .is_none(),
        "the simulated crash must leave the persisted cursor unchanged"
    );
    let second = client
        .pull_chat_workspace(&mut reopened, "ws", &NoFaults, &NoLiveLeases)
        .expect("second pull");
    let pending = match second {
        SyncPassOutcome::Complete {
            fetched: 1,
            applied: 0,
            skipped: 1,
            pending_cursor: Some(cursor),
            ..
        } => cursor,
        other => panic!("unexpected second pull: {other:?}"),
    };
    assert!(
        read_relay_cursor(&reopened, "ws")
            .expect("durable cursor before explicit commit")
            .is_none(),
        "redelivery must still leave the cursor pending"
    );
    assert_eq!(
        client
            .commit_pull_cursor(&mut reopened, "ws", &pending, &NoFaults)
            .expect("commit after materialization"),
        TxnOutcome::Committed(())
    );
    assert_eq!(
        read_relay_cursor(&reopened, "ws")
            .expect("cursor")
            .expect("committed cursor")
            .cursor,
        1
    );

    drop(reopened);
    let mut committed = EngineStore::open(&path, 3_000).expect("reopen after cursor commit");
    assert_eq!(
        read_relay_cursor(&committed, "ws")
            .expect("durable cursor after reopen")
            .expect("committed cursor after reopen")
            .cursor,
        1
    );
    let third = client
        .pull_chat_workspace(&mut committed, "ws", &NoFaults, &NoLiveLeases)
        .expect("pull after cursor commit");
    assert!(matches!(
        third,
        SyncPassOutcome::Complete {
            fetched: 0,
            applied: 0,
            skipped: 0,
            pending_cursor: Some(_),
            ..
        }
    ));
}

#[test]
fn every_relay_fixture_code_maps_to_its_rust_variant() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../services/sync-relay/relay-error-codes.json"
    ))
    .expect("relay error-code fixture");
    let cases = fixture
        .iter()
        .map(|entry| {
            let status = entry["status"].as_u64().expect("fixture status");
            let status = u16::try_from(status).expect("fixture status fits u16");
            let code = entry["code"].as_str().expect("fixture code").to_owned();
            (status, code)
        })
        .collect::<VecDeque<_>>();
    // MUTATION: collapsing a specific server code into a status-class error
    // makes the affected variant assertion fail.
    let expected = cases
        .iter()
        .map(|(_, code)| expected_relay_error(code))
        .collect::<Vec<_>>();
    let cases = Arc::new(Mutex::new(cases));
    let handler_cases = Arc::clone(&cases);
    let server = FakeServer::start(move |_| {
        let (status, code) = handler_cases
            .lock()
            .expect("error cases")
            .pop_front()
            .expect("planned error");
        TestResponse::json(status, json!({"ok": false, "code": code}))
    });
    let transport = transport(&server);
    for expected in expected {
        let actual = transport
            .probe(ProbeRequest {
                workspace_id: "ws".to_owned(),
                replication_epoch: "epoch-1".to_owned(),
                stream_identity: "stream-1".to_owned(),
            })
            .expect_err("planned relay error");
        assert_eq!(actual, expected);
    }
    assert!(cases.lock().expect("error cases").is_empty());
}

fn expected_relay_error(code: &str) -> RelayError {
    match code {
        "ambiguous_selector" => RelayError::AmbiguousSelector,
        "authorship_mismatch" => RelayError::AuthorshipMismatch,
        "bad_request" | "empty_selector" | "invalid_access" | "invalid_path"
        | "invalid_version" | "secret_path" | "too_many_paths" => RelayError::BadRequest,
        "blob_missing" => RelayError::BlobReferenceMissing,
        "blob_not_found" => RelayError::BlobMissing,
        "conflict" => RelayError::Conflict,
        "epoch_superseded" => RelayError::EpochSuperseded,
        "identity_not_recognized" => RelayError::IdentityNotRecognized,
        "identity_required" => RelayError::IdentityRequired,
        "internal_error" => RelayError::ServerInternal,
        "invalid_channel" => RelayError::InvalidChannel,
        "key_envelope_not_found" => RelayError::KeyEnvelopeMissing,
        "method_not_allowed" => RelayError::MethodNotAllowed,
        "not_found" => RelayError::WorkspaceUnavailable,
        "payload_too_large" => RelayError::PayloadTooLarge,
        "presence_capacity" => RelayError::PresenceCapacity,
        "quota_exceeded" => RelayError::QuotaExceeded,
        "self_share" => RelayError::SelfShare,
        "share_op_rejected" => RelayError::ShareOperationRejected,
        "share_read_only" => RelayError::ShareReadOnly,
        "stream_identity_mismatch" => RelayError::StreamIdentityMismatch,
        "unknown_chat_op" => RelayError::UnknownChatOperation,
        unknown => panic!("fixture code {unknown} needs an expected Rust variant"),
    }
}

#[test]
fn status_classes_and_all_transport_endpoints_preserve_auth_and_wire_shapes() {
    let seen = Arc::new(Mutex::new(BTreeSet::new()));
    let handler_seen = Arc::clone(&seen);
    let etag = "a".repeat(64);
    let handler_etag = etag.clone();
    let server = FakeServer::start(move |request| {
        assert_eq!(request.header("authorization"), Some("Bearer test-token"));
        let mut seen = handler_seen.lock().expect("seen endpoints");
        seen.insert(format!("{} {}", request.method, request.path()));
        seen.insert(format!("TARGET {}", request.target));
        drop(seen);
        match (request.method.as_str(), request.path()) {
            ("POST", "/sync/workspaces") => {
                let body = request.json();
                assert_eq!(body["workspaceId"], "ws");
                assert_eq!(body["replicationEpoch"], "epoch-1");
                TestResponse::json(200, json!({"ok": true}))
            }
            ("POST", "/sync/ws/epoch") => TestResponse::json(
                200,
                json!({
                    "ok": true,
                    "rotated": true,
                    "replicationEpoch": "epoch-2",
                    "streamIdentity": "stream-2"
                }),
            ),
            ("POST", "/sync/ws/log") | ("POST", "/sync/shares/share-1/log") => {
                let ops = request.json()["ops"].as_array().expect("ops").len();
                TestResponse::json(
                    200,
                    json!({
                        "ok": true,
                        "accepted": ops,
                        "inserted": ops,
                        "skipped": 0,
                        "currentMaxOriginSeq": if ops == 0 { -1 } else { 0 }
                    }),
                )
            }
            ("GET", "/sync/ws/log") => log_page(Vec::new(), 0, false),
            ("GET", "/sync/shares/share-1/log") => TestResponse::json(
                200,
                json!({
                    "ok": true,
                    "ops": [{
                        "relaySeq": 1,
                        "originId": "peer",
                        "originSeq": 0,
                        "opKind": "probe",
                        "payload": {},
                        "recordedAtMs": 1
                    }],
                    "nextCursor": 1,
                    "hasMore": false
                }),
            ),
            ("POST", "/sync/ws/blobs/have") => {
                TestResponse::json(200, json!({"ok": true, "missing": []}))
            }
            ("PUT", path) if path.starts_with("/sync/ws/blobs/") => {
                TestResponse::json(200, json!({"ok": true}))
            }
            ("GET", path) if path.starts_with("/sync/ws/blobs/") => TestResponse::bytes(b"blob"),
            ("PUT", "/sync/ws/keys") => TestResponse::json(200, json!({"ok": true}))
                .with_header("etag", &format!("\"{handler_etag}\"")),
            ("GET", "/sync/ws/keys") => TestResponse::bytes(br#"{"wrapped":"key"}"#)
                .with_header("content-type", "application/json")
                .with_header("etag", &format!("\"{handler_etag}\"")),
            ("GET", path) if path.starts_with("/sync/shares/share-1/blobs/") => {
                TestResponse::bytes(b"shared")
            }
            _ => TestResponse::json(500, json!({"code": "internal_error"})),
        }
    });
    let transport = transport(&server);
    let coordinate = || ("ws".to_owned(), "epoch-1".to_owned(), "stream-1".to_owned());
    let (workspace_id, replication_epoch, stream_identity) = coordinate();
    transport
        .claim_workspace(ClaimRequest {
            workspace_id,
            replication_epoch,
            stream_identity,
        })
        .expect("claim");
    let (workspace_id, _, _) = coordinate();
    transport
        .rotate_epoch(EpochRequest {
            workspace_id,
            replication_epoch: "epoch-2".to_owned(),
            stream_identity: "stream-2".to_owned(),
        })
        .expect("epoch");
    let (workspace_id, replication_epoch, stream_identity) = coordinate();
    transport
        .push(dohc_engine_sync::PushRequest {
            workspace_id,
            replication_epoch,
            stream_identity,
            origin_id: "local".to_owned(),
            after_seq: -1,
            ops: vec![ReplicationEnvelope {
                workspace_id: "ws".to_owned(),
                origin_id: "local".to_owned(),
                origin_seq: 0,
                op_kind: "probe".to_owned(),
                payload: json!({}),
                recorded_at_ms: 1,
            }],
        })
        .expect("workspace push");
    let (workspace_id, replication_epoch, stream_identity) = coordinate();
    transport
        .pull(PullRequest {
            workspace_id,
            replication_epoch,
            stream_identity,
            cursor: 0,
            limit: 1,
        })
        .expect("workspace pull");
    let (workspace_id, replication_epoch, stream_identity) = coordinate();
    transport
        .blobs_have(BlobHaveRequest {
            workspace_id,
            replication_epoch,
            stream_identity,
            sha256s: vec!["b".repeat(64)],
        })
        .expect("blob have");
    let (workspace_id, replication_epoch, stream_identity) = coordinate();
    transport
        .upload_blob(BlobUploadRequest {
            workspace_id,
            replication_epoch,
            stream_identity,
            sha256: "b".repeat(64),
            bytes: b"blob".to_vec(),
        })
        .expect("blob upload");
    let (workspace_id, replication_epoch, stream_identity) = coordinate();
    transport
        .download_blob(BlobDownloadRequest {
            workspace_id,
            replication_epoch,
            stream_identity,
            sha256: "b".repeat(64),
        })
        .expect("blob download");
    let (workspace_id, replication_epoch, stream_identity) = coordinate();
    transport
        .upload_key_envelope(KeyEnvelopeRequest {
            workspace_id,
            replication_epoch,
            stream_identity,
            envelope_json: "{}".to_owned(),
            if_match: Some(etag.clone()),
        })
        .expect("key upload");
    let (workspace_id, replication_epoch, stream_identity) = coordinate();
    transport
        .download_key_envelope(KeyEnvelopeDownloadRequest {
            workspace_id,
            replication_epoch,
            stream_identity,
        })
        .expect("key download");
    transport
        .shared_channel_push(SharedChannelRequest {
            share_id: "share-1".to_owned(),
            channel_wire_id: "wire-1".to_owned(),
            origin_id: "member".to_owned(),
            cursor: 0,
            ops: vec![ShareReplicationEnvelope {
                origin_id: "member".to_owned(),
                origin_seq: 0,
                op_kind: "probe".to_owned(),
                payload: json!({}),
                recorded_at_ms: 1,
            }],
        })
        .expect("share push");
    transport
        .shared_channel_pull(SharedChannelRequest {
            share_id: "share-1".to_owned(),
            channel_wire_id: "wire-1".to_owned(),
            origin_id: "member".to_owned(),
            cursor: 0,
            ops: Vec::new(),
        })
        .expect("share pull");
    transport
        .share_view_pull(ShareViewRequest {
            share_id: "share-1".to_owned(),
            cursor: 0,
            limit: usize::MAX,
        })
        .expect("share view pull");
    transport
        .share_blob(ShareBlobRequest {
            share_id: "share-1".to_owned(),
            sha256: "b".repeat(64),
        })
        .expect("share blob");

    let seen = seen.lock().expect("seen endpoints");
    for endpoint in [
        "POST /sync/workspaces",
        "POST /sync/ws/log",
        "GET /sync/ws/log",
        "POST /sync/ws/epoch",
        "POST /sync/ws/blobs/have",
        "PUT /sync/ws/blobs/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "GET /sync/ws/blobs/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "PUT /sync/ws/keys",
        "GET /sync/ws/keys",
        "POST /sync/shares/share-1/log",
        "GET /sync/shares/share-1/log",
        "GET /sync/shares/share-1/blobs/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ] {
        assert!(seen.contains(endpoint), "missing endpoint {endpoint}");
    }
    assert!(
        seen.contains("TARGET /sync/shares/share-1/log?since=0&limit=500&channelWireId=wire-1")
    );
    assert!(
        seen.contains("TARGET /sync/shares/share-1/log?since=0&limit=500"),
        "MUTATION: forwarding an unbounded share-view limit exceeds the response budget"
    );
}

#[test]
fn status_401_404_and_409_remain_distinct() {
    let responses = Arc::new(Mutex::new(VecDeque::from([
        TestResponse::json(401, json!({"ok": false})),
        TestResponse::json(404, json!({"ok": false})),
        TestResponse::json(409, json!({"ok": false})),
    ])));
    let handler_responses = Arc::clone(&responses);
    let server = FakeServer::start(move |_| {
        handler_responses
            .lock()
            .expect("responses")
            .pop_front()
            .expect("planned response")
    });
    let transport = transport(&server);
    for expected in [
        RelayError::Unauthorized,
        RelayError::WorkspaceUnavailable,
        RelayError::Conflict,
    ] {
        assert_eq!(
            transport
                .probe(ProbeRequest {
                    workspace_id: "ws".to_owned(),
                    replication_epoch: "epoch".to_owned(),
                    stream_identity: "stream".to_owned(),
                })
                .expect_err("planned status"),
            expected
        );
    }
}

#[test]
fn redirect_to_plaintext_destination_is_refused_without_following() {
    let destination_hit = Arc::new(AtomicBool::new(false));
    let destination_hit_for_handler = Arc::clone(&destination_hit);
    let destination = FakeServer::start(move |_| {
        destination_hit_for_handler.store(true, Ordering::SeqCst);
        log_page(Vec::new(), 0, false)
    });
    let location = format!("{}/sync/ws/log", destination.base_url);
    let source = FakeServer::start(move |_| TestResponse::redirect(location.clone()));

    assert_eq!(
        probe(&transport(&source)).expect_err("redirect must be refused"),
        RelayError::BadRequest
    );
    assert!(
        !destination_hit.load(Ordering::SeqCst),
        "MUTATION: allowing redirects sends the bearer request over plaintext"
    );
}

#[test]
fn redirect_to_link_local_destination_is_refused_before_connection() {
    let source =
        FakeServer::start(|_| TestResponse::redirect("http://169.254.169.254/latest/meta-data/"));

    assert_eq!(
        probe(&transport(&source)).expect_err("link-local redirect must be refused"),
        RelayError::BadRequest,
        "MUTATION: following this redirect reintroduces an SSRF host/port oracle"
    );
}

#[test]
fn loopback_opt_in_still_performs_direct_requests() {
    let server = FakeServer::start(|_| log_page(Vec::new(), 0, false));
    let response = probe(&transport(&server)).expect("direct loopback request");
    assert!(!response.has_content);
}

#[test]
fn key_envelope_upload_rejects_an_oversized_ack_body() {
    let server = FakeServer::start(|_| {
        TestResponse::bytes(vec![b'x'; 64 * 1024 + 1]).with_header("etag", "\"etag\"")
    });
    let error = transport(&server)
        .upload_key_envelope(KeyEnvelopeRequest {
            workspace_id: "ws".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            envelope_json: "{}".to_owned(),
            if_match: None,
        })
        .expect_err("oversized key ack");
    assert_eq!(
        error,
        RelayError::InvalidResponse,
        "MUTATION: restoring the log-page budget accepts a ~133 MiB key ack"
    );
}

#[test]
fn generic_blob_404_is_workspace_unavailable_not_blob_missing() {
    let server = FakeServer::start(|_| TestResponse::json(404, json!({"code": "not_found"})));
    let error = transport(&server)
        .download_blob(BlobDownloadRequest {
            workspace_id: "ws".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            sha256: "b".repeat(64),
        })
        .expect_err("workspace-level blob 404");
    assert_eq!(error, RelayError::WorkspaceUnavailable);
}

#[test]
fn a_blob_at_the_ingest_ceiling_arrives_whole() {
    // The relay stores blobs up to `MAX_BLOB_BYTES`, which is the text ceiling,
    // so an at-ceiling text blob is work the relay legally serves.
    //
    // MUTATION: set the read limit back to `MAX_INGEST_BLOB_BYTES` and this
    // fails with `InvalidResponse` — `ureq` refuses a body once a read reaches
    // its limit, so the last byte the ceiling allows never arrives.
    let (_constraint, limit_bytes) = blob_ceiling(BlobKind::Text);
    let server = FakeServer::start(move |request| match request.path() {
        path if path.starts_with("/sync/ws/blobs/") => TestResponse::bytes(vec![b'a'; limit_bytes]),
        _ => TestResponse::json(500, json!({"code": "internal_error"})),
    });
    let response = transport(&server)
        .download_blob(BlobDownloadRequest {
            workspace_id: "ws".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            sha256: "b".repeat(64),
        })
        .expect("an at-ceiling blob downloads");
    assert_eq!(response.bytes.len(), limit_bytes);
}

#[test]
fn pull_names_the_text_ceiling_for_an_oversized_relay_blob() {
    // The production transport must carry the refusal ingest writes, not
    // replace it with an unreadable-response error that names no limit.
    //
    // MUTATION: set the read limit back to `MAX_INGEST_BLOB_BYTES` and the
    // caller gets `InvalidResponse` instead, with no constraint, no configured
    // limit, and no observed size.
    let (_scratch, _path, mut engine) = store();
    seed_identity(&mut engine, &json!({}));
    let (constraint, limit_bytes) = blob_ceiling(BlobKind::Text);
    let oversized = vec![b'a'; limit_bytes + 1];
    let sha256 = hex_sha256(&oversized);
    let handler_sha = sha256.clone();
    let server = FakeServer::start(move |request| match request.path() {
        "/sync/ws/log" => log_page(
            vec![remote_row(
                "peer",
                0,
                "version.create",
                json!({
                    "versionId": "oversized-blob-version",
                    "name": "oversized-blob-version",
                    "kind": "named",
                    "forkVersionId": "main",
                    "forkMomentId": "fork-moment",
                    "createdAtMs": 1_500,
                    "forkSnapshots": [{
                        "objectId": "oversized-blob-object",
                        "objectCreatedAtMs": 1_100,
                        "path": "oversized-blob.md",
                        "blobSha256": handler_sha,
                        "byteLength": 7,
                        "updatedAtMs": 1_200,
                        "latestMomentId": "oversized-blob-object-moment",
                        "metadata": {"origin": "sync"}
                    }]
                }),
            )],
            1,
            false,
        ),
        path if path.starts_with("/sync/ws/blobs/") => TestResponse::bytes(oversized.clone()),
        _ => TestResponse::json(500, json!({"code": "internal_error"})),
    });
    // The served bytes hash to the requested sha256, so only the ceiling can
    // refuse them.
    assert_eq!(
        RelaySyncClient::new(transport(&server)).pull_chat_workspace(
            &mut engine,
            "ws",
            &NoFaults,
            &NoLiveLeases
        ),
        Err(RelayError::BlobTooLarge {
            constraint,
            limit_bytes,
            observed: ObservedBytes::Exact(limit_bytes + 1),
        })
    );
    assert!(read_relay_cursor(&engine, "ws").expect("cursor").is_none());
}

#[test]
fn a_blob_body_past_the_read_limit_still_names_the_ceiling() {
    // A one-byte overage reaches ingest, which reports an exact size. A larger
    // one never finishes reading, so the transport reports the floor it proved
    // rather than inventing a total. Both name a constraint, a limit, and a
    // unit; the diagnostic does not fall off a cliff at two bytes.
    //
    // MUTATION: map the read failure back to a bare `RelayError::InvalidResponse`
    // and this fails — the caller learns nothing about which limit it broke.
    let (_constraint, limit_bytes) = blob_ceiling(BlobKind::Text);
    let far_over = limit_bytes + 4096;
    let server = FakeServer::start(move |request| match request.path() {
        path if path.starts_with("/sync/ws/blobs/") => TestResponse::bytes(vec![b'a'; far_over]),
        _ => TestResponse::json(500, json!({"code": "internal_error"})),
    });
    let error = transport(&server)
        .download_blob(BlobDownloadRequest {
            workspace_id: "ws".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            sha256: "b".repeat(64),
        })
        .expect_err("a body past the read limit is refused");
    assert_eq!(
        error,
        RelayError::BlobTooLarge {
            constraint: "MAX_INGEST_BLOB_BYTES",
            limit_bytes,
            observed: ObservedBytes::AtLeast(limit_bytes + 2),
        }
    );
    assert_eq!(
        error.to_string(),
        format!(
            "relay blob exceeds MAX_INGEST_BLOB_BYTES: limit {limit_bytes} bytes, \
             observed at least {} bytes",
            limit_bytes + 2
        )
    );
}
