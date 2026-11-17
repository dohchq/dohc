//! `share.view.rebuild`: rebuild a joined copy that closed because the relay
//! changed which items the member sees.
//!
//! Afterwards the disk equals the new store. Everything of the member's the
//! relay hasn't taken goes to a recovery folder, and their unsent deletes and
//! moves are undone and listed in its `contents.md`.
//!
//! The manifest (`rebuild_manifest`) decides every step, so a call after a
//! crash continues where the last one stopped:
//!
//! - `closed`: read the old store's unsent work; build a new store from the
//!   relay under `.dohc/local/rebuild/`; plan each path on disk against the
//!   new store; write the copies the plan saves under that folder; write
//!   `planned`.
//! - `planned`: move those copies and the old store's `displaced` folder into
//!   the recovery folder, write its `contents.md`, make the aside folder
//!   empty, then `swapping`.
//! - `swapping`: rename the old store aside and the new one into place, as
//!   the three folders on disk say is left to do, then `swapped`.
//! - `swapped`: converge the files in three waves, then `converged`.
//!
//! `share.view.rebuildFinish` deletes what the rebuild left once main has
//! stored the new reach, and the manifest last. `share.view.rebuildStatus`
//! names the manifest's rebuild, for a main that never heard its id.
//!
//! The caller closes every handle on the root first.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::{
    ActorHandle, RebuildCarried, RebuildHead, RebuildJob, RebuildRemoval, RebuildUnsent,
    RelayOperation, RelayOperationOutcome,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::rebuild_manifest::{
    self, PlannedJob, RebuildManifest, RebuildPhase, RebuildPlan, RecoveryItem, RecoverySource,
    UndoneChange,
};
use crate::root_binding::{self, LOCAL_STATE_RELATIVE_PATH};
use crate::rpc::error::map_runtime;
use crate::rpc::rebuild::updating_access;
use crate::rpc::relay::{GrantedSelectorParams, share_grant};
use crate::rpc::request::{now_ms, parse};
use crate::{EngineService, lock};

const STAGING: &str = "rebuild";
const SAVED: &str = "saved";
const ASIDE: &str = "rebuild-aside";
const SHARE_REFRESH: &str = "share-refresh";
const RECOVERY: &str = "recovery";
const CONTENTS: &str = "contents.md";
const DISPLACED: &str = "displaced";
/// The longest name one path part may have, in bytes.
const MAX_NAME_BYTES: usize = 255;

