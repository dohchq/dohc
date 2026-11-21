use super::*;
use crate::WorkspaceSupervisor;
use dohc_engine_storage::hex_sha256;
use dohc_engine_sync::MAX_SHARE_BLOB_BATCH;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::Condvar;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const NOTE_PATH: &str = "notes/note.md";
const SAVED_VERSIONS: usize = 25;
const ROUND_TRIP: Duration = Duration::from_millis(270);
const TCP_AND_TLS_HANDSHAKE: Duration = Duration::from_millis(540);

#[derive(Clone, Copy)]
enum Pace {
    HoldEachBlobUntilItsWholeBatchIsAsked,
    Delayed {
        new_connection: Duration,
        round_trip: Duration,
    },
}

#[derive(Default)]
struct Served {
    connections: usize,
    blob_requests: usize,
    blobs_in_flight: usize,
    most_blobs_in_flight: usize,
    batch_never_overlapped: bool,
}

struct ShareRelay {
    address: SocketAddr,
    served: Arc<(Mutex<Served>, Condvar)>,
    stop: Arc<AtomicBool>,
    accept: Option<std::thread::JoinHandle<()>>,
}

fn saved_version(index: usize) -> Vec<u8> {
    format!("# Note\n\nSaved version {index}.\n").into_bytes()
}

