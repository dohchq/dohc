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
    c.execute(
        "INSERT INTO chat_conversation_file_links(workspace_id,channel_id,file_key,attachment_id,thread_id,message_id,object_id,path_hint,mentioned_at_ms)
         SELECT workspace_id,channel_id,object_id,attachment_id,thread_id,message_id,object_id,path_hint,created_at_ms
         FROM chat_conversation_file_link_candidates WHERE workspace_id=?1 AND channel_id=?2 AND attachment_id=?3 AND object_id IS NOT NULL
         ON CONFLICT(workspace_id,channel_id,file_key) DO UPDATE SET
         attachment_id=excluded.attachment_id,thread_id=excluded.thread_id,message_id=excluded.message_id,
         object_id=excluded.object_id,path_hint=excluded.path_hint,mentioned_at_ms=excluded.mentioned_at_ms,invalid=0
         WHERE (excluded.mentioned_at_ms,excluded.attachment_id)>(chat_conversation_file_links.mentioned_at_ms,chat_conversation_file_links.attachment_id)",
        params![ws,channel,id],
    ).map_err(sql)?;
    c.execute("UPDATE chat_conversation_file_link_state SET legacy=1 WHERE workspace_id=?1 AND channel_id=?2 AND EXISTS(
        SELECT 1 FROM chat_conversation_file_link_candidates WHERE workspace_id=?1 AND channel_id=?2 AND attachment_id=?3 AND object_id IS NULL)",
        params![ws,channel,id]).map_err(sql)?;
    Ok(())
}

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
}

fn enqueue(c: &Connection, work: &Work, object: &str) -> Result<(), StorageError> {
    c.execute("INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key) VALUES(?1,?2,'file',?3)
        ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,after_time=9223372036854775807,after_id=''",
        params![work.ws,work.channel,object]).map_err(sql)?;
    Ok(())
}

fn finish(c: &Connection, work: &Work) -> Result<(), StorageError> {
    c.execute(
        "DELETE FROM chat_conversation_file_link_work WHERE work_id=?1 AND revision=?2",
        params![work.id, work.revision],
    )
    .map_err(sql)?;
    Ok(())
}

fn repair(c: &Connection, w: &Work) -> Result<(), StorageError> {
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
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM chat_conversation_file_link_candidates
                WHERE workspace_id=?1 AND channel_id=?2 AND attachment_id=?3)",
                    params![w.ws, w.channel, id],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            if eligible {
                c.execute("DELETE FROM chat_conversation_file_links WHERE workspace_id=?1 AND channel_id=?2 AND file_key=?3",params![w.ws,w.channel,w.key]).map_err(sql)?;
                publish(c, &w.ws, &w.channel, id)?;
                return finish(c, w);
            }
        }
        if rows.len() < BATCH as usize {
            c.execute("DELETE FROM chat_conversation_file_links WHERE workspace_id=?1 AND channel_id=?2 AND file_key=?3",params![w.ws,w.channel,w.key]).map_err(sql)?;
            finish(c, w)?;
        } else if let Some((id, time)) = rows.last() {
            // Strictly exclude the consumed row on the next bounded slice.
            c.execute("UPDATE chat_conversation_file_link_work SET after_time=?2,after_id=?3 WHERE work_id=?1 AND revision=?4",
                params![w.id,time,id,w.revision]).map_err(sql)?;
        }
    } else if w.kind == "thread" && w.phase == 0 {
        let mut stmt = c.prepare_cached("SELECT message_id,created_at_ms,attachment_id,object_id FROM chat_attachments
            WHERE workspace_id=?1 AND thread_id=?2 AND (message_id,created_at_ms,attachment_id)>(?3,?4,?5)
            ORDER BY message_id,created_at_ms,attachment_id LIMIT ?6").map_err(sql)?;
        let rows = stmt
            .query_map(
                params![w.ws, w.key, w.message, w.time, w.after, BATCH],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        for (_, _, id, object) in &rows {
            if let Some(object) = object {
                enqueue(c, w, object)?;
            } else {
                publish(c, &w.ws, &w.channel, id)?;
            }
        }
        if let Some((message, time, id, _)) = rows.last() {
            c.execute("UPDATE chat_conversation_file_link_work SET after_message=?2,after_time=?3,after_id=?4 WHERE work_id=?1 AND revision=?5",
                params![w.id,message,time,id,w.revision]).map_err(sql)?;
        }
        if rows.len() < BATCH as usize {
            c.execute("UPDATE chat_conversation_file_link_work SET phase=1,after_id='' WHERE work_id=?1 AND revision=?2",params![w.id,w.revision]).map_err(sql)?;
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
                c.execute("DELETE FROM chat_conversation_file_links WHERE workspace_id=?1 AND channel_id=?2 AND file_key=?3",params![w.ws,w.channel,key]).map_err(sql)?;
            } else {
                enqueue(c, w, key)?;
            }
        }
        if keys.len() < BATCH as usize {
            finish(c, w)?;
        } else if let Some(key) = keys.last() {
            c.execute("UPDATE chat_conversation_file_link_work SET after_id=?2 WHERE work_id=?1 AND revision=?3",params![w.id,key,w.revision]).map_err(sql)?;
        }
    }
    Ok(())
}

/// One transaction processes at most 100 raw coordinates. Only demand enables the actor's scheduler.
pub(crate) fn tick(store: &mut EngineStore) -> Result<bool, StorageError> {
    let work = store.read_with(|c| c.query_row("SELECT work_id,workspace_id,channel_id,kind,key,revision,phase,after_message,after_time,after_id
        FROM chat_conversation_file_link_work ORDER BY work_id LIMIT 1", [], |r| Ok(Work {
            id:r.get(0)?,ws:r.get(1)?,channel:r.get(2)?,kind:r.get(3)?,key:r.get(4)?,revision:r.get(5)?,
            phase:r.get(6)?,message:r.get(7)?,time:r.get(8)?,after:r.get(9)?,
        })).optional().map_err(sql))?;
    if let Some(work) = work {
        store.write_background_with(&NoFaults, |c| repair(c, &work))?;
        return Ok(true);
    }
    let seed: Option<(String,String,String)> = store.read_with(|c| c.query_row(
        "SELECT workspace_id,channel_id,seed_after FROM chat_conversation_file_link_state WHERE seed_phase='scan' ORDER BY workspace_id,channel_id LIMIT 1",
        [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(sql))?;
    let Some((ws, channel, after)) = seed else {
        return Ok(false);
    };
    store.write_background_with(&NoFaults, |c| -> Result<_,StorageError> {
        let mut stmt = c.prepare_cached("SELECT attachment_id FROM chat_attachments WHERE workspace_id=?1 AND attachment_id>?2 ORDER BY attachment_id LIMIT ?3").map_err(sql)?;
        let ids = stmt.query_map(params![ws,after,BATCH], |r| r.get::<_,String>(0)).map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
        for id in &ids { publish(c,&ws,&channel,id)?; }
        c.execute("UPDATE chat_conversation_file_link_state SET seed_after=?3,seed_phase=?4 WHERE workspace_id=?1 AND channel_id=?2",
            params![ws,channel,ids.last().unwrap_or(&after),if ids.len()<BATCH as usize {"ready"} else {"scan"}]).map_err(sql)?;
        Ok(())
    })?;
    Ok(true)
}

impl ActorHandle {
    pub(crate) async fn enable_conversation_links(&self) -> Result<(), RuntimeError> {
        self.request_conversation_links().await
    }
}
