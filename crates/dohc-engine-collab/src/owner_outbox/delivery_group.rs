//! Owner drafts typed while a delivery is in flight wait as one group, which
//! goes as one delivery once that delivery is received. A row joins only a
//! group behind the head, so a group never changes once it can be offered.
//! Its id and digest are computed from its rows' bytes while it waits, and
//! read from the receipt every row keeps once it is acknowledged.

use super::draft::{bounded_blob, collab};
use super::{delivery_id, read_sql, OwnerOutboxError};
use dohc_engine_storage::hex_sha256;
use rusqlite::{params, Connection, OptionalExtension};

/// Keystrokes are tens of bytes, so a small cap still sends a burst as one
/// delivery. A larger group could pass a relay's update limit that each of its
/// rows met.
pub(super) const MAX_GROUP_BYTES: i64 = 4096;

/// The group a new draft row joins: the last row's, if that row waits under
/// the same draft revision and author, its group is behind the head, and the
/// group stays within [`MAX_GROUP_BYTES`].
#[allow(clippy::too_many_arguments)]
pub(super) fn joinable_in(
    conn: &Connection,
    outbox_id: &str,
    next_sequence: i64,
    draft_revision: i64,
    declaration_json: Option<&str>,
    automation_json: Option<&str>,
    person_edit: bool,
    agent_run_id: Option<&str>,
    byte_length: i64,
) -> Result<Option<i64>, OwnerOutboxError> {
    conn.query_row(
        "SELECT t.delivery_group FROM owner_ydoc_outbox_entries t \
         WHERE t.outbox_id=?1 AND t.sequence=?2-1 AND t.pending=1 \
           AND t.delivery_group>(SELECT MIN(sequence) FROM owner_ydoc_outbox_entries \
                                 WHERE outbox_id=?1 AND pending=1) \
           AND t.draft_binding_revision=?3 AND t.agent_declaration_json IS ?4 \
           AND t.automation_declaration_json IS ?5 AND t.person_edit IS ?6 AND t.agent_run_id IS ?7 \
           AND ?8+(SELECT SUM(byte_length) FROM owner_ydoc_outbox_entries \
                   WHERE outbox_id=?1 AND pending=1 AND delivery_group=t.delivery_group)<=?9",
        params![
            outbox_id,
            next_sequence,
            draft_revision,
            declaration_json,
            automation_json,
            person_edit.then_some(true),
            agent_run_id,
            byte_length,
            MAX_GROUP_BYTES,
        ],
        |row| row.get(0),
    )
    .optional()
    .map_err(read_sql)
}

/// The pending rows that go as one delivery, in order.
#[derive(Debug, Clone)]
pub(super) struct PendingDelivery {
    pub first_sequence: i64,
    pub last_sequence: i64,
    pub rows: usize,
    pub row_digests: Vec<String>,
    /// What the rows count toward the outbox's pending bytes.
    pub queued_bytes: i64,
    pub delivery_id: String,
    pub update_digest: String,
    /// The merged update of two or more rows. A single row's is its own blob.
    merged: Option<Vec<u8>>,
}

impl PendingDelivery {
    pub fn is_group(&self) -> bool {
        self.merged.is_some()
    }

    pub fn update(&self, conn: &Connection) -> Result<Vec<u8>, OwnerOutboxError> {
        match &self.merged {
            Some(merged) => Ok(merged.clone()),
            None => checked_blob(conn, &self.update_digest, self.queued_bytes),
        }
    }
}

/// A pending row's update, which must match its digest and length.
fn checked_blob(conn: &Connection, digest: &str, length: i64) -> Result<Vec<u8>, OwnerOutboxError> {
    let update = bounded_blob(conn, digest)?;
    if hex_sha256(&update) != digest || i64::try_from(update.len()).ok() != Some(length) {
        return Err(OwnerOutboxError::Corrupt);
    }
    Ok(update)
}

struct Row {
    sequence: i64,
    group: i64,
    delivery_id: String,
    update_digest: String,
    byte_length: i64,
}

