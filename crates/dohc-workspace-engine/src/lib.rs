//! Shadow-only composition host for the Rust workspace engine.

#![forbid(unsafe_code)]

pub(crate) mod capture_driver;
pub mod capture_sink;
pub mod cutover_rehearse;
pub mod shadow_fence;

pub use capture_sink::{SelfWriteSuppression, StoreCaptureSink};

use base64::Engine as _;
use dohc_engine_collab::{CollabError, ContentKind, DocKey, Lease, LeaseRegistry, Regime};
use dohc_engine_domain::{
    BookmarkMode, BookmarkTargetKind, ChatActorKind, ChatBookmark, ChatChannel, ChatChannelKind,
    ChatChannelSummary, ChatFeedReadState, ChatFollow, ChatMessage, ChatThread,
    ChatThreadReadState, CompareTextFileVersions, ComparisonStatus, ConflictChoice,
    ConflictContentKind, ConflictFileState, ConflictMetadata, ConflictResolution, ConflictStatus,
    CreateNamedVersion, DeleteTextFile, DispatchClaim, DomainError, FeedCursorValue, FollowState,
    FollowTargetKind, MarkdownMergeResult, MergeTextFileFromVersion, MergeTextFileResult,
    RenameTextFile, ResolveConflictKind, ResolveTextConflict, RollbackTextFileMutation,
    SaveBookmark, SecretDelete, SecretDiskIntent, SecretMomentRecord, SecretWrite, SendMessage,
    SetFollow, StartChannelThread, TextConflict, TextSnapshot, VersionFileChangeStatus,
    VersionRecord, WriteBinary, WriteText, merge_markdown,
};
use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    transport::{EngineService as ProtocolEngineService, RequestContext},
    wire::{Request, Response, WorkspaceHandle},
};
use dohc_engine_runtime::{
    ActorHandle, ApplyOutcome, CancellationToken, ConflictApplyResult, LifecycleState, NoFaults,
    PostCommitMaterializeOutcome, RuntimeError, SearchError, SearchSurface, WorkspaceSupervisor,
};
use dohc_engine_sync::{ReplicationEnvelope, SyncError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};
use unicode_normalization::UnicodeNormalization;

const MAX_OPEN_HANDLES: usize = 64;
const CHAT_DISPATCH_MAX_ATTEMPTS: i64 = 2;

/// In-band CONTENT (binary bytes, secret plaintext) is bounded by the DOP1
/// string limit (64 KiB per string): base64 expands 4/3, so this raw cap
/// leaves headroom under it. Larger content needs the protocol's blob-chunk
/// streaming (BlobStart exists in the wire contract; no daemon producer
/// yet) — tracked in docs/superpowers/plans/rust-engine/RPC_GAP.md, which
/// is maintained on the integrator branch (PR #216) until it merges.
const MAX_INBAND_CONTENT_BYTES: usize = dohc_engine_domain::INBAND_CONTENT_CAP_BYTES;

/// Largest raw Y.Doc full-state that still fits one wire string once
/// base64-expanded (4/3): DOP1's 64 KiB `max_string_bytes` divided by 4,
/// times 3. Refusing here surfaces a clean error instead of the framer
/// rejecting the whole response (which InProcessTransport would not even
/// catch). Docs beyond this belong to the blob-chunk streaming path.
const MAX_YDOC_STATE_WIRE_BYTES: usize =
    (dohc_engine_protocol::limits::WireLimits::SPIKE_DEFAULTS.max_string_bytes as usize / 4) * 3;

fn encode_ydoc_state_base64(full_state: &[u8]) -> Result<String, WireError> {
    if full_state.len() > MAX_YDOC_STATE_WIRE_BYTES {
        return Err(wire(ErrorCode::Internal, "ydoc-state-exceeds-wire-limit"));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(full_state))
}

/// Approximate serialized-bytes budget for one moments.list page: a row
/// can legitimately carry 64 KiB strings (authorJson), so a row COUNT can
/// never bound the frame — the page cuts when the running estimate would
/// pass this, well under the 1 MiB frame limit.
const MOMENTS_PAGE_BYTE_BUDGET: usize = 256 * 1024;

/// How many leading serialized rows fit a byte budget (at least one always
/// ships — every string is wire-capped, so a single row fits). MEASURED on
/// the serialized JSON, not estimated from raw lengths: escaping can expand
/// a control-character-heavy string up to 6x, and an estimate that ignores
/// that can pass the budget while the encoded frame exceeds the limit.
fn byte_budget_cut_serialized(rows: &[Value], budget: usize) -> usize {
    let mut included = 0usize;
    let mut remaining = budget as i64;
    for row in rows {
        let size = serde_json::to_string(row).map_or(0, |s| s.len());
        // A first row may exceed the PAGE budget (progress guarantee) but
        // never the hard single-row bound — beyond that it cannot ship
        // in a frame at all, and the caller must surface the refusal
        // rather than emit an over-frame response.
        if included == 0 && size > SINGLE_ROW_HARD_CAP_BYTES {
            break;
        }
        remaining -= size as i64;
        if included > 0 && remaining < 0 {
            break;
        }
        included += 1;
    }
    included
}

/// The most one serialized row may occupy: safely under the 1 MiB frame
/// limit with envelope headroom.
const SINGLE_ROW_HARD_CAP_BYTES: usize = 700 * 1024;

/// Approximate serialized-bytes budget for one chat list/messages page —
/// the same measured discipline as every other list family.
const CHAT_PAGE_BYTE_BUDGET: usize = 256 * 1024;

#[derive(Clone)]
struct OpenWorkspace {
    root: PathBuf,
    db_path: PathBuf,
    workspace_id: String,
    actor: ActorHandle,
    /// The autonomous capture driver (files actor + watcher + reconcile
    /// loop), spawned only after the shadow binding succeeded. Shared so the
    /// teardown paths can take it exactly once.
    capture: Arc<Mutex<Option<capture_driver::CaptureDriver>>>,
}

struct YdocSession {
    workspace: WorkspaceHandle,
    key: DocKey,
    path: String,
    content_kind: ContentKind,
    regime: Regime,
    lineage_absent: bool,
    first_update_pending: bool,
    last_settled_sha: Option<String>,
    /// The head sha observed at open — the settle preimage expectation
    /// until the session's first settle replaces it.
    open_head_sha: Option<String>,
    _lease: Lease,
}

#[derive(Clone)]
struct YdocSessionView {
    key: DocKey,
    path: String,
    content_kind: ContentKind,
    regime: Regime,
    lineage_absent: bool,
    first_update_pending: bool,
    open_head_sha: Option<String>,
}

impl OpenWorkspace {
    /// Take the driver and cancel it SYNCHRONOUSLY (no await point, so an
    /// aborted RPC future can never leave a driver un-cancelled), returning
    /// the join handle for callers that must await the full drain.
    fn begin_capture_shutdown(&self) -> Option<tokio::task::JoinHandle<()>> {
        lock(&self.capture)
            .take()
            .and_then(capture_driver::CaptureDriver::begin_shutdown)
    }

    /// Cancel and await the capture driver's full drain (idempotent).
    /// Strictly BEFORE the store-actor close: the driver may be mid-apply
    /// against the actor.
    async fn shutdown_capture(&self) {
        if let Some(task) = self.begin_capture_shutdown() {
            let _ = task.await;
        }
    }
}

/// Protocol service composing domain operations on the runtime actor's sole
/// writable `EngineStore` connection.
pub struct EngineService {
    supervisor: &'static WorkspaceSupervisor,
    handles: Mutex<HashMap<WorkspaceHandle, OpenWorkspace>>,
    open_lock: tokio::sync::Mutex<()>,
    next_handle: std::sync::atomic::AtomicU64,
    sessions: Arc<Mutex<HashMap<String, YdocSession>>>,
    session_ops: Arc<tokio::sync::Mutex<()>>,
    leases: LeaseRegistry,
    next_session: std::sync::atomic::AtomicU64,
    /// Unique per service INSTANCE (process id + construction time):
    /// session ids seed client-side idempotency keys that persist in
    /// `engine_requests`, so ids restarting from 1 each daemon lifetime
    /// would collide a fresh session's first requests with a prior
    /// lifetime's ledger rows (hash-mismatch refusals or false dedupes).
    session_epoch: String,
    self_writes: SelfWriteSuppression,
}

impl Default for EngineService {
    fn default() -> Self {
        Self::new()
    }
}

impl EngineService {
    pub fn new() -> Self {
        Self::with_supervisor(WorkspaceSupervisor::global())
    }

