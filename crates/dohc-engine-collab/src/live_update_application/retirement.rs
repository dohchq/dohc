//! Stop retires one exact activation. Reconciliation proves what the relay
//! accepted from it and what this host applied, before release. Both share
//! one validation of the activation and one representation of an adoption
//! seed it never delivered.
use super::owner_activations::{
    activation_by_id, current_activation, lineage_origin_id, ActivationAdoption, OwnerActivation,
};
use super::released_protection::{
    readable, ContributionLocator, PreservationFinding, PreservationReason, ProofStage,
    RetainedAuthors, RetainedContribution, Stop, TailWork, Work,
};
use super::*;
use crate::owner_outbox::{
    OwnerDeliveryReceipt, OwnerOutboxError, OwnerOutboxNativeOrigin, OwnerOutboxNativeSource,
    ACTIVATION_RELEASED, MAX_TERMINAL_REASON_BYTES,
};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

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

/// The activation a Stop prepares to fence. No fence exists yet, so it names no F.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparationKey {
    pub object_id: String,
    pub lineage_claim_id: String,
    pub activation_id: String,
    pub restore_fence_generation: i64,
}

/// Why a Stop cannot fence its activation yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparationPending {
    /// A native edit of the activation waits for delivery.
    NativePending,
    /// A Try again of one of its queues is outstanding.
    RetryOutstanding,
}

/// The activations a Stop prepared to fence, on one store's writer. Each
/// refuses local appends while the owner that prepared it lasts, until its
/// release or its retirement's intent. Memory only: a restarted engine
/// holds none.
#[derive(Clone, Default)]
pub struct RetirementPreparations(Arc<Mutex<HashMap<String, Prepared>>>);

/// A preparation's generation, and the owner whose lifetime bounds it.
type Prepared = (i64, Arc<AtomicBool>);

impl RetirementPreparations {
    fn held(&self) -> MutexGuard<'_, HashMap<String, Prepared>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether a preparation refuses appends to the activation at `generation`.
    pub fn blocks(&self, activation_id: &str, generation: i64) -> bool {
        self.held()
            .get(activation_id)
            .is_some_and(|(prepared, owner)| {
                *prepared == generation && owner.load(Ordering::Acquire)
            })
    }

    /// End `owner`'s preparation of the key. True when it was in force.
    pub fn release(&self, key: &PreparationKey, owner: &Arc<AtomicBool>) -> bool {
        let mut held = self.held();
        let Some((generation, prepared)) = held.get(&key.activation_id) else {
            return false;
        };
        if *generation != key.restore_fence_generation || !Arc::ptr_eq(prepared, owner) {
            return false;
        }
        let live = prepared.load(Ordering::Acquire);
        held.remove(&key.activation_id);
        live
    }

    /// A retirement's durable intent refuses the activation's appends from here.
    pub fn end(&self, activation_id: &str) {
        self.held().remove(activation_id);
    }
}

