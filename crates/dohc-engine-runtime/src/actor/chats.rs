use super::ActorHandle;
use crate::error::RuntimeError;
use dohc_engine_domain::{
    AgentRunRecord, AgentUnreadThreadRow, ChannelGroup, ChannelThreadSummary, ChatAgentReadState,
    ChatAttachment, ChatBookmark, ChatBookmarkTransition, ChatChannel, ChatChannelKind,
    ChatChannelSummary, ChatDecision, ChatFeedPage, ChatFeedReadState, ChatFileMention, ChatFollow,
    ChatMention, ChatMessage, ChatMessagePage, ChatProjectionFileAccess, ChatReaction, ChatThread,
    ChatThreadLane, ChatThreadProjection, ChatThreadReadState, CreateFileThread, DispatchClaim,
    DispatchRecovery, LinkedChatStore, MentionCursor, PendingBookmarkRow, ResolveDecision,
    RunRecordLink, SaveBookmark, SendMessage, SetFollow, SetReaction, StartChannelThread,
    ThreadDispatchPause, UnreadFileThread,
};
use dohc_engine_storage::NoFaults;
use tokio_util::sync::CancellationToken;

impl ActorHandle {
    #[allow(clippy::too_many_arguments)]
    pub async fn chat_channel_create(
        &self,
        workspace_id: String,
        channel_id: String,
        name: String,
        kind: ChatChannelKind,
        group: ChannelGroup,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatChannel, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .create_group(
                        &workspace_id,
                        &channel_id,
                        &name,
                        kind,
                        group,
                        now_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_channel_ensure_general(
        &self,
        workspace_id: String,
        channel_id: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatChannel, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .ensure_general_channel(&workspace_id, &channel_id, now_ms, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_channel_ensure_agent(
        &self,
        workspace_id: String,
        channel_id: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatChannel, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .ensure_agent_channel(&workspace_id, &channel_id, now_ms, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_channels_list(
        &self,
        workspace_id: String,
    ) -> Result<Vec<ChatChannelSummary>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_channels(&workspace_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_channel_find_by_slug(
        &self,
        workspace_id: String,
        slug: String,
    ) -> Result<Option<ChatChannel>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .find_channel_by_slug(&workspace_id, &slug)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_channel_get_wire_id(
        &self,
        workspace_id: String,
        channel_id: String,
    ) -> Result<Option<String>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .get_channel_wire_id(&workspace_id, &channel_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_thread_start(
        &self,
        input: StartChannelThread,
        token: CancellationToken,
    ) -> Result<(ChatThread, ChatMessage), RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .start_channel_thread(&input, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_thread_create(
        &self,
        input: CreateFileThread,
        token: CancellationToken,
    ) -> Result<ChatThread, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .create_thread(&input, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_threads_list(
        &self,
        workspace_id: String,
    ) -> Result<Vec<ChatThread>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_threads(&workspace_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_threads_list_for_file(
        &self,
        workspace_id: String,
        object_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatThread>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_threads_for_file(&workspace_id, &object_id, after, limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_threads_list_for_channel(
        &self,
        workspace_id: String,
        channel_id: String,
        lane: ChatThreadLane,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChannelThreadSummary>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_channel_threads_in_lane(&workspace_id, &channel_id, lane, after, limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_thread_find_channel_id(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<Option<String>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .find_thread_channel_id(&workspace_id, &thread_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_thread_get_projection(
        &self,
        workspace_id: String,
        thread_id: String,
        linked_file_access: ChatProjectionFileAccess,
    ) -> Result<ChatThreadProjection, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .get_thread_projection(&workspace_id, &thread_id, linked_file_access)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_attachments_list_for_thread(
        &self,
        workspace_id: String,
        thread_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatAttachment>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_thread_attachments(&workspace_id, &thread_id, after, limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_attachments_list_file_mentions(
        &self,
        workspace_id: String,
        object_id: Option<String>,
        path_hint: Option<String>,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatFileMention>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_file_mentions(
                    &workspace_id,
                    object_id.as_deref(),
                    path_hint.as_deref(),
                    after,
                    limit,
                )
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_mentions_backfill(
        &self,
        workspace_id: String,
        token: CancellationToken,
    ) -> Result<i64, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .backfill_mentions(&workspace_id, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_mentions_list_for_handle(
        &self,
        workspace_id: String,
        handle: String,
        unread_only: bool,
        after: Option<MentionCursor>,
        limit: i64,
    ) -> Result<Vec<ChatMention>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_mentions_for_handle(&workspace_id, &handle, unread_only, after, limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_dispatch_record_eligible_triggers(
        &self,
        workspace_id: String,
        verified_user_id: Option<String>,
        at_ms: i64,
        token: CancellationToken,
    ) -> Result<i64, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .record_eligible_triggers(
                        &workspace_id,
                        verified_user_id.as_deref(),
                        at_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_message_send(
        &self,
        input: SendMessage,
        token: CancellationToken,
    ) -> Result<ChatMessage, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .send_message(&input, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_decision_resolve(
        &self,
        input: ResolveDecision,
        token: CancellationToken,
    ) -> Result<ChatDecision, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .resolve_decision(&input, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_decisions_list(
        &self,
        workspace_id: String,
        thread_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatDecision>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_thread_decisions(&workspace_id, &thread_id, after, limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_reaction_set(
        &self,
        input: SetReaction,
        token: CancellationToken,
    ) -> Result<ChatReaction, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .set_reaction(&input, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_reactions_list(
        &self,
        workspace_id: String,
        thread_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatReaction>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_reactions(&workspace_id, &thread_id, after, limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_messages_list(
        &self,
        workspace_id: String,
        thread_id: String,
        limit: i64,
        after_message_order: Option<i64>,
    ) -> Result<ChatMessagePage, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_messages(&workspace_id, &thread_id, limit, after_message_order)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_thread_revision(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<i64, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .conversation_revision(&workspace_id, &thread_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_read_state_mark_thread_read(
        &self,
        workspace_id: String,
        thread_id: String,
        up_to_sequence: i64,
        expected_revision: Option<i64>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatThreadReadState, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .mark_thread_read(
                        &workspace_id,
                        &thread_id,
                        up_to_sequence,
                        expected_revision,
                        now_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_read_state_get(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<ChatThreadReadState, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .read_state(&workspace_id, &thread_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_read_state_list_unread_file_threads(
        &self,
        workspace_id: String,
        after_thread_id: Option<String>,
        limit: i64,
    ) -> Result<Vec<UnreadFileThread>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_unread_file_threads(&workspace_id, after_thread_id.as_deref(), limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_agent_unread_threads(
        &self,
        workspace_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<AgentUnreadThreadRow>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_agent_unread_threads(&workspace_id, after, limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_agent_mark_thread_read(
        &self,
        workspace_id: String,
        thread_id: String,
        up_to_created_at_ms: i64,
        up_to_message_id: String,
        expected_revision: Option<i64>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatAgentReadState, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .mark_thread_read_by_agent(
                        &workspace_id,
                        &thread_id,
                        up_to_created_at_ms,
                        &up_to_message_id,
                        expected_revision,
                        now_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_follow_set(
        &self,
        input: SetFollow,
        token: CancellationToken,
    ) -> Result<ChatFollow, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .set_follow(&input, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_follows_list(
        &self,
        workspace_id: String,
        owner_user_id: String,
        state: Option<String>,
    ) -> Result<Vec<ChatFollow>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_follows(&workspace_id, &owner_user_id, state.as_deref())
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_follows_ensure_defaults(
        &self,
        workspace_id: String,
        owner_user_id: String,
        token: CancellationToken,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .ensure_default_channel_follows(&workspace_id, &owner_user_id, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_bookmark_find(
        &self,
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
    ) -> Result<Option<ChatBookmark>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .find_bookmark(&workspace_id, &owner_user_id, &bookmark_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_bookmarks_list_pending(
        &self,
        workspace_id: String,
        owner_user_id: String,
        limit: i64,
        after: Option<(i64, String)>,
    ) -> Result<Vec<PendingBookmarkRow>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_pending_bookmarks_page(&workspace_id, &owner_user_id, limit, after)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_feed_mark_seen(
        &self,
        workspace_id: String,
        owner_user_id: String,
        replication_owner_user_id: Option<String>,
        head_cursor: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatFeedReadState, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .mark_feed_seen(
                        &workspace_id,
                        &owner_user_id,
                        replication_owner_user_id.as_deref(),
                        &head_cursor,
                        now_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_feed_list_personal(
        &self,
        workspace_id: String,
        owner_user_id: String,
        limit: Option<i64>,
        cursor: Option<String>,
    ) -> Result<ChatFeedPage, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_personal_feed(&workspace_id, &owner_user_id, limit, cursor.as_deref())
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_bookmark_save(
        &self,
        input: SaveBookmark,
        token: CancellationToken,
    ) -> Result<ChatBookmark, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .save_bookmark(&input, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_bookmarks_list(
        &self,
        workspace_id: String,
        owner_user_id: String,
        state: Option<String>,
    ) -> Result<Vec<ChatBookmark>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_bookmarks(&workspace_id, &owner_user_id, state.as_deref())
                .map_err(RuntimeError::from)
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_bookmark_mark_ready(
        &self,
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        generation: i64,
        projected_at_ms: i64,
        projection_object_id: Option<String>,
        projection_path: Option<String>,
        token: CancellationToken,
    ) -> Result<ChatBookmarkTransition, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .mark_bookmark_ready(
                        &workspace_id,
                        &owner_user_id,
                        &bookmark_id,
                        generation,
                        projected_at_ms,
                        projection_object_id.as_deref(),
                        projection_path.as_deref(),
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_bookmark_archive(
        &self,
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatBookmark, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .archive_bookmark(
                        &workspace_id,
                        &owner_user_id,
                        &bookmark_id,
                        now_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_bookmark_mark_pending(
        &self,
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        request_id: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatBookmark, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .mark_bookmark_pending(
                        &workspace_id,
                        &owner_user_id,
                        &bookmark_id,
                        &request_id,
                        now_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_bookmark_mark_failed(
        &self,
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        generation: i64,
        failure_reason: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatBookmarkTransition, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .mark_bookmark_failed(
                        &workspace_id,
                        &owner_user_id,
                        &bookmark_id,
                        generation,
                        &failure_reason,
                        now_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_bookmark_mark_stale(
        &self,
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        generation: i64,
        failure_reason: Option<String>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatBookmarkTransition, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .mark_bookmark_stale(
                        &workspace_id,
                        &owner_user_id,
                        &bookmark_id,
                        generation,
                        failure_reason.as_deref(),
                        now_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_dispatch_enqueue(
        &self,
        workspace_id: String,
        trigger_message_id: String,
        thread_id: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .enqueue_dispatch(
                        &workspace_id,
                        &trigger_message_id,
                        &thread_id,
                        now_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_dispatch_claim_next_pending(
        &self,
        workspace_id: String,
        run_id: String,
        command: String,
        log_path: Option<String>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<Option<DispatchClaim>, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .claim_next_pending(
                        &workspace_id,
                        &run_id,
                        &command,
                        log_path.as_deref(),
                        now_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_dispatch_list_pending(
        &self,
        workspace_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<dohc_engine_domain::DispatchRecord>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_pending_dispatches(&workspace_id, after, limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_dispatch_open_runs(
        &self,
        workspace_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<DispatchClaim>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_open_dispatch_runs(&workspace_id, after, limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_dispatch_list_run_messages(
        &self,
        workspace_id: String,
        run_id: String,
        after_message_id: Option<String>,
        limit: i64,
    ) -> Result<Vec<String>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_run_messages(&workspace_id, &run_id, after_message_id, limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_dispatch_run_id_for_message(
        &self,
        workspace_id: String,
        message_id: String,
    ) -> Result<Option<String>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .dispatch_run_id_for_message(&workspace_id, &message_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_dispatch_run_records_for_thread(
        &self,
        workspace_id: String,
        thread_id: String,
        run_limit: Option<i64>,
        after: Option<(i64, String, String)>,
        page_limit: i64,
    ) -> Result<Vec<RunRecordLink>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .run_records_for_thread(&workspace_id, &thread_id, run_limit, after, page_limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_dispatch_get_run_record(
        &self,
        workspace_id: String,
        run_id: String,
    ) -> Result<Option<AgentRunRecord>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .get_run_record(&workspace_id, &run_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_dispatch_thread_paused(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .thread_dispatch_paused(&workspace_id, &thread_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_dispatch_get_thread_pause_state(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<Option<ThreadDispatchPause>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .get_thread_dispatch_pause_state(&workspace_id, &thread_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_dispatch_recent_count(
        &self,
        workspace_id: String,
        thread_id: String,
        since_ms: f64,
    ) -> Result<i64, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .recent_dispatch_count(&workspace_id, &thread_id, since_ms)
                .map_err(RuntimeError::from)
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_dispatch_fail_pending_for_thread(
        &self,
        workspace_id: String,
        thread_id: String,
        reason: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<i64, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .fail_pending_for_thread(&workspace_id, &thread_id, &reason, now_ms, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_dispatch_record_run_message(
        &self,
        workspace_id: String,
        message_id: String,
        run_id: String,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .record_run_message(&workspace_id, &message_id, &run_id, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_dispatch_set_thread_paused(
        &self,
        workspace_id: String,
        thread_id: String,
        paused: bool,
        reason: Option<String>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ThreadDispatchPause, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .set_thread_dispatch_paused(
                        &workspace_id,
                        &thread_id,
                        paused,
                        reason.as_deref(),
                        now_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_dispatch_mark_failure_note_posted(
        &self,
        workspace_id: String,
        run_id: String,
        token: CancellationToken,
    ) -> Result<AgentRunRecord, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .mark_failure_note_posted(&workspace_id, &run_id, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_dispatch_requeue_failed_trigger(
        &self,
        workspace_id: String,
        trigger_message_id: String,
        run_id: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .requeue_failed_trigger(
                        &workspace_id,
                        &trigger_message_id,
                        &run_id,
                        now_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_dispatch_list_app_quit_recoveries(
        &self,
        workspace_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<DispatchRecovery>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .list_app_quit_recoveries(&workspace_id, after, limit)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn chat_dispatch_complete(
        &self,
        workspace_id: String,
        run_id: String,
        exit_code: i64,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .complete_dispatch(&workspace_id, &run_id, exit_code, now_ms, &NoFaults)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_dispatch_fail(
        &self,
        workspace_id: String,
        run_id: String,
        reason: String,
        exit_code: Option<i64>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                LinkedChatStore::new(store)
                    .fail_dispatch(
                        &workspace_id,
                        &run_id,
                        &reason,
                        exit_code,
                        now_ms,
                        &NoFaults,
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn chat_dispatch_reclaim_running(
        &self,
        workspace_id: String,
        max_attempts: i64,
        now_ms: i64,
    ) -> Result<Vec<String>, RuntimeError> {
        self.run(move |store, _| {
            LinkedChatStore::new(store)
                .reclaim_running_dispatches(&workspace_id, max_attempts, now_ms, &NoFaults)
                .map_err(RuntimeError::from)
        })
        .await
    }
}
