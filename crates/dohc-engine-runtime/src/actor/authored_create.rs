use super::versioned::versioned_text_write_on_store;
use super::versions::ensure_mutation_version_on_store;
use super::{ActorHandle, LifecycleState};
use crate::{EngineDbIdentity, RuntimeError};
use dohc_engine_domain::{
    DomainError, VersionedTextStore, WriteResult, WriteText, write_text_in_tx,
};
use dohc_engine_files::materialize::{
    AuthoredCreatePublishError, AuthoredCreateStage, cleanup_authored_create_stages,
};
use dohc_engine_files::search_policy::{read_engine_search_policy, resolve_effective_policy};
use dohc_engine_storage::{
    EngineStore, FaultInjector, NoFaults, StorageError, TxnOutcome, hex_sha256,
};
use rusqlite::{OptionalExtension, params};
use std::path::{Path, PathBuf};
use std::sync::{Arc, atomic::Ordering};
use tokio_util::sync::CancellationToken;

fn validate_root(root: &Path, identity: &EngineDbIdentity) -> Result<(), RuntimeError> {
    if EngineDbIdentity::of_existing(&root.join(".dohc/engine/engine.db"))? != *identity {
        return Err(RuntimeError::Identity {
            reason: "authored create root no longer owns the actor database",
            source: None,
        });
    }
    Ok(())
}

