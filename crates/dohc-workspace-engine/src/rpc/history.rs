use crate::EngineService;
use crate::lock;
use crate::rpc::capture::MAX_DESKTOP_CAPTURE_TEXT_BYTES;
use crate::rpc::error::workspace_unavailable;
use crate::rpc::reads::MAX_INBAND_CONTENT_BYTES;
use crate::rpc::reads::byte_budget_cut_serialized;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::parse;
use crate::rpc::secrets::secret_moment_json;
use crate::rpc::versions::version_record_json;
use crate::rpc::workspace::validate_workspace_param;
use dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES;
use dohc_engine_domain::MomentPage;
use dohc_engine_domain::MomentRecord;
use dohc_engine_domain::{
    HistoryCursor, HistoryMarkerPosition, HistoryMomentMetadata, HistoryMomentPosition,
    HistoryPageRead,
};
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::time::Duration;

/// Approximate serialized-bytes budget for one moments.list page: a row
/// can legitimately carry 64 KiB strings (authorJson), so a row COUNT can
/// never bound the frame — the page cuts when the running estimate would
/// pass this, well under the 1 MiB frame limit.
pub(super) const MOMENTS_PAGE_BYTE_BUDGET: usize = 256 * 1024;

const HISTORY_PAGE_FLUSH_RETRIES: usize = 50;

const HISTORY_PAGE_FLUSH_RETRY_DELAY: Duration = Duration::from_millis(20);

struct EncodedMomentPage {
    rows: Vec<Value>,
    included: usize,
    next_before_moment_order: Option<i64>,
    latest_moment_order: i64,
}

impl EncodedMomentPage {
    fn into_json(self) -> Value {
        json!({
            "moments": self.rows[..self.included].to_vec(),
            "nextBeforeMomentOrder": self.next_before_moment_order,
            "latestMomentOrder": self.latest_moment_order,
        })
    }
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
struct HistoryPageParams {
    workspace_id: String,
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    object_id: Option<String>,
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    cursor: Option<HistoryCursor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MomentsGetParams {
    moment_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicationAppliedParams {
    request_id: String,
    moment_id: String,
}

/// How a moment projection carries its two payload bodies.
#[derive(Clone, Copy)]
enum MomentBodies {
    /// Each body under the same self-describing in-band cap as every content
    /// read.
    Capped,
    /// Every body the capped form would carry, withheld at that cap.
    Withheld,
    /// Neither body: a first page row past `MOMENTS_PAGE_BYTE_BUDGET`, sent as
    /// metadata so the cursor still makes progress.
    PageDegraded,
}

impl MomentBodies {
    /// One payload body and the in-band limit beside it.
    fn project<'a>(
        self,
        content_kind: &str,
        text: Option<&'a str>,
        byte_length: Option<i64>,
    ) -> (Option<&'a str>, Option<usize>) {
        let capped = text.filter(|text| text.len() <= MAX_DESKTOP_CAPTURE_TEXT_BYTES);
        match (self, capped) {
            (MomentBodies::PageDegraded, _) => (None, Some(MAX_INBAND_CONTENT_BYTES)),
            (MomentBodies::Withheld, Some(_)) => (None, Some(MAX_DESKTOP_CAPTURE_TEXT_BYTES)),
            (_, Some(text)) => (Some(text), None),
            // Only a text body the store left unhydrated names the limit.
            (_, None) => {
                let over_cap = content_kind == "text"
                    && text.is_none()
                    && byte_length
                        .is_some_and(|length| length as usize > MAX_DESKTOP_CAPTURE_TEXT_BYTES);
                (None, over_cap.then_some(MAX_DESKTOP_CAPTURE_TEXT_BYTES))
            }
        }
    }
}

fn moment_wire_json(moment: &MomentRecord, bodies: MomentBodies) -> Value {
    let (after_text, after_inband_limit_bytes) = bodies.project(
        &moment.after_content_kind,
        moment.after_text.as_deref(),
        moment.after_byte_length,
    );
    let (before_text, before_inband_limit_bytes) = bodies.project(
        &moment.before_content_kind,
        moment.before_text.as_deref(),
        moment.before_byte_length,
    );
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
        // PARSED authors: absent column = actor-neutral; an entry that does
        // not parse surfaces as an explicit corrupt marker, never silently
        // dropped and never trusted raw.
        "authors": moment.author_json.as_deref().map(parsed_moment_authors),
        "syncRecordOnly": moment.sync_record_only,
        // Hydrated payload text (momentSelectSql parity).
        "afterText": after_text,
        "afterByteLength": moment.after_byte_length,
        "afterInbandLimitBytes": after_inband_limit_bytes,
        "beforeText": before_text,
        "beforeByteLength": moment.before_byte_length,
        "beforeInbandLimitBytes": before_inband_limit_bytes,
        "beforePath": moment.before_path,
    })
}

pub(super) fn moment_json(moment: &MomentRecord) -> Value {
    moment_wire_json(moment, MomentBodies::Capped)
}

/// A moment with both payload bodies withheld. The digests beside them stay,
/// so the caller hydrates through `versionedText.readBlob` — the shape an
/// over-cap moment already arrives in.
pub(super) fn withheld_moment_json(moment: &MomentRecord) -> Value {
    moment_wire_json(moment, MomentBodies::Withheld)
}

