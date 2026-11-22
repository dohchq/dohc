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
    render_field_value_json, strip_markdown_frontmatter, truncate_chars,
};

pub const DEFAULT_RETRIEVAL_LIMIT: usize = 15;
pub const MAX_RETRIEVAL_LIMIT: usize = 50;
pub const MAX_RETRIEVAL_RESPONSE_BYTES: usize = 64 * 1024;

const FTS_AND_CANDIDATE_CAP: usize = 100;
const FTS_OR_CANDIDATE_CAP: usize = 160;
const PATH_METADATA_CANDIDATE_CAP: usize = 120;
const RECORD_FIELD_CANDIDATE_CAP: usize = 120;
const COLLECTION_SCAN_CAP: usize = 500;
const DATASET_SCAN_CAP: usize = 100;
const CHAT_FTS_CANDIDATE_CAP: usize = 160;
const CHAT_METADATA_CANDIDATE_CAP: usize = 60;
const SHORT_QUERY_FILE_SCAN_CAP: usize = 2000;
const SHORT_QUERY_CHAT_SCAN_CAP: usize = 1000;
const CANDIDATE_TEXT_CAP_BYTES: i64 = 256 * 1024;
const SCHEMA_TEXT_CAP_BYTES: i64 = 64 * 1024;
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

