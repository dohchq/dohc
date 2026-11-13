use crate::capture_driver;
use crate::root_binding;
use dohc_engine_collab::CollabError;
use dohc_engine_collab::OwnerOutboxError;
use dohc_engine_collab::live_update_application::ApplicationError;
use dohc_engine_domain::DomainError;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::Retryability;
use dohc_engine_protocol::error::WireError;
use dohc_engine_runtime::RuntimeError;
use dohc_engine_runtime::SearchError;
use dohc_engine_sync::RelayError;
use dohc_engine_sync::SyncError;

pub(super) fn map_switch_reconcile_error(
    error: capture_driver::SwitchReconcileError,
    operation: &str,
) -> WireError {
    match error {
        capture_driver::SwitchReconcileError::Cancelled => WireError::new(
            ErrorCode::Internal,
            format!("{operation} detached full scan was interrupted"),
        ),
        capture_driver::SwitchReconcileError::Degraded(mut paths) => {
            paths.sort();
            paths.dedup();
            let message = if paths.is_empty() {
                "Could not scan workspace paths".to_owned()
            } else {
                format!("Could not scan workspace paths: {}", paths.join(", "))
            };
            WireError::new(ErrorCode::Internal, message)
        }
        capture_driver::SwitchReconcileError::Unavailable => WireError::new(
            ErrorCode::WorkspaceUnavailable,
            "capture driver unavailable",
        ),
        capture_driver::SwitchReconcileError::ApplyFailed => {
            WireError::new(ErrorCode::Internal, "pre-version-reconcile-failed")
        }
    }
}

pub(super) fn map_owner_outbox(error: OwnerOutboxError) -> WireError {
    let message = match error {
        OwnerOutboxError::DesktopHost => "owner-stop-desktop-host",
        OwnerOutboxError::RestorePending => {
            return WireError::new(ErrorCode::Overloaded, "owner-stop-restore-pending");
        }
        OwnerOutboxError::StopConflict => "owner-stop-conflict",
        OwnerOutboxError::InvalidInput(_) => "invalid-owner-outbox-input",
        OwnerOutboxError::WorkspaceMismatch => "owner-outbox-workspace-mismatch",
        OwnerOutboxError::MainVersionMismatch => "owner-outbox-main-version-mismatch",
        OwnerOutboxError::ParentMismatch => "owner-outbox-parent-mismatch",
        OwnerOutboxError::AppendKeyMismatch => "owner-outbox-append-key-mismatch",
        OwnerOutboxError::Frozen => "owner-outbox-frozen",
        OwnerOutboxError::NotQuarantined => "owner-outbox-not-quarantined",
        OwnerOutboxError::RecoveryCheckpointOutdated => "owner-outbox-read-changed",
        OwnerOutboxError::RecoveryCheckpointUnavailable => {
            "owner-outbox-recovery-checkpoint-unavailable"
        }
        OwnerOutboxError::AcceptedStateIncomplete => "owner-outbox-accepted-state-incomplete",
        OwnerOutboxError::NotFound => "owner-outbox-not-found",
        OwnerOutboxError::ReceiptMismatch => "owner-outbox-receipt-mismatch",
        OwnerOutboxError::Corrupt => {
            return WireError::new(ErrorCode::Internal, "owner-outbox-state-corrupt");
        }
        OwnerOutboxError::Storage(error) => return map_runtime(RuntimeError::Storage(error)),
    };
    WireError::new(ErrorCode::InvalidParams, message)
}

/// The transient store lock, through every wrapper that carries it to this
/// seam.
///
/// One condition, so one answer. Reading it as retryable under materialization
/// and terminal under collaboration would make the same busy database mean two
/// different things to the same caller, which is the defect this recognizer
/// exists to remove.
///
/// Matched on the variant for the reason the artifact lock above is: `code()`
/// delegates through each wrapper, so "file-locked" alone cannot tell a busy
/// database apart from a busy file.
pub(crate) fn store_busy(error: &RuntimeError) -> bool {
    use dohc_engine_storage::StorageError;
    // The search index keeps the raw rusqlite failure instead of wrapping it
    // in the storage taxonomy, so it carries no `FileLocked` to match on and
    // has to be asked directly.
    if let RuntimeError::Search(SearchError::Storage(sqlite)) = error {
        return StorageError::is_transient_lock(sqlite);
    }
    // A shared sync failure is busy when its original is.
    if let RuntimeError::Sync(sync) = error {
        return matches!(
            sync.original(),
            SyncError::Storage(StorageError::FileLocked)
        );
    }
    matches!(
        error,
        RuntimeError::Storage(StorageError::FileLocked)
            | RuntimeError::Materialize(dohc_engine_files::MaterializeError::Storage(
                StorageError::FileLocked
            ))
            | RuntimeError::Domain(DomainError::Storage(StorageError::FileLocked))
            | RuntimeError::Collab(CollabError::Storage(StorageError::FileLocked))
            | RuntimeError::Search(SearchError::Store(StorageError::FileLocked))
            // The relay route carries it under its own type rather than a
            // storage error, because `RelayError` is where a relay operation's
            // local failures land. Same condition, same answer.
            | RuntimeError::Relay(RelayError::StoreBusy)
    )
}

pub(super) fn map_runtime(error: RuntimeError) -> WireError {
    let (wire, line) = map_runtime_logged(error);
    if let Some(line) = line {
        eprintln!("{line}");
    }
    wire
}

fn map_runtime_logged(error: RuntimeError) -> (WireError, Option<String>) {
    let error = match error {
        RuntimeError::LiveApplication(ApplicationError::Storage(error)) => {
            RuntimeError::Storage(error)
        }
        RuntimeError::LiveApplication(ApplicationError::Collab(error)) => {
            RuntimeError::Collab(error)
        }
        error => error,
    };
    let wire = map_runtime_inner(&error);
    let line = internal_refusal(wire.code, &error);
    (wire, line)
}

/// Each io error in `error`'s chain.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn io_errors(error: &RuntimeError) -> impl Iterator<Item = &std::io::Error> {
    let error: &(dyn std::error::Error + 'static) = error;
    std::iter::successors(Some(error), |error| error.source())
        .filter_map(|error| error.downcast_ref::<std::io::Error>())
}

/// What keeps the engine's folder or a store file from being private, and
/// its path from the workspace's root, which the desktop shows. The path is
/// `.dohc`, the engine's folder or a store file, never one of the person's.
#[cfg(target_os = "macos")]
fn engine_folder_not_private(refused: &dohc_macos_files::NotPrivate) -> WireError {
    let (reason, path) = (refused.reason.code(), refused.path.display());
    WireError::new(
        ErrorCode::Internal,
        format!("engine-folder-not-private: {reason} {path}"),
    )
}

/// The reader failed in a way that clears on its own and the proof has
/// retries left, so the caller asks again after a backoff. The resolver
/// bounds those retries and then answers `markdown-reader-unavailable`.
pub(super) fn reader_retryable(error: &RuntimeError) -> bool {
    matches!(
        error,
        RuntimeError::Collab(CollabError::MarkdownReaderRetryable)
            | RuntimeError::LiveApplication(ApplicationError::Collab(
                CollabError::MarkdownReaderRetryable
            ))
            | RuntimeError::Sync(SyncError::RetryableState {
                reason: "markdown-reader-retryable"
            })
    )
}

