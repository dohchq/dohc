use crate::links::query::cursor_key;
use crate::{ActorHandle, RuntimeError};
use dohc_engine_crypto::{SealedSecret, open, seal};
use dohc_engine_domain::{DomainError, FileResolution, FileResolveTarget, VersionedTextStore};
use dohc_engine_storage::StorageError;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const PURPOSE: &str = "chats.attachments.listFileMentions";
const WORK: usize = 512;
const RECORDS: usize = 100;
const BYTES: usize = 64 * 1024;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Position {
    phase: u8,
    key: String,
    time: i64,
    id: String,
    finished: bool,
    incomplete: bool,
    uncovered: i64,
}
fn invalid() -> RuntimeError {
    StorageError::InvalidInput {
        reason: "invalid chat file mention cursor or metadata",
    }
    .into()
}
pub(crate) fn seal_cursor<T: Serialize>(
    ws: &str,
    purpose: &str,
    payload: &T,
) -> Result<String, RuntimeError> {
    let bytes = serde_json::to_vec(payload).map_err(|_| invalid())?;
    let sealed = seal(cursor_key()?, ws, purpose, &bytes).map_err(|_| invalid())?;
    Ok(json!([
        sealed.iv_base64(),
        sealed.auth_tag_base64(),
        sealed.ciphertext_base64(),
        sealed.byte_length()
    ])
    .to_string())
}
pub(crate) fn unseal_cursor<T: for<'de> Deserialize<'de>>(
    ws: &str,
    purpose: &str,
    cursor: &str,
) -> Result<T, RuntimeError> {
    if cursor.len() > 32768 {
        return Err(invalid_cursor());
    }
    let (iv, tag, body, len): (String, String, String, usize) =
        serde_json::from_str(cursor).map_err(|_| invalid_cursor())?;
    let sealed = SealedSecret::from_base64(&iv, &tag, &body, len).map_err(|_| invalid_cursor())?;
    let bytes = open(cursor_key()?, ws, purpose, &sealed).map_err(|_| invalid_cursor())?;
    serde_json::from_slice(bytes.as_bytes()).map_err(|_| invalid_cursor())
}
fn encode(
    ws: &str,
    version: &str,
    subject: &Value,
    scope: &str,
    pos: &Position,
) -> Result<String, RuntimeError> {
    seal_cursor(ws, PURPOSE, &(1, version, subject, scope, pos))
}
fn invalid_cursor() -> RuntimeError {
    DomainError::InvalidInput {
        reason: "invalid chat file mention cursor",
    }
    .into()
}
fn decode(
    ws: &str,
    version: &str,
    subject: &Value,
    scope: &str,
    cursor: Option<String>,
) -> Result<Position, RuntimeError> {
    let Some(cursor) = cursor else {
        return Ok(Position {
            finished: true,
            ..Default::default()
        });
    };
    let (format, v, s, a, pos): (u8, String, Value, String, Position) =
        unseal_cursor(ws, PURPOSE, &cursor)?;
    if format != 1 || s != *subject || pos.phase > 1 {
        return Err(invalid_cursor());
    }
    if a != scope {
        return Err(RuntimeError::ChatMentionAccessChanged);
    }
    if v != version {
        return Err(RuntimeError::ChatMentionVersionChanged);
    }
    Ok(pos)
}
#[derive(Clone)]
struct Attachment {
    id: String,
    thread: String,
    message: String,
    object: Option<String>,
    path: Option<String>,
    heading: Option<String>,
    anchor: Option<String>,
    occurrence: Option<i64>,
    time: i64,
}
fn short(value: String, max: usize) -> String {
    value.chars().take(max).collect()
}

fn next_key_sql(column: &str) -> String {
    format!(
        "SELECT {column} FROM chat_attachments WHERE workspace_id=?1 AND {column}>?2 ORDER BY {column} LIMIT 1"
    )
}
fn window_sql(column: &str, after: bool) -> String {
    let columns = "attachment_id,thread_id,message_id,object_id,path_hint,heading_text,heading_anchor,heading_occurrence,created_at_ms";
    let seek = if after {
        " AND (created_at_ms,attachment_id)<(?4,?5)"
    } else {
        ""
    };
    format!(
        "SELECT {columns} FROM chat_attachments WHERE workspace_id=?1 AND {column}=?2{seek} ORDER BY created_at_ms DESC,attachment_id DESC LIMIT ?3"
    )
}

