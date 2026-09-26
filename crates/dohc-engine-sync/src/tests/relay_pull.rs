use super::*;

#[derive(Default)]
struct ClaimRelay {
    relay: FakeRelay,
    refusal: Mutex<Option<RelayError>>,
    claims: Mutex<Vec<ClaimRequest>>,
}

impl RelayTransport for ClaimRelay {
    fn claim_workspace(&self, req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        self.claims.lock().unwrap().push(req);
        match self.refusal.lock().unwrap().clone() {
            Some(error) => Err(error),
            None => Ok(ClaimResponse),
        }
    }
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError> {
        self.relay.push(req)
    }
    fn pull(&self, req: PullRequest) -> Result<PullResponse, RelayError> {
        self.relay.pull(req)
    }
    fn lookup_log_coordinate(
        &self,
        req: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError> {
        self.relay.lookup_log_coordinate(req)
    }
    fn probe(&self, req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        self.relay.probe(req)
    }
    fn rotate_epoch(&self, req: EpochRequest) -> Result<EpochResponse, RelayError> {
        self.relay.rotate_epoch(req)
    }
    fn blobs_have(&self, req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        self.relay.blobs_have(req)
    }
    fn upload_blob(&self, req: BlobUploadRequest) -> Result<(), RelayError> {
        self.relay.upload_blob(req)
    }
    fn download_blobs(
        &self,
        req: BlobDownloadBatchRequest,
    ) -> Result<BlobDownloadBatchResponse, RelayError> {
        self.relay.download_blobs(req)
    }
    fn upload_key_envelope(
        &self,
        req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        self.relay.upload_key_envelope(req)
    }
    fn download_key_envelope(
        &self,
        req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        self.relay.download_key_envelope(req)
    }
    fn shared_channel_pull(
        &self,
        req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        self.relay.shared_channel_pull(req)
    }
    fn share_log_push(&self, req: ShareLogPushRequest) -> Result<PushResponse, RelayError> {
        self.relay.share_log_push(req)
    }
    fn share_view_pull(&self, req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        self.relay.share_view_pull(req)
    }
    fn share_blob(&self, req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        self.relay.share_blob(req)
    }
    fn share_blob_upload(&self, req: ShareBlobUploadRequest) -> Result<(), RelayError> {
        self.relay.share_blob_upload(req)
    }
    fn share_proposal_submit(
        &self,
        req: ShareProposalSubmitRequest,
    ) -> Result<ShareProposalSubmitResponse, RelayError> {
        self.relay.share_proposal_submit(req)
    }
    fn share_collection_write(
        &self,
        req: ShareCollectionWriteRequest,
    ) -> Result<ShareCollectionWriteResponse, RelayError> {
        self.relay.share_collection_write(req)
    }
}

#[test]
fn relay_claim_refusal_survives_restart_until_successful_retry() {
    for refusal in [
        RelayError::WorkspaceUnavailable,
        RelayError::EpochSuperseded,
        RelayError::IdentityNotRecognized,
        RelayError::IdentityRequired,
        RelayError::StreamIdentityMismatch,
    ] {
        let (_scratch, path, mut engine) = open_store();
        seed_identity(&mut engine);
        let identity = read_sync_identity(&engine, "ws").unwrap().unwrap();
        let request = ClaimRequest {
            workspace_id: "ws".to_owned(),
            replication_epoch: identity.replication_epoch.clone(),
            stream_identity: identity.stream_identity.clone(),
        };
        let client = RelaySyncClient::new(ClaimRelay::default());
        *client.transport().refusal.lock().unwrap() = Some(refusal.clone());
        assert_eq!(
            client.claim_workspace(&mut engine, request.clone(), Some("account-a"), &NoFaults),
            Err(refusal.clone())
        );
        drop(engine);

        let mut reopened = EngineStore::open(&path, 2_000).unwrap();
        assert_eq!(reopened.read_with(|conn| conn.query_row(
            "SELECT claim_account_id FROM sync_identity WHERE workspace_id='ws'",
            [], |row| row.get::<_, String>(0),
        )).unwrap(), "account-a");
        let restarted = RelaySyncClient::new(ClaimRelay::default());
        assert_eq!(
            restarted.push_workspace(&mut reopened, "ws", &NoFaults, &NoLiveLeases, 2_001, 0),
            Err(RelayError::ClaimRefused(Box::new(refusal.clone())))
        );
        assert!(
            restarted
                .transport()
                .relay
                .pushes
                .lock()
                .unwrap()
                .is_empty()
        );
        assert!(restarted.transport().claims.lock().unwrap().is_empty());
        *restarted.transport().refusal.lock().unwrap() = Some(RelayError::Partitioned);
        assert_eq!(
            restarted.claim_workspace(&mut reopened, request.clone(), Some("account-a"), &NoFaults),
            Err(RelayError::Partitioned)
        );
        drop(reopened);
        let mut reopened = EngineStore::open(&path, 2_002).unwrap();
        assert_eq!(
            restarted.push_workspace(&mut reopened, "ws", &NoFaults, &NoLiveLeases, 2_003, 0),
            Err(RelayError::ClaimRefused(Box::new(refusal)))
        );
        *restarted.transport().refusal.lock().unwrap() = None;
        restarted
            .claim_workspace(&mut reopened, request.clone(), Some("account-a"), &NoFaults)
            .unwrap();
        assert_eq!(read_sync_identity(&reopened, "ws").unwrap(), Some(identity));
        assert_eq!(reopened.read_with(|conn| conn.query_row(
            "SELECT claim_account_id FROM sync_identity WHERE workspace_id='ws'",
            [], |row| row.get::<_, Option<String>>(0),
        )).unwrap(), None);
        drop(reopened);
        let mut reopened = EngineStore::open(&path, 2_004).unwrap();
        restarted
            .push_workspace(&mut reopened, "ws", &NoFaults, &NoLiveLeases, 2_005, 0)
            .unwrap();
        assert_eq!(
            *restarted.transport().claims.lock().unwrap(),
            vec![request.clone(), request]
        );
    }
}

#[test]
fn relay_interrupted_claim_survives_restart_as_identity_required() {
    let (_scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    let identity = read_sync_identity(&engine, "ws").unwrap().unwrap();
    let client = RelaySyncClient::new(ClaimRelay::default());
    *client.transport().refusal.lock().unwrap() = Some(RelayError::Partitioned);
    assert_eq!(
        client.claim_workspace(
            &mut engine,
            ClaimRequest {
                workspace_id: "ws".to_owned(),
                replication_epoch: identity.replication_epoch,
                stream_identity: identity.stream_identity,
            },
            Some("account-a"),
            &NoFaults
        ),
        Err(RelayError::Partitioned)
    );
    drop(engine);
    let mut reopened = EngineStore::open(&path, 2_000).unwrap();
    assert_eq!(
        client.push_workspace(&mut reopened, "ws", &NoFaults, &NoLiveLeases, 2_001, 0),
        Err(RelayError::IdentityRequired)
    );
}

#[test]
fn push_without_identity_requests_enrollment() {
    let (_scratch, _path, mut engine) = open_store();
    let client = RelaySyncClient::new(FakeRelay::default());
    let result =
        client.push_workspace(&mut engine, "ws", &NoFaults, &crate::NoLiveLeases, 1_000, 0);
    assert!(matches!(result, Err(RelayError::IdentityRequired)));
    assert!(
        client
            .transport()
            .pushes
            .lock()
            .expect("push calls")
            .is_empty()
    );
}

#[test]
fn locally_journaled_identity_requires_claim_before_push() {
    let (_scratch, path, mut store) = open_store();
    journal_local_replication_op(
        &mut store,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "probe.local",
        &json!({}),
        1_000,
        &NoFaults,
    )
    .unwrap();
    drop(store);
    let mut store = EngineStore::open(&path, 2_000).unwrap();
    let client = RelaySyncClient::new(ClaimRelay::default());
    assert_eq!(
        client.push_workspace(&mut store, "ws", &NoFaults, &NoLiveLeases, 2_001, 0),
        Err(RelayError::IdentityRequired)
    );
    client
        .claim_workspace(
            &mut store,
            ClaimRequest {
                workspace_id: "ws".to_owned(),
                replication_epoch: "epoch-1".to_owned(),
                stream_identity: "stream-1".to_owned(),
            },
            Some("account-a"),
            &NoFaults,
        )
        .unwrap();
    client
        .push_workspace(&mut store, "ws", &NoFaults, &NoLiveLeases, 2_002, 0)
        .unwrap();
    assert_eq!(client.transport().claims.lock().unwrap().len(), 1);
}

struct FirstLeaseCheckLive(AtomicUsize);

impl LeaseProbe for FirstLeaseCheckLive {
    fn is_live(&self, _key: &dohc_engine_collab::DocKey) -> bool {
        self.0.fetch_add(1, Ordering::SeqCst) == 0
    }
}

#[test]
fn fault_sync_during_journal_txn_rolls_back_domain_and_position() {
    let (_scratch, path, mut engine) = open_store();
    let faults = ScriptedFaults::crash_at(FaultPoint::SyncDuringJournalTxn);
    let outcome = journal_local_replication_op(
        &mut engine,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "doc.put",
        &json!({"id":"doc"}),
        1_000,
        faults.as_ref(),
    )
    .expect("fault outcome");
    assert_eq!(outcome, TxnOutcome::Crashed { committed: false });
    drop(engine);
    let mut reopened = EngineStore::open(&path, 1_001).expect("reopen");
    assert!(
        read_sync_identity(&reopened, "ws")
            .expect("identity")
            .is_none()
    );
    let retried = journal_local_replication_op(
        &mut reopened,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "doc.put",
        &json!({"id":"doc"}),
        1_000,
        &NoFaults,
    )
    .expect("retry");
    assert_eq!(retried, TxnOutcome::Committed(0));
}

#[test]
fn join_identity_adoption_creates_only_an_absent_coordinate_and_is_idempotent() {
    let (_scratch, _path, mut engine) = open_store();
    assert_eq!(
        adopt_join_identity(
            &mut engine,
            "ws",
            "origin-joined",
            "epoch-relay",
            "stream-relay",
            2,
            &NoFaults,
        )
        .expect("adopt relay identity"),
        TxnOutcome::Committed(AdoptJoinIdentityOutcome::Adopted)
    );
    assert_eq!(
        read_sync_identity(&engine, "ws").expect("identity"),
        Some(SyncIdentity {
            workspace_id: "ws".to_owned(),
            origin_id: "origin-joined".to_owned(),
            replication_epoch: "epoch-relay".to_owned(),
            stream_identity: "stream-relay".to_owned(),
        })
    );

    assert_eq!(
        adopt_join_identity(
            &mut engine,
            "ws",
            "origin-must-not-replace",
            "epoch-relay",
            "stream-relay",
            3,
            &NoFaults,
        )
        .expect("retry same coordinate"),
        TxnOutcome::Committed(AdoptJoinIdentityOutcome::AlreadyMatched)
    );
    assert_eq!(
        read_sync_identity(&engine, "ws")
            .expect("identity")
            .expect("present")
            .origin_id,
        "origin-joined"
    );
}

#[test]
fn join_identity_adoption_rejects_non_relay_identity_text_without_writing() {
    let (_scratch, _path, mut engine) = open_store();
    let cases = [
        ("ws-origin", " origin-joined", "epoch-relay", "stream-relay"),
        ("ws-epoch", "origin-joined", "epoch-relay ", "stream-relay"),
        (
            "ws-stream",
            "origin-joined",
            "epoch-relay",
            "stream\u{0000}relay",
        ),
        (
            "ws-bom",
            "origin-joined",
            "\u{feff}epoch-relay",
            "stream-relay",
        ),
    ];

    for (workspace_id, origin_id, replication_epoch, stream_identity) in cases {
        assert!(matches!(
            adopt_join_identity(
                &mut engine,
                workspace_id,
                origin_id,
                replication_epoch,
                stream_identity,
                2,
                &NoFaults,
            ),
            Err(SyncError::InvalidInput { .. })
        ));
        assert!(
            read_sync_identity(&engine, workspace_id)
                .expect("identity")
                .is_none(),
            "invalid identity text must not create a row for {workspace_id}"
        );
    }
}

#[test]
fn join_identity_adoption_refuses_a_different_existing_identity() {
    let (_scratch, _path, mut engine) = open_store();
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_identity \
                 (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
                 VALUES ('ws','origin-old','epoch-old','stream-old',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed different identity");

    assert!(matches!(
        adopt_join_identity(
            &mut engine,
            "ws",
            "origin-joined",
            "epoch-relay",
            "stream-relay",
            2,
            &NoFaults,
        ),
        Err(SyncError::InvalidInput {
            reason: "join identity adoption found a different local sync identity"
        })
    ));
    let identity = read_sync_identity(&engine, "ws")
        .expect("identity")
        .expect("present");
    assert_eq!(identity.origin_id, "origin-old");
    assert_eq!(identity.replication_epoch, "epoch-old");
    assert_eq!(identity.stream_identity, "stream-old");
}

#[test]
fn join_identity_adoption_refuses_any_existing_replication_state() {
    let (_scratch, _path, mut engine) = open_store();
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_log \
                 (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                 VALUES ('ws-log','origin-old',0,'workspace.init','{}',1,0)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO sync_relay_cursors \
                 (workspace_id,cursor,replication_epoch,stream_identity) \
                 VALUES ('ws-cursor','0','epoch-old','stream-old')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO replication_peers (workspace_id,origin_id,acked_seq) \
                 VALUES ('ws-peer','origin-old',0)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                 VALUES ('ws-push','origin-old',0)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO shared_channel_cursors (workspace_id,share_id,cursor) \
                 VALUES ('ws-channel-cursor','share-old','0')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO shared_channel_peers \
                 (workspace_id,share_id,origin_id,applied_origin_seq,dense_seq) \
                 VALUES ('ws-channel-peer','share-old','origin-old',0,0)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO shared_channel_push_state (workspace_id,share_id,pushed_seq) \
                 VALUES ('ws-channel-push','share-old',0)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO share_view_cursors (workspace_id,share_id,cursor) \
                 VALUES ('ws-view-cursor','share-old','0')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_pending_replication \
                 (workspace_id,origin_id,origin_seq,dependency_kind,dependency_id) \
                 VALUES ('ws-chat-pending','origin-old',0,'message-thread','thread-old')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO versioned_workspaces (workspace_id,main_version_id) \
                 VALUES ('ws-ydoc-pending','main')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws-ydoc-pending','object-ydoc-pending',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_deferred_updates \
                  (workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms) \
                  VALUES ('ws-ydoc-pending','main','object-ydoc-pending','origin-old',0,1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO versioned_workspaces (workspace_id,main_version_id) \
                 VALUES ('ws-conflict-pending','main')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO replication_pending_conflict_bundles \
                 (workspace_id,conflict_id,format_version,pre_effect_moment_order,created_at_ms) \
                 VALUES ('ws-conflict-pending','conflict-pending',1,0,1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO versioned_workspaces (workspace_id,main_version_id) \
                 VALUES ('ws-ydoc-candidate','main')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws-ydoc-candidate','object-ydoc-candidate',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO versioned_workspaces (workspace_id,main_version_id) \
                 VALUES ('ws-ydoc-recovery','main')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO binary_blobs (sha256,byte_length,bytes) \
                 VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,X'00')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_base_relay_candidates \
                 (workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq) \
                 VALUES ('ws-ydoc-candidate','main','object-ydoc-candidate', \
                         'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', \
                         'origin-old',0)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_recovery_decisions ( \
                     workspace_id,origin_id,origin_seq,version_id,object_id,original_path, \
                     incoming_content_kind,incoming_update_blob_sha256, \
                     incoming_lineage_claim_id,incoming_is_base_state,losing_claim_id, \
                     recovered_path,recovery_collision_ordinal,recovery_object_id, \
                     recovery_moment_id,recorded_at_ms \
                 ) VALUES ( \
                     'ws-ydoc-recovery','origin-old',0,'main','object-ydoc-recovery','doc.md', \
                     'plaintext', \
                     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', \
                     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1, \
                     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', \
                     'doc.recovered.md','0','recovery-object','recovery-moment',1 \
                 )",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed non-pristine state");

    for workspace_id in [
        "ws-log",
        "ws-cursor",
        "ws-peer",
        "ws-push",
        "ws-channel-cursor",
        "ws-channel-peer",
        "ws-channel-push",
        "ws-view-cursor",
        "ws-chat-pending",
        "ws-ydoc-pending",
        "ws-conflict-pending",
        "ws-ydoc-candidate",
        "ws-ydoc-recovery",
    ] {
        assert!(matches!(
            adopt_join_identity(
                &mut engine,
                workspace_id,
                "origin-joined",
                "epoch-relay",
                "stream-relay",
                2,
                &NoFaults,
            ),
            Err(SyncError::InvalidInput {
                reason: "join identity adoption requires pristine local replication state"
            })
        ));
        assert!(
            read_sync_identity(&engine, workspace_id)
                .expect("identity")
                .is_none()
        );
    }
}

#[test]
fn fault_sync_before_apply_commit_reopens_unapplied_and_unacked() {
    let (_scratch, path, mut engine) = open_store();
    let op = envelope("peer", 0, "probe.apply", json!({}));
    let faults = ScriptedFaults::crash_at(FaultPoint::SyncBeforeApplyCommit);
    let outcome = apply_envelope_with(&mut engine, &op, faults.as_ref(), insert_probe)
        .expect("fault outcome");
    assert_eq!(
        outcome,
        ApplyOutcome::new(ApplyDisposition::Crashed { committed: false })
    );
    drop(engine);
    let mut reopened = EngineStore::open(&path, 2_001).expect("reopen");
    let probe_rows: i64 = reopened
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM blobs WHERE sha256='peer'", [], |r| {
                r.get(0)
            })
        })
        .expect("probe rows");
    assert_eq!(probe_rows, 0);
    assert_eq!(
        read_replication_acked_seq(&reopened, "ws", "peer").expect("ack"),
        -1
    );
    assert_eq!(
        apply_envelope_with(&mut reopened, &op, &NoFaults, insert_probe).expect("retry"),
        ApplyOutcome::new(ApplyDisposition::Applied(()))
    );
}

