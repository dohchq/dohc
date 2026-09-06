use crate::EngineService;
use crate::rpc::error::map_runtime;
use crate::rpc::error::wire;
use crate::rpc::history::moment_json;
use crate::rpc::history::withhold_moment_texts;
use crate::rpc::reads::RESPONSE_FRAME_BYTES;
use crate::rpc::reads::byte_budget_cut_serialized_with_row_cap;
use crate::rpc::reads::file_object_json;
use crate::rpc::reads::json_string_encoded_len;
use crate::rpc::reads::response_encoded_bytes;
use crate::rpc::reads::settled_snapshot_json;
use crate::rpc::reads::snapshot_json;
use crate::rpc::reads::snapshot_metadata_json;
use crate::rpc::reads::withhold_over_cap_text;
use crate::rpc::reads::withhold_text;
use crate::rpc::relay::sharing_declined_json;
use crate::rpc::request::MAX_METADATA_FIELD_BYTES;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::request::validate_metadata_fields;
use crate::rpc::request::validated_origin;
use crate::rpc::workspace::enforce_workspace;
use dohc_engine_domain::ConflictChoice;
use dohc_engine_domain::ConflictContentKind;
use dohc_engine_domain::ConflictFileState;
use dohc_engine_domain::ConflictMetadata;
use dohc_engine_domain::ConflictResolution;
use dohc_engine_domain::ConflictStatus;
use dohc_engine_domain::ResolveConflictKind;
use dohc_engine_domain::ResolveTextConflict;
use dohc_engine_domain::TextConflict;
use dohc_engine_domain::TextSnapshot;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::ApplyOutcome;
use dohc_engine_runtime::ConflictApplyResult;
use dohc_engine_runtime::NoFaults;
use dohc_engine_sync::ReplicationEnvelope;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

/// The encoded size of the request envelope that carried these params — what
/// the control frame actually held.
///
/// Every field is the caller'S OWN: this request's id, deadline, workspace
/// handle, idempotency key and params, re-encoded by the same encoder the
/// transport uses. Nothing is reserved and nothing is substituted. A
/// worst-case stand-in for a field the daemon can read (this one used
/// `u64::MAX` and `u32::MAX` for the id and deadline) inflates the total by
/// about thirty bytes, which rejects requests that did cross the frame and
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

/// What a resolve answer spends on everything the REQUEST supplies, each
/// string counted at the number of places the answer serves it.
///
/// Read off the answer builder and rounded up: the object id rides
/// `object.id`, `snapshot.objectId` and `moment.objectId` in both the write
/// and the delete block; each moment id rides its own block's snapshot and
/// moment; the metadata pair rides both snapshots and both moments; the author
/// rides both moments, and its PARSED form is never longer than the string
/// measured here.
fn resolve_answer_beside_conflict_bytes(local: &LocalResolveDto) -> usize {
    let optional = |value: &Option<String>| value.as_deref().map_or(0, json_string_encoded_len);
    6 * json_string_encoded_len(&local.object_id)
        + 3 * json_string_encoded_len(&local.write_moment_id)
        + 3 * json_string_encoded_len(&local.delete_moment_id)
        + 4 * optional(&local.metadata_summary)
        + 4 * optional(&local.metadata_correlation_id)
        + 2 * optional(&local.author_json)
}

const CONFLICTS_PAGE_BYTE_BUDGET: usize = 256 * 1024;

const CONFLICTS_RESPONSE_ROW_LIMIT: usize =
    dohc_engine_domain::TEXT_CONFLICT_QUERY_LIMIT as usize - 1;

/// The most one serialized conflict row may carry in band: the negotiated
/// 8 MiB control frame, retaining explicit envelope and continuation
/// headroom. A row past it is degraded, not refused — `conflicts_list`
/// withholds its over-cap side bodies, and the caller hydrates them through
/// `versionedText.readBlob`.
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