fn encode_moment_page(page: &MomentPage) -> Result<EncodedMomentPage, WireError> {
    // A row COUNT cannot bound the frame: authorJson alone may be a 64 KiB
    // string. The measured serialized cut is shared by moments.list and the
    // aggregate history page so their text page and cursor stay identical.
    let mut rows: Vec<Value> = page.moments.iter().map(moment_json).collect();
    // A first row may legitimately exceed the page budget. Degrade that row
    // to metadata so the cursor still makes progress, exactly as moments.list
    // did before the history aggregate existed.
    if let (Some(first), Some(moment)) = (rows.first_mut(), page.moments.first())
        && serde_json::to_string(first).map_or(0, |s| s.len()) > MOMENTS_PAGE_BYTE_BUDGET
    {
        *first = moment_wire_json(moment, MomentBodies::PageDegraded);
    }
    let included = byte_budget_cut_serialized(&rows, MOMENTS_PAGE_BYTE_BUDGET);
    if included == 0 && !rows.is_empty() {
        return Err(WireError::new(
            ErrorCode::Internal,
            "a moment row exceeds the response frame budget",
        ));
    }
    let next_before_moment_order = if included < rows.len() {
        page.moments[..included]
            .last()
            .map(|moment| moment.moment_order)
    } else {
        page.next_before_moment_order
    };
    Ok(EncodedMomentPage {
        rows,
        included,
        next_before_moment_order,
        // The TS contract uses -1 for an empty timeline, never null.
        latest_moment_order: page.latest_moment_order.unwrap_or(-1),
    })
}

fn history_moment_json(moment: &HistoryMomentMetadata) -> Value {
    json!({
        "momentOrder":moment.moment_order,"momentId":moment.moment_id,"versionId":moment.version_id,
        "objectId":moment.object_id,"path":moment.path,"beforePath":moment.before_path,"recordedAtMs":moment.recorded_at_ms,
        "operation":moment.operation.as_str(),"afterContentKind":moment.after_content_kind,
        "afterByteLength":moment.after_byte_length,"metadataOrigin":moment.metadata_origin,
        "metadataSummary":moment.metadata_summary,"metadataCorrelationId":moment.metadata_correlation_id,
        "authors":moment.author_json.as_deref().map(parsed_moment_authors),"syncRecordOnly":moment.sync_record_only,
    })
}

enum HistoryPosition {
    Text(HistoryMomentPosition),
    Protected(HistoryMomentPosition),
    Marker(HistoryMarkerPosition),
}

fn encode_history_page(read: HistoryPageRead, limit: usize) -> Result<Value, WireError> {
    let start_cursor = read.cursor;
    let mut cursor = start_cursor.clone();
    let mut rows = Vec::new();
    for moment in read.moments {
        let pos = HistoryMomentPosition {
            recorded_at_ms: moment.recorded_at_ms,
            moment_order: moment.moment_order,
        };
        rows.push((
            moment.recorded_at_ms,
            0,
            moment.moment_order,
            moment.moment_id.clone(),
            history_moment_json(&moment),
            HistoryPosition::Text(pos),
        ));
    }
    for moment in read.protected_moments {
        let pos = HistoryMomentPosition {
            recorded_at_ms: moment.recorded_at_ms,
            moment_order: moment.moment_order,
        };
        rows.push((
            moment.recorded_at_ms,
            1,
            moment.moment_order,
            moment.moment_id.clone(),
            secret_moment_json(&moment),
            HistoryPosition::Protected(pos),
        ));
    }
    for version in read.version_markers {
        let pos = HistoryMarkerPosition {
            created_at_ms: version.created_at_ms,
            version_id: version.version_id.clone(),
        };
        rows.push((
            version.created_at_ms,
            2,
            0,
            version.version_id.clone(),
            version_record_json(&version),
            HistoryPosition::Marker(pos),
        ));
    }
    rows.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(a.1.cmp(&b.1))
            .then(b.2.cmp(&a.2))
            .then(b.3.cmp(&a.3))
    });
    let available = rows.len();
    let mut result = json!({"activeVersion":version_record_json(&read.active_version),"moments":[],"protectedMoments":[],"versionMarkers":[],"startCursor":start_cursor,"nextCursor":null,"latestMomentOrder":cursor.text_fence});
    let base_bytes = serde_json::to_vec(&result)
        .map_err(|_| WireError::new(ErrorCode::Internal, "history metadata encoding failed"))?
        .len();
    let mut used_bytes = 0;
    let mut included = 0;
    for (_, _, _, _, row, position) in rows.into_iter().take(limit) {
        let mut next = cursor.clone();
        let key = match position {
            HistoryPosition::Text(position) => {
                next.text = Some(position);
                "moments"
            }
            HistoryPosition::Protected(position) => {
                next.protected = Some(position);
                "protectedMoments"
            }
            HistoryPosition::Marker(position) => {
                next.marker = Some(position);
                "versionMarkers"
            }
        };
        let row_bytes = serde_json::to_vec(&row)
            .map_err(|_| WireError::new(ErrorCode::Internal, "history metadata encoding failed"))?
            .len();
        let cursor_bytes = serde_json::to_vec(&next)
            .map_err(|_| WireError::new(ErrorCode::Internal, "history cursor encoding failed"))?
            .len();
        if base_bytes + used_bytes + row_bytes + cursor_bytes + included + 16
            > MOMENTS_PAGE_BYTE_BUDGET
        {
            break;
        }
        used_bytes += row_bytes;
        result[key].as_array_mut().expect("history array").push(row);
        cursor = next;
        included += 1;
    }
    if included == 0 && available > 0 {
        return Err(WireError::new(
            ErrorCode::Internal,
            "a history metadata row exceeds the page byte budget",
        ));
    }
    if included < available {
        result["nextCursor"] = json!(cursor);
    }
    Ok(result)
}

