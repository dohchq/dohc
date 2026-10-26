use super::{
    PARSER_GENERATION, cache,
    query::{cursor_key, invalid, resolve},
    sql,
};
use crate::{ActorHandle, RuntimeError};
use dohc_engine_crypto::{SealedSecret, open, seal};
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_storage::StorageError;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const RECORDS: usize = 100;
const OCCURRENCES: usize = 512;
const BYTES: usize = 64 * 1024;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Position {
    path: String,
    object: String,
    key: Option<String>,
    emitted: bool,
    ordinal: i64,
    finished: bool,
    incomplete: bool,
    building: bool,
}
fn encode(ws: &str, version: &str, position: &Position) -> Result<String, RuntimeError> {
    let bytes = serde_json::to_vec(&(1, "edges", version, position)).map_err(|_| invalid())?;
    let sealed = seal(cursor_key()?, ws, "links.edges", &bytes).map_err(|_| invalid())?;
    Ok(json!([
        sealed.iv_base64(),
        sealed.auth_tag_base64(),
        sealed.ciphertext_base64(),
        sealed.byte_length()
    ])
    .to_string())
}
fn decode(ws: &str, version: &str, cursor: Option<String>) -> Result<Position, RuntimeError> {
    let Some(cursor) = cursor else {
        return Ok(Position {
            ordinal: -1,
            finished: true,
            ..Default::default()
        });
    };
    if cursor.len() > 32768 {
        return Err(invalid());
    }
    let (iv, tag, body, length): (String, String, String, usize) =
        serde_json::from_str(&cursor).map_err(|_| invalid())?;
    let sealed = SealedSecret::from_base64(&iv, &tag, &body, length).map_err(|_| invalid())?;
    let plain = open(cursor_key()?, ws, "links.edges", &sealed).map_err(|_| invalid())?;
    let (format, purpose, v, position): (u8, String, String, Position) =
        serde_json::from_slice(plain.as_bytes()).map_err(|_| invalid())?;
    if format != 1 || purpose != "edges" || v != version {
        return Err(invalid());
    }
    Ok(position)
}

struct Source {
    path: String,
    object: String,
    title: String,
    key: Option<String>,
    rows: Vec<(i64, String, String)>,
    more: bool,
}
fn markdown(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "md" | "markdown" | "mdx"
    )
}
fn corrupt() -> StorageError {
    StorageError::InvalidInput {
        reason: "invalid or stale links.edges cursor or metadata",
    }
}

