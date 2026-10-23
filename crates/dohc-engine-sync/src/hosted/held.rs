//! The documents a hosted replica holds for retained work a released chain
//! left, as their owner reviews them: found in object ID order from durable
//! state alone, so discovery needs no editor and survives a restart, and each
//! inspected against its stored binding. Nothing here writes.

use dohc_engine_collab::live_update_application::{HeldInspection, Preservation, inspect_held};

use super::*;

/// One document the replica holds for released retained work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldDocument {
    pub object_id: String,
    /// The path its scope names it at.
    pub path: String,
    pub binding: Box<ReleasedLineageBinding>,
    pub continuation: ReleasedHoldContinuation,
    /// The stored hold already claims no currency for its binding.
    pub binding_stale: bool,
}

/// One page of [`list_held_documents`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldDocumentsPage {
    pub documents: Vec<HeldDocument>,
    /// Another page follows, after the last document of this one.
    pub has_more: bool,
}

/// Whether a held document's binding still names what its document holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeldBindingStatus {
    Current,
    /// The document, its feed or its retained work changed since the binding
    /// was derived. The next pass derives it again from the held row.
    Stale,
}

impl HeldBindingStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Stale => "stale",
        }
    }
}

/// [`inspect_held_document`]'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldDocumentInspection {
    pub document: HeldDocument,
    pub status: HeldBindingStatus,
    /// What the binding preserves; only a current binding has one.
    pub preservation: Option<Preservation>,
}

/// The largest page [`list_held_documents`] answers.
pub const MAX_HELD_DOCUMENTS_PAGE: usize = 256;

/// The documents the replica's current scope holds for released retained
/// work, in object ID order after `after_object_id`, at most `limit`. None
/// for a workspace that is not hosted.
pub fn list_held_documents(
    store: &EngineStore,
    workspace_id: &str,
    after_object_id: Option<&str>,
    limit: usize,
) -> Result<Option<HeldDocumentsPage>, SyncError> {
    if !(1..=MAX_HELD_DOCUMENTS_PAGE).contains(&limit) {
        return Err(SyncError::InvalidInput {
            reason: "held document page limit is out of range",
        });
    }
    store.read_with(|conn| {
        if !replica_exists(conn, workspace_id)? {
            return Ok(None);
        }
        let mut statement = conn
            .prepare_cached(&format!(
                "SELECT object_id,path,state,{HELD_COLUMNS} FROM hosted_documents \
                 WHERE workspace_id=?1 AND held_reason=?2 AND (?3 IS NULL OR object_id>?3) \
                 AND scope_generation=(SELECT scope_generation FROM hosted_replicas \
                   WHERE workspace_id=?1) \
                 ORDER BY object_id LIMIT ?4"
            ))
            .map_err(SyncError::corrupt)?;
        let rows = statement
            .query_map(
                params![
                    workspace_id,
                    RELEASED_LINEAGE_UNSETTLED,
                    after_object_id,
                    (limit + 1) as i64
                ],
                held_row,
            )
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?;
        let has_more = rows.len() > limit;
        let documents = rows
            .into_iter()
            .take(limit)
            .map(held_document)
            .collect::<Result<_, _>>()?;
        Ok(Some(HeldDocumentsPage {
            documents,
            has_more,
        }))
    })
}