fn pending(store: &EngineStore) -> Result<Option<(WriteText, String)>, RuntimeError> {
    let row: Option<(String, String)> = store.read_with(|conn| {
        conn.query_row(
            "SELECT input_json, stage_id FROM authored_create_intent WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::corrupt_public)
    })?;
    row.map(|(json, stage)| {
        let input = serde_json::from_str(&json).map_err(|_| DomainError::StateCorrupt {
            reason: "invalid authored create intent",
        })?;
        Ok((input, stage))
    })
    .transpose()
}

fn admit(store: &mut EngineStore, input: &WriteText, root: &Path) -> Result<(), RuntimeError> {
    dohc_engine_domain::validate_write_input(input)?;
    let policy = read_engine_search_policy(root);
    let effective = resolve_effective_policy(
        &input.path,
        policy.files_policy.as_deref(),
        policy.visibility_policy.as_deref(),
    );
    if policy.is_degraded() || !effective.tracked {
        return Err(DomainError::InvalidInput {
            reason: "authored create path is not tracked",
        }
        .into());
    }
    let versions = VersionedTextStore::new(store);
    if versions.get_active_version(&input.workspace_id)?.version_id != input.version_id {
        return Err(DomainError::InvalidVersion.into());
    }
    Ok(())
}

fn require_absent_head(store: &mut EngineStore, input: &WriteText) -> Result<(), RuntimeError> {
    let versions = VersionedTextStore::new(store);
    match versions.read_text(&input.workspace_id, &input.version_id, &input.path) {
        Ok(None) => Ok(()),
        Ok(Some(_)) | Err(DomainError::BinaryHeadNotText) => {
            Err(DomainError::TargetPathExists.into())
        }
        Err(error) => Err(error.into()),
    }
}

fn discard(store: &mut EngineStore) -> Result<(), RuntimeError> {
    store.write_with(&NoFaults, |tx| {
        tx.execute("DELETE FROM authored_create_intent WHERE singleton = 1", [])
            .map_err(StorageError::persist_public)?;
        Ok::<_, RuntimeError>(())
    })?;
    Ok(())
}

impl ActorHandle {
    /// A published file cannot reach capture until its original author commits.
    pub async fn versioned_text_create(
        &self,
        input: WriteText,
        root: PathBuf,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        self.versioned_text_create_with_publish(
            input,
            root,
            faults,
            token,
            AuthoredCreateStage::publish,
        )
        .await
    }

    async fn versioned_text_create_with_publish(
        &self,
        input: WriteText,
        root: PathBuf,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        publish: impl FnOnce(&AuthoredCreateStage) -> Result<bool, AuthoredCreatePublishError>
        + Send
        + 'static,
    ) -> Result<WriteResult, RuntimeError> {
        let state = Arc::clone(&self.state);
        let identity = self.identity.clone();
        self.run(move |store, cache| {
            cache.clear();
            let result = create_on_store(
                store,
                &input,
                &root,
                &identity,
                faults.as_ref(),
                &token,
                publish,
            );
            if result.is_err() && pending(store).map_or(true, |row| row.is_some()) {
                // The worker closes after this command. Queued capture requests
                // fail, and workspace reopen recovers before starting a watcher.
                state.store(LifecycleState::RecoveryRequired.as_u8(), Ordering::Release);
                return Err(RuntimeError::ActorUnavailable);
            }
            result
        })
        .await
    }

    pub async fn recover_authored_create(
        &self,
        workspace_id: String,
        root: PathBuf,
    ) -> Result<(), RuntimeError> {
        let claims = self.claims.clone();
        let identity = self.identity.clone();
        self.run(move |store, cache| {
            validate_root(&root, &identity)?;
            if let Some((input, id)) = pending(store)? {
                if input.workspace_id != workspace_id {
                    return Err(DomainError::WorkspaceMismatch.into());
                }
                cache.clear();
                let stage = AuthoredCreateStage::open(&root, &input.path, &id)?;
                if stage.is_published()? {
                    admit(store, &input, &root)?;
                    require_absent_head(store, &input)?;
                    let result = versioned_text_write_on_store(
                        store,
                        &input,
                        Some(&root),
                        None,
                        true,
                        &NoFaults,
                        &CancellationToken::new(),
                    )?;
                    claims.announce(&result.automation_claims);
                } else {
                    discard(store)?;
                }
                let _ = stage.cleanup();
            }
            // Private cleanup never changes the outcome of committed history.
            let _ = cleanup_authored_create_stages(&root);
            Ok(())
        })
        .await
    }
}

fn create_on_store(
    store: &mut EngineStore,
    input: &WriteText,
    root: &Path,
    identity: &EngineDbIdentity,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
    publish: impl FnOnce(&AuthoredCreateStage) -> Result<bool, AuthoredCreatePublishError>,
) -> Result<WriteResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    if pending(store)?.is_some() {
        return Err(RuntimeError::ActorUnavailable);
    }
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        &NoFaults,
    )?;
    validate_root(root, identity)?;
    admit(store, input, root)?;
    let is_create_replay = store.read_with(|conn| {
        conn.query_row(
            "SELECT kind = 'authored-create' FROM engine_requests WHERE request_id = ?1",
            [&input.request_id],
            |row| row.get::<_, bool>(0),
        )
        .optional()
        .map(|found| found.unwrap_or(false))
        .map_err(StorageError::corrupt_public)
    })?;
    if !is_create_replay {
        require_absent_head(store, input)?;
    }
    // The domain validates the exact request payload and reconstructs its
    // original result. Only a committed create may bypass the absent-path rule.
    let preview = store.preview_write(|tx| write_text_in_tx(tx, input))?;
    if preview.deduped {
        return if is_create_replay {
            Ok(preview)
        } else {
            Err(DomainError::TargetPathExists.into())
        };
    }
    if is_create_replay {
        return Err(DomainError::StateCorrupt {
            reason: "authored create replay has no prior result",
        }
        .into());
    }
    let id = hex_sha256(format!("{}\0{}", input.workspace_id, input.moment_id).as_bytes());
    let stage = AuthoredCreateStage::open(root, &input.path, &id)?;
    // The actor proved no intent is pending. This private stage can only be
    // an abandoned preparation from an earlier attempt with the same identity.
    stage.cleanup()?;
    if let Err(error) = stage.prepare(&input.text) {
        let _ = stage.cleanup();
        return Err(error.into());
    }
    let json = serde_json::to_string(input).map_err(|_| DomainError::StateCorrupt {
        reason: "could not encode authored create intent",
    })?;
    let saved = store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO authored_create_intent (singleton, input_json, stage_id) VALUES (1, ?1, ?2)", params![json, id]).map_err(StorageError::persist_public)?;
        Ok::<_, RuntimeError>(())
    });
    if !matches!(saved, Ok(TxnOutcome::Committed(()))) {
        // A failed insert may have committed. Keep its evidence unless the
        // actor can prove that no intent references the private stage.
        if matches!(pending(store), Ok(None)) {
            let _ = stage.cleanup();
        }
        saved?;
        return Err(RuntimeError::OperationCrashed);
    }
    if token.is_cancelled() {
        discard(store)?;
        let _ = stage.cleanup();
        return Err(RuntimeError::Cancelled);
    }
    validate_root(root, identity)?;
    match publish(&stage) {
        Ok(true) => {}
        Ok(false) => {
            discard(store)?;
            let _ = stage.cleanup();
            return Err(DomainError::TargetPathExists.into());
        }
        Err(error) => {
            if !error.may_be_published {
                discard(store)?;
                let _ = stage.cleanup();
            }
            return Err(error.error.into());
        }
    }
    // Cancellation after publication cannot abandon authorship. The durable
    // intent survives any failure here; recovery uses these exact IDs and author.
    let result = versioned_text_write_on_store(
        store,
        input,
        Some(root),
        None,
        true,
        faults,
        &CancellationToken::new(),
    )?;
    let _ = stage.cleanup();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EngineDbIdentity, WorkspaceActor};
    use dohc_engine_files::materialize::MaterializeError;
    use dohc_engine_storage::FaultPoint;
    use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};

    fn input() -> WriteText {
        WriteText {
            workspace_id: "create-test".into(), version_id: "main".into(),
            object_id: "object-created".into(), path: "tasks/record.md".into(),
            text: "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\nBody".into(),
            moment_id: "created".into(), metadata_origin: "api".into(),
            metadata_summary: None, metadata_correlation_id: None,
            author_json: Some(r#"[{"kind":"automation","automationId":"collection:tasks#create","onBehalfOf":"local","depth":2}]"#.into()),
            now_ms: 2, request_id: Some("create-request".into()),
        }
    }

    fn open(root: &Path) -> WorkspaceActor {
        let db = engine_db_path(root).expect("db");
        let identity = EngineDbIdentity::resolve_or_create(&db).expect("identity");
        WorkspaceActor::spawn(db, identity, 1, 1, None).expect("actor")
    }

    async fn assert_moment(actor: &ActorHandle, expected: bool) {
        actor
            .run(move |store, _| {
                let input = input();
                let moment = VersionedTextStore::new(store)
                    .get_moment(&input.workspace_id, &input.moment_id)?;
                assert_eq!(moment.is_some(), expected);
                if let Some(moment) = moment {
                    assert_eq!(moment.author_json, input.author_json);
                }
                assert!(pending(store)?.is_none());
                Ok(())
            })
            .await
            .expect("history");
    }

    #[tokio::test]
    async fn create_replay_rejects_different_payload_and_ordinary_write_requests() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut actor = open(scratch.path());
        actor
            .handle()
            .versioned_text_create(
                input(),
                scratch.path().into(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("create");
        let mut changed = input();
        changed.text = "different input".into();
        assert!(matches!(
            actor
                .handle()
                .versioned_text_create(
                    changed,
                    scratch.path().into(),
                    Arc::new(NoFaults),
                    CancellationToken::new()
                )
                .await,
            Err(RuntimeError::Domain(
                DomainError::IdempotencyKeyReuseMismatch
            ))
        ));
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/record.md")).expect("bytes"),
            input().text
        );
        actor.close().expect("close");
        let ordinary = ScratchDir::new().expect("ordinary scratch");
        let mut actor = open(ordinary.path());
        actor
            .handle()
            .versioned_text_write(input(), Arc::new(NoFaults), CancellationToken::new())
            .await
            .expect("ordinary write");
        assert!(matches!(
            actor
                .handle()
                .versioned_text_create(
                    input(),
                    ordinary.path().into(),
                    Arc::new(NoFaults),
                    CancellationToken::new()
                )
                .await,
            Err(RuntimeError::Domain(DomainError::TargetPathExists))
        ));
        assert!(!ordinary.path().join("tasks/record.md").exists());
        actor.close().expect("close");
    }

    #[tokio::test]
    async fn abandoned_private_preparation_does_not_block_the_same_create() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut actor = open(scratch.path());
        let input = input();
        let id = hex_sha256(format!("{}\0{}", input.workspace_id, input.moment_id).as_bytes());
        AuthoredCreateStage::open(scratch.path(), &input.path, &id)
            .expect("stage")
            .prepare("partial preparation")
            .expect("abandoned bytes");
        actor
            .handle()
            .versioned_text_create(
                input,
                scratch.path().into(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("retry");
        assert_moment(&actor.handle(), true).await;
        actor.close().expect("close");
    }

    #[tokio::test]
    async fn supervisor_replaces_an_actor_that_requires_recovery() {
        let scratch = ScratchDir::new().expect("scratch");
        let db = engine_db_path(scratch.path()).expect("db");
        let supervisor = crate::WorkspaceSupervisor::new();
        let first = supervisor.open(&db, 1).expect("first actor");
        // Hold the observable state at the point before the worker's Closed guard.
        first
            .actor
            .state
            .store(LifecycleState::RecoveryRequired.as_u8(), Ordering::Release);
        let replacement = supervisor.open(&db, 2).expect("replacement actor");
        assert!(
            replacement.created_actor,
            "reconnect must not reuse the fenced actor"
        );
        replacement
            .actor
            .run(|_, _| Ok(()))
            .await
            .expect("replacement accepts work");
        supervisor.close_all().expect("close");
    }

    #[tokio::test]
    async fn a_regular_file_parent_refuses_create_without_fencing_the_actor() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut actor = open(scratch.path());
        std::fs::write(scratch.path().join("tasks"), "keep parent file").expect("parent file");
        let result = actor
            .handle()
            .versioned_text_create(
                input(),
                scratch.path().into(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(
            result,
            Err(RuntimeError::Materialize(MaterializeError::Io {
                kind: std::io::ErrorKind::NotADirectory,
                ..
            }))
        ));
        assert_moment(&actor.handle(), false).await;
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks")).expect("parent bytes"),
            "keep parent file"
        );
        actor.close().expect("close");
    }

    #[tokio::test]
    async fn unpublished_create_failure_preserves_actor_and_returns_filesystem_error() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut actor = open(scratch.path());
        let result = actor
            .handle()
            .versioned_text_create_with_publish(
                input(),
                scratch.path().into(),
                Arc::new(NoFaults),
                CancellationToken::new(),
                |stage| {
                    stage
                        .cleanup()
                        .expect("make publication evidence unavailable");
                    Err(AuthoredCreatePublishError {
                        may_be_published: false,
                        error: MaterializeError::Io {
                            path: "tasks/record.md".into(),
                            kind: std::io::ErrorKind::Unsupported,
                        },
                    })
                },
            )
            .await;
        assert!(matches!(
            result,
            Err(RuntimeError::Materialize(MaterializeError::Io {
                kind: std::io::ErrorKind::Unsupported,
                ..
            }))
        ));
        assert!(!scratch.path().join("tasks/record.md").exists());
        assert_moment(&actor.handle(), false).await;
        actor
            .handle()
            .versioned_text_create(
                input(),
                scratch.path().into(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("retry in same actor");
        assert_moment(&actor.handle(), true).await;
        actor.close().expect("close");
    }

    #[tokio::test]
    async fn published_create_error_keeps_recovery_evidence() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut actor = open(scratch.path());
        let result = actor
            .handle()
            .versioned_text_create_with_publish(
                input(),
                scratch.path().into(),
                Arc::new(NoFaults),
                CancellationToken::new(),
                |stage| {
                    assert!(stage.publish().map_err(|e| e.error).expect("publish"));
                    Err(AuthoredCreatePublishError {
                        may_be_published: true,
                        error: MaterializeError::Io {
                            path: "tasks/record.md".into(),
                            kind: std::io::ErrorKind::PermissionDenied,
                        },
                    })
                },
            )
            .await;
        assert!(matches!(result, Err(RuntimeError::ActorUnavailable)));
        actor.close().expect("close");
        let mut recovered = open(scratch.path());
        recovered
            .handle()
            .recover_authored_create("create-test".into(), scratch.path().into())
            .await
            .expect("recover");
        assert_moment(&recovered.handle(), true).await;
        recovered.close().expect("close recovered");
    }

    #[tokio::test]
    async fn failed_intent_insert_allows_same_moment_retry_without_reopen() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut actor = open(scratch.path());
        actor.handle().run(|store, _| {
            store.write_with(&NoFaults, |tx| {
                tx.execute_batch("CREATE TEMP TRIGGER reject_create_intent BEFORE INSERT ON authored_create_intent BEGIN SELECT RAISE(ABORT, 'test insertion failure'); END;").map_err(StorageError::persist_public)?;
                Ok::<_, RuntimeError>(())
            })?;
            Ok(())
        }).await.expect("install fault");
        assert!(
            actor
                .handle()
                .versioned_text_create(
                    input(),
                    scratch.path().into(),
                    Arc::new(NoFaults),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert_moment(&actor.handle(), false).await;
        actor
            .handle()
            .run(|store, _| {
                store.write_with(&NoFaults, |tx| {
                    tx.execute_batch("DROP TRIGGER reject_create_intent")
                        .map_err(StorageError::persist_public)?;
                    Ok::<_, RuntimeError>(())
                })?;
                Ok(())
            })
            .await
            .expect("remove fault");
        actor
            .handle()
            .versioned_text_create(
                input(),
                scratch.path().into(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("same moment retry");
        assert_moment(&actor.handle(), true).await;
        actor.close().expect("close");
    }

    #[tokio::test]
    async fn authored_create_rejects_secret_paths_and_other_workspace_roots() {
        let scratch = ScratchDir::new().expect("scratch");
        let other = ScratchDir::new().expect("other root");
        let mut actor = open(scratch.path());
        let mut other_actor = open(other.path());
        let mut secret = input();
        secret.path = ".env".into();
        assert!(
            actor
                .handle()
                .versioned_text_create(
                    secret,
                    scratch.path().into(),
                    Arc::new(NoFaults),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert!(!scratch.path().join(".env").exists());
        assert!(
            actor
                .handle()
                .versioned_text_create(
                    input(),
                    other.path().into(),
                    Arc::new(NoFaults),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert!(!other.path().join("tasks/record.md").exists());
        assert_moment(&actor.handle(), false).await;
        actor.close().expect("close");
        other_actor.close().expect("close other");
    }

    #[tokio::test]
    async fn authored_create_collision_preserves_bytes_identity_and_history() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut actor = open(scratch.path());
        let target = scratch.path().join("tasks/record.md");
        std::fs::create_dir_all(target.parent().expect("parent")).expect("directory");
        std::fs::write(&target, "external record").expect("external create");
        let identity = file_id::get_file_id(&target).expect("identity");
        let result = actor
            .handle()
            .versioned_text_create(
                input(),
                scratch.path().into(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(
            result,
            Err(RuntimeError::Domain(DomainError::TargetPathExists))
        ));
        assert_eq!(
            std::fs::read_to_string(&target).expect("bytes"),
            "external record"
        );
        assert_eq!(file_id::get_file_id(&target).expect("identity"), identity);
        assert_moment(&actor.handle(), false).await;
        actor.close().expect("close");
    }

    #[tokio::test]
    async fn published_authored_create_recovers_original_author_before_capture() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut actor = open(scratch.path());
        let handle = actor.handle();
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
        assert!(matches!(
            handle
                .versioned_text_create(
                    input(),
                    scratch.path().into(),
                    faults.clone(),
                    CancellationToken::new()
                )
                .await,
            Err(RuntimeError::ActorUnavailable)
        ));
        assert!(faults.fired());
        assert!(matches!(
            handle.run(|_, _| Ok(())).await,
            Err(RuntimeError::ActorUnavailable)
        ));
        actor.close().expect("close fenced actor");
        let target = scratch.path().join("tasks/record.md");
        let identity = file_id::get_file_id(&target).expect("identity");
        // A same-inode external edit remains on disk. Recovery journals the
        // original authored creation; subsequent capture owns the external edit.
        std::fs::write(&target, "external edit").expect("edit");
        let mut actor = open(scratch.path());
        actor
            .handle()
            .recover_authored_create(input().workspace_id, scratch.path().into())
            .await
            .expect("recover");
        assert_moment(&actor.handle(), true).await;
        assert_eq!(
            std::fs::read_to_string(&target).expect("bytes"),
            "external edit"
        );
        assert_eq!(file_id::get_file_id(&target).expect("identity"), identity);
        actor.close().expect("close");
    }

    #[tokio::test]
    async fn authored_create_recovery_preserves_a_foreign_replacement() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut actor = open(scratch.path());
        let result = actor
            .handle()
            .versioned_text_create(
                input(),
                scratch.path().into(),
                ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist),
                CancellationToken::new(),
            )
            .await;
        assert!(result.is_err());
        actor.close().expect("close");
        let target = scratch.path().join("tasks/record.md");
        std::fs::remove_file(&target).expect("external removal");
        std::fs::write(&target, "foreign replacement").expect("replacement");
        let identity = file_id::get_file_id(&target).expect("identity");
        let mut actor = open(scratch.path());
        actor
            .handle()
            .recover_authored_create(input().workspace_id, scratch.path().into())
            .await
            .expect("recover");
        assert_moment(&actor.handle(), false).await;
        assert_eq!(
            std::fs::read_to_string(&target).expect("bytes"),
            "foreign replacement"
        );
        assert_eq!(file_id::get_file_id(&target).expect("identity"), identity);
        actor.close().expect("close");
    }

    #[tokio::test]
    async fn committed_unacknowledged_create_keeps_one_moment_and_cleans_stage() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut actor = open(scratch.path());
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
        assert!(
            actor
                .handle()
                .versioned_text_create(
                    input(),
                    scratch.path().into(),
                    faults.clone(),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert!(faults.fired());
        actor.close().expect("close");
        let mut actor = open(scratch.path());
        actor
            .handle()
            .recover_authored_create(input().workspace_id, scratch.path().into())
            .await
            .expect("recover");
        assert_moment(&actor.handle(), true).await;
        let retry = actor
            .handle()
            .versioned_text_create(
                input(),
                scratch.path().into(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await;
        assert!(retry.expect("exact create retry").deduped);
        assert_moment(&actor.handle(), true).await;
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/record.md")).expect("bytes"),
            input().text
        );
        assert_eq!(
            std::fs::read_dir(scratch.path().join(".dohc/engine/authored-create"))
                .expect("stages")
                .count(),
            0
        );
        actor.close().expect("close");
    }
}