fn raw_window(
    c: &rusqlite::Connection,
    ws: &str,
    subject: &Value,
    after: &Position,
    token: &CancellationToken,
) -> Result<(Vec<(Attachment, Position)>, bool), RuntimeError> {
    let mut pos = after.clone();
    let mut window = Vec::new();
    while pos.phase < 2 {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        let column = if pos.phase == 0 {
            "object_id"
        } else {
            "path_hint"
        };
        let subject_key = if pos.phase == 0 {
            subject["objectId"].as_str()
        } else {
            subject["path"].as_str()
        };
        if pos.finished {
            let key: Option<String> = if let Some(key) = subject_key {
                if pos.key.is_empty() {
                    Some(key.into())
                } else {
                    None
                }
            } else {
                c.query_row(&next_key_sql(column), params![ws, pos.key], |r| r.get(0))
                    .optional()
                    .map_err(|_| invalid())?
            };
            let Some(key) = key else {
                pos.phase += 1;
                pos.key.clear();
                pos.id.clear();
                continue;
            };
            pos.key = key;
            pos.id.clear();
            pos.time = i64::MAX;
            pos.finished = false;
        }
        let sql = window_sql(column, !pos.id.is_empty());
        let mut stmt = c.prepare_cached(&sql).map_err(|_| invalid())?;
        let map = |r: &rusqlite::Row<'_>| {
            Ok(Attachment {
                id: r.get(0)?,
                thread: r.get(1)?,
                message: r.get(2)?,
                object: r.get(3)?,
                path: r.get(4)?,
                heading: r.get(5)?,
                anchor: r.get(6)?,
                occurrence: r.get(7)?,
                time: r.get(8)?,
            })
        };
        let limit = (WORK - window.len() + 1) as i64;
        let rows = if pos.id.is_empty() {
            stmt.query_map(params![ws, pos.key, limit], map)
        } else {
            stmt.query_map(params![ws, pos.key, limit, pos.time, pos.id], map)
        }
        .map_err(|_| invalid())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid())?;
        let count = rows.len();
        for row in rows {
            if window.len() == WORK {
                return Ok((window, true));
            }
            pos.time = row.time;
            pos.id = row.id.clone();
            window.push((row, pos.clone()));
        }
        if count < limit as usize {
            pos.finished = true;
        }
    }
    Ok((window, false))
}

