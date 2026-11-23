use super::*;
use crate::WorkspaceSupervisor;
use dohc_engine_storage::hex_sha256;
use dohc_engine_sync::MAX_SHARE_BLOB_BATCH;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::Condvar;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const NOTE_PATH: &str = "notes/note.md";
const SAVED_VERSIONS: usize = 25;
const ROWS_IN_A_LOG_PAGE: usize = 10_000;
const ROUND_TRIP: Duration = Duration::from_millis(270);
const TCP_AND_TLS_HANDSHAKE: Duration = Duration::from_millis(540);
const PHOTO_PATH: &str = "notes/photo.bin";
const PHOTO_VERSIONS: usize = 8;
const PHOTO_BYTES: usize = 3 * 512 * 1024;
const SLOW_LINK_BYTES_PER_ATTEMPT: usize = 9 * 1024 * 1024;
const SLOW_LINK_CHUNK_BYTES: usize = 64 * 1024;
const SLOW_LINK_CHUNK_TIME: Duration = Duration::from_millis(8);

#[derive(Clone, Copy)]
enum Pace {
    HoldEachBlobUntilItsWholeBatchIsAsked,
    Delayed {
        new_connection: Duration,
        round_trip: Duration,
    },
}

#[derive(Clone, Copy)]
struct SharedNote {
    versions: usize,
    empty_log_pages_before_it: usize,
}

const NOTE_SAVED_25_TIMES: SharedNote = SharedNote {
    versions: SAVED_VERSIONS,
    empty_log_pages_before_it: 0,
};

const NOTE_BEHIND_4_EMPTY_LOG_PAGES: SharedNote = SharedNote {
    versions: 1,
    empty_log_pages_before_it: 4,
};