/// Why an item is in the recovery folder, as `contents.md` says it.
const WHY_REPLACED: &str = "Your change wasn't sent. The shared version is back in its place.";
const WHY_HIDDEN: &str = "No longer shared with you.";
const WHY_NOT_SENT: &str = "Not sent.";
const WHY_VERSION: &str = "Your newest version, which wasn't sent or on disk.";
const WHY_CHAT: &str = "Chat messages that weren't sent.";
const WHY_DRAFT: &str = "Edits in a page you had open, which weren't sent.";
const WHY_DISPLACED: &str = "Files dohc had set aside before.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RebuildParams {
    root_dir: String,
    workspace_id: String,
    rebuild_id: String,
    share_id: String,
    /// The grant with the reach main read from the relay for this rebuild.
    granted_selector: Value,
    /// The relay configuration `workspace.open` takes.
    relay: Value,
    /// The unsent edits of the live pages main closed for the rebuild.
    #[serde(default)]
    live_drafts: Vec<LiveDraft>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiveDraft {
    record_id: String,
    path: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinishParams {
    root_dir: String,
    rebuild_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusParams {
    root_dir: String,
}

/// A copy `closed` writes under the staging folder: its name and bytes.
type SavedCopy = (String, Vec<u8>);

/// A section of a saved thread, with the message it shows, if any.
type ChatSection = (Option<String>, String);

/// What `closed` read from the old store and the disk.
struct OldRead {
    heads: Vec<RebuildHead>,
    unsent: RebuildUnsent,
    /// The bytes of each unsent version the disk doesn't hold, by hash.
    version_bytes: BTreeMap<String, Vec<u8>>,
    /// Read markers, bookmarks, follows and feed read state.
    carried: RebuildCarried,
}

/// What `closed` read from the new store and the disk.
struct NewRead {
    heads: Vec<RebuildHead>,
    /// The hash of each file on disk at a path either store holds, and of
    /// each other file the engine tracks there.
    disk: BTreeMap<String, String>,
    /// The disk hashes whose bytes the new store holds.
    held: HashSet<String>,
}

fn failed(code: &'static str) -> WireError {
    WireError::new(ErrorCode::Conflict, code)
}

fn local(root: &Path) -> PathBuf {
    root.join(LOCAL_STATE_RELATIVE_PATH)
}

fn live_store(root: &Path) -> PathBuf {
    root.join(".dohc").join("engine")
}

fn staging_root(root: &Path) -> PathBuf {
    local(root).join(STAGING)
}

fn staging_store(root: &Path) -> PathBuf {
    live_store(&staging_root(root))
}

fn saved_copies(root: &Path) -> PathBuf {
    staging_root(root).join(SAVED)
}

fn aside(root: &Path) -> PathBuf {
    local(root).join(ASIDE)
}

fn write_manifest(root: &Path, manifest: &RebuildManifest) -> Result<(), WireError> {
    rebuild_manifest::write_manifest(root, manifest)
        .map_err(|_| failed("share-view-rebuild-manifest-unwritable"))
}

fn remove_folder(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn job_id(rebuild_id: &str, wave: u8, path: &str) -> String {
    format!(
        "rebuild-{rebuild_id}-w{wave}-{}",
        dohc_engine_storage::hex_sha256(path.as_bytes())
    )
}

/// The hash of the file at `path`, or `None` when no file is there. On a disk
/// that ignores case, a file stored under another spelling of its name is not
/// at `path`: the member renamed it, and the plan must not take it for a
/// second file.
fn disk_sha(root: &Path, path: &str) -> Option<String> {
    let bytes = std::fs::read(root.join(path)).ok()?;
    if dohc_engine_files::stored_under_other_spelling(root, path) {
        return None;
    }
    Some(dohc_engine_storage::hex_sha256(&bytes))
}

/// Every file the engine tracks on disk, with its hash.
async fn files_on_disk(root: &Path) -> Result<Vec<(String, String)>, WireError> {
    let root = root.to_path_buf();
    let scanned = tokio::task::spawn_blocking(move || {
        let scanner = dohc_engine_files::Scanner::new(dohc_engine_files::ScanBounds::default())?;
        scanner.scan(&root, &dohc_engine_files::CancellationToken::new())
    })
    .await;
    match scanned {
        Ok(Ok(dohc_engine_files::ScanOutcome::Completed(listing))) => Ok(listing
            .files
            .into_iter()
            .map(|file| (file.path, file.sha256))
            .collect()),
        _ => Err(failed("share-view-rebuild-disk-unreadable")),
    }
}

impl EngineService {
    /// Stop here as a crash would, when a harness asked for it.
    fn rebuild_crash_point(&self, _point: &str) -> Result<(), WireError> {
        #[cfg(feature = "harness")]
        {
            let mut crash_at = lock(&self.rebuild_crash_at);
            if crash_at.as_deref() == Some(_point) {
                *crash_at = None;
                return Err(WireError::new(
                    ErrorCode::Internal,
                    "rebuild-crash-for-harness",
                ));
            }
        }
        Ok(())
    }

    pub(super) async fn share_view_rebuild(
        &self,
        ctx: &RequestContext,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RebuildParams = parse(params)?;
        let selector: GrantedSelectorParams = parse(params.granted_selector.clone())?;
        if share_grant(selector)?.reach.is_none() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "a rebuild needs the reach it builds under",
            ));
        }
        let root = root_binding::canonical_root(Path::new(&params.root_dir))
            .map_err(|_| WireError::new(ErrorCode::InvalidParams, "rootDir is unavailable"))?;
        if lock(&self.handles).values().any(|open| open.root == root) {
            return Err(failed("share-view-rebuild-root-open"));
        }
        loop {
            let manifest = self.rebuild_manifest(&root, &params.rebuild_id)?;
            match manifest.phase {
                RebuildPhase::Closed => {
                    if let Some(answer) = self.rebuild_plan(ctx, &root, &params, manifest).await? {
                        return Ok(answer);
                    }
                }
                RebuildPhase::Planned => self.rebuild_save(&root, manifest)?,
                RebuildPhase::Swapping => self.rebuild_swap(&root, manifest).await?,
                RebuildPhase::Swapped => {
                    self.rebuild_converge(ctx, &root, &params.workspace_id, manifest)
                        .await?;
                }
                RebuildPhase::Converged => {
                    self.rebuild_crash_point("converged")?;
                    let plan = manifest.plan.as_ref();
                    return Ok(json!({
                        "state": "rebuilt",
                        "reach": plan.map(|plan| plan.reach.clone()),
                        "recoveryFolder": plan.and_then(|plan| plan.recovery_folder.clone()),
                        "recovered": plan.map_or(0, |plan| plan.recovery.len()),
                        "savedDrafts": plan.map(|plan| plan.saved_drafts.clone()).unwrap_or_default(),
                        "asideLeft": aside(&root).exists(),
                    }));
                }
            }
        }
    }

    /// Delete what a converged rebuild left, the manifest last. Main calls
    /// this once it has stored the new reach.
    pub(super) async fn share_view_rebuild_finish(
        &self,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: FinishParams = parse(params)?;
        let root = root_binding::canonical_root(Path::new(&params.root_dir))
            .map_err(|_| WireError::new(ErrorCode::InvalidParams, "rootDir is unavailable"))?;
        let Some(manifest) =
            rebuild_manifest::read_manifest(&root).map_err(|_| updating_access())?
        else {
            return Ok(json!({ "finished": false }));
        };
        if manifest.rebuild_id != params.rebuild_id {
            return Err(updating_access());
        }
        if manifest.phase != RebuildPhase::Converged {
            return Err(failed("share-view-rebuild-unfinished"));
        }
        remove_folder(&aside(&root)).map_err(|_| failed("share-view-rebuild-aside-left"))?;
        remove_folder(&staging_root(&root))
            .map_err(|_| failed("share-view-rebuild-staging-left"))?;
        std::fs::remove_file(rebuild_manifest::manifest_path(&root))
            .map_err(|_| failed("share-view-rebuild-manifest-unwritable"))?;
        lock(&self.rebuilding_roots).remove(&root);
        // Main deletes these drafts now, including on a finish it retries
        // after the rebuild's answer is gone.
        let saved_drafts = manifest
            .plan
            .map(|plan| plan.saved_drafts)
            .unwrap_or_default();
        Ok(json!({ "finished": true, "savedDrafts": saved_drafts }))
    }

    /// The rebuild a root's manifest names, and its phase, or nulls. The
    /// engine closes a copy before main hears the rebuild id, so a main that
    /// stopped or failed in between asks here before it opens or refreshes
    /// the copy.
    pub(super) fn share_view_rebuild_status(&self, params: Value) -> Result<Value, WireError> {
        let params: StatusParams = parse(params)?;
        let root = root_binding::canonical_root(Path::new(&params.root_dir))
            .map_err(|_| WireError::new(ErrorCode::InvalidParams, "rootDir is unavailable"))?;
        Ok(
            match rebuild_manifest::read_manifest(&root).map_err(|_| updating_access())? {
                Some(manifest) => {
                    json!({ "rebuildId": manifest.rebuild_id, "phase": manifest.phase })
                }
                None => json!({ "rebuildId": null, "phase": null }),
            },
        )
    }

    fn rebuild_manifest(
        &self,
        root: &Path,
        rebuild_id: &str,
    ) -> Result<RebuildManifest, WireError> {
        let manifest = rebuild_manifest::read_manifest(root)
            .map_err(|_| updating_access())?
            .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "share-view-not-rebuilding"))?;
        if manifest.rebuild_id != rebuild_id {
            return Err(updating_access());
        }
        Ok(manifest)
    }

    async fn rebuild_open(
        &self,
        ctx: &RequestContext,
        root: &Path,
        workspace_id: &str,
        rebuild_id: Option<&str>,
        relay: Option<&Value>,
    ) -> Result<WorkspaceHandle, WireError> {
        let mut params = json!({
            "rootDir": root.to_string_lossy(),
            "workspaceId": workspace_id,
            "captureMode": "none",
        });
        if let Some(rebuild_id) = rebuild_id {
            params["rebuildId"] = json!(rebuild_id);
        }
        if let Some(relay) = relay {
            params["relay"] = relay.clone();
        }
        let opened = Box::pin(self.workspace_open(ctx, params)).await?;
        serde_json::from_value(opened["workspace"].clone())
            .map_err(|_| WireError::new(ErrorCode::Internal, "workspace handle unreadable"))
    }

    fn rebuild_actor(&self, handle: &WorkspaceHandle) -> Result<ActorHandle, WireError> {
        Ok(self.open(Some(handle))?.actor.clone())
    }

    /// `closed`: read the old store, build the new one, plan, and write the
    /// copies the plan saves. Answers when the rebuild stops here; `None`
    /// once `planned` is written.
    async fn rebuild_plan(
        &self,
        ctx: &RequestContext,
        root: &Path,
        params: &RebuildParams,
        manifest: RebuildManifest,
    ) -> Result<Option<Value>, WireError> {
        let workspace_id = params.workspace_id.as_str();
        // A build a crash stopped starts again.
        remove_folder(&staging_root(root))
            .map_err(|_| failed("share-view-rebuild-staging-left"))?;

        // The open settles the old store: it replays every pending
        // materialization job before it answers.
        let old = self
            .rebuild_open(ctx, root, workspace_id, Some(&manifest.rebuild_id), None)
            .await?;
        let read = self.rebuild_read_old(&old, root, params).await;
        self.workspace_close(Some(old)).await?;
        let old = read?;

        // The swap renames the store between these folders, which only
        // works within one filesystem.
        std::fs::create_dir_all(staging_root(root))
            .map_err(|_| failed("share-view-rebuild-staging-unavailable"))?;
        let same = dohc_engine_files::filesystem_identity(&live_store(root))
            .and_then(|live| {
                dohc_engine_files::filesystem_identity(&local(root)).map(|local| live == local)
            })
            .map_err(|_| failed("share-view-rebuild-filesystem-unreadable"))?;
        if !same {
            return Err(failed("share-view-rebuild-filesystems-differ"));
        }

        let staging = self
            .rebuild_open(
                ctx,
                &staging_root(root),
                workspace_id,
                None,
                Some(&params.relay),
            )
            .await?;
        let built = self.rebuild_build(ctx, &staging, root, params, &old).await;
        self.workspace_close(Some(staging)).await?;
        let new = match built? {
            Ok(built) => built,
            Err(served) => {
                remove_folder(&staging_root(root))
                    .map_err(|_| failed("share-view-rebuild-staging-left"))?;
                return Ok(Some(json!({ "state": "reachMoved", "served": served })));
            }
        };
        self.rebuild_crash_point("built")?;

        let (plan, copies) = plan(root, &manifest, params, &old, &new)?;
        let saved = saved_copies(root);
        std::fs::create_dir_all(&saved)
            .map_err(|_| failed("share-view-rebuild-staging-unavailable"))?;
        for (name, bytes) in copies {
            write_synced(&saved.join(name), &bytes)
                .map_err(|_| failed("share-view-rebuild-staging-unavailable"))?;
        }
        write_manifest(
            root,
            &RebuildManifest {
                phase: RebuildPhase::Planned,
                plan: Some(plan),
                ..manifest
            },
        )?;
        Ok(None)
    }

    /// The old store's current files and the member's work the relay hasn't
    /// taken, with the bytes of each unsent version the disk doesn't hold.
    async fn rebuild_read_old(
        &self,
        handle: &WorkspaceHandle,
        root: &Path,
        params: &RebuildParams,
    ) -> Result<OldRead, WireError> {
        let actor = self.rebuild_actor(handle)?;
        let heads = actor
            .rebuild_main_heads(params.workspace_id.clone())
            .await
            .map_err(map_runtime)?;
        let unsent = actor
            .rebuild_unsent(params.workspace_id.clone(), params.share_id.clone())
            .await
            .map_err(map_runtime)?;
        let mut version_bytes = BTreeMap::new();
        for version in &unsent.versions {
            if disk_sha(root, &version.path).as_deref() == Some(version.sha256.as_str()) {
                continue;
            }
            if let Some(bytes) = actor
                .rebuild_blob(version.sha256.clone())
                .await
                .map_err(map_runtime)?
            {
                version_bytes.insert(version.sha256.clone(), bytes);
            }
        }
        let carried = actor
            .rebuild_carried(params.workspace_id.clone())
            .await
            .map_err(map_runtime)?;
        Ok(OldRead {
            heads,
            unsent,
            version_bytes,
            carried,
        })
    }

    /// Pull the share from the start into the staging store, then carry the
    /// old store's read markers, bookmarks, follows and feed read state into
    /// it. Answers its current files, the disk's hash at each path either
    /// store holds and which of those the new store holds, or the signatures
    /// the relay served when they differ from the grant's.
    async fn rebuild_build(
        &self,
        ctx: &RequestContext,
        handle: &WorkspaceHandle,
        root: &Path,
        params: &RebuildParams,
        old: &OldRead,
    ) -> Result<Result<NewRead, Value>, WireError> {
        let open = self.open(Some(handle))?;
        Box::pin(self.versions_ensure_main(
            ctx,
            Some(handle.clone()),
            json!({ "workspaceId": params.workspace_id }),
        ))
        .await?;
        let configuration = open
            .relay
            .clone()
            .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "relay-not-configured"))?;
        loop {
            let granted = share_grant(parse(params.granted_selector.clone())?)?;
            let pulled = self
                .relay_execute(
                    ctx,
                    &open,
                    configuration.clone(),
                    RelayOperation::PullShareView {
                        workspace_id: params.workspace_id.clone(),
                        share_id: params.share_id.clone(),
                        granted,
                        through_moves: true,
                    },
                    "share.view.rebuild",
                )
                .await?;
            let RelayOperationOutcome::ShareViewPulled(pulled) = pulled else {
                return Err(WireError::new(
                    ErrorCode::Internal,
                    "unexpected pull outcome",
                ));
            };
            if let Some(served) = pulled.reach_changed {
                return Ok(Err(json!({
                    "signature": served.signature,
                    "visibilitySignature": served.visibility_signature,
                })));
            }
            let has_more = pulled.has_more;
            self.relay_execute(
                ctx,
                &open,
                configuration.clone(),
                RelayOperation::CommitShareViewCursor {
                    workspace_id: params.workspace_id.clone(),
                    cursor: pulled.pending_cursor,
                },
                "share.view.rebuild",
            )
            .await?;
            if !has_more {
                break;
            }
        }
        // A thread, message or channel the new reach hides takes none of it.
        open.actor
            .rebuild_carry(old.carried.clone())
            .await
            .map_err(map_runtime)?;
        let heads = open
            .actor
            .rebuild_main_heads(params.workspace_id.clone())
            .await
            .map_err(map_runtime)?;
        let stored: BTreeSet<&str> = old
            .heads
            .iter()
            .chain(&heads)
            .map(|head| head.path.as_str())
            .collect();
        let mut disk: BTreeMap<String, String> = stored
            .iter()
            .filter_map(|path| disk_sha(root, path).map(|sha| ((*path).to_owned(), sha)))
            .collect();
        // A file neither store holds is the member's, which the old store
        // never recorded because the copy closed first.
        disk.extend(
            files_on_disk(root)
                .await?
                .into_iter()
                .filter(|(path, _)| !stored.contains(path.as_str())),
        );
        let held = open
            .actor
            .rebuild_held_blobs(disk.values().cloned().collect())
            .await
            .map_err(map_runtime)?;
        Ok(Ok(NewRead { heads, disk, held }))
    }

    /// `planned`: move the saved copies and the displaced folder into the
    /// recovery folder, then get the swap ready.
    fn rebuild_save(&self, root: &Path, mut manifest: RebuildManifest) -> Result<(), WireError> {
        if let Some(plan) = manifest.plan.as_mut()
            && let Some(folder) = plan.recovery_folder.as_deref()
        {
            let folder = root.join(folder);
            std::fs::create_dir_all(&folder)
                .map_err(|_| failed("share-view-rebuild-recovery-unavailable"))?;
            for item in &mut plan.recovery {
                let source = match item.source {
                    RecoverySource::Disk => continue,
                    _ if item.done => continue,
                    RecoverySource::Saved => saved_copies(root).join(&item.destination),
                    RecoverySource::Displaced => live_store(root).join(DISPLACED),
                };
                item.found = Some(recover(&source, &folder.join(&item.destination))?);
                item.done = true;
                self.rebuild_crash_point("planned")?;
            }
        }
        write_contents(root, &manifest)?;
        let aside = aside(root);
        remove_folder(&aside)
            .and_then(|()| std::fs::create_dir(&aside))
            .map_err(|_| failed("share-view-rebuild-aside-unavailable"))?;
        let existed = local(root).join(SHARE_REFRESH).exists();
        write_manifest(
            root,
            &RebuildManifest {
                phase: RebuildPhase::Swapping,
                share_refresh_existed: Some(existed),
                ..manifest
            },
        )
    }

    /// `swapping`: finish the renames the folders on disk say are left.
    async fn rebuild_swap(&self, root: &Path, manifest: RebuildManifest) -> Result<(), WireError> {
        let aside = aside(root);
        let refresh = local(root).join(SHARE_REFRESH);
        if manifest.share_refresh_existed == Some(true) && refresh.exists() {
            rename_retrying(&refresh, &aside.join(SHARE_REFRESH)).await?;
        }
        let (live, staging, aside_store) =
            (live_store(root), staging_store(root), aside.join("engine"));
        match (live.exists(), staging.exists(), aside_store.exists()) {
            (true, true, false) => {
                self.rebuild_crash_point("rename-0")?;
                rename_retrying(&live, &aside_store).await?;
                self.rebuild_crash_point("rename-1")?;
                rename_retrying(&staging, &live).await?;
            }
            (false, true, true) => rename_retrying(&staging, &live).await?,
            (true, false, true) => {}
            _ => return Err(failed("share-view-rebuild-swap-unrecognized")),
        }
        self.rebuild_crash_point("rename-2")?;
        write_manifest(
            root,
            &RebuildManifest {
                phase: RebuildPhase::Swapped,
                ..manifest
            },
        )
    }

    /// `swapped`: drop the old store and converge the files in three waves.
    async fn rebuild_converge(
        &self,
        ctx: &RequestContext,
        root: &Path,
        workspace_id: &str,
        mut manifest: RebuildManifest,
    ) -> Result<(), WireError> {
        self.rebuild_crash_point("swapped")?;
        // The aside store still holds the hidden History. A delete that
        // fails is tried again by finish, and the answer says it is left.
        let _ = remove_folder(&aside(root));
        let _ = remove_folder(&staging_root(root));
        let handle = self
            .rebuild_open(ctx, root, workspace_id, None, None)
            .await?;
        let converged = self
            .rebuild_waves(&handle, root, workspace_id, &mut manifest)
            .await;
        self.workspace_close(Some(handle)).await?;
        converged?;
        manifest.phase = RebuildPhase::Converged;
        write_contents(root, &manifest)?;
        write_manifest(root, &manifest)
    }

    async fn rebuild_waves(
        &self,
        handle: &WorkspaceHandle,
        root: &Path,
        workspace_id: &str,
        manifest: &mut RebuildManifest,
    ) -> Result<(), WireError> {
        let actor = self.rebuild_actor(handle)?;
        let waves_done = manifest.plan.as_ref().map_or(3, |plan| plan.waves_done);
        if waves_done < 1 {
            let plan = manifest.plan.clone().unwrap_or_else(empty_plan);
            for (index, item) in plan.recovery.iter().enumerate() {
                if item.done || item.source != RecoverySource::Disk {
                    continue;
                }
                let folder = root.join(plan.recovery_folder.as_deref().unwrap_or_default());
                let found = recover(&root.join(&item.path), &folder.join(&item.destination))?;
                if let Some(plan) = manifest.plan.as_mut() {
                    plan.recovery[index].done = true;
                    plan.recovery[index].found = Some(found);
                }
                write_manifest(root, manifest)?;
            }
            self.rebuild_wave_jobs(&actor, root, workspace_id, manifest, 1)
                .await?;
            self.rebuild_crash_point("wave-1")?;
        }
        if waves_done < 2 {
            let writes: Vec<String> = manifest
                .plan
                .iter()
                .flat_map(|plan| plan.jobs.iter())
                .filter(|job| job.wave == 3)
                .map(|job| job.path.clone())
                .collect();
            for path in writes {
                if root.join(&path).is_dir() {
                    actor
                        .rebuild_remove_empty_folder(root.to_path_buf(), path)
                        .await
                        .map_err(map_runtime)?;
                }
            }
            if let Some(plan) = manifest.plan.as_mut() {
                plan.waves_done = 2;
            }
            write_manifest(root, manifest)?;
        }
        if waves_done < 3 {
            self.rebuild_wave_jobs(&actor, root, workspace_id, manifest, 3)
                .await?;
        }
        // A folder whose files all left the disk goes too, so a hidden folder
        // doesn't stay behind empty. Each call is safe to repeat.
        let removed: BTreeSet<String> = manifest
            .plan
            .iter()
            .flat_map(|plan| {
                let deletes = plan
                    .jobs
                    .iter()
                    .filter(|job| job.delete)
                    .map(|job| &job.path);
                let saved = plan
                    .recovery
                    .iter()
                    .filter(|item| item.source == RecoverySource::Disk)
                    .map(|item| &item.path);
                deletes.chain(saved)
            })
            .flat_map(|path| {
                let mut folders = Vec::new();
                let mut at = path.as_str();
                while let Some((parent, _)) = at.rsplit_once('/') {
                    folders.push(parent.to_owned());
                    at = parent;
                }
                folders
            })
            .collect();
        // Deepest first, so a parent is empty once its children are gone.
        let mut removed: Vec<String> = removed.into_iter().collect();
        removed.sort_by_key(|folder| std::cmp::Reverse(folder.matches('/').count()));
        for folder in removed {
            actor
                .rebuild_remove_empty_folder(root.to_path_buf(), folder)
                .await
                .map_err(map_runtime)?;
        }
        Ok(())
    }

    /// Add a wave's jobs once, run them, and mark the wave done when every
    /// one has ended.
    async fn rebuild_wave_jobs(
        &self,
        actor: &ActorHandle,
        root: &Path,
        workspace_id: &str,
        manifest: &mut RebuildManifest,
        wave: u8,
    ) -> Result<(), WireError> {
        let now = now_ms()?;
        let jobs: Vec<RebuildJob> = manifest
            .plan
            .iter()
            .flat_map(|plan| plan.jobs.iter())
            .filter(|job| job.wave == wave)
            .map(|job| RebuildJob {
                job_id: job_id(&manifest.rebuild_id, wave, &job.path),
                target_path: job.path.clone(),
                delete: job.delete,
                content_sha256: job.content_sha256.clone(),
                preimage: job.preimage.clone(),
                target_generation: now,
            })
            .collect();
        let ids: Vec<String> = jobs.iter().map(|job| job.job_id.clone()).collect();
        actor
            .rebuild_add_jobs(workspace_id.to_owned(), jobs, now)
            .await
            .map_err(map_runtime)?;
        actor
            .rebuild_run_jobs(
                root.to_path_buf(),
                workspace_id.to_owned(),
                ids.clone(),
                now,
            )
            .await
            .map_err(map_runtime)?;
        let statuses = actor
            .rebuild_job_statuses(ids.clone())
            .await
            .map_err(map_runtime)?;
        if ids
            .iter()
            .any(|id| statuses.get(id).is_none_or(|status| status == "pending"))
        {
            return Err(failed("share-view-rebuild-jobs-unfinished"));
        }
        if let Some(plan) = manifest.plan.as_mut() {
            plan.waves_done = wave;
        }
        write_manifest(root, manifest)
    }
}

