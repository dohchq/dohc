use super::*;
use crate::{ContentKind, Ydoc};
use dohc_engine_domain::{write_text_in_tx, DomainError, WriteResult, WriteText};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveApplicationBootstrap {
    pub bootstrap_id: String,
    pub bootstrap_moment_id: String,
    #[serde(deserialize_with = "wire_integer")]
    pub baseline_moment_relay_sequence: i64,
    #[serde(deserialize_with = "wire_integer")]
    pub baseline_registered_at_ms: i64,
    pub baseline_digest: String,
    #[serde(deserialize_with = "wire_integer")]
    pub baseline_byte_length: i64,
    pub projected_markdown_digest: String,
    #[serde(deserialize_with = "wire_integer")]
    pub projected_markdown_byte_length: i64,
}

impl LiveApplicationBootstrap {
    pub fn validate(&self) -> Result<(), ApplicationError> {
        identifier(&self.bootstrap_id, 512)?;
        identifier(&self.bootstrap_moment_id, 512)?;
        integer(self.baseline_moment_relay_sequence, 0, SAFE)?;
        integer(self.baseline_registered_at_ms, 0, SAFE)?;
        integer(
            self.baseline_byte_length,
            2,
            crate::limits::MAX_YDOC_UPDATE_BYTES as i64,
        )?;
        integer(
            self.projected_markdown_byte_length,
            0,
            dohc_engine_domain::MAX_TEXT_BYTES as i64,
        )?;
        digest(&self.baseline_digest)?;
        digest(&self.projected_markdown_digest)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveApplicationBootstrapAck {
    pub bootstrap_id: String,
    pub bootstrap_moment_id: String,
    pub baseline_digest: String,
    pub baseline_moment_relay_sequence: i64,
    #[serde(rename = "localYDocSequence")]
    pub local_ydoc_sequence: i64,
    pub bootstrap_replayed: bool,
}

impl LiveApplicationBootstrapAck {
    fn new(input: &LiveApplicationBootstrap, sequence: i64, replayed: bool) -> Self {
        Self {
            bootstrap_id: input.bootstrap_id.clone(),
            bootstrap_moment_id: input.bootstrap_moment_id.clone(),
            baseline_digest: input.baseline_digest.clone(),
            baseline_moment_relay_sequence: input.baseline_moment_relay_sequence,
            local_ydoc_sequence: sequence,
            bootstrap_replayed: replayed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootstrapResult {
    Bootstrapped(LiveApplicationBootstrapAck),
    Pending(ApplicationPending),
}

/// Commit the original baseline, domain object, and bootstrap audit together.
/// The actor supplies its search-index update inside this transaction. This
/// acknowledgement does not assert filesystem materialization or settlement.
pub fn bootstrap_committed<E>(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    handle: &ApplicationHandle,
    input: LiveApplicationBootstrap,
    bytes: Vec<u8>,
    faults: &dyn FaultInjector,
    follow_up: impl FnOnce(&Transaction<'_>, &WriteResult, &str, &LiveObjectBinding) -> Result<(), E>,
) -> Result<BootstrapResult, E>
where
    E: From<ApplicationError> + From<StorageError> + From<DomainError>,
{
    input.validate().map_err(E::from)?;
    if bytes.len() as i64 != input.baseline_byte_length
        || hex_sha256(&bytes) != input.baseline_digest
    {
        return Err(E::from(invalid("bootstrap baseline digest or length")));
    }
    let held = handle
        .registration
        .lock()
        .map_err(|_| E::from(ApplicationError::Interrupted))?;
    if !held.live {
        return Ok(BootstrapResult::Pending(
            ApplicationPending::ApplicabilityUnavailable,
        ));
    }
    let binding = &held.binding;
    if binding.lineage_claim_id != input.baseline_digest {
        return Err(E::from(ApplicationError::Conflict));
    }
    let key = DocKey::new(
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )
    .map_err(ApplicationError::from)
    .map_err(E::from)?;
    let mut attempted = false;
    let outcome = store.write_with(faults, |tx| {
        require_workspace(tx, &held).map_err(E::from)?;
        let current = read_binding(tx, &held).map_err(E::from)?;
        if !current.is_some_and(|(binding, coordinate, available)| available && binding == held.binding && coordinate == held.coordinate) {
            return Ok(BootstrapResult::Pending(ApplicationPending::ApplicabilityUnavailable));
        }
        if let Some((original, retained_binding, coordinate, sequence)) = read_bootstrap(tx, &held).map_err(E::from)? {
            original.validate().map_err(|_| E::from(ApplicationError::Corrupt))?;
            retained_binding.validate_canonical().map_err(|_| E::from(ApplicationError::Corrupt))?;
            coordinate.validate().map_err(|_| E::from(ApplicationError::Corrupt))?;
            if original != input || retained_binding != *binding {
                return Err(E::from(ApplicationError::Conflict));
            }
            let marker = durable::read_marker_in(tx, &key).map_err(ApplicationError::from).map_err(E::from)?.ok_or_else(|| E::from(ApplicationError::Corrupt))?;
            if marker.regime != Regime::Replicated || marker.lineage_claim_id.as_deref() != Some(&input.baseline_digest)
                || marker.lineage_claim_status != durable::LineageClaimStatus::Exact || marker.content_kind != ContentKind::Richdoc
                || marker.path.as_deref() != Some(&binding.current_path) || sequence != 0 || marker.head_update_seq < 0 {
                return Err(E::from(ApplicationError::Corrupt));
            }
            let retained = get_binary_blob(tx, &input.baseline_digest).map_err(E::from)?.ok_or_else(|| E::from(ApplicationError::Corrupt))?;
            if retained != bytes { return Err(E::from(ApplicationError::Corrupt)); }
            let retained_domain: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM moments WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND moment_id=?4 AND path=?5 AND after_blob_sha256=?6 AND after_content_kind='text' AND before_present=1 AND metadata_origin='sync' AND recorded_at_ms=?7)
                    AND EXISTS(SELECT 1 FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND path=?5)",
                params![binding.workspace_id,binding.main_version_id,binding.object_id,input.bootstrap_moment_id,binding.current_path,input.projected_markdown_digest,input.baseline_registered_at_ms], |row| row.get(0)
            ).map_err(read_sql).map_err(E::from)?;
            if !retained_domain { return Err(E::from(ApplicationError::Corrupt)); }
            return Ok(BootstrapResult::Bootstrapped(LiveApplicationBootstrapAck::new(&input, sequence, true)));
        }
        if durable::read_marker_in(tx, &key).map_err(ApplicationError::from).map_err(E::from)?.is_some() {
            return Err(E::from(ApplicationError::Conflict));
        }
        let occupied: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM file_objects WHERE workspace_id=?1 AND object_id=?3)
                OR EXISTS(SELECT 1 FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND (object_id=?3 OR path=?4))
                OR EXISTS(SELECT 1 FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND (object_id=?3 OR path=?4))
                OR EXISTS(SELECT 1 FROM fork_base_snapshots WHERE workspace_id=?1 AND version_id=?2 AND (object_id=?3 OR path=?4))
                OR EXISTS(SELECT 1 FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)
                OR EXISTS(SELECT 1 FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
            params![binding.workspace_id, binding.main_version_id, binding.object_id, binding.current_path], |row| row.get(0)
        ).map_err(read_sql).map_err(E::from)?;
        if occupied { return Err(E::from(ApplicationError::Conflict)); }
        let doc = Ydoc::wire();
        doc.apply(&bytes).map_err(ApplicationError::from).map_err(E::from)?;
        if doc.has_missing_updates() {
            return Ok(BootstrapResult::Pending(ApplicationPending::DependenciesUnresolved));
        }
        doc.validate_public_baseline(&bytes).map_err(ApplicationError::from).map_err(E::from)?;
        let mut projection = doc.project(ContentKind::Richdoc).map_err(ApplicationError::from).map_err(E::from)?;
        projection.content = doc.preserved_markdown_source(&projection.content).unwrap_or(projection.content);
        if projection.content.len() as i64 != input.projected_markdown_byte_length
            || hex_sha256(projection.content.as_bytes()) != input.projected_markdown_digest {
            return Err(E::from(invalid("bootstrap Markdown projection mismatch")));
        }
        attempted = true;
        let written = write_text_in_tx(tx, &WriteText {
            workspace_id: binding.workspace_id.clone(), version_id: binding.main_version_id.clone(),
            object_id: binding.object_id.clone(), path: binding.current_path.clone(), text: projection.content,
            moment_id: input.bootstrap_moment_id.clone(), metadata_origin: "sync".into(),
            metadata_summary: None, metadata_correlation_id: None, author_json: None,
            now_ms: input.baseline_registered_at_ms, request_id: None,
        }).map_err(E::from)?;
        if written.deduped || written.snapshot.object_id != binding.object_id { return Err(E::from(ApplicationError::Conflict)); }
        let claimed = durable::claim_base_in_tx(tx, &key, ContentKind::Richdoc, &bytes, &doc.encode_state_vector(), input.baseline_registered_at_ms)
            .map_err(ApplicationError::from).map_err(E::from)?;
        if !matches!(claimed, durable::ClaimOutcome::Claimed { ref base_snapshot_sha } if base_snapshot_sha == &input.baseline_digest) {
            return Err(E::from(ApplicationError::Conflict));
        }
        tx.execute("UPDATE ydoc_docs SET path=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.current_path]).map_err(write_sql).map_err(E::from)?;
        let marker = durable::read_marker_in(tx, &key).map_err(ApplicationError::from).map_err(E::from)?.ok_or_else(|| E::from(ApplicationError::Corrupt))?;
        if marker.head_update_seq != 0 || marker.lineage_claim_id.as_deref() != Some(&input.baseline_digest) { return Err(E::from(ApplicationError::Corrupt)); }
        insert_bootstrap(tx, &held, &input, marker.head_update_seq).map_err(E::from)?;
        accepted_history::initialize(tx, &held, &bytes).map_err(E::from)?;
        follow_up(tx, &written, &held.namespace, binding)?;
        let readback = read_bootstrap(tx, &held).map_err(E::from)?.ok_or_else(|| E::from(ApplicationError::Corrupt))?;
        if readback != (input.clone(), binding.clone(), held.coordinate.clone(), marker.head_update_seq) { return Err(E::from(ApplicationError::Corrupt)); }
        Ok(BootstrapResult::Bootstrapped(LiveApplicationBootstrapAck::new(&input, marker.head_update_seq, false)))
    });
    if attempted {
        cache.remove(&key);
    }
    match outcome? {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(E::from(ApplicationError::Interrupted)),
    }
}

type BootstrapRecord = (
    LiveApplicationBootstrap,
    LiveObjectBinding,
    ApplicationHostCoordinate,
    i64,
);

pub(super) fn read_bootstrap(
    conn: &Connection,
    held: &Registration,
) -> Result<Option<BootstrapRecord>, ApplicationError> {
    let b = &held.binding;
    conn.query_row("SELECT bootstrap_id,bootstrap_moment_id,baseline_moment_relay_sequence,baseline_registered_at_ms,baseline_digest,baseline_byte_length,projected_markdown_digest,projected_markdown_byte_length,binding_json,host_coordinate_json,local_ydoc_sequence FROM live_device_bootstraps WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5",
        params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id], |row| {
            let binding:String=row.get(8)?;let coordinate:String=row.get(9)?;
            let decode=|index, error:serde_json::Error|rusqlite::Error::FromSqlConversionFailure(index,rusqlite::types::Type::Text,Box::new(error));
            Ok((LiveApplicationBootstrap {bootstrap_id:row.get(0)?,bootstrap_moment_id:row.get(1)?,baseline_moment_relay_sequence:row.get(2)?,baseline_registered_at_ms:row.get(3)?,baseline_digest:row.get(4)?,baseline_byte_length:row.get(5)?,projected_markdown_digest:row.get(6)?,projected_markdown_byte_length:row.get(7)?},serde_json::from_str(&binding).map_err(|e|decode(8,e))?,serde_json::from_str(&coordinate).map_err(|e|decode(9,e))?,row.get(10)?))
        }).optional().map_err(read_sql)
}

fn insert_bootstrap(
    tx: &Transaction<'_>,
    held: &Registration,
    input: &LiveApplicationBootstrap,
    sequence: i64,
) -> Result<(), ApplicationError> {
    let b = &held.binding;
    tx.execute("INSERT INTO live_device_bootstraps VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)", params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,input.bootstrap_id,input.bootstrap_moment_id,serde_json::to_string(b).map_err(|_|ApplicationError::Corrupt)?,input.baseline_digest,input.baseline_byte_length,input.baseline_moment_relay_sequence,input.baseline_registered_at_ms,input.projected_markdown_digest,input.projected_markdown_byte_length,sequence,serde_json::to_string(&held.coordinate).map_err(|_|ApplicationError::Corrupt)?]).map_err(write_sql)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_test_scratch::ScratchDir;

    #[derive(Debug, thiserror::Error)]
    enum Error {
        #[error(transparent)]
        Application(#[from] ApplicationError),
        #[error(transparent)]
        Storage(#[from] StorageError),
        #[error(transparent)]
        Domain(#[from] DomainError),
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        name: String,
        bytes: Vec<u8>,
        markdown: String,
        registration_accepted: bool,
        /// The frontmatter block as written, which the settle must keep.
        #[serde(default)]
        kept_frontmatter: Option<String>,
    }
    fn vectors() -> Vec<Vector> {
        serde_json::from_str(include_str!(
            "../../tests/live-bootstrap-fixtures/live-bootstrap.json"
        ))
        .unwrap()
    }
    fn input(vector: &Vector) -> LiveApplicationBootstrap {
        LiveApplicationBootstrap {
            bootstrap_id: "bootstrap-1".into(),
            bootstrap_moment_id: "bootstrap-moment-1".into(),
            baseline_moment_relay_sequence: 0,
            baseline_registered_at_ms: 100,
            baseline_digest: hex_sha256(&vector.bytes),
            baseline_byte_length: vector.bytes.len() as i64,
            projected_markdown_digest: hex_sha256(vector.markdown.as_bytes()),
            projected_markdown_byte_length: vector.markdown.len() as i64,
        }
    }
    fn fixture(
        vector: &Vector,
    ) -> (
        ScratchDir,
        EngineStore,
        WriterDocCache,
        ApplicationOwner,
        ApplicationHandle,
    ) {
        let dir = ScratchDir::new_named("live-bootstrap").unwrap();
        let mut store = EngineStore::open(&dir.join("engine.db"), 0).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
        let handle = owner
            .register(
                &mut store,
                "relay-A".into(),
                ApplicationHostCoordinate {
                    host_id: "host".into(),
                    host_epoch: 1,
                    instance_id: "instance".into(),
                    connection_id: "connection".into(),
                },
                LiveObjectBinding {
                    workspace_id: "workspace".into(),
                    main_version_id: "main".into(),
                    object_id: "object".into(),
                    lineage_claim_id: hex_sha256(&vector.bytes),
                    current_path: "notes/example.md".into(),
                    selector_paths: vec!["notes/example.md".into()],
                    restore_fence_generation: 0,
                },
            )
            .unwrap();
        (dir, store, WriterDocCache::new(), owner, handle)
    }
    fn run(
        store: &mut EngineStore,
        cache: &mut WriterDocCache,
        handle: &ApplicationHandle,
        vector: &Vector,
        faults: &dyn FaultInjector,
    ) -> Result<BootstrapResult, Error> {
        bootstrap_committed(
            store,
            cache,
            handle,
            input(vector),
            vector.bytes.clone(),
            faults,
            |_, _, _, _| Ok(()),
        )
    }
    fn counts(store: &EngineStore) -> (i64, i64, i64, i64) {
        store.read_with(|conn| conn.query_row("SELECT (SELECT COUNT(*) FROM live_device_bootstraps),(SELECT COUNT(*) FROM moments),(SELECT COUNT(*) FROM ydoc_docs),(SELECT COUNT(*) FROM snapshots)",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))).unwrap()
    }
    fn fence_input(handle: &ApplicationHandle) -> (NativeRestoreFence, ApplicationHostCoordinate) {
        let held = handle.registration.lock().unwrap();
        (
            NativeRestoreFence {
                operation_id: "restore".into(),
                relay_database_namespace: held.namespace.clone(),
                old_binding: held.binding.clone(),
                host_id: held.coordinate.host_id.clone(),
                new_fence: 1,
                origin: RestoreDeliveryOrigin::Bootstrap {
                    id: "bootstrap-1".into(),
                },
                terminal: None,
                applied_sequence: 0,
            },
            held.coordinate.clone(),
        )
    }

    #[test]
    fn restore_fence_stops_bootstrap_writes_and_replays_after_reopen() {
        let vector = vectors()
            .into_iter()
            .find(|v| v.registration_accepted)
            .unwrap();
        let (dir, mut store, mut cache, mut owner, handle) = fixture(&vector);
        run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap();
        let (input, coordinate) = fence_input(&handle);
        let before = counts(&store);
        let receipt = owner
            .fence_restore(
                &mut store,
                input.clone(),
                coordinate.clone(),
                200,
                &NoFaults,
            )
            .unwrap();
        assert_eq!(receipt.local_head_sequence, 0);
        assert_eq!(counts(&store), before);
        assert!(matches!(
            run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap(),
            BootstrapResult::Pending(_)
        ));
        let key = DocKey::new("workspace", "main", "object").unwrap();
        let doc = Ydoc::wire();
        doc.apply(&vector.bytes).unwrap();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, "stale edit")
            .unwrap();
        let bytes = doc.encode_full_state();
        assert!(matches!(
            store.write_with(&NoFaults, |tx| durable::record_update_in_tx(
                tx, &key, &bytes, None, None, 201
            )),
            Err(CollabError::RestoreFenced)
        ));
        drop(handle);
        drop(owner);
        drop(store);
        let mut store = EngineStore::open(&dir.join("engine.db"), 202).unwrap();
        let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
        for namespace in ["relay-A", "another-relay"] {
            assert!(matches!(
                owner.register(
                    &mut store,
                    namespace.into(),
                    coordinate.clone(),
                    input.old_binding.clone()
                ),
                Err(ApplicationError::Collab(CollabError::RestoreFenced))
            ));
        }
        assert_eq!(
            owner
                .fence_restore(
                    &mut store,
                    input.clone(),
                    coordinate.clone(),
                    203,
                    &NoFaults
                )
                .unwrap(),
            receipt
        );
        let mut conflict = input;
        conflict.operation_id = "different".into();
        assert!(owner
            .fence_restore(&mut store, conflict, coordinate, 204, &NoFaults)
            .is_err());
        assert_eq!(store.table_row_count("live_restore_fences").unwrap(), 1);
    }

    fn sync_policy() -> AppliedSyncPolicy {
        AppliedSyncPolicy {
            max_client_vector_bytes: 1024,
            max_host_vector_bytes: 4096,
            max_output_bytes: 1_000_000,
            max_read_bytes: 10_000_000,
        }
    }

    fn sync_event(handle: &ApplicationHandle, cursor: i64, bytes: Vec<u8>) -> AdmittedLiveUpdate {
        AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: LiveUpdateReceipt {
                        delivery_id: format!("sync-{cursor}"),
                        update_digest: hex_sha256(&bytes),
                        journal_cursor: cursor,
                        accepting_host_epoch: 1,
                    },
                    binding: handle.registration.lock().unwrap().binding.clone(),
                    authority: ServerDerivedLiveUpdateAuthority::Owner {
                        principal_id: "owner".into(),
                    },
                    received_at_ms: 120,
                },
                first_seen: vec![],
            },
            update_bytes: bytes,
        }
    }

