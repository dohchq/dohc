//! Plan r3, Round 2, "Copy creation and retry": the owner's copy of what a
//! hosted replica holds for a released chain, made once per attempt through
//! faults, lost responses, a person's later changes and another device.

use super::*;
use dohc_engine_collab::live_update_application::{
    ReleasedLineageBinding, ReleasedTails, RetainedAuthors, RetainedContribution,
    UnprovenCommitment,
};

const PATH: &str = "notes/plan.md";
const MARKDOWN: &str = "# Plan\n\nKept from the stopped session.\n";

/// An agent that works for the owner.
fn agent(id: &str) -> RetainedAuthors {
    RetainedAuthors::credited(
        Some(id),
        Some(&dohc_engine_domain::ChangeAttribution {
            actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
            on_behalf_of: Some("owner".into()),
            depth: 1,
            run: None,
        }),
    )
    .unwrap()
}

/// The binding a hold of `covered` names.
fn binding_of(covered: Vec<RetainedContribution>) -> ReleasedLineageBinding {
    let commitment = UnprovenCommitment::of(covered).expect("covered work");
    ReleasedLineageBinding::from_json(&json!({
        "version": 3, "workspaceId": "ws", "mainVersionId": "main", "objectId": "held",
        "lineageClaimId": "a".repeat(64), "currentPath": PATH, "restoreGeneration": 0,
        "incoming": {"relayNamespace": "relay", "replicationEpoch": "epoch-1",
            "streamIdentity": "stream-1", "originId": "service-host:host", "originSeq": 4,
            "relaySeq": 9},
        "headDigest": "b".repeat(64),
        "tails": [{"namespace": "relay", "activationId": "activation",
            "release": {"path": PATH, "restoreGeneration": 0},
            "unproven": {"count": commitment.count, "digest": commitment.digest}}],
    }))
    .expect("binding")
}

fn binding() -> ReleasedLineageBinding {
    binding_of(covered())
}

fn merged() -> Vec<RetainedContribution> {
    vec![RetainedContribution::Outbox {
        outbox_id: "outbox".into(),
        sequence: 1,
        delivery_id: "delivery-1".into(),
        update_digest: "d".repeat(64),
        authors: agent("trip-agent"),
    }]
}

/// Work the held document already holds: covered, though merging adds
/// nothing of it.
fn contained() -> RetainedContribution {
    RetainedContribution::Carried {
        delivery_id: "delivery-0".into(),
        update_digest: "e".repeat(64),
        journal_cursor: 3,
        authors: agent("earlier-agent"),
    }
}

fn covered() -> Vec<RetainedContribution> {
    let mut covered = merged();
    covered.push(contained());
    covered.sort();
    covered
}

fn request(markdown: &str) -> KeepRetainedVersion {
    KeepRetainedVersion {
        binding: binding(),
        markdown: markdown.to_owned(),
        projection_sha256: dohc_engine_storage::hex_sha256(markdown.as_bytes()),
        covered_contributions: vec![("relay".into(), covered())],
        merged_contribution_ids: merged(),
        now_ms: 3_000,
    }
}

/// The agents an author list names, in its order.
fn agents(author_json: &str) -> Vec<String> {
    let authors: serde_json::Value = serde_json::from_str(author_json).expect("authors");
    authors
        .as_array()
        .expect("a list")
        .iter()
        .map(|author| author["agentId"].as_str().expect("an agent").to_owned())
        .collect()
}

/// An owner device of `ws` publishing as `origin` through its relay, which
/// holds the document the binding names and its native head.
fn owner_device(origin: &str) -> (ScratchDir, EngineStore) {
    let (scratch, _path, mut store) = open_store();
    seed_replication_version(&mut store, "main", "main");
    adopt_join_identity(
        &mut store, "ws", origin, "epoch-1", "stream-1", 1_000, &NoFaults,
    )
    .expect("identity");
    journal_local_replication_op(
        &mut store,
        "ws",
        origin,
        "epoch-1",
        "stream-1",
        "probe.local",
        &json!({}),
        1_000,
        &NoFaults,
    )
    .expect("probe");
    seed_text_head(&mut store, "held", PATH, "# Plan\n");
    store.put_binary_blob(b"native head").expect("head state");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                 VALUES ('ws',?1,-1)",
                [origin],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_docs (workspace_id,version_id,object_id,updated_at_ms) \
                 VALUES ('ws','main','held',0)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("owner lane");
    (scratch, store)
}

fn kept(outcome: Result<TxnOutcome<KeptRetainedVersion>, SyncError>) -> KeptRetainedVersion {
    match outcome.expect("keep") {
        TxnOutcome::Committed(kept) => kept,
        TxnOutcome::Crashed { .. } => panic!("no faults were injected"),
    }
}

fn keep(store: &mut EngineStore, markdown: &str) -> KeptRetainedVersion {
    kept(keep_retained_version(
        store,
        "ws",
        &request(markdown),
        &NoFaults,
    ))
}

