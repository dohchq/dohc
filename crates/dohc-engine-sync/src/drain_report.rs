//! What a pass owes for queued Y.Doc rows its drains removed before the pass
//! reached its reporting boundary. The transaction that deletes a row writes
//! its report, keyed by the row's coordinate, so a pass that waits later, is
//! abandoned, or meets a restart loses nothing it committed. The pass claims
//! every report no other live pass owns under its settlement report token,
//! and its cursor commit removes them, as it does its applied settlements.
//! Refusals need no report: each persists as a pending refusal, which every
//! pass reports.

use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

use dohc_engine_domain::CollectionRecordApplyFacts;
use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};

use crate::{MomentMaterializationChange, SharingDeclined, SyncError};

/// What a drain reported as a whole, not of one row: conflicts its bases
/// opened, sharing its projection declined, and the files it changed. It
/// rides with the drain's last removed row.
#[derive(Debug, Default)]
pub(crate) struct DrainExtras {
    pub(crate) conflicts_opened: i64,
    pub(crate) sharing_declined: Vec<SharingDeclined>,
    pub(crate) changes: Vec<MomentMaterializationChange>,
}

impl DrainExtras {
    fn is_empty(&self) -> bool {
        self.conflicts_opened == 0 && self.sharing_declined.is_empty() && self.changes.is_empty()
    }
}

