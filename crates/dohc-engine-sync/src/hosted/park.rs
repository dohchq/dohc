//! Parking a hosted document that left the scope. The replica keeps
//! everything its return needs to resume live editing: its moments, its
//! Y.Doc, its activation and adoption, its accepted work, restore fences and
//! receipts, and its journal, whose rows the return skips as redelivered.
//! Parking releases only what holds a path here: its heads and path aliases
//! move to the parked tables, which keep their bytes, and its file is
//! recorded as a [retired file](RetiredFile), which holds its path until the
//! file is gone. On its return, its heads come back once nothing holds their
//! paths, the same gate a replayed row meets.

use dohc_engine_storage::text;
use std::collections::HashMap;

use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{Connection, ToSql, params};

use super::{DOCUMENT_NAMED_SQL, HostedHold};
use crate::SyncError;

/// A hosted document outside the current scope that still holds state here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepartedDocument {
    pub object_id: String,
    /// Its head in each version.
    pub heads: Vec<DepartedHead>,
    /// The versions holding a Y.Doc lineage of it.
    pub ydoc_versions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepartedHead {
    pub version_id: String,
    pub path: String,
    /// The digest of the head's bytes, as its file holds them.
    pub sha256: String,
}

/// The hosted documents outside the current scope that have not parked, by
/// object id.
pub fn departed_hosted_documents(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<DepartedDocument>, SyncError> {
    store.read_with(|conn| {
        let object_ids = strings(
            conn,
            "SELECT d.object_id FROM hosted_documents d \
             JOIN hosted_replicas h ON h.workspace_id=d.workspace_id \
             WHERE d.workspace_id=?1 AND d.scope_generation<>h.scope_generation \
               AND d.state<>'parked' \
             ORDER BY d.object_id",
            &[&workspace_id],
        )?;
        object_ids
            .into_iter()
            .map(|object_id| {
                let heads = conn
                    .prepare(
                        "SELECT version_id,path,COALESCE(blob_sha256,binary_sha256) FROM snapshots \
                         WHERE workspace_id=?1 AND object_id=?2 ORDER BY version_id",
                    )
                    .map_err(SyncError::corrupt)?
                    .query_map(params![workspace_id, object_id], |row| {
                        Ok(DepartedHead {
                            version_id: row.get(0)?,
                            path: row.get(1)?,
                            sha256: row.get(2)?,
                        })
                    })
                    .map_err(SyncError::corrupt)?
                    .collect::<Result<_, _>>()
                    .map_err(SyncError::corrupt)?;
                let ydoc_versions = strings(
                    conn,
                    "SELECT version_id FROM ydoc_docs WHERE workspace_id=?1 AND object_id=?2 \
                     ORDER BY version_id",
                    &[&workspace_id, &object_id],
                )?;
                Ok(DepartedDocument {
                    object_id,
                    heads,
                    ydoc_versions,
                })
            })
            .collect()
    })
}

/// The hosted documents outside the current scope that this replica has not
/// finished releasing, by object id: it has not parked, or its retired file
/// remains. A parked document whose file is gone is gone from the host. A
/// file retired before retired files named their document names none.
pub fn departed_hosted_object_ids(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<String>, SyncError> {
    store.read_with(|conn| {
        strings(
            conn,
            "SELECT d.object_id FROM hosted_documents d \
             JOIN hosted_replicas h ON h.workspace_id=d.workspace_id \
             WHERE d.workspace_id=?1 AND d.scope_generation<>h.scope_generation \
               AND d.state<>'parked' \
             UNION SELECT object_id FROM hosted_retired_files \
             WHERE workspace_id=?1 AND object_id IS NOT NULL \
             ORDER BY 1",
            &[&workspace_id],
        )
    })
}

/// Park `object_id`, a hosted document that left the scope. Answers `false`,
/// changing nothing, while it is not [parkable](hosted_document_parkable).
/// The caller first proves that its Y.Doc settled into its head and that its
/// file holds nothing else. Its head in `version_id`, the version the root
/// holds, becomes a retired file for the caller to remove. Work the relay
/// served that it never journaled is released, as a hold releases it; its
/// return fetches that work again.
pub fn park_hosted_document(
    store: &mut EngineStore,
    workspace_id: &str,
    object_id: &str,
    version_id: &str,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<bool>, SyncError> {
    store.write_with(faults, |tx| {
        if !parkable(tx, workspace_id, object_id)? {
            return Ok(false);
        }
        // Removing a head clears the export state its Y.Doc keeps, which a
        // parked document keeps as it was.
        let exports = tx
            .prepare(
                "SELECT version_id,sharing_declined_json,file_export_lane FROM ydoc_docs \
                 WHERE workspace_id=?1 AND object_id=?2",
            )
            .map_err(SyncError::corrupt)?
            .query_map(params![workspace_id, object_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?;
        let bound: [&dyn ToSql; 3] = [&workspace_id, &object_id, &version_id];
        for sql in PARK {
            execute(tx, sql, &bound)?;
        }
        for (version, declined, lane) in exports {
            tx.execute(
                "UPDATE ydoc_docs SET sharing_declined_json=?4,file_export_lane=?5 \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![workspace_id, version, object_id, declined, lane],
            )
            .map_err(SyncError::persist)?;
        }
        crate::deferred::release_hosted_in_tx(tx, workspace_id, object_id)?;
        Ok(true)
    })
}

/// Whether [`park_hosted_document`] would park `object_id` now: it is out of
/// the scope and not parked, the relay has acknowledged every row this
/// replica wrote for it, nothing it accepted is pending (outbox bytes,
/// applied updates past their settlement, or a restore fence), and every
/// activation of it has its adoption. A pending activation can resume only
/// on the state it captured, which a return would change. Deferred updates
/// from the relay do not count: parking keeps them, and the return applies
/// them.
pub fn hosted_document_parkable(
    store: &EngineStore,
    workspace_id: &str,
    object_id: &str,
) -> Result<bool, SyncError> {
    store.read_with(|conn| parkable(conn, workspace_id, object_id))
}

/// The page that finishes `object_id`'s files in `version_id`, the version
/// the root holds, before it parks, or `None` when every row it applied
/// had its files written by a committed pass. A pass can stop after its rows
/// applied and before their files were written, and a document can leave the
/// scope while held, its files only partly written; either way no pass serves
/// its rows again. So this is the page of the pass that makes a document
/// ready, read from its journal instead of the relay: the decisions its
/// journaled rows stored that still stand ([`super::redelivered_unready`]),
/// and a write of each of its heads nothing else holds.
pub fn departed_hosted_materialization(
    store: &EngineStore,
    workspace_id: &str,
    object_id: &str,
    version_id: &str,
) -> Result<Option<Vec<crate::MomentMaterializationChange>>, SyncError> {
    let unmaterialized: bool = store.read_with(|conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM hosted_documents WHERE workspace_id=?1 \
             AND object_id=?2 AND unmaterialized_seq IS NOT NULL)",
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)
    })?;
    if !unmaterialized {
        return Ok(None);
    }
    // One journaled row is held at a time, however long its history.
    let mut stored = crate::relay::ChangedPaths::new();
    store.read_with(|conn| {
        let mut statement = conn
            .prepare_cached(JOURNALED_SQL)
            .map_err(SyncError::corrupt)?;
        let mut rows = statement
            .query(params![workspace_id, version_id, object_id])
            .map_err(SyncError::corrupt)?;
        while let Some(row) = rows.next().map_err(SyncError::corrupt)? {
            let payload: String = row.get(3).map_err(SyncError::corrupt)?;
            let op = crate::ReplicationEnvelope {
                settlement_admission: None,
                admitted_author_snapshot: None,
                workspace_id: workspace_id.to_owned(),
                origin_id: row.get(0).map_err(SyncError::corrupt)?,
                origin_seq: row.get(1).map_err(SyncError::corrupt)?,
                relay_seq: None,
                op_kind: row.get(2).map_err(SyncError::corrupt)?,
                payload: serde_json::from_str(&payload).map_err(SyncError::corrupt)?,
                recorded_at_ms: row.get(4).map_err(SyncError::corrupt)?,
            };
            for change in crate::router::redelivered_materialization_changes(store, &op)? {
                if change.version_id == version_id {
                    crate::relay::insert_changed_path(&mut stored, change);
                }
            }
        }
        Ok::<_, SyncError>(())
    })?;
    let page = store.read_with(|conn| {
        let mut occupancy = Occupancy::new(conn, workspace_id);
        let mut page = crate::relay::ChangedPaths::new();
        for change in super::redelivered_unready(&mut occupancy, object_id, stored.into_values())? {
            crate::relay::insert_changed_path(&mut page, change);
        }
        for head in super::head_writes(conn, workspace_id, object_id)? {
            if head.version_id == version_id
                && occupancy
                    .hold(object_id, &head.version_id, &head.path)?
                    .is_none()
            {
                crate::relay::insert_changed_path(&mut page, head);
            }
        }
        Ok::<_, SyncError>(page)
    })?;
    Ok(Some(crate::relay::page_order(
        page.into_values(),
        |change| change.operation,
    )))
}

/// Each row journaled for a document in a version that can carry a
/// materialization decision, read through the indexes on its version and
/// document. `?1` is the workspace, `?2` the version and `?3` the document.
const JOURNALED_SQL: &str = "SELECT origin_id,origin_seq,op_kind,payload_json,recorded_at_ms \
     FROM replication_log WHERE workspace_id=?1 AND op_kind='moment.append' \
       AND json_extract(payload_json,'$.versionId')=?2 \
       AND json_extract(payload_json,'$.objectId')=?3 \
     UNION ALL SELECT origin_id,origin_seq,op_kind,payload_json,recorded_at_ms \
     FROM replication_log WHERE workspace_id=?1 AND op_kind='ydoc.update' \
       AND json_extract(payload_json,'$.versionId')=?2 \
       AND json_extract(payload_json,'$.objectId')=?3";

/// A file a parked document left in the root: its path, and the digest of
/// the head it held. No moment takes the path until the file is forgotten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetiredFile {
    pub path: String,
    pub sha256: String,
}

/// The retired files still to remove, by path.
pub fn retired_hosted_files(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<RetiredFile>, SyncError> {
    store.read_with(|conn| {
        conn.prepare(
            "SELECT path,sha256 FROM hosted_retired_files WHERE workspace_id=?1 ORDER BY path",
        )
        .map_err(SyncError::corrupt)?
        .query_map([workspace_id], |row| {
            Ok(RetiredFile {
                path: row.get(0)?,
                sha256: row.get(1)?,
            })
        })
        .map_err(SyncError::corrupt)?
        .collect::<Result<_, _>>()
        .map_err(SyncError::corrupt)
    })
}

/// Forget the retired file at `path` once it is gone. Its path is free again.
pub fn forget_retired_hosted_file(
    store: &mut EngineStore,
    workspace_id: &str,
    path: &str,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<()>, SyncError> {
    store.write_with(faults, |tx| {
        tx.execute(
            "DELETE FROM hosted_retired_files WHERE workspace_id=?1 AND path=?2",
            params![workspace_id, path],
        )
        .map_err(SyncError::persist)?;
        Ok(())
    })
}

/// What holds `object_id`, a hosted document whose heads are parked, from
/// them, or `None` for one with none parked: a document of the scope at one
/// of their paths, a departed document or retired file at one, its own
/// included, or, once all are free, the pass that has yet to bring them back.
pub(crate) fn parked_hold(
    occupancy: &mut Occupancy<'_>,
    object_id: &str,
) -> Result<Option<HostedHold>, SyncError> {
    let paths = parked_paths(occupancy.conn, occupancy.workspace_id, object_id)?;
    if paths.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        paths_hold(occupancy, object_id, &paths)?.unwrap_or(HostedHold::WorkWaiting),
    ))
}

/// Whether `object_id`'s heads are parked and nothing holds their paths any
/// more, so the next pass brings them back. A head or path alias of its own
/// outside the parked tables would collide with them, so it stays held.
pub(crate) fn unparks_next(
    occupancy: &mut Occupancy<'_>,
    object_id: &str,
) -> Result<bool, SyncError> {
    let (conn, workspace_id) = (occupancy.conn, occupancy.workspace_id);
    let paths = parked_paths(conn, workspace_id, object_id)?;
    if paths.is_empty() {
        return Ok(false);
    }
    let unparked: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM snapshots WHERE workspace_id=?1 AND object_id=?2) \
             OR EXISTS(SELECT 1 FROM path_aliases WHERE workspace_id=?1 AND object_id=?2)",
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    Ok(!unparked && paths_hold(occupancy, object_id, &paths)?.is_none())
}

