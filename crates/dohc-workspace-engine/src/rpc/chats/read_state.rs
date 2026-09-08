use crate::EngineService;
use crate::rpc::chats::ChatKeysetCursor;
use crate::rpc::chats::ChatPageParams;
use crate::rpc::chats::bounded_chat_page_len;
use crate::rpc::chats::chat_cursor_binding;
use crate::rpc::chats::chat_page_limit;
use crate::rpc::chats::decode_chat_cursor;
use crate::rpc::chats::encode_chat_cursor;
use crate::rpc::chats::threads::ChatThreadParams;
use crate::rpc::chats::threads::thread_b2_json;
use crate::rpc::error::wire;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::deserialize_optional_non_null_string;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use dohc_engine_domain::ChatAgentReadState;
use dohc_engine_domain::ChatThreadReadState;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;

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
pub(super) struct ChatOwnerParams {
    pub(super) owner_user_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatReadStateMarkParams {
    thread_id: String,
    up_to_sequence: i64,
    expected_revision: Option<i64>,
    now_ms: Option<i64>,
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

impl EngineService {
    pub(crate) async fn chats_read_state_mark_thread_read(
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
                open.workspace_id.clone(),
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

    pub(crate) async fn chats_read_state_get(
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
                .chat_read_state_get(open.workspace_id.clone(), params.thread_id),
        )
        .await?;
        Ok(read_state_json(&state))
    }

    pub(crate) async fn chats_read_state_list_unread_file_threads(
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
                open.workspace_id.clone(),
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

    pub(crate) async fn chats_agent_read_state_list_unread_threads(
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

    pub(crate) async fn chats_agent_read_state_mark_thread_read(
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
                open.workspace_id.clone(),
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
}
