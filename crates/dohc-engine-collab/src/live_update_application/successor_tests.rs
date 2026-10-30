use crate::live_update_application::retirement::Disposition;

/// Everything a refused succession could write.
const SUCCESSION_WRITES: [&str; 10] = [
    "live_owner_activations",
    "live_owner_adoptions",
    "live_device_application_bindings",
    "owner_ydoc_outboxes",
    "owner_ydoc_outbox_entries",
    "live_accepted_updates",
    "live_accepted_checkpoints",
    "ydoc_updates",
    "ydoc_owner_activation_sources",
    "binary_blobs",
];

/// The fixture's document as ordinary sync left it for a capture: a base the
/// replication log applied, and a committed cursor past it.
fn importable(f: &mut Fixture) {
    let payload = serde_json::json!({
        "versionId": "main", "objectId": "object", "contentKind": "richdoc", "isBaseState": true,
        "lineageClaimId": f.binding.lineage_claim_id, "updateBlobSha256": f.binding.lineage_claim_id,
    });
    write(f, &format!(
        "UPDATE ydoc_docs SET base_origin_id='remote',base_origin_seq=7,base_relay_seq=9;
         INSERT OR IGNORE INTO sync_relay_cursors(workspace_id,cursor,replication_epoch,stream_identity)
           VALUES('workspace','9','epoch','stream');
         INSERT OR IGNORE INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported)
           VALUES('workspace','remote',7,'ydoc.update','{payload}',1,1)"
    ));
}

/// The released document back in the replica's scope and ready, its
/// committed cursor past the imported base.
fn returned(f: &mut Fixture) {
    host_document(f, false, false);
    write(f, "UPDATE hosted_replicas SET main_cursor=9");
}

/// The file at the fixture binding's path, rewritten to the local Y.Doc's
/// text, as ordinary sync brings the owner's work.
fn file_matches_local(f: &mut Fixture, moment: &str) {
    let local = f
        .store
        .read_with(|conn| durable::load_doc_in(conn, &f.key))
        .unwrap();
    let projection = local.project(ContentKind::Richdoc).unwrap().content;
    let text = local
        .preserved_markdown_source(&projection)
        .unwrap_or(projection);
    VersionedTextStore::new(&mut f.store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: f.binding.current_path.clone(),
                text,
                moment_id: moment.into(),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 40,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
}

/// The owner's edit while live editing was stopped, in the Y.Doc and the file.
fn offline_edit(f: &mut Fixture, text: &str, moment: &str) {
    f.doc
        .rewrite_content_to_markdown(ContentKind::Richdoc, text)
        .unwrap();
    let update = f.doc.encode_full_state();
    f.store
        .write_with(&NoFaults, |tx| {
            durable::record_update_in_tx(tx, &f.key, &update, None, None, 40)
        })
        .unwrap();
    file_matches_local(f, moment);
}

/// An imported activation's capture, adopted through the fixture's handle.
fn adopt_root(f: &mut Fixture) -> String {
    let id = capture_imported(f, 1_000_000).unwrap().activation_id;
    f.cut.adoption_id = id.clone();
    f.adopt().unwrap();
    id
}

/// Release the activation the cut names at F=10, once its document parked.
fn release_parked(f: &mut Fixture) -> Option<RetainedPrefixBody> {
    host_document(f, true, true);
    let Release::Released { replayed: false, boundary } = release_through(f, 10).unwrap() else {
        panic!("released");
    };
    boundary
}

/// Capture the released chain tail's successor, register it by name, and
/// cut its retained prefix. Returns its ID.
fn successor(f: &mut Fixture) -> String {
    let captured = capture_imported(f, 1_000_000).unwrap();
    follow(f, captured)
}

/// [`successor`] for a note the reader built, its capture proven by `resolver`.
fn reader_successor(f: &mut Fixture, resolver: &crate::reader_resolver::ReaderResolver) -> String {
    let captured = prove_activation(f, resolver).unwrap();
    follow(f, captured)
}

/// The fixture's cut adopted through its handle, each reader proof it waits
/// for resolved by `resolver`.
fn reader_adopt(f: &mut Fixture, resolver: &crate::reader_resolver::ReaderResolver) -> OwnerAdoptionAck {
    reader_application_result(|| {
        adopt_owner_committed(&mut f.store, &f.handle, f.cut.clone(), 1_000_000, 100, 10, &NoFaults, Some(resolver), |_, _, _, _| Ok(()))
    })
    .unwrap()
}

/// Register `captured`, the released chain tail's successor, by name, and cut
/// its retained prefix. Returns its ID.
fn follow(f: &mut Fixture, captured: ImportedOwnerActivation) -> String {
    let tail = chain_tail(f, "namespace").unwrap().expect("a released tail");
    assert_eq!(captured.source.predecessor_activation_id.as_deref(), Some(tail.as_str()));
    let boundary = f
        .store
        .read_with(|conn| retirement::released_tail(conn, "namespace", &tail))
        .unwrap()
        .0
        .expect("an adopted chain keeps its boundary");
    f.handle = f
        ._owner
        .register_activation(&mut f.store, "namespace".into(), retirement_host(), f.binding.clone(), captured.activation_id.clone())
        .unwrap();
    f.cut.adoption_id = captured.activation_id.clone();
    f.cut.source_moment_id = captured.source.source_moment_id.clone();
    f.cut.source_digest = captured.source.source_digest.clone();
    f.cut.source_byte_length = captured.source.source_byte_length;
    f.cut.expected_local_sequence = captured.source.native_head_sequence;
    f.cut.events.clear();
    f.cut.terminal_receipt = boundary.terminal_receipt.clone();
    f.cut.retained_prefix = Some(RetainedPrefix {
        terminal_receipt: boundary.terminal_receipt,
        event_count: boundary.event_count,
        history_evidence_digest: boundary.history_evidence_digest,
        predecessor_activation_id: tail,
    });
    captured.activation_id
}

/// The activation row a successor's adoption wrote.
fn succession_row(f: &Fixture, id: &str) -> (Option<String>, Option<String>, Option<String>, bool, String) {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT origin_adoption_id,predecessor_activation_id,boundary_json,released_at_ms IS NULL,coverage_digest
                 FROM live_owner_activations WHERE activation_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
        })
        .unwrap()
}

/// The coverage digest an adoption keeps for these entries, each named by its
/// original outbox and sequence.
fn outboxes_digest(coverage: &[(String, i64, Disposition)]) -> String {
    hex_sha256(&serde_json::to_vec(coverage).unwrap())
}

/// The outbox at `path`.
fn outbox_at(f: &Fixture, path: &str) -> String {
    f.store
        .read_with(|conn| {
            conn.query_row("SELECT outbox_id FROM owner_ydoc_outboxes WHERE current_path=?1", [path], |r| r.get(0))
        })
        .unwrap()
}

/// The coverage digest an adoption keeps for these dispositions of the
/// entries in the outbox at the fixture's binding.
fn coverage_digest(f: &Fixture, coverage: &[(i64, Disposition)]) -> String {
    let outbox = outbox_at(f, &f.binding.current_path);
    let coverage: Vec<_> = coverage.iter().map(|(sequence, disposition)| (outbox.clone(), *sequence, disposition.clone())).collect();
    outboxes_digest(&coverage)
}

