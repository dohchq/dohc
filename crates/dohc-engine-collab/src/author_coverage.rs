//! Author coverage belongs to the admitted interval, independently of CRDT compaction.

use crate::{CollabError, DocKey};
use dohc_engine_domain::{ChangeActorKind, ChangeAttribution, SharedChangeAuthor};
use dohc_engine_storage::StorageError;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::BTreeMap;

pub use dohc_engine_domain::MAX_AUTHOR_ENTRY_BYTES;

/// A settlement moment names every author of its interval.
pub const MAX_INTERVAL_AUTHORS: usize = dohc_engine_domain::MAX_MOMENT_AUTHORS;
pub const MAX_INTERVAL_AUTHOR_BYTES: usize = dohc_engine_domain::MAX_AUTHOR_JSON_BYTES;
pub const SETTLE_AUTHOR_BYTE_THRESHOLD: usize = 96 * 1024;
pub const SETTLE_AUTHOR_COUNT_THRESHOLD: usize = 960;
/// Digits of the largest grant generation a shared author names (2^53 - 1).
const MAX_GRANT_GENERATION_DIGITS: usize = 16;

fn sql(error: rusqlite::Error) -> CollabError {
    StorageError::persist_public(error).into()
}

fn corrupt(reason: impl Into<String>) -> CollabError {
    CollabError::Corrupt {
        reason: reason.into(),
    }
}

/// One snapshot per scoped identity. Confirmation requires every merged entry.
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
        if kind == "unattributed" {
            if author.as_object().is_none_or(|object| object.len() != 1) {
                return Err(corrupt("invalid unattributed coverage marker"));
            }
            self.0.insert("unattributed".into(), author);
            return Ok(());
        }
        // A shared author is one identity per grant: its person or link
        // principal. A link an admitted snapshot names is its public principal.
        let (field, scope_field) = match kind {
            "agent" => ("agentId", "onBehalfOf"),
            "automation" => ("automationId", "onBehalfOf"),
            "human" => ("humanId", "onBehalfOf"),
            "named" => ("userId", "grantId"),
            "link" if author.get("publicPrincipalId").is_some() => {
                ("publicPrincipalId", "onBehalfOf")
            }
            "link" => ("principalId", "grantId"),
            _ => return Err(corrupt("unsupported live author kind")),
        };
        let id = author
            .get(field)
            .and_then(Value::as_str)
            .ok_or_else(|| corrupt("author has no identity"))?;
        let scope = author.get(scope_field).and_then(Value::as_str);
        let identity = serde_json::json!([kind, scope, id]).to_string();
        let previous = self.0.get(&identity);
        if previous.is_some_and(|previous| {
            previous.get("relayConfirmed") != Some(&Value::Bool(true))
                || author.get("relayConfirmed") != Some(&Value::Bool(true))
        }) {
            author
                .as_object_mut()
                .expect("author object")
                .remove("relayConfirmed");
        }
        let prior_depth = previous
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

    // Known ids and scopes cannot grow. Reserve their depth's, or their grant
    // generation's, largest encoding so a known author remains admissible even
    // at capacity, without truncation.
    fn admission_bytes(&self) -> usize {
        self.journal_bytes() + self.0.values().map(reserved_bytes).sum::<usize>()
    }

    pub fn moment_json(&self) -> Option<String> {
        (!self.is_empty()).then(|| self.json())
    }

    pub fn has_unattributed(&self) -> bool {
        self.0.contains_key("unattributed")
    }

    pub fn remove_unattributed(&mut self) {
        self.0.remove("unattributed");
    }
}

fn reserved_bytes(author: &Value) -> usize {
    let kind = author.get("kind").and_then(Value::as_str);
    let depth = author.get("depth").map(Value::to_string);
    let generation = author.get("grantGeneration").map(Value::to_string);
    match (kind, depth, generation) {
        (Some("agent"), None, _) => r#","depth":64"#.len(),
        (Some("agent" | "automation"), Some(depth), _) => 2 - depth.len().min(2),
        (Some("named" | "link"), _, Some(generation)) => {
            MAX_GRANT_GENERATION_DIGITS - generation.len().min(MAX_GRANT_GENERATION_DIGITS)
        }
        _ => 0,
    }
}

