//! Whether a synced update may change a lineage a released chain left. In
//! the [released window](super::settled_base::released_window) a tail keeps
//! work no file may show: Carried deliveries, an acknowledged seed among them,
//! and owner outbox work that never applied. While any of it lacks proof, the
//! lineage is protected, and ingress applies only an update structural
//! inspection shows destroys nothing.
use super::*;
use crate::Ydoc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

mod binding;

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
    /// Shared with every decision the same validation answers.
    pub tails: Arc<ProtectedTails>,
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
        let ProtectedTails::Listed(tails) = &*self.tails else {
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

/// The protected tails of each document lineage as the actor last validated
/// them on one open store, at the document's released tail generation then;
/// none for a lineage nothing protects. Tails read activations, outboxes and
/// their entries, applications and accepted history of their deliveries,
/// seed captures, the journal rows native entries name, the document's head
/// and lineage columns, and terminal blobs. The store's triggers move the
/// generation with every change to those rows, whichever connection makes
/// it, so a decision whose transaction reads the store identity and
/// generation kept tails were validated at reuses them, and any other
/// validates again, every entry as
/// before. The path, restore generation and head stay each decision's own.
///
/// Only committed state is kept. Validation runs in a read-only transaction
/// of its own that completes before the decision goes on, and its result is
/// kept and used only when that state records the generation the deciding
/// transaction reads. A transaction that changed the document's tail inputs
/// reads another generation than committed state, so it validates its own
/// state, and keeps nothing a rollback could undo. A document with no
/// recorded generation is validated for each decision and never kept. The
/// actor's connection is the store's only writer; [`crate::WriterDocCache`]
/// keeps one of these for it, and binding it to another open of a store, a
/// reopen or restore among them, forgets everything kept before.
#[derive(Clone)]
pub struct ReleasedTails(Option<Arc<Mutex<TailsCache>>>);

#[derive(Default)]
struct TailsCache {
    store: Option<CachedStore>,
    validated: std::collections::HashMap<(DocKey, String), Validated>,
    validations: u64,
}

/// The open store kept tails come from: its opening and its file.
struct CachedStore {
    opening: u64,
    path: std::path::PathBuf,
}

/// Tails validated on the store `engine` names, at `generation`.
struct Validated {
    engine: String,
    generation: i64,
    tails: Option<Arc<ProtectedTails>>,
}

impl Default for ReleasedTails {
    fn default() -> Self {
        Self(Some(Arc::default()))
    }
}

fn lock(cache: &Mutex<TailsCache>) -> MutexGuard<'_, TailsCache> {
    // Validation keeps a result only once it completes, so a panic leaves
    // nothing half kept.
    cache.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ReleasedTails {
    /// Tails each decision validates in its own transaction and never keeps.
    pub fn uncached() -> Self {
        Self(None)
    }

    /// These tails, for decisions on `store`. Everything kept for another
    /// open of a store is forgotten first. Until bound, nothing is kept.
    pub fn bound_to(&self, store: &dohc_engine_storage::EngineStore) -> Self {
        if let Some(cache) = &self.0 {
            let mut cache = lock(cache);
            if cache
                .store
                .as_ref()
                .is_none_or(|kept| kept.opening != store.opening())
            {
                cache.validated.clear();
                cache.store = Some(CachedStore {
                    opening: store.opening(),
                    path: store.database_path().to_owned(),
                });
            }
        }
        self.clone()
    }

    /// How many validations these tails ran on committed state.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn validations(&self) -> u64 {
        self.0.as_ref().map_or(0, |cache| lock(cache).validations)
    }

    /// The protected tails of the document lineage, as `conn` reads them.
    fn read(
        &self,
        conn: &Connection,
        doc: &DocKey,
        lineage: &str,
    ) -> Result<Option<Arc<ProtectedTails>>, ApplicationError> {
        let fresh = || Ok(protected_tails(conn, doc, lineage)?.map(Arc::new));
        let Some(cache) = &self.0 else {
            return fresh();
        };
        let (Some(generation), engine) = tail_generation(conn, doc)? else {
            return fresh();
        };
        let key = (doc.clone(), lineage.to_owned());
        let mut cache = lock(cache);
        if let Some(kept) = cache
            .validated
            .get(&key)
            .filter(|kept| kept.generation == generation && kept.engine == engine)
        {
            return Ok(kept.tails.clone());
        }
        match cache.validate(key, generation, &engine)? {
            Some(tails) => Ok(tails),
            None => {
                drop(cache);
                fresh()
            }
        }
    }
}