/// Each adoption seed: its activation and outbox sequence.
fn seeds(f: &Fixture) -> Vec<(String, i64)> {
    f.store
        .read_with(|conn| {
            conn.prepare(
                "SELECT json_extract(native_source_json,'$.adoptionId'),sequence FROM owner_ydoc_outbox_entries
                 WHERE json_extract(native_source_json,'$.origin.kind')='adoptionSeed' ORDER BY sequence",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
}

/// Sol's plan §5: the prefix is the evidence's tenth element, only when
/// present, identically in Rust and TypeScript.
#[test]
fn owner_adoption_evidence_matches_the_shared_vectors() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../tests/owner-source/owner-adoption-evidence.json"
    ))
    .unwrap();
    let binding: LiveObjectBinding = serde_json::from_value(vectors["binding"].clone()).unwrap();
    let c = &vectors["cut"];
    for case in vectors["cases"].as_array().unwrap() {
        let prefix: Option<RetainedPrefix> = serde_json::from_value(case["retainedPrefix"].clone()).unwrap();
        let cut = OwnerAdoptionCut {
            relay_database_namespace: c["relayDatabaseNamespace"].as_str().unwrap().into(),
            adoption_id: "adoption".into(),
            source_moment_id: c["sourceMomentId"].as_str().unwrap().into(),
            source_digest: c["sourceDigest"].as_str().unwrap().into(),
            source_byte_length: c["sourceByteLength"].as_i64().unwrap(),
            baseline_moment_relay_sequence: c["baselineMomentRelaySequence"].as_i64().unwrap(),
            baseline_registered_at_ms: c["baselineRegisteredAtMs"].as_i64().unwrap(),
            baseline_bytes: serde_json::from_value(c["baselineBytes"].clone()).unwrap(),
            expected_local_sequence: c["expectedLocalSequence"].as_i64().unwrap(),
            events: vec![],
            terminal_receipt: prefix.as_ref().and_then(|prefix| prefix.terminal_receipt.clone()),
            retained_prefix: prefix,
            outbox_limits: crate::OwnerOutboxLimits {
                max_pending_bytes: 1,
                max_pending_age_ms: 1,
            },
            reconstruction: NativeHistoryReconstruction {
                working_reserve_bytes: 1,
            },
        };
        assert_eq!(
            validate_cut(&cut, &binding, 1_000_000, 10).unwrap(),
            case["evidenceDigest"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
}

/// A prefix cut has no events after the prefix and ends at its terminal.
#[test]
fn a_prefix_cut_is_its_prefix_alone() {
    let mut f = Fixture::new();
    f.edit(true);
    let terminal = f.cut.terminal_receipt.clone();
    f.cut.retained_prefix = Some(RetainedPrefix {
        terminal_receipt: terminal.clone(),
        event_count: 1,
        history_evidence_digest: "e".repeat(64),
        predecessor_activation_id: "predecessor".into(),
    });
    assert!(validate_cut(&f.cut, &f.binding, 1_000_000, 10).is_err(), "events after the prefix");
    f.cut.events.clear();
    validate_cut(&f.cut, &f.binding, 1_000_000, 10).unwrap();
    f.cut.terminal_receipt = None;
    assert!(validate_cut(&f.cut, &f.binding, 1_000_000, 10).is_err(), "another terminal");
    f.cut.terminal_receipt = terminal;
    f.cut.retained_prefix.as_mut().unwrap().predecessor_activation_id = String::new();
    assert!(validate_cut(&f.cut, &f.binding, 1_000_000, 10).is_err(), "no predecessor");
}

/// Sol's plan §5, capture: a capture follows its released chain tail, so the
/// same state captures under a new ID; it waits while a retirement settles
/// the document. Only an unreleased capture whose predecessor is still the
/// tail resumes or registers; a stale one releases by its exact ID. A
/// source that follows nothing keeps the descriptor it always had.
#[test]
fn a_capture_follows_the_released_chain_tail() {
    let mut f = imported_fixture();
    let first = capture_imported(&mut f, 1_000_000).unwrap();
    let json = serde_json::to_string(&first.source).unwrap();
    assert!(!json.contains("predecessorActivationId"), "{json}");
    assert_eq!(first.activation_id, format!("ordinary-activation-{}", hex_sha256(json.as_bytes())));
    f.cut.adoption_id = first.activation_id.clone();
    f.adopt().unwrap();
    let root = first.activation_id;
    assert_eq!(capture_imported(&mut f, 1_000_000).unwrap().activation_id, root, "the current activation's own capture");
    begin(&mut f, 10).unwrap();
    let before = rows(&f, &SUCCESSION_WRITES);
    assert!(matches!(capture_imported(&mut f, 1_000_000), Err(ApplicationError::Conflict)), "its predecessor still retires");
    assert_eq!(rows(&f, &SUCCESSION_WRITES), before);
    release_parked(&mut f);
    returned(&mut f);
    let next = capture_imported(&mut f, 1_000_000).unwrap();
    assert_ne!(next.activation_id, root, "unchanged state, a new activation");
    assert_eq!(next.source.predecessor_activation_id.as_deref(), Some(root.as_str()));
    assert_eq!(
        serde_json::to_string(&next.source).unwrap(),
        format!("{},\"predecessorActivationId\":\"{root}\"}}", json.trim_end_matches('}'))
    );
    resume_imported(&mut f, &next.activation_id, 1_000_000).expect("its predecessor is still the tail");
    // Another activation followed the tail since: this capture is stale.
    release_unadopted(&mut f, "namespace", "object", "sibling", Some(&root));
    assert!(matches!(resume_imported(&mut f, &next.activation_id, 1_000_000), Err(ApplicationError::Conflict)));
    assert!(matches!(
        f._owner.register_activation(&mut f.store, "namespace".into(), retirement_host(), f.binding.clone(), next.activation_id.clone()),
        Err(ApplicationError::Conflict)
    ), "registration requires the capture to follow the tail");
    let fresh = capture_imported(&mut f, 1_000_000).unwrap();
    assert_eq!(fresh.source.predecessor_activation_id.as_deref(), Some("sibling"));
    f._owner
        .register_activation(&mut f.store, "namespace".into(), retirement_host(), f.binding.clone(), fresh.activation_id)
        .unwrap();
    release_imported_owner_activation(&mut f.store, "namespace", "workspace", &next.activation_id, None, &NoFaults).unwrap();
    let stale: bool = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM ydoc_owner_activation_sources WHERE activation_id=?1)",
                [&next.activation_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(!stale, "a stale capture releases by its exact ID");
}

/// Sol's plan §5, adoption: the successor of the exact released tail adopts
/// its prefix. It inserts its own activation under the lineage's origin,
/// names the binding, and leaves the root adoption and the accepted history
/// as they were. Unchanged state queues no seed; an offline edit queues one
/// seed of the full local state, which writes no Y.Doc row. Replay answers by
/// the exact activation ID, and only for the prefix it adopted.
#[test]
fn a_successor_adopts_its_released_prefix_without_touching_the_origin() {
    for edited in [false, true] {
        let mut f = imported_fixture();
        let root = adopt_root(&mut f);
        let boundary = release_parked(&mut f).expect("an adopted release keeps its boundary");
        let origin = root_adoption(&f);
        let history = rows(&f, &["live_accepted_updates", "live_accepted_checkpoints"]);
        returned(&mut f);
        if edited {
            offline_edit(&mut f, "Edited while stopped", "offline");
        }
        let id = successor(&mut f);
        // The owner state a successor's adoption starts from reads no current activation until it adopts.
        let current = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    &format!(
                        "SELECT count(*) FROM {} WHERE relay_database_namespace='namespace' AND workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
                        crate::live_update_application::owner_activations::CURRENT_ACTIVATIONS
                    ),
                    rusqlite::params![f.binding.workspace_id, f.binding.main_version_id, f.binding.object_id, f.binding.lineage_claim_id],
                    |r| r.get::<_, i64>(0),
                )
            })
            .unwrap();
        assert_eq!(current, 0, "edited={edited}");
        let updates = f.store.table_row_count("ydoc_updates").unwrap();
        let ack = f.adopt().unwrap();
        assert!(!ack.adoption_replayed, "edited={edited}");
        assert_eq!((ack.adoption_id.as_str(), ack.terminal_cursor), (id.as_str(), 0));
        assert_eq!(ack.local_ydoc_sequence, f.cut.expected_local_sequence);
        assert_eq!(root_adoption(&f), origin, "the root adoption stays");
        assert_eq!(rows(&f, &["live_accepted_updates", "live_accepted_checkpoints"]), history, "history is not reinitialized");
        let prefix = f.cut.retained_prefix.clone().unwrap();
        assert_eq!(prefix.body(), boundary);
        let (origin_id, predecessor, saved, current, coverage) = succession_row(&f, &id);
        assert_eq!(origin_id.as_deref(), Some(root.as_str()));
        assert_eq!(predecessor.as_deref(), Some(root.as_str()));
        assert_eq!(saved, Some(serde_json::to_string(&prefix).unwrap()));
        assert!(current);
        assert_eq!(coverage, hex_sha256(b"[]"));
        assert_eq!(binding_activation(&f), (Some(id.clone()), 1));
        assert_eq!(f.handle.activation_id().as_deref(), Some(id.as_str()));
        assert_eq!(
            seeds(&f),
            if edited { vec![(id.clone(), 1)] } else { vec![] },
            "a seed only when local state differs from the accepted state"
        );
        assert_eq!(f.store.table_row_count("ydoc_updates").unwrap(), updates, "a seed is no Y.Doc row");
        if edited {
            let seeded: Vec<u8> = f
                .store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT b.bytes FROM owner_ydoc_outbox_entries e JOIN binary_blobs b ON b.sha256=e.update_blob_digest",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap();
            let doc = Ydoc::wire();
            doc.apply(&seeded).unwrap();
            assert!(crate::replay_parity::structurally_equal_v2(&f.doc, &doc).unwrap());
        }
        let written = rows(&f, &SUCCESSION_WRITES);
        assert!(f.adopt().unwrap().adoption_replayed);
        assert_eq!(rows(&f, &SUCCESSION_WRITES), written, "replay writes nothing");
        f.cut.retained_prefix.as_mut().unwrap().history_evidence_digest = "f".repeat(64);
        assert!(matches!(f.adopt(), Err(ApplicationError::Conflict)), "replay only for the prefix it adopted");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), written);
    }
}

fn resumed_at_a_renamed_binding() -> (Fixture, String) {
    let mut f = released_unregistered();
    let projection = f.doc.project(ContentKind::Richdoc).unwrap().content;
    let predecessor = f.doc.preserved_markdown_source(&projection).unwrap_or(projection);
    offline_edit(&mut f, "Private edit while stopped", "offline");
    rename(&mut f, "notes/renamed.md", "renamed");
    successor(&mut f);
    assert_eq!(f.adopt().unwrap().terminal_cursor, 3);
    (f, hex_sha256(predecessor.as_bytes()))
}

#[test]
fn a_resumed_owner_proves_its_accepted_predecessor_after_a_rename() {
    let (f, predecessor) = resumed_at_a_renamed_binding();
    f.store.read_with(|conn| {
        let binding = serde_json::to_string(&f.binding).unwrap();
        let retained: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM live_device_bootstraps WHERE binding_json=?1 AND projected_markdown_digest=?2)
             OR EXISTS(SELECT 1 FROM live_owner_activations WHERE binding_json=?1 AND source_digest=?2 AND evidence_digest IS NOT NULL)
             OR EXISTS(SELECT 1 FROM live_device_settlements WHERE binding_json=?1 AND markdown_digest=?2)",
            params![binding, predecessor], |r| r.get(0),
        ).map_err(read_sql)?;
        assert!(!retained, "no retained projection proves the predecessor at the renamed binding");
        let mut remaining = 8 * 1024 * 1024;
        assert!(adoption_contains_predecessor_in(
            conn, &f.key, "namespace", &f.binding, &predecessor, &mut remaining,
        )?, "the resumed activation proves its accepted predecessor");
        assert!(!adoption_contains_predecessor_in(
            conn, &f.key, "namespace", &f.binding, &f.cut.source_digest, &mut remaining,
        )?, "the private captured source is not the accepted predecessor");
        Ok::<_, ApplicationError>(())
    }).unwrap();
}

#[test]
fn a_resumed_owners_markdown_retry_uses_its_renamed_binding() {
    let (f, _) = resumed_at_a_renamed_binding();
    let retry = f.store.read_with(|conn| {
        crate::markdown_write_obligations::AuditedRetry::adopted_owner_in(conn, &f.key, 1)
    }).unwrap().unwrap();
    assert_eq!(retry.binding, f.binding, "retry reads the resumed activation's binding");
    assert_eq!(retry.namespace, "namespace");
    assert_eq!(retry.terminal_cursor, 3);
    assert_eq!(retry.head_update_seq, 1);
}

