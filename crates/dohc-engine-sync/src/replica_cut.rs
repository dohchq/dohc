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

#[derive(Debug, Clone, Deserialize)]
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
}

#[derive(Default)]
pub struct CurrentViewCache {
    entries: BTreeMap<(String, String, String), (String, String)>,
    bytes: usize,
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
        let tx = conn.unchecked_transaction().map_err(SyncError::corrupt)?;
        let frontier = read_frontiers(&tx, workspace)?;
        let position = CurrentViewPosition {revision: frontier.revision, log_cursor: frontier.log_cursor, journal_cursor: frontier.journal_cursor};
        if request.cursor.is_some() && request.position.is_none() { return Err(SyncError::InvalidInput {reason: "a current view cursor requires its applied position"}); }
        let moved = request.position.as_ref().is_some_and(|p| *p != position);
        if request.known_text_shas.len() % 64 != 0 || !request.known_text_shas.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) { return Err(SyncError::InvalidInput {reason: "invalid known current view text digests"}); }
        let mut known: BTreeSet<String> = request.known_text_shas.as_bytes().chunks(64).map(|b| String::from_utf8_lossy(b).into_owned()).collect();
        let mut view = ReplicaCurrentView { workspace_id: workspace.into(), revision: frontier.revision,
            log_cursor: frontier.log_cursor, journal_cursor: frontier.journal_cursor, files: vec![], texts: vec![], moved, next_cursor: None, refused_files: vec![] };
        if moved { return Ok(view); }
        let header_bytes = serde_json::to_vec(&view).map_err(SyncError::corrupt)?.len() + 128;
        let mut encoded_bytes = header_bytes;
        let mut last = request.cursor.clone();
        let mut stmt = tx.prepare("SELECT a.version_id,a.object_id,a.path,s.content_kind,COALESCE(s.blob_sha256,s.binary_sha256),COALESCE(b.byte_length,bb.byte_length) FROM path_aliases a JOIN snapshots s ON s.workspace_id=a.workspace_id AND s.version_id=a.version_id AND s.object_id=a.object_id AND s.path=a.path LEFT JOIN blobs b ON b.sha256=s.blob_sha256 LEFT JOIN binary_blobs bb ON bb.sha256=s.binary_sha256 WHERE a.workspace_id=?1 AND (a.version_id,a.path) > (?2,?3) ORDER BY a.version_id,a.path").map_err(SyncError::corrupt)?;
        let mut rows = stmt.query(params![workspace, request.cursor.as_ref().map_or("", |c| c.version_id.as_str()),request.cursor.as_ref().map_or("", |c| c.path.as_str())]).map_err(SyncError::corrupt)?;
        while let Some(row) = rows.next().map_err(SyncError::corrupt)? {
            let version: String = row.get(0).map_err(SyncError::corrupt)?;
            let path: String = row.get(2).map_err(SyncError::corrupt)?;
            if classify_share_path(&path) != PathClass::Tracked || !request.selectors.iter().any(|s| s.version_id.as_deref().unwrap_or("main") == version && (s.version_id.is_some() && s.paths.is_empty() || s.paths.iter().any(|p| path == *p || path.starts_with(&format!("{p}/"))))) { continue; }
            let object: String = row.get(1).map_err(SyncError::corrupt)?;

            let key = DocKey::new(workspace, &version, &object).map_err(map_collab_hard_error)?;
            let marker = durable::read_marker_in(&tx, &key).map_err(map_collab_hard_error)?;
            let lineage = marker.as_ref().and_then(|m| m.lineage_claim_id.clone());
            let generation = if let Some(claim) = &lineage {
                tx.query_row("SELECT restore_generation FROM replica_documents WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4", params![workspace, version, object, claim], |r| r.get::<_,i64>(0)).optional().map_err(SyncError::corrupt)?.or(Some(1))
            } else { None };
            let kind: String = row.get(3).map_err(SyncError::corrupt)?;
            let mut sha: String = row.get(4).map_err(SyncError::corrupt)?;
            let mut len = usize::try_from(row.get::<_,i64>(5).map_err(SyncError::corrupt)?).map_err(SyncError::corrupt)?;
            let mut text: Option<String> = None;
            let settled: i64 = tx.query_row("SELECT settled_update_seq FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![workspace,version,object],|r|r.get(0)).optional().map_err(SyncError::corrupt)?.unwrap_or(0);
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
            let cursor = CurrentViewCursor {path: path.clone(), object_id: object.clone(), version_id: version.clone()};
            let file = CurrentViewFile {version_id: version, object_id: object, path, content_kind: kind, sha256: sha.clone(), byte_length: len, lineage_claim_id: lineage, restore_generation: generation};
            let file_bytes = serde_json::to_vec(&file).map_err(SyncError::corrupt)?.len();
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
                last = Some(cursor);
                continue;
            }
            if (!view.files.is_empty() || !view.refused_files.is_empty()) && (encoded_bytes + size + cursor_bytes > 8 * 1024 * 1024 || view.files.len() >= 16_000) {view.next_cursor = last; break;}
            encoded_bytes += size;
            if let Some(text) = text { known.insert(sha.clone()); view.texts.push(text); }
            view.files.push(file);
            last = Some(cursor);


        }
        drop(rows); drop(stmt);
        tx.commit().map_err(SyncError::corrupt)?;
        Ok(view)
    })
}
