use super::{BATCH, sql};
use crate::chat_mentions::{seal_cursor, unseal_cursor};
use crate::{ActorHandle, RuntimeError};
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_storage::{NoFaults, StorageError};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const PURPOSE: &str = "chats.conversations.listLinks";
const BYTES: usize = 64 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Position {
    format: u8,
    version: String,
    subject: String,
    scope: String,
    revision: i64,
    uncovered: i64,
    time: i64,
    id: String,
    key: String,
}
fn invalid() -> RuntimeError {
    StorageError::InvalidInput {
        reason: "invalid conversation links page or cursor",
    }
    .into()
}
fn encode(ws: &str, pos: &Position) -> Result<String, RuntimeError> {
    seal_cursor(ws, PURPOSE, pos)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn read(
    c: &Connection,
    ws: &str,
    channel: &str,
    wire: &str,
    version: &str,
    scope: &str,
    uncovered: i64,
    cursor: Option<String>,
    token: &CancellationToken,
) -> Result<Value, RuntimeError> {
    let (revision,scanning,legacy): (i64,bool,bool) = c.query_row(
        "SELECT revision,seed_phase<>'ready',legacy FROM chat_conversation_file_link_state WHERE workspace_id=?1 AND channel_id=?2",
        params![ws,channel],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(sql)?;
    let mut pos = if let Some(cursor) = cursor {
        unseal_cursor::<Position>(ws, PURPOSE, &cursor)?
    } else {
        Position {
            format: 1,
            version: version.into(),
            subject: wire.into(),
            scope: scope.into(),
            revision,
            uncovered,
            time: i64::MAX,
            id: String::new(),
            key: String::new(),
        }
    };
    if pos.format != 1 || pos.subject != wire {
        return Err(invalid());
    }
    if pos.scope != scope {
        return Err(RuntimeError::ChatMentionAccessChanged);
    }
    if pos.version != version {
        return Err(RuntimeError::ChatMentionVersionChanged);
    }
    if pos.revision != revision {
        return Err(RuntimeError::ChatConversationLinksChanged);
    }
    let (pending,barrier): (bool,bool) = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_conversation_file_link_work WHERE workspace_id=?1 AND channel_id=?2),
        EXISTS(SELECT 1 FROM chat_conversation_file_link_work WHERE workspace_id=?1 AND channel_id=?2 AND kind='thread') OR EXISTS(SELECT 1 FROM chat_conversation_file_link_work WHERE workspace_id=?1 AND channel_id=?2 AND kind='reset')",
        params![ws,channel], |r| Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;
    pos.uncovered = pos.uncovered.max(uncovered);
    let building = scanning || pending;
    let mut page = json!({"versionId":version,"subject":{"channelWireId":wire},"entries":[],"unchecked":[],
        "complete":!building&&!legacy&&pos.uncovered==0,"indexBuilding":building,"mountsCovered":true,
        "sharedChannelRowsUncovered":pos.uncovered,"nextCursor":null});
    if barrier {
        return Ok(page);
    }
    let columns="SELECT file_key,attachment_id,thread_id,message_id,mentioned_at_ms FROM chat_conversation_file_links
        WHERE workspace_id=?1 AND channel_id=?2 AND invalid=0";
    let query = if pos.key.is_empty() {
        format!(
            "{columns} ORDER BY mentioned_at_ms DESC,attachment_id DESC,file_key DESC LIMIT 101"
        )
    } else {
        format!(
            "{columns} AND (mentioned_at_ms,attachment_id,file_key)<(?3,?4,?5) ORDER BY mentioned_at_ms DESC,attachment_id DESC,file_key DESC LIMIT 101"
        )
    };
    let mut stmt = c.prepare_cached(&query).map_err(sql)?;
    let mut args = vec![
        rusqlite::types::Value::Text(ws.into()),
        channel.to_owned().into(),
    ];
    if !pos.key.is_empty() {
        args.extend([
            pos.time.into(),
            pos.id.clone().into(),
            pos.key.clone().into(),
        ]);
    }
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    let mut more = rows.len() > BATCH as usize;
    let mut reserve = serde_json::to_vec(&pos).map_err(|_| invalid())?.len();
    for (key, id, _, _, time) in &rows {
        let mut next = pos.clone();
        next.key = key.clone();
        next.id = id.clone();
        next.time = *time;
        reserve = reserve.max(serde_json::to_vec(&next).map_err(|_| invalid())?.len());
    }
    let mut bytes = page.to_string().len() + reserve.div_ceil(3) * 4 + 256;
    let mut count = 0;
    for (key, id, thread, message, time) in rows.into_iter().take(BATCH as usize) {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if let Some(entry) = hydrate(c, ws, channel, version, &key, &id, &thread, &message, time)? {
            let size = entry.to_string().len() + 1;
            if bytes + size > BYTES {
                if count == 0 {
                    return Err(invalid());
                }
                more = true;
                break;
            }
            page["entries"].as_array_mut().expect("entries").push(entry);
            bytes += size;
            count += 1;
        }
        pos.time = time;
        pos.id = id;
        pos.key = key;
    }
    if more {
        page["nextCursor"] = json!(encode(ws, &pos)?);
    }
    if page.to_string().len() > BYTES {
        return Err(invalid());
    }
    Ok(page)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn hydrate(
    c: &Connection,
    ws: &str,
    channel: &str,
    version: &str,
    key: &str,
    id: &str,
    thread: &str,
    message: &str,
    time: i64,
) -> Result<Option<Value>, RuntimeError> {
    let path: Option<String>=c.prepare_cached(
    "SELECT path FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 ORDER BY path LIMIT 1").map_err(sql)?.query_row(
    params![ws,version,key],|r| r.get(0)).optional().map_err(sql)?;
    if let Some(path) = path {
        let author: Option<Value>=c.prepare_cached(
        "SELECT m.author_kind,substr(m.author_display_name,1,100),m.author_owner_display_name,m.author_user_id,m.author_actor_key,
                m.link_grant_id,m.link_principal_id
         FROM chat_messages m JOIN chat_threads t ON t.workspace_id=m.workspace_id AND t.thread_id=m.thread_id
         JOIN chat_channels ch ON ch.workspace_id=t.workspace_id AND ch.channel_id=t.channel_id
         WHERE m.workspace_id=?1 AND m.message_id=?2 AND m.thread_id=?3 AND t.channel_id=?4").map_err(sql)?.query_row(
        params![ws,message,thread,channel],|r| {
            let mut author=json!({"authorKind":r.get::<_,String>(0)?,"authorDisplayName":r.get::<_,String>(1)?});
            for (index,name) in [(2,"authorOwnerDisplayName"),(3,"authorUserId"),(4,"authorActorKey"),
                (5,"linkGrantId"),(6,"linkPrincipalId")] {
                if let Some(value)=r.get::<_,Option<String>>(index)? { author[name]=json!(value); }
            }
            Ok(author)
        }).optional().map_err(sql)?;
        if let Some(author) = author {
            let folder = path
                .rsplit_once('/')
                .map(|(folder, _)| folder)
                .unwrap_or("");
            return Ok(Some(
                json!({"file":{"objectId":key,"path":path,"folder":folder},
            "attachmentId":id,"threadId":thread,"messageId":message,"mentionedAtMs":time,"author":author}),
            ));
        }
    }
    Ok(None)
}

impl ActorHandle {
    /// Engine-only facts. Main must authorize the conversation and each file before adding any production door.
    pub async fn conversation_file_links_page(
        &self,
        ws: String,
        wire: String,
        scope: String,
        uncovered: i64,
        cursor: Option<String>,
        token: CancellationToken,
    ) -> Result<Value, RuntimeError> {
        if wire.is_empty()
            || wire.len() > 500
            || scope.is_empty()
            || scope.len() > 256
            || uncovered < 0
        {
            return Err(invalid());
        }
        self.enable_conversation_links().await?;
        self.run(move |store,_| {
            if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
            if store.is_passive() {return Err(invalid());}
            let channel: Option<String>=store.read_with(|c| c.query_row(
                "SELECT ch.channel_id FROM chat_channel_wire_ids w JOIN chat_channels ch ON ch.workspace_id=w.workspace_id AND ch.channel_id=w.channel_id
                 WHERE w.workspace_id=?1 AND w.wire_id=?2 AND NOT EXISTS(SELECT 1 FROM chat_channel_placeholders p WHERE p.workspace_id=ch.workspace_id AND p.channel_id=ch.channel_id)",
                params![ws,wire],|r| r.get(0)).optional().map_err(sql))?;
            let Some(channel)=channel else {return Ok(Value::Null);};
            let exists: bool=store.read_with(|c| c.query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_conversation_file_link_state WHERE workspace_id=?1 AND channel_id=?2)",params![ws,channel],|r| r.get(0)).map_err(sql))?;
            if !exists {
                store.write_with(&NoFaults,|c| c.execute(
                    "INSERT INTO chat_conversation_file_link_state(workspace_id,channel_id) VALUES(?1,?2)",params![ws,channel]).map_err(sql))?;
            }
            let version=VersionedTextStore::new(store).get_active_version(&ws)?.version_id;
            store.read_with(|c| {
                let snapshot=c.unchecked_transaction().map_err(sql)?;
                let page=read(c,&ws,&channel,&wire,&version,&scope,uncovered,cursor,&token)?;
                snapshot.commit().map_err(sql)?;
                Ok(page)
            })
        }).await
    }
}
