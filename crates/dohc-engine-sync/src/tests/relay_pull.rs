use super::*;

fn open_document_pull_fixture(later: i64, live: bool) -> (i64, i64, u128) {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1000, &NoFaults)
        .unwrap();
    let key = dohc_engine_collab::DocKey::new("ws", "main", "shared").unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "before");
    let sha = engine.put_binary_blob(&doc.encode_full_state()).unwrap();
    let base = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({"versionId":"main", "objectId":"shared", "path":"shared.md", "contentKind":"plaintext", "updateBlobSha256":sha, "lineageClaimId":sha, "isBaseState":true}),
    );
    apply_ydoc_envelope(
        &mut engine,
        &mut Default::default(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    let leases = dohc_engine_collab::LeaseRegistry::new();
    let _held = live.then(|| leases.acquire(&key).unwrap());
    if let Some(held) = &_held {
        held.bind_claim(base.payload["lineageClaimId"].as_str())
            .unwrap();
    }
    let bytes = doc.plaintext_insert(6, " settled");
    let delta_sha = engine.put_binary_blob(&bytes).unwrap();
    let mut delta = base.clone();
    delta.origin_seq = 1;
    delta.payload["updateBlobSha256"] = json!(delta_sha);
    delta.payload["isBaseState"] = json!(false);
    let text = "before settled";
    let text_sha = dohc_engine_storage::hex_sha256(text.as_bytes());
    let moment = |seq, object: String, path: String| {
        envelope(
            "peer",
            seq,
            "moment.append",
            json!({
                "momentId":if seq == 2 { format!("moment-ydoc-{}", "c".repeat(64)) } else { format!("settled-{seq}") }, "versionId":"main", "objectId":object, "objectCreatedAtMs":1,
                "path":path, "recordedAtMs":2000, "operation":"write", "payloadBeforeBlobSha256":null, "payloadBeforePath":null,
                "payloadAfterBlobSha256":text_sha, "payloadAfterPath":path, "payloadAfterContentKind":"text",
                "metadata":{"origin":"sync"}, "beforePresent":"absent"
            }),
        )
    };
    let mut ops = vec![delta, moment(2, "shared".into(), "shared.md".into())];
    ops.extend((0..later).map(|i| moment(i + 3, format!("other-{i}"), format!("other-{i}.md"))));
    let mut cursor = 0;
    let total = ops.len();
    let pages = ops
        .chunks(500)
        .map(|chunk| {
            let start = cursor;
            cursor += chunk.len() as i64;
            (
                start,
                PullResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: chunk.to_vec(),
                    next_cursor: cursor,
                    has_more: cursor < total as i64,
                },
            )
        })
        .collect::<Vec<_>>();
    let mut relay = PagedRelay::new(pages);
    relay.blobs.insert(text_sha, text.as_bytes().to_vec());
    let client = RelaySyncClient::new(relay);
    let start = std::time::Instant::now();
    let mut cache = Default::default();
    loop {
        let result = client
            .pull_chat_workspace(&mut engine, &mut cache, "ws", &NoFaults, &leases, 2100)
            .unwrap();
        let SyncPassOutcome::Complete {
            has_more,
            pending_cursor: Some(cursor),
            ..
        } = result
        else {
            panic!("{result:?}");
        };
        client
            .commit_pull_cursor(&mut engine, "ws", &cursor, &NoFaults, &leases, 2100)
            .unwrap();
        if !has_more {
            break;
        }
    }
    let micros = start.elapsed().as_micros();
    let deferred = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM relay_deferred_ops", [], |r| {
                r.get::<_, i64>(0)
            })
        })
        .unwrap();
    let others = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM snapshots WHERE object_id LIKE 'other-%'",
                [],
                |r| r.get::<_, i64>(0),
            )
        })
        .unwrap();
    if deferred == 0 {
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", "peer").unwrap(),
            later + 2
        );
    }
    (others, deferred, micros)
}

#[test]
fn open_document_pull_admits_settlement_and_same_origin_later_files() {
    let (others, deferred, _) = open_document_pull_fixture(2, true);
    assert_eq!((others, deferred), (2, 0));
}

#[test]
#[ignore = "manual before/after pull measurement"]
fn open_document_pull_measurement() {
    for live in [true, false] {
        for sample in 0..std::env::var("OPENHOLD_SAMPLES")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5)
        {
            let (others, deferred, micros) = open_document_pull_fixture(1000, live);
            println!(
                "OPENHOLD pull live={live} sample={sample} applied_later={others} deferred={deferred} micros={micros}"
            );
        }
    }
}