/// The reader refused the note as larger than it can check (#3575). Asking
/// again gives the same answer. It keeps the INTERNAL code of the reader's
/// other final answers: clients read a LIMIT_EXCEEDED refusal as an update the
/// engine never admitted, and this one can come after the update landed.
fn reader_capacity(error: &RuntimeError) -> bool {
    match error {
        RuntimeError::Collab(CollabError::MarkdownReaderCapacity)
        | RuntimeError::LiveApplication(ApplicationError::Collab(
            CollabError::MarkdownReaderCapacity,
        )) => true,
        RuntimeError::Sync(sync) => matches!(sync.original(), SyncError::MarkdownReaderCapacity),
        _ => false,
    }
}

fn map_runtime_inner(error: &RuntimeError) -> WireError {
    // The volume keeps ACL entries on the engine's folder or store, or what is
    // at one of their paths can't be kept private.
    #[cfg(target_os = "macos")]
    for io in io_errors(error) {
        if dohc_macos_files::volume_shares_new_files(io) {
            return WireError::new(ErrorCode::Internal, "volume-shares-new-files");
        }
        if let Some(refused) = dohc_macos_files::not_private(io) {
            return engine_folder_not_private(refused);
        }
    }
    // On Linux, the engine can't reach its checked folder through the
    // descriptor it holds.
    #[cfg(target_os = "linux")]
    for io in io_errors(error) {
        if let Some(refused) = dohc_linux_files::held::not_held(io) {
            let (reason, path) = (
                dohc_linux_files::held::NotHeld::CODE,
                refused.path.display(),
            );
            return WireError::new(
                ErrorCode::Internal,
                format!("engine-folder-not-private: {reason} {path}"),
            );
        }
    }
    if matches!(
        error,
        RuntimeError::ChatMentionAccessChanged
            | RuntimeError::ChatMentionVersionChanged
            | RuntimeError::ChatConversationLinksChanged
    ) {
        return WireError::new(ErrorCode::Conflict, error.code());
    }
    if matches!(error, RuntimeError::LinksEdgesSourceChanged) {
        return WireError::new(ErrorCode::Conflict, "links-edges-source-changed");
    }
    if matches!(
        error,
        RuntimeError::MarkdownWriteHeld { .. }
            | RuntimeError::Sync(SyncError::MarkdownWriteHeld { .. })
    ) {
        return WireError::new(ErrorCode::Conflict, "markdown-write-held");
    }
    if matches!(
        error,
        RuntimeError::Collab(CollabError::MarkdownWitnessCheckPending { .. })
            | RuntimeError::Sync(SyncError::MarkdownWitnessCheckPending { .. })
    ) {
        return WireError::new(ErrorCode::Overloaded, "markdown-witness-check-pending");
    }
    if let RuntimeError::Domain(DomainError::UndoRefused { .. }) = error {
        return WireError::new(ErrorCode::Conflict, error.to_string());
    }
    if let RuntimeError::CaptureFileHeld { path } = error {
        return WireError::new(ErrorCode::Conflict, format!("capture-file-held: {path}"));
    }
    if matches!(
        error,
        RuntimeError::Sync(SyncError::RetryableState {
            reason: "settlement-materialization-pending"
        })
    ) {
        return WireError::new(ErrorCode::Overloaded, "settlement-materialization-pending");
    }
    if reader_retryable(error) {
        return WireError::new(ErrorCode::Overloaded, "markdown-reader-retryable");
    }
    if reader_capacity(error) {
        return WireError::new(ErrorCode::Internal, "document-too-dense");
    }
    if let RuntimeError::Domain(DomainError::WritePreconditionFailed { .. }) = error {
        return WireError::new(ErrorCode::Conflict, "write-precondition-failed");
    }
    // A materialization that exhausted its replace retries against a lock an
    // external program holds on the ARTIFACT. The settle committed and the
    // write job is durably pending, so the only missing piece is a later
    // attempt — which is exactly `Overloaded`'s retry contract
    // (afterBackoff). Flattening it to Internal (retry: no) is what left a
    // locked file's save landing only on the next unrelated settle.
    //
    // Matched on the variant, never on `code()`: the code delegates through
    // `MaterializeError::Storage`, so a busy SQLite handle answers
    // "file-locked" too — and the desktop would then tell the user another
    // program has their DOCUMENT open while it retried a database contention.
    if matches!(
        error,
        RuntimeError::Materialize(dohc_engine_files::MaterializeError::FileLocked)
    ) {
        return WireError::new(ErrorCode::Overloaded, "file-locked");
    }
    // The other busy thing, and the same answer. `StorageError::FileLocked` is
    // the store reporting itself intact and the operation retryable: writers
    // met inside SQLite and the bounded retry budget ran out. Waiting fixes it.
    //
    // The Internal tail below called it "workspace operation failed", whose
    // retry contract is `no`, so every caller stood down on a condition that
    // clears by itself. It carries its own message because the desktop
    // must not read it as the user's file being held: nothing outside dohc is
    // involved, and there is nothing for a person to do.
    if store_busy(error) {
        return WireError::new(ErrorCode::Overloaded, "engine-store-busy");
    }
    // A read that never migrates, as a CLI read of a workspace dohc has not
    // opened since it updated, found migrations this build has yet to run.
    if matches!(
        error,
        RuntimeError::Storage(dohc_engine_storage::StorageError::MigrationPending)
    ) {
        return WireError::new(
            ErrorCode::Internal,
            "Open the workspace in dohc first, then try again.",
        );
    }
    // Keep the storage refusal code so the desktop can offer move-aside
    // recovery instead of reporting a generic workspace failure.
    if let RuntimeError::Storage(
        refused @ (dohc_engine_storage::StorageError::UnsupportedFingerprint { .. }
        | dohc_engine_storage::StorageError::ForeignDatabase
        | dohc_engine_storage::StorageError::MigrationFailed { .. }
        | dohc_engine_storage::StorageError::MigratedByNewerBuild { .. }),
    ) = error
    {
        // A migration refusal names its cause after the code, the way other
        // refusals carry a detail: the desktop matches the code prefix and
        // shows the rest. The cause is the storage crate's constant text
        // plus a migration id, never a path or content.
        let message = match refused {
            dohc_engine_storage::StorageError::MigrationFailed { .. }
            | dohc_engine_storage::StorageError::MigratedByNewerBuild { .. } => {
                format!("{}: {}", refused.code(), error_chain(refused))
            }
            _ => refused.code().to_string(),
        };
        return WireError::new(ErrorCode::Internal, message);
    }
    match error {
        RuntimeError::RecoveryImportRefused { reason } => {
            return WireError::new(
                ErrorCode::InvalidParams,
                format!("capture-recovery-refused:{reason}"),
            );
        }
        RuntimeError::Collab(CollabError::AuthorCapacity) => {
            return WireError::new(ErrorCode::LimitExceeded, "ydoc-author-capacity");
        }
        RuntimeError::Collab(refused @ CollabError::AuthorEntryTooLarge) => {
            return WireError::new(ErrorCode::LimitExceeded, refused.to_string());
        }
        RuntimeError::Collab(refused @ CollabError::FrontmatterEditRefused) => {
            return WireError::new(ErrorCode::InvalidParams, refused.to_string());
        }
        RuntimeError::Collab(CollabError::ReplayParityViolation { .. }) => {
            return WireError::new(ErrorCode::InvalidParams, "Y.Doc replay parity violation");
        }
        RuntimeError::Collab(CollabError::LineageWriteStale { .. }) => {
            return WireError::new(ErrorCode::InvalidParams, "ydoc-lineage-stale");
        }
        RuntimeError::Collab(CollabError::ObjectAliasCollision) => {
            return WireError::new(ErrorCode::InvalidParams, "ydoc-object-alias-collision");
        }
        RuntimeError::Collab(CollabError::UnsettledClose) => {
            return WireError::new(ErrorCode::InvalidParams, "ydoc-unsettled-close");
        }
        RuntimeError::Collab(CollabError::OwnerOutboxFrozen) => {
            return WireError::new(ErrorCode::InvalidParams, "owner-outbox-frozen");
        }
        RuntimeError::Collab(CollabError::IdempotencyKeyReused) => {
            return WireError::new(ErrorCode::InvalidParams, "idempotency-key-reuse-mismatch");
        }
        RuntimeError::Relay(RelayError::ApiVersionTooOld) => {
            return WireError::new(
                ErrorCode::ProtocolVersionUnsupported,
                "relay-api-version-too-old",
            );
        }
        RuntimeError::Relay(RelayError::ApiVersionTooNew) => {
            return WireError::new(
                ErrorCode::ProtocolVersionUnsupported,
                "relay-api-version-too-new",
            );
        }
        RuntimeError::Relay(RelayError::SettlementProofBudget) => {
            return WireError::new(ErrorCode::Overloaded, "settlement-proof-budget");
        }
        RuntimeError::Relay(RelayError::OriginDiverged) => {
            return WireError::new(ErrorCode::InvalidParams, "relay-origin-diverged");
        }
        RuntimeError::Relay(RelayError::ShareReadOnly) => {
            return WireError::new(ErrorCode::InvalidParams, "share-read-only");
        }
        // The caller matches the code prefix and shows the reason.
        RuntimeError::Relay(RelayError::HostedRefusal(reason)) => {
            return WireError::new(ErrorCode::InvalidParams, format!("invalid-input: {reason}"));
        }
        // The desktop matches the code prefix and names the file. The engine
        // still logs it as an internal refusal, and that line names no path.
        RuntimeError::Relay(RelayError::PathOccupied { path, .. }) => {
            return WireError::new(ErrorCode::Internal, format!("sync-path-occupied: {path}"));
        }
        // Changes waiting on an open conflict reached their limit. The desktop
        // shows its sentences and keeps the counts after them for a report.
        RuntimeError::Relay(RelayError::Local(detail))
            if detail.starts_with("conflict-wait-limit: ") =>
        {
            return WireError::new(ErrorCode::Internal, detail.clone());
        }
        RuntimeError::Relay(RelayError::ClaimRefused(reason)) => {
            let mut wire = map_runtime_inner(&RuntimeError::Relay((**reason).clone()));
            wire.message = "relay-claim-refused".to_owned();
            wire.retry = dohc_engine_protocol::Retryability::No;
            return wire;
        }
        RuntimeError::Relay(RelayError::WorkspaceUnavailable) => {
            return WireError::new(
                ErrorCode::WorkspaceUnavailable,
                "relay-workspace-unavailable",
            );
        }
        // The session still works; only the relay is out of reach. A new
        // session would meet the same relay, so the caller waits and retries.
        RuntimeError::Relay(RelayError::Partitioned) => {
            return WireError {
                retry: Retryability::AfterBackoff,
                ..WireError::new(ErrorCode::WorkspaceUnavailable, "relay-unreachable")
            };
        }
        // Only the session host's service reads it, and it must find the file.
        RuntimeError::HostedFileUnexpected { .. } => {
            return WireError::new(ErrorCode::Internal, error.to_string());
        }
        RuntimeError::SceneAssetDeletePending => {
            return WireError::new(
                ErrorCode::Overloaded,
                "Sync has not delivered every drawing asset delete. Retry the rollback after sync completes.",
            );
        }
        // The change is saved, but a file it owed wasn't written, such as
        // one changed outside dohc. The caller names the file, not a fault.
        RuntimeError::ActiveVersionMaterializationIncomplete { .. } => {
            return WireError::new(ErrorCode::Internal, error.code());
        }
        // Another held proof holds the workspace; nothing queued, ask again.
        RuntimeError::HeldReadBusy => {
            return WireError::new(ErrorCode::Overloaded, "held-read-busy");
        }
        // The proof's answer can never fit; asking again answers the same.
        RuntimeError::HeldReadTooLarge => {
            return WireError::new(ErrorCode::PayloadTooLarge, "held-read-too-large");
        }
        RuntimeError::StoreInUse => {
            return WireError::new(ErrorCode::Overloaded, "store-in-use");
        }
        RuntimeError::Relay(relay @ RelayError::BlobTooLarge { .. }) => {
            return WireError::new(ErrorCode::PayloadTooLarge, relay.to_string());
        }
        RuntimeError::Sync(sync)
            if matches!(sync.original(), SyncError::ProjectionTooLarge { .. }) =>
        {
            return WireError::new(ErrorCode::PayloadTooLarge, sync.to_string());
        }
        RuntimeError::Sync(sync)
            if matches!(sync.original(), SyncError::LiveDocumentBindingActive) =>
        {
            return WireError::new(ErrorCode::InvalidParams, "live-document-binding-active");
        }
        _ => {}
    }
    if let RuntimeError::LiveApplication(application) = error {
        let code = match application {
            ApplicationError::ConfiguredByteBudgetExceeded => ErrorCode::LimitExceeded,
            ApplicationError::InvalidInput(_)
            | ApplicationError::WorkspaceMismatch
            | ApplicationError::MainVersionMismatch => ErrorCode::InvalidParams,
            // The message tells a document that may become ready from a divergence.
            ApplicationError::Conflict
            | ApplicationError::HostedDocumentUnready
            | ApplicationError::LiveDocumentWithoutLineage
            | ApplicationError::ConfiguredBudgetMismatch => ErrorCode::Conflict,
            // The earlier settlement's file write lands on its own; retry later.
            ApplicationError::MaterializationPending => ErrorCode::Overloaded,
            _ => ErrorCode::Internal,
        };
        return WireError::new(code, error.code());
    }
    let code = match error {
        RuntimeError::Cancelled => ErrorCode::Cancelled,
        RuntimeError::ActorUnavailable | RuntimeError::WorkerPanicked => {
            ErrorCode::WorkspaceUnavailable
        }
        RuntimeError::WorkspaceOwned => {
            return WireError::new(ErrorCode::WorkspaceUnavailable, "workspace-owned");
        }
        RuntimeError::WorkspaceHardlinked => {
            return WireError::new(ErrorCode::WorkspaceUnavailable, "workspace-hardlinked");
        }
        RuntimeError::Domain(error) => return map_domain(error),
        RuntimeError::Collab(error) => {
            return WireError::new(map_collab_code(error), error.code());
        }
        RuntimeError::Sync(error) => map_sync_code(error),
        RuntimeError::Relay(error) => map_relay_code(error),
        RuntimeError::Search(error) => map_search_code(error),
        materialize @ RuntimeError::Materialize(_) => {
            return WireError::new(ErrorCode::Internal, materialize.code());
        }
        _ => ErrorCode::Internal,
    };
    WireError::new(code, "workspace operation failed")
}

