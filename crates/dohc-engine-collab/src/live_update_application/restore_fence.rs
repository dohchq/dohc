use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum RestoreDeliveryOrigin {
    Bootstrap { id: String },
    Owner { id: String },
}

/// Supplied by an authenticated operation adapter after relay old-cut ACK.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreFence {
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
    pub fn validate(&self) -> Result<(), ApplicationError> {
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
        mark_durable(tx, "restore-cancellation-durability", workspace_id)?;
        Ok::<_, ApplicationError>(outcome)
    })?;
    match outcome {
        TxnOutcome::Committed(outcome) => Ok(outcome),
        TxnOutcome::Crashed { .. } => Err(ApplicationError::Interrupted),
    }
}

/// A replay writes nothing, and SQLite syncs no commit without a write. This
/// marker of `kind` makes a durable write's answer durable before it is sent.
fn mark_durable(
    tx: &Transaction<'_>,
    kind: &str,
    workspace_id: &str,
) -> Result<(), ApplicationError> {
    let marked = tx
        .execute(
            "INSERT INTO engine_requests (request_id, payload_hash, result_seq, committed_at, kind) \
             VALUES (?1, '', -1, 0, ?2) \
             ON CONFLICT(request_id) DO UPDATE SET result_seq = CASE result_seq WHEN -1 THEN -2 ELSE -1 END \
             WHERE engine_requests.kind = ?2",
            params![format!("\0{kind}:{workspace_id}"), kind],
        )
        .map_err(write_sql)?;
    if marked != 1 {
        return Err(ApplicationError::Corrupt);
    }
    Ok(())
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
        bool,
    );
    let fenced: Option<Fenced> = tx.query_row(
        "SELECT workspace_id,main_version_id,object_id,lineage_claim_id,new_generation,receipt_json,
            application_json IS NOT NULL OR resume_receipt_json IS NOT NULL,cancelled_json IS NOT NULL
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
        if cancelled {
            let doc = DocKey::new(workspace_id, &main, &input.object_id)?;
            let lineage = Some(input.lineage_claim_id.as_str());
            let saved = cancelled_at(tx, namespace, &doc, lineage, input.new_fence, None)?
                .ok_or(ApplicationError::Corrupt)?;
            if saved.fence != receipt {
                return Err(ApplicationError::Corrupt);
            }
            return Ok(RestoreFenceCancellationOutcome::FenceCancelled(Box::new(
                saved,
            )));
        }
        let cancellation = terminal_cancellation(tx, namespace, receipt, now_ms)?;
        // The declined proposal goes with the operation, and so does each of
        // its blobs nothing else holds; a cancelled row holds none.
        let proposal: [Option<String>; 3] = tx
            .query_row(
                "SELECT proposal_candidate_sha256,proposal_frozen_sha256,proposal_point_sha256
             FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2",
                params![namespace, input.operation_id],
                |r| Ok([r.get(0)?, r.get(1)?, r.get(2)?]),
            )
            .map_err(read_sql)?;
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
        for digest in proposal.iter().flatten() {
            match tx.execute("DELETE FROM binary_blobs WHERE sha256=?1", [digest]) {
                Ok(_) => (),
                Err(rusqlite::Error::SqliteFailure(error, message))
                    if error.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY
                        || (error.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER
                            && message.as_deref() == Some("FOREIGN KEY constraint failed")) => {}
                Err(error) => return Err(write_sql(error)),
            }
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
/// `lineage`: the generation its lineage's released tail kept, else, while
/// its marker names the lineage, its last resumed or cancelled restore. A
/// later restore of another lineage proves nothing for this one. None when
/// neither names the lineage.
fn proven_generation(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: &str,
) -> Result<Option<i64>, ApplicationError> {
    let Some(tail) = owner_activations::released_chain_tail(conn, namespace, doc, lineage)? else {
        let marked = durable::read_marker_in(conn, doc)?
            .is_some_and(|marker| marker.lineage_claim_id.as_deref() == Some(lineage));
        if !marked {
            return Ok(None);
        }
        return current_generation(conn, doc).map_err(|error| match error {
            CollabError::RestoreFenced => ApplicationError::Conflict,
            error => error.into(),
        });
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

// This document lineage's settlements whose moments have not reached the relay:
// local moments above the origin's pushed cursor, then settlements a retained
// history export has not journaled yet. Unpushed rows bound the scan, not history.
const UNPUBLISHED_SETTLEMENT_MOMENTS: &str = "SELECT EXISTS(SELECT 1 FROM sync_identity i JOIN replication_log r ON r.workspace_id=i.workspace_id AND r.origin_id=i.origin_id WHERE i.workspace_id=?1 AND r.origin_seq>COALESCE((SELECT pushed_seq FROM sync_relay_push_state p WHERE p.workspace_id=?1 AND p.origin_id=i.origin_id),-1) AND r.imported=0 AND r.op_kind='moment.append' AND EXISTS(SELECT 1 FROM live_device_settlements s WHERE s.relay_database_namespace=?2 AND s.workspace_id=?1 AND s.main_version_id=?3 AND s.object_id=?4 AND s.lineage_claim_id=?5 AND s.moment_id=json_extract(r.payload_json,'$.momentId'))) OR EXISTS(SELECT 1 FROM live_audit_pending_exports e JOIN live_device_settlements s ON s.relay_database_namespace=e.relay_database_namespace AND s.workspace_id=e.workspace_id AND s.main_version_id=e.main_version_id AND s.object_id=e.object_id AND s.lineage_claim_id=e.lineage_claim_id AND s.terminal_cursor>e.after_settlement_cursor WHERE e.workspace_id=?1 AND e.relay_database_namespace=?2 AND e.main_version_id=?3 AND e.object_id=?4 AND e.lineage_claim_id=?5)";

// Every edit and live application on a restored document runs these reads.
// The fence row stores its restore proof, which can be tens of MiB, before the
// resume receipt and the cancellation, so the live_restore_resumed index must
// answer them. A generation is settled once its restore resumed or its
// cancellation ended it.
const CURRENT_GENERATION: &str = "SELECT new_generation,resume_receipt_json IS NOT NULL,cancelled_json IS NOT NULL,relay_database_namespace FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 ORDER BY new_generation DESC LIMIT 1";
const RESUMED: &str = "SELECT resume_receipt_json FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND new_generation=?4";

// A document's cancelled fence rows from generation ?4 through ?5 in
// namespace ?6, found in the generation reads' index. A cancelled row holds
// no restore proof, and its fence columns come before where one would be.
const CANCELLED_FENCES: &str = "SELECT new_generation,lineage_claim_id,operation_id,length(CAST(cancelled_json AS BLOB)),length(CAST(input_json AS BLOB)),length(CAST(receipt_json AS BLOB)),cancelled_json,input_json,receipt_json FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND new_generation>=?4 AND new_generation<=?5 AND relay_database_namespace=?6 AND cancelled_json IS NOT NULL ORDER BY new_generation";

/// Each cancellation that ended a fence of `doc` in `namespace`, from
/// generation `from` through `through` in order, and of `lineage` when one is
/// named. `each` answers whether to read on. This is the one check of a
/// stored cancellation: it agrees with itself, ends exactly the fence and
/// input its row stored, names that row's namespace, document, lineage and
/// generation, and its endpoint is the accepted history the lineage holds at
/// its event count. Each record is bounded before it is parsed, or charged
/// to `budget`.
pub(super) fn cancellations(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: Option<&str>,
    (from, through): (i64, i64),
    mut budget: Option<&mut restore_content::Budget>,
    mut each: impl FnMut(NativeRestoreCancellationReceipt) -> Result<bool, ApplicationError>,
) -> Result<(), ApplicationError> {
    let mut query = conn.prepare(CANCELLED_FENCES).map_err(read_sql)?;
    let mut rows = query
        .query(params![
            doc.workspace_id,
            doc.version_id,
            doc.object_id,
            from,
            through,
            namespace
        ])
        .map_err(read_sql)?;
    while let Some(row) = rows.next().map_err(read_sql)? {
        let generation: i64 = row.get(0).map_err(read_sql)?;
        let row_lineage: String = row.get(1).map_err(read_sql)?;
        // Another lineage of the document can reach the same generation.
        if lineage.is_some_and(|lineage| lineage != row_lineage) {
            continue;
        }
        let operation: String = row.get(2).map_err(read_sql)?;
        for column in 3..=5 {
            let length: i64 = row.get(column).map_err(read_sql)?;
            match budget.as_deref_mut() {
                Some(budget) => budget
                    .charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?,
                None if (1..=NativeHistoryReconstruction::HEADER_BYTES as i64)
                    .contains(&length) => {}
                None => return Err(ApplicationError::Corrupt),
            }
        }
        let parse = |column: usize| row.get::<_, String>(column).map_err(read_sql);
        let cancelled: NativeRestoreCancellationReceipt =
            serde_json::from_str(&parse(6)?).map_err(|_| ApplicationError::Corrupt)?;
        let input: NativeRestoreFence =
            serde_json::from_str(&parse(7)?).map_err(|_| ApplicationError::Corrupt)?;
        let fence: NativeRestoreFenceReceipt =
            serde_json::from_str(&parse(8)?).map_err(|_| ApplicationError::Corrupt)?;
        cancelled
            .validate()
            .map_err(|_| ApplicationError::Corrupt)?;
        let b = &cancelled.binding;
        if cancelled.fence != fence
            || fence.operation != input
            || input.operation_id != operation
            || input.relay_database_namespace != namespace
            || (
                b.workspace_id.as_str(),
                b.main_version_id.as_str(),
                b.object_id.as_str(),
            ) != (
                doc.workspace_id.as_str(),
                doc.version_id.as_str(),
                doc.object_id.as_str(),
            )
            || b.lineage_claim_id != row_lineage
            || b.restore_fence_generation != generation
            || !holds_endpoint(conn, namespace, b, &cancelled.endpoint)?
        {
            return Err(ApplicationError::Corrupt);
        }
        if !each(cancelled)? {
            break;
        }
    }
    Ok(())
}

/// The cancellation that ended the fence of `doc` into `generation`, as
/// [`cancellations`] checks it.
pub(super) fn cancelled_at(
    conn: &Connection,
    namespace: &str,
    doc: &DocKey,
    lineage: Option<&str>,
    generation: i64,
    budget: Option<&mut restore_content::Budget>,
) -> Result<Option<NativeRestoreCancellationReceipt>, ApplicationError> {
    let mut found = None;
    cancellations(
        conn,
        namespace,
        doc,
        lineage,
        (generation, generation),
        budget,
        |cancelled| {
            found = Some(cancelled);
            Ok(false)
        },
    )?;
    Ok(found)
}

/// The leading bytes of an accepted event's metadata that hold its receipt,
/// or of a checkpoint's terminal: the enclosing keys, and a receipt whose
/// delivery ID of at most 512 bytes may escape to twice that.
const RECEIPT_BYTES: i64 = 2048;

/// Whether `b`'s lineage holds accepted history ending at `endpoint`: its
/// event at that count, or a checkpoint there. The receipt is read from the
/// metadata's leading bytes, which serialization puts first.
fn holds_endpoint(
    conn: &Connection,
    namespace: &str,
    b: &LiveObjectBinding,
    endpoint: &RetainedPrefixBody,
) -> Result<bool, ApplicationError> {
    let held: Option<(String, Vec<u8>, bool)> = conn.query_row(
        "SELECT evidence_digest,substr(CAST(metadata_json AS BLOB),1,?7),1 FROM live_accepted_updates WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND event_count=?6
         UNION ALL SELECT evidence_digest,substr(CAST(terminal_json AS BLOB),1,?7),0 FROM live_accepted_checkpoints WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND event_count=?6 LIMIT 1",
        params![namespace, b.workspace_id, b.main_version_id, b.object_id, b.lineage_claim_id, endpoint.event_count, RECEIPT_BYTES],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(read_sql)?;
    let Some((evidence, head, accepted)) = held else {
        return Ok(false);
    };
    let terminal: Option<LiveUpdateReceipt> = if accepted {
        let receipt = head
            .strip_prefix(br#"{"accepted":{"receipt":"#)
            .ok_or(ApplicationError::Corrupt)?;
        let mut decoder = serde_json::Deserializer::from_slice(receipt);
        Some(
            <LiveUpdateReceipt as serde::Deserialize>::deserialize(&mut decoder)
                .map_err(|_| ApplicationError::Corrupt)?,
        )
    } else {
        serde_json::from_slice(&head).map_err(|_| ApplicationError::Corrupt)?
    };
    Ok(evidence == endpoint.history_evidence_digest && terminal == endpoint.terminal_receipt)
}

/// The binding a settled generation names: the terminal binding of the
/// cancellation already read, or its resumed restore's.
fn settled_binding(
    conn: &Connection,
    key: &DocKey,
    latest: Latest,
) -> Result<LiveObjectBinding, ApplicationError> {
    if let Some(receipt) = latest.cancelled {
        return Ok(receipt.binding);
    }
    let json: Option<String> = conn
        .query_row(
            RESUMED,
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                latest.generation
            ],
            |r| r.get(0),
        )
        .map_err(read_sql)?;
    serde_json::from_str::<NativeRestoreResumeReceipt>(&json.ok_or(ApplicationError::Corrupt)?)
        .map(|receipt| receipt.binding)
        .map_err(|_| ApplicationError::Corrupt)
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

/// A document's latest fenced generation, in its namespace: resumed, or
/// ended by the cancellation [`cancellations`] accepts, or neither yet.
struct Latest {
    generation: i64,
    namespace: String,
    resumed: bool,
    cancelled: Option<NativeRestoreCancellationReceipt>,
}

fn latest(conn: &Connection, key: &DocKey) -> Result<Option<Latest>, CollabError> {
    let latest: Option<(i64, bool, bool, String)> = conn
        .query_row(
            CURRENT_GENERATION,
            params![key.workspace_id, key.version_id, key.object_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| CollabError::Storage(StorageError::corrupt_public(e)))?;
    let Some((generation, resumed, cancelled, namespace)) = latest else {
        return Ok(None);
    };
    let cancelled = match cancelled {
        false => None,
        true => match cancelled_at(conn, &namespace, key, None, generation, None) {
            Ok(Some(receipt)) if !resumed => Some(receipt),
            Err(ApplicationError::Storage(error)) => return Err(CollabError::Storage(error)),
            Err(ApplicationError::Collab(error)) => return Err(error),
            _ => return Err(CollabError::RestoreFenced),
        },
    };
    Ok(Some(Latest {
        generation,
        namespace,
        resumed,
        cancelled,
    }))
}

/// The document's latest fenced generation, and whether it is settled: its
/// restore resumed, or a cancellation that [`cancellations`] accepts ended it.
pub(crate) fn latest_generation(
    conn: &Connection,
    key: &DocKey,
) -> Result<Option<(i64, bool)>, CollabError> {
    Ok(latest(conn, key)?.map(|latest| {
        (
            latest.generation,
            latest.resumed || latest.cancelled.is_some(),
        )
    }))
}

/// The latest generation, which must be settled, as [`current_generation`]
/// answers it.
fn settled(conn: &Connection, key: &DocKey) -> Result<Option<Latest>, CollabError> {
    match latest(conn, key)? {
        None => Ok(None),
        Some(latest)
            if (latest.resumed || latest.cancelled.is_some())
                && (1..=SAFE).contains(&latest.generation) =>
        {
            Ok(Some(latest))
        }
        Some(_) => Err(CollabError::RestoreFenced),
    }
}

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
    cancelled_chain(
        conn,
        &held.namespace,
        &held.binding,
        (from, through),
        Some(tip),
        accepted_history::CHECKPOINT_EVENTS,
        |_| (),
    )
}

/// The restores cancelled after their fences that carried `b`'s lineage in
/// `namespace` from generation `from` to `b`'s own, one for each generation.
/// Accepted events may lie between them: a cancellation applied nothing, so
/// the history from `from` stays this binding's. A genuine restore between
/// them refuses.
pub fn require_crossed(
    conn: &Connection,
    namespace: &str,
    b: &LiveObjectBinding,
    from: i64,
) -> Result<(), ApplicationError> {
    require_crossed_within(
        conn,
        namespace,
        b,
        from,
        accepted_history::CHECKPOINT_EVENTS,
    )
}

/// [`require_crossed`] in one chain of at most `limit` generations.
pub(super) fn require_crossed_within(
    conn: &Connection,
    namespace: &str,
    b: &LiveObjectBinding,
    from: i64,
    limit: i64,
) -> Result<(), ApplicationError> {
    cancelled_chain(
        conn,
        namespace,
        b,
        (from, b.restore_fence_generation),
        None,
        limit,
        |_| (),
    )
}

/// The most restores cancelled in a row that one accepted event can cross.
pub const MAX_CANCELLED_RESTORES: usize = accepted_history::CHECKPOINT_EVENTS as usize;

/// The restores cancelled after their fences that carried `binding`'s
/// lineage in `namespace` from generation `from` to `through` with no
/// accepted event between, in order, as the history readers check them.
/// Each ends at `endpoint`. None when the generation did not move.
pub fn cancelled_restores(
    conn: &Connection,
    namespace: &str,
    binding: &LiveObjectBinding,
    (from, through): (i64, i64),
    endpoint: &RetainedPrefixBody,
) -> Result<Vec<NativeRestoreCancellationReceipt>, ApplicationError> {
    let mut chain = Vec::new();
    if through != from {
        let tip = accepted_history::Tip {
            terminal: endpoint.terminal_receipt.as_ref(),
            count: endpoint.event_count,
            evidence: &endpoint.history_evidence_digest,
        };
        cancelled_chain(
            conn,
            namespace,
            binding,
            (from, through),
            Some(&tip),
            accepted_history::CHECKPOINT_EVENTS,
            |cancelled| chain.push(cancelled),
        )?;
    }
    Ok(chain)
}

/// The cancellations from `from` to `through`, at most `limit` of them, each
/// checked by [`cancellations`], and each ending at `tip` when one is named.
fn cancelled_chain(
    conn: &Connection,
    namespace: &str,
    b: &LiveObjectBinding,
    (from, through): (i64, i64),
    tip: Option<&accepted_history::Tip<'_>>,
    limit: i64,
    mut keep: impl FnMut(NativeRestoreCancellationReceipt),
) -> Result<(), ApplicationError> {
    if through <= from || through - from > limit {
        return Err(ApplicationError::Conflict);
    }
    let doc = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    let mut next = from + 1;
    cancellations(
        conn,
        namespace,
        &doc,
        Some(&b.lineage_claim_id),
        (from + 1, through),
        None,
        |cancelled| {
            let endpoint = &cancelled.endpoint;
            if cancelled.binding.restore_fence_generation != next
                || tip.is_some_and(|tip| {
                    endpoint.terminal_receipt.as_ref() != tip.terminal
                        || endpoint.event_count != tip.count
                        || endpoint.history_evidence_digest != tip.evidence
                })
            {
                return Err(ApplicationError::Conflict);
            }
            next += 1;
            keep(cancelled);
            Ok(true)
        },
    )?;
    if next != through + 1 {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

/// [`require_crossed`] from `from`, or from the generation of the lineage's
/// latest accepted event or checkpoint at or before `b`'s when that is later.
/// Each accepted event crossed one bounded chain when it was admitted, so the
/// history through that anchor is already verified, and fence admission keeps
/// the generations since within one chain.
pub fn require_crossed_since(
    conn: &Connection,
    namespace: &str,
    b: &LiveObjectBinding,
    from: i64,
) -> Result<(), ApplicationError> {
    require_crossed_since_within(
        conn,
        namespace,
        b,
        from,
        accepted_history::CHECKPOINT_EVENTS,
    )
}

/// [`require_crossed_since`] with chains of at most `limit` generations.
pub(super) fn require_crossed_since_within(
    conn: &Connection,
    namespace: &str,
    b: &LiveObjectBinding,
    from: i64,
    limit: i64,
) -> Result<(), ApplicationError> {
    let anchor = tip_generation(conn, namespace, b, b.restore_fence_generation)?;
    let from = anchor.map_or(from, |anchor| anchor.max(from));
    if from == b.restore_fence_generation {
        return Ok(());
    }
    require_crossed_within(conn, namespace, b, from, limit)
}

/// The generation of `b`'s lineage's latest accepted event, or checkpoint, in
/// `namespace` at or before generation `through`, when it has one.
fn tip_generation(
    conn: &Connection,
    namespace: &str,
    b: &LiveObjectBinding,
    through: i64,
) -> Result<Option<i64>, ApplicationError> {
    conn.query_row(
        "SELECT generation FROM (
            SELECT * FROM (SELECT event_count,json_extract(metadata_json,'$.accepted.binding.restoreFenceGeneration') AS generation FROM live_accepted_updates WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND generation<=?6 ORDER BY event_count DESC LIMIT 1)
            UNION ALL SELECT * FROM (SELECT event_count,json_extract(binding_json,'$.restoreFenceGeneration') AS generation FROM live_accepted_checkpoints WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND generation<=?6 ORDER BY event_count DESC LIMIT 1)
         ) ORDER BY event_count DESC LIMIT 1",
        params![namespace, b.workspace_id, b.main_version_id, b.object_id, b.lineage_claim_id, through],
        |r| r.get(0),
    ).optional().map_err(read_sql)
}

/// A fence of `b`'s lineage into `new_fence` could end cancelled, and the
/// lineage's next event would then cross every generation since its accepted
/// tip. Refuse the fence when [`require_cancelled`] could not read that far.
pub(super) fn require_chain_room(
    conn: &Connection,
    namespace: &str,
    b: &LiveObjectBinding,
    new_fence: i64,
) -> Result<(), ApplicationError> {
    let tip = tip_generation(conn, namespace, b, i64::MAX)?.unwrap_or(b.restore_fence_generation);
    if new_fence - tip > accepted_history::CHECKPOINT_EVENTS {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

/// Fresh sessions capture this value; queued work must retain its original value.
pub fn current_generation(conn: &Connection, key: &DocKey) -> Result<Option<i64>, CollabError> {
    Ok(settled(conn, key)?.map(|latest| latest.generation))
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
    let Some(latest) = settled(conn, key)? else {
        return Ok(());
    };
    if latest.generation != binding.restore_fence_generation || latest.namespace != namespace {
        return Err(ApplicationError::Conflict);
    };
    if settled_binding(conn, key, latest)? != *binding {
        return Err(ApplicationError::Conflict);
    };
    Ok(())
}

impl NativeRestoreFence {
    pub(super) fn validate(&self) -> Result<(), ApplicationError> {
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
        let input_json = serde_json::to_string(&input).map_err(|_| ApplicationError::Corrupt)?;
        // The fence is the operation's point of no return, so its answer, and
        // a replay's, is durable before it is sent.
        let outcome = store.write_durable_with(faults, |tx| {
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
                mark_durable(tx, "restore-fence-durability", &held.workspace_id)?;
                return Ok(receipt);
            }
            // A cancelled operation never fences.
            let collision: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2)
                    OR EXISTS(SELECT 1 FROM live_restore_cancellations WHERE relay_database_namespace=?1 AND operation_id=?2)",
                params![held.namespace,input.operation_id], |r| r.get(0),
            ).map_err(read_sql)?;
            if collision { return Err(ApplicationError::Conflict); }
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
                return Err(ApplicationError::Interrupted);
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
            require_chain_room(tx, &held.namespace, b, input.new_fence)?;
            let current = durable::load_doc_in(tx, &key)?;
            if current.has_reader_source() {
                let reference = current.markdown_source_reference().ok_or(CollabError::MarkdownReaderUnavailable)?;
                if resolver.is_none() { return Err(CollabError::MarkdownReaderUnavailable.into()); }
                crate::reader_snapshot::history_artifact(tx, &key, &b.current_path, &reference.source_sha256, crate::limits::MAX_PUBLIC_MARKDOWN_BYTES)
                    .map_err(|error| match error {
                        CollabError::ConfiguredByteBudgetExceeded => CollabError::MarkdownReaderUnavailable,
                        error => error,
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
    let Some(latest) = settled(conn, key)? else {
        return Ok(None);
    };
    let generation = latest.generation;
    let b = settled_binding(conn, key, latest).map_err(|error| match error {
        ApplicationError::Storage(error) => CollabError::Storage(error),
        _ => CollabError::RestoreFenced,
    })?;
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
                for sql in [CURRENT_GENERATION, RESUMED] {
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
                // A cancelled row holds no proof, and its check reads the
                // fence columns stored before where one would be.
                let (columns, plan) = inspect(conn, CANCELLED_FENCES)?;
                assert!(
                    columns.iter().all(|column| indexed.contains(column)
                        || stored.contains(column)
                        || generated.contains(column)),
                    "the cancellation check reads {columns:?}"
                );
                assert!(
                    plan.iter().all(|detail| detail.starts_with(
                        "SEARCH live_restore_fences USING INDEX live_restore_resumed ("
                    )),
                    "the cancellation check: {plan:?}"
                );
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
    }
}
