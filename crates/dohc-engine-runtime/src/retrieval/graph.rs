use super::text::{
    MAX_NEIGHBOR_SNIPPET_CHARS, MAX_TITLE_CHARS, ParsedQuery, extract_best_snippet,
    extract_markdown_heading, fallback_title_from_path, strip_markdown_frontmatter, truncate_chars,
};
use super::{
    LiveFileHead, RetrievalEdgeDirection, RetrievalEdgeKind, RetrievalHit, RetrievalKind,
    RetrievalNeighbor, RetrievalNeighborVia, RetrievalRelatedEdge, SCHEMA_TEXT_CAP_BYTES,
    load_file_body_capped, redact_text_for_policy, resolve_live_file_head,
    resolve_live_file_head_by_path,
};
use crate::links::PARSER_GENERATION;
use crate::links::path_keys;
use crate::links::resolver::Resolver;
use crate::search::SearchError;
use crate::search::policy::SearchPolicySnapshot;
use dohc_engine_domain::parse_collection_schema;
use dohc_engine_files::search_text::extract_search_text;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::{HashMap, HashSet};
use tokio_util::sync::CancellationToken;

const GRAPH_SEED_CAP: usize = 8;
const MAX_OUTGOING_LINKS_PER_SEED: usize = 16;
const MAX_INCOMING_LINK_CANDIDATES_PER_SEED: usize = 24;
const MAX_RELATIONS_PER_SEED: usize = 12;
const MAX_CHAT_LINKS_PER_SEED: usize = 8;
const MAX_RELATED_PER_HIT: usize = 4;
const MAX_NEIGHBORS: usize = 5;
const MAX_VIA_PER_NEIGHBOR: usize = 3;
const NEIGHBOR_BODY_CAP_BYTES: i64 = 64 * 1024;

#[derive(Debug, Clone)]
struct GraphNode {
    id: String,
    kind: RetrievalKind,
    title: String,
    path: Option<String>,
    object_id: Option<String>,
    collection_path: Option<String>,
    record_id: Option<String>,
    thread_id: Option<String>,
    snippet: String,
}

#[derive(Debug, Clone)]
struct DiscoveredEdge {
    edge: RetrievalEdgeKind,
    direction: RetrievalEdgeDirection,
    field: Option<String>,
    target: GraphNode,
}

pub(crate) struct GraphExpansionOutcome {
    pub neighbors: Vec<RetrievalNeighbor>,
    pub links_building: bool,
}

fn edge_priority(edge: RetrievalEdgeKind) -> u8 {
    match edge {
        RetrievalEdgeKind::Relation => 5,
        RetrievalEdgeKind::Wikilink => 4,
        RetrievalEdgeKind::Markdown => 4,
        RetrievalEdgeKind::ChatLinkedFile => 3,
        RetrievalEdgeKind::ChatMention => 2,
        RetrievalEdgeKind::CollectionMember => 1,
    }
}

fn edge_weight(edge: RetrievalEdgeKind) -> f64 {
    match edge {
        RetrievalEdgeKind::Relation => 1.5,
        RetrievalEdgeKind::Wikilink | RetrievalEdgeKind::Markdown => 1.25,
        RetrievalEdgeKind::ChatLinkedFile => 1.15,
        RetrievalEdgeKind::ChatMention => 1.0,
        RetrievalEdgeKind::CollectionMember => 0.85,
    }
}

