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
    /// The relay namespace the host's trusted configuration names for the
    /// feed; none on a pull no configured host serves.
    pub relay_namespace: Option<String>,
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
    pub tails: ProtectedTails,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtectedTails {
    /// Every protected namespace's tail, in namespace order.
    Listed(Vec<ProtectedTail>),
    /// The window's own evidence does not read: a current activation, or a
    /// namespace's tail, that cannot be named.
    Invalid,
}

/// A released chain tail whose retained work protects its lineage.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ProtectedTail {
    pub namespace: String,
    pub activation_id: String,
    /// What the tail's release bound; none when it does not read.
    pub release: Option<TailRelease>,
    pub coverage: RetainedCoverage,
}

/// The path and restore generation a tail's release bound.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct TailRelease {
    pub path: String,
    pub restore_generation: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum RetainedCoverage {
    /// This work, in canonical order, lacks proof of application or terminal
    /// coverage.
    Unproven(Vec<RetainedContribution>),
    /// Its evidence, or the release that bound it, is missing, conflicting
    /// or corrupt.
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
    /// release bound: another path, or a restore since. A release no
    /// evidence names cannot show the update stays on it.
    pub fn moved(&self, path: &str) -> bool {
        let here = |bound: &str| self.current_path.as_deref() == Some(bound);
        let ProtectedTails::Listed(tails) = &self.tails else {
            return true;
        };
        !here(path)
            || tails.iter().any(|tail| match &tail.release {
                Some(release) => {
                    !here(&release.path)
                        || self.restore_generation != Some(release.restore_generation)
                }
                None => true,
            })
    }
}

/// The value `result` reads, or none when its evidence does not read.
/// Storage failures stay errors.
fn readable<T>(result: Result<T, ApplicationError>) -> Result<Option<T>, ApplicationError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(
            error @ (ApplicationError::Storage(_)
            | ApplicationError::Collab(CollabError::Storage(_))),
        ) => Err(error),
        Err(_) => Ok(None),
    }
}

/// The protected tails of each document lineage, as one pass of synced rows
/// first read them; none for a lineage nothing protects. Tails read only
/// activations, outboxes and their entries, applications and accepted
/// history, which applying a synced row never writes, so a pass reads each
/// lineage's tails once. Its owner drops it when the pass ends.
#[derive(Debug, Default)]
pub struct PassTails(std::collections::HashMap<(DocKey, String), Option<ProtectedTails>>);

/// Whether the released window protects the head of `key`'s lineage from
/// the incoming update, and the binding a hold of it names. A tail whose
/// retained work all has proof leaves the lineage unprotected; a window or
/// tail whose evidence does not read protects it. The tails come from
/// `pass`, read on its first decision for the lineage; the path, restore
/// generation and head are read for each update. Storage failures stay
/// errors.
pub fn protection(
    conn: &Connection,
    key: &ProtectionKey<'_>,
    pass: &mut PassTails,
) -> Result<Protection, ApplicationError> {
    let (doc, lineage) = (key.doc, key.lineage_claim_id);
    let read = (doc.clone(), lineage.to_owned());
    let tails = match pass.0.get(&read) {
        Some(tails) => tails.clone(),
        None => {
            let tails = protected_tails(conn, doc, lineage)?;
            pass.0.insert(read, tails.clone());
            tails
        }
    };
    let Some(tails) = tails else {
        return Ok(Protection::Unprotected);
    };
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

/// The tails of the released window that protect the document's lineage, or
/// none while nothing does.
fn protected_tails(
    conn: &Connection,
    doc: &DocKey,
    lineage: &str,
) -> Result<Option<ProtectedTails>, ApplicationError> {
    let Some(window) = readable(super::settled_base::released_window(conn, doc, lineage))? else {
        return Ok(Some(ProtectedTails::Invalid));
    };
    let mut tails = Vec::new();
    for (namespace, activation_id) in window {
        let release = readable(super::retirement::released_binding(
            conn,
            &namespace,
            doc,
            lineage,
            &activation_id,
        ))?
        .map(|(path, restore_generation)| TailRelease {
            path,
            restore_generation,
        });
        let unproven = match release {
            Some(_) => readable(super::retirement::unproven_retained(
                conn,
                &namespace,
                doc,
                lineage,
                &activation_id,
            ))?,
            None => None,
        };
        let coverage = match unproven {
            Some(unproven) if unproven.is_empty() => continue,
            Some(unproven) => RetainedCoverage::Unproven(unproven),
            None => RetainedCoverage::Invalid,
        };
        tails.push(ProtectedTail {
            namespace,
            activation_id,
            release,
            coverage,
        });
    }
    Ok((!tails.is_empty()).then_some(ProtectedTails::Listed(tails)))
}
