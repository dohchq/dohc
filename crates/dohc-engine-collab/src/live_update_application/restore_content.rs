use super::*;
use crate::{ContentKind, Ydoc};
use dohc_engine_storage::put_binary_blob;
use std::io::Write;

pub(super) mod application;
mod native_sources;
pub use application::{NativeRestoreApplication, NativeRestoreApplicationReceipt};
#[cfg(test)]
pub(super) mod tests;
pub use native_sources::NativeRestoreSource;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestorePoint {
    pub journal_cursor: i64,
    /// Baseline digest at zero; update digest at a selected journal cursor.
    pub receipt_digest: String,
    pub markdown_digest: String,
    pub projection_digest: String,
}

/// Native storage owns the accepted history; the caller selects an authenticated point.
#[derive(Clone)]
pub struct NativeRestorePreparation {
    pub fence: NativeRestoreFenceReceipt,
    pub point: NativeRestorePoint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreProposalReceipt {
    pub fence: NativeRestoreFenceReceipt,
    pub point: NativeRestorePoint,
    pub candidate_digest: String,
    pub frozen_state_digest: String,
    pub point_state_digest: String,
    pub final_content_digest: String,
    pub before_state_vector: Vec<u8>,
    pub after_state_vector: Vec<u8>,
    /// These new ranges belong to the restoring owner, not to the point's writers.
    pub replacement_ranges: Vec<LiveUpdateStructRange>,
    pub origin_evidence_digest: String,
    pub selected_history: NativeRestoreHistoryProof,
    pub accepted_history: NativeRestoreHistoryProof,
    pub native_sources: Vec<NativeRestoreSource>,
    pub native_source_manifest_digest: String,
}

/// Constructed only after native verification or verified durable replay.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRestoreProposal {
    receipt: NativeRestoreProposalReceipt,
    candidate_bytes: Vec<u8>,
    frozen_state_bytes: Vec<u8>,
    point_state_bytes: Vec<u8>,
    native_source_bytes: Vec<Vec<u8>>,
}

impl NativeRestoreProposal {
    pub fn receipt(&self) -> &NativeRestoreProposalReceipt {
        &self.receipt
    }
    pub fn candidate_bytes(&self) -> &[u8] {
        &self.candidate_bytes
    }
    pub fn frozen_state_bytes(&self) -> &[u8] {
        &self.frozen_state_bytes
    }
    pub fn point_state_bytes(&self) -> &[u8] {
        &self.point_state_bytes
    }
    pub fn native_source_bytes(&self) -> &[Vec<u8>] {
        &self.native_source_bytes
    }
}

