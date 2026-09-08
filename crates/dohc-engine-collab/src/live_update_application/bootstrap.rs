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
    follow_up: impl FnOnce(&Transaction<'_>, &WriteResult) -> Result<(), E>,
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
        follow_up(tx, &written)?;
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
            |_, _| Ok(()),
        )
    }
    fn counts(store: &EngineStore) -> (i64, i64, i64, i64) {
        store.read_with(|conn| conn.query_row("SELECT (SELECT COUNT(*) FROM live_device_bootstraps),(SELECT COUNT(*) FROM moments),(SELECT COUNT(*) FROM ydoc_docs),(SELECT COUNT(*) FROM snapshots)",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))).unwrap()
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
    fn shared_projections_preserve_tagged_prefix_and_change_fallback() {
        let mut mismatches = Vec::new();
        for vector in vectors() {
            if !vector.registration_accepted && vector.name.starts_with("public-frontmatter-") {
                continue;
            }
            let doc = Ydoc::wire();
            doc.apply(&vector.bytes).unwrap();
            let actual = doc.project(ContentKind::Richdoc).unwrap().content;
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
            |_, _| Ok(()),
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
            |_, _| Err(ApplicationError::Interrupted.into()),
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
