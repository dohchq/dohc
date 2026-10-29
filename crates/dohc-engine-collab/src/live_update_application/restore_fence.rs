use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum RestoreDeliveryOrigin {
    Bootstrap { id: String },
    Owner { id: String },
}

/// Journal point authenticated before committing the restore fence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreSelection {
    pub journal_cursor: i64,
    pub receipt_digest: String,
}

/// Supplied by an authenticated operation adapter after relay old-cut ACK.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreFence {
    pub point: NativeRestoreSelection,
    pub operation_id: String,
    pub relay_database_namespace: String,
    pub old_binding: LiveObjectBinding,
    pub host_id: String,
    pub new_fence: i64,
    pub origin: RestoreDeliveryOrigin,
    pub terminal: Option<LiveUpdateReceipt>,
    pub applied_sequence: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreFenceReceipt {
    pub operation: NativeRestoreFence,
    pub local_head_sequence: i64,
    pub recorded_at_ms: i64,
}

/// The restore fence a cancellation names: one operation's fence of one
/// document lineage, on the host that fenced it. The engine's configuration
/// fixes its namespace and workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreFenceCancellation {
    pub operation_id: String,
    pub object_id: String,
    pub lineage_claim_id: String,
    pub host_id: String,
    pub new_fence: i64,
}

/// The terminal end of a restore cancelled after its fence committed and
/// before anything applied it. The fence moved the document's generation and
/// nothing else: `binding` is the fence's stopped binding at the new
/// generation, and `endpoint` the accepted history the fence froze. Content,
/// native head, lineage origin and retained work stay as the fence left them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreCancellationReceipt {
    pub fence: NativeRestoreFenceReceipt,
    pub binding: LiveObjectBinding,
    pub endpoint: RetainedPrefixBody,
    pub recorded_at_ms: i64,
}

