use std::collections::{BTreeMap, BTreeSet};

use dohc_engine_domain::{DeleteTextFile, DomainError, VersionedTextStore, WriteBinary, WriteText};
use dohc_engine_storage::{
    EngineStore, FaultInjector, FaultPoint, StorageError, TxnOutcome, hex_sha256,
};
use rusqlite::{OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};

use crate::apply::apply_chat_lww_projection_tx;
use crate::cursor::{
    RelayCursor, commit_relay_cursor, has_relay_position, read_pushed_seq, rewind_pushed_seq,
    write_pushed_seq,
};
use crate::error::GENERIC_REPLAY_REFUSAL_CODE;
use crate::journal::{crashes, list_replication_ops, read_sync_identity};
use crate::{
    ApplyOutcome, BlobContent, BlobHydration, BlobKind, ObservedBytes, RelayError,
    ReplicationEnvelope, ShareDisposition, SyncError, blob_ceiling, hydrate_blob_content,
};

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
    pub accepted: usize,
    pub inserted: usize,
    pub skipped: usize,
    pub current_max_origin_seq: i64,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobUploadRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub sha256: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobDownloadRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobDownloadResponse {
    pub bytes: Vec<u8>,
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
/// before the submit that references it (#646 PR3a). The relay refuses a batch
/// naming a blob it does not hold, at submit and again at accept, so content
/// travels first and the ops travel second — the same ordering the owner's own
/// drain uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareBlobUploadRequest {
    pub share_id: String,
    pub sha256: String,
    pub bytes: Vec<u8>,
}

/// ONE net change to ONE file: "the file you have at `based_on_path` with
/// content `based_on_blob_sha256` should now be at `after_path` with content
/// `after_blob_sha256`" — or, for a delete, should be gone.
///
/// Deliberately NOT a replayed moment. The served moment drops `momentId`,
/// `objectId` and every `before*` field, so a recipient never learns a granter
/// moment id and could not state a lineage the granter recognizes. The base
/// pair is the one identifier both sides genuinely share, and the relay
/// resolves it to the granter's own moment at accept.
#[derive(Debug, Clone, PartialEq, Eq)]
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
    pub origin_id: String,
    pub ops: Vec<ShareProposalChange>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareProposalSubmitResponse {
    pub proposal_id: String,
    pub ops: usize,
    /// Whether this submit created the proposal. `false` is the idempotent
    /// repeat answering with the proposal it already held.
    pub created: bool,
}

/// What one submit offered. `proposal_id` is `None` exactly when nothing was
/// offered — a share below edit level, or a scan that found no change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareProposalSubmitOutcome {
    pub submitted: usize,
    pub proposal_id: Option<String>,
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
/// to parse. The relay picks these values, so they are normalized HERE, where
/// the refusal is built — a diagnostic must be well formed whatever it is
/// diagnosing.
const MAX_REFUSAL_OP_KIND_UNITS: usize = 128;
pub(crate) const MAX_REFUSAL_DETAIL_UNITS: usize = 2048;

/// The path budget inside ONE refusal listed in a detail, in UTF-16 units.
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

/// A path cut to `budget`, with the cut MARKED and BOTH ends kept.
///
/// A head-only cut was silent and lossy in the same stroke: two refused files
/// that differ past the budget recorded identically, and the record is all the
/// reader has once the cursor has committed past them. Since a healthy path
/// outgrows this budget (see `MAX_REFUSAL_PATH_UNITS`), that was the ordinary
/// case rather than a corner.
///
/// So the tail is taken first — the file name is the identifying part, and the
/// stated recovery is to go ask the granter about a named file — and the
/// marker carries how many units went, so two paths that share a head AND a
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