#[derive(Default)]
pub(super) struct ClaimRelay {
    relay: FakeRelay,
    pub(super) refusal: Mutex<Option<RelayError>>,
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
        assert_eq!(
            reopened
                .read_with(|conn| conn.query_row(
                    "SELECT claim_account_id FROM sync_identity WHERE workspace_id='ws'",
                    [],
                    |row| row.get::<_, String>(0),
                ))
                .unwrap(),
            "account-a"
        );
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
        assert_eq!(
            reopened
                .read_with(|conn| conn.query_row(
                    "SELECT claim_account_id FROM sync_identity WHERE workspace_id='ws'",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                ))
                .unwrap(),
            None
        );
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

struct FirstLeaseCheckLive(AtomicUsize);

impl LeaseProbe for FirstLeaseCheckLive {
    fn is_live(&self, _key: &dohc_engine_collab::DocKey) -> bool {
        self.0.fetch_add(1, Ordering::SeqCst) == 0
    }
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
fn ordinary_recording_claim_is_consumed_on_owner_echo_and_redelivery() {
    for (kind, authors) in [
        ("moment.append", None),
        (
            "moment.append",
            Some(json!([{"kind":"agent", "agentId":"writer"}])),
        ),
        ("ydoc.update", None),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        let mut payload = json!({"content": "original", "isBaseState": false,
            "actorOriginId": "owner", "attribution": {"actorKind": "human", "depth": 0},
            "authorContext": {"kind": "account", "accountId": "owner"}});
        if let Some(authors) = authors {
            payload["authors"] = authors;
        }
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            kind,
            &payload,
            2_000,
            &NoFaults,
        )
        .expect("journal recording claim");
        let mut stored = payload.clone();
        stored.as_object_mut().unwrap().remove("authorContext");
        let mut echo = envelope("local", 0, kind, stored);
        for _ in 0..2 {
            assert!(matches!(
                apply_envelope_with(
                    &mut engine,
                    &echo,
                    &NoFaults,
                    |_, _| -> Result<(), SyncError> { panic!("owner echo must not apply twice") }
                ),
                Ok(ApplyOutcome {
                    primary: ApplyDisposition::Skipped,
                    ..
                })
            ));
            assert!(
                crate::apply::is_acknowledged_envelope(&engine, &echo).expect("acknowledged echo")
            );
        }
        echo.payload["content"] = json!("changed");
        assert!(matches!(
            apply_envelope_with(&mut engine, &echo, &NoFaults, |_, _| Ok(())),
            Err(SyncError::CoordinateDiverged)
        ));
        let journal = list_replication_ops(&engine, "ws", "local", -1, 10).unwrap();
        assert_eq!(
            journal[0].payload, payload,
            "comparison does not rewrite the journal"
        );
        let mut changed_claim = envelope("local", 0, kind, payload.clone());
        changed_claim.payload["authorContext"]["accountId"] = json!("someone-else");
        assert!(matches!(
            apply_envelope_with(&mut engine, &changed_claim, &NoFaults, |_, _| Ok(())),
            Err(SyncError::CoordinateDiverged)
        ));
        crate::cursor::write_pushed_seq_with_refusals(
            &mut engine,
            "ws",
            "local",
            0,
            &[],
            &[],
            &[envelope("local", 0, kind, payload)],
            &NoFaults,
            &NoLiveLeases,
            2_001,
        )
        .expect("commit successful push");
        let stored = list_replication_ops(&engine, "ws", "local", -1, 10).unwrap();
        assert!(stored[0].payload.get("authorContext").is_none());
    }
}

#[test]
fn ordinary_recording_claim_preserves_live_agent_settlement_and_base_contexts() {
    for (kind, fields, context) in [
        (
            "ydoc.update",
            json!({}),
            json!({"kind":"account", "accountId":"owner"}),
        ),
        (
            "ydoc.update",
            json!({"isBaseState":true}),
            json!({"kind":"account", "accountId":"owner"}),
        ),
        (
            "ydoc.update",
            json!({"isBaseState":false, "actorOriginId":"owner", "attribution":{"actorKind":"human"}}),
            json!({"kind":"account", "accountId":"owner", "agent":{"agentId":"writer"}}),
        ),
        (
            "moment.append",
            json!({"settlementReference":{}}),
            json!({"kind":"account", "accountId":"owner"}),
        ),
        (
            "moment.append",
            json!({"authors":[{"kind":"agent", "agentId":"writer"}]}),
            json!({"kind":"account", "accountId":"owner", "agent":{"agentId":"writer"}}),
        ),
        (
            "moment.append",
            json!({"momentId":"unavailable-moment", "attributionUnavailable":{"settlementId":"unavailable", "reason":"unproven-hosted-authors"}}),
            json!({"kind":"account", "accountId":"owner"}),
        ),
        (
            "other",
            json!({}),
            json!({"kind":"account", "accountId":"owner"}),
        ),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        let mut original = envelope("peer", 0, kind, fields);
        original.payload["authorContext"] = context;
        apply_envelope_with(&mut engine, &original, &NoFaults, |_, _| Ok(())).unwrap();
        let mut changed = original.clone();
        changed
            .payload
            .as_object_mut()
            .unwrap()
            .remove("authorContext");
        assert!(
            matches!(
                apply_envelope_with(&mut engine, &changed, &NoFaults, |_, _| Ok(())),
                Err(SyncError::CoordinateDiverged)
            ),
            "{kind}: {}",
            original.payload
        );
    }
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
                settlement_admission: None,
                admitted_author_snapshot: None,
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
                work_references: Vec::new(),
                next_reference_after: None,
                reference_has_more: false,
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
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
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
            settlement_admission: None,
            admitted_author_snapshot: None,
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

pub(super) fn seed_base_repair_candidate(
    engine: &mut EngineStore,
    object_id: &str,
    origin_id: &str,
    origin_seq: i64,
) -> ReplicationEnvelope {
    let path = format!("notes/{object_id}.md");
    seed_text_head(engine, object_id, &path, "local base");
    let key = dohc_engine_collab::DocKey::new("ws", "main", object_id).expect("doc key");
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "local base");
    let base = doc.encode_full_state();
    let claim_id = match dohc_engine_collab::claim_base(
        engine,
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
        "path": &path,
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
                 ) VALUES ('ws',?1,?2,'ydoc.update',?3,1100,?4,'applied')",
                params![
                    origin_id,
                    origin_seq,
                    payload.to_string(),
                    i64::from(origin_id != "local")
                ],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_base_relay_candidates (
                     workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq
                 ) VALUES ('ws','main',?1,?2,?3,?4)",
                params![key.object_id, claim_id, origin_id, origin_seq],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed local pending coordinate");
    ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".to_owned(),
        origin_id: origin_id.to_owned(),
        origin_seq,
        op_kind: "ydoc.update".to_owned(),
        payload,
        recorded_at_ms: 1_100,
        relay_seq: Some(7),
    }
}

fn base_repair_state(engine: &EngineStore, object_id: &str) -> (Option<i64>, i64, i64) {
    engine
        .read_with(|conn| {
            let marker = conn.query_row(
                "SELECT base_relay_seq,base_relay_confirmed_absent FROM ydoc_docs
             WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [object_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let count = conn.query_row(
                "SELECT COUNT(*) FROM ydoc_base_relay_candidates
             WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [object_id],
                |row| row.get(0),
            )?;
            Ok::<_, rusqlite::Error>((marker.0, marker.1, count))
        })
        .expect("base repair state")
}

pub(super) fn empty_base_repair_relay() -> PagedRelay {
    PagedRelay::new([(
        0,
        PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops: Vec::new(),
            next_cursor: 0,
            has_more: false,
        },
    )])
}

fn pull_base_repair(client: &RelaySyncClient<PagedRelay>, engine: &mut EngineStore) {
    client
        .pull_chat_workspace(
            engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_200,
        )
        .expect("pull base repair");
}

fn add_base_candidate(engine: &mut EngineStore, op: &ReplicationEnvelope) {
    engine.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported,apply_disposition) VALUES ('ws',?1,?2,'ydoc.update',?3,?4,?5,'applied')", params![op.origin_id,op.origin_seq,op.payload.to_string(),op.recorded_at_ms,i64::from(op.origin_id != "local")]).map_err(SyncError::persist)?;
        tx.execute("INSERT INTO ydoc_base_relay_candidates (workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq) VALUES ('ws','main',?1,?2,?3,?4)", params![op.payload["objectId"].as_str().unwrap(),op.payload["lineageClaimId"].as_str().unwrap(),op.origin_id,op.origin_seq]).map_err(SyncError::persist)?;
        Ok::<_,SyncError>(())
    }).unwrap();
}