/// A moment's stored author list, entry by entry. A value that is not a
/// nonempty list reads as one corrupt entry.
fn parsed_moment_authors(raw: &str) -> Value {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(authors)) if !authors.is_empty() => {
            Value::Array(authors.into_iter().map(parsed_moment_author).collect())
        }
        _ => json!([{ "corrupt": true }]),
    }
}

/// Fail-closed author parsing (parity with the TS wire `MomentAuthorSchema`):
/// only a supported author shape renders as an author. Anything
/// else, such as a hand-edited shape, surfaces as an explicit corrupt
/// marker, never a valid-looking attribution.
fn parsed_moment_author(value: Value) -> Value {
    let corrupt = || json!({ "corrupt": true });
    let Some(object) = value.as_object() else {
        return corrupt();
    };
    if object.get("kind").and_then(Value::as_str) == Some("unattributed") {
        return if object.len() == 1 { value } else { corrupt() };
    }
    let bounded_ids = |keys: &[&str]| {
        keys.iter().all(|key| {
            object
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty() && v.len() <= MAX_AUTHOR_FIELD_BYTES)
        })
    };
    // A field of a relay-admitted live author snapshot, within its admission bound.
    let snapshot_text = |key: &str| {
        object.get(key).and_then(Value::as_str).is_some_and(|v| {
            !v.is_empty()
                && v.len() <= MAX_AUTHOR_FIELD_BYTES
                && !v.bytes().any(|b| b.is_ascii_control())
        })
    };
    let principal_ok = object
        .get("onBehalfOf")
        .is_none_or(|value| value.as_str().is_some_and(|value| !value.is_empty()));
    // A snapshot names an account holder or a link's public principal with
    // the name the relay stored for them.
    let snapshot_fields = match object.get("kind").and_then(Value::as_str) {
        Some("human") if object.contains_key("humanName") => Some(["humanId", "humanName"]),
        Some("link") if object.contains_key("publicPrincipalId") => {
            Some(["publicPrincipalId", "label"])
        }
        _ => None,
    };
    if let Some(fields) = snapshot_fields {
        // The relay confirms an admitted person, never a link holder.
        let marker = object.get("kind").and_then(Value::as_str) == Some("human")
            && object.contains_key("relayConfirmed");
        let valid = object.len() == 3 + usize::from(marker)
            && fields.into_iter().all(&snapshot_text)
            && (!marker || object.get("relayConfirmed") == Some(&Value::Bool(true)));
        return if valid { value } else { corrupt() };
    }
    if object.get("kind").and_then(Value::as_str) == Some("public") {
        let valid = object.len() == 3 && bounded_ids(&["principalId", "grantId"]);
        return if valid { value } else { corrupt() };
    }
    // A direct write names its grant and generation, and either the named
    // recipient's user or the link's principal.
    let direct_write_ids = match object.get("kind").and_then(Value::as_str) {
        Some("named") => Some(["userId", "grantId"]),
        Some("link") => Some(["grantId", "principalId"]),
        _ => None,
    };
    if let Some(ids) = direct_write_ids {
        let valid = object.len() == 4
            && bounded_ids(&ids)
            && object
                .get("grantGeneration")
                .and_then(Value::as_i64)
                .is_some_and(|generation| generation >= 1);
        return if valid { value } else { corrupt() };
    }
    if object.get("kind").and_then(Value::as_str) == Some("automation") {
        let text = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty())
        };
        let valid = object.len() == 3 + usize::from(object.contains_key("onBehalfOf"))
            && text("automationId")
            && principal_ok
            && object
                .get("depth")
                .and_then(Value::as_u64)
                .is_some_and(|depth| {
                    depth <= u64::from(dohc_engine_domain::MAX_CHANGE_ATTRIBUTION_DEPTH)
                });
        return if valid { value } else { corrupt() };
    }
    if object.get("kind").and_then(Value::as_str) == Some("human") {
        let valid = object.len()
            == 2 + usize::from(object.contains_key("onBehalfOf"))
                + usize::from(object.contains_key("relayConfirmed"))
            && bounded_ids(&["humanId"])
            && object
                .get("relayConfirmed")
                .is_none_or(|value| value == &Value::Bool(true))
            && principal_ok;
        return if valid { value } else { corrupt() };
    }
    let kind_ok = object.get("kind").and_then(Value::as_str) == Some("agent");
    let agent_id = object
        .get("agentId")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty());
    let run_ok = match object.get("agentRunId") {
        None => true,
        Some(Value::String(v)) => !v.is_empty(),
        Some(_) => false,
    };
    let name_ok = !object.contains_key("agentName") || snapshot_text("agentName");
    match agent_id {
        Some(agent_id) if kind_ok && principal_ok && run_ok && name_ok => json!(AgentAuthorWire {
            kind: "agent",
            agent_id,
            agent_name: object.get("agentName").and_then(Value::as_str),
            on_behalf_of: object.get("onBehalfOf").and_then(Value::as_str),
            agent_run_id: object.get("agentRunId").and_then(Value::as_str),
            // Named only past 0; a depth an older build stored unchecked reads as none.
            depth: dohc_engine_domain::agent_author_depth(object.get("depth")),
        }),
        _ => corrupt(),
    }
}

