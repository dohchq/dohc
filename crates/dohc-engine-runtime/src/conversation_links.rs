use crate::{ActorHandle, RuntimeError};
use dohc_engine_storage::{EngineStore, NoFaults, StorageError};
use rusqlite::{Connection, OptionalExtension, params};

mod page;
#[cfg(test)]
mod tests;

const BATCH: i64 = 100;
pub(super) fn sql(error: rusqlite::Error) -> StorageError {
    StorageError::persist_public(error)
}

fn publish(c: &Connection, ws: &str, channel: &str, id: &str) -> Result<(), StorageError> {
    c.prepare_cached(
        "INSERT INTO chat_conversation_file_links(workspace_id,channel_id,file_key,attachment_id,thread_id,message_id,mentioned_at_ms)
         SELECT workspace_id,channel_id,object_id,attachment_id,thread_id,message_id,created_at_ms
         FROM chat_conversation_file_link_candidates WHERE workspace_id=?1 AND channel_id=?2 AND attachment_id=?3 AND object_id IS NOT NULL
         ON CONFLICT(workspace_id,channel_id,file_key) DO UPDATE SET
         attachment_id=excluded.attachment_id,thread_id=excluded.thread_id,message_id=excluded.message_id,
         mentioned_at_ms=excluded.mentioned_at_ms,invalid=0
         WHERE (excluded.mentioned_at_ms,excluded.attachment_id)>(chat_conversation_file_links.mentioned_at_ms,chat_conversation_file_links.attachment_id)",
    ).map_err(sql)?.execute(params![ws,channel,id]).map_err(sql)?;
    c.prepare_cached("UPDATE chat_conversation_file_link_state SET legacy=1 WHERE workspace_id=?1 AND channel_id=?2 AND EXISTS(
        SELECT 1 FROM chat_conversation_file_link_candidates WHERE workspace_id=?1 AND channel_id=?2 AND attachment_id=?3 AND object_id IS NULL)",
        ).map_err(sql)?.execute(params![ws,channel,id]).map_err(sql)?;
    Ok(())
}

#[derive(Clone)]
struct Work {
    id: i64,
    ws: String,
    channel: String,
    kind: String,
    key: String,
    revision: i64,
    phase: i64,
    message: String,
    time: i64,
    after: String,
    failures: u32,
}

fn enqueue(c: &Connection, work: &Work, object: &str) -> Result<(), StorageError> {
    c.prepare_cached("INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key) VALUES(?1,?2,'file',?3)
        ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,after_time=9223372036854775807,after_id=''").map_err(sql)?.execute(
        params![work.ws,work.channel,object]).map_err(sql)?;
    Ok(())
}

fn finish(c: &Connection, work: &Work) -> Result<(), StorageError> {
    c.prepare_cached(
        "DELETE FROM chat_conversation_file_link_work WHERE work_id=?1 AND revision=?2",
    )
    .map_err(sql)?
    .execute(params![work.id, work.revision])
    .map_err(sql)?;
    Ok(())
}

