//! A share recipient's direct writes to a Collection's own files (ADR 0013).
//!
//! A recipient with Edit changes `collection.yaml` and `automations.yaml`, or
//! creates a new Collection, and the relay writes the change into the
//! granter's workspace at once under the recipient's name. Every other change
//! stays on proposals.
//!
//! This lane reads the same journal the proposal lane reads. It keeps its own
//! position, and a mark per file for the ops it decided. A file it wrote is
//! marked delivered, and the proposal scan reads past those ops, so Send
//! changes never offers them again. A file the relay refused, or whose base
//! was stale, is marked decided but not delivered: the direct lane does not
//! send it again, and Send changes still offers it.

use std::collections::{BTreeMap, BTreeSet};

use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome, hex_sha256};
use rusqlite::{OptionalExtension, params};

use super::{
    NetChange, RelaySyncClient, RelayTransport, ShareProposalChange,
    collect_share_proposal_changes, local, local_max_origin_seq, read_share_proposal_scan_position,
};
use crate::journal::read_sync_identity;
use crate::{RelayError, SyncError};

const COLLECTION_SCHEMA_FILE: &str = "collection.yaml";
const COLLECTION_AUTOMATIONS_FILE: &str = "automations.yaml";
const MAIN_VERSION_ID: &str = "main";
/// The relay's bounds on one direct write
/// (`services/sync-relay/src/shareFilter.ts`).
const MAX_NEW_COLLECTION_RECORDS: usize = 500;
const MAX_COLLECTION_WRITE_BYTES: i64 = 4 * 1024 * 1024;

/// One direct write: a schema edit, an automations change, or a new
/// Collection's files, sent to `POST /sync/shares/:shareId/collection-writes`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareCollectionWriteRequest {
    pub share_id: String,
    /// Derived from the write itself, so a retry of the same write names the
    /// same id and the relay answers with the receipt it already holds.
    pub submit_id: String,
    pub changes: Vec<ShareProposalChange>,
}

/// How the relay answered one direct write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShareCollectionWriteResponse {
    /// The relay wrote these paths into the granter's workspace.
    Written { paths: Vec<String> },
    /// `path` changed since this replica read it. `current_blob_sha256` is
    /// the granter's current content, or `None` when the path is taken under
    /// another spelling.
    Stale {
        path: String,
        current_blob_sha256: Option<String>,
    },
    /// The direct lane does not take this write, for `reason`. The recipient
    /// can send it as a proposal.
    Refused { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectWriteResult {
    Written,
    Stale {
        path: String,
        current_blob_sha256: Option<String>,
    },
    Refused {
        reason: String,
    },
}

/// One direct write and how it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectWriteReport {
    pub paths: Vec<String>,
    pub result: DirectWriteResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DirectWritePushOutcome {
    pub writes: Vec<DirectWriteReport>,
    /// The scan stopped at its file bound; another push has more to read.
    pub more_pending: bool,
}

/// The direct lane's decision about one file, through a journal position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DirectWriteMark {
    pub(super) through_seq: i64,
    /// The relay wrote the file. A stale or refused write is decided but not
    /// delivered.
    pub(super) delivered: bool,
}