/// Bring back the heads of each document of the scope whose heads are
/// parked, once nothing holds their paths. Its file comes back with the pass
/// that makes it ready, which writes each of its heads.
pub(crate) fn unpark_returned(
    store: &mut EngineStore,
    workspace_id: &str,
    faults: &dyn FaultInjector,
) -> Result<(), SyncError> {
    // A document still held writes nothing, pass after pass.
    let returned = store.read_with(|conn| {
        let mut occupancy = Occupancy::new(conn, workspace_id);
        let mut returned = Vec::new();
        for object_id in strings(conn, RETURNED, &[&workspace_id])? {
            if unparks_next(&mut occupancy, &object_id)? {
                returned.push(object_id);
            }
        }
        Ok::<_, SyncError>(returned)
    })?;
    if returned.is_empty() {
        return Ok(());
    }
    let policy = crate::file_search::search_policy_for_store(store);
    let outcome = store.write_with(faults, |tx| {
        let mut occupancy = Occupancy::new(tx, workspace_id);
        for object_id in &returned {
            if !unparks_next(&mut occupancy, object_id)? {
                continue;
            }
            // A later return to one of these paths sees this one holding it.
            occupancy.take(object_id, &parked_paths(tx, workspace_id, object_id)?);
            let heads = tx
                .prepare(
                    "SELECT p.version_id,p.path,p.content_kind,b.sha256 FROM hosted_parked_snapshots p \
                     LEFT JOIN blobs b ON b.sha256=p.blob_sha256 \
                     WHERE p.workspace_id=?1 AND p.object_id=?2",
                )
                .map_err(SyncError::corrupt)?
                .query_map(params![workspace_id, object_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        text::optional_from_row(tx, row, 3)?,
                    ))
                })
                .map_err(SyncError::corrupt)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(SyncError::corrupt)?;
            let bound: [&dyn ToSql; 2] = [&workspace_id, object_id];
            for sql in UNPARK {
                execute(tx, sql, &bound)?;
            }
            for (version_id, path, kind, text) in heads {
                crate::file_search::upsert_file_search_index(
                    tx,
                    workspace_id,
                    &version_id,
                    object_id,
                    &path,
                    text.as_deref().filter(|_| kind != "binary"),
                    policy.as_ref(),
                )?;
            }
        }
        Ok::<_, SyncError>(())
    })?;
    match outcome {
        TxnOutcome::Committed(()) => Ok(()),
        TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
    }
}