/// An agent author, rebuilt from its checked fields so nothing else it stored
/// rides along.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentAuthorWire<'a> {
    kind: &'static str,
    agent_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    on_behalf_of: Option<&'a str>,
    // The contract field is OPTIONAL (`agentRunId?: string`), never
    // nullable — omit it when absent, exactly as pickMomentAuthor does.
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_run_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    depth: Option<u32>,
}

impl EngineService {
    pub(super) async fn history_rewrite_links(
        &self,
        ctx: &RequestContext,
        request: dohc_engine_protocol::wire::Request,
    ) -> Result<Value, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            operation_id: String,
            author: Option<Value>,
        }
        let params: Params = parse(request.params)?;
        let handle = request.workspace.as_ref();
        let open = self.open(handle)?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "history.rewriteLinks needs the workspace's owning handle",
            ));
        }
        let request_key = crate::rpc::request::required_idempotency_key(request.idempotency_key)?;
        let author = crate::rpc::request::validated_author(params.author.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let result = Self::read_under_ctx(
            &cancellation,
            "history.rewriteLinks",
            open.actor.history_rewrite_links(
                open.workspace_id.clone(),
                params.operation_id,
                request_key,
                author,
                open.root.clone(),
                self.leases.scoped(&open.root),
                [open.capture_apply_gate.clone(), open.session_ops.clone()],
                std::sync::Arc::new(dohc_engine_runtime::NoFaults),
                (
                    self.version_fence()
                        .link_document_is_open(handle.ok_or_else(workspace_unavailable)?),
                    self.version_fence()
                        .link_document_resync(handle.ok_or_else(workspace_unavailable)?),
                ),
                std::sync::Arc::new(self.self_writes.scoped(&open.root)),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(result)
    }

    pub(super) async fn moments_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: MomentsListParams = parse(params)?;
        // The filter rejects only what the write path can never store
        // (the empty string): every id versionedText.list or
        // moments.list can return — whitespace/control-carrying
        // included — must stay filterable verbatim.
        if params.object_id.as_deref() == Some("") {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "objectId must not be empty",
            ));
        }
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "moments.list",
            open.actor
                .list_moments(dohc_engine_domain::ListMomentsQuery {
                    workspace_id: open.workspace_id.clone(),
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
        Ok(encode_moment_page(&page)?.into_json())
    }

    pub(super) async fn history_operation(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            operation_id: String,
        }
        let params: Params = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let result = Self::read_under_ctx(
            &cancellation,
            "history.operations",
            open.actor
                .history_operation(open.workspace_id.clone(), params.operation_id),
        )
        .await?;
        Ok(
            json!({"operationId":result.operation_id,"versionId":result.version_id,"momentCount":result.moments.len(),"kind":result.kind}),
        )
    }

    pub(super) async fn history_page(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: HistoryPageParams = parse(params)?;
        if params.object_id.as_deref() == Some("") {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "objectId must not be empty",
            ));
        }
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;

        if open.capture_enabled {
            let capture_stopped = || {
                lock(&open.capture)
                    .as_ref()
                    .is_some_and(|driver| driver.is_finished())
            };
            let mut flush = self
                .capture_flush_once(ctx, &open, "history.page capture flush", None)
                .await?;
            for _ in 0..HISTORY_PAGE_FLUSH_RETRIES {
                if flush.settled || capture_stopped() {
                    break;
                }
                let cancellation = OperationCancellation::new(ctx);
                tokio::select! {
                    biased;
                    () = cancellation.token.cancelled() => {
                        return Err(cancellation.interruption("history.page capture flush retry"));
                    }
                    () = tokio::time::sleep(HISTORY_PAGE_FLUSH_RETRY_DELAY) => {}
                }
                flush = self
                    .capture_flush_once(ctx, &open, "history.page capture flush", None)
                    .await?;
            }
            // A stopped task cannot flush. Keep recorded History readable;
            // watcher.status reports that recording has paused.
            if !flush.settled && !capture_stopped() {
                return Err(WireError::new(
                    ErrorCode::Overloaded,
                    "History is still updating. Try again.",
                ));
            }
        }

        let limit = params.limit.unwrap_or(50).clamp(1, 50) as usize;
        let cancellation = OperationCancellation::new(ctx);
        let read = Self::read_under_ctx(
            &cancellation,
            "history.page",
            open.actor.history_page(
                open.workspace_id.clone(),
                params.version_id,
                params.object_id,
                params.operation_id,
                limit,
                params.cursor,
            ),
        )
        .await?;
        encode_history_page(read, limit)
    }

    pub(super) async fn moments_get(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: MomentsGetParams = parse(params)?;
        // Reject only what the write path can never store (the empty
        // string): all-whitespace ids are storable and moments.list
        // returns them verbatim — they must stay fetchable verbatim.
        if params.moment_id.is_empty() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "momentId must not be empty",
            ));
        }
        let moment_id = params.moment_id;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let moment = Self::read_under_ctx(
            &cancellation,
            "moments.get",
            open.actor.get_moment(open.workspace_id.clone(), moment_id),
        )
        .await?;
        Ok(match moment {
            None => Value::Null,
            Some(moment) => moment_json(&moment),
        })
    }

    pub(super) async fn publication_applied(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: PublicationAppliedParams = parse(params)?;
        if params.request_id.is_empty() || params.moment_id.is_empty() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "requestId and momentId must not be empty",
            ));
        }
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let applied = Self::read_under_ctx(
            &cancellation,
            "versionedText.publicationApplied",
            open.actor.publication_applied(
                open.workspace_id.clone(),
                params.request_id,
                params.moment_id,
            ),
        )
        .await?;
        Ok(json!(applied))
    }
}