const PENDING_ROWS: &str =
    "SELECT sequence,COALESCE(delivery_group,sequence),delivery_id,update_digest,byte_length \
     FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        sequence: r.get(0)?,
        group: r.get(1)?,
        delivery_id: r.get(2)?,
        update_digest: r.get(3)?,
        byte_length: r.get(4)?,
    })
}

/// The first `limit` pending deliveries of an outbox, in order.
pub(super) fn pending_in(
    conn: &Connection,
    outbox_id: &str,
    limit: usize,
) -> Result<Vec<PendingDelivery>, OwnerOutboxError> {
    let mut statement = conn
        .prepare(&format!("{PENDING_ROWS} ORDER BY sequence"))
        .map_err(read_sql)?;
    let mut rows = statement.query([outbox_id]).map_err(read_sql)?;
    let mut groups: Vec<Vec<Row>> = Vec::new();
    while let Some(next) = rows.next().map_err(read_sql)? {
        let next = row(next).map_err(read_sql)?;
        match groups.last_mut() {
            Some(group) if group[0].group == next.group => group.push(next),
            _ if groups.len() == limit => break,
            _ => groups.push(vec![next]),
        }
    }
    groups
        .into_iter()
        .map(|rows| delivery(conn, outbox_id, rows))
        .collect()
}

