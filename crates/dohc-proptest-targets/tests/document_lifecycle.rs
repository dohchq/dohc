//! Generated command histories for one live plaintext note against a small
//! reference model.
//!
//! Each case starts from a fixture, runs at most eight commands through the
//! engine's own entry points, and checks the model's invariants after every
//! command. A refusal the model predicts is an outcome, not a failure.
//!
//! The model never reads the engine's tables. It holds the note's text as a
//! plain Y.Doc that receives exactly the updates the engine acknowledged, the
//! peer updates still parked behind a live session, whether the file still
//! owes writes, and what the file must hold once every committed write lands.
//!
//! This test does not cover:
//!
//! - Stop, retirement, release, or a Stopped fixture. Owner enrollment takes
//!   only a rich document, which needs `dohc-engine-reader`. This crate does
//!   not depend on it, and the existing Stop fixtures insert owner rows with
//!   SQL.
//! - Rich documents, file deletion, or explicit conflicts. The model never
//!   expects a conflict, so any conflict copy fails the case.
//! - The engine's session lease. While a session is open, the test passes
//!   `AlwaysLive` to the pull, so the test makes peer edits park. A bug where
//!   the engine fails to register a live session's lease cannot fail it.
//! - Pulls as production runs them. Every remote apply closes the actor,
//!   pulls on the store, and reopens the actor, which production does not do.
//!   That reopen skips the startup replay that `restart()` runs. `pull()`
//!   calls `fetch_pull`, `apply_pull`, `commit_pull_cursor`,
//!   `pull_hosted_workspace`, and `commit_hosted_cursor` as
//!   `run_relay_operation` in `dohc-engine-runtime/src/actor/relay.rs` does.
//!   It passes empty released tails, and skips `park_departed_hosted`,
//!   `release_unready_hosted`, and the retry on `RepairPending`.
//!
//! To cover a new lifecycle route, add a `Command` with its weight in
//! `command()`, and an arm in `Run::step` that updates the model and checks
//! the invariant the route keeps. To replay a failure, copy the replica and
//! shrunk history that proptest prints into a `#[test]` that calls `replay`,
//! as the regression tests at the end do.

use dohc_engine_collab::live_update_application::ReleasedTails;
use dohc_engine_collab::{ContentKind, DocKey, Regime, WriterDocCache, Ydoc};
use dohc_engine_runtime::{
    ActorHandle, CancellationToken, NoFaults, RuntimeError, WorkspaceSupervisor,
};
use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint};
use dohc_engine_sync::{
    AlwaysLive, BlobDownloadBatchRequest, BlobDownloadBatchResponse, BlobDownloadResponse,
    HostedPullRequest, HostedPullResponse, HostedScope, HostedScopeDocument, LeaseProbe,
    MomentMaterializationChange, NoLiveLeases, PullRequest, PullResponse, RelayError,
    RelaySyncClient, RelayTransport, ReplicationEnvelope, SyncPassOutcome,
};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use proptest::prelude::*;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const WS: &str = "workspace";
const NOTE: Note = Note {
    object_id: "note",
    path: "notes/live.md",
    peer: "peer",
};
const NEIGHBOUR: Note = Note {
    object_id: "neighbour",
    path: "notes/neighbour.md",
    peer: "neighbour-peer",
};

#[derive(Clone, Copy)]
struct Note {
    object_id: &'static str,
    path: &'static str,
    /// The device whose edits reach this note through sync.
    peer: &'static str,
}

impl Note {
    fn key(self) -> DocKey {
        DocKey::new(WS, "main", self.object_id).expect("key")
    }
}

/// One step a person, a peer, or the host can take.
#[derive(Clone, Debug)]
enum Command {
    /// Open the note, or resync the session that has it open.
    Open,
    /// The person types into the open session.
    LocalEdit,
    /// A peer's edit arrives through sync. It parks behind a live session.
    RemoteApply,
    /// The session settles the note to its file.
    Settle,
    /// The session closes.
    Close,
    /// The engine stops at a fault point inside the next write, then
    /// restarts.
    CrashAndReopen(Crash),
    /// An edit commits, its reply is lost, and the session sends it again.
    LostReply,
}

#[derive(Clone, Copy, Debug)]
enum Crash {
    /// Before an edit's transaction commits.
    DuringEdit,
    /// Before a settle's first transaction commits.
    DuringSettle,
    /// After a settle commits its file write and before the write runs.
    AfterSettleCommit,
}

fn command() -> impl Strategy<Value = Command> {
    prop_oneof![
        3 => Just(Command::Open),
        3 => Just(Command::LocalEdit),
        3 => Just(Command::RemoteApply),
        2 => Just(Command::Settle),
        2 => Just(Command::Close),
        1 => Just(Command::CrashAndReopen(Crash::DuringEdit)),
        1 => Just(Command::CrashAndReopen(Crash::DuringSettle)),
        1 => Just(Command::CrashAndReopen(Crash::AfterSettleCommit)),
        1 => Just(Command::LostReply),
    ]
}

/// The person's view of an open note.
struct Session {
    client: Ydoc,
    lineage: Option<String>,
    /// The file content this session last saw, which its settle expects.
    head_sha: Option<String>,
}

