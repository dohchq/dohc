use super::*;
use crate::live_object_binding::{
    LIVE_OBJECT_BINDING_PATH_MAX_BYTES, LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT,
};

// JSON can escape each path byte as six bytes, plus quotes, separators and brackets.
pub(super) const MAX_SELECTOR_JSON_BYTES: usize =
    LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT * (LIVE_OBJECT_BINDING_PATH_MAX_BYTES * 6 + 3) + 1;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveApplicationAckIdentity {
    pub delivery_id: String,
    pub update_digest: String,
}

impl LiveApplicationAckIdentity {
    pub fn validate(&self) -> Result<(), ApplicationError> {
        identifier(&self.delivery_id, 512)?;
        digest(&self.update_digest)
    }
}

/// Read retained host application evidence through a current document registration.
/// This neither applies bytes nor treats a relay receipt as proof of application.
pub fn read_application_ack(
    store: &EngineStore,
    handle: &ApplicationHandle,
    identity: &LiveApplicationAckIdentity,
) -> Result<Option<LiveUpdateHostApplicationAck>, ApplicationError> {
    identity.validate()?;
    let held = handle
        .registration
        .lock()
        .map_err(|_| ApplicationError::Interrupted)?;
    if !held.live {
        return Err(ApplicationError::Interrupted);
    }
    let b = &held.binding;
    settlement::validate_historical_binding(b, b)?;
    let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    store.read_with(|conn| {
        let read_tx=conn.unchecked_transaction().map_err(read_sql)?;
        let conn=&*read_tx;
        require_workspace(conn, &held)?;
        if !read_binding(conn, &held)?.is_some_and(|(binding, coordinate, available)|
            available && binding == *b && coordinate == held.coordinate) {
            return Err(ApplicationError::Interrupted);
        }
        restore_fence::require_registration(conn, &key, &held.namespace, b)?;
        let Some(marker) = durable::read_marker_in(conn, &key)? else { return Ok(None); };
        if marker.regime != Regime::Replicated || marker.lineage_claim_status != durable::LineageClaimStatus::Exact
            || marker.lineage_claim_id.as_deref() != Some(&b.lineage_claim_id)
            || marker.path.as_deref() != Some(&b.current_path) {
            return Err(ApplicationError::Conflict);
        }
        // Compare document coordinates in SQLite before reading bounded historical selectors.
        let row: Option<(bool, bool, i64, i64, i64, i64)> = conn.query_row(
            "SELECT workspace_id=?3 AND main_version_id=?4 AND object_id=?5 AND lineage_claim_id=?6 AND current_path=?7 AND restore_fence_generation=?8, update_digest=?9, journal_cursor, accepting_host_epoch, local_ydoc_sequence, length(CAST(selector_paths_json AS BLOB)) FROM live_device_update_applications WHERE relay_database_namespace=?1 AND delivery_id=?2",
            params![held.namespace, identity.delivery_id, b.workspace_id, b.main_version_id, b.object_id,
                b.lineage_claim_id, b.current_path, b.restore_fence_generation, identity.update_digest],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        ).optional().map_err(read_sql)?;
        let Some((same_binding, same_digest, cursor, epoch, sequence, selector_bytes)) = row else { return Ok(None); };
        if !same_binding || !same_digest { return Err(ApplicationError::Conflict); }
        if !(2..=MAX_SELECTOR_JSON_BYTES as i64).contains(&selector_bytes) { return Err(ApplicationError::Corrupt); }
        let selectors: String = conn.query_row(
            "SELECT selector_paths_json FROM live_device_update_applications WHERE relay_database_namespace=?1 AND delivery_id=?2",
            params![held.namespace, identity.delivery_id], |row| row.get(0),
        ).map_err(read_sql)?;
        let historical = LiveObjectBinding {
            selector_paths: serde_json::from_str(&selectors).map_err(|_| ApplicationError::Corrupt)?,
            ..b.clone()
        };
        historical.validate_canonical().map_err(|_| ApplicationError::Corrupt)?;
        settlement::validate_historical_binding(&historical, b)?;
        let receipt = LiveUpdateReceipt {
            delivery_id: identity.delivery_id.clone(), update_digest: identity.update_digest.clone(),
            journal_cursor: cursor, accepting_host_epoch: epoch,
        };
        receipt.validate().map_err(|_| ApplicationError::Corrupt)?;
        integer(sequence, 1, SAFE).map_err(|_| ApplicationError::Corrupt)?;
        if sequence > marker.head_update_seq { return Err(ApplicationError::Corrupt); }
        Ok(Some(LiveUpdateHostApplicationAck::new(&receipt, sequence, true)))
    })
}
