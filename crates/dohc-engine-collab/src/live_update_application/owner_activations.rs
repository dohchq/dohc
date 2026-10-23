//! A document lineage's owner activations. `live_owner_adoptions` keeps the
//! lineage's immutable origin. `live_owner_activations` has a row for each
//! activation that held the document since, and at most one is current.
//! Each reader names which it means: the origin, the current activation, an
//! exact one, or the released tail a successor follows.
use super::*;

/// The current activation of each document lineage: its unreleased row.
pub const CURRENT_ACTIVATIONS: &str =
    "(SELECT * FROM live_owner_activations WHERE released_at_ms IS NULL)";

/// Each lineage's current activation, and each released tail that carried
/// deliveries no successor applied yet: the relay accepted them, and its
/// native log still holds them unapplied.
pub const RETAINED_ACTIVATIONS: &str = "(SELECT * FROM live_owner_activations v
    WHERE released_at_ms IS NULL OR (json_array_length(carried_manifest_json)>0
      AND NOT EXISTS(SELECT 1 FROM live_owner_activations s
        WHERE s.relay_database_namespace=v.relay_database_namespace AND s.predecessor_activation_id=v.activation_id)))";

/// Makes the adoption `(?1, ?2)` its lineage's first current activation,
/// following the released capture `?3` its own capture named, if any.
pub const ACTIVATE_ADOPTION: &str = "INSERT INTO live_owner_activations (relay_database_namespace,
    activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,origin_adoption_id,
    predecessor_activation_id,binding_json,
    source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,
    host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,
    terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms)
  SELECT relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id,adoption_id,
    ?3,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,
    baseline_registered_at_ms,host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,
    local_ydoc_sequence,terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms
  FROM live_owner_adoptions WHERE relay_database_namespace=?1 AND adoption_id=?2";

const COLUMNS: &str =
    "relay_database_namespace,activation_id,binding_json,source_moment_id,source_digest,
    source_byte_length,host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,
    local_ydoc_sequence,terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms,
    released_at_ms IS NOT NULL,workspace_id,main_version_id,object_id,lineage_claim_id,
    predecessor_activation_id";

/// One activation as its row records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerActivation {
    pub namespace: String,
    pub activation_id: String,
    pub key: DocKey,
    pub lineage_claim_id: String,
    /// The released activation it followed; none for a chain's first.
    pub predecessor_activation_id: Option<String>,
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

#[cfg(test)]
thread_local! {
    static ACTIVATION_READS_HERE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// How many activations the calling thread read whole.
#[cfg(test)]
pub(crate) fn activation_reads_on_this_thread() -> u64 {
    ACTIVATION_READS_HERE.with(std::cell::Cell::get)
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OwnerActivation> {
    #[cfg(test)]
    ACTIVATION_READS_HERE.with(|reads| reads.set(reads.get() + 1));
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
        predecessor_activation_id: row.get(20)?,
        binding_json: row.get(2)?,
        source_moment_id: row.get(3)?,
        source_digest: row.get(4)?,
        source_byte_length: row.get(5)?,
        host_coordinate_json: row.get(6)?,
        adoption,
        released: row.get(15)?,
    })
}

/// Whether a retained activation of one of the workspace's documents adopted
/// outbox limits above these, which a configured host's budget must cover.
/// A released tail that never adopted carries its predecessor's deliveries
/// under the limits they were accepted with: those of the last activation in
/// its chain that adopted.
pub fn retained_limits_exceed(
    conn: &Connection,
    workspace_id: &str,
    max_pending_bytes: i64,
    max_pending_age_ms: i64,
) -> Result<bool, ApplicationError> {
    conn.query_row(
        &format!(
            "WITH RECURSIVE provenance(namespace,predecessor,max_pending_bytes,max_pending_age_ms) AS (
               SELECT a.relay_database_namespace,a.predecessor_activation_id,a.max_pending_bytes,a.max_pending_age_ms
                 FROM {RETAINED_ACTIVATIONS} a JOIN ydoc_docs d
                   ON d.workspace_id=a.workspace_id AND d.version_id=a.main_version_id AND d.object_id=a.object_id
                   AND d.lineage_claim_id=a.lineage_claim_id
                 WHERE a.workspace_id=?1
               UNION ALL
               SELECT v.relay_database_namespace,v.predecessor_activation_id,v.max_pending_bytes,v.max_pending_age_ms
                 FROM provenance p JOIN live_owner_activations v
                   ON v.relay_database_namespace=p.namespace AND v.activation_id=p.predecessor
                 WHERE p.max_pending_bytes IS NULL)
             SELECT EXISTS(SELECT 1 FROM provenance WHERE max_pending_bytes>?2 OR max_pending_age_ms>?3)"
        ),
        params![workspace_id, max_pending_bytes, max_pending_age_ms],
        |row| row.get(0),
    )
    .map_err(read_sql)
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

