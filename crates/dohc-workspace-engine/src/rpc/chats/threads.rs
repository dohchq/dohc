use crate::EngineService;
use crate::rpc::capture::reject_capture_origin;
use crate::rpc::chats::ChatKeysetCursor;
use crate::rpc::chats::ChatPageParams;
use crate::rpc::chats::bounded_chat_page_len;
use crate::rpc::chats::chat_cursor_binding;
use crate::rpc::chats::chat_page_cursor;
use crate::rpc::chats::chat_page_limit;
use crate::rpc::chats::decode_chat_cursor;
use crate::rpc::chats::encode_chat_cursor;
use crate::rpc::chats::messages::ChatMessageAutomationParams;
use crate::rpc::chats::messages::actor_kind_str;
use crate::rpc::chats::messages::message_json;
use crate::rpc::chats::messages::parse_actor_kind;
use crate::rpc::chats::messages::reaction_json;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::deserialize_optional_non_null;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::request::required_idempotency_key;
use dohc_engine_domain::ChannelThreadSummary;
use dohc_engine_domain::ChatProjectionFileAccess;
use dohc_engine_domain::ChatThread;
use dohc_engine_domain::ChatThreadLane;
use dohc_engine_domain::CreateFileThread;
use dohc_engine_domain::LocalAttachmentInput;
use dohc_engine_domain::StartChannelThread;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatThreadStartParams {
    channel_id: String,
    thread_id: String,
    message_id: String,
    title: Option<String>,
    lane: Option<String>,
    author_kind: String,
    author_display_name: String,
    author_owner_display_name: Option<String>,
    author_user_id: Option<String>,
    origin: Option<String>,
    body: String,
    #[serde(default)]
    needs_decision: bool,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    options: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    attachments: Option<Vec<ChatLocalAttachmentParams>>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    automation: Option<ChatMessageAutomationParams>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChatLocalAttachmentParams {
    pub(crate) object_id: String,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    pub(super) path_hint: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    pub(super) heading_text: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    pub(super) heading_anchor: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    pub(super) heading_occurrence: Option<i64>,
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
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
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
pub(super) struct ChatThreadPageParams {
    pub(crate) thread_id: String,
    pub(super) page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    pub(crate) cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChatThreadParams {
    pub(crate) thread_id: String,
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
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    linked_file_access: Option<ChatProjectionFileAccessParams>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatThreadsListForFileParams {
    object_id: String,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatThreadsListForChannelParams {
    channel_id: String,
    lane: Option<String>,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    cursor: Option<String>,
}

fn thread_json(thread: &ChatThread) -> Value {
    json!({
        "workspaceId": thread.workspace_id,
        "threadId": thread.thread_id,
        "title": thread.title,
        "createdAtMs": thread.created_at_ms,
        "updatedAtMs": thread.updated_at_ms,
        "lane": thread.lane.as_str(),
        "channelId": thread.channel_id,
        "linkedObjectId": thread.linked_object_id,
    })
}

fn parse_thread_lane(raw: Option<&str>) -> Result<ChatThreadLane, WireError> {
    match raw {
        None => Ok(ChatThreadLane::default()),
        Some(raw) => ChatThreadLane::parse(raw)
            .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "unknown chat thread lane")),
    }
}

pub(super) fn thread_b2_json(thread: &ChatThread) -> Value {
    let mut value = json!({
        "id": thread.thread_id,
        "workspaceId": thread.workspace_id,
        "title": thread.title,
        "createdAtMs": thread.created_at_ms,
        "updatedAtMs": thread.updated_at_ms,
        "lane": thread.lane.as_str(),
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
                        "kind": actor_kind_str(opening.author_kind),
                        "displayName": opening.author_display_name,
                    },
                    "createdAtMs": opening.created_at_ms,
                    "bodySnippet": opening.body_snippet,
                    "reactions": opening.reactions.iter().map(reaction_json).collect::<Vec<_>>(),
                }),
            );
    }
    if let Some(author_user_id) = summary
        .opening_message
        .as_ref()
        .and_then(|opening| opening.author_user_id.as_ref())
    {
        value["openingMessage"]["authorUserId"] = json!(author_user_id);
    }
    if let Some(owner_name) = summary
        .opening_message
        .as_ref()
        .and_then(|opening| opening.author_owner_display_name.as_ref())
    {
        value["openingMessage"]["authorOwnerDisplayName"] = json!(owner_name);
    }
    value
}