/// Each version and path `object_id` parked a head or path alias at.
pub(super) fn parked_paths(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<Vec<(String, String)>, SyncError> {
    conn.prepare_cached(
        "SELECT version_id,path FROM hosted_parked_snapshots WHERE workspace_id=?1 AND object_id=?2 \
         UNION SELECT version_id,path FROM hosted_parked_path_aliases \
         WHERE workspace_id=?1 AND object_id=?2",
    )
    .map_err(SyncError::corrupt)?
    .query_map(params![workspace_id, object_id], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })
    .map_err(SyncError::corrupt)?
    .collect::<Result<_, _>>()
    .map_err(SyncError::corrupt)
}

/// What holds one of `paths` here against `object_id`: another document's
/// head or path alias, which names a document of the scope as holding it, or
/// a retired file.
pub(super) fn paths_hold(
    occupancy: &mut Occupancy<'_>,
    object_id: &str,
    paths: &[(String, String)],
) -> Result<Option<HostedHold>, SyncError> {
    let mut departed = false;
    for (version_id, path) in paths {
        match occupancy.hold(object_id, version_id, path)? {
            Some(hold @ HostedHold::PathHeld { .. }) => return Ok(Some(hold)),
            Some(_) => departed = true,
            None => {}
        }
    }
    Ok(departed.then_some(HostedHold::WorkWaiting))
}

