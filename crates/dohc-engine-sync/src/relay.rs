use std::collections::{BTreeMap, BTreeSet, VecDeque};

use dohc_engine_domain::{DeleteTextFile, DomainError, VersionedTextStore, WriteBinary, WriteText};
use dohc_engine_storage::text;
use dohc_engine_storage::{
    EngineStore, FaultInjector, FaultPoint, StorageError, TxnOutcome, hex_sha256,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::apply::apply_chat_lww_projection_tx;
use crate::cursor::{
    RelayCursor, commit_relay_cursor, has_relay_position, read_pushed_seq, rewind_pushed_seq,
    write_pushed_seq,
};
use crate::error::GENERIC_REPLAY_REFUSAL_CODE;
use crate::hydration::VerifiedBlob;
use crate::journal::{crashes, list_replication_ops, read_sync_identity};
use crate::references::{MomentRefs, VersionCreateRefs, YdocRefs, conflict_open_sides};

mod direct_write;
mod share_authors;
use crate::{
    ApplyDisposition, ApplyOutcome, BlobKind, ObservedBytes, RelayError, ReplicationEnvelope,
    ShareDisposition, SyncError, blob_ceiling,
};
pub use direct_write::{
    DirectWritePushOutcome, DirectWriteReport, DirectWriteResult, DirectWriteState,
    DirectWriteStatus, ShareCollectionWriteRequest, ShareCollectionWriteResponse, collision_key,
    read_direct_write_status, read_record_creation_statuses,
};
use direct_write::{read_direct_write_marks, read_direct_write_open_objects};

const CLAIM_REFUSALS: [(&str, RelayError); 5] = [
    ("workspace-unavailable", RelayError::WorkspaceUnavailable),
    ("epoch-superseded", RelayError::EpochSuperseded),
    ("identity-not-recognized", RelayError::IdentityNotRecognized),
    ("identity-required", RelayError::IdentityRequired),
    (
        "stream-identity-mismatch",
        RelayError::StreamIdentityMismatch,
    ),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub origin_id: String,
    pub after_seq: i64,
    pub ops: Vec<ReplicationEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushResponse {
    pub settlement_refusals: Vec<SettlementPublicationRefusal>,
    /// Ops the scoped feed refused one at a time. Only a hosted push has any.
    pub hosted_refusals: Vec<HostedPushRefusal>,
    /// Copies of retained work another device had already published. Only
    /// the owner's log names any.
    pub redundant_recoveries: Vec<crate::RedundantRecovery>,
    pub accepted: usize,
    pub inserted: usize,
    pub skipped: usize,
    pub current_max_origin_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettlementPublicationRefusal {
    pub origin_id: String,
    pub origin_seq: i64,
    pub moment_id: String,
    pub settlement_id: String,
    pub reason: String,
}

/// A hosted op the relay refused. It keeps the coordinate as a refusal, so
/// the origin's later ops still land; the op itself never reaches the log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedPushRefusal {
    pub origin_id: String,
    pub origin_seq: i64,
    pub op_kind: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub cursor: i64,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullResponse {
    pub ops: Vec<ReplicationEnvelope>,
    pub next_cursor: i64,
    pub has_more: bool,
}

/// A read of the session host's scoped feed, `GET /sync/:workspace/hosted/log`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedPullRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    /// The scope the host last adopted, sent as `scope`. `None` before the first.
    pub scope_token: Option<String>,
    /// One document's backfill, sent as `object`. `None` reads the main feed.
    pub object_id: Option<String>,
    pub cursor: i64,
    pub limit: usize,
}

/// One scoped feed page. Its cursor may pass rows the feed withholds. When the
/// request's scope token is stale, it carries no ops and the request's cursor,
/// and its scope is the one the host must adopt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedPullResponse {
    pub scope: HostedScope,
    pub ops: Vec<ReplicationEnvelope>,
    pub next_cursor: i64,
    pub has_more: bool,
}

/// The documents the host may read, under the token that names them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedScope {
    pub token: String,
    pub documents: Vec<HostedScopeDocument>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedScopeDocument {
    pub object_id: String,
    pub path: String,
}

/// One hosted pull pass. Its cursor stays pending until the caller
/// materializes the pass and commits it with [`RelaySyncClient::commit_hosted_cursor`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HostedPassOutcome {
    pub fetched: usize,
    pub has_more: bool,
    pub applied: usize,
    pub refused: usize,
    pub skipped: usize,
    pub conflicts_opened: i64,
    /// `None` when the pass adopted a new scope and applied nothing.
    pub pending_cursor: Option<crate::HostedCursor>,
    pub changed_paths: Vec<crate::MomentMaterializationChange>,
    pub refusals: Vec<crate::ReplicationRefusal>,
    pub sharing_declined: Vec<crate::SharingDeclined>,
    pub record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
    /// The fetched documents this pass leaves held, by object id, with what
    /// holds each. None of them can be edited live until a later pass
    /// settles it ready.
    pub held: BTreeMap<String, crate::HostedHold>,
    /// The path its scope names each held document at, by object id.
    pub held_paths: BTreeMap<String, String>,
    /// The held documents this pass moved from ready: ready in the replica
    /// it fetched, held now. What it read bounds them.
    pub newly_held: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogCoordinateRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub origin_id: String,
    pub origin_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogCoordinateResponse {
    Present(ReplicationEnvelope),
    PresentBelowEpochFloor(ReplicationEnvelope),
    Absent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeResponse {
    pub has_content: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClaimResponse;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpochRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpochResponse {
    pub rotated: bool,
    pub replication_epoch: String,
    pub stream_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobHaveRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub sha256s: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobHaveResponse {
    pub missing: Vec<String>,
}

impl BlobHaveResponse {
    /// Reject duplicate or unrequested digests before using a presence answer.
    pub fn validated_missing(&self, requested: &[String]) -> Result<BTreeSet<&String>, RelayError> {
        let missing = self.missing.iter().collect::<BTreeSet<_>>();
        if missing.len() != self.missing.len() || missing.iter().any(|sha| !requested.contains(sha))
        {
            return Err(RelayError::InvalidResponse);
        }
        Ok(missing)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobUploadRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub sha256: String,
    pub bytes: Vec<u8>,
}

pub const MAX_BLOB_DOWNLOAD_BATCH: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobDownloadSpec {
    pub sha256: String,
    pub limit_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobDownloadBatchRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub blobs: Vec<BlobDownloadSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobDownloadResponse {
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobDownloadBatchResponse {
    pub results: Vec<Result<BlobDownloadResponse, RelayError>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEnvelopeRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub envelope_json: String,
    pub if_match: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEnvelopeResponse {
    pub etag: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEnvelopeDownloadRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEnvelopeDownloadResponse {
    pub envelope_json: String,
    pub etag: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareReplicationEnvelope {
    pub origin_id: String,
    pub origin_seq: i64,
    pub op_kind: String,
    pub payload: serde_json::Value,
    pub recorded_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedChannelRequest {
    pub share_id: String,
    pub channel_wire_id: String,
    pub origin_id: String,
    pub cursor: i64,
    pub ops: Vec<ShareReplicationEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedChannelResponse {
    pub own_origin_id: Option<String>,
    pub ops: Vec<ShareReplicationEnvelope>,
    pub next_cursor: i64,
    pub has_more: bool,
    pub push: Option<PushResponse>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareLogPushRequest {
    pub share_id: String,
    pub origin_id: String,
    pub ops: Vec<ShareReplicationEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareViewRequest {
    pub share_id: String,
    pub cursor: i64,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareViewResponse {
    pub ops: Vec<ShareReplicationEnvelope>,
    pub next_cursor: i64,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareBlobRequest {
    pub share_id: String,
    pub sha256: String,
}

/// One blob a proposed change names, uploaded to the GRANTER's workspace
/// before the submit that references it. The relay refuses a batch
/// naming a blob it does not hold, at submit and again at accept, so content
/// travels first and the ops travel second — the same ordering the owner's own
/// drain uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareBlobUploadRequest {
    pub share_id: String,
    pub sha256: String,
    pub bytes: Vec<u8>,
}

/// One net change to one file: "the file you have at `based_on_path` with
/// content `based_on_blob_sha256` should now be at `after_path` with content
/// `after_blob_sha256`" — or, for a delete, should be gone.
///
/// Deliberately not a replayed moment. The served moment drops `momentId`,
/// `objectId` and every `before*` field, so a recipient never learns a granter
/// moment id and could not state a lineage the granter recognizes. The base
/// pair is the one identifier both sides genuinely share, and the relay
/// resolves it to the granter's own moment at accept.
///
/// Every optional field serializes as an explicit `null` rather than being
/// skipped. The relay reads the base pair as a stated fact — both halves or
/// neither — so an absent field and a null field must not look the same on the
/// wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareProposalChange {
    /// The GRANTER's path for this file, or `None` for a file the recipient
    /// created. Travels with `based_on_blob_sha256` or not at all.
    pub based_on_path: Option<String>,
    /// The after-hash of the last granter moment the recipient applied for
    /// this file, or `None` for a file the recipient created.
    pub based_on_blob_sha256: Option<String>,
    /// `"write"` or `"delete"`, net over every local op in this submit.
    pub operation: String,
    /// Where the change puts the file. `None` for a delete.
    pub after_path: Option<String>,
    pub after_blob_sha256: Option<String>,
    /// `"text"` or `"binary"` — the only two values the relay accepts.
    pub after_content_kind: Option<String>,
    pub after_byte_length: Option<i64>,
    pub recorded_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareProposalSubmitRequest {
    pub share_id: String,
    /// The idempotency key for one submit. A repeat returns the existing
    /// proposal and never creates a second one.
    pub submit_id: String,
    pub ops: Vec<ShareProposalChange>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareProposalSubmitResponse {
    pub proposal_id: String,
    pub ops: usize,
}

/// What one submit offered. `proposal_id` is `None` exactly when nothing was
/// offered — a share below edit level, or a scan that found no change.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ShareProposalSubmitOutcome {
    pub submitted: usize,
    pub proposal_id: Option<String>,
    /// Files this scan dropped because one of their local ops named a path
    /// the pinned grant does not cover. Counted once per file, not per op:
    /// the file is not offerable at all, so a partly collected one is dropped
    /// whole. A file that was never in the shared paths and one an edit moved
    /// out of them count the same, because they state the same fact — the file
    /// is not part of this share, and it was not sent.
    ///
    /// Saturates at `MAX_SHARE_PROPOSAL_OPS`, the bound the contract carrying
    /// this count accepts.
    pub skipped_outside_share: usize,
    /// Whether the per-submit change bound stopped this scan before the
    /// journal mark it read, so a further submit has more to offer.
    ///
    /// A flag, not a count. The scan stops AT the bound rather than reading
    /// on, so this replica has not measured what is left.
    pub more_pending: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoverResponse {
    pub old_origin_id: String,
    pub new_origin_id: String,
    pub shared_prefix_length: i64,
    pub preserved_ops: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedChannelRejection {
    pub origin_id: String,
    pub origin_seq: i64,
    pub op_kind: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedChannelPullOutcome {
    pub fetched: usize,
    pub has_more: bool,
    pub applied: usize,
    pub refused: usize,
    pub rejections: Vec<SharedChannelRejection>,
    pub skipped: usize,
    pub next_cursor: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedChannelPushOutcome {
    pub pushed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareViewChangedPath {
    pub path: String,
    pub operation: &'static str,
    pub content_kind: &'static str,
}

/// The relay's share bootstrap op. Payload-free by contract, and the one op a
/// share-view pull skips without calling it a refusal.
const BOOTSTRAP_OP_KIND: &str = "workspace.init";

/// The bounds the desktop's `ShareSkippedOpsSummary` enforces on a persisted
/// refusal (`apps/desktop/src/ipc/bridgeContract.ts`), in UTF-16 code units —
/// what zod's `.max()` counts.
///
/// A refusal that breaks them is worse than no refusal at all. The client
/// decodes strictly, so an empty op kind throws and wedges the pull on every
/// retry; an oversized one is persisted and the next workspace listing fails
/// to parse. The relay picks these values, so they are normalized here, where
/// the refusal is built — a diagnostic must be well formed whatever it is
/// diagnosing.
const MAX_REFUSAL_OP_KIND_UNITS: usize = 128;
pub(crate) const MAX_REFUSAL_DETAIL_UNITS: usize = 2048;

/// The path budget inside one refusal listed in a detail, in UTF-16 units.
///
/// This rejects no work. The path is stored whole and nothing is refused for
/// being long; this is a share of the detail budget, and it exists because a
/// path is the one part of a detail that no other limit bounds. Sized from
/// that contract rather than from measured work: 200 units keeps at least six
/// complete refusals inside `MAX_REFUSAL_DETAIL_UNITS`.
///
/// A healthy path OUTGROWS this, and by design. The relay admits a granted
/// path of `MAX_SHARE_PATH_CHARS` (1,024, `services/sync-relay/src/shareFilter.ts`)
/// and the files under it are longer still. Raising the budget to cover them
/// would cost the six-refusal guarantee — one 1,024-unit path is half the
/// whole detail. So eliding is the normal case, not the pathological one,
/// which is why `elided_path` marks the cut instead of hiding it.
const MAX_REFUSAL_PATH_UNITS: usize = 200;

/// What an op kind becomes when the relay's is not one. The real cause is in
/// `detail`, and the coordinate stays exactly as served.
const INVALID_OP_KIND: &str = "invalid-op-kind";

/// A path cut to `budget`, with the cut marked and both ends kept.
///
/// A head-only cut was silent and lossy in the same stroke: two refused files
/// that differ past the budget recorded identically, and the record is all the
/// reader has once the cursor has committed past them. Since a healthy path
/// outgrows this budget (see `MAX_REFUSAL_PATH_UNITS`), that was the ordinary
/// case rather than a corner.
///
/// So the tail is taken first — the file name is the identifying part, and the
/// stated recovery is to go ask the granter about a named file — and the
/// marker carries how many units went, so two paths that share a head and a
/// tail still read apart.
fn elided_path(path: &str, budget: usize) -> String {
    let units = path.encode_utf16().count();
    if units <= budget {
        return path.to_owned();
    }
    let tail = trailing_units(path, budget / 2);
    let tail_kept = tail.encode_utf16().count();
    // `units` is an upper bound on the omitted count, so a marker measured
    // from it is never narrower than the real one and the result cannot
    // outgrow the budget.
    let marker_budget = format!("…+{units}…").encode_utf16().count();
    let head = bounded_units(path, budget.saturating_sub(tail_kept + marker_budget));
    let omitted = units - head.encode_utf16().count() - tail_kept;
    format!("{head}…+{omitted}…{tail}")
}

/// The last `limit` UTF-16 units of `value`, whole characters only.
fn trailing_units(value: &str, limit: usize) -> String {
    let mut reversed = String::new();
    let mut units = 0;
    for character in value.chars().rev() {
        let width = character.len_utf16();
        if units + width > limit {
            break;
        }
        reversed.push(character);
        units += width;
    }
    reversed.chars().rev().collect()
}

fn bounded_units(value: &str, limit: usize) -> String {
    if value.encode_utf16().count() <= limit {
        return value.to_owned();
    }
    let mut bounded = String::new();
    let mut units = 0;
    for character in value.chars() {
        let width = character.len_utf16();
        if units + width > limit {
            break;
        }
        bounded.push(character);
        units += width;
    }
    bounded
}

impl ShareViewRefusal {
    /// Build a refusal whose every field is one the recipient can persist and
    /// read back. Only the op kind can be unusable — the coordinate was
    /// checked before this, and the code is ours — so it is the one field
    /// that can be replaced.
    fn new(
        origin_id: String,
        origin_seq: i64,
        op_kind: &str,
        code: &'static str,
        detail: String,
    ) -> Self {
        let usable_kind =
            !op_kind.is_empty() && op_kind.encode_utf16().count() <= MAX_REFUSAL_OP_KIND_UNITS;
        Self {
            origin_id,
            origin_seq,
            op_kind: if usable_kind {
                op_kind.to_owned()
            } else {
                INVALID_OP_KIND.to_owned()
            },
            code,
            detail: bounded_units(&detail, MAX_REFUSAL_DETAIL_UNITS),
        }
    }
}

/// One op a share-view pull refused, so the refusal reaches the caller instead
/// of being a bare count. Mirrors `SharedChannelRejection`, and adds `detail`
/// because a version refusal names a limit, a unit and an observed usage that
/// a code alone throws away.
///
/// A skipped op is not a failed pull: the page continues, and one op a
/// diverging relay serves cannot wedge the whole share. The cost of that
/// liveness is that a recipient can go on seeing stale content, so the reason
/// travels with the outcome and the client surfaces it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareViewRefusal {
    pub origin_id: String,
    pub origin_seq: i64,
    pub op_kind: String,
    /// The stable machine code, from `SyncError::code`.
    pub code: &'static str,
    /// The refusal message, which names the constraint the op broke.
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareViewPullOutcome {
    pub fetched: usize,
    pub has_more: bool,
    pub applied: usize,
    pub skipped: usize,
    /// Why the skipped ops were skipped, in page order. Bounded by the page
    /// itself: a page carries at most `MAX_PULL_OPS` ops. A page entry too
    /// malformed to parse into an envelope has no origin identity to report,
    /// so it is counted in `skipped` without a refusal.
    pub refusals: Vec<ShareViewRefusal>,
    pub changed_paths: Vec<ShareViewChangedPath>,
    /// How far the share has been read, not how much of it applied. It
    /// advances past every op the page carried, including the skipped ones —
    /// those are two different facts, and `applied`, `skipped` and `refusals`
    /// carry the other one. A cursor that stalled on a refusal would re-fetch
    /// the same refusal forever and hold every later op in the share behind
    /// it; one that advanced silently would lose the skip. So it advances,
    /// and the skip is recorded.
    pub pending_cursor: crate::ShareCursor,
}

/// Runtime-owned relay seam. The core crate contains no HTTP or async runtime
/// dependency; production adapters live in separate crates.
pub trait RelayTransport {
    /// The native replica publishes settlement proofs; the relay derives their authors.
    fn publishes_native_settlements(&self) -> bool {
        false
    }
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError>;
    fn pull(&self, req: PullRequest) -> Result<PullResponse, RelayError>;
    /// GET the session host's scoped feed. Only a hosted replica's transport serves it.
    fn pull_hosted(&self, _req: HostedPullRequest) -> Result<HostedPullResponse, RelayError> {
        Err(no_hosted_feed())
    }
    /// POST to the scoped feed's log under the host's `service-host:` origin.
    /// It answers as [`RelayTransport::push`] does.
    fn push_hosted(&self, _req: PushRequest) -> Result<PushResponse, RelayError> {
        Err(no_hosted_feed())
    }
    fn lookup_log_coordinate(
        &self,
        req: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError>;
    /// A local bridge batch. Adapters still use the existing coordinate endpoint.
    fn lookup_log_coordinates(
        &self,
        requests: Vec<LogCoordinateRequest>,
    ) -> Result<Vec<LogCoordinateResponse>, RelayError> {
        if requests.is_empty() || requests.len() > MAX_BASE_REPAIR_LOOKUPS {
            return Err(RelayError::InvalidResponse);
        }
        requests
            .into_iter()
            .map(|request| self.lookup_log_coordinate(request))
            .collect()
    }
    fn probe(&self, req: ProbeRequest) -> Result<ProbeResponse, RelayError>;
    fn claim_workspace(&self, req: ClaimRequest) -> Result<ClaimResponse, RelayError>;
    fn rotate_epoch(&self, req: EpochRequest) -> Result<EpochResponse, RelayError>;
    fn blobs_have(&self, req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError>;
    fn upload_blob(&self, req: BlobUploadRequest) -> Result<(), RelayError>;
    fn upload_blobs(&self, requests: Vec<BlobUploadRequest>) -> Result<(), RelayError> {
        if requests.is_empty() || requests.len() > MAX_BLOB_UPLOAD_BATCH {
            return Err(RelayError::InvalidResponse);
        }
        requests
            .into_iter()
            .try_for_each(|request| self.upload_blob(request))
    }
    fn download_blobs(
        &self,
        req: BlobDownloadBatchRequest,
    ) -> Result<BlobDownloadBatchResponse, RelayError>;
    fn upload_key_envelope(
        &self,
        req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError>;
    fn download_key_envelope(
        &self,
        req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError>;
    fn shared_channel_pull(
        &self,
        req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError>;
    /// POST to a share's log. One surface for both share kinds: the route is
    /// per-share and the relay scopes the batch by the share's own selector,
    /// so the pusher names no channel and no path.
    fn share_log_push(&self, req: ShareLogPushRequest) -> Result<PushResponse, RelayError>;
    fn share_view_pull(&self, req: ShareViewRequest) -> Result<ShareViewResponse, RelayError>;
    fn share_blob(&self, req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError>;
    fn share_blob_upload(&self, req: ShareBlobUploadRequest) -> Result<(), RelayError>;
    fn share_proposal_submit(
        &self,
        req: ShareProposalSubmitRequest,
    ) -> Result<ShareProposalSubmitResponse, RelayError>;
    /// POST one direct write to a Collection's own files. The relay answers
    /// a stale base and a refusal as outcomes, not errors, because the
    /// recipient shows each one and keeps going.
    fn share_collection_write(
        &self,
        req: ShareCollectionWriteRequest,
    ) -> Result<ShareCollectionWriteResponse, RelayError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncPassOutcome {
    Complete {
        owner_admission_pending: Vec<crate::OwnerAdmissionPending>,
        pushed: usize,
        fetched: usize,
        has_more: bool,
        applied: usize,
        refused: usize,
        skipped: usize,
        conflicts_opened: i64,
        pending_cursor: Option<RelayCursor>,
        changed_paths: Vec<crate::MomentMaterializationChange>,
        /// Per-operation validation failures that were journaled and acked.
        /// The rejected mutations were rolled back before those coordinates
        /// were retired.
        refusals: Vec<crate::ReplicationRefusal>,
        /// Local Y.Doc bases that could not be shared during enrollment.
        sharing_declined: Vec<crate::SharingDeclined>,
        /// Collection record changes this pass applied, in apply order, for
        /// post-commit record-event emission.
        record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
    },
    CrashedAfterRemoteCommit,
    CrashedAfterApply {
        applied: usize,
        refused: usize,
        skipped: usize,
        conflicts_opened: i64,
        pending_cursor: RelayCursor,
        changed_paths: Vec<crate::MomentMaterializationChange>,
        refusals: Vec<crate::ReplicationRefusal>,
        sharing_declined: Vec<crate::SharingDeclined>,
        record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
    },
}

pub struct RelaySyncClient<T> {
    transport: T,
    /// Group automation claims this client's applies committed and nobody
    /// took yet. A pass that fails after an apply committed leaves them here:
    /// its retry finds the message stored and claims nothing again.
    automation_claims: std::sync::Mutex<Vec<dohc_engine_domain::AutomationClaim>>,
    continuation: PullContinuation,
}

/// A pull pass that stopped for released-tail validation
/// ([`RelayError::ValidationPending`]), kept for the request that ran it.
/// That request's next run applies the rest of what the pass fetched, from
/// the row that waited, with every count, change and fact the pass had
/// gathered: a fresh pass would skip the rows already applied and report
/// none of it. A new request starts empty.
#[derive(Clone, Default)]
pub struct PullContinuation(std::sync::Arc<std::sync::Mutex<Option<SuspendedPull>>>);

struct SuspendedPull {
    workspace_id: String,
    fetched: Fetched,
    progress: ApplyProgress,
}

enum Fetched {
    Ordinary(Box<OrdinaryFetch>),
    Hosted(Box<HostedFetch>),
}

/// What an ordinary pass fetched and read before it applied.
struct OrdinaryFetch {
    identity: crate::SyncIdentity,
    queued: Vec<ReplicationEnvelope>,
    ordered: Vec<ReplicationEnvelope>,
    cursor: i64,
    fetched: usize,
    has_more: bool,
    bootstrap_complete: bool,
    /// The token [`crate::cursor::begin_ordinary_pull`] gave this pass; only
    /// its own terminal cursor finishes the pull.
    pull_token: String,
}

/// What a hosted pass fetched and read before it applied.
struct HostedFetch {
    replica: crate::HostedReplicaState,
    identity: crate::SyncIdentity,
    backfill: Option<(String, i64)>,
    reads: BTreeMap<String, (i64, bool)>,
    has_more: bool,
    fetched: usize,
    cursor: i64,
    queued: Vec<ReplicationEnvelope>,
    ordered: Vec<ReplicationEnvelope>,
}

impl PullContinuation {
    fn take(&self, workspace_id: &str) -> Option<(Fetched, ApplyProgress)> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
            .filter(|suspended| suspended.workspace_id == workspace_id)
            .map(|suspended| (suspended.fetched, suspended.progress))
    }

    fn keep(&self, workspace_id: &str, fetched: Fetched, progress: ApplyProgress) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(SuspendedPull {
            workspace_id: workspace_id.to_owned(),
            fetched,
            progress,
        });
    }
}

#[cfg(test)]
#[path = "relay_prepared_tests.rs"]
mod prepared_tests;

pub const MAX_BLOB_UPLOAD_BATCH: usize = 4;
const MAX_BLOB_UPLOAD_BATCH_BYTES: usize = 1024 * 1024;

const MAX_PUSH_OPS_PER_PASS: usize = crate::MAX_PUSH_OPS_PER_BATCH;
// Soft limit on preparation and blob uploads, reserving 10 seconds of the
// desktop's 30-second RPC deadline for append and durable acknowledgement.
// An individual transport request can still run past this limit.
const PUSH_PRE_APPEND_BUDGET: std::time::Duration = std::time::Duration::from_secs(20);

/// One push request's preparation, retained while its transport yields for I/O.
/// A new request starts from the durable cursor, never from this cache.
pub struct PushWorkspaceProgress {
    started: std::time::Instant,
    acknowledged: usize,
    confirmed_identity: Option<crate::SyncIdentity>,
    confirmed_blobs: BTreeSet<String>,
    page: Option<PreparedPushPage>,
    batch_size: usize,
    file_versions_selected: bool,
    writer_cache_reset_required: bool,
}

impl PushWorkspaceProgress {
    /// Record validated successful responses from this push's transport only.
    pub fn confirm_blob_presence(
        &mut self,
        workspace: &str,
        epoch: &str,
        stream: &str,
        sha256s: impl IntoIterator<Item = String>,
    ) -> bool {
        if !self.confirmed_identity.as_ref().is_some_and(|identity| {
            identity.workspace_id == workspace
                && identity.replication_epoch == epoch
                && identity.stream_identity == stream
        }) {
            return false;
        }
        self.confirmed_blobs.extend(sha256s);
        true
    }

    /// Sticky across I/O continuations, including failed enrollment work.
    pub fn writer_cache_reset_required(&self) -> bool {
        self.writer_cache_reset_required
    }
}

impl Default for PushWorkspaceProgress {
    fn default() -> Self {
        Self {
            started: std::time::Instant::now(),
            acknowledged: 0,
            confirmed_identity: None,
            confirmed_blobs: BTreeSet::new(),
            page: None,
            batch_size: crate::MAX_PUSH_OPS_PER_BATCH,
            file_versions_selected: false,
            writer_cache_reset_required: false,
        }
    }
}

fn select_file_versions(
    selection: &mut bool,
    store: &mut EngineStore,
    workspace_id: &str,
    faults: &dyn FaultInjector,
) -> Result<(), RelayError> {
    if *selection {
        return Ok(());
    }
    match store
        .write_with(faults, |tx| {
            if !crate::ydoc_origination::can_originate_local_bases_in_tx(tx, workspace_id)? {
                return Ok::<_, SyncError>(false);
            }
            crate::enrolment::backfill_file_versions_in_tx(tx, workspace_id)?;
            Ok(true)
        })
        .map_err(local)?
    {
        TxnOutcome::Committed(selected) => {
            *selection = selected;
            Ok(())
        }
        TxnOutcome::Crashed { .. } => Err(local(SyncError::FaultCrash)),
    }
}

struct PreparedPushPage {
    identity: crate::SyncIdentity,
    origin_id: String,
    cursor: i64,
    revision: u64,
    ops: Vec<ReplicationEnvelope>,
    prefix: crate::OwnerPublicationPrefix,
    blob_refs: BTreeMap<String, BTreeSet<BlobKind>>,
    missing: BTreeSet<String>,
    inventory: VecDeque<Vec<String>>,
    uploaded_ops: usize,
    sending: Option<usize>,
}

fn base_repair_collab_error(error: dohc_engine_collab::CollabError) -> SyncError {
    match error {
        dohc_engine_collab::CollabError::Storage(storage) => SyncError::Storage(storage),
        hard => SyncError::Storage(StorageError::corrupt_public(hard)),
    }
}

struct PendingBaseRelayRepair {
    key: dohc_engine_collab::DocKey,
    lineage_claim_id: String,
    origin_id: String,
    origin_seq: i64,
    op_kind: String,
    payload: serde_json::Value,
    recorded_at_ms: i64,
}

type BaseRelayRepairKey = (String, String, String);
type BaseRelayRepairCandidate = (PendingBaseRelayRepair, Option<i64>, bool);

pub const MAX_BASE_REPAIR_LOOKUPS: usize = 256;

#[derive(Default)]
struct BaseRelayRepairChunk {
    repairs: Vec<PendingBaseRelayRepair>,
    deferred: Vec<PendingDeferredRelayRepair>,
}

impl BaseRelayRepairChunk {
    fn len(&self) -> usize {
        self.repairs.len() + self.deferred.len()
    }
}

struct PendingDeferredRelayRepair {
    origin_id: String,
    origin_seq: i64,
    op_kind: String,
    payload: serde_json::Value,
    recorded_at_ms: i64,
}

impl<T: RelayTransport> RelaySyncClient<T> {
    pub fn new(transport: T) -> Self {
        Self::resuming(transport, PullContinuation::default())
    }

    /// A client for one run of a request, resuming the pull pass
    /// `continuation` kept from that request's earlier run.
    pub fn resuming(transport: T, continuation: PullContinuation) -> Self {
        Self {
            transport,
            automation_claims: std::sync::Mutex::new(Vec::new()),
            continuation,
        }
    }

    /// The Group automation claims this client's applies committed since the
    /// last call, whether or not the pass that applied them finished.
    pub fn take_automation_claims(&self) -> Vec<dohc_engine_domain::AutomationClaim> {
        std::mem::take(
            &mut *self
                .automation_claims
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    fn keep_automation_claims(&self, claims: Vec<dohc_engine_domain::AutomationClaim>) {
        self.automation_claims
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .extend(claims);
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }

    /// A hosted replica writes to the scoped feed's log; any other to the workspace log.
    fn push_log(&self, hosted: bool, req: PushRequest) -> Result<PushResponse, RelayError> {
        if hosted {
            self.transport.push_hosted(req)
        } else {
            self.transport.push(req)
        }
    }

    pub(crate) fn repair_pending_ydoc_base_orders(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        identity: &crate::journal::SyncIdentity,
        faults: &dyn FaultInjector,
        page: &[ReplicationEnvelope],
    ) -> Result<(), RelayError> {
        let passive = store.is_passive();
        let local_pushed_seq =
            read_pushed_seq(store, workspace_id, &identity.origin_id).map_err(local)?;
        let rows = store
            .read_with(|conn| {
                let mut statement = conn
                    .prepare(
                        "WITH coordinates AS (
                             SELECT docs.workspace_id,docs.version_id,docs.object_id,
                                    docs.lineage_claim_id,candidate.origin_id,candidate.origin_seq
                               FROM ydoc_docs AS docs
                               JOIN ydoc_base_relay_candidates AS candidate
                                 ON candidate.workspace_id=docs.workspace_id
                                AND candidate.version_id=docs.version_id
                                AND candidate.object_id=docs.object_id
                                AND candidate.lineage_claim_id=docs.lineage_claim_id
                              WHERE docs.workspace_id=?1
                                AND docs.lineage_claim_status='exact'
                                AND docs.base_relay_seq IS NULL
                                AND docs.base_relay_confirmed_absent=0
                                AND docs.lineage_claim_id IS NOT NULL
                             UNION ALL
                             SELECT docs.workspace_id,docs.version_id,docs.object_id,
                                    docs.lineage_claim_id,docs.base_origin_id,docs.base_origin_seq
                               FROM ydoc_docs AS docs
                              WHERE docs.workspace_id=?1
                                AND docs.lineage_claim_status='exact'
                                AND docs.base_relay_seq IS NULL
                                AND docs.base_relay_confirmed_absent=0
                                AND docs.lineage_claim_id IS NOT NULL
                                AND docs.base_origin_id IS NOT NULL
                                AND docs.base_origin_seq IS NOT NULL
                                AND NOT EXISTS (
                                    SELECT 1 FROM ydoc_base_relay_candidates AS candidate
                                     WHERE candidate.workspace_id=docs.workspace_id
                                       AND candidate.version_id=docs.version_id
                                       AND candidate.object_id=docs.object_id
                                )
                         )
                         SELECT coordinate.version_id,coordinate.object_id,
                                coordinate.lineage_claim_id,coordinate.origin_id,
                                coordinate.origin_seq,log.op_kind,log.payload_json,
                                log.recorded_at_ms
                           FROM coordinates AS coordinate
                           JOIN replication_log AS log
                             ON log.workspace_id=coordinate.workspace_id
                            AND log.origin_id=coordinate.origin_id
                            AND log.origin_seq=coordinate.origin_seq
                            AND log.apply_disposition='applied'
                          ORDER BY coordinate.version_id,coordinate.object_id,
                                   coordinate.origin_id,coordinate.origin_seq",
                    )
                    .map_err(SyncError::corrupt)?;
                let rows = statement
                    .query_map([workspace_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, i64>(7)?,
                        ))
                    })
                    .map_err(SyncError::corrupt)?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(SyncError::corrupt)
            })
            .map_err(local)?;

        let mut repairs = Vec::with_capacity(rows.len());
        for (
            version_id,
            object_id,
            lineage_claim_id,
            origin_id,
            origin_seq,
            op_kind,
            payload_json,
            recorded_at_ms,
        ) in rows
        {
            let key =
                dohc_engine_collab::DocKey::new(workspace_id.to_owned(), version_id, object_id)
                    .map_err(|error| local(SyncError::corrupt(error)))?;
            let payload = serde_json::from_str(&payload_json)
                .map_err(|error| local(SyncError::corrupt(error)))?;
            if op_kind != "ydoc.update"
                || !crate::ydoc_apply::is_exact_repairable_ydoc_base_claim(
                    &payload,
                    &key,
                    &lineage_claim_id,
                )
            {
                continue;
            }
            repairs.push(PendingBaseRelayRepair {
                key,
                lineage_claim_id,
                origin_id,
                origin_seq,
                op_kind,
                payload,
                recorded_at_ms,
            });
        }

        let deferred = store
            .read_with(|conn| {
                let mut statement = conn
                    .prepare(
                        "SELECT deferred.origin_id,deferred.origin_seq,log.op_kind,
                                log.payload_json,log.recorded_at_ms
                           FROM ydoc_deferred_updates AS deferred
                           JOIN replication_log AS log
                             ON log.workspace_id=deferred.workspace_id
                            AND log.origin_id=deferred.origin_id
                            AND log.origin_seq=deferred.origin_seq
                          WHERE deferred.workspace_id=?1
                            AND deferred.relay_seq IS NULL
                            AND log.op_kind='ydoc.update'
                          ORDER BY deferred.origin_id,deferred.origin_seq",
                    )
                    .map_err(SyncError::corrupt)?;
                let rows = statement
                    .query_map([workspace_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?,
                        ))
                    })
                    .map_err(SyncError::corrupt)?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(SyncError::corrupt)
            })
            .map_err(local)?;
        if repairs.is_empty() && deferred.is_empty() {
            return Ok(());
        }
        let needs_confirmation = repairs.iter().any(|repair| {
            repair.origin_id == identity.origin_id && repair.origin_seq > local_pushed_seq
        }) || deferred.iter().any(|(origin_id, origin_seq, ..)| {
            origin_id == &identity.origin_id && *origin_seq > local_pushed_seq
        });
        let relay_origin_max = if needs_confirmation && !passive {
            let hosted = store
                .read_with(|conn| crate::hosted::is_hosted(conn, workspace_id))
                .map_err(local)?;
            // Empty pushes ignore the cursor; keep the request stable across deferred-I/O replay.
            let probe = self.push_log(
                hosted,
                push_probe_request(workspace_id, identity, &identity.origin_id, -1),
            )?;
            validate_probe_response(&probe)?;
            probe.current_max_origin_seq
        } else {
            local_pushed_seq
        };
        // A same-device push during reruns can make this maximum stale, as between main's lookup and push.
        // Today's callers push before pulling.
        let own_relay_bound = local_pushed_seq.max(relay_origin_max);
        let mut page_coordinates = BTreeMap::new();
        for op in page {
            // Validated pages are in relay order; repeated coordinates keep their minimum.
            page_coordinates
                .entry((op.origin_id.as_str(), op.origin_seq))
                .or_insert(op);
        }
        let deferred = deferred
            .into_iter()
            .map(
                |(origin_id, origin_seq, op_kind, payload_json, recorded_at_ms)| {
                    Ok(PendingDeferredRelayRepair {
                        origin_id,
                        origin_seq,
                        op_kind,
                        payload: serde_json::from_str(&payload_json)
                            .map_err(|error| local(SyncError::corrupt(error)))?,
                        recorded_at_ms,
                    })
                },
            )
            .collect::<Result<Vec<_>, RelayError>>()?;
        let mut groups: BTreeMap<BaseRelayRepairKey, Vec<PendingBaseRelayRepair>> = BTreeMap::new();
        for repair in repairs {
            groups
                .entry((
                    repair.key.version_id.clone(),
                    repair.key.object_id.clone(),
                    repair.lineage_claim_id.clone(),
                ))
                .or_default()
                .push(repair);
        }
        let mut chunks = Vec::new();
        let mut chunk = BaseRelayRepairChunk::default();
        for group in groups.into_values() {
            if chunk.len() > 0 && chunk.len() + group.len() > MAX_BASE_REPAIR_LOOKUPS {
                chunks.push(std::mem::take(&mut chunk));
            }
            chunk.repairs.extend(group);
            if chunk.len() >= MAX_BASE_REPAIR_LOOKUPS {
                chunks.push(std::mem::take(&mut chunk));
            }
        }
        for repair in deferred {
            if chunk.len() >= MAX_BASE_REPAIR_LOOKUPS {
                chunks.push(std::mem::take(&mut chunk));
            }
            chunk.deferred.push(repair);
        }
        if chunk.len() > 0 {
            chunks.push(chunk);
        }

        for BaseRelayRepairChunk { repairs, deferred } in chunks {
            let mut coordinates = BTreeSet::new();
            coordinates.extend(
                repairs
                    .iter()
                    .map(|repair| (repair.origin_id.clone(), repair.origin_seq)),
            );
            coordinates.extend(
                deferred
                    .iter()
                    .map(|repair| (repair.origin_id.clone(), repair.origin_seq)),
            );
            let requests = coordinates
                .into_iter()
                .filter(|(origin, seq)| {
                    !(page_coordinates.contains_key(&(origin.as_str(), *seq))
                        || !passive && origin == &identity.origin_id && *seq > own_relay_bound)
                })
                .map(|(origin_id, origin_seq)| LogCoordinateRequest {
                    workspace_id: workspace_id.to_owned(),
                    replication_epoch: identity.replication_epoch.clone(),
                    stream_identity: identity.stream_identity.clone(),
                    origin_id,
                    origin_seq,
                })
                .collect::<Vec<_>>();
            let mut responses = BTreeMap::new();
            // A group wider than one batch retains its answers across replay and commits whole.
            for requests in requests.chunks(MAX_BASE_REPAIR_LOOKUPS) {
                let answers = self.transport.lookup_log_coordinates(requests.to_vec())?;
                if answers.len() != requests.len() {
                    return Err(RelayError::InvalidResponse);
                }
                for (request, answer) in requests.iter().zip(answers) {
                    responses.insert((request.origin_id.clone(), request.origin_seq), answer);
                }
            }
            let lookup = |origin_id: &str, origin_seq: i64| {
                if let Some(op) = page_coordinates.get(&(origin_id, origin_seq)) {
                    Ok(LogCoordinateResponse::Present((*op).clone()))
                } else if !passive
                    && origin_id == identity.origin_id
                    && origin_seq > own_relay_bound
                {
                    Ok(LogCoordinateResponse::Absent)
                } else {
                    responses
                        .get(&(origin_id.to_owned(), origin_seq))
                        .cloned()
                        .ok_or(RelayError::InvalidResponse)
                }
            };
            let mut deferred_repairs = Vec::new();
            for repair in deferred {
                let response = lookup(&repair.origin_id, repair.origin_seq)?;
                let relay_seq = match response {
                    LogCoordinateResponse::Present(op)
                    | LogCoordinateResponse::PresentBelowEpochFloor(op) => {
                        if op.validate().is_err()
                            || op.workspace_id != workspace_id
                            || op.origin_id != repair.origin_id
                            || op.origin_seq != repair.origin_seq
                            || op.op_kind != repair.op_kind
                            || op.payload != repair.payload
                            || op.recorded_at_ms != repair.recorded_at_ms
                        {
                            return Err(RelayError::InvalidResponse);
                        }
                        Some(op.relay_seq.ok_or(RelayError::InvalidResponse)?)
                    }
                    LogCoordinateResponse::Absent
                        if repair.origin_id == identity.origin_id
                            && local_pushed_seq < repair.origin_seq
                            && !passive =>
                    {
                        None
                    }
                    LogCoordinateResponse::Absent => None,
                };
                if let Some(relay_seq) = relay_seq {
                    deferred_repairs.push((repair.origin_id, repair.origin_seq, relay_seq));
                }
            }
            let mut grouped: BTreeMap<BaseRelayRepairKey, Vec<BaseRelayRepairCandidate>> =
                BTreeMap::new();
            for repair in repairs {
                let response = lookup(&repair.origin_id, repair.origin_seq)?;
                let (relay_seq, unresolved_local_coordinate) = match response {
                    LogCoordinateResponse::Present(op)
                    | LogCoordinateResponse::PresentBelowEpochFloor(op) => {
                        if op.validate().is_err()
                            || op.workspace_id != workspace_id
                            || op.origin_id != repair.origin_id
                            || op.origin_seq != repair.origin_seq
                            || op.op_kind != repair.op_kind
                            || op.payload != repair.payload
                            || op.recorded_at_ms != repair.recorded_at_ms
                            || !crate::ydoc_apply::is_exact_repairable_ydoc_base_claim(
                                &op.payload,
                                &repair.key,
                                &repair.lineage_claim_id,
                            )
                        {
                            return Err(RelayError::InvalidResponse);
                        }
                        (
                            Some(op.relay_seq.ok_or(RelayError::InvalidResponse)?),
                            false,
                        )
                    }
                    LogCoordinateResponse::Absent
                        if repair.origin_id == identity.origin_id
                            && local_pushed_seq < repair.origin_seq
                            && !passive =>
                    {
                        (None, true)
                    }
                    LogCoordinateResponse::Absent => (None, false),
                };
                grouped
                    .entry((
                        repair.key.version_id.clone(),
                        repair.key.object_id.clone(),
                        repair.lineage_claim_id.clone(),
                    ))
                    .or_default()
                    .push((repair, relay_seq, unresolved_local_coordinate));
            }

            grouped.retain(|_, candidates| {
                candidates
                    .iter()
                    .any(|(_, relay_seq, _)| relay_seq.is_some())
                    || !candidates.iter().any(|(_, _, unresolved)| *unresolved)
            });
            if grouped.is_empty() && deferred_repairs.is_empty() {
                continue;
            }
            match store
                .write_with(faults, |tx| {
                    for candidates in grouped.into_values() {
                        let resolved = candidates
                            .iter()
                            .filter_map(|(repair, relay_seq, _)| {
                                relay_seq.map(|relay_seq| (repair, relay_seq))
                            })
                            .min_by_key(|(_, relay_seq)| *relay_seq);
                        let (chosen, relay_seq) = match resolved {
                            Some((repair, relay_seq)) => (repair, Some(relay_seq)),
                            None => (&candidates[0].0, None),
                        };
                        dohc_engine_collab::record_base_coordinate_in_tx(
                            tx,
                            dohc_engine_collab::BaseCoordinateRecord {
                                key: &chosen.key,
                                lineage_claim_id: &chosen.lineage_claim_id,
                                origin_id: &chosen.origin_id,
                                origin_seq: chosen.origin_seq,
                                relay_seq,
                                now_ms: chosen.recorded_at_ms,
                            },
                        )
                        .map_err(base_repair_collab_error)?;
                        if relay_seq.is_none() {
                            dohc_engine_collab::mark_base_coordinate_absent_in_tx(
                                tx,
                                &chosen.key,
                                &chosen.lineage_claim_id,
                                &chosen.origin_id,
                                chosen.origin_seq,
                                chosen.recorded_at_ms,
                            )
                            .map_err(base_repair_collab_error)?;
                        }
                        tx.execute(
                            "DELETE FROM ydoc_base_relay_candidates
                    WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                            params![
                                chosen.key.workspace_id,
                                chosen.key.version_id,
                                chosen.key.object_id
                            ],
                        )
                        .map_err(SyncError::persist)?;
                    }
                    for (origin_id, origin_seq, relay_seq) in deferred_repairs {
                        let changed = tx
                            .execute(
                                "UPDATE ydoc_deferred_updates SET relay_seq=?4
                    WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 AND relay_seq IS NULL",
                                params![workspace_id, origin_id, origin_seq, relay_seq],
                            )
                            .map_err(SyncError::persist)?;
                        if changed != 1 {
                            return Err(SyncError::CoordinateDiverged);
                        }
                    }
                    Ok(())
                })
                .map_err(local)?
            {
                TxnOutcome::Committed(()) => {}
                TxnOutcome::Crashed { .. } => return Err(local(SyncError::FaultCrash)),
            }
        }
        Ok(())
    }

    pub fn push_workspace(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        faults: &dyn FaultInjector,
        leases: &dyn crate::LeaseProbe,
        now_ms: i64,
        max_read_bytes: usize,
    ) -> Result<SyncPassOutcome, RelayError> {
        self.resume_push_workspace(
            store,
            workspace_id,
            faults,
            leases,
            now_ms,
            max_read_bytes,
            &mut PushWorkspaceProgress::default(),
        )
    }

    /// Resume the same request after a deferred transport completion.
    #[allow(clippy::too_many_arguments)]
    pub fn resume_push_workspace(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        faults: &dyn FaultInjector,
        leases: &dyn crate::LeaseProbe,
        now_ms: i64,
        max_read_bytes: usize,
        progress: &mut PushWorkspaceProgress,
    ) -> Result<SyncPassOutcome, RelayError> {
        if store.is_passive() {
            return Err(local(SyncError::InvalidInput {
                reason: "passive store cannot write to the relay",
            }));
        }
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::IdentityRequired)?;
        let claim_state: Option<String> = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT claim_state FROM sync_identity WHERE workspace_id=?1",
                    [workspace_id],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)
            })
            .map_err(local)?;
        if let Some(state) = claim_state {
            if state == "pending" {
                return Err(RelayError::IdentityRequired);
            }
            let (_, refusal) = CLAIM_REFUSALS
                .iter()
                .find(|(code, _)| *code == state)
                .ok_or(RelayError::InvalidResponse)?;
            return Err(RelayError::ClaimRefused(Box::new(refusal.clone())));
        }
        if !progress
            .confirmed_identity
            .as_ref()
            .is_some_and(|confirmed| {
                confirmed.workspace_id == identity.workspace_id
                    && confirmed.replication_epoch == identity.replication_epoch
                    && confirmed.stream_identity == identity.stream_identity
            })
        {
            progress.confirmed_blobs.clear();
            progress.confirmed_identity = Some(identity.clone());
        }
        // A hosted replica holds the owner's documents, not its own: it
        // enrolls nothing and only sends what its live sessions journal.
        let hosted = store
            .read_with(|conn| crate::hosted::is_hosted(conn, workspace_id))
            .map_err(local)?;
        let mut sharing_declined = Vec::new();
        if !hosted {
            sharing_declined = crate::live_audit::enrollment::prepare_exports(
                store,
                workspace_id,
                faults,
                leases,
                now_ms,
                &mut progress.writer_cache_reset_required,
            )
            .map_err(local)?;
            select_file_versions(
                &mut progress.file_versions_selected,
                store,
                workspace_id,
                faults,
            )?;
        }
        let mut origins = list_workspace_origins(store, workspace_id).map_err(local)?;
        let mut pushed = 0_usize;
        let mut owner_admission_pending = Vec::new();
        let mut publication_refusals = Vec::new();
        let mut resume_needed = false;

        let has_position = store
            .read_with(|conn| has_relay_position(conn, workspace_id))
            .map_err(local)?;
        // The first pushed cursor can backfill and claim local bases. A hosted
        // replica already replicates, so its pushes never backfill.
        progress.writer_cache_reset_required |= !has_position && !hosted;
        let mut enrollment_prepared = has_position || hosted;
        if origins.is_empty() && !enrollment_prepared {
            let response = self.transport.push(push_probe_request(
                workspace_id,
                &identity,
                &identity.origin_id,
                -1,
            ))?;
            validate_probe_response(&response)?;
            if response.current_max_origin_seq != -1 {
                return Err(RelayError::OriginDiverged);
            }
            match write_pushed_seq(
                store,
                workspace_id,
                &identity.origin_id,
                response.current_max_origin_seq,
                faults,
                leases,
                now_ms,
            )
            .map_err(local)?
            {
                TxnOutcome::Committed(declined) => sharing_declined.extend(declined),
                TxnOutcome::Crashed { .. } => {
                    return Ok(SyncPassOutcome::CrashedAfterRemoteCommit);
                }
            }
            sharing_declined.extend(
                crate::live_audit::enrollment::prepare_exports(
                    store,
                    workspace_id,
                    faults,
                    leases,
                    now_ms,
                    &mut progress.writer_cache_reset_required,
                )
                .map_err(local)?,
            );
            enrollment_prepared = true;
            select_file_versions(
                &mut progress.file_versions_selected,
                store,
                workspace_id,
                faults,
            )?;
            // Re-read so the probe's backfill enters the push loop.
            origins = list_workspace_origins(store, workspace_id).map_err(local)?;
        }

        let mut seen_origins: BTreeSet<_> = origins.iter().cloned().collect();
        // Consume an in-flight append before considering newly queued origins.
        if let Some(page) = &progress.page
            && let Some(index) = origins.iter().position(|origin| origin == &page.origin_id)
        {
            origins.swap(0, index);
        }
        let mut origins: VecDeque<_> = origins.into();
        'origins: while let Some(origin_id) = origins.pop_front() {
            let mut local_max =
                local_max_origin_seq(store, workspace_id, &origin_id).map_err(local)?;
            let mut cursor = read_pushed_seq(store, workspace_id, &origin_id).map_err(local)?;
            let mut attempt = 0_u8;

            loop {
                if progress.acknowledged >= MAX_PUSH_OPS_PER_PASS
                    || (progress.acknowledged > 0
                        && progress.started.elapsed() >= PUSH_PRE_APPEND_BUDGET)
                {
                    resume_needed |= cursor < local_max || !origins.is_empty();
                    break 'origins;
                }
                let revision = store
                    .read_with(|conn| Ok::<_, SyncError>(conn.total_changes()))
                    .map_err(local)?;
                // An in-flight append can consume its original response after
                // local edits, but never under a different workspace identity.
                let previous = progress.page.as_ref().filter(|page| {
                    page.identity == identity
                        && page.origin_id == origin_id
                        && page.cursor == cursor
                });
                let cached = previous
                    .is_some_and(|page| page.sending.is_some() || page.revision == revision);
                if !cached {
                    // Reprove the original bounded page after every write. New
                    // appends enter the next page, after this one is acknowledged.
                    let limit = previous
                        .map_or(MAX_PUSH_OPS_PER_PASS - progress.acknowledged, |page| {
                            page.ops.len()
                        });
                    let mut ops =
                        list_replication_ops(store, workspace_id, &origin_id, cursor, limit)
                            .map_err(local)?;
                    if ops.is_empty() {
                        break;
                    }
                    match crate::outbound::repair_queued_moment_authors(
                        store,
                        &mut ops,
                        faults,
                        self.transport.publishes_native_settlements(),
                    )
                    .map_err(local)?
                    {
                        TxnOutcome::Committed(()) => {}
                        TxnOutcome::Crashed { .. } => return Err(local(SyncError::FaultCrash)),
                    }
                    let prefix =
                        crate::owner_publication_prefix(store, workspace_id, &ops, max_read_bytes)
                            .map_err(local)?;
                    let revision = store
                        .read_with(|conn| Ok::<_, SyncError>(conn.total_changes()))
                        .map_err(local)?;
                    let blob_refs = collect_blob_refs(&ops[..prefix.allowed_ops])?;
                    let retained =
                        previous.is_some_and(|page| page.ops == ops && page.prefix == prefix);
                    let mut page = PreparedPushPage {
                        identity: identity.clone(),
                        origin_id: origin_id.clone(),
                        cursor,
                        revision,
                        blob_refs,
                        inventory: VecDeque::new(),
                        ops,
                        prefix,
                        missing: BTreeSet::new(),
                        uploaded_ops: 0,
                        sending: None,
                    };
                    if retained && let Some(previous) = progress.page.take() {
                        page.missing = previous.missing;
                        page.inventory = previous.inventory;
                        page.uploaded_ops = previous.uploaded_ops;
                    } else {
                        page.inventory = page
                            .blob_refs
                            .keys()
                            .filter(|sha| !progress.confirmed_blobs.contains(*sha))
                            .cloned()
                            .collect::<Vec<_>>()
                            .chunks(crate::MAX_BLOB_HAVE_BATCH)
                            .map(<[String]>::to_vec)
                            .collect();
                    }
                    progress.page = Some(page);
                }
                let page = progress.page.as_mut().ok_or(RelayError::InvalidResponse)?;
                let count = match page.sending {
                    Some(count) => count,
                    None => self.upload_push_prefix(
                        store,
                        workspace_id,
                        &identity,
                        page,
                        progress.started,
                        &mut progress.confirmed_blobs,
                    )?,
                };
                page.sending = Some(count);
                let prefix = &page.prefix;
                let blocked = prefix.pending.is_some() || prefix.budget_exhausted;
                let ops = &page.ops[..count];
                if let Some(pending) = &prefix.pending {
                    owner_admission_pending.push(pending.clone());
                }
                if ops.is_empty() {
                    break;
                }
                let mut conflict = false;
                let mut batch_start = 0;
                while batch_start < ops.len() {
                    let batch =
                        &ops[batch_start..(batch_start + progress.batch_size).min(ops.len())];
                    let response = match self.push_log(
                        hosted,
                        PushRequest {
                            workspace_id: workspace_id.to_owned(),
                            replication_epoch: identity.replication_epoch.clone(),
                            stream_identity: identity.stream_identity.clone(),
                            origin_id: origin_id.clone(),
                            after_seq: cursor,
                            ops: batch.to_vec(),
                        },
                    ) {
                        Ok(response) => response,
                        Err(RelayError::SettlementProofBudget) if batch.len() > 1 => {
                            progress.batch_size = (batch.len() / 2).max(1);
                            continue;
                        }
                        Err(RelayError::Conflict) if attempt == 0 => {
                            conflict = true;
                            break;
                        }
                        Err(error) => return Err(error),
                    };
                    validate_push_response(&response, batch, local_max, hosted)?;
                    if response.current_max_origin_seq > local_max {
                        return Err(RelayError::OriginDiverged);
                    }
                    if crashes(faults, FaultPoint::SyncAfterPushBeforeCursorPersist) {
                        return Ok(SyncPassOutcome::CrashedAfterRemoteCommit);
                    }
                    if !response.redundant_recoveries.is_empty()
                        && let TxnOutcome::Crashed { .. } =
                            crate::ydoc_recovery::record_redundant_publication(
                                store,
                                workspace_id,
                                &response.redundant_recoveries,
                                faults,
                            )
                            .map_err(local)?
                    {
                        return Ok(SyncPassOutcome::CrashedAfterRemoteCommit);
                    }
                    match crate::cursor::write_pushed_seq_with_refusals(
                        store,
                        workspace_id,
                        &origin_id,
                        response.current_max_origin_seq,
                        &response.settlement_refusals,
                        &response.hosted_refusals,
                        batch,
                        faults,
                        leases,
                        now_ms,
                    )
                    .map_err(local)?
                    {
                        TxnOutcome::Committed(declined) => sharing_declined.extend(declined),
                        TxnOutcome::Crashed { .. } => {
                            return Ok(SyncPassOutcome::CrashedAfterRemoteCommit);
                        }
                    }
                    publication_refusals.extend(response.settlement_refusals.iter().map(
                        |refusal| crate::ReplicationRefusal {
                            workspace_id: workspace_id.to_owned(),
                            origin_id: refusal.origin_id.clone(),
                            origin_seq: refusal.origin_seq,
                            op_kind: "moment.append".into(),
                            reason: crate::RefusalReason::InvalidInput {
                                reason: crate::settlement_publication::REFUSAL_MESSAGE.to_owned(),
                            },
                        },
                    ));
                    publication_refusals.extend(
                        response
                            .hosted_refusals
                            .iter()
                            .map(|refusal| crate::hosted::push_refusal(workspace_id, refusal)),
                    );
                    if !enrollment_prepared {
                        sharing_declined.extend(
                            crate::live_audit::enrollment::prepare_exports(
                                store,
                                workspace_id,
                                faults,
                                leases,
                                now_ms,
                                &mut progress.writer_cache_reset_required,
                            )
                            .map_err(local)?,
                        );
                        enrollment_prepared = true;
                        select_file_versions(
                            &mut progress.file_versions_selected,
                            store,
                            workspace_id,
                            faults,
                        )?;
                        for added in list_workspace_origins(store, workspace_id).map_err(local)? {
                            if seen_origins.insert(added.clone()) {
                                origins.push_back(added);
                            }
                        }
                    }
                    local_max =
                        local_max_origin_seq(store, workspace_id, &origin_id).map_err(local)?;
                    pushed = pushed
                        .checked_add(response.inserted)
                        .ok_or(RelayError::InvalidResponse)?;
                    cursor = response.current_max_origin_seq;
                    progress.acknowledged += batch.len();
                    batch_start += batch.len();
                }
                if !conflict {
                    resume_needed |= count < prefix.allowed_ops || prefix.budget_exhausted;
                    progress.page = None;
                    if blocked {
                        break;
                    }
                    continue;
                }

                let probe = self.push_log(
                    hosted,
                    push_probe_request(workspace_id, &identity, &origin_id, cursor),
                )?;
                validate_probe_response(&probe)?;
                if probe.current_max_origin_seq > local_max
                    || probe.current_max_origin_seq >= cursor
                {
                    return Err(RelayError::OriginDiverged);
                }
                match rewind_pushed_seq(
                    store,
                    workspace_id,
                    &origin_id,
                    probe.current_max_origin_seq,
                    faults,
                )
                .map_err(local)?
                {
                    TxnOutcome::Committed(()) => {}
                    TxnOutcome::Crashed { .. } => {
                        return Ok(SyncPassOutcome::CrashedAfterRemoteCommit);
                    }
                }
                cursor = probe.current_max_origin_seq;
                progress.page = None;
                attempt = attempt.saturating_add(1);
            }
        }

        Ok(SyncPassOutcome::Complete {
            owner_admission_pending,
            pushed,
            fetched: 0,
            has_more: resume_needed
                || store
                    .read_with(|conn| {
                        crate::live_audit::enrollment::pending_in_tx(conn, workspace_id)
                    })
                    .map_err(local)?,
            applied: 0,
            refused: publication_refusals.len(),
            skipped: 0,
            conflicts_opened: 0,
            pending_cursor: None,
            changed_paths: Vec::new(),
            refusals: publication_refusals,
            record_facts: Vec::new(),
            sharing_declined,
        })
    }

    /// Pull and apply replicated operations. The returned cursor remains
    /// pending until the caller completes disk materialization and commits it.
    pub fn pull_chat_workspace(
        &self,
        store: &mut EngineStore,
        cache: &mut dohc_engine_collab::WriterDocCache,
        workspace_id: &str,
        faults: &dyn FaultInjector,
        leases: &dyn crate::LeaseProbe,
        now_ms: i64,
    ) -> Result<SyncPassOutcome, RelayError> {
        let (fetch, progress) = match self.continuation.take(workspace_id) {
            Some((Fetched::Ordinary(fetch), progress)) => (fetch, progress),
            _ => self.fetch_ordinary(store, workspace_id, faults)?,
        };
        let pass = match self.apply_pulled(
            store,
            cache,
            workspace_id,
            &fetch.identity,
            &fetch.queued,
            &fetch.ordered,
            progress,
            None,
            faults,
            leases,
        )? {
            Applying::Done(pass) => *pass,
            Applying::Suspended(pending, progress) => {
                self.continuation
                    .keep(workspace_id, Fetched::Ordinary(fetch), *progress);
                return Err(RelayError::ValidationPending(pending));
            }
        };
        let OrdinaryFetch {
            identity,
            ordered,
            cursor,
            fetched,
            has_more,
            bootstrap_complete,
            pull_token,
            ..
        } = *fetch;
        let AppliedPass {
            applied,
            refused,
            skipped,
            conflicts_opened,
            changed_paths,
            refusals,
            mut sharing_declined,
            record_facts,
            settlement_report_id,
            has_more: settled_more,
            stopped: _,
            // Only a hosted pass has documents that are not ready, or holds
            // one for released retained work.
            redelivered: _,
            released: _,
            drain_holds: _,
        } = pass;
        let has_more = has_more || settled_more;

        let mut pulled_foreign_max = BTreeMap::<String, i64>::new();
        for op in &ordered {
            if op.origin_id != identity.origin_id {
                pulled_foreign_max
                    .entry(op.origin_id.clone())
                    .and_modify(|seq| *seq = (*seq).max(op.origin_seq))
                    .or_insert(op.origin_seq);
            }
        }
        for (origin_id, max_seq) in pulled_foreign_max {
            if max_seq > read_pushed_seq(store, workspace_id, &origin_id).map_err(local)? {
                match write_pushed_seq(
                    store,
                    workspace_id,
                    &origin_id,
                    max_seq,
                    faults,
                    leases,
                    now_ms,
                )
                .map_err(local)?
                {
                    TxnOutcome::Committed(declined) => sharing_declined.extend(declined),
                    TxnOutcome::Crashed { .. } => {
                        return Err(RelayError::Local("injected-crash".to_owned()));
                    }
                }
            }
        }

        let pending_cursor = RelayCursor {
            cursor,
            bootstrap_complete: bootstrap_complete
                || (!has_more && !crate::deferred::has_unapplied(store, workspace_id)?),
            replication_epoch: identity.replication_epoch,
            stream_identity: identity.stream_identity,
            settlement_report_id,
            ordinary_pull: Some(crate::OrdinaryPullCompletion {
                token: pull_token,
                terminal: !has_more,
            }),
        };
        if crashes(faults, FaultPoint::SyncBetweenApplyAndCursorCommit) {
            return Ok(SyncPassOutcome::CrashedAfterApply {
                applied,
                refused,
                skipped,
                conflicts_opened,
                pending_cursor,
                changed_paths: page_order(changed_paths.into_values(), |change| change.operation),
                refusals,
                sharing_declined,
                record_facts,
            });
        }
        Ok(SyncPassOutcome::Complete {
            owner_admission_pending: Vec::new(),
            pushed: 0,
            fetched,
            has_more,
            applied,
            refused,
            skipped,
            conflicts_opened,
            pending_cursor: Some(pending_cursor),
            changed_paths: page_order(changed_paths.into_values(), |change| change.operation),
            refusals,
            sharing_declined,
            record_facts,
        })
    }

    /// What an ordinary pass fetches and reads before it applies, and where
    /// its apply starts.
    fn fetch_ordinary(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<(Box<OrdinaryFetch>, ApplyProgress), RelayError> {
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        if store
            .read_with(|conn| crate::hosted::is_hosted(conn, workspace_id))
            .map_err(local)?
        {
            return Err(RelayError::HostedRefusal(
                "a hosted replica pulls with pull_hosted_workspace",
            ));
        }
        let (queued, durable_origins) = crate::deferred::read(store, workspace_id, &identity)?;
        let current = crate::read_relay_cursor(store, workspace_id).map_err(local)?;
        if let Some(cursor) = &current {
            if cursor.replication_epoch != identity.replication_epoch
                || cursor.stream_identity != identity.stream_identity
            {
                return Err(RelayError::InvalidResponse);
            }
        }
        let bootstrap_complete = store
            .read_with(|conn| {
                crate::ydoc_origination::can_originate_local_bases_in_tx(conn, workspace_id)
            })
            .map_err(local)?;
        let mut cursor = current.map_or(0, |value| value.cursor);
        let mut fetched = 0_usize;
        let mut pages = 0_usize;
        let mut ops = Vec::new();
        let has_more = loop {
            let remaining = crate::model::MAX_PULL_OPS_PER_PASS
                .checked_sub(fetched)
                .ok_or(RelayError::InvalidResponse)?;
            let limit = remaining.min(crate::MAX_PULL_OPS);
            let response = self.transport.pull(PullRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                cursor,
                limit,
            })?;
            validate_pull_page(&response, workspace_id, cursor)?;
            if response.ops.len() > limit {
                return Err(RelayError::InvalidResponse);
            }
            fetched = fetched
                .checked_add(response.ops.len())
                .ok_or(RelayError::InvalidResponse)?;
            ops.extend(response.ops);
            cursor = response.next_cursor;
            let has_more = response.has_more;
            pages = pages.checked_add(1).ok_or(RelayError::InvalidResponse)?;
            if !has_more
                || fetched >= crate::model::MAX_PULL_OPS_PER_PASS
                || pages >= crate::model::MAX_PULL_PAGES_PER_PASS
            {
                break has_more;
            }
        };

        if !queued.is_empty() {
            crate::deferred::check_redelivery(store, &ops)?;
        }
        let fetched_coordinates: BTreeSet<_> = ops
            .iter()
            .map(|op| (op.origin_id.clone(), op.origin_seq))
            .collect();
        let fetched_op_count = ops.len();
        ops.extend(
            queued
                .iter()
                .filter(|op| !fetched_coordinates.contains(&(op.origin_id.clone(), op.origin_seq)))
                .cloned(),
        );
        preflight_collisions(store, workspace_id, &identity.origin_id, &ops)?;
        let pull_token =
            match crate::cursor::begin_ordinary_pull(store, &identity, faults).map_err(local)? {
                TxnOutcome::Committed(token) => token,
                TxnOutcome::Crashed { .. } => {
                    return Err(RelayError::Local("injected-crash".to_owned()));
                }
            };
        self.repair_pending_ydoc_base_orders(
            store,
            workspace_id,
            &identity,
            faults,
            &ops[..fetched_op_count],
        )?;
        self.hydrate_missing_blobs(store, workspace_id, &identity, &ops, faults)?;
        let ordered = merge_by_origin(ops);
        let progress = Self::begin_apply(ordered.len(), durable_origins, Holding::ByOrigin);
        Ok((
            Box::new(OrdinaryFetch {
                identity,
                queued,
                ordered,
                cursor,
                fetched,
                has_more,
                bootstrap_complete,
                pull_token,
            }),
            progress,
        ))
    }

    /// Confirm the relay holds nothing of this hosted replica's own origin
    /// past what the replica numbered. A store restored from an older copy
    /// lost commits it already pushed. The counter is the only local record of
    /// them: a pull imports the host's own rows back into the journal, so the
    /// journal's maximum rises to the relay's. Sends one empty push to the
    /// hosted log and writes nothing.
    pub fn confirm_hosted_origin(
        &self,
        store: &EngineStore,
        workspace_id: &str,
    ) -> Result<(), RelayError> {
        let numbered = store
            .read_with(|conn| crate::hosted::last_outbound_seq(conn, workspace_id))
            .map_err(local)?
            .ok_or(RelayError::HostedRefusal(
                crate::hosted::NOT_A_HOSTED_REPLICA,
            ))?;
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let probe = self.transport.push_hosted(push_probe_request(
            workspace_id,
            &identity,
            &identity.origin_id,
            -1,
        ))?;
        validate_probe_response(&probe)?;
        if probe.current_max_origin_seq > numbered {
            return Err(RelayError::OriginDiverged);
        }
        Ok(())
    }

    /// Pull one hosted pass: the first document still backfilling reads its
    /// own rows from its backfill cursor, and only when none is left does the
    /// main feed move, skipping the rows of every document that is not ready.
    /// Each held document then reads one page of its own rows from its
    /// cursor, so a row that could not apply before is tried again. A
    /// response under a new scope applies nothing; the pass adopts the scope
    /// and returns no cursor. The returned cursor stays pending until the
    /// caller materializes the pass and commits it. `relay_namespace` is the
    /// feed's, as the host's trusted configuration names it: a hosted pass
    /// never runs without one.
    pub fn pull_hosted_workspace(
        &self,
        store: &mut EngineStore,
        cache: &mut dohc_engine_collab::WriterDocCache,
        workspace_id: &str,
        relay_namespace: &str,
        faults: &dyn FaultInjector,
        leases: &dyn crate::LeaseProbe,
    ) -> Result<HostedPassOutcome, RelayError> {
        let (fetch, progress) = match self.continuation.take(workspace_id) {
            Some((Fetched::Hosted(fetch), progress)) => (fetch, progress),
            _ => match self.fetch_hosted(store, workspace_id, faults)? {
                Some(fetched) => fetched,
                // A pass under a new scope adopts it and applies nothing.
                None => {
                    return Ok(HostedPassOutcome {
                        has_more: true,
                        ..HostedPassOutcome::default()
                    });
                }
            },
        };
        let pass = match self.apply_pulled(
            store,
            cache,
            workspace_id,
            &fetch.identity,
            &fetch.queued,
            &fetch.ordered,
            progress,
            Some(relay_namespace),
            faults,
            leases,
        )? {
            Applying::Done(pass) => *pass,
            Applying::Suspended(pending, progress) => {
                self.continuation
                    .keep(workspace_id, Fetched::Hosted(fetch), *progress);
                return Err(RelayError::ValidationPending(pending));
            }
        };
        let HostedFetch {
            replica,
            backfill,
            mut reads,
            has_more,
            fetched,
            cursor,
            ..
        } = *fetch;
        // A ready document that stopped at a conflict child whose parent the
        // feed withholds, at a move onto another spelling of a path another
        // document holds, or at work past the retention limit, is held from
        // there and reads its own rows.
        for (object_id, op) in &pass.stopped {
            if replica
                .documents
                .get(object_id)
                .is_some_and(|document| document.status == crate::HostedDocumentStatus::Ready)
            {
                let at = op.relay_seq.map_or(0, |seq| seq.saturating_sub(1));
                reads.insert(object_id.clone(), (at, true));
            }
        }
        self.settle_hosted_reads(
            store,
            workspace_id,
            &replica,
            backfill.is_some(),
            reads,
            has_more,
            fetched,
            cursor,
            pass,
        )
    }

    /// What a hosted pass fetches and reads before it applies, and where its
    /// apply starts; `None` once a response under a new scope was adopted
    /// instead.
    fn fetch_hosted(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<Option<(Box<HostedFetch>, ApplyProgress)>, RelayError> {
        let replica = crate::read_hosted_replica(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::HostedRefusal(
                crate::hosted::NOT_A_HOSTED_REPLICA,
            ))?;
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let backfill = replica
            .documents
            .iter()
            .find(|(_, document)| document.status == crate::HostedDocumentStatus::Backfilling)
            .map(|(object_id, document)| (object_id.clone(), document.backfill_cursor));
        let held = replica
            .documents
            .iter()
            .filter(|(_, document)| matches!(document.status, crate::HostedDocumentStatus::Held(_)))
            .map(|(object_id, document)| (object_id.clone(), document.backfill_cursor))
            .collect::<Vec<_>>();
        let unready: BTreeSet<String> = replica
            .documents
            .iter()
            .filter(|(_, document)| document.status != crate::HostedDocumentStatus::Ready)
            .map(|(object_id, _)| object_id.clone())
            .collect();
        let backfilled = backfill.as_ref().map(|(object_id, _)| object_id.as_str());
        let mut ops = Vec::new();
        let mut cursor = backfill
            .as_ref()
            .map_or(replica.main_cursor, |(_, cursor)| *cursor);
        let mut fetched = 0_usize;
        let mut pages = 0_usize;
        let has_more = loop {
            let remaining = crate::model::MAX_PULL_OPS_PER_PASS
                .checked_sub(fetched)
                .ok_or(RelayError::InvalidResponse)?;
            let limit = remaining.min(crate::MAX_PULL_OPS);
            let Some(response) = self.hosted_page(
                store,
                workspace_id,
                &identity,
                &replica,
                backfilled,
                cursor,
                limit,
                faults,
            )?
            else {
                // What earlier pages fetched under the old scope is dropped
                // too: it cannot commit.
                return Ok(None);
            };
            fetched = fetched
                .checked_add(response.ops.len())
                .ok_or(RelayError::InvalidResponse)?;
            ops.extend(response.ops);
            cursor = response.next_cursor;
            let has_more = response.has_more;
            pages = pages.checked_add(1).ok_or(RelayError::InvalidResponse)?;
            if !has_more
                || fetched >= crate::model::MAX_PULL_OPS_PER_PASS
                || pages >= crate::model::MAX_PULL_PAGES_PER_PASS
            {
                break has_more;
            }
        };
        let mut reads = BTreeMap::new();
        match &backfill {
            Some((object_id, _)) => {
                reads.insert(object_id.clone(), (cursor, has_more));
            }
            // A held document's own read covers these rows. It reads after
            // the main feed, and its document is not ready until that read
            // reaches the end of its rows.
            None => ops.retain(|op| {
                crate::hosted::hosted_document(op).is_none_or(|id| !unready.contains(id))
            }),
        }
        // Held reads share what the pass has left. A stopped document needs
        // only the row it stopped at, and a read cut short goes on next pass.
        let per_held = (crate::model::MAX_PULL_OPS_PER_PASS.saturating_sub(fetched)
            / held.len().max(1))
        .clamp(1, crate::MAX_PULL_OPS);
        for (object_id, from) in &held {
            let Some(response) = self.hosted_page(
                store,
                workspace_id,
                &identity,
                &replica,
                Some(object_id),
                *from,
                per_held,
                faults,
            )?
            else {
                return Ok(None);
            };
            fetched = fetched
                .checked_add(response.ops.len())
                .ok_or(RelayError::InvalidResponse)?;
            ops.extend(response.ops);
            reads.insert(object_id.clone(), (response.next_cursor, response.has_more));
        }
        // A returning document's heads come back before its rows route, so
        // the rows it applied skip as redelivered against them.
        crate::hosted::unpark_returned(store, workspace_id, faults).map_err(local)?;

        // Every document with retained work may retain more behind it; one
        // whose retained work runs past this replay holds from where it stops.
        let replay = crate::deferred::read_hosted(store, workspace_id, &identity)?;
        let queued = replay.ops;
        let durable = replay.documents.keys().cloned().collect();
        let behind = replay
            .documents
            .into_iter()
            .filter_map(|(object_id, from)| Some((object_id, from?)))
            .collect();
        if !queued.is_empty() {
            crate::deferred::check_redelivery(store, &ops)?;
        }
        let fetched_coordinates: BTreeSet<_> = ops
            .iter()
            .map(|op| (op.origin_id.clone(), op.origin_seq))
            .collect();
        let fetched_op_count = ops.len();
        ops.extend(
            queued
                .iter()
                .filter(|op| !fetched_coordinates.contains(&(op.origin_id.clone(), op.origin_seq)))
                .cloned(),
        );
        preflight_collisions(store, workspace_id, &identity.origin_id, &ops)?;
        self.repair_pending_ydoc_base_orders(
            store,
            workspace_id,
            &identity,
            faults,
            &ops[..fetched_op_count],
        )?;
        self.hydrate_missing_blobs(store, workspace_id, &identity, &ops, faults)?;
        // Relay order is each document's order, across origins.
        ops.sort_by_key(|op| op.relay_seq);
        let progress =
            Self::begin_apply(ops.len(), durable, Holding::ByDocument { behind, unready });
        Ok(Some((
            Box::new(HostedFetch {
                replica,
                identity,
                backfill,
                reads,
                has_more,
                fetched,
                cursor,
                queued,
                ordered: ops,
            }),
            progress,
        )))
    }

    /// Settle each document a hosted pass read: where its read stops, what
    /// holds it, and the heads a pass whose commit can make it ready writes.
    #[allow(clippy::too_many_arguments)]
    fn settle_hosted_reads(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        replica: &crate::HostedReplicaState,
        backfilled: bool,
        reads: BTreeMap<String, (i64, bool)>,
        has_more: bool,
        fetched: usize,
        cursor: i64,
        mut pass: AppliedPass,
    ) -> Result<HostedPassOutcome, RelayError> {
        // A read stops before its document's first row that did not apply;
        // nothing of it was retained, so its next read fetches it again.
        let redelivered = std::mem::take(&mut pass.redelivered);
        let (reads, held, held_paths, newly_held, unparks, standing, heads) = store
            .read_with(|conn| {
                // What holds each path, read once for every document.
                let mut occupancy = crate::hosted::Occupancy::new(conn, workspace_id);
                let mut held = BTreeMap::new();
                let mut held_paths = BTreeMap::new();
                let mut newly_held = BTreeSet::new();
                // Each held document's path, and whether this pass moved it
                // from ready, kept as it is held.
                let mut hold_at = |object_id: &String, document: &crate::HostedDocumentState| {
                    held_paths.insert(object_id.clone(), document.path.clone());
                    if document.status == crate::HostedDocumentStatus::Ready {
                        newly_held.insert(object_id.clone());
                    }
                };
                let mut settled = BTreeMap::new();
                // A document whose parked heads this pass freed the paths of
                // comes back on the next pass.
                let mut unparks = false;
                // What its history stored that still stands, checked once
                // per document against what the pass left holding its paths.
                let mut standing = Vec::new();
                for (object_id, stored) in redelivered {
                    standing.extend(crate::hosted::redelivered_unready(
                        &mut occupancy,
                        &object_id,
                        stored.into_values(),
                    )?);
                }
                // Readiness never precedes its files, so a pass whose commit
                // can make a document ready writes each of its heads.
                let mut heads = Vec::new();
                for (object_id, (cursor, more)) in reads {
                    unparks |= crate::hosted::unparks_next(&mut occupancy, &object_id)?;
                    let mut read = match pass.stopped.get(&object_id) {
                        Some(op) => crate::HostedRead {
                            // Commit refuses one below its document's read
                            // that is not explained by work it releases.
                            cursor: op
                                .relay_seq
                                .map_or(0, |seq| cursor.min(seq.saturating_sub(1))),
                            stopped: Some(match pass.released.get(&object_id) {
                                Some(((origin_id, origin_seq), binding))
                                    if (origin_id, *origin_seq)
                                        == (&op.origin_id, op.origin_seq) =>
                                {
                                    crate::HostedHold::ReleasedLineageUnsettled {
                                        binding: binding.clone(),
                                        continuation: crate::ReleasedHoldContinuation::Frozen,
                                        binding_stale: false,
                                    }
                                }
                                // A frozen drain hold stopped the read before
                                // this op; the hold stays what it was.
                                _ => match pass.drain_holds.get(&object_id) {
                                    Some(hold) => hold.clone(),
                                    None => {
                                        crate::hosted::stopped_hold(&mut occupancy, &object_id, op)?
                                    }
                                },
                            }),
                            complete: false,
                            heads_written: false,
                        },
                        // Its queued work a drain held stops it where its read is.
                        None => {
                            let held = pass.drain_holds.get(&object_id).cloned();
                            crate::HostedRead {
                                cursor,
                                complete: !more && held.is_none(),
                                stopped: held,
                                heads_written: false,
                            }
                        }
                    };
                    match read.hold(&mut occupancy, &object_id)? {
                        Some(hold) => {
                            let Some(document) = replica.documents.get(&object_id) else {
                                return Err(crate::error::local_corruption(
                                    "a hosted read has no document",
                                ));
                            };
                            hold_at(&object_id, document);
                            held.insert(object_id.clone(), hold);
                        }
                        None if read.complete => {
                            heads.extend(crate::hosted::head_writes(
                                conn,
                                workspace_id,
                                &object_id,
                            )?);
                            read.heads_written = true;
                        }
                        None => {}
                    }
                    settled.insert(object_id, read);
                }
                // A ready document that a refusal of this pass held is held
                // too. It reads its own rows from the next pass. One the
                // pass did not read that is held for released retained work
                // still is, so every pass names each such hold.
                for (object_id, document) in &replica.documents {
                    if settled.contains_key(object_id) {
                        continue;
                    }
                    let released = matches!(
                        document.status,
                        crate::HostedDocumentStatus::Held(
                            crate::HostedHold::ReleasedLineageUnsettled { .. }
                        )
                    );
                    if (released || document.status == crate::HostedDocumentStatus::Ready)
                        && let Some(hold) =
                            crate::hosted::recorded_hold(conn, workspace_id, object_id)?
                    {
                        hold_at(object_id, document);
                        held.insert(object_id.clone(), hold);
                    }
                }
                Ok::<_, SyncError>((
                    settled, held, held_paths, newly_held, unparks, standing, heads,
                ))
            })
            .map_err(local)?;
        for change in standing {
            pass.changed_paths
                .entry((change.version_id.clone(), change.path.clone()))
                .or_insert(change);
        }
        for change in heads {
            insert_changed_path(&mut pass.changed_paths, change);
        }
        // A finished backfill still leaves the main feed or another document,
        // and a held document whose read went on backfills again.
        let more = has_more
            || pass.has_more
            || unparks
            || backfilled
            || reads
                .values()
                .any(|read| read.stopped.is_none() && !read.complete);
        Ok(HostedPassOutcome {
            fetched,
            has_more: more,
            applied: pass.applied,
            refused: pass.refused,
            skipped: pass.skipped,
            conflicts_opened: pass.conflicts_opened,
            pending_cursor: Some(crate::HostedCursor {
                scope_generation: replica.scope_generation,
                cursor_commits: replica.cursor_commits,
                main_cursor: (!backfilled).then_some(cursor),
                reads,
                settlement_report_id: pass.settlement_report_id,
            }),
            changed_paths: page_order(pass.changed_paths.into_values(), |change| change.operation),
            refusals: pass.refusals,
            sharing_declined: pass.sharing_declined,
            record_facts: pass.record_facts,
            held,
            held_paths,
            newly_held,
        })
    }

    /// Commit a hosted pass's cursor after its work materialized. Commits
    /// nothing when the scope moved or another pass committed since its
    /// fetch, or a released-lineage hold's binding went stale.
    pub fn commit_hosted_cursor(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        cursor: &crate::HostedCursor,
        tails: &dohc_engine_collab::live_update_application::ReleasedTails,
        faults: &dyn FaultInjector,
    ) -> Result<TxnOutcome<crate::HostedCommit>, RelayError> {
        crate::commit_hosted_cursor(store, workspace_id, cursor, tails, faults).map_err(|error| {
            match error {
                SyncError::InvalidInput {
                    reason: reason @ crate::hosted::NOT_A_HOSTED_REPLICA,
                } => RelayError::HostedRefusal(reason),
                error => local(error),
            }
        })
    }

    /// One page of the hosted feed under the stored scope: `workspace.init`
    /// and scoped documents' rows on the main feed, and only `backfilled`'s
    /// rows in its backfill. `None` when the response announced another
    /// scope, which is adopted instead: the feed serves nothing under a stale
    /// one.
    #[allow(clippy::too_many_arguments)]
    fn hosted_page(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        identity: &crate::SyncIdentity,
        replica: &crate::HostedReplicaState,
        backfilled: Option<&str>,
        cursor: i64,
        limit: usize,
        faults: &dyn FaultInjector,
    ) -> Result<Option<HostedPullResponse>, RelayError> {
        let response = self.transport.pull_hosted(HostedPullRequest {
            workspace_id: workspace_id.to_owned(),
            replication_epoch: identity.replication_epoch.clone(),
            stream_identity: identity.stream_identity.clone(),
            scope_token: replica.scope_token.clone(),
            object_id: backfilled.map(str::to_owned),
            cursor,
            limit,
        })?;
        validate_hosted_page(&response, workspace_id, cursor)?;
        if response.ops.len() > limit {
            return Err(RelayError::InvalidResponse);
        }
        let documents = hosted_scope_documents(&response.scope)?;
        if replica.scope_token.as_deref() != Some(response.scope.token.as_str()) {
            if !response.ops.is_empty() || response.next_cursor != cursor {
                return Err(RelayError::InvalidResponse);
            }
            match crate::hosted::adopt_scope(
                store,
                workspace_id,
                &response.scope.token,
                &documents,
                faults,
            )
            .map_err(local)?
            {
                TxnOutcome::Committed(()) => return Ok(None),
                TxnOutcome::Crashed { .. } => return Err(local(SyncError::FaultCrash)),
            }
        }
        // One token names one set of documents at their paths.
        if !documents.iter().eq(replica
            .documents
            .iter()
            .map(|(object_id, document)| (object_id, &document.path)))
        {
            return Err(RelayError::InvalidResponse);
        }
        for op in &response.ops {
            let admitted = match (crate::hosted::hosted_document(op), backfilled) {
                (Some(object_id), Some(backfilled)) => object_id == backfilled,
                (Some(object_id), None) => replica.documents.contains_key(object_id),
                (None, None) => op.op_kind == "workspace.init",
                (None, Some(_)) => false,
            };
            if !admitted {
                return Err(RelayError::InvalidResponse);
            }
        }
        Ok(Some(response))
    }

    /// Where a pass's apply starts: open documents' artifacts still to
    /// recover, and its `ops` ordered ops all still to apply.
    fn begin_apply(ops: usize, durable: BTreeSet<String>, holding: Holding) -> ApplyProgress {
        ApplyProgress {
            pass: AppliedPass::default(),
            recovering: true,
            completed: Vec::new(),
            round: (0..ops).collect(),
            next: 0,
            still_retryable: Vec::new(),
            retryable_refusals: Vec::new(),
            first: true,
            made_progress: false,
            held: holding.held_at_round(&durable),
            durable,
            holding,
            rounds_done: false,
            settlements: Default::default(),
            archived_protected: Vec::new(),
        }
    }

    /// Apply a pass's ops in order from where `progress` stands and settle
    /// what they left pending. An op that cannot apply yet holds the ops
    /// behind it; when a round makes no progress, work held for a durable
    /// reason is retained so the cursor can move past it, and any other hold
    /// fails the pass. An op that waits for released-tail validation stops
    /// the pass with nothing of it applied, keeping the progress to go on
    /// from, as does a ready owner settlement once the settlements before it
    /// commit. `relay_namespace` names the feed, when the pull's trusted
    /// configuration names one.
    #[allow(clippy::too_many_arguments)]
    fn apply_pulled(
        &self,
        store: &mut EngineStore,
        cache: &mut dohc_engine_collab::WriterDocCache,
        workspace_id: &str,
        identity: &crate::SyncIdentity,
        queued: &[ReplicationEnvelope],
        ordered: &[ReplicationEnvelope],
        mut progress: ApplyProgress,
        relay_namespace: Option<&str>,
        faults: &dyn FaultInjector,
        leases: &dyn crate::LeaseProbe,
    ) -> Result<Applying, RelayError> {
        let p = &mut progress;
        // Recovery that waits for validation leaves every drain's rows
        // queued and runs again after it, reporting them then. The rows one
        // that completes removes leave drain reports, so a later wait loses
        // none of what they committed.
        while p.recovering {
            let recovered =
                crate::moment_apply::open_artifacts::drain_open_document_artifacts_durably(
                    store,
                    cache,
                    workspace_id,
                    leases,
                    faults,
                )
                .map_err(local)?;
            for change in recovered.changes {
                insert_changed_path(&mut p.pass.changed_paths, change);
            }
            p.pass.record_facts.extend(recovered.record_facts);
            for refusal in recovered.refusals {
                push_refusal_once(&mut p.pass.refusals, refusal);
            }
            for declined in recovered.sharing_declined {
                push_sharing_declined_once(&mut p.pass.sharing_declined, declined);
            }
            p.pass.conflicts_opened += recovered.conflicts_opened;
            p.pass.replace_drain_holds(recovered.holds);
            match recovered.waiting {
                Some(pending) => return Ok(Applying::Suspended(pending, Box::new(progress))),
                None => p.recovering = false,
            }
        }
        while !p.rounds_done {
            while let Some(&index) = p.round.get(p.next) {
                match self.apply_one(
                    store,
                    cache,
                    workspace_id,
                    &ordered[index],
                    index,
                    p,
                    relay_namespace,
                    faults,
                    leases,
                ) {
                    Err(RelayError::ValidationPending(pending)) => {
                        return Ok(Applying::Suspended(pending, Box::new(progress)));
                    }
                    applied => applied?,
                }
                p.next += 1;
            }
            if p.still_retryable.is_empty() {
                p.rounds_done = true;
                break;
            }
            if !p.first && !p.made_progress {
                // Nothing left in the pass can free these, so a ready
                // document whose op can wait indefinitely stops here.
                for &(index, reason) in &p.retryable_refusals {
                    p.holding.stop_where_it_can_wait(&ordered[index], reason);
                }
                // A document that is not ready retains nothing: its read
                // stops at its first op still to apply, in relay order.
                let (stopped, retained): (Vec<_>, Vec<_>) = std::mem::take(&mut p.still_retryable)
                    .into_iter()
                    .map(|index| &ordered[index])
                    .partition(|op| p.holding.unready(op).is_some());
                for op in stopped {
                    if let Some(object_id) = p.holding.unready(op) {
                        p.pass
                            .stopped
                            .entry(object_id.to_owned())
                            .or_insert_with(|| op.clone());
                    }
                }
                if retained.iter().any(|op| {
                    !p.holding
                        .key(op)
                        .is_some_and(|key| p.durable.contains(&key))
                }) {
                    return Err(retryable_refusal(
                        p.retryable_refusals
                            .iter()
                            .map(|&(index, reason)| (&ordered[index], reason))
                            .filter(|(op, _)| {
                                p.holding.unready(op).is_none()
                                    && !p
                                        .holding
                                        .key(op)
                                        .is_some_and(|key| p.durable.contains(&key))
                            }),
                    ));
                }
                // A hosted document that would pass the retention limit is
                // held at its first op still to apply, as one that is not
                // ready, so the pass still commits and releases other work.
                let unretained =
                    crate::deferred::retain(store, identity, relay_namespace, &retained, faults)?;
                for op in retained {
                    if let Some(object_id) = crate::hosted::hosted_document(op)
                        .filter(|object_id| unretained.contains(*object_id))
                    {
                        p.pass
                            .stopped
                            .entry(object_id.to_owned())
                            .or_insert_with(|| op.clone());
                    }
                }
                p.rounds_done = true;
                break;
            }
            p.first = false;
            p.round = std::mem::take(&mut p.still_retryable);
            p.retryable_refusals.clear();
            p.next = 0;
            p.made_progress = false;
            p.held = p.holding.held_at_round(&p.durable);
        }
        // The inactive drain's refusals reach the pass as pending refusals,
        // and the facts of rows it removes that applied to a head before
        // their lineage was archived reach it as drain reports. A document whose
        // archived lineage released tails protect holds for it. Each lineage
        // is decided again here, and a hold the pass reported for one it
        // frees is cleared.
        let archived = match crate::ydoc_apply::drain_inactive_ydoc_updates(
            store,
            crate::ydoc_apply::InactiveScope::Workspace(workspace_id),
            &cache.released_tails(store),
            &mut Vec::new(),
            crate::ydoc_apply::DrainReporting::Durable,
            faults,
        ) {
            Ok(drained) => {
                p.pass.clear_freed(&drained.cleared);
                drained.holds
            }
            Err(SyncError::ValidationPending(pending)) => {
                return Ok(Applying::Suspended(pending, Box::new(progress)));
            }
            Err(error) => return Err(local(error)),
        };
        p.pass.replace_drain_holds(
            archived
                .iter()
                .map(|(object_id, hold)| (object_id.clone(), Some(hold.clone())))
                .collect(),
        );
        // Each pass decides again for queued work a drain held, so its
        // document frees once that work no longer needs holding. What those
        // drains commit is the pass's, once: when one waits, each keeps its
        // rows queued for the next attempt to report, and the rows they
        // remove leave drain reports.
        if matches!(p.holding, Holding::ByDocument { .. }) {
            let released = crate::ydoc_apply::drain_released_holds(
                store,
                cache,
                workspace_id,
                &archived,
                faults,
                leases,
            )
            .map_err(local)?;
            p.pass.replace_drain_holds(released.holds);
            for change in released.changes {
                insert_changed_path(&mut p.pass.changed_paths, change);
            }
            for refusal in released.refusals {
                push_refusal_once(&mut p.pass.refusals, refusal);
            }
            if let Some(pending) = released.waiting {
                return Ok(Applying::Suspended(pending, Box::new(progress)));
            }
        }
        let drained = crate::moment_apply::pending::drain_and_claim(
            store,
            workspace_id,
            &cache.released_tails(store),
            &mut p.settlements,
            faults,
            leases,
        );
        // A fault can report failure after the transaction commits.
        if drained.is_err() || p.settlements.report_id.is_some() {
            cache.clear();
        }
        match drained {
            Ok(()) => {}
            // The settlements before the one that waits committed into the
            // report the pass goes on with.
            Err(SyncError::ValidationPending(pending)) => {
                return Ok(Applying::Suspended(pending, Box::new(progress)));
            }
            Err(error) => return Err(local(error)),
        }
        let completed: Vec<&ReplicationEnvelope> =
            p.completed.iter().map(|&index| &ordered[index]).collect();
        let mut pass = std::mem::take(&mut p.pass);
        let mut settlements = std::mem::take(&mut p.settlements);
        let replay_more = crate::deferred::claim_report(
            store,
            workspace_id,
            queued,
            &completed,
            &mut settlements.report_id,
            faults,
        )?;
        pass.has_more = settlements.has_more || replay_more;
        for change in settlements.changes {
            insert_changed_path(&mut pass.changed_paths, change);
        }
        pass.record_facts.extend(settlements.record_facts);
        // What this pass's drains, and any abandoned pass's, removed from the
        // queue reaches the pass here, under the same token.
        let drained =
            crate::drain_report::claim(store, workspace_id, &mut settlements.report_id, faults)
                .map_err(local)?;
        pass.record_facts.extend(drained.record_facts);
        for change in drained.extras.changes {
            insert_changed_path(&mut pass.changed_paths, change);
        }
        for declined in drained.extras.sharing_declined {
            push_sharing_declined_once(&mut pass.sharing_declined, declined);
        }
        pass.conflicts_opened = pass
            .conflicts_opened
            .checked_add(drained.extras.conflicts_opened)
            .ok_or(RelayError::InvalidResponse)?;
        // A refusal a later projection's notice clearing removed from the
        // pending refusals still reaches the pass, once with them.
        for refusal in drained.extras.refusals {
            push_refusal_once(&mut pass.refusals, refusal);
        }
        // A drain refusal can commit before a later envelope fails hard, or
        // outside a pull during open/resync/close. Claim every relay-owned
        // pending sidecar under a unique local report token and return it here.
        // Direct-RPC retry rows retain their sentinel. Cursor commit clears only
        // the claimed token; a later drain remains unowned, while a newer pull
        // retags relay rows so a stale cursor cannot destroy an unread refusal.
        let pending_refusals =
            crate::apply::read_pending_refusals(store, workspace_id).map_err(local)?;
        for refusal in pending_refusals {
            push_refusal_once(&mut pass.refusals, refusal);
        }
        pass.settlement_report_id = settlements.report_id;
        Ok(Applying::Done(Box::new(pass)))
    }

    /// Apply the ordered op at `index` within the round `p` stands in. One
    /// that waits for released-tail validation applies nothing and changes
    /// nothing of `p`.
    #[allow(clippy::too_many_arguments)]
    fn apply_one(
        &self,
        store: &mut EngineStore,
        cache: &mut dohc_engine_collab::WriterDocCache,
        workspace_id: &str,
        op: &ReplicationEnvelope,
        index: usize,
        p: &mut ApplyProgress,
        relay_namespace: Option<&str>,
        faults: &dyn FaultInjector,
        leases: &dyn crate::LeaseProbe,
    ) -> Result<(), RelayError> {
        let key = p.holding.key(op);
        if let (Holding::ByDocument { behind, .. }, Some(key)) = (&p.holding, &key) {
            let omitted = behind
                .get(key)
                .is_some_and(|from| op.relay_seq.is_some_and(|seq| seq >= *from));
            if omitted || p.held.contains(key) {
                p.still_retryable.push(index);
                return Ok(());
            }
        }
        // Archived work queued before the op applies first, except of a
        // lineage an earlier op's drain found protected. A hold it leaves
        // stands in its document's row, which the pass reads when it settles
        // that document, and one the pass reported for a lineage it frees
        // is cleared.
        if op.op_kind != "ydoc.update" || op.payload["isBaseState"] == true {
            let drained = crate::ydoc_apply::drain_inactive_ydoc_updates(
                store,
                crate::ydoc_apply::InactiveScope::Workspace(workspace_id),
                &cache.released_tails(store),
                &mut p.archived_protected,
                crate::ydoc_apply::DrainReporting::Durable,
                faults,
            )
            .map_err(local)?;
            p.pass.clear_freed(&drained.cleared);
        }
        // Retained work replays under the feed it arrived on.
        let recorded = match &p.holding {
            Holding::ByDocument { .. } => crate::deferred::retained_namespace(store, op)?,
            Holding::ByOrigin => None,
        };
        let relay_namespace = recorded.as_ref().map_or(relay_namespace, Option::as_deref);
        // A frozen drain hold stops its document's read before the next op
        // it has not retained, which stays in the feed. Nothing reruns the
        // drain for it. One of an archived lineage freezes only that lineage:
        // ingress stops each of its updates, and the head's ops route on.
        // r1c-2: a dependency-drain hold still routes later ops, which queue
        // behind it unbounded until its bounded retention lands.
        let frozen = match (&p.holding, crate::hosted::hosted_document(op)) {
            (Holding::ByDocument { .. }, Some(object_id)) if recorded.is_none() => store
                .read_with(|conn| -> Result<Option<crate::HostedHold>, SyncError> {
                    let hold = crate::hosted::queued_released_hold(conn, workspace_id, object_id)?;
                    let Some(crate::HostedHold::ReleasedLineageUnsettled {
                        binding,
                        continuation: crate::ReleasedHoldContinuation::Frozen,
                        ..
                    }) = &hold
                    else {
                        return Ok(None);
                    };
                    if crate::ydoc_apply::names_archived_lineage(conn, binding)? {
                        return Ok(None);
                    }
                    Ok(hold)
                })
                .map_err(local)?
                .map(|hold| (object_id.to_owned(), hold)),
            _ => None,
        };
        let routed = if let Some((object_id, hold)) = frozen {
            p.pass.drain_holds.insert(object_id, hold);
            Err(SyncError::RetryableState {
                reason: crate::hosted::RELEASED_LINEAGE_UNSETTLED,
            })
        } else {
            match p.holding.held_before_routing(store, op)? {
                Some(reason) => Err(SyncError::RetryableState { reason }),
                None => crate::router::apply_replication_envelope_in_batch(
                    store,
                    cache,
                    op,
                    faults,
                    leases,
                    true,
                    relay_namespace,
                ),
            }
        };
        let held_for = match routed {
            // Its transaction rolled back; it routes again once its
            // validation completes.
            Err(SyncError::ValidationPending(pending)) => {
                return Err(RelayError::ValidationPending(pending));
            }
            // The read that stops at `op` holds its document with this
            // binding.
            Err(SyncError::ReleasedLineageUnsettled(binding)) => {
                if let Some(object_id) = crate::hosted::hosted_document(op) {
                    p.pass.released.insert(
                        object_id.to_owned(),
                        ((op.origin_id.clone(), op.origin_seq), binding),
                    );
                }
                Err(crate::hosted::RELEASED_LINEAGE_UNSETTLED)
            }
            // A hosted pull no configured host names a feed for cannot
            // queue what it must; it fails rather than stop at this op on
            // every pass.
            Err(SyncError::RetryableState {
                reason: reason @ crate::ydoc_apply::HOSTED_DEFERRAL_UNNAMED,
            }) => return Err(RelayError::Local(reason.to_owned())),
            Err(SyncError::RetryableState { reason }) => Err(reason),
            routed => Ok(routed),
        };
        // A later attempt at the coordinate that answers otherwise leaves
        // no binding for a stop there to take.
        if !matches!(held_for, Err(crate::hosted::RELEASED_LINEAGE_UNSETTLED))
            && let Some(object_id) = crate::hosted::hosted_document(op)
            && p.pass
                .released
                .get(object_id)
                .is_some_and(|(coordinate, _)| {
                    (coordinate.0.as_str(), coordinate.1) == (op.origin_id.as_str(), op.origin_seq)
                })
        {
            p.pass.released.remove(object_id);
        }
        match held_for {
            Err(reason) => {
                p.retryable_refusals.push((index, reason));
                if let Some(key) = key {
                    if retained_while_held(op, reason) {
                        p.durable.insert(key.clone());
                    }
                    p.held.insert(key);
                }
                p.still_retryable.push(index);
            }
            Ok(Err(SyncError::SequenceGap))
                if matches!(p.holding, Holding::ByOrigin) && p.held.contains(&op.origin_id) =>
            {
                p.still_retryable.push(index);
            }
            Ok(Err(error)) => return Err(local(error)),
            Ok(Ok(outcome)) => {
                p.made_progress = true;
                p.completed.push(index);
                accumulate_pull_outcome(
                    store,
                    op,
                    p.holding.unready(op),
                    outcome,
                    &mut p.pass.applied,
                    &mut p.pass.refused,
                    &mut p.pass.skipped,
                    &mut p.pass.conflicts_opened,
                    &mut p.pass.changed_paths,
                    &mut p.pass.redelivered,
                    &mut p.pass.refusals,
                    &mut p.pass.sharing_declined,
                    &mut p.pass.record_facts,
                    |claims| self.keep_automation_claims(claims),
                )?;
            }
        }
        Ok(())
    }

    pub fn commit_pull_cursor(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        cursor: &RelayCursor,
        faults: &dyn FaultInjector,
        leases: &dyn crate::LeaseProbe,
        now_ms: i64,
    ) -> Result<TxnOutcome<crate::CursorCommit>, RelayError> {
        commit_relay_cursor(store, workspace_id, cursor, faults, leases, now_ms).map_err(local)
    }

    pub fn probe(&self, req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        self.transport.probe(req)
    }

    pub fn claim_workspace(
        &self,
        store: &mut EngineStore,
        req: ClaimRequest,
        account_id: Option<&str>,
        faults: &dyn FaultInjector,
    ) -> Result<ClaimResponse, RelayError> {
        if store.is_passive() {
            return Err(local(SyncError::InvalidInput {
                reason: "passive store cannot write to the relay",
            }));
        }
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        // Before the pending state below, which would hold back hosted pushes.
        if store
            .read_with(|conn| crate::hosted::is_hosted(conn, &req.workspace_id))
            .map_err(local)?
        {
            return Err(hosted_feed_only());
        }
        let save = |store: &mut EngineStore, state: Option<&str>, keep_refusal: bool| match store
            .write_with(faults, |tx| {
                // A refused claim stops this replica's sync, which abandons
                // its unfinished ordinary pull.
                let refused = CLAIM_REFUSALS.iter().any(|(code, _)| Some(*code) == state);
                let changed = tx
                    .execute(
                        "UPDATE sync_identity SET \
                     claim_account_id=CASE WHEN ?3 THEN claim_account_id ELSE ?4 END, \
                     claim_state=CASE WHEN ?3 THEN COALESCE(claim_state,?2) ELSE ?2 END, \
                     ordinary_pull_token=CASE WHEN ?5 THEN NULL ELSE ordinary_pull_token END \
                     WHERE workspace_id=?1",
                        params![
                            req.workspace_id,
                            state,
                            keep_refusal,
                            state.and(account_id),
                            refused
                        ],
                    )
                    .map_err(SyncError::persist)?;
                if changed != 1 {
                    return Err(SyncError::CoordinateDiverged);
                }
                Ok(())
            })
            .map_err(local)?
        {
            TxnOutcome::Committed(()) => Ok(()),
            TxnOutcome::Crashed { .. } => Err(local(SyncError::FaultCrash)),
        };
        // A crash or lost response must leave this identity waiting for claim.
        save(store, Some("pending"), true)?;
        let result = self.transport.claim_workspace(req.clone());
        match &result {
            Ok(_) => save(store, None, false)?,
            Err(error) => {
                if let Some((code, _)) = CLAIM_REFUSALS.iter().find(|(_, refusal)| refusal == error)
                {
                    save(store, Some(code), false)?;
                }
            }
        }
        result
    }

    pub fn rotate_epoch(&self, req: EpochRequest) -> Result<EpochResponse, RelayError> {
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        self.transport.rotate_epoch(req)
    }

    pub fn upload_key_envelope(
        &self,
        req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        if req.envelope_json.is_empty() || req.envelope_json.len() > 16 * 1024 {
            return Err(RelayError::InvalidResponse);
        }
        let response = self.transport.upload_key_envelope(req)?;
        if response.etag.is_empty() {
            return Err(RelayError::InvalidResponse);
        }
        Ok(response)
    }

    pub fn download_key_envelope(
        &self,
        req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        let response = self.transport.download_key_envelope(req)?;
        if response.envelope_json.is_empty()
            || response.envelope_json.len() > 16 * 1024
            || response.etag.is_empty()
        {
            return Err(RelayError::InvalidResponse);
        }
        Ok(response)
    }

    pub fn recover_origin(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        new_origin_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<RecoverResponse, RelayError> {
        crate::model::bounded(new_origin_id, "origin_id must be non-empty and bounded")
            .map_err(local)?;
        // The rebase rewrites this origin's coordinates and resets acks the
        // hosted journal does not keep. A hosted origin is the relay's to name.
        if store
            .read_with(|conn| crate::hosted::is_hosted(conn, workspace_id))
            .map_err(local)?
        {
            return Err(RelayError::HostedRefusal(
                "a hosted replica never rebases its origin",
            ));
        }
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let mut shared_prefix_length = 0_i64;
        let mut cursor = 0;
        'pages: loop {
            let page = self.transport.pull(PullRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                cursor,
                limit: crate::MAX_PULL_OPS,
            })?;
            validate_pull_page(&page, workspace_id, cursor)?;
            for op in page.ops {
                if op.origin_id != identity.origin_id || op.origin_seq < shared_prefix_length {
                    continue;
                }
                if op.origin_seq != shared_prefix_length {
                    break 'pages;
                }
                let local_op = list_replication_ops(
                    store,
                    workspace_id,
                    &identity.origin_id,
                    shared_prefix_length - 1,
                    1,
                )
                .map_err(local)?
                .into_iter()
                .next();
                let Some(local_op) = local_op else {
                    break 'pages;
                };
                if local_op.origin_seq != shared_prefix_length
                    || local_op.op_kind != op.op_kind
                    || local_op.recorded_at_ms != op.recorded_at_ms
                    || !replication_payloads_match(&op.op_kind, &local_op.payload, &op.payload)
                        .map_err(local)?
                {
                    break 'pages;
                }
                shared_prefix_length = shared_prefix_length
                    .checked_add(1)
                    .ok_or(RelayError::InvalidResponse)?;
            }
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }

        let old_origin_id = identity.origin_id;
        let result = store
            .write_with(faults, |tx| {
                let bootstrap_complete =
                    crate::ydoc_origination::can_originate_local_bases_in_tx(tx, workspace_id)?;
                let collision: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM replication_log \
                         WHERE workspace_id=?1 AND origin_id=?2)",
                        params![workspace_id, new_origin_id],
                        |row| row.get(0),
                    )
                    .map_err(SyncError::corrupt)?;
                if collision {
                    return Err(SyncError::CoordinateDiverged);
                }
                let preserved_ops: i64 = tx
                    .query_row(
                        "SELECT COUNT(*) FROM replication_log \
                         WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq>=?3",
                        params![workspace_id, old_origin_id, shared_prefix_length],
                        |row| row.get(0),
                    )
                    .map_err(SyncError::corrupt)?;
                tx.execute(
                    "INSERT INTO replication_log \
                     (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                     SELECT workspace_id,?1,origin_seq-?2,op_kind,payload_json,recorded_at_ms,0 \
                     FROM replication_log \
                     WHERE workspace_id=?3 AND origin_id=?4 AND origin_seq>=?2 \
                     ORDER BY origin_seq",
                    params![
                        new_origin_id,
                        shared_prefix_length,
                        workspace_id,
                        old_origin_id
                    ],
                )
                .map_err(SyncError::persist)?;
                // These rows name physical replication coordinates, not the
                // operation's logical lineage. Move them with the preserved
                // suffix before deleting its old log rows. Relay positions
                // belonged to the collided origin and must be learned again
                // for the recovered coordinate.
                tx.execute(
                    "UPDATE ydoc_base_relay_candidates
                        SET origin_id=?1,origin_seq=origin_seq-?2
                      WHERE workspace_id=?3 AND origin_id=?4 AND origin_seq>=?2",
                    params![
                        new_origin_id,
                        shared_prefix_length,
                        workspace_id,
                        old_origin_id
                    ],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "UPDATE ydoc_docs
                        SET base_origin_id=?1,base_origin_seq=base_origin_seq-?2,
                            base_relay_seq=NULL,base_relay_confirmed_absent=0
                      WHERE workspace_id=?3 AND base_origin_id=?4
                        AND base_origin_seq>=?2",
                    params![
                        new_origin_id,
                        shared_prefix_length,
                        workspace_id,
                        old_origin_id
                    ],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "UPDATE ydoc_deferred_updates
                        SET origin_id=?1,origin_seq=origin_seq-?2,relay_seq=NULL
                      WHERE workspace_id=?3 AND origin_id=?4 AND origin_seq>=?2",
                    params![
                        new_origin_id,
                        shared_prefix_length,
                        workspace_id,
                        old_origin_id
                    ],
                )
                .map_err(SyncError::persist)?;
                let affected_chat_lww_cells = rebase_chat_projection_suffix(
                    tx,
                    workspace_id,
                    &old_origin_id,
                    shared_prefix_length,
                    new_origin_id,
                )?;
                tx.execute(
                    "DELETE FROM replication_log \
                     WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq>=?3",
                    params![workspace_id, old_origin_id, shared_prefix_length],
                )
                .map_err(SyncError::persist)?;
                recompute_chat_projection_winners(
                    tx,
                    workspace_id,
                    new_origin_id,
                    &affected_chat_lww_cells,
                )?;
                tx.execute(
                    "UPDATE sync_identity SET origin_id=?1 WHERE workspace_id=?2",
                    params![new_origin_id, workspace_id],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                     VALUES (?1,?2,?3) ON CONFLICT(workspace_id,origin_id) DO UPDATE SET \
                     pushed_seq=excluded.pushed_seq",
                    params![workspace_id, old_origin_id, shared_prefix_length - 1],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "UPDATE replication_peers SET acked_seq=?1 \
                     WHERE workspace_id=?2 AND origin_id=?3 AND acked_seq>?1",
                    params![shared_prefix_length - 1, workspace_id, old_origin_id],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "DELETE FROM sync_relay_push_state WHERE workspace_id=?1 AND origin_id=?2",
                    params![workspace_id, new_origin_id],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "INSERT INTO sync_relay_cursors \
                     (workspace_id,cursor,replication_epoch,stream_identity,bootstrap_complete) \
                     VALUES (?1,'0',?2,?3,?4) ON CONFLICT(workspace_id) DO UPDATE SET \
                     cursor='0',replication_epoch=excluded.replication_epoch, \
                     stream_identity=excluded.stream_identity,bootstrap_complete=excluded.bootstrap_complete",
                    params![workspace_id, identity.replication_epoch, identity.stream_identity, bootstrap_complete],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "DELETE FROM shared_channel_push_state WHERE workspace_id=?1",
                    [workspace_id],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "DELETE FROM share_proposal_push_state WHERE workspace_id=?1",
                    [workspace_id],
                )
                .map_err(SyncError::persist)?;
                // Direct-write marks name this origin's journal positions, which
                // a recovered origin starts over.
                tx.execute(
                    "DELETE FROM share_direct_write_state WHERE workspace_id=?1",
                    [workspace_id],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "DELETE FROM share_direct_write_marks WHERE workspace_id=?1",
                    [workspace_id],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "DELETE FROM share_direct_write_plan WHERE workspace_id=?1",
                    [workspace_id],
                )
                .map_err(SyncError::persist)?;
                usize::try_from(preserved_ops).map_err(|_| SyncError::CoordinateDiverged)
            })
            .map_err(local)?;
        let preserved_ops = match result {
            TxnOutcome::Committed(preserved_ops) => preserved_ops,
            TxnOutcome::Crashed { .. } => {
                return Err(RelayError::Local("injected-crash".to_owned()));
            }
        };
        Ok(RecoverResponse {
            old_origin_id,
            new_origin_id: new_origin_id.to_owned(),
            shared_prefix_length,
            preserved_ops,
        })
    }

    pub fn pull_shared_channel(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        share_id: &str,
        channel_wire_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<SharedChannelPullOutcome, RelayError> {
        let identity = read_sync_identity(store, workspace_id).map_err(local)?;
        let mut cursor = crate::read_share_cursor(
            store,
            workspace_id,
            share_id,
            crate::CursorKind::SharedChannel,
        )
        .map_err(local)?;
        let page = self.transport.shared_channel_pull(SharedChannelRequest {
            share_id: share_id.to_owned(),
            channel_wire_id: channel_wire_id.to_owned(),
            origin_id: identity
                .as_ref()
                .map_or_else(String::new, |value| value.origin_id.clone()),
            cursor,
            ops: Vec::new(),
        })?;
        validate_share_page(&page.ops, page.next_cursor, page.has_more, cursor)?;
        let fetched = page.ops.len();
        let own_echo = page.own_origin_id;
        let ops = page.ops;
        cursor = page.next_cursor;

        let boundary = crate::ShareBoundary {
            share_id: share_id.to_owned(),
            surface: crate::ShareSurface::SharedChannel,
            channel_wire_id: Some(channel_wire_id.to_owned()),
            granted: None,
        };
        let mut applied = 0_usize;
        let mut refused = 0_usize;
        let mut rejections = Vec::new();
        let mut skipped = 0_usize;
        for op in ops {
            if own_echo.as_deref() == Some(op.origin_id.as_str()) {
                skipped += 1;
                continue;
            }
            // The shared-CHANNEL lane keeps its bare skip: its outcome carries
            // per-op rejections for the boundary, and a malformed envelope
            // here is reported through `skipped` as it always was.
            let envelope = match share_envelope(workspace_id, op) {
                Ok(envelope) => envelope,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            match crate::apply_shared_envelope(store, &boundary, &envelope, faults) {
                Ok(outcome) => {
                    let ApplyOutcome {
                        primary,
                        refusals: nested_refusals,
                        sharing_declined,
                    } = outcome;
                    debug_assert!(sharing_declined.is_empty());
                    for refusal in nested_refusals {
                        push_shared_channel_rejection(&mut refused, &mut rejections, refusal)?;
                    }
                    match primary {
                        ApplyDisposition::Applied(claims) => {
                            applied += 1;
                            self.keep_automation_claims(claims);
                        }
                        ApplyDisposition::Refused(refusal) => {
                            push_shared_channel_rejection(&mut refused, &mut rejections, refusal)?;
                        }
                        ApplyDisposition::Skipped => skipped += 1,
                        ApplyDisposition::Crashed { .. } => {
                            return Err(RelayError::Local("injected-crash".to_owned()));
                        }
                    }
                }
                Err(SyncError::ShareBoundaryViolation) => {
                    refused = refused.checked_add(1).ok_or(RelayError::InvalidResponse)?;
                    rejections.push(SharedChannelRejection {
                        origin_id: envelope.origin_id,
                        origin_seq: envelope.origin_seq,
                        op_kind: envelope.op_kind,
                        reason: "share-boundary-violation".to_owned(),
                    });
                }
                // Every other class asks `share_disposition`, which is
                // exhaustive over `SyncError`. This lane keeps no list of its
                // own: a list is a thing to forget, and forgetting one here
                // wedges the pull rather than losing a count.
                Err(error) => match error.share_disposition() {
                    ShareDisposition::Skip => skipped += 1,
                    ShareDisposition::Abort => return Err(local(error)),
                },
            }
        }
        let committed = crate::commit_share_cursor(
            store,
            workspace_id,
            &crate::ShareCursor {
                kind: crate::CursorKind::SharedChannel,
                share_id: share_id.to_owned(),
                cursor,
            },
            faults,
        )
        .map_err(local)?;
        if matches!(committed, TxnOutcome::Crashed { .. }) {
            return Err(RelayError::Local("injected-crash".to_owned()));
        }
        Ok(SharedChannelPullOutcome {
            fetched,
            has_more: page.has_more,
            applied,
            refused,
            rejections,
            skipped,
            next_cursor: cursor,
        })
    }

    pub fn push_shared_channel(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        share_id: &str,
        channel_wire_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<SharedChannelPushOutcome, RelayError> {
        if store.is_passive() {
            return Err(local(SyncError::InvalidInput {
                reason: "passive store cannot write to the relay",
            }));
        }
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let state = read_shared_push_state(store, workspace_id, share_id)?;
        let scanned = state.scanned_seq;
        let mut dense_seq = match state.dense_seq {
            Some(dense_seq) => dense_seq,
            None => {
                let dense_seq = shared_dense_seq_through(
                    store,
                    workspace_id,
                    &identity.origin_id,
                    channel_wire_id,
                    scanned,
                )?;
                write_shared_push_state(store, workspace_id, share_id, scanned, dense_seq, faults)?;
                dense_seq
            }
        };
        let mut pending = Vec::with_capacity(crate::MAX_PUSH_OPS_PER_BATCH);
        let mut last_scanned = scanned;
        let mut pushed = 0_usize;
        let push_batch = |batch: &[(i64, ShareReplicationEnvelope)]| {
            let push = self.transport.share_log_push(ShareLogPushRequest {
                share_id: share_id.to_owned(),
                origin_id: identity.origin_id.clone(),
                ops: batch.iter().map(|(_, op)| op.clone()).collect(),
            })?;
            validate_share_push_response(&push, batch.len())?;
            Ok(push.inserted)
        };
        let mut after = scanned;
        loop {
            let page = list_replication_ops(
                store,
                workspace_id,
                &identity.origin_id,
                after,
                crate::MAX_PULL_OPS,
            )
            .map_err(local)?;
            let Some(page_last) = page.last().map(|op| op.origin_seq) else {
                break;
            };
            for op in page {
                let eligible =
                    shared_channel_op_allowed(store, workspace_id, channel_wire_id, &op)?;
                if eligible {
                    dense_seq = dense_seq
                        .checked_add(1)
                        .ok_or(RelayError::InvalidResponse)?;
                }
                if op.origin_seq <= scanned {
                    continue;
                }
                last_scanned = op.origin_seq;
                if eligible {
                    pending.push((
                        op.origin_seq,
                        ShareReplicationEnvelope {
                            origin_id: identity.origin_id.clone(),
                            origin_seq: dense_seq,
                            op_kind: op.op_kind,
                            payload: op.payload,
                            recorded_at_ms: op.recorded_at_ms,
                        },
                    ));
                }
                if pending.len() == crate::MAX_PUSH_OPS_PER_BATCH {
                    pushed = pushed
                        .checked_add(push_batch(&pending)?)
                        .ok_or(RelayError::InvalidResponse)?;
                    write_shared_push_state(
                        store,
                        workspace_id,
                        share_id,
                        pending.last().ok_or(RelayError::InvalidResponse)?.0,
                        dense_seq,
                        faults,
                    )?;
                    pending.clear();
                }
            }
            after = page_last;
        }
        if !pending.is_empty() {
            pushed = pushed
                .checked_add(push_batch(&pending)?)
                .ok_or(RelayError::InvalidResponse)?;
            write_shared_push_state(
                store,
                workspace_id,
                share_id,
                pending.last().ok_or(RelayError::InvalidResponse)?.0,
                dense_seq,
                faults,
            )?;
        }
        write_shared_push_state(
            store,
            workspace_id,
            share_id,
            last_scanned,
            dense_seq,
            faults,
        )?;
        Ok(SharedChannelPushOutcome { pushed })
    }

    /// Offer this replica's own edits to a received file share back to the
    /// granter, as one proposal the granter reads and then accepts or declines.
    ///
    /// The scan is bounded at the submit moment: the journal's high-water mark
    /// for this origin is read once, before the first page, and edits made
    /// after it wait for the next submit. That integer is what makes one
    /// submit one coherent unit rather than a debounce tick.
    ///
    /// `scanned_seq` advances only after the relay has accepted the submit, so
    /// a failed submit re-offers the same changes rather than losing them.
    ///
    /// One submit carries at most `MAX_SHARE_PROPOSAL_OPS` changes. The scan
    /// stops at that bound instead of failing after it, and records the
    /// journal position it stopped at, so the rest travels in the next submit.
    /// `more_pending` on the outcome says a further submit has more to offer.
    #[allow(clippy::too_many_arguments)]
    pub fn submit_share_proposal(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        share_id: &str,
        granted: &crate::ShareGrant,
        submit_id: &str,
        faults: &dyn FaultInjector,
        max_read_bytes: usize,
    ) -> Result<ShareProposalSubmitOutcome, RelayError> {
        if store.is_passive() {
            return Err(local(SyncError::InvalidInput {
                reason: "passive store cannot write to the relay",
            }));
        }
        // The PINNED level is read here rather than trusted from the relay's
        // own refusal. A recipient offers nothing it was not granted, so a
        // View or Comment share never contacts the relay at all.
        if granted.access != crate::ShareAccess::Edit {
            return Ok(ShareProposalSubmitOutcome::default());
        }
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let scanned = read_share_proposal_scan_position(store, workspace_id, share_id)?;
        let submit_through =
            local_max_origin_seq(store, workspace_id, &identity.origin_id).map_err(local)?;
        // A change the direct lane already wrote to the granter's files is
        // not offered again. Its later edits are, based on what it wrote. A
        // file a direct write still carries stops the scan, so this position
        // never passes a change the relay may yet refuse.
        let skips = ScanSkips {
            settled: read_direct_write_marks(store, workspace_id, share_id)?
                .into_iter()
                .filter(|(_, mark)| mark.delivered_through >= 0)
                .map(|(object_id, mark)| (object_id, mark.delivered_through))
                .collect(),
            stop_at: read_direct_write_open_objects(store, workspace_id, share_id)?,
        };
        let scan = collect_share_proposal_changes(
            store,
            workspace_id,
            granted,
            &identity.origin_id,
            scanned,
            submit_through,
            max_read_bytes,
            &skips,
        )?;
        let mut changes: Vec<ShareProposalChange> =
            scan.changes.into_iter().map(|net| net.change).collect();
        if changes.is_empty() {
            // Nothing to offer, but this window is read. Recording it keeps
            // the next submit from re-reading ops it already decided about.
            write_share_proposal_scan_position(
                store,
                workspace_id,
                share_id,
                scan.scanned_through,
                faults,
            )?;
            return Ok(ShareProposalSubmitOutcome {
                skipped_outside_share: scan.skipped_outside_share,
                more_pending: scan.more_pending,
                ..ShareProposalSubmitOutcome::default()
            });
        }
        self.upload_proposed_blobs(store, share_id, &mut changes, &mut BTreeMap::new())?;
        let response = self
            .transport
            .share_proposal_submit(ShareProposalSubmitRequest {
                share_id: share_id.to_owned(),
                submit_id: submit_id.to_owned(),
                ops: changes.clone(),
            })?;
        if response.proposal_id.is_empty() || response.ops != changes.len() {
            return Err(RelayError::InvalidResponse);
        }
        write_share_proposal_scan_position(
            store,
            workspace_id,
            share_id,
            scan.scanned_through,
            faults,
        )?;
        Ok(ShareProposalSubmitOutcome {
            submitted: changes.len(),
            proposal_id: Some(response.proposal_id),
            skipped_outside_share: scan.skipped_outside_share,
            more_pending: scan.more_pending,
        })
    }

    /// Upload the after-blob of every change that names one, before the submit
    /// that references it. `appendLogBatch` refuses a batch naming a blob the
    /// relay does not hold, and the submit route runs the same check, so
    /// content travels first — the ordering the owner's own drain uses.
    ///
    /// The blob is also where a missing byte length comes from. A moment whose
    /// stored `payloadAfterByteLength` is null would otherwise be offered with
    /// a length nobody measured, and the relay writes that number into the
    /// granter's own moment at accept.
    ///
    /// `uploaded` holds the blobs already sent in this operation, with their
    /// byte lengths, so a blob several changes name travels once.
    fn upload_proposed_blobs(
        &self,
        store: &EngineStore,
        share_id: &str,
        changes: &mut [ShareProposalChange],
        uploaded: &mut BTreeMap<String, i64>,
    ) -> Result<(), RelayError> {
        for change in changes {
            let Some(sha256) = change.after_blob_sha256.clone() else {
                continue;
            };
            let byte_length = match uploaded.get(&sha256) {
                Some(byte_length) => *byte_length,
                None => {
                    let kind = if change.after_content_kind.as_deref() == Some("binary") {
                        BlobKind::Binary
                    } else {
                        BlobKind::Text
                    };
                    let bytes =
                        local_blob_bytes(store, &sha256, kind)?.ok_or(RelayError::BlobMissing)?;
                    let byte_length =
                        i64::try_from(bytes.len()).map_err(|_| RelayError::BlobInvalid)?;
                    self.transport.share_blob_upload(ShareBlobUploadRequest {
                        share_id: share_id.to_owned(),
                        sha256: sha256.clone(),
                        bytes,
                    })?;
                    uploaded.insert(sha256, byte_length);
                    byte_length
                }
            };
            if change.after_byte_length.is_none() {
                change.after_byte_length = Some(byte_length);
            }
        }
        Ok(())
    }

    /// Pull one page of a received share.
    ///
    /// `granted` is the selector the relay stated for this share, pinned by
    /// the recipient on first read, and it is enforced against every inbound
    /// op. The relay selects the page, but the relay is not trusted to select
    /// it honestly: an op addressing a path outside the pinned selector — or
    /// claiming a version it does not grant — is skipped before replay, so
    /// its blob is never requested. There is no unscoped pull: the grant is
    /// required, and one that selects nothing admits nothing.
    pub fn pull_share_view(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        share_id: &str,
        granted: &crate::ShareGrant,
        faults: &dyn FaultInjector,
    ) -> Result<ShareViewPullOutcome, RelayError> {
        let mut cursor =
            crate::read_share_cursor(store, workspace_id, share_id, crate::CursorKind::ShareView)
                .map_err(local)?;
        let page = self.transport.share_view_pull(ShareViewRequest {
            share_id: share_id.to_owned(),
            cursor,
            limit: crate::model::MAX_PULL_OPS_PER_PASS,
        })?;
        validate_share_page(&page.ops, page.next_cursor, page.has_more, cursor)?;
        let fetched = page.ops.len();
        let ops = page.ops;
        // The cursor this page was fetched at, kept for the ops that carry no
        // usable coordinate of their own. See `page_position_origin`.
        let page_cursor = cursor;
        cursor = page.next_cursor;
        let boundary = crate::ShareBoundary {
            share_id: share_id.to_owned(),
            surface: crate::ShareSurface::ShareView,
            channel_wire_id: None,
            granted: Some(granted.clone()),
        };
        let mut applied = 0_usize;
        let mut skipped = 0_usize;
        let mut refusals = Vec::new();
        let mut changed = BTreeMap::<String, ShareViewChangedPath>::new();
        let mut blob_refusals = BTreeMap::<(String, &'static str), RelayError>::new();
        for (index, op) in ops.into_iter().enumerate() {
            // The coordinate before the envelope is built: a malformed op the
            // engine will not apply still commits the cursor past itself, and
            // when its origin coordinate is usable there is an identity to
            // attach the reason to. Only an op with no usable coordinate is a
            // bare skip — that one genuinely has nothing to record.
            let coordinate = usable_coordinate(&op);
            let envelope = match share_envelope(workspace_id, op) {
                Ok(envelope) => envelope,
                Err(ShareEnvelopeError { op_kind, cause }) => {
                    skipped += 1;
                    // An op whose own coordinate is unusable is filed under
                    // its POSITION in the page instead. Its cursor commits
                    // past it either way, so "no identity" cannot mean "no
                    // durable record" — that would lose exactly the ops least
                    // able to identify themselves.
                    let (origin_id, origin_seq) =
                        coordinate.unwrap_or_else(|| page_position_origin(page_cursor, index));
                    refusals.push(ShareViewRefusal::new(
                        origin_id,
                        origin_seq,
                        &op_kind,
                        cause.code(),
                        cause.detail,
                    ));
                    continue;
                }
            };
            // The relay serves `workspace.init` to a path/version share as its
            // bootstrap op (`services/sync-relay/src/shareFilter.ts`), and this
            // recipient needs nothing from it: `replay_share_view_op` ensures
            // the local main version itself. So it is skipped as expected, not
            // refused — the boundary still admits only `moment.append` and
            // `version.create`, and reporting this healthy skip as a refusal
            // would make the first pull of every share look damaged.
            if envelope.op_kind == BOOTSTRAP_OP_KIND {
                skipped += 1;
                continue;
            }
            match crate::apply_shared_envelope(store, &boundary, &envelope, faults) {
                Ok(outcome) => {
                    let ApplyOutcome {
                        primary,
                        refusals: nested_refusals,
                        sharing_declined,
                    } = outcome;
                    // A share-view CHAT op does mutate chat
                    // dependencies — that is what applying it means, and the
                    // replay it unparks can refuse ops of its own. Those
                    // refusals are recorded below rather than asserted about:
                    // every coordinate `chat_pending_replication` can hold is
                    // a chat kind by construction, so an assertion that they
                    // are chat kinds proves nothing and is absent in release
                    // anyway.
                    for refusal in nested_refusals {
                        refusals.push(ShareViewRefusal::new(
                            refusal.origin_id,
                            refusal.origin_seq,
                            &refusal.op_kind,
                            refusal.reason.code(),
                            refusal.reason.message().to_owned(),
                        ));
                    }
                    debug_assert!(sharing_declined.is_empty());
                    match primary {
                        ApplyDisposition::Applied(claims) => self.keep_automation_claims(claims),
                        ApplyDisposition::Refused(_) | ApplyDisposition::Skipped => {
                            skipped += 1;
                            continue;
                        }
                        ApplyDisposition::Crashed { .. } => {
                            return Err(RelayError::Local("injected-crash".to_owned()));
                        }
                    }
                }
                // `share_disposition` decides, and it is exhaustive over
                // `SyncError` — a new variant fails to compile there until its
                // author chooses, rather than falling into a catch-all and
                // wedging this pull. Listing the classes here instead would
                // put that choice in a place nobody is forced to visit.
                Err(error) => match error.share_disposition() {
                    // Skip and continue: one op the relay should not have
                    // served must not wedge the share. The reason travels with
                    // the outcome so the skip is visible rather than silent.
                    ShareDisposition::Skip => {
                        skipped += 1;
                        refusals.push(ShareViewRefusal::new(
                            envelope.origin_id,
                            envelope.origin_seq,
                            &envelope.op_kind,
                            error.code(),
                            error.to_string(),
                        ));
                        continue;
                    }
                    ShareDisposition::Abort => return Err(local(error)),
                },
            }
            // A chat op is fully applied by the boundary above —
            // it has no file to materialize, no blob to fetch, and no path to
            // report as changed. `replay_share_view_op` is the FILE replay,
            // and running it for a chat op would ensure a version and then
            // fall through every branch for nothing.
            if envelope.op_kind.starts_with("chat.") {
                applied += 1;
                continue;
            }
            let mut replay = ShareViewReplayContext {
                transport: &self.transport,
                store,
                workspace_id,
                share_id,
                faults,
                applied: &mut applied,
                skipped: &mut skipped,
                refusals: &mut refusals,
                changed: &mut changed,
                blob_refusals: &mut blob_refusals,
            };
            // Replay refusals are recorded inside, one per refused blob, by
            // `refuse_replay_unit`. What reaches here is only what must abort.
            replay_share_view_op(&mut replay, &envelope)?;
        }
        Ok(ShareViewPullOutcome {
            fetched,
            has_more: page.has_more,
            applied,
            skipped,
            refusals,
            changed_paths: page_order(changed.into_values(), |change| change.operation),
            pending_cursor: crate::ShareCursor {
                kind: crate::CursorKind::ShareView,
                share_id: share_id.to_owned(),
                cursor,
            },
        })
    }

    pub fn commit_share_view_cursor(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        cursor: &crate::ShareCursor,
        faults: &dyn FaultInjector,
    ) -> Result<TxnOutcome<()>, RelayError> {
        if cursor.kind != crate::CursorKind::ShareView {
            return Err(RelayError::InvalidResponse);
        }
        crate::commit_share_cursor(store, workspace_id, cursor, faults).map_err(local)
    }

    fn upload_push_prefix(
        &self,
        store: &EngineStore,
        workspace_id: &str,
        identity: &crate::SyncIdentity,
        page: &mut PreparedPushPage,
        started: std::time::Instant,
        confirmed: &mut BTreeSet<String>,
    ) -> Result<usize, RelayError> {
        let ops = &page.ops[..page.prefix.allowed_ops];
        let missing = &mut page.missing;
        while let Some(chunk) = page.inventory.front() {
            let response = self.transport.blobs_have(BlobHaveRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                sha256s: chunk.clone(),
            })?;
            let returned = response.validated_missing(chunk)?;
            confirmed.extend(chunk.iter().filter(|sha| !returned.contains(sha)).cloned());
            missing.extend(response.missing);
            page.inventory.pop_front();
        }
        missing.retain(|sha| !confirmed.contains(sha));
        while page.uploaded_ops < ops.len() {
            if page.uploaded_ops > 0 && started.elapsed() >= PUSH_PRE_APPEND_BUDGET {
                break;
            }
            let width = if started.elapsed() >= PUSH_PRE_APPEND_BUDGET {
                1
            } else {
                MAX_BLOB_UPLOAD_BATCH
            };
            let end = (page.uploaded_ops + width).min(ops.len());
            let mut uploads = Vec::new();
            let mut upload_bytes = 0;
            'blobs: for sha256 in collect_blob_refs(&ops[page.uploaded_ops..end])?.keys() {
                if !missing.contains(sha256) {
                    continue;
                }
                let mut bytes = None;
                let kinds = page
                    .blob_refs
                    .get(sha256)
                    .ok_or(RelayError::InvalidResponse)?;
                for kind in kinds {
                    if !uploads.is_empty()
                        && local_blob_length(store, sha256, *kind, false)?.is_some_and(|length| {
                            length > MAX_BLOB_UPLOAD_BATCH_BYTES - upload_bytes
                        })
                    {
                        break 'blobs;
                    }
                    if let Some(local) = local_blob_bytes(store, sha256, *kind)? {
                        bytes = Some(local);
                        break;
                    }
                }
                let bytes = bytes.ok_or(RelayError::BlobInvalid)?;
                upload_bytes += bytes.len();
                uploads.push(BlobUploadRequest {
                    workspace_id: workspace_id.to_owned(),
                    replication_epoch: identity.replication_epoch.clone(),
                    stream_identity: identity.stream_identity.clone(),
                    sha256: sha256.clone(),
                    bytes,
                });
                if uploads.len() == MAX_BLOB_UPLOAD_BATCH
                    || upload_bytes >= MAX_BLOB_UPLOAD_BATCH_BYTES
                {
                    break;
                }
            }
            if !uploads.is_empty() {
                let uploaded = uploads
                    .iter()
                    .map(|upload| upload.sha256.clone())
                    .collect::<Vec<_>>();
                self.transport.upload_blobs(uploads)?;
                for sha in uploaded {
                    missing.remove(&sha);
                    confirmed.insert(sha);
                }
                continue;
            }
            page.uploaded_ops = end;
        }
        Ok(page.uploaded_ops)
    }

    fn hydrate_missing_blobs(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        identity: &crate::SyncIdentity,
        ops: &[ReplicationEnvelope],
        faults: &dyn FaultInjector,
    ) -> Result<(), RelayError> {
        struct MissingBlob {
            sha256: String,
            kinds: Vec<BlobKind>,
            constraint: &'static str,
            limit_bytes: usize,
        }

        let mut pending = Vec::new();
        for (sha256, kinds) in blob_refs_to_apply(store, ops)? {
            let mut missing = Vec::new();
            for kind in kinds {
                if local_blob_length(store, &sha256, kind, true)?.is_none() {
                    missing.push(kind);
                }
            }
            // The loosest ceiling any missing kind allows. An empty `missing`
            // yields no ceiling and needs no download.
            let Some((constraint, limit_bytes)) = missing
                .iter()
                .copied()
                .map(blob_ceiling)
                .max_by_key(|(_, limit_bytes)| *limit_bytes)
            else {
                continue;
            };
            pending.push(MissingBlob {
                sha256,
                kinds: missing,
                constraint,
                limit_bytes,
            });
        }

        for chunk in pending.chunks(MAX_BLOB_DOWNLOAD_BATCH) {
            let first = chunk.first().ok_or(RelayError::InvalidResponse)?;
            let response = self
                .transport
                .download_blobs(BlobDownloadBatchRequest {
                    workspace_id: workspace_id.to_owned(),
                    replication_epoch: identity.replication_epoch.clone(),
                    stream_identity: identity.stream_identity.clone(),
                    blobs: chunk
                        .iter()
                        .map(|blob| BlobDownloadSpec {
                            sha256: blob.sha256.clone(),
                            limit_bytes: blob.limit_bytes,
                        })
                        .collect(),
                })
                .map_err(|error| relabel_ceiling(error, first.constraint, first.limit_bytes))?;
            if response.results.len() != chunk.len() {
                return Err(RelayError::InvalidResponse);
            }

            for (blob, result) in chunk.iter().zip(response.results) {
                let response = result
                    .map_err(|error| relabel_ceiling(error, blob.constraint, blob.limit_bytes))?;
                // Refuse before hashing and before copying: a transport is not
                // trusted to bound its own response, and no kind can accept this.
                if response.bytes.len() > blob.limit_bytes {
                    return Err(RelayError::BlobTooLarge {
                        constraint: blob.constraint,
                        limit_bytes: blob.limit_bytes,
                        observed: ObservedBytes::Exact(response.bytes.len()),
                    });
                }
                let verified = VerifiedBlob::verify(&blob.sha256, &response.bytes)
                    .map_err(|_| RelayError::BlobInvalid)?;
                for kind in &blob.kinds {
                    match verified
                        .hydrate(store, *kind, faults)
                        .map_err(|error| match error {
                            SyncError::BlobInvalid => RelayError::BlobInvalid,
                            SyncError::BlobTooLarge {
                                constraint,
                                limit_bytes,
                                observed_bytes,
                            } => RelayError::BlobTooLarge {
                                constraint,
                                limit_bytes,
                                observed: ObservedBytes::Exact(observed_bytes),
                            },
                            other => local(other),
                        })? {
                        TxnOutcome::Committed(()) => {}
                        TxnOutcome::Crashed { .. } => {
                            return Err(RelayError::Local("injected-crash".to_owned()));
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

/// A transport bounds a blob body without knowing which kind was asked for, so
/// it names the loosest ingest ceiling. Only the caller knows the kind. Relabel
/// the refusal with that kind's real limit: an agent told the wrong number
/// shrinks its payload to a size that is still refused.
fn relabel_ceiling(error: RelayError, constraint: &'static str, limit_bytes: usize) -> RelayError {
    match error {
        RelayError::BlobTooLarge { observed, .. } => RelayError::BlobTooLarge {
            constraint,
            limit_bytes,
            observed,
        },
        other => other,
    }
}

/// The blobs this replica needs to apply `ops`. A hosted replica never needs,
/// and so never requests, a before side the feed withholds.
pub(crate) fn blob_refs_to_apply(
    store: &EngineStore,
    ops: &[ReplicationEnvelope],
) -> Result<BTreeMap<String, BTreeSet<BlobKind>>, RelayError> {
    let mut forgotten: Option<Vec<ReplicationEnvelope>> = None;
    for (index, op) in ops.iter().enumerate() {
        if op.op_kind == "moment.append"
            && !settlement_refused(op)
            && store
                .read_with(|conn| crate::hosted::withheld_before(conn, op))
                .map_err(local)?
                .is_some()
        {
            let forgotten = forgotten.get_or_insert_with(|| ops.to_vec());
            crate::hosted::forget_before(&mut forgotten[index].payload);
        }
    }
    collect_blob_refs(forgotten.as_deref().unwrap_or(ops))
}

/// Deterministic refusal acknowledges only the immutable coordinate, and the
/// relay serves a refused row without validating it: unavailable hostile
/// content must not hold up subsequent operations.
fn settlement_refused(op: &ReplicationEnvelope) -> bool {
    matches!(
        op.settlement_admission,
        Some(crate::SettlementAdmission::Refused { .. })
    )
}

pub(crate) fn collect_blob_refs(
    ops: &[ReplicationEnvelope],
) -> Result<BTreeMap<String, BTreeSet<BlobKind>>, RelayError> {
    let mut refs = BTreeMap::new();
    for op in ops {
        if settlement_refused(op) {
            continue;
        }
        match op.op_kind.as_str() {
            "moment.append" => {
                insert_optional_ref(
                    &mut refs,
                    op.payload
                        .get("settlementReference")
                        .and_then(|reference| reference.get("record"))
                        .and_then(|record| string_field(record, "acceptedStateBlobSha256")),
                    BlobKind::Ydoc,
                )?;
                for side in MomentRefs::read(&op.payload).sides() {
                    insert_optional_ref(
                        &mut refs,
                        side.blob_sha256,
                        side.content_kind.blob_kind(),
                    )?;
                }
            }
            "conflict.open" => {
                // A text side carries its content inline.
                for side in conflict_open_sides(&op.payload) {
                    if side.content_kind.blob_kind() == BlobKind::Binary {
                        insert_optional_ref(&mut refs, side.sha256, BlobKind::Binary)?;
                    }
                }
            }
            "conflict.resolve" => {
                let validated = crate::conflict_resolve_v1::validate_conflict_resolve_v1(
                    &op.payload,
                    crate::conflict_resolve_v1::ConflictResolveEnvelopeContext {
                        workspace_id: &op.workspace_id,
                        recorded_at_ms: op.recorded_at_ms,
                    },
                )
                .map_err(local)?;
                for sha256 in validated.text_blob_sha256s {
                    refs.entry(sha256).or_default().insert(BlobKind::Text);
                }
                for sha256 in validated.binary_blob_sha256s {
                    refs.entry(sha256).or_default().insert(BlobKind::Binary);
                }
                for sha256 in validated.ydoc_blob_sha256s {
                    refs.entry(sha256).or_default().insert(BlobKind::Ydoc);
                }
            }
            "version.create" => {
                for snapshot in VersionCreateRefs::read(&op.payload).snapshots() {
                    insert_optional_ref(
                        &mut refs,
                        snapshot.content.blob_sha256,
                        snapshot.content.content_kind.blob_kind(),
                    )?;
                }
            }
            "ydoc.update" => {
                // Its own kind, not `Binary`: a Y.Doc delta or full-state base
                // rides the collab layer's measured payload cap, never the
                // captured-file cap.
                insert_optional_ref(
                    &mut refs,
                    YdocRefs::read(&op.payload).update_blob_sha256,
                    BlobKind::Ydoc,
                )?;
            }
            "live.audit.application" => {
                insert_optional_ref(
                    &mut refs,
                    string_field(&op.payload, "updateBlobSha256"),
                    BlobKind::Ydoc,
                )?;
                for chunk in op
                    .payload
                    .get("manifest")
                    .and_then(|m| m.get("chunks"))
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    insert_optional_ref(
                        &mut refs,
                        string_field(chunk, "sha256"),
                        BlobKind::Binary,
                    )?;
                }
            }
            "live.audit.settlement" => {
                insert_optional_ref(
                    &mut refs,
                    op.payload
                        .get("record")
                        .and_then(|record| string_field(record, "acceptedStateBlobSha256")),
                    BlobKind::Ydoc,
                )?;
                insert_optional_ref(
                    &mut refs,
                    op.payload
                        .get("record")
                        .and_then(|record| string_field(record, "markdownDigest")),
                    BlobKind::Text,
                )?;
            }
            "live.audit.base" => {
                insert_optional_ref(
                    &mut refs,
                    op.payload
                        .get("record")
                        .and_then(|record| record.get("checkpoint"))
                        .and_then(|checkpoint| string_field(checkpoint, "stateDigest")),
                    BlobKind::Ydoc,
                )?;
            }
            "secret.file.put" => {
                insert_optional_ref(
                    &mut refs,
                    string_field(&op.payload, "ciphertextSha256"),
                    BlobKind::Binary,
                )?;
            }
            "secret.version.fork" => {
                for row in op
                    .payload
                    .get("rows")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    insert_optional_ref(
                        &mut refs,
                        string_field(row, "ciphertextSha256"),
                        BlobKind::Binary,
                    )?;
                }
            }
            _ => {}
        }
    }
    Ok(refs)
}

fn insert_optional_ref(
    refs: &mut BTreeMap<String, BTreeSet<BlobKind>>,
    sha256: Option<&str>,
    kind: BlobKind,
) -> Result<(), RelayError> {
    let Some(sha256) = sha256.filter(|sha256| !sha256.is_empty()) else {
        return Ok(());
    };
    if !valid_sha256(sha256) {
        return Err(RelayError::BlobInvalid);
    }
    refs.entry(sha256.to_owned()).or_default().insert(kind);
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn local_blob_bytes(
    store: &EngineStore,
    sha256: &str,
    kind: BlobKind,
) -> Result<Option<Vec<u8>>, RelayError> {
    #[cfg(test)]
    LOCAL_BLOB_BYTES_CALLS.with(|calls| calls.set(calls.get() + 1));
    store
        .read_with(|conn| match kind {
            BlobKind::Text => {
                let row = text::with_length(conn, sha256)
                    .optional()
                    .map_err(SyncError::corrupt)?;
                let Some((byte_length, text)) = row else {
                    return Ok(None);
                };
                let bytes = text.into_bytes();
                if usize::try_from(byte_length).ok() != Some(bytes.len())
                    || hex_sha256(&bytes) != sha256
                {
                    return Err(SyncError::BlobInvalid);
                }
                Ok(Some(bytes))
            }
            BlobKind::Binary | BlobKind::Ydoc => {
                let row = conn
                    .query_row(
                        "SELECT byte_length,bytes FROM binary_blobs WHERE sha256=?1",
                        [sha256],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)),
                    )
                    .optional()
                    .map_err(SyncError::corrupt)?;
                let Some((byte_length, bytes)) = row else {
                    return Ok(None);
                };
                // The ceiling comes from the referenced kind, never a literal.
                // A restated number here read a Y.Doc base against the
                // captured-file cap and called a valid oversized blob
                // `BlobInvalid` — the wrong constraint and the wrong error.
                if usize::try_from(byte_length).ok() != Some(bytes.len())
                    || bytes.len() > blob_ceiling(kind).1
                    || hex_sha256(&bytes) != sha256
                {
                    return Err(SyncError::BlobInvalid);
                }
                Ok(Some(bytes))
            }
        })
        .map_err(|error| {
            if matches!(error, SyncError::BlobInvalid) {
                RelayError::BlobInvalid
            } else {
                local(error)
            }
        })
}

#[cfg(test)]
thread_local! {
    static LOCAL_BLOB_BYTES_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn take_local_blob_bytes_call_count() -> usize {
    LOCAL_BLOB_BYTES_CALLS.with(|calls| {
        let count = calls.get();
        calls.set(0);
        count
    })
}

/// Read the stored length; with `validate_ceiling`, refuse one over the kind's
/// ceiling. Upload passes `false` and only needs the length;
/// `local_blob_bytes` refuses its bytes.
///
/// Both questions, because they stopped being the same one. `Binary` and
/// `Ydoc` share `binary_blobs` and no longer share a ceiling, so bare table
/// membership would let a caller route around the tighter cap by referencing
/// bytes some other kind already admitted: a Y.Doc base up to
/// `MAX_YDOC_UPDATE_BYTES` hydrates legitimately, and a later `moment.append`
/// naming the same sha as `binary` would be reported satisfied — skipping
/// `hydrate_blob_content`, the only place `MAX_CAPTURE_BINARY_FILE_BYTES` is
/// enforced — and materialize as an oversized captured file.
///
/// So pull's stored bytes over the requested kind's ceiling are refused here, by
/// name, rather than reported present. Refused rather than re-fetched: the
/// length is already known, and downloading identical bytes to reject them
/// would only make the observed size less exact.
fn local_blob_length(
    store: &EngineStore,
    sha256: &str,
    kind: BlobKind,
    validate_ceiling: bool,
) -> Result<Option<usize>, RelayError> {
    let (constraint, limit_bytes) = blob_ceiling(kind);
    let stored: Option<i64> = store
        .read_with(|conn| {
            let table = match kind {
                BlobKind::Text => "blobs",
                BlobKind::Binary | BlobKind::Ydoc => "binary_blobs",
            };
            conn.query_row(
                &format!("SELECT byte_length FROM {table} WHERE sha256=?1"),
                [sha256],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)
        })
        .map_err(local)?;
    let Some(byte_length) = stored else {
        return Ok(None);
    };
    let observed = usize::try_from(byte_length).map_err(|_| RelayError::BlobInvalid)?;
    if validate_ceiling && observed > limit_bytes {
        return Err(RelayError::BlobTooLarge {
            constraint,
            limit_bytes,
            observed: ObservedBytes::Exact(observed),
        });
    }
    Ok(Some(observed))
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum ChatLwwCell {
    Reaction {
        message_id: String,
        emoji: String,
        author_id: String,
    },
    Decision {
        message_id: String,
    },
    Follow {
        owner_user_id: String,
        target_kind: String,
        target_id: String,
    },
    FeedRead {
        owner_user_id: String,
    },
}

fn chat_lww_cell(op_kind: &str, payload: &serde_json::Value) -> Option<ChatLwwCell> {
    let field = |name| payload.get(name)?.as_str().map(str::to_owned);
    match op_kind {
        "chat.reaction.set" => Some(ChatLwwCell::Reaction {
            message_id: field("messageId")?,
            emoji: field("emoji")?,
            author_id: field("authorId")?,
        }),
        "chat.decision.set" => Some(ChatLwwCell::Decision {
            message_id: field("messageId")?,
        }),
        "chat.follow.set" => Some(ChatLwwCell::Follow {
            owner_user_id: field("ownerUserId")?,
            target_kind: field("targetKind")?,
            target_id: field("targetId")?,
        }),
        "chat.feed.read.set" => Some(ChatLwwCell::FeedRead {
            owner_user_id: field("ownerUserId")?,
        }),
        _ => None,
    }
}

fn rebase_chat_projection_suffix(
    tx: &Transaction<'_>,
    workspace_id: &str,
    old_origin_id: &str,
    first_old_origin_seq: i64,
    new_origin_id: &str,
) -> Result<BTreeSet<ChatLwwCell>, SyncError> {
    let suffix_ops = {
        let mut statement = tx
            .prepare(
                "SELECT origin_seq,op_kind,payload_json FROM replication_log \
                 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq>=?3 \
                   AND op_kind IN ('chat.reaction.set','chat.decision.set', \
                                   'chat.follow.set','chat.feed.read.set') \
                 ORDER BY origin_seq",
            )
            .map_err(SyncError::corrupt)?;
        statement
            .query_map(
                params![workspace_id, old_origin_id, first_old_origin_seq],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?
    };
    let mut affected = BTreeSet::new();
    for (old_origin_seq, op_kind, payload_json) in suffix_ops {
        let payload: serde_json::Value =
            serde_json::from_str(&payload_json).map_err(SyncError::corrupt)?;
        let cell = chat_lww_cell(&op_kind, &payload).ok_or(SyncError::CoordinateDiverged)?;
        let new_origin_seq = old_origin_seq
            .checked_sub(first_old_origin_seq)
            .ok_or(SyncError::CoordinateDiverged)?;
        rebase_current_chat_projection(
            tx,
            workspace_id,
            old_origin_id,
            old_origin_seq,
            new_origin_id,
            new_origin_seq,
            &cell,
        )?;
        affected.insert(cell);
    }
    Ok(affected)
}

#[allow(clippy::too_many_arguments)]
fn rebase_current_chat_projection(
    tx: &Transaction<'_>,
    workspace_id: &str,
    old_origin_id: &str,
    old_origin_seq: i64,
    new_origin_id: &str,
    new_origin_seq: i64,
    cell: &ChatLwwCell,
) -> Result<(), SyncError> {
    match cell {
        ChatLwwCell::Reaction {
            message_id,
            emoji,
            author_id,
        } => tx.execute(
            "UPDATE chat_reactions SET origin_id=?1,origin_seq=?2 \
             WHERE workspace_id=?3 AND origin_id=?4 AND origin_seq=?5 \
               AND message_id=?6 AND emoji=?7 AND author_id=?8",
            params![
                new_origin_id,
                new_origin_seq,
                workspace_id,
                old_origin_id,
                old_origin_seq,
                message_id,
                emoji,
                author_id
            ],
        ),
        ChatLwwCell::Decision { message_id } => tx.execute(
            "UPDATE chat_decisions SET origin_id=?1,origin_seq=?2 \
             WHERE workspace_id=?3 AND origin_id=?4 AND origin_seq=?5 AND message_id=?6",
            params![
                new_origin_id,
                new_origin_seq,
                workspace_id,
                old_origin_id,
                old_origin_seq,
                message_id
            ],
        ),
        ChatLwwCell::Follow {
            owner_user_id,
            target_kind,
            target_id,
        } => tx.execute(
            "UPDATE chat_follows SET origin_id=?1,origin_seq=?2 \
             WHERE workspace_id=?3 AND origin_id=?4 AND origin_seq=?5 \
               AND owner_user_id=?6 AND target_kind=?7 AND target_id=?8",
            params![
                new_origin_id,
                new_origin_seq,
                workspace_id,
                old_origin_id,
                old_origin_seq,
                owner_user_id,
                target_kind,
                target_id
            ],
        ),
        ChatLwwCell::FeedRead { owner_user_id } => tx.execute(
            "UPDATE chat_feed_read_state SET origin_id=?1,origin_seq=?2 \
             WHERE workspace_id=?3 AND origin_id=?4 AND origin_seq=?5 AND owner_user_id=?6",
            params![
                new_origin_id,
                new_origin_seq,
                workspace_id,
                old_origin_id,
                old_origin_seq,
                owner_user_id
            ],
        ),
    }
    .map_err(SyncError::persist)?;
    Ok(())
}

fn recompute_chat_projection_winners(
    tx: &Transaction<'_>,
    workspace_id: &str,
    new_origin_id: &str,
    affected: &BTreeSet<ChatLwwCell>,
) -> Result<(), SyncError> {
    if affected.is_empty() {
        return Ok(());
    }
    let raw_candidates = {
        let mut statement = tx
            .prepare(
                "SELECT origin_id,origin_seq,op_kind,payload_json,recorded_at_ms \
                 FROM replication_log WHERE workspace_id=?1 \
                   AND op_kind IN ('chat.reaction.set','chat.decision.set', \
                                   'chat.follow.set','chat.feed.read.set') \
                 ORDER BY origin_id,origin_seq",
            )
            .map_err(SyncError::corrupt)?;
        statement
            .query_map([workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?
    };
    for (origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) in raw_candidates {
        let payload: serde_json::Value =
            serde_json::from_str(&payload_json).map_err(SyncError::corrupt)?;
        let Some(cell) = chat_lww_cell(&op_kind, &payload) else {
            continue;
        };
        if !affected.contains(&cell) {
            continue;
        }
        let operation = ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: workspace_id.to_owned(),
            origin_id,
            origin_seq,
            relay_seq: None,
            op_kind,
            payload,
            recorded_at_ms,
        };
        tx.execute_batch("SAVEPOINT dohc_recover_chat_lww")
            .map_err(SyncError::persist)?;
        match apply_chat_lww_projection_tx(tx, &operation) {
            Ok(()) => tx
                .execute_batch("RELEASE dohc_recover_chat_lww")
                .map_err(SyncError::persist)?,
            Err(error) => {
                tx.execute_batch(
                    "ROLLBACK TO dohc_recover_chat_lww; RELEASE dohc_recover_chat_lww",
                )
                .map_err(SyncError::persist)?;
                match error {
                    SyncError::InvalidInput { .. } if operation.origin_id != new_origin_id => {
                        continue;
                    }
                    SyncError::InvalidInput { .. } => {
                        return Err(SyncError::CoordinateDiverged);
                    }
                    error => return Err(error),
                }
            }
        }
    }
    Ok(())
}

fn preflight_collisions(
    store: &EngineStore,
    workspace_id: &str,
    local_origin_id: &str,
    ops: &[ReplicationEnvelope],
) -> Result<(), RelayError> {
    let diverged_is_local = store
        .read_with(|conn| {
            for op in ops {
                let existing = conn
                    .query_row(
                        "SELECT op_kind,payload_json,recorded_at_ms FROM replication_log \
                         WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                        params![workspace_id, op.origin_id, op.origin_seq],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, i64>(2)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(SyncError::corrupt)?;
                let Some((op_kind, payload_json, recorded_at_ms)) = existing else {
                    continue;
                };
                let local_payload: serde_json::Value = match serde_json::from_str(&payload_json) {
                    Ok(payload) => payload,
                    Err(_) => return Ok(Some(op.origin_id == local_origin_id)),
                };
                if op_kind != op.op_kind
                    || recorded_at_ms != op.recorded_at_ms
                    || !replication_payloads_match(&op.op_kind, &local_payload, &op.payload)?
                {
                    return Ok(Some(op.origin_id == local_origin_id));
                }
            }
            Ok(None)
        })
        .map_err(local)?;
    match diverged_is_local {
        Some(true) => Err(RelayError::OriginDiverged),
        // Recovering the local origin cannot repair a conflicting imported
        // coordinate. Fail closed without rotating the unrelated local log.
        Some(false) => Err(RelayError::InvalidResponse),
        None => Ok(()),
    }
}

/// The relay consumes ordinary recording claims, while main's live, agent,
/// settlement and full-state payloads retain their exact context.
pub(crate) fn without_recording_claim(
    kind: &str,
    payload: &serde_json::Value,
) -> Option<serde_json::Value> {
    let context = payload.get("authorContext")?;
    let account = context.get("accountId")?.as_str()?;
    if crate::outbound::ordinary_account_context(account).as_ref() != Some(context) {
        return None;
    }
    match kind {
        "moment.append"
            if payload.get("settlementReference").is_none()
                && payload.get("attributionUnavailable").is_none() => {}
        "ydoc.update"
            if payload.get("isBaseState") == Some(&serde_json::Value::Bool(false))
                && payload
                    .get("actorOriginId")
                    .and_then(serde_json::Value::as_str)
                    == Some(account)
                && payload["attribution"]["actorKind"] == "human" => {}
        _ => return None,
    }
    let mut stored = payload.clone();
    stored.as_object_mut()?.remove("authorContext");
    Some(stored)
}

pub(crate) fn replication_payloads_match(
    kind: &str,
    left: &serde_json::Value,
    right: &serde_json::Value,
) -> Result<bool, SyncError> {
    // A lost push acknowledgement can leave the claim only in the local journal.
    // Two claims, or any other content difference, still compare exactly.
    let stripped_left = right
        .get("authorContext")
        .is_none()
        .then(|| without_recording_claim(kind, left))
        .flatten();
    let stripped_right = left
        .get("authorContext")
        .is_none()
        .then(|| without_recording_claim(kind, right))
        .flatten();
    Ok(
        canonical_json_bytes(stripped_left.as_ref().unwrap_or(left))?
            == canonical_json_bytes(stripped_right.as_ref().unwrap_or(right))?,
    )
}

pub(crate) fn canonical_json_bytes(value: &serde_json::Value) -> Result<Vec<u8>, SyncError> {
    #[cfg(test)]
    CANONICAL_JSON_CALLS.with(|calls| calls.set(calls.get() + 1));
    dohc_engine_collab::canonical_json::canonical_json_string(value)
        .map(String::into_bytes)
        .ok_or(SyncError::CoordinateDiverged)
}

#[cfg(test)]
thread_local! {
    static CANONICAL_JSON_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn take_canonical_json_call_count() -> usize {
    CANONICAL_JSON_CALLS.with(|calls| {
        let count = calls.get();
        calls.set(0);
        count
    })
}

/// Whether a held op is retained across passes, so the cursor can move past
/// it: work behind a live session, and a hosted moment or Y.Doc row whose
/// path waits for a departed document to park. A hosted document that is not
/// ready retains nothing.
fn retained_while_held(op: &ReplicationEnvelope, reason: &str) -> bool {
    match reason {
        crate::hosted::PATH_HELD_BY_DEPARTED => true,
        "ydoc-session-live" => {
            matches!(op.op_kind.as_str(), "conflict.resolve" | "moment.append")
        }
        _ => false,
    }
}

/// How a pass holds later work behind an op that cannot apply yet.
enum Holding {
    /// Admission takes each origin in sequence, so it refuses later ops of a
    /// held origin with a gap.
    ByOrigin,
    /// A hosted replica admits sparsely, so the pass itself holds later ops of
    /// a held document. `behind` gives, for each document whose retained work
    /// runs past this pass's replay, the relay position of the first op the
    /// replay left out: that op and every later one of the document hold.
    /// `unready` names the documents in the scope that are not ready.
    ByDocument {
        behind: BTreeMap<String, i64>,
        unready: BTreeSet<String>,
    },
}

impl Holding {
    fn key(&self, op: &ReplicationEnvelope) -> Option<String> {
        match self {
            Self::ByOrigin => Some(op.origin_id.clone()),
            Self::ByDocument { .. } => crate::hosted::hosted_document(op).map(str::to_owned),
        }
    }

    /// Why a hosted replica holds `op` back before routing it
    /// ([`crate::hosted::held_before_routing`]).
    fn held_before_routing(
        &self,
        store: &EngineStore,
        op: &ReplicationEnvelope,
    ) -> Result<Option<&'static str>, RelayError> {
        let Self::ByDocument { unready, .. } = self else {
            return Ok(None);
        };
        store
            .read_with(|conn| crate::hosted::held_before_routing(conn, unready, op))
            .map_err(local)
    }

    /// What each round starts out holding: an origin with durable work, or
    /// nothing for a hosted replica.
    fn held_at_round(&self, durable: &BTreeSet<String>) -> BTreeSet<String> {
        match self {
            Self::ByOrigin => durable.clone(),
            Self::ByDocument { .. } => BTreeSet::new(),
        }
    }

    /// The document of `op`, when it is a hosted document that is not ready.
    fn unready<'a>(&self, op: &'a ReplicationEnvelope) -> Option<&'a str> {
        let Self::ByDocument { unready, .. } = self else {
            return None;
        };
        crate::hosted::hosted_document(op).filter(|object_id| unready.contains(*object_id))
    }

    /// Stop a ready hosted document at `op` when it can wait indefinitely:
    /// the feed withholds its conflict parent, it would move onto another
    /// spelling of a path another document holds, its released lineage is
    /// unsettled, or its lineage does not project its resulting head yet. The
    /// document is held there, naming why, and retains nothing, as one that
    /// is not ready.
    // MERGE-REVIEW: main stops these only after a round without progress;
    // the released-lineage and resulting-head reasons now wait for that too.
    fn stop_where_it_can_wait(&mut self, op: &ReplicationEnvelope, reason: &str) {
        if let Self::ByDocument { unready, .. } = self
            && matches!(
                reason,
                crate::hosted::CONFLICT_PARENT_WITHHELD
                    | crate::hosted::PATH_HELD_IN_SCOPE
                    | crate::hosted::RELEASED_LINEAGE_UNSETTLED
                    | "ydoc-resulting-head-pending"
            )
            && let Some(object_id) = crate::hosted::hosted_document(op)
        {
            unready.insert(object_id.to_owned());
        }
    }
}

#[derive(Default)]
struct AppliedPass {
    applied: usize,
    refused: usize,
    skipped: usize,
    conflicts_opened: i64,
    changed_paths: ChangedPaths,
    /// The decisions journaled rows of each hosted document that is not
    /// ready stored, which the pass has yet to check against what holds
    /// their paths.
    redelivered: BTreeMap<String, ChangedPaths>,
    refusals: Vec<crate::ReplicationRefusal>,
    sharing_declined: Vec<crate::SharingDeclined>,
    record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
    settlement_report_id: Option<String>,
    /// Settlement or deferred replay left work for another pass.
    has_more: bool,
    /// Each hosted document that is not ready, that stopped at a withheld
    /// conflict parent, or whose work would pass the retention limit, whose
    /// ops did not all apply, with the first that did not.
    stopped: BTreeMap<String, ReplicationEnvelope>,
    /// Each document an op held for released retained work, with that op's
    /// coordinate and the binding the hold names.
    released: BTreeMap<String, ReleasedStop>,
    /// Each document whose queued work the pass's drain held for released
    /// retained work, with that hold.
    drain_holds: BTreeMap<String, crate::HostedHold>,
}

impl AppliedPass {
    /// Take what a drain decided for each document it examined: the hold it
    /// left, or none, which clears the hold an earlier drain of the pass
    /// reported. A document it did not examine keeps its entry.
    fn replace_drain_holds(&mut self, examined: BTreeMap<String, Option<crate::HostedHold>>) {
        for (object_id, hold) in examined {
            match hold {
                Some(hold) => self.drain_holds.insert(object_id, hold),
                None => self.drain_holds.remove(&object_id),
            };
        }
    }

    /// Clear each hold an earlier drain reported that names an archived
    /// lineage `cleared` says a later one took every queued row of, by
    /// object id. A hold of another lineage stands.
    fn clear_freed(&mut self, cleared: &BTreeMap<String, BTreeSet<String>>) {
        self.drain_holds.retain(|object_id, hold| {
            !matches!(
                hold,
                crate::HostedHold::ReleasedLineageUnsettled { binding, .. }
                    if cleared
                        .get(object_id)
                        .is_some_and(|lineages| lineages.contains(&binding.lineage_claim_id))
            )
        });
    }
}

type ReleasedStop = (
    (String, i64),
    Box<dohc_engine_collab::live_update_application::ReleasedLineageBinding>,
);

/// Where a pass's apply stands. Ops are named by their index in the pass's
/// ordered ops.
struct ApplyProgress {
    pass: AppliedPass,
    /// Open documents' artifacts are still to recover into the pass.
    recovering: bool,
    completed: Vec<usize>,
    /// The round being applied, and how far into it.
    round: Vec<usize>,
    next: usize,
    /// What the round held for the next one.
    still_retryable: Vec<usize>,
    /// Why each op the round held could not apply.
    retryable_refusals: Vec<(usize, &'static str)>,
    first: bool,
    made_progress: bool,
    held: BTreeSet<String>,
    durable: BTreeSet<String>,
    holding: Holding,
    /// Every round ran; only settling what the ops left pending remains.
    rounds_done: bool,
    /// The owner settlements the pass reports so far.
    settlements: crate::moment_apply::pending::PendingSettlementReport,
    /// The archived lineages, as `[version, object, lineage]`, that the
    /// inactive drains before its ops found released tails protect. Those
    /// drains pass over them; the end of the pass decides them again.
    archived_protected: Vec<[String; 3]>,
}

/// What applying a pass came to.
enum Applying {
    Done(Box<AppliedPass>),
    /// An op or owner settlement waits for released-tail validation; nothing
    /// of it applied.
    Suspended(
        Box<dohc_engine_collab::live_update_application::PendingValidation>,
        Box<ApplyProgress>,
    ),
}

/// The documents a scope names, each once, with its path.
fn hosted_scope_documents(scope: &HostedScope) -> Result<BTreeMap<String, String>, RelayError> {
    let bounded = |value: &str| {
        crate::model::bounded(value, "hosted scope fields must be non-empty and bounded").is_ok()
    };
    let mut documents = BTreeMap::new();
    if !bounded(&scope.token) {
        return Err(RelayError::InvalidResponse);
    }
    for document in &scope.documents {
        if !bounded(&document.object_id)
            || !bounded(&document.path)
            || documents
                .insert(document.object_id.clone(), document.path.clone())
                .is_some()
        {
            return Err(RelayError::InvalidResponse);
        }
    }
    Ok(documents)
}

fn merge_by_origin(ops: Vec<ReplicationEnvelope>) -> Vec<ReplicationEnvelope> {
    let mut queues = BTreeMap::<String, Vec<ReplicationEnvelope>>::new();
    for op in ops {
        queues.entry(op.origin_id.clone()).or_default().push(op);
    }
    for queue in queues.values_mut() {
        queue.sort_by_key(|op| op.origin_seq);
        queue.reverse();
    }
    let mut merged = Vec::new();
    loop {
        let best = queues
            .iter()
            .filter_map(|(origin, queue)| queue.last().map(|op| (origin.clone(), op)))
            .min_by(|(_, left), (_, right)| {
                (left.recorded_at_ms, &left.origin_id, left.origin_seq).cmp(&(
                    right.recorded_at_ms,
                    &right.origin_id,
                    right.origin_seq,
                ))
            })
            .map(|(origin, _)| origin);
        let Some(origin) = best else {
            break;
        };
        if let Some(op) = queues.get_mut(&origin).and_then(Vec::pop) {
            merged.push(op);
        }
    }
    merged
}

fn list_workspace_origins(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<String>, SyncError> {
    store.read_with(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT DISTINCT origin_id FROM replication_log \
                 WHERE workspace_id=?1 AND imported=0 ORDER BY origin_id",
            )
            .map_err(SyncError::corrupt)?;
        let rows = statement
            .query_map([workspace_id], |row| row.get(0))
            .map_err(SyncError::corrupt)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)
    })
}

/// The highest sequence `origin_id` wrote here. A hosted replica's own origin
/// reads its counter too, which outlives the journal rows it numbered.
pub(crate) fn local_max_origin_seq(
    store: &EngineStore,
    workspace_id: &str,
    origin_id: &str,
) -> Result<i64, SyncError> {
    store.read_with(|conn| {
        conn.query_row(
            "SELECT MAX(COALESCE((SELECT MAX(origin_seq) FROM replication_log \
               WHERE workspace_id=?1 AND origin_id=?2),-1), \
             COALESCE((SELECT h.last_outbound_seq FROM hosted_replicas h \
               JOIN sync_identity i ON i.workspace_id=h.workspace_id \
               WHERE h.workspace_id=?1 AND i.origin_id=?2),-1))",
            params![workspace_id, origin_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)
    })
}

fn validate_push_response(
    response: &PushResponse,
    batch: &[ReplicationEnvelope],
    local_max: i64,
    hosted: bool,
) -> Result<(), RelayError> {
    crate::settlement_publication::validate_push_refusals(&response.settlement_refusals, batch)?;
    crate::hosted::validate_push_refusals(response, batch, hosted)?;
    crate::ydoc_recovery::validate_redundant_recoveries(
        &response.redundant_recoveries,
        batch,
        hosted,
    )?;
    let last = batch
        .last()
        .map(|op| op.origin_seq)
        .ok_or(RelayError::InvalidResponse)?;
    if response.accepted != batch.len()
        || response
            .inserted
            .checked_add(response.skipped)
            .is_none_or(|total| total != response.accepted)
        || !(-1..=crate::MAX_WIRE_INTEGER).contains(&response.current_max_origin_seq)
        || response.current_max_origin_seq < last
    {
        return Err(RelayError::InvalidResponse);
    }
    if response.current_max_origin_seq > local_max {
        return Err(RelayError::OriginDiverged);
    }
    Ok(())
}

/// A share log answers for its whole batch: only the hosted log refuses ops one at a time.
pub(crate) fn validate_share_push_response(
    push: &PushResponse,
    batch_len: usize,
) -> Result<(), RelayError> {
    if push.accepted != batch_len
        || push.inserted.checked_add(push.skipped) != Some(push.accepted)
        || !push.hosted_refusals.is_empty()
        || !push.redundant_recoveries.is_empty()
    {
        return Err(RelayError::InvalidResponse);
    }
    Ok(())
}

pub(crate) fn validate_probe_response(response: &PushResponse) -> Result<(), RelayError> {
    if !response.settlement_refusals.is_empty()
        || !response.hosted_refusals.is_empty()
        || !response.redundant_recoveries.is_empty()
        || response.accepted != 0
        || response.inserted != 0
        || response.skipped != 0
        || !(-1..=crate::MAX_WIRE_INTEGER).contains(&response.current_max_origin_seq)
    {
        return Err(RelayError::InvalidResponse);
    }
    Ok(())
}

fn push_probe_request(
    workspace_id: &str,
    identity: &crate::SyncIdentity,
    origin_id: &str,
    after_seq: i64,
) -> PushRequest {
    PushRequest {
        workspace_id: workspace_id.to_owned(),
        replication_epoch: identity.replication_epoch.clone(),
        stream_identity: identity.stream_identity.clone(),
        origin_id: origin_id.to_owned(),
        after_seq,
        ops: Vec::new(),
    }
}

fn validate_pull_page(
    response: &PullResponse,
    workspace_id: &str,
    cursor: i64,
) -> Result<(), RelayError> {
    validate_log_page(
        &response.ops,
        response.next_cursor,
        response.has_more,
        workspace_id,
        cursor,
        false,
    )
}

/// A hosted page may end past its last op: the scoped feed's cursor passes
/// the rows it withholds.
fn validate_hosted_page(
    response: &HostedPullResponse,
    workspace_id: &str,
    cursor: i64,
) -> Result<(), RelayError> {
    validate_log_page(
        &response.ops,
        response.next_cursor,
        response.has_more,
        workspace_id,
        cursor,
        true,
    )
}

fn validate_log_page(
    ops: &[ReplicationEnvelope],
    next_cursor: i64,
    has_more: bool,
    workspace_id: &str,
    cursor: i64,
    passes_withheld_rows: bool,
) -> Result<(), RelayError> {
    if ops.len() > crate::MAX_PULL_OPS
        || !(0..=crate::MAX_WIRE_INTEGER).contains(&next_cursor)
        || (!has_more && next_cursor < cursor)
    {
        return Err(RelayError::InvalidResponse);
    }
    if has_more && next_cursor <= cursor {
        return Err(RelayError::NoProgress);
    }
    let mut previous = cursor;
    for op in ops {
        if op.workspace_id != workspace_id || op.validate().is_err() {
            return Err(RelayError::InvalidResponse);
        }
        let relay_seq = op.relay_seq.ok_or(RelayError::InvalidResponse)?;
        if relay_seq <= previous || relay_seq > next_cursor {
            return Err(RelayError::InvalidResponse);
        }
        previous = relay_seq;
    }
    if !passes_withheld_rows && previous != next_cursor {
        return Err(RelayError::InvalidResponse);
    }
    Ok(())
}

fn validate_share_page(
    ops: &[ShareReplicationEnvelope],
    next_cursor: i64,
    has_more: bool,
    cursor: i64,
) -> Result<(), RelayError> {
    if ops.len() > crate::MAX_PULL_OPS
        || !(0..=crate::MAX_WIRE_INTEGER).contains(&next_cursor)
        || next_cursor < cursor
        || (has_more && next_cursor <= cursor)
    {
        return Err(RelayError::InvalidResponse);
    }
    Ok(())
}

/// Why a served op could not become an envelope, kept whole so the refusal can
/// name it. The op kind travels with it because the envelope was never built.
struct ShareEnvelopeError {
    op_kind: String,
    cause: EnvelopeRefusal,
}

struct EnvelopeRefusal {
    code: &'static str,
    detail: String,
}

impl EnvelopeRefusal {
    const fn code(&self) -> &'static str {
        self.code
    }
}

/// The namespace that keeps a page position out of the relay's identity space.
///
/// A unit separator, and the reason is mechanical: a relay origin id becomes a
/// coordinate only through `usable_coordinate`, which runs
/// `crate::model::bounded`, which rejects every ASCII control byte. So no id
/// the relay can serve begins with this, and the two spaces cannot meet. The
/// readable part after it is for a human reading a registry file and carries
/// no guarantee at all — without this prefix, a relay origin literally named
/// `share-page:0` at seq 1 would be the same durable coordinate as the op at
/// index 1 of the page fetched at cursor 0, and the recipient's merge would
/// read the second as a retry of the first.
///
/// `page_position_origins_cannot_alias_a_relay_origin` holds the two ends
/// together, so relaxing `bounded` breaks a test rather than a boundary.
const PAGE_POSITION_NAMESPACE: char = '\u{1f}';

/// The identity for an op whose own coordinate is unusable: where it sat in
/// the page.
///
/// Idempotent across re-pulls, which is what a durable record needs. A page is
/// fetched at a cursor and the relay's log is append-only, so the same cursor
/// returns the same ops in the same order and the same op lands on the same
/// coordinate — the recipient's merge then recognizes it as one it already
/// counted. A relay that answers the same cursor with different ops can make
/// two of them share a coordinate; that costs one entry in a bounded list, and
/// the relay was lying about its log.
pub(crate) fn page_position_origin(page_cursor: i64, index: usize) -> (String, i64) {
    (
        format!("{PAGE_POSITION_NAMESPACE}share-page:{page_cursor}"),
        index as i64,
    )
}

/// The origin coordinate a refusal can be filed under, or `None` when the op
/// carries none this record could ever match again.
fn usable_coordinate(op: &ShareReplicationEnvelope) -> Option<(String, i64)> {
    if crate::model::bounded(&op.origin_id, "origin").is_err() {
        return None;
    }
    if op.origin_seq < 0 || op.origin_seq > crate::model::MAX_WIRE_INTEGER {
        return None;
    }
    Some((op.origin_id.clone(), op.origin_seq))
}

fn share_envelope(
    workspace_id: &str,
    op: ShareReplicationEnvelope,
) -> Result<ReplicationEnvelope, ShareEnvelopeError> {
    let op_kind = op.op_kind.clone();
    let envelope = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: workspace_id.to_owned(),
        origin_id: op.origin_id,
        origin_seq: op.origin_seq,
        relay_seq: None,
        op_kind: op.op_kind,
        payload: op.payload,
        recorded_at_ms: op.recorded_at_ms,
    };
    if let Err(error) = envelope.validate() {
        return Err(ShareEnvelopeError {
            op_kind,
            cause: describe_envelope_refusal(&envelope, error),
        });
    }
    Ok(envelope)
}

/// The refusal message, with the numbers where the check has them.
///
/// `ReplicationEnvelope::validate` answers with a static reason, so the
/// oversized-payload case is measured here for the report — the same
/// measurement, taken again to say how far over the op was rather than only
/// that it was over. A caller that cannot see the size cannot tell a payload
/// one byte past the limit from one ten times it.
fn describe_envelope_refusal(envelope: &ReplicationEnvelope, error: SyncError) -> EnvelopeRefusal {
    let code = error.code();
    // In the order `ReplicationEnvelope::validate` checks them, so the branch
    // taken here is the one that actually refused.
    //
    // The origin id first, and it matters most: an op whose origin id is
    // unusable is filed under its page position, so the reader never sees the
    // value at all and cannot tell an empty one from a small overrun or from
    // a hundred kilobytes.
    // The clause that fired, from the validator itself. An id can break this
    // rule three ways, and citing the length bound for one that satisfies it
    // names a constraint the op met.
    if let Some(clause) = crate::model::unbounded_clause(&envelope.origin_id) {
        return EnvelopeRefusal {
            code,
            detail: format!("{error}: {clause}"),
        };
    }
    // Then the sequence, the coordinate's other half and refused for the same
    // reason it is unusable AS a coordinate: an op with one is filed under its
    // page position, so this value never reaches the reader either.
    if envelope.origin_seq < 0 || envelope.origin_seq > crate::model::MAX_WIRE_INTEGER {
        return EnvelopeRefusal {
            code,
            detail: format!(
                "{error}: 0 to {} inclusive, offered {}",
                crate::model::MAX_WIRE_INTEGER,
                envelope.origin_seq
            ),
        };
    }
    // Then the op kind, for the same reason: the refusal replaces an unusable
    // kind with a placeholder, so without the numbers a reader cannot tell a
    // one-byte overrun from a kilobyte of junk.
    let op_kind_bytes = envelope.op_kind.len();
    if envelope.op_kind.is_empty() || op_kind_bytes > crate::model::MAX_OP_KIND_BYTES {
        return EnvelopeRefusal {
            code,
            detail: format!(
                "{error}: at most {} bytes, offered {op_kind_bytes} bytes",
                crate::model::MAX_OP_KIND_BYTES
            ),
        };
    }
    let observed = serde_json::to_vec(&envelope.payload)
        .map(|encoded| encoded.len())
        .ok();
    match observed {
        Some(observed) if observed > crate::model::MAX_PAYLOAD_JSON_BYTES => EnvelopeRefusal {
            code,
            detail: format!(
                "{error}: at most {} bytes, offered {observed} bytes",
                crate::model::MAX_PAYLOAD_JSON_BYTES
            ),
        },
        _ => EnvelopeRefusal {
            code,
            detail: error.to_string(),
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SharedPushState {
    scanned_seq: i64,
    dense_seq: Option<i64>,
}

fn read_shared_push_state(
    store: &EngineStore,
    workspace_id: &str,
    share_id: &str,
) -> Result<SharedPushState, RelayError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT pushed_seq,dense_seq FROM shared_channel_push_state \
                 WHERE workspace_id=?1 AND share_id=?2",
                params![workspace_id, share_id],
                |row| {
                    Ok(SharedPushState {
                        scanned_seq: row.get(0)?,
                        dense_seq: row.get(1)?,
                    })
                },
            )
            .optional()
            .map(|value| {
                value.unwrap_or(SharedPushState {
                    scanned_seq: -1,
                    dense_seq: Some(-1),
                })
            })
            .map_err(SyncError::corrupt)
        })
        .map_err(local)
}

fn write_shared_push_state(
    store: &mut EngineStore,
    workspace_id: &str,
    share_id: &str,
    scanned_seq: i64,
    dense_seq: i64,
    faults: &dyn FaultInjector,
) -> Result<(), RelayError> {
    if !(-1..=crate::MAX_WIRE_INTEGER).contains(&scanned_seq)
        || !(-1..=crate::MAX_WIRE_INTEGER).contains(&dense_seq)
    {
        return Err(RelayError::InvalidResponse);
    }
    let outcome = store
        .write_with(faults, |tx| {
            tx.execute(
                "INSERT INTO shared_channel_push_state \
                 (workspace_id,share_id,pushed_seq,dense_seq) VALUES (?1,?2,?3,?4) \
                 ON CONFLICT(workspace_id,share_id) DO UPDATE SET \
                 pushed_seq=excluded.pushed_seq,dense_seq=excluded.dense_seq",
                params![workspace_id, share_id, scanned_seq, dense_seq],
            )
            .map_err(SyncError::persist)?;
            Ok::<(), SyncError>(())
        })
        .map_err(local)?;
    if matches!(outcome, TxnOutcome::Crashed { .. }) {
        return Err(RelayError::Local("injected-crash".to_owned()));
    }
    Ok(())
}

/// Where the last submit stopped reading this replica's own journal for this
/// share. `-1` is "nothing read yet", the same floor every other
/// durable coordinate in this file uses.
fn read_share_proposal_scan_position(
    store: &EngineStore,
    workspace_id: &str,
    share_id: &str,
) -> Result<i64, RelayError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT scanned_seq FROM share_proposal_push_state \
                 WHERE workspace_id=?1 AND share_id=?2",
                params![workspace_id, share_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|value| value.unwrap_or(-1))
            .map_err(SyncError::corrupt)
        })
        .map_err(local)
}

fn write_share_proposal_scan_position(
    store: &mut EngineStore,
    workspace_id: &str,
    share_id: &str,
    scanned_seq: i64,
    faults: &dyn FaultInjector,
) -> Result<(), RelayError> {
    if !(-1..=crate::MAX_WIRE_INTEGER).contains(&scanned_seq) {
        return Err(RelayError::InvalidResponse);
    }
    let outcome = store
        .write_with(faults, |tx| {
            tx.execute(
                "INSERT INTO share_proposal_push_state (workspace_id,share_id,scanned_seq) \
                 VALUES (?1,?2,?3) ON CONFLICT(workspace_id,share_id) DO UPDATE SET \
                 scanned_seq=excluded.scanned_seq",
                params![workspace_id, share_id, scanned_seq],
            )
            .map_err(SyncError::persist)?;
            Ok::<(), SyncError>(())
        })
        .map_err(local)?;
    if matches!(outcome, TxnOutcome::Crashed { .. }) {
        return Err(RelayError::Local("injected-crash".to_owned()));
    }
    Ok(())
}

/// Whether every path this moment names sits inside the pinned grant.
///
/// The outbound twin of `enforce_share_view_boundary`'s containment loop,
/// reading the same paths through the same rule. A moment naming one path
/// outside the grant is not this share's to offer, in either direction — and
/// a moment naming no path at all describes no file, so there is nothing to
/// propose.
fn proposal_paths_within_grant(moment: MomentRefs<'_>, granted: &crate::ShareGrant) -> bool {
    let mut named = false;
    for path in moment.paths() {
        named = true;
        if !crate::share::selected_path_within_grant(path, granted) {
            return false;
        }
    }
    named
}

/// One file's net change in a scan, with the object it belongs to and the
/// first and last journal positions it consolidates.
struct NetChange {
    object_id: String,
    first_seq: i64,
    last_seq: i64,
    change: ShareProposalChange,
}

/// What the other lane decided, which a scan reads past or stops at.
struct ScanSkips {
    /// Per object, the journal position through which the other lane already
    /// decided its ops. Those ops are read past; a later op for the same
    /// object starts a change based on what that lane decided.
    settled: BTreeMap<String, i64>,
    /// Objects the other lane is still carrying. The scan stops at the first
    /// op of one, as it stops at its bound.
    stop_at: BTreeSet<String>,
}

/// What one scan of this replica's journal found.
struct ShareProposalScan {
    changes: Vec<NetChange>,
    /// The journal position this scan read through, and the position the
    /// submit records once the relay accepts it. Below `submit_through`
    /// exactly when the change bound stopped the scan early.
    scanned_through: i64,
    more_pending: bool,
    skipped_outside_share: usize,
}

/// One local moment read as a complete net change: the base from its before
/// side, the destination from its after side.
///
/// `rename` is a local label for a moment; a proposal states only what the
/// granter must end up with, and the relay derives the moment's own label from
/// the two paths at accept.
fn proposed_change(op: &ReplicationEnvelope) -> ShareProposalChange {
    let moment = MomentRefs::read(&op.payload);
    ShareProposalChange {
        based_on_path: moment.payload_before.path.map(str::to_owned),
        based_on_blob_sha256: moment
            .payload_before
            .blob_sha256
            .filter(|sha256| valid_sha256(sha256))
            .map(str::to_owned),
        operation: if moment.operation == Some("delete") {
            "delete".to_owned()
        } else {
            "write".to_owned()
        },
        after_path: moment.payload_after.path.map(str::to_owned),
        after_blob_sha256: moment
            .payload_after
            .blob_sha256
            .filter(|sha256| valid_sha256(sha256))
            .map(str::to_owned),
        // The relay accepts exactly two content kinds, so state one of them. A
        // moment carrying neither is text, as on apply.
        after_content_kind: Some(moment.payload_after.content_kind.as_str().to_owned()),
        after_byte_length: op
            .payload
            .get("payloadAfterByteLength")
            .and_then(serde_json::Value::as_i64)
            .filter(|byte_length| *byte_length >= 0),
        recorded_at_ms: op.recorded_at_ms,
    }
}

/// This replica's local moments between `scanned_seq` and `submit_through`,
/// consolidated into one net change per file.
///
/// One moment already states its object's complete post state rather than a
/// delta — `store/delete_rename.rs` copies the before blob into `payloadAfterBlobSha256` for
/// a rename, and `moment_apply.rs` materializes from the after side whatever
/// the operation says. So a run of moments for one object collapses by taking
/// the base from the first and the destination from the last, and a write
/// followed by a rename leaves as one change from the original path to the new
/// one.
///
/// The scan holds at most `MAX_SHARE_PROPOSAL_OPS` files, which is what one
/// submit carries. It stops at the op that would admit one file too many, and
/// reports the position it stopped at, so the next submit resumes from exactly
/// there. Folding more ops into files it already holds is not what the bound
/// counts, so no file is ever offered half consolidated.
///
/// `skips` says what the other lane decided (see `ScanSkips`).
#[allow(clippy::too_many_arguments)]
fn collect_share_proposal_changes(
    store: &EngineStore,
    workspace_id: &str,
    granted: &crate::ShareGrant,
    origin_id: &str,
    scanned_seq: i64,
    submit_through: i64,
    max_read_bytes: usize,
    skips: &ScanSkips,
) -> Result<ShareProposalScan, RelayError> {
    let mut order: Vec<String> = Vec::new();
    let mut by_object: BTreeMap<String, (ShareProposalChange, i64, i64)> = BTreeMap::new();
    let mut outside_share: BTreeSet<String> = BTreeSet::new();
    let mut scanned_through = scanned_seq;
    let mut more_pending = false;
    let mut after = scanned_seq;
    'pages: while after < submit_through {
        let page = list_replication_ops(store, workspace_id, origin_id, after, crate::MAX_PULL_OPS)
            .map_err(local)?;
        let Some(page_last) = page.last().map(|op| op.origin_seq) else {
            break;
        };
        for op in page {
            // The submit bound. An op journaled after the mark this submit
            // read belongs to the next one.
            if op.origin_seq > submit_through {
                break 'pages;
            }
            let moment = match op.op_kind.as_str() {
                "moment.append" => Some(MomentRefs::read(&op.payload)),
                _ => None,
            };
            // An open write stops the scan at its file's first op past what
            // is already settled; a settled op is read past as usual.
            if let Some(object_id) = moment.and_then(|moment| moment.object_id)
                && skips.stop_at.contains(object_id)
                && skips
                    .settled
                    .get(object_id)
                    .is_none_or(|through| op.origin_seq > *through)
            {
                more_pending = true;
                break 'pages;
            }
            if let Some(moment) = moment
                && let Some(object_id) = moment.object_id.map(str::to_owned)
                && !outside_share.contains(&object_id)
                && skips
                    .settled
                    .get(&object_id)
                    .is_none_or(|through| op.origin_seq > *through)
            {
                if !proposal_paths_within_grant(moment, granted) {
                    // One op outside the grant takes the whole file out of
                    // this share's reach. A rename out of the grant must not
                    // leave the file's pre-rename state proposed, so what the
                    // scan already collected for it is dropped too.
                    by_object.remove(&object_id);
                    outside_share.insert(object_id);
                } else {
                    if !by_object.contains_key(&object_id)
                        && by_object.len() >= crate::MAX_SHARE_PROPOSAL_OPS
                    {
                        more_pending = true;
                        break 'pages;
                    }
                    let proof = crate::owner_publication_prefix(
                        store,
                        workspace_id,
                        std::slice::from_ref(&op),
                        max_read_bytes,
                    )
                    .map_err(local)?;
                    if let Some(pending) = proof.pending {
                        return Err(RelayError::Local(format!(
                            "owner-admission-pending: {}:{} {}",
                            pending.origin_id, pending.origin_seq, pending.path
                        )));
                    }
                    let mut change = proposed_change(&op);
                    let mut first_seq = op.origin_seq;
                    match by_object.get(&object_id) {
                        // The base stays the first moment's before side: what
                        // the recipient started from, which is what the
                        // granter has to resolve against its own log.
                        Some((held, held_first, _)) => {
                            change.based_on_path.clone_from(&held.based_on_path);
                            change
                                .based_on_blob_sha256
                                .clone_from(&held.based_on_blob_sha256);
                            first_seq = *held_first;
                        }
                        None => order.push(object_id.clone()),
                    }
                    by_object.insert(object_id, (change, first_seq, op.origin_seq));
                }
            }
            scanned_through = op.origin_seq;
        }
        after = page_last;
    }
    let mut changes = Vec::with_capacity(order.len());
    for object_id in order {
        // A file collected and then taken out of the grant by a later op is
        // gone from `by_object` but still named here.
        let Some((mut change, first_seq, last_seq)) = by_object.remove(&object_id) else {
            continue;
        };
        // A half-stated base names a file without saying what the recipient
        // read, which is exactly what the base rewrite cannot resolve. Both
        // halves travel or neither does.
        if change.based_on_path.is_none() || change.based_on_blob_sha256.is_none() {
            change.based_on_path = None;
            change.based_on_blob_sha256 = None;
        }
        if change.operation == "delete" {
            change.after_path = None;
            change.after_blob_sha256 = None;
            change.after_content_kind = None;
            change.after_byte_length = None;
            // A delete of a file the granter never had removes nothing. The
            // relay refuses that shape, so offering it would fail the whole
            // submit for a change that describes nothing.
            if change.based_on_path.is_none() {
                continue;
            }
        } else if change.after_path.is_none() || change.after_blob_sha256.is_none() {
            // A write with no destination content is not a change anyone can
            // apply.
            continue;
        }
        changes.push(NetChange {
            object_id,
            first_seq,
            last_seq,
            change,
        });
    }
    Ok(ShareProposalScan {
        changes,
        scanned_through,
        more_pending,
        // Saturated at the batch bound, because that is what the contract this
        // count crosses accepts. A larger number is parsed after the submit
        // already succeeded and the scan position already moved on, so it would
        // report a working submit as a failure whose retry offers nothing.
        skipped_outside_share: outside_share.len().min(crate::MAX_SHARE_PROPOSAL_OPS),
    })
}

fn shared_dense_seq_through(
    store: &EngineStore,
    workspace_id: &str,
    origin_id: &str,
    channel_wire_id: &str,
    scanned_seq: i64,
) -> Result<i64, RelayError> {
    let mut dense_seq = -1_i64;
    let mut after = -1_i64;
    while after < scanned_seq {
        let page = list_replication_ops(store, workspace_id, origin_id, after, crate::MAX_PULL_OPS)
            .map_err(local)?;
        let Some(page_last) = page.last().map(|op| op.origin_seq) else {
            break;
        };
        for op in page {
            if op.origin_seq > scanned_seq {
                return Ok(dense_seq);
            }
            // Eligibility only — this walk never sends anything, and building
            // a served payload per op just to drop it clones the whole
            // payload for every op in the log on every push.
            if shared_channel_op_allowed(store, workspace_id, channel_wire_id, &op)? {
                dense_seq = dense_seq
                    .checked_add(1)
                    .ok_or(RelayError::InvalidResponse)?;
            }
        }
        after = page_last;
    }
    Ok(dense_seq)
}

fn shared_channel_op_allowed(
    store: &EngineStore,
    workspace_id: &str,
    channel_wire_id: &str,
    op: &ReplicationEnvelope,
) -> Result<bool, RelayError> {
    if op.op_kind == "chat.channel.create" {
        return Ok(
            op.payload.get("wireId").and_then(serde_json::Value::as_str) == Some(channel_wire_id)
        );
    }
    if op.op_kind == "chat.thread.create" {
        return Ok(op
            .payload
            .get("channelWireId")
            .and_then(serde_json::Value::as_str)
            == Some(channel_wire_id));
    }
    if !matches!(
        op.op_kind.as_str(),
        "chat.message.append" | "chat.decision.set" | "chat.attachment.add" | "chat.reaction.set"
    ) {
        return Ok(false);
    }
    let Some(thread_id) = op
        .payload
        .get("threadId")
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(false);
    };
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_threads t \
                 JOIN chat_channel_wire_ids w \
                   ON w.workspace_id=t.workspace_id AND w.channel_id=t.channel_id \
                 WHERE t.workspace_id=?1 AND t.thread_id=?2 AND w.wire_id=?3)",
                params![workspace_id, thread_id, channel_wire_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .map_err(local)
}

fn replay_id(share_id: &str, envelope: &ReplicationEnvelope, action: &str, path: &str) -> String {
    let mut hash = Sha256::new();
    for value in [
        share_id.as_bytes(),
        envelope.origin_id.as_bytes(),
        envelope.origin_seq.to_string().as_bytes(),
        action.as_bytes(),
        path.as_bytes(),
    ] {
        hash.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_le_bytes());
        hash.update(value);
    }
    hex_sha256(&hash.finalize())
}

struct ShareViewReplayContext<'a, T> {
    transport: &'a T,
    store: &'a mut EngineStore,
    workspace_id: &'a str,
    share_id: &'a str,
    faults: &'a dyn FaultInjector,
    applied: &'a mut usize,
    skipped: &'a mut usize,
    refusals: &'a mut Vec<ShareViewRefusal>,
    changed: &'a mut BTreeMap<String, ShareViewChangedPath>,
    /// Blobs this pull has already refused permanently, by sha256 and the
    /// content kind the op claimed for them. See `blob_refusal_key`.
    blob_refusals: &'a mut BTreeMap<(String, &'static str), RelayError>,
}

/// What a permanent blob refusal is remembered under, and why the pull is the
/// right lifetime for it.
///
/// `replay_share_write` is keyed by PATH — its request record is per path, and
/// a refused write records nothing at all — so before this, every row naming
/// the same blob downloaded and hashed the whole body again. A 256 KiB
/// `version.create` holds thousands of snapshot rows and a blob runs to the
/// kind ceiling, so one refresh could move gigabytes to reach the same
/// refusal thousands of times.
///
/// The decision belongs to the bytes and to the kind the op claims for them:
/// the ceiling is per kind, and so is whether the bytes are text. Never to the
/// path. So the key is the pair, and one row's answer serves every other row
/// that names it.
///
/// The lifetime is the pull rather than the op, because ops repeat a blob too
/// — a granter who shared one oversized file into several versions sends one
/// op per version. What makes that scope safe is what is stored: a decision,
/// not a body. This map cannot grow with the size of the content it describes,
/// which is exactly why caching the authenticated bytes instead would be the
/// new failure — the payload budget admits thousands of distinct shas, and
/// each body may run to the ceiling.
fn blob_refusal_key(sha256: &str, content_kind: &'static str) -> (String, &'static str) {
    (sha256.to_owned(), content_kind)
}

/// Record one refused replay unit, or abort the pull.
///
/// The skip unit is the refusal unit, and the unit is a blob. A
/// `version.create` carries one blob per fork snapshot: refusing one of them
/// says nothing about the others, which are healthy files this recipient can
/// hold. Skipping the whole OP instead dropped every snapshot behind the
/// refused one — permanently, because the cursor commits past the op either
/// way, and silently, because one refusal was recorded for many lost files.
///
/// So each unit is refused on its own and the caller keeps going. What that
/// buys is a property worth stating: after a refused blob, the remaining
/// blobs in the same op are all applied. Never a prefix.
fn refuse_replay_unit<T>(
    context: &mut ShareViewReplayContext<'_, T>,
    refused: &mut Vec<RefusedBlob>,
    path: &str,
    error: RelayError,
) -> Result<(), RelayError> {
    let Some(code) = error.share_replay_refusal_code() else {
        return Err(error);
    };
    *context.skipped += 1;
    refused.push(RefusedBlob {
        code,
        reason: error.to_string(),
        path: path.to_owned(),
    });
    Ok(())
}

/// One blob an op named that this recipient will never apply, and why. The
/// path is carried because the reason alone cannot say which file went
/// missing, and an op can lose several.
///
/// Reason and path are kept apart because they are bounded differently. A
/// reason is bounded by construction: a constraint name, a limit, a unit and
/// an observed count. A path is bounded by nothing — `classify_share_path`
/// admits a tracked path of any length — so a served op would otherwise
/// decide how much of the record every other refusal in the op gets.
struct RefusedBlob {
    code: &'static str,
    reason: String,
    path: String,
}

/// Turn an op's refused blobs into one durable record.
///
/// The recipient's record is keyed by origin coordinate and by nothing else
/// (`mergeShareSkippedOps` in `apps/desktop/src/workspaces/registryStore.ts`),
/// because a re-fetched page must not stack the same op up twice. Every blob
/// in one op shares that coordinate, so emitting a refusal per blob does not
/// give the reader more detail — the record keeps the first and drops the
/// rest, uncounted. Two files would go missing and the notice would say one.
///
/// So the op is the record and the blobs are its contents. The count leads,
/// because `ShareViewRefusal::new` bounds the detail and a list that stops
/// short must still say how many files it is short.
fn record_refused_blobs<T>(
    context: &mut ShareViewReplayContext<'_, T>,
    envelope: &ReplicationEnvelope,
    refused: &[RefusedBlob],
) {
    if refused.is_empty() {
        return;
    }
    context.refusals.push(ShareViewRefusal::new(
        envelope.origin_id.clone(),
        envelope.origin_seq,
        &envelope.op_kind,
        refusal_code(refused),
        refusal_detail(refused),
    ));
}

/// The one code that speaks for however many blobs an op refused.
///
/// The recipient keeps one record per origin coordinate, so a mixed op has to
/// choose, and it reports a class only when every refused blob is in that
/// class. The codes are not interchangeable: `share-blob-over-ceiling` sends
/// the reader to the granter for a smaller file, which is a false instruction
/// for a blob refused because the op described its own content wrongly. So a
/// mixed op falls back to the generic code, which claims nothing it cannot
/// keep.
fn refusal_code(refused: &[RefusedBlob]) -> &'static str {
    refused
        .iter()
        .map(|blob| blob.code)
        .reduce(|left, right| {
            if left == right {
                left
            } else {
                GENERIC_REPLAY_REFUSAL_CODE
            }
        })
        .unwrap_or(GENERIC_REPLAY_REFUSAL_CODE)
}

/// Every refusal the record can hold in full, and an honest count of the rest.
///
/// One entry is `reason — path`: the reason first, so truncation costs a path
/// tail rather than a measurement. That order alone was not enough. The
/// entries were concatenated whole, so entry one's unbounded path spent the
/// budget entry two's measurements needed, and the aggregate put back exactly
/// the rejection the per-entry order had removed.
///
/// Two rules close it. A path gets a budget of its own, and entries are added
/// only while the whole detail still fits — so the record never holds a
/// half-written entry, and it says how many entries it left out.
fn refusal_detail(refused: &[RefusedBlob]) -> String {
    let entries: Vec<String> = refused
        .iter()
        .map(|blob| {
            format!(
                "{} — {}",
                blob.reason,
                elided_path(&blob.path, MAX_REFUSAL_PATH_UNITS)
            )
        })
        .collect();
    // One refused blob needs no count: the record already names one file.
    if let [only] = entries.as_slice() {
        return only.clone();
    }
    let mut listed = 0;
    while listed < entries.len()
        && refusal_list(entries.len(), &entries[..=listed])
            .encode_utf16()
            .count()
            <= MAX_REFUSAL_DETAIL_UNITS
    {
        listed += 1;
    }
    refusal_list(entries.len(), &entries[..listed])
}

/// The count leads, then the entries that fit, then what was left out.
fn refusal_list(total: usize, listed: &[String]) -> String {
    let unlisted = format!("and {} more", total - listed.len());
    let mut parts: Vec<&str> = listed.iter().map(String::as_str).collect();
    if listed.len() < total {
        parts.push(&unlisted);
    }
    format!(
        "{total} files in this operation were not applied: {}",
        parts.join("; ")
    )
}

fn replay_share_view_op<T: RelayTransport>(
    context: &mut ShareViewReplayContext<'_, T>,
    envelope: &ReplicationEnvelope,
) -> Result<(), RelayError> {
    // Every blob this op loses, gathered so the op can be recorded ONCE.
    let mut refused = Vec::new();
    let main_version_id = {
        let mut versioned = VersionedTextStore::new(&mut *context.store);
        versioned
            .ensure_main_version(
                context.workspace_id,
                "main",
                envelope.recorded_at_ms,
                context.faults,
            )
            .map_err(domain)?
            .version_id
    };
    if envelope.op_kind == "moment.append" {
        let moment = MomentRefs::read(&envelope.payload);
        let after_kind = moment.payload_after.content_kind.as_str();
        match moment.operation {
            Some("delete") => {
                if let Some(path) = moment.path {
                    replay_share_delete(
                        &mut *context.store,
                        context.workspace_id,
                        &main_version_id,
                        context.share_id,
                        envelope,
                        path,
                        context.faults,
                        &mut *context.applied,
                        &mut *context.changed,
                    )?;
                }
            }
            Some("rename") => {
                if let (Some(before), Some(after), Some(sha)) = (
                    moment.payload_before.path,
                    moment.after_path(),
                    moment.payload_after.blob_sha256,
                ) {
                    if let Err(error) = replay_share_write(
                        context.transport,
                        &mut *context.store,
                        context.workspace_id,
                        &main_version_id,
                        context.share_id,
                        envelope,
                        after,
                        sha,
                        after_kind,
                        moment.object_id,
                        Some(before),
                        context.faults,
                        &mut *context.applied,
                        &mut *context.changed,
                        &mut *context.blob_refusals,
                    ) {
                        refuse_replay_unit(context, &mut refused, after, error)?;
                    }
                }
            }
            Some("write") => {
                if let (Some(after), Some(sha)) =
                    (moment.after_path(), moment.payload_after.blob_sha256)
                {
                    if let Err(error) = replay_share_write(
                        context.transport,
                        &mut *context.store,
                        context.workspace_id,
                        &main_version_id,
                        context.share_id,
                        envelope,
                        after,
                        sha,
                        after_kind,
                        moment.object_id,
                        None,
                        context.faults,
                        &mut *context.applied,
                        &mut *context.changed,
                        &mut *context.blob_refusals,
                    ) {
                        refuse_replay_unit(context, &mut refused, after, error)?;
                    }
                }
            }
            _ => {}
        }
    } else if envelope.op_kind == "version.create" {
        for snapshot in VersionCreateRefs::read(&envelope.payload).snapshots() {
            let content = snapshot.content;
            if let (Some(path), Some(sha)) = (content.path, content.blob_sha256) {
                // Per SNAPSHOT, so one refused file in a shared version does
                // not take its siblings with it. The loop continues.
                if let Err(error) = replay_share_write(
                    context.transport,
                    &mut *context.store,
                    context.workspace_id,
                    &main_version_id,
                    context.share_id,
                    envelope,
                    path,
                    sha,
                    content.content_kind.as_str(),
                    snapshot.object_id,
                    None,
                    context.faults,
                    &mut *context.applied,
                    &mut *context.changed,
                    &mut *context.blob_refusals,
                ) {
                    refuse_replay_unit(context, &mut refused, path, error)?;
                }
            }
        }
    }
    record_refused_blobs(context, envelope, &refused);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn replay_share_write<T: RelayTransport>(
    transport: &T,
    store: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    share_id: &str,
    envelope: &ReplicationEnvelope,
    path: &str,
    sha256: &str,
    content_kind: &'static str,
    object_id: Option<&str>,
    rename_from: Option<&str>,
    faults: &dyn FaultInjector,
    applied: &mut usize,
    changed: &mut BTreeMap<String, ShareViewChangedPath>,
    blob_refusals: &mut BTreeMap<(String, &'static str), RelayError>,
) -> Result<(), RelayError> {
    // The OP is wrong, not the relay's copy of the blob: this reference is not
    // a sha256, so there is no blob to ask for and no repair that produces one.
    if !valid_sha256(sha256) {
        return Err(RelayError::ShareOpInvalid {
            reason: "share write names a blob reference that is not a sha256",
        });
    }
    // The other question the OP answers about itself, asked here for the same
    // reason: the store door's path rules are pure over the path, so nothing
    // has to be fetched to answer them. Asked after the blob instead, every
    // row naming an unusable path downloaded and hashed a body — up to the
    // kind ceiling, once per row — to reach a refusal the path alone had
    // already decided.
    //
    // The same door `write_text`/`write_binary` open with, not a restatement
    // of its rules, so the two cannot drift — and this is the only place the
    // path class has to be classified. Everything that reaches replay has
    // already passed `classify_share_path`, whose grammar admits no `%`, `\`,
    // `.` or `..` segment, so normalization is the identity on it and the
    // second `validate_path` inside `write_binary_file_in_tx` can no longer
    // find anything this call did not. The writes below therefore keep the
    // plain `domain` mapping.
    dohc_engine_domain::validate_plaintext_storable_path(path).map_err(replayed_domain)?;
    let key = replay_id(
        share_id,
        envelope,
        if rename_from.is_some() {
            "rename"
        } else {
            "write"
        },
        path,
    );
    let request_id = format!("share-view:{key}");
    let already_applied = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_requests WHERE request_id=?1)",
                [&request_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .map_err(local)?;
    if already_applied {
        if let Some(before) = rename_from {
            changed.insert(
                before.to_owned(),
                ShareViewChangedPath {
                    path: before.to_owned(),
                    operation: "delete",
                    content_kind,
                },
            );
        }
        changed.insert(
            path.to_owned(),
            ShareViewChangedPath {
                path: path.to_owned(),
                operation: "write",
                content_kind,
            },
        );
        return Ok(());
    }
    // After the request record, because that one is about this path and this
    // one is about the blob. A row whose write already landed is not refused
    // by a later row's verdict on the same bytes.
    let refusal_key = blob_refusal_key(sha256, content_kind);
    if let Some(refused) = blob_refusals.get(&refusal_key) {
        return Err(refused.clone());
    }
    // Remember a PERMANENT refusal, so the next row naming this blob is
    // answered without fetching it again. Only permanent ones: a transport
    // failure or a corrupt served body aborts the pull, and a retry after the
    // repair must ask the relay rather than a stale verdict.
    let remember = |refusals: &mut BTreeMap<(String, &'static str), RelayError>,
                    error: RelayError| {
        if error.share_replay_refusal_code().is_some() {
            refusals.insert(blob_refusal_key(sha256, content_kind), error.clone());
        }
        error
    };
    // The shared write lands in the store through `write_binary`/`write_text`,
    // which never pass a blob through ingest hydration. Without this the only
    // bound left is the generic 64 MiB blob store, so a share could persist a
    // binary an ordinary capture refuses.
    let (constraint, limit_bytes) = blob_ceiling(if content_kind == "binary" {
        BlobKind::Binary
    } else {
        BlobKind::Text
    });
    let bytes = transport
        .share_blob(ShareBlobRequest {
            share_id: share_id.to_owned(),
            sha256: sha256.to_owned(),
        })
        .map_err(|error| relabel_ceiling(error, constraint, limit_bytes))?
        .bytes;
    // INTEGRITY BEFORE SIZE, and the order is the whole point. "Too large" is
    // a permanent refusal that commits the cursor past the op, and that is only
    // honest about bytes proven to be the ones this op named. Measured first,
    // a relay serving oversized junk for an op naming a small file would be
    // read as the granter's file being too big — permanently dropping content
    // the relay can still serve correctly.
    //
    // Hashing first costs nothing that matters: the body is already wholly in
    // memory and bounded by the transport's own read limit, and the ceiling
    // still refuses before anything reaches the store, which is the floor this
    // check exists to hold.
    if hex_sha256(&bytes) != sha256 {
        return Err(RelayError::BlobInvalid);
    }
    if bytes.len() > limit_bytes {
        return Err(remember(
            blob_refusals,
            RelayError::ShareBlobOverCeiling {
                constraint,
                limit_bytes,
                observed_bytes: bytes.len(),
            },
        ));
    }
    if content_kind != "binary" && std::str::from_utf8(&bytes).is_err() {
        return Err(RelayError::ShareOpInvalid {
            reason: "share write claims text content the shared bytes cannot be",
        });
    }
    if let Some(before) = rename_from {
        let input = dohc_engine_domain::RenameTextFile {
            workspace_id: workspace_id.to_owned(),
            version_id: version_id.to_owned(),
            from_path: before.to_owned(),
            to_path: path.to_owned(),
            moment_id: format!("moment-share-{key}"),
            request_id: Some(request_id.clone()),
            metadata_origin: "sync".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: share_authors::received_authors(envelope),
            now_ms: envelope.recorded_at_ms,
        };
        let result =
            VersionedTextStore::new(store).rename_text_file_with(&input, faults, |tx, result| {
                if result.before.blob_sha256 != sha256
                    || object_id
                        .filter(|id| received_object_token(id))
                        .is_some_and(|id| {
                            result.object.object_id != id
                                && !result.object.object_id.starts_with("object-share-")
                        })
                {
                    return Err(DomainError::InvalidInput {
                        reason: "received rename does not match its object and content",
                    });
                }
                dohc_engine_storage::count_remote_change_in_tx(tx, workspace_id)?;
                Ok(())
            });
        match result {
            Ok(result) => {
                if !result.deduped {
                    *applied = applied.checked_add(1).ok_or(RelayError::InvalidResponse)?;
                }
                changed.insert(
                    before.to_owned(),
                    ShareViewChangedPath {
                        path: before.to_owned(),
                        operation: "delete",
                        content_kind,
                    },
                );
                changed.insert(
                    path.to_owned(),
                    ShareViewChangedPath {
                        path: path.to_owned(),
                        operation: "write",
                        content_kind,
                    },
                );
                return Ok(());
            }
            Err(DomainError::FileNotFound | DomainError::TargetPathExists) => {}
            Err(DomainError::InvalidInput {
                reason: "received rename does not match its object and content",
            }) => {}
            Err(error) => return Err(replayed_domain(error)),
        }
    }
    // The rename receipt covers the fallback write and source delete together.
    let rename_delete = rename_from.map(|before| {
        let key = replay_id(share_id, envelope, "delete", before);
        DeleteTextFile {
            workspace_id: workspace_id.to_owned(),
            version_id: version_id.to_owned(),
            path: before.to_owned(),
            moment_id: format!("moment-share-{key}"),
            request_id: Some(format!("share-view:{key}")),
            metadata_origin: "sync".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: share_authors::received_authors(envelope),
            now_ms: envelope.recorded_at_ms,
        }
    });
    let deduped = {
        if content_kind == "binary" {
            let input = WriteBinary {
                workspace_id: workspace_id.to_owned(),
                version_id: version_id.to_owned(),
                object_id: object_id
                    .filter(|id| received_object_token(id))
                    .map_or_else(|| format!("object-share-{key}"), str::to_owned),
                path: path.to_owned(),
                bytes,
                moment_id: format!("moment-share-{key}"),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: share_authors::received_authors(envelope),
                now_ms: envelope.recorded_at_ms,
                request_id: Some(request_id.clone()),
            };
            replay_share_change(
                store,
                workspace_id,
                faults,
                |tx| {
                    prepare_received_identity(
                        tx,
                        workspace_id,
                        version_id,
                        path,
                        &input.object_id,
                    )?;
                    if let Some(before) = rename_from {
                        rebind_received_rename(
                            tx,
                            workspace_id,
                            version_id,
                            before,
                            path,
                            &input.object_id,
                        )?;
                    }
                    let result = dohc_engine_domain::write_binary_in_tx(tx, &input)?;
                    if let Some(delete) = &rename_delete {
                        delete_received_rename_source_in_tx(tx, delete)?;
                    }
                    Ok(result)
                },
                |result| result.deduped,
            )
            .map_err(domain)?
            .deduped
        } else {
            // These bytes already matched the sha the op named, so they are
            // the content the granter shared. The op calling them text is the
            // defect, and no repair at the relay changes that.
            let text = String::from_utf8(bytes).map_err(|_| {
                remember(
                    blob_refusals,
                    RelayError::ShareOpInvalid {
                        reason: "share write claims text content the shared bytes cannot be",
                    },
                )
            })?;
            let input = WriteText {
                workspace_id: workspace_id.to_owned(),
                version_id: version_id.to_owned(),
                object_id: object_id
                    .filter(|id| received_object_token(id))
                    .map_or_else(|| format!("object-share-{key}"), str::to_owned),
                path: path.to_owned(),
                text,
                moment_id: format!("moment-share-{key}"),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: share_authors::received_authors(envelope),
                now_ms: envelope.recorded_at_ms,
                request_id: Some(request_id),
            };
            replay_share_change(
                store,
                workspace_id,
                faults,
                |tx| {
                    prepare_received_identity(
                        tx,
                        workspace_id,
                        version_id,
                        path,
                        &input.object_id,
                    )?;
                    if let Some(before) = rename_from {
                        rebind_received_rename(
                            tx,
                            workspace_id,
                            version_id,
                            before,
                            path,
                            &input.object_id,
                        )?;
                    }
                    let result = dohc_engine_domain::write_text_in_tx(tx, &input)?;
                    if let Some(delete) = &rename_delete {
                        delete_received_rename_source_in_tx(tx, delete)?;
                    }
                    Ok(result)
                },
                |result| result.deduped,
            )
            .map_err(domain)?
            .deduped
        }
    };
    if !deduped {
        *applied = applied.checked_add(1).ok_or(RelayError::InvalidResponse)?;
    }
    changed.insert(
        path.to_owned(),
        ShareViewChangedPath {
            path: path.to_owned(),
            operation: "write",
            content_kind,
        },
    );
    if let Some(before) = rename_from {
        changed.insert(
            before.to_owned(),
            ShareViewChangedPath {
                path: before.to_owned(),
                operation: "delete",
                content_kind,
            },
        );
    }
    Ok(())
}

// Rebinding can vacate the source before deletion; the rename receipt still covers it.
fn delete_received_rename_source_in_tx(
    tx: &Transaction<'_>,
    input: &DeleteTextFile,
) -> Result<(), DomainError> {
    match dohc_engine_domain::delete_text_in_tx(tx, input) {
        Ok(_) | Err(DomainError::FileNotFound) => Ok(()),
        Err(error) => Err(error),
    }
}

pub(crate) fn received_object_token(id: &str) -> bool {
    id.strip_prefix("share-object:v1:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

// The received head owns this path, including when it displaces an unsubmitted draft.
// Retire its alias and current snapshot so reads cannot expose two heads at one path.
// Draft moments and blobs remain in history; pre-token received stores keep their identity.
fn prepare_received_identity(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    path: &str,
    token: &str,
) -> Result<(), DomainError> {
    if !received_object_token(token) {
        return Ok(());
    }
    let previous: Option<String> = tx.query_row("SELECT object_id FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND path=?3",
        params![workspace_id, version_id, path], |row| row.get(0)).optional().map_err(|err| DomainError::Storage(StorageError::corrupt_public(err)))?;
    if let Some(previous) = previous.filter(|id| id != token && !id.starts_with("object-share-")) {
        tx.execute(
            "DELETE FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![workspace_id, version_id, previous],
        )
        .map_err(|err| DomainError::Storage(StorageError::persist_public(err)))?;
        tx.execute(
            "DELETE FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![workspace_id, version_id, previous],
        )
        .map_err(|err| DomainError::Storage(StorageError::persist_public(err)))?;
    }
    Ok(())
}

// A fallback write keeps the token and its preimage while releasing the old path.
fn rebind_received_rename(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    before: &str,
    after: &str,
    token: &str,
) -> Result<(), DomainError> {
    if !received_object_token(token) {
        return Ok(());
    }
    tx.execute("UPDATE path_aliases SET path=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND path=?5",
        params![workspace_id,version_id,token,after,before])
        .map_err(|err| DomainError::Storage(StorageError::persist_public(err)))?;
    tx.execute("UPDATE snapshots SET path=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND path=?5",
        params![workspace_id,version_id,token,after,before])
        .map_err(|err| DomainError::Storage(StorageError::persist_public(err)))?;
    Ok(())
}

/// Commit one share-view replay, and count it as a change from another
/// computer in the same transaction when it changed the store. The replay's
/// request record makes a repeat a deduped no-op that counts nothing.
fn replay_share_change<T>(
    store: &mut EngineStore,
    workspace_id: &str,
    faults: &dyn FaultInjector,
    change: impl FnOnce(&Transaction<'_>) -> Result<T, DomainError>,
    deduped: impl Fn(&T) -> bool,
) -> Result<T, DomainError> {
    let outcome = store.write_with(faults, |tx| {
        let result = change(tx)?;
        if !deduped(&result) {
            dohc_engine_storage::count_remote_change_in_tx(tx, workspace_id)?;
        }
        Ok::<_, DomainError>(result)
    })?;
    match outcome {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(DomainError::Storage(StorageError::persist_public(
            std::io::Error::other("crash fault fired before ack"),
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
fn replay_share_delete(
    store: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    share_id: &str,
    envelope: &ReplicationEnvelope,
    path: &str,
    faults: &dyn FaultInjector,
    applied: &mut usize,
    changed: &mut BTreeMap<String, ShareViewChangedPath>,
) -> Result<(), RelayError> {
    let existing_kind = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT s.content_kind FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id=a.workspace_id \
                   AND s.version_id=a.version_id AND s.object_id=a.object_id \
                 WHERE a.workspace_id=?1 AND a.version_id=?2 AND a.path=?3",
                params![workspace_id, version_id, path],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(SyncError::corrupt)
        })
        .map_err(local)?
        .flatten();
    let Some(existing_kind) = existing_kind else {
        changed.insert(
            path.to_owned(),
            ShareViewChangedPath {
                path: path.to_owned(),
                operation: "delete",
                content_kind: "text",
            },
        );
        return Ok(());
    };
    let key = replay_id(share_id, envelope, "delete", path);
    let input = DeleteTextFile {
        workspace_id: workspace_id.to_owned(),
        version_id: version_id.to_owned(),
        path: path.to_owned(),
        moment_id: format!("moment-share-{key}"),
        request_id: Some(format!("share-view:{key}")),
        metadata_origin: "sync".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: share_authors::received_authors(envelope),
        now_ms: envelope.recorded_at_ms,
    };
    let result = replay_share_change(
        store,
        workspace_id,
        faults,
        |tx| dohc_engine_domain::delete_text_in_tx(tx, &input),
        |result| result.deduped,
    );
    match result {
        Ok(value) => {
            if !value.deduped {
                *applied = applied.checked_add(1).ok_or(RelayError::InvalidResponse)?;
            }
        }
        Err(DomainError::FileNotFound) => {}
        Err(error) => return Err(domain(error)),
    }
    changed.insert(
        path.to_owned(),
        ShareViewChangedPath {
            path: path.to_owned(),
            operation: "delete",
            content_kind: if existing_kind == "binary" {
                "binary"
            } else {
                "text"
            },
        },
    );
    Ok(())
}

fn string_field<'a>(value: &'a serde_json::Value, name: &str) -> Option<&'a str> {
    value.get(name).and_then(serde_json::Value::as_str)
}

fn domain(error: DomainError) -> RelayError {
    if matches!(error, DomainError::Storage(StorageError::FileLocked)) {
        return RelayError::StoreBusy;
    }
    RelayError::Local(error.code().to_owned())
}

/// A domain failure a share-view REPLAY met, answered by the one question
/// `share_replay_refusal_code` asks: can this op ever succeed?
///
/// PERMANENT for an invalid path. The path is fixed in the served op and the
/// store door's rules are pure over it, so asking again returns the same
/// refusal forever. Under the generic `domain` mapping it became
/// `Local("invalid-path")`, which aborts the pull — the cursor never commits
/// and every op behind the bad path never arrives (the failure mode, on a
/// class that cannot be repaired).
///
/// Only a diverging relay produces one: the granter's own capture writes
/// through this same door, so a path it refuses here was never storable
/// there either. Nobody can act on it, which is why it takes the generic
/// refusal code rather than one that would send the reader to the granter.
///
/// The verdict is not remembered in `blob_refusals`. That map is keyed by the
/// bytes and the kind claimed for them, and this refusal belongs to the PATH:
/// the same blob at a storable path must still apply.
///
/// Every other domain failure keeps the abort. A busy store or a corrupt
/// read says nothing about the op, and skipping past it would drop content
/// this recipient can still receive.
pub(crate) fn replayed_domain(error: DomainError) -> RelayError {
    match error {
        DomainError::InvalidPath { reason } => RelayError::ShareOpInvalid { reason },
        other => domain(other),
    }
}

/// Fold one routed op into its pass. `unready` names its hosted document when
/// that is not ready; the decisions a row of it the journal already held
/// stored go to `redelivered`, by document, for its pass to keep what still
/// stands of them once it has applied ([`crate::hosted::redelivered_unready`]).
#[allow(clippy::too_many_arguments)]
fn accumulate_pull_outcome(
    store: &EngineStore,
    op: &ReplicationEnvelope,
    unready: Option<&str>,
    outcome: ApplyOutcome<crate::RoutedApply>,
    applied: &mut usize,
    refused: &mut usize,
    skipped: &mut usize,
    conflicts_opened: &mut i64,
    changed_paths: &mut ChangedPaths,
    redelivered: &mut BTreeMap<String, ChangedPaths>,
    refusals: &mut Vec<crate::ReplicationRefusal>,
    sharing_declined: &mut Vec<crate::SharingDeclined>,
    record_facts: &mut Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
    keep_automation_claims: impl FnOnce(Vec<dohc_engine_domain::AutomationClaim>),
) -> Result<(), RelayError> {
    let ApplyOutcome {
        primary,
        refusals: drain_refusals,
        sharing_declined: drain_declines,
    } = outcome;
    for refusal in drain_refusals {
        push_refusal_once(refusals, refusal);
    }
    for declined in drain_declines {
        push_sharing_declined_once(sharing_declined, declined);
    }
    match primary {
        ApplyDisposition::Applied(routed) => {
            *conflicts_opened = conflicts_opened
                .checked_add(routed.conflicts_opened)
                .ok_or(RelayError::InvalidResponse)?;
            record_facts.extend(routed.record_facts);
            keep_automation_claims(routed.automation_claims);
            for change in routed.materialization_changes {
                insert_changed_path(changed_paths, change);
            }
            for change in
                crate::router::redelivered_materialization_changes(store, op).map_err(local)?
            {
                insert_changed_path(changed_paths, change);
            }
            *applied = applied.checked_add(1).ok_or(RelayError::InvalidResponse)?;
        }
        ApplyDisposition::Refused(refusal) => {
            *refused = refused.checked_add(1).ok_or(RelayError::InvalidResponse)?;
            push_refusal_once(refusals, refusal);
        }
        ApplyDisposition::Skipped => {
            *conflicts_opened = conflicts_opened
                .checked_add(crate::router::redelivered_conflicts_opened(store, op).map_err(local)?)
                .ok_or(RelayError::InvalidResponse)?;
            if let Some(refusal) = crate::apply::read_replayed_refusal(store, op).map_err(local)? {
                push_refusal_once(refusals, refusal);
            }
            let stored = match unready {
                Some(object_id) => redelivered.entry(object_id.to_owned()).or_default(),
                None => &mut *changed_paths,
            };
            for change in
                crate::router::redelivered_materialization_changes(store, op).map_err(local)?
            {
                insert_changed_path(stored, change);
            }
            *skipped = skipped.checked_add(1).ok_or(RelayError::InvalidResponse)?;
        }
        ApplyDisposition::Crashed { .. } => {
            return Err(RelayError::Local("injected-crash".to_owned()));
        }
    }
    Ok(())
}

/// A pass's materialization decisions, by version and path.
pub(crate) type ChangedPaths = BTreeMap<(String, String), crate::MomentMaterializationChange>;

/// A page's changes in the order they apply: every delete, then every write,
/// each in path order. A disk that ignores case or Unicode normalization
/// opens `Notes.md` as the `notes.md` that a rename deletes, so a write that
/// ran first would go with that delete.
pub(crate) fn page_order<T>(
    changes: impl IntoIterator<Item = T>,
    operation: impl Fn(&T) -> &str,
) -> Vec<T> {
    let (mut page, writes): (Vec<T>, Vec<T>) = changes
        .into_iter()
        .partition(|change| operation(change) == "delete");
    page.extend(writes);
    page
}

pub(crate) fn insert_changed_path(
    changed_paths: &mut ChangedPaths,
    change: crate::MomentMaterializationChange,
) {
    changed_paths.insert((change.version_id.clone(), change.path.clone()), change);
}

fn push_refusal_once(
    refusals: &mut Vec<crate::ReplicationRefusal>,
    refusal: crate::ReplicationRefusal,
) {
    if !refusals.iter().any(|existing| {
        existing.workspace_id == refusal.workspace_id
            && existing.origin_id == refusal.origin_id
            && existing.origin_seq == refusal.origin_seq
    }) {
        refusals.push(refusal);
    }
}

fn push_sharing_declined_once(
    declines: &mut Vec<crate::SharingDeclined>,
    declined: crate::SharingDeclined,
) {
    if let Some(existing) = declines
        .iter_mut()
        .find(|item| item.version_id == declined.version_id && item.object_id == declined.object_id)
    {
        *existing = declined;
    } else {
        declines.push(declined);
    }
}

fn push_shared_channel_rejection(
    refused: &mut usize,
    rejections: &mut Vec<SharedChannelRejection>,
    refusal: crate::ReplicationRefusal,
) -> Result<(), RelayError> {
    *refused = refused.checked_add(1).ok_or(RelayError::InvalidResponse)?;
    rejections.push(SharedChannelRejection {
        origin_id: refusal.origin_id,
        origin_seq: refusal.origin_seq,
        op_kind: refusal.op_kind,
        reason: refusal.reason.message().to_owned(),
    });
    Ok(())
}

fn validate_identity_request(workspace: &str, epoch: &str, stream: &str) -> Result<(), RelayError> {
    crate::model::bounded(workspace, "workspace_id must be non-empty and bounded")
        .map_err(local)?;
    crate::model::bounded(epoch, "replication_epoch must be non-empty and bounded")
        .map_err(local)?;
    crate::model::bounded(stream, "stream_identity must be non-empty and bounded").map_err(local)
}

// The busy store keeps its type across this boundary. Both funnels answer it
// the same way, so a relay operation refused for contention reaches the wire
// as the retryable class no matter which taxonomy it came through.
fn local(error: SyncError) -> RelayError {
    match error {
        SyncError::Storage(StorageError::FileLocked) => RelayError::StoreBusy,
        SyncError::ValidationPending(pending) => RelayError::ValidationPending(pending),
        error if matches!(error.original(), SyncError::RetryableState { .. }) => {
            RelayError::Local(format!("{}: {error}", error.code()))
        }
        error => RelayError::Local(error.code().to_owned()),
    }
}

fn retryable_refusal<'a>(
    refusals: impl IntoIterator<Item = (&'a ReplicationEnvelope, &'static str)>,
) -> RelayError {
    let mut refusals = refusals.into_iter();
    let Some((op, reason)) = refusals.next() else {
        return RelayError::Local("retryable-state".to_owned());
    };
    let object = crate::hosted::hosted_document(op)
        .map(|id| format!("object {id}, "))
        .unwrap_or_default();
    let mut detail = format!(
        "retryable-state: {} ({object}origin {} seq {})",
        SyncError::RetryableState { reason },
        op.origin_id,
        op.origin_seq,
    );
    let remaining = refusals.count();
    if remaining > 0 {
        detail.push_str(&format!("; and {remaining} more"));
    }
    RelayError::Local(detail)
}

/// A hosted feed request on a transport built for an ordinary replica.
pub fn no_hosted_feed() -> RelayError {
    RelayError::HostedRefusal("relay transport serves no hosted feed")
}

/// An ordinary relay operation or route on a hosted replica, which reaches
/// only the session host's scoped feed.
pub fn hosted_feed_only() -> RelayError {
    RelayError::HostedRefusal("a hosted replica uses only its hosted feed")
}

#[cfg(test)]
mod push_budget_tests {
    use super::*;

    #[test]
    fn upload_uses_page_wide_kinds_for_a_digest_shared_by_binary_and_text_ops() {
        for stored_as_text in [true, false] {
            let (_scratch, _path, mut store) = dohc_engine_testkit::open_store();
            let bytes = b"shared content";
            let sha = hex_sha256(bytes);
            store
                .write_with(&dohc_engine_storage::NoFaults, |tx| {
                    if stored_as_text {
                        tx.execute(
                            "INSERT INTO blobs(sha256,byte_length,text) VALUES (?1,?2,?3)",
                            rusqlite::params![sha, bytes.len() as i64, "shared content"],
                        )
                        .map_err(SyncError::persist)?;
                    } else {
                        tx.execute(
                            "INSERT INTO binary_blobs(sha256,byte_length,bytes) VALUES (?1,?2,?3)",
                            rusqlite::params![sha, bytes.len() as i64, bytes.as_slice()],
                        )
                        .map_err(SyncError::persist)?;
                    }
                    Ok::<_, SyncError>(())
                })
                .unwrap();
            let identity = crate::SyncIdentity {
                workspace_id: "ws".into(),
                origin_id: "local".into(),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
            };
            let kinds = if stored_as_text {
                ["binary", "text"]
            } else {
                ["text", "binary"]
            };
            let ops: Vec<_> = kinds
                .into_iter()
                .enumerate()
                .map(|(index, kind)| ReplicationEnvelope {
                    settlement_admission: None,
                    admitted_author_snapshot: None,
                    workspace_id: "ws".into(),
                    origin_id: "local".into(),
                    origin_seq: index as i64,
                    relay_seq: None,
                    op_kind: "moment.append".into(),
                    recorded_at_ms: 1,
                    payload: serde_json::json!({ "payloadAfterBlobSha256": sha,
                    "payloadAfterContentKind": kind }),
                })
                .collect();
            let mut page = PreparedPushPage {
                identity: identity.clone(),
                origin_id: "local".into(),
                cursor: -1,
                revision: 0,
                blob_refs: collect_blob_refs(&ops).unwrap(),
                ops,
                prefix: crate::OwnerPublicationPrefix {
                    allowed_ops: 2,
                    pending: None,
                    budget_exhausted: false,
                },
                missing: BTreeSet::from([sha]),
                inventory: VecDeque::new(),
                uploaded_ops: 0,
                sending: None,
            };
            let client = RelaySyncClient::new(crate::tests::FakeRelay::default());
            assert_eq!(
                client
                    .upload_push_prefix(
                        &store,
                        "ws",
                        &identity,
                        &mut page,
                        std::time::Instant::now(),
                        &mut BTreeSet::new(),
                    )
                    .unwrap(),
                2
            );
            assert!(page.missing.is_empty());
        }
    }

    #[test]
    fn elapsed_upload_budget_finishes_one_operation_and_leaves_a_prefix() {
        let (_scratch, _path, store) = dohc_engine_testkit::open_store();
        let identity = crate::SyncIdentity {
            workspace_id: "ws".into(),
            origin_id: "local".into(),
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
        };
        let mut page = PreparedPushPage {
            identity: identity.clone(),
            origin_id: "local".into(),
            cursor: -1,
            revision: 0,
            ops: (0..2)
                .map(|origin_seq| ReplicationEnvelope {
                    settlement_admission: None,
                    admitted_author_snapshot: None,
                    workspace_id: "ws".into(),
                    origin_id: "local".into(),
                    origin_seq,
                    relay_seq: None,
                    op_kind: "probe.safe".into(),
                    payload: serde_json::json!({}),
                    recorded_at_ms: 1,
                })
                .collect(),
            prefix: crate::OwnerPublicationPrefix {
                allowed_ops: 2,
                pending: None,
                budget_exhausted: false,
            },
            blob_refs: BTreeMap::new(),
            inventory: VecDeque::new(),
            missing: BTreeSet::new(),
            uploaded_ops: 0,
            sending: None,
        };
        let client = RelaySyncClient::new(crate::tests::FakeRelay::default());
        let started = std::time::Instant::now() - PUSH_PRE_APPEND_BUDGET;
        assert_eq!(
            client
                .upload_push_prefix(
                    &store,
                    "ws",
                    &identity,
                    &mut page,
                    started,
                    &mut BTreeSet::new()
                )
                .unwrap(),
            1
        );
        assert_eq!(page.uploaded_ops, 1);
        assert_eq!(page.ops.len(), 2);
    }
}

#[cfg(test)]
mod pull_page_validation_tests {
    use super::{PullResponse, ReplicationEnvelope, validate_pull_page};
    use crate::RelayError;

    fn op(relay_seq: Option<i64>) -> ReplicationEnvelope {
        ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "ws".to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: 0,
            relay_seq,
            op_kind: "opaque.test".to_owned(),
            payload: serde_json::json!({}),
            recorded_at_ms: 1,
        }
    }

    #[test]
    fn pull_page_allows_gaps_but_requires_one_global_order_before_apply() {
        validate_pull_page(
            &PullResponse {
                ops: vec![op(Some(12)), op(Some(15))],
                next_cursor: 15,
                has_more: false,
            },
            "ws",
            10,
        )
        .expect("gaps are valid when the page remains strictly ordered");

        for invalid in [
            PullResponse {
                ops: vec![op(None)],
                next_cursor: 11,
                has_more: false,
            },
            PullResponse {
                ops: vec![op(Some(10))],
                next_cursor: 10,
                has_more: false,
            },
            PullResponse {
                ops: vec![op(Some(12)), op(Some(11))],
                next_cursor: 11,
                has_more: false,
            },
            PullResponse {
                ops: vec![op(Some(12))],
                next_cursor: 11,
                has_more: false,
            },
            PullResponse {
                ops: vec![op(Some(12))],
                next_cursor: 13,
                has_more: false,
            },
        ] {
            assert_eq!(
                validate_pull_page(&invalid, "ws", 10),
                Err(RelayError::InvalidResponse)
            );
        }
    }

    #[test]
    fn only_a_hosted_page_may_end_past_its_last_op() {
        let scope = super::HostedScope {
            token: "scope".to_owned(),
            documents: Vec::new(),
        };
        for (ops, next_cursor) in [(vec![op(Some(12))], 15), (Vec::new(), 15)] {
            let hosted = super::HostedPullResponse {
                scope: scope.clone(),
                ops: ops.clone(),
                next_cursor,
                has_more: false,
            };
            super::validate_hosted_page(&hosted, "ws", 10)
                .expect("the scoped feed's cursor passes rows it withholds");
            let ordinary = PullResponse {
                ops,
                next_cursor,
                has_more: false,
            };
            assert_eq!(
                validate_pull_page(&ordinary, "ws", 10),
                Err(RelayError::InvalidResponse)
            );
        }
        for invalid in [
            super::HostedPullResponse {
                scope: scope.clone(),
                ops: vec![op(Some(16))],
                next_cursor: 15,
                has_more: false,
            },
            super::HostedPullResponse {
                scope: scope.clone(),
                ops: vec![op(Some(10))],
                next_cursor: 15,
                has_more: false,
            },
            super::HostedPullResponse {
                scope,
                ops: Vec::new(),
                next_cursor: 9,
                has_more: false,
            },
        ] {
            assert_eq!(
                super::validate_hosted_page(&invalid, "ws", 10),
                Err(RelayError::InvalidResponse)
            );
        }
    }
}

#[cfg(test)]
mod sharing_decline_tests {
    use super::push_sharing_declined_once;

    fn decline(path: &str) -> crate::SharingDeclined {
        crate::SharingDeclined {
            object_id: path.to_owned(),
            version_id: "main".to_owned(),
            lineage_pruned: false,
            head_blob_sha256: None,
            path: path.to_owned(),
            constraint: "MAX_YDOC_UPDATE_BYTES",
            limit_bytes: 20,
            observed_bytes: 21,
        }
    }

    #[test]
    fn merged_declines_follow_an_object_across_a_rename() {
        let original = decline("notes/original.md");
        let renamed = crate::SharingDeclined {
            path: "notes/renamed.md".to_owned(),
            lineage_pruned: true,
            ..original.clone()
        };
        let mut declines = Vec::new();
        push_sharing_declined_once(&mut declines, original);
        push_sharing_declined_once(&mut declines, renamed.clone());
        assert_eq!(declines, [renamed]);
    }

    #[test]
    fn sharing_declines_keep_the_same_object_in_distinct_versions() {
        let main = decline("notes/large.md");
        let draft = crate::SharingDeclined {
            version_id: "draft".to_owned(),
            ..main.clone()
        };
        let renamed_draft = crate::SharingDeclined {
            path: "notes/renamed.md".to_owned(),
            ..draft.clone()
        };
        let mut declines = Vec::new();
        push_sharing_declined_once(&mut declines, main.clone());
        push_sharing_declined_once(&mut declines, draft);
        push_sharing_declined_once(&mut declines, renamed_draft.clone());
        assert_eq!(declines, [main, renamed_draft]);
    }

    #[test]
    fn equal_sized_declines_for_distinct_objects_do_not_collapse() {
        let mut declines = Vec::new();

        push_sharing_declined_once(&mut declines, decline("notes/first.md"));
        push_sharing_declined_once(&mut declines, decline("notes/second.md"));
        push_sharing_declined_once(&mut declines, decline("notes/first.md"));

        assert_eq!(
            declines
                .iter()
                .map(|declined| declined.path.as_str())
                .collect::<Vec<_>>(),
            ["notes/first.md", "notes/second.md"]
        );
    }
}

#[cfg(test)]
mod changed_path_tests {
    use std::collections::BTreeMap;

    use super::insert_changed_path;

    #[test]
    fn same_path_in_two_versions_keeps_both_materialization_changes() {
        let mut changed = BTreeMap::new();
        for version_id in ["main", "feature"] {
            insert_changed_path(
                &mut changed,
                crate::MomentMaterializationChange {
                    version_id: version_id.to_owned(),
                    path: ".env".to_owned(),
                    operation: "write",
                    content_kind: "secret",
                },
            );
        }

        assert_eq!(changed.len(), 2);
        assert!(changed.contains_key(&("main".to_owned(), ".env".to_owned())));
        assert!(changed.contains_key(&("feature".to_owned(), ".env".to_owned())));
    }
}

#[cfg(test)]
mod conflict_resolve_blob_ref_tests {
    use std::collections::{BTreeMap, BTreeSet};

    use super::{BlobKind, ReplicationEnvelope, collect_blob_refs};
    use crate::conflict_resolve_v1::{
        ConflictResolveV1, EffectContextV1, HeadContentKindV1, HeadV1, LineageTransitionV1,
        MetadataV1, PresentHeadV1, ResolutionV1, ResolveChoiceV1, SuccessorContentKindV1,
        SuccessorV1, build_conflict_resolve_v1,
    };

    #[test]
    fn native_event_zero_keeps_the_ydoc_blob_ceiling() {
        let sha = "a".repeat(64);
        let envelope = ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "workspace".into(),
            origin_id: "owner".into(),
            origin_seq: 0,
            relay_seq: None,
            op_kind: "live.audit.base".into(),
            payload: serde_json::json!({"record":{"checkpoint":{"stateDigest":sha}}}),
            recorded_at_ms: 0,
        };
        assert_eq!(
            collect_blob_refs(&[envelope]).unwrap(),
            BTreeMap::from([(sha, BTreeSet::from([BlobKind::Ydoc]))])
        );
    }

    #[test]
    fn native_settlement_keeps_projection_in_the_text_blob_lane() {
        let sha = "a".repeat(64);
        let envelope = ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "workspace".into(),
            origin_id: "owner".into(),
            origin_seq: 0,
            relay_seq: None,
            op_kind: "live.audit.settlement".into(),
            payload: serde_json::json!({"record":{"markdownDigest":sha}}),
            recorded_at_ms: 0,
        };
        assert_eq!(
            collect_blob_refs(&[envelope]).unwrap(),
            BTreeMap::from([(sha, BTreeSet::from([BlobKind::Text]))])
        );
    }

    #[test]
    fn live_application_audit_keeps_update_and_metadata_in_their_existing_blob_lanes() {
        let update = "a".repeat(64);
        let chunk = "b".repeat(64);
        let envelope = ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "workspace".into(),
            origin_id: "owner".into(),
            origin_seq: 0,
            relay_seq: None,
            op_kind: "live.audit.application".into(),
            payload: serde_json::json!({"updateBlobSha256":update,"manifest":{"chunks":[{"sha256":chunk},{"sha256":chunk}]}}),
            recorded_at_ms: 0,
        };
        assert_eq!(
            collect_blob_refs(&[envelope]).unwrap(),
            BTreeMap::from([
                (update, BTreeSet::from([BlobKind::Ydoc])),
                (chunk, BTreeSet::from([BlobKind::Binary]))
            ])
        );
    }

    #[test]
    fn conflict_resolve_collects_text_binary_and_successor_roots() {
        let text_sha = dohc_engine_storage::hex_sha256(b"current text");
        let binary_sha = dohc_engine_storage::hex_sha256(b"incoming binary");
        let successor_sha = dohc_engine_storage::hex_sha256(b"successor base");
        let state_vector_sha = dohc_engine_storage::hex_sha256(b"successor state vector");
        let current = HeadV1::Present(PresentHeadV1 {
            path_ref: 0,
            object_id: "object-current".to_owned(),
            latest_moment_id: "moment-current".to_owned(),
            content_kind: HeadContentKindV1::Text,
            blob_sha256: text_sha.clone(),
            byte_length: 12,
            updated_at_ms: 10,
        });
        let built = build_conflict_resolve_v1(ConflictResolveV1 {
            workspace_id: "workspace-carrier-roots".to_owned(),
            conflict_id: "conflict-carrier-roots".to_owned(),
            chosen_from: ResolveChoiceV1::Current,
            resolution: ResolutionV1::KeptCurrent,
            target_version_id: "main".to_owned(),
            source_version_id: "peer-main".to_owned(),
            paths: vec![
                "notes/current.md".to_owned(),
                "notes/incoming.bin".to_owned(),
            ],
            current: current.clone(),
            incoming: HeadV1::Present(PresentHeadV1 {
                path_ref: 1,
                object_id: "object-incoming".to_owned(),
                latest_moment_id: "moment-incoming".to_owned(),
                content_kind: HeadContentKindV1::Binary,
                blob_sha256: binary_sha.clone(),
                byte_length: 15,
                updated_at_ms: 11,
            }),
            result: current,
            effect_context: EffectContextV1 {
                recorded_at_ms: 12,
                metadata: MetadataV1 {
                    origin: "api".to_owned(),
                    summary: None,
                    correlation_id: None,
                },
                author: None,
                current_object_created_at_ms: Some(1),
                result_object_created_at_ms: Some(1),
            },
            effects: Vec::new(),
            exported_before: None,
            lineage_transition: Some(LineageTransitionV1 {
                predecessor_claim_id: dohc_engine_storage::hex_sha256(b"predecessor"),
                predecessor_state_vector_sha256: dohc_engine_storage::hex_sha256(
                    b"predecessor state vector",
                ),
                predecessor_delete_set_sha256: dohc_engine_storage::hex_sha256(
                    b"predecessor full state",
                ),
                artifact_preimage_sha256: text_sha.clone(),
                successor: Some(SuccessorV1 {
                    lineage_claim_id: successor_sha.clone(),
                    epoch_tag: dohc_engine_storage::hex_sha256(b"successor epoch"),
                    content_kind: SuccessorContentKindV1::Plaintext,
                    result_sha256: text_sha.clone(),
                    update_blob_sha256: successor_sha.clone(),
                    state_vector_blob_sha256: state_vector_sha.clone(),
                }),
            }),
        })
        .expect("valid conflict.resolve carrier");
        let envelope = ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "workspace-carrier-roots".to_owned(),
            origin_id: "origin-a".to_owned(),
            origin_seq: 0,
            relay_seq: None,
            op_kind: "conflict.resolve".to_owned(),
            payload: built.value,
            recorded_at_ms: 12,
        };

        let refs = collect_blob_refs(&[envelope]).expect("collect carrier roots");
        let expected = BTreeMap::from([
            (text_sha, BTreeSet::from([BlobKind::Text])),
            (binary_sha, BTreeSet::from([BlobKind::Binary])),
            (successor_sha, BTreeSet::from([BlobKind::Ydoc])),
            (state_vector_sha, BTreeSet::from([BlobKind::Ydoc])),
        ]);
        assert_eq!(refs, expected);
    }
}

#[cfg(test)]
mod refusal_tests {
    use super::*;

    #[test]
    fn local_retryable_refusal_keeps_its_reason() {
        let error = local(SyncError::RetryableState {
            reason: "ydoc-resulting-head-pending",
        });
        assert!(
            matches!(&error, RelayError::Local(code) if code.split(':').next() == Some("retryable-state"))
        );
        assert!(error.to_string().contains("ydoc-resulting-head-pending"));
    }

    #[test]
    fn local_retryable_refusal_keeps_its_reason_and_bounds_pull_detail() {
        let op = ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "ws".into(),
            origin_id: "peer".into(),
            origin_seq: 7,
            relay_seq: Some(7),
            op_kind: "ydoc.update".into(),
            payload: serde_json::json!({"objectId": "apollo"}),
            recorded_at_ms: 0,
        };
        let first = (&op, "ydoc-resulting-head-pending");
        assert_eq!(
            retryable_refusal([first]).to_string(),
            "local sync state failed: retryable-state: replication state is not ready: ydoc-resulting-head-pending (object apollo, origin peer seq 7)",
        );
        assert_eq!(
            retryable_refusal(
                std::iter::once(first).chain(std::iter::repeat_n((&op, "other reason"), 499))
            )
            .to_string(),
            "local sync state failed: retryable-state: replication state is not ready: ydoc-resulting-head-pending (object apollo, origin peer seq 7); and 499 more",
        );
        let without_object = ReplicationEnvelope {
            payload: serde_json::json!({}),
            ..op
        };
        assert_eq!(
            retryable_refusal([(&without_object, "ydoc-resulting-head-pending")]).to_string(),
            "local sync state failed: retryable-state: replication state is not ready: ydoc-resulting-head-pending (origin peer seq 7)",
        );
        assert!(
            matches!(retryable_refusal([]), RelayError::Local(detail) if detail == "retryable-state")
        );
    }
}