/// The wire code and the error's code word only. A server's hosting engine
/// writes this line to the server's log, and an error's text can name a file.
fn internal_refusal(code: ErrorCode, error: &RuntimeError) -> Option<String> {
    (code == ErrorCode::Internal).then(|| {
        format!(
            "engine: internal refusal: {} {}",
            code.as_str(),
            error.code()
        )
    })
}

/// The error followed by each of its sources, for migration wire messages.
fn error_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

fn map_relay_code(error: &RelayError) -> ErrorCode {
    match error {
        RelayError::Unauthorized => ErrorCode::AuthFailed,
        RelayError::Forbidden => ErrorCode::Forbidden,
        RelayError::Conflict => ErrorCode::Conflict,
        RelayError::OriginDiverged => ErrorCode::OriginDiverged,
        RelayError::ShareUnavailable => ErrorCode::ShareUnavailable,
        RelayError::KeyEnvelopeMissing => ErrorCode::KeyEnvelopeMissing,
        RelayError::EpochSuperseded => ErrorCode::EpochSuperseded,
        RelayError::IdentityNotRecognized => ErrorCode::IdentityNotRecognized,
        RelayError::ShareReadOnly => ErrorCode::ShareReadOnly,
        RelayError::ShareOperationRejected => ErrorCode::ShareOperationRejected,
        RelayError::PayloadTooLarge
        | RelayError::BlobTooLarge { .. }
        // The same class as the two above — content past a size limit — and it
        // reaches this mapping only through a caller that chooses to surface
        // it, because the share-view pull records it as a skipped op instead.
        | RelayError::ShareBlobOverCeiling { .. } => ErrorCode::PayloadTooLarge,
        RelayError::QuotaExceeded => ErrorCode::QuotaExceeded,
        // A 429 asks the caller to back off and retry, which is exactly
        // Overloaded's wire contract (Retryability::AfterBackoff) — unlike
        // QuotaExceeded, which reads as a persistent ceiling.
        RelayError::DiscussionRateLimited
        | RelayError::LinkReadRateLimited
        | RelayError::ShareAccessRateLimited
        | RelayError::SettlementProofBudget => ErrorCode::Overloaded,
        RelayError::NoProgress => ErrorCode::RelayNoProgress,
        RelayError::BlobMissing => ErrorCode::BlobMissing,
        RelayError::BlobReferenceMissing => ErrorCode::BlobReferenceMissing,
        RelayError::BlobInvalid => ErrorCode::BlobInvalid,
        RelayError::IdentityRequired => ErrorCode::IdentityRequired,
        RelayError::ClaimRefused(reason) => map_relay_code(reason),
        RelayError::StreamIdentityMismatch => ErrorCode::StreamIdentityMismatch,
        RelayError::AuthorshipMismatch => ErrorCode::AuthorshipMismatch,
        RelayError::UnknownChatOperation => ErrorCode::UnknownChatOperation,
        RelayError::PresenceCapacity => ErrorCode::PresenceCapacity,
        RelayError::SelfShare => ErrorCode::SelfShare,
        RelayError::AmbiguousSelector => ErrorCode::AmbiguousSelector,
        RelayError::InvalidChannel => ErrorCode::InvalidChannel,
        RelayError::ApiVersionTooOld | RelayError::ApiVersionTooNew => {
            ErrorCode::ProtocolVersionUnsupported
        }
        RelayError::MethodNotAllowed => ErrorCode::RelayMethodNotAllowed,
        RelayError::HttpsRequired => ErrorCode::RelayHttpsRequired,
        // A served share op the engine cannot replay is the relay's response
        // failing validation, which is the code that already says so. The
        // share-view pull never returns this — it records it as a skipped op
        // and keeps reading — so this arm exists for exhaustiveness and for
        // any later caller that chooses to surface it instead.
        RelayError::ShareOpInvalid { .. } | RelayError::InvalidResponse => {
            ErrorCode::RelayInvalidResponse
        }
        RelayError::WorkspaceUnavailable | RelayError::Partitioned => {
            ErrorCode::WorkspaceUnavailable
        }
        // Reached only by a caller that surfaces it without the `store_busy`
        // recognizer above — which answers OVERLOADED for every route. This
        // arm exists for exhaustiveness and names the backpressure honestly.
        RelayError::StoreBusy => ErrorCode::Overloaded,
        // The relay coordinator awaits every pending validation and runs the
        // operation again, so none reaches a reply.
        RelayError::ServerInternal
        | RelayError::UnknownServerCode(_)
        | RelayError::HttpStatus(_)
        | RelayError::ValidationPending(_)
        | RelayError::Local(_)
        | RelayError::RepairPending
        | RelayError::PathOccupied { .. } => ErrorCode::Internal,
        RelayError::BadRequest | RelayError::HostedRefusal(_) => ErrorCode::InvalidParams,
    }
}