/// What holds paths here, read once however many documents and paths are
/// asked about: every document's head and path alias in each version asked
/// about, and every retired file. A document asking is never held by its own
/// heads and aliases. Paths collide as capture holds match them: the same
/// path in any case, or one inside the other.
pub(crate) struct Occupancy<'c> {
    pub(crate) conn: &'c Connection,
    pub(crate) workspace_id: &'c str,
    versions: HashMap<String, Holders>,
    retired: Option<Holders>,
}

impl<'c> Occupancy<'c> {
    pub(crate) fn new(conn: &'c Connection, workspace_id: &'c str) -> Self {
        Self {
            conn,
            workspace_id,
            versions: HashMap::new(),
            retired: None,
        }
    }

    /// What holds `path` in `version_id` against `object_id`: the first
    /// other document of the scope there by id, or
    /// [`HostedHold::WorkWaiting`] for only another departed document or a
    /// retired file, its own included.
    pub(crate) fn hold(
        &mut self,
        object_id: &str,
        version_id: &str,
        path: &str,
    ) -> Result<Option<HostedHold>, SyncError> {
        if self.retired.is_none() {
            let mut retired = Holders::default();
            for held in strings(
                self.conn,
                "SELECT path FROM hosted_retired_files WHERE workspace_id=?1",
                &[&self.workspace_id],
            )? {
                retired.insert(&held, &Holder::Departed(None));
            }
            self.retired = Some(retired);
        }
        if !self.versions.contains_key(version_id) {
            let holders = self.load(version_id)?;
            self.versions.insert(version_id.to_owned(), holders);
        }
        let folded = dohc_engine_files::floor::path_collision_key(path);
        let holder = Holder::merge(
            self.versions[version_id].holder(&folded, object_id),
            self.retired
                .as_ref()
                .and_then(|retired| retired.holder(&folded, object_id)),
        );
        Ok(holder.map(|holder| match holder {
            Holder::Scope(held_by) => HostedHold::PathHeld {
                path: path.to_owned(),
                held_by,
            },
            Holder::Departed(_) => HostedHold::WorkWaiting,
        }))
    }

