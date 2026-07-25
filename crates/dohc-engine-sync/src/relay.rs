use std::collections::{BTreeMap, BTreeSet};

use dohc_engine_domain::{DeleteTextFile, DomainError, VersionedTextStore, WriteBinary, WriteText};
use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint, TxnOutcome, hex_sha256};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::cursor::{RelayCursor, commit_relay_cursor, read_pushed_seq, write_pushed_seq};
use crate::journal::{crashes, list_replication_ops, read_sync_identity};
use crate::{
    ApplyOutcome, BlobContent, BlobHydration, RelayError, ReplicationEnvelope, SyncError,
    hydrate_blob_content,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoverResponse {
    pub old_origin_id: String,
    pub new_origin_id: String,
    pub shared_prefix_length: i64,
    pub preserved_ops: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedChannelPullOutcome {
    pub fetched: usize,
    pub applied: usize,
    pub refused: usize,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareViewPullOutcome {
    pub fetched: usize,
    pub applied: usize,
    pub skipped: usize,
    pub changed_paths: Vec<ShareViewChangedPath>,
    pub pending_cursor: crate::ShareCursor,
}

/// Runtime-owned relay seam. The core crate contains no HTTP or async runtime
/// dependency; production adapters live in separate crates.
pub trait RelayTransport {
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError>;
    fn pull(&self, req: PullRequest) -> Result<PullResponse, RelayError>;
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
    fn shared_channel_push(
        &self,
        req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError>;
    fn share_view_pull(&self, req: ShareViewRequest) -> Result<ShareViewResponse, RelayError>;
    fn share_blob(&self, req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncPassOutcome {
    Complete {
        pushed: usize,
        fetched: usize,
        applied: usize,
        refused: usize,
        skipped: usize,
        pending_cursor: Option<RelayCursor>,
        changed_paths: Vec<crate::MomentMaterializationChange>,
        /// Replicated resolutions acked in this pass that the receiver
        /// deliberately did not apply. The cursor advances past them, so they
        /// only exist here — a caller that drops this loses them.
        pending_resolves: Vec<crate::PendingResolve>,
        /// Per-operation validation failures that were journaled and acked.
        /// The rejected mutations were rolled back before those coordinates
        /// were retired.
        refusals: Vec<crate::ReplicationRefusal>,
    },
    CrashedAfterRemoteCommit,
    CrashedAfterApply {
        applied: usize,
        refused: usize,
        skipped: usize,
        pending_cursor: RelayCursor,
        changed_paths: Vec<crate::MomentMaterializationChange>,
        pending_resolves: Vec<crate::PendingResolve>,
        refusals: Vec<crate::ReplicationRefusal>,
    },
}

pub struct RelaySyncClient<T> {
    transport: T,
}

impl<T: RelayTransport> RelaySyncClient<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }

    pub fn push_workspace(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<SyncPassOutcome, RelayError> {
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let origins = list_workspace_origins(store, workspace_id).map_err(local)?;
        let mut pushed = 0_usize;

        for origin_id in origins {
            let local_max = local_max_origin_seq(store, workspace_id, &origin_id).map_err(local)?;
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
                    )
                    .map_err(local)?
                    {
                        TxnOutcome::Committed(()) => {}
                        TxnOutcome::Crashed { .. } => {
                            return Ok(SyncPassOutcome::CrashedAfterRemoteCommit);
                        }
                    }
                    pushed = pushed
                        .checked_add(response.inserted)
                        .ok_or(RelayError::InvalidResponse)?;
                    cursor = response.current_max_origin_seq;
                }
                if !conflict {
                    continue;
                }

                let probe = self.transport.push(PushRequest {
                    workspace_id: workspace_id.to_owned(),
                    replication_epoch: identity.replication_epoch.clone(),
                    stream_identity: identity.stream_identity.clone(),
                    origin_id: origin_id.clone(),
                    after_seq: cursor,
                    ops: Vec::new(),
                })?;
                validate_probe_response(&probe)?;
                if probe.current_max_origin_seq > local_max
                    || probe.current_max_origin_seq >= cursor
                {
                    return Err(RelayError::OriginDiverged);
                }
                match write_pushed_seq(
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
            applied: 0,
            refused: 0,
            skipped: 0,
            pending_cursor: None,
            changed_paths: Vec::new(),
            pending_resolves: Vec::new(),
            refusals: Vec::new(),
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
        let mut ops = Vec::new();
        loop {
            let response = self.transport.pull(PullRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                cursor,
                limit: crate::MAX_PULL_OPS,
            })?;
            if response.ops.len() > crate::MAX_PULL_OPS
                || !(0..=crate::MAX_WIRE_INTEGER).contains(&response.next_cursor)
            {
                return Err(RelayError::InvalidResponse);
            }
            for op in &response.ops {
                if op.workspace_id != workspace_id {
                    return Err(RelayError::InvalidResponse);
                }
            }
            fetched = fetched
                .checked_add(response.ops.len())
                .ok_or(RelayError::InvalidResponse)?;
            ops.extend(response.ops);
            if response.has_more && response.next_cursor <= cursor {
                return Err(RelayError::NoProgress);
            }
            cursor = response.next_cursor;
            if !response.has_more {
                break;
            }
        }

        preflight_collisions(store, workspace_id, &ops)?;
        self.hydrate_missing_blobs(store, workspace_id, &identity, &ops, faults)?;
        let ordered = merge_by_origin(ops);
        let mut applied = 0_usize;
        let mut refused = 0_usize;
        let mut skipped = 0_usize;
        let mut pending_resolves = Vec::new();
        let mut refusals = Vec::new();
        let mut changed_paths = BTreeMap::new();
        let mut pulled_foreign_max = BTreeMap::<String, i64>::new();
        for op in &ordered {
            match crate::apply_replication_envelope(store, op, faults, leases).map_err(local)? {
                ApplyOutcome::Applied(routed) => {
                    if let Some(pending) = routed.pending_resolve() {
                        pending_resolves.push(pending.clone());
                    }
                    for change in routed.materialization_changes {
                        changed_paths.insert(change.path.clone(), change);
                    }
                    applied = applied.checked_add(1).ok_or(RelayError::InvalidResponse)?;
                }
                ApplyOutcome::Refused(refusal) => {
                    refused = refused.checked_add(1).ok_or(RelayError::InvalidResponse)?;
                    refusals.push(refusal);
                }
                ApplyOutcome::Skipped => {
                    for change in
                        crate::moment_apply::redelivered_materialization_changes(store, op)
                            .map_err(local)?
                    {
                        changed_paths.insert(change.path.clone(), change);
                    }
                    skipped = skipped.checked_add(1).ok_or(RelayError::InvalidResponse)?;
                }
                ApplyOutcome::Crashed { .. } => {
                    return Err(RelayError::Local("injected-crash".to_owned()));
                }
            }
            if op.origin_id != identity.origin_id {
                pulled_foreign_max
                    .entry(op.origin_id.clone())
                    .and_modify(|seq| *seq = (*seq).max(op.origin_seq))
                    .or_insert(op.origin_seq);
            }
        }
        for (origin_id, max_seq) in pulled_foreign_max {
            if max_seq > read_pushed_seq(store, workspace_id, &origin_id).map_err(local)? {
                match write_pushed_seq(store, workspace_id, &origin_id, max_seq, faults)
                    .map_err(local)?
                {
                    TxnOutcome::Committed(()) => {}
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
        };
        if crashes(faults, FaultPoint::SyncBetweenApplyAndCursorCommit) {
            return Ok(SyncPassOutcome::CrashedAfterApply {
                applied,
                refused,
                skipped,
                pending_cursor,
                changed_paths: changed_paths.into_values().collect(),
                pending_resolves,
                refusals,
            });
        }
        Ok(SyncPassOutcome::Complete {
            pushed: 0,
            fetched,
            applied,
            refused,
            skipped,
            pending_cursor: Some(pending_cursor),
            changed_paths: changed_paths.into_values().collect(),
            pending_resolves,
            refusals,
        })
    }

    pub fn commit_pull_cursor(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        cursor: &RelayCursor,
        faults: &dyn FaultInjector,
    ) -> Result<TxnOutcome<()>, RelayError> {
        commit_relay_cursor(store, workspace_id, cursor, faults).map_err(local)
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
        mut req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        if req.envelope_json.is_empty() || req.envelope_json.len() > 16 * 1024 {
            return Err(RelayError::InvalidResponse);
        }
        for _ in 0..3 {
            match self.transport.upload_key_envelope(req.clone()) {
                Ok(response) if !response.etag.is_empty() => return Ok(response),
                Ok(_) => return Err(RelayError::InvalidResponse),
                Err(RelayError::Conflict) => {
                    let current =
                        self.transport
                            .download_key_envelope(KeyEnvelopeDownloadRequest {
                                workspace_id: req.workspace_id.clone(),
                                replication_epoch: req.replication_epoch.clone(),
                                stream_identity: req.stream_identity.clone(),
                            });
                    match current {
                        Ok(current) if !current.etag.is_empty() => {
                            req.if_match = Some(current.etag);
                        }
                        Ok(_) => return Err(RelayError::InvalidResponse),
                        Err(RelayError::KeyEnvelopeMissing | RelayError::WorkspaceUnavailable) => {
                            req.if_match = None;
                        }
                        Err(error) => return Err(error),
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Err(RelayError::Conflict)
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
        let mut local_ops = Vec::new();
        let mut after = -1;
        loop {
            let page = list_replication_ops(
                store,
                workspace_id,
                &identity.origin_id,
                after,
                crate::MAX_PULL_OPS,
            )
            .map_err(local)?;
            let Some(last) = page.last() else {
                break;
            };
            after = last.origin_seq;
            local_ops.extend(page);
        }

        let mut relay_ops = BTreeMap::new();
        let mut cursor = 0;
        loop {
            let page = self.transport.pull(PullRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                cursor,
                limit: crate::MAX_PULL_OPS,
            })?;
            validate_pull_page(&page, workspace_id, cursor)?;
            for op in page.ops {
                if op.origin_id == identity.origin_id {
                    relay_ops.insert(op.origin_seq, op);
                }
            }
            if page.has_more && page.next_cursor <= cursor {
                return Err(RelayError::NoProgress);
            }
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }

        let mut shared_prefix_length = 0_i64;
        for op in &local_ops {
            if op.origin_seq != shared_prefix_length {
                break;
            }
            let Some(remote) = relay_ops.get(&op.origin_seq) else {
                break;
            };
            if remote.op_kind != op.op_kind
                || remote.recorded_at_ms != op.recorded_at_ms
                || canonical_json_bytes(&remote.payload).map_err(local)?
                    != canonical_json_bytes(&op.payload).map_err(local)?
            {
                break;
            }
            shared_prefix_length += 1;
        }
        let orphan_ops = local_ops
            .iter()
            .filter(|op| op.origin_seq >= shared_prefix_length)
            .cloned()
            .collect::<Vec<_>>();
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
                for (dense_seq, op) in orphan_ops.iter().enumerate() {
                    let dense_seq =
                        i64::try_from(dense_seq).map_err(|_| SyncError::CoordinateDiverged)?;
                    tx.execute(
                        "INSERT INTO replication_log \
                         (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                         VALUES (?1,?2,?3,?4,?5,?6,0)",
                        params![
                            workspace_id,
                            new_origin_id,
                            dense_seq,
                            op.op_kind,
                            serde_json::to_string(&op.payload).map_err(|_| {
                                SyncError::InvalidInput {
                                    reason: "payload is not valid JSON",
                                }
                            })?,
                            op.recorded_at_ms
                        ],
                    )
                    .map_err(SyncError::persist)?;
                }
                tx.execute(
                    "DELETE FROM replication_log \
                     WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq>=?3",
                    params![workspace_id, old_origin_id, shared_prefix_length],
                )
                .map_err(SyncError::persist)?;
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
                Ok::<(), SyncError>(())
            })
            .map_err(local)?;
        if matches!(result, TxnOutcome::Crashed { .. }) {
            return Err(RelayError::Local("injected-crash".to_owned()));
        }
        Ok(RecoverResponse {
            old_origin_id,
            new_origin_id: new_origin_id.to_owned(),
            shared_prefix_length,
            preserved_ops: orphan_ops.len(),
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
        let mut fetched = 0_usize;
        let mut ops = Vec::new();
        loop {
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
            fetched = fetched
                .checked_add(page.ops.len())
                .ok_or(RelayError::InvalidResponse)?;
            ops.extend(page.ops);
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }

        let boundary = crate::ShareBoundary {
            share_id: share_id.to_owned(),
            surface: crate::ShareSurface::SharedChannel,
            channel_wire_id: Some(channel_wire_id.to_owned()),
            path_prefix: None,
        };
        let mut applied = 0_usize;
        let mut refused = 0_usize;
        let mut skipped = 0_usize;
        let mut boundary_rejected = false;
        for op in ops {
            if own_echo.as_deref() == Some(op.origin_id.as_str()) {
                skipped += 1;
                continue;
            }
            let envelope = match share_envelope(workspace_id, op) {
                Ok(envelope) => envelope,
                Err(RelayError::InvalidResponse) => {
                    skipped += 1;
                    continue;
                }
                Err(error) => return Err(error),
            };
            match crate::apply_shared_envelope(store, &boundary, &envelope, faults) {
                Ok(ApplyOutcome::Applied(_)) => applied += 1,
                Ok(ApplyOutcome::Refused(_)) => refused += 1,
                Ok(ApplyOutcome::Skipped) => skipped += 1,
                Ok(ApplyOutcome::Crashed { .. }) => {
                    return Err(RelayError::Local("injected-crash".to_owned()));
                }
                Err(SyncError::ShareBoundaryViolation) => {
                    boundary_rejected = true;
                    skipped += 1;
                }
                Err(SyncError::InvalidInput { .. }) => {
                    skipped += 1;
                }
                Err(error) => return Err(local(error)),
            }
        }
        if boundary_rejected {
            return Err(RelayError::ShareOperationRejected);
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
            applied,
            refused,
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
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let scanned = read_shared_push_state(store, workspace_id, share_id)?;
        let all = list_all_origin_ops(store, workspace_id, &identity.origin_id)?;
        let mut dense_seq = -1_i64;
        let mut pending = Vec::new();
        let mut last_scanned = scanned;
        for op in all {
            let eligible = shared_channel_op_allowed(store, workspace_id, channel_wire_id, &op)?;
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
        }
        let mut pushed = 0_usize;
        for batch in pending.chunks(500) {
            let response = self.transport.shared_channel_push(SharedChannelRequest {
                share_id: share_id.to_owned(),
                channel_wire_id: channel_wire_id.to_owned(),
                origin_id: identity.origin_id.clone(),
                cursor: 0,
                ops: batch.iter().map(|(_, op)| op.clone()).collect(),
            })?;
            let push = response.push.ok_or(RelayError::InvalidResponse)?;
            if push.accepted != batch.len()
                || push.inserted.checked_add(push.skipped) != Some(push.accepted)
            {
                return Err(RelayError::InvalidResponse);
            }
            pushed = pushed
                .checked_add(push.inserted)
                .ok_or(RelayError::InvalidResponse)?;
            write_shared_push_state(
                store,
                workspace_id,
                share_id,
                batch.last().ok_or(RelayError::InvalidResponse)?.0,
                faults,
            )?;
        }
        write_shared_push_state(store, workspace_id, share_id, last_scanned, faults)?;
        Ok(SharedChannelPushOutcome { pushed })
    }

    pub fn pull_share_view(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        share_id: &str,
        path_prefix: &str,
        faults: &dyn FaultInjector,
    ) -> Result<ShareViewPullOutcome, RelayError> {
        let mut cursor =
            crate::read_share_cursor(store, workspace_id, share_id, crate::CursorKind::ShareView)
                .map_err(local)?;
        let mut fetched = 0_usize;
        let mut ops = Vec::new();
        loop {
            let page = self.transport.share_view_pull(ShareViewRequest {
                share_id: share_id.to_owned(),
                cursor,
                limit: 500,
            })?;
            validate_share_page(&page.ops, page.next_cursor, page.has_more, cursor)?;
            fetched = fetched
                .checked_add(page.ops.len())
                .ok_or(RelayError::InvalidResponse)?;
            ops.extend(page.ops);
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        let boundary = crate::ShareBoundary {
            share_id: share_id.to_owned(),
            surface: crate::ShareSurface::ShareView,
            channel_wire_id: None,
            path_prefix: Some(path_prefix.to_owned()),
        };
        let mut applied = 0_usize;
        let mut skipped = 0_usize;
        let mut changed = BTreeMap::<String, ShareViewChangedPath>::new();
        for op in ops {
            let envelope = match share_envelope(workspace_id, op) {
                Ok(envelope) => envelope,
                Err(RelayError::InvalidResponse) => {
                    skipped += 1;
                    continue;
                }
                Err(error) => return Err(error),
            };
            match crate::apply_shared_envelope(store, &boundary, &envelope, faults) {
                Ok(ApplyOutcome::Applied(_)) => {}
                Err(SyncError::ShareBoundaryViolation | SyncError::InvalidInput { .. }) => {
                    skipped += 1;
                    continue;
                }
                Err(error) => return Err(local(error)),
                _ => {
                    skipped += 1;
                    continue;
                }
            }
            let mut replay = ShareViewReplayContext {
                transport: &self.transport,
                store,
                workspace_id,
                share_id,
                faults,
                applied: &mut applied,
                changed: &mut changed,
            };
            replay_share_view_op(&mut replay, &envelope)?;
        }
        Ok(ShareViewPullOutcome {
            fetched,
            applied,
            skipped,
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
                let kind = refs.get(&sha256).ok_or(RelayError::InvalidResponse)?;
                let bytes =
                    local_blob_bytes(store, &sha256, *kind)?.ok_or(RelayError::BlobInvalid)?;
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
        for (sha256, kind) in collect_blob_refs(ops)? {
            if local_blob_bytes(store, &sha256, kind)?.is_some() {
                continue;
            }
            let response = self.transport.download_blob(BlobDownloadRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                sha256: sha256.clone(),
            })?;
            if hex_sha256(&response.bytes) != sha256 {
                return Err(RelayError::BlobInvalid);
            }
            let content = match kind {
                BlobKind::Text => String::from_utf8(response.bytes)
                    .map(BlobContent::Text)
                    .map_err(|_| RelayError::BlobInvalid)?,
                BlobKind::Binary => BlobContent::Binary(response.bytes),
            };
            match hydrate_blob_content(store, &BlobHydration { sha256, content }, faults).map_err(
                |error| {
                    if matches!(error, SyncError::BlobInvalid) {
                        RelayError::BlobInvalid
                    } else {
                        local(error)
                    }
                },
            )? {
                TxnOutcome::Committed(()) => {}
                TxnOutcome::Crashed { .. } => {
                    return Err(RelayError::Local("injected-crash".to_owned()));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum BlobKind {
    Text,
    Binary,
}

fn collect_blob_refs(
    ops: &[ReplicationEnvelope],
) -> Result<BTreeMap<String, BlobKind>, RelayError> {
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
                insert_optional_ref(
                    &mut refs,
                    op.payload.get("updateBlobSha256"),
                    BlobKind::Binary,
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
    refs: &mut BTreeMap<String, BlobKind>,
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
    refs.entry(sha256.to_owned())
        .and_modify(|present| {
            if kind == BlobKind::Binary {
                *present = kind;
            }
        })
        .or_insert(kind);
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn local_blob_bytes(
    store: &EngineStore,
    sha256: &str,
    kind: BlobKind,
) -> Result<Option<Vec<u8>>, RelayError> {
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
            BlobKind::Binary => {
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
                if usize::try_from(byte_length).ok() != Some(bytes.len())
                    || bytes.len() > 5 * 1024 * 1024
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

fn preflight_collisions(
    store: &EngineStore,
    workspace_id: &str,
    ops: &[ReplicationEnvelope],
) -> Result<(), RelayError> {
    store
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
                let local_payload: serde_json::Value = serde_json::from_str(&payload_json)
                    .map_err(|_| SyncError::CoordinateDiverged)?;
                let local_bytes = canonical_json_bytes(&local_payload)?;
                let remote_bytes = canonical_json_bytes(&op.payload)?;
                if op_kind != op.op_kind
                    || recorded_at_ms != op.recorded_at_ms
                    || local_bytes != remote_bytes
                {
                    return Err(SyncError::CoordinateDiverged);
                }
            }
            Ok(())
        })
        .map_err(|error| {
            if matches!(error, SyncError::CoordinateDiverged) {
                RelayError::OriginDiverged
            } else {
                local(error)
            }
        })
}

fn canonical_json_bytes(value: &serde_json::Value) -> Result<Vec<u8>, SyncError> {
    fn canonical(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.iter().map(canonical).collect())
            }
            serde_json::Value::Object(object) => {
                let mut entries = object.iter().collect::<Vec<_>>();
                entries.sort_by_key(|(key, _)| *key);
                serde_json::Value::Object(
                    entries
                        .into_iter()
                        .map(|(key, value)| (key.clone(), canonical(value)))
                        .collect(),
                )
            }
            scalar => scalar.clone(),
        }
    }

    serde_json::to_vec(&canonical(value)).map_err(|_| SyncError::CoordinateDiverged)
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
                 WHERE workspace_id=?1 ORDER BY origin_id",
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

fn validate_pull_page(
    response: &PullResponse,
    workspace_id: &str,
    cursor: i64,
) -> Result<(), RelayError> {
    if response.ops.len() > crate::MAX_PULL_OPS
        || !(0..=crate::MAX_WIRE_INTEGER).contains(&response.next_cursor)
        || response.next_cursor < cursor
        || (response.has_more && response.next_cursor <= cursor)
    {
        return Err(RelayError::InvalidResponse);
    }
    for op in &response.ops {
        if op.workspace_id != workspace_id || op.validate().is_err() {
            return Err(RelayError::InvalidResponse);
        }
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

fn share_envelope(
    workspace_id: &str,
    op: ShareReplicationEnvelope,
) -> Result<ReplicationEnvelope, RelayError> {
    let envelope = ReplicationEnvelope {
        workspace_id: workspace_id.to_owned(),
        origin_id: op.origin_id,
        origin_seq: op.origin_seq,
        op_kind: op.op_kind,
        payload: op.payload,
        recorded_at_ms: op.recorded_at_ms,
    };
    envelope
        .validate()
        .map_err(|_| RelayError::InvalidResponse)?;
    Ok(envelope)
}

fn read_shared_push_state(
    store: &EngineStore,
    workspace_id: &str,
    share_id: &str,
) -> Result<i64, RelayError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT pushed_seq FROM shared_channel_push_state \
                 WHERE workspace_id=?1 AND share_id=?2",
                params![workspace_id, share_id],
                |row| row.get(0),
            )
            .optional()
            .map(|value| value.unwrap_or(-1))
            .map_err(SyncError::corrupt)
        })
        .map_err(local)
}

fn write_shared_push_state(
    store: &mut EngineStore,
    workspace_id: &str,
    share_id: &str,
    pushed_seq: i64,
    faults: &dyn FaultInjector,
) -> Result<(), RelayError> {
    if !(-1..=crate::MAX_WIRE_INTEGER).contains(&pushed_seq) {
        return Err(RelayError::InvalidResponse);
    }
    let outcome = store
        .write_with(faults, |tx| {
            tx.execute(
                "INSERT INTO shared_channel_push_state (workspace_id,share_id,pushed_seq) \
                 VALUES (?1,?2,?3) ON CONFLICT(workspace_id,share_id) DO UPDATE SET \
                 pushed_seq=excluded.pushed_seq",
                params![workspace_id, share_id, pushed_seq],
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

fn list_all_origin_ops(
    store: &EngineStore,
    workspace_id: &str,
    origin_id: &str,
) -> Result<Vec<ReplicationEnvelope>, RelayError> {
    let mut after = -1;
    let mut all = Vec::new();
    loop {
        let page = list_replication_ops(store, workspace_id, origin_id, after, crate::MAX_PULL_OPS)
            .map_err(local)?;
        let Some(last) = page.last() else {
            break;
        };
        after = last.origin_seq;
        all.extend(page);
    }
    Ok(all)
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
    changed: &'a mut BTreeMap<String, ShareViewChangedPath>,
}

fn replay_share_view_op<T: RelayTransport>(
    context: &mut ShareViewReplayContext<'_, T>,
    envelope: &ReplicationEnvelope,
) -> Result<(), RelayError> {
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
                    replay_share_write(
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
                    )?;
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
                    replay_share_write(
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
                    )?;
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
                replay_share_write(
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
                )?;
            }
        }
    }
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
) -> Result<(), RelayError> {
    if !valid_sha256(sha256) {
        return Err(RelayError::BlobInvalid);
    }
    let bytes = transport
        .share_blob(ShareBlobRequest {
            share_id: share_id.to_owned(),
            sha256: sha256.to_owned(),
        })?
        .bytes;
    if hex_sha256(&bytes) != sha256 {
        return Err(RelayError::BlobInvalid);
    }
    let key = replay_id(share_id, envelope, "write", path);
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
                        author_json: None,
                        now_ms: envelope.recorded_at_ms,
                        request_id: Some(format!("share-view:{key}")),
                    },
                    faults,
                )
                .map_err(domain)?
                .deduped
        } else {
            let text = String::from_utf8(bytes).map_err(|_| RelayError::BlobInvalid)?;
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
                        author_json: None,
                        now_ms: envelope.recorded_at_ms,
                        request_id: Some(format!("share-view:{key}")),
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
    RelayError::Local(error.code().to_owned())
}

fn validate_identity_request(workspace: &str, epoch: &str, stream: &str) -> Result<(), RelayError> {
    crate::model::bounded(workspace, "workspace_id must be non-empty and bounded")
        .map_err(local)?;
    crate::model::bounded(epoch, "replication_epoch must be non-empty and bounded")
        .map_err(local)?;
    crate::model::bounded(stream, "stream_identity must be non-empty and bounded").map_err(local)
}

fn local(error: SyncError) -> RelayError {
    RelayError::Local(error.code().to_owned())
}