/// Check that nothing of the activation waits for delivery, then refuse its
/// local appends while `owner` lasts. The check and the block run on the
/// store's writer, so no append lands between them. A pending answer blocks
/// nothing. A released or retiring activation is not prepared again.
pub fn prepare_retirement(
    store: &EngineStore,
    scope: &RetirementScope<'_>,
    key: &PreparationKey,
    preparations: &RetirementPreparations,
    owner: &Arc<AtomicBool>,
) -> Result<Option<PreparationPending>, ApplicationError> {
    let pending = store.read_with(|conn| {
        let retiring = validate_retirement(
            conn,
            scope,
            &RetirementKey {
                object_id: key.object_id.clone(),
                lineage_claim_id: key.lineage_claim_id.clone(),
                activation_id: key.activation_id.clone(),
                restore_fence_generation: key.restore_fence_generation,
                accepted_through: 0,
            },
        )?;
        if retiring.released_through.is_some() {
            return Err(ApplicationError::Conflict);
        }
        require_not_retiring(conn, scope.namespace, &key.activation_id)?;
        let doc = &retiring.doc;
        let (retrying, pending): (bool, bool) = conn
            .query_row(
                "SELECT
                   EXISTS(SELECT 1 FROM owner_ydoc_outboxes o JOIN owner_ydoc_outbox_entries e ON e.outbox_id=o.outbox_id
                     WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3 AND o.lineage_claim_id=?4
                       AND o.state='quarantined' AND o.retry_delivery_id IS NOT NULL
                       AND e.pending=1 AND json_extract(e.native_source_json,'$.adoptionId')=?5),
                   EXISTS(SELECT 1 FROM owner_ydoc_outboxes o JOIN owner_ydoc_outbox_entries e ON e.outbox_id=o.outbox_id
                     WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3 AND o.lineage_claim_id=?4
                       AND o.state!='quarantined' AND e.pending=1
                       AND json_extract(e.native_source_json,'$.adoptionId')=?5)",
                params![
                    doc.workspace_id,
                    doc.version_id,
                    doc.object_id,
                    key.lineage_claim_id,
                    key.activation_id
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(read_sql)?;
        Ok::<_, ApplicationError>(if retrying {
            Some(PreparationPending::RetryOutstanding)
        } else if pending {
            Some(PreparationPending::NativePending)
        } else {
            None
        })
    })?;
    if pending.is_none() {
        preparations.held().insert(
            key.activation_id.clone(),
            (key.restore_fence_generation, Arc::clone(owner)),
        );
    }
    Ok(pending)
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

/// The native outbox entries of the document's lineage that `filter` selects,
/// with `e` and `o` naming each entry and its outbox.
fn native_entries(
    conn: &Connection,
    doc: &DocKey,
    lineage: &str,
    filter: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<RetainedEntry>, ApplicationError> {
    let mut query = conn
        .prepare(&format!(
            "SELECT e.outbox_id,e.sequence,e.append_key,e.delivery_id,e.update_digest,e.native_source_json,
                e.accepted_receipt_json,e.pending,e.terminal_reason,e.update_blob_digest,e.terminal_blob_digest,
                length(CAST(e.native_source_json AS BLOB)),o.state='quarantined'
             FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id
             WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3 AND o.lineage_claim_id=?4
               AND e.native_source_json IS NOT NULL AND {filter}
             ORDER BY e.outbox_id,e.sequence"
        ))
        .map_err(read_sql)?;
    let document: [&dyn rusqlite::ToSql; 4] =
        [&doc.workspace_id, &doc.version_id, &doc.object_id, &lineage];
    let mut rows = query
        .query(&*[&document[..], params].concat())
        .map_err(read_sql)?;
    let mut entries = Vec::new();
    while let Some(row) = rows.next().map_err(read_sql)? {
        let update_digest: String = row.get(4).map_err(read_sql)?;
        let source = native_source(
            &row.get::<_, String>(5).map_err(read_sql)?,
            row.get(11).map_err(read_sql)?,
            &row.get::<_, String>(2).map_err(read_sql)?,
            doc,
            lineage,
            &update_digest,
        )?;
        entries.push(RetainedEntry {
            outbox_id: row.get(0).map_err(read_sql)?,
            sequence: row.get(1).map_err(read_sql)?,
            delivery_id: row.get(3).map_err(read_sql)?,
            update_digest,
            source,
            receipt: row.get(6).map_err(read_sql)?,
            pending: row.get(7).map_err(read_sql)?,
            terminal_reason: row.get(8).map_err(read_sql)?,
            update_blob: row.get(9).map_err(read_sql)?,
            terminal_blob: row.get(10).map_err(read_sql)?,
            quarantined: row.get(12).map_err(read_sql)?,
        });
    }
    Ok(entries)
}

/// The activation's retained native entries. With `unproven_through`, only
/// those that still need proof: pending ones, ones without a receipt that no
/// host refused, and ones whose receipt passes F.
fn retained_entries(
    conn: &Connection,
    retiring: &Retiring,
    unproven_through: Option<i64>,
) -> Result<Vec<RetainedEntry>, ApplicationError> {
    native_entries(
        conn,
        &retiring.doc,
        &retiring.lineage_claim_id,
        "json_extract(e.native_source_json,'$.adoptionId')=?5
           AND (?6 IS NULL OR e.pending=1 OR json_extract(e.accepted_receipt_json,'$.journalCursor')>?6
             OR (e.accepted_receipt_json IS NULL AND (e.terminal_reason IS NULL OR e.terminal_reason=?7)))",
        params![
            retiring.activation_id,
            unproven_through,
            ACTIVATION_RELEASED
        ],
    )
}

/// The receipt an entry saved, as the relay's journal names it.
fn saved_receipt(json: &str) -> Result<LiveUpdateReceipt, ApplicationError> {
    let saved: OwnerDeliveryReceipt =
        serde_json::from_str(json).map_err(|_| ApplicationError::Corrupt)?;
    Ok(LiveUpdateReceipt {
        delivery_id: saved.delivery_id,
        update_digest: saved.update_digest,
        journal_cursor: saved.journal_cursor,
        accepting_host_epoch: saved.accepting_host_epoch,
    })
}

/// A Carried delivery the released chain left the activation that follows
/// it, resolved to its original outbox entry. The entry keeps its outbox
/// identity, source activation, receipt and native sequence; nothing moves
/// it or submits it again.
pub(crate) struct InheritedEntry {
    pub entry: RetainedEntry,
    pub receipt: LiveUpdateReceipt,
}

/// The one resolution of the Carried deliveries the released chain ending at
/// `tail` left its successor, as the tail's stored manifest lists them. Each
/// resolves to its original native outbox entry of the document's lineage,
/// which saved exactly the listed receipt for its own delivery and bytes,
/// keeps the listed native sequence and that sequence's provenance, holds no
/// pending or terminal evidence, and was queued by an activation of the
/// chain. Anything else, or a delivery listed twice, refuses. Whether each
/// was applied since, its caller judges.
pub(crate) fn inherited_entries(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    tail: Option<&str>,
) -> Result<Vec<InheritedEntry>, ApplicationError> {
    let Some(tail) = tail else {
        return Ok(Vec::new());
    };
    let (_, manifest) = released_tail(conn, namespace, tail)?;
    if manifest.is_empty() {
        return Ok(Vec::new());
    }
    let chain = chain_activations(conn, namespace, tail)?;
    resolve_manifest(conn, namespace, doc, lineage, manifest, &chain)
}

/// [`inherited_entries`] of the released chain ending at `tail`, whose
/// activations its caller already walked.
pub(super) fn inherited_in_chain(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    tail: &str,
    chain: &HashSet<String>,
) -> Result<Vec<InheritedEntry>, ApplicationError> {
    let (_, manifest) = released_tail(conn, namespace, tail)?;
    resolve_manifest(conn, namespace, doc, lineage, manifest, chain)
}

/// Each delivery of a chain's Carried manifest, resolved as
/// [`inherited_entries`] describes, through the activations `chain` names.
fn resolve_manifest(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    manifest: Vec<CarriedDelivery>,
    chain: &HashSet<String>,
) -> Result<Vec<InheritedEntry>, ApplicationError> {
    let mut listed = BTreeSet::new();
    let mut inherited = Vec::with_capacity(manifest.len());
    for carried in manifest {
        if !listed.insert(carried.receipt.delivery_id.clone()) {
            return Err(ApplicationError::Conflict);
        }
        inherited.push(resolve_carried(
            conn, namespace, doc, lineage, carried, chain,
        )?);
    }
    Ok(inherited)
}

/// One delivery of a chain's Carried manifest, resolved as
/// [`inherited_entries`] describes.
fn resolve_carried(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    carried: CarriedDelivery,
    chain: &HashSet<String>,
) -> Result<InheritedEntry, ApplicationError> {
    carried
        .receipt
        .validate()
        .map_err(|_| ApplicationError::Corrupt)?;
    let entry = native_entries(
        conn,
        doc,
        lineage,
        "e.delivery_id=?5",
        params![carried.receipt.delivery_id],
    )?
    .pop()
    .ok_or(ApplicationError::Conflict)?;
    let saved = entry.receipt.as_deref().map(saved_receipt).transpose()?;
    if saved.as_ref() != Some(&carried.receipt)
        || entry.update_digest != carried.receipt.update_digest
        || entry.source.native_sequence != carried.native_sequence
        || entry.pending
        || entry.update_blob.is_some()
        || entry.terminal_reason.is_some()
        || entry.terminal_blob.is_some()
    {
        return Err(ApplicationError::Conflict);
    }
    if !native_provenance(conn, namespace, doc, lineage, &entry.source)?
        || chained_retiring(
            conn,
            namespace,
            doc,
            lineage,
            chain,
            &entry.source.adoption_id,
        )?
        .is_none()
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(InheritedEntry {
        entry,
        receipt: carried.receipt,
    })
}

/// Whether what queued a native entry proves its source: a native update's
/// own journal row, within its compaction, or a seed's capture.
fn native_provenance(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    source: &OwnerOutboxNativeSource,
) -> Result<bool, ApplicationError> {
    match source.origin {
        OwnerOutboxNativeOrigin::AdoptionSeed => {
            captured_seed(conn, namespace, doc, lineage, source)
        }
        OwnerOutboxNativeOrigin::NativeUpdate { .. } => {
            source.verify_retained_row(conn).map_err(outbox_error)?;
            Ok(true)
        }
    }
}

/// Whether the entry at `sequence` of `outbox_id` is a delivery a host
/// refused, in the strict representation, that an activation of the released
/// chain ending at `tail` queued.
pub(crate) fn chain_refusal(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    tail: Option<&str>,
    outbox_id: &str,
    sequence: i64,
) -> Result<bool, ApplicationError> {
    let Some(tail) = tail else {
        return Ok(false);
    };
    let Some(source) = refused_entry(conn, namespace, doc, lineage, outbox_id, sequence)?
        .and_then(|refusal| refusal.source)
    else {
        return Ok(false);
    };
    let chain = chain_activations(conn, namespace, tail)?;
    Ok(chained_retiring(conn, namespace, doc, lineage, &chain, &source.adoption_id)?.is_some())
}

/// Whether this host applied exactly `receipt` to the document's lineage in
/// `namespace`. An application of its delivery to another document or
/// lineage, of other bytes, or at another coordinate conflicts.
pub(crate) fn applied(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    receipt: &LiveUpdateReceipt,
) -> Result<bool, ApplicationError> {
    let row: Option<(String, String, String, String, String, i64, i64)> = conn
        .prepare_cached(
            "SELECT workspace_id,main_version_id,object_id,lineage_claim_id,update_digest,journal_cursor,
                accepting_host_epoch
             FROM live_device_update_applications WHERE relay_database_namespace=?1 AND delivery_id=?2",
        )
        .map_err(read_sql)?
        .query_row(
            params![namespace, receipt.delivery_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()
        .map_err(read_sql)?;
    let Some((workspace, version, object, applied_lineage, digest, cursor, epoch)) = row else {
        return Ok(false);
    };
    if workspace != doc.workspace_id
        || version != doc.version_id
        || object != doc.object_id
        || applied_lineage != lineage
        || digest != receipt.update_digest
        || cursor != receipt.journal_cursor
        || epoch != receipt.accepting_host_epoch
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(true)
}

/// The order the released chain a lineage's activation follows still asks
/// of its applications.
pub(crate) struct RetainedSuffix {
    /// F: the chain's journal rows through it may apply while the
    /// successor's seed waits for its receipt.
    pub through: i64,
    /// The earliest Carried receipt the chain left that nothing applied yet.
    /// Nothing after it applies.
    pub earliest_carried: Option<i64>,
}

/// The retained suffix of the adopted chain the lineage's activation follows,
/// or its next activation while none is current. Every Carried delivery the
/// chain lists goes through the shared resolution and the exact application
/// check, applied or not, so an application that conflicts refuses.
pub(crate) fn retained_suffix(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
) -> Result<Option<RetainedSuffix>, ApplicationError> {
    let Some(tail) = owner_activations::capture_predecessor(conn, namespace, doc, lineage)? else {
        return Ok(None);
    };
    let (adopted, through): (bool, i64) = conn
        .query_row(
            "SELECT released_boundary_json<>'null',released_accepted_cursor FROM live_owner_activations
             WHERE relay_database_namespace=?1 AND activation_id=?2 AND released_at_ms IS NOT NULL",
            params![namespace, tail],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(read_sql)?;
    // A chain that never adopted retains no suffix.
    if !adopted {
        return Ok(None);
    }
    let mut earliest_carried = None;
    for inherited in inherited_entries(conn, namespace, doc, lineage, Some(&tail))? {
        let cursor = inherited.receipt.journal_cursor;
        if !applied(conn, namespace, doc, lineage, &inherited.receipt)?
            && earliest_carried.is_none_or(|earliest| cursor < earliest)
        {
            earliest_carried = Some(cursor);
        }
    }
    Ok(Some(RetainedSuffix {
        through,
        earliest_carried,
    }))
}

/// The path and restore generation the release of `tail`, a released
/// activation of the document's lineage, bound.
pub(crate) fn released_binding(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    tail: &str,
) -> Result<(String, i64), ApplicationError> {
    let activation = activation_by_id(conn, namespace, tail)?
        .filter(|found| found.released && found.key == *doc && found.lineage_claim_id == lineage)
        .ok_or(ApplicationError::Conflict)?;
    let binding: LiveObjectBinding =
        serde_json::from_str(&activation.binding_json).map_err(|_| ApplicationError::Corrupt)?;
    let generation: Option<i64> = conn
        .query_row(
            "SELECT released_restore_generation FROM live_owner_activations
             WHERE relay_database_namespace=?1 AND activation_id=?2",
            params![namespace, tail],
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    Ok((
        binding.current_path,
        generation.ok_or(ApplicationError::Corrupt)?,
    ))
}

/// What the released chain ending at `tail` retains that no proof covers:
/// each Carried delivery its manifest lists that no host applied here, and
/// each other outbox entry of the chain that is pending, saved a receipt
/// nothing here applied or accepted, or holds neither a receipt nor a strict
/// terminal representation, each with the authors its evidence credits.
/// Every entry of the lineage is validated before it is set aside or kept:
/// its native source, and the exact application or accepted receipt that
/// proves it. A kept one's provenance is validated too: a native update's
/// journal row, a seed's capture, a draft's declarations, and any receipt,
/// acceptance or application its delivery has, a pending one's included.
/// Pending proves nothing applied, and an acceptance or application a
/// pending entry never recorded keeps it as it is.
///
/// Missing or conflicting evidence never reads as nothing retained. An entry
/// whose evidence contradicts itself is a contradiction of the work it names,
/// or of the tail when nothing names that work, and every other entry is
/// still checked. Each contradiction is reserved in `working` before it is
/// kept. Evidence that does not enumerate, or a storage failure, is an
/// error, and so is `stop`, checked before the manifest decodes and before
/// each entry.
pub(crate) fn unproven_retained(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    tail: &str,
    stop: Stop<'_>,
    working: &mut Work<'_>,
) -> Result<TailWork, ApplicationError> {
    let mut work = Found {
        namespace,
        tail: TailWork::default(),
        working,
    };
    let mut listed = BTreeSet::new();
    let chain = chain_activations(conn, namespace, tail)?;
    stop.check(ProofStage::Validation)?;
    let (_, manifest) = released_tail(conn, namespace, tail)?;
    for carried in manifest {
        stop.check(ProofStage::Validation)?;
        let receipt = &carried.receipt;
        let locator = ContributionLocator::Carried {
            delivery_id: receipt.delivery_id.clone(),
            update_digest: receipt.update_digest.clone(),
            journal_cursor: receipt.journal_cursor,
        };
        if !listed.insert(receipt.delivery_id.clone()) {
            work.contradiction(PreservationReason::ContradictoryEvidence, &locator)?;
            continue;
        }
        let unapplied = (|| -> Result<Option<RetainedEntry>, ApplicationError> {
            let inherited = resolve_carried(conn, namespace, doc, lineage, carried, &chain)?;
            let receipt = &inherited.receipt;
            let accepted = accepted_receipt(
                conn,
                namespace,
                doc,
                lineage,
                &receipt.delivery_id,
                &receipt.update_digest,
            )?;
            if accepted.is_some_and(|accepted| accepted != *receipt) {
                return Err(ApplicationError::Conflict);
            }
            Ok((!applied(conn, namespace, doc, lineage, receipt)?).then_some(inherited.entry))
        })();
        let Some(Some(entry)) = work.checked(&locator, unapplied)? else {
            continue;
        };
        let authors = (|| -> Result<RetainedAuthors, ApplicationError> {
            let (agent, automation, person) = declarations(conn, &entry.outbox_id, entry.sequence)?;
            retained_authors(Some(&entry.source), agent, automation, person)
        })();
        work.authored(locator, authors)?;
    }
    let mut entries = conn
        .prepare(
            "SELECT e.outbox_id,e.sequence,e.append_key,e.delivery_id,e.update_digest,e.native_source_json,
                length(CAST(e.native_source_json AS BLOB)),e.pending,e.accepted_receipt_json,e.terminal_reason,
                e.agent_declaration_json,e.automation_declaration_json,e.person_edit
             FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id
             WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3 AND o.lineage_claim_id=?4
             ORDER BY e.outbox_id,e.sequence",
        )
        .map_err(read_sql)?;
    let mut rows = entries
        .query(params![
            doc.workspace_id,
            doc.version_id,
            doc.object_id,
            lineage
        ])
        .map_err(read_sql)?;
    while let Some(row) = rows.next().map_err(read_sql)? {
        stop.check(ProofStage::Validation)?;
        let outbox_id: String = row.get(0).map_err(read_sql)?;
        let sequence: i64 = row.get(1).map_err(read_sql)?;
        let append_key: String = row.get(2).map_err(read_sql)?;
        let delivery_id: String = row.get(3).map_err(read_sql)?;
        let update_digest: String = row.get(4).map_err(read_sql)?;
        let native: Option<String> = row.get(5).map_err(read_sql)?;
        let native_length: Option<i64> = row.get(6).map_err(read_sql)?;
        let pending: bool = row.get(7).map_err(read_sql)?;
        let receipt: Option<String> = row.get(8).map_err(read_sql)?;
        let terminal: Option<String> = row.get(9).map_err(read_sql)?;
        let agent: Option<String> = row.get(10).map_err(read_sql)?;
        let automation: Option<String> = row.get(11).map_err(read_sql)?;
        let person: Option<i64> = row.get(12).map_err(read_sql)?;
        let locator = ContributionLocator::Outbox {
            outbox_id: outbox_id.clone(),
            sequence,
            delivery_id: delivery_id.clone(),
            update_digest: update_digest.clone(),
        };
        // A native entry of another activation of the lineage is that
        // activation's work; one whose source names nothing it can be is not.
        let source = native
            .map(
                |json| -> Result<OwnerOutboxNativeSource, ApplicationError> {
                    let source = native_source(
                        &json,
                        native_length.unwrap_or(0),
                        &append_key,
                        doc,
                        lineage,
                        &update_digest,
                    )?;
                    if !chain.contains(&source.adoption_id)
                        && !lineage_activation(conn, doc, lineage, &source.adoption_id)?
                    {
                        return Err(ApplicationError::Conflict);
                    }
                    Ok(source)
                },
            )
            .transpose();
        let Some(source) = work.checked(&locator, source)? else {
            continue;
        };
        if source
            .as_ref()
            .is_some_and(|source| !chain.contains(&source.adoption_id))
            || listed.contains(&delivery_id)
        {
            continue;
        }
        let unproven = (|| -> Result<bool, ApplicationError> {
            if pending {
                // Nothing saved a receipt for it yet; any acceptance or
                // application of its delivery is still its own.
                if receipt.is_some() || terminal.is_some() {
                    return Err(ApplicationError::Conflict);
                }
                match accepted_receipt(conn, namespace, doc, lineage, &delivery_id, &update_digest)?
                {
                    Some(accepted) => {
                        applied(conn, namespace, doc, lineage, &accepted)?;
                    }
                    None => unacknowledged_application(
                        conn,
                        namespace,
                        doc,
                        lineage,
                        &delivery_id,
                        &update_digest,
                    )?,
                }
            } else if let Some(receipt) = &receipt {
                let saved = saved_receipt(receipt)?;
                saved.validate().map_err(|_| ApplicationError::Corrupt)?;
                if saved.delivery_id != delivery_id || saved.update_digest != update_digest {
                    return Err(ApplicationError::Conflict);
                }
                let accepted =
                    accepted_receipt(conn, namespace, doc, lineage, &delivery_id, &update_digest)?;
                if accepted.as_ref().is_some_and(|accepted| *accepted != saved) {
                    return Err(ApplicationError::Conflict);
                }
                if applied(conn, namespace, doc, lineage, &saved)? || accepted.is_some() {
                    return Ok(false);
                }
            } else if terminal.is_some() {
                if strictly_terminal(conn, namespace, doc, lineage, &chain, &outbox_id, sequence)? {
                    return Ok(false);
                }
                return Err(ApplicationError::Conflict);
            }
            // What it keeps is what its provenance proves.
            if let Some(source) = &source {
                if !native_provenance(conn, namespace, doc, lineage, source)? {
                    return Err(ApplicationError::Conflict);
                }
            }
            Ok(true)
        })();
        if work.checked(&locator, unproven)? != Some(true) {
            continue;
        }
        let authors = retained_authors(source.as_ref(), agent, automation, person);
        work.authored(locator, authors)?;
    }
    let mut tail = work.tail;
    tail.contributions.sort();
    Ok(tail)
}

/// A tail's work as its validation finds it, and the reservation its
/// contradictions are kept in.
struct Found<'a, 'w> {
    namespace: &'a str,
    tail: TailWork,
    working: &'a mut Work<'w>,
}

impl Found<'_, '_> {
    /// A contradiction of the work `locator` names, or of the tail when no
    /// reader could locate that work: its namespace, the work it names, and
    /// its place with room for the contradictions to double, the old list
    /// and the new held at once as they do, reserved before it is made.
    fn contradiction(
        &mut self,
        reason: PreservationReason,
        locator: &ContributionLocator,
    ) -> Result<(), ApplicationError> {
        let contribution = locator.readable().then_some(locator);
        let bytes = self.namespace.len()
            + contribution.map_or(0, ContributionLocator::text_bytes)
            + 3 * std::mem::size_of::<PreservationFinding>();
        self.working
            .grow(u64::try_from(bytes).unwrap_or(u64::MAX))?;
        self.tail.contradictions.push(PreservationFinding {
            reason,
            namespace: Some(self.namespace.to_owned()),
            contribution: contribution.cloned(),
        });
        Ok(())
    }

    /// What `result` reads as evidence of the work `locator` names: none,
    /// with its contradiction recorded, when it does not read. A storage
    /// failure stays an error.
    fn checked<T>(
        &mut self,
        locator: &ContributionLocator,
        result: Result<T, ApplicationError>,
    ) -> Result<Option<T>, ApplicationError> {
        let read = readable(result)?;
        if read.is_none() {
            self.contradiction(PreservationReason::ContradictoryEvidence, locator)?;
        }
        Ok(read)
    }

    /// Keep the work `locator` names, once its authors read. Malformed
    /// authorship is a contradiction of its own: no contribution is made up
    /// for it.
    fn authored(
        &mut self,
        locator: ContributionLocator,
        authors: Result<RetainedAuthors, ApplicationError>,
    ) -> Result<(), ApplicationError> {
        match readable(authors)? {
            Some(authors) => self
                .tail
                .contributions
                .push(RetainedContribution::at(locator, authors)),
            None => self.contradiction(PreservationReason::MalformedAuthorship, &locator)?,
        }
        Ok(())
    }
}

/// The authors an outbox entry's evidence credits, as
/// [`crate::owner_outbox::entry_credit`] derives them for release too.
fn retained_authors(
    native: Option<&OwnerOutboxNativeSource>,
    agent: Option<String>,
    automation: Option<String>,
    person: Option<i64>,
) -> Result<RetainedAuthors, ApplicationError> {
    let (actor, attribution) = crate::owner_outbox::entry_credit(native, agent, automation, person)
        .map_err(outbox_error)?;
    RetainedAuthors::credited(actor.as_deref(), attribution.as_ref())
        .ok_or(ApplicationError::Corrupt)
}

/// An entry's agent and automation declarations and person edit.
type Declarations = (Option<String>, Option<String>, Option<i64>);

/// The declarations the entry at `sequence` of `outbox_id` keeps.
fn declarations(
    conn: &Connection,
    outbox_id: &str,
    sequence: i64,
) -> Result<Declarations, ApplicationError> {
    conn.prepare_cached(
        "SELECT agent_declaration_json,automation_declaration_json,person_edit
         FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND sequence=?2",
    )
    .map_err(read_sql)?
    .query_row(params![outbox_id, sequence], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })
    .map_err(read_sql)
}

/// Refuse an application of `delivery` here that names another document,
/// lineage or bytes. Without a receipt, its coordinate proves nothing.
fn unacknowledged_application(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    delivery: &str,
    update_digest: &str,
) -> Result<(), ApplicationError> {
    let row: Option<(String, String, String, String, String)> = conn
        .prepare_cached(
            "SELECT workspace_id,main_version_id,object_id,lineage_claim_id,update_digest
             FROM live_device_update_applications WHERE relay_database_namespace=?1 AND delivery_id=?2",
        )
        .map_err(read_sql)?
        .query_row(params![namespace, delivery], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })
        .optional()
        .map_err(read_sql)?;
    match row {
        Some((workspace, version, object, applied_lineage, digest))
            if workspace != doc.workspace_id
                || version != doc.version_id
                || object != doc.object_id
                || applied_lineage != lineage
                || digest != update_digest =>
        {
            Err(ApplicationError::Conflict)
        }
        _ => Ok(()),
    }
}

/// Whether `activation_id` names an activation of the document's lineage in
/// any namespace.
fn lineage_activation(
    conn: &Connection,
    doc: &DocKey,
    lineage: &str,
    activation_id: &str,
) -> Result<bool, ApplicationError> {
    conn.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM live_owner_activations WHERE workspace_id=?1 AND main_version_id=?2
           AND object_id=?3 AND lineage_claim_id=?4 AND activation_id=?5)",
    )
    .map_err(read_sql)?
    .query_row(
        params![
            doc.workspace_id,
            doc.version_id,
            doc.object_id,
            lineage,
            activation_id
        ],
        |row| row.get(0),
    )
    .map_err(read_sql)
}

/// Whether the entry at `sequence` of `outbox_id` ended in a strict terminal
/// representation of the released chain whose activations `chain` names: a
/// refusal, or a seed its activation abandoned. A refused owner draft names
/// no activation.
fn strictly_terminal(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    chain: &HashSet<String>,
    outbox_id: &str,
    sequence: i64,
) -> Result<bool, ApplicationError> {
    if let Some(refusal) = refused_entry(conn, namespace, doc, lineage, outbox_id, sequence)? {
        return match refusal.source {
            None => Ok(true),
            Some(source) => {
                Ok(
                    chained_retiring(conn, namespace, doc, lineage, chain, &source.adoption_id)?
                        .is_some(),
                )
            }
        };
    }
    let Some(entry) = native_entries(
        conn,
        doc,
        lineage,
        "e.outbox_id=?5 AND e.sequence=?6",
        params![outbox_id, sequence],
    )?
    .pop() else {
        return Ok(false);
    };
    match chained_retiring(
        conn,
        namespace,
        doc,
        lineage,
        chain,
        &entry.source.adoption_id,
    )? {
        Some(retiring) => is_abandoned_seed(conn, namespace, &retiring, &entry),
        None => Ok(false),
    }
}

/// An entry's retained native source, valid for that entry: within its
/// bound, keyed by its append key, naming the document's lineage and the
/// entry's own bytes. Anything else is corrupt.
fn native_source(
    json: &str,
    length: i64,
    append_key: &str,
    doc: &DocKey,
    lineage: &str,
    update_digest: &str,
) -> Result<OwnerOutboxNativeSource, ApplicationError> {
    if !(1..=MAX_NATIVE_SOURCE_BYTES).contains(&length) {
        return Err(ApplicationError::Corrupt);
    }
    let source: OwnerOutboxNativeSource =
        serde_json::from_str(json).map_err(|_| ApplicationError::Corrupt)?;
    source
        .validate(append_key)
        .map_err(|_| ApplicationError::Corrupt)?;
    let b = &source.binding;
    if b.workspace_id != doc.workspace_id
        || b.main_version_id != doc.version_id
        || b.object_id != doc.object_id
        || b.lineage_claim_id != lineage
        || source.update_digest != update_digest
    {
        return Err(ApplicationError::Corrupt);
    }
    Ok(source)
}

/// A delivery a host refused, as its refusal left it.
#[derive(Debug)]
pub(crate) struct Refusal {
    pub delivery_id: String,
    pub update_digest: String,
    pub terminal_reason: String,
    /// The native update or seed it queued; none for an owner draft.
    pub source: Option<OwnerOutboxNativeSource>,
}

/// The one representation of a delivery a host refused, for release and
/// succession alike: terminal with a valid reason, never acknowledged,
/// accepted or applied in `namespace`, and keeping exactly its own bytes. A
/// native update's journal row proves its source, and a seed's capture
/// proves its. Its reason alone proves nothing, and an abandoned seed's is
/// never a refusal.
/// A refusal stays terminal: whoever reads it records it, and grants nothing.
pub(super) fn refused_entry(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    outbox_id: &str,
    sequence: i64,
) -> Result<Option<Refusal>, ApplicationError> {
    type Row = (String, String, String, String, Option<String>, Option<i64>);
    let row: Option<Row> = conn
        .query_row(
            "SELECT e.delivery_id,e.update_digest,e.terminal_reason,e.append_key,e.native_source_json,
                length(CAST(e.native_source_json AS BLOB))
             FROM owner_ydoc_outbox_entries e JOIN binary_blobs b ON b.sha256=e.terminal_blob_digest
             WHERE e.outbox_id=?1 AND e.sequence=?2 AND e.pending=0 AND e.accepted_receipt_json IS NULL
               AND e.update_blob_digest IS NULL AND e.terminal_blob_digest=e.update_digest
               AND e.terminal_reason<>?3 AND b.byte_length=e.byte_length AND length(b.bytes)=e.byte_length
               AND NOT EXISTS(SELECT 1 FROM live_accepted_updates
                 WHERE relay_database_namespace=?4 AND delivery_id=e.delivery_id)
               AND NOT EXISTS(SELECT 1 FROM live_device_update_applications
                 WHERE relay_database_namespace=?4 AND delivery_id=e.delivery_id)",
            params![outbox_id, sequence, ACTIVATION_RELEASED, namespace],
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
    let Some((delivery_id, update_digest, terminal_reason, append_key, json, length)) = row else {
        return Ok(None);
    };
    if identifier(&terminal_reason, MAX_TERMINAL_REASON_BYTES).is_err() {
        return Ok(None);
    }
    let source = match json {
        None => None,
        Some(json) => {
            let source = native_source(
                &json,
                length.unwrap_or(0),
                &append_key,
                doc,
                lineage,
                &update_digest,
            )?;
            source.verify_retained_row(conn).map_err(outbox_error)?;
            if matches!(source.origin, OwnerOutboxNativeOrigin::AdoptionSeed)
                && !captured_seed(conn, namespace, doc, lineage, &source)?
            {
                return Ok(None);
            }
            Some(source)
        }
    };
    Ok(Some(Refusal {
        delivery_id,
        update_digest,
        terminal_reason,
        source,
    }))
}

/// Whether `source` is the adoption seed its activation queued: the
/// activation it names adopted this lineage, and that activation's retained
/// capture holds exactly the seed's native sequence and full state. A seed
/// has no journal row, so its capture is its provenance.
fn captured_seed(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    source: &OwnerOutboxNativeSource,
) -> Result<bool, ApplicationError> {
    if !matches!(source.origin, OwnerOutboxNativeOrigin::AdoptionSeed)
        || !activation_by_id(conn, namespace, &source.adoption_id)?.is_some_and(|found| {
            found.key == *doc && found.lineage_claim_id == lineage && found.adoption.is_some()
        })
    {
        return Ok(false);
    }
    let captured: Option<(String, String)> = conn
        .query_row(
            "SELECT full_state_digest,descriptor_json FROM ydoc_owner_activation_sources
             WHERE activation_id=?1 AND relay_database_namespace=?2 AND workspace_id=?3
               AND version_id=?4 AND object_id=?5 AND lineage_claim_id=?6",
            params![
                source.adoption_id,
                namespace,
                doc.workspace_id,
                doc.version_id,
                doc.object_id,
                lineage
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
    Ok(captured_digest == source.update_digest
        && captured.native_head_sequence == source.native_sequence)
}

/// Whether `entry` is the retiring activation's adoption seed, never
/// delivered: its capture proves it, nothing accepted or applied its
/// delivery, and nothing applied after the activation's cut, through its
/// release fence once released.
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
    let doc = &retiring.doc;
    if entry.source.adoption_id != retiring.activation_id
        || entry.source.native_sequence != adopted.local_ydoc_sequence
        || entry.receipt.is_some()
        || !captured_seed(
            conn,
            namespace,
            doc,
            &retiring.lineage_claim_id,
            &entry.source,
        )?
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

/// The head of a kept relay refusal.
#[derive(Clone, Copy, PartialEq, Eq)]
enum KeptHead {
    Seed,
    Edit,
}

/// The refused head `entry` waits at or behind, when the relay refused it and
/// nothing can deliver `entry`: its outbox is quarantined without a Try again,
/// the head is pending or kept by an earlier pass, and nothing accepted or
/// applied `entry`'s delivery.
fn kept_refusal(
    conn: &Connection,
    namespace: &str,
    entry: &RetainedEntry,
) -> Result<Option<KeptHead>, ApplicationError> {
    conn.query_row(
        "SELECT json_extract(h.native_source_json,'$.origin.kind')='adoptionSeed'
         FROM owner_ydoc_outboxes o
         JOIN owner_ydoc_outbox_refusals r ON r.outbox_id=o.outbox_id
         JOIN owner_ydoc_outbox_entries h ON h.outbox_id=o.outbox_id AND h.delivery_id=r.delivery_id
         WHERE o.outbox_id=?1 AND o.state='quarantined' AND o.retry_delivery_id IS NULL AND h.sequence<=?2
           AND (h.pending=1 OR h.terminal_reason=?5)
           AND NOT EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries p WHERE p.outbox_id=o.outbox_id
             AND p.sequence<h.sequence AND p.pending=1)
           AND NOT EXISTS(SELECT 1 FROM live_accepted_updates WHERE relay_database_namespace=?3 AND delivery_id=?4)
           AND NOT EXISTS(SELECT 1 FROM live_device_update_applications WHERE relay_database_namespace=?3 AND delivery_id=?4)
         LIMIT 1",
        params![
            entry.outbox_id,
            entry.sequence,
            namespace,
            entry.delivery_id,
            crate::owner_outbox::RETIREMENT_KEPT
        ],
        |row| row.get::<_, Option<bool>>(0),
    )
    .optional()
    .map_err(read_sql)
    .map(|head| {
        head.map(|seed| match seed {
            Some(true) => KeptHead::Seed,
            _ => KeptHead::Edit,
        })
    })
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
    let mut kept = Vec::new();
    // Outboxes a refused seed holds: none of their entries changes.
    let mut held = BTreeSet::new();
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
                    if entry.update_blob.is_none() || entry.terminal_reason.is_some() {
                        return Err(ApplicationError::Conflict);
                    }
                    let seed = matches!(entry.source.origin, OwnerOutboxNativeOrigin::AdoptionSeed);
                    // A seed its activation never delivered goes undelivered.
                    if seed && undelivered_seed(tx, scope.namespace, &retiring, &entry)? {
                        stalled.insert(entry.outbox_id.clone());
                        abandoned.push((entry.outbox_id, entry.sequence));
                        continue;
                    }
                    let refused = kept_refusal(tx, scope.namespace, &entry)?;
                    if !seed && refused == Some(KeptHead::Edit) {
                        // The relay refused an edit at the head and no Try
                        // again can deliver it: it and what waits behind it
                        // are kept, with their bytes.
                        stalled.insert(entry.outbox_id.clone());
                        kept.push((entry.outbox_id, entry.sequence));
                    } else if entry.quarantined && (seed || refused == Some(KeptHead::Seed)) {
                        // A refused seed no settlement may pass, or an edit
                        // behind one, holds the retirement without failing it.
                        seed_quarantined = true;
                        held.insert(entry.outbox_id.clone());
                        stalled.insert(entry.outbox_id);
                        unresolved.push(entry.delivery_id);
                    } else {
                        return Err(ApplicationError::Conflict);
                    }
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
    for (outbox, sequence) in abandoned
        .iter()
        .filter(|(outbox, _)| !held.contains(outbox))
    {
        crate::owner_outbox::abandon_seed_in_tx(tx, outbox, *sequence).map_err(outbox_error)?;
    }
    for (outbox, sequence) in &kept {
        crate::owner_outbox::keep_refused_in_tx(tx, outbox, *sequence).map_err(outbox_error)?;
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
    accepted_receipt(
        conn,
        namespace,
        &retiring.doc,
        &retiring.lineage_claim_id,
        &entry.delivery_id,
        &entry.update_digest,
    )
}

/// The receipt the lineage's accepted history kept for `delivery`, if any.
/// Another document's, or other bytes, under the same delivery conflict.
fn accepted_receipt(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    expected_lineage: &str,
    delivery: &str,
    update_digest: &str,
) -> Result<Option<LiveUpdateReceipt>, ApplicationError> {
    let row: Option<(String, String, String, String, String, String)> = conn
        .prepare_cached(
            "SELECT workspace_id,main_version_id,object_id,lineage_claim_id,update_sha256,
                json_extract(metadata_json,'$.accepted.receipt')
             FROM live_accepted_updates WHERE relay_database_namespace=?1 AND delivery_id=?2",
        )
        .map_err(read_sql)?
        .query_row(params![namespace, delivery], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
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
        || lineage != expected_lineage
        || update != update_digest
        || receipt.delivery_id != delivery
        || receipt.update_digest != update_digest
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
pub struct RetainedPrefixBody {
    pub terminal_receipt: Option<LiveUpdateReceipt>,
    pub event_count: i64,
    pub history_evidence_digest: String,
}

/// The released prefix a successor adopts: its predecessor, the released
/// chain tail, and the boundary that tail kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainedPrefix {
    pub terminal_receipt: Option<LiveUpdateReceipt>,
    pub event_count: i64,
    pub history_evidence_digest: String,
    pub predecessor_activation_id: String,
}

impl RetainedPrefix {
    pub fn body(&self) -> RetainedPrefixBody {
        RetainedPrefixBody {
            terminal_receipt: self.terminal_receipt.clone(),
            event_count: self.event_count,
            history_evidence_digest: self.history_evidence_digest.clone(),
        }
    }

    pub(super) fn validate(&self) -> Result<(), ApplicationError> {
        identifier(&self.predecessor_activation_id, 1024)?;
        integer(self.event_count, 0, SAFE)?;
        digest(&self.history_evidence_digest)?;
        if let Some(receipt) = &self.terminal_receipt {
            receipt.validate()?;
        }
        Ok(())
    }
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
        boundary: Option<RetainedPrefixBody>,
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
    cache: &mut WriterDocCache,
    scope: &RetirementScope<'_>,
    key: &RetirementKey,
    host: &ApplicationHostCoordinate,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<Release, ApplicationError> {
    integer(now_ms, 0, SAFE)?;
    let (doc, replayed) = store.read_with(|conn| {
        let retiring = validate_retirement(conn, scope, key)?;
        let replayed = match retiring.released_through {
            Some(_) => Some(released(conn, scope.namespace, &retiring)?),
            None => None,
        };
        Ok::<_, ApplicationError>((retiring.doc, replayed))
    })?;
    if let Some(replayed) = replayed {
        return Ok(replayed);
    }
    let outcome = store.write_with(faults, |tx| release_in_tx(tx, scope, key, host, now_ms));
    // Its release may return the Y.Doc to accepted state at the head the
    // cache already holds.
    cache.remove(&doc);
    match outcome? {
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
) -> Result<Option<RetainedPrefixBody>, ApplicationError> {
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
    drop_kept_edits(tx, scope.namespace, &retiring, host, &boundary, now_ms)?;
    clear_intent(tx, scope.namespace, &key.activation_id)?;
    Ok(Release::Released {
        replayed: false,
        boundary: Some(boundary),
    })
}

/// Return the local Y.Doc to what the release explains, once the retirement
/// kept refused edits: accepted state at `boundary` and the Carried
/// deliveries, as a successor's capture replays them. The kept edits reached
/// no one, so no successor delivers them again. Their bytes stay in their
/// entries and in the owner's recovery copy. Only a Y.Doc that is exactly
/// that state and the kept edits changes. Any other, or one whose accepted
/// state this budget cannot rebuild, stays as it is.
fn drop_kept_edits(
    tx: &Transaction<'_>,
    namespace: &str,
    retiring: &Retiring,
    host: &ApplicationHostCoordinate,
    boundary: &RetainedPrefixBody,
    now_ms: i64,
) -> Result<(), ApplicationError> {
    let (doc, lineage) = (&retiring.doc, retiring.lineage_claim_id.as_str());
    let kept = native_entries(
        tx,
        doc,
        lineage,
        "json_extract(e.native_source_json,'$.adoptionId')=?5 AND e.terminal_reason=?6",
        params![retiring.activation_id, crate::owner_outbox::RETIREMENT_KEPT],
    )?;
    let Some(activation) = retiring.activation.as_ref().filter(|_| !kept.is_empty()) else {
        return Ok(());
    };
    let binding: LiveObjectBinding =
        serde_json::from_str(&activation.binding_json).map_err(|_| ApplicationError::Corrupt)?;
    let through = boundary
        .terminal_receipt
        .as_ref()
        .map_or(0, |receipt| receipt.journal_cursor);
    let mut budget = super::restore_content::Budget {
        remaining: super::settled_base::RELEASED_CAPTURE_PROOF_BYTES,
    };
    let state = match super::accepted_history::read_state_by_identity(
        tx,
        namespace,
        binding,
        host.clone(),
        through,
        &mut budget,
    ) {
        Ok(state) => state,
        Err(
            ApplicationError::ConfiguredByteBudgetExceeded
            | ApplicationError::AcceptedStateIncomplete,
        ) => return Ok(()),
        Err(error) => return Err(error),
    };
    for inherited in inherited_entries(
        tx,
        namespace,
        doc,
        lineage,
        Some(retiring.activation_id.as_str()),
    )? {
        let Some(bytes) = get_binary_blob(tx, &inherited.entry.update_digest)? else {
            return Ok(());
        };
        state.apply(&bytes)?;
    }
    let explained = state.encode_full_state();
    let proof = crate::Ydoc::wire();
    proof.apply(&explained)?;
    for entry in &kept {
        let digest = entry
            .terminal_blob
            .as_deref()
            .ok_or(ApplicationError::Corrupt)?;
        proof.apply(&get_binary_blob(tx, digest)?.ok_or(ApplicationError::Corrupt)?)?;
    }
    let local = durable::load_doc_in(tx, doc)?;
    if state.has_missing_updates()
        || proof.has_missing_updates()
        || local.has_missing_updates()
        || !crate::replay_parity::structurally_equal_v2(&proof, &local)?
    {
        return Ok(());
    }
    let head = durable::read_marker_in(tx, doc)?
        .ok_or(ApplicationError::Corrupt)?
        .head_update_seq;
    durable::write_head_snapshot_in_tx(
        tx,
        doc,
        head,
        &explained,
        &state.encode_state_vector(),
        now_ms,
    )?;
    Ok(())
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
/// boundary and carried deliveries. A never-adopted release records release
/// order; its predecessor may differ from the capture descriptor.
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
    let inherited: Option<RetainedPrefixBody> =
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
) -> Result<RetainedPrefixBody, ApplicationError> {
    let doc = &retiring.doc;
    let latest: Option<LiveUpdateReceipt> = conn
        .query_row(
            "SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM live_device_update_applications
             WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4
               AND lineage_claim_id=?5 ORDER BY journal_cursor DESC LIMIT 1",
            params![
                namespace,
                doc.workspace_id,
                doc.version_id,
                doc.object_id,
                retiring.lineage_claim_id
            ],
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
    let endpoint = accepted_endpoint(conn, namespace, doc, &retiring.lineage_claim_id)?;
    if endpoint.terminal_receipt != applied {
        return Err(ApplicationError::Conflict);
    }
    Ok(endpoint)
}

/// Where the lineage's accepted history ends: its last event, or a later
/// checkpoint.
pub(super) fn accepted_endpoint(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
) -> Result<RetainedPrefixBody, ApplicationError> {
    let document = params![
        namespace,
        doc.workspace_id,
        doc.version_id,
        doc.object_id,
        lineage
    ];
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
    Ok(RetainedPrefixBody {
        terminal_receipt: serde_json::from_str(&terminal).map_err(|_| ApplicationError::Corrupt)?,
        event_count,
        history_evidence_digest: evidence,
    })
}

/// Classify the activation's retained native entries, and the Carried
/// deliveries it inherited from its released chain, against B and F.
/// Covered: accepted history at or below B keeps its exact receipt.
/// Carried: a saved receipt in (B, F] for its own delivery, never applied,
/// listed under its original identity and cursor order. Abandoned: the strict
/// seed representation. Refused: the strict refusal representation, which
/// needs no acceptance. Anything else, including an entry with both terminal
/// and acceptance evidence, refuses the release.
fn classify(
    conn: &Connection,
    namespace: &str,
    retiring: &Retiring,
    boundary: &RetainedPrefixBody,
    through: i64,
) -> Result<Vec<CarriedDelivery>, ApplicationError> {
    let applied_through = boundary
        .terminal_receipt
        .as_ref()
        .map_or(0, |receipt| receipt.journal_cursor);
    let predecessor = retiring
        .activation
        .as_ref()
        .and_then(|activation| activation.predecessor_activation_id.as_deref());
    // An inherited entry names a released activation, so never the retiring one.
    let inherited = inherited_entries(
        conn,
        namespace,
        &retiring.doc,
        &retiring.lineage_claim_id,
        predecessor,
    )?
    .into_iter()
    .map(|inherited| inherited.entry);
    let mut carried = Vec::new();
    for entry in retained_entries(conn, retiring, None)?
        .into_iter()
        .chain(inherited)
    {
        let Some(saved) = &entry.receipt else {
            let refused = || {
                refused_entry(
                    conn,
                    namespace,
                    &retiring.doc,
                    &retiring.lineage_claim_id,
                    &entry.outbox_id,
                    entry.sequence,
                )
            };
            if is_abandoned_seed(conn, namespace, retiring, &entry)? || refused()?.is_some() {
                continue;
            }
            return Err(ApplicationError::Conflict);
        };
        if entry.terminal_reason.is_some() || entry.terminal_blob.is_some() {
            return Err(ApplicationError::Conflict);
        }
        let receipt = saved_receipt(saved)?;
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
        if applied(
            conn,
            namespace,
            &retiring.doc,
            &retiring.lineage_claim_id,
            &receipt,
        )? {
            return Err(ApplicationError::Conflict);
        }
        carried.push(CarriedDelivery {
            receipt,
            native_sequence: entry.source.native_sequence,
        });
    }
    carried.sort_by_key(|delivery| delivery.receipt.journal_cursor);
    Ok(carried)
}

/// What a released activation left its successor: the boundary it kept and
/// the deliveries it carried.
pub(super) fn released_tail(
    conn: &Connection,
    namespace: &str,
    activation_id: &str,
) -> Result<(Option<RetainedPrefixBody>, Vec<CarriedDelivery>), ApplicationError> {
    let (boundary, carried): (String, String) = conn
        .query_row(
            "SELECT released_boundary_json,carried_manifest_json FROM live_owner_activations
             WHERE relay_database_namespace=?1 AND activation_id=?2 AND released_at_ms IS NOT NULL",
            params![namespace, activation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(read_sql)?;
    Ok((
        serde_json::from_str(&boundary).map_err(|_| ApplicationError::Corrupt)?,
        serde_json::from_str(&carried).map_err(|_| ApplicationError::Corrupt)?,
    ))
}

/// The activations of the released chain ending at `tail`, that one included.
fn chain_activations(
    conn: &Connection,
    namespace: &str,
    tail: &str,
) -> Result<HashSet<String>, ApplicationError> {
    let mut query = conn
        .prepare(
            "WITH RECURSIVE chain(activation_id) AS (SELECT ?2 UNION
               SELECT v.predecessor_activation_id FROM live_owner_activations v JOIN chain c
                 ON v.relay_database_namespace=?1 AND v.activation_id=c.activation_id
               WHERE v.predecessor_activation_id IS NOT NULL)
             SELECT activation_id FROM chain",
        )
        .map_err(read_sql)?;
    let chain = query
        .query_map(params![namespace, tail], |row| row.get(0))
        .map_err(read_sql)?
        .collect::<Result<_, _>>()
        .map_err(read_sql)?;
    Ok(chain)
}

/// An activation of a released chain, given its activations, as its release
/// left it, to judge an entry it queued. None for any other activation.
fn chained_retiring(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    chain: &HashSet<String>,
    activation_id: &str,
) -> Result<Option<Retiring>, ApplicationError> {
    if !chain.contains(activation_id) {
        return Ok(None);
    }
    let Some(activation) = activation_by_id(conn, namespace, activation_id)?
        .filter(|found| found.released && found.key == *doc && found.lineage_claim_id == lineage)
    else {
        return Ok(None);
    };
    let through: i64 = conn
        .query_row(
            "SELECT released_accepted_cursor FROM live_owner_activations
             WHERE relay_database_namespace=?1 AND activation_id=?2",
            params![namespace, activation_id],
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    Ok(Some(Retiring {
        doc: doc.clone(),
        lineage_claim_id: lineage.to_owned(),
        activation_id: activation_id.to_owned(),
        activation: Some(activation),
        released_through: Some(through),
    }))
}

/// How a successor's coverage accounts for one retained entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum Disposition {
    /// Covered or Carried, each under its own proof.
    Receipt { receipt: LiveUpdateReceipt },
    /// A seed its activation strictly abandoned.
    Abandoned,
    /// A delivery a host refused, which stays terminal.
    #[serde(rename_all = "camelCase")]
    Refused {
        delivery_id: String,
        update_digest: String,
        terminal_reason: String,
    },
}

/// One entry of an adoption's coverage: its original outbox, its sequence
/// there, and its disposition. The coverage digest hashes them in this order.
pub(super) type CoveredEntry = (String, i64, Disposition);

/// A successor's coverage of the outboxes its released chain left, under one
/// budget for all of them: each entry Covered by accepted history at or below
/// the prefix, Carried as the chain's resolved manifest lists it, a seed its
/// activation strictly abandoned, or a delivery a host strictly refused.
/// Native sources of the last two belong to the chain, whose activations
/// `chain` names. Anything else refuses the succession, and so does a carried
/// delivery none of them holds. Entries are ordered by outbox and sequence,
/// whatever order `outboxes` names them.
#[allow(clippy::too_many_arguments)]
pub(super) fn retained_coverage(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    outboxes: &[String],
    prefix: &RetainedPrefix,
    carried: &[InheritedEntry],
    chain: &HashSet<String>,
    max_events: usize,
) -> Result<Vec<CoveredEntry>, ApplicationError> {
    let mut outboxes = outboxes.to_vec();
    outboxes.sort();
    outboxes.dedup();
    let mut coverage = Vec::new();
    let mut found = BTreeSet::new();
    for outbox_id in &outboxes {
        outbox_entries(
            conn,
            namespace,
            doc,
            lineage,
            outbox_id,
            prefix,
            carried,
            chain,
            max_events,
            &mut coverage,
            &mut found,
        )?;
    }
    if carried
        .iter()
        .any(|delivery| !found.contains(&delivery.receipt.delivery_id))
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(coverage)
}

/// Add one outbox's entries to `coverage`, which holds at most `max_events`
/// across every outbox, and record the Carried deliveries it found.
#[allow(clippy::too_many_arguments)]
fn outbox_entries(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
    outbox_id: &str,
    prefix: &RetainedPrefix,
    carried: &[InheritedEntry],
    chain: &HashSet<String>,
    max_events: usize,
    coverage: &mut Vec<CoveredEntry>,
    found: &mut BTreeSet<String>,
) -> Result<(), ApplicationError> {
    let through = prefix
        .terminal_receipt
        .as_ref()
        .map_or(0, |receipt| receipt.journal_cursor);
    let over_budget = || invalid("owner adoption retained outbox coverage exceeds its budget");
    let limit = max_events
        .checked_sub(coverage.len())
        .and_then(|remaining| i64::try_from(remaining).ok())
        .and_then(|remaining| remaining.checked_add(1))
        .ok_or_else(over_budget)?;
    let mut query = conn
        .prepare(
            "SELECT sequence,append_key,delivery_id,update_digest,native_source_json,accepted_receipt_json,pending,
                terminal_reason,update_blob_digest,terminal_blob_digest,length(CAST(native_source_json AS BLOB))
             FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 ORDER BY sequence LIMIT ?2",
        )
        .map_err(read_sql)?;
    let mut rows = query.query(params![outbox_id, limit]).map_err(read_sql)?;
    let mut next = 1;
    while let Some(row) = rows.next().map_err(read_sql)? {
        if coverage.len() >= max_events {
            return Err(over_budget());
        }
        let sequence: i64 = row.get(0).map_err(read_sql)?;
        if sequence != next || row.get::<_, bool>(6).map_err(read_sql)? {
            return Err(ApplicationError::Conflict);
        }
        next += 1;
        let append_key: String = row.get(1).map_err(read_sql)?;
        let delivery: String = row.get(2).map_err(read_sql)?;
        let digest: String = row.get(3).map_err(read_sql)?;
        let source = match row.get::<_, Option<String>>(4).map_err(read_sql)? {
            None => None,
            Some(json) => Some(native_source(
                &json,
                row.get(10).map_err(read_sql)?,
                &append_key,
                doc,
                lineage,
                &digest,
            )?),
        };
        let terminal_reason: Option<String> = row.get(7).map_err(read_sql)?;
        let terminal_blob: Option<String> = row.get(9).map_err(read_sql)?;
        let saved = row
            .get::<_, Option<String>>(5)
            .map_err(read_sql)?
            .as_deref()
            .map(saved_receipt)
            .transpose()?;
        // Acceptance evidence beside terminal evidence contradicts itself.
        let terminal = terminal_reason.is_some() || terminal_blob.is_some();
        if let Some(receipt) = accepted_receipt(conn, namespace, doc, lineage, &delivery, &digest)?
        {
            if terminal
                || receipt.journal_cursor > through
                || saved.as_ref().is_some_and(|saved| *saved != receipt)
            {
                return Err(ApplicationError::Conflict);
            }
            coverage.push((
                outbox_id.to_owned(),
                sequence,
                Disposition::Receipt { receipt },
            ));
            continue;
        }
        if let (Some(saved), Some(_)) = (&saved, &source) {
            let listed = carried.iter().any(|inherited| {
                inherited.entry.outbox_id == outbox_id
                    && inherited.entry.sequence == sequence
                    && inherited.receipt == *saved
            });
            if terminal
                || !listed
                || saved.delivery_id != delivery
                || saved.update_digest != digest
                || saved.journal_cursor <= through
                || applied(conn, namespace, doc, lineage, saved)?
            {
                return Err(ApplicationError::Conflict);
            }
            found.insert(delivery);
            coverage.push((
                outbox_id.to_owned(),
                sequence,
                Disposition::Receipt {
                    receipt: saved.clone(),
                },
            ));
            continue;
        }
        if saved.is_some() {
            return Err(ApplicationError::Conflict);
        }
        let chained = |activation_id: &str| {
            chained_retiring(conn, namespace, doc, lineage, chain, activation_id)
        };
        if let Some(source) = &source {
            let entry = RetainedEntry {
                outbox_id: outbox_id.to_owned(),
                sequence,
                delivery_id: delivery.clone(),
                update_digest: digest.clone(),
                receipt: None,
                pending: false,
                terminal_reason: terminal_reason.clone(),
                update_blob: row.get(8).map_err(read_sql)?,
                terminal_blob: terminal_blob.clone(),
                quarantined: false,
                source: source.clone(),
            };
            if let Some(retiring) = chained(&source.adoption_id)? {
                if is_abandoned_seed(conn, namespace, &retiring, &entry)? {
                    coverage.push((outbox_id.to_owned(), sequence, Disposition::Abandoned));
                    continue;
                }
            }
        }
        let refusal = refused_entry(conn, namespace, doc, lineage, outbox_id, sequence)?
            .ok_or(ApplicationError::Conflict)?;
        if let Some(source) = &refusal.source {
            if chained(&source.adoption_id)?.is_none() {
                return Err(ApplicationError::Conflict);
            }
        }
        coverage.push((
            outbox_id.to_owned(),
            sequence,
            Disposition::Refused {
                delivery_id: refusal.delivery_id,
                update_digest: refusal.update_digest,
                terminal_reason: refusal.terminal_reason,
            },
        ));
    }
    Ok(())
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