#[test]
fn fault_sync_before_blob_hydrate_commit_leaves_no_blob_or_cursor() {
    let (_scratch, path, mut engine) = open_store();
    let bytes = b"replicated bytes".to_vec();
    let blob = BlobHydration {
        sha256: dohc_engine_storage::hex_sha256(&bytes),
        content: BlobContent::Binary(bytes),
    };
    let faults = ScriptedFaults::crash_at(FaultPoint::SyncBeforeBlobHydrateCommit);
    assert_eq!(
        hydrate_blob_content(&mut engine, &blob, faults.as_ref()).expect("fault"),
        TxnOutcome::Crashed { committed: false }
    );
    drop(engine);
    let mut reopened = EngineStore::open(&path, 2_001).expect("reopen");
    assert!(!reopened.has_binary_blob(&blob.sha256).expect("blob absent"));
    assert!(
        read_relay_cursor(&reopened, "ws")
            .expect("cursor")
            .is_none()
    );
    assert_eq!(
        hydrate_blob_content(&mut reopened, &blob, &NoFaults).expect("retry"),
        TxnOutcome::Committed(())
    );
}

/// Ingest owns the text ceiling. Before this, nothing on the sync path checked
/// `MAX_TEXT_BYTES`: the HTTP transport's blob response bound sat near it by
/// coincidence, and any other `RelayTransport` could store an over-cap body.
///
#[test]
fn text_blob_over_the_text_ceiling_is_refused_at_ingest() {
    let (_scratch, _path, mut engine) = open_store();

    let at_cap = "a".repeat(MAX_TEXT_BYTES);
    let accepted = BlobHydration {
        sha256: dohc_engine_storage::hex_sha256(at_cap.as_bytes()),
        content: BlobContent::Text(at_cap),
    };
    assert_eq!(
        hydrate_blob_content(&mut engine, &accepted, &NoFaults).expect("at-cap text hydrates"),
        TxnOutcome::Committed(())
    );

    let over_cap = "a".repeat(MAX_TEXT_BYTES + 1);
    let refused = BlobHydration {
        sha256: dohc_engine_storage::hex_sha256(over_cap.as_bytes()),
        content: BlobContent::Text(over_cap),
    };
    let error = hydrate_blob_content(&mut engine, &refused, &NoFaults)
        .expect_err("over-cap text is refused");
    assert!(
        matches!(
            error,
            SyncError::BlobTooLarge {
                constraint: "MAX_TEXT_BYTES",
                limit_bytes: MAX_TEXT_BYTES,
                observed_bytes,
            } if observed_bytes == MAX_TEXT_BYTES + 1
        ),
        "unexpected refusal: {error:?}"
    );
    assert_eq!(
        error.to_string(),
        format!(
            "blob exceeds MAX_TEXT_BYTES: limit {MAX_TEXT_BYTES} bytes, observed {} bytes",
            MAX_TEXT_BYTES + 1
        )
    );

    let (stored, refused_rows) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM blobs WHERE sha256=?1",
                    [&accepted.sha256],
                    |row| row.get::<_, i64>(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM blobs WHERE sha256=?1",
                    [&refused.sha256],
                    |row| row.get::<_, i64>(0),
                )?,
            ))
        })
        .expect("blob rows");
    assert_eq!(stored, 1);
    assert_eq!(refused_rows, 0);
}

/// The relay pull checks the ceiling on the undecoded response, before it
/// hashes the bytes and before it copies them into a `String`. The served
/// bytes deliberately do not hash to the requested sha256, so the refusal can
/// only be `BlobTooLarge` while the size check runs first.
///
#[test]
fn oversized_relay_blob_is_refused_before_it_is_hashed_or_copied() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let sha256 = dohc_engine_storage::hex_sha256(b"an honest sha the relay does not serve");
    let op = version_create_with_shipped_snapshots(
        "oversized-blob-peer",
        "oversized-blob-version",
        vec![shipped_text_snapshot(
            "oversized-blob-object",
            "oversized-blob.md",
            &sha256,
        )],
    );
    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![op],
            next_cursor: 1,
            has_more: false,
        },
    )]);
    relay.blobs.insert(sha256, vec![b'a'; MAX_TEXT_BYTES + 1]);
    let client = RelaySyncClient::new(relay);

    assert_eq!(
        client.pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000
        ),
        Err(RelayError::BlobTooLarge {
            constraint: "MAX_TEXT_BYTES",
            limit_bytes: MAX_TEXT_BYTES,
            observed: ObservedBytes::Exact(MAX_TEXT_BYTES + 1),
        })
    );
    assert!(
        read_relay_cursor(&engine, "ws")
            .expect("read cursor")
            .is_none()
    );
}

#[test]
fn exact_duplicate_is_noop_and_gap_is_rejected() {
    let (_scratch, _path, mut engine) = open_store();
    let op = envelope("peer", 0, "probe.apply", json!({"v":1}));
    assert_eq!(
        apply_envelope_with(&mut engine, &op, &NoFaults, insert_probe).expect("apply"),
        ApplyOutcome::new(ApplyDisposition::Applied(()))
    );
    assert_eq!(
        apply_envelope_with(&mut engine, &op, &NoFaults, insert_probe).expect("dedup"),
        ApplyOutcome::new(ApplyDisposition::Skipped)
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "peer").expect("ack"),
        0
    );
    let gap = envelope("peer", 2, "probe.apply", json!({}));
    assert!(matches!(
        apply_envelope_with(&mut engine, &gap, &NoFaults, insert_probe),
        Err(SyncError::SequenceGap)
    ));
}

#[test]
fn key_envelope_conflict_is_surfaced_without_rebasing_over_the_winner() {
    let client = RelaySyncClient::new(KeyConflictRelay::default());
    let request = KeyEnvelopeRequest {
        workspace_id: "ws".to_owned(),
        replication_epoch: "epoch".to_owned(),
        stream_identity: "stream".to_owned(),
        envelope_json: r#"{"stale":true}"#.to_owned(),
        if_match: Some("stale-etag".to_owned()),
    };
    assert_eq!(
        client.upload_key_envelope(request.clone()),
        Err(RelayError::Conflict)
    );
    assert_eq!(
        *client.transport().uploads.lock().expect("key uploads"),
        [request],
        "conflict rebasing sends the stale bytes a second time"
    );
    assert_eq!(
        *client.transport().downloads.lock().expect("key downloads"),
        0,
        "a strict CAS client must not fetch an ETag solely to overwrite its winner"
    );
}

#[test]
fn fresh_coordinate_does_not_canonicalize_payload_for_a_comparison_that_cannot_exist() {
    let (_scratch, _path, mut engine) = open_store();
    let incoming = envelope("canonical-peer", 0, "probe", json!({"z": 1, "a": [2, 3]}));
    let _ = crate::relay::take_canonical_json_call_count();
    assert!(matches!(
        apply_envelope_with(&mut engine, &incoming, &NoFaults, |_, _| Ok(())),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(()),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        crate::relay::take_canonical_json_call_count(),
        0,
        "eager canonicalization does unused work on every fresh coordinate"
    );
    assert!(matches!(
        apply_envelope_with(&mut engine, &incoming, &NoFaults, |_, _| Ok(())),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Skipped,
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        crate::relay::take_canonical_json_call_count(),
        2,
        "redelivery canonicalizes both the incoming and stored payload before comparing"
    );
}

#[test]
fn pull_repairs_legacy_null_base_coordinates_only_from_exact_relay_answers() {
    for (label, content_kind, below_floor, mismatch, expected) in [
        (
            "below-floor",
            dohc_engine_collab::ContentKind::Plaintext,
            true,
            false,
            (Some(7), 0_i64, 0_i64),
        ),
        (
            "scene-below-floor",
            dohc_engine_collab::ContentKind::Scene,
            true,
            false,
            (Some(7), 0_i64, 0_i64),
        ),
        (
            "below-floor-mismatch",
            dohc_engine_collab::ContentKind::Plaintext,
            true,
            true,
            (None, 0_i64, 1_i64),
        ),
        (
            "absent",
            dohc_engine_collab::ContentKind::Plaintext,
            false,
            false,
            (None, 1_i64, 0_i64),
        ),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        seed_identity(&mut engine);
        VersionedTextStore::new(&mut engine)
            .ensure_main_version("ws", "main", 1_000, &NoFaults)
            .expect("main version");
        let path = match content_kind {
            dohc_engine_collab::ContentKind::Scene => {
                format!("drawings/{label}.excalidraw")
            }
            _ => format!("notes/{label}.md"),
        };
        seed_text_head(
            &mut engine,
            &format!("object-{label}"),
            &path,
            "legacy base",
        );
        let key = dohc_engine_collab::DocKey::new("ws", "main", format!("object-{label}"))
            .expect("doc key");
        let doc = dohc_engine_collab::Ydoc::wire();
        match content_kind {
            dohc_engine_collab::ContentKind::Scene => {
                let portable = json!({
                    "type": "excalidraw",
                    "version": 2,
                    "source": "https://excalidraw.com",
                    "elements": [],
                    "appState": {},
                    "files": {},
                })
                .to_string();
                let imported = dohc_engine_collab::import_portable_scene(&portable)
                    .expect("import legacy scene");
                doc.apply(&imported.initial_update)
                    .expect("apply legacy scene");
            }
            _ => {
                doc.plaintext_insert(0, "legacy base");
            }
        }
        let base = doc.encode_full_state();
        let claim_id = match dohc_engine_collab::claim_base(
            &mut engine,
            &key,
            content_kind,
            &base,
            &NoFaults,
            1_100,
        )
        .expect("claim legacy base")
        {
            TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Claimed {
                base_snapshot_sha,
            }) => base_snapshot_sha,
            other => panic!("unexpected claim outcome: {other:?}"),
        };
        let payload = json!({
            "versionId": "main",
            "objectId": key.object_id,
            "path": path,
            "contentKind": content_kind.as_str(),
            "updateBlobSha256": &claim_id,
            "lineageClaimId": &claim_id,
            "isBaseState": true,
        });
        let response = if below_floor {
            let response_payload = if mismatch {
                let mut unrelated = payload.clone();
                unrelated["path"] = json!("notes/unrelated-clone.md");
                unrelated
            } else {
                payload.clone()
            };
            LogCoordinateResponse::PresentBelowEpochFloor(ReplicationEnvelope {
                relay_seq: Some(7),
                workspace_id: "ws".to_owned(),
                origin_id: "legacy-peer".to_owned(),
                origin_seq: 0,
                op_kind: "ydoc.update".to_owned(),
                payload: response_payload,
                recorded_at_ms: 1_100,
            })
        } else {
            LogCoordinateResponse::Absent
        };
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO replication_log (
                         workspace_id,origin_id,origin_seq,op_kind,payload_json,
                         recorded_at_ms,imported,apply_disposition
                     ) VALUES ('ws','legacy-peer',0,'ydoc.update',?1,1100,1,'applied')",
                    [payload.to_string()],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "INSERT INTO ydoc_base_relay_candidates (
                         workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq
                     ) VALUES ('ws','main',?1,?2,'legacy-peer',0)",
                    params![key.object_id, claim_id],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed repair candidate");
        let relay = PagedRelay::new([(
            0,
            PullResponse {
                ops: Vec::new(),
                next_cursor: 0,
                has_more: false,
            },
        )])
        .with_coordinate("legacy-peer", 0, response);
        let result = RelaySyncClient::new(relay).pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_200,
        );
        if mismatch {
            assert_eq!(
                result.expect_err("an unrelated below-floor op must not repair the local base"),
                RelayError::InvalidResponse,
            );
        } else {
            result.expect("repair legacy coordinate");
        }
        let repaired: (Option<i64>, i64, i64) = engine
            .read_with(|conn| {
                let marker = conn.query_row(
                    "SELECT base_relay_seq,base_relay_confirmed_absent
                       FROM ydoc_docs
                      WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                    [&key.object_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let candidates = conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_base_relay_candidates
                      WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                    [&key.object_id],
                    |row| row.get(0),
                )?;
                Ok::<_, rusqlite::Error>((marker.0, marker.1, candidates))
            })
            .expect("read repaired marker");
        assert_eq!(repaired, expected);
    }
}

#[test]
fn invalid_pull_page_leaves_legacy_base_repair_and_pull_state_unchanged() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    seed_text_head(
        &mut engine,
        "object-invalid-page",
        "notes/invalid-page.md",
        "legacy base",
    );
    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "object-invalid-page").expect("doc key");
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "legacy base");
    let base = doc.encode_full_state();
    let claim_id = match dohc_engine_collab::claim_base(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Plaintext,
        &base,
        &NoFaults,
        1_100,
    )
    .expect("claim legacy base")
    {
        TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Claimed { base_snapshot_sha }) => {
            base_snapshot_sha
        }
        other => panic!("unexpected claim outcome: {other:?}"),
    };
    let payload = json!({
        "versionId": "main",
        "objectId": key.object_id,
        "path": "notes/invalid-page.md",
        "contentKind": "plaintext",
        "updateBlobSha256": &claim_id,
        "lineageClaimId": &claim_id,
        "isBaseState": true,
    });
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_log (
                     workspace_id,origin_id,origin_seq,op_kind,payload_json,
                     recorded_at_ms,imported,apply_disposition
                 ) VALUES ('ws','legacy-peer',0,'ydoc.update',?1,1100,1,'applied')",
                [payload.to_string()],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_base_relay_candidates (
                     workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq
                 ) VALUES ('ws','main',?1,?2,'legacy-peer',0)",
                params![key.object_id, claim_id],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_deferred_updates (
                     workspace_id,version_id,object_id,origin_id,origin_seq,
                     recorded_at_ms,lineage_claim_id,relay_seq
                 ) VALUES ('ws','main',?1,'deferred-peer',0,1150,?2,9)",
                params![key.object_id, claim_id],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed pending repair state");
    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![envelope(
                "page-peer",
                0,
                "chat.reaction.set",
                reaction_payload("added", "x", 20, "page-author"),
            )],
            next_cursor: 1,
            has_more: false,
        },
    )])
    .with_coordinate(
        "legacy-peer",
        0,
        LogCoordinateResponse::PresentBelowEpochFloor(ReplicationEnvelope {
            relay_seq: Some(7),
            workspace_id: "ws".to_owned(),
            origin_id: "legacy-peer".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            payload: payload.clone(),
            recorded_at_ms: 1_100,
        }),
    );
    relay.pages.get_mut(&0).expect("page").ops[0].relay_seq = Some(2);

    assert_eq!(
        RelaySyncClient::new(relay).pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_200,
        ),
        Err(RelayError::InvalidResponse)
    );
    let fingerprint = engine
        .read_with(|conn| {
            let marker = conn.query_row(
                "SELECT base_relay_seq,base_relay_confirmed_absent
                   FROM ydoc_docs
                  WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [&key.object_id],
                |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, i64>(1)?)),
            )?;
            let candidates = conn.query_row(
                "SELECT COUNT(*) FROM ydoc_base_relay_candidates
                  WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [&key.object_id],
                |row| row.get::<_, i64>(0),
            )?;
            let deferred = conn.query_row(
                "SELECT COUNT(*) FROM ydoc_deferred_updates
                  WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [&key.object_id],
                |row| row.get::<_, i64>(0),
            )?;
            let cursors = conn.query_row(
                "SELECT COUNT(*) FROM sync_relay_cursors WHERE workspace_id='ws'",
                [],
                |row| row.get::<_, i64>(0),
            )?;
            Ok::<_, rusqlite::Error>((marker.0, marker.1, candidates, deferred, cursors))
        })
        .expect("state fingerprint");
    assert_eq!(
        fingerprint,
        (None, 0, 1, 1, 0),
        "a malformed page must fail before repair, deferred apply, or cursor mutation"
    );
}

#[test]
fn local_unpushed_absence_stays_pending_until_push_makes_the_coordinate_present() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    seed_text_head(
        &mut engine,
        "object-local-pending",
        "notes/local-pending.md",
        "local base",
    );
    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "object-local-pending").expect("doc key");
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "local base");
    let base = doc.encode_full_state();
    let claim_id = match dohc_engine_collab::claim_base(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Plaintext,
        &base,
        &NoFaults,
        1_100,
    )
    .expect("claim local base")
    {
        TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Claimed { base_snapshot_sha }) => {
            base_snapshot_sha
        }
        other => panic!("unexpected claim outcome: {other:?}"),
    };
    let payload = json!({
        "versionId": "main",
        "objectId": key.object_id,
        "path": "notes/local-pending.md",
        "contentKind": "plaintext",
        "updateBlobSha256": &claim_id,
        "lineageClaimId": &claim_id,
        "isBaseState": true,
    });
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_log (
                     workspace_id,origin_id,origin_seq,op_kind,payload_json,
                     recorded_at_ms,imported,apply_disposition
                 ) VALUES ('ws','local',1,'ydoc.update',?1,1100,0,'applied')",
                [payload.to_string()],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_base_relay_candidates (
                     workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq
                 ) VALUES ('ws','main',?1,?2,'local',1)",
                params![key.object_id, claim_id],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed local pending coordinate");
    let relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: Vec::new(),
            next_cursor: 0,
            has_more: false,
        },
    )])
    .with_coordinate("local", 1, LogCoordinateResponse::Absent);
    let client = RelaySyncClient::new(relay);

    client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_200,
        )
        .expect("pull before push");
    let pending = engine
        .read_with(|conn| {
            let marker = conn.query_row(
                "SELECT base_relay_seq,base_relay_confirmed_absent
                   FROM ydoc_docs
                  WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [&key.object_id],
                |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, i64>(1)?)),
            )?;
            let candidates = conn.query_row(
                "SELECT COUNT(*) FROM ydoc_base_relay_candidates
                  WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [&key.object_id],
                |row| row.get::<_, i64>(0),
            )?;
            Ok::<_, rusqlite::Error>((marker.0, marker.1, candidates))
        })
        .expect("pending marker");
    assert_eq!(pending, (None, 0, 1));

    client
        .push_workspace(&mut engine, "ws", &NoFaults, &crate::NoLiveLeases, 1_300, 0)
        .expect("push local coordinate");
    client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_400,
        )
        .expect("repair after push");
    let repaired = engine
        .read_with(|conn| {
            let marker = conn.query_row(
                "SELECT base_relay_seq,base_relay_confirmed_absent
                   FROM ydoc_docs
                  WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [&key.object_id],
                |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, i64>(1)?)),
            )?;
            let candidates = conn.query_row(
                "SELECT COUNT(*) FROM ydoc_base_relay_candidates
                  WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [&key.object_id],
                |row| row.get::<_, i64>(0),
            )?;
            Ok::<_, rusqlite::Error>((marker.0, marker.1, candidates))
        })
        .expect("repaired marker");
    assert_eq!(repaired, (Some(101), 0, 0));
}