fn divergent_repair_base(base: &ReplicationEnvelope) -> (ReplicationEnvelope, Vec<u8>) {
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "divergent base");
    let bytes = doc.encode_full_state();
    let sha = dohc_engine_storage::hex_sha256(&bytes);
    let mut op = base.clone();
    op.origin_id = "divergent".into();
    op.origin_seq = 0;
    op.payload["lineageClaimId"] = json!(sha);
    op.payload["updateBlobSha256"] = json!(sha);
    (op, bytes)
}

#[test]
fn base_repair_held_push_lets_a_fetched_divergent_base_win_and_the_pull_continue() {
    for mixed_absent in [false, true] {
        let (_scratch, mut engine, observed, _checkpoint) = super::owner_publication::fixture();
        let local = seed_base_repair_candidate(&mut engine, "blocked", "local", 1);
        let owner = envelope(
            "local",
            0,
            "ydoc.update",
            json!({"versionId":"main","objectId":"owner","path":"owner.md","contentKind":"richdoc","lineageClaimId":observed.binding.lineage_claim_id,"updateBlobSha256":observed.binding.lineage_claim_id,"isBaseState":true}),
        );
        engine.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE replication_log SET op_kind='ydoc.update',payload_json=?1,recorded_at_ms=?2,apply_disposition='applied' WHERE workspace_id='ws' AND origin_id='local' AND origin_seq=0", params![owner.payload.to_string(),owner.recorded_at_ms]).map_err(SyncError::persist)?;
            tx.execute("UPDATE ydoc_owner_bindings SET binding_json=json_set(binding_json,'$.currentPath','private/owner.md','$.selectorPaths',json('[\"private/owner.md\"]'))",[]).map_err(SyncError::persist)?;
            // Origination stores the base's own coordinate on its marker.
            tx.execute("UPDATE ydoc_docs SET base_origin_id='local',base_origin_seq=1 WHERE object_id='blocked'",[]).map_err(SyncError::persist)?;
            Ok::<_,SyncError>(())
        }).unwrap();
        let (divergent, bytes) = divergent_repair_base(&local);
        let text = "an unrelated change";
        let text_sha = dohc_engine_storage::hex_sha256(text.as_bytes());
        let unrelated = envelope(
            "peer",
            0,
            "moment.append",
            json!({
                "momentId":"unrelated-0", "versionId":"main", "objectId":"elsewhere", "objectCreatedAtMs":1,
                "path":"elsewhere.md", "recordedAtMs":2000, "operation":"write", "payloadBeforeBlobSha256":null, "payloadBeforePath":null,
                "payloadAfterBlobSha256":text_sha, "payloadAfterPath":"elsewhere.md", "payloadAfterContentKind":"text",
                "metadata":{"origin":"sync"}, "beforePresent":"absent"
            }),
        );
        // The fixture numbers the page 119 and 120.
        let mut relay = PagedRelay::new([(
            0,
            PullResponse {
                work_references: Vec::new(),
                next_reference_after: None,
                reference_has_more: false,
                ops: vec![divergent.clone(), unrelated],
                next_cursor: 120,
                has_more: false,
            },
        )]);
        relay
            .blobs
            .insert(dohc_engine_storage::hex_sha256(&bytes), bytes);
        relay.blobs.insert(text_sha, text.as_bytes().to_vec());
        if mixed_absent {
            let mut peer = local.clone();
            peer.origin_id = "absent-peer".into();
            peer.origin_seq = 0;
            add_base_candidate(&mut engine, &peer);
            relay = relay.with_coordinate("absent-peer", 0, LogCoordinateResponse::Absent);
        }
        let client =
            RelaySyncClient::new(relay.with_coordinate("local", 1, LogCoordinateResponse::Absent));
        let pushed = client
            .push_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases, 1500, 1_000_000)
            .unwrap();
        assert!(matches!(
            pushed,
            SyncPassOutcome::Complete { pushed: 0, .. }
        ));
        assert!(client.transport().pushes.lock().unwrap().is_empty());
        let pulled = client
            .pull_chat_workspace(
                &mut engine,
                &mut dohc_engine_collab::WriterDocCache::new(),
                "ws",
                &NoFaults,
                &NoLiveLeases,
                1200,
            )
            .expect("a held push must not stop the pull");
        assert!(
            matches!(
                pulled,
                SyncPassOutcome::Complete {
                    applied: 2,
                    conflicts_opened: 1,
                    ..
                }
            ),
            "{pulled:?}"
        );
        // The probe ran after the page and found the local base unsent.
        assert_eq!(client.transport().pushes.lock().unwrap().len(), 1);
        let lineage: String = engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT lineage_claim_id FROM ydoc_docs WHERE object_id='blocked'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(
            lineage,
            divergent.payload["lineageClaimId"].as_str().unwrap()
        );
        assert_eq!(base_repair_state(&engine, "blocked"), (Some(119), 0, 0));
        let unrelated_heads: i64 = engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE object_id='elsewhere'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(unrelated_heads, 1);
        assert_eq!(read_pushed_seq(&engine, "ws", "local").unwrap(), -1);
    }
}

