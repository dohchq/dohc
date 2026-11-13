use super::*;
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn exec(s: &mut EngineStore, statement: &str) {
    s.write_with(&NoFaults, |c| c.execute_batch(statement).map_err(sql))
        .unwrap();
}
fn fixture() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().unwrap();
    let mut s = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
    VersionedTextStore::new(&mut s)
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .unwrap();
    exec(&mut s,"INSERT INTO chat_channels(workspace_id,channel_id,name,slug,kind,created_at_ms,updated_at_ms) VALUES
        ('ws','a','A','a','channel',1,1),('ws','b','B','b','channel',1,1);
        INSERT INTO chat_channel_wire_ids VALUES('ws','wire-a','a'),('ws','wire-b','b');
        INSERT INTO chat_threads(workspace_id,thread_id,title,created_at_ms,updated_at_ms,channel_id) VALUES
        ('ws','t','T',1,1,'a'),('ws','u','U',1,1,'b');
        UPDATE chat_threads SET lane='chat' WHERE thread_id='t';
        INSERT INTO chat_messages(workspace_id,thread_id,message_order,message_id,author_kind,author_display_name,body,created_at_ms) VALUES
        ('ws','t',0,'m','human','Ada','',1),('ws','u',0,'n','agent','Agent','',1);");
    (scratch, s)
}
fn demand(s: &mut EngineStore, ch: &str) {
    s.write_with(&NoFaults, |c| c.execute("INSERT OR IGNORE INTO chat_conversation_file_link_state(workspace_id,channel_id) VALUES('ws',?1)",[ch]).map_err(sql)).unwrap();
}
fn alias(s: &mut EngineStore, object: &str, path: &str) {
    s.write_with(&NoFaults, |c| {
        c.execute(
            "INSERT OR IGNORE INTO file_objects VALUES('ws',?1,1)",
            [object],
        )
        .map_err(sql)?;
        c.execute(
            "INSERT INTO path_aliases VALUES('ws','main',?1,?2)",
            params![path, object],
        )
        .map_err(sql)?;
        Ok::<_, StorageError>(())
    })
    .unwrap();
}
fn attach(
    s: &mut EngineStore,
    id: &str,
    object: Option<&str>,
    time: i64,
    thread: &str,
    message: &str,
) {
    s.write_with(&NoFaults, |c| c.execute("INSERT INTO chat_attachments(workspace_id,attachment_id,thread_id,message_id,target_kind,object_id,path_hint,created_at_ms)
        VALUES('ws',?1,?2,?3,'file',?4,'old/reused.md',?5)",params![id,thread,message,object,time]).map_err(sql)).unwrap();
}
fn drain(s: &mut EngineStore) {
    for _ in 0..100_000 {
        if !tick(s).unwrap() {
            return;
        }
    }
    panic!("projection failed to finish");
}
fn page(s: &EngineStore, ch: &str, cursor: Option<String>) -> Result<Value, RuntimeError> {
    s.read_with(|c| {
        super::page::read(
            c,
            "ws",
            ch,
            &format!("wire-{ch}"),
            "main",
            "scope",
            0,
            cursor,
            &CancellationToken::new(),
        )
    })
}
fn entries(s: &EngineStore, ch: &str) -> Vec<Value> {
    page(s, ch, None).unwrap()["entries"]
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn conversation_links_seed_collapses_heading_mentions_and_excludes_standalone_and_orphans() {
    let (_scratch, mut s) = fixture();
    alias(&mut s, "f", "notes/current.md");
    attach(&mut s, "first", Some("f"), 1, "t", "m");
    attach(&mut s, "heading", Some("f"), 4, "t", "m");
    exec(&mut s,"UPDATE chat_attachments SET heading_text='Part',heading_anchor='part',heading_occurrence=0 WHERE attachment_id='heading';
        INSERT INTO chat_threads(workspace_id,thread_id,title,created_at_ms,updated_at_ms,channel_id,lane) VALUES('ws','posts','Posts',1,1,'a','posts'),('ws','standalone','File',1,1,NULL,'posts');
        INSERT INTO chat_messages(workspace_id,thread_id,message_order,message_id,author_kind,author_display_name,body,created_at_ms) VALUES
        ('ws','posts',0,'new','human','Bea','',5),('ws','standalone',0,'alone','human','Hidden','',7);");
    attach(&mut s, "latest", Some("f"), 5, "posts", "new");
    attach(&mut s, "standalone", Some("f"), 7, "standalone", "alone");
    attach(&mut s, "orphan", Some("f"), 9, "t", "absent");
    let count: i64 = s
        .read_with(|c| {
            c.query_row(
                "SELECT count(*) FROM chat_conversation_file_link_state",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(count, 0, "no projection or history scan before demand");
    demand(&mut s, "a");
    assert_eq!(page(&s, "a", None).unwrap()["indexBuilding"], true);
    drain(&mut s);
    let rows = entries(&s, "a");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["attachmentId"], "latest");
    assert_eq!(rows[0]["author"]["authorDisplayName"], "Bea");
    assert!(rows[0]["author"].get("authorUserId").is_none());
}

#[test]
fn conversation_links_pages_ties_scope_revision_and_byte_budget() {
    let (_scratch, mut s) = fixture();
    demand(&mut s, "a");
    drain(&mut s);
    for i in 0..125 {
        let object = format!("f-{i:03}");
        alias(&mut s, &object, &format!("notes/{object}.md"));
        attach(&mut s, &format!("id-{i:03}"), Some(&object), 10, "t", "m");
    }
    let first = page(&s, "a", None).unwrap();
    assert_eq!(first["entries"].as_array().unwrap().len(), 100);
    assert!(first.to_string().len() <= 64 * 1024);
    assert_eq!(first["entries"][0]["attachmentId"], "id-124");
    let cursor = first["nextCursor"].as_str().unwrap().to_owned();
    let second = page(&s, "a", Some(cursor.clone())).unwrap();
    assert_eq!(second["entries"].as_array().unwrap().len(), 25);
    assert_eq!(second["entries"][0]["attachmentId"], "id-024");
    assert!(second["nextCursor"].is_null());
    for (ws, ch, wire, ver, scope) in [
        ("else", "a", "wire-a", "main", "scope"),
        ("ws", "b", "wire-b", "main", "scope"),
        ("ws", "a", "wire-a", "named", "scope"),
        ("ws", "a", "wire-a", "main", "changed"),
    ] {
        assert!(
            s.read_with(|c| super::page::read(
                c,
                ws,
                ch,
                wire,
                ver,
                scope,
                0,
                Some(cursor.clone()),
                &CancellationToken::new()
            ))
            .is_err()
        );
    }
    assert!(page(&s, "a", Some(format!("{cursor}x"))).is_err());
    attach(&mut s, "unrelated", Some("f-000"), 99, "u", "n");
    assert!(
        page(&s, "a", Some(cursor.clone())).is_ok(),
        "other conversations do not invalidate a cursor"
    );
    attach(&mut s, "changed", Some("f-000"), 99, "t", "m");
    assert!(matches!(
        page(&s, "a", Some(cursor)),
        Err(RuntimeError::ChatConversationLinksChanged)
    ));
}

#[test]
fn conversation_links_removal_move_and_restart_never_expose_stale_winners() {
    let (scratch, mut s) = fixture();
    demand(&mut s, "a");
    demand(&mut s, "b");
    drain(&mut s);
    alias(&mut s, "f", "f.md");
    attach(&mut s, "old", Some("f"), 1, "t", "m");
    exec(
        &mut s,
        "INSERT INTO chat_messages(workspace_id,thread_id,message_order,message_id,author_kind,author_display_name,body,created_at_ms) VALUES('ws','t',1,'new','human','Bea','',2);",
    );
    attach(&mut s, "winner", Some("f"), 2, "t", "new");
    exec(&mut s, "DELETE FROM chat_messages WHERE message_id='new';");
    assert!(entries(&s, "a").is_empty());
    assert_eq!(page(&s, "a", None).unwrap()["indexBuilding"], true);
    assert!(tick(&mut s).unwrap());
    drop(s);
    let mut s = EngineStore::open(&engine_db_path(&scratch).unwrap(), 3).unwrap();
    drain(&mut s);
    assert_eq!(entries(&s, "a")[0]["attachmentId"], "old");
    exec(
        &mut s,
        "UPDATE chat_threads SET channel_id='b' WHERE thread_id='t';",
    );
    assert!(entries(&s, "a").is_empty());
    assert!(entries(&s, "b").is_empty());
    drain(&mut s);
    assert!(entries(&s, "a").is_empty());
    assert_eq!(entries(&s, "b")[0]["attachmentId"], "old");
    exec(
        &mut s,
        "DELETE FROM chat_threads WHERE thread_id='t'; DELETE FROM chat_attachments WHERE attachment_id='old';",
    );
    drain(&mut s);
    assert!(entries(&s, "b").is_empty());
    exec(&mut s, "DELETE FROM chat_channels WHERE channel_id='b';");
    drain(&mut s);
    let count: i64 = s
        .read_with(|c| {
            c.query_row(
                "SELECT count(*) FROM chat_conversation_file_links WHERE channel_id='b'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn conversation_links_local_sync_and_pending_replay_use_the_same_projection() {
    use dohc_engine_domain::{
        ChatActorKind, ChatThreadLane, LinkedChatStore, LocalAttachmentInput, StartChannelThread,
        attachment_id_for,
    };
    use dohc_engine_sync::{ReplicationEnvelope, apply_chat_envelope};
    let (_scratch, mut s) = fixture();
    demand(&mut s, "a");
    drain(&mut s);
    for object in ["local", "sync", "replay"] {
        alias(&mut s, object, &format!("{object}.md"));
    }
    let begin = std::time::Instant::now();
    LinkedChatStore::new(&mut s)
        .start_channel_thread(
            &StartChannelThread {
                automation: None,
                workspace_id: "ws".into(),
                channel_id: "a".into(),
                thread_id: "local-thread".into(),
                message_id: "local-message".into(),
                title: Some("Local".into()),
                lane: ChatThreadLane::Posts,
                own_thread: false,
                author_kind: ChatActorKind::Human,
                author_display_name: "Ada".into(),
                author_owner_display_name: None,
                author_user_id: None,
                origin: None,
                body: "local".into(),
                needs_decision: false,
                options: vec![],
                attachments: vec![LocalAttachmentInput {
                    object_id: "local".into(),
                    path_hint: None,
                    heading_text: None,
                    heading_anchor: None,
                    heading_occurrence: None,
                }],
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: 10,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let local_us = begin.elapsed().as_micros();
    let envelope = |origin: &str, kind: &str, payload: Value| ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".into(),
        origin_id: origin.into(),
        origin_seq: 0,
        op_kind: kind.into(),
        payload,
        recorded_at_ms: 2000,
        relay_seq: Some(0),
    };
    let attachment = |message: &str, object: &str, time: i64| {
        json!({
            "attachmentId":attachment_id_for(message,object,None,None),"threadId":"t","messageId":message,
            "targetKind":"file","objectId":object,"createdAtMs":time
        })
    };
    let sync = envelope(
        "direct-attachment",
        "chat.attachment.add",
        attachment("m", "sync", 20),
    );
    let begin = std::time::Instant::now();
    apply_chat_envelope(&mut s, &sync, &NoFaults).unwrap();
    let sync_us = begin.elapsed().as_micros();
    apply_chat_envelope(&mut s, &sync, &NoFaults).unwrap();
    let replay = envelope(
        "pending-attachment",
        "chat.attachment.add",
        attachment("late", "replay", 30),
    );
    apply_chat_envelope(&mut s, &replay, &NoFaults).unwrap();
    assert!(
        !entries(&s, "a")
            .iter()
            .any(|r| r["file"]["objectId"] == "replay")
    );
    let begin = std::time::Instant::now();
    apply_chat_envelope(&mut s,&envelope("late-message","chat.message.append",json!({
        "messageId":"late","threadId":"t","authorKind":"human","authorDisplayName":"Ada","body":"later","createdAtMs":25
    })),&NoFaults).unwrap();
    let replay_us = begin.elapsed().as_micros();
    println!(
        "NATIVE_INSERT_US local={local_us} sync={sync_us} pendingReplayWithParent={replay_us}"
    );
    drain(&mut s);
    let rows = entries(&s, "a");
    assert_eq!(
        rows.iter()
            .map(|r| r["file"]["objectId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["replay", "sync", "local"]
    );
    assert_eq!(
        rows.iter()
            .map(|r| r["mentionedAtMs"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        [30, 20, 10]
    );
    assert!(
        rows.iter()
            .all(|r| r["author"]["authorDisplayName"] == "Ada")
    );
}

#[path = "measurement_tests.rs"]
mod measurement;

#[test]
fn conversation_links_failed_repair_backs_off_without_releasing_its_barrier_or_stalling_others() {
    let (scratch, mut s) = fixture();
    demand(&mut s, "a");
    demand(&mut s, "b");
    drain(&mut s);
    for (ch, t, m) in [("a", "t", "m"), ("b", "u", "n")] {
        alias(&mut s, ch, &format!("{ch}.md"));
        attach(&mut s, ch, Some(ch), 1, t, m);
    }
    exec(&mut s,"INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key) VALUES
        ('ws','a','file','a'),('ws','a','thread','barrier'),('ws','b','file','b'),('ws','b','thread','barrier');
        UPDATE chat_conversation_file_link_work SET phase=2 WHERE kind='thread';
        CREATE TRIGGER fail_a BEFORE DELETE ON chat_conversation_file_links WHEN OLD.channel_id='a' BEGIN SELECT RAISE(ABORT,'injected repair failure'); END;");
    assert_eq!(tick_at(&mut s, 1000).unwrap(), std::time::Duration::ZERO);
    let retry:(i64,i64)=s.read_with(|c|c.query_row("SELECT failures,retry_at_ms FROM chat_conversation_file_link_work WHERE channel_id='a' AND kind='file'",[],|r|Ok((r.get(0)?,r.get(1)?)))).unwrap();
    assert_eq!(retry, (1, 1250));
    drop(s);
    let mut s = EngineStore::open(&engine_db_path(&scratch).unwrap(), 2).unwrap();
    for _ in 0..2 {
        tick_at(&mut s, 1001).unwrap();
    }
    assert_eq!(entries(&s, "b").len(), 1);
    assert_eq!(page(&s, "b", None).unwrap()["indexBuilding"], false);
    assert!(
        entries(&s, "a").is_empty(),
        "failed conversation retains its barrier"
    );
    assert_eq!(
        tick_at(&mut s, 1001).unwrap(),
        std::time::Duration::from_millis(249)
    );
    exec(&mut s, "DROP TRIGGER fail_a;");
    for _ in 0..3 {
        tick_at(&mut s, 1250).unwrap();
    }
    assert_eq!(entries(&s, "a").len(), 1);
    assert_eq!(page(&s, "a", None).unwrap()["indexBuilding"], false);
}