    #[test]
    fn applied_sync_replays_past_the_old_configured_event_window() {
        let vector = vectors()
            .into_iter()
            .find(|v| v.registration_accepted)
            .unwrap();
        let (_dir, mut store, mut cache, _owner, handle) = fixture(&vector);
        run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap();
        let doc = Ydoc::wire();
        doc.apply(&vector.bytes).unwrap();
        let update = doc.richdoc_append_paragraph("past one hundred applications");
        for cursor in 1..=101 {
            apply_committed(
                &mut store,
                &mut cache,
                &handle,
                sync_event(&handle, cursor, update.clone()),
                &NoFaults,
                10_000_000,
                |_, _, _, _| Ok(()),
            )
            .unwrap();
        }
        let checkpoint_count: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT max(event_count) FROM live_accepted_checkpoints",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(checkpoint_count, 0);
        let cut = read_applied_sync(&store, &handle, &[0], sync_policy(), || true).unwrap();
        assert_eq!(cut.position.event_count, 101);
        assert_eq!(cut.position.journal_cursor, 101);
        let peer = Ydoc::wire();
        peer.apply(&cut.missing_state_update).unwrap();
        assert_eq!(peer.canonical_content(), doc.canonical_content());
    }

    #[test]
    fn applied_sync_requires_accepted_history_for_a_native_claimed_document() {
        let vector = vectors()
            .into_iter()
            .find(|v| v.registration_accepted)
            .unwrap();
        let (_dir, mut store, mut cache, _owner, handle) = fixture(&vector);
        let doc = Ydoc::wire();
        doc.apply(&vector.bytes).unwrap();
        let key = DocKey::new("workspace", "main", "object").unwrap();
        store
            .write_with(&NoFaults, |tx| {
                write_text_in_tx(
                    tx,
                    &WriteText {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        object_id: "object".into(),
                        path: "notes/example.md".into(),
                        text: vector.markdown.clone(),
                        moment_id: "native-baseline".into(),
                        metadata_origin: "sync".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 100,
                        request_id: None,
                    },
                )?;
                durable::claim_base_in_tx(
                    tx,
                    &key,
                    ContentKind::Richdoc,
                    &vector.bytes,
                    &doc.encode_state_vector(),
                    100,
                )
                .map_err(ApplicationError::from)?;
                tx.execute("UPDATE ydoc_docs SET path='notes/example.md'", [])
                    .map_err(write_sql)?;
                Ok::<_, Error>(())
            })
            .unwrap();
        let zero = AppliedPosition {
            event_count: 0,
            journal_cursor: 0,
            evidence_digest: accepted_history::initial_digest(&handle.registration.lock().unwrap())
                .unwrap(),
        };
        for cursor in 0..=1 {
            if cursor == 1 {
                let update = doc.richdoc_append_paragraph("applied without accepted history");
                assert!(matches!(
                    apply_committed(
                        &mut store,
                        &mut cache,
                        &handle,
                        sync_event(&handle, cursor, update),
                        &NoFaults,
                        10_000_000,
                        |_, _, _, _| Ok(())
                    )
                    .unwrap(),
                    ApplicationResult::Applied(_)
                ));
            }
            assert!(matches!(
                read_applied_sync(&store, &handle, &[0], sync_policy(), || true),
                Err(ApplicationError::Conflict)
            ));
            assert!(matches!(
                read_next_applied(&store, &handle, &zero, sync_policy(), || true),
                Err(ApplicationError::Conflict)
            ));
        }
    }

