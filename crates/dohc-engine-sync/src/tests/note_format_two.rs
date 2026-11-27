use super::*;
use crate::conflict_resolve_v1::{
    ConflictResolveV1, EffectContextV1, HeadContentKindV1, HeadV1, LineageTransitionV1, MetadataV1,
    PresentHeadV1, ResolutionV1, ResolveChoiceV1, SuccessorContentKindV1, SuccessorV1,
    build_conflict_resolve_v1,
};
use dohc_engine_collab::ydoc::{reading_body_sequence_here, writing_new_notes_in_format_two_here};
use dohc_engine_collab::{
    ContentKind, DocKey, LocalAppend, SuccessorIdentity, SuccessorIdentityInput,
    fresh_successor_base,
};
use dohc_engine_domain::{
    CreateNamedVersion, DeleteTextFile, WriteText, select_snapshot_by_path_in_tx,
};
use dohc_engine_storage::hex_sha256;

const NOTE: &str = "A note.\n";
const OTHER_NOTE: &str = "Another note.\n";
const DOC: (&str, &str) = ("object-a", "doc.md");
const OTHER: (&str, &str) = ("object-b", "other.md");

fn on<R>(run: impl FnOnce() -> R) -> R {
    writing_new_notes_in_format_two_here(|| reading_body_sequence_here(run))
}

fn committed<T: std::fmt::Debug>(outcome: TxnOutcome<T>) -> T {
    match outcome {
        TxnOutcome::Committed(value) => value,
        other => panic!("{other:?}"),
    }
}

fn base_of(texts: &[&str]) -> Vec<u8> {
    let doc = dohc_engine_collab::Ydoc::wire();
    for text in texts {
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, text)
            .unwrap();
    }
    doc.encode_full_state()
}

fn write(store: &mut EngineStore, text: &str, moment_id: &str, now_ms: i64) {
    write_at(store, DOC, text, moment_id, now_ms);
}

fn write_at(
    store: &mut EngineStore,
    (object_id, path): (&str, &str),
    text: &str,
    moment_id: &str,
    now_ms: i64,
) {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: object_id.to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: moment_id.to_owned(),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
}

fn seed_note(store: &mut EngineStore, text: &str, moment_id: &str, base: Option<&[u8]>) -> DocKey {
    seed_at(store, DOC, text, moment_id, base)
}

fn seed_at(
    store: &mut EngineStore,
    note: (&str, &str),
    text: &str,
    moment_id: &str,
    base: Option<&[u8]>,
) -> DocKey {
    VersionedTextStore::new(store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .unwrap();
    write_at(store, note, text, moment_id, 10);
    let key = DocKey::new("ws", "main", note.0).unwrap();
    if let Some(base) = base {
        dohc_engine_collab::claim_base(store, &key, ContentKind::Richdoc, base, &NoFaults, 11)
            .unwrap();
    }
    key
}

fn owner(base: &[u8]) -> (ScratchDir, EngineStore, DocKey) {
    let (scratch, _path, mut store) = open_store();
    let key = seed_note(&mut store, NOTE, "moment-current", Some(base));
    (scratch, store, key)
}

fn edit(store: &mut EngineStore, key: &DocKey, text: &str, moment_id: &str) {
    on(|| {
        let doc = dohc_engine_collab::load_persisted(store, key)
            .unwrap()
            .unwrap()
            .doc;
        let delta = doc
            .rewrite_content_to_markdown(ContentKind::Richdoc, text)
            .unwrap();
        dohc_engine_collab::record_local_update(
            store,
            &mut WriterDocCache::new(),
            key,
            &delta,
            LocalAppend::default(),
            &NoFaults,
            30,
            |_, _, _| Ok(()),
        )
        .unwrap();
        write(store, text, moment_id, 30);
    });
}

fn convert(store: &mut EngineStore, key: &DocKey, leases: &dyn LeaseProbe) -> FormatTwoConversion {
    committed(
        store
            .write_with(&NoFaults, |tx| {
                convert_note_to_format_two_in_tx(tx, key, leases, 21)
            })
            .unwrap(),
    )
}

fn carriers(store: &EngineStore) -> Vec<serde_json::Value> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT payload_json FROM replication_pending_conflict_ops \
                 WHERE op_kind='conflict.resolve' UNION ALL SELECT payload_json \
                 FROM replication_log WHERE op_kind='conflict.resolve'",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
        .iter()
        .map(|payload| serde_json::from_str(payload).unwrap())
        .collect()
}

fn converted_owner(base: &[u8]) -> (ScratchDir, EngineStore, serde_json::Value) {
    let (scratch, mut store, key) = owner(base);
    assert_eq!(
        on(|| convert(&mut store, &key, &NoLiveLeases)),
        FormatTwoConversion::Converted
    );
    let carrier = carriers(&store).pop().unwrap();
    (scratch, store, carrier)
}

fn prebuilt(store: &mut EngineStore, schema_version: u8, named: Option<&str>) -> serde_json::Value {
    prebuilt_at(store, DOC, schema_version, named)
}