fn empty_plan() -> RebuildPlan {
    RebuildPlan {
        reach: Value::Null,
        recovery_folder: None,
        recovery: Vec::new(),
        undone: Vec::new(),
        saved_drafts: Vec::new(),
        jobs: Vec::new(),
        waves_done: 0,
    }
}

/// Plan each path either store holds by the file on disk there, `d`, and
/// the new store's file, `n`:
///
/// - `d` equals `n`: no step.
/// - the new store holds `d`'s bytes: write `n`, or delete, where `d` is.
/// - otherwise `d` moves to the recovery folder, then `n` is written where
///   no file is.
///
/// A path with no file on disk gets `n`. The plan also saves each unsent
/// version the disk doesn't hold, the unsent chat by thread, the live
/// drafts and the displaced folder. Answers the plan and the copies to
/// write, by name, under the staging folder.
fn plan(
    root: &Path,
    manifest: &RebuildManifest,
    params: &RebuildParams,
    old: &OldRead,
    new: &NewRead,
) -> Result<(RebuildPlan, Vec<SavedCopy>), WireError> {
    let old_heads: BTreeMap<&str, &RebuildHead> = old
        .heads
        .iter()
        .map(|head| (head.path.as_str(), head))
        .collect();
    let new_heads: BTreeMap<&str, &RebuildHead> = new
        .heads
        .iter()
        .map(|head| (head.path.as_str(), head))
        .collect();
    let own: HashSet<&str> = old
        .unsent
        .versions
        .iter()
        .map(|version| version.path.as_str())
        .collect();
    // An unsent delete or move the plan undoes: its source comes back from
    // the new store. A move counts only when the source comes back with the
    // destination's bytes; then the destination is replaced like any file the
    // store holds. Other bytes there are the member's own and go to recovery.
    let undoes = |removal: &&RebuildRemoval| {
        let Some(restored) = new_heads.get(removal.path.as_str()) else {
            return false;
        };
        !new.disk.contains_key(&removal.path)
            && removal
                .moved_to
                .as_ref()
                .is_none_or(|to| new.disk.get(to) == Some(&restored.sha256))
    };
    let moved_back: HashSet<&str> = old
        .unsent
        .removals
        .iter()
        .filter(undoes)
        .filter_map(|removal| removal.moved_to.as_deref())
        .collect();
    // Bytes on disk the member wrote there and hasn't sent. The new store
    // may hold the same bytes elsewhere, a copy's original or an older
    // version in History, but they are still the member's change at this
    // path, so they go to recovery rather than being replaced.
    let own_on_disk: HashSet<(&str, &str)> = old
        .unsent
        .versions
        .iter()
        .filter(|version| !moved_back.contains(version.path.as_str()))
        .map(|version| (version.path.as_str(), version.sha256.as_str()))
        .collect();
    // A path neither store holds is the member's file, never replaced.
    let replaceable = |path: &str, d: &String| {
        (old_heads.contains_key(path) || new_heads.contains_key(path))
            && new.held.contains(d)
            && !own_on_disk.contains(&(path, d.as_str()))
    };
    let paths: BTreeSet<&str> = old_heads
        .keys()
        .chain(new_heads.keys())
        .copied()
        .chain(new.disk.keys().map(String::as_str))
        .collect();
    let mut jobs = Vec::new();
    // What to save: where it comes from, what it was, its name and why.
    let mut saves: Vec<(RecoverySource, String, String, &str)> = Vec::new();
    let mut copies = Vec::new();
    let write = |path: &str, sha: &str, preimage: Option<&str>| PlannedJob {
        wave: 3,
        path: path.to_owned(),
        delete: false,
        content_sha256: sha.to_owned(),
        preimage: preimage.map(str::to_owned),
    };
    let last_part = |path: &str| path.rsplit('/').next().unwrap_or(path).to_owned();
    for path in paths {
        let n = new_heads.get(path);
        match (new.disk.get(path), n) {
            (Some(d), Some(n)) if *d == n.sha256 => {}
            (Some(d), Some(n)) if replaceable(path, d) => {
                jobs.push(write(path, &n.sha256, Some(d)));
            }
            (Some(d), None) if replaceable(path, d) => jobs.push(PlannedJob {
                wave: 1,
                path: path.to_owned(),
                delete: true,
                content_sha256: d.clone(),
                preimage: Some(d.clone()),
            }),
            (Some(d), n) => {
                let why = if n.is_some() {
                    WHY_REPLACED
                } else if !own.contains(path)
                    && old_heads.get(path).is_some_and(|old| old.sha256 == *d)
                {
                    WHY_HIDDEN
                } else {
                    WHY_NOT_SENT
                };
                saves.push((RecoverySource::Disk, path.to_owned(), last_part(path), why));
                if let Some(n) = n {
                    jobs.push(write(path, &n.sha256, None));
                }
            }
            (None, Some(n)) => jobs.push(write(path, &n.sha256, None)),
            (None, None) => {}
        }
    }
    for version in &old.unsent.versions {
        let on_disk = new.disk.get(&version.path) == Some(&version.sha256);
        let shared = new_heads
            .get(version.path.as_str())
            .is_some_and(|head| head.sha256 == version.sha256);
        if on_disk || shared {
            continue;
        }
        if let Some(bytes) = old.version_bytes.get(&version.sha256) {
            saves.push((
                RecoverySource::Saved,
                version.path.clone(),
                last_part(&version.path),
                WHY_VERSION,
            ));
            copies.push(bytes.clone());
        }
    }
    for (title, text) in chat_files(&old.unsent) {
        saves.push((
            RecoverySource::Saved,
            format!("chat: {title}"),
            format!("chat {}.md", file_safe(&title)),
            WHY_CHAT,
        ));
        copies.push(text.into_bytes());
    }
    for draft in &params.live_drafts {
        let name = last_part(&draft.path);
        let stem = name.strip_suffix(".md").unwrap_or(&name);
        saves.push((
            RecoverySource::Saved,
            draft.path.clone(),
            format!("{} (open page).md", file_safe(stem)),
            WHY_DRAFT,
        ));
        copies.push(draft.text.clone().into_bytes());
    }
    let displaced = live_store(root).join(DISPLACED);
    if std::fs::read_dir(&displaced).is_ok_and(|mut entries| entries.next().is_some()) {
        saves.push((
            RecoverySource::Displaced,
            format!(".dohc/engine/{DISPLACED}"),
            DISPLACED.to_owned(),
            WHY_DISPLACED,
        ));
    }
    let undone: Vec<UndoneChange> = old
        .unsent
        .removals
        .iter()
        .filter(undoes)
        .map(|removal| UndoneChange {
            path: removal.path.clone(),
            moved_to: removal.moved_to.clone(),
        })
        .collect();

    let recovery_folder = if saves.is_empty() && undone.is_empty() {
        None
    } else {
        Some(pick_recovery_folder(root, manifest.closed_at_ms)?)
    };
    let mut recovery = Vec::new();
    let mut named = Vec::new();
    let mut copies = copies.into_iter();
    for ((source, path, name, why), number) in saves.into_iter().zip(1..) {
        let destination = numbered_name(number, &name);
        if source == RecoverySource::Saved {
            named.push((destination.clone(), copies.next().unwrap_or_default()));
        }
        recovery.push(RecoveryItem {
            number,
            source,
            path,
            destination,
            reason: why.to_owned(),
            done: false,
            found: None,
        });
    }
    Ok((
        RebuildPlan {
            reach: params.granted_selector["reach"].clone(),
            recovery_folder,
            recovery,
            undone,
            saved_drafts: params
                .live_drafts
                .iter()
                .map(|draft| draft.record_id.clone())
                .collect(),
            jobs,
            waves_done: 0,
        },
        named,
    ))
}

