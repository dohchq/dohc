//! A document lineage's owner activations. `live_owner_adoptions` keeps the
//! lineage's immutable origin. `live_owner_activations` has a row for each
//! activation that held the document since, and at most one is current.
//! Each reader names which of the three it means.
use super::*;

/// The current activation of each document lineage: its unreleased row.
pub const CURRENT_ACTIVATIONS: &str =
    "(SELECT * FROM live_owner_activations WHERE released_at_ms IS NULL)";

/// Makes the adoption `(?1, ?2)` its lineage's first current activation.
pub const ACTIVATE_ADOPTION: &str = "INSERT INTO live_owner_activations (relay_database_namespace,
    activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,origin_adoption_id,binding_json,
    source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,
    host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,
    terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms)
  SELECT relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id,adoption_id,
    binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,
    baseline_registered_at_ms,host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,
    local_ydoc_sequence,terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms
  FROM live_owner_adoptions WHERE relay_database_namespace=?1 AND adoption_id=?2";

const COLUMNS: &str =
    "relay_database_namespace,activation_id,binding_json,source_moment_id,source_digest,
    source_byte_length,host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,
    local_ydoc_sequence,terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms,
    released_at_ms IS NOT NULL,workspace_id,main_version_id,object_id,lineage_claim_id";

/// One activation as its row records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerActivation {
    pub namespace: String,
    pub activation_id: String,
    pub key: DocKey,
    pub lineage_claim_id: String,
    pub binding_json: String,
    pub source_moment_id: String,
    pub source_digest: String,
    pub source_byte_length: i64,
    pub host_coordinate_json: String,
    /// Absent only for a released activation that never adopted.
    pub adoption: Option<ActivationAdoption>,
    pub released: bool,
}

/// The facts an activation's adoption proved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationAdoption {
    pub evidence_digest: String,
    pub coverage_digest: String,
    pub covered_outbox_sequence: i64,
    pub local_ydoc_sequence: i64,
    pub terminal_cursor: i64,
    pub terminal_receipt_json: String,
    pub max_pending_bytes: i64,
    pub max_pending_age_ms: i64,
}

/// The current activation and its adoption, which a current one always has.
pub type CurrentActivation = (OwnerActivation, ActivationAdoption);

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OwnerActivation> {
    let evidence_digest: Option<String> = row.get(7)?;
    let adoption = match evidence_digest {
        None => None,
        Some(evidence_digest) => Some(ActivationAdoption {
            evidence_digest,
            coverage_digest: row.get(8)?,
            covered_outbox_sequence: row.get(9)?,
            local_ydoc_sequence: row.get(10)?,
            terminal_cursor: row.get(11)?,
            terminal_receipt_json: row.get(12)?,
            max_pending_bytes: row.get(13)?,
            max_pending_age_ms: row.get(14)?,
        }),
    };
    let key = DocKey::new(
        row.get::<_, String>(16)?,
        row.get::<_, String>(17)?,
        row.get::<_, String>(18)?,
    )
    .map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(16, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(OwnerActivation {
        namespace: row.get(0)?,
        activation_id: row.get(1)?,
        key,
        lineage_claim_id: row.get(19)?,
        binding_json: row.get(2)?,
        source_moment_id: row.get(3)?,
        source_digest: row.get(4)?,
        source_byte_length: row.get(5)?,
        host_coordinate_json: row.get(6)?,
        adoption,
        released: row.get(15)?,
    })
}

/// The lineage's immutable origin: the adoption that first activated it.
/// History stamps and event-zero origins read it, whatever holds it now.
pub fn lineage_origin_id(
    conn: &Connection,
    namespace: Option<&str>,
    key: &DocKey,
    lineage_claim_id: &str,
) -> Result<Option<String>, ApplicationError> {
    conn.query_row(
        "SELECT adoption_id FROM live_owner_adoptions WHERE (?1 IS NULL OR relay_database_namespace=?1)
         AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5",
        params![namespace, key.workspace_id, key.version_id, key.object_id, lineage_claim_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(read_sql)
}

/// The document lineage's current activation. `namespace` scopes it to one
/// relay; without it, any relay's.
pub fn current_activation(
    conn: &Connection,
    namespace: Option<&str>,
    key: &DocKey,
    lineage_claim_id: &str,
) -> Result<Option<CurrentActivation>, ApplicationError> {
    let found = conn
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM {CURRENT_ACTIVATIONS} WHERE (?1 IS NULL OR relay_database_namespace=?1)
                 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5"
            ),
            params![namespace, key.workspace_id, key.version_id, key.object_id, lineage_claim_id],
            row,
        )
        .optional()
        .map_err(read_sql)?;
    found
        .map(|mut activation| {
            let adoption = activation
                .adoption
                .take()
                .ok_or(ApplicationError::Corrupt)?;
            Ok((activation, adoption))
        })
        .transpose()
}

/// The activation `activation_id` names in `namespace`, released or not.
pub fn activation_by_id(
    conn: &Connection,
    namespace: &str,
    activation_id: &str,
) -> Result<Option<OwnerActivation>, ApplicationError> {
    conn.query_row(
        &format!(
            "SELECT {COLUMNS} FROM live_owner_activations WHERE relay_database_namespace=?1 AND activation_id=?2"
        ),
        params![namespace, activation_id],
        row,
    )
    .optional()
    .map_err(read_sql)
}

/// The activation a registration serves. A named one is the lineage's current
/// activation, or a retained source no activation recorded yet while nothing
/// holds the lineage, which its adoption will activate. Without a name, the
/// registration serves the current activation, if any.
pub(super) fn registration_activation(
    conn: &Connection,
    namespace: &str,
    binding: &LiveObjectBinding,
    requested: Option<&str>,
) -> Result<Option<String>, ApplicationError> {
    let key = DocKey::new(
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )?;
    let current = current_activation(conn, None, &key, &binding.lineage_claim_id)?
        .map(|(activation, _)| activation);
    let Some(requested) = requested else {
        return Ok(current
            .filter(|activation| activation.namespace == namespace)
            .map(|activation| activation.activation_id));
    };
    identifier(requested, 1024)?;
    let serves = match current {
        Some(current) => current.namespace == namespace && current.activation_id == requested,
        None => conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ydoc_owner_activation_sources WHERE activation_id=?1
                   AND relay_database_namespace=?2 AND workspace_id=?3 AND version_id=?4 AND object_id=?5
                   AND lineage_claim_id=?6)
                 AND NOT EXISTS(SELECT 1 FROM live_owner_activations WHERE relay_database_namespace=?2 AND activation_id=?1)",
                params![requested, namespace, key.workspace_id, key.version_id, key.object_id, binding.lineage_claim_id],
                |row| row.get(0),
            )
            .map_err(read_sql)?,
    };
    if !serves {
        return Err(ApplicationError::Conflict);
    }
    Ok(Some(requested.to_owned()))
}