/// A damage a succession must refuse.
type SuccessionDamage = (&'static str, fn(&mut Fixture));

/// Each successor requirement, failing alone, refuses with no writes: the
/// exact predecessor, a capture that follows it, no sibling successor, no
/// current activation in any namespace, the tail's boundary, the
/// accepted-history endpoint, and a lineage already adopted.
#[test]
fn each_succession_requirement_refuses_without_writes() {
    let cases: [SuccessionDamage; 7] = [
        ("wrong predecessor", |f| {
            f.cut.retained_prefix.as_mut().unwrap().predecessor_activation_id = "another".into()
        }),
        ("stale capture", |f| {
            // A capture released after this one became the tail, keeping the
            // same boundary, and the cut follows it.
            let root = f.cut.retained_prefix.clone().unwrap().predecessor_activation_id;
            release_unadopted(f, "namespace", "object", "later", Some(&root));
            write(f, &format!(
                "UPDATE live_owner_activations SET released_boundary_json=(SELECT released_boundary_json
                   FROM live_owner_activations WHERE activation_id='{root}') WHERE activation_id='later'"
            ));
            f.cut.retained_prefix.as_mut().unwrap().predecessor_activation_id = "later".into();
        }),
        ("sibling successor", |f| {
            let root = f.cut.retained_prefix.clone().unwrap().predecessor_activation_id;
            release_unadopted(f, "namespace", "object", "sibling", Some(&root));
        }),
        ("current in another namespace", |f| {
            // One root per lineage keeps this out of a valid store, so only a
            // connection without foreign keys writes it. The adopter still refuses it.
            let root = f.cut.retained_prefix.clone().unwrap().predecessor_activation_id;
            let raw = rusqlite::Connection::open(f._scratch.join("engine.db")).unwrap();
            raw.pragma_update(None, "foreign_keys", false).unwrap();
            raw.execute(
                "INSERT INTO live_owner_activations (relay_database_namespace,activation_id,workspace_id,
                    main_version_id,object_id,lineage_claim_id,origin_adoption_id,binding_json,source_moment_id,
                    source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,
                    host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,
                    terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms)
                 SELECT 'elsewhere','elsewhere-current',workspace_id,main_version_id,object_id,lineage_claim_id,
                    origin_adoption_id,binding_json,source_moment_id,source_digest,source_byte_length,
                    baseline_moment_relay_sequence,baseline_registered_at_ms,host_coordinate_json,evidence_digest,
                    coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,
                    max_pending_bytes,max_pending_age_ms
                 FROM live_owner_activations WHERE activation_id=?1",
                [&root],
            )
            .unwrap();
        }),
        ("boundary", |f| {
            // The cut names the history's real endpoint; the tail kept another.
            let root = f.cut.retained_prefix.clone().unwrap().predecessor_activation_id;
            write(f, &format!(
                "UPDATE live_owner_activations SET released_boundary_json=json_set(released_boundary_json,
                   '$.historyEvidenceDigest','{}') WHERE activation_id='{root}'",
                "f".repeat(64)
            ));
        }),
        ("history endpoint", |f| {
            let root = f.cut.retained_prefix.clone().unwrap().predecessor_activation_id;
            write(f, &format!(
                "UPDATE live_owner_activations SET released_boundary_json=json_set(released_boundary_json,'$.eventCount',5)
                 WHERE activation_id='{root}'"
            ));
            f.cut.retained_prefix.as_mut().unwrap().event_count = 5;
        }),
        ("never adopted", |f| {
            write(f, "UPDATE live_owner_activations SET origin_adoption_id=NULL,evidence_digest=NULL,
                coverage_digest=NULL,covered_outbox_sequence=NULL,local_ydoc_sequence=NULL,terminal_cursor=NULL,
                terminal_receipt_json=NULL,max_pending_bytes=NULL,max_pending_age_ms=NULL;
                DELETE FROM live_owner_adoptions");
        }),
    ];
    for (case, damage) in cases {
        let mut f = imported_fixture();
        adopt_root(&mut f);
        release_parked(&mut f);
        returned(&mut f);
        offline_edit(&mut f, "Edited while stopped", "offline");
        successor(&mut f);
        damage(&mut f);
        let before = rows(&f, &SUCCESSION_WRITES);
        let refused = f.adopt();
        assert!(matches!(refused, Err(ApplicationError::Conflict)), "{case}: {refused:?}");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}");
    }
}

/// Sol's any-namespace ruling, through adoption: once a lineage adopted in
/// one namespace, a capture in another neither adopts it first nor succeeds
/// the released tail; each refuses with no writes.
#[test]
fn another_namespace_never_adopts_or_succeeds_an_adopted_lineage() {
    for (case, succeeds) in [("a first adoption", false), ("a succession", true)] {
        let mut f = imported_fixture();
        adopt_root(&mut f);
        release_parked(&mut f);
        returned(&mut f);
        offline_edit(&mut f, "Edited while stopped", "offline");
        let tail = chain_tail(&f, "namespace").unwrap().expect("a released tail");
        let boundary = f
            .store
            .read_with(|conn| retirement::released_tail(conn, "namespace", &tail))
            .unwrap()
            .0
            .expect("an adopted chain keeps its boundary");
        let path = f.binding.current_path.clone();
        let captured =
            capture_imported_owner_activation(&mut f.store, "other", &f.key, &path, 1_000_000, &NoFaults, None).unwrap();
        f.handle = f
            ._owner
            .register_activation(&mut f.store, "other".into(), retirement_host(), f.binding.clone(), captured.activation_id.clone())
            .unwrap();
        f.cut.adoption_id = captured.activation_id.clone();
        f.cut.source_moment_id = captured.source.source_moment_id.clone();
        f.cut.source_digest = captured.source.source_digest.clone();
        f.cut.source_byte_length = captured.source.source_byte_length;
        f.cut.expected_local_sequence = captured.source.native_head_sequence;
        f.cut.events.clear();
        f.cut.terminal_receipt = boundary.terminal_receipt.clone();
        f.cut.retained_prefix = succeeds.then_some(RetainedPrefix {
            terminal_receipt: boundary.terminal_receipt,
            event_count: boundary.event_count,
            history_evidence_digest: boundary.history_evidence_digest,
            predecessor_activation_id: tail,
        });
        let before = rows(&f, &SUCCESSION_WRITES);
        let refused = f.adopt();
        assert!(matches!(refused, Err(ApplicationError::Conflict)), "{case}: {refused:?}");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}");
    }
}

/// A successor of a chain whose tail carried deliveries: its coverage holds
/// the Covered entry and the Carried one, each with its receipt, and its seed
/// follows them. A covered receipt that differs from accepted history, a
/// carried entry its chain never listed, a listed delivery it lacks, and
/// local state lacking the accepted state each refuse with no writes.
#[test]
fn a_successor_covers_its_chains_retained_entries() {
    for damage in ["none", "covered receipt", "unlisted carried", "missing carried", "local lacks accepted"] {
        let (mut f, covered, carried, _) = covered_and_carried();
        host_document(&mut f, true, true);
        retirement_settle(&mut f, 10, Some(covered.clone())).unwrap();
        release_parked(&mut f);
        write(&mut f, "DELETE FROM ydoc_deferred_updates");
        importable(&mut f);
        returned(&mut f);
        let tail = chain_tail(&f, "namespace").unwrap().unwrap();
        match damage {
            "covered receipt" => write(&mut f, "UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=
                json_set(accepted_receipt_json,'$.acceptingHostEpoch',2) WHERE sequence=1"),
            "unlisted carried" => write(&mut f, &format!(
                "UPDATE live_owner_activations SET carried_manifest_json='[]' WHERE activation_id='{tail}'"
            )),
            "missing carried" => write(&mut f, &format!(
                "UPDATE live_owner_activations SET carried_manifest_json=json_insert(carried_manifest_json,'$[#]',
                   json_object('receipt',json_object('deliveryId','absent','updateDigest','{}','journalCursor',6,
                     'acceptingHostEpoch',1),'nativeSequence',9)) WHERE activation_id='{tail}'",
                "a".repeat(64)
            )),
            "local lacks accepted" => {
                // Local state compacted to the baseline, without the covered update.
                let head: i64 = f
                    .store
                    .read_with(|conn| conn.query_row("SELECT head_update_seq FROM ydoc_docs", [], |r| r.get(0)))
                    .unwrap();
                let baseline = Ydoc::wire();
                baseline.apply(&f.cut.baseline_bytes).unwrap();
                let vector = baseline.encode_state_vector();
                f.store
                    .write_with(&NoFaults, |tx| {
                        let vector = dohc_engine_storage::put_binary_blob(tx, &vector)?;
                        tx.execute(
                            "INSERT INTO ydoc_snapshots VALUES ('workspace','main','object',?1,?2,?3,40)",
                            params![head, f.binding.lineage_claim_id, vector],
                        )
                        .map_err(write_sql)
                    })
                    .unwrap();
            }
            _ => {}
        }
        file_matches_local(&mut f, "returned");
        let id = successor(&mut f);
        let before = rows(&f, &SUCCESSION_WRITES);
        let adopted = f.adopt();
        if damage != "none" {
            assert!(matches!(adopted, Err(ApplicationError::Conflict)), "{damage}: {adopted:?}");
            assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{damage}");
            continue;
        }
        adopted.unwrap();
        let coverage = vec![
            (1, Disposition::Receipt { receipt: covered.clone() }),
            (2, Disposition::Receipt { receipt: carried.clone() }),
        ];
        let (_, _, _, _, digest) = succession_row(&f, &id);
        assert_eq!(digest, coverage_digest(&f, &coverage));
        let covered_sequence: i64 = f
            .store
            .read_with(|conn| {
                conn.query_row("SELECT covered_outbox_sequence FROM live_owner_activations WHERE activation_id=?1", [&id], |r| r.get(0))
            })
            .unwrap();
        assert_eq!(covered_sequence, 2);
        assert_eq!(seeds(&f), vec![(id, 3)], "its seed follows the chain's entries");
    }
}

