use super::*;
use crate::WorkspaceSupervisor;
use dohc_engine_storage::StorageError;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::params;

fn fixture(coordinates: usize) -> (ScratchDir, std::path::PathBuf, EngineStore) {
    fixture_with_mode(coordinates, false)
}

fn fixture_with_mode(
    coordinates: usize,
    passive: bool,
) -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let scratch = ScratchDir::new().unwrap();
    let path = engine_db_path(&scratch).unwrap();
    let mut store = if passive {
        EngineStore::open_passive(&path, 1_000, None, None).unwrap()
    } else {
        EngineStore::open(&path, 1_000).unwrap()
    };
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .unwrap();
    adopt_join_identity(
        &mut store, "ws", "local", "epoch", "stream", 1_000, &NoFaults,
    )
    .unwrap();
    let claim =
        dohc_engine_storage::hex_sha256(&dohc_engine_collab::Ydoc::wire().encode_full_state());
    store
        .put_binary_blob(&dohc_engine_collab::Ydoc::wire().encode_full_state())
        .unwrap();
    store.write_with(&NoFaults, |tx| {
        for index in 0..coordinates {
            let object = format!("doc-{index:05}");
            let payload = serde_json::json!({"versionId":"main", "objectId":object,
                "path":format!("{object}.md"), "contentKind":"plaintext",
                "lineageClaimId":claim, "updateBlobSha256":claim, "isBaseState":true});
            tx.execute("INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('ws',?1,1000)", [&object]).map_err(StorageError::persist_public)?;
            tx.execute("INSERT INTO ydoc_docs (workspace_id,version_id,object_id,content_kind,regime,updated_at_ms,path,lineage_claim_status,lineage_claim_id) VALUES ('ws','main',?1,'plaintext','replicated',1000,?2,'exact',?3)", params![object,format!("{object}.md"),claim]).map_err(StorageError::persist_public)?;
            tx.execute("INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported,apply_disposition) VALUES ('ws','peer',?1,'ydoc.update',?2,1000,1,'applied')",params![index as i64,payload.to_string()]).map_err(StorageError::persist_public)?;
            tx.execute("INSERT INTO ydoc_base_relay_candidates (workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq) VALUES ('ws','main',?1,?2,'peer',?3)",params![object,claim,index as i64]).map_err(StorageError::persist_public)?;
        }
        Ok::<_, StorageError>(())
    }).unwrap();
    (scratch, path, store)
}

fn operation() -> RelayOperation {
    RelayOperation::Pull {
        workspace_id: "ws".into(),
        now_ms: 1_200,
    }
}

#[derive(Default)]
struct Relay {
    lookups: usize,
    pulls: usize,
    deferred: bool,
}

impl Relay {
    fn answer(&mut self, request: &RelayIoRequest) -> RelayIoResponse {
        match request {
            RelayIoRequest::Pull(_) => {
                self.pulls += 1;
                RelayIoResponse::Pull(PullResponse {
                    ops: Vec::new(),
                    next_cursor: 0,
                    has_more: false,
                })
            }
            RelayIoRequest::LookupCoordinates(requests) => {
                assert!(requests.len() <= 256);
                self.lookups += requests.len();
                RelayIoResponse::LookupCoordinates(
                    requests
                        .iter()
                        .map(|request| self.coordinate(request))
                        .collect(),
                )
            }
            other => panic!("unexpected repair request: {other:?}"),
        }
    }

    fn coordinate(&self, request: &LogCoordinateRequest) -> LogCoordinateResponse {
        if !self.deferred {
            return LogCoordinateResponse::Absent;
        }
        let object = format!("doc-{:05}", request.origin_seq);
        let claim =
            dohc_engine_storage::hex_sha256(&dohc_engine_collab::Ydoc::wire().encode_full_state());
        LogCoordinateResponse::Present(dohc_engine_sync::ReplicationEnvelope {
            workspace_id: request.workspace_id.clone(),
            origin_id: request.origin_id.clone(),
            origin_seq: request.origin_seq,
            op_kind: "ydoc.update".into(),
            recorded_at_ms: 1_000,
            relay_seq: Some(request.origin_seq + 1),
            settlement_admission: None,
            admitted_author_snapshot: None,
            payload: serde_json::json!({"versionId":"main", "objectId":object,
                "path":format!("{object}.md"), "contentKind":"plaintext",
                "lineageClaimId":claim, "updateBlobSha256":claim, "isBaseState":false}),
        })
    }
}

