use crate::EngineService;
use crate::rpc::capture::reject_capture_origin;
use crate::rpc::chats::ChatKeysetCursor;
use crate::rpc::chats::bounded_chat_page_len;
use crate::rpc::chats::channels::channel_json;
use crate::rpc::chats::chat_cursor_binding;
use crate::rpc::chats::chat_page_limit;
use crate::rpc::chats::decode_chat_cursor;
use crate::rpc::chats::encode_chat_cursor;
use crate::rpc::chats::threads::ChatLocalAttachmentParams;
use crate::rpc::chats::threads::ChatThreadPageParams;
use crate::rpc::chats::threads::thread_b2_json;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::deserialize_optional_non_null;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::request::required_idempotency_key;
use dohc_engine_domain::ChatActorKind;
use dohc_engine_domain::ChatAttachment;
use dohc_engine_domain::ChatDecision;
use dohc_engine_domain::ChatDecisionState;
use dohc_engine_domain::ChatFileMention;
use dohc_engine_domain::ChatMention;
use dohc_engine_domain::ChatMessage;
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
    parent_message_id: Option<String>,
    origin: Option<String>,
    body: String,
    #[serde(default)]
    needs_decision: bool,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    options: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    attachments: Option<Vec<ChatLocalAttachmentParams>>,
    now_ms: Option<i64>,
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
    object_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    path_hint: Option<String>,
    page_limit: Option<i64>,
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

pub(super) fn parse_actor_kind(raw: &str) -> Result<ChatActorKind, WireError> {
    match raw {
        "human" => Ok(ChatActorKind::Human),
        "agent" => Ok(ChatActorKind::Agent),
        _ => Err(WireError::new(
            ErrorCode::InvalidParams,
            "unknown chat actor kind",
        )),
    }
}

pub(super) fn message_json(message: &ChatMessage) -> Value {
    let mut value = json!({
        "id": message.message_id,
        "workspaceId": message.workspace_id,
        "threadId": message.thread_id,
        "author": {
            "kind": match message.author_kind {
                ChatActorKind::Human => "human",
                ChatActorKind::Agent => "agent",
            },
            "displayName": message.author_display_name,
        },
        "body": message.body,
        "createdAtMs": message.created_at_ms,
        "attachments": message.attachments.iter().map(attachment_json).collect::<Vec<_>>(),
    });
    let object = value.as_object_mut().expect("message is an object");
    if let Some(owner_name) = &message.author_owner_display_name {
        object.insert("authorOwnerDisplayName".to_owned(), json!(owner_name));
    }
    if let Some(author_user_id) = &message.author_user_id {
        object.insert("authorUserId".to_owned(), json!(author_user_id));
    }
    if let Some(parent_message_id) = &message.parent_message_id {
        object.insert("parentMessageId".to_owned(), json!(parent_message_id));
    }
    if let Some(origin) = &message.origin {
        object.insert("origin".to_owned(), json!(origin));
    }
    value
}

pub(super) fn reaction_json(reaction: &ChatReaction) -> Value {
    json!({
        "reactionId": reaction.reaction_id,
        "threadId": reaction.thread_id,
        "messageId": reaction.message_id,
        "emoji": reaction.emoji,
        "author": {
            "authorId": reaction.author_id,
            "kind": match reaction.author_kind {
                ChatActorKind::Human => "human",
                ChatActorKind::Agent => "agent",
            },
            "displayName": reaction.author_display_name,
        },
        "state": match reaction.state {
            ChatReactionState::Added => "added",
            ChatReactionState::Removed => "removed",
        },
        "atMs": reaction.at_ms,
    })
}

fn decision_json(decision: &ChatDecision) -> Value {
    let mut value = json!({
        "threadId": decision.thread_id,
        "messageId": decision.message_id,
        "state": match decision.state {
            ChatDecisionState::Open => "open",
            ChatDecisionState::Resolved => "resolved",
        },
        "atMs": decision.at_ms,
    });
    if !decision.options.is_empty() {
        value["options"] = json!(decision.options);
    }
    if let Some(chosen) = &decision.chosen_option {
        value["chosenOption"] = json!(chosen);
    }
    if let Some(resolved_by_message_id) = &decision.resolved_by_message_id {
        value
            .as_object_mut()
            .expect("decision is an object")
            .insert(
                "resolvedByMessageId".to_owned(),
                json!(resolved_by_message_id),
            );
    }
    value
}