#[test]
fn relay_pull_recovers_only_a_diverged_local_origin() {
    for (origin_id, expected) in [
        ("local", RelayError::OriginDiverged),
        ("peer", RelayError::InvalidResponse),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        seed_identity(&mut engine);
        if origin_id == "peer" {
            engine
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "INSERT INTO replication_log \
                         (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                         VALUES ('ws','peer',0,'probe.peer','{}',1000,1)",
                        [],
                    )
                    .map_err(SyncError::persist)?;
                    Ok::<_, SyncError>(())
                })
                .expect("seed imported coordinate");
        }
        let client = RelaySyncClient::new(FakeRelay {
            pushes: Mutex::new(Vec::new()),
            pull: Mutex::new(Some(PullResponse {
                ops: vec![envelope(
                    origin_id,
                    0,
                    if origin_id == "local" {
                        "probe.local"
                    } else {
                        "probe.peer"
                    },
                    json!({"changed": true}),
                )],
                next_cursor: 1,
                has_more: false,
            })),
        });

        assert_eq!(
            client.pull_chat_workspace(
                &mut engine,
                &mut dohc_engine_collab::WriterDocCache::new(),
                "ws",
                &NoFaults,
                &NoLiveLeases,
                1_000
            ),
            Err(expected),
            "{origin_id}"
        );
    }
}

#[test]
fn fault_sync_after_push_before_cursor_persist_repushes_without_local_double_advance() {
    let (_scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(FakeRelay::default());
    let faults = ScriptedFaults::crash_at(FaultPoint::SyncAfterPushBeforeCursorPersist);
    assert_eq!(
        client
            .push_workspace(
                &mut engine,
                "ws",
                faults.as_ref(),
                &crate::NoLiveLeases,
                1_000,
                0
            )
            .expect("push fault"),
        SyncPassOutcome::CrashedAfterRemoteCommit
    );
    drop(engine);
    let mut reopened = EngineStore::open(&path, 2_000).expect("reopen");
    assert_eq!(
        read_pushed_seq(&reopened, "ws", "local").expect("cursor"),
        -1
    );
    client
        .push_workspace(
            &mut reopened,
            "ws",
            &NoFaults,
            &crate::NoLiveLeases,
            1_000,
            0,
        )
        .expect("retry push");
    assert_eq!(
        read_pushed_seq(&reopened, "ws", "local").expect("cursor"),
        0
    );
    assert_eq!(client.transport().pushes.lock().expect("calls").len(), 2);
}

#[test]
fn journal_rejects_payloads_above_the_relay_contract() {
    let (_scratch, _path, mut engine) = open_store();
    let overhead = br#"{"data":""}"#.len();
    let exact = json!({"data": "x".repeat(MAX_PAYLOAD_JSON_BYTES - overhead)});
    assert_eq!(
        serde_json::to_vec(&exact).expect("exact payload").len(),
        MAX_PAYLOAD_JSON_BYTES,
        "restoring the former 10 MiB journal limit accepts `oversized`.",
    );
    assert_eq!(
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "probe.local",
            &exact,
            1_000,
            &NoFaults,
        )
        .expect("exact-limit payload"),
        TxnOutcome::Committed(0)
    );

    let oversized = json!({"data": "x".repeat(MAX_PAYLOAD_JSON_BYTES - overhead + 1)});
    assert!(matches!(
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "probe.local",
            &oversized,
            1_001,
            &NoFaults,
        ),
        Err(SyncError::InvalidInput {
            reason: "payload exceeds the relay limit"
        })
    ));
}

#[test]
fn canonical_json_matches_javascript_number_boundaries() {
    let cases = [
        (json!(1e21), "1e+21"),
        (json!(1e-6), "0.000001"),
        (json!(1e-7), "1e-7"),
        (json!(-0.0), "0"),
        (
            serde_json::from_str("9007199254740993").expect("integer above 2^53"),
            "9007199254740992",
        ),
    ];
    for (value, expected) in cases {
        assert_eq!(
            crate::relay::canonical_json_bytes(&value).expect("canonical number"),
            expected.as_bytes(),
            "JavaScript stableJsonStringify parity for {value}"
        );
    }
}

#[test]
fn fault_sync_between_apply_and_cursor_commit_refetches_and_dedups() {
    let (_scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    let remote = envelope(
        "peer",
        0,
        "chat.reaction.set",
        json!({"reactionId":"r","messageId":"m","threadId":"t","emoji":"👍","authorId":"u","authorKind":"human","authorDisplayName":"U","atMs":10,"state":"added"}),
    );
    let fake = FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![remote],
            next_cursor: 1,
            has_more: false,
        })),
    };
    let client = RelaySyncClient::new(fake);
    let faults = ScriptedFaults::crash_at(FaultPoint::SyncBetweenApplyAndCursorCommit);
    let first = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            faults.as_ref(),
            &NoLiveLeases,
            1_000,
        )
        .expect("pull fault");
    assert!(matches!(
        first,
        SyncPassOutcome::CrashedAfterApply { applied: 1, .. }
    ));
    drop(engine);
    let mut reopened = EngineStore::open(&path, 2_000).expect("reopen");
    assert!(
        read_relay_cursor(&reopened, "ws")
            .expect("cursor")
            .is_none()
    );
    let retry = client
        .pull_chat_workspace(
            &mut reopened,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("retry pull");
    let pending = match retry {
        SyncPassOutcome::Complete {
            applied: 0,
            skipped: 1,
            pending_cursor: Some(cursor),
            ..
        } => cursor,
        other => panic!("unexpected retry outcome: {other:?}"),
    };
    assert_eq!(
        client
            .commit_pull_cursor(
                &mut reopened,
                "ws",
                &pending,
                &NoFaults,
                &crate::NoLiveLeases,
                1_000
            )
            .expect("commit"),
        TxnOutcome::Committed(Vec::new())
    );
}

#[test]
fn retained_scene_lineage_does_not_wedge_a_later_peer_delete() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let object_id = "retained-scene";
    let path = "drawings/retained.excalidraw";
    let imported = dohc_engine_collab::import_portable_scene(
        &json!({
            "type": "excalidraw",
            "version": 2,
            "source": "https://excalidraw.com",
            "elements": [],
            "appState": {},
            "files": {}
        })
        .to_string(),
    )
    .expect("import scene");
    let base_sha = engine
        .put_binary_blob(&imported.initial_update)
        .expect("store scene base");
    let base = envelope(
        "scene-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "path": path,
            "contentKind": "scene",
            "updateBlobSha256": base_sha,
            "lineageClaimId": base_sha,
            "isBaseState": true
        }),
    );
    let base_outcome = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    );
    assert!(
        matches!(
            base_outcome,
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(_),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ),
        "unexpected scene base outcome: {base_outcome:?}"
    );
    let (scene_sha, updated_at_ms, latest_moment_id): (String, i64, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT blob_sha256,updated_at_ms,latest_moment_id \
                 FROM snapshots WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [object_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("scene head");

    let delete_payload = |moment_id: &str| {
        json!({
            "momentId": moment_id,
            "versionId": "main",
            "objectId": object_id,
            "objectCreatedAtMs": 2_000,
            "path": path,
            "recordedAtMs": 3_100,
            "operation": "delete",
            "payloadBeforeBlobSha256": scene_sha,
            "payloadBeforePath": path,
            "payloadBeforeContentKind": "text",
            "payloadAfterBlobSha256": scene_sha,
            "payloadAfterPath": path,
            "payloadAfterContentKind": "text",
            "metadata": {"origin": "sync"},
            "beforePresent": "present",
            "beforeObjectId": object_id,
            "beforeVersionId": "main",
            "beforePath": path,
            "beforeBlobSha256": scene_sha,
            "beforeContentKind": "text",
            "beforeUpdatedAtMs": updated_at_ms,
            "beforeLatestMomentId": latest_moment_id,
            "beforeMetadata": {"origin": "sync"}
        })
    };
    let first_delete = envelope(
        "first-scene-delete-peer",
        0,
        "moment.append",
        delete_payload("first-scene-delete"),
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &first_delete,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let key = dohc_engine_collab::DocKey::new("ws", "main", object_id).expect("scene key");
    assert!(
        dohc_engine_collab::read_marker(&engine, &key)
            .expect("read retained marker")
            .is_some(),
        "scene rollback and asset authority require the deleted lineage"
    );

    let peer_delete = envelope(
        "scene-delete-peer",
        0,
        "moment.append",
        delete_payload("peer-scene-delete"),
    );
    let later = envelope("scene-delete-peer", 1, "workspace.init", json!({}));
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![peer_delete, later],
            next_cursor: 2,
            has_more: false,
        })),
    });

    let first = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            3_200,
        )
        .expect("retained scene delete must not wedge the relay");
    let first_cursor = match first {
        SyncPassOutcome::Complete {
            applied: 2,
            skipped: 0,
            pending_cursor: Some(cursor),
            ..
        } => cursor,
        other => panic!("unexpected first pull: {other:?}"),
    };
    assert_eq!(first_cursor.cursor, 2);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "scene-delete-peer").expect("peer ack"),
        1,
        "the operation after the peer delete must apply"
    );

    let replay = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            3_300,
        )
        .expect("cursor-crash replay must dedupe");
    let replay_cursor = match replay {
        SyncPassOutcome::Complete {
            applied: 0,
            skipped: 2,
            pending_cursor: Some(cursor),
            ..
        } => cursor,
        other => panic!("unexpected replay pull: {other:?}"),
    };
    assert_eq!(replay_cursor.cursor, 2);
    client
        .commit_pull_cursor(
            &mut engine,
            "ws",
            &replay_cursor,
            &NoFaults,
            &crate::NoLiveLeases,
            3_400,
        )
        .expect("commit replay cursor");
    assert_eq!(
        read_relay_cursor(&engine, "ws")
            .expect("read relay cursor")
            .map(|cursor| cursor.cursor),
        Some(2)
    );
    assert!(
        dohc_engine_collab::read_marker(&engine, &key)
            .expect("read retained marker after peer delete")
            .is_some(),
        "peer-delete progress must not discard scene rollback state"
    );
}

#[derive(Debug, Clone, Copy)]
enum RelayFaultKind {
    Duplicate,
    Reorder,
    Drop,
    Partition,
    RestartMidPull,
}

#[test]
fn seeded_relay_fault_model_converges_without_double_apply() {
    let faults = [
        RelayFaultKind::Duplicate,
        RelayFaultKind::Reorder,
        RelayFaultKind::Drop,
        RelayFaultKind::Partition,
        RelayFaultKind::RestartMidPull,
    ];
    assert_eq!(faults.len(), 5);
    let ops = vec![
        envelope(
            "origin-a",
            0,
            "chat.reaction.set",
            json!({"reactionId":"r","messageId":"m","threadId":"t","emoji":"👍","authorId":"u","authorKind":"human","authorDisplayName":"U","atMs":10,"state":"added"}),
        ),
        envelope(
            "origin-b",
            0,
            "chat.reaction.set",
            json!({"reactionId":"r","messageId":"m","threadId":"t","emoji":"👍","authorId":"u","authorKind":"human","authorDisplayName":"U","atMs":20,"state":"removed"}),
        ),
        envelope(
            "origin-c",
            0,
            "chat.reaction.set",
            json!({"reactionId":"r","messageId":"m","threadId":"t","emoji":"👍","authorId":"u","authorKind":"human","authorDisplayName":"U","atMs":15,"state":"added"}),
        ),
    ];

    let (scratch_a, path_a, mut a) = open_store();
    let (_scratch_b, _path_b, mut b) = open_store();
    let (_scratch_c, _path_c, mut c) = open_store();

    // Seed 0xR10's deterministic schedule: reordered delivery, a dropped
    // packet, a partitioned peer, a duplicate, and a restart after a prefix.
    for op in ops.iter().rev() {
        apply_chat_envelope(&mut a, op, &NoFaults).expect("a reordered");
    }
    apply_chat_envelope(&mut a, &ops[1], &NoFaults).expect("a duplicate");

    apply_chat_envelope(&mut b, &ops[0], &NoFaults).expect("b prefix");
    drop(b);
    let mut b = EngineStore::open(&_path_b, 3_000).expect("b restart mid pull");
    apply_chat_envelope(&mut b, &ops[2], &NoFaults).expect("b after dropped middle");

    // c is partitioned during the first pass and receives nothing.
    assert_eq!(
        read_replication_acked_seq(&c, "ws", "origin-a").expect("partition ack"),
        -1
    );

    // Healing pass: every instance receives the complete relay log. Exact
    // duplicates are skipped; missing coordinates apply once.
    for engine in [&mut a, &mut b, &mut c] {
        for op in &ops {
            apply_chat_envelope(engine, op, &NoFaults).expect("healed delivery");
        }
    }

    let normalized = |engine: &EngineStore| {
        engine
            .read_with(|conn| {
                let cell = conn.query_row(
                    "SELECT state,at_ms,origin_id,origin_seq FROM chat_reactions WHERE workspace_id='ws'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)),
                )?;
                let log_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws'",
                    [],
                    |row| row.get(0),
                )?;
                Ok::<_, rusqlite::Error>((cell, log_count))
            })
            .expect("normalized")
    };
    let expected = normalized(&a);
    assert_eq!(expected, normalized(&b));
    assert_eq!(expected, normalized(&c));
    assert_eq!(expected.0.0, "removed");
    assert_eq!(expected.1, 3, "duplicates never append a second coordinate");

    drop(a);
    let reopened = EngineStore::open(&path_a, 4_000).expect("a durable reopen");
    assert_eq!(expected, normalized(&reopened));
    drop(reopened);
    drop(scratch_a);
}

// ----------------------------------------------------------------------------
// Regression coverage for the Codex-bot review findings triaged in round 2.

/// #6 (apply dedup ordering): a redelivered coordinate at or below the ack with
/// a divergent payload must fail closed (never silently skip, never mutate).
#[test]
fn redelivered_divergent_coordinate_at_acked_seq_is_rejected() {
    let (_scratch, _path, mut engine) = open_store();
    let first = envelope(
        "peer",
        0,
        "chat.channel.create",
        json!({"channelId":"c1","name":"First","slug":"first","kind":"channel","createdAtMs":1}),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &first, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    // Same coordinate (origin peer, seq 0), different payload — a tamper/replay.
    let divergent = envelope(
        "peer",
        0,
        "chat.channel.create",
        json!({"channelId":"c1","name":"Tampered","slug":"first","kind":"channel","createdAtMs":1}),
    );
    assert!(matches!(
        apply_chat_envelope(&mut engine, &divergent, &NoFaults),
        Err(SyncError::CoordinateDiverged)
    ));
    // The original row is untouched — no partial mutation from the replay.
    let name: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT name FROM chat_channels WHERE workspace_id='ws' AND channel_id='c1'",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("channel name");
    assert_eq!(name, "First");
    // An exact redelivery is still an idempotent skip (not a divergence).
    assert!(matches!(
        apply_chat_envelope(&mut engine, &first, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Skipped,
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
}

/// #2 (relay pull workspace gating): a pulled op targeting a foreign workspace
/// must be rejected before apply, and the fetch cursor must not advance.
#[test]
fn pull_rejects_op_for_foreign_workspace() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let foreign = ReplicationEnvelope {
        workspace_id: "other".to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "chat.channel.create".to_owned(),
        payload: json!({"channelId":"c1","name":"X","slug":"x","kind":"channel","createdAtMs":1}),
        recorded_at_ms: 2_000,
        relay_seq: Some(0),
    };
    let fake = FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![foreign],
            next_cursor: 1,
            has_more: false,
        })),
    };
    let client = RelaySyncClient::new(fake);
    assert!(matches!(
        client.pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000
        ),
        Err(RelayError::InvalidResponse)
    ));
    // Fail closed: the cursor was never persisted, so the pass is retryable.
    assert!(read_relay_cursor(&engine, "ws").expect("cursor").is_none());
}

