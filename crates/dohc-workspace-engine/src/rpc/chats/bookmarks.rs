use crate::EngineService;
use crate::rpc::chats::ChatKeysetCursor;
use crate::rpc::chats::bounded_chat_page_len;
use crate::rpc::chats::chat_cursor_binding;
use crate::rpc::chats::chat_page_cursor;
use crate::rpc::chats::chat_page_limit;
use crate::rpc::chats::decode_chat_cursor;
use crate::rpc::chats::encode_chat_cursor;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::deserialize_optional_non_null;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::request::required_idempotency_key;
use dohc_engine_domain::BookmarkMode;
use dohc_engine_domain::BookmarkTargetKind;
use dohc_engine_domain::ChatBookmark;
use dohc_engine_domain::SaveBookmark;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatBookmarkListParams {
    owner_user_id: String,
    state: Option<String>,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
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
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
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
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    failure_reason: Option<String>,
}

fn parse_bookmark_target_kind(raw: &str) -> Result<BookmarkTargetKind, WireError> {
    match raw {
        "message" => Ok(BookmarkTargetKind::Message),
        "thread" => Ok(BookmarkTargetKind::Thread),
        _ => Err(WireError::new(
            ErrorCode::InvalidParams,
            "unknown bookmark target kind",
        )),
    }
}

fn parse_bookmark_mode(raw: &str) -> Result<BookmarkMode, WireError> {
    match raw {
        "live" => Ok(BookmarkMode::Live),
        "snapshot" => Ok(BookmarkMode::Snapshot),
        _ => Err(WireError::new(
            ErrorCode::InvalidParams,
            "unknown bookmark mode",
        )),
    }
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

impl EngineService {
    pub(crate) async fn chats_bookmarks_save(
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

    pub(crate) async fn chats_bookmarks_find(
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

    pub(crate) async fn chats_bookmarks_list_pending(
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
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid-parameters",
            ));
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
            return Err(WireError::new(ErrorCode::InvalidParams, "invalid-cursor"));
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
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
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

    pub(crate) async fn chats_bookmarks_list(
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

    pub(crate) async fn chats_bookmarks_mark_ready(
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

    pub(crate) async fn chats_bookmarks_archive(
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

    pub(crate) async fn chats_bookmarks_mark_pending(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ChatBookmarkArchiveParams = parse(params)?;
        let request_id = required_idempotency_key(request_id)?;
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

    pub(crate) async fn chats_bookmarks_mark_failed(
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

    pub(crate) async fn chats_bookmarks_mark_stale(
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
}
