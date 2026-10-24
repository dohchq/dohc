use super::*;
use crate::Ydoc;
use dohc_engine_storage::put_binary_blob;
mod native_state;

pub(super) const CHECKPOINT_EVENTS: i64 = 4095;
const CHECKPOINT_BYTES: i64 = 20_971_520;
const DOCUMENT: &str = "relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5";
/// Every live application reads this until the next checkpoint. It finds the
/// fence by its delivery and compares only columns stored before the restore
/// proof, so it never walks the proof.
pub(super) const NATIVE_APPEND_FENCE: &str = "SELECT operation_id=?2 AND new_generation=?4 AND workspace_id=?5 AND main_version_id=?6 AND object_id=?7 AND lineage_claim_id=?8 FROM live_restore_fences WHERE relay_database_namespace=?1 AND application_delivery_id=?3";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAcceptedCheckpoint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore_operation_id: Option<String>,
    pub event_count: i64,
    pub terminal: Option<LiveUpdateReceipt>,
    pub binding: LiveObjectBinding,
    pub state_digest: String,
    pub evidence_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreHistoryProof {
    pub checkpoint: NativeAcceptedCheckpoint,
    pub suffix: Vec<AdmittedLiveUpdateMetadata>,
    pub event_count: i64,
    pub terminal: Option<LiveUpdateReceipt>,
    pub evidence_digest: String,
}

pub(super) struct HistoryRead {
    pub proof: NativeRestoreHistoryProof,
    pub doc: Ydoc,
}

/// Where a lineage's accepted history stood before an event: its last
/// receipt, its event count and its evidence digest.
pub(super) struct Tip<'a> {
    pub terminal: Option<&'a LiveUpdateReceipt>,
    pub count: i64,
    pub evidence: &'a str,
}

fn parameters(held: &Registration) -> [&str; 5] {
    let b = &held.binding;
    [
        &held.namespace,
        &b.workspace_id,
        &b.main_version_id,
        &b.object_id,
        &b.lineage_claim_id,
    ]
}

pub(super) fn initial_digest(
    namespace: &str,
    binding: &LiveObjectBinding,
) -> Result<String, ApplicationError> {
    Ok(hex_sha256(
        &serde_json::to_vec(&(
            "accepted-history-v1",
            [
                namespace,
                &binding.workspace_id,
                &binding.main_version_id,
                &binding.object_id,
                &binding.lineage_claim_id,
            ],
        ))
        .map_err(|_| ApplicationError::Corrupt)?,
    ))
}

pub(super) fn next_digest(
    previous: &str,
    count: i64,
    metadata: &AdmittedLiveUpdateMetadata,
) -> Result<String, ApplicationError> {
    let mut writer = native_state::HashWriter::default();
    serde_json::to_writer(
        &mut writer,
        &(
            if metadata.canonical_version == Some(2) {
                "accepted-event-v2"
            } else {
                "accepted-event-v1"
            },
            previous,
            count,
            metadata,
        ),
    )
    .map_err(|_| ApplicationError::Corrupt)?;
    Ok(writer.finish())
}

pub(super) fn require_version_transition(
    previous: &AdmittedLiveUpdateMetadata,
    next: &AdmittedLiveUpdateMetadata,
) -> Result<(), ApplicationError> {
    previous.validate_extensions()?;
    next.validate_extensions()?;
    if previous.canonical_version == Some(2) && next.canonical_version != Some(2) {
        return Err(invalid("accepted history version downgrade"));
    }
    Ok(())
}
pub(super) fn origin_stamp(
    conn: &Connection,
    held: &Registration,
) -> Result<String, ApplicationError> {
    origin_stamp_in(
        conn,
        held,
        &mut restore_content::Budget {
            remaining: usize::MAX,
        },
    )
}

/// Charges at least the origin row's raw columns before reading them, and the
/// stamp's JSON as it is written. The adoption array matches SQLite's former
/// `json_array` of the same columns byte for byte.
pub(super) fn origin_stamp_in(
    conn: &Connection,
    held: &Registration,
    budget: &mut restore_content::Budget,
) -> Result<String, ApplicationError> {
    let p = parameters(held);
    let lengths = [
        "bootstrap_id",
        "bootstrap_moment_id",
        "baseline_moment_relay_sequence",
        "baseline_registered_at_ms",
        "baseline_digest",
        "baseline_byte_length",
        "projected_markdown_digest",
        "projected_markdown_byte_length",
        "binding_json",
        "host_coordinate_json",
        "local_ydoc_sequence",
    ]
    .map(|column| format!("coalesce(length(CAST({column} AS BLOB)),0)"))
    .join("+");
    let bootstrap: Option<i64> = conn
        .query_row(
            &format!("SELECT {lengths} FROM live_device_bootstraps WHERE {DOCUMENT}"),
            p,
            |r| r.get(0),
        )
        .optional()
        .map_err(read_sql)?;
    if let Some(length) = bootstrap {
        // Decoding can shrink stored JSON, so the raw read is consumed first.
        // Serializing reuses that reservation and charges only its expansion.
        let raw = usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?;
        budget.charge(raw)?;
        let record = bootstrap::read_bootstrap(conn, held)?.ok_or(ApplicationError::Corrupt)?;
        let bytes = restore_content::Budget {
            remaining: raw.saturating_add(budget.remaining),
        }
        .json(&record)?;
        budget.charge(bytes.len().saturating_sub(raw))?;
        return Ok(hex_sha256(&bytes));
    }
    let json = budget.sql_json_array(
        conn,
        &[
            "adoption_id",
            "evidence_digest",
            "binding_json",
            "source_moment_id",
            "source_digest",
            "source_byte_length",
            "baseline_moment_relay_sequence",
            "baseline_registered_at_ms",
            "coverage_digest",
            "covered_outbox_sequence",
            "local_ydoc_sequence",
            "terminal_cursor",
            "terminal_receipt_json",
            "host_coordinate_json",
            "max_pending_bytes",
            "max_pending_age_ms",
        ],
        &format!("FROM live_owner_adoptions WHERE {DOCUMENT}"),
        params![p[0], p[1], p[2], p[3], p[4]],
    )?;
    Ok(hex_sha256(json.as_bytes()))
}