fn share_log_page() -> String {
    let ops = (0..SAVED_VERSIONS)
        .map(|index| {
            serde_json::json!({
                "relaySeq": index + 1,
                "originId": "granter",
                "originSeq": index,
                "opKind": "moment.append",
                "recordedAtMs": 1_000 + index,
                "payload": {
                    "versionId": "main",
                    "operation": "write",
                    "path": NOTE_PATH,
                    "payloadAfterPath": NOTE_PATH,
                    "payloadAfterBlobSha256": hex_sha256(&saved_version(index)),
                    "payloadAfterContentKind": "text",
                },
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({ "ops": ops, "nextCursor": SAVED_VERSIONS, "hasMore": false }).to_string()
}

fn read_request_path(stream: &mut TcpStream) -> Option<String> {
    let mut request = Vec::new();
    let mut bytes = [0; 4096];
    while !request.windows(4).any(|part| part == b"\r\n\r\n") {
        let read = stream.read(&mut bytes).ok()?;
        if read == 0 {
            return None;
        }
        request.extend_from_slice(&bytes[..read]);
    }
    let request = String::from_utf8(request).ok()?;
    request.split_whitespace().nth(1).map(str::to_owned)
}

fn answer_blob(served: &(Mutex<Served>, Condvar), pace: Pace, sha256: &str) -> Vec<u8> {
    let index = (0..SAVED_VERSIONS)
        .find(|index| hex_sha256(&saved_version(*index)) == sha256)
        .expect("a blob of the shared note");
    let (lock, wake) = served;
    let mut state = lock.lock().unwrap();
    state.blob_requests += 1;
    state.blobs_in_flight += 1;
    state.most_blobs_in_flight = state.most_blobs_in_flight.max(state.blobs_in_flight);
    wake.notify_all();
    match pace {
        Pace::HoldEachBlobUntilItsWholeBatchIsAsked => {
            let batch_end =
                ((index / MAX_SHARE_BLOB_BATCH + 1) * MAX_SHARE_BLOB_BATCH).min(SAVED_VERSIONS);
            let (waited, timeout) = wake
                .wait_timeout_while(state, Duration::from_secs(10), |state| {
                    !state.batch_never_overlapped && state.blob_requests < batch_end
                })
                .unwrap();
            state = waited;
            if timeout.timed_out() {
                state.batch_never_overlapped = true;
                wake.notify_all();
            }
        }
        Pace::Delayed { round_trip, .. } => {
            drop(state);
            std::thread::sleep(round_trip);
            state = lock.lock().unwrap();
        }
    }
    state.blobs_in_flight -= 1;
    saved_version(index)
}

fn serve_connection(mut stream: TcpStream, served: &(Mutex<Served>, Condvar), pace: Pace) {
    if let Pace::Delayed { new_connection, .. } = pace {
        std::thread::sleep(new_connection);
    }
    while let Some(path) = read_request_path(&mut stream) {
        let (content_type, body) = match path.split_once("/blobs/") {
            Some((_, sha256)) => (
                "application/octet-stream",
                answer_blob(served, pace, sha256),
            ),
            None => {
                if let Pace::Delayed { round_trip, .. } = pace {
                    std::thread::sleep(round_trip);
                }
                let page = if path.contains("since=0&") {
                    share_log_page()
                } else {
                    serde_json::json!({
                        "ops": [], "nextCursor": SAVED_VERSIONS, "hasMore": false
                    })
                    .to_string()
                };
                ("application/json", page.into_bytes())
            }
        };
        let head = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\n\r\n",
            body.len()
        );
        if stream.write_all(head.as_bytes()).is_err() || stream.write_all(&body).is_err() {
            return;
        }
    }
}

impl ShareRelay {
    fn start(pace: Pace) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let served = Arc::new((Mutex::new(Served::default()), Condvar::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (accept_served, accept_stop) = (Arc::clone(&served), Arc::clone(&stop));
        let accept = std::thread::spawn(move || {
            let mut connections = Vec::new();
            loop {
                let (stream, _) = listener.accept().unwrap();
                if accept_stop.load(Ordering::SeqCst) {
                    break;
                }
                accept_served.0.lock().unwrap().connections += 1;
                let served = Arc::clone(&accept_served);
                connections.push(std::thread::spawn(move || {
                    serve_connection(stream, &served, pace);
                }));
            }
            for connection in connections {
                connection.join().unwrap();
            }
        });
        Self {
            address,
            served,
            stop,
            accept: Some(accept),
        }
    }

    fn configuration(&self) -> RelayConfiguration {
        RelayConfiguration {
            base_url: format!("http://{}", self.address),
            socket_path: None,
            bearer_token: "token".to_owned(),
            allow_insecure_loopback_for_tests: true,
        }
    }

    fn finish(mut self) -> Served {
        self.stop.store(true, Ordering::SeqCst);
        drop(TcpStream::connect(self.address).unwrap());
        self.accept.take().unwrap().join().unwrap();
        std::mem::take(&mut *self.served.0.lock().unwrap())
    }
}

struct AddedNote {
    outcome: ShareViewPullOutcome,
    text: Option<String>,
    pull: Duration,
}

async fn add_the_shared_note(relay: &ShareRelay) -> AddedNote {
    let scratch = ScratchDir::new().unwrap();
    let path = engine_db_path(&scratch).unwrap();
    let mut store = EngineStore::open(&path, 1_000).unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .unwrap();
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1_100).unwrap().actor;
    let started = Instant::now();
    let pulled = actor
        .relay(
            relay.configuration(),
            RelayOperation::PullShareView {
                workspace_id: "ws".to_owned(),
                share_id: "share".to_owned(),
                granted: dohc_engine_sync::ShareGrant {
                    paths: vec!["notes".to_owned()],
                    version_id: None,
                    access: dohc_engine_sync::ShareAccess::View,
                },
            },
            LeaseRegistry::default(),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
    let pull = started.elapsed();
    let RelayOperationOutcome::ShareViewPulled(outcome) = pulled else {
        panic!("a share view pull answers with its outcome");
    };
    drop(actor);
    supervisor.close(&path).unwrap();
    let mut store = EngineStore::open(&path, 1_200).unwrap();
    let text = dohc_engine_domain::VersionedTextStore::new(&mut store)
        .read_text("ws", "main", NOTE_PATH)
        .unwrap()
        .map(|snapshot| snapshot.text);
    AddedNote {
        outcome,
        text,
        pull,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_share_pull_downloads_each_batch_of_a_notes_saved_versions_together() {
    let relay = ShareRelay::start(Pace::HoldEachBlobUntilItsWholeBatchIsAsked);

    let added = add_the_shared_note(&relay).await;

    let served = relay.finish();
    assert_eq!(added.outcome.fetched, SAVED_VERSIONS);
    assert_eq!(
        added
            .outcome
            .changed_paths
            .iter()
            .map(|changed| changed.path.as_str())
            .collect::<Vec<_>>(),
        [NOTE_PATH]
    );
    assert_eq!(
        added.text.map(String::into_bytes),
        Some(saved_version(SAVED_VERSIONS - 1)),
        "the note ends at its last saved version"
    );
    assert_eq!(served.blob_requests, SAVED_VERSIONS);
    assert!(
        !served.batch_never_overlapped,
        "the blobs of one batch were not all asked for before the first was answered"
    );
    assert_eq!(served.most_blobs_in_flight, MAX_SHARE_BLOB_BATCH);
    assert_eq!(
        served.connections, MAX_SHARE_BLOB_BATCH,
        "a later batch opened new connections instead of reusing the first batch's"
    );
}

#[test]
#[ignore = "manual share add benchmark; run alone with --ignored --nocapture"]
fn share_pull_of_a_note_saved_25_times_benchmark() {
    let pace = Pace::Delayed {
        new_connection: TCP_AND_TLS_HANDSHAKE,
        round_trip: ROUND_TRIP,
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    for _ in 0..3 {
        let relay = ShareRelay::start(pace);
        let added = runtime.block_on(add_the_shared_note(&relay));
        let served = relay.finish();
        println!(
            "{}",
            serde_json::json!({
                "benchmark": "share_pull_of_a_note_saved_25_times",
                "round_trip_ms": ROUND_TRIP.as_millis(),
                "new_connection_ms": TCP_AND_TLS_HANDSHAKE.as_millis(),
                "fetched": added.outcome.fetched,
                "blob_requests": served.blob_requests,
                "most_blobs_in_flight": served.most_blobs_in_flight,
                "connections": served.connections,
                "pull_ms": added.pull.as_millis(),
            })
        );
    }
    for at_a_time in [1, 2, 4, 8] {
        let relay = ShareRelay::start(pace);
        let transport = HttpRelayTransport::new_insecure_loopback_for_tests(
            format!("http://{}", relay.address),
            "token",
        )
        .unwrap();
        let blob = |index: usize| ShareBlobRequest {
            share_id: "share".to_owned(),
            sha256: hex_sha256(&saved_version(index)),
        };
        transport.share_blob(blob(0)).unwrap();
        let started = Instant::now();
        for together in (0..SAVED_VERSIONS).collect::<Vec<_>>().chunks(at_a_time) {
            let results = transport
                .share_blobs(together.iter().copied().map(blob).collect())
                .unwrap();
            assert!(results.iter().all(Result::is_ok));
        }
        let elapsed_ms = started.elapsed().as_millis();
        drop(transport);
        let served = relay.finish();
        println!(
            "{}",
            serde_json::json!({
                "benchmark": "share_blob_downloads_at_a_time",
                "at_a_time": at_a_time,
                "blob_requests": served.blob_requests - 1,
                "connections": served.connections,
                "elapsed_ms": elapsed_ms,
            })
        );
    }
}