impl ActorHandle {
    pub async fn link_edges(
        &self,
        ws: String,
        cursor: Option<String>,
        token: CancellationToken,
    ) -> Result<Value, RuntimeError> {
        let workspace = ws.clone();
        let cache = self.link_resolvers.clone();
        let actor_token = token.clone();
        let (version, after, sources, more, building, paths) = self.run(move |store, _| {
            if actor_token.is_cancelled() { return Err(RuntimeError::Cancelled); }
            let version = VersionedTextStore::new(store).get_active_version(&ws)?.version_id;
            let after = decode(&ws, &version, cursor)?;
            store.read_with(|c| -> Result<_, RuntimeError> {
                let snapshot = c.unchecked_transaction().map_err(sql)?;
                let ready: bool = c.query_row(
                    "SELECT coalesce((SELECT seed_phase='ready' AND parser_generation=?3 FROM link_index_state WHERE workspace_id=?1 AND version_id=?2),0) AND NOT EXISTS(SELECT 1 FROM link_pending WHERE workspace_id=?1 AND version_id=?2)",
                    params![ws, version, PARSER_GENERATION], |r| r.get(0)).map_err(sql)?;
                // Separate equality and range seeks keep both on the authoritative primary key.
                let columns = "SELECT a.path,a.object_id,s.title,s.index_key,s.path,s.parser_generation,s.status,p.revision
                     FROM path_aliases a LEFT JOIN link_sources s ON s.workspace_id=a.workspace_id AND s.version_id=a.version_id AND s.object_id=a.object_id
                     LEFT JOIN link_pending p ON p.workspace_id=a.workspace_id AND p.version_id=a.version_id AND p.object_id=a.object_id
                     WHERE a.workspace_id=?1 AND a.version_id=?2 AND ";
                let read_source = |r: &rusqlite::Row<'_>| {
                    let path: String = r.get(0)?;
                    let indexed: Option<String> = r.get(4)?;
                    let usable = indexed.as_ref() == Some(&path)
                        && r.get::<_,Option<i64>>(5)? == Some(PARSER_GENERATION)
                        && r.get::<_,Option<String>>(6)?.as_deref() == Some("indexed")
                        && r.get::<_,Option<i64>>(7)?.is_none();
                    Ok(Source { path, object: r.get(1)?, title: r.get::<_,Option<String>>(2)?.unwrap_or_default(),
                        key: if usable { r.get(3)? } else { None }, rows: Vec::new(), more: false })
                };
                let mut aliases = Vec::new();
                if !after.finished {
                    let mut stmt = c.prepare_cached(&format!("{columns}a.path=?3")).map_err(sql)?;
                    aliases = stmt.query_map(params![ws,version,after.path],read_source).map_err(sql)?
                        .collect::<Result<Vec<_>,_>>().map_err(sql)?;
                    if aliases.first().is_none_or(|s| s.object != after.object || s.key != after.key) { return Err(RuntimeError::LinksEdgesSourceChanged); }
                }
                let mut stmt = c.prepare_cached(&format!("{columns}a.path>?3 ORDER BY a.path LIMIT ?4")).map_err(sql)?;
                aliases.extend(stmt.query_map(params![ws,version,after.path,(101-aliases.len()) as i64],read_source).map_err(sql)?
                    .collect::<Result<Vec<_>,_>>().map_err(sql)?);
                let alias_count = aliases.len();
                let mut sources = Vec::new();
                let mut remaining = OCCURRENCES + 1;
                for mut source in aliases.into_iter().take(RECORDS) {
                    if actor_token.is_cancelled() { return Err(RuntimeError::Cancelled); }
                    if source.path.len() > 4096 || source.object.len() > 500 || source.title.encode_utf16().count() > 640 { return Err(corrupt().into()); }
                    if markdown(&source.path) && let Some(key) = &source.key {
                        let ordinal = if source.path == after.path && !after.finished { after.ordinal } else { -1 };
                        let mut stmt = c.prepare_cached("SELECT ordinal,literal,kind FROM links WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND index_key=?4 AND ordinal>?5 ORDER BY ordinal LIMIT ?6").map_err(sql)?;
                        source.rows = stmt.query_map(params![ws,version,source.object,key,ordinal,remaining as i64], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))
                            .map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
                        source.more = source.rows.len() == remaining;
                        remaining -= source.rows.len();
                    }
                    sources.push(source);
                    if remaining == 0 { break; }
                }
                let more = sources.len() < alias_count;
                let paths = cache::prepare(c, &cache, &ws, &version)?;
                snapshot.commit().map_err(sql)?;
                Ok((version.clone(), after.clone(), sources, more, !ready || after.building, paths))
            })
        }).await?;
        tokio::task::spawn_blocking(move || {
            if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
            let resolver = paths.build();
            let mut last = after.clone();
            last.building = building;
            last.incomplete |= building;
            let mut page = json!({"versionId":version,"files":[],"entries":[],"unchecked":[],
                "complete":!last.incomplete,"indexBuilding":building,"mountsCovered":true,"nextCursor":null});
            // Reserve independent field maxima, including JSON escaping, with one seal.
            let longest = |field: fn(&Source) -> &String, previous: &String| {
                sources.iter().map(field).chain(std::iter::once(previous))
                    .max_by_key(|s| json!(s).to_string().len()).expect("cursor field").clone()
            };
            let key = sources.iter().filter_map(|s| s.key.as_ref()).chain(after.key.iter())
                .max_by_key(|s| json!(s).to_string().len()).cloned();
            let reserve = json!(encode(&workspace, &version, &Position {
                path:longest(|s| &s.path, &after.path), object:longest(|s| &s.object, &after.object), key,
                emitted:false, ordinal:i64::MAX, finished:false, incomplete:false, building:false,
            })?).to_string().len() + 8;
            let mut bytes = page.to_string().len() + reserve;
            let mut records = 0;
            let mut examined = 0;
            let mut stopped = false;
            let mut add = |page: &mut Value, array: &str, row: Value| {
                let size = row.to_string().len() + 1;
                if records == RECORDS || bytes + size > BYTES { return false; }
                bytes += size;
                records += 1;
                page[array].as_array_mut().expect("array").push(row);
                true
            };
            'sources: for source in sources {
                if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
                if source.path != last.path || last.finished {
                    last = Position { path:source.path.clone(), object:source.object.clone(), key:source.key.clone(),
                        ordinal:-1,incomplete:last.incomplete,building,..Default::default() };
                }
                if !markdown(&source.path) { last.finished = true; continue; }
                if !last.emitted {
                    let title = if source.title.is_empty() { source.path.rsplit('/').next().unwrap_or(&source.path) } else { &source.title };
                    if !add(&mut page,"files",json!({"path":source.path,"objectId":source.object,"title":title})) { stopped=true; break; }
                    last.emitted = true;
                }
                if source.key.is_none() {
                    last.incomplete = true;
                    if !add(&mut page,"unchecked",json!(source.path)) { stopped=true; break; }
                    last.finished = true;
                    continue;
                }
                for (ordinal,literal,kind) in source.rows {
                    if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
                    if examined == OCCURRENCES { stopped=true; break 'sources; }
                    examined += 1;
                    let target = resolve(&resolver, &source.path, &literal, &kind);
                    if let Some(target) = target.filter(|t| *t != source.path)
                        && !add(&mut page,"entries",json!({"source":source.path,"target":target,"kind":kind,"ordinal":ordinal})) {
                            stopped=true; break 'sources;
                        }
                    last.ordinal = ordinal;
                }
                last.finished = !source.more;
                if source.more { stopped=true; break; }
            }
            if stopped && last.path == after.path && last.emitted == after.emitted && last.ordinal == after.ordinal && last.finished == after.finished { return Err(invalid()); }
            page["complete"] = json!(!last.incomplete);
            if stopped || more { page["nextCursor"] = json!(encode(&workspace,&version,&last)?); }
            if page.to_string().len() > BYTES { return Err(invalid()); }
            Ok(page)
        }).await.map_err(|_| invalid())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursors_have_their_own_workspace_version_and_purpose() {
        let cursor = encode("ws", "main", &Position::default()).unwrap();
        assert!(decode("other", "main", Some(cursor.clone())).is_err());
        assert!(decode("ws", "other", Some(cursor.clone())).is_err());
        assert!(
            super::super::query::decode_cursor("ws", "main", "", Some(cursor.clone())).is_err()
        );
        assert!(decode("ws", "main", Some(cursor)).is_ok());
        let incoming = super::super::query::encode_cursor(
            "ws",
            "main",
            "target",
            &("a.md".into(), 1, true, false),
        )
        .unwrap();
        assert!(decode("ws", "main", Some(incoming)).is_err());
    }
}