fn repair(c: &Connection, w: &Work) -> Result<(), StorageError> {
    // Phase 2 is the rebuilding barrier. The phase index schedules all file
    // repairs before releasing it, including work queued by other thread slices.
    if w.kind == "thread" && w.phase == 2 {
        return finish(c, w);
    }
    if w.kind == "file" {
        let mut stmt = c
            .prepare_cached(
                "SELECT attachment_id,created_at_ms FROM chat_attachments
            WHERE workspace_id=?1 AND object_id=?2 AND (created_at_ms,attachment_id)<(?3,?4)
            ORDER BY created_at_ms DESC,attachment_id DESC LIMIT ?5",
            )
            .map_err(sql)?;
        let rows = stmt
            .query_map(params![w.ws, w.key, w.time, w.after, BATCH], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        for (id, _) in &rows {
            let eligible: bool = c
                .prepare_cached(
                    "SELECT EXISTS(SELECT 1 FROM chat_conversation_file_link_candidates
                WHERE workspace_id=?1 AND channel_id=?2 AND attachment_id=?3)",
                )
                .map_err(sql)?
                .query_row(params![w.ws, w.channel, id], |r| r.get(0))
                .map_err(sql)?;
            if eligible {
                c.prepare_cached("DELETE FROM chat_conversation_file_links WHERE workspace_id=?1 AND channel_id=?2 AND file_key=?3").map_err(sql)?.execute(params![w.ws,w.channel,w.key]).map_err(sql)?;
                publish(c, &w.ws, &w.channel, id)?;
                return finish(c, w);
            }
        }
        if rows.len() < BATCH as usize {
            c.prepare_cached("DELETE FROM chat_conversation_file_links WHERE workspace_id=?1 AND channel_id=?2 AND file_key=?3").map_err(sql)?.execute(params![w.ws,w.channel,w.key]).map_err(sql)?;
            finish(c, w)?;
        } else if let Some((id, time)) = rows.last() {
            // Strictly exclude the consumed row on the next bounded slice.
            c.prepare_cached("UPDATE chat_conversation_file_link_work SET after_time=?2,after_id=?3 WHERE work_id=?1 AND revision=?4").map_err(sql)?.execute(
                params![w.id,time,id,w.revision]).map_err(sql)?;
        }
    } else if w.kind == "thread" && w.phase == 0 {
        let rows = thread_slice(c, w)?;
        for (_, _, id, object) in &rows {
            if let Some(object) = object {
                enqueue(c, w, object)?;
            } else {
                publish(c, &w.ws, &w.channel, id)?;
            }
        }
        if let Some((message, time, id, _)) = rows.last() {
            c.prepare_cached("UPDATE chat_conversation_file_link_work SET after_message=?2,after_time=?3,after_id=?4 WHERE work_id=?1 AND revision=?5").map_err(sql)?.execute(
                params![w.id,message,time,id,w.revision]).map_err(sql)?;
        }
        if rows.len() < BATCH as usize {
            c.prepare_cached("UPDATE chat_conversation_file_link_work SET phase=1,after_id='' WHERE work_id=?1 AND revision=?2").map_err(sql)?.execute(params![w.id,w.revision]).map_err(sql)?;
        }
    } else {
        let (query, limit) = if w.kind == "reset" {
            (
                "SELECT file_key FROM chat_conversation_file_links WHERE workspace_id=?1 AND channel_id=?2 AND file_key>?3 ORDER BY file_key LIMIT ?4",
                BATCH,
            )
        } else {
            (
                "SELECT file_key FROM chat_conversation_file_links WHERE workspace_id=?1 AND channel_id=?2 AND thread_id=?5 AND file_key>?3 ORDER BY file_key LIMIT ?4",
                BATCH,
            )
        };
        let mut stmt = c.prepare_cached(query).map_err(sql)?;
        let mut args = vec![
            w.ws.clone().into(),
            w.channel.clone().into(),
            w.after.clone().into(),
            rusqlite::types::Value::Integer(limit),
        ];
        if w.kind != "reset" {
            args.push(w.key.clone().into());
        }
        let keys = stmt
            .query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        for key in &keys {
            if w.kind == "reset" {
                c.prepare_cached("DELETE FROM chat_conversation_file_links WHERE workspace_id=?1 AND channel_id=?2 AND file_key=?3").map_err(sql)?.execute(params![w.ws,w.channel,key]).map_err(sql)?;
            } else {
                enqueue(c, w, key)?;
            }
        }
        if keys.len() < BATCH as usize {
            if w.kind == "reset" {
                finish(c, w)?;
            } else {
                c.prepare_cached("UPDATE chat_conversation_file_link_work SET phase=2 WHERE work_id=?1 AND revision=?2").map_err(sql)?.execute(params![w.id,w.revision]).map_err(sql)?;
            }
        } else if let Some(key) = keys.last() {
            c.prepare_cached("UPDATE chat_conversation_file_link_work SET after_id=?2 WHERE work_id=?1 AND revision=?3").map_err(sql)?.execute(params![w.id,key,w.revision]).map_err(sql)?;
        }
    }
    Ok(())
}