fn prebuilt_at(
    store: &mut EngineStore,
    (object_id, path): (&str, &str),
    schema_version: u8,
    named: Option<&str>,
) -> serde_json::Value {
    let key = DocKey::new("ws", "main", object_id).unwrap();
    let built = store
        .write_with(&NoFaults, |tx| {
            let marker = dohc_engine_collab::read_marker_in(tx, &key).unwrap();
            let claim = marker.unwrap().lineage_claim_id.unwrap();
            let doc = dohc_engine_collab::load_doc_in(tx, &key).unwrap();
            let state = select_snapshot_by_path_in_tx(tx, "ws", "main", path).unwrap();
            let snapshot = state.snapshot.unwrap();
            let vector = hex_sha256(&doc.encode_state_vector());
            let deletes = hex_sha256(&doc.encode_delete_set());
            let cut = json!(["ws", "main", object_id, claim, vector, deletes]);
            let conflict_id = named.map_or_else(
                || format!("note-format-two-{}", hex_sha256(cut.to_string().as_bytes())),
                str::to_owned,
            );
            let identity = SuccessorIdentity::derive_with_schema_version(
                SuccessorIdentityInput {
                    key: &key,
                    predecessor_claim_id: &claim,
                    predecessor_state_vector_sha256: &vector,
                    artifact_op_kind: "note.format-two",
                    artifact_id: &conflict_id,
                    artifact_preimage_sha256: &snapshot.blob_sha256,
                    content_kind: ContentKind::Richdoc,
                    result_sha256: &snapshot.blob_sha256,
                },
                schema_version,
            );
            let successor = fresh_successor_base(&identity, &snapshot.text).unwrap();
            let update = dohc_engine_storage::put_binary_blob(tx, &successor.update)
                .map_err(SyncError::Storage)?;
            let state_vector = dohc_engine_storage::put_binary_blob(tx, &successor.state_vector)
                .map_err(SyncError::Storage)?;
            let created: i64 = tx
                .query_row(
                    "SELECT created_at_ms FROM file_objects WHERE object_id=?1",
                    [object_id],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?;
            let head = HeadV1::Present(PresentHeadV1 {
                path_ref: 0,
                object_id: snapshot.object_id.clone(),
                latest_moment_id: snapshot.latest_moment_id.clone(),
                content_kind: HeadContentKindV1::Text,
                blob_sha256: snapshot.blob_sha256.clone(),
                byte_length: i64::try_from(snapshot.text.len()).unwrap(),
                updated_at_ms: snapshot.updated_at_ms,
            });
            build_conflict_resolve_v1(ConflictResolveV1 {
                workspace_id: "ws".to_owned(),
                conflict_id,
                chosen_from: ResolveChoiceV1::Current,
                resolution: ResolutionV1::KeptCurrent,
                target_version_id: "main".to_owned(),
                source_version_id: "main".to_owned(),
                paths: vec![path.to_owned()],
                current: head.clone(),
                incoming: head.clone(),
                result: head,
                effect_context: EffectContextV1 {
                    recorded_at_ms: 21,
                    metadata: MetadataV1 {
                        origin: "sync".to_owned(),
                        summary: None,
                        correlation_id: None,
                    },
                    author: None,
                    current_object_created_at_ms: Some(created),
                    result_object_created_at_ms: Some(created),
                },
                effects: Vec::new(),
                lineage_transition: Some(LineageTransitionV1 {
                    predecessor_claim_id: claim,
                    predecessor_state_vector_sha256: vector,
                    predecessor_delete_set_sha256: deletes,
                    artifact_preimage_sha256: snapshot.blob_sha256.clone(),
                    successor: Some(SuccessorV1 {
                        lineage_claim_id: successor.lineage_claim_id.clone(),
                        epoch_tag: successor.epoch_tag.clone(),
                        content_kind: SuccessorContentKindV1::Richdoc,
                        result_sha256: snapshot.blob_sha256.clone(),
                        update_blob_sha256: update,
                        state_vector_blob_sha256: state_vector,
                    }),
                }),
                exported_before: None,
            })
        })
        .unwrap();
    committed(built).value
}

fn prebuilt_owner(base: &[u8]) -> (ScratchDir, EngineStore, serde_json::Value) {
    let (scratch, mut store, _key) = owner(base);
    let carrier = on(|| prebuilt(&mut store, 2, None));
    (scratch, store, carrier)
}

fn successor_claim(carrier: &serde_json::Value) -> String {
    carrier["lineageTransition"]["successor"]["lineageClaimId"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn predecessor_claim(carrier: &serde_json::Value) -> &str {
    carrier["lineageTransition"]["predecessorClaimId"]
        .as_str()
        .unwrap()
}

fn hand_over(from: &EngineStore, to: &mut EngineStore, carrier: &serde_json::Value) {
    let transition = &carrier["lineageTransition"];
    let successor = &transition["successor"];
    for sha in [
        &transition["predecessorClaimId"],
        &successor["updateBlobSha256"],
        &successor["stateVectorBlobSha256"],
    ] {
        let sha = sha.as_str().unwrap();
        to.put_binary_blob(&from.get_binary_blob(sha).unwrap().unwrap())
            .unwrap();
    }
}

fn receive(
    from: &EngineStore,
    to: &mut EngineStore,
    carrier: &serde_json::Value,
    origin: &str,
) -> Result<ApplyDisposition<ConflictApplyResult>, SyncError> {
    hand_over(from, to, carrier);
    let mut parent = envelope(origin, 0, "conflict.resolve", carrier.clone());
    parent.recorded_at_ms = 21;
    on(|| apply_conflict_envelope(to, &parent, &NoFaults, &NoLiveLeases))
        .map(|outcome| outcome.primary)
}

fn claim(store: &EngineStore, key: &DocKey) -> Option<String> {
    dohc_engine_collab::read_marker(store, key)
        .unwrap()
        .and_then(|marker| marker.lineage_claim_id)
}

fn note(store: &EngineStore, key: &DocKey) -> (u8, String) {
    on(|| {
        let doc = dohc_engine_collab::load_persisted(store, key)
            .unwrap()
            .unwrap()
            .doc;
        let projection = doc.project(ContentKind::Richdoc).unwrap().content;
        let settled = doc
            .settled_markdown_source(&projection, || Ok::<_, ()>(None))
            .unwrap();
        (doc.note_schema_version(), settled.unwrap_or(projection))
    })
}

fn text(store: &mut EngineStore) -> String {
    VersionedTextStore::new(store)
        .read_text("ws", "main", "doc.md")
        .unwrap()
        .unwrap()
        .text
}

fn open_reviews(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM conflicts WHERE workspace_id='ws' AND status='open'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

fn read_at(store: &mut EngineStore, path: &str) -> Option<String> {
    VersionedTextStore::new(store)
        .read_text("ws", "main", path)
        .unwrap()
        .map(|snapshot| snapshot.text)
}

struct OpenNote(&'static str);

impl LeaseProbe for OpenNote {
    fn is_live(&self, key: &DocKey) -> bool {
        key.object_id == self.0
    }
}

fn relay(ops: Vec<ReplicationEnvelope>) -> RelaySyncClient<FakeRelay> {
    let next_cursor = i64::try_from(ops.len()).unwrap();
    RelaySyncClient::new(FakeRelay {
        pull: Mutex::new(Some(PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops,
            next_cursor,
            has_more: false,
        })),
        ..Default::default()
    })
}

fn pull(
    client: &RelaySyncClient<FakeRelay>,
    peer: &mut EngineStore,
    leases: &dyn LeaseProbe,
) -> SyncPassOutcome {
    on(|| {
        client.pull_chat_workspace(
            peer,
            &mut WriterDocCache::new(),
            "ws",
            &NoFaults,
            leases,
            1_000,
        )
    })
    .expect("the pull goes on")
}

fn pending_cursor(outcome: &SyncPassOutcome) -> Option<i64> {
    match outcome {
        SyncPassOutcome::Complete { pending_cursor, .. } => {
            pending_cursor.as_ref().map(|cursor| cursor.cursor)
        }
        _ => None,
    }
}

fn conversion_op(seq: i64, carrier: &serde_json::Value) -> ReplicationEnvelope {
    let mut op = envelope("owner", seq, "conflict.resolve", carrier.clone());
    op.recorded_at_ms = 21;
    op
}

fn later_owner_op(seq: i64) -> ReplicationEnvelope {
    let mut op = version_create_with_shipped_snapshots("owner", "later-version", Vec::new());
    op.origin_seq = seq;
    op
}

fn peer_without_ydoc(
    owner_store: &EngineStore,
    carrier: &serde_json::Value,
) -> (ScratchDir, EngineStore, DocKey) {
    let (scratch, _path, mut peer) = open_store();
    seed_identity(&mut peer);
    let key = seed_note(&mut peer, NOTE, "moment-current", None);
    hand_over(owner_store, &mut peer, carrier);
    (scratch, peer, key)
}

fn successor_edit(owner_store: &EngineStore, carrier: &serde_json::Value, text: &str) -> Vec<u8> {
    on(|| {
        let successor = carrier["lineageTransition"]["successor"]["updateBlobSha256"]
            .as_str()
            .unwrap();
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.apply(&owner_store.get_binary_blob(successor).unwrap().unwrap())
            .unwrap();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, text)
            .unwrap()
    })
}

fn successor_update(
    peer: &EngineStore,
    seq: i64,
    carrier: &serde_json::Value,
    update: &[u8],
) -> ReplicationEnvelope {
    envelope(
        "owner",
        seq,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-a",
            "path": "doc.md",
            "contentKind": "richdoc",
            "updateBlobSha256": peer.put_binary_blob(update).unwrap(),
            "lineageClaimId": successor_claim(carrier),
            "isBaseState": false
        }),
    )
}

fn predecessor_base(carrier: &serde_json::Value) -> ReplicationEnvelope {
    envelope(
        "creator",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-a",
            "path": "doc.md",
            "contentKind": "richdoc",
            "updateBlobSha256": predecessor_claim(carrier),
            "lineageClaimId": predecessor_claim(carrier),
            "isBaseState": true
        }),
    )
}

