use dohc_engine_runtime::{ActorHandle, WorkspaceSupervisor};
use dohc_engine_storage::{EngineStore, NoFaults, StorageError};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::params;
use serde_json::{Value, json};

fn journal(
    rows: &[(String, Value, bool)],
    deleted: &[(&str, &str)],
) -> (ScratchDir, WorkspaceSupervisor, ActorHandle) {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = EngineStore::open(&db, 0).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            for (seq, (kind, payload, imported)) in rows.iter().enumerate() {
                tx.execute(
                    "INSERT INTO replication_log \
                     (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, imported) \
                     VALUES ('ws', 'origin', ?1, ?2, ?3, 1, ?4)",
                    params![seq as i64, kind, payload.to_string(), imported],
                )
                .map_err(StorageError::persist_public)?;
            }
            for (workspace, message) in deleted {
                tx.execute(
                    "INSERT INTO chat_deleted_messages \
                     (workspace_id, message_id, thread_id, deleted_at_ms) \
                     VALUES (?1, ?2, 'thread', 2)",
                    params![workspace, message],
                )
                .map_err(StorageError::persist_public)?;
            }
            Ok::<_, StorageError>(())
        })
        .unwrap();
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    (scratch, supervisor, actor)
}

fn message(id: &str, body: &str, parent: Option<&str>) -> Value {
    json!({
        "workspaceId": "ws", "threadId": "thread", "messageId": id,
        "authorKind": "human", "authorDisplayName": "Ada", "authorUserId": "ada",
        "body": body, "parentMessageId": parent, "createdAtMs": 1,
    })
}

#[tokio::test]
async fn rebuild_unsent_omits_deleted_parent_text_from_message_context() {
    let rows = vec![
        (
            "chat.message.append".into(),
            message("deleted", "Deleted parent text", None),
            true,
        ),
        (
            "chat.message.append".into(),
            message("live", "Live parent text", None),
            true,
        ),
        (
            "chat.message.append".into(),
            message("reply-deleted", "Unsent reply", Some("deleted")),
            false,
        ),
        (
            "chat.message.append".into(),
            message("reply-live", "Another reply", Some("live")),
            false,
        ),
    ];
    let (_scratch, _supervisor, actor) = journal(&rows, &[("ws", "deleted"), ("other", "live")]);
    let unsent = actor
        .rebuild_unsent("ws".into(), "share".into())
        .await
        .unwrap();

    assert_eq!(unsent.chat.len(), 2);
    assert_eq!(
        unsent.messages.get("live"),
        Some(&("Ada".into(), "Live parent text".into()))
    );
    assert!(
        !unsent.messages.contains_key("deleted"),
        "recovery exposed a deleted parent's journal text: {:?}",
        unsent.messages
    );
}

#[tokio::test]
async fn rebuild_unsent_omits_deleted_message_ops_after_a_lost_push_ack() {
    let mut rows = Vec::new();
    for id in ["deleted", "live"] {
        rows.extend([
            (
                "chat.message.append".into(),
                message(id, "Message body", None),
                false,
            ),
            (
                "chat.decision.set".into(),
                json!({"threadId": "thread", "messageId": id,
                    "state": "resolved", "chosenOption": "Private choice"}),
                false,
            ),
            (
                "chat.attachment.add".into(),
                json!({"threadId": "thread", "messageId": id,
                    "targetKind": "file", "pathHint": "private.md"}),
                false,
            ),
        ]);
    }
    let (_scratch, _supervisor, actor) = journal(&rows, &[("ws", "deleted"), ("other", "live")]);
    let unsent = actor
        .rebuild_unsent("ws".into(), "share".into())
        .await
        .unwrap();

    let live: Vec<_> = rows[3..]
        .iter()
        .map(|(kind, payload, _)| (kind.clone(), payload.clone()))
        .collect();
    assert_eq!(unsent.chat, live, "deleted journal ops reached recovery");
}