/// The held document `object_id` of the replica's current scope, its binding
/// checked against what the store holds now and, while it stands, what it
/// preserves. Inspection reads the state of the lineage the binding names,
/// an archived one included. The hold and everything its binding names are
/// read in one transaction, so a current answer describes one state. None
/// when the workspace is not hosted or the document is not held for released
/// work.
pub fn inspect_held_document(
    store: &EngineStore,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<HeldDocumentInspection>, SyncError> {
    store.read_with(|conn| {
        read_only(conn, |tx| {
            let Some(document) = held_in(tx, workspace_id, object_id)? else {
                return Ok(None);
            };
            let preservation = if document.binding_stale || !feed_matches(tx, &document.binding)? {
                None
            } else {
                match inspect_held(tx, &document.binding)
                    .map_err(crate::ydoc_apply::protection_failure)?
                {
                    HeldInspection::Current(preservation) => Some(preservation),
                    HeldInspection::Stale => None,
                }
            };
            let status = if preservation.is_some() {
                HeldBindingStatus::Current
            } else {
                HeldBindingStatus::Stale
            };
            Ok(Some(HeldDocumentInspection {
                document,
                status,
                preservation,
            }))
        })
    })
}

/// `read` in one transaction that always rolls back, so whatever it or
/// anything it calls writes is undone and every read agrees.
fn read_only<T>(
    conn: &Connection,
    read: impl FnOnce(&Connection) -> Result<T, SyncError>,
) -> Result<T, SyncError> {
    let tx = conn.unchecked_transaction().map_err(SyncError::corrupt)?;
    let answer = read(&tx)?;
    tx.rollback().map_err(SyncError::corrupt)?;
    Ok(answer)
}

fn replica_exists(conn: &Connection, workspace_id: &str) -> Result<bool, SyncError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM hosted_replicas WHERE workspace_id=?1)",
        [workspace_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// The document's stored hold, while the replica's current scope holds it
/// for released retained work.
fn held_in(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<HeldDocument>, SyncError> {
    if !replica_exists(conn, workspace_id)? {
        return Ok(None);
    }
    conn.query_row(
        &format!(
            "SELECT object_id,path,state,{HELD_COLUMNS} FROM hosted_documents \
             WHERE workspace_id=?1 AND object_id=?2 AND held_reason=?3 \
             AND scope_generation=(SELECT scope_generation FROM hosted_replicas \
               WHERE workspace_id=?1)"
        ),
        params![workspace_id, object_id, RELEASED_LINEAGE_UNSETTLED],
        held_row,
    )
    .optional()
    .map_err(SyncError::corrupt)?
    .map(held_document)
    .transpose()
}

type HeldRow = (String, String, String, HeldColumns);

fn held_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HeldRow> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, HeldColumns::read(row, 3)?))
}

fn held_document((object_id, path, state, held): HeldRow) -> Result<HeldDocument, SyncError> {
    match decode_status(&path, &state, held)? {
        HostedDocumentStatus::Held(HostedHold::ReleasedLineageUnsettled {
            binding,
            continuation,
            binding_stale,
        }) => Ok(HeldDocument {
            object_id,
            path,
            binding,
            continuation,
            binding_stale,
        }),
        _ => Err(crate::error::local_corruption(
            "a hosted document's state is malformed",
        )),
    }
}

/// Whether the replica still reads the feed `binding`'s update arrived on.
fn feed_matches(conn: &Connection, binding: &ReleasedLineageBinding) -> Result<bool, SyncError> {
    let feed: Option<(String, String)> = conn
        .query_row(
            "SELECT replication_epoch,stream_identity FROM sync_identity WHERE workspace_id=?1",
            [&binding.workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let incoming = &binding.incoming;
    Ok(feed.as_ref().map(|(epoch, stream)| (epoch.as_str(), stream.as_str()))
        == Some((
            incoming.replication_epoch.as_str(),
            incoming.stream_identity.as_str(),
        )))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opus's r2a F4: inspection's transaction rolls back, so a write made
    /// inside it, by inspection or anything it calls, never lands.
    #[test]
    fn inspection_rolls_its_transaction_back() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE probe (value INTEGER)").unwrap();
        let count = |conn: &Connection| {
            conn.query_row("SELECT count(*) FROM probe", [], |row| row.get::<_, i64>(0))
                .map_err(SyncError::corrupt)
        };
        let inside = read_only(&conn, |tx| {
            tx.execute("INSERT INTO probe VALUES (1)", [])
                .map_err(SyncError::corrupt)?;
            count(tx)
        })
        .unwrap();
        assert_eq!(inside, 1, "the transaction reads its own write");
        assert_eq!(count(&conn).unwrap(), 0, "which never lands");
        assert!(conn.is_autocommit(), "the transaction ended");
    }
}