/// An abandoned seed is covered as Abandoned, and only in its strict
/// representation. The successor's own seed holds application; the
/// predecessor's abandoned one never does.
#[test]
fn a_successor_covers_an_abandoned_seed_and_holds_only_its_own() {
    for intact in [true, false] {
        let (mut f, seed, _) = seeded();
        let predecessor = f.cut.adoption_id.clone();
        let absent = JournalEvidence { receipts: vec![], absent: vec![seed] };
        reconcile(&mut f, 10, None, Some(&absent)).unwrap();
        release_parked(&mut f);
        returned(&mut f);
        file_matches_local(&mut f, "returned");
        if !intact {
            write(&mut f, "UPDATE owner_ydoc_outbox_entries SET terminal_blob_digest=update_digest");
        }
        let id = successor(&mut f);
        let before = rows(&f, &SUCCESSION_WRITES);
        if !intact {
            assert!(matches!(f.adopt(), Err(ApplicationError::Conflict)));
            assert_eq!(rows(&f, &SUCCESSION_WRITES), before);
            continue;
        }
        f.adopt().unwrap();
        let (_, _, _, _, digest) = succession_row(&f, &id);
        assert_eq!(digest, coverage_digest(&f, &[(1, Disposition::Abandoned)]));
        assert_eq!(seeds(&f), vec![(predecessor, 1), (id.clone(), 2)]);
        let hold = f
            .store
            .read_with(|conn| super::super::seed_hold(conn, "namespace", &f.binding))
            .unwrap();
        let own: String = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT delivery_id FROM owner_ydoc_outbox_entries WHERE json_extract(native_source_json,'$.adoptionId')=?1",
                    [&id],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert!(
            matches!(hold, Some(SeedHold::Pending { delivery, .. }) if delivery == own),
            "the successor's hold names its own seed"
        );
    }
}

/// Opus, round 3b delta, and Sol's round 4a ruling: two never-adopted
/// captures. While the first one's retirement settles the document, the
/// second can't adopt. Once the first releases, the second is stale: it
/// follows nothing while the first is the tail, so neither its registration
/// nor its adoption proceeds. A recapture follows the first and adopts first,
/// with no prefix. Its descriptor and row name the same predecessor, so an
/// unchanged recapture keeps its ID and resumes. A lineage never adopted
/// keeps its first adoption after released captures, and its seed lands
/// although released rows exist.
#[test]
fn adoption_waits_while_the_document_retires() {
    let mut f = imported_fixture();
    let first = capture_imported(&mut f, 1_000_000).unwrap().activation_id;
    offline_edit(&mut f, "Edited before the second capture", "second");
    let second = capture_imported(&mut f, 1_000_000).unwrap();
    assert_eq!(second.source.predecessor_activation_id, None);
    f.cut.adoption_id = first.clone();
    begin(&mut f, 10).unwrap();
    let before = rows(&f, &SUCCESSION_WRITES);
    assert!(matches!(capture_imported(&mut f, 1_000_000), Err(ApplicationError::Conflict)), "no capture while it retires");
    assert_eq!(rows(&f, &SUCCESSION_WRITES), before);
    f.cut.adoption_id = second.activation_id.clone();
    f.cut.source_moment_id = second.source.source_moment_id.clone();
    f.cut.source_digest = second.source.source_digest.clone();
    f.cut.source_byte_length = second.source.source_byte_length;
    f.cut.expected_local_sequence = second.source.native_head_sequence;
    let before = rows(&f, &SUCCESSION_WRITES);
    assert!(matches!(f.adopt(), Err(ApplicationError::Conflict)), "the document is retiring");
    assert_eq!(rows(&f, &SUCCESSION_WRITES), before);
    host_document(&mut f, true, false);
    f.cut.adoption_id = first.clone();
    assert!(matches!(release_through(&mut f, 10).unwrap(), Release::Released { boundary: None, .. }));
    returned(&mut f);
    // The adoption checks the predecessor itself: this handle names none.
    f.cut.adoption_id = second.activation_id.clone();
    let before = rows(&f, &SUCCESSION_WRITES);
    assert!(matches!(f.adopt(), Err(ApplicationError::Conflict)), "the stale capture never adopts");
    assert!(matches!(
        f._owner.register_activation(&mut f.store, "namespace".into(), retirement_host(), f.binding.clone(), second.activation_id.clone()),
        Err(ApplicationError::Conflict)
    ), "nor registers");
    assert_eq!(rows(&f, &SUCCESSION_WRITES), before);
    let recaptured = capture_imported(&mut f, 1_000_000).unwrap();
    assert_ne!(recaptured.activation_id, second.activation_id, "the same state follows the first now");
    assert_eq!(recaptured.source.predecessor_activation_id.as_deref(), Some(first.as_str()));
    f.handle = f
        ._owner
        .register_activation(&mut f.store, "namespace".into(), retirement_host(), f.binding.clone(), recaptured.activation_id.clone())
        .unwrap();
    f.cut.adoption_id = recaptured.activation_id.clone();
    assert!(!f.adopt().unwrap().adoption_replayed);
    assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 1);
    let (origin, predecessor, boundary, current, _) = succession_row(&f, &recaptured.activation_id);
    assert_eq!(origin.as_deref(), Some(recaptured.activation_id.as_str()), "its own origin");
    assert_eq!(predecessor, recaptured.source.predecessor_activation_id, "the row names its descriptor's predecessor");
    assert_eq!((boundary, current), (None, true));
    assert_eq!(seeds(&f), vec![(recaptured.activation_id.clone(), 1)]);
    assert_eq!(chain_tail(&f, "namespace").unwrap(), None);
    assert_eq!(
        capture_imported(&mut f, 1_000_000).unwrap().activation_id,
        recaptured.activation_id,
        "an unchanged recapture keeps its ID"
    );
    resume_imported(&mut f, &recaptured.activation_id, 1_000_000).expect("it resumes");
}

/// Round 3b's freeze holds: an ordinary owner delivery on a released lineage
/// is refused. Only the successor's own adoption appends, once its row holds
/// the lineage.
#[test]
fn only_the_successor_adoption_appends_to_a_released_lineage() {
    let mut f = imported_fixture();
    adopt_root(&mut f);
    release_parked(&mut f);
    returned(&mut f);
    offline_edit(&mut f, "Edited while stopped", "offline");
    let append = |f: &mut Fixture| {
        owner_outbox::append(
            &mut f.store,
            "workspace",
            owner_outbox::OwnerOutboxAppendInput {
                binding: f.binding.clone(),
                base_update: f.cut.baseline_bytes.clone(),
                append_key: "ordinary".into(),
                update: f.doc.encode_full_state(),
                limits: f.cut.outbox_limits.clone(),
                created_at_ms: 41,
            },
        )
    };
    assert!(matches!(append(&mut f), Err(owner_outbox::OwnerOutboxError::Frozen)));
    let id = successor(&mut f);
    assert!(matches!(append(&mut f), Err(owner_outbox::OwnerOutboxError::Frozen)), "registration alone holds nothing");
    f.adopt().unwrap();
    assert_eq!(seeds(&f), vec![(id, 1)]);
    append(&mut f).expect("the successor holds the lineage");
}

/// What enrollment recovery writes over each pending entry of the outbox it
/// recovers, with its totals.
const RECOVERY_TERMINAL: &str =
    "UPDATE owner_ydoc_outbox_entries SET pending=0,terminal_blob_digest=update_blob_digest,update_blob_digest=NULL,
       terminal_reason='stale-binding' WHERE pending=1;
     UPDATE owner_ydoc_outboxes SET pending_bytes=0,oldest_entry_at_ms=NULL";

/// Write a state the schema's checks refuse, as a damaged store could hold it.
fn write_unchecked(f: &mut Fixture, sql: &str) {
    let raw = rusqlite::Connection::open(f._scratch.join("engine.db")).unwrap();
    raw.pragma_update(None, "ignore_check_constraints", true).unwrap();
    raw.execute_batch(sql).unwrap();
}

/// Each row `sql` selects, so a step can be shown to leave them as they were.
fn query_rows(f: &Fixture, sql: &str) -> Vec<String> {
    f.store
        .read_with(|conn| {
            let mut statement = conn.prepare(sql)?;
            let columns = statement.column_count();
            let mut query = statement.query([])?;
            let mut rows = Vec::new();
            while let Some(row) = query.next()? {
                let values = (0..columns)
                    .map(|column| row.get::<_, rusqlite::types::Value>(column))
                    .collect::<Result<Vec<_>, _>>()?;
                rows.push(format!("{values:?}"));
            }
            Ok::<_, rusqlite::Error>(rows)
        })
        .unwrap()
}

/// Every terminal entry with the bytes it keeps.
fn terminal_entries(f: &Fixture) -> Vec<String> {
    query_rows(
        f,
        "SELECT e.*,b.byte_length,b.bytes FROM owner_ydoc_outbox_entries e
         LEFT JOIN binary_blobs b ON b.sha256=e.terminal_blob_digest
         WHERE e.terminal_reason IS NOT NULL ORDER BY e.sequence",
    )
}

