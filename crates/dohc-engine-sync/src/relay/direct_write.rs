//! A share recipient's direct writes to a Collection's own files (ADR 0013).
//!
//! A recipient with Edit changes `collection.yaml` and `automations.yaml`, or
//! creates a new Collection, and the relay writes the change into the
//! granter's workspace at once under the recipient's name. Every other change
//! stays on proposals.
//!
//! This lane reads the same journal the proposal lane reads. Each push plans
//! its writes once and records the plan, with each exact request, before it
//! sends anything. Every later run, rerun, or retry sends those same requests
//! under the same submit ids, so a write the relay already took answers with
//! its stored receipt. Each answer is recorded in its own transaction.
//!
//! Per file, the lane keeps two positions that only rise. `delivered_through`
//! says the relay wrote the file's ops up to there; the proposal scan reads
//! past them, so Send changes never offers them again. `decided_through` says
//! this lane will not look at those ops again: it wrote them, the relay
//! answered stale or refused, or they are not a Collection's own files. Send
//! changes still offers everything not delivered.

use std::collections::{BTreeMap, BTreeSet};

use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome, hex_sha256};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{
    NetChange, RelaySyncClient, RelayTransport, ScanSkips, ShareProposalChange,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "lowercase")]
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

/// The direct lane's two positions for one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DirectWriteMark {
    pub(super) delivered_through: i64,
    pub(super) decided_through: i64,
}

/// One planned write, as recorded before it is sent.
struct PlannedWrite {
    ordinal: i64,
    request: ShareCollectionWriteRequest,
    /// Each file the write carries, with the last journal position it
    /// consolidates.
    objects: Vec<(String, i64)>,
    /// `None` until the relay answers.
    result: Option<DirectWriteResult>,
}

/// One push's recorded plan.
struct DirectWritePlan {
    writes: Vec<PlannedWrite>,
    /// Where the lane has read through once every write is answered.
    position: i64,
    more_pending: bool,
}

impl<T: RelayTransport> RelaySyncClient<T> {
    /// Write this replica's changes to a Collection's own files directly into
    /// the granter's workspace.
    ///
    /// A push first finishes the plan an earlier push recorded, if any.
    /// Otherwise it scans the journal once, and records the plan and the
    /// files it leaves to proposals before it sends anything. A write that
    /// fails in transit stops the push; the plan stays, and the next push
    /// sends the same request.
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
        let plan = match read_direct_write_plan(store, workspace_id, share_id)? {
            Some(plan) => plan,
            None => {
                let identity = read_sync_identity(store, workspace_id)
                    .map_err(local)?
                    .ok_or(RelayError::InvalidResponse)?;
                let (plan, left) = build_direct_write_plan(
                    store,
                    workspace_id,
                    share_id,
                    granted,
                    &identity.origin_id,
                    max_read_bytes,
                )?;
                record_direct_write_plan(store, workspace_id, share_id, &plan, &left, faults)?;
                if plan.writes.is_empty() {
                    return Ok(DirectWritePushOutcome {
                        writes: Vec::new(),
                        more_pending: plan.more_pending,
                    });
                }
                plan
            }
        };

        let mut uploaded = BTreeMap::new();
        for write in plan.writes.iter().filter(|write| write.result.is_none()) {
            let mut changes = write.request.changes.clone();
            let sent = self
                .upload_proposed_blobs(store, share_id, &mut changes, &mut uploaded)
                .and_then(|()| self.transport.share_collection_write(write.request.clone()));
            let response = match sent {
                Ok(response) => response,
                Err(error) => {
                    // A relay that does not take these writes, or no longer
                    // takes them from this grant, will not answer later
                    // either, whether it says so to the upload or to the
                    // write. Dropping the plan lets Send changes offer the
                    // files it still carries.
                    if relay_refuses_the_lane(&error) {
                        abandon_direct_write_plan(store, workspace_id, share_id, faults)?;
                    }
                    return Err(error);
                }
            };
            let result = direct_write_result(response, &write.request)?;
            record_direct_write_result(store, workspace_id, share_id, write, &result, faults)?;
        }