/// One Markdown file per thread with unsent chat: each message with its
/// author, time, what it replies to, its attachments and decisions.
fn chat_files(unsent: &RebuildUnsent) -> Vec<(String, String)> {
    let text = |payload: &Value, key: &str| payload[key].as_str().unwrap_or_default().to_owned();
    let excerpt = |message: &str| -> String {
        unsent.messages.get(message).map_or_else(
            || "a message".to_owned(),
            |(author, body)| {
                let line = body.lines().next().unwrap_or_default();
                let short: String = line.chars().take(80).collect();
                if short.len() < line.len() {
                    format!("{author}: \"{short}…\"")
                } else {
                    format!("{author}: \"{short}\"")
                }
            },
        )
    };
    // Each thread's sections in the order the member wrote them; a message's
    // attachments and decisions follow it.
    let mut threads: Vec<(String, Vec<ChatSection>)> = Vec::new();
    let mut details: Vec<(usize, String, String)> = Vec::new();
    for (kind, payload) in &unsent.chat {
        let id = text(payload, "threadId");
        let index = match threads.iter().position(|(thread, _)| *thread == id) {
            Some(index) => index,
            None => {
                threads.push((id, Vec::new()));
                threads.len() - 1
            }
        };
        match kind.as_str() {
            "chat.message.append" => {
                let at = payload["createdAtMs"]
                    .as_i64()
                    .map(utc_time)
                    .unwrap_or_default();
                let mut section = format!(
                    "## {}, {at}\n\n{}\n",
                    text(payload, "authorDisplayName"),
                    text(payload, "body")
                );
                if let Some(parent) = payload["parentMessageId"].as_str() {
                    section.push_str(&format!("\nReplying to {}\n", excerpt(parent)));
                }
                threads[index]
                    .1
                    .push((Some(text(payload, "messageId")), section));
            }
            "chat.attachment.add" => {
                let target = payload["pathHint"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| text(payload, "targetKind"));
                details.push((
                    index,
                    text(payload, "messageId"),
                    format!("Attached: {target}"),
                ));
            }
            "chat.decision.set" => {
                let mut line = format!("Decision: {}", text(payload, "state"));
                if let Some(chosen) = payload["chosenOption"].as_str() {
                    line.push_str(&format!(", chose \"{chosen}\""));
                }
                details.push((index, text(payload, "messageId"), line));
            }
            _ => {}
        }
    }
    for (index, message, line) in details {
        let sections = &mut threads[index].1;
        match sections
            .iter_mut()
            .find(|(id, _)| id.as_deref() == Some(message.as_str()))
        {
            Some((_, section)) => section.push_str(&format!("\n{line}\n")),
            None => sections.push((None, format!("## On {}\n\n{line}\n", excerpt(&message)))),
        }
    }
    threads
        .into_iter()
        .filter(|(_, sections)| !sections.is_empty())
        .map(|(id, sections)| {
            let title = unsent.thread_titles.get(&id).cloned().unwrap_or(id);
            let mut text = format!(
                "# {title}\n\nThese weren't sent before this workspace's access changed.\n"
            );
            for (_, section) in sections {
                text.push('\n');
                text.push_str(&section);
            }
            (title, text)
        })
        .collect()
}

