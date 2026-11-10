use crate::rpc::{
    error::map_runtime,
    request::{now_ms, parse, validated_author},
};
use crate::{EngineService, lock};
use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    wire::WorkspaceHandle,
};
use dohc_engine_runtime::{DocKey, actor::HeldChangeAction};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    path: String,
    author: Option<Value>,
    #[serde(flatten)]
    action: HeldChangeAction,
}

impl EngineService {
    pub(super) async fn held_note_change(
        &self,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: Params = parse(params)?;
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() || open.projects_collections() {
            return Err(WireError::new(
                ErrorCode::Forbidden,
                "Only the owner on this computer can drop or restore a held change.",
            ));
        }
        let author_json = validated_author(params.author.as_ref())?;
        if !matches!(params.action, HeldChangeAction::Review) && author_json.is_none() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "A held change needs its caller's author.",
            ));
        }
        let capture = open.capture_apply_gate.clone().lock_owned().await;
        let serial = open.session_ops.clone().lock_owned().await;
        let sessions = self.sessions.clone();
        let events = self.events.clone();
        let now = now_ms()?;
        // A committed reset must notify editors even if its caller disconnects.
        tokio::spawn(async move {
            let (_capture, _serial) = (capture, serial);
            let version = open
                .actor
                .active_version_id(open.workspace_id.clone())
                .await
                .map_err(map_runtime)?;
            let object = open
                .actor
                .resolve_path_object(
                    open.workspace_id.clone(),
                    version.clone(),
                    params.path.clone(),
                )
                .await
                .map_err(map_runtime)?
                .ok_or_else(|| {
                    WireError::new(
                        ErrorCode::InvalidParams,
                        "The note moved or changed. Open it again.",
                    )
                })?;
            let key = DocKey::new(&open.workspace_id, version, object)
                .map_err(|error| map_runtime(error.into()))?;
            let changes = !matches!(params.action, HeldChangeAction::Review);
            let mut revoked = Vec::new();
            if changes {
                for (id, session) in lock(&sessions)
                    .iter_mut()
                    .filter(|(_, session)| session.key == key)
                {
                    if let Some(consent) = session.conversion_consent.take()
                        && let Some(replacement) = consent.revoke_with_replacement()
                    {
                        revoked.push((id.clone(), std::sync::Arc::new(replacement)));
                    }
                }
            }
            let result = open
                .actor
                .held_note_change(
                    key.clone(),
                    params.path,
                    open.root.clone(),
                    params.action,
                    author_json,
                    now,
                )
                .await;
            let result = match result {
                Ok(result) => result,
                Err(error) => {
                    let mut sessions = lock(&sessions);
                    for (id, consent) in revoked {
                        if let Some(session) = sessions.get_mut(&id).filter(|session| {
                            session.key == key && session.conversion_consent.is_none()
                        }) {
                            session.conversion_consent = Some(consent);
                        }
                    }
                    return Err(match error {
                        dohc_engine_runtime::RuntimeError::Collab(dohc_engine_collab::CollabError::OwnerOutboxFrozen) =>
                            WireError::new(ErrorCode::InvalidParams, "Drop is not available for shared notes yet. Keep the waiting edits or save a copy."),
                        error => map_runtime(error),
                    });
                }
            };
            if changes {
                let mut sessions = lock(&sessions);
                for (id, session) in sessions
                    .iter_mut()
                    .filter(|(_, session)| session.key == key)
                {
                    session.conversion_consent = None;
                    events.emit(
                        "ydoc.remoteUpdate",
                        serde_json::json!({"sessionId":id,"resyncRequired":true}),
                    );
                }
                open.actor.request_markdown_recovery();
                events.emit_refusals_changed(&open.workspace_id);
            }
            serde_json::to_value(result)
                .map_err(|_| WireError::new(ErrorCode::Internal, "response encode failed"))
        })
        .await
        .map_err(|_| WireError::new(ErrorCode::Internal, "held change task failed"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_protocol::transport::RequestContext;
    use dohc_engine_testkit::ScratchDir;
    use serde_json::json;

    #[tokio::test]
    async fn held_drop_and_undo_refuse_received_share_and_read_only_handles() {
        for received in [false, true] {
            let scratch = ScratchDir::new().unwrap();
            let service = EngineService::new();
            let params = json!({"rootDir":scratch.path(), "workspaceId":"held-permission",
                "captureMode":"none", "projectCollections":received});
            let opened = service
                .workspace_open(&RequestContext::unbounded(), params.clone())
                .await
                .unwrap();
            let owner: WorkspaceHandle =
                serde_json::from_value(opened["workspace"].clone()).unwrap();
            let handle = if received {
                owner.clone()
            } else {
                let mut read_only = params;
                read_only["skipStartupMaintenance"] = json!(true);
                let attached = service
                    .workspace_open(&RequestContext::unbounded(), read_only)
                    .await
                    .unwrap();
                serde_json::from_value(attached["workspace"].clone()).unwrap()
            };
            for action in ["review", "drop", "undo"] {
                let mut params = json!({"path":"note.md","action":action});
                if action != "review" {
                    params["token"] = json!("a".repeat(64));
                }
                assert_eq!(
                    service
                        .held_note_change(Some(handle.clone()), params)
                        .await
                        .unwrap_err()
                        .code,
                    ErrorCode::Forbidden
                );
            }
            if !received {
                service.workspace_close(Some(handle)).await.unwrap();
            }
            service.workspace_close(Some(owner)).await.unwrap();
        }
    }
}