impl<T: RelayTransport> RelaySyncClient<T> {
    /// Write this replica's changes to a Collection's own files directly into
    /// the granter's workspace.
    ///
    /// The scan starts after whatever either lane already read, and reads
    /// past the ops of files this lane already decided. It plans each
    /// eligible change as one write, sends the writes one at a time, and
    /// records every decision once all of them are answered. A write that
    /// fails in transit stops the push without recording anything: the next
    /// push plans the same writes under the same submit ids, and the relay
    /// answers a write it already took with its stored receipt.
    pub fn push_direct_writes(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        share_id: &str,
        granted: &crate::ShareGrant,
        faults: &dyn FaultInjector,
        max_read_bytes: usize,
    ) -> Result<DirectWritePushOutcome, RelayError> {
        if granted.access != crate::ShareAccess::Edit || granted.version_id.is_some() {
            return Ok(DirectWritePushOutcome::default());
        }
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let decided: BTreeMap<String, i64> =
            read_direct_write_marks(store, workspace_id, share_id)?
                .into_iter()
                .map(|(object_id, mark)| (object_id, mark.through_seq))
                .collect();
        let start = read_direct_write_position(store, workspace_id, share_id)?.max(
            read_share_proposal_scan_position(store, workspace_id, share_id)?,
        );
        let submit_through =
            local_max_origin_seq(store, workspace_id, &identity.origin_id).map_err(local)?;
        let scan = collect_share_proposal_changes(
            store,
            workspace_id,
            granted,
            &identity.origin_id,
            start,
            submit_through,
            max_read_bytes,
            &decided,
        )?;
        let writes = plan_direct_writes(store, workspace_id, granted, &scan.changes)?;

        let mut uploaded = BTreeMap::new();
        let mut marks: Vec<(String, DirectWriteMark)> = Vec::new();
        let mut reports = Vec::with_capacity(writes.len());
        for write in writes {
            let mut changes: Vec<ShareProposalChange> =
                write.iter().map(|net| net.change.clone()).collect();
            let paths: Vec<String> = changes
                .iter()
                .filter_map(|change| change.after_path.clone())
                .collect();
            self.upload_proposed_blobs(store, share_id, &mut changes, &mut uploaded)?;
            let response = self
                .transport
                .share_collection_write(ShareCollectionWriteRequest {
                    share_id: share_id.to_owned(),
                    submit_id: direct_submit_id(share_id, &identity.origin_id, &write),
                    changes,
                })?;
            let result = match response {
                ShareCollectionWriteResponse::Written { paths: written } => {
                    let sent: BTreeSet<&String> = paths.iter().collect();
                    if written.len() != paths.len()
                        || written.iter().collect::<BTreeSet<_>>() != sent
                    {
                        return Err(RelayError::InvalidResponse);
                    }
                    DirectWriteResult::Written
                }
                ShareCollectionWriteResponse::Stale {
                    path,
                    current_blob_sha256,
                } => DirectWriteResult::Stale {
                    path,
                    current_blob_sha256,
                },
                ShareCollectionWriteResponse::Refused { reason } => {
                    DirectWriteResult::Refused { reason }
                }
            };
            let delivered = result == DirectWriteResult::Written;
            marks.extend(write.iter().map(|net| {
                (
                    net.object_id.clone(),
                    DirectWriteMark {
                        through_seq: net.last_seq,
                        delivered,
                    },
                )
            }));
            reports.push(DirectWriteReport { paths, result });
        }
        write_direct_write_progress(
            store,
            workspace_id,
            share_id,
            &marks,
            scan.scanned_through,
            faults,
        )?;
        Ok(DirectWritePushOutcome {
            writes: reports,
            more_pending: scan.more_pending,
        })
    }
}

