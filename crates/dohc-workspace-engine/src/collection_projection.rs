use crate::{COLLECTIONS_PROJECTED_EVENT, EngineEvents};
use dohc_engine_domain::CollectionProjection;
use dohc_engine_runtime::{ActorHandle, CancellationToken};
use std::sync::Arc;

/// One coalescing worker per received-share binding, drained before actor close.
pub(crate) struct CollectionProjectionWorker {
    cancel: CancellationToken,
    wake: Arc<tokio::sync::Notify>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl CollectionProjectionWorker {
    pub(crate) fn spawn(actor: ActorHandle, workspace_id: String, events: EngineEvents) -> Self {
        let cancel = CancellationToken::new();
        let wake = Arc::new(tokio::sync::Notify::new());
        let task = tokio::spawn({
            let cancel = cancel.clone();
            let wake = Arc::clone(&wake);
            async move {
                let mut previous = CollectionProjection::default();
                loop {
                    tokio::select! {
                        biased;
                        () = cancel.cancelled() => break,
                        () = wake.notified() => {}
                    }
                    match actor
                        .project_collections(workspace_id.clone(), previous)
                        .await
                    {
                        Ok((next, paths)) => {
                            previous = next;
                            if !paths.is_empty() {
                                let count = paths.len();
                                let paths = (count <= 32).then_some(paths);
                                events.emit(COLLECTIONS_PROJECTED_EVENT,
                                    serde_json::json!({ "workspaceId": workspace_id, "projectedCount": count, "paths": paths }));
                            }
                        }
                        Err(error) => {
                            previous = CollectionProjection::default();
                            eprintln!("engine: received Collection projection failed: {error}");
                        }
                    }
                }
            }
        });
        wake.notify_one();
        Self {
            cancel,
            wake,
            task: Some(task),
        }
    }

    pub(crate) fn request(&self) {
        self.wake.notify_one();
    }
    pub(crate) fn request_shutdown(&self) {
        self.cancel.cancel();
    }
    pub(crate) fn begin_shutdown(mut self) -> Option<tokio::task::JoinHandle<()>> {
        self.cancel.cancel();
        self.task.take()
    }
}

impl Drop for CollectionProjectionWorker {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
