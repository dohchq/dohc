use super::*;
use dohc_engine_collab::WriterDocCache;
use dohc_engine_sync::*;
use std::sync::Mutex;
#[derive(Default)]
struct PerfRelay {
    refuse_oversized_proofs: bool,
    push_budget_limit: Option<usize>,
    pushes: Mutex<Vec<PushRequest>>,
    pull: Mutex<Option<PullResponse>>,
}
impl RelayTransport for PerfRelay {
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError> {
        self.pushes.lock().expect("push lock").push(req.clone());
        let mut settlement_refusals = Vec::new();
        if self.refuse_oversized_proofs
            && let Some(op) = req
                .ops
                .iter()
                .find(|op| op.payload.get("settlementReference").is_some())
        {
            if req.ops.len() > 1 {
                return Err(RelayError::SettlementProofBudget);
            }
            settlement_refusals.push(SettlementPublicationRefusal {
                origin_id: req.origin_id.clone(),
                origin_seq: op.origin_seq,
                moment_id: op.payload["momentId"].as_str().unwrap().into(),
                settlement_id: op.payload["settlementReference"]["record"]["settlementId"]
                    .as_str()
                    .unwrap()
                    .into(),
                reason: "authorship-mismatch".into(),
            });
        }
        if self
            .push_budget_limit
            .is_some_and(|limit| req.ops.len() > limit)
        {
            return Err(RelayError::SettlementProofBudget);
        }
        let accepted = req.ops.len();
        let current_max_origin_seq = req.ops.last().map_or(req.after_seq, |op| op.origin_seq);
        Ok(PushResponse {
            release_refusals: Vec::new(),
            settlement_refusals,
            accepted,
            inserted: accepted,
            skipped: 0,
            current_max_origin_seq,
        })
    }
    fn pull(&self, _req: PullRequest) -> Result<PullResponse, RelayError> {
        let page = self
            .pull
            .lock()
            .expect("pull lock")
            .clone()
            .ok_or(RelayError::InvalidResponse)?;

        Ok(page)
    }
    fn lookup_log_coordinate(
        &self,
        _req: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn probe(&self, _req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        Ok(ProbeResponse { has_content: false })
    }
    fn claim_workspace(&self, _req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        Ok(ClaimResponse)
    }
    fn rotate_epoch(&self, _req: EpochRequest) -> Result<EpochResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn blobs_have(&self, _req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        Ok(BlobHaveResponse {
            missing: Vec::new(),
        })
    }
    fn upload_blob(&self, _req: BlobUploadRequest) -> Result<(), RelayError> {
        Ok(())
    }
    fn download_blobs(
        &self,
        req: BlobDownloadBatchRequest,
    ) -> Result<BlobDownloadBatchResponse, RelayError> {
        Ok(BlobDownloadBatchResponse {
            results: req
                .blobs
                .iter()
                .map(|_| Err(RelayError::BlobMissing))
                .collect(),
        })
    }
    fn upload_key_envelope(
        &self,
        _req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        Ok(KeyEnvelopeResponse {
            etag: "etag".to_owned(),
        })
    }
    fn download_key_envelope(
        &self,
        _req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        Err(RelayError::KeyEnvelopeMissing)
    }
    fn shared_channel_pull(
        &self,
        _req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_log_push(&self, _req: ShareLogPushRequest) -> Result<PushResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_view_pull(&self, _req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_blob(&self, _req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        Err(RelayError::ShareUnavailable)
    }

    fn share_blob_upload(&self, _req: ShareBlobUploadRequest) -> Result<(), RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn share_proposal_submit(
        &self,
        _req: ShareProposalSubmitRequest,
    ) -> Result<ShareProposalSubmitResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn share_collection_write(
        &self,
        _req: ShareCollectionWriteRequest,
    ) -> Result<ShareCollectionWriteResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
}

#[tokio::test]
#[ignore = "manual paired release performance measurement"]
async fn ordinary_append_settle_push_pull() {
    let size: usize = std::env::var("DOHC_DRAIN2B_PERF_SIZE")
        .unwrap()
        .parse()
        .unwrap();
    let mut f = Fixture::with_size(size);
    // This fresh fixture has no acknowledged coordinate yet. Sequence zero must be pushed.
    f.store
        .write_with(&NoFaults, |tx| {
            // The parent fixture's synthetic Collection has no schema file.
            // This workload measures an ordinary document.
            tx.execute("DELETE FROM collection_records", []).unwrap();
            tx.execute("DELETE FROM collections", []).unwrap();
            tx.execute("UPDATE sync_relay_push_state SET pushed_seq=-1", [])
                .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&f.db, 3).unwrap().actor;
    let update = append_fixed(&f.bytes, 200002, "ordinary local append").1;
    f.doc.apply(&update).unwrap();
    let start = std::time::Instant::now();
    f.record(&actor, update, "ordinary-perf", 20).await;
    let append = start.elapsed().as_nanos();
    let start = std::time::Instant::now();
    f.ordinary_settle(&actor).await.unwrap();
    let settle = start.elapsed().as_nanos();
    // Exercise the raw outbox append too: its durable session lookup changed in part 1.
    let outbox_fixture = Fixture::with_size(size);
    let outbox_actor = supervisor.open(&outbox_fixture.db, 3).unwrap().actor;
    let outbox_update = append_fixed(&outbox_fixture.bytes, 200004, "ordinary pending append").1;
    let start = std::time::Instant::now();
    outbox_actor
        .owner_ydoc_outbox_append(
            "workspace".into(),
            dohc_engine_collab::OwnerOutboxAppendInput {
                binding: outbox_fixture.binding.clone(),
                base_update: outbox_fixture.bytes.clone(),
                append_key: "perf-outbox".into(),
                update: outbox_update,
                limits: dohc_engine_collab::OwnerOutboxLimits {
                    max_pending_bytes: 8 * 1024 * 1024,
                    max_pending_age_ms: 100000,
                },
                created_at_ms: 20,
            },
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
    let outbox_append = start.elapsed().as_nanos();
    // A second ordinary document receives the peer delta. The first document
    // has an authenticated owner binding for the host settlement below.
    dohc_engine_domain::VersionedTextStore::new(&mut f.store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "peer-object".into(),
                path: "notes/peer.md".into(),
                text: f.doc.project(ContentKind::Richdoc).unwrap().content,
                moment_id: "peer-original".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 31,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let peer_base = f.doc.encode_full_state();
    let peer_claim = hex_sha256(&peer_base);
    dohc_engine_collab::claim_base(
        &mut f.store,
        &DocKey::new("workspace", "main", "peer-object").unwrap(),
        ContentKind::Richdoc,
        &peer_base,
        &NoFaults,
        32,
    )
    .unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET path='notes/peer.md' WHERE object_id='peer-object'",
                [],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
    let transport = PerfRelay::default();
    let peer = append_fixed(&f.doc.encode_full_state(), 200003, "ordinary peer append").1;
    let sha = f.store.put_binary_blob(&peer).unwrap();
    *transport.pull.lock().unwrap() = Some(PullResponse {
        ops: vec![ReplicationEnvelope {
            workspace_id: "workspace".into(),
            origin_id: "peer".into(),
            origin_seq: 0,
            relay_seq: Some(1),
            recorded_at_ms: 40,
            op_kind: "ydoc.update".into(),
            settlement_admission: None,
            admitted_author_snapshot: None,
            payload: serde_json::json!({"versionId":"main","objectId":"peer-object","path":"notes/peer.md","contentKind":"richdoc","lineageClaimId":peer_claim,"updateBlobSha256":sha}),
        }],
        next_cursor: 1,
        has_more: false,
    });
    let client = RelaySyncClient::new(transport);
    commit_relay_cursor(
        &mut f.store,
        "workspace",
        &RelayCursor {
            bootstrap_complete: true,
            cursor: 0,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            settlement_report_id: None,
        },
        &NoFaults,
        &NoLiveLeases,
        40,
    )
    .unwrap();
    let start = std::time::Instant::now();
    let outcome = client
        .push_workspace(
            &mut f.store,
            "workspace",
            &NoFaults,
            &NoLiveLeases,
            40,
            8 * 1024 * 1024,
        )
        .unwrap();
    let push = start.elapsed().as_nanos();
    assert!(
        matches!(outcome,SyncPassOutcome::Complete{pushed,..} if pushed>0),
        "{outcome:?}"
    );
    // Relay read-back assigns sequence numbers to the just-pushed base before the peer delta.
    let mut read_back = list_replication_ops(&f.store, "workspace", "origin", -1, 100).unwrap();
    for (index, op) in read_back.iter_mut().enumerate() {
        op.relay_seq = Some(index as i64 + 1);
    }
    let mut page = client.transport().pull.lock().unwrap().take().unwrap();
    let mut peer = page.ops.pop().unwrap();
    peer.relay_seq = Some(read_back.len() as i64 + 1);
    read_back.push(peer);
    // A host settlement ahead of the accepted cursor exercises pending enqueue,
    // including the immutable envelope retained by migration 56.
    let binding = f.binding.clone();
    let checkpoint = f.doc.encode_full_state();
    let (markdown_sha, before_updated, before_moment, before_origin): (String, i64, String, String) = f.store.read_with(|c| c.query_row("SELECT blob_sha256,updated_at_ms,latest_moment_id,metadata_origin FROM snapshots WHERE workspace_id='workspace' AND version_id='main' AND object_id='object'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))).unwrap();
    let path = binding.current_path.clone();
    let host = ReplicationEnvelope {
        workspace_id: "workspace".into(),
        origin_id: "host".into(),
        origin_seq: 0,
        relay_seq: Some(read_back.len() as i64 + 1),
        recorded_at_ms: 40,
        op_kind: "moment.append".into(),
        settlement_admission: None,
        admitted_author_snapshot: None,
        payload: serde_json::json!({
            "momentId":format!("moment-ydoc-{}", "b".repeat(64)),"versionId":"main","objectId":"object","objectCreatedAtMs":1,
            "path":path,"recordedAtMs":40,"operation":"write","payloadBeforeBlobSha256":markdown_sha,"payloadBeforePath":path,
            "payloadAfterBlobSha256":markdown_sha,"payloadAfterPath":path,"metadata":{"origin":"sync"},
            "beforePresent":"present","beforeObjectId":"object","beforeVersionId":"main","beforePath":path,
            "beforeBlobSha256":markdown_sha,"beforeUpdatedAtMs":before_updated,"beforeLatestMomentId":before_moment,"beforeMetadata":{"origin":"local-file"}
        }),
    };
    // Outbound replication maps the local ydoc origin to local-file.
    assert_eq!(before_origin, "ydoc");
    let moment_id = host.payload["momentId"].clone();
    f.store.write_with(&NoFaults, |tx| {
            let head = dohc_engine_collab::read_marker_in(tx, &DocKey::new("workspace","main","object").unwrap()).unwrap().unwrap().head_update_seq;
            let owner = dohc_engine_collab::owner_outbox::draft::ObservedOwnerBinding {
                binding:binding.clone(), relay_database_namespace:"relay".into(), revision:1, accepted_cursor:0,
                native_head_sequence:head, checkpoint_digest:hex_sha256(&checkpoint),
                limits:dohc_engine_collab::OwnerOutboxLimits {max_pending_bytes:8*1024*1024,max_pending_age_ms:100000},
            };
            dohc_engine_collab::owner_outbox::draft::install_observed_binding_in_tx(tx,"workspace",&owner,&checkpoint).map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            let record = serde_json::json!({"momentId":moment_id,"binding":binding,"relayDatabaseNamespace":"relay","terminalCursor":1,"acceptedStateBlobSha256":hex_sha256(&checkpoint)}).to_string();
            tx.execute("INSERT INTO live_audit_settlements VALUES('perf-audit','workspace',?1,?2,?3)",rusqlite::params![hex_sha256(record.as_bytes()),record,markdown_sha]).map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_,dohc_engine_storage::StorageError>(())
    }).unwrap();
    let host_envelope_bytes = serde_json::to_vec(&host).unwrap().len();
    read_back.push(host);
    let next_cursor = read_back.len() as i64;
    *client.transport().pull.lock().unwrap() = Some(PullResponse {
        ops: read_back,
        next_cursor,
        has_more: false,
    });
    let start = std::time::Instant::now();
    let outcome = client
        .pull_chat_workspace(
            &mut f.store,
            &mut WriterDocCache::new(),
            "workspace",
            &NoFaults,
            &NoLiveLeases,
            41,
        )
        .unwrap();
    let SyncPassOutcome::Complete {
        pending_cursor: Some(cursor),
        ..
    } = outcome
    else {
        panic!("{outcome:?}")
    };
    client
        .commit_pull_cursor(
            &mut f.store,
            "workspace",
            &cursor,
            &NoFaults,
            &NoLiveLeases,
            42,
        )
        .unwrap();
    let pull = start.elapsed().as_nanos();
    assert!(
        list_refusal_notices(&f.store, "workspace")
            .unwrap()
            .is_empty()
    );
    let peer_doc = f
        .store
        .read_with(|conn| {
            dohc_engine_collab::load_doc_in(
                conn,
                &DocKey::new("workspace", "main", "peer-object").unwrap(),
            )
        })
        .unwrap();
    assert!(
        peer_doc
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("ordinary peer append")
    );
    assert_eq!(
        f.store
            .table_row_count("owner_pending_settlements")
            .unwrap(),
        1
    );
    assert_eq!(f.store.table_row_count("owner_live_stops").unwrap(), 0);
    println!(
        "DRAIN2B_ORDINARY {}",
        serde_json::json!({"size":size,"hostEnvelopeBytes":host_envelope_bytes,"documentSha256":hex_sha256(f.text.as_bytes()),"nativeSha256":hex_sha256(&f.bytes),"append":append,"outboxAppend":outbox_append,"settle":settle,"push":push,"pull":pull})
    );
    supervisor.close_all().unwrap();
}

// Fixed wire client IDs keep the compared native state and update bytes identical.
pub(super) fn append_fixed(base: &[u8], client: u64, text: &str) -> (Vec<u8>, Vec<u8>) {
    use yrs::{
        ReadTxn, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim, updates::decoder::Decode,
    };
    let doc = yrs::Doc::with_options(yrs::Options {
        client_id: yrs::ClientID::new(client),
        offset_kind: yrs::OffsetKind::Utf16,
        skip_gc: true,
        ..Default::default()
    });
    let fragment = doc.get_or_insert_xml_fragment("body");
    let mut tx = doc.transact_mut();
    tx.apply_update(yrs::Update::decode_v1(base).unwrap())
        .unwrap();
    let vector = tx.state_vector();
    let index = fragment.len(&tx);
    let el = fragment.insert(&mut tx, index, XmlElementPrelim::empty("paragraph"));
    el.insert(&mut tx, 0, XmlTextPrelim::new(text));
    (
        tx.encode_state_as_update_v1(&yrs::StateVector::default()),
        tx.encode_state_as_update_v1(&vector),
    )
}
