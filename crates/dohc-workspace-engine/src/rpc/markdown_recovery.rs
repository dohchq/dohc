use super::workspace::OpenWorkspace;
use super::ydoc::YdocSession;
use crate::{EngineEvents, lock};
use dohc_engine_collab::markdown_write_obligations::{Kind, Obligation};
use dohc_engine_collab::LeaseRegistry;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::{CancellationToken, NoFaults, RuntimeError};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};

pub(super) struct MarkdownRecovery {
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl MarkdownRecovery {
    pub(super) fn spawn(open: &Arc<OpenWorkspace>, handle: WorkspaceHandle,
        sessions: Arc<Mutex<HashMap<String, YdocSession>>>, leases: LeaseRegistry,
        writes: crate::capture_sink::SelfWriteSuppression, events: EngineEvents) -> Self {
        let cancel = CancellationToken::new();
        let wake = open.actor.markdown_recovery_wake();
        let task = tokio::spawn(run(Arc::downgrade(open), handle, sessions, leases, writes, events, cancel.clone()));
        wake.notify_one();
        Self { cancel, task: Some(task) }
    }
    pub(super) fn request_shutdown(&self) { self.cancel.cancel(); }
    pub(super) fn begin_shutdown(mut self) -> Option<tokio::task::JoinHandle<()>> {
        self.cancel.cancel();
        self.task.take()
    }
}
impl Drop for MarkdownRecovery {
    fn drop(&mut self) { self.cancel.cancel(); }
}

#[allow(clippy::too_many_arguments)]
async fn run(open: Weak<OpenWorkspace>, handle: WorkspaceHandle,
    sessions: Arc<Mutex<HashMap<String, YdocSession>>>, leases: LeaseRegistry,
    writes: crate::capture_sink::SelfWriteSuppression, events: EngineEvents, cancel: CancellationToken) {
    let Some(initial) = open.upgrade() else { return; };
    let wake = initial.actor.markdown_recovery_wake();
    drop(initial);
    let mut attempted = HashMap::<i64, String>::new();
    loop {
        tokio::select! { biased; () = cancel.cancelled() => return, () = wake.notified() => {} }
        let Some(open) = open.upgrade() else { return; };
        let _capture = tokio::select! { biased;
            () = cancel.cancelled() => return,
            guard = open.capture_apply_gate.clone().lock_owned() => guard,
        };
        let _sessions = tokio::select! { biased;
            () = cancel.cancelled() => return,
            guard = open.session_ops.clone().lock_owned() => guard,
        };
        let now = match super::request::now_ms() { Ok(now) => now, Err(_) => continue };
        let candidates = match open.actor.markdown_recovery_candidates(open.workspace_id.clone()).await {
            Ok(rows) => rows,
            Err(error) => { eprintln!("engine: Markdown recovery scan retained: {error}"); continue; }
        };
        let present: HashSet<_> = candidates.iter().map(|row| row.obligation.order).collect();
        attempted.retain(|order, _| present.contains(order));
        let mut blocked = HashSet::new();
        for candidate in candidates {
            if cancel.is_cancelled() { return; }
            let owed = candidate.obligation;
            let document = (owed.key.version_id.clone(), owed.key.object_id.clone());
            if blocked.contains(&document) { continue; }
            let active = lock(&sessions).iter().find(|(_, session)|
                session.workspace == handle && session.key == owed.key
                && session.lineage_claim_id.as_deref().unwrap_or("") == owed.lineage_claim_id)
                .map(|(id, session)| (id.clone(), session.path.clone(), session.content_kind,
                    session.lineage_claim_id.clone(), session.last_settled_sha.clone().or(session.open_head_sha.clone()),
                    session.restore_generation, session.conversion_consent.clone()));
            let consent = active.as_ref().and_then(|row| row.6.as_ref())
                .map(|grant| (Arc::as_ptr(grant) as usize, grant.is_consumed()));
            let fingerprint = format!("{}:{}:{consent:?}", candidate.fingerprint, open.actor.markdown_recovery_epoch());
            if attempted.get(&owed.order) == Some(&fingerprint) { blocked.insert(document); continue; }
            attempted.insert(owed.order, fingerprint);
            let root_guard = match crate::capture_sink::CapturedRoot::bind(&open.root) {
                Ok(guard) => Arc::new(guard),
                Err(_) => { blocked.insert(document); continue; }
            };
            let outcome = if matches!(owed.kind, Kind::CollectionAdoption | Kind::RelationCleanup) {
                open.actor.reconcile_collections_guarded(open.workspace_id.clone(), owed.key.version_id.clone(),
                    open.root.clone(), leases.clone(), Arc::new(writes.clone()), now, Arc::new(NoFaults),
                    cancel.clone(), root_guard).await.map(|result| {
                        crate::events::emit_automation_claimed(&events, &open.workspace_id, &result.automation_claims);
                        result.held_documents.is_empty() && !result.lease_held && !result.waits_for_pull
                    })
            } else if owed.kind == Kind::Session && active.is_some() {
                let (id, path, kind, lineage, head, generation, consent) = active.unwrap();
                match open.actor.ydoc_settle(open.root.clone(), owed.key.clone(), path, kind, lineage,
                    head, id.clone(), Arc::new(writes.clone()), now, Arc::new(NoFaults), cancel.clone(),
                    generation, consent).await {
                    Ok(dohc_engine_runtime::YdocSettleOutcome::Settled(settled)) => {
                        if let Some(session) = lock(&sessions).get_mut(&id) {
                            session.last_settled_sha = Some(settled.sha256.clone());
                        }
                        open.actor.complete_markdown_obligation(owed.clone(), now).await.map(|()| true)
                    }
                    Ok(dohc_engine_runtime::YdocSettleOutcome::RemoteUpdatesPending { record_facts }) => {
                        for facts in &record_facts { crate::events::emit_record_events(&events, &open.workspace_id, facts); }
                        notify_sessions(&sessions, &handle, &owed, &events, false);
                        Ok(false)
                    }
                    Err(error) => Err(error),
                }
            } else {
                open.actor.recover_markdown_write(owed.clone(), open.root.clone(), root_guard,
                    leases.clone(), Arc::new(writes.clone()), now, cancel.clone()).await
            };
            match outcome {
                Ok(true) => {
                    attempted.remove(&owed.order);
                    notify_sessions(&sessions, &handle, &owed, &events, false);
                    if let Err(error) = open.actor.materialize_replay_pending_for_fence(open.root.clone(),
                        open.workspace_id.clone(), Arc::new(writes.clone()), now).await {
                        eprintln!("engine: Markdown recovery materialization retained: {error}");
                        blocked.insert(document);
                    }
                }
                Ok(false) => {
                    if owed.kind == Kind::AuditedSettle { notify_sessions(&sessions, &handle, &owed, &events, true); }
                    blocked.insert(document);
                }
                Err(error) => {
                    if !matches!(error, RuntimeError::MarkdownWriteHeld { .. }) {
                        eprintln!("engine: Markdown recovery retained: {error}");
                    }
                    blocked.insert(document);
                }
            }
        }
    }
}

fn notify_sessions(sessions: &Mutex<HashMap<String, YdocSession>>, handle: &WorkspaceHandle,
    owed: &Obligation, events: &EngineEvents, settlement_wanted: bool) {
    for (id, session) in lock(sessions).iter() {
        if session.workspace == *handle && session.key == owed.key
            && session.lineage_claim_id.as_deref().unwrap_or("") == owed.lineage_claim_id {
            events.emit("ydoc.remoteUpdate", if settlement_wanted {
                serde_json::json!({"sessionId":id,"settlementWanted":true})
            } else {
                serde_json::json!({"sessionId":id,"resyncRequired":true})
            });
        }
    }
}

#[cfg(test)]
#[path = "markdown_recovery_tests.rs"]
mod tests;