#[test]
fn base_repair_cloned_store_pull_keeps_cursor_and_next_push_conflicts() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let base = seed_base_repair_candidate(&mut engine, "clone", "local", 1);
    engine.write_with(&NoFaults, |tx| {
        for seq in [2, 3] {
            tx.execute("INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported,apply_disposition) VALUES ('ws','local',?1,'probe.suffix','{\"device\":\"B\"}',1000,0,'applied')", [seq]).map_err(SyncError::persist)?;
        }
        Ok::<_,SyncError>(())
    }).unwrap();
    let mut committed = base;
    committed.relay_seq = Some(100);
    let mut other_device = envelope("local", 2, "probe.suffix", json!({"device":"A"}));
    other_device.relay_seq = Some(101);
    let client = RelaySyncClient::new(
        empty_base_repair_relay()
            .with_coordinate("local", 1, LogCoordinateResponse::Present(committed))
            .with_coordinate("local", 2, LogCoordinateResponse::Present(other_device)),
    );
    pull_base_repair(&client, &mut engine);
    assert_eq!(read_pushed_seq(&engine, "ws", "local").unwrap(), -1);
    assert_eq!(base_repair_state(&engine, "clone"), (Some(100), 0, 0));
    assert_eq!(
        client
            .push_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases, 1300, 0)
            .unwrap_err(),
        RelayError::OriginDiverged
    );
    let pushes = client.transport().pushes.lock().unwrap();
    let batch = pushes
        .iter()
        .find(|request| !request.ops.is_empty())
        .unwrap();
    assert_eq!(*client.transport().push_conflicts.lock().unwrap(), 1);
    assert_eq!(batch.after_seq, -1);
    assert!(
        batch
            .ops
            .iter()
            .any(|op| op.origin_seq == 2 && op.payload["device"] == "B")
    );
    assert!(
        !client
            .transport()
            .coordinates
            .lock()
            .unwrap()
            .contains_key(&("local".into(), 3)),
        "conflicting batch must not append B's suffix"
    );
    assert_eq!(read_pushed_seq(&engine, "ws", "local").unwrap(), -1);
}
#[test]
fn base_repair_recovers_remote_commit_before_idempotent_repush() {
    let (_scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    seed_base_repair_candidate(&mut engine, "crash-pending", "local", 1);
    let client = RelaySyncClient::new(empty_base_repair_relay());
    let faults = ScriptedFaults::crash_at(FaultPoint::SyncAfterPushBeforeCursorPersist);
    assert_eq!(
        client
            .push_workspace(&mut engine, "ws", faults.as_ref(), &NoLiveLeases, 1_300, 0)
            .expect("push crash"),
        SyncPassOutcome::CrashedAfterRemoteCommit
    );
    drop(engine);
    let mut engine = EngineStore::open(&path, 1_400).expect("reopen");
    assert_eq!(read_pushed_seq(&engine, "ws", "local").unwrap(), -1);
    let original = {
        let coordinates = client.transport().coordinates.lock().unwrap();
        let LogCoordinateResponse::Present(op) = coordinates.get(&("local".to_owned(), 1)).unwrap()
        else {
            panic!("remote commit must exist")
        };
        assert_eq!(op.relay_seq, Some(101));
        op.clone()
    };
    pull_base_repair(&client, &mut engine);
    assert_eq!(
        base_repair_state(&engine, "crash-pending"),
        (Some(101), 0, 0)
    );
    assert_eq!(read_pushed_seq(&engine, "ws", "local").unwrap(), -1);
    assert_eq!(
        *client.transport().coordinate_lookups.lock().unwrap(),
        [("local".to_owned(), 1)]
    );
    assert_eq!(
        client
            .transport()
            .pushes
            .lock()
            .unwrap()
            .iter()
            .filter(|req| req.ops.is_empty())
            .count(),
        1
    );
    assert!(matches!(
        client
            .push_workspace(&mut engine, "ws", &NoFaults, &NoLiveLeases, 1_500, 0)
            .expect("idempotent repush"),
        SyncPassOutcome::Complete {
            pushed: 0,
            applied: 0,
            ..
        }
    ));
    assert_eq!(read_pushed_seq(&engine, "ws", "local").unwrap(), 1);
    assert_eq!(
        client
            .transport()
            .coordinates
            .lock()
            .unwrap()
            .get(&("local".to_owned(), 1)),
        Some(&LogCoordinateResponse::Present(original))
    );
    pull_base_repair(&client, &mut engine);
    assert_eq!(
        base_repair_state(&engine, "crash-pending"),
        (Some(101), 0, 0)
    );
    assert_eq!(
        client.transport().coordinate_lookups.lock().unwrap().len(),
        1
    );
}

#[test]
fn base_repair_still_confirms_absent_for_own_pushed_and_foreign_coordinates() {
    for origin in ["local", "peer"] {
        let (_scratch, _path, mut engine) = open_store();
        seed_identity(&mut engine);
        seed_replication_version(&mut engine, "main", "main");
        seed_base_repair_candidate(&mut engine, "absent", origin, 1);
        if origin == "local" {
            crate::cursor::write_pushed_seq(
                &mut engine,
                "ws",
                "local",
                1,
                &NoFaults,
                &NoLiveLeases,
                1_200,
            )
            .expect("acknowledged cursor");
        }
        let client = RelaySyncClient::new(empty_base_repair_relay().with_coordinate(
            origin,
            1,
            LogCoordinateResponse::Absent,
        ));
        pull_base_repair(&client, &mut engine);
        assert_eq!(base_repair_state(&engine, "absent"), (None, 1, 0));
        assert!(client.transport().pushes.lock().unwrap().is_empty());
        assert_eq!(
            *client.transport().coordinate_lookups.lock().unwrap(),
            [(origin.to_owned(), 1)]
        );
    }
}

fn mixed_base_group_repairs_present_or_absent(present: bool) {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let mut peer = seed_base_repair_candidate(&mut engine, "mixed", "local", 1);
    peer.origin_id = "a-peer".to_owned();
    peer.origin_seq = 0;
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_log (workspace_id,origin_id,origin_seq,
            op_kind,payload_json,recorded_at_ms,imported,apply_disposition)
            VALUES ('ws','a-peer',0,'ydoc.update',?1,1100,1,'applied')",
                [peer.payload.to_string()],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_base_relay_candidates
            (workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq)
            VALUES ('ws','main','mixed',?1,'a-peer',0)",
                [peer.payload["lineageClaimId"].as_str().unwrap()],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let client = RelaySyncClient::new(
        empty_base_repair_relay()
            .with_coordinate(
                "a-peer",
                0,
                if present {
                    LogCoordinateResponse::Present(peer)
                } else {
                    LogCoordinateResponse::Absent
                },
            )
            .with_coordinate("local", 1, LogCoordinateResponse::Absent),
    );
    let revision = engine
        .read_with(|conn| Ok::<_, rusqlite::Error>(conn.total_changes()))
        .unwrap();
    pull_base_repair(&client, &mut engine);
    assert_eq!(
        base_repair_state(&engine, "mixed"),
        if present {
            (Some(7), 0, 0)
        } else {
            (None, 0, 2)
        }
    );
    assert_eq!(
        *client.transport().coordinate_lookups.lock().unwrap(),
        [("a-peer".to_owned(), 0)]
    );
    assert_eq!(client.transport().pushes.lock().unwrap().len(), 1);
    let changes = engine
        .read_with(|conn| Ok::<_, rusqlite::Error>(conn.total_changes()))
        .unwrap();
    // Every pass writes its own ordinary pull token.
    assert_eq!(changes > revision + 1, present);
}

#[test]
fn base_repair_keeps_mixed_absent_group_pending() {
    mixed_base_group_repairs_present_or_absent(false);
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
            refuse_oversized_proofs: false,
            push_budget_limit: None,
            pushes: Mutex::new(Vec::new()),
            pull: Mutex::new(Some(PullResponse {
                work_references: Vec::new(),
                next_reference_after: None,
                reference_has_more: false,
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
            ..Default::default()
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
        refuse_oversized_proofs: false,
        push_budget_limit: None,
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops: vec![remote],
            next_cursor: 1,
            has_more: false,
        })),
        ..Default::default()
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
    assert!(matches!(
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
        TxnOutcome::Committed(ref commit) if commit.sharing_declined.is_empty()
    ));
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

    for op in ops.iter().rev() {
        apply_chat_envelope(&mut a, op, &NoFaults).expect("a reordered");
    }
    apply_chat_envelope(&mut a, &ops[1], &NoFaults).expect("a duplicate");

    apply_chat_envelope(&mut b, &ops[0], &NoFaults).expect("b prefix");
    drop(b);
    let mut b = EngineStore::open(&_path_b, 3_000).expect("b restart mid pull");
    apply_chat_envelope(&mut b, &ops[2], &NoFaults).expect("b after dropped middle");

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

#[test]
fn pull_rejects_op_for_foreign_workspace() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let foreign = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "other".to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "chat.channel.create".to_owned(),
        payload: json!({"channelId":"c1","name":"X","slug":"x","kind":"channel","createdAtMs":1}),
        recorded_at_ms: 2_000,
        relay_seq: Some(0),
    };
    let fake = FakeRelay {
        refuse_oversized_proofs: false,
        push_budget_limit: None,
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops: vec![foreign],
            next_cursor: 1,
            has_more: false,
        })),
        ..Default::default()
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
    assert!(read_relay_cursor(&engine, "ws").expect("cursor").is_none());
}

