/// Accepted state at B=3, which the released chain's file at B shows.
fn base_at_b(f: &Fixture) -> Ydoc {
    let held = f.handle.registration.lock().unwrap();
    f.store
        .read_with(|conn| {
            accepted_history::read_state(conn, &held, 3, NativeHistoryReconstruction { working_reserve_bytes: 8 * 1024 * 1024 })
        })
        .unwrap()
}

/// What a disk capture of `text` may do over `head`, decided before it
/// ingests the file.
fn disk_capture(f: &Fixture, text: &str, head: &Ydoc) -> Result<ReleasedCapture, ApplicationError> {
    disk_capture_within(f, text, head, RELEASED_CAPTURE_PROOF_BYTES)
}

fn disk_capture_within(f: &Fixture, text: &str, head: &Ydoc, max_bytes: usize) -> Result<ReleasedCapture, ApplicationError> {
    f.store.read_with(|conn| released_capture(conn, &f.key, &f.binding.lineage_claim_id, "owner.md", text, head, max_bytes))
}

/// The file the released chain settled at B, with a paragraph added on disk.
fn edited_on_disk(f: &Fixture) -> String {
    edited_from(f, "retired")
}

/// The file the settlement recorded as `moment`, with a paragraph added.
fn edited_from(f: &Fixture, moment: &str) -> String {
    format!("{}\nA disk edit.\n", moment_text(f, moment))
}

/// A root whose native update the host applied at B=3, settled at B and
/// released with nothing Carried, its document back in the scope. Its file
/// shows accepted state at B, which is its whole Y.Doc.
fn released_without_carried() -> Fixture {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let covered = native_tail_edit(&mut f, "# Covered\n", 11);
    native_tail_apply(&mut f, covered.update.clone(), covered.delivery_id.clone(), 3);
    let covered = receipt_of(&covered.delivery_id, &covered.update_digest, 3);
    acknowledge_entry(&mut f, &covered);
    host_document(&mut f, true, true);
    retire_settled(&mut f, Some(covered), "retired").unwrap();
    release_parked(&mut f);
    assert!(manifest(&f, "adoption").is_empty());
    importable(&mut f);
    returned(&mut f);
    f
}

