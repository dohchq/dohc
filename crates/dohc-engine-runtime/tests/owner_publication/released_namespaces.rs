//! Sol's any-namespace ruling: a capture released without adopting in one
//! relay namespace, beside the document's activation in another.

use super::*;

/// The namespace of the capture that never adopted.
const ELSEWHERE: &str = "other";

/// The document captured in [`ELSEWHERE`] and released there without
/// adopting, once it left the hosted scope. It then returns to the scope.
async fn release_elsewhere(host: &mut WindowHost) {
    let captured = host
        .actor
        .capture_imported_owner_activation(
            ELSEWHERE.into(),
            window_key(),
            WINDOW_PATH.into(),
            1_000_000,
            None,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap();
    let owner = host
        .actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    owner
        .register_activation(
            ELSEWHERE.into(),
            window_host_coordinate(),
            window_binding(&host.lineage),
            captured.activation_id.clone(),
        )
        .await
        .unwrap();
    let scope = dohc_engine_runtime::actor::OwnedRetirementScope {
        namespace: ELSEWHERE.into(),
        max_deliveries: 8,
        max_applications: 8,
    };
    let key = RetirementKey {
        object_id: "object".into(),
        lineage_claim_id: host.lineage.clone(),
        activation_id: captured.activation_id,
        restore_fence_generation: 0,
        accepted_through: 10,
    };
    owner
        .begin_retirement(scope.clone(), window_host_coordinate(), key.clone(), false)
        .await
        .unwrap();
    execute(&mut host.store, "INSERT INTO hosted_replicas(workspace_id,scope_generation,created_at_ms,main_cursor,last_outbound_seq)
          VALUES ('workspace',1,0,1,(SELECT COALESCE(MAX(origin_seq),-1) FROM replication_log WHERE origin_id='origin'));
        INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation) VALUES ('workspace','object','notes/plan.md','ready',0)");
    assert!(matches!(
        owner
            .release_activation(scope, window_host_coordinate(), key, 40)
            .await
            .unwrap(),
        Release::Released { boundary: None, .. }
    ));
    execute(
        &mut host.store,
        "UPDATE hosted_documents SET scope_generation=1,state='ready';
        UPDATE hosted_replicas SET scope_token='scope'",
    );
    owner.close().await.unwrap();
}

/// A synced update of the document fed from [`ELSEWHERE`].
fn incoming() -> IncomingCoordinate {
    IncomingCoordinate {
        relay_namespace: Some(ELSEWHERE.into()),
        replication_epoch: "epoch".into(),
        stream_identity: "stream".into(),
        origin_id: "desktop".into(),
        origin_seq: 4,
        relay_seq: 9,
    }
}

/// The binding protection names for the document's `lineage` on `tails`,
/// bound to `store`, after every validation it waits for; none while
/// nothing protects it.
fn decided(
    store: &EngineStore,
    lineage: &str,
    tails: &ReleasedTails,
) -> Option<ReleasedLineageBinding> {
    let (doc, incoming) = (window_key(), incoming());
    let key = ProtectionKey {
        doc: &doc,
        lineage_claim_id: lineage,
        incoming: &incoming,
    };
    let tails = tails.bound_to(store);
    loop {
        match store
            .read_with(|conn| protection(conn, &key, &tails))
            .unwrap()
        {
            Protection::Pending(pending) => pending.validate().wait().unwrap(),
            Protection::Unprotected => return None,
            Protection::Protected { binding, .. } => return Some(*binding),
        }
    }
}

/// One hosted pass fed from [`ELSEWHERE`], run to its end.
async fn pass_elsewhere(
    root: &ScratchDir,
    store: &mut EngineStore,
    client: &dohc_engine_sync::RelaySyncClient<HostedFeed>,
) -> dohc_engine_sync::HostedPassOutcome {
    let mut cache = witness_cache(root).await;
    loop {
        match client.pull_hosted_workspace(
            store,
            &mut cache,
            "workspace",
            ELSEWHERE,
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
        ) {
            Err(dohc_engine_sync::RelayError::ValidationPending(pending)) => {
                pending.validate().wait().unwrap();
            }
            pass => return pass.unwrap(),
        }
    }
}

/// The document's snapshot: its path and content digest.
fn snapshot(store: &EngineStore) -> (String, String) {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT path,blob_sha256 FROM snapshots WHERE object_id='object'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap()
}

/// `op` rebased over the host's head, as a peer that had seen it sends it.
fn over_head(
    store: &EngineStore,
    mut op: dohc_engine_sync::ReplicationEnvelope,
) -> dohc_engine_sync::ReplicationEnvelope {
    let (sha, latest, updated): (String, String, i64) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT blob_sha256,latest_moment_id,updated_at_ms FROM snapshots WHERE object_id='object'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .unwrap();
    let fields = op.payload.as_object_mut().unwrap();
    for (name, value) in [
        ("payloadBeforeBlobSha256", serde_json::json!(sha)),
        ("beforeBlobSha256", serde_json::json!(sha)),
        ("beforeLatestMomentId", serde_json::json!(latest)),
        ("beforeUpdatedAtMs", serde_json::json!(updated)),
    ] {
        if fields.contains_key(name) {
            fields.insert(name.into(), value);
        }
    }
    op
}

/// Sol's any-namespace ruling, while A is current: B, a capture in another
/// namespace, released without adopting, and A then adopted in "relay". A
/// rewrite of the host's head, and a delete, rename or binary write from the
/// owner's desktop, from its own head or over the host's, fed from B's
/// namespace find no protecting window. Each leaves A's native state and the
/// document's snapshot as they were, with nothing to materialize: over the
/// host's head the current activation's guard refuses it, and from the
/// desktop's own head it opens a conflict.
#[tokio::test]
async fn input_fed_from_a_released_namespace_never_replaces_a_current_activations_state() {
    let mut cases = vec![("a rewrite".to_owned(), None, true)];
    for change in FILE_CHANGES {
        cases.push((
            format!("{change:?} from the desktop's head"),
            Some(change),
            false,
        ));
        cases.push((
            format!("{change:?} over the host's head"),
            Some(change),
            true,
        ));
    }
    for (case, change, rebased) in cases {
        let mut host = window_host().await;
        release_elsewhere(&mut host).await;
        let mut w = adopt_window(host, true).await;
        assert!(
            decided(&w.store, &w.lineage, &ReleasedTails::default()).is_none(),
            "{case}: A is current"
        );
        let desktop = desktop_of(&w.base, &w.lineage, &[w.covered_bytes.clone()]).await;
        let head = desktop.file();
        let (op, bytes) = match change {
            None => host_write(&w.store, WINDOW_PATH, "Rewritten elsewhere.\n"),
            Some(change) => desktop.change(change).await,
        };
        let op = if rebased { over_head(&w.store, op) } else { op };
        let feed = HostedFeed::new(&[("object", WINDOW_PATH)]);
        feed.blobs
            .lock()
            .unwrap()
            .insert(hex_sha256(head.as_bytes()), head.into_bytes());
        feed.serve(op, bytes);
        let client = dohc_engine_sync::RelaySyncClient::new(feed);
        let (native, before) = (w.native(), snapshot(&w.store));
        let pass = pass_elsewhere(&w.root, &mut w.store, &client).await;
        let outcome = format!(
            "applied {} refused {} skipped {} conflicts {} changed {:?} refusals {:?} held {:?}",
            pass.applied,
            pass.refused,
            pass.skipped,
            pass.conflicts_opened,
            pass.changed_paths,
            pass.refusals,
            pass.held
        );
        assert_eq!(w.native(), native, "{case}: native; {outcome}");
        assert_eq!(snapshot(&w.store), before, "{case}: snapshot; {outcome}");
        assert!(pass.changed_paths.is_empty(), "{case}: {outcome}");
        if rebased {
            assert!(
                matches!(pass.refusals.as_slice(), [refusal] if matches!(
                    &refusal.reason,
                    dohc_engine_sync::RefusalReason::InvalidInput { reason }
                        if reason == "live document binding is still active"
                )),
                "{case}: the current activation's guard refuses it; {outcome}"
            );
        } else {
            assert_eq!(
                pass.conflicts_opened, 1,
                "{case}: a conflict to resolve; {outcome}"
            );
        }
        desktop.close().await;
        w.close().await;
    }
}

/// Sol's any-namespace ruling, once A releases: tails validated while only
/// B's release stood, and a validation in flight then, never answer for A's
/// release. The next decision on each validates again, and A's Carried
/// deliveries protect the lineage under A's tail alone.
#[tokio::test]
async fn protection_resumes_for_a_released_activations_work_beside_another_namespace() {
    let mut host = window_host().await;
    release_elsewhere(&mut host).await;
    let lineage = host.lineage.clone();
    let warm = ReleasedTails::default();
    assert!(
        decided(&host.store, &lineage, &warm).is_none(),
        "B retains nothing"
    );
    assert_eq!(warm.validations(), 1);
    let in_flight = ReleasedTails::default().bound_to(&host.store);
    in_flight.pause_validation();
    let (doc, incoming) = (window_key(), incoming());
    let key = ProtectionKey {
        doc: &doc,
        lineage_claim_id: &lineage,
        incoming: &incoming,
    };
    let Protection::Pending(pending) = host
        .store
        .read_with(|conn| protection(conn, &key, &in_flight))
        .unwrap()
    else {
        panic!("B's window waits for validation");
    };
    let validation = pending.validate();
    in_flight.paused_validation().await;
    let mut w = adopt_window(host, true).await;
    w.release().await;
    in_flight.resume_validation();
    validation.await.unwrap();
    for (case, tails) in [("warm", &warm), ("in flight", &in_flight)] {
        let binding =
            decided(&w.store, &lineage, tails).unwrap_or_else(|| panic!("{case}: protected"));
        let ProtectedTails::Listed(listed) = &*binding.tails else {
            panic!("{case}: a window that reads");
        };
        let named: Vec<_> = listed
            .iter()
            .map(|tail| (tail.namespace.as_str(), tail.activation_id.as_str()))
            .collect();
        assert_eq!(named, [("relay", w.first.activation_id.as_str())], "{case}");
        assert!(
            matches!(&listed[0].coverage, RetainedCoverage::Unproven(unproven) if unproven.count == 2),
            "{case}: {:?}",
            listed[0].coverage
        );
        assert_eq!(tails.validations(), 2, "{case}");
    }
    w.close().await;
}