fn retain(store: &mut EngineStore, op: &ReplicationEnvelope) {
    let identity = read_sync_identity(store, "ws").unwrap().unwrap();
    crate::deferred::retain_waiting(store, &identity, None, &[op], &BTreeMap::new(), &NoFaults)
        .unwrap();
}

fn retained(store: &EngineStore, origin: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM relay_deferred_ops WHERE origin_id=?1",
                [origin],
                |row| row.get(0),
            )
        })
        .unwrap()
}

fn put_text(store: &mut EngineStore, text: &str) -> String {
    let sha = hex_sha256(text.as_bytes());
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO blobs(sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![sha, i64::try_from(text.len()).unwrap(), text],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    sha
}

const NEW_NOTE: &str = "A new note.\n";

fn new_note_op(store: &mut EngineStore, seq: i64) -> ReplicationEnvelope {
    let sha = put_text(store, NEW_NOTE);
    envelope(
        "owner",
        seq,
        "moment.append",
        json!({
            "momentId": "owner-new-moment", "versionId": "main",
            "objectId": "object-c", "objectCreatedAtMs": 1,
            "path": "notes.md", "recordedAtMs": 2_000, "operation": "write",
            "payloadBeforeBlobSha256": null, "payloadBeforePath": null,
            "payloadAfterBlobSha256": sha, "payloadAfterPath": "notes.md",
            "payloadAfterContentKind": "text", "metadata": {"origin": "sync"},
            "beforePresent": "absent",
        }),
    )
}

fn passes_held(store: &mut EngineStore, kind: &str, payload: serde_json::Value) -> bool {
    let op = envelope("owner", 1, kind, payload);
    committed(
        store
            .write_with(&NoFaults, |tx| {
                crate::deferred::passes_held_work(tx, &op, -1)
            })
            .unwrap(),
    )
}

#[test]
fn a_converted_note_projects_the_same_bytes_in_format_two() {
    let (_scratch, mut store, key) = owner(&base_of(&[NOTE]));
    assert_eq!(note(&store, &key), (1, NOTE.to_owned()));
    let expected = on(|| prebuilt(&mut store, 2, None));
    assert_eq!(
        on(|| convert(&mut store, &key, &NoLiveLeases)),
        FormatTwoConversion::Converted
    );
    assert_eq!(note(&store, &key), (2, NOTE.to_owned()));
    assert_eq!(text(&mut store), NOTE);
    let carrier = carriers(&store).pop().unwrap();
    assert_eq!(carrier, expected);
    assert_eq!(claim(&store, &key), Some(successor_claim(&carrier)));
}

#[test]
fn a_note_without_a_final_newline_converts_and_keeps_its_bytes() {
    let bare = "A note.";
    let (_scratch, _path, mut store) = open_store();
    let key = seed_note(&mut store, bare, "moment-bare", Some(&base_of(&[bare])));
    assert_eq!(
        on(|| convert(&mut store, &key, &NoLiveLeases)),
        FormatTwoConversion::Converted
    );
    assert_eq!(text(&mut store), bare);
    assert_eq!(note(&store, &key), (2, bare.to_owned()));
}

#[test]
fn two_stores_at_one_state_build_the_same_successor() {
    let base = base_of(&[NOTE]);
    let (_first_scratch, first, first_carrier) = converted_owner(&base);
    let (_second_scratch, second, second_carrier) = converted_owner(&base);
    assert_eq!(first_carrier, second_carrier);
    let claim = successor_claim(&first_carrier);
    assert_eq!(
        first.get_binary_blob(&claim).unwrap(),
        second.get_binary_blob(&claim).unwrap()
    );
}

#[test]
fn a_second_call_writes_nothing() {
    let (_scratch, mut store, key) = owner(&base_of(&[NOTE]));
    on(|| {
        assert_eq!(
            convert(&mut store, &key, &NoLiveLeases),
            FormatTwoConversion::Converted
        );
        let second = store
            .write_with(&NoFaults, |tx| {
                let changes = |tx: &rusqlite::Transaction<'_>| {
                    tx.query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
                        .map_err(SyncError::corrupt)
                };
                let before = changes(tx)?;
                let conversion = convert_note_to_format_two_in_tx(tx, &key, &NoLiveLeases, 22)?;
                Ok::<_, SyncError>((conversion, changes(tx)? - before))
            })
            .unwrap();
        assert_eq!(
            second,
            TxnOutcome::Committed((FormatTwoConversion::NothingToConvert, 0))
        );
    });
    assert_eq!(carriers(&store).len(), 1);
}

#[test]
fn a_crash_at_each_commit_converts_once() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let (_scratch, mut store, key) = owner(&base_of(&[NOTE]));
        let faults = ScriptedFaults::crash_at(point);
        let _ = on(|| {
            store.write_with(&*faults, |tx| {
                convert_note_to_format_two_in_tx(tx, &key, &NoLiveLeases, 21)
            })
        });
        assert!(faults.fired(), "{point:?}");
        let retried = on(|| convert(&mut store, &key, &NoLiveLeases));
        let expected = if point == FaultPoint::StorageBeforePersist {
            FormatTwoConversion::Converted
        } else {
            FormatTwoConversion::NothingToConvert
        };
        assert_eq!(retried, expected, "{point:?}");
        assert_eq!(carriers(&store).len(), 1, "{point:?}");
        assert_eq!(note(&store, &key), (2, NOTE.to_owned()), "{point:?}");
    }
}

#[test]
fn a_note_format_two_cannot_hold_is_left_in_format_one() {
    let linked = "Run [`npm install`](https://example.com) first\n";
    let (_scratch, _path, mut store) = open_store();
    let key = seed_note(
        &mut store,
        linked,
        "moment-linked",
        Some(&base_of(&[linked])),
    );
    let before = claim(&store, &key);
    assert_eq!(
        on(|| convert(&mut store, &key, &NoLiveLeases)),
        FormatTwoConversion::DoesNotFit
    );
    assert_eq!(claim(&store, &key), before);
    assert_eq!(note(&store, &key), (1, linked.to_owned()));
    assert!(carriers(&store).is_empty());
}

#[test]
fn a_note_waits_while_it_is_live_unsent_or_switched_off() {
    let (_scratch, mut store, key) = owner(&base_of(&[NOTE]));
    assert_eq!(
        reading_body_sequence_here(|| convert(&mut store, &key, &NoLiveLeases)),
        FormatTwoConversion::NotNow("note-format-two-off")
    );
    assert_eq!(
        on(|| convert(&mut store, &key, &AlwaysLive)),
        FormatTwoConversion::NotNow("ydoc-session-live")
    );
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_log \
                 (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                 VALUES ('ws','local',5,'moment.append',?1,1,0)",
                [json!({"versionId": "main", "objectId": "object-a"}).to_string()],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    assert_eq!(
        on(|| convert(&mut store, &key, &NoLiveLeases)),
        FormatTwoConversion::NotNow("unsent-edit")
    );
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                 VALUES ('ws','local',5)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    assert_eq!(
        on(|| convert(&mut store, &key, &NoLiveLeases)),
        FormatTwoConversion::Converted
    );
}

#[test]
fn a_peer_at_the_same_state_adopts_the_conversion() {
    let base = base_of(&[NOTE]);
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base);
    let (_scratch, mut peer, key) = owner(&base);
    let applied = receive(&owner_store, &mut peer, &carrier, "owner").unwrap();
    assert!(
        matches!(applied, ApplyDisposition::Applied(_)),
        "{applied:?}"
    );
    assert_eq!(claim(&peer, &key), Some(successor_claim(&carrier)));
    assert_eq!(note(&peer, &key), (2, NOTE.to_owned()));
    assert_eq!(open_reviews(&peer), 0);
}