fn map_domain(error: &DomainError) -> WireError {
    use ErrorCode::{Internal, InvalidParams};
    use dohc_engine_crypto::CryptoError;

    let (code, message) = match error {
        error @ (DomainError::PayloadTooLarge { .. }
        | DomainError::ConflictMetadataTooLarge { .. }
        | DomainError::ConflictResolveAnswerTooLarge { .. }
        | DomainError::IdentifierTooLong { .. }) => {
            return WireError::new(ErrorCode::PayloadTooLarge, error.to_string());
        }
        DomainError::IdempotencyKeyReuseMismatch => {
            (InvalidParams, "idempotency-key-reuse-mismatch")
        }
        DomainError::DuplicateMomentId | DomainError::DuplicateId => {
            (InvalidParams, "duplicate-id")
        }
        DomainError::FileNotFound => (InvalidParams, "file-not-found"),
        DomainError::ObjectIdentityMismatch => (InvalidParams, "object-identity-mismatch"),
        DomainError::WorkTargetNotFound => (InvalidParams, "work-target-not-found"),
        DomainError::TargetPathExists => (InvalidParams, "target-path-exists"),
        DomainError::LiveDocumentBindingActive => (InvalidParams, "live-document-binding-active"),
        DomainError::LivePageOwned => (InvalidParams, "live-page-owned"),
        DomainError::VersionNotFound => (InvalidParams, "version-not-found"),
        DomainError::InvalidVersion => (InvalidParams, "invalid-version"),
        DomainError::VersionNameConflict => (InvalidParams, "version-name-conflict"),
        DomainError::InvalidVersionName => (InvalidParams, "invalid-version-name"),
        DomainError::ForkBaseNotFound => (InvalidParams, "fork-base-not-found"),
        DomainError::ConflictNotFound => (InvalidParams, "conflict-not-found"),
        DomainError::ConflictStaleTarget => (InvalidParams, "conflict-stale-target"),
        DomainError::SyncedDeletionRevivalRefused => {
            (InvalidParams, "synced-deletion-revival-refused")
        }
        DomainError::BinaryHeadNotText => (InvalidParams, "binary-head-not-text"),
        DomainError::InvalidPath { .. } => (InvalidParams, "invalid-path"),
        DomainError::InvalidText { .. } => (InvalidParams, "invalid-text"),
        DomainError::NotSecretPath => (InvalidParams, "not-secret-path"),
        DomainError::SecretMomentNotFound => (InvalidParams, "moment-not-found"),
        DomainError::CheckedDeleteReplicationDependents => {
            (ErrorCode::Conflict, "checked-delete-replication-dependents")
        }
        DomainError::RollbackWaitsForSync => (
            ErrorCode::Overloaded,
            "Sync hasn't sent this change yet. Turn sync on and let it finish, then roll the change back.",
        ),
        // The caller matches the code prefix and shows the reason.
        DomainError::InvalidInput {
            reason: reason @ dohc_engine_domain::HOSTED_REPLICA_WRITE_REFUSED,
        } => {
            return WireError::new(InvalidParams, format!("invalid-input: {reason}"));
        }
        DomainError::InvalidInput {
            reason:
                reason @ ("held-change-stale"
                | "held-change-missing"
                | "held-change-conflict"
                | "held-change-undo-stale"
                | "held-change-shared-owner"),
        } => (InvalidParams, *reason),
        DomainError::InvalidInput { .. } => (InvalidParams, "invalid-input"),
        DomainError::StateCorrupt { .. } => (Internal, "state-corrupt"),
        DomainError::Storage(_) => (Internal, "persist-failed"),
        DomainError::Chat {
            code: "state-corrupt",
            ..
        } => (Internal, "state-corrupt"),
        DomainError::Chat {
            code: "invalid-poll-options",
            reason,
        } => (InvalidParams, *reason),
        DomainError::Chat { code, .. } => (InvalidParams, *code),
        DomainError::Crypto(error) => {
            let code = match error {
                CryptoError::InvalidIvLength
                | CryptoError::InvalidTagLength
                | CryptoError::PlaintextTooLarge
                | CryptoError::PlaintextNotUtf8
                | CryptoError::InvalidBase64 => InvalidParams,
                CryptoError::DecryptFailed
                | CryptoError::InvalidKeyLength
                | CryptoError::KeyFileMalformed
                | CryptoError::VolumeSharesNewFiles => Internal,
            };
            (code, error.code())
        }
        DomainError::WorkspaceNotFound
        | DomainError::WorkspaceMismatch
        | DomainError::TextHeadNotBinary => (InvalidParams, "workspace operation failed"),
        _ => (Internal, "workspace operation failed"),
    };
    WireError::new(code, message)
}

