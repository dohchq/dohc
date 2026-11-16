//! The refusal rule for a joined workspace whose copy is being rebuilt.
//!
//! A root whose manifest (`rebuild_manifest`) is in a phase before
//! `swapped` still holds the old store, which may hold History the relay now
//! withholds. The engine opens such a root only for the open that carries the
//! manifest's rebuild id, never creates a store there, and refuses every
//! request to it except `workspace.close` and those that carry the rebuild
//! id in their params as `rebuildId`.

use std::path::Path;

use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::wire::Request;

use crate::rebuild_manifest::{self, RebuildManifest};
use crate::{EngineService, lock};

/// The refusal a reader of a closed copy meets. The desktop shows
/// "Updating access" for it.
pub(crate) const UPDATING_ACCESS: &str = "share-view-updating-access";

pub(super) fn updating_access() -> WireError {
    WireError::new(ErrorCode::Forbidden, UPDATING_ACCESS)
}

/// The engine's own store folder at a root.
fn store_folder(root: &Path) -> std::path::PathBuf {
    root.join(".dohc").join("engine")
}

impl EngineService {
    /// Read the root's manifest before anything opens or creates a store
    /// there. A root that holds an old store opens only for its rebuild, and
    /// only when the store is already on disk.
    pub(super) fn admit_rebuilding_root(
        &self,
        root: &Path,
        rebuild_id: Option<&str>,
    ) -> Result<(), WireError> {
        let manifest = match rebuild_manifest::read_manifest(root) {
            Ok(manifest) => manifest,
            // A manifest that can't be read may name a rebuild under way.
            Err(_) => return Err(updating_access()),
        };
        let Some(manifest) = manifest.filter(|manifest| manifest.phase.holds_old_store()) else {
            lock(&self.rebuilding_roots).remove(root);
            return Ok(());
        };
        if rebuild_id != Some(manifest.rebuild_id.as_str()) || !store_folder(root).is_dir() {
            return Err(updating_access());
        }
        lock(&self.rebuilding_roots).insert(root.to_path_buf(), manifest.rebuild_id);
        Ok(())
    }

    /// Refuse a request to a root whose copy is closed for a rebuild, unless
    /// it closes the handle or carries the rebuild id. The id is taken out of
    /// the params before the method reads them.
    pub(crate) fn guard_rebuilding_request(&self, request: &mut Request) -> Result<(), WireError> {
        let Some(handle) = request.workspace.as_ref() else {
            return Ok(());
        };
        let carried = match request.params.as_object_mut() {
            Some(params) => match params.remove("rebuildId") {
                None => None,
                Some(serde_json::Value::String(id)) => Some(id),
                Some(_) => {
                    return Err(WireError::new(
                        ErrorCode::InvalidParams,
                        "rebuildId must be a string",
                    ));
                }
            },
            None => None,
        };
        let Some(root) = lock(&self.handles)
            .get(handle)
            .map(|open| open.root.clone())
        else {
            return Ok(());
        };
        let Some(rebuild_id) = lock(&self.rebuilding_roots).get(&root).cloned() else {
            return Ok(());
        };
        if request.method == "workspace.close" || carried.as_deref() == Some(rebuild_id.as_str()) {
            return Ok(());
        }
        Err(updating_access())
    }