#[test]
fn relay_pull_refuses_reserved_case_variants() {
    for name in [
        ".DOHC",
        ".Dohc",
        ".dohc",
        ".do‍hc",
        ".GIT",
        "NODE_MODULES",
        "GIT~1",
        "NODE_M~1",
        "DOHC~1",
        "my-dohc",
        ".ＤＯＨＣ",
    ] {
        let (_scratch, _path, mut engine) = open_store();
        seed_identity(&mut engine);
        VersionedTextStore::new(&mut engine)
            .ensure_main_version("ws", "main", 1_300, &NoFaults)
            .expect("main");
        engine.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO file_objects (workspace_id, object_id, created_at_ms) VALUES ('ws','reserved-target',1400)", []).map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        }).expect("object");
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.plaintext_insert(0, "peer content");
        let bytes = doc.encode_full_state();
        let sha = dohc_engine_storage::hex_sha256(&bytes);
        let path = format!("{name}/engine/injected.md");
        let op = envelope(
            "reserved-peer",
            0,
            "ydoc.update",
            json!({
                "versionId": "main", "objectId": "reserved-target", "path": path,
                "contentKind": "plaintext", "updateBlobSha256": sha,
                "lineageClaimId": sha, "isBaseState": true
            }),
        );
        let mut relay = PagedRelay::new([(
            0,
            PullResponse {
                work_references: Vec::new(),
                next_reference_after: None,
                reference_has_more: false,
                ops: vec![op],
                next_cursor: 1,
                has_more: false,
            },
        )]);
        relay.blobs.insert(sha, bytes);
        let outcome = RelaySyncClient::new(relay)
            .pull_chat_workspace(
                &mut engine,
                &mut dohc_engine_collab::WriterDocCache::new(),
                "ws",
                &NoFaults,
                &NoLiveLeases,
                2_000,
            )
            .expect("pull");
        let SyncPassOutcome::Complete {
            applied,
            refused,
            changed_paths,
            ..
        } = outcome
        else {
            panic!("incomplete pull: {outcome:?}");
        };
        if name == "my-dohc" || name == ".ＤＯＨＣ" {
            assert_eq!((applied, refused), (1, 0));
            assert_eq!(changed_paths.len(), 1);
        } else {
            assert_eq!((applied, refused), (0, 1), "{name}");
            assert!(changed_paths.is_empty(), "{name}");
            let jobs = engine
                .read_with(|conn| {
                    conn.query_row("SELECT count(*) FROM materialization_jobs", [], |row| {
                        row.get::<_, i64>(0)
                    })
                })
                .expect("jobs");
            assert_eq!(jobs, 0, "{name}");
        }
    }
}