#[cfg(test)]
mod moment_projection_tests {
    use super::*;
    use dohc_engine_domain::MomentOp;

    const CAP: i64 = MAX_DESKTOP_CAPTURE_TEXT_BYTES as i64;

    fn moment(after_text: Option<&str>, after_byte_length: Option<i64>) -> MomentRecord {
        MomentRecord {
            moment_order: 3,
            moment_id: "moment".to_owned(),
            version_id: "main".to_owned(),
            object_id: "object".to_owned(),
            path: "notes/a.md".to_owned(),
            recorded_at_ms: 9,
            operation: MomentOp::Write,
            after_content_kind: "text".to_owned(),
            after_blob_sha256: Some("after-digest".to_owned()),
            after_binary_sha256: None,
            before_present: true,
            before_blob_sha256: None,
            before_content_kind: "binary".to_owned(),
            before_binary_sha256: Some("before-digest".to_owned()),
            before_latest_moment_id: Some("earlier".to_owned()),
            metadata_origin: "api".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: Some("correlation".to_owned()),
            author_json: Some(
                json!([{"kind":"agent", "agentId":"agent", "depth":0, "model":"m"}]).to_string(),
            ),
            sync_record_only: false,
            after_text: after_text.map(str::to_owned),
            after_byte_length,
            before_text: None,
            before_byte_length: Some(CAP + 1),
            before_path: Some("notes/old.md".to_owned()),
        }
    }

    #[test]
    fn a_moment_carries_every_field_and_both_limits() {
        assert_eq!(
            moment_json(&moment(Some("body"), Some(4))),
            json!({
                "momentOrder": 3,
                "momentId": "moment",
                "versionId": "main",
                "objectId": "object",
                "path": "notes/a.md",
                "recordedAtMs": 9,
                "operation": "write",
                "afterContentKind": "text",
                "afterBlobSha256": "after-digest",
                "afterBinarySha256": null,
                "beforePresent": true,
                "beforeContentKind": "binary",
                "beforeBlobSha256": null,
                "beforeBinarySha256": "before-digest",
                "beforeLatestMomentId": "earlier",
                "metadataOrigin": "api",
                "metadataSummary": null,
                "metadataCorrelationId": "correlation",
                "authors": [{"kind":"agent", "agentId":"agent"}],
                "syncRecordOnly": false,
                "afterText": "body",
                "afterByteLength": 4,
                "afterInbandLimitBytes": null,
                // A binary preimage never names the text limit, whatever its length.
                "beforeText": null,
                "beforeByteLength": CAP + 1,
                "beforeInbandLimitBytes": null,
                "beforePath": "notes/old.md",
            })
        );
    }

    #[test]
    fn a_moment_names_the_limit_only_for_an_unhydrated_text_body_past_the_cap() {
        let at_cap = "a".repeat(MAX_DESKTOP_CAPTURE_TEXT_BYTES);
        let past_cap = "a".repeat(MAX_DESKTOP_CAPTURE_TEXT_BYTES + 1);
        let limit = json!(MAX_DESKTOP_CAPTURE_TEXT_BYTES);
        // (stored body, stored length) -> (capped, withheld) as (afterText, afterInbandLimitBytes).
        let cases = [
            (
                Some(at_cap.as_str()),
                Some(CAP),
                (json!(at_cap), Value::Null),
                (Value::Null, limit.clone()),
            ),
            // A hydrated body past the cap goes out null, and names no limit.
            (
                Some(past_cap.as_str()),
                Some(CAP + 1),
                (Value::Null, Value::Null),
                (Value::Null, Value::Null),
            ),
            (
                None,
                Some(CAP),
                (Value::Null, Value::Null),
                (Value::Null, Value::Null),
            ),
            (
                None,
                Some(CAP + 1),
                (Value::Null, limit.clone()),
                (Value::Null, limit.clone()),
            ),
            // A negative stored length reads as past the cap, as it always has.
            (
                None,
                Some(-1),
                (Value::Null, limit.clone()),
                (Value::Null, limit.clone()),
            ),
            (
                None,
                None,
                (Value::Null, Value::Null),
                (Value::Null, Value::Null),
            ),
        ];
        for (text, byte_length, capped, withheld) in cases {
            let record = moment(text, byte_length);
            for (projected, expected) in [
                (moment_json(&record), capped),
                (withheld_moment_json(&record), withheld),
            ] {
                assert_eq!(
                    (
                        projected["afterText"].clone(),
                        projected["afterInbandLimitBytes"].clone()
                    ),
                    expected,
                    "{byte_length:?}"
                );
            }
        }
    }

