use super::*;

fn pump_retained_push(store: &mut EngineStore, relay: &mut Relay, present: bool) {
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    let mut confirmed = BTreeSet::new();
    let mut extended = false;
    let mut inventories: Vec<Vec<String>> = Vec::new();
    for _ in 0..40 {
        if let Some((pushed, more)) = step(store, &mut cache, &transport) {
            assert_eq!((pushed, more), (4, false));
            assert!(extended);
            assert_eq!(
                relay.ops.keys().copied().collect::<Vec<_>>(),
                vec![0, 1, 2, 3]
            );
            let expected =
                dohc_engine_sync::list_replication_ops(store, WORKSPACE, ORIGIN, -1, 4).unwrap();
            assert_eq!(
                relay.ops.values().collect::<Vec<_>>(),
                expected.iter().collect::<Vec<_>>()
            );
            assert_eq!(
                inventories.len(),
                2,
                "one inventory for each prepared suffix"
            );
            assert_eq!(inventories[1].len(), 1, "only the new blob needs an answer");
            return;
        }
        let request = transport.take_pending().expect("deferred request");
        if let RelayIoRequest::BlobsHave(have) = &request {
            assert!(
                have.sha256s.iter().all(|sha| !confirmed.contains(sha)),
                "this push already confirmed a blob in {have:?}"
            );
            inventories.push(have.sha256s.clone());
            if present && !extended {
                relay.blobs.extend(have.sha256s.iter().cloned());
            }
        }
        let response = relay.answer(&request);
        match (&request, &response) {
            (RelayIoRequest::BlobsHave(have), RelayIoResponse::BlobsHave(answer)) => {
                confirmed.extend(
                    have.sha256s
                        .iter()
                        .filter(|sha| !answer.missing.contains(sha))
                        .cloned(),
                );
            }
            (RelayIoRequest::UploadBlob(upload), RelayIoResponse::UploadBlob) => {
                confirmed.insert(upload.sha256.clone());
            }
            _ => {}
        }
        let extend = !extended
            && if present {
                matches!(request, RelayIoRequest::BlobsHave(_))
            } else {
                matches!(
                    request,
                    RelayIoRequest::UploadBlob(_) | RelayIoRequest::UploadBlobs(_)
                )
            };
        transport.complete(request, Ok(response));
        if extend {
            append_file(store, 2);
            let mut repeated =
                dohc_engine_sync::list_replication_ops(store, WORKSPACE, ORIGIN, -1, 1)
                    .unwrap()
                    .remove(0)
                    .payload;
            repeated["momentId"] = serde_json::json!("repeated-blob");
            store
                .write_with(&NoFaults, |tx| {
                    dohc_engine_sync::journal_local_op_in_tx(
                        tx,
                        WORKSPACE,
                        "moment.append",
                        &repeated,
                        2300,
                    )
                })
                .unwrap();
            extended = true;
        }
    }
    panic!("prepared push did not finish");
}

#[test]
fn prepared_push_keeps_uploaded_blobs_across_a_later_append() {
    let (_scratch, _path, mut store) = fixture_with_files(2);
    pump_retained_push(&mut store, &mut Relay::default(), false);
}

#[test]
fn prepared_push_keeps_have_confirmations_and_asks_for_a_new_blob() {
    let (_scratch, _path, mut store) = fixture_with_files(2);
    pump_retained_push(&mut store, &mut Relay::default(), true);
}

#[test]
fn prepared_push_uploads_four_blobs_in_one_transport_round() {
    let (_scratch, _path, mut store) = fixture_with_files(4);
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    let mut relay = Relay::default();
    let mut upload_rounds = 0;
    for _ in 0..20 {
        if let Some(outcome) = step(&mut store, &mut cache, &transport) {
            assert_eq!(outcome, (4, false));
            assert_eq!(relay.uploads.len(), 4);
            assert_eq!(
                upload_rounds, 1,
                "four independent blobs need one transport round"
            );
            return;
        }
        let request = transport.take_pending().unwrap();
        if !matches!(
            request,
            RelayIoRequest::BlobsHave(_) | RelayIoRequest::Push(_)
        ) {
            upload_rounds += 1;
        }
        let response = relay.answer(&request);
        transport.complete(request, Ok(response));
    }
    panic!("push did not finish");
}

#[test]
fn prepared_push_rechecks_an_identity_changed_during_upload() {
    identity_change_during_upload("stream_identity", "replacement", "replacement");
}

#[test]
fn prepared_push_rechecks_an_origin_identity_changed_during_upload() {
    identity_change_during_upload("origin_id", "replacement", "stream");
}

fn identity_change_during_upload(column: &str, value: &str, stream: &str) {
    let (_scratch, _path, mut store) = fixture_with_files(1);
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    let mut relay = Relay::default();
    loop {
        assert_eq!(step(&mut store, &mut cache, &transport), None);
        let request = transport.take_pending().unwrap();
        let response = relay.answer(&request);
        let uploaded = matches!(request, RelayIoRequest::UploadBlob(_));
        transport.complete(request, Ok(response));
        if uploaded {
            break;
        }
    }
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                &format!("UPDATE sync_identity SET {column}=?1 WHERE workspace_id='ws'"),
                [value],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
    assert_eq!(step(&mut store, &mut cache, &transport), None);
    let RelayIoRequest::BlobsHave(have) = transport.take_pending().unwrap() else {
        panic!("old identity retained its upload authority");
    };
    assert_eq!(have.stream_identity, stream);
    assert_eq!(have.sha256s.len(), 1);
    assert_eq!(read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(), -1);
}

#[test]
fn prepared_push_restart_after_upload_before_append_uses_the_durable_cursor() {
    let (_scratch, path, mut store) = fixture_with_files(2);
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    let mut relay = Relay::default();
    loop {
        assert_eq!(step(&mut store, &mut cache, &transport), None);
        let request = transport.take_pending().unwrap();
        if matches!(request, RelayIoRequest::Push(_)) {
            break;
        }
        let response = relay.answer(&request);
        transport.complete(request, Ok(response));
    }
    assert_eq!(relay.uploads.len(), 2);
    assert_eq!(read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(), -1);
    drop(transport);
    drop(store);
    let mut store = EngineStore::open(&path, 2500).unwrap();
    assert_eq!(pump_pass(&mut store, &mut relay), (2, false));
    assert_eq!(relay.inventories, 2, "a new push must ask the relay again");
    assert!(relay.uploads.values().all(|count| *count == 1));
    assert_eq!(read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(), 1);
}

#[test]
fn prepared_push_missing_blob_at_append_fails_without_advancing_then_retries() {
    let (_scratch, _path, mut store) = fixture_with_files(1);
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    let mut relay = Relay::default();
    loop {
        assert_eq!(step(&mut store, &mut cache, &transport), None);
        let request = transport.take_pending().unwrap();
        if matches!(request, RelayIoRequest::Push(_)) {
            relay.blobs.clear();
            transport.complete(request, Err(RelayError::BlobMissing));
            break;
        }
        let response = relay.answer(&request);
        transport.complete(request, Ok(response));
    }
    let result = execute_relay_operation(
        &mut store,
        &mut cache,
        transport,
        push_operation(),
        &LeaseRegistry::default(),
        &ClaimAnnouncer::default(),
    );
    assert!(matches!(
        result,
        Err(RuntimeError::Relay(RelayError::BlobMissing))
    ));
    assert_eq!(read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(), -1);
    assert!(relay.ops.is_empty());
    assert_eq!(pump_pass(&mut store, &mut relay), (1, false));
    assert_eq!(relay.uploads.values().copied().collect::<Vec<_>>(), vec![2]);
}