/// A name that works as one path part on every platform.
fn file_safe(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|char| {
            if char.is_control() || "/\\:*?\"<>|".contains(char) {
                ' '
            } else {
                char
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim_end();
    if trimmed.is_empty() {
        "untitled".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// `.dohc/local/recovery/<date and time>`, adding `-2`, `-3` and so on when
/// the name is taken, relative to the root. `planned` makes it.
fn pick_recovery_folder(root: &Path, closed_at_ms: i64) -> Result<String, WireError> {
    let parent = local(root).join(RECOVERY);
    let stamp = utc_stamp(closed_at_ms);
    (1..1000)
        .map(|attempt| {
            if attempt == 1 {
                stamp.clone()
            } else {
                format!("{stamp}-{attempt}")
            }
        })
        .find(|name| !parent.join(name).exists())
        .map(|name| format!("{LOCAL_STATE_RELATIVE_PATH}/{RECOVERY}/{name}"))
        .ok_or_else(|| failed("share-view-rebuild-recovery-unavailable"))
}

/// `2026-11-16 11-05 UTC` for a time in Unix milliseconds.
fn utc_stamp(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}-{:02} UTC",
        rest / 3600,
        rest % 3600 / 60
    )
}

/// `2026-11-16 11:05 UTC`, for text rather than a file name.
fn utc_time(ms: i64) -> String {
    let stamp = utc_stamp(ms);
    match stamp.rfind('-') {
        Some(dash) => format!("{}:{}", &stamp[..dash], &stamp[dash + 1..]),
        None => stamp,
    }
}

/// `<number> <name>`, shortened before its extension to fit one path part.
fn numbered_name(number: u32, name: &str) -> String {
    let prefix = format!("{number:04} ");
    let room = MAX_NAME_BYTES - prefix.len();
    if name.len() <= room {
        return format!("{prefix}{name}");
    }
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 && name.len() - dot < room => name.split_at(dot),
        _ => (name, ""),
    };
    let mut end = room - extension.len();
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    format!("{prefix}{}{extension}", &stem[..end])
}

/// Move a file or folder to its recovery destination without replacing
/// anything. Answers whether there was one to move. A destination that
/// exists is a move already done.
fn recover(source: &Path, destination: &Path) -> Result<bool, WireError> {
    if destination.exists() {
        return Ok(true);
    }
    if !source.exists() {
        return Ok(false);
    }
    if let Some(folder) = destination.parent() {
        std::fs::create_dir_all(folder)
            .map_err(|_| failed("share-view-rebuild-recovery-unavailable"))?;
    }
    dohc_engine_files::move_file_no_replace(source, destination).map_err(|error| {
        failed(if maybe_held(&error) {
            "share-view-rebuild-file-held"
        } else {
            "share-view-rebuild-recovery-move-failed"
        })
    })?;
    Ok(true)
}

fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Write the recovery folder's `contents.md` from the manifest.
fn write_contents(root: &Path, manifest: &RebuildManifest) -> Result<(), WireError> {
    let Some(plan) = manifest.plan.as_ref() else {
        return Ok(());
    };
    let Some(folder) = plan.recovery_folder.as_deref() else {
        return Ok(());
    };
    let mut text = format!(
        "# Saved files\n\nThis workspace's access changed on {}. dohc saved here what the \
         server hadn't received from this copy, instead of deleting it.\n",
        utc_time(manifest.closed_at_ms)
    );
    if !plan.recovery.is_empty() {
        text.push_str("\n| Saved as | Was at | Why |\n| --- | --- | --- |\n");
    }
    for item in &plan.recovery {
        let why = if item.found == Some(false) {
            format!("{} It wasn't found.", item.reason)
        } else {
            item.reason.clone()
        };
        text.push_str(&format!(
            "| {} | {} | {} |\n",
            item.destination, item.path, why
        ));
    }
    if !plan.undone.is_empty() {
        text.push_str(
            "\n## Undone\n\nThe server never received these changes, so the files are back where \
             they were:\n\n",
        );
        for change in &plan.undone {
            match &change.moved_to {
                Some(moved_to) => {
                    text.push_str(&format!("- `{moved_to}` moved back to `{}`\n", change.path));
                }
                None => text.push_str(&format!("- `{}`, which you deleted\n", change.path)),
            }
        }
    }
    let folder = root.join(folder);
    let temp = folder.join(format!("{CONTENTS}.tmp"));
    let written = std::fs::create_dir_all(&folder)
        .and_then(|()| write_synced(&temp, text.as_bytes()))
        .and_then(|()| std::fs::rename(&temp, folder.join(CONTENTS)));
    written.map_err(|_| failed("share-view-rebuild-recovery-unavailable"))
}

/// Whether another program's open file may be what stopped a move. Windows
/// reports a rename blocked by a held file as access denied (5), as it does
/// a real denial, so this can't be sure.
fn maybe_held(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::ResourceBusy {
        return true;
    }
    // ERROR_ACCESS_DENIED (5), ERROR_SHARING_VIOLATION (32) and
    // ERROR_LOCK_VIOLATION (33). On Unix these numbers mean other things.
    cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

/// Rename, trying again with backoff: on Windows a handle another program
/// holds blocks a rename for a moment.
async fn rename_retrying(from: &Path, to: &Path) -> Result<(), WireError> {
    let mut delay = Duration::from_millis(50);
    for attempt in 0..3 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(_) if attempt < 2 => {
                tokio::time::sleep(delay).await;
                delay *= 4;
            }
            Err(error) if maybe_held(&error) => return Err(failed("share-view-rebuild-file-held")),
            Err(_) => break,
        }
    }
    Err(failed("share-view-rebuild-rename-failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stamp_names_the_utc_minute() {
        assert_eq!(utc_stamp(0), "1970-01-01 00-00 UTC");
        assert_eq!(utc_stamp(1_794_827_100_000), "2026-11-16 11-05 UTC");
        assert_eq!(utc_time(1_794_827_100_000), "2026-11-16 11:05 UTC");
    }

    #[test]
    fn a_long_name_is_shortened_before_its_extension() {
        assert_eq!(numbered_name(7, "notes.md"), "0007 notes.md");
        let long = format!("{}.md", "é".repeat(200));
        let named = numbered_name(1, &long);
        assert!(named.len() <= MAX_NAME_BYTES, "{}", named.len());
        assert!(
            named.starts_with("0001 é") && named.ends_with("é.md"),
            "{named}"
        );
    }

    /// A rename another program's open file blocks names the held file, so
    /// main can tell the member what to close.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_rename_a_held_file_blocks_says_the_file_is_held() {
        use std::os::windows::fs::OpenOptionsExt;
        let scratch = dohc_engine_testkit::ScratchDir::new().expect("scratch");
        let from = scratch.path().join("engine");
        std::fs::create_dir(&from).expect("folder");
        std::fs::write(from.join("engine.db"), b"store").expect("file");
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(from.join("engine.db"))
            .expect("hold");
        let error = rename_retrying(&from, &scratch.path().join("aside"))
            .await
            .expect_err("held");
        assert_eq!(error.message, "share-view-rebuild-file-held");
        drop(held);
        rename_retrying(&from, &scratch.path().join("aside"))
            .await
            .expect("free");
    }

    #[test]
    fn a_title_becomes_one_safe_path_part() {
        assert_eq!(file_safe("Plans: a/b?"), "Plans  a b");
        assert_eq!(file_safe(" ... "), "untitled");
    }
}