/// Check `bytes`, the state `doc` holds, as accepted state: a note the
/// engine's reader built by the reader's rule, any other by the strict public
/// rule. Initialization, native replay and every checkpoint use it, so a
/// lineage whose baseline the reader built replays and checkpoints too.
fn validate_baseline(doc: &Ydoc, bytes: &[u8]) -> Result<(), ApplicationError> {
    if doc.has_reader_source() {
        doc.validate_reader_baseline(bytes)?;
    } else {
        doc.validate_public_baseline(bytes)?;
    }
    Ok(())
}

pub(super) fn initialize(
    tx: &Transaction<'_>,
    held: &Registration,
    baseline: &[u8],
) -> Result<(), ApplicationError> {
    if hex_sha256(baseline) != held.binding.lineage_claim_id {
        return Err(ApplicationError::Conflict);
    }
    let doc = Ydoc::wire();
    doc.apply(baseline)?;
    validate_baseline(&doc, baseline)?;
    let checkpoint = NativeAcceptedCheckpoint {
        canonical_version: None,
        restore_operation_id: None,
        event_count: 0,
        terminal: None,
        binding: held.binding.clone(),
        state_digest: put_binary_blob(tx, baseline)?,
        evidence_digest: initial_digest(&held.namespace, &held.binding)?,
    };
    insert_checkpoint(
        tx,
        held,
        &checkpoint,
        &mut restore_content::Budget {
            remaining: crate::limits::MAX_YDOC_UPDATE_BYTES,
        },
    )
}

fn insert_checkpoint(
    tx: &Transaction<'_>,
    held: &Registration,
    c: &NativeAcceptedCheckpoint,
    budget: &mut restore_content::Budget,
) -> Result<(), ApplicationError> {
    let p = parameters(held);
    tx.execute(
        "INSERT INTO live_accepted_checkpoints VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            p[0],
            p[1],
            p[2],
            p[3],
            p[4],
            c.event_count,
            c.terminal.as_ref().map_or(0, |r| r.journal_cursor),
            serde_json::to_string(&c.terminal).map_err(|_| ApplicationError::Corrupt)?,
            serde_json::to_string(&c.binding).map_err(|_| ApplicationError::Corrupt)?,
            origin_stamp(tx, held)?,
            c.state_digest,
            c.evidence_digest,
            c.restore_operation_id,
            c.restore_operation_id.as_deref().map(|id| restore_stamp(tx,held,id,budget)).transpose()?
        ],
    )
    .map_err(write_sql)?;
    Ok(())
}

#[derive(Clone, Copy)]
enum CheckpointRead {
    Proof { verify_cadence: bool },
    NativeState { verify_cadence: bool },
    NativeAppend,
}
impl CheckpointRead {
    fn verify_cadence(self) -> bool {
        match self {
            Self::Proof { verify_cadence } | Self::NativeState { verify_cadence } => verify_cadence,
            Self::NativeAppend => false,
        }
    }
    fn native(self) -> bool {
        matches!(self, Self::NativeState { .. } | Self::NativeAppend)
    }
}

fn checkpoint(
    conn: &Connection,
    held: &Registration,
    through: i64,
    budget: &mut restore_content::Budget,
    verify_cadence: bool,
) -> Result<NativeAcceptedCheckpoint, ApplicationError> {
    checkpoint_in(
        conn,
        held,
        through,
        budget,
        CheckpointRead::Proof { verify_cadence },
    )
}