fn map_collab_code(error: &CollabError) -> ErrorCode {
    match error {
        CollabError::MarkdownReaderPending(_)
        | CollabError::MarkdownReaderUnavailable
        | CollabError::MarkdownReaderCapacity
        | CollabError::MarkdownWitnessCheckPending { .. } => ErrorCode::Internal,
        CollabError::MarkdownReaderRetryable => ErrorCode::Overloaded,
        CollabError::ConfiguredByteBudgetExceeded
        | CollabError::AuthorCapacity
        | CollabError::AuthorEntryTooLarge => ErrorCode::LimitExceeded,
        CollabError::Corrupt { .. } | CollabError::Storage(_) => ErrorCode::Internal,
        CollabError::MalformedUpdate { .. }
        | CollabError::BaselineSchemaVersionMissing
        | CollabError::FrontmatterEditRefused
        | CollabError::ReplayParityViolation { .. }
        | CollabError::EmptyUpdate
        | CollabError::UpdateTooLarge { .. }
        | CollabError::ProjectionTooLarge { .. }
        | CollabError::ProjectionTooComplex { .. }
        | CollabError::InvalidIdentifier { .. }
        | CollabError::ContentKindMismatch
        | CollabError::UnsupportedContentKind { .. }
        | CollabError::MarkdownRewriteUnsupported { .. }
        | CollabError::MarkdownQuoteDepthExceeded
        | CollabError::MarkdownNotRepresentable
        | CollabError::BaseAlreadyClaimed
        | CollabError::BaseStateDiverged
        | CollabError::BaseRelaySequencePending
        | CollabError::BaseRelaySequenceCollision { .. }
        | CollabError::LineageWriteStale { .. }
        | CollabError::SuccessorProjectionMismatch { .. }
        | CollabError::SuccessorResultMismatch { .. }
        | CollabError::LineageEpochChanged { .. }
        | CollabError::LineagePredecessorMismatch { .. }
        | CollabError::LineageStateVectorMismatch { .. }
        | CollabError::InvalidSuccessorBase { .. }
        | CollabError::LineageIncomplete { .. }
        | CollabError::LeaseHeld
        | CollabError::NoMarker
        | CollabError::MissingDependencies
        | CollabError::ObjectAliasCollision
        | CollabError::SeedOntoExistingLineage
        | CollabError::IdempotencyKeyReused
        | CollabError::OwnerOutboxFrozen
        | CollabError::RestoreFenced
        | CollabError::UnsettledClose => ErrorCode::InvalidParams,
    }
}

fn map_sync_code(error: &SyncError) -> ErrorCode {
    match error {
        SyncError::Shared(original) => map_sync_code(original),
        SyncError::MarkdownReaderPending(_) => ErrorCode::Internal,
        SyncError::MarkdownWitnessCheckPending { .. } => ErrorCode::Internal,
        SyncError::Storage(_)
        | SyncError::SequenceGap
        | SyncError::CoordinateDiverged
        // Retryable state conditions are transient by definition; Internal is
        // the retry-eligible class on this surface (InvalidParams is terminal).
        | SyncError::RetryableState { .. }
        | SyncError::ReleasedLineageUnsettled(_)
        | SyncError::ValidationPending(_)
        | SyncError::MarkdownReaderCapacity
        | SyncError::FaultCrash => ErrorCode::Internal,
        SyncError::InvalidInput { .. }
        | SyncError::MarkdownWriteHeld { .. }
        | SyncError::LiveDocumentBindingActive
        | SyncError::SyncedDeletionRevivalRefused
        | SyncError::UnsupportedOperation
        | SyncError::ShareBoundaryViolation
        | SyncError::ShareVersionMismatch { .. }
        | SyncError::ShareVersionUnusable { .. }
        | SyncError::BlobInvalid => ErrorCode::InvalidParams,
        // Same condition as its relay twin, so the same code. A blob over a
        // fixed ceiling is a size refusal on either path.
        SyncError::BlobTooLarge { .. }
        | SyncError::InputTooLarge { .. }
        | SyncError::ProjectionTooLarge { .. } => {
            ErrorCode::PayloadTooLarge
        }
        SyncError::Cancelled => ErrorCode::Cancelled,
    }
}

fn map_search_code(error: &SearchError) -> ErrorCode {
    match error {
        SearchError::Bounds(_) => ErrorCode::InvalidParams,
        SearchError::Storage(_) | SearchError::Store(_) | SearchError::Corrupt(_) => {
            ErrorCode::Internal
        }
    }
}

pub(super) fn map_root_binding(error: root_binding::RootBindingError) -> WireError {
    let code = match &error {
        // The code every other path sends this refusal with, which the
        // desktop matches.
        root_binding::RootBindingError::VolumeSharesNewFiles => ErrorCode::Internal,
        #[cfg(target_os = "macos")]
        root_binding::RootBindingError::NotPrivate(refused) => {
            return engine_folder_not_private(refused);
        }
        // The message is the one a Mac sends as `NotPrivate`.
        #[cfg(not(target_os = "macos"))]
        root_binding::RootBindingError::NotPrivate(..) => ErrorCode::Internal,
        _ => ErrorCode::InvalidParams,
    };
    WireError::new(code, error.to_string())
}

pub(super) fn initial_capture_updating() -> WireError {
    WireError::new(
        ErrorCode::Overloaded,
        "Workspace is still updating. Try again.",
    )
}

/// The initial capture ended without reading the file. No capture wake will
/// follow, so the refusal is not retryable, but a later capture pass can still
/// read the file, and the caller can open it then.
pub(super) fn initial_capture_degraded() -> WireError {
    WireError {
        code: ErrorCode::Overloaded,
        message: "dohc has not read this file yet. Open it again once dohc has read it.".to_owned(),
        retry: Retryability::No,
    }
}

pub(super) fn workspace_unavailable() -> WireError {
    WireError::new(
        ErrorCode::WorkspaceUnavailable,
        "workspace handle is unavailable",
    )
}

#[cfg(test)]
mod tests {

