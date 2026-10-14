use super::*;
use dohc_engine_domain::WriteText;

fn refused_update() -> ReplicationEnvelope {
    serde_json::from_value(json!({
        "workspaceId":"ws", "originId":"peer", "originSeq":0, "relaySeq":1,
        "opKind":"ydoc.update", "recordedAtMs":2,
        "payload":{
            "versionId":"main", "objectId":"object", "path":"doc.md",
            "lineageClaimId":"a".repeat(64), "updateBlobSha256":"b".repeat(64),
            "contentKind":"richdoc", "isBaseState":false,
            "release":{"releaseDigest":"c".repeat(64),"restoreFenceGeneration":0,
                "document":{"workspaceId":"ws","mainVersionId":"main",
                    "objectId":"object","lineageClaimId":"a".repeat(64)}}
        },
        "settlementAdmission":{"status":"refused","kind":"release-publication",
            "releaseDigest":"c".repeat(64),"reason":"release-generation-fenced"}
    }))
    .expect("release refusal must parse without a settlement ID")
}

#[test]
fn release_refusal_wire_round_trip() {
    let op = refused_update();
    let encoded = serde_json::to_value(&op).unwrap();
    assert_eq!(
        encoded["settlementAdmission"]["kind"],
        "release-publication"
    );
    assert_eq!(
        serde_json::from_value::<ReplicationEnvelope>(encoded).unwrap(),
        op
    );
}

#[test]
fn ordinary_settlement_admission_keeps_its_durable_encoding() {
    assert_eq!(
        serde_json::to_string(&SettlementAdmission::Accepted {
            settlement_id: "one".into()
        })
        .unwrap(),
        r#"{"status":"accepted","settlementId":"one"}"#
    );
    assert_eq!(
        serde_json::to_string(&SettlementAdmission::Refused {
            settlement_id: "one".into(),
            reason: "authorship-mismatch".into()
        })
        .unwrap(),
        r#"{"status":"refused","settlementId":"one","reason":"authorship-mismatch"}"#
    );
}

#[test]
fn release_refused_update_without_blob_advances_before_unrelated_work() {
    let (_scratch, _path, mut store) = open_store();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .unwrap();
    let op = refused_update();
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    for _ in 0..2 {
        let outcome =
            apply_ydoc_envelope(&mut store, &mut cache, &op, &NoFaults, &NoLiveLeases).unwrap();
        assert!(matches!(outcome.primary, ApplyDisposition::Refused(_)));
    }
    assert_eq!(read_replication_acked_seq(&store, "ws", "peer").unwrap(), 0);
    assert_eq!(store.table_row_count("ydoc_docs").unwrap(), 0);
    let next = envelope("peer", 1, "test.unrelated", json!({}));
    let result = apply_envelope_with(&mut store, &next, &NoFaults, |_, _| Ok(42)).unwrap();
    assert_eq!(result.primary, ApplyDisposition::Applied(42));
    assert_eq!(read_replication_acked_seq(&store, "ws", "peer").unwrap(), 1);
}

#[test]
fn release_refusal_restarts_and_rejects_changed_decisions() {
    let (_scratch, path, mut store) = open_store();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .unwrap();
    let mut op = refused_update();
    apply_ydoc_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    drop(store);
    let mut store = EngineStore::open(&path, 3).unwrap();
    let result = apply_ydoc_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(matches!(result.primary, ApplyDisposition::Refused(_)));
    assert_eq!(
        store
            .table_row_count("release_publication_admissions")
            .unwrap(),
        1
    );
    op.settlement_admission = Some(SettlementAdmission::ReleaseRefused {
        release_digest: "c".repeat(64),
        reason: "release-document-changed".into(),
    });
    assert!(matches!(
        apply_ydoc_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::CoordinateDiverged)
    ));
}

#[test]
fn release_refusal_requires_the_exact_authenticated_tag() {
    for field in [
        "relay",
        "digest",
        "workspace",
        "object",
        "generation",
        "reason",
        "kind",
        "authors",
    ] {
        let (_scratch, _path, mut store) = open_store();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        let mut op = refused_update();
        match field {
            "relay" => op.relay_seq = None,
            "digest" => op.payload["release"]["releaseDigest"] = json!("d".repeat(64)),
            "workspace" => op.payload["release"]["document"]["workspaceId"] = json!("other"),
            "object" => op.payload["release"]["document"]["objectId"] = json!("other"),
            "generation" => op.payload["release"]["restoreFenceGeneration"] = json!(-1),
            "reason" => {
                op.settlement_admission = Some(SettlementAdmission::ReleaseRefused {
                    release_digest: "c".repeat(64),
                    reason: "unknown".into(),
                })
            }
            "kind" => op.op_kind = "secret.put".into(),
            "authors" => op.admitted_author_snapshot = Some(json!([])),
            _ => unreachable!(),
        }
        assert!(
            matches!(
                apply_envelope_with(&mut store, &op, &NoFaults, |_, _| Ok(())),
                Err(SyncError::InvalidInput { .. })
            ),
            "{field}"
        );
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "peer").unwrap(),
            -1
        );
    }
}