/// What the engine must hold, kept without reading its tables.
struct Model {
    /// The note's text: every update the engine applied, and nothing else.
    text: Ydoc,
    /// Peer updates waiting behind the live session, oldest first.
    parked: Vec<Vec<u8>>,
    session: Option<Session>,
    /// A local edit is in the note but not yet settled to its file.
    unsettled: bool,
    /// Peer edits entered the note without their file writes: a resync, an
    /// open or a refused settle drained them. The writes stay owed until a
    /// settle, a draining close, or a pull with no session writes the note.
    owed: bool,
    /// What the file holds once every write the engine committed lands: the
    /// note as of its last settle, drain, close that wrote, or pull with no
    /// session. A restart must leave the file holding this.
    file: String,
    /// The peer's own replica: the base and its own edits.
    peer: Ydoc,
    peer_seq: i64,
    edits: usize,
}

struct Engine {
    db: PathBuf,
    supervisor: WorkspaceSupervisor,
    actor: ActorHandle,
    /// A read-only view of the store, for checks the actor does not answer.
    probe: EngineStore,
    now: i64,
    replica: Replica,
    relay: Relay,
    lineage: String,
    /// Declared last, so it is removed after everything that holds its files.
    scratch: ScratchDir,
}

/// Run a future to completion on this thread. The actor runs on its own
/// thread, so its replies need no async runtime here.
fn block_on<F: std::future::Future>(future: F) -> F::Output {
    struct Unpark(std::thread::Thread);
    impl std::task::Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = std::task::Waker::from(Arc::new(Unpark(std::thread::current())));
    let mut context = std::task::Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        if let std::task::Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::park();
    }
}

fn utf16_len(doc: &Ydoc) -> u32 {
    u32::try_from(doc.plaintext_string().encode_utf16().count()).expect("length")
}

/// Which store the note lives in.
#[derive(Clone, Copy, Debug)]
enum Replica {
    /// A person's computer that joined the workspace its peers sync.
    Device,
    /// A server that hosts the workspace's shared notes. It pulls only the
    /// documents its scope names.
    Hosted,
}

/// What the relay holds: every peer row in relay order, their blobs, and
/// the scope it shows a hosted replica.
#[derive(Clone, Default)]
struct Feed {
    rows: Vec<ReplicationEnvelope>,
    blobs: BTreeMap<String, Vec<u8>>,
    scope: Option<HostedScope>,
}

/// A fake relay, answering the engine's own pull client from a [`Feed`].
#[derive(Clone)]
struct Relay(Arc<Mutex<Feed>>);

impl Relay {
    fn new(feed: Feed) -> Self {
        Self(Arc::new(Mutex::new(feed)))
    }

    fn feed(&self) -> std::sync::MutexGuard<'_, Feed> {
        self.0.lock().expect("feed")
    }

    /// Post a peer's `ydoc.update` of `note`. A base names itself as its
    /// lineage. Answers the lineage it names.
    fn serve(
        &self,
        note: Note,
        origin_seq: i64,
        lineage: Option<&str>,
        bytes: &[u8],
        now: i64,
    ) -> String {
        let blob = dohc_engine_storage::hex_sha256(bytes);
        let lineage = lineage.map_or_else(|| blob.clone(), str::to_owned);
        let mut feed = self.feed();
        let relay_seq = i64::try_from(feed.rows.len()).expect("rows") + 1;
        feed.rows.push(ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: WS.into(),
            origin_id: note.peer.into(),
            origin_seq,
            relay_seq: Some(relay_seq),
            op_kind: "ydoc.update".into(),
            payload: serde_json::json!({
                "versionId": "main",
                "objectId": note.object_id,
                "path": note.path,
                "contentKind": "plaintext",
                "updateBlobSha256": blob,
                "lineageClaimId": lineage,
                "isBaseState": origin_seq == 0,
            }),
            recorded_at_ms: now,
        });
        feed.blobs.insert(blob, bytes.to_vec());
        lineage
    }

    /// The rows after `cursor`, at most `limit`, for `object_id` if named.
    fn page(
        &self,
        cursor: i64,
        limit: usize,
        object_id: Option<&str>,
    ) -> (Vec<ReplicationEnvelope>, i64, bool) {
        let feed = self.feed();
        let mut after = feed
            .rows
            .iter()
            .filter(|op| op.relay_seq.expect("relay seq") > cursor)
            .filter(|op| object_id.is_none_or(|object_id| op.payload["objectId"] == object_id));
        let ops: Vec<_> = after.by_ref().take(limit).cloned().collect();
        let has_more = after.next().is_some();
        let next = ops
            .last()
            .map_or(cursor, |op| op.relay_seq.expect("relay seq"));
        (ops, next, has_more)
    }
}

macro_rules! refused {
    ($($method:ident($request:ty) -> $response:ty;)*) => {
        $(fn $method(&self, _req: $request) -> Result<$response, RelayError> {
            Err(RelayError::InvalidResponse)
        })*
    };
}