#[test]
fn relay_pull_rejects_a_tampered_own_ydoc_echo() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_peers (workspace_id, origin_id, acked_seq) \
                 VALUES ('ws','local',0) \
                 ON CONFLICT(workspace_id,origin_id) DO UPDATE SET acked_seq=0",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed local frontier");
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws','own-echo-tamper',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("scaffolding");

    let local_doc = dohc_engine_collab::Ydoc::wire();
    local_doc.plaintext_insert(0, "local");
    let local_bytes = local_doc.encode_full_state();
    let local_sha = engine.put_binary_blob(&local_bytes).expect("local blob");
    let local = envelope(
        "local",
        1,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "own-echo-tamper",
            "path": "notes/own-echo-tamper.md",
            "contentKind": "plaintext",
            "updateBlobSha256": local_sha,
            "lineageClaimId": local_sha,
            "isBaseState": true
        }),
    );
    apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &local,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("seed durable local coordinate");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE replication_peers SET acked_seq=0 WHERE workspace_id='ws' AND origin_id='local'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("rewind acknowledgement for first-delivery proof");
    assert!(
        crate::apply::is_acknowledged_envelope(&engine, &local)
            .expect("first delivery exact durable row"),
        "the durable row matches at acked_seq + 1"
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &local,
            &NoFaults,
            &NoLiveLeases,
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Skipped,
            ..
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "local").unwrap(),
        1
    );

    let tampered_doc = dohc_engine_collab::Ydoc::wire();
    tampered_doc.plaintext_insert(0, "tampered");
    let tampered_bytes = tampered_doc.encode_full_state();
    let tampered_sha = engine
        .put_binary_blob(&tampered_bytes)
        .expect("tampered blob");
    let mut tampered = local.clone();
    tampered.payload["updateBlobSha256"] = json!(tampered_sha.clone());
    tampered.payload["lineageClaimId"] = json!(tampered_sha.clone());
    tampered.relay_seq = Some(2);

    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &tampered,
            &NoFaults,
            &NoLiveLeases,
        ),
        Err(SyncError::CoordinateDiverged)
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "local").expect("local ack after direct tamper"),
        1,
        "direct tampering must leave the acknowledgement unchanged"
    );

    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops: vec![tampered],
            next_cursor: 2,
            has_more: false,
        },
    )]);
    relay.blobs.insert(tampered_sha, tampered_bytes);
    let result = RelaySyncClient::new(relay).pull_chat_workspace(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        "ws",
        &NoFaults,
        &NoLiveLeases,
        2_000,
    );
    assert!(matches!(result, Err(RelayError::OriginDiverged)));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "local").expect("local ack"),
        1,
        "a changed payload at the acknowledged coordinate must not advance it"
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
                work_references: Vec::new(),
                next_reference_after: None,
                reference_has_more: false,
                ops: first_page,
                next_cursor: i64::try_from(crate::model::MAX_PULL_OPS_PER_PASS).expect("cursor"),
                has_more: true,
            },
        ),
        (
            i64::try_from(crate::model::MAX_PULL_OPS_PER_PASS).expect("cursor"),
            PullResponse {
                work_references: Vec::new(),
                next_reference_after: None,
                reference_has_more: false,
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
fn join_pull_journals_received_document_edits_without_originating_offline_bases() {
    assert_join_pull_conflicts_offline_edits(false, true);
}

fn assert_join_pull_conflicts_offline_edits(sparse: bool, edit_between_batches: bool) {
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
                        work_references: Vec::new(),
                        next_reference_after: None,
                        reference_has_more: false,
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
                work_references: Vec::new(),
                next_reference_after: None,
                reference_has_more: false,
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
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
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
    assert_eq!(
        texts,
        [("joining.md".to_owned(), "offline edit".to_owned())]
    );
    let (current, incoming, recoveries): (String, String, i64) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT c.text,i.text,(SELECT COUNT(*) FROM ydoc_recovery_decisions)
            FROM conflicts f JOIN blobs c ON c.sha256=f.current_blob_sha256
            JOIN blobs i ON i.sha256=f.incoming_blob_sha256 WHERE f.status='open'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .expect("offline edits are visible in a version conflict");
    assert_eq!(current, "offline edit");
    assert_eq!(incoming, "remote edit");
    assert_eq!(recoveries, 0);
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
    let pushes = client.transport().pushes.lock().expect("push calls");
    assert_eq!(pushes.len(), 1);
    assert!(
        pushes
            .iter()
            .all(|push| !push.origin_id.starts_with("shared:")),
        "an unfiltered origin scan sends the imported share row through the owner lane"
    );
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
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
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
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
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
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
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
fn persisted_relay_and_share_cursors_never_regress_within_the_same_stream() {
    let (_scratch, _path, mut engine) = open_store();
    let relay = |cursor| RelayCursor {
        bootstrap_complete: true,
        cursor,
        replication_epoch: "epoch".to_owned(),
        stream_identity: "stream".to_owned(),
        settlement_report_id: None,
        ordinary_pull: None,
    };
    assert!(matches!(
        commit_relay_cursor(&mut engine, "ws", &relay(10), &NoFaults, &crate::NoLiveLeases, 1_000),
        Ok(TxnOutcome::Committed(ref commit)) if commit.sharing_declined.is_empty()
    ));
    assert!(matches!(
        commit_relay_cursor(&mut engine, "ws", &relay(4), &NoFaults, &crate::NoLiveLeases, 1_000),
        Ok(TxnOutcome::Committed(ref commit)) if commit.sharing_declined.is_empty()
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
    // payload is not usable here: its payload deserialization fails
    // pre-savepoint and stays a hard error.)
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
        refuse_oversized_proofs: false,
        push_budget_limit: None,
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops: vec![refused, later],
            next_cursor: 2,
            has_more: false,
        })),
        ..Default::default()
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
        exported_before: None,
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
        refuse_oversized_proofs: false,
        push_budget_limit: None,
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops: vec![parent, child, same_origin_later, later],
            next_cursor: 4,
            has_more: false,
        })),
        ..Default::default()
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
        refuse_oversized_proofs: false,
        push_budget_limit: None,
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
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
        ..Default::default()
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
        survivors, pending_before_commit,
        "a workspace-wide cursor sweep destroys this unread drain refusal"
    );

    let second_client = RelaySyncClient::new(FakeRelay {
        refuse_oversized_proofs: false,
        push_budget_limit: None,
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
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
        ..Default::default()
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
        refusals
            .into_iter()
            .filter(|row| row.origin_id == "post-pull-drain-peer")
            .collect::<Vec<_>>(),
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
        remaining, 2,
        "cursor commit retains both unresolved refusals"
    );
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

/// `Binary` and `Ydoc` share `binary_blobs`. Once a Y.Doc base over the
/// captured-file cap has hydrated legitimately, a later `moment.append`
/// naming the same digest as `binary` must not be reported already-satisfied:
/// that would skip `hydrate_blob_content`, the only place
/// `MAX_CAPTURE_BINARY_FILE_BYTES` is enforced. `require_binary_blob` applies
/// no ceiling, so an authorized peer could materialize a 20 MiB Y.Doc payload
/// as an oversized captured file.
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
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
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
        exported_before: None,
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
                work_references: Vec::new(),
                next_reference_after: None,
                reference_has_more: false,
                ops: page,
                next_cursor: 500,
                has_more: true,
            },
        ),
        (
            500,
            PullResponse {
                work_references: Vec::new(),
                next_reference_after: None,
                reference_has_more: false,
                ops: vec![later],
                next_cursor: 501,
                has_more: false,
            },
        ),
        (
            501,
            PullResponse {
                work_references: Vec::new(),
                next_reference_after: None,
                reference_has_more: false,
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
    crate::deferred::retain(&mut engine, &identity, None, &[&first], &NoFaults).unwrap();
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "held").unwrap(),
        -1
    );
    let mut divergent = first.clone();
    divergent.recorded_at_ms += 1;
    assert!(crate::deferred::check_redelivery(&engine, &[divergent]).is_err());
    let mut next = version_create_with_shipped_snapshots("held", "second", Vec::new());
    next.origin_seq = 2;
    assert!(crate::deferred::retain(&mut engine, &identity, None, &[&next], &NoFaults).is_err());
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
    let error = crate::deferred::retain(&mut engine, &identity, None, &[&next], &NoFaults)
        .expect_err("the work passes the limit");
    assert!(
        error.to_string().ends_with(
            "deferred relay work limit reached; close the conflicting editor to resume sync"
        ),
        "an origin no conflict holds keeps the editor words: {error}"
    );
    let (pending, _) = crate::deferred::read(&engine, "ws", &identity).unwrap();
    assert_eq!(
        pending,
        vec![first],
        "limit overflow rolls back the entire new retention"
    );
    assert!(read_relay_cursor(&engine, "ws").unwrap().is_none());
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
        None,
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
            None,
            &suffixes.iter().collect::<Vec<_>>(),
            &NoFaults,
        )
        .unwrap();
    }
}

