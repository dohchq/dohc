//! Full-content comparison oracle for metadata-only version paging tests.

use dohc_engine_domain::{
    DomainError, SnapshotContent, VersionFileChangeStatus, VersionedTextStore,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionFileChange {
    pub path: String,
    pub status: VersionFileChangeStatus,
    pub current: Option<SnapshotContent>,
    pub incoming: Option<SnapshotContent>,
}

/// Compare hydrated snapshot contents independently of the paged query.
pub fn compare_version_files(
    store: &VersionedTextStore<'_>,
    workspace_id: &str,
    source_version_id: &str,
    target_version_id: &str,
) -> Result<Vec<VersionFileChange>, DomainError> {
    let target = store.list_snapshots(workspace_id, target_version_id)?;
    let source = store.list_snapshots(workspace_id, source_version_id)?;
    let target_by_path: BTreeMap<_, _> = target
        .into_iter()
        .map(|snapshot| (snapshot.path.clone(), snapshot))
        .collect();
    let source_by_path: BTreeMap<_, _> = source
        .into_iter()
        .map(|snapshot| (snapshot.path.clone(), snapshot))
        .collect();
    let paths: BTreeSet<_> = target_by_path
        .keys()
        .chain(source_by_path.keys())
        .cloned()
        .collect();
    let mut changes = Vec::new();
    for path in paths {
        match (target_by_path.get(&path), source_by_path.get(&path)) {
            (Some(current), Some(incoming)) if current.content != incoming.content => {
                changes.push(VersionFileChange {
                    path,
                    status: VersionFileChangeStatus::Modified,
                    current: Some(current.content.clone()),
                    incoming: Some(incoming.content.clone()),
                });
            }
            (None, Some(incoming)) => changes.push(VersionFileChange {
                path,
                status: VersionFileChangeStatus::Added,
                current: None,
                incoming: Some(incoming.content.clone()),
            }),
            (Some(current), None) => changes.push(VersionFileChange {
                path,
                status: VersionFileChangeStatus::Deleted,
                current: Some(current.content.clone()),
                incoming: None,
            }),
            _ => {}
        }
    }
    Ok(changes)
}
