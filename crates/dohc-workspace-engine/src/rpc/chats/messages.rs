use crate::EngineService;
use crate::rpc::capture::reject_capture_origin;
use crate::rpc::chats::ChatKeysetCursor;
use crate::rpc::chats::bounded_chat_page_len;
use crate::rpc::chats::chat_cursor_binding;
use crate::rpc::chats::chat_page_limit;
use crate::rpc::chats::decode_chat_cursor;
use crate::rpc::chats::encode_chat_cursor;
use crate::rpc::chats::stream::with_agent_requests;
use crate::rpc::chats::threads::ChatLocalAttachmentParams;
use crate::rpc::chats::threads::ChatThreadPageParams;
use crate::rpc::request::MAX_METADATA_FIELD_BYTES;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::deserialize_optional_non_null;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::request::required_idempotency_key;
use dohc_engine_domain::ChatActorKind;
use dohc_engine_domain::ChatAttachment;
use dohc_engine_domain::ChatDecision;
use dohc_engine_domain::ChatMention;
use dohc_engine_domain::ChatMessage;
use dohc_engine_domain::ChatMessageAutomation;
use dohc_engine_domain::ChatMessageLinkAuthor;
use dohc_engine_domain::ChatReaction;
use dohc_engine_domain::ChatReactionState;
use dohc_engine_domain::LocalAttachmentInput;
use dohc_engine_domain::MentionCursor;
use dohc_engine_domain::ResolveDecision;
use dohc_engine_domain::SendMessage;
use dohc_engine_domain::SetReaction;
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
struct ChatMessageSendParams {
    thread_id: String,
    message_id: String,
    author_kind: String,
    author_display_name: String,
    author_owner_display_name: Option<String>,
    author_user_id: Option<String>,
    author_actor_key: Option<String>,
    parent_message_id: Option<String>,
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
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    author_agent_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    named_agent_ids: Option<Vec<String>>,
    now_ms: Option<i64>,
}

/// The automation executor names the automation that writes a message.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChatMessageAutomationParams {
    automation_id: String,
    chain_depth: u32,
}