#[test]
#[ignore = "manual partial-index insert measurement"]
fn ydoc_update_index_insert_measurement() {
    for local in [true, false] {
        for live in [true, false] {
            for indexed in [true, false, false, true] {
                let (_scratch, _path, mut store) = open_store();
                seed_identity(&mut store);
                VersionedTextStore::new(&mut store)
                    .ensure_main_version("ws", "main", 1, &NoFaults)
                    .unwrap();
                let key = dohc_engine_collab::DocKey::new("ws", "main", "measured").unwrap();
                let doc = dohc_engine_collab::Ydoc::wire();
                doc.plaintext_insert(0, "base");
                let sha = store.put_binary_blob(&doc.encode_full_state()).unwrap();
                let base = envelope(
                    "peer",
                    0,
                    "ydoc.update",
                    json!({"versionId":"main","objectId":"measured","path":"measured.md","contentKind":"plaintext","updateBlobSha256":sha,"lineageClaimId":sha,"isBaseState":true}),
                );
                let mut cache = Default::default();
                apply_ydoc_envelope(&mut store, &mut cache, &base, &NoFaults, &NoLiveLeases)
                    .unwrap();
                store.write_with(&NoFaults,|tx| {
                    for origin in ["history-a","history-b","history-c"] {
                        for seq in 0..3334 {
                            tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES ('ws',?1,?2,'ydoc.update',?3,1,1)",params![origin,seq,base.payload.to_string()]).unwrap();
                        }
                    }
                    if !indexed { tx.execute_batch("DROP INDEX replication_ydoc_origin_document").unwrap(); }
                    Ok::<_,SyncError>(())
                }).unwrap();
                let leases = dohc_engine_collab::LeaseRegistry::new();
                let held = live.then(|| leases.acquire(&key).unwrap());
                if let Some(held) = &held {
                    held.bind_claim(Some(&sha)).unwrap();
                }
                let mut samples = Vec::new();
                let mut inserts = Vec::new();
                for seq in 1..=110 {
                    let update = doc.plaintext_insert((seq + 3) as u32, "x");
                    let mut op = base.clone();
                    op.origin_seq = seq;
                    op.payload["isBaseState"] = json!(false);
                    // Hydration is outside the timed remote apply, as in a pull.
                    if !local {
                        op.payload["updateBlobSha256"] =
                            json!(store.put_binary_blob(&update).unwrap());
                    }
                    let started = std::time::Instant::now();
                    if local {
                        dohc_engine_collab::record_local_update(
                            &mut store,
                            &mut cache,
                            &key,
                            &update,
                            Default::default(),
                            &NoFaults,
                            seq + 2,
                            |tx, _, update_sha| {
                                op.payload["updateBlobSha256"] = json!(update_sha);
                                let journal = std::time::Instant::now();
                                crate::journal_local_op_in_tx(
                                    tx,
                                    "ws",
                                    "ydoc.update",
                                    &op.payload,
                                    seq + 2,
                                )
                                .unwrap();
                                inserts.push(journal.elapsed().as_nanos());
                                Ok(())
                            },
                        )
                        .unwrap();
                    } else {
                        apply_ydoc_envelope(&mut store, &mut cache, &op, &NoFaults, &leases)
                            .unwrap();
                    }
                    if seq > 10 {
                        samples.push(started.elapsed().as_nanos());
                    }
                }
                samples.sort_unstable();
                inserts = inserts.into_iter().skip(10).collect();
                inserts.sort_unstable();
                println!(
                    "OPENHOLD index local={local} live={live} indexed={indexed} n=100 p50_ns={} p95_ns={} journal_p50_ns={} journal_p95_ns={}",
                    samples[49],
                    samples[94],
                    inserts.get(49).copied().unwrap_or(0),
                    inserts.get(94).copied().unwrap_or(0)
                );
                // Isolate the journal insert from remote projection and local replay costs.
                let payload = base.payload.to_string();
                store.write_with(&NoFaults,|tx| {
                    let mut timings=Vec::new();
                    let mut statement=tx.prepare_cached("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported,apply_disposition) VALUES ('ws','insert-only',?1,'ydoc.update',?2,1,?3,'applied')").unwrap();
                    for seq in 0..1010 {
                        let start=std::time::Instant::now();
                        statement.execute(params![seq,payload,i64::from(!local)]).unwrap();
                        if seq>=10 { timings.push(start.elapsed().as_nanos()); }
                    }
                    timings.sort_unstable();
                    println!("OPENHOLD insert local={local} live={live} indexed={indexed} n=1000 p50_ns={} p95_ns={}",timings[499],timings[949]);
                    Ok::<_,SyncError>(())
                }).unwrap();
            }
        }
    }
}

