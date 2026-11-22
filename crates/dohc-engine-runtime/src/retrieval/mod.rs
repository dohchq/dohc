//! Unified workspace retrieval: ranked hybrid lexical + structured + 1-hop graph
//! recall across pages, document collections, typed records, transactional
//! dataset pointers, and chats.

mod graph;
pub mod rank;
pub mod text;

#[cfg(test)]
mod tests;

use crate::actor::{ActorHandle, HeldReader};
use crate::error::RuntimeError;
use crate::links::cache;
use crate::links::resolver::Resolver;
use crate::search::SearchError;
use crate::search::index::{
    display_title_for, ensure_search_index_for_version, is_search_index_certified,
};
use crate::search::policy::{
    SearchPolicySnapshot, path_is_search_indexed, read_engine_search_policy,
};
use dohc_engine_domain::{VersionedTextStore, parse_collection_schema};
use dohc_engine_files::search_text::extract_search_text;
use dohc_engine_storage::text as blob_text;
use dohc_engine_storage::{NoFaults, StorageError};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

use self::graph::expand_graph_neighborhood;
use self::rank::{RRF_K, ScoreDocument, rrf_fuse, score_document_bm25f};
use self::text::{
    MAX_SNIPPET_CHARS, MAX_TITLE_CHARS, ParsedQuery, collapse_whitespace, escape_like_pattern,
    extract_best_snippet, extract_markdown_heading, fallback_title_from_path, fts_match_and,
    fts_match_or, normalize_filter_prefix, parse_query, path_matches_prefix,
    redact_file_references, render_field_value_json, strip_markdown_frontmatter, truncate_chars,
};

pub const DEFAULT_RETRIEVAL_LIMIT: usize = 15;
pub const MAX_RETRIEVAL_LIMIT: usize = 50;
pub const MAX_RETRIEVAL_RESPONSE_BYTES: usize = 64 * 1024;
pub const RECEIVED_SHARE_RETRIEVAL_REFUSAL: &str =
    "received shares do not support workspace retrieval";

const RESPONSE_BUDGET_HEADROOM_BYTES: usize = 512;
const FTS_AND_CANDIDATE_CAP: usize = 100;
const FTS_OR_CANDIDATE_CAP: usize = 160;
const PATH_METADATA_CANDIDATE_CAP: usize = 120;
const RECORD_FIELD_CANDIDATE_CAP: usize = 120;
const COLLECTION_SCAN_CAP: usize = 500;
const RECORD_COUNT_SCAN_CAP: usize = 10_000;
const DATASET_SCAN_CAP: usize = 100;
const DATASET_TEXT_CAP_BYTES: i64 = 256 * 1024;
const DATASET_MAX_TABLES: usize = 64;
const DATASET_MAX_FIELDS: usize = 128;
const DATASET_MAX_OPERATIONS: usize = 128;
const DATASET_EMITTED_FIELDS_CAP: usize = 64;
const CHAT_FTS_CANDIDATE_CAP: usize = 160;
const CHAT_METADATA_CANDIDATE_CAP: usize = 60;
const CHAT_BODY_CAP_BYTES: i64 = 72 * 1024;
const CHAT_COMBINED_BODY_CAP_BYTES: usize = 128 * 1024;
const SHORT_QUERY_FILE_SCAN_CAP: usize = 2000;
const SHORT_QUERY_CHAT_SCAN_CAP: usize = 1000;
const CANDIDATE_TEXT_CAP_BYTES: i64 = 256 * 1024;
pub(crate) const SCHEMA_TEXT_CAP_BYTES: i64 = 64 * 1024;
const TOTAL_HYDRATED_BYTES_BUDGET: usize = 8 * 1024 * 1024;
const MAX_MATCHED_FIELDS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetrievalKind {
    Page,
    Collection,
    Record,
    Chat,
}