/// The Refused disposition of each terminal entry, as coverage records it.
fn refusals(f: &Fixture) -> Vec<(i64, Disposition)> {
    f.store
        .read_with(|conn| {
            conn.prepare(
                "SELECT sequence,delivery_id,update_digest,terminal_reason FROM owner_ydoc_outbox_entries
                 WHERE terminal_reason IS NOT NULL ORDER BY sequence",
            )?
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    Disposition::Refused { delivery_id: r.get(1)?, update_digest: r.get(2)?, terminal_reason: r.get(3)? },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
}

/// A host's terminal refusal of `delivery`, through the refusal path.
fn refuse(f: &mut Fixture, delivery: &str, reason: &str) {
    let (outbox_id, update_digest): (String, String) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id,update_digest FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                [delivery],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    let input = owner_outbox::OwnerOutboxRefuseInput {
        outbox_id,
        delivery_id: delivery.into(),
        update_digest,
        reason: reason.into(),
    };
    let refused = f
        .store
        .write_with(&NoFaults, |tx| owner_outbox::refuse_entry_in_tx(tx, "workspace", &input, 40).map(|_| ()))
        .unwrap();
    assert!(matches!(refused, TxnOutcome::Committed(())));
}

/// Quarantine the document's one outbox.
fn quarantine(f: &mut Fixture, reason: &str) {
    let outbox_id: String = f
        .store
        .read_with(|conn| conn.query_row("SELECT outbox_id FROM owner_ydoc_outboxes", [], |r| r.get(0)))
        .unwrap();
    owner_outbox::quarantine(
        &mut f.store,
        "workspace",
        owner_outbox::OwnerOutboxQuarantineInput { outbox_id, reason: reason.into(), observed_binding: None },
        5,
    )
    .unwrap();
}

/// A current root activation whose native update a host refused. With
/// `dependent`, an owner write that built on that update follows it, and the
/// refusal ends it too.
fn refused_root(dependent: bool) -> Fixture {
    let mut f = imported_fixture();
    adopt_root(&mut f);
    let refused = native_tail_edit(&mut f, "# Refused\n", 11);
    if dependent {
        let update = f
            .doc
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "# Refused, then built on\n")
            .unwrap();
        owner_outbox::append(
            &mut f.store,
            "workspace",
            owner_outbox::OwnerOutboxAppendInput {
                binding: f.binding.clone(),
                base_update: f.cut.baseline_bytes.clone(),
                append_key: "dependent".into(),
                update,
                limits: f.cut.outbox_limits.clone(),
                created_at_ms: 12,
            },
        )
        .unwrap();
    }
    refuse(&mut f, &refused.delivery_id, "terminal-source-refused");
    f
}

/// Release the root once parked, and bring its document back with its file
/// at the local state.
fn release_and_return(f: &mut Fixture) {
    release_parked(f);
    returned(f);
    file_matches_local(f, "returned");
}

/// Sol's round 4a ruling: a refusal belongs to its delivery, never to the
/// document's lineage. A native update and the owner write that built on it,
/// refused through the host's refusal path; an adoption seed refused the same
/// way; and an update enrollment recovery ended: each releases, and a
/// successor then adopts. Coverage records each as Refused, and the entry
/// keeps its terminal bytes, provenance and reason.
#[test]
fn a_refusal_ends_its_delivery_and_never_its_lineage() {
    for case in ["native update", "adoption seed", "enrollment recovery"] {
        let mut f = match case {
            "native update" => refused_root(true),
            "adoption seed" => refused_seed(),
            _ => {
                let mut f = imported_fixture();
                adopt_root(&mut f);
                native_tail_edit(&mut f, "# Recovered\n", 11);
                write(&mut f, RECOVERY_TERMINAL);
                f
            }
        };
        release_and_return(&mut f);
        let refused = refusals(&f);
        let reasons: Vec<&str> = refused
            .iter()
            .map(|(_, refusal)| match refusal {
                Disposition::Refused { terminal_reason, .. } => terminal_reason.as_str(),
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(
            reasons,
            match case {
                "native update" => vec!["terminal-source-refused", "An earlier write was not accepted."],
                "adoption seed" => vec!["terminal-source-refused"],
                _ => vec!["stale-binding"],
            },
            "{case}"
        );
        let kept = terminal_entries(&f);
        let id = successor(&mut f);
        f.adopt().unwrap();
        let (_, _, _, current, digest) = succession_row(&f, &id);
        assert!(current, "{case}");
        assert_eq!(digest, coverage_digest(&f, &refused), "{case}");
        assert_eq!(terminal_entries(&f), kept, "{case}: terminal bytes, provenance and reasons stay");
        assert_eq!(seeds(&f).last(), Some(&(id, refused.len() as i64 + 1)), "{case}");
    }
}

/// The append key a native source's entry carries.
fn native_append_key(source: &owner_outbox::OwnerOutboxNativeSource) -> String {
    match source.origin {
        owner_outbox::OwnerOutboxNativeOrigin::AdoptionSeed => format!(
            "owner-adoption:{}",
            hex_sha256(&serde_json::to_vec(&(&source.adoption_id, source.native_sequence, &source.update_digest)).unwrap())
        ),
        _ => format!("adopted-local:{}", hex_sha256(&serde_json::to_vec(source).unwrap())),
    }
}

/// Write `source` and its append key over the entry at `sequence`.
fn write_source(f: &mut Fixture, sequence: i64, source: &owner_outbox::OwnerOutboxNativeSource) {
    let (key, json) = (native_append_key(source), serde_json::to_string(source).unwrap());
    write(f, &format!(
        "UPDATE owner_ydoc_outbox_entries SET append_key='{key}',native_source_json='{json}' WHERE sequence={sequence}"
    ));
}

/// Rewrite the native source of the entry at sequence 1, keyed as its append
/// key would be.
fn rewrite_source(f: &mut Fixture, change: impl FnOnce(&mut owner_outbox::OwnerOutboxNativeSource)) {
    let (key, json): (String, String) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT append_key,native_source_json FROM owner_ydoc_outbox_entries WHERE sequence=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    let mut source: owner_outbox::OwnerOutboxNativeSource = serde_json::from_str(&json).unwrap();
    assert_eq!(key, native_append_key(&source), "the entry's own key");
    change(&mut source);
    write_source(f, 1, &source);
}

/// A damage to a refused entry, whether the shared predicate itself must
/// refuse it, and whether release must.
type RefusalDamage = (&'static str, bool, bool, fn(&mut Fixture));

/// A fixture whose one entry a host refused.
type RefusedFixture = (&'static str, fn() -> Fixture);

/// Each condition of the strict Refused representation, failing alone, keeps
/// a refused native update or adoption seed from being Refused. Release
/// refuses it, the shared predicate refuses it, and succession refuses it
/// with no writes. Coverage also refuses a native source outside the
/// released chain.
#[test]
fn only_the_strict_representation_is_refused() {
    const ENTRY: &str = "UPDATE owner_ydoc_outbox_entries SET";
    let damages: [RefusalDamage; 16] = [
        ("pending", true, true, |f| write_unchecked(f, &format!("{ENTRY} pending=1"))),
        ("saved receipt", true, true, |f| write_unchecked(f, &format!(
            "{ENTRY} accepted_receipt_json=json_object('deliveryId',delivery_id,'updateDigest',update_digest,
               'journalCursor',5,'acceptingHostEpoch',1)"
        ))),
        ("accepted history", true, true, |f| write(f, &format!(
            "INSERT INTO live_accepted_updates SELECT 'namespace','workspace','main','object',o.lineage_claim_id,9,9,
               e.delivery_id,'{{}}',e.update_digest,1,1,'{}'
             FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o USING(outbox_id)",
            "e".repeat(64)
        ))),
        ("application", true, true, |f| write(f,
            "INSERT INTO live_device_update_applications(relay_database_namespace,workspace_id,delivery_id,main_version_id,
               object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,update_digest,
               update_byte_length,journal_cursor,accepting_host_epoch,principal_kind,principal_id,received_at_ms,
               first_seen_count,local_ydoc_sequence,applied_host_id,applied_host_epoch,applied_instance_id,
               applied_connection_id)
             SELECT 'namespace','workspace',e.delivery_id,'main','object',o.lineage_claim_id,'owner.md','[\"owner.md\"]',0,
               e.update_digest,e.byte_length,9,1,'owner','owner',9,0,1,'host',1,'instance','connection'
             FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o USING(outbox_id)",
        )),
        ("no terminal blob", true, true, |f| write(f, &format!("{ENTRY} terminal_blob_digest=NULL"))),
        ("another terminal blob", true, true, |f| {
            // Other bytes of the same length.
            let mut bytes: Vec<u8> = f
                .store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT b.bytes FROM owner_ydoc_outbox_entries e JOIN binary_blobs b ON b.sha256=e.terminal_blob_digest",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap();
            let last = bytes.len() - 1;
            bytes[last] ^= 1;
            f.store
                .write_with(&NoFaults, |tx| {
                    let digest = dohc_engine_storage::put_binary_blob(tx, &bytes)?;
                    tx.execute("UPDATE owner_ydoc_outbox_entries SET terminal_blob_digest=?1", [digest])
                        .map_err(write_sql)?;
                    Ok::<_, ApplicationError>(())
                })
                .unwrap();
        }),
        ("terminal length", true, true, |f| write(f, &format!("{ENTRY} byte_length=byte_length+1"))),
        ("surviving update blob", true, true, |f| write_unchecked(f, &format!("{ENTRY} update_blob_digest=update_digest"))),
        ("invalid reason", true, true, |f| write(f, &format!("{ENTRY} terminal_reason='refused'||char(10)"))),
        ("oversized reason", true, true, |f| write_unchecked(f, &format!("{ENTRY} terminal_reason=printf('%.257c','r')"))),
        ("release reason", true, true, |f| write(f, &format!("{ENTRY} terminal_reason='activation-released'"))),
        ("native sequence", true, true, |f| write(f, &format!(
            "{ENTRY} native_source_json=json_set(native_source_json,'$.nativeSequence',99)"
        ))),
        ("append key", true, true, |f| write(f, &format!("{ENTRY} append_key='adopted-local:'||printf('%.64c','f')"))),
        ("source lineage", true, true, |f| {
            rewrite_source(f, |source| source.binding.lineage_claim_id = "f".repeat(64))
        }),
        ("native provenance", true, true, |f| write(f,
            "UPDATE ydoc_updates SET recorded_at_ms=recorded_at_ms+1 WHERE seq=(SELECT
               json_extract(native_source_json,'$.nativeSequence') FROM owner_ydoc_outbox_entries)",
        )),
        ("outside the chain", false, false, |f| {
            // Released activations of the lineage that follow each other, so
            // the root stays the chain's one tail.
            release_unadopted(f, "namespace", "object", "stray", None);
            release_unadopted(f, "namespace", "object", "stray-back", Some("stray"));
            write(f, "UPDATE live_owner_activations SET predecessor_activation_id='stray-back' WHERE activation_id='stray'");
            rewrite_source(f, |source| source.adoption_id = "stray".into());
        }),
    ];
    let fixtures: [RefusedFixture; 2] = [("native update", || refused_root(false)), ("adoption seed", refused_seed)];
    for ((kind, fixture), (case, predicate, release, damage)) in
        fixtures.into_iter().flat_map(|fixture| damages.map(|damage| (fixture, damage)))
    {
        // A seed has no journal row to damage.
        if kind == "adoption seed" && case == "native provenance" {
            continue;
        }
        let case = format!("{kind}, {case}");
        if release {
            let mut f = fixture();
            damage(&mut f);
            host_document(&mut f, true, true);
            let before = rows(&f, &RELEASE_WRITES);
            let released = release_through(&mut f, 10);
            assert!(!matches!(released, Ok(Release::Released { .. })), "{case}: {released:?}");
            assert_eq!(rows(&f, &RELEASE_WRITES), before, "{case}");
        }
        let mut f = fixture();
        release_and_return(&mut f);
        successor(&mut f);
        damage(&mut f);
        if predicate {
            let outbox: String = f
                .store
                .read_with(|conn| conn.query_row("SELECT outbox_id FROM owner_ydoc_outboxes", [], |r| r.get(0)))
                .unwrap();
            let refused = f.store.read_with(|conn| {
                retirement::refused_entry(conn, "namespace", &f.key, &f.binding.lineage_claim_id, &outbox, 1)
            });
            assert!(!matches!(refused, Ok(Some(_))), "{case}: {refused:?}");
        }
        let before = rows(&f, &SUCCESSION_WRITES);
        let adopted = f.adopt();
        assert!(adopted.is_err(), "{case}: {adopted:?}");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}");
    }
}

/// A root whose adoption seed a host refused through the refusal path.
fn refused_seed() -> Fixture {
    let (mut f, seed, _) = seeded();
    refuse(&mut f, &seed, "terminal-source-refused");
    f
}

/// A damage to a refused seed's proof, and whether release must refuse it.
type SeedDamage = (&'static str, bool, fn(&mut Fixture));

/// The capture of the activation the entry at sequence 1 names.
const SEED_CAPTURE: &str = "FROM ydoc_owner_activation_sources WHERE activation_id=(SELECT
    json_extract(native_source_json,'$.adoptionId') FROM owner_ydoc_outbox_entries WHERE sequence=1)";

/// Sol's round 4a ruling: a refused seed has no journal row, so the capture
/// of the activation it names is its proof. That activation adopted the
/// lineage, and its capture is present and holds the seed's native sequence
/// and full state. Each damage leaves the seed a valid entry under a
/// recomputed append key, with its bytes and refusal as they were. Release,
/// the shared predicate and succession each refuse it, with no writes. A seed
/// naming another activation is not the retiring activation's entry, so only
/// the predicate and succession judge it.
#[test]
fn a_refused_seed_is_proven_by_its_capture() {
    let damages: [SeedDamage; 5] = [
        ("native sequence", true, |f| rewrite_source(f, |source| source.native_sequence += 1)),
        ("no capture", true, |f| write(f, &format!("DELETE {SEED_CAPTURE}"))),
        ("captured state", true, |f| write(f, &format!(
            "UPDATE ydoc_owner_activation_sources SET full_state_digest=lineage_claim_id
             WHERE activation_id=(SELECT activation_id {SEED_CAPTURE})"
        ))),
        ("captured sequence", true, |f| write(f, &format!(
            "UPDATE ydoc_owner_activation_sources SET descriptor_json=json_set(descriptor_json,'$.nativeHeadSequence',
               json_extract(descriptor_json,'$.nativeHeadSequence')+1) WHERE activation_id=(SELECT activation_id {SEED_CAPTURE})"
        ))),
        ("unadopted activation", false, |f| {
            // The same capture under an activation that never adopted.
            write(f, &format!(
                "INSERT INTO ydoc_owner_activation_sources SELECT 'stray',relay_database_namespace,workspace_id,version_id,
                   object_id,lineage_claim_id,source_moment_id,source_digest,full_state_digest,descriptor_json {SEED_CAPTURE}"
            ));
            rewrite_source(f, |source| source.adoption_id = "stray".into());
        }),
    ];
    for (case, release, damage) in damages {
        if release {
            let mut f = refused_seed();
            damage(&mut f);
            host_document(&mut f, true, true);
            let before = rows(&f, &RELEASE_WRITES);
            let released = release_through(&mut f, 10);
            assert!(!matches!(released, Ok(Release::Released { .. })), "{case}: {released:?}");
            assert_eq!(rows(&f, &RELEASE_WRITES), before, "{case}");
        }
        let mut f = refused_seed();
        release_and_return(&mut f);
        successor(&mut f);
        damage(&mut f);
        let outbox: String = f
            .store
            .read_with(|conn| conn.query_row("SELECT outbox_id FROM owner_ydoc_outboxes", [], |r| r.get(0)))
            .unwrap();
        let refused = f.store.read_with(|conn| {
            retirement::refused_entry(conn, "namespace", &f.key, &f.binding.lineage_claim_id, &outbox, 1)
        });
        assert!(matches!(refused, Ok(None)), "{case}: {refused:?}");
        let before = rows(&f, &SUCCESSION_WRITES);
        let adopted = f.adopt();
        assert!(adopted.is_err(), "{case}: {adopted:?}");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}");
    }
}