fn checkpoint_in(
    conn: &Connection,
    held: &Registration,
    through: i64,
    budget: &mut restore_content::Budget,
    mode: CheckpointRead,
) -> Result<NativeAcceptedCheckpoint, ApplicationError> {
    let p = parameters(held);
    let sql = format!(
        "SELECT event_count,journal_cursor,length(CAST(terminal_json AS BLOB))+length(CAST(binding_json AS BLOB))+length(CAST(state_sha256 AS BLOB))+length(CAST(evidence_digest AS BLOB))+length(CAST(origin_stamp AS BLOB))+coalesce(length(CAST(restore_operation_id AS BLOB)),0)+coalesce(length(CAST(restore_stamp AS BLOB)),0) FROM live_accepted_checkpoints WHERE {DOCUMENT} AND journal_cursor<=?6 ORDER BY journal_cursor DESC LIMIT 1"
    );
    let (count, cursor, length): (i64, i64, i64) = conn
        .query_row(&sql, params![p[0], p[1], p[2], p[3], p[4], through], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()
        .map_err(read_sql)?
        .ok_or(ApplicationError::Conflict)?;
    if mode.native()
        && (length < 0 || length as u64 > NativeHistoryReconstruction::HEADER_BYTES as u64)
    {
        return Err(ApplicationError::Corrupt);
    }
    integer(count, 0, SAFE).map_err(|_| ApplicationError::Corrupt)?;
    integer(cursor, 0, SAFE).map_err(|_| ApplicationError::Corrupt)?;
    budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
    let sql = format!(
        "SELECT terminal_json,binding_json,state_sha256,evidence_digest,origin_stamp,restore_operation_id,restore_stamp FROM live_accepted_checkpoints WHERE {DOCUMENT} AND event_count=?6"
    );
    let (
        terminal,
        binding,
        state_digest,
        evidence_digest,
        stamp,
        restore_operation_id,
        saved_restore_stamp,
    ): (
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    ) = conn
        .query_row(&sql, params![p[0], p[1], p[2], p[3], p[4], count], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })
        .map_err(read_sql)?;
    let actual_stamp = if mode.native() {
        origin_stamp_in(
            conn,
            held,
            &mut restore_content::Budget {
                remaining: NativeHistoryReconstruction::HEADER_BYTES,
            },
        )?
    } else {
        origin_stamp_in(conn, held, budget)?
    };
    if stamp != actual_stamp {
        return Err(ApplicationError::Corrupt);
    }
    let terminal: Option<LiveUpdateReceipt> =
        serde_json::from_str(&terminal).map_err(|_| ApplicationError::Corrupt)?;
    let binding: LiveObjectBinding =
        serde_json::from_str(&binding).map_err(|_| ApplicationError::Corrupt)?;
    binding
        .validate_canonical()
        .map_err(|_| ApplicationError::Corrupt)?;
    require_document(held, &binding)?;
    digest(&state_digest)?;
    digest(&evidence_digest)?;
    if terminal.as_ref().map_or(0, |r| r.journal_cursor) != cursor
        || (count == 0) != terminal.is_none()
    {
        return Err(ApplicationError::Corrupt);
    }
    if let Some(receipt) = &terminal {
        receipt.validate()?;
    }
    if count == 0
        && (state_digest != held.binding.lineage_claim_id
            || evidence_digest != initial_digest(&held.namespace, &held.binding)?)
    {
        return Err(ApplicationError::Corrupt);
    }
    if count == 0 && restore_operation_id.is_some() {
        return Err(ApplicationError::Corrupt);
    };
    if let Some(id) = &restore_operation_id {
        identifier(id, 512)?;
        digest(
            saved_restore_stamp
                .as_deref()
                .ok_or(ApplicationError::Corrupt)?,
        )?;
        if matches!(mode, CheckpointRead::Proof { .. })
            && Some(restore_stamp(conn, held, id, budget)?) != saved_restore_stamp
        {
            return Err(ApplicationError::Corrupt);
        };
        let bound = if matches!(mode, CheckpointRead::NativeAppend) {
            // Historical restore JSON and content are checked by state replay.
            // Append still binds this checkpoint to the committed fence row.
            conn.query_row(
                NATIVE_APPEND_FENCE,
                params![
                    held.namespace,
                    id,
                    terminal
                        .as_ref()
                        .ok_or(ApplicationError::Corrupt)?
                        .delivery_id,
                    binding.restore_fence_generation,
                    binding.workspace_id,
                    binding.main_version_id,
                    binding.object_id,
                    binding.lineage_claim_id
                ],
                |r| r.get::<_, bool>(0),
            )
            .optional()
            .map_err(read_sql)?
            .unwrap_or(false)
        } else {
            conn.query_row("SELECT application_delivery_id=?3 AND new_generation=?4 AND json_extract(application_json,'$.admitted.accepted.binding')=?5 FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2",params![held.namespace,id,terminal.as_ref().ok_or(ApplicationError::Corrupt)?.delivery_id,binding.restore_fence_generation,serde_json::to_string(&binding).map_err(|_|ApplicationError::Corrupt)?],|r|r.get::<_,bool>(0)).map_err(read_sql)?
        };
        if !bound {
            return Err(ApplicationError::Corrupt);
        };
        if matches!(
            mode,
            CheckpointRead::Proof {
                verify_cadence: true
            }
        ) {
            verify_restore_state(conn, held, id, &state_digest, budget)?;
        }
    } else if saved_restore_stamp.is_some() {
        return Err(ApplicationError::Corrupt);
    };
    let mut canonical_version = None;
    if count > 0 {
        let sql = format!(
            "SELECT length(CAST(metadata_json AS BLOB)) FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6 AND journal_cursor=?7"
        );
        let length: i64 = conn
            .query_row(
                &sql,
                params![p[0], p[1], p[2], p[3], p[4], count, cursor],
                |r| r.get(0),
            )
            .map_err(read_sql)?;
        let (metadata, expected) = if mode.native() {
            let metadata = native_state::metadata(conn, held, count)?;
            let expected = conn.query_row(
                &format!("SELECT evidence_digest FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6"),
                params![p[0],p[1],p[2],p[3],p[4],count], |r| r.get::<_,String>(0),
            ).map_err(read_sql)?;
            (metadata, expected)
        } else {
            budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
            let sql = format!(
                "SELECT metadata_json,evidence_digest FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6 AND journal_cursor=?7"
            );
            let (json, expected): (String, String) = conn
                .query_row(
                    &sql,
                    params![p[0], p[1], p[2], p[3], p[4], count, cursor],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(read_sql)?;
            let metadata: AdmittedLiveUpdateMetadata =
                serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
            metadata.validate_extensions()?;
            (
                native_state::NativeMetadata {
                    canonical_version: metadata.canonical_version,
                    checkpoint_coverage: metadata.checkpoint_coverage.is_some(),
                    accepted: metadata.accepted,
                    evidence_digest: expected.clone(),
                },
                expected,
            )
        };
        canonical_version = metadata.canonical_version;
        let checkpoint_coverage = metadata.checkpoint_coverage;
        if Some(&metadata.accepted.receipt) != terminal.as_ref()
            || metadata.accepted.binding != binding
            || expected != evidence_digest
        {
            return Err(ApplicationError::Corrupt);
        }
        if let Some(id) = &restore_operation_id {
            if matches!(mode, CheckpointRead::NativeState { .. }) {
                native_state::restore_association(
                    conn,
                    held,
                    id,
                    &metadata.accepted,
                    None,
                    Some(&state_digest),
                )?;
                native_state::restore_metadata(conn, held, id, count, &evidence_digest)?;
            }
        }
        drop(metadata);
        if mode.verify_cadence() {
            // Check cadence from the preceding checkpoint using lengths only.
            let sql = format!(
                "SELECT event_count FROM live_accepted_checkpoints WHERE {DOCUMENT} AND event_count<?6 ORDER BY event_count DESC LIMIT 1"
            );
            let previous: i64 = conn
                .query_row(&sql, params![p[0], p[1], p[2], p[3], p[4], count], |r| {
                    r.get(0)
                })
                .map_err(read_sql)?;
            let (events, bytes) = segment_position(conn, held, previous, count)?;
            if restore_operation_id.is_none()
                && !checkpoint_coverage
                && events != CHECKPOINT_EVENTS
                && bytes < CHECKPOINT_BYTES
            {
                return Err(ApplicationError::Corrupt);
            }
        }
    }
    Ok(NativeAcceptedCheckpoint {
        canonical_version,
        restore_operation_id,
        event_count: count,
        terminal,
        binding,
        state_digest,
        evidence_digest,
    })
}

fn require_document(held: &Registration, b: &LiveObjectBinding) -> Result<(), ApplicationError> {
    if b.workspace_id != held.binding.workspace_id
        || b.main_version_id != held.binding.main_version_id
        || b.object_id != held.binding.object_id
        || b.lineage_claim_id != held.binding.lineage_claim_id
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

fn segment_position(
    conn: &Connection,
    held: &Registration,
    after: i64,
    through: i64,
) -> Result<(i64, i64), ApplicationError> {
    let p = parameters(held);
    let sql = "SELECT a.event_count,b.byte_length,length(b.bytes),a.suffix_count,a.suffix_bytes FROM live_accepted_updates a JOIN binary_blobs b ON b.sha256=a.update_sha256 WHERE a.relay_database_namespace=?1 AND a.workspace_id=?2 AND a.main_version_id=?3 AND a.object_id=?4 AND a.lineage_claim_id=?5 AND a.event_count>?6 AND a.event_count<=?7 ORDER BY a.event_count LIMIT 4096";
    let mut query = conn.prepare(sql).map_err(read_sql)?;
    let mut rows = query
        .query(params![p[0], p[1], p[2], p[3], p[4], after, through])
        .map_err(read_sql)?;
    let mut count = 0;
    let mut bytes = 0;
    while let Some(row) = rows.next().map_err(read_sql)? {
        if count == CHECKPOINT_EVENTS || bytes >= CHECKPOINT_BYTES {
            return Err(ApplicationError::Corrupt);
        }
        let ordinal: i64 = row.get(0).map_err(read_sql)?;
        let length: i64 = row.get(1).map_err(read_sql)?;
        if ordinal != after + count + 1
            || length <= 0
            || length > CHECKPOINT_BYTES
            || row.get::<_, i64>(2).map_err(read_sql)? != length
        {
            return Err(ApplicationError::Corrupt);
        }
        count += 1;
        bytes += length;
        if row.get::<_, i64>(3).map_err(read_sql)? != count
            || row.get::<_, i64>(4).map_err(read_sql)? != bytes
        {
            return Err(ApplicationError::Corrupt);
        }
    }
    if after + count != through {
        return Err(ApplicationError::Corrupt);
    }
    Ok((count, bytes))
}

/// A full accepted history is initialized only by verified bootstrap or adoption.
/// Other application users can keep applying without gaining restore authority.
pub(super) fn append_native(
    tx: &Transaction<'_>,
    held: &Registration,
    event: &AdmittedLiveUpdate,
    working_reserve_bytes: usize,
) -> Result<(), ApplicationError> {
    append_inner(
        tx,
        held,
        event,
        &mut restore_content::Budget {
            remaining: usize::MAX,
        },
        None,
        Some(NativeHistoryReconstruction {
            working_reserve_bytes,
        }),
    )
}

pub(super) fn append_restore(
    tx: &Transaction<'_>,
    held: &Registration,
    event: &AdmittedLiveUpdate,
    doc: &Ydoc,
    operation: &str,
    budget: &mut restore_content::Budget,
) -> Result<(), ApplicationError> {
    append_inner(tx, held, event, budget, Some((operation, doc)), None)
}

fn append_inner(
    tx: &Transaction<'_>,
    held: &Registration,
    event: &AdmittedLiveUpdate,
    budget: &mut restore_content::Budget,
    restored: Option<(&str, &Ydoc)>,
    reconstruction: Option<NativeHistoryReconstruction>,
) -> Result<(), ApplicationError> {
    let p = parameters(held);
    let sql = format!("SELECT EXISTS(SELECT 1 FROM live_accepted_checkpoints WHERE {DOCUMENT})");
    if !tx
        .query_row(&sql, p, |r| r.get::<_, bool>(0))
        .map_err(read_sql)?
    {
        if bootstrap::read_bootstrap(tx, held)?.is_some()
            || adoption::read_origin(tx, held)?.is_some()
        {
            return Err(ApplicationError::Corrupt);
        }
        return Ok(());
    }
    let c = if reconstruction.is_some() {
        checkpoint_in(tx, held, SAFE, budget, CheckpointRead::NativeAppend)?
    } else {
        checkpoint(tx, held, SAFE, budget, false)?
    };
    let sql = format!(
        "SELECT event_count,journal_cursor,evidence_digest,suffix_count,suffix_bytes FROM live_accepted_updates WHERE {DOCUMENT} ORDER BY event_count DESC LIMIT 1"
    );
    let prior: Option<(i64, i64, String, i64, i64)> = tx
        .query_row(&sql, p, |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .optional()
        .map_err(read_sql)?;
    let (count, cursor, previous, (binding, terminal), prior_events, prior_bytes) = match prior {
        Some((count, cursor, digest, events, bytes)) => {
            // State-only metadata reads never charge discarded records cumulatively.
            // Restore append retains its external proof budget semantics.
            let accepted = if reconstruction.is_some() {
                {
                    let previous = native_state::metadata(tx, held, count)?;
                    if previous.canonical_version == Some(2)
                        && event.metadata.canonical_version != Some(2)
                    {
                        return Err(invalid("accepted history version downgrade"));
                    }
                    previous.accepted
                }
            } else {
                let sql = format!(
                    "SELECT length(CAST(metadata_json AS BLOB)),metadata_json FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6"
                );
                let length: i64 = tx
                    .query_row(&sql, params![p[0], p[1], p[2], p[3], p[4], count], |r| {
                        r.get(0)
                    })
                    .map_err(read_sql)?;
                budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
                let json: String = tx
                    .query_row(&sql, params![p[0], p[1], p[2], p[3], p[4], count], |r| {
                        r.get(1)
                    })
                    .map_err(read_sql)?;
                let metadata: AdmittedLiveUpdateMetadata =
                    serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
                require_version_transition(&metadata, &event.metadata)?;
                metadata.accepted
            };
            (
                count,
                cursor,
                digest,
                (accepted.binding, Some(accepted.receipt)),
                events,
                bytes,
            )
        }
        None => (
            0,
            0,
            c.evidence_digest.clone(),
            (c.binding.clone(), c.terminal.clone()),
            0,
            0,
        ),
    };
    require_document(held, &event.metadata.accepted.binding)?;
    if event.metadata.accepted.receipt.journal_cursor <= cursor || count == SAFE {
        return Err(ApplicationError::Conflict);
    }
    let tip = Tip {
        terminal: terminal.as_ref(),
        count,
        evidence: &previous,
    };
    if reconstruction.is_some() {
        native_state::transition(
            tx,
            held,
            &binding,
            &tip,
            &event.metadata.accepted,
            &next_digest(&previous, count + 1, &event.metadata)?,
        )?;
    } else {
        require_transition(tx, held, &binding, &tip, &event.metadata)?;
    }
    let (events, bytes) = if count == c.event_count {
        (1, event.update_bytes.len() as i64)
    } else {
        if count - c.event_count != prior_events
            || prior_events >= CHECKPOINT_EVENTS
            || prior_bytes >= CHECKPOINT_BYTES
        {
            return Err(ApplicationError::Corrupt);
        }
        (
            prior_events + 1,
            prior_bytes + event.update_bytes.len() as i64,
        )
    };
    let count = count + 1;
    let evidence = next_digest(&previous, count, &event.metadata)?;
    append(
        tx,
        &held.namespace,
        &held.binding,
        event,
        count,
        events,
        bytes,
        &evidence,
    )?;
    if restored.is_some()
        || events == CHECKPOINT_EVENTS
        || bytes >= CHECKPOINT_BYTES
        || event.metadata.checkpoint_coverage.is_some()
    {
        let history = reconstruction
            .map(|policy| {
                read_state(
                    tx,
                    held,
                    event.metadata.accepted.receipt.journal_cursor,
                    policy,
                )
            })
            .transpose()?;
        let doc = restored
            .map(|(_, doc)| doc)
            .or(history.as_ref())
            .ok_or(ApplicationError::Corrupt)?;
        let state = doc
            .encode_full_state_bounded(if reconstruction.is_some() {
                CHECKPOINT_BYTES as usize
            } else {
                budget.remaining.min(CHECKPOINT_BYTES as usize)
            })
            .ok_or_else(|| {
                if budget.remaining < CHECKPOINT_BYTES as usize {
                    ApplicationError::ConfiguredByteBudgetExceeded
                } else {
                    invalid("accepted checkpoint exceeds update limit")
                }
            })?;
        if reconstruction.is_none() {
            budget.charge(state.len())?;
        }
        validate_baseline(doc, &state)?;
        insert_checkpoint(
            tx,
            held,
            &NativeAcceptedCheckpoint {
                canonical_version: event.metadata.canonical_version,
                restore_operation_id: restored.map(|(id, _)| id.to_owned()),
                event_count: count,
                terminal: Some(event.metadata.accepted.receipt.clone()),
                binding: event.metadata.accepted.binding.clone(),
                state_digest: put_binary_blob(tx, &state)?,
                evidence_digest: evidence,
            },
            budget,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn append(
    tx: &Transaction<'_>,
    namespace: &str,
    binding: &LiveObjectBinding,
    event: &AdmittedLiveUpdate,
    count: i64,
    events: i64,
    bytes: i64,
    evidence: &str,
) -> Result<(), ApplicationError> {
    let p = [
        namespace,
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
        &binding.lineage_claim_id,
    ];
    let update = put_binary_blob(tx, &event.update_bytes)?;
    tx.execute(
        "INSERT INTO live_accepted_updates VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            p[0],
            p[1],
            p[2],
            p[3],
            p[4],
            count,
            event.metadata.accepted.receipt.journal_cursor,
            event.metadata.accepted.receipt.delivery_id,
            native_state::json(&event.metadata)?,
            update,
            events,
            bytes,
            evidence
        ],
    )
    .map_err(write_sql)?;
    Ok(())
}

/// An event changes the generation only as a restore's application, or as
/// the first event after restores cancelled at `tip`. Cancellations before a
/// restore's fence lead from `previous` to the generation it fenced.
fn require_transition(
    conn: &Connection,
    held: &Registration,
    previous: &LiveObjectBinding,
    tip: &Tip<'_>,
    next: &AdmittedLiveUpdateMetadata,
) -> Result<(), ApplicationError> {
    let binding = &next.accepted.binding;
    let from = previous.restore_fence_generation;
    if from == binding.restore_fence_generation {
        return Ok(());
    }
    let json:Option<String>=conn.query_row("SELECT application_json FROM live_restore_fences WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND application_delivery_id=?5",params![held.namespace,held.workspace_id,binding.main_version_id,binding.object_id,next.accepted.receipt.delivery_id],|r|r.get(0)).optional().map_err(read_sql)?.flatten();
    let Some(json) = json else {
        return restore_fence::require_cancelled(
            conn,
            held,
            from,
            binding.restore_fence_generation,
            tip,
        );
    };
    let receipt: NativeRestoreApplicationReceipt =
        serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
    let fenced = receipt.fence.operation.old_binding.restore_fence_generation;
    if receipt.admitted != *next
        || receipt.fence.operation.new_fence != binding.restore_fence_generation
        || receipt.fence.operation.old_binding.lineage_claim_id != binding.lineage_claim_id
    {
        return Err(ApplicationError::Conflict);
    }
    if fenced != from {
        restore_fence::require_cancelled(conn, held, from, fenced, tip)?;
    }
    Ok(())
}

/// Resume routing needs the committed checkpoint association, not a second Ydoc.
/// The admitted state reader separately validates its origin and public content.
pub(super) fn validate_resume_checkpoint(
    conn: &Connection,
    held: &Registration,
    operation: &str,
    receipt: &LiveUpdateReceipt,
) -> Result<(), ApplicationError> {
    let p = parameters(held);
    let length: i64 = conn.query_row(
        &format!("SELECT length(CAST(terminal_json AS BLOB))+length(CAST(binding_json AS BLOB))+length(CAST(state_sha256 AS BLOB))+length(CAST(evidence_digest AS BLOB)) FROM live_accepted_checkpoints WHERE {DOCUMENT} AND journal_cursor=?6 AND restore_operation_id=?7"),
        params![p[0],p[1],p[2],p[3],p[4],receipt.journal_cursor,operation], |r|r.get(0),
    ).map_err(read_sql)?;
    if !(1..=NativeHistoryReconstruction::HEADER_BYTES as i64).contains(&length) {
        return Err(ApplicationError::Corrupt);
    }
    let (count,terminal,binding,state,evidence):(i64,String,String,String,String)=conn.query_row(
        &format!("SELECT event_count,terminal_json,binding_json,state_sha256,evidence_digest FROM live_accepted_checkpoints WHERE {DOCUMENT} AND journal_cursor=?6 AND restore_operation_id=?7"),
        params![p[0],p[1],p[2],p[3],p[4],receipt.journal_cursor,operation], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
    ).map_err(read_sql)?;
    integer(count, 1, SAFE).map_err(|_| ApplicationError::Corrupt)?;
    digest(&state)?;
    digest(&evidence)?;
    let terminal: LiveUpdateReceipt =
        serde_json::from_str(&terminal).map_err(|_| ApplicationError::Corrupt)?;
    let binding: LiveObjectBinding =
        serde_json::from_str(&binding).map_err(|_| ApplicationError::Corrupt)?;
    if terminal != *receipt || binding != held.binding {
        return Err(ApplicationError::Corrupt);
    };
    let metadata = native_state::metadata(conn, held, count)?;
    if metadata.accepted.receipt != terminal
        || metadata.accepted.binding != binding
        || metadata.evidence_digest != evidence
    {
        return Err(ApplicationError::Corrupt);
    }
    native_state::restore_association(conn, held, operation, &metadata.accepted, None, None)?;
    native_state::restore_metadata(conn, held, operation, count, &evidence)?;
    native_state::validate_blob_hash(conn, &state)
}

pub(super) fn read_state(
    conn: &Connection,
    held: &Registration,
    through: i64,
    policy: NativeHistoryReconstruction,
) -> Result<Ydoc, ApplicationError> {
    native_state::read(
        conn,
        held,
        through,
        policy,
        &mut restore_content::Budget {
            remaining: usize::MAX,
        },
    )
}

/// [`read_state`] for a reader no registration serves: the lineage's history
/// in `namespace` selected by its durable identity alone, through a view that
/// is never registered or live. `binding` and `coordinate` are the ones a
/// durable record kept; only the document and lineage select the history.
/// The blobs it replays are charged to `budget`.
pub(super) fn read_state_by_identity(
    conn: &Connection,
    namespace: &str,
    binding: LiveObjectBinding,
    coordinate: ApplicationHostCoordinate,
    through: i64,
    budget: &mut restore_content::Budget,
) -> Result<Ydoc, ApplicationError> {
    let view = Registration {
        workspace_id: binding.workspace_id.clone(),
        namespace: namespace.to_owned(),
        coordinate,
        binding,
        activation_id: None,
        live: false,
    };
    let policy = NativeHistoryReconstruction {
        working_reserve_bytes: budget.remaining,
    };
    native_state::read(conn, &view, through, policy, budget)
}

pub(super) fn read(
    conn: &Connection,
    held: &Registration,
    through: i64,
    budget: &mut restore_content::Budget,
    max_events: usize,
) -> Result<HistoryRead, ApplicationError> {
    read_inner(
        conn,
        held,
        through,
        budget,
        max_events,
        HistoryPurpose::Restore,
    )
}

pub(super) enum HistoryPurpose {
    Native,
    Restore,
}

pub(super) fn read_inner(
    conn: &Connection,
    held: &Registration,
    through: i64,
    budget: &mut restore_content::Budget,
    max_events: usize,
    purpose: HistoryPurpose,
) -> Result<HistoryRead, ApplicationError> {
    let retain_metadata = matches!(purpose, HistoryPurpose::Restore);
    let c = checkpoint(conn, held, through, budget, true)?;
    let baseline = budget.blob(conn, &c.state_digest)?;
    let doc = Ydoc::wire();
    doc.apply(&baseline)?;
    if retain_metadata && doc.has_reader_source() {
        doc.validate_reader_baseline(&baseline)?;
    } else {
        doc.validate_public_baseline(&baseline)?;
    }
    let p = parameters(held);
    let sql = format!(
        "SELECT event_count,journal_cursor,length(CAST(metadata_json AS BLOB)),update_sha256,evidence_digest FROM live_accepted_updates WHERE {DOCUMENT} AND event_count>?6 AND journal_cursor<=?7 ORDER BY event_count LIMIT ?8"
    );
    let mut query = conn.prepare(&sql).map_err(read_sql)?;
    let mut rows = query
        .query(params![
            p[0],
            p[1],
            p[2],
            p[3],
            p[4],
            c.event_count,
            through,
            (max_events.min(CHECKPOINT_EVENTS as usize) + 1) as i64
        ])
        .map_err(read_sql)?;
    let mut metadata_query: Option<rusqlite::Statement<'_>> = None;
    let mut suffix = Vec::new();
    let mut count = c.event_count;
    let mut terminal = c.terminal.clone();
    let mut evidence = c.evidence_digest.clone();
    let mut binding = c.binding.clone();
    let mut canonical_version = c.canonical_version;
    let mut bytes = 0;
    while let Some(row) = rows.next().map_err(read_sql)? {
        if count - c.event_count >= max_events as i64
            || count - c.event_count >= CHECKPOINT_EVENTS
            || bytes >= CHECKPOINT_BYTES
        {
            return Err(invalid("accepted suffix exceeds configured bounds"));
        }
        let ordinal: i64 = row.get(0).map_err(read_sql)?;
        let cursor: i64 = row.get(1).map_err(read_sql)?;
        let metadata_len: i64 = row.get(2).map_err(read_sql)?;
        if ordinal != count + 1 || cursor <= terminal.as_ref().map_or(0, |r| r.journal_cursor) {
            return Err(ApplicationError::Corrupt);
        }
        budget.charge(usize::try_from(metadata_len).map_err(|_| ApplicationError::Corrupt)?)?;
        let statement = match &mut metadata_query {
            Some(statement) => statement,
            empty => empty.insert(
                conn.prepare(&format!(
                    "SELECT metadata_json FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6"
                ))
                .map_err(read_sql)?,
            ),
        };
        let json: String = statement
            .query_row(params![p[0], p[1], p[2], p[3], p[4], ordinal], |r| r.get(0))
            .map_err(read_sql)?;
        let metadata: AdmittedLiveUpdateMetadata =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        let update_digest: String = row.get(3).map_err(read_sql)?;
        if metadata.accepted.receipt.update_digest != update_digest
            || metadata.accepted.receipt.journal_cursor != cursor
        {
            return Err(ApplicationError::Corrupt);
        }
        let update = budget.blob(conn, &update_digest)?;
        let event = AdmittedLiveUpdate {
            metadata,
            update_bytes: update,
        };
        event.validate()?;
        if canonical_version == Some(2) && event.metadata.canonical_version != Some(2) {
            return Err(invalid("accepted history version downgrade"));
        }
        canonical_version = event.metadata.canonical_version;
        require_document(held, &event.metadata.accepted.binding)?;
        let tip = Tip {
            terminal: terminal.as_ref(),
            count,
            evidence: &evidence,
        };
        require_transition(conn, held, &binding, &tip, &event.metadata)?;
        let next = next_digest(&evidence, ordinal, &event.metadata)?;
        if next != row.get::<_, String>(4).map_err(read_sql)? {
            return Err(ApplicationError::Corrupt);
        }
        doc.apply(&event.update_bytes)?;
        bytes += event.update_bytes.len() as i64;
        count = ordinal;
        terminal = Some(event.metadata.accepted.receipt.clone());
        evidence = next;
        binding = event.metadata.accepted.binding.clone();
        if retain_metadata {
            suffix.push(event.metadata);
        }
    }
    if terminal.as_ref().map_or(0, |r| r.journal_cursor) != through || doc.has_missing_updates() {
        return Err(ApplicationError::Conflict);
    }
    Ok(HistoryRead {
        doc,
        proof: NativeRestoreHistoryProof {
            checkpoint: c,
            suffix,
            event_count: count,
            terminal,
            evidence_digest: evidence,
        },
    })
}

pub(super) fn accepted_source(
    conn: &Connection,
    held: &Registration,
    delivery: &str,
    budget: &mut restore_content::Budget,
) -> Result<Option<AdmittedLiveUpdateMetadata>, ApplicationError> {
    let length:Option<i64>=conn.query_row("SELECT length(CAST(metadata_json AS BLOB)) FROM live_accepted_updates WHERE relay_database_namespace=?1 AND delivery_id=?2",params![held.namespace,delivery],|r|r.get(0)).optional().map_err(read_sql)?;
    let Some(length) = length else {
        let applied:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM live_device_update_applications WHERE relay_database_namespace=?1 AND delivery_id=?2)",params![held.namespace,delivery],|r|r.get(0)).map_err(read_sql)?;
        if applied {
            return Err(ApplicationError::Corrupt);
        }
        return Ok(None);
    };
    budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
    let (json,count,cursor,update,evidence):(String,i64,i64,String,String)=conn.query_row("SELECT metadata_json,event_count,journal_cursor,update_sha256,evidence_digest FROM live_accepted_updates WHERE relay_database_namespace=?1 AND delivery_id=?2",params![held.namespace,delivery],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(read_sql)?;
    let metadata: AdmittedLiveUpdateMetadata =
        serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
    require_document(held, &metadata.accepted.binding)?;
    metadata.accepted.receipt.validate()?;
    let previous = if count == 1 {
        initial_digest(&held.namespace, &held.binding)?
    } else {
        let p = parameters(held);
        let length: i64 = conn.query_row(
            &format!("SELECT length(CAST(metadata_json AS BLOB)) FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6"),
            params![p[0], p[1], p[2], p[3], p[4], count - 1], |r| r.get(0),
        ).map_err(read_sql)?;
        budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
        let sql = format!(
            "SELECT evidence_digest,metadata_json FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6"
        );
        let (digest, json): (String, String) = conn
            .query_row(
                &sql,
                params![p[0], p[1], p[2], p[3], p[4], count - 1],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(read_sql)?;
        let prior: AdmittedLiveUpdateMetadata =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        require_version_transition(&prior, &metadata)?;
        digest
    };
    if count <= 0
        || metadata.accepted.receipt.delivery_id != delivery
        || metadata.accepted.receipt.journal_cursor != cursor
        || metadata.accepted.receipt.update_digest != update
        || next_digest(&previous, count, &metadata)? != evidence
    {
        return Err(ApplicationError::Corrupt);
    }
    Ok(Some(metadata))
}

fn restore_stamp(
    conn: &Connection,
    held: &Registration,
    id: &str,
    budget: &mut restore_content::Budget,
) -> Result<String, ApplicationError> {
    let json = budget.sql_json_array(
        conn,
        &["input_json", "receipt_json", "proposal_json", "proposal_candidate_sha256", "proposal_frozen_sha256", "proposal_point_sha256", "application_json", "application_delivery_id"],
        "FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2 AND workspace_id=?3 AND main_version_id=?4 AND object_id=?5",
        params![held.namespace,id,held.workspace_id,held.binding.main_version_id,held.binding.object_id],
    )?;
    Ok(hex_sha256(json.as_bytes()))
}

fn verify_restore_state(
    conn: &Connection,
    held: &Registration,
    id: &str,
    state_digest: &str,
    budget: &mut restore_content::Budget,
) -> Result<(), ApplicationError> {
    let (frozen,candidate,proposal):(String,String,String)=conn.query_row("SELECT proposal_frozen_sha256,proposal_candidate_sha256,proposal_json FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2",params![held.namespace,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(read_sql)?;
    // restore_stamp charged the complete retained metadata before this read.
    let proposal: NativeRestoreProposalReceipt =
        serde_json::from_str(&proposal).map_err(|_| ApplicationError::Corrupt)?;
    if proposal.fence.operation.operation_id != id
        || proposal.frozen_state_digest != frozen
        || proposal.candidate_digest != candidate
    {
        return Err(ApplicationError::Corrupt);
    };
    let doc = Ydoc::wire();
    doc.apply(&budget.blob(conn, &frozen)?)?;
    for source in &proposal.native_sources {
        let bytes = budget.blob(conn, &source.update_digest)?;
        if bytes.len() as i64 != source.byte_length {
            return Err(ApplicationError::Corrupt);
        };
    }
    let candidate = budget.blob(conn, &candidate)?;
    crate::validate_replay_parity(&doc, &candidate)?;
    doc.apply(&candidate)?;
    let state = budget.blob(conn, state_digest)?;
    let saved = Ydoc::wire();
    saved.apply(&state)?;
    if !crate::replay_parity::structurally_equal_v2(&doc, &saved)?
        || doc.canonical_content_sha256() != proposal.final_content_digest
    {
        return Err(ApplicationError::Corrupt);
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The relay computes these digests from the same shared rows. Native
    /// history must reproduce each document's initial digest, the event's
    /// canonical metadata bytes, and its accepted-event digest, with and
    /// without a Unicode agent declaration.
    #[test]
    fn shared_accepted_history_digests_match_the_relay() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../packages/live-session-contract/vectors/live-update-admission-vectors.json"
        ))
        .unwrap();
        let rows = vectors["acceptedHistoryDigests"].as_array().unwrap();
        let mut declared = 0;
        for row in rows {
            let case = &row["case"];
            let metadata = parse_admitted_metadata(row["metadata"].clone()).unwrap();
            let binding = metadata.accepted.binding.clone();
            let document = &row["document"];
            assert_eq!(document["workspaceId"], binding.workspace_id, "{case}");
            assert_eq!(document["mainVersionId"], binding.main_version_id, "{case}");
            assert_eq!(document["objectId"], binding.object_id, "{case}");
            assert_eq!(
                document["lineageClaimId"], binding.lineage_claim_id,
                "{case}"
            );
            let held = Registration {
                workspace_id: binding.workspace_id.clone(),
                namespace: row["namespace"].as_str().unwrap().into(),
                coordinate: ApplicationHostCoordinate {
                    host_id: "host".into(),
                    host_epoch: 1,
                    instance_id: "instance".into(),
                    connection_id: "connection".into(),
                },
                binding,
                activation_id: None,
                live: true,
            };
            let initial = initial_digest(&held.namespace, &held.binding).unwrap();
            assert_eq!(initial, row["initialDigest"].as_str().unwrap(), "{case}");
            assert_eq!(
                serde_json::to_string(&metadata).unwrap(),
                row["canonicalJson"].as_str().unwrap(),
                "{case}"
            );
            let count = row["eventCount"].as_i64().unwrap();
            assert_eq!(
                next_digest(&initial, count, &metadata).unwrap(),
                row["eventDigest"].as_str().unwrap(),
                "{case}"
            );
            if metadata.admitted_declaration().is_some() {
                declared += 1;
            }
        }
        assert!(
            declared > 0 && declared < rows.len(),
            "absent and declared rows"
        );
    }

    pub(super) const ACCEPTED_COMPLETE: &str = r#"{"receipt":{"deliveryId":"delivery-1","updateDigest":"1111111111111111111111111111111111111111111111111111111111111111","journalCursor":7,"acceptingHostEpoch":1},"binding":{"workspaceId":"workspace-1","mainVersionId":"main","objectId":"object-1","lineageClaimId":"2222222222222222222222222222222222222222222222222222222222222222","currentPath":"notes/a.md","selectorPaths":["notes/a.md"],"restoreFenceGeneration":0},"authority":{"grantGeneration":null,"grantId":null,"principalId":"owner-1","principalKind":"owner"},"receivedAtMs":10}"#;

    #[test]
    fn undeclared_v1_evidence_keeps_original_bytes() {
        let previous = "0".repeat(64);
        let json = format!(r#"{{"accepted":{ACCEPTED_COMPLETE},"firstSeen":[]}}"#);
        let metadata: AdmittedLiveUpdateMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(serde_json::to_string(&metadata).unwrap(), json);
        assert_eq!(
            next_digest(&previous, 1, &metadata).unwrap(),
            hex_sha256(format!(r#"["accepted-event-v1","{previous}",1,{json}]"#).as_bytes())
        );
    }
}
