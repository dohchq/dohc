//! Shadow-only composition host for the Rust workspace engine.

#![forbid(unsafe_code)]

pub(crate) mod capture_driver;
pub mod capture_sink;
pub mod cutover_rehearse;
#[cfg(feature = "harness")]
pub mod rehearsal_harness;
pub mod shadow_fence;

#[cfg(feature = "harness")]
pub use capture_driver::CaptureApplyProbe;
pub use capture_sink::{SelfWriteSuppression, StoreCaptureSink};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use dohc_engine_collab::{CollabError, ContentKind, DocKey, Lease, LeaseRegistry, Regime};
use dohc_engine_domain::{
    AgentRunRecord, BookmarkMode, BookmarkTargetKind, ChannelThreadSummary, ChatActorKind,
    ChatAgentReadState, ChatAttachment, ChatBookmark, ChatChannel, ChatChannelKind,
    ChatChannelSummary, ChatDecision, ChatDecisionState, ChatFeedReadState, ChatFileMention,
    ChatFollow, ChatMention, ChatMessage, ChatProjectionFileAccess, ChatReaction,
    ChatReactionState, ChatThread, ChatThreadReadState, CompareTextFileVersions, ComparisonStatus,
    ConflictChoice, ConflictContentKind, ConflictFileState, ConflictMetadata, ConflictResolution,
    ConflictStatus, CreateFileThread, CreateNamedVersion, DeleteTextFile, DispatchClaim,
    DispatchRecord, DomainError, FeedCursorValue, FollowState, FollowTargetKind,
    LocalAttachmentInput, MentionCursor, MergeTextFileFromVersion, MergeTextFileResult,
    MergeUnchangedReason, MomentOp, RenameTextFile, ResolveConflictKind, ResolveDecision,
    ResolveTextConflict, RollbackTextFileMutation, SaveBookmark, SecretDelete, SecretDiskIntent,
    SecretMomentRecord, SecretWrite, SendMessage, SetFollow, SetReaction, StartChannelThread,
    TextConflict, TextSnapshot, ThreadDispatchPause, VersionFileChangeStatus, VersionRecord,
    WriteBinary, WriteText, validate_addressable_plaintext_path,
};
use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    transport::{
        BlobEgress, EngineService as ProtocolEngineService, RequestContext, ServiceResponse,
    },
    wire::{Request, Response, WorkspaceHandle},
};
use dohc_engine_runtime::{
    ActorHandle, ApplyOutcome, CancellationToken, ConflictApplyResult, LifecycleState, NoFaults,
    PostCommitMaterializeOutcome, RelayConfiguration, RelayOperation, RelayOperationOutcome,
    RuntimeError, SearchError, SearchPageDisposition, SearchResultKey, SearchSurface,
    WorkspaceSupervisor,
};
use dohc_engine_sync::{
    RelayCursor, RelayError, ReplicationEnvelope, ShareCursor, SyncError, SyncPassOutcome,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_OPEN_HANDLES: usize = 64;
const CHAT_DISPATCH_MAX_ATTEMPTS: i64 = 2;

/// Emitted once per settled capture batch / reconcile pass that settled any
/// path — a REPAINT PING, not a moment ledger. Most emissions follow new
/// moment rows (ingests, retires, policy/non-ownable/secret untracks), but
/// content-equality dedupes and no-op retires fire it too: the renderer
/// re-lists cheaply, and under-notifying is the staleness bug this event
/// exists to prevent. In daemon mode no TS write path runs, so nothing else
/// announces these writes.
pub const CAPTURE_MOMENT_RECORDED_EVENT: &str = "capture.momentRecorded";

/// An engine-initiated notification for the transport host to deliver as a
/// wire `Event` envelope. The service assigns only the NAME and PAYLOAD;
/// the per-session `seq`/`sessionGeneration` belong to the transport.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineEventNotice {
    pub name: String,
    pub payload: Value,
}

/// How many undelivered notices the service-to-transport queue holds before
/// new ones are DROPPED. Notices are repaint pings, so any queued backlog
/// already guarantees the consumer will re-list on drain — dropping under a
/// stalled transport loses nothing while keeping capture activity from
/// growing the daemon without bound.
const ENGINE_EVENT_QUEUE_CAPACITY: usize = 256;

/// Cloneable emitter handle shared between the service and its background
/// tasks (the capture driver). At most one subscriber (the stdio host); with
/// no subscriber, notices are dropped — an embedded in-process host that
/// never subscribes owes no drain.
#[derive(Clone, Default)]
pub struct EngineEvents {
    subscriber: Arc<Mutex<Option<tokio::sync::mpsc::Sender<EngineEventNotice>>>>,
}

impl EngineEvents {
    /// Route subsequent notices to the returned receiver, replacing any
    /// previous subscriber. The channel is BOUNDED: a transport that stops
    /// draining (blocked Electron main thread) sheds notices instead of
    /// accumulating them, and the ones already queued make the eventual
    /// drain repaint anyway.
    pub fn subscribe(&self) -> tokio::sync::mpsc::Receiver<EngineEventNotice> {
        let (tx, rx) = tokio::sync::mpsc::channel(ENGINE_EVENT_QUEUE_CAPACITY);
        *lock(&self.subscriber) = Some(tx);
        rx
    }

    pub(crate) fn emit(&self, name: &str, payload: Value) {
        let mut subscriber = lock(&self.subscriber);
        let Some(tx) = subscriber.as_ref() else {
            return;
        };
        match tx.try_send(EngineEventNotice {
            name: name.to_owned(),
            payload,
        }) {
            // A full queue sheds the notice (see `subscribe`); the emitter
            // must never block a capture apply on a stalled transport.
            Ok(()) | Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {}
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                // The receiver is gone; drop it so later emits stop cloning
                // payloads into a dead channel.
                *subscriber = None;
            }
        }
    }
}

/// In-band CONTENT (binary bytes, secret plaintext) uses the capture contract's
/// smaller request cap. Larger binary blobs use the full-range write endpoint
/// or raw blob-chunk egress.
const MAX_INBAND_CONTENT_BYTES: usize = dohc_engine_domain::INBAND_CONTENT_CAP_BYTES;
const MAX_DESKTOP_CAPTURE_TEXT_BYTES: usize = 128 * 1024;
const MAX_METADATA_FIELD_BYTES: usize = 16 * 1024;

/// Aggregate hydrated blob bytes allowed to wait for or flow through framed
/// egress. A single stored blob may be this large, so exact-byte reservations
/// allow one maximum-sized response or multiple smaller responses up to the
/// same fixed resident-memory ceiling.
const BLOB_EGRESS_BYTE_BUDGET: usize = dohc_engine_storage::MAX_BLOB_BYTES;

/// Largest raw Y.Doc full-state that still fits one wire string once
/// base64-expanded (4/3): DOP1's `max_string_bytes` divided by 4,
/// times 3. Refusing here surfaces a clean error instead of the framer
/// rejecting the whole response (which InProcessTransport would not even
/// catch). Docs beyond this belong to the blob-chunk streaming path.
const MAX_YDOC_STATE_WIRE_BYTES: usize =
    (dohc_engine_protocol::limits::WireLimits::SPIKE_DEFAULTS.max_string_bytes as usize / 4) * 3;

/// How many bytes a string occupies once JSON-encoded, quotes included.
///
/// `check_string` bounds the DECODED length, so only the frame limit catches
/// escaping — and escaping is not a rounding error: every newline, quote and
/// backslash doubles, and every other control byte becomes six. A caller
/// measured against raw bytes would be told a body fits when the encoded
/// request cannot cross the wire at all.
fn json_string_encoded_len(text: &str) -> usize {
    text.bytes().fold(2, |len, byte| {
        len + match byte {
            b'"' | b'\\' | 0x08 | 0x09 | 0x0a | 0x0c | 0x0d => 2,
            0x00..=0x1f => 6,
            _ => 1,
        }
    })
}

/// The encoded size of the request envelope that carried these params — what
/// the control frame actually held.
///
/// Every field is the CALLER'S OWN: this request's id, deadline, workspace
/// handle, idempotency key and params, re-encoded by the same encoder the
/// transport uses. Nothing is reserved and nothing is substituted. A
/// worst-case stand-in for a field the daemon can read (this one used
/// `u64::MAX` and `u32::MAX` for the id and deadline) inflates the total by
/// about thirty bytes, which rejects requests that DID cross the frame and
/// reports a size that never existed — a limit must name what happened.
fn resolve_request_encoded_bytes(
    id: u64,
    deadline_ms: Option<u32>,
    handle: Option<&WorkspaceHandle>,
    idempotency_key: Option<&str>,
    params: &Value,
) -> usize {
    let envelope =
        dohc_engine_protocol::wire::Envelope::Request(dohc_engine_protocol::wire::Request {
            id,
            method: "conflicts.resolve".to_owned(),
            workspace: handle.cloned(),
            deadline_ms,
            idempotency_key: idempotency_key.map(str::to_owned),
            params: json!({}),
        });
    let envelope_bytes = serde_json::to_vec(&envelope).map_or(usize::MAX, |bytes| bytes.len());
    let params_bytes = serde_json::to_vec(params).map_or(usize::MAX, |bytes| bytes.len());
    // `- 2` drops the empty object measured in the params slot.
    envelope_bytes
        .saturating_sub(2)
        .saturating_add(params_bytes)
}

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
    byte_budget_cut_serialized_with_row_cap(rows, budget, SINGLE_ROW_HARD_CAP_BYTES)
}

fn byte_budget_cut_serialized_with_row_cap(
    rows: &[Value],
    budget: usize,
    single_row_hard_cap_bytes: usize,
) -> usize {
    let mut included = 0usize;
    let mut remaining = budget as i64;
    for row in rows {
        let size = serde_json::to_string(row).map_or(0, |s| s.len());
        // A first row may exceed the PAGE budget (progress guarantee) but
        // never the hard single-row bound — beyond that it cannot ship
        // in a frame at all, and the caller must surface the refusal
        // rather than emit an over-frame response.
        if included == 0 && size > single_row_hard_cap_bytes {
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

#[derive(Clone)]
struct BlobEgressBudget {
    permits: Arc<tokio::sync::Semaphore>,
}

impl BlobEgressBudget {
    fn new(byte_budget: usize) -> Self {
        BlobEgressBudget {
            permits: Arc::new(tokio::sync::Semaphore::new(byte_budget)),
        }
    }

    async fn reserve(
        &self,
        byte_length: i64,
        cancellation: &OperationCancellation,
    ) -> Result<tokio::sync::OwnedSemaphorePermit, WireError> {
        let bytes = usize::try_from(byte_length)
            .ok()
            .filter(|bytes| *bytes <= BLOB_EGRESS_BYTE_BUDGET)
            .and_then(|bytes| u32::try_from(bytes).ok())
            .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                Err(cancellation.interruption("versionedBinary.readBlob (egress budget)"))
            }
            permit = Arc::clone(&self.permits).acquire_many_owned(bytes) => {
                permit.map_err(|_| wire(ErrorCode::Internal, "blob egress budget unavailable"))
            }
        }
    }
}

/// The most one serialized row may occupy: safely under the 1 MiB frame
/// limit with envelope headroom.
const SINGLE_ROW_HARD_CAP_BYTES: usize = 700 * 1024;

/// Approximate serialized-bytes budget for one chat list/messages page —
/// the same measured discipline as every other list family.
const CHAT_PAGE_BYTE_BUDGET: usize = 256 * 1024;
const GRANULAR_CHAT_RESPONSE_BYTE_BUDGET: usize = 256 * 1024;
const CONFLICTS_PAGE_BYTE_BUDGET: usize = 256 * 1024;
const CONFLICTS_RESPONSE_ROW_LIMIT: usize =
    dohc_engine_domain::TEXT_CONFLICT_QUERY_LIMIT as usize - 1;
/// Conflict rows are the only hydration surface for the three full-text
/// sides. Let any row that fits the negotiated 8 MiB control frame progress,
/// retaining explicit envelope and continuation headroom.
const CONFLICT_ROW_HARD_CAP_BYTES: usize =
    dohc_engine_protocol::limits::WireLimits::SPIKE_DEFAULTS.max_frame_bytes as usize - 64 * 1024;
/// What a hand-combined resolution is bounded by: the control frame that has
/// to carry the whole REQUEST. Not the body alone, and not a fixed headroom
/// beside it — the same request also carries two 16 KiB metadata fields, a
/// path, four identifiers and an idempotency key, each of which can double
/// under escaping. Every conflict a caller can list can still be combined and
/// applied; what a body gets is whatever the rest of its request leaves.
///
/// MEASURED ON THE ENCODED REQUEST (`resolve_request_encoded_bytes`). The
/// frame carries encoded bytes and `check_string` bounds decoded ones, so
/// escaping is invisible to every other limit on this path: 4,194,304
/// newlines are 4 MiB raw and 8 MiB encoded.
const RESOLVE_REQUEST_FRAME_BYTES: usize =
    dohc_engine_protocol::limits::WireLimits::SPIKE_DEFAULTS.max_frame_bytes as usize;
const SEARCH_PAGE_BYTE_BUDGET: usize = 256 * 1024;

const CHAT_PAGE_LIMIT_DEFAULT: i64 = 200;
const CHAT_PAGE_LIMIT_MAX: i64 = 500;

/// Versioned, opaque continuation state for the RPC-B2 chat families. The
/// binding is a digest over method + authenticated workspace + logical
/// filters, so a cursor cannot be replayed against another view.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatKeysetCursor {
    version: u8,
    binding: String,
    consumed: i64,
    first: i64,
    second: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    third: Option<String>,
}

/// Opaque generation-bound keyset cursor for workspace search.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchPageCursor {
    version: u8,
    binding: String,
    active_version_id: String,
    consumed: usize,
    generation: u64,
    surface: String,
    rowid: i64,
    line: usize,
}

fn chat_cursor_binding(method: &str, workspace_id: &str, filters: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for field in std::iter::once(method)
        .chain(std::iter::once(workspace_id))
        .chain(filters.iter().copied())
    {
        hasher.update(field.as_bytes());
        hasher.update([0]);
    }
    let digest = hasher.finalize();
    let mut binding = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(binding, "{byte:02x}");
    }
    binding
}

