use super::*;
use crate::WorkspaceSupervisor;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Instant;

fn exact_work(s: &EngineStore, counter: Arc<AtomicU64>) {
    s.read_with(|c| {
        c.progress_handler(
            1,
            Some(move || {
                counter.fetch_add(1, Ordering::Relaxed);
                false
            }),
        )
        .map_err(sql)
    })
    .unwrap();
}

/// Run explicitly under the campaign heavy-job lock; this is an engine fixture, not a packaged benchmark.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "scheduled conversation Links measurement"]
async fn conversation_links_measure_same_fixture_aggregate_and_actual_mention_pages() {
    let mut results = Vec::new();
    let mut baseline = None;
    for (history, unrelated) in [(1_000_i64, 0_i64), (10_000, 0), (10_000, 10_000)] {
        let (scratch, mut s) = fixture();
        s.write_with(&NoFaults,|c| {
            for i in 0..256 { let object=format!("f-{i:03}");c.execute("INSERT INTO file_objects VALUES('ws',?1,1)",[&object]).map_err(sql)?;
                c.execute("INSERT INTO path_aliases VALUES('ws','main',?1,?2)",params![format!("notes/{object}.md"),object]).map_err(sql)?; }
            for i in 0..history+unrelated {
                let (thread,message)=if i<history {("t","m")} else {("u","n")};
                let object=format!("f-{:03}",if i<256 {i} else {0});
                c.execute("INSERT INTO chat_attachments(workspace_id,attachment_id,thread_id,message_id,target_kind,object_id,created_at_ms) VALUES('ws',?1,?2,?3,'file',?4,?5)",
                    params![format!("id-{i:06}"),thread,message,object,i]).map_err(sql)?;
            }
            Ok::<_,StorageError>(())
        }).unwrap();
        let work = Arc::new(AtomicU64::new(0));
        exact_work(&s, work.clone());
        let aggregate = "SELECT a.object_id,MAX(a.created_at_ms) FROM chat_attachments a JOIN chat_threads t ON t.workspace_id=a.workspace_id AND t.thread_id=a.thread_id JOIN chat_messages m ON m.workspace_id=a.workspace_id AND m.thread_id=a.thread_id AND m.message_id=a.message_id WHERE a.workspace_id=?1 AND t.channel_id=?2 GROUP BY COALESCE(a.object_id,a.path_hint) ORDER BY MAX(a.created_at_ms) DESC LIMIT ?3";
        let start = Instant::now();
        let (aggregate_rows, aggregate_plan) = s
            .read_with(|c| {
                let rows = c
                    .prepare(aggregate)
                    .unwrap()
                    .query_map(params!["ws", "a", 100], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                    })
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                let plan = c
                    .prepare(&format!("EXPLAIN QUERY PLAN {aggregate}"))
                    .unwrap()
                    .query_map(params!["ws", "a", 100], |r| r.get::<_, String>(3))
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                Ok::<_, StorageError>((rows, plan))
            })
            .unwrap();
        let aggregate_us = start.elapsed().as_micros();
        let aggregate_steps = work.swap(0, Ordering::Relaxed);
        demand(&mut s, "a");
        let mut slices = 0;
        let mut max_slice_us = 0;
        let start = Instant::now();
        while {
            let start = Instant::now();
            let pending = tick(&mut s).unwrap();
            max_slice_us = max_slice_us.max(start.elapsed().as_micros());
            pending
        } {
            slices += 1;
        }
        let seed_us = start.elapsed().as_micros();
        let seed_steps = work.swap(0, Ordering::Relaxed);
        let start = Instant::now();
        let first = page(&s, "a", None).unwrap();
        let first_us = start.elapsed().as_micros();
        let first_steps = work.swap(0, Ordering::Relaxed);
        let start = Instant::now();
        let second = page(&s, "a", Some(first["nextCursor"].as_str().unwrap().into())).unwrap();
        let second_us = start.elapsed().as_micros();
        let second_steps = work.swap(0, Ordering::Relaxed);
        let page_plan=s.read_with(|c| c.prepare("EXPLAIN QUERY PLAN SELECT file_key,attachment_id FROM chat_conversation_file_links WHERE workspace_id='ws' AND channel_id='a' AND invalid=0 AND (mentioned_at_ms,attachment_id,file_key)<(999999,'z','z') ORDER BY mentioned_at_ms DESC,attachment_id DESC,file_key DESC LIMIT 101").unwrap().query_map([],|r| r.get::<_,String>(3)).unwrap().collect::<Result<Vec<_>,_>>()).unwrap();
        assert!(page_plan.iter().all(|s| !s.contains("TEMP B-TREE")));
        assert_eq!(first["entries"].as_array().unwrap().len(), 100);
        assert_eq!(second["entries"].as_array().unwrap().len(), 100);
        println!(
            "PAGE_WORK history={history} unrelated={unrelated} first={first_steps} continuation={second_steps}"
        );
        if let Some((first_base, second_base)) = baseline {
            assert!(
                first_steps <= first_base + 2000 && second_steps <= second_base + 2000,
                "page work grew with history or unrelated rows"
            );
        } else {
            baseline = Some((first_steps, second_steps));
        }
        // Retained repair must yield rather than consume all unrelated mentions.
        exec(
            &mut s,
            "DELETE FROM chat_attachments WHERE attachment_id='id-009999';",
        );
        let start = Instant::now();
        tick(&mut s).unwrap();
        let repair_slice_us = start.elapsed().as_micros();
        let repair_slice_steps = work.swap(0, Ordering::Relaxed);
        drain(&mut s);
        // Reinsert so all comparison readers see the same admitted history.
        if history == 10_000 {
            attach(&mut s, "id-009999", Some("f-000"), 9999, "t", "m");
            drain(&mut s);
        }
        exec(&mut s, "DROP INDEX conversation_file_link_alias;");
        s.count_work(None).unwrap();
        drop(s);
        let supervisor = WorkspaceSupervisor::new();
        let start = Instant::now();
        let actor = supervisor
            .open_read_only_counting(&engine_db_path(&scratch).unwrap(), Some(work.clone()))
            .unwrap()
            .actor;
        let open_us = start.elapsed().as_micros();
        let counter = work.clone();
        actor
            .run(move |store, _| {
                exact_work(store, counter);
                Ok::<_, RuntimeError>(())
            })
            .await
            .unwrap();
        work.store(0, Ordering::Relaxed);
        let start = Instant::now();
        let mut cursor = None;
        let mut pages = 0;
        let mut mentions = 0;
        let mut bytes = 0;
        let mut distinct = std::collections::BTreeSet::new();
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
            for entry in p["entries"].as_array().unwrap() {
                mentions += 1;
                if entry["channelId"] == "a" {
                    distinct.insert(entry["attachment"]["objectId"].as_str().unwrap().to_owned());
                }
            }
            cursor = p["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        let drain_us = start.elapsed().as_micros();
        let drain_steps = work.swap(0, Ordering::Relaxed);
        assert_eq!(distinct.len(), 256);
        drop(actor);
        drop(supervisor);
        results.push(json!({"history":history,"unrelated":unrelated,"aggregate":{"rows":aggregate_rows.len(),"us":aggregate_us,"vmSteps":aggregate_steps,"plan":aggregate_plan},
            "projection":{"firstUs":first_us,"continuationUs":second_us,"firstVmSteps":first_steps,"continuationVmSteps":second_steps,"firstBytes":first.to_string().len(),"continuationBytes":second.to_string().len(),"candidateWindow":101,"hydrationMaximum":100,"plan":page_plan},
            "seed":{"slices":slices,"us":seed_us,"vmSteps":seed_steps,"maxActorSliceUs":max_slice_us},"repair":{"oneSliceUs":repair_slice_us,"vmSteps":repair_slice_steps},
            "actualMentionDrain":{"pages":pages,"records":mentions,"bytes":bytes,"us":drain_us,"vmSteps":drain_steps},"readOnlyOpenUs":open_us}));
    }
    println!(
        "CONVERSATION_LINKS_MEASUREMENT {}",
        serde_json::to_string(&results).unwrap()
    );
}
