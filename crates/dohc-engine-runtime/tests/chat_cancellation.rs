use dohc_engine_domain::{
    ChannelGroup, ChatActorKind, ChatChannelKind, ChatThreadLane, CreateFileThread, SendMessage,
    StartChannelThread,
};
use dohc_engine_runtime::{CancellationToken, RuntimeError, WorkspaceSupervisor};
use dohc_engine_testkit::{ScratchDir, engine_db_path};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_core_chat_mutations_leave_channels_threads_messages_and_revision_unchanged() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let workspace_id = "ws-chat-cancellation".to_owned();

    actor
        .chat_channel_create(
            workspace_id.clone(),
            "existing-channel".to_owned(),
            "Project".to_owned(),
            ChatChannelKind::Channel,
            ChannelGroup::default(),
            10,
            CancellationToken::new(),
        )
        .await
        .expect("create prerequisite channel");
    let start = StartChannelThread {
        automation: None,
        workspace_id: workspace_id.clone(),
        channel_id: "existing-channel".to_owned(),
        thread_id: "existing-thread".to_owned(),
        message_id: "opening-message".to_owned(),
        title: Some("Project discussion".to_owned()),
        lane: ChatThreadLane::Posts,
        author_kind: ChatActorKind::Human,
        author_display_name: "Ada".to_owned(),
        author_owner_display_name: None,
        author_user_id: Some("user-ada".to_owned()),
        origin: None,
        body: "Opening message".to_owned(),
        needs_decision: false,
        options: Vec::new(),
        attachments: Vec::new(),
        now_ms: 20,
        request_id: Some("existing-thread-request".to_owned()),
    };
    actor
        .chat_thread_start(start.clone(), CancellationToken::new())
        .await
        .expect("create prerequisite thread and opening message");

    let channels_before = actor
        .chat_channels_list(workspace_id.clone())
        .await
        .expect("channels before cancellation");
    let threads_before = actor
        .chat_threads_list(workspace_id.clone())
        .await
        .expect("threads before cancellation");
    let messages_before = actor
        .chat_messages_list(workspace_id.clone(), start.thread_id.clone(), 100, None)
        .await
        .expect("messages before cancellation");
    let revision_before = actor
        .chat_thread_revision(workspace_id.clone(), start.thread_id.clone())
        .await
        .expect("revision before cancellation");
    assert_eq!(channels_before.len(), 1);
    assert_eq!(threads_before.len(), 1);
    assert_eq!(messages_before.messages.len(), 1);
    assert_eq!(revision_before, 1);

    let cancelled_start = StartChannelThread {
        automation: None,
        thread_id: "cancelled-channel-thread".to_owned(),
        message_id: "cancelled-opening-message".to_owned(),
        request_id: Some("cancelled-start-request".to_owned()),
        now_ms: 30,
        ..start.clone()
    };
    let file_thread = CreateFileThread {
        workspace_id: workspace_id.clone(),
        thread_id: "cancelled-file-thread".to_owned(),
        title: "File discussion".to_owned(),
        linked_object_id: "project-file".to_owned(),
        linked_path_hint: Some("project.md".to_owned()),
        now_ms: 30,
        request_id: "cancelled-create-request".to_owned(),
    };
    let message = SendMessage {
        automation: None,
        workspace_id: workspace_id.clone(),
        thread_id: start.thread_id.clone(),
        message_id: "cancelled-reply".to_owned(),
        author_kind: ChatActorKind::Human,
        author_display_name: "Ada".to_owned(),
        author_owner_display_name: None,
        author_user_id: Some("user-ada".to_owned()),
        parent_message_id: Some(start.message_id.clone()),
        origin: None,
        body: "Reply to the opening message".to_owned(),
        needs_decision: false,
        options: Vec::new(),
        attachments: Vec::new(),
        now_ms: 30,
        request_id: Some("cancelled-send-request".to_owned()),
    };
    let token = CancellationToken::new();
    token.cancel();

    assert!(matches!(
        actor
            .chat_channel_create(
                workspace_id.clone(),
                "cancelled-channel".to_owned(),
                "Cancelled channel".to_owned(),
                ChatChannelKind::Channel,
                ChannelGroup::default(),
                30,
                token.clone(),
            )
            .await,
        Err(RuntimeError::Cancelled)
    ));
    assert!(matches!(
        actor
            .chat_channel_ensure_general(
                workspace_id.clone(),
                "general-channel".to_owned(),
                30,
                token.clone(),
            )
            .await,
        Err(RuntimeError::Cancelled)
    ));
    assert!(matches!(
        actor
            .chat_channel_ensure_agent(
                workspace_id.clone(),
                "agent-channel".to_owned(),
                30,
                token.clone(),
            )
            .await,
        Err(RuntimeError::Cancelled)
    ));
    assert!(matches!(
        actor
            .chat_thread_start(cancelled_start.clone(), token.clone())
            .await,
        Err(RuntimeError::Cancelled)
    ));
    assert!(matches!(
        actor
            .chat_thread_create(file_thread.clone(), token.clone())
            .await,
        Err(RuntimeError::Cancelled)
    ));
    assert!(matches!(
        actor.chat_message_send(message.clone(), token).await,
        Err(RuntimeError::Cancelled)
    ));

    assert_eq!(
        actor
            .chat_channels_list(workspace_id.clone())
            .await
            .expect("channels after cancellation"),
        channels_before
    );
    assert_eq!(
        actor
            .chat_threads_list(workspace_id.clone())
            .await
            .expect("threads after cancellation"),
        threads_before
    );
    assert_eq!(
        actor
            .chat_messages_list(workspace_id.clone(), start.thread_id.clone(), 100, None)
            .await
            .expect("messages after cancellation"),
        messages_before
    );
    assert_eq!(
        actor
            .chat_thread_revision(workspace_id.clone(), start.thread_id.clone())
            .await
            .expect("revision after cancellation"),
        revision_before
    );
    for slug in ["general", "my-agent"] {
        assert_eq!(
            actor
                .chat_channel_find_by_slug(workspace_id.clone(), slug.to_owned())
                .await
                .expect("find well-known channel after cancelled ensure"),
            None
        );
    }

    // The same inputs succeed with live tokens, including their idempotency keys.
    actor
        .chat_channel_create(
            workspace_id.clone(),
            "cancelled-channel".to_owned(),
            "Cancelled channel".to_owned(),
            ChatChannelKind::Channel,
            ChannelGroup::default(),
            30,
            CancellationToken::new(),
        )
        .await
        .expect("channel input is valid");
    actor
        .chat_channel_ensure_general(
            workspace_id.clone(),
            "general-channel".to_owned(),
            30,
            CancellationToken::new(),
        )
        .await
        .expect("general channel input is valid");
    actor
        .chat_channel_ensure_agent(
            workspace_id,
            "agent-channel".to_owned(),
            30,
            CancellationToken::new(),
        )
        .await
        .expect("agent channel input is valid");
    actor
        .chat_thread_start(cancelled_start, CancellationToken::new())
        .await
        .expect("channel thread input is valid");
    actor
        .chat_thread_create(file_thread, CancellationToken::new())
        .await
        .expect("file thread input is valid");
    actor
        .chat_message_send(message, CancellationToken::new())
        .await
        .expect("message input is valid");
    supervisor.close(&db).expect("close actor");
}