    /// Record that `object_id`, a document of the scope, now holds `paths`.
    /// A version not read yet reads them with the rest.
    fn take(&mut self, object_id: &str, paths: &[(String, String)]) {
        for (version_id, path) in paths {
            if let Some(holders) = self.versions.get_mut(version_id) {
                holders.insert(path, &Holder::Scope(object_id.to_owned()));
            }
        }
    }

    fn load(&self, version_id: &str) -> Result<Holders, SyncError> {
        let mut statement = self
            .conn
            .prepare_cached(OCCUPANTS_SQL)
            .map_err(SyncError::corrupt)?;
        let occupants = statement
            .query_map(params![self.workspace_id, version_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })
            .map_err(SyncError::corrupt)?;
        let mut holders = Holders::default();
        for occupant in occupants {
            let (held_by, held, in_scope) = occupant.map_err(SyncError::corrupt)?;
            #[cfg(test)]
            OCCUPANTS_READ.with(|read| read.set(read.get() + 1));
            let holder = if in_scope {
                Holder::Scope(held_by)
            } else {
                Holder::Departed(Some(held_by))
            };
            holders.insert(&held, &holder);
        }
        Ok(holders)
    }
}

/// Every document's head and path alias in one version, and whether that
/// document is of the scope. `?1` is the workspace and `?2` the version.
/// [`Holders`] merges a path read twice, so `UNION ALL` reads each table by
/// its version.
const OCCUPANTS_SQL: &str = "SELECT o.object_id,o.path,EXISTS(SELECT 1 FROM hosted_documents d \
       JOIN hosted_replicas h \
         ON h.workspace_id=d.workspace_id AND h.scope_generation=d.scope_generation \
       WHERE d.workspace_id=?1 AND d.object_id=o.object_id) \
     FROM (SELECT object_id,path FROM snapshots WHERE workspace_id=?1 AND version_id=?2 \
       UNION ALL SELECT object_id,path FROM path_aliases \
         WHERE workspace_id=?1 AND version_id=?2) o";

