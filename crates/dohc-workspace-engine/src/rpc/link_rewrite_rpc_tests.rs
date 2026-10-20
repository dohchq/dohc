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
    transport
        .call(
            RequestContext::unbounded(),
            Request {
                id: 100,
                method: method.into(),
                workspace: Some(handle.clone()),
                deadline_ms: None,
                idempotency_key: Some(key.into()),
                progress: false,
                params: json!({"operationId":OP}),
            },
        )
        .await
        .unwrap()
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
            Ok(())
        })
        .unwrap();
    std::fs::write(root.join("old.md"), "target body").unwrap();
    drop(store);
    // Pause the normal watcher after its initial settled event. The RPC still
    // runs its real fence, reconcile, compensation, and placement paths.
    let probe = crate::capture_driver::CaptureApplyProbe::default();
    probe.pause_at_initial_settled();
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
    tokio::time::timeout(
        std::time::Duration::from_secs(120),
        probe.wait_at_initial_settled(),
    )
    .await
    .unwrap();
    let open = service.open(Some(&handle)).unwrap();
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
    let started = Instant::now();
    let forward = rpc(&transport, &handle, "history.rewriteLinks", "forward").await;
    let forward_ns = started.elapsed().as_nanos();
    assert_eq!(forward["documents"], sources);
    assert_eq!(forward["complete"], true);
    if later_edit {
        let rewritten = open
            .actor
            .run(|store, _| {
                let text = VersionedTextStore::new(store)
                    .read_text(WS, "main", "source-0000.md")?
                    .unwrap()
                    .text;
                let mut input = write(
                    "source-0000",
                    "source-0000.md",
                    &format!("{text} later typing"),
                    "later-edit",
                );
                input.now_ms = now_ms().unwrap() + 1;
                store.write_with(&NoFaults, |tx| -> Result<(), DomainError> {
                    let result = write_text_in_tx(tx, &input)?;
                    let preimage = dohc_engine_storage::Preimage::Present(
                        result.moment.before_blob_sha256.clone().unwrap(),
                    );
                    dohc_engine_domain::enqueue_write(tx, &result, preimage, "authored")?;
                    Ok(())
                })?;
                Ok(())
            })
            .await;
        rewritten.unwrap();
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
    let undone = rpc(&transport, &handle, "history.undo", "undo").await;
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
        .run(|store, _| {
            Ok(VersionedTextStore::new(store)
                .read_text(WS, "main", "source-0000.md")?
                .unwrap()
                .text)
        })
        .await
        .unwrap();
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
    // Rejoin the placement continuation through its serialization gate.
    let replay = open
        .actor
        .preflight_history_undo(WS.into(), OP.into(), "undo".into(), None)
        .await
        .unwrap()
        .unwrap();
    let placed = open
        .actor
        .history_undo_place(
            WS.into(),
            replay,
            root.to_path_buf(),
            Arc::new(service.self_writes.scoped(&open.root)),
            now_ms().unwrap(),
            |_| {},
        )
        .await;
    assert!(placed.materialized);
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
    probe.release_initial_settled();
    service.workspace_close(Some(handle)).await.unwrap();
}