fn attachment_json(attachment: &ChatAttachment) -> Value {
    let mut value = json!({
        "attachmentId": attachment.attachment_id,
        "threadId": attachment.thread_id,
        "messageId": attachment.message_id,
        "targetKind": "file",
        "createdAtMs": attachment.created_at_ms,
    });
    let object = value.as_object_mut().expect("attachment is an object");
    if let Some(object_id) = &attachment.object_id {
        object.insert("objectId".to_owned(), json!(object_id));
    }
    if let Some(path_hint) = &attachment.path_hint {
        object.insert("pathHint".to_owned(), json!(path_hint));
    }
    if let Some(heading_text) = &attachment.heading_text {
        object.insert("headingText".to_owned(), json!(heading_text));
    }
    if let Some(heading_anchor) = &attachment.heading_anchor {
        object.insert("headingAnchor".to_owned(), json!(heading_anchor));
    }
    if let Some(heading_occurrence) = attachment.heading_occurrence {
        object.insert("headingOccurrence".to_owned(), json!(heading_occurrence));
    }
    value
}

fn file_mention_json(mention: &ChatFileMention) -> Value {
    let mut value = json!({
        "attachment": attachment_json(&mention.attachment),
        "message": message_json(&mention.message),
        "thread": thread_b2_json(&mention.thread),
    });
    if let Some(channel) = &mention.channel {
        value
            .as_object_mut()
            .expect("file mention is an object")
            .insert("channel".to_owned(), channel_json(channel));
    }
    value
}

fn mention_json(mention: &ChatMention) -> Value {
    json!({
        "threadId": mention.thread_id,
        "messageId": mention.message_id,
        "handle": mention.handle,
        "authorKind": match mention.author_kind {
            ChatActorKind::Human => "human",
            ChatActorKind::Agent => "agent",
        },
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
                consumed: cursor.as_ref().map_or(0, |cursor| cursor.consumed) + included as i64,
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
        let page_limit = chat_page_limit(params.page_limit)?;
        let binding = chat_cursor_binding(
            "chats.attachments.listFileMentions",
            &workspace_id,
            &[
                params.object_id.as_deref().unwrap_or_default(),
                params.path_hint.as_deref().unwrap_or_default(),
            ],
        );
        let cursor = decode_chat_cursor(params.cursor.as_deref(), &binding)?;
        let consumed = cursor.as_ref().map_or(0, |cursor| cursor.consumed);
        if consumed >= dohc_engine_domain::MAX_FILE_MENTION_RESULTS {
            return Ok(json!({ "mentions": [], "nextCursor": Value::Null }));
        }
        let remaining = dohc_engine_domain::MAX_FILE_MENTION_RESULTS - consumed;
        let fetch_limit = (page_limit + 1).min(remaining);
        let after = cursor
            .as_ref()
            .map(|cursor| (cursor.first, cursor.second.clone()));
        let cancellation = OperationCancellation::new(ctx);
        let rows = Self::read_under_ctx(
            &cancellation,
            "chats.attachments.listFileMentions",
            open.actor.chat_attachments_list_file_mentions(
                workspace_id,
                params.object_id,
                params.path_hint,
                after,
                fetch_limit,
            ),
        )
        .await?;
        let logical_page = page_limit.min(remaining) as usize;
        let values: Vec<Value> = rows
            .iter()
            .take(logical_page)
            .map(file_mention_json)
            .collect();
        let included = bounded_chat_page_len(&values)?;
        let has_more = consumed + (included as i64) < dohc_engine_domain::MAX_FILE_MENTION_RESULTS
            && rows.len() > included;
        let next_cursor = if has_more {
            let last = rows
                .get(included.saturating_sub(1))
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
            Some(encode_chat_cursor(&ChatKeysetCursor {
                version: 1,
                binding,
                consumed: consumed + included as i64,
                first: last.attachment.created_at_ms,
                second: last.attachment.attachment_id.clone(),
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
                consumed: cursor.as_ref().map_or(0, |cursor| cursor.consumed) + included as i64,
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
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                cancellation.token(),
            ),
        )
        .await?;
        Ok(message_json(&message))
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
                consumed: cursor.as_ref().map_or(0, |cursor| cursor.consumed) + included as i64,
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
        let author_kind = parse_actor_kind(&params.author.kind)?;
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
                consumed: cursor.as_ref().map_or(0, |cursor| cursor.consumed) + included as i64,
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
        let row_values: Vec<Value> = page.messages.iter().map(message_json).collect();
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