fn count(store: &EngineStore, sql: &str, value: &str) -> i64 {
    store
        .read_with(|conn| conn.query_row(sql, [value], |row| row.get::<_, i64>(0)))
        .expect("count")
}

/// Every row `sql` selects, each column as it is stored.
fn rows(store: &EngineStore, sql: &str) -> Vec<String> {
    store
        .read_with(|conn| {
            let mut statement = conn.prepare(sql)?;
            let columns = statement.column_count();
            statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|index| {
                            row.get::<_, rusqlite::types::Value>(index)
                                .map(|value| format!("{value:?}"))
                        })
                        .collect::<Result<Vec<_>, _>>()
                        .map(|values| values.join("|"))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("rows")
}

/// The held document's own state on this device: its file, its history,
/// its native state and every stored state blob.
fn canonical(store: &EngineStore) -> Vec<Vec<String>> {
    [
        "SELECT * FROM snapshots WHERE object_id='held' ORDER BY path",
        "SELECT * FROM moments WHERE object_id='held' ORDER BY moment_id",
        "SELECT * FROM ydoc_docs ORDER BY object_id",
        "SELECT * FROM binary_blobs ORDER BY sha256",
    ]
    .map(|sql| rows(store, sql))
    .to_vec()
}

fn decisions(store: &EngineStore) -> i64 {
    count(
        store,
        "SELECT COUNT(*) FROM released_hold_copy_decisions WHERE workspace_id=?1",
        "ws",
    )
}

fn copy_text(store: &EngineStore, object_id: &str) -> Option<String> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT blob.text FROM snapshots AS snapshot \
                 JOIN blobs AS blob ON blob.sha256=snapshot.blob_sha256 \
                 WHERE snapshot.workspace_id='ws' AND snapshot.object_id=?1",
                [object_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
        .expect("copy text")
}

fn journaled(store: &EngineStore, moment_id: &str) -> i64 {
    count(
        store,
        "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws' AND imported=0 \
         AND op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?1",
        moment_id,
    )
}

fn rewrite(store: &mut EngineStore, object_id: &str, path: &str, text: &str, moment_id: &str) {
    VersionedTextStore::new(store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: object_id.into(),
                path: path.into(),
                text: text.into(),
                moment_id: moment_id.into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4_000,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("edit copy");
}

/// Plan r3: the copy keeps the merged projection as an ordinary file beside
/// the held document, journaled for the owner's relay, and leaves the
/// document's own state byte for byte as it was.
#[test]
fn a_copy_keeps_the_projection_without_touching_the_held_document() {
    let (_scratch, mut store) = owner_device("local");
    let before = canonical(&store);
    let copy = keep(&mut store, MARKDOWN);
    assert_eq!(
        canonical(&store),
        before,
        "the held document's state is unchanged"
    );

    let digest = binding().digest();
    let projection = dohc_engine_storage::hex_sha256(MARKDOWN.as_bytes());
    assert_eq!(
        (copy.binding_digest.as_str(), copy.attempt, copy.created),
        (digest.as_str(), 0, true)
    );
    assert_eq!(
        copy.recovered_path,
        format!("notes/plan (recovered {} {projection}).md", &digest[..8])
    );
    assert!(
        copy.recovery_moment_id
            .starts_with(RELEASED_COPY_MOMENT_PREFIX)
    );
    assert_eq!(
        copy_text(&store, &copy.recovery_object_id).as_deref(),
        Some(MARKDOWN)
    );
    assert_eq!(journaled(&store, &copy.recovery_moment_id), 1);
    assert_eq!(
        (
            copy.publication.state,
            copy.publication.origin_id.as_str(),
            copy.publication.origin_seq
        ),
        (CopyPublicationState::Pending, "local", 1)
    );
    assert_eq!(copy.merged_contribution_ids, merged());
    assert_eq!(copy.resolution, None);
    // The copy's creation names the binding and every covered author, as
    // its decision does.
    let (correlation, authors, decided): (Option<String>, Option<String>, String) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT m.metadata_correlation_id,m.author_json,d.recovery_author_json FROM moments m
                 JOIN released_hold_copy_decisions d ON d.recovery_moment_id=m.moment_id
                 WHERE m.moment_id=?1",
                [&copy.recovery_moment_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .unwrap();
    assert_eq!(correlation.as_deref(), Some(digest.as_str()));
    assert_eq!(decided, copy.recovery_author_json);
    assert_eq!(agents(&authors.expect("authors")), agents(&decided));
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM materialization_jobs WHERE job_id='sync-mat_'||?1 AND status='pending'",
            &copy.recovery_moment_id,
        ),
        1,
        "the copy waits to reach disk"
    );
}

/// Plan r3: stored bytes that are not the projection roll back the copy and
/// its decision together. The store already holds a damaged blob under the
/// projection's digest, so the write reuses it.
#[test]
fn a_stored_byte_mismatch_rolls_back_the_copy_and_its_decision() {
    let (_scratch, mut store) = owner_device("local");
    let projection = dohc_engine_storage::hex_sha256(MARKDOWN.as_bytes());
    let tampered = "# Plan\n\nNot what the host preserved.\n";
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![projection, MARKDOWN.len() as i64, tampered],
            )
            .map_err(SyncError::persist)
        })
        .expect("damaged blob");
    let before = rows(
        &store,
        "SELECT * FROM replication_log ORDER BY origin_id,origin_seq",
    );
    assert!(keep_retained_version(&mut store, "ws", &request(MARKDOWN), &NoFaults).is_err());
    assert_eq!(decisions(&store), 0);
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM moments WHERE moment_id GLOB ?1",
            "released-copy-*"
        ),
        0
    );
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM file_objects WHERE object_id GLOB ?1",
            "released-copy-*"
        ),
        0
    );
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM materialization_jobs WHERE job_id GLOB ?1",
            "sync-mat_released-copy-*"
        ),
        0
    );
    assert_eq!(
        rows(
            &store,
            "SELECT * FROM replication_log ORDER BY origin_id,origin_seq"
        ),
        before,
        "nothing was journaled"
    );
}