#[test]
fn relay_pull_reports_applied_and_redelivered_ydoc_materialization_paths() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    dohc_engine_domain::VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws','object-relay-path',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("scaffolding");

    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "remote projection");
    let bytes = doc.encode_full_state();
    let sha256 = dohc_engine_storage::hex_sha256(&bytes);
    let op = envelope(
        "ydoc-path-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-relay-path",
            "path": "notes/relay-path.md",
            "contentKind": "plaintext",
            "updateBlobSha256": sha256.clone(),
            "lineageClaimId": sha256.clone(),
            "isBaseState": true
        }),
    );
    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![op],
            next_cursor: 1,
            has_more: false,
        },
    )]);
    relay.blobs.insert(sha256, bytes);
    let client = RelaySyncClient::new(relay);

    for (expected_applied, expected_skipped) in [(1, 0), (0, 1)] {
        let outcome = client
            .pull_chat_workspace(
                &mut engine,
                &mut dohc_engine_collab::WriterDocCache::new(),
                "ws",
                &NoFaults,
                &NoLiveLeases,
                1_000,
            )
            .expect("pull ydoc projection");
        let SyncPassOutcome::Complete {
            applied,
            skipped,
            changed_paths,
            ..
        } = outcome
        else {
            panic!("ydoc pull must complete: {outcome:?}");
        };
        assert_eq!((applied, skipped), (expected_applied, expected_skipped));
        assert_eq!(
            changed_paths,
            [MomentMaterializationChange {
                version_id: "main".to_owned(),
                path: "notes/relay-path.md".to_owned(),
                operation: "write",
                content_kind: "text",
            }],
            "dropping non-moment durable-intent reconstruction loses the owed path"
        );
    }
}

#[test]
fn central_router_recognizes_owned_kinds_and_refuses_unknown_kinds_forward_compatibly() {
    for kind in crate::router::owned_op_kinds() {
        let (_scratch, _path, mut engine) = open_store();
        let operation = envelope("router-peer", 0, kind, json!({}));
        assert!(
            !matches!(
                apply_replication_envelope(
                    &mut engine,
                    &mut dohc_engine_collab::WriterDocCache::new(),
                    &operation,
                    &NoFaults,
                    &NoLiveLeases
                ),
                Err(SyncError::UnsupportedOperation)
            ),
            "{kind} fell through the router"
        );
    }

    let (_scratch, _path, mut engine) = open_store();
    let workspace = envelope("router-workspace", 0, "workspace.init", json!({}));
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &workspace,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    // moment.append is no longer the not-implemented stub: it routes to the real
    // applier, so a malformed payload is rejected by that applier rather than by
    // the router.
    let moment = envelope("router-moment", 0, "moment.append", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &moment, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { ref reason },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "moment.append payload is malformed")
    ));
    let unknown = envelope("router-unknown", 0, "version.rename", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &unknown, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { ref reason },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "operation kind is not supported by this client")
    ));
    let next = envelope(
        "router-unknown",
        1,
        "chat.channel.create",
        json!({
            "channelId": "after-newer-op",
            "name": "After newer op",
            "slug": "after-newer-op",
            "kind": "channel",
            "createdAtMs": 2_001
        }),
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &next,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "router-unknown")
            .expect("forward-compatible ack"),
        1,
        "returning UnsupportedOperation hard-wedges an older client on a newer peer op"
    );
}
#[test]
fn relay_pull_operation_ceiling_returns_a_resumable_completed_page() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let first_page = (0..crate::model::MAX_PULL_OPS_PER_PASS)
        .map(|seq| {
            envelope(
                "bounded-pull-peer",
                i64::try_from(seq).expect("sequence"),
                "chat.reaction.set",
                reaction_payload(
                    "added",
                    "🧱",
                    i64::try_from(seq).expect("timestamp"),
                    &format!("bounded-{seq}"),
                ),
            )
        })
        .collect::<Vec<_>>();
    let second_page = envelope(
        "bounded-pull-second-peer",
        0,
        "chat.reaction.set",
        reaction_payload("added", "▶️", 1_000, "bounded-second"),
    );
    let client = RelaySyncClient::new(PagedRelay::new([
        (
            0,
            PullResponse {
                ops: first_page,
                next_cursor: i64::try_from(crate::model::MAX_PULL_OPS_PER_PASS).expect("cursor"),
                has_more: true,
            },
        ),
        (
            i64::try_from(crate::model::MAX_PULL_OPS_PER_PASS).expect("cursor"),
            PullResponse {
                ops: vec![second_page],
                next_cursor: i64::try_from(crate::model::MAX_PULL_OPS_PER_PASS + 1)
                    .expect("cursor"),
                has_more: false,
            },
        ),
    ]));

    let first = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("bounded first pass");
    let SyncPassOutcome::Complete {
        fetched,
        has_more,
        pending_cursor: Some(pending),
        ..
    } = first
    else {
        panic!("first pass must return its completed-page cursor: {first:?}");
    };
    assert_eq!(fetched, crate::model::MAX_PULL_OPS_PER_PASS);
    assert!(
        has_more,
        "the operation ceiling must explicitly report that the relay is not drained"
    );
    assert_eq!(
        pending.cursor,
        i64::try_from(crate::model::MAX_PULL_OPS_PER_PASS).expect("cursor")
    );
    assert_eq!(
        *client.transport().pulls.lock().expect("pull calls"),
        [(0, crate::model::MAX_PULL_OPS_PER_PASS)]
    );
    client
        .commit_pull_cursor(
            &mut engine,
            "ws",
            &pending,
            &NoFaults,
            &crate::NoLiveLeases,
            1_000,
        )
        .expect("commit bounded prefix");

    let second = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("resume after bounded prefix");
    assert!(matches!(
        second,
        SyncPassOutcome::Complete {
            fetched: 1,
            applied: 1,
            ..
        }
    ));
}

#[test]
fn join_pull_recovers_offline_edits_after_the_operation_limit() {
    assert_join_pull_recovers_offline_edits(false, false);
}

#[test]
fn join_pull_recovers_offline_edits_after_the_page_limit() {
    assert_join_pull_recovers_offline_edits(true, false);
}

#[test]
fn join_pull_journals_received_document_edits_without_originating_offline_bases() {
    assert_join_pull_recovers_offline_edits(false, true);
}

fn assert_join_pull_recovers_offline_edits(sparse: bool, edit_between_batches: bool) {
    let (_scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    seed_text_head(&mut engine, "joining-doc", "joining.md", "offline edit");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "joining-doc").expect("key");
    let offline = dohc_engine_collab::Ydoc::wire();
    let update = offline.plaintext_insert(0, "offline edit");
    dohc_engine_collab::record_local_update(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &update,
        dohc_engine_collab::LocalAppend {
            marker: Some(dohc_engine_collab::MarkerCreation {
                path: Some("joining.md"),
                content_kind: dohc_engine_collab::ContentKind::Plaintext,
                regime: dohc_engine_collab::Regime::LocalOnly,
            }),
            ..Default::default()
        },
        &NoFaults,
        1_100,
        |_, _, _| Ok(()),
    )
    .expect("offline edit");

    let remote = dohc_engine_collab::Ydoc::wire();
    remote.plaintext_insert(0, "remote edit");
    let remote_bytes = remote.encode_full_state();
    let remote_sha = dohc_engine_storage::hex_sha256(&remote_bytes);
    if edit_between_batches {
        seed_text_head(&mut engine, "early-doc", "early.md", "remote edit");
    }
    let limit = if sparse {
        crate::model::MAX_PULL_PAGES_PER_PASS
    } else {
        crate::model::MAX_PULL_OPS_PER_PASS
    };
    let boundary = i64::try_from(limit).expect("boundary");
    let padding = |seq| envelope("padding-peer", seq, "probe.padding", json!({}));
    let mut pages = if sparse {
        (0..boundary)
            .map(|seq| {
                (
                    seq,
                    PullResponse {
                        ops: vec![padding(seq)],
                        next_cursor: seq + 1,
                        has_more: true,
                    },
                )
            })
            .collect::<Vec<_>>()
    } else {
        vec![(
            0,
            PullResponse {
                ops: (0..boundary).map(padding).collect(),
                next_cursor: boundary,
                has_more: true,
            },
        )]
    };
    if edit_between_batches {
        *pages[0].1.ops.last_mut().expect("first batch") = envelope(
            "early-peer",
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": "early-doc",
                "path": "early.md",
                "contentKind": "plaintext",
                "updateBlobSha256": remote_sha,
                "lineageClaimId": remote_sha,
                "isBaseState": true,
            }),
        );
    }
    pages.push((
        boundary,
        PullResponse {
            ops: vec![envelope(
                "document-peer",
                0,
                "ydoc.update",
                json!({
                    "versionId": "main",
                    "objectId": "joining-doc",
                    "path": "joining.md",
                    "contentKind": "plaintext",
                    "updateBlobSha256": remote_sha,
                    "lineageClaimId": remote_sha,
                    "isBaseState": true,
                }),
            )],
            next_cursor: boundary + 1,
            has_more: false,
        },
    ));
    let mut relay =
        PagedRelay::new(pages).with_coordinate("local", 1, LogCoordinateResponse::Absent);
    relay.blobs.insert(remote_sha.clone(), remote_bytes);
    let client = RelaySyncClient::new(relay);
    let first = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_200,
        )
        .expect("first pass");
    let SyncPassOutcome::Complete {
        has_more: true,
        pending_cursor: Some(cursor),
        ..
    } = first
    else {
        panic!("first pass must stop before the remote base: {first:?}");
    };
    assert!(!cursor.bootstrap_complete);
    client
        .commit_pull_cursor(
            &mut engine,
            "ws",
            &cursor,
            &NoFaults,
            &crate::NoLiveLeases,
            1_201,
        )
        .expect("commit first batch");
    assert_eq!(
        engine
            .write_with(&NoFaults, |tx| {
                originate_ydoc_base_in_tx(tx, &key, "joining.md", None, None, 1_202)
            })
            .expect("edit-time origination remains disabled"),
        TxnOutcome::Committed(BaseOrigination::NothingToDo)
    );
    drop(engine);
    let mut engine = EngineStore::open(&path, 1_202).expect("resume bootstrap after restart");
    if edit_between_batches {
        engine
            .write_with(&NoFaults, |tx| {
                crate::ydoc_apply::reconcile_local_resulting_head_in_tx(
                    tx,
                    "ws",
                    "main",
                    "early-doc",
                    crate::ydoc_apply::ResultingHead::Text {
                        path: "early.md",
                        text: "edited during join",
                    },
                    None,
                    None,
                    1_203,
                )
            })
            .expect("edit received document during bootstrap");
        assert!(
            list_replication_ops(&engine, "ws", "local", -1, 500)
                .expect("local journal")
                .iter()
                .any(|op| op.op_kind == "ydoc.update"
                    && op.payload["objectId"] == "early-doc"
                    && op.payload["isBaseState"] == false),
            "the edit must be journaled before the join finishes"
        );
        client
            .push_workspace(
                &mut engine,
                "ws",
                &NoFaults,
                &crate::NoLiveLeases,
                1_204,
                100_000_000,
            )
            .expect("a resumed push-first pass can publish the edit");
        assert!(
            !dohc_engine_collab::read_marker(&engine, &key)
                .expect("offline marker")
                .expect("present")
                .lineage_claim_status
                .has_claimed_base(),
            "a local push during bootstrap must not originate offline bases"
        );
    }
    let second = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_300,
        )
        .expect("later remote base must finish without a push or retry loop");
    let SyncPassOutcome::Complete {
        has_more: false,
        pending_cursor: Some(cursor),
        refused: 0,
        ..
    } = second
    else {
        panic!("join must finish: {second:?}");
    };
    assert!(cursor.bootstrap_complete);
    client
        .commit_pull_cursor(
            &mut engine,
            "ws",
            &cursor,
            &NoFaults,
            &crate::NoLiveLeases,
            1_301,
        )
        .expect("finish bootstrap");
    client
        .commit_pull_cursor(
            &mut engine,
            "ws",
            &RelayCursor {
                cursor: cursor.cursor + 1,
                bootstrap_complete: false,
                ..cursor
            },
            &NoFaults,
            &crate::NoLiveLeases,
            1_302,
        )
        .expect("later partial batches retain enrollment");
    assert!(
        read_relay_cursor(&engine, "ws")
            .expect("cursor")
            .expect("present")
            .bootstrap_complete
    );
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load document")
        .expect("document");
    assert_eq!(persisted.doc.plaintext_string(), "remote edit");
    assert_eq!(persisted.marker.lineage_claim_id, Some(remote_sha));
    let texts: Vec<(String, String)> = engine
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT s.path,b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
             WHERE s.workspace_id='ws' AND s.version_id='main' AND s.object_id!='early-doc' ORDER BY b.text",
            )?;
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("materialized content");
    assert_eq!(texts.len(), 2);
    assert!(texts[0].0.starts_with("joining (recovered "));
    assert!(texts[0].0.ends_with(".md"));
    assert_eq!(texts[0].1, "offline edit");
    assert_eq!(
        texts[1],
        ("joining.md".to_owned(), "remote edit".to_owned())
    );
}

#[test]
fn relay_pull_page_ceiling_stops_an_advancing_sparse_stream() {
    assert_page_ceiling_retains_bootstrap_state(false);
}

#[test]
fn creator_partial_pull_keeps_local_base_origination_enabled() {
    assert_page_ceiling_retains_bootstrap_state(true);
}

fn assert_page_ceiling_retains_bootstrap_state(creator: bool) {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let mut pages = Vec::new();
    for cursor in 0..crate::model::MAX_PULL_PAGES_PER_PASS {
        let cursor = i64::try_from(cursor).expect("cursor");
        pages.push((
            cursor,
            PullResponse {
                ops: vec![envelope(
                    &format!("unrelated-{cursor}"),
                    0,
                    "opaque.test",
                    json!({}),
                )],
                next_cursor: cursor + 1,
                has_more: true,
            },
        ));
    }
    let resume_cursor =
        i64::try_from(crate::model::MAX_PULL_PAGES_PER_PASS).expect("resume cursor");
    pages.push((
        resume_cursor,
        PullResponse {
            ops: vec![envelope(
                &format!("unrelated-{resume_cursor}"),
                0,
                "opaque.test",
                json!({}),
            )],
            next_cursor: resume_cursor + 1,
            has_more: false,
        },
    ));
    let client = RelaySyncClient::new(PagedRelay::new(pages));

    if creator {
        client
            .push_workspace(
                &mut engine,
                "ws",
                &NoFaults,
                &crate::NoLiveLeases,
                999,
                100_000_000,
            )
            .expect("creator pushes before its first pull");
    }
    let first = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("page-bounded pull");
    let SyncPassOutcome::Complete {
        fetched,
        has_more,
        pending_cursor: Some(pending),
        ..
    } = first
    else {
        panic!("sparse page prefix must complete: {first:?}");
    };
    assert_eq!(fetched, crate::model::MAX_PULL_PAGES_PER_PASS);
    assert_eq!(pending.cursor, resume_cursor);
    assert_eq!(pending.bootstrap_complete, creator);
    client
        .commit_pull_cursor(
            &mut engine,
            "ws",
            &pending,
            &NoFaults,
            &crate::NoLiveLeases,
            1_001,
        )
        .expect("persist partial pull");
    assert_eq!(
        engine
            .read_with(|conn| crate::ydoc_origination::can_originate_local_bases_in_tx(conn, "ws"))
            .expect("base origination state"),
        creator
    );
    assert!(
        has_more,
        "the page ceiling must explicitly report that the relay is not drained"
    );
    assert_eq!(
        client.transport().pulls.lock().expect("pull calls").len(),
        crate::model::MAX_PULL_PAGES_PER_PASS
    );
}

#[test]
fn workspace_push_excludes_origins_imported_from_share_views() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_log \
                 (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                 VALUES ('ws','shared:share:peer',0,'moment.append','{}',2,1)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed imported share origin");
    let client = RelaySyncClient::new(FakeRelay::default());
    client
        .push_workspace(&mut engine, "ws", &NoFaults, &crate::NoLiveLeases, 1_000, 0)
        .expect("push owner lane");
    assert_eq!(
        client.transport().pushes.lock().expect("push calls").len(),
        1,
        "an unfiltered origin scan sends the imported share row through the owner lane"
    );
}

#[test]
fn enrollment_backfill_refreshes_the_origin_bound_before_the_next_push() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    VersionedTextStore::new(&mut engine)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "backfilled-object".to_owned(),
                path: "backfilled.md".to_owned(),
                text: "captured before enrollment".to_owned(),
                moment_id: "backfilled-moment".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2_000,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("captured moment");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE moments SET metadata_origin='capture' \
                 WHERE workspace_id='ws' AND moment_id='backfilled-moment'",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "UPDATE snapshots SET metadata_origin='capture' \
                 WHERE workspace_id='ws' AND version_id='main' \
                   AND object_id='backfilled-object'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("stamp autonomous capture origin");
    let client = RelaySyncClient::new(FakeRelay::default());

    let outcome =
        client.push_workspace(&mut engine, "ws", &NoFaults, &crate::NoLiveLeases, 1_000, 0);

    assert!(
        matches!(outcome, Ok(SyncPassOutcome::Complete { pushed: 2, .. })),
        "the same pass must push the pre-existing op and the newly backfilled moment: {outcome:?}"
    );
}

#[test]
fn pull_first_enrollment_does_not_echo_the_imported_moment_on_the_next_push() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let incoming = b"pulled before enrollment";
    let incoming_sha = dohc_engine_storage::hex_sha256(incoming);
    engine
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![
                    incoming_sha,
                    incoming.len() as i64,
                    String::from_utf8_lossy(incoming)
                ],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("hydrate the incoming blob");
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![envelope(
                "peer",
                0,
                "moment.append",
                json!({
                    "momentId": "peer-moment",
                    "versionId": "main",
                    "objectId": "pulled-object",
                    "objectCreatedAtMs": 1,
                    "path": "pulled.md",
                    "recordedAtMs": 1_000,
                    "operation": "write",
                    "payloadBeforeBlobSha256": null,
                    "payloadBeforePath": null,
                    "payloadAfterBlobSha256": incoming_sha,
                    "payloadAfterPath": "pulled.md",
                    "metadata": {"origin": "api"},
                    "beforePresent": "absent"
                }),
            )],
            next_cursor: 1,
            has_more: false,
        })),
    });

    let pull = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("first relay contact pulls the moment");
    let SyncPassOutcome::Complete {
        pending_cursor: Some(cursor),
        ..
    } = pull
    else {
        panic!("pull must return a pending cursor: {pull:?}");
    };
    client
        .commit_pull_cursor(
            &mut engine,
            "ws",
            &cursor,
            &NoFaults,
            &crate::NoLiveLeases,
            1_000,
        )
        .expect("the pull cursor ends enrollment");
    client
        .push_workspace(&mut engine, "ws", &NoFaults, &crate::NoLiveLeases, 1_000, 0)
        .expect("next push");

    let pushes = client.transport().pushes.lock().expect("pushes");
    assert!(
        pushes
            .iter()
            .flat_map(|request| &request.ops)
            .all(|op| op.op_kind != "moment.append" || op.origin_id != "local"),
        "the next push must not echo the imported moment under the local origin: {pushes:?}"
    );
}