#[cfg(test)]
thread_local! {
    /// How many heads and path aliases each [`Occupancy`] on this thread read.
    pub(crate) static OCCUPANTS_READ: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Who holds a path: a document of the scope, or only a departed document,
/// or a retired file (`None`), which holds it against every document.
#[derive(Clone)]
enum Holder {
    Scope(String),
    Departed(Option<String>),
}

impl Holder {
    /// The holder a hold names of either: a document of the scope, the first
    /// by id.
    fn merge(a: Option<Holder>, b: Option<Holder>) -> Option<Holder> {
        match (a, b) {
            (Some(Holder::Scope(a)), Some(Holder::Scope(b))) => Some(Holder::Scope(a.min(b))),
            (Some(Holder::Departed(_)), b @ Some(_)) => b,
            (a, b) => a.or(b),
        }
    }
}

/// Held paths, keyed as capture holds match them: each one, and each folder
/// above one.
#[derive(Default)]
struct Holders {
    at: HashMap<String, Held>,
    above: HashMap<String, Held>,
}

/// Who holds one path: its first two documents of the scope by id, and two
/// of its other holders, so leaving out any one document still names who
/// else holds it.
#[derive(Default)]
struct Held {
    scope: Vec<String>,
    departed: Vec<Option<String>>,
}

impl Held {
    fn add(&mut self, holder: &Holder) {
        match holder {
            Holder::Scope(id) if !self.scope.contains(id) => {
                self.scope.push(id.clone());
                self.scope.sort();
                self.scope.truncate(2);
            }
            Holder::Departed(owner)
                if self.departed.len() < 2 && !self.departed.contains(owner) =>
            {
                self.departed.push(owner.clone());
            }
            _ => {}
        }
    }

    /// Its first holder other than `object_id`.
    fn without(&self, object_id: &str) -> Option<Holder> {
        match self.scope.iter().find(|id| *id != object_id) {
            Some(id) => Some(Holder::Scope(id.clone())),
            None => self
                .departed
                .iter()
                .find(|owner| owner.as_deref() != Some(object_id))
                .map(|owner| Holder::Departed(owner.clone())),
        }
    }
}

impl Holders {
    fn insert(&mut self, held: &str, holder: &Holder) {
        let held = dohc_engine_files::floor::path_collision_key(held);
        for (end, _) in held.match_indices('/') {
            self.above
                .entry(held[..end].to_owned())
                .or_default()
                .add(holder);
        }
        self.at.entry(held).or_default().add(holder);
    }

    /// What holds `path`, keyed, against `object_id`: another holder of
    /// a path the same, above it or inside it.
    fn holder(&self, path: &str, object_id: &str) -> Option<Holder> {
        let inside = path.match_indices('/').map(|(end, _)| &path[..end]);
        [self.at.get(path), self.above.get(path)]
            .into_iter()
            .chain(inside.map(|folder| self.at.get(folder)))
            .flatten()
            .fold(None, |holder, held| {
                Holder::merge(holder, held.without(object_id))
            })
    }
}

fn parkable(conn: &Connection, workspace_id: &str, object_id: &str) -> Result<bool, SyncError> {
    let quiet: bool = conn
        .query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM hosted_documents d \
                   JOIN hosted_replicas h ON h.workspace_id=d.workspace_id \
                   WHERE d.workspace_id=?1 AND d.object_id=?2 \
                     AND d.scope_generation<>h.scope_generation AND d.state<>'parked') \
                 AND NOT EXISTS(SELECT 1 FROM replication_log \
                   JOIN sync_identity USING (workspace_id,origin_id) \
                   WHERE workspace_id=?1 AND {DOCUMENT_NAMED_SQL}=?2 \
                     AND origin_seq>COALESCE((SELECT p.pushed_seq FROM sync_relay_push_state p \
                       WHERE p.workspace_id=?1 AND p.origin_id=sync_identity.origin_id),-1)) \
                 AND NOT EXISTS(SELECT 1 FROM live_audit_pending_exports \
                   WHERE workspace_id=?1 AND object_id=?2) \
                 AND NOT EXISTS(SELECT 1 FROM ydoc_owner_activation_sources a \
                   WHERE a.workspace_id=?1 AND a.object_id=?2 \
                     AND NOT EXISTS(SELECT 1 FROM live_owner_activations o \
                       WHERE o.workspace_id=a.workspace_id AND o.main_version_id=a.version_id \
                         AND o.object_id=a.object_id AND o.lineage_claim_id=a.lineage_claim_id \
                         AND o.relay_database_namespace=a.relay_database_namespace \
                         AND o.activation_id=a.activation_id))"
            ),
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    Ok(quiet
        && dohc_engine_collab::live_update_application::park_pending(conn, workspace_id, object_id)
            .map_err(SyncError::corrupt)?
            .is_none())
}