    #[test]
    fn an_over_budget_first_row_degrades_to_metadata_and_the_cursor_moves_past_it() {
        let mut heavy = moment(Some("body"), Some(4));
        heavy.metadata_summary = Some("s".repeat(MOMENTS_PAGE_BYTE_BUDGET));
        let mut next = moment(Some("next"), Some(4));
        next.moment_order = 2;
        let page = MomentPage {
            moments: vec![heavy.clone(), next],
            next_before_moment_order: None,
            latest_moment_order: Some(3),
        };
        let encoded = encode_moment_page(&page).expect("a degraded row still ships");
        assert_eq!(encoded.included, 1);
        assert_eq!(encoded.next_before_moment_order, Some(3));
        // Both bodies go, the binary preimage's too, and both name the
        // in-band content cap rather than the per-body text cap.
        let mut expected = moment_json(&heavy);
        for (text, limit) in [
            ("afterText", "afterInbandLimitBytes"),
            ("beforeText", "beforeInbandLimitBytes"),
        ] {
            expected[text] = Value::Null;
            expected[limit] = json!(MAX_INBAND_CONTENT_BYTES);
        }
        assert_eq!(encoded.rows[0], expected);

        heavy.metadata_summary = Some("s".repeat(crate::rpc::reads::SINGLE_ROW_HARD_CAP_BYTES));
        let refused = encode_moment_page(&MomentPage {
            moments: vec![heavy],
            next_before_moment_order: None,
            latest_moment_order: Some(3),
        });
        assert!(refused.is_err(), "a row past the hard cap is refused");
    }
}

#[cfg(test)]
mod relay_author_tests {
    use super::parsed_moment_authors;
    use dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES;
    use serde_json::{Value, json};

    /// One stored author, read back as the entry history returns for it.
    fn parsed_moment_author(raw: &str) -> Value {
        let value: Value = serde_json::from_str(raw).expect("test author is JSON");
        let authors = parsed_moment_authors(&json!([value]).to_string());
        let [author] = authors.as_array().expect("a list").as_slice() else {
            panic!("one author in, one author out: {authors}");
        };
        author.clone()
    }

    #[test]
    fn keeps_only_a_true_relay_confirmation_marker() {
        let confirmed = json!({"kind":"human","humanId":"reader","relayConfirmed":true});
        assert_eq!(parsed_moment_author(&confirmed.to_string()), confirmed);
        for marker in [json!(false), json!(null), json!("true"), json!(1)] {
            assert_eq!(
                parsed_moment_author(
                    &json!({"kind":"human","humanId":"reader","relayConfirmed":marker}).to_string()
                ),
                json!({"corrupt":true})
            );
        }
    }

    #[test]
    fn reads_live_human_and_agent_snapshot_as_native_moment_authors() {
        let human = json!({"kind":"human", "humanId":"owner", "humanName":"Owner proof"});
        let agent =
            json!({"kind":"agent", "agentId":"hosted-agent", "onBehalfOf":"owner", "depth":0});
        assert_eq!(
            parsed_moment_authors(&json!([human, agent]).to_string()),
            json!([{"kind":"human", "humanId":"owner", "humanName":"Owner proof"}, {"kind":"agent", "agentId":"hosted-agent", "onBehalfOf":"owner"}])
        );
        for name in [json!(null), json!(""), json!("x".repeat(513))] {
            assert_eq!(
                parsed_moment_author(
                    &json!({"kind":"human", "humanId":"owner", "humanName":name}).to_string()
                ),
                json!({"corrupt":true})
            );
        }
    }

    #[test]
    fn reads_every_author_of_a_moment_and_refuses_a_value_that_is_not_a_list() {
        let agent = json!({"kind":"agent", "agentId":"agent"});
        let human = json!({"kind":"human", "humanId":"ada", "onBehalfOf":"ada"});
        assert_eq!(
            parsed_moment_authors(&json!([agent, human, {"kind":"agent"}]).to_string()),
            json!([agent, human, {"corrupt":true}])
        );
        for stored in [agent.to_string(), "[]".to_owned(), "not json".to_owned()] {
            assert_eq!(
                parsed_moment_authors(&stored),
                json!([{"corrupt":true}]),
                "{stored}"
            );
        }
    }

    #[test]
    fn preserves_a_person_author_and_refuses_incomplete_or_mixed_shapes() {
        for author in [
            json!({"kind":"human", "humanId":"ada"}),
            json!({"kind":"human", "humanId":"ada", "onBehalfOf":"ada"}),
        ] {
            assert_eq!(parsed_moment_author(&author.to_string()), author);
        }
        for malformed in [
            json!({"kind":"human"}),
            json!({"kind":"human", "humanId":""}),
            json!({"kind":"human", "humanId":"ada", "onBehalfOf":""}),
            json!({"kind":"human", "humanId":"ada", "agentId":"agent"}),
        ] {
            assert_eq!(
                parsed_moment_author(&malformed.to_string()),
                json!({"corrupt":true})
            );
        }
    }

