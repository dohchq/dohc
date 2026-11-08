use crate::{
    RefusalReason, ReplicationEnvelope, ReplicationRefusal, SettlementAdmission,
    SettlementPublicationRefusal, SyncError,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::Value;

pub(crate) const REFUSAL_MESSAGE: &str =
    "dohc could not verify who changed this file. The file will share without author names.";

fn invalid(reason: &'static str) -> SyncError {
    SyncError::InvalidInput { reason }
}

pub(crate) fn validate(envelope: &ReplicationEnvelope) -> Result<(), SyncError> {
    let Some(admission) = envelope.settlement_admission.as_ref() else {
        return Ok(());
    };
    if envelope.op_kind != "moment.append" || envelope.relay_seq.is_none() {
        return Err(invalid(
            "settlement admission requires an authenticated relay moment",
        ));
    }
    match admission {
        SettlementAdmission::Refused {
            settlement_id,
            reason,
        } => {
            if settlement_id.is_empty()
                || settlement_id.len() > 512
                || reason.is_empty()
                || reason.len() > 4096
                || envelope.admitted_author_snapshot.is_some()
            {
                return Err(invalid("invalid settlement refusal"));
            }
            return Ok(());
        }
        SettlementAdmission::Accepted { settlement_id } => {
            let reference = &envelope.payload["settlementReference"]["record"];
            if reference["settlementId"].as_str() != Some(settlement_id)
                || reference["momentId"] != envelope.payload["momentId"]
                || reference["binding"]["workspaceId"].as_str() != Some(&envelope.workspace_id)
            {
                return Err(invalid("settlement admission reference differs"));
            }
            if envelope.payload.get("authors").is_some() {
                return Err(invalid("proof settlement cannot declare authors"));
            }
            let authors = envelope
                .admitted_author_snapshot
                .as_ref()
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("accepted settlement has no author snapshot"))?;
            if authors.len() > 1024
                || serde_json::to_vec(authors)
                    .map_err(SyncError::corrupt)?
                    .len()
                    > crate::MAX_PAYLOAD_JSON_BYTES
            {
                return Err(invalid(
                    "accepted settlement author snapshot exceeds its bound",
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn admitted_moment_authors(
    envelope: &ReplicationEnvelope,
) -> Result<Option<Value>, SyncError> {
    use dohc_engine_collab::live_update_application::LiveAuthorEntry;
    let Some(snapshot) = &envelope.admitted_author_snapshot else {
        return Ok(None);
    };
    let authors: Vec<LiveAuthorEntry> = serde_json::from_value(snapshot.clone())
        .map_err(|_| invalid("accepted settlement authors are invalid"))?;
    let mut converted = Vec::with_capacity(authors.len());
    for author in authors {
        author
            .validate()
            .map_err(|_| invalid("accepted settlement authors are invalid"))?;
        match author {
            LiveAuthorEntry::Automation {
                automation_id,
                attribution,
            } => {
                let native = dohc_engine_domain::moment_author_json(
                    Some(&automation_id),
                    Some(&attribution),
                )
                .ok_or_else(|| invalid("accepted automation has no native author"))?;
                let entries: Vec<Value> =
                    serde_json::from_str(&native).map_err(SyncError::corrupt)?;
                converted.extend(entries);
            }
            human @ LiveAuthorEntry::Human { .. } => {
                let mut native = serde_json::to_value(human).map_err(SyncError::corrupt)?;
                if envelope.relay_seq.is_some()
                    && matches!(
                        envelope.settlement_admission,
                        Some(SettlementAdmission::Accepted { .. })
                    )
                {
                    native["relayConfirmed"] = Value::Bool(true);
                }
                converted.push(native);
            }
            other => converted.push(serde_json::to_value(other).map_err(SyncError::corrupt)?),
        }
    }
    Ok(Some(Value::Array(converted)))
}

pub(crate) fn refresh_in_tx(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
) -> Result<Option<ReplicationRefusal>, SyncError> {
    validate(envelope)?;
    let Some(admission) = &envelope.settlement_admission else {
        if let Some(mark) = envelope.payload.get("attributionUnavailable") {
            if envelope.op_kind != "moment.append"
                || envelope.payload.get("settlementReference").is_some()
                || envelope
                    .payload
                    .get("authors")
                    .is_some_and(|v| !v.is_null())
            {
                return Err(invalid("unavailable attribution cannot claim authors"));
            }
            let id = mark["settlementId"]
                .as_str()
                .ok_or_else(|| invalid("invalid unavailable attribution"))?;
            let reason = mark["reason"]
                .as_str()
                .ok_or_else(|| invalid("invalid unavailable attribution"))?;
            if id.is_empty() || id.len() > 512 || reason.is_empty() || reason.len() > 4096 {
                return Err(invalid("invalid unavailable attribution"));
            }
            let marked_before:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM live_settlement_attribution_unavailable WHERE workspace_id=?1 AND moment_id=?2)",params![envelope.workspace_id,envelope.payload["momentId"].as_str()],|r|r.get(0)).map_err(SyncError::corrupt)?;
            tx.execute("INSERT INTO live_settlement_attribution_unavailable(workspace_id,moment_id,settlement_id,reason) VALUES (?1,?2,?3,?4) ON CONFLICT(workspace_id,moment_id) DO NOTHING",params![envelope.workspace_id,envelope.payload["momentId"].as_str(),id,reason]).map_err(SyncError::persist)?;
            tx.execute("UPDATE moments SET author_json=NULL,metadata_summary='Attribution unavailable' WHERE workspace_id=?1 AND moment_id=?2 AND EXISTS(SELECT 1 FROM replication_log r WHERE r.workspace_id=?1 AND r.origin_id=?3 AND r.origin_seq=?4 AND (r.imported=0 OR r.apply_disposition='applied'))",params![envelope.workspace_id,envelope.payload["momentId"].as_str(),envelope.origin_id,envelope.origin_seq]).map_err(SyncError::persist)?;
            let local:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 AND imported=0)",params![envelope.workspace_id,envelope.origin_id,envelope.origin_seq],|r|r.get(0)).map_err(SyncError::corrupt)?;
            if local && (!marked_before || reason == "terminal-owner-source") {
                tx.execute("INSERT INTO replication_pending_refusals(workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) VALUES (?1,?2,?3,'moment.append','invalid-input',?4) ON CONFLICT(workspace_id,origin_id,origin_seq) DO NOTHING",params![envelope.workspace_id,envelope.origin_id,envelope.origin_seq,REFUSAL_MESSAGE]).map_err(SyncError::persist)?;
            }
        }
        return Ok(None);
    };
    let encoded = serde_json::to_string(admission).map_err(SyncError::corrupt)?;
    let authors = envelope
        .admitted_author_snapshot
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(SyncError::corrupt)?;
    let moment = envelope.payload["momentId"].as_str().unwrap_or("");
    let prior: Option<(String,Option<String>)> = tx.query_row("SELECT admission_json,authors_json FROM live_settlement_publication_admissions WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",params![envelope.workspace_id,envelope.origin_id,envelope.origin_seq],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(SyncError::corrupt)?;
    if prior
        .as_ref()
        .is_some_and(|saved| saved != &(encoded.clone(), authors.clone()))
    {
        return Err(SyncError::CoordinateDiverged);
    }
    let moment_authors = admitted_moment_authors(envelope)?
        .filter(|authors| {
            authors
                .as_array()
                .is_some_and(|authors| !authors.is_empty())
        })
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(SyncError::corrupt)?;
    tx.execute("INSERT INTO live_settlement_publication_admissions(workspace_id,origin_id,origin_seq,moment_id,admission_json,authors_json) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(workspace_id,origin_id,origin_seq) DO NOTHING",params![envelope.workspace_id,envelope.origin_id,envelope.origin_seq,moment,encoded,authors]).map_err(SyncError::persist)?;
    match admission {
        SettlementAdmission::Accepted { .. } => {
            tx.execute(
                "UPDATE moments SET author_json=?3 WHERE workspace_id=?1 AND moment_id=?2 AND EXISTS(SELECT 1 FROM replication_log r WHERE r.workspace_id=?1 AND r.origin_id=?4 AND r.origin_seq=?5 AND (r.imported=0 OR r.apply_disposition='applied'))",
                params![envelope.workspace_id, moment, moment_authors,envelope.origin_id,envelope.origin_seq],
            )
            .map_err(SyncError::persist)?;
            Ok(None)
        }
        SettlementAdmission::Refused {
            settlement_id,
            reason,
        } => {
            if prior.is_some() {
                return Ok(Some(publication_refusal(envelope)));
            }
            refuse_in_tx(tx, envelope, moment, settlement_id, reason).map(Some)
        }
    }
}

fn publication_refusal(envelope: &ReplicationEnvelope) -> ReplicationRefusal {
    ReplicationRefusal {
        workspace_id: envelope.workspace_id.clone(),
        origin_id: envelope.origin_id.clone(),
        origin_seq: envelope.origin_seq,
        op_kind: envelope.op_kind.clone(),
        reason: RefusalReason::InvalidInput {
            reason: REFUSAL_MESSAGE.to_owned(),
        },
    }
}

fn refuse_in_tx(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    moment: &str,
    settlement_id: &str,
    reason: &str,
) -> Result<ReplicationRefusal, SyncError> {
    let refusal = publication_refusal(envelope);
    tx.execute("INSERT INTO replication_pending_refusals(workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) VALUES (?1,?2,?3,'moment.append','invalid-input',?4) ON CONFLICT(workspace_id,origin_id,origin_seq) DO NOTHING",params![envelope.workspace_id,envelope.origin_id,envelope.origin_seq,refusal.reason.message()]).map_err(SyncError::persist)?;
    let local: Option<bool> = tx.query_row("SELECT imported=0 FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",params![envelope.workspace_id,envelope.origin_id,envelope.origin_seq],|r|r.get(0)).optional().map_err(SyncError::corrupt)?;
    let native:bool=tx.query_row(concat!("SELECT EXISTS(SELECT 1 FROM moments WHERE ", dohc_engine_domain::exclude_capture_recovery_sql!(), " AND workspace_id=?1 AND moment_id=?2 AND version_id=?3 AND object_id=?4 AND payload_after_blob_sha256=?5)"),params![envelope.workspace_id,moment,envelope.payload["versionId"].as_str(),envelope.payload["objectId"].as_str(),envelope.payload["payloadAfterBlobSha256"].as_str()],|r|r.get(0)).map_err(SyncError::corrupt)?;
    let structurally_valid = serde_json::from_value::<crate::moment_apply::MomentAppendPayload>(
        envelope.payload.clone(),
    )
    .is_ok();
    if local == Some(true) && native && structurally_valid {
        let prior: Option<i64> = tx.query_row("SELECT fallback_origin_seq FROM live_settlement_publication_admissions WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",params![envelope.workspace_id,envelope.origin_id,envelope.origin_seq],|r|r.get(0)).optional().map_err(SyncError::corrupt)?.flatten();
        if prior.is_none() {
            let mut fallback = envelope.payload.clone();
            let object = fallback
                .as_object_mut()
                .ok_or_else(|| invalid("invalid settlement moment"))?;
            object.remove("authors");
            object.remove("settlementReference");
            object.insert(
                "attributionUnavailable".into(),
                serde_json::json!({"settlementId":settlement_id,"reason":reason}),
            );
            fallback["metadata"]["summary"] = Value::String("Attribution unavailable".into());
            let sequence = crate::journal_local_op_in_tx(
                tx,
                &envelope.workspace_id,
                "moment.append",
                &fallback,
                envelope.recorded_at_ms,
            )?;
            tx.execute("UPDATE live_settlement_publication_admissions SET fallback_origin_seq=?4 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",params![envelope.workspace_id,envelope.origin_id,envelope.origin_seq,sequence]).map_err(SyncError::persist)?;
        }
        tx.execute("UPDATE moments SET author_json=NULL,metadata_summary='Attribution unavailable' WHERE workspace_id=?1 AND moment_id=?2",params![envelope.workspace_id,moment]).map_err(SyncError::persist)?;
        tx.execute("INSERT INTO live_settlement_attribution_unavailable(workspace_id,moment_id,settlement_id,reason) VALUES (?1,?2,?3,?4) ON CONFLICT(workspace_id,moment_id) DO NOTHING",params![envelope.workspace_id,moment,settlement_id,reason]).map_err(SyncError::persist)?;
        tx.execute("UPDATE replication_log SET apply_disposition='refused' WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",params![envelope.workspace_id,envelope.origin_id,envelope.origin_seq]).map_err(SyncError::persist)?;
    }
    Ok(refusal)
}

pub(crate) fn push_refusals_in_tx(
    tx: &Transaction<'_>,
    workspace: &str,
    refusals: &[SettlementPublicationRefusal],
) -> Result<(), SyncError> {
    for refusal in refusals {
        let (json,recorded): (String,i64) = tx.query_row("SELECT payload_json,recorded_at_ms FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 AND op_kind='moment.append' AND imported=0",params![workspace,refusal.origin_id,refusal.origin_seq],|r|Ok((r.get(0)?,r.get(1)?))).map_err(SyncError::corrupt)?;
        let envelope = ReplicationEnvelope {
            workspace_id: workspace.into(),
            origin_id: refusal.origin_id.clone(),
            origin_seq: refusal.origin_seq,
            relay_seq: Some(0),
            op_kind: "moment.append".into(),
            payload: serde_json::from_str(&json).map_err(SyncError::corrupt)?,
            recorded_at_ms: recorded,
            settlement_admission: Some(SettlementAdmission::Refused {
                settlement_id: refusal.settlement_id.clone(),
                reason: refusal.reason.clone(),
            }),
            admitted_author_snapshot: None,
        };
        if !refusal_identifier_matches(&envelope.payload["momentId"], &refusal.moment_id) {
            return Err(SyncError::CoordinateDiverged);
        }
        refresh_in_tx(tx, &envelope)?;
    }
    Ok(())
}

fn refusal_identifier_matches(original: &Value, refused: &str) -> bool {
    // The relay can reject a payload before reading either identifier.
    refused == "unavailable" || original.as_str() == Some(refused)
}

pub(crate) fn validate_push_refusals(
    refusals: &[SettlementPublicationRefusal],
    batch: &[ReplicationEnvelope],
) -> Result<(), crate::RelayError> {
    let mut coordinates = std::collections::BTreeSet::new();
    for refusal in refusals {
        if !coordinates.insert((&refusal.origin_id, refusal.origin_seq))
            || refusal.moment_id.is_empty()
            || refusal.moment_id.len() > 512
            || refusal.settlement_id.is_empty()
            || refusal.settlement_id.len() > 512
            || refusal.reason.is_empty()
            || refusal.reason.len() > 4096
            || !batch.iter().any(|op| {
                op.origin_id == refusal.origin_id
                    && op.origin_seq == refusal.origin_seq
                    && op.op_kind == "moment.append"
                    && refusal_identifier_matches(&op.payload["momentId"], &refusal.moment_id)
                    && refusal_identifier_matches(
                        &op.payload["settlementReference"]["record"]["settlementId"],
                        &refusal.settlement_id,
                    )
            })
        {
            return Err(crate::RelayError::InvalidResponse);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ApplyDisposition, NoLiveLeases, adopt_join_identity, apply_envelope_with,
        apply_moment_envelope, list_replication_ops, read_pushed_seq,
    };
    use dohc_engine_collab::live_update_application::ReleasedTails;
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};
    use dohc_engine_testkit::open_store;
    use serde_json::json;

    fn source(store: &mut EngineStore) -> ReplicationEnvelope {
        VersionedTextStore::new(store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        adopt_join_identity(store, "ws", "source", "epoch", "stream", 1, &NoFaults).unwrap();
        VersionedTextStore::new(store)
            .write_text(
                &WriteText {
                    workspace_id: "ws".into(),
                    version_id: "main".into(),
                    object_id: "object".into(),
                    path: "doc.md".into(),
                    text: "accepted work".into(),
                    moment_id: "moment".into(),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: Some(json!([{"kind":"agent","agentId":"forged"}]).to_string()),
                    now_ms: 10,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                crate::journal_moment_append_in_tx(tx, "ws", "moment")
            })
            .unwrap();
        list_replication_ops(store, "ws", "source", -1, 500)
            .unwrap()
            .into_iter()
            .find(|op| op.op_kind == "moment.append")
            .unwrap()
    }
    fn proved(mut envelope: ReplicationEnvelope) -> ReplicationEnvelope {
        envelope.payload.as_object_mut().unwrap().remove("authors");
        envelope.payload["settlementReference"] = json!({"formatVersion":1,"recordDigest":"test","record":{"settlementId":"settlement","momentId":"moment","binding":{"workspaceId":"ws"}}});
        envelope.relay_seq = Some(4);
        envelope.settlement_admission = Some(SettlementAdmission::Accepted {
            settlement_id: "settlement".into(),
        });
        envelope.admitted_author_snapshot = Some(
            json!([{"kind":"human","humanId":"reader","humanName":"Reader"},{"kind":"agent","agentId":"assistant","agentName":"Assistant","onBehalfOf":"reader","depth":2}]),
        );
        envelope
    }
    #[test]
    fn accepted_snapshot_keeps_unattributed_coverage_after_import_and_refresh() {
        let (_scratch, _path, mut owner) = open_store();
        let mut envelope = proved(source(&mut owner));
        let snapshot = json!([
            {"kind":"human","humanId":"reader","humanName":"Reader"},
            {"kind":"unattributed"}
        ]);
        let native_snapshot = json!([
            {"kind":"human","humanId":"reader","humanName":"Reader","relayConfirmed":true},
            {"kind":"unattributed"}
        ]);
        envelope.admitted_author_snapshot = Some(snapshot.clone());
        owner.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE replication_log SET payload_json=?1 WHERE workspace_id='ws' AND origin_id=?2 AND origin_seq=?3",
                params![envelope.payload.to_string(), envelope.origin_id, envelope.origin_seq]).map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        }).unwrap();
        assert!(
            serde_json::from_value::<dohc_engine_collab::live_update_application::LiveAuthorEntry>(
                json!({"kind":"unattributed","humanId":"forged"})
            )
            .is_err()
        );
        let (_peer, _path, mut peer) = open_store();
        VersionedTextStore::new(&mut peer)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        peer.write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs(sha256,byte_length,text) VALUES (?1,13,'accepted work')",
                [dohc_engine_storage::hex_sha256(b"accepted work")],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
        for (index, store) in [&mut peer, &mut owner].into_iter().enumerate() {
            for attempt in 0..2 {
                let outcome = apply_moment_envelope(
                    store,
                    &envelope,
                    &NoFaults,
                    &NoLiveLeases,
                    &ReleasedTails::default(),
                )
                .expect("accept mixed relay snapshot");
                if index == 0 && attempt == 0 {
                    assert!(matches!(outcome.primary, ApplyDisposition::Applied(_)));
                } else {
                    assert_eq!(outcome.primary, ApplyDisposition::Skipped);
                }
                let (native, admitted): (String, String) = store.read_with(|conn| {
                    conn.query_row("SELECT m.author_json,a.authors_json FROM moments m JOIN live_settlement_publication_admissions a USING(workspace_id,moment_id) WHERE m.moment_id='moment'", [], |row| Ok((row.get(0)?, row.get(1)?)))
                }).unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(&native).unwrap(),
                    native_snapshot
                );
                assert_eq!(serde_json::from_str::<Value>(&admitted).unwrap(), snapshot);
            }
        }
    }

    #[test]
    fn only_admitted_humans_carry_relay_confirmation() {
        let (_scratch, _path, mut store) = open_store();
        let accepted = proved(source(&mut store));
        for missing_receipt in [false, true] {
            let mut unadmitted = accepted.clone();
            if missing_receipt {
                unadmitted.relay_seq = None;
            } else {
                unadmitted.settlement_admission = None;
            }
            assert_eq!(
                admitted_moment_authors(&unadmitted).unwrap().unwrap()[0],
                json!({"kind":"human","humanId":"reader","humanName":"Reader"})
            );
        }
        assert_eq!(
            admitted_moment_authors(&accepted).unwrap().unwrap()[0],
            json!({"kind":"human","humanId":"reader","humanName":"Reader","relayConfirmed":true})
        );
    }
    #[test]
    fn accepted_echo_stamps_named_contributors_and_keeps_the_immutable_payload() {
        let (_scratch, _path, mut store) = open_store();
        let original = source(&mut store);
        let envelope = proved(original);
        store.write_with(&NoFaults,|tx|{tx.execute("UPDATE replication_log SET payload_json=?1 WHERE workspace_id='ws' AND origin_id=?2 AND origin_seq=?3",params![envelope.payload.to_string(),envelope.origin_id,envelope.origin_seq]).map_err(SyncError::persist)?;Ok::<_,SyncError>(())}).unwrap();
        let result = apply_moment_envelope(
            &mut store,
            &envelope,
            &NoFaults,
            &NoLiveLeases,
            &ReleasedTails::default(),
        )
        .unwrap();
        assert_eq!(result.primary, ApplyDisposition::Skipped);
        let (payload,authors):(String,String)=store.read_with(|conn|conn.query_row("SELECT r.payload_json,m.author_json FROM replication_log r JOIN moments m ON m.workspace_id=r.workspace_id AND m.moment_id='moment' WHERE r.origin_id=?1 AND r.origin_seq=?2",params![envelope.origin_id,envelope.origin_seq],|r|Ok((r.get(0)?,r.get(1)?))).map_err(SyncError::corrupt)).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&payload).unwrap(),
            envelope.payload
        );
        assert_eq!(
            serde_json::from_str::<Value>(&authors).unwrap(),
            json!([
                {"kind":"human","humanId":"reader","humanName":"Reader","relayConfirmed":true},
                {"kind":"agent","agentId":"assistant","agentName":"Assistant","onBehalfOf":"reader","depth":2}
            ])
        );
        let mut forged = envelope.clone();
        forged.admitted_author_snapshot = Some(json!([{"kind":"human","humanId":"other"}]));
        assert!(matches!(
            apply_moment_envelope(
                &mut store,
                &forged,
                &NoFaults,
                &NoLiveLeases,
                &ReleasedTails::default()
            ),
            Err(SyncError::CoordinateDiverged)
        ));
    }

    #[test]
    fn accepted_live_link_and_agent_snapshot_imports_without_client_author_authority() {
        let retain_text = |store: &mut EngineStore| {
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "INSERT INTO blobs(sha256,byte_length,text) VALUES (?1,13,'accepted work')",
                        [dohc_engine_storage::hex_sha256(b"accepted work")],
                    )
                    .map_err(SyncError::persist)?;
                    Ok::<_, SyncError>(())
                })
                .unwrap();
        };
        let (_scratch, _path, mut source_store) = open_store();
        let mut envelope = proved(source(&mut source_store));
        let snapshot = json!([
            {"kind":"link","publicPrincipalId":"edit-link","label":"Edit link"},
            {"kind":"agent","agentId":"assistant","agentName":"Assistant","onBehalfOf":"reader","depth":2}
        ]);
        envelope.admitted_author_snapshot = Some(snapshot.clone());
        for claimed in [Value::Null, json!([]), snapshot.clone()] {
            let mut forged = envelope.clone();
            forged.payload["authors"] = claimed;
            assert!(matches!(
                validate(&forged),
                Err(SyncError::InvalidInput { .. })
            ));
        }
        let (_peer, _path, mut peer) = open_store();
        VersionedTextStore::new(&mut peer)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        retain_text(&mut peer);
        assert!(matches!(
            apply_moment_envelope(
                &mut peer,
                &envelope,
                &NoFaults,
                &NoLiveLeases,
                &ReleasedTails::default()
            )
            .unwrap()
            .primary,
            ApplyDisposition::Applied(_)
        ));
        let authors: String = peer
            .read_with(|conn| {
                conn.query_row(
                    "SELECT author_json FROM moments WHERE moment_id='moment'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        let retained:String=peer.read_with(|conn|conn.query_row("SELECT authors_json FROM live_settlement_publication_admissions WHERE moment_id='moment'",[],|r|r.get(0))).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&authors).unwrap(), snapshot);
        assert_eq!(serde_json::from_str::<Value>(&retained).unwrap(), snapshot);
        for claimed in [
            snapshot,
            json!([{"kind":"human","humanId":"reader","humanName":"Reader"}]),
            json!([{"kind":"link","publicPrincipalId":"edit-link","label":"Edit link"}]),
            json!([{"kind":"link","grantId":"forged","grantGeneration":1,"principalId":"forged"}]),
        ] {
            let (_ordinary, _path, mut ordinary) = open_store();
            VersionedTextStore::new(&mut ordinary)
                .ensure_main_version("ws", "main", 1, &NoFaults)
                .unwrap();
            retain_text(&mut ordinary);
            let mut forged = envelope.clone();
            forged.settlement_admission = None;
            forged.admitted_author_snapshot = None;
            forged
                .payload
                .as_object_mut()
                .unwrap()
                .remove("settlementReference");
            forged.payload["authors"] = claimed;
            assert!(matches!(
                apply_moment_envelope(
                    &mut ordinary,
                    &forged,
                    &NoFaults,
                    &NoLiveLeases,
                    &ReleasedTails::default()
                )
                .unwrap()
                .primary,
                ApplyDisposition::Refused(_)
            ));
            assert_eq!(ordinary.table_row_count("moments").unwrap(), 0);
        }
        let (_empty, _path, mut empty) = open_store();
        VersionedTextStore::new(&mut empty)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        retain_text(&mut empty);
        envelope.admitted_author_snapshot = Some(json!([]));
        assert!(matches!(
            apply_moment_envelope(
                &mut empty,
                &envelope,
                &NoFaults,
                &NoLiveLeases,
                &ReleasedTails::default()
            )
            .unwrap()
            .primary,
            ApplyDisposition::Applied(_)
        ));
        let (native, retained): (Option<String>, String) = empty.read_with(|conn| {
            conn.query_row("SELECT m.author_json,a.authors_json FROM moments m JOIN live_settlement_publication_admissions a USING(workspace_id,moment_id) WHERE m.moment_id='moment'", [], |r| Ok((r.get(0)?,r.get(1)?)))
        }).unwrap();
        assert_eq!(
            native, None,
            "an empty admitted snapshot names no native moment author"
        );
        assert_eq!(retained, "[]", "exact admission evidence remains retained");
    }
    #[test]
    fn admitted_automation_converts_to_native_moment_authors_and_keeps_exact_replay_identity() {
        let (_scratch, _path, mut store) = open_store();
        let original = source(&mut store);
        let mut envelope = proved(original);
        let automation = json!({"kind":"automation","automationId":"collection:Tasks#mark",
            "attribution":{"actorKind":"automation","onBehalfOf":"presser","depth":1,
                "run":{"claimId":"claim","automationName":"Mark task"}}});
        envelope.admitted_author_snapshot = Some(json!([automation]));
        store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE replication_log SET payload_json=?1 WHERE workspace_id='ws' AND origin_id=?2 AND origin_seq=?3",
                params![envelope.payload.to_string(),envelope.origin_id,envelope.origin_seq]).map_err(SyncError::persist)?;
            Ok::<_,SyncError>(())
        }).unwrap();
        for _ in 0..2 {
            assert_eq!(
                apply_moment_envelope(
                    &mut store,
                    &envelope,
                    &NoFaults,
                    &NoLiveLeases,
                    &ReleasedTails::default()
                )
                .unwrap()
                .primary,
                ApplyDisposition::Skipped
            );
        }
        let (authors, snapshot): (String, String) = store.read_with(|conn| {
            conn.query_row("SELECT m.author_json,a.authors_json FROM moments m JOIN live_settlement_publication_admissions a ON a.workspace_id=m.workspace_id AND a.moment_id=m.moment_id WHERE m.workspace_id='ws' AND m.moment_id='moment'", [], |r| Ok((r.get(0)?,r.get(1)?))).map_err(SyncError::corrupt)
        }).unwrap();
        let expected = json!([{"kind":"automation","automationId":"collection:Tasks#mark","onBehalfOf":"presser","depth":1}]);
        assert_eq!(serde_json::from_str::<Value>(&authors).unwrap(), expected);
        assert_eq!(
            serde_json::from_str::<Value>(&snapshot).unwrap(),
            envelope.admitted_author_snapshot.clone().unwrap()
        );
        for (field, changed) in [
            ("onBehalfOf", json!("other")),
            (
                "run",
                json!({"claimId":"other-claim","automationName":"Mark task"}),
            ),
        ] {
            let mut forged = envelope.clone();
            forged.admitted_author_snapshot.as_mut().unwrap()[0]["attribution"][field] = changed;
            assert!(matches!(
                apply_moment_envelope(
                    &mut store,
                    &forged,
                    &NoFaults,
                    &NoLiveLeases,
                    &ReleasedTails::default()
                ),
                Err(SyncError::CoordinateDiverged)
            ));
        }
        let (_peer_scratch, _peer_path, mut peer) = open_store();
        VersionedTextStore::new(&mut peer)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        peer.write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs(sha256,byte_length,text) VALUES (?1,13,'accepted work')",
                [&envelope.payload["payloadAfterBlobSha256"].as_str().unwrap()],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
        assert!(matches!(
            apply_moment_envelope(
                &mut peer,
                &envelope,
                &NoFaults,
                &NoLiveLeases,
                &ReleasedTails::default()
            )
            .unwrap()
            .primary,
            ApplyDisposition::Applied(_)
        ));
        let imported: String = peer.read_with(|conn| conn.query_row("SELECT author_json FROM moments WHERE workspace_id='ws' AND moment_id='moment'", [], |r|r.get(0)).map_err(SyncError::corrupt)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&imported).unwrap(), expected);
    }

    #[test]
    fn singleton_budget_refusal_pushes_the_unavailable_fallback_and_later_operations() {
        let (_scratch, _path, mut store) = open_store();
        let original = source(&mut store);
        let mut proof = proved(original.clone());
        proof.relay_seq = None;
        proof.settlement_admission = None;
        proof.admitted_author_snapshot = None;
        store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE replication_log SET payload_json=?1 WHERE workspace_id='ws' AND origin_id=?2 AND origin_seq=?3",
                params![proof.payload.to_string(),proof.origin_id,proof.origin_seq]).map_err(SyncError::persist)?;
            crate::journal_local_op_in_tx(tx, "ws", "probe", &json!({"later":true}), 11)?;
            Ok::<_,SyncError>(())
        }).unwrap();
        let client =
            crate::RelaySyncClient::new(crate::tests::FakeRelay::refusing_oversized_proofs());
        assert!(matches!(
            client.push_workspace(&mut store, "ws", &NoFaults, &NoLiveLeases, 20, 0),
            Ok(crate::SyncPassOutcome::Complete { .. })
        ));
        assert_eq!(
            read_pushed_seq(&store, "ws", &original.origin_id).unwrap(),
            original.origin_seq + 2
        );
        let requests = client.transport().pushed_requests();
        let served: Vec<_> = requests
            .iter()
            .filter(|request| {
                request.ops.len() == 1
                    || !request
                        .ops
                        .iter()
                        .any(|op| op.payload.get("settlementReference").is_some())
            })
            .flat_map(|request| &request.ops)
            .collect();
        assert!(
            served
                .iter()
                .any(|op| op.op_kind == "probe" && op.payload["later"] == true)
        );
        let fallback = served
            .iter()
            .find(|op| op.payload.get("attributionUnavailable").is_some())
            .unwrap();
        assert_eq!(
            fallback.payload["attributionUnavailable"]["settlementId"],
            "settlement"
        );
        assert_eq!(
            fallback.payload["metadata"]["summary"],
            "Attribution unavailable"
        );
        assert!(fallback.payload.get("authors").is_none());
        assert!(fallback.payload.get("settlementReference").is_none());
        assert_eq!(crate::list_refusal_notices(&store, "ws").unwrap().len(), 1);
    }

    #[test]
    fn acknowledged_refusal_journals_one_marked_fallback_and_does_not_wedge_the_origin() {
        let (_scratch, _path, mut store) = open_store();
        let original = source(&mut store);
        let refusal = SettlementPublicationRefusal {
            origin_id: original.origin_id.clone(),
            origin_seq: original.origin_seq,
            moment_id: "moment".into(),
            settlement_id: "unavailable".into(),
            reason: "authorship-mismatch".into(),
        };
        for _ in 0..2 {
            assert!(matches!(
                crate::cursor::write_pushed_seq_with_refusals(
                    &mut store,
                    "ws",
                    &original.origin_id,
                    original.origin_seq,
                    std::slice::from_ref(&refusal),
                    &[],
                    &[],
                    &NoFaults,
                    &NoLiveLeases,
                    20
                )
                .unwrap(),
                TxnOutcome::Committed(_)
            ));
        }
        assert_eq!(
            read_pushed_seq(&store, "ws", &original.origin_id).unwrap(),
            original.origin_seq
        );
        let ops = list_replication_ops(&store, "ws", &original.origin_id, -1, 500).unwrap();
        let original_again = ops
            .iter()
            .find(|op| op.origin_seq == original.origin_seq)
            .unwrap();
        assert_eq!(original_again.payload, original.payload);
        let fallbacks: Vec<_> = ops
            .iter()
            .filter(|op| op.payload.get("attributionUnavailable").is_some())
            .collect();
        assert_eq!(fallbacks.len(), 1);
        let fallback = fallbacks[0];
        assert!(fallback.payload.get("authors").is_none());
        assert!(fallback.payload.get("settlementReference").is_none());
        assert_eq!(
            fallback.payload["metadata"]["summary"],
            "Attribution unavailable"
        );
        let (authors,summary):(Option<String>,String)=store.read_with(|conn|conn.query_row("SELECT author_json,metadata_summary FROM moments WHERE workspace_id='ws' AND moment_id='moment'",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(SyncError::corrupt)).unwrap();
        assert!(authors.is_none());
        assert_eq!(summary, "Attribution unavailable");
        assert_eq!(crate::list_refusal_notices(&store, "ws").unwrap().len(), 1);
        let (_peer_scratch, _peer_path, mut peer) = open_store();
        VersionedTextStore::new(&mut peer)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        let mut refused = original.clone();
        refused.origin_seq = 0;
        refused.relay_seq = Some(1);
        refused.settlement_admission = Some(SettlementAdmission::Refused {
            settlement_id: "unavailable".into(),
            reason: "authorship-mismatch".into(),
        });
        assert!(matches!(
            apply_moment_envelope(
                &mut peer,
                &refused,
                &NoFaults,
                &NoLiveLeases,
                &ReleasedTails::default()
            )
            .unwrap()
            .primary,
            ApplyDisposition::Refused(_)
        ));
        let mut next = refused.clone();
        next.origin_seq = 1;
        next.op_kind = "probe".into();
        next.settlement_admission = None;
        next.payload = json!({});
        assert_eq!(
            apply_envelope_with(&mut peer, &next, &NoFaults, |_, _| Ok(()))
                .unwrap()
                .primary,
            ApplyDisposition::Applied(())
        );
        assert_eq!(
            crate::read_replication_acked_seq(&peer, "ws", &refused.origin_id).unwrap(),
            1
        );
    }
    #[test]
    fn malformed_refused_push_keeps_its_original_and_advances_the_cursor() {
        for payload in [
            json!({"settlementReference":null,"momentId":null}),
            json!({"settlementReference":{"record":{"settlementId":17}}}),
            json!({"settlementReference":{"record":{"settlementId":"valid"}},"momentId":"moment","authors":[]}),
            json!({"momentId":"moment","versionId":"main","objectId":"object","payloadAfterBlobSha256":dohc_engine_storage::hex_sha256(b"accepted work"),"settlementReference":false}),
        ] {
            let (_scratch, _path, mut store) = open_store();
            let mut op = source(&mut store);
            op.payload = payload;
            op.origin_seq = match store
                .write_with(&NoFaults, |tx| {
                    crate::journal_local_op_in_tx(tx, "ws", "moment.append", &op.payload, 21)
                })
                .unwrap()
            {
                TxnOutcome::Committed(sequence) => sequence,
                _ => panic!("journal must commit"),
            };
            let refusal = SettlementPublicationRefusal {
                origin_id: op.origin_id.clone(),
                origin_seq: op.origin_seq,
                moment_id: "unavailable".into(),
                settlement_id: "unavailable".into(),
                reason: "authorship-mismatch".into(),
            };
            validate_push_refusals(std::slice::from_ref(&refusal), std::slice::from_ref(&op))
                .unwrap();
            crate::cursor::write_pushed_seq_with_refusals(
                &mut store,
                "ws",
                &op.origin_id,
                op.origin_seq,
                std::slice::from_ref(&refusal),
                &[],
                &[],
                &NoFaults,
                &NoLiveLeases,
                22,
            )
            .unwrap();
            assert_eq!(
                read_pushed_seq(&store, "ws", &op.origin_id).unwrap(),
                op.origin_seq
            );
            let saved =
                list_replication_ops(&store, "ws", &op.origin_id, op.origin_seq - 1, 1).unwrap();
            assert_eq!(saved[0].payload, op.payload);
            assert_eq!(crate::list_refusal_notices(&store, "ws").unwrap().len(), 1);
        }
    }

    #[test]
    fn unrelated_live_update_snapshots_are_not_settlement_admissions() {
        let envelope = ReplicationEnvelope {
            workspace_id: "ws".into(),
            origin_id: "source".into(),
            origin_seq: 0,
            relay_seq: Some(1),
            op_kind: "ydoc.update".into(),
            payload: json!({}),
            recorded_at_ms: 1,
            settlement_admission: None,
            admitted_author_snapshot: Some(json!([{"kind":"human","humanId":"reader"}])),
        };
        validate(&envelope).unwrap();
    }
}