impl RelayTransport for Relay {
    fn pull(&self, req: PullRequest) -> Result<PullResponse, RelayError> {
        let (ops, next_cursor, has_more) = self.page(req.cursor, req.limit, None);
        Ok(PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops,
            next_cursor,
            has_more,
        })
    }

    fn pull_hosted(&self, req: HostedPullRequest) -> Result<HostedPullResponse, RelayError> {
        let scope = self
            .feed()
            .scope
            .clone()
            .ok_or(RelayError::InvalidResponse)?;
        // A pull under an earlier scope gets the scope and no rows.
        if req.scope_token.as_deref() != Some(scope.token.as_str()) {
            return Ok(HostedPullResponse {
                scope,
                ops: Vec::new(),
                next_cursor: req.cursor,
                has_more: false,
            });
        }
        let (ops, next_cursor, has_more) =
            self.page(req.cursor, req.limit, req.object_id.as_deref());
        Ok(HostedPullResponse {
            scope,
            ops,
            next_cursor,
            has_more,
        })
    }

    fn download_blobs(
        &self,
        req: BlobDownloadBatchRequest,
    ) -> Result<BlobDownloadBatchResponse, RelayError> {
        let feed = self.feed();
        Ok(BlobDownloadBatchResponse {
            results: req
                .blobs
                .iter()
                .map(|blob| {
                    feed.blobs
                        .get(&blob.sha256)
                        .map(|bytes| BlobDownloadResponse {
                            bytes: bytes.clone(),
                        })
                        .ok_or(RelayError::BlobMissing)
                })
                .collect(),
        })
    }

    refused! {
        push(dohc_engine_sync::PushRequest) -> dohc_engine_sync::PushResponse;
        lookup_log_coordinate(dohc_engine_sync::LogCoordinateRequest) -> dohc_engine_sync::LogCoordinateResponse;
        probe(dohc_engine_sync::ProbeRequest) -> dohc_engine_sync::ProbeResponse;
        claim_workspace(dohc_engine_sync::ClaimRequest) -> dohc_engine_sync::ClaimResponse;
        rotate_epoch(dohc_engine_sync::EpochRequest) -> dohc_engine_sync::EpochResponse;
        blobs_have(dohc_engine_sync::BlobHaveRequest) -> dohc_engine_sync::BlobHaveResponse;
        upload_blob(dohc_engine_sync::BlobUploadRequest) -> ();
        upload_key_envelope(dohc_engine_sync::KeyEnvelopeRequest) -> dohc_engine_sync::KeyEnvelopeResponse;
        download_key_envelope(dohc_engine_sync::KeyEnvelopeDownloadRequest) -> dohc_engine_sync::KeyEnvelopeDownloadResponse;
        shared_channel_pull(dohc_engine_sync::SharedChannelRequest) -> dohc_engine_sync::SharedChannelResponse;
        share_log_push(dohc_engine_sync::ShareLogPushRequest) -> dohc_engine_sync::PushResponse;
        share_view_pull(dohc_engine_sync::ShareViewRequest) -> dohc_engine_sync::ShareViewResponse;
        share_blob(dohc_engine_sync::ShareBlobRequest) -> BlobDownloadResponse;
        share_blob_upload(dohc_engine_sync::ShareBlobUploadRequest) -> ();
        share_proposal_submit(dohc_engine_sync::ShareProposalSubmitRequest) -> dohc_engine_sync::ShareProposalSubmitResponse;
        share_collection_write(dohc_engine_sync::ShareCollectionWriteRequest) -> dohc_engine_sync::ShareCollectionWriteResponse;
    }
}

/// Pull every page the relay holds and commit each page's cursor, through
/// the engine's own pull client. A live lease parks the note's updates.
/// Answers the file changes the pages report, for the actor to write.
fn pull(
    store: &mut EngineStore,
    relay: &Relay,
    replica: Replica,
    leases: &dyn LeaseProbe,
    now: i64,
) -> Vec<MomentMaterializationChange> {
    let client = RelaySyncClient::new(relay.clone());
    let mut cache = WriterDocCache::new();
    let mut changes = Vec::new();
    loop {
        let has_more = match replica {
            Replica::Device => {
                let page = client.fetch_pull(store, WS, &NoFaults).expect("fetch pull");
                let SyncPassOutcome::Complete {
                    pending_cursor,
                    changed_paths,
                    refusals,
                    has_more,
                    ..
                } = client
                    .apply_pull(store, &mut cache, WS, &page, &NoFaults, leases, now)
                    .expect("apply pull")
                else {
                    panic!("the pull stopped");
                };
                assert_eq!(refusals, [], "the pull refused a peer update");
                changes.extend(changed_paths);
                if let Some(cursor) = pending_cursor {
                    client
                        .commit_pull_cursor(store, WS, &cursor, &NoFaults, leases, now)
                        .expect("commit pull");
                }
                has_more
            }
            Replica::Hosted => {
                let pass = loop {
                    match client
                        .pull_hosted_workspace(store, &mut cache, WS, "relay", &NoFaults, leases)
                    {
                        Err(RelayError::ValidationPending(pending)) => {
                            block_on(pending.validate()).expect("validation");
                        }
                        pass => break pass.expect("hosted pull"),
                    }
                };
                assert_eq!(pass.refusals, [], "the pull refused a peer update");
                changes.extend(pass.changed_paths);
                if let Some(cursor) = &pass.pending_cursor {
                    let tails = ReleasedTails::default().bound_to(store);
                    client
                        .commit_hosted_cursor(store, WS, cursor, &tails, &NoFaults)
                        .expect("commit hosted pull");
                }
                pass.has_more
            }
        };
        if !has_more {
            return changes;
        }
    }
}

/// The fixture every case starts from, built once per test thread and
/// copied into each case's own workspace.
struct Template {
    scratch: ScratchDir,
    feed: Feed,
    base: Vec<u8>,
    lineage: String,
}

