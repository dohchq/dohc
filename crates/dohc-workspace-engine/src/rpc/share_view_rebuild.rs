//! `share.view.rebuild`: rebuild a joined copy that closed because the relay
//! changed which items the member sees.
//!
//! The manifest (`rebuild_manifest`) decides every step, so a call after a
//! crash continues where the last one stopped:
//!
//! - `closed`: settle the old store and check it holds no work of the
//!   member's own; build a new store from the relay under
//!   `.dohc/local/rebuild/`; plan how the files on disk converge; write
//!   `planned`. A copy with own work stays in `closed`.
//! - `planned`: write the recovery folder's `contents.md`, then `saved`.
//! - `saved`: make the aside folder empty, then `swapping`.
//! - `swapping`: rename the old store aside and the new one into place, as
//!   the three folders on disk say is left to do, then `swapped`.
//! - `swapped`: converge the files in three waves, then `converged`.
//!
//! `share.view.rebuildFinish` deletes what the rebuild left once main has
//! stored the new reach, and the manifest last.
//!
//! The caller closes every handle on the root first. Only a copy with no own
//! work is rebuilt here; one with own work waits for the plan that keeps it.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::{
    ActorHandle, RebuildHead, RebuildJob, RelayOperation, RelayOperationOutcome,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::rebuild_manifest::{
    self, PlannedJob, RebuildManifest, RebuildPhase, RebuildPlan, RecoveryItem,
};
use crate::root_binding::{self, LOCAL_STATE_RELATIVE_PATH};
use crate::rpc::error::map_runtime;
use crate::rpc::rebuild::updating_access;
use crate::rpc::relay::{GrantedSelectorParams, share_grant};
use crate::rpc::request::{now_ms, parse};
use crate::{EngineService, lock};