type AttachmentCoordinate = (String, i64, String, Option<String>);
fn thread_slice(c: &Connection, w: &Work) -> Result<Vec<AttachmentCoordinate>, StorageError> {
    c.prepare_cached("SELECT message_id,created_at_ms,attachment_id,object_id FROM chat_attachments
        WHERE workspace_id=?1 AND thread_id=?2 AND (message_id,created_at_ms,attachment_id)>(?3,?4,?5)
        ORDER BY message_id,created_at_ms,attachment_id LIMIT ?6").map_err(sql)?
        .query_map(params![w.ws,w.key,w.message,w.time,w.after,BATCH], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))
        .map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)
}

fn seed(c: &Connection, w: &Work) -> Result<(), StorageError> {
    let thread: Option<String> = c
        .prepare_cached(
            "SELECT thread_id FROM chat_threads t WHERE workspace_id=?1 AND channel_id=?2
         AND thread_id>=?3 AND (?4=0 OR thread_id>?3)
         AND EXISTS(SELECT 1 FROM chat_attachments a WHERE a.workspace_id=t.workspace_id AND a.thread_id=t.thread_id)
         ORDER BY thread_id LIMIT 1",
        )
        .map_err(sql)?
        .query_row(params![w.ws, w.channel, w.key, w.phase], |r| r.get(0))
        .optional()
        .map_err(sql)?;
    let Some(thread) = thread else {
        c.prepare_cached("UPDATE chat_conversation_file_link_state SET seed_phase='ready',failures=0,retry_at_ms=0 WHERE request_id=?1")
            .map_err(sql)?.execute([w.id]).map_err(sql)?;
        return Ok(());
    };
    let same = thread == w.key && w.phase == 0;
    let scan = Work {
        key: thread.clone(),
        message: if same {
            w.message.clone()
        } else {
            String::new()
        },
        time: if same { w.time } else { i64::MAX },
        after: if same { w.after.clone() } else { String::new() },
        ..w.clone()
    };
    let rows = thread_slice(c, &scan)?;
    for (_, _, id, _) in &rows {
        publish(c, &w.ws, &w.channel, id)?;
    }
    let done = rows.len() < BATCH as usize;
    let (message, time, id) = if !done {
        let (m, t, id, _) = rows.last().expect("full slice");
        (m.as_str(), *t, id.as_str())
    } else {
        ("", i64::MAX, "")
    };
    c.prepare_cached("UPDATE chat_conversation_file_link_state SET seed_turn=(SELECT COALESCE(MAX(seed_turn),0)+1 FROM chat_conversation_file_link_state WHERE seed_phase='scan'),seed_thread=?2,seed_message=?3,seed_time=?4,seed_after=?5,seed_done=?6,failures=0,retry_at_ms=0 WHERE request_id=?1")
        .map_err(sql)?.execute(params![w.id,thread,message,time,id,done]).map_err(sql)?;
    Ok(())
}

/// Retain the failed item and its barrier, but let other conversations advance.
fn backoff(
    store: &mut EngineStore,
    w: &Work,
    now: i64,
    seed: bool,
    error: StorageError,
) -> Result<(), StorageError> {
    let delay = (250_i64 * (1_i64 << w.failures.min(8))).min(60_000);
    eprintln!(
        "conversation links {} item {} retained, attempt {}, retry in {delay}ms: {error}",
        if seed { "seed" } else { "repair" },
        w.id,
        w.failures.saturating_add(1)
    );
    store.write_background_with(&NoFaults, |c| {
        let query = if seed {
            "UPDATE chat_conversation_file_link_state SET failures=failures+1,retry_at_ms=?2 WHERE request_id=?1"
        } else {
            "UPDATE chat_conversation_file_link_work SET failures=failures+1,retry_at_ms=?2 WHERE work_id=?1"
        };
        c.prepare_cached(query).map_err(sql)?.execute(params![w.id,now.saturating_add(delay)]).map_err(sql)
    })?;
    Ok(())
}