impl TailsCache {
    /// The lineage's tails, validated on the store's committed state in a
    /// read-only connection and transaction that both end before this
    /// returns, and kept at `generation`. None, keeping nothing, when no
    /// store is bound or committed state records another generation or
    /// engine.
    fn validate(
        &mut self,
        key: (DocKey, String),
        generation: i64,
        engine: &str,
    ) -> Result<Option<Option<Arc<ProtectedTails>>>, ApplicationError> {
        let Some(store) = &self.store else {
            return Ok(None);
        };
        let mut reader = open_reader(&store.path)?;
        let tx = reader.transaction().map_err(read_sql)?;
        let committed = tail_generation(&tx, &key.0)?;
        if committed.0 != Some(generation) || committed.1 != engine {
            tx.commit().map_err(read_sql)?;
            return Ok(None);
        }
        let tails = protected_tails(&tx, &key.0, &key.1)?.map(Arc::new);
        tx.commit().map_err(read_sql)?;
        self.validations += 1;
        self.validated.insert(
            key,
            Validated {
                engine: engine.to_owned(),
                generation,
                tails: tails.clone(),
            },
        );
        Ok(Some(tails))
    }
}

/// A read-only connection to the store at `path` that never checkpoints it.
fn open_reader(path: &std::path::Path) -> Result<Connection, ApplicationError> {
    let reader = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(read_sql)?;
    reader
        .set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
            true,
        )
        .map_err(read_sql)?;
    reader
        .busy_timeout(std::time::Duration::from_millis(u64::from(
            dohc_engine_storage::ENGINE_SQLITE_BUSY_TIMEOUT_MS,
        )))
        .map_err(read_sql)?;
    Ok(reader)
}

/// The document's released tail generation, none before its first
/// activation, and the identity of the store that records it.
fn tail_generation(
    conn: &Connection,
    doc: &DocKey,
) -> Result<(Option<i64>, String), ApplicationError> {
    conn.prepare_cached(
        "SELECT (SELECT generation FROM released_tail_generations
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3),engine_uuid
         FROM engine_ownership WHERE rowid_guard=1",
    )
    .map_err(read_sql)?
    .query_row(
        params![doc.workspace_id, doc.version_id, doc.object_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .map_err(read_sql)
}

/// Whether the released window protects the head of `key`'s lineage from
/// the incoming update, and the binding a hold of it names. A tail whose
/// retained work all has proof leaves the lineage unprotected; a window or
/// tail whose evidence does not read protects it. The tails come from
/// `tails` when their validation still holds; the path, restore generation
/// and head are read for each update. Storage failures stay errors.
pub fn protection(
    conn: &Connection,
    key: &ProtectionKey<'_>,
    tails: &ReleasedTails,
) -> Result<Protection, ApplicationError> {
    let doc = key.doc;
    let Some(tails) = tails.read(conn, doc, key.lineage_claim_id)? else {
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

/// How many times this process read a released window's tails from a store,
/// on any connection, for measurements that compare revisions.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub fn released_tail_scans() -> u64 {
    SCANS.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(any(test, feature = "test-support"))]
static SCANS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The tails of the released window that protect the document's lineage, or
/// none while nothing does.
fn protected_tails(
    conn: &Connection,
    doc: &DocKey,
    lineage: &str,
) -> Result<Option<ProtectedTails>, ApplicationError> {
    #[cfg(any(test, feature = "test-support"))]
    SCANS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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
