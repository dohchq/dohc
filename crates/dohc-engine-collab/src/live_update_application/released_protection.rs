//! Whether a synced update may change a lineage a released chain left. In
//! the [released window](super::settled_base::released_window) a tail keeps
//! work no file may show: Carried deliveries, an acknowledged seed among them,
//! and owner outbox work that never applied. While any of it lacks proof, the
//! lineage is protected, and ingress applies only an update structural
//! inspection shows destroys nothing.
use super::*;
use crate::Ydoc;

/// The synced update protection is decided for: the feed it arrived on and
/// its coordinate there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingCoordinate {
    pub replication_epoch: String,
    pub stream_identity: String,
    pub origin_id: String,
    pub origin_seq: i64,
    pub relay_seq: i64,
}

/// What [`protection`] decides for: the head's lineage and the incoming update.
#[derive(Debug, Clone, Copy)]
pub struct ProtectionKey<'a> {
    pub doc: &'a DocKey,
    pub lineage_claim_id: &'a str,
    pub incoming: &'a IncomingCoordinate,
}

/// What a held update binds: the document's scope, the incoming feed and
/// coordinate, the head it would have changed, and every protected tail with
/// its retained coverage, in namespace order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleasedLineageBinding {
    pub workspace_id: String,
    pub main_version_id: String,
    pub object_id: String,
    pub lineage_claim_id: String,
    /// The document's path; none when no alias holds it.
    pub current_path: Option<String>,
    /// Its restore generation, 0 before any restore; none while one fences it.
    pub restore_generation: Option<i64>,
    pub incoming: IncomingCoordinate,
    /// The SHA-256 of the head's full state before the update.
    pub head_digest: String,
    pub tails: Vec<ProtectedTail>,
}

/// A released chain tail whose retained work protects its lineage.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ProtectedTail {
    pub namespace: String,
    pub activation_id: String,
    pub coverage: RetainedCoverage,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum RetainedCoverage {
    /// The tail's release bound `path` and `restore_generation`, and this
    /// work, in canonical order, lacks proof of application or terminal
    /// coverage.
    Unproven {
        path: String,
        restore_generation: i64,
        unproven: Vec<RetainedContribution>,
    },
    /// Its evidence is missing, conflicting or corrupt.
    Invalid,
}

/// One piece of retained work no proof covers.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum RetainedContribution {
    /// A Carried delivery, a seed among them, that no host here applied.
    Carried {
        delivery_id: String,
        update_digest: String,
        journal_cursor: i64,
    },
    /// Any other outbox entry of the chain without such proof.
    Outbox {
        outbox_id: String,
        sequence: i64,
        delivery_id: String,
        update_digest: String,
    },
}

pub enum Protection {
    Unprotected,
    /// The head the binding names, loaded for inspection.
    Protected {
        binding: Box<ReleasedLineageBinding>,
        head: Ydoc,
    },
}

impl ReleasedLineageBinding {
    /// Whether an update at `path` would land off what a protected tail's
    /// release bound: another path, or a restore since.
    pub fn moved(&self, path: &str) -> bool {
        let here = |bound: &str| self.current_path.as_deref() == Some(bound);
        !here(path)
            || self.tails.iter().any(|tail| match &tail.coverage {
                RetainedCoverage::Unproven {
                    path,
                    restore_generation,
                    ..
                } => !here(path) || self.restore_generation != Some(*restore_generation),
                RetainedCoverage::Invalid => false,
            })
    }
}

/// Whether the released window protects the head of `key`'s lineage from
/// the incoming update, and the binding a hold of it names. A tail whose
/// retained work all has proof leaves the lineage unprotected; one whose
/// evidence does not read protects it. Storage failures stay errors.
pub fn protection(
    conn: &Connection,
    key: &ProtectionKey<'_>,
) -> Result<Protection, ApplicationError> {
    let mut tails = Vec::new();
    for (namespace, activation_id) in
        super::settled_base::released_window(conn, key.doc, key.lineage_claim_id)?
    {
        let coverage = match super::retirement::unproven_retained(
            conn,
            &namespace,
            key.doc,
            key.lineage_claim_id,
            &activation_id,
        ) {
            Ok((_, _, unproven)) if unproven.is_empty() => continue,
            Ok((path, restore_generation, unproven)) => RetainedCoverage::Unproven {
                path,
                restore_generation,
                unproven,
            },
            Err(
                error @ (ApplicationError::Storage(_)
                | ApplicationError::Collab(CollabError::Storage(_))),
            ) => return Err(error),
            Err(_) => RetainedCoverage::Invalid,
        };
        tails.push(ProtectedTail {
            namespace,
            activation_id,
            coverage,
        });
    }
    if tails.is_empty() {
        return Ok(Protection::Unprotected);
    }
    let doc = key.doc;
    let current_path = conn
        .query_row(
            "SELECT path FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![doc.workspace_id, doc.version_id, doc.object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(read_sql)?;
    let restore_generation = match restore_fence::current_generation(conn, doc) {
        Ok(generation) => Some(generation.unwrap_or(0)),
        Err(CollabError::RestoreFenced) => None,
        Err(error) => return Err(error.into()),
    };
    let head = durable::load_doc_in(conn, doc)?;
    let head_digest = hex_sha256(&head.encode_full_state());
    Ok(Protection::Protected {
        binding: Box::new(ReleasedLineageBinding {
            workspace_id: doc.workspace_id.clone(),
            main_version_id: doc.version_id.clone(),
            object_id: doc.object_id.clone(),
            lineage_claim_id: key.lineage_claim_id.to_owned(),
            current_path,
            restore_generation,
            incoming: key.incoming.clone(),
            head_digest,
            tails,
        }),
        head,
    })
}