    #[test]
    fn internal_refusal_logs_only_its_code_words() {
        use dohc_engine_files::MaterializeError;
        use dohc_engine_storage::StorageError;

        for (error, message, line) in [
            (
                RuntimeError::Relay(RelayError::Local(
                    "retryable-state: replication state is not ready: ydoc-resulting-head-pending (object apollo, origin peer seq 7)".into(),
                )),
                "workspace operation failed",
                "engine: internal refusal: INTERNAL relay-failed",
            ),
            (
                RuntimeError::Relay(RelayError::Local("object apollo\nforged\r\t\u{0}\u{1b}\u{85}".into())),
                "workspace operation failed",
                "engine: internal refusal: INTERNAL relay-failed",
            ),
            (
                RuntimeError::Relay(RelayError::UnknownServerCode("unknown\nforged".into())),
                "workspace operation failed",
                "engine: internal refusal: INTERNAL relay-failed",
            ),
            (
                RuntimeError::Identity {
                    reason: "missing identity",
                    source: Some(std::io::Error::other("identity")),
                },
                "workspace operation failed",
                "engine: internal refusal: INTERNAL identity-unresolved",
            ),
            (
                RuntimeError::Sync(SyncError::RetryableState {
                    reason: "ydoc-resulting-head-pending",
                }),
                "workspace operation failed",
                "engine: internal refusal: INTERNAL retryable-state",
            ),
            (
                RuntimeError::Collab(CollabError::Corrupt {
                    reason: "missing lineage".into(),
                }),
                "corrupt-lineage",
                "engine: internal refusal: INTERNAL corrupt-lineage",
            ),
            (
                RuntimeError::Search(SearchError::Store(StorageError::corrupt_public(
                    std::io::Error::other("missing search table"),
                ))),
                "workspace operation failed",
                "engine: internal refusal: INTERNAL search-storage-core",
            ),
            (
                RuntimeError::Domain(DomainError::CaptureNotOwned),
                "workspace operation failed",
                "engine: internal refusal: INTERNAL capture-not-owned",
            ),
            (
                RuntimeError::Domain(DomainError::StateCorrupt {
                    reason: "missing workspace row",
                }),
                "state-corrupt",
                "engine: internal refusal: INTERNAL state-corrupt",
            ),
            (
                RuntimeError::Materialize(MaterializeError::UnsafeTargetPath),
                "unsafe-target-path",
                "engine: internal refusal: INTERNAL unsafe-target-path",
            ),
            (
                RuntimeError::Storage(StorageError::MigrationFailed {
                    source: Some(Box::new(std::io::Error::other("missing table"))),
                }),
                "migration-failed: engine migration failed to apply: missing table",
                "engine: internal refusal: INTERNAL migration-failed",
            ),
        ] {
            let (wire, logged) = map_runtime_logged(error);
            assert_eq!(
                (wire.code, wire.message.as_str(), logged.as_deref()),
                (ErrorCode::Internal, message, Some(line)),
            );
        }
    }

    #[test]
    fn routine_refusals_have_no_internal_log_line() {
        for (error, code, message) in [
            (
                RuntimeError::Sync(SyncError::InvalidInput {
                    reason: "invalid id",
                }),
                ErrorCode::InvalidParams,
                "workspace operation failed",
            ),
            (
                RuntimeError::Domain(DomainError::FileNotFound),
                ErrorCode::InvalidParams,
                "file-not-found",
            ),
            (
                RuntimeError::Collab(CollabError::AuthorCapacity),
                ErrorCode::LimitExceeded,
                "ydoc-author-capacity",
            ),
            (
                RuntimeError::Collab(CollabError::MalformedUpdate {
                    reason: "invalid public baseline schema".into(),
                }),
                ErrorCode::InvalidParams,
                "malformed-update",
            ),
            (
                RuntimeError::LiveApplication(ApplicationError::Collab(
                    CollabError::BaselineSchemaVersionMissing,
                )),
                ErrorCode::InvalidParams,
                "baseline-schema-version-missing",
            ),
            (
                RuntimeError::Relay(RelayError::QuotaExceeded),
                ErrorCode::QuotaExceeded,
                "workspace operation failed",
            ),
            (
                RuntimeError::Sync(SyncError::RetryableState {
                    reason: "settlement-materialization-pending",
                }),
                ErrorCode::Overloaded,
                "settlement-materialization-pending",
            ),
        ] {
            let (wire, logged) = map_runtime_logged(error);
            assert_eq!(
                (wire.code, wire.message.as_str(), logged.as_deref()),
                (code, message, None),
            );
        }
    }

    use super::*;
    use dohc_engine_collab::CollabError;
    use dohc_engine_domain::DomainError;
    use dohc_engine_protocol::error::ErrorCode;
    use dohc_engine_runtime::RuntimeError;
    use dohc_engine_runtime::SearchError;
    use dohc_engine_sync::ObservedBytes;
    use dohc_engine_sync::RelayError;
    use dohc_engine_sync::SyncError;

    #[test]
    fn a_reader_with_retries_left_asks_for_a_backoff_and_an_exhausted_one_does_not() {
        for error in [
            RuntimeError::Collab(CollabError::MarkdownReaderRetryable),
            RuntimeError::LiveApplication(ApplicationError::Collab(
                CollabError::MarkdownReaderRetryable,
            )),
            RuntimeError::Sync(SyncError::RetryableState {
                reason: "markdown-reader-retryable",
            }),
        ] {
            let wire = map_runtime(error);
            assert_eq!(wire.code, ErrorCode::Overloaded);
            assert_eq!(wire.message, "markdown-reader-retryable");
            assert_eq!(wire.retry, dohc_engine_protocol::Retryability::AfterBackoff);
        }
        for error in [
            RuntimeError::Collab(CollabError::MarkdownReaderUnavailable),
            RuntimeError::Sync(SyncError::RetryableState {
                reason: "dohc could not verify this file. Try again.",
            }),
        ] {
            let wire = map_runtime(error);
            assert_eq!(wire.code, ErrorCode::Internal);
            assert_eq!(wire.retry, dohc_engine_protocol::Retryability::No);
        }
        // A note over the reader's capacity is told apart from a reader that
        // stopped, and is not asked again.
        for error in [
            RuntimeError::Collab(CollabError::MarkdownReaderCapacity),
            RuntimeError::LiveApplication(ApplicationError::Collab(
                CollabError::MarkdownReaderCapacity,
            )),
            RuntimeError::Sync(SyncError::MarkdownReaderCapacity),
        ] {
            let wire = map_runtime(error);
            assert_eq!(wire.code, ErrorCode::Internal);
            assert_eq!(wire.message, "document-too-dense");
            assert_eq!(wire.retry, dohc_engine_protocol::Retryability::No);
        }
    }

