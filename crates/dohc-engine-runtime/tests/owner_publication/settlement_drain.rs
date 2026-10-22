//! The owner settlement drain through the actor, its queue built by real
//! owner-settlement admission.

use super::*;
use dohc_engine_collab::owner_outbox::accepted::{OwnerAcceptedFrameInput, apply_frame_in_tx};
use dohc_engine_collab::owner_outbox::draft::{
    ObservedOwnerBinding, install_observed_binding_in_tx,
};
use dohc_engine_domain::{VersionedTextStore, WriteText};

const RECORD_PATH: &str = "tasks/record.md";
const OWNER_PATH: &str = "notes/owner.md";

/// A document whose owner this store observes: the owner's settlement at
/// accepted cursor 1, and the frame that brings the store to it.
struct Observed {
    binding: dohc_engine_collab::LiveObjectBinding,
    native_head_sequence: i64,
    frame: Vec<u8>,
    settled: String,
}

/// A store observing the owners of two documents, each with a settlement
/// admitted while its accepted cursor was 0 and ready once the owner's frame
/// reached cursor 1. In drain order: the record's settlement, which changes
/// a Collection field the store indexed after that frame, and the owner
/// document's, whose lineage a capture released without adopting, so its
/// decision waits for validation. Fields drop in order.
struct Drain {
    actor: ActorHandle,
    supervisor: WorkspaceSupervisor,
    store: EngineStore,
    root: ScratchDir,
}

fn write_text(store: &mut EngineStore, object: &str, path: &str, text: &str) {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: object.into(),
                path: path.into(),
                text: text.into(),
                moment_id: format!("moment-{object}"),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
}

/// Observe the owner of `object` at `path`, its Y.Doc `base`, and prepare
/// the frame `change` makes.
fn observe(
    store: &mut EngineStore,
    object: &str,
    path: &str,
    base: &Ydoc,
    change: impl FnOnce(&Ydoc),
) -> Observed {
    write_text(
        store,
        object,
        path,
        &base.project(ContentKind::Richdoc).unwrap().content,
    );
    let key = DocKey::new("workspace", "main", object).unwrap();
    let bytes = base.encode_full_state();
    dohc_engine_collab::claim_base(store, &key, ContentKind::Richdoc, &bytes, &NoFaults, 2)
        .unwrap();
    execute(
        store,
        &format!("UPDATE ydoc_docs SET path='{path}' WHERE object_id='{object}'"),
    );
    let checkpoint = store
        .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
        .unwrap()
        .encode_full_state();
    let native_head_sequence = store
        .read_with(|conn| dohc_engine_collab::read_marker_in(conn, &key))
        .unwrap()
        .unwrap()
        .head_update_seq;
    let binding = dohc_engine_collab::LiveObjectBinding {
        workspace_id: "workspace".into(),
        main_version_id: "main".into(),
        object_id: object.into(),
        lineage_claim_id: hex_sha256(&bytes),
        current_path: path.into(),
        selector_paths: vec![path.into()],
        restore_fence_generation: 0,
    };
    store
        .write_with(&NoFaults, |tx| {
            install_observed_binding_in_tx(
                tx,
                "workspace",
                &ObservedOwnerBinding {
                    binding: binding.clone(),
                    relay_database_namespace: "relay".into(),
                    revision: 1,
                    accepted_cursor: 0,
                    native_head_sequence,
                    checkpoint_digest: hex_sha256(&checkpoint),
                    limits: dohc_engine_collab::OwnerOutboxLimits {
                        max_pending_bytes: 1_000_000,
                        max_pending_age_ms: 60_000,
                    },
                },
                &checkpoint,
            )
        })
        .unwrap();
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    let vector = host.encode_state_vector();
    change(&host);
    Observed {
        binding,
        native_head_sequence,
        frame: host.diff(&vector).unwrap(),
        settled: host.project(ContentKind::Richdoc).unwrap().content,
    }
}