/// Neither class follows from a reason string. The journal's absence ends
/// only a seed, and a native update shaped as an abandoned seed, reason and
/// all, still refuses its release.
#[test]
fn a_reason_alone_abandons_nothing() {
    let mut f = imported_fixture();
    adopt_root(&mut f);
    let entry = native_tail_edit(&mut f, "# Absent\n", 11);
    let absent = JournalEvidence { receipts: vec![], absent: vec![entry.delivery_id] };
    let before = rows(&f, &RELEASE_WRITES);
    assert!(matches!(reconcile(&mut f, 10, None, Some(&absent)), Err(ApplicationError::Conflict)));
    assert_eq!(rows(&f, &RELEASE_WRITES), before);
    write(
        &mut f,
        "UPDATE owner_ydoc_outbox_entries SET pending=0,update_blob_digest=NULL,terminal_blob_digest=NULL,
           terminal_reason='activation-released';
         UPDATE owner_ydoc_outboxes SET pending_bytes=0,oldest_entry_at_ms=NULL",
    );
    host_document(&mut f, true, true);
    let before = rows(&f, &RELEASE_WRITES);
    assert!(matches!(release_through(&mut f, 10), Err(ApplicationError::Conflict)));
    assert_eq!(rows(&f, &RELEASE_WRITES), before);
}

/// A root whose seed the relay refused on provenance, quarantining its
/// outbox. The journal proved the seed absent, so reconciliation abandoned
/// it, and Stop released the root. Returns the root.
fn quarantined_seed_released() -> (Fixture, String) {
    let (mut f, seed, _) = seeded();
    let root = f.cut.adoption_id.clone();
    quarantine(&mut f, "provenance-refused");
    let absent = JournalEvidence { receipts: vec![], absent: vec![seed] };
    reconcile(&mut f, 10, None, Some(&absent)).unwrap();
    release_and_return(&mut f);
    (f, root)
}

/// Sol's B1: the successor reopens the outbox its predecessor's refused seed
/// quarantined, in its adoption: active again, with its entries and sequence
/// kept and the successor's seed next. A failure before commit rolls the
/// reopening back with the adoption, and a replay after a lost reply writes
/// nothing.
#[test]
fn a_successor_reopens_the_outbox_a_refused_seed_quarantined() {
    let (mut f, root) = quarantined_seed_released();
    let id = successor(&mut f);
    let abandoned = query_rows(&f, "SELECT * FROM owner_ydoc_outbox_entries");
    let before = rows(&f, &SUCCESSION_WRITES);
    let failed = adopt_owner_committed(&mut f.store, &f.handle, f.cut.clone(), 1_000_000, 100, 10, &NoFaults, None, |tx, _, _, _| {
        let state: String = tx
            .query_row("SELECT state FROM owner_ydoc_outboxes", [], |r| r.get(0))
            .map_err(read_sql)?;
        assert_eq!(state, "active", "reopened before the commit");
        Err(ApplicationError::Conflict)
    });
    assert!(matches!(failed, Err(ApplicationError::Conflict)));
    assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "the reopening rolls back with the adoption");
    f.adopt().unwrap();
    assert_eq!(
        query_rows(&f, "SELECT state,quarantine_reason,observed_binding_json FROM owner_ydoc_outboxes"),
        query_rows(&f, "SELECT 'active',NULL,NULL"),
        "the same outbox, open again"
    );
    let (_, _, _, _, digest) = succession_row(&f, &id);
    assert_eq!(digest, coverage_digest(&f, &[(1, Disposition::Abandoned)]));
    assert_eq!(seeds(&f), vec![(root, 1), (id, 2)]);
    assert_eq!(query_rows(&f, "SELECT * FROM owner_ydoc_outbox_entries WHERE sequence=1"), abandoned);
    let written = rows(&f, &SUCCESSION_WRITES);
    assert!(f.adopt().unwrap().adoption_replayed);
    assert_eq!(rows(&f, &SUCCESSION_WRITES), written, "a replay adds no activation and no seed");
}

/// Sol's B1, its limits: a successor reopens only a relay refusal's
/// quarantine, at its exact binding, with nothing pending and a seed
/// strictly abandoned. A restore or binding quarantine, like every other
/// damage, refuses the succession with no writes.
#[test]
fn a_successor_reopens_no_other_quarantine() {
    for reason in ["delivery-conflict", "capacity-refused", "invalid-update"] {
        let mut f = quarantined_seed_released().0;
        successor(&mut f);
        write(
            &mut f,
            &format!("UPDATE owner_ydoc_outboxes SET quarantine_reason='{reason}'"),
        );
        f.adopt()
            .unwrap_or_else(|error| panic!("{reason}: {error:?}"));
        assert_eq!(
            query_rows(
                &f,
                "SELECT state,quarantine_reason FROM owner_ydoc_outboxes"
            ),
            query_rows(&f, "SELECT 'active',NULL"),
            "{reason}"
        );
    }
    let cases: [(&str, &str); 8] = [
        ("selectors", "UPDATE owner_ydoc_outboxes SET selector_paths_json='[\"owner.md\",\"other.md\"]'"),
        ("restore", "UPDATE owner_ydoc_outboxes SET quarantine_reason='restore-fenced'"),
        ("binding", "UPDATE owner_ydoc_outboxes SET quarantine_reason='stale-binding'"),
        ("binding changed", "UPDATE owner_ydoc_outboxes SET quarantine_reason='binding-changed'"),
        (
            "conflicting observed binding",
            "UPDATE owner_ydoc_outboxes SET observed_binding_json=json_object('workspaceId','workspace',
               'mainVersionId','main','objectId','object','lineageClaimId',lineage_claim_id,'currentPath','other.md',
               'selectorPaths',json_array('other.md'),'restoreFenceGeneration',0)",
        ),
        ("pending totals", "UPDATE owner_ydoc_outboxes SET pending_bytes=5,oldest_entry_at_ms=1"),
        ("pending entry", "UPDATE owner_ydoc_outbox_entries SET pending=1,terminal_reason=NULL,update_blob_digest=update_digest"),
        ("no abandoned seed", ""),
    ];
    for (case, damage) in cases {
        let mut f = if damage.is_empty() {
            // A provenance quarantine over a refused update, with no seed.
            let mut f = refused_root(false);
            quarantine(&mut f, "provenance-refused");
            release_and_return(&mut f);
            f
        } else {
            quarantined_seed_released().0
        };
        successor(&mut f);
        if !damage.is_empty() {
            write(&mut f, damage);
        }
        let before = rows(&f, &SUCCESSION_WRITES);
        let adopted = f.adopt();
        assert!(matches!(adopted, Err(ApplicationError::Conflict)), "{case}: {adopted:?}");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}");
    }
}