/// Plan r3: a crash before commit leaves neither the copy nor its decision;
/// a crash after commit, whose response is lost, leaves both, and the retry
/// answers that same copy without making another.
#[test]
fn the_copy_and_its_decision_survive_faults_and_lost_responses() {
    let (_scratch, mut store) = owner_device("local");
    let crash = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
    assert!(matches!(
        keep_retained_version(&mut store, "ws", &request(MARKDOWN), &*crash),
        Ok(TxnOutcome::Crashed { .. }) | Err(SyncError::FaultCrash)
    ));
    assert_eq!(decisions(&store), 0);
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM moments WHERE moment_id GLOB ?1",
            "released-copy-*"
        ),
        0
    );

    let lost = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
    let _ = keep_retained_version(&mut store, "ws", &request(MARKDOWN), &*lost);
    assert_eq!(
        decisions(&store),
        1,
        "the commit stands without its response"
    );
    let retried = keep(&mut store, MARKDOWN);
    assert_eq!((retried.attempt, retried.created), (0, false));
    assert_eq!(decisions(&store), 1);
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM moments WHERE moment_id GLOB ?1",
            "released-copy-*"
        ),
        1
    );
    assert_eq!(journaled(&store, &retried.recovery_moment_id), 1);
}

/// Plan r3: after a person renames, edits and deletes the copy, keeping the
/// same binding answers the copy it made, at the path it was made at, and
/// never makes it again.
#[test]
fn retries_answer_the_same_copy_after_rename_edit_and_deletion() {
    let (_scratch, mut store) = owner_device("local");
    let copy = keep(&mut store, MARKDOWN);
    let renamed = "notes/kept plan.md";
    VersionedTextStore::new(&mut store)
        .rename_text_file(
            &RenameTextFile {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                from_path: copy.recovered_path.clone(),
                to_path: renamed.to_owned(),
                moment_id: "rename-copy".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 3_100,
            },
            &NoFaults,
        )
        .expect("rename copy");
    let again = keep(&mut store, MARKDOWN);
    assert_eq!(
        (again.attempt, again.created, again.recovered_path.as_str()),
        (0, false, copy.recovered_path.as_str())
    );

    rewrite(
        &mut store,
        &copy.recovery_object_id,
        renamed,
        "# Plan\n\nEdited.\n",
        "edit-copy",
    );
    let again = keep(&mut store, MARKDOWN);
    assert_eq!((again.attempt, again.created), (0, false));
    assert_eq!(
        copy_text(&store, &copy.recovery_object_id).as_deref(),
        Some("# Plan\n\nEdited.\n")
    );

    VersionedTextStore::new(&mut store)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                path: renamed.to_owned(),
                moment_id: "delete-copy".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 3_200,
            },
            &NoFaults,
        )
        .expect("delete copy");
    let again = keep(&mut store, MARKDOWN);
    assert_eq!((again.attempt, again.created), (0, false));
    assert_eq!(
        copy_text(&store, &copy.recovery_object_id),
        None,
        "a deleted copy stays deleted"
    );
    assert_eq!(decisions(&store), 1);
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM moments WHERE moment_id GLOB ?1",
            "released-copy-*"
        ),
        1
    );
}

