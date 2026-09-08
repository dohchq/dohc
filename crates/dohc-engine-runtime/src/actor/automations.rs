use super::ActorHandle;
use crate::error::RuntimeError;
use dohc_engine_domain::{
    AutomationClaim, AutomationClaimAttempt, AutomationFailure, AutomationSettle,
};
use dohc_engine_storage::FaultInjector;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

impl ActorHandle {
    pub async fn automation_subscribe(
        &self,
        workspace_id: String,
        automation_id: String,
        prefix: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                dohc_engine_domain::subscribe_automation(
                    store,
                    &workspace_id,
                    &automation_id,
                    &prefix,
                    now_ms,
                    faults.as_ref(),
                )
                .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn automation_unsubscribe(
        &self,
        workspace_id: String,
        automation_id: String,
        prefix: String,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                dohc_engine_domain::unsubscribe_automation(
                    store,
                    &workspace_id,
                    &automation_id,
                    &prefix,
                    faults.as_ref(),
                )
                .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn automation_claim_next(
        &self,
        workspace_id: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<Option<AutomationClaim>, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                dohc_engine_domain::claim_next_pending_automation(
                    store,
                    &workspace_id,
                    now_ms,
                    faults.as_ref(),
                )
                .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn automation_settle(
        &self,
        workspace_id: String,
        claim_id: String,
        settle: AutomationSettle,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<AutomationClaim, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                dohc_engine_domain::settle_automation_claim(
                    store,
                    &workspace_id,
                    &claim_id,
                    &settle,
                    now_ms,
                    faults.as_ref(),
                )
                .map_err(RuntimeError::from)
            }
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn automation_reclaim_running(
        &self,
        workspace_id: String,
        attempts: Option<Vec<AutomationClaimAttempt>>,
        max_attempts: i64,
        stale_before_ms: i64,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<Vec<AutomationClaim>, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                dohc_engine_domain::reclaim_running_automations(
                    store,
                    &workspace_id,
                    attempts.as_deref(),
                    max_attempts,
                    stale_before_ms,
                    now_ms,
                    faults.as_ref(),
                )
                .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn automation_running_attempts(
        &self,
        workspace_id: String,
    ) -> Result<Vec<AutomationClaimAttempt>, RuntimeError> {
        self.run(move |store, _cache| {
            dohc_engine_domain::list_running_automation_attempts(store, &workspace_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn automation_failures(
        &self,
        workspace_id: String,
    ) -> Result<Vec<AutomationFailure>, RuntimeError> {
        self.run(move |store, _cache| {
            dohc_engine_domain::list_automation_failures(store, &workspace_id)
                .map_err(RuntimeError::from)
        })
        .await
    }
}