#[test]
fn a_peer_with_another_moment_for_the_same_text_adopts_the_conversion() {
    let base = base_of(&[NOTE]);
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base);
    let (_scratch, _path, mut peer) = open_store();
    let key = seed_note(&mut peer, NOTE, "moment-peer", Some(&base));
    let applied = receive(&owner_store, &mut peer, &carrier, "owner").unwrap();
    assert!(
        matches!(applied, ApplyDisposition::Applied(_)),
        "{applied:?}"
    );
    assert_eq!(claim(&peer, &key), Some(successor_claim(&carrier)));
    assert_eq!(note(&peer, &key), (2, NOTE.to_owned()));
    assert_eq!(open_reviews(&peer), 0);
}

#[test]
fn a_format_one_keep_current_with_no_effects_installs_nothing_here() {
    let base = base_of(&[NOTE]);
    let (_owner_scratch, mut owner_store, _owner_key) = owner(&base);
    let carrier = on(|| prebuilt(&mut owner_store, 1, Some("kept-current")));
    let (_scratch, _path, mut peer) = open_store();
    let key = seed_note(&mut peer, NOTE, "moment-peer", Some(&base));
    let before = claim(&peer, &key);
    let received = receive(&owner_store, &mut peer, &carrier, "owner");
    assert!(
        !matches!(received, Ok(ApplyDisposition::Applied(_))),
        "{received:?}"
    );
    assert_eq!(claim(&peer, &key), before);
    assert_eq!(note(&peer, &key), (1, NOTE.to_owned()));
}

#[test]
fn a_duplicate_conversion_keeps_the_first_and_a_later_edit() {
    let base = base_of(&[NOTE]);
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base);
    for edited in [false, true] {
        let (_scratch, mut peer, key) = owner(&base);
        receive(&owner_store, &mut peer, &carrier, "owner").unwrap();
        assert_eq!(claim(&peer, &key), Some(successor_claim(&carrier)));
        if edited {
            edit(&mut peer, &key, "An edited note.\n", "moment-edit");
        }
        let applied = receive(&owner_store, &mut peer, &carrier, "twin").unwrap();
        assert!(
            matches!(applied, ApplyDisposition::Applied(_)),
            "edited {edited}: {applied:?}"
        );
        assert_eq!(claim(&peer, &key), Some(successor_claim(&carrier)));
        assert_eq!(open_reviews(&peer), 0, "edited {edited}");
        let expected = if edited { "An edited note.\n" } else { NOTE };
        assert_eq!(text(&mut peer), expected);
        assert_eq!(note(&peer, &key), (2, expected.to_owned()));
    }
}

#[test]
fn a_peer_with_no_ydoc_acknowledges_the_conversion_and_pulls_on() {
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base_of(&[NOTE]));
    let (_scratch, mut peer, key) = peer_without_ydoc(&owner_store, &carrier);
    let client = relay(vec![conversion_op(0, &carrier), later_owner_op(1)]);
    let outcome = pull(&client, &mut peer, &NoLiveLeases);
    assert_eq!(pending_cursor(&outcome), Some(2), "{outcome:?}");
    assert_eq!(read_replication_acked_seq(&peer, "ws", "owner").unwrap(), 1);
    assert_eq!(claim(&peer, &key), None);
    assert_eq!(text(&mut peer), NOTE);
    assert_eq!(open_reviews(&peer), 0);
}

#[test]
fn a_peer_with_no_ydoc_waits_for_a_retained_base_then_takes_the_conversion() {
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base_of(&[NOTE]));
    let (_scratch, mut peer, key) = peer_without_ydoc(&owner_store, &carrier);
    retain(&mut peer, &predecessor_base(&carrier));
    let owner_edit = successor_edit(&owner_store, &carrier, "An owner edit.\n");
    let client = relay(vec![
        conversion_op(0, &carrier),
        new_note_op(&mut peer, 1),
        successor_update(&peer, 2, &carrier, &owner_edit),
    ]);
    let held = pull(&client, &mut peer, &OpenNote("object-a"));
    assert!(matches!(held, SyncPassOutcome::Complete { .. }), "{held:?}");
    assert_eq!(claim(&peer, &key), None);
    assert_eq!(read_at(&mut peer, "notes.md").as_deref(), Some(NEW_NOTE));
    assert_eq!(retained(&peer, "owner"), 2);
    let closed = pull(&client, &mut peer, &NoLiveLeases);
    assert!(
        matches!(closed, SyncPassOutcome::Complete { .. }),
        "{closed:?}"
    );
    assert_eq!(claim(&peer, &key), Some(successor_claim(&carrier)));
    assert_eq!(note(&peer, &key), (2, "An owner edit.\n".to_owned()));
    assert_eq!(text(&mut peer), "An owner edit.\n");
    assert_eq!(read_replication_acked_seq(&peer, "ws", "owner").unwrap(), 2);
    assert_eq!(open_reviews(&peer), 0);
}

#[test]
fn a_successor_edit_from_a_third_origin_waits_for_a_retained_conversion() {
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base_of(&[NOTE]));
    let (_scratch, mut peer, key) = peer_without_ydoc(&owner_store, &carrier);
    retain(&mut peer, &predecessor_base(&carrier));
    let third_edit = successor_edit(&owner_store, &carrier, "A third edit.\n");
    let mut third = successor_update(&peer, 0, &carrier, &third_edit);
    third.origin_id = "third".to_owned();
    third.recorded_at_ms = 3_000;
    let client = relay(vec![conversion_op(0, &carrier), third]);
    let outcome = pull(&client, &mut peer, &NoLiveLeases);
    assert!(
        matches!(outcome, SyncPassOutcome::Complete { .. }),
        "{outcome:?}"
    );
    assert_eq!(claim(&peer, &key), Some(successor_claim(&carrier)));
    assert_eq!(note(&peer, &key), (2, "A third edit.\n".to_owned()));
    assert_eq!(text(&mut peer), "A third edit.\n");
    assert_eq!(read_replication_acked_seq(&peer, "ws", "third").unwrap(), 0);
}

#[test]
fn a_successor_edit_to_an_open_note_waits_for_the_conversion_and_lands_on_close() {
    let base = base_of(&[NOTE]);
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base);
    let (_scratch, _path, mut peer) = open_store();
    seed_identity(&mut peer);
    let key = seed_note(&mut peer, NOTE, "moment-current", Some(&base));
    hand_over(&owner_store, &mut peer, &carrier);
    let third_edit = successor_edit(&owner_store, &carrier, "A third edit.\n");
    let mut third = successor_update(&peer, 0, &carrier, &third_edit);
    third.origin_id = "third".to_owned();
    third.recorded_at_ms = 3_000;
    let client = relay(vec![conversion_op(0, &carrier), third]);
    let held = pull(&client, &mut peer, &OpenNote("object-a"));
    assert!(matches!(held, SyncPassOutcome::Complete { .. }), "{held:?}");
    let closed = pull(&client, &mut peer, &NoLiveLeases);
    assert!(
        matches!(closed, SyncPassOutcome::Complete { .. }),
        "{closed:?}"
    );
    assert_eq!(claim(&peer, &key), Some(successor_claim(&carrier)));
    assert_eq!(note(&peer, &key), (2, "A third edit.\n".to_owned()));
    assert_eq!(text(&mut peer), "A third edit.\n");
    assert_eq!(open_reviews(&peer), 0);
}

