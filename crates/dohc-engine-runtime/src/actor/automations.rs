use super::ActorHandle;
use crate::error::RuntimeError;
use dohc_engine_domain::{
    AutomationClaim, AutomationClaimAttempt, AutomationFailure, AutomationFieldFacts,
    AutomationGroupSubscription, AutomationPress, AutomationPressed, AutomationRetry,
    AutomationScheduleClaim, AutomationScheduleClaimed, AutomationScheduleMark, AutomationSettle,
    AutomationSubscription,
};
use dohc_engine_storage::FaultInjector;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

impl ActorHandle {
    pub async fn automation_subscribe(
        &self,
        workspace_id: String,
        subscription: AutomationSubscription,
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
                    &subscription,
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

    pub async fn automation_subscribe_group(
        &self,
        workspace_id: String,
        subscription: AutomationGroupSubscription,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                dohc_engine_domain::subscribe_automation_group(
                    store,
                    &workspace_id,
                    &subscription,
                    now_ms,
                    faults.as_ref(),
                )
                .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn automation_unsubscribe_group(
        &self,
        workspace_id: String,
        automation_id: String,
        channel_id: String,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                dohc_engine_domain::unsubscribe_automation_group(
                    store,
                    &workspace_id,
                    &automation_id,
                    &channel_id,
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
        automation_id_prefix: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<Option<(AutomationClaim, AutomationFieldFacts)>, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                dohc_engine_domain::claim_next_pending_automation(
                    store,
                    &workspace_id,
                    &automation_id_prefix,
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

    pub async fn automation_press(
        &self,
        workspace_id: String,
        press: AutomationPress,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<AutomationPressed, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                dohc_engine_domain::press_automation(
                    store,
                    &workspace_id,
                    &press,
                    now_ms,
                    faults.as_ref(),
                )
                .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn automation_claim_schedule(
        &self,
        workspace_id: String,
        schedule: AutomationScheduleClaim,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<AutomationScheduleClaimed, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                dohc_engine_domain::claim_automation_schedule(
                    store,
                    &workspace_id,
                    &schedule,
                    now_ms,
                    faults.as_ref(),
                )
                .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn automation_schedule_marks(
        &self,
        workspace_id: String,
    ) -> Result<Vec<AutomationScheduleMark>, RuntimeError> {
        self.run(move |store, _cache| {
            dohc_engine_domain::list_automation_schedule_marks(store, &workspace_id)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn automation_retry(
        &self,
        workspace_id: String,
        claim_id: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<AutomationRetry, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                dohc_engine_domain::retry_automation_claim(
                    store,
                    &workspace_id,
                    &claim_id,
                    now_ms,
                    faults.as_ref(),
                )
                .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn automation_release(
        &self,
        workspace_id: String,
        claim_id: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<AutomationClaim, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                dohc_engine_domain::release_automation_claim(
                    store,
                    &workspace_id,
                    &claim_id,
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

    pub async fn automation_claims(
        &self,
        workspace_id: String,
        automation_id: String,
    ) -> Result<Vec<AutomationClaim>, RuntimeError> {
        self.run(move |store, _cache| {
            dohc_engine_domain::list_automation_claims(store, &workspace_id, &automation_id)
                .map_err(RuntimeError::from)
        })
        .await
    }
}