thread_local! {
    static DEVICE: Template = Template::build(Replica::Device);
    static HOSTED: Template = Template::build(Replica::Hosted);
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).expect("copy dir");
    for entry in std::fs::read_dir(from).expect("read template") {
        let entry = entry.expect("template entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("entry type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).expect("copy file");
        }
    }
}

impl Template {
    /// A note and a neighbour, each pulled from its peer's base and written
    /// to its file. The store is closed when this returns.
    fn build(replica: Replica) -> Self {
        let (scratch, db, mut store) = dohc_engine_testkit::open_store();
        match replica {
            Replica::Device => dohc_engine_sync::adopt_join_identity(
                &mut store, WS, "local", "epoch", "stream", 1_000, &NoFaults,
            ),
            Replica::Hosted => dohc_engine_sync::create_hosted_replica(
                &mut store,
                WS,
                "service-host:host",
                "epoch",
                "stream",
                1_000,
                &NoFaults,
            ),
        }
        .expect("identity");
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version(WS, "main", 1_000, &NoFaults)
            .expect("main version");
        let scope = HostedScope {
            token: "scope".into(),
            documents: [NOTE, NEIGHBOUR]
                .iter()
                .map(|note| HostedScopeDocument {
                    object_id: note.object_id.into(),
                    path: note.path.into(),
                })
                .collect(),
        };
        let relay = Relay::new(Feed {
            scope: matches!(replica, Replica::Hosted).then_some(scope),
            ..Feed::default()
        });
        let base = Ydoc::wire();
        base.plaintext_insert(0, "before");
        let base = base.encode_full_state();
        let mut lineage = String::new();
        for note in [NOTE, NEIGHBOUR] {
            lineage = relay.serve(note, 0, None, &base, 1_000);
        }
        let changes = pull(&mut store, &relay, replica, &NoLiveLeases, 1_001);
        drop(store);
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1_002).expect("open actor").actor;
        block_on(actor.materialize_relay_page(
            WS.into(),
            scratch.path().to_path_buf(),
            changes,
            Arc::new(()),
            1_003,
            CancellationToken::new(),
        ))
        .expect("write the base");
        supervisor.close(&db).expect("close actor");
        let feed = relay.feed().clone();
        Self {
            scratch,
            feed,
            base,
            lineage,
        }
    }
}