#[test]
fn a_second_relay_position_does_not_repeat_enrollment_backfill() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let ciphertext = b"local secret content";
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO secret_moments \
                 (workspace_id,moment_order,moment_id,version_id,path,recorded_at_ms,operation, \
                  metadata_origin,after_present,after_iv_base64,after_auth_tag_base64, \
                  after_ciphertext_base64,after_byte_length) \
                 VALUES ('ws',1,'local-secret','main','.env',10,'write','api',1,?1,?2,?3,?4)",
                params![
                    STANDARD.encode([1_u8; 12]),
                    STANDARD.encode([2_u8; 16]),
                    STANDARD.encode(ciphertext),
                    ciphertext.len() as i64,
                ],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed local secret moment");

    assert!(matches!(
        crate::cursor::write_pushed_seq(&mut engine, "ws", "local", -1, &NoFaults, &crate::NoLiveLeases, 7_001),
        Ok(TxnOutcome::Committed(ref declines)) if declines.is_empty()
    ));
    let after_first: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )
        })
        .expect("first enrollment journal count");
    // `seed_identity` already journals one `probe.local` op (origin_seq 0) to
    // establish `sync_identity`; the local secret moment backfills as the
    // second row.
    assert_eq!(after_first, 2, "the local secret moment is backfilled once");

    assert!(matches!(
        crate::cursor::write_pushed_seq(&mut engine, "ws", "local", 0, &NoFaults, &crate::NoLiveLeases, 7_002),
        Ok(TxnOutcome::Committed(ref declines)) if declines.is_empty()
    ));
    let after_second: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )
        })
        .expect("second enrollment journal count");
    assert_eq!(
        after_second, after_first,
        "the was_enrolled latch must suppress every second-pass duplicate"
    );
    let source: (Option<String>, Option<i64>) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT source_origin_id,source_origin_seq FROM secret_moments \
                 WHERE workspace_id='ws' AND moment_id='local-secret'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("local secret provenance");
    assert_eq!(source, (None, None));
}

#[test]
fn invalid_blob_in_batch_stops_before_later_collection_order_hydration() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let mut ordered = [
        b"first batch blob".to_vec(),
        b"middle batch blob".to_vec(),
        b"last batch blob".to_vec(),
    ]
    .into_iter()
    .map(|bytes| (dohc_engine_storage::hex_sha256(&bytes), bytes))
    .collect::<Vec<_>>();
    ordered.sort_by(|left, right| left.0.cmp(&right.0));
    let snapshots = ordered
        .iter()
        .enumerate()
        .map(|(index, (sha256, _))| {
            shipped_text_snapshot(
                &format!("batch-invalid-object-{index}"),
                &format!("batch-invalid-{index}.md"),
                sha256,
            )
        })
        .collect();
    let op = version_create_with_shipped_snapshots(
        "batch-invalid-peer",
        "batch-invalid-version",
        snapshots,
    );
    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![op],
            next_cursor: 1,
            has_more: false,
        },
    )]);
    relay
        .blobs
        .insert(ordered[0].0.clone(), ordered[0].1.clone());
    relay.blobs.insert(
        ordered[1].0.clone(),
        b"wrong bytes for requested sha".to_vec(),
    );
    relay
        .blobs
        .insert(ordered[2].0.clone(), ordered[2].1.clone());
    let client = RelaySyncClient::new(relay);

    assert_eq!(
        client.pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000
        ),
        Err(RelayError::BlobInvalid)
    );
    let present = ordered
        .iter()
        .map(|(sha256, _)| {
            engine
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM blobs WHERE sha256=?1",
                        [sha256],
                        |row| row.get::<_, i64>(0),
                    )
                })
                .expect("blob presence")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        present,
        vec![1, 0, 0],
        "only the valid prefix before the earliest invalid response may hydrate"
    );
    let batches = client
        .transport()
        .download_batches
        .lock()
        .expect("blob download batches");
    assert_eq!(batches.len(), 1);
    assert_eq!(
        batches[0]
            .blobs
            .iter()
            .map(|blob| blob.sha256.as_str())
            .collect::<Vec<_>>(),
        ordered
            .iter()
            .map(|(sha256, _)| sha256.as_str())
            .collect::<Vec<_>>()
    );
    assert!(read_relay_cursor(&engine, "ws").expect("cursor").is_none());
}

#[test]
fn crashed_blob_batch_reconstructs_the_same_request_after_reopen() {
    let (_scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let blobs = [
        b"crash batch one".to_vec(),
        b"crash batch two".to_vec(),
        b"crash batch three".to_vec(),
    ];
    let snapshots = blobs
        .iter()
        .enumerate()
        .map(|(index, bytes)| {
            shipped_text_snapshot(
                &format!("crash-batch-object-{index}"),
                &format!("crash-batch-{index}.md"),
                &dohc_engine_storage::hex_sha256(bytes),
            )
        })
        .collect();
    let op =
        version_create_with_shipped_snapshots("crash-batch-peer", "crash-batch-version", snapshots);
    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![op],
            next_cursor: 1,
            has_more: false,
        },
    )]);
    for bytes in &blobs {
        relay
            .blobs
            .insert(dohc_engine_storage::hex_sha256(bytes), bytes.clone());
    }
    let client = RelaySyncClient::new(relay);
    let faults = ScriptedFaults::crash_at(FaultPoint::SyncBeforeBlobHydrateCommit);

    assert_eq!(
        client.pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            faults.as_ref(),
            &NoLiveLeases,
            1_000,
        ),
        Err(RelayError::Local("injected-crash".to_owned()))
    );
    drop(engine);
    let mut reopened = EngineStore::open(&path, 2_000).expect("reopen after hydration crash");
    assert!(matches!(
        client.pull_chat_workspace(
            &mut reopened,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            faults.as_ref(),
            &NoLiveLeases,
            2_000,
        ),
        Ok(SyncPassOutcome::Complete { .. })
    ));

    let batches = client
        .transport()
        .download_batches
        .lock()
        .expect("blob download batches");
    assert_eq!(batches.len(), 2);
    assert_eq!(
        batches[0], batches[1],
        "crash replay must reconstruct the same ordered sha and ceiling batch"
    );
    assert_eq!(batches[0].blobs.len(), blobs.len());
    drop(batches);
    for bytes in &blobs {
        let sha256 = dohc_engine_storage::hex_sha256(bytes);
        let present = reopened
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM blobs WHERE sha256=?1",
                    [&sha256],
                    |row| row.get::<_, i64>(0),
                )
            })
            .expect("replayed blob presence");
        assert_eq!(present, 1, "crash replay must hydrate every batch member");
    }
}

#[test]
fn relay_hydration_failure_mid_page_leaves_no_cursor_and_applies_nothing() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let normal = envelope(
        "hydrate-order-normal-peer",
        0,
        "chat.reaction.set",
        reaction_payload("added", "💧", 20, "hydrate-order-author"),
    );
    let missing_sha = dohc_engine_storage::hex_sha256(b"missing relay hydration");
    let missing = version_create_with_shipped_snapshots(
        "hydrate-order-missing-peer",
        "hydrate-order-version",
        vec![shipped_text_snapshot(
            "hydrate-order-object",
            "hydrate-order.md",
            &missing_sha,
        )],
    );
    let client = RelaySyncClient::new(PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![normal, missing],
            next_cursor: 2,
            has_more: false,
        },
    )]));

    assert_eq!(
        client.pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000
        ),
        Err(RelayError::BlobMissing)
    );
    assert!(
        read_relay_cursor(&engine, "ws")
            .expect("read cursor")
            .is_none()
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "hydrate-order-normal-peer").expect("normal ack"),
        -1,
        "hydration must complete before the first envelope applies"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "hydrate-order-missing-peer")
            .expect("missing ack"),
        -1
    );
}

#[test]
fn relay_hydrates_text_and_binary_rows_for_one_shared_digest() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    // A canonical empty Yjs update is also valid UTF-8, so the same digest is
    // legal in both the text and binary stores.
    let bytes = vec![0_u8, 0_u8];
    let sha256 = dohc_engine_storage::hex_sha256(&bytes);
    let text = version_create_with_shipped_snapshots(
        "a-dual-kind-text-peer",
        "dual-kind-version",
        vec![json!({
            "objectId": "dual-kind-object",
            "objectCreatedAtMs": 1_100,
            "path": "dual-kind.md",
            "blobSha256": sha256,
            "byteLength": bytes.len(),
            "updatedAtMs": 1_200,
            "latestMomentId": "dual-kind-moment",
            "metadata": {"origin": "sync"}
        })],
    );
    let binary = envelope(
        "z-dual-kind-binary-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "dual-kind-version",
            "objectId": "dual-kind-object",
            "path": "dual-kind.md",
            "contentKind": "plaintext",
            "updateBlobSha256": sha256.clone(),
            "lineageClaimId": sha256.clone(),
            "isBaseState": true
        }),
    );
    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![text, binary],
            next_cursor: 2,
            has_more: false,
        },
    )]);
    relay.blobs.insert(sha256.clone(), bytes);
    let client = RelaySyncClient::new(relay);

    let outcome = client.pull_chat_workspace(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        "ws",
        &NoFaults,
        &NoLiveLeases,
        1_000,
    );
    assert!(
        matches!(outcome, Ok(SyncPassOutcome::Complete { .. })),
        "dual-kind hydration pass must complete: {outcome:?}"
    );
    let rows = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM blobs WHERE sha256=?1",
                    [&sha256],
                    |row| row.get::<_, i64>(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM binary_blobs WHERE sha256=?1",
                    [&sha256],
                    |row| row.get::<_, i64>(0),
                )?,
            ))
        })
        .expect("dual-kind blob rows");
    assert_eq!(
        rows,
        (1, 1),
        "one digest referenced by both kinds must hydrate both physical stores"
    );
}

#[test]
fn pull_blob_existence_probe_does_not_read_and_rehash_present_content() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let text = "already local";
    let sha256 = dohc_engine_storage::hex_sha256(text.as_bytes());
    engine
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![sha256, text.len() as i64, text],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("seed local blob");
    let op = version_create_with_shipped_snapshots(
        "present-blob-peer",
        "present-blob-version",
        vec![shipped_text_snapshot(
            "present-blob-object",
            "present.md",
            &sha256,
        )],
    );
    let client = RelaySyncClient::new(PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![op],
            next_cursor: 1,
            has_more: false,
        },
    )]));
    let _ = crate::relay::take_local_blob_bytes_call_count();
    assert!(matches!(
        client.pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000
        ),
        Ok(SyncPassOutcome::Complete { .. })
    ));
    assert_eq!(
        crate::relay::take_local_blob_bytes_call_count(),
        0,
        "using the blob reader as an existence probe reads and hashes present content"
    );
    assert!(
        client
            .transport()
            .download_batches
            .lock()
            .expect("blob download batches")
            .is_empty(),
        "an all-present pull must not issue an empty or redundant download batch"
    );
}

#[test]
fn relay_multi_page_pull_reports_conflicts_opened() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let normal = envelope(
        "multi-page-before-conflict-peer",
        0,
        "chat.reaction.set",
        reaction_payload("added", "⚔️", 20, "conflict-author"),
    );
    let side = |path: &str| {
        json!({
            "exists": false,
            "path": path,
            "contentKind": "text"
        })
    };
    let conflict = envelope(
        "multi-page-conflict-peer",
        0,
        "conflict.open",
        json!({
            "id": "multi-page-open-conflict",
            "workspaceId": "ws",
            "path": "doc.md",
            "targetVersionId": "main",
            "sourceVersionId": "peer",
            "createdAtMs": 2_000,
            "updatedAtMs": 2_000,
            "base": side("doc.md"),
            "current": side("doc.md"),
            "incoming": side("doc.md"),
            "status": "open",
            "chosenFrom": "current",
            "metadata": {"origin": "sync"}
        }),
    );
    let client = RelaySyncClient::new(PagedRelay::new([
        (
            0,
            PullResponse {
                ops: vec![normal],
                next_cursor: 1,
                has_more: true,
            },
        ),
        (
            1,
            PullResponse {
                ops: vec![conflict],
                next_cursor: 2,
                has_more: false,
            },
        ),
    ]));

    let outcome = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("multi-page conflict pull");
    let SyncPassOutcome::Complete {
        fetched,
        applied,
        conflicts_opened,
        ..
    } = outcome
    else {
        panic!("multi-page conflict pull must complete: {outcome:?}");
    };
    assert_eq!((fetched, applied, conflicts_opened), (2, 2, 1));
}

#[test]
fn relay_pull_reports_conflicts_opened_by_a_divergent_moment_append() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let local_sha = dohc_engine_storage::hex_sha256(b"local");
    let base_sha = dohc_engine_storage::hex_sha256(b"base");
    let incoming_sha = dohc_engine_storage::hex_sha256(b"incoming");
    engine
        .read_with(|conn| {
            for (sha, text) in [
                (&local_sha, "local"),
                (&base_sha, "base"),
                (&incoming_sha, "incoming"),
            ] {
                conn.execute(
                    "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![sha, text.len() as i64, text],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .expect("hydrate moment blobs");
    let local = envelope(
        "local-moment-peer",
        0,
        "moment.append",
        json!({
            "momentId": "local-head",
            "versionId": "main",
            "objectId": "object",
            "objectCreatedAtMs": 1,
            "path": "doc.md",
            "recordedAtMs": 1_000,
            "operation": "write",
            "payloadBeforeBlobSha256": null,
            "payloadBeforePath": null,
            "payloadAfterBlobSha256": local_sha,
            "payloadAfterPath": "doc.md",
            "metadata": {"origin": "sync"},
            "beforePresent": "absent"
        }),
    );
    let divergent = envelope(
        "divergent-moment-peer",
        0,
        "moment.append",
        json!({
            "momentId": "incoming-head",
            "versionId": "main",
            "objectId": "object",
            "objectCreatedAtMs": 1,
            "path": "doc.md",
            "recordedAtMs": 2_000,
            "operation": "write",
            "payloadBeforeBlobSha256": base_sha,
            "payloadBeforePath": "doc.md",
            "payloadAfterBlobSha256": incoming_sha,
            "payloadAfterPath": "doc.md",
            "metadata": {"origin": "sync"},
            "beforePresent": "present",
            "beforeObjectId": "object",
            "beforeVersionId": "main",
            "beforePath": "doc.md",
            "beforeBlobSha256": base_sha,
            "beforeUpdatedAtMs": 500,
            "beforeLatestMomentId": "remote-base",
            "beforeMetadata": {"origin": "sync"}
        }),
    );
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![local, divergent],
            next_cursor: 2,
            has_more: false,
        })),
    });

    let outcome = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("pull");
    let SyncPassOutcome::Complete {
        applied,
        conflicts_opened,
        ..
    } = outcome
    else {
        panic!("pull must complete: {outcome:?}");
    };
    assert_eq!(applied, 2);
    assert_eq!(
        conflicts_opened, 1,
        "discarding the routed moment result hides the newly opened conflict"
    );
}

#[test]
fn persisted_relay_and_share_cursors_never_regress_within_the_same_stream() {
    let (_scratch, _path, mut engine) = open_store();
    let relay = |cursor| RelayCursor {
        bootstrap_complete: true,
        cursor,
        replication_epoch: "epoch".to_owned(),
        stream_identity: "stream".to_owned(),
        refusal_report_id: None,
        settlement_report_id: None,
    };
    assert!(matches!(
        commit_relay_cursor(&mut engine, "ws", &relay(10), &NoFaults, &crate::NoLiveLeases, 1_000),
        Ok(TxnOutcome::Committed(ref declines)) if declines.is_empty()
    ));
    assert!(matches!(
        commit_relay_cursor(&mut engine, "ws", &relay(4), &NoFaults, &crate::NoLiveLeases, 1_000),
        Ok(TxnOutcome::Committed(ref declines)) if declines.is_empty()
    ));
    assert_eq!(
        read_relay_cursor(&engine, "ws")
            .expect("read relay cursor")
            .expect("relay cursor")
            .cursor,
        10
    );
    let share = |cursor| ShareCursor {
        kind: CursorKind::ShareView,
        share_id: "share".to_owned(),
        cursor,
    };
    assert!(matches!(
        commit_share_cursor(&mut engine, "ws", &share(10), &NoFaults),
        Ok(TxnOutcome::Committed(()))
    ));
    assert!(matches!(
        commit_share_cursor(&mut engine, "ws", &share(4), &NoFaults),
        Ok(TxnOutcome::Committed(_))
    ));
    assert_eq!(
        read_share_cursor(&engine, "ws", "share", CursorKind::ShareView)
            .expect("read share cursor"),
        10,
        "unconditional conflict updates let an older acknowledgement regress the cursor"
    );
}
#[test]
fn relay_retry_surfaces_refusal_acked_before_later_error() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    // A mutation-level invalid input: the channel timestamp guard runs inside
    // the savepoint, so this refuses-and-acks. (moment.append with an empty
    // payload is not usable here: since #243 implemented that applier, its
    // payload deserialization fails pre-savepoint and stays a hard error.)
    let refused = envelope(
        "retry-refusal-peer",
        0,
        "chat.channel.create",
        json!({
            "channelId": "retry-refusal-channel",
            "name": "Refused",
            "slug": "refused",
            "kind": "channel",
            "createdAtMs": -1
        }),
    );
    let mut later = version_create_with_shipped_snapshots(
        "retry-refusal-later-peer",
        "retry-refusal-later-version",
        Vec::new(),
    );
    later.recorded_at_ms = refused.recorded_at_ms + 1;
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "CREATE TRIGGER inject_retry_refusal_later_failure \
                 BEFORE INSERT ON versions \
                 WHEN NEW.version_id='retry-refusal-later-version' \
                 BEGIN SELECT RAISE(ABORT, 'injected later apply failure'); END",
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("install later apply failure");
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![refused, later],
            next_cursor: 2,
            has_more: false,
        })),
    });

    assert!(matches!(
        client.pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000
        ),
        Err(RelayError::Local(_))
    ));
    let persisted: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_pending_refusals \
                 WHERE workspace_id='ws' AND origin_id='retry-refusal-peer' AND origin_seq=0",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("persisted refusal count");
    assert_eq!(
        persisted, 1,
        "the refusal must persist before the later hard failure"
    );
    assert!(
        read_relay_cursor(&engine, "ws")
            .expect("relay cursor")
            .is_none()
    );

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch("DROP TRIGGER inject_retry_refusal_later_failure")
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("clear later apply failure");

    let retry = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("retry pull");
    let SyncPassOutcome::Complete {
        applied,
        refused: refused_count,
        skipped,
        refusals,
        ..
    } = retry
    else {
        panic!("retry must complete: {retry:?}");
    };
    assert_eq!((applied, refused_count, skipped), (1, 0, 1));
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "retry-refusal-peer".to_owned(),
            origin_seq: 0,
            op_kind: "chat.channel.create".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "chat channel timestamp is invalid".to_owned(),
            },
        }],
        "the Skipped path must reconstruct the persisted refusal"
    );
}