        let finished = read_direct_write_plan(store, workspace_id, share_id)?
            .ok_or(RelayError::InvalidResponse)?;
        let mut reports = Vec::with_capacity(finished.writes.len());
        for write in finished.writes {
            let result = write.result.ok_or(RelayError::InvalidResponse)?;
            reports.push(DirectWriteReport {
                paths: request_paths(&write.request),
                result,
            });
        }
        finish_direct_write_plan(store, workspace_id, share_id, finished.position, faults)?;
        Ok(DirectWritePushOutcome {
            writes: reports,
            more_pending: finished.more_pending,
        })
    }
}

/// The relay's lasting no to the route itself: it does not take direct
/// writes, the share or the grant's level is gone, or the request can never
/// be taken as sent. Every other error may pass, so the plan waits for it.
///
/// Only a failure that may pass keeps the plan: the transport, the relay's
/// own 5xx or 429, a blob the relay does not hold yet, an answer this
/// replica could not read (the relay may have taken the write), a sign-in to
/// refresh, and this replica's own store. Everything else is a no.
fn relay_refuses_the_lane(error: &RelayError) -> bool {
    !matches!(
        error,
        RelayError::Partitioned
            | RelayError::ServerInternal
            | RelayError::BlobMissing
            | RelayError::BlobReferenceMissing
            | RelayError::InvalidResponse
            | RelayError::Unauthorized
            | RelayError::StoreBusy
            | RelayError::Local(_)
    ) && !matches!(error, RelayError::HttpStatus(status) if *status == 429 || *status >= 500)
}

fn request_paths(request: &ShareCollectionWriteRequest) -> Vec<String> {
    request
        .changes
        .iter()
        .filter_map(|change| change.after_path.clone())
        .collect()
}