/// One transaction consumes at most 100 coordinates; demand alone enables scheduling.
fn tick_at(store: &mut EngineStore, now: i64) -> Result<std::time::Duration, StorageError> {
    use std::time::Duration;
    let work = store.read_with(|c| c.prepare_cached("SELECT work_id,workspace_id,channel_id,kind,key,revision,phase,after_message,after_time,after_id,failures
        FROM chat_conversation_file_link_work w WHERE (retry_at_ms<=?1 OR retry_at_ms>?2)
        AND (phase<>2 OR NOT EXISTS(SELECT 1 FROM chat_conversation_file_link_work other
            WHERE other.workspace_id=w.workspace_id AND other.channel_id=w.channel_id AND other.phase<>2))
        ORDER BY phase,work_id LIMIT 1").map_err(sql)?.query_row(params![now,now.saturating_add(60_000)], |r| Ok(Work {
            id:r.get(0)?,ws:r.get(1)?,channel:r.get(2)?,kind:r.get(3)?,key:r.get(4)?,revision:r.get(5)?,
            phase:r.get(6)?,message:r.get(7)?,time:r.get(8)?,after:r.get(9)?,failures:r.get(10)?,
        })).optional().map_err(sql))?;
    if let Some(work) = work {
        if let Err(error) = store.write_background_with(&NoFaults, |c| {
            repair(c, &work)?;
            c.prepare_cached("UPDATE chat_conversation_file_link_work SET failures=0,retry_at_ms=0 WHERE work_id=?1 AND revision=?2")
                .map_err(sql)?.execute(params![work.id,work.revision]).map_err(sql)?;
            Ok(())
        }) {
            backoff(store, &work, now, false, error)?;
        }
        return Ok(Duration::ZERO);
    }
    let requested = store.read_with(|c| c.prepare_cached(
        "SELECT request_id,workspace_id,channel_id,seed_thread,seed_done,seed_message,seed_time,seed_after,failures
         FROM chat_conversation_file_link_state WHERE seed_phase='scan' AND (retry_at_ms<=?1 OR retry_at_ms>?2) ORDER BY seed_turn,request_id LIMIT 1"
    ).map_err(sql)?.query_row(params![now,now.saturating_add(60_000)], |r| Ok(Work {
        id:r.get(0)?,ws:r.get(1)?,channel:r.get(2)?,key:r.get(3)?,phase:r.get(4)?,message:r.get(5)?,
        time:r.get(6)?,after:r.get(7)?,failures:r.get(8)?,kind:String::new(),revision:0,
    })).optional().map_err(sql))?;
    if let Some(requested) = requested {
        if let Err(error) = store.write_background_with(&NoFaults, |c| seed(c, &requested)) {
            backoff(store, &requested, now, true, error)?;
        }
        return Ok(Duration::ZERO);
    }
    let next: Option<i64> = store.read_with(|c| c.query_row(
        "SELECT MIN(retry_at_ms) FROM (
            SELECT retry_at_ms FROM chat_conversation_file_link_work w
            WHERE phase<>2 OR NOT EXISTS(SELECT 1 FROM chat_conversation_file_link_work other
                WHERE other.workspace_id=w.workspace_id AND other.channel_id=w.channel_id AND other.phase<>2)
            UNION ALL SELECT retry_at_ms FROM chat_conversation_file_link_state WHERE seed_phase='scan')",
        [], |r| r.get(0)).map_err(sql))?;
    Ok(next.map_or(Duration::MAX, |deadline| {
        Duration::from_millis(deadline.saturating_sub(now).clamp(0, 60_000) as u64)
    }))
}

pub(crate) fn tick_delay(store: &mut EngineStore) -> Result<std::time::Duration, StorageError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    tick_at(store, now)
}

#[cfg(test)]
fn tick(store: &mut EngineStore) -> Result<bool, StorageError> {
    tick_delay(store).map(|delay| delay != std::time::Duration::MAX)
}

impl ActorHandle {
    pub(crate) async fn enable_conversation_links(&self) -> Result<(), RuntimeError> {
        self.request_conversation_links().await
    }
}
