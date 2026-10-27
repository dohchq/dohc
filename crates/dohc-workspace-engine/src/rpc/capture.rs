use crate::EngineService;
use crate::capture_driver;
use crate::lock;
use crate::rpc::dispatch::initial_capture_phase_requires_fence;
use crate::rpc::error::map_runtime;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::landed_wait_until;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetryHeldParams {
    path: String,
}

fn held_files_json(holds: &[dohc_engine_storage::capture_file_holds::CaptureFileHold]) -> Value {
    json!(holds.iter().map(|hold| json!({
        "workspaceId": hold.workspace_id, "sourceVersionId": hold.source_version_id,
        "objectId": hold.object_id, "path": hold.path, "observedSha256": hold.observed_sha256,
        "observedSize": hold.observed_size, "reason": hold.reason,
        "observedAtMs": hold.observed_at_ms, "attemptCount": hold.attempt_count,
        "retryRequested": hold.retry_requested,
    })).collect::<Vec<_>>())
}

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
struct ClearCaptureRecoveryParams {
    moment_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureHoldParams {
    #[serde(default)]
    operation_id: Option<String>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureDuplicateParams {
    hold_id: String,
    from_path: String,
    to_path: String,
    author: Option<Value>,
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
pub(super) fn capture_operation_id(
    open: &OpenWorkspace,
    hold_id: Option<&str>,
) -> Result<Option<String>, WireError> {
    let Some(id) = hold_id else {
        return Ok(None);
    };
    let mut holds = lock(&open.capture_holds);
    if !hold_is_live(&mut holds, id, Instant::now()) {
        return Err(WireError::new(
            ErrorCode::InvalidParams,
            "capture-hold-ended",
        ));
    }
    Ok(holds.get(id).and_then(|hold| hold.operation_id.clone()))
}

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

const FLUSH_UNAVAILABLE: capture_driver::FlushOutcome = capture_driver::FlushOutcome {
    settled: false,
    running: false,
    degraded: true,
};

/// Hand a flush to the driver and answer with its passes. A flush can sit
/// behind a full flush queue, so a cancelled caller stops waiting for a
/// place. A flush with `landed` follows a landed step: it ignores the
/// cancellation and stops waiting for a place or for the passes at `landed`,
/// answering `unsettled`; a queued flush still runs. Otherwise, once the
/// driver holds the flush it runs its passes regardless, so the request
/// answers with their outcome.
async fn flush_through(
    sender: &tokio::sync::mpsc::Sender<tokio::sync::oneshot::Sender<capture_driver::FlushOutcome>>,
    ctx: &RequestContext,
    operation: &str,
    landed: Option<tokio::time::Instant>,
    unsettled: capture_driver::FlushOutcome,
) -> Result<capture_driver::FlushOutcome, WireError> {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    let sent = match landed {
        Some(until) => match tokio::time::timeout_at(until, sender.send(reply_tx)).await {
            Ok(sent) => sent,
            Err(_) => return Ok(unsettled),
        },
        None => {
            let cancellation = OperationCancellation::new(ctx);
            tokio::select! {
                biased;
                () = cancellation.token.cancelled() => {
                    return Err(cancellation.interruption(&format!("{operation} (queued)")));
                }
                sent = sender.send(reply_tx) => sent,
            }
        }
    };
    if sent.is_err() {
        return Ok(FLUSH_UNAVAILABLE);
    }
    let replied = match landed {
        Some(until) => match tokio::time::timeout_at(until, reply_rx).await {
            Ok(replied) => replied,
            Err(_) => return Ok(unsettled),
        },
        None => reply_rx.await,
    };
    Ok(replied.unwrap_or(FLUSH_UNAVAILABLE))
}

impl EngineService {
    pub(super) async fn capture_duplicate_file(
        &self,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: CaptureDuplicateParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::Forbidden,
                "Duplicate needs the owning handle",
            ));
        }
        let operation = capture_operation_id(&open, Some(&params.hold_id))?.ok_or_else(|| {
            WireError::new(
                ErrorCode::InvalidParams,
                "Duplicate needs an admitted operation",
            )
        })?;
        let from = tracked_relative_path(&params.from_path)?;
        let to = tracked_relative_path(&params.to_path)?;
        let author = validated_author(params.author.as_ref())?;
        let version = open
            .actor
            .active_version(open.workspace_id.clone())
            .await
            .map_err(map_runtime)?
            .version_id;
        let result = open
            .actor
            .duplicate_file(
                dohc_engine_domain::DuplicateFile {
                    workspace_id: open.workspace_id.clone(),
                    version_id: version,
                    from_path: from,
                    to_path: to.clone(),
                    operation_id: operation.clone(),
                    author_json: author,
                    now_ms: now_ms()?,
                },
                open.root.clone(),
                Arc::new(dohc_engine_storage::NoFaults),
            )
            .await
            .map_err(map_runtime)?;
        let placed = open
            .actor
            .history_undo_place(
                open.workspace_id.clone(),
                dohc_engine_runtime::HistoryUndoResult {
                    operation_id: operation.clone(),
                    version_id: result.version_id,
                    moments: result.moments,
                    compensation_operation_id: operation,
                    deduped: false,
                    materialized: false,
                    not_restored: vec![],
                },
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
                now_ms()?,
                |_| {},
            )
            .await;
        Ok(json!({ "path": to, "materialized": placed.materialized }))
    }

