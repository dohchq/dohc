//! Stop retires one exact activation. Reconciliation proves what the relay
//! accepted from it and what this host applied, before release. Both share
//! one validation of the activation and one representation of an adoption
//! seed it never delivered.
use super::owner_activations::{
    activation_by_id, current_activation, lineage_origin_id, ActivationAdoption, OwnerActivation,
};
use super::*;
use crate::owner_outbox::{
    OwnerDeliveryReceipt, OwnerOutboxError, OwnerOutboxNativeOrigin, OwnerOutboxNativeSource,
    ACTIVATION_RELEASED,
};
use std::collections::{BTreeSet, HashMap};

/// The activation Stop retires, as the relay fenced it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetirementKey {
    pub object_id: String,
    pub lineage_claim_id: String,
    pub activation_id: String,
    pub restore_fence_generation: i64,
    /// F: the live-journal cursor Stop fenced.
    pub accepted_through: i64,
}

/// What the engine's authenticated configuration fixes for a retirement.
/// No caller supplies these.
#[derive(Debug, Clone, Copy)]
pub struct RetirementScope<'a> {
    pub namespace: &'a str,
    pub workspace_id: &'a str,
    pub max_deliveries: usize,
    pub max_applications: usize,
}

/// The relay journal's answer for the deliveries reconciliation named,
/// scoped to the namespace, the lineage and cursors through F.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalEvidence {
    pub receipts: Vec<LiveUpdateReceipt>,
    pub absent: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reconciliation {
    /// The journal must answer for these deliveries first.
    PendingDelivery(Vec<String>),
    /// As [`PendingDelivery`](Self::PendingDelivery), and the activation's
    /// own seed is among them in a quarantined outbox: delivery never
    /// retries it, so only this retirement or recovery ends the hold.
    SeedQuarantined(Vec<String>),
    Reconciled {
        adoption: Option<OwnerAdoptionAck>,
        applications: Vec<LiveUpdateHostApplicationAck>,
        has_more_applications: bool,
        /// Whether the activation applied past its last settlement.
        settle: bool,
    },
}

/// What a retirement may tear down, once its key validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetirementTarget {
    pub doc: DocKey,
    /// A released activation's retirement replays; it tears nothing down.
    pub released: bool,
}

/// Validate a retirement's key and durably record its intent, before the
/// caller ends any of the activation's runtime. The intent outlasts a
/// restart, so no restore moves the generation the key names until the
/// release clears it. A release also needs its document to have left the
/// replica's scope. A released activation's replay records nothing.
pub fn begin_retirement(
    store: &mut EngineStore,
    scope: &RetirementScope<'_>,
    key: &RetirementKey,
    release: bool,
    faults: &dyn FaultInjector,
) -> Result<RetirementTarget, ApplicationError> {
    let outcome = store.write_with(faults, |tx| {
        let retiring = validate_retirement(tx, scope, key)?;
        let released = retiring.released_through.is_some();
        if !released {
            if release {
                departed_parked(tx, &retiring.doc)?;
            }
            record_intent(tx, scope.namespace, &retiring, key)?;
        }
        Ok::<_, ApplicationError>(RetirementTarget {
            doc: retiring.doc,
            released,
        })
    })?;
    match outcome {
        TxnOutcome::Committed(target) => Ok(target),
        TxnOutcome::Crashed { .. } => Err(ApplicationError::Interrupted),
    }
}

/// Record that the retirement of this exact activation and generation began.
/// Each later Phase A for the same key finds it; another generation conflicts.
fn record_intent(
    tx: &Transaction<'_>,
    namespace: &str,
    retiring: &Retiring,
    key: &RetirementKey,
) -> Result<(), ApplicationError> {
    let doc = &retiring.doc;
    let row = params![
        namespace,
        key.activation_id,
        doc.workspace_id,
        doc.version_id,
        doc.object_id,
        retiring.lineage_claim_id,
        key.restore_fence_generation
    ];
    tx.execute(
        "INSERT OR IGNORE INTO live_owner_retirements (relay_database_namespace,activation_id,workspace_id,
            main_version_id,object_id,lineage_claim_id,restore_fence_generation) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        row,
    )
    .map_err(write_sql)?;
    let recorded: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM live_owner_retirements WHERE relay_database_namespace=?1
               AND activation_id=?2 AND workspace_id=?3 AND main_version_id=?4 AND object_id=?5
               AND lineage_claim_id=?6 AND restore_fence_generation=?7)",
            row,
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    if !recorded {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

/// Whether an activation of the document is retiring: its retirement began,
/// in any namespace, and it is not released yet.
pub(super) fn retiring(conn: &Connection, doc: &DocKey) -> Result<bool, ApplicationError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_owner_retirements
           WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)",
        params![doc.workspace_id, doc.version_id, doc.object_id],
        |row| row.get(0),
    )
    .map_err(read_sql)
}