fn direct_write_result(
    response: ShareCollectionWriteResponse,
    request: &ShareCollectionWriteRequest,
) -> Result<DirectWriteResult, RelayError> {
    Ok(match response {
        ShareCollectionWriteResponse::Written { paths } => {
            let sent = request_paths(request);
            if paths.len() != sent.len()
                || paths.iter().collect::<BTreeSet<_>>() != sent.iter().collect::<BTreeSet<_>>()
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
        ShareCollectionWriteResponse::Refused { reason } => DirectWriteResult::Refused { reason },
    })
}

/// Scan once and plan. Returns the plan and the files this push leaves to
/// proposals, each with the last position it read for it.
fn build_direct_write_plan(
    store: &EngineStore,
    workspace_id: &str,
    share_id: &str,
    granted: &crate::ShareGrant,
    origin_id: &str,
    max_read_bytes: usize,
) -> Result<(DirectWritePlan, Vec<(String, i64)>), RelayError> {
    let skips = ScanSkips {
        settled: read_direct_write_marks(store, workspace_id, share_id)?
            .into_iter()
            .filter(|(_, mark)| mark.decided_through >= 0)
            .map(|(object_id, mark)| (object_id, mark.decided_through))
            .collect(),
        stop_at: BTreeSet::new(),
    };
    let start = read_direct_write_position(store, workspace_id, share_id)?.max(
        read_share_proposal_scan_position(store, workspace_id, share_id)?,
    );
    let submit_through = local_max_origin_seq(store, workspace_id, origin_id).map_err(local)?;
    let scan = collect_share_proposal_changes(
        store,
        workspace_id,
        granted,
        origin_id,
        start,
        submit_through,
        max_read_bytes,
        &skips,
    )?;

    let groups = plan_direct_writes(store, workspace_id, granted, &scan.changes)?;
    // A new Collection the scan bound may have cut waits for the next push,
    // which reads it again whole. That only helps when this push still moves
    // on: it writes something, or it leaves files to proposals. A scan that is
    // nothing but new Collections would read the same window for ever, so
    // those go now, as the scan saw them.
    let grouped: BTreeSet<&str> = groups
        .iter()
        .flat_map(|group| group.changes.iter().map(|net| net.object_id.as_str()))
        .collect();
    let defer = scan.more_pending
        && (groups.iter().any(|group| !group.new_collection)
            || scan
                .changes
                .iter()
                .any(|net| !grouped.contains(net.object_id.as_str())));
    let mut position = scan.scanned_through;
    let mut carried = BTreeSet::new();
    let mut writes = Vec::new();
    for group in groups {
        if defer && group.new_collection {
            // The scan stopped at its bound, so more of this Collection's
            // records may follow. The next push reads it again whole.
            if let Some(first) = group.changes.iter().map(|net| net.first_seq).min() {
                position = position.min(first - 1);
            }
            carried.extend(group.changes.iter().map(|net| net.object_id.clone()));
            continue;
        }
        let mut changes = Vec::with_capacity(group.changes.len());
        for net in &group.changes {
            let mut change = net.change.clone();
            change.after_byte_length = Some(byte_length(store, &change)?);
            changes.push(change);
        }
        carried.extend(group.changes.iter().map(|net| net.object_id.clone()));
        writes.push(PlannedWrite {
            ordinal: i64::try_from(writes.len()).map_err(|_| RelayError::InvalidResponse)?,
            request: ShareCollectionWriteRequest {
                share_id: share_id.to_owned(),
                submit_id: direct_submit_id(share_id, origin_id, &group.changes, &changes),
                changes,
            },
            objects: group
                .changes
                .iter()
                .map(|net| (net.object_id.clone(), net.last_seq))
                .collect(),
            result: None,
        });
    }
    let left = scan
        .changes
        .iter()
        .filter(|net| !carried.contains(&net.object_id))
        .map(|net| (net.object_id.clone(), net.last_seq))
        .collect();
    Ok((
        DirectWritePlan {
            writes,
            position,
            more_pending: scan.more_pending,
        },
        left,
    ))
}

/// A group of changes the relay takes as one write.
struct PlannedGroup<'a> {
    new_collection: bool,
    changes: Vec<&'a NetChange>,
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
) -> Result<Vec<PlannedGroup<'a>>, RelayError> {
    let mut used = BTreeSet::new();
    let mut groups = Vec::new();

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
        // One name per spelling a disk would take as one file, as the relay
        // counts them. A second spelling stays on proposals.
        let mut names = BTreeSet::from([collision_key(name)]);
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
            let is_automations = other_name == COLLECTION_AUTOMATIONS_FILE;
            if !is_automations
                && (!is_markdown(other_name) || records.len() >= MAX_NEW_COLLECTION_RECORDS)
            {
                continue;
            }
            if !names.insert(collision_key(other_name)) {
                continue;
            }
            if is_automations {
                automations = Some(other_index);
            } else {
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
        groups.push(PlannedGroup {
            new_collection: true,
            changes: batch,
        });
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
            groups.push(PlannedGroup {
                new_collection: false,
                changes: vec![net],
            });
        }
    }
    Ok(groups)
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

/// The relay's key for one path component
/// (`services/sync-relay/src/pathCollisionKey.ts`): NFKC, folded lower,
/// upper, then lower, without the trailing dots and spaces Windows drops.
fn collision_key(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let folded = name
        .nfkc()
        .collect::<String>()
        .to_lowercase()
        .to_uppercase()
        .to_lowercase();
    folded
        .nfkc()
        .collect::<String>()
        .trim_end_matches(['.', ' '])
        .to_owned()
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

/// The same write always names the same id, and a different write never
/// does: its share, this replica's origin, and for each file its object, last
/// journal position, base, content, and length.
fn direct_submit_id(
    share_id: &str,
    origin_id: &str,
    group: &[&NetChange],
    changes: &[ShareProposalChange],
) -> String {
    let mut bytes = Vec::new();
    let mut part = |value: &str| {
        bytes.extend_from_slice(value.as_bytes());
        bytes.push(0);
    };
    for value in ["dohc-direct-write-v2", share_id, origin_id] {
        part(value);
    }
    for (net, change) in group.iter().zip(changes) {
        part(&net.object_id);
        part(&net.last_seq.to_string());
        part(change.based_on_blob_sha256.as_deref().unwrap_or_default());
        part(change.after_blob_sha256.as_deref().unwrap_or_default());
        part(&change.after_byte_length.unwrap_or(-1).to_string());
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
                    "SELECT object_id,delivered_through,decided_through \
                     FROM share_direct_write_marks WHERE workspace_id=?1 AND share_id=?2",
                )
                .map_err(SyncError::corrupt)?;
            let rows = statement
                .query_map(params![workspace_id, share_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        DirectWriteMark {
                            delivered_through: row.get(1)?,
                            decided_through: row.get(2)?,
                        },
                    ))
                })
                .map_err(SyncError::corrupt)?;
            rows.collect::<Result<BTreeMap<_, _>, _>>()
                .map_err(SyncError::corrupt)
        })
        .map_err(local)
}

