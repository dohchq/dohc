use crate::EngineService;
use crate::rpc::chats::bounded_chat_page_len;
use crate::rpc::chats::channels::ChannelWire;
use crate::rpc::chats::messages::AuthorWire;
use crate::rpc::chats::messages::MessageWire;
use crate::rpc::chats::messages::ReactionWire;
use crate::rpc::chats::threads::ChatThreadParams;
use crate::rpc::chats::threads::ThreadB2Wire;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::deserialize_optional_non_null;
use crate::rpc::request::parse;
use dohc_engine_domain::ChatActorKind;
use dohc_engine_domain::ChatThreadLane;
use dohc_engine_domain::STREAM_LIMIT_DEFAULT;
use dohc_engine_domain::StreamAgentRequest;
use dohc_engine_domain::StreamItem;
use dohc_engine_domain::StreamPosition;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StreamPositionParams {
    created_at_ms: i64,
    lane: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatStreamListParams {
    channel_id: String,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    before: Option<StreamPositionParams>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    page_limit: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamPositionWire<'a> {
    created_at_ms: i64,
    lane: &'static str,
    id: &'a str,
}

impl<'a> From<&'a StreamPosition> for StreamPositionWire<'a> {
    fn from(position: &'a StreamPosition) -> Self {
        StreamPositionWire {
            created_at_ms: position.created_at_ms,
            lane: position.lane.as_str(),
            id: &position.id,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamReplierWire<'a> {
    author: AuthorWire<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_user_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_agent_id: Option<&'a str>,
    last_reply_at_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamAgentReplyWire<'a> {
    id: &'a str,
    author: AuthorWire<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_owner_display_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_user_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_agent_id: Option<&'a str>,
    created_at_ms: i64,
    body_excerpt: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamPostWire<'a> {
    reply_count: i64,
    repliers: Vec<StreamReplierWire<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_reply_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_agent_reply: Option<StreamAgentReplyWire<'a>>,
    open_decision_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamItemWire<'a> {
    position: StreamPositionWire<'a>,
    message: MessageWire<'a>,
    reactions: Vec<ReactionWire<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    post: Option<StreamPostWire<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequestWire<'a> {
    agent_id: &'a str,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_reason: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    log_path: Option<&'a str>,
}

/// A message's JSON with its open agent requests, when it has any.
pub(super) fn with_agent_requests(
    mut message: Value,
    requests: Option<&Vec<StreamAgentRequest>>,
) -> Value {
    if let (Some(object), Some(requests)) = (message.as_object_mut(), requests)
        && !requests.is_empty()
    {
        let wire: Vec<AgentRequestWire<'_>> = requests
            .iter()
            .map(|request| AgentRequestWire {
                agent_id: &request.agent_id,
                state: request.state.as_str(),
                run_id: request.run_id.as_deref(),
                started_at_ms: request.started_at_ms,
                failure_reason: request.failure_reason.as_deref(),
                exit_code: request.exit_code,
                log_path: request.log_path.as_deref(),
            })
            .collect();
        object.insert("agentRequests".to_owned(), json!(wire));
    }
    message
}

fn stream_item_json(item: &StreamItem) -> Value {
    let mut value = json!(StreamItemWire {
        position: StreamPositionWire::from(&item.position),
        message: MessageWire::from(&item.message),
        reactions: item.reactions.iter().map(ReactionWire::from).collect(),
        post: item.post.as_ref().map(|post| StreamPostWire {
            reply_count: post.reply_count,
            repliers: post
                .repliers
                .iter()
                .map(|replier| StreamReplierWire {
                    author: AuthorWire::new(
                        replier.author_kind,
                        &replier.author_display_name,
                        replier.link_author.as_ref(),
                    ),
                    author_user_id: replier.author_user_id.as_deref(),
                    author_agent_id: replier.author_agent_id.as_deref(),
                    last_reply_at_ms: replier.last_reply_at_ms,
                })
                .collect(),
            last_reply_at_ms: post.last_reply_at_ms,
            latest_agent_reply: post.latest_agent_reply.as_ref().map(|reply| {
                StreamAgentReplyWire {
                    id: &reply.message_id,
                    author: AuthorWire::new(ChatActorKind::Agent, &reply.author_display_name, None),
                    author_owner_display_name: reply.author_owner_display_name.as_deref(),
                    author_user_id: reply.author_user_id.as_deref(),
                    author_agent_id: reply.author_agent_id.as_deref(),
                    created_at_ms: reply.created_at_ms,
                    body_excerpt: &reply.body_excerpt,
                }
            }),
            open_decision_count: post.open_decision_count,
        }),
    });
    if let Some(message) = value.get_mut("message") {
        *message = with_agent_requests(message.take(), Some(&item.agent_requests));
    }
    value
}

impl EngineService {
    pub(crate) async fn chats_stream_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatStreamListParams = parse(params)?;
        let invalid = || WireError::new(ErrorCode::InvalidParams, "invalid-parameters");
        let before = params
            .before
            .map(|before| {
                Ok::<_, WireError>(StreamPosition {
                    created_at_ms: before.created_at_ms,
                    lane: ChatThreadLane::parse(&before.lane).ok_or_else(invalid)?,
                    id: before.id,
                })
            })
            .transpose()?;
        let limit = params.page_limit.unwrap_or(STREAM_LIMIT_DEFAULT);
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "chats.stream.list",
            open.actor.chat_stream_list(
                open.workspace_id.clone(),
                params.channel_id,
                before,
                limit,
            ),
        )
        .await?;
        // The page keeps its newest items when it is over the byte budget, so
        // the reader continues from the oldest item it received.
        let newest_first: Vec<Value> = page.items.iter().rev().map(stream_item_json).collect();
        let included = bounded_chat_page_len(&newest_first)?;
        let first_included = page.items.len() - included;
        let next_before = (page.has_older || first_included > 0)
            .then(|| page.items.get(first_included))
            .flatten()
            .map(|item| json!(StreamPositionWire::from(&item.position)));
        let mut items = newest_first;
        items.truncate(included);
        items.reverse();
        Ok(json!({
            "items": items,
            "nextBefore": next_before,
            "readPosition": page.read_position.as_ref().map(StreamPositionWire::from),
        }))
    }

    pub(crate) async fn chats_threads_get(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let found = Self::read_under_ctx(
            &cancellation,
            "chats.threads.get",
            open.actor
                .chat_thread_get(open.workspace_id.clone(), params.thread_id),
        )
        .await?;
        Ok(json!({
            "thread": ThreadB2Wire::from(&found.thread),
            "channel": found.channel.as_ref().map(ChannelWire::from),
            "messageCount": found.message_count,
        }))
    }
}