const STAGING: &str = "rebuild";
const ASIDE: &str = "rebuild-aside";
const SHARE_REFRESH: &str = "share-refresh";
const RECOVERY: &str = "recovery";
const CONTENTS: &str = "contents.md";
const LEFT_REACH_UNCHANGED: &str = "left reach, unchanged copy";
/// The longest name one path part may have, in bytes.
const MAX_NAME_BYTES: usize = 255;

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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinishParams {
    root_dir: String,
    rebuild_id: String,
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
                RebuildPhase::Planned => {
                    write_contents(&root, &manifest)?;
                    write_manifest(
                        &root,
                        &RebuildManifest {
                            phase: RebuildPhase::Saved,
                            ..manifest
                        },
                    )?;
                }
                RebuildPhase::Saved => {
                    let aside = aside(&root);
                    remove_folder(&aside)
                        .and_then(|()| std::fs::create_dir(&aside))
                        .map_err(|_| failed("share-view-rebuild-aside-unavailable"))?;
                    let existed = local(&root).join(SHARE_REFRESH).exists();
                    write_manifest(
                        &root,
                        &RebuildManifest {
                            phase: RebuildPhase::Swapping,
                            share_refresh_existed: Some(existed),
                            ..manifest
                        },
                    )?;
                }
                RebuildPhase::Swapping => self.rebuild_swap(&root, manifest).await?,
                RebuildPhase::Swapped => {
                    self.rebuild_converge(ctx, &root, &params.workspace_id, manifest)
                        .await?;
                }
                RebuildPhase::Converged => {
                    let plan = manifest.plan.as_ref();
                    return Ok(json!({
                        "state": "rebuilt",
                        "reach": plan.map(|plan| plan.reach.clone()),
                        "recoveryFolder": plan.and_then(|plan| plan.recovery_folder.clone()),
                        "recovered": plan.map_or(0, |plan| plan.recovery.len()),
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
        Ok(json!({ "finished": true }))
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

    /// `closed`: check the old store, build the new one and plan. Answers
    /// when the rebuild stops here; `None` once `planned` is written.
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
        let checked = self.rebuild_check_old(&old, root, workspace_id).await;
        self.workspace_close(Some(old)).await?;
        let (old_heads, kinds) = checked?;
        if !kinds.is_empty() {
            return Ok(Some(json!({ "state": "ownWork", "kinds": kinds })));
        }

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
        let built = self.rebuild_build(ctx, &staging, params, &old_heads).await;
        self.workspace_close(Some(staging)).await?;
        let (new_heads, held) = match built? {
            Ok(built) => built,
            Err(served) => {
                remove_folder(&staging_root(root))
                    .map_err(|_| failed("share-view-rebuild-staging-left"))?;
                return Ok(Some(json!({ "state": "reachMoved", "served": served })));
            }
        };
        self.rebuild_crash_point("built")?;

        let plan = plan(root, &manifest, &old_heads, &new_heads, &held, params)?;
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

    /// The old store's current files, and each kind of own work it holds.
    async fn rebuild_check_old(
        &self,
        handle: &WorkspaceHandle,
        root: &Path,
        workspace_id: &str,
    ) -> Result<(Vec<RebuildHead>, Vec<String>), WireError> {
        let actor = self.rebuild_actor(handle)?;
        let mut kinds = actor
            .rebuild_own_work(workspace_id.to_owned())
            .await
            .map_err(map_runtime)?;
        let displaced = live_store(root).join("displaced");
        if std::fs::read_dir(&displaced).is_ok_and(|mut entries| entries.next().is_some()) {
            kinds.push("displaced files".to_owned());
        }
        let heads = actor
            .rebuild_main_heads(workspace_id.to_owned())
            .await
            .map_err(map_runtime)?;
        // The disk must hold exactly the old store's files: anything else is
        // an edit capture has not journaled.
        let mut changed = false;
        for head in &heads {
            match std::fs::read(root.join(&head.path)) {
                Ok(bytes) if dohc_engine_storage::hex_sha256(&bytes) == head.sha256 => {}
                _ => changed = true,
            }
        }
        if changed {
            kinds.push("changed files".to_owned());
        }
        let tracked: HashSet<&str> = heads.iter().map(|head| head.path.as_str()).collect();
        let mut untracked = false;
        walk_files(root, root, &mut |path| {
            untracked |= !tracked.contains(path);
        })
        .map_err(|_| failed("share-view-rebuild-disk-unreadable"))?;
        if untracked {
            kinds.push("new files".to_owned());
        }
        Ok((heads, kinds))
    }

    /// Pull the share from the start into the staging store. Answers its
    /// current files and which of the old store's blobs it holds, or the
    /// revisions the relay served when they differ from the grant's.
    async fn rebuild_build(
        &self,
        ctx: &RequestContext,
        handle: &WorkspaceHandle,
        params: &RebuildParams,
        old_heads: &[RebuildHead],
    ) -> Result<Result<(Vec<RebuildHead>, HashSet<String>), Value>, WireError> {
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
                    "revision": served.revision,
                    "visibilityRevision": served.visibility_revision,
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
        let heads = open
            .actor
            .rebuild_main_heads(params.workspace_id.clone())
            .await
            .map_err(map_runtime)?;
        let held = open
            .actor
            .rebuild_held_blobs(old_heads.iter().map(|head| head.sha256.clone()).collect())
            .await
            .map_err(map_runtime)?;
        Ok(Ok((heads, held)))
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
                if item.done {
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
            .materialize_replay_pending(root.to_path_buf(), workspace_id.to_owned(), now)
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
        jobs: Vec::new(),
        waves_done: 0,
    }
}

/// Each path either store holds is No step, a converge job, or a recovery
/// move then a write. A file whose bytes the new store can't confirm is never
/// deleted or replaced in place: it moves to the recovery folder.
fn plan(
    root: &Path,
    manifest: &RebuildManifest,
    old_heads: &[RebuildHead],
    new_heads: &[RebuildHead],
    held: &HashSet<String>,
    params: &RebuildParams,
) -> Result<RebuildPlan, WireError> {
    let old: BTreeMap<&str, &RebuildHead> = old_heads
        .iter()
        .map(|head| (head.path.as_str(), head))
        .collect();
    let new: BTreeMap<&str, &RebuildHead> = new_heads
        .iter()
        .map(|head| (head.path.as_str(), head))
        .collect();
    let paths: BTreeSet<&str> = old.keys().chain(new.keys()).copied().collect();
    let mut jobs = Vec::new();
    let mut moves = Vec::new();
    let write = |path: &str, sha: &str, preimage: Option<&str>| PlannedJob {
        wave: 3,
        path: path.to_owned(),
        delete: false,
        content_sha256: sha.to_owned(),
        preimage: preimage.map(str::to_owned),
    };
    for path in paths {
        match (old.get(path), new.get(path)) {
            (Some(old), Some(new)) if old.sha256 == new.sha256 => {}
            (Some(old), Some(new)) if held.contains(&old.sha256) => {
                jobs.push(write(path, &new.sha256, Some(&old.sha256)));
            }
            (Some(_), Some(new)) => {
                moves.push(path);
                jobs.push(write(path, &new.sha256, None));
            }
            (Some(old), None) if held.contains(&old.sha256) => jobs.push(PlannedJob {
                wave: 1,
                path: path.to_owned(),
                delete: true,
                content_sha256: old.sha256.clone(),
                preimage: Some(old.sha256.clone()),
            }),
            (Some(_), None) => moves.push(path),
            (None, Some(new)) => jobs.push(write(path, &new.sha256, None)),
            (None, None) => {}
        }
    }
    let recovery_folder = if moves.is_empty() {
        None
    } else {
        Some(make_recovery_folder(root, manifest.closed_at_ms)?)
    };
    let recovery = moves
        .into_iter()
        .zip(1..)
        .map(|(path, number)| RecoveryItem {
            number,
            path: path.to_owned(),
            destination: numbered_name(number, path.rsplit('/').next().unwrap_or(path)),
            reason: LEFT_REACH_UNCHANGED.to_owned(),
            done: false,
            found: None,
        })
        .collect();
    Ok(RebuildPlan {
        reach: params.granted_selector["reach"].clone(),
        recovery_folder,
        recovery,
        jobs,
        waves_done: 0,
    })
}

/// Make `.dohc/local/recovery/<date and time>`, adding `-2`, `-3` and so on
/// when the name is taken. Answers it relative to the root.
fn make_recovery_folder(root: &Path, closed_at_ms: i64) -> Result<String, WireError> {
    let parent = local(root).join(RECOVERY);
    std::fs::create_dir_all(&parent)
        .map_err(|_| failed("share-view-rebuild-recovery-unavailable"))?;
    let stamp = utc_stamp(closed_at_ms);
    for attempt in 1..1000 {
        let name = if attempt == 1 {
            stamp.clone()
        } else {
            format!("{stamp}-{attempt}")
        };
        match std::fs::create_dir(parent.join(&name)) {
            Ok(()) => return Ok(format!("{LOCAL_STATE_RELATIVE_PATH}/{RECOVERY}/{name}")),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => break,
        }
    }
    Err(failed("share-view-rebuild-recovery-unavailable"))
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

/// Move a file to its recovery destination without replacing anything.
/// Answers whether there was a file to move. A destination that exists is a
/// move already done.
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
    dohc_engine_files::move_file_no_replace(source, destination)
        .map_err(|_| failed("share-view-rebuild-recovery-move-failed"))?;
    Ok(true)
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
        "# Saved files\n\nThis workspace's access changed on {}. dohc moved these files here \
         instead of deleting them.\n\n| Saved as | Was at | Why |\n| --- | --- | --- |\n",
        utc_stamp(manifest.closed_at_ms)
    );
    for item in &plan.recovery {
        let why = if item.found == Some(false) {
            format!("{}; the file wasn't found", item.reason)
        } else {
            item.reason.clone()
        };
        text.push_str(&format!(
            "| {} | {} | {} |\n",
            item.destination, item.path, why
        ));
    }
    let folder = root.join(folder);
    let temp = folder.join(format!("{CONTENTS}.tmp"));
    let written = (|| {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temp, folder.join(CONTENTS))
    })();
    written.map_err(|_| failed("share-view-rebuild-recovery-unavailable"))
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
            Err(_) => break,
        }
    }
    Err(failed("share-view-rebuild-rename-failed"))
}

/// Call `found` with every file under `folder`, as a path relative to
/// `root` with `/` separators. Skips `.dohc` at the root.
fn walk_files(root: &Path, folder: &Path, found: &mut dyn FnMut(&str)) -> std::io::Result<()> {
    for entry in std::fs::read_dir(folder)? {
        let entry = entry?;
        let path = entry.path();
        if folder == root && entry.file_name() == ".dohc" {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            walk_files(root, &path, found)?;
        } else if let Ok(relative) = path.strip_prefix(root) {
            let relative: Vec<String> = relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect();
            found(&relative.join("/"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stamp_names_the_utc_minute() {
        assert_eq!(utc_stamp(0), "1970-01-01 00-00 UTC");
        assert_eq!(utc_stamp(1_794_827_100_000), "2026-11-16 11-05 UTC");
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
}
