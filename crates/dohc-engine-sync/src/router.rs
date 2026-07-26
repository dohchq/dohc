use dohc_engine_storage::{EngineStore, FaultInjector};

use crate::{ApplyOutcome, ConflictApplyResult, LeaseProbe, ReplicationEnvelope, SyncError};

/// What one routed envelope produced beyond "it applied". Appliers that fail
/// closed into a pending decision must reach the caller intact: a conflict
/// resolve the receiver could not safely apply is acked and the relay cursor
/// advances, so a count-only result would drop that decision permanently.
///
/// A Y.Doc update parked behind a live lease is different: its exact
/// coordinate is committed to `ydoc_deferred_updates` with the ack, and lease
/// teardown/open (or the next non-leased update) replays it through
/// `drain_deferred_ydoc_for_key`. It requires no caller action, so the router
/// deliberately does not carry its transient `YdocApplyResult`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RoutedApply {
    pub conflict: Option<ConflictApplyResult>,
}

impl RoutedApply {
    /// The pending resolution this envelope surfaced, if any.
    pub fn pending_resolve(&self) -> Option<&crate::PendingResolve> {
        self.conflict
            .as_ref()
            .and_then(|result| result.pending_resolve.as_ref())
    }
}

#[derive(Clone, Copy)]
enum OwnedRoute {
    Chat,
    Secret,
    Ydoc,
    Conflict,
    Workspace,
    Version,
    Moment,
}

const OWNED_OP_ROUTES: &[(&str, OwnedRoute)] = &[
    ("chat.channel.create", OwnedRoute::Chat),
    ("chat.thread.create", OwnedRoute::Chat),
    ("chat.message.append", OwnedRoute::Chat),
    ("chat.decision.set", OwnedRoute::Chat),
    ("chat.attachment.add", OwnedRoute::Chat),
    ("chat.reaction.set", OwnedRoute::Chat),
    ("chat.follow.set", OwnedRoute::Chat),
    ("chat.feed.read.set", OwnedRoute::Chat),
    ("secret.file.put", OwnedRoute::Secret),
    ("secret.file.delete", OwnedRoute::Secret),
    ("secret.version.fork", OwnedRoute::Secret),
    ("ydoc.update", OwnedRoute::Ydoc),
    ("conflict.open", OwnedRoute::Conflict),
    ("conflict.resolve", OwnedRoute::Conflict),
    ("workspace.init", OwnedRoute::Workspace),
    ("version.create", OwnedRoute::Version),
    ("moment.append", OwnedRoute::Moment),
];

#[cfg(test)]
pub(crate) fn owned_op_kinds() -> impl Iterator<Item = &'static str> {
    OWNED_OP_ROUTES.iter().map(|(kind, _)| *kind)
}

pub fn apply_replication_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
) -> Result<ApplyOutcome<RoutedApply>, SyncError> {
    let route = OWNED_OP_ROUTES
        .iter()
        .find_map(|(kind, route)| (*kind == envelope.op_kind).then_some(*route))
        .ok_or(SyncError::UnsupportedOperation)?;
    match route {
        OwnedRoute::Chat => plain(crate::apply_chat_envelope(store, envelope, faults)),
        OwnedRoute::Secret => plain(crate::apply_secret_envelope(store, envelope, faults)),
        OwnedRoute::Ydoc => map_applied(
            crate::apply_ydoc_envelope(store, envelope, faults, leases),
            |_ydoc| RoutedApply::default(),
        ),
        OwnedRoute::Conflict => map_applied(
            crate::apply_conflict_envelope(store, envelope, faults),
            |conflict| RoutedApply {
                conflict: Some(conflict),
            },
        ),
        OwnedRoute::Workspace => plain(crate::version_apply::apply_workspace_envelope(
            store, envelope, faults,
        )),
        OwnedRoute::Version => plain(crate::version_apply::apply_version_envelope(
            store, envelope, faults,
        )),
        OwnedRoute::Moment => plain(apply_unimplemented_moment_envelope(store, envelope, faults)),
    }
}

fn apply_unimplemented_moment_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    crate::apply_envelope_with(store, envelope, faults, |_tx, _op| {
        Err(SyncError::MomentAppendNotImplemented)
    })
}

fn plain(
    result: Result<ApplyOutcome<()>, SyncError>,
) -> Result<ApplyOutcome<RoutedApply>, SyncError> {
    map_applied(result, |()| RoutedApply::default())
}

fn map_applied<T>(
    result: Result<ApplyOutcome<T>, SyncError>,
    wrap: impl FnOnce(T) -> RoutedApply,
) -> Result<ApplyOutcome<RoutedApply>, SyncError> {
    result.map(|outcome| match outcome {
        ApplyOutcome::Applied(value) => ApplyOutcome::Applied(wrap(value)),
        ApplyOutcome::Skipped => ApplyOutcome::Skipped,
        ApplyOutcome::Crashed { committed } => ApplyOutcome::Crashed { committed },
    })
}
