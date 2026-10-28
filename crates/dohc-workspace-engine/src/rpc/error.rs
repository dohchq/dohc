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
    matches!(
        error,
        RuntimeError::Storage(StorageError::FileLocked)
            | RuntimeError::Materialize(dohc_engine_files::MaterializeError::Storage(
                StorageError::FileLocked
            ))
            | RuntimeError::Domain(DomainError::Storage(StorageError::FileLocked))
            | RuntimeError::Collab(CollabError::Storage(StorageError::FileLocked))
            | RuntimeError::Sync(SyncError::Storage(StorageError::FileLocked))
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
        RuntimeError::Relay(RelayError::Partitioned) => {
            return WireError::new(ErrorCode::WorkspaceUnavailable, "relay-unreachable");
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
        RuntimeError::Relay(relay @ RelayError::BlobTooLarge { .. }) => {
            return WireError::new(ErrorCode::PayloadTooLarge, relay.to_string());
        }
        RuntimeError::Sync(sync @ SyncError::ProjectionTooLarge { .. }) => {
            return WireError::new(ErrorCode::PayloadTooLarge, sync.to_string());
        }
        RuntimeError::Sync(SyncError::LiveDocumentBindingActive) => {
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
        RuntimeError::Collab(error) => map_collab_code(error),
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

fn internal_refusal(code: ErrorCode, error: &(dyn std::error::Error + 'static)) -> Option<String> {
    if code != ErrorCode::Internal {
        return None;
    }
    let mut line = format!("engine: internal refusal: {error}");
    let mut source = error.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !line
            .strip_suffix(text.as_str())
            .is_some_and(|head| head.ends_with(": "))
        {
            line.push_str(": ");
            line.push_str(&text);
        }
        source = cause.source();
    }
    let mut escaped = String::with_capacity(line.len());
    for ch in line.chars() {
        if ch.is_control() {
            escaped.extend(ch.escape_default());
        } else {
            escaped.push(ch);
        }
    }
    if escaped.len() > 4096 {
        let mut end = 4096 - '…'.len_utf8();
        while !escaped.is_char_boundary(end) {
            end -= 1;
        }
        escaped.truncate(end);
        escaped.push('…');
    }
    Some(escaped)
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
        RelayError::ServerInternal
        | RelayError::UnknownServerCode(_)
        | RelayError::HttpStatus(_)
        | RelayError::Local(_) => ErrorCode::Internal,
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
        DomainError::TargetPathExists => (InvalidParams, "target-path-exists"),
        DomainError::LiveDocumentBindingActive => (InvalidParams, "live-document-binding-active"),
        DomainError::VersionNotFound => (InvalidParams, "version-not-found"),
        DomainError::InvalidVersion => (InvalidParams, "invalid-version"),
        DomainError::VersionNameConflict => (InvalidParams, "version-name-conflict"),
        DomainError::InvalidVersionName => (InvalidParams, "invalid-version-name"),
        DomainError::ForkBaseNotFound => (InvalidParams, "fork-base-not-found"),
        DomainError::ConflictNotFound => (InvalidParams, "conflict-not-found"),
        DomainError::ConflictStaleTarget => (InvalidParams, "conflict-stale-target"),
        DomainError::BinaryHeadNotText => (InvalidParams, "binary-head-not-text"),
        DomainError::InvalidPath { .. } => (InvalidParams, "invalid-path"),
        DomainError::InvalidText { .. } => (InvalidParams, "invalid-text"),
        DomainError::NotSecretPath => (InvalidParams, "not-secret-path"),
        DomainError::SecretMomentNotFound => (InvalidParams, "moment-not-found"),
        DomainError::CheckedDeleteReplicationDependents => {
            (ErrorCode::Conflict, "checked-delete-replication-dependents")
        }
        // The caller matches the code prefix and shows the reason.
        DomainError::InvalidInput {
            reason: reason @ dohc_engine_domain::HOSTED_REPLICA_WRITE_REFUSED,
        } => {
            return WireError::new(InvalidParams, format!("invalid-input: {reason}"));
        }
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
        | CollabError::MarkdownWitnessCheckPending { .. } => ErrorCode::Internal,
        CollabError::ConfiguredByteBudgetExceeded
        | CollabError::AuthorCapacity
        | CollabError::AuthorEntryTooLarge => ErrorCode::LimitExceeded,
        CollabError::Corrupt { .. } | CollabError::Storage(_) => ErrorCode::Internal,
        CollabError::MalformedUpdate { .. }
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
        SyncError::MarkdownReaderPending(_) => ErrorCode::Internal,
        SyncError::MarkdownWitnessCheckPending { .. } => ErrorCode::Internal,
        SyncError::Storage(_)
        | SyncError::SequenceGap
        | SyncError::CoordinateDiverged
        // Retryable state conditions are transient by definition; Internal is
        // the retry-eligible class on this surface (InvalidParams is terminal).
        | SyncError::RetryableState { .. }
        | SyncError::FaultCrash => ErrorCode::Internal,
        SyncError::InvalidInput { .. }
        | SyncError::MarkdownWriteHeld { .. }
        | SyncError::LiveDocumentBindingActive
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
    fn undo_refusal_wire_text_keeps_the_domain_prefix() {
        let error = super::map_runtime(dohc_engine_runtime::RuntimeError::Domain(
            dohc_engine_domain::DomainError::UndoRefused {
                path: "a.md".into(),
                reason: "link changed after rename",
            },
        ));
        assert_eq!(
            error.message,
            "domain error: Undo refused: link changed after rename: a.md"
        );
    }

    #[test]
    fn changed_chat_authority_has_a_restartable_wire_reason() {
        let error = super::map_runtime(dohc_engine_runtime::RuntimeError::ChatMentionAccessChanged);
        assert_eq!(error.code, dohc_engine_protocol::ErrorCode::Conflict);
        assert_eq!(error.message, "chat-mention-access-changed");
        let error =
            super::map_runtime(dohc_engine_runtime::RuntimeError::ChatMentionVersionChanged);
        assert_eq!(error.code, dohc_engine_protocol::ErrorCode::Conflict);
        assert_eq!(error.message, "chat-mention-version-changed");
    }

    #[test]
    fn changed_edge_source_has_a_restartable_wire_reason() {
        let error = super::map_runtime(dohc_engine_runtime::RuntimeError::LinksEdgesSourceChanged);
        assert_eq!(error.code, dohc_engine_protocol::ErrorCode::Conflict);
        assert_eq!(error.message, "links-edges-source-changed");
    }

    #[test]
    fn internal_refusal_maps_the_wire_and_logs_each_cause_once() {
        use dohc_engine_files::MaterializeError;
        use dohc_engine_storage::StorageError;

        for (error, message, line) in [
            (
                RuntimeError::Relay(RelayError::Local(
                    "retryable-state: replication state is not ready: ydoc-resulting-head-pending (object apollo, origin peer seq 7)".into(),
                )),
                "workspace operation failed",
                "engine: internal refusal: relay error: local sync state failed: retryable-state: replication state is not ready: ydoc-resulting-head-pending (object apollo, origin peer seq 7)",
            ),
            (
                RuntimeError::Relay(RelayError::Local("object apollo\nforged\r\t\u{0}\u{1b}\u{85}".into())),
                "workspace operation failed",
                "engine: internal refusal: relay error: local sync state failed: object apollo\\nforged\\r\\t\\u{0}\\u{1b}\\u{85}",
            ),
            (
                RuntimeError::Relay(RelayError::UnknownServerCode("unknown\nforged".into())),
                "workspace operation failed",
                "engine: internal refusal: relay error: relay returned unknown error code unknown\\nforged",
            ),
            (
                RuntimeError::Identity {
                    reason: "missing identity",
                    source: Some(std::io::Error::other("identity")),
                },
                "workspace operation failed",
                "engine: internal refusal: could not resolve engine.db identity: missing identity: identity",
            ),
            (
                RuntimeError::Sync(SyncError::RetryableState {
                    reason: "ydoc-resulting-head-pending",
                }),
                "workspace operation failed",
                "engine: internal refusal: synchronization error: replication state is not ready: ydoc-resulting-head-pending",
            ),
            (
                RuntimeError::Collab(CollabError::Corrupt {
                    reason: "missing lineage".into(),
                }),
                "workspace operation failed",
                "engine: internal refusal: collaboration error: corrupt Y.Doc lineage: missing lineage",
            ),
            (
                RuntimeError::Search(SearchError::Store(StorageError::corrupt_public(
                    std::io::Error::other("missing search table"),
                ))),
                "workspace operation failed",
                "engine: internal refusal: search error: search storage-core failure: engine store is corrupt: missing search table",
            ),
            (
                RuntimeError::Domain(DomainError::CaptureNotOwned),
                "workspace operation failed",
                "engine: internal refusal: domain error: capture does not own this path current head",
            ),
            (
                RuntimeError::Domain(DomainError::StateCorrupt {
                    reason: "missing workspace row",
                }),
                "state-corrupt",
                "engine: internal refusal: domain error: engine store is corrupt: missing workspace row",
            ),
            (
                RuntimeError::Materialize(MaterializeError::UnsafeTargetPath),
                "unsafe-target-path",
                "engine: internal refusal: materialization error: job target path is not a safe workspace-relative path",
            ),
            (
                RuntimeError::Storage(StorageError::MigrationFailed {
                    source: Some(Box::new(std::io::Error::other("missing table"))),
                }),
                "migration-failed: engine migration failed to apply: missing table",
                "engine: internal refusal: storage error: engine migration failed to apply: missing table",
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
    fn internal_refusal_caps_the_escaped_chain_on_a_char_boundary() {
        use dohc_engine_storage::StorageError;

        for detail in ["é".repeat(3000), "\n".repeat(3000)] {
            let (wire, logged) = map_runtime_logged(RuntimeError::Storage(
                StorageError::corrupt_public(std::io::Error::other(detail)),
            ));
            assert_eq!(
                (wire.code, wire.message.as_str()),
                (ErrorCode::Internal, "workspace operation failed"),
            );
            let line = logged.expect("Internal refusal logs its cause");
            assert!((4093..=4096).contains(&line.len()), "{} bytes", line.len());
            assert!(line.ends_with('…'));
            assert!(
                line.starts_with(
                    "engine: internal refusal: storage error: engine store is corrupt: "
                )
            );
            assert!(!line.chars().any(char::is_control));
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

    #[test]
    fn checked_delete_replication_dependents_have_a_known_reason() {
        let wire = super::map_runtime(dohc_engine_runtime::RuntimeError::Domain(
            dohc_engine_domain::DomainError::CheckedDeleteReplicationDependents,
        ));
        assert_eq!(wire.code, dohc_engine_protocol::ErrorCode::Conflict);
        assert_eq!(wire.message, "checked-delete-replication-dependents");
    }

    #[test]
    fn conditional_restore_delete_materialization_reason_reaches_rpc() {
        for error in [
            dohc_engine_files::MaterializeError::SymlinkTarget,
            dohc_engine_files::MaterializeError::RecoveryUnavailable,
            dohc_engine_files::MaterializeError::Io {
                path: "record.md".into(),
                kind: std::io::ErrorKind::PermissionDenied,
                raw_os_error: None,
                privacy_denied: false,
            },
        ] {
            let code = error.code();
            let wire = super::map_runtime(dohc_engine_runtime::RuntimeError::Materialize(error));
            assert_eq!(wire.code, dohc_engine_protocol::ErrorCode::Internal);
            assert_eq!(wire.message, code);
            assert!(!wire.message.contains("record.md"));
        }
    }

    /// The desktop explains a macOS privacy refusal by this code, so it
    /// reaches the wire from a file write and from the workspace root.
    #[test]
    fn a_macos_privacy_denial_reaches_rpc_by_its_code() {
        let write = super::map_runtime(dohc_engine_runtime::RuntimeError::Materialize(
            dohc_engine_files::MaterializeError::Io {
                path: "notes.md".into(),
                kind: std::io::ErrorKind::PermissionDenied,
                raw_os_error: Some(1),
                privacy_denied: true,
            },
        ));
        let root = super::map_root_binding(crate::root_binding::RootBindingError::PrivacyDenied);
        assert_eq!(root.message, "privacy-denied");
        assert_eq!(write.message, "privacy-denied");
    }

    /// A write on a volume that adds sharing permissions to new files names
    /// that limit on the wire, not a generic io failure.
    #[test]
    fn a_volume_that_shares_new_files_reaches_rpc_by_its_code() {
        let write = super::map_runtime(dohc_engine_runtime::RuntimeError::Materialize(
            dohc_engine_files::MaterializeError::VolumeSharesNewFiles,
        ));
        assert_eq!(write.code, dohc_engine_protocol::ErrorCode::Internal);
        assert_eq!(write.message, "volume-shares-new-files");
        let root =
            super::map_root_binding(crate::root_binding::RootBindingError::VolumeSharesNewFiles);
        assert_eq!(root.code, dohc_engine_protocol::ErrorCode::Internal);
        assert_eq!(root.message, "volume-shares-new-files");
        #[cfg(target_os = "macos")]
        {
            let refused = || std::io::Error::other(dohc_macos_files::VolumeSharesNewFiles);
            let folder = super::map_runtime(dohc_engine_runtime::RuntimeError::Identity {
                reason: "could not create engine.db parent directory",
                source: Some(refused()),
            });
            let store = super::map_runtime(dohc_engine_runtime::RuntimeError::Storage(
                dohc_engine_storage::StorageError::persist_public(refused()),
            ));
            for wire in [folder, store] {
                assert_eq!(wire.code, dohc_engine_protocol::ErrorCode::Internal);
                assert_eq!(wire.message, "volume-shares-new-files");
            }
        }
    }

    /// The desktop names what keeps the engine's folder from being private,
    /// and where, by this code, from the root binding and from the store.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_folder_dohc_cant_keep_private_reaches_rpc_by_its_code() {
        use dohc_macos_files::{NotPrivate, NotPrivateReason};
        for (path, reason, message) in [
            (
                ".dohc",
                NotPrivateReason::Link,
                "engine-folder-not-private: link .dohc",
            ),
            (
                ".dohc/engine",
                NotPrivateReason::NotFolder,
                "engine-folder-not-private: not-folder .dohc/engine",
            ),
            (
                ".dohc/engine",
                NotPrivateReason::OtherOwner,
                "engine-folder-not-private: other-owner .dohc/engine",
            ),
            (
                ".dohc/engine/engine.db-wal",
                NotPrivateReason::NotFile,
                "engine-folder-not-private: not-file .dohc/engine/engine.db-wal",
            ),
            (
                ".dohc/engine",
                NotPrivateReason::UncheckedVolume,
                "engine-folder-not-private: unchecked-volume .dohc/engine",
            ),
        ] {
            let refused = NotPrivate {
                path: path.into(),
                reason,
            };
            let root = super::map_root_binding(crate::root_binding::RootBindingError::NotPrivate(
                refused.clone(),
            ));
            let store = super::map_runtime(dohc_engine_runtime::RuntimeError::Identity {
                reason: "could not keep the engine store private",
                source: Some(std::io::Error::other(refused)),
            });
            for wire in [root, store] {
                assert_eq!(wire.code, dohc_engine_protocol::ErrorCode::Internal);
                assert_eq!(wire.message, message);
            }
        }
    }

    /// On Linux, an engine folder the engine can't reach through the
    /// descriptor it holds reaches the desktop by the same code, from the root
    /// binding and from the store.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_folder_dohc_cant_hold_reaches_rpc_by_its_code() {
        use dohc_linux_files::held::NotHeld;
        let root = super::map_root_binding(crate::root_binding::RootBindingError::NotPrivate(
            NotHeld::CODE,
            ".dohc/engine",
        ));
        let refused = NotHeld {
            path: ".dohc/engine".into(),
        };
        let store = super::map_runtime(dohc_engine_runtime::RuntimeError::Identity {
            reason: "could not keep the engine store private",
            source: Some(std::io::Error::other(refused)),
        });
        for wire in [root, store] {
            assert_eq!(wire.code, dohc_engine_protocol::ErrorCode::Internal);
            assert_eq!(
                wire.message,
                "engine-folder-not-private: unchecked-system .dohc/engine"
            );
        }
    }

    #[test]
    fn settlement_proof_budget_has_a_retryable_rpc_error() {
        let error = super::map_runtime(dohc_engine_runtime::RuntimeError::Relay(
            dohc_engine_sync::RelayError::SettlementProofBudget,
        ));
        assert_eq!(error.code, dohc_engine_protocol::ErrorCode::Overloaded);
        assert_eq!(
            error.retry,
            dohc_engine_protocol::Retryability::AfterBackoff
        );
        assert_eq!(error.message, "settlement-proof-budget");
    }

    #[test]
    fn pending_settlement_has_a_retryable_wire_error() {
        let error = super::map_runtime(dohc_engine_runtime::RuntimeError::Sync(
            dohc_engine_sync::SyncError::RetryableState {
                reason: "settlement-materialization-pending",
            },
        ));
        assert_eq!(
            error.code,
            dohc_engine_protocol::error::ErrorCode::Overloaded
        );
        assert_eq!(error.message, "settlement-materialization-pending");
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
    fn live_application_native_errors_preserve_refusal_and_failure_codes() {
        for (application, expected) in [
            (
                ApplicationError::InvalidInput("invalid binding"),
                ErrorCode::InvalidParams,
            ),
            (
                ApplicationError::WorkspaceMismatch,
                ErrorCode::InvalidParams,
            ),
            (
                ApplicationError::MainVersionMismatch,
                ErrorCode::InvalidParams,
            ),
            (ApplicationError::Conflict, ErrorCode::Conflict),
            (ApplicationError::HostedDocumentUnready, ErrorCode::Conflict),
            (
                ApplicationError::LiveDocumentWithoutLineage,
                ErrorCode::Conflict,
            ),
            (
                ApplicationError::ConfiguredByteBudgetExceeded,
                ErrorCode::LimitExceeded,
            ),
            (ApplicationError::Corrupt, ErrorCode::Internal),
            (ApplicationError::Interrupted, ErrorCode::Internal),
        ] {
            let error = RuntimeError::LiveApplication(application);
            let message = error.code();
            let mapped = map_runtime(error);
            assert_eq!(mapped.code, expected);
            assert_eq!(mapped.message, message);
        }
    }

    #[test]
    fn a_store_with_pending_migrations_asks_for_the_workspace_to_open_first() {
        let mapped = map_runtime(RuntimeError::Storage(
            dohc_engine_storage::StorageError::MigrationPending,
        ));
        assert_eq!(mapped.code, ErrorCode::Internal);
        assert_eq!(
            mapped.message,
            "Open the workspace in dohc first, then try again."
        );
    }

    #[test]
    fn live_application_wrappers_preserve_storage_and_collaboration_refusals() {
        use dohc_engine_storage::StorageError;
        for error in [
            RuntimeError::LiveApplication(ApplicationError::Storage(StorageError::ForeignDatabase)),
            RuntimeError::LiveApplication(ApplicationError::Storage(
                StorageError::UnsupportedFingerprint {
                    found: 1,
                    expected: 2,
                },
            )),
            RuntimeError::LiveApplication(ApplicationError::Storage(
                StorageError::MigrationFailed { source: None },
            )),
            RuntimeError::LiveApplication(ApplicationError::Storage(
                StorageError::MigratedByNewerBuild {
                    ordinal: 5,
                    id: "from-a-newer-build".to_owned(),
                },
            )),
        ] {
            let expected = match &error {
                RuntimeError::LiveApplication(ApplicationError::Storage(inner)) => inner.code(),
                _ => unreachable!(),
            };
            let message = map_runtime(error).message;
            assert!(
                message == expected || message.starts_with(&format!("{expected}: ")),
                "{message} must carry the {expected} code"
            );
        }
        let error = map_runtime(RuntimeError::LiveApplication(ApplicationError::Collab(
            CollabError::ObjectAliasCollision,
        )));
        assert_eq!(error.code, ErrorCode::InvalidParams);
        assert_eq!(error.message, "ydoc-object-alias-collision");
        for refusal in [
            CollabError::MalformedUpdate {
                reason: "incomplete update".into(),
            },
            CollabError::ProjectionTooLarge { actual: 3, max: 2 },
        ] {
            assert_eq!(
                map_runtime(RuntimeError::LiveApplication(ApplicationError::Collab(
                    refusal
                )))
                .code,
                ErrorCode::InvalidParams,
            );
        }
        // A settlement cannot release the author interval until the earlier
        // settlement's file write lands, so the host retries after backoff.
        let error = map_runtime(RuntimeError::LiveApplication(
            ApplicationError::MaterializationPending,
        ));
        assert_eq!(error.code, ErrorCode::Overloaded);
        assert_eq!(error.message, "settlement-materialization-pending");
    }

    /// The artifact lock and a busy engine database are two
    /// different contentions, and only the first may be reported as
    /// `file-locked` — the desktop turns that message into "another program
    /// has this file open" and retries the ARTIFACT write against it. The
    /// code() of MaterializeError::Storage delegates to the storage error, so
    /// matching on the code alone reported a busy SQLite handle as an
    /// artifact lock. Matching the variant is what keeps them apart.
    ///
    /// Round 14 held the busy store terminal because nothing collected on the
    /// retry it would have advertised. #658 built the collector — the Y.Doc
    /// provider's settle ladder retries `engine-store-busy` — so the busy
    /// store now carries the retry contract that has always been true of it,
    /// under its own message. Two messages, because the two contentions need
    /// different words: one names a program outside dohc holding the user's
    /// file, and the other is dohc's own writers meeting inside SQLite.
    ///
    #[test]
    fn a_busy_engine_store_is_not_reported_as_a_locked_artifact() {
        let artifact = map_runtime(RuntimeError::Materialize(
            dohc_engine_files::MaterializeError::FileLocked,
        ));
        assert_eq!(artifact.code, ErrorCode::Overloaded);
        assert_eq!(artifact.message, "file-locked");

        let store = map_runtime(RuntimeError::Materialize(
            dohc_engine_files::MaterializeError::Storage(
                dohc_engine_storage::StorageError::FileLocked,
            ),
        ));
        assert_eq!(store.code, ErrorCode::Overloaded);
        assert_eq!(store.message, "engine-store-busy");
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
            // The search index's other carrier: a raw rusqlite failure that
            // never passed through this taxonomy, so it has no variant to
            // match and is asked about its result code directly.
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
    fn an_unsupported_fingerprint_names_its_storage_code_on_the_wire() {
        use dohc_engine_storage::StorageError;
        let fingerprint = map_runtime(RuntimeError::Storage(
            StorageError::UnsupportedFingerprint {
                found: 0,
                expected: 2,
            },
        ));
        assert_eq!(fingerprint.code, ErrorCode::Internal);
        assert_eq!(fingerprint.message, "unsupported-fingerprint");
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

    /// A session host's hosted replica refuses a named version. The write
    /// rolls back and the caller hears why, as its own input error rather than
    /// an internal storage failure.
    #[tokio::test]
    async fn a_hosted_replica_refusal_reaches_the_caller_with_its_reason() {
        use dohc_engine_runtime::{CancellationToken, NoFaults};
        use dohc_engine_storage::EngineStore;
        use std::sync::Arc;

        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        {
            let mut store = EngineStore::open(&db, 1).unwrap();
            dohc_engine_sync::create_hosted_replica(
                &mut store,
                "ws",
                "service-host:host",
                "epoch",
                "stream",
                1,
                &NoFaults,
            )
            .unwrap();
            dohc_engine_domain::VersionedTextStore::new(&mut store)
                .ensure_main_version("ws", "main", 1, &NoFaults)
                .unwrap();
        }
        let supervisor = dohc_engine_runtime::WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).unwrap().actor;
        let refused = actor
            .create_named_version(
                dohc_engine_domain::CreateNamedVersion {
                    workspace_id: "ws".into(),
                    new_version_id: "draft".into(),
                    name: "Draft".into(),
                    from_version_id: "main".into(),
                    now_ms: 2,
                    request_id: None,
                },
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        let surfaced = map_runtime(refused);
        assert_eq!(
            (surfaced.code, surfaced.message.as_str()),
            (
                ErrorCode::InvalidParams,
                "invalid-input: a hosted replica writes only its hosted documents"
            )
        );
        let versions = actor.list_versions("ws".into()).await.unwrap();
        assert_eq!(versions.len(), 1, "the refused version rolled back");
        supervisor.close(&db).unwrap();
    }

    /// Relay operations a store cannot take as a hosted replica keep their
    /// reason: creating one on a passive store, and adopting an ordinary
    /// identity on one that exists.
    #[tokio::test]
    async fn hosted_relay_refusals_reach_the_caller_with_their_reason() {
        use dohc_engine_runtime::{
            ActorHandle, CancellationToken, NoFaults, RelayConfiguration, RelayOperation,
        };
        use dohc_engine_storage::EngineStore;

        let relay = |actor: ActorHandle, operation: RelayOperation| async move {
            let refused = actor
                .relay(
                    RelayConfiguration {
                        base_url: "https://relay.invalid".to_owned(),
                        socket_path: None,
                        bearer_token: "token".to_owned(),
                        #[cfg(debug_assertions)]
                        allow_insecure_loopback_for_tests: false,
                    },
                    operation,
                    dohc_engine_collab::LeaseRegistry::default(),
                    CancellationToken::new(),
                    None,
                )
                .await
                .unwrap_err();
            let surfaced = map_runtime(refused);
            (surfaced.code, surfaced.message)
        };
        let supervisor = dohc_engine_runtime::WorkspaceSupervisor::new();

        let passive_scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let passive = dohc_engine_testkit::engine_db_path(&passive_scratch).unwrap();
        let actor = supervisor
            .open_passive_root_bound(&passive, 1, "root-token", None)
            .unwrap()
            .actor;
        assert_eq!(
            relay(
                actor,
                RelayOperation::CreateHostedReplica {
                    workspace_id: "ws".into(),
                    new_origin_id: "service-host:host".into(),
                    replication_epoch: "epoch".into(),
                    stream_identity: "stream".into(),
                    created_at_ms: 2,
                }
            )
            .await,
            (
                ErrorCode::InvalidParams,
                "invalid-input: a passive store cannot host documents".to_owned()
            )
        );
        supervisor.close(&passive).unwrap();

        let hosted_scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let hosted = dohc_engine_testkit::engine_db_path(&hosted_scratch).unwrap();
        {
            let mut store = EngineStore::open(&hosted, 1).unwrap();
            dohc_engine_sync::create_hosted_replica(
                &mut store,
                "ws",
                "service-host:host",
                "epoch",
                "stream",
                1,
                &NoFaults,
            )
            .unwrap();
        }
        let actor = supervisor.open(&hosted, 1).unwrap().actor;
        assert_eq!(
            relay(
                actor,
                RelayOperation::AdoptJoinIdentity {
                    workspace_id: "ws".into(),
                    new_origin_id: "origin".into(),
                    replication_epoch: "epoch".into(),
                    stream_identity: "stream".into(),
                    created_at_ms: 2,
                }
            )
            .await,
            (
                ErrorCode::InvalidParams,
                "invalid-input: a hosted replica uses only its hosted feed".to_owned()
            )
        );
        supervisor.close(&hosted).unwrap();
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
        // One condition must not surface under two codes depending on which
        // layer refused it. Latent today, because relay pulls convert the
        // ingest refusal before it reaches here; pinned so a second caller
        // cannot reintroduce the split.
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
    fn pending_scene_asset_delete_makes_rollback_retryable() {
        let pending = map_runtime(RuntimeError::SceneAssetDeletePending);
        assert_eq!(pending.code, ErrorCode::Overloaded);
        assert_eq!(
            pending.message,
            "Sync has not delivered every drawing asset delete. Retry the rollback after sync completes."
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
        let missing = map_runtime(RuntimeError::Relay(RelayError::WorkspaceUnavailable));
        assert_eq!(missing.code, ErrorCode::WorkspaceUnavailable);
        assert_eq!(missing.message, "relay-workspace-unavailable");
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
