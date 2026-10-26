use super::*;
use dohc_engine_domain::{RenameTextFile, WriteText};
use dohc_engine_runtime::{CancellationToken, NoFaults};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::sync::Arc;
use std::time::Duration;

const WS: &str = "rewrite-publication-recovery";
const OP: &str = "dohc-operation:publication-recovery";
const BEFORE: &str = "[[old#part|label]]";
const AFTER: &str = "[[new#part|label]]";

fn request(handle: WorkspaceHandle) -> dohc_engine_protocol::wire::Request {
    dohc_engine_protocol::wire::Request {
        id: 1,
        method: "history.undo".into(),
        workspace: Some(handle),
        deadline_ms: None,
        idempotency_key: Some("publication-undo".into()),
        progress: false,
        params: json!({"operationId":OP}),
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_rewrite_publication_recovers_at_open_and_undo_races_it_safely() {
    for restart in [true, false] {
        let scratch = ScratchDir::new().unwrap();
        let service = EngineService::new();
        let params = json!({"rootDir":scratch.path().to_string_lossy(),"workspaceId":WS});
        let opened = service
            .workspace_open(&RequestContext::unbounded(), params.clone())
            .await
            .unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let open = service.open(Some(&handle)).unwrap();
        let capture = open.capture_apply_gate.clone().lock_owned().await;
        let root = scratch.path().to_path_buf();
        let version = open
            .actor
            .ensure_main_version(WS.into(), 1, Arc::new(NoFaults), CancellationToken::new())
            .await
            .unwrap()
            .version_id;
        for (i, path) in ["old.md", "one.md", "two.md", "three.md"]
            .iter()
            .enumerate()
        {
            let text = if i == 0 { "target" } else { BEFORE };
            open.actor
                .versioned_text_write(
                    WriteText {
                        workspace_id: WS.into(),
                        version_id: version.clone(),
                        object_id: format!("object-{i}"),
                        path: (*path).into(),
                        text: text.into(),
                        moment_id: format!("seed-{i}"),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 1,
                    },
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            std::fs::write(root.join(path), text).unwrap();
        }
        std::fs::rename(root.join("old.md"), root.join("new.md")).unwrap();
        open.actor
            .versioned_text_rename(
                RenameTextFile {
                    workspace_id: WS.into(),
                    version_id: version,
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
                root,
                Arc::new(service.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let reply = open
            .actor
            .history_rewrite_links(
                WS.into(),
                OP.into(),
                "recovery-pass".into(),
                None,
                scratch.path().to_path_buf(),
                dohc_engine_collab::LeaseRegistry::new().scoped(scratch.path()),
                [open.capture_apply_gate.clone(), open.session_ops.clone()],
                Arc::new(NoFaults),
                (Arc::new(|_| false), Arc::new(|_| {})),
                Arc::new(()),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(reply["documents"], 3);
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("one.md")).unwrap(),
            BEFORE
        );
        if restart {
            // Lose the actor after its durable commit, before its publisher enters.
            service
                .supervisor
                .close(&engine_db_path(&scratch).unwrap())
                .unwrap();
            drop(capture);
            service.workspace_close(Some(handle)).await.unwrap();
            let opened = service
                .workspace_open(&RequestContext::unbounded(), params)
                .await
                .unwrap();
            let handle = serde_json::from_value(opened["workspace"].clone()).unwrap();
            for name in ["one.md", "two.md", "three.md"] {
                assert_eq!(
                    std::fs::read_to_string(scratch.path().join(name)).unwrap(),
                    AFTER
                );
            }
            service.workspace_close(Some(handle)).await.unwrap();
        } else {
            // The publisher and the real Undo fence queue behind the same capture gate.
            let ctx = RequestContext::unbounded();
            let undo = service.history_undo(&ctx, request(handle.clone()));
            tokio::pin!(undo);
            std::future::poll_fn(|cx| {
                assert!(std::future::Future::poll(undo.as_mut(), cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            drop(capture);
            assert_eq!(undo.await.unwrap()["momentCount"], 4);
            tokio::time::timeout(Duration::from_secs(120), async {
                loop {
                    if ["one.md", "two.md", "three.md"].iter().all(|name| {
                        std::fs::read_to_string(scratch.path().join(name))
                            .ok()
                            .as_deref()
                            == Some(BEFORE)
                    }) {
                        break;
                    }
                    open.actor.active_version_id(WS.into()).await.unwrap();
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("Undo's production publisher must restore every file");
            assert_eq!(
                std::fs::read_to_string(scratch.path().join("old.md")).unwrap(),
                "target"
            );
            assert!(!scratch.path().join("new.md").exists());
            service.workspace_close(Some(handle)).await.unwrap();
        }
    }
}