/// Sol's 4b2b-1 ruling, branch selection. A proven base structurally the
/// whole Y.Doc folds as ever. The same Markdown over another structure, and
/// a Y.Doc holding the chain's Carried deliveries, refuse. The bytes capture
/// last recorded keep the Y.Doc, Carried deliveries and all. Outside the
/// window, capture is ordinary.
#[test]
fn a_released_window_folds_only_over_a_proven_base_equal_to_the_head() {
    let f = released_without_carried();
    let edited = edited_on_disk(&f);
    let local = local_doc(&f);
    assert!(crate::replay_parity::structurally_equal_v2(&base_at_b(&f), &local).unwrap());
    assert_eq!(disk_capture(&f, &edited, &local).unwrap(), ReleasedCapture::Ordinary);
    let markdown = local.project(ContentKind::Richdoc).unwrap().content;
    let rebuilt = Ydoc::wire();
    rebuilt.apply(&local.encode_full_state()).unwrap();
    rebuilt.rewrite_content_to_markdown(ContentKind::Richdoc, &markdown).unwrap();
    assert_eq!(rebuilt.project(ContentKind::Richdoc).unwrap().content, markdown, "the same Markdown");
    assert!(!crate::replay_parity::structurally_equal_v2(&rebuilt, &local).unwrap());
    assert!(matches!(disk_capture(&f, &edited, &rebuilt), Err(ApplicationError::Conflict)), "another structure");

    let (f, _, _, _) = released_at_b();
    let local = local_doc(&f);
    assert!(matches!(disk_capture(&f, &edited_on_disk(&f), &local), Err(ApplicationError::Conflict)), "Carried content");
    let file = moment_text(&f, "retired");
    assert_eq!(disk_capture(&f, &file, &local).unwrap(), ReleasedCapture::Unchanged);
    let mut f = f;
    // The lineage current in another relay is no released window, whatever
    // tail this relay keeps.
    write_unchecked(&mut f, "PRAGMA foreign_keys=OFF;
        CREATE TEMP TABLE current AS SELECT * FROM live_owner_activations WHERE activation_id='adoption';
        UPDATE current SET relay_database_namespace='other',released_at_ms=NULL,released_restore_generation=NULL,
          released_accepted_cursor=NULL,released_boundary_json=NULL,carried_manifest_json=NULL;
        INSERT INTO live_owner_activations SELECT * FROM current");
    assert_eq!(disk_capture(&f, &edited_on_disk(&f), &local).unwrap(), ReleasedCapture::Ordinary, "current in another relay");

    let mut f = Fixture::new();
    f.adopt().unwrap();
    native_tail_edit(&mut f, "# Own edit\n", 11);
    assert_eq!(disk_capture(&f, "# Anything\n", &local_doc(&f)).unwrap(), ReleasedCapture::Ordinary, "an activation is current");
    let f = Fixture::new();
    assert_eq!(disk_capture(&f, "# Anything\n", &local_doc(&f)).unwrap(), ReleasedCapture::Ordinary, "no chain");
}

/// A damage the released-window proof must refuse.
type ProofDamage = (&'static str, fn(&mut Fixture, &mut Ydoc));

/// Each condition of the released-window proof, failing alone, refuses a
/// disk edit over a base that is otherwise proven and equal to the head:
/// the settlement's moment, digest, binding, path or state vector, the
/// accepted history it reconstructs from, a dependency the head is missing,
/// a released tail whose record does not read, and a proof larger than its
/// budget.
#[test]
fn the_released_window_proof_refuses_each_unproven_base() {
    let damages: [ProofDamage; 9] = [
        ("wrong moment", |f, _| write(f, "UPDATE live_device_settlements SET moment_id='settlement-shaped'")),
        ("wrong digest", |f, _| {
            write(f, &format!("UPDATE live_device_settlements SET markdown_digest='{}'", "f".repeat(64)))
        }),
        ("wrong binding", |f, _| {
            write(f, "UPDATE live_device_settlements SET binding_json=json_set(binding_json,'$.objectId','other')")
        }),
        ("wrong path", |f, _| {
            write(f, "UPDATE live_device_settlements
                SET binding_json=json_set(binding_json,'$.currentPath','other.md','$.selectorPaths',json_array('other.md'))")
        }),
        ("wrong settlement vector", |f, _| {
            write(f, &format!("UPDATE live_device_settlements SET source_state_vector_digest='{}'", "f".repeat(64)))
        }),
        ("missing reconstruction bytes", |f, _| {
            write_unchecked(f, "PRAGMA foreign_keys=OFF;
                DELETE FROM binary_blobs WHERE sha256 IN (SELECT update_sha256 FROM live_accepted_updates)")
        }),
        ("missing dependency", |_, head| {
            let ahead = Ydoc::wire();
            ahead.apply(&head.encode_full_state()).unwrap();
            ahead.richdoc_append_paragraph("Missing");
            let dependent = ahead.richdoc_append_paragraph("Dependent");
            head.apply(&dependent).unwrap();
            assert!(head.has_missing_updates());
        }),
        ("invalid tail", |f, _| {
            write_unchecked(f, "UPDATE live_owner_activations SET released_boundary_json='{}' WHERE activation_id='adoption'")
        }),
        // One byte less than the proof reads.
        ("budget", |_, _| {}),
    ];
    for (case, damage) in damages {
        let mut f = released_without_carried();
        let mut head = local_doc(&f);
        let edited = edited_on_disk(&f);
        assert_eq!(disk_capture(&f, &edited, &head).unwrap(), ReleasedCapture::Ordinary, "{case}: proven before");
        damage(&mut f, &mut head);
        let max_bytes = if case == "budget" { proof_bytes(&f) - 1 } else { RELEASED_CAPTURE_PROOF_BYTES };
        let decided = disk_capture_within(&f, &edited, &head, max_bytes);
        assert!(decided.is_err(), "{case}: {decided:?}");
        if case == "budget" {
            assert!(matches!(decided, Err(ApplicationError::ConfiguredByteBudgetExceeded)), "{case}");
            assert_eq!(disk_capture_within(&f, &edited, &head, max_bytes + 1).unwrap(), ReleasedCapture::Ordinary);
        }
    }
}

/// The accepted-history bytes the proof of the file at B reads.
fn proof_bytes(f: &Fixture) -> usize {
    let digest = hex_sha256(moment_text(f, "retired").as_bytes());
    let length = moment_text(f, "retired").len() as i64;
    let mut budget = restore_content::Budget { remaining: RELEASED_CAPTURE_PROOF_BYTES };
    f.store
        .read_with(|conn| {
            settled_base::settled_base(conn, "namespace", &f.key, "owner.md", &f.binding.lineage_claim_id, ("retired", &digest, length), settled_base::Settlement::Latest, &mut budget, None)
        })
        .unwrap();
    RELEASED_CAPTURE_PROOF_BYTES - budget.remaining
}

/// Sol's 4b2b-1 ruling, the released-window variants: content the file at B
/// never showed refuses a disk edit, whether the chain Carried it, a seed
/// accepted and never applied holds it, the owner typed it after the
/// release, or ordinary sync caught it up and a moment records it.
#[test]
fn a_released_window_refuses_a_disk_edit_over_content_its_file_never_showed() {
    let (f, _, _, _) = released_at_b();
    assert!(diverged(disk_capture(&f, &edited_on_disk(&f), &local_doc(&f))), "Carried content");

    let (mut f, _, carried) = resumed_after_catch_up(true, 1);
    accept_seed(&mut f, 7);
    apply_carried(&mut f, &carried[0]);
    host_document(&mut f, true, true);
    retire_settled(&mut f, Some(carried[0].receipt.clone()), "seed-retired").unwrap();
    release_parked(&mut f);
    returned(&mut f);
    assert!(diverged(disk_capture(&f, &edited_from(&f, "seed-retired"), &local_doc(&f))), "an acknowledged seed");

    let mut f = released_without_carried();
    let update = f.doc.richdoc_append_paragraph("Typed after the release");
    f.store
        .write_with(&NoFaults, |tx| durable::record_update_in_tx(tx, &f.key, &update, None, None, 40))
        .unwrap();
    assert!(diverged(disk_capture(&f, &edited_on_disk(&f), &local_doc(&f))), "own unapplied edits");

    let mut f = released_without_carried();
    catch_up_row(&mut f, 1);
    file_matches_local(&mut f, "caught-up");
    // The file shows B again, while a moment of it holds the catch-up.
    write(&mut f, "UPDATE snapshots SET latest_moment_id='retired',
        blob_sha256=(SELECT after_blob_sha256 FROM moments WHERE moment_id='retired')");
    assert!(diverged(disk_capture(&f, &edited_on_disk(&f), &local_doc(&f))), "caught-up content a moment holds");
}

/// Sol's 4b2i-3 ruling: the namespaces of a document lineage come from
/// `live_owner_activations_document`, never a scan, across a history of
/// several namespaces and documents with many released activations, with and
/// without statistics.
#[test]
fn a_lineage_finds_its_namespaces_by_its_document_index() {
    let mut f = Fixture::new();
    let lineage = f.binding.lineage_claim_id.clone();
    write_unchecked(&mut f, &format!("PRAGMA foreign_keys=OFF;
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<2399)
        INSERT INTO live_owner_activations (relay_database_namespace,activation_id,workspace_id,main_version_id,
            object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,
            host_coordinate_json,released_at_ms,released_restore_generation,released_accepted_cursor,
            released_boundary_json,carried_manifest_json)
        SELECT 'relay-'||(i%4),'released-'||i,'workspace','main',iif((i/4)%8=0,'object','document-'||((i/4)%8)),'{lineage}',
            '{{}}','moment','source',0,'{{}}',i,0,0,'{{}}','[]' FROM n"));
    for analyze in ["", "ANALYZE"] {
        write_unchecked(&mut f, analyze);
        let namespaces = f
            .store
            .read_with(|conn| {
                conn.prepare(settled_base::LINEAGE_NAMESPACES_SQL)?
                    .query_map(params!["workspace", "main", "object", lineage], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap();
        assert_eq!(namespaces, ["relay-0", "relay-1", "relay-2", "relay-3"], "{analyze}");
        let plan = f
            .store
            .read_with(|conn| {
                conn.prepare(&format!("EXPLAIN QUERY PLAN {}", settled_base::LINEAGE_NAMESPACES_SQL))?
                    .query_map(params!["workspace", "main", "object", lineage], |row| row.get::<_, String>(3))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap();
        assert_eq!(
            plan,
            ["SEARCH live_owner_activations USING COVERING INDEX live_owner_activations_document \
              (workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?)"],
            "{analyze}"
        );
    }
}

/// A proven base the head differs from, not an unproven one.
fn diverged(decided: Result<ReleasedCapture, ApplicationError>) -> bool {
    matches!(decided, Err(ApplicationError::Conflict))
}

/// Sol's 4b2b-1 ruling, the shared budget: a successor's capture reads
/// accepted state at B and replays the Carried updates onto it within one
/// budget. Each fits it alone; together they refuse.
#[test]
fn a_successor_proof_and_its_carried_replay_share_one_budget() {
    let (f, _, _, _) = released_at_b();
    let file = moment_text(&f, "retired");
    let digest = hex_sha256(file.as_bytes());
    let reconstruction = proof_bytes(&f);
    let replay: usize = f
        .store
        .read_with(|conn| retirement::inherited_entries(conn, "namespace", &f.key, &f.binding.lineage_claim_id, Some("adoption")))
        .unwrap()
        .iter()
        .map(|inherited| f.store.get_binary_blob(&inherited.entry.update_digest).unwrap().unwrap().len())
        .sum();
    let local = local_doc(&f);
    let lineage = f.binding.lineage_claim_id.clone();
    let proof = |max_bytes| {
        f.store.read_with(|conn| {
            activation::settled_at_boundary(conn, "namespace", &f.key, "owner.md", &lineage, None, &local, ("retired", &digest, file.len() as i64), max_bytes, None)
        })
    };
    let largest = reconstruction.max(replay);
    assert!(largest < reconstruction + replay);
    assert!(matches!(proof(largest), Err(ApplicationError::ConfiguredByteBudgetExceeded)));
    proof(reconstruction + replay).unwrap();
}