/// The pending delivery whose first row is `sequence`, if there is one.
pub(super) fn starting_at_in(
    conn: &Connection,
    outbox_id: &str,
    sequence: i64,
) -> Result<Option<PendingDelivery>, OwnerOutboxError> {
    let mut statement = conn
        .prepare(&format!(
            "{PENDING_ROWS} AND COALESCE(delivery_group,sequence)=(SELECT COALESCE(delivery_group,sequence) \
             FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND sequence=?2) ORDER BY sequence"
        ))
        .map_err(read_sql)?;
    let rows = statement
        .query_map(params![outbox_id, sequence], row)
        .map_err(read_sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(read_sql)?;
    if rows.first().map(|first| first.sequence) != Some(sequence) {
        return Ok(None);
    }
    delivery(conn, outbox_id, rows).map(Some)
}

fn delivery(
    conn: &Connection,
    outbox_id: &str,
    rows: Vec<Row>,
) -> Result<PendingDelivery, OwnerOutboxError> {
    let (Some(first), Some(last)) = (rows.first(), rows.last()) else {
        return Err(OwnerOutboxError::Corrupt);
    };
    let queued_bytes = rows.iter().try_fold(0_i64, |total, row| {
        total
            .checked_add(row.byte_length)
            .ok_or(OwnerOutboxError::Corrupt)
    })?;
    let (first_sequence, last_sequence) = (first.sequence, last.sequence);
    let row_digests = rows.iter().map(|row| row.update_digest.clone()).collect();
    if rows.len() == 1 {
        return Ok(PendingDelivery {
            first_sequence,
            last_sequence,
            rows: 1,
            row_digests,
            queued_bytes,
            delivery_id: first.delivery_id.clone(),
            update_digest: first.update_digest.clone(),
            merged: None,
        });
    }
    let updates = rows
        .iter()
        .map(|row| checked_blob(conn, &row.update_digest, row.byte_length))
        .collect::<Result<Vec<_>, _>>()?;
    let merged = crate::merge_updates(&updates).map_err(collab)?;
    let update_digest = hex_sha256(&merged);
    Ok(PendingDelivery {
        first_sequence,
        last_sequence,
        rows: rows.len(),
        row_digests,
        queued_bytes,
        delivery_id: delivery_id(outbox_id, first_sequence, &update_digest),
        update_digest,
        merged: Some(merged),
    })
}

/// An acknowledged group's receipt, found through migration 100's index on its
/// digest. `+outbox_id` keeps the planner off the outbox's whole history.
pub(super) const ACKNOWLEDGED_GROUP: &str =
    "SELECT accepted_receipt_json FROM owner_ydoc_outbox_entries \
     WHERE delivery_group IS NOT NULL AND accepted_receipt_json IS NOT NULL \
       AND json_extract(accepted_receipt_json,'$.updateDigest')=?3 \
       AND +outbox_id=?1 AND pending=0 \
       AND json_extract(accepted_receipt_json,'$.deliveryId')=?2 LIMIT 1";

/// A delivery an outbox knows by its id.
pub(super) struct KnownDelivery {
    pub update_digest: String,
    /// Set while it waits for its receipt.
    pub pending: Option<PendingDelivery>,
    pub receipt_json: Option<String>,
    pub terminal_reason: Option<String>,
}

/// Find a delivery by id: a row delivered alone, the head group while it
/// waits, or a group by the receipt its rows keep, found through its digest.
/// A row of a waiting group of two or more is not a delivery of its own.
pub(super) fn find_in(
    conn: &Connection,
    outbox_id: &str,
    delivery_id: &str,
    update_digest: &str,
) -> Result<Option<KnownDelivery>, OwnerOutboxError> {
    let own: Option<(i64, String, bool, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT sequence,update_digest,pending,accepted_receipt_json,terminal_reason \
             FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND delivery_id=?2",
            params![outbox_id, delivery_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(read_sql)?;
    if let Some((sequence, update_digest, pending, receipt_json, terminal_reason)) = own {
        let pending = if pending {
            match starting_at_in(conn, outbox_id, sequence)? {
                Some(alone) if !alone.is_group() => Some(alone),
                _ => return Ok(None),
            }
        } else {
            None
        };
        return Ok(Some(KnownDelivery {
            update_digest,
            pending,
            receipt_json,
            terminal_reason,
        }));
    }
    if let Some(head) = pending_in(conn, outbox_id, 1)?.pop() {
        if head.delivery_id == delivery_id {
            return Ok(Some(KnownDelivery {
                update_digest: head.update_digest.clone(),
                pending: Some(head),
                receipt_json: None,
                terminal_reason: None,
            }));
        }
    }
    let acknowledged: Option<String> = conn
        .query_row(
            ACKNOWLEDGED_GROUP,
            params![outbox_id, delivery_id, update_digest],
            |r| r.get(0),
        )
        .optional()
        .map_err(read_sql)?;
    Ok(acknowledged.map(|receipt_json| KnownDelivery {
        update_digest: update_digest.to_owned(),
        pending: None,
        receipt_json: Some(receipt_json),
        terminal_reason: None,
    }))
}

/// Whether a group of two or more rows refused together for `reason` had this
/// id and digest. Their kept bytes stay until the outbox is released.
pub(super) fn was_refused_in(
    conn: &Connection,
    outbox_id: &str,
    id: &str,
    update_digest: &str,
    reason: &str,
) -> Result<bool, OwnerOutboxError> {
    let mut statement = conn
        .prepare(
            "SELECT sequence,delivery_group,terminal_blob_digest FROM owner_ydoc_outbox_entries \
             WHERE outbox_id=?1 AND pending=0 AND accepted_receipt_json IS NULL \
               AND terminal_reason=?2 AND delivery_group IS NOT NULL ORDER BY sequence",
        )
        .map_err(read_sql)?;
    let rows = statement
        .query_map(params![outbox_id, reason], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(read_sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(read_sql)?;
    for group in rows.chunk_by(|a, b| a.1 == b.1) {
        if group.len() < 2 {
            continue;
        }
        let updates = group
            .iter()
            .map(|(_, _, kept)| {
                bounded_blob(conn, kept.as_deref().ok_or(OwnerOutboxError::Corrupt)?)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let merged = crate::merge_updates(&updates).map_err(collab)?;
        let digest = hex_sha256(&merged);
        if digest == update_digest && delivery_id(outbox_id, group[0].0, &digest) == id {
            return Ok(true);
        }
    }
    Ok(false)
}