/// The LAST `limit` UTF-16 units of `value`, whole characters only.
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
    /// How far the share has been READ, not how much of it applied. It
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
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError>;
    fn pull(&self, req: PullRequest) -> Result<PullResponse, RelayError>;
    fn lookup_log_coordinate(
        &self,
        req: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError>;
    fn probe(&self, req: ProbeRequest) -> Result<ProbeResponse, RelayError>;
    fn claim_workspace(&self, req: ClaimRequest) -> Result<ClaimResponse, RelayError>;
    fn rotate_epoch(&self, req: EpochRequest) -> Result<EpochResponse, RelayError>;
    fn blobs_have(&self, req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError>;
    fn upload_blob(&self, req: BlobUploadRequest) -> Result<(), RelayError>;
    fn download_blob(&self, req: BlobDownloadRequest) -> Result<BlobDownloadResponse, RelayError>;
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
    /// POST to a share's log. ONE surface for both share kinds: the route is
    /// per-share and the relay scopes the batch by the share's own selector,
    /// so the pusher names no channel and no path (#646 PR2).
    fn share_log_push(&self, req: ShareLogPushRequest) -> Result<PushResponse, RelayError>;
    fn share_view_pull(&self, req: ShareViewRequest) -> Result<ShareViewResponse, RelayError>;
    fn share_blob(&self, req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError>;
    fn share_blob_upload(&self, req: ShareBlobUploadRequest) -> Result<(), RelayError>;
    fn share_proposal_submit(
        &self,
        req: ShareProposalSubmitRequest,
    ) -> Result<ShareProposalSubmitResponse, RelayError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncPassOutcome {
    Complete {
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
    },
}

pub struct RelaySyncClient<T> {
    transport: T,
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

struct PendingDeferredRelayRepair {
    origin_id: String,
    origin_seq: i64,
    op_kind: String,
    payload: serde_json::Value,
    recorded_at_ms: i64,
}

impl<T: RelayTransport> RelaySyncClient<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }

    fn repair_pending_ydoc_base_orders(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        identity: &crate::journal::SyncIdentity,
        faults: &dyn FaultInjector,
    ) -> Result<(), RelayError> {
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

        let local_pushed_seq =
            read_pushed_seq(store, workspace_id, &identity.origin_id).map_err(local)?;
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
        let mut deferred_repairs = Vec::new();
        for (origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) in deferred {
            let repair = PendingDeferredRelayRepair {
                origin_id,
                origin_seq,
                op_kind,
                payload: serde_json::from_str(&payload_json)
                    .map_err(|error| local(SyncError::corrupt(error)))?,
                recorded_at_ms,
            };
            let response = self.transport.lookup_log_coordinate(LogCoordinateRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                origin_id: repair.origin_id.clone(),
                origin_seq: repair.origin_seq,
            })?;
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
                        && local_pushed_seq < repair.origin_seq =>
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
            let response = self.transport.lookup_log_coordinate(LogCoordinateRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                origin_id: repair.origin_id.clone(),
                origin_seq: repair.origin_seq,
            })?;
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
                        && local_pushed_seq < repair.origin_seq =>
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

        for candidates in grouped.into_values() {
            let resolved = candidates
                .iter()
                .filter_map(|(repair, relay_seq, _)| relay_seq.map(|relay_seq| (repair, relay_seq)))
                .min_by_key(|(_, relay_seq)| *relay_seq);
            let (chosen, relay_seq) = match resolved {
                Some((repair, relay_seq)) => (repair, Some(relay_seq)),
                None if candidates.iter().any(|(_, _, unresolved)| *unresolved) => continue,
                None => (&candidates[0].0, None),
            };
            match store
                .write_with(faults, |tx| {
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
                    )?;
                    if relay_seq.is_none() {
                        dohc_engine_collab::mark_base_coordinate_absent_in_tx(
                            tx,
                            &chosen.key,
                            &chosen.lineage_claim_id,
                            &chosen.origin_id,
                            chosen.origin_seq,
                            chosen.recorded_at_ms,
                        )?;
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
                    .map_err(|error| {
                        dohc_engine_collab::CollabError::Storage(StorageError::persist_public(
                            error,
                        ))
                    })?;
                    Ok(())
                })
                .map_err(|error| match error {
                    dohc_engine_collab::CollabError::Storage(storage) => {
                        local(SyncError::Storage(storage))
                    }
                    hard => local(SyncError::Storage(StorageError::corrupt_public(hard))),
                })? {
                TxnOutcome::Committed(()) => {}
                TxnOutcome::Crashed { .. } => return Err(local(SyncError::FaultCrash)),
            }
        }
        for (origin_id, origin_seq, relay_seq) in deferred_repairs {
            match store
                .write_with(faults, |tx| {
                    let changed = tx
                        .execute(
                            "UPDATE ydoc_deferred_updates SET relay_seq=?4
                              WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3
                                AND relay_seq IS NULL",
                            params![workspace_id, origin_id, origin_seq, relay_seq],
                        )
                        .map_err(SyncError::persist)?;
                    if changed != 1 {
                        return Err(SyncError::CoordinateDiverged);
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
        now_ms: i64,
    ) -> Result<SyncPassOutcome, RelayError> {
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let mut origins = list_workspace_origins(store, workspace_id).map_err(local)?;
        let mut pushed = 0_usize;
        let mut sharing_declined = Vec::new();

        let has_position = store
            .read_with(|conn| has_relay_position(conn, workspace_id))
            .map_err(local)?;
        if origins.is_empty() && !has_position {
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
                now_ms,
            )
            .map_err(local)?
            {
                TxnOutcome::Committed(declined) => sharing_declined.extend(declined),
                TxnOutcome::Crashed { .. } => {
                    return Ok(SyncPassOutcome::CrashedAfterRemoteCommit);
                }
            }
            // Re-read so the probe's same-transaction backfill enters the push loop.
            origins = list_workspace_origins(store, workspace_id).map_err(local)?;
        }

        for origin_id in origins {
            let mut local_max =
                local_max_origin_seq(store, workspace_id, &origin_id).map_err(local)?;
            let mut cursor = read_pushed_seq(store, workspace_id, &origin_id).map_err(local)?;
            let mut attempt = 0_u8;

            loop {
                let ops = list_replication_ops(
                    store,
                    workspace_id,
                    &origin_id,
                    cursor,
                    crate::MAX_PULL_OPS,
                )
                .map_err(local)?;
                if ops.is_empty() {
                    break;
                }
                self.upload_missing_blobs(store, workspace_id, &identity, &ops)?;

                let mut conflict = false;
                for batch in ops.chunks(crate::MAX_PUSH_OPS_PER_BATCH) {
                    let response = match self.transport.push(PushRequest {
                        workspace_id: workspace_id.to_owned(),
                        replication_epoch: identity.replication_epoch.clone(),
                        stream_identity: identity.stream_identity.clone(),
                        origin_id: origin_id.clone(),
                        after_seq: cursor,
                        ops: batch.to_vec(),
                    }) {
                        Ok(response) => response,
                        Err(RelayError::Conflict) if attempt == 0 => {
                            conflict = true;
                            break;
                        }
                        Err(error) => return Err(error),
                    };
                    validate_push_response(&response, batch, local_max)?;
                    if response.current_max_origin_seq > local_max {
                        return Err(RelayError::OriginDiverged);
                    }
                    if crashes(faults, FaultPoint::SyncAfterPushBeforeCursorPersist) {
                        return Ok(SyncPassOutcome::CrashedAfterRemoteCommit);
                    }
                    match write_pushed_seq(
                        store,
                        workspace_id,
                        &origin_id,
                        response.current_max_origin_seq,
                        faults,
                        now_ms,
                    )
                    .map_err(local)?
                    {
                        TxnOutcome::Committed(declined) => sharing_declined.extend(declined),
                        TxnOutcome::Crashed { .. } => {
                            return Ok(SyncPassOutcome::CrashedAfterRemoteCommit);
                        }
                    }
                    local_max =
                        local_max_origin_seq(store, workspace_id, &origin_id).map_err(local)?;
                    pushed = pushed
                        .checked_add(response.inserted)
                        .ok_or(RelayError::InvalidResponse)?;
                    cursor = response.current_max_origin_seq;
                }
                if !conflict {
                    continue;
                }

                let probe = self.transport.push(push_probe_request(
                    workspace_id,
                    &identity,
                    &origin_id,
                    cursor,
                ))?;
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
                attempt = attempt.saturating_add(1);
            }
        }

        Ok(SyncPassOutcome::Complete {
            pushed,
            fetched: 0,
            has_more: false,
            applied: 0,
            refused: 0,
            skipped: 0,
            conflicts_opened: 0,
            pending_cursor: None,
            changed_paths: Vec::new(),
            refusals: Vec::new(),
            sharing_declined,
        })
    }

    /// Pull and apply replicated operations. The returned cursor remains
    /// pending until the caller completes disk materialization and commits it.
    pub fn pull_chat_workspace(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        faults: &dyn FaultInjector,
        leases: &dyn crate::LeaseProbe,
        now_ms: i64,
    ) -> Result<SyncPassOutcome, RelayError> {
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let current = crate::read_relay_cursor(store, workspace_id).map_err(local)?;
        if let Some(cursor) = &current {
            if cursor.replication_epoch != identity.replication_epoch
                || cursor.stream_identity != identity.stream_identity
            {
                return Err(RelayError::InvalidResponse);
            }
        }
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

        self.repair_pending_ydoc_base_orders(store, workspace_id, &identity, faults)?;
        preflight_collisions(store, workspace_id, &identity.origin_id, &ops)?;
        self.hydrate_missing_blobs(store, workspace_id, &identity, &ops, faults)?;
        let ordered = merge_by_origin(ops);
        let mut applied = 0_usize;
        let mut refused = 0_usize;
        let mut skipped = 0_usize;
        let mut conflicts_opened = 0_i64;
        let mut refusals = Vec::new();
        let mut sharing_declined = Vec::new();
        let mut changed_paths = BTreeMap::new();
        let mut retryable = Vec::new();
        let mut deferred_origins = BTreeSet::new();
        for op in &ordered {
            match crate::apply_replication_envelope(store, op, faults, leases) {
                Err(SyncError::RetryableState { .. }) => {
                    deferred_origins.insert(op.origin_id.clone());
                    retryable.push(op);
                }
                Err(SyncError::SequenceGap) if deferred_origins.contains(&op.origin_id) => {
                    retryable.push(op);
                }
                Err(error) => return Err(local(error)),
                Ok(outcome) => accumulate_pull_outcome(
                    store,
                    op,
                    outcome,
                    &mut applied,
                    &mut refused,
                    &mut skipped,
                    &mut conflicts_opened,
                    &mut changed_paths,
                    &mut refusals,
                    &mut sharing_declined,
                )?,
            }
        }
        while !retryable.is_empty() {
            let mut still_retryable = Vec::new();
            let mut still_deferred_origins = BTreeSet::new();
            let mut made_progress = false;
            for op in retryable {
                match crate::apply_replication_envelope(store, op, faults, leases) {
                    Err(SyncError::RetryableState { .. }) => {
                        still_deferred_origins.insert(op.origin_id.clone());
                        still_retryable.push(op);
                    }
                    Err(SyncError::SequenceGap)
                        if still_deferred_origins.contains(&op.origin_id) =>
                    {
                        still_retryable.push(op);
                    }
                    Err(error) => return Err(local(error)),
                    Ok(outcome) => {
                        made_progress = true;
                        accumulate_pull_outcome(
                            store,
                            op,
                            outcome,
                            &mut applied,
                            &mut refused,
                            &mut skipped,
                            &mut conflicts_opened,
                            &mut changed_paths,
                            &mut refusals,
                            &mut sharing_declined,
                        )?;
                    }
                }
            }
            if still_retryable.is_empty() {
                break;
            }
            if !made_progress {
                return Err(RelayError::Local("retryable-state".to_owned()));
            }
            retryable = still_retryable;
        }
        // A drain refusal can commit before a later envelope fails hard, or
        // outside a pull during open/resync/close. Claim every relay-owned
        // pending sidecar under a unique local report token and return it here.
        // Direct-RPC retry rows retain their sentinel. Cursor commit clears only
        // the claimed token; a later drain remains unowned, while a newer pull
        // retags relay rows so a stale cursor cannot destroy an unread refusal.
        let (pending_refusals, refusal_report_id) =
            crate::apply::claim_pending_refusals(store, workspace_id, faults).map_err(local)?;
        for refusal in pending_refusals {
            push_refusal_once(&mut refusals, refusal);
        }

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
                match write_pushed_seq(store, workspace_id, &origin_id, max_seq, faults, now_ms)
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
            replication_epoch: identity.replication_epoch,
            stream_identity: identity.stream_identity,
            refusal_report_id,
        };
        if crashes(faults, FaultPoint::SyncBetweenApplyAndCursorCommit) {
            return Ok(SyncPassOutcome::CrashedAfterApply {
                applied,
                refused,
                skipped,
                conflicts_opened,
                pending_cursor,
                changed_paths: changed_paths.into_values().collect(),
                refusals,
                sharing_declined,
            });
        }
        Ok(SyncPassOutcome::Complete {
            pushed: 0,
            fetched,
            has_more,
            applied,
            refused,
            skipped,
            conflicts_opened,
            pending_cursor: Some(pending_cursor),
            changed_paths: changed_paths.into_values().collect(),
            refusals,
            sharing_declined,
        })
    }

    pub fn commit_pull_cursor(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        cursor: &RelayCursor,
        faults: &dyn FaultInjector,
        now_ms: i64,
    ) -> Result<TxnOutcome<Vec<crate::SharingDeclined>>, RelayError> {
        commit_relay_cursor(store, workspace_id, cursor, faults, now_ms).map_err(local)
    }

    pub fn probe(&self, req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        self.transport.probe(req)
    }

    pub fn claim_workspace(&self, req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        self.transport.claim_workspace(req)
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
                    || canonical_json_bytes(&local_op.payload).map_err(local)?
                        != canonical_json_bytes(&op.payload).map_err(local)?
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
                    "DELETE FROM sync_relay_cursors WHERE workspace_id=?1",
                    [workspace_id],
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
        let own_echo = identity
            .as_ref()
            .map(|value| format!("share:{share_id}:{}", value.origin_id));
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
                    let (primary, nested_refusals, sharing_declined) =
                        outcome.into_primary_and_diagnostics();
                    debug_assert!(sharing_declined.is_empty());
                    for refusal in nested_refusals {
                        push_shared_channel_rejection(&mut refused, &mut rejections, refusal)?;
                    }
                    match primary {
                        ApplyOutcome::Applied(_) => applied += 1,
                        ApplyOutcome::Refused(refusal) => {
                            push_shared_channel_rejection(&mut refused, &mut rejections, refusal)?;
                        }
                        ApplyOutcome::Skipped => skipped += 1,
                        ApplyOutcome::Crashed { .. } => {
                            return Err(RelayError::Local("injected-crash".to_owned()));
                        }
                        ApplyOutcome::WithDiagnostics { .. } => {
                            unreachable!("diagnostics were flattened")
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
        self.push_share_ops(
            store,
            workspace_id,
            share_id,
            &SharePushScope::Channel(channel_wire_id),
            faults,
        )
    }

    /// Push this replica's own chat about a RECEIVED file share back to the
    /// granter (#646 PR2).
    ///
    /// The lane is MU-C4's, op for op: the same local scan, the same dense
    /// per-share origin sequence, the same batched POST to the share log, the
    /// same push state. Only the scope differs — a channel share scopes by
    /// channel wire id, a file share by the pinned grant — and one payload is
    /// rewritten on the way out, because a thread's link crosses a share
    /// boundary as a PATH and this replica's object ids mean nothing to the
    /// granter.
    ///
    /// The relay refuses the whole batch when the grant does not admit an op,
    /// so eligibility here is not the authorization; it is what keeps this
    /// replica from offering ops the grant was never going to accept.
    pub fn push_share_view(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        share_id: &str,
        granted: &crate::ShareGrant,
        faults: &dyn FaultInjector,
    ) -> Result<SharedChannelPushOutcome, RelayError> {
        self.push_share_ops(
            store,
            workspace_id,
            share_id,
            &SharePushScope::View(granted),
            faults,
        )
    }

    fn push_share_ops(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        share_id: &str,
        scope: &SharePushScope<'_>,
        faults: &dyn FaultInjector,
    ) -> Result<SharedChannelPushOutcome, RelayError> {
        // Names the missing thing, because an agent reads this, not a user.
        // A view-level share view never arrives here — `share_view_push_path`
        // refuses first — so reaching this is a real bug in the caller.
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or_else(|| {
                RelayError::Local(
                    "share view has no sync identity: one is written at open when the \
                     share grants comment or edit"
                        .to_owned(),
                )
            })?;
        let state = read_shared_push_state(store, workspace_id, share_id)?;
        let scanned = state.scanned_seq;
        let mut dense_seq = match state.dense_seq {
            Some(dense_seq) => dense_seq,
            None => {
                let dense_seq = shared_dense_seq_through(
                    store,
                    workspace_id,
                    &identity.origin_id,
                    scope,
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
            if push.accepted != batch.len()
                || push.inserted.checked_add(push.skipped) != Some(push.accepted)
            {
                return Err(RelayError::InvalidResponse);
            }
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
                let served = scope.served_payload(store, workspace_id, &op)?;
                if served.is_some() {
                    dense_seq = dense_seq
                        .checked_add(1)
                        .ok_or(RelayError::InvalidResponse)?;
                }
                if op.origin_seq <= scanned {
                    continue;
                }
                last_scanned = op.origin_seq;
                if let Some(payload) = served {
                    pending.push((
                        op.origin_seq,
                        ShareReplicationEnvelope {
                            origin_id: identity.origin_id.clone(),
                            origin_seq: dense_seq,
                            op_kind: op.op_kind,
                            payload,
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

    /// Offer this replica's own edits to a RECEIVED file share back to the
    /// granter, as ONE proposal the granter reads and then accepts or declines
    /// (#646 PR3a).
    ///
    /// A proposal op is a NET CHANGE, not a replayed moment: "the file you
    /// have at P with content H should now be at Q with content H2", or
    /// "should be gone". The served moment drops `momentId`, `objectId` and
    /// every `before*` field (`services/sync-relay/src/shareFilter.ts`), so a
    /// recipient never learns a granter moment id and could not state a
    /// lineage the granter recognizes. The base pair is the one identifier
    /// both sides genuinely share, and the relay resolves it to the granter's
    /// own moment at accept.
    ///
    /// The scan is bounded at the submit moment: the journal's high-water mark
    /// for this origin is read ONCE, before the first page, and edits made
    /// after it wait for the next submit. That integer is what makes one
    /// submit one coherent unit rather than a debounce tick.
    ///
    /// `scanned_seq` advances only after the relay has accepted the submit, so
    /// a failed submit re-offers the same changes rather than losing them.
    pub fn submit_share_proposal(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        share_id: &str,
        granted: &crate::ShareGrant,
        submit_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<ShareProposalSubmitOutcome, RelayError> {
        // The PINNED level, read here rather than trusted from the relay's own
        // refusal — the defence in depth `share_view_push_path` states for
        // chat. A recipient offers nothing it was not granted, so a view or
        // comment share never contacts the relay at all.
        if granted.access != crate::ShareAccess::Edit {
            return Ok(ShareProposalSubmitOutcome {
                submitted: 0,
                proposal_id: None,
            });
        }
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let scanned = read_share_proposal_scan_position(store, workspace_id, share_id)?;
        let submit_through =
            local_max_origin_seq(store, workspace_id, &identity.origin_id).map_err(local)?;
        let mut changes = collect_share_proposal_changes(
            store,
            workspace_id,
            granted,
            &identity.origin_id,
            scanned,
            submit_through,
        )?;
        if changes.is_empty() {
            // Nothing to offer, but this window is read. Recording it keeps
            // the next submit from re-reading ops it already decided about.
            write_share_proposal_scan_position(
                store,
                workspace_id,
                share_id,
                submit_through,
                faults,
            )?;
            return Ok(ShareProposalSubmitOutcome {
                submitted: 0,
                proposal_id: None,
            });
        }
        if changes.len() > crate::MAX_PUSH_OPS_PER_BATCH {
            return Err(RelayError::Local(format!(
                "share proposal exceeds changes per submit: limit {} changes, \
                 observed {} changes",
                crate::MAX_PUSH_OPS_PER_BATCH,
                changes.len()
            )));
        }
        self.upload_proposed_blobs(store, share_id, &mut changes)?;
        let response = self
            .transport
            .share_proposal_submit(ShareProposalSubmitRequest {
                share_id: share_id.to_owned(),
                submit_id: submit_id.to_owned(),
                origin_id: identity.origin_id.clone(),
                ops: changes.clone(),
            })?;
        if response.proposal_id.is_empty() || response.ops != changes.len() {
            return Err(RelayError::InvalidResponse);
        }
        write_share_proposal_scan_position(store, workspace_id, share_id, submit_through, faults)?;
        Ok(ShareProposalSubmitOutcome {
            submitted: changes.len(),
            proposal_id: Some(response.proposal_id),
        })
    }

    /// Upload the after-blob of every change that names one, BEFORE the submit
    /// that references it. `appendLogBatch` refuses a batch naming a blob the
    /// relay does not hold, and the submit route runs the same check, so
    /// content travels first — the ordering the owner's own drain uses.
    ///
    /// The blob is also where a missing byte length comes from. A moment whose
    /// stored `payloadAfterByteLength` is null would otherwise be offered with
    /// a length nobody measured, and the relay writes that number into the
    /// granter's own moment at accept.
    fn upload_proposed_blobs(
        &self,
        store: &EngineStore,
        share_id: &str,
        changes: &mut [ShareProposalChange],
    ) -> Result<(), RelayError> {
        let mut uploaded: BTreeMap<String, i64> = BTreeMap::new();
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
        // The cursor this page was FETCHED at, kept for the ops that carry no
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
            // The coordinate BEFORE the envelope is built: a malformed op the
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
            // the local main version itself. So it is skipped as EXPECTED, not
            // refused — the boundary still admits only `moment.append` and
            // `version.create`, and reporting this healthy skip as a refusal
            // would make the first pull of every share look damaged.
            if envelope.op_kind == BOOTSTRAP_OP_KIND {
                skipped += 1;
                continue;
            }
            match crate::apply_shared_envelope(store, &boundary, &envelope, faults) {
                Ok(outcome) => {
                    let (primary, nested_refusals, sharing_declined) =
                        outcome.into_primary_and_diagnostics();
                    // #646 PR2: a share-view CHAT op does mutate chat
                    // dependencies — that is what applying it means, and the
                    // replay it unparks can refuse ops of its own. Those
                    // refusals are RECORDED below rather than asserted about:
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
                        ApplyOutcome::Applied(_) => {}
                        ApplyOutcome::Refused(_) | ApplyOutcome::Skipped => {
                            skipped += 1;
                            continue;
                        }
                        ApplyOutcome::Crashed { .. } => {
                            return Err(RelayError::Local("injected-crash".to_owned()));
                        }
                        ApplyOutcome::WithDiagnostics { .. } => {
                            unreachable!("diagnostics were flattened")
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
            // #646 PR2: a chat op is fully applied by the boundary above —
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
            // Replay refusals are recorded INSIDE, one per refused blob, by
            // `refuse_replay_unit`. What reaches here is only what must abort.
            replay_share_view_op(&mut replay, &envelope)?;
        }
        Ok(ShareViewPullOutcome {
            fetched,
            has_more: page.has_more,
            applied,
            skipped,
            refusals,
            changed_paths: changed.into_values().collect(),
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

    fn upload_missing_blobs(
        &self,
        store: &EngineStore,
        workspace_id: &str,
        identity: &crate::SyncIdentity,
        ops: &[ReplicationEnvelope],
    ) -> Result<(), RelayError> {
        let refs = collect_blob_refs(ops)?;
        let all = refs.keys().cloned().collect::<Vec<_>>();
        for sha_chunk in all.chunks(crate::MAX_BLOB_HAVE_BATCH) {
            let response = self.transport.blobs_have(BlobHaveRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                sha256s: sha_chunk.to_vec(),
            })?;
            let requested = sha_chunk.iter().collect::<BTreeSet<_>>();
            let mut seen = BTreeSet::new();
            for sha256 in response.missing {
                if !requested.contains(&sha256) || !seen.insert(sha256.clone()) {
                    return Err(RelayError::InvalidResponse);
                }
                let kinds = refs.get(&sha256).ok_or(RelayError::InvalidResponse)?;
                let mut bytes = None;
                for kind in kinds {
                    if let Some(local) = local_blob_bytes(store, &sha256, *kind)? {
                        bytes = Some(local);
                        break;
                    }
                }
                let bytes = bytes.ok_or(RelayError::BlobInvalid)?;
                self.transport.upload_blob(BlobUploadRequest {
                    workspace_id: workspace_id.to_owned(),
                    replication_epoch: identity.replication_epoch.clone(),
                    stream_identity: identity.stream_identity.clone(),
                    sha256,
                    bytes,
                })?;
            }
        }
        Ok(())
    }

    fn hydrate_missing_blobs(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        identity: &crate::SyncIdentity,
        ops: &[ReplicationEnvelope],
        faults: &dyn FaultInjector,
    ) -> Result<(), RelayError> {
        for (sha256, kinds) in collect_blob_refs(ops)? {
            let mut missing = Vec::new();
            for kind in kinds {
                if !local_blob_present(store, &sha256, kind)? {
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
            let response = self
                .transport
                .download_blob(BlobDownloadRequest {
                    workspace_id: workspace_id.to_owned(),
                    replication_epoch: identity.replication_epoch.clone(),
                    stream_identity: identity.stream_identity.clone(),
                    sha256: sha256.clone(),
                })
                .map_err(|error| relabel_ceiling(error, constraint, limit_bytes))?;
            // Refuse before hashing and before copying: a transport is not
            // trusted to bound its own response, and no kind can accept this.
            if response.bytes.len() > limit_bytes {
                return Err(RelayError::BlobTooLarge {
                    constraint,
                    limit_bytes,
                    observed: ObservedBytes::Exact(response.bytes.len()),
                });
            }
            if hex_sha256(&response.bytes) != sha256 {
                return Err(RelayError::BlobInvalid);
            }
            for kind in missing {
                let content = match kind {
                    BlobKind::Text => String::from_utf8(response.bytes.clone())
                        .map(BlobContent::Text)
                        .map_err(|_| RelayError::BlobInvalid)?,
                    BlobKind::Binary => BlobContent::Binary(response.bytes.clone()),
                    BlobKind::Ydoc => BlobContent::Ydoc(response.bytes.clone()),
                };
                match hydrate_blob_content(
                    store,
                    &BlobHydration {
                        sha256: sha256.clone(),
                        content,
                    },
                    faults,
                )
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

fn collect_blob_refs(
    ops: &[ReplicationEnvelope],
) -> Result<BTreeMap<String, BTreeSet<BlobKind>>, RelayError> {
    let mut refs = BTreeMap::new();
    for op in ops {
        match op.op_kind.as_str() {
            "moment.append" => {
                insert_optional_ref(
                    &mut refs,
                    op.payload.get("payloadBeforeBlobSha256"),
                    content_kind(op.payload.get("payloadBeforeContentKind")),
                )?;
                insert_optional_ref(
                    &mut refs,
                    op.payload.get("payloadAfterBlobSha256"),
                    content_kind(op.payload.get("payloadAfterContentKind")),
                )?;
                insert_optional_ref(
                    &mut refs,
                    op.payload.get("beforeBlobSha256"),
                    content_kind(op.payload.get("beforeContentKind")),
                )?;
            }
            "conflict.open" => {
                for name in ["base", "current", "incoming"] {
                    let Some(state) = op.payload.get(name) else {
                        continue;
                    };
                    if state.get("exists").and_then(serde_json::Value::as_bool) == Some(true)
                        && content_kind(state.get("contentKind")) == BlobKind::Binary
                    {
                        insert_optional_ref(&mut refs, state.get("sha256"), BlobKind::Binary)?;
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
                for snapshot in op
                    .payload
                    .get("forkSnapshots")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    insert_optional_ref(
                        &mut refs,
                        snapshot.get("blobSha256"),
                        content_kind(snapshot.get("contentKind")),
                    )?;
                }
            }
            "ydoc.update" => {
                // Its OWN kind, not `Binary`: a Y.Doc delta or full-state base
                // rides the collab layer's measured payload cap, never the
                // captured-file cap (#549).
                insert_optional_ref(
                    &mut refs,
                    op.payload.get("updateBlobSha256"),
                    BlobKind::Ydoc,
                )?;
            }
            "secret.file.put" => {
                insert_optional_ref(
                    &mut refs,
                    op.payload.get("ciphertextSha256"),
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
                    insert_optional_ref(&mut refs, row.get("ciphertextSha256"), BlobKind::Binary)?;
                }
            }
            _ => {}
        }
    }
    Ok(refs)
}

fn content_kind(value: Option<&serde_json::Value>) -> BlobKind {
    if value.and_then(serde_json::Value::as_str) == Some("binary") {
        BlobKind::Binary
    } else {
        BlobKind::Text
    }
}

fn insert_optional_ref(
    refs: &mut BTreeMap<String, BTreeSet<BlobKind>>,
    value: Option<&serde_json::Value>,
    kind: BlobKind,
) -> Result<(), RelayError> {
    let Some(sha256) = value.and_then(serde_json::Value::as_str) else {
        return Ok(());
    };
    if sha256.is_empty() {
        return Ok(());
    }
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
                let row = conn
                    .query_row(
                        "SELECT byte_length,text FROM blobs WHERE sha256=?1",
                        [sha256],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                    )
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
                // The ceiling comes from the REFERENCED kind, never a literal.
                // A restated number here read a Y.Doc base against the
                // captured-file cap and called a valid oversized blob
                // `BlobInvalid` — the wrong constraint and the wrong error
                // (#549).
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

/// Is this digest already hydrated AND valid for the kind being asked for?
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
/// So stored bytes over the REQUESTED kind's ceiling are refused here, by
/// name, rather than reported present. Refused rather than re-fetched: the
/// length is already known, and downloading identical bytes to reject them
/// would only make the observed size less exact.
fn local_blob_present(
    store: &EngineStore,
    sha256: &str,
    kind: BlobKind,
) -> Result<bool, RelayError> {
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
        return Ok(false);
    };
    let observed = usize::try_from(byte_length).map_err(|_| RelayError::BlobInvalid)?;
    if observed > limit_bytes {
        return Err(RelayError::BlobTooLarge {
            constraint,
            limit_bytes,
            observed: ObservedBytes::Exact(observed),
        });
    }
    Ok(true)
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
                    || canonical_json_bytes(&local_payload)? != canonical_json_bytes(&op.payload)?
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

fn local_max_origin_seq(
    store: &EngineStore,
    workspace_id: &str,
    origin_id: &str,
) -> Result<i64, SyncError> {
    store.read_with(|conn| {
        conn.query_row(
            "SELECT COALESCE(MAX(origin_seq),-1) FROM replication_log \
             WHERE workspace_id=?1 AND origin_id=?2",
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
) -> Result<(), RelayError> {
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

fn validate_probe_response(response: &PushResponse) -> Result<(), RelayError> {
    if response.accepted != 0
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
    if response.ops.len() > crate::MAX_PULL_OPS
        || !(0..=crate::MAX_WIRE_INTEGER).contains(&response.next_cursor)
        || (!response.has_more && response.next_cursor < cursor)
    {
        return Err(RelayError::InvalidResponse);
    }
    if response.has_more && response.next_cursor <= cursor {
        return Err(RelayError::NoProgress);
    }
    let mut previous = cursor;
    for op in &response.ops {
        if op.workspace_id != workspace_id || op.validate().is_err() {
            return Err(RelayError::InvalidResponse);
        }
        let relay_seq = op.relay_seq.ok_or(RelayError::InvalidResponse)?;
        if relay_seq <= previous || relay_seq > response.next_cursor {
            return Err(RelayError::InvalidResponse);
        }
        previous = relay_seq;
    }
    if previous != response.next_cursor {
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
/// oversized-payload case is MEASURED here for the report — the same
/// measurement, taken again to say how far over the op was rather than only
/// that it was over. A caller that cannot see the size cannot tell a payload
/// one byte past the limit from one ten times it.
fn describe_envelope_refusal(envelope: &ReplicationEnvelope, error: SyncError) -> EnvelopeRefusal {
    let code = error.code();
    // In the order `ReplicationEnvelope::validate` checks them, so the branch
    // taken here is the one that actually refused.
    //
    // The origin id first, and it matters MOST: an op whose origin id is
    // unusable is filed under its page position, so the reader never sees the
    // value at all and cannot tell an empty one from a small overrun or from
    // a hundred kilobytes.
    // The CLAUSE that fired, from the validator itself. An id can break this
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
/// share (#646 PR3a). `-1` is "nothing read yet", the same floor every other
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

/// Whether EVERY path this moment names sits inside the pinned grant.
///
/// The outbound twin of `enforce_share_view_boundary`'s containment loop,
/// reading the same four fields through the same rule. A moment naming one
/// path outside the grant is not this share's to offer, in either direction —
/// and a moment naming no path at all describes no file, so there is nothing
/// to propose.
fn proposal_paths_within_grant(payload: &serde_json::Value, granted: &crate::ShareGrant) -> bool {
    let mut named = false;
    for field in crate::share::MOMENT_PATH_FIELDS {
        let Some(path) = string_field(payload, field) else {
            continue;
        };
        named = true;
        if !crate::share::selected_path_within_grant(path, granted) {
            return false;
        }
    }
    named
}

/// This replica's local moments between `scanned_seq` and `submit_through`,
/// consolidated into ONE net change per file.
///
/// One moment already states its object's COMPLETE post state rather than a
/// delta — `store.rs` copies the before blob into `payloadAfterBlobSha256` for
/// a rename, and `moment_apply.rs` materializes from the after side whatever
/// the operation says. So a run of moments for one object collapses by taking
/// the base from the FIRST and the destination from the LAST, and a write
/// followed by a rename leaves as one change from the original path to the new
/// one.
fn collect_share_proposal_changes(
    store: &EngineStore,
    workspace_id: &str,
    granted: &crate::ShareGrant,
    origin_id: &str,
    scanned_seq: i64,
    submit_through: i64,
) -> Result<Vec<ShareProposalChange>, RelayError> {
    let mut order: Vec<String> = Vec::new();
    let mut by_object: BTreeMap<String, ShareProposalChange> = BTreeMap::new();
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
            if op.op_kind != "moment.append" {
                continue;
            }
            if !proposal_paths_within_grant(&op.payload, granted) {
                continue;
            }
            let Some(object_id) = string_field(&op.payload, "objectId") else {
                continue;
            };
            let change = by_object.entry(object_id.to_owned()).or_insert_with(|| {
                order.push(object_id.to_owned());
                ShareProposalChange {
                    // The base is the FIRST moment's before side: what the
                    // recipient started from, which is what the granter has to
                    // resolve against its own log.
                    based_on_path: string_field(&op.payload, "payloadBeforePath")
                        .map(str::to_owned),
                    based_on_blob_sha256: string_field(&op.payload, "payloadBeforeBlobSha256")
                        .filter(|sha256| valid_sha256(sha256))
                        .map(str::to_owned),
                    operation: String::new(),
                    after_path: None,
                    after_blob_sha256: None,
                    after_content_kind: None,
                    after_byte_length: None,
                    recorded_at_ms: 0,
                }
            });
            // The destination is the LAST moment's after side, overwritten as
            // the scan walks forward.
            //
            // `rename` is a local label for a moment; a proposal states only
            // what the granter must end up with, and the relay derives the
            // moment's own label from the two paths at accept.
            change.operation = if string_field(&op.payload, "operation") == Some("delete") {
                "delete".to_owned()
            } else {
                "write".to_owned()
            };
            change.after_path = string_field(&op.payload, "payloadAfterPath")
                .or_else(|| string_field(&op.payload, "path"))
                .map(str::to_owned);
            change.after_blob_sha256 = string_field(&op.payload, "payloadAfterBlobSha256")
                .filter(|sha256| valid_sha256(sha256))
                .map(str::to_owned);
            // The relay accepts exactly two content kinds, so state one of
            // them. A moment carrying neither is text, the same reading
            // `ContentKind::from_wire` applies on apply.
            change.after_content_kind = Some(
                if string_field(&op.payload, "payloadAfterContentKind") == Some("binary") {
                    "binary".to_owned()
                } else {
                    "text".to_owned()
                },
            );
            change.after_byte_length = op
                .payload
                .get("payloadAfterByteLength")
                .and_then(serde_json::Value::as_i64)
                .filter(|byte_length| *byte_length >= 0);
            change.recorded_at_ms = op.recorded_at_ms;
        }
        after = page_last;
    }
    let mut changes = Vec::with_capacity(order.len());
    for object_id in order {
        let Some(mut change) = by_object.remove(&object_id) else {
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
        changes.push(change);
    }
    Ok(changes)
}

/// What a push is scoped to. The two share surfaces run the SAME outbound
/// lane — one local scan, one dense per-share origin sequence, one batched
/// POST — and differ only in which of this replica's ops belong to the share
/// and what shape they take on the wire.
enum SharePushScope<'a> {
    /// MU-C4: the granted channel's own ops, pushed unchanged.
    Channel(&'a str),
    /// #646 PR2: this replica's chat about the files a received file share
    /// covers, scoped by the pinned grant.
    View(&'a crate::ShareGrant),
}

impl SharePushScope<'_> {
    /// Whether `op` is this share's to push, without building its payload.
    fn is_eligible(
        &self,
        store: &EngineStore,
        workspace_id: &str,
        op: &ReplicationEnvelope,
    ) -> Result<bool, RelayError> {
        match self {
            Self::Channel(channel_wire_id) => {
                shared_channel_op_allowed(store, workspace_id, channel_wire_id, op)
            }
            Self::View(granted) => {
                Ok(share_view_push_path(store, workspace_id, granted, op)?.is_some())
            }
        }
    }

    /// The payload to push for `op`, or `None` when the op is not this
    /// share's to push.
    fn served_payload(
        &self,
        store: &EngineStore,
        workspace_id: &str,
        op: &ReplicationEnvelope,
    ) -> Result<Option<serde_json::Value>, RelayError> {
        match self {
            Self::Channel(channel_wire_id) => {
                Ok(
                    shared_channel_op_allowed(store, workspace_id, channel_wire_id, op)?
                        .then(|| op.payload.clone()),
                )
            }
            Self::View(granted) => share_view_push_payload(store, workspace_id, granted, op),
        }
    }
}

/// The file-share half of the eligibility rule, and the one rewrite the
/// outbound lane makes.
///
/// An op is this share's to push when it is one of the five file-chat kinds
/// AND the file its thread is about sits inside the pinned grant right now.
/// A `chat.thread.create` then leaves here naming that file by PATH: the
/// granter mints its own object ids, so the local one this replica journaled
/// would name nothing there, and the relay's own filter refuses a create that
/// carries both shapes.
/// The in-grant path this op's thread is about, or `None` when the op is not
/// this share's to push. Answers eligibility WITHOUT building a payload, so
/// the dense-sequence walk can ask the same question cheaply.
fn share_view_push_path(
    store: &EngineStore,
    workspace_id: &str,
    granted: &crate::ShareGrant,
    op: &ReplicationEnvelope,
) -> Result<Option<String>, RelayError> {
    if !crate::share::is_share_view_chat_kind(&op.op_kind) {
        return Ok(None);
    }
    // The PINNED level, read here rather than trusted from the relay's own
    // refusal (#646 PR2). A `view` grant carries chat to read and nothing to
    // write, so this replica offers none — the defence in depth the plan's
    // enforcement table claims, and the one place the pinned level decides
    // something by itself.
    if granted.access == crate::ShareAccess::View {
        return Ok(None);
    }
    let object_id = if op.op_kind == "chat.thread.create" {
        match op
            .payload
            .get("linkedObjectId")
            .and_then(serde_json::Value::as_str)
        {
            Some(object_id) => object_id.to_owned(),
            // A channel thread, or a create already naming a path. Neither is
            // this file share's to push.
            None => return Ok(None),
        }
    } else {
        let Some(thread_id) = op
            .payload
            .get("threadId")
            .and_then(serde_json::Value::as_str)
        else {
            return Ok(None);
        };
        match read_thread_linked_object(store, workspace_id, thread_id)? {
            Some(object_id) => object_id,
            None => return Ok(None),
        }
    };
    let Some(path) = read_object_path(store, workspace_id, &object_id)? else {
        return Ok(None);
    };
    // Chat follows PATHS only, and the same containment rule the inbound
    // boundary applies — so a version share pushes nothing either.
    if !crate::share::selected_path_within_grant(&path, granted) {
        return Ok(None);
    }
    Ok(Some(path))
}

fn share_view_push_payload(
    store: &EngineStore,
    workspace_id: &str,
    granted: &crate::ShareGrant,
    op: &ReplicationEnvelope,
) -> Result<Option<serde_json::Value>, RelayError> {
    let Some(path) = share_view_push_path(store, workspace_id, granted, op)? else {
        return Ok(None);
    };
    if op.op_kind != "chat.thread.create" {
        return Ok(Some(op.payload.clone()));
    }
    let mut payload = op.payload.clone();
    let Some(record) = payload.as_object_mut() else {
        return Ok(None);
    };
    record.remove("linkedObjectId");
    // Display-only and captured once. The granter re-resolves the path it
    // receives against its own store, so carrying a second, staler copy of the
    // same idea across the boundary would only invite someone to read it.
    record.remove("linkedPathHint");
    record.insert("linkedPath".to_owned(), serde_json::Value::String(path));
    Ok(Some(payload))
}

fn read_thread_linked_object(
    store: &EngineStore,
    workspace_id: &str,
    thread_id: &str,
) -> Result<Option<String>, RelayError> {
    store
        .read_with(|conn| crate::share::thread_linked_object(conn, workspace_id, thread_id))
        .map_err(local)
}

fn read_object_path(
    store: &EngineStore,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<String>, RelayError> {
    store
        .read_with(|conn| crate::share::object_main_path(conn, workspace_id, object_id))
        .map_err(local)
}

fn shared_dense_seq_through(
    store: &EngineStore,
    workspace_id: &str,
    origin_id: &str,
    scope: &SharePushScope<'_>,
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
            if scope.is_eligible(store, workspace_id, &op)? {
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
/// The decision belongs to the BYTES and to the kind the op claims for them:
/// the ceiling is per kind, and so is whether the bytes are text. Never to the
/// path. So the key is the pair, and one row's answer serves every other row
/// that names it.
///
/// The lifetime is the PULL rather than the op, because ops repeat a blob too
/// — a granter who shared one oversized file into several versions sends one
/// op per version. What makes that scope safe is what is stored: a decision,
/// not a body. This map cannot grow with the size of the content it describes,
/// which is exactly why caching the authenticated bytes instead would be the
/// new failure — the payload budget admits thousands of distinct shas, and
/// each body may run to the ceiling.
fn blob_refusal_key(sha256: &str, content_kind: &'static str) -> (String, &'static str) {
    (sha256.to_owned(), content_kind)
}

/// Record ONE refused replay unit, or abort the pull.
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
/// blobs in the same op are ALL applied. Never a prefix.
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
/// path is carried because the reason alone cannot say WHICH file went
/// missing, and an op can lose several.
///
/// Reason and path are kept APART because they are bounded differently. A
/// reason is bounded by construction: a constraint name, a limit, a unit and
/// an observed count. A path is bounded by nothing — `classify_share_path`
/// admits a tracked path of any length — so a served op would otherwise
/// decide how much of the record every OTHER refusal in the op gets.
struct RefusedBlob {
    code: &'static str,
    reason: String,
    path: String,
}

/// Turn an op's refused blobs into ONE durable record.
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

/// The ONE code that speaks for however many blobs an op refused.
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
/// only while the WHOLE detail still fits — so the record never holds a
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
        let operation = string_field(&envelope.payload, "operation");
        let path = string_field(&envelope.payload, "path");
        match operation {
            Some("delete") => {
                if let Some(path) = path {
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
                let before = string_field(&envelope.payload, "payloadBeforePath");
                let after = string_field(&envelope.payload, "payloadAfterPath").or(path);
                let sha = string_field(&envelope.payload, "payloadAfterBlobSha256");
                if let (Some(before), Some(after), Some(sha)) = (before, after, sha) {
                    if let Err(error) = replay_share_write(
                        context.transport,
                        &mut *context.store,
                        context.workspace_id,
                        &main_version_id,
                        context.share_id,
                        envelope,
                        after,
                        sha,
                        content_kind_name(envelope.payload.get("payloadAfterContentKind")),
                        context.faults,
                        &mut *context.applied,
                        &mut *context.changed,
                        &mut *context.blob_refusals,
                    ) {
                        refuse_replay_unit(context, &mut refused, after, error)?;
                        // The rename's delete does NOT run. Removing the old
                        // path when its replacement was refused would lose the
                        // file outright — the one outcome worse than not
                        // renaming it.
                        record_refused_blobs(context, envelope, &refused);
                        return Ok(());
                    }
                    if before != after {
                        replay_share_delete(
                            &mut *context.store,
                            context.workspace_id,
                            &main_version_id,
                            context.share_id,
                            envelope,
                            before,
                            context.faults,
                            &mut *context.applied,
                            &mut *context.changed,
                        )?;
                    }
                }
            }
            Some("write") => {
                let after = string_field(&envelope.payload, "payloadAfterPath").or(path);
                let sha = string_field(&envelope.payload, "payloadAfterBlobSha256");
                if let (Some(after), Some(sha)) = (after, sha) {
                    if let Err(error) = replay_share_write(
                        context.transport,
                        &mut *context.store,
                        context.workspace_id,
                        &main_version_id,
                        context.share_id,
                        envelope,
                        after,
                        sha,
                        content_kind_name(envelope.payload.get("payloadAfterContentKind")),
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
        for snapshot in envelope
            .payload
            .get("forkSnapshots")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
        {
            let path = string_field(snapshot, "path");
            let sha = string_field(snapshot, "blobSha256");
            if let (Some(path), Some(sha)) = (path, sha) {
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
                    content_kind_name(snapshot.get("contentKind")),
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
    // The SAME door `write_text`/`write_binary` open with, not a restatement
    // of its rules, so the two cannot drift — and this is the ONLY place the
    // path class has to be classified. Everything that reaches replay has
    // already passed `classify_share_path`, whose grammar admits no `%`, `\`,
    // `.` or `..` segment, so normalization is the identity on it and the
    // second `validate_path` inside `write_binary_file_in_tx` can no longer
    // find anything this call did not. The writes below therefore keep the
    // plain `domain` mapping.
    dohc_engine_domain::validate_plaintext_storable_path(path).map_err(replayed_domain)?;
    let key = replay_id(share_id, envelope, "write", path);
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
    // AFTER the request record, because that one is about this path and this
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
    let deduped = {
        let mut versioned = VersionedTextStore::new(store);
        if content_kind == "binary" {
            versioned
                .write_binary(
                    &WriteBinary {
                        workspace_id: workspace_id.to_owned(),
                        version_id: version_id.to_owned(),
                        object_id: format!("object-share-{key}"),
                        path: path.to_owned(),
                        bytes,
                        moment_id: format!("moment-share-{key}"),
                        metadata_origin: "sync".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: envelope.recorded_at_ms,
                        request_id: Some(request_id.clone()),
                    },
                    faults,
                )
                .map_err(domain)?
                .deduped
        } else {
            // These bytes already matched the sha the op named, so they ARE
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
            versioned
                .write_text(
                    &WriteText {
                        workspace_id: workspace_id.to_owned(),
                        version_id: version_id.to_owned(),
                        object_id: format!("object-share-{key}"),
                        path: path.to_owned(),
                        text,
                        moment_id: format!("moment-share-{key}"),
                        metadata_origin: "sync".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: envelope.recorded_at_ms,
                        request_id: Some(request_id),
                    },
                    faults,
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
    Ok(())
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
    let result = {
        let mut versioned = VersionedTextStore::new(store);
        versioned.delete_text_file(
            &DeleteTextFile {
                workspace_id: workspace_id.to_owned(),
                version_id: version_id.to_owned(),
                path: path.to_owned(),
                moment_id: format!("moment-share-{key}"),
                request_id: Some(format!("share-view:{key}")),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: envelope.recorded_at_ms,
            },
            faults,
        )
    };
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

fn content_kind_name(value: Option<&serde_json::Value>) -> &'static str {
    if value.and_then(serde_json::Value::as_str) == Some("binary") {
        "binary"
    } else {
        "text"
    }
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
/// and every op behind the bad path never arrives (#571's failure mode, on a
/// class that cannot be repaired).
///
/// Only a diverging relay produces one: the granter's own capture writes
/// through this same door, so a path it refuses here was never storable
/// there either. Nobody can act on it, which is why it takes the generic
/// refusal code rather than one that would send the reader to the granter.
///
/// The verdict is NOT remembered in `blob_refusals`. That map is keyed by the
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

#[allow(clippy::too_many_arguments)]
fn accumulate_pull_outcome(
    store: &EngineStore,
    op: &ReplicationEnvelope,
    outcome: ApplyOutcome<crate::RoutedApply>,
    applied: &mut usize,
    refused: &mut usize,
    skipped: &mut usize,
    conflicts_opened: &mut i64,
    changed_paths: &mut BTreeMap<(String, String), crate::MomentMaterializationChange>,
    refusals: &mut Vec<crate::ReplicationRefusal>,
    sharing_declined: &mut Vec<crate::SharingDeclined>,
) -> Result<(), RelayError> {
    let (primary, drain_refusals, drain_declines) = outcome.into_primary_and_diagnostics();
    for refusal in drain_refusals {
        push_refusal_once(refusals, refusal);
    }
    for declined in drain_declines {
        push_sharing_declined_once(sharing_declined, declined);
    }
    match primary {
        ApplyOutcome::Applied(routed) => {
            *conflicts_opened = conflicts_opened
                .checked_add(routed.conflicts_opened)
                .ok_or(RelayError::InvalidResponse)?;
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
        ApplyOutcome::Refused(refusal) => {
            *refused = refused.checked_add(1).ok_or(RelayError::InvalidResponse)?;
            push_refusal_once(refusals, refusal);
        }
        ApplyOutcome::Skipped => {
            *conflicts_opened = conflicts_opened
                .checked_add(crate::router::redelivered_conflicts_opened(store, op).map_err(local)?)
                .ok_or(RelayError::InvalidResponse)?;
            if let Some(refusal) = crate::apply::read_replayed_refusal(store, op).map_err(local)? {
                push_refusal_once(refusals, refusal);
            }
            for change in
                crate::router::redelivered_materialization_changes(store, op).map_err(local)?
            {
                insert_changed_path(changed_paths, change);
            }
            *skipped = skipped.checked_add(1).ok_or(RelayError::InvalidResponse)?;
        }
        ApplyOutcome::Crashed { .. } => {
            return Err(RelayError::Local("injected-crash".to_owned()));
        }
        ApplyOutcome::WithDiagnostics { .. } => unreachable!("diagnostics were flattened"),
    }
    Ok(())
}

fn insert_changed_path(
    changed_paths: &mut BTreeMap<(String, String), crate::MomentMaterializationChange>,
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
    if !declines.contains(&declined) {
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

// The busy store keeps its TYPE across this boundary. Both funnels answer it
// the same way, so a relay operation refused for contention reaches the wire
// as the retryable class no matter which taxonomy it came through (#658).
fn local(error: SyncError) -> RelayError {
    if matches!(error, SyncError::Storage(StorageError::FileLocked)) {
        return RelayError::StoreBusy;
    }
    RelayError::Local(error.code().to_owned())
}

#[cfg(test)]
mod pull_page_validation_tests {
    use super::{PullResponse, ReplicationEnvelope, validate_pull_page};
    use crate::RelayError;

    fn op(relay_seq: Option<i64>) -> ReplicationEnvelope {
        ReplicationEnvelope {
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
}

#[cfg(test)]
mod sharing_decline_tests {
    use super::push_sharing_declined_once;

    fn decline(path: &str) -> crate::SharingDeclined {
        crate::SharingDeclined {
            path: path.to_owned(),
            constraint: "MAX_YDOC_UPDATE_BYTES",
            limit_bytes: 20,
            observed_bytes: 21,
        }
    }

    #[test]
    fn equal_sized_declines_for_distinct_paths_do_not_collapse() {
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
            lineage_transition: Some(LineageTransitionV1 {
                predecessor_claim_id: dohc_engine_storage::hex_sha256(b"predecessor"),
                predecessor_state_vector_sha256: dohc_engine_storage::hex_sha256(
                    b"predecessor state vector",
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