/// Group the scan's changes into the writes the relay takes, in the order it
/// takes them: each new Collection as one batch, then each schema edit and
/// each automations change on its own. A change that fits none stays on
/// proposals. The relay makes every decision again; this only keeps changes
/// it would refuse by shape from being sent.
fn plan_direct_writes<'a>(
    store: &EngineStore,
    workspace_id: &str,
    granted: &crate::ShareGrant,
    changes: &'a [NetChange],
) -> Result<Vec<Vec<&'a NetChange>>, RelayError> {
    let mut used = BTreeSet::new();
    let mut writes = Vec::new();

    for (index, net) in changes.iter().enumerate() {
        let Some((folder, name)) = text_write_path(net) else {
            continue;
        };
        if name != COLLECTION_SCHEMA_FILE || net.change.based_on_path.is_some() {
            continue;
        }
        // The grant covers the folder the new Collection goes in.
        let Some((parent, _)) = folder.rsplit_once('/') else {
            continue;
        };
        if !covers_folder(parent, granted) {
            continue;
        }
        used.insert(index);
        let mut batch = vec![net];
        let mut bytes = byte_length(store, &net.change)?;
        let mut automations = None;
        let mut records = Vec::new();
        for (other_index, other) in changes.iter().enumerate() {
            if used.contains(&other_index) || other.change.based_on_path.is_some() {
                continue;
            }
            let Some((other_folder, other_name)) = text_write_path(other) else {
                continue;
            };
            if other_folder != folder {
                continue;
            }
            if other_name == COLLECTION_AUTOMATIONS_FILE {
                if automations.is_none() {
                    automations = Some(other_index);
                }
            } else if is_markdown(other_name) && records.len() < MAX_NEW_COLLECTION_RECORDS {
                records.push(other_index);
            }
        }
        // The automations file first, then records while the batch has
        // room. What does not fit stays on proposals.
        for other_index in automations.into_iter().chain(records) {
            let length = byte_length(store, &changes[other_index].change)?;
            if bytes.saturating_add(length) > MAX_COLLECTION_WRITE_BYTES {
                continue;
            }
            bytes += length;
            used.insert(other_index);
            batch.push(&changes[other_index]);
        }
        writes.push(batch);
    }

    for (index, net) in changes.iter().enumerate() {
        if used.contains(&index) {
            continue;
        }
        let Some((folder, name)) = text_write_path(net) else {
            continue;
        };
        if !covers_folder(folder, granted) {
            continue;
        }
        let direct = match name {
            COLLECTION_SCHEMA_FILE => net.change.based_on_path.is_some(),
            COLLECTION_AUTOMATIONS_FILE => folder_holds_schema(store, workspace_id, folder)?,
            _ => false,
        };
        if direct {
            writes.push(vec![net]);
        }
    }
    Ok(writes)
}

/// The folder and file name of a change the direct lane can carry: a text
/// write that either creates its file or edits it where it is. A delete, a
/// move, and binary content stay on proposals.
fn text_write_path(net: &NetChange) -> Option<(&str, &str)> {
    let change = &net.change;
    let path = change.after_path.as_deref()?;
    if change.operation != "write"
        || change.after_content_kind.as_deref() != Some("text")
        || change.after_blob_sha256.is_none()
        || change
            .based_on_path
            .as_deref()
            .is_some_and(|base| base != path)
    {
        return None;
    }
    path.rsplit_once('/')
}

/// The relay's rule: Edit on the folder itself, which is never the root.
fn covers_folder(folder: &str, granted: &crate::ShareGrant) -> bool {
    !folder.is_empty() && crate::share::selected_path_within_grant(folder, granted)
}

fn is_markdown(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() > 3 && bytes[bytes.len() - 3..].eq_ignore_ascii_case(b".md")
}

/// Whether this replica has `<folder>/collection.yaml` on main, so the
/// folder is a Collection an automations file can go in.
fn folder_holds_schema(
    store: &EngineStore,
    workspace_id: &str,
    folder: &str,
) -> Result<bool, RelayError> {
    let path = format!("{folder}/{COLLECTION_SCHEMA_FILE}");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM snapshots \
                 WHERE workspace_id=?1 AND version_id=?2 AND path=?3)",
                params![workspace_id, MAIN_VERSION_ID, path],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .map_err(local)
}

/// A change's content length: the one its moment states, or the stored
/// blob's.
fn byte_length(store: &EngineStore, change: &ShareProposalChange) -> Result<i64, RelayError> {
    if let Some(length) = change.after_byte_length {
        return Ok(length);
    }
    let Some(sha256) = change.after_blob_sha256.as_deref() else {
        return Ok(0);
    };
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT byte_length FROM blobs WHERE sha256=?1",
                [sha256],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(SyncError::corrupt)
        })
        .map_err(local)?
        .ok_or(RelayError::BlobMissing)
}

