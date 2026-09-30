use crate::EngineService;
use crate::capture_driver;
use crate::lock;
use crate::rpc::dispatch::initial_capture_phase_requires_fence;
use crate::rpc::error::map_runtime;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::request::validated_author;
use crate::rpc::workspace::OpenWorkspace;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub(super) const MAX_DESKTOP_CAPTURE_TEXT_BYTES: usize = 128 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureSetAuthorParams {
    author: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureReleaseParams {
    hold_id: String,
}

static NEXT_CAPTURE_HOLD: AtomicU64 = AtomicU64::new(1);

/// A write that names a hold refuses once the hold ended, for example because
/// the workspace closed or the engine restarted, so the caller restores disk
/// instead of recording a change capture may already have seen.
pub(super) fn require_capture_hold(
    open: &OpenWorkspace,
    hold_id: Option<&str>,
) -> Result<(), WireError> {
    match hold_id {
        Some(id) if !lock(&open.capture_holds).contains_key(id) => Err(WireError::new(
            ErrorCode::InvalidParams,
            "capture-hold-ended",
        )),
        _ => Ok(()),
    }
}

pub(super) fn reject_capture_origin(origin: Option<&str>) -> Result<(), WireError> {
    if origin == Some("capture") {
        Err(WireError::new(
            ErrorCode::InvalidParams,
            "capture is a reserved origin",
        ))
    } else {
        Ok(())
    }
}

impl EngineService {
    pub(super) async fn watcher_status(
        &self,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        // A write here found a filesystem with no atomic no-replace rename.
        let recovery_unavailable = dohc_engine_files::workspace_recovery_unavailable(&open.root);
        let no_atomic_placement = dohc_engine_files::workspace_lacks_atomic_placement(&open.root);
        let kept_files = open
            .actor
            .kept_materialization_files(open.workspace_id.clone(), open.root.clone())
            .await
            .unwrap_or_default();
        let guard = lock(&open.capture);
        Ok(match guard.as_ref() {
            Some(driver) => {
                // One snapshot — the three flags must come from the same
                // atomic load, or a reader racing a transition could report
                // running && terminal.
                let snapshot = driver.status().snapshot();
                json!({
                    "running": snapshot.running,
                    "degraded": snapshot.degraded,
                    "terminal": snapshot.terminal,
                    "phase": snapshot.phase.as_str(),
                    "noAtomicPlacement": no_atomic_placement,
                    "keptFiles": kept_files,
                    "recoveryUnavailable": recovery_unavailable,
                })
            }
            // The driver is only absent mid-teardown; report an honest
            // "down" rather than erroring a racing status poll.
            None => json!({
                "running": false,
                "degraded": true,
                "terminal": false,
                "phase": "degraded",
                "noAtomicPlacement": no_atomic_placement,
                "keptFiles": kept_files,
                    "recoveryUnavailable": recovery_unavailable,
            }),
        })
    }

    /// Drive capture to quiescence and report what was achieved. The
    /// determinism seam for the capture differential: without it a harness
    /// can only sleep and hope, which turns timing blips into parity
    /// failures. Quiescence covers every change the watcher has noticed — a
    /// write still inside the OS debounce is invisible to flush too; callers
    /// needing a specific write poll for it (flush + check), which the
    /// differential does. `settled: false` is an honest answer (layer down, teardown
    /// race, or a workspace under continuous mutation hitting the cycle
    /// bound) — callers must treat it as "state not comparable", never as
    /// "clean".
    pub(super) async fn capture_flush(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        let outcome = self.capture_flush_once(ctx, &open, "capture.flush").await?;
        Ok(json!({
            "settled": outcome.settled,
            "running": outcome.running,
            "degraded": outcome.degraded,
        }))
    }

    pub(super) async fn capture_flush_once(
        &self,
        ctx: &RequestContext,
        open: &OpenWorkspace,
        operation: &'static str,
    ) -> Result<capture_driver::FlushOutcome, WireError> {
        // Clone the sender out of the lock and await outside it: a flush can
        // legitimately take many reconcile cycles, and the workspace table
        // must not be blocked for its duration.
        let capture = lock(&open.capture).as_ref().map(|driver| {
            let snapshot = driver.status().snapshot();
            (driver.flush_sender(), snapshot)
        });
        let unavailable = capture_driver::FlushOutcome {
            settled: false,
            running: false,
            degraded: true,
        };
        let Some((sender, initial_snapshot)) = capture else {
            return Ok(unavailable);
        };
        // `Degraded` is a settled startup DECISION, not a settled flush. Let
        // it reach the driver so a clean recovery tick can make the stronger
        // quiescence promise. Persistent failures still answer false through
        // the ordinary driver outcome; only Starting/Importing stay fenced.
        if initial_capture_phase_requires_fence(initial_snapshot.phase) {
            return Ok(capture_driver::FlushOutcome {
                settled: false,
                running: initial_snapshot.running,
                degraded: initial_snapshot.degraded,
            });
        }
        // A flush can drive up to MAX_FLUSH_CYCLES reconciles or sit behind
        // a full flush queue — a cancelled/deadlined caller must get its
        // answer now, like every other workspace RPC. The driver still
        // finishes its pass; only the wait is abandoned (the reply send
        // fails harmlessly).
        let cancellation = OperationCancellation::new(ctx);
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption(&format!("{operation} (queued)")));
            }
            sent = sender.send(reply_tx) => {
                if sent.is_err() {
                    return Ok(unavailable);
                }
            }
        }
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                Err(cancellation.interruption(operation))
            }
            outcome = reply_rx => Ok(outcome.unwrap_or(unavailable)),
        }
    }

    /// Force the live capture manifest to rebuild, then answer after the first
    /// driver pass. The caller follows an unsettled answer with ordinary
    /// `capture.flush` polling; unlike ordinary flush, this RPC always starts
    /// one full baseline scan even when the OS watcher has not fired yet.
    pub(super) async fn capture_reconcile(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        if dohc_engine_files::workspace_recovery_unavailable(&open.root) {
            let cancellation = OperationCancellation::new(ctx);
            let _capture = tokio::select! {
                biased;
                () = cancellation.token.cancelled() => return Err(cancellation.interruption("file recovery")),
                guard = Arc::clone(&open.capture_apply_gate).lock_owned() => guard,
            };
            let _sessions = tokio::select! {
                biased;
                () = cancellation.token.cancelled() => return Err(cancellation.interruption("file recovery")),
                guard = Arc::clone(&open.session_ops).lock_owned() => guard,
            };
            open.actor
                .materialize_replay_pending_for_fence(
                    open.root.clone(),
                    open.workspace_id.clone(),
                    Arc::new(self.self_writes.scoped(&open.root)),
                    now_ms()?,
                )
                .await
                .map_err(map_runtime)?;
        }
        if let Some(driver) = lock(&open.capture).as_ref() {
            driver.request_manifest_refresh();
        }
        self.capture_flush(ctx, handle).await
    }

    pub(super) async fn capture_set_author(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: CaptureSetAuthorParams = parse(params)?;
        let author_json = validated_author(params.author.as_ref())?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let _apply = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("capture.setAuthor (queued)"));
            }
            guard = Arc::clone(&open.capture_apply_gate).lock_owned() => guard,
        };
        let capture = lock(&open.capture);
        let driver = capture.as_ref().ok_or_else(|| {
            WireError::new(
                ErrorCode::WorkspaceUnavailable,
                "capture driver unavailable",
            )
        })?;
        driver.set_author_json(author_json);
        Ok(json!({ "updated": true }))
    }

    /// Keep capture from recording anything until `capture.release`, so a
    /// caller can change the disk and record that change under its own
    /// author before capture sees it. Capture then finds each change already
    /// recorded. The hold has no time limit, because a limit could end it
    /// while the caller's change is still running. It also ends when the
    /// workspace closes, and with this process, which exits when its one
    /// client does.
    pub(super) async fn capture_hold(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "capture.hold needs the workspace's owning handle",
            ));
        }
        let cancellation = OperationCancellation::new(ctx);
        let guard = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("capture.hold (queued)"));
            }
            guard = Arc::clone(&open.capture_apply_gate).lock_owned() => guard,
        };
        let hold_id = format!(
            "hold-{:016x}",
            NEXT_CAPTURE_HOLD.fetch_add(1, Ordering::Relaxed)
        );
        lock(&open.capture_holds).insert(hold_id.clone(), guard);
        Ok(json!({ "holdId": hold_id }))
    }

    /// End a hold. `released: false` means it had already ended.
    pub(super) async fn capture_release(
        &self,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: CaptureReleaseParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "capture.release needs the workspace's owning handle",
            ));
        }
        let released = lock(&open.capture_holds).remove(&params.hold_id).is_some();
        Ok(json!({ "released": released }))
    }
}