fn encode_chat_cursor(cursor: &ChatKeysetCursor) -> Result<String, WireError> {
    let bytes =
        serde_json::to_vec(cursor).map_err(|_| wire(ErrorCode::Internal, "state-corrupt"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_chat_cursor(
    encoded: Option<&str>,
    expected_binding: &str,
) -> Result<Option<ChatKeysetCursor>, WireError> {
    let Some(encoded) = encoded else {
        return Ok(None);
    };
    let invalid = || wire(ErrorCode::InvalidParams, "invalid-cursor");
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid())?;
    let cursor: ChatKeysetCursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if cursor.version != 1
        || cursor.binding != expected_binding
        || cursor.consumed < 0
        || cursor.second.is_empty()
    {
        return Err(invalid());
    }
    Ok(Some(cursor))
}

fn encode_search_cursor(cursor: &SearchPageCursor) -> Result<String, WireError> {
    let bytes =
        serde_json::to_vec(cursor).map_err(|_| wire(ErrorCode::Internal, "state-corrupt"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_search_cursor(
    encoded: Option<&str>,
    expected_binding: &str,
    limit: usize,
) -> Result<Option<SearchPageCursor>, WireError> {
    let Some(encoded) = encoded else {
        return Ok(None);
    };
    let invalid = || wire(ErrorCode::InvalidParams, "invalid-cursor");
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid())?;
    let cursor: SearchPageCursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if cursor.version != 3
        || cursor.binding != expected_binding
        || cursor.active_version_id.is_empty()
        || cursor.consumed >= limit
        || !matches!(cursor.surface.as_str(), "file" | "chat")
        || cursor.rowid <= 0
    {
        return Err(invalid());
    }
    Ok(Some(cursor))
}

fn chat_page_limit(value: Option<i64>) -> Result<i64, WireError> {
    let value = value.unwrap_or(CHAT_PAGE_LIMIT_DEFAULT);
    if !(1..=CHAT_PAGE_LIMIT_MAX).contains(&value) {
        return Err(wire(ErrorCode::InvalidParams, "invalid-parameters"));
    }
    Ok(value)
}

fn bounded_chat_page_len(rows: &[Value]) -> Result<usize, WireError> {
    let included = byte_budget_cut_serialized(rows, CHAT_PAGE_BYTE_BUDGET);
    if included == 0 && !rows.is_empty() {
        return Err(wire(ErrorCode::LimitExceeded, "row-exceeds-wire-limit"));
    }
    Ok(included)
}

fn chat_page_cursor<T>(
    rows: &[T],
    included: usize,
    consumed: i64,
    binding: String,
    coordinate: impl FnOnce(&T) -> (i64, String),
) -> Result<Option<String>, WireError> {
    if rows.len() <= included {
        return Ok(None);
    }
    let last = rows
        .get(included.saturating_sub(1))
        .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
    let (first, second) = coordinate(last);
    encode_chat_cursor(&ChatKeysetCursor {
        version: 1,
        binding,
        consumed: consumed + included as i64,
        first,
        second,
        third: None,
    })
    .map(Some)
}

#[derive(Clone)]
struct OpenWorkspace {
    root: PathBuf,
    db_path: PathBuf,
    workspace_id: String,
    actor: ActorHandle,
    mode: WorkspaceOpenMode,
    handle_kind: WorkspaceHandleKind,
    relay: Option<RelayConfiguration>,
    /// The autonomous capture driver (files actor + watcher + reconcile
    /// loop), spawned only after the shadow binding succeeded. Shared so the
    /// teardown paths can take it exactly once.
    capture: Arc<Mutex<Option<capture_driver::CaptureDriver>>>,
    /// Held by every capture reconcile+apply and by versions.setActive across
    /// its forced full scan plus switch transaction. This drains an in-flight
    /// apply and prevents a new one from resolving the destination version
    /// across the active-version boundary.
    capture_apply_gate: capture_driver::ApplyGate,
    /// Serializes Y.Doc admission and versioned mutations for this workspace.
    /// Version fences retain this gate through their destructive continuation,
    /// without stalling editor traffic in unrelated open workspaces.
    session_ops: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkspaceOpenMode {
    Full,
    ReadOnly,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum WorkspaceHandleKind {
    Owner,
    ReadOnlyAttach { owner: WorkspaceHandle },
}

impl WorkspaceHandleKind {
    fn owns_binding(&self) -> bool {
        matches!(self, Self::Owner)
    }

    fn is_attached_to(&self, handle: &WorkspaceHandle) -> bool {
        matches!(self, Self::ReadOnlyAttach { owner } if owner == handle)
    }
}

#[derive(Clone)]
enum IssuedCursor {
    Relay(RelayCursor),
    ShareView(ShareCursor),
}

#[derive(Clone)]
struct PendingCursor {
    handle: WorkspaceHandle,
    workspace_id: String,
    cursor: IssuedCursor,
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
    last_settled_sha: Option<String>,
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

struct WorkspaceBarriers {
    _capture: tokio::sync::OwnedMutexGuard<()>,
    _sessions: tokio::sync::OwnedMutexGuard<()>,
}

enum VersionFenceIntent {
    Fork {
        input: CreateNamedVersion,
    },
    Switch {
        target_version_id: String,
        now_ms: i64,
    },
}

enum VersionFenceOutcome {
    AlreadyActive,
    CreateReplay(VersionRecord),
    Committed(VersionRecord),
}

/// Protocol service composing domain operations on the runtime actor's sole
/// writable `EngineStore` connection.
///
/// INVARIANT: exactly one `EngineService` owns each live physical `engine.db`.
/// Read-intent opens get non-owning handles over that service's binding;
/// cross-service or aliased attachments remain rejected so barriers cannot split.
pub struct EngineService {
    supervisor: &'static WorkspaceSupervisor,
    handles: Mutex<HashMap<WorkspaceHandle, OpenWorkspace>>,
    pending_cursors: Mutex<HashMap<String, PendingCursor>>,
    open_lock: tokio::sync::Mutex<()>,
    next_handle: std::sync::atomic::AtomicU64,
    sessions: Arc<Mutex<HashMap<String, YdocSession>>>,
    leases: LeaseRegistry,
    next_session: std::sync::atomic::AtomicU64,
    /// Unique per service INSTANCE (process id + construction time):
    /// session ids seed client-side idempotency keys that persist in
    /// `engine_requests`, so ids restarting from 1 each daemon lifetime
    /// would collide a fresh session's first requests with a prior
    /// lifetime's ledger rows (hash-mismatch refusals or false dedupes).
    session_epoch: String,
    self_writes: SelfWriteSuppression,
    events: EngineEvents,
    #[cfg(feature = "harness")]
    capture_apply_probe: Option<capture_driver::CaptureApplyProbe>,
    /// PER-EngineService by design. Production runs exactly ONE EngineService per
    /// daemon process (the stdio host constructs a single service), so the
    /// `BLOB_EGRESS_BYTE_BUDGET` resident-memory ceiling is per-process there.
    /// The budget is per-instance (not a process-global static) so tests can
    /// inject a small deterministic budget; if a future host ever runs multiple
    /// EngineServices in one process, back this with a shared/global semaphore to
    /// keep the ceiling aggregate.
    blob_egress_budget: BlobEgressBudget,
}

impl Drop for EngineService {
    fn drop(&mut self) {
        let open: Vec<(WorkspaceHandle, OpenWorkspace)> = match self.handles.get_mut() {
            Ok(handles) => handles
                .drain()
                .filter(|(_, open)| open.handle_kind.owns_binding())
                .collect(),
            Err(poisoned) => poisoned
                .into_inner()
                .drain()
                .filter(|(_, open)| open.handle_kind.owns_binding())
                .collect(),
        };
        if open.is_empty() {
            return;
        }

        let sessions = Arc::clone(&self.sessions);
        let self_writes = self.self_writes.clone();
        let supervisor = self.supervisor;
        let cleanup = EngineServiceCleanup {
            open,
            sessions,
            self_writes,
            supervisor,
        };
        // The entered runtime may be in its final `block_on`; a task spawned
        // onto it can be discarded immediately after this Drop returns.
        // Teardown therefore always owns both its thread and runtime.
        let cleanup = Arc::new(Mutex::new(Some(cleanup)));
        let thread_cleanup = Arc::clone(&cleanup);
        if std::thread::Builder::new()
            .name("dohc-service-drop".to_owned())
            .spawn(move || {
                let Some(cleanup) = lock(&thread_cleanup).take() else {
                    return;
                };
                match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime.block_on(cleanup.run()),
                    Err(_) => cleanup.close_synchronously(),
                }
            })
            .is_err()
            && let Some(cleanup) = lock(&cleanup).take()
        {
            cleanup.close_synchronously();
        }
    }
}

struct EngineServiceCleanup {
    open: Vec<(WorkspaceHandle, OpenWorkspace)>,
    sessions: Arc<Mutex<HashMap<String, YdocSession>>>,
    self_writes: SelfWriteSuppression,
    supervisor: &'static WorkspaceSupervisor,
}

impl EngineServiceCleanup {
    async fn run(self) {
        for (handle, workspace) in self.open {
            let _capture = Arc::clone(&workspace.capture_apply_gate).lock_owned().await;
            let _sessions = Arc::clone(&workspace.session_ops).lock_owned().await;
            lock(&self.sessions).retain(|_, session| session.workspace != handle);
            workspace.shutdown_capture().await;
            let db_path = workspace.db_path.clone();
            let root = workspace.root.clone();
            let workspace_id = workspace.workspace_id.clone();
            let supervisor = self.supervisor;
            let _ = tokio::task::spawn_blocking(move || supervisor.close(&db_path)).await;
            self.self_writes
                .scoped(&root)
                .clear_workspace(&workspace_id);
        }
    }

    fn close_synchronously(self) {
        for (handle, workspace) in self.open {
            lock(&self.sessions).retain(|_, session| session.workspace != handle);
            let _ = workspace.begin_capture_shutdown();
            let _ = self.supervisor.close(&workspace.db_path);
            self.self_writes
                .scoped(&workspace.root)
                .clear_workspace(&workspace.workspace_id);
        }
    }
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
            pending_cursors: Mutex::new(HashMap::new()),
            open_lock: tokio::sync::Mutex::new(()),
            next_handle: std::sync::atomic::AtomicU64::new(1),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            leases: {
                // ONE process-wide registry remains a defense in depth for
                // non-service actor users. EngineService itself rejects a
                // second attachment to an already-live physical engine.db, so
                // one service owns all session admission for that actor.
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
                // Process-wide so suppression survives service replacement
                // during close/reopen and remains collision-safe across
                // distinct workspaces (keys include the scoped root).
                static GLOBAL_SELF_WRITES: std::sync::LazyLock<SelfWriteSuppression> =
                    std::sync::LazyLock::new(SelfWriteSuppression::default);
                GLOBAL_SELF_WRITES.clone()
            },
            events: EngineEvents::default(),
            #[cfg(feature = "harness")]
            capture_apply_probe: None,
            blob_egress_budget: BlobEgressBudget::new(BLOB_EGRESS_BYTE_BUDGET),
        }
    }

    #[cfg(feature = "harness")]
    pub fn with_capture_apply_probe_for_harness(probe: CaptureApplyProbe) -> Self {
        let mut service = Self::new();
        service.capture_apply_probe = Some(probe);
        service
    }

    async fn dispatch(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        let id = request.id;
        self.ensure_handle_allows_method(request.workspace.as_ref(), &request.method)?;
        if request.method == "versionedBinary.readBlob" {
            let (result, blob_egress) = self
                .versioned_binary_read_blob(&ctx, request.workspace, request.params, id)
                .await?;
            return Ok(ServiceResponse {
                response: Response { id, result },
                blob_egress,
            });
        }
        if request.method == "versionedText.readBlob" {
            let (result, blob_egress) = self
                .versioned_text_read_blob(&ctx, request.workspace, request.params, id)
                .await?;
            return Ok(ServiceResponse {
                response: Response { id, result },
                blob_egress,
            });
        }
        let result = match request.method.as_str() {
            "engine.ping" => engine_ping(),
            "workspace.open" => self.workspace_open(&ctx, request.params).await?,
            "workspace.close" => self.workspace_close(request.workspace).await?,
            "sync.push" => {
                Box::pin(self.sync_push(&ctx, request.workspace, request.params)).await?
            }
            "sync.pull" => {
                Box::pin(self.sync_pull(&ctx, request.workspace, request.params)).await?
            }
            "sync.commitCursor" => {
                Box::pin(self.sync_commit_cursor(&ctx, request.workspace, request.params)).await?
            }
            "sync.probe" => {
                Box::pin(self.sync_probe(&ctx, request.workspace, request.params)).await?
            }
            "sync.claim" => {
                Box::pin(self.sync_claim(&ctx, request.workspace, request.params)).await?
            }
            "sync.adoptJoinIdentity" => {
                Box::pin(self.sync_adopt_join_identity(&ctx, request.workspace, request.params))
                    .await?
            }
            "sync.recoverOrigin" => {
                Box::pin(self.sync_recover_origin(&ctx, request.workspace, request.params)).await?
            }
            "keys.upload" => {
                Box::pin(self.keys_upload(&ctx, request.workspace, request.params)).await?
            }
            "keys.download" => {
                Box::pin(self.keys_download(&ctx, request.workspace, request.params)).await?
            }
            "share.channel.pull" => {
                Box::pin(self.share_channel_pull(&ctx, request.workspace, request.params)).await?
            }
            "share.channel.push" => {
                Box::pin(self.share_channel_push(&ctx, request.workspace, request.params)).await?
            }
            "share.view.pull" => {
                Box::pin(self.share_view_pull(&ctx, request.workspace, request.params)).await?
            }
            "versionedText.write" => {
                self.versioned_text_write(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedBinary.write" => {
                self.versioned_binary_write(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedBinary.writeBlob" => {
                self.versioned_binary_write_blob(&ctx, &request, request.params.clone())
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
                    request.id,
                    request.deadline_ms,
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
            "search.queryPage" => {
                self.search_query_page(&ctx, request.workspace, request.params)
                    .await?
            }
            "search.queryChatMessagesGranular" => {
                self.search_query_chat_messages_granular(&ctx, request.workspace, request.params)
                    .await?
            }
            "search.ensureIndex" => {
                self.search_ensure_index(&ctx, request.workspace, request.params)
                    .await?
            }
            "watcher.status" => self.watcher_status(request.workspace)?,
            "capture.flush" => self.capture_flush(&ctx, request.workspace).await?,
            "capture.setAuthor" => {
                self.capture_set_author(&ctx, request.workspace, request.params)
                    .await?
            }
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
            "secrets.stateExists" => {
                self.secrets_state_exists(&ctx, request.workspace, request.params)
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
            "chats.threads.create" => {
                self.chats_threads_create(
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
            "chats.threads.listForFile" => {
                self.chats_threads_list_for_file(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.threads.listForChannel" => {
                self.chats_threads_list_for_channel(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.threads.findChannelId" => {
                self.chats_threads_find_channel_id(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.threads.getProjection" => {
                self.chats_threads_get_projection(&ctx, request.workspace, request.params)
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
            "chats.decisions.resolve" => {
                self.chats_decisions_resolve(
                    &ctx,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
                .await?
            }
            "chats.decisions.listForThread" => {
                self.chats_decisions_list_for_thread(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.reactions.set" => {
                self.chats_reactions_set(
                    &ctx,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
                .await?
            }
            "chats.reactions.list" => {
                self.chats_reactions_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.attachments.listForThread" => {
                self.chats_attachments_list_for_thread(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.attachments.listFileMentions" => {
                self.chats_attachments_list_file_mentions(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.mentions.listForHandle" => {
                self.chats_mentions_list_for_handle(&ctx, request.workspace, request.params)
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
            "chats.readState.listUnreadFileThreads" => {
                self.chats_read_state_list_unread_file_threads(
                    &ctx,
                    request.workspace,
                    request.params,
                )
                .await?
            }
            "chats.agentReadState.listUnreadThreads" => {
                self.chats_agent_read_state_list_unread_threads(
                    &ctx,
                    request.workspace,
                    request.params,
                )
                .await?
            }
            "chats.agentReadState.markThreadRead" => {
                self.chats_agent_read_state_mark_thread_read(
                    &ctx,
                    request.workspace,
                    request.params,
                )
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
            "chats.follows.ensureDefaults" => {
                self.chats_follows_ensure_defaults(&ctx, request.workspace, request.params)
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
            "chats.bookmarks.markPending" => {
                self.chats_bookmarks_mark_pending(
                    &ctx,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
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
            "chats.dispatch.recordEligibleTriggers" => {
                self.chats_dispatch_record_eligible_triggers(
                    &ctx,
                    request.workspace,
                    request.params,
                )
                .await?
            }
            "chats.dispatch.claimNextPending" => {
                self.chats_dispatch_claim_next_pending(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.listPending" => {
                self.chats_dispatch_list_pending(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.openRuns" => {
                self.chats_dispatch_open_runs(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.listRunMessages" => {
                self.chats_dispatch_list_run_messages(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.runIdForMessage" => {
                self.chats_dispatch_run_id_for_message(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.runRecordsForThread" => {
                self.chats_dispatch_run_records_for_thread(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.getRunRecord" => {
                self.chats_dispatch_get_run_record(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.isThreadPaused" => {
                self.chats_dispatch_thread_paused(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.getThreadPauseState" => {
                self.chats_dispatch_get_thread_pause_state(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.recentCount" => {
                self.chats_dispatch_recent_count(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.failPendingForThread" => {
                self.chats_dispatch_fail_pending_for_thread(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.recordRunMessage" => {
                self.chats_dispatch_record_run_message(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.setThreadPaused" => {
                self.chats_dispatch_set_thread_paused(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.markFailureNotePosted" => {
                self.chats_dispatch_mark_failure_note_posted(
                    &ctx,
                    request.workspace,
                    request.params,
                )
                .await?
            }
            "chats.dispatch.requeueFailedTrigger" => {
                self.chats_dispatch_requeue_failed_trigger(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.listAppQuitRecoveries" => {
                self.chats_dispatch_list_app_quit_recoveries(
                    &ctx,
                    request.workspace,
                    request.params,
                )
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
        Ok(ServiceResponse::response(Response { id, result }))
    }

    fn ensure_handle_allows_method(
        &self,
        handle: Option<&WorkspaceHandle>,
        method: &str,
    ) -> Result<(), WireError> {
        let Some(handle) = handle else {
            return Ok(());
        };
        let read_only = lock(&self.handles)
            .get(handle)
            .is_some_and(|open| open.mode == WorkspaceOpenMode::ReadOnly);
        if read_only
            && !matches!(
                method,
                "workspace.close"
                    | "search.queryChatMessagesGranular"
                    | "chats.readState.listUnreadFileThreads"
            )
        {
            return Err(wire(
                ErrorCode::InvalidParams,
                "method is unavailable on a read-only workspace handle",
            ));
        }
        Ok(())
    }

    /// Tear down every open workspace's capture driver (watcher joined,
    /// files actor closed). Called at daemon shutdown AFTER the transport's
    /// workspace close hook: store actors are already gone by then, so any
    /// in-flight capture write fails CONTAINED (never acked — the next
    /// daemon start re-offers it from the dirty baseline), and this drain
    /// joins the watcher/files threads so the process exits clean.
    pub async fn shutdown_all_capture(&self) {
        let open: Vec<OpenWorkspace> = lock(&self.handles)
            .values()
            .filter(|open| open.handle_kind.owns_binding())
            .cloned()
            .collect();
        for workspace in open {
            workspace.shutdown_capture().await;
        }
    }

    /// The service's event emitter. The transport host subscribes once and
    /// forwards notices to the connected client as wire `Event` envelopes.
    pub fn events(&self) -> EngineEvents {
        self.events.clone()
    }

    async fn workspace_open(
        &self,
        ctx: &RequestContext,
        params: Value,
    ) -> Result<Value, WireError> {
        let capture_author_supplied = params
            .as_object()
            .is_some_and(|object| object.contains_key("captureAuthor"));
        let params: WorkspaceOpenParams = parse(params)?;
        let capture_author_json = if capture_author_supplied {
            Some(validated_author(params.capture_author.as_ref(), None)?)
        } else {
            None
        };
        let capture_enabled = params.capture_mode.is_none();
        if !capture_enabled && capture_author_supplied {
            return Err(wire(
                ErrorCode::InvalidParams,
                "captureAuthor is unavailable when captureMode is none",
            ));
        }
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
        let requested_mode = if params.skip_startup_maintenance {
            WorkspaceOpenMode::ReadOnly
        } else {
            WorkspaceOpenMode::Full
        };
        let existing = {
            let guard = lock(&self.handles);
            guard
                .iter()
                .find(|(_, open)| open.root == root && open.handle_kind.owns_binding())
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
            // A maintenance-free open is read intent, not a request for
            // ownership. Mint a non-owning token over the live binding so its
            // close cannot tear down the desktop's actor, capture, or relay.
            // Same workspace: short-circuit only on a LIVE binding. A bound-but-
            // closed actor (its worker died) is stale — drop it and reopen fresh.
            if open.actor.lifecycle() != LifecycleState::Closed {
                if requested_mode == WorkspaceOpenMode::ReadOnly {
                    // Caller-supplied relay params and captureAuthor are
                    // deliberately ignored here: the attachment rides the
                    // OWNER's binding, and read-only handles cannot reach
                    // sync/relay/capture methods anyway.
                    let sequence = self
                        .next_handle
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let attached_handle = WorkspaceHandle(format!("ws-{sequence:016x}"));
                    let mut attached = open;
                    attached.mode = WorkspaceOpenMode::ReadOnly;
                    attached.handle_kind = WorkspaceHandleKind::ReadOnlyAttach { owner: handle };
                    {
                        let mut handles = lock(&self.handles);
                        if handles.len() >= MAX_OPEN_HANDLES {
                            return Err(wire(
                                ErrorCode::Overloaded,
                                "workspace handle limit reached",
                            ));
                        }
                        handles.insert(attached_handle.clone(), attached);
                    }
                    return Ok(json!({ "workspace": attached_handle }));
                }
                if open.mode != requested_mode {
                    return Err(wire(
                        ErrorCode::InvalidParams,
                        "workspace root is already open in a different mode",
                    ));
                }
                if lock(&open.capture).is_some() != capture_enabled {
                    return Err(wire(
                        ErrorCode::InvalidParams,
                        "workspace capture configuration mismatch",
                    ));
                }
                if open.relay != params.relay.as_ref().map(RelayOpenParams::configuration) {
                    return Err(wire(
                        ErrorCode::InvalidParams,
                        "workspace relay configuration mismatch",
                    ));
                }
                if let Some(author_json) = capture_author_json.clone() {
                    let _apply = tokio::select! {
                        biased;
                        () = cancellation.token.cancelled() => {
                            return Err(cancellation.interruption(
                                "workspace open (capture author)"
                            ));
                        }
                        guard = Arc::clone(&open.capture_apply_gate).lock_owned() => guard,
                    };
                    let capture = lock(&open.capture);
                    let driver = capture.as_ref().ok_or_else(|| {
                        wire(
                            ErrorCode::WorkspaceUnavailable,
                            "capture driver unavailable",
                        )
                    })?;
                    driver.set_author_json(author_json);
                }
                return Ok(json!({ "workspace": handle }));
            }
            lock(&self.handles).remove(&handle);
            let attached_handles = {
                let mut handles = lock(&self.handles);
                let attached: Vec<WorkspaceHandle> = handles
                    .iter()
                    .filter(|(_, open)| open.handle_kind.is_attached_to(&handle))
                    .map(|(attached, _)| attached.clone())
                    .collect();
                for attached in &attached {
                    handles.remove(attached);
                }
                attached
            };
            // The normal close path drops pending cursors with the handle;
            // eviction dropped the handle and the sessions but left them.
            // Handles are minted from a monotonic counter, so the orphans were
            // never CONSUMABLE — every reopen gets a new handle and
            // consume_pending_cursor matches on it — they simply accumulated
            // in the map for the life of the process, one per issued cursor
            // per evicted binding, with nothing able to remove them.
            lock(&self.pending_cursors).retain(|_, pending| {
                pending.handle != handle && !attached_handles.contains(&pending.handle)
            });
            lock(&self.sessions).retain(|_, session| {
                session.workspace != handle && !attached_handles.contains(&session.workspace)
            });
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
        let actor_open = tokio::task::spawn_blocking(move || match requested_mode {
            WorkspaceOpenMode::Full => supervisor.open(&actor_path, now_ms),
            WorkspaceOpenMode::ReadOnly => supervisor.open_read_only(&actor_path),
        })
        .await
        .map_err(|_| wire(ErrorCode::Internal, "workspace open task failed"))?
        .map_err(map_runtime)?;
        // The supervisor deduplicates by physical engine.db identity, including
        // root aliases and hard links. EngineService state (capture driver,
        // session registry, and version barriers) deliberately has one owner:
        // attaching a second service to the shared actor would split those
        // barriers and make version switches unsafe. Production constructs one
        // service, and repeated opens on that service returned above; reject
        // every remaining cross-service/aliased attachment explicitly.
        if !actor_open.created_actor {
            return Err(wire(
                ErrorCode::WorkspaceUnavailable,
                "workspace database is already attached",
            ));
        }
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
        let capture_apply_gate = Arc::new(tokio::sync::Mutex::new(()));
        let capture = if requested_mode == WorkspaceOpenMode::ReadOnly {
            None
        } else {
            // Mandatory readiness barrier: derived mention rows must exist before
            // this workspace can expose a mention read or advance the dispatch
            // scan cursor past an older `@agent` message.
            Self::read_under_ctx(
                &cancellation,
                "workspace.open (mention backfill)",
                actor.chat_mentions_backfill(
                    params.workspace_id.clone(),
                    cancellation.token.clone(),
                ),
            )
            .await?;
            // Startup replay BEFORE the files layer exists: jobs left pending by
            // a crash, a transient settle failure, or a pulled replication apply
            // land on disk while nothing is watching (no suppression window),
            // and the baseline reconcile below then scans the POST-replay disk.
            actor
                .materialize_replay_pending(root.clone(), params.workspace_id.clone(), now_ms)
                .await
                .map_err(map_runtime)?;
            // The files layer spawns ONLY here — after the shadow binding
            // succeeded — so an unmarked or mismatched root can never grow a
            // watcher or files actor (the shadow-scope dormancy invariant).
            let capture = capture_enabled.then(|| {
                capture_driver::CaptureDriver::spawn(
                    root.clone(),
                    actor.clone(),
                    params.workspace_id.clone(),
                    self.self_writes.scoped(&root),
                    Arc::clone(&capture_apply_gate),
                    capture_author_json.flatten(),
                    self.events.clone(),
                    #[cfg(feature = "harness")]
                    self.capture_apply_probe.clone(),
                )
            });
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
            // Desktop rebinds opt out because their runner processes outlive the daemon.
            if actor_open.created_actor && params.recover_running_dispatches.unwrap_or(true) {
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
            if let Some(capture) = &capture {
                capture.wait_for_baseline().await;
            }
            capture
        };
        open_guard.disarm();
        lock(&self.handles).insert(
            handle.clone(),
            OpenWorkspace {
                root,
                db_path,
                workspace_id: params.workspace_id,
                actor,
                mode: requested_mode,
                handle_kind: WorkspaceHandleKind::Owner,
                relay: params
                    .relay
                    .map(|configuration| configuration.configuration()),
                capture: Arc::new(Mutex::new(capture)),
                capture_apply_gate,
                session_ops: Arc::new(tokio::sync::Mutex::new(())),
            },
        );
        Ok(json!({ "workspace": handle }))
    }

    /// Acquire the capture and session barriers in the one per-workspace order
    /// used by version fencing and workspace teardown.
    async fn acquire_workspace_barriers(
        &self,
        open: &OpenWorkspace,
        cancellation: Option<&OperationCancellation>,
        operation: &str,
        pause_after_capture: bool,
    ) -> Result<WorkspaceBarriers, WireError> {
        #[cfg(feature = "harness")]
        if pause_after_capture && let Some(probe) = &self.capture_apply_probe {
            probe.observe_version_fence_wait_if_armed();
        }
        let capture = match cancellation {
            Some(cancellation) => {
                tokio::select! {
                    biased;
                    () = cancellation.token.cancelled() => {
                        return Err(cancellation.interruption(
                            &format!("{operation} (capture barrier)")
                        ));
                    }
                    barrier = Arc::clone(&open.capture_apply_gate).lock_owned() => barrier,
                }
            }
            None => Arc::clone(&open.capture_apply_gate).lock_owned().await,
        };

        #[cfg(feature = "harness")]
        if pause_after_capture && let Some(probe) = &self.capture_apply_probe {
            probe.pause_version_fence_if_armed().await;
        }
        #[cfg(not(feature = "harness"))]
        let _ = pause_after_capture;

        let sessions = match cancellation {
            Some(cancellation) => {
                tokio::select! {
                    biased;
                    () = cancellation.token.cancelled() => {
                        return Err(cancellation.interruption(
                            &format!("{operation} (ydoc barrier)")
                        ));
                    }
                    serial = Arc::clone(&open.session_ops).lock_owned() => serial,
                }
            }
            None => Arc::clone(&open.session_ops).lock_owned().await,
        };
        Ok(WorkspaceBarriers {
            _capture: capture,
            _sessions: sessions,
        })
    }

    async fn workspace_close(&self, handle: Option<WorkspaceHandle>) -> Result<Value, WireError> {
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(&handle))?;
        if !open.handle_kind.owns_binding() {
            let _serial = self.open_lock.lock().await;
            let removed = lock(&self.handles).remove(&handle).is_some();
            lock(&self.pending_cursors).retain(|_, pending| pending.handle != handle);
            lock(&self.sessions).retain(|_, session| session.workspace != handle);
            return Ok(json!({ "closed": false, "attachmentClosed": removed }));
        }
        // The same capture→sessions order as `fence_version_snapshot`.
        // Holding the capture gate through driver cancellation/drain means no
        // apply can be queued behind a session-first close and form the
        // close→driver→switch deadlock triangle.
        let _barriers = self
            .acquire_workspace_barriers(&open, None, "workspace.close", false)
            .await?;
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
            let (removed, attached_handles) = {
                let mut handles = lock(&self.handles);
                let removed = handles.remove(&handle);
                let attached: Vec<WorkspaceHandle> = handles
                    .iter()
                    .filter(|(_, open)| open.handle_kind.is_attached_to(&handle))
                    .map(|(attached, _)| attached.clone())
                    .collect();
                for attached in &attached {
                    handles.remove(attached);
                }
                (removed, attached)
            };
            lock(&self.pending_cursors).retain(|_, pending| {
                pending.handle != handle && !attached_handles.contains(&pending.handle)
            });
            // Sessions (and their lease guards) evict only AFTER this close
            // owns the teardown — evicting earlier meant a close future
            // dropped while waiting on open_lock had already stranded live
            // editors (ydoc-session-not-found) and released their leases for
            // a workspace that stayed open.
            lock(&self.sessions).retain(|_, session| {
                session.workspace != handle && !attached_handles.contains(&session.workspace)
            });
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

    fn relay_open(
        &self,
        handle: Option<&WorkspaceHandle>,
        workspace_id: &str,
    ) -> Result<(OpenWorkspace, RelayConfiguration), WireError> {
        let open = self.open(handle)?;
        validate_workspace_param(Some(workspace_id), &open.workspace_id)?;
        let configuration = open
            .relay
            .clone()
            .ok_or_else(|| wire(ErrorCode::InvalidParams, "relay-not-configured"))?;
        Ok((open, configuration))
    }

    fn issue_pending_cursor(
        &self,
        handle: &WorkspaceHandle,
        workspace_id: &str,
        cursor: IssuedCursor,
    ) -> Result<Value, WireError> {
        for _ in 0..4 {
            let mut bytes = [0_u8; 32];
            getrandom::fill(&mut bytes)
                .map_err(|_| wire(ErrorCode::Internal, "pending-cursor-token-failed"))?;
            let token = bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let (kind, wire_kind) = match &cursor {
                IssuedCursor::Relay(_) => (PendingCursorKind::Relay, "relay"),
                IssuedCursor::ShareView(_) => (PendingCursorKind::ShareView, "shareView"),
            };
            let mut pending = lock(&self.pending_cursors);
            if pending.contains_key(&token) {
                continue;
            }
            pending.retain(|_, issued| {
                issued.handle != *handle
                    || issued.workspace_id != workspace_id
                    || !matches!(
                        (&issued.cursor, kind),
                        (IssuedCursor::Relay(_), PendingCursorKind::Relay)
                            | (IssuedCursor::ShareView(_), PendingCursorKind::ShareView)
                    )
            });
            pending.insert(
                token.clone(),
                PendingCursor {
                    handle: handle.clone(),
                    workspace_id: workspace_id.to_owned(),
                    cursor,
                },
            );
            return Ok(json!({ "kind": wire_kind, "token": token }));
        }
        Err(wire(ErrorCode::Internal, "pending-cursor-token-collision"))
    }

    fn consume_pending_cursor(
        &self,
        handle: &WorkspaceHandle,
        workspace_id: &str,
        kind: PendingCursorKind,
        token: &str,
    ) -> Result<IssuedCursor, WireError> {
        let mut pending = lock(&self.pending_cursors);
        let valid = pending.get(token).is_some_and(|issued| {
            issued.handle == *handle
                && issued.workspace_id == workspace_id
                && matches!(
                    (&issued.cursor, kind),
                    (IssuedCursor::Relay(_), PendingCursorKind::Relay)
                        | (IssuedCursor::ShareView(_), PendingCursorKind::ShareView)
                )
        });
        if !valid {
            return Err(wire(ErrorCode::InvalidParams, "invalid-pending-cursor"));
        }
        pending
            .remove(token)
            .map(|issued| issued.cursor)
            .ok_or_else(|| wire(ErrorCode::InvalidParams, "invalid-pending-cursor"))
    }

    async fn relay_execute(
        &self,
        ctx: &RequestContext,
        open: &OpenWorkspace,
        configuration: RelayConfiguration,
        operation: RelayOperation,
        label: &str,
    ) -> Result<RelayOperationOutcome, WireError> {
        let cancellation = OperationCancellation::new(ctx);
        Self::read_under_ctx(
            &cancellation,
            label,
            open.actor.relay(
                configuration,
                operation,
                self.leases.scoped(&open.root),
                cancellation.token(),
            ),
        )
        .await
    }

    async fn sync_push(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::Push {
                    workspace_id: open.workspace_id.clone(),
                },
                "sync.push",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    async fn sync_pull(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let bound_handle = handle.as_ref().ok_or_else(workspace_unavailable)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::Pull {
                    workspace_id: open.workspace_id.clone(),
                },
                "sync.pull",
            )
            .await?;
        let pending = match &outcome {
            RelayOperationOutcome::Sync(SyncPassOutcome::Complete {
                pending_cursor: Some(cursor),
                ..
            })
            | RelayOperationOutcome::Sync(SyncPassOutcome::CrashedAfterApply {
                pending_cursor: cursor,
                ..
            }) => Some(IssuedCursor::Relay(cursor.clone())),
            _ => None,
        };
        let mut result = relay_outcome_json(outcome)?;
        if let Some(cursor) = pending {
            result["pendingCursor"] =
                self.issue_pending_cursor(bound_handle, &open.workspace_id, cursor)?;
        }
        Ok(result)
    }

    async fn sync_commit_cursor(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: CommitCursorParams = parse(params)?;
        let bound_handle = handle.as_ref().ok_or_else(workspace_unavailable)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let (kind, token) = match params.pending_cursor {
            PendingCursorParams::Relay { token } => (PendingCursorKind::Relay, token),
            PendingCursorParams::ShareView { token } => (PendingCursorKind::ShareView, token),
        };
        let issued = self.consume_pending_cursor(bound_handle, &open.workspace_id, kind, &token)?;
        let operation = match issued {
            IssuedCursor::Relay(cursor) => RelayOperation::CommitCursor {
                workspace_id: open.workspace_id.clone(),
                cursor,
            },
            IssuedCursor::ShareView(cursor) => RelayOperation::CommitShareViewCursor {
                workspace_id: open.workspace_id.clone(),
                cursor,
            },
        };
        let outcome = self
            .relay_execute(ctx, &open, configuration, operation, "sync.commitCursor")
            .await?;
        relay_outcome_json(outcome)
    }

    async fn sync_probe(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::Probe {
                    workspace_id: open.workspace_id.clone(),
                },
                "sync.probe",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    async fn sync_claim(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::Claim {
                    workspace_id: open.workspace_id.clone(),
                    new_origin_id: sync_identifier("origin")?,
                    new_replication_epoch: sync_identifier("epoch")?,
                    new_stream_identity: sync_identifier("stream")?,
                    created_at_ms: now_ms()?,
                },
                "sync.claim",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    async fn sync_adopt_join_identity(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AdoptJoinIdentityParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::AdoptJoinIdentity {
                    workspace_id: open.workspace_id.clone(),
                    new_origin_id: recovered_origin_id()?,
                    replication_epoch: params.replication_epoch,
                    stream_identity: params.stream_identity,
                    created_at_ms: now_ms()?,
                },
                "sync.adoptJoinIdentity",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    async fn sync_recover_origin(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let new_origin_id = recovered_origin_id()?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::RecoverOrigin {
                    workspace_id: open.workspace_id.clone(),
                    new_origin_id,
                },
                "sync.recoverOrigin",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    async fn keys_upload(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: KeyEnvelopeUploadParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::UploadKeyEnvelope {
                    workspace_id: open.workspace_id.clone(),
                    envelope_json: params.envelope_json,
                    if_match: params.if_match,
                },
                "keys.upload",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    async fn keys_download(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::DownloadKeyEnvelope {
                    workspace_id: open.workspace_id.clone(),
                },
                "keys.download",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    async fn share_channel_pull(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SharedChannelParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::PullSharedChannel {
                    workspace_id: open.workspace_id.clone(),
                    share_id: params.share_id,
                    channel_wire_id: params.channel_wire_id,
                },
                "share.channel.pull",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    async fn share_channel_push(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SharedChannelParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::PushSharedChannel {
                    workspace_id: open.workspace_id.clone(),
                    share_id: params.share_id,
                    channel_wire_id: params.channel_wire_id,
                },
                "share.channel.push",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    async fn share_view_pull(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ShareViewParams = parse(params)?;
        let bound_handle = handle.as_ref().ok_or_else(workspace_unavailable)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::PullShareView {
                    workspace_id: open.workspace_id.clone(),
                    share_id: params.share_id,
                    granted: params.granted_selector.into(),
                },
                "share.view.pull",
            )
            .await?;
        let pending = match &outcome {
            RelayOperationOutcome::ShareViewPulled(outcome) => {
                Some(IssuedCursor::ShareView(outcome.pending_cursor.clone()))
            }
            _ => None,
        };
        let mut result = relay_outcome_json(outcome)?;
        if let Some(cursor) = pending {
            result["pendingCursor"] =
                self.issue_pending_cursor(bound_handle, &open.workspace_id, cursor)?;
        }
        Ok(result)
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

    /// Acquire the ordering guard shared with `ydoc.open` before probing a
    /// path lease. The caller must retain the returned OWNED guard until its
    /// actor mutation has completed: check-without-lease -> mutation and
    /// probe -> lease -> authoritative re-read are mutually exclusive orders.
    async fn mutation_session_guard(
        &self,
        open: &OpenWorkspace,
        cancellation: &OperationCancellation,
        operation: &str,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, WireError> {
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                Err(cancellation.interruption(operation))
            }
            serial = Arc::clone(&open.session_ops).lock_owned() => Ok(serial),
        }
    }

    async fn ensure_path_not_leased(
        &self,
        open: &OpenWorkspace,
        version_id: &str,
        path: &str,
    ) -> Result<(), WireError> {
        let canonical_path = validate_addressable_plaintext_path(path)
            .map_err(|error| map_runtime(RuntimeError::Domain(error)))?;
        let existing = match open
            .actor
            .resolve_path_object(
                open.workspace_id.clone(),
                version_id.to_owned(),
                canonical_path.clone(),
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
            dohc_engine_domain::derive_capture_object_id(
                &open.workspace_id,
                version_id,
                &canonical_path,
            )
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
        let path = params.path.clone();
        let text = params.text;
        if text.len() > MAX_DESKTOP_CAPTURE_TEXT_BYTES {
            return Err(wire(ErrorCode::InvalidParams, "content-exceeds-inband-cap"));
        }
        let origin = validated_origin(params.origin.as_deref(), params.metadata_origin.as_deref())?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let author_json = validated_author(params.author.as_ref(), params.author_json.as_deref())?;
        let cancellation = OperationCancellation::new(ctx);
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versionedText.write (queued)")
            .await?;
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
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                open.root.clone(),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await;
        drop(session_serial);
        let result = result.map_err(map_runtime)?;
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
        let path = params.path.clone();
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
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let author_json = validated_author(params.author.as_ref(), params.author_json.as_deref())?;
        let cancellation = OperationCancellation::new(ctx);
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versionedBinary.write (queued)")
            .await?;
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
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await;
        drop(session_serial);
        let execution = execution.map_err(map_runtime)?;
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

    async fn versioned_binary_write_blob(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedBinaryWriteBlobParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        if params.sha256.len() != 64 || !params.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(wire(ErrorCode::InvalidParams, "invalid-input"));
        }
        let sha256 = params.sha256.to_ascii_lowercase();
        let path = params.path.clone();
        let origin = validated_origin(params.origin.as_deref(), params.metadata_origin.as_deref())?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let author_json = validated_author(params.author.as_ref(), params.author_json.as_deref())?;
        let cancellation = OperationCancellation::new(ctx);
        let bytes = match params.bytes_base64 {
            Some(encoded) => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| wire(ErrorCode::InvalidParams, "invalid-input"))?;
                if bytes.len() > dohc_engine_domain::MAX_CAPTURE_BINARY_FILE_BYTES {
                    return Err(wire(
                        ErrorCode::InvalidParams,
                        "content-exceeds-capture-cap",
                    ));
                }
                let actual = Sha256::digest(&bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                if actual != sha256 {
                    return Err(wire(ErrorCode::InvalidParams, "invalid-input"));
                }
                bytes
            }
            None => {
                let blob = Self::read_under_ctx(
                    &cancellation,
                    "versionedBinary.writeBlob",
                    open.actor
                        .read_binary_blob_for_egress(open.workspace_id.clone(), sha256),
                )
                .await?
                .ok_or_else(|| wire(ErrorCode::InvalidParams, "file-not-found"))?;
                blob.bytes
                    .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?
            }
        };
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versionedBinary.writeBlob (queued)")
            .await?;
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
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await;
        drop(session_serial);
        let execution = execution.map_err(map_runtime)?;
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
        let from_path = params.from_path.clone();
        let to_path = params.to_path.clone();
        let origin = validated_origin(params.origin.as_deref(), params.metadata_origin.as_deref())?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let author_json = validated_author(params.author.as_ref(), params.author_json.as_deref())?;
        let cancellation = OperationCancellation::new(ctx);
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versionedText.rename (queued)")
            .await?;
        self.ensure_path_not_leased(&open, &params.version_id, &from_path)
            .await?;
        self.ensure_path_not_leased(&open, &params.version_id, &to_path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let moment_id =
            self.generated_rpc_id("moment", request.id, request_id.as_deref(), &to_path);
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
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await;
        drop(session_serial);
        let result = result.map_err(map_runtime)?;
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
        let path = params.path.clone();
        let origin = validated_origin(params.origin.as_deref(), params.metadata_origin.as_deref())?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let author_json = validated_author(params.author.as_ref(), params.author_json.as_deref())?;
        let cancellation = OperationCancellation::new(ctx);
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versionedText.delete (queued)")
            .await?;
        self.ensure_path_not_leased(&open, &params.version_id, &path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let moment_id = self.generated_rpc_id("moment", request.id, request_id.as_deref(), &path);
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
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await;
        drop(session_serial);
        let result = result.map_err(map_runtime)?;
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
        let path = validate_addressable_plaintext_path(&params.path)
            .map_err(|error| map_runtime(RuntimeError::Domain(error)))?;
        let origin = validated_origin(params.origin.as_deref(), params.metadata_origin.as_deref())?;
        let author_json = validated_author(params.author.as_ref(), params.author_json.as_deref())?;
        let cancellation = OperationCancellation::new(ctx);
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versionedText.rollback (queued)")
            .await?;
        self.ensure_path_not_leased(&open, &params.version_id, &path)
            .await?;
        let restore_path = open
            .actor
            .get_moment(open.workspace_id.clone(), params.mutation_moment_id.clone())
            .await
            .map_err(map_runtime)?
            .filter(|moment| {
                moment.version_id == params.version_id
                    && moment.path == path
                    && moment.operation == MomentOp::Rename
            });
        if let Some(before_moment_id) =
            restore_path.and_then(|moment| moment.before_latest_moment_id)
            && let Some(before) = open
                .actor
                .get_moment(open.workspace_id.clone(), before_moment_id)
                .await
                .map_err(map_runtime)?
            && before.path != path
        {
            self.ensure_path_not_leased(&open, &params.version_id, &before.path)
                .await?;
        }
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
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
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await;
        drop(session_serial);
        let result = result.map_err(map_runtime)?;
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
                path: params.path.clone(),
            }),
        )
        .await?;
        Ok(comparison_json(&comparison))
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
        let path = params.path.clone();
        let origin = validated_origin(params.origin.as_deref(), params.metadata_origin.as_deref())?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let author_json = validated_author(params.author.as_ref(), params.author_json.as_deref())?;
        let cancellation = OperationCancellation::new(ctx);
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versions.merge (queued)")
            .await?;
        self.ensure_path_not_leased(&open, &params.target_version_id, &path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let object_id = self.generated_rpc_id("object", request.id, request_id.as_deref(), &path);
        let moment_id = self.generated_rpc_id("moment", request.id, request_id.as_deref(), &path);
        let conflict_id =
            self.generated_rpc_id("conflict", request.id, request_id.as_deref(), &path);
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
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await;
        drop(session_serial);
        let execution = result.map_err(map_runtime)?;
        let materialize_enqueued = execution.materialize_enqueued;
        let materialized = execution.materialized;
        let materialize_outcome = materialize_outcome_name(execution.materialize_outcome);
        Ok(match execution.merge {
            MergeTextFileResult::Unchanged {
                reason,
                comparison,
                deduped,
            } => json!({
                "status": "unchanged",
                "reason": match reason {
                    MergeUnchangedReason::AlreadySame => "already-same",
                    MergeUnchangedReason::SourceUnchanged => "source-unchanged",
                },
                "comparison": comparison_json(&comparison),
                "deduped": deduped,
                "materializeEnqueued": materialize_enqueued,
                "materialized": materialized,
                "materializeOutcome": materialize_outcome,
            }),
            MergeTextFileResult::Write { comparison, write } => json!({
                "status": "merged",
                "comparison": comparison_json(&comparison),
                "writeKind": "write",
                "object": file_object_json(&write.object),
                "snapshot": snapshot_metadata_json(&write.snapshot, "text", None, None),
                "moment": moment_json(&write.moment),
                "deduped": write.deduped,
                "materializeEnqueued": materialize_enqueued,
                "materialized": materialized,
                "materializeOutcome": materialize_outcome,
            }),
            MergeTextFileResult::BinaryWrite { comparison, write } => json!({
                "status": "merged",
                "comparison": comparison_json(&comparison),
                "writeKind": "binary-write",
                "object": file_object_json(&write.object),
                "snapshot": snapshot_metadata_json(
                    &write.head.snapshot,
                    "binary",
                    Some(&write.head.snapshot.blob_sha256),
                    Some(write.head.byte_length),
                ),
                "moment": moment_json(&write.moment),
                "deduped": write.deduped,
                "materializeEnqueued": materialize_enqueued,
                "materialized": materialized,
                "materializeOutcome": materialize_outcome,
            }),
            MergeTextFileResult::Delete { comparison, delete } => json!({
                "status": "merged",
                "comparison": comparison_json(&comparison),
                "writeKind": "delete",
                "object": file_object_json(&delete.object),
                "before": snapshot_metadata_json(&delete.before, "text", None, None),
                "moment": moment_json(&delete.moment),
                "deduped": delete.deduped,
                "materializeEnqueued": materialize_enqueued,
                "materialized": materialized,
                "materializeOutcome": materialize_outcome,
            }),
            MergeTextFileResult::Conflict {
                comparison,
                conflict,
                deduped,
            } => json!({
                "status": "conflict",
                "conflictId": conflict.conflict_id,
                "comparison": comparison_json(&comparison),
                "deduped": deduped,
                "materializeEnqueued": materialize_enqueued,
                "materialized": materialized,
                "materializeOutcome": materialize_outcome,
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
        let handle = request
            .workspace
            .as_ref()
            .ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(handle))?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let new_version_id = self.generated_rpc_id(
            "version",
            request.id,
            request.idempotency_key.as_deref(),
            &params.name,
        );
        let cancellation = OperationCancellation::new(ctx);
        let input = CreateNamedVersion {
            workspace_id: open.workspace_id.clone(),
            new_version_id,
            name: params.name,
            from_version_id: params.from_version_id,
            now_ms: now_ms()?,
            request_id: request.idempotency_key.clone(),
        };
        // Reject missing sources, bad/taken names, duplicate ids, and
        // idempotency mismatches before the destructive session sweep and full
        // scan. An exact replay returns its original version without fencing.
        if let Some(version) = Self::read_under_ctx(
            &cancellation,
            "versions.createNamed (preflight)",
            open.actor
                .preflight_create_named_version(input.clone(), cancellation.token()),
        )
        .await?
        {
            return Ok(version_record_json(&version));
        }
        let fence = self
            .fence_version_snapshot(
                &cancellation,
                &open,
                handle,
                "versions.createNamed",
                "Saved latest edits before creating a version",
                VersionFenceIntent::Fork {
                    input: input.clone(),
                },
            )
            .await?;
        match fence {
            VersionFenceOutcome::CreateReplay(version) => Ok(version_record_json(&version)),
            VersionFenceOutcome::AlreadyActive => {
                unreachable!("fork fences never return AlreadyActive");
            }
            VersionFenceOutcome::Committed(version) => Ok(version_record_json(&version)),
        }
    }

    /// Freeze the active workspace snapshot before a version fork or switch.
    ///
    /// Lock order is per-workspace capture gate FIRST, then that workspace's
    /// Y.Doc/session mutation gate — the same helper used by workspace.close.
    /// Once both are held, no capture apply or session admission can straddle
    /// the session sweep, forced reconcile, and version transaction. After the
    /// fenced preflight, the destructive continuation moves into an owned task:
    /// dropping the request future detaches it instead of releasing either
    /// guard over a partially completed switch.
    async fn fence_version_snapshot(
        &self,
        cancellation: &OperationCancellation,
        open: &OpenWorkspace,
        handle: &WorkspaceHandle,
        operation: &str,
        settle_summary: &str,
        intent: VersionFenceIntent,
    ) -> Result<VersionFenceOutcome, WireError> {
        let barriers = self
            .acquire_workspace_barriers(open, Some(cancellation), operation, true)
            .await?;

        let (reconcile_version_id, fork_source_version_id) = match &intent {
            VersionFenceIntent::Fork { input } => {
                // The preflight is intentionally repeated while the fence is
                // held: a competing create may have won between the cheap
                // outer check and acquisition. Reject or replay before any
                // session is closed.
                if let Some(version) = Self::read_under_ctx(
                    cancellation,
                    "versions.createNamed (fenced preflight)",
                    open.actor
                        .preflight_create_named_version(input.clone(), cancellation.token()),
                )
                .await?
                {
                    return Ok(VersionFenceOutcome::CreateReplay(version));
                }
                let active = Self::read_under_ctx(
                    cancellation,
                    "versions.createNamed (active version)",
                    open.actor.active_version(open.workspace_id.clone()),
                )
                .await?;
                (active.version_id, Some(input.from_version_id.clone()))
            }
            VersionFenceIntent::Switch {
                target_version_id, ..
            } => {
                let active = Self::read_under_ctx(
                    cancellation,
                    "versions.setActive (fenced active recheck)",
                    open.actor.active_version(open.workspace_id.clone()),
                )
                .await?;
                if active.version_id == *target_version_id {
                    return Ok(VersionFenceOutcome::AlreadyActive);
                }
                (active.version_id, None)
            }
        };

        let session_views: Vec<(String, DocKey, ContentKind)> = lock(&self.sessions)
            .iter()
            .filter(|(_, session)| {
                session.workspace == *handle && session.key.version_id == reconcile_version_id
            })
            .map(|(session_id, session)| {
                (
                    session_id.clone(),
                    session.key.clone(),
                    session.content_kind,
                )
            })
            .collect();
        let session_ids: Vec<String> = session_views
            .iter()
            .map(|(session_id, _, _)| session_id.clone())
            .collect();

        if let Some(source_version_id) = fork_source_version_id.as_ref()
            && let Some(content_kind) = Self::read_under_ctx(
                cancellation,
                "versions.createNamed (source ydoc preflight)",
                open.actor.ydoc_version_unsettled_content_kind(
                    open.workspace_id.clone(),
                    source_version_id.clone(),
                    if source_version_id == &reconcile_version_id {
                        session_views
                            .iter()
                            .map(|(_, key, _)| key.object_id.clone())
                            .collect()
                    } else {
                        Vec::new()
                    },
                    cancellation.token(),
                ),
            )
            .await?
        {
            return Err(unsettled_fork_error(content_kind));
        }

        let (capture_status, capture_author_json) = lock(&open.capture)
            .as_ref()
            .map(|driver| (Arc::clone(driver.status()), driver.author_json()))
            .ok_or_else(|| {
                wire(
                    ErrorCode::WorkspaceUnavailable,
                    "capture driver unavailable",
                )
            })?;
        let open = open.clone();
        let handle = handle.clone();
        let sessions = Arc::clone(&self.sessions);
        let self_writes = self.self_writes.clone();
        let events = self.events.clone();
        let detached_operation = operation.to_owned();
        let settle_summary = settle_summary.to_owned();
        // The fence's forced reconcile is a capture PASS (TS parity:
        // `version-switch-${id}` / `version-create-${id}`): its moments carry
        // the fence's own summary and ONE correlation id so the pre-switch
        // "nothing is ever lost" capture groups in history instead of
        // rendering as unrelated per-file rows.
        let reconcile_provenance = capture_sink::CaptureProvenance {
            summary: Some(settle_summary.clone()),
            correlation_id: Some(capture_driver::pass_correlation_id(match &intent {
                VersionFenceIntent::Fork { .. } => "version-create",
                VersionFenceIntent::Switch { .. } => "version-switch",
            })),
        };
        #[cfg(feature = "harness")]
        let probe = self.capture_apply_probe.clone();
        let mut fence = tokio::spawn(async move {
            let _barriers = barriers;
            let token = CancellationToken::new();
            for session_id in session_ids {
                close_ydoc_session_for_version_fence(
                    &sessions,
                    &self_writes,
                    &open,
                    &handle,
                    &session_id,
                    &settle_summary,
                    &token,
                )
                .await?;
            }

            if let VersionFenceIntent::Fork { input } = &intent
                && let Some(content_kind) = open
                    .actor
                    .ydoc_version_unsettled_content_kind(
                        open.workspace_id.clone(),
                        input.from_version_id.clone(),
                        Vec::new(),
                        token.clone(),
                    )
                    .await
                    .map_err(map_runtime)?
            {
                return Err(unsettled_fork_error(content_kind));
            }

            open.actor
                .materialize_replay_pending_for_fence(
                    open.root.clone(),
                    open.workspace_id.clone(),
                    Arc::new(self_writes.scoped(&open.root)),
                    now_ms()?,
                )
                .await
                .map_err(map_runtime)?;

            #[cfg(feature = "harness")]
            if let Some(probe) = &probe {
                probe.record_version_scan();
            }
            let reconcile = capture_driver::reconcile_full_for_switch(
                &open.root,
                &open.actor,
                &open.workspace_id,
                &capture_status,
                &self_writes.scoped(&open.root),
                capture_author_json,
                reconcile_provenance,
                events.clone(),
                token.clone(),
            )
            .await;

            if !matches!(reconcile, Ok(false)) {
                let capture = lock(&open.capture);
                let driver = capture.as_ref().ok_or_else(|| {
                    wire(
                        ErrorCode::WorkspaceUnavailable,
                        "capture driver unavailable",
                    )
                })?;
                driver.request_manifest_refresh();
            }
            let _manifest_changed = reconcile
                .map_err(|error| map_switch_reconcile_error(error, &detached_operation))?;

            #[cfg(feature = "harness")]
            if let Some(probe) = &probe {
                probe.pause_version_commit_if_armed().await;
            }

            let version = match intent {
                VersionFenceIntent::Fork { input } => {
                    open.actor
                        .create_named_version(input, Arc::new(NoFaults), token)
                        .await
                }
                VersionFenceIntent::Switch {
                    target_version_id,
                    now_ms,
                } => {
                    open.actor
                        .set_active_version(
                            dohc_engine_runtime::ActiveVersionSwitch {
                                workspace_id: open.workspace_id.clone(),
                                version_id: target_version_id,
                                root_dir: open.root.clone(),
                                self_writes: Arc::new(self_writes.scoped(&open.root)),
                                now_ms,
                            },
                            Arc::new(NoFaults),
                            token,
                        )
                        .await
                }
            }
            .map_err(map_runtime)?;
            Ok(VersionFenceOutcome::Committed(version))
        });
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                Err(cancellation.interruption(operation))
            }
            outcome = &mut fence => {
                outcome.map_err(|_| wire(ErrorCode::Internal, "version fence task failed"))?
            }
        }
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
                MAX_DESKTOP_CAPTURE_TEXT_BYTES,
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
                    "metadataOrigin": snapshot.metadata_origin,
                    "metadataSummary": snapshot.metadata_summary,
                    "metadataCorrelationId": snapshot.metadata_correlation_id
                });
                if over_cap {
                    body["inbandLimitBytes"] = json!(MAX_DESKTOP_CAPTURE_TEXT_BYTES);
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

    async fn capture_set_author(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: CaptureSetAuthorParams = parse(params)?;
        let author_json = validated_author(params.author.as_ref(), None)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let _apply = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("capture.setAuthor (queued)"));
            }
            guard = Arc::clone(&open.capture_apply_gate).lock_owned() => guard,
        };
        let capture = lock(&open.capture);
        let driver = capture.as_ref().ok_or_else(|| {
            wire(
                ErrorCode::WorkspaceUnavailable,
                "capture driver unavailable",
            )
        })?;
        driver.set_author_json(author_json);
        Ok(json!({ "updated": true }))
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
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(&handle))?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        // Oracle ordering: reject an unknown target, and return a true no-op
        // for the already-active version, before disturbing live sessions.
        let versions = Self::read_under_ctx(
            &cancellation,
            "versions.setActive (target validation)",
            open.actor.list_versions(open.workspace_id.clone()),
        )
        .await?;
        let target = versions
            .into_iter()
            .find(|version| version.version_id == params.version_id)
            .ok_or_else(|| wire(ErrorCode::InvalidParams, "version-not-found"))?;
        let active = Self::read_under_ctx(
            &cancellation,
            "versions.setActive (active version)",
            open.actor.active_version(open.workspace_id.clone()),
        )
        .await?;
        if active.version_id == target.version_id {
            return Ok(version_record_json(&target));
        }

        let fence = self
            .fence_version_snapshot(
                &cancellation,
                &open,
                &handle,
                "versions.setActive",
                "Saved latest edits before switching versions",
                VersionFenceIntent::Switch {
                    target_version_id: target.version_id.clone(),
                    now_ms: now_ms()?,
                },
            )
            .await?;
        match fence {
            VersionFenceOutcome::AlreadyActive => Ok(version_record_json(&target)),
            VersionFenceOutcome::CreateReplay(_) => {
                unreachable!("switch fences never return CreateReplay");
            }
            VersionFenceOutcome::Committed(version) => Ok(version_record_json(&version)),
        }
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
                // The domain code, like every other refusal (`map_runtime`).
                // Spelling this one as prose gave the SAME refusal two wire
                // messages depending on which method the caller reached it
                // through, and a client that keys on the code saw neither.
                return Err(wire(ErrorCode::InvalidParams, "version-not-found"));
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
                    "sha256": row.sha256,
                    "byteLength": row.byte_length,
                    "binarySha256": row.binary_sha256,
                    "updatedAtMs": row.updated_at_ms,
                    "latestMomentId": row.latest_moment_id,
                    "metadataOrigin": row.metadata_origin,
                    "metadataSummary": row.metadata_summary,
                    "metadataCorrelationId": row.metadata_correlation_id,
                    "hasYdocMarker": row.has_ydoc_marker,
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
        request_id: u64,
    ) -> Result<(Value, Option<BlobEgress>), WireError> {
        let params: VersionedBinaryReadBlobParams = parse(params)?;
        if params.sha256.len() != 64 || !params.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(wire(ErrorCode::InvalidParams, "invalid-input"));
        }
        // Stored digests are canonical lowercase hex; an uppercase spelling of
        // a referenced digest must find it, not miss the exact-match lookup.
        let sha256 = params.sha256.to_ascii_lowercase();
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        // MUTATION: hydrate directly before reserving its recorded byte length
        // -> concurrent over-cap reads can retain queue-capacity full blobs.
        // Metadata/in-band first: over-cap bytes do not leave SQLite until the
        // exact-byte egress reservation has been acquired.
        let read = Self::read_under_ctx(
            &cancellation,
            "versionedBinary.readBlob",
            open.actor
                .read_binary_blob(open.workspace_id.clone(), sha256.clone()),
        )
        .await?
        .ok_or_else(|| wire(ErrorCode::InvalidParams, "file-not-found"))?;
        let Some(bytes) = read.bytes else {
            if !ctx.has_capability("blobs") {
                return Ok((
                    json!({
                        "bytesBase64": Value::Null,
                        "byteLength": read.byte_length,
                        "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
                    }),
                    None,
                ));
            }
            let byte_permit = self
                .blob_egress_budget
                .reserve(read.byte_length, &cancellation)
                .await?;
            let hydrated = Self::read_under_ctx(
                &cancellation,
                "versionedBinary.readBlob",
                open.actor
                    .read_binary_blob_for_egress(open.workspace_id, sha256.clone()),
            )
            .await?
            .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            if hydrated.byte_length != read.byte_length {
                return Err(wire(ErrorCode::Internal, "state-corrupt"));
            }
            let bytes = hydrated
                .bytes
                .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            return Ok((
                json!({
                    "bytesBase64": Value::Null,
                    "byteLength": read.byte_length,
                    "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
                }),
                Some(BlobEgress {
                    stream_id: request_id,
                    sha256,
                    bytes,
                    cancel: ctx.cancel.clone(),
                    deadline: ctx.deadline,
                    byte_permit: Some(byte_permit),
                }),
            ));
        };
        Ok((
            json!({
                "bytesBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            }),
            None,
        ))
    }

    async fn versioned_text_read_blob(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
    ) -> Result<(Value, Option<BlobEgress>), WireError> {
        let params: VersionedTextReadBlobParams = parse(params)?;
        if params.sha256.len() != 64 || !params.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(wire(ErrorCode::InvalidParams, "invalid-input"));
        }
        let sha256 = params.sha256.to_ascii_lowercase();
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let read = Self::read_under_ctx(
            &cancellation,
            "versionedText.readBlob",
            open.actor
                .read_text_blob(open.workspace_id.clone(), sha256.clone()),
        )
        .await?
        .ok_or_else(|| wire(ErrorCode::InvalidParams, "file-not-found"))?;
        let Some(text) = read.text else {
            if !ctx.has_capability("blobs") {
                return Ok((
                    json!({
                        "bytesBase64": Value::Null,
                        "byteLength": read.byte_length,
                        "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
                    }),
                    None,
                ));
            }
            let byte_permit = self
                .blob_egress_budget
                .reserve(read.byte_length, &cancellation)
                .await?;
            let hydrated = Self::read_under_ctx(
                &cancellation,
                "versionedText.readBlob",
                open.actor
                    .read_text_blob_for_egress(open.workspace_id, sha256.clone()),
            )
            .await?
            .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            if hydrated.byte_length != read.byte_length {
                return Err(wire(ErrorCode::Internal, "state-corrupt"));
            }
            let bytes = hydrated
                .text
                .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?
                .into_bytes();
            if bytes.len() as i64 != read.byte_length
                || dohc_engine_storage::hex_sha256(&bytes) != sha256
            {
                return Err(wire(ErrorCode::Internal, "state-corrupt"));
            }
            return Ok((
                json!({
                    "bytesBase64": Value::Null,
                    "byteLength": read.byte_length,
                    "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
                }),
                Some(BlobEgress {
                    stream_id: request_id,
                    sha256,
                    bytes,
                    cancel: ctx.cancel.clone(),
                    deadline: ctx.deadline,
                    byte_permit: Some(byte_permit),
                }),
            ));
        };
        let bytes = text.into_bytes();
        if bytes.len() as i64 != read.byte_length
            || dohc_engine_storage::hex_sha256(&bytes) != sha256
        {
            return Err(wire(ErrorCode::Internal, "state-corrupt"));
        }
        Ok((
            json!({
                "bytesBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            }),
            None,
        ))
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

    async fn secrets_state_exists(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: WorkspaceOnlyParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let exists = Self::read_under_ctx(
            &cancellation,
            "secrets.stateExists",
            open.actor.secret_state_exists(open.workspace_id),
        )
        .await?;
        Ok(json!(exists))
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
        let path = params.path.clone();
        let text = params.text;
        if text.len() > dohc_engine_domain::MAX_SECRET_FILE_BYTES {
            return Err(wire(ErrorCode::InvalidParams, "content-exceeds-inband-cap"));
        }
        let origin = validated_origin(Some(&params.origin), None)?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
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
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
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
        let path = params.path.clone();
        let origin = validated_origin(Some(&params.origin), None)?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
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
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
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
        let path = params.path.clone();
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
        // Secret-path gate UP FRONT so the error surface is identical across
        // key states (a non-secret path refuses the same way with or without
        // a key on disk).
        if dohc_engine_files::policy::classify_engine_file_path(&params.path)
            != dohc_engine_files::policy::PathClassification::Secret
        {
            return Err(wire(ErrorCode::InvalidParams, "not-secret-path"));
        }
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let origin = validated_origin(Some(&params.origin), None)?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let path = params.path.clone();
        let cancellation = OperationCancellation::new(ctx);
        for (operation, version_id) in [
            ("secrets.apply (source version)", &params.source_version_id),
            ("secrets.apply (target version)", &params.target_version_id),
        ] {
            let validation = Self::read_under_ctx(
                &cancellation,
                operation,
                open.actor.list_secret_files_page(
                    open.workspace_id.clone(),
                    version_id.clone(),
                    None,
                    1,
                ),
            )
            .await;
            match validation {
                Ok(_) => {}
                Err(error) if error.message == "invalid-version" => {
                    return Err(wire(ErrorCode::InvalidParams, "invalid-version"));
                }
                Err(error) => return Err(error),
            }
        }
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
                params.source_version_id,
                params.target_version_id,
                params.moment_id,
                origin,
                params.summary,
                params.correlation_id,
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
        let origin = validated_origin(Some(&params.origin), None)?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let path = params.path.clone();
        let cancellation = OperationCancellation::new(ctx);
        let result = open
            .actor
            .restore_secret_file(
                open.workspace_id,
                path,
                params.before_moment_id,
                params.moment_id,
                origin,
                params.summary,
                params.correlation_id,
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
                dohc_engine_domain::MAX_SECRET_FILE_BYTES,
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
                    "inbandLimitBytes": dohc_engine_domain::MAX_SECRET_FILE_BYTES,
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
        let params: ChatPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)? as usize;
        let binding = chat_cursor_binding("chats.channels.list", &workspace_id, &[]);
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let cancellation = OperationCancellation::new(ctx);
        let channels = Self::read_under_ctx(
            &cancellation,
            "chats.channels.list",
            open.actor.chat_channels_list(workspace_id),
        )
        .await?;
        let channels: Vec<_> = channels
            .into_iter()
            .filter(|channel| match cursor.as_ref() {
                Some(cursor) => {
                    (
                        channel.channel.created_at_ms,
                        channel.channel.channel_id.as_str(),
                    ) > (cursor.first, cursor.second.as_str())
                }
                None => true,
            })
            .take(page_limit + 1)
            .collect();
        let row_values: Vec<Value> = channels.iter().map(channel_summary_json).collect();
        let included = bounded_chat_page_len(&row_values)?.min(page_limit);
        let next_cursor = chat_page_cursor(
            &channels,
            included,
            cursor.as_ref().map_or(0, |cursor| cursor.consumed),
            binding,
            |channel| {
                (
                    channel.channel.created_at_ms,
                    channel.channel.channel_id.clone(),
                )
            },
        )?;
        Ok(json!({
            "channels": row_values[..included].to_vec(),
            "nextCursor": next_cursor,
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
                    needs_decision: params.needs_decision,
                    attachments: params
                        .attachments
                        .unwrap_or_default()
                        .into_iter()
                        .map(LocalAttachmentInput::from)
                        .collect(),
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({ "thread": thread_b2_json(&thread), "message": message_json(&message) }))
    }

    async fn chats_threads_create(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ChatThreadCreateParams = parse(params)?;
        let request_id = request_id
            .filter(|request_id| !request_id.is_empty())
            .ok_or_else(|| wire(ErrorCode::InvalidParams, "idempotency-key-required"))?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let thread = Self::read_under_ctx(
            &cancellation,
            "chats.threads.create",
            open.actor.chat_thread_create(
                CreateFileThread {
                    workspace_id: open.workspace_id,
                    thread_id: params.thread_id,
                    title: params.title,
                    linked_object_id: params.linked_file.object_id,
                    linked_path_hint: params.linked_file.path_hint,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                cancellation.token(),
            ),
        )
        .await?;
        Ok(thread_b2_json(&thread))
    }

    async fn chats_threads_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)? as usize;
        let binding = chat_cursor_binding("chats.threads.list", &workspace_id, &[]);
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let cancellation = OperationCancellation::new(ctx);
        let threads = Self::read_under_ctx(
            &cancellation,
            "chats.threads.list",
            open.actor.chat_threads_list(workspace_id),
        )
        .await?;
        let threads: Vec<_> = threads
            .into_iter()
            .filter(|thread| match cursor.as_ref() {
                Some(cursor) => {
                    (thread.created_at_ms, thread.thread_id.as_str())
                        > (cursor.first, cursor.second.as_str())
                }
                None => true,
            })
            .take(page_limit + 1)
            .collect();
        let row_values: Vec<Value> = threads.iter().map(thread_json).collect();
        let included = bounded_chat_page_len(&row_values)?.min(page_limit);
        let next_cursor = chat_page_cursor(
            &threads,
            included,
            cursor.as_ref().map_or(0, |cursor| cursor.consumed),
            binding,
            |thread| (thread.created_at_ms, thread.thread_id.clone()),
        )?;
        Ok(json!({
            "threads": row_values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    async fn chats_threads_list_for_file(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadsListForFileParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding(
            "chats.threads.listForFile",
            &workspace_id,
            &[&params.object_id],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.threads.listForFile",
            open.actor.chat_threads_list_for_file(
                workspace_id.clone(),
                params.object_id,
                after,
                page_limit + 1,
            ),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(thread_b2_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let has_more = rows.len() > included;
        let next_cursor = if has_more {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: cursor.as_ref().map_or(0, |cursor| cursor.consumed) + included as i64,
                first: last.created_at_ms,
                second: last.thread_id.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "threads": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    async fn chats_threads_list_for_channel(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadsListForChannelParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding(
            "chats.threads.listForChannel",
            &workspace_id,
            &[&params.channel_id],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.threads.listForChannel",
            open.actor.chat_threads_list_for_channel(
                workspace_id,
                params.channel_id,
                after,
                page_limit + 1,
            ),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(channel_thread_summary_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = if rows.len() > included {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: cursor.as_ref().map_or(0, |cursor| cursor.consumed) + included as i64,
                first: last.thread.updated_at_ms,
                second: last.thread.thread_id.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "threads": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    async fn chats_threads_find_channel_id(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadParams = parse(params)?;
        if params.thread_id.is_empty()
            || params.thread_id.encode_utf16().count() > 256
            || params.thread_id.len() > 512
            || params.thread_id.chars().any(char::is_control)
        {
            return Err(wire(ErrorCode::InvalidParams, "invalid-parameters"));
        }
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let channel_id = Self::read_under_ctx(
            &cancellation,
            "chats.threads.findChannelId",
            open.actor
                .chat_thread_find_channel_id(open.workspace_id, params.thread_id),
        )
        .await?;
        Ok(channel_id.map_or(Value::Null, Value::String))
    }

    async fn chats_threads_get_projection(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadProjectionParams = parse(params)?;
        let linked_file_access = match params.linked_file_access {
            None | Some(ChatProjectionFileAccessParams::Unknown {}) => {
                ChatProjectionFileAccess::Unknown
            }
            Some(ChatProjectionFileAccessParams::Denied {}) => ChatProjectionFileAccess::Denied,
            Some(ChatProjectionFileAccessParams::Allowed { path }) => {
                ChatProjectionFileAccess::Allowed(path)
            }
        };
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let projection = Self::read_under_ctx(
            &cancellation,
            "chats.threads.getProjection",
            open.actor.chat_thread_get_projection(
                open.workspace_id,
                params.thread_id,
                linked_file_access,
            ),
        )
        .await?;
        if projection.text.len() > dohc_engine_domain::INBAND_CONTENT_CAP_BYTES {
            return Err(wire(
                ErrorCode::LimitExceeded,
                "projection-exceeds-inband-limit",
            ));
        }
        Ok(json!({
            "path": projection.path,
            "readOnly": projection.read_only,
            "threadId": projection.thread_id,
            "text": projection.text,
        }))
    }

    async fn chats_attachments_list_for_thread(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatAttachmentsListForThreadParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding(
            "chats.attachments.listForThread",
            &workspace_id,
            &[&params.thread_id],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.attachments.listForThread",
            open.actor.chat_attachments_list_for_thread(
                workspace_id,
                params.thread_id,
                after,
                page_limit + 1,
            ),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(attachment_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let has_more = rows.len() > included;
        let next_cursor = if has_more {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: cursor.as_ref().map_or(0, |cursor| cursor.consumed) + included as i64,
                first: last.created_at_ms,
                second: last.attachment_id.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "attachments": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    async fn chats_attachments_list_file_mentions(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatAttachmentsListFileMentionsParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding(
            "chats.attachments.listFileMentions",
            &workspace_id,
            &[
                params.object_id.as_deref().unwrap_or_default(),
                params.path_hint.as_deref().unwrap_or_default(),
            ],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let consumed = cursor.as_ref().map_or(0, |cursor| cursor.consumed);
        if consumed >= dohc_engine_domain::MAX_FILE_MENTION_RESULTS {
            return Ok(json!({ "mentions": [], "nextCursor": Value::Null }));
        }
        let remaining = dohc_engine_domain::MAX_FILE_MENTION_RESULTS - consumed;
        let fetch_limit = (page_limit + 1).min(remaining);
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.attachments.listFileMentions",
            open.actor.chat_attachments_list_file_mentions(
                workspace_id,
                params.object_id,
                params.path_hint,
                after,
                fetch_limit,
            ),
        )
        .await?;
        let logical_page = page_limit.min(remaining) as usize;
        let values: Vec<Value> = rows
            .iter()
            .take(logical_page)
            .map(file_mention_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let has_more = consumed + (included as i64) < dohc_engine_domain::MAX_FILE_MENTION_RESULTS
            && rows.len() > included;
        let next_cursor = if has_more {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: consumed + included as i64,
                first: last.attachment.created_at_ms,
                second: last.attachment.attachment_id.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "mentions": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    async fn chats_mentions_list_for_handle(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatMentionsListForHandleParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let unread_filter = if params.unread_by_agent_only {
            "unread"
        } else {
            "all"
        };
        let binding = chat_cursor_binding(
            "chats.mentions.listForHandle",
            &workspace_id,
            &[&params.handle, unread_filter],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor.as_ref().map(|cursor| MentionCursor {
            created_at_ms: cursor.first,
            message_id: cursor.second.clone(),
        });
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.mentions.listForHandle",
            open.actor.chat_mentions_list_for_handle(
                workspace_id,
                params.handle,
                params.unread_by_agent_only,
                after,
                page_limit + 1,
            ),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(mention_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = if rows.len() > included {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: cursor.as_ref().map_or(0, |cursor| cursor.consumed) + included as i64,
                first: last.created_at_ms,
                second: last.message_id.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "mentions": values[..included].to_vec(),
            "nextCursor": next_cursor,
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
                    needs_decision: params.needs_decision,
                    attachments: params
                        .attachments
                        .unwrap_or_default()
                        .into_iter()
                        .map(LocalAttachmentInput::from)
                        .collect(),
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                cancellation.token(),
            ),
        )
        .await?;
        Ok(message_json(&message))
    }

    async fn chats_decisions_resolve(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ChatDecisionResolveParams = parse(params)?;
        let request_id = required_idempotency_key(request_id)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let decision = Self::read_under_ctx(
            &cancellation,
            "chats.decisions.resolve",
            open.actor.chat_decision_resolve(
                ResolveDecision {
                    workspace_id: open.workspace_id,
                    thread_id: params.thread_id,
                    message_id: params.message_id,
                    resolved_by_message_id: params.resolved_by_message_id,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                cancellation.token(),
            ),
        )
        .await?;
        Ok(decision_json(&decision))
    }

    async fn chats_decisions_list_for_thread(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding(
            "chats.decisions.listForThread",
            &workspace_id,
            &[&params.thread_id],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.decisions.listForThread",
            open.actor
                .chat_decisions_list(workspace_id, params.thread_id, after, page_limit + 1),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(decision_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = if rows.len() > included {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: cursor.as_ref().map_or(0, |cursor| cursor.consumed) + included as i64,
                first: last.at_ms,
                second: last.message_id.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "decisions": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    async fn chats_reactions_set(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ChatReactionSetParams = parse(params)?;
        let request_id = required_idempotency_key(request_id)?;
        let state = match params.state.as_str() {
            "added" => ChatReactionState::Added,
            "removed" => ChatReactionState::Removed,
            _ => return Err(wire(ErrorCode::InvalidParams, "invalid-parameters")),
        };
        let author_kind = parse_actor_kind(&params.author.kind)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let reaction = Self::read_under_ctx(
            &cancellation,
            "chats.reactions.set",
            open.actor.chat_reaction_set(
                SetReaction {
                    workspace_id: open.workspace_id,
                    thread_id: params.thread_id,
                    message_id: params.message_id,
                    emoji: params.emoji,
                    author_id: params.author.author_id,
                    replication_author_id: params.replication_author_id,
                    author_kind,
                    author_display_name: params.author.display_name,
                    state,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                cancellation.token(),
            ),
        )
        .await?;
        Ok(reaction_json(&reaction))
    }

    async fn chats_reactions_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding =
            chat_cursor_binding("chats.reactions.list", &workspace_id, &[&params.thread_id]);
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.reactions.list",
            open.actor
                .chat_reactions_list(workspace_id, params.thread_id, after, page_limit + 1),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(reaction_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = if rows.len() > included {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: cursor.as_ref().map_or(0, |cursor| cursor.consumed) + included as i64,
                first: last.at_ms,
                second: last.reaction_id.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "reactions": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
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
        let included = bounded_chat_page_len(&row_values)?;
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

    async fn chats_read_state_list_unread_file_threads(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: UnreadFileThreadPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let page_limit = chat_page_limit(params.page_limit)?;
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.readState.listUnreadFileThreads",
            open.actor.chat_read_state_list_unread_file_threads(
                open.workspace_id,
                params.after_thread_id,
                page_limit,
            ),
        )
        .await?;
        Ok(Value::Array(
            rows.into_iter()
                .map(|row| {
                    json!({
                        "threadId": row.thread_id,
                        "messageCount": row.message_count,
                        "lastReadSequence": row.last_read_sequence,
                    })
                })
                .collect(),
        ))
    }

    async fn chats_agent_read_state_list_unread_threads(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding =
            chat_cursor_binding("chats.agentReadState.listUnreadThreads", &workspace_id, &[]);
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.agentReadState.listUnreadThreads",
            open.actor
                .chat_agent_unread_threads(workspace_id, after, page_limit + 1),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(|row| thread_b2_json(&row.thread))
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = if rows.len() > included {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: cursor.as_ref().map_or(0, |cursor| cursor.consumed) + included as i64,
                first: last.latest_created_at_ms,
                second: last.latest_message_id.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "threads": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    async fn chats_agent_read_state_mark_thread_read(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatAgentReadMarkParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let state = Self::read_under_ctx(
            &cancellation,
            "chats.agentReadState.markThreadRead",
            open.actor.chat_agent_mark_thread_read(
                open.workspace_id,
                params.thread_id,
                params.up_to.created_at_ms,
                params.up_to.message_id,
                params.expected_revision,
                now_ms()?,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(agent_read_state_json(&state))
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
        let page_limit = chat_page_limit(params.page_limit)? as usize;
        let state_filter = params.state.as_deref().unwrap_or("");
        let binding = chat_cursor_binding(
            "chats.follows.list",
            &workspace_id,
            &[params.owner_user_id.as_str(), state_filter],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let cancellation = OperationCancellation::new(ctx);
        let follows = Self::read_under_ctx(
            &cancellation,
            "chats.follows.list",
            open.actor
                .chat_follows_list(open.workspace_id, params.owner_user_id, params.state),
        )
        .await?;
        let follows: Vec<_> = follows
            .into_iter()
            .filter(|follow| match cursor.as_ref() {
                Some(cursor) => {
                    format!(
                        "{}\0{}",
                        follow_target_kind_str(follow.target_kind),
                        follow.target_id
                    ) > cursor.second
                }
                None => true,
            })
            .take(page_limit + 1)
            .collect();
        let row_values: Vec<Value> = follows
            .iter()
            .map(|follow| follow_json(&workspace_id, follow))
            .collect();
        let included = bounded_chat_page_len(&row_values)?.min(page_limit);
        let next_cursor = chat_page_cursor(
            &follows,
            included,
            cursor.as_ref().map_or(0, |cursor| cursor.consumed),
            binding,
            |follow| {
                (
                    0,
                    format!(
                        "{}\0{}",
                        follow_target_kind_str(follow.target_kind),
                        follow.target_id
                    ),
                )
            },
        )?;
        Ok(json!({
            "follows": row_values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    async fn chats_follows_ensure_defaults(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatOwnerParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        Self::read_under_ctx(
            &cancellation,
            "chats.follows.ensureDefaults",
            open.actor.chat_follows_ensure_defaults(
                open.workspace_id,
                params.owner_user_id,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(Value::Null)
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
                params.limit,
                params.cursor,
            ),
        )
        .await?;
        let row_values: Vec<Value> = page
            .items
            .iter()
            .map(|item| {
                let mut value = json!({
                    "message": message_json(&item.message),
                    "thread": thread_b2_json(&item.thread),
                    "reactions": item.reactions.iter().map(reaction_json).collect::<Vec<_>>(),
                    "matchedBy": item.matched_by.iter().map(follow_target_kind_json).collect::<Vec<_>>(),
                });
                let object = value.as_object_mut().expect("feed item is an object");
                if let Some(channel) = &item.channel {
                    object.insert("channel".to_owned(), feed_channel_json(channel));
                }
                if let Some(parent_message) = &item.parent_message {
                    object.insert(
                        "parentMessage".to_owned(),
                        message_json(parent_message),
                    );
                }
                if let Some(opening_message) = &item.opening_message {
                    object.insert(
                        "openingMessage".to_owned(),
                        message_json(opening_message),
                    );
                }
                value
            })
            .collect();
        let included = bounded_chat_page_len(&row_values)?;
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
        Ok(bookmark
            .as_ref()
            .map(|bookmark| bookmark_json(&workspace_id, bookmark))
            .unwrap_or(Value::Null))
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
        let logical_limit = params.limit.unwrap_or(50);
        if !(1..=200).contains(&logical_limit) {
            return Err(wire(ErrorCode::InvalidParams, "invalid-parameters"));
        }
        let page_limit = chat_page_limit(params.page_limit)?;
        let logical_limit_binding = logical_limit.to_string();
        let binding = chat_cursor_binding(
            "chats.bookmarks.listPending",
            &workspace_id,
            &[&params.owner_user_id, &logical_limit_binding],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let consumed = cursor.as_ref().map_or(0, |cursor| cursor.consumed);
        if consumed > logical_limit {
            return Err(wire(ErrorCode::InvalidParams, "invalid-cursor"));
        }
        let remaining = logical_limit - consumed;
        if remaining == 0 {
            return Ok(json!({ "bookmarks": [], "nextCursor": Value::Null }));
        }
        let take = remaining.min(page_limit);
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.bookmarks.listPending",
            open.actor.chat_bookmarks_list_pending(
                workspace_id.clone(),
                params.owner_user_id,
                take + 1,
                after,
            ),
        )
        .await?;
        let row_values: Vec<Value> = rows
            .iter()
            .take(take as usize)
            .map(|row| bookmark_json(&workspace_id, &row.bookmark))
            .collect();
        let included = bounded_chat_page_len(&row_values)?;
        let next_consumed = consumed + included as i64;
        let has_more = next_consumed < logical_limit && rows.len() > included;
        let next_cursor = if has_more {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: next_consumed,
                first: last.outbox_updated_at_ms,
                second: last.bookmark.bookmark_id.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "bookmarks": row_values[..included].to_vec(),
            "nextCursor": next_cursor,
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
        let page_limit = chat_page_limit(params.page_limit)? as usize;
        let state_filter = params.state.as_deref().unwrap_or("");
        let binding = chat_cursor_binding(
            "chats.bookmarks.list",
            &workspace_id,
            &[params.owner_user_id.as_str(), state_filter],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
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
        let bookmarks: Vec<_> = bookmarks
            .into_iter()
            .filter(|bookmark| match cursor.as_ref() {
                Some(cursor) => {
                    bookmark.updated_at_ms < cursor.first
                        || (bookmark.updated_at_ms == cursor.first
                            && bookmark.bookmark_id > cursor.second)
                }
                None => true,
            })
            .take(page_limit + 1)
            .collect();
        let row_values: Vec<Value> = bookmarks
            .iter()
            .map(|bookmark| bookmark_json(&workspace_id, bookmark))
            .collect();
        let included = bounded_chat_page_len(&row_values)?.min(page_limit);
        let next_cursor = chat_page_cursor(
            &bookmarks,
            included,
            cursor.as_ref().map_or(0, |cursor| cursor.consumed),
            binding,
            |bookmark| (bookmark.updated_at_ms, bookmark.bookmark_id.clone()),
        )?;
        Ok(json!({
            "bookmarks": row_values[..included].to_vec(),
            "nextCursor": next_cursor,
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

    async fn chats_bookmarks_mark_pending(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ChatBookmarkArchiveParams = parse(params)?;
        let request_id = request_id
            .filter(|request_id| !request_id.is_empty())
            .ok_or_else(|| wire(ErrorCode::InvalidParams, "idempotency-key-required"))?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let cancellation = OperationCancellation::new(ctx);
        let bookmark = Self::read_under_ctx(
            &cancellation,
            "chats.bookmarks.markPending",
            open.actor.chat_bookmark_mark_pending(
                workspace_id.clone(),
                params.owner_user_id,
                params.bookmark_id,
                request_id,
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

    async fn chats_dispatch_record_eligible_triggers(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchRecordEligibleParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let inserted = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.recordEligibleTriggers",
            open.actor.chat_dispatch_record_eligible_triggers(
                open.workspace_id,
                params.verified_user_id,
                now_ms()?,
                cancellation.token.clone(),
            ),
        )
        .await?;
        Ok(json!(inserted))
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

    async fn chats_dispatch_list_pending(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding("chats.dispatch.listPending", &workspace_id, &[]);
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.listPending",
            open.actor
                .chat_dispatch_list_pending(workspace_id, after, page_limit + 1),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(dispatch_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = chat_page_cursor(
            &rows,
            included,
            cursor.as_ref().map_or(0, |cursor| cursor.consumed),
            binding,
            |row| (row.created_at_ms, row.trigger_message_id.clone()),
        )?;
        Ok(json!({
            "dispatches": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    async fn chats_dispatch_open_runs(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding("chats.dispatch.openRuns", &workspace_id, &[]);
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.openRuns",
            open.actor
                .chat_dispatch_open_runs(workspace_id, after, page_limit + 1),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(dispatch_claim_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = chat_page_cursor(
            &rows,
            included,
            cursor.as_ref().map_or(0, |cursor| cursor.consumed),
            binding,
            |claim| {
                (
                    claim.dispatch.updated_at_ms,
                    claim.dispatch.trigger_message_id.clone(),
                )
            },
        )?;
        Ok(json!({
            "claims": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    async fn chats_dispatch_list_run_messages(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchRunPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding(
            "chats.dispatch.listRunMessages",
            &workspace_id,
            &[&params.run_id],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.listRunMessages",
            open.actor.chat_dispatch_list_run_messages(
                workspace_id,
                params.run_id,
                cursor.as_ref().map(|cursor| cursor.second.clone()),
                page_limit + 1,
            ),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(|message_id| json!(message_id))
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = if rows.len() > included {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: cursor.as_ref().map_or(0, |cursor| cursor.consumed) + included as i64,
                first: 0,
                second: last.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "messageIds": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    async fn chats_dispatch_run_id_for_message(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchMessageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let run_id = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.runIdForMessage",
            open.actor
                .chat_dispatch_run_id_for_message(open.workspace_id, params.message_id),
        )
        .await?;
        Ok(run_id.map_or(Value::Null, Value::String))
    }

    async fn chats_dispatch_run_records_for_thread(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchThreadRunsParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let limit_binding = params
            .limit
            .map_or_else(String::new, |limit| limit.to_string());
        let binding = chat_cursor_binding(
            "chats.dispatch.runRecordsForThread",
            &workspace_id,
            &[&params.thread_id, &limit_binding],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = match &cursor {
            None => None,
            Some(cursor) => Some((
                cursor.first,
                cursor.second.clone(),
                cursor
                    .third
                    .clone()
                    .ok_or_else(|| wire(ErrorCode::InvalidParams, "invalid-cursor"))?,
            )),
        };
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.runRecordsForThread",
            open.actor.chat_dispatch_run_records_for_thread(
                workspace_id,
                params.thread_id,
                params.limit,
                after,
                page_limit + 1,
            ),
        )
        .await?;
        let entry_values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(|row| {
                let mut entry = serde_json::Map::new();
                entry.insert(row.message_id.clone(), run_json(&row.run));
                Value::Object(entry)
            })
            .collect();
        let included = bounded_chat_page_len(&entry_values)?;
        let mut runs = serde_json::Map::new();
        for row in rows.iter().take(included) {
            runs.insert(row.message_id.clone(), run_json(&row.run));
        }
        let next_cursor = if rows.len() > included {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| wire(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: cursor.as_ref().map_or(0, |cursor| cursor.consumed) + included as i64,
                first: last.run.started_at_ms,
                second: last.run.run_id.clone(),
                third: Some(last.message_id.clone()),
            })?)
        } else {
            None
        };
        Ok(json!({ "runs": runs, "nextCursor": next_cursor }))
    }

    async fn chats_dispatch_get_run_record(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchRunParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let run = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.getRunRecord",
            open.actor
                .chat_dispatch_get_run_record(open.workspace_id, params.run_id),
        )
        .await?;
        Ok(run.as_ref().map(run_json).unwrap_or(Value::Null))
    }

    async fn chats_dispatch_thread_paused(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let paused = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.isThreadPaused",
            open.actor
                .chat_dispatch_thread_paused(open.workspace_id, params.thread_id),
        )
        .await?;
        Ok(json!(paused))
    }

    async fn chats_dispatch_get_thread_pause_state(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let pause = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.getThreadPauseState",
            open.actor
                .chat_dispatch_get_thread_pause_state(open.workspace_id, params.thread_id),
        )
        .await?;
        Ok(pause.as_ref().map(pause_json).unwrap_or(Value::Null))
    }

    async fn chats_dispatch_recent_count(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchRecentCountParams = parse(params)?;
        if !params.since_ms.is_finite() {
            return Err(wire(ErrorCode::InvalidParams, "invalid-input"));
        }
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let count = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.recentCount",
            open.actor.chat_dispatch_recent_count(
                open.workspace_id,
                params.thread_id,
                params.since_ms,
            ),
        )
        .await?;
        Ok(json!(count))
    }

    async fn chats_dispatch_fail_pending_for_thread(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchFailPendingParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let changed = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.failPendingForThread",
            open.actor.chat_dispatch_fail_pending_for_thread(
                open.workspace_id,
                params.thread_id,
                params.reason,
                now_ms()?,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!(changed))
    }

    async fn chats_dispatch_record_run_message(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchRecordRunMessageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let inserted = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.recordRunMessage",
            open.actor.chat_dispatch_record_run_message(
                open.workspace_id,
                params.message_id,
                params.run_id,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!(inserted))
    }

    async fn chats_dispatch_set_thread_paused(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchSetPausedParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let pause = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.setThreadPaused",
            open.actor.chat_dispatch_set_thread_paused(
                open.workspace_id,
                params.thread_id,
                params.paused,
                params.reason,
                now_ms()?,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(pause_json(&pause))
    }

    async fn chats_dispatch_mark_failure_note_posted(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchRunParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let run = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.markFailureNotePosted",
            open.actor.chat_dispatch_mark_failure_note_posted(
                open.workspace_id,
                params.run_id,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(run_json(&run))
    }

    async fn chats_dispatch_requeue_failed_trigger(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatDispatchRequeueParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let requeued = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.requeueFailedTrigger",
            open.actor.chat_dispatch_requeue_failed_trigger(
                open.workspace_id,
                params.trigger_message_id,
                params.run_id,
                now_ms()?,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!(requeued))
    }

    async fn chats_dispatch_list_app_quit_recoveries(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding =
            chat_cursor_binding("chats.dispatch.listAppQuitRecoveries", &workspace_id, &[]);
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.dispatch.listAppQuitRecoveries",
            open.actor
                .chat_dispatch_list_app_quit_recoveries(workspace_id, after, page_limit + 1),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(|recovery| {
                json!({
                    "run": run_json(&recovery.run),
                    "attemptCount": recovery.attempt_count,
                })
            })
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = chat_page_cursor(
            &rows,
            included,
            cursor.as_ref().map_or(0, |cursor| cursor.consumed),
            binding,
            |recovery| (recovery.run.started_at_ms, recovery.run.run_id.clone()),
        )?;
        Ok(json!({
            "recoveries": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
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
            serial = open.session_ops.lock() => serial,
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
            serial = open.session_ops.lock() => serial,
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
            head: if state.head_blob_sha256.is_some() {
                "present"
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
        let open = self.open(handle.as_ref())?;
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
            serial = Arc::clone(&open.session_ops).lock_owned() => serial,
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
        let open = self.open(handle.as_ref())?;
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.settle (queued)"));
            }
            serial = open.session_ops.lock() => serial,
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
            materialized: settled.materialized,
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
        let open = self.open(handle.as_ref())?;
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.applyExternalMarkdownEdit (queued)"));
            }
            serial = open.session_ops.lock() => serial,
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
        let open = self.open(handle.as_ref())?;
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.close (queued)"));
            }
            serial = open.session_ops.lock() => serial,
        };
        self.ydoc_close_inner(&cancellation, handle.as_ref(), params)
            .await
    }

    /// Close one session while the caller already owns the workspace's
    /// `session_ops`.
    /// `versions.setActive` uses the same primitive for its all-session sweep,
    /// so manual close and switch-time close have identical settle/retry/prune
    /// behavior.
    async fn ydoc_close_inner(
        &self,
        cancellation: &OperationCancellation,
        handle: Option<&WorkspaceHandle>,
        params: YdocCloseParams,
    ) -> Result<Value, WireError> {
        // Missing `settle` means SETTLE — the TS driver treats close() as
        // settle-unless-explicitly-false, and defaulting to false here would
        // fail dirty local-only closes (UnsettledClose) and let a replicated
        // close compact while the markdown projection is stale.
        let default_settle = {
            let (_open, session) = self.ydoc_session(handle, &params.session_id)?;
            // An untouched absent-lineage session (opened, never seeded) has
            // nothing to settle: defaulting to settle there would refuse
            // NoMarker and strand the session/lease.
            !(session.lineage_absent && session.first_update_pending)
        };
        if params.settle.unwrap_or(default_settle) {
            let settled = self
                .ydoc_settle_inner(
                    cancellation,
                    handle,
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
                        cancellation,
                        handle,
                        &params.session_id,
                        params.summary.as_deref(),
                    )
                    .await?;
                }
                Err(error) => return Err(error),
            }
        }
        let (open, session) = self.ydoc_session(handle, &params.session_id)?;
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
        let open = self.open(handle.as_ref())?;
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.resync (queued)"));
            }
            serial = open.session_ops.lock() => serial,
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
                last_settled_sha: session.last_settled_sha.clone(),
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
            .conflict_list(
                open.workspace_id,
                params.status,
                params.after_conflict_id,
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        // The domain query returns sixteen candidates plus one lookahead, with
        // LIMIT applied before its blob joins hydrate the three text sides.
        let candidates = conflicts.len().min(CONFLICTS_RESPONSE_ROW_LIMIT);
        let rows: Vec<Value> = conflicts[..candidates].iter().map(conflict_json).collect();
        let included = byte_budget_cut_serialized_with_row_cap(
            &rows,
            CONFLICTS_PAGE_BYTE_BUDGET,
            CONFLICT_ROW_HARD_CAP_BYTES,
        );
        if included == 0 && !conflicts.is_empty() {
            return Err(wire(
                ErrorCode::LimitExceeded,
                "conflict-row-exceeds-wire-limit",
            ));
        }
        let next_after_conflict_id = (included < conflicts.len())
            .then(|| {
                conflicts[..included]
                    .last()
                    .map(|conflict| conflict.conflict_id.clone())
            })
            .flatten();
        Ok(json!({
            "conflicts": rows[..included].to_vec(),
            "nextAfterConflictId": next_after_conflict_id,
        }))
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
            .conflict_open(Box::new(conflict), Arc::new(NoFaults), cancellation.token())
            .await
            .map_err(map_runtime)?;
        Ok(json!({ "inserted": inserted }))
    }

    async fn conflicts_resolve(
        &self,
        ctx: &RequestContext,
        id: u64,
        deadline_ms: Option<u32>,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let encoded_request = resolve_request_encoded_bytes(
            id,
            deadline_ms,
            handle.as_ref(),
            request_id.as_deref(),
            &params,
        );
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
        validate_metadata_fields(
            local.metadata_summary.as_deref(),
            local.metadata_correlation_id.as_deref(),
        )?;
        let metadata_origin = validated_origin(Some(&local.metadata_origin), None)?;
        let resolution = match local.resolution.as_str() {
            "keep-current" => ResolveConflictKind::KeepCurrent,
            "apply-incoming" => ResolveConflictKind::ApplyIncoming,
            "apply-merged" => {
                let text = local
                    .merged_text
                    .ok_or_else(|| wire(ErrorCode::InvalidParams, "missing merged text"))?;
                if encoded_request > RESOLVE_REQUEST_FRAME_BYTES {
                    return Err(WireError::new(
                        ErrorCode::InvalidParams,
                        format!(
                            "merged-text-exceeds-wire-limit: one control frame carries a \
                             resolve request of at most {RESOLVE_REQUEST_FRAME_BYTES} encoded \
                             bytes, observed {encoded_request} encoded bytes for this request \
                             ({} raw bytes of combined body, {} encoded)",
                            text.len(),
                            json_string_encoded_len(&text)
                        ),
                    ));
                }
                ResolveConflictKind::ApplyMerged { text }
            }
            _ => {
                return Err(wire(
                    ErrorCode::InvalidParams,
                    "unknown conflict resolution",
                ));
            }
        };
        let result = open
            .actor
            .conflict_resolve_indexed(
                ResolveTextConflict {
                    workspace_id: open.workspace_id,
                    conflict_id: local.conflict_id,
                    resolution,
                    object_id: local.object_id,
                    write_moment_id: local.write_moment_id,
                    delete_moment_id: local.delete_moment_id,
                    metadata_origin,
                    metadata_summary: local.metadata_summary,
                    metadata_correlation_id: local.metadata_correlation_id,
                    author_json: local.author_json,
                    now_ms: local.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                open.root,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({
            "conflict": settled_conflict_json(&result.conflict),
            "write": result.write.as_ref().map(|write| json!({
                "object": file_object_json(&write.object),
                "snapshot": settled_snapshot_json(&write.snapshot),
                "moment": moment_json(&write.moment),
            })),
            // The preimage is described by the MOMENT, not by the text view of
            // the head it removed. A resolution can remove a binary head, whose
            // view carries empty text and the binary hash in `blob_sha256` —
            // `snapshot_json` would report that as an empty TEXT file.
            "delete": result.delete.as_ref().map(|delete| json!({
                "object": file_object_json(&delete.object),
                "before": snapshot_metadata_json(
                    &delete.before,
                    &delete.moment.before_content_kind,
                    delete.moment.before_binary_sha256.as_deref(),
                    delete.moment.before_byte_length,
                ),
                "moment": moment_json(&delete.moment),
            })),
        }))
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

    async fn search_query_page(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SearchPageParams = parse(params)?;
        let limit = params
            .limit
            .unwrap_or(dohc_engine_runtime::search::DEFAULT_SEARCH_LIMIT);
        if !(1..=i64::try_from(dohc_engine_runtime::search::MAX_RESULT_LIMIT).unwrap_or(i64::MAX))
            .contains(&limit)
        {
            return Err(wire(ErrorCode::InvalidParams, "invalid-parameters"));
        }
        let limit = usize::try_from(limit)
            .map_err(|_| wire(ErrorCode::InvalidParams, "invalid-parameters"))?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let active_version_id = Self::read_under_ctx(
            &cancellation,
            "search.queryPage (active version)",
            open.actor.active_version_id(open.workspace_id.clone()),
        )
        .await?;
        let limit_binding = limit.to_string();
        let binding = chat_cursor_binding(
            "search.queryPage",
            &open.workspace_id,
            &[&params.query, &limit_binding],
        );
        let cursor = decode_search_cursor(params.cursor.as_deref(), &binding, limit)?;
        if cursor
            .as_ref()
            .is_some_and(|cursor| cursor.active_version_id != active_version_id)
        {
            return Ok(json!({
                "results": [],
                "nextCursor": null,
                "versionId": active_version_id,
                "restartRequired": true,
            }));
        }
        let consumed = cursor.as_ref().map_or(0, |cursor| cursor.consumed);
        let remaining = limit.saturating_sub(consumed);
        let expected_generation = cursor.as_ref().map(|cursor| cursor.generation);
        let after = cursor.as_ref().map(|cursor| SearchResultKey {
            surface: if cursor.surface == "file" {
                SearchSurface::File
            } else {
                SearchSurface::Chat
            },
            rowid: cursor.rowid,
            line: cursor.line,
        });
        let page = open
            .actor
            .search_page(
                open.root,
                open.workspace_id,
                active_version_id.clone(),
                params.query,
                Some(i64::try_from(remaining).unwrap_or(i64::MAX)),
                params.now_ms.unwrap_or(now_ms()?),
                expected_generation,
                after,
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        if page.disposition == SearchPageDisposition::Restart {
            return Ok(json!({
                "results": [],
                "nextCursor": null,
                "versionId": active_version_id,
                "restartRequired": true,
            }));
        }
        let row_values: Vec<Value> = page
            .results
            .iter()
            .map(|keyed| {
                let result = &keyed.result;
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
            .collect();
        let included = byte_budget_cut_serialized(&row_values, SEARCH_PAGE_BYTE_BUDGET);
        if included == 0 && !row_values.is_empty() {
            return Err(wire(
                ErrorCode::LimitExceeded,
                "search-result-exceeds-wire-limit",
            ));
        }
        let total_consumed = consumed.saturating_add(included);
        let needs_continuation =
            total_consumed < limit && (included < row_values.len() || page.has_more);
        let next_cursor = if needs_continuation {
            let key = if included < row_values.len() {
                page.results
                    .get(included.saturating_sub(1))
                    .map(|keyed| keyed.key)
            } else {
                page.continuation
            }
            .ok_or_else(|| wire(ErrorCode::Internal, "search-page-made-no-progress"))?;
            Some(encode_search_cursor(&SearchPageCursor {
                version: 3,
                binding,
                active_version_id: active_version_id.clone(),
                consumed: total_consumed,
                generation: page.generation,
                surface: match key.surface {
                    SearchSurface::File => "file",
                    SearchSurface::Chat => "chat",
                }
                .to_owned(),
                rowid: key.rowid,
                line: key.line,
            })?)
        } else {
            None
        };
        Ok(json!({
            "results": &row_values[..included],
            "nextCursor": next_cursor,
            "versionId": active_version_id,
            "restartRequired": false,
        }))
    }

    async fn search_query_chat_messages_granular(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SearchChatMessagesGranularParams = parse(params)?;
        let effective_limit = usize::try_from(params.limit)
            .unwrap_or(dohc_engine_runtime::search::MAX_GRANULAR_CHAT_RESULT_LIMIT)
            .min(dohc_engine_runtime::search::MAX_GRANULAR_CHAT_RESULT_LIMIT);
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let batch = Self::read_under_ctx(
            &cancellation,
            "search.queryChatMessagesGranular",
            open.actor.search_query_chat_messages_granular(
                open.workspace_id,
                params.query,
                params.limit,
                GRANULAR_CHAT_RESPONSE_BYTE_BUDGET,
            ),
        )
        .await?;
        let saturated_by_limit = params.limit > 0 && batch.results.len() == effective_limit;
        let row_values: Vec<Value> = batch
            .results
            .into_iter()
            .map(|row| {
                json!({
                    "threadId": row.thread_id,
                    "messageId": row.message_id,
                    "text": row.text,
                })
            })
            .collect();
        let included = byte_budget_cut_serialized(&row_values, GRANULAR_CHAT_RESPONSE_BYTE_BUDGET);
        if included == 0 && !row_values.is_empty() {
            return Err(wire(
                ErrorCode::LimitExceeded,
                "granular-chat-row-exceeds-wire-limit",
            ));
        }
        Ok(json!({
            "results": &row_values[..included],
            "saturated": batch.saturated_by_bytes
                || saturated_by_limit
                || included < row_values.len(),
        }))
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
        let versions = Self::read_under_ctx(
            &cancellation,
            "search.ensureIndex (version)",
            open.actor.list_versions(open.workspace_id.clone()),
        )
        .await?;
        if !versions
            .iter()
            .any(|version| version.version_id == params.version_id)
        {
            return Err(wire(ErrorCode::InvalidParams, "version-not-found"));
        }
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

async fn close_ydoc_session_for_version_fence(
    sessions: &Arc<Mutex<HashMap<String, YdocSession>>>,
    self_writes: &SelfWriteSuppression,
    open: &OpenWorkspace,
    handle: &WorkspaceHandle,
    session_id: &str,
    _summary: &str,
    token: &CancellationToken,
) -> Result<(), WireError> {
    let session = version_fence_session_view(sessions, handle, session_id)?;
    // Mirrors ydoc.close's default-settle rule: only an untouched
    // absent-lineage session (nothing to settle) skips the settling sweep.
    let settle = !(session.lineage_absent && session.first_update_pending);
    if settle {
        let first = settle_ydoc_session_for_version_fence(
            sessions,
            self_writes,
            open,
            session_id,
            &session,
            token,
        )
        .await;
        match first {
            Ok(()) => {}
            Err(error) if error.message == "ydoc-remote-updates-pending" => {
                let refreshed = version_fence_session_view(sessions, handle, session_id)?;
                settle_ydoc_session_for_version_fence(
                    sessions,
                    self_writes,
                    open,
                    session_id,
                    &refreshed,
                    token,
                )
                .await?;
            }
            Err(error) => return Err(error),
        }
    }

    let session = version_fence_session_view(sessions, handle, session_id)?;
    let now = now_ms()?;
    let taken = lock(sessions).remove(session_id);
    let close = open
        .actor
        .ydoc_close_session(
            session.key,
            now,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await;
    if matches!(
        close,
        Err(RuntimeError::Collab(_)) | Err(RuntimeError::Domain(_))
    ) && let Some(entry) = taken
    {
        lock(sessions).insert(session_id.to_owned(), entry);
    }
    close.map_err(map_runtime)?;
    Ok(())
}

fn version_fence_session_view(
    sessions: &Arc<Mutex<HashMap<String, YdocSession>>>,
    handle: &WorkspaceHandle,
    session_id: &str,
) -> Result<YdocSessionView, WireError> {
    let sessions = lock(sessions);
    let session = sessions
        .get(session_id)
        .filter(|session| session.workspace == *handle)
        .ok_or_else(|| wire(ErrorCode::InvalidParams, "ydoc-session-not-found"))?;
    Ok(YdocSessionView {
        key: session.key.clone(),
        path: session.path.clone(),
        content_kind: session.content_kind,
        regime: session.regime,
        lineage_absent: session.lineage_absent,
        first_update_pending: session.first_update_pending,
        last_settled_sha: session.last_settled_sha.clone(),
        open_head_sha: session.open_head_sha.clone(),
    })
}

async fn settle_ydoc_session_for_version_fence(
    sessions: &Arc<Mutex<HashMap<String, YdocSession>>>,
    self_writes: &SelfWriteSuppression,
    open: &OpenWorkspace,
    session_id: &str,
    session: &YdocSessionView,
    token: &CancellationToken,
) -> Result<(), WireError> {
    let settled = open
        .actor
        .ydoc_settle(
            open.root.clone(),
            session.key.clone(),
            session.path.clone(),
            session.content_kind,
            settle_preimage(&session.last_settled_sha, &session.open_head_sha),
            session_id.to_owned(),
            Arc::new(self_writes.scoped(&open.root)),
            now_ms()?,
            Arc::new(NoFaults),
            token.clone(),
        )
        .await
        .map_err(|error| {
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
    if let Some(session) = lock(sessions).get_mut(session_id) {
        session.last_settled_sha = Some(settled.sha256);
    }
    Ok(())
}

fn unsettled_fork_error(_content_kind: ContentKind) -> WireError {
    // Both kinds settle now (richdoc projection is full-fidelity since
    // R15-3), so an unsettled lineage refuses with one message.
    wire(ErrorCode::InvalidParams, "ydoc-unsettled-close")
}

fn settle_preimage(
    last_settled_sha: &Option<String>,
    open_head_sha: &Option<String>,
) -> Option<String> {
    last_settled_sha.clone().or_else(|| open_head_sha.clone())
}

#[cfg(test)]
mod version_fence_preimage_tests {
    use super::settle_preimage;

    #[test]
    fn latest_settlement_outranks_the_open_head() {
        assert_eq!(
            settle_preimage(
                &Some("latest-settlement".to_owned()),
                &Some("original-open-head".to_owned())
            ),
            Some("latest-settlement".to_owned())
        );
        assert_eq!(
            settle_preimage(&None, &Some("original-open-head".to_owned())),
            Some("original-open-head".to_owned())
        );
    }
}

fn map_switch_reconcile_error(
    error: capture_driver::SwitchReconcileError,
    operation: &str,
) -> WireError {
    match error {
        capture_driver::SwitchReconcileError::Cancelled => WireError::new(
            ErrorCode::Internal,
            format!("{operation} detached full scan was interrupted"),
        ),
        capture_driver::SwitchReconcileError::Degraded(mut paths) => {
            paths.sort();
            paths.dedup();
            let message = if paths.is_empty() {
                "Could not scan workspace paths".to_owned()
            } else {
                format!("Could not scan workspace paths: {}", paths.join(", "))
            };
            WireError::new(ErrorCode::Internal, message)
        }
        capture_driver::SwitchReconcileError::Unavailable => wire(
            ErrorCode::WorkspaceUnavailable,
            "capture driver unavailable",
        ),
        capture_driver::SwitchReconcileError::ApplyFailed => {
            wire(ErrorCode::Internal, "pre-version-reconcile-failed")
        }
    }
}

impl ProtocolEngineService for EngineService {
    async fn call(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
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
    #[serde(default)]
    capture_author: Option<Value>,
    #[serde(default)]
    recover_running_dispatches: Option<bool>,
    #[serde(default)]
    skip_startup_maintenance: bool,
    #[serde(default)]
    capture_mode: Option<WorkspaceCaptureMode>,
    #[serde(default)]
    relay: Option<RelayOpenParams>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum WorkspaceCaptureMode {
    None,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelayOpenParams {
    base_url: String,
    bearer_token: String,
    #[cfg(debug_assertions)]
    #[serde(default)]
    allow_insecure_loopback_for_tests: bool,
}

impl RelayOpenParams {
    fn configuration(&self) -> RelayConfiguration {
        RelayConfiguration {
            base_url: self.base_url.clone(),
            bearer_token: self.bearer_token.clone(),
            #[cfg(debug_assertions)]
            allow_insecure_loopback_for_tests: self.allow_insecure_loopback_for_tests,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelayWorkspaceParams {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdoptJoinIdentityParams {
    workspace_id: String,
    replication_epoch: String,
    stream_identity: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitCursorParams {
    workspace_id: String,
    pending_cursor: PendingCursorParams,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum PendingCursorParams {
    Relay { token: String },
    ShareView { token: String },
}

#[derive(Clone, Copy)]
enum PendingCursorKind {
    Relay,
    ShareView,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyEnvelopeUploadParams {
    workspace_id: String,
    envelope_json: String,
    #[serde(default)]
    if_match: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedChannelParams {
    workspace_id: String,
    share_id: String,
    channel_wire_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareViewParams {
    workspace_id: String,
    share_id: String,
    /// The selector the relay stated for this share, pinned by the caller on
    /// first read. REQUIRED, and required as an object: absent and explicit
    /// `null` both parse as "no scope", which is the one pull nothing checks.
    /// Serde refuses either — a caller with no selector must resolve one
    /// before it pulls.
    granted_selector: GrantedSelectorParams,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantedSelectorParams {
    paths: Vec<String>,
    #[serde(default)]
    version_id: Option<String>,
}

impl From<GrantedSelectorParams> for dohc_engine_sync::ShareGrant {
    fn from(params: GrantedSelectorParams) -> Self {
        Self {
            paths: params.paths,
            version_id: params.version_id,
        }
    }
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
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
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
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    author_json: Option<String>,
    #[serde(default)]
    moment_id: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedBinaryWriteBlobParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
    #[serde(default)]
    object_id: Option<String>,
    path: String,
    sha256: String,
    #[serde(default)]
    bytes_base64: Option<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    metadata_origin: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    author_json: Option<String>,
    #[serde(default)]
    moment_id: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
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
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
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
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
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
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
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
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsDeleteParams {
    workspace_id: String,
    version_id: String,
    path: String,
    origin: String,
    moment_id: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
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
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
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
    source_version_id: String,
    target_version_id: String,
    moment_id: String,
    origin: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsRestoreParams {
    workspace_id: String,
    path: String,
    before_moment_id: String,
    moment_id: String,
    origin: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
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
struct VersionedTextReadBlobParams {
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
    /// Whether the ENTERED VERSION has a committed snapshot for this path.
    /// "absent" means the daemon bound an empty doc over a path the version
    /// does not contain — legitimate only while the caller is creating the
    /// file. The consumer owns that decision; the contract it applies is
    /// stated on `WorkspaceEngineCapture.openYDocSession`
    /// (apps/desktop/src/workspaces/workspaceEngineCapture.ts).
    head: &'static str,
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
    /// `null` once the settled markdown is past the in-band cap. The settle
    /// still committed and the daemon wrote the file — the client reads it
    /// from disk rather than echoing it back over the wire.
    markdown: Option<String>,
    sha256: String,
    /// `false` when the settle committed but materialization was blocked by
    /// containment: the file on disk is still the OLD artifact and the write
    /// is pending a retry. Nothing may report the document as saved on this.
    materialized: bool,
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
    #[serde(default)]
    after_conflict_id: Option<String>,
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
    metadata_summary: Option<String>,
    metadata_correlation_id: Option<String>,
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
struct SearchPageParams {
    query: String,
    limit: Option<i64>,
    cursor: Option<String>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchChatMessagesGranularParams {
    query: String,
    limit: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchEnsureIndexParams {
    workspace_id: String,
    version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureSetAuthorParams {
    author: Option<Value>,
}

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
    #[serde(default)]
    needs_decision: bool,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_attachments"
    )]
    attachments: Option<Vec<ChatLocalAttachmentParams>>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatLocalAttachmentParams {
    object_id: String,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    path_hint: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    heading_text: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    heading_anchor: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_i64")]
    heading_occurrence: Option<i64>,
}

impl From<ChatLocalAttachmentParams> for LocalAttachmentInput {
    fn from(value: ChatLocalAttachmentParams) -> Self {
        LocalAttachmentInput {
            object_id: value.object_id,
            path_hint: value.path_hint,
            heading_text: value.heading_text,
            heading_anchor: value.heading_anchor,
            heading_occurrence: value.heading_occurrence,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatLinkedFileParams {
    object_id: String,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    path_hint: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatThreadCreateParams {
    thread_id: String,
    title: String,
    linked_file: ChatLinkedFileParams,
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
    #[serde(default)]
    needs_decision: bool,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_attachments"
    )]
    attachments: Option<Vec<ChatLocalAttachmentParams>>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDecisionResolveParams {
    thread_id: String,
    message_id: String,
    resolved_by_message_id: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatReactionAuthorParams {
    author_id: String,
    kind: String,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatReactionSetParams {
    thread_id: String,
    message_id: String,
    emoji: String,
    author: ChatReactionAuthorParams,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    replication_author_id: Option<String>,
    state: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatThreadPageParams {
    thread_id: String,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    cursor: Option<String>,
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
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum ChatProjectionFileAccessParams {
    Allowed { path: String },
    Denied {},
    Unknown {},
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatThreadProjectionParams {
    thread_id: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_projection_access"
    )]
    linked_file_access: Option<ChatProjectionFileAccessParams>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatThreadsListForFileParams {
    object_id: String,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatThreadsListForChannelParams {
    channel_id: String,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAttachmentsListForThreadParams {
    thread_id: String,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAttachmentsListFileMentionsParams {
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    object_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    path_hint: Option<String>,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatMentionsListForHandleParams {
    handle: String,
    #[serde(default)]
    unread_by_agent_only: bool,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatPageParams {
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnreadFileThreadPageParams {
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    after_thread_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAgentReadCoordinateParams {
    created_at_ms: i64,
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAgentReadMarkParams {
    thread_id: String,
    up_to: ChatAgentReadCoordinateParams,
    expected_revision: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatOwnerParams {
    owner_user_id: String,
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
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatFollowListParams {
    owner_user_id: String,
    state: Option<String>,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    cursor: Option<String>,
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
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    cursor: Option<String>,
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
struct ChatDispatchRecordEligibleParams {
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    verified_user_id: Option<String>,
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
struct ChatDispatchRunPageParams {
    run_id: String,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchMessageParams {
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchThreadRunsParams {
    thread_id: String,
    limit: Option<i64>,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchRunParams {
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchRecentCountParams {
    thread_id: String,
    since_ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchFailPendingParams {
    thread_id: String,
    reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchRecordRunMessageParams {
    message_id: String,
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchSetPausedParams {
    thread_id: String,
    paused: bool,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDispatchRequeueParams {
    trigger_message_id: String,
    run_id: String,
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
            binary_byte_length: None,
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
            metadata_summary: None,
            metadata_correlation_id: None,
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

fn required_idempotency_key(request_id: Option<String>) -> Result<String, WireError> {
    request_id
        .filter(|request_id| !request_id.is_empty())
        .ok_or_else(|| wire(ErrorCode::InvalidParams, "idempotency-key-required"))
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

fn thread_b2_json(thread: &ChatThread) -> Value {
    let mut value = json!({
        "id": thread.thread_id,
        "workspaceId": thread.workspace_id,
        "title": thread.title,
        "createdAtMs": thread.created_at_ms,
        "updatedAtMs": thread.updated_at_ms,
    });
    let object = value.as_object_mut().expect("thread is an object");
    if let Some(channel_id) = &thread.channel_id {
        object.insert("channelId".to_owned(), json!(channel_id));
    }
    if let Some(object_id) = &thread.linked_object_id {
        let mut linked_file = json!({
            "objectId": object_id,
            "linkedAtMs": thread.linked_at_ms.expect("validated linked thread"),
        });
        if let Some(path_hint) = &thread.linked_path_hint {
            linked_file
                .as_object_mut()
                .expect("linked file is an object")
                .insert("pathHint".to_owned(), json!(path_hint));
        }
        object.insert("linkedFile".to_owned(), linked_file);
    }
    value
}

fn channel_thread_summary_json(summary: &ChannelThreadSummary) -> Value {
    let mut value = json!({
        "thread": thread_b2_json(&summary.thread),
        "messageCount": summary.message_count,
        "lastReadSequence": summary.last_read_sequence,
        "unreadCount": summary.unread_count,
        "openDecisionCount": summary.open_decision_count,
    });
    if let Some(opening) = &summary.opening_message {
        value
            .as_object_mut()
            .expect("channel thread summary is an object")
            .insert(
                "openingMessage".to_owned(),
                json!({
                    "id": opening.message_id,
                    "author": {
                        "kind": match opening.author_kind {
                            ChatActorKind::Human => "human",
                            ChatActorKind::Agent => "agent",
                        },
                        "displayName": opening.author_display_name,
                    },
                    "createdAtMs": opening.created_at_ms,
                    "bodySnippet": opening.body_snippet,
                    "reactions": opening.reactions.iter().map(reaction_json).collect::<Vec<_>>(),
                }),
            );
    }
    value
}

fn message_json(message: &ChatMessage) -> Value {
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
        "attachments": message.attachments.iter().map(attachment_json).collect::<Vec<_>>(),
    });
    let object = value.as_object_mut().expect("message is an object");
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

fn reaction_json(reaction: &ChatReaction) -> Value {
    json!({
        "reactionId": reaction.reaction_id,
        "threadId": reaction.thread_id,
        "messageId": reaction.message_id,
        "emoji": reaction.emoji,
        "author": {
            "authorId": reaction.author_id,
            "kind": match reaction.author_kind {
                ChatActorKind::Human => "human",
                ChatActorKind::Agent => "agent",
            },
            "displayName": reaction.author_display_name,
        },
        "state": match reaction.state {
            ChatReactionState::Added => "added",
            ChatReactionState::Removed => "removed",
        },
        "atMs": reaction.at_ms,
    })
}

fn decision_json(decision: &ChatDecision) -> Value {
    let mut value = json!({
        "threadId": decision.thread_id,
        "messageId": decision.message_id,
        "state": match decision.state {
            ChatDecisionState::Open => "open",
            ChatDecisionState::Resolved => "resolved",
        },
        "atMs": decision.at_ms,
    });
    if let Some(resolved_by_message_id) = &decision.resolved_by_message_id {
        value
            .as_object_mut()
            .expect("decision is an object")
            .insert(
                "resolvedByMessageId".to_owned(),
                json!(resolved_by_message_id),
            );
    }
    value
}

fn attachment_json(attachment: &ChatAttachment) -> Value {
    let mut value = json!({
        "attachmentId": attachment.attachment_id,
        "threadId": attachment.thread_id,
        "messageId": attachment.message_id,
        "targetKind": "file",
        "createdAtMs": attachment.created_at_ms,
    });
    let object = value.as_object_mut().expect("attachment is an object");
    if let Some(object_id) = &attachment.object_id {
        object.insert("objectId".to_owned(), json!(object_id));
    }
    if let Some(path_hint) = &attachment.path_hint {
        object.insert("pathHint".to_owned(), json!(path_hint));
    }
    if let Some(heading_text) = &attachment.heading_text {
        object.insert("headingText".to_owned(), json!(heading_text));
    }
    if let Some(heading_anchor) = &attachment.heading_anchor {
        object.insert("headingAnchor".to_owned(), json!(heading_anchor));
    }
    if let Some(heading_occurrence) = attachment.heading_occurrence {
        object.insert("headingOccurrence".to_owned(), json!(heading_occurrence));
    }
    value
}

fn file_mention_json(mention: &ChatFileMention) -> Value {
    let mut value = json!({
        "attachment": attachment_json(&mention.attachment),
        "message": message_json(&mention.message),
        "thread": thread_b2_json(&mention.thread),
    });
    if let Some(channel) = &mention.channel {
        value
            .as_object_mut()
            .expect("file mention is an object")
            .insert("channel".to_owned(), channel_json(channel));
    }
    value
}

fn mention_json(mention: &ChatMention) -> Value {
    json!({
        "threadId": mention.thread_id,
        "messageId": mention.message_id,
        "handle": mention.handle,
        "authorKind": match mention.author_kind {
            ChatActorKind::Human => "human",
            ChatActorKind::Agent => "agent",
        },
        "createdAtMs": mention.created_at_ms,
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

fn agent_read_state_json(state: &ChatAgentReadState) -> Value {
    json!({
        "workspaceId": state.workspace_id,
        "threadId": state.thread_id,
        "lastReadCreatedAtMs": state.last_read_created_at_ms,
        "lastReadMessageId": state.last_read_message_id,
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

fn follow_target_kind_str(kind: FollowTargetKind) -> &'static str {
    match kind {
        FollowTargetKind::Person => "person",
        FollowTargetKind::Agent => "agent",
        FollowTargetKind::Channel => "channel",
        FollowTargetKind::Thread => "thread",
    }
}

fn follow_json(workspace_id: &str, follow: &ChatFollow) -> Value {
    json!({
        "workspaceId": workspace_id,
        "ownerUserId": follow.owner_user_id,
        "targetKind": follow_target_kind_str(follow.target_kind),
        "targetId": follow.target_id,
        "state": match follow.state {
            FollowState::Following => "following",
            FollowState::Unfollowed => "unfollowed",
        },
        "updatedAtMs": follow.updated_at_ms,
    })
}

fn bookmark_json(workspace_id: &str, bookmark: &ChatBookmark) -> Value {
    let mut value = json!({
        "bookmarkId": bookmark.bookmark_id,
        "workspaceId": workspace_id,
        "ownerUserId": bookmark.owner_user_id,
        "targetKind": bookmark.target_kind,
        "targetId": bookmark.target_id,
        "threadId": bookmark.thread_id,
        "mode": bookmark.mode,
        "destinationPath": bookmark.destination_path,
        "state": bookmark.state,
        "generation": bookmark.generation,
        "projectedGeneration": bookmark.projected_generation,
        "projectionState": bookmark.projection_state,
        "createdAtMs": bookmark.created_at_ms,
        "updatedAtMs": bookmark.updated_at_ms,
    });
    let object = value.as_object_mut().expect("bookmark is an object");
    if let Some(message_id) = &bookmark.message_id {
        object.insert("messageId".to_owned(), json!(message_id));
    }
    if let Some(projection_object_id) = &bookmark.projection_object_id {
        object.insert("projectionObjectId".to_owned(), json!(projection_object_id));
    }
    if let Some(last_projected_at_ms) = bookmark.last_projected_at_ms {
        object.insert("lastProjectedAtMs".to_owned(), json!(last_projected_at_ms));
    }
    if let Some(failure_reason) = &bookmark.failure_reason {
        object.insert("failureReason".to_owned(), json!(failure_reason));
    }
    value
}

fn dispatch_claim_json(claim: &DispatchClaim) -> Value {
    json!({ "dispatch": dispatch_json(&claim.dispatch), "run": run_json(&claim.run) })
}

fn dispatch_json(dispatch: &DispatchRecord) -> Value {
    let mut value = json!({
        "workspaceId": dispatch.workspace_id,
        "triggerMessageId": dispatch.trigger_message_id,
        "threadId": dispatch.thread_id,
        "state": dispatch.state,
        "attemptCount": dispatch.attempt_count,
        "createdAtMs": dispatch.created_at_ms,
        "updatedAtMs": dispatch.updated_at_ms,
    });
    let object = value.as_object_mut().expect("dispatch is an object");
    if let Some(run_id) = &dispatch.run_id {
        object.insert("runId".to_owned(), json!(run_id));
    }
    if let Some(failure_reason) = &dispatch.failure_reason {
        object.insert("failureReason".to_owned(), json!(failure_reason));
    }
    value
}

fn run_json(run: &AgentRunRecord) -> Value {
    let mut value = json!({
        "workspaceId": run.workspace_id,
        "runId": run.run_id,
        "threadId": run.thread_id,
        "triggerMessageId": run.trigger_message_id,
        "command": run.command,
        "startedAtMs": run.started_at_ms,
        "failureNotePosted": run.failure_note_posted,
    });
    let object = value.as_object_mut().expect("run is an object");
    if let Some(ended_at_ms) = run.ended_at_ms {
        object.insert("endedAtMs".to_owned(), json!(ended_at_ms));
    }
    if let Some(exit_code) = run.exit_code {
        object.insert("exitCode".to_owned(), json!(exit_code));
    }
    if let Some(failure_reason) = &run.failure_reason {
        object.insert("failureReason".to_owned(), json!(failure_reason));
    }
    if let Some(log_path) = &run.log_path {
        object.insert("logPath".to_owned(), json!(log_path));
    }
    value
}

fn pause_json(pause: &ThreadDispatchPause) -> Value {
    let mut value = json!({
        "workspaceId": pause.workspace_id,
        "threadId": pause.thread_id,
        "paused": pause.paused,
        "updatedAtMs": pause.updated_at_ms,
    });
    if let Some(reason) = &pause.reason {
        value
            .as_object_mut()
            .expect("pause is an object")
            .insert("reason".to_owned(), json!(reason));
    }
    value
}

fn moment_json(moment: &dohc_engine_domain::MomentRecord) -> Value {
    let after_inband_limit = (moment.after_content_kind == "text"
        && moment.after_text.is_none()
        && moment
            .after_byte_length
            .is_some_and(|length| length as usize > MAX_DESKTOP_CAPTURE_TEXT_BYTES))
    .then_some(MAX_DESKTOP_CAPTURE_TEXT_BYTES);
    let before_inband_limit = (moment.before_content_kind == "text"
        && moment.before_text.is_none()
        && moment
            .before_byte_length
            .is_some_and(|length| length as usize > MAX_DESKTOP_CAPTURE_TEXT_BYTES))
    .then_some(MAX_DESKTOP_CAPTURE_TEXT_BYTES);
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
        "metadataSummary": moment.metadata_summary,
        "metadataCorrelationId": moment.metadata_correlation_id,
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
        "beforePath": moment.before_path,
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
        Some(text) if text.len() <= MAX_DESKTOP_CAPTURE_TEXT_BYTES => json!(text),
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
        "metadataOrigin": snapshot.metadata_origin,
        "metadataSummary": snapshot.metadata_summary,
        "metadataCorrelationId": snapshot.metadata_correlation_id
    })
}

/// Withhold one text body past the in-band cap, in place: the digest and the
/// limit go out, the body does not. This is the shape `versionedText.read`
/// already uses, so the caller hydrates with `versionedText.readBlob`.
fn withhold_over_cap_text(body: &mut Value) {
    let over_cap = body
        .get("text")
        .and_then(Value::as_str)
        .is_some_and(|text| text.len() > MAX_DESKTOP_CAPTURE_TEXT_BYTES);
    if over_cap {
        body["text"] = Value::Null;
        body["inbandLimitBytes"] = json!(MAX_DESKTOP_CAPTURE_TEXT_BYTES);
    }
}

/// The body a resolution settled, withheld past the in-band cap.
fn settled_snapshot_json(snapshot: &TextSnapshot) -> Value {
    let mut body = snapshot_json(snapshot);
    withhold_over_cap_text(&mut body);
    body
}

/// The conflict a resolution closed, with every side's body withheld past the
/// in-band cap.
///
/// ONE rule bounds this whole answer, because no part of it may grow with a
/// body. The answer carries five text bodies — three sides, the settled
/// snapshot, and the moment's before and after — and one control frame has to
/// hold all of them. Withholding each past 128 KiB caps the answer at five
/// residuals plus metadata, about 640 KiB inside an 8 MiB frame. Withhold
/// only some of them and a conflict whose row approaches
/// `CONFLICT_ROW_HARD_CAP_BYTES` still overruns the frame — and the daemon's
/// writer treats an oversized answer as a fatal transport error AFTER the
/// resolution has committed.
///
/// The conflict LISTING is untouched: it bounds its own answer by cutting
/// rows, and its readers paint the bodies it returns.
fn settled_conflict_json(conflict: &TextConflict) -> Value {
    let mut value = conflict_json(conflict);
    for side in ["base", "current", "incoming"] {
        if let Some(snapshot) = value[side].get_mut("snapshot")
            && !snapshot.is_null()
        {
            withhold_over_cap_text(snapshot);
        }
    }
    value
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
        "metadataSummary": snapshot.metadata_summary,
        "metadataCorrelationId": snapshot.metadata_correlation_id,
    })
}

/// One comparison side as a versioned read value. A binary side reports the
/// same shape `versionedText.read` gives a binary head: empty text, the binary
/// content address in both hash fields, and the blob's byte length.
fn comparison_side_json(side: &dohc_engine_domain::ComparisonSide) -> Value {
    if !side.binary {
        return snapshot_json(&side.snapshot);
    }
    json!({
        "workspaceId": side.snapshot.workspace_id,
        "versionId": side.snapshot.version_id,
        "objectId": side.snapshot.object_id,
        "path": side.snapshot.path,
        "text": "",
        "contentKind": "binary",
        "sha256": side.snapshot.blob_sha256,
        "byteLength": side.byte_length,
        "blobSha256": side.snapshot.blob_sha256,
        "updatedAtMs": side.snapshot.updated_at_ms,
        "latestMomentId": side.snapshot.latest_moment_id,
        "metadataOrigin": side.snapshot.metadata_origin,
        "metadataSummary": side.snapshot.metadata_summary,
        "metadataCorrelationId": side.snapshot.metadata_correlation_id
    })
}

fn comparison_json(comparison: &dohc_engine_domain::VersionedTextComparison) -> Value {
    json!({
        "workspaceId": comparison.workspace_id,
        "path": comparison.path,
        "targetVersionId": comparison.target_version_id,
        "sourceVersionId": comparison.source_version_id,
        "base": comparison.base.as_ref().map(comparison_side_json),
        "current": comparison.current.as_ref().map(comparison_side_json),
        "incoming": comparison.incoming.as_ref().map(comparison_side_json),
        "status": match comparison.status {
            ComparisonStatus::Same => "same",
            ComparisonStatus::IncomingChanged => "incoming-changed",
            ComparisonStatus::CurrentChanged => "current-changed",
            ComparisonStatus::Diverged => "diverged",
        },
    })
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
        "binarySha256": state.binary_sha256,
        "binaryByteLength": state.binary_byte_length,
        "binaryObjectId": state.binary_object_id,
        "binaryLatestMomentId": state.binary_latest_moment_id,
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
        ApplyOutcome::Refused(refusal) => json!({
            "replicated": true,
            "status": "refused",
            "workspaceId": refusal.workspace_id,
            "originId": refusal.origin_id,
            "originSeq": refusal.origin_seq,
            "opKind": refusal.op_kind,
            "code": refusal.reason.code(),
            "reason": refusal.reason.message()
        }),
        ApplyOutcome::Skipped => json!({ "replicated": true, "status": "skipped" }),
        ApplyOutcome::Crashed { committed } => json!({
            "replicated": true,
            "status": "crashed",
            "committed": committed
        }),
        ApplyOutcome::WithRefusals { outcome, refusals } => {
            let mut value = replicated_conflict_json(*outcome);
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "refusals".to_owned(),
                    Value::Array(
                        refusals
                            .into_iter()
                            .map(|refusal| {
                                json!({
                                    "workspaceId": refusal.workspace_id,
                                    "originId": refusal.origin_id,
                                    "originSeq": refusal.origin_seq,
                                    "opKind": refusal.op_kind,
                                    "code": refusal.reason.code(),
                                    "reason": refusal.reason.message()
                                })
                            })
                            .collect(),
                    ),
                );
            }
            value
        }
    }
}

fn deserialize_optional_non_null_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

fn deserialize_optional_non_null_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    i64::deserialize(deserializer).map(Some)
}

fn deserialize_optional_non_null_attachments<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<ChatLocalAttachmentParams>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Vec::<ChatLocalAttachmentParams>::deserialize(deserializer).map(Some)
}

fn deserialize_optional_non_null_projection_access<'de, D>(
    deserializer: D,
) -> Result<Option<ChatProjectionFileAccessParams>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    ChatProjectionFileAccessParams::deserialize(deserializer).map(Some)
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

fn relay_cursor_json(cursor: &RelayCursor) -> Value {
    json!({
        "kind": "relay",
        "cursor": cursor.cursor,
        "replicationEpoch": cursor.replication_epoch,
        "streamIdentity": cursor.stream_identity,
    })
}

fn sync_outcome_json(outcome: SyncPassOutcome) -> Value {
    match outcome {
        SyncPassOutcome::Complete {
            pushed,
            fetched,
            has_more,
            applied,
            refused,
            skipped,
            conflicts_opened,
            pending_cursor,
            changed_paths,
            pending_resolves,
            refusals,
        } => json!({
            "status": "complete",
            "pushed": pushed,
            "fetched": fetched,
            "hasMore": has_more,
            "applied": applied,
            "refused": refused,
            "skipped": skipped,
            "conflictsOpened": conflicts_opened,
            "nextCursor": pending_cursor.as_ref().map(|cursor| cursor.cursor),
            "pendingCursor": pending_cursor.as_ref().map(relay_cursor_json),
            "changedPaths": changed_paths.iter().map(|change| json!({
                "path": change.path,
                "operation": change.operation,
                "contentKind": change.content_kind,
            })).collect::<Vec<_>>(),
            "pendingResolves": pending_resolves,
            "refusals": refusals.into_iter().map(|refusal| json!({
                "workspaceId": refusal.workspace_id,
                "originId": refusal.origin_id,
                "originSeq": refusal.origin_seq,
                "opKind": refusal.op_kind,
                "code": refusal.reason.code(),
                "reason": refusal.reason.message(),
            })).collect::<Vec<_>>(),
        }),
        SyncPassOutcome::CrashedAfterRemoteCommit => {
            json!({ "status": "crashedAfterRemoteCommit" })
        }
        SyncPassOutcome::CrashedAfterApply {
            applied,
            refused,
            skipped,
            conflicts_opened,
            pending_cursor,
            changed_paths,
            pending_resolves,
            refusals,
        } => json!({
            "status": "crashedAfterApply",
            "applied": applied,
            "refused": refused,
            "skipped": skipped,
            "conflictsOpened": conflicts_opened,
            "nextCursor": pending_cursor.cursor,
            "pendingCursor": relay_cursor_json(&pending_cursor),
            "changedPaths": changed_paths.iter().map(|change| json!({
                "path": change.path,
                "operation": change.operation,
                "contentKind": change.content_kind,
            })).collect::<Vec<_>>(),
            "pendingResolves": pending_resolves,
            "refusals": refusals.into_iter().map(|refusal| json!({
                "workspaceId": refusal.workspace_id,
                "originId": refusal.origin_id,
                "originSeq": refusal.origin_seq,
                "opKind": refusal.op_kind,
                "code": refusal.reason.code(),
                "reason": refusal.reason.message(),
            })).collect::<Vec<_>>(),
        }),
    }
}

fn relay_outcome_json(outcome: RelayOperationOutcome) -> Result<Value, WireError> {
    Ok(match outcome {
        RelayOperationOutcome::Sync(outcome) => sync_outcome_json(outcome),
        RelayOperationOutcome::CursorCommitted => json!({ "committed": true }),
        RelayOperationOutcome::Probe(has_content) => json!({ "hasContent": has_content }),
        RelayOperationOutcome::Claimed => json!({ "claimed": true }),
        RelayOperationOutcome::JoinIdentityAdopted => json!({ "adopted": true }),
        RelayOperationOutcome::Recovered(outcome) => json!({
            "oldOriginId": outcome.old_origin_id,
            "newOriginId": outcome.new_origin_id,
            "sharedPrefixLength": outcome.shared_prefix_length,
            "preservedOps": outcome.preserved_ops,
        }),
        RelayOperationOutcome::KeyEnvelopeUploaded { etag } => json!({ "etag": etag }),
        RelayOperationOutcome::KeyEnvelopeDownloaded {
            envelope_json,
            etag,
        } => json!({
            "envelopeJson": envelope_json,
            "etag": etag,
        }),
        RelayOperationOutcome::SharedChannelPulled(outcome) => json!({
            "fetched": outcome.fetched,
            "hasMore": outcome.has_more,
            "applied": outcome.applied,
            "refused": outcome.refused,
            "rejections": outcome.rejections.iter().map(|rejection| json!({
                "originId": rejection.origin_id,
                "originSeq": rejection.origin_seq,
                "opKind": rejection.op_kind,
                "reason": rejection.reason,
            })).collect::<Vec<_>>(),
            "skipped": outcome.skipped,
            "nextCursor": outcome.next_cursor,
        }),
        RelayOperationOutcome::SharedChannelPushed(outcome) => {
            json!({ "pushed": outcome.pushed })
        }
        RelayOperationOutcome::ShareViewPulled(outcome) => json!({
            "fetched": outcome.fetched,
            "hasMore": outcome.has_more,
            "applied": outcome.applied,
            "skipped": outcome.skipped,
            // Why each skipped op was skipped. A skip is silent otherwise, and
            // a share that quietly stops carrying a granter's edits is exactly
            // the state a recipient cannot diagnose without this.
            "refusals": outcome.refusals.iter().map(|refusal| json!({
                "originId": refusal.origin_id,
                "originSeq": refusal.origin_seq,
                "opKind": refusal.op_kind,
                "code": refusal.code,
                "detail": refusal.detail,
            })).collect::<Vec<_>>(),
            "nextCursor": outcome.pending_cursor.cursor,
            "changedPaths": outcome.changed_paths.into_iter().map(|change| json!({
                "path": change.path,
                "operation": change.operation,
                "contentKind": change.content_kind,
            })).collect::<Vec<_>>(),
            "pendingCursor": {
                "kind": "shareView",
                "shareId": outcome.pending_cursor.share_id,
                "cursor": outcome.pending_cursor.cursor,
            },
        }),
    })
}

fn validate_workspace_param(candidate: Option<&str>, resolved: &str) -> Result<(), WireError> {
    if candidate.is_some_and(|candidate| candidate != resolved) {
        return Err(wire(ErrorCode::InvalidParams, "invalid-workspace"));
    }
    Ok(())
}

fn validate_metadata_fields(
    summary: Option<&str>,
    correlation_id: Option<&str>,
) -> Result<(), WireError> {
    if [summary, correlation_id]
        .into_iter()
        .flatten()
        .any(|field| field.len() > MAX_METADATA_FIELD_BYTES)
    {
        return Err(wire(ErrorCode::InvalidParams, "invalid-metadata"));
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
    if matches!(&error, RuntimeError::Relay(RelayError::OriginDiverged)) {
        return wire(ErrorCode::InvalidParams, "relay-origin-diverged");
    }
    if matches!(&error, RuntimeError::Relay(RelayError::ShareReadOnly)) {
        return wire(ErrorCode::InvalidParams, "share-read-only");
    }
    // The only rejection whose message carries numbers. `wire` takes a static
    // string, so the generic tail below would replace them with a placeholder.
    if let RuntimeError::Relay(relay @ RelayError::BlobTooLarge { .. }) = &error {
        return WireError::new(ErrorCode::PayloadTooLarge, relay.to_string());
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
            DomainError::ConflictNotFound => Some("conflict-not-found"),
            DomainError::ConflictStaleTarget => Some("conflict-stale-target"),
            DomainError::BinaryHeadNotText => Some("binary-head-not-text"),
            DomainError::InvalidPath { .. } => Some("invalid-path"),
            DomainError::InvalidText { .. } => Some("invalid-text"),
            DomainError::NotSecretPath => Some("not-secret-path"),
            DomainError::SecretMomentNotFound => Some("moment-not-found"),
            DomainError::Crypto(error) => Some(error.code()),
            DomainError::InvalidInput { .. } => Some("invalid-input"),
            DomainError::StateCorrupt { .. } => Some("state-corrupt"),
            DomainError::Storage(_) => Some("persist-failed"),
            DomainError::Chat { code, .. } => Some(*code),
            _ => None,
        };
        if let Some(message) = message {
            let code = match domain {
                DomainError::Storage(_)
                | DomainError::StateCorrupt { .. }
                | DomainError::Chat {
                    code: "state-corrupt",
                    ..
                } => ErrorCode::Internal,
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
        RuntimeError::Relay(error) => map_relay_code(error),
        RuntimeError::Search(error) => map_search_code(error),
        _ => ErrorCode::Internal,
    };
    wire(code, "workspace operation failed")
}

fn map_relay_code(error: RelayError) -> ErrorCode {
    match error {
        RelayError::Unauthorized => ErrorCode::AuthFailed,
        RelayError::Forbidden => ErrorCode::Forbidden,
        RelayError::Conflict => ErrorCode::Conflict,
        RelayError::OriginDiverged => ErrorCode::OriginDiverged,
        RelayError::ShareUnavailable => ErrorCode::ShareUnavailable,
        RelayError::KeyEnvelopeMissing => ErrorCode::KeyEnvelopeMissing,
        RelayError::EpochSuperseded => ErrorCode::EpochSuperseded,
        RelayError::IdentityNotRecognized => ErrorCode::IdentityNotRecognized,
        RelayError::ShareReadOnly => ErrorCode::ShareReadOnly,
        RelayError::ShareOperationRejected => ErrorCode::ShareOperationRejected,
        RelayError::PayloadTooLarge | RelayError::BlobTooLarge { .. } => ErrorCode::PayloadTooLarge,
        RelayError::QuotaExceeded => ErrorCode::QuotaExceeded,
        RelayError::NoProgress => ErrorCode::RelayNoProgress,
        RelayError::BlobMissing => ErrorCode::BlobMissing,
        RelayError::BlobReferenceMissing => ErrorCode::BlobReferenceMissing,
        RelayError::BlobInvalid => ErrorCode::BlobInvalid,
        RelayError::IdentityRequired => ErrorCode::IdentityRequired,
        RelayError::StreamIdentityMismatch => ErrorCode::StreamIdentityMismatch,
        RelayError::AuthorshipMismatch => ErrorCode::AuthorshipMismatch,
        RelayError::UnknownChatOperation => ErrorCode::UnknownChatOperation,
        RelayError::PresenceCapacity => ErrorCode::PresenceCapacity,
        RelayError::SelfShare => ErrorCode::SelfShare,
        RelayError::AmbiguousSelector => ErrorCode::AmbiguousSelector,
        RelayError::InvalidChannel => ErrorCode::InvalidChannel,
        RelayError::MethodNotAllowed => ErrorCode::RelayMethodNotAllowed,
        RelayError::InvalidResponse => ErrorCode::RelayInvalidResponse,
        RelayError::WorkspaceUnavailable | RelayError::Partitioned => {
            ErrorCode::WorkspaceUnavailable
        }
        RelayError::ServerInternal
        | RelayError::UnknownServerCode(_)
        | RelayError::HttpStatus(_)
        | RelayError::Local(_) => ErrorCode::Internal,
        RelayError::BadRequest => ErrorCode::InvalidParams,
    }
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
        DomainError::PayloadTooLarge { .. } => ErrorCode::PayloadTooLarge,
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
        | CollabError::ProjectionTooLarge { .. }
        | CollabError::ProjectionTooComplex { .. }
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
        // Retryable state conditions are transient by definition; Internal is
        // the retry-eligible class on this surface (InvalidParams is terminal).
        | SyncError::RetryableState { .. }
        | SyncError::FaultCrash => ErrorCode::Internal,
        SyncError::InvalidInput { .. }
        | SyncError::UnsupportedOperation
        | SyncError::ShareBoundaryViolation
        | SyncError::ShareVersionMismatch { .. }
        | SyncError::ShareVersionUnusable { .. }
        | SyncError::BlobInvalid => ErrorCode::InvalidParams,
        // Same condition as its relay twin, so the same code. A blob over a
        // fixed ceiling is a size refusal on either path.
        SyncError::BlobTooLarge { .. } => ErrorCode::PayloadTooLarge,
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

fn recovered_origin_id() -> Result<String, WireError> {
    sync_identifier("origin")
}

fn sync_identifier(prefix: &'static str) -> Result<String, WireError> {
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy)
        .map_err(|_| wire(ErrorCode::Internal, "sync-identity-generation-failed"))?;
    Ok(sync_identifier_from_entropy(prefix, entropy))
}

fn sync_identifier_from_entropy(prefix: &str, mut entropy: [u8; 16]) -> String {
    entropy[6] = (entropy[6] & 0x0f) | 0x40;
    entropy[8] = (entropy[8] & 0x3f) | 0x80;
    let hex = entropy
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "{prefix}_{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Liveness probe. It takes no workspace, reads no store, and touches no
/// filesystem, so it can neither block nor fail. An answer therefore proves
/// the transport reader, the request supervisor, and the writer are all still
/// turning — which is the whole claim a client-side wedge detector needs.
/// It says nothing about any single workspace actor, which runs on its own
/// thread and can stall alone.
fn engine_ping() -> Value {
    json!({ "ok": true })
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
    use dohc_engine_sync::ObservedBytes;
    use dohc_engine_testkit::{GateFaults, ScratchDir};
    use std::time::Duration;

    const SHADOW_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn encoded_length_agrees_with_the_encoder_that_builds_the_frame() {
        // The merged-resolution budget is spent in ENCODED bytes, so this
        // count must be the encoder's count, not an approximation of it. Every
        // escape class serde_json has: the two-byte shorthands, the six-byte
        // \u form for the other control bytes, DEL (which it does NOT escape),
        // and multi-byte UTF-8 (which it passes through).
        //
        // MUTATION: change any width in the fold -> this fails on the class
        // that moved.
        let samples = [
            "plain ascii".to_owned(),
            "\"\\\n\r\t\u{08}\u{0c}".to_owned(),
            (0u8..0x20).map(char::from).collect::<String>(),
            "\u{7f}\u{80}\u{7ff}\u{800}\u{ffff}\u{10000}".to_owned(),
            "é✓🙂 mixed \n with \u{0}".to_owned(),
            String::new(),
        ];
        for sample in samples {
            let encoded = serde_json::to_string(sample.as_str()).expect("encode a string");
            assert_eq!(
                json_string_encoded_len(&sample),
                encoded.len(),
                "encoded length disagrees for {sample:?}"
            );
        }
    }

    #[tokio::test]
    async fn engine_events_shed_instead_of_growing_when_the_subscriber_stalls() {
        // codex P2: an unbounded notice queue under a stalled transport
        // grows the daemon without bound. The channel is bounded and emit
        // NEVER blocks: overflow is shed (the queued backlog already
        // guarantees a repaint on drain).
        let events = EngineEvents::default();
        let mut rx = events.subscribe();
        for i in 0..(ENGINE_EVENT_QUEUE_CAPACITY + 10) {
            events.emit(CAPTURE_MOMENT_RECORDED_EVENT, json!({ "i": i }));
        }
        let mut drained = 0usize;
        while rx.try_recv().is_ok() {
            drained += 1;
        }
        assert_eq!(
            drained, ENGINE_EVENT_QUEUE_CAPACITY,
            "emit must shed past the bound, not queue unboundedly"
        );
    }

    #[tokio::test]
    async fn engine_ping_answers_without_a_workspace_handle() {
        // MUTATION: drop the "engine.ping" dispatch arm and the call falls
        // through to MethodNotFound; require a workspace and it errors on a
        // probe that must work before any workspace is open.
        let service = EngineService::new();
        let answer = service
            .call(
                RequestContext::unbounded(),
                Request {
                    id: 1,
                    method: "engine.ping".to_owned(),
                    workspace: None,
                    deadline_ms: None,
                    idempotency_key: None,
                    params: Value::Null,
                },
            )
            .await
            .expect("engine.ping must answer");
        assert_eq!(answer.response.id, 1);
        assert_eq!(answer.response.result, json!({ "ok": true }));
    }

    #[test]
    fn recovered_origins_use_random_uuid_identity_coordinates() {
        let first = sync_identifier_from_entropy("origin", [0; 16]);
        let second = sync_identifier_from_entropy("origin", [1; 16]);
        assert_eq!(first, "origin_00000000-0000-4000-8000-000000000000");
        assert_eq!(second, "origin_01010101-0101-4101-8101-010101010101");
        assert_ne!(
            first, second,
            "cross-device entropy must participate in the recovered coordinate"
        );
    }

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

    /// An ingest ceiling is useless if the caller cannot read which limit it
    /// hit. `wire` only takes static strings, so the generic tail replaces
    /// every message with "workspace operation failed".
    ///
    /// MUTATION: drop the explicit `BlobTooLarge` arm in `map_runtime` and the
    /// numbers vanish from the surfaced error.
    #[test]
    fn an_oversized_blob_refusal_reaches_the_caller_naming_its_limit() {
        let surfaced = map_runtime(RuntimeError::Relay(RelayError::BlobTooLarge {
            constraint: "MAX_TEXT_BYTES",
            limit_bytes: 10 * 1024 * 1024,
            observed: ObservedBytes::Exact(10 * 1024 * 1024 + 1),
        }));
        assert_eq!(surfaced.code, ErrorCode::PayloadTooLarge);
        assert_eq!(
            surfaced.message,
            "relay blob exceeds MAX_TEXT_BYTES: limit 10485760 bytes, observed 10485761 bytes"
        );
        assert_eq!(
            surfaced.retry,
            dohc_engine_protocol::Retryability::No,
            "a blob that exceeds a fixed ceiling never succeeds on retry"
        );
        // One condition must not surface under two codes depending on which
        // layer refused it. Latent today, because relay pulls convert the
        // ingest refusal before it reaches here; pinned so a second caller
        // cannot reintroduce the split.
        assert_eq!(
            map_sync_code(SyncError::BlobTooLarge {
                constraint: "MAX_CAPTURE_BINARY_FILE_BYTES",
                limit_bytes: 5 * 1024 * 1024,
                observed_bytes: 5 * 1024 * 1024 + 1,
            }),
            map_relay_code(RelayError::BlobTooLarge {
                constraint: "MAX_CAPTURE_BINARY_FILE_BYTES",
                limit_bytes: 5 * 1024 * 1024,
                observed: ObservedBytes::Exact(5 * 1024 * 1024 + 1),
            })
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workspace_rebind_preserves_a_runner_owned_by_the_desktop() {
        // MUTATION: ignore recoverRunningDispatches=false on the second open ->
        // the claim is reclaimed and requeued before the surviving runner can
        // complete it.
        let scratch = ScratchDir::new().expect("scratch");
        shadow_fence::write_shadow_marker_for_harness(scratch.path(), SHADOW_TOKEN)
            .expect("shadow marker");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let first_service = EngineService::with_supervisor(supervisor);
        let workspace_id = "desktop-runner-survives-daemon";
        let opened = first_service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            )
            .await
            .expect("initial workspace open");
        let first_handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        first_service
            .chats_dispatch_enqueue(
                &RequestContext::unbounded(),
                Some(first_handle.clone()),
                json!({
                    "triggerMessageId": "trigger-survives",
                    "threadId": "thread-survives",
                    "nowMs": 10,
                }),
            )
            .await
            .expect("enqueue dispatch");
        let claim = first_service
            .chats_dispatch_claim_next_pending(
                &RequestContext::unbounded(),
                Some(first_handle.clone()),
                json!({
                    "runId": "run-survives",
                    "command": "agent",
                    "nowMs": 20,
                }),
            )
            .await
            .expect("claim dispatch");
        assert_eq!(claim["run"]["runId"], json!("run-survives"));

        first_service
            .workspace_close(Some(first_handle))
            .await
            .expect("simulate old daemon teardown");

        let rebound_service = EngineService::with_supervisor(supervisor);
        let rebound = rebound_service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                    "recoverRunningDispatches": false,
                }),
            )
            .await
            .expect("desktop rebind");
        let rebound_handle: WorkspaceHandle =
            serde_json::from_value(rebound["workspace"].clone()).expect("rebound handle");
        let open_runs = rebound_service
            .chats_dispatch_open_runs(
                &RequestContext::unbounded(),
                Some(rebound_handle.clone()),
                json!({}),
            )
            .await
            .expect("list open runs");
        assert_eq!(
            open_runs["claims"][0]["run"]["runId"],
            json!("run-survives")
        );

        rebound_service
            .chats_dispatch_complete(
                &RequestContext::unbounded(),
                Some(rebound_handle.clone()),
                json!({ "runId": "run-survives", "exitCode": 0, "nowMs": 30 }),
            )
            .await
            .expect("surviving runner completes");
        let pending = rebound_service
            .chats_dispatch_list_pending(
                &RequestContext::unbounded(),
                Some(rebound_handle.clone()),
                json!({}),
            )
            .await
            .expect("list pending dispatches");
        assert_eq!(pending["dispatches"], json!([]));

        rebound_service
            .workspace_close(Some(rebound_handle))
            .await
            .expect("workspace close");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn maintenance_free_open_does_not_apply_pending_migrations() {
        let scratch = ScratchDir::new().expect("scratch");
        shadow_fence::write_shadow_marker_for_harness(scratch.path(), SHADOW_TOKEN)
            .expect("shadow marker");
        let db_path = scratch.path().join(".dohc/engine/engine.db");
        std::fs::create_dir_all(db_path.parent().expect("engine parent"))
            .expect("engine directory");
        let mut store = dohc_engine_storage::EngineStore::open(&db_path, 1).expect("fixture store");
        assert!(
            store
                .bind_shadow_clone_token(SHADOW_TOKEN)
                .expect("bind shadow token")
        );
        drop(store);

        let conn = rusqlite::Connection::open(&db_path).expect("fixture connection");
        let removed_migration: String = conn
            .query_row(
                "SELECT id FROM engine_migrations ORDER BY ordinal DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("latest migration");
        conn.execute(
            "DELETE FROM engine_migrations WHERE id = ?1",
            [&removed_migration],
        )
        .expect("remove latest migration ledger row");
        for column in [
            "before_object_id",
            "before_version_id",
            "before_path",
            "before_updated_at_ms",
            "before_metadata_origin",
            "before_metadata_summary",
            "before_metadata_correlation_id",
        ] {
            conn.execute(&format!("ALTER TABLE moments DROP COLUMN {column}"), [])
                .expect("restore the pre-migration moments shape");
        }
        drop(conn);

        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "read-only-pending-migration",
                    "recoverRunningDispatches": false,
                    "skipStartupMaintenance": true,
                }),
            )
            .await
            .expect("maintenance-free open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");

        let conn = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("read migration ledger");
        let present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM engine_migrations WHERE id = ?1",
                [&removed_migration],
                |row| row.get(0),
            )
            .expect("migration count");
        // MUTATION: routing this mode through supervisor.open applies the
        // missing ledger entry before workspace.open returns.
        assert_eq!(
            present, 0,
            "a maintenance-free read must not apply a pending migration"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn maintenance_free_handle_is_not_reused_for_full_open() {
        let scratch = ScratchDir::new().expect("scratch");
        shadow_fence::write_shadow_marker_for_harness(scratch.path(), SHADOW_TOKEN)
            .expect("shadow marker");
        let db_path = scratch.path().join(".dohc/engine/engine.db");
        std::fs::create_dir_all(db_path.parent().expect("engine parent"))
            .expect("engine directory");
        let mut store = dohc_engine_storage::EngineStore::open(&db_path, 1).expect("fixture store");
        assert!(
            store
                .bind_shadow_clone_token(SHADOW_TOKEN)
                .expect("bind shadow token")
        );
        drop(store);

        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "open-mode-compatibility",
        });
        let read_only = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "open-mode-compatibility",
                    "skipStartupMaintenance": true,
                }),
            )
            .await
            .expect("maintenance-free open");
        let read_only_handle: WorkspaceHandle =
            serde_json::from_value(read_only["workspace"].clone()).expect("workspace handle");

        let incompatible = service
            .workspace_open(&RequestContext::unbounded(), params.clone())
            .await;
        // MUTATION: omitting the mode comparison returns the maintenance-free
        // handle as a successful full open and silently leaves capture absent.
        assert!(
            matches!(
                incompatible,
                Err(WireError {
                    code: ErrorCode::InvalidParams,
                    ..
                })
            ),
            "a full open must not reuse a maintenance-free handle"
        );

        service
            .workspace_close(Some(read_only_handle))
            .await
            .expect("close maintenance-free handle");
        let full = service
            .workspace_open(&RequestContext::unbounded(), params)
            .await
            .expect("full open after maintenance-free close");
        let full_handle: WorkspaceHandle =
            serde_json::from_value(full["workspace"].clone()).expect("full workspace handle");
        assert!(
            lock(&service.handles)
                .get(&full_handle)
                .is_some_and(|open| lock(&open.capture).is_some()),
            "the subsequent full open must run startup and own capture"
        );
        service
            .workspace_close(Some(full_handle))
            .await
            .expect("close full handle");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capture_mode_none_preserves_disk_drift_while_full_open_reconciles_it() {
        let scratch = ScratchDir::new().expect("scratch");
        shadow_fence::write_shadow_marker_for_harness(scratch.path(), SHADOW_TOKEN)
            .expect("shadow marker");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let workspace_id = "capture-mode-none";
        std::fs::write(scratch.path().join("notes.md"), "authoritative").expect("seed disk");
        let seeded = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            )
            .await
            .expect("seed workspace through normal capture");
        let seeded_handle: WorkspaceHandle =
            serde_json::from_value(seeded["workspace"].clone()).expect("workspace handle");
        let main = service
            .versions_ensure_main(
                &RequestContext::unbounded(),
                Some(seeded_handle.clone()),
                json!({ "workspaceId": workspace_id }),
            )
            .await
            .expect("ensure main");
        service
            .workspace_close(Some(seeded_handle))
            .await
            .expect("close seeded workspace");
        std::fs::write(scratch.path().join("notes.md"), "defaced").expect("tamper disk");

        let open_params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": workspace_id,
            "captureMode": "none",
        });
        let opened = service
            .workspace_open(&RequestContext::unbounded(), open_params.clone())
            .await
            .expect("no-capture workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        assert!(
            lock(&service.handles)
                .get(&handle)
                .is_some_and(|open| lock(&open.capture).is_none()),
            "captureMode none must not create a capture driver"
        );
        let preserved = service
            .versioned_text_read(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({ "versionId": main["id"], "path": "notes.md" }),
            )
            .await
            .expect("read preserved snapshot");
        assert_eq!(
            preserved["text"],
            json!("authoritative"),
            "a no-capture open must not reconcile tampered disk bytes"
        );
        service
            .workspace_close(Some(handle))
            .await
            .expect("close no-capture workspace");

        let full = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            )
            .await
            .expect("normal full open");
        let full_handle: WorkspaceHandle =
            serde_json::from_value(full["workspace"].clone()).expect("workspace handle");
        assert!(
            lock(&service.handles)
                .get(&full_handle)
                .is_some_and(|open| lock(&open.capture).is_some()),
            "a normal full open must still create a capture driver"
        );
        let reconciled = service
            .versioned_text_read(
                &RequestContext::unbounded(),
                Some(full_handle.clone()),
                json!({ "versionId": main["id"], "path": "notes.md" }),
            )
            .await
            .expect("read reconciled snapshot");
        assert_eq!(
            reconciled["text"],
            json!("defaced"),
            "a normal full open must still reconcile disk state"
        );
        service
            .workspace_close(Some(full_handle))
            .await
            .expect("close full workspace");
    }

    #[tokio::test]
    async fn blob_egress_budget_blocks_when_aggregate_bytes_are_exhausted() {
        // MUTATION: remove the exact-byte reservation before blob hydration ->
        // the second over-budget egress proceeds while the first is retained.
        let budget = BlobEgressBudget::new(8);
        let first_ctx = RequestContext::unbounded();
        let first_cancellation = OperationCancellation::new(&first_ctx);
        let first = budget
            .reserve(5, &first_cancellation)
            .await
            .expect("reserve first five bytes");
        assert_eq!(budget.permits.available_permits(), 3);

        let waiting_budget = budget.clone();
        let mut waiting = tokio::spawn(async move {
            let ctx = RequestContext::unbounded();
            let cancellation = OperationCancellation::new(&ctx);
            waiting_budget.reserve(5, &cancellation).await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut waiting)
                .await
                .is_err(),
            "an aggregate reservation beyond the byte budget must wait"
        );

        drop(first);
        let second = tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("second reservation unblocked")
            .expect("reservation task")
            .expect("reserve second five bytes");
        assert_eq!(budget.permits.available_permits(), 3);
        drop(second);
        assert_eq!(budget.permits.available_permits(), 8);
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

    #[test]
    fn replicated_conflict_json_surfaces_an_acked_refusal() {
        let value = replicated_conflict_json(ApplyOutcome::Refused(
            dohc_engine_sync::ReplicationRefusal {
                workspace_id: "ws".to_owned(),
                origin_id: "peer".to_owned(),
                origin_seq: 7,
                op_kind: "conflict.open".to_owned(),
                reason: dohc_engine_sync::RefusalReason::InvalidInput {
                    reason: "conflict.open must describe an unresolved conflict".to_owned(),
                },
            },
        ));

        assert_eq!(
            value,
            json!({
                "replicated": true,
                "status": "refused",
                "workspaceId": "ws",
                "originId": "peer",
                "originSeq": 7,
                "opKind": "conflict.open",
                "code": "invalid-input",
                "reason": "conflict.open must describe an unresolved conflict"
            })
        );
    }

    #[test]
    fn sync_outcome_json_surfaces_an_undrained_complete_pass() {
        let value = sync_outcome_json(SyncPassOutcome::Complete {
            pushed: 0,
            fetched: 500,
            has_more: true,
            applied: 500,
            refused: 0,
            skipped: 0,
            conflicts_opened: 0,
            pending_cursor: None,
            changed_paths: Vec::new(),
            pending_resolves: Vec::new(),
            refusals: Vec::new(),
        });

        assert_eq!(value["status"], "complete");
        assert_eq!(
            value["hasMore"], true,
            "MUTATION: omitting hasMore makes a bounded prefix indistinguishable from a drained relay"
        );
    }

    #[test]
    fn relay_error_mapping_preserves_recovery_and_authorization_conditions() {
        let cases = [
            (RelayError::Conflict, ErrorCode::Conflict),
            (RelayError::OriginDiverged, ErrorCode::OriginDiverged),
            (RelayError::ShareUnavailable, ErrorCode::ShareUnavailable),
            (
                RelayError::KeyEnvelopeMissing,
                ErrorCode::KeyEnvelopeMissing,
            ),
            (RelayError::EpochSuperseded, ErrorCode::EpochSuperseded),
            (
                RelayError::IdentityNotRecognized,
                ErrorCode::IdentityNotRecognized,
            ),
            (RelayError::QuotaExceeded, ErrorCode::QuotaExceeded),
            (RelayError::PayloadTooLarge, ErrorCode::PayloadTooLarge),
            (RelayError::Forbidden, ErrorCode::Forbidden),
            (RelayError::ShareReadOnly, ErrorCode::ShareReadOnly),
            (
                RelayError::ShareOperationRejected,
                ErrorCode::ShareOperationRejected,
            ),
            (RelayError::NoProgress, ErrorCode::RelayNoProgress),
            (RelayError::BlobMissing, ErrorCode::BlobMissing),
            (
                RelayError::BlobReferenceMissing,
                ErrorCode::BlobReferenceMissing,
            ),
            (RelayError::BlobInvalid, ErrorCode::BlobInvalid),
            (RelayError::IdentityRequired, ErrorCode::IdentityRequired),
            (
                RelayError::StreamIdentityMismatch,
                ErrorCode::StreamIdentityMismatch,
            ),
            (
                RelayError::AuthorshipMismatch,
                ErrorCode::AuthorshipMismatch,
            ),
            (
                RelayError::UnknownChatOperation,
                ErrorCode::UnknownChatOperation,
            ),
            (RelayError::PresenceCapacity, ErrorCode::PresenceCapacity),
            (RelayError::SelfShare, ErrorCode::SelfShare),
            (RelayError::AmbiguousSelector, ErrorCode::AmbiguousSelector),
            (RelayError::InvalidChannel, ErrorCode::InvalidChannel),
            (
                RelayError::MethodNotAllowed,
                ErrorCode::RelayMethodNotAllowed,
            ),
            (RelayError::InvalidResponse, ErrorCode::RelayInvalidResponse),
        ];
        for (relay, expected) in cases {
            assert_eq!(
                map_relay_code(relay),
                expected,
                "MUTATION: collapsing a relay condition prevents generated clients from recovering"
            );
        }
        assert_eq!(
            map_relay_code(RelayError::Partitioned),
            ErrorCode::WorkspaceUnavailable
        );
    }

    #[test]
    fn share_view_outcome_json_surfaces_has_more_and_every_refusal() {
        let value = relay_outcome_json(RelayOperationOutcome::ShareViewPulled(
            dohc_engine_sync::ShareViewPullOutcome {
                fetched: 2,
                has_more: true,
                applied: 0,
                skipped: 1,
                refusals: vec![dohc_engine_sync::ShareViewRefusal {
                    origin_id: "granter".to_owned(),
                    origin_seq: 4,
                    op_kind: "moment.append".to_owned(),
                    code: "share-boundary-violation",
                    detail: "the share granted version main, the relay offered version other"
                        .to_owned(),
                }],
                changed_paths: Vec::new(),
                pending_cursor: ShareCursor {
                    kind: dohc_engine_sync::CursorKind::ShareView,
                    share_id: "share".to_owned(),
                    cursor: 1,
                },
            },
        ))
        .expect("serialize share view outcome");
        assert_eq!(
            value["hasMore"], true,
            "MUTATION: omitting hasMore hides that the pending cursor is only a bounded prefix"
        );
        assert_eq!(
            value["refusals"][0]["detail"],
            "the share granted version main, the relay offered version other",
            "MUTATION: serializing a bare count leaves the client nothing to tell the user"
        );
        assert_eq!(value["refusals"][0]["originSeq"], 4);
        assert_eq!(value["refusals"][0]["code"], "share-boundary-violation");
    }

    #[test]
    fn relay_refusal_messages_preserve_recovery_meaning() {
        let origin = map_runtime(RuntimeError::Relay(RelayError::OriginDiverged));
        assert_eq!(origin.code, ErrorCode::InvalidParams);
        assert_eq!(
            origin.message, "relay-origin-diverged",
            "MUTATION: a generic INVALID_PARAMS would re-baseline on protocol errors"
        );

        let read_only = map_runtime(RuntimeError::Relay(RelayError::ShareReadOnly));
        assert_eq!(read_only.code, ErrorCode::InvalidParams);
        assert_eq!(
            read_only.message, "share-read-only",
            "MUTATION: a generic INVALID_PARAMS would permanently downgrade writable shares"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn binary_write_records_suppression_in_the_root_scoped_registry() {
        // MUTATION: pass the process-global suppression registry to the actor
        // instead of the root-scoped view -> the scoped lookup is empty.
        let scratch = ScratchDir::new().expect("scratch");
        shadow_fence::write_shadow_marker_for_harness(scratch.path(), SHADOW_TOKEN)
            .expect("shadow marker");
        let service = EngineService::new();
        let workspace_id = "binary-root-scoped-suppression";
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            )
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");

        // Keep the assertion deterministic: no watcher remains to consume the
        // suppression identity between materialization and inspection.
        let open = service.open(Some(&handle)).expect("open workspace");
        let canonical_root = open.root.clone();
        open.shutdown_capture().await;

        let request = Request {
            id: 1,
            method: "versionedBinary.write".to_owned(),
            workspace: Some(handle.clone()),
            deadline_ms: None,
            idempotency_key: None,
            params: json!({
                "versionId": "main",
                "path": "scoped.bin",
                "bytes": [7, 8, 9],
                "origin": "api",
            }),
        };
        let result = service
            .versioned_binary_write(
                &RequestContext::unbounded(),
                &request,
                request.params.clone(),
            )
            .await
            .expect("binary write");
        let sha256 = result["snapshot"]["sha256"]
            .as_str()
            .expect("binary sha256");

        assert!(
            service.self_writes.scoped(&canonical_root).has_pending(
                workspace_id,
                "scoped.bin",
                sha256
            ),
            "binary materialization must register in the capture driver's root-scoped view"
        );
        assert!(
            !service
                .self_writes
                .has_pending(workspace_id, "scoped.bin", sha256),
            "the process-global unscoped namespace must remain empty"
        );

        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");
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
    async fn mutation_write_waits_for_session_ops_before_lease_check_and_commit() {
        // MUTATION: remove the versionedText.write session_ops acquisition ->
        // the write completes while this test still holds the ydoc ordering guard.
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
                    "workspaceId": "mutation-session-serial"
                }),
            )
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");

        let open = service.open(Some(&handle)).expect("open workspace");
        let held = Arc::clone(&open.session_ops).lock_owned().await;
        let writing_service = Arc::clone(&service);
        let writing_handle = handle.clone();
        let mut writing = tokio::spawn(async move {
            let ctx = RequestContext::unbounded();
            let request = Request {
                id: 1,
                method: "versionedText.write".to_owned(),
                workspace: Some(writing_handle),
                deadline_ms: None,
                idempotency_key: None,
                params: json!({
                    "versionId": "main",
                    "path": "serialized.md",
                    "text": "must wait",
                    "origin": "api",
                    "requestId": "mutation-session-serial-write"
                }),
            };
            writing_service
                .versioned_text_write(&ctx, &request, request.params.clone())
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut writing)
                .await
                .is_err(),
            "the write path must block behind the same guard held by ydoc.open"
        );

        drop(held);
        tokio::time::timeout(Duration::from_secs(10), writing)
            .await
            .expect("write completed after guard release")
            .expect("write task")
            .expect("versioned text write");
        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");
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

    /// A workspace whose actor died is EVICTED and rebound by the next open,
    /// never closed. That path dropped the handle and the sessions but left
    /// the handle's pending cursors in the map, where nothing could ever
    /// remove them: `consume_pending_cursor` matches on the handle, and every
    /// rebind mints a new one from a monotonic counter. Each evicted binding
    /// therefore stranded one entry per issued cursor for the life of the
    /// process. The normal close path has always dropped them.
    #[tokio::test]
    async fn evicting_a_dead_binding_drops_its_pending_cursors() {
        let scratch = ScratchDir::new().expect("scratch");
        shadow_fence::write_shadow_marker_for_harness(scratch.path(), SHADOW_TOKEN)
            .expect("shadow marker");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = Arc::new(EngineService::with_supervisor(supervisor));
        let open_params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "evicted-cursor-cleanup"
        });
        let opened = service
            .workspace_open(&RequestContext::unbounded(), open_params.clone())
            .await
            .expect("initial workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");

        lock(&service.pending_cursors).insert(
            "evicted-token".to_owned(),
            PendingCursor {
                handle: handle.clone(),
                workspace_id: "evicted-cursor-cleanup".to_owned(),
                cursor: IssuedCursor::Relay(dohc_engine_sync::RelayCursor {
                    cursor: 7,
                    replication_epoch: "epoch".to_owned(),
                    stream_identity: "stream".to_owned(),
                    refusal_report_id: None,
                }),
            },
        );

        // Kill the actor underneath the live handle. The next open finds a
        // bound-but-Closed actor and takes the eviction path rather than the
        // short-circuit or the close path.
        let db_path = scratch
            .path()
            .join(".dohc")
            .join("engine")
            .join("engine.db");
        let closing_path = db_path.clone();
        let _closed = tokio::task::spawn_blocking(move || supervisor.close(&closing_path))
            .await
            .expect("actor close task");

        let reopened = service
            .workspace_open(&RequestContext::unbounded(), open_params)
            .await
            .expect("workspace reopen after the actor died");
        let rebound: WorkspaceHandle =
            serde_json::from_value(reopened["workspace"].clone()).expect("rebound handle");
        assert_ne!(rebound, handle, "eviction must mint a fresh handle");

        assert!(
            lock(&service.pending_cursors).is_empty(),
            "eviction must drop the dead binding's pending cursors"
        );

        service
            .workspace_close(Some(rebound))
            .await
            .expect("final workspace close");
    }
}