#[test]
fn pull_keeps_a_genuine_origin_gap_hard() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let mut gap =
        version_create_with_shipped_snapshots("gapped-peer", "must-not-apply", Vec::new());
    gap.origin_seq = 1;
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![gap],
            next_cursor: 1,
            has_more: false,
        })),
    });

    assert!(matches!(
        client.pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000
        ),
        Err(RelayError::Local(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "gapped-peer").expect("gap ack"),
        -1,
        "a gap without an earlier retryable coordinate must remain unacked"
    );
}

#[test]
fn pull_reaches_later_cross_origin_work_before_retrying_a_deferred_origin() {
    use crate::conflict_resolve_v1::{
        ConflictResolveV1, EffectContextV1, EffectKindV1, EffectV1, HeadContentKindV1, HeadV1,
        MetadataV1, PresentHeadV1, ResolutionV1, ResolveChoiceV1, build_conflict_resolve_v1,
    };

    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let result_text = "resolved after retry";
    let result_sha = dohc_engine_storage::hex_sha256(result_text.as_bytes());
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![result_sha, result_text.len() as i64, result_text],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed result blob");
    let result = HeadV1::Present(PresentHeadV1 {
        path_ref: 0,
        object_id: "retry-object".to_owned(),
        latest_moment_id: "retry-result-moment".to_owned(),
        content_kind: HeadContentKindV1::Text,
        blob_sha256: result_sha,
        byte_length: result_text.len() as i64,
        updated_at_ms: 21,
    });
    let built = build_conflict_resolve_v1(ConflictResolveV1 {
        workspace_id: "ws".to_owned(),
        conflict_id: "retryable-parent-conflict".to_owned(),
        chosen_from: ResolveChoiceV1::Incoming,
        resolution: ResolutionV1::AppliedIncoming,
        target_version_id: "main".to_owned(),
        source_version_id: "peer".to_owned(),
        paths: vec!["retry.md".to_owned()],
        current: HeadV1::Absent { path_ref: 0 },
        incoming: result.clone(),
        result,
        effect_context: EffectContextV1 {
            recorded_at_ms: 21,
            metadata: MetadataV1 {
                origin: "sync".to_owned(),
                summary: None,
                correlation_id: None,
            },
            author: None,
            current_object_created_at_ms: None,
            result_object_created_at_ms: Some(20),
        },
        effects: vec![EffectV1 {
            kind: EffectKindV1::Write,
            moment_id: "retry-result-moment".to_owned(),
            payload_sha256: String::new(),
        }],
        lineage_transition: None,
    })
    .expect("retryable parent carrier");
    let mut parent = envelope("bundle-peer", 0, "conflict.resolve", built.value);
    parent.recorded_at_ms = 21;
    let mut child = envelope(
        "bundle-peer",
        1,
        "moment.append",
        built.validated.shadows[0].clone(),
    );
    child.recorded_at_ms = 22;
    let mut same_origin_later =
        version_create_with_shipped_snapshots("bundle-peer", "same-origin-version", Vec::new());
    same_origin_later.origin_seq = 2;
    same_origin_later.recorded_at_ms = 23;
    let mut later =
        version_create_with_shipped_snapshots("later-peer", "later-version", Vec::new());
    later.recorded_at_ms = 24;
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![parent, child, same_origin_later, later],
            next_cursor: 4,
            has_more: false,
        })),
    });
    let leases = FirstLeaseCheckLive(AtomicUsize::new(0));

    let outcome = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &leases,
            1_000,
        )
        .expect("later cross-origin work must run before the deferred origin retry pass");
    assert!(
        matches!(outcome, SyncPassOutcome::Complete { applied: 4, .. }),
        "the parent, its whole origin suffix, and later cross-origin work must apply: {outcome:?}"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "bundle-peer").expect("bundle ack"),
        2
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "later-peer").expect("later ack"),
        0
    );
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "retry.md")
            .expect("resolved head")
            .expect("resolved head exists")
            .text,
        result_text
    );
}

#[test]
fn relay_retry_surfaces_drain_refusal_from_an_earlier_cursor_page() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let (base_bytes, invalid_bytes) = clock_collision_pair();
    let base_sha = engine.put_binary_blob(&base_bytes).expect("base blob");
    let invalid_sha = engine
        .put_binary_blob(&invalid_bytes)
        .expect("pre-base update blob");
    let deferred = envelope(
        "prior-page-deferred-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-prior-page-drain",
            "path": "notes/prior-page-drain.md",
            "contentKind": "plaintext",
            "updateBlobSha256": invalid_sha,
            "lineageClaimId": base_sha.clone(),
            "isBaseState": false
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &deferred,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-lineage-absent"),
                conflicts_opened: 0,
                lineage_replacement: None,
                record_facts: _,
            }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let base = envelope(
        "current-page-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-prior-page-drain",
            "path": "notes/prior-page-drain.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha,
            "isBaseState": true
        }),
    );
    let mut later = version_create_with_shipped_snapshots(
        "current-page-later-peer",
        "current-page-later-version",
        Vec::new(),
    );
    later.recorded_at_ms = base.recorded_at_ms + 1;
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "CREATE TRIGGER inject_current_page_later_failure \
                 BEFORE INSERT ON versions \
                 WHEN NEW.version_id='current-page-later-version' \
                 BEGIN SELECT RAISE(ABORT, 'injected later apply failure'); END",
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("install later apply failure");
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![base, later],
            next_cursor: 2,
            has_more: false,
        })),
    });

    assert!(matches!(
        client.pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000
        ),
        Err(RelayError::Local(_))
    ));
    assert!(
        read_relay_cursor(&engine, "ws")
            .expect("relay cursor")
            .is_none()
    );
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch("DROP TRIGGER inject_current_page_later_failure")
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("clear later apply failure");

    let retry = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("retry pull");
    let SyncPassOutcome::Complete {
        applied,
        refused,
        skipped,
        refusals,
        ..
    } = retry
    else {
        panic!("retry must complete: {retry:?}");
    };
    assert_eq!((applied, refused, skipped), (1, 0, 1));
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "prior-page-deferred-peer".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "parked ydoc.update could not be applied".to_owned(),
            },
        }],
        "reading refusals only for retried page coordinates loses the drain disposition"
    );
}

#[test]
fn committed_pull_cursor_clears_persisted_refusals() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![envelope(
                "cursor-clear-refusal-peer",
                0,
                "chat.channel.create",
                json!({
                    "channelId": "cursor-clear-refusal-channel",
                    "name": "Refused",
                    "slug": "refused",
                    "kind": "channel",
                    "createdAtMs": -1
                }),
            )],
            next_cursor: 1,
            has_more: false,
        })),
    });

    let outcome = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("pull");
    let SyncPassOutcome::Complete {
        pending_cursor: Some(pending_cursor),
        ..
    } = outcome
    else {
        panic!("pull must complete with a cursor: {outcome:?}");
    };
    let persisted = |engine: &EngineStore| -> i64 {
        engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals WHERE workspace_id='ws'",
                    [],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)
            })
            .expect("count pending refusals")
    };
    assert_eq!(persisted(&engine), 1, "the refusal is persisted");

    client
        .commit_pull_cursor(
            &mut engine,
            "ws",
            &pending_cursor,
            &NoFaults,
            &crate::NoLiveLeases,
            1_000,
        )
        .expect("commit cursor");
    assert_eq!(
        persisted(&engine),
        0,
        "cursor commit must sweep persisted refusal reports"
    );
}

#[test]
fn cursor_commit_preserves_an_unread_refusal_created_by_a_later_ydoc_drain() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let (base_bytes, invalid_bytes) = clock_collision_pair();
    let base_sha = engine.put_binary_blob(&base_bytes).expect("base blob");
    let invalid_sha = engine
        .put_binary_blob(&invalid_bytes)
        .expect("deferred blob");
    let deferred = envelope(
        "post-pull-drain-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-post-pull-drain",
            "path": "notes/post-pull-drain.md",
            "contentKind": "plaintext",
            "updateBlobSha256": invalid_sha,
            "lineageClaimId": base_sha.clone(),
            "isBaseState": false
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &deferred,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult { deferred: true, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let first_client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![envelope(
                "first-report-peer",
                0,
                "chat.channel.create",
                json!({
                    "channelId": "first-report-channel",
                    "name": "Refused",
                    "slug": "refused",
                    "kind": "channel",
                    "createdAtMs": -1
                }),
            )],
            next_cursor: 1,
            has_more: false,
        })),
    });
    let first = first_client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("first pull");
    let SyncPassOutcome::Complete {
        pending_cursor: Some(first_cursor),
        refusals: first_refusals,
        ..
    } = first
    else {
        panic!("first pull must complete: {first:?}");
    };
    assert_eq!(first_refusals.len(), 1);
    assert!(
        first_cursor.refusal_report_id.is_some(),
        "a surfaced refusal must be owned by this pending cursor"
    );

    // This models open/resync/close draining after pull returns. Its structured
    // result is deliberately dropped by those runtime calls, so persistence is
    // the only path by which the next pull can surface the refusal.
    let base = envelope(
        "post-pull-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-post-pull-drain",
            "path": "notes/post-pull-drain.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha,
            "isBaseState": true
        }),
    );
    let _ignored_drain_result = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("base triggers drain refusal");
    let pending_before_commit: Vec<(String, Option<String>)> = engine
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT origin_id,report_id FROM replication_pending_refusals \
                 WHERE workspace_id='ws' ORDER BY origin_id",
            )?;
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect()
        })
        .expect("pending refusals");
    assert_eq!(pending_before_commit.len(), 2);
    assert!(
        pending_before_commit
            .iter()
            .any(|(origin, report)| origin == "post-pull-drain-peer" && report.is_none()),
        "a drain after pull must remain unowned by the earlier cursor"
    );

    first_client
        .commit_pull_cursor(
            &mut engine,
            "ws",
            &first_cursor,
            &NoFaults,
            &crate::NoLiveLeases,
            1_000,
        )
        .expect("commit first cursor");
    let survivors: Vec<(String, Option<String>)> = engine
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT origin_id,report_id FROM replication_pending_refusals \
                 WHERE workspace_id='ws' ORDER BY origin_id",
            )?;
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect()
        })
        .expect("surviving refusals");
    assert_eq!(
        survivors,
        vec![("post-pull-drain-peer".to_owned(), None)],
        "a workspace-wide cursor sweep destroys this unread drain refusal"
    );

    let second_client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![envelope(
                "second-report-peer",
                0,
                "chat.channel.create",
                json!({
                    "channelId": "second-report-channel",
                    "name": "Second",
                    "slug": "second",
                    "kind": "channel",
                    "createdAtMs": 2
                }),
            )],
            next_cursor: 2,
            has_more: false,
        })),
    });
    let second = second_client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("next pull surfaces drain refusal");
    let SyncPassOutcome::Complete {
        pending_cursor: Some(second_cursor),
        refusals,
        ..
    } = second
    else {
        panic!("second pull must complete: {second:?}");
    };
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "post-pull-drain-peer".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "parked ydoc.update could not be applied".to_owned(),
            },
        }],
        "the next pull is the explicit reader for non-pull drain refusals"
    );
    second_client
        .commit_pull_cursor(
            &mut engine,
            "ws",
            &second_cursor,
            &NoFaults,
            &crate::NoLiveLeases,
            1_000,
        )
        .expect("commit second cursor");
    let remaining: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_pending_refusals WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )
        })
        .expect("remaining refusals");
    assert_eq!(
        remaining, 0,
        "a refusal clears only after the cursor that actually surfaced it commits"
    );
}

#[test]
fn relay_claim_does_not_consume_a_direct_rpc_refusal() {
    let (_scratch, _path, mut engine) = open_store();
    let direct = envelope("direct-conflict-peer", 0, "conflict.open", json!({}));
    assert!(matches!(
        apply_conflict_envelope(&mut engine, &direct, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Refused(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    retain_refusal_for_direct_retry(&mut engine, &direct, &NoFaults)
        .expect("protect direct refusal");

    let (claimed, report_id) = crate::apply::claim_pending_refusals(&mut engine, "ws", &NoFaults)
        .expect("unrelated relay claim");
    assert!(
        claimed.is_empty() && report_id.is_none(),
        "claiming every workspace row steals the direct RPC retry disposition"
    );
    let cursor = RelayCursor {
        bootstrap_complete: true,
        cursor: 0,
        replication_epoch: "epoch".to_owned(),
        stream_identity: "stream".to_owned(),
        refusal_report_id: report_id,
        settlement_report_id: None,
    };
    commit_relay_cursor(
        &mut engine,
        "ws",
        &cursor,
        &NoFaults,
        &crate::NoLiveLeases,
        1_000,
    )
    .expect("cursor commit");
    let replayed = read_replayed_refusal(&engine, &direct)
        .expect("read direct refusal")
        .expect("direct refusal survives");
    assert_eq!(
        replayed.reason,
        RefusalReason::InvalidInput {
            reason: "conflict.open payload is malformed".to_owned()
        }
    );
}

#[test]
fn relay_cursor_serializes_numeric_position_into_the_shipped_text_column() {
    let (_scratch, _path, mut engine) = open_store();
    let cursor = RelayCursor {
        bootstrap_complete: true,
        cursor: 42,
        replication_epoch: "epoch-1".to_owned(),
        stream_identity: "stream-1".to_owned(),
        refusal_report_id: None,
        settlement_report_id: None,
    };
    assert!(matches!(
        commit_relay_cursor(&mut engine, "ws", &cursor, &NoFaults, &crate::NoLiveLeases, 1_000),
        Ok(TxnOutcome::Committed(ref declines)) if declines.is_empty()
    ));
    let stored = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT typeof(cursor), cursor FROM sync_relay_cursors WHERE workspace_id='ws'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("stored cursor");
    assert_eq!(stored, ("text".to_owned(), "42".to_owned()));
    assert_eq!(
        read_relay_cursor(&engine, "ws").expect("parsed cursor"),
        Some(cursor)
    );

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE sync_relay_cursors SET cursor='not-a-number' WHERE workspace_id='ws'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("poison cursor");
    assert!(matches!(
        read_relay_cursor(&engine, "ws"),
        Err(SyncError::InvalidInput {
            reason: "persisted relay cursor is invalid"
        })
    ));
}

#[test]
fn router_counts_only_newly_inserted_replicated_open_conflicts() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let side = |path: &str| {
        json!({
            "exists": false,
            "path": path,
            "contentKind": "text"
        })
    };
    let payload = json!({
        "id": "router-open-conflict",
        "workspaceId": "ws",
        "path": "doc.md",
        "targetVersionId": "main",
        "sourceVersionId": "peer",
        "createdAtMs": 2_000,
        "updatedAtMs": 2_000,
        "base": side("doc.md"),
        "current": side("doc.md"),
        "incoming": side("doc.md"),
        "status": "open",
        "chosenFrom": "current",
        "metadata": {"origin": "sync"}
    });

    let first = envelope("router-open-a", 0, "conflict.open", payload.clone());
    let ApplyOutcome {
        primary: ApplyDisposition::Applied(first),
        refusals: ref outcome_refusals,
        sharing_declined: ref outcome_sharing_declined,
    } = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &first,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("first routed open")
    else {
        panic!("first conflict.open did not apply");
    };
    assert!(outcome_refusals.is_empty());
    assert!(outcome_sharing_declined.is_empty());
    assert_eq!(
        first.conflict.as_ref().and_then(|row| row.inserted),
        Some(true)
    );
    assert_eq!(first.conflicts_opened, 1);

    let duplicate = envelope("router-open-b", 0, "conflict.open", payload);
    let ApplyOutcome {
        primary: ApplyDisposition::Applied(duplicate),
        refusals: ref outcome_refusals,
        sharing_declined: ref outcome_sharing_declined,
    } = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &duplicate,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("idempotent routed open")
    else {
        panic!("duplicate conflict.open did not apply");
    };
    assert!(outcome_refusals.is_empty());
    assert!(outcome_sharing_declined.is_empty());
    assert_eq!(
        duplicate.conflict.as_ref().and_then(|row| row.inserted),
        Some(false)
    );
    assert_eq!(
        duplicate.conflicts_opened, 0,
        "flattening the structured result yields 0 for the first assertion; hardcoding every conflict.open as one breaks this assertion."
    );
}

#[test]
fn malformed_moment_append_router_refuses_and_acks() {
    let (_scratch, _path, mut engine) = open_store();
    let operation = envelope("moment-peer", 0, "moment.append", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { ref reason },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "moment.append payload is malformed")
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "moment-peer").expect("ack"),
        0
    );
}

#[test]
fn refused_op_acks_and_the_next_same_origin_op_applies() {
    let (_scratch, _path, mut engine) = open_store();
    let refused = envelope(
        "progress-peer",
        0,
        "chat.decision.set",
        decision_payload("open", i64::MAX, None),
    );
    let outcome = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &refused,
        &NoFaults,
        &NoLiveLeases,
    );
    assert!(matches!(
        outcome,
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Refused(ReplicationRefusal {
                reason: RefusalReason::InvalidInput { .. },
                ..
            }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let next = envelope("progress-peer", 1, "workspace.init", json!({}));
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &next,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "progress-peer").expect("ack"),
        1
    );
}

#[test]
fn malformed_ydoc_op_is_refused_without_wedging_its_origin() {
    let (_scratch, _path, mut engine) = open_store();
    let malformed = envelope("ydoc-refusal-peer", 0, "ydoc.update", json!({}));
    assert!(matches!(
        apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &malformed, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "ydoc.update payload is malformed")
    ));

    let next = envelope("ydoc-refusal-peer", 1, "workspace.init", json!({}));
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &next,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "ydoc-refusal-peer").expect("ack"),
        1
    );
}