/// The relay journal's admission of one accepted owner delivery.
fn owner_event(binding: &LiveObjectBinding, receipt: LiveUpdateReceipt, update_bytes: Vec<u8>) -> AdmittedLiveUpdate {
    AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt,
                binding: binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner { principal_id: "owner".into() },
                received_at_ms: 4,
            },
            first_seen: vec![],
            canonical_version: None,
            author_snapshot: None,
            first_seen_deletes: None,
            checkpoint_coverage: None,
        },
        update_bytes,
    }
}

/// The enrolled owner's draft `index` over the local state, through the draft
/// writer, with the accepted state it was written at and its update.
fn owner_draft(
    store: &mut EngineStore,
    binding: &LiveObjectBinding,
    index: usize,
) -> Result<(owner_outbox::accepted::OwnerAcceptedState, owner_outbox::OwnerOutboxAppendResult, Vec<u8>), owner_outbox::OwnerOutboxError> {
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let state = store.read_with(|conn| owner_outbox::accepted::read_state_in(conn, binding, "namespace"))?;
    let draft = Ydoc::wire();
    draft
        .apply(&store.read_with(|conn| durable::load_doc_in(conn, &key)).unwrap().encode_full_state())
        .unwrap();
    let update = draft.richdoc_append_paragraph(&format!("Draft {index}"));
    let entry = owner_outbox::draft::append_draft_cached(
        store,
        &mut WriterDocCache::new(),
        "workspace",
        owner_outbox::draft::OwnerDraftAppendInput {
            person_edit: false,
            binding: binding.clone(),
            expected_revision: state.revision,
            append_key: format!("draft-{index}"),
            update: update.clone(),
            now_ms: 20,
            agent_declaration: None,
            automation_declaration: None,
        },
        &NoFaults,
    )?;
    Ok((state, entry, update))
}

/// The owner's delivery of one draft per `plan` entry, through the real
/// writers, before any host registered the document: enrollment at the local
/// state, then each draft accepted (its frame applied, then acknowledged) or
/// refused as automation delivery refuses one. Each refusal lands before the
/// next draft, so no later draft builds on refused bytes. Returns the
/// accepted drafts' events.
fn owner_drafts(store: &mut EngineStore, binding: &LiveObjectBinding, plan: &[bool]) -> Vec<AdmittedLiveUpdate> {
    use owner_outbox::accepted::{apply_frame_in_tx, OwnerAcceptedFrameInput};
    use owner_outbox::enrollment::{capture_in, enroll_in_tx, OwnerEnrollmentInput};
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let local = store.read_with(|conn| durable::load_doc_in(conn, &key)).unwrap();
    let input = OwnerEnrollmentInput {
        binding: binding.clone(),
        relay_database_namespace: "namespace".into(),
        captured: store.read_with(|conn| capture_in(conn, binding)).unwrap(),
        journal_cursor: 0,
        checkpoint: local.encode_full_state(),
        host_vector: local.encode_state_vector(),
        recovery: false,
    };
    let limits = owner_outbox::OwnerOutboxLimits { max_pending_bytes: 1_000_000, max_pending_age_ms: 100_000 };
    store.write_with(&NoFaults, |tx| enroll_in_tx(tx, "workspace", &input, &limits, 10)).unwrap();
    let mut events = Vec::new();
    for (index, accepted) in plan.iter().enumerate() {
        let (state, entry, update) = owner_draft(store, binding, index).unwrap();
        if !accepted {
            let refusal = owner_outbox::OwnerOutboxRefuseInput {
                outbox_id: entry.outbox_id,
                delivery_id: entry.delivery_id,
                update_digest: entry.update_digest,
                reason: "authority-refused".into(),
            };
            store
                .write_with(&NoFaults, |tx| owner_outbox::refuse_entry_in_tx(tx, "workspace", &refusal, 25))
                .unwrap();
            continue;
        }
        let receipt = receipt_of(&entry.delivery_id, &entry.update_digest, state.accepted_cursor + 1);
        let frame = OwnerAcceptedFrameInput {
            binding: binding.clone(),
            relay_database_namespace: "namespace".into(),
            expected_revision: state.revision,
            expected_native_head_sequence: state.native_head_sequence,
            previous_accepted_cursor: state.accepted_cursor,
            journal_cursor: receipt.journal_cursor,
            update_bytes: update.clone(),
        };
        store.write_with(&NoFaults, |tx| apply_frame_in_tx(tx, "workspace", &frame, 30)).unwrap();
        owner_outbox::acknowledge(
            store,
            "workspace",
            &entry.outbox_id,
            &[owner_outbox::OwnerDeliveryReceipt {
                delivery_id: receipt.delivery_id.clone(),
                update_digest: receipt.update_digest.clone(),
                journal_cursor: receipt.journal_cursor,
                accepting_host_epoch: receipt.accepting_host_epoch,
            }],
        )
        .unwrap();
        events.push(owner_event(binding, receipt, update));
    }
    events
}

/// A document whose enrolled owner delivered `plan`'s drafts before its host
/// registered it, with the cut the relay's journal gives its first adoption.
fn enrolled_drafts(plan: &[bool]) -> Fixture {
    let mut events = Vec::new();
    let mut f = Fixture::new_before_host(|store, binding| events = owner_drafts(store, binding, plan));
    f.cut.expected_local_sequence = f
        .store
        .read_with(|conn| conn.query_row("SELECT head_update_seq FROM ydoc_docs WHERE object_id='object'", [], |r| r.get(0)))
        .unwrap();
    f.cut.terminal_receipt = events.last().map(|event| event.metadata.accepted.receipt.clone());
    f.cut.events = events;
    f
}

/// The outbox sequence an activation's adoption covered.
fn covered_sequence(f: &Fixture, id: &str) -> i64 {
    f.store
        .read_with(|conn| {
            conn.query_row("SELECT covered_outbox_sequence FROM live_owner_activations WHERE activation_id=?1", [id], |r| r.get(0))
        })
        .unwrap()
}

/// The coverage a first adoption of `plan`'s drafts records: each accepted
/// draft's receipt from the cut, and each refusal.
fn draft_coverage(f: &Fixture, plan: &[bool]) -> Vec<(i64, Disposition)> {
    let mut receipts = f.cut.events.iter().map(|event| event.metadata.accepted.receipt.clone());
    let mut refused = refusals(f).into_iter();
    plan.iter()
        .zip(1..)
        .map(|(accepted, sequence)| {
            if *accepted {
                (sequence, Disposition::Receipt { receipt: receipts.next().unwrap() })
            } else {
                refused.next().unwrap()
            }
        })
        .collect()
}

/// Reopen the fixture's store, as after a restart.
fn reopen(f: &mut Fixture) {
    f.store = EngineStore::open(&f._scratch.join("engine.db"), 0).unwrap();
}

/// Opus N4 and Sol's ruling: a first adoption accounts for every outbox
/// entry through its terminal sequence, as an Owner receipt from its cut or a
/// strict refusal. An enrolled owner's drafts, through the real writers: one
/// refused alone, and one accepted, one refused, and one written after the
/// refusal and accepted. Coverage records each, counts all of them, and
/// leaves each refusal terminal with its bytes and provenance. An independent
/// write still appends after it, and a replay after reopening the store finds
/// the same coverage and writes nothing.
#[test]
fn a_first_adoption_accounts_for_an_enrolled_owners_refused_draft() {
    for plan in [&[false][..], &[true, false, true]] {
        let mut f = enrolled_drafts(plan);
        let kept = terminal_entries(&f);
        assert_eq!(refusals(&f).len(), 1, "{plan:?}");
        assert!(!f.adopt().unwrap().adoption_replayed, "{plan:?}");
        let id = f.cut.adoption_id.clone();
        let (_, _, _, current, digest) = succession_row(&f, &id);
        assert!(current, "{plan:?}");
        assert_eq!(digest, coverage_digest(&f, &draft_coverage(&f, plan)), "{plan:?}");
        assert_eq!(covered_sequence(&f, &id), plan.len() as i64, "{plan:?}");
        assert_eq!(terminal_entries(&f), kept, "{plan:?}: the refusal stays terminal");
        let (_, independent, _) = owner_draft(&mut f.store, &f.binding, plan.len()).expect("an independent write");
        assert_eq!(independent.sequence, plan.len() as i64 + 1, "{plan:?}");
        reopen(&mut f);
        let written = rows(&f, &SUCCESSION_WRITES);
        assert!(f.adopt().unwrap().adoption_replayed, "{plan:?}");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), written, "{plan:?}: replay writes nothing");
    }
}

