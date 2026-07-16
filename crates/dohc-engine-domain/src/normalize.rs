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

/// One normalized moment row (ascending `moment_order`). Carries the full
/// deterministic-history contract — stable id, object identity, before-linking,
/// timestamp, and origin — so the differential fails when any of them is wrong,
/// not only when the after-content diverges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MomentRow {
    pub moment_order: i64,
    pub moment_id: String,
    pub version_id: String,
    pub object_id: String,
    pub path: String,
    pub recorded_at_ms: i64,
    pub operation: String,
    pub after_blob_sha256: String,
    pub before_present: bool,
    pub before_blob_sha256: Option<String>,
    pub metadata_origin: String,
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

/// Per-page size when sweeping the full moment history through the keyset
/// cursor (bounded — the sweep follows pages until the cursor is exhausted, so
/// a long-lived workspace is captured completely, not truncated).
const MOMENT_PAGE: i64 = 512;

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

    // Sweep the whole history by following the keyset cursor, never truncating.
    let mut moments: Vec<MomentRow> = Vec::new();
    let mut cursor: Option<i64> = None;
    loop {
        let page = store.list_moments(&ListMomentsQuery {
            workspace_id: workspace_id.to_owned(),
            version_id: None,
            object_id: None,
            limit: MOMENT_PAGE,
            before_moment_order: cursor,
        })?;
        for m in page.moments {
            moments.push(MomentRow {
                moment_order: m.moment_order,
                moment_id: m.moment_id,
                version_id: m.version_id,
                object_id: m.object_id,
                path: m.path,
                recorded_at_ms: m.recorded_at_ms,
                operation: m.operation.as_str().to_owned(),
                after_blob_sha256: m.after_blob_sha256,
                before_present: m.before_present,
                before_blob_sha256: m.before_blob_sha256,
                metadata_origin: m.metadata_origin,
                sync_record_only: m.sync_record_only,
            });
        }
        match page.next_before_moment_order {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
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
    ///
    /// FULL sha256 hashes (never truncated) so distinct content can never
    /// compare equal. Field values are emitted via [`field`] which rejects a
    /// value containing a delimiter/newline, so user-controlled names/paths/ids
    /// cannot forge or hide a row.
    pub fn to_canonical_string(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "active={}\n",
            field(self.active_version_id.as_deref().unwrap_or("<none>"))
        ));
        for v in &self.versions {
            out.push_str(&format!(
                "version id={} kind={} name={} created={} fork_from={} fork_moment={}\n",
                field(&v.version_id),
                v.kind.as_str(),
                field(&v.name),
                v.created_at_ms,
                field(v.fork_version_id.as_deref().unwrap_or("-")),
                field(v.fork_moment_id.as_deref().unwrap_or("-")),
            ));
        }
        for s in &self.snapshots {
            out.push_str(&format!(
                "snapshot version={} path={} object={} blob={} origin={}\n",
                field(&s.version_id),
                field(&s.path),
                field(&s.object_id),
                s.blob_sha256,
                field(&s.metadata_origin),
            ));
        }
        for f in &self.fork_bases {
            out.push_str(&format!(
                "forkbase version={} path={} object={} blob={}\n",
                field(&f.version_id),
                field(&f.path),
                field(&f.object_id),
                f.blob_sha256,
            ));
        }
        for m in &self.moments {
            out.push_str(&format!(
                "moment order={} id={} version={} object={} path={} recorded={} op={} after={} before_present={} before={} origin={} sync_only={}\n",
                m.moment_order,
                field(&m.moment_id),
                field(&m.version_id),
                field(&m.object_id),
                field(&m.path),
                m.recorded_at_ms,
                m.operation,
                m.after_blob_sha256,
                m.before_present,
                m.before_blob_sha256.as_deref().unwrap_or("-"),
                field(&m.metadata_origin),
                m.sync_record_only,
            ));
        }
        out
    }
}

/// Emit a field value for the canonical form, rejecting a delimiter/newline so
/// a user-controlled value cannot inject or hide a row. Controlled inputs never
/// hit the fallback; it exists so a malformed value is loud, not silent.
fn field(value: &str) -> String {
    if value.contains(' ') || value.contains('\n') || value.contains('=') {
        format!("<invalid:{}>", value.escape_default())
    } else {
        value.to_owned()
    }
}