/// A rename that changes only case reaches a pull as a delete of the old
/// spelling and a write of the new one. On a disk that ignores case the write
/// opens the old file, so the page must delete first: `Notes.md` sorts before
/// `notes.md`, and in path order the delete would remove the renamed file.
#[test]
fn relay_pull_puts_a_renames_delete_before_its_write() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main");
    let text = "body\n";
    let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
    let write = envelope(
        "peer",
        0,
        "moment.append",
        json!({
            "momentId": "write-notes", "versionId": "main", "objectId": "notes",
            "objectCreatedAtMs": 1, "path": "notes.md", "recordedAtMs": 2_000,
            "operation": "write", "payloadBeforeBlobSha256": null, "payloadBeforePath": null,
            "payloadAfterBlobSha256": sha, "payloadAfterPath": "notes.md",
            "payloadAfterContentKind": "text", "metadata": {"origin": "sync"},
            "beforePresent": "absent"
        }),
    );
    let rename = envelope(
        "peer",
        1,
        "moment.append",
        json!({
            "momentId": "rename-notes", "versionId": "main", "objectId": "notes",
            "objectCreatedAtMs": 1, "path": "notes.md", "recordedAtMs": 2_001,
            "operation": "rename", "payloadBeforeBlobSha256": sha,
            "payloadBeforePath": "notes.md", "payloadBeforeContentKind": "text",
            "payloadAfterBlobSha256": sha, "payloadAfterPath": "Notes.md",
            "payloadAfterContentKind": "text", "metadata": {"origin": "sync"},
            "beforePresent": "present", "beforeObjectId": "notes", "beforeVersionId": "main",
            "beforePath": "notes.md", "beforeBlobSha256": sha, "beforeContentKind": "text",
            "beforeUpdatedAtMs": 2_000, "beforeLatestMomentId": "write-notes",
            "beforeMetadata": {"origin": "sync"}
        }),
    );
    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops: vec![write, rename],
            next_cursor: 2,
            has_more: false,
        },
    )]);
    relay.blobs.insert(sha, text.as_bytes().to_vec());
    let outcome = RelaySyncClient::new(relay)
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            3_000,
        )
        .expect("pull");
    let SyncPassOutcome::Complete {
        applied,
        changed_paths,
        ..
    } = outcome
    else {
        panic!("incomplete pull: {outcome:?}");
    };
    assert_eq!(applied, 2);
    let page: Vec<_> = changed_paths
        .iter()
        .map(|change| (change.operation, change.path.as_str()))
        .collect();
    assert_eq!(page, [("delete", "notes.md"), ("write", "Notes.md")]);
}

#[test]
fn owner_pull_learns_one_mapping_page_and_keeps_its_tail_after_reopen() {
    use dohc_engine_domain::work_references::{
        WorkReferenceResolution, resolve_work_reference, work_reference_page_after,
    };
    let (_scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    let mapping = serde_json::from_value(json!({"reference":"R".repeat(43),"createdAtMs":1,
        "target":{"kind":"transactionalCollection","datasetId":"00000000-0000-4000-8000-000000000001","tableId":"00000000-0000-4000-8000-000000000002"}})).unwrap();
    let client = RelaySyncClient::new(PagedRelay::new([
        (
            0,
            PullResponse {
                work_references: vec![mapping],
                next_reference_after: Some("7".into()),
                reference_has_more: false,
                ops: vec![envelope(
                    "peer",
                    0,
                    "chat.channel.create",
                    json!({"channelId":"c","wireId":"w","name":"Team","slug":"team","kind":"channel","createdAtMs":1}),
                )],
                next_cursor: 1,
                has_more: true,
            },
        ),
        (
            1,
            PullResponse {
                work_references: vec![],
                next_reference_after: None,
                reference_has_more: false,
                ops: vec![envelope(
                    "peer",
                    1,
                    "chat.thread.create",
                    json!({"threadId":"t","channelWireId":"w","title":"Plans","createdAtMs":2}),
                )],
                next_cursor: 2,
                has_more: false,
            },
        ),
        (
            2,
            PullResponse {
                work_references: vec![],
                next_reference_after: Some("7".into()),
                reference_has_more: false,
                ops: vec![],
                next_cursor: 2,
                has_more: false,
            },
        ),
    ]));
    let result = client
        .pull_chat_workspace(
            &mut engine,
            &mut Default::default(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            3,
        )
        .unwrap();
    let SyncPassOutcome::Complete {
        has_more,
        pending_cursor: Some(cursor),
        ..
    } = result
    else {
        panic!("{result:?}");
    };
    assert!(!has_more);
    client
        .commit_pull_cursor(&mut engine, "ws", &cursor, &NoFaults, &NoLiveLeases, 3)
        .unwrap();
    assert!(matches!(
        resolve_work_reference(&engine, "ws", &"R".repeat(43)).unwrap(),
        WorkReferenceResolution::Found { .. }
    ));
    assert_eq!(
        *client.transport().reference_pulls.lock().unwrap(),
        vec![(None, true), (None, false)]
    );
    drop(engine);
    let mut engine = EngineStore::open(&path, 4).unwrap();
    assert_eq!(
        work_reference_page_after(&engine, "ws", "owner")
            .unwrap()
            .as_deref(),
        Some("7")
    );
    let result = client
        .pull_chat_workspace(
            &mut engine,
            &mut Default::default(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            5,
        )
        .unwrap();
    assert!(matches!(
        result,
        SyncPassOutcome::Complete {
            has_more: false,
            ..
        }
    ));
    assert_eq!(
        client.transport().reference_pulls.lock().unwrap().last(),
        Some(&(Some("7".into()), true))
    );
}
