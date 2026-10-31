//! The file a settlement left, proven against accepted history. A successor's
//! capture and a disk capture in a released chain's window both read it.
use super::*;
use crate::{ContentKind, Ydoc};

/// What a settlement proves its file showed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettledBaseEvidence {
    pub moment_id: String,
    pub source_digest: String,
    pub binding: LiveObjectBinding,
    pub terminal_cursor: i64,
    pub state_vector_digest: String,
    /// The file's exact text: accepted state's projection by the reader's
    /// proof or the settled-source rule.
    pub source: String,
}

const UNEXPLAINED: &str = "ordinary activation source does not match imported document";

pub(super) fn unexplained() -> ApplicationError {
    invalid(UNEXPLAINED)
}

/// Whether `error` is [`unexplained`]'s refusal.
pub(super) fn is_unexplained(error: &ApplicationError) -> bool {
    matches!(error, ApplicationError::InvalidInput(message) if *message == UNEXPLAINED)
}

/// Which of the namespace's settlements of a lineage a proof reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Settlement {
    /// The latest.
    Latest,
    /// The latest, which must end at this cursor.
    LatestAt(i64),
    /// The one ending at this cursor, whatever settled after it.
    At(i64),
}

/// The Y.Doc the file at `path` showed, rebuilt from accepted history. The
/// settlement `at` selects must be an ordinary one that recorded the file's
/// moment and bytes with a canonical binding at this document, lineage and
/// path. Accepted state at its terminal, its blobs charged to `budget`, must
/// have the settlement's state vector and project to exactly the file: by
/// the `resolver`'s proof for a note the engine's reader built, or else by
/// the settled-source rule. Anything else refuses.
#[allow(clippy::too_many_arguments)]
pub(super) fn settled_base(
    conn: &Connection,
    namespace: &str,
    key: &DocKey,
    path: &str,
    lineage: &str,
    (moment, source_digest, source_length): (&str, &str, i64),
    at: Settlement,
    budget: &mut restore_content::Budget,
    resolver: Option<&crate::reader_resolver::ReaderResolver>,
) -> Result<(Ydoc, SettledBaseEvidence), ApplicationError> {
    type Settled = (i64, String, String, String, String, String, String);
    let exact = match at {
        Settlement::At(cursor) => Some(cursor),
        Settlement::Latest | Settlement::LatestAt(_) => None,
    };
    let settled: Option<Settled> = conn.query_row(
        "SELECT terminal_cursor,settlement_kind,moment_id,markdown_digest,source_state_vector_digest,binding_json,host_coordinate_json
         FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3
           AND object_id=?4 AND lineage_claim_id=?5 AND (?6 IS NULL OR terminal_cursor=?6)
         ORDER BY terminal_cursor DESC LIMIT 1",
        params![namespace, key.workspace_id, key.version_id, key.object_id, lineage, exact],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
    ).optional().map_err(read_sql)?;
    let Some((terminal, kind, settled_moment, markdown, vector, binding, coordinate)) = settled
    else {
        return Err(unexplained());
    };
    let binding: LiveObjectBinding =
        serde_json::from_str(&binding).map_err(|_| ApplicationError::Corrupt)?;
    binding
        .validate_canonical()
        .map_err(|_| ApplicationError::Corrupt)?;
    if matches!(at, Settlement::LatestAt(cursor) if cursor != terminal)
        || kind != "ordinary"
        || settled_moment != moment
        || markdown != source_digest
        || binding.workspace_id != key.workspace_id
        || binding.main_version_id != key.version_id
        || binding.object_id != key.object_id
        || binding.lineage_claim_id != lineage
        || binding.current_path != path
    {
        return Err(unexplained());
    }
    let coordinate = serde_json::from_str(&coordinate).map_err(|_| ApplicationError::Corrupt)?;
    let state = super::accepted_history::read_state_by_identity(
        conn,
        namespace,
        binding.clone(),
        coordinate,
        terminal,
        budget,
    )?;
    if hex_sha256(&state.encode_state_vector()) != vector {
        return Err(unexplained());
    }
    let projection = state.project(ContentKind::Richdoc)?.content;
    // A note the reader built shows its file by the reader's proof. One the
    // reader cannot prove, as an edited one, falls to the settled-source rule.
    let proved = if state.has_reader_source() {
        let authority = serde_json::to_string(&(namespace, &binding, terminal))
            .map_err(|_| ApplicationError::Corrupt)?;
        match crate::reader_snapshot::resolve(
            conn,
            key,
            &state,
            &projection,
            &crate::reader_snapshot::SnapshotIdentity {
                moment,
                path,
                digest: source_digest,
                lineage,
                restore_fence: None,
                authority: &authority,
            },
            resolver,
        ) {
            Ok(text) => Some(text),
            Err(CollabError::MarkdownReaderUnavailable) => None,
            Err(error) => return Err(error.into()),
        }
    } else {
        None
    };
    let text = match proved {
        Some(text) => text,
        None => state
            .settled_markdown_source(&projection, || {
                conn.query_row(
                    "SELECT text FROM blobs WHERE sha256=?1",
                    [source_digest],
                    |row| row.get(0),
                )
                .optional()
                .map(Option::flatten)
                .map_err(read_sql)
            })?
            .unwrap_or(projection),
    };
    if text.len() as i64 != source_length || hex_sha256(text.as_bytes()) != source_digest {
        return Err(unexplained());
    }
    Ok((
        state,
        SettledBaseEvidence {
            moment_id: settled_moment,
            source_digest: markdown,
            binding,
            terminal_cursor: terminal,
            state_vector_digest: vector,
            source: text,
        },
    ))
}

