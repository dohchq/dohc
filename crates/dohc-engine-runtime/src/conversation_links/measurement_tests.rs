use super::*;
use crate::WorkspaceSupervisor;
use std::time::Instant;

const AGGREGATE: &str = "SELECT a.object_id,MAX(a.created_at_ms),
    substr(MAX(printf('%020d',a.created_at_ms)||a.attachment_id),21) AS winner
    FROM chat_attachments a
    JOIN chat_threads t ON t.workspace_id=a.workspace_id AND t.thread_id=a.thread_id
    JOIN chat_messages m ON m.workspace_id=a.workspace_id AND m.thread_id=a.thread_id AND m.message_id=a.message_id
    WHERE a.workspace_id=?1 AND t.channel_id=?2 AND a.object_id IS NOT NULL
    GROUP BY COALESCE(a.object_id,a.path_hint)
    HAVING ?5='' OR (MAX(a.created_at_ms),substr(MAX(printf('%020d',a.created_at_ms)||a.attachment_id),21),a.object_id)<(?3,?4,?5)
    ORDER BY MAX(a.created_at_ms) DESC,winner DESC,a.object_id DESC LIMIT 101";

// Reproduce the aggregate, with deterministic ties and the production hydration,
// candidate limit, byte accounting, cursor sealing and continuation coordinates.
fn aggregate_page(s: &EngineStore, cursor: Option<String>) -> Value {
    s.read_with(|c| {
        let revision:i64=c.query_row("SELECT revision FROM chat_conversation_file_link_state WHERE workspace_id='ws' AND channel_id='a'",[],|r|r.get(0)).unwrap();
        let mut pos=cursor.map(|cursor|crate::chat_mentions::unseal_cursor::<Value>("ws","chats.conversations.listLinks",&cursor).unwrap())
            .unwrap_or_else(||json!({"format":1,"version":"main","subject":"wire-a","scope":"scope","revision":revision,
                "uncovered":0,"time":i64::MAX,"id":"","key":""}));
        let rows=c.prepare_cached(AGGREGATE).unwrap().query_map(params!["ws","a",pos["time"].as_i64().unwrap(),pos["id"].as_str().unwrap(),pos["key"].as_str().unwrap()],|r|
            Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        let mut p=json!({"versionId":"main","subject":{"channelWireId":"wire-a"},"entries":[],"unchecked":[],
            "complete":false,"indexBuilding":false,"mountsCovered":true,"sharedChannelRowsUncovered":0,"nextCursor":null});
        let mut reserve=pos.to_string().len();
        for (key,time,id) in &rows {let mut next=pos.clone();next["key"]=json!(key);next["time"]=json!(time);next["id"]=json!(id);reserve=reserve.max(next.to_string().len());}
        let mut bytes=p.to_string().len()+reserve.div_ceil(3)*4+256;
        let mut more=rows.len()>100;
        for (key,time,id) in rows.into_iter().take(100) {
            let (thread,message):(String,String)=c.prepare_cached("SELECT thread_id,message_id FROM chat_attachments WHERE workspace_id='ws' AND attachment_id=?1")
                .unwrap().query_row([&id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            if let Some(entry)=super::super::page::hydrate(c,"ws","a","main",&key,&id,&thread,&message,time).unwrap() {
                let size=entry.to_string().len()+1;
                if bytes+size>64*1024 {more=true;break;}
                p["entries"].as_array_mut().unwrap().push(entry);bytes+=size;
            }
            pos["time"]=json!(time);pos["id"]=json!(id);pos["key"]=json!(key);
        }
        if more {p["nextCursor"]=json!(crate::chat_mentions::seal_cursor("ws","chats.conversations.listLinks",&pos).unwrap());}
        assert!(p.to_string().len()<=64*1024);
        Ok::<_,StorageError>(p)
    }).unwrap()
}

fn median_page(mut run: impl FnMut() -> Value) -> (u128, Value) {
    let mut times = Vec::new();
    let mut result = run();
    for _ in 0..7 {
        let start = Instant::now();
        result = run();
        times.push(start.elapsed().as_micros());
    }
    times.sort_unstable();
    (times[3], result)
}

/// Run only under the campaign lock. Release mode, with no per-opcode hook.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "scheduled conversation Links measurement"]
async fn conversation_links_measure_same_fixture_aggregate_and_actual_mention_pages() {
    assert!(
        !std::hint::black_box(cfg!(debug_assertions)),
        "run the measurement with --release"
    );
    let mut results = Vec::new();
    for (history, unrelated, distinct) in [
        (1_000_i64, 0_i64, 256_i64),
        (10_000, 0, 256),
        (10_000, 10_000, 256),
        (10_000, 0, 2048),
    ] {
        let (scratch, mut s) = seed_measurement_fixture(history, unrelated, distinct);
        demand(&mut s, "z-small");
        demand(&mut s, "a");
        let start = Instant::now();
        let mut small_us = 0;
        let mut slices = 0;
        let mut max_slice_us = 0;
        let mut reopen_us = 0;
        loop {
            let begin = Instant::now();
            let pending = tick(&mut s).unwrap();
            max_slice_us = max_slice_us.max(begin.elapsed().as_micros());
            if !pending {
                break;
            }
            slices += 1;
            if small_us == 0 && page(&s, "z-small", None).unwrap()["indexBuilding"] == false {
                small_us = start.elapsed().as_micros();
                assert_eq!(page(&s, "z-small", None).unwrap()["indexBuilding"], false);
                assert_eq!(
                    page(&s, "a", None).unwrap()["indexBuilding"],
                    true,
                    "small request must finish first"
                );
            }
            if slices == 5 && history >= 10_000 {
                drop(s);
                let begin = Instant::now();
                s = EngineStore::open(&engine_db_path(&scratch).unwrap(), 2).unwrap();
                reopen_us = begin.elapsed().as_micros();
            }
        }
        let seed_us = start.elapsed().as_micros();
        let (first_us, first) = median_page(|| page(&s, "a", None).unwrap());
        let (next_us, next) = median_page(|| {
            page(&s, "a", Some(first["nextCursor"].as_str().unwrap().into())).unwrap()
        });
        let (aggregate_us, aggregate) = median_page(|| aggregate_page(&s, None));
        let (aggregate_next_us, aggregate_next) = median_page(|| {
            aggregate_page(&s, Some(aggregate["nextCursor"].as_str().unwrap().into()))
        });
        assert_eq!(first["entries"], aggregate["entries"]);
        assert_eq!(next["entries"], aggregate_next["entries"]);
        assert!(first.to_string().len() <= 64 * 1024 && next.to_string().len() <= 64 * 1024);
        let aggregate_plan = s
            .read_with(|c| {
                c.prepare(&format!("EXPLAIN QUERY PLAN {AGGREGATE}"))
                    .unwrap()
                    .query_map(params!["ws", "a", i64::MAX, "", ""], |r| {
                        r.get::<_, String>(3)
                    })
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap();
        let page_plan=s.read_with(|c|c.prepare("EXPLAIN QUERY PLAN SELECT file_key,attachment_id,thread_id,message_id,mentioned_at_ms FROM chat_conversation_file_links WHERE workspace_id='ws' AND channel_id='a' AND invalid=0 AND (mentioned_at_ms,attachment_id,file_key)<(999999,'z','z') ORDER BY mentioned_at_ms DESC,attachment_id DESC,file_key DESC LIMIT 101").unwrap().query_map([],|r|r.get::<_,String>(3)).unwrap().collect::<Result<Vec<_>,_>>()).unwrap();
        assert!(page_plan.iter().all(|p| !p.contains("TEMP B-TREE")));
        let mut expected = std::collections::BTreeSet::new();
        let mut cursor = None;
        loop {
            let p = page(&s, "a", cursor).unwrap();
            for e in p["entries"].as_array().unwrap() {
                expected.insert(e["file"]["objectId"].as_str().unwrap().to_owned());
            }
            cursor = p["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        // Main's mention page does not have migration 65's hydration index.
        exec(&mut s, "DROP INDEX conversation_file_link_alias;");
        drop(s);
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor
            .open_read_only_counting(&engine_db_path(&scratch).unwrap(), None)
            .unwrap()
            .actor;
        let start = Instant::now();
        let mut cursor = None;
        let mut pages = 0;
        let mut records = 0;
        let mut bytes = 0;
        let mut found = std::collections::BTreeSet::new();
        loop {
            let p = actor
                .chat_file_mentions_page(
                    "ws".into(),
                    None,
                    "scope".into(),
                    0,
                    cursor,
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            pages += 1;
            bytes += p.to_string().len();
            for e in p["entries"].as_array().unwrap() {
                records += 1;
                if e["channelId"] == "a" {
                    found.insert(e["attachment"]["objectId"].as_str().unwrap().to_owned());
                }
            }
            cursor = p["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        let drain_us = start.elapsed().as_micros();
        assert_eq!(found, expected);
        drop(actor);
        drop(supervisor);
        results.push(json!({"history":history,"unrelated":unrelated,"distinctFiles":distinct,"fixture":{"threads":33,"orphans":64,"tiedTimestampGroup":5,"unprovedPathOnly":1,"sparseEvery":7,"longLabelEvery":11},
            "projection":{"firstUs":first_us,"continuationUs":next_us,"firstBytes":first.to_string().len(),"continuationBytes":next.to_string().len(),"firstRecords":first["entries"].as_array().unwrap().len(),"continuationRecords":next["entries"].as_array().unwrap().len(),"plan":page_plan},
            "aggregate":{"firstUs":aggregate_us,"continuationUs":aggregate_next_us,"hydration":"production helper; same record and byte limits","plan":aggregate_plan},
            "multiConversationSeed":{"requestOrder":["z-small","a"],"smallUs":small_us,"totalUs":seed_us,"slices":slices,"maxSliceUs":max_slice_us,"reopenUs":reopen_us},
            "actualMentionDrain":{"pages":pages,"records":records,"bytes":bytes,"us":drain_us}}));
    }
    println!(
        "CONVERSATION_LINKS_MEASUREMENT {}",
        serde_json::to_string(&results).unwrap()
    );
}

fn seed_measurement_fixture(
    history: i64,
    unrelated: i64,
    distinct: i64,
) -> (ScratchDir, EngineStore) {
    let (scratch, mut s) = fixture();
    s.write_with(&NoFaults,|c| {
        for i in 0..distinct {
            let object=format!("f-{i:04}");
            c.execute("INSERT INTO file_objects VALUES('ws',?1,1)",[&object]).map_err(sql)?;
            if i%7!=6 {
                let path=if i%11==3 {format!("notes/{}/{object}.md","long-label".repeat(120))} else {format!("notes/{object}.md")};
                c.execute("INSERT INTO path_aliases VALUES('ws','main',?1,?2)",params![path,object]).map_err(sql)?;
            }
        }
        for i in 0..32 {
            let thread=format!("p-{i:02}");let message=format!("pm-{i:02}");
            c.execute("INSERT INTO chat_threads(workspace_id,thread_id,title,created_at_ms,updated_at_ms,channel_id,lane) VALUES('ws',?1,'Measured',1,1,?2,?3)",params![thread,if i<16 {"a"} else {"b"},if i%2==0 {"posts"} else {"chat"}]).map_err(sql)?;
            c.execute("INSERT INTO chat_messages(workspace_id,thread_id,message_order,message_id,author_kind,author_display_name,body,created_at_ms) VALUES('ws',?1,0,?2,'human',?3,'',1)",params![thread,message,"Long author ".repeat(20)]).map_err(sql)?;
        }
        let mut insert=c.prepare_cached("INSERT INTO chat_attachments(workspace_id,attachment_id,thread_id,message_id,target_kind,object_id,path_hint,created_at_ms) VALUES('ws',?1,?2,?3,'file',?4,?5,?6)").map_err(sql)?;
        for i in 0..history+unrelated {
            let n=if i<history {i%16} else {16+i%16};
            let object=format!("f-{:04}",if i<distinct {i} else {0});
            insert.execute(params![format!("id-{i:06}"),format!("p-{n:02}"),format!("pm-{n:02}"),object,Option::<String>::None,i/5]).map_err(sql)?;
        }
        for i in 0..64 {insert.execute(params![format!("orphan-{i:03}"),"p-00","absent","f-0000",Option::<String>::None,history+i]).map_err(sql)?;}
        insert.execute(params!["unresolved","p-00","pm-00",Option::<String>::None,"old/unproved.md",history]).map_err(sql)?;
        c.execute_batch("INSERT INTO chat_channels(workspace_id,channel_id,name,slug,kind,created_at_ms,updated_at_ms) VALUES('ws','z-small','Small','z-small','channel',1,1);
            INSERT INTO chat_channel_wire_ids VALUES('ws','wire-z-small','z-small');
            INSERT INTO chat_threads(workspace_id,thread_id,title,created_at_ms,updated_at_ms,channel_id) VALUES('ws','small','Small',1,1,'z-small');
            INSERT INTO chat_messages(workspace_id,thread_id,message_order,message_id,author_kind,author_display_name,body,created_at_ms) VALUES('ws','small',0,'small-message','human','Ada','',1);").map_err(sql)?;
        for i in 0..3 {insert.execute(params![format!("small-{i}"),"small","small-message",format!("f-{i:04}"),Option::<String>::None,i]).map_err(sql)?;}
        Ok::<_,StorageError>(())
    }).unwrap();
    (scratch, s)
}

/// Seed rows only: optimized release, no opcode hook, both request orders.
#[test]
#[ignore = "scheduled conversation Links seed measurement"]
fn conversation_links_measure_seed_only() {
    assert!(
        !std::hint::black_box(cfg!(debug_assertions)),
        "run with --release"
    );
    let mut results = Vec::new();
    for (history, unrelated, distinct, empty_threads) in [
        (1000, 0, 256, 0),
        (10000, 0, 256, 0),
        (10000, 10000, 256, 0),
        (10000, 0, 2048, 0),
        (0, 0, 256, 20000),
    ] {
        for small_first in [true, false] {
            let (scratch, mut s) = seed_measurement_fixture(history, unrelated, distinct);
            if empty_threads != 0 {
                exec(
                    &mut s,
                    "DELETE FROM chat_attachments WHERE attachment_id LIKE 'orphan-%' OR attachment_id='unresolved';",
                );
                posts_seed_fixture(&mut s, empty_threads, 50);
            }
            let order = if small_first {
                ["z-small", "a"]
            } else {
                ["a", "z-small"]
            };
            for channel in order {
                demand(&mut s, channel);
            }
            let start = Instant::now();
            let mut slices = 0;
            let mut small_slices = 0;
            let mut small_us = 0;
            let mut max_slice_us = 0;
            let mut max_slice_channel = String::new();
            let mut reopen_us = 0;
            loop {
                let channel: Option<String> = s.read_with(|c| c.query_row(
                    "SELECT channel_id FROM chat_conversation_file_link_state WHERE seed_phase='scan' ORDER BY seed_turn,request_id LIMIT 1",
                    [], |r| r.get(0)).optional()).unwrap();
                let begin = Instant::now();
                let pending = tick(&mut s).unwrap();
                let elapsed = begin.elapsed().as_micros();
                if elapsed > max_slice_us {
                    max_slice_us = elapsed;
                    max_slice_channel = channel.unwrap_or_else(|| "idle".into());
                }
                if !pending {
                    break;
                }
                slices += 1;
                if small_slices == 0 && page(&s, "z-small", None).unwrap()["indexBuilding"] == false
                {
                    small_slices = slices;
                    small_us = start.elapsed().as_micros();
                    assert_eq!(page(&s, "a", None).unwrap()["indexBuilding"], true);
                }
                if slices == 5 && history >= 10000 {
                    drop(s);
                    let begin = Instant::now();
                    s = EngineStore::open(&engine_db_path(&scratch).unwrap(), 2).unwrap();
                    reopen_us = begin.elapsed().as_micros();
                }
            }
            assert_eq!(small_slices, if small_first { 3 } else { 4 });
            if empty_threads != 0 {
                assert_eq!(slices, 53);
            }
            results.push(json!({"history":history,"unrelated":unrelated,"distinct":distinct,
                "emptyThreadFixture":empty_threads,"requestOrder":order,"slices":slices,
                "smallReadyAtSlice":small_slices,"smallUs":small_us,"totalUs":start.elapsed().as_micros(),
                "maxSliceUs":max_slice_us,"maxSliceKind":"seed","maxSliceChannel":max_slice_channel,"reopenUs":reopen_us}));
        }
    }
    println!(
        "CONVERSATION_LINKS_SEED_MEASUREMENT {}",
        serde_json::to_string(&results).unwrap()
    );
}