#[derive(Default)]
struct Served {
    connections: usize,
    log_requests: usize,
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

fn share_log_page(note: SharedNote, since: usize) -> String {
    let first = note.empty_log_pages_before_it * ROWS_IN_A_LOG_PAGE;
    if since < first {
        let next = (since / ROWS_IN_A_LOG_PAGE + 1) * ROWS_IN_A_LOG_PAGE;
        return serde_json::json!({ "ops": [], "nextCursor": next, "hasMore": true }).to_string();
    }
    let versions = if since == first { note.versions } else { 0 };
    let ops = (0..versions)
        .map(|index| {
            serde_json::json!({
                "relaySeq": first + index + 1,
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
    serde_json::json!({ "ops": ops, "nextCursor": first + note.versions, "hasMore": false })
        .to_string()
}

fn since(path: &str) -> usize {
    path.split_once("since=")
        .and_then(|(_, rest)| rest.split('&').next())
        .and_then(|since| since.parse().ok())
        .expect("a share log request names its cursor")
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

fn answer_blob(
    served: &(Mutex<Served>, Condvar),
    pace: Pace,
    note: SharedNote,
    sha256: &str,
) -> Vec<u8> {
    let index = (0..note.versions)
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
            let batch_end = if index == 0 {
                1
            } else {
                ((index / MAX_SHARE_BLOB_BATCH + 1) * MAX_SHARE_BLOB_BATCH).min(note.versions)
            };
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

fn serve_connection(
    mut stream: TcpStream,
    served: &(Mutex<Served>, Condvar),
    pace: Pace,
    note: SharedNote,
) {
    if let Pace::Delayed { new_connection, .. } = pace {
        std::thread::sleep(new_connection);
    }
    while let Some(path) = read_request_path(&mut stream) {
        let (content_type, body) = match path.split_once("/blobs/") {
            Some((_, sha256)) => (
                "application/octet-stream",
                answer_blob(served, pace, note, sha256),
            ),
            None => {
                if let Pace::Delayed { round_trip, .. } = pace {
                    std::thread::sleep(round_trip);
                }
                served.0.lock().unwrap().log_requests += 1;
                let page = share_log_page(note, since(&path));
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
    fn start(pace: Pace, note: SharedNote) -> Self {
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
                    serve_connection(stream, &served, pace, note);
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

struct Photo {
    sha256: String,
    bytes: Vec<u8>,
}

fn photos_of(sizes: impl IntoIterator<Item = usize>) -> Vec<Photo> {
    sizes
        .into_iter()
        .enumerate()
        .map(|(index, size)| {
            let bytes = vec![u8::try_from(index).unwrap(); size];
            Photo {
                sha256: hex_sha256(&bytes),
                bytes,
            }
        })
        .collect()
}

fn a_photo_over_the_ceiling_then_a_small_one_then_large_ones() -> Vec<Photo> {
    let (_, ceiling) = dohc_engine_sync::blob_ceiling(dohc_engine_sync::BlobKind::Binary);
    photos_of([ceiling + 1, 1024].into_iter().chain([PHOTO_BYTES; 6]))
}

fn photo_log_page(photos: &[Photo], since: usize) -> String {
    if since < ROWS_IN_A_LOG_PAGE {
        return serde_json::json!({
            "ops": [], "nextCursor": ROWS_IN_A_LOG_PAGE, "hasMore": true
        })
        .to_string();
    }
    let served = if since == ROWS_IN_A_LOG_PAGE {
        photos
    } else {
        &[]
    };
    let ops = served
        .iter()
        .enumerate()
        .map(|(index, photo)| {
            serde_json::json!({
                "relaySeq": ROWS_IN_A_LOG_PAGE + index + 1,
                "originId": "granter",
                "originSeq": index,
                "opKind": "moment.append",
                "recordedAtMs": 1_000 + index,
                "payload": {
                    "versionId": "main",
                    "operation": "write",
                    "path": PHOTO_PATH,
                    "payloadAfterPath": PHOTO_PATH,
                    "payloadAfterBlobSha256": photo.sha256,
                    "payloadAfterContentKind": "binary",
                },
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "ops": ops, "nextCursor": ROWS_IN_A_LOG_PAGE + photos.len(), "hasMore": false
    })
    .to_string()
}

#[derive(Default)]
struct SlowLink {
    attempt: u64,
    bytes_left: usize,
    spent: bool,
    writers: u64,
    writers_waiting: VecDeque<u64>,
    photos_asked_for: Vec<usize>,
}

struct SlowLinkRelay {
    address: SocketAddr,
    photos: Arc<Vec<Photo>>,
    link: Arc<(Mutex<SlowLink>, Condvar)>,
    stop: Arc<AtomicBool>,
    accept: Option<std::thread::JoinHandle<()>>,
}

fn send_over_slow_link(
    stream: &mut TcpStream,
    body: &[u8],
    link: &(Mutex<SlowLink>, Condvar),
    spent: &tokio::sync::mpsc::UnboundedSender<()>,
) -> bool {
    let (lock, wake) = link;
    let attempt = lock.lock().unwrap().attempt;
    for chunk in body.chunks(SLOW_LINK_CHUNK_BYTES) {
        let mut state = lock.lock().unwrap();
        let writer = state.writers;
        state.writers += 1;
        state.writers_waiting.push_back(writer);
        loop {
            if state.attempt != attempt {
                return false;
            }
            if state.writers_waiting.front() == Some(&writer) {
                if state.bytes_left >= chunk.len() {
                    break;
                }
                if !state.spent {
                    state.spent = true;
                    let _ = spent.send(());
                }
            }
            state = wake.wait(state).unwrap();
        }
        state.writers_waiting.pop_front();
        state.bytes_left -= chunk.len();
        std::thread::sleep(SLOW_LINK_CHUNK_TIME);
        wake.notify_all();
        drop(state);
        if stream.write_all(chunk).is_err() {
            return false;
        }
    }
    true
}

fn serve_over_slow_link(
    mut stream: TcpStream,
    photos: &[Photo],
    link: &(Mutex<SlowLink>, Condvar),
    spent: &tokio::sync::mpsc::UnboundedSender<()>,
) {
    while let Some(path) = read_request_path(&mut stream) {
        let photo = path.split_once("/blobs/").map(|(_, sha256)| {
            let asked = photos
                .iter()
                .position(|photo| photo.sha256 == sha256)
                .expect("a version of the shared photo");
            link.0.lock().unwrap().photos_asked_for.push(asked);
            &photos[asked]
        });
        let page = if photo.is_some() {
            String::new()
        } else {
            photo_log_page(photos, since(&path))
        };
        let length = photo.map_or(page.len(), |photo| photo.bytes.len());
        let head = format!("HTTP/1.1 200 OK\r\ncontent-length: {length}\r\n\r\n");
        if stream.write_all(head.as_bytes()).is_err() {
            return;
        }
        let sent = match photo {
            Some(photo) => send_over_slow_link(&mut stream, &photo.bytes, link, spent),
            None => stream.write_all(page.as_bytes()).is_ok(),
        };
        if !sent {
            return;
        }
    }
}

impl SlowLinkRelay {
    fn start(photos: Vec<Photo>) -> (Self, tokio::sync::mpsc::UnboundedReceiver<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let link = Arc::new((Mutex::new(SlowLink::default()), Condvar::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let photos = Arc::new(photos);
        let (spent, link_spent) = tokio::sync::mpsc::unbounded_channel();
        let (accept_link, accept_stop) = (Arc::clone(&link), Arc::clone(&stop));
        let accept_photos = Arc::clone(&photos);
        let accept = std::thread::spawn(move || {
            let mut connections = Vec::new();
            loop {
                let (stream, _) = listener.accept().unwrap();
                if accept_stop.load(Ordering::SeqCst) {
                    break;
                }
                let (link, spent) = (Arc::clone(&accept_link), spent.clone());
                let photos = Arc::clone(&accept_photos);
                connections.push(std::thread::spawn(move || {
                    serve_over_slow_link(stream, &photos, &link, &spent);
                }));
            }
            for connection in connections {
                connection.join().unwrap();
            }
        });
        (
            Self {
                address,
                photos,
                link,
                stop,
                accept: Some(accept),
            },
            link_spent,
        )
    }

    fn start_attempt(&self, bytes: usize) {
        let (lock, wake) = &*self.link;
        let mut state = lock.lock().unwrap();
        state.attempt += 1;
        state.bytes_left = bytes;
        state.spent = false;
        state.writers_waiting.clear();
        wake.notify_all();
    }

    fn times_asked_for(&self, photo: usize) -> usize {
        let asked = &self.link.0.lock().unwrap().photos_asked_for;
        asked.iter().filter(|asked| **asked == photo).count()
    }

    async fn pull_and_commit_until_no_more(
        &self,
        actor: &ActorHandle,
        deadline: &CancellationToken,
    ) -> Result<RelayOperationOutcome, RuntimeError> {
        let relay = || RelayConfiguration {
            base_url: format!("http://{}", self.address),
            socket_path: None,
            bearer_token: "token".to_owned(),
            allow_insecure_loopback_for_tests: true,
        };
        loop {
            let pulled = actor
                .relay(
                    relay(),
                    pull_the_share(),
                    LeaseRegistry::default(),
                    deadline.clone(),
                    None,
                )
                .await?;
            let cursor = match &pulled {
                RelayOperationOutcome::ShareViewPulled(outcome) if outcome.has_more => {
                    outcome.pending_cursor.clone()
                }
                _ => return Ok(pulled),
            };
            actor
                .relay(
                    relay(),
                    RelayOperation::CommitShareViewCursor {
                        workspace_id: "ws".to_owned(),
                        cursor,
                    },
                    LeaseRegistry::default(),
                    deadline.clone(),
                    None,
                )
                .await?;
        }
    }

    async fn pull_until_the_link_is_spent(
        &self,
        actor: &ActorHandle,
        link_spent: &mut tokio::sync::mpsc::UnboundedReceiver<()>,
        bytes: usize,
    ) -> (Vec<bool>, Result<RelayOperationOutcome, RuntimeError>) {
        self.start_attempt(bytes);
        while link_spent.try_recv().is_ok() {}
        let deadline = CancellationToken::new();
        let pull = self.pull_and_commit_until_no_more(actor, &deadline);
        tokio::pin!(pull);
        let pulled = tokio::select! {
            pulled = &mut pull => pulled,
            _ = link_spent.recv() => {
                deadline.cancel();
                pull.await
            }
        };
        let photos = Arc::clone(&self.photos);
        let stored = actor
            .run(move |store, _| {
                Ok(photos
                    .iter()
                    .map(|photo| store.has_binary_blob(&photo.sha256).unwrap())
                    .collect())
            })
            .await
            .unwrap();
        (stored, pulled)
    }

    fn finish(mut self) {
        self.start_attempt(0);
        self.stop.store(true, Ordering::SeqCst);
        drop(TcpStream::connect(self.address).unwrap());
        self.accept.take().unwrap().join().unwrap();
    }
}

struct AddedNote {
    outcome: ShareViewPullOutcome,
    text: Option<String>,
    pull: Duration,
    pulls: usize,
}

fn receiving_workspace() -> (ScratchDir, std::path::PathBuf) {
    let scratch = ScratchDir::new().unwrap();
    let path = engine_db_path(&scratch).unwrap();
    let mut store = EngineStore::open(&path, 1_000).unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .unwrap();
    (scratch, path)
}

fn pull_the_share() -> RelayOperation {
    RelayOperation::PullShareView {
        workspace_id: "ws".to_owned(),
        share_id: "share".to_owned(),
        granted: dohc_engine_sync::ShareGrant {
            scope: dohc_engine_sync::ShareScope::Paths(vec!["notes".to_owned()]),
            version_id: None,
            access: dohc_engine_sync::ShareAccess::View,
        },
    }
}

async fn add_the_shared_note(relay: &ShareRelay) -> AddedNote {
    let (_scratch, path) = receiving_workspace();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1_100).unwrap().actor;
    let started = Instant::now();
    let mut pulls = 0;
    let outcome = loop {
        let pulled = actor
            .relay(
                relay.configuration(),
                pull_the_share(),
                LeaseRegistry::default(),
                CancellationToken::new(),
                None,
            )
            .await
            .unwrap();
        pulls += 1;
        let RelayOperationOutcome::ShareViewPulled(outcome) = pulled else {
            panic!("a share view pull answers with its outcome");
        };
        if !outcome.has_more {
            break outcome;
        }
        actor
            .relay(
                relay.configuration(),
                RelayOperation::CommitShareViewCursor {
                    workspace_id: "ws".to_owned(),
                    cursor: outcome.pending_cursor.clone(),
                },
                LeaseRegistry::default(),
                CancellationToken::new(),
                None,
            )
            .await
            .unwrap();
    };
    let pull = started.elapsed();
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
        pulls,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_share_pull_downloads_each_batch_of_a_notes_saved_versions_together() {
    let relay = ShareRelay::start(
        Pace::HoldEachBlobUntilItsWholeBatchIsAsked,
        NOTE_SAVED_25_TIMES,
    );

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_share_pull_reads_past_empty_log_pages_in_one_call_and_applies_the_note_in_the_next() {
    let relay = ShareRelay::start(
        Pace::HoldEachBlobUntilItsWholeBatchIsAsked,
        NOTE_BEHIND_4_EMPTY_LOG_PAGES,
    );

    let added = add_the_shared_note(&relay).await;

    let served = relay.finish();
    assert_eq!(
        added.text.map(String::into_bytes),
        Some(saved_version(0)),
        "the note behind the empty pages was not applied"
    );
    assert_eq!(
        (added.pulls, served.log_requests, served.connections),
        (2, 6, 2),
        "pull calls, share-log requests, and connections for a note behind 4 empty log pages"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_share_pull_over_a_slow_link_applies_large_files_on_every_attempt() {
    let (relay, mut link_spent) = SlowLinkRelay::start(photos_of([PHOTO_BYTES; PHOTO_VERSIONS]));
    let (_scratch, path) = receiving_workspace();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1_100).unwrap().actor;
    let mut applied_after_each_attempt = Vec::new();

    while applied_after_each_attempt.last() != Some(&PHOTO_VERSIONS) {
        let applied = relay
            .pull_until_the_link_is_spent(&actor, &mut link_spent, SLOW_LINK_BYTES_PER_ATTEMPT)
            .await
            .0
            .into_iter()
            .filter(|stored| *stored)
            .count();
        assert!(
            applied > applied_after_each_attempt.last().copied().unwrap_or(0),
            "an attempt applied nothing: {applied} applied after {applied_after_each_attempt:?}"
        );
        applied_after_each_attempt.push(applied);
    }

    println!(
        "{}",
        serde_json::json!({
            "slow_link": "8 files of 1.5 MiB, 9 MiB per attempt",
            "applied_after_each_attempt": applied_after_each_attempt,
        })
    );
    drop(actor);
    supervisor.close(&path).unwrap();
    relay.finish();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_blob_does_not_keep_a_slow_pull_from_the_file_after_it() {
    let (relay, mut link_spent) =
        SlowLinkRelay::start(a_photo_over_the_ceiling_then_a_small_one_then_large_ones());
    let (_scratch, path) = receiving_workspace();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1_100).unwrap().actor;

    let (stored, _) = relay
        .pull_until_the_link_is_spent(&actor, &mut link_spent, 11 * 1024 * 1024)
        .await;

    println!(
        "{}",
        serde_json::json!({
            "refused_blob": "slow link, 11 MiB in the attempt",
            "times_the_refused_blob_was_asked_for": relay.times_asked_for(0),
            "files_applied": stored.iter().filter(|stored| **stored).count(),
        })
    );
    assert!(!stored[0], "a blob over its ceiling was stored");
    assert!(
        stored[1],
        "the small file after the refused blob was not applied"
    );
    assert_eq!(
        relay.times_asked_for(0),
        1,
        "the refused blob was downloaded again in the same pull"
    );
    drop(actor);
    supervisor.close(&path).unwrap();
    relay.finish();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pull_downloads_a_refused_blob_once() {
    let (relay, mut link_spent) =
        SlowLinkRelay::start(a_photo_over_the_ceiling_then_a_small_one_then_large_ones());
    let (_scratch, path) = receiving_workspace();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1_100).unwrap().actor;

    let (stored, pulled) = relay
        .pull_until_the_link_is_spent(&actor, &mut link_spent, usize::MAX)
        .await;
    let RelayOperationOutcome::ShareViewPulled(outcome) = pulled.expect("the pull finishes") else {
        panic!("a share view pull answers with its outcome");
    };
    let (constraint, ceiling) = dohc_engine_sync::blob_ceiling(dohc_engine_sync::BlobKind::Binary);

    println!(
        "{}",
        serde_json::json!({
            "refused_blob": "whole pull, link never spent",
            "times_the_refused_blob_was_asked_for": relay.times_asked_for(0),
            "files_applied": stored.iter().filter(|stored| **stored).count(),
        })
    );
    assert_eq!(
        stored,
        [false, true, true, true, true, true, true, true],
        "every file but the refused one is applied"
    );
    assert_eq!(relay.times_asked_for(0), 1);
    assert_eq!(
        outcome
            .refusals
            .iter()
            .map(|refusal| (
                refusal.origin_id.as_str(),
                refusal.origin_seq,
                refusal.op_kind.as_str(),
                refusal.code,
                refusal.detail.as_str()
            ))
            .collect::<Vec<_>>(),
        [(
            "granter",
            0,
            "moment.append",
            "share-blob-over-ceiling",
            format!(
                "shared blob exceeds {constraint}: limit {ceiling} bytes, observed {} bytes — {PHOTO_PATH}",
                ceiling + 1
            )
            .as_str()
        )]
    );
    drop(actor);
    supervisor.close(&path).unwrap();
    relay.finish();
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
        let relay = ShareRelay::start(pace, NOTE_SAVED_25_TIMES);
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
    for _ in 0..3 {
        let relay = ShareRelay::start(pace, NOTE_BEHIND_4_EMPTY_LOG_PAGES);
        let added = runtime.block_on(add_the_shared_note(&relay));
        let served = relay.finish();
        println!(
            "{}",
            serde_json::json!({
                "benchmark": "share_add_of_a_note_behind_4_empty_log_pages",
                "round_trip_ms": ROUND_TRIP.as_millis(),
                "new_connection_ms": TCP_AND_TLS_HANDSHAKE.as_millis(),
                "pull_calls": added.pulls,
                "log_requests": served.log_requests,
                "blob_requests": served.blob_requests,
                "connections": served.connections,
                "pull_ms": added.pull.as_millis(),
            })
        );
    }
}