/// The released activation a successor in `namespace` follows: the one with
/// no successor on this document lineage. None while the lineage is current
/// there, or before it ever had an activation.
pub fn released_chain_tail(
    conn: &Connection,
    namespace: &str,
    key: &DocKey,
    lineage_claim_id: &str,
) -> Result<Option<String>, ApplicationError> {
    let lineage = "relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3
        AND object_id=?4 AND lineage_claim_id=?5";
    let mut statement = conn
        .prepare(&format!(
            "SELECT activation_id FROM live_owner_activations v WHERE {lineage}
               AND released_at_ms IS NOT NULL
               AND NOT EXISTS(SELECT 1 FROM live_owner_activations s
                 WHERE s.relay_database_namespace=v.relay_database_namespace
                   AND s.predecessor_activation_id=v.activation_id)
               AND NOT EXISTS(SELECT 1 FROM live_owner_activations WHERE {lineage} AND released_at_ms IS NULL)
             LIMIT 2"
        ))
        .map_err(read_sql)?;
    let mut tails = statement
        .query_map(
            params![
                namespace,
                key.workspace_id,
                key.version_id,
                key.object_id,
                lineage_claim_id
            ],
            |row| row.get(0),
        )
        .map_err(read_sql)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(read_sql)?;
    // Each activation names the tail it follows, so a lineage has one chain.
    if tails.len() > 1 {
        return Err(ApplicationError::Corrupt);
    }
    Ok(tails.pop())
}

/// The activation a capture in `namespace` follows. While one is current
/// there, its own predecessor, so an unchanged capture names it again;
/// otherwise the released chain tail.
pub fn capture_predecessor(
    conn: &Connection,
    namespace: &str,
    key: &DocKey,
    lineage_claim_id: &str,
) -> Result<Option<String>, ApplicationError> {
    if let Some((current, _)) = current_activation(conn, Some(namespace), key, lineage_claim_id)? {
        return Ok(current.predecessor_activation_id);
    }
    released_chain_tail(conn, namespace, key, lineage_claim_id)
}

/// The activation a registration serves. A named one is the lineage's current
/// activation, or a retained source no activation recorded yet while nothing
/// holds the lineage, which its adoption will activate. That source must
/// follow the released chain tail, or none when there is none, as only such
/// a capture may adopt. Without a name, the
/// registration serves the current activation, if any. A lineage this relay
/// adopted whose activation is released takes no unnamed registration: only
/// an activation gives it live authority again. Neither serves an activation
/// whose retirement began.
pub(super) fn registration_activation(
    conn: &Connection,
    namespace: &str,
    binding: &LiveObjectBinding,
    requested: Option<&str>,
) -> Result<Option<String>, ApplicationError> {
    let serves = resolve_registration(conn, namespace, binding, requested)?;
    if let Some(activation_id) = &serves {
        super::retirement::require_not_retiring(conn, namespace, activation_id)?;
    }
    Ok(serves)
}

fn resolve_registration(
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
        if current.is_none()
            && lineage_origin_id(conn, Some(namespace), &key, &binding.lineage_claim_id)?.is_some()
        {
            return Err(ApplicationError::Conflict);
        }
        return Ok(current
            .filter(|activation| activation.namespace == namespace)
            .map(|activation| activation.activation_id));
    };
    identifier(requested, 1024)?;
    let serves = match current {
        Some(current) => current.namespace == namespace && current.activation_id == requested,
        None => {
            let descriptor: Option<String> = conn
                .query_row(
                    "SELECT descriptor_json FROM ydoc_owner_activation_sources WHERE activation_id=?1
                       AND relay_database_namespace=?2 AND workspace_id=?3 AND version_id=?4 AND object_id=?5
                       AND lineage_claim_id=?6
                       AND NOT EXISTS(SELECT 1 FROM live_owner_activations WHERE relay_database_namespace=?2 AND activation_id=?1)",
                    params![requested, namespace, key.workspace_id, key.version_id, key.object_id, binding.lineage_claim_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(read_sql)?;
            match descriptor {
                None => false,
                Some(descriptor) => {
                    let source: super::activation::ImportedOwnerSource =
                        serde_json::from_str(&descriptor).map_err(|_| ApplicationError::Corrupt)?;
                    source.predecessor_activation_id
                        == released_chain_tail(conn, namespace, &key, &binding.lineage_claim_id)?
                }
            }
        }
    };
    if !serves {
        return Err(ApplicationError::Conflict);
    }
    Ok(Some(requested.to_owned()))
}