    #[test]
    fn applied_sync_cut_feed_survives_compaction_and_detects_missing_ordinals() {
        let vector = vectors()
            .into_iter()
            .find(|v| v.registration_accepted)
            .unwrap();
        let (_dir, mut store, mut cache, _owner, handle) = fixture(&vector);
        run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap();
        let policy = sync_policy();
        let cut = read_applied_sync(&store, &handle, &[0], policy, || true).unwrap();
        assert_eq!(cut.position.event_count, 0);
        assert!(
            read_next_applied(&store, &handle, &cut.position, policy, || true)
                .unwrap()
                .is_none()
        );
        let doc = Ydoc::wire();
        doc.apply(&cut.missing_state_update).unwrap();
        let update = doc.richdoc_append_paragraph("after atomic cut");
        let binding = handle.registration.lock().unwrap().binding.clone();
        let event = AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: LiveUpdateReceipt {
                        delivery_id: "sync-first".into(),
                        update_digest: hex_sha256(&update),
                        journal_cursor: 11,
                        accepting_host_epoch: 1,
                    },
                    binding,
                    authority: ServerDerivedLiveUpdateAuthority::Owner {
                        principal_id: "owner".into(),
                    },
                    received_at_ms: 120,
                },
                first_seen: vec![],
            },
            update_bytes: update,
        };
        apply_committed(
            &mut store,
            &mut cache,
            &handle,
            event.clone(),
            &NoFaults,
            10_000_000,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
        let first = read_next_applied(&store, &handle, &cut.position, policy, || true)
            .unwrap()
            .unwrap();
        assert_eq!(first.position.journal_cursor, 11);
        assert_eq!(first.position.event_count, 1);
        let peer = Ydoc::wire();
        peer.apply(&cut.missing_state_update).unwrap();
        peer.apply(&first.update_bytes).unwrap();
        assert_eq!(peer.canonical_content(), doc.canonical_content());
        let mut duplicate = event;
        duplicate.metadata.accepted.receipt.delivery_id = "sync-repeat-bytes".into();
        duplicate.metadata.accepted.receipt.journal_cursor = 30;
        apply_committed(
            &mut store,
            &mut cache,
            &handle,
            duplicate,
            &NoFaults,
            10_000_000,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
        let second = read_next_applied(&store, &handle, &first.position, policy, || true)
            .unwrap()
            .unwrap();
        assert_eq!(
            second.ack.local_ydoc_sequence,
            first.ack.local_ydoc_sequence
        );
        let key = DocKey::new("workspace", "main", "object").unwrap();
        durable::maybe_compact(&mut store, &key, 0, &NoFaults, 150).unwrap();
        assert_eq!(
            read_next_applied(&store, &handle, &first.position, policy, || true)
                .unwrap()
                .unwrap()
                .update_bytes,
            second.update_bytes
        );
        let now = read_applied_sync(&store, &handle, &peer.encode_state_vector(), policy, || {
            true
        })
        .unwrap();
        assert_eq!(now.position, second.position);
        assert!(
            read_next_applied(&store, &handle, &now.position, policy, || true)
                .unwrap()
                .is_none()
        );
        let before = counts(&store);
        assert!(read_applied_sync(
            &store,
            &handle,
            &[0],
            AppliedSyncPolicy {
                max_read_bytes: 1024,
                ..policy
            },
            || true
        )
        .is_err());
        assert!(read_next_applied(
            &store,
            &handle,
            &cut.position,
            AppliedSyncPolicy {
                max_output_bytes: 4096,
                max_host_vector_bytes: 4096,
                max_read_bytes: 1,
                ..policy
            },
            || true
        )
        .is_err());
        assert!(read_applied_sync(&store, &handle, &[0], policy, || false).is_err());
        assert_eq!(counts(&store), before);
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("DELETE FROM live_accepted_updates WHERE event_count=1", [])
                    .map_err(write_sql)?;
                Ok::<_, ApplicationError>(())
            })
            .unwrap();
        assert!(read_next_applied(&store, &handle, &cut.position, policy, || true).is_err());
    }

    #[test]
    fn applied_sync_refuses_stopped_or_retired_registration() {
        let vector = vectors()
            .into_iter()
            .find(|v| v.registration_accepted)
            .unwrap();
        let (_dir, mut store, mut cache, mut owner, handle) = fixture(&vector);
        run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap();
        let cut = read_applied_sync(&store, &handle, &[0], sync_policy(), || true).unwrap();
        let (fence, coordinate) = fence_input(&handle);
        owner
            .fence_restore(&mut store, fence, coordinate, 200, &NoFaults)
            .unwrap();
        assert!(read_applied_sync(&store, &handle, &[0], sync_policy(), || true).is_err());
        assert!(read_next_applied(&store, &handle, &cut.position, sync_policy(), || true).is_err());
        owner.invalidate(&mut store).unwrap();
        assert!(read_applied_sync(&store, &handle, &[0], sync_policy(), || true).is_err());
    }

    #[test]
    fn applied_sync_excludes_unadmitted_native_head() {
        let vector = vectors()
            .into_iter()
            .find(|v| v.registration_accepted)
            .unwrap();
        let (_dir, mut store, mut cache, _owner, handle) = fixture(&vector);
        run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap();
        let native = Ydoc::wire();
        native.apply(&vector.bytes).unwrap();
        let update = native.richdoc_append_paragraph("not yet admitted");
        let key = DocKey::new("workspace", "main", "object").unwrap();
        store
            .write_with(&NoFaults, |tx| {
                durable::record_update_in_tx(tx, &key, &update, None, None, 150)
            })
            .unwrap();
        let cut = read_applied_sync(&store, &handle, &[0], sync_policy(), || true).unwrap();
        assert_eq!(cut.observed_local_ydoc_head_sequence, 1);
        assert_eq!(cut.position.event_count, 0);
        let applied = Ydoc::wire();
        applied.apply(&cut.missing_state_update).unwrap();
        let baseline = Ydoc::wire();
        baseline.apply(&vector.bytes).unwrap();
        assert_eq!(applied.canonical_content(), baseline.canonical_content());
        assert_ne!(applied.canonical_content(), native.canonical_content());
        assert!(
            read_next_applied(&store, &handle, &cut.position, sync_policy(), || true)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn restore_fence_replay_refuses_changed_durable_state() {
        for sql in [
            "UPDATE live_device_application_bindings SET available=1",
            "UPDATE live_device_application_bindings SET restore_fence_generation=2",
            "UPDATE ydoc_docs SET path='other.md'",
            "DELETE FROM ydoc_docs",
        ] {
            let vector = vectors()
                .into_iter()
                .find(|v| v.registration_accepted)
                .unwrap();
            let (_dir, mut store, mut cache, mut owner, handle) = fixture(&vector);
            run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap();
            let (input, coordinate) = fence_input(&handle);
            owner
                .fence_restore(
                    &mut store,
                    input.clone(),
                    coordinate.clone(),
                    200,
                    &NoFaults,
                )
                .unwrap();
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(sql, []).unwrap();
                    Ok::<_, StorageError>(())
                })
                .unwrap();
            assert!(
                owner
                    .fence_restore(&mut store, input, coordinate, 201, &NoFaults)
                    .is_err(),
                "{sql}"
            );
            assert_eq!(store.table_row_count("live_restore_fences").unwrap(), 1);
        }
    }

    #[cfg(feature = "fault-injection")]
    #[test]
    fn restore_fence_commit_boundaries_reopen_without_partial_state() {
        use dohc_engine_storage::{FaultAction, FaultPoint};
        struct Crash(FaultPoint);
        impl FaultInjector for Crash {
            fn poll(&self, point: FaultPoint) -> FaultAction {
                if point == self.0 {
                    FaultAction::Crash
                } else {
                    FaultAction::Continue
                }
            }
        }
        for point in [
            FaultPoint::StorageBeforePersist,
            FaultPoint::StorageAfterCommitBeforeAck,
        ] {
            let vector = vectors()
                .into_iter()
                .find(|v| v.registration_accepted)
                .unwrap();
            let (dir, mut store, mut cache, mut owner, handle) = fixture(&vector);
            run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap();
            let (input, coordinate) = fence_input(&handle);
            assert!(owner
                .fence_restore(
                    &mut store,
                    input.clone(),
                    coordinate.clone(),
                    200,
                    &Crash(point)
                )
                .is_err());
            drop(handle);
            drop(owner);
            drop(store);
            let mut store = EngineStore::open(&dir.join("engine.db"), 201).unwrap();
            let committed = point == FaultPoint::StorageAfterCommitBeforeAck;
            assert_eq!(
                store.table_row_count("live_restore_fences").unwrap(),
                i64::from(committed)
            );
            let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
            if !committed {
                owner
                    .register(
                        &mut store,
                        input.relay_database_namespace.clone(),
                        coordinate.clone(),
                        input.old_binding.clone(),
                    )
                    .unwrap();
            }
            let receipt = owner
                .fence_restore(&mut store, input, coordinate, 202, &NoFaults)
                .unwrap();
            assert_eq!(receipt.recorded_at_ms, if committed { 200 } else { 202 });
        }
    }

    #[test]
    fn restore_fence_refuses_mismatched_receipts_without_mutation() {
        for field in [
            "namespace",
            "host",
            "source",
            "path",
            "selector",
            "lineage",
            "fence",
            "sequence",
            "terminal",
        ] {
            let vector = vectors()
                .into_iter()
                .find(|v| v.registration_accepted)
                .unwrap();
            let (_dir, mut store, mut cache, mut owner, handle) = fixture(&vector);
            run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap();
            let (mut input, coordinate) = fence_input(&handle);
            match field {
                "namespace" => input.relay_database_namespace = "other".into(),
                "host" => input.host_id = "other".into(),
                "source" => input.origin = RestoreDeliveryOrigin::Bootstrap { id: "other".into() },
                "path" => input.old_binding.current_path = "notes/other.md".into(),
                "selector" => input.old_binding.selector_paths = vec!["notes".into()],
                "lineage" => input.old_binding.lineage_claim_id = "f".repeat(64),
                "fence" => input.new_fence = 2,
                "sequence" => input.applied_sequence = 1,
                "terminal" => {
                    input.terminal = Some(LiveUpdateReceipt {
                        delivery_id: "missing".into(),
                        update_digest: "f".repeat(64),
                        journal_cursor: 1,
                        accepting_host_epoch: 1,
                    })
                }
                _ => unreachable!(),
            }
            let before = counts(&store);
            assert!(
                owner
                    .fence_restore(&mut store, input, coordinate, 200, &NoFaults)
                    .is_err(),
                "{field}"
            );
            assert_eq!(store.table_row_count("live_restore_fences").unwrap(), 0);
            assert_eq!(counts(&store), before);
            assert!(matches!(
                run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap(),
                BootstrapResult::Bootstrapped(_)
            ));
        }
    }

    #[cfg(feature = "fault-injection")]
    #[test]
    fn restore_fence_process_child() {
        let Some(path) = std::env::var_os("DOHC_RESTORE_FENCE_TEST_INPUT") else {
            return;
        };
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let input: NativeRestoreFence = serde_json::from_value(value["input"].clone()).unwrap();
        let coordinate: ApplicationHostCoordinate =
            serde_json::from_value(value["coordinate"].clone()).unwrap();
        let mut store =
            EngineStore::open(std::path::Path::new(value["db"].as_str().unwrap()), 201).unwrap();
        let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
        owner
            .register(
                &mut store,
                input.relay_database_namespace.clone(),
                coordinate.clone(),
                input.old_binding.clone(),
            )
            .unwrap();
        struct Exit(bool);
        impl FaultInjector for Exit {
            fn poll(
                &self,
                point: dohc_engine_storage::FaultPoint,
            ) -> dohc_engine_storage::FaultAction {
                use dohc_engine_storage::{FaultAction, FaultPoint};
                if (!self.0 && point == FaultPoint::StorageBeforePersist)
                    || (self.0 && point == FaultPoint::StorageAfterCommitBeforeAck)
                {
                    std::process::exit(if self.0 { 82 } else { 81 });
                }
                FaultAction::Continue
            }
        }
        owner
            .fence_restore(
                &mut store,
                input,
                coordinate,
                202,
                &Exit(value["after"].as_bool().unwrap()),
            )
            .unwrap();
        panic!("process did not reach its commit boundary");
    }

    #[cfg(feature = "fault-injection")]
    #[test]
    fn restore_fence_survives_native_process_exit_before_and_after_commit() {
        for after in [false, true] {
            let vector = vectors()
                .into_iter()
                .find(|v| v.registration_accepted)
                .unwrap();
            let (dir, mut store, mut cache, owner, handle) = fixture(&vector);
            run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap();
            let (input, coordinate) = fence_input(&handle);
            let path = dir.join("restore-process.json");
            std::fs::write(&path, serde_json::to_vec(&serde_json::json!({"db":dir.join("engine.db"),"input":input,"coordinate":coordinate,"after":after})).unwrap()).unwrap();
            drop(handle);
            drop(owner);
            drop(store);
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "live_update_application::bootstrap::tests::restore_fence_process_child",
                    "--nocapture",
                ])
                .env("DOHC_RESTORE_FENCE_TEST_INPUT", &path)
                .output()
                .unwrap();
            assert_eq!(
                output.status.code(),
                Some(if after { 82 } else { 81 }),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let mut store = EngineStore::open(&dir.join("engine.db"), 203).unwrap();
            assert_eq!(
                store.table_row_count("live_restore_fences").unwrap(),
                i64::from(after)
            );
            let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
            if !after {
                owner
                    .register(
                        &mut store,
                        input.relay_database_namespace.clone(),
                        coordinate.clone(),
                        input.old_binding.clone(),
                    )
                    .unwrap();
            }
            let receipt = owner
                .fence_restore(&mut store, input, coordinate, 204, &NoFaults)
                .unwrap();
            assert_eq!(receipt.recorded_at_ms, if after { 202 } else { 204 });
            assert_eq!(receipt.local_head_sequence, 0);
        }
    }
    #[test]
    fn owner_source_bootstrap_preserves_valid_lexical_markdown() {
        let source: Value = serde_json::from_str(include_str!(
            "../../tests/owner-source/owner-source-seed.json"
        ))
        .unwrap();
        let vector = Vector {
            name: "original-owner-source".into(),
            bytes: serde_json::from_value(source["bytes"].clone()).unwrap(),
            markdown: source["markdown"].as_str().unwrap().into(),
            registration_accepted: true,
            kept_frontmatter: None,
        };
        let (_dir, mut store, mut cache, _owner, handle) = fixture(&vector);
        assert!(matches!(
            run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap(),
            BootstrapResult::Bootstrapped(_)
        ));
        let text:String=store.read_with(|conn|conn.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.object_id='object'",[],|r|r.get(0))).unwrap();
        assert_eq!(text, vector.markdown);
        assert_ne!(text, source["canonical"].as_str().unwrap());
    }
    #[test]
    fn shared_projections_keep_written_frontmatter_and_change_fallback() {
        let mut mismatches = Vec::new();
        for vector in vectors() {
            if !vector.registration_accepted && vector.name.starts_with("public-frontmatter-") {
                continue;
            }
            let doc = Ydoc::wire();
            doc.apply(&vector.bytes).unwrap();
            let actual = doc.project(ContentKind::Richdoc).unwrap().content;
            if let Some(kept) = &vector.kept_frontmatter {
                assert!(
                    actual.starts_with(kept.as_str()),
                    "{} rewrote its frontmatter",
                    vector.name
                );
            }
            if actual != vector.markdown {
                mismatches.push(format!(
                    "{}: actual={actual:?}; expected={:?}",
                    vector.name, vector.markdown
                ));
            }
            if vector.name == "negative-zero" {
                assert_eq!(
                    doc.encode_full_state(),
                    vector.bytes,
                    "Yrs emits the exact bytes that the TypeScript fixture decodes as negative zero"
                );
                let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/live-bootstrap-fixtures/live-bootstrap-negative-zero-yrs.json");
                if std::env::var("DOHC_WRITE_BOOTSTRAP_VECTORS").as_deref() == Ok("1") {
                    std::fs::write(
                        &path,
                        serde_json::to_string(&doc.encode_full_state()).unwrap() + "\n",
                    )
                    .unwrap();
                }
                let exported: Vec<u8> =
                    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
                assert_eq!(
                    doc.encode_full_state(),
                    exported,
                    "committed Rust re-encoding consumed by TypeScript"
                );
            }
        }
        assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
    }
    #[test]
    fn admitted_baselines_commit_atomically_and_replay_after_reopen() {
        for vector in vectors()
            .into_iter()
            .filter(|vector| vector.registration_accepted)
        {
            let (dir, mut store, mut cache, owner, handle) = fixture(&vector);
            assert_eq!(
                run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap(),
                BootstrapResult::Bootstrapped(LiveApplicationBootstrapAck::new(
                    &input(&vector),
                    0,
                    false
                )),
                "{}",
                vector.name
            );
            assert_eq!(counts(&store), (1, 1, 1, 1));
            drop(store);
            let mut store = EngineStore::open(&dir.join("engine.db"), 101).unwrap();
            assert_eq!(
                run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap(),
                BootstrapResult::Bootstrapped(LiveApplicationBootstrapAck::new(
                    &input(&vector),
                    0,
                    true
                ))
            );
            assert_eq!(counts(&store), (1, 1, 1, 1));
            let loaded = store
                .read_with(|conn| {
                    durable::load_doc_in(conn, &DocKey::new("workspace", "main", "object").unwrap())
                })
                .unwrap();
            assert_eq!(
                loaded.project(ContentKind::Richdoc).unwrap().content,
                vector.markdown
            );
            if vector.name == "negative-zero" {
                assert_eq!(
                    loaded.encode_full_state(),
                    vector.bytes,
                    "persisted reopen preserves the signed-zero wire value"
                );
            }
            drop(owner);
        }
    }
    #[test]
    fn projection_mismatch_and_follow_up_failure_leave_no_partial_bootstrap() {
        let vector = vectors().remove(1);
        let (_dir, mut store, mut cache, _owner, handle) = fixture(&vector);
        let mut bad = input(&vector);
        bad.projected_markdown_digest = "f".repeat(64);
        let result: Result<_, Error> = bootstrap_committed(
            &mut store,
            &mut cache,
            &handle,
            bad,
            vector.bytes.clone(),
            &NoFaults,
            |_, _, _, _| Ok(()),
        );
        assert!(result.is_err());
        assert_eq!(counts(&store), (0, 0, 0, 0));
        let result: Result<_, Error> = bootstrap_committed(
            &mut store,
            &mut cache,
            &handle,
            input(&vector),
            vector.bytes.clone(),
            &NoFaults,
            |_, _, _, _| Err(ApplicationError::Interrupted.into()),
        );
        assert!(result.is_err());
        assert_eq!(counts(&store), (0, 0, 0, 0));
        assert!(run(&mut store, &mut cache, &handle, &vector, &NoFaults).is_ok());
    }
    #[test]
    fn unresolved_dependencies_and_nonpublic_roots_do_not_create_domain_state() {
        let doc = Ydoc::wire();
        doc.plaintext_insert(0, "a");
        let pending = Vector {
            name: "pending".into(),
            bytes: doc.plaintext_insert(1, "b"),
            markdown: String::new(),
            registration_accepted: false,
            kept_frontmatter: None,
        };
        let (_dir, mut store, mut cache, _owner, handle) = fixture(&pending);
        assert_eq!(
            run(&mut store, &mut cache, &handle, &pending, &NoFaults).unwrap(),
            BootstrapResult::Pending(ApplicationPending::DependenciesUnresolved)
        );
        assert_eq!(counts(&store), (0, 0, 0, 0));
        let nonpublic = Vector {
            name: "plaintext".into(),
            bytes: doc.encode_full_state(),
            markdown: String::new(),
            registration_accepted: false,
            kept_frontmatter: None,
        };
        let (_dir, mut store, mut cache, _owner, handle) = fixture(&nonpublic);
        assert!(run(&mut store, &mut cache, &handle, &nonpublic, &NoFaults).is_err());
        assert_eq!(counts(&store), (0, 0, 0, 0));
    }
    #[test]
    fn existing_domain_object_and_retired_registration_cannot_be_bootstrapped() {
        let vector = vectors().remove(1);
        let (_dir, mut store, mut cache, mut owner, handle) = fixture(&vector);
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO file_objects VALUES ('workspace','object',0)",
                    [],
                )
                .unwrap();
                Ok::<_, StorageError>(())
            })
            .unwrap();
        assert!(matches!(
            run(&mut store, &mut cache, &handle, &vector, &NoFaults),
            Err(Error::Application(ApplicationError::Conflict))
        ));
        assert_eq!(counts(&store), (0, 0, 0, 0));
        owner.invalidate(&mut store).unwrap();
        assert_eq!(
            run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap(),
            BootstrapResult::Pending(ApplicationPending::ApplicabilityUnavailable)
        );
    }
    #[test]
    fn replay_checks_original_moment_and_retained_marker() {
        let vector = vectors().remove(1);
        let (_dir, mut store, mut cache, _owner, handle) = fixture(&vector);
        run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE moments SET metadata_origin='local'", [])
                    .unwrap();
                Ok::<_, StorageError>(())
            })
            .unwrap();
        assert!(matches!(
            run(&mut store, &mut cache, &handle, &vector, &NoFaults),
            Err(Error::Application(ApplicationError::Corrupt))
        ));
    }
    #[test]
    fn bootstrap_retains_original_blob_and_workspace_deletion_cascades_audit() {
        let vector = vectors().remove(1);
        let (_dir, mut store, mut cache, _owner, handle) = fixture(&vector);
        run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("DELETE FROM ydoc_snapshots", []).unwrap();
                assert!(tx
                    .execute(
                        "DELETE FROM binary_blobs WHERE sha256=?1",
                        [hex_sha256(&vector.bytes)]
                    )
                    .is_err());
                tx.execute(
                    "DELETE FROM versioned_workspaces WHERE workspace_id='workspace'",
                    [],
                )
                .unwrap();
                let count: i64 = tx
                    .query_row("SELECT COUNT(*) FROM live_device_bootstraps", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(count, 0);
                Ok::<_, StorageError>(())
            })
            .unwrap();
    }
    #[cfg(feature = "fault-injection")]
    #[test]
    fn lost_commit_ack_replays_and_precommit_crash_has_no_partial_rows() {
        use dohc_engine_storage::{FaultAction, FaultPoint};
        struct Crash(FaultPoint);
        impl FaultInjector for Crash {
            fn poll(&self, point: FaultPoint) -> FaultAction {
                if point == self.0 {
                    FaultAction::Crash
                } else {
                    FaultAction::Continue
                }
            }
        }
        for point in [
            FaultPoint::StorageBeforePersist,
            FaultPoint::StorageAfterCommitBeforeAck,
        ] {
            let vector = vectors().remove(1);
            let (_dir, mut store, mut cache, _owner, handle) = fixture(&vector);
            assert!(run(&mut store, &mut cache, &handle, &vector, &Crash(point)).is_err());
            let committed = point == FaultPoint::StorageAfterCommitBeforeAck;
            assert_eq!(
                counts(&store),
                if committed {
                    (1, 1, 1, 1)
                } else {
                    (0, 0, 0, 0)
                }
            );
            assert_eq!(
                run(&mut store, &mut cache, &handle, &vector, &NoFaults).unwrap(),
                BootstrapResult::Bootstrapped(LiveApplicationBootstrapAck::new(
                    &input(&vector),
                    0,
                    committed
                ))
            );
        }
    }
}
