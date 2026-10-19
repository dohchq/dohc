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

/// The file at the document's path, rewritten to the local Y.Doc's text, as
/// ordinary sync brings the owner's work.
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
                path: "owner.md".into(),
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
        let coverage = vec![(1, Some(covered.clone())), (2, Some(carried.clone()))];
        let (_, _, _, _, digest) = succession_row(&f, &id);
        assert_eq!(digest, hex_sha256(&serde_json::to_vec(&coverage).unwrap()));
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

/// An abandoned seed is covered with no receipt, and only in its strict
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
        let coverage: Vec<(i64, Option<LiveUpdateReceipt>)> = vec![(1, None)];
        assert_eq!(digest, hex_sha256(&serde_json::to_vec(&coverage).unwrap()));
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

/// Opus, round 3b delta: two never-adopted captures. While the first one's
/// retirement settles the document, the second can't adopt; once the first
/// releases, the second adopts first, with no prefix, and follows it in the
/// chain. A lineage never adopted keeps its first adoption after released
/// captures, and its seed lands although released rows exist.
#[test]
fn adoption_waits_while_the_document_retires() {
    let mut f = imported_fixture();
    let first = capture_imported(&mut f, 1_000_000).unwrap().activation_id;
    offline_edit(&mut f, "Edited before the second capture", "second");
    let second = capture_imported(&mut f, 1_000_000).unwrap();
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
    f.cut.adoption_id = second.activation_id.clone();
    assert!(!f.adopt().unwrap().adoption_replayed);
    assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 1);
    let (origin, predecessor, boundary, current, _) = succession_row(&f, &second.activation_id);
    assert_eq!(origin.as_deref(), Some(second.activation_id.as_str()), "its own origin");
    assert_eq!(predecessor.as_deref(), Some(first.as_str()), "after the capture released before it");
    assert_eq!((boundary, current), (None, true));
    assert_eq!(seeds(&f), vec![(second.activation_id.clone(), 1)]);
    assert_eq!(chain_tail(&f, "namespace").unwrap(), None);
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