#[test]
fn relay_pull_surfaces_refusal_reason_to_the_caller() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![envelope(
                "reason-peer",
                0,
                "chat.channel.create",
                json!({
                    "channelId": "reason-channel",
                    "name": "Refused",
                    "slug": "refused",
                    "kind": "channel",
                    "createdAtMs": -1
                }),
            )],
            next_cursor: 1,
            has_more: false,
        })),
    });

    let outcome = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("a refused operation must not fail the pull");
    let SyncPassOutcome::Complete {
        applied,
        refused,
        skipped,
        pending_cursor,
        refusals,
        ..
    } = outcome
    else {
        panic!("refused pull must complete: {outcome:?}");
    };
    assert_eq!((applied, refused, skipped), (0, 1, 0));
    assert!(pending_cursor.is_some());
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "reason-peer".to_owned(),
            origin_seq: 0,
            op_kind: "chat.channel.create".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "chat channel timestamp is invalid".to_owned(),
            },
        }]
    );
    assert_eq!(refusals[0].reason.code(), "invalid-input");
    assert_eq!(
        refusals[0].reason.message(),
        "chat channel timestamp is invalid"
    );
}

#[test]
fn coordinate_divergence_still_stops_a_pass_after_an_acked_refusal() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let first = envelope(
        "divergent-refusal-peer",
        0,
        "chat.channel.create",
        json!({
            "channelId": "divergent-refusal-channel",
            "name": "Refused",
            "slug": "refused",
            "kind": "channel",
            "createdAtMs": -1
        }),
    );
    let mut divergent = first.clone();
    divergent.payload = json!({"tampered": true});
    let client = RelaySyncClient::new(FakeRelay {
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![
                first,
                divergent,
                envelope("divergent-refusal-peer", 1, "workspace.init", json!({})),
            ],
            next_cursor: 3,
            has_more: false,
        })),
    });

    assert!(matches!(
        client.pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000
        ),
        Err(RelayError::Local(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "divergent-refusal-peer").expect("ack"),
        0,
        "the first refusal is durable, but divergence must stop the pass"
    );
    let initialized: bool = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM versioned_workspaces WHERE workspace_id='ws')",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("workspace state");
    assert!(!initialized, "the op after divergence must not apply");
}

#[test]
fn structurally_invalid_envelope_remains_unrecorded_and_unacked() {
    let (_scratch, _path, mut engine) = open_store();
    let mut invalid = envelope("structural-peer", 0, "moment.append", json!({}));
    invalid.origin_seq = MAX_WIRE_INTEGER + 1;

    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &invalid,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::InvalidInput {
            reason: "origin_seq is outside the wire integer range"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "structural-peer").expect("ack"),
        -1
    );
    let recorded: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='structural-peer'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("journal rows");
    assert_eq!(recorded, 0);
}

#[test]
fn redelivered_refusal_is_recorded_once_and_skipped() {
    let (_scratch, _path, mut engine) = open_store();
    let refused = envelope(
        "refusal-replay-peer",
        0,
        "chat.channel.create",
        json!({
            "channelId": "refusal-replay-channel",
            "name": "Refused",
            "slug": "refused",
            "kind": "channel",
            "createdAtMs": -1
        }),
    );
    let first = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &refused,
        &NoFaults,
        &NoLiveLeases,
    );
    assert!(matches!(
        first,
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Refused(ReplicationRefusal {
                reason: RefusalReason::InvalidInput { .. },
                ..
            }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &refused,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Skipped,
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let recorded: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='refusal-replay-peer' AND origin_seq=0",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("refusal journal row");
    assert_eq!(recorded, 1);
}

#[test]
fn every_refusal_reason_round_trips_through_persist_and_read() {
    let (_scratch, _path, mut engine) = open_store();
    for operation in [
        envelope("roundtrip-invalid-refusal", 0, "ydoc.update", json!({})),
        envelope(
            "roundtrip-chat-refusal",
            0,
            "chat.channel.create",
            json!({
                "channelId": "roundtrip-channel",
                "name": "Refused",
                "slug": "refused",
                "kind": "channel",
                "createdAtMs": -1
            }),
        ),
    ] {
        let ApplyOutcome {
            primary: ApplyDisposition::Refused(expected),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        } = apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("refusal")
        else {
            panic!("operation must be refused");
        };
        assert!(outcome_refusals.is_empty());
        assert!(outcome_sharing_declined.is_empty());
        assert_eq!(
            crate::apply::read_replayed_refusal(&engine, &operation)
                .expect("read refusal")
                .expect("persisted refusal"),
            expected,
            "the owned refusal message and variant must round-trip losslessly"
        );
        let exhaustively_matched_message = match &expected.reason {
            RefusalReason::InvalidInput { reason } => reason,
        };
        assert_eq!(
            exhaustively_matched_message,
            expected.reason.message(),
            "the exhaustive guard must execute for every persisted refusal variant"
        );
    }
}

/// A Y.Doc payload is its own blob kind, and `ydoc.update` must reference it.
/// While it referenced `BlobKind::Binary` the lineage inherited the
/// captured-file ceiling — 5 MiB, a number about user uploads — and a base
/// larger than that was refused on hydrate no matter what the collab layer
/// allowed.
///
#[test]
fn a_ydoc_base_over_the_captured_file_cap_still_hydrates() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let (ydoc_constraint, ydoc_limit) = blob_ceiling(BlobKind::Ydoc);
    let (binary_constraint, binary_limit) = blob_ceiling(BlobKind::Binary);
    assert_eq!(ydoc_constraint, "MAX_YDOC_UPDATE_BYTES");
    assert_ne!(
        ydoc_constraint, binary_constraint,
        "the two ceilings must stay separately named"
    );
    assert!(
        ydoc_limit > binary_limit,
        "the measured Y.Doc bound ({ydoc_limit}) must exceed the captured-file \
         cap ({binary_limit}) it used to inherit; otherwise the documents this \
         issue is about are still refused"
    );

    // Between the two ceilings: the size that used to be unreachable.
    let base = vec![7u8; binary_limit + 1];
    let sha256 = dohc_engine_storage::hex_sha256(&base);
    let op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-oversize-base",
            "path": "notes/oversize.md",
            "contentKind": "richdoc",
            "updateBlobSha256": sha256.clone(),
            "lineageClaimId": sha256.clone(),
            "isBaseState": true
        }),
    );
    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![op],
            next_cursor: 1,
            has_more: false,
        },
    )]);
    relay.blobs.insert(sha256.clone(), base);

    // These bytes are not a Y.Doc, so the apply refuses them — but hydration
    // runs first, and that is what this test is about. The refusal must not be
    // a ceiling refusal.
    let outcome = RelaySyncClient::new(relay)
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("the pull completes: an oversized-for-binary Y.Doc base is not a transport error");
    assert!(
        matches!(outcome, SyncPassOutcome::Complete { .. }),
        "unexpected pass outcome: {outcome:?}"
    );
    assert!(
        engine.has_binary_blob(&sha256).expect("blob presence"),
        "the base blob hydrated under the Y.Doc ceiling"
    );
}

/// Splitting the ceiling split presence from validation, and only one half
/// moved. `Binary` and `Ydoc` share `binary_blobs`, so once a Y.Doc base over
/// the captured-file cap has hydrated legitimately, a later `moment.append`
/// naming the same digest as `binary` was reported already-satisfied — skipping
/// `hydrate_blob_content`, the only place `MAX_CAPTURE_BINARY_FILE_BYTES` is
/// enforced. `require_binary_blob` applies no ceiling at all, so an authorized
/// peer could materialize a 20 MiB Y.Doc payload as an oversized captured file.
///
/// The inverse of the defect #549 fixed: there a Y.Doc payload inherited a cap
/// about user uploads; here a user upload borrows the Y.Doc payload's cap.
///
/// The bytes must already be stored for the hole to open, and one batch cannot
/// do it: a pass accumulates every page into a single `ops` list and hydrates
/// once, so both kinds come up missing together and the binary half refuses on
/// its own ceiling. The precondition here is this machine's own origination —
/// `ydoc_originate_base_in_tx` writes the base through `put_binary_blob`,
/// bounded only by the 64 MiB store — so no peer is needed to create it.
///
#[test]
fn a_ydoc_payload_cannot_be_reused_as_an_over_cap_captured_binary() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let (binary_constraint, binary_limit) = blob_ceiling(BlobKind::Binary);
    let (_, ydoc_limit) = blob_ceiling(BlobKind::Ydoc);

    // A real Y.Doc full state, so the first pass genuinely applies and the
    // lineage really exists. Bytes that merely look like a base would be
    // refused by the apply, and then the second pass would be running against
    // a precondition no honest peer could produce.
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, &"x".repeat(binary_limit + 40_000));
    let payload = doc.encode_full_state();
    assert!(
        payload.len() > binary_limit && payload.len() <= ydoc_limit,
        "the base must sit between the two ceilings: {} bytes",
        payload.len()
    );
    let sha256 = dohc_engine_storage::hex_sha256(&payload);

    let steal = envelope(
        "peer",
        0,
        "moment.append",
        json!({
            "momentId": "peer-steal",
            "versionId": "main",
            "objectId": "object-steal",
            "objectCreatedAtMs": 1,
            "path": "notes/steal.bin",
            "recordedAtMs": 2_000,
            "operation": "write",
            "payloadBeforeBlobSha256": null,
            "payloadBeforePath": null,
            "payloadAfterBlobSha256": sha256,
            "payloadAfterPath": "notes/steal.bin",
            "payloadAfterContentKind": "binary",
            "payloadAfterByteLength": payload.len(),
            "metadata": {"origin": "sync"},
            "beforePresent": "absent"
        }),
    );

    // Pass one: the Y.Doc base hydrates legitimately under its own ceiling.
    // The precondition: these bytes are already in `binary_blobs`. This is
    // exactly what `ydoc_originate_base_in_tx` writes when this machine starts
    // a shared lineage — `put_binary_blob`, bounded only by the 64 MiB store —
    // so the state is one the engine produces itself, with no peer involved.
    let stored = engine.put_binary_blob(&payload).expect("store the base");
    assert_eq!(stored, sha256);

    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![steal],
            next_cursor: 1,
            has_more: false,
        },
    )]);
    relay.blobs.insert(sha256.clone(), payload.clone());

    assert_eq!(
        RelaySyncClient::new(relay).pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        ),
        Err(RelayError::BlobTooLarge {
            constraint: binary_constraint,
            limit_bytes: binary_limit,
            observed: ObservedBytes::Exact(payload.len()),
        }),
        "referencing a stored Y.Doc payload as a captured binary must be refused \
         by the captured-file ceiling, not admitted because the bytes are in the \
         shared table"
    );

    // And nothing of the theft persisted.
    let snapshots: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM snapshots WHERE path='notes/steal.bin'",
                [],
                |row| row.get(0),
            )
        })
        .expect("snapshot count");
    assert_eq!(snapshots, 0, "no over-cap binary snapshot may materialize");
}

/// The PUSH side of the same mistake. `upload_missing_blobs` reads the blob out
/// of the local store before it sends it, and that reader carried the binary
/// ceiling as a `5 * 1024 * 1024` literal — so a Y.Doc base this engine had just
/// originated read back as `BlobInvalid`. Wrong constraint, wrong error, and it
/// would have made the widened bound unusable in the direction that matters
/// first.
///
#[test]
fn the_local_blob_reader_measures_against_the_referenced_kind() {
    let (_scratch, _path, engine) = open_store();
    let (_, binary_limit) = blob_ceiling(BlobKind::Binary);
    let bytes = vec![4u8; binary_limit + 1];
    let sha256 = engine.put_binary_blob(&bytes).expect("store the blob");

    assert_eq!(
        crate::relay::local_blob_bytes(&engine, &sha256, BlobKind::Ydoc),
        Ok(Some(bytes)),
        "a Y.Doc payload past the captured-file cap is readable for push"
    );
    assert_eq!(
        crate::relay::local_blob_bytes(&engine, &sha256, BlobKind::Binary),
        Err(RelayError::BlobInvalid),
        "the same bytes referenced as a captured file are still over ITS ceiling"
    );
}

/// The Y.Doc half of the ingest chokepoint. Text and binary are pinned above.
///
#[test]
fn a_ydoc_blob_at_the_ydoc_ceiling_hydrates_and_one_byte_over_is_refused() {
    let (_scratch, _path, mut engine) = open_store();
    let (constraint, limit_bytes) = blob_ceiling(BlobKind::Ydoc);
    assert_eq!(
        (constraint, limit_bytes),
        (
            "MAX_YDOC_UPDATE_BYTES",
            dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES
        ),
        "the Y.Doc ingest ceiling is the collab layer's measured payload bound"
    );

    let at_cap = vec![9u8; limit_bytes];
    let accepted = BlobHydration {
        sha256: dohc_engine_storage::hex_sha256(&at_cap),
        content: BlobContent::Ydoc(at_cap),
    };
    assert_eq!(
        hydrate_blob_content(&mut engine, &accepted, &NoFaults).expect("at-cap Y.Doc hydrates"),
        TxnOutcome::Committed(())
    );
    assert!(
        engine
            .has_binary_blob(&accepted.sha256)
            .expect("blob presence"),
        "a Y.Doc payload shares the content-addressed binary table"
    );

    let over_cap = vec![9u8; limit_bytes + 1];
    let refused = BlobHydration {
        sha256: dohc_engine_storage::hex_sha256(&over_cap),
        content: BlobContent::Ydoc(over_cap),
    };
    let error = hydrate_blob_content(&mut engine, &refused, &NoFaults)
        .expect_err("over-cap Y.Doc is refused");
    assert_eq!(
        error.to_string(),
        format!(
            "blob exceeds MAX_YDOC_UPDATE_BYTES: limit {limit_bytes} bytes, observed {} bytes",
            limit_bytes + 1
        )
    );
    assert!(
        !engine
            .has_binary_blob(&refused.sha256)
            .expect("blob presence"),
        "an over-cap Y.Doc payload must not persist"
    );
}

/// The binary half of the same chokepoint. The text half is pinned above; this
/// one was not, so the ceiling could be deleted for `BlobKind::Binary` alone
/// and every other test stayed green.
///
#[test]
fn binary_blob_over_the_binary_ceiling_is_refused_at_ingest() {
    let (_scratch, _path, mut engine) = open_store();
    let (constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);
    // Pinned, not derived. Every other expectation here reads the ceiling from
    // `blob_ceiling`, so without this a widened ceiling would carry the whole
    // test with it and still report green.
    assert_eq!(
        (constraint, limit_bytes),
        ("MAX_CAPTURE_BINARY_FILE_BYTES", 5 * 1024 * 1024),
        "binary ingest is the tighter ceiling this test exists to hold"
    );

    let at_cap = vec![3u8; limit_bytes];
    let accepted = BlobHydration {
        sha256: dohc_engine_storage::hex_sha256(&at_cap),
        content: BlobContent::Binary(at_cap),
    };
    assert_eq!(
        hydrate_blob_content(&mut engine, &accepted, &NoFaults).expect("at-cap binary hydrates"),
        TxnOutcome::Committed(())
    );
    assert!(
        engine
            .has_binary_blob(&accepted.sha256)
            .expect("binary blob presence")
    );

    let over_cap = vec![3u8; limit_bytes + 1];
    let refused = BlobHydration {
        sha256: dohc_engine_storage::hex_sha256(&over_cap),
        content: BlobContent::Binary(over_cap),
    };
    let error = hydrate_blob_content(&mut engine, &refused, &NoFaults)
        .expect_err("over-cap binary is refused");
    assert!(
        matches!(
            error,
            SyncError::BlobTooLarge {
                constraint: named,
                limit_bytes: limit,
                observed_bytes,
            } if named == constraint && limit == limit_bytes && observed_bytes == limit_bytes + 1
        ),
        "unexpected refusal: {error:?}"
    );
    assert_eq!(
        error.to_string(),
        format!(
            "blob exceeds MAX_CAPTURE_BINARY_FILE_BYTES: limit {limit_bytes} bytes, observed {} bytes",
            limit_bytes + 1
        )
    );
    assert!(
        !engine
            .has_binary_blob(&refused.sha256)
            .expect("binary blob presence"),
        "an over-cap binary must not persist"
    );
}