#[test]
fn a_successor_edit_to_an_open_note_with_no_ydoc_waits_for_a_retained_base() {
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base_of(&[NOTE]));
    let (_scratch, mut peer, key) = peer_without_ydoc(&owner_store, &carrier);
    retain(&mut peer, &predecessor_base(&carrier));
    let third_edit = successor_edit(&owner_store, &carrier, "A third edit.\n");
    let mut third = successor_update(&peer, 0, &carrier, &third_edit);
    third.origin_id = "third".to_owned();
    third.recorded_at_ms = 3_000;
    let client = relay(vec![conversion_op(0, &carrier), third]);
    let held = pull(&client, &mut peer, &OpenNote("object-a"));
    assert!(matches!(held, SyncPassOutcome::Complete { .. }), "{held:?}");
    assert_eq!(retained(&peer, "third"), 1);
    assert_eq!(claim(&peer, &key), None);
    pull(&client, &mut peer, &NoLiveLeases);
    assert_eq!(note(&peer, &key), (2, "A third edit.\n".to_owned()));
}

#[test]
fn a_conversion_does_not_wait_for_a_base_another_note_holds_the_path_of() {
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base_of(&[NOTE]));
    let (_scratch, _path, mut peer) = open_store();
    seed_identity(&mut peer);
    seed_at(
        &mut peer,
        ("object-b", "doc.md"),
        OTHER_NOTE,
        "moment-other",
        None,
    );
    hand_over(&owner_store, &mut peer, &carrier);
    retain(&mut peer, &predecessor_base(&carrier));
    put_text(&mut peer, NOTE);
    let before = put_text(&mut peer, OTHER_NOTE);
    let after = put_text(&mut peer, "");
    let delete = envelope(
        "owner",
        1,
        "moment.append",
        json!({
            "momentId": "owner-deleted", "versionId": "main", "objectId": "object-b",
            "objectCreatedAtMs": 1, "path": "doc.md", "recordedAtMs": 2_000,
            "operation": "delete",
            "payloadBeforeBlobSha256": before, "payloadBeforePath": "doc.md",
            "payloadAfterBlobSha256": after, "payloadAfterPath": "doc.md",
            "metadata": {"origin": "sync"},
            "beforePresent": "present", "beforeObjectId": "object-b", "beforeVersionId": "main",
            "beforePath": "doc.md", "beforeBlobSha256": before,
            "beforeUpdatedAtMs": 10, "beforeLatestMomentId": "moment-other",
            "beforeMetadata": {"origin": "sync"}
        }),
    );
    let client = relay(vec![conversion_op(0, &carrier), delete]);
    let outcome = pull(&client, &mut peer, &OpenNote("object-a"));
    assert_eq!(pending_cursor(&outcome), Some(2), "{outcome:?}");
    assert_eq!(read_replication_acked_seq(&peer, "ws", "owner").unwrap(), 1);
    assert_eq!(retained(&peer, "owner"), 0);
}

#[test]
fn a_resolve_named_in_another_case_has_no_scope_and_is_checked() {
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base_of(&[NOTE]));
    let (_scratch, mut peer, _key) = peer_without_ydoc(&owner_store, &carrier);
    let mut shouting = carrier.clone();
    shouting["conflictId"] = json!(carrier["conflictId"].as_str().unwrap().to_uppercase());
    let op = conversion_op(0, &shouting);
    retain(&mut peer, &op);
    assert_eq!(crate::deferred::hold_key(&op), "owner");
    crate::deferred::claim_report(
        &mut peer,
        "ws",
        std::slice::from_ref(&op),
        &[],
        &mut None,
        &NoFaults,
    )
    .unwrap();
    let checked: i64 = peer
        .read_with(|conn| {
            conn.query_row(
                "SELECT checked_sequence FROM relay_deferred_ops WHERE origin_id='owner'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert!(checked > 0, "{checked}");
}

#[test]
fn a_conversion_before_its_base_from_another_origin_leaves_the_peer_on_the_base() {
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base_of(&[NOTE]));
    let (_scratch, mut peer, key) = peer_without_ydoc(&owner_store, &carrier);
    let owner_edit = successor_edit(&owner_store, &carrier, "An owner edit.\n");
    let client = relay(vec![
        conversion_op(0, &carrier),
        predecessor_base(&carrier),
        successor_update(&peer, 1, &carrier, &owner_edit),
        later_owner_op(2),
    ]);
    let outcome = pull(&client, &mut peer, &NoLiveLeases);
    assert_eq!(pending_cursor(&outcome), Some(4), "{outcome:?}");
    assert_eq!(
        read_replication_acked_seq(&peer, "ws", "creator").unwrap(),
        0
    );
    assert_eq!(read_replication_acked_seq(&peer, "ws", "owner").unwrap(), 2);
    assert_eq!(retained(&peer, "owner"), 0);
    assert_eq!(
        claim(&peer, &key).as_deref(),
        Some(predecessor_claim(&carrier))
    );
    assert_eq!(text(&mut peer), NOTE);
    assert_eq!(open_reviews(&peer), 0);
}

#[test]
fn a_peer_that_deleted_the_note_offline_keeps_it_deleted_and_pulls_on() {
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base_of(&[NOTE]));
    let (_scratch, mut peer, key) = peer_without_ydoc(&owner_store, &carrier);
    VersionedTextStore::new(&mut peer)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                path: "doc.md".to_owned(),
                moment_id: "moment-deleted".to_owned(),
                request_id: None,
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 15,
            },
            &NoFaults,
        )
        .unwrap();
    let client = relay(vec![conversion_op(0, &carrier), later_owner_op(1)]);
    let outcome = pull(&client, &mut peer, &NoLiveLeases);
    assert_eq!(pending_cursor(&outcome), Some(2), "{outcome:?}");
    assert_eq!(read_replication_acked_seq(&peer, "ws", "owner").unwrap(), 1);
    assert_eq!(read_at(&mut peer, "doc.md"), None);
    assert_eq!(claim(&peer, &key), None);
    assert_eq!(open_reviews(&peer), 0);
}

