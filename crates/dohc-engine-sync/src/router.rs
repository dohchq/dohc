use dohc_engine_storage::{EngineStore, FaultInjector};

use crate::{ApplyOutcome, LeaseProbe, ReplicationEnvelope, SyncError};

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
) -> Result<ApplyOutcome<()>, SyncError> {
    let route = OWNED_OP_ROUTES
        .iter()
        .find_map(|(kind, route)| (*kind == envelope.op_kind).then_some(*route))
        .ok_or(SyncError::UnsupportedOperation)?;
    match route {
        OwnedRoute::Chat => crate::apply_chat_envelope(store, envelope, faults),
        OwnedRoute::Secret => crate::apply_secret_envelope(store, envelope, faults),
        OwnedRoute::Ydoc => erase(crate::apply_ydoc_envelope(store, envelope, faults, leases)),
        OwnedRoute::Conflict => erase(crate::apply_conflict_envelope(store, envelope, faults)),
        OwnedRoute::Workspace => {
            crate::version_apply::apply_workspace_envelope(store, envelope, faults)
        }
        OwnedRoute::Version => {
            crate::version_apply::apply_version_envelope(store, envelope, faults)
        }
        OwnedRoute::Moment => apply_unimplemented_moment_envelope(store, envelope, faults),
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

fn erase<T>(result: Result<ApplyOutcome<T>, SyncError>) -> Result<ApplyOutcome<()>, SyncError> {
    result.map(|outcome| match outcome {
        ApplyOutcome::Applied(_) => ApplyOutcome::Applied(()),
        ApplyOutcome::Skipped => ApplyOutcome::Skipped,
        ApplyOutcome::Crashed { committed } => ApplyOutcome::Crashed { committed },
    })
}