/// What a disk capture may do with a lineage a released chain left.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleasedCapture {
    /// No released chain holds the lineage, or the file is proven to show
    /// the whole Y.Doc: capture folds the file as ever.
    Ordinary,
    /// The file holds the bytes capture last recorded: the Y.Doc, and the
    /// tail it holds, stay as they are, and capture writes nothing.
    Unchanged,
}

/// The proof input one disk capture may read: a checkpoint and its suffix.
pub const RELEASED_CAPTURE_PROOF_BYTES: usize = 2 * crate::limits::MAX_YDOC_UPDATE_BYTES;

/// Every namespace holding an activation of a document lineage. Each capture
/// of a document with a Y.Doc and no current activation runs it.
pub(super) const LINEAGE_NAMESPACES_SQL: &str =
    "SELECT DISTINCT relay_database_namespace FROM live_owner_activations
     WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4
     ORDER BY relay_database_namespace";

/// The released window of a document lineage: no activation of it is current
/// in any namespace, and each namespace listed, in namespace order, keeps a
/// released chain tail, named beside it. A namespace with activations of the
/// lineage and no tail is corrupt. Empty outside the window. Disk capture and
/// synced ingress each decide their own policy inside it.
pub(super) fn released_window(
    conn: &Connection,
    key: &DocKey,
    lineage: &str,
) -> Result<Vec<(String, String)>, ApplicationError> {
    #[cfg(test)]
    WINDOW_READS_HERE.with(|reads| reads.set(reads.get() + 1));
    if owner_activations::current_activation(conn, None, key, lineage)?.is_some() {
        return Ok(Vec::new());
    }
    let namespaces = conn
        .prepare(LINEAGE_NAMESPACES_SQL)
        .map_err(read_sql)?
        .query_map(
            params![key.workspace_id, key.version_id, key.object_id, lineage],
            |row| row.get::<_, String>(0),
        )
        .map_err(read_sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(read_sql)?;
    let mut tails = Vec::new();
    for namespace in namespaces {
        let tail = owner_activations::released_chain_tail(conn, &namespace, key, lineage)?
            .ok_or(ApplicationError::Corrupt)?;
        tails.push((namespace, tail));
    }
    Ok(tails)
}

#[cfg(test)]
thread_local! {
    static WINDOW_READS_HERE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// How many released windows the calling thread read.
#[cfg(test)]
pub(super) fn released_window_reads_on_this_thread() -> u64 {
    WINDOW_READS_HERE.with(std::cell::Cell::get)
}

/// Decide, before capture records `text` at `path`, what it may do with the
/// lineage's Y.Doc `head`. Only the [released window](released_window) is
/// decided here. There the fold would rewrite `head` to the file, deleting
/// whatever the chain's settlement never projected. Bytes capture last
/// recorded change nothing. Changed bytes fold only over a base proven to be
/// the file, structurally `head`, with no dependency missing, within
/// `max_bytes` of proof input. Anything else refuses.
pub fn released_capture(
    conn: &Connection,
    key: &DocKey,
    lineage: &str,
    path: &str,
    text: &str,
    head: &Ydoc,
    max_bytes: usize,
) -> Result<ReleasedCapture, ApplicationError> {
    let mut tails = Vec::new();
    for (namespace, tail) in released_window(conn, key, lineage)? {
        // A tail whose record does not read refuses, never captures.
        super::retirement::released_tail(conn, &namespace, &tail)?;
        tails.push(namespace);
    }
    if tails.is_empty() {
        return Ok(ReleasedCapture::Ordinary);
    }
    let snapshot: Option<(String, String, i64)> = conn.query_row(
        "SELECT s.latest_moment_id,s.blob_sha256,b.byte_length FROM snapshots s
         JOIN path_aliases p USING(workspace_id,version_id,object_id,path)
         JOIN moments m ON m.workspace_id=s.workspace_id AND m.version_id=s.version_id AND m.object_id=s.object_id
            AND m.moment_id=s.latest_moment_id AND m.path=s.path AND m.after_blob_sha256=s.blob_sha256 AND m.after_content_kind='text'
         JOIN blobs b ON b.sha256=s.blob_sha256
         WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.path=?4 AND s.content_kind='text'",
        params![key.workspace_id, key.version_id, key.object_id, path],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(read_sql)?;
    let Some((moment, digest, length)) = snapshot else {
        return Err(unexplained());
    };
    if hex_sha256(text.as_bytes()) == digest {
        return Ok(ReleasedCapture::Unchanged);
    }
    let mut budget = restore_content::Budget {
        remaining: max_bytes,
    };
    let mut refused = None;
    for namespace in &tails {
        let source = (moment.as_str(), digest.as_str(), length);
        // Disk capture runs without the reader, so a note it built folds only
        // over a base the settled-source rule proves.
        match settled_base(
            conn,
            namespace,
            key,
            path,
            lineage,
            source,
            Settlement::Latest,
            &mut budget,
            None,
        ) {
            Ok((base, _)) => {
                if base.has_missing_updates() || head.has_missing_updates() {
                    return Err(ApplicationError::Conflict);
                }
                if !crate::replay_parity::structurally_equal_v2(&base, head)? {
                    return Err(ApplicationError::Conflict);
                }
                return Ok(ReleasedCapture::Ordinary);
            }
            Err(error) => {
                refused.get_or_insert(error);
            }
        }
    }
    Err(refused.unwrap_or_else(unexplained))
}
