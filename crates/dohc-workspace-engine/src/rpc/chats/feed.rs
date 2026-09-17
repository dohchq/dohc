use crate::EngineService;
use crate::rpc::chats::bounded_chat_page_len;
use crate::rpc::chats::follows::follow_target_kind_json;
use crate::rpc::chats::messages::message_json;
use crate::rpc::chats::messages::reaction_json;
use crate::rpc::chats::threads::thread_b2_json;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::deserialize_optional_non_null;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use dohc_engine_domain::ChatChannel;
use dohc_engine_domain::ChatChannelKind;
use dohc_engine_domain::ChatFeedReadState;
use dohc_engine_domain::FeedCursorValue;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
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

fn feed_channel_json(channel: &ChatChannel) -> Value {
    let mut value = json!({
        "id": channel.channel_id,
        "workspaceId": channel.workspace_id,
        "name": channel.name,
        "slug": channel.slug,
        "kind": match channel.kind {
            ChatChannelKind::Channel => "channel",
            ChatChannelKind::Dm => "dm",
            ChatChannelKind::Agent => "agent",
        },
        "type": channel.group.channel_type.as_str(),
        "purpose": channel.group.purpose,
        "createdAtMs": channel.created_at_ms,
        "updatedAtMs": channel.updated_at_ms,
    });
    if let Some(folder) = &channel.group.folder_path {
        value["folderPath"] = json!(folder);
    }
    value
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
            .map(|item| {
                let mut value = json!({
                    "message": message_json(&item.message),
                    "thread": thread_b2_json(&item.thread),
                    "reactions": item.reactions.iter().map(reaction_json).collect::<Vec<_>>(),
                    "matchedBy": item.matched_by.iter().map(follow_target_kind_json).collect::<Vec<_>>(),
                });
                let object = value.as_object_mut().expect("feed item is an object");
                if let Some(channel) = &item.channel {
                    object.insert("channel".to_owned(), feed_channel_json(channel));
                }
                if let Some(parent_message) = &item.parent_message {
                    object.insert(
                        "parentMessage".to_owned(),
                        message_json(parent_message),
                    );
                }
                if let Some(opening_message) = &item.opening_message {
                    object.insert(
                        "openingMessage".to_owned(),
                        message_json(opening_message),
                    );
                }
                value
            })
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