    fn with_supervisor(supervisor: &'static WorkspaceSupervisor) -> Self {
        EngineService {
            supervisor,
            handles: Mutex::new(HashMap::new()),
            open_lock: tokio::sync::Mutex::new(()),
            next_handle: std::sync::atomic::AtomicU64::new(1),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            session_ops: Arc::new(tokio::sync::Mutex::new(())),
            leases: {
                // ONE process-wide registry: the supervisor lets multiple
                // EngineServices open the same workspace root, and per-service
                // registries would hand two transports concurrent live
                // sessions on one DocKey with no mutual exclusion. DocKeys are
                // workspace-scoped, so a global set is collision-safe.
                static GLOBAL_LEASES: std::sync::LazyLock<LeaseRegistry> =
                    std::sync::LazyLock::new(LeaseRegistry::new);
                GLOBAL_LEASES.clone()
            },
            next_session: std::sync::atomic::AtomicU64::new(1),
            session_epoch: {
                // pid + boot-ms + a PROCESS-GLOBAL instance counter: two
                // services constructed in the same millisecond must still
                // mint disjoint session ids (they seed persisted
                // idempotency keys).
                static INSTANCE: std::sync::atomic::AtomicU64 =
                    std::sync::atomic::AtomicU64::new(0);
                let instance = INSTANCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let boot_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_millis())
                    .unwrap_or(0);
                format!("{:x}-{boot_ms:x}-{instance:x}", std::process::id())
            },
            self_writes: {
                // Process-wide for the same reason as the lease registry: a
                // settle through service A must suppress the capture ingest
                // observed by service B's driver on the same root, or B
                // claims the ydoc head as an external capture edit. Keys are
                // (workspace, path), so a global map is collision-safe.
                static GLOBAL_SELF_WRITES: std::sync::LazyLock<SelfWriteSuppression> =
                    std::sync::LazyLock::new(SelfWriteSuppression::default);
                GLOBAL_SELF_WRITES.clone()
            },
        }
    }

    async fn dispatch(&self, ctx: RequestContext, request: Request) -> Result<Response, WireError> {
        let id = request.id;
        let result = match request.method.as_str() {
            "workspace.open" => self.workspace_open(&ctx, request.params).await?,
            "workspace.close" => self.workspace_close(request.workspace).await?,
            "versionedText.write" => {
                self.versioned_text_write(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedBinary.write" => {
                self.versioned_binary_write(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.rename" => {
                self.versioned_text_rename(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.delete" => {
                self.versioned_text_delete(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.rollback" => {
                self.versioned_text_rollback(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.merge" => {
                self.versioned_text_merge(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.compare" => {
                self.versioned_text_compare(&ctx, request.workspace, request.params)
                    .await?
            }
            "versions.compareFiles" => {
                self.versions_compare_files(&ctx, request.workspace, request.params)
                    .await?
            }
            "versions.createNamed" => {
                self.versions_create_named(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.read" => {
                self.versioned_text_read(&ctx, request.workspace, request.params)
                    .await?
            }
            "ydoc.apply" => {
                self.ydoc_apply(&ctx, request.workspace, request.params)
                    .await?
            }
            "ydoc.open" => {
                self.ydoc_open(&ctx, request.workspace, request.params)
                    .await?
            }
            "ydoc.recordUpdate" => {
                self.ydoc_record_update(
                    &ctx,
                    request.workspace,
                    request.idempotency_key.clone(),
                    request.params.clone(),
                )
                .await?
            }
            "ydoc.settle" => {
                self.ydoc_settle(&ctx, request.workspace, request.params)
                    .await?
            }
            "ydoc.applyExternalMarkdownEdit" => {
                self.ydoc_apply_external_markdown_edit(&ctx, request.workspace, request.params)
                    .await?
            }
            "ydoc.close" => {
                self.ydoc_close(&ctx, request.workspace, request.params)
                    .await?
            }
            "ydoc.resync" => {
                self.ydoc_resync(&ctx, request.workspace, request.params)
                    .await?
            }
            "conflicts.list" => {
                self.conflicts_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "conflicts.open" => {
                self.conflicts_open(&ctx, request.workspace, request.params)
                    .await?
            }
            "conflicts.resolve" => {
                self.conflicts_resolve(
                    &ctx,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
                .await?
            }
            "search.query" => {
                self.search_query(&ctx, request.workspace, request.params)
                    .await?
            }
            "search.ensureIndex" => {
                self.search_ensure_index(&ctx, request.workspace, request.params)
                    .await?
            }
            "watcher.status" => self.watcher_status(request.workspace)?,
            "capture.flush" => self.capture_flush(&ctx, request.workspace).await?,
            "versions.active" => {
                self.versions_active(&ctx, request.workspace, request.params)
                    .await?
            }
            "versions.ensureMain" => {
                self.versions_ensure_main(&ctx, request.workspace, request.params)
                    .await?
            }
            "versions.setActive" => {
                self.versions_set_active(&ctx, request.workspace, request.params)
                    .await?
            }
            "versions.list" => {
                self.versions_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "versionedText.list" => {
                self.versioned_text_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "versionedBinary.read" => {
                self.versioned_binary_read(&ctx, request.workspace, request.params)
                    .await?
            }
            "versionedBinary.readBlob" => {
                self.versioned_binary_read_blob(&ctx, request.workspace, request.params)
                    .await?
            }
            "moments.list" => {
                self.moments_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "moments.get" => {
                self.moments_get(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.list" => {
                self.secrets_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.write" => {
                self.secrets_write(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.delete" => {
                self.secrets_delete(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.fork" => {
                self.secrets_fork(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.moments.list" => {
                self.secrets_moments_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.moments.get" => {
                self.secrets_moments_get(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.compare" => {
                self.secrets_compare(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.apply" => {
                self.secrets_apply(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.restore" => {
                self.secrets_restore(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.materialize" => {
                self.secrets_materialize(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.channels.create" => {
                self.chats_channels_create(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.channels.ensureGeneral" => {
                self.chats_channels_ensure_general(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.channels.ensureAgent" => {
                self.chats_channels_ensure_agent(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.channels.list" => {
                self.chats_channels_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.channels.findBySlug" => {
                self.chats_channels_find_by_slug(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.channels.getWireId" => {
                self.chats_channels_get_wire_id(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.threads.start" => {
                self.chats_threads_start(
                    &ctx,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
                .await?
            }
            "chats.threads.list" => {
                self.chats_threads_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.messages.send" => {
                self.chats_messages_send(
                    &ctx,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
                .await?
            }
            "chats.messages.list" => {
                self.chats_messages_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.readState.markThreadRead" => {
                self.chats_read_state_mark_thread_read(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.readState.get" => {
                self.chats_read_state_get(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.follows.set" => {
                self.chats_follows_set(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.follows.list" => {
                self.chats_follows_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.feed.markSeen" => {
                self.chats_feed_mark_seen(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.feed.listPersonal" => {
                self.chats_feed_list_personal(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.save" => {
                self.chats_bookmarks_save(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.list" => {
                self.chats_bookmarks_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.find" => {
                self.chats_bookmarks_find(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.listPending" => {
                self.chats_bookmarks_list_pending(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.markReady" => {
                self.chats_bookmarks_mark_ready(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.archive" => {
                self.chats_bookmarks_archive(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.markFailed" => {
                self.chats_bookmarks_mark_failed(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.markStale" => {
                self.chats_bookmarks_mark_stale(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.enqueue" => {
                self.chats_dispatch_enqueue(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.claimNextPending" => {
                self.chats_dispatch_claim_next_pending(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.complete" => {
                self.chats_dispatch_complete(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.fail" => {
                self.chats_dispatch_fail(&ctx, request.workspace, request.params)
                    .await?
            }
            _ => return Err(wire(ErrorCode::MethodNotFound, "unknown method")),
        };
        Ok(Response { id, result })
    }

    /// Tear down every open workspace's capture driver (watcher joined,
    /// files actor closed). Called at daemon shutdown AFTER the transport's
    /// workspace close hook: store actors are already gone by then, so any
    /// in-flight capture write fails CONTAINED (never acked — the next
    /// daemon start re-offers it from the dirty baseline), and this drain
    /// joins the watcher/files threads so the process exits clean.
    pub async fn shutdown_all_capture(&self) {
        let open: Vec<OpenWorkspace> = lock(&self.handles).values().cloned().collect();
        for workspace in open {
            workspace.shutdown_capture().await;
        }
    }

    async fn workspace_open(
        &self,
        ctx: &RequestContext,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: WorkspaceOpenParams = parse(params)?;
        let cancellation = OperationCancellation::new(ctx);
        let _open_serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("workspace open (queued)"));
            }
            serial = self.open_lock.lock() => serial,
        };
        let validated =
            shadow_fence::validate_shadow_root(PathBuf::from(&params.root_dir).as_path())
                .map_err(map_shadow_fence)?;
        let root = validated.root;
        let existing = {
            let guard = lock(&self.handles);
            guard
                .iter()
                .find(|(_, open)| open.root == root)
                .map(|(handle, open)| (handle.clone(), open.clone()))
        };
        if let Some((handle, open)) = existing {
            // The root's logical binding to a workspace id holds regardless of
            // actor liveness: a different workspace id is always rejected.
            if open.workspace_id != params.workspace_id {
                return Err(wire(
                    ErrorCode::InvalidParams,
                    "workspace root is already bound to another workspace",
                ));
            }
            // Same workspace: short-circuit only on a LIVE binding. A bound-but-
            // closed actor (its worker died) is stale — drop it and reopen fresh.
            if open.actor.lifecycle() != LifecycleState::Closed {
                return Ok(json!({ "workspace": handle }));
            }
            lock(&self.handles).remove(&handle);
            lock(&self.sessions).retain(|_, session| session.workspace != handle);
            // The evicted binding's files layer must not outlive it. Clear
            // suppression only AFTER the shutdown drain — an in-flight
            // reconcile apply still consults the registry.
            open.shutdown_capture().await;
            self.self_writes
                .scoped(&open.root)
                .clear_workspace(&open.workspace_id);
        }
        if lock(&self.handles).len() >= MAX_OPEN_HANDLES {
            return Err(wire(
                ErrorCode::Overloaded,
                "workspace handle limit reached",
            ));
        }
        let db_path = root.join(".dohc").join("engine").join("engine.db");
        let supervisor = self.supervisor;
        let actor_path = db_path.clone();
        let now_ms = now_ms()?;
        let actor_open = tokio::task::spawn_blocking(move || supervisor.open(&actor_path, now_ms))
            .await
            .map_err(|_| wire(ErrorCode::Internal, "workspace open task failed"))?
            .map_err(map_runtime)?;
        let actor = actor_open.actor;
        let binding = actor.bind_shadow_clone(validated.token).await;
        let binding_error = match binding {
            Ok(true) => None,
            Ok(false) => Some(map_shadow_fence(
                shadow_fence::ShadowFenceError::DatabaseTokenMismatch,
            )),
            Err(error) => Some(map_runtime(error)),
        };
        if let Some(error) = binding_error {
            let supervisor = self.supervisor;
            let rejected_path = db_path.clone();
            let _ = tokio::task::spawn_blocking(move || supervisor.close(&rejected_path)).await;
            return Err(error);
        }
        let sequence = self
            .next_handle
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let handle = WorkspaceHandle(format!("ws-{sequence:016x}"));
        // The guard arms BEFORE any fallible await past the shadow binding:
        // an error in the startup replay below must close the actor rather
        // than leak an unowned, handle-less binding in the supervisor.
        let open_guard = OpenGuard {
            supervisor: self.supervisor,
            db_path: Some(db_path.clone()),
        };
        // Startup replay BEFORE the files layer exists: jobs left pending by
        // a crash, a transient settle failure, or a pulled replication apply
        // land on disk while nothing is watching (no suppression window),
        // and the baseline reconcile below then scans the POST-replay disk.
        actor
            .materialize_replay_pending(root.clone(), now_ms)
            .await
            .map_err(map_runtime)?;
        // The files layer spawns ONLY here — after the shadow binding
        // succeeded — so an unmarked or mismatched root can never grow a
        // watcher or files actor (the shadow-scope dormancy invariant).
        let capture = capture_driver::CaptureDriver::spawn(
            root.clone(),
            actor.clone(),
            params.workspace_id.clone(),
            self.self_writes.scoped(&root),
        );
        // STARTUP ORDERING BARRIER: the baseline reconcile (closed-period
        // disk state) must apply before the handle is handed out, or a
        // caller's first write could later be overwritten by a capture of
        // stale disk bytes.
        //
        // CANCELLATION: nothing owns the store actor yet (the handle is
        // inserted below), so an abort here would leak it. The `open_guard`
        // armed above the startup replay closes the actor on an early drop
        // and is disarmed once the handle is inserted; `CaptureDriver`'s own
        // Drop cancels the files layer.
        if actor_open.created_actor {
            // Cancellation-aware like every other actor wait in this flow:
            // a caller abort stops WAITING promptly (the actor still finishes
            // the reclaim it already accepted — it is idempotent on the next
            // open) and the open_guard above closes the actor on early drop.
            Self::read_under_ctx(
                &cancellation,
                "workspace.open (dispatch reclaim)",
                actor.chat_dispatch_reclaim_running(
                    params.workspace_id.clone(),
                    CHAT_DISPATCH_MAX_ATTEMPTS,
                    now_ms,
                ),
            )
            .await?;
        }
        capture.wait_for_baseline().await;
        open_guard.disarm();
        lock(&self.handles).insert(
            handle.clone(),
            OpenWorkspace {
                root,
                db_path,
                workspace_id: params.workspace_id,
                actor,
                capture: Arc::new(Mutex::new(Some(capture))),
            },
        );
        Ok(json!({ "workspace": handle }))
    }

    async fn workspace_close(&self, handle: Option<WorkspaceHandle>) -> Result<Value, WireError> {
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let _session_serial = self.session_ops.lock().await;
        let supervisor = self.supervisor;
        // Hold open_lock only across the handle removal and the synchronous
        // begin_close, so a workspace_open already waiting on `handles` cannot
        // slip in after the removal and reach supervisor.open before the global
        // Closing marker is installed. Once begin_close has marked Closing, the
        // lock is released — the marker (not this lock) serializes reopen, and
        // the detached finish stays cancellation-safe.
        let (closing, removed) = {
            let _serial = self.open_lock.lock().await;
            let db_path = {
                let guard = lock(&self.handles);
                guard
                    .get(&handle)
                    .ok_or_else(workspace_unavailable)?
                    .db_path
                    .clone()
            };
            // Install the GLOBAL Closing marker BEFORE removing the handle, so a
            // workspace_open on another EngineService (which does not take this
            // service's open_lock) observes Closing at supervisor.open and waits
            // for a fresh actor instead of the one being torn down.
            let closing = supervisor.begin_close(&db_path).map_err(map_runtime)?;
            let removed = lock(&self.handles).remove(&handle);
            // Sessions (and their lease guards) evict only AFTER this close
            // owns the teardown — evicting earlier meant a close future
            // dropped while waiting on open_lock had already stranded live
            // editors (ydoc-session-not-found) and released their leases for
            // a workspace that stayed open.
            lock(&self.sessions).retain(|_, session| session.workspace != handle);
            (closing, removed)
        };
        // The capture driver is CANCELLED synchronously here (an aborted close
        // future can never leave it running), and the detached task below owns
        // both the drain and the actor close from the start — so cancellation
        // at ANY await point leaves the #201 backstop semantics intact while
        // the teardown order stays strictly files-then-actor: the driver
        // drains its in-flight apply BEFORE the store actor goes down.
        let capture_drain = removed
            .as_ref()
            .and_then(OpenWorkspace::begin_capture_shutdown);
        let closed = closing.is_some();
        // Suppression entries clear AFTER the capture drain: an in-flight
        // reconcile apply still consults the registry, and clearing first
        // would let it re-ingest the daemon's own just-settled file as a
        // capture write (provenance flip) during teardown.
        let clear_suppression = removed.as_ref().map(|removed| {
            (
                self.self_writes.scoped(&removed.root),
                removed.workspace_id.clone(),
            )
        });
        let close_task = tokio::spawn(async move {
            if let Some(drain) = capture_drain {
                let _ = drain.await;
            }
            if let Some((self_writes, workspace_id)) = clear_suppression {
                self_writes.clear_workspace(&workspace_id);
            }
            tokio::task::spawn_blocking(move || match closing {
                Some(closing) => closing.finish(),
                None => Ok(()),
            })
            .await
        });
        close_task
            .await
            .map_err(|_| wire(ErrorCode::Internal, "workspace close task failed"))?
            .map_err(|_| wire(ErrorCode::Internal, "workspace close task failed"))?
            .map_err(map_runtime)?;
        Ok(json!({ "closed": closed }))
    }

    fn generated_rpc_id(
        &self,
        prefix: &str,
        wire_request_id: u64,
        request_id: Option<&str>,
        path: &str,
    ) -> String {
        let mut digest = Sha256::new();
        let wire_request_id = wire_request_id.to_string();
        let fields: Vec<&[u8]> = match request_id {
            Some(request_id) => vec![request_id.as_bytes(), path.as_bytes()],
            None => vec![
                self.session_epoch.as_bytes(),
                wire_request_id.as_bytes(),
                path.as_bytes(),
            ],
        };
        for field in fields {
            digest.update((field.len() as u64).to_le_bytes());
            digest.update(field);
        }
        format!("{prefix}-{:x}", digest.finalize())
    }

    async fn ensure_path_not_leased(
        &self,
        open: &OpenWorkspace,
        version_id: &str,
        path: &str,
    ) -> Result<(), WireError> {
        let existing = match open
            .actor
            .resolve_path_object(
                open.workspace_id.clone(),
                version_id.to_owned(),
                path.to_owned(),
            )
            .await
        {
            Ok(existing) => existing,
            Err(RuntimeError::Domain(
                DomainError::WorkspaceNotFound | DomainError::VersionNotFound,
            )) => None,
            Err(error) => return Err(map_runtime(error)),
        };
        let object_id = existing.unwrap_or_else(|| {
            dohc_engine_domain::derive_capture_object_id(&open.workspace_id, version_id, path)
        });
        let key = DocKey::new(open.workspace_id.clone(), version_id.to_owned(), object_id)
            .map_err(|_| wire(ErrorCode::InvalidParams, "invalid-input"))?;
        if self.leases.scoped(&open.root).is_held(&key) {
            return Err(wire(ErrorCode::InvalidParams, "ydoc-session-busy"));
        }
        Ok(())
    }

    async fn versioned_text_write(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextWriteParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let path = normalize_rpc_path(&params.path);
        let text = params.text;
        if text.len() > MAX_INBAND_CONTENT_BYTES {
            return Err(wire(ErrorCode::InvalidParams, "content-exceeds-inband-cap"));
        }
        let origin = validated_origin(params.origin.as_deref(), params.metadata_origin.as_deref())?;
        let author_json = validated_author(params.author.as_ref(), params.author_json.as_deref())?;
        self.ensure_path_not_leased(&open, &params.version_id, &path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let object_id = params.object_id.unwrap_or_else(|| {
            self.generated_rpc_id("object", request.id, request_id.as_deref(), &path)
        });
        let moment_id = params.moment_id.unwrap_or_else(|| {
            self.generated_rpc_id("moment", request.id, request_id.as_deref(), &path)
        });
        let cancellation = OperationCancellation::new(ctx);
        let result = open
            .actor
            .versioned_text_write_indexed(
                WriteText {
                    workspace_id: open.workspace_id.clone(),
                    version_id: params.version_id,
                    object_id,
                    path,
                    text,
                    moment_id,
                    request_id,
                    metadata_origin: origin,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                open.root.clone(),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({
            "object": file_object_json(&result.object),
            "snapshot": snapshot_json(&result.snapshot),
            "moment": moment_json(&result.moment),
            "deduped": result.deduped,
        }))
    }

    async fn versioned_binary_write(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedBinaryWriteParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let path = normalize_rpc_path(&params.path);
        let bytes = match (params.bytes, params.bytes_base64) {
            (Some(bytes), None) => bytes,
            (None, Some(encoded)) => base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| wire(ErrorCode::InvalidParams, "invalid-input"))?,
            _ => return Err(wire(ErrorCode::InvalidParams, "invalid-input")),
        };
        if bytes.len() > MAX_INBAND_CONTENT_BYTES {
            return Err(wire(ErrorCode::InvalidParams, "content-exceeds-inband-cap"));
        }
        let origin = validated_origin(params.origin.as_deref(), params.metadata_origin.as_deref())?;
        let author_json = validated_author(params.author.as_ref(), params.author_json.as_deref())?;
        self.ensure_path_not_leased(&open, &params.version_id, &path)
            .await?;
        let object_id = params
            .object_id
            .unwrap_or_else(|| self.generated_rpc_id("object", request.id, None, &path));
        let moment_id = params
            .moment_id
            .unwrap_or_else(|| self.generated_rpc_id("moment", request.id, None, &path));
        let cancellation = OperationCancellation::new(ctx);
        let execution = open
            .actor
            .versioned_binary_write(
                WriteBinary {
                    workspace_id: open.workspace_id.clone(),
                    version_id: params.version_id,
                    object_id,
                    path,
                    bytes,
                    moment_id,
                    metadata_origin: origin,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                open.root,
                Arc::new(self.self_writes.clone()),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        let result = execution.write;
        Ok(json!({
            "object": file_object_json(&result.object),
            "snapshot": {
                "objectId": result.object_id,
                "path": result.path,
                "contentKind": "binary",
                "text": "",
                "sha256": result.sha256,
                "byteLength": result.byte_length,
                "updatedAtMs": result.updated_at_ms,
                "latestMomentId": result.moment.moment_id,
            },
            "moment": moment_json(&result.moment),
            "deduped": result.deduped,
            "materializeEnqueued": result.materialize_enqueued,
            "materialized": execution.materialized,
            "materializeOutcome": materialize_outcome_name(execution.materialize_outcome),
        }))
    }

    async fn versioned_text_rename(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextRenameParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let from_path = normalize_rpc_path(&params.from_path);
        let to_path = normalize_rpc_path(&params.to_path);
        let origin = validated_origin(params.origin.as_deref(), params.metadata_origin.as_deref())?;
        let author_json = validated_author(params.author.as_ref(), params.author_json.as_deref())?;
        self.ensure_path_not_leased(&open, &params.version_id, &from_path)
            .await?;
        self.ensure_path_not_leased(&open, &params.version_id, &to_path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let moment_id =
            self.generated_rpc_id("moment", request.id, request_id.as_deref(), &to_path);
        let cancellation = OperationCancellation::new(ctx);
        let result = open
            .actor
            .versioned_text_rename(
                RenameTextFile {
                    workspace_id: open.workspace_id,
                    version_id: params.version_id,
                    from_path,
                    to_path,
                    moment_id,
                    request_id,
                    metadata_origin: origin,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                open.root,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({
            "object": file_object_json(&result.object),
            "before": snapshot_metadata_json(
                &result.before,
                &result.moment.before_content_kind,
                result.moment.before_binary_sha256.as_deref(),
                result.moment.before_byte_length,
            ),
            "after": snapshot_metadata_json(
                &result.after,
                &result.moment.after_content_kind,
                result.moment.after_binary_sha256.as_deref(),
                result.moment.after_byte_length,
            ),
            "moment": moment_json(&result.moment),
            "deduped": result.deduped,
        }))
    }

    async fn versioned_text_delete(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextDeleteParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let path = normalize_rpc_path(&params.path);
        let origin = validated_origin(params.origin.as_deref(), params.metadata_origin.as_deref())?;
        let author_json = validated_author(params.author.as_ref(), params.author_json.as_deref())?;
        self.ensure_path_not_leased(&open, &params.version_id, &path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let moment_id = self.generated_rpc_id("moment", request.id, request_id.as_deref(), &path);
        let cancellation = OperationCancellation::new(ctx);
        let result = open
            .actor
            .versioned_text_delete(
                DeleteTextFile {
                    workspace_id: open.workspace_id,
                    version_id: params.version_id,
                    path,
                    moment_id,
                    request_id,
                    metadata_origin: origin,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                open.root,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({
            "object": file_object_json(&result.object),
            "before": snapshot_metadata_json(
                &result.before,
                &result.moment.before_content_kind,
                result.moment.before_binary_sha256.as_deref(),
                result.moment.before_byte_length,
            ),
            "moment": moment_json(&result.moment),
            "deduped": result.deduped,
        }))
    }

    async fn versioned_text_rollback(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextRollbackParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let path = normalize_rpc_path(&params.path);
        let origin = validated_origin(params.origin.as_deref(), params.metadata_origin.as_deref())?;
        let author_json = validated_author(params.author.as_ref(), params.author_json.as_deref())?;
        self.ensure_path_not_leased(&open, &params.version_id, &path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let cancellation = OperationCancellation::new(ctx);
        let result = open
            .actor
            .versioned_text_rollback(
                RollbackTextFileMutation {
                    workspace_id: open.workspace_id,
                    version_id: params.version_id,
                    path,
                    mutation_moment_id: params.mutation_moment_id,
                    request_id,
                    legacy_before_text: params.legacy_before_text,
                    metadata_origin: origin,
                    author_json,
                },
                open.root,
                Arc::new(self.self_writes.clone()),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({
            "rolledBack": true,
            "deduped": result.deduped,
            "materializeEnqueued": result.materialize_enqueued,
            "materialized": result.materialized,
            "materializeOutcome": materialize_outcome_name(result.materialize_outcome),
        }))
    }

    async fn versioned_text_compare(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextCompareParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let comparison = Self::read_under_ctx(
            &cancellation,
            "versionedText.compare",
            open.actor.versioned_text_compare(CompareTextFileVersions {
                workspace_id: open.workspace_id,
                target_version_id: params.target_version_id,
                source_version_id: params.source_version_id,
                path: normalize_rpc_path(&params.path),
            }),
        )
        .await?;
        Ok(json!({ "status": comparison_wire_status(&comparison) }))
    }

    async fn versioned_text_merge(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextMergeParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let path = normalize_rpc_path(&params.path);
        let origin = validated_origin(params.origin.as_deref(), params.metadata_origin.as_deref())?;
        let author_json = validated_author(params.author.as_ref(), params.author_json.as_deref())?;
        self.ensure_path_not_leased(&open, &params.target_version_id, &path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let object_id = self.generated_rpc_id("object", request.id, request_id.as_deref(), &path);
        let moment_id = self.generated_rpc_id("moment", request.id, request_id.as_deref(), &path);
        let conflict_id =
            self.generated_rpc_id("conflict", request.id, request_id.as_deref(), &path);
        let cancellation = OperationCancellation::new(ctx);
        let result = open
            .actor
            .versioned_text_merge(
                MergeTextFileFromVersion {
                    workspace_id: open.workspace_id,
                    target_version_id: params.target_version_id,
                    source_version_id: params.source_version_id,
                    path,
                    object_id,
                    moment_id,
                    request_id,
                    conflict_id,
                    metadata_origin: origin,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                open.root,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(match result {
            MergeTextFileResult::Unchanged { deduped, .. } => json!({
                "status": "unchanged",
                "deduped": deduped,
            }),
            MergeTextFileResult::Write { write, .. } => json!({
                "status": "merged",
                "writeKind": "write",
                "object": file_object_json(&write.object),
                "snapshot": snapshot_metadata_json(&write.snapshot, "text", None, None),
                "moment": moment_json(&write.moment),
                "deduped": write.deduped,
            }),
            MergeTextFileResult::Delete { delete, .. } => json!({
                "status": "merged",
                "writeKind": "delete",
                "object": file_object_json(&delete.object),
                "moment": moment_json(&delete.moment),
                "deduped": delete.deduped,
            }),
            MergeTextFileResult::Conflict { deduped, .. } => json!({
                "status": "conflict",
                "deduped": deduped,
            }),
        })
    }

    async fn versions_create_named(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionsCreateNamedParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let new_version_id = self.generated_rpc_id(
            "version",
            request.id,
            request.idempotency_key.as_deref(),
            &params.name,
        );
        let cancellation = OperationCancellation::new(ctx);
        let version = open
            .actor
            .create_named_version(
                CreateNamedVersion {
                    workspace_id: open.workspace_id,
                    new_version_id,
                    name: params.name,
                    from_version_id: params.from_version_id,
                    now_ms: now_ms()?,
                    request_id: request.idempotency_key.clone(),
                },
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(version_record_json(&version))
    }

    async fn versions_compare_files(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionsCompareFilesParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "versions.compareFiles",
            open.actor.compare_version_files_page(
                open.workspace_id,
                params.source_version_id,
                params.target_version_id,
                params.after_path,
                200,
            ),
        )
        .await?;
        let entries: Vec<Value> = page
            .entries
            .iter()
            .map(|change| {
                let status = match change.status {
                    VersionFileChangeStatus::Added => "added",
                    VersionFileChangeStatus::Modified => "modified",
                    VersionFileChangeStatus::Deleted => "deleted",
                };
                if change.binary {
                    json!({ "path": change.path, "status": status, "binary": true })
                } else {
                    json!({ "path": change.path, "status": status })
                }
            })
            .collect();
        let budget = params
            .byte_budget
            .unwrap_or(MOMENTS_PAGE_BYTE_BUDGET)
            .clamp(1, SINGLE_ROW_HARD_CAP_BYTES);
        let included = byte_budget_cut_serialized(&entries, budget);
        if included == 0 && !entries.is_empty() {
            return Err(wire(ErrorCode::InvalidParams, "invalid-input"));
        }
        let byte_truncated = included < entries.len();
        let next_cursor = if byte_truncated {
            entries[included - 1]["path"].as_str().map(str::to_owned)
        } else {
            page.next_after_path
        };
        Ok(json!({
            "entries": entries[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    async fn versioned_text_read(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextReadParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        // ONE actor turn decides the in-band cap: an over-cap body never
        // leaves SQLite, and no concurrent write can grow the body between
        // a size probe and the load (there is no probe).
        let snapshot = Self::read_under_ctx(
            &cancellation,
            "versionedText.read",
            open.actor.read_text_inband(
                open.workspace_id,
                params.version_id,
                params.path,
                MAX_INBAND_CONTENT_BYTES,
            ),
        )
        .await?;
        Ok(match snapshot {
            None => Value::Null,
            Some(snapshot) => {
                let over_cap = snapshot.content_kind == "text" && snapshot.text.is_none();
                let mut body = json!({
                    "workspaceId": snapshot.workspace_id,
                    "versionId": snapshot.version_id,
                    "objectId": snapshot.object_id,
                    "path": snapshot.path,
                    "contentKind": snapshot.content_kind,
                    "text": snapshot.text,
                    "byteLength": snapshot.byte_length,
                    "blobSha256": snapshot.blob_sha256,
                    "sha256": snapshot.blob_sha256,
                    "updatedAtMs": snapshot.updated_at_ms,
                    "latestMomentId": snapshot.latest_moment_id,
                    "metadataOrigin": snapshot.metadata_origin
                });
                if over_cap {
                    body["inbandLimitBytes"] = json!(MAX_INBAND_CONTENT_BYTES);
                }
                body
            }
        })
    }

    /// The capture driver's observable health: whether the files layer is
    /// up (`running`), whether anything since the last fully clean tick went
    /// wrong (`degraded`), and whether the restart streak has escalated past
    /// recovery-on-its-own-timescale (`terminal`).
    fn watcher_status(&self, handle: Option<WorkspaceHandle>) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        let guard = lock(&open.capture);
        Ok(match guard.as_ref() {
            Some(driver) => {
                // ONE snapshot — the three flags must come from the same
                // atomic load, or a reader racing a transition could report
                // running && terminal.
                let snapshot = driver.status().snapshot();
                json!({
                    "running": snapshot.running,
                    "degraded": snapshot.degraded,
                    "terminal": snapshot.terminal,
                })
            }
            // The driver is only absent mid-teardown; report an honest
            // "down" rather than erroring a racing status poll.
            None => json!({ "running": false, "degraded": true, "terminal": false }),
        })
    }

    /// Drive capture to quiescence and report what was achieved. THE
    /// determinism seam for the capture differential: without it a harness
    /// can only sleep and hope, which turns timing blips into parity
    /// failures. Quiescence covers every change the WATCHER has noticed — a
    /// write still inside the OS debounce is invisible to flush too; callers
    /// needing a specific write poll for it (flush + check), which the
    /// differential does. `settled: false` is an honest answer (layer down, teardown
    /// race, or a workspace under continuous mutation hitting the cycle
    /// bound) — callers must treat it as "state not comparable", never as
    /// "clean".
    async fn capture_flush(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        // Clone the sender OUT of the lock and await OUTSIDE it: a flush can
        // legitimately take many reconcile cycles, and the workspace table
        // must not be blocked for its duration.
        let sender = lock(&open.capture)
            .as_ref()
            .map(capture_driver::CaptureDriver::flush_sender);
        let unavailable = json!({ "settled": false, "running": false, "degraded": true });
        let Some(sender) = sender else {
            return Ok(unavailable);
        };
        // A flush can drive up to MAX_FLUSH_CYCLES reconciles or sit behind
        // a full flush queue — a cancelled/deadlined caller must get its
        // answer NOW, like every other workspace RPC. The driver still
        // finishes its pass; only the wait is abandoned (the reply send
        // fails harmlessly).
        let cancellation = OperationCancellation::new(ctx);
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("capture.flush (queued)"));
            }
            sent = sender.send(reply_tx) => {
                if sent.is_err() {
                    return Ok(unavailable);
                }
            }
        }
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                Err(cancellation.interruption("capture.flush"))
            }
            outcome = reply_rx => match outcome {
                Ok(outcome) => Ok(json!({
                    "settled": outcome.settled,
                    "running": outcome.running,
                    "degraded": outcome.degraded,
                })),
                Err(_) => Ok(unavailable),
            }
        }
    }

    /// Await an actor read under the request's cancellation/deadline — the
    /// wait is abandoned (the actor's work completes and is discarded),
    /// the same shape capture.flush uses. Read commands carry no token, so
    /// abandoning the wait IS the cancellation semantics.
    async fn read_under_ctx<T>(
        cancellation: &OperationCancellation,
        what: &str,
        read: impl std::future::Future<Output = Result<T, RuntimeError>>,
    ) -> Result<T, WireError> {
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => Err(cancellation.interruption(what)),
            result = read => result.map_err(map_runtime),
        }
    }

    async fn versions_active(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: WorkspaceOnlyParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let version = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("versions.active"));
            }
            result = open.actor.active_version(open.workspace_id) => match result {
                Ok(version) => version,
                Err(RuntimeError::Domain(DomainError::WorkspaceNotFound)) => return Ok(Value::Null),
                Err(error) => return Err(map_runtime(error)),
            },
        };
        Ok(version_record_json(&version))
    }

    async fn versions_ensure_main(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: WorkspaceOnlyParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let version = open
            .actor
            .ensure_main_version(
                open.workspace_id,
                now_ms()?,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(version_record_json(&version))
    }

    async fn versions_set_active(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionsSetActiveParams = parse(params)?;
        if params.version_id.is_empty() || params.version_id.trim() != params.version_id {
            return Err(wire(ErrorCode::InvalidParams, "invalid-version"));
        }
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let version = open
            .actor
            .set_active_version(
                open.workspace_id,
                params.version_id,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(version_record_json(&version))
    }

    async fn versions_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionsListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let mut versions = Self::read_under_ctx(
            &cancellation,
            "versions.list",
            open.actor.list_versions(open.workspace_id),
        )
        .await?;
        // Keyset resume over the domain's stable ordering: the composite
        // sort key makes a SQL cursor awkward, and version counts are
        // small — resuming positionally over the loaded ordered vector is
        // exact (the id either exists at one position or the cursor is
        // stale and reads from the start).
        if let Some(after) = params.after_version_id.as_deref() {
            if let Some(position) = versions
                .iter()
                .position(|version| version.version_id == after)
            {
                versions.drain(..=position);
            }
        }
        // Versions are few in practice, but the frame limit does not care
        // about practice: same measured budget + honest truncated flag as
        // every other list family.
        let row_values: Vec<Value> = versions
            .iter()
            .map(|version| {
                json!({
                    "versionId": version.version_id,
                    "kind": version.kind.as_str(),
                    "name": version.name,
                    "createdAtMs": version.created_at_ms,
                    "forkVersionId": version.fork_version_id,
                    "forkMomentId": version.fork_moment_id,
                })
            })
            .collect();
        let included = byte_budget_cut_serialized(&row_values, MOMENTS_PAGE_BYTE_BUDGET);
        if included == 0 && !row_values.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        let truncated = included < row_values.len();
        let next_after_version_id = truncated
            .then(|| versions[..included].last().map(|v| v.version_id.clone()))
            .flatten();
        Ok(json!({
            "versions": row_values[..included].to_vec(),
            "nextAfterVersionId": next_after_version_id,
        }))
    }

    async fn versioned_text_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        // METADATA ONLY, PAGED: bodies come one path at a time via
        // versionedText.read (aggregated bodies trivially exceed the 1 MiB
        // frame limit), and even metadata rows are paged so a large
        // workspace cannot exceed it either. The +1 row probes for more.
        let limit = params.limit.unwrap_or(200).clamp(1, 500);
        let mut rows = Self::read_under_ctx(
            &cancellation,
            "versionedText.list",
            open.actor.list_snapshot_metadata(
                open.workspace_id.clone(),
                params.version_id.clone(),
                params.after_path.clone(),
                limit + 1,
            ),
        )
        .await?;
        // An unknown version must REFUSE, never read as empty — on EVERY
        // page: a stale cursor plus a typo'd version would otherwise read
        // as "exhausted". A legitimately-empty tail page for a real
        // version pays one extra membership read; correctness wins.
        if rows.is_empty() {
            let versions = Self::read_under_ctx(
                &cancellation,
                "versionedText.list",
                open.actor.list_versions(open.workspace_id),
            )
            .await?;
            if !versions
                .iter()
                .any(|version| version.version_id == params.version_id)
            {
                return Err(wire(ErrorCode::InvalidParams, "version not found"));
            }
        }
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        // Metadata rows can still be string-heavy (paths/origins are
        // wire-legal up to 64 KiB): the byte budget cuts the page under
        // the frame limit; the cursor resumes at the cut.
        let row_values: Vec<Value> = rows
            .iter()
            .map(|row| {
                json!({
                    "path": row.path,
                    "objectId": row.object_id,
                    "contentKind": row.content_kind,
                    "byteLength": row.text_byte_length,
                    "binarySha256": row.binary_sha256,
                    "updatedAtMs": row.updated_at_ms,
                    "latestMomentId": row.latest_moment_id,
                    "metadataOrigin": row.metadata_origin,
                })
            })
            .collect();
        let byte_cut = byte_budget_cut_serialized(&row_values, MOMENTS_PAGE_BYTE_BUDGET);
        if byte_cut == 0 && !row_values.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        let byte_truncated = byte_cut < rows.len();
        let next_after_path = (has_more || byte_truncated)
            .then(|| rows[..byte_cut].last().map(|row| row.path.clone()))
            .flatten();
        Ok(json!({
            "files": row_values[..byte_cut].to_vec(),
            "nextAfterPath": next_after_path,
        }))
    }

    async fn versioned_binary_read(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionPathParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        // ONE actor turn: the cap is decided in the query, so a replaced
        // head can never smuggle an over-cap blob into memory, and the
        // recorded length is integrity-checked against the stored bytes.
        let head = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("versionedBinary.read"));
            }
            result = open.actor.read_binary_inband(
                open.workspace_id,
                params.version_id,
                params.path,
                MAX_INBAND_CONTENT_BYTES,
            ) => match result {
                Ok(head) => head,
                Err(RuntimeError::Domain(DomainError::TextHeadNotBinary)) => return Ok(Value::Null),
                Err(error) => return Err(map_runtime(error)),
            },
        };
        Ok(match head {
            None => Value::Null,
            Some(head) => match head.bytes {
                Some(bytes) => json!({
                    "objectId": head.object_id,
                    "sha256": head.sha256,
                    "byteLength": head.byte_length,
                    "bytesBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                }),
                None => json!({
                    "objectId": head.object_id,
                    "sha256": head.sha256,
                    "byteLength": head.byte_length,
                    "bytesBase64": Value::Null,
                    "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
                }),
            },
        })
    }

    async fn versioned_binary_read_blob(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedBinaryReadBlobParams = parse(params)?;
        if params.sha256.len() != 64 || !params.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(wire(ErrorCode::InvalidParams, "invalid-input"));
        }
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let bytes = Self::read_under_ctx(
            &cancellation,
            "versionedBinary.readBlob",
            open.actor.read_binary_blob(params.sha256),
        )
        .await?
        .ok_or_else(|| wire(ErrorCode::InvalidParams, "file-not-found"))?;
        let byte_length = bytes.len();
        Ok(if byte_length <= MAX_INBAND_CONTENT_BYTES {
            json!({
                "bytesBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            })
        } else {
            json!({
                "bytesBase64": Value::Null,
                "byteLength": byte_length,
                "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
            })
        })
    }

    async fn moments_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: MomentsListParams = parse(params)?;
        // The filter rejects ONLY what the write path can never store
        // (the empty string): every id versionedText.list or
        // moments.list can return — whitespace/control-carrying
        // included — must stay filterable verbatim.
        if params.object_id.as_deref() == Some("") {
            return Err(wire(ErrorCode::InvalidParams, "objectId must not be empty"));
        }
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "moments.list",
            open.actor
                .list_moments(dohc_engine_domain::ListMomentsQuery {
                    workspace_id: open.workspace_id,
                    version_id: params.version_id,
                    object_id: params.object_id,
                    // Clamped: an unbounded page would load a workspace's whole
                    // history in one actor turn and then fail the wire's
                    // collection cap at encode anyway.
                    // TS normalizeMomentListLimit contract: default 200, cap 500
                    // — page boundaries and cursors must match across engines.
                    limit: params.limit.unwrap_or(200).min(500),
                    before_moment_order: params.before_moment_order,
                }),
        )
        .await?;
        // A row COUNT cannot bound the frame: authorJson alone may be a
        // 64 KiB string. Cut the page when the running size estimate would
        // pass the budget (at least one row always ships — a single row
        // fits by construction, every string being wire-capped).
        let mut rows: Vec<Value> = page.moments.iter().map(moment_json).collect();
        // A single row can legitimately exceed the page budget (several
        // wire-legal strings plus escaping). The page must still make
        // progress: degrade THAT row to metadata (texts nulled — their
        // byte lengths remain) rather than ship an over-frame page or
        // dead-end the cursor.
        if let Some(first) = rows.first_mut() {
            if serde_json::to_string(first).map_or(0, |s| s.len()) > MOMENTS_PAGE_BYTE_BUDGET {
                first["afterText"] = Value::Null;
                first["beforeText"] = Value::Null;
                first["afterInbandLimitBytes"] = json!(MAX_INBAND_CONTENT_BYTES);
                first["beforeInbandLimitBytes"] = json!(MAX_INBAND_CONTENT_BYTES);
            }
        }
        let included = byte_budget_cut_serialized(&rows, MOMENTS_PAGE_BYTE_BUDGET);
        if included == 0 && !rows.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a moment row exceeds the response frame budget",
            ));
        }
        let truncated = included < rows.len();
        let next_before = if truncated {
            page.moments[..included]
                .last()
                .map(|moment| moment.moment_order)
        } else {
            page.next_before_moment_order
        };
        Ok(json!({
            "moments": rows[..included].to_vec(),
            "nextBeforeMomentOrder": next_before,
            // The TS contract's numeric sentinel: -1 for an empty timeline,
            // never null (numeric comparisons drive polling/cursor state).
            "latestMomentOrder": page.latest_moment_order.unwrap_or(-1),
        }))
    }

    async fn moments_get(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: MomentsGetParams = parse(params)?;
        // Reject ONLY what the write path can never store (the empty
        // string): all-whitespace ids ARE storable and moments.list
        // returns them verbatim — they must stay fetchable verbatim.
        if params.moment_id.is_empty() {
            return Err(wire(ErrorCode::InvalidParams, "momentId must not be empty"));
        }
        let moment_id = params.moment_id;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let moment = Self::read_under_ctx(
            &cancellation,
            "moments.get",
            open.actor.get_moment(open.workspace_id, moment_id),
        )
        .await?;
        Ok(match moment {
            None => Value::Null,
            Some(moment) => moment_json(&moment),
        })
    }

    async fn secrets_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        // Paged at the DOMAIN (keyset by path): a many-secret workspace
        // never loads every tip per request just for the RPC to discard
        // the overflow.
        let limit = params.limit.unwrap_or(200).clamp(1, 500);
        let secrets = Self::read_under_ctx(
            &cancellation,
            "secrets.list",
            open.actor.list_secret_files_page(
                open.workspace_id,
                params.version_id,
                params.after_path.clone(),
                limit + 1,
            ),
        )
        .await?;
        let has_more = secrets.len() > limit;
        let secrets = &secrets[..secrets.len().min(limit)];
        // Metadata-only AND keyset-paged (afterPath/nextAfterPath); the
        // byte budget is the second bound so no page can outgrow the
        // frame even when rows are string-heavy.
        let row_values: Vec<Value> = secrets
            .iter()
            .map(|stat| {
                json!({
                    "path": stat.path,
                    "byteLength": stat.byte_length,
                    "updatedAtMs": stat.updated_at_ms,
                    "latestMomentId": stat.latest_moment_id,
                })
            })
            .collect();
        let included = byte_budget_cut_serialized(&row_values, MOMENTS_PAGE_BYTE_BUDGET);
        if included == 0 && !row_values.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        let byte_truncated = included < row_values.len();
        let next_after_path = (has_more || byte_truncated)
            .then(|| secrets[..included].last().map(|stat| stat.path.clone()))
            .flatten();
        Ok(json!({
            "secrets": row_values[..included].to_vec(),
            "nextAfterPath": next_after_path,
        }))
    }

    async fn load_or_create_secret_key(
        &self,
        cancellation: &OperationCancellation,
        open: &OpenWorkspace,
        operation: &'static str,
    ) -> Result<dohc_engine_crypto::SecretDataKey, WireError> {
        let key_root = open.root.clone();
        let key_task =
            tokio::task::spawn_blocking(move || dohc_engine_crypto::load_key_file(&key_root));
        let loaded = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption(operation));
            }
            loaded = key_task => loaded
                .map_err(|_| wire(ErrorCode::Internal, "key-corrupt"))?
                .map_err(|error| map_runtime(RuntimeError::Domain(DomainError::Crypto(error))))?,
        };
        if let Some(key) = loaded {
            return Ok(key);
        }

        let has_state = Self::read_under_ctx(
            cancellation,
            operation,
            open.actor.secret_state_exists(open.workspace_id.clone()),
        )
        .await?;
        if has_state {
            return Err(wire(ErrorCode::Internal, "key-corrupt"));
        }

        let key_root = open.root.clone();
        let key_task =
            tokio::task::spawn_blocking(move || dohc_engine_crypto::create_key_file(&key_root));
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => Err(cancellation.interruption(operation)),
            created = key_task => created
                .map_err(|_| wire(ErrorCode::Internal, "key-corrupt"))?
                .map_err(|error| map_runtime(RuntimeError::Domain(DomainError::Crypto(error)))),
        }
    }

    async fn secrets_write(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsWriteParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let path = normalize_rpc_path(&params.path);
        let text = params.text;
        if text.len() > MAX_INBAND_CONTENT_BYTES {
            return Err(wire(ErrorCode::InvalidParams, "content-exceeds-inband-cap"));
        }
        let origin = validated_origin(Some(&params.origin), None)?;
        let cancellation = OperationCancellation::new(ctx);
        // Prove the version reference and secret-floor routing keylessly before
        // any key-file load/mint. Invalid calls must remain side-effect-free.
        Self::read_under_ctx(
            &cancellation,
            "secrets.write (validate)",
            open.actor.secret_file_len(
                open.workspace_id.clone(),
                params.version_id.clone(),
                path.clone(),
            ),
        )
        .await?;
        let key = self
            .load_or_create_secret_key(&cancellation, &open, "secrets.write (key load)")
            .await?;
        let result = open
            .actor
            .write_secret_file(
                SecretWrite {
                    workspace_id: open.workspace_id,
                    version_id: params.version_id,
                    path,
                    text,
                    moment_id: params.moment_id,
                    metadata_origin: origin,
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: now_ms()?,
                    disk_intent: SecretDiskIntent::Materialize,
                },
                key,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({
            "changed": result.changed,
            "moment": result.moment.as_ref().map(secret_moment_json),
        }))
    }

    async fn secrets_delete(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsDeleteParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let path = normalize_rpc_path(&params.path);
        let origin = validated_origin(Some(&params.origin), None)?;
        let cancellation = OperationCancellation::new(ctx);
        let moment = open
            .actor
            .delete_secret_file(
                SecretDelete {
                    workspace_id: open.workspace_id,
                    version_id: params.version_id,
                    path,
                    moment_id: params.moment_id,
                    metadata_origin: origin,
                    metadata_summary: None,
                    now_ms: now_ms()?,
                },
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({ "moment": moment.as_ref().map(secret_moment_json) }))
    }

    async fn secrets_fork(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsForkParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        open.actor
            .fork_secret_version(
                open.workspace_id,
                params.from_version_id,
                params.to_version_id,
                now_ms()?,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({}))
    }

    async fn secrets_moments_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsMomentsListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let path = normalize_rpc_path(&params.path);
        let cancellation = OperationCancellation::new(ctx);
        let limit = params.limit.unwrap_or(200).clamp(1, 500);
        let mut page = Self::read_under_ctx(
            &cancellation,
            "secrets.moments.list",
            open.actor.list_secret_moments(
                open.workspace_id,
                params.version_id,
                path,
                params.before_moment_order,
                limit,
            ),
        )
        .await?;
        let rows: Vec<Value> = page.moments.iter().map(secret_moment_json).collect();
        let included = byte_budget_cut_serialized(&rows, MOMENTS_PAGE_BYTE_BUDGET);
        if included == 0 && !rows.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        if included < rows.len() {
            page.next_before_moment_order = page.moments[..included]
                .last()
                .map(|moment| moment.moment_order);
        }
        Ok(json!({
            "moments": rows[..included].to_vec(),
            "nextBeforeMomentOrder": page.next_before_moment_order,
        }))
    }

    async fn secrets_moments_get(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsMomentsGetParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let moment = Self::read_under_ctx(
            &cancellation,
            "secrets.moments.get",
            open.actor
                .get_secret_moment(open.workspace_id, params.moment_id),
        )
        .await?;
        Ok(moment.as_ref().map_or(Value::Null, secret_moment_json))
    }

    async fn secrets_compare(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsCompareParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        // Validate both version references before key state can affect error
        // precedence. These one-row keyless probes never hydrate ciphertext.
        Self::read_under_ctx(
            &cancellation,
            "secrets.compare (source version)",
            open.actor.list_secret_files_page(
                open.workspace_id.clone(),
                params.source_version_id.clone(),
                None,
                1,
            ),
        )
        .await?;
        Self::read_under_ctx(
            &cancellation,
            "secrets.compare (target version)",
            open.actor.list_secret_files_page(
                open.workspace_id.clone(),
                params.target_version_id.clone(),
                None,
                1,
            ),
        )
        .await?;
        let has_state = Self::read_under_ctx(
            &cancellation,
            "secrets.compare",
            open.actor.secret_state_exists(open.workspace_id.clone()),
        )
        .await?;
        let key = if has_state {
            let key_root = open.root.clone();
            let key_task =
                tokio::task::spawn_blocking(move || dohc_engine_crypto::load_key_file(&key_root));
            let loaded = tokio::select! {
                biased;
                () = cancellation.token.cancelled() => {
                    return Err(cancellation.interruption("secrets.compare (key load)"));
                }
                loaded = key_task => loaded
                    .map_err(|_| wire(ErrorCode::Internal, "key-corrupt"))?
                    .map_err(|error| map_runtime(RuntimeError::Domain(DomainError::Crypto(error))))?,
            };
            Some(loaded.ok_or_else(|| wire(ErrorCode::Internal, "key-corrupt"))?)
        } else {
            None
        };
        let limit = params.limit.unwrap_or(200).clamp(1, 500);
        let page = Self::read_under_ctx(
            &cancellation,
            "secrets.compare",
            open.actor.compare_secret_files(
                open.workspace_id,
                params.source_version_id,
                params.target_version_id,
                params.after_path,
                limit,
                key,
            ),
        )
        .await?;
        let rows: Vec<Value> = page
            .entries
            .iter()
            .map(|entry| {
                json!({
                    "path": entry.path,
                    "status": match entry.status {
                        VersionFileChangeStatus::Added => "added",
                        VersionFileChangeStatus::Modified => "modified",
                        VersionFileChangeStatus::Deleted => "deleted",
                    },
                })
            })
            .collect();
        let included = byte_budget_cut_serialized(&rows, MOMENTS_PAGE_BYTE_BUDGET);
        if included == 0 && !rows.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        let byte_truncated = included < rows.len();
        let next_after_path = if byte_truncated {
            page.entries[..included]
                .last()
                .map(|entry| entry.path.clone())
        } else {
            page.next_after_path
        };
        Ok(json!({
            "entries": rows[..included].to_vec(),
            "nextAfterPath": next_after_path,
        }))
    }

    async fn secrets_apply(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsApplyParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let path = normalize_rpc_path(&params.path);
        let cancellation = OperationCancellation::new(ctx);
        let active = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("secrets.apply (active version)"));
            }
            result = open.actor.active_version(open.workspace_id.clone()) => match result {
                Ok(version) => version,
                Err(RuntimeError::Domain(DomainError::WorkspaceNotFound)) => {
                    return Err(wire(ErrorCode::Internal, "state-corrupt"));
                }
                Err(error) => return Err(map_runtime(error)),
            },
        };
        Self::read_under_ctx(
            &cancellation,
            "secrets.apply (source version)",
            open.actor.list_secret_files_page(
                open.workspace_id.clone(),
                params.from_version_id.clone(),
                None,
                1,
            ),
        )
        .await?;
        let key_root = open.root.clone();
        let key_task =
            tokio::task::spawn_blocking(move || dohc_engine_crypto::load_key_file(&key_root));
        let key = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("secrets.apply (key load)"));
            }
            loaded = key_task => loaded
                .map_err(|_| wire(ErrorCode::Internal, "key-corrupt"))?
                .map_err(|error| map_runtime(RuntimeError::Domain(DomainError::Crypto(error))))?,
        };
        let Some(key) = key else {
            let has_state = Self::read_under_ctx(
                &cancellation,
                "secrets.apply (key state)",
                open.actor.secret_state_exists(open.workspace_id.clone()),
            )
            .await?;
            if has_state {
                return Err(wire(ErrorCode::Internal, "key-corrupt"));
            }
            return Ok(json!({ "changed": false, "moment": Value::Null }));
        };
        let result = open
            .actor
            .apply_secret_file(
                open.workspace_id,
                path,
                params.from_version_id,
                active.version_id,
                params.moment_id,
                now_ms()?,
                key,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({
            "changed": result.changed,
            "moment": result.moment.as_ref().map(secret_moment_json),
        }))
    }

    async fn secrets_restore(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SecretsRestoreParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let path = normalize_rpc_path(&params.path);
        let cancellation = OperationCancellation::new(ctx);
        let result = open
            .actor
            .restore_secret_file(
                open.workspace_id,
                path,
                params.before_moment_id,
                params.moment_id,
                now_ms()?,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({
            "restored": result.restored,
            "restoredMomentId": result.restored_moment_id,
            "path": result.path,
        }))
    }

    /// THE single authorized plaintext accessor over RPC (TS parity:
    /// `materializeSecretFile`). The key is loaded from the workspace root
    /// per call — the daemon holds no key custody — and a missing key with
    /// live secret state fails closed rather than returning nothing.
    async fn secrets_materialize(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionPathParams = parse(params)?;
        // Normalize ONCE and use the normalized spelling everywhere: the
        // policy stable-decodes percent disguises (%2eenv classifies as
        // .env), and querying with the raw spelling would answer "absent
        // secret" for a real one. This also runs the fail-closed secret
        // gate up front, before ANY state-dependent branch, so the error
        // surface is identical across key states.
        if dohc_engine_files::policy::classify_engine_file_path(&params.path)
            != dohc_engine_files::policy::PathClassification::Secret
        {
            return Err(wire(ErrorCode::InvalidParams, "not a secret path"));
        }
        // QUERY VERBATIM: the domain stores the spelling the write
        // carried, and a path secrets.list returns must materialize
        // verbatim — rewriting to the normalized spelling would orphan
        // stored tips (the classification above still uses it, so the
        // gate is disguise-proof).
        let secret_path = params.path.clone();
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        // PRECEDENCE stat (keyless): validates the secret path and the
        // version BEFORE any key work, so caller mistakes error
        // identically regardless of local key-file state — and an ABSENT
        // secret answers null right here: no key material is needed to
        // say "nothing stored", and a stale malformed key file must not
        // turn that answer into an error. The in-band cap itself is
        // decided later, inside the decrypting actor turn.
        let stat = Self::read_under_ctx(
            &cancellation,
            "secrets.materialize",
            open.actor.secret_file_len(
                open.workspace_id.clone(),
                params.version_id.clone(),
                secret_path.clone(),
            ),
        )
        .await?;
        if stat.is_none() {
            return Ok(Value::Null);
        }
        // Blocking filesystem work stays off the tokio worker — and the
        // WAIT for it is cancellation/deadline-raced like every other
        // await on this surface (the blocking task finishes on its own;
        // only the caller's wait abandons).
        let key_root = open.root.clone();
        let key_task =
            tokio::task::spawn_blocking(move || dohc_engine_crypto::load_key_file(&key_root));
        let key = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("secrets.materialize (key load)"));
            }
            loaded = key_task => loaded
                .map_err(|_| wire(ErrorCode::Internal, "secret key unavailable"))?
                .map_err(|_| wire(ErrorCode::Internal, "secret key unavailable"))?,
        };
        let Some(key) = key else {
            // Path and version already validated above (gate + stat).
            // The state check: a workspace that never minted a key has no
            // secrets; one WITH secret rows and no key is
            // corrupt/misrestored state and fails closed.
            let has_state = Self::read_under_ctx(
                &cancellation,
                "secrets.materialize",
                open.actor.secret_state_exists(open.workspace_id.clone()),
            )
            .await?;
            if has_state {
                return Err(wire(ErrorCode::Internal, "secret key unavailable"));
            }
            return Ok(Value::Null);
        };
        // Key present and valid: the cap is decided IN the decrypting
        // actor turn — a secret growing after any earlier read cannot be
        // decrypted over-cap, and over-cap plaintext never exists.
        let secret = Self::read_under_ctx(
            &cancellation,
            "secrets.materialize",
            open.actor.materialize_secret_inband(
                open.workspace_id,
                params.version_id,
                secret_path,
                key,
                MAX_INBAND_CONTENT_BYTES,
            ),
        )
        .await?;
        Ok(match secret {
            None => Value::Null,
            Some(secret) => match secret.text {
                Some(text) => json!({ "text": text }),
                None => json!({
                    "text": Value::Null,
                    "byteLength": secret.byte_length,
                    "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
                }),
            },
        })
    }

    async fn chats_channels_create(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatChannelCreateParams = parse(params)?;
        let kind = parse_channel_kind(&params.kind)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let channel = Self::read_under_ctx(
            &cancellation,
            "chats.channels.create",
            open.actor.chat_channel_create(
                open.workspace_id,
                params.channel_id,
                params.name,
                kind,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(channel_json(&channel))
    }

    async fn chats_channels_ensure_general(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatChannelEnsureParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let channel = Self::read_under_ctx(
            &cancellation,
            "chats.channels.ensureGeneral",
            open.actor.chat_channel_ensure_general(
                open.workspace_id,
                params.channel_id,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(channel_json(&channel))
    }

    async fn chats_channels_ensure_agent(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatChannelEnsureParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let channel = Self::read_under_ctx(
            &cancellation,
            "chats.channels.ensureAgent",
            open.actor.chat_channel_ensure_agent(
                open.workspace_id,
                params.channel_id,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(channel_json(&channel))
    }

    async fn chats_channels_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let _: EmptyParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let channels = Self::read_under_ctx(
            &cancellation,
            "chats.channels.list",
            open.actor.chat_channels_list(open.workspace_id),
        )
        .await?;
        // Bounded domain-side (10k rows) but a row can still be string-
        // heavy: the byte budget keeps every page under the wire frame.
        // No cursor on this family yet (composite sort keys) — truncated
        // says so honestly; cursor pagination is RPC_GAP follow-up work.
        let row_values: Vec<Value> = channels.iter().map(channel_summary_json).collect();
        let included = byte_budget_cut_serialized(&row_values, CHAT_PAGE_BYTE_BUDGET);
        if included == 0 && !row_values.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        let truncated = included < row_values.len();
        Ok(json!({
            "channels": row_values[..included].to_vec(),
            "truncated": truncated,
        }))
    }

    async fn chats_channels_find_by_slug(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatChannelFindParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let channel = Self::read_under_ctx(
            &cancellation,
            "chats.channels.findBySlug",
            open.actor
                .chat_channel_find_by_slug(open.workspace_id, params.slug),
        )
        .await?;
        Ok(channel.as_ref().map(channel_json).unwrap_or(Value::Null))
    }

    async fn chats_channels_get_wire_id(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatChannelIdParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let wire_id = Self::read_under_ctx(
            &cancellation,
            "chats.channels.getWireId",
            open.actor
                .chat_channel_get_wire_id(open.workspace_id, params.channel_id),
        )
        .await?;
        Ok(json!({ "wireId": wire_id }))
    }

    async fn chats_threads_start(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ChatThreadStartParams = parse(params)?;
        reject_capture_origin(params.origin.as_deref())?;
        let author_kind = parse_actor_kind(&params.author_kind)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let (thread, message) = Self::read_under_ctx(
            &cancellation,
            "chats.threads.start",
            open.actor.chat_thread_start(
                StartChannelThread {
                    workspace_id: open.workspace_id,
                    channel_id: params.channel_id,
                    thread_id: params.thread_id,
                    message_id: params.message_id,
                    title: params.title,
                    author_kind,
                    author_display_name: params.author_display_name,
                    author_user_id: params.author_user_id,
                    origin: params.origin,
                    body: params.body,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({ "thread": thread_json(&thread), "message": message_json(&message) }))
    }

    async fn chats_threads_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let _: EmptyParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let threads = Self::read_under_ctx(
            &cancellation,
            "chats.threads.list",
            open.actor.chat_threads_list(open.workspace_id),
        )
        .await?;
        // Bounded domain-side (10k rows) but a row can still be string-
        // heavy: the byte budget keeps every page under the wire frame.
        // No cursor on this family yet (composite sort keys) — truncated
        // says so honestly; cursor pagination is RPC_GAP follow-up work.
        let row_values: Vec<Value> = threads.iter().map(thread_json).collect();
        let included = byte_budget_cut_serialized(&row_values, CHAT_PAGE_BYTE_BUDGET);
        if included == 0 && !row_values.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        let truncated = included < row_values.len();
        Ok(json!({
            "threads": row_values[..included].to_vec(),
            "truncated": truncated,
        }))
    }

    async fn chats_messages_send(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ChatMessageSendParams = parse(params)?;
        reject_capture_origin(params.origin.as_deref())?;
        let author_kind = parse_actor_kind(&params.author_kind)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let message = Self::read_under_ctx(
            &cancellation,
            "chats.messages.send",
            open.actor.chat_message_send(
                SendMessage {
                    workspace_id: open.workspace_id,
                    thread_id: params.thread_id,
                    message_id: params.message_id,
                    author_kind,
                    author_display_name: params.author_display_name,
                    author_user_id: params.author_user_id,
                    parent_message_id: params.parent_message_id,
                    origin: params.origin,
                    body: params.body,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                cancellation.token(),
            ),
        )
        .await?;
        Ok(message_json(&message))
    }

    async fn chats_messages_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatMessagesListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "chats.messages.list",
            open.actor.chat_messages_list(
                open.workspace_id,
                params.thread_id,
                params.limit.unwrap_or(100).min(500),
                params.after_message_order,
            ),
        )
        .await?;
        let row_values: Vec<Value> = page.messages.iter().map(message_json).collect();
        let included = byte_budget_cut_serialized(&row_values, CHAT_PAGE_BYTE_BUDGET);
        if included == 0 && !row_values.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a message row exceeds the response frame budget",
            ));
        }
        let truncated = included < row_values.len();
        let next_after = if truncated {
            page.messages[..included]
                .last()
                .map(|message| message.message_order)
        } else {
            page.next_after_message_order
        };
        Ok(json!({
            "messages": row_values[..included].to_vec(),
            "nextAfterMessageOrder": next_after,
        }))
    }

    async fn chats_read_state_mark_thread_read(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatReadStateMarkParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let state = Self::read_under_ctx(
            &cancellation,
            "chats.readState.markThreadRead",
            open.actor.chat_read_state_mark_thread_read(
                open.workspace_id,
                params.thread_id,
                params.up_to_sequence,
                params.expected_revision,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(read_state_json(&state))
    }

    async fn chats_read_state_get(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let state = Self::read_under_ctx(
            &cancellation,
            "chats.readState.get",
            open.actor
                .chat_read_state_get(open.workspace_id, params.thread_id),
        )
        .await?;
        Ok(read_state_json(&state))
    }

    async fn chats_follows_set(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatFollowSetParams = parse(params)?;
        let target_kind = parse_follow_target_kind(&params.target_kind)?;
        let state = parse_follow_state(&params.state)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let cancellation = OperationCancellation::new(ctx);
        let follow = Self::read_under_ctx(
            &cancellation,
            "chats.follows.set",
            open.actor.chat_follow_set(
                SetFollow {
                    workspace_id: open.workspace_id,
                    owner_user_id: params.owner_user_id,
                    replication_owner_user_id: params.replication_owner_user_id,
                    target_kind,
                    target_id: params.target_id,
                    state,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                cancellation.token(),
            ),
        )
        .await?;
        Ok(follow_json(&workspace_id, &follow))
    }

    async fn chats_follows_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatFollowListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let cancellation = OperationCancellation::new(ctx);
        let follows = Self::read_under_ctx(
            &cancellation,
            "chats.follows.list",
            open.actor
                .chat_follows_list(open.workspace_id, params.owner_user_id, params.state),
        )
        .await?;
        // Bounded domain-side (10k rows) but a row can still be string-
        // heavy: the byte budget keeps every page under the wire frame.
        // No cursor on this family yet (composite sort keys) — truncated
        // says so honestly; cursor pagination is RPC_GAP follow-up work.
        let row_values: Vec<Value> = follows
            .iter()
            .map(|follow| follow_json(&workspace_id, follow))
            .collect();
        let included = byte_budget_cut_serialized(&row_values, CHAT_PAGE_BYTE_BUDGET);
        if included == 0 && !row_values.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        let truncated = included < row_values.len();
        Ok(json!({
            "follows": row_values[..included].to_vec(),
            "truncated": truncated,
        }))
    }

    async fn chats_feed_mark_seen(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatFeedMarkSeenParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let state = Self::read_under_ctx(
            &cancellation,
            "chats.feed.markSeen",
            open.actor.chat_feed_mark_seen(
                open.workspace_id,
                params.owner_user_id,
                params.replication_owner_user_id,
                params.head_cursor,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(feed_read_state_json(&state))
    }

    async fn chats_feed_list_personal(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatFeedListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "chats.feed.listPersonal",
            open.actor.chat_feed_list_personal(
                open.workspace_id,
                params.owner_user_id,
                params.limit.map(|limit| limit.min(100)),
                params.cursor,
            ),
        )
        .await?;
        let row_values: Vec<Value> = page
            .items
            .iter()
            .map(|item| {
                let mut value = json!({
                    "message": feed_message_json(&item.message),
                    "thread": feed_thread_json(&item.thread),
                    // Reactions are an unported RPC-B2 domain; the contract field
                    // still exists and must be an empty array for shape validation.
                    "reactions": [],
                    "matchedBy": item.matched_by.iter().map(follow_target_kind_json).collect::<Vec<_>>(),
                });
                let object = value.as_object_mut().expect("feed item is an object");
                if let Some(channel) = &item.channel {
                    object.insert("channel".to_owned(), feed_channel_json(channel));
                }
                if let Some(parent_message) = &item.parent_message {
                    object.insert(
                        "parentMessage".to_owned(),
                        feed_message_json(parent_message),
                    );
                }
                if let Some(opening_message) = &item.opening_message {
                    object.insert(
                        "openingMessage".to_owned(),
                        feed_message_json(opening_message),
                    );
                }
                value
            })
            .collect();
        let included = byte_budget_cut_serialized(&row_values, CHAT_PAGE_BYTE_BUDGET);
        if included == 0 && !row_values.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a feed row exceeds the response frame budget",
            ));
        }
        let truncated = included < row_values.len();
        let next_cursor = if truncated {
            page.items[..included].last().map(|item| {
                dohc_engine_domain::encode_feed_cursor(&FeedCursorValue {
                    created_at_ms: item.message.created_at_ms,
                    message_id: item.message.message_id.clone(),
                })
            })
        } else {
            page.next_cursor
        };
        Ok(json!({
            "items": row_values[..included].to_vec(),
            "nextCursor": next_cursor,
            "headCursor": page.head_cursor,
            "readState": page.read_state.as_ref().map(feed_read_state_json),
        }))
    }

    async fn chats_bookmarks_save(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatBookmarkSaveParams = parse(params)?;
        let target_kind = parse_bookmark_target_kind(&params.target_kind)?;
        let mode = parse_bookmark_mode(&params.mode)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let cancellation = OperationCancellation::new(ctx);
        let bookmark = Self::read_under_ctx(
            &cancellation,
            "chats.bookmarks.save",
            open.actor.chat_bookmark_save(
                SaveBookmark {
                    workspace_id: workspace_id.clone(),
                    owner_user_id: params.owner_user_id,
                    target_kind,
                    target_id: params.target_id,
                    mode,
                    destination_path: params.destination_path,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                cancellation.token(),
            ),
        )
        .await?;
        Ok(bookmark_json(&workspace_id, &bookmark))
    }

    async fn chats_bookmarks_find(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatBookmarkFindParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let cancellation = OperationCancellation::new(ctx);
        let bookmark = Self::read_under_ctx(
            &cancellation,
            "chats.bookmarks.find",
            open.actor.chat_bookmark_find(
                workspace_id.clone(),
                params.owner_user_id,
                params.bookmark_id,
            ),
        )
        .await?;
        Ok(json!({
            "bookmark": bookmark
                .as_ref()
                .map(|bookmark| bookmark_json(&workspace_id, bookmark))
                .unwrap_or(Value::Null)
        }))
    }

    async fn chats_bookmarks_list_pending(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatBookmarkListPendingParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let cancellation = OperationCancellation::new(ctx);
        let bookmarks = Self::read_under_ctx(
            &cancellation,
            "chats.bookmarks.listPending",
            open.actor.chat_bookmarks_list_pending(
                workspace_id.clone(),
                params.owner_user_id,
                params.limit,
            ),
        )
        .await?;
        // Domain-bounded to 200 rows; the byte budget still fences
        // string-heavy rows like the other list families.
        let row_values: Vec<Value> = bookmarks
            .iter()
            .map(|bookmark| bookmark_json(&workspace_id, bookmark))
            .collect();
        let included = byte_budget_cut_serialized(&row_values, CHAT_PAGE_BYTE_BUDGET);
        if included == 0 && !row_values.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        let truncated = included < row_values.len();
        Ok(json!({
            "bookmarks": row_values[..included].to_vec(),
            "truncated": truncated,
        }))
    }

    async fn chats_bookmarks_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatBookmarkListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let cancellation = OperationCancellation::new(ctx);
        let bookmarks = Self::read_under_ctx(
            &cancellation,
            "chats.bookmarks.list",
            open.actor.chat_bookmarks_list(
                workspace_id.clone(),
                params.owner_user_id,
                params.state,
            ),
        )
        .await?;
        // Bounded domain-side (10k rows) but a row can still be string-
        // heavy: the byte budget keeps every page under the wire frame.
        // No cursor on this family yet (composite sort keys) — truncated
        // says so honestly; cursor pagination is RPC_GAP follow-up work.
        let row_values: Vec<Value> = bookmarks
            .iter()
            .map(|bookmark| bookmark_json(&workspace_id, bookmark))
            .collect();
        let included = byte_budget_cut_serialized(&row_values, CHAT_PAGE_BYTE_BUDGET);
        if included == 0 && !row_values.is_empty() {
            return Err(wire(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        let truncated = included < row_values.len();
        Ok(json!({
            "bookmarks": row_values[..included].to_vec(),
            "truncated": truncated,
        }))
    }

    async fn chats_bookmarks_mark_ready(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatBookmarkMarkReadyParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let cancellation = OperationCancellation::new(ctx);
        let transition = Self::read_under_ctx(
            &cancellation,
            "chats.bookmarks.markReady",
            open.actor.chat_bookmark_mark_ready(
                workspace_id.clone(),
                params.owner_user_id,
                params.bookmark_id,
                params.generation,
                params.projected_at_ms.unwrap_or(now_ms()?),
                params.projection_object_id,
                params.projection_path,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({
            "bookmark": bookmark_json(&workspace_id, &transition.bookmark),
            "applied": transition.applied,
        }))
    }

    async fn chats_bookmarks_archive(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatBookmarkArchiveParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let cancellation = OperationCancellation::new(ctx);
        let bookmark = Self::read_under_ctx(
            &cancellation,
            "chats.bookmarks.archive",
            open.actor.chat_bookmark_archive(
                workspace_id.clone(),
                params.owner_user_id,
                params.bookmark_id,
                now_ms()?,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(bookmark_json(&workspace_id, &bookmark))
    }

    async fn chats_bookmarks_mark_failed(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatBookmarkMarkFailedParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let cancellation = OperationCancellation::new(ctx);
        let transition = Self::read_under_ctx(
            &cancellation,
            "chats.bookmarks.markFailed",
            open.actor.chat_bookmark_mark_failed(
                workspace_id.clone(),
                params.owner_user_id,
                params.bookmark_id,
                params.generation,
                params.failure_reason,
                now_ms()?,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({
            "bookmark": bookmark_json(&workspace_id, &transition.bookmark),
            "applied": transition.applied,
        }))
    }

    async fn chats_bookmarks_mark_stale(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatBookmarkMarkStaleParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let cancellation = OperationCancellation::new(ctx);
        let transition = Self::read_under_ctx(
            &cancellation,
            "chats.bookmarks.markStale",
            open.actor.chat_bookmark_mark_stale(
                workspace_id.clone(),
                params.owner_user_id,
                params.bookmark_id,
                params.generation,
                params.failure_reason,
                now_ms()?,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({
            "bookmark": bookmark_json(&workspace_id, &transition.bookmark),
            "applied": transition.applied,
        }))
    }

    async fn chats_dispatch_enqueue(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchEnqueueParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let enqueued = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.enqueue",
            open.actor.chat_dispatch_enqueue(
                open.workspace_id,
                params.trigger_message_id,
                params.thread_id,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({ "enqueued": enqueued }))
    }

    async fn chats_dispatch_claim_next_pending(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchClaimParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let claim = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.claimNextPending",
            open.actor.chat_dispatch_claim_next_pending(
                open.workspace_id,
                params.run_id,
                params.command.unwrap_or_default(),
                params.log_path,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(claim
            .as_ref()
            .map(dispatch_claim_json)
            .unwrap_or(Value::Null))
    }

    async fn chats_dispatch_complete(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchCompleteParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.complete",
            open.actor.chat_dispatch_complete(
                open.workspace_id,
                params.run_id,
                params.exit_code,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({ "completed": true }))
    }

    async fn chats_dispatch_fail(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchFailParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.fail",
            open.actor.chat_dispatch_fail(
                open.workspace_id,
                params.run_id,
                params.reason,
                params.exit_code,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({ "failed": true }))
    }

    async fn ydoc_apply(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: YdocApplyParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        // Serialize with the session surface: the lease check below is only
        // meaningful if no ydoc.open can interleave between it and the
        // append (open holds this same lock across lease + state read).
        // Cancellation stays honored while queued — a long settle must not
        // pin an already-expired apply on the transport.
        let cancellation = OperationCancellation::new(ctx);
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.apply (queued)"));
            }
            serial = self.session_ops.lock() => serial,
        };
        let update = base64::engine::general_purpose::STANDARD
            .decode(params.update_base64)
            .map_err(|_| wire(ErrorCode::InvalidParams, "invalid update encoding"))?;
        let key = DocKey::new(open.workspace_id, params.version_id, params.object_id)
            .map_err(|_| wire(ErrorCode::InvalidParams, "invalid document coordinates"))?;
        // A live session's lease is single-writer: the legacy append path
        // must not advance the durable CRDT behind an open editor (no
        // remoteUpdate delivery, no forced resync). Same refusal shape as a
        // second ydoc.open.
        if self.leases.scoped(&open.root).is_held(&key) {
            return Err(wire(ErrorCode::InvalidParams, "ydoc-session-busy"));
        }
        let content_kind = match params.content_kind.as_str() {
            "plaintext" => ContentKind::Plaintext,
            "richdoc" => ContentKind::Richdoc,
            _ => return Err(wire(ErrorCode::InvalidParams, "unknown Y.Doc content kind")),
        };
        let outcome = open
            .actor
            .ydoc_apply(
                key,
                content_kind,
                update,
                params.now_ms.unwrap_or(now_ms()?),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({
            "seq": outcome.seq,
            "deduped": outcome.deduped,
            "emitOutbound": outcome.emit_outbound
        }))
    }

    async fn ydoc_open(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: YdocOpenParams = parse(params)?;
        validate_ydoc_path(&params.path)?;
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(&handle))?;
        let requested_kind = params
            .content_kind
            .as_deref()
            .map(parse_ydoc_content_kind)
            .transpose()?;
        let cancellation = OperationCancellation::new(ctx);
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.open (queued)"));
            }
            serial = self.session_ops.lock() => serial,
        };
        // The first read only DERIVES the key (head resolution can't happen
        // without it). The lease is then taken on that key and the state is
        // RE-READ under it — a legacy ydoc.apply landing between read one and
        // the lease can no longer hand the opener stale initial state (the
        // second read is the authoritative one; apply refuses while leased).
        let probe = open
            .actor
            .ydoc_open_state(
                open.workspace_id.clone(),
                now_ms()?,
                false,
                None,
                params.version_id.clone(),
                params.path.clone(),
                requested_kind,
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        let lease =
            self.leases
                .scoped(&open.root)
                .acquire(&probe.key)
                .map_err(|error| match error {
                    CollabError::LeaseHeld => wire(ErrorCode::InvalidParams, "ydoc-session-busy"),
                    other => map_runtime(RuntimeError::Collab(other)),
                })?;
        let state = open
            .actor
            .ydoc_open_state(
                open.workspace_id.clone(),
                now_ms()?,
                true,
                Some(probe.key.clone()),
                params.version_id,
                params.path.clone(),
                requested_kind,
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        if state.key != probe.key {
            // The path's owner changed between the probe and the lease: the
            // held lease guards the WRONG key. Refuse; the client retries.
            return Err(wire(ErrorCode::InvalidParams, "ydoc-session-busy"));
        }
        let sequence = self
            .next_session
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let session_id = format!("ydoc-{}-{sequence:016x}", self.session_epoch);
        let result = YdocOpenResult {
            session_id: session_id.clone(),
            object_id: state.key.object_id.clone(),
            path: params.path.clone(),
            content_kind: ydoc_content_kind_name(state.content_kind),
            initial_update_base64: encode_ydoc_state_base64(&state.initial_update)?,
            lineage: if state.lineage_existing {
                "existing"
            } else {
                "absent"
            },
            seed_markdown: {
                // A seed past the in-band cap cannot cross the wire as one
                // string, and a client that can't seed can't edit: refuse the
                // open outright (blob streaming for large bodies is RPC-D).
                if state
                    .seed_markdown
                    .as_ref()
                    .is_some_and(|seed| seed.len() > MAX_INBAND_CONTENT_BYTES)
                {
                    return Err(wire(
                        ErrorCode::InvalidParams,
                        "ydoc-seed-exceeds-inband-cap",
                    ));
                }
                state.seed_markdown
            },
        };
        lock(&self.sessions).insert(
            session_id,
            YdocSession {
                workspace: handle,
                key: state.key,
                path: params.path,
                content_kind: state.content_kind,
                regime: state.regime,
                lineage_absent: !state.lineage_existing,
                first_update_pending: !state.lineage_existing,
                last_settled_sha: None,
                open_head_sha: state.head_blob_sha256,
                _lease: lease,
            },
        );
        serde_json::to_value(result)
            .map_err(|_| wire(ErrorCode::Internal, "response encode failed"))
    }

    async fn ydoc_record_update(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        idempotency_key: Option<String>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: YdocRecordUpdateParams = parse(params)?;
        let cancellation = OperationCancellation::new(ctx);
        // An OWNED guard: it moves INTO the spawned task below, so a dropped
        // RPC future cannot release the session serial while the record (and
        // its first_update_pending transition) is still running — a second
        // recordUpdate would otherwise read the stale flag and refuse
        // seed-onto-existing-lineage after the first write committed.
        let serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.recordUpdate (queued)"));
            }
            serial = Arc::clone(&self.session_ops).lock_owned() => serial,
        };
        let (open, session) = self.ydoc_session(handle.as_ref(), &params.session_id)?;
        let update = base64::engine::general_purpose::STANDARD
            .decode(params.update_base64)
            .map_err(|_| wire(ErrorCode::InvalidParams, "invalid update encoding"))?;
        let require_empty = session.lineage_absent && session.first_update_pending;
        // The record and the first-seed flag transition run in a SPAWNED
        // task: if the seed COMMITS but a deadline/cancel drops this future
        // before the post-await assignment, the session would keep
        // `first_update_pending` and send its next distinct edit with
        // `require_empty_lineage = true` — a spurious
        // seed-onto-existing-lineage quarantine for a healthy session. The
        // spawned task runs to completion regardless of this future.
        let outcome = {
            let sessions = Arc::clone(&self.sessions);
            let session_id = params.session_id.clone();
            let actor = open.actor.clone();
            let now = now_ms()?;
            let token = cancellation.token();
            let record_task = tokio::spawn(async move {
                let _serial = serial;
                let outcome = actor
                    .ydoc_record_update(
                        session.key,
                        session.path,
                        session.content_kind,
                        session.regime,
                        update,
                        params.actor_origin_id,
                        require_empty,
                        idempotency_key,
                        now,
                        Arc::new(NoFaults),
                        token,
                    )
                    .await;
                if outcome.is_ok()
                    && let Some(session) = lock(&sessions).get_mut(&session_id)
                {
                    session.first_update_pending = false;
                }
                outcome
            });
            record_task
                .await
                .map_err(|_| wire(ErrorCode::Internal, "ydoc record task failed"))?
                .map_err(|error| {
                    if matches!(
                        error,
                        RuntimeError::Collab(CollabError::SeedOntoExistingLineage)
                    ) {
                        wire(ErrorCode::InvalidParams, "seed-onto-existing-lineage")
                    } else {
                        map_runtime(error)
                    }
                })?
        };
        serde_json::to_value(YdocRecordUpdateResult {
            seq: outcome.seq,
            deduped: outcome.deduped,
        })
        .map_err(|_| wire(ErrorCode::Internal, "response encode failed"))
    }

    async fn ydoc_settle(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: YdocSettleParams = parse(params)?;
        let cancellation = OperationCancellation::new(ctx);
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.settle (queued)"));
            }
            serial = self.session_ops.lock() => serial,
        };
        self.ydoc_settle_inner(
            &cancellation,
            handle.as_ref(),
            &params.session_id,
            params.summary.as_deref(),
        )
        .await
    }

    async fn ydoc_settle_inner(
        &self,
        cancellation: &OperationCancellation,
        handle: Option<&WorkspaceHandle>,
        session_id: &str,
        _summary: Option<&str>,
    ) -> Result<Value, WireError> {
        let (open, session) = self.ydoc_session(handle, session_id)?;
        if session.content_kind == ContentKind::Richdoc {
            return Err(wire(ErrorCode::InvalidParams, "richdoc-settle-unsupported"));
        }
        let settled = open
            .actor
            .ydoc_settle(
                open.root.clone(),
                session.key,
                session.path.clone(),
                session.content_kind,
                session.open_head_sha.clone(),
                session_id.to_owned(),
                Arc::new(self.self_writes.scoped(&open.root)),
                now_ms()?,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(|error| {
                // A distinct wire message the client acts on: remote edits
                // drained under this session's lease mean the client's doc is
                // BEHIND — it must resync (which returns the full drained
                // state) and settle again. The generic mapping would bury
                // the signal as "workspace operation failed".
                if matches!(
                    &error,
                    RuntimeError::Domain(dohc_engine_domain::DomainError::InvalidInput {
                        reason: "ydoc-remote-updates-pending",
                    })
                ) {
                    wire(ErrorCode::InvalidParams, "ydoc-remote-updates-pending")
                } else {
                    map_runtime(error)
                }
            })?;
        if let Some(session) = lock(&self.sessions).get_mut(session_id) {
            session.last_settled_sha = Some(settled.sha256.clone());
        }
        serde_json::to_value(YdocSettleResult {
            moment_id: settled.moment_id,
            path: settled.path,
            markdown: settled.markdown,
            sha256: settled.sha256,
            projection: YdocProjectionProvenance {
                content_kind: ydoc_content_kind_name(settled.projection.content_kind),
                source_state_vector_sha256: settled.projection.source_state_vector_sha256,
                destructive: settled.projection.destructive,
            },
        })
        .map_err(|_| wire(ErrorCode::Internal, "response encode failed"))
    }

    async fn ydoc_apply_external_markdown_edit(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: YdocApplyExternalMarkdownEditParams = parse(params)?;
        let cancellation = OperationCancellation::new(ctx);
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.applyExternalMarkdownEdit (queued)"));
            }
            serial = self.session_ops.lock() => serial,
        };
        let _ = self.ydoc_session(handle.as_ref(), &params.session_id)?;
        let _ = params.markdown;
        Err(wire(
            ErrorCode::InvalidParams,
            "external-edit-unsupported-live",
        ))
    }

    async fn ydoc_close(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: YdocCloseParams = parse(params)?;
        let cancellation = OperationCancellation::new(ctx);
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.close (queued)"));
            }
            serial = self.session_ops.lock() => serial,
        };
        // Missing `settle` means SETTLE — the TS driver treats close() as
        // settle-unless-explicitly-false, and defaulting to false here would
        // fail dirty local-only closes (UnsettledClose) and let a replicated
        // close compact while the markdown projection is stale.
        let default_settle = {
            let (_open, session) = self.ydoc_session(handle.as_ref(), &params.session_id)?;
            // Richdoc settle is a C1 refusal on the EXPLICIT ydoc.settle RPC;
            // a default close must not inherit that error — it skips the
            // markdown settle and the close below persists the closed CRDT
            // state instead (nothing is lost, nothing is projected). An
            // untouched absent-lineage session (opened, never seeded) has
            // nothing to settle either: defaulting to settle there would
            // refuse NoMarker and strand the session/lease.
            session.content_kind != ContentKind::Richdoc
                && !(session.lineage_absent && session.first_update_pending)
        };
        if params.settle.unwrap_or(default_settle) {
            let settled = self
                .ydoc_settle_inner(
                    &cancellation,
                    handle.as_ref(),
                    &params.session_id,
                    params.summary.as_deref(),
                )
                .await;
            match settled {
                Ok(_) => {}
                // The refusal fires AFTER the deferred rows drained: for the
                // EXPLICIT settle RPC the client must resync (it keeps
                // editing), but a CLOSE is final — the session ends, so the
                // converged doc (local + drained remote) IS the artifact.
                // Retry once; the drain has emptied the queue, so the second
                // settle projects the merged state. Without this, a routine
                // close refuses and strands the session/lease until the
                // caller manually resyncs or closes the workspace.
                Err(error) if error.message == "ydoc-remote-updates-pending" => {
                    self.ydoc_settle_inner(
                        &cancellation,
                        handle.as_ref(),
                        &params.session_id,
                        params.summary.as_deref(),
                    )
                    .await?;
                }
                Err(error) => return Err(error),
            }
        }
        let (open, session) = self.ydoc_session(handle.as_ref(), &params.session_id)?;
        // The close command carries a FRESH token: once the settle above has
        // materialized, honoring a caller cancel here would leave the
        // session/lease held, and the retried close would re-settle over the
        // already-settled content (the fingerprint's previous-moment input
        // changed) — duplicate moments for one close.
        //
        // The session entry (and with it the lease guard) is TAKEN before
        // the await: if a deadline drops this future while the actor still
        // compacts/prunes, dropping the entry releases the lease — the doc
        // can't stay ydoc-session-busy forever. A close REFUSAL (e.g.
        // UnsettledClose on a dirty prune-close) reinserts the entry.
        //
        // The take→close→reinsert sequence runs in a SPAWNED task, not this
        // RPC future: the protocol supervisor can drop this future on a
        // caller cancel/deadline, and a drop between the take and the
        // actor's refusal would skip the reinsert — the session and lease
        // would vanish over a still-dirty lineage with the refusal never
        // observable. A spawned task runs to completion regardless of what
        // happens to this future (dropping a JoinHandle does not cancel).
        let now = now_ms()?;
        let sessions = Arc::clone(&self.sessions);
        let actor = open.actor.clone();
        let session_id = params.session_id.clone();
        let session_key = session.key.clone();
        // The TAKE happens synchronously BEFORE the spawn: if this future is
        // dropped right after spawning, `session_ops` releases while the task
        // has not yet run — a concurrent recordUpdate/settle must NOT be able
        // to find the session and race edits against the in-flight close.
        let taken = lock(&self.sessions).remove(&params.session_id);
        let close_task = tokio::spawn(async move {
            let close_result = actor
                .ydoc_close_session(
                    session_key,
                    now,
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await;
            // Reinsert ONLY on a genuine close refusal (UnsettledClose and
            // friends) — an ActorUnavailable/WorkerPanicked error means the
            // workspace was torn down while this task ran, and resurrecting
            // the entry would keep its embedded lease alive past the
            // eviction, leaving the doc ydoc-session-busy for the NEXT
            // workspace open.
            if matches!(
                close_result,
                Err(RuntimeError::Collab(_)) | Err(RuntimeError::Domain(_))
            ) && let Some(entry) = taken
            {
                lock(&sessions).insert(session_id, entry);
            }
            close_result
        });
        let close_result = close_task
            .await
            .map_err(|_| wire(ErrorCode::Internal, "ydoc close task failed"))?;
        if let Err(error) = close_result {
            return Err(map_runtime(error));
        }
        serde_json::to_value(YdocCloseResult { closed: true })
            .map_err(|_| wire(ErrorCode::Internal, "response encode failed"))
    }

    async fn ydoc_resync(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: YdocResyncParams = parse(params)?;
        let cancellation = OperationCancellation::new(ctx);
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.resync (queued)"));
            }
            serial = self.session_ops.lock() => serial,
        };
        let (open, session) = self.ydoc_session(handle.as_ref(), &params.session_id)?;
        let full_state = open
            .actor
            .ydoc_resync(session.key, cancellation.token())
            .await
            .map_err(map_runtime)?;
        serde_json::to_value(YdocResyncResult {
            initial_update_base64: encode_ydoc_state_base64(&full_state)?,
        })
        .map_err(|_| wire(ErrorCode::Internal, "response encode failed"))
    }

    fn ydoc_session(
        &self,
        handle: Option<&WorkspaceHandle>,
        session_id: &str,
    ) -> Result<(OpenWorkspace, YdocSessionView), WireError> {
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(handle))?;
        let sessions = lock(&self.sessions);
        let session = sessions
            .get(session_id)
            .filter(|session| &session.workspace == handle)
            .ok_or_else(|| wire(ErrorCode::InvalidParams, "ydoc-session-not-found"))?;
        Ok((
            open,
            YdocSessionView {
                key: session.key.clone(),
                path: session.path.clone(),
                content_kind: session.content_kind,
                regime: session.regime,
                lineage_absent: session.lineage_absent,
                first_update_pending: session.first_update_pending,
                open_head_sha: session.open_head_sha.clone(),
            },
        ))
    }

    async fn conflicts_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ConflictListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let conflicts = open
            .actor
            .conflict_list(open.workspace_id, params.status, cancellation.token())
            .await
            .map_err(map_runtime)?;
        Ok(Value::Array(conflicts.iter().map(conflict_json).collect()))
    }

    async fn conflicts_open(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ConflictOpenParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        if let Some(envelope) = params.envelope {
            enforce_workspace(&open, &envelope.workspace_id)?;
            let result = open
                .actor
                .conflict_apply_replicated(envelope, Arc::new(NoFaults), cancellation.token())
                .await
                .map_err(map_runtime)?;
            return Ok(replicated_conflict_json(result));
        }
        let conflict = params
            .conflict
            .ok_or_else(|| wire(ErrorCode::InvalidParams, "missing conflict or envelope"))?
            .into_domain()?;
        enforce_workspace(&open, &conflict.workspace_id)?;
        let inserted = open
            .actor
            .conflict_open(conflict, Arc::new(NoFaults), cancellation.token())
            .await
            .map_err(map_runtime)?;
        Ok(json!({ "inserted": inserted }))
    }

    async fn conflicts_resolve(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ConflictResolveParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        if let Some(envelope) = params.envelope {
            enforce_workspace(&open, &envelope.workspace_id)?;
            let result = open
                .actor
                .conflict_apply_replicated(envelope, Arc::new(NoFaults), cancellation.token())
                .await
                .map_err(map_runtime)?;
            return Ok(replicated_conflict_json(result));
        }
        let local = params.local.ok_or_else(|| {
            wire(
                ErrorCode::InvalidParams,
                "missing local resolve or envelope",
            )
        })?;
        let resolution = match local.resolution.as_str() {
            "keep-current" => ResolveConflictKind::KeepCurrent,
            "apply-incoming" => ResolveConflictKind::ApplyIncoming,
            "apply-merged" => ResolveConflictKind::ApplyMerged {
                text: local
                    .merged_text
                    .ok_or_else(|| wire(ErrorCode::InvalidParams, "missing merged text"))?,
            },
            _ => {
                return Err(wire(
                    ErrorCode::InvalidParams,
                    "unknown conflict resolution",
                ));
            }
        };
        let result = open
            .actor
            .conflict_resolve(
                ResolveTextConflict {
                    workspace_id: open.workspace_id,
                    conflict_id: local.conflict_id,
                    resolution,
                    object_id: local.object_id,
                    write_moment_id: local.write_moment_id,
                    delete_moment_id: local.delete_moment_id,
                    metadata_origin: local.metadata_origin,
                    author_json: local.author_json,
                    now_ms: local.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({ "conflict": conflict_json(&result.conflict) }))
    }

    async fn search_query(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SearchParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let results = open
            .actor
            .search(
                open.root,
                open.workspace_id,
                params.version_id,
                params.query,
                params.limit,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(Value::Array(
            results
                .into_iter()
                .map(|result| {
                    json!({
                        "surface": match result.surface { SearchSurface::File => "file", SearchSurface::Chat => "chat" },
                        "path": result.path,
                        "title": result.title,
                        "line": result.line,
                        "preview": result.preview,
                        "matchStart": result.match_start,
                        "matchEnd": result.match_end,
                        "threadId": result.thread_id,
                        "objectId": result.object_id
                    })
                })
                .collect(),
        ))
    }

    async fn search_ensure_index(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SearchEnsureIndexParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        open.actor
            .ensure_search_index(
                open.root,
                open.workspace_id,
                params.version_id,
                now_ms()?,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({}))
    }

    fn open(&self, handle: Option<&WorkspaceHandle>) -> Result<OpenWorkspace, WireError> {
        let handle = handle.ok_or_else(workspace_unavailable)?;
        lock(&self.handles)
            .get(handle)
            .cloned()
            .ok_or_else(workspace_unavailable)
    }
}

impl ProtocolEngineService for EngineService {
    async fn call(&self, ctx: RequestContext, request: Request) -> Result<Response, WireError> {
        self.dispatch(ctx, request).await
    }
}

struct OperationCancellation {
    token: CancellationToken,
    /// Whether the DEADLINE (not a client cancel) is what fired the token —
    /// the two report different wire codes with different retryability.
    deadline_hit: Arc<std::sync::atomic::AtomicBool>,
    bridge: tokio::task::JoinHandle<()>,
}

impl OperationCancellation {
    fn new(ctx: &RequestContext) -> Self {
        let token = CancellationToken::new();
        if ctx.cancel.is_cancelled() {
            token.cancel();
        }
        let signal = ctx.cancel.clone();
        let deadline = ctx.deadline;
        let deadline_hit = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hit = Arc::clone(&deadline_hit);
        let child = token.clone();
        let bridge = tokio::spawn(async move {
            // The supervisor enforces deadlines non-cooperatively for wire
            // requests; EMBEDDED callers (InProcessTransport, future
            // mobile/WASM hosts) have no supervisor, so the deadline arms
            // the same token here.
            match deadline {
                Some(deadline) => {
                    tokio::select! {
                        () = signal.cancelled() => {}
                        () = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                            hit.store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                    }
                }
                None => signal.cancelled().await,
            }
            child.cancel();
        });
        OperationCancellation {
            token,
            deadline_hit,
            bridge,
        }
    }

    /// The wire error for an interrupted wait: DEADLINE_EXCEEDED when the
    /// deadline fired, CANCELLED for a client cancel — retryability differs.
    fn interruption(&self, what: &str) -> WireError {
        if self.deadline_hit.load(std::sync::atomic::Ordering::Relaxed) {
            WireError::new(
                ErrorCode::DeadlineExceeded,
                format!("{what} deadline elapsed"),
            )
        } else {
            WireError::new(ErrorCode::Cancelled, format!("{what} cancelled"))
        }
    }

    fn token(&self) -> CancellationToken {
        self.token.clone()
    }
}

/// Closes a just-opened store actor if `workspace_open` is dropped before the
/// handle reaches `handles` (a cancelled/deadline-expired open). Disarmed on
/// the success path, where the handle owns the actor.
struct OpenGuard {
    supervisor: &'static WorkspaceSupervisor,
    db_path: Option<PathBuf>,
}

impl OpenGuard {
    fn disarm(mut self) {
        self.db_path = None;
    }
}

impl Drop for OpenGuard {
    fn drop(&mut self) {
        let Some(db_path) = self.db_path.take() else {
            return;
        };
        let supervisor = self.supervisor;
        // Detached + blocking: never run the actor join on a runtime worker
        // (the #201 cancellation-safety contract).
        tokio::task::spawn_blocking(move || {
            let _ = supervisor.close(&db_path);
        });
    }
}

impl Drop for OperationCancellation {
    fn drop(&mut self) {
        self.token.cancel();
        self.bridge.abort();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceOpenParams {
    root_dir: String,
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextWriteParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
    #[serde(default)]
    object_id: Option<String>,
    path: String,
    text: String,
    #[serde(default)]
    moment_id: Option<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    metadata_origin: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    author_json: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedBinaryWriteParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
    #[serde(default)]
    object_id: Option<String>,
    path: String,
    #[serde(default)]
    bytes: Option<Vec<u8>>,
    #[serde(default)]
    bytes_base64: Option<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    metadata_origin: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    author_json: Option<String>,
    #[serde(default)]
    moment_id: Option<String>,
    #[serde(default)]
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextRenameParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
    from_path: String,
    to_path: String,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    metadata_origin: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    author_json: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextDeleteParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
    path: String,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    metadata_origin: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    author_json: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextRollbackParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
    path: String,
    mutation_moment_id: String,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    metadata_origin: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    author_json: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    legacy_before_text: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextCompareParams {
    #[serde(default)]
    workspace_id: Option<String>,
    path: String,
    source_version_id: String,
    target_version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextMergeParams {
    #[serde(default)]
    workspace_id: Option<String>,
    path: String,
    source_version_id: String,
    target_version_id: String,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    metadata_origin: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    author_json: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionsCompareFilesParams {
    #[serde(default)]
    workspace_id: Option<String>,
    source_version_id: String,
    target_version_id: String,
    #[serde(default)]
    after_path: Option<String>,
    #[serde(default)]
    byte_budget: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextReadParams {
    version_id: String,
    path: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionsListParams {
    #[serde(default)]
    after_version_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionsCreateNamedParams {
    workspace_id: String,
    name: String,
    from_version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceOnlyParams {
    #[serde(default)]
    workspace_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionsSetActiveParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsListParams {
    version_id: String,
    #[serde(default)]
    after_path: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsWriteParams {
    workspace_id: String,
    version_id: String,
    path: String,
    text: String,
    origin: String,
    moment_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsDeleteParams {
    workspace_id: String,
    version_id: String,
    path: String,
    origin: String,
    moment_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsForkParams {
    workspace_id: String,
    from_version_id: String,
    to_version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsMomentsListParams {
    workspace_id: String,
    version_id: String,
    path: String,
    #[serde(default)]
    before_moment_order: Option<i64>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsMomentsGetParams {
    workspace_id: String,
    moment_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsCompareParams {
    workspace_id: String,
    source_version_id: String,
    target_version_id: String,
    #[serde(default)]
    after_path: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsApplyParams {
    workspace_id: String,
    path: String,
    from_version_id: String,
    moment_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsRestoreParams {
    workspace_id: String,
    path: String,
    before_moment_id: String,
    moment_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextListParams {
    version_id: String,
    #[serde(default)]
    after_path: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionPathParams {
    version_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedBinaryReadBlobParams {
    workspace_id: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MomentsListParams {
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    object_id: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    before_moment_order: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MomentsGetParams {
    moment_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocApplyParams {
    version_id: String,
    object_id: String,
    content_kind: String,
    update_base64: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocOpenParams {
    version_id: String,
    path: String,
    #[serde(default)]
    content_kind: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YdocOpenResult {
    session_id: String,
    object_id: String,
    path: String,
    content_kind: &'static str,
    initial_update_base64: String,
    lineage: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    seed_markdown: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocRecordUpdateParams {
    session_id: String,
    update_base64: String,
    #[serde(default)]
    actor_origin_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YdocRecordUpdateResult {
    /// Durable per-lineage head sequence (not a session-local counter).
    seq: i64,
    deduped: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocSettleParams {
    session_id: String,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YdocProjectionProvenance {
    content_kind: &'static str,
    source_state_vector_sha256: String,
    destructive: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YdocSettleResult {
    moment_id: String,
    path: String,
    markdown: String,
    sha256: String,
    projection: YdocProjectionProvenance,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocApplyExternalMarkdownEditParams {
    session_id: String,
    markdown: String,
}

#[allow(dead_code, reason = "C1 refuses this method before producing a result")]
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum YdocApplyExternalMarkdownEditResult {
    Merged { markdown: String },
    Conflict { conflict_path: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocCloseParams {
    session_id: String,
    #[serde(default)]
    settle: Option<bool>,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YdocCloseResult {
    closed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocResyncParams {
    session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YdocResyncResult {
    initial_update_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictListParams {
    status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictOpenParams {
    conflict: Option<ConflictDto>,
    envelope: Option<ReplicationEnvelope>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictResolveParams {
    local: Option<LocalResolveDto>,
    envelope: Option<ReplicationEnvelope>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalResolveDto {
    conflict_id: String,
    resolution: String,
    merged_text: Option<String>,
    object_id: String,
    write_moment_id: String,
    delete_moment_id: String,
    metadata_origin: String,
    author_json: Option<String>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchParams {
    version_id: String,
    query: String,
    limit: Option<i64>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchEnsureIndexParams {
    workspace_id: String,
    version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmptyParams {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatChannelCreateParams {
    channel_id: String,
    name: String,
    kind: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatChannelEnsureParams {
    channel_id: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatChannelFindParams {
    slug: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatChannelIdParams {
    channel_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatThreadStartParams {
    channel_id: String,
    thread_id: String,
    message_id: String,
    title: Option<String>,
    author_kind: String,
    author_display_name: String,
    author_user_id: Option<String>,
    origin: Option<String>,
    body: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatMessageSendParams {
    thread_id: String,
    message_id: String,
    author_kind: String,
    author_display_name: String,
    author_user_id: Option<String>,
    parent_message_id: Option<String>,
    origin: Option<String>,
    body: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatMessagesListParams {
    thread_id: String,
    limit: Option<i64>,
    after_message_order: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatThreadParams {
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatReadStateMarkParams {
    thread_id: String,
    up_to_sequence: i64,
    expected_revision: Option<i64>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatFollowSetParams {
    owner_user_id: String,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    replication_owner_user_id: Option<String>,
    target_kind: String,
    target_id: String,
    state: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatBookmarkListParams {
    owner_user_id: String,
    state: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatFollowListParams {
    owner_user_id: String,
    state: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatBookmarkFindParams {
    owner_user_id: String,
    bookmark_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatBookmarkListPendingParams {
    owner_user_id: String,
    limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatFeedMarkSeenParams {
    owner_user_id: String,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    replication_owner_user_id: Option<String>,
    head_cursor: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatFeedListParams {
    owner_user_id: String,
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatBookmarkSaveParams {
    owner_user_id: String,
    target_kind: String,
    target_id: String,
    mode: String,
    destination_path: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatBookmarkMarkReadyParams {
    owner_user_id: String,
    bookmark_id: String,
    generation: i64,
    projected_at_ms: Option<i64>,
    projection_object_id: Option<String>,
    projection_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatBookmarkArchiveParams {
    owner_user_id: String,
    bookmark_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatBookmarkMarkFailedParams {
    owner_user_id: String,
    bookmark_id: String,
    generation: i64,
    failure_reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatBookmarkMarkStaleParams {
    owner_user_id: String,
    bookmark_id: String,
    generation: i64,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    failure_reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchEnqueueParams {
    trigger_message_id: String,
    thread_id: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchClaimParams {
    run_id: String,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    command: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    log_path: Option<String>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchCompleteParams {
    run_id: String,
    exit_code: i64,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchFailParams {
    run_id: String,
    reason: String,
    exit_code: Option<i64>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictDto {
    id: String,
    workspace_id: String,
    path: String,
    target_version_id: String,
    source_version_id: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    status: String,
    chosen_from: String,
    resolution: Option<String>,
    metadata: ConflictMetadataDto,
    base: ConflictStateDto,
    current: ConflictStateDto,
    incoming: ConflictStateDto,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictMetadataDto {
    origin: String,
    summary: Option<String>,
    correlation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictStateDto {
    path: String,
    content_kind: String,
    snapshot: Option<SnapshotDto>,
    metadata_summary: Option<String>,
    metadata_correlation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotDto {
    workspace_id: String,
    version_id: String,
    object_id: String,
    path: String,
    text: String,
    blob_sha256: String,
    updated_at_ms: i64,
    latest_moment_id: String,
    metadata_origin: String,
}

impl ConflictDto {
    fn into_domain(self) -> Result<TextConflict, WireError> {
        Ok(TextConflict {
            conflict_id: self.id,
            workspace_id: self.workspace_id,
            path: self.path,
            target_version_id: self.target_version_id,
            source_version_id: self.source_version_id,
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
            status: parse_status(&self.status)?,
            chosen_from: parse_choice(&self.chosen_from)?,
            resolution: self
                .resolution
                .as_deref()
                .map(parse_resolution)
                .transpose()?,
            metadata: ConflictMetadata {
                origin: self.metadata.origin,
                summary: self.metadata.summary,
                correlation_id: self.metadata.correlation_id,
            },
            base: self.base.into_domain()?,
            current: self.current.into_domain()?,
            incoming: self.incoming.into_domain()?,
        })
    }
}

impl ConflictStateDto {
    fn into_domain(self) -> Result<ConflictFileState, WireError> {
        let content_kind = match self.content_kind.as_str() {
            "text" => ConflictContentKind::Text,
            "binary" => ConflictContentKind::Binary,
            _ => {
                return Err(wire(
                    ErrorCode::InvalidParams,
                    "unknown conflict content kind",
                ));
            }
        };
        Ok(ConflictFileState {
            path: self.path,
            snapshot: self.snapshot.map(SnapshotDto::into_domain).transpose()?,
            // This wire DTO carries no binary payload yet; a `content_kind:
            // "binary"` side arriving here has no blob reference and fails
            // closed downstream (`insert_text_conflict_if_absent`). Wiring an
            // actual binary payload through this RPC surface is out of scope
            // for BINCONFLICT (schema + persistence only).
            binary_sha256: None,
            binary_object_id: None,
            binary_latest_moment_id: None,
            content_kind,
            metadata_summary: self.metadata_summary,
            metadata_correlation_id: self.metadata_correlation_id,
        })
    }
}

impl SnapshotDto {
    fn into_domain(self) -> Result<TextSnapshot, WireError> {
        let actual = dohc_engine_storage::hex_sha256(self.text.as_bytes());
        if self.blob_sha256 != actual {
            return Err(wire(
                ErrorCode::InvalidParams,
                "snapshot hash does not match text",
            ));
        }
        Ok(TextSnapshot {
            workspace_id: self.workspace_id,
            version_id: self.version_id,
            object_id: self.object_id,
            path: self.path,
            text: self.text,
            blob_sha256: self.blob_sha256,
            updated_at_ms: self.updated_at_ms,
            latest_moment_id: self.latest_moment_id,
            metadata_origin: self.metadata_origin,
        })
    }
}

fn parse_status(raw: &str) -> Result<ConflictStatus, WireError> {
    match raw {
        "open" => Ok(ConflictStatus::Open),
        "resolved" => Ok(ConflictStatus::Resolved),
        _ => Err(wire(ErrorCode::InvalidParams, "unknown conflict status")),
    }
}

fn parse_choice(raw: &str) -> Result<ConflictChoice, WireError> {
    match raw {
        "current" => Ok(ConflictChoice::Current),
        "incoming" => Ok(ConflictChoice::Incoming),
        "merged" => Ok(ConflictChoice::Merged),
        _ => Err(wire(ErrorCode::InvalidParams, "unknown conflict choice")),
    }
}

fn parse_resolution(raw: &str) -> Result<ConflictResolution, WireError> {
    match raw {
        "kept-current" => Ok(ConflictResolution::KeptCurrent),
        "applied-incoming" => Ok(ConflictResolution::AppliedIncoming),
        "applied-merged" => Ok(ConflictResolution::AppliedMerged),
        _ => Err(wire(
            ErrorCode::InvalidParams,
            "unknown conflict resolution",
        )),
    }
}

fn parse_channel_kind(raw: &str) -> Result<ChatChannelKind, WireError> {
    match raw {
        "channel" => Ok(ChatChannelKind::Channel),
        "dm" => Ok(ChatChannelKind::Dm),
        "agent" => Ok(ChatChannelKind::Agent),
        _ => Err(wire(ErrorCode::InvalidParams, "unknown chat channel kind")),
    }
}

fn parse_actor_kind(raw: &str) -> Result<ChatActorKind, WireError> {
    match raw {
        "human" => Ok(ChatActorKind::Human),
        "agent" => Ok(ChatActorKind::Agent),
        _ => Err(wire(ErrorCode::InvalidParams, "unknown chat actor kind")),
    }
}

fn parse_follow_target_kind(raw: &str) -> Result<FollowTargetKind, WireError> {
    match raw {
        "person" => Ok(FollowTargetKind::Person),
        "agent" => Ok(FollowTargetKind::Agent),
        "channel" => Ok(FollowTargetKind::Channel),
        "thread" => Ok(FollowTargetKind::Thread),
        _ => Err(wire(ErrorCode::InvalidParams, "unknown follow target kind")),
    }
}

fn parse_follow_state(raw: &str) -> Result<FollowState, WireError> {
    match raw {
        "following" => Ok(FollowState::Following),
        "unfollowed" => Ok(FollowState::Unfollowed),
        _ => Err(wire(ErrorCode::InvalidParams, "unknown follow state")),
    }
}

fn parse_bookmark_target_kind(raw: &str) -> Result<BookmarkTargetKind, WireError> {
    match raw {
        "message" => Ok(BookmarkTargetKind::Message),
        "thread" => Ok(BookmarkTargetKind::Thread),
        _ => Err(wire(
            ErrorCode::InvalidParams,
            "unknown bookmark target kind",
        )),
    }
}

fn parse_bookmark_mode(raw: &str) -> Result<BookmarkMode, WireError> {
    match raw {
        "live" => Ok(BookmarkMode::Live),
        "snapshot" => Ok(BookmarkMode::Snapshot),
        _ => Err(wire(ErrorCode::InvalidParams, "unknown bookmark mode")),
    }
}

fn reject_capture_origin(origin: Option<&str>) -> Result<(), WireError> {
    if origin == Some("capture") {
        Err(wire(
            ErrorCode::InvalidParams,
            "capture is a reserved origin",
        ))
    } else {
        Ok(())
    }
}

fn channel_json(channel: &ChatChannel) -> Value {
    json!({
        "workspaceId": channel.workspace_id,
        "channelId": channel.channel_id,
        "name": channel.name,
        "slug": channel.slug,
        "kind": match channel.kind {
            ChatChannelKind::Channel => "channel",
            ChatChannelKind::Dm => "dm",
            ChatChannelKind::Agent => "agent",
        },
        "createdAtMs": channel.created_at_ms,
        "updatedAtMs": channel.updated_at_ms,
    })
}

fn feed_channel_json(channel: &ChatChannel) -> Value {
    json!({
        "id": channel.channel_id,
        "workspaceId": channel.workspace_id,
        "name": channel.name,
        "slug": channel.slug,
        "kind": match channel.kind {
            ChatChannelKind::Channel => "channel",
            ChatChannelKind::Dm => "dm",
            ChatChannelKind::Agent => "agent",
        },
        "createdAtMs": channel.created_at_ms,
        "updatedAtMs": channel.updated_at_ms,
    })
}

fn feed_thread_json(thread: &ChatThread) -> Value {
    let mut value = json!({
        "id": thread.thread_id,
        "workspaceId": thread.workspace_id,
        "title": thread.title,
        "createdAtMs": thread.created_at_ms,
        "updatedAtMs": thread.updated_at_ms,
    });
    if let Some(channel_id) = &thread.channel_id {
        value
            .as_object_mut()
            .expect("feed thread is an object")
            .insert("channelId".to_owned(), json!(channel_id));
    }
    value
}

fn feed_message_json(message: &ChatMessage) -> Value {
    let mut value = json!({
        "id": message.message_id,
        "workspaceId": message.workspace_id,
        "threadId": message.thread_id,
        "author": {
            "kind": match message.author_kind {
                ChatActorKind::Human => "human",
                ChatActorKind::Agent => "agent",
            },
            "displayName": message.author_display_name,
        },
        "body": message.body,
        "createdAtMs": message.created_at_ms,
        "attachments": [],
    });
    let object = value.as_object_mut().expect("feed message is an object");
    if let Some(author_user_id) = &message.author_user_id {
        object.insert("authorUserId".to_owned(), json!(author_user_id));
    }
    if let Some(parent_message_id) = &message.parent_message_id {
        object.insert("parentMessageId".to_owned(), json!(parent_message_id));
    }
    if let Some(origin) = &message.origin {
        object.insert("origin".to_owned(), json!(origin));
    }
    value
}

fn follow_target_kind_json(kind: &FollowTargetKind) -> Value {
    json!(match kind {
        FollowTargetKind::Person => "person",
        FollowTargetKind::Agent => "agent",
        FollowTargetKind::Channel => "channel",
        FollowTargetKind::Thread => "thread",
    })
}

fn channel_summary_json(summary: &ChatChannelSummary) -> Value {
    let mut value = channel_json(&summary.channel);
    value["threadCount"] = json!(summary.thread_count);
    value["unreadCount"] = json!(summary.unread_count);
    value
}

fn thread_json(thread: &ChatThread) -> Value {
    json!({
        "workspaceId": thread.workspace_id,
        "threadId": thread.thread_id,
        "title": thread.title,
        "createdAtMs": thread.created_at_ms,
        "updatedAtMs": thread.updated_at_ms,
        "channelId": thread.channel_id,
        "linkedObjectId": thread.linked_object_id,
    })
}

fn message_json(message: &ChatMessage) -> Value {
    json!({
        "workspaceId": message.workspace_id,
        "threadId": message.thread_id,
        "messageId": message.message_id,
        "messageOrder": message.message_order,
        "authorKind": match message.author_kind {
            ChatActorKind::Human => "human",
            ChatActorKind::Agent => "agent",
        },
        "authorDisplayName": message.author_display_name,
        "authorUserId": message.author_user_id,
        "parentMessageId": message.parent_message_id,
        "origin": message.origin,
        "body": message.body,
        "createdAtMs": message.created_at_ms,
    })
}

fn read_state_json(state: &ChatThreadReadState) -> Value {
    json!({
        "workspaceId": state.workspace_id,
        "threadId": state.thread_id,
        "lastReadSequence": state.last_read_sequence,
        "revision": state.revision,
        "updatedAtMs": state.updated_at_ms,
    })
}

fn feed_read_state_json(state: &ChatFeedReadState) -> Value {
    json!({
        "workspaceId": state.workspace_id,
        "ownerUserId": state.owner_user_id,
        "lastSeenCreatedAtMs": state.last_seen_created_at_ms,
        "lastSeenMessageId": state.last_seen_message_id,
        "updatedAtMs": state.updated_at_ms,
    })
}

fn follow_json(workspace_id: &str, follow: &ChatFollow) -> Value {
    json!({
        "workspaceId": workspace_id,
        "ownerUserId": follow.owner_user_id,
        "targetKind": match follow.target_kind {
            FollowTargetKind::Person => "person",
            FollowTargetKind::Agent => "agent",
            FollowTargetKind::Channel => "channel",
            FollowTargetKind::Thread => "thread",
        },
        "targetId": follow.target_id,
        "state": match follow.state {
            FollowState::Following => "following",
            FollowState::Unfollowed => "unfollowed",
        },
        "updatedAtMs": follow.updated_at_ms,
    })
}

fn bookmark_json(workspace_id: &str, bookmark: &ChatBookmark) -> Value {
    json!({
        "bookmarkId": bookmark.bookmark_id,
        "workspaceId": workspace_id,
        "ownerUserId": bookmark.owner_user_id,
        "targetKind": bookmark.target_kind,
        "targetId": bookmark.target_id,
        "threadId": bookmark.thread_id,
        "messageId": bookmark.message_id,
        "mode": bookmark.mode,
        "destinationPath": bookmark.destination_path,
        "state": bookmark.state,
        "generation": bookmark.generation,
        "projectedGeneration": bookmark.projected_generation,
        "projectionState": bookmark.projection_state,
        "projectionObjectId": bookmark.projection_object_id,
        "createdAtMs": bookmark.created_at_ms,
        "updatedAtMs": bookmark.updated_at_ms,
        "lastProjectedAtMs": bookmark.last_projected_at_ms,
        "failureReason": bookmark.failure_reason,
    })
}

fn dispatch_claim_json(claim: &DispatchClaim) -> Value {
    json!({
        "dispatch": {
            "workspaceId": claim.dispatch.workspace_id,
            "triggerMessageId": claim.dispatch.trigger_message_id,
            "threadId": claim.dispatch.thread_id,
            "state": claim.dispatch.state,
            "runId": claim.dispatch.run_id,
            "failureReason": claim.dispatch.failure_reason,
            "attemptCount": claim.dispatch.attempt_count,
            "createdAtMs": claim.dispatch.created_at_ms,
            "updatedAtMs": claim.dispatch.updated_at_ms,
        },
        "run": {
            "workspaceId": claim.run.workspace_id,
            "runId": claim.run.run_id,
            "threadId": claim.run.thread_id,
            "triggerMessageId": claim.run.trigger_message_id,
            "command": claim.run.command,
            "startedAtMs": claim.run.started_at_ms,
            "endedAtMs": claim.run.ended_at_ms,
            "exitCode": claim.run.exit_code,
            "failureReason": claim.run.failure_reason,
            "logPath": claim.run.log_path,
            "failureNotePosted": claim.run.failure_note_posted,
        },
    })
}

fn moment_json(moment: &dohc_engine_domain::MomentRecord) -> Value {
    let after_inband_limit = (moment.after_content_kind == "text"
        && moment.after_text.is_none()
        && moment
            .after_byte_length
            .is_some_and(|length| length as usize > MAX_INBAND_CONTENT_BYTES))
    .then_some(MAX_INBAND_CONTENT_BYTES);
    let before_inband_limit = (moment.before_content_kind == "text"
        && moment.before_text.is_none()
        && moment
            .before_byte_length
            .is_some_and(|length| length as usize > MAX_INBAND_CONTENT_BYTES))
    .then_some(MAX_INBAND_CONTENT_BYTES);
    json!({
        "momentOrder": moment.moment_order,
        "momentId": moment.moment_id,
        "versionId": moment.version_id,
        "objectId": moment.object_id,
        "path": moment.path,
        "recordedAtMs": moment.recorded_at_ms,
        "operation": moment.operation.as_str(),
        "afterContentKind": moment.after_content_kind,
        "afterBlobSha256": moment.after_blob_sha256,
        "afterBinarySha256": moment.after_binary_sha256,
        "beforePresent": moment.before_present,
        "beforeContentKind": moment.before_content_kind,
        "beforeBlobSha256": moment.before_blob_sha256,
        "beforeBinarySha256": moment.before_binary_sha256,
        "beforeLatestMomentId": moment.before_latest_moment_id,
        "metadataOrigin": moment.metadata_origin,
        // PARSED author (TS momentAuthorFromRow parity): absent column =
        // actor-neutral; unparseable JSON surfaces as an explicit corrupt
        // marker, never silently dropped and never trusted raw.
        "author": moment.author_json.as_deref().map(parsed_moment_author),
        "syncRecordOnly": moment.sync_record_only,
        // Hydrated payload text (momentSelectSql parity), each body under
        // the same self-describing in-band cap as every content read.
        "afterText": inband_text(moment.after_text.as_deref()),
        "afterByteLength": moment.after_byte_length,
        "afterInbandLimitBytes": after_inband_limit,
        "beforeText": inband_text(moment.before_text.as_deref()),
        "beforeByteLength": moment.before_byte_length,
        "beforeInbandLimitBytes": before_inband_limit,
    })
}

fn secret_moment_json(moment: &SecretMomentRecord) -> Value {
    json!({
        "id": moment.moment_id,
        "workspaceId": moment.workspace_id,
        "versionId": moment.version_id,
        "path": moment.path,
        "recordedAtMs": moment.recorded_at_ms,
        "operation": moment.operation.as_str(),
        "metadata": {
            "origin": moment.metadata_origin,
            "summary": moment.metadata_summary,
            "correlationId": moment.metadata_correlation_id,
        },
        "momentOrder": moment.moment_order,
        "protected": true,
    })
}

/// Fail-closed author parsing (TS assertMomentAuthor parity): only the
/// exact agent-attribution shape renders as an author; anything else — bad
/// JSON or a hand-edited/wrong shape — surfaces as an explicit corrupt
/// marker, never a valid-looking attribution.
fn parsed_moment_author(raw: &str) -> Value {
    let corrupt = || json!({ "corrupt": true });
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return corrupt();
    };
    let Some(object) = value.as_object() else {
        return corrupt();
    };
    let kind_ok = object.get("kind").and_then(Value::as_str) == Some("agent");
    let nonempty = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty())
    };
    let run_ok = match object.get("agentRunId") {
        None => true,
        Some(Value::String(v)) => !v.is_empty(),
        Some(_) => false,
    };
    if kind_ok && nonempty("agentId") && nonempty("onBehalfOf") && run_ok {
        let mut author = json!({
            "kind": "agent",
            "agentId": object["agentId"],
            "onBehalfOf": object["onBehalfOf"],
        });
        // The contract field is OPTIONAL (`agentRunId?: string`), never
        // nullable — omit it when absent, exactly as pickMomentAuthor does.
        if let Some(run_id) = object.get("agentRunId") {
            author["agentRunId"] = run_id.clone();
        }
        author
    } else {
        corrupt()
    }
}

/// A text body under the in-band cap, or null (the byte length beside it
/// tells the caller what was withheld).
fn inband_text(text: Option<&str>) -> Value {
    match text {
        Some(text) if text.len() <= MAX_INBAND_CONTENT_BYTES => json!(text),
        _ => Value::Null,
    }
}

fn snapshot_json(snapshot: &TextSnapshot) -> Value {
    json!({
        "workspaceId": snapshot.workspace_id,
        "versionId": snapshot.version_id,
        "objectId": snapshot.object_id,
        "path": snapshot.path,
        "text": snapshot.text,
        "contentKind": "text",
        "sha256": snapshot.blob_sha256,
        "byteLength": snapshot.text.len(),
        "blobSha256": snapshot.blob_sha256,
        "updatedAtMs": snapshot.updated_at_ms,
        "latestMomentId": snapshot.latest_moment_id,
        "metadataOrigin": snapshot.metadata_origin
    })
}

fn file_object_json(object: &dohc_engine_domain::FileObjectRecord) -> Value {
    json!({
        "id": object.object_id,
        "workspaceId": object.workspace_id,
        "createdAtMs": object.created_at_ms,
    })
}

fn version_record_json(version: &VersionRecord) -> Value {
    let mut value = json!({
        "id": version.version_id,
        "workspaceId": version.workspace_id,
        "kind": version.kind.as_str(),
        "name": version.name,
        "createdAtMs": version.created_at_ms,
    });
    if let Some(fork_version_id) = &version.fork_version_id {
        let mut fork_point = json!({ "versionId": fork_version_id });
        if let Some(moment_id) = &version.fork_moment_id {
            fork_point["momentId"] = json!(moment_id);
        }
        value["forkPoint"] = fork_point;
    }
    value
}

fn snapshot_metadata_json(
    snapshot: &TextSnapshot,
    content_kind: &str,
    binary_sha256: Option<&str>,
    binary_byte_length: Option<i64>,
) -> Value {
    let (sha256, byte_length) = if content_kind == "binary" {
        (
            binary_sha256.unwrap_or(&snapshot.blob_sha256),
            binary_byte_length.unwrap_or_default().max(0) as usize,
        )
    } else {
        (snapshot.blob_sha256.as_str(), snapshot.text.len())
    };
    json!({
        "workspaceId": snapshot.workspace_id,
        "versionId": snapshot.version_id,
        "objectId": snapshot.object_id,
        "path": snapshot.path,
        "contentKind": content_kind,
        "sha256": sha256,
        "byteLength": byte_length,
        "updatedAtMs": snapshot.updated_at_ms,
        "latestMomentId": snapshot.latest_moment_id,
        "metadataOrigin": snapshot.metadata_origin,
    })
}

fn comparison_wire_status(
    comparison: &dohc_engine_domain::VersionedTextComparison,
) -> &'static str {
    match comparison.status {
        ComparisonStatus::Same | ComparisonStatus::CurrentChanged => "unchanged",
        ComparisonStatus::IncomingChanged => "merged",
        ComparisonStatus::Diverged => match (
            comparison.base.as_ref(),
            comparison.current.as_ref(),
            comparison.incoming.as_ref(),
        ) {
            (Some(base), Some(current), Some(incoming)) => {
                match merge_markdown(&base.text, &current.text, &incoming.text) {
                    MarkdownMergeResult::Merged(_) => "merged",
                    MarkdownMergeResult::Conflict => "conflict",
                }
            }
            _ => "conflict",
        },
    }
}

fn conflict_json(conflict: &TextConflict) -> Value {
    json!({
        "id": conflict.conflict_id,
        "workspaceId": conflict.workspace_id,
        "path": conflict.path,
        "targetVersionId": conflict.target_version_id,
        "sourceVersionId": conflict.source_version_id,
        "createdAtMs": conflict.created_at_ms,
        "updatedAtMs": conflict.updated_at_ms,
        "status": format!("{:?}", conflict.status).to_lowercase(),
        "chosenFrom": format!("{:?}", conflict.chosen_from).to_lowercase(),
        "resolution": conflict.resolution.map(|value| match value {
            ConflictResolution::KeptCurrent => "kept-current",
            ConflictResolution::AppliedIncoming => "applied-incoming",
            ConflictResolution::AppliedMerged => "applied-merged",
        }),
        "metadata": {
            "origin": conflict.metadata.origin,
            "summary": conflict.metadata.summary,
            "correlationId": conflict.metadata.correlation_id
        },
        "base": conflict_state_json(&conflict.base),
        "current": conflict_state_json(&conflict.current),
        "incoming": conflict_state_json(&conflict.incoming)
    })
}

fn conflict_state_json(state: &ConflictFileState) -> Value {
    json!({
        "path": state.path,
        "contentKind": match state.content_kind {
            ConflictContentKind::Text => "text",
            ConflictContentKind::Binary => "binary",
        },
        "snapshot": state.snapshot.as_ref().map(snapshot_json),
        "metadataSummary": state.metadata_summary,
        "metadataCorrelationId": state.metadata_correlation_id
    })
}

fn replicated_conflict_json(outcome: ApplyOutcome<ConflictApplyResult>) -> Value {
    match outcome {
        ApplyOutcome::Applied(result) => {
            let deferred = result.deferred();
            json!({
                "replicated": true,
                "status": "applied",
                "conflictId": result.conflict_id,
                "inserted": result.inserted,
                "matched": result.matched,
                "deferred": deferred,
                "pendingResolve": result.pending_resolve
            })
        }
        ApplyOutcome::Skipped => json!({ "replicated": true, "status": "skipped" }),
        ApplyOutcome::Crashed { committed } => json!({
            "replicated": true,
            "status": "crashed",
            "committed": committed
        }),
    }
}

fn deserialize_optional_non_null_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

fn normalize_rpc_path(path: &str) -> String {
    path.nfc().collect()
}

fn materialize_outcome_name(outcome: PostCommitMaterializeOutcome) -> &'static str {
    match outcome {
        PostCommitMaterializeOutcome::Applied => "applied",
        PostCommitMaterializeOutcome::Skipped => "skipped",
        PostCommitMaterializeOutcome::Conflict => "conflict",
        PostCommitMaterializeOutcome::Superseded => "superseded",
        PostCommitMaterializeOutcome::Error => "error",
    }
}

fn validate_workspace_param(candidate: Option<&str>, resolved: &str) -> Result<(), WireError> {
    if candidate.is_some_and(|candidate| candidate != resolved) {
        return Err(wire(ErrorCode::InvalidParams, "invalid-workspace"));
    }
    Ok(())
}

fn validated_origin(
    origin: Option<&str>,
    legacy_origin: Option<&str>,
) -> Result<String, WireError> {
    let value = origin
        .or(legacy_origin)
        .ok_or_else(|| wire(ErrorCode::InvalidParams, "invalid-metadata"))?;
    match value {
        "api" | "local-file" | "restore" | "sync" | "unknown" => Ok(value.to_owned()),
        // Compatibility for pre-RPC-D callers. The new `origin` field remains
        // the closed five-set; legacy `metadataOrigin: agent` represented an
        // API write before author attribution became a separate field.
        "agent" if origin.is_none() => Ok("api".to_owned()),
        _ => Err(wire(ErrorCode::InvalidParams, "invalid-metadata")),
    }
}

fn validated_author(
    author: Option<&Value>,
    legacy_author_json: Option<&str>,
) -> Result<Option<String>, WireError> {
    if author.is_some() && legacy_author_json.is_some() {
        return Err(wire(ErrorCode::InvalidParams, "invalid-metadata"));
    }
    let value = match author {
        Some(value) => value.clone(),
        None => match legacy_author_json {
            Some(raw) => serde_json::from_str(raw)
                .map_err(|_| wire(ErrorCode::InvalidParams, "invalid-metadata"))?,
            None => return Ok(None),
        },
    };
    let object = value
        .as_object()
        .ok_or_else(|| wire(ErrorCode::InvalidParams, "invalid-metadata"))?;
    let nonempty = |field: &str| {
        object
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
    };
    let run_valid = object
        .get("agentRunId")
        .is_none_or(|value| value.as_str().is_some_and(|value| !value.is_empty()));
    if object.get("kind").and_then(Value::as_str) != Some("agent")
        || !nonempty("agentId")
        || !nonempty("onBehalfOf")
        || !run_valid
    {
        return Err(wire(ErrorCode::InvalidParams, "invalid-metadata"));
    }
    serde_json::to_string(&value)
        .map(Some)
        .map_err(|_| wire(ErrorCode::InvalidParams, "invalid-metadata"))
}

fn parse<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, WireError> {
    serde_json::from_value(value).map_err(|_| wire(ErrorCode::InvalidParams, "invalid parameters"))
}

fn parse_ydoc_content_kind(raw: &str) -> Result<ContentKind, WireError> {
    match raw {
        "plaintext" => Ok(ContentKind::Plaintext),
        "richdoc" => Ok(ContentKind::Richdoc),
        _ => Err(wire(ErrorCode::InvalidParams, "unknown Y.Doc content kind")),
    }
}

fn ydoc_content_kind_name(kind: ContentKind) -> &'static str {
    match kind {
        ContentKind::Plaintext => "plaintext",
        ContentKind::Richdoc => "richdoc",
    }
}

fn validate_ydoc_path(path: &str) -> Result<(), WireError> {
    match dohc_engine_files::classify_engine_file_path_normalized(path) {
        (dohc_engine_files::PathClassification::Tracked, Some(normalized))
            if normalized == path =>
        {
            Ok(())
        }
        _ => Err(wire(ErrorCode::InvalidParams, "invalid Y.Doc path")),
    }
}

fn enforce_workspace(open: &OpenWorkspace, workspace_id: &str) -> Result<(), WireError> {
    if open.workspace_id == workspace_id {
        Ok(())
    } else {
        Err(wire(ErrorCode::InvalidParams, "workspace scope mismatch"))
    }
}

fn now_ms() -> Result<i64, WireError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| wire(ErrorCode::Internal, "system clock unavailable"))?;
    i64::try_from(duration.as_millis())
        .map_err(|_| wire(ErrorCode::Internal, "system clock unavailable"))
}

fn map_runtime(error: RuntimeError) -> WireError {
    if matches!(
        &error,
        RuntimeError::Collab(CollabError::ReplayParityViolation { .. })
    ) {
        return wire(ErrorCode::InvalidParams, "Y.Doc replay parity violation");
    }
    if matches!(
        &error,
        RuntimeError::Collab(CollabError::ObjectAliasCollision)
    ) {
        return wire(ErrorCode::InvalidParams, "ydoc-object-alias-collision");
    }
    if matches!(&error, RuntimeError::Collab(CollabError::UnsettledClose)) {
        return wire(ErrorCode::InvalidParams, "ydoc-unsettled-close");
    }
    if let RuntimeError::Domain(domain) = &error {
        let message = match domain {
            DomainError::IdempotencyKeyReuseMismatch => Some("idempotency-key-reuse-mismatch"),
            DomainError::DuplicateMomentId => Some("duplicate-id"),
            DomainError::FileNotFound => Some("file-not-found"),
            DomainError::TargetPathExists => Some("target-path-exists"),
            DomainError::VersionNotFound => Some("version-not-found"),
            DomainError::InvalidVersion => Some("invalid-version"),
            DomainError::VersionNameConflict => Some("version-name-conflict"),
            DomainError::InvalidVersionName => Some("invalid-version-name"),
            DomainError::DuplicateId => Some("duplicate-id"),
            DomainError::ForkBaseNotFound => Some("fork-base-not-found"),
            DomainError::ConflictStaleTarget => Some("conflict-stale-target"),
            DomainError::InvalidPath { .. } => Some("invalid-path"),
            DomainError::InvalidText { .. } => Some("invalid-text"),
            DomainError::NotSecretPath => Some("not-secret-path"),
            DomainError::SecretMomentNotFound => Some("moment-not-found"),
            DomainError::Crypto(error) => Some(error.code()),
            DomainError::InvalidInput { .. } => Some("invalid-input"),
            DomainError::StateCorrupt { .. } => Some("state-corrupt"),
            DomainError::Storage(_) => Some("persist-failed"),
            _ => None,
        };
        if let Some(message) = message {
            let code = match domain {
                DomainError::Storage(_) | DomainError::StateCorrupt { .. } => ErrorCode::Internal,
                // Same severity split as map_domain_code: decode/key failures
                // are internal state problems, not caller mistakes.
                DomainError::Crypto(error) => match error {
                    dohc_engine_crypto::CryptoError::InvalidIvLength
                    | dohc_engine_crypto::CryptoError::InvalidTagLength
                    | dohc_engine_crypto::CryptoError::PlaintextTooLarge
                    | dohc_engine_crypto::CryptoError::PlaintextNotUtf8
                    | dohc_engine_crypto::CryptoError::InvalidBase64 => ErrorCode::InvalidParams,
                    dohc_engine_crypto::CryptoError::DecryptFailed
                    | dohc_engine_crypto::CryptoError::InvalidKeyLength
                    | dohc_engine_crypto::CryptoError::KeyFileMalformed
                    | dohc_engine_crypto::CryptoError::EnvelopeUnwrapFailed => ErrorCode::Internal,
                },
                _ => ErrorCode::InvalidParams,
            };
            return wire(code, message);
        }
    }
    let code = match error {
        RuntimeError::Overloaded => ErrorCode::Overloaded,
        RuntimeError::Cancelled => ErrorCode::Cancelled,
        RuntimeError::DeadlineExceeded => ErrorCode::DeadlineExceeded,
        RuntimeError::ActorUnavailable | RuntimeError::WorkerPanicked => {
            ErrorCode::WorkspaceUnavailable
        }
        RuntimeError::Domain(error) => map_domain_code(error),
        RuntimeError::Collab(error) => map_collab_code(error),
        RuntimeError::Sync(error) => map_sync_code(error),
        RuntimeError::Search(error) => map_search_code(error),
        _ => ErrorCode::Internal,
    };
    wire(code, "workspace operation failed")
}

fn map_domain_code(error: DomainError) -> ErrorCode {
    match error {
        DomainError::Storage(_)
        | DomainError::StateCorrupt { .. }
        | DomainError::Chat {
            code: "state-corrupt",
            ..
        } => ErrorCode::Internal,
        DomainError::Crypto(error) => match error {
            dohc_engine_crypto::CryptoError::InvalidIvLength
            | dohc_engine_crypto::CryptoError::InvalidTagLength
            | dohc_engine_crypto::CryptoError::PlaintextTooLarge
            | dohc_engine_crypto::CryptoError::PlaintextNotUtf8
            | dohc_engine_crypto::CryptoError::InvalidBase64 => ErrorCode::InvalidParams,
            dohc_engine_crypto::CryptoError::DecryptFailed
            | dohc_engine_crypto::CryptoError::InvalidKeyLength
            | dohc_engine_crypto::CryptoError::KeyFileMalformed
            | dohc_engine_crypto::CryptoError::EnvelopeUnwrapFailed => ErrorCode::Internal,
        },
        DomainError::WorkspaceNotFound
        | DomainError::VersionNotFound
        | DomainError::InvalidVersion
        | DomainError::WorkspaceMismatch
        | DomainError::VersionNameConflict
        | DomainError::InvalidVersionName
        | DomainError::DuplicateId
        | DomainError::DuplicateMomentId
        | DomainError::FileNotFound
        | DomainError::BinaryHeadNotText
        | DomainError::TextHeadNotBinary
        | DomainError::TargetPathExists
        | DomainError::ForkBaseNotFound
        | DomainError::ConflictNotFound
        | DomainError::ConflictStaleTarget
        | DomainError::InvalidText { .. }
        | DomainError::InvalidPath { .. }
        | DomainError::NotSecretPath
        | DomainError::InvalidInput { .. }
        | DomainError::IdempotencyKeyReuseMismatch
        | DomainError::SecretMomentNotFound
        | DomainError::Chat { .. } => ErrorCode::InvalidParams,
        _ => ErrorCode::Internal,
    }
}

fn map_collab_code(error: CollabError) -> ErrorCode {
    match error {
        CollabError::Corrupt { .. } | CollabError::Storage(_) => ErrorCode::Internal,
        CollabError::MalformedUpdate { .. }
        | CollabError::ReplayParityViolation { .. }
        | CollabError::EmptyUpdate
        | CollabError::UpdateTooLarge { .. }
        | CollabError::InvalidIdentifier { .. }
        | CollabError::ContentKindMismatch
        | CollabError::BaseAlreadyClaimed
        | CollabError::BaseStateDiverged
        | CollabError::LeaseHeld
        | CollabError::NoMarker
        | CollabError::MissingDependencies
        | CollabError::ObjectAliasCollision
        | CollabError::SeedOntoExistingLineage
        | CollabError::UnsettledClose => ErrorCode::InvalidParams,
    }
}

fn map_sync_code(error: SyncError) -> ErrorCode {
    match error {
        SyncError::Storage(_)
        | SyncError::SequenceGap
        | SyncError::CoordinateDiverged
        | SyncError::FaultCrash => ErrorCode::Internal,
        SyncError::InvalidInput { .. }
        | SyncError::UnsupportedOperation
        | SyncError::ShareBoundaryViolation
        | SyncError::BlobInvalid => ErrorCode::InvalidParams,
    }
}

fn map_search_code(error: SearchError) -> ErrorCode {
    match error {
        SearchError::Bounds(_) => ErrorCode::InvalidParams,
        SearchError::Storage(_) | SearchError::Store(_) | SearchError::Corrupt(_) => {
            ErrorCode::Internal
        }
    }
}

fn map_shadow_fence(_error: shadow_fence::ShadowFenceError) -> WireError {
    wire(ErrorCode::InvalidParams, "shadow workspace refused")
}

fn workspace_unavailable() -> WireError {
    wire(
        ErrorCode::WorkspaceUnavailable,
        "workspace handle is unavailable",
    )
}

fn wire(code: ErrorCode, message: &'static str) -> WireError {
    WireError::new(code, message)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_runtime::{CompoundWrite, FaultInjector, FaultPoint, LifecycleState};
    use dohc_engine_testkit::{GateFaults, ScratchDir};
    use std::time::Duration;

    const SHADOW_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn runtime_error_mapping_separates_corruption_from_bad_input() {
        let corrupt = map_runtime(RuntimeError::Collab(CollabError::Corrupt {
            reason: "test corrupt lineage".to_owned(),
        }));
        assert_eq!(corrupt.code, ErrorCode::Internal);

        let storage =
            dohc_engine_storage::StorageError::persist_public(rusqlite::Error::InvalidQuery);
        let persisted = map_runtime(RuntimeError::Sync(SyncError::Storage(storage)));
        assert_eq!(persisted.code, ErrorCode::Internal);

        let invalid = map_runtime(RuntimeError::Domain(DomainError::InvalidInput {
            reason: "test invalid input",
        }));
        assert_eq!(invalid.code, ErrorCode::InvalidParams);

        // S1 (BINHEAD): a text read of a binary head is a normal user error, not
        // an internal server fault — it must map to InvalidParams, never fall
        // through the catch-all to Internal.
        let binary_head = map_runtime(RuntimeError::Domain(DomainError::BinaryHeadNotText));
        assert_eq!(binary_head.code, ErrorCode::InvalidParams);
    }

    #[test]
    fn replicated_conflict_json_keeps_deferred_and_adds_pending_resolve() {
        let value = replicated_conflict_json(ApplyOutcome::Applied(ConflictApplyResult {
            conflict_id: "remote-c".to_owned(),
            inserted: None,
            matched: false,
            pending_resolve: Some(dohc_engine_sync::PendingResolve {
                remote_conflict_id: "remote-c".to_owned(),
                local_conflict_id: Some("local-c".to_owned()),
                path: Some("doc.md".to_owned()),
                reason: dohc_engine_sync::PendingResolveReason::BinaryUnhydrated,
            }),
        }));

        assert_eq!(value["deferred"], true);
        assert_eq!(
            value["pendingResolve"],
            json!({
                "remoteConflictId": "remote-c",
                "localConflictId": "local-c",
                "path": "doc.md",
                "reason": "binary-unhydrated"
            })
        );
    }

    #[tokio::test]
    async fn cancelled_workspace_open_does_not_wait_for_open_lock() {
        let service = Arc::new(EngineService::new());
        let held = service.open_lock.lock().await;
        let ctx = RequestContext::unbounded();
        let cancel = ctx.cancel.clone();
        let queued_service = Arc::clone(&service);
        let queued = tokio::spawn(async move {
            queued_service
                .workspace_open(
                    &ctx,
                    json!({
                        "rootDir": std::env::temp_dir().join("dohc-r14-cancelled-open"),
                        "workspaceId": "cancelled-open"
                    }),
                )
                .await
        });

        tokio::task::yield_now().await;
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_millis(250), queued)
            .await
            .expect("cancelled open resolved promptly")
            .expect("queued task completed")
            .expect_err("cancelled queued open must fail");
        assert_eq!(result.code, ErrorCode::Cancelled);
        drop(held);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_workspace_close_keeps_reopen_serialized_until_actor_is_closed() {
        let scratch = ScratchDir::new().expect("scratch");
        shadow_fence::write_shadow_marker_for_harness(scratch.path(), SHADOW_TOKEN)
            .expect("shadow marker");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = Arc::new(EngineService::with_supervisor(supervisor));
        let baseline = supervisor.actor_count();
        let open_params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "cancelled-close"
        });
        let opened = service
            .workspace_open(&RequestContext::unbounded(), open_params.clone())
            .await
            .expect("initial workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        let actor = lock(&service.handles)
            .get(&handle)
            .expect("open workspace")
            .actor
            .clone();

        let gate = GateFaults::at(FaultPoint::StorageBeforePersist);
        let gate_faults: Arc<dyn FaultInjector> = gate.clone();
        let held_write = tokio::spawn(async move {
            actor
                .write_async(
                    CompoundWrite {
                        request_id: "hold-close".to_owned(),
                        doc_id: "held".to_owned(),
                        body: "held".to_owned(),
                        op_kind: "text.write".to_owned(),
                        now_ms: 1,
                    },
                    gate_faults,
                )
                .await
        });
        let gate_wait = gate.clone();
        tokio::task::spawn_blocking(move || gate_wait.wait_until_reached())
            .await
            .expect("gate wait task");

        let closing_service = Arc::clone(&service);
        let closing_handle = handle.clone();
        let closing =
            tokio::spawn(
                async move { closing_service.workspace_close(Some(closing_handle)).await },
            );
        tokio::time::timeout(Duration::from_secs(10), async {
            while lock(&service.handles).contains_key(&handle) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("close removed the handle within the deadline");
        closing.abort();
        assert!(
            closing
                .await
                .expect_err("close request was cancelled")
                .is_cancelled()
        );

        let reopening_service = Arc::clone(&service);
        let mut reopening = tokio::spawn(async move {
            reopening_service
                .workspace_open(&RequestContext::unbounded(), open_params)
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut reopening)
                .await
                .is_err(),
            "reopen must wait for the detached close"
        );
        gate.release();
        held_write
            .await
            .expect("held write task")
            .expect("held write");

        let reopened = tokio::time::timeout(Duration::from_secs(10), reopening)
            .await
            .expect("reopen completed within the deadline")
            .expect("reopen task")
            .expect("workspace reopen");
        let reopened_handle: WorkspaceHandle =
            serde_json::from_value(reopened["workspace"].clone()).expect("reopened handle");
        let reopened_actor = lock(&service.handles)
            .get(&reopened_handle)
            .expect("reopened workspace")
            .actor
            .clone();
        assert_eq!(reopened_actor.lifecycle(), LifecycleState::Ready);
        assert_eq!(supervisor.actor_count(), baseline + 1);

        service
            .workspace_close(Some(reopened_handle))
            .await
            .expect("final workspace close");
        assert_eq!(supervisor.actor_count(), baseline);
    }

    #[tokio::test]
    async fn two_services_share_close_reopen_serialization_for_one_root() {
        let scratch = ScratchDir::new().expect("scratch");
        shadow_fence::write_shadow_marker_for_harness(scratch.path(), SHADOW_TOKEN)
            .expect("shadow marker");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service_a = Arc::new(EngineService::with_supervisor(supervisor));
        let service_b = Arc::new(EngineService::with_supervisor(supervisor));
        let baseline = supervisor.actor_count();
        let open_params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "two-services"
        });
        let opened = service_a
            .workspace_open(&RequestContext::unbounded(), open_params.clone())
            .await
            .expect("service A workspace open");
        let handle_a: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("service A handle");

        let closing_service = Arc::clone(&service_a);
        let closing =
            tokio::spawn(async move { closing_service.workspace_close(Some(handle_a)).await });
        tokio::time::timeout(Duration::from_secs(10), async {
            while !lock(&service_a.handles).is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("service A close removed its handle");
        let opening_service = Arc::clone(&service_b);
        let opening = tokio::spawn(async move {
            opening_service
                .workspace_open(&RequestContext::unbounded(), open_params)
                .await
        });

        tokio::time::timeout(Duration::from_secs(10), closing)
            .await
            .expect("service A close completed within the deadline")
            .expect("service A close task")
            .expect("service A close");
        let reopened = tokio::time::timeout(Duration::from_secs(10), opening)
            .await
            .expect("service B open completed within the deadline")
            .expect("service B open task")
            .expect("service B reopen");
        let handle_b: WorkspaceHandle =
            serde_json::from_value(reopened["workspace"].clone()).expect("service B handle");
        let actor_b = lock(&service_b.handles)
            .get(&handle_b)
            .expect("service B workspace")
            .actor
            .clone();
        assert_eq!(actor_b.lifecycle(), LifecycleState::Ready);
        assert_eq!(supervisor.actor_count(), baseline + 1);

        service_b
            .workspace_close(Some(handle_b))
            .await
            .expect("service B close");
        assert_eq!(supervisor.actor_count(), baseline);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capture_driver_status_tracks_the_workspace_lifecycle() {
        let scratch = ScratchDir::new().expect("scratch");
        shadow_fence::write_shadow_marker_for_harness(scratch.path(), SHADOW_TOKEN)
            .expect("shadow marker");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = Arc::new(EngineService::with_supervisor(supervisor));
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "driver-status"
                }),
            )
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");

        let status = {
            let guard = lock(&service.handles);
            let open = guard.get(&handle).expect("open workspace");
            let capture = lock(&open.capture);
            Arc::clone(capture.as_ref().expect("driver present").status())
        };
        // The files layer comes up shortly after open (watcher attach +
        // baseline reconcile) and must not be degraded on the happy path.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while !status.running() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "driver never reported running"
            );
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(!status.degraded(), "happy path must not be degraded");

        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");
        // Close drains the driver fully: running flips off.
        assert!(!status.running(), "driver reports stopped after close");
    }

    #[tokio::test]
    async fn interleaved_workspace_reopens_return_live_actors_without_leaks() {
        let scratch = ScratchDir::new().expect("scratch");
        shadow_fence::write_shadow_marker_for_harness(scratch.path(), SHADOW_TOKEN)
            .expect("shadow marker");
        // Isolated supervisor so the actor-count baseline can't race other tests
        // sharing the process-global one.
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = Arc::new(EngineService::with_supervisor(supervisor));
        let baseline = service.supervisor.actor_count();
        let open_params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "open-close-race"
        });
        let opened = service
            .workspace_open(&RequestContext::unbounded(), open_params.clone())
            .await
            .expect("initial workspace open");
        let mut handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");

        for _ in 0..128 {
            let closing_service = Arc::clone(&service);
            let closing_handle = handle.clone();
            let closing =
                tokio::spawn(
                    async move { closing_service.workspace_close(Some(closing_handle)).await },
                );
            tokio::time::timeout(Duration::from_secs(10), async {
                while lock(&service.handles).contains_key(&handle) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("close removed the handle within the deadline");

            let opening_service = Arc::clone(&service);
            let iteration_params = open_params.clone();
            let opening = tokio::spawn(async move {
                opening_service
                    .workspace_open(&RequestContext::unbounded(), iteration_params)
                    .await
            });
            closing
                .await
                .expect("close task completed")
                .expect("workspace close");
            let reopened = opening
                .await
                .expect("open task completed")
                .expect("workspace reopen");
            handle = serde_json::from_value(reopened["workspace"].clone())
                .expect("reopened workspace handle");
            service
                .conflicts_list(
                    &RequestContext::unbounded(),
                    Some(handle.clone()),
                    json!({}),
                )
                .await
                .expect("reopened actor is live");
        }

        service
            .workspace_close(Some(handle))
            .await
            .expect("final workspace close");
        assert_eq!(service.supervisor.actor_count(), baseline);
    }
}