pub(super) struct Budget {
    pub(super) remaining: usize,
}
impl Budget {
    pub(super) fn charge(&mut self, bytes: usize) -> Result<(), ApplicationError> {
        self.remaining = self
            .remaining
            .checked_sub(bytes)
            .ok_or(ApplicationError::ConfiguredByteBudgetExceeded)?;
        Ok(())
    }
    fn blob_length(&mut self, conn: &Connection, digest: &str) -> Result<usize, ApplicationError> {
        let (length, actual): (i64, i64) = conn
            .query_row(
                "SELECT byte_length,length(bytes) FROM binary_blobs WHERE sha256=?1",
                [digest],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(read_sql)?;
        if length != actual
            || length < 0
            || length as u64 > crate::limits::MAX_YDOC_UPDATE_BYTES as u64
        {
            return Err(ApplicationError::Corrupt);
        }
        let length = usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?;
        self.charge(length)?;
        Ok(length)
    }
    pub(super) fn blob(
        &mut self,
        conn: &Connection,
        digest: &str,
    ) -> Result<Vec<u8>, ApplicationError> {
        self.blob_length(conn, digest)?;
        get_binary_blob(conn, digest)?.ok_or(ApplicationError::Corrupt)
    }
    fn json(&mut self, value: &impl Serialize) -> Result<Vec<u8>, ApplicationError> {
        struct Bounded<'a> {
            budget: &'a mut Budget,
            bytes: Vec<u8>,
            exceeded: bool,
        }
        impl Write for Bounded<'_> {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if let Err(error) = self.budget.charge(bytes.len()) {
                    self.exceeded = true;
                    return Err(std::io::Error::other(error));
                }
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut writer = Bounded {
            budget: self,
            bytes: Vec::new(),
            exceeded: false,
        };
        if serde_json::to_writer(&mut writer, value).is_err() {
            return Err(if writer.exceeded {
                ApplicationError::ConfiguredByteBudgetExceeded
            } else {
                ApplicationError::Corrupt
            });
        }
        Ok(writer.bytes)
    }
    fn state(&mut self, doc: &Ydoc) -> Result<Vec<u8>, ApplicationError> {
        let bytes = doc
            .encode_full_state_bounded(self.remaining.min(crate::limits::MAX_YDOC_UPDATE_BYTES))
            .ok_or_else(|| {
                if self.remaining < crate::limits::MAX_YDOC_UPDATE_BYTES {
                    ApplicationError::ConfiguredByteBudgetExceeded
                } else {
                    invalid("restore state exceeds update limit")
                }
            })?;
        self.charge(bytes.len())?;
        Ok(bytes)
    }
}

impl NativeRestorePreparation {
    /// Run before the actor takes ownership of a potentially large queued proof.
    pub fn validate_budget(
        &self,
        max_bytes: usize,
        max_events: usize,
    ) -> Result<(), ApplicationError> {
        if max_bytes == 0 || max_events == 0 || max_events >= i64::MAX as usize {
            return Err(invalid("invalid restore preparation budget"));
        }
        self.fence.operation.validate()?;
        integer(self.fence.local_head_sequence, 0, SAFE)?;
        integer(self.fence.recorded_at_ms, 0, SAFE)?;
        integer(self.point.journal_cursor, 0, SAFE)?;
        for value in [
            &self.point.receipt_digest,
            &self.point.markdown_digest,
            &self.point.projection_digest,
        ] {
            digest(value)?;
        }
        Ok(())
    }
}

impl ApplicationOwner {
    /// Prepare under the actor writer exclusion. No canonical edit or admission occurs here.
    pub fn prepare_restore(
        &mut self,
        store: &mut EngineStore,
        input: NativeRestorePreparation,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        faults: &dyn FaultInjector,
    ) -> Result<NativeRestoreProposal, ApplicationError> {
        input.validate_budget(max_bytes, max_events)?;
        coordinate.validate()?;
        let operation = &input.fence.operation;
        if operation.host_id != coordinate.host_id {
            return Err(ApplicationError::Conflict);
        }
        validate_application_binding(store, &self.workspace_id, &operation.old_binding)?;
        let held = Registration {
            workspace_id: self.workspace_id.clone(),
            namespace: operation.relay_database_namespace.clone(),
            coordinate,
            binding: operation.old_binding.clone(),
            live: false,
        };
        let outcome = store.write_with(faults, |tx| {
            prepare_in(tx, &held, &input, max_bytes, max_events)
        })?;
        match outcome {
            TxnOutcome::Committed(proposal) => Ok(proposal),
            TxnOutcome::Crashed { .. } => Err(ApplicationError::Interrupted),
        }
    }
}