    /// A hosted agent's live edit settles with the relay-admitted account
    /// holder beside the declared agent, and a link holder's with its public
    /// principal. History reads every field back.
    #[test]
    fn preserves_live_author_snapshots_and_refuses_malformed_ones() {
        let human = json!({"kind":"human", "humanId":"owner", "humanName":"Sam 🐈"});
        let agent = json!({"kind":"agent", "agentId":"writer", "agentName":"Writer", "onBehalfOf":"owner", "depth":1});
        let link = json!({"kind":"link", "publicPrincipalId":"public_1", "label":"Anonymous"});
        assert_eq!(
            parsed_moment_authors(&json!([human, agent, link]).to_string()),
            json!([human, agent, link])
        );
        let longest = "\"".repeat(MAX_AUTHOR_FIELD_BYTES);
        for author in [
            json!({"kind":"human", "humanId":longest, "humanName":longest}),
            json!({"kind":"link", "publicPrincipalId":longest, "label":longest}),
            json!({"kind":"agent", "agentId":"writer", "agentName":longest}),
        ] {
            assert_eq!(parsed_moment_author(&author.to_string()), author);
        }
        let over = format!("{}x", "é".repeat(MAX_AUTHOR_FIELD_BYTES / 2));
        for malformed in [
            json!({"kind":"human", "humanId":"owner", "humanName":""}),
            json!({"kind":"human", "humanId":"", "humanName":"Sam"}),
            json!({"kind":"human", "humanId":"owner", "humanName":over}),
            json!({"kind":"human", "humanId":over, "humanName":"Sam"}),
            json!({"kind":"human", "humanId":"owner", "humanName":"Sam\n"}),
            json!({"kind":"human", "humanId":"owner", "humanName":42}),
            json!({"kind":"human", "humanId":"owner", "humanName":"Sam", "onBehalfOf":"owner"}),
            json!({"kind":"link", "publicPrincipalId":"public_1"}),
            json!({"kind":"link", "publicPrincipalId":"public_1", "label":""}),
            json!({"kind":"link", "publicPrincipalId":over, "label":"Anonymous"}),
            json!({"kind":"link", "publicPrincipalId":"public_1", "label":over}),
            json!({"kind":"link", "publicPrincipalId":"public_1", "label":"Anonymous", "grantId":"grant"}),
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2, "principalId":"holder", "publicPrincipalId":"public_1"}),
            json!({"kind":"agent", "agentId":"writer", "agentName":""}),
            json!({"kind":"agent", "agentId":"writer", "agentName":over}),
            json!({"kind":"agent", "agentId":"writer", "agentName":"Writer\u{7f}"}),
            json!({"kind":"agent", "agentId":"writer", "agentName":null}),
        ] {
            assert_eq!(
                parsed_moment_author(&malformed.to_string()),
                json!({"corrupt":true}),
                "{malformed}"
            );
        }
    }

    #[test]
    fn preserves_declared_authors_without_inventing_a_principal() {
        for author in [
            json!({"kind":"agent", "agentId":"agent"}),
            json!({"kind":"agent", "agentId":"agent", "agentRunId":"run", "depth":3}),
            json!({"kind":"automation", "automationId":"collection:tasks#stamp", "depth":4}),
        ] {
            assert_eq!(parsed_moment_author(&author.to_string()), author);
            for principal in [json!(null), json!(""), json!(42)] {
                let mut malformed = author.clone();
                malformed["onBehalfOf"] = principal;
                assert_eq!(
                    parsed_moment_author(&malformed.to_string()),
                    json!({"corrupt":true})
                );
            }
        }
        for malformed in [
            json!({"kind":"agent"}),
            json!({"kind":"automation", "automationId":"collection:tasks#stamp"}),
            json!({"kind":"automation", "depth":4}),
            json!({"kind":"automation", "automationId":"a", "depth":65}),
            json!({"kind":"automation", "automationId":"a", "depth":4, "extra":true}),
        ] {
            assert_eq!(
                parsed_moment_author(&malformed.to_string()),
                json!({"corrupt":true})
            );
        }
    }

    /// An older build stored an agent author with any depth it was given, 0
    /// included. After an upgrade, history reads such a depth as none, as it
    /// reads a run a person started.
    #[test]
    fn reads_a_stored_agent_depth_outside_the_chain_as_none() {
        let named =
            json!({"kind":"agent", "agentId":"agent", "onBehalfOf":"local", "agentRunId":"run"});
        for depth in [json!(0), json!(65), json!("3"), json!(null)] {
            let mut stored = named.clone();
            stored["depth"] = depth;
            assert_eq!(parsed_moment_author(&stored.to_string()), named, "{stored}");
        }
    }

    #[test]
    fn rebuilds_an_agent_author_from_its_checked_fields_only() {
        let stored = json!({
            "kind": "agent",
            "agentId": "agent",
            "onBehalfOf": "local",
            "agentRunId": "run",
            "depth": 2,
            "model": "unlisted",
        });
        assert_eq!(
            parsed_moment_author(&stored.to_string()),
            json!({"kind":"agent", "agentId":"agent", "onBehalfOf":"local", "agentRunId":"run", "depth":2})
        );
        for run in [json!(null), json!(""), json!(7)] {
            let mut malformed = stored.clone();
            malformed["agentRunId"] = run;
            assert_eq!(
                parsed_moment_author(&malformed.to_string()),
                json!({"corrupt":true}),
                "{malformed}"
            );
        }
    }

    #[test]
    fn preserves_public_author_and_refuses_incomplete_or_mixed_shapes() {
        let author = json!({"kind":"public", "principalId":"holder", "grantId":"grant"});
        assert_eq!(parsed_moment_author(&author.to_string()), author);
        let automation = json!({
            "kind": "automation",
            "automationId": "collection:tasks#stamp",
            "onBehalfOf": "local",
            "depth": 1,
        });
        assert_eq!(parsed_moment_author(&automation.to_string()), automation);
        assert_eq!(
            parsed_moment_author(
                &json!({"kind":"automation", "automationId":"a", "onBehalfOf":"local"}).to_string()
            ),
            json!({"corrupt":true}),
            "an automation author names its depth"
        );
        for malformed in [
            json!({"kind":"public", "principalId":"holder"}),
            json!({"kind":"public", "principalId":"", "grantId":"grant"}),
            json!({"kind":"public", "principalId":"holder", "grantId":"grant", "agentId":"agent"}),
        ] {
            assert_eq!(
                parsed_moment_author(&malformed.to_string()),
                json!({"corrupt":true})
            );
        }
    }

    #[test]
    fn preserves_named_author_and_refuses_incomplete_or_mixed_shapes() {
        let author =
            json!({"kind":"named", "userId":"ana", "grantId":"grant", "grantGeneration":2});
        assert_eq!(parsed_moment_author(&author.to_string()), author);
        for malformed in [
            json!({"kind":"named", "userId":"ana", "grantId":"grant"}),
            json!({"kind":"named", "userId":"", "grantId":"grant", "grantGeneration":2}),
            json!({"kind":"named", "userId":"ana", "grantId":"grant", "grantGeneration":0}),
            json!({"kind":"named", "userId":"ana", "grantId":"grant", "grantGeneration":"2"}),
            json!({"kind":"named", "userId":"ana", "grantId":"grant", "grantGeneration":2, "email":"ana@example.com"}),
        ] {
            assert_eq!(
                parsed_moment_author(&malformed.to_string()),
                json!({"corrupt":true})
            );
        }
    }

    #[test]
    fn keeps_shared_author_ids_up_to_the_author_field_bound() {
        // A live share admits identifiers of up to 512 bytes; quotes escape
        // to twice that in the stored JSON.
        let longest = "\"".repeat(MAX_AUTHOR_FIELD_BYTES);
        let named = json!({"kind":"named", "userId":longest, "grantId":longest, "grantGeneration":9_007_199_254_740_991_i64});
        let link = json!({"kind":"link", "grantId":longest, "grantGeneration":9_007_199_254_740_991_i64, "principalId":longest});
        assert_eq!(parsed_moment_author(&named.to_string()), named);
        assert_eq!(parsed_moment_author(&link.to_string()), link);
        // One byte over, from a 2-byte character, is corrupt in every field.
        let over = format!("{}x", "é".repeat(MAX_AUTHOR_FIELD_BYTES / 2));
        assert_eq!(over.len(), MAX_AUTHOR_FIELD_BYTES + 1);
        for (author, field) in [
            (&named, "userId"),
            (&named, "grantId"),
            (&link, "grantId"),
            (&link, "principalId"),
        ] {
            let mut oversized = author.clone();
            oversized[field] = json!(over);
            assert_eq!(
                parsed_moment_author(&oversized.to_string()),
                json!({"corrupt":true}),
                "{field}"
            );
        }
    }

    #[test]
    fn preserves_live_authors_and_refuses_mixed_shapes() {
        for author in [
            json!({"kind":"human", "humanId":"ana", "humanName":"Ana"}),
            json!({"kind":"unattributed"}),
            json!({"kind":"link", "publicPrincipalId":"public-ana", "label":"Ana"}),
        ] {
            assert_eq!(parsed_moment_author(&author.to_string()), author);
            let mut mixed = author.clone();
            mixed["principalId"] = json!("private");
            assert_eq!(
                parsed_moment_author(&mixed.to_string()),
                json!({"corrupt":true})
            );
        }
    }

    #[test]
    fn preserves_link_author_and_refuses_incomplete_or_mixed_shapes() {
        let author =
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2, "principalId":"holder"});
        assert_eq!(parsed_moment_author(&author.to_string()), author);
        for malformed in [
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2}),
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2, "principalId":""}),
            json!({"kind":"link", "grantId":"", "grantGeneration":2, "principalId":"holder"}),
            json!({"kind":"link", "grantId":"grant", "grantGeneration":0, "principalId":"holder"}),
            json!({"kind":"link", "grantId":"grant", "grantGeneration":"2", "principalId":"holder"}),
            // A claimed name never rides a link author, and neither does a user.
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2, "principalId":"holder", "displayName":"Ana"}),
            json!({"kind":"link", "grantId":"grant", "grantGeneration":2, "principalId":"holder", "userId":"ana"}),
            json!({"kind":"link", "userId":"ana", "grantId":"grant", "grantGeneration":2}),
        ] {
            assert_eq!(
                parsed_moment_author(&malformed.to_string()),
                json!({"corrupt":true}),
                "{malformed}"
            );
        }
    }
}