/// Plan r3: a push that fails or loses its answer, an acknowledged push and a
/// redundant publication each answer the same attempt. Only a durable
/// refusal of an unresolved attempt makes the next one, and the refused copy
/// stays. A terminal stale decision makes none.
#[test]
fn only_a_genuine_durable_refusal_permits_the_next_attempt() {
    let (_scratch, mut store) = owner_device("local");
    let first = keep(&mut store, MARKDOWN);
    // A transient failure changes nothing durable.
    assert_eq!(keep(&mut store, MARKDOWN).attempt, 0);
    // The relay took the push; which coordinate it accepted is not known yet.
    crate::cursor::rewind_pushed_seq(
        &mut store,
        "ws",
        "local",
        first.publication.origin_seq,
        &NoFaults,
    )
    .unwrap();
    let acknowledged = keep(&mut store, MARKDOWN);
    assert_eq!(
        (acknowledged.attempt, acknowledged.publication.state),
        (0, CopyPublicationState::Acknowledged)
    );

    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_pending_refusals \
                 (workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) \
                 VALUES ('ws','local',?1,'moment.append','invalid-input','refused')",
                [first.publication.origin_seq],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    let refused = keep(&mut store, MARKDOWN);
    assert_eq!((refused.attempt, refused.created), (1, true));
    assert_ne!(refused.recovery_moment_id, first.recovery_moment_id);
    assert_eq!(
        copy_text(&store, &first.recovery_object_id).as_deref(),
        Some(MARKDOWN),
        "the refused copy stays"
    );
    assert!(
        refused.recovered_path.ends_with(" 2).md"),
        "{}",
        refused.recovered_path
    );
    // The new attempt stands until it is itself refused.
    let again = keep(&mut store, MARKDOWN);
    assert_eq!((again.attempt, again.created), (1, false));
    assert_eq!(decisions(&store), 2);
}

#[test]
fn a_terminal_decision_permits_no_other_attempt() {
    let (_scratch, mut store) = owner_device("local");
    let first = keep(&mut store, MARKDOWN);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_pending_refusals \
                 (workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) \
                 VALUES ('ws','local',?1,'moment.append','invalid-input','refused')",
                [first.publication.origin_seq],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "UPDATE released_hold_copy_decisions \
                 SET resolution_outcome='stale',resolution_outcome_at_ms=5000",
                [],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    let stale = keep(&mut store, MARKDOWN);
    assert_eq!(
        (stale.attempt, stale.created, stale.resolution),
        (0, false, Some((CopyResolutionOutcome::Stale, 5_000)))
    );
    assert_eq!(decisions(&store), 1);
}

