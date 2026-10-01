//! Author coverage belongs to the admitted interval, independently of CRDT compaction.

use crate::{CollabError, DocKey};
use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
use dohc_engine_storage::StorageError;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::BTreeMap;

pub use dohc_engine_domain::MAX_AUTHOR_ENTRY_BYTES;

/// A settlement moment names every author of its interval.
pub const MAX_INTERVAL_AUTHORS: usize = dohc_engine_domain::MAX_MOMENT_AUTHORS;
pub const MAX_INTERVAL_AUTHOR_BYTES: usize = dohc_engine_domain::MAX_AUTHOR_JSON_BYTES;
pub const SETTLE_AUTHOR_BYTE_THRESHOLD: usize = 96 * 1024;
pub const SETTLE_AUTHOR_COUNT_THRESHOLD: usize = 960;

fn sql(error: rusqlite::Error) -> CollabError {
    StorageError::persist_public(error).into()
}

fn corrupt(reason: impl Into<String>) -> CollabError {
    CollabError::Corrupt {
        reason: reason.into(),
    }
}

/// One snapshot per scoped identity. Later admissions replace the summary snapshot.
#[derive(Default)]
pub struct Authors(BTreeMap<String, Value>);

impl Authors {
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn insert(&mut self, mut author: Value) -> Result<(), CollabError> {
        let kind = author
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| corrupt("author has no kind"))?;
        let field = match kind {
            "agent" => "agentId",
            "automation" => "automationId",
            "human" => "humanId",
            _ => return Err(corrupt("unsupported live author kind")),
        };
        let id = author
            .get(field)
            .and_then(Value::as_str)
            .ok_or_else(|| corrupt("author has no identity"))?;
        let scope = author.get("onBehalfOf").and_then(Value::as_str);
        let identity = serde_json::json!([kind, scope, id]).to_string();
        let prior_depth = self
            .0
            .get(&identity)
            .and_then(|previous| previous.get("depth"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if prior_depth > author.get("depth").and_then(Value::as_u64).unwrap_or(0) {
            author["depth"] = Value::from(prior_depth);
        }
        self.0.insert(identity, author);
        Ok(())
    }

    pub fn union_json(&mut self, json: &str) -> Result<(), CollabError> {
        let entries: Vec<Value> = serde_json::from_str(json)
            .map_err(|_| corrupt("author coverage is not an author list"))?;
        for entry in entries {
            self.insert(entry)?;
        }
        Ok(())
    }

    pub fn json(&self) -> String {
        Value::Array(self.0.values().cloned().collect()).to_string()
    }

    /// Escaped JSON bytes as embedded in moment.append, including punctuation.
    pub fn journal_bytes(&self) -> usize {
        self.json().len()
    }

    // Known ids and scopes cannot grow. Reserve their depth's largest encoding
    // so a known author remains admissible even at capacity, without truncation.
    fn admission_bytes(&self) -> usize {
        self.journal_bytes()
            + self
                .0
                .values()
                .map(|author| {
                    let kind = author.get("kind").and_then(Value::as_str);
                    let depth = author.get("depth").map(Value::to_string);
                    match (kind, depth) {
                        (Some("agent"), None) => r#","depth":64"#.len(),
                        (Some("agent" | "automation"), Some(depth)) => 2 - depth.len().min(2),
                        _ => 0,
                    }
                })
                .sum::<usize>()
    }

    pub fn moment_json(&self) -> Option<String> {
        (!self.is_empty()).then(|| self.json())
    }
}

/// Read only authors above the settled boundary, including rows a fold already consumed.
pub fn interval_in(conn: &Connection, key: &DocKey, through: i64) -> Result<Authors, CollabError> {
    let (boundary, pending): (Option<i64>, String) = conn
        .query_row(
            "SELECT settled_update_seq, pending_authors_json FROM ydoc_docs \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(sql)?;
    let mut authors = Authors::default();
    authors.union_json(&pending)?;
    // Admission caps distinct identities, so this returns at most
    // MAX_INTERVAL_AUTHORS rows from the retained rows above the boundary.
    let mut stmt = conn
        .prepare_cached(
            "SELECT actor_origin_id, actor_kind, on_behalf_of, MAX(chain_depth) FROM ydoc_updates \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
         AND seq>COALESCE(?4,-1) AND seq<=?5 AND is_seed=0 \
         AND actor_kind IN ('human','agent','automation') AND actor_origin_id IS NOT NULL \
         GROUP BY actor_kind, on_behalf_of, actor_origin_id",
        )
        .map_err(sql)?;
    let rows = stmt
        .query_map(
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                boundary,
                through
            ],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<u32>>(3)?,
                ))
            },
        )
        .map_err(sql)?;
    for row in rows {
        let (actor, kind, on_behalf_of, depth) = row.map_err(sql)?;
        let attribution = kind
            .as_deref()
            .and_then(ChangeActorKind::parse)
            .map(|actor_kind| ChangeAttribution {
                actor_kind,
                on_behalf_of,
                depth: depth.unwrap_or(0),
                run: None,
            });
        if let Some(json) =
            dohc_engine_domain::moment_author_json(actor.as_deref(), attribution.as_ref())
        {
            authors.union_json(&json)?;
        }
    }
    Ok(authors)
}