/// One author's share of the admission bytes. Depth and generation growth
/// leave it unchanged.
fn entry_admission_bytes(author: &Value) -> usize {
    author.to_string().len() + reserved_bytes(author)
}

/// Whether a current activation holds this lineage, or a released one left
/// carried deliveries in it. Its native log also holds the owner's edits
/// until the host applies them as accepted, so its interval names only
/// authors admitted with accepted content, never a native row's author ahead
/// of acceptance.
pub fn accepted_only_in(conn: &Connection, key: &DocKey) -> Result<bool, CollabError> {
    conn.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM ydoc_docs d JOIN {} a \
             ON a.workspace_id=d.workspace_id AND a.main_version_id=d.version_id \
             AND a.object_id=d.object_id AND a.lineage_claim_id=d.lineage_claim_id \
             WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3)",
            crate::live_update_application::owner_activations::RETAINED_ACTIVATIONS
        ),
        params![key.workspace_id, key.version_id, key.object_id],
        |row| row.get(0),
    )
    .map_err(sql)
}

/// Read only authors above the settled boundary, including rows a fold already
/// consumed and authors that accepted deliveries admitted.
/// `through` bounds native rows; pending coverage, including the marker, is interval-wide.
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
    if accepted_only_in(conn, key)? {
        return Ok(authors);
    }
    // Actorless edits and accepted snapshots retain coverage at admission.
    // Admission caps the named identities retained above the boundary.
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
        // Confirmation belongs to that settlement, not the next local interval.
        for author in authors.0.values_mut() {
            if let Some(fields) = author.as_object_mut() {
                fields.remove("relayConfirmed");
            }
        }
    }
    for author in interval_in(conn, key, i64::MAX)?.0.into_values() {
        authors.insert(author)?;
    }
    Ok(authors)
}

/// The author a collaborator's or an Edit share link's accepted delivery names.
pub fn shared_json(author: &SharedChangeAuthor) -> Result<String, CollabError> {
    if !author.is_valid() {
        return Err(corrupt("shared author is incomplete"));
    }
    Ok(dohc_engine_domain::moment_author_list_json(
        &serde_json::to_value(author).map_err(|_| corrupt("shared author is not JSON"))?,
    ))
}

