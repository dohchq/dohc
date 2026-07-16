//! Normalized logical-state capture for the differential harness.
//!
//! Produces a deterministic, order-stable projection of a workspace's version
//! graph, active version, moment order, and per-version snapshots (by blob
//! hash) — the comparison surface a TS-vs-Rust differential asserts on
//! (`TEST_ORACLE.md` §2, normalizers N2/N4–N8). Ids that carry identity are
//! caller-supplied in the operation traces, so the capture is fully
//! deterministic and can be compared to a golden fixture without ID
//! substitution. A LIVE TS runner would additionally apply N7 structural ID
//! substitution — noted in the PR as a follow-up.

use crate::error::DomainError;
use crate::records::{ListMomentsQuery, VersionKind, VersionRecord};
use crate::store::VersionedTextStore;

/// One normalized version-graph row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionRow {
    pub version_id: String,
    pub kind: VersionKind,
    pub name: String,
    pub created_at_ms: i64,
    pub fork_version_id: Option<String>,
    pub fork_moment_id: Option<String>,
}

/// One normalized snapshot row (content by hash — N8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotRow {
    pub version_id: String,
    pub path: String,
    pub object_id: String,
    pub blob_sha256: String,
    pub metadata_origin: String,
}

/// One normalized fork-base row (the frozen three-way-merge anchor). Included
/// so a wrong, leaked, or missing fork base is visible in the differential —
/// the exact provenance the fork-point bug corrupts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkBaseRow {
    pub version_id: String,
    pub path: String,
    pub object_id: String,
    pub blob_sha256: String,
}

/// One normalized moment row (ascending `moment_order`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MomentRow {
    pub moment_order: i64,
    pub version_id: String,
    pub path: String,
    pub operation: String,
    pub after_blob_sha256: String,
    pub before_present: bool,
    pub sync_record_only: bool,
}

/// The full normalized state of one workspace.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NormalizedState {
    pub active_version_id: Option<String>,
    pub versions: Vec<VersionRow>,
    pub snapshots: Vec<SnapshotRow>,
    pub fork_bases: Vec<ForkBaseRow>,
    pub moments: Vec<MomentRow>,
}

/// A generous page size to gather all moments in one read for the harness.
const MOMENT_SWEEP_LIMIT: i64 = 1_000_000;
/// Blob hashes are truncated to this many hex chars in the canonical string so
/// golden fixtures stay readable; still deterministic and collision-safe here.
const HASH_PREFIX: usize = 12;

pub(crate) fn capture(
    store: &VersionedTextStore<'_>,
    workspace_id: &str,
) -> Result<NormalizedState, DomainError> {
    let versions = store.list_versions(workspace_id)?;
    if versions.is_empty() {
        return Ok(NormalizedState::default());
    }
    let active_version_id = Some(store.get_active_version(workspace_id)?.version_id);

    let version_rows = versions.iter().map(to_version_row).collect();

    let mut snapshots = Vec::new();
    for version in &versions {
        for snap in store.list_snapshots(workspace_id, &version.version_id)? {
            snapshots.push(SnapshotRow {
                version_id: snap.version_id,
                path: snap.path,
                object_id: snap.object_id,
                blob_sha256: snap.blob_sha256,
                metadata_origin: snap.metadata_origin,
            });
        }
    }
    // (version_id, path) already unique; sort for a stable order.
    snapshots.sort_by(|a, b| (&a.version_id, &a.path).cmp(&(&b.version_id, &b.path)));

    let mut fork_bases = Vec::new();
    for version in &versions {
        for base in store.list_fork_base_snapshots(workspace_id, &version.version_id)? {
            fork_bases.push(ForkBaseRow {
                version_id: base.version_id,
                path: base.path,
                object_id: base.object_id,
                blob_sha256: base.blob_sha256,
            });
        }
    }
    fork_bases.sort_by(|a, b| (&a.version_id, &a.path).cmp(&(&b.version_id, &b.path)));

    let page = store.list_moments(&ListMomentsQuery {
        workspace_id: workspace_id.to_owned(),
        version_id: None,
        object_id: None,
        limit: MOMENT_SWEEP_LIMIT,
        before_moment_order: None,
    })?;
    let mut moments: Vec<MomentRow> = page
        .moments
        .into_iter()
        .map(|m| MomentRow {
            moment_order: m.moment_order,
            version_id: m.version_id,
            path: m.path,
            operation: m.operation.as_str().to_owned(),
            after_blob_sha256: m.after_blob_sha256,
            before_present: m.before_present,
            sync_record_only: m.sync_record_only,
        })
        .collect();
    // list_moments returns newest-first; normalize to ascending order.
    moments.sort_by_key(|m| m.moment_order);

    Ok(NormalizedState {
        active_version_id,
        versions: version_rows,
        snapshots,
        fork_bases,
        moments,
    })
}

fn to_version_row(v: &VersionRecord) -> VersionRow {
    VersionRow {
        version_id: v.version_id.clone(),
        kind: v.kind,
        name: v.name.clone(),
        created_at_ms: v.created_at_ms,
        fork_version_id: v.fork_version_id.clone(),
        fork_moment_id: v.fork_moment_id.clone(),
    }
}

impl NormalizedState {
    /// A canonical, line-oriented string form — stable across runs for a given
    /// trace, so a golden-fixture comparison is a plain string equality.
    pub fn to_canonical_string(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "active={}\n",
            self.active_version_id.as_deref().unwrap_or("<none>")
        ));
        for v in &self.versions {
            out.push_str(&format!(
                "version id={} kind={} name={} created={} fork_from={} fork_moment={}\n",
                v.version_id,
                v.kind.as_str(),
                v.name,
                v.created_at_ms,
                v.fork_version_id.as_deref().unwrap_or("-"),
                v.fork_moment_id.as_deref().unwrap_or("-"),
            ));
        }
        for s in &self.snapshots {
            out.push_str(&format!(
                "snapshot version={} path={} object={} blob={} origin={}\n",
                s.version_id,
                s.path,
                s.object_id,
                short(&s.blob_sha256),
                s.metadata_origin,
            ));
        }
        for f in &self.fork_bases {
            out.push_str(&format!(
                "forkbase version={} path={} object={} blob={}\n",
                f.version_id,
                f.path,
                f.object_id,
                short(&f.blob_sha256),
            ));
        }
        for m in &self.moments {
            out.push_str(&format!(
                "moment order={} version={} path={} op={} after={} before_present={} sync_only={}\n",
                m.moment_order,
                m.version_id,
                m.path,
                m.operation,
                short(&m.after_blob_sha256),
                m.before_present,
                m.sync_record_only,
            ));
        }
        out
    }
}

fn short(hash: &str) -> &str {
    hash.get(..HASH_PREFIX).unwrap_or(hash)
}