/// The same write always names the same id: its share, this replica's
/// origin, and each file's object, last journal position, and content.
fn direct_submit_id(share_id: &str, origin_id: &str, write: &[&NetChange]) -> String {
    let mut bytes = Vec::new();
    for part in ["dohc-direct-write-v1", share_id, origin_id] {
        bytes.extend_from_slice(part.as_bytes());
        bytes.push(0);
    }
    for net in write {
        bytes.extend_from_slice(net.object_id.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(net.last_seq.to_string().as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(
            net.change
                .after_blob_sha256
                .as_deref()
                .unwrap_or_default()
                .as_bytes(),
        );
        bytes.push(0);
    }
    format!("direct-{}", hex_sha256(&bytes))
}

pub(super) fn read_direct_write_marks(
    store: &EngineStore,
    workspace_id: &str,
    share_id: &str,
) -> Result<BTreeMap<String, DirectWriteMark>, RelayError> {
    store
        .read_with(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT object_id,through_seq,delivered FROM share_direct_write_marks \
                     WHERE workspace_id=?1 AND share_id=?2",
                )
                .map_err(SyncError::corrupt)?;
            let rows = statement
                .query_map(params![workspace_id, share_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        DirectWriteMark {
                            through_seq: row.get(1)?,
                            delivered: row.get::<_, i64>(2)? == 1,
                        },
                    ))
                })
                .map_err(SyncError::corrupt)?;
            rows.collect::<Result<BTreeMap<_, _>, _>>()
                .map_err(SyncError::corrupt)
        })
        .map_err(local)
}

fn read_direct_write_position(
    store: &EngineStore,
    workspace_id: &str,
    share_id: &str,
) -> Result<i64, RelayError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT scanned_seq FROM share_direct_write_state \
                 WHERE workspace_id=?1 AND share_id=?2",
                params![workspace_id, share_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|value| value.unwrap_or(-1))
            .map_err(SyncError::corrupt)
        })
        .map_err(local)
}

/// Records one push's decisions and the position it read through, together.
fn write_direct_write_progress(
    store: &mut EngineStore,
    workspace_id: &str,
    share_id: &str,
    marks: &[(String, DirectWriteMark)],
    scanned_seq: i64,
    faults: &dyn FaultInjector,
) -> Result<(), RelayError> {
    if !(-1..=crate::MAX_WIRE_INTEGER).contains(&scanned_seq) {
        return Err(RelayError::InvalidResponse);
    }
    let outcome = store
        .write_with(faults, |tx| {
            for (object_id, mark) in marks {
                tx.execute(
                    "INSERT INTO share_direct_write_marks \
                     (workspace_id,share_id,object_id,through_seq,delivered) \
                     VALUES (?1,?2,?3,?4,?5) \
                     ON CONFLICT(workspace_id,share_id,object_id) DO UPDATE SET \
                     through_seq=excluded.through_seq,delivered=excluded.delivered",
                    params![
                        workspace_id,
                        share_id,
                        object_id,
                        mark.through_seq,
                        i64::from(mark.delivered)
                    ],
                )
                .map_err(SyncError::persist)?;
            }
            tx.execute(
                "INSERT INTO share_direct_write_state (workspace_id,share_id,scanned_seq) \
                 VALUES (?1,?2,?3) ON CONFLICT(workspace_id,share_id) DO UPDATE SET \
                 scanned_seq=max(scanned_seq,excluded.scanned_seq)",
                params![workspace_id, share_id, scanned_seq],
            )
            .map_err(SyncError::persist)?;
            Ok::<(), SyncError>(())
        })
        .map_err(local)?;
    if matches!(outcome, TxnOutcome::Crashed { .. }) {
        return Err(RelayError::Local("injected-crash".to_owned()));
    }
    Ok(())
}
