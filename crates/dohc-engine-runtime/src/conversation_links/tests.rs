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
fn conversation_links_sparse_pages_rename_delete_and_path_reuse() {
    let (_scratch, mut s) = fixture();
    demand(&mut s, "a");
    drain(&mut s);
    alias(&mut s, "visible", "notes/start.md");
    attach(&mut s, "visible", Some("visible"), 1, "t", "m");
    for i in 0..101 {
        attach(
            &mut s,
            &format!("missing-{i:03}"),
            Some(&format!("gone-{i}")),
            100 + i,
            "t",
            "m",
        );
    }
    let first = page(&s, "a", None).unwrap();
    assert!(first["entries"].as_array().unwrap().is_empty());
    let last = page(&s, "a", Some(first["nextCursor"].as_str().unwrap().into())).unwrap();
    assert_eq!(last["entries"].as_array().unwrap().len(), 1);
    exec(
        &mut s,
        "UPDATE path_aliases SET path='moved/end.md' WHERE object_id='visible';",
    );
    let rows = page(&s, "a", Some(first["nextCursor"].as_str().unwrap().into())).unwrap();
    assert_eq!(rows["entries"][0]["file"]["folder"], "moved");
    exec(
        &mut s,
        "DELETE FROM path_aliases WHERE object_id='visible';",
    );
    alias(&mut s, "replacement", "moved/end.md");
    assert!(
        page(&s, "a", Some(first["nextCursor"].as_str().unwrap().into())).unwrap()["entries"]
            .as_array()
            .unwrap()
            .is_empty(),
        "an old object never attaches to its replacement"
    );
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
fn conversation_links_seed_restart_and_legacy_coverage() {
    let (scratch, mut s) = fixture();
    for i in 0..210 {
        attach(&mut s, &format!("id-{i:03}"), Some("f"), i, "t", "m");
    }
    alias(&mut s, "f", "f.md");
    attach(&mut s, "legacy", None, 500, "t", "m");
    demand(&mut s, "a");
    assert!(tick(&mut s).unwrap());
    let after: String = s
        .read_with(|c| {
            c.query_row(
                "SELECT seed_after FROM chat_conversation_file_link_state",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(after, "id-099");
    drop(s);
    let mut s = EngineStore::open(&engine_db_path(&scratch).unwrap(), 2).unwrap();
    attach(&mut s, "behind-cursor", Some("f"), 999, "t", "m");
    drain(&mut s);
    let result = page(&s, "a", None).unwrap();
    assert_eq!(result["entries"].as_array().unwrap().len(), 1);
    assert_eq!(result["entries"][0]["attachmentId"], "behind-cursor");
    assert_eq!(result["complete"], false);
    assert!(!result.to_string().contains("old/reused.md"));
    exec(
        &mut s,
        "DELETE FROM chat_attachments WHERE attachment_id='legacy';",
    );
    drain(&mut s);
    assert_eq!(page(&s, "a", None).unwrap()["complete"], true);
}

#[test]
fn conversation_links_repairs_in_windows_and_restarts_after_an_insert() {
    let (_scratch, mut s) = fixture();
    demand(&mut s, "a");
    drain(&mut s);
    alias(&mut s, "f", "f.md");
    attach(&mut s, "old", Some("f"), 1, "t", "m");
    for i in 0..250 {
        attach(&mut s, &format!("other-{i:03}"), Some("f"), i + 2, "u", "n");
    }
    exec(
        &mut s,
        "DELETE FROM chat_attachments WHERE attachment_id='old';",
    );
    assert!(tick(&mut s).unwrap());
    let remaining: i64 = s
        .read_with(|c| {
            c.query_row(
                "SELECT count(*) FROM chat_conversation_file_link_work",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(remaining, 1, "one slice cannot drain unrelated history");
    attach(&mut s, "new", Some("f"), 999, "t", "m");
    drain(&mut s);
    assert_eq!(entries(&s, "a")[0]["attachmentId"], "new");
}