#[cfg(test)]
mod snapshot_confirmation_tests {
    use super::parsed_moment_author;
    use serde_json::json;

    /// The relay confirms an admitted person in either shape. Any other
    /// marker value, extra field, or marker on a link holder reads as corrupt.
    #[test]
    fn reads_confirmed_people_and_refuses_malformed_markers() {
        for author in [
            json!({"kind":"human","humanId":"reader","humanName":"Reader","relayConfirmed":true}),
            json!({"kind":"human","humanId":"reader","humanName":"Reader"}),
            json!({"kind":"human","humanId":"reader","relayConfirmed":true}),
        ] {
            assert_eq!(parsed_moment_author(author.clone()), author);
        }
        for author in [
            json!({"kind":"human","humanId":"reader","humanName":"Reader","relayConfirmed":false}),
            json!({"kind":"human","humanId":"reader","humanName":"Reader","relayConfirmed":"true"}),
            json!({"kind":"human","humanId":"reader","humanName":"Reader","relayConfirmed":null}),
            json!({"kind":"human","humanId":"reader","relayConfirmed":false}),
            json!({"kind":"human","humanId":"reader","humanName":"Re\nader","relayConfirmed":true}),
            json!({"kind":"human","humanId":"reader","humanName":"Reader","relayConfirmed":true,"extra":1}),
            json!({"kind":"link","publicPrincipalId":"public_1","label":"Anonymous","relayConfirmed":true}),
        ] {
            assert_eq!(parsed_moment_author(author), json!({"corrupt": true}));
        }
    }
}

#[cfg(test)]
#[path = "link_publication_tests.rs"]
mod link_publication_tests;
