use crate::EngineService;
use crate::rpc::chats::bounded_chat_page_len;
use crate::rpc::chats::chat_cursor_binding;
use crate::rpc::chats::chat_page_cursor;
use crate::rpc::chats::chat_page_limit;
use crate::rpc::chats::decode_chat_cursor;
use crate::rpc::chats::read_state::ChatOwnerParams;
use crate::rpc::error::wire;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::deserialize_optional_non_null_string;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use dohc_engine_domain::ChatFollow;
use dohc_engine_domain::FollowState;
use dohc_engine_domain::FollowTargetKind;
use dohc_engine_domain::SetFollow;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;

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
struct ChatFollowListParams {
    owner_user_id: String,
    state: Option<String>,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    cursor: Option<String>,
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

pub(super) fn follow_target_kind_json(kind: &FollowTargetKind) -> Value {
    json!(match kind {
        FollowTargetKind::Person => "person",
        FollowTargetKind::Agent => "agent",
        FollowTargetKind::Channel => "channel",
        FollowTargetKind::Thread => "thread",
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

impl EngineService {
    pub(crate) async fn chats_follows_set(
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

    pub(crate) async fn chats_follows_list(
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

    pub(crate) async fn chats_follows_ensure_defaults(
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
}