impl NativeRestoreCancellationReceipt {
    /// The record agrees with itself: the fence it ends, the binding that
    /// fence stopped, and the endpoint the fence's terminal names.
    pub(super) fn validate(&self) -> Result<(), ApplicationError> {
        self.fence.operation.validate()?;
        integer(self.fence.local_head_sequence, 0, SAFE)?;
        integer(self.fence.recorded_at_ms, 0, SAFE)?;
        integer(self.recorded_at_ms, 0, SAFE)?;
        integer(self.endpoint.event_count, 0, SAFE)?;
        digest(&self.endpoint.history_evidence_digest)?;
        let operation = &self.fence.operation;
        let mut stopped = operation.old_binding.clone();
        stopped.restore_fence_generation = operation.new_fence;
        if self.binding != stopped
            || self.endpoint.terminal_receipt != operation.terminal
            || (self.endpoint.event_count == 0) != operation.terminal.is_none()
        {
            return Err(ApplicationError::Conflict);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreFenceCancellationOutcome {
    /// No fence of the operation committed here, and none ever will. The
    /// document keeps the generation before it; `binding` is its binding in
    /// the namespace at that generation, while it has one.
    Cancelled {
        generation: i64,
        binding: Option<LiveObjectBinding>,
    },
    /// The fence committed and this cancellation ended it before anything
    /// applied the restore. The document stays at the fenced generation.
    FenceCancelled(Box<NativeRestoreCancellationReceipt>),
}

/// Cancel a restore whose fence may still be in flight. The store's one
/// writer orders this against the fence: a cancellation recorded first makes
/// the operation's fence refuse, and a fence committed first ends with a
/// terminal cancellation. Either way the operation never prepares, applies or
/// fences again. A replay answers the same. Another key for the operation,
/// another host, a key the document's generation has passed or never
/// reached, and a restore already admitted refuse. The answer is durable
/// before it returns.
pub fn cancel_restore_fence(
    store: &mut EngineStore,
    namespace: &str,
    workspace_id: &str,
    host_id: &str,
    input: &RestoreFenceCancellation,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<RestoreFenceCancellationOutcome, ApplicationError> {
    identifier(namespace, 512)?;
    identifier(&input.operation_id, 512)?;
    identifier(&input.object_id, 1024)?;
    identifier(&input.host_id, 1024)?;
    digest(&input.lineage_claim_id)?;
    integer(input.new_fence, 1, SAFE)?;
    integer(now_ms, 0, SAFE)?;
    if input.host_id != host_id {
        return Err(ApplicationError::Conflict);
    }
    let outcome = store.write_durable_with(faults, |tx| {
        let outcome = cancel_in(tx, namespace, workspace_id, input, now_ms)?;
        // A replay writes nothing, and SQLite syncs no commit without a
        // write. The marker makes every answer durable before it is sent.
        let marked = tx.execute(
            "INSERT INTO engine_requests (request_id, payload_hash, result_seq, committed_at, kind) \
             VALUES (?1, '', -1, 0, 'restore-cancellation-durability') \
             ON CONFLICT(request_id) DO UPDATE SET result_seq = CASE result_seq WHEN -1 THEN -2 ELSE -1 END \
             WHERE engine_requests.kind = 'restore-cancellation-durability'",
            params![format!("\0restore-cancellation-durability:{workspace_id}")],
        ).map_err(write_sql)?;
        if marked != 1 {
            return Err(ApplicationError::Corrupt);
        }
        Ok(outcome)
    })?;
    match outcome {
        TxnOutcome::Committed(outcome) => Ok(outcome),
        TxnOutcome::Crashed { .. } => Err(ApplicationError::Interrupted),
    }
}

fn cancel_in(
    tx: &Transaction<'_>,
    namespace: &str,
    workspace_id: &str,
    input: &RestoreFenceCancellation,
    now_ms: i64,
) -> Result<RestoreFenceCancellationOutcome, ApplicationError> {
    let generation = input.new_fence - 1;
    let main: String = tx
        .query_row(
            "SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1",
            [workspace_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(read_sql)?
        .ok_or(ApplicationError::WorkspaceMismatch)?;
    let key = (
        workspace_id.to_owned(),
        main.clone(),
        input.object_id.clone(),
        input.lineage_claim_id.clone(),
        input.new_fence,
    );
    type Fenced = (
        String,
        String,
        String,
        Option<String>,
        Option<i64>,
        String,
        bool,
        Option<String>,
    );
    let fenced: Option<Fenced> = tx.query_row(
        "SELECT workspace_id,main_version_id,object_id,lineage_claim_id,new_generation,receipt_json,
            application_json IS NOT NULL OR resume_receipt_json IS NOT NULL,cancelled_json
         FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2",
        params![namespace, input.operation_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
    ).optional().map_err(read_sql)?;
    if let Some((workspace, version, object, lineage, fence, receipt, admitted, cancelled)) = fenced
    {
        let Some((lineage, fence)) = lineage.zip(fence) else {
            return Err(ApplicationError::Corrupt);
        };
        if (workspace, version, object, lineage, fence) != key || admitted {
            return Err(ApplicationError::Conflict);
        }
        let receipt: NativeRestoreFenceReceipt =
            serde_json::from_str(&receipt).map_err(|_| ApplicationError::Corrupt)?;
        if receipt.operation.operation_id != input.operation_id
            || receipt.operation.relay_database_namespace != namespace
            || receipt.operation.new_fence != input.new_fence
        {
            return Err(ApplicationError::Corrupt);
        }
        if receipt.operation.host_id != input.host_id {
            return Err(ApplicationError::Conflict);
        }
        if let Some(saved) = cancelled {
            let saved: NativeRestoreCancellationReceipt =
                serde_json::from_str(&saved).map_err(|_| ApplicationError::Corrupt)?;
            if saved.fence != receipt {
                return Err(ApplicationError::Corrupt);
            }
            return Ok(RestoreFenceCancellationOutcome::FenceCancelled(Box::new(
                saved,
            )));
        }
        let cancellation = terminal_cancellation(tx, namespace, receipt, now_ms)?;
        // The declined proposal goes with the operation; a cancelled row
        // holds none.
        let changed = tx.execute(
            "UPDATE live_restore_fences SET cancelled_json=?3,proposal_json=NULL,proposal_candidate_sha256=NULL,
                proposal_frozen_sha256=NULL,proposal_point_sha256=NULL
             WHERE relay_database_namespace=?1 AND operation_id=?2 AND application_json IS NULL
               AND resume_receipt_json IS NULL AND cancelled_json IS NULL",
            params![namespace, input.operation_id, serde_json::to_string(&cancellation).map_err(|_| ApplicationError::Corrupt)?],
        ).map_err(write_sql)?;
        if changed != 1 {
            return Err(ApplicationError::Corrupt);
        }
        return Ok(RestoreFenceCancellationOutcome::FenceCancelled(Box::new(
            cancellation,
        )));
    }
    let doc = DocKey::new(workspace_id, &main, &input.object_id)?;
    let bound = retirement::read_bound_binding(tx, namespace, &doc)?.map(|(binding, _)| binding);
    let saved: Option<(String, String, String, String, i64)> = tx
        .query_row(
            "SELECT workspace_id,main_version_id,object_id,lineage_claim_id,new_generation
         FROM live_restore_cancellations WHERE relay_database_namespace=?1 AND operation_id=?2",
            params![namespace, input.operation_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(read_sql)?;
    match saved {
        Some(saved) if saved == key => {}
        Some(_) => return Err(ApplicationError::Conflict),
        None => {
            // Only a key the document holds: its binding at the generation
            // before, or with no binding, the lineage and generation the
            // document proves. A fence at the generation after names another
            // owner.
            let held = match &bound {
                Some(b) => {
                    b.lineage_claim_id == input.lineage_claim_id
                        && b.restore_fence_generation == generation
                }
                None => {
                    proven_generation(tx, namespace, &doc, &input.lineage_claim_id)?
                        == Some(generation)
                }
            };
            if !held || latest_generation(tx, &doc)?.is_some_and(|(g, _)| g >= input.new_fence) {
                return Err(ApplicationError::Conflict);
            }
            tx.execute(
                "INSERT INTO live_restore_cancellations(relay_database_namespace,operation_id,workspace_id,
                    main_version_id,object_id,lineage_claim_id,new_generation,cancelled_at_ms)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![namespace, input.operation_id, workspace_id, main, input.object_id,
                    input.lineage_claim_id, input.new_fence, now_ms],
            ).map_err(write_sql)?;
        }
    }
    Ok(RestoreFenceCancellationOutcome::Cancelled {
        generation,
        binding: bound.filter(|b| {
            b.lineage_claim_id == input.lineage_claim_id && b.restore_fence_generation == generation
        }),
    })
}

/// The generation a document with no binding in `namespace` proves for
/// `lineage`: its last resumed or cancelled restore, else the generation its
/// lineage's released tail kept. None when neither its marker nor a released
/// activation names the lineage.
fn proven_generation(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
) -> Result<Option<i64>, ApplicationError> {
    let tail = owner_activations::released_chain_tail(conn, namespace, doc, lineage)?;
    let marked = durable::read_marker_in(conn, doc)?
        .is_some_and(|marker| marker.lineage_claim_id.as_deref() == Some(lineage));
    if tail.is_none() && !marked {
        return Ok(None);
    }
    let settled = current_generation(conn, doc).map_err(|error| match error {
        CollabError::RestoreFenced => ApplicationError::Conflict,
        error => error.into(),
    })?;
    if settled.is_some() {
        return Ok(settled);
    }
    let Some(tail) = tail else {
        return Ok(None);
    };
    conn.query_row(
        "SELECT released_restore_generation FROM live_owner_activations
         WHERE relay_database_namespace=?1 AND activation_id=?2",
        params![namespace, tail],
        |r| r.get(0),
    )
    .map_err(read_sql)
}

/// The terminal cancellation of the committed fence `fence`, which nothing
/// applied: the document still holds the fence's stopped binding,
/// unavailable, its frozen native head, its recorded origin, and accepted
/// history ending exactly at the fence's terminal. It reads no restore proof
/// and no history beyond that endpoint.
fn terminal_cancellation(
    tx: &Transaction<'_>,
    namespace: &str,
    fence: NativeRestoreFenceReceipt,
    now_ms: i64,
) -> Result<NativeRestoreCancellationReceipt, ApplicationError> {
    let operation = &fence.operation;
    let b = &operation.old_binding;
    let doc = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    let mut stopped = b.clone();
    stopped.restore_fence_generation = operation.new_fence;
    let held: Option<(String, i64)> = tx
        .query_row(
            "SELECT host_id,available FROM live_device_application_bindings
             WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4",
            params![namespace, doc.workspace_id, doc.version_id, doc.object_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(read_sql)?;
    if retirement::read_bound_binding(tx, namespace, &doc)?.map(|(binding, _)| binding)
        != Some(stopped.clone())
        || held != Some((operation.host_id.clone(), 0))
        || marker(tx, b)?.head_update_seq != fence.local_head_sequence
    {
        return Err(ApplicationError::Conflict);
    }
    let origin = match &operation.origin {
        RestoreDeliveryOrigin::Owner { id } => {
            owner_activations::current_activation(tx, Some(namespace), &doc, &b.lineage_claim_id)?
                .is_some_and(|(current, _)| current.activation_id == *id)
        }
        RestoreDeliveryOrigin::Bootstrap { id } => tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM live_device_bootstraps WHERE relay_database_namespace=?1
                   AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5
                   AND bootstrap_id=?6)",
                params![namespace, doc.workspace_id, doc.version_id, doc.object_id, b.lineage_claim_id, id],
                |r| r.get(0),
            )
            .map_err(read_sql)?,
    };
    let endpoint = retirement::accepted_endpoint(tx, namespace, &doc, &b.lineage_claim_id)?;
    // With no terminal, history still ends at the verified origin.
    if !origin
        || (operation.terminal.is_none()
            && endpoint.history_evidence_digest != accepted_history::initial_digest(namespace, b)?)
    {
        return Err(ApplicationError::Conflict);
    }
    let cancellation = NativeRestoreCancellationReceipt {
        fence,
        binding: stopped,
        endpoint,
        recorded_at_ms: now_ms,
    };
    cancellation.validate()?;
    Ok(cancellation)
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeRestoreRefusalReason {
    BindingChanged,
    ReaderUnavailable,
    SourceUnavailable,
    SourceTooLarge,
    IncompleteWitness,
}

/// The writer found no saved fence and refused before its first fence write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreRefusal {
    pub operation: NativeRestoreFence,
    pub reason: NativeRestoreRefusalReason,
}

const SELECTED_POINT_REPLAY_BYTES: usize = crate::limits::MAX_YDOC_UPDATE_BYTES * 5;

// This document lineage's settlements whose moments have not reached the relay:
// local moments above the origin's pushed cursor, then settlements a retained
// history export has not journaled yet. Unpushed rows bound the scan, not history.
const UNPUBLISHED_SETTLEMENT_MOMENTS: &str = "SELECT EXISTS(SELECT 1 FROM sync_identity i JOIN replication_log r ON r.workspace_id=i.workspace_id AND r.origin_id=i.origin_id WHERE i.workspace_id=?1 AND r.origin_seq>COALESCE((SELECT pushed_seq FROM sync_relay_push_state p WHERE p.workspace_id=?1 AND p.origin_id=i.origin_id),-1) AND r.imported=0 AND r.op_kind='moment.append' AND EXISTS(SELECT 1 FROM live_device_settlements s WHERE s.relay_database_namespace=?2 AND s.workspace_id=?1 AND s.main_version_id=?3 AND s.object_id=?4 AND s.lineage_claim_id=?5 AND s.moment_id=json_extract(r.payload_json,'$.momentId'))) OR EXISTS(SELECT 1 FROM live_audit_pending_exports e JOIN live_device_settlements s ON s.relay_database_namespace=e.relay_database_namespace AND s.workspace_id=e.workspace_id AND s.main_version_id=e.main_version_id AND s.object_id=e.object_id AND s.lineage_claim_id=e.lineage_claim_id AND s.terminal_cursor>e.after_settlement_cursor WHERE e.workspace_id=?1 AND e.relay_database_namespace=?2 AND e.main_version_id=?3 AND e.object_id=?4 AND e.lineage_claim_id=?5)";

// Every edit and live application on a restored document runs these reads.
// The fence row stores its restore proof, which can be tens of MiB, before the
// resume receipt and the cancellation, so the live_restore_resumed index must
// answer them. A generation is settled once its restore resumed or its
// cancellation ended it.
const CURRENT_GENERATION: &str = "SELECT new_generation,resume_receipt_json IS NOT NULL OR cancelled_json IS NOT NULL FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 ORDER BY new_generation DESC LIMIT 1";
const RESUMED_REGISTRATION: &str = "SELECT relay_database_namespace,resume_receipt_json,cancelled_json FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND new_generation=?4";
const RESUMED_BINDING: &str = "SELECT resume_receipt_json,cancelled_json FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND new_generation=?4 AND (resume_receipt_json IS NOT NULL OR cancelled_json IS NOT NULL)";

/// The binding a settled generation names: its resumed restore's, or its
/// cancellation's terminal binding.
fn settled_binding(
    resumed: Option<String>,
    cancelled: Option<String>,
) -> Result<LiveObjectBinding, ApplicationError> {
    match (resumed, cancelled) {
        (Some(json), None) => serde_json::from_str::<NativeRestoreResumeReceipt>(&json)
            .map(|receipt| receipt.binding)
            .map_err(|_| ApplicationError::Corrupt),
        (None, Some(json)) => serde_json::from_str::<NativeRestoreCancellationReceipt>(&json)
            .map(|receipt| receipt.binding)
            .map_err(|_| ApplicationError::Corrupt),
        _ => Err(ApplicationError::Corrupt),
    }
}

pub fn require_open(conn: &Connection, key: &DocKey) -> Result<(), CollabError> {
    let stopped: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)",
        params![key.workspace_id, key.version_id, key.object_id], |r| r.get(0),
    ).map_err(|e| CollabError::Storage(StorageError::corrupt_public(e)))?;
    if stopped {
        Err(CollabError::RestoreFenced)
    } else {
        Ok(())
    }
}

pub(crate) fn latest_generation(
    conn: &Connection,
    key: &DocKey,
) -> Result<Option<(i64, bool)>, CollabError> {
    conn.query_row(
        CURRENT_GENERATION,
        params![key.workspace_id, key.version_id, key.object_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| CollabError::Storage(StorageError::corrupt_public(e)))
}

// Each cancellation of a document from generation ?4 through ?5, from the
// generation reads' index.
const CANCELLED_CHAIN: &str = "SELECT new_generation,cancelled_json FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND new_generation>?4 AND new_generation<=?5 AND relay_database_namespace=?6 AND cancelled_json IS NOT NULL ORDER BY new_generation";

/// The restores cancelled after their fences that carried the lineage from
/// generation `from` to `through` with no accepted event between: one for
/// each generation, each ending at `tip`. The walk refuses past
/// `CHECKPOINT_EVENTS` generations.
pub(super) fn require_cancelled(
    conn: &Connection,
    held: &Registration,
    from: i64,
    through: i64,
    tip: &accepted_history::Tip<'_>,
) -> Result<(), ApplicationError> {
    if through <= from || through - from > accepted_history::CHECKPOINT_EVENTS {
        return Err(ApplicationError::Conflict);
    }
    let b = &held.binding;
    let mut query = conn.prepare(CANCELLED_CHAIN).map_err(read_sql)?;
    let mut rows = query
        .query(params![
            b.workspace_id,
            b.main_version_id,
            b.object_id,
            from,
            through,
            held.namespace
        ])
        .map_err(read_sql)?;
    let mut next = from + 1;
    while let Some(row) = rows.next().map_err(read_sql)? {
        let generation: i64 = row.get(0).map_err(read_sql)?;
        let json: String = row.get(1).map_err(read_sql)?;
        if json.len() > NativeHistoryReconstruction::HEADER_BYTES {
            return Err(ApplicationError::Corrupt);
        }
        let cancelled: NativeRestoreCancellationReceipt =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        if cancelled.binding.lineage_claim_id != b.lineage_claim_id {
            continue;
        }
        cancelled
            .validate()
            .map_err(|_| ApplicationError::Corrupt)?;
        let endpoint = &cancelled.endpoint;
        if generation != next
            || cancelled.binding.restore_fence_generation != generation
            || cancelled.fence.operation.relay_database_namespace != held.namespace
            || endpoint.terminal_receipt.as_ref() != tip.terminal
            || endpoint.event_count != tip.count
            || endpoint.history_evidence_digest != tip.evidence
        {
            return Err(ApplicationError::Conflict);
        }
        next += 1;
    }
    if next != through + 1 {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

/// Fresh sessions capture this value; queued work must retain its original value.
pub fn current_generation(conn: &Connection, key: &DocKey) -> Result<Option<i64>, CollabError> {
    let row = latest_generation(conn, key)?;
    match row {
        None => Ok(None),
        Some((generation, true)) if (1..=SAFE).contains(&generation) => Ok(Some(generation)),
        _ => Err(CollabError::RestoreFenced),
    }
}

pub fn require_generation(
    conn: &Connection,
    key: &DocKey,
    expected: Option<i64>,
) -> Result<(), CollabError> {
    if current_generation(conn, key)? == expected {
        Ok(())
    } else {
        Err(CollabError::RestoreFenced)
    }
}

/// No restore fence is active, and a resumed or cancelled one names exactly
/// this binding and namespace.
pub(crate) fn require_registration(
    conn: &Connection,
    key: &DocKey,
    namespace: &str,
    binding: &LiveObjectBinding,
) -> Result<(), ApplicationError> {
    let Some(generation) = current_generation(conn, key)? else {
        return Ok(());
    };
    if generation != binding.restore_fence_generation {
        return Err(ApplicationError::Conflict);
    };
    let (saved_namespace, resumed, cancelled): (String, Option<String>, Option<String>) = conn
        .query_row(
            RESUMED_REGISTRATION,
            params![key.workspace_id, key.version_id, key.object_id, generation],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(read_sql)?;
    if saved_namespace != namespace || settled_binding(resumed, cancelled)? != *binding {
        return Err(ApplicationError::Conflict);
    };
    Ok(())
}

impl NativeRestoreFence {
    pub(super) fn validate(&self) -> Result<(), ApplicationError> {
        integer(self.point.journal_cursor, 0, SAFE)?;
        digest(&self.point.receipt_digest)?;
        identifier(&self.operation_id, 512)?;
        identifier(&self.relay_database_namespace, 512)?;
        identifier(&self.host_id, 1024)?;
        self.old_binding.validate_canonical().map_err(invalid)?;
        integer(self.old_binding.restore_fence_generation, 0, SAFE - 1)?;
        if self.new_fence != self.old_binding.restore_fence_generation + 1 {
            return Err(ApplicationError::Conflict);
        }
        integer(self.applied_sequence, 0, SAFE)?;
        let id = match &self.origin {
            RestoreDeliveryOrigin::Bootstrap { id } | RestoreDeliveryOrigin::Owner { id } => id,
        };
        identifier(id, 512)?;
        if let Some(terminal) = &self.terminal {
            terminal.validate()?;
        }
        Ok(())
    }
}

pub(super) fn marker(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<durable::Marker, ApplicationError> {
    let key = DocKey::new(
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )?;
    let marker = durable::read_marker_in(conn, &key)?.ok_or(ApplicationError::Conflict)?;
    if marker.regime != Regime::Replicated
        || marker.content_kind != crate::ContentKind::Richdoc
        || marker.lineage_claim_status != durable::LineageClaimStatus::Exact
        || marker.lineage_claim_id.as_deref() != Some(&binding.lineage_claim_id)
        || marker.path.as_deref() != Some(&binding.current_path)
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(marker)
}

pub(super) fn applied_tip(
    conn: &Connection,
    held: &Registration,
    input: &NativeRestoreFence,
) -> Result<(Option<LiveUpdateReceipt>, i64), ApplicationError> {
    let b = &held.binding;
    let origin = match &input.origin {
        RestoreDeliveryOrigin::Bootstrap { id } => {
            // A lineage an owner adopted never restores from a bootstrap,
            // even once its activation is released.
            let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
            if owner_activations::lineage_origin_id(
                conn,
                Some(&held.namespace),
                &key,
                &b.lineage_claim_id,
            )?
            .is_some()
            {
                return Err(ApplicationError::Conflict);
            }
            let (bootstrap, binding, coordinate, sequence) =
                bootstrap::read_bootstrap(conn, held)?.ok_or(ApplicationError::Conflict)?;
            bootstrap.validate()?;
            restore_resume::validate_origin_binding(conn, held, &binding)?;
            if bootstrap.bootstrap_id != *id || coordinate.host_id != input.host_id {
                return Err(ApplicationError::Conflict);
            }
            (None, sequence)
        }
        RestoreDeliveryOrigin::Owner { id } => {
            let origin = adoption::read_origin(conn, held)?.ok_or(ApplicationError::Conflict)?;
            let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
            let (current, _) = owner_activations::current_activation(
                conn,
                Some(&held.namespace),
                &key,
                &b.lineage_claim_id,
            )?
            .ok_or(ApplicationError::Corrupt)?;
            let saved_id = current.activation_id;
            let host: ApplicationHostCoordinate =
                serde_json::from_str(&current.host_coordinate_json)
                    .map_err(|_| ApplicationError::Corrupt)?;
            host.validate()?;
            if saved_id != *id || host.host_id != input.host_id {
                return Err(ApplicationError::Conflict);
            }
            (origin.terminal, origin.sequence)
        }
    };
    // A cancelled restore applied nothing: its generation starts where its
    // fence found the tip, unless the origin came after it.
    let cursor =
        |receipt: &Option<LiveUpdateReceipt>| receipt.as_ref().map_or(0, |r| r.journal_cursor);
    let origin = match restore_resume::settled(conn, held)? {
        Some(restore_resume::Settled::Resumed(resumed)) => (
            Some(resumed.application_receipt),
            resumed.local_head_sequence,
        ),
        Some(restore_resume::Settled::Cancelled(cancelled))
            if cursor(&cancelled.fence.operation.terminal) > cursor(&origin.0) =>
        {
            let fenced = cancelled.fence.operation;
            (fenced.terminal, fenced.applied_sequence)
        }
        _ => origin,
    };
    let latest: Option<LiveUpdateReceipt> = conn.query_row(
        "SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM live_device_update_applications WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND restore_fence_generation=?6 ORDER BY journal_cursor DESC LIMIT 1",
        params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.restore_fence_generation],
        |r| Ok(LiveUpdateReceipt {delivery_id:r.get(0)?,update_digest:r.get(1)?,journal_cursor:r.get(2)?,accepting_host_epoch:r.get(3)?}),
    ).optional().map_err(read_sql)?;
    let Some(terminal) =
        latest.filter(|r| r.journal_cursor > origin.0.as_ref().map_or(0, |r| r.journal_cursor))
    else {
        return Ok(origin);
    };
    let record =
        read_application(conn, &held.namespace, &terminal)?.ok_or(ApplicationError::Corrupt)?;
    settlement::validate_historical_binding(&record.event.metadata.accepted.binding, b)?;
    if record.event.metadata.accepted.receipt != terminal
        || record.coordinate.host_id != input.host_id
    {
        return Err(ApplicationError::Corrupt);
    }
    Ok((Some(terminal), record.sequence))
}

impl ApplicationOwner {
    /// Replays need no ordinary registration, which stays refused after restart.
    pub fn fence_restore(
        &mut self,
        store: &mut EngineStore,
        resolver: Option<&Arc<crate::reader_resolver::ReaderResolver>>,
        input: NativeRestoreFence,
        coordinate: ApplicationHostCoordinate,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<NativeRestoreFenceReceipt, ApplicationError> {
        self.fence_restore_inner(store, resolver, input, coordinate, now_ms, faults, false)
    }

    /// The authenticated host adapter holds its current connection output guard.
    /// Resume a saved old cut without registering or adopting the document again.
    pub fn fence_restore_after_reconnect(
        &mut self,
        store: &mut EngineStore,
        resolver: Option<&Arc<crate::reader_resolver::ReaderResolver>>,
        input: NativeRestoreFence,
        coordinate: ApplicationHostCoordinate,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<NativeRestoreFenceReceipt, ApplicationError> {
        self.fence_restore_inner(store, resolver, input, coordinate, now_ms, faults, true)
    }

    #[allow(clippy::too_many_arguments)]
    fn fence_restore_inner(
        &mut self,
        store: &mut EngineStore,
        resolver: Option<&Arc<crate::reader_resolver::ReaderResolver>>,
        input: NativeRestoreFence,
        coordinate: ApplicationHostCoordinate,
        now_ms: i64,
        faults: &dyn FaultInjector,
        after_reconnect: bool,
    ) -> Result<NativeRestoreFenceReceipt, ApplicationError> {
        input.validate()?;
        coordinate.validate()?;
        integer(now_ms, 0, SAFE)?;
        if input.host_id != coordinate.host_id {
            return Err(ApplicationError::Conflict);
        }
        validate_application_binding(store, &self.workspace_id, &input.old_binding)?;
        let b = &input.old_binding;
        let held = Registration {
            workspace_id: self.workspace_id.clone(),
            namespace: input.relay_database_namespace.clone(),
            coordinate,
            binding: b.clone(),
            activation_id: None,
            live: true,
        };
        let selected = store.read_with(|conn| {
            if !accepted_history::may_have_reader(conn, &held)? {
                return Ok(None);
            }
            let read = conn.unchecked_transaction().map_err(read_sql)?;
            accepted_history::read_selected_point(
                &read,
                &held,
                &input.point,
                &mut restore_content::Budget {
                    remaining: SELECTED_POINT_REPLAY_BYTES,
                },
                accepted_history::CHECKPOINT_EVENTS as usize,
            )
            .map(|history| Some(history.doc))
        });
        // Saved fences replay independently of history; preserve transaction error precedence.
        let (selected, mut selection_error) = match selected {
            Ok(doc) => (doc, None),
            Err(error) => (None, Some(error)),
        };
        let input_json = serde_json::to_string(&input).map_err(|_| ApplicationError::Corrupt)?;
        let outcome = store.write_with(faults, |tx| {
            require_workspace(tx, &held)?;
            let saved: Option<(String, String)> = tx.query_row(
                "SELECT input_json,receipt_json FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND relay_database_namespace=?4 AND operation_id=?5 AND resume_receipt_json IS NULL AND cancelled_json IS NULL",
                params![b.workspace_id,b.main_version_id,b.object_id,held.namespace,input.operation_id],
                |r| Ok((r.get(0)?,r.get(1)?)),
            ).optional().map_err(read_sql)?;
            if let Some((saved_input, receipt)) = saved {
                if saved_input != input_json { return Err(ApplicationError::Conflict); }
                let receipt: NativeRestoreFenceReceipt = serde_json::from_str(&receipt).map_err(|_| ApplicationError::Corrupt)?;
                if receipt.operation != input || receipt.local_head_sequence < input.applied_sequence {
                    return Err(ApplicationError::Corrupt);
                }
                integer(receipt.local_head_sequence, 0, SAFE)?;
                integer(receipt.recorded_at_ms, 0, SAFE)?;
                let mut stopped = b.clone();
                stopped.restore_fence_generation = input.new_fence;
                if !read_binding(tx, &held)?.is_some_and(|(binding, coordinate, available)| {
                    binding == stopped && coordinate.host_id == input.host_id && !available
                }) || marker(tx, b)?.head_update_seq != restore_content::application::fence_replay_head(tx,&held,&receipt)? {
                    return Err(ApplicationError::Corrupt);
                }
                return Ok(receipt);
            }
            // A cancelled operation never fences.
            let collision: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2)
                    OR EXISTS(SELECT 1 FROM live_restore_cancellations WHERE relay_database_namespace=?1 AND operation_id=?2)",
                params![held.namespace,input.operation_id], |r| r.get(0),
            ).map_err(read_sql)?;
            if collision { return Err(ApplicationError::Conflict); }
            let refused = |reason| ApplicationError::RestoreRefused(Box::new(NativeRestoreRefusal {
                operation: input.clone(), reason,
            }));
            let key = DocKey::new(&b.workspace_id,&b.main_version_id,&b.object_id)?;
            require_hosted_ready(tx, &key)?;
            require_registration(tx,&key,&held.namespace,b)?;
            // A restore moves the generation a retirement's key names, so a
            // retiring activation keeps it waiting until its release.
            if retirement::retiring(tx, &key)? {
                return Err(ApplicationError::Conflict);
            }
            let previous=restore_resume::settled(tx,&held)?.map(|settled|settled.operation_id().to_owned());
            if !read_binding(tx, &held)?.is_some_and(|(binding, coordinate, available)| {
                binding == *b && available && (coordinate == held.coordinate
                    || (after_reconnect && coordinate.host_id == held.coordinate.host_id))
            }) {
                return Err(refused(NativeRestoreRefusalReason::BindingChanged));
            }
            // A settlement moment's before-image is publishable only while its
            // generation is current. Refuse until the relay acknowledged this
            // document's journaled settlement moments.
            let unpublished: bool = tx.query_row(
                UNPUBLISHED_SETTLEMENT_MOMENTS,
                params![b.workspace_id,held.namespace,b.main_version_id,b.object_id,b.lineage_claim_id],
                |r| r.get(0),
            ).map_err(read_sql)?;
            if unpublished { return Err(ApplicationError::PublicationPending); }
            let marker = marker(tx, b)?;
            let (terminal, sequence) = applied_tip(tx, &held, &input)?;
            if terminal != input.terminal || sequence != input.applied_sequence || marker.head_update_seq < sequence {
                return Err(ApplicationError::Conflict);
            }
            let current = durable::load_doc_in(tx, &key)?;
            if let Some(error) = selection_error.take() {
                return Err(error);
            }
            accepted_history::require_selected_terminal(tx, &held, &input.point)?;
            // A new reader-bearing append after the preflight needs a fresh attempt.
            if selected.is_none() && accepted_history::may_have_reader(tx, &held)? {
                return Err(ApplicationError::Interrupted);
            }
            let needed = if selected.as_ref().is_some_and(|doc| doc.has_reader_source()) { selected.as_ref() }
                else if current.has_reader_source() { Some(&current) } else { None };
            if let Some(doc) = needed {
                let reference = doc.markdown_source_reference().ok_or_else(|| refused(NativeRestoreRefusalReason::IncompleteWitness))?;
                if doc.markdown_source(&reference).is_none() {
                    return Err(refused(NativeRestoreRefusalReason::IncompleteWitness));
                }
                if resolver.is_none() {
                    return Err(refused(NativeRestoreRefusalReason::ReaderUnavailable));
                }
                crate::reader_snapshot::history_artifact(tx, &key, &b.current_path, &reference.source_sha256, crate::limits::MAX_PUBLIC_MARKDOWN_BYTES)
                    .map_err(|error| match error {
                        CollabError::MarkdownReaderUnavailable => refused(NativeRestoreRefusalReason::SourceUnavailable),
                        CollabError::ConfiguredByteBudgetExceeded => refused(NativeRestoreRefusalReason::SourceTooLarge),
                        error => error.into(),
                    })?;
            }
            let receipt = NativeRestoreFenceReceipt {
                operation: input.clone(),
                local_head_sequence: marker.head_update_seq,
                recorded_at_ms: now_ms,
            };
            tx.execute(
                "INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json,previous_operation_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![b.workspace_id,b.main_version_id,b.object_id,held.namespace,input.operation_id,input_json,serde_json::to_string(&receipt).map_err(|_| ApplicationError::Corrupt)?,previous],
            ).map_err(write_sql)?;
            crate::owner_outbox::keep_recovery_checkpoints_in_tx(tx, b).map_err(|error| match error {
                crate::OwnerOutboxError::Storage(error) => ApplicationError::Storage(error),
                crate::OwnerOutboxError::AcceptedStateIncomplete => {
                    ApplicationError::AcceptedStateIncomplete
                }
                _ => ApplicationError::Corrupt,
            })?;
            let changed = tx.execute(
                "UPDATE live_device_application_bindings SET available=0,restore_fence_generation=?5 WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4",
                params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,input.new_fence],
            ).map_err(write_sql)?;
            if changed != 1 { return Err(ApplicationError::Corrupt); }
            let mut observed = b.clone();
            observed.restore_fence_generation = input.new_fence;
            let outboxes = {
                let mut stmt = tx.prepare(
                    "SELECT outbox_id FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5 AND state!='quarantined'",
                ).map_err(read_sql)?;
                let rows = stmt.query_map(
                    params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.restore_fence_generation],
                    |row| row.get::<_, String>(0),
                ).map_err(read_sql)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
            };
            for outbox_id in outboxes {
                crate::owner_outbox::quarantine_in_tx(
                    tx,
                    &b.workspace_id,
                    &crate::owner_outbox::OwnerOutboxQuarantineInput {
                        outbox_id,
                        reason: "restore-fenced".into(),
                        observed_binding: Some(observed.clone()),
                    },
                    now_ms,
                ).map_err(|error| match error {
                    crate::OwnerOutboxError::Storage(error) => ApplicationError::Storage(error),
                    _ => ApplicationError::Corrupt,
                })?;
            }
            Ok(receipt)
        })?;
        for current in &self.current {
            let mut current = current.lock().map_err(|_| ApplicationError::Interrupted)?;
            if current.binding.main_version_id == b.main_version_id
                && current.binding.object_id == b.object_id
            {
                current.live = false;
            }
        }
        match outcome {
            TxnOutcome::Committed(receipt) => Ok(receipt),
            TxnOutcome::Crashed { .. } => Err(ApplicationError::Interrupted),
        }
    }
}

/// Used only after a local mutation has checked its captured generation.
pub(crate) fn resumed_binding(
    conn: &Connection,
    key: &DocKey,
) -> Result<Option<LiveObjectBinding>, CollabError> {
    let Some(generation) = current_generation(conn, key)? else {
        return Ok(None);
    };
    let (resumed, cancelled): (Option<String>, Option<String>) = conn
        .query_row(
            RESUMED_BINDING,
            params![key.workspace_id, key.version_id, key.object_id, generation],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| CollabError::Storage(StorageError::corrupt_public(e)))?;
    let b = settled_binding(resumed, cancelled).map_err(|_| CollabError::RestoreFenced)?;
    if b.workspace_id != key.workspace_id
        || b.main_version_id != key.version_id
        || b.object_id != key.object_id
        || b.restore_fence_generation != generation
    {
        return Err(CollabError::RestoreFenced);
    };
    Ok(Some(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{Arc, Mutex};

    /// The fence columns `sql` reads, and its query plan.
    fn inspect(conn: &Connection, sql: &str) -> rusqlite::Result<(Vec<String>, Vec<String>)> {
        let columns = Arc::new(Mutex::new(Vec::new()));
        let seen = columns.clone();
        conn.authorizer(Some(move |context: AuthContext<'_>| {
            if let AuthAction::Read {
                table_name: "live_restore_fences",
                column_name,
            } = context.action
            {
                seen.lock().unwrap().push(column_name.to_owned());
            }
            Authorization::Allow
        }))?;
        conn.prepare(sql)?;
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
        let mut plan = Vec::new();
        let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
        let mut rows = statement.raw_query();
        while let Some(row) = rows.next()? {
            plan.push(row.get(3)?);
        }
        let columns = columns.lock().unwrap().clone();
        Ok((columns, plan))
    }

    /// Each edit and live application on a restored document reads its fence.
    /// None of those reads may reach the restore proof stored in the fence row.
    #[test]
    fn restored_document_reads_never_walk_the_restore_proof() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("restore-proof-reads").unwrap();
        let store = EngineStore::open(&scratch.join("engine.db"), 0).unwrap();
        store
            .read_with(|conn| {
                let indexed: Vec<String> = conn
                    .prepare("SELECT name FROM pragma_index_info('live_restore_resumed')")?
                    .query_map([], |row| row.get(0))?
                    .collect::<Result<_, _>>()?;
                for sql in [
                    CURRENT_GENERATION,
                    RESUMED_REGISTRATION,
                    RESUMED_BINDING,
                    CANCELLED_CHAIN,
                    restore_resume::CANCELLED,
                ] {
                    let (columns, plan) = inspect(conn, sql)?;
                    assert!(
                        columns.iter().all(|column| indexed.contains(column)),
                        "{sql} reads {columns:?}"
                    );
                    assert!(
                        plan.iter().all(|detail| detail.starts_with(
                            "SEARCH live_restore_fences USING INDEX live_restore_resumed ("
                        )),
                        "{sql}: {plan:?}"
                    );
                }
                // The checkpoint bind reads stored columns before the proof,
                // and generated columns, which derive from input_json.
                let (stored, generated): (Vec<String>, Vec<String>) = {
                    let mut statement = conn.prepare(
                        "SELECT name,hidden FROM pragma_table_xinfo('live_restore_fences') ORDER BY cid",
                    )?;
                    let rows: Vec<(String, i64)> = statement
                        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                        .collect::<Result<_, _>>()?;
                    let proof = rows.iter().position(|(name, _)| name == "proposal_json").unwrap();
                    (
                        rows[..proof].iter().filter(|(_, hidden)| *hidden == 0).map(|(name, _)| name.clone()).collect(),
                        rows.iter().filter(|(_, hidden)| *hidden == 2).map(|(name, _)| name.clone()).collect(),
                    )
                };
                let (columns, plan) = inspect(conn, accepted_history::NATIVE_APPEND_FENCE)?;
                assert!(
                    columns.iter().all(|column| column == "application_delivery_id"
                        || stored.contains(column)
                        || generated.contains(column)),
                    "the checkpoint bind reads {columns:?}"
                );
                assert_eq!(
                    plan,
                    ["SEARCH live_restore_fences USING INDEX live_restore_application_delivery (relay_database_namespace=? AND application_delivery_id=?)"]
                );
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
    }
}
