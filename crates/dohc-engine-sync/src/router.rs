use dohc_engine_storage::{EngineStore, FaultInjector};

use crate::{ApplyOutcome, LeaseProbe, ReplicationEnvelope, SyncError};

pub fn apply_replication_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
) -> Result<ApplyOutcome<()>, SyncError> {
    match envelope.op_kind.as_str() {
        "chat.channel.create"
        | "chat.thread.create"
        | "chat.message.append"
        | "chat.decision.set"
        | "chat.attachment.add"
        | "chat.reaction.set"
        | "chat.follow.set"
        | "chat.feed.read.set" => crate::apply_chat_envelope(store, envelope, faults),
        "secret.file.put" | "secret.file.delete" | "secret.version.fork" => {
            crate::apply_secret_envelope(store, envelope, faults)
        }
        "ydoc.update" => erase(crate::apply_ydoc_envelope(store, envelope, faults, leases)),
        "conflict.open" | "conflict.resolve" => {
            erase(crate::apply_conflict_envelope(store, envelope, faults))
        }
        "workspace.init" => crate::version_apply::apply_workspace_envelope(store, envelope, faults),
        "version.create" => crate::version_apply::apply_version_envelope(store, envelope, faults),
        "moment.append" => erase(crate::apply_moment_envelope(store, envelope, faults)),
        _ => Err(SyncError::UnsupportedOperation),
    }
}

fn erase<T>(result: Result<ApplyOutcome<T>, SyncError>) -> Result<ApplyOutcome<()>, SyncError> {
    result.map(|outcome| match outcome {
        ApplyOutcome::Applied(_) => ApplyOutcome::Applied(()),
        ApplyOutcome::Skipped => ApplyOutcome::Skipped,
        ApplyOutcome::Crashed { committed } => ApplyOutcome::Crashed { committed },
    })
}
