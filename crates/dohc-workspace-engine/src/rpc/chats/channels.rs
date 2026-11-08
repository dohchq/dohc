use crate::EngineService;
use crate::rpc::chats::ChatPageParams;
use crate::rpc::chats::bounded_chat_page_len;
use crate::rpc::chats::chat_cursor_binding;
use crate::rpc::chats::chat_page_cursor;
use crate::rpc::chats::chat_page_limit;
use crate::rpc::chats::decode_chat_cursor;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use dohc_engine_domain::ChannelGroup;
use dohc_engine_domain::ChatChannel;
use dohc_engine_domain::ChatChannelKind;
use dohc_engine_domain::ChatChannelSummary;
use dohc_engine_domain::ChatChannelType;
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
struct ChatChannelCreateParams {
    channel_id: String,
    name: String,
    kind: String,
    #[serde(rename = "type")]
    channel_type: Option<String>,
    purpose: Option<String>,
    folder_path: Option<String>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatChannelEnsureParams {
    channel_id: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatChannelEnsureAgentParams {
    channel_id: String,
    agent_id: String,
    name: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatChannelFindParams {
    slug: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatChannelIdParams {
    channel_id: String,
}

fn parse_channel_kind(raw: &str) -> Result<ChatChannelKind, WireError> {
    match raw {
        "channel" => Ok(ChatChannelKind::Channel),
        "dm" => Ok(ChatChannelKind::Dm),
        "agent" => Ok(ChatChannelKind::Agent),
        _ => Err(WireError::new(
            ErrorCode::InvalidParams,
            "unknown chat channel kind",
        )),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChannelWire<'a> {
    workspace_id: &'a str,
    channel_id: &'a str,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<&'a str>,
}

impl<'a> From<&'a ChatChannel> for ChannelWire<'a> {
    fn from(channel: &'a ChatChannel) -> Self {
        ChannelWire {
            workspace_id: &channel.workspace_id,
            channel_id: &channel.channel_id,
            name: &channel.name,
            slug: &channel.slug,
            kind: channel.kind.as_str(),
            channel_type: channel.group.channel_type.as_str(),
            purpose: &channel.group.purpose,
            created_at_ms: channel.created_at_ms,
            updated_at_ms: channel.updated_at_ms,
            folder_path: channel.group.folder_path.as_deref(),
            agent_id: channel.agent_id.as_deref(),
        }
    }
}

fn channel_json(channel: &ChatChannel) -> Value {
    json!(ChannelWire::from(channel))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelSummaryWire<'a> {
    #[serde(flatten)]
    channel: ChannelWire<'a>,
    thread_count: i64,
    unread_count: i64,
}

fn channel_summary_json(summary: &ChatChannelSummary) -> Value {
    json!(ChannelSummaryWire {
        channel: ChannelWire::from(&summary.channel),
        thread_count: summary.thread_count,
        unread_count: summary.unread_count,
    })
}

impl EngineService {
    pub(crate) async fn chats_channels_create(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatChannelCreateParams = parse(params)?;
        let kind = parse_channel_kind(&params.kind)?;
        let channel_type = match params.channel_type.as_deref() {
            None => ChatChannelType::default(),
            Some(raw) => ChatChannelType::parse(raw).ok_or_else(|| {
                WireError::new(ErrorCode::InvalidParams, "unknown chat channel type")
            })?,
        };
        let group = ChannelGroup {
            channel_type,
            purpose: params.purpose.unwrap_or_default(),
            folder_path: params.folder_path,
        };
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let channel = Self::read_under_ctx(
            &cancellation,
            "chats.channels.create",
            open.actor.chat_channel_create(
                open.workspace_id.clone(),
                params.channel_id,
                params.name,
                kind,
                group,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(channel_json(&channel))
    }

    pub(crate) async fn chats_channels_ensure_general(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatChannelEnsureParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let channel = Self::read_under_ctx(
            &cancellation,
            "chats.channels.ensureGeneral",
            open.actor.chat_channel_ensure_general(
                open.workspace_id.clone(),
                params.channel_id,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(channel_json(&channel))
    }

    pub(crate) async fn chats_channels_ensure_agent(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatChannelEnsureAgentParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let channel = Self::read_under_ctx(
            &cancellation,
            "chats.channels.ensureAgent",
            open.actor.chat_channel_ensure_agent(
                open.workspace_id.clone(),
                params.channel_id,
                params.agent_id,
                params.name,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            ),
        )
        .await?;
        Ok(channel_json(&channel))
    }

    pub(crate) async fn chats_channels_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)? as usize;
        let binding = chat_cursor_binding("chats.channels.list", &workspace_id, &[]);
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let cancellation = OperationCancellation::new(ctx);
        let channels = Self::read_under_ctx(
            &cancellation,
            "chats.channels.list",
            open.actor.chat_channels_list(
                workspace_id,
                cursor
                    .as_ref()
                    .map(|cursor| (cursor.first, cursor.second.clone())),
                page_limit as i64 + 1,
            ),
        )
        .await?;
        let row_values: Vec<Value> = channels.iter().map(channel_summary_json).collect();
        let included = bounded_chat_page_len(&row_values)?.min(page_limit);
        let next_cursor = chat_page_cursor(&channels, included, binding, |channel| {
            (
                channel.channel.created_at_ms,
                channel.channel.channel_id.clone(),
            )
        })?;
        Ok(json!({
            "channels": row_values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    pub(crate) async fn chats_channels_find_by_slug(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatChannelFindParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let channel = Self::read_under_ctx(
            &cancellation,
            "chats.channels.findBySlug",
            open.actor
                .chat_channel_find_by_slug(open.workspace_id.clone(), params.slug),
        )
        .await?;
        Ok(channel.as_ref().map(channel_json).unwrap_or(Value::Null))
    }

    pub(crate) async fn chats_channels_get_wire_id(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatChannelIdParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let wire_id = Self::read_under_ctx(
            &cancellation,
            "chats.channels.getWireId",
            open.actor
                .chat_channel_get_wire_id(open.workspace_id.clone(), params.channel_id),
        )
        .await?;
        Ok(json!({ "wireId": wire_id }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_summary_extends_the_channel_record() {
        let channel = ChatChannel {
            workspace_id: "workspace".to_owned(),
            channel_id: "channel".to_owned(),
            name: "General".to_owned(),
            slug: "general".to_owned(),
            kind: ChatChannelKind::Channel,
            group: ChannelGroup::default(),
            created_at_ms: 10,
            updated_at_ms: 11,
            agent_id: None,
        };
        let summary = ChatChannelSummary {
            channel: channel.clone(),
            thread_count: 2,
            unread_count: 1,
        };
        assert_eq!(
            channel_summary_json(&summary),
            json!({
                "workspaceId": "workspace",
                "channelId": "channel",
                "name": "General",
                "slug": "general",
                "kind": "channel",
                "type": "posts",
                "purpose": "",
                "createdAtMs": 10,
                "updatedAtMs": 11,
                "threadCount": 2,
                "unreadCount": 1,
            })
        );
        let foldered = ChatChannel {
            group: ChannelGroup {
                folder_path: Some("groups/general".to_owned()),
                ..ChannelGroup::default()
            },
            ..channel
        };
        assert_eq!(
            channel_json(&foldered)["folderPath"],
            json!("groups/general")
        );
    }
}