/// Refuse an activation whose retirement began, until its release: no
/// registration, capture, resume or adoption serves it again, even after a
/// restart empties the in-memory retired set.
pub(super) fn require_not_retiring(
    conn: &Connection,
    namespace: &str,
    activation_id: &str,
) -> Result<(), ApplicationError> {
    let retiring: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM live_owner_retirements
               WHERE relay_database_namespace=?1 AND activation_id=?2)",
            params![namespace, activation_id],
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    if retiring {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

/// A release ends the retirement it began.
fn clear_intent(
    tx: &Transaction<'_>,
    namespace: &str,
    activation_id: &str,
) -> Result<(), ApplicationError> {
    tx.execute(
        "DELETE FROM live_owner_retirements WHERE relay_database_namespace=?1 AND activation_id=?2",
        params![namespace, activation_id],
    )
    .map_err(write_sql)?;
    Ok(())
}

/// Whether the document, which must have left the replica's scope, parked.
fn departed_parked(conn: &Connection, doc: &DocKey) -> Result<bool, ApplicationError> {
    let hosted: Option<(bool, bool)> = conn
        .query_row(
            "SELECT d.scope_generation<>h.scope_generation,d.state='parked' FROM hosted_documents d
             JOIN hosted_replicas h ON h.workspace_id=d.workspace_id WHERE d.workspace_id=?1 AND d.object_id=?2",
            params![doc.workspace_id, doc.object_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(read_sql)?;
    match hosted {
        Some((true, parked)) => Ok(parked),
        _ => Err(ApplicationError::Conflict),
    }
}

/// The exact activation, or retained native source, a retirement names.
pub(crate) struct Retiring {
    pub doc: DocKey,
    pub lineage_claim_id: String,
    pub activation_id: String,
    /// Its row; none for a never-adopted source no row records yet.
    pub activation: Option<OwnerActivation>,
    /// The cursor its release fenced, once released.
    pub released_through: Option<i64>,
}

/// Validate the activation a retirement names, before anything reads its
/// entries. A released one answers from its release; any other must still
/// hold its lineage, generation and binding.
pub(crate) fn validate_retirement(
    conn: &Connection,
    scope: &RetirementScope<'_>,
    key: &RetirementKey,
) -> Result<Retiring, ApplicationError> {
    identifier(&key.object_id, 1024)?;
    identifier(&key.activation_id, 1024)?;
    digest(&key.lineage_claim_id)?;
    integer(key.restore_fence_generation, 0, SAFE)?;
    integer(key.accepted_through, 0, SAFE)?;
    let main: String = conn
        .query_row(
            "SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1",
            [scope.workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(read_sql)?
        .ok_or(ApplicationError::WorkspaceMismatch)?;
    let doc = DocKey::new(scope.workspace_id, main, &key.object_id)?;
    let lineage = key.lineage_claim_id.as_str();
    let activation = activation_by_id(conn, scope.namespace, &key.activation_id)?;
    // The path a never-adopted source was captured at.
    let captured_path = match &activation {
        Some(found) => {
            if found.key != doc || found.lineage_claim_id != lineage {
                return Err(ApplicationError::Conflict);
            }
            None
        }
        None => {
            let descriptor: String = conn
                .query_row(
                    "SELECT descriptor_json FROM ydoc_owner_activation_sources WHERE activation_id=?1
                       AND relay_database_namespace=?2 AND workspace_id=?3 AND version_id=?4
                       AND object_id=?5 AND lineage_claim_id=?6",
                    params![
                        key.activation_id,
                        scope.namespace,
                        doc.workspace_id,
                        doc.version_id,
                        doc.object_id,
                        lineage
                    ],
                    |row| row.get(0),
                )
                .optional()
                .map_err(read_sql)?
                .ok_or(ApplicationError::Conflict)?;
            let source: ImportedOwnerSource =
                serde_json::from_str(&descriptor).map_err(|_| ApplicationError::Corrupt)?;
            Some(source.current_path)
        }
    };
    let retiring = |released_through| Retiring {
        doc: doc.clone(),
        lineage_claim_id: lineage.to_owned(),
        activation_id: key.activation_id.clone(),
        activation: activation.clone(),
        released_through,
    };
    if activation.as_ref().is_some_and(|found| found.released) {
        let (generation, through): (i64, i64) = conn
            .query_row(
                "SELECT released_restore_generation,released_accepted_cursor FROM live_owner_activations
                 WHERE relay_database_namespace=?1 AND activation_id=?2",
                params![scope.namespace, key.activation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(read_sql)?;
        if generation != key.restore_fence_generation || through != key.accepted_through {
            return Err(ApplicationError::Conflict);
        }
        return Ok(retiring(Some(through)));
    }
    let fence = restore_fence::current_generation(conn, &doc).map_err(|error| match error {
        CollabError::RestoreFenced => ApplicationError::Conflict,
        error => error.into(),
    })?;
    let bound = read_bound_binding(conn, scope.namespace, &doc)?;
    let saved = activation
        .as_ref()
        .map(|found| serde_json::from_str::<LiveObjectBinding>(&found.binding_json))
        .transpose()
        .map_err(|_| ApplicationError::Corrupt)?;
    let generation = fence
        .or(bound
            .as_ref()
            .map(|(binding, _)| binding.restore_fence_generation))
        .or(saved
            .as_ref()
            .map(|binding| binding.restore_fence_generation));
    if generation.is_some_and(|generation| generation != key.restore_fence_generation) {
        return Err(ApplicationError::Conflict);
    }
    match (&saved, &bound) {
        // An adopted activation holds its exact binding, as a restore resumed it.
        (Some(saved), Some((binding, named))) => {
            let expected = restore_fence::resumed_binding(conn, &doc)?.unwrap_or(saved.clone());
            if *binding != expected || named.as_deref() != Some(key.activation_id.as_str()) {
                return Err(ApplicationError::Conflict);
            }
        }
        (Some(_), None) => return Err(ApplicationError::Conflict),
        // A never-adopted source has no binding, or one at its own lineage
        // and captured path that names it, or names nothing while its
        // lineage was never adopted.
        (None, Some((binding, named))) => {
            if binding.lineage_claim_id != lineage
                || Some(&binding.current_path) != captured_path.as_ref()
            {
                return Err(ApplicationError::Conflict);
            }
            match named {
                Some(named) if *named != key.activation_id => {
                    return Err(ApplicationError::Conflict)
                }
                None if lineage_origin_id(conn, Some(scope.namespace), &doc, lineage)?
                    .is_some() =>
                {
                    return Err(ApplicationError::Conflict)
                }
                _ => {}
            }
        }
        (None, None) => {}
    }
    let overtaken = current_activation(conn, None, &doc, lineage)?.is_some_and(|(current, _)| {
        current.namespace != scope.namespace || current.activation_id != key.activation_id
    });
    let succeeded: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM live_owner_activations WHERE relay_database_namespace=?1
               AND predecessor_activation_id=?2)",
            params![scope.namespace, key.activation_id],
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    if overtaken || succeeded {
        return Err(ApplicationError::Conflict);
    }
    Ok(retiring(None))
}

/// The document's binding in `namespace` and the activation it names.
fn read_bound_binding(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
) -> Result<Option<(LiveObjectBinding, Option<String>)>, ApplicationError> {
    let row: Option<(String, String, String, i64, Option<String>)> = conn
        .query_row(
            "SELECT lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,activation_id
             FROM live_device_application_bindings WHERE relay_database_namespace=?1 AND workspace_id=?2
               AND main_version_id=?3 AND object_id=?4",
            params![namespace, doc.workspace_id, doc.version_id, doc.object_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(read_sql)?;
    row.map(|(lineage, path, selectors, generation, named)| {
        Ok((
            LiveObjectBinding {
                workspace_id: doc.workspace_id.clone(),
                main_version_id: doc.version_id.clone(),
                object_id: doc.object_id.clone(),
                lineage_claim_id: lineage,
                current_path: path,
                selector_paths: serde_json::from_str(&selectors)
                    .map_err(|_| ApplicationError::Corrupt)?,
                restore_fence_generation: generation,
            },
            named,
        ))
    })
    .transpose()
}

/// One retained native outbox entry of the retiring activation.
pub(crate) struct RetainedEntry {
    pub outbox_id: String,
    pub sequence: i64,
    pub delivery_id: String,
    pub update_digest: String,
    pub source: OwnerOutboxNativeSource,
    pub receipt: Option<String>,
    pub pending: bool,
    pub terminal_reason: Option<String>,
    pub update_blob: Option<String>,
    pub terminal_blob: Option<String>,
    /// Its outbox is quarantined, so delivery never retries it.
    pub quarantined: bool,
}

/// A native source names one binding and its origin. A larger one is corrupt.
const MAX_NATIVE_SOURCE_BYTES: i64 = 262_144;

/// The activation's retained native entries. With `unproven_through`, only
/// those that still need proof: pending ones, ones without a receipt that no
/// host refused, and ones whose receipt passes F.
fn retained_entries(
    conn: &Connection,
    retiring: &Retiring,
    unproven_through: Option<i64>,
) -> Result<Vec<RetainedEntry>, ApplicationError> {
    let doc = &retiring.doc;
    let mut query = conn
        .prepare(
            "SELECT e.outbox_id,e.sequence,e.append_key,e.delivery_id,e.update_digest,e.native_source_json,
                e.accepted_receipt_json,e.pending,e.terminal_reason,e.update_blob_digest,e.terminal_blob_digest,
                length(CAST(e.native_source_json AS BLOB)),o.state='quarantined'
             FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id
             WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3 AND o.lineage_claim_id=?4
               AND e.native_source_json IS NOT NULL AND json_extract(e.native_source_json,'$.adoptionId')=?5
               AND (?6 IS NULL OR e.pending=1 OR json_extract(e.accepted_receipt_json,'$.journalCursor')>?6
                 OR (e.accepted_receipt_json IS NULL AND (e.terminal_reason IS NULL OR e.terminal_reason=?7)))
             ORDER BY e.outbox_id,e.sequence",
        )
        .map_err(read_sql)?;
    let mut rows = query
        .query(params![
            doc.workspace_id,
            doc.version_id,
            doc.object_id,
            retiring.lineage_claim_id,
            retiring.activation_id,
            unproven_through,
            ACTIVATION_RELEASED
        ])
        .map_err(read_sql)?;
    let mut entries = Vec::new();
    while let Some(row) = rows.next().map_err(read_sql)? {
        let length: i64 = row.get(11).map_err(read_sql)?;
        if !(1..=MAX_NATIVE_SOURCE_BYTES).contains(&length) {
            return Err(ApplicationError::Corrupt);
        }
        let append_key: String = row.get(2).map_err(read_sql)?;
        let json: String = row.get(5).map_err(read_sql)?;
        let source: OwnerOutboxNativeSource =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        source
            .validate(&append_key)
            .map_err(|_| ApplicationError::Corrupt)?;
        let entry = RetainedEntry {
            outbox_id: row.get(0).map_err(read_sql)?,
            sequence: row.get(1).map_err(read_sql)?,
            delivery_id: row.get(3).map_err(read_sql)?,
            update_digest: row.get(4).map_err(read_sql)?,
            source,
            receipt: row.get(6).map_err(read_sql)?,
            pending: row.get(7).map_err(read_sql)?,
            terminal_reason: row.get(8).map_err(read_sql)?,
            update_blob: row.get(9).map_err(read_sql)?,
            terminal_blob: row.get(10).map_err(read_sql)?,
            quarantined: row.get(12).map_err(read_sql)?,
        };
        let b = &entry.source.binding;
        if b.workspace_id != doc.workspace_id
            || b.main_version_id != doc.version_id
            || b.object_id != doc.object_id
            || b.lineage_claim_id != retiring.lineage_claim_id
            || entry.source.update_digest != entry.update_digest
        {
            return Err(ApplicationError::Corrupt);
        }
        entries.push(entry);
    }
    Ok(entries)
}

/// Whether `entry` is the retiring activation's adoption seed, never
/// delivered: its source matches the retained activation source, nothing
/// accepted or applied its delivery, and nothing applied after the
/// activation's cut, through its release fence once released.
fn undelivered_seed(
    conn: &Connection,
    namespace: &str,
    retiring: &Retiring,
    entry: &RetainedEntry,
) -> Result<bool, ApplicationError> {
    let Some(adopted) = retiring
        .activation
        .as_ref()
        .and_then(|activation| activation.adoption.as_ref())
    else {
        return Ok(false);
    };
    if !matches!(entry.source.origin, OwnerOutboxNativeOrigin::AdoptionSeed)
        || entry.source.adoption_id != retiring.activation_id
        || entry.source.native_sequence != adopted.local_ydoc_sequence
        || entry.receipt.is_some()
    {
        return Ok(false);
    }
    let doc = &retiring.doc;
    let captured: Option<(String, String)> = conn
        .query_row(
            "SELECT full_state_digest,descriptor_json FROM ydoc_owner_activation_sources
             WHERE activation_id=?1 AND relay_database_namespace=?2 AND workspace_id=?3
               AND version_id=?4 AND object_id=?5 AND lineage_claim_id=?6",
            params![
                retiring.activation_id,
                namespace,
                doc.workspace_id,
                doc.version_id,
                doc.object_id,
                retiring.lineage_claim_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(read_sql)?;
    let Some((captured_digest, descriptor)) = captured else {
        return Ok(false);
    };
    let captured: ImportedOwnerSource =
        serde_json::from_str(&descriptor).map_err(|_| ApplicationError::Corrupt)?;
    if captured_digest != entry.update_digest
        || captured.native_head_sequence != entry.source.native_sequence
    {
        return Ok(false);
    }
    let delivered: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM live_accepted_updates WHERE relay_database_namespace=?1 AND delivery_id=?2)
              OR EXISTS(SELECT 1 FROM live_device_update_applications WHERE relay_database_namespace=?1 AND delivery_id=?2)
              OR EXISTS(SELECT 1 FROM live_device_update_applications WHERE relay_database_namespace=?1
                AND workspace_id=?3 AND main_version_id=?4 AND object_id=?5 AND lineage_claim_id=?6
                AND journal_cursor>?7 AND (?8 IS NULL OR journal_cursor<=?8))",
            params![
                namespace,
                entry.delivery_id,
                doc.workspace_id,
                doc.version_id,
                doc.object_id,
                retiring.lineage_claim_id,
                adopted.terminal_cursor,
                retiring.released_through
            ],
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    Ok(!delivered)
}

/// The one representation of a seed its activation never delivered, while
/// current and after release. The terminal reason alone proves nothing.
pub(crate) fn is_abandoned_seed(
    conn: &Connection,
    namespace: &str,
    retiring: &Retiring,
    entry: &RetainedEntry,
) -> Result<bool, ApplicationError> {
    Ok(!entry.pending
        && entry.update_blob.is_none()
        && entry.terminal_blob.is_none()
        && entry.terminal_reason.as_deref() == Some(ACTIVATION_RELEASED)
        && undelivered_seed(conn, namespace, retiring, entry)?)
}

fn outbox_error(error: OwnerOutboxError) -> ApplicationError {
    match error {
        OwnerOutboxError::Storage(error) => error.into(),
        OwnerOutboxError::Corrupt => ApplicationError::Corrupt,
        OwnerOutboxError::InvalidInput(message) => ApplicationError::InvalidInput(message),
        _ => ApplicationError::Conflict,
    }
}

fn delivery_receipt(receipt: &LiveUpdateReceipt) -> OwnerDeliveryReceipt {
    OwnerDeliveryReceipt {
        delivery_id: receipt.delivery_id.clone(),
        update_digest: receipt.update_digest.clone(),
        journal_cursor: receipt.journal_cursor,
        accepting_host_epoch: receipt.accepting_host_epoch,
    }
}

enum Answer<'a> {
    Accepted(&'a LiveUpdateReceipt),
    Absent,
}

/// Reconcile the activation's deliveries with what the relay accepted, in
/// one transaction. A pending result keeps the receipt work it proved; an
/// integrity failure writes nothing. A released activation answers from its
/// stored release and writes nothing.
pub fn reconcile_activation(
    store: &mut EngineStore,
    scope: &RetirementScope<'_>,
    key: &RetirementKey,
    after: Option<&LiveUpdateReceipt>,
    journal: Option<&JournalEvidence>,
    faults: &dyn FaultInjector,
) -> Result<Reconciliation, ApplicationError> {
    let replayed = store.read_with(|conn| {
        let retiring = validate_retirement(conn, scope, key)?;
        match retiring.released_through {
            Some(_) => released_reconciliation(conn, scope, &retiring, after).map(Some),
            None => Ok(None),
        }
    })?;
    if let Some(replayed) = replayed {
        return Ok(replayed);
    }
    match store.write_with(faults, |tx| reconcile_in_tx(tx, scope, key, after, journal))? {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(ApplicationError::Interrupted),
    }
}

/// A released activation's reconciliation, from the boundary its release
/// stored: its adoption, then its applications through that boundary, which
/// it settled before release. A successor's history cannot move it.
fn released_reconciliation(
    conn: &Connection,
    scope: &RetirementScope<'_>,
    retiring: &Retiring,
    after: Option<&LiveUpdateReceipt>,
) -> Result<Reconciliation, ApplicationError> {
    let Some(adopted) = retiring
        .activation
        .as_ref()
        .and_then(|activation| activation.adoption.as_ref())
    else {
        return applications(conn, scope, retiring, after, 0, None);
    };
    let boundary = stored_boundary(conn, scope.namespace, &retiring.activation_id)?
        .ok_or(ApplicationError::Corrupt)?;
    let through = boundary
        .terminal_receipt
        .as_ref()
        .map_or(adopted.terminal_cursor, |receipt| receipt.journal_cursor);
    applications(conn, scope, retiring, after, through, None)
}

fn reconcile_in_tx(
    tx: &Transaction<'_>,
    scope: &RetirementScope<'_>,
    key: &RetirementKey,
    after: Option<&LiveUpdateReceipt>,
    journal: Option<&JournalEvidence>,
) -> Result<Reconciliation, ApplicationError> {
    let retiring = validate_retirement(tx, scope, key)?;
    if retiring.released_through.is_some() {
        return released_reconciliation(tx, scope, &retiring, after);
    }
    let through = key.accepted_through;
    let mut answers = HashMap::new();
    if let Some(journal) = journal {
        if journal.receipts.len() + journal.absent.len() > scope.max_deliveries {
            return Err(invalid("journal evidence exceeds the delivery budget"));
        }
        for receipt in &journal.receipts {
            receipt.validate()?;
            if receipt.journal_cursor > through
                || answers
                    .insert(receipt.delivery_id.as_str(), Answer::Accepted(receipt))
                    .is_some()
            {
                return Err(ApplicationError::Conflict);
            }
        }
        for delivery in &journal.absent {
            identifier(delivery, 512)?;
            if answers.insert(delivery.as_str(), Answer::Absent).is_some() {
                return Err(ApplicationError::Conflict);
            }
        }
    }
    let mut unresolved = Vec::new();
    let mut accepted: Vec<(String, Vec<OwnerDeliveryReceipt>)> = Vec::new();
    let mut abandoned = Vec::new();
    // Outboxes whose next pending entry stays unproven or was never
    // delivered: nothing after it can be acknowledged.
    let mut stalled = BTreeSet::new();
    let mut seed_quarantined = false;
    for entry in retained_entries(tx, &retiring, Some(through))? {
        if let Some(saved) = &entry.receipt {
            let saved: OwnerDeliveryReceipt =
                serde_json::from_str(saved).map_err(|_| ApplicationError::Corrupt)?;
            if entry.pending || saved.journal_cursor > through {
                return Err(ApplicationError::Conflict);
            }
            continue;
        }
        let answer = answers.get(entry.delivery_id.as_str());
        if entry.pending {
            match answer {
                Some(Answer::Accepted(receipt)) => {
                    if receipt.update_digest != entry.update_digest {
                        return Err(ApplicationError::Conflict);
                    }
                    if stalled.contains(&entry.outbox_id) {
                        if abandoned
                            .iter()
                            .any(|(outbox, _)| *outbox == entry.outbox_id)
                        {
                            return Err(ApplicationError::Conflict);
                        }
                        unresolved.push(entry.delivery_id);
                        continue;
                    }
                    match accepted.last_mut() {
                        Some((outbox, receipts)) if *outbox == entry.outbox_id => {
                            receipts.push(delivery_receipt(receipt))
                        }
                        _ => accepted.push((entry.outbox_id, vec![delivery_receipt(receipt)])),
                    }
                }
                Some(Answer::Absent) => {
                    // Only a seed its activation never delivered may go undelivered.
                    if entry.update_blob.is_none()
                        || entry.terminal_reason.is_some()
                        || !undelivered_seed(tx, scope.namespace, &retiring, &entry)?
                    {
                        return Err(ApplicationError::Conflict);
                    }
                    stalled.insert(entry.outbox_id.clone());
                    abandoned.push((entry.outbox_id, entry.sequence));
                }
                None => {
                    seed_quarantined |= entry.quarantined
                        && matches!(entry.source.origin, OwnerOutboxNativeOrigin::AdoptionSeed);
                    stalled.insert(entry.outbox_id);
                    unresolved.push(entry.delivery_id);
                }
            }
        } else if entry.terminal_reason.is_some() {
            if !is_abandoned_seed(tx, scope.namespace, &retiring, &entry)? {
                return Err(ApplicationError::Conflict);
            }
        } else {
            // Acknowledged before acknowledgements kept their receipts.
            let proof = match accepted_history_receipt(tx, scope.namespace, &retiring, &entry)? {
                Some(receipt) => Some(receipt),
                None => match answer {
                    Some(Answer::Accepted(receipt)) => Some((*receipt).clone()),
                    Some(Answer::Absent) => return Err(ApplicationError::Conflict),
                    None => None,
                },
            };
            match proof {
                Some(receipt) if receipt.journal_cursor > through => {
                    return Err(ApplicationError::Conflict)
                }
                Some(receipt) => {
                    crate::owner_outbox::record_missing_receipt_in_tx(
                        tx,
                        &entry.outbox_id,
                        &delivery_receipt(&receipt),
                    )
                    .map_err(outbox_error)?;
                }
                None => unresolved.push(entry.delivery_id),
            }
        }
    }
    for (outbox, sequence) in &abandoned {
        crate::owner_outbox::abandon_seed_in_tx(tx, outbox, *sequence).map_err(outbox_error)?;
    }
    for (outbox, receipts) in &accepted {
        crate::owner_outbox::acknowledge_in_tx(tx, outbox, receipts).map_err(outbox_error)?;
    }
    if !unresolved.is_empty() {
        unresolved.truncate(scope.max_deliveries.max(1));
        return Ok(if seed_quarantined {
            Reconciliation::SeedQuarantined(unresolved)
        } else {
            Reconciliation::PendingDelivery(unresolved)
        });
    }
    applications(tx, scope, &retiring, after, through, Some(through))
}

/// The receipt the activation's accepted history kept for `entry`, if any.
fn accepted_history_receipt(
    conn: &Connection,
    namespace: &str,
    retiring: &Retiring,
    entry: &RetainedEntry,
) -> Result<Option<LiveUpdateReceipt>, ApplicationError> {
    let doc = &retiring.doc;
    let row: Option<(String, String, String, String, String, String)> = conn
        .query_row(
            "SELECT workspace_id,main_version_id,object_id,lineage_claim_id,update_sha256,
                json_extract(metadata_json,'$.accepted.receipt')
             FROM live_accepted_updates WHERE relay_database_namespace=?1 AND delivery_id=?2",
            params![namespace, entry.delivery_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(read_sql)?;
    let Some((workspace, version, object, lineage, update, receipt)) = row else {
        return Ok(None);
    };
    let receipt: LiveUpdateReceipt =
        serde_json::from_str(&receipt).map_err(|_| ApplicationError::Corrupt)?;
    receipt.validate().map_err(|_| ApplicationError::Corrupt)?;
    if workspace != doc.workspace_id
        || version != doc.version_id
        || object != doc.object_id
        || lineage != retiring.lineage_claim_id
        || update != entry.update_digest
        || receipt.delivery_id != entry.delivery_id
        || receipt.update_digest != entry.update_digest
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(Some(receipt))
}

/// The stored adoption ACK, then a bounded contiguous page of application
/// ACKs after `after`, through `through`. `settle_through` asks whether the
/// activation applied past its last settlement through that cursor; a
/// released one settled before release.
fn applications(
    conn: &Connection,
    scope: &RetirementScope<'_>,
    retiring: &Retiring,
    after: Option<&LiveUpdateReceipt>,
    through: i64,
    settle_through: Option<i64>,
) -> Result<Reconciliation, ApplicationError> {
    let Some(adopted) = retiring
        .activation
        .as_ref()
        .and_then(|activation| activation.adoption.as_ref())
    else {
        return Ok(Reconciliation::Reconciled {
            adoption: None,
            applications: Vec::new(),
            has_more_applications: false,
            settle: false,
        });
    };
    let doc = &retiring.doc;
    let lineage = retiring.lineage_claim_id.as_str();
    let terminal: Option<LiveUpdateReceipt> = serde_json::from_str(&adopted.terminal_receipt_json)
        .map_err(|_| ApplicationError::Corrupt)?;
    let start = match after {
        None => adopted.terminal_cursor,
        Some(after) if terminal.as_ref() == Some(after) => adopted.terminal_cursor,
        Some(after) => {
            after.validate()?;
            let applied: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM live_device_update_applications WHERE relay_database_namespace=?1
                       AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5
                       AND delivery_id=?6 AND update_digest=?7 AND journal_cursor=?8 AND accepting_host_epoch=?9)",
                    params![
                        scope.namespace,
                        doc.workspace_id,
                        doc.version_id,
                        doc.object_id,
                        lineage,
                        after.delivery_id,
                        after.update_digest,
                        after.journal_cursor,
                        after.accepting_host_epoch
                    ],
                    |row| row.get(0),
                )
                .map_err(read_sql)?;
            if !applied
                || after.journal_cursor <= adopted.terminal_cursor
                || after.journal_cursor > through
            {
                return Err(ApplicationError::Conflict);
            }
            after.journal_cursor
        }
    };
    let limit =
        i64::try_from(scope.max_applications.max(1)).map_err(|_| invalid("application budget"))?;
    let mut query = conn
        .prepare(
            "SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch,local_ydoc_sequence
             FROM live_device_update_applications WHERE relay_database_namespace=?1 AND workspace_id=?2
               AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5
               AND journal_cursor>?6 AND journal_cursor<=?7
             ORDER BY journal_cursor LIMIT ?8",
        )
        .map_err(read_sql)?;
    let mut applications = query
        .query_map(
            params![
                scope.namespace,
                doc.workspace_id,
                doc.version_id,
                doc.object_id,
                lineage,
                start,
                through,
                limit + 1
            ],
            |row| {
                let receipt = LiveUpdateReceipt {
                    delivery_id: row.get(0)?,
                    update_digest: row.get(1)?,
                    journal_cursor: row.get(2)?,
                    accepting_host_epoch: row.get(3)?,
                };
                Ok(LiveUpdateHostApplicationAck::new(
                    &receipt,
                    row.get(4)?,
                    true,
                ))
            },
        )
        .map_err(read_sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(read_sql)?;
    let has_more_applications = applications.len() as i64 > limit;
    applications.truncate(limit as usize);
    Ok(Reconciliation::Reconciled {
        adoption: Some(OwnerAdoptionAck {
            adoption_id: retiring.activation_id.clone(),
            local_ydoc_sequence: adopted.local_ydoc_sequence,
            terminal_cursor: adopted.terminal_cursor,
            adoption_replayed: true,
        }),
        applications,
        has_more_applications,
        settle: match settle_through {
            Some(through) => {
                settlement_pending(conn, scope.namespace, doc, lineage, Some(through))?
            }
            None => false,
        },
    })
}

/// The accepted prefix a release kept: the activation's applied endpoint in
/// its lineage's accepted history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainedPrefix {
    pub terminal_receipt: Option<LiveUpdateReceipt>,
    pub event_count: i64,
    pub history_evidence_digest: String,
}

/// A delivery the relay accepted from the activation after its boundary,
/// through F, that it never applied. Its successor carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CarriedDelivery {
    pub receipt: LiveUpdateReceipt,
    pub native_sequence: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Release {
    Released {
        replayed: bool,
        boundary: Option<RetainedPrefix>,
    },
    Pending(ReleasePending),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleasePending {
    /// The adopted document left the scope but has not parked.
    Parking,
    /// Delivery or settlement completed since reconciliation; reconcile again.
    Reconciliation,
}

/// Release the activation a retirement names, in one transaction that proves
/// its delivery, application and settlement again. A released activation
/// answers from its stored release and writes nothing.
pub fn release_activation(
    store: &mut EngineStore,
    scope: &RetirementScope<'_>,
    key: &RetirementKey,
    host: &ApplicationHostCoordinate,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<Release, ApplicationError> {
    integer(now_ms, 0, SAFE)?;
    let replayed = store.read_with(|conn| {
        let retiring = validate_retirement(conn, scope, key)?;
        match retiring.released_through {
            Some(_) => released(conn, scope.namespace, &retiring).map(Some),
            None => Ok(None),
        }
    })?;
    if let Some(replayed) = replayed {
        return Ok(replayed);
    }
    match store.write_with(faults, |tx| release_in_tx(tx, scope, key, host, now_ms))? {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(ApplicationError::Interrupted),
    }
}

fn released(
    conn: &Connection,
    namespace: &str,
    retiring: &Retiring,
) -> Result<Release, ApplicationError> {
    Ok(Release::Released {
        replayed: true,
        boundary: stored_boundary(conn, namespace, &retiring.activation_id)?,
    })
}

fn stored_boundary(
    conn: &Connection,
    namespace: &str,
    activation_id: &str,
) -> Result<Option<RetainedPrefix>, ApplicationError> {
    let json: String = conn
        .query_row(
            "SELECT released_boundary_json FROM live_owner_activations
             WHERE relay_database_namespace=?1 AND activation_id=?2 AND released_at_ms IS NOT NULL",
            params![namespace, activation_id],
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)
}

fn release_in_tx(
    tx: &Transaction<'_>,
    scope: &RetirementScope<'_>,
    key: &RetirementKey,
    host: &ApplicationHostCoordinate,
    now_ms: i64,
) -> Result<Release, ApplicationError> {
    let retiring = validate_retirement(tx, scope, key)?;
    if retiring.released_through.is_some() {
        return released(tx, scope.namespace, &retiring);
    }
    let parked = departed_parked(tx, &retiring.doc)?;
    let Some(adopted) = retiring
        .activation
        .as_ref()
        .and_then(|activation| activation.adoption.clone())
    else {
        // An unadopted source keeps its document from parking, so it
        // releases first.
        return release_unadopted(tx, scope, key, &retiring, host, now_ms);
    };
    if !parked {
        return Ok(Release::Pending(ReleasePending::Parking));
    }
    if !matches!(
        reconcile_in_tx(tx, scope, key, None, None)?,
        Reconciliation::Reconciled { settle: false, .. }
    ) {
        return Ok(Release::Pending(ReleasePending::Reconciliation));
    }
    let boundary = applied_boundary(
        tx,
        scope.namespace,
        &retiring,
        &adopted,
        key.accepted_through,
    )?;
    let carried = classify(
        tx,
        scope.namespace,
        &retiring,
        &boundary,
        key.accepted_through,
    )?;
    let changed = tx
        .execute(
            "UPDATE live_owner_activations SET released_at_ms=?3,released_restore_generation=?4,
                released_accepted_cursor=?5,released_boundary_json=?6,carried_manifest_json=?7
             WHERE relay_database_namespace=?1 AND activation_id=?2 AND released_at_ms IS NULL",
            params![
                scope.namespace,
                key.activation_id,
                now_ms,
                key.restore_fence_generation,
                key.accepted_through,
                serde_json::to_string(&boundary).map_err(|_| ApplicationError::Corrupt)?,
                serde_json::to_string(&carried).map_err(|_| ApplicationError::Corrupt)?
            ],
        )
        .map_err(write_sql)?;
    if changed != 1 || delete_own_binding(tx, scope.namespace, &retiring, key)? != 1 {
        return Err(ApplicationError::Corrupt);
    }
    clear_intent(tx, scope.namespace, &key.activation_id)?;
    Ok(Release::Released {
        replayed: false,
        boundary: Some(boundary),
    })
}

/// Delete only the binding the retirement names: its activation, lineage
/// and generation.
fn delete_own_binding(
    tx: &Transaction<'_>,
    namespace: &str,
    retiring: &Retiring,
    key: &RetirementKey,
) -> Result<usize, ApplicationError> {
    let doc = &retiring.doc;
    tx.execute(
        "DELETE FROM live_device_application_bindings WHERE relay_database_namespace=?1 AND workspace_id=?2
           AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND activation_id=?6
           AND restore_fence_generation=?7",
        params![
            namespace,
            doc.workspace_id,
            doc.version_id,
            doc.object_id,
            retiring.lineage_claim_id,
            key.activation_id,
            key.restore_fence_generation
        ],
    )
    .map_err(write_sql)
}

/// A never-adopted source's release: a released row with its retained source
/// identity, following its lineage's released tail and keeping that tail's
/// boundary and carried deliveries.
fn release_unadopted(
    tx: &Transaction<'_>,
    scope: &RetirementScope<'_>,
    key: &RetirementKey,
    retiring: &Retiring,
    host: &ApplicationHostCoordinate,
    now_ms: i64,
) -> Result<Release, ApplicationError> {
    let doc = &retiring.doc;
    let lineage = retiring.lineage_claim_id.as_str();
    let descriptor: String = tx
        .query_row(
            "SELECT descriptor_json FROM ydoc_owner_activation_sources WHERE activation_id=?1
               AND relay_database_namespace=?2 AND workspace_id=?3 AND version_id=?4 AND object_id=?5
               AND lineage_claim_id=?6",
            params![
                key.activation_id,
                scope.namespace,
                doc.workspace_id,
                doc.version_id,
                doc.object_id,
                lineage
            ],
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    let source: ImportedOwnerSource =
        serde_json::from_str(&descriptor).map_err(|_| ApplicationError::Corrupt)?;
    let binding = match read_bound_binding(tx, scope.namespace, doc)? {
        Some((binding, Some(named))) if named == key.activation_id => binding,
        _ => LiveObjectBinding {
            workspace_id: doc.workspace_id.clone(),
            main_version_id: doc.version_id.clone(),
            object_id: doc.object_id.clone(),
            lineage_claim_id: lineage.to_owned(),
            current_path: source.current_path.clone(),
            selector_paths: vec![source.current_path.clone()],
            restore_fence_generation: key.restore_fence_generation,
        },
    };
    let predecessor = owner_activations::released_chain_tail(tx, scope.namespace, doc, lineage)?;
    let (boundary, carried): (String, String) = match &predecessor {
        Some(id) => tx
            .query_row(
                "SELECT released_boundary_json,carried_manifest_json FROM live_owner_activations
                 WHERE relay_database_namespace=?1 AND activation_id=?2",
                params![scope.namespace, id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(read_sql)?,
        None => ("null".into(), "[]".into()),
    };
    let inherited: Option<RetainedPrefix> =
        serde_json::from_str(&boundary).map_err(|_| ApplicationError::Corrupt)?;
    serde_json::from_str::<Vec<CarriedDelivery>>(&carried)
        .map_err(|_| ApplicationError::Corrupt)?;
    tx.execute(
        "INSERT INTO live_owner_activations (relay_database_namespace,activation_id,workspace_id,main_version_id,
            object_id,lineage_claim_id,predecessor_activation_id,binding_json,source_moment_id,source_digest,
            source_byte_length,host_coordinate_json,released_at_ms,released_restore_generation,
            released_accepted_cursor,released_boundary_json,carried_manifest_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
        params![
            scope.namespace,
            key.activation_id,
            doc.workspace_id,
            doc.version_id,
            doc.object_id,
            lineage,
            predecessor,
            serde_json::to_string(&binding).map_err(|_| ApplicationError::Corrupt)?,
            source.source_moment_id,
            source.source_digest,
            source.source_byte_length,
            serde_json::to_string(host).map_err(|_| ApplicationError::Corrupt)?,
            now_ms,
            key.restore_fence_generation,
            key.accepted_through,
            boundary,
            carried
        ],
    )
    .map_err(write_sql)?;
    delete_own_binding(tx, scope.namespace, retiring, key)?;
    clear_intent(tx, scope.namespace, &key.activation_id)?;
    Ok(Release::Released {
        replayed: false,
        boundary: inherited,
    })
}

/// B: the activation's latest applied receipt through F, or its adopted
/// origin when nothing newer applied. The lineage's accepted history must
/// end exactly there.
fn applied_boundary(
    conn: &Connection,
    namespace: &str,
    retiring: &Retiring,
    adopted: &ActivationAdoption,
    through: i64,
) -> Result<RetainedPrefix, ApplicationError> {
    let doc = &retiring.doc;
    let document = params![
        namespace,
        doc.workspace_id,
        doc.version_id,
        doc.object_id,
        retiring.lineage_claim_id
    ];
    let latest: Option<LiveUpdateReceipt> = conn
        .query_row(
            "SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM live_device_update_applications
             WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4
               AND lineage_claim_id=?5 ORDER BY journal_cursor DESC LIMIT 1",
            document,
            |row| {
                Ok(LiveUpdateReceipt {
                    delivery_id: row.get(0)?,
                    update_digest: row.get(1)?,
                    journal_cursor: row.get(2)?,
                    accepting_host_epoch: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(read_sql)?;
    let applied = match latest {
        Some(latest) if latest.journal_cursor > adopted.terminal_cursor => {
            if latest.journal_cursor > through {
                return Err(ApplicationError::Conflict);
            }
            Some(latest)
        }
        _ => serde_json::from_str(&adopted.terminal_receipt_json)
            .map_err(|_| ApplicationError::Corrupt)?,
    };
    let endpoint = |sql: &str| -> Result<Option<(i64, String, String)>, ApplicationError> {
        conn.query_row(sql, document, |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()
        .map_err(read_sql)
    };
    let event = endpoint(
        "SELECT event_count,json_extract(metadata_json,'$.accepted.receipt'),evidence_digest FROM live_accepted_updates
         WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4
           AND lineage_claim_id=?5 ORDER BY event_count DESC LIMIT 1",
    )?;
    let checkpoint = endpoint(
        "SELECT event_count,terminal_json,evidence_digest FROM live_accepted_checkpoints
         WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4
           AND lineage_claim_id=?5 ORDER BY event_count DESC LIMIT 1",
    )?;
    let (event_count, terminal, evidence) = match (event, checkpoint) {
        (Some(event), Some(checkpoint)) if checkpoint.0 > event.0 => checkpoint,
        (Some(endpoint), _) | (None, Some(endpoint)) => endpoint,
        (None, None) => return Err(ApplicationError::Corrupt),
    };
    let terminal: Option<LiveUpdateReceipt> =
        serde_json::from_str(&terminal).map_err(|_| ApplicationError::Corrupt)?;
    if terminal != applied {
        return Err(ApplicationError::Conflict);
    }
    Ok(RetainedPrefix {
        terminal_receipt: applied,
        event_count,
        history_evidence_digest: evidence,
    })
}

/// Classify each of the activation's retained native entries against B and
/// F. Covered: accepted history at or below B keeps its exact receipt.
/// Carried: a saved receipt in (B, F] for its own delivery, never applied.
/// Abandoned: the strict seed representation. An entry a host refused was
/// never accepted and needs none. Anything else refuses the release.
fn classify(
    conn: &Connection,
    namespace: &str,
    retiring: &Retiring,
    boundary: &RetainedPrefix,
    through: i64,
) -> Result<Vec<CarriedDelivery>, ApplicationError> {
    let applied_through = boundary
        .terminal_receipt
        .as_ref()
        .map_or(0, |receipt| receipt.journal_cursor);
    let mut carried = Vec::new();
    for entry in retained_entries(conn, retiring, None)? {
        let Some(saved) = &entry.receipt else {
            match entry.terminal_reason.as_deref() {
                Some(ACTIVATION_RELEASED)
                    if is_abandoned_seed(conn, namespace, retiring, &entry)? =>
                {
                    continue
                }
                Some(reason) if reason != ACTIVATION_RELEASED && !entry.pending => continue,
                _ => return Err(ApplicationError::Conflict),
            }
        };
        let saved: OwnerDeliveryReceipt =
            serde_json::from_str(saved).map_err(|_| ApplicationError::Corrupt)?;
        let receipt = LiveUpdateReceipt {
            delivery_id: saved.delivery_id,
            update_digest: saved.update_digest,
            journal_cursor: saved.journal_cursor,
            accepting_host_epoch: saved.accepting_host_epoch,
        };
        receipt.validate().map_err(|_| ApplicationError::Corrupt)?;
        if entry.pending
            || receipt.delivery_id != entry.delivery_id
            || receipt.update_digest != entry.update_digest
            || receipt.journal_cursor > through
        {
            return Err(ApplicationError::Conflict);
        }
        if receipt.journal_cursor <= applied_through {
            if accepted_history_receipt(conn, namespace, retiring, &entry)?.as_ref()
                != Some(&receipt)
            {
                return Err(ApplicationError::Conflict);
            }
            continue;
        }
        let applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM live_device_update_applications WHERE relay_database_namespace=?1
                   AND delivery_id=?2)",
                params![namespace, entry.delivery_id],
                |row| row.get(0),
            )
            .map_err(read_sql)?;
        if applied {
            return Err(ApplicationError::Conflict);
        }
        carried.push(CarriedDelivery {
            receipt,
            native_sequence: entry.source.native_sequence,
        });
    }
    Ok(carried)
}

/// The registration a retirement settles through: the activation's own
/// durable binding on this host, with no live registration behind it.
pub(super) fn retiring_registration(
    conn: &Connection,
    scope: &RetirementScope<'_>,
    key: &RetirementKey,
    host: &ApplicationHostCoordinate,
) -> Result<Registration, ApplicationError> {
    let retiring = validate_retirement(conn, scope, key)?;
    if retiring.released_through.is_some()
        || retiring
            .activation
            .as_ref()
            .and_then(|activation| activation.adoption.as_ref())
            .is_none()
    {
        return Err(ApplicationError::Conflict);
    }
    let (binding, _) = read_bound_binding(conn, scope.namespace, &retiring.doc)?
        .ok_or(ApplicationError::Conflict)?;
    let mut held = Registration {
        workspace_id: scope.workspace_id.to_owned(),
        namespace: scope.namespace.to_owned(),
        coordinate: host.clone(),
        binding,
        activation_id: Some(key.activation_id.clone()),
        live: true,
    };
    let (_, coordinate, available) =
        read_binding(conn, &held)?.ok_or(ApplicationError::Conflict)?;
    if coordinate.host_id != host.host_id || !available {
        return Err(ApplicationError::Conflict);
    }
    held.coordinate = coordinate;
    Ok(held)
}