#[cfg(test)]
mod tests {
    use crate::EngineService;
    use crate::lock;
    use dohc_engine_protocol::transport::RequestContext;
    use dohc_engine_protocol::wire::Request;
    use dohc_engine_protocol::wire::WorkspaceHandle;
    use dohc_engine_runtime::WorkspaceSupervisor;
    use dohc_engine_testkit::ScratchDir;
    use serde_json::json;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capture_mode_none_preserves_disk_drift_while_full_open_reconciles_it() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let workspace_id = "capture-mode-none";
        std::fs::write(scratch.path().join("notes.md"), "authoritative").expect("seed disk");
        let seeded = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            )
            .await
            .expect("seed workspace through normal capture");
        let seeded_handle: WorkspaceHandle =
            serde_json::from_value(seeded["workspace"].clone()).expect("workspace handle");
        let main = service
            .versions_ensure_main(
                &RequestContext::unbounded(),
                Some(seeded_handle.clone()),
                json!({ "workspaceId": workspace_id }),
            )
            .await
            .expect("ensure main");
        service
            .workspace_close(Some(seeded_handle))
            .await
            .expect("close seeded workspace");
        std::fs::write(scratch.path().join("notes.md"), "defaced").expect("tamper disk");

        let open_params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": workspace_id,
            "captureMode": "none",
        });
        let opened = service
            .workspace_open(&RequestContext::unbounded(), open_params.clone())
            .await
            .expect("no-capture workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        assert!(
            lock(&service.handles)
                .get(&handle)
                .is_some_and(|open| lock(&open.capture).is_none()),
            "captureMode none must not create a capture driver"
        );
        let preserved = service
            .versioned_text_read(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({ "versionId": main["id"], "path": "notes.md" }),
            )
            .await
            .expect("read preserved snapshot");
        assert_eq!(
            preserved["text"],
            json!("authoritative"),
            "a no-capture open must not reconcile tampered disk bytes"
        );
        service
            .workspace_close(Some(handle))
            .await
            .expect("close no-capture workspace");

        let full = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            )
            .await
            .expect("normal full open");
        let full_handle: WorkspaceHandle =
            serde_json::from_value(full["workspace"].clone()).expect("workspace handle");
        assert!(
            lock(&service.handles)
                .get(&full_handle)
                .is_some_and(|open| lock(&open.capture).is_some()),
            "a normal full open must still create a capture driver"
        );
        let reconciled = service
            .versioned_text_read(
                &RequestContext::unbounded(),
                Some(full_handle.clone()),
                json!({ "versionId": main["id"], "path": "notes.md" }),
            )
            .await
            .expect("read reconciled snapshot");
        assert_eq!(
            reconciled["text"],
            json!("defaced"),
            "a normal full open must still reconcile disk state"
        );
        service
            .workspace_close(Some(full_handle))
            .await
            .expect("close full workspace");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unavailable_recovery_allows_open_and_explicit_reconcile_retries_it() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let params =
            json!({ "rootDir": scratch.path().to_string_lossy(), "workspaceId": "recovery" });
        let first = service
            .workspace_open(&RequestContext::unbounded(), params.clone())
            .await
            .unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(first["workspace"].clone()).unwrap();
        service.workspace_close(Some(handle)).await.unwrap();
        let staging = scratch.path().join(".dohc/engine/displaced");
        std::fs::write(&staging, b"unavailable").unwrap();
        let opened = service
            .workspace_open(&RequestContext::unbounded(), params)
            .await
            .unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let status = service.watcher_status(Some(handle.clone())).await.unwrap();
        assert_eq!(status["recoveryUnavailable"], json!(true));
        assert_eq!(std::fs::read(&staging).unwrap(), b"unavailable");
        std::fs::remove_file(&staging).unwrap();
        service
            .capture_reconcile(&RequestContext::unbounded(), Some(handle.clone()))
            .await
            .unwrap();
        let status = service.watcher_status(Some(handle.clone())).await.unwrap();
        assert_eq!(status["recoveryUnavailable"], json!(false));
        service.workspace_close(Some(handle)).await.unwrap();
    }

    /// A server's automation replica opens without capture and asks to keep
    /// its Collections current. Nothing scans its folder, so the record it
    /// creates through the engine is adopted by the write itself. Any other
    /// captureless open, such as the desktop's join bootstrap, reconciles
    /// nothing, as before.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capture_mode_none_adopts_a_record_it_writes_only_when_asked() {
        for reconcile in [true, false] {
            for (publish, create_only) in [(true, true), (true, false), (false, false)] {
                capture_mode_none_adoption(reconcile, publish, create_only).await;
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reconcile_collections_needs_capture_mode_none() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let refused = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "reconcile-needs-no-capture",
                    "reconcileCollections": true,
                }),
            )
            .await;
        assert!(
            refused.is_err(),
            "a captured workspace already reconciles through its driver"
        );
    }

    async fn capture_mode_none_adoption(reconcile: bool, publish: bool, create_only: bool) {
        const RECORD: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let workspace_id = "capture-mode-none-collections";
        let ctx = RequestContext::unbounded();
        let opened = service
            .workspace_open(
                &ctx,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                    "captureMode": "none",
                    "reconcileCollections": reconcile,
                }),
            )
            .await
            .expect("no-capture workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        let main = service
            .versions_ensure_main(
                &ctx,
                Some(handle.clone()),
                json!({ "workspaceId": workspace_id }),
            )
            .await
            .expect("ensure main");
        let files = [
            (
                "Tasks/collection.yaml",
                "name: Tasks\nfields:\n  Status:\n    type: text\n".to_owned(),
            ),
            (
                "Tasks/one.md",
                format!("---\nid: {RECORD}\nStatus: Doing\n---\n"),
            ),
        ];
        for (id, (path, text)) in (1_u64..).zip(files) {
            let request = Request {
                id,
                method: "versionedText.write".to_owned(),
                workspace: Some(handle.clone()),
                deadline_ms: None,
                idempotency_key: None,
                progress: false,
                params: json!({
                    "versionId": main["id"],
                    "path": path,
                    "text": text,
                    "origin": "api",
                    "publish": publish,
                    "createOnly": create_only,
                }),
            };
            service
                .versioned_text_write(&ctx, &request, request.params.clone())
                .await
                .expect("create through the engine");
        }
        let found = service
            .collections_get_record(
                &ctx,
                Some(handle.clone()),
                json!({ "collectionPath": "Tasks", "recordId": RECORD, "historyLimit": 1 }),
                3,
            )
            .await;
        if reconcile {
            let (found, _) = found.expect("the record is in its Collection without a capture pass");
            assert_eq!(found["record"]["path"], json!("Tasks/one.md"));
        } else {
            assert!(
                found.is_err(),
                "a captureless open that did not ask reconciles nothing"
            );
        }
        service
            .workspace_close(Some(handle))
            .await
            .expect("close no-capture workspace");
    }
}