#[test]
fn a_conversion_held_behind_an_open_note_holds_only_that_note() {
    let (base, other_base) = (base_of(&[NOTE]), base_of(&[OTHER_NOTE]));
    let (_owner_scratch, _owner_path, mut owner_store) = open_store();
    seed_at(&mut owner_store, DOC, NOTE, "moment-current", Some(&base));
    seed_at(
        &mut owner_store,
        OTHER,
        OTHER_NOTE,
        "moment-other",
        Some(&other_base),
    );
    let carrier = on(|| prebuilt_at(&mut owner_store, DOC, 2, None));
    let other_carrier = on(|| prebuilt_at(&mut owner_store, OTHER, 2, None));
    let (_scratch, _path, mut peer) = open_store();
    seed_identity(&mut peer);
    let key = seed_at(&mut peer, DOC, NOTE, "moment-current", Some(&base));
    let other_key = seed_at(
        &mut peer,
        OTHER,
        OTHER_NOTE,
        "moment-other",
        Some(&other_base),
    );
    hand_over(&owner_store, &mut peer, &carrier);
    hand_over(&owner_store, &mut peer, &other_carrier);
    let owner_edit = successor_edit(&owner_store, &carrier, "An owner edit.\n");
    let client = relay(vec![
        conversion_op(0, &carrier),
        conversion_op(1, &other_carrier),
        new_note_op(&mut peer, 2),
        successor_update(&peer, 3, &carrier, &owner_edit),
    ]);
    let held = pull(&client, &mut peer, &OpenNote("object-a"));
    assert!(matches!(held, SyncPassOutcome::Complete { .. }), "{held:?}");
    assert_eq!(
        claim(&peer, &other_key),
        Some(successor_claim(&other_carrier))
    );
    assert_eq!(note(&peer, &other_key), (2, OTHER_NOTE.to_owned()));
    assert_eq!(read_at(&mut peer, "notes.md").as_deref(), Some(NEW_NOTE));
    assert_ne!(claim(&peer, &key), Some(successor_claim(&carrier)));
    assert_eq!(note(&peer, &key), (1, NOTE.to_owned()));
    let reshaped = |field: &str, value: serde_json::Value| {
        let mut carrier = other_carrier.clone();
        carrier[field] = value;
        carrier
    };
    let file = "moment.append";
    for (label, kind, payload, passes) in [
        (
            "a rename of the held note",
            file,
            json!({"objectId": "object-a", "beforePath": "doc.md", "path": "renamed.md"}),
            false,
        ),
        (
            "a move of the held note",
            file,
            json!({"objectId": "object-a", "beforePath": "doc.md", "path": "notes/doc.md"}),
            false,
        ),
        (
            "a delete of the held note",
            file,
            json!({"objectId": "object-a", "path": "doc.md", "operation": "delete"}),
            false,
        ),
        (
            "a new note at the held path",
            file,
            json!({"objectId": "object-z", "path": "Doc.md"}),
            false,
        ),
        (
            "a new note elsewhere",
            file,
            json!({"objectId": "object-z", "path": "elsewhere.md"}),
            true,
        ),
        (
            "a conversion of another note",
            "conflict.resolve",
            other_carrier.clone(),
            true,
        ),
        (
            "a resolve with an effect",
            "conflict.resolve",
            reshaped("effects", json!([{"kind": "write"}])),
            false,
        ),
        (
            "a resolve that took the other side",
            "conflict.resolve",
            reshaped("resolution", json!("applied-incoming")),
            false,
        ),
    ] {
        assert_eq!(passes_held(&mut peer, kind, payload), passes, "{label}");
    }
    let closed = pull(&client, &mut peer, &NoLiveLeases);
    assert!(
        matches!(closed, SyncPassOutcome::Complete { .. }),
        "{closed:?}"
    );
    assert_eq!(claim(&peer, &key), Some(successor_claim(&carrier)));
    assert_eq!(note(&peer, &key), (2, "An owner edit.\n".to_owned()));
    assert_eq!(read_replication_acked_seq(&peer, "ws", "owner").unwrap(), 3);
}

#[test]
fn a_note_too_large_for_format_two_does_not_fit() {
    let large = vec!["p"; 50_000].join("\n\n") + "\n";
    let (_scratch, _path, mut store) = open_store();
    let key = seed_note(
        &mut store,
        &large,
        "moment-large",
        Some(&base_of(&[&large])),
    );
    let before = claim(&store, &key);
    assert_eq!(
        on(|| convert(&mut store, &key, &NoLiveLeases)),
        FormatTwoConversion::DoesNotFit
    );
    assert_eq!(claim(&store, &key), before);
    assert_eq!(note(&store, &key).0, 1);
    assert!(carriers(&store).is_empty());
}

#[test]
fn a_peer_on_a_third_lineage_reviews_the_conversion() {
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base_of(&[NOTE]));
    let (_scratch, mut peer, key) = owner(&base_of(&["A draft.\n", NOTE]));
    let before = claim(&peer, &key);
    assert_ne!(before.as_deref(), Some(predecessor_claim(&carrier)));
    receive(&owner_store, &mut peer, &carrier, "owner").unwrap();
    assert_eq!(claim(&peer, &key), before);
    assert_eq!(open_reviews(&peer), 1);
    assert_eq!(text(&mut peer), NOTE);
}

#[test]
fn a_peer_with_an_unsent_edit_keeps_it_in_review() {
    let base = base_of(&[NOTE]);
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base);
    let (_scratch, mut peer, key) = owner(&base);
    let before = claim(&peer, &key);
    edit(&mut peer, &key, "An unsent edit.\n", "moment-unsent");
    receive(&owner_store, &mut peer, &carrier, "owner").unwrap();
    assert_eq!(claim(&peer, &key), before);
    assert_eq!(open_reviews(&peer), 1);
    assert_eq!(text(&mut peer), "An unsent edit.\n");
    assert_eq!(note(&peer, &key), (1, "An unsent edit.\n".to_owned()));
}

#[test]
fn a_peer_with_the_note_open_holds_the_conversion_until_it_closes() {
    let base = base_of(&[NOTE]);
    let (_owner_scratch, owner_store, carrier) = prebuilt_owner(&base);
    let (_scratch, _path, mut peer) = open_store();
    seed_identity(&mut peer);
    let key = seed_note(&mut peer, NOTE, "moment-current", Some(&base));
    hand_over(&owner_store, &mut peer, &carrier);
    let later = version_create_with_shipped_snapshots("later-peer", "later-version", Vec::new());
    let client = relay(vec![conversion_op(0, &carrier), later]);
    let before = claim(&peer, &key);
    let held = pull(&client, &mut peer, &AlwaysLive);
    assert!(matches!(held, SyncPassOutcome::Complete { .. }), "{held:?}");
    assert_eq!(
        read_replication_acked_seq(&peer, "ws", "later-peer").unwrap(),
        0
    );
    assert_eq!(claim(&peer, &key), before);
    assert_ne!(before, Some(successor_claim(&carrier)));
    let closed = pull(&client, &mut peer, &NoLiveLeases);
    assert!(
        matches!(closed, SyncPassOutcome::Complete { .. }),
        "{closed:?}"
    );
    assert_eq!(claim(&peer, &key), Some(successor_claim(&carrier)));
    assert_eq!(note(&peer, &key), (2, NOTE.to_owned()));
}

fn convert_all(
    store: &mut EngineStore,
    after: Option<&DocKey>,
    budget: usize,
    live: &dyn LeaseProbe,
) -> FormatTwoPass {
    on(|| {
        convert_notes_to_format_two(
            store,
            "ws",
            after,
            budget,
            live,
            &|_, _| None,
            &NoFaults,
            21,
        )
        .unwrap()
    })
}

fn changes(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| conn.query_row("SELECT total_changes()", [], |row| row.get(0)))
        .unwrap()
}

