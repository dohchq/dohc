fn imported_fixture() -> Fixture {
    let mut fixture = Fixture::new();
    let payload = serde_json::json!({
        "versionId":"main", "objectId":"object", "contentKind":"richdoc", "isBaseState":true,
        "lineageClaimId":fixture.binding.lineage_claim_id,
        "updateBlobSha256":fixture.binding.lineage_claim_id,
    });
    fixture.store.write_with(&NoFaults, |tx| {
        tx.execute("DELETE FROM ydoc_owner_base_sources", []).map_err(write_sql)?;
        tx.execute("UPDATE ydoc_docs SET base_origin_id='remote',base_origin_seq=7,base_relay_seq=9", []).map_err(write_sql)?;
        tx.execute("INSERT INTO sync_relay_cursors(workspace_id,cursor,replication_epoch,stream_identity)
            VALUES('workspace','9','epoch','stream')", []).map_err(write_sql)?;
        tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported)
            VALUES('workspace','remote',7,'ydoc.update',?1,1,1)", [payload.to_string()]).map_err(write_sql)?;
        Ok::<_, ApplicationError>(())
    }).unwrap();
    fixture
}

fn capture_imported(
    f: &mut Fixture,
    max_bytes: usize,
) -> Result<ImportedOwnerActivation, ApplicationError> {
    capture_imported_owner_activation(
        &mut f.store,
        "namespace",
        &f.key,
        "owner.md",
        max_bytes,
        &NoFaults,
    )
}

#[test]
fn imported_activation_retains_original_source_without_minting_native_seed() {
    let mut f = imported_fixture();
    let first = capture_imported(&mut f, 1_000_000).unwrap();
    let replay = capture_imported(&mut f, 1_000_000).unwrap();
    assert_eq!(first.activation_id, replay.activation_id);
    assert_eq!(first.baseline_bytes, f.cut.baseline_bytes);
    assert_eq!(first.source.base_origin_id, "remote");
    assert_eq!(first.source.base_origin_seq, 7);
    assert_eq!(first.source.base_relay_seq, 9);
    assert_eq!(first.source.committed_cursor, 9);
    let seed_count: i64 = f
        .store
        .read_with(|conn| {
            conn.query_row("SELECT count(*) FROM ydoc_owner_base_sources", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(seed_count, 0);
    f.cut.adoption_id = first.activation_id;
    let ack = adopt_owner_committed(
        &mut f.store,
        &f.handle,
        f.cut.clone(),
        1_000_000,
        10,
        4,
        &NoFaults,
    )
    .unwrap();
    assert!(!ack.adoption_replayed);
    let ack = adopt_owner_committed(
        &mut f.store,
        &f.handle,
        f.cut.clone(),
        1_000_000,
        10,
        5,
        &NoFaults,
    )
    .unwrap();
    assert!(ack.adoption_replayed);
}

#[test]
fn imported_activation_rejects_uncommitted_cursor_budget_and_changed_provenance() {
    let mut f = imported_fixture();
    assert!(capture_imported(&mut f, 1).is_err());
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE sync_relay_cursors SET cursor='8'", [])
                .map_err(write_sql)
        })
        .unwrap();
    assert!(capture_imported(&mut f, 1_000_000).is_err());
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE sync_relay_cursors SET cursor='9'", [])
                .map_err(write_sql)
        })
        .unwrap();
    f.cut.adoption_id = capture_imported(&mut f, 1_000_000).unwrap().activation_id;
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE replication_log SET imported=0", [])
                .map_err(write_sql)
        })
        .unwrap();
    assert!(
        adopt_owner_committed(
            &mut f.store,
            &f.handle,
            f.cut.clone(),
            1_000_000,
            10,
            4,
            &NoFaults
        )
        .is_err()
    );
    assert!(capture_imported(&mut f, 1_000_000).is_err());
}

#[test]
fn imported_activation_rejects_ordinary_projection_that_does_not_match_native_state() {
    let mut f = imported_fixture();
    f.doc
        .rewrite_content_to_markdown(ContentKind::Richdoc, "unsettled change")
        .unwrap();
    let update = f.doc.encode_full_state();
    f.store
        .write_with(&NoFaults, |tx| {
            durable::record_update_in_tx(tx, &f.key, &update, None, None, 4)
        })
        .unwrap();
    assert!(capture_imported(&mut f, 1_000_000).is_err());
}
