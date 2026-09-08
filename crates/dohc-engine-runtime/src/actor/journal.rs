//! Transaction helpers for outbound replication journals.

use dohc_engine_domain::{
    DomainError, SecretMomentRecord, SecretOp, SecretWriteResult, VersionRecord,
};
use dohc_engine_storage::StorageError;

fn outbound_domain(error: dohc_engine_sync::SyncError) -> DomainError {
    DomainError::Storage(StorageError::persist_public(std::io::Error::other(
        format!("outbound replication journal append failed: {error}"),
    )))
}

fn relay_enabled_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
) -> Result<bool, DomainError> {
    dohc_engine_sync::workspace_replicates_with_relay_in_tx(tx, workspace_id)
        .map_err(outbound_domain)
}

/// File moments are the one kind a share view can carry, so this reads the
/// wider `workspace_journals_file_moments_in_tx`. It is not the only site
/// that does: `ydoc_recovery.rs` journals a recovered FILE moment and asks
/// the same question, and the two must agree or a recovery would strand a
/// change the recipient can see but never send.
///
/// Every sibling below stays on the owner-lane predicate: a share view
/// creates no versions and writes no secrets, and journaling either would
/// leave rows nothing drains.
pub(super) fn journal_moment_outbound_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    moment_id: &str,
    deduped: bool,
) -> Result<(), DomainError> {
    let mut eligibility = None;
    journal_moment_outbound_with_batch_in_tx(tx, workspace_id, moment_id, deduped, &mut eligibility)
}

pub(super) fn journal_moment_outbound_with_batch_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    moment_id: &str,
    deduped: bool,
    eligibility: &mut Option<bool>,
) -> Result<(), DomainError> {
    if deduped {
        return Ok(());
    }
    let journals_file_moments = match *eligibility {
        Some(eligible) => eligible,
        None => {
            let eligible =
                dohc_engine_sync::workspace_journals_file_moments_in_tx(tx, workspace_id)
                    .map_err(outbound_domain)?;
            *eligibility = Some(eligible);
            eligible
        }
    };
    if !journals_file_moments {
        return Ok(());
    }
    dohc_engine_sync::journal_moment_append_in_tx(tx, workspace_id, moment_id)
        .map_err(outbound_domain)
}

pub(super) fn journal_secret_put_outbound_in_tx(
    tx: &rusqlite::Transaction<'_>,
    result: &SecretWriteResult,
) -> Result<(), DomainError> {
    let Some(moment) = result.moment.as_ref() else {
        return Ok(());
    };
    journal_secret_put_moment_outbound_in_tx(tx, moment)
}

pub(super) fn journal_secret_moment_outbound_in_tx(
    tx: &rusqlite::Transaction<'_>,
    moment: Option<&SecretMomentRecord>,
) -> Result<(), DomainError> {
    let Some(moment) = moment else {
        return Ok(());
    };
    match moment.operation {
        SecretOp::Write => journal_secret_put_moment_outbound_in_tx(tx, moment),
        SecretOp::Delete => journal_secret_delete_outbound_in_tx(tx, moment),
    }
}

fn journal_secret_put_moment_outbound_in_tx(
    tx: &rusqlite::Transaction<'_>,
    moment: &SecretMomentRecord,
) -> Result<(), DomainError> {
    if !relay_enabled_in_tx(tx, &moment.workspace_id)? {
        return Ok(());
    }
    dohc_engine_sync::journal_secret_put_in_tx(tx, moment).map_err(outbound_domain)
}

pub(super) fn journal_secret_delete_outbound_in_tx(
    tx: &rusqlite::Transaction<'_>,
    moment: &SecretMomentRecord,
) -> Result<(), DomainError> {
    if !relay_enabled_in_tx(tx, &moment.workspace_id)? {
        return Ok(());
    }
    dohc_engine_sync::journal_secret_delete_in_tx(tx, moment).map_err(outbound_domain)
}

pub(super) fn journal_secret_fork_outbound_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    from_version_id: &str,
    to_version_id: &str,
    recorded_at_ms: i64,
) -> Result<(), DomainError> {
    if !relay_enabled_in_tx(tx, workspace_id)? {
        return Ok(());
    }
    dohc_engine_sync::journal_secret_version_fork_in_tx(
        tx,
        workspace_id,
        from_version_id,
        to_version_id,
        recorded_at_ms,
    )
    .map_err(outbound_domain)
}

pub(super) fn journal_version_create_outbound_in_tx(
    tx: &rusqlite::Transaction<'_>,
    record: &VersionRecord,
    from_version_id: &str,
) -> Result<(), DomainError> {
    if !relay_enabled_in_tx(tx, &record.workspace_id)? {
        return Ok(());
    }
    dohc_engine_sync::journal_version_create_in_tx(tx, record).map_err(outbound_domain)?;
    dohc_engine_sync::journal_secret_version_fork_in_tx(
        tx,
        &record.workspace_id,
        from_version_id,
        &record.version_id,
        record.created_at_ms,
    )
    .map_err(outbound_domain)
}