#[test]
fn the_pass_converts_within_its_budget_and_resumes_where_it_stopped() {
    let (_scratch, _path, mut store) = open_store();
    let keys: Vec<DocKey> = (1..=5)
        .map(|n| {
            let text = format!("Note {n}.\n");
            let (object, path) = (format!("note-{n}"), format!("note-{n}.md"));
            seed_at(
                &mut store,
                (&object, &path),
                &text,
                &format!("moment-{n}"),
                Some(&base_of(&[&text])),
            )
        })
        .collect();
    let off = reading_body_sequence_here(|| {
        convert_notes_to_format_two(
            &mut store,
            "ws",
            None,
            2,
            &NoLiveLeases,
            &|_, _| None,
            &NoFaults,
            21,
        )
    })
    .unwrap();
    assert!(off.off);
    assert_eq!(off.converted, 0);
    let first = convert_all(&mut store, None, 2, &NoLiveLeases);
    assert_eq!(
        (first.converted, first.resume_after.as_ref()),
        (2, Some(&keys[1]))
    );
    let second = convert_all(&mut store, first.resume_after.as_ref(), 2, &NoLiveLeases);
    assert_eq!(
        (second.converted, second.resume_after.as_ref()),
        (2, Some(&keys[3]))
    );
    let third = convert_all(&mut store, second.resume_after.as_ref(), 2, &NoLiveLeases);
    assert_eq!((third.converted, third.resume_after), (1, None));
    for (n, key) in keys.iter().enumerate() {
        assert_eq!(note(&store, key), (2, format!("Note {}.\n", n + 1)));
    }
    assert_eq!(carriers(&store).len(), 5);
    let before = changes(&store);
    let again = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!((again.converted, again.unchanged), (0, 5));
    assert_eq!(changes(&store), before);
    assert_eq!(carriers(&store).len(), 5);
}

#[test]
fn the_pass_skips_an_open_note_and_converts_it_on_the_next_run() {
    let (_scratch, _path, mut store) = open_store();
    let key = seed_note(&mut store, NOTE, "moment-a", Some(&base_of(&[NOTE])));
    let other = seed_at(
        &mut store,
        OTHER,
        OTHER_NOTE,
        "moment-b",
        Some(&base_of(&[OTHER_NOTE])),
    );
    let held = convert_all(&mut store, None, 10, &OpenNote("object-a"));
    assert_eq!(held.converted, 1);
    assert_eq!(
        held.skipped,
        vec![(key.clone(), "doc.md".to_owned(), "ydoc-session-live")]
    );
    assert_eq!(note(&store, &key).0, 1);
    assert_eq!(note(&store, &other).0, 2);
    let closed = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!((closed.converted, closed.unchanged), (1, 1));
    assert!(closed.skipped.is_empty());
    assert_eq!(note(&store, &key), (2, NOTE.to_owned()));
}

#[test]
fn the_pass_converts_only_the_main_version() {
    let (_scratch, mut store, key) = owner(&base_of(&[NOTE]));
    VersionedTextStore::new(&mut store)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: "ws".to_owned(),
                from_version_id: "main".to_owned(),
                new_version_id: "named".to_owned(),
                name: "Named".to_owned(),
                now_ms: 15,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let named = DocKey::new("ws", "named", "object-a").unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &named,
        ContentKind::Richdoc,
        &base_of(&[NOTE]),
        &NoFaults,
        16,
    )
    .unwrap();
    let pass = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!((pass.converted, pass.unchanged), (1, 0));
    assert_eq!(note(&store, &key), (2, NOTE.to_owned()));
    assert_eq!(note(&store, &named), (1, NOTE.to_owned()));
}

#[test]
fn the_pass_names_a_note_too_large_for_format_two_and_leaves_it() {
    let large = vec!["p"; 50_000].join("\n\n") + "\n";
    let (_scratch, _path, mut store) = open_store();
    let key = seed_note(
        &mut store,
        &large,
        "moment-large",
        Some(&base_of(&[&large])),
    );
    let before = (claim(&store, &key), changes(&store));
    let pass = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!(pass.does_not_fit, vec![(key.clone(), "doc.md".to_owned())]);
    assert_eq!(pass.converted, 0);
    assert_eq!((claim(&store, &key), changes(&store)), before);
    assert_eq!(note(&store, &key).0, 1);
    assert!(carriers(&store).is_empty());
}

fn local_note(
    store: &mut EngineStore,
    text: &str,
    base: &[u8],
    seed_source: Option<&str>,
) -> DocKey {
    let key = seed_note(store, text, "moment-local", None);
    dohc_engine_collab::record_local_update(
        store,
        &mut WriterDocCache::new(),
        &key,
        base,
        LocalAppend {
            marker: Some(dohc_engine_collab::MarkerCreation {
                path: Some("doc.md"),
                content_kind: ContentKind::Richdoc,
                regime: dohc_engine_collab::Regime::LocalOnly,
            }),
            is_seed: seed_source.is_some(),
            seed_source_sha256: seed_source,
            ..Default::default()
        },
        &NoFaults,
        12,
        |_, _, _| Ok(()),
    )
    .unwrap();
    key
}

fn projected(store: &EngineStore, key: &DocKey) -> String {
    on(|| {
        dohc_engine_collab::load_persisted(store, key)
            .unwrap()
            .unwrap()
            .doc
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
    })
}

fn settled_local_note(store: &mut EngineStore, text: &str) -> DocKey {
    let key = local_note(store, text, &base_of(&[text]), None);
    let projected = projected(store, &key);
    settle(store, &projected);
    key
}

fn settle(store: &mut EngineStore, settled: &str) {
    exec(
        store,
        &format!(
            "UPDATE ydoc_docs SET last_settled_sha='{}', pending_authors_json='[]'",
            hex_sha256(settled.as_bytes())
        ),
    );
}

fn head(store: &EngineStore, key: &DocKey) -> (i64, i64) {
    let marker = dohc_engine_collab::read_marker(store, key)
        .unwrap()
        .unwrap();
    (marker.head_update_seq, marker.head_snapshot_seq)
}

fn exec(store: &mut EngineStore, sql: &str) {
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(sql).map_err(SyncError::persist)
        })
        .unwrap();
}

#[test]
fn a_bare_local_marker_in_a_synced_workspace_counts_as_unchanged() {
    let (_scratch, _path, mut store) = open_store();
    let key = settled_local_note(&mut store, NOTE);
    assert_eq!(
        convert_all(&mut store, None, 10, &NoLiveLeases).converted,
        1
    );
    assert_eq!(head(&store, &key), (0, 0));
    exec(
        &mut store,
        "INSERT INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
         VALUES('ws','probe-origin','epoch','stream',1); \
         INSERT INTO sync_relay_cursors(workspace_id,cursor,replication_epoch,stream_identity) \
         VALUES('ws','0','epoch','stream');",
    );
    let pass = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!((pass.unchanged, pass.skipped), (1, Vec::new()));
}

#[test]
fn a_held_local_note_keeps_its_cache() {
    let (_scratch, _path, mut store) = open_store();
    let key = settled_local_note(&mut store, NOTE);
    exec(
        &mut store,
        &format!(
            "INSERT INTO capture_file_holds VALUES('ws','main','object-a','doc.md','{}',5,\
             'ydoc-resolution-not-representable',1,1,0)",
            "a".repeat(64)
        ),
    );
    let before = head(&store, &key);
    let pass = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!(
        pass.skipped,
        vec![(key.clone(), "doc.md".to_owned(), "held")]
    );
    assert_eq!(head(&store, &key), before);
}

