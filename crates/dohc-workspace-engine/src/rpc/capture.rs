use crate::EngineService;
use crate::capture_driver;
use crate::lock;
use crate::rpc::dispatch::initial_capture_phase_requires_fence;
use crate::rpc::error::map_runtime;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::request::validated_author;
use crate::rpc::workspace::CaptureHold;
use crate::rpc::workspace::CaptureHolds;
use crate::rpc::workspace::OpenWorkspace;
use dohc_engine_files::policy::{PathClassification, classify_engine_file_path_normalized};
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::time::Instant;

pub(super) const MAX_DESKTOP_CAPTURE_TEXT_BYTES: usize = 128 * 1024;

/// How long a hold lasts without a renewal. The holder renews well inside
/// this while its change runs, so a hold whose reply was lost, or whose
/// holder died with the connection up, ends on its own.
pub(super) const CAPTURE_HOLD_LEASE: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureSetAuthorParams {
    author: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureHoldIdParams {
    hold_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureMoveFileParams {
    hold_id: String,
    from_path: String,
    to_path: String,
}

static NEXT_CAPTURE_HOLD: AtomicU64 = AtomicU64::new(1);

/// Whether the hold is still running. An expired hold ends here, before its
/// timer gets to it, so nothing records under a lease that already ran out.
fn hold_is_live(holds: &mut HashMap<String, CaptureHold>, hold_id: &str, now: Instant) -> bool {
    match holds.get(hold_id) {
        Some(hold) if hold.expires_at > now => true,
        Some(_) => {
            holds.remove(hold_id);
            false
        }
        None => false,
    }
}

/// A write that names a hold refuses once the hold ended, for example because
/// its lease ran out, the workspace closed or the engine restarted, so the
/// caller restores disk instead of recording a change capture may already
/// have seen.
pub(super) fn require_capture_hold(
    open: &OpenWorkspace,
    hold_id: Option<&str>,
) -> Result<(), WireError> {
    match hold_id {
        Some(id) if !hold_is_live(&mut lock(&open.capture_holds), id, Instant::now()) => Err(
            WireError::new(ErrorCode::InvalidParams, "capture-hold-ended"),
        ),
        _ => Ok(()),
    }
}

/// Ends the hold when its lease runs out. A renewal moves the end later; the
/// timer reads the current end each time it wakes, so it never ends a hold
/// that was renewed since it was armed.
fn expire_capture_hold(holds: CaptureHolds, hold_id: String, first: Instant) {
    tokio::spawn(async move {
        let mut wake = first;
        loop {
            tokio::time::sleep_until(wake).await;
            let next = {
                let mut live = lock(&holds);
                let Some(expires_at) = live.get(&hold_id).map(|hold| hold.expires_at) else {
                    return;
                };
                if expires_at <= Instant::now() {
                    live.remove(&hold_id);
                    return;
                }
                expires_at
            };
            wake = next;
        }
    });
}

fn tracked_relative_path(path: &str) -> Result<String, WireError> {
    match classify_engine_file_path_normalized(path) {
        (PathClassification::Tracked, Some(normalized)) if normalized == path => Ok(normalized),
        _ => Err(WireError::new(
            ErrorCode::InvalidParams,
            "capture.moveFile needs tracked workspace paths",
        )),
    }
}

/// Why `capture.moveFile` left the file where it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotMoved {
    DestinationExists,
    SourceMissing,
    NoReplaceUnsupported,
}

impl NotMoved {
    fn as_str(self) -> &'static str {
        match self {
            Self::DestinationExists => "destination-exists",
            Self::SourceMissing => "source-missing",
            Self::NoReplaceUnsupported => "no-replace-unsupported",
        }
    }
}