impl Engine {
    /// A fresh copy of the template, with its actor open. Answers the base
    /// both notes replicated.
    fn new(replica: Replica) -> (Self, Vec<u8>) {
        let scratch = ScratchDir::new().expect("scratch");
        let copy = |template: &Template| {
            copy_tree(template.scratch.path(), scratch.path());
            (
                template.feed.clone(),
                template.base.clone(),
                template.lineage.clone(),
            )
        };
        let (feed, base, lineage) = match replica {
            Replica::Device => DEVICE.with(copy),
            Replica::Hosted => HOSTED.with(copy),
        };
        let db = dohc_engine_testkit::engine_db_path(scratch.path()).expect("db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1_010).expect("open actor").actor;
        let probe = EngineStore::open_read_only(&db).expect("probe store");
        (
            Self {
                scratch,
                db,
                supervisor,
                actor,
                probe,
                now: 1_010,
                replica,
                relay: Relay::new(feed),
                lineage,
            },
            base,
        )
    }

    fn tick(&mut self) -> i64 {
        self.now += 10;
        self.now
    }

    fn file(&self, note: Note) -> Option<String> {
        std::fs::read_to_string(self.scratch.path().join(note.path)).ok()
    }

    /// Copies a conflict left beside the notes.
    fn conflict_files(&self) -> Vec<String> {
        std::fs::read_dir(self.scratch.path().join("notes"))
            .expect("notes dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name.contains("conflict"))
            .collect()
    }

    /// The note's applied Y.Doc as the store holds it.
    fn persisted_text(&self, note: Note) -> String {
        dohc_engine_collab::load_persisted(&self.probe, &note.key())
            .expect("load")
            .expect("persisted note")
            .doc
            .plaintext_string()
    }

    fn head_update_seq(&self, note: Note) -> i64 {
        dohc_engine_collab::read_marker(&self.probe, &note.key())
            .expect("marker")
            .expect("marker present")
            .head_update_seq
    }

    /// Restart the engine as workspace open does: reopen the actor, then
    /// replay the file writes the store still owes.
    fn restart(&mut self) {
        self.supervisor.close(&self.db).expect("close actor");
        let now = self.tick();
        self.actor = self
            .supervisor
            .open(&self.db, now)
            .expect("reopen actor")
            .actor;
        let now = self.tick();
        block_on(self.actor.materialize_replay_pending(
            self.scratch.path().to_path_buf(),
            WS.into(),
            now,
        ))
        .expect("startup replay");
    }

    /// Pull what the relay holds, as sync does, then write the files its
    /// pages changed. A live session parks the note's updates.
    fn pull(&mut self, live: bool) {
        let (relay, replica) = (self.relay.clone(), self.replica);
        let changes = self.with_store(|store, now| {
            let leases: &dyn LeaseProbe = if live { &AlwaysLive } else { &NoLiveLeases };
            pull(store, &relay, replica, leases, now)
        });
        let now = self.tick();
        block_on(self.actor.materialize_relay_page(
            WS.into(),
            self.scratch.path().to_path_buf(),
            changes,
            Arc::new(()),
            now,
            CancellationToken::new(),
        ))
        .expect("pull materialization");
    }

    /// Run `apply` on the store while the actor is closed, then reopen it.
    fn with_store<R>(&mut self, apply: impl FnOnce(&mut EngineStore, i64) -> R) -> R {
        self.supervisor.close(&self.db).expect("close actor");
        let now = self.tick();
        let mut store = EngineStore::open(&self.db, now).expect("store");
        let result = apply(&mut store, now);
        drop(store);
        let now = self.tick();
        self.actor = self
            .supervisor
            .open(&self.db, now)
            .expect("reopen actor")
            .actor;
        result
    }

    fn open(&mut self, note: Note) -> Result<Session, RuntimeError> {
        let now = self.tick();
        let opened = block_on(self.actor.ydoc_open_state(
            WS.into(),
            now,
            true,
            Some(note.key()),
            "main".into(),
            note.path.into(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        ))?;
        let client = Ydoc::wire();
        client.apply(&opened.initial_update).expect("open state");
        Ok(Session {
            client,
            lineage: opened.lineage_claim_id,
            head_sha: opened.head_blob_sha256,
        })
    }

    fn resync(&mut self, note: Note, session: &mut Session) -> Result<(), RuntimeError> {
        let resynced = block_on(self.actor.ydoc_resync(
            note.key(),
            session.lineage.clone(),
            CancellationToken::new(),
            None,
        ))?;
        session
            .client
            .apply(&resynced.initial_update)
            .expect("resync state");
        session.lineage = resynced.lineage_claim_id;
        session.head_sha = resynced.head_blob_sha256;
        Ok(())
    }

    fn record(
        &mut self,
        note: Note,
        session: &Session,
        update: &[u8],
        request: &str,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<dohc_engine_runtime::actor::YdocAppend, RuntimeError> {
        let now = self.tick();
        block_on(self.actor.ydoc_record_update(
            note.key(),
            note.path.into(),
            ContentKind::Plaintext,
            Regime::Replicated,
            update.to_vec(),
            None,
            None,
            session.lineage.clone(),
            false,
            None,
            Some(request.into()),
            now,
            faults,
            CancellationToken::new(),
            None,
        ))
    }

    fn settle(
        &mut self,
        note: Note,
        session: &Session,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<dohc_engine_runtime::actor::YdocSettleOutcome, RuntimeError> {
        let now = self.tick();
        block_on(self.actor.ydoc_settle(
            self.scratch.path().to_path_buf(),
            note.key(),
            note.path.into(),
            ContentKind::Plaintext,
            session.lineage.clone(),
            session.head_sha.clone(),
            "session".into(),
            Arc::new(()),
            now,
            faults,
            CancellationToken::new(),
            None,
            None,
        ))
    }

    fn close(&mut self, note: Note) -> Result<(), RuntimeError> {
        let now = self.tick();
        block_on(self.actor.ydoc_close_session_materialized(
            self.scratch.path().to_path_buf(),
            note.key(),
            Arc::new(()),
            now,
            Arc::new(NoFaults),
            CancellationToken::new(),
        ))
        .map(drop)
    }
}

/// One generated history, run step by step against the model.
struct Run {
    engine: Engine,
    model: Model,
    log: Vec<String>,
}

impl Run {
    fn new(replica: Replica) -> Self {
        let (engine, base) = Engine::new(replica);
        let text = Ydoc::wire();
        text.apply(&base).expect("model base");
        let peer = Ydoc::wire();
        peer.apply(&base).expect("peer base");
        let file = text.plaintext_string();
        Self {
            engine,
            model: Model {
                text,
                parked: Vec::new(),
                session: None,
                unsettled: false,
                owed: false,
                file,
                peer,
                peer_seq: 0,
                edits: 0,
            },
            log: Vec::new(),
        }
    }

    fn fail(&self, message: String) -> TestCaseError {
        TestCaseError::fail(format!("{message}\nhistory: {:?}", self.log))
    }

    fn check(&self, holds: bool, message: impl FnOnce() -> String) -> Result<(), TestCaseError> {
        if holds {
            Ok(())
        } else {
            Err(self.fail(message()))
        }
    }

    /// Parked peer edits enter the note when the engine drains them. Answers
    /// whether any did.
    fn drain_parked(&mut self) -> bool {
        let drained = !self.model.parked.is_empty();
        for update in self.model.parked.drain(..) {
            self.model.text.apply(&update).expect("model drain");
        }
        drained
    }

    /// A drain outside a close leaves the drained edits' writes owed. The
    /// newest of them writes the note as the drain left it.
    fn drain_owed(&mut self) {
        if self.drain_parked() {
            self.model.owed = true;
            self.model.file = self.model.text.plaintext_string();
        }
    }

    fn step(&mut self, command: &Command) -> Result<(), TestCaseError> {
        self.log.push(format!("{command:?}"));
        match command {
            Command::Open => self.open()?,
            Command::LocalEdit => self.local_edit()?,
            Command::RemoteApply => self.remote_apply()?,
            Command::Settle => drop(self.settle()?),
            Command::Close => self.close()?,
            Command::CrashAndReopen(crash) => self.crash(*crash)?,
            Command::LostReply => self.lost_reply()?,
        }
        self.check_store()
    }

    fn open(&mut self) -> Result<(), TestCaseError> {
        if let Some(mut session) = self.model.session.take() {
            let resynced = self.engine.resync(NOTE, &mut session);
            self.model.session = Some(session);
            resynced.map_err(|error| self.fail(format!("resync refused: {error:?}")))?;
        } else {
            let session = self
                .engine
                .open(NOTE)
                .map_err(|error| self.fail(format!("open refused: {error:?}")))?;
            self.model.session = Some(session);
        }
        self.drain_owed();
        let client = self
            .model
            .session
            .as_ref()
            .expect("session")
            .client
            .plaintext_string();
        let expected = self.model.text.plaintext_string();
        self.check(client == expected, || {
            format!("the session sees {client:?}, the note is {expected:?}")
        })
    }

    fn next_edit(&mut self) -> Option<(Vec<u8>, String)> {
        let session = self.model.session.as_ref()?;
        self.model.edits += 1;
        let token = format!(" l{}", self.model.edits);
        let update = session
            .client
            .plaintext_insert(utf16_len(&session.client), &token);
        Some((update, token))
    }

    fn acknowledge(&mut self, update: &[u8]) {
        self.model.text.apply(update).expect("model edit");
        self.model.unsettled = true;
    }

    fn local_edit(&mut self) -> Result<(), TestCaseError> {
        let Some((update, token)) = self.next_edit() else {
            return Ok(());
        };
        let session = self.model.session.as_ref().expect("session");
        let request = format!("edit-{token}");
        self.engine
            .record(NOTE, session, &update, &request, Arc::new(NoFaults))
            .map_err(|error| self.fail(format!("edit refused: {error:?}")))?;
        self.acknowledge(&update);
        Ok(())
    }

    fn remote_apply(&mut self) -> Result<(), TestCaseError> {
        self.model.peer_seq += 1;
        let token = format!(" r{}", self.model.peer_seq);
        let update = self
            .model
            .peer
            .plaintext_insert(utf16_len(&self.model.peer), &token);
        let live = self.model.session.is_some();
        let now = self.engine.tick();
        let lineage = self.engine.lineage.clone();
        self.engine
            .relay
            .serve(NOTE, self.model.peer_seq, Some(&lineage), &update, now);
        self.engine.pull(live);
        if live {
            self.model.parked.push(update);
            return Ok(());
        }
        // An update that does not park first drains any that did. The pull
        // then writes the whole note and ends every write queued before it.
        self.drain_parked();
        self.model.text.apply(&update).expect("model remote");
        self.model.owed = false;
        self.model.unsettled = false;
        self.model.file = self.model.text.plaintext_string();
        self.check_file("pull")
    }

    /// Answers whether the note settled.
    fn settle(&mut self) -> Result<bool, TestCaseError> {
        let Some(session) = self.model.session.as_ref() else {
            return Ok(false);
        };
        let outcome = self
            .engine
            .settle(NOTE, session, Arc::new(NoFaults))
            .map_err(|error| self.fail(format!("settle refused: {error:?}")))?;
        let behind = !self.model.parked.is_empty();
        let Some(settled) = outcome.settled() else {
            // The settle drains what parked behind the session and asks it
            // to catch up first.
            self.check(behind, || {
                "settle refused a session that was current".into()
            })?;
            self.drain_owed();
            return Ok(false);
        };
        self.check(!behind, || "settle passed peer edits still parked".into())?;
        let expected = self.model.text.plaintext_string();
        self.check(
            settled.content.as_deref() == Some(expected.as_str()),
            || format!("settled {:?}, the note is {expected:?}", settled.content),
        )?;
        self.check(settled.materialized, || {
            "settle left the file unwritten".into()
        })?;
        self.model.session.as_mut().expect("session").head_sha = Some(settled.sha256.clone());
        self.model.unsettled = false;
        self.model.owed = false;
        self.model.file = expected;
        self.check_file("settle")?;
        Ok(true)
    }

    fn close(&mut self) -> Result<(), TestCaseError> {
        if self.model.session.take().is_none() {
            return Ok(());
        }
        self.engine
            .close(NOTE)
            .map_err(|error| self.fail(format!("close refused: {error:?}")))?;
        // A close that drains parked edits writes the whole note, local edits
        // included, after any writes owed before them, oldest first. A dirty
        // close that drains nothing writes nothing.
        if self.drain_parked() {
            self.model.owed = false;
            self.model.unsettled = false;
            self.model.file = self.model.text.plaintext_string();
            self.check_file("close")?;
        } else if !self.model.unsettled && !self.model.owed {
            self.check_file("close")?;
        }
        Ok(())
    }

    fn crash(&mut self, crash: Crash) -> Result<(), TestCaseError> {
        let Some(session) = self.model.session.as_ref() else {
            return Ok(());
        };
        let behind = !self.model.parked.is_empty();
        // A current settle replays the owed writes before it writes.
        let replays_owed = matches!(crash, Crash::AfterSettleCommit) && !behind && self.model.owed;
        let point = match crash {
            Crash::DuringEdit | Crash::DuringSettle => FaultPoint::StorageBeforePersist,
            Crash::AfterSettleCommit => FaultPoint::MaterializeAfterJobCommit,
        };
        let faults = ScriptedFaults::crash_at(point);
        let injected: Arc<dyn FaultInjector> = faults.clone();
        // Whether the engine must stop, and its answer.
        let (stops, answer) = match crash {
            Crash::DuringEdit => {
                let (update, token) = self.next_edit().expect("session");
                let session = self.model.session.as_ref().expect("session");
                let request = format!("edit-{token}");
                // Nothing committed, so nothing is acknowledged.
                let result = self
                    .engine
                    .record(NOTE, session, &update, &request, injected);
                (true, result.map(drop))
            }
            Crash::DuringSettle | Crash::AfterSettleCommit => {
                let result = self.engine.settle(NOTE, session, injected);
                let settled = result.as_ref().ok().map(|outcome| {
                    matches!(
                        outcome,
                        dohc_engine_runtime::actor::YdocSettleOutcome::Settled(_)
                    )
                });
                let text = self.model.text.plaintext_string();
                let commits = matches!(crash, Crash::AfterSettleCommit);
                // Behind parked edits, the settle drains them first. A crash
                // before persist stops in that drain; otherwise the settle
                // asks the session to catch up. A current settle runs any
                // owed writes first, and a crash after a job commit stops in
                // the first of them. Then the settle writes only if the file
                // is not already the note.
                let stops = if behind {
                    !commits
                } else {
                    (commits && self.model.owed) || text != self.model.file
                };
                if stops {
                    // A crash after the job commit, with nothing owed,
                    // stops after the settle committed its own write.
                    if commits && !behind && !self.model.owed {
                        self.model.unsettled = false;
                        self.model.file = text;
                    }
                } else if behind {
                    self.check(settled == Some(false), || {
                        format!("a settle behind parked edits answered {result:?}")
                    })?;
                    self.drain_owed();
                } else {
                    self.check(settled == Some(true), || {
                        format!("a settle with nothing to write answered {result:?}")
                    })?;
                }
                (stops, result.map(drop))
            }
        };
        // A drain answers the sync layer's crash, everything else the
        // runtime's. A crash in an owed write older than the head's stops
        // the settle with that write still pending.
        let crashed = matches!(
            answer,
            Err(RuntimeError::OperationCrashed
                | RuntimeError::Sync(dohc_engine_sync::SyncError::FaultCrash))
        ) || (replays_owed
            && matches!(
                answer,
                Err(RuntimeError::Sync(
                    dohc_engine_sync::SyncError::RetryableState {
                        reason: "settlement-materialization-pending"
                    }
                ))
            ));
        let fired = faults.fired();
        self.check(fired == stops && crashed == stops, || {
            format!("{crash:?}: the fault fired {fired}, the engine answered {answer:?}")
        })?;
        // The engine restarts, and the session that held the note is gone.
        // Startup replay lands every owed write before anything else runs.
        self.engine.restart();
        self.model.session = None;
        self.model.owed = false;
        self.check_restart()
    }

    fn lost_reply(&mut self) -> Result<(), TestCaseError> {
        let Some((update, token)) = self.next_edit() else {
            return Ok(());
        };
        let request = format!("edit-{token}");
        let session = self.model.session.as_ref().expect("session");
        let lost = self.engine.record(
            NOTE,
            session,
            &update,
            &request,
            ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck),
        );
        self.check(lost.is_err(), || "the fault did not drop the reply".into())?;
        let committed = self.engine.head_update_seq(NOTE);
        let session = self.model.session.as_ref().expect("session");
        let replayed = self
            .engine
            .record(NOTE, session, &update, &request, Arc::new(NoFaults))
            .map_err(|error| self.fail(format!("replay refused: {error:?}")))?;
        self.check(
            replayed.outcome.deduped && !replayed.outcome.emit_outbound,
            || format!("the replay added history: {:?}", replayed.outcome),
        )?;
        let after = self.engine.head_update_seq(NOTE);
        self.check(after == committed, || {
            format!("the replay moved the head from {committed} to {after}")
        })?;
        self.acknowledge(&update);
        Ok(())
    }

    /// The store's note is the model's: no acknowledged edit lost, no parked
    /// edit applied early, nothing added.
    fn check_store(&self) -> Result<(), TestCaseError> {
        let persisted = self.engine.persisted_text(NOTE);
        let expected = self.model.text.plaintext_string();
        self.check(persisted == expected, || {
            format!("the store holds {persisted:?}, the model {expected:?}")
        })
    }

    /// Once the note settles, its file holds the note, written in order. A
    /// write that passed an older one is caught in one of two ways: it leaves
    /// a conflict copy, which this check finds, or the next settle is refused
    /// as a stale target, which fails the case.
    fn check_file(&self, after: &str) -> Result<(), TestCaseError> {
        self.check_file_holds(after, &self.model.text.plaintext_string())
    }

    /// Right after a restart, before any settle or pull can repair it, the
    /// file holds every write the engine committed.
    fn check_restart(&self) -> Result<(), TestCaseError> {
        self.check_file_holds("restart", &self.model.file)
    }

    fn check_file_holds(&self, after: &str, expected: &str) -> Result<(), TestCaseError> {
        let file = self.engine.file(NOTE);
        self.check(file.as_deref() == Some(expected), || {
            format!("after {after} the file holds {file:?}, it must hold {expected:?}")
        })?;
        let conflicts = self.engine.conflict_files();
        self.check(conflicts.is_empty(), || {
            format!("after {after} conflict copies appeared: {conflicts:?}")
        })
    }

    /// Bring the note to rest: open it, settle until current, close. The file
    /// must then hold every acknowledged edit and every peer edit.
    fn finish(&mut self) -> Result<(), TestCaseError> {
        self.log.push("finish".into());
        if self.model.session.is_none() {
            self.open()?;
        }
        if !self.settle()? {
            self.open()?;
            let settled = self.settle()?;
            self.check(settled, || "a current session could not settle".into())?;
        }
        self.close()?;
        self.check_file("finish")?;
        let existed = block_on(self.engine.actor.ydoc_file_has_existed(NOTE.key(), false))
            .map_err(|error| self.fail(format!("file history unreadable: {error:?}")))?;
        // The fixture wrote the file and no command deletes it.
        self.check(existed, || "the engine says the file never existed".into())
    }

    /// Whatever state the note was left in, the neighbour still opens, takes
    /// an edit, and settles to its file.
    fn neighbour_progresses(&mut self) -> Result<(), TestCaseError> {
        self.log.push("neighbour".into());
        let session = self
            .engine
            .open(NEIGHBOUR)
            .map_err(|error| self.fail(format!("neighbour open refused: {error:?}")))?;
        let update = session
            .client
            .plaintext_insert(utf16_len(&session.client), " n");
        self.engine
            .record(
                NEIGHBOUR,
                &session,
                &update,
                "neighbour-edit",
                Arc::new(NoFaults),
            )
            .map_err(|error| self.fail(format!("neighbour edit refused: {error:?}")))?;
        let settled = self
            .engine
            .settle(NEIGHBOUR, &session, Arc::new(NoFaults))
            .map_err(|error| self.fail(format!("neighbour settle refused: {error:?}")))?
            .settled();
        self.check(settled.is_some_and(|settled| settled.materialized), || {
            "the neighbour did not settle".into()
        })?;
        let file = self.engine.file(NEIGHBOUR);
        self.check(file.as_deref() == Some("before n"), || {
            format!("the neighbour's file holds {file:?}")
        })
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = self.engine.supervisor.close_all();
    }
}

fn run(replica: Replica, history: &[Command]) -> Result<(), TestCaseError> {
    let mut run = Run::new(replica);
    for command in history {
        run.step(command)?;
    }
    run.neighbour_progresses()?;
    run.finish()
}

proptest! {
    #[test]
    fn a_note_keeps_every_edit_and_settles_its_file_in_order(
        replica in prop_oneof![Just(Replica::Device), Just(Replica::Hosted)],
        history in prop::collection::vec(command(), 1..=8)
    ) {
        run(replica, &history)?;
    }
}

fn replay(replica: Replica, history: &[Command]) {
    if let Err(error) = run(replica, history) {
        panic!("{error}");
    }
}

/// Replay `history` on both replicas, and report every one that fails.
fn replay_both(history: &[Command]) {
    let failures: Vec<String> = [Replica::Device, Replica::Hosted]
        .into_iter()
        .filter_map(|replica| {
            run(replica, history)
                .err()
                .map(|error| format!("{replica:?}: {error}"))
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A settle after a drain must write every owed write. Writing only the
/// newest leaves the file behind the note.
#[test]
fn a_settle_after_a_drain_writes_every_owed_edit() {
    use Command::{Open, RemoteApply, Settle};
    replay(Replica::Device, &[Open, RemoteApply, Settle, RemoteApply]);
}

/// A pull that writes the note's file must end its queued writes. Otherwise
/// a later settle replays an older write and is refused as a stale target.
#[test]
fn a_pull_that_writes_the_file_ends_its_queued_writes() {
    replay(Replica::Device, &[Command::RemoteApply]);
}

/// A pull with no session writes the whole note and ends the writes that
/// earlier drains left owed, so the next settle has nothing to replay.
#[test]
fn a_pull_with_no_session_ends_the_writes_drains_left_owed() {
    use Command::{Close, CrashAndReopen, Open, RemoteApply};
    let history = [
        Open,
        RemoteApply,
        Open,
        Close,
        RemoteApply,
        Open,
        CrashAndReopen(Crash::AfterSettleCommit),
    ];
    replay_both(&history);
}

/// The same, with a local edit the settle commits before the crash.
#[test]
fn a_settle_after_a_pull_with_no_session_commits_its_own_write() {
    use Command::{Close, CrashAndReopen, LocalEdit, Open, RemoteApply};
    let history = [
        Open,
        RemoteApply,
        Open,
        Close,
        RemoteApply,
        Open,
        LocalEdit,
        CrashAndReopen(Crash::AfterSettleCommit),
    ];
    replay_both(&history);
}

/// Two drains leave two owed writes. A crash in the earlier one stops the
/// settle.
#[test]
fn a_crash_in_an_earlier_owed_write_stops_the_settle() {
    use Command::{CrashAndReopen, Open, RemoteApply};
    let history = [
        Open,
        RemoteApply,
        Open,
        RemoteApply,
        Open,
        CrashAndReopen(Crash::AfterSettleCommit),
    ];
    replay_both(&history);
}

/// A close that drains peer edits writes the local edit with them.
/// Generation seldom reaches this history.
#[test]
fn a_draining_close_writes_the_local_edit() {
    use Command::{Close, LocalEdit, Open, RemoteApply};
    let history = [Open, LocalEdit, RemoteApply, Close];
    replay_both(&history);
}