/// A head's columns, as `snapshots` and `hosted_parked_snapshots` both hold them.
macro_rules! head_columns {
    () => {
        "workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,\
         metadata_origin,content_kind,binary_sha256,metadata_summary,metadata_correlation_id"
    };
}

/// What parking writes, in order. `?1` is the workspace, `?2` the document,
/// and `?3` the version the root holds.
const PARK: [&str; 9] = [
    "INSERT INTO hosted_retired_files (workspace_id,path,object_id,sha256) \
     SELECT workspace_id,path,object_id,COALESCE(blob_sha256,binary_sha256) FROM snapshots \
     WHERE workspace_id=?1 AND object_id=?2 AND version_id=?3",
    concat!(
        "INSERT INTO hosted_parked_snapshots (",
        head_columns!(),
        ") SELECT ",
        head_columns!(),
        " FROM snapshots WHERE workspace_id=?1 AND object_id=?2"
    ),
    "INSERT INTO hosted_parked_path_aliases (workspace_id,version_id,path,object_id) \
     SELECT workspace_id,version_id,path,object_id FROM path_aliases \
     WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM path_aliases WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM snapshots WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM engine_search_files_fts WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM capture_file_holds WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM share_direct_write_marks WHERE workspace_id=?1 AND object_id=?2",
    "UPDATE hosted_documents SET state='parked',held_reason=NULL,held_path=NULL,held_by=NULL, \
     held_conflict_id=NULL,released_hold_binding_json=NULL,released_hold_binding_digest=NULL, \
     released_hold_continuation=NULL,released_hold_binding_stale=0,unmaterialized_seq=NULL \
     WHERE workspace_id=?1 AND object_id=?2",
];

/// The documents of the scope whose heads are parked. `?1` is the workspace.
const RETURNED: &str = "SELECT p.object_id FROM \
      (SELECT workspace_id,object_id FROM hosted_parked_snapshots \
       UNION SELECT workspace_id,object_id FROM hosted_parked_path_aliases) p \
    JOIN hosted_documents d USING (workspace_id,object_id) \
    JOIN hosted_replicas h \
      ON h.workspace_id=d.workspace_id AND h.scope_generation=d.scope_generation \
    WHERE p.workspace_id=?1 ORDER BY 1";

/// What bringing a document's heads back writes, in order. `?1` is the
/// workspace and `?2` the document.
const UNPARK: [&str; 4] = [
    concat!(
        "INSERT INTO snapshots (",
        head_columns!(),
        ") SELECT ",
        head_columns!(),
        " FROM hosted_parked_snapshots WHERE workspace_id=?1 AND object_id=?2"
    ),
    "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
     SELECT workspace_id,version_id,path,object_id FROM hosted_parked_path_aliases \
     WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM hosted_parked_path_aliases WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM hosted_parked_snapshots WHERE workspace_id=?1 AND object_id=?2",
];

fn strings(conn: &Connection, sql: &str, bound: &[&dyn ToSql]) -> Result<Vec<String>, SyncError> {
    let mut statement = conn.prepare(sql).map_err(SyncError::corrupt)?;
    let count = statement.parameter_count();
    statement
        .query_map(&bound[..count], |row| row.get(0))
        .map_err(SyncError::corrupt)?
        .collect::<Result<_, _>>()
        .map_err(SyncError::corrupt)
}