/// What a fully withheld resolve answer spends on JSON keys, punctuation and
/// every fixed-width field beside them — 64-hex digests, i64 counters, enum
/// strings, the `inbandLimitBytes` numbers each withheld body leaves behind.
/// `a_fully_withheld_resolve_answer_fits_its_scaffolding_allowance` measures
/// the real figure against this, which is why it is public: a test carrying
/// its own copy of the number would pass whatever this held.
pub const RESOLVE_ANSWER_SCAFFOLDING_BYTES: usize = 64 * 1024;

/// The one part of a resolve answer that no request supplies and no conflict
/// row carries: the metadata pair on the head a resolution REMOVES. The write
/// path that minted it bounded each field at `MAX_METADATA_FIELD_BYTES`
/// decoded, and escaping costs at most six bytes per byte, so both fields
/// together cannot pass this.
const RESOLVE_ANSWER_REMOVED_HEAD_METADATA_BYTES: usize = 2 * (6 * MAX_METADATA_FIELD_BYTES + 2);

/// Everything a resolve answer carries that is neither the conflict row nor
/// this request's own fields.
const RESOLVE_ANSWER_STRUCTURAL_BYTES: usize =
    RESOLVE_ANSWER_SCAFFOLDING_BYTES + RESOLVE_ANSWER_REMOVED_HEAD_METADATA_BYTES;

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
        // No size gate here on purpose. Everything a conflict row carries
        // that withholding cannot shrink is bounded once, at the shared
        // pre-persistence path both conflict opens funnel through
        // (`insert_text_conflict_if_absent`) — this DTO is only the local
        // route, and a peer's replicated open never passes through it.
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
            binary_updated_at_ms: None,
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

/// The conflict a resolution closed, with every side's body withheld past the
/// in-band cap.
///
/// One rule bounds this whole answer, because no part of it may grow with a
/// body. The answer carries five text bodies — three sides, the settled
/// snapshot, and the moment's before and after — and one control frame has to
/// hold all of them. Withholding each past 128 KiB caps the answer at five
/// residuals plus metadata, about 640 KiB inside an 8 MiB frame. Withhold
/// only some of them and a conflict whose row approaches
/// `CONFLICT_ROW_HARD_CAP_BYTES` still overruns the frame — and the daemon's
/// writer treats an oversized answer as a fatal transport error after the
/// resolution has committed.
///
/// The conflict listing shares the withholding, not the trigger: it carries
/// bodies in band up to `CONFLICT_ROW_HARD_CAP_BYTES` per row, and degrades
/// only a row past that (`conflicts_list`).
fn settled_conflict_json(conflict: &TextConflict) -> Value {
    let mut value = conflict_json(conflict);
    withhold_conflict_side_texts(&mut value);
    value
}

/// Withhold every over-cap side body of one serialized conflict, in place.
/// Each side keeps its digest, byte length and `inbandLimitBytes`, so the
/// caller hydrates through `versionedText.readBlob`.
fn withhold_conflict_side_texts(value: &mut Value) {
    for side in ["base", "current", "incoming"] {
        if let Some(snapshot) = value[side].get_mut("snapshot")
            && !snapshot.is_null()
        {
            withhold_over_cap_text(snapshot);
        }
    }
}

/// Withhold every side body of one serialized conflict, whatever each body's
/// own size.
///
/// The per-body rule above cannot degrade an aggregate overrun: three sides of
/// 128 KiB each are individually in band, and beside metadata near
/// `CONFLICT_METADATA_BUDGET_BYTES` their sum still carries the row past
/// `CONFLICT_ROW_HARD_CAP_BYTES`. Withholding only the over-cap bodies would
/// leave the row over the cap and dead-end the cursor — the failure is the
/// sum, so the remedy has to be the sum. With every body withheld, what
/// remains is bounded at open, so the row provably fits.
fn withhold_all_conflict_side_texts(value: &mut Value) {
    for side in ["base", "current", "incoming"] {
        if let Some(snapshot) = value[side].get_mut("snapshot")
            && !snapshot.is_null()
        {
            withhold_text(snapshot);
        }
    }
}