/// Admit the owner's settlement of `observed` from `origin`, as ordinary
/// sync brings it with its audited record at cursor 1.
fn admit(store: &mut EngineStore, observed: &Observed, origin: &str, digit: char) {
    let b = &observed.binding;
    let (before, latest, updated): (String, String, i64) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT blob_sha256,latest_moment_id,updated_at_ms FROM snapshots WHERE object_id=?1",
                [&b.object_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .unwrap();
    let moment = format!("moment-ydoc-{}", digit.to_string().repeat(64));
    let settled = hex_sha256(observed.settled.as_bytes());
    let record = serde_json::json!({
        "momentId": moment, "relayDatabaseNamespace": "relay", "binding": b,
        "previousCursor": 0, "terminalCursor": 1, "acceptedEventCount": 1,
        "acceptedIntervalDigest": "0".repeat(64)
    })
    .to_string();
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                rusqlite::params![settled, observed.settled.len() as i64, observed.settled],
            )?;
            conn.execute(
                "INSERT INTO live_audit_settlements (settlement_id,workspace_id,record_digest,record_json,markdown_digest)
                 VALUES (?1,'workspace',?2,?3,?4)",
                rusqlite::params![
                    format!("settlement-{origin}"),
                    hex_sha256(record.as_bytes()),
                    record,
                    settled
                ],
            )
        })
        .unwrap();
    let op = dohc_engine_sync::ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "workspace".into(),
        origin_id: origin.into(),
        origin_seq: 0,
        relay_seq: None,
        op_kind: "moment.append".into(),
        payload: serde_json::json!({
            "momentId": moment, "versionId": "main", "objectId": b.object_id,
            "path": b.current_path, "recordedAtMs": 2_000, "operation": "write",
            "payloadBeforeBlobSha256": before, "payloadBeforePath": b.current_path,
            "payloadAfterBlobSha256": settled, "payloadAfterPath": b.current_path,
            "metadata": {"origin": "sync"}, "beforePresent": "present",
            "beforeObjectId": b.object_id, "beforeVersionId": "main",
            "beforePath": b.current_path, "beforeBlobSha256": before,
            "beforeContentKind": "text", "beforeUpdatedAtMs": updated,
            "beforeLatestMomentId": latest
        }),
        recorded_at_ms: 2_000,
    };
    dohc_engine_sync::apply_replication_envelope(
        store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &op,
        &NoFaults,
        &dohc_engine_sync::NoLiveLeases,
    )
    .unwrap();
}

/// The owner's authenticated feed reaches cursor 1.
fn accept(store: &mut EngineStore, observed: &Observed) {
    store
        .write_with(&NoFaults, |tx| {
            apply_frame_in_tx(
                tx,
                "workspace",
                &OwnerAcceptedFrameInput {
                    binding: observed.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    expected_revision: 1,
                    expected_native_head_sequence: observed.native_head_sequence,
                    previous_accepted_cursor: 0,
                    journal_cursor: 1,
                    update_bytes: observed.frame.clone(),
                },
                11,
            )
        })
        .unwrap();
}

async fn drain() -> Drain {
    let root = ScratchDir::new().unwrap();
    let db = engine_db_path(&root).unwrap();
    let mut store = EngineStore::open(&db, 0).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    execute(&mut store, "INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES ('workspace','origin','epoch','stream',1);
        INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES ('workspace','origin',0);
        INSERT INTO sync_relay_cursors (workspace_id,cursor,replication_epoch,stream_identity) VALUES ('workspace','1','epoch','stream')");
    let record = Ydoc::wire();
    record.apply(&owner_source_base()).unwrap();
    record
        .frontmatter_set("id", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa")
        .unwrap();
    record.frontmatter_set("status", "open").unwrap();
    let record = observe(&mut store, "record", RECORD_PATH, &record, |doc| {
        doc.frontmatter_set("status", "done").unwrap();
    });
    let owner = Ydoc::wire();
    owner.apply(&owner_source_base()).unwrap();
    let owner = observe(&mut store, "window", OWNER_PATH, &owner, |doc| {
        doc.richdoc_append_paragraph("Settled by the owner");
    });
    admit(&mut store, &record, "a-record", 'b');
    admit(&mut store, &owner, "b-owner", 'c');
    assert_eq!(settlement_queue(&store).len(), 2, "both wait for cursor 1");
    accept(&mut store, &record);
    accept(&mut store, &owner);
    // The record's Collection, indexed from its file as the frame left it.
    write_text(
        &mut store,
        "schema",
        "tasks/collection.yaml",
        "fields:\n  status:\n    type: text\n",
    );
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "workspace", "main")
        })
        .unwrap();
    let source = owner_source_base();
    let text = {
        let doc = Ydoc::wire();
        doc.apply(&source).unwrap();
        doc.project(ContentKind::Richdoc).unwrap().content
    };
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO live_owner_activations (relay_database_namespace,activation_id,
                   workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,
                   source_moment_id,source_digest,source_byte_length,host_coordinate_json,
                   released_at_ms,released_restore_generation,released_accepted_cursor,
                   released_boundary_json,carried_manifest_json)
                 VALUES ('relay','capture','workspace','main','window',?1,?2,'moment-window',?3,?4,'{}',20,0,1,'null','[]')",
                rusqlite::params![
                    owner.binding.lineage_claim_id,
                    serde_json::to_string(&owner.binding).unwrap(),
                    hex_sha256(text.as_bytes()),
                    text.len() as i64
                ],
            )
        })
        .unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    Drain {
        actor,
        supervisor,
        store,
        root,
    }
}

