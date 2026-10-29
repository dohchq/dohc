use crate::EngineService;
use crate::rpc::chats::bounded_chat_page_len;
use crate::rpc::chats::messages::MessageWire;
use crate::rpc::chats::messages::ReactionWire;
use crate::rpc::chats::threads::ThreadB2Wire;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::deserialize_optional_non_null;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use dohc_engine_domain::ChatChannel;
use dohc_engine_domain::ChatFeedItem;
use dohc_engine_domain::ChatFeedReadState;
use dohc_engine_domain::FeedCursorValue;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatFeedMarkSeenParams {
    owner_user_id: String,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    replication_owner_user_id: Option<String>,
    head_cursor: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatFeedListParams {
    owner_user_id: String,
    limit: Option<i64>,
    cursor: Option<String>,
}

/// The feed names a channel by `id`, where channel reads say `channelId`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedChannelWire<'a> {
    id: &'a str,
    workspace_id: &'a str,
    name: &'a str,
    slug: &'a str,
    kind: &'static str,
    #[serde(rename = "type")]
    channel_type: &'static str,
    purpose: &'a str,
    created_at_ms: i64,
    updated_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder_path: Option<&'a str>,
}

impl<'a> From<&'a ChatChannel> for FeedChannelWire<'a> {
    fn from(channel: &'a ChatChannel) -> Self {
        FeedChannelWire {
            id: &channel.channel_id,
            workspace_id: &channel.workspace_id,
            name: &channel.name,
            slug: &channel.slug,
            kind: channel.kind.as_str(),
            channel_type: channel.group.channel_type.as_str(),
            purpose: &channel.group.purpose,
            created_at_ms: channel.created_at_ms,
            updated_at_ms: channel.updated_at_ms,
            folder_path: channel.group.folder_path.as_deref(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedItemWire<'a> {
    message: MessageWire<'a>,
    thread: ThreadB2Wire<'a>,
    reactions: Vec<ReactionWire<'a>>,
    matched_by: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<FeedChannelWire<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_message: Option<MessageWire<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    opening_message: Option<MessageWire<'a>>,
}

impl<'a> From<&'a ChatFeedItem> for FeedItemWire<'a> {
    fn from(item: &'a ChatFeedItem) -> Self {
        FeedItemWire {
            message: MessageWire::from(&item.message),
            thread: ThreadB2Wire::from(&item.thread),
            reactions: item.reactions.iter().map(ReactionWire::from).collect(),
            matched_by: item.matched_by.iter().map(|kind| kind.as_str()).collect(),
            channel: item.channel.as_ref().map(FeedChannelWire::from),
            parent_message: item.parent_message.as_ref().map(MessageWire::from),
            opening_message: item.opening_message.as_ref().map(MessageWire::from),
        }
    }
}

fn feed_read_state_json(state: &ChatFeedReadState) -> Value {
    json!({
        "workspaceId": state.workspace_id,
        "ownerUserId": state.owner_user_id,
        "lastSeenCreatedAtMs": state.last_seen_created_at_ms,
        "lastSeenMessageId": state.last_seen_message_id,
        "updatedAtMs": state.updated_at_ms,
    })
}

impl EngineService {
    pub(crate) async fn chats_feed_mark_seen(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatFeedMarkSeenParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let state = Self::read_under_ctx(
            &cancellation,
            "chats.feed.markSeen",
            open.actor.chat_feed_mark_seen(
                open.workspace_id.clone(),
                params.owner_user_id,
                params.replication_owner_user_id,
                params.head_cursor,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(feed_read_state_json(&state))
    }

    pub(crate) async fn chats_feed_list_personal(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatFeedListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "chats.feed.listPersonal",
            open.actor.chat_feed_list_personal(
                open.workspace_id.clone(),
                params.owner_user_id,
                params.limit,
                params.cursor,
            ),
        )
        .await?;
        let row_values: Vec<Value> = page
            .items
            .iter()
            .map(|item| json!(FeedItemWire::from(item)))
            .collect();
        let included = bounded_chat_page_len(&row_values)?;
        let truncated = included < row_values.len();
        let next_cursor = if truncated {
            page.items[..included].last().map(|item| {
                dohc_engine_domain::encode_feed_cursor(&FeedCursorValue {
                    created_at_ms: item.message.created_at_ms,
                    message_id: item.message.message_id.clone(),
                })
            })
        } else {
            page.next_cursor
        };
        Ok(json!({
            "items": row_values[..included].to_vec(),
            "nextCursor": next_cursor,
            "headCursor": page.head_cursor,
            "readState": page.read_state.as_ref().map(feed_read_state_json),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_domain::ChannelGroup;
    use dohc_engine_domain::ChatActorKind;
    use dohc_engine_domain::ChatChannelKind;
    use dohc_engine_domain::ChatMessage;
    use dohc_engine_domain::ChatThread;
    use dohc_engine_domain::ChatThreadLane;
    use dohc_engine_domain::FollowTargetKind;

    fn item() -> ChatFeedItem {
        ChatFeedItem {
            message: ChatMessage {
                workspace_id: "workspace".to_owned(),
                thread_id: "thread".to_owned(),
                message_id: "message".to_owned(),
                message_order: 1,
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".to_owned(),
                author_owner_display_name: None,
                author_user_id: None,
                author_actor_key: None,
                parent_message_id: None,
                origin: None,
                body: "hello".to_owned(),
                created_at_ms: 10,
                automation: None,
                link_author: None,
                author_agent_id: None,
                attachments: Vec::new(),
            },
            thread: ChatThread {
                workspace_id: "workspace".to_owned(),
                thread_id: "thread".to_owned(),
                title: "Plan".to_owned(),
                created_at_ms: 10,
                updated_at_ms: 10,
                lane: ChatThreadLane::Posts,
                channel_id: None,
                linked_object_id: None,
                linked_path_hint: None,
                linked_at_ms: None,
            },
            channel: None,
            parent_message: None,
            opening_message: None,
            reactions: Vec::new(),
            matched_by: vec![FollowTargetKind::Person, FollowTargetKind::Thread],
        }
    }

    #[test]
    fn feed_item_omits_absent_context_and_names_its_channel_by_id() {
        let bare = json!(FeedItemWire::from(&item()));
        assert_eq!(bare["matchedBy"], json!(["person", "thread"]));
        for absent in ["channel", "parentMessage", "openingMessage"] {
            assert!(bare.get(absent).is_none(), "{absent} is omitted");
        }
        let in_channel = ChatFeedItem {
            channel: Some(ChatChannel {
                workspace_id: "workspace".to_owned(),
                channel_id: "channel".to_owned(),
                name: "General".to_owned(),
                slug: "general".to_owned(),
                kind: ChatChannelKind::Dm,
                group: ChannelGroup::default(),
                created_at_ms: 1,
                updated_at_ms: 2,
                agent_id: None,
            }),
            ..item()
        };
        assert_eq!(
            json!(FeedItemWire::from(&in_channel))["channel"],
            json!({
                "id": "channel",
                "workspaceId": "workspace",
                "name": "General",
                "slug": "general",
                "kind": "dm",
                "type": "posts",
                "purpose": "",
                "createdAtMs": 1,
                "updatedAtMs": 2,
            })
        );
    }
}