/// Withhold every body one resolve answer carries: the conflict's three sides,
/// the settled snapshot, and both moments' payloads. The removed head is
/// described by its moment, so `delete.before` carries no body to withhold.
fn withhold_all_resolve_answer_texts(answer: &mut Value) {
    withhold_all_conflict_side_texts(&mut answer["conflict"]);
    for block in ["write", "delete"] {
        let Some(block) = answer.get_mut(block).filter(|value| !value.is_null()) else {
            continue;
        };
        if let Some(snapshot) = block.get_mut("snapshot")
            && !snapshot.is_null()
        {
            withhold_text(snapshot);
        }
        if let Some(moment) = block.get_mut("moment")
            && !moment.is_null()
        {
            withhold_moment_texts(moment);
        }
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
            json!({
                "replicated": true,
                "status": "applied",
                "conflictId": result.conflict_id,
                "inserted": result.inserted,
                "matched": result.matched
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
        ApplyOutcome::WithDiagnostics {
            outcome,
            refusals,
            sharing_declined,
        } => {
            let mut value = replicated_conflict_json(*outcome);
            if let Some(object) = value.as_object_mut() {
                if !refusals.is_empty() {
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
                if !sharing_declined.is_empty() {
                    object.insert(
                        "sharingDeclined".to_owned(),
                        Value::Array(sharing_declined_json(sharing_declined)),
                    );
                }
            }
            value
        }
    }
}

impl EngineService {
    pub(super) async fn conflicts_list(
        &self,
        ctx: &RequestContext,
        id: u64,
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
        let mut rows: Vec<Value> = conflicts[..candidates].iter().map(conflict_json).collect();
        // A row past the hard cap can never ship in band, and refusing it
        // would refuse its healthy neighbors and dead-end the cursor: an
        // over-cap row that is not first ends the page, the cursor advances
        // to it, and the next request makes it the leading row. Degrade that
        // row instead: withhold each over-cap side body, so the `blobSha256`
        // and `inbandLimitBytes` beside it route the caller to
        // `versionedText.readBlob` — the hydration `versionedText.read`
        // already uses.
        for row in &mut rows {
            if serde_json::to_string(row).map_or(0, |s| s.len()) > CONFLICT_ROW_HARD_CAP_BYTES {
                // Every body, not just the over-cap ones: the row crossed on
                // the sum of its parts, so withholding only the parts that
                // individually cross can leave it over the cap.
                withhold_all_conflict_side_texts(row);
            }
        }
        let included = byte_budget_cut_serialized_with_row_cap(
            &rows,
            CONFLICTS_PAGE_BYTE_BUDGET,
            CONFLICT_ROW_HARD_CAP_BYTES,
        );
        if included == 0 && !conflicts.is_empty() {
            // The last line of defense, not dead code: withholding nulls only
            // the side bodies, so this fires for a row still over the cap on
            // what remains — which is why every string that survives
            // withholding is bounded before persistence, at the shared path
            // both open routes funnel through
            // (`insert_text_conflict_if_absent`). A named refusal beats an
            // over-frame response the daemon's writer treats as fatal.
            let observed = rows
                .first()
                .and_then(|row| serde_json::to_string(row).ok())
                .map_or(0, |serialized| serialized.len());
            return Err(WireError::new(
                ErrorCode::LimitExceeded,
                format!(
                    "conflict-row-exceeds-wire-limit: a conflicts.list row is capped at \
                     CONFLICT_ROW_HARD_CAP_BYTES = {CONFLICT_ROW_HARD_CAP_BYTES} serialized \
                     bytes; observed {observed} bytes after withholding"
                ),
            ));
        }
        let next_after_conflict_id = (included < conflicts.len())
            .then(|| {
                conflicts[..included]
                    .last()
                    .map(|conflict| conflict.conflict_id.clone())
            })
            .flatten();
        let mut page = json!({
            "conflicts": rows[..included].to_vec(),
            "nextAfterConflictId": next_after_conflict_id,
        });
        // The cap above bounds a ROW; the frame carries the PAGE. The
        // continuation is appended after the cut — a second copy of one row's
        // id — and a body admitted in band can leave no room for it, so a row
        // and a cursor that are each admissible still cross together. Measure
        // the encoded response, and past the frame withhold every body on
        // every row: the sum is what crossed, so the remedy is the sum.
        //
        // The withheld page fits. A fully withheld row costs its non-withheld
        // strings plus scaffolding — `CONFLICT_METADATA_BUDGET_BYTES` plus
        // `CONFLICT_ROW_STRUCTURAL_HEADROOM_BYTES`, both bounded before
        // persistence — and that budget counts the conflict id twice, which is
        // precisely the continuation's copy. A page of several rows is bounded
        // instead by `CONFLICTS_PAGE_BYTE_BUDGET`, which admits a row after the
        // first only while the running total stays inside it, and its
        // continuation is one of those rows' ids.
        if response_encoded_bytes(id, &page) > RESPONSE_FRAME_BYTES {
            for row in page["conflicts"].as_array_mut().into_iter().flatten() {
                withhold_all_conflict_side_texts(row);
            }
            let observed = response_encoded_bytes(id, &page);
            if observed > RESPONSE_FRAME_BYTES {
                // The last line of defense for the page, in the shape the row
                // guard above already has: a named refusal beats an over-frame
                // response the daemon's writer treats as fatal.
                return Err(WireError::new(
                    ErrorCode::LimitExceeded,
                    format!(
                        "conflict-page-exceeds-wire-limit: a conflicts.list response is capped \
                         at the negotiated control frame of {RESPONSE_FRAME_BYTES} encoded \
                         bytes; observed {observed} encoded bytes after withholding every body"
                    ),
                ));
            }
        }
        Ok(page)
    }

    pub(super) async fn conflicts_open(
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
                .conflict_apply_replicated(
                    envelope,
                    Arc::new(NoFaults),
                    self.leases.scoped(&open.root),
                    cancellation.token(),
                )
                .await
                .map_err(map_runtime)?;
            if matches!(&result, ApplyOutcome::Applied(_)) {
                open.request_collection_reconcile();
            }
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
        if inserted {
            open.request_collection_reconcile();
        }
        Ok(json!({ "inserted": inserted }))
    }

    pub(super) async fn conflicts_resolve(
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
                .conflict_apply_replicated(
                    envelope,
                    Arc::new(NoFaults),
                    self.leases.scoped(&open.root),
                    cancellation.token(),
                )
                .await
                .map_err(map_runtime)?;
            if matches!(&result, ApplyOutcome::Applied(_)) {
                open.request_collection_reconcile();
            }
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
        let metadata_origin = validated_origin(Some(&local.metadata_origin))?;
        // The answer is built after the mutation commits. Withholding (below)
        // takes out every body, never the strings beside them, so an answer
        // whose withheld form still passes the frame cannot be sent at all —
        // and by then the resolution has happened, which turns a transport
        // limit into a lost acknowledgement. So the answer is bounded before
        // anything is written: reserve what this request's own fields will
        // spend, and the resolve transaction refuses inside itself, without
        // writing, if the conflict cannot fit in what remains.
        //
        // The reservation is an upper bound, not an estimate. Every string a
        // withheld answer serves is one of three things:
        //   1. the conflict row's own strings, measured against this budget in
        //      the transaction that serves them (`non_withheld_encoded_bytes`);
        //   2. this request's identifiers and metadata, counted here at every
        //      place the answer repeats them;
        //   3. scaffolding, fixed-width fields, and the removed head's
        //      metadata pair — `RESOLVE_ANSWER_STRUCTURAL_BYTES`.
        // Nothing else can appear. The write and delete blocks describe the
        // live head, and `live_state_matches_conflict_current` admits a
        // resolution only when that head matches the recorded current side on
        // path, object and latest moment — so those identifiers are the
        // conflict row's, already counted in (1).
        //
        // Healthy work cannot reach it, measured rather than assumed. Three
        // UUID identifiers served twelve times cost under 600 bytes, and the
        // sibling write paths cap a metadata field at
        // `MAX_METADATA_FIELD_BYTES`. `a_worst_legitimate_resolve_is_admitted`
        // runs the heaviest legitimate resolve there is — every free-form
        // field at that cap, in its escaping-heaviest form, on the conflict
        // and on the request — and its conflict measures 655,980 encoded
        // bytes against a budget of about 8.13 MB, twelve times inside it.
        // The only conflicts this can refuse carry metadata within a quarter
        // megabyte of an entire control frame.
        let conflict_answer_budget_bytes = RESPONSE_FRAME_BYTES
            .saturating_sub(resolve_answer_beside_conflict_bytes(&local))
            .saturating_sub(RESOLVE_ANSWER_STRUCTURAL_BYTES);
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
        let scoped_leases = self.leases.scoped(&open.root);
        let result = open
            .actor
            .conflict_resolve_indexed(
                ResolveTextConflict {
                    workspace_id: open.workspace_id.clone(),
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
                    conflict_answer_budget_bytes,
                },
                scoped_leases,
                open.root.clone(),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        open.request_collection_reconcile();
        let mut answer = json!({
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
        });
        // One frame carries the whole answer, and this one reports a mutation
        // that already committed: an over-frame answer loses the caller's
        // acknowledgement for work the workspace kept. Each body is withheld
        // past the in-band cap above; nothing bounds their sum beside a
        // conflict whose own metadata may reach
        // `CONFLICT_METADATA_BUDGET_BYTES`. Measure the encoded answer, and
        // past the frame withhold every body it carries — each keeps its
        // digest and `inbandLimitBytes`, so the caller hydrates through
        // `versionedText.readBlob`.
        //
        // This is the belt, not the guarantee. The guarantee is the budget
        // reserved above and enforced inside the resolve transaction, which
        // refuses — without writing — an answer whose withheld form cannot
        // fit. What this pass adds is the shrinking that keeps a fitting
        // answer inside the frame once the bodies are counted. Refusing here
        // is not an option: the resolution has committed, and a refusal would
        // report a mutation that happened as one that did not.
        if response_encoded_bytes(id, &answer) > RESPONSE_FRAME_BYTES {
            withhold_all_resolve_answer_texts(&mut answer);
        }
        Ok(answer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::reads::json_string_encoded_len;
    use dohc_engine_runtime::ApplyOutcome;
    use serde_json::json;

    #[test]
    fn encoded_length_agrees_with_the_encoder_that_builds_the_frame() {
        // The merged-resolution budget is spent in ENCODED bytes, so this
        // count must be the encoder's count, not an approximation of it. Every
        // escape class serde_json has: the two-byte shorthands, the six-byte
        // \u form for the other control bytes, DEL (which it does not escape),
        // and multi-byte UTF-8 (which it passes through).
        //
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

    /// The domain bounds a conflict's non-withheld strings, but the cap it is
    /// derived from lives here, on the transport. Neither crate can see the
    /// other's constant, so the derivation is pinned by this guard: if the
    /// frame, the envelope headroom or the scaffolding allowance moves and the
    /// budget does not, a conflict the listing cannot carry becomes
    /// persistable again.
    #[test]
    fn the_conflict_metadata_budget_stays_derived_from_the_row_cap() {
        assert_eq!(
            dohc_engine_domain::CONFLICT_METADATA_BUDGET_BYTES
                + dohc_engine_domain::CONFLICT_ROW_STRUCTURAL_HEADROOM_BYTES,
            CONFLICT_ROW_HARD_CAP_BYTES,
            "the metadata budget plus its scaffolding allowance must equal the row cap"
        );
    }
}