/// Moves one visible regular file inside `root` to an empty name in one
/// rename that refuses to replace. Both parents must exist and resolve
/// inside the canonical root, and the source must be a regular file, never a
/// link: this moves the entry the caller admitted, not what a link reaches.
fn move_visible_file(root: &Path, from: &str, to: &str) -> Result<Option<NotMoved>, WireError> {
    let invalid = |message: &'static str| WireError::new(ErrorCode::InvalidParams, message);
    let from_abs = root.join(from);
    let to_abs = root.join(to);
    for absolute in [&from_abs, &to_abs] {
        let Some(parent) = absolute.parent() else {
            return Err(invalid("capture.moveFile paths need a parent folder"));
        };
        let resolved = std::fs::canonicalize(parent)
            .map_err(|_| invalid("capture.moveFile parent folder does not resolve"))?;
        if !resolved.starts_with(root) {
            return Err(invalid(
                "capture.moveFile parent folder leads outside the workspace",
            ));
        }
        let relative = resolved
            .strip_prefix(root)
            .map_err(|_| invalid("capture.moveFile parent folder leads outside the workspace"))?;
        let leaf = absolute
            .file_name()
            .ok_or_else(|| invalid("capture.moveFile paths need a file name"))?;
        tracked_relative_path(&relative.join(leaf).to_string_lossy().replace('\\', "/"))?;
    }
    match std::fs::symlink_metadata(&from_abs) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err(invalid("capture.moveFile moves regular files only")),
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Some(NotMoved::SourceMissing)),
        Err(err) => {
            return Err(WireError::new(
                ErrorCode::Internal,
                format!("capture.moveFile could not read the source: {err}"),
            ));
        }
    }
    match dohc_engine_files::move_file_no_replace(&from_abs, &to_abs) {
        Ok(()) => Ok(None),
        Err(err) if err.kind() == ErrorKind::AlreadyExists => Ok(Some(NotMoved::DestinationExists)),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(Some(NotMoved::SourceMissing)),
        Err(err) if err.kind() == ErrorKind::Unsupported => {
            Ok(Some(NotMoved::NoReplaceUnsupported))
        }
        Err(err) => Err(WireError::new(
            ErrorCode::Internal,
            format!("capture.moveFile could not move the file: {err}"),
        )),
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
    /// recorded. The hold is a lease of `leaseMs`: the holder renews it with
    /// `capture.renew` while its change runs, and a hold nobody renews ends
    /// on its own, so a lost reply or a holder that died with the connection
    /// up cannot keep capture out for good. It also ends when the workspace
    /// closes, and with this process, which exits when its one client does.
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
        let expires_at = Instant::now() + CAPTURE_HOLD_LEASE;
        lock(&open.capture_holds).insert(
            hold_id.clone(),
            CaptureHold {
                _guard: guard,
                expires_at,
            },
        );
        expire_capture_hold(Arc::clone(&open.capture_holds), hold_id.clone(), expires_at);
        Ok(json!({
            "holdId": hold_id,
            "leaseMs": u64::try_from(CAPTURE_HOLD_LEASE.as_millis()).unwrap_or(u64::MAX),
        }))
    }

    /// Start the hold's lease again from now. `renewed: false` means the hold
    /// had already ended, and every write that names it refuses.
    pub(super) async fn capture_renew(
        &self,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: CaptureHoldIdParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "capture.renew needs the workspace's owning handle",
            ));
        }
        let now = Instant::now();
        let mut holds = lock(&open.capture_holds);
        let renewed = hold_is_live(&mut holds, &params.hold_id, now);
        if let Some(hold) = holds.get_mut(&params.hold_id) {
            hold.expires_at = now + CAPTURE_HOLD_LEASE;
        }
        Ok(json!({ "renewed": renewed }))
    }

    /// End a hold. `released: false` means it had already ended.
    pub(super) async fn capture_release(
        &self,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: CaptureHoldIdParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "capture.release needs the workspace's owning handle",
            ));
        }
        let mut holds = lock(&open.capture_holds);
        let released = hold_is_live(&mut holds, &params.hold_id, Instant::now())
            && holds.remove(&params.hold_id).is_some();
        Ok(json!({ "released": released }))
    }

    /// Move one visible regular file to an empty name in one rename that
    /// refuses to replace, while the caller's hold keeps capture out. The
    /// caller records the rename under its author afterwards. `moved: false`
    /// names why the file stayed: the destination is taken, the source is
    /// gone, or this filesystem has no such rename, in which case the caller
    /// moves the file its own way.
    pub(super) async fn capture_move_file(
        &self,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: CaptureMoveFileParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "capture.moveFile needs the workspace's owning handle",
            ));
        }
        require_capture_hold(&open, Some(&params.hold_id))?;
        let from = tracked_relative_path(&params.from_path)?;
        let to = tracked_relative_path(&params.to_path)?;
        let root = open.root.clone();
        let outcome = tokio::task::spawn_blocking(move || move_visible_file(&root, &from, &to))
            .await
            .map_err(|_| WireError::new(ErrorCode::Internal, "capture.moveFile worker failed"))??;
        Ok(match outcome {
            None => json!({ "moved": true }),
            Some(reason) => json!({ "moved": false, "reason": reason.as_str() }),
        })
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

    #[cfg(unix)]
    #[test]
    fn native_move_refuses_aliases_into_reserved_folders_and_outside_the_workspace() {
        let scratch = ScratchDir::new().expect("scratch");
        let root = std::fs::canonicalize(scratch.path()).expect("root");
        std::fs::create_dir(root.join(".dohc")).expect("metadata");
        std::fs::write(root.join("good.txt"), "mine").expect("source");
        std::fs::write(root.join(".dohc/state"), "engine").expect("reserved source");
        std::os::unix::fs::symlink(root.join(".dohc"), root.join("alias")).expect("alias");
        assert!(super::move_visible_file(&root, "good.txt", "alias/target").is_err());
        assert!(super::move_visible_file(&root, "alias/state", "visible.txt").is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("good.txt")).expect("source"),
            "mine"
        );
        assert_eq!(
            std::fs::read_to_string(root.join(".dohc/state")).expect("reserved source"),
            "engine"
        );
        let outside = ScratchDir::new().expect("outside");
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).expect("outside alias");
        assert!(super::move_visible_file(&root, "good.txt", "escape/target").is_err());
        assert!(!outside.path().join("target").exists());
    }

    async fn lease_fixture() -> (ScratchDir, EngineService, WorkspaceHandle) {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "capture-hold-lease",
                    "captureMode": "none",
                }),
            )
            .await
            .expect("open");
        let handle = serde_json::from_value(opened["workspace"].clone()).expect("handle");
        (scratch, service, handle)
    }

    #[tokio::test(start_paused = true)]
    async fn lost_capture_hold_reply_expires_and_releases_the_apply_gate() {
        let (_scratch, service, handle) = lease_fixture().await;
        let open = service.open(Some(&handle)).expect("open handle");
        let reply = service
            .capture_hold(&RequestContext::unbounded(), Some(handle.clone()))
            .await
            .expect("hold");
        assert_eq!(reply["leaseMs"], json!(30_000));
        drop(reply); // The connection stays open but no caller received the hold id.
        assert!(open.capture_apply_gate.try_lock().is_err());
        tokio::time::advance(super::CAPTURE_HOLD_LEASE).await;
        let guard = open.capture_apply_gate.lock().await;
        assert!(lock(&open.capture_holds).is_empty());
        drop(guard);
        service.workspace_close(Some(handle)).await.expect("close");
    }

    #[tokio::test(start_paused = true)]
    async fn renewed_capture_hold_survives_its_first_deadline_then_expires() {
        let (_scratch, service, handle) = lease_fixture().await;
        let open = service.open(Some(&handle)).expect("open handle");
        let reply = service
            .capture_hold(&RequestContext::unbounded(), Some(handle.clone()))
            .await
            .expect("hold");
        let half = super::CAPTURE_HOLD_LEASE / 2;
        tokio::time::advance(half).await;
        assert_eq!(
            service
                .capture_renew(Some(handle.clone()), json!({ "holdId": reply["holdId"] }))
                .await
                .expect("renew"),
            json!({ "renewed": true })
        );
        tokio::time::advance(half).await;
        assert!(open.capture_apply_gate.try_lock().is_err());
        tokio::time::advance(half).await;
        let guard = open.capture_apply_gate.lock().await;
        assert!(lock(&open.capture_holds).is_empty());
        drop(guard);
        assert_eq!(
            service
                .capture_renew(Some(handle.clone()), json!({ "holdId": reply["holdId"] }))
                .await
                .expect("late renew"),
            json!({ "renewed": false })
        );
        assert!(super::require_capture_hold(&open, reply["holdId"].as_str()).is_err());
        service.workspace_close(Some(handle)).await.expect("close");
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