fn remaining(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM ydoc_base_relay_candidates) +
                    (SELECT COUNT(*) FROM ydoc_deferred_updates WHERE relay_seq IS NULL)",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

fn one_group(store: &mut EngineStore) {
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE ydoc_base_relay_candidates SET object_id='doc-00000'", []).map_err(StorageError::persist_public)?;
        tx.execute("UPDATE replication_log SET payload_json=json_set(payload_json,'$.objectId','doc-00000','$.path','doc-00000.md')", []).map_err(StorageError::persist_public)?;
        Ok::<_, StorageError>(())
    }).unwrap();
}

fn finish(store: &mut EngineStore, relay: &mut Relay) -> usize {
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    let mut reruns = 0;
    loop {
        match execute_relay_operation(
            store,
            &mut cache,
            transport.clone(),
            operation(),
            &LeaseRegistry::default(),
            &ClaimAnnouncer::default(),
            &mut crate::actor::live_application::Registry::default(),
        ) {
            Ok(RelayOperationOutcome::Sync(SyncPassOutcome::Complete { .. })) => break,
            Err(RuntimeError::Relay(RelayError::Local(reason))) if reason == RELAY_IO_PENDING => {
                let request = transport.take_pending().unwrap();
                if !matches!(request, RelayIoRequest::Pull(_)) {
                    reruns += 1;
                }
                let response = relay.answer(&request);
                transport.complete(request, Ok(response));
            }
            other => panic!("repair failed: {other:?}"),
        }
    }
    assert_eq!(remaining(store), 0);
    reruns
}

#[test]
fn base_repair_600_coordinates_need_at_most_three_repair_reruns() {
    let (_scratch, _path, mut store) = fixture(600);
    let mut relay = Relay::default();
    let reruns = finish(&mut store, &mut relay);
    assert_eq!(relay.lookups, 600);
    assert!(reruns <= 3, "600 coordinates caused {reruns} repair reruns");
}

#[tokio::test]
async fn base_repair_deadline_keeps_first_chunk_and_next_pull_finishes() {
    deadline_preserves_chunk(false).await;
}

#[tokio::test]
async fn base_repair_deferred_update_deadline_keeps_first_chunk() {
    deadline_preserves_chunk(true).await;
}

async fn deadline_preserves_chunk(deferred: bool) {
    let (_scratch, path, mut store) = fixture(600);
    if deferred {
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO ydoc_deferred_updates (workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq,recorded_at_ms)
                SELECT workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq,1000 FROM ydoc_base_relay_candidates", []).map_err(StorageError::persist_public)?;
            tx.execute("DELETE FROM ydoc_base_relay_candidates", []).map_err(StorageError::persist_public)?;
            tx.execute("UPDATE ydoc_docs SET base_relay_confirmed_absent=1", []).map_err(StorageError::persist_public)?;
            tx.execute("UPDATE replication_log SET payload_json=json_set(payload_json,'$.isBaseState',json('false'))", []).map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        }).unwrap();
    }
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1_100).unwrap().actor;
    let relay = Arc::new(Mutex::new(Relay {
        deferred,
        ..Relay::default()
    }));
    let io_relay = Arc::clone(&relay);
    let result = actor
        .relay_with_io(
            false,
            operation(),
            LeaseRegistry::default(),
            CancellationToken::new(),
            None,
            move |request, token| {
                let relay = Arc::clone(&io_relay);
                async move {
                    // Expire the operation at the next I/O boundary after 256 answers.
                    if relay.lock().unwrap().lookups >= 256 {
                        token.cancel();
                        std::future::pending::<Result<RelayIoResponse, RelayError>>().await
                    } else {
                        Ok(relay.lock().unwrap().answer(&request))
                    }
                }
            },
        )
        .await;
    assert!(matches!(result, Err(RuntimeError::Cancelled)));
    supervisor.close(&path).unwrap();
    let mut store = EngineStore::open(&path, 1_200).unwrap();
    assert_eq!(
        remaining(&store),
        344,
        "the first 256 repairs must survive the deadline"
    );
    let mut resumed = Relay {
        deferred,
        ..Relay::default()
    };
    finish(&mut store, &mut resumed);
    assert_eq!(
        resumed.lookups, 344,
        "committed repairs must not be looked up again"
    );
}