pub(crate) fn links_index_is_building(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<bool, SearchError> {
    let ready: bool = conn.query_row(
        "SELECT coalesce((SELECT seed_phase = 'ready' AND parser_generation = ?3 \
                          FROM link_index_state \
                          WHERE workspace_id = ?1 AND version_id = ?2), 0) \
         AND NOT EXISTS(SELECT 1 FROM link_pending WHERE workspace_id = ?1 AND version_id = ?2)",
        params![workspace_id, version_id, PARSER_GENERATION],
        |row| row.get(0),
    )?;
    Ok(!ready)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn expand_graph_neighborhood(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
    resolver: &Resolver,
    query: &ParsedQuery,
    hits: &mut [RetrievalHit],
    token: &CancellationToken,
) -> Result<GraphExpansionOutcome, SearchError> {
    if hits.is_empty() {
        return Ok(GraphExpansionOutcome {
            neighbors: Vec::new(),
            links_building: false,
        });
    }

    let links_building = if policy.is_degraded() {
        false
    } else {
        links_index_is_building(conn, workspace_id, version_id)?
    };

    let direct_ids: HashSet<String> = hits.iter().map(|hit| hit.id.clone()).collect();
    let mut node_cache: HashMap<String, GraphNode> = HashMap::new();
    let mut neighbor_scores: HashMap<String, (f64, Vec<RetrievalNeighborVia>, GraphNode)> =
        HashMap::new();

    let seed_count = hits.len().min(GRAPH_SEED_CAP);
    for (seed_rank, hit) in hits.iter_mut().take(seed_count).enumerate() {
        if token.is_cancelled() {
            return Ok(GraphExpansionOutcome {
                neighbors: Vec::new(),
                links_building,
            });
        }
        let seed_weight = 1.0 / ((seed_rank as f64) + 1.0).sqrt();
        let mut raw_edges: Vec<DiscoveredEdge> = Vec::new();

        match hit.kind {
            RetrievalKind::Page | RetrievalKind::Record => {
                if !policy.is_degraded() {
                    if let (Some(object_id), Some(path)) =
                        (hit.object_id.as_deref(), hit.path.as_deref())
                    {
                        collect_outgoing_links(
                            conn,
                            policy,
                            workspace_id,
                            version_id,
                            resolver,
                            object_id,
                            path,
                            query,
                            &mut node_cache,
                            &mut raw_edges,
                        )?;
                        collect_incoming_links(
                            conn,
                            policy,
                            workspace_id,
                            version_id,
                            resolver,
                            object_id,
                            path,
                            query,
                            &mut node_cache,
                            &mut raw_edges,
                        )?;
                        collect_chats_for_file(
                            conn,
                            policy,
                            resolver,
                            workspace_id,
                            object_id,
                            query,
                            &mut node_cache,
                            &mut raw_edges,
                        )?;
                    }
                    if hit.kind == RetrievalKind::Record {
                        if let Some(record_id) = hit.record_id.as_deref() {
                            collect_record_relations(
                                conn,
                                policy,
                                resolver,
                                workspace_id,
                                version_id,
                                record_id,
                                query,
                                &mut node_cache,
                                &mut raw_edges,
                            )?;
                        }
                        if let Some(collection_path) = hit.collection_path.as_deref() {
                            collect_parent_collection(
                                conn,
                                policy,
                                workspace_id,
                                version_id,
                                collection_path,
                                &mut node_cache,
                                &mut raw_edges,
                            )?;
                        }
                    }
                }
            }
            RetrievalKind::Collection => {
                if !policy.is_degraded()
                    && hit.collection_kind == Some(super::RetrievalCollectionKind::Document)
                    && let Some(collection_path) = hit.collection_path.as_deref()
                {
                    collect_collection_records(
                        conn,
                        policy,
                        resolver,
                        workspace_id,
                        version_id,
                        collection_path,
                        query,
                        &mut node_cache,
                        &mut raw_edges,
                    )?;
                }
            }
            RetrievalKind::Chat => {
                if !policy.is_degraded()
                    && let Some(thread_id) = hit.thread_id.as_deref()
                {
                    collect_files_for_chat(
                        conn,
                        policy,
                        resolver,
                        workspace_id,
                        version_id,
                        thread_id,
                        query,
                        &mut node_cache,
                        &mut raw_edges,
                    )?;
                }
            }
        }

        let mut seen_related = HashSet::new();
        raw_edges.retain(|edge| {
            if edge.target.id == hit.id {
                return false;
            }
            seen_related.insert((
                edge.target.id.clone(),
                edge.edge,
                edge.direction,
                edge.field.clone(),
            ))
        });

        raw_edges.sort_by(|a, b| {
            edge_priority(b.edge)
                .cmp(&edge_priority(a.edge))
                .then_with(|| a.target.id.cmp(&b.target.id))
                .then_with(|| a.field.cmp(&b.field))
        });

        for discovered in raw_edges.iter().take(MAX_RELATED_PER_HIT) {
            hit.related.push(RetrievalRelatedEdge {
                kind: discovered.target.kind,
                edge: discovered.edge,
                direction: discovered.direction,
                field: discovered.field.clone(),
                title: discovered.target.title.clone(),
                path: discovered.target.path.clone(),
                object_id: discovered.target.object_id.clone(),
                collection_path: discovered.target.collection_path.clone(),
                record_id: discovered.target.record_id.clone(),
                thread_id: discovered.target.thread_id.clone(),
            });
        }

        for discovered in raw_edges {
            if direct_ids.contains(&discovered.target.id) {
                continue;
            }
            let contribution = seed_weight * edge_weight(discovered.edge);
            let entry = neighbor_scores
                .entry(discovered.target.id.clone())
                .or_insert_with(|| (0.0, Vec::new(), discovered.target.clone()));
            if !entry
                .1
                .iter()
                .any(|via| via.from_id == hit.id && via.edge == discovered.edge)
            {
                let bridge_bonus = if entry.1.is_empty() { 0.0 } else { 0.75 };
                entry.0 += contribution + bridge_bonus;
                if entry.1.len() < MAX_VIA_PER_NEIGHBOR {
                    entry.1.push(RetrievalNeighborVia {
                        from_id: hit.id.clone(),
                        from_title: hit.title.clone(),
                        edge: discovered.edge,
                        direction: discovered.direction,
                        field: discovered.field,
                    });
                }
            }
        }
    }

    let mut ranked_neighbors: Vec<(f64, Vec<RetrievalNeighborVia>, GraphNode)> =
        neighbor_scores.into_values().collect();
    ranked_neighbors.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| b.1.len().cmp(&a.1.len()))
            .then_with(|| a.2.id.cmp(&b.2.id))
    });

    let neighbors = ranked_neighbors
        .into_iter()
        .take(MAX_NEIGHBORS)
        .map(|(_, via, node)| RetrievalNeighbor {
            id: node.id,
            kind: node.kind,
            title: node.title,
            path: node.path,
            object_id: node.object_id,
            collection_path: node.collection_path,
            record_id: node.record_id,
            thread_id: node.thread_id,
            snippet: if node.snippet.is_empty() {
                None
            } else {
                Some(node.snippet)
            },
            via,
        })
        .collect();

    Ok(GraphExpansionOutcome {
        neighbors,
        links_building,
    })
}

