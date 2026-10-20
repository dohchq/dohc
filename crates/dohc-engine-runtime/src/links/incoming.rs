//! Read-only incoming candidates. Probe matches are a superset; resolve each
//! parsed wikilink against the version's aliases before treating it as incoming.
use super::{Head, Work, head, parser, path_keys, sql};
use dohc_engine_storage::StorageError;
use rusqlite::{Connection, OptionalExtension, params};

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Candidates {
    pub sources: Vec<(String, String)>,
    pub unchecked: Vec<String>,
}

pub(super) const CANDIDATES_SQL: &str = "WITH candidates AS (SELECT DISTINCT k.object_id FROM json_each(?3) probe
         CROSS JOIN link_occurrence_keys k INDEXED BY link_occurrence_probe
           ON k.workspace_id=?1 AND k.version_id=?2 AND k.key_kind=json_extract(probe.value,'$[0]') AND k.key=json_extract(probe.value,'$[1]')
         JOIN link_sources s ON s.workspace_id=k.workspace_id AND s.version_id=k.version_id AND s.object_id=k.object_id AND s.index_key=k.index_key
         JOIN links l ON l.workspace_id=k.workspace_id AND l.version_id=k.version_id AND l.object_id=k.object_id AND l.index_key=k.index_key AND l.ordinal=k.ordinal
         WHERE l.kind IN (SELECT value FROM json_each(?5))
         UNION SELECT object_id FROM link_pending WHERE workspace_id=?1 AND version_id=?2
         UNION SELECT object_id FROM link_sources WHERE workspace_id=?1 AND version_id=?2 AND (status='unindexed' OR parser_generation<>?4))
         SELECT candidate.object_id,MIN(a.path),MAX(coalesce(s.status='unindexed',0))
         FROM candidates candidate
         JOIN path_aliases a INDEXED BY idx_path_aliases_workspace_object ON a.workspace_id=?1 AND a.version_id=?2 AND a.object_id=candidate.object_id
         LEFT JOIN link_sources s ON s.workspace_id=a.workspace_id AND s.version_id=a.version_id AND s.object_id=a.object_id
         GROUP BY candidate.object_id";

pub(crate) fn candidates(
    conn: &Connection,
    ws: &str,
    version: &str,
    target: &str,
    kinds: &[&str],
) -> Result<Candidates, StorageError> {
    let keys = serde_json::to_string(&path_keys(target)).expect("string pairs serialize to JSON");
    let mut stmt = conn.prepare_cached(CANDIDATES_SQL).map_err(sql)?;
    let objects = stmt
        .query_map(
            params![
                ws,
                version,
                keys,
                super::PARSER_GENERATION,
                serde_json::to_string(kinds).expect("string kinds serialize")
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                ))
            },
        )
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    let mut sources = Vec::new();
    let mut unchecked = Vec::new();
    for (object, path, unindexed) in objects {
        if unindexed {
            unchecked.push(path);
        } else {
            sources.push((object, path));
        }
    }
    let ready: bool = conn.query_row(
        "SELECT coalesce((SELECT seed_phase='ready' AND parser_generation=?3 FROM link_index_state WHERE workspace_id=?1 AND version_id=?2),0)",
        params![ws, version, super::PARSER_GENERATION], |r| r.get(0),
    ).map_err(sql)?;
    if !ready {
        let mut missing = conn.prepare_cached(
            "SELECT MIN(a.path) FROM path_aliases a WHERE a.workspace_id=?1 AND a.version_id=?2
             AND NOT EXISTS(SELECT 1 FROM link_sources s WHERE s.workspace_id=a.workspace_id AND s.version_id=a.version_id AND s.object_id=a.object_id)
             AND NOT EXISTS(SELECT 1 FROM link_pending p WHERE p.workspace_id=a.workspace_id AND p.version_id=a.version_id AND p.object_id=a.object_id)
             GROUP BY a.object_id",
        ).map_err(sql)?;
        unchecked.extend(
            missing
                .query_map(params![ws, version], |r| r.get::<_, String>(0))
                .map_err(sql)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql)?,
        );
    }
    sources.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
    unchecked.sort();
    Ok(Candidates { sources, unchecked })
}

pub(crate) struct Source {
    work: Work,
    head: Head,
}

impl Source {
    pub(crate) fn text(&self) -> Option<&str> {
        self.head.text.as_deref()
    }
    /// Run off the actor. This result is for resolution, never index publication.
    pub(crate) fn parse(self) -> Result<parser::Parsed, StorageError> {
        parser::parse(self.work, Some(self.head))
    }
}

/// Hydrate the current head, including pending edits, without draining or
/// changing the index. The caller must parse off the actor and recheck the
/// head before any later write.
pub(crate) fn read_source(
    conn: &Connection,
    ws: &str,
    version: &str,
    object: &str,
) -> Result<Option<Source>, StorageError> {
    let pending = conn.query_row(
        "SELECT pending_id,revision,queued_at_ms FROM link_pending WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![ws, version, object],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(sql)?;
    let (id, revision, queued_at_ms) = pending.unwrap_or((0, 0, 0));
    let work = Work {
        id,
        revision,
        queued_at_ms,
        workspace: ws.into(),
        version: version.into(),
        object: object.into(),
    };
    // The index's alias seed may still be incomplete.
    Ok(head(conn, &work, true, true)?.map(|head| Source { work, head }))
}