impl EngineService {
    pub(crate) async fn chats_threads_start(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ChatThreadStartParams = parse(params)?;
        let lane = parse_thread_lane(params.lane.as_deref())?;
        reject_capture_origin(params.origin.as_deref())?;
        let author_kind = parse_actor_kind(&params.author_kind)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let (thread, message) = Self::read_under_ctx(
            &cancellation,
            "chats.threads.start",
            open.actor.chat_thread_start(
                StartChannelThread {
                    workspace_id: open.workspace_id.clone(),
                    channel_id: params.channel_id,
                    thread_id: params.thread_id,
                    message_id: params.message_id,
                    title: params.title,
                    lane,
                    author_kind,
                    author_display_name: params.author_display_name,
                    author_owner_display_name: params.author_owner_display_name,
                    author_user_id: params.author_user_id,
                    origin: params.origin,
                    body: params.body,
                    needs_decision: params.needs_decision,
                    options: params.options.unwrap_or_default(),
                    attachments: params
                        .attachments
                        .unwrap_or_default()
                        .into_iter()
                        .map(LocalAttachmentInput::from)
                        .collect(),
                    automation: params.automation.map(Into::into),
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                cancellation.token(),
            ),
        )
        .await?;
        Ok(json!({ "thread": thread_b2_json(&thread), "message": message_json(&message) }))
    }

    pub(crate) async fn chats_threads_create(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ChatThreadCreateParams = parse(params)?;
        let request_id = required_idempotency_key(request_id)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let thread = Self::read_under_ctx(
            &cancellation,
            "chats.threads.create",
            open.actor.chat_thread_create(
                CreateFileThread {
                    workspace_id: open.workspace_id.clone(),
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

    pub(crate) async fn chats_threads_list(
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

    pub(crate) async fn chats_threads_list_for_file(
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
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
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

    pub(crate) async fn chats_threads_list_for_channel(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadsListForChannelParams = parse(params)?;
        let lane = parse_thread_lane(params.lane.as_deref())?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding(
            "chats.threads.listForChannel",
            &workspace_id,
            &[&params.channel_id, lane.as_str()],
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
                lane,
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
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
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

    pub(crate) async fn chats_threads_find_channel_id(
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
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid-parameters",
            ));
        }
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let channel_id = Self::read_under_ctx(
            &cancellation,
            "chats.threads.findChannelId",
            open.actor
                .chat_thread_find_channel_id(open.workspace_id.clone(), params.thread_id),
        )
        .await?;
        Ok(channel_id.map_or(Value::Null, Value::String))
    }

    pub(crate) async fn chats_threads_revision(
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
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid-parameters",
            ));
        }
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let revision = Self::read_under_ctx(
            &cancellation,
            "chats.threads.revision",
            open.actor
                .chat_thread_revision(open.workspace_id.clone(), params.thread_id),
        )
        .await?;
        Ok(json!({ "revision": revision }))
    }

    pub(crate) async fn chats_threads_get_projection(
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
                open.workspace_id.clone(),
                params.thread_id,
                linked_file_access,
            ),
        )
        .await?;
        if projection.text.len() > dohc_engine_domain::INBAND_CONTENT_CAP_BYTES {
            return Err(WireError::new(
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_chat_fields_distinguish_missing_null_and_present_values() {
        let absent: ChatLocalAttachmentParams =
            serde_json::from_value(json!({"objectId": "object"})).expect("missing optional fields");
        assert!(absent.path_hint.is_none());
        assert!(absent.heading_occurrence.is_none());
        let present: ChatLocalAttachmentParams = serde_json::from_value(
            json!({"objectId": "object", "pathHint": "", "headingOccurrence": 0}),
        )
        .expect("present optional fields");
        assert_eq!(present.path_hint.as_deref(), Some(""));
        assert_eq!(present.heading_occurrence, Some(0));
        for (field, invalid) in [
            ("pathHint", json!(null)),
            ("headingOccurrence", json!(null)),
            ("pathHint", json!(0)),
            ("headingOccurrence", json!("0")),
        ] {
            let mut value = json!({"objectId": "object"});
            value[field] = invalid;
            assert!(
                serde_json::from_value::<ChatLocalAttachmentParams>(value).is_err(),
                "{field} must preserve its non-null type"
            );
        }

        let mut start = json!({"channelId": "channel", "threadId": "thread", "messageId": "message", "authorKind": "human", "authorDisplayName": "Ada", "body": "hello"});
        let absent: ChatThreadStartParams =
            serde_json::from_value(start.clone()).expect("missing attachments");
        assert!(absent.attachments.is_none());
        start["attachments"] = json!([]);
        let empty: ChatThreadStartParams =
            serde_json::from_value(start.clone()).expect("empty attachments");
        assert!(
            empty
                .attachments
                .expect("present empty attachments")
                .is_empty()
        );
        start["attachments"] = json!(null);
        assert!(serde_json::from_value::<ChatThreadStartParams>(start).is_err());

        let absent: ChatThreadProjectionParams =
            serde_json::from_value(json!({"threadId": "thread"})).expect("missing file access");
        assert!(absent.linked_file_access.is_none());
        let denied: ChatThreadProjectionParams = serde_json::from_value(
            json!({"threadId": "thread", "linkedFileAccess": {"kind": "denied"}}),
        )
        .expect("explicit denied access");
        assert!(matches!(
            denied.linked_file_access,
            Some(ChatProjectionFileAccessParams::Denied {})
        ));
        assert!(
            serde_json::from_value::<ChatThreadProjectionParams>(
                json!({"threadId": "thread", "linkedFileAccess": null})
            )
            .is_err()
        );
    }
}