impl From<ChatMessageAutomationParams> for ChatMessageAutomation {
    fn from(value: ChatMessageAutomationParams) -> Self {
        ChatMessageAutomation {
            automation_id: value.automation_id,
            chain_depth: value.chain_depth,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatDecisionResolveParams {
    thread_id: String,
    message_id: String,
    resolved_by_message_id: String,
    chosen_option: Option<String>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatReactionAuthorParams {
    author_id: String,
    kind: String,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatReactionSetParams {
    thread_id: String,
    message_id: String,
    emoji: String,
    author: ChatReactionAuthorParams,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    replication_author_id: Option<String>,
    state: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatMessageGetParams {
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatMessagesListParams {
    thread_id: String,
    limit: Option<i64>,
    after_message_order: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAttachmentsListForThreadParams {
    thread_id: String,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAttachmentsListFileMentionsParams {
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    subject: Option<Value>,
    scope: String,
    shared_channel_rows_uncovered: i64,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatMentionsListForHandleParams {
    handle: String,
    #[serde(default)]
    unread_by_agent_only: bool,
    page_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    cursor: Option<String>,
}

/// A message author. The domain accepts an automation only with its automation.
/// Only the relay writes a link message, so no caller here names one.
pub(super) fn parse_actor_kind(raw: &str) -> Result<ChatActorKind, WireError> {
    match raw {
        "human" => Ok(ChatActorKind::Human),
        "agent" => Ok(ChatActorKind::Agent),
        "automation" => Ok(ChatActorKind::Automation),
        "link" => Err(WireError::new(
            ErrorCode::InvalidParams,
            "only the relay writes a link message",
        )),
        _ => Err(WireError::new(
            ErrorCode::InvalidParams,
            "unknown chat actor kind",
        )),
    }
}

pub(super) fn validate_actor_key(key: Option<&str>) -> Result<(), WireError> {
    if key.is_some_and(|key| key.len() > MAX_METADATA_FIELD_BYTES) {
        return Err(WireError::new(
            ErrorCode::InvalidParams,
            format!("chat actor key exceeds {MAX_METADATA_FIELD_BYTES} bytes"),
        ));
    }
    Ok(())
}

/// A reaction author. Automations do not react.
fn parse_reactor_kind(raw: &str) -> Result<ChatActorKind, WireError> {
    match parse_actor_kind(raw)? {
        ChatActorKind::Automation => Err(WireError::new(
            ErrorCode::InvalidParams,
            "an automation cannot react",
        )),
        kind => Ok(kind),
    }
}

/// The depth stays in the engine.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AutomationWire<'a> {
    automation_id: &'a str,
}

impl<'a> From<&'a ChatMessageAutomation> for AutomationWire<'a> {
    fn from(automation: &'a ChatMessageAutomation) -> Self {
        AutomationWire {
            automation_id: &automation.automation_id,
        }
    }
}

/// A link author also names its link grant and link principal.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AuthorWire<'a> {
    kind: &'static str,
    display_name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    grant_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    principal_id: Option<&'a str>,
}

impl<'a> AuthorWire<'a> {
    pub(super) fn new(
        kind: ChatActorKind,
        display_name: &'a str,
        link_author: Option<&'a ChatMessageLinkAuthor>,
    ) -> Self {
        AuthorWire {
            kind: kind.as_str(),
            display_name,
            grant_id: link_author.map(|link| link.grant_id.as_str()),
            principal_id: link_author.map(|link| link.principal_id.as_str()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MessageWire<'a> {
    id: &'a str,
    workspace_id: &'a str,
    thread_id: &'a str,
    author: AuthorWire<'a>,
    body: &'a str,
    created_at_ms: i64,
    attachments: Vec<AttachmentWire<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_owner_display_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_user_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_actor_key: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_message_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    automation: Option<AutomationWire<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_agent_id: Option<&'a str>,
}

impl<'a> From<&'a ChatMessage> for MessageWire<'a> {
    fn from(message: &'a ChatMessage) -> Self {
        MessageWire {
            id: &message.message_id,
            workspace_id: &message.workspace_id,
            thread_id: &message.thread_id,
            author: AuthorWire::new(
                message.author_kind,
                &message.author_display_name,
                message.link_author.as_ref(),
            ),
            body: &message.body,
            created_at_ms: message.created_at_ms,
            attachments: message
                .attachments
                .iter()
                .map(AttachmentWire::from)
                .collect(),
            author_owner_display_name: message.author_owner_display_name.as_deref(),
            author_user_id: message.author_user_id.as_deref(),
            author_actor_key: message.author_actor_key.as_deref(),
            parent_message_id: message.parent_message_id.as_deref(),
            origin: message.origin.as_deref(),
            automation: message.automation.as_ref().map(AutomationWire::from),
            author_agent_id: message.author_agent_id.as_deref(),
        }
    }
}

pub(super) fn message_json(message: &ChatMessage) -> Value {
    json!(MessageWire::from(message))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReactionAuthorWire<'a> {
    author_id: &'a str,
    kind: &'static str,
    display_name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReactionWire<'a> {
    reaction_id: &'a str,
    thread_id: &'a str,
    message_id: &'a str,
    emoji: &'a str,
    author: ReactionAuthorWire<'a>,
    state: &'static str,
    at_ms: i64,
}

impl<'a> From<&'a ChatReaction> for ReactionWire<'a> {
    fn from(reaction: &'a ChatReaction) -> Self {
        ReactionWire {
            reaction_id: &reaction.reaction_id,
            thread_id: &reaction.thread_id,
            message_id: &reaction.message_id,
            emoji: &reaction.emoji,
            author: ReactionAuthorWire {
                author_id: &reaction.author_id,
                kind: reaction.author_kind.as_str(),
                display_name: &reaction.author_display_name,
            },
            state: reaction.state.as_str(),
            at_ms: reaction.at_ms,
        }
    }
}

fn reaction_json(reaction: &ChatReaction) -> Value {
    json!(ReactionWire::from(reaction))
}

/// A bare question omits `options`; a poll lists them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DecisionWire<'a> {
    thread_id: &'a str,
    message_id: &'a str,
    state: &'static str,
    at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<&'a [String]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chosen_option: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_by_message_id: Option<&'a str>,
}

fn decision_json(decision: &ChatDecision) -> Value {
    json!(DecisionWire {
        thread_id: &decision.thread_id,
        message_id: &decision.message_id,
        state: decision.state.as_str(),
        at_ms: decision.at_ms,
        options: (!decision.options.is_empty()).then_some(decision.options.as_slice()),
        chosen_option: decision.chosen_option.as_deref(),
        resolved_by_message_id: decision.resolved_by_message_id.as_deref(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentWire<'a> {
    attachment_id: &'a str,
    thread_id: &'a str,
    message_id: &'a str,
    target_kind: &'static str,
    created_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    object_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path_hint: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    heading_text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    heading_anchor: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    heading_occurrence: Option<i64>,
}

impl<'a> From<&'a ChatAttachment> for AttachmentWire<'a> {
    fn from(attachment: &'a ChatAttachment) -> Self {
        AttachmentWire {
            attachment_id: &attachment.attachment_id,
            thread_id: &attachment.thread_id,
            message_id: &attachment.message_id,
            target_kind: "file",
            created_at_ms: attachment.created_at_ms,
            object_id: attachment.object_id.as_deref(),
            path_hint: attachment.path_hint.as_deref(),
            heading_text: attachment.heading_text.as_deref(),
            heading_anchor: attachment.heading_anchor.as_deref(),
            heading_occurrence: attachment.heading_occurrence,
        }
    }
}

fn attachment_json(attachment: &ChatAttachment) -> Value {
    json!(AttachmentWire::from(attachment))
}

fn mention_json(mention: &ChatMention) -> Value {
    json!({
        "threadId": mention.thread_id,
        "messageId": mention.message_id,
        "handle": mention.handle,
        "authorKind": mention.author_kind.as_str(),
        "createdAtMs": mention.created_at_ms,
    })
}

impl EngineService {
    pub(crate) async fn chats_attachments_list_for_thread(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatAttachmentsListForThreadParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding(
            "chats.attachments.listForThread",
            &workspace_id,
            &[&params.thread_id],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.attachments.listForThread",
            open.actor.chat_attachments_list_for_thread(
                workspace_id,
                params.thread_id,
                after,
                page_limit + 1,
            ),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(attachment_json)
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
                consumed: None,
                first: last.created_at_ms,
                second: last.attachment_id.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "attachments": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    pub(crate) async fn chats_attachments_list_file_mentions(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatAttachmentsListFileMentionsParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        if params.scope.is_empty()
            || params.scope.len() > 256
            || params.shared_channel_rows_uncovered < 0
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid mention scope",
            ));
        }
        let cancellation = OperationCancellation::new(ctx);
        Self::read_under_ctx(
            &cancellation,
            "chats.attachments.listFileMentions",
            open.actor.chat_file_mentions_page(
                workspace_id,
                params.subject.map(crate::rpc::files::resolve_target),
                params.scope,
                params.shared_channel_rows_uncovered,
                params.cursor,
                cancellation.token(),
            ),
        )
        .await
    }

    pub(crate) async fn chats_mentions_list_for_handle(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatMentionsListForHandleParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let unread_filter = if params.unread_by_agent_only {
            "unread"
        } else {
            "all"
        };
        let binding = chat_cursor_binding(
            "chats.mentions.listForHandle",
            &workspace_id,
            &[&params.handle, unread_filter],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor.as_ref().map(|cursor| MentionCursor {
            created_at_ms: cursor.first,
            message_id: cursor.second.clone(),
        });
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.mentions.listForHandle",
            open.actor.chat_mentions_list_for_handle(
                workspace_id,
                params.handle,
                params.unread_by_agent_only,
                after,
                page_limit + 1,
            ),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(mention_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = if rows.len() > included {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: None,
                first: last.created_at_ms,
                second: last.message_id.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "mentions": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    pub(crate) async fn chats_messages_send(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ChatMessageSendParams = parse(params)?;
        validate_actor_key(params.author_actor_key.as_deref())?;
        reject_capture_origin(params.origin.as_deref())?;
        let author_kind = parse_actor_kind(&params.author_kind)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let message = Self::read_under_ctx(
            &cancellation,
            "chats.messages.send",
            open.actor.chat_message_send(
                SendMessage {
                    workspace_id: open.workspace_id.clone(),
                    thread_id: params.thread_id,
                    message_id: params.message_id,
                    author_kind,
                    author_display_name: params.author_display_name,
                    author_owner_display_name: params.author_owner_display_name,
                    author_user_id: params.author_user_id,
                    parent_message_id: params.parent_message_id,
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
                    automation: params.automation.map(ChatMessageAutomation::from),
                    author_agent_id: params.author_agent_id,
                    named_agent_ids: params.named_agent_ids.unwrap_or_default(),
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                params.author_actor_key,
                cancellation.token(),
            ),
        )
        .await?;
        Ok(message_json(&message))
    }

    /// One message by id. A Group automation reads the whole message when
    /// its claim carried the body truncated.
    pub(crate) async fn chats_messages_get(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatMessageGetParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let message = Self::read_under_ctx(
            &cancellation,
            "chats.messages.get",
            open.actor
                .chat_message_get(open.workspace_id.clone(), params.message_id),
        )
        .await?;
        Ok(json!({ "message": message_json(&message) }))
    }

    pub(crate) async fn chats_decisions_resolve(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ChatDecisionResolveParams = parse(params)?;
        let request_id = required_idempotency_key(request_id)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let decision = Self::read_under_ctx(
            &cancellation,
            "chats.decisions.resolve",
            open.actor.chat_decision_resolve(
                ResolveDecision {
                    workspace_id: open.workspace_id.clone(),
                    thread_id: params.thread_id,
                    message_id: params.message_id,
                    resolved_by_message_id: params.resolved_by_message_id,
                    chosen_option: params.chosen_option,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                cancellation.token(),
            ),
        )
        .await?;
        Ok(decision_json(&decision))
    }

    pub(crate) async fn chats_decisions_list_for_thread(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding(
            "chats.decisions.listForThread",
            &workspace_id,
            &[&params.thread_id],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.decisions.listForThread",
            open.actor
                .chat_decisions_list(workspace_id, params.thread_id, after, page_limit + 1),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(decision_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = if rows.len() > included {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: None,
                first: last.at_ms,
                second: last.message_id.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "decisions": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    pub(crate) async fn chats_reactions_set(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ChatReactionSetParams = parse(params)?;
        let request_id = required_idempotency_key(request_id)?;
        let state = match params.state.as_str() {
            "added" => ChatReactionState::Added,
            "removed" => ChatReactionState::Removed,
            _ => {
                return Err(WireError::new(
                    ErrorCode::InvalidParams,
                    "invalid-parameters",
                ));
            }
        };
        let author_kind = parse_reactor_kind(&params.author.kind)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let reaction = Self::read_under_ctx(
            &cancellation,
            "chats.reactions.set",
            open.actor.chat_reaction_set(
                SetReaction {
                    workspace_id: open.workspace_id.clone(),
                    thread_id: params.thread_id,
                    message_id: params.message_id,
                    emoji: params.emoji,
                    author_id: params.author.author_id,
                    replication_author_id: params.replication_author_id,
                    author_kind,
                    author_display_name: params.author.display_name,
                    state,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                cancellation.token(),
            ),
        )
        .await?;
        Ok(reaction_json(&reaction))
    }

    pub(crate) async fn chats_reactions_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatThreadPageParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let workspace_id = open.workspace_id.clone();
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding =
            chat_cursor_binding("chats.reactions.list", &workspace_id, &[&params.thread_id]);
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.reactions.list",
            open.actor
                .chat_reactions_list(workspace_id, params.thread_id, after, page_limit + 1),
        )
        .await?;
        let values: Vec<Value> = rows
            .iter()
            .take(page_limit as usize)
            .map(reaction_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let next_cursor = if rows.len() > included {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: None,
                first: last.at_ms,
                second: last.reaction_id.clone(),
                third: None,
            })?)
        } else {
            None
        };
        Ok(json!({
            "reactions": values[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    pub(crate) async fn chats_messages_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ChatMessagesListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "chats.messages.list",
            open.actor.chat_messages_list(
                open.workspace_id.clone(),
                params.thread_id,
                params.limit.unwrap_or(100).min(500),
                params.after_message_order,
            ),
        )
        .await?;
        let row_values: Vec<Value> = page
            .messages
            .iter()
            .map(|message| {
                with_agent_requests(
                    message_json(message),
                    page.agent_requests.get(&message.message_id),
                )
            })
            .collect();
        let included = bounded_chat_page_len(&row_values)?;
        let truncated = included < row_values.len();
        let next_after = if truncated {
            page.messages[..included]
                .last()
                .map(|message| message.message_order)
        } else {
            page.next_after_message_order
        };
        Ok(json!({
            "messages": row_values[..included].to_vec(),
            "nextAfterMessageOrder": next_after,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_domain::ChatDecisionState;

    fn message() -> ChatMessage {
        ChatMessage {
            workspace_id: "workspace".to_owned(),
            thread_id: "thread".to_owned(),
            message_id: "message".to_owned(),
            message_order: 7,
            author_kind: ChatActorKind::Automation,
            author_display_name: "Stamp".to_owned(),
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
        }
    }

    fn attachment() -> ChatAttachment {
        ChatAttachment {
            attachment_id: "attachment".to_owned(),
            thread_id: "thread".to_owned(),
            message_id: "message".to_owned(),
            object_id: None,
            path_hint: None,
            heading_text: None,
            heading_anchor: None,
            heading_occurrence: None,
            created_at_ms: 11,
        }
    }

    #[test]
    fn message_projection_omits_absent_fields_and_keeps_chain_depth_private() {
        assert_eq!(
            message_json(&message()),
            json!({
                "id": "message",
                "workspaceId": "workspace",
                "threadId": "thread",
                "author": { "kind": "automation", "displayName": "Stamp" },
                "body": "hello",
                "createdAtMs": 10,
                "attachments": [],
            })
        );
        let full = ChatMessage {
            author_owner_display_name: Some("Ada".to_owned()),
            author_user_id: Some("user".to_owned()),
            author_actor_key: Some(r#"{"kind":"unknown"}"#.to_owned()),
            parent_message_id: Some("parent".to_owned()),
            origin: Some("desktop".to_owned()),
            automation: Some(ChatMessageAutomation {
                automation_id: "collection:tasks#stamp".to_owned(),
                chain_depth: 3,
            }),
            attachments: vec![attachment()],
            ..message()
        };
        assert_eq!(
            message_json(&full),
            json!({
                "id": "message",
                "workspaceId": "workspace",
                "threadId": "thread",
                "author": { "kind": "automation", "displayName": "Stamp" },
                "body": "hello",
                "createdAtMs": 10,
                "attachments": [{
                    "attachmentId": "attachment",
                    "threadId": "thread",
                    "messageId": "message",
                    "targetKind": "file",
                    "createdAtMs": 11,
                }],
                "authorOwnerDisplayName": "Ada",
                "authorUserId": "user",
                "authorActorKey": r#"{"kind":"unknown"}"#,
                "parentMessageId": "parent",
                "origin": "desktop",
                "automation": { "automationId": "collection:tasks#stamp" },
            })
        );
    }

    #[test]
    fn link_message_projection_names_its_link_and_no_account() {
        let link = ChatMessage {
            author_kind: ChatActorKind::Link,
            author_display_name: "Guest".to_owned(),
            link_author: Some(ChatMessageLinkAuthor {
                grant_id: "grant".to_owned(),
                principal_id: "principal".to_owned(),
            }),
            ..message()
        };
        assert_eq!(
            message_json(&link),
            json!({
                "id": "message",
                "workspaceId": "workspace",
                "threadId": "thread",
                "author": {
                    "kind": "link",
                    "displayName": "Guest",
                    "grantId": "grant",
                    "principalId": "principal",
                },
                "body": "hello",
                "createdAtMs": 10,
                "attachments": [],
            })
        );
    }

    #[test]
    fn local_writers_cannot_name_a_link_author() {
        let refused = parse_actor_kind("link").unwrap_err();
        assert_eq!(refused.code, ErrorCode::InvalidParams);
        assert!(parse_reactor_kind("link").is_err());
        assert_eq!(parse_actor_kind("human").unwrap(), ChatActorKind::Human);
    }

    #[test]
    fn attachment_projection_keeps_present_empty_and_zero_values() {
        let located = ChatAttachment {
            object_id: Some("object".to_owned()),
            path_hint: Some(String::new()),
            heading_text: Some("Plan".to_owned()),
            heading_anchor: Some("plan".to_owned()),
            heading_occurrence: Some(0),
            ..attachment()
        };
        assert_eq!(
            attachment_json(&located),
            json!({
                "attachmentId": "attachment",
                "threadId": "thread",
                "messageId": "message",
                "targetKind": "file",
                "createdAtMs": 11,
                "objectId": "object",
                "pathHint": "",
                "headingText": "Plan",
                "headingAnchor": "plan",
                "headingOccurrence": 0,
            })
        );
    }

    #[test]
    fn decision_projection_omits_options_for_a_bare_question() {
        let open = ChatDecision {
            thread_id: "thread".to_owned(),
            message_id: "message".to_owned(),
            state: ChatDecisionState::Open,
            resolved_by_message_id: None,
            at_ms: 12,
            options: Vec::new(),
            chosen_option: None,
        };
        assert_eq!(
            decision_json(&open),
            json!({ "threadId": "thread", "messageId": "message", "state": "open", "atMs": 12 })
        );
        let resolved = ChatDecision {
            state: ChatDecisionState::Resolved,
            resolved_by_message_id: Some("answer".to_owned()),
            options: vec!["yes".to_owned(), "no".to_owned()],
            chosen_option: Some("no".to_owned()),
            ..open
        };
        assert_eq!(
            decision_json(&resolved),
            json!({
                "threadId": "thread",
                "messageId": "message",
                "state": "resolved",
                "atMs": 12,
                "options": ["yes", "no"],
                "chosenOption": "no",
                "resolvedByMessageId": "answer",
            })
        );
    }

    #[test]
    fn reaction_projection_nests_its_author() {
        let reaction = ChatReaction {
            reaction_id: "reaction".to_owned(),
            thread_id: "thread".to_owned(),
            message_id: "message".to_owned(),
            emoji: "+1".to_owned(),
            author_id: "user".to_owned(),
            author_kind: ChatActorKind::Human,
            author_display_name: "Ada".to_owned(),
            state: ChatReactionState::Removed,
            at_ms: 13,
        };
        assert_eq!(
            reaction_json(&reaction),
            json!({
                "reactionId": "reaction",
                "threadId": "thread",
                "messageId": "message",
                "emoji": "+1",
                "author": { "authorId": "user", "kind": "human", "displayName": "Ada" },
                "state": "removed",
                "atMs": 13,
            })
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationLinksParams {
    channel_wire_id: String,
    scope: String,
    shared_channel_rows_uncovered: i64,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    cursor: Option<String>,
}
impl EngineService {
    pub(crate) async fn chats_conversations_list_links(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let p: ConversationLinksParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        Self::read_under_ctx(
            &cancellation,
            "chats.conversations.listLinks",
            open.actor.conversation_file_links_page(
                open.workspace_id.clone(),
                p.channel_wire_id,
                p.scope,
                p.shared_channel_rows_uncovered,
                p.cursor,
                cancellation.token(),
            ),
        )
        .await
    }
}