pub fn fold_in(conn: &Connection, key: &DocKey, through: i64) -> Result<(), CollabError> {
    let authors = interval_in(conn, key, through)?;
    conn.execute(
        "UPDATE ydoc_docs SET pending_authors_json=?4 \
        WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            authors.json()
        ],
    )
    .map_err(sql)?;
    Ok(())
}

/// Include the unresolved moment's reserved identities before admitting another author.
pub fn reserved_in(conn: &Connection, key: &DocKey) -> Result<Authors, CollabError> {
    let mut authors = Authors::default();
    let reserved: Option<String> = conn
        .query_row(
            "SELECT m.author_json FROM ydoc_docs d JOIN moments m \
         ON m.workspace_id=d.workspace_id AND m.version_id=d.version_id \
         AND m.object_id=d.object_id AND m.moment_order=d.settle_seq \
         WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3 \
         AND d.settle_prior_update_seq IS NOT NULL",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql)?
        .flatten();
    if let Some(json) = reserved {
        authors.union_json(&json)?;
    }
    for author in interval_in(conn, key, i64::MAX)?.0.into_values() {
        authors.insert(author)?;
    }
    Ok(authors)
}

pub fn check_admission_in(
    conn: &Connection,
    key: &DocKey,
    actor: Option<&str>,
    attribution: Option<&ChangeAttribution>,
) -> Result<bool, CollabError> {
    let Some(json) = dohc_engine_domain::moment_author_json(actor, attribution) else {
        return Ok(false);
    };
    let mut incoming = Authors::default();
    incoming.union_json(&json)?;
    if incoming
        .0
        .values()
        .any(|author| author.to_string().len() > MAX_AUTHOR_ENTRY_BYTES)
    {
        return Err(CollabError::AuthorEntryTooLarge);
    }
    let identity = incoming
        .0
        .keys()
        .next()
        .ok_or_else(|| corrupt("attribution has no identity"))?;
    let mut covered = reserved_in(conn, key)?;
    let known = covered.0.contains_key(identity);
    covered.union_json(&json)?;
    let bytes = covered.admission_bytes();
    if !known && (covered.len() > MAX_INTERVAL_AUTHORS || bytes > MAX_INTERVAL_AUTHOR_BYTES) {
        return Err(CollabError::AuthorCapacity);
    }
    Ok(
        (bytes >= SETTLE_AUTHOR_BYTE_THRESHOLD || covered.len() >= SETTLE_AUTHOR_COUNT_THRESHOLD)
            && !unresolved_in(conn, key)?,
    )
}