impl ActorHandle {
    /// Each page visits at most 512 raw attachments, before filtering or hydration.
    pub async fn chat_file_mentions_page(
        &self,
        ws: String,
        subject: Option<FileResolveTarget>,
        scope: String,
        uncovered: i64,
        cursor: Option<String>,
        token: CancellationToken,
    ) -> Result<Value, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
            let (version, subject) = if let Some(target) = subject {
                let (version, rows) = VersionedTextStore::new(store).resolve_files(&ws, None, &[target])?;
                let subject = match rows.into_iter().next() {
                    Some(FileResolution::Found { object_id, path, .. }) => json!({"objectId":object_id,"path":path}),
                    Some(FileResolution::Invalid) => return Err(invalid()),
                    _ => return Ok(Value::Null),
                };
                (version, subject)
            } else {
                (VersionedTextStore::new(store).get_active_version(&ws)?.version_id, Value::Null)
            };
            let mut pos = decode(&ws, &version, &subject, &scope, cursor)?;
            pos.uncovered = pos.uncovered.max(uncovered);
            pos.incomplete |= pos.uncovered > 0;
            store.read_with(|c| -> Result<_, RuntimeError> {
                let transaction = c.unchecked_transaction().map_err(|_| invalid())?;
                let mut page = json!({"versionId":version,"subject":subject,"entries":[],"unchecked":[],
                    "complete":!pos.incomplete,"indexBuilding":false,"mountsCovered":true,
                    "sharedChannelRowsUncovered":pos.uncovered,"nextCursor":null});
                let (rows, mut more) = raw_window(c, &ws, &subject, &pos, &token)?;
                // Reserve the longest possible continuation in this bounded window.
                // Base64 adds four bytes per three plaintext bytes. The fixed allowance
                // covers IV, tag, length and the escaped JSON envelope without sealing.
                let cursor_bytes = std::iter::once(&pos).chain(rows.iter().map(|(_, next)| next))
                    .map(|next| serde_json::to_vec(&(1, &version, &subject, &scope, next))
                        .map(|bytes| bytes.len()).map_err(|_| invalid()))
                    .collect::<Result<Vec<_>, _>>()?.into_iter().max().unwrap_or(0)
                    .div_ceil(3) * 4 + 256;
                let mut bytes = page.to_string().len() + cursor_bytes;
                let mut records = 0;
                for (row, next) in rows {
                    if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
                    // Path windows include object-backed rows, which must not emit twice.
                    if next.phase == 1 && row.object.is_some() { pos = next; continue; }
                    let file: Option<(String,String)> = if let Some(object) = &row.object {
                        c.query_row("SELECT object_id,path FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 ORDER BY path LIMIT 1",
                            params![ws,version,object], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_| invalid())?
                    } else if let Some(path) = &row.path {
                        c.query_row("SELECT object_id,path FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND path=?3",
                            params![ws,version,path], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_| invalid())?
                    } else { None };
                    let Some((object,path)) = file else { pos = next; continue; };
                    if let Some(entry) = compact_entry(c, &ws, &row, &object, &path)? {
                        let size = entry.to_string().len() + 1;
                        if records == RECORDS || bytes + size > BYTES {
                            if records == 0 { return Err(invalid()); }
                            more = true;
                            break;
                        }
                        bytes += size;
                        page["entries"].as_array_mut().expect("entries").push(entry);
                        records += 1;
                    }
                    pos = next;
                }
                if more { page["nextCursor"] = json!(encode(&ws,&version,&subject,&scope,&pos)?); }
                transaction.commit().map_err(|_| invalid())?;
                Ok(page)
            })
        }).await
    }
}