    /// Close a root's copy for a rebuild: write the manifest, flushed, and
    /// refuse the root from then on. The manifest is on disk before this
    /// returns, so a restart refuses the root too.
    pub(super) fn close_for_rebuild(
        &self,
        root: &Path,
        manifest: &RebuildManifest,
    ) -> Result<(), WireError> {
        // Refuse first: a request that slips in between would read the old
        // store, while a refusal with no manifest yet only delays it.
        lock(&self.rebuilding_roots).insert(root.to_path_buf(), manifest.rebuild_id.clone());
        rebuild_manifest::write_manifest(root, manifest).map_err(|_| {
            WireError::new(
                ErrorCode::Internal,
                "share-view-rebuild-manifest-unwritable",
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rebuild_manifest::RebuildPhase;
    use crate::root_binding;
    use dohc_engine_protocol::transport::RequestContext;
    use dohc_engine_protocol::wire::WorkspaceHandle;
    use dohc_engine_runtime::WorkspaceSupervisor;
    use dohc_engine_testkit::ScratchDir;
    use serde_json::{Value, json};

    fn service() -> EngineService {
        EngineService::with_supervisor(Box::leak(Box::new(WorkspaceSupervisor::new())))
    }

    fn manifest(rebuild_id: &str, phase: RebuildPhase) -> RebuildManifest {
        RebuildManifest {
            rebuild_id: rebuild_id.to_owned(),
            phase,
            share_id: "share-1".to_owned(),
            signature: "rev-2".to_owned(),
            visibility_signature: "vis-2".to_owned(),
            closed_at_ms: 1,
            plan: None,
            share_refresh_existed: None,
        }
    }

    async fn open(
        service: &EngineService,
        root: &Path,
        rebuild_id: Option<&str>,
    ) -> Result<WorkspaceHandle, WireError> {
        let mut params = json!({
            "rootDir": root.to_string_lossy(),
            "workspaceId": "joined",
            "captureMode": "none",
        });
        if let Some(id) = rebuild_id {
            params["rebuildId"] = json!(id);
        }
        let opened = service
            .workspace_open(&RequestContext::unbounded(), params)
            .await?;
        Ok(serde_json::from_value(opened["workspace"].clone()).expect("handle"))
    }

    async fn call(
        service: &EngineService,
        handle: &WorkspaceHandle,
        method: &str,
        params: Value,
    ) -> Result<(), WireError> {
        service
            .dispatch(
                RequestContext::unbounded(),
                Request {
                    id: 1,
                    method: method.to_owned(),
                    workspace: Some(handle.clone()),
                    deadline_ms: None,
                    idempotency_key: None,
                    progress: false,
                    params,
                },
            )
            .await
            .map(|_| ())
    }

    fn assert_updating_access(result: Result<impl std::fmt::Debug, WireError>) {
        let error = result.expect_err("refused while updating access");
        assert_eq!(
            (error.code, error.message.as_str()),
            (ErrorCode::Forbidden, UPDATING_ACCESS)
        );
    }

    /// From the close on, the old store answers only its rebuild and
    /// `workspace.close`, through a restart, until the new store is swapped in.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_closed_copy_answers_only_its_rebuild_until_the_swap_across_restart() {
        let scratch = ScratchDir::new().expect("scratch");
        let root = root_binding::canonical_root(scratch.path()).expect("root");
        let first = service();
        let handle = open(&first, &root, None).await.expect("open");
        call(&first, &handle, "sync.remoteChanges", json!({}))
            .await
            .expect("an open copy reads");

        first
            .close_for_rebuild(&root, &manifest("rebuild-1", RebuildPhase::Closed))
            .expect("close");
        assert_updating_access(call(&first, &handle, "sync.remoteChanges", json!({})).await);
        assert_updating_access(
            call(
                &first,
                &handle,
                "sync.remoteChanges",
                json!({ "rebuildId": "rebuild-0" }),
            )
            .await,
        );
        call(
            &first,
            &handle,
            "sync.remoteChanges",
            json!({ "rebuildId": "rebuild-1" }),
        )
        .await
        .expect("the rebuild reads");
        call(&first, &handle, "workspace.close", json!({}))
            .await
            .expect("a closed copy still closes");

        // A restart reads the manifest before it opens anything.
        let restarted = service();
        assert_updating_access(open(&restarted, &root, None).await);
        assert_updating_access(open(&restarted, &root, Some("rebuild-0")).await);
        let handle = open(&restarted, &root, Some("rebuild-1"))
            .await
            .expect("the rebuild opens its root");
        assert_updating_access(call(&restarted, &handle, "sync.remoteChanges", json!({})).await);
        call(
            &restarted,
            &handle,
            "sync.remoteChanges",
            json!({ "rebuildId": "rebuild-1" }),
        )
        .await
        .expect("the rebuild reads after a restart");
        call(&restarted, &handle, "workspace.close", json!({}))
            .await
            .expect("close");

        // Each phase before the swap holds the old store.
        for phase in [RebuildPhase::Planned, RebuildPhase::Swapping] {
            crate::rebuild_manifest::write_manifest(&root, &manifest("rebuild-1", phase))
                .expect("phase");
            assert_updating_access(open(&restarted, &root, None).await);
        }
        // From `swapped` on, the store at the root is the new one.
        crate::rebuild_manifest::write_manifest(
            &root,
            &manifest("rebuild-1", RebuildPhase::Swapped),
        )
        .expect("swapped");
        let handle = open(&restarted, &root, None)
            .await
            .expect("the new store opens");
        call(&restarted, &handle, "sync.remoteChanges", json!({}))
            .await
            .expect("the new store reads");
        call(&restarted, &handle, "workspace.close", json!({}))
            .await
            .expect("close");
    }

    /// A root with a manifest and no store opens for nobody, its rebuild
    /// included, and is never given a store.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_closed_root_with_no_store_is_never_given_one() {
        let scratch = ScratchDir::new().expect("scratch");
        let root = root_binding::canonical_root(scratch.path()).expect("root");
        std::fs::create_dir_all(root.join(".dohc").join("local")).expect("local");
        crate::rebuild_manifest::write_manifest(
            &root,
            &manifest("rebuild-1", RebuildPhase::Closed),
        )
        .expect("manifest");
        let service = service();
        assert_updating_access(open(&service, &root, None).await);
        assert_updating_access(open(&service, &root, Some("rebuild-1")).await);
        assert!(!root.join(".dohc").join("engine").exists());
    }

    /// A manifest that can't be read may name a rebuild under way, so the
    /// root is refused rather than opened as if there were none.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unreadable_manifest_refuses_the_root() {
        let scratch = ScratchDir::new().expect("scratch");
        let root = root_binding::canonical_root(scratch.path()).expect("root");
        let service = service();
        let handle = open(&service, &root, None).await.expect("open");
        call(&service, &handle, "workspace.close", json!({}))
            .await
            .expect("close");
        std::fs::write(crate::rebuild_manifest::manifest_path(&root), b"{").expect("torn");
        assert_updating_access(open(&service, &root, None).await);
    }
}
