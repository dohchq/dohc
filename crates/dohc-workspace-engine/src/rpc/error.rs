use crate::capture_driver;
use crate::root_binding;
use dohc_engine_collab::CollabError;
use dohc_engine_collab::OwnerOutboxError;
use dohc_engine_collab::live_update_application::ApplicationError;
use dohc_engine_domain::DomainError;
use dohc_engine_protocol::error::ErrorCode;
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
        OwnerOutboxError::InvalidInput(_) => "invalid-owner-outbox-input",
        OwnerOutboxError::WorkspaceMismatch => "owner-outbox-workspace-mismatch",
        OwnerOutboxError::MainVersionMismatch => "owner-outbox-main-version-mismatch",
        OwnerOutboxError::ParentMismatch => "owner-outbox-parent-mismatch",
        OwnerOutboxError::AppendKeyMismatch => "owner-outbox-append-key-mismatch",
        OwnerOutboxError::Frozen => "owner-outbox-frozen",
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
fn store_busy(error: &RuntimeError) -> bool {
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
    let error = match error {
        RuntimeError::LiveApplication(ApplicationError::Storage(error)) => {
            RuntimeError::Storage(error)
        }
        RuntimeError::LiveApplication(ApplicationError::Collab(error)) => {
            RuntimeError::Collab(error)
        }
        error => error,
    };
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
        &error,
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
    if store_busy(&error) {
        return WireError::new(ErrorCode::Overloaded, "engine-store-busy");
    }
    // Keep the storage refusal code so the desktop can offer move-aside
    // recovery instead of reporting a generic workspace failure.
    if let RuntimeError::Storage(
        refused @ (dohc_engine_storage::StorageError::UnsupportedFingerprint { .. }
        | dohc_engine_storage::StorageError::ForeignDatabase),
    ) = &error
    {
        return WireError::new(ErrorCode::Internal, refused.code());
    }
    match &error {
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
        RuntimeError::Relay(RelayError::OriginDiverged) => {
            return WireError::new(ErrorCode::InvalidParams, "relay-origin-diverged");
        }
        RuntimeError::Relay(RelayError::ShareReadOnly) => {
            return WireError::new(ErrorCode::InvalidParams, "share-read-only");
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
        _ => {}
    }
    if let RuntimeError::LiveApplication(ref application) = error {
        let code = match application {
            ApplicationError::InvalidInput(_)
            | ApplicationError::WorkspaceMismatch
            | ApplicationError::MainVersionMismatch => ErrorCode::InvalidParams,
            ApplicationError::Conflict => ErrorCode::Conflict,
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
        _ => ErrorCode::Internal,
    };
    WireError::new(code, "workspace operation failed")
}

fn map_relay_code(error: RelayError) -> ErrorCode {
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
        RelayError::DiscussionRateLimited | RelayError::LinkReadRateLimited => {
            ErrorCode::Overloaded
        }
        RelayError::NoProgress => ErrorCode::RelayNoProgress,
        RelayError::BlobMissing => ErrorCode::BlobMissing,
        RelayError::BlobReferenceMissing => ErrorCode::BlobReferenceMissing,
        RelayError::BlobInvalid => ErrorCode::BlobInvalid,
        RelayError::IdentityRequired => ErrorCode::IdentityRequired,
        RelayError::StreamIdentityMismatch => ErrorCode::StreamIdentityMismatch,
        RelayError::AuthorshipMismatch => ErrorCode::AuthorshipMismatch,
        RelayError::UnknownChatOperation => ErrorCode::UnknownChatOperation,
        RelayError::PresenceCapacity => ErrorCode::PresenceCapacity,
        RelayError::SelfShare => ErrorCode::SelfShare,
        RelayError::AmbiguousSelector => ErrorCode::AmbiguousSelector,
        RelayError::InvalidChannel => ErrorCode::InvalidChannel,
        RelayError::MethodNotAllowed => ErrorCode::RelayMethodNotAllowed,
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
        RelayError::BadRequest => ErrorCode::InvalidParams,
    }
}

fn map_domain(error: DomainError) -> WireError {
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
        DomainError::TargetPathExists => (InvalidParams, "target-path-exists"),
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
        DomainError::InvalidInput { .. } => (InvalidParams, "invalid-input"),
        DomainError::StateCorrupt { .. } => (Internal, "state-corrupt"),
        DomainError::Storage(_) => (Internal, "persist-failed"),
        DomainError::Chat {
            code: "state-corrupt",
            ..
        } => (Internal, "state-corrupt"),
        DomainError::Chat { code, .. } => (InvalidParams, code),
        DomainError::Crypto(error) => {
            let code = match error {
                CryptoError::InvalidIvLength
                | CryptoError::InvalidTagLength
                | CryptoError::PlaintextTooLarge
                | CryptoError::PlaintextNotUtf8
                | CryptoError::InvalidBase64 => InvalidParams,
                CryptoError::DecryptFailed
                | CryptoError::InvalidKeyLength
                | CryptoError::KeyFileMalformed => Internal,
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

fn map_collab_code(error: CollabError) -> ErrorCode {
    match error {
        CollabError::Corrupt { .. } | CollabError::Storage(_) => ErrorCode::Internal,
        CollabError::MalformedUpdate { .. }
        | CollabError::ReplayParityViolation { .. }
        | CollabError::EmptyUpdate
        | CollabError::UpdateTooLarge { .. }
        | CollabError::ProjectionTooLarge { .. }
        | CollabError::ProjectionTooComplex { .. }
        | CollabError::InvalidIdentifier { .. }
        | CollabError::ContentKindMismatch
        | CollabError::UnsupportedContentKind { .. }
        | CollabError::MarkdownRewriteUnsupported { .. }
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
        | CollabError::UnsettledClose => ErrorCode::InvalidParams,
    }
}

fn map_sync_code(error: SyncError) -> ErrorCode {
    match error {
        SyncError::Storage(_)
        | SyncError::SequenceGap
        | SyncError::CoordinateDiverged
        // Retryable state conditions are transient by definition; Internal is
        // the retry-eligible class on this surface (InvalidParams is terminal).
        | SyncError::RetryableState { .. }
        | SyncError::FaultCrash => ErrorCode::Internal,
        SyncError::InvalidInput { .. }
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

fn map_search_code(error: SearchError) -> ErrorCode {
    match error {
        SearchError::Bounds(_) => ErrorCode::InvalidParams,
        SearchError::Storage(_) | SearchError::Store(_) | SearchError::Corrupt(_) => {
            ErrorCode::Internal
        }
    }
}

pub(super) fn map_root_binding(error: root_binding::RootBindingError) -> WireError {
    WireError::new(ErrorCode::InvalidParams, error.to_string())
}

pub(super) fn initial_capture_updating() -> WireError {
    WireError::new(
        ErrorCode::Overloaded,
        "Workspace is still updating. Try again.",
    )
}

pub(super) fn workspace_unavailable() -> WireError {
    WireError::new(
        ErrorCode::WorkspaceUnavailable,
        "workspace handle is unavailable",
    )
}

#[cfg(test)]
mod tests {
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
        ] {
            let expected = match &error {
                RuntimeError::LiveApplication(ApplicationError::Storage(inner)) => inner.code(),
                _ => unreachable!(),
            };
            assert_eq!(map_runtime(error).message, expected);
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

        let storage =
            dohc_engine_storage::StorageError::persist_public(rusqlite::Error::InvalidQuery);
        let persisted = map_runtime(RuntimeError::Sync(SyncError::Storage(storage)));
        assert_eq!(persisted.code, ErrorCode::Internal);

        let invalid = map_runtime(RuntimeError::Domain(DomainError::InvalidInput {
            reason: "test invalid input",
        }));
        assert_eq!(invalid.code, ErrorCode::InvalidParams);

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
        // One condition must not surface under two codes depending on which
        // layer refused it. Latent today, because relay pulls convert the
        // ingest refusal before it reaches here; pinned so a second caller
        // cannot reintroduce the split.
        assert_eq!(
            map_sync_code(SyncError::BlobTooLarge {
                constraint: "MAX_CAPTURE_BINARY_FILE_BYTES",
                limit_bytes: 5 * 1024 * 1024,
                observed_bytes: 5 * 1024 * 1024 + 1,
            }),
            map_relay_code(RelayError::BlobTooLarge {
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
            (RelayError::PresenceCapacity, ErrorCode::PresenceCapacity),
            (RelayError::SelfShare, ErrorCode::SelfShare),
            (RelayError::AmbiguousSelector, ErrorCode::AmbiguousSelector),
            (RelayError::InvalidChannel, ErrorCode::InvalidChannel),
            (
                RelayError::MethodNotAllowed,
                ErrorCode::RelayMethodNotAllowed,
            ),
            (RelayError::InvalidResponse, ErrorCode::RelayInvalidResponse),
        ];
        for (relay, expected) in cases {
            assert_eq!(
                map_relay_code(relay),
                expected,
                "collapsing a relay condition prevents generated clients from recovering"
            );
        }
        assert_eq!(
            map_relay_code(RelayError::Partitioned),
            ErrorCode::WorkspaceUnavailable
        );
        for relay in [
            RelayError::DiscussionRateLimited,
            RelayError::LinkReadRateLimited,
        ] {
            let wire = map_runtime(RuntimeError::Relay(relay));
            assert_eq!(wire.code, ErrorCode::Overloaded);
            assert_eq!(wire.retry, dohc_engine_protocol::Retryability::AfterBackoff);
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