#[allow(clippy::too_many_arguments)]
fn hydrate_file_node(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    resolver: &Resolver,
    head: &LiveFileHead,
    workspace_id: &str,
    version_id: &str,
    query: &ParsedQuery,
    cache: &mut HashMap<String, GraphNode>,
) -> Result<GraphNode, SearchError> {
    let record_meta: Option<(Option<String>, String)> = conn
        .prepare_cached(
            "SELECT record_id, collection_path FROM collection_records \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
             LIMIT 1",
        )?
        .query_row(params![workspace_id, version_id, head.object_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;

    let (id, kind, collection_path, record_id) = match record_meta {
        Some((Some(rid), coll)) => (
            format!("record:{rid}"),
            RetrievalKind::Record,
            Some(coll),
            Some(rid),
        ),
        _ => (
            format!("page:{}", head.object_id),
            RetrievalKind::Page,
            None,
            None,
        ),
    };

    if let Some(existing) = cache.get(&id) {
        return Ok(existing.clone());
    }

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

    let raw_body =
        load_file_body_capped(conn, head.blob_sha256.as_deref(), NEIGHBOR_BODY_CAP_BYTES)?;
    let searchable_body = raw_body
        .as_deref()
        .map(|text| extract_search_text(&head.path, text));

    let title = link_title
        .filter(|t| !t.trim().is_empty())
        .map(|t| truncate_chars(t.trim(), MAX_TITLE_CHARS))
        .or_else(|| {
            searchable_body
                .as_deref()
                .and_then(extract_markdown_heading)
        })
        .unwrap_or_else(|| fallback_title_from_path(&head.path));

    let snippet_source = match (kind, searchable_body.as_deref()) {
        (RetrievalKind::Record, Some(body)) => strip_markdown_frontmatter(body),
        (_, Some(body)) => body,
        _ => "",
    };
    let redacted_snippet =
        redact_text_for_policy(snippet_source, Some(&head.path), policy, Some(resolver));
    let snippet = extract_best_snippet(&redacted_snippet, query, MAX_NEIGHBOR_SNIPPET_CHARS);

    let node = GraphNode {
        id: id.clone(),
        kind,
        title,
        path: Some(head.path.clone()),
        object_id: Some(head.object_id.clone()),
        collection_path,
        record_id,
        thread_id: None,
        snippet,
    };
    cache.insert(id, node.clone());
    Ok(node)
}

fn hydrate_chat_node(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    resolver: &Resolver,
    workspace_id: &str,
    thread_id: &str,
    query: &ParsedQuery,
    cache: &mut HashMap<String, GraphNode>,
) -> Result<Option<GraphNode>, SearchError> {
    let id = format!("chat:{thread_id}");
    if let Some(existing) = cache.get(&id) {
        return Ok(Some(existing.clone()));
    }

    struct ChatNodeRow {
        stored_title: String,
        linked_object_id: Option<String>,
        channel_id: Option<String>,
        first_body: Option<String>,
        channel_valid: i64,
    }
    let row = conn
        .prepare_cached(
            "SELECT t.title, t.linked_object_id, t.channel_id, \
                    (SELECT m.body FROM chat_messages m \
                     WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id \
                     ORDER BY m.created_at_ms, m.message_id LIMIT 1), \
                    CASE WHEN t.channel_id IS NULL THEN 1 \
                         ELSE EXISTS(SELECT 1 FROM chat_channels ch \
                                     WHERE ch.workspace_id = t.workspace_id AND ch.channel_id = t.channel_id \
                                     AND NOT EXISTS(SELECT 1 FROM chat_channel_placeholders p \
                                                    WHERE p.workspace_id = ch.workspace_id AND p.channel_id = ch.channel_id)) \
                    END \
             FROM chat_threads t \
             WHERE t.workspace_id = ?1 AND t.thread_id = ?2",
        )?
        .query_row(params![workspace_id, thread_id], |r| {
            Ok(ChatNodeRow {
                stored_title: r.get(0)?,
                linked_object_id: r.get(1)?,
                channel_id: r.get(2)?,
                first_body: r.get(3)?,
                channel_valid: r.get(4)?,
            })
        })
        .optional()?;

    let Some(ChatNodeRow {
        stored_title,
        linked_object_id,
        channel_id,
        first_body,
        channel_valid,
    }) = row
    else {
        return Ok(None);
    };
    if linked_object_id.is_some() == channel_id.is_some() || channel_valid != 1 {
        return Ok(None);
    }

    let redacted_stored = redact_text_for_policy(&stored_title, None, policy, Some(resolver));
    let redacted_body = first_body
        .as_deref()
        .map(|body| redact_text_for_policy(body, None, policy, Some(resolver)));
    let title = truncate_chars(
        &crate::search::index::display_title_for(&redacted_stored, redacted_body.as_deref()),
        MAX_TITLE_CHARS,
    );
    let snippet = redacted_body
        .as_deref()
        .map(|body| extract_best_snippet(body, query, MAX_NEIGHBOR_SNIPPET_CHARS))
        .unwrap_or_default();

    let node = GraphNode {
        id: id.clone(),
        kind: RetrievalKind::Chat,
        title,
        path: None,
        object_id: None,
        collection_path: None,
        record_id: None,
        thread_id: Some(thread_id.to_owned()),
        snippet,
    };
    cache.insert(id, node.clone());
    Ok(Some(node))
}

#[allow(clippy::too_many_arguments)]
fn collect_outgoing_links(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
    resolver: &Resolver,
    object_id: &str,
    source_path: &str,
    query: &ParsedQuery,
    cache: &mut HashMap<String, GraphNode>,
    out: &mut Vec<DiscoveredEdge>,
) -> Result<(), SearchError> {
    let index_key: Option<String> = conn
        .prepare_cached(
            "SELECT s.index_key FROM link_sources s \
             WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.object_id = ?3 \
               AND s.status = 'indexed' AND s.parser_generation = ?4 \
               AND NOT EXISTS(SELECT 1 FROM link_pending p \
                              WHERE p.workspace_id = s.workspace_id \
                                AND p.version_id = s.version_id \
                                AND p.object_id = s.object_id)",
        )?
        .query_row(
            params![workspace_id, version_id, object_id, PARSER_GENERATION],
            |row| row.get(0),
        )
        .optional()?;
    let Some(index_key) = index_key else {
        return Ok(());
    };

    let mut stmt = conn.prepare_cached(
        "SELECT literal, kind FROM links \
         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 AND index_key = ?4 \
         ORDER BY ordinal LIMIT ?5",
    )?;
    let rows = stmt
        .query_map(
            params![
                workspace_id,
                version_id,
                object_id,
                index_key,
                MAX_OUTGOING_LINKS_PER_SEED as i64
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for (literal, kind) in rows {
        let resolved = if kind == "markdown" {
            resolver.resolve_markdown(source_path, &literal)
        } else {
            resolver.resolve(source_path, &literal)
        };
        let Some(target_path) = resolved else {
            continue;
        };
        if target_path == source_path {
            continue;
        }
        let Some(head) =
            resolve_live_file_head_by_path(conn, policy, workspace_id, version_id, target_path)?
        else {
            continue;
        };
        let node = hydrate_file_node(
            conn,
            policy,
            resolver,
            &head,
            workspace_id,
            version_id,
            query,
            cache,
        )?;
        out.push(DiscoveredEdge {
            edge: if kind == "markdown" {
                RetrievalEdgeKind::Markdown
            } else {
                RetrievalEdgeKind::Wikilink
            },
            direction: RetrievalEdgeDirection::Out,
            field: None,
            target: node,
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn collect_incoming_links(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
    resolver: &Resolver,
    target_object_id: &str,
    target_path: &str,
    query: &ParsedQuery,
    cache: &mut HashMap<String, GraphNode>,
    out: &mut Vec<DiscoveredEdge>,
) -> Result<(), SearchError> {
    let keys = serde_json::to_string(&path_keys(target_path)).expect("path keys serialize to JSON");
    let mut stmt = conn.prepare_cached(
        "SELECT DISTINCT k.object_id, l.literal, l.kind \
         FROM json_each(?3) probe \
         CROSS JOIN link_occurrence_keys k INDEXED BY link_occurrence_probe \
           ON k.workspace_id = ?1 AND k.version_id = ?2 \
          AND k.key_kind = json_extract(probe.value, '$[0]') \
          AND k.key = json_extract(probe.value, '$[1]') \
         JOIN link_sources s \
           ON s.workspace_id = k.workspace_id AND s.version_id = k.version_id \
          AND s.object_id = k.object_id AND s.index_key = k.index_key \
         JOIN links l \
           ON l.workspace_id = k.workspace_id AND l.version_id = k.version_id \
          AND l.object_id = k.object_id AND l.index_key = k.index_key AND l.ordinal = k.ordinal \
         WHERE s.status = 'indexed' AND s.parser_generation = ?4 \
           AND k.object_id <> ?5 \
           AND NOT EXISTS(SELECT 1 FROM link_pending p \
                          WHERE p.workspace_id = s.workspace_id \
                            AND p.version_id = s.version_id \
                            AND p.object_id = s.object_id) \
         LIMIT ?6",
    )?;
    let rows = stmt
        .query_map(
            params![
                workspace_id,
                version_id,
                keys,
                PARSER_GENERATION,
                target_object_id,
                MAX_INCOMING_LINK_CANDIDATES_PER_SEED as i64
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for (source_object_id, literal, kind) in rows {
        let Some(head) =
            resolve_live_file_head(conn, policy, workspace_id, version_id, &source_object_id)?
        else {
            continue;
        };
        let resolved = if kind == "markdown" {
            resolver.resolve_markdown(&head.path, &literal)
        } else {
            resolver.resolve(&head.path, &literal)
        };
        if resolved != Some(target_path) {
            continue;
        }
        let node = hydrate_file_node(
            conn,
            policy,
            resolver,
            &head,
            workspace_id,
            version_id,
            query,
            cache,
        )?;
        out.push(DiscoveredEdge {
            edge: if kind == "markdown" {
                RetrievalEdgeKind::Markdown
            } else {
                RetrievalEdgeKind::Wikilink
            },
            direction: RetrievalEdgeDirection::In,
            field: None,
            target: node,
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn collect_record_relations(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    resolver: &Resolver,
    workspace_id: &str,
    version_id: &str,
    record_id: &str,
    query: &ParsedQuery,
    cache: &mut HashMap<String, GraphNode>,
    out: &mut Vec<DiscoveredEdge>,
) -> Result<(), SearchError> {
    let mut out_stmt = conn.prepare_cached(
        "SELECT e.field_name, r.object_id \
         FROM collection_relation_edges e \
         JOIN collection_records r \
           ON r.workspace_id = e.workspace_id AND r.version_id = e.version_id \
          AND r.record_id = e.target_record_id \
         WHERE e.workspace_id = ?1 AND e.version_id = ?2 AND e.source_record_id = ?3 \
         LIMIT ?4",
    )?;
    let outgoing = out_stmt
        .query_map(
            params![
                workspace_id,
                version_id,
                record_id,
                MAX_RELATIONS_PER_SEED as i64
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for (field_name, target_object_id) in outgoing {
        let Some(head) =
            resolve_live_file_head(conn, policy, workspace_id, version_id, &target_object_id)?
        else {
            continue;
        };
        let node = hydrate_file_node(
            conn,
            policy,
            resolver,
            &head,
            workspace_id,
            version_id,
            query,
            cache,
        )?;
        out.push(DiscoveredEdge {
            edge: RetrievalEdgeKind::Relation,
            direction: RetrievalEdgeDirection::Out,
            field: Some(field_name),
            target: node,
        });
    }

    let mut in_stmt = conn.prepare_cached(
        "SELECT e.field_name, r.object_id \
         FROM collection_relation_edges e \
         JOIN collection_records r \
           ON r.workspace_id = e.workspace_id AND r.version_id = e.version_id \
          AND r.record_id = e.source_record_id \
         WHERE e.workspace_id = ?1 AND e.version_id = ?2 AND e.target_record_id = ?3 \
         LIMIT ?4",
    )?;
    let incoming = in_stmt
        .query_map(
            params![
                workspace_id,
                version_id,
                record_id,
                MAX_RELATIONS_PER_SEED as i64
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for (field_name, source_object_id) in incoming {
        let Some(head) =
            resolve_live_file_head(conn, policy, workspace_id, version_id, &source_object_id)?
        else {
            continue;
        };
        let node = hydrate_file_node(
            conn,
            policy,
            resolver,
            &head,
            workspace_id,
            version_id,
            query,
            cache,
        )?;
        out.push(DiscoveredEdge {
            edge: RetrievalEdgeKind::Relation,
            direction: RetrievalEdgeDirection::In,
            field: Some(field_name),
            target: node,
        });
    }
    Ok(())
}

fn collect_parent_collection(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    workspace_id: &str,
    version_id: &str,
    collection_path: &str,
    cache: &mut HashMap<String, GraphNode>,
    out: &mut Vec<DiscoveredEdge>,
) -> Result<(), SearchError> {
    let schema_path: Option<String> = conn
        .prepare_cached(
            "SELECT schema_path FROM collections \
             WHERE workspace_id = ?1 AND version_id = ?2 AND collection_path = ?3",
        )?
        .query_row(params![workspace_id, version_id, collection_path], |row| {
            row.get(0)
        })
        .optional()?;
    let Some(schema_path) = schema_path else {
        return Ok(());
    };
    let Some(head) =
        resolve_live_file_head_by_path(conn, policy, workspace_id, version_id, &schema_path)?
    else {
        return Ok(());
    };
    let id = format!("collection:document:{collection_path}");
    let node = if let Some(existing) = cache.get(&id) {
        existing.clone()
    } else {
        let schema_yaml =
            load_file_body_capped(conn, head.blob_sha256.as_deref(), SCHEMA_TEXT_CAP_BYTES)?
                .unwrap_or_default();
        let parsed = parse_collection_schema(&schema_yaml);
        let title = parsed
            .schema
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                collection_path
                    .rsplit('/')
                    .next()
                    .unwrap_or(collection_path)
                    .to_owned()
            });
        let node = GraphNode {
            id: id.clone(),
            kind: RetrievalKind::Collection,
            title: truncate_chars(&title, MAX_TITLE_CHARS),
            path: Some(head.path),
            object_id: Some(head.object_id),
            collection_path: Some(collection_path.to_owned()),
            record_id: None,
            thread_id: None,
            snippet: String::new(),
        };
        cache.insert(id, node.clone());
        node
    };
    out.push(DiscoveredEdge {
        edge: RetrievalEdgeKind::CollectionMember,
        direction: RetrievalEdgeDirection::Out,
        field: None,
        target: node,
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn collect_collection_records(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    resolver: &Resolver,
    workspace_id: &str,
    version_id: &str,
    collection_path: &str,
    query: &ParsedQuery,
    cache: &mut HashMap<String, GraphNode>,
    out: &mut Vec<DiscoveredEdge>,
) -> Result<(), SearchError> {
    let mut stmt = conn.prepare_cached(
        "SELECT object_id FROM collection_records \
         WHERE workspace_id = ?1 AND version_id = ?2 AND collection_path = ?3 \
           AND record_id IS NOT NULL \
         ORDER BY file_path LIMIT 6",
    )?;
    let object_ids = stmt
        .query_map(params![workspace_id, version_id, collection_path], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for object_id in object_ids {
        let Some(head) =
            resolve_live_file_head(conn, policy, workspace_id, version_id, &object_id)?
        else {
            continue;
        };
        let node = hydrate_file_node(
            conn,
            policy,
            resolver,
            &head,
            workspace_id,
            version_id,
            query,
            cache,
        )?;
        out.push(DiscoveredEdge {
            edge: RetrievalEdgeKind::CollectionMember,
            direction: RetrievalEdgeDirection::In,
            field: None,
            target: node,
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn collect_chats_for_file(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    resolver: &Resolver,
    workspace_id: &str,
    object_id: &str,
    query: &ParsedQuery,
    cache: &mut HashMap<String, GraphNode>,
    out: &mut Vec<DiscoveredEdge>,
) -> Result<(), SearchError> {
    let mut linked_stmt = conn.prepare_cached(
        "SELECT thread_id FROM chat_threads \
         WHERE workspace_id = ?1 AND linked_object_id = ?2 \
         ORDER BY updated_at_ms DESC, thread_id LIMIT ?3",
    )?;
    let linked_threads = linked_stmt
        .query_map(
            params![workspace_id, object_id, MAX_CHAT_LINKS_PER_SEED as i64],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for thread_id in linked_threads {
        if let Some(node) = hydrate_chat_node(
            conn,
            policy,
            resolver,
            workspace_id,
            &thread_id,
            query,
            cache,
        )? {
            out.push(DiscoveredEdge {
                edge: RetrievalEdgeKind::ChatLinkedFile,
                direction: RetrievalEdgeDirection::In,
                field: None,
                target: node,
            });
        }
    }

    let mut mention_stmt = conn.prepare_cached(
        "SELECT DISTINCT ca.thread_id FROM chat_attachments ca \
         JOIN chat_messages m \
           ON m.workspace_id = ca.workspace_id AND m.thread_id = ca.thread_id \
          AND m.message_id = ca.message_id \
         WHERE ca.workspace_id = ?1 AND ca.object_id = ?2 \
         ORDER BY ca.created_at_ms DESC, ca.attachment_id DESC LIMIT ?3",
    )?;
    let mentioned_threads = mention_stmt
        .query_map(
            params![workspace_id, object_id, MAX_CHAT_LINKS_PER_SEED as i64],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for thread_id in mentioned_threads {
        if let Some(node) = hydrate_chat_node(
            conn,
            policy,
            resolver,
            workspace_id,
            &thread_id,
            query,
            cache,
        )? {
            out.push(DiscoveredEdge {
                edge: RetrievalEdgeKind::ChatMention,
                direction: RetrievalEdgeDirection::In,
                field: None,
                target: node,
            });
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn collect_files_for_chat(
    conn: &Connection,
    policy: &SearchPolicySnapshot,
    resolver: &Resolver,
    workspace_id: &str,
    version_id: &str,
    thread_id: &str,
    query: &ParsedQuery,
    cache: &mut HashMap<String, GraphNode>,
    out: &mut Vec<DiscoveredEdge>,
) -> Result<(), SearchError> {
    let thread_meta: Option<(Option<String>, Option<String>)> = conn
        .prepare_cached(
            "SELECT linked_object_id, channel_id FROM chat_threads \
             WHERE workspace_id = ?1 AND thread_id = ?2",
        )?
        .query_row(params![workspace_id, thread_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    let Some((linked_object_id, channel_id)) = thread_meta else {
        return Ok(());
    };

    if let Some(object_id) = linked_object_id
        && let Some(head) =
            resolve_live_file_head(conn, policy, workspace_id, version_id, &object_id)?
    {
        let node = hydrate_file_node(
            conn,
            policy,
            resolver,
            &head,
            workspace_id,
            version_id,
            query,
            cache,
        )?;
        out.push(DiscoveredEdge {
            edge: RetrievalEdgeKind::ChatLinkedFile,
            direction: RetrievalEdgeDirection::Out,
            field: None,
            target: node,
        });
    }

    let mut attachment_objects: Vec<String> = {
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT ca.object_id FROM chat_attachments ca \
             JOIN chat_messages m \
               ON m.workspace_id = ca.workspace_id AND m.thread_id = ca.thread_id \
              AND m.message_id = ca.message_id \
             WHERE ca.workspace_id = ?1 AND ca.thread_id = ?2 AND ca.object_id IS NOT NULL \
             ORDER BY ca.created_at_ms DESC, ca.attachment_id DESC LIMIT ?3",
        )?;
        stmt.query_map(
            params![workspace_id, thread_id, MAX_CHAT_LINKS_PER_SEED as i64],
            |row| row.get(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    if let Some(channel_id) = channel_id {
        let mut stmt = conn.prepare_cached(
            "SELECT file_key FROM chat_conversation_file_links \
             WHERE workspace_id = ?1 AND channel_id = ?2 AND thread_id = ?3 AND invalid = 0 \
             ORDER BY mentioned_at_ms DESC, attachment_id DESC LIMIT ?4",
        )?;
        let conv_objects = stmt
            .query_map(
                params![
                    workspace_id,
                    channel_id,
                    thread_id,
                    MAX_CHAT_LINKS_PER_SEED as i64
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        attachment_objects.extend(conv_objects);
    }

    let mut seen_objects = HashSet::new();
    for object_id in attachment_objects {
        if !seen_objects.insert(object_id.clone()) {
            continue;
        }
        let Some(head) =
            resolve_live_file_head(conn, policy, workspace_id, version_id, &object_id)?
        else {
            continue;
        };
        let node = hydrate_file_node(
            conn,
            policy,
            resolver,
            &head,
            workspace_id,
            version_id,
            query,
            cache,
        )?;
        out.push(DiscoveredEdge {
            edge: RetrievalEdgeKind::ChatMention,
            direction: RetrievalEdgeDirection::Out,
            field: None,
            target: node,
        });
    }
    Ok(())
}