#[test]
fn held_conflict_allows_later_pages_and_replays_after_restart() {
    assert_held_conflict_replays_after_restart(false);
}

#[test]
fn join_waits_for_held_conflict_before_originating_offline_documents() {
    assert_held_conflict_replays_after_restart(true);
}

fn assert_held_conflict_replays_after_restart(joining: bool) {
    use crate::conflict_resolve_v1::{
        ConflictResolveV1, EffectContextV1, EffectKindV1, EffectV1, HeadContentKindV1, HeadV1,
        MetadataV1, PresentHeadV1, ResolutionV1, ResolveChoiceV1, build_conflict_resolve_v1,
    };

    let (_scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let offline_key = dohc_engine_collab::DocKey::new("ws", "main", "offline-doc").unwrap();
    if joining {
        seed_text_head(&mut engine, "offline-doc", "offline.md", "offline edit");
        let offline = dohc_engine_collab::Ydoc::wire();
        let update = offline.plaintext_insert(0, "offline edit");
        dohc_engine_collab::record_local_update(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &offline_key,
            &update,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some("offline.md"),
                    content_kind: dohc_engine_collab::ContentKind::Plaintext,
                    regime: dohc_engine_collab::Regime::LocalOnly,
                }),
                ..Default::default()
            },
            &NoFaults,
            900,
            |_, _, _| Ok(()),
        )
        .unwrap();
    }
    let result_text = "resolved after retry";
    let result_sha = dohc_engine_storage::hex_sha256(result_text.as_bytes());
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![result_sha, result_text.len() as i64, result_text],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed result blob");
    let result = HeadV1::Present(PresentHeadV1 {
        path_ref: 0,
        object_id: "retry-object".to_owned(),
        latest_moment_id: "retry-result-moment".to_owned(),
        content_kind: HeadContentKindV1::Text,
        blob_sha256: result_sha.clone(),
        byte_length: result_text.len() as i64,
        updated_at_ms: 21,
    });
    let built = build_conflict_resolve_v1(ConflictResolveV1 {
        workspace_id: "ws".to_owned(),
        conflict_id: "retryable-parent-conflict".to_owned(),
        chosen_from: ResolveChoiceV1::Incoming,
        resolution: ResolutionV1::AppliedIncoming,
        target_version_id: "main".to_owned(),
        source_version_id: "peer".to_owned(),
        paths: vec!["retry.md".to_owned()],
        current: HeadV1::Absent { path_ref: 0 },
        incoming: result.clone(),
        result,
        effect_context: EffectContextV1 {
            recorded_at_ms: 21,
            metadata: MetadataV1 {
                origin: "sync".to_owned(),
                summary: None,
                correlation_id: None,
            },
            author: None,
            current_object_created_at_ms: None,
            result_object_created_at_ms: Some(20),
        },
        effects: vec![EffectV1 {
            kind: EffectKindV1::Write,
            moment_id: "retry-result-moment".to_owned(),
            payload_sha256: String::new(),
        }],
        lineage_transition: None,
    })
    .expect("retryable parent carrier");
    let mut parent = envelope("bundle-peer", 0, "conflict.resolve", built.value);
    parent.recorded_at_ms = 21;
    let mut child = envelope(
        "bundle-peer",
        1,
        "moment.append",
        built.validated.shadows[0].clone(),
    );
    child.recorded_at_ms = 22;
    let mut same_origin_later =
        version_create_with_shipped_snapshots("bundle-peer", "same-origin-version", Vec::new());
    same_origin_later.origin_seq = 2;
    same_origin_later.recorded_at_ms = 23;
    let mut later =
        version_create_with_shipped_snapshots("later-peer", "later-version", Vec::new());
    later.recorded_at_ms = 24;
    let mut page = vec![parent, child, same_origin_later];
    for sequence in 0..497 {
        let mut op = version_create_with_shipped_snapshots(
            "unrelated",
            &format!("independent-{sequence}"),
            Vec::new(),
        );
        op.origin_seq = sequence;
        page.push(op);
    }
    let client = RelaySyncClient::new(PagedRelay::new([
        (
            0,
            PullResponse {
                ops: page,
                next_cursor: 500,
                has_more: true,
            },
        ),
        (
            500,
            PullResponse {
                ops: vec![later],
                next_cursor: 501,
                has_more: false,
            },
        ),
        (
            501,
            PullResponse {
                ops: Vec::new(),
                next_cursor: 501,
                has_more: false,
            },
        ),
    ]));
    let leases = dohc_engine_collab::LeaseRegistry::new();
    let key = dohc_engine_collab::DocKey::new("ws", "main", "retry-object").unwrap();
    let held = leases.acquire(&key).unwrap();
    for expected_cursor in [500, 501] {
        let outcome = client
            .pull_chat_workspace(
                &mut engine,
                &mut dohc_engine_collab::WriterDocCache::new(),
                "ws",
                &NoFaults,
                &leases,
                1_000,
            )
            .expect("a held conflict must not block unrelated pages");
        let SyncPassOutcome::Complete {
            pending_cursor: Some(cursor),
            has_more,
            ..
        } = outcome
        else {
            panic!("durable cursor");
        };
        assert_eq!(cursor.cursor, expected_cursor);
        if joining {
            assert!(
                !cursor.bootstrap_complete,
                "fetching the last page does not finish applying the join"
            );
            assert_eq!(
                has_more,
                expected_cursor == 500,
                "a held lease must not cause an immediate retry loop"
            );
        }
        client
            .commit_pull_cursor(
                &mut engine,
                "ws",
                &cursor,
                &NoFaults,
                &crate::NoLiveLeases,
                1_000,
            )
            .unwrap();
        if joining {
            assert!(
                !dohc_engine_collab::read_marker(&engine, &offline_key)
                    .unwrap()
                    .unwrap()
                    .lineage_claim_status
                    .has_claimed_base(),
                "held remote work must not enroll offline documents"
            );
        }
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", "bundle-peer").unwrap(),
            -1,
            "retention is not application acknowledgement"
        );
    }
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "later-peer").unwrap(),
        0
    );
    assert!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "retry.md")
            .unwrap()
            .is_none()
    );
    assert!(
        engine
            .read_with(|conn| conn.execute("DELETE FROM blobs WHERE sha256=?1", [&result_sha]))
            .is_err(),
        "held work pins its hydrated blob before advancing the fetch cursor"
    );
    drop(held);
    drop(engine);
    let mut engine = EngineStore::open(&path, 1_001).unwrap();
    // Interrupt after application but before the disk report's cursor commits.
    let outcome = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &leases,
            1_001,
        )
        .unwrap();
    let SyncPassOutcome::Complete {
        pending_cursor: Some(stale_cursor),
        changed_paths,
        ..
    } = outcome
    else {
        panic!("replay");
    };
    assert!(changed_paths.iter().any(|change| change.path == "retry.md"));
    if joining {
        assert!(
            stale_cursor.bootstrap_complete,
            "applied deferred work finishes the join even before its report commits"
        );
    }
    drop(engine);
    let mut engine = EngineStore::open(&path, 1_002).unwrap();
    let outcome = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &leases,
            1_002,
        )
        .unwrap();
    let SyncPassOutcome::Complete {
        pending_cursor: Some(cursor),
        changed_paths,
        ..
    } = outcome
    else {
        panic!("report replay");
    };
    assert!(
        changed_paths.iter().any(|change| change.path == "retry.md"),
        "uncommitted disk report survives restart"
    );
    client
        .commit_pull_cursor(
            &mut engine,
            "ws",
            &stale_cursor,
            &NoFaults,
            &crate::NoLiveLeases,
            1_002,
        )
        .unwrap();
    let pending: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM relay_deferred_ops", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(
        pending, 3,
        "a stale report cannot remove the newer report's work"
    );
    client
        .commit_pull_cursor(
            &mut engine,
            "ws",
            &cursor,
            &NoFaults,
            &crate::NoLiveLeases,
            1_002,
        )
        .unwrap();
    let pending: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM relay_deferred_ops", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(pending, 0);
    if joining {
        assert!(
            read_relay_cursor(&engine, "ws")
                .unwrap()
                .unwrap()
                .bootstrap_complete
        );
        assert!(
            dohc_engine_collab::read_marker(&engine, &offline_key)
                .unwrap()
                .unwrap()
                .lineage_claim_status
                .has_claimed_base(),
            "settled join enrolls the offline document"
        );
    }
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "bundle-peer").unwrap(),
        2
    );
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "retry.md")
            .unwrap()
            .unwrap()
            .text,
        result_text
    );
    let count: i64 = engine.read_with(|conn| conn.query_row(
        "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND moment_id='retry-result-moment'", [], |row| row.get(0))).unwrap();
    assert_eq!(count, 1, "conflict effect applies exactly once");
}

#[test]
fn deferred_relay_work_rejects_divergence_gaps_identity_changes_and_limit_overflow() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let identity = read_sync_identity(&engine, "ws").unwrap().unwrap();
    let first = version_create_with_shipped_snapshots("held", "first", Vec::new());
    crate::deferred::retain(&mut engine, &identity, &[&first], &NoFaults).unwrap();
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "held").unwrap(),
        -1
    );
    let mut divergent = first.clone();
    divergent.recorded_at_ms += 1;
    assert!(crate::deferred::check_redelivery(&engine, &[divergent]).is_err());
    let mut next = version_create_with_shipped_snapshots("held", "second", Vec::new());
    next.origin_seq = 2;
    assert!(crate::deferred::retain(&mut engine, &identity, &[&next], &NoFaults).is_err());
    let mut other_identity = identity.clone();
    other_identity.replication_epoch = "another-epoch".to_owned();
    assert!(crate::deferred::read(&engine, "ws", &other_identity).is_err());
    other_identity = identity.clone();
    other_identity.stream_identity = "another-stream".to_owned();
    assert!(crate::deferred::read(&engine, "ws", &other_identity).is_err());
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE relay_deferred_ops SET retained_bytes=536870912", [])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    next.origin_seq = 1;
    assert!(crate::deferred::retain(&mut engine, &identity, &[&next], &NoFaults).is_err());
    let (pending, _) = crate::deferred::read(&engine, "ws", &identity).unwrap();
    assert_eq!(
        pending,
        vec![first],
        "limit overflow rolls back the entire new retention"
    );
    assert!(read_relay_cursor(&engine, "ws").unwrap().is_none());
}

#[test]
fn deferred_relay_replay_rotates_between_held_origins() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let identity = read_sync_identity(&engine, "ws").unwrap().unwrap();
    let mut ops = Vec::new();
    for seq in 0..501 {
        let mut op =
            version_create_with_shipped_snapshots("a-held", &format!("version-{seq}"), Vec::new());
        op.origin_seq = seq;
        ops.push(op);
    }
    ops.push(version_create_with_shipped_snapshots(
        "b-held",
        "other",
        Vec::new(),
    ));
    crate::deferred::retain(
        &mut engine,
        &identity,
        &ops.iter().collect::<Vec<_>>(),
        &NoFaults,
    )
    .unwrap();
    let (first, _) = crate::deferred::read(&engine, "ws", &identity).unwrap();
    assert_eq!(first.len(), 500);
    assert!(first.iter().all(|op| op.origin_id == "a-held"));
    let mut report = None;
    assert!(
        !crate::deferred::claim_report(&mut engine, "ws", &first, &[], &mut report, &NoFaults)
            .unwrap(),
        "held work must not trigger an immediate busy loop"
    );
    assert!(report.is_none());
    let (second, _) = crate::deferred::read(&engine, "ws", &identity).unwrap();
    assert_eq!(second[0].origin_id, "b-held");
    assert_eq!(
        second[1].origin_seq, 0,
        "each origin replays from its oldest retained work"
    );
}

#[test]
fn fetched_suffix_does_not_starve_a_released_deferred_origin() {
    use crate::conflict_resolve_v1::{
        ConflictResolveV1, EffectContextV1, EffectKindV1, EffectV1, HeadContentKindV1, HeadV1,
        MetadataV1, PresentHeadV1, ResolutionV1, ResolveChoiceV1, build_conflict_resolve_v1,
    };

    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let identity = read_sync_identity(&engine, "ws").unwrap().unwrap();
    let mut conflict = |origin: &str| {
        let result_text = "resolved after retry";
        let result_sha = dohc_engine_storage::hex_sha256(result_text.as_bytes());
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![result_sha, result_text.len() as i64, result_text],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed result blob");
        let result = HeadV1::Present(PresentHeadV1 {
            path_ref: 0,
            object_id: format!("{origin}-object"),
            latest_moment_id: format!("{origin}-moment"),
            content_kind: HeadContentKindV1::Text,
            blob_sha256: result_sha.clone(),
            byte_length: result_text.len() as i64,
            updated_at_ms: 21,
        });
        let built = build_conflict_resolve_v1(ConflictResolveV1 {
            workspace_id: "ws".to_owned(),
            conflict_id: format!("{origin}-conflict"),
            chosen_from: ResolveChoiceV1::Incoming,
            resolution: ResolutionV1::AppliedIncoming,
            target_version_id: "main".to_owned(),
            source_version_id: "peer".to_owned(),
            paths: vec![format!("{origin}.md")],
            current: HeadV1::Absent { path_ref: 0 },
            incoming: result.clone(),
            result,
            effect_context: EffectContextV1 {
                recorded_at_ms: 21,
                metadata: MetadataV1 {
                    origin: "sync".to_owned(),
                    summary: None,
                    correlation_id: None,
                },
                author: None,
                current_object_created_at_ms: None,
                result_object_created_at_ms: Some(20),
            },
            effects: vec![EffectV1 {
                kind: EffectKindV1::Write,
                moment_id: format!("{origin}-moment"),
                payload_sha256: String::new(),
            }],
            lineage_transition: None,
        })
        .expect("retryable parent carrier");
        let mut parent = envelope(origin, 0, "conflict.resolve", built.value);
        parent.recorded_at_ms = 21;
        parent
    };
    let mut retained = vec![conflict("a-held")];
    let released = conflict("b-released");
    for seq in 1..500 {
        let mut op = version_create_with_shipped_snapshots(
            "a-held",
            &format!("a-version-{seq}"),
            Vec::new(),
        );
        op.origin_seq = seq;
        retained.push(op);
    }
    retained.push(released);
    crate::deferred::retain(
        &mut engine,
        &identity,
        &retained.iter().collect::<Vec<_>>(),
        &NoFaults,
    )
    .unwrap();
    let leases = dohc_engine_collab::LeaseRegistry::new();
    let a_key = dohc_engine_collab::DocKey::new("ws", "main", "a-held-object").unwrap();
    let b_key = dohc_engine_collab::DocKey::new("ws", "main", "b-released-object").unwrap();
    let _held = leases.acquire(&a_key).unwrap();
    let b_lease = leases.acquire(&b_key).unwrap();
    drop(b_lease);
    let pages = (1..=2).map(|seq| {
        let mut op = version_create_with_shipped_snapshots(
            "b-released",
            &format!("b-version-{seq}"),
            Vec::new(),
        );
        op.origin_seq = seq;
        (
            seq - 1,
            PullResponse {
                ops: vec![op],
                next_cursor: seq,
                has_more: false,
            },
        )
    });
    let client = RelaySyncClient::new(PagedRelay::new(pages));
    for pass in 1..=2 {
        let result = client
            .pull_chat_workspace(
                &mut engine,
                &mut dohc_engine_collab::WriterDocCache::new(),
                "ws",
                &NoFaults,
                &leases,
                1_000 + pass,
            )
            .unwrap();
        let SyncPassOutcome::Complete {
            pending_cursor: Some(cursor),
            ..
        } = result
        else {
            panic!("completed pass");
        };
        client
            .commit_pull_cursor(
                &mut engine,
                "ws",
                &cursor,
                &NoFaults,
                &crate::NoLiveLeases,
                1_000 + pass,
            )
            .unwrap();
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", "a-held").unwrap(),
            -1
        );
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", "b-released").unwrap(),
            if pass == 1 { -1 } else { 2 },
            "fetched suffixes must not consume the released origin's replay turn"
        );
    }
    assert!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "b-released.md")
            .unwrap()
            .is_some()
    );
}

#[test]
fn deferred_relay_suffixes_and_new_origins_keep_their_place_in_the_cycle() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let identity = read_sync_identity(&engine, "ws").unwrap().unwrap();
    let op = |origin: &str, seq: i64| {
        let mut op =
            version_create_with_shipped_snapshots(origin, &format!("{origin}-{seq}"), Vec::new());
        op.origin_seq = seq;
        op
    };
    let mut retained = Vec::new();
    for origin in ["a-held", "b-held"] {
        retained.extend((0..500).map(|seq| op(origin, seq)));
    }
    retained.push(op("c-released", 0));
    crate::deferred::retain(
        &mut engine,
        &identity,
        &retained.iter().collect::<Vec<_>>(),
        &NoFaults,
    )
    .unwrap();
    for (turn, expected) in ["a-held", "b-held", "c-released"].into_iter().enumerate() {
        let (queued, _) = crate::deferred::read(&engine, "ws", &identity).unwrap();
        assert_eq!(
            queued[0].origin_id, expected,
            "new suffixes and newly admitted origins cannot overtake an origin waiting for replay"
        );
        if expected == "c-released" {
            break;
        }
        let mut report = None;
        crate::deferred::claim_report(&mut engine, "ws", &queued, &[], &mut report, &NoFaults)
            .unwrap();
        let suffixes = [
            op("a-held", 500 + turn as i64),
            op("b-held", 500 + turn as i64),
            op(&format!("0-new-{turn}"), 0),
        ];
        crate::deferred::retain(
            &mut engine,
            &identity,
            &suffixes.iter().collect::<Vec<_>>(),
            &NoFaults,
        )
        .unwrap();
    }
}