    /// A busy SQLite handle is transient wherever it appears, and it appears
    /// through several wrappers. Answering it under one and standing down under the
    /// next would leave the same condition retryable or terminal by accident
    /// of which layer noticed it first.
    ///
    /// The paired assertion is what keeps the recognizer narrow: a store error
    /// that is not the transient lock keeps its terminal answer, so this does
    /// not turn every storage failure into a retry.
    ///
    #[test]
    fn a_busy_store_is_retryable_under_every_wrapper_that_carries_it() {
        use dohc_engine_storage::StorageError;
        let busy = [
            RuntimeError::Storage(StorageError::FileLocked),
            RuntimeError::Materialize(dohc_engine_files::MaterializeError::Storage(
                StorageError::FileLocked,
            )),
            RuntimeError::Domain(DomainError::Storage(StorageError::FileLocked)),
            RuntimeError::Collab(CollabError::Storage(StorageError::FileLocked)),
            RuntimeError::LiveApplication(ApplicationError::Storage(StorageError::FileLocked)),
            RuntimeError::LiveApplication(ApplicationError::Collab(CollabError::Storage(
                StorageError::FileLocked,
            ))),
            RuntimeError::Sync(SyncError::Storage(StorageError::FileLocked)),
            RuntimeError::Search(SearchError::Store(StorageError::FileLocked)),
            RuntimeError::Search(SearchError::Storage(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(5), // SQLITE_BUSY
                Some("database is locked".to_owned()),
            ))),
            // The relay route's own type. `RelayError` carries a relay
            // operation's local failures, so the busy store arrives typed
            // rather than as a storage variant — and used to fall through to
            // INTERNAL because this recognizer only read storage variants.
            RuntimeError::Relay(RelayError::StoreBusy),
        ];
        for error in busy {
            let label = error.to_string();
            let wire = map_runtime(error);
            assert_eq!(wire.code, ErrorCode::Overloaded, "{label}");
            assert_eq!(wire.message, "engine-store-busy", "{label}");
            assert_eq!(
                wire.retry,
                dohc_engine_protocol::Retryability::AfterBackoff,
                "{label}"
            );
        }
        let corrupt = map_runtime(RuntimeError::Storage(StorageError::StateCorrupt {
            source: None,
        }));
        assert_eq!(corrupt.code, ErrorCode::Internal);
        assert_ne!(corrupt.message, "engine-store-busy");
    }

    #[test]
    fn runtime_error_mapping_separates_corruption_from_bad_input() {
        let corrupt = map_runtime(RuntimeError::Collab(CollabError::Corrupt {
            reason: "test corrupt lineage".to_owned(),
        }));
        assert_eq!(corrupt.code, ErrorCode::Internal);

        let reused = map_runtime(RuntimeError::Collab(CollabError::IdempotencyKeyReused));
        assert_eq!(reused.code, ErrorCode::InvalidParams);
        assert_eq!(reused.message, "idempotency-key-reuse-mismatch");

        let storage =
            dohc_engine_storage::StorageError::persist_public(rusqlite::Error::InvalidQuery);
        let persisted = map_runtime(RuntimeError::Sync(SyncError::Storage(storage)));
        assert_eq!(persisted.code, ErrorCode::Internal);

        let invalid = map_runtime(RuntimeError::Domain(DomainError::InvalidInput {
            reason: "test invalid input",
        }));
        assert_eq!(invalid.code, ErrorCode::InvalidParams);
        assert_eq!(invalid.message, "invalid-input");

        // S1 (BINHEAD): a text read of a binary head is a normal user error, not
        // an internal server fault — it must map to InvalidParams, never fall
        // through the catch-all to Internal.
        let binary_head = map_runtime(RuntimeError::Domain(DomainError::BinaryHeadNotText));
        assert_eq!(binary_head.code, ErrorCode::InvalidParams);
    }

    #[test]
    fn secret_failures_preserve_safe_messages_and_caller_error_severity() {
        use dohc_engine_crypto::CryptoError;
        use dohc_engine_protocol::Retryability;

        for (error, code, message) in [
            (
                CryptoError::DecryptFailed,
                ErrorCode::Internal,
                "decrypt-failed",
            ),
            (
                CryptoError::InvalidKeyLength,
                ErrorCode::Internal,
                "key-corrupt",
            ),
            (
                CryptoError::KeyFileMalformed,
                ErrorCode::Internal,
                "key-corrupt",
            ),
            (
                CryptoError::VolumeSharesNewFiles,
                ErrorCode::Internal,
                "volume-shares-new-files",
            ),
            (
                CryptoError::InvalidIvLength,
                ErrorCode::InvalidParams,
                "invalid-iv",
            ),
            (
                CryptoError::InvalidTagLength,
                ErrorCode::InvalidParams,
                "invalid-tag",
            ),
            (
                CryptoError::PlaintextTooLarge,
                ErrorCode::InvalidParams,
                "invalid-text",
            ),
            (
                CryptoError::PlaintextNotUtf8,
                ErrorCode::InvalidParams,
                "invalid-text",
            ),
            (
                CryptoError::InvalidBase64,
                ErrorCode::InvalidParams,
                "invalid-input",
            ),
        ] {
            let surfaced = map_runtime(RuntimeError::Domain(DomainError::Crypto(error)));
            assert_eq!(
                (surfaced.code, surfaced.message.as_str(), surfaced.retry),
                (code, message, Retryability::No)
            );
        }
    }

    #[test]
    fn domain_refusals_keep_wire_names_and_hide_internal_reasons() {
        use dohc_engine_protocol::Retryability;

        for (error, code, message) in [
            (
                DomainError::DuplicateMomentId,
                ErrorCode::InvalidParams,
                "duplicate-id",
            ),
            (
                DomainError::SecretMomentNotFound,
                ErrorCode::InvalidParams,
                "moment-not-found",
            ),
            (
                DomainError::Chat {
                    code: "state-corrupt",
                    reason: "private state detail",
                },
                ErrorCode::Internal,
                "state-corrupt",
            ),
            (
                DomainError::Chat {
                    code: "message-not-found",
                    reason: "private message detail",
                },
                ErrorCode::InvalidParams,
                "message-not-found",
            ),
            (
                DomainError::StateCorrupt {
                    reason: "private state detail",
                },
                ErrorCode::Internal,
                "state-corrupt",
            ),
            (
                DomainError::WorkspaceNotFound,
                ErrorCode::InvalidParams,
                "workspace operation failed",
            ),
            (
                DomainError::WorkspaceMismatch,
                ErrorCode::InvalidParams,
                "workspace operation failed",
            ),
            (
                DomainError::TextHeadNotBinary,
                ErrorCode::InvalidParams,
                "workspace operation failed",
            ),
            (
                DomainError::CaptureNotOwned,
                ErrorCode::Internal,
                "workspace operation failed",
            ),
        ] {
            let surfaced = map_runtime(RuntimeError::Domain(error));
            assert_eq!(
                (surfaced.code, surfaced.message.as_str(), surfaced.retry),
                (code, message, Retryability::No)
            );
        }
    }

    /// Size refusals preserve the measured limit and observed usage.
    #[test]
    fn an_oversized_blob_refusal_reaches_the_caller_naming_its_limit() {
        let surfaced = map_runtime(RuntimeError::Relay(RelayError::BlobTooLarge {
            constraint: "MAX_TEXT_BYTES",
            limit_bytes: 10 * 1024 * 1024,
            observed: ObservedBytes::Exact(10 * 1024 * 1024 + 1),
        }));
        assert_eq!(surfaced.code, ErrorCode::PayloadTooLarge);
        assert_eq!(
            surfaced.message,
            "relay blob exceeds MAX_TEXT_BYTES: limit 10485760 bytes, observed 10485761 bytes"
        );
        assert_eq!(
            surfaced.retry,
            dohc_engine_protocol::Retryability::No,
            "a blob that exceeds a fixed ceiling never succeeds on retry"
        );
        assert_eq!(
            map_sync_code(&SyncError::BlobTooLarge {
                constraint: "MAX_CAPTURE_BINARY_FILE_BYTES",
                limit_bytes: 5 * 1024 * 1024,
                observed_bytes: 5 * 1024 * 1024 + 1,
            }),
            map_relay_code(&RelayError::BlobTooLarge {
                constraint: "MAX_CAPTURE_BINARY_FILE_BYTES",
                limit_bytes: 5 * 1024 * 1024,
                observed: ObservedBytes::Exact(5 * 1024 * 1024 + 1),
            })
        );
        let projection = map_runtime(RuntimeError::Sync(SyncError::ProjectionTooLarge {
            constraint: "MAX_PROJECTION_BYTES",
            actual_bytes: dohc_engine_collab::limits::MAX_PROJECTION_BYTES + 1,
            limit_bytes: dohc_engine_collab::limits::MAX_PROJECTION_BYTES,
        }));
        assert_eq!(projection.code, ErrorCode::PayloadTooLarge);
        assert_eq!(
            projection.message,
            "Y.Doc projection exceeds MAX_PROJECTION_BYTES: limit 16777216 bytes, observed at least 16777217 bytes"
        );
    }

    #[test]
    fn relay_error_mapping_preserves_recovery_and_authorization_conditions() {
        let cases = [
            (RelayError::Conflict, ErrorCode::Conflict),
            (RelayError::OriginDiverged, ErrorCode::OriginDiverged),
            (RelayError::ShareUnavailable, ErrorCode::ShareUnavailable),
            (
                RelayError::KeyEnvelopeMissing,
                ErrorCode::KeyEnvelopeMissing,
            ),
            (RelayError::EpochSuperseded, ErrorCode::EpochSuperseded),
            (
                RelayError::IdentityNotRecognized,
                ErrorCode::IdentityNotRecognized,
            ),
            (RelayError::QuotaExceeded, ErrorCode::QuotaExceeded),
            (RelayError::DiscussionRateLimited, ErrorCode::Overloaded),
            (RelayError::LinkReadRateLimited, ErrorCode::Overloaded),
            (RelayError::ShareAccessRateLimited, ErrorCode::Overloaded),
            (RelayError::PayloadTooLarge, ErrorCode::PayloadTooLarge),
            (RelayError::Forbidden, ErrorCode::Forbidden),
            (RelayError::ShareReadOnly, ErrorCode::ShareReadOnly),
            (
                RelayError::ShareOperationRejected,
                ErrorCode::ShareOperationRejected,
            ),
            (RelayError::NoProgress, ErrorCode::RelayNoProgress),
            (RelayError::BlobMissing, ErrorCode::BlobMissing),
            (
                RelayError::BlobReferenceMissing,
                ErrorCode::BlobReferenceMissing,
            ),
            (RelayError::BlobInvalid, ErrorCode::BlobInvalid),
            (RelayError::IdentityRequired, ErrorCode::IdentityRequired),
            (
                RelayError::StreamIdentityMismatch,
                ErrorCode::StreamIdentityMismatch,
            ),
            (
                RelayError::AuthorshipMismatch,
                ErrorCode::AuthorshipMismatch,
            ),
            (
                RelayError::UnknownChatOperation,
                ErrorCode::UnknownChatOperation,
            ),
            (RelayError::LinkReadRateLimited, ErrorCode::Overloaded),
            (RelayError::ShareAccessRateLimited, ErrorCode::Overloaded),
            (RelayError::PresenceCapacity, ErrorCode::PresenceCapacity),
            (RelayError::SelfShare, ErrorCode::SelfShare),
            (RelayError::AmbiguousSelector, ErrorCode::AmbiguousSelector),
            (RelayError::InvalidChannel, ErrorCode::InvalidChannel),
            (
                RelayError::MethodNotAllowed,
                ErrorCode::RelayMethodNotAllowed,
            ),
            (RelayError::InvalidResponse, ErrorCode::RelayInvalidResponse),
            (RelayError::HttpsRequired, ErrorCode::RelayHttpsRequired),
        ];
        for (relay, expected) in cases {
            assert_eq!(
                map_relay_code(&relay),
                expected,
                "collapsing a relay condition prevents generated clients from recovering"
            );
        }
        assert_eq!(
            map_relay_code(&RelayError::Partitioned),
            ErrorCode::WorkspaceUnavailable
        );
        // A relay that answered "not found" and one nobody could reach share
        // the code; only the message tells the desktop which to name.
        let unreachable = map_runtime(RuntimeError::Relay(RelayError::Partitioned));
        assert_eq!(unreachable.code, ErrorCode::WorkspaceUnavailable);
        assert_eq!(unreachable.message, "relay-unreachable");
        // Reopening the session cannot reach the relay either (#2708).
        assert_eq!(unreachable.retry, Retryability::AfterBackoff);
        let missing = map_runtime(RuntimeError::Relay(RelayError::WorkspaceUnavailable));
        assert_eq!(missing.code, ErrorCode::WorkspaceUnavailable);
        assert_eq!(missing.message, "relay-workspace-unavailable");
        assert_eq!(missing.retry, Retryability::AfterReconnect);
        assert_ne!(
            map_runtime(RuntimeError::ActorUnavailable).message,
            missing.message
        );
        assert_ne!(workspace_unavailable().message, missing.message);
        for relay in [
            RelayError::DiscussionRateLimited,
            RelayError::LinkReadRateLimited,
            RelayError::ShareAccessRateLimited,
        ] {
            let wire = map_runtime(RuntimeError::Relay(relay));
            assert_eq!(wire.code, ErrorCode::Overloaded);
            assert_eq!(wire.retry, dohc_engine_protocol::Retryability::AfterBackoff);
        }
        for (relay, message) in [
            (RelayError::ApiVersionTooOld, "relay-api-version-too-old"),
            (RelayError::ApiVersionTooNew, "relay-api-version-too-new"),
        ] {
            let wire = map_runtime(RuntimeError::Relay(relay));
            assert_eq!(wire.code, ErrorCode::ProtocolVersionUnsupported);
            assert_eq!(
                wire.message, message,
                "the desktop reads which side must update"
            );
            assert_eq!(wire.retry, dohc_engine_protocol::Retryability::No);
        }
        let permanent_limit = map_runtime(RuntimeError::Relay(RelayError::QuotaExceeded));
        assert_eq!(permanent_limit.code, ErrorCode::QuotaExceeded);
        assert_eq!(
            permanent_limit.retry,
            dohc_engine_protocol::Retryability::No,
            "a permanent discussion limit must not ask the client to retry"
        );
    }

    #[test]
    fn relay_refusal_messages_preserve_recovery_meaning() {
        let required = map_runtime(RuntimeError::Relay(RelayError::IdentityRequired));
        assert_eq!(
            serde_json::to_value(&required).unwrap()["code"],
            "IDENTITY_REQUIRED"
        );
        assert_ne!(required.message, "relay-claim-refused");
        for refusal in [
            RelayError::WorkspaceUnavailable,
            RelayError::EpochSuperseded,
            RelayError::IdentityNotRecognized,
            RelayError::IdentityRequired,
            RelayError::StreamIdentityMismatch,
        ] {
            let original = map_runtime(RuntimeError::Relay(refusal.clone()));
            let saved = map_runtime(RuntimeError::Relay(RelayError::ClaimRefused(Box::new(
                refusal,
            ))));
            assert_eq!(saved.code, original.code);
            assert_eq!(saved.message, "relay-claim-refused");
            assert_eq!(saved.retry, dohc_engine_protocol::Retryability::No);
        }
        let origin = map_runtime(RuntimeError::Relay(RelayError::OriginDiverged));
        assert_eq!(origin.code, ErrorCode::InvalidParams);
        assert_eq!(
            origin.message, "relay-origin-diverged",
            "a generic INVALID_PARAMS would re-baseline on protocol errors"
        );

        let read_only = map_runtime(RuntimeError::Relay(RelayError::ShareReadOnly));
        assert_eq!(read_only.code, ErrorCode::InvalidParams);
        assert_eq!(
            read_only.message, "share-read-only",
            "a generic INVALID_PARAMS would permanently downgrade writable shares"
        );
    }
}