/// The same refusal through Stop: a capture of the never-adopted lineage
/// retires and releases, and the recapture that follows it resumes and
/// adopts first, accounting for the refused draft.
#[test]
fn a_first_adoption_after_stop_accounts_for_a_refused_draft() {
    let mut f = imported_source_fixture(enrolled_drafts(&[false]));
    let kept = terminal_entries(&f);
    let first = capture_imported(&mut f, 1_000_000).unwrap().activation_id;
    f.cut.adoption_id = first.clone();
    begin(&mut f, 10).unwrap();
    host_document(&mut f, true, false);
    assert!(matches!(release_through(&mut f, 10).unwrap(), Release::Released { boundary: None, .. }));
    returned(&mut f);
    let next = capture_imported(&mut f, 1_000_000).unwrap();
    assert_eq!(next.source.predecessor_activation_id.as_deref(), Some(first.as_str()));
    f.handle = f
        ._owner
        .register_activation(&mut f.store, "namespace".into(), retirement_host(), f.binding.clone(), next.activation_id.clone())
        .unwrap();
    resume_imported(&mut f, &next.activation_id, 1_000_000).expect("it resumes before any adoption");
    f.cut.adoption_id = next.activation_id.clone();
    assert!(!f.adopt().unwrap().adoption_replayed);
    let (origin, predecessor, _, current, digest) = succession_row(&f, &next.activation_id);
    assert_eq!(origin.as_deref(), Some(next.activation_id.as_str()), "its own origin");
    assert_eq!(predecessor.as_deref(), Some(first.as_str()));
    assert!(current);
    assert_eq!(digest, coverage_digest(&f, &refusals(&f)));
    assert_eq!(covered_sequence(&f, &next.activation_id), 1);
    assert_eq!(terminal_entries(&f), kept, "the refusal stays terminal");
    let (_, independent, _) = owner_draft(&mut f.store, &f.binding, 1).expect("an independent write");
    assert_eq!(independent.sequence, 2);
    reopen(&mut f);
    let written = rows(&f, &SUCCESSION_WRITES);
    assert!(f.adopt().unwrap().adoption_replayed);
    assert_eq!(rows(&f, &SUCCESSION_WRITES), written, "replay writes nothing");
}

/// Make the refused draft at sequence 2 a native entry of an activation the
/// lineage never adopted, keyed as its append key would be. It refuses the
/// journal row and bytes of the first accepted draft, so a native update's
/// provenance holds and only its adoption can refuse it; a seed has no
/// capture to prove it.
fn unadopted_source(f: &mut Fixture, seed: bool) {
    type Journaled = (String, Option<String>, Option<String>, Option<String>, Option<i64>, i64);
    let (update_digest, actor_origin_id, actor_kind, on_behalf_of, chain_depth, recorded_at_ms): Journaled = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT update_blob_sha256,actor_origin_id,actor_kind,on_behalf_of,chain_depth,recorded_at_ms
                 FROM ydoc_updates WHERE object_id='object' AND seq=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
        })
        .unwrap();
    write(f, &format!(
        "UPDATE owner_ydoc_outbox_entries SET draft_binding_revision=NULL,update_digest='{update_digest}',
           terminal_blob_digest='{update_digest}',byte_length=(SELECT byte_length FROM binary_blobs WHERE sha256='{update_digest}')
         WHERE sequence=2"
    ));
    let origin = if seed {
        owner_outbox::OwnerOutboxNativeOrigin::AdoptionSeed
    } else {
        owner_outbox::OwnerOutboxNativeOrigin::NativeUpdate { actor_origin_id, actor_kind, on_behalf_of, chain_depth, recorded_at_ms }
    };
    let source = owner_outbox::OwnerOutboxNativeSource {
        binding: f.binding.clone(),
        adoption_id: "never-adopted".into(),
        native_sequence: 1,
        update_digest,
        origin,
    };
    write_source(f, 2, &source);
}

/// Each first-adoption coverage requirement, failing alone over an enrolled
/// owner's accepted, refused and accepted drafts, refuses with no writes:
/// the strict refusal, no refused native update or seed, no terminal
/// evidence beside an accepted receipt, receipt order across the refusal,
/// and capacity that counts the refusal.
#[test]
fn a_first_adoption_refuses_what_its_coverage_cannot_account_for() {
    let cases: [SuccessionDamage; 8] = [
        ("no terminal blob", |f| write(f, "UPDATE owner_ydoc_outbox_entries SET terminal_blob_digest=NULL WHERE sequence=2")),
        ("invalid reason", |f| write(f, "UPDATE owner_ydoc_outbox_entries SET terminal_reason='refused'||char(10) WHERE sequence=2")),
        ("saved receipt", |f| write_unchecked(f,
            "UPDATE owner_ydoc_outbox_entries SET accepted_receipt_json=json_object('deliveryId',delivery_id,
               'updateDigest',update_digest,'journalCursor',5,'acceptingHostEpoch',1) WHERE sequence=2",
        )),
        ("native refusal", |f| unadopted_source(f, false)),
        ("seed refusal", |f| unadopted_source(f, true)),
        ("terminal beside a receipt", |f| write_unchecked(f,
            "UPDATE owner_ydoc_outbox_entries SET terminal_reason='authority-refused' WHERE sequence=1",
        )),
        ("receipt order", |f| {
            // The journal accepted the third draft before the first.
            let (mut first, mut third) = (f.cut.events[0].clone(), f.cut.events[1].clone());
            let cursors = (first.metadata.accepted.receipt.journal_cursor, third.metadata.accepted.receipt.journal_cursor);
            first.metadata.accepted.receipt.journal_cursor = cursors.1;
            third.metadata.accepted.receipt.journal_cursor = cursors.0;
            f.cut.terminal_receipt = Some(first.metadata.accepted.receipt.clone());
            f.cut.events = vec![third, first];
        }),
        ("capacity", |_| {}),
    ];
    for (case, damage) in cases {
        let mut f = enrolled_drafts(&[true, false, true]);
        damage(&mut f);
        if case == "native refusal" {
            // Strictly refused but for its source, so only the first
            // adoption's own rule refuses it.
            let outbox: String = f
                .store
                .read_with(|conn| conn.query_row("SELECT outbox_id FROM owner_ydoc_outboxes", [], |r| r.get(0)))
                .unwrap();
            let refused = f
                .store
                .read_with(|conn| retirement::refused_entry(conn, "namespace", &f.key, &f.binding.lineage_claim_id, &outbox, 2))
                .unwrap();
            assert!(refused.is_some_and(|refusal| refusal.source.is_some()), "{case}");
        }
        let max_events = if case == "capacity" { 2 } else { 100 };
        let before = rows(&f, &SUCCESSION_WRITES);
        let adopted = adopt_owner_committed(&mut f.store, &f.handle, f.cut.clone(), 1_000_000, max_events, 10, &NoFaults, None, |_, _, _, _| Ok(()));
        assert!(adopted.is_err(), "{case}: {adopted:?}");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}");
    }
}

/// Sol's merge-review finding 2: the successor of a lineage whose baseline
/// the reader built adopts its released prefix, its accepted state at B
/// replayed from that baseline by the reader's rule.
#[test]
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
fn a_reader_built_lineage_adopts_its_successor() {
    let mut f = reader_fixture_case("valid");
    let resolver = reader_resolver();
    let root = prove_activation(&mut f, &resolver).unwrap().activation_id;
    f.cut.adoption_id = root.clone();
    reader_adopt(&mut f, &resolver);
    release_parked(&mut f).expect("an adopted release keeps its boundary");
    returned(&mut f);
    let id = reader_successor(&mut f, &resolver);
    let ack = reader_adopt(&mut f, &resolver);
    assert!(!ack.adoption_replayed);
    assert_eq!(ack.adoption_id, id);
    let (origin, predecessor, _, current, _) = succession_row(&f, &id);
    assert_eq!(origin.as_deref(), Some(root.as_str()));
    assert_eq!(predecessor.as_deref(), Some(root.as_str()));
    assert!(current);
}

/// Sol's merge-review finding 2: a lineage whose baseline the reader built
/// writes its checkpoint at the native cadence, and its accepted state
/// replays from that checkpoint.
#[test]
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
fn a_reader_built_lineage_checkpoints_at_the_native_cadence() {
    let mut f = reader_fixture_case("valid");
    let resolver = reader_resolver();
    f.cut.adoption_id = prove_activation(&mut f, &resolver).unwrap().activation_id;
    reader_adopt(&mut f, &resolver);
    let bytes = f.doc.encode_full_state();
    let held = f.handle.registration.lock().unwrap();
    let appended = f
        .store
        .write_with(&NoFaults, |tx| -> Result<(), ApplicationError> {
            for cursor in 1..=accepted_history::CHECKPOINT_EVENTS {
                let event = AdmittedLiveUpdate {
                    metadata: AdmittedLiveUpdateMetadata {
                        accepted: RelayAcceptedLiveUpdate {
                            receipt: LiveUpdateReceipt {
                                delivery_id: format!("cadence-{cursor}"),
                                update_digest: hex_sha256(&bytes),
                                journal_cursor: cursor,
                                accepting_host_epoch: 1,
                            },
                            binding: f.binding.clone(),
                            authority: ServerDerivedLiveUpdateAuthority::Owner { principal_id: "owner".into() },
                            received_at_ms: cursor,
                        },
                        first_seen: vec![],
                        canonical_version: Some(2),
                        author_snapshot: Some(vec![]),
                        first_seen_deletes: Some(vec![]),
                        checkpoint_coverage: None,
                    },
                    update_bytes: bytes.clone(),
                };
                accepted_history::append_native(tx, &held, &event, 8 * 1024 * 1024)?;
            }
            Ok(())
        })
        .unwrap();
    assert!(matches!(appended, TxnOutcome::Committed(())));
    // The event or the byte cadence, whichever the updates reach first.
    let checkpoint: i64 = f
        .store
        .read_with(|conn| conn.query_row("SELECT max(event_count) FROM live_accepted_checkpoints", [], |r| r.get(0)))
        .unwrap();
    assert!(checkpoint > 0, "a checkpoint past the adoption's");
    let replayed = f
        .store
        .read_with(|conn| {
            accepted_history::read_state(
                conn,
                &held,
                accepted_history::CHECKPOINT_EVENTS,
                NativeHistoryReconstruction { working_reserve_bytes: 8 * 1024 * 1024 },
            )
        })
        .unwrap();
    assert!(replayed.has_reader_source());
    assert!(crate::replay_parity::structurally_equal_v2(&replayed, &f.doc).unwrap());
}