/// Plan r3: another binding's text never reuses this binding's decision, and
/// a request that disagrees with the decision kept for its binding is
/// refused rather than answered with the other text.
#[test]
fn a_binding_keeps_one_text() {
    let (_scratch, mut store) = owner_device("local");
    keep(&mut store, MARKDOWN);
    assert!(matches!(
        keep_retained_version(&mut store, "ws", &request("# Plan\n\nOther.\n"), &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
    assert_eq!(decisions(&store), 1);
}

/// Plan r3: a copy past the in-band limit is kept and journaled whole.
#[test]
fn a_copy_past_the_inband_limit_is_kept_whole() {
    let (_scratch, mut store) = owner_device("local");
    let markdown = "# Plan\n\n".to_owned() + &"Kept paragraph.\n\n".repeat(6 * 1024);
    assert!(markdown.len() > 96 * 1024);
    let copy = keep(&mut store, &markdown);
    assert_eq!(
        copy_text(&store, &copy.recovery_object_id).as_deref(),
        Some(markdown.as_str())
    );
    let length: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT json_extract(payload_json,'$.payloadAfterByteLength') FROM replication_log \
                 WHERE imported=0 AND json_extract(payload_json,'$.momentId')=?1",
                [&copy.recovery_moment_id],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(length, markdown.len() as i64);
}

/// Plan r3: only the owner's ordinary file lane publishes a copy. A
/// workspace that does not sync refuses before anything is written.
#[test]
fn only_the_owner_lane_keeps_a_copy() {
    let (_scratch, _path, mut unsynced) = open_store();
    seed_replication_version(&mut unsynced, "main", "main");
    seed_text_head(&mut unsynced, "held", PATH, "# Plan\n");
    assert!(matches!(
        keep_retained_version(&mut unsynced, "ws", &request(MARKDOWN), &NoFaults),
        Err(SyncError::InvalidInput { .. })
    ));
    assert_eq!(decisions(&unsynced), 0);
    assert_eq!(
        count(
            &unsynced,
            "SELECT COUNT(*) FROM moments WHERE moment_id GLOB ?1",
            "released-copy-*"
        ),
        0
    );
}

/// The probe and the copy's creation `store` journaled as `origin`, as the
/// feed serves them, the creation at `relay_seq`.
fn served(
    store: &EngineStore,
    origin: &str,
    relay_seq: i64,
) -> (ReplicationEnvelope, ReplicationEnvelope) {
    let mut ops = list_replication_ops(store, "ws", origin, -1, 10).expect("served ops");
    assert_eq!(ops.len(), 2, "{ops:?}");
    let mut creation = ops.pop().unwrap();
    let mut probe = ops.pop().unwrap();
    probe.relay_seq = Some(relay_seq - 1);
    creation.relay_seq = Some(relay_seq);
    (probe, creation)
}

fn receive(
    store: &mut EngineStore,
    probe: &ReplicationEnvelope,
    creation: &ReplicationEnvelope,
) -> ApplyOutcome<i64> {
    apply_envelope_with(store, probe, &NoFaults, insert_probe).expect("probe");
    apply_moment_envelope(
        store,
        creation,
        &NoFaults,
        &NoLiveLeases,
        &ReleasedTails::default(),
    )
    .expect("creation")
}

fn accepted(store: &EngineStore) -> Vec<String> {
    rows(
        store,
        "SELECT accepted_recovery_origin_id,accepted_recovery_origin_seq,accepted_recovery_relay_seq \
         FROM released_hold_copy_decisions ORDER BY attempt",
    )
}

/// Plan r3, two devices, pull before publish: both keep the same binding,
/// and one then receives the other's accepted creation. It applies as a
/// receipt of the copy already there: no second moment, no new object, the
/// person's later edit stays, and the accepted coordinate is recorded. The
/// other device, already holding its own accepted creation, takes the
/// second one's publication the same way.
#[test]
fn identical_creations_converge_when_one_device_pulls_before_publishing() {
    let (_a_scratch, mut device_a) = owner_device("device-a");
    let (_b_scratch, mut device_b) = owner_device("device-b");
    let on_a = keep(&mut device_a, MARKDOWN);
    let on_b = keep(&mut device_b, MARKDOWN);
    assert_eq!(
        (&on_a.recovery_object_id, &on_a.recovery_moment_id),
        (&on_b.recovery_object_id, &on_b.recovery_moment_id),
        "the same attempt names the same copy on every device"
    );
    rewrite(
        &mut device_b,
        &on_b.recovery_object_id,
        &on_b.recovered_path,
        "# Plan\n\nEdited on B.\n",
        "edit-on-b",
    );
    let history = |store: &EngineStore| {
        count(
            store,
            "SELECT COUNT(*) FROM moments WHERE object_id=?1",
            &on_a.recovery_object_id,
        )
    };
    let before = history(&device_b);

    let (probe, creation) = served(&device_a, "device-a", 7);
    assert!(matches!(
        receive(&mut device_b, &probe, &creation).primary,
        ApplyDisposition::Applied(0)
    ));
    assert_eq!(history(&device_b), before, "no second creation in history");
    assert_eq!(
        copy_text(&device_b, &on_b.recovery_object_id).as_deref(),
        Some("# Plan\n\nEdited on B.\n"),
        "the later local edit stays"
    );
    assert_eq!(
        accepted(&device_b),
        [r#"Text("device-a")|Integer(1)|Integer(7)"#.to_owned()]
    );
    let again = keep(&mut device_b, MARKDOWN);
    assert_eq!(
        (
            again.attempt,
            again.created,
            again.publication.state,
            again.publication.relay_seq
        ),
        (0, false, CopyPublicationState::Accepted, Some(7))
    );

    // A sees its own creation come back first, then B's redundant one.
    device_a
        .write_with(&NoFaults, |tx| {
            crate::ydoc_recovery::record_released_copy_echo_in_tx(tx, &creation)
        })
        .unwrap();
    let (probe, redundant) = served(&device_b, "device-b", 9);
    assert!(matches!(
        receive(&mut device_a, &probe, &redundant).primary,
        ApplyDisposition::Applied(0)
    ));
    assert_eq!(
        accepted(&device_a),
        [r#"Text("device-a")|Integer(1)|Integer(7)"#.to_owned()]
    );
    assert_eq!(history(&device_a), 1);
}

/// The owner's log as [`FakeRelay`] answers it, naming `redundant` for the
/// ops a push carries.
struct RedundantRelay {
    inner: FakeRelay,
    redundant: Vec<RedundantRecovery>,
}

impl RelayTransport for RedundantRelay {
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError> {
        let named = self
            .redundant
            .iter()
            .filter(|named| req.ops.iter().any(|op| op.origin_seq == named.origin_seq))
            .cloned()
            .collect();
        let mut response = self.inner.push(req)?;
        response.redundant_recoveries = named;
        Ok(response)
    }
    fn pull(&self, req: PullRequest) -> Result<PullResponse, RelayError> {
        self.inner.pull(req)
    }
    fn lookup_log_coordinate(
        &self,
        req: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError> {
        self.inner.lookup_log_coordinate(req)
    }
    fn probe(&self, req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        self.inner.probe(req)
    }
    fn claim_workspace(&self, req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        self.inner.claim_workspace(req)
    }
    fn rotate_epoch(&self, req: EpochRequest) -> Result<EpochResponse, RelayError> {
        self.inner.rotate_epoch(req)
    }
    fn blobs_have(&self, req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        self.inner.blobs_have(req)
    }
    fn upload_blob(&self, req: BlobUploadRequest) -> Result<(), RelayError> {
        self.inner.upload_blob(req)
    }
    fn download_blobs(
        &self,
        req: BlobDownloadBatchRequest,
    ) -> Result<BlobDownloadBatchResponse, RelayError> {
        self.inner.download_blobs(req)
    }
    fn upload_key_envelope(
        &self,
        req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        self.inner.upload_key_envelope(req)
    }
    fn download_key_envelope(
        &self,
        req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        self.inner.download_key_envelope(req)
    }
    fn shared_channel_pull(
        &self,
        req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        self.inner.shared_channel_pull(req)
    }
    fn share_log_push(&self, req: ShareLogPushRequest) -> Result<PushResponse, RelayError> {
        self.inner.share_log_push(req)
    }
    fn share_view_pull(&self, req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        self.inner.share_view_pull(req)
    }
    fn share_blob(&self, req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        self.inner.share_blob(req)
    }
    fn share_blob_upload(&self, req: ShareBlobUploadRequest) -> Result<(), RelayError> {
        self.inner.share_blob_upload(req)
    }
    fn share_proposal_submit(
        &self,
        req: ShareProposalSubmitRequest,
    ) -> Result<ShareProposalSubmitResponse, RelayError> {
        self.inner.share_proposal_submit(req)
    }
    fn share_collection_write(
        &self,
        req: ShareCollectionWriteRequest,
    ) -> Result<ShareCollectionWriteResponse, RelayError> {
        self.inner.share_collection_write(req)
    }
}

/// Plan r3, two devices, both publish: the relay answers the second
/// device's push with the first accepted creation. That device records it
/// and allocates nothing; a later keep answers the same attempt as accepted.
#[test]
fn a_redundant_publication_adopts_the_accepted_creation() {
    let (_scratch, mut device_b) = owner_device("device-b");
    let copy = keep(&mut device_b, MARKDOWN);
    let client = RelaySyncClient::new(RedundantRelay {
        inner: FakeRelay::default(),
        redundant: vec![RedundantRecovery {
            origin_seq: copy.publication.origin_seq,
            recovery_moment_id: copy.recovery_moment_id.clone(),
            accepted_origin_id: "device-a".into(),
            accepted_origin_seq: 1,
            accepted_relay_seq: 7,
        }],
    });
    assert!(matches!(
        client.push_workspace(
            &mut device_b,
            "ws",
            &NoFaults,
            &NoLiveLeases,
            4_000,
            1_000_000
        ),
        Ok(SyncPassOutcome::Complete { .. })
    ));
    assert_eq!(
        accepted(&device_b),
        [r#"Text("device-a")|Integer(1)|Integer(7)"#.to_owned()]
    );
    let again = keep(&mut device_b, MARKDOWN);
    assert_eq!(
        (
            again.attempt,
            again.created,
            again.publication.origin_id.as_str(),
            again.publication.state
        ),
        (0, false, "device-a", CopyPublicationState::Accepted)
    );
    assert_eq!(decisions(&device_b), 1);
}

/// A device that received another's accepted creation before it kept the
/// copy reuses that creation, wherever it now is.
#[test]
fn keeping_a_copy_already_received_reuses_it() {
    let (_a_scratch, mut device_a) = owner_device("device-a");
    let (_c_scratch, mut device_c) = owner_device("device-c");
    let on_a = keep(&mut device_a, MARKDOWN);
    device_c
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![
                    dohc_engine_storage::hex_sha256(MARKDOWN.as_bytes()),
                    MARKDOWN.len() as i64,
                    MARKDOWN
                ],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    let (probe, creation) = served(&device_a, "device-a", 7);
    assert!(matches!(
        receive(&mut device_c, &probe, &creation).primary,
        ApplyDisposition::Applied(_)
    ));
    let on_c = keep(&mut device_c, MARKDOWN);
    assert_eq!(
        (
            on_c.attempt,
            on_c.created,
            on_c.recovered_path.as_str(),
            on_c.publication.origin_id.as_str()
        ),
        (0, false, on_a.recovered_path.as_str(), "device-a")
    );
    assert_eq!(on_c.publication.state, CopyPublicationState::Accepted);
    assert_eq!(
        journaled(&device_c, &on_c.recovery_moment_id),
        0,
        "nothing to publish again"
    );
}

/// Plan r3: different bytes, correlation or authors under the same identity
/// are not the same copy, and keep the ordinary duplicate refusal.
#[test]
fn a_different_creation_under_the_same_identity_is_not_equivalent() {
    let (_b_scratch, mut device_b) = owner_device("device-b");
    let on_b = keep(&mut device_b, MARKDOWN);
    let other = "# Plan\n\nSomething else.\n";
    let other_sha = dohc_engine_storage::hex_sha256(other.as_bytes());
    device_b
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![other_sha, other.len() as i64, other],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    let creation = list_replication_ops(&device_b, "ws", "device-b", 0, 10)
        .unwrap()
        .pop()
        .unwrap();
    let mut forged = creation.clone();
    forged.origin_id = "device-a".into();
    forged.payload["payloadAfterBlobSha256"] = json!(other_sha);
    forged.payload["payloadAfterByteLength"] = json!(other.len());
    let mut probe = creation.clone();
    probe.origin_id = "device-a".into();
    probe.origin_seq = 0;
    probe.op_kind = "probe.local".into();
    probe.payload = json!({});
    apply_envelope_with(&mut device_b, &probe, &NoFaults, insert_probe).unwrap();
    assert_invalid_refusal!(apply_moment_envelope(
        &mut device_b,
        &forged,
        &NoFaults,
        &NoLiveLeases,
        &ReleasedTails::default()
    ));
    assert_eq!(
        copy_text(&device_b, &on_b.recovery_object_id).as_deref(),
        Some(MARKDOWN)
    );

    let digest = binding().digest();
    let kept: serde_json::Value = serde_json::from_str(&on_b.recovery_author_json).unwrap();
    let mut equivalent = |correlation: &str,
                          authors: Option<&serde_json::Value>,
                          unavailable: bool| {
        device_b
            .write_with(&NoFaults, |tx| {
                crate::ydoc_recovery::equivalent_released_copy_in_tx(
                    tx,
                    "ws",
                    &crate::ydoc_recovery::ReceivedCreation {
                        moment_id: &on_b.recovery_moment_id,
                        version_id: "main",
                        object_id: &on_b.recovery_object_id,
                        operation: "write",
                        before_present: "null",
                        after_content_kind: Some("text"),
                        after_blob_sha256: &dohc_engine_storage::hex_sha256(MARKDOWN.as_bytes()),
                        after_byte_length: Some(MARKDOWN.len() as i64),
                        correlation_id: Some(correlation),
                        authors,
                        attribution_unavailable: unavailable,
                    },
                )
            })
            .unwrap()
    };
    assert_eq!(
        equivalent(&digest, Some(&kept), false),
        TxnOutcome::Committed(true)
    );
    assert_eq!(
        equivalent(&"e".repeat(64), Some(&kept), false),
        TxnOutcome::Committed(false)
    );
    // Sol's Ruling A: retained authorship is part of the copy. Authors left
    // out, one dropped, another added or attribution withheld are another
    // copy's.
    let mut fewer = kept.clone();
    fewer.as_array_mut().unwrap().pop();
    let mut more = kept.clone();
    more.as_array_mut()
        .unwrap()
        .push(json!({"kind": "agent", "agentId": "stranger"}));
    for authors in [None, Some(&fewer), Some(&more)] {
        assert_eq!(
            equivalent(&digest, authors, false),
            TxnOutcome::Committed(false),
            "{authors:?}"
        );
    }
    assert_eq!(
        equivalent(&digest, Some(&kept), true),
        TxnOutcome::Committed(false)
    );
}

/// Sol's Ruling A: the copy credits every author whose work the binding
/// covers, in its creation and its decision: work the held document already
/// held included, not only what merging added.
#[test]
fn the_copy_credits_already_contained_work_too() {
    let (_scratch, mut store) = owner_device("local");
    let copy = keep(&mut store, MARKDOWN);
    assert!(
        !copy.merged_contribution_ids.contains(&contained()),
        "merging added nothing of it"
    );
    assert_eq!(
        agents(&copy.recovery_author_json),
        ["earlier-agent", "trip-agent"]
    );
    let moment: Option<String> = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT author_json FROM moments WHERE moment_id=?1",
                [&copy.recovery_moment_id],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        agents(&moment.expect("authors")),
        ["earlier-agent", "trip-agent"]
    );
}

/// Sol's Ruling A: a copy credits only what the binding commits to. Covered
/// lists that leave work out, credit it to someone else, or name another
/// namespace, a merged contribution none of them covers, and a binding whose
/// coverage does not read are refused before anything is written.
#[test]
fn covered_work_must_be_exactly_what_the_binding_commits_to() {
    let (_scratch, mut store) = owner_device("local");
    let credited_elsewhere = RetainedContribution::at(contained().locator(), agent("someone-else"));
    let mut misattributed = merged();
    misattributed.push(credited_elsewhere);
    misattributed.sort();
    let stranger = RetainedContribution::at(merged()[0].locator(), agent("stranger"));
    let mut invalid_binding = binding();
    invalid_binding.tails =
        std::sync::Arc::new(dohc_engine_collab::live_update_application::ProtectedTails::Invalid);
    let refused: [(&str, KeepRetainedVersion); 6] = [
        (
            "work left out",
            KeepRetainedVersion {
                covered_contributions: vec![("relay".into(), merged())],
                ..request(MARKDOWN)
            },
        ),
        (
            "work credited to someone else",
            KeepRetainedVersion {
                covered_contributions: vec![("relay".into(), misattributed)],
                ..request(MARKDOWN)
            },
        ),
        (
            "another namespace",
            KeepRetainedVersion {
                covered_contributions: vec![("other".into(), covered())],
                ..request(MARKDOWN)
            },
        ),
        (
            "no tail",
            KeepRetainedVersion {
                covered_contributions: Vec::new(),
                ..request(MARKDOWN)
            },
        ),
        (
            "a merged contribution nothing covers",
            KeepRetainedVersion {
                merged_contribution_ids: vec![stranger],
                ..request(MARKDOWN)
            },
        ),
        (
            "coverage that does not read",
            KeepRetainedVersion {
                binding: invalid_binding,
                ..request(MARKDOWN)
            },
        ),
    ];
    for (case, request) in refused {
        assert!(
            matches!(
                keep_retained_version(&mut store, "ws", &request, &NoFaults),
                Err(SyncError::InvalidInput { .. })
            ),
            "{case}"
        );
    }
    assert_eq!(decisions(&store), 0);
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM moments WHERE moment_id GLOB ?1",
            "released-copy-*"
        ),
        0
    );
}

/// Sol's decision-table note: a decision whose columns disagree with each
/// other or with its key reads as corruption, never as the attempt that
/// stands.
#[test]
fn a_decision_that_does_not_read_is_corruption() {
    let damages = [
        ("a binding of another digest",
            "UPDATE released_hold_copy_decisions SET binding_json=replace(binding_json,'\"originSeq\":4','\"originSeq\":5')"),
        ("a binding not in canonical form", "UPDATE released_hold_copy_decisions SET binding_json=' '||binding_json"),
        ("a merged contribution without authors",
            "UPDATE released_hold_copy_decisions SET merged_contribution_ids_json=json_remove(merged_contribution_ids_json,'$[0].authors')"),
        ("a merged coordinate of 0",
            "UPDATE released_hold_copy_decisions SET merged_contribution_ids_json=json_set(merged_contribution_ids_json,'$[0].sequence',0)"),
        ("a repeated merged contribution",
            "UPDATE released_hold_copy_decisions SET merged_contribution_ids_json=
               json_insert(merged_contribution_ids_json,'$[#]',json_extract(merged_contribution_ids_json,'$[0]'))"),
        ("no authors", "UPDATE released_hold_copy_decisions SET recovery_author_json='null'"),
        ("authors that leave out a merged one",
            "UPDATE released_hold_copy_decisions SET recovery_author_json='[{\"kind\":\"unattributed\"}]'"),
        ("authors not in canonical form", "UPDATE released_hold_copy_decisions SET recovery_author_json=' '||recovery_author_json"),
        ("another projection length", "UPDATE released_hold_copy_decisions SET projection_byte_length=projection_byte_length+1"),
    ];
    for (case, damage) in damages {
        let (_scratch, mut store) = owner_device("local");
        keep(&mut store, MARKDOWN);
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(damage, []).map_err(SyncError::persist)
            })
            .unwrap_or_else(|error| panic!("{case}: {error:?}"));
        assert!(
            keep_retained_version(&mut store, "ws", &request(MARKDOWN), &NoFaults).is_err(),
            "{case}"
        );
        assert_eq!(decisions(&store), 1, "{case}: no other attempt");
    }
}

/// A relay's redundant classification must name a copy's creation in the
/// batch and another coordinate; a hosted push never carries one.
#[test]
fn a_redundant_classification_must_name_a_copy_in_the_batch() {
    let (_scratch, mut store) = owner_device("device-b");
    let copy = keep(&mut store, MARKDOWN);
    let batch = list_replication_ops(&store, "ws", "device-b", -1, 10).unwrap();
    let named = RedundantRecovery {
        origin_seq: copy.publication.origin_seq,
        recovery_moment_id: copy.recovery_moment_id.clone(),
        accepted_origin_id: "device-a".into(),
        accepted_origin_seq: 1,
        accepted_relay_seq: 7,
    };
    let validate = |redundant: &[RedundantRecovery], hosted: bool| {
        crate::ydoc_recovery::validate_redundant_recoveries(redundant, &batch, hosted)
    };
    assert_eq!(validate(std::slice::from_ref(&named), false), Ok(()));
    assert_eq!(
        validate(std::slice::from_ref(&named), true),
        Err(RelayError::InvalidResponse)
    );
    for wrong in [
        RedundantRecovery {
            origin_seq: 0,
            ..named.clone()
        },
        RedundantRecovery {
            recovery_moment_id: "released-copy-moment-other".into(),
            ..named.clone()
        },
        RedundantRecovery {
            accepted_origin_id: "device-b".into(),
            ..named.clone()
        },
        RedundantRecovery {
            accepted_relay_seq: 0,
            ..named.clone()
        },
        RedundantRecovery {
            accepted_origin_id: String::new(),
            ..named.clone()
        },
    ] {
        assert_eq!(validate(&[wrong], false), Err(RelayError::InvalidResponse));
    }
    assert_eq!(
        validate(&[named.clone(), named], false),
        Err(RelayError::InvalidResponse)
    );
}