impl RetrievalKind {
    fn sort_rank(self) -> u8 {
        match self {
            Self::Collection => 0,
            Self::Record => 1,
            Self::Page => 2,
            Self::Chat => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetrievalCollectionKind {
    Document,
    Transactional,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetrievalEdgeKind {
    Wikilink,
    Markdown,
    Relation,
    ChatLinkedFile,
    ChatMention,
    CollectionMember,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetrievalEdgeDirection {
    Out,
    In,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetrievalRequest {
    pub query: String,
    pub surfaces: Option<Vec<RetrievalKind>>,
    pub path_prefix: Option<String>,
    pub collection_path: Option<String>,
    pub include_neighbors: bool,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalMatchedField {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalRelatedEdge {
    pub kind: RetrievalKind,
    pub edge: RetrievalEdgeKind,
    pub direction: RetrievalEdgeDirection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalHit {
    pub id: String,
    pub kind: RetrievalKind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_kind: Option<RetrievalCollectionKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dataset_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_fields: Option<Vec<RetrievalMatchedField>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_wire_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_file_path: Option<String>,
    pub snippet: String,
    pub matched_terms: Vec<String>,
    pub related: Vec<RetrievalRelatedEdge>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalNeighborVia {
    pub from_id: String,
    pub from_title: String,
    pub edge: RetrievalEdgeKind,
    pub direction: RetrievalEdgeDirection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalNeighbor {
    pub id: String,
    pub kind: RetrievalKind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    pub via: Vec<RetrievalNeighborVia>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalResponse {
    pub version_id: String,
    pub results: Vec<RetrievalHit>,
    pub neighbors: Vec<RetrievalNeighbor>,
    pub complete: bool,
    pub index_building: bool,
    pub policy_degraded: bool,
    pub mounts_covered: bool,
    pub shared_channel_rows_uncovered: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct LiveFileHead {
    pub object_id: String,
    pub path: String,
    pub blob_sha256: Option<String>,
}

pub(crate) fn resolve_live_file_head(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<Option<LiveFileHead>, SearchError> {
    if policy.is_degraded() {
        return Ok(None);
    }
    let path: Option<String> = conn
        .prepare_cached(
            "SELECT path FROM path_aliases \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
             ORDER BY path LIMIT 1",
        )?
        .query_row(params![workspace_id, version_id, object_id], |row| {
            row.get(0)
        })
        .optional()?;
    let Some(path) = path else {
        return Ok(None);
    };
    if !path_is_search_indexed(policy, &path) {
        return Ok(None);
    }
    let head: Option<(Option<String>, Option<String>)> = conn
        .prepare_cached(
            "SELECT content_kind, blob_sha256 FROM ( \
               SELECT content_kind, blob_sha256, 0 AS prio \
               FROM snapshots \
               WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
               UNION ALL \
               SELECT content_kind, blob_sha256, 1 AS prio \
               FROM fork_base_snapshots \
               WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
                 AND NOT EXISTS ( \
                   SELECT 1 FROM snapshots s \
                   WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.object_id = ?3 \
                 ) \
             ) ORDER BY prio LIMIT 1",
        )?
        .query_row(params![workspace_id, version_id, object_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    let Some((content_kind, blob_sha256)) = head else {
        return Ok(None);
    };
    if content_kind.as_deref() == Some("binary") {
        return Ok(None);
    }
    Ok(Some(LiveFileHead {
        object_id: object_id.to_owned(),
        path,
        blob_sha256,
    }))
}

pub(crate) fn resolve_live_file_head_by_path(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<LiveFileHead>, SearchError> {
    if policy.is_degraded() || !path_is_search_indexed(policy, path) {
        return Ok(None);
    }
    let object_id: Option<String> = conn
        .prepare_cached(
            "SELECT object_id FROM path_aliases \
             WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
        )?
        .query_row(params![workspace_id, version_id, path], |row| row.get(0))
        .optional()?;
    let Some(object_id) = object_id else {
        return Ok(None);
    };
    resolve_live_file_head(conn, policy, workspace_id, version_id, &object_id)
}

pub(crate) enum BlobLoad {
    Text(String),
    Oversized,
    Missing,
}

pub(crate) fn load_file_body_status(
    conn: &Connection,
    blob_sha256: Option<&str>,
    cap_bytes: i64,
) -> Result<BlobLoad, SearchError> {
    let Some(sha256) = blob_sha256 else {
        return Ok(BlobLoad::Missing);
    };
    match blob_text::capped(conn, sha256, cap_bytes) {
        Ok((_, _, Some(text))) => Ok(BlobLoad::Text(text)),
        Ok((recorded_len, actual_len, None))
            if recorded_len > cap_bytes || actual_len > cap_bytes =>
        {
            Ok(BlobLoad::Oversized)
        }
        Ok((_, _, None)) => Ok(BlobLoad::Missing),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(BlobLoad::Missing),
        Err(error) => Err(SearchError::from(error)),
    }
}

pub(crate) fn load_file_body_capped(
    conn: &Connection,
    blob_sha256: Option<&str>,
    cap_bytes: i64,
) -> Result<Option<String>, SearchError> {
    match load_file_body_status(conn, blob_sha256, cap_bytes)? {
        BlobLoad::Text(text) => Ok(Some(text)),
        BlobLoad::Oversized | BlobLoad::Missing => Ok(None),
    }
}

fn is_sqlite_interrupted(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(ffi_err, _)
            if ffi_err.code == rusqlite::ErrorCode::OperationInterrupted
    )
}

fn is_storage_interrupted(err: &StorageError) -> bool {
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(err);
    while let Some(current) = source {
        if let Some(sql_err) = current.downcast_ref::<rusqlite::Error>()
            && is_sqlite_interrupted(sql_err)
        {
            return true;
        }
        source = current.source();
    }
    false
}

fn map_runtime_or_cancelled(err: RuntimeError, token: &CancellationToken) -> RuntimeError {
    if token.is_cancelled() {
        return RuntimeError::Cancelled;
    }
    match &err {
        RuntimeError::Cancelled => RuntimeError::Cancelled,
        RuntimeError::Search(SearchError::Storage(sql_err)) if is_sqlite_interrupted(sql_err) => {
            RuntimeError::Cancelled
        }
        RuntimeError::Search(SearchError::Store(storage_err))
            if is_storage_interrupted(storage_err) =>
        {
            RuntimeError::Cancelled
        }
        RuntimeError::Storage(storage_err) if is_storage_interrupted(storage_err) => {
            RuntimeError::Cancelled
        }
        _ => err,
    }
}

fn is_received_share_store(conn: &Connection, workspace_id: &str) -> Result<bool, SearchError> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM share_view_cursors WHERE workspace_id = ?1)",
        params![workspace_id],
        |row| row.get(0),
    )?)
}

fn query_validation_error(raw: &str) -> &'static str {
    let trimmed = raw.trim_matches(dohc_engine_domain::is_js_trim_ws);
    if trimmed.is_empty() || trimmed.chars().count() > text::MAX_RETRIEVAL_QUERY_CHARS {
        "retrieval query must be 1 to 512 non-whitespace characters"
    } else {
        "retrieval query must contain at least one letter or digit"
    }
}

pub(crate) fn redact_text_for_policy(
    text: &str,
    source_path: Option<&str>,
    policy: &SearchPolicySnapshot,
    resolver: Option<&Resolver>,
) -> String {
    if !text.contains("[[") && !text.contains("](") && !text.contains("@[") {
        return text.to_owned();
    }
    let policy_degraded = policy.is_degraded();
    let src = source_path.unwrap_or("");
    redact_file_references(
        text,
        |target| {
            if policy_degraded {
                return false;
            }
            let target_path = target.split('#').next().unwrap_or(target).trim();
            if target_path.is_empty() {
                return true;
            }
            if let Some(res) = resolver
                && let Some(resolved) = res.resolve(src, target_path)
            {
                return path_is_search_indexed(policy, resolved);
            }
            let candidate = target_path.trim_start_matches('/');
            let with_md = if candidate.contains('.') {
                candidate.to_owned()
            } else {
                format!("{candidate}.md")
            };
            path_is_search_indexed(policy, candidate) && path_is_search_indexed(policy, &with_md)
        },
        |target| {
            if policy_degraded {
                return false;
            }
            let target_path = target.split('#').next().unwrap_or(target).trim();
            if target_path.is_empty() {
                return true;
            }
            if let Some(res) = resolver
                && let Some(resolved) = res.resolve_markdown(src, target_path)
            {
                return path_is_search_indexed(policy, resolved);
            }
            let normalized = target_path.trim_start_matches("./").trim_start_matches('/');
            path_is_search_indexed(policy, normalized)
        },
        |target| {
            if policy_degraded {
                return false;
            }
            let target_path = target.split('#').next().unwrap_or(target).trim();
            if target_path.is_empty() {
                return true;
            }
            if let Some(res) = resolver
                && let Some(resolved) = res.resolve("", target_path)
            {
                return path_is_search_indexed(policy, resolved);
            }
            let normalized = target_path.trim_start_matches("./").trim_start_matches('/');
            path_is_search_indexed(policy, normalized)
        },
    )
}

pub(crate) fn resolve_live_file_title(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    resolver: Option<&Resolver>,
    workspace_id: &str,
    version_id: &str,
    head: &LiveFileHead,
    preloaded_body: Option<&str>,
) -> Result<String, SearchError> {
    let link_title: Option<String> = match head.blob_sha256.as_deref() {
        Some(source_hash) => conn
            .prepare_cached(
                "SELECT s.title FROM link_sources s \
                 WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.object_id = ?3 \
                   AND s.status = 'indexed' AND s.source_hash = ?4 \
                   AND NOT EXISTS(SELECT 1 FROM link_pending p \
                                  WHERE p.workspace_id = s.workspace_id \
                                    AND p.version_id = s.version_id \
                                    AND p.object_id = s.object_id)",
            )?
            .query_row(
                params![workspace_id, version_id, head.object_id, source_hash],
                |row| row.get(0),
            )
            .optional()?,
        None => None,
    };

    let raw_title = if let Some(title) = link_title.filter(|t| !t.trim().is_empty()) {
        title
    } else if let Some(body) = preloaded_body {
        extract_markdown_heading(body).unwrap_or_else(|| fallback_title_from_path(&head.path))
    } else {
        let fetched = load_file_body_capped(conn, head.blob_sha256.as_deref(), 16 * 1024)?;
        fetched
            .as_deref()
            .map(|text| extract_search_text(&head.path, text))
            .as_deref()
            .and_then(extract_markdown_heading)
            .unwrap_or_else(|| fallback_title_from_path(&head.path))
    };

    let redacted = redact_text_for_policy(&raw_title, Some(&head.path), policy, resolver);
    let cleaned = collapse_whitespace(&redacted);
    if cleaned.is_empty() {
        Ok(fallback_title_from_path(&head.path))
    } else {
        Ok(truncate_chars(&cleaned, MAX_TITLE_CHARS))
    }
}

struct SurfaceMask {
    page: bool,
    collection: bool,
    record: bool,
    chat: bool,
}

impl SurfaceMask {
    fn from_request(req: &RetrievalRequest, collection_filter: Option<&str>) -> Self {
        let mut mask = match &req.surfaces {
            None => Self {
                page: true,
                collection: true,
                record: true,
                chat: true,
            },
            Some(list) => Self {
                page: list.contains(&RetrievalKind::Page),
                collection: list.contains(&RetrievalKind::Collection),
                record: list.contains(&RetrievalKind::Record),
                chat: list.contains(&RetrievalKind::Chat),
            },
        };
        if collection_filter.is_some() {
            mask.page = false;
            mask.chat = false;
        }
        mask
    }

    fn wants_any_file_surface(&self) -> bool {
        self.page || self.collection || self.record
    }
}

struct ScoredCandidate {
    hit: RetrievalHit,
    bm25f_score: f64,
}

struct CandidatePool {
    items: HashMap<String, ScoredCandidate>,
    file_fts_order: Vec<String>,
    chat_fts_order: Vec<String>,
    scan_saturated: bool,
    hydrated_bytes: usize,
}

impl CandidatePool {
    fn new() -> Self {
        Self {
            items: HashMap::new(),
            file_fts_order: Vec::new(),
            chat_fts_order: Vec::new(),
            scan_saturated: false,
            hydrated_bytes: 0,
        }
    }

    fn record_file_fts_rank(&mut self, id: &str) {
        self.file_fts_order.push(id.to_owned());
    }

    fn record_chat_fts_rank(&mut self, id: &str) {
        self.chat_fts_order.push(id.to_owned());
    }

    fn insert_or_improve(&mut self, candidate: ScoredCandidate) {
        if let Some(existing) = self.items.get_mut(&candidate.hit.id) {
            if candidate.bm25f_score > existing.bm25f_score {
                *existing = candidate;
            }
        } else {
            self.items.insert(candidate.hit.id.clone(), candidate);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn prepare_retrieval_on_actor(
    store: &mut dohc_engine_storage::EngineStore,
    root_for_actor: &Path,
    ws: &str,
    link_cache: &std::sync::Arc<std::sync::Mutex<cache::Cache>>,
    now_ms: i64,
    allow_index_build: bool,
    actor_token: &CancellationToken,
) -> Result<(String, bool, Option<cache::Prepared>), RuntimeError> {
    if actor_token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let received = store.read_with(|conn| is_received_share_store(conn, ws))?;
    if received {
        return Err(StorageError::InvalidInput {
            reason: RECEIVED_SHARE_RETRIEVAL_REFUSAL,
        }
        .into());
    }
    let version_id = VersionedTextStore::new(store)
        .get_active_version(ws)?
        .version_id;
    let policy = read_engine_search_policy(root_for_actor);
    let is_passive = store.is_passive();
    let is_read_only = store.pages_checked().is_none();

    let certified =
        store.read_with(|conn| is_search_index_certified(conn, &policy, ws, &version_id))?;

    let mut index_building = false;
    if !certified {
        if allow_index_build && !is_passive && !is_read_only {
            let cancel = actor_token.clone();
            let _ = store.hooks_with(|conn| {
                conn.progress_handler(1000, Some(move || cancel.is_cancelled()))
            });
            let rebuild_res = store.mutate_with_connection(|conn| {
                ensure_search_index_for_version(
                    conn,
                    root_for_actor,
                    ws,
                    &version_id,
                    now_ms,
                    &NoFaults,
                )
            });
            let _ = store.hooks_with(|conn| conn.progress_handler(0, None::<fn() -> bool>));
            rebuild_res?;
        } else {
            index_building = true;
        }
    }

    let prepared = if !policy.is_degraded() {
        Some(store.read_with(|conn| cache::prepare(conn, link_cache, ws, &version_id))?)
    } else {
        None
    };

    Ok((version_id, index_building, prepared))
}

impl ActorHandle {
    pub async fn retrieve_workspace(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        request: RetrievalRequest,
        now_ms: i64,
        allow_index_build: bool,
        token: CancellationToken,
    ) -> Result<RetrievalResponse, RuntimeError> {
        if parse_query(&request.query).is_none() {
            return Err(StorageError::InvalidInput {
                reason: query_validation_error(&request.query),
            }
            .into());
        }
        normalize_filter_prefix(request.path_prefix.as_deref())
            .map_err(|reason| StorageError::InvalidInput { reason })?;
        normalize_filter_prefix(request.collection_path.as_deref())
            .map_err(|reason| StorageError::InvalidInput { reason })?;

        let ws = workspace_id.clone();
        let root_for_actor = root_dir.clone();
        let link_cache = self.link_resolvers.clone();
        let actor_token = token.clone();

        let (version_id, search_index_building, prepared_resolver) = self
            .run(move |store, _| -> Result<_, RuntimeError> {
                prepare_retrieval_on_actor(
                    store,
                    &root_for_actor,
                    &ws,
                    &link_cache,
                    now_ms,
                    allow_index_build,
                    &actor_token,
                )
                .map_err(|err| map_runtime_or_cancelled(err, &actor_token))
            })
            .await?;

        let held = self.location();
        tokio::task::spawn_blocking(move || {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let mut store = HeldReader::open(held)?;
            let resolver = prepared_resolver.map(cache::Prepared::build);
            let cancel = token.clone();
            let _ = store.hooks_with(|conn| {
                conn.progress_handler(1000, Some(move || cancel.is_cancelled()))
            });
            let read_result = store
                .read_with(|conn| -> Result<RetrievalResponse, RuntimeError> {
                    let snapshot = conn
                        .unchecked_transaction()
                        .map_err(StorageError::corrupt_public)?;
                    let response = retrieve_workspace_on_conn(
                        conn,
                        &root_dir,
                        &workspace_id,
                        &version_id,
                        &request,
                        resolver.as_deref(),
                        search_index_building,
                        &token,
                    )?;
                    snapshot.commit().map_err(StorageError::corrupt_public)?;
                    Ok(response)
                })
                .map_err(|err| map_runtime_or_cancelled(err, &token));
            let _ = store.hooks_with(|conn| conn.progress_handler(0, None::<fn() -> bool>));
            read_result
        })
        .await
        .map_err(|_| RuntimeError::Storage(StorageError::StateCorrupt { source: None }))?
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn retrieve_workspace_on_conn(
    conn: &Connection,
    root_dir: &Path,
    workspace_id: &str,
    version_id: &str,
    request: &RetrievalRequest,
    resolver: Option<&Resolver>,
    search_index_building: bool,
    token: &CancellationToken,
) -> Result<RetrievalResponse, RuntimeError> {
    retrieve_workspace_on_conn_inner(
        conn,
        root_dir,
        workspace_id,
        version_id,
        request,
        resolver,
        search_index_building,
        token,
    )
    .map_err(|err| map_runtime_or_cancelled(err, token))
}

#[allow(clippy::too_many_arguments)]
fn retrieve_workspace_on_conn_inner(
    conn: &Connection,
    root_dir: &Path,
    workspace_id: &str,
    version_id: &str,
    request: &RetrievalRequest,
    resolver: Option<&Resolver>,
    search_index_building: bool,
    token: &CancellationToken,
) -> Result<RetrievalResponse, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    if is_received_share_store(conn, workspace_id)? {
        return Err(StorageError::InvalidInput {
            reason: RECEIVED_SHARE_RETRIEVAL_REFUSAL,
        }
        .into());
    }

    let Some(parsed_query) = parse_query(&request.query) else {
        return Err(StorageError::InvalidInput {
            reason: query_validation_error(&request.query),
        }
        .into());
    };

    let path_prefix = normalize_filter_prefix(request.path_prefix.as_deref())
        .map_err(|reason| StorageError::InvalidInput { reason })?;
    let collection_filter = normalize_filter_prefix(request.collection_path.as_deref())
        .map_err(|reason| StorageError::InvalidInput { reason })?;

    let limit = request.limit.clamp(1, MAX_RETRIEVAL_LIMIT);
    let mask = SurfaceMask::from_request(request, collection_filter.as_deref());
    let policy = read_engine_search_policy(root_dir);
    let policy_degraded = policy.is_degraded();

    let owned_resolver;
    let active_resolver: Option<&Resolver> = if policy_degraded {
        None
    } else {
        match resolver {
            Some(existing) => Some(existing),
            None => {
                let paths = Resolver::paths_for_version(conn, workspace_id, version_id)?;
                owned_resolver = Resolver::new(paths);
                Some(&owned_resolver)
            }
        }
    };

    let mut pool = CandidatePool::new();

    if !policy_degraded && mask.wants_any_file_surface() {
        if mask.collection {
            collect_document_collections(
                conn,
                &policy,
                active_resolver,
                workspace_id,
                version_id,
                &parsed_query,
                path_prefix.as_deref(),
                collection_filter.as_deref(),
                &mut pool,
                token,
            )?;
            collect_transactional_datasets(
                conn,
                &policy,
                workspace_id,
                version_id,
                &parsed_query,
                path_prefix.as_deref(),
                collection_filter.as_deref(),
                &mut pool,
                token,
            )?;
        }
        if mask.page || mask.record {
            collect_file_and_record_candidates(
                conn,
                &policy,
                active_resolver,
                workspace_id,
                version_id,
                &parsed_query,
                &mask,
                path_prefix.as_deref(),
                collection_filter.as_deref(),
                &mut pool,
                token,
            )?;
        }
    }

    if mask.chat {
        collect_chat_candidates(
            conn,
            &policy,
            active_resolver,
            workspace_id,
            version_id,
            &parsed_query,
            path_prefix.as_deref(),
            &mut pool,
            token,
        )?;
    }

    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }

    let mut bm25f_ranked: Vec<(String, f64)> = pool
        .items
        .iter()
        .map(|(id, candidate)| (id.clone(), candidate.bm25f_score))
        .collect();
    bm25f_ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let bm25f_ids: Vec<String> = bm25f_ranked.into_iter().map(|(id, _)| id).collect();

    let file_fts_ids: Vec<String> = pool
        .file_fts_order
        .iter()
        .filter(|id| pool.items.contains_key(id.as_str()))
        .cloned()
        .collect();
    let chat_fts_ids: Vec<String> = pool
        .chat_fts_order
        .iter()
        .filter(|id| pool.items.contains_key(id.as_str()))
        .cloned()
        .collect();

    let fused = rrf_fuse(
        &[
            (&bm25f_ids, 1.5),
            (&file_fts_ids, 1.0),
            (&chat_fts_ids, 1.0),
        ],
        RRF_K,
    );

    let mut ranked: Vec<(f64, RetrievalHit)> = pool
        .items
        .into_iter()
        .map(|(id, candidate)| {
            let rrf_score = fused.get(&id).copied().unwrap_or(0.0);
            let tie_score = rrf_score + (candidate.bm25f_score * 1e-4);
            (tie_score, candidate.hit)
        })
        .collect();

    ranked.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| b.1.matched_terms.len().cmp(&a.1.matched_terms.len()))
            .then_with(|| a.1.kind.sort_rank().cmp(&b.1.kind.sort_rank()))
            .then_with(|| a.1.id.cmp(&b.1.id))
    });

    let mut results: Vec<RetrievalHit> =
        ranked.into_iter().take(limit).map(|(_, hit)| hit).collect();

    let (mut neighbors, links_building) =
        if request.include_neighbors && !results.is_empty() && !policy_degraded {
            let active = active_resolver.expect("resolver built when policy is not degraded");
            let outcome = expand_graph_neighborhood(
                conn,
                &policy,
                workspace_id,
                version_id,
                active,
                &parsed_query,
                &mut results,
                token,
            )?;
            (outcome.neighbors, outcome.links_building)
        } else {
            (Vec::new(), false)
        };

    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }

    let index_building = search_index_building || links_building;
    let mut response = RetrievalResponse {
        version_id: version_id.to_owned(),
        results,
        neighbors: std::mem::take(&mut neighbors),
        complete: false,
        index_building,
        policy_degraded,
        mounts_covered: true,
        shared_channel_rows_uncovered: 0,
        truncated: false,
    };

    enforce_response_byte_budget(&mut response);
    response.complete = !response.index_building
        && !response.policy_degraded
        && !response.truncated
        && !pool.scan_saturated
        && response.shared_channel_rows_uncovered == 0;

    Ok(response)
}

fn enforce_response_byte_budget(response: &mut RetrievalResponse) {
    let target_bytes = MAX_RETRIEVAL_RESPONSE_BYTES - RESPONSE_BUDGET_HEADROOM_BYTES;
    while serde_json::to_vec(response)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
        > target_bytes
    {
        response.truncated = true;
        if response.neighbors.pop().is_some() {
            continue;
        }
        if response.results.len() > 1 {
            response.results.pop();
            continue;
        }
        if let Some(first) = response.results.first_mut() {
            if !first.related.is_empty() {
                first.related.pop();
                continue;
            }
            if first.snippet.chars().count() > 80 {
                first.snippet = truncate_chars(&first.snippet, 80);
                continue;
            }
        }
        response.results.clear();
        break;
    }
}

fn append_path_prefix_sql(
    bind_values: &mut Vec<rusqlite::types::Value>,
    column: &str,
    prefix: &str,
) -> String {
    let eq_idx = bind_values.len() + 1;
    let lo_idx = eq_idx + 1;
    let hi_idx = eq_idx + 2;
    bind_values.push(rusqlite::types::Value::Text(prefix.to_owned()));
    bind_values.push(rusqlite::types::Value::Text(format!("{prefix}/")));
    bind_values.push(rusqlite::types::Value::Text(format!("{prefix}0")));
    format!("({column} = ?{eq_idx} OR ({column} >= ?{lo_idx} AND {column} < ?{hi_idx}))")
}

#[allow(clippy::too_many_arguments)]
fn collect_document_collections(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    resolver: Option<&Resolver>,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
    path_prefix: Option<&str>,
    collection_filter: Option<&str>,
    pool: &mut CandidatePool,
    token: &CancellationToken,
) -> Result<(), RuntimeError> {
    let mut bind_values: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Text(workspace_id.to_owned()),
        rusqlite::types::Value::Text(version_id.to_owned()),
    ];
    let mut extra = String::new();
    if let Some(filter) = collection_filter {
        let idx = bind_values.len() + 1;
        bind_values.push(rusqlite::types::Value::Text(filter.to_owned()));
        extra.push_str(&format!(" AND collection_path = ?{idx}"));
    }
    if let Some(prefix) = path_prefix {
        let coll_clause = append_path_prefix_sql(&mut bind_values, "collection_path", prefix);
        let schema_clause = append_path_prefix_sql(&mut bind_values, "schema_path", prefix);
        extra.push_str(&format!(" AND ({coll_clause} OR {schema_clause})"));
    }
    let limit_idx = bind_values.len() + 1;
    bind_values.push(rusqlite::types::Value::Integer(COLLECTION_SCAN_CAP as i64));
    let sql = format!(
        "SELECT collection_path, schema_path FROM collections \
         WHERE workspace_id = ?1 AND version_id = ?2{extra} \
         ORDER BY collection_path LIMIT ?{limit_idx}"
    );
    let mut stmt = conn.prepare(&sql).map_err(SearchError::from)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(bind_values), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(SearchError::from)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(SearchError::from)?;

    if rows.len() >= COLLECTION_SCAN_CAP {
        pool.scan_saturated = true;
    }

    for (collection_path, schema_path) in rows {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if let Some(filter) = collection_filter
            && collection_path != filter
        {
            continue;
        }
        if let Some(prefix) = path_prefix
            && !path_matches_prefix(&collection_path, prefix)
            && !path_matches_prefix(&schema_path, prefix)
        {
            continue;
        }
        let Some(head) =
            resolve_live_file_head_by_path(conn, policy, workspace_id, version_id, &schema_path)?
        else {
            continue;
        };
        let schema_yaml = match load_file_body_status(
            conn,
            head.blob_sha256.as_deref(),
            SCHEMA_TEXT_CAP_BYTES,
        )? {
            BlobLoad::Text(text) => text,
            BlobLoad::Oversized => {
                pool.scan_saturated = true;
                continue;
            }
            BlobLoad::Missing => String::new(),
        };
        let parsed = parse_collection_schema(&schema_yaml);
        let schema = parsed.schema;

        let fallback_title = collection_path
            .rsplit('/')
            .next()
            .unwrap_or(&collection_path)
            .to_owned();
        let title = schema
            .name
            .as_deref()
            .map(|name| redact_text_for_policy(name, Some(&schema_path), policy, resolver))
            .map(|name| collapse_whitespace(&name))
            .filter(|name| !name.is_empty())
            .map(|name| truncate_chars(&name, MAX_TITLE_CHARS))
            .unwrap_or_else(|| truncate_chars(&fallback_title, MAX_TITLE_CHARS));

        let field_names: Vec<String> = schema
            .fields
            .iter()
            .map(|field| field.name().to_owned())
            .collect();

        let mut field_search_parts: Vec<String> = field_names.clone();
        for field in &schema.fields {
            match field {
                dohc_engine_domain::FieldDefinition::Select { options, .. }
                | dohc_engine_domain::FieldDefinition::MultiSelect { options, .. } => {
                    field_search_parts.extend(options.iter().cloned());
                }
                dohc_engine_domain::FieldDefinition::Relation { collection, .. } => {
                    field_search_parts.push(collection.clone());
                }
                _ => {}
            }
        }
        let raw_description = schema.description.unwrap_or_default();
        let description =
            redact_text_for_policy(&raw_description, Some(&schema_path), policy, resolver);
        let doc = ScoreDocument {
            title: title.clone(),
            path: collection_path.clone(),
            fields_text: field_search_parts.join(" "),
            body: format!("collection {description}"),
        };
        let scored = score_document_bm25f(&doc, query);
        if !scored.has_strong_match {
            continue;
        }

        let (record_count, count_saturated) = count_indexed_collection_records(
            conn,
            policy,
            workspace_id,
            version_id,
            &collection_path,
            token,
        )?;
        if count_saturated {
            pool.scan_saturated = true;
        }

        let snippet = build_collection_snippet(&description, &field_names);
        let id = format!("collection:document:{collection_path}");
        pool.insert_or_improve(ScoredCandidate {
            hit: RetrievalHit {
                id,
                kind: RetrievalKind::Collection,
                title,
                path: Some(schema_path),
                object_id: Some(head.object_id),
                collection_kind: Some(RetrievalCollectionKind::Document),
                collection_path: Some(collection_path),
                dataset_path: None,
                record_id: None,
                fields: Some(field_names),
                record_count,
                matched_fields: None,
                thread_id: None,
                message_id: None,
                author: None,
                created_at_ms: None,
                channel_name: None,
                channel_wire_id: None,
                linked_file_path: None,
                snippet,
                matched_terms: scored.matched_terms,
                related: Vec::new(),
            },
            bm25f_score: scored.score,
        });
    }
    Ok(())
}

fn count_indexed_collection_records(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
    collection_path: &str,
    token: &CancellationToken,
) -> Result<(Option<u64>, bool), RuntimeError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT r.object_id FROM collection_records r \
             WHERE r.workspace_id = ?1 AND r.version_id = ?2 AND r.collection_path = ?3 \
               AND r.record_id IS NOT NULL \
             LIMIT ?4",
        )
        .map_err(SearchError::from)?;
    let mut rows = stmt
        .query(params![
            workspace_id,
            version_id,
            collection_path,
            (RECORD_COUNT_SCAN_CAP + 1) as i64
        ])
        .map_err(SearchError::from)?;
    let mut scanned = 0usize;
    let mut count = 0u64;
    while let Some(row) = rows.next().map_err(SearchError::from)? {
        scanned += 1;
        if scanned > RECORD_COUNT_SCAN_CAP {
            return Ok((None, true));
        }
        if scanned.is_multiple_of(256) && token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        let object_id: String = row.get(0).map_err(SearchError::from)?;
        if resolve_live_file_head(conn, policy, workspace_id, version_id, &object_id)?.is_some() {
            count += 1;
        }
    }
    Ok((Some(count), false))
}

fn build_collection_snippet(description: &str, field_names: &[String]) -> String {
    let desc = collapse_whitespace(description);
    let fields_summary = if field_names.is_empty() {
        String::new()
    } else {
        format!("fields: {}", field_names.join(", "))
    };
    let raw = match (desc.is_empty(), fields_summary.is_empty()) {
        (false, false) => format!("{desc} ({fields_summary})"),
        (false, true) => desc,
        (true, false) => format!("Collection ({fields_summary})"),
        (true, true) => "Collection".to_owned(),
    };
    truncate_chars(&raw, MAX_SNIPPET_CHARS)
}

#[allow(clippy::too_many_arguments)]
fn collect_transactional_datasets(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
    path_prefix: Option<&str>,
    collection_filter: Option<&str>,
    pool: &mut CandidatePool,
    token: &CancellationToken,
) -> Result<(), RuntimeError> {
    let mut bind_values: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Text(workspace_id.to_owned()),
        rusqlite::types::Value::Text(version_id.to_owned()),
    ];
    let mut extra = String::new();
    if let Some(filter) = collection_filter {
        let eq_idx = bind_values.len() + 1;
        let child_idx = eq_idx + 1;
        bind_values.push(rusqlite::types::Value::Text(filter.to_owned()));
        bind_values.push(rusqlite::types::Value::Text(format!(
            "{filter}/dataset.json"
        )));
        extra.push_str(&format!(" AND (path = ?{eq_idx} OR path = ?{child_idx})"));
    }
    if let Some(prefix) = path_prefix {
        let prefix_clause = append_path_prefix_sql(&mut bind_values, "path", prefix);
        extra.push_str(&format!(" AND {prefix_clause}"));
    }
    let limit_idx = bind_values.len() + 1;
    bind_values.push(rusqlite::types::Value::Integer(DATASET_SCAN_CAP as i64));
    let sql = format!(
        "SELECT object_id, path FROM path_aliases \
         WHERE workspace_id = ?1 AND version_id = ?2 \
           AND (path = 'dataset.json' OR path LIKE '%/dataset.json') \
           AND path NOT LIKE 'revisions/%' \
           AND path NOT LIKE '%/revisions/%'{extra} \
         ORDER BY path LIMIT ?{limit_idx}"
    );
    let mut stmt = conn.prepare(&sql).map_err(SearchError::from)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(bind_values), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(SearchError::from)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(SearchError::from)?;

    if rows.len() >= DATASET_SCAN_CAP {
        pool.scan_saturated = true;
    }

    for (object_id, path) in rows {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if path.starts_with("revisions/") || path.contains("/revisions/") {
            continue;
        }
        let parent_dir = path
            .rsplit_once('/')
            .map(|(dir, _)| dir.to_owned())
            .unwrap_or_else(|| ".".to_owned());
        if let Some(filter) = collection_filter
            && parent_dir != filter
            && path != filter
        {
            continue;
        }
        if let Some(prefix) = path_prefix
            && !path_matches_prefix(&path, prefix)
            && !path_matches_prefix(&parent_dir, prefix)
        {
            continue;
        }
        let Some(head) =
            resolve_live_file_head(conn, policy, workspace_id, version_id, &object_id)?
        else {
            continue;
        };
        let raw_json =
            match load_file_body_status(conn, head.blob_sha256.as_deref(), DATASET_TEXT_CAP_BYTES)?
            {
                BlobLoad::Text(text) => text,
                BlobLoad::Oversized => {
                    pool.scan_saturated = true;
                    continue;
                }
                BlobLoad::Missing => continue,
            };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw_json) else {
            continue;
        };
        if parsed.get("formatVersion").and_then(Value::as_u64) != Some(1) {
            continue;
        }
        let Some(name) = parsed
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };

        let mut table_names = Vec::new();
        let mut field_names = Vec::new();
        let mut seen_fields = HashSet::new();
        if let Some(tables) = parsed.get("tables").and_then(Value::as_array) {
            for table in tables.iter().take(DATASET_MAX_TABLES) {
                if let Some(tname) = table.get("name").and_then(Value::as_str) {
                    table_names.push(tname.to_owned());
                }
                if let Some(fields) = table.get("fields").and_then(Value::as_array) {
                    for field in fields.iter().take(DATASET_MAX_FIELDS) {
                        if let Some(fname) = field.get("name").and_then(Value::as_str)
                            && seen_fields.insert(fname.to_owned())
                        {
                            field_names.push(fname.to_owned());
                        }
                    }
                }
            }
        }
        let mut op_labels = Vec::new();
        if let Some(ops) = parsed.get("operations").and_then(Value::as_array) {
            for op in ops.iter().take(DATASET_MAX_OPERATIONS) {
                if let Some(label) = op.get("label").and_then(Value::as_str) {
                    op_labels.push(label.to_owned());
                }
            }
        }

        let title = truncate_chars(name, MAX_TITLE_CHARS);
        let doc = ScoreDocument {
            title: title.clone(),
            path: head.path.clone(),
            fields_text: format!("{} {}", table_names.join(" "), field_names.join(" ")),
            body: format!("dataset collection {}", op_labels.join(" ")),
        };
        let scored = score_document_bm25f(&doc, query);
        if !scored.has_strong_match {
            continue;
        }

        let emitted_fields: Vec<String> = field_names
            .into_iter()
            .take(DATASET_EMITTED_FIELDS_CAP)
            .collect();
        let summary = if table_names.is_empty() {
            "Transactional Collection (query with dohc_dataset)".to_owned()
        } else {
            format!(
                "Transactional Collection (query with dohc_dataset): tables {}; fields {}",
                table_names.join(", "),
                emitted_fields.join(", ")
            )
        };

        let id = format!("collection:transactional:{}", head.path);
        pool.insert_or_improve(ScoredCandidate {
            hit: RetrievalHit {
                id,
                kind: RetrievalKind::Collection,
                title,
                path: Some(head.path.clone()),
                object_id: Some(head.object_id),
                collection_kind: Some(RetrievalCollectionKind::Transactional),
                collection_path: Some(parent_dir),
                dataset_path: Some(head.path),
                record_id: None,
                fields: Some(emitted_fields),
                record_count: None,
                matched_fields: None,
                thread_id: None,
                message_id: None,
                author: None,
                created_at_ms: None,
                channel_name: None,
                channel_wire_id: None,
                linked_file_path: None,
                snippet: truncate_chars(&summary, MAX_SNIPPET_CHARS),
                matched_terms: scored.matched_terms,
                related: Vec::new(),
            },
            bm25f_score: scored.score,
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn collect_file_and_record_candidates(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    resolver: Option<&Resolver>,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
    mask: &SurfaceMask,
    path_prefix: Option<&str>,
    collection_filter: Option<&str>,
    pool: &mut CandidatePool,
    token: &CancellationToken,
) -> Result<(), RuntimeError> {
    let mut candidate_objects: Vec<(String, bool)> = Vec::new();
    let mut seen_objects: HashSet<String> = HashSet::new();

    if !query.fts_terms.is_empty() {
        let mut fts_rows: Vec<String> = Vec::new();
        if query.fts_terms.len() >= 2
            && let Some(and_expr) = fts_match_and(&query.fts_terms)
        {
            let (rows, saturated) = query_file_fts_ranked(
                conn,
                workspace_id,
                version_id,
                &and_expr,
                mask,
                path_prefix,
                collection_filter,
                FTS_AND_CANDIDATE_CAP,
            )?;
            if saturated {
                pool.scan_saturated = true;
            }
            fts_rows.extend(rows);
        }
        if fts_rows.len() < 40
            && let Some(or_expr) = fts_match_or(&query.fts_terms)
        {
            let (rows, saturated) = query_file_fts_ranked(
                conn,
                workspace_id,
                version_id,
                &or_expr,
                mask,
                path_prefix,
                collection_filter,
                FTS_OR_CANDIDATE_CAP,
            )?;
            if saturated {
                pool.scan_saturated = true;
            }
            fts_rows.extend(rows);
        }
        for object_id in fts_rows {
            if seen_objects.insert(object_id.clone()) {
                candidate_objects.push((object_id, true));
            }
        }
    } else {
        let (short_rows, saturated) = query_file_fts_short_scan(
            conn,
            workspace_id,
            version_id,
            query,
            mask,
            path_prefix,
            collection_filter,
            SHORT_QUERY_FILE_SCAN_CAP,
        )?;
        if saturated {
            pool.scan_saturated = true;
        }
        for object_id in short_rows {
            if seen_objects.insert(object_id.clone()) {
                candidate_objects.push((object_id, false));
            }
        }
    }

    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }

    let (path_title_rows, path_saturated) = query_path_and_title_candidates(
        conn,
        workspace_id,
        version_id,
        query,
        mask,
        path_prefix,
        collection_filter,
    )?;
    if path_saturated {
        pool.scan_saturated = true;
    }
    for object_id in path_title_rows {
        if seen_objects.insert(object_id.clone()) {
            candidate_objects.push((object_id, false));
        }
    }

    if mask.record {
        let (field_rows, fields_saturated) = query_record_field_candidates(
            conn,
            workspace_id,
            version_id,
            query,
            path_prefix,
            collection_filter,
        )?;
        if fields_saturated {
            pool.scan_saturated = true;
        }
        for object_id in field_rows {
            if seen_objects.insert(object_id.clone()) {
                candidate_objects.push((object_id, false));
            }
        }
    }

    let mut relation_title_cache: HashMap<String, String> = HashMap::new();

    for (object_id, from_fts) in candidate_objects {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if pool.hydrated_bytes >= TOTAL_HYDRATED_BYTES_BUDGET {
            pool.scan_saturated = true;
            break;
        }

        let Some(head) =
            resolve_live_file_head(conn, policy, workspace_id, version_id, &object_id)?
        else {
            continue;
        };

        if head.path == "collection.yaml"
            || head.path.ends_with("/collection.yaml")
            || head.path == "dataset.json"
            || head.path.ends_with("/dataset.json")
        {
            continue;
        }

        if let Some(prefix) = path_prefix
            && !path_matches_prefix(&head.path, prefix)
        {
            continue;
        }

        let record_row: Option<(Option<String>, String)> = conn
            .prepare_cached(
                "SELECT record_id, collection_path FROM collection_records \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
                 LIMIT 1",
            )
            .map_err(SearchError::from)?
            .query_row(params![workspace_id, version_id, head.object_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()
            .map_err(SearchError::from)?;

        let (kind, collection_path, record_id) = match record_row {
            Some((Some(rid), coll)) => (RetrievalKind::Record, Some(coll), Some(rid)),
            _ => (RetrievalKind::Page, None, None),
        };

        if let Some(filter) = collection_filter
            && collection_path.as_deref() != Some(filter)
        {
            continue;
        }
        if (kind == RetrievalKind::Page && !mask.page)
            || (kind == RetrievalKind::Record && !mask.record)
        {
            continue;
        }

        let body_text = match load_file_body_status(
            conn,
            head.blob_sha256.as_deref(),
            CANDIDATE_TEXT_CAP_BYTES,
        )? {
            BlobLoad::Text(raw) => extract_search_text(&head.path, &raw).into_owned(),
            BlobLoad::Oversized => {
                pool.scan_saturated = true;
                String::new()
            }
            BlobLoad::Missing => String::new(),
        };
        pool.hydrated_bytes = pool.hydrated_bytes.saturating_add(body_text.len());

        let title = resolve_live_file_title(
            conn,
            policy,
            resolver,
            workspace_id,
            version_id,
            &head,
            Some(&body_text),
        )?;

        let mut rendered_fields: Vec<RetrievalMatchedField> = Vec::new();
        let mut fields_text = String::new();
        if let Some(rid) = record_id.as_deref() {
            rendered_fields = load_record_fields(
                conn,
                policy,
                resolver,
                workspace_id,
                version_id,
                &head.path,
                rid,
                &mut relation_title_cache,
            )?;
            for field in &rendered_fields {
                fields_text.push_str(&field.name);
                fields_text.push(' ');
                fields_text.push_str(&field.value);
                fields_text.push('\n');
            }
        }

        let prose_raw = if kind == RetrievalKind::Record {
            strip_markdown_frontmatter(&body_text)
        } else {
            body_text.as_str()
        };
        let prose_body = redact_text_for_policy(prose_raw, Some(&head.path), policy, resolver);

        let doc = ScoreDocument {
            title: title.clone(),
            path: head.path.clone(),
            fields_text,
            body: prose_body.clone(),
        };
        let scored = score_document_bm25f(&doc, query);
        if !scored.has_strong_match {
            continue;
        }

        let id = match &record_id {
            Some(rid) => format!("record:{rid}"),
            None => format!("page:{}", head.object_id),
        };
        if from_fts {
            pool.record_file_fts_rank(&id);
        }

        let matched_fields = if kind == RetrievalKind::Record {
            let selected = select_matched_fields(&rendered_fields, query);
            if selected.is_empty() {
                None
            } else {
                Some(selected)
            }
        } else {
            None
        };

        let snippet = extract_best_snippet(&prose_body, query, MAX_SNIPPET_CHARS);
        let snippet = if snippet.is_empty() {
            if let Some(fields) = &matched_fields {
                truncate_chars(
                    &fields
                        .iter()
                        .map(|f| format!("{}: {}", f.name, f.value))
                        .collect::<Vec<_>>()
                        .join(" · "),
                    MAX_SNIPPET_CHARS,
                )
            } else {
                String::new()
            }
        } else {
            snippet
        };

        pool.insert_or_improve(ScoredCandidate {
            hit: RetrievalHit {
                id,
                kind,
                title,
                path: Some(head.path),
                object_id: Some(head.object_id),
                collection_kind: None,
                collection_path,
                dataset_path: None,
                record_id,
                fields: None,
                record_count: None,
                matched_fields,
                thread_id: None,
                message_id: None,
                author: None,
                created_at_ms: None,
                channel_name: None,
                channel_wire_id: None,
                linked_file_path: None,
                snippet,
                matched_terms: scored.matched_terms,
                related: Vec::new(),
            },
            bm25f_score: scored.score,
        });
    }
    Ok(())
}

fn append_file_scope_sql(
    bind_values: &mut Vec<rusqlite::types::Value>,
    alias_table: &str,
    mask: &SurfaceMask,
    path_prefix: Option<&str>,
    collection_filter: Option<&str>,
) -> String {
    let mut clause = format!(
        " AND {alias_table}.path <> 'collection.yaml' AND {alias_table}.path NOT LIKE '%/collection.yaml' \
          AND {alias_table}.path <> 'dataset.json' AND {alias_table}.path NOT LIKE '%/dataset.json'"
    );
    if let Some(prefix) = path_prefix {
        let prefix_col = format!("{alias_table}.path");
        let prefix_clause = append_path_prefix_sql(bind_values, &prefix_col, prefix);
        clause.push_str(&format!(" AND {prefix_clause}"));
    }
    if let Some(filter) = collection_filter {
        let idx = bind_values.len() + 1;
        bind_values.push(rusqlite::types::Value::Text(filter.to_owned()));
        clause.push_str(&format!(
            " AND EXISTS(SELECT 1 FROM collection_records cr \
                         WHERE cr.workspace_id = {alias_table}.workspace_id \
                           AND cr.version_id = {alias_table}.version_id \
                           AND cr.object_id = {alias_table}.object_id \
                           AND cr.record_id IS NOT NULL \
                           AND cr.collection_path = ?{idx})"
        ));
    } else if mask.record && !mask.page {
        clause.push_str(&format!(
            " AND EXISTS(SELECT 1 FROM collection_records cr \
                         WHERE cr.workspace_id = {alias_table}.workspace_id \
                           AND cr.version_id = {alias_table}.version_id \
                           AND cr.object_id = {alias_table}.object_id \
                           AND cr.record_id IS NOT NULL)"
        ));
    } else if mask.page && !mask.record {
        clause.push_str(&format!(
            " AND NOT EXISTS(SELECT 1 FROM collection_records cr \
                             WHERE cr.workspace_id = {alias_table}.workspace_id \
                               AND cr.version_id = {alias_table}.version_id \
                               AND cr.object_id = {alias_table}.object_id \
                               AND cr.record_id IS NOT NULL)"
        ));
    }
    clause
}

#[allow(clippy::too_many_arguments)]
fn query_file_fts_ranked(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    match_expr: &str,
    mask: &SurfaceMask,
    path_prefix: Option<&str>,
    collection_filter: Option<&str>,
    limit: usize,
) -> Result<(Vec<String>, bool), SearchError> {
    let mut bind_values: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Text(workspace_id.to_owned()),
        rusqlite::types::Value::Text(version_id.to_owned()),
        rusqlite::types::Value::Text(match_expr.to_owned()),
    ];
    let scope_sql =
        append_file_scope_sql(&mut bind_values, "a", mask, path_prefix, collection_filter);
    let limit_idx = bind_values.len() + 1;
    bind_values.push(rusqlite::types::Value::Integer(limit as i64));
    let sql = format!(
        "SELECT engine_search_files_fts.object_id \
         FROM engine_search_files_fts \
         JOIN path_aliases a \
           ON a.workspace_id = engine_search_files_fts.workspace_id \
          AND a.version_id = engine_search_files_fts.version_id \
          AND a.object_id = engine_search_files_fts.object_id \
         WHERE engine_search_files_fts MATCH ?3 \
           AND engine_search_files_fts.workspace_id = ?1 \
           AND engine_search_files_fts.version_id = ?2{scope_sql} \
         ORDER BY bm25(engine_search_files_fts) LIMIT ?{limit_idx}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(bind_values), |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let saturated = rows.len() >= limit;
    Ok((rows, saturated))
}

#[allow(clippy::too_many_arguments)]
fn query_file_fts_short_scan(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
    mask: &SurfaceMask,
    path_prefix: Option<&str>,
    collection_filter: Option<&str>,
    scan_cap: usize,
) -> Result<(Vec<String>, bool), SearchError> {
    let mut bind_values: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Text(workspace_id.to_owned()),
        rusqlite::types::Value::Text(version_id.to_owned()),
    ];
    let scope_sql =
        append_file_scope_sql(&mut bind_values, "a", mask, path_prefix, collection_filter);
    let cap_idx = bind_values.len() + 1;
    let limit_idx = cap_idx + 1;
    bind_values.push(rusqlite::types::Value::Integer(CANDIDATE_TEXT_CAP_BYTES));
    bind_values.push(rusqlite::types::Value::Integer(scan_cap as i64));
    let sql = format!(
        "SELECT engine_search_files_fts.object_id, \
                CASE WHEN length(CAST(engine_search_files_fts.text AS BLOB)) <= ?{cap_idx} \
                     THEN engine_search_files_fts.text ELSE NULL END \
         FROM engine_search_files_fts \
         JOIN path_aliases a \
           ON a.workspace_id = engine_search_files_fts.workspace_id \
          AND a.version_id = engine_search_files_fts.version_id \
          AND a.object_id = engine_search_files_fts.object_id \
         WHERE engine_search_files_fts.workspace_id = ?1 \
           AND engine_search_files_fts.version_id = ?2{scope_sql} \
         ORDER BY engine_search_files_fts.rowid LIMIT ?{limit_idx}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(bind_values))?;
    let mut inspected = 0usize;
    let mut out = Vec::new();
    let mut bytes_seen = 0usize;
    let mut saw_oversized = false;
    while let Some(row) = rows.next()? {
        inspected += 1;
        let object_id: String = row.get(0)?;
        let maybe_text: Option<String> = row.get(1)?;
        let Some(text) = maybe_text else {
            saw_oversized = true;
            continue;
        };
        bytes_seen = bytes_seen.saturating_add(text.len());
        let lowered = text.to_lowercase();
        if query.terms.iter().any(|term| lowered.contains(&term.raw)) {
            out.push(object_id);
            if out.len() >= FTS_OR_CANDIDATE_CAP {
                return Ok((out, true));
            }
        }
        if bytes_seen >= TOTAL_HYDRATED_BYTES_BUDGET / 2 {
            return Ok((out, true));
        }
    }
    Ok((out, saw_oversized || inspected >= scan_cap))
}

#[allow(clippy::too_many_arguments)]
fn query_path_and_title_candidates(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
    mask: &SurfaceMask,
    path_prefix: Option<&str>,
    collection_filter: Option<&str>,
) -> Result<(Vec<String>, bool), SearchError> {
    let mut probe_terms: Vec<&str> = query
        .terms
        .iter()
        .map(|term| {
            if term.stem.chars().count() >= 3 {
                term.stem.as_str()
            } else {
                term.raw.as_str()
            }
        })
        .take(6)
        .collect();
    if probe_terms.is_empty() {
        return Ok((Vec::new(), false));
    }
    probe_terms.sort();
    probe_terms.dedup();

    let mut clauses = Vec::with_capacity(probe_terms.len());
    let mut bind_values: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Text(workspace_id.to_owned()),
        rusqlite::types::Value::Text(version_id.to_owned()),
    ];
    for term in &probe_terms {
        let param_idx = bind_values.len() + 1;
        clauses.push(format!(
            "(lower(a.path) LIKE ?{param_idx} ESCAPE '\\' OR lower(coalesce(ls.title, '')) LIKE ?{param_idx} ESCAPE '\\')"
        ));
        bind_values.push(rusqlite::types::Value::Text(escape_like_pattern(term)));
    }
    let scope_sql =
        append_file_scope_sql(&mut bind_values, "a", mask, path_prefix, collection_filter);
    let limit_idx = bind_values.len() + 1;
    bind_values.push(rusqlite::types::Value::Integer(
        PATH_METADATA_CANDIDATE_CAP as i64,
    ));

    let sql = format!(
        "SELECT a.object_id FROM path_aliases a \
         LEFT JOIN link_sources ls \
           ON ls.workspace_id = a.workspace_id AND ls.version_id = a.version_id \
          AND ls.object_id = a.object_id AND ls.status = 'indexed' \
         WHERE a.workspace_id = ?1 AND a.version_id = ?2{scope_sql} \
           AND ({}) \
         LIMIT ?{limit_idx}",
        clauses.join(" OR ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let out = stmt
        .query_map(rusqlite::params_from_iter(bind_values), |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let saturated = out.len() >= PATH_METADATA_CANDIDATE_CAP;
    Ok((out, saturated))
}

fn query_record_field_candidates(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
    path_prefix: Option<&str>,
    collection_filter: Option<&str>,
) -> Result<(Vec<String>, bool), SearchError> {
    let mut probe_terms: Vec<&str> = query
        .terms
        .iter()
        .map(|term| {
            if term.stem.chars().count() >= 3 {
                term.stem.as_str()
            } else {
                term.raw.as_str()
            }
        })
        .take(6)
        .collect();
    if probe_terms.is_empty() {
        return Ok((Vec::new(), false));
    }
    probe_terms.sort();
    probe_terms.dedup();

    let mut clauses = Vec::with_capacity(probe_terms.len());
    let mut bind_values: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Text(workspace_id.to_owned()),
        rusqlite::types::Value::Text(version_id.to_owned()),
    ];
    for term in &probe_terms {
        let param_idx = bind_values.len() + 1;
        clauses.push(format!(
            "(lower(f.field_name) LIKE ?{param_idx} ESCAPE '\\' OR lower(f.value_json) LIKE ?{param_idx} ESCAPE '\\')"
        ));
        bind_values.push(rusqlite::types::Value::Text(escape_like_pattern(term)));
    }
    let mut extra = String::new();
    if let Some(filter) = collection_filter {
        let idx = bind_values.len() + 1;
        bind_values.push(rusqlite::types::Value::Text(filter.to_owned()));
        extra.push_str(&format!(" AND r.collection_path = ?{idx}"));
    }
    if let Some(prefix) = path_prefix {
        let prefix_clause = append_path_prefix_sql(&mut bind_values, "a.path", prefix);
        extra.push_str(&format!(" AND {prefix_clause}"));
    }
    let limit_idx = bind_values.len() + 1;
    bind_values.push(rusqlite::types::Value::Integer(
        RECORD_FIELD_CANDIDATE_CAP as i64,
    ));

    let sql = format!(
        "SELECT DISTINCT r.object_id \
         FROM collection_record_fields f \
         JOIN collection_records r \
           ON r.workspace_id = f.workspace_id AND r.version_id = f.version_id \
          AND r.record_id = f.record_id \
         JOIN path_aliases a \
           ON a.workspace_id = r.workspace_id AND a.version_id = r.version_id \
          AND a.object_id = r.object_id \
         WHERE f.workspace_id = ?1 AND f.version_id = ?2{extra} \
           AND ({}) \
         LIMIT ?{limit_idx}",
        clauses.join(" OR ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let out = stmt
        .query_map(rusqlite::params_from_iter(bind_values), |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let saturated = out.len() >= RECORD_FIELD_CANDIDATE_CAP;
    Ok((out, saturated))
}

#[allow(clippy::too_many_arguments)]
fn load_record_fields(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    resolver: Option<&Resolver>,
    workspace_id: &str,
    version_id: &str,
    source_path: &str,
    record_id: &str,
    relation_title_cache: &mut HashMap<String, String>,
) -> Result<Vec<RetrievalMatchedField>, SearchError> {
    let mut rel_stmt = conn.prepare_cached(
        "SELECT e.target_record_id, r.object_id \
         FROM collection_relation_edges e \
         JOIN collection_records r \
           ON r.workspace_id = e.workspace_id AND r.version_id = e.version_id \
          AND r.record_id = e.target_record_id \
         WHERE e.workspace_id = ?1 AND e.version_id = ?2 AND e.source_record_id = ?3 \
         LIMIT 24",
    )?;
    let rel_targets = rel_stmt
        .query_map(params![workspace_id, version_id, record_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for (target_record_id, target_object_id) in rel_targets {
        if relation_title_cache.contains_key(&target_record_id) {
            continue;
        }
        let Some(head) =
            resolve_live_file_head(conn, policy, workspace_id, version_id, &target_object_id)?
        else {
            continue;
        };
        let resolved_title = resolve_live_file_title(
            conn,
            policy,
            resolver,
            workspace_id,
            version_id,
            &head,
            None,
        )?;
        relation_title_cache.insert(target_record_id, resolved_title);
    }

    let mut stmt = conn.prepare_cached(
        "SELECT field_name, value_json FROM collection_record_fields \
         WHERE workspace_id = ?1 AND version_id = ?2 AND record_id = ?3 \
         ORDER BY field_name LIMIT 32",
    )?;
    let rows = stmt
        .query_map(params![workspace_id, version_id, record_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut out = Vec::new();
    for (name, value_json) in rows {
        if let Some(rendered) = render_field_value_json(&value_json, relation_title_cache) {
            let redacted = redact_text_for_policy(&rendered, Some(source_path), policy, resolver);
            let cleaned = collapse_whitespace(&redacted);
            if !cleaned.is_empty() {
                out.push(RetrievalMatchedField {
                    name,
                    value: cleaned,
                });
            }
        }
    }
    Ok(out)
}

fn select_matched_fields(
    fields: &[RetrievalMatchedField],
    query: &ParsedQuery,
) -> Vec<RetrievalMatchedField> {
    let mut scored: Vec<(usize, &RetrievalMatchedField)> = fields
        .iter()
        .map(|field| {
            let hay = format!("{} {}", field.name, field.value).to_lowercase();
            let mut hits = 0usize;
            for term in &query.terms {
                if hay.contains(&term.raw) || hay.contains(&term.stem) {
                    hits += 1;
                }
            }
            (hits, field)
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));

    let matched: Vec<RetrievalMatchedField> = scored
        .iter()
        .filter(|(hits, _)| *hits > 0)
        .take(MAX_MATCHED_FIELDS)
        .map(|(_, field)| (*field).clone())
        .collect();
    if !matched.is_empty() {
        return matched;
    }
    fields.iter().take(2).cloned().collect()
}

struct ChatThreadHit {
    thread_id: String,
    best_message_id: Option<String>,
    best_author: Option<String>,
    best_created_at_ms: Option<i64>,
    best_body: String,
    combined_messages: String,
    from_fts: bool,
}

#[allow(clippy::too_many_arguments)]
fn collect_chat_candidates(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    resolver: Option<&Resolver>,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
    path_prefix: Option<&str>,
    pool: &mut CandidatePool,
    token: &CancellationToken,
) -> Result<(), RuntimeError> {
    let mut raw_hits: Vec<(String, String, bool)> = Vec::new();
    let mut seen_pairs: HashSet<(String, String)> = HashSet::new();

    if !query.fts_terms.is_empty() {
        if query.fts_terms.len() >= 2
            && let Some(and_expr) = fts_match_and(&query.fts_terms)
        {
            let (rows, saturated) = query_chat_fts_ranked(
                conn,
                workspace_id,
                version_id,
                &and_expr,
                path_prefix,
                CHAT_FTS_CANDIDATE_CAP,
            )?;
            if saturated {
                pool.scan_saturated = true;
            }
            for (tid, mid) in rows {
                if seen_pairs.insert((tid.clone(), mid.clone())) {
                    raw_hits.push((tid, mid, true));
                }
            }
        }
        if raw_hits.len() < 40
            && let Some(or_expr) = fts_match_or(&query.fts_terms)
        {
            let (rows, saturated) = query_chat_fts_ranked(
                conn,
                workspace_id,
                version_id,
                &or_expr,
                path_prefix,
                CHAT_FTS_CANDIDATE_CAP,
            )?;
            if saturated {
                pool.scan_saturated = true;
            }
            for (tid, mid) in rows {
                if seen_pairs.insert((tid.clone(), mid.clone())) {
                    raw_hits.push((tid, mid, true));
                }
            }
        }
    } else {
        let (rows, saturated) = query_chat_fts_short_scan(
            conn,
            workspace_id,
            version_id,
            query,
            path_prefix,
            SHORT_QUERY_CHAT_SCAN_CAP,
        )?;
        if saturated {
            pool.scan_saturated = true;
        }
        for (tid, mid) in rows {
            if seen_pairs.insert((tid.clone(), mid.clone())) {
                raw_hits.push((tid, mid, false));
            }
        }
    }

    let (meta_tids, meta_saturated) =
        query_chat_metadata_candidates(conn, workspace_id, version_id, query, path_prefix)?;
    if meta_saturated {
        pool.scan_saturated = true;
    }
    for tid in meta_tids {
        let header_id = crate::search::THREAD_HEADER_MESSAGE_ID.to_owned();
        if seen_pairs.insert((tid.clone(), header_id.clone())) {
            raw_hits.push((tid, header_id, false));
        }
    }

    let mut by_thread: HashMap<String, ChatThreadHit> = HashMap::new();
    let mut thread_order: Vec<String> = Vec::new();

    for (thread_id, message_id, from_fts) in raw_hits {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if pool.hydrated_bytes >= TOTAL_HYDRATED_BYTES_BUDGET {
            pool.scan_saturated = true;
            break;
        }
        if thread_id.is_empty() {
            continue;
        }
        if !by_thread.contains_key(&thread_id) {
            thread_order.push(thread_id.clone());
        }
        let entry = by_thread
            .entry(thread_id.clone())
            .or_insert_with(|| ChatThreadHit {
                thread_id: thread_id.clone(),
                best_message_id: None,
                best_author: None,
                best_created_at_ms: None,
                best_body: String::new(),
                combined_messages: String::new(),
                from_fts,
            });
        entry.from_fts |= from_fts;

        if message_id == crate::search::THREAD_HEADER_MESSAGE_ID {
            continue;
        }
        let msg_row: Option<(String, Option<String>, i64)> = conn
            .prepare_cached(
                "SELECT author_display_name, \
                        CASE WHEN length(CAST(body AS BLOB)) <= ?4 THEN body ELSE NULL END, \
                        created_at_ms \
                 FROM chat_messages \
                 WHERE workspace_id = ?1 AND thread_id = ?2 AND message_id = ?3",
            )
            .map_err(SearchError::from)?
            .query_row(
                params![workspace_id, thread_id, message_id, CHAT_BODY_CAP_BYTES],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(SearchError::from)?;
        let Some((author, maybe_body, created_at_ms)) = msg_row else {
            continue;
        };
        let Some(body) = maybe_body else {
            pool.scan_saturated = true;
            continue;
        };
        pool.hydrated_bytes = pool.hydrated_bytes.saturating_add(body.len());

        if entry.combined_messages.len() < CHAT_COMBINED_BODY_CAP_BYTES {
            if !entry.combined_messages.is_empty() {
                entry.combined_messages.push('\n');
            }
            entry.combined_messages.push_str(&author);
            entry.combined_messages.push(' ');
            entry.combined_messages.push_str(&body);
        }

        if entry.best_message_id.is_none() {
            entry.best_message_id = Some(message_id);
            entry.best_author = Some(author);
            entry.best_created_at_ms = Some(created_at_ms);
            entry.best_body = body;
        }
    }

    for thread_id in thread_order {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        let Some(mut hit) = by_thread.remove(&thread_id) else {
            continue;
        };
        struct ChatMetaRow {
            stored_title: String,
            linked_object_id: Option<String>,
            channel_id: Option<String>,
            channel_name: Option<String>,
            channel_wire_id: Option<String>,
            first_body: Option<String>,
            channel_valid: i64,
        }
        let meta = conn
            .prepare_cached(
                "SELECT t.title, t.linked_object_id, t.channel_id, ch.name, \
                        (SELECT w.wire_id FROM chat_channel_wire_ids w \
                         WHERE w.workspace_id = t.workspace_id AND w.channel_id = t.channel_id \
                         ORDER BY w.wire_id LIMIT 1), \
                        (SELECT substr(m.body, 1, 2048) FROM chat_messages m \
                         WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id \
                         ORDER BY m.created_at_ms, m.message_id LIMIT 1), \
                        CASE WHEN t.channel_id IS NULL THEN 1 \
                             ELSE EXISTS(SELECT 1 FROM chat_channels c2 \
                                         WHERE c2.workspace_id = t.workspace_id AND c2.channel_id = t.channel_id \
                                         AND NOT EXISTS(SELECT 1 FROM chat_channel_placeholders p \
                                                        WHERE p.workspace_id = c2.workspace_id AND p.channel_id = c2.channel_id)) \
                        END \
                 FROM chat_threads t \
                 LEFT JOIN chat_channels ch \
                   ON ch.workspace_id = t.workspace_id AND ch.channel_id = t.channel_id \
                 WHERE t.workspace_id = ?1 AND t.thread_id = ?2",
            )
            .map_err(SearchError::from)?
            .query_row(params![workspace_id, thread_id], |row| {
                Ok(ChatMetaRow {
                    stored_title: row.get(0)?,
                    linked_object_id: row.get(1)?,
                    channel_id: row.get(2)?,
                    channel_name: row.get(3)?,
                    channel_wire_id: row.get(4)?,
                    first_body: row.get(5)?,
                    channel_valid: row.get(6)?,
                })
            })
            .optional()
            .map_err(SearchError::from)?;

        let Some(ChatMetaRow {
            stored_title,
            linked_object_id,
            channel_id,
            channel_name,
            channel_wire_id,
            first_body,
            channel_valid,
        }) = meta
        else {
            continue;
        };

        if linked_object_id.is_some() == channel_id.is_some() || channel_valid != 1 {
            continue;
        }

        let linked_file_path = match linked_object_id.as_deref() {
            Some(object_id) => {
                resolve_live_file_head(conn, policy, workspace_id, version_id, object_id)?
                    .map(|head| head.path)
            }
            None => None,
        };

        if let Some(prefix) = path_prefix {
            let Some(linked_path) = linked_file_path.as_deref() else {
                continue;
            };
            if !path_matches_prefix(linked_path, prefix) {
                continue;
            }
        }

        let redacted_stored_title = redact_text_for_policy(&stored_title, None, policy, resolver);
        let redacted_first_body = first_body
            .as_deref()
            .map(|body| redact_text_for_policy(body, None, policy, resolver));
        let title = truncate_chars(
            &display_title_for(&redacted_stored_title, redacted_first_body.as_deref()),
            MAX_TITLE_CHARS,
        );
        if hit.best_body.is_empty()
            && let Some(body) = redacted_first_body.as_deref()
        {
            hit.best_body = body.to_owned();
        } else {
            hit.best_body = redact_text_for_policy(&hit.best_body, None, policy, resolver);
        }
        let body_for_score = if hit.combined_messages.is_empty() {
            hit.best_body.clone()
        } else {
            redact_text_for_policy(&hit.combined_messages, None, policy, resolver)
        };

        let doc = ScoreDocument {
            title: title.clone(),
            path: linked_file_path.clone().unwrap_or_default(),
            fields_text: channel_name.clone().unwrap_or_default(),
            body: body_for_score,
        };
        let scored = score_document_bm25f(&doc, query);
        if !scored.has_strong_match {
            continue;
        }

        let id = format!("chat:{}", hit.thread_id);
        if hit.from_fts {
            pool.record_chat_fts_rank(&id);
        }
        let snippet = extract_best_snippet(&hit.best_body, query, MAX_SNIPPET_CHARS);

        pool.insert_or_improve(ScoredCandidate {
            hit: RetrievalHit {
                id,
                kind: RetrievalKind::Chat,
                title,
                path: None,
                object_id: None,
                collection_kind: None,
                collection_path: None,
                dataset_path: None,
                record_id: None,
                fields: None,
                record_count: None,
                matched_fields: None,
                thread_id: Some(hit.thread_id),
                message_id: hit.best_message_id,
                author: hit.best_author.map(|a| truncate_chars(&a, 100)),
                created_at_ms: hit.best_created_at_ms,
                channel_name: channel_name.map(|c| truncate_chars(&c, 100)),
                channel_wire_id,
                linked_file_path,
                snippet,
                matched_terms: scored.matched_terms,
                related: Vec::new(),
            },
            bm25f_score: scored.score,
        });
    }
    Ok(())
}

fn query_chat_fts_ranked(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    match_expr: &str,
    path_prefix: Option<&str>,
    limit: usize,
) -> Result<(Vec<(String, String)>, bool), SearchError> {
    let rows = if let Some(prefix) = path_prefix {
        let mut bind_values: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(workspace_id.to_owned()),
            rusqlite::types::Value::Text(match_expr.to_owned()),
            rusqlite::types::Value::Text(version_id.to_owned()),
        ];
        let prefix_clause = append_path_prefix_sql(&mut bind_values, "a.path", prefix);
        let limit_idx = bind_values.len() + 1;
        bind_values.push(rusqlite::types::Value::Integer(limit as i64));
        let sql = format!(
            "SELECT engine_search_chat_messages_fts.thread_id, \
                    engine_search_chat_messages_fts.message_id \
             FROM engine_search_chat_messages_fts \
             JOIN chat_threads t \
               ON t.workspace_id = engine_search_chat_messages_fts.workspace_id \
              AND t.thread_id = engine_search_chat_messages_fts.thread_id \
             JOIN path_aliases a \
               ON a.workspace_id = t.workspace_id AND a.version_id = ?3 \
              AND a.object_id = t.linked_object_id \
             WHERE engine_search_chat_messages_fts MATCH ?2 \
               AND engine_search_chat_messages_fts.workspace_id = ?1 \
               AND t.channel_id IS NULL \
               AND {prefix_clause} \
             ORDER BY bm25(engine_search_chat_messages_fts) LIMIT ?{limit_idx}"
        );
        let mut stmt = conn.prepare(&sql)?;
        stmt.query_map(rusqlite::params_from_iter(bind_values), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        let mut stmt = conn.prepare_cached(
            "SELECT thread_id, message_id \
             FROM engine_search_chat_messages_fts \
             WHERE engine_search_chat_messages_fts MATCH ?2 AND workspace_id = ?1 \
             ORDER BY bm25(engine_search_chat_messages_fts) LIMIT ?3",
        )?;
        stmt.query_map(params![workspace_id, match_expr, limit as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let saturated = rows.len() >= limit;
    Ok((rows, saturated))
}

fn query_chat_fts_short_scan(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
    path_prefix: Option<&str>,
    scan_cap: usize,
) -> Result<(Vec<(String, String)>, bool), SearchError> {
    let mut bind_values: Vec<rusqlite::types::Value> =
        vec![rusqlite::types::Value::Text(workspace_id.to_owned())];
    let (join_sql, where_extra) = if let Some(prefix) = path_prefix {
        let ver_idx = bind_values.len() + 1;
        bind_values.push(rusqlite::types::Value::Text(version_id.to_owned()));
        let prefix_clause = append_path_prefix_sql(&mut bind_values, "a.path", prefix);
        (
            format!(
                " JOIN chat_threads t \
                    ON t.workspace_id = engine_search_chat_messages_fts.workspace_id \
                   AND t.thread_id = engine_search_chat_messages_fts.thread_id \
                  JOIN path_aliases a \
                    ON a.workspace_id = t.workspace_id AND a.version_id = ?{ver_idx} \
                   AND a.object_id = t.linked_object_id"
            ),
            format!(" AND t.channel_id IS NULL AND {prefix_clause}"),
        )
    } else {
        (String::new(), String::new())
    };
    let cap_idx = bind_values.len() + 1;
    let limit_idx = cap_idx + 1;
    bind_values.push(rusqlite::types::Value::Integer(CHAT_BODY_CAP_BYTES));
    bind_values.push(rusqlite::types::Value::Integer(scan_cap as i64));
    let sql = format!(
        "SELECT engine_search_chat_messages_fts.thread_id, \
                engine_search_chat_messages_fts.message_id, \
                CASE WHEN length(CAST(engine_search_chat_messages_fts.text AS BLOB)) <= ?{cap_idx} \
                     THEN engine_search_chat_messages_fts.text ELSE NULL END \
         FROM engine_search_chat_messages_fts{join_sql} \
         WHERE engine_search_chat_messages_fts.workspace_id = ?1{where_extra} \
         ORDER BY engine_search_chat_messages_fts.rowid LIMIT ?{limit_idx}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(bind_values))?;
    let mut inspected = 0usize;
    let mut out = Vec::new();
    let mut bytes_seen = 0usize;
    let mut saw_oversized = false;
    while let Some(row) = rows.next()? {
        inspected += 1;
        let thread_id: String = row.get(0)?;
        let message_id: String = row.get(1)?;
        let maybe_text: Option<String> = row.get(2)?;
        let Some(text) = maybe_text else {
            saw_oversized = true;
            continue;
        };
        bytes_seen = bytes_seen.saturating_add(text.len());
        let lowered = text.to_lowercase();
        if query.terms.iter().any(|term| lowered.contains(&term.raw)) {
            out.push((thread_id, message_id));
            if out.len() >= CHAT_FTS_CANDIDATE_CAP {
                return Ok((out, true));
            }
        }
        if bytes_seen >= TOTAL_HYDRATED_BYTES_BUDGET / 2 {
            return Ok((out, true));
        }
    }
    Ok((out, saw_oversized || inspected >= scan_cap))
}

fn query_chat_metadata_candidates(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
    path_prefix: Option<&str>,
) -> Result<(Vec<String>, bool), SearchError> {
    let mut probe_terms: Vec<&str> = query
        .terms
        .iter()
        .map(|term| {
            if term.stem.chars().count() >= 3 {
                term.stem.as_str()
            } else {
                term.raw.as_str()
            }
        })
        .take(6)
        .collect();
    if probe_terms.is_empty() {
        return Ok((Vec::new(), false));
    }
    probe_terms.sort();
    probe_terms.dedup();

    let mut clauses = Vec::with_capacity(probe_terms.len());
    let mut bind_values: Vec<rusqlite::types::Value> =
        vec![rusqlite::types::Value::Text(workspace_id.to_owned())];
    for term in &probe_terms {
        let param_idx = bind_values.len() + 1;
        clauses.push(format!(
            "(lower(t.title) LIKE ?{param_idx} ESCAPE '\\' OR lower(coalesce(ch.name, '')) LIKE ?{param_idx} ESCAPE '\\')"
        ));
        bind_values.push(rusqlite::types::Value::Text(escape_like_pattern(term)));
    }
    let (join_sql, where_extra) = if let Some(prefix) = path_prefix {
        let ver_idx = bind_values.len() + 1;
        bind_values.push(rusqlite::types::Value::Text(version_id.to_owned()));
        let prefix_clause = append_path_prefix_sql(&mut bind_values, "a.path", prefix);
        (
            format!(
                " JOIN path_aliases a \
                    ON a.workspace_id = t.workspace_id AND a.version_id = ?{ver_idx} \
                   AND a.object_id = t.linked_object_id"
            ),
            format!(" AND t.channel_id IS NULL AND {prefix_clause}"),
        )
    } else {
        (String::new(), String::new())
    };
    let limit_idx = bind_values.len() + 1;
    bind_values.push(rusqlite::types::Value::Integer(
        CHAT_METADATA_CANDIDATE_CAP as i64,
    ));

    let sql = format!(
        "SELECT t.thread_id FROM chat_threads t \
         LEFT JOIN chat_channels ch \
           ON ch.workspace_id = t.workspace_id AND ch.channel_id = t.channel_id{join_sql} \
         WHERE t.workspace_id = ?1{where_extra} \
           AND ({}) \
         ORDER BY t.updated_at_ms DESC LIMIT ?{limit_idx}",
        clauses.join(" OR ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let out = stmt
        .query_map(rusqlite::params_from_iter(bind_values), |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let saturated = out.len() >= CHAT_METADATA_CANDIDATE_CAP;
    Ok((out, saturated))
}
