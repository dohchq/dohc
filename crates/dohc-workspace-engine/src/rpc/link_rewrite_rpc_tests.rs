#[path = "../../tests/common/mod.rs"]
mod common;

use super::*;
use dohc_engine_domain::{
    DomainError, RenameTextFile, VersionedTextStore, WriteText, write_text_in_tx,
};
use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::Request,
};
use dohc_engine_storage::{EngineStore, NoFaults};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::time::Instant;

const WS: &str = "rewrite-rpc";
const OP: &str = "dohc-operation:rpc-rename";
const BODY: &str = "[[old#part|label]] [[./old.md]] [old](old.md)";
fn write(object: &str, path: &str, text: &str, moment: &str) -> WriteText {
    WriteText {
        workspace_id: WS.into(),
        version_id: "main".into(),
        object_id: object.into(),
        path: path.into(),
        text: text.into(),
        moment_id: moment.into(),
        request_id: None,
        metadata_origin: "api".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 1,
    }
}
async fn rpc(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    method: &str,
    key: &str,
) -> Value {
    let request = Request {
        id: 100,
        method: method.into(),
        workspace: Some(handle.clone()),
        deadline_ms: None,
        idempotency_key: Some(key.into()),
        progress: false,
        params: json!({"operationId":OP}),
    };
    let mut attempts = 0;
    let result = common::retry_engine_store_busy(|| {
        attempts += 1;
        transport.call(RequestContext::unbounded(), request.clone())
    })
    .await;
    eprintln!(
        "LINK_REWRITE_RPC_RETRIES method={method} key={key} retries={}",
        attempts - 1
    );
    result
        .unwrap_or_else(|error| panic!("{method}: {error:?}"))
        .result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rpc_undo_keeps_unpublished_forward_and_later_edit_jobs_out_of_capture() {
    pending_rewrite_proof(1, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_thousand_sources_forward_and_undo_through_rpc() {
    pending_rewrite_proof(2000, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_hold_link_rename_reports_unchecked_and_undo_completes_safe_and_pristine_peers() {
    use dohc_engine_collab::{
        ContentKind, DocKey, LocalAppend, MarkerCreation, Regime, WriterDocCache, Ydoc,
    };
    let root = ScratchDir::new().unwrap();
    let binding = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    crate::root_binding::write_root_binding(&root, binding).unwrap();
    let db = engine_db_path(&root).unwrap();
    let nested = format!("- parent\n  - child\n\n{BODY}");
    let mut store = EngineStore::open(&db, 1).unwrap();
    store.bind_root_token(binding, &NoFaults).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .unwrap();
    let mut cache = WriterDocCache::new();
    for (object, source) in [
        ("held", nested.as_str()),
        ("pristine", nested.as_str()),
        ("safe", BODY),
    ] {
        let path = format!("{object}.md");
        VersionedTextStore::new(&mut store)
            .write_text(
                &write(object, &path, source, &format!("seed-{object}")),
                &NoFaults,
            )
            .unwrap();
        std::fs::write(root.join(&path), source).unwrap();
        if object != "safe" {
            let doc = Ydoc::wire();
            doc.richdoc_wikilinks_after_markdown_for_test("- parent\n  - child", BODY)
                .unwrap();
            doc.preserve_folded_markdown_source(source).unwrap();
            let projection = doc.project(ContentKind::Richdoc).unwrap().content;
            assert_eq!(
                doc.settled_markdown_source(&projection, || Ok::<_, ()>(Some(source.to_owned())))
                    .unwrap()
                    .as_deref(),
                Some(source),
                "{projection:?}"
            );
            if object == "held" {
                doc.richdoc_append_paragraph("Accepted edit awaiting a safe baseline");
            }
            dohc_engine_collab::record_local_update(
                &mut store,
                &mut cache,
                &DocKey::new(WS, "main", object).unwrap(),
                &doc.encode_full_state(),
                LocalAppend {
                    marker: Some(MarkerCreation {
                        path: Some(&path),
                        content_kind: ContentKind::Richdoc,
                        regime: Regime::LocalOnly,
                    }),
                    ..Default::default()
                },
                &NoFaults,
                2,
                |_, _, _| Ok(()),
            )
            .unwrap();
        }
    }
    VersionedTextStore::new(&mut store)
        .write_text(
            &write("target", "old.md", "target body", "seed-target"),
            &NoFaults,
        )
        .unwrap();
    std::fs::write(root.join("old.md"), "target body").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) \
            SELECT workspace_id,version_id,object_id,1 FROM snapshots WHERE workspace_id=?1 \
            ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1",
                [WS],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
    drop(store);
    let modified = std::fs::metadata(root.join("held.md"))
        .unwrap()
        .modified()
        .unwrap();
    let service = Arc::new(EngineService::with_capture_apply_probe_for_harness(
        crate::capture_driver::CaptureApplyProbe::default(),
    ));
    let transport = InProcessTransport::new(service.clone());
    let opened = service
        .workspace_open(
            &RequestContext::unbounded(),
            json!({
                "rootDir":root.to_string_lossy(),"workspaceId":WS,
            }),
        )
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    let _links_hold = open.actor.hold_link_drain();
    lock(&open.capture).as_ref().unwrap().request_shutdown();
    drop(open.capture_apply_gate.lock().await);
    open.actor
        .configure_reader_resolver(Arc::new(
            dohc_engine_collab::reader_resolver::ReaderResolver::new(Arc::new(
                dohc_engine_reader::Reader::new(Some(
                    crate::rpc::markdown_recovery::tests::witness_reader(&root, "witness-unsafe"),
                )),
            )),
        ))
        .await
        .unwrap();
    for path in ["held.md", "pristine.md"] {
        service
            .ydoc_open(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({"versionId":"main","path":path,"contentKind":"richdoc"}),
                101,
            )
            .await
            .unwrap();
    }
    std::fs::rename(root.join("old.md"), root.join("new.md")).unwrap();
    open.actor
        .versioned_text_rename(
            RenameTextFile {
                workspace_id: WS.into(),
                version_id: "main".into(),
                from_path: "old.md".into(),
                to_path: "new.md".into(),
                moment_id: "rename".into(),
                request_id: None,
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: Some(OP.into()),
                author_json: None,
                now_ms: 3,
            },
            open.root.clone(),
            Arc::new(service.self_writes.scoped(&open.root)),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let forward = rpc(&transport, &handle, "history.rewriteLinks", "forward-held").await;
    assert_eq!(forward["uncheckedCount"], 1, "{forward}");
    assert_eq!(forward["complete"], false);
    assert_eq!(forward["documents"], 2);
    assert_eq!(
        std::fs::read_to_string(root.join("held.md")).unwrap(),
        nested
    );
    assert_eq!(
        std::fs::metadata(root.join("held.md"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    let safe = open
        .actor
        .versioned_text_read(
            WS.into(),
            "main".into(),
            "safe.md".into(),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap()
        .text;
    let pristine = open
        .actor
        .versioned_text_read(
            WS.into(),
            "main".into(),
            "pristine.md".into(),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap()
        .text;
    assert!(safe.contains("new.md"));
    assert!(pristine.starts_with("- parent\n  - child\n"));
    assert!(pristine.contains("new.md"));
    {
        let reader = EngineStore::open_read_only(&db).unwrap();
        let held =
            dohc_engine_collab::load_persisted(&reader, &DocKey::new(WS, "main", "held").unwrap())
                .unwrap()
                .unwrap()
                .doc;
        assert!(
            held.project(ContentKind::Richdoc)
                .unwrap()
                .content
                .contains("Accepted edit awaiting a safe baseline")
        );
        let jobs: i64 = reader
            .read_with(|conn| {
                conn.query_row(
                    "SELECT count(*) FROM materialization_jobs WHERE target_path='held.md'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(jobs, 0);
        let owed = reader
            .read_with(|conn| dohc_engine_collab::markdown_write_obligations::pending_in(conn, WS))
            .unwrap();
        assert_eq!(owed.len(), 1);
        assert_eq!(
            owed[0].kind,
            dohc_engine_collab::markdown_write_obligations::Kind::LinkBaseline
        );
    }
    let undone = rpc(&transport, &handle, "history.undo", "undo-held").await;
    assert_eq!(undone["notRestored"], json!([]));
    let undone = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let result = rpc(&transport, &handle, "history.undo", "undo-held").await;
            if result["materialized"] == true {
                break result;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("committed Undo placement must finish");
    assert_eq!(undone["materialized"], true);
    for (path, expected) in [
        ("held.md", nested.as_str()),
        ("pristine.md", nested.as_str()),
        ("safe.md", BODY),
    ] {
        let head = open
            .actor
            .versioned_text_read(
                WS.into(),
                "main".into(),
                path.into(),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(head.text, expected);
        assert_eq!(std::fs::read_to_string(root.join(path)).unwrap(), expected);
    }
    assert_eq!(
        std::fs::metadata(root.join("held.md"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    service.workspace_close(Some(handle)).await.unwrap();
}

async fn pending_rewrite_proof(sources: usize, later_edit: bool) {
    let root = ScratchDir::new().unwrap();
    let binding = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    crate::root_binding::write_root_binding(&root, binding).unwrap();
    let db = engine_db_path(&root).unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    store.bind_root_token(binding, &NoFaults).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .unwrap();
    let files = if sources == 2000 { 4999 } else { sources };
    store
        .write_with(&NoFaults, |tx| -> Result<(), DomainError> {
            for i in 0..files {
                let path = format!("source-{i:04}.md");
                let body = if i < sources { BODY } else { "no links" };
                write_text_in_tx(
                    tx,
                    &write(&format!("source-{i:04}"), &path, body, &format!("seed-{i}")),
                )?;
                std::fs::write(root.join(path), body).unwrap();
            }
            write_text_in_tx(tx, &write("target", "old.md", "target body", "seed-target"))?;
            tx.execute("INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) SELECT workspace_id,version_id,object_id,1 FROM snapshots WHERE workspace_id=?1 AND version_id='main' ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1", [WS]).unwrap();
            Ok(())
        })
        .unwrap();
    std::fs::write(root.join("old.md"), "target body").unwrap();
    drop(store);
    // Keep the pending-job proof independent of background watcher scheduling.
    // The RPC still runs its real fence, reconcile, compensation, and placement.
    let probe = crate::capture_driver::CaptureApplyProbe::default();
    let service = Arc::new(EngineService::with_capture_apply_probe_for_harness(
        probe.clone(),
    ));
    let transport = InProcessTransport::new(service.clone());
    let opened = service
        .workspace_open(
            &RequestContext::unbounded(),
            json!({"rootDir":root.to_string_lossy(),"workspaceId":WS}),
        )
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    let _links_hold = open.actor.hold_link_drain();
    lock(&open.capture).as_ref().unwrap().request_shutdown();
    // Wait for the in-flight apply to leave before creating pending jobs.
    drop(open.capture_apply_gate.lock().await);
    std::fs::rename(root.join("old.md"), root.join("new.md")).unwrap();
    open.actor
        .versioned_text_rename(
            RenameTextFile {
                workspace_id: WS.into(),
                version_id: "main".into(),
                from_path: "old.md".into(),
                to_path: "new.md".into(),
                moment_id: "rename".into(),
                request_id: None,
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: Some(OP.into()),
                author_json: None,
                now_ms: 2,
            },
            open.root.clone(),
            Arc::new(service.self_writes.scoped(&open.root)),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    // Queue Undo ahead of the publisher to exercise the unpublished-debt branch.
    let capture = open.capture_apply_gate.clone().lock_owned().await;
    let undo = rpc(&transport, &handle, "history.undo", "undo");
    tokio::pin!(undo);
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(undo.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    let started = Instant::now();
    let forward = rpc(&transport, &handle, "history.rewriteLinks", "forward").await;
    let forward_ns = started.elapsed().as_nanos();
    assert_eq!(forward["documents"], sources);
    assert_eq!(forward["complete"], true);
    if later_edit {
        let text = open
            .actor
            .versioned_text_read(
                WS.into(),
                "main".into(),
                "source-0000.md".into(),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .unwrap()
            .text;
        let mut input = write(
            "source-0000",
            "source-0000.md",
            &format!("{text} later typing"),
            "later-edit",
        );
        input.now_ms = now_ms().unwrap() + 1;
        let crash = dohc_engine_testkit::ScriptedFaults::crash_at(
            dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck,
        );
        let result = open
            .actor
            .versioned_text_publish(
                input,
                open.root.clone(),
                dohc_engine_runtime::WriteConditions::default(),
                None,
                Arc::new(service.self_writes.scoped(&open.root)),
                crash.clone(),
                CancellationToken::new(),
            )
            .await;
        assert!(crash.fired());
        assert!(matches!(result, Err(RuntimeError::OperationCrashed)));
    }
    let jobs = open
        .actor
        .history_operation_pending_jobs(WS.into(), OP.into())
        .await
        .unwrap();
    assert_eq!(jobs.len(), sources + usize::from(later_edit));
    assert_eq!(
        std::fs::read_to_string(root.join("source-0000.md")).unwrap(),
        BODY
    );
    probe.pause_next_undo_placement();
    let started = Instant::now();
    drop(capture);
    let undone = undo.await;
    let undo_ns = started.elapsed().as_nanos();
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        probe.wait_until_undo_placement_paused(),
    )
    .await
    .unwrap();
    assert_eq!(undone["momentCount"], sources + 1);
    assert_eq!(undone["notRestored"], json!([]));
    let observer = EngineStore::open_read_only(&db).unwrap();
    let statuses: Vec<String> = observer.read_with(|conn| {
        let keys = serde_json::to_string(&jobs).unwrap();
        conn.prepare("SELECT status FROM materialization_jobs WHERE job_id IN (SELECT value FROM json_each(?1))")?
            .query_map([keys],|r|r.get(0))?.collect::<Result<_,_>>()
    }).unwrap();
    assert_eq!(
        statuses,
        vec!["cancelled"; jobs.len()],
        "RPC must cancel the whole unpublished chain without publishing or false conflicts"
    );
    let restored = open
        .actor
        .versioned_text_read(
            WS.into(),
            "main".into(),
            "source-0000.md".into(),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap()
        .text;
    assert_eq!(
        restored,
        format!("{BODY}{}", if later_edit { " later typing" } else { "" })
    );
    assert_eq!(
        std::fs::read_to_string(root.join("source-0000.md")).unwrap(),
        BODY,
        "final placement is paused; RPC never wrote the forward bytes"
    );
    probe.release_undo_placement();
    // A committed Undo can defer placement after a lock refusal.
    let placed = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            let result = rpc(&transport, &handle, "history.undo", "undo").await;
            if result["materialized"] == true {
                break result;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("committed Undo placement must finish");
    assert_eq!(placed["materialized"], true);
    assert_eq!(
        std::fs::read_to_string(root.join("source-0000.md")).unwrap(),
        restored
    );
    eprintln!("REWRITE_RPC sources={sources} forward_ns={forward_ns} undo_ns={undo_ns}");
    if let Ok(dir) = std::env::var("DOHC_LINK_REWRITE_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join(format!("rpc-{sources}.json")),
            json!({"sources":sources,"files":files+1,"forwardNs":forward_ns,"undoNs":undo_ns})
                .to_string(),
        )
        .unwrap();
    }
    service.workspace_close(Some(handle.clone())).await.unwrap();
}

#[path = "link_rewrite_open_rpc_tests.rs"]
mod open_documents;