fn prepare_in(
    tx: &Transaction<'_>,
    held: &Registration,
    input: &NativeRestorePreparation,
    max_bytes: usize,
    max_events: usize,
) -> Result<NativeRestoreProposal, ApplicationError> {
    let operation = &input.fence.operation;

    require_workspace(tx, held)?;
    let b = &held.binding;
    let saved: (String,String,Option<i64>,Option<String>,Option<String>,Option<String>) = tx.query_row(
        "SELECT input_json,receipt_json,length(CAST(proposal_json AS BLOB)),proposal_candidate_sha256,proposal_frozen_sha256,proposal_point_sha256 FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND relay_database_namespace=?4 AND operation_id=?5",
        params![b.workspace_id,b.main_version_id,b.object_id,held.namespace,operation.operation_id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)),
    ).optional().map_err(read_sql)?.ok_or(ApplicationError::Conflict)?;
    let saved_input: NativeRestoreFence =
        serde_json::from_str(&saved.0).map_err(|_| ApplicationError::Corrupt)?;
    let saved_fence: NativeRestoreFenceReceipt =
        serde_json::from_str(&saved.1).map_err(|_| ApplicationError::Corrupt)?;
    if saved_input != *operation || saved_fence != input.fence {
        return Err(ApplicationError::Conflict);
    }
    let mut budget = Budget {
        remaining: max_bytes,
    };
    let applied = application::read_saved(tx, held, &mut budget)?;
    let expected_head = applied
        .as_ref()
        .map_or(input.fence.local_head_sequence, |receipt| {
            receipt.local_head_sequence
        });
    let mut stopped = b.clone();
    stopped.restore_fence_generation = operation.new_fence;
    if !read_binding(tx, held)?.is_some_and(|(binding, host, available)| {
        binding == stopped && host.host_id == operation.host_id && !available
    }) || restore_fence::marker(tx, b)?.head_update_seq != expected_head
    {
        return Err(ApplicationError::Conflict);
    }
    let (terminal, sequence) = restore_fence::applied_tip(tx, held, operation)?;
    if terminal != operation.terminal || sequence != operation.applied_sequence {
        return Err(ApplicationError::Conflict);
    }
    let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    let local_bytes = adoption::require_local_replay_budget(tx, &key, budget.remaining)?;
    budget.charge(local_bytes)?;
    let current = durable::load_doc_in(tx, &key)?;
    let (frozen, applied_current) = if applied.is_some() {
        let bytes = budget.blob(tx, saved.4.as_deref().ok_or(ApplicationError::Corrupt)?)?;
        let frozen = Ydoc::wire();
        frozen.apply(&bytes)?;
        (frozen, Some(current))
    } else {
        (current, None)
    };
    if frozen.has_missing_updates() {
        return Err(invalid("restore frozen head has missing dependencies"));
    }

    let (origin_digest, origin_sequence) = origin(tx, held, input, &mut budget)?;
    let accepted_history = accepted_history::read(
        tx,
        held,
        operation.terminal.as_ref().map_or(0, |r| r.journal_cursor),
        &mut budget,
        max_events,
    )?;
    if accepted_history.proof.terminal != operation.terminal {
        return Err(ApplicationError::Conflict);
    }
    let selected_history = accepted_history::read(
        tx,
        held,
        input.point.journal_cursor,
        &mut budget,
        max_events.saturating_sub(accepted_history.proof.suffix.len()),
    )?;
    if selected_history
        .proof
        .terminal
        .as_ref()
        .map_or(b.lineage_claim_id.as_str(), |r| r.update_digest.as_str())
        != input.point.receipt_digest
    {
        return Err(ApplicationError::Conflict);
    }
    let accepted = accepted_history.doc;
    let point = selected_history.doc;
    let event_count = accepted_history.proof.suffix.len() + selected_history.proof.suffix.len();
    let native_sources::ClassifiedNativeSources {
        sources: native_sources,
        bytes: native_source_bytes,
        digest: native_source_manifest_digest,
    } = native_sources::classify(
        tx,
        held,
        input,
        origin_sequence,
        event_count,
        &accepted,
        &mut budget,
        max_events,
    )?;
    if accepted.has_missing_updates()
        || !crate::replay_parity::structurally_equal_v2(&accepted, &frozen)?
    {
        return Err(invalid(
            "restore preparation requires classified native pending context",
        ));
    }
    let point_projection = point.project(ContentKind::Richdoc)?.content;
    let markdown = point
        .preserved_markdown_source(&point_projection)
        .unwrap_or_else(|| point_projection.clone());
    if hex_sha256(point_projection.as_bytes()) != input.point.projection_digest
        || hex_sha256(markdown.as_bytes()) != input.point.markdown_digest
    {
        return Err(ApplicationError::Conflict);
    }
    if markdown.len() > crate::limits::MAX_PUBLIC_MARKDOWN_BYTES
        || point_projection.len() > crate::limits::MAX_PUBLIC_MARKDOWN_BYTES
    {
        return Err(invalid("restore point exceeds public Markdown limit"));
    }
    if let Some(length) = saved.2 {
        budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
        let json: String = tx.query_row("SELECT proposal_json FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND relay_database_namespace=?4 AND operation_id=?5",params![b.workspace_id,b.main_version_id,b.object_id,held.namespace,operation.operation_id],|r|r.get(0)).map_err(read_sql)?;
        let receipt: NativeRestoreProposalReceipt =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        if receipt.fence != input.fence || receipt.point != input.point {
            return Err(ApplicationError::Conflict);
        }
        if receipt.origin_evidence_digest != origin_digest
            || receipt.native_sources != native_sources
            || receipt.native_source_manifest_digest != native_source_manifest_digest
            || receipt.accepted_history != accepted_history.proof
            || receipt.selected_history != selected_history.proof
            || saved.3.as_ref() != Some(&receipt.candidate_digest)
            || saved.4.as_ref() != Some(&receipt.frozen_state_digest)
            || saved.5.as_ref() != Some(&receipt.point_state_digest)
        {
            return Err(ApplicationError::Corrupt);
        }
        let candidate_bytes = budget.blob(tx, &receipt.candidate_digest)?;
        let frozen_state_bytes = budget.blob(tx, &receipt.frozen_state_digest)?;
        let point_state_bytes = budget.blob(tx, &receipt.point_state_digest)?;
        let previous = Ydoc::wire();
        previous.apply(&frozen_state_bytes)?;
        if !crate::replay_parity::structurally_equal_v2(&previous, &frozen)? {
            return Err(ApplicationError::Conflict);
        }
        let saved_point = Ydoc::wire();
        saved_point.apply(&point_state_bytes)?;
        if !crate::replay_parity::structurally_equal_v2(&saved_point, &point)? {
            return Err(ApplicationError::Corrupt);
        }
        verify_candidate(
            &previous,
            &candidate_bytes,
            &point_state_bytes,
            &receipt,
            &mut budget,
        )?;
        let proposal = NativeRestoreProposal {
            receipt,
            candidate_bytes,
            frozen_state_bytes,
            point_state_bytes,
            native_source_bytes,
        };
        if let Some(applied) = &applied {
            application::verify_saved(
                tx,
                held,
                applied,
                &proposal,
                applied_current.as_ref().ok_or(ApplicationError::Corrupt)?,
            )?;
        }
        return Ok(proposal);
    }
    let frozen_state_bytes = budget.state(&frozen)?;
    let point_state_bytes = budget.state(&point)?;
    let before = frozen.state_vector();
    let before_state_vector = frozen.encode_state_vector();
    let candidate_bytes =
        frozen.rewrite_richdoc_preserving_source_bounded(&markdown, &point, budget.remaining)?;
    budget.charge(candidate_bytes.len())?;
    let after = frozen.state_vector();
    let mut replacement_ranges = Vec::new();
    for (&client, &end) in after.iter() {
        let start = before.get(&client);
        if end > start {
            if start != 0 {
                return Err(invalid("restore producer reused a frozen writer identity"));
            }
            let range = LiveUpdateStructRange {
                client_id: i64::try_from(client.get()).map_err(|_| ApplicationError::Corrupt)?,
                start_clock: 0,
                end_clock: i64::from(end),
            };
            range.validate()?;
            replacement_ranges.push(range);
        }
    }
    replacement_ranges.sort_by_key(|range| range.client_id);
    if replacement_ranges.is_empty() {
        return Err(invalid(
            "restore producer created no owner replacement ranges",
        ));
    }
    let receipt = NativeRestoreProposalReceipt {
        fence: input.fence.clone(),
        point: input.point.clone(),
        candidate_digest: hex_sha256(&candidate_bytes),
        frozen_state_digest: hex_sha256(&frozen_state_bytes),
        point_state_digest: hex_sha256(&point_state_bytes),
        final_content_digest: frozen.canonical_content_sha256(),
        before_state_vector,
        after_state_vector: frozen.encode_state_vector(),
        replacement_ranges,
        origin_evidence_digest: origin_digest,
        accepted_history: accepted_history.proof,
        selected_history: selected_history.proof,
        native_sources,
        native_source_manifest_digest,
    };
    let check = Ydoc::wire();
    check.apply(&frozen_state_bytes)?;
    verify_candidate(
        &check,
        &candidate_bytes,
        &point_state_bytes,
        &receipt,
        &mut budget,
    )?;
    let json = String::from_utf8(budget.json(&receipt)?).map_err(|_| ApplicationError::Corrupt)?;
    put_binary_blob(tx, &candidate_bytes)?;
    put_binary_blob(tx, &frozen_state_bytes)?;
    put_binary_blob(tx, &point_state_bytes)?;
    let changed = tx.execute("UPDATE live_restore_fences SET proposal_json=?6,proposal_candidate_sha256=?7,proposal_frozen_sha256=?8,proposal_point_sha256=?9 WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND relay_database_namespace=?4 AND operation_id=?5 AND proposal_json IS NULL",
        params![b.workspace_id,b.main_version_id,b.object_id,held.namespace,operation.operation_id,json,receipt.candidate_digest,receipt.frozen_state_digest,receipt.point_state_digest]).map_err(write_sql)?;
    if changed != 1 {
        return Err(ApplicationError::Conflict);
    }
    Ok(NativeRestoreProposal {
        receipt,
        candidate_bytes,
        frozen_state_bytes,
        point_state_bytes,
        native_source_bytes,
    })
}

