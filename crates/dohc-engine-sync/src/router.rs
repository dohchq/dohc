use dohc_engine_storage::{EngineStore, FaultInjector};

use crate::{ApplyOutcome, ConflictApplyResult, LeaseProbe, ReplicationEnvelope, SyncError};

/// What one routed envelope produced beyond "it applied". A Y.Doc update
/// parked behind a live lease has its exact coordinate committed to
/// `ydoc_deferred_updates` with the ack, and lease
/// teardown/open (or the next non-leased update) replays it through
/// `drain_deferred_ydoc_for_key`. It requires no caller action, so the router
/// deliberately does not carry its transient `YdocApplyResult`. A terminal
/// refusal discovered by that drain is different and remains attached to the
/// routed outcome until the relay cursor commits.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RoutedApply {
    pub conflict: Option<ConflictApplyResult>,
    pub conflicts_opened: i64,
    pub materialization_changes: Vec<crate::MomentMaterializationChange>,
}

pub(crate) fn redelivered_materialization_changes(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<Vec<crate::MomentMaterializationChange>, SyncError> {
    match envelope.op_kind.as_str() {
        "moment.append" => {
            crate::moment_apply::redelivered_materialization_changes(store, envelope)
        }
        "ydoc.update" => crate::ydoc_apply::redelivered_materialization_changes(store, envelope),
        "conflict.resolve" => {
            crate::conflict_apply::redelivered_materialization_changes(store, envelope)
        }
        "secret.file.put" | "secret.file.delete" | "secret.version.fork" => {
            crate::secret_apply::redelivered_materialization_changes(store, envelope)
        }
        _ => Ok(Vec::new()),
    }
}

pub(crate) fn redelivered_conflicts_opened(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<i64, SyncError> {
    match envelope.op_kind.as_str() {
        "conflict.open" => crate::conflict_apply::redelivered_conflicts_opened(store, envelope),
        "moment.append" => crate::moment_apply::redelivered_conflicts_opened(store, envelope),
        "ydoc.update" => crate::ydoc_apply::redelivered_conflicts_opened(store, envelope),
        _ => Ok(0),
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

/// Whether this engine knows the op kind at all.
///
/// The share boundary asks so it can tell two refusals apart: a KNOWN kind a
/// share does not carry is a scope decision, and a kind this engine cannot
/// interpret is not — no grant admits it, and only the sender can fix it.
/// One list answers both, so a new op kind cannot drift into the wrong class.
pub(crate) fn is_owned_op_kind(kind: &str) -> bool {
    OWNED_OP_ROUTES.iter().any(|(owned, _)| *owned == kind)
}

pub fn apply_replication_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
) -> Result<ApplyOutcome<RoutedApply>, SyncError> {
    let Some(route) = OWNED_OP_ROUTES
        .iter()
        .find_map(|(kind, route)| (*kind == envelope.op_kind).then_some(*route))
    else {
        // Forward compatibility: an older client cannot interpret a newer
        // peer's operation, but permanently wedging that origin prevents it
        // from receiving every later operation it *does* understand.
        return plain(crate::apply_envelope_with(
            store,
            envelope,
            faults,
            |_tx, _op| Err(SyncError::UnsupportedOperation),
        ));
    };
    match route {
        OwnedRoute::Chat => plain(crate::apply_chat_envelope(store, envelope, faults)),
        OwnedRoute::Secret => map_applied(
            crate::secret_apply::apply_secret_envelope_detailed(store, envelope, faults),
            |secret| RoutedApply {
                materialization_changes: secret.materialization_changes,
                ..RoutedApply::default()
            },
        ),
        OwnedRoute::Ydoc => map_applied(
            crate::apply_ydoc_envelope(store, envelope, faults, leases),
            |ydoc| RoutedApply {
                conflicts_opened: ydoc.conflicts_opened,
                ..RoutedApply::default()
            },
        ),
        OwnedRoute::Conflict => map_applied(
            crate::apply_conflict_envelope(store, envelope, faults, leases),
            |conflict| {
                let conflicts_opened = i64::from(conflict.inserted == Some(true));
                RoutedApply {
                    conflict: Some(conflict),
                    conflicts_opened,
                    ..RoutedApply::default()
                }
            },
        ),
        OwnedRoute::Workspace => plain(crate::version_apply::apply_workspace_envelope(
            store, envelope, faults,
        )),
        OwnedRoute::Version => plain(crate::version_apply::apply_version_envelope(
            store, envelope, faults,
        )),
        OwnedRoute::Moment => map_applied(
            crate::moment_apply::apply_moment_envelope_detailed(store, envelope, faults, leases),
            |moment| RoutedApply {
                conflicts_opened: moment.conflicts_opened,
                materialization_changes: moment.materialization_changes,
                ..RoutedApply::default()
            },
        ),
    }
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
    result.map(|outcome| {
        let (primary, refusals, sharing_declined) = outcome.into_primary_and_diagnostics();
        let mapped = match primary {
            ApplyOutcome::Applied(value) => ApplyOutcome::Applied(wrap(value)),
            ApplyOutcome::Refused(refusal) => ApplyOutcome::Refused(refusal),
            ApplyOutcome::Skipped => ApplyOutcome::Skipped,
            ApplyOutcome::Crashed { committed } => ApplyOutcome::Crashed { committed },
            ApplyOutcome::WithDiagnostics { .. } => unreachable!("diagnostics were flattened"),
        };
        mapped
            .with_refusals(refusals)
            .with_sharing_declined(sharing_declined)
    })
}