fn unresolved_in(conn: &Connection, key: &DocKey) -> Result<bool, CollabError> {
    conn.query_row(
        "SELECT settle_prior_update_seq IS NOT NULL FROM ydoc_docs \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id],
        |row| row.get(0),
    )
    .map_err(sql)
}

/// Consume the current interval with its boundary, reserving a materialization attempt if needed.
pub fn advance_in(
    conn: &Connection,
    key: &DocKey,
    reserve_attempt: bool,
) -> Result<(), CollabError> {
    if unresolved_in(conn, key)? {
        return Err(CollabError::UnsettledClose);
    }
    conn.execute(
        "UPDATE ydoc_docs SET settled_update_seq=head_update_seq,pending_authors_json='[]', \
         settle_prior_update_seq=CASE WHEN ?4 THEN COALESCE(settled_update_seq,-1) ELSE NULL END \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            reserve_attempt
        ],
    )
    .map_err(sql)?;
    Ok(())
}

/// Reserve coverage only when this moment has a disk materialization job.
pub fn advance_moment_in(
    conn: &Connection,
    key: &DocKey,
    moment_id: &str,
) -> Result<(), CollabError> {
    let pending: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM materialization_jobs WHERE job_id='ydoc-mat_'||?1)",
            [moment_id],
            |row| row.get(0),
        )
        .map_err(sql)?;
    advance_in(conn, key, pending)
}

/// Restore coverage once. The moment stays in history, even when its file write failed.
pub fn compensate_in(
    conn: &Connection,
    key: &DocKey,
    moment_id: Option<&str>,
    now_ms: i64,
) -> Result<(), CollabError> {
    let prior: Option<i64> = conn.query_row(
        "SELECT settle_prior_update_seq FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id], |row| row.get(0),
    ).map_err(sql)?;
    let Some(prior) = prior else {
        if let Some(moment_id) = moment_id {
            conn.execute(
                "UPDATE ydoc_docs SET last_settled_sha=NULL, updated_at_ms=?4 \
            WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
            AND EXISTS(SELECT 1 FROM snapshots s WHERE s.workspace_id=?1 AND s.version_id=?2 \
                AND s.object_id=?3 AND s.latest_moment_id=?5 AND s.blob_sha256=ydoc_docs.last_settled_sha)",
                params![key.workspace_id, key.version_id, key.object_id, now_ms, moment_id],
            )
            .map_err(sql)?;
        }
        return Ok(());
    };
    if let Some(moment_id) = moment_id {
        let owns_attempt: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM moments m JOIN ydoc_docs d \
             ON m.workspace_id=d.workspace_id AND m.version_id=d.version_id AND m.object_id=d.object_id \
             AND m.moment_order=d.settle_seq WHERE d.workspace_id=?1 AND d.version_id=?2 \
             AND d.object_id=?3 AND m.moment_id=?4)",
            params![key.workspace_id, key.version_id, key.object_id, moment_id], |row| row.get(0),
        ).map_err(sql)?;
        if !owns_attempt {
            return Ok(());
        }
    }
    let authors = reserved_in(conn, key)?;
    conn.execute(
        "UPDATE ydoc_docs SET settled_update_seq=NULLIF(?4,-1), pending_authors_json=?5, \
         last_settled_sha=NULL, settle_prior_update_seq=NULL, updated_at_ms=?6 \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            prior,
            authors.json(),
            now_ms
        ],
    )
    .map_err(sql)?;
    Ok(())
}