#[test]
fn base_repair_group_wider_than_a_batch_commits_whole_and_chooses_lowest_sequence() {
    let (_scratch, _path, mut store) = fixture(300);
    one_group(&mut store);
    let payload: serde_json::Value = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT payload_json FROM replication_log LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
        })
        .map(|json| serde_json::from_str(&json).unwrap())
        .unwrap();
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    let mut answered = 0;
    loop {
        match execute_relay_operation(
            &mut store,
            &mut cache,
            transport.clone(),
            operation(),
            &LeaseRegistry::default(),
            &ClaimAnnouncer::default(),
            &mut crate::actor::live_application::Registry::default(),
        ) {
            Ok(_) => break,
            Err(RuntimeError::Relay(RelayError::Local(reason))) if reason == RELAY_IO_PENDING => {
                let request = transport.take_pending().unwrap();
                let response = match &request {
                    RelayIoRequest::Pull(_) => Relay::default().answer(&request),
                    RelayIoRequest::LookupCoordinates(coordinates) => {
                        assert_eq!(
                            remaining(&store),
                            300,
                            "no candidate in a partial group may commit"
                        );
                        answered += coordinates.len();
                        RelayIoResponse::LookupCoordinates(
                            coordinates
                                .iter()
                                .map(|coordinate| {
                                    LogCoordinateResponse::Present(
                                        dohc_engine_sync::ReplicationEnvelope {
                                            workspace_id: "ws".into(),
                                            origin_id: coordinate.origin_id.clone(),
                                            origin_seq: coordinate.origin_seq,
                                            op_kind: "ydoc.update".into(),
                                            payload: payload.clone(),
                                            recorded_at_ms: 1_000,
                                            relay_seq: Some(300 - coordinate.origin_seq),
                                            settlement_admission: None,
                                            admitted_author_snapshot: None,
                                        },
                                    )
                                })
                                .collect(),
                        )
                    }
                    other => panic!("unexpected repair request: {other:?}"),
                };
                transport.complete(request, Ok(response));
            }
            other => panic!("repair failed: {other:?}"),
        }
    }
    assert_eq!(answered, 300);
    assert_eq!(remaining(&store), 0);
    let seq: Option<i64> = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT base_relay_seq FROM ydoc_docs WHERE object_id='doc-00000'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(seq, Some(1), "the minimum is in the second batch");
}