/// The files a recorded write still carries: the relay has not answered it.
/// The proposal scan stops at them, so its position never passes a change
/// whose fate is still open.
pub(super) fn read_direct_write_open_objects(
    store: &EngineStore,
    workspace_id: &str,
    share_id: &str,
) -> Result<BTreeSet<String>, RelayError> {
    let Some(plan) = read_direct_write_plan(store, workspace_id, share_id)? else {
        return Ok(BTreeSet::new());
    };
    Ok(plan
        .writes
        .into_iter()
        .filter(|write| write.result.is_none())
        .flat_map(|write| write.objects.into_iter().map(|(object_id, _)| object_id))
        .collect())
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

type PlanRow = (i64, String, String, String, Option<String>);

fn read_direct_write_plan(
    store: &EngineStore,
    workspace_id: &str,
    share_id: &str,
) -> Result<Option<DirectWritePlan>, RelayError> {
    let (state, rows) = store
        .read_with(|conn| {
            let state = conn
                .query_row(
                    "SELECT plan_seq,plan_more_pending FROM share_direct_write_state \
                     WHERE workspace_id=?1 AND share_id=?2 AND plan_seq IS NOT NULL",
                    params![workspace_id, share_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)? == 1)),
                )
                .optional()
                .map_err(SyncError::corrupt)?;
            let mut statement = conn
                .prepare(
                    "SELECT ordinal,submit_id,changes_json,objects_json,result_json \
                     FROM share_direct_write_plan WHERE workspace_id=?1 AND share_id=?2 \
                     ORDER BY ordinal",
                )
                .map_err(SyncError::corrupt)?;
            let rows = statement
                .query_map(params![workspace_id, share_id], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                })
                .map_err(SyncError::corrupt)?
                .collect::<Result<Vec<PlanRow>, _>>()
                .map_err(SyncError::corrupt)?;
            Ok::<_, SyncError>((state, rows))
        })
        .map_err(local)?;
    let Some((position, more_pending)) = state else {
        return Ok(None);
    };
    let corrupt = |_: serde_json::Error| RelayError::Local("direct-write-plan-corrupt".to_owned());
    let mut writes = Vec::with_capacity(rows.len());
    for (ordinal, submit_id, changes_json, objects_json, result_json) in rows {
        writes.push(PlannedWrite {
            ordinal,
            request: ShareCollectionWriteRequest {
                share_id: share_id.to_owned(),
                submit_id,
                changes: serde_json::from_str(&changes_json).map_err(corrupt)?,
            },
            objects: serde_json::from_str(&objects_json).map_err(corrupt)?,
            result: result_json
                .map(|json| serde_json::from_str(&json))
                .transpose()
                .map_err(corrupt)?,
        });
    }
    Ok(Some(DirectWritePlan {
        writes,
        position,
        more_pending,
    }))
}

fn crashed<T>(outcome: TxnOutcome<T>) -> Result<(), RelayError> {
    if matches!(outcome, TxnOutcome::Crashed { .. }) {
        return Err(RelayError::Local("injected-crash".to_owned()));
    }
    Ok(())
}