/// End a lineage's coverage before its rows are removed or its sequence is rebased.
pub fn reset_in(conn: &Connection, key: &DocKey, retain_content: bool) -> Result<(), CollabError> {
    let updated: Option<i64> = conn.query_row(
        "SELECT updated_at_ms FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id], |row| row.get(0),
    ).optional().map_err(sql)?;
    let Some(now_ms) = updated else {
        return Ok(());
    };
    if retain_content && !reconcile_in(conn, key, now_ms)? {
        return Err(CollabError::UnsettledClose);
    }
    if retain_content {
        fold_in(conn, key, i64::MAX)?;
    }
    conn.execute(
        "UPDATE ydoc_docs SET settled_update_seq=NULL,settle_prior_update_seq=NULL, \
         last_settled_sha=CASE WHEN ?4 THEN last_settled_sha ELSE NULL END, \
         pending_authors_json=CASE WHEN ?4 THEN pending_authors_json ELSE '[]' END \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            retain_content
        ],
    )
    .map_err(sql)?;
    Ok(())
}

/// Reconcile terminal jobs too: their status can commit before the caller compensates.
pub fn reconcile_in(conn: &Connection, key: &DocKey, now_ms: i64) -> Result<bool, CollabError> {
    let attempt: Option<String> = conn
        .query_row(
            "SELECT j.status \
         FROM ydoc_docs d JOIN moments m ON m.workspace_id=d.workspace_id \
         AND m.version_id=d.version_id AND m.object_id=d.object_id AND m.moment_order=d.settle_seq \
         JOIN materialization_jobs j ON j.job_id='ydoc-mat_'||m.moment_id \
         WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3 \
         AND d.settle_prior_update_seq IS NOT NULL",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql)?;
    match attempt {
        Some(status) if status == "pending" => Ok(false),
        Some(status) if status == "complete" => {
            conn.execute(
                "UPDATE ydoc_docs SET settle_prior_update_seq=NULL \
                WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(sql)?;
            Ok(true)
        }
        Some(_) => {
            compensate_in(conn, key, None, now_ms)?;
            Ok(true)
        }
        None => {
            let unresolved: bool = conn.query_row(
                "SELECT settle_prior_update_seq IS NOT NULL FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![key.workspace_id, key.version_id, key.object_id], |row| row.get(0),
            ).optional().map_err(sql)?.unwrap_or(false);
            if unresolved {
                return Err(corrupt("settlement attempt has no materialization job"));
            }
            Ok(true)
        }
    }
}

/// A newer local head supersedes the unresolved attempt. Its moment already
/// names the reserved authors, so cancel its write instead of crediting them again.
pub fn supersede_in(conn: &Connection, key: &DocKey, now_ms: i64) -> Result<(), CollabError> {
    if reconcile_in(conn, key, now_ms)? {
        return Ok(());
    }
    conn.execute(
        "UPDATE materialization_jobs SET status='cancelled', completed_at_ms=?4 \
         WHERE status='pending' AND job_id=(SELECT 'ydoc-mat_'||m.moment_id \
         FROM ydoc_docs d JOIN moments m ON m.workspace_id=d.workspace_id \
         AND m.version_id=d.version_id AND m.object_id=d.object_id AND m.moment_order=d.settle_seq \
         WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3)",
        params![key.workspace_id, key.version_id, key.object_id, now_ms],
    )
    .map_err(sql)?;
    conn.execute(
        "UPDATE ydoc_docs SET settle_prior_update_seq=NULL \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id],
    )
    .map_err(sql)?;
    Ok(())
}

pub fn reconcile_workspace_in(
    conn: &Connection,
    workspace_id: &str,
    now_ms: i64,
) -> Result<(), CollabError> {
    let mut stmt = conn.prepare("SELECT version_id,object_id FROM ydoc_docs WHERE workspace_id=?1 AND settle_prior_update_seq IS NOT NULL").map_err(sql)?;
    let keys = stmt
        .query_map([workspace_id], |row| {
            Ok(DocKey {
                workspace_id: workspace_id.to_owned(),
                version_id: row.get(0)?,
                object_id: row.get(1)?,
            })
        })
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    for key in keys {
        reconcile_in(conn, &key, now_ms)?;
    }
    Ok(())
}