fn compact_entry(
    c: &rusqlite::Connection,
    ws: &str,
    row: &Attachment,
    object: &str,
    path: &str,
) -> Result<Option<Value>, RuntimeError> {
    c.query_row(
        "SELECT m.author_display_name,substr(m.body,1,480),m.created_at_ms,
            t.title,t.created_at_ms,t.updated_at_ms,t.channel_id,ch.name,ch.slug,ch.kind,
            (SELECT wire_id FROM chat_channel_wire_ids w WHERE w.workspace_id=t.workspace_id AND w.channel_id=t.channel_id ORDER BY wire_id LIMIT 1)
         FROM chat_messages m JOIN chat_threads t ON t.workspace_id=m.workspace_id AND t.thread_id=m.thread_id
         LEFT JOIN chat_channels ch ON ch.workspace_id=t.workspace_id AND ch.channel_id=t.channel_id
         WHERE m.workspace_id=?1 AND m.message_id=?2 AND m.thread_id=?3",
        params![ws,row.message,row.thread], |r| {
            let channel: Option<String> = r.get(6)?;
            let name: Option<String> = r.get(7)?;
            if channel.is_some() && name.is_none() { return Ok(None); }
            let mut attachment = json!({"attachmentId":row.id,"messageId":row.message,"threadId":row.thread,
                "targetKind":"file","objectId":object,"pathHint":path,"createdAtMs":row.time});
            for (key,value) in [("headingText",row.heading.as_ref()),("headingAnchor",row.anchor.as_ref())] {
                if let Some(value) = value { attachment[key] = json!(value); }
            }
            if let Some(value) = row.occurrence { attachment["headingOccurrence"] = json!(value); }
            let mut entry = json!({"attachment":attachment,
                "message":{"id":row.message,"authorDisplayName":short(r.get(0)?,100),"preview":short(r.get(1)?,480),"createdAtMs":r.get::<_,i64>(2)?},
                "thread":{"id":row.thread,"title":short(r.get(3)?,300),"createdAtMs":r.get::<_,i64>(4)?,"updatedAtMs":r.get::<_,i64>(5)?}});
            if let Some(channel) = channel {
                entry["channelId"] = json!(channel);
                entry["channelName"] = json!(short(name.unwrap_or_default(),100));
                entry["channelSlug"] = json!(r.get::<_,String>(8)?);
                entry["channelKind"] = json!(r.get::<_,String>(9)?);
                if let Some(wire) = r.get::<_,Option<String>>(10)? { entry["channelWireId"] = json!(wire); }
            }
            Ok(Some(entry))
        }).optional().map_err(|_| invalid()).map(Option::flatten)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_is_bound_to_workspace_version_subject_authority_and_purpose() {
        let subject = json!({"objectId":"file","path":"a.md"});
        let cursor = encode("ws", "main", &subject, "grant-1", &Position::default()).unwrap();
        assert!(decode("ws", "main", &subject, "grant-1", Some(cursor.clone())).is_ok());
        for (ws, v, s, a) in [
            ("other", "main", subject.clone(), "grant-1"),
            ("ws", "other", subject.clone(), "grant-1"),
            ("ws", "main", Value::Null, "grant-1"),
            ("ws", "main", subject.clone(), "grant-2"),
        ] {
            assert!(decode(ws, v, &s, a, Some(cursor.clone())).is_err());
        }
        let (iv, tag, body, len): (String, String, String, usize) =
            serde_json::from_str(&cursor).unwrap();
        let sealed = SealedSecret::from_base64(&iv, &tag, &body, len).unwrap();
        assert!(open(cursor_key().unwrap(), "ws", "links.in", &sealed).is_err());
        assert!(
            decode(
                "ws",
                "main",
                &subject,
                "grant-1",
                Some(format!("{cursor}x"))
            )
            .is_err()
        );
    }
    #[test]
    fn cursor_changes_distinguish_restartable_access_and_version_from_invalid_input() {
        let subject = Value::Null;
        let cursor = encode("ws", "main", &subject, "grant-1", &Position::default()).unwrap();
        assert!(matches!(
            decode("ws", "main", &subject, "grant-2", Some(cursor.clone())),
            Err(RuntimeError::ChatMentionAccessChanged)
        ));
        assert!(matches!(
            decode("ws", "captured", &subject, "grant-1", Some(cursor.clone())),
            Err(RuntimeError::ChatMentionVersionChanged)
        ));
        assert!(matches!(
            decode(
                "ws",
                "main",
                &json!({"path":"other.md"}),
                "grant-1",
                Some(cursor)
            ),
            Err(RuntimeError::Domain(DomainError::InvalidInput { .. }))
        ));
    }
    #[test]
    fn traversal_windows_seek_existing_indexes_without_sorting() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE chat_attachments(workspace_id TEXT, attachment_id TEXT, thread_id TEXT, message_id TEXT, object_id TEXT, path_hint TEXT, heading_text TEXT, heading_anchor TEXT, heading_occurrence INTEGER, created_at_ms INTEGER);
            CREATE INDEX idx_chat_attachments_file_object ON chat_attachments(workspace_id,object_id,created_at_ms DESC,attachment_id DESC);
            CREATE INDEX idx_chat_attachments_file_path ON chat_attachments(workspace_id,path_hint,created_at_ms DESC,attachment_id DESC);").unwrap();
        for (column, index) in [
            ("object_id", "idx_chat_attachments_file_object"),
            ("path_hint", "idx_chat_attachments_file_path"),
        ] {
            for (sql, args) in [
                (
                    next_key_sql(column),
                    vec![
                        rusqlite::types::Value::Text("ws".into()),
                        rusqlite::types::Value::Text("key".into()),
                    ],
                ),
                (
                    window_sql(column, false),
                    vec![
                        rusqlite::types::Value::Text("ws".into()),
                        rusqlite::types::Value::Text("key".into()),
                        rusqlite::types::Value::Integer(513),
                    ],
                ),
                (
                    window_sql(column, true),
                    vec![
                        rusqlite::types::Value::Text("ws".into()),
                        rusqlite::types::Value::Text("key".into()),
                        rusqlite::types::Value::Integer(513),
                        rusqlite::types::Value::Integer(9),
                        rusqlite::types::Value::Text("id".into()),
                    ],
                ),
            ] {
                let mut stmt = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
                let plan = stmt
                    .query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(3))
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap()
                    .join(" ");
                assert!(plan.contains(index), "{plan}");
                assert!(
                    !plan.contains("SCAN") && !plan.contains("TEMP B-TREE"),
                    "{plan}"
                );
            }
        }
    }
}