impl Drain {
    fn pull(
        &self,
        feed: &Arc<QuietFeed>,
        token: CancellationToken,
    ) -> tokio::task::JoinHandle<Answer> {
        let (actor, feed) = (self.actor.clone(), Arc::clone(feed));
        tokio::spawn(async move {
            actor
                .relay_through(
                    feed,
                    dohc_engine_runtime::RelayOperation::Pull {
                        workspace_id: "workspace".into(),
                        now_ms: 1_000_000,
                    },
                    token,
                )
                .await
        })
    }

    async fn commit(&self, feed: &Arc<QuietFeed>, cursor: &dohc_engine_sync::RelayCursor) {
        self.actor
            .relay_through(
                Arc::clone(feed),
                dohc_engine_runtime::RelayOperation::CommitCursor {
                    workspace_id: "workspace".into(),
                    cursor: cursor.clone(),
                    now_ms: 1_000_000,
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
    }

    /// The drain's first attempt committed the record's settlement, with its
    /// field change, under one report, and rolled back the owner document's.
    fn committed_prefix(&self) -> String {
        let queue = settlement_queue(&self.store);
        let report = queue[1].3.clone().expect("the record's report");
        assert_eq!(
            queue,
            [
                ("b-owner".into(), false, false, None),
                ("a-record".into(), true, true, Some(report.clone())),
            ]
        );
        let facts: Option<String> = self
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT record_facts_json FROM owner_pending_settlements WHERE origin_id='a-record'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert!(facts.is_some(), "the record's fact committed");
        report
    }

    async fn close(self) {
        self.supervisor.close_all().unwrap();
    }
}

/// A relay with nothing new to serve: a pull only drains what the store
/// queued. Its second page waits for `gate`, when there is one.
#[derive(Default)]
struct QuietFeed {
    pulls: std::sync::atomic::AtomicUsize,
    second: tokio::sync::Notify,
    gate: std::sync::Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

impl dohc_engine_sync::RelayTransport for QuietFeed {
    fn pull(
        &self,
        req: dohc_engine_sync::PullRequest,
    ) -> Result<dohc_engine_sync::PullResponse, dohc_engine_sync::RelayError> {
        if self.pulls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
            self.second.notify_one();
            if let Some(gate) = self.gate.lock().unwrap().take() {
                let _ = gate.recv();
            }
        }
        Ok(dohc_engine_sync::PullResponse {
            ops: Vec::new(),
            next_cursor: req.cursor,
            has_more: false,
        })
    }

    refused_relay_methods! {
        push(dohc_engine_sync::PushRequest) -> dohc_engine_sync::PushResponse;
        pull_hosted(dohc_engine_sync::HostedPullRequest) -> dohc_engine_sync::HostedPullResponse;
        probe(dohc_engine_sync::ProbeRequest) -> dohc_engine_sync::ProbeResponse;
        claim_workspace(dohc_engine_sync::ClaimRequest) -> dohc_engine_sync::ClaimResponse;
        rotate_epoch(dohc_engine_sync::EpochRequest) -> dohc_engine_sync::EpochResponse;
        blobs_have(dohc_engine_sync::BlobHaveRequest) -> dohc_engine_sync::BlobHaveResponse;
        upload_blob(dohc_engine_sync::BlobUploadRequest) -> ();
        download_blobs(dohc_engine_sync::BlobDownloadBatchRequest) -> dohc_engine_sync::BlobDownloadBatchResponse;
        lookup_log_coordinate(dohc_engine_sync::LogCoordinateRequest) -> dohc_engine_sync::LogCoordinateResponse;
        upload_key_envelope(dohc_engine_sync::KeyEnvelopeRequest) -> dohc_engine_sync::KeyEnvelopeResponse;
        download_key_envelope(dohc_engine_sync::KeyEnvelopeDownloadRequest) -> dohc_engine_sync::KeyEnvelopeDownloadResponse;
        shared_channel_pull(dohc_engine_sync::SharedChannelRequest) -> dohc_engine_sync::SharedChannelResponse;
        share_log_push(dohc_engine_sync::ShareLogPushRequest) -> dohc_engine_sync::PushResponse;
        share_view_pull(dohc_engine_sync::ShareViewRequest) -> dohc_engine_sync::ShareViewResponse;
        share_blob(dohc_engine_sync::ShareBlobRequest) -> dohc_engine_sync::BlobDownloadResponse;
        share_blob_upload(dohc_engine_sync::ShareBlobUploadRequest) -> ();
        share_proposal_submit(dohc_engine_sync::ShareProposalSubmitRequest) -> dohc_engine_sync::ShareProposalSubmitResponse;
        share_collection_write(dohc_engine_sync::ShareCollectionWriteRequest) -> dohc_engine_sync::ShareCollectionWriteResponse;
    }
}

/// A field change of a fact: its field, before and after.
type FieldChange = (String, Option<String>, Option<String>);

/// What a completed pull reports: its cursor, the paths it changed and the
/// field changes of its facts.
type Reported = (dohc_engine_sync::RelayCursor, Vec<String>, Vec<FieldChange>);

fn reported(answer: Answer) -> Reported {
    let dohc_engine_runtime::RelayOperationOutcome::Sync(
        dohc_engine_sync::SyncPassOutcome::Complete {
            pending_cursor: Some(cursor),
            changed_paths,
            record_facts,
            ..
        },
    ) = answer.unwrap()
    else {
        panic!("a completed pass");
    };
    let mut paths: Vec<String> = changed_paths
        .into_iter()
        .map(|change| change.path)
        .collect();
    paths.sort();
    let fields = record_facts
        .into_iter()
        .flat_map(|facts| facts.fields)
        .map(|field| (field.field_name, field.previous_json, field.next_json))
        .collect();
    (cursor, paths, fields)
}

/// Each change and fact the drain owes, once.
fn owed() -> (Vec<String>, Vec<FieldChange>) {
    (
        vec![OWNER_PATH.into(), RECORD_PATH.into()],
        vec![(
            "status".into(),
            Some("\"open\"".into()),
            Some("\"done\"".into()),
        )],
    )
}

/// Sol's review of round 4b2i-1a-2j, finding 2, through the actor and real
/// admission: the drain applies the record's settlement with its field
/// change and commits it under its report before the owner document's
/// decision waits. The request stays outstanding; once validation completes
/// it goes on in the same report, which names each change and fact once.
/// The rows stay queued until a cursor naming that report commits: one
/// naming another releases nothing.
#[tokio::test]
async fn a_waiting_drain_goes_on_in_its_report_through_real_admission() {
    let d = drain().await;
    let feed = Arc::new(QuietFeed::default());
    let tails = d.actor.released_tails();
    tails.pause_validation();
    let mut request = d.pull(&feed, CancellationToken::new());
    held_validation(&tails, &mut request).await;
    let report = d.committed_prefix();
    d.actor
        .remote_changes_applied("workspace".into())
        .await
        .expect("the actor serves other work");
    assert!(!request.is_finished(), "the request is outstanding");
    tails.resume_validation();
    let (cursor, paths, fields) = reported(request.await.unwrap());
    assert_eq!(
        cursor.settlement_report_id.as_deref(),
        Some(report.as_str())
    );
    assert_eq!((paths, fields), owed());
    assert_eq!(feed.pulls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!((tails.validation_requests(), tails.validations()), (1, 1));
    let owned = Some(report.clone());
    assert_eq!(
        settlement_queue(&d.store),
        [
            ("a-record".into(), true, true, owned.clone()),
            ("b-owner".into(), true, true, owned),
        ]
    );
    let another = dohc_engine_sync::RelayCursor {
        settlement_report_id: Some("another".into()),
        ..cursor.clone()
    };
    d.commit(&feed, &another).await;
    assert_eq!(
        settlement_queue(&d.store).len(),
        2,
        "another report releases nothing"
    );
    d.commit(&feed, &cursor).await;
    assert!(settlement_queue(&d.store).is_empty());
    d.close().await;
}

/// Sol's review of round 4b2i-1a-2j, finding 2, cancellation and reopen: a
/// request cancelled while its drain waits leaves the committed prefix. The
/// store reopened, the next pull reclaims it under a report of its own with
/// its change and fact, once, and only a cursor naming that report releases
/// the rows.
#[tokio::test]
async fn a_cancelled_drain_leaves_its_prefix_to_the_next_pull_after_reopen() {
    let mut d = drain().await;
    let feed = Arc::new(QuietFeed::default());
    let tails = d.actor.released_tails();
    tails.pause_validation();
    let token = CancellationToken::new();
    let mut request = d.pull(&feed, token.clone());
    held_validation(&tails, &mut request).await;
    let abandoned = d.committed_prefix();
    token.cancel();
    assert!(matches!(
        request.await.unwrap(),
        Err(dohc_engine_runtime::RuntimeError::Cancelled)
    ));
    tails.resume_validation();
    d.supervisor.close_all().unwrap();
    d.supervisor = WorkspaceSupervisor::new();
    d.actor = d
        .supervisor
        .open(&engine_db_path(&d.root).unwrap(), 4)
        .unwrap()
        .actor;
    let (cursor, paths, fields) = reported(d.pull(&feed, CancellationToken::new()).await.unwrap());
    let reclaimed = cursor.settlement_report_id.clone().expect("its own report");
    assert_ne!(reclaimed, abandoned);
    assert_eq!((paths, fields), owed());
    let stale = dohc_engine_sync::RelayCursor {
        settlement_report_id: Some(abandoned),
        ..cursor.clone()
    };
    d.commit(&feed, &stale).await;
    assert_eq!(
        settlement_queue(&d.store).len(),
        2,
        "the abandoned report releases nothing"
    );
    d.commit(&feed, &cursor).await;
    assert!(settlement_queue(&d.store).is_empty());
    d.close().await;
}

/// Sol's review of round 4b2i-1a-2j, finding 1: one pull runs at a time on a
/// store, across its waits for validation. A second pull that arrives while
/// the first waits, with the record's settlement and its fact committed,
/// waits for it without fetching. The first goes on in its report and names
/// each change and fact once; its cursor commits before the second fetches,
/// and the second names none of them again.
#[tokio::test]
async fn a_second_pull_waits_for_the_first_across_its_validation() {
    let d = drain().await;
    let (release, gate) = std::sync::mpsc::channel();
    let feed = Arc::new(QuietFeed {
        gate: std::sync::Mutex::new(Some(gate)),
        ..QuietFeed::default()
    });
    let tails = d.actor.released_tails();
    tails.pause_validation();
    let mut first = d.pull(&feed, CancellationToken::new());
    held_validation(&tails, &mut first).await;
    let report = d.committed_prefix();
    let second = d.pull(&feed, CancellationToken::new());
    tokio::select! {
        biased;
        () = feed.second.notified() => panic!("the second pull fetched while the first waited"),
        () = d.actor.pull_waiting() => {}
    }
    assert!(!first.is_finished());
    tails.resume_validation();
    let (cursor, paths, fields) = reported(first.await.unwrap());
    assert_eq!(
        cursor.settlement_report_id.as_deref(),
        Some(report.as_str())
    );
    assert_eq!((paths, fields), owed());
    d.commit(&feed, &cursor).await;
    release.send(()).unwrap();
    let (_, paths, fields) = reported(second.await.unwrap());
    assert!(
        paths.is_empty() && fields.is_empty(),
        "{paths:?} {fields:?}"
    );
    assert_eq!(feed.pulls.load(std::sync::atomic::Ordering::SeqCst), 2);
    d.close().await;
}
