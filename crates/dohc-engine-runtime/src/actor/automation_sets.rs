use super::ydoc::{
    SettlementKind, journal_ydoc_append_in_tx, ydoc_settle_disk_preimage, ydoc_settlement_in_tx,
};
use super::{ActorHandle, materialization::SelfWriteRecorder};
use crate::error::RuntimeError;
use dohc_engine_collab::{ContentKind, DocKey, LeaseRegistry, WriterDocCache};
use dohc_engine_domain::automation_sets::*;
use dohc_engine_domain::{
    ChangeActorKind, ChangeAttribution, DomainError, select_snapshot_by_path_in_tx,
};
use dohc_engine_storage::{EngineStore, FaultInjector, NoFaults, StorageError, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use tokio_util::sync::CancellationToken;

fn invalid(reason: &'static str) -> RuntimeError {
    DomainError::InvalidInput { reason }.into()
}

fn active_version(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<(), RuntimeError> {
    let active = dohc_engine_domain::collections::active_version_id(conn, workspace_id)?;
    if active != version_id {
        return Err(invalid("automation-set-batch-version-stale"));
    }
    Ok(())
}

/// Resolve Collection identity and record membership through the current schema object.
fn binding(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    record: &SetBatchRecord,
) -> Result<Option<(SetBatchBinding, String)>, RuntimeError> {
    let row: Option<(String, String, String, String)> = conn.query_row(
        "SELECT r.object_id,r.file_path,s.blob_sha256,h.blob_sha256 FROM collections c \
        JOIN snapshots s ON s.workspace_id=c.workspace_id AND s.version_id=c.version_id AND s.path=c.schema_path \
        JOIN collection_records r ON r.workspace_id=c.workspace_id AND r.version_id=c.version_id AND r.collection_path=c.collection_path \
        JOIN snapshots h ON h.workspace_id=r.workspace_id AND h.version_id=r.version_id AND h.path=r.file_path AND h.object_id=r.object_id \
        WHERE c.workspace_id=?1 AND c.version_id=?2 AND s.object_id=?3 AND r.record_id=?4 AND r.adoption_state='adopted'",
        params![workspace_id,version_id,record.collection_id,record.record_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(StorageError::corrupt_public)?;
    row.map(|(object_id, path, schema_sha256, head_sha256)| {
        let key = DocKey::new(workspace_id, version_id, &object_id)?;
        let lineage_claim_id = dohc_engine_collab::read_marker_in(conn, &key)?
            .and_then(|marker| marker.lineage_claim_id);
        Ok((
            SetBatchBinding {
                object_id,
                lineage_claim_id,
                restore_generation:
                    dohc_engine_collab::live_update_application::restore_generation(conn, &key)?,
                schema_sha256,
                head_sha256,
            },
            path,
        ))
    })
    .transpose()
}

impl ActorHandle {
    pub async fn prepare_set_batch(
        &self,
        workspace_id: String,
        mut plan: SetBatchPlan,
        leases: LeaseRegistry,
    ) -> Result<(SetBatchPlan, String, Vec<bool>), RuntimeError> {
        self.run(move |store, _| {
            plan.validate()?;
            if plan.version_id.is_empty() {
                plan.version_id = store.read_with(|conn| {
                    dohc_engine_domain::collections::active_version_id(conn, &workspace_id)
                })?;
            }
            let open = store.read_with(|conn| {
                active_version(conn, &workspace_id, &plan.version_id)?;
                if admitted_set_claim(conn, &workspace_id, &plan.key)?.is_none() {
                    return Err(invalid("automation-set-batch-retired"));
                }
                let mut open = Vec::new();
                for record in &mut plan.records {
                    record.binding = binding(conn, &workspace_id, &plan.version_id, record)?
                        .map(|(guard, _)| guard);
                    open.push(match &record.binding {
                        Some(guard) => {
                            let key =
                                DocKey::new(&workspace_id, &plan.version_id, &guard.object_id)?;
                            leases.is_held(&key)
                                || conn.query_row("SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)", params![key.workspace_id,key.version_id,key.object_id], |row| row.get::<_,bool>(0)).map_err(StorageError::corrupt_public)?
                                || dohc_engine_collab::owner_outbox::has_adopted_owner_in(
                                    conn, &key,
                                )?
                                || dohc_engine_collab::live_update_application::restore_generation(
                                    conn, &key,
                                )?
                                .is_some()
                        }
                        None => false,
                    });
                }
                Ok::<_, RuntimeError>(open)
            })?;
            let digest = plan.digest()?;
            Ok((plan, digest, open))
        })
        .await
    }

    pub async fn lookup_set_batch(
        &self,
        workspace_id: String,
        key: SetBatchKey,
        digest: String,
        now_ms: i64,
    ) -> Result<SetBatchLookup, RuntimeError> {
        self.run(move |store, _| {
            match store.write_full_with(&NoFaults, |tx| {
                fence_set_receipt_in_tx(tx, &workspace_id, &key, &digest, now_ms)
            })? {
                TxnOutcome::Committed(receipt) => Ok(receipt),
                TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
            }
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn set_fields_batch(
        &self,
        workspace_id: String,
        root: PathBuf,
        plan: SetBatchPlan,
        digest: String,
        attribution: ChangeAttribution,
        leases: LeaseRegistry,
        token: CancellationToken,
        now_ms: i64,
        self_writes: Arc<dyn SelfWriteRecorder>,
    ) -> Result<
        (
            SetBatchReceipt,
            Vec<dohc_engine_domain::AutomationClaim>,
            Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
        ),
        RuntimeError,
    > {
        self.run(move |store, cache| {
            set_fields_batch_on_store(
                store,
                cache,
                &workspace_id,
                &root,
                &plan,
                &digest,
                attribution,
                &leases,
                &token,
                now_ms,
                &NoFaults,
                self_writes.as_ref(),
            )
        })
        .await
    }

    /// One final wait, yielding the writer between each file placement.
    pub async fn wait_set_batches(
        &self,
        workspace_id: String,
        root: PathBuf,
        receipts: Vec<(SetBatchKey, String)>,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
    ) -> Result<(), RuntimeError> {
        let mut jobs = Vec::new();
        for (key, digest) in receipts {
            match self
                .lookup_set_batch(workspace_id.clone(), key, digest, now_ms)
                .await?
            {
                SetBatchLookup::Committed { receipt } => jobs.extend(receipt.jobs),
                SetBatchLookup::Abandoned => {}
                SetBatchLookup::Retired => return Err(invalid("automation-set-batch-retired")),
            }
        }
        let mut seen = std::collections::HashSet::new();
        jobs.retain(|job| seen.insert(job.clone()));
        for job_id in jobs {
            let workspace_id = workspace_id.clone();
            let root = root.clone();
            let self_writes = self_writes.clone();
            self.run(move |store, _| {
                if !super::materialization::materialize_expected_job(
                    store,
                    &root,
                    &workspace_id,
                    &job_id,
                    self_writes.as_ref(),
                    now_ms,
                    &NoFaults,
                ) {
                    return Err(invalid("automation-set-batch-files-unplaced"));
                }
                Ok(())
            })
            .await?;
        }
        self.run(move |store, _| {
            super::materialization::reconcile_settlement_attempts(
                store,
                &workspace_id,
                now_ms,
                &NoFaults,
            )
        })
        .await
    }
}

#[allow(clippy::too_many_arguments)]
fn set_fields_batch_on_store(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    workspace_id: &str,
    root: &Path,
    plan: &SetBatchPlan,
    digest: &str,
    attribution: ChangeAttribution,
    leases: &LeaseRegistry,
    token: &CancellationToken,
    now_ms: i64,
    faults: &dyn FaultInjector,
    self_writes: &dyn SelfWriteRecorder,
) -> Result<
    (
        SetBatchReceipt,
        Vec<dohc_engine_domain::AutomationClaim>,
        Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
    ),
    RuntimeError,
> {
    // Replay precedes person, version, and binding checks. It grants no new write.
    if let Some(found) =
        store.read_with(|conn| read_set_receipt_in_tx(conn, workspace_id, &plan.key, digest))?
    {
        return match found {
            SetBatchLookup::Committed { receipt } => Ok((receipt, Vec::new(), Vec::new())),
            SetBatchLookup::Abandoned => Err(invalid("automation-set-batch-abandoned")),
            SetBatchLookup::Retired => Err(invalid("automation-set-batch-retired")),
        };
    }
    plan.validate()?;
    if plan.digest()? != digest {
        return Err(invalid("automation-set-batch-digest-invalid"));
    }
    attribution.validate().map_err(invalid)?;
    if attribution.actor_kind != ChangeActorKind::Automation
        || attribution
            .run
            .as_ref()
            .is_none_or(|run| run.claim_id != plan.key.claim_id)
    {
        return Err(invalid("automation-set-batch-attribution-invalid"));
    }
    let mut held = Vec::new();
    for record in &plan.records {
        if let Some(guard) = &record.binding {
            held.push(leases.acquire(&DocKey::new(
                workspace_id,
                &plan.version_id,
                &guard.object_id,
            )?)?);
        }
    }
    // An earlier Set may have committed this head without placing its file yet.
    // Place that exact predecessor before validating this batch's disk preimage.
    for record in &plan.records {
        if let Some((_, path)) =
            store.read_with(|conn| binding(conn, workspace_id, &plan.version_id, record))?
        {
            let head = store
                .read_with(|conn| {
                    select_snapshot_by_path_in_tx(conn, workspace_id, &plan.version_id, &path)
                })?
                .snapshot;
            if let Some(head) = head {
                let job = format!("ydoc-mat_{}", head.latest_moment_id);
                if store.load_materialization_job(&job)?.is_some()
                    && !super::materialization::materialize_expected_job(
                        store,
                        root,
                        workspace_id,
                        &job,
                        self_writes,
                        now_ms,
                        faults,
                    )
                {
                    return Err(invalid("automation-set-batch-files-unplaced"));
                }
            }
        }
    }
    let started = Instant::now();
    let outcome = store.write_full_with(faults, |tx| {
        if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
        active_version(tx, workspace_id, &plan.version_id)?;
        let automation_id = admitted_set_claim(tx, workspace_id, &plan.key)?.ok_or_else(|| invalid("automation-set-batch-retired"))?;
        let (state, depth): (String, i64) = tx.query_row("SELECT state,depth FROM automation_claims WHERE workspace_id=?1 AND claim_id=?2", params![workspace_id,plan.key.claim_id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(StorageError::corrupt_public)?;
        if state != "running" || i64::from(attribution.depth) != depth + 1 { return Err(invalid("automation-set-batch-claim-inactive")); }
        let mut receipt = SetBatchReceipt { key: plan.key.clone(), digest: digest.to_owned(), version_id: plan.version_id.clone(),
            attribution: attribution.clone(), records: Vec::new(), jobs: Vec::new(), committed_at_ms: now_ms, writer_ms: 0.0 };
        let mut claims = Vec::new();
        let mut facts = Vec::new();
        let mut state_bytes = 0;
        for record in &plan.records {
            if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
            let current = binding(tx, workspace_id, &plan.version_id, record)?;
            let Some((current_guard, path)) = current else {
                receipt.records.push(SetBatchRecordOutcome { record_id: record.record_id.clone(), path: None, fields: Vec::new() });
                continue;
            };
            if record.binding.as_ref() != Some(&current_guard) { return Err(invalid("automation-set-batch-binding-stale")); }
            let key = DocKey::new(workspace_id, &plan.version_id, &current_guard.object_id)?;
            dohc_engine_collab::owner_outbox::require_ordinary_settlement(tx, &key)?;
            dohc_engine_collab::live_update_application::require_restore_open(tx, &key)?;
            let deferred: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)", params![key.workspace_id,key.version_id,key.object_id], |row| row.get(0)).map_err(StorageError::corrupt_public)?;
            if deferred { return Err(invalid("ydoc-remote-updates-pending")); }
            if dohc_engine_sync::open_sync_conflict_for_object(tx, workspace_id, &plan.version_id, &key.object_id)?.is_some() {
                return Err(invalid("ydoc-conflict-open"));
            }
            if !dohc_engine_collab::author_coverage::reconcile_in(tx, &key, now_ms)? { return Err(invalid("automation-set-batch-files-unplaced")); }
            let head = select_snapshot_by_path_in_tx(tx, workspace_id, &plan.version_id, &path)?.snapshot.ok_or_else(|| invalid("automation-set-batch-binding-stale"))?;
            if let Some((seed, mut appended)) = dohc_engine_collab::seed_closed_record_in_tx(tx, &key, &path, &head.text, &head.blob_sha256, now_ms)? {
                journal_ydoc_append_in_tx(tx, &key, &path, ContentKind::Richdoc, &seed, None, None,
                    Some(dohc_engine_collab::owner_base_source::OwnerSeedSource { moment_id: head.latest_moment_id.clone(), blob_sha256: head.blob_sha256.clone() }),
                    false, now_ms, &mut appended, &dohc_engine_storage::hex_sha256(&seed))?;
            }
            let doc = dohc_engine_collab::load_doc_in(tx, &key)?;
            if doc.has_pending_dependencies() { return Err(dohc_engine_collab::CollabError::MissingDependencies.into()); }
            state_bytes += doc.encode_full_state().len();
            if state_bytes > if plan.records.len() == 1 { dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES } else { MAX_SET_BATCH_STATE } { return Err(invalid("automation-set-batch-oversized")); }
            let mut fields = Vec::new();
            let initial_vector = doc.encode_state_vector();
            let mut changed = false;
            for field in &record.fields {
                let before = doc.frontmatter_json().get(&field.field).cloned().unwrap_or(serde_json::Value::Null);
                if dohc_engine_domain::collections::collection_values_equal(&before, &field.after) {
                    fields.push(SetBatchFieldOutcome::Unchanged { field: field.field.clone() });
                } else if !dohc_engine_domain::collections::collection_values_equal(&before, &field.before) {
                    fields.push(SetBatchFieldOutcome::Kept { field: field.field.clone(), current: before });
                } else {
                    doc.frontmatter_set_value(&field.field, field.after.clone())?;
                    let history_id = 0;
                    fields.push(SetBatchFieldOutcome::Changed { field: field.field.clone(), before, after: field.after.clone(), history_id });
                    changed = true;
                }
            }
            if changed {
                let update = doc.diff(&initial_vector)?;
                let mut appended = dohc_engine_collab::record_update_in_tx(tx, &key, &update, Some(&automation_id), Some(&attribution), now_ms)?;
                let (_, new_claims) = journal_ydoc_append_in_tx(tx, &key, &path, ContentKind::Richdoc, &update,
                    Some(automation_id.clone()), Some(attribution.clone()), None, true, now_ms, &mut appended, &dohc_engine_storage::hex_sha256(&update))?;
                claims.extend(new_claims);
                facts.extend(appended.record_facts);
                for field in &mut fields {
                    if let SetBatchFieldOutcome::Changed { field, history_id, .. } = field {
                        *history_id = tx.query_row("SELECT max(history_id) FROM collection_field_history WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3 AND field_name=?4",
                            params![workspace_id,plan.version_id,record.record_id,field.as_str()], |row| row.get(0)).map_err(StorageError::corrupt_public)?;
                    }
                }
                let projection = doc.project(ContentKind::Richdoc)?;
                let expected = Some(head.blob_sha256);
                let preimage = ydoc_settle_disk_preimage(root, &path, expected.as_deref(), &dohc_engine_storage::hex_sha256(projection.content.as_bytes()))?;
                let (write, _) = ydoc_settlement_in_tx(tx, root, &key, &path, ContentKind::Richdoc, projection.content,
                    &projection.source_state_vector_sha256, &expected, &preimage, false, &format!("set-batch/{}", plan.key.batch),
                    None, None, false, SettlementKind::Document, now_ms)?;
                receipt.jobs.push(format!("ydoc-mat_{}", write.moment.moment_id));
            }
            receipt.records.push(SetBatchRecordOutcome { record_id: record.record_id.clone(), path: Some(path), fields });
        }
        receipt.writer_ms = started.elapsed().as_secs_f64() * 1000.0;
        save_set_receipt_in_tx(tx, workspace_id, &receipt)?;
        if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
        Ok::<_, RuntimeError>((receipt, claims, facts))
    });
    // This path never mutates cache entries speculatively. Remove only its own stale bases.
    for record in &plan.records {
        if let Some(guard) = &record.binding {
            cache.remove(&DocKey::new(
                workspace_id,
                &plan.version_id,
                &guard.object_id,
            )?);
        }
    }
    match outcome? {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_domain::{AutomationSettle, VersionedTextStore, WriteText};
    use dohc_engine_storage::{FaultAction, FaultPoint};
    use dohc_engine_testkit::{ScratchDir, engine_db_path};
    use serde_json::json;

    const WS: &str = "batch-workspace";
    const CLAIM: &str = "batch-claim";
    struct CrashAt(FaultPoint);
    impl FaultInjector for CrashAt {
        fn poll(&self, point: FaultPoint) -> FaultAction {
            if point == self.0 {
                FaultAction::Crash
            } else {
                FaultAction::Continue
            }
        }
    }
    fn author() -> ChangeAttribution {
        serde_json::from_value(json!({"actorKind":"automation","depth":1,"run":{"claimId":CLAIM,"automationName":"Stamp"}})).unwrap()
    }
    fn fixture(count: usize) -> (ScratchDir, EngineStore, SetBatchPlan) {
        let scratch = ScratchDir::new().unwrap();
        let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
        super::super::versions::ensure_mutation_version_on_store(
            &mut store, WS, "main", 1, &NoFaults,
        )
        .unwrap();
        std::fs::create_dir_all(scratch.path().join("tasks")).unwrap();
        let write = |store: &mut EngineStore, object: &str, path: &str, text: &str| {
            VersionedTextStore::new(store)
                .write_text(
                    &WriteText {
                        workspace_id: WS.into(),
                        version_id: "main".into(),
                        object_id: object.into(),
                        path: path.into(),
                        text: text.into(),
                        moment_id: format!("fixture-{object}"),
                        metadata_origin: "test".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 1,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
            std::fs::write(scratch.path().join(path), text).unwrap();
        };
        write(
            &mut store,
            "schema",
            "tasks/collection.yaml",
            "fields:\n  Status:\n    type: text\n  Count:\n    type: number\n",
        );
        let mut records = Vec::new();
        for index in 0..count {
            let record_id = format!(
                "rec_{}{}{}",
                "a".repeat(24),
                char::from(b'a' + (index / 26) as u8),
                char::from(b'a' + (index % 26) as u8)
            );
            let path = format!("tasks/{index}.md");
            write(
                &mut store,
                &format!("object-{index}"),
                &path,
                &format!("---\nid: {record_id}\nStatus: open\nCount: 1\n---\n\nBody {index}\n"),
            );
            records.push(SetBatchRecord {
                collection_id: "schema".into(),
                record_id,
                fields: vec![
                    SetBatchField {
                        field: "Status".into(),
                        before: json!("open"),
                        after: json!("done"),
                    },
                    SetBatchField {
                        field: "Count".into(),
                        before: json!(1),
                        after: json!(2),
                    },
                ],
                binding: None,
            });
        }
        store.write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, WS, "main")?;
            tx.execute("UPDATE collection_records SET adoption_state='adopted' WHERE workspace_id=?1", [WS]).map_err(StorageError::persist_public)?;
            tx.execute("INSERT INTO automation_claims(workspace_id,claim_id,automation_id,trigger_key,collection_path,depth,state,created_at_ms,updated_at_ms,change_kind) VALUES(?1,?2,'collection:schema#stamp','run-now:fixture','tasks',0,'running',1,1,'schedule')",params![WS,CLAIM]).map_err(StorageError::persist_public)?;
            Ok::<_, DomainError>(())
        }).unwrap();
        let mut plan = SetBatchPlan {
            key: SetBatchKey {
                claim_id: CLAIM.into(),
                key_seed: "seed".into(),
                step: 1,
                batch: "0".into(),
            },
            version_id: "main".into(),
            records,
        };
        store
            .read_with(|conn| {
                for record in &mut plan.records {
                    record.binding = binding(conn, WS, "main", record)?.map(|(guard, _)| guard);
                }
                Ok::<_, RuntimeError>(())
            })
            .unwrap();
        (scratch, store, plan)
    }
    fn submit(
        store: &mut EngineStore,
        root: &Path,
        plan: &SetBatchPlan,
        faults: &dyn FaultInjector,
    ) -> Result<SetBatchReceipt, RuntimeError> {
        set_fields_batch_on_store(
            store,
            &mut WriterDocCache::new(),
            WS,
            root,
            plan,
            &plan.digest().unwrap(),
            author(),
            &LeaseRegistry::new(),
            &CancellationToken::new(),
            2,
            faults,
            &(),
        )
        .map(|(receipt, _, _)| receipt)
    }
    fn changes(store: &EngineStore) -> i64 {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT count(*) FROM collection_field_history WHERE automation_claim_id=?1",
                    [CLAIM],
                    |row| row.get(0),
                )
            })
            .unwrap()
    }
    fn place(store: &mut EngineStore, root: &Path, receipt: &SetBatchReceipt) {
        for job in &receipt.jobs {
            assert!(super::super::materialization::materialize_expected_job(
                store,
                root,
                WS,
                job,
                &(),
                3,
                &NoFaults,
            ));
        }
        super::super::materialization::reconcile_settlement_attempts(store, WS, 3, &NoFaults)
            .unwrap();
    }

    #[test]
    fn stale_object_lineage_restore_head_and_attribution_are_refused() {
        for changed_guard in 0..4 {
            let (scratch, mut store, mut plan) = fixture(1);
            let guard = plan.records[0].binding.as_mut().unwrap();
            match changed_guard {
                0 => guard.object_id = "other-object".into(),
                1 => guard.lineage_claim_id = Some("other-lineage".into()),
                2 => guard.restore_generation = Some(1),
                _ => guard.head_sha256 = "stale-head".into(),
            }
            assert!(submit(&mut store, scratch.path(), &plan, &NoFaults).is_err());
            assert_eq!(changes(&store), 0);
        }
        let (scratch, mut store, plan) = fixture(1);
        let mut wrong = author();
        wrong.run.as_mut().unwrap().claim_id = "other-claim".into();
        assert!(
            set_fields_batch_on_store(
                &mut store,
                &mut WriterDocCache::new(),
                WS,
                scratch.path(),
                &plan,
                &plan.digest().unwrap(),
                wrong,
                &LeaseRegistry::new(),
                &CancellationToken::new(),
                2,
                &NoFaults,
                &()
            )
            .is_err()
        );
        assert_eq!(changes(&store), 0);
    }

    #[test]
    fn a_second_set_places_its_predecessor_and_remains_exactly_once() {
        let (scratch, mut store, mut plan) = fixture(1);
        let first = submit(&mut store, scratch.path(), &plan, &NoFaults).unwrap();
        plan.key.batch = "second".into();
        plan.records[0].fields[0].before = json!("done");
        plan.records[0].fields[0].after = json!("reviewed");
        plan.records[0].fields[1].before = json!(2);
        plan.records[0].fields[1].after = json!(3);
        plan.records[0].binding = store
            .read_with(|conn| binding(conn, WS, "main", &plan.records[0]))
            .unwrap()
            .map(|(guard, _)| guard);
        let second = submit(&mut store, scratch.path(), &plan, &NoFaults).unwrap();
        place(&mut store, scratch.path(), &first);
        place(&mut store, scratch.path(), &second);
        assert!(
            std::fs::read_to_string(scratch.path().join("tasks/0.md"))
                .unwrap()
                .contains("reviewed")
        );
        assert_eq!(changes(&store), 4);
        assert_eq!(
            submit(&mut store, scratch.path(), &plan, &NoFaults).unwrap(),
            second
        );
    }

    #[test]
    fn cancellation_inactive_claim_and_receipt_failure_commit_nothing() {
        let (scratch, mut store, plan) = fixture(2);
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(
            set_fields_batch_on_store(
                &mut store,
                &mut WriterDocCache::new(),
                WS,
                scratch.path(),
                &plan,
                &plan.digest().unwrap(),
                author(),
                &LeaseRegistry::new(),
                &cancelled,
                2,
                &NoFaults,
                &(),
            )
            .is_err()
        );
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE automation_claims SET state='done'", [])
                    .map_err(StorageError::persist_public)
            })
            .unwrap();
        assert!(
            submit(&mut store, scratch.path(), &plan, &NoFaults)
                .unwrap_err()
                .to_string()
                .contains("claim-inactive")
        );
        store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE automation_claims SET state='running'", []).map_err(StorageError::persist_public)?;
            tx.execute_batch("CREATE TRIGGER refuse_receipt BEFORE INSERT ON automation_set_batch_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END").map_err(StorageError::persist_public)
        }).unwrap();
        assert!(submit(&mut store, scratch.path(), &plan, &NoFaults).is_err());
        assert_eq!(changes(&store), 0);
        assert!(
            store
                .read_with(|conn| read_set_receipt_in_tx(
                    conn,
                    WS,
                    &plan.key,
                    &plan.digest().unwrap()
                ))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn fenced_absence_abandons_the_key_and_retirement_never_looks_absent() {
        let (scratch, mut store, plan) = fixture(4);
        let digest = plan.digest().unwrap();
        let found = store
            .write_full_with(&NoFaults, |tx| {
                fence_set_receipt_in_tx(tx, WS, &plan.key, &digest, 2)
            })
            .unwrap();
        assert!(matches!(
            found,
            TxnOutcome::Committed(SetBatchLookup::Abandoned)
        ));
        assert!(
            submit(&mut store, scratch.path(), &plan, &NoFaults)
                .unwrap_err()
                .to_string()
                .contains("abandoned")
        );
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE automation_claims SET expired=1", [])
                    .map_err(StorageError::persist_public)
            })
            .unwrap();
        assert_eq!(
            store
                .read_with(|conn| read_set_receipt_in_tx(conn, WS, &plan.key, &digest))
                .unwrap(),
            Some(SetBatchLookup::Retired)
        );
        let mut unknown = plan.key.clone();
        unknown.claim_id = "unknown".into();
        assert_eq!(
            store
                .read_with(|conn| fence_set_receipt_in_tx(conn, WS, &unknown, &digest, 3))
                .unwrap(),
            SetBatchLookup::Retired
        );
        assert_eq!(changes(&store), 0);
        assert_eq!(store.synchronous_setting().unwrap(), 1);
    }

    #[test]
    fn whole_batch_rolls_back_at_each_stale_record_and_before_persist() {
        for index in 0..4 {
            let (scratch, mut store, mut plan) = fixture(4);
            plan.records[index].binding.as_mut().unwrap().schema_sha256 = "stale".into();
            assert!(submit(&mut store, scratch.path(), &plan, &NoFaults).is_err());
            assert_eq!(changes(&store), 0);
            assert!(
                store
                    .read_with(|conn| read_set_receipt_in_tx(
                        conn,
                        WS,
                        &plan.key,
                        &plan.digest().unwrap()
                    ))
                    .unwrap()
                    .is_none()
            );
        }
        let (scratch, mut store, plan) = fixture(4);
        assert!(
            submit(
                &mut store,
                scratch.path(),
                &plan,
                &CrashAt(FaultPoint::StorageBeforePersist)
            )
            .is_err()
        );
        assert_eq!(changes(&store), 0);
        let receipt = submit(&mut store, scratch.path(), &plan, &NoFaults).unwrap();
        assert_eq!(receipt.records.len(), 4);
        assert_eq!(changes(&store), 8);
        assert_eq!(store.synchronous_setting().unwrap(), 1);
    }

    #[test]
    fn committed_batches_publish_record_facts_and_replays_do_not() {
        let (scratch, mut store, plan) = fixture(4);
        let mut apply = || {
            set_fields_batch_on_store(
                &mut store,
                &mut WriterDocCache::new(),
                WS,
                scratch.path(),
                &plan,
                &plan.digest().unwrap(),
                author(),
                &LeaseRegistry::new(),
                &CancellationToken::new(),
                2,
                &NoFaults,
                &(),
            )
            .unwrap()
        };
        let (first, _, facts) = apply();
        assert_eq!(facts.len(), 4);
        assert!(facts.iter().all(
            |record| record.fields.len() == 2 && record.attribution.as_ref() == Some(&author())
        ));
        let (replayed, claims, facts) = apply();
        assert_eq!(first, replayed);
        assert!(claims.is_empty());
        assert!(facts.is_empty());
    }

    #[test]
    fn fifty_record_run_restarts_mid_batch_and_recovers_every_record_once() {
        let (scratch, mut store, whole) = fixture(50);
        let mut receipts = Vec::new();
        for (index, records) in whole.records.chunks(4).enumerate() {
            let mut plan = whole.clone();
            plan.records = records.to_vec();
            plan.key.batch = index.to_string();
            let receipt = if index == 3 {
                assert!(
                    submit(
                        &mut store,
                        scratch.path(),
                        &plan,
                        &CrashAt(FaultPoint::StorageAfterCommitBeforeAck)
                    )
                    .is_err()
                );
                drop(store);
                store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 3).unwrap();
                let receipt = submit(&mut store, scratch.path(), &plan, &NoFaults).unwrap();
                // A later caller's person cannot relabel a committed receipt.
                let mut changed_author = author();
                changed_author.on_behalf_of = Some("other-person".into());
                let replay = set_fields_batch_on_store(
                    &mut store,
                    &mut WriterDocCache::new(),
                    WS,
                    scratch.path(),
                    &plan,
                    &plan.digest().unwrap(),
                    changed_author,
                    &LeaseRegistry::new(),
                    &CancellationToken::new(),
                    4,
                    &NoFaults,
                    &(),
                )
                .unwrap()
                .0;
                assert_eq!(receipt, replay);
                receipt
            } else {
                submit(&mut store, scratch.path(), &plan, &NoFaults).unwrap()
            };
            receipts.push(receipt);
        }
        assert_eq!(changes(&store), 100);
        for receipt in &receipts {
            place(&mut store, scratch.path(), receipt);
        }
        drop(store);
        store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 5).unwrap();
        for receipt in receipts {
            assert_eq!(
                store
                    .read_with(|conn| fence_set_receipt_in_tx(
                        conn,
                        WS,
                        &receipt.key,
                        &receipt.digest,
                        5
                    ))
                    .unwrap(),
                SetBatchLookup::Committed {
                    receipt: receipt.clone()
                }
            );
            place(&mut store, scratch.path(), &receipt);
        }
        assert_eq!(changes(&store), 100);
        for index in 0..50 {
            let text =
                std::fs::read_to_string(scratch.path().join(format!("tasks/{index}.md"))).unwrap();
            assert!(
                text.contains("Status: done")
                    && text.contains("Count: 2")
                    && text.contains(&format!("Body {index}"))
            );
        }
    }

    #[test]
    fn field_conflicts_are_local_and_equal_values_without_receipts_are_unchanged() {
        let (scratch, mut store, mut plan) = fixture(1);
        plan.records[0].fields[0].before = json!("somebody else");
        plan.records[0].fields[1].after = json!(1.0);
        let receipt = submit(&mut store, scratch.path(), &plan, &NoFaults).unwrap();
        assert!(matches!(
            receipt.records[0].fields[0],
            SetBatchFieldOutcome::Kept { .. }
        ));
        assert!(matches!(
            receipt.records[0].fields[1],
            SetBatchFieldOutcome::Unchanged { .. }
        ));
        assert_eq!(changes(&store), 0);
        assert!(receipt.jobs.is_empty());
    }

    #[test]
    fn live_lease_refuses_mutation_and_oversize_has_no_receipt() {
        let (scratch, mut store, plan) = fixture(4);
        let leases = LeaseRegistry::new();
        let _held = leases
            .acquire(&DocKey::new(WS, "main", "object-2").unwrap())
            .unwrap();
        assert!(
            set_fields_batch_on_store(
                &mut store,
                &mut WriterDocCache::new(),
                WS,
                scratch.path(),
                &plan,
                &plan.digest().unwrap(),
                author(),
                &leases,
                &CancellationToken::new(),
                2,
                &NoFaults,
                &(),
            )
            .is_err()
        );
        assert_eq!(changes(&store), 0);
        let mut oversized = plan.clone();
        oversized.records = vec![plan.records[0].clone(); 9];
        assert!(
            submit(&mut store, scratch.path(), &oversized, &NoFaults)
                .unwrap_err()
                .to_string()
                .contains("oversized")
        );
        assert!(
            store
                .read_with(|conn| read_set_receipt_in_tx(
                    conn,
                    WS,
                    &oversized.key,
                    &oversized.digest().unwrap()
                ))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn pruning_retires_receipts_but_preserves_unfinished_undo_and_placement() {
        let (scratch, mut store, plan) = fixture(1);
        let receipt = submit(&mut store, scratch.path(), &plan, &NoFaults).unwrap();
        dohc_engine_domain::settle_automation_claim(
            &mut store,
            WS,
            CLAIM,
            &AutomationSettle::Done,
            4,
            &NoFaults,
        )
        .unwrap();
        let now = 4 + dohc_engine_domain::AUTOMATION_HISTORY_RETENTION_MS + 1;
        assert_eq!(
            dohc_engine_domain::prune_automation_history(&mut store, WS, &[], now, &NoFaults)
                .unwrap()
                .pruned,
            0
        );
        place(&mut store, scratch.path(), &receipt);
        assert_eq!(
            dohc_engine_domain::prune_automation_history(
                &mut store,
                WS,
                &[CLAIM.into()],
                now,
                &NoFaults,
            )
            .unwrap()
            .pruned,
            0
        );
        assert_eq!(
            dohc_engine_domain::prune_automation_history(&mut store, WS, &[], now, &NoFaults)
                .unwrap()
                .pruned,
            1
        );
        assert_eq!(
            store
                .read_with(|conn| read_set_receipt_in_tx(
                    conn,
                    WS,
                    &plan.key,
                    &plan.digest().unwrap()
                ))
                .unwrap(),
            Some(SetBatchLookup::Retired)
        );
        assert_eq!(
            store
                .read_with(|conn| conn.query_row(
                    "SELECT count(*) FROM automation_set_batch_receipts",
                    [],
                    |row| row.get::<_, i64>(0)
                ))
                .unwrap(),
            0
        );
    }
}