#[test]
fn release_refused_moment_preserves_local_credit_without_an_untagged_fallback() {
    let (_scratch, _path, mut store) = open_store();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .unwrap();
    adopt_join_identity(&mut store, "ws", "owner", "epoch", "stream", 1, &NoFaults).unwrap();
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: "doc.md".into(),
                text: "keep local work".into(),
                moment_id: "moment".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: Some(json!([{"kind":"agent","agentId":"original"}]).to_string()),
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            journal_moment_append_in_tx(tx, "ws", "moment")
        })
        .unwrap();
    let mut op = list_replication_ops(&store, "ws", "owner", -1, 500)
        .unwrap()
        .into_iter()
        .find(|op| op.op_kind == "moment.append")
        .unwrap();
    op.payload.as_object_mut().unwrap().remove("authors");
    op.payload["release"] = refused_update().payload["release"].clone();
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE replication_log SET payload_json=?1 WHERE workspace_id='ws' AND origin_id='owner' AND origin_seq=?2", params![op.payload.to_string(),op.origin_seq]).map_err(SyncError::persist)?;
        Ok::<_,SyncError>(())
    }).unwrap();
    let count = store.table_row_count("replication_log").unwrap();
    let refusal = crate::ReleasePublicationRefusal {
        origin_id: "owner".into(),
        origin_seq: op.origin_seq,
        status: "refused".into(),
        kind: "release-publication".into(),
        release_digest: "c".repeat(64),
        reason: "release-publication-fenced".into(),
    };
    crate::release_publication::validate_push_refusals(
        std::slice::from_ref(&refusal),
        std::slice::from_ref(&op),
    )
    .unwrap();
    for _ in 0..2 {
        crate::cursor::write_pushed_seq_with_refusals(
            &mut store,
            "ws",
            "owner",
            op.origin_seq,
            &[],
            std::slice::from_ref(&refusal),
            &NoFaults,
            &NoLiveLeases,
            3,
        )
        .unwrap();
    }
    assert_eq!(
        read_pushed_seq(&store, "ws", "owner").unwrap(),
        op.origin_seq
    );
    op.relay_seq = Some(1);
    op.settlement_admission = Some(SettlementAdmission::ReleaseRefused {
        release_digest: "c".repeat(64),
        reason: "release-publication-fenced".into(),
    });
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults, &NoLiveLeases)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(store.table_row_count("replication_log").unwrap(), count);
    let credit: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT author_json FROM moments WHERE moment_id='moment'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&credit).unwrap(),
        json!([{"kind":"agent","agentId":"original"}])
    );
    assert_eq!(
        store
            .table_row_count("live_settlement_attribution_unavailable")
            .unwrap(),
        0
    );
}

#[test]
fn release_push_refusals_cannot_name_another_coordinate_or_tag() {
    let mut op = refused_update();
    op.settlement_admission = None;
    op.relay_seq = None;
    let valid = crate::ReleasePublicationRefusal {
        origin_id: "peer".into(),
        origin_seq: 0,
        status: "refused".into(),
        kind: "release-publication".into(),
        release_digest: "c".repeat(64),
        reason: "release-generation-fenced".into(),
    };
    crate::release_publication::validate_push_refusals(
        std::slice::from_ref(&valid),
        std::slice::from_ref(&op),
    )
    .unwrap();
    for case in ["coordinate", "digest", "kind", "reason", "duplicate"] {
        let mut r = valid.clone();
        match case {
            "coordinate" => r.origin_seq = 1,
            "digest" => r.release_digest = "d".repeat(64),
            "kind" => r.kind = "settlement".into(),
            "reason" => r.reason = "unknown".into(),
            "duplicate" => {}
            _ => unreachable!(),
        }
        let rs = if case == "duplicate" {
            vec![r.clone(), r]
        } else {
            vec![r]
        };
        assert!(
            matches!(
                crate::release_publication::validate_push_refusals(&rs, std::slice::from_ref(&op)),
                Err(RelayError::InvalidResponse)
            ),
            "{case}"
        );
    }
}