/// History recovery keeps native authors too. Accepted settlement deliberately
/// excludes the owner's private tail; its outbox retains compacted provenance.
pub fn recovery_in(conn: &Connection, key: &DocKey) -> Result<Authors, CollabError> {
    let mut authors = reserved_in(conn, key)?;
    let mut statement = conn
        .prepare(
            "SELECT e.native_source_json FROM owner_ydoc_outbox_entries e
         JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id
         JOIN ydoc_docs d ON d.workspace_id=o.workspace_id AND d.version_id=o.main_version_id
           AND d.object_id=o.object_id AND d.lineage_claim_id=o.lineage_claim_id
         WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3
           AND e.pending=1 AND e.native_source_json IS NOT NULL",
        )
        .map_err(sql)?;
    let sources = statement
        .query_map(
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(sql)?;
    for source in sources {
        let source: crate::owner_outbox::OwnerOutboxSource =
            serde_json::from_str(&source.map_err(sql)?)
                .map_err(|_| corrupt("recovery native source is invalid"))?;
        if let Some(native) = source.native() {
            if let Some((actor, attribution)) = native
                .native_author()
                .map_err(|_| corrupt("recovery native author is invalid"))?
            {
                if let Some(json) =
                    dohc_engine_domain::moment_author_json(actor.as_deref(), attribution.as_ref())
                {
                    authors.union_json(&json)?;
                }
            }
        }
    }
    Ok(authors)
}

/// One author entry within the size a moment can hold.
fn entry(json: &str) -> Result<Authors, CollabError> {
    let mut incoming = Authors::default();
    incoming.union_json(json)?;
    if incoming
        .0
        .values()
        .any(|author| author.to_string().len() > MAX_AUTHOR_ENTRY_BYTES)
    {
        return Err(CollabError::AuthorEntryTooLarge);
    }
    Ok(incoming)
}

/// Adds one author to `covered`, refusing a new identity past the bounds.
/// Returns the admission bytes of the result.
fn admit(covered: &mut Authors, json: &str) -> Result<usize, CollabError> {
    let incoming = entry(json)?;
    let identity = incoming
        .0
        .keys()
        .next()
        .ok_or_else(|| corrupt("attribution has no identity"))?;
    let prior = covered.0.get(identity).map(entry_admission_bytes);
    covered.union_json(json)?;
    let bytes = covered.admission_bytes();
    // A later snapshot can still lengthen a known author's name or label.
    let grown =
        prior.is_none_or(|prior| covered.0.get(identity).map(entry_admission_bytes) > Some(prior));
    if (prior.is_none() && covered.len() > MAX_INTERVAL_AUTHORS)
        || (grown && bytes > MAX_INTERVAL_AUTHOR_BYTES)
    {
        return Err(CollabError::AuthorCapacity);
    }
    Ok(bytes)
}

pub fn check_admission_in(
    conn: &Connection,
    key: &DocKey,
    actor: Option<&str>,
    attribution: Option<&ChangeAttribution>,
) -> Result<bool, CollabError> {
    check_admission_with_coverage_in(conn, key, actor, attribution)
        .map(|admission| admission.request_settlement)
}

/// Reserve a burst's credits against one interval snapshot, before appending.
pub(crate) fn check_batch_admission_in<'a>(
    conn: &Connection,
    key: &DocKey,
    credits: impl Iterator<Item = (Option<&'a str>, Option<&'a ChangeAttribution>)>,
) -> Result<bool, CollabError> {
    let mut covered = reserved_in(conn, key)?;
    let mut seen = std::collections::BTreeSet::new();
    let mut settle = false;
    for (actor, attribution) in credits {
        let json = dohc_engine_domain::moment_author_json(actor, attribution);
        let actorless = json.is_none();
        let json = json.unwrap_or_else(|| r#"[{"kind":"unattributed"}]"#.to_owned());
        if !seen.insert(json.clone()) {
            continue;
        }
        let bytes = admit(&mut covered, &json)?;
        if actorless {
            retain_pending_in(conn, key, &[json])?;
        }
        settle |=
            bytes >= SETTLE_AUTHOR_BYTE_THRESHOLD || covered.len() >= SETTLE_AUTHOR_COUNT_THRESHOLD;
    }
    Ok(settle && !unresolved_in(conn, key)?)
}

struct Admission {
    request_settlement: bool,
    introduced_unattributed: bool,
}

fn check_admission_with_coverage_in(
    conn: &Connection,
    key: &DocKey,
    actor: Option<&str>,
    attribution: Option<&ChangeAttribution>,
) -> Result<Admission, CollabError> {
    let json = dohc_engine_domain::moment_author_json(actor, attribution);
    let actorless = json.is_none();
    let json = json.unwrap_or_else(|| r#"[{"kind":"unattributed"}]"#.to_owned());
    // An adopted owner's edit is private until the relay accepts it. Its
    // author joins the interval with that acceptance, where a settlement can
    // always make room, so only the entry itself is bounded here.
    if accepted_only_in(conn, key)? {
        entry(&json)?;
        return Ok(Admission {
            request_settlement: false,
            introduced_unattributed: false,
        });
    }
    if actorless {
        let pending: String = conn
            .query_row(
                "SELECT pending_authors_json FROM ydoc_docs \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![key.workspace_id, key.version_id, key.object_id],
                |row| row.get(0),
            )
            .map_err(sql)?;
        let mut admitted = Authors::default();
        admitted.union_json(&pending)?;
        // Repeated actorless edits add no identity or bytes. Only a new named
        // identity needs room; its admission checks capacity again, and
        // AuthorCapacity queues a settlement.
        if admitted.has_unattributed() {
            return Ok(Admission {
                request_settlement: false,
                introduced_unattributed: false,
            });
        }
    }
    let mut covered = reserved_in(conn, key)?;
    let introduced_unattributed = actorless && !covered.has_unattributed();
    let bytes = admit(&mut covered, &json)?;
    if actorless {
        retain_pending_in(conn, key, &[json])?;
    }
    Ok(Admission {
        request_settlement: (bytes >= SETTLE_AUTHOR_BYTE_THRESHOLD
            || covered.len() >= SETTLE_AUTHOR_COUNT_THRESHOLD)
            && !unresolved_in(conn, key)?,
        introduced_unattributed,
    })
}

/// A historical coordinate's verified snapshot owns its coverage, just as an
/// accepted delivery's snapshot does. Raw replication rows cannot mint it.
/// Returns whether admission introduced the unknown-author marker.
pub(crate) fn check_remote_admission_in(
    conn: &Connection,
    key: &DocKey,
    origin_id: &str,
    origin_seq: i64,
    actor: Option<&str>,
    attribution: Option<&ChangeAttribution>,
) -> Result<bool, CollabError> {
    let verified: Option<(String, String)> = conn
        .query_row(
            "SELECT a.author_json,d.pending_authors_json FROM live_audit_projection_authors a JOIN ydoc_docs d \
             ON d.workspace_id=a.workspace_id AND d.version_id=a.version_id AND d.object_id=a.object_id \
             AND d.path=a.path AND d.lineage_claim_id=a.lineage_claim_id \
             WHERE a.workspace_id=?1 AND a.origin_id=?2 AND a.origin_seq=?3 \
             AND a.version_id=?4 AND a.object_id=?5",
            params![key.workspace_id, origin_id, origin_seq, key.version_id, key.object_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(sql)?;
    if let Some((verified, pending)) = verified {
        let mut covered = Authors::default();
        covered.union_json(&pending)?;
        covered.union_json(&verified)?;
        // Identical admitted snapshots add no identity or bytes. Catch-up must
        // not scan the native interval again for every known coordinate.
        if covered.json() == pending {
            return Ok(false);
        }
        let authors: Vec<Value> = serde_json::from_str(&verified)
            .map_err(|_| corrupt("verified remote coverage is not an author list"))?;
        let entries = authors
            .into_iter()
            .map(|author| Value::Array(vec![author]).to_string())
            .collect::<Vec<_>>();
        admit_accepted_in(conn, key, &entries).map(|_| false)
    } else {
        check_admission_with_coverage_in(conn, key, actor, attribution)
            .map(|admission| admission.introduced_unattributed)
    }
}

/// Admits the authors of one accepted delivery to the current interval, under
/// the bounds a local author meets: the authors its admitted snapshot names,
/// and the collaborator or Edit share link the relay accepted it from. The
/// delivery retains no
/// attributed update row, so the interval keeps them with the authors
/// compaction folded until a settlement names them. Refuses before writing
/// when a new author would not fit.
pub fn admit_accepted_in(
    conn: &Connection,
    key: &DocKey,
    authors: &[String],
) -> Result<(), CollabError> {
    // Missing recording context is coverage too, never proof of recipient-only edits.
    let unattributed = [r#"[{"kind":"unattributed"}]"#.to_owned()];
    let authors = if authors.is_empty() {
        &unattributed
    } else {
        authors
    };
    let mut covered = reserved_in(conn, key)?;
    for json in authors {
        admit(&mut covered, json)?;
    }
    retain_pending_in(conn, key, authors)
}

fn retain_pending_in(
    conn: &Connection,
    key: &DocKey,
    authors: &[String],
) -> Result<(), CollabError> {
    let pending: String = conn
        .query_row(
            "SELECT pending_authors_json FROM ydoc_docs \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .map_err(sql)?;
    let mut admitted = Authors::default();
    admitted.union_json(&pending)?;
    for json in authors {
        admitted.union_json(json)?;
    }
    let json = admitted.json();
    if json == pending {
        return Ok(());
    }
    conn.execute(
        "UPDATE ydoc_docs SET pending_authors_json=?4 \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id, json],
    )
    .map_err(sql)?;
    Ok(())
}

/// Whether an earlier settlement's moment still reserves its authors until
/// its file write resolves. Settling again cannot release them before then.
pub fn unresolved_in(conn: &Connection, key: &DocKey) -> Result<bool, CollabError> {
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
    advance(conn, key, reserve_attempt, false)
}

/// Consume the current interval of an accepted prefix. Its file lacks the
/// owner's private native tail, so the native settled boundary stays where it
/// was: nothing may read this settlement as the file holding the native head.
pub fn advance_accepted_prefix_in(
    conn: &Connection,
    key: &DocKey,
    reserve_attempt: bool,
) -> Result<(), CollabError> {
    advance(conn, key, reserve_attempt, true)
}

fn advance(
    conn: &Connection,
    key: &DocKey,
    reserve_attempt: bool,
    keep_boundary: bool,
) -> Result<(), CollabError> {
    if unresolved_in(conn, key)? {
        return Err(CollabError::UnsettledClose);
    }
    conn.execute(
        "UPDATE ydoc_docs SET \
         settled_update_seq=CASE WHEN ?5 THEN settled_update_seq ELSE head_update_seq END, \
         pending_authors_json='[]', \
         settle_prior_update_seq=CASE WHEN ?4 THEN COALESCE(settled_update_seq,-1) ELSE NULL END \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            reserve_attempt,
            keep_boundary
        ],
    )
    .map_err(sql)?;
    clear_provisional_author_in(conn, key)?;
    Ok(())
}

/// Only the latest covered interval can still replace its provisional marker.
fn clear_provisional_author_in(conn: &Connection, key: &DocKey) -> Result<(), CollabError> {
    conn.execute(
        "DELETE FROM engine_requests WHERE request_id='sync-ydoc-provisional-author:'||json_array(?1,?2,?3) \
         AND kind='sync-ydoc-provisional-author'",
        params![key.workspace_id, key.version_id, key.object_id],
    )
    .map_err(sql)?;
    Ok(())
}

/// Reserve coverage only when this moment has a disk materialization job.
pub fn advance_moment_in(
    conn: &Connection,
    key: &DocKey,
    moment_id: &str,
    accepted_prefix: bool,
) -> Result<(), CollabError> {
    let pending: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM materialization_jobs WHERE job_id='ydoc-mat_'||?1)",
            [moment_id],
            |row| row.get(0),
        )
        .map_err(sql)?;
    advance(conn, key, pending, accepted_prefix)
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
    clear_provisional_author_in(conn, key)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ContentKind, LocalAppend, MarkerCreation, Regime, WriterDocCache, Ydoc};
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    use dohc_engine_storage::{EngineStore, NoFaults};

    /// A collaborator the interval already names can return at a later grant
    /// generation. Admission held room for that, so every known author still
    /// applies at the byte bound and the interval still fits one moment.
    #[test]
    fn a_known_shared_author_at_a_later_generation_fits_the_bound() {
        let named = |index: usize, grant_generation: i64| {
            shared_json(&SharedChangeAuthor::Named {
                user_id: format!("{index:04}{}", "u".repeat(508)),
                grant_id: format!("{index:04}{}", "g".repeat(508)),
                grant_generation,
            })
            .unwrap()
        };
        let covering = |admitted: &[String]| {
            let mut covered = Authors::default();
            for json in admitted {
                covered.union_json(json).unwrap();
            }
            covered
        };
        let mut admitted = Vec::new();
        loop {
            let json = named(admitted.len(), 1);
            match admit(&mut covering(&admitted), &json) {
                Ok(_) => admitted.push(json),
                Err(CollabError::AuthorCapacity) => break,
                Err(other) => panic!("unexpected {other:?}"),
            }
        }
        assert!(admitted.len() > 1, "the byte bound refuses a new identity");
        let mut covered = covering(&admitted);
        for index in 0..admitted.len() {
            admit(&mut covered, &named(index, 9_007_199_254_740_991))
                .expect("a known author applies at a later generation");
        }
        assert_eq!(covered.len(), admitted.len());
        assert!(covered.journal_bytes() <= MAX_INTERVAL_AUTHOR_BYTES);
        assert!(covered.json().len() <= dohc_engine_domain::MAX_AUTHOR_JSON_BYTES);
    }

    /// Identifiers made only of quotes escape to twice their size. An Edit
    /// link named that way still fits one entry at every valid generation.
    #[test]
    fn an_escaped_link_author_fits_one_entry_at_every_generation() {
        let quotes = "\"".repeat(512);
        let link = |grant_generation: i64| {
            shared_json(&SharedChangeAuthor::Link {
                grant_id: quotes.clone(),
                grant_generation,
                principal_id: quotes.clone(),
            })
            .unwrap()
        };
        let mut covered = Authors::default();
        for generation in [1, 100, 9_007_199_254_740_991] {
            admit(&mut covered, &link(generation)).expect("a known link applies");
        }
        assert_eq!(covered.len(), 1);
        // An 80-byte skeleton and two escaped 512-byte identifiers.
        assert_eq!(covered.json().len() - "[]".len(), 2_128);
    }

    /// An admitted snapshot names a link by its public principal, the relay's
    /// authority by its grant. Each stays its own author, and returns as known.
    #[test]
    fn a_snapshot_link_and_an_authority_link_are_separate_authors() {
        let snapshot = r#"[{"kind":"link","publicPrincipalId":"public_1","label":"Anonymous"}]"#;
        let authority = shared_json(&SharedChangeAuthor::Link {
            grant_id: "grant".into(),
            grant_generation: 1,
            principal_id: "holder".into(),
        })
        .unwrap();
        let mut covered = Authors::default();
        for json in [snapshot, authority.as_str(), snapshot, authority.as_str()] {
            admit(&mut covered, json).expect("a link applies");
        }
        assert_eq!(covered.len(), 2);
    }

    #[test]
    fn remote_admission_does_not_introduce_a_reserved_unattributed_marker() {
        let scratch = dohc_test_scratch::ScratchDir::new().unwrap();
        let mut store = EngineStore::open(&scratch.join("engine.db"), 1).unwrap();
        let key = DocKey::new("ws", "main", "object").unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        let moment = VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: key.workspace_id.clone(),
                    version_id: key.version_id.clone(),
                    object_id: key.object_id.clone(),
                    path: "note.txt".into(),
                    text: "unproven local edit".into(),
                    moment_id: "local-settlement".into(),
                    metadata_origin: "ydoc".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: Some(r#"[{"kind":"human","humanId":"recipient","relayConfirmed":true},{"kind":"unattributed"}]"#.into()),
                    now_ms: 3,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap()
            .moment;
        crate::record_local_update(
            &mut store,
            &mut WriterDocCache::new(),
            &key,
            &Ydoc::wire().plaintext_insert(0, "unproven local edit"),
            LocalAppend {
                marker: Some(MarkerCreation {
                    path: Some("note.txt"),
                    content_kind: ContentKind::Plaintext,
                    regime: Regime::LocalOnly,
                }),
                ..LocalAppend::default()
            },
            &NoFaults,
            2,
            |_, _, _| Ok(()),
        )
        .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                // Model the reservation before materialization compensation.
                advance_in(tx, &key, true)?;
                tx.execute("UPDATE ydoc_docs SET settle_seq=?1", [moment.moment_order])
                    .map_err(sql)?;
                assert!(unresolved_in(tx, &key)?);
                assert!(interval_in(tx, &key, i64::MAX)?.is_empty());
                let reserved = reserved_in(tx, &key)?;
                assert!(reserved.has_unattributed());
                let reserved_json: Value = serde_json::from_str(&reserved.json()).unwrap();
                assert_eq!(reserved_json, serde_json::json!([{ "kind": "human", "humanId": "recipient" }, { "kind": "unattributed" }]));
                assert!(
                    !check_remote_admission_in(tx, &key, "remote", 1, None, None)?,
                    "the unresolved local settlement already reserves the marker"
                );
                assert!(interval_in(tx, &key, i64::MAX)?.has_unattributed());
                assert!(!check_remote_admission_in(
                    tx, &key, "remote", 2, None, None
                )?);
                compensate_in(tx, &key, None, 4)?;
                assert!(interval_in(tx, &key, i64::MAX)?.has_unattributed());
                Ok::<_, CollabError>(())
            })
            .unwrap();
    }
}

#[cfg(test)]
mod confirmation_tests {
    use super::Authors;
    use serde_json::json;

    #[test]
    fn confirmation_requires_every_entry_for_an_identity_in_either_order() {
        let plain = json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"}]);
        let confirmed = json!([{"kind":"human","humanId":"recipient","humanName":"Recipient","relayConfirmed":true}]);
        for (first, second) in [(&plain, &confirmed), (&confirmed, &plain)] {
            let mut authors = Authors::default();
            authors.union_json(&first.to_string()).unwrap();
            authors.union_json(&second.to_string()).unwrap();
            assert_eq!(authors.json(), plain.to_string());
        }
        let mut authors = Authors::default();
        authors.union_json(r#"[{"kind":"unattributed"}]"#).unwrap();
        authors.union_json(&confirmed.to_string()).unwrap();
        authors.union_json(&confirmed.to_string()).unwrap();
        assert_eq!(
            authors.json(),
            json!([confirmed[0].clone(), {"kind":"unattributed"}]).to_string()
        );
    }
}