/// What every report a pass claimed adds up to.
#[derive(Debug, Default)]
pub(crate) struct ClaimedReports {
    pub(crate) record_facts: Vec<CollectionRecordApplyFacts>,
    pub(crate) extras: DrainExtras,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredReport {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    record_facts: Option<CollectionRecordApplyFacts>,
    #[serde(default)]
    conflicts_opened: i64,
    #[serde(default)]
    sharing_declined: Vec<StoredDecline>,
    #[serde(default)]
    changes: Vec<StoredChange>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDecline {
    object_id: String,
    version_id: String,
    lineage_pruned: bool,
    head_blob_sha256: Option<String>,
    path: String,
    constraint: String,
    limit_bytes: usize,
    observed_bytes: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredChange {
    version_id: String,
    path: String,
    operation: String,
    content_kind: String,
}

fn malformed() -> SyncError {
    crate::error::local_corruption("a drain report is malformed")
}

impl StoredDecline {
    fn new(declined: &SharingDeclined) -> Self {
        Self {
            object_id: declined.object_id.clone(),
            version_id: declined.version_id.clone(),
            lineage_pruned: declined.lineage_pruned,
            head_blob_sha256: declined.head_blob_sha256.clone(),
            path: declined.path.clone(),
            constraint: declined.constraint.to_owned(),
            limit_bytes: declined.limit_bytes,
            observed_bytes: declined.observed_bytes,
        }
    }

    fn declined(self) -> Result<SharingDeclined, SyncError> {
        Ok(SharingDeclined {
            object_id: self.object_id,
            version_id: self.version_id,
            lineage_pruned: self.lineage_pruned,
            head_blob_sha256: self.head_blob_sha256,
            path: self.path,
            constraint: match self.constraint.as_str() {
                "MAX_YDOC_UPDATE_BYTES" => "MAX_YDOC_UPDATE_BYTES",
                _ => return Err(malformed()),
            },
            limit_bytes: self.limit_bytes,
            observed_bytes: self.observed_bytes,
        })
    }
}

impl StoredChange {
    fn new(change: &MomentMaterializationChange) -> Self {
        Self {
            version_id: change.version_id.clone(),
            path: change.path.clone(),
            operation: change.operation.to_owned(),
            content_kind: change.content_kind.to_owned(),
        }
    }

    fn change(self) -> Result<MomentMaterializationChange, SyncError> {
        Ok(MomentMaterializationChange {
            version_id: self.version_id,
            path: self.path,
            operation: match self.operation.as_str() {
                "write" => "write",
                "delete" => "delete",
                _ => return Err(malformed()),
            },
            content_kind: match self.content_kind.as_str() {
                "text" => "text",
                "binary" => "binary",
                _ => return Err(malformed()),
            },
        })
    }
}

/// Write the report each of `coordinates`, queued rows of `workspace_id`
/// this transaction removes, owes: the facts it parked, and for the last
/// one `extras`. Runs before the rows go. A row that owes nothing writes
/// nothing.
pub(crate) fn record_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    coordinates: &[(String, i64)],
    extras: &DrainExtras,
) -> Result<(), SyncError> {
    for (index, (origin_id, origin_seq)) in coordinates.iter().enumerate() {
        let facts: Option<String> = tx
            .query_row(
                "SELECT record_facts_json FROM ydoc_deferred_updates \
                 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                params![workspace_id, origin_id, origin_seq],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?
            .flatten();
        let last = index + 1 == coordinates.len();
        let report = StoredReport {
            record_facts: facts
                .as_deref()
                .map(crate::ydoc_apply::parse_parked_record_facts)
                .transpose()?,
            conflicts_opened: if last { extras.conflicts_opened } else { 0 },
            sharing_declined: if last {
                extras
                    .sharing_declined
                    .iter()
                    .map(StoredDecline::new)
                    .collect()
            } else {
                Vec::new()
            },
            changes: if last {
                extras.changes.iter().map(StoredChange::new).collect()
            } else {
                Vec::new()
            },
        };
        if report.record_facts.is_none() && (!last || extras.is_empty()) {
            continue;
        }
        tx.execute(
            "INSERT OR REPLACE INTO ydoc_drain_reports \
             (workspace_id,origin_id,origin_seq,report_json,report_id) VALUES (?1,?2,?3,?4,NULL)",
            params![
                workspace_id,
                origin_id,
                origin_seq,
                serde_json::to_string(&report).map_err(SyncError::corrupt)?
            ],
        )
        .map_err(SyncError::persist)?;
    }
    Ok(())
}

/// Claim every drain report of `workspace_id` that `report_id` does not
/// already own under it, creating the token when none exists yet, and answer
/// what they report. One an abandoned pass claimed is claimed again.
pub(crate) fn claim(
    store: &mut EngineStore,
    workspace_id: &str,
    report_id: &mut Option<String>,
    faults: &dyn FaultInjector,
) -> Result<ClaimedReports, SyncError> {
    let pending: bool = store.read_with(|conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM ydoc_drain_reports \
             WHERE workspace_id=?1 AND COALESCE(report_id!=?2,1))",
            params![workspace_id, report_id.as_deref()],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)
    })?;
    if !pending {
        return Ok(ClaimedReports::default());
    }
    let outcome = store.write_with(faults, |tx| {
        let token = match report_id.as_ref() {
            Some(token) => token.clone(),
            None => tx
                .query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
                .map_err(SyncError::corrupt)?,
        };
        let mut statement = tx
            .prepare(
                "UPDATE ydoc_drain_reports SET report_id=?2 \
                 WHERE workspace_id=?1 AND COALESCE(report_id!=?2,1) \
                 RETURNING rowid,report_json",
            )
            .map_err(SyncError::corrupt)?;
        let mut rows = statement
            .query_map(params![workspace_id, token], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::persist)?;
        // In the order the drains removed their rows.
        rows.sort_by_key(|(rowid, _)| *rowid);
        drop(statement);
        Ok::<_, SyncError>((token, rows))
    })?;
    let TxnOutcome::Committed((token, rows)) = outcome else {
        return Err(SyncError::FaultCrash);
    };
    *report_id = Some(token);
    let mut claimed = ClaimedReports::default();
    for (_, json) in rows {
        let report: StoredReport = serde_json::from_str(&json).map_err(|_| malformed())?;
        claimed.record_facts.extend(report.record_facts);
        claimed.extras.conflicts_opened = claimed
            .extras
            .conflicts_opened
            .checked_add(report.conflicts_opened)
            .ok_or_else(malformed)?;
        for declined in report.sharing_declined {
            claimed.extras.sharing_declined.push(declined.declined()?);
        }
        for change in report.changes {
            claimed.extras.changes.push(change.change()?);
        }
    }
    Ok(claimed)
}

/// Remove the reports a committed pass claimed under `report_id`.
pub(crate) fn release_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    report_id: &str,
) -> Result<(), SyncError> {
    tx.execute(
        "DELETE FROM ydoc_drain_reports WHERE workspace_id=?1 AND report_id=?2",
        params![workspace_id, report_id],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}
