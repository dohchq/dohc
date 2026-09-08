use crate::EngineService;
use crate::rpc::chats::chat_cursor_binding;
use crate::rpc::error::map_runtime;
use crate::rpc::error::wire;
use crate::rpc::reads::byte_budget_cut_serialized;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::workspace::validate_workspace_param;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::NoFaults;
use dohc_engine_runtime::SearchPageDisposition;
use dohc_engine_runtime::SearchResultKey;
use dohc_engine_runtime::SearchSurface;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

const GRANULAR_CHAT_RESPONSE_BYTE_BUDGET: usize = 256 * 1024;

const SEARCH_PAGE_BYTE_BUDGET: usize = 256 * 1024;

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

impl EngineService {
    pub(super) async fn search_query_page(
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

    pub(super) async fn search_query_chat_messages_granular(
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

    pub(super) async fn search_ensure_index(
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
}