#[test]
fn base_repair_batch_reuses_answers_when_pending_groups_shift_boundaries() {
    let (_scratch, _path, mut store) = fixture(600);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE replication_log SET origin_id='local',imported=0 WHERE origin_seq=0",
                [],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "UPDATE ydoc_base_relay_candidates SET origin_id='local' WHERE origin_seq=0",
                [],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    let mut relay = Relay::default();
    let mut probes = 0;
    loop {
        match execute_relay_operation(
            &mut store,
            &mut cache,
            transport.clone(),
            operation(),
            &LeaseRegistry::default(),
            &ClaimAnnouncer::default(),
            &mut crate::actor::live_application::Registry::default(),
        ) {
            Ok(_) => break,
            Err(RuntimeError::Relay(RelayError::Local(reason))) if reason == RELAY_IO_PENDING => {
                let request = transport.take_pending().unwrap();
                let response = if let RelayIoRequest::Push(push) = &request {
                    assert!(push.ops.is_empty());
                    probes += 1;
                    RelayIoResponse::Push(PushResponse {
                        accepted: 0,
                        inserted: 0,
                        skipped: 0,
                        current_max_origin_seq: -1,
                        settlement_refusals: Vec::new(),
                        hosted_refusals: Vec::new(),
                        redundant_recoveries: Vec::new(),
                    })
                } else {
                    relay.answer(&request)
                };
                transport.complete(request, Ok(response));
            }
            other => panic!("repair failed: {other:?}"),
        }
    }
    assert_eq!(remaining(&store), 1);
    assert_eq!(
        relay.lookups, 599,
        "each foreign coordinate must be fetched once"
    );
    assert_eq!(probes, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn base_repair_lookup_batch_has_at_most_eight_in_flight_and_preserves_order() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let requests = (0..32)
        .map(|seq| LogCoordinateRequest {
            workspace_id: "ws".into(),
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            origin_id: "peer".into(),
            origin_seq: seq,
        })
        .collect();
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let workers_gate = Arc::clone(&gate);
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let worker_active = Arc::clone(&active);
    let worker_peak = Arc::clone(&peak);
    let task = tokio::spawn(execute_coordinate_lookup_batch(
        requests,
        CancellationToken::new(),
        move |request, _worker_token| {
            let in_flight = worker_active.fetch_add(1, Ordering::SeqCst) + 1;
            worker_peak.fetch_max(in_flight, Ordering::SeqCst);
            assert!(in_flight <= 8);
            started_tx.send(request.origin_seq).unwrap();
            let (lock, wake) = &*workers_gate;
            let released = lock.lock().unwrap();
            drop(wake.wait_while(released, |released| !*released).unwrap());
            worker_active.fetch_sub(1, Ordering::SeqCst);
            Ok(LogCoordinateResponse::Present(
                dohc_engine_sync::ReplicationEnvelope {
                    workspace_id: request.workspace_id,
                    origin_id: request.origin_id,
                    origin_seq: request.origin_seq,
                    op_kind: "ydoc.update".into(),
                    payload: serde_json::json!({}),
                    recorded_at_ms: 1,
                    relay_seq: Some(request.origin_seq + 1),
                    settlement_admission: None,
                    admitted_author_snapshot: None,
                },
            ))
        },
    ));
    tokio::task::spawn_blocking(move || {
        for _ in 0..8 {
            started_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
        }
        assert!(
            started_rx.try_recv().is_err(),
            "a ninth lookup started before a slot was free"
        );
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        // Keep the receiver alive until the workers finish sending their start events.
        for _ in 8..32 {
            started_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
        }
    })
    .await
    .unwrap();
    let results = task.await.unwrap().unwrap();
    assert_eq!(peak.load(Ordering::SeqCst), 8);
    assert_eq!(active.load(Ordering::SeqCst), 0);
    for (index, result) in results.into_iter().enumerate() {
        let LogCoordinateResponse::Present(op) = result else {
            panic!("missing response");
        };
        assert_eq!(op.origin_seq, index as i64);
    }
}

#[test]
#[ignore = "manual base repair benchmark; run alone with --ignored --nocapture"]
fn base_repair_deferred_benchmark() {
    for coordinates in [50, 500, 2_000] {
        let mut samples = Vec::new();
        let mut reruns = Vec::new();
        let mut requests = Vec::new();
        for sample in 0..=5 {
            let (_scratch, _path, mut store) = fixture(coordinates);
            let mut relay = Relay::default();
            let start = std::time::Instant::now();
            let passes = finish(&mut store, &mut relay);
            let elapsed = start.elapsed().as_micros();
            assert_eq!(relay.lookups, coordinates);
            if sample > 0 {
                samples.push(elapsed);
                reruns.push(passes);
                requests.push(relay.pulls + relay.lookups);
            }
        }
        let mut sorted = samples.clone();
        sorted.sort_unstable();
        println!(
            "{}",
            serde_json::json!({"benchmark":"base_repair_deferred", "coordinates":coordinates,
            "samples_us":samples, "median_us":sorted[2], "repair_reruns":reruns, "relay_requests":requests,
            "transport":"deferred bridge with immediate in-process Absent replies; empty pull page", "build":"debug"})
        );
    }
}

fn lookup_requests(count: i64) -> Vec<LogCoordinateRequest> {
    (0..count)
        .map(|origin_seq| LogCoordinateRequest {
            workspace_id: "ws".into(),
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            origin_id: "peer".into(),
            origin_seq,
        })
        .collect()
}

#[test]
#[ignore = "manual HTTP coordinate benchmark; run alone with --ignored --nocapture"]
fn base_repair_coordinate_http_batch_benchmark() {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    for coordinates in [50_usize, 500, 2_000] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..coordinates * 6 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut bytes = [0; 4096];
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let read = stream.read(&mut bytes).unwrap();
                    assert_ne!(read, 0);
                    request.extend_from_slice(&bytes[..read]);
                }
                let body = r#"{"status":"absent"}"#;
                write!(stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
                stream.flush().unwrap();
            }
        });
        let transport = Arc::new(
            HttpRelayTransport::new_insecure_loopback_for_tests(
                format!("http://{address}"),
                "token",
            )
            .unwrap(),
        );
        let requests = lookup_requests(coordinates as i64);
        let mut samples = Vec::new();
        for sample in 0..=5 {
            let started = std::time::Instant::now();
            for chunk in requests.chunks(MAX_BASE_REPAIR_LOOKUPS) {
                let result = runtime
                    .block_on(execute_http_request(
                        Arc::clone(&transport),
                        RelayIoRequest::LookupCoordinates(chunk.to_vec()),
                        CancellationToken::new(),
                    ))
                    .unwrap();
                assert!(matches!(result, RelayIoResponse::LookupCoordinates(replies)
                    if replies == vec![LogCoordinateResponse::Absent; chunk.len()]));
            }
            if sample > 0 {
                samples.push(started.elapsed().as_micros());
            }
        }
        server.join().unwrap();
        let mut sorted = samples.clone();
        sorted.sort_unstable();
        println!(
            "{}",
            serde_json::json!({"benchmark":"base_repair_coordinate_http", "coordinates":coordinates,
                "samples_us":samples, "median_us":sorted[2], "lookup_rounds":coordinates.div_ceil(MAX_BASE_REPAIR_LOOKUPS),
                "relay_requests":coordinates, "transport":"immediate loopback HTTP Absent replies; no pull/store", "build":"debug"})
        );
    }
}