pub(crate) fn load_file_body_capped(
    conn: &Connection,
    blob_sha256: Option<&str>,
    cap_bytes: i64,
) -> Result<Option<String>, SearchError> {
    let Some(sha256) = blob_sha256 else {
        return Ok(None);
    };
    match blob_text::capped(conn, sha256, cap_bytes) {
        Ok((_, _, maybe_text)) => Ok(maybe_text),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(SearchError::from(error)),
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
    fts_rank: Option<usize>,
}

struct CandidatePool {
    items: HashMap<String, ScoredCandidate>,
    fts_order: Vec<String>,
    scan_saturated: bool,
    hydrated_bytes: usize,
}

impl CandidatePool {
    fn new() -> Self {
        Self {
            items: HashMap::new(),
            fts_order: Vec::new(),
            scan_saturated: false,
            hydrated_bytes: 0,
        }
    }

    fn record_fts_rank(&mut self, id: &str) -> usize {
        let rank = self.fts_order.len();
        self.fts_order.push(id.to_owned());
        rank
    }

    fn insert_or_improve(&mut self, mut candidate: ScoredCandidate) {
        if let Some(existing) = self.items.get_mut(&candidate.hit.id) {
            if existing.fts_rank.is_none() {
                existing.fts_rank = candidate.fts_rank;
            }
            if candidate.bm25f_score > existing.bm25f_score {
                candidate.fts_rank = existing.fts_rank.or(candidate.fts_rank);
                *existing = candidate;
            }
        } else {
            self.items.insert(candidate.hit.id.clone(), candidate);
        }
    }
}

impl ActorHandle {
    pub async fn retrieve_workspace(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        request: RetrievalRequest,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<RetrievalResponse, RuntimeError> {
        if parse_query(&request.query).is_none() {
            return Err(StorageError::InvalidInput {
                reason: "retrieval query must be 1 to 512 non-whitespace characters",
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
        let include_neighbors = request.include_neighbors;

        let (version_id, search_index_building, prepared_resolver) = self
            .run(move |store, _| -> Result<_, RuntimeError> {
                if actor_token.is_cancelled() {
                    return Err(RuntimeError::Cancelled);
                }
                let version_id = VersionedTextStore::new(store)
                    .get_active_version(&ws)?
                    .version_id;
                let policy = read_engine_search_policy(&root_for_actor);
                let is_passive = store.is_passive();
                let is_read_only = store.pages_checked().is_none();

                let certified = store
                    .read_with(|conn| is_search_index_certified(conn, &policy, &ws, &version_id))?;

                let mut index_building = false;
                if !certified {
                    if !is_passive && !is_read_only {
                        store.mutate_with_connection(|conn| {
                            ensure_search_index_for_version(
                                conn,
                                &root_for_actor,
                                &ws,
                                &version_id,
                                now_ms,
                                &NoFaults,
                            )
                        })?;
                    } else {
                        index_building = true;
                    }
                }

                let prepared =
                    if include_neighbors && !policy.is_degraded() {
                        Some(store.read_with(|conn| {
                            cache::prepare(conn, &link_cache, &ws, &version_id)
                        })?)
                    } else {
                        None
                    };

                Ok((version_id, index_building, prepared))
            })
            .await?;

        let held = self.location();
        tokio::task::spawn_blocking(move || {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let store = HeldReader::open(held)?;
            let resolver = prepared_resolver.map(cache::Prepared::build);
            store.read_with(|conn| -> Result<RetrievalResponse, RuntimeError> {
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
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }

    let Some(parsed_query) = parse_query(&request.query) else {
        return Err(StorageError::InvalidInput {
            reason: "retrieval query must be 1 to 512 non-whitespace characters",
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

    let mut pool = CandidatePool::new();

    if !policy_degraded && mask.wants_any_file_surface() {
        if mask.collection {
            collect_document_collections(
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

    let fts_ids: Vec<String> = pool
        .fts_order
        .iter()
        .filter(|id| pool.items.contains_key(id.as_str()))
        .cloned()
        .collect();

    let fused = rrf_fuse(&[(&bm25f_ids, 1.5), (&fts_ids, 1.0)], RRF_K);

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

    let (mut neighbors, links_building) = if request.include_neighbors && !results.is_empty() {
        let owned_resolver;
        let active_resolver = match resolver {
            Some(existing) => existing,
            None => {
                let paths = Resolver::paths_for_version(conn, workspace_id, version_id)?;
                owned_resolver = Resolver::new(paths);
                &owned_resolver
            }
        };
        let outcome = expand_graph_neighborhood(
            conn,
            &policy,
            workspace_id,
            version_id,
            active_resolver,
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
    while serde_json::to_vec(response)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
        > MAX_RETRIEVAL_RESPONSE_BYTES
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

#[allow(clippy::too_many_arguments)]
fn collect_document_collections(
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
    let mut stmt = conn
        .prepare_cached(
            "SELECT collection_path, schema_path FROM collections \
             WHERE workspace_id = ?1 AND version_id = ?2 \
             ORDER BY collection_path LIMIT ?3",
        )
        .map_err(SearchError::from)?;
    let rows = stmt
        .query_map(
            params![workspace_id, version_id, COLLECTION_SCAN_CAP as i64],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
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
        let schema_yaml =
            load_file_body_capped(conn, head.blob_sha256.as_deref(), SCHEMA_TEXT_CAP_BYTES)?
                .unwrap_or_default();
        let parsed = parse_collection_schema(&schema_yaml);
        let schema = parsed.schema;

        let title = schema
            .name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .map(|name| truncate_chars(name.trim(), MAX_TITLE_CHARS))
            .unwrap_or_else(|| {
                truncate_chars(
                    collection_path
                        .rsplit('/')
                        .next()
                        .unwrap_or(&collection_path),
                    MAX_TITLE_CHARS,
                )
            });

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
        let description = schema.description.unwrap_or_default();
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

        let record_count = count_indexed_collection_records(
            conn,
            policy,
            workspace_id,
            version_id,
            &collection_path,
        )?;

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
                record_count: Some(record_count),
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
            fts_rank: None,
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
) -> Result<u64, SearchError> {
    let mut stmt = conn.prepare_cached(
        "SELECT a.path FROM collection_records r \
         JOIN path_aliases a \
           ON a.workspace_id = r.workspace_id AND a.version_id = r.version_id \
          AND a.object_id = r.object_id \
         WHERE r.workspace_id = ?1 AND r.version_id = ?2 AND r.collection_path = ?3 \
         LIMIT 5000",
    )?;
    let mut count = 0u64;
    let mut rows = stmt.query(params![workspace_id, version_id, collection_path])?;
    while let Some(row) = rows.next()? {
        let path: String = row.get(0)?;
        if path_is_search_indexed(policy, &path) {
            count += 1;
        }
    }
    Ok(count)
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
    let mut stmt = conn
        .prepare_cached(
            "SELECT object_id, path FROM path_aliases \
             WHERE workspace_id = ?1 AND version_id = ?2 \
               AND (path = 'dataset.json' OR path LIKE '%/dataset.json') \
             ORDER BY path LIMIT ?3",
        )
        .map_err(SearchError::from)?;
    let rows = stmt
        .query_map(
            params![workspace_id, version_id, DATASET_SCAN_CAP as i64],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(SearchError::from)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(SearchError::from)?;

    for (object_id, path) in rows {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if path.contains("/revisions/") {
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
        let Some(raw_json) =
            load_file_body_capped(conn, head.blob_sha256.as_deref(), SCHEMA_TEXT_CAP_BYTES)?
        else {
            continue;
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
            for table in tables.iter().take(32) {
                if let Some(tname) = table.get("name").and_then(Value::as_str) {
                    table_names.push(tname.to_owned());
                }
                if let Some(fields) = table.get("fields").and_then(Value::as_array) {
                    for field in fields.iter().take(64) {
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
            for op in ops.iter().take(32) {
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

        let summary = if table_names.is_empty() {
            "Transactional Collection (query with dohc_dataset)".to_owned()
        } else {
            format!(
                "Transactional Collection (query with dohc_dataset): tables {}; fields {}",
                table_names.join(", "),
                field_names.join(", ")
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
                fields: Some(field_names),
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
            fts_rank: None,
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn collect_file_and_record_candidates(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
    mask: &SurfaceMask,
    path_prefix: Option<&str>,
    collection_filter: Option<&str>,
    pool: &mut CandidatePool,
    token: &CancellationToken,
) -> Result<(), RuntimeError> {
    let mut candidate_objects: Vec<(String, Option<String>, bool)> = Vec::new();
    let mut seen_objects: HashSet<String> = HashSet::new();

    if !query.fts_terms.is_empty() {
        let mut fts_rows: Vec<(String, String)> = Vec::new();
        if query.fts_terms.len() >= 2
            && let Some(and_expr) = fts_match_and(&query.fts_terms)
        {
            fts_rows.extend(query_file_fts_ranked(
                conn,
                workspace_id,
                version_id,
                &and_expr,
                FTS_AND_CANDIDATE_CAP,
            )?);
        }
        if fts_rows.len() < 40
            && let Some(or_expr) = fts_match_or(&query.fts_terms)
        {
            fts_rows.extend(query_file_fts_ranked(
                conn,
                workspace_id,
                version_id,
                &or_expr,
                FTS_OR_CANDIDATE_CAP,
            )?);
        }
        for (object_id, text) in fts_rows {
            if seen_objects.insert(object_id.clone()) {
                candidate_objects.push((object_id, Some(text), true));
            }
        }
    } else {
        let (short_rows, saturated) = query_file_fts_short_scan(
            conn,
            workspace_id,
            version_id,
            query,
            SHORT_QUERY_FILE_SCAN_CAP,
        )?;
        if saturated {
            pool.scan_saturated = true;
        }
        for (object_id, text) in short_rows {
            if seen_objects.insert(object_id.clone()) {
                candidate_objects.push((object_id, Some(text), false));
            }
        }
    }

    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }

    for object_id in query_path_and_title_candidates(conn, workspace_id, version_id, query)? {
        if seen_objects.insert(object_id.clone()) {
            candidate_objects.push((object_id, None, false));
        }
    }

    if mask.record {
        for object_id in
            query_record_field_candidates(conn, workspace_id, version_id, query, collection_filter)?
        {
            if seen_objects.insert(object_id.clone()) {
                candidate_objects.push((object_id, None, false));
            }
        }
    }

    let mut relation_title_cache: HashMap<String, String> = HashMap::new();

    for (object_id, fts_text, from_fts) in candidate_objects {
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

        let body_text = match fts_text {
            Some(text) => text,
            None => {
                let raw = load_file_body_capped(
                    conn,
                    head.blob_sha256.as_deref(),
                    CANDIDATE_TEXT_CAP_BYTES,
                )?
                .unwrap_or_default();
                extract_search_text(&head.path, &raw).into_owned()
            }
        };
        pool.hydrated_bytes = pool.hydrated_bytes.saturating_add(body_text.len());

        let link_title: Option<String> = conn
            .prepare_cached(
                "SELECT title FROM link_sources \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
                   AND status = 'indexed'",
            )
            .map_err(SearchError::from)?
            .query_row(params![workspace_id, version_id, head.object_id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(SearchError::from)?;

        let title = link_title
            .filter(|t| !t.trim().is_empty())
            .map(|t| truncate_chars(t.trim(), MAX_TITLE_CHARS))
            .or_else(|| extract_markdown_heading(&body_text))
            .unwrap_or_else(|| fallback_title_from_path(&head.path));

        let mut rendered_fields: Vec<RetrievalMatchedField> = Vec::new();
        let mut fields_text = String::new();
        if let Some(rid) = record_id.as_deref() {
            rendered_fields = load_record_fields(
                conn,
                policy,
                workspace_id,
                version_id,
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

        let prose_body = if kind == RetrievalKind::Record {
            strip_markdown_frontmatter(&body_text)
        } else {
            body_text.as_str()
        };

        let doc = ScoreDocument {
            title: title.clone(),
            path: head.path.clone(),
            fields_text,
            body: prose_body.to_owned(),
        };
        let scored = score_document_bm25f(&doc, query);
        if !scored.has_strong_match {
            continue;
        }

        let id = match &record_id {
            Some(rid) => format!("record:{rid}"),
            None => format!("page:{}", head.object_id),
        };
        let fts_rank = if from_fts {
            Some(pool.record_fts_rank(&id))
        } else {
            None
        };

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

        let snippet = extract_best_snippet(prose_body, query, MAX_SNIPPET_CHARS);
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
            fts_rank,
        });
    }
    Ok(())
}

fn query_file_fts_ranked(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    match_expr: &str,
    limit: usize,
) -> Result<Vec<(String, String)>, SearchError> {
    let mut stmt = conn.prepare_cached(
        "SELECT object_id, \
                CASE WHEN length(CAST(text AS BLOB)) <= ?5 THEN text ELSE '' END \
         FROM engine_search_files_fts \
         WHERE engine_search_files_fts MATCH ?3 \
           AND workspace_id = ?1 AND version_id = ?2 \
         ORDER BY bm25(engine_search_files_fts) LIMIT ?4",
    )?;
    let rows = stmt
        .query_map(
            params![
                workspace_id,
                version_id,
                match_expr,
                limit as i64,
                CANDIDATE_TEXT_CAP_BYTES
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn query_file_fts_short_scan(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
    scan_cap: usize,
) -> Result<(Vec<(String, String)>, bool), SearchError> {
    let mut stmt = conn.prepare_cached(
        "SELECT object_id, \
                CASE WHEN length(CAST(text AS BLOB)) <= ?4 THEN text ELSE '' END \
         FROM engine_search_files_fts \
         WHERE workspace_id = ?1 AND version_id = ?2 \
         ORDER BY rowid LIMIT ?3",
    )?;
    let mut rows = stmt.query(params![
        workspace_id,
        version_id,
        scan_cap as i64,
        CANDIDATE_TEXT_CAP_BYTES
    ])?;
    let mut inspected = 0usize;
    let mut out = Vec::new();
    let mut bytes_seen = 0usize;
    while let Some(row) = rows.next()? {
        inspected += 1;
        let object_id: String = row.get(0)?;
        let text: String = row.get(1)?;
        bytes_seen = bytes_seen.saturating_add(text.len());
        let lowered = text.to_lowercase();
        if query.terms.iter().any(|term| lowered.contains(&term.raw)) {
            out.push((object_id, text));
            if out.len() >= FTS_OR_CANDIDATE_CAP {
                return Ok((out, true));
            }
        }
        if bytes_seen >= TOTAL_HYDRATED_BYTES_BUDGET / 2 {
            return Ok((out, true));
        }
    }
    Ok((out, inspected >= scan_cap))
}

fn query_path_and_title_candidates(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
) -> Result<Vec<String>, SearchError> {
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
        return Ok(Vec::new());
    }
    probe_terms.sort();
    probe_terms.dedup();

    let mut clauses = Vec::with_capacity(probe_terms.len());
    let mut bind_values: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Text(workspace_id.to_owned()),
        rusqlite::types::Value::Text(version_id.to_owned()),
    ];
    for (idx, term) in probe_terms.iter().enumerate() {
        let param_idx = idx + 3;
        clauses.push(format!(
            "(lower(a.path) LIKE ?{param_idx} ESCAPE '\\' OR lower(coalesce(ls.title, '')) LIKE ?{param_idx} ESCAPE '\\')"
        ));
        bind_values.push(rusqlite::types::Value::Text(escape_like_pattern(term)));
    }
    let limit_idx = bind_values.len() + 1;
    bind_values.push(rusqlite::types::Value::Integer(
        PATH_METADATA_CANDIDATE_CAP as i64,
    ));

    let sql = format!(
        "SELECT a.object_id FROM path_aliases a \
         LEFT JOIN link_sources ls \
           ON ls.workspace_id = a.workspace_id AND ls.version_id = a.version_id \
          AND ls.object_id = a.object_id AND ls.status = 'indexed' \
         WHERE a.workspace_id = ?1 AND a.version_id = ?2 \
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
    Ok(out)
}

fn query_record_field_candidates(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
    collection_filter: Option<&str>,
) -> Result<Vec<String>, SearchError> {
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
        return Ok(Vec::new());
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
    let collection_clause = if let Some(filter) = collection_filter {
        let idx = bind_values.len() + 1;
        bind_values.push(rusqlite::types::Value::Text(filter.to_owned()));
        format!(" AND r.collection_path = ?{idx}")
    } else {
        String::new()
    };
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
         WHERE f.workspace_id = ?1 AND f.version_id = ?2{collection_clause} \
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
    Ok(out)
}

fn load_record_fields(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
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
        let title: Option<String> = conn
            .prepare_cached(
                "SELECT title FROM link_sources \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
                   AND status = 'indexed'",
            )?
            .query_row(params![workspace_id, version_id, head.object_id], |row| {
                row.get(0)
            })
            .optional()?;
        let resolved_title = title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| fallback_title_from_path(&head.path));
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
            out.push(RetrievalMatchedField {
                name,
                value: rendered,
            });
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
            for (tid, mid) in
                query_chat_fts_ranked(conn, workspace_id, &and_expr, CHAT_FTS_CANDIDATE_CAP)?
            {
                if seen_pairs.insert((tid.clone(), mid.clone())) {
                    raw_hits.push((tid, mid, true));
                }
            }
        }
        if raw_hits.len() < 40
            && let Some(or_expr) = fts_match_or(&query.fts_terms)
        {
            for (tid, mid) in
                query_chat_fts_ranked(conn, workspace_id, &or_expr, CHAT_FTS_CANDIDATE_CAP)?
            {
                if seen_pairs.insert((tid.clone(), mid.clone())) {
                    raw_hits.push((tid, mid, true));
                }
            }
        }
    } else {
        let (rows, saturated) =
            query_chat_fts_short_scan(conn, workspace_id, query, SHORT_QUERY_CHAT_SCAN_CAP)?;
        if saturated {
            pool.scan_saturated = true;
        }
        for (tid, mid) in rows {
            if seen_pairs.insert((tid.clone(), mid.clone())) {
                raw_hits.push((tid, mid, false));
            }
        }
    }

    for tid in query_chat_metadata_candidates(conn, workspace_id, query)? {
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
        let msg_row: Option<(String, String, i64)> = conn
            .prepare_cached(
                "SELECT author_display_name, substr(body, 1, 8192), created_at_ms \
                 FROM chat_messages \
                 WHERE workspace_id = ?1 AND thread_id = ?2 AND message_id = ?3",
            )
            .map_err(SearchError::from)?
            .query_row(params![workspace_id, thread_id, message_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .optional()
            .map_err(SearchError::from)?;
        let Some((author, body, created_at_ms)) = msg_row else {
            continue;
        };

        if entry.combined_messages.len() < 16_384 {
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

        let title = truncate_chars(
            &display_title_for(&stored_title, first_body.as_deref()),
            MAX_TITLE_CHARS,
        );
        if hit.best_body.is_empty()
            && let Some(body) = first_body.as_deref()
        {
            hit.best_body = body.to_owned();
        }
        let body_for_score = if hit.combined_messages.is_empty() {
            hit.best_body.clone()
        } else {
            hit.combined_messages
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
        let fts_rank = if hit.from_fts {
            Some(pool.record_fts_rank(&id))
        } else {
            None
        };
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
            fts_rank,
        });
    }
    Ok(())
}

fn query_chat_fts_ranked(
    conn: &Connection,
    workspace_id: &str,
    match_expr: &str,
    limit: usize,
) -> Result<Vec<(String, String)>, SearchError> {
    let mut stmt = conn.prepare_cached(
        "SELECT thread_id, message_id \
         FROM engine_search_chat_messages_fts \
         WHERE engine_search_chat_messages_fts MATCH ?2 AND workspace_id = ?1 \
         ORDER BY bm25(engine_search_chat_messages_fts) LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![workspace_id, match_expr, limit as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn query_chat_fts_short_scan(
    conn: &Connection,
    workspace_id: &str,
    query: &ParsedQuery,
    scan_cap: usize,
) -> Result<(Vec<(String, String)>, bool), SearchError> {
    let mut stmt = conn.prepare_cached(
        "SELECT thread_id, message_id, substr(text, 1, 8192) \
         FROM engine_search_chat_messages_fts \
         WHERE workspace_id = ?1 \
         ORDER BY rowid LIMIT ?2",
    )?;
    let mut rows = stmt.query(params![workspace_id, scan_cap as i64])?;
    let mut inspected = 0usize;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        inspected += 1;
        let thread_id: String = row.get(0)?;
        let message_id: String = row.get(1)?;
        let text: String = row.get(2)?;
        let lowered = text.to_lowercase();
        if query.terms.iter().any(|term| lowered.contains(&term.raw)) {
            out.push((thread_id, message_id));
            if out.len() >= CHAT_FTS_CANDIDATE_CAP {
                return Ok((out, true));
            }
        }
    }
    Ok((out, inspected >= scan_cap))
}

fn query_chat_metadata_candidates(
    conn: &Connection,
    workspace_id: &str,
    query: &ParsedQuery,
) -> Result<Vec<String>, SearchError> {
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
        return Ok(Vec::new());
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
    let limit_idx = bind_values.len() + 1;
    bind_values.push(rusqlite::types::Value::Integer(
        CHAT_METADATA_CANDIDATE_CAP as i64,
    ));

    let sql = format!(
        "SELECT t.thread_id FROM chat_threads t \
         LEFT JOIN chat_channels ch \
           ON ch.workspace_id = t.workspace_id AND ch.channel_id = t.channel_id \
         WHERE t.workspace_id = ?1 \
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
    Ok(out)
}