fn execute(conn: &Connection, sql: &str, bound: &[&dyn ToSql]) -> Result<(), SyncError> {
    let mut statement = conn.prepare(sql).map_err(SyncError::persist)?;
    let count = statement.parameter_count();
    statement
        .execute(&bound[..count])
        .map_err(SyncError::persist)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Holder, Holders};
    use dohc_engine_files::floor::path_collision_key;
    use dohc_engine_files::path_is_held;

    /// A held path holds another as a capture hold matches them, either way
    /// round: the same path in any case or normalization, or one inside the
    /// other.
    #[test]
    fn held_paths_collide_as_capture_holds_match() {
        let paths = [
            "a.md",
            "A.md",
            "a.md/b.md",
            "A.MD/b.md",
            "a",
            "a/b",
            "a/b/c.md",
            "ab/c.md",
            "b.md",
            "caf\u{e9}.md",
            "cafe\u{301}.md",
            "CAF\u{c9}.md/b.md",
            "cafe.md",
        ];
        for held in paths {
            let mut holders = Holders::default();
            holders.insert(held, &Holder::Departed(None));
            for path in paths {
                assert_eq!(
                    holders.holder(&path_collision_key(path), "doc").is_some(),
                    path_is_held(held, path) || path_is_held(path, held),
                    "{held} against {path}"
                );
            }
        }
    }

    /// A hold names a document of the scope over a departed one or a retired
    /// file, and the first by id.
    #[test]
    fn a_hold_names_the_first_document_of_the_scope() {
        let mut holders = Holders::default();
        holders.insert("d/x.md", &Holder::Departed(None));
        holders.insert("d/b.md", &Holder::Scope("doc-b".to_owned()));
        holders.insert("d/a.md", &Holder::Scope("doc-a".to_owned()));
        assert!(matches!(holders.holder("d", "doc"), Some(Holder::Scope(id)) if id == "doc-a"));
        assert!(matches!(
            holders.holder("d/x.md", "doc"),
            Some(Holder::Departed(None))
        ));
    }

    /// A document asking is never held by its own heads and aliases, however
    /// many others hold the same paths, but a retired file holds against it
    /// even when it left that file.
    #[test]
    fn a_hold_leaves_out_the_document_asking() {
        let mut holders = Holders::default();
        for id in ["doc-a", "doc-b", "doc-c"] {
            holders.insert("d/a.md", &Holder::Scope(id.to_owned()));
        }
        holders.insert("D/A.md", &Holder::Scope("doc-a".to_owned()));
        for (asking, held_by) in [("doc-a", "doc-b"), ("doc-b", "doc-a"), ("doc-z", "doc-a")] {
            assert!(
                matches!(holders.holder("d", asking), Some(Holder::Scope(id)) if id == held_by),
                "{asking}"
            );
        }
        let mut departed = Holders::default();
        departed.insert("x.md", &Holder::Departed(Some("doc-a".to_owned())));
        assert!(departed.holder("x.md", "doc-a").is_none());
        departed.insert("x.md", &Holder::Departed(Some("doc-b".to_owned())));
        departed.insert("x.md", &Holder::Departed(None));
        assert!(matches!(
            departed.holder("x.md", "doc-a"),
            Some(Holder::Departed(_))
        ));
        let mut retired = Holders::default();
        retired.insert("x.md", &Holder::Departed(None));
        assert!(
            retired
                .holder(path_collision_key("X.md").as_str(), "doc-a")
                .is_some()
        );
        let mut own = Holders::default();
        own.insert("d/a.md", &Holder::Scope("doc-a".to_owned()));
        assert!(own.holder("d", "doc-a").is_none());
    }

    /// A return reads its own heads, and each version's occupants, through
    /// their tables' keys, never by scanning the workspace; so does parking
    /// read a document's journal.
    #[test]
    fn a_returns_reads_search_by_key() {
        let (_scratch, _path, store) = dohc_engine_testkit::open_store();
        for sql in [
            super::super::HEADS_SQL,
            super::OCCUPANTS_SQL,
            super::JOURNALED_SQL,
        ] {
            let plan = store
                .read_with(|conn| {
                    let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                    let bound = ["ws", "main", "doc"];
                    let count = statement.parameter_count();
                    statement
                        .query_map(rusqlite::params_from_iter(&bound[..count]), |row| {
                            row.get::<_, String>(3)
                        })?
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap();
            // A head or alias is found by its version, not in every row of
            // the workspace.
            let keyed = |step: &String| {
                let table = step.split_whitespace().nth(1).unwrap_or_default();
                !["s", "snapshots", "path_aliases"].contains(&table)
                    || step.contains("version_id=?")
            };
            assert!(
                plan.iter()
                    .all(|step| (!step.starts_with("SCAN") || step == "SCAN o") && keyed(step)),
                "{plan:?}"
            );
        }
    }
}