pub(super) fn applied_proposal(
    tx: &Transaction<'_>,
    held: &Registration,
    input: &NativeRestoreApplication,
    max_bytes: usize,
    max_events: usize,
) -> Result<(NativeRestoreProposal, NativeRestoreApplicationReceipt), ApplicationError> {
    input.validate_budget(max_bytes, max_events)?;
    let mut budget = Budget {
        remaining: max_bytes,
    };
    budget.json(&input.admitted)?;
    let receipt =
        application::read_saved(tx, held, &mut budget)?.ok_or(ApplicationError::Conflict)?;
    if receipt.admitted != input.admitted
        || receipt.candidate_digest != input.candidate_digest
        || receipt.native_source_manifest_digest != input.native_source_manifest_digest
    {
        return Err(ApplicationError::Conflict);
    }
    let proposal = prepare_in(tx, held, &input.preparation, budget.remaining, max_events)?;
    Ok((proposal, receipt))
}

fn origin(
    conn: &Connection,
    held: &Registration,
    input: &NativeRestorePreparation,
    budget: &mut Budget,
) -> Result<(String, i64), ApplicationError> {
    let operation = &input.fence.operation;
    let b = &held.binding;
    match &operation.origin {
        RestoreDeliveryOrigin::Bootstrap { id } => {
            let (bootstrap, binding, coordinate, sequence) =
                bootstrap::read_bootstrap(conn, held)?.ok_or(ApplicationError::Conflict)?;
            bootstrap.validate()?;
            if bootstrap.bootstrap_id != *id
                || binding != *b
                || coordinate.host_id != operation.host_id
                || bootstrap.baseline_digest != b.lineage_claim_id
            {
                return Err(ApplicationError::Conflict);
            }
            Ok((hex_sha256(&budget.json(&bootstrap)?), sequence))
        }
        RestoreDeliveryOrigin::Owner { id } => {
            let saved: (String,String,i64,String) = conn.query_row(
                "SELECT evidence_digest,binding_json,local_ydoc_sequence,host_coordinate_json FROM live_owner_adoptions WHERE relay_database_namespace=?1 AND adoption_id=?2 AND workspace_id=?3 AND main_version_id=?4 AND object_id=?5 AND lineage_claim_id=?6",
                params![held.namespace,id,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],
                |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(read_sql)?.ok_or(ApplicationError::Conflict)?;
            let binding: LiveObjectBinding =
                serde_json::from_str(&saved.1).map_err(|_| ApplicationError::Corrupt)?;
            let host: ApplicationHostCoordinate =
                serde_json::from_str(&saved.3).map_err(|_| ApplicationError::Corrupt)?;
            if binding != *b || host.host_id != operation.host_id {
                return Err(ApplicationError::Conflict);
            }
            digest(&saved.0)?;
            integer(saved.2, 0, SAFE)?;
            budget.charge(saved.0.len() + saved.1.len() + saved.3.len())?;
            Ok((saved.0, saved.2))
        }
    }
}

fn verify_candidate(
    doc: &Ydoc,
    candidate: &[u8],
    point_bytes: &[u8],
    receipt: &NativeRestoreProposalReceipt,
    budget: &mut Budget,
) -> Result<(), ApplicationError> {
    if hex_sha256(candidate) != receipt.candidate_digest
        || hex_sha256(point_bytes) != receipt.point_state_digest
        || doc.encode_state_vector() != receipt.before_state_vector
    {
        return Err(ApplicationError::Corrupt);
    }
    let point = Ydoc::wire();
    point.apply(point_bytes)?;
    let point_projection = point.project(ContentKind::Richdoc)?.content;
    let source = point
        .preserved_markdown_source(&point_projection)
        .unwrap_or_else(|| point_projection.clone());
    let before = doc.state_vector();
    doc.apply(candidate)?;
    let projection = doc.project(ContentKind::Richdoc)?.content;
    let final_bytes = budget.state(doc)?;
    doc.validate_public_baseline(&final_bytes)?;
    let mut ranges = Vec::new();
    for (&client, &end) in doc.state_vector().iter() {
        let start = before.get(&client);
        if end > start {
            if start != 0 {
                return Err(ApplicationError::Corrupt);
            }
            ranges.push(LiveUpdateStructRange {
                client_id: i64::try_from(client.get()).map_err(|_| ApplicationError::Corrupt)?,
                start_clock: 0,
                end_clock: i64::from(end),
            });
        }
    }
    ranges.sort_by_key(|range| range.client_id);
    if ranges.is_empty() || ranges != receipt.replacement_ranges {
        return Err(ApplicationError::Corrupt);
    }
    let mut actual = doc.canonical_content();
    let mut expected = point.canonical_content();
    actual
        .as_object_mut()
        .ok_or(ApplicationError::Corrupt)?
        .remove("meta");
    expected
        .as_object_mut()
        .ok_or(ApplicationError::Corrupt)?
        .remove("meta");
    if doc.has_missing_updates()
        || actual != expected
        || projection != point_projection
        || doc.preserved_markdown_source(&projection).as_deref() != Some(source.as_str())
        || hex_sha256(source.as_bytes()) != receipt.point.markdown_digest
        || hex_sha256(projection.as_bytes()) != receipt.point.projection_digest
        || doc.canonical_content_sha256() != receipt.final_content_digest
        || doc.encode_state_vector() != receipt.after_state_vector
    {
        return Err(invalid(
            "restore candidate does not reproduce the verified point",
        ));
    }
    Ok(())
}