    pub(super) async fn capture_retry_held(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let input: RetryHeldParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::Forbidden,
                "capture.retryHeld needs the workspace's owning handle",
            ));
        }
        let path = dohc_engine_domain::validate_addressable_plaintext_path(&input.path)
            .map_err(|error| map_runtime(error.into()))?;
        let cancellation = OperationCancellation::new(ctx);
        let gate = tokio::select! {
            () = cancellation.token.cancelled() => return Err(cancellation.interruption("capture.retryHeld (queued)")),
            guard = Arc::clone(&open.capture_apply_gate).lock_owned() => guard,
        };
        let retried = open
            .actor
            .retry_capture_file(open.workspace_id.clone(), path)
            .await
            .map_err(map_runtime)?;
        if retried && let Some(driver) = lock(&open.capture).as_ref() {
            driver.request_manifest_refresh();
        }
        drop(gate);
        // A committed retry hands its flush to the driver whatever the caller does.
        let landed = retried.then(|| landed_wait_until(ctx));
        let mut response = self.capture_flush_after(ctx, handle, landed).await?;
        response["retried"] = json!(retried);
        Ok(response)
    }
    pub(super) async fn capture_clear_recovery(
        &self,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let input: ClearCaptureRecoveryParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        open.actor
            .clear_capture_recovery(open.workspace_id.clone(), input.moment_id)
            .await
            .map_err(map_runtime)?;
        Ok(json!({"cleared":true}))
    }
    pub(super) fn watcher_deferred_writes(
        &self,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        let paths = lock(&open.capture)
            .as_ref()
            .map(|driver| driver.status().deferred_writes())
            .unwrap_or_default();
        Ok(json!({ "deferredWrites": paths }))
    }

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
        let (capture_recoveries, holds) = open
            .actor
            .capture_notices(open.workspace_id.clone())
            .await
            .map_err(map_runtime)?;
        let held_files = held_files_json(&holds);
        let retained_copies = crate::rpc::retained_copies::summary_json(
            crate::rpc::retained_copies::retained_summary(&open)
                .await
                .unwrap_or_default(),
        );
        let guard = lock(&open.capture);
        Ok(match guard.as_ref() {
            Some(driver) => {
                // All flags come from one snapshot, so a transition cannot
                // report running && terminal.
                let snapshot = driver.status_snapshot();
                json!({
                    "running": snapshot.running,
                    "degraded": snapshot.degraded,
                    "terminal": snapshot.terminal,
                    "phase": snapshot.phase.as_str(),
                    "noAtomicPlacement": no_atomic_placement,
                    "keptFiles": kept_files,
                    "captureRecoveries": capture_recoveries,
                    "heldFiles": held_files,
                    "deferredWrites": driver.status().deferred_writes(),
                    "recoveryUnavailable": recovery_unavailable,
                    "retainedCopies": retained_copies,
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
                "captureRecoveries": capture_recoveries,
                "heldFiles": held_files,
                "deferredWrites": [],
                "recoveryUnavailable": recovery_unavailable,
                "retainedCopies": retained_copies,
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
        self.capture_flush_after(ctx, handle, None).await
    }

    /// `capture.flush`, or with `landed`, the flush that follows a landed step.
    async fn capture_flush_after(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        landed: Option<tokio::time::Instant>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        let outcome = self
            .capture_flush_once(ctx, &open, "capture.flush", landed)
            .await?;
        let held_files = held_files_json(
            &open
                .actor
                .capture_file_holds(open.workspace_id.clone())
                .await
                .map_err(map_runtime)?,
        );
        Ok(json!({
            "settled": outcome.settled,
            "running": outcome.running,
            "degraded": outcome.degraded,
            "heldFiles": held_files,
            "deferredWrites": lock(&open.capture).as_ref()
                .map(|driver| driver.status().deferred_writes()).unwrap_or_default(),
        }))
    }

    /// Flush capture once; `landed` is as for [`flush_through`].
    pub(super) async fn capture_flush_once(
        &self,
        ctx: &RequestContext,
        open: &OpenWorkspace,
        operation: &'static str,
        landed: Option<tokio::time::Instant>,
    ) -> Result<capture_driver::FlushOutcome, WireError> {
        // Clone the sender out of the lock and await outside it: a flush can
        // legitimately take many reconcile cycles, and the workspace table
        // must not be blocked for its duration.
        let capture = lock(&open.capture).as_ref().map(|driver| {
            let snapshot = driver.status_snapshot();
            (driver.flush_sender(), snapshot)
        });
        let Some((sender, initial_snapshot)) = capture else {
            return Ok(FLUSH_UNAVAILABLE);
        };
        let unsettled = capture_driver::FlushOutcome {
            settled: false,
            running: initial_snapshot.running,
            degraded: initial_snapshot.degraded,
        };
        // `Degraded` is a settled startup DECISION, not a settled flush. Let
        // it reach the driver so a clean recovery tick can make the stronger
        // quiescence promise. Persistent failures still answer false through
        // the ordinary driver outcome; only Starting/Importing stay fenced.
        if initial_capture_phase_requires_fence(initial_snapshot.phase) {
            return Ok(unsettled);
        }
        flush_through(&sender, ctx, operation, landed, unsettled).await
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
        let mut landed = None;
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
            landed = Some(landed_wait_until(ctx));
        }
        if let Some(driver) = lock(&open.capture).as_ref() {
            driver.request_manifest_refresh();
        }
        self.capture_flush_after(ctx, handle, landed).await
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
        params: Value,
    ) -> Result<Value, WireError> {
        let params: CaptureHoldParams = parse(params)?;
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
        if let Some(operation) = &params.operation_id {
            open.actor
                .admit_history_operation(open.workspace_id.clone(), operation.clone())
                .await
                .map_err(map_runtime)?;
        }
        let hold_id = format!(
            "hold-{:016x}",
            NEXT_CAPTURE_HOLD.fetch_add(1, Ordering::Relaxed)
        );
        let expires_at = Instant::now() + CAPTURE_HOLD_LEASE;
        lock(&open.capture_holds).insert(
            hold_id.clone(),
            CaptureHold {
                operation_id: params.operation_id,
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
    #[tokio::test]
    async fn duplicate_refuses_forged_operation_and_hold_ids() {
        assert!(serde_json::from_value::<super::CaptureDuplicateParams>(serde_json::json!({"holdId":"hold-forged","fromPath":"a.md","toPath":"b.md","operationId":"dohc-operation:forged"})).is_err());
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let supervisor = Box::leak(Box::new(dohc_engine_runtime::WorkspaceSupervisor::new()));
        let service = crate::EngineService::with_supervisor(supervisor);
        let opened = service.workspace_open(&dohc_engine_protocol::transport::RequestContext::unbounded(), serde_json::json!({"rootDir":scratch.path().to_string_lossy(),"workspaceId":"duplicate-forged","captureMode":"none"})).await.unwrap();
        let handle: dohc_engine_protocol::wire::WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).unwrap();
        let result = service
            .capture_duplicate_file(
                Some(handle.clone()),
                serde_json::json!({"holdId":"hold-forged","fromPath":"a.md","toPath":"b.md"}),
            )
            .await;
        assert!(result.is_err(), "an arbitrary id never admits a Duplicate");
        service.workspace_close(Some(handle)).await.unwrap();
    }
    use crate::EngineService;
    use crate::capture_driver;
    use crate::lock;
    use dohc_engine_protocol::transport::RequestContext;
    use dohc_engine_protocol::wire::Request;
    use dohc_engine_protocol::wire::WorkspaceHandle;
    use dohc_engine_runtime::WorkspaceSupervisor;
    use dohc_engine_testkit::ScratchDir;
    use serde_json::json;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stopped_capture_task_panicking_during_import_reports_paused() {
        stopped_capture_task_reports_paused(true, true).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stopped_capture_task_returning_during_import_reports_paused() {
        stopped_capture_task_reports_paused(true, false).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stopped_capture_task_panicking_after_ready_reports_paused() {
        stopped_capture_task_reports_paused(false, true).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stopped_capture_task_returning_after_ready_reports_paused() {
        stopped_capture_task_reports_paused(false, false).await;
    }

    async fn stopped_capture_task_reports_paused(importing: bool, panic: bool) {
        let scratch = ScratchDir::new().unwrap();
        let probe = capture_driver::CaptureApplyProbe::default();
        let files = if importing {
            probe.pause_next_apply();
            capture_driver::EARLY_IMPORT_MIN_ADDED_FILES
        } else {
            1
        };
        for index in 0..files {
            std::fs::write(scratch.path().join(format!("seed-{index}.md")), b"seed").unwrap();
        }
        let service = EngineService::with_capture_apply_probe_for_harness(probe.clone());
        let ctx = RequestContext::unbounded();
        let opened = service
            .workspace_open(
                &ctx,
                json!({
                    "rootDir": scratch.path().to_string_lossy(), "workspaceId": "stopped-task"
                }),
            )
            .await
            .unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        if importing {
            probe.wait_until_paused().await;
        }
        let open = service.open(Some(&handle)).unwrap();
        let driver = lock(&open.capture).take().unwrap();
        assert_eq!(
            driver.status().snapshot().phase,
            if importing {
                capture_driver::CapturePhase::Importing
            } else {
                capture_driver::CapturePhase::Ready
            }
        );
        probe.stop_task_for_test(panic);
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            while !driver.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("capture task finishes");
        *lock(&open.capture) = Some(driver);
        service
            .versions_ensure_main(
                &ctx,
                Some(handle.clone()),
                json!({"workspaceId":"stopped-task"}),
            )
            .await
            .unwrap();

        let status = service.watcher_status(Some(handle.clone())).await.unwrap();
        let versions = service
            .dispatch(
                RequestContext::unbounded(),
                Request {
                    id: 1,
                    workspace: Some(handle.clone()),
                    method: "versions.list".to_owned(),
                    deadline_ms: None,
                    idempotency_key: None,
                    progress: false,
                    params: json!({}),
                },
            )
            .await
            .map(|reply| reply.response.result);
        let history_params = json!({"workspaceId":"stopped-task", "versionId":"main"});
        let history = service
            .history_page(&ctx, Some(handle.clone()), history_params.clone())
            .await;
        let history_dispatch = service
            .dispatch(
                RequestContext::unbounded(),
                Request {
                    id: 2,
                    workspace: Some(handle.clone()),
                    method: "history.page".to_owned(),
                    deadline_ms: None,
                    idempotency_key: None,
                    progress: false,
                    params: history_params,
                },
            )
            .await
            .map(|reply| reply.response.result);
        // The unrecorded file exercises ydoc.open's separate import check.
        std::fs::write(scratch.path().join("uncaptured.md"), b"not recorded").unwrap();
        let ydoc = service
            .ydoc_open(
                &ctx,
                Some(handle.clone()),
                json!({
                    "versionId":"main", "path":"uncaptured.md"
                }),
                3,
            )
            .await;
        service.workspace_close(Some(handle)).await.unwrap();

        assert!(
            status["running"] == json!(false)
                && status["degraded"] == json!(true)
                && status["terminal"] == json!(true)
                && versions.is_ok()
                && history.is_ok()
                && history_dispatch.is_ok()
                && ydoc
                    .as_ref()
                    .is_err_and(|error| error.message
                        == crate::rpc::error::initial_capture_degraded().message),
            "status={status}; versions={versions:?}; history={history:?}; history dispatch={history_dispatch:?}; ydoc={ydoc:?}"
        );
    }

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

    #[tokio::test]
    async fn a_flush_cancelled_once_the_driver_holds_it_answers_with_its_passes() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({ "rootDir": scratch.path().to_string_lossy(), "workspaceId": "flush" }),
            )
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        // The initial import answers a flush without reaching the driver.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while service
            .capture_flush(&RequestContext::unbounded(), Some(handle.clone()))
            .await
            .expect("flush")["settled"]
            != json!(true)
        {
            assert!(tokio::time::Instant::now() < deadline, "capture settles");
            tokio::task::yield_now().await;
        }
        let ctx = RequestContext::unbounded();
        let mut waiting = Box::pin(service.capture_flush(&ctx, Some(handle.clone())));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(waiting.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        ctx.cancel.cancel();
        tokio::task::yield_now().await;
        let flushed = waiting
            .await
            .expect("a flush the driver holds answers with its outcome");
        assert_eq!(flushed["settled"], json!(true));
        service.workspace_close(Some(handle)).await.expect("close");
    }

    /// A flush that follows a landed step finds the flush queue full. It
    /// ignores the request's cancellation and stops waiting at its bound,
    /// answering that capture has not settled.
    #[tokio::test(start_paused = true)]
    async fn a_landed_flush_stops_waiting_for_a_full_queue_at_its_bound() {
        let (sender, _queue) = tokio::sync::mpsc::channel(1);
        let (taken, _) = tokio::sync::oneshot::channel();
        sender.try_send(taken).expect("fill the queue");
        let ctx = RequestContext::unbounded();
        ctx.cancel.cancel();
        let unsettled = capture_driver::FlushOutcome {
            settled: false,
            running: true,
            degraded: false,
        };
        let bound = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            super::flush_through(&sender, &ctx, "capture.retryHeld", Some(bound), unsettled),
        )
        .await
        .expect("the wait ends at its bound")
        .expect("a landed flush answers");
        assert!(!outcome.settled && outcome.running && !outcome.degraded);
        assert_eq!(tokio::time::Instant::now(), bound);
    }

    /// A flush that follows a landed step enters the queue, and the driver
    /// does not answer it before the bound. The request answers that capture
    /// has not settled, and the queued flush stays for the driver to run.
    #[tokio::test(start_paused = true)]
    async fn a_landed_flush_stops_waiting_for_its_reply_at_its_bound() {
        let (sender, mut queue) = tokio::sync::mpsc::channel(1);
        let unsettled = capture_driver::FlushOutcome {
            settled: false,
            running: true,
            degraded: false,
        };
        let bound = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            super::flush_through(
                &sender,
                &RequestContext::unbounded(),
                "capture.retryHeld",
                Some(bound),
                unsettled,
            ),
        )
        .await
        .expect("the wait ends at its bound")
        .expect("a landed flush answers");
        assert!(!outcome.settled && outcome.running && !outcome.degraded);
        assert_eq!(tokio::time::Instant::now(), bound);
        let queued = queue.try_recv().expect("the flush stays queued");
        // The driver finishes it later; the answer has nowhere to go.
        assert!(
            queued
                .send(capture_driver::FlushOutcome {
                    settled: true,
                    running: true,
                    degraded: false,
                })
                .is_err()
        );
    }

    /// The retry is cancelled while it waits for the actor, so it commits
    /// before it reaches its flush.
    #[tokio::test]
    async fn a_retry_cancelled_after_it_commits_answers_with_its_flush() {
        use dohc_engine_domain::{VersionedTextStore, WriteText};
        use dohc_engine_storage::capture_file_holds::{CaptureFileHold, NOT_REPRESENTABLE};
        use dohc_engine_storage::{EngineStore, NoFaults};
        let scratch = ScratchDir::new().expect("scratch");
        let workspace_id = "retry-held-cancel";
        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        crate::root_binding::write_root_binding(scratch.path(), token).expect("root binding");
        {
            let mut store =
                EngineStore::open(&dohc_engine_testkit::engine_db_path(&scratch).unwrap(), 1)
                    .expect("store");
            store.bind_root_token(token, &NoFaults).expect("bind root");
            let mut domain = VersionedTextStore::new(&mut store);
            domain
                .ensure_main_version(workspace_id, "main", 1, &NoFaults)
                .expect("main");
            domain
                .write_text(
                    &WriteText {
                        workspace_id: workspace_id.into(),
                        version_id: "main".into(),
                        object_id: "held".into(),
                        path: "held.txt".into(),
                        text: "Before".into(),
                        moment_id: "held-seed".into(),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2,
                    },
                    &NoFaults,
                )
                .expect("head");
            store
                .write_with(&NoFaults, |tx| {
                    dohc_engine_storage::capture_file_holds::record_in(
                        tx,
                        &CaptureFileHold {
                            workspace_id: workspace_id.into(),
                            source_version_id: "main".into(),
                            object_id: "held".into(),
                            path: "held.txt".into(),
                            observed_sha256: dohc_engine_storage::hex_sha256(b"Held outside"),
                            observed_size: 12,
                            reason: NOT_REPRESENTABLE.into(),
                            observed_at_ms: 3,
                            attempt_count: 1,
                            retry_requested: false,
                        },
                    )
                })
                .expect("hold");
        }
        std::fs::write(scratch.path().join("held.txt"), "Held outside").expect("held file");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({ "rootDir": scratch.path().to_string_lossy(), "workspaceId": workspace_id }),
            )
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while service
            .capture_flush(&RequestContext::unbounded(), Some(handle.clone()))
            .await
            .expect("flush")["settled"]
            != json!(true)
        {
            assert!(tokio::time::Instant::now() < deadline, "capture settles");
            tokio::task::yield_now().await;
        }
        let hold = service.hold_actor(&handle).await;
        let ctx = RequestContext::unbounded();
        let mut retrying = Box::pin(service.capture_retry_held(
            &ctx,
            Some(handle.clone()),
            json!({ "path": "held.txt" }),
        ));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(retrying.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        ctx.cancel.cancel();
        // Let the cancellation reach the request's token.
        tokio::task::yield_now().await;
        drop(hold);
        let retried = retrying
            .await
            .expect("a committed retry answers with its flush");
        assert_eq!(retried["retried"], json!(true));
        assert!(retried.get("settled").is_some());
        service.workspace_close(Some(handle)).await.expect("close");
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

    #[tokio::test]
    async fn deferred_write_snapshot_without_a_driver_returns_immediately() {
        let (_scratch, service, handle) = lease_fixture().await;
        let open = service.open(Some(&handle)).expect("open workspace");
        let hold = open.capture_apply_gate.lock().await;
        for _ in 0..2 {
            assert_eq!(
                service.watcher_deferred_writes(Some(handle.clone())).unwrap(),
                json!({ "deferredWrites": [] })
            );
        }
        drop(hold);
        service.workspace_close(Some(handle.clone())).await.unwrap();
        assert!(service.watcher_deferred_writes(Some(handle)).is_err());
    }

    #[tokio::test]
    async fn deferred_write_snapshot_returns_during_capture_shutdown() {
        let scratch = ScratchDir::new().unwrap();
        let service = EngineService::new();
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({ "rootDir": scratch.path().to_string_lossy(), "workspaceId": "deferred-shutdown" }),
            )
            .await
            .unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        service.shutdown_all_capture().await;
        assert_eq!(
            service.watcher_deferred_writes(Some(handle.clone())).unwrap(),
            json!({ "deferredWrites": [] })
        );
        service.workspace_close(Some(handle)).await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn lost_capture_hold_reply_expires_and_releases_the_apply_gate() {
        let (_scratch, service, handle) = lease_fixture().await;
        let open = service.open(Some(&handle)).expect("open handle");
        let reply = service
            .capture_hold(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({}),
            )
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
            .capture_hold(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({}),
            )
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
                .versioned_text_write(&ctx, request)
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportRecoveryParams {
    admitted_base_base64: String,
    version_id: String,
    object_id: String,
    path: String,
    expected_claim_id: Option<String>,
    expected_state_vector_sha256: String,
    expected_disk_sha256: Option<String>,
    text: String,
    updates: Vec<ImportRecoveryUpdate>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportRecoveryUpdate {
    request_id: String,
    update_base64: String,
    actor_origin_id: Option<String>,
    attribution: Option<dohc_engine_domain::ChangeAttribution>,
}
impl EngineService {
    pub(super) async fn capture_import_recovery(
        &self,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        use base64::Engine as _;
        use dohc_engine_runtime::actor::{RecoveryImport, RecoveryImportOutcome, RecoveryUpdate};
        let input: ImportRecoveryParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::Forbidden,
                "capture.importRecovery needs the workspace's owning handle",
            ));
        }
        let admitted_base = base64::engine::general_purpose::STANDARD
            .decode(input.admitted_base_base64)
            .map_err(|_| {
                WireError::new(
                    ErrorCode::InvalidParams,
                    "capture-recovery-refused:invalid-admitted-base",
                )
            })?;
        let _serial = open.session_ops.lock().await;
        let updates = input
            .updates
            .into_iter()
            .map(|u| {
                Ok(RecoveryUpdate {
                    request_id: u.request_id,
                    update: base64::engine::general_purpose::STANDARD
                        .decode(u.update_base64)
                        .map_err(|_| {
                            WireError::new(
                                ErrorCode::InvalidParams,
                                "capture-recovery-refused:invalid-update",
                            )
                        })?,
                    actor_origin_id: u.actor_origin_id,
                    attribution: u.attribution,
                })
            })
            .collect::<Result<Vec<_>, WireError>>()?;
        let outcome = open
            .actor
            .capture_import_recovery(
                open.root.clone(),
                RecoveryImport {
                    key: dohc_engine_collab::DocKey::new(
                        &open.workspace_id,
                        input.version_id,
                        input.object_id,
                    )
                    .map_err(|e| WireError::new(ErrorCode::InvalidParams, e.to_string()))?,
                    path: input.path,
                    expected_claim_id: input.expected_claim_id,
                    expected_state_vector_sha256: input.expected_state_vector_sha256,
                    expected_disk_sha256: input.expected_disk_sha256,
                    admitted_base,
                    updates,
                    text: input.text,
                },
                now_ms()?,
                Arc::new(dohc_engine_storage::NoFaults),
            )
            .await
            .map_err(map_runtime)?;
        for facts in &outcome.record_facts {
            crate::events::emit_record_events(&self.events, &open.workspace_id, facts);
        }
        crate::events::emit_automation_claimed(
            &self.events,
            &open.workspace_id,
            &outcome.automation_claims,
        );
        Ok(match outcome.outcome {
            RecoveryImportOutcome::Imported { moment_id } => {
                json!({"committed":true,"outcome":"imported","momentId":moment_id})
            }
            RecoveryImportOutcome::Replayed => {
                json!({"committed":true,"outcome":"replayed","momentId":null})
            }
            RecoveryImportOutcome::Covered => {
                json!({"committed":true,"outcome":"covered","momentId":null})
            }
        })
    }
}
