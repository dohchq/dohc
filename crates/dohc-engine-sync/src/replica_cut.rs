//! Sanitized relay-owned current views. Collection selectors confer no read authority.
use crate::{
    PathClass, SyncError, classify_share_path,
    ydoc_apply::{map_collab_hard_error, project_ydoc_with_store},
};
use dohc_engine_collab::{DocKey, durable};
use dohc_engine_storage::text;
use dohc_engine_storage::{EngineStore, hex_sha256, replica::read_frontiers};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[cfg(test)]
#[path = "replica_cut_tests.rs"]
mod tests;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentViewSelector {
    pub version_id: Option<String>,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentViewRequest {
    pub selectors: Vec<CurrentViewSelector>,
    #[serde(default)]
    pub known_text_shas: String,
    #[serde(default)]
    pub position: Option<CurrentViewPosition>,
    #[serde(default)]
    pub cursor: Option<CurrentViewCursor>,
    #[serde(default)]
    pub since: Option<CurrentViewPosition>,
    pub incarnation: String,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentViewPosition {
    pub revision: i64,
    pub log_cursor: i64,
    pub journal_cursor: i64,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentViewCursor {
    pub path: String,
    pub object_id: String,
    pub version_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<usize>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentViewRemoved {
    pub version_id: String,
    pub object_id: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentViewRefusal {
    pub path: String,
    pub object_id: String,
    pub version_id: String,
    pub sha256: String,
    pub reason: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentViewFile {
    pub version_id: String,
    pub object_id: String,
    pub path: String,
    pub content_kind: String,
    pub sha256: String,
    pub byte_length: usize,
    pub lineage_claim_id: Option<String>,
    pub restore_generation: Option<i64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentViewText {
    pub sha256: String,
    pub text: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaCurrentView {
    pub workspace_id: String,
    pub revision: i64,
    pub log_cursor: i64,
    pub journal_cursor: i64,
    pub files: Vec<CurrentViewFile>,
    pub texts: Vec<CurrentViewText>,
    pub moved: bool,
    pub next_cursor: Option<CurrentViewCursor>,
    pub refused_files: Vec<CurrentViewRefusal>,
    pub delta: bool,
    pub removed: Vec<CurrentViewRemoved>,
}

#[derive(Default)]
pub struct CurrentViewCache {
    entries: BTreeMap<(String, String, String), (String, String)>,
    bytes: usize,
    tracking: bool,
    identity: (String, String),
    position: Option<CurrentViewPosition>,
    collecting: Option<CurrentViewPosition>,
    since: Option<CurrentViewPosition>,
    delta: bool,
    manifest: BTreeMap<(String, String), String>,
    pending: BTreeMap<(String, String), String>,
    removed: Vec<CurrentViewRemoved>,
    scenes: BTreeSet<(String, String)>,
}

fn track_touched(conn: &rusqlite::Connection) -> Result<(), SyncError> {
    conn.execute_batch("CREATE TEMP TABLE IF NOT EXISTS replica_cut_touched(workspace TEXT,version TEXT,object TEXT,PRIMARY KEY(workspace,version,object)) WITHOUT ROWID; CREATE TEMP TABLE IF NOT EXISTS replica_cut_collecting(workspace TEXT,version TEXT,object TEXT,PRIMARY KEY(workspace,version,object)) WITHOUT ROWID;").map_err(SyncError::corrupt)?;
    for (table, version) in [
        ("path_aliases", "version_id"),
        ("snapshots", "version_id"),
        ("ydoc_docs", "version_id"),
        ("replica_documents", "main_version_id"),
        ("replica_restore_cancellations", "main_version_id"),
    ] {
        for (event, row) in [("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")] {
            let old = if event == "UPDATE" {
                format!(
                    "INSERT INTO replica_cut_touched VALUES(OLD.workspace_id,OLD.{version},OLD.object_id) ON CONFLICT DO NOTHING;"
                )
            } else {
                String::new()
            };
            conn.execute_batch(&format!("CREATE TEMP TRIGGER IF NOT EXISTS cut_{table}_{event} AFTER {event} ON main.{table} BEGIN {old} INSERT INTO replica_cut_touched VALUES({row}.workspace_id,{row}.{version},{row}.object_id) ON CONFLICT DO NOTHING; END;")).map_err(SyncError::corrupt)?;
        }
    }
    conn.execute_batch("CREATE TEMP TRIGGER IF NOT EXISTS cut_displaced_alias BEFORE INSERT ON main.path_aliases BEGIN INSERT INTO replica_cut_touched SELECT workspace_id,version_id,object_id FROM path_aliases WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND path=NEW.path ON CONFLICT DO NOTHING; END;").map_err(SyncError::corrupt)?;
    Ok(())
}

fn selected(request: &CurrentViewRequest, version: &str, path: &str) -> bool {
    classify_share_path(path) == PathClass::Tracked
        && request.selectors.iter().any(|s| {
            s.version_id.as_deref().unwrap_or("main") == version
                && (s.version_id.is_some() && s.paths.is_empty()
                    || s.paths.iter().any(|p| {
                        path == p
                            || path
                                .strip_prefix(p)
                                .is_some_and(|suffix| suffix.starts_with('/'))
                    }))
        })
}

pub fn collect_current_view(
    store: &EngineStore,
    workspace: &str,
    request: &CurrentViewRequest,
) -> Result<ReplicaCurrentView, SyncError> {
    collect_current_view_cached(store, workspace, request, &mut CurrentViewCache::default())
}

pub fn collect_current_view_cached(
    store: &EngineStore,
    workspace: &str,
    request: &CurrentViewRequest,
    cache: &mut CurrentViewCache,
) -> Result<ReplicaCurrentView, SyncError> {
    if !store.is_passive() {
        return Err(SyncError::InvalidInput {
            reason: "current views require a passive store",
        });
    }
    if request.selectors.iter().any(|s| {
        s.version_id
            .as_deref()
            .is_some_and(|version| !crate::is_valid_share_version_id(version))
            || s.paths
                .iter()
                .any(|p| classify_share_path(p) != PathClass::Tracked)
    }) {
        return Err(SyncError::ShareBoundaryViolation);
    }
    store.read_with(|conn| {
        if !cache.tracking {track_touched(conn)?; cache.tracking=true;}
        let tx = conn.unchecked_transaction().map_err(SyncError::corrupt)?;
        let frontier = read_frontiers(&tx, workspace)?;
        let position = CurrentViewPosition {revision: frontier.revision, log_cursor: frontier.log_cursor, journal_cursor: frontier.journal_cursor};
        if request.cursor.is_some() && request.position.is_none() { return Err(SyncError::InvalidInput {reason: "a current view cursor requires its applied position"}); }
        let identity=(request.incarnation.clone(),serde_json::to_string(&request.selectors).map_err(SyncError::corrupt)?);
        let moved = request.position.as_ref().is_some_and(|p| *p != position) || request.cursor.is_some() && (cache.collecting.as_ref()!=Some(&position) || cache.identity!=identity || cache.since!=request.since);
        if !moved && request.cursor.is_none() {
            cache.delta=cache.position.as_ref().is_some_and(|p| request.since.as_ref()==Some(p)) && cache.identity==identity;
            cache.identity=identity; cache.collecting=Some(position.clone());cache.since=request.since.clone(); cache.pending.clear(); cache.removed.clear();
            tx.execute("INSERT INTO replica_cut_touched SELECT * FROM replica_cut_collecting WHERE workspace=?1 ON CONFLICT DO NOTHING",[workspace]).map_err(SyncError::corrupt)?;
            tx.execute("DELETE FROM replica_cut_collecting WHERE workspace=?1",[workspace]).map_err(SyncError::corrupt)?;
            if cache.delta {
                // Scene projections depend on versioned assets as well as their own head.
                if tx.query_row("SELECT EXISTS(SELECT 1 FROM replica_cut_touched WHERE workspace=?1)",[workspace],|r|r.get::<_,bool>(0)).map_err(SyncError::corrupt)? {
                    for (version,object) in &cache.scenes {tx.execute("INSERT INTO replica_cut_touched VALUES(?1,?2,?3) ON CONFLICT DO NOTHING",params![workspace,version,object]).map_err(SyncError::corrupt)?;}
                }
                let mut stmt=tx.prepare("SELECT version,object FROM replica_cut_touched WHERE workspace=?1").map_err(SyncError::corrupt)?;
                let keys=stmt.query_map([workspace],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(SyncError::corrupt)?;
                for key in keys {
                    let key=key.map_err(SyncError::corrupt)?;
                    if cache.manifest.contains_key(&key) {
                        let path=tx.query_row("SELECT a.path FROM path_aliases a JOIN snapshots s USING(workspace_id,version_id,object_id,path) WHERE a.workspace_id=?1 AND a.version_id=?2 AND a.object_id=?3",params![workspace,key.0,key.1],|r|r.get::<_,String>(0)).optional().map_err(SyncError::corrupt)?;
                        if path.is_none_or(|p| !selected(request,&key.0,&p)) {cache.removed.push(CurrentViewRemoved {version_id:key.0,object_id:key.1});}
                    }
                }
            } else {cache.position=None; cache.manifest.clear();cache.scenes.clear();}
            tx.execute("INSERT INTO replica_cut_collecting SELECT * FROM replica_cut_touched WHERE workspace=?1",[workspace]).map_err(SyncError::corrupt)?;
            tx.execute("DELETE FROM replica_cut_touched WHERE workspace=?1",[workspace]).map_err(SyncError::corrupt)?;
        }
        if request.known_text_shas.len() % 64 != 0 || !request.known_text_shas.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) { return Err(SyncError::InvalidInput {reason: "invalid known current view text digests"}); }
        let mut known: BTreeSet<String> = request.known_text_shas.as_bytes().chunks(64).map(|b| String::from_utf8_lossy(b).into_owned()).collect();
        let mut view = ReplicaCurrentView { workspace_id: workspace.into(), revision: frontier.revision,
            log_cursor: frontier.log_cursor, journal_cursor: frontier.journal_cursor, files: vec![], texts: vec![], moved, next_cursor: None, refused_files: vec![], delta:cache.delta, removed:vec![] };
        if moved { return Ok(view); }
        let header_bytes = serde_json::to_vec(&view).map_err(SyncError::corrupt)?.len() + 128;
        let mut encoded_bytes = header_bytes;
        let mut last = request.cursor.clone();
        for (i,removed) in cache.removed.iter().enumerate().skip(request.cursor.as_ref().and_then(|c|c.removed).unwrap_or(0)) {
            let key=CurrentViewRemoved {version_id:removed.version_id.clone(),object_id:removed.object_id.clone()};
            let size=serde_json::to_vec(&key).map_err(SyncError::corrupt)?.len()+1;
            if encoded_bytes+size>8*1024*1024 || view.removed.len()>=16_000 {
                view.next_cursor=Some(CurrentViewCursor {path:String::new(),object_id:String::new(),version_id:String::new(),removed:Some(i)}); tx.commit().map_err(SyncError::corrupt)?; return Ok(view);
            }
            encoded_bytes+=size; view.removed.push(key);
        }
        if !view.removed.is_empty() {last=Some(CurrentViewCursor{path:String::new(),object_id:String::new(),version_id:String::new(),removed:Some(cache.removed.len())});}
        let from=if cache.delta {"replica_cut_collecting t CROSS JOIN snapshots s ON s.workspace_id=t.workspace AND s.version_id=t.version AND s.object_id=t.object CROSS JOIN path_aliases a ON a.workspace_id=s.workspace_id AND a.version_id=s.version_id AND a.object_id=s.object_id AND a.path=s.path"} else {"path_aliases a JOIN snapshots s ON s.workspace_id=a.workspace_id AND s.version_id=a.version_id AND s.object_id=a.object_id AND s.path=a.path"};
        let filter=if cache.delta {" AND t.workspace=?1"} else {""};
        let mut stmt = tx.prepare(&format!("SELECT a.version_id,a.object_id,a.path,s.content_kind,COALESCE(s.blob_sha256,s.binary_sha256),COALESCE(b.byte_length,bb.byte_length),d.object_id IS NOT NULL,CASE WHEN d.object_id IS NULL THEN 0 ELSE d.settled_update_seq END FROM {from} LEFT JOIN blobs b ON b.sha256=s.blob_sha256 LEFT JOIN binary_blobs bb ON bb.sha256=s.binary_sha256 LEFT JOIN ydoc_docs d ON d.workspace_id=s.workspace_id AND d.version_id=s.version_id AND d.object_id=s.object_id WHERE a.workspace_id=?1 AND (a.version_id,a.path) > (?2,?3){filter} ORDER BY a.version_id,a.path")).map_err(SyncError::corrupt)?;
        let mut rows = stmt.query(params![workspace, request.cursor.as_ref().map_or("", |c| c.version_id.as_str()),request.cursor.as_ref().map_or("", |c| c.path.as_str())]).map_err(SyncError::corrupt)?;
        while let Some(row) = rows.next().map_err(SyncError::corrupt)? {
            let version: String = row.get(0).map_err(SyncError::corrupt)?;
            let path: String = row.get(2).map_err(SyncError::corrupt)?;
            if !selected(request,&version,&path) { continue; }
            let object: String = row.get(1).map_err(SyncError::corrupt)?;

            let key = DocKey::new(workspace, &version, &object).map_err(map_collab_hard_error)?;
            let marker = if row.get::<_,bool>(6).map_err(SyncError::corrupt)? {durable::read_marker_in(&tx, &key).map_err(map_collab_hard_error)?} else {None};
            let scene_key=(version.clone(),object.clone());
            if marker.as_ref().is_some_and(|m|m.content_kind==dohc_engine_collab::ContentKind::Scene) {cache.scenes.insert(scene_key);} else {cache.scenes.remove(&scene_key);}
            let lineage = marker.as_ref().and_then(|m| m.lineage_claim_id.clone());
            // Before its first accepted event a lineage stands at the
            // generation its last cancelled restore reached.
            let generation = if let Some(claim) = &lineage {
                Some(tx.query_row("SELECT COALESCE((SELECT restore_generation FROM replica_documents WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4),(SELECT max(restore_generation) FROM replica_restore_cancellations WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4),1)", params![workspace, version, object, claim], |r| r.get::<_,i64>(0)).map_err(SyncError::corrupt)?)
            } else { None };
            let kind: String = row.get(3).map_err(SyncError::corrupt)?;
            let mut sha: String = row.get(4).map_err(SyncError::corrupt)?;
            let mut len = usize::try_from(row.get::<_,i64>(5).map_err(SyncError::corrupt)?).map_err(SyncError::corrupt)?;
            let mut text: Option<String> = None;
            let settled: i64 = row.get(7).map_err(SyncError::corrupt)?;
            if let Some(marker) = marker && kind == "text" && marker.head_update_seq > settled {
                let cache_key=(workspace.to_string(),version.clone(),object.clone());
                // Scene projections also depend on versioned assets, so their key includes the complete applied revision.
                let position=format!("{}:{}:{}:{lineage:?}:{:?}",marker.head_update_seq,settled,sha,
                    (marker.content_kind==dohc_engine_collab::ContentKind::Scene).then_some(frontier.revision));
                let projected=match cache.entries.get(&cache_key) {
                    Some((saved,content)) if *saved==position=>content.clone(),
                    _=>{
                        let doc=durable::load_doc_in(&tx,&key).map_err(map_collab_hard_error)?;
                        let content=project_ydoc_with_store(&tx,&key,&doc,marker.content_kind)?.content;
                        if cache.bytes+content.len()>64*1024*1024 || cache.entries.len()>=128 {cache.entries.clear();cache.bytes=0;}
                        if content.len()<=64*1024*1024 {
                            if let Some((_,old))=cache.entries.remove(&cache_key) {cache.bytes-=old.len();}
                            cache.bytes+=content.len();cache.entries.insert(cache_key,(position,content.clone()));
                        }
                        content
                    }
                };
                sha=hex_sha256(projected.as_bytes());len=projected.len();text=Some(projected);
            }
            let cursor = CurrentViewCursor {path: path.clone(), object_id: object.clone(), version_id: version.clone(),removed:Some(cache.removed.len())};
            let file = CurrentViewFile {version_id: version, object_id: object, path, content_kind: kind, sha256: sha.clone(), byte_length: len, lineage_claim_id: lineage, restore_generation: generation};
            let object_key=(file.version_id.clone(),file.object_id.clone());
            let encoded=serde_json::to_vec(&file).map_err(SyncError::corrupt)?;
            let fingerprint=hex_sha256(&encoded);
            if cache.delta && cache.manifest.get(&object_key).is_some_and(|saved|*saved==fingerprint) {continue;}
            let file_bytes = encoded.len();
            let cursor_bytes = serde_json::to_vec(&cursor).map_err(SyncError::corrupt)?.len();
            let empty_text_bytes = serde_json::to_vec(&CurrentViewText {sha256: sha.clone(), text: String::new()}).map_err(SyncError::corrupt)?.len();
            let oversized_snapshot = file.content_kind == "text" && text.is_none() && len + empty_text_bytes + file_bytes + header_bytes + cursor_bytes + 2 > 14 * 1024 * 1024;
            let text = if !oversized_snapshot && file.content_kind == "text" && !known.contains(&sha) {
                Some(CurrentViewText {sha256: sha.clone(), text: match text {
                    Some(text) => text,
                    None => text::read(&tx, &sha).map_err(SyncError::corrupt)?,
                }})
            } else {None};
            let size = file_bytes + text.as_ref().map(|t| serde_json::to_vec(t).map(|b| b.len())).transpose().map_err(SyncError::corrupt)?.unwrap_or(0) + 2;
            if oversized_snapshot || size + header_bytes + cursor_bytes > 14 * 1024 * 1024 {
                let refusal = CurrentViewRefusal {path: file.path, object_id: file.object_id, version_id: file.version_id, sha256: file.sha256, reason: "text-frame-limit"};
                let refusal_size = serde_json::to_vec(&refusal).map_err(SyncError::corrupt)?.len() + 1;
                if encoded_bytes + refusal_size + cursor_bytes > 8 * 1024 * 1024 || view.refused_files.len() >= 16_000 {view.next_cursor = last; break;}
                encoded_bytes += refusal_size;
                view.refused_files.push(refusal);
                cache.pending.insert(object_key,fingerprint);
                last = Some(cursor);
                continue;
            }
            if (!view.files.is_empty() || !view.refused_files.is_empty() || !view.removed.is_empty()) && (encoded_bytes + size + cursor_bytes > 8 * 1024 * 1024 || view.files.len() >= 16_000) {view.next_cursor = last; break;}
            encoded_bytes += size;
            if let Some(text) = text { known.insert(sha.clone()); view.texts.push(text); }
            view.files.push(file);
            cache.pending.insert(object_key,fingerprint);
            last = Some(cursor);


        }
        drop(rows); drop(stmt);
        if view.next_cursor.is_none() {
            for key in &cache.removed {cache.manifest.remove(&(key.version_id.clone(),key.object_id.clone()));}
            for (key,value) in std::mem::take(&mut cache.pending) {cache.manifest.insert(key,value);} cache.position=Some(position);
            tx.execute("DELETE FROM replica_cut_collecting WHERE workspace=?1",[workspace]).map_err(SyncError::corrupt)?;
        }
        tx.commit().map_err(SyncError::corrupt)?;
        Ok(view)
    })
}