#[test]
fn base_repair_single_missing_coordinate_uses_the_batch_path() {
    let transport = DeferredRelayTransport::default();
    let requests = lookup_requests(1);
    assert!(transport.lookup_log_coordinates(requests.clone()).is_err());
    let pending = transport.take_pending().unwrap();
    assert!(matches!(&pending, RelayIoRequest::LookupCoordinates(batch) if batch == &requests));
    transport.complete(
        pending,
        Ok(RelayIoResponse::LookupCoordinates(vec![
            LogCoordinateResponse::Absent,
        ])),
    );
    assert_eq!(
        transport
            .lookup_log_coordinate(requests[0].clone())
            .unwrap(),
        LogCoordinateResponse::Absent
    );
    assert!(transport.take_pending().is_none());
}

#[test]
fn base_repair_cancelled_lookup_batch_stops_workers_and_returns_promptly() {
    stalled_lookup_batch(false);
}

#[test]
fn base_repair_first_lookup_error_stops_other_workers_and_returns_promptly() {
    stalled_lookup_batch(true);
}

fn stalled_lookup_batch(first_error: bool) {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::{Duration, Instant};

    static STALLED_BATCH: Mutex<()> = Mutex::new(());
    let _stalled_batch = STALLED_BATCH
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let gate = Arc::new((Mutex::new((false, false)), std::sync::Condvar::new()));
    let server_gate = Arc::clone(&gate);
    let (received_tx, received_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let mut handlers = Vec::new();
        let mut coordinates = Vec::new();
        loop {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut request = Vec::new();
            let mut bytes = [0; 4096];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let read = stream.read(&mut bytes).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&bytes[..read]);
            }
            // An empty connection ends the server after the request runtime stops.
            if request.is_empty() {
                break;
            }
            let request = String::from_utf8(request).unwrap();
            let path = request.split_whitespace().nth(1).unwrap();
            let coordinate: i64 = path
                .split('?')
                .next()
                .unwrap()
                .rsplit('/')
                .next()
                .unwrap()
                .parse()
                .unwrap();
            let first = coordinates.is_empty();
            coordinates.push(coordinate);
            received_tx.send(()).unwrap();
            let gate = Arc::clone(&server_gate);
            handlers.push(std::thread::spawn(move || {
                let (lock, wake) = &*gate;
                let state = lock.lock().unwrap();
                drop(wake.wait_while(state, |state| {
                    !(state.0 || first_error && first && state.1)
                }).unwrap());
                let status = if first_error && first { 400 } else { 200 };
                let body = if first_error && first {
                    r#"{"code":"bad_request"}"#
                } else {
                    r#"{"status":"absent"}"#
                };
                let _ = write!(stream,
                    "HTTP/1.1 {status} Answer\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                let _ = stream.flush();
            }));
        }
        for handler in handlers {
            handler.join().unwrap();
        }
        coordinates
    });
    let transport = Arc::new(
        HttpRelayTransport::new_insecure_loopback_for_tests(format!("http://{address}"), "token")
            .unwrap(),
    );
    let token = CancellationToken::new();
    let operation_token = token.clone();
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let operation = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(execute_http_request(
            transport,
            RelayIoRequest::LookupCoordinates(lookup_requests(32)),
            operation_token,
        ));
        // Dropping the runtime also waits for its blocking lookup workers.
        drop(runtime);
        finished_tx.send(result).unwrap();
    });
    for _ in 0..8 {
        received_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    }
    let started = Instant::now();
    if first_error {
        gate.0.lock().unwrap().1 = true;
        gate.1.notify_all();
    } else {
        token.cancel();
    }
    let before_release = finished_rx.recv_timeout(Duration::from_secs(1));
    let shutdown_us = started.elapsed().as_micros();
    // Always release the server before asserting, including against the broken base.
    gate.0.lock().unwrap().0 = true;
    gate.1.notify_all();
    operation.join().unwrap();
    drop(TcpStream::connect(address).unwrap());
    let coordinates = server.join().unwrap();
    assert!(coordinates.iter().all(|coordinate| *coordinate < 8));
    assert_eq!(
        coordinates.len(),
        8,
        "no next wave may issue after stopping"
    );
    let result =
        before_release.expect("lookup workers must stop before stalled headers are released");
    if first_error {
        assert!(matches!(result, Err(RelayError::BadRequest)));
        assert!(
            !token.is_cancelled(),
            "batch failure must not cancel its parent"
        );
    } else {
        assert!(matches!(result, Err(RelayError::Local(reason)) if reason == RELAY_IO_CANCELLED));
    }
    println!(
        "lookup batch first_error={first_error} shutdown_us={shutdown_us} requests={}",
        coordinates.len()
    );
}

#[test]
fn passive_store_base_repair_never_posts_a_confirmation() {
    let (_scratch, _path, mut store) = fixture_with_mode(1, true);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE sync_identity SET origin_id='peer' WHERE workspace_id='ws'",
                [],
            )
            .map_err(StorageError::persist_public)
        })
        .unwrap();
    let mut cache = WriterDocCache::new();
    let transport = DeferredRelayTransport::default();
    let mut relay = Relay::default();
    for _ in 0..8 {
        match execute_relay_operation(
            &mut store,
            &mut cache,
            transport.clone(),
            operation(),
            &LeaseRegistry::default(),
            &ClaimAnnouncer::default(),
            &mut crate::actor::live_application::Registry::default(),
        ) {
            Ok(RelayOperationOutcome::Sync(SyncPassOutcome::Complete { .. })) => {
                assert_eq!(remaining(&store), 0);
                assert_eq!(relay.lookups, 1);
                return;
            }
            Err(RuntimeError::Relay(RelayError::Local(reason))) if reason == RELAY_IO_PENDING => {
                let request = transport.take_pending().unwrap();
                let response = relay.answer(&request);
                transport.complete(request, Ok(response));
            }
            other => panic!("{other:?}"),
        }
    }
    panic!("base repair did not finish");
}
