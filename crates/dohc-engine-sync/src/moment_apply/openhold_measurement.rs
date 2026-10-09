use super::*;

#[test]
#[ignore = "manual open-document admission measurement"]
fn open_document_claim_check_measurement() {
    use dohc_engine_collab::Ydoc;
    use dohc_engine_storage::NoFaults;
    use dohc_engine_testkit::{ScratchDir, engine_db_path};
    use serde_json::json;
    for gap in [0_i64, 10_000] {
        let scratch = ScratchDir::new().unwrap();
        let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        let doc = Ydoc::wire();
        doc.plaintext_insert(0, "before");
        let sha = store.put_binary_blob(&doc.encode_full_state()).unwrap();
        let base = ReplicationEnvelope {
            workspace_id: "ws".into(),
            origin_id: "peer".into(),
            origin_seq: 0,
            op_kind: "ydoc.update".into(),
            recorded_at_ms: 1,
            relay_seq: Some(1),
            settlement_admission: None,
            admitted_author_snapshot: None,
            payload: json!({"versionId":"main","objectId":"object","path":"head.md","contentKind":"plaintext","lineageClaimId":sha,"updateBlobSha256":sha,"isBaseState":true}),
        };
        crate::apply_ydoc_envelope(
            &mut store,
            &mut Default::default(),
            &base,
            &NoFaults,
            &crate::NoLiveLeases,
        )
        .unwrap();
        store.write_with(&NoFaults, |tx| {
            for seq in 1..=gap {
                tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES ('ws','peer',?1,'ydoc.update',?2,1,1)", params![seq,base.payload.to_string()]).map_err(SyncError::persist)?;
            }
            for origin in ["another", "third"] {
                for seq in 0..gap {
                    tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES ('ws',?1,?2,'ydoc.update',?3,1,1)", params![origin,seq,base.payload.to_string()]).map_err(SyncError::persist)?;
                }
            }
            tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES ('ws','peer',?1,'ydoc.update',?2,1,1)", params![gap+2,base.payload.to_string()]).map_err(SyncError::persist)?;
            Ok::<_,SyncError>(())
        }).unwrap();
        let payload: MomentAppendPayload = serde_json::from_value(json!({"momentId":"artifact", "versionId":"main", "objectId":"object", "objectCreatedAtMs":1,"path":"head.md","recordedAtMs":2,"operation":"write","payloadAfterBlobSha256":hex_sha256(b"changed"),"payloadAfterPath":"head.md","metadata":{"origin":"sync"},"beforePresent":"absent"})).unwrap();
        let leases = dohc_engine_collab::LeaseRegistry::new();
        let key = DocKey::new("ws", "main", "object").unwrap();
        let held = leases.acquire(&key).unwrap();
        held.bind_claim(Some(&sha)).unwrap();
        for position in [gap + 1, gap + 3] {
            let op = ReplicationEnvelope {
                origin_seq: position,
                ..base.clone()
            };
            store
                .write_with(&NoFaults, |tx| {
                    // Warm SQLite's pages and statement preparation before sampling.
                    for _ in 0..20 {
                        assert!(holds_earlier_lineage_artifact(
                            tx,
                            &op,
                            &payload,
                            Some(&sha)
                        )?);
                    }
                    let mut samples = Vec::with_capacity(500);
                    for _ in 0..500 {
                        let start = std::time::Instant::now();
                        let claim = leases.bound_claim(&key).unwrap();
                        assert!(holds_earlier_lineage_artifact(
                            tx,
                            &op,
                            &payload,
                            Some(&claim)
                        )?);
                        samples.push(start.elapsed().as_nanos());
                    }
                    samples.sort_unstable();
                    println!(
                        "OPENHOLD check gap={gap} moment_seq={position} n=500 p50_ns={} p95_ns={}",
                        samples[249], samples[474]
                    );
                    Ok::<_, SyncError>(())
                })
                .unwrap();
        }
    }
}