#[test]
fn a_local_note_with_an_unsettled_edit_keeps_it_whatever_the_file_proof() {
    let (_scratch, _path, mut store) = open_store();
    let key = settled_local_note(&mut store, NOTE);
    edit(&mut store, &key, OTHER_NOTE, "moment-edit");
    exec(&mut store, "UPDATE ydoc_docs SET pending_authors_json='[]'");
    let before = head(&store, &key);
    let settled = hex_sha256(NOTE.as_bytes());
    let pass = on(|| {
        convert_notes_to_format_two(
            &mut store,
            "ws",
            None,
            10,
            &NoLiveLeases,
            &|_, _| Some(settled.clone()),
            &NoFaults,
            21,
        )
        .unwrap()
    });
    assert_eq!(
        pass.skipped,
        vec![(key.clone(), "doc.md".to_owned(), "ydoc-unsettled")]
    );
    assert_eq!(head(&store, &key), before);
    assert_eq!(note(&store, &key), (1, OTHER_NOTE.to_owned()));
    let projected = projected(&store, &key);
    settle(&mut store, &projected);
    let settled = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!((settled.converted, head(&store, &key)), (1, (0, 0)));
}

#[test]
fn a_settled_local_note_that_keeps_its_files_bytes_drops_its_cache() {
    let file = "A note.";
    let kept = dohc_engine_collab::Ydoc::wire();
    kept.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, file)
        .unwrap();
    let (_scratch, _path, mut store) = open_store();
    let key = local_note(&mut store, file, &kept.encode_full_state(), None);
    assert_ne!(projected(&store, &key), file);
    settle(&mut store, file);
    let pass = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!((pass.converted, pass.skipped), (1, Vec::new()));
    assert_eq!(head(&store, &key), (0, 0));
    assert_eq!(text(&mut store), file);
}

#[test]
fn a_deleted_local_note_counts_as_unchanged_and_keeps_its_cache() {
    let (_scratch, _path, mut store) = open_store();
    let key = settled_local_note(&mut store, NOTE);
    VersionedTextStore::new(&mut store)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                path: "doc.md".to_owned(),
                moment_id: "moment-deleted".to_owned(),
                request_id: None,
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 15,
            },
            &NoFaults,
        )
        .unwrap();
    let before = head(&store, &key);
    let pass = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!((pass.unchanged, pass.converted), (1, 0));
    assert_eq!(head(&store, &key), before);
}

#[test]
fn a_local_note_whose_file_format_two_cannot_hold_keeps_its_cache() {
    let linked = "Run [`npm install`](https://example.com) first\n";
    let (_scratch, _path, mut store) = open_store();
    let key = settled_local_note(&mut store, NOTE);
    write(&mut store, linked, "moment-linked", 13);
    let before = (head(&store, &key), changes(&store));
    let pass = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!(pass.does_not_fit, vec![(key.clone(), "doc.md".to_owned())]);
    assert_eq!((head(&store, &key), changes(&store)), before);
}

#[test]
fn a_local_only_workspace_drops_its_format_one_cache_offline() {
    let (_scratch, _path, mut store) = open_store();
    let key = settled_local_note(&mut store, NOTE);
    assert_eq!(note(&store, &key), (1, NOTE.to_owned()));
    let pass = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!(pass.skipped, Vec::new());
    assert_eq!(pass.converted, 1);
    assert_eq!(head(&store, &key), (0, 0));
    assert_eq!(text(&mut store), NOTE);
    assert!(carriers(&store).is_empty());
    let journaled: i64 = store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM replication_log", [], |row| row.get(0))
        })
        .unwrap();
    assert_eq!(journaled, 0);
    let before = changes(&store);
    let again = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!((again.converted, again.unchanged), (0, 1));
    assert_eq!(changes(&store), before);
}

#[test]
fn a_pristine_local_seed_is_dropped_only_with_the_callers_file_proof() {
    let (_scratch, _path, mut store) = open_store();
    let source = hex_sha256(NOTE.as_bytes());
    let key = local_note(&mut store, NOTE, &base_of(&[NOTE]), Some(&source));
    let unproven = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!(
        unproven.skipped,
        vec![(key.clone(), "doc.md".to_owned(), "ydoc-unsettled")]
    );
    assert_eq!(head(&store, &key), (1, 0));
    let file_proof =
        |_: &EngineStore, proven: &DocKey| (proven.object_id == "object-a").then(|| source.clone());
    let proven = on(|| {
        convert_notes_to_format_two(
            &mut store,
            "ws",
            None,
            10,
            &NoLiveLeases,
            &file_proof,
            &NoFaults,
            21,
        )
        .unwrap()
    });
    assert_eq!((proven.converted, proven.skipped), (1, Vec::new()));
    assert_eq!(head(&store, &key), (0, 0));
    assert_eq!(text(&mut store), NOTE);
}

#[test]
fn a_zero_budget_is_refused_and_converts_nothing() {
    let (_scratch, mut store, key) = owner(&base_of(&[NOTE]));
    let refused = on(|| {
        convert_notes_to_format_two(
            &mut store,
            "ws",
            None,
            0,
            &NoLiveLeases,
            &|_, _| None,
            &NoFaults,
            21,
        )
    });
    assert!(matches!(refused, Err(SyncError::InvalidInput { .. })));
    assert_eq!(note(&store, &key).0, 1);
    assert!(carriers(&store).is_empty());
}

#[test]
fn a_sqlite_engine_failure_stops_the_pass_and_a_bad_row_fails_only_its_note() {
    let corrupt = |source: rusqlite::Error| {
        SyncError::Storage(dohc_engine_storage::StorageError::StateCorrupt {
            source: Some(Box::new(source)),
        })
    };
    let io = rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR),
        None,
    );
    let row =
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, "bad".into());
    let fatal = |source| {
        !crate::conflict_resolve_v1::note_format_two::fails_only_the_note(&corrupt(source))
    };
    assert!(fatal(io));
    assert!(!fatal(row));
}

#[test]
fn a_damaged_note_is_reported_and_the_pass_goes_on() {
    for damaged in ["snapshot_blob_sha256", "state_vector_blob_sha256"] {
        pass_over_a_damaged_note(damaged);
    }
}

fn pass_over_a_damaged_note(damaged: &str) {
    let (_scratch, _path, mut store) = open_store();
    let keys: Vec<DocKey> = (1..=3)
        .map(|n| {
            let text = format!("Note {n}.\n");
            let (object, path) = (format!("note-{n}"), format!("note-{n}.md"));
            seed_at(
                &mut store,
                (&object, &path),
                &text,
                &format!("moment-{n}"),
                Some(&base_of(&[&text])),
            )
        })
        .collect();
    store
        .write_with(&NoFaults, |tx| {
            let blob: String = tx
                .query_row(
                    &format!("SELECT {damaged} FROM ydoc_snapshots WHERE object_id='note-2'"),
                    [],
                    |row| row.get(0),
                )
                .map_err(SyncError::persist)?;
            let mut bytes: Vec<u8> = tx
                .query_row(
                    "SELECT bytes FROM binary_blobs WHERE sha256=?1",
                    [&blob],
                    |row| row.get(0),
                )
                .map_err(SyncError::persist)?;
            let last = bytes.len() - 1;
            bytes[last] ^= 1;
            tx.execute(
                "UPDATE binary_blobs SET bytes=?2 WHERE sha256=?1",
                params![blob, bytes],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let pass = convert_all(&mut store, None, 10, &NoLiveLeases);
    assert_eq!(pass.converted, 2, "{damaged}");
    assert_eq!(
        pass.failed
            .iter()
            .map(|(key, path, _)| (key, path.as_str()))
            .collect::<Vec<_>>(),
        vec![(&keys[1], "note-2.md")],
        "{damaged}"
    );
    assert_eq!(note(&store, &keys[0]).0, 2);
    assert_eq!(note(&store, &keys[2]).0, 2);
    assert_eq!(pass.resume_after, None);
}