fn upsert_mark(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    share_id: &str,
    object_id: &str,
    mark: DirectWriteMark,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT INTO share_direct_write_marks \
         (workspace_id,share_id,object_id,delivered_through,decided_through) \
         VALUES (?1,?2,?3,?4,?5) \
         ON CONFLICT(workspace_id,share_id,object_id) DO UPDATE SET \
         delivered_through=max(delivered_through,excluded.delivered_through), \
         decided_through=max(decided_through,excluded.decided_through)",
        params![
            workspace_id,
            share_id,
            object_id,
            mark.delivered_through,
            mark.decided_through
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// Records the plan and the files it leaves to proposals, together, before
/// anything is sent. A plan with no writes only moves the position.
fn record_direct_write_plan(
    store: &mut EngineStore,
    workspace_id: &str,
    share_id: &str,
    plan: &DirectWritePlan,
    left: &[(String, i64)],
    faults: &dyn FaultInjector,
) -> Result<(), RelayError> {
    if !(-1..=crate::MAX_WIRE_INTEGER).contains(&plan.position) {
        return Err(RelayError::InvalidResponse);
    }
    let mut rows = Vec::with_capacity(plan.writes.len());
    for write in &plan.writes {
        let changes = serde_json::to_string(&write.request.changes)
            .map_err(|_| RelayError::InvalidResponse)?;
        let objects =
            serde_json::to_string(&write.objects).map_err(|_| RelayError::InvalidResponse)?;
        rows.push((write.ordinal, &write.request.submit_id, changes, objects));
    }
    let outcome = store
        .write_with(faults, |tx| {
            for (object_id, last_seq) in left {
                upsert_mark(
                    tx,
                    workspace_id,
                    share_id,
                    object_id,
                    DirectWriteMark {
                        delivered_through: -1,
                        decided_through: *last_seq,
                    },
                )?;
            }
            if rows.is_empty() {
                tx.execute(
                    "INSERT INTO share_direct_write_state (workspace_id,share_id,scanned_seq) \
                     VALUES (?1,?2,?3) ON CONFLICT(workspace_id,share_id) DO UPDATE SET \
                     scanned_seq=max(scanned_seq,excluded.scanned_seq)",
                    params![workspace_id, share_id, plan.position],
                )
                .map_err(SyncError::persist)?;
                return Ok::<(), SyncError>(());
            }
            for (ordinal, submit_id, changes, objects) in &rows {
                tx.execute(
                    "INSERT INTO share_direct_write_plan \
                     (workspace_id,share_id,ordinal,submit_id,changes_json,objects_json) \
                     VALUES (?1,?2,?3,?4,?5,?6)",
                    params![workspace_id, share_id, ordinal, submit_id, changes, objects],
                )
                .map_err(SyncError::persist)?;
            }
            tx.execute(
                "INSERT INTO share_direct_write_state \
                 (workspace_id,share_id,scanned_seq,plan_seq,plan_more_pending) \
                 VALUES (?1,?2,-1,?3,?4) ON CONFLICT(workspace_id,share_id) DO UPDATE SET \
                 plan_seq=excluded.plan_seq,plan_more_pending=excluded.plan_more_pending",
                params![
                    workspace_id,
                    share_id,
                    plan.position,
                    i64::from(plan.more_pending)
                ],
            )
            .map_err(SyncError::persist)?;
            Ok(())
        })
        .map_err(local)?;
    crashed(outcome)
}

/// Records one write's answer and its files' positions, in one transaction.
fn record_direct_write_result(
    store: &mut EngineStore,
    workspace_id: &str,
    share_id: &str,
    write: &PlannedWrite,
    result: &DirectWriteResult,
    faults: &dyn FaultInjector,
) -> Result<(), RelayError> {
    let json = serde_json::to_string(result).map_err(|_| RelayError::InvalidResponse)?;
    let delivered = *result == DirectWriteResult::Written;
    let outcome = store
        .write_with(faults, |tx| {
            tx.execute(
                "UPDATE share_direct_write_plan SET result_json=?4 \
                 WHERE workspace_id=?1 AND share_id=?2 AND ordinal=?3",
                params![workspace_id, share_id, write.ordinal, json],
            )
            .map_err(SyncError::persist)?;
            for (object_id, last_seq) in &write.objects {
                upsert_mark(
                    tx,
                    workspace_id,
                    share_id,
                    object_id,
                    DirectWriteMark {
                        delivered_through: if delivered { *last_seq } else { -1 },
                        decided_through: *last_seq,
                    },
                )?;
            }
            Ok::<(), SyncError>(())
        })
        .map_err(local)?;
    crashed(outcome)
}

/// The relay will not answer the rest of the plan: drop it without moving the
/// position. Writes it answered keep their marks; the rest go back to being
/// changes, and the next push plans them again.
fn abandon_direct_write_plan(
    store: &mut EngineStore,
    workspace_id: &str,
    share_id: &str,
    faults: &dyn FaultInjector,
) -> Result<(), RelayError> {
    let outcome = store
        .write_with(faults, |tx| {
            tx.execute(
                "DELETE FROM share_direct_write_plan WHERE workspace_id=?1 AND share_id=?2",
                params![workspace_id, share_id],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "UPDATE share_direct_write_state SET plan_seq=NULL,plan_more_pending=0 \
                 WHERE workspace_id=?1 AND share_id=?2",
                params![workspace_id, share_id],
            )
            .map_err(SyncError::persist)?;
            Ok::<(), SyncError>(())
        })
        .map_err(local)?;
    crashed(outcome)
}

/// Every write is answered: drop the plan and move the position.
fn finish_direct_write_plan(
    store: &mut EngineStore,
    workspace_id: &str,
    share_id: &str,
    position: i64,
    faults: &dyn FaultInjector,
) -> Result<(), RelayError> {
    let outcome = store
        .write_with(faults, |tx| {
            tx.execute(
                "DELETE FROM share_direct_write_plan WHERE workspace_id=?1 AND share_id=?2",
                params![workspace_id, share_id],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "UPDATE share_direct_write_state SET \
                 scanned_seq=max(scanned_seq,?3),plan_seq=NULL,plan_more_pending=0 \
                 WHERE workspace_id=?1 AND share_id=?2",
                params![workspace_id, share_id, position],
            )
            .map_err(SyncError::persist)?;
            Ok::<(), SyncError>(())
        })
        .map_err(local)?;
    crashed(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn net(base: Option<&str>, byte_length: i64) -> NetChange {
        NetChange {
            object_id: "object".to_owned(),
            first_seq: 1,
            last_seq: 1,
            change: ShareProposalChange {
                based_on_path: base.map(|_| "shared/docs/a/collection.yaml".to_owned()),
                based_on_blob_sha256: base.map(str::to_owned),
                operation: "write".to_owned(),
                after_path: Some("shared/docs/a/collection.yaml".to_owned()),
                after_blob_sha256: Some("b".repeat(64)),
                after_content_kind: Some("text".to_owned()),
                after_byte_length: Some(byte_length),
                recorded_at_ms: 1,
            },
        }
    }

    fn id(net: &NetChange) -> String {
        direct_submit_id("share", "origin", &[net], std::slice::from_ref(&net.change))
    }

    #[test]
    fn a_write_from_another_base_or_length_names_another_submit_id() {
        let base = "1".repeat(64);
        let first = net(Some(&base), 4);
        assert_eq!(id(&first), id(&net(Some(&base), 4)));
        assert_ne!(id(&first), id(&net(Some(&"2".repeat(64)), 4)));
        assert_ne!(id(&first), id(&net(Some(&base), 5)));
        assert_ne!(id(&first), id(&net(None, 4)));
    }

    #[test]
    fn names_one_disk_holds_as_one_file_share_a_key() {
        assert_eq!(collision_key("A.MD"), collision_key("a.md"));
        assert_eq!(
            collision_key("caf\u{e9}.md"),
            collision_key("cafe\u{301}.md")
        );
        assert_eq!(collision_key("b.md. "), collision_key("b.md"));
        assert_eq!(collision_key("\u{1e9e}.md"), collision_key("ss.md"));
        assert_ne!(collision_key("a.md"), collision_key("b.md"));
    }
}
