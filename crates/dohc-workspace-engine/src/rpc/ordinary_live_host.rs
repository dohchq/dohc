use super::configured_live_host::IngressConfig;
use crate::live_application_ingress::LiveApplicationIngress;
use crate::{EngineService, LiveApplicationHostConfig};
use dohc_engine_collab::live_update_application::ApplicationHostCoordinate;
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::transport::{ConnectionOwner, RequestContext};
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io::Read, path::Path, sync::Arc};

/// Native main-process configuration. It enables no renderer RPC proxy.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrdinaryLiveHostConfig {
    ingress: IngressConfig,
    max_registrations: usize,
    max_adoption_bytes: usize,
    max_adoption_events: usize,
    max_applications_per_settlement: usize,
    owner_outbox: dohc_engine_collab::OwnerOutboxLimits,
    restore: Option<crate::live_application_ingress::RestoreConfig>,
    sync: Option<super::live_application::sync::SyncConfig>,
}

impl OrdinaryLiveHostConfig {
    pub fn read(path: &Path) -> Result<Self, WireError> {
        let invalid = || {
            WireError::new(
                ErrorCode::InvalidParams,
                "invalid ordinary live host configuration",
            )
        };
        if !path.is_absolute() {
            return Err(invalid());
        }
        let file = std::fs::File::open(path).map_err(|_| invalid())?;
        let mut bytes = Vec::new();
        file.take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid())?;
        if bytes.len() > 1_048_576 {
            return Err(invalid());
        }
        serde_json::from_slice(&bytes).map_err(|_| invalid())
    }
}

pub(crate) struct OrdinaryHost {
    pub service: std::sync::Weak<EngineService>,
    pub owner_delivery_admission: Option<crate::live_application_ingress::SettlementAdmission>,
    pub sync: Option<(
        dohc_engine_collab::live_update_application::AppliedSyncPolicy,
        crate::live_application_ingress::SettlementAdmission,
    )>,
    pub max_registrations: usize,
    pub max_adoption_bytes: usize,
    pub max_adoption_events: usize,
    pub owner_outbox: dohc_engine_collab::OwnerOutboxLimits,
    pub connection: dohc_engine_protocol::transport::ConnectionHandle,
    pub settlement: (usize, crate::live_application_ingress::SettlementAdmission),
    pub restore: Option<crate::live_application_ingress::RestoreConfig>,
}

impl EngineService {
    pub fn ordinary_live_host(
        config: OrdinaryLiveHostConfig,
    ) -> Result<(Arc<Self>, ConnectionOwner, LiveApplicationIngress), WireError> {
        config
            .owner_outbox
            .validate()
            .map_err(super::error::map_owner_outbox)?;
        if config.owner_outbox.max_pending_bytes > 9_007_199_254_740_991
            || config.owner_outbox.max_pending_age_ms > 9_007_199_254_740_991
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid ordinary owner outbox bounds",
            ));
        }
        if config.max_registrations == 0
            || config.max_adoption_events == 0
            || config.max_adoption_bytes == 0
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid ordinary live host bounds",
            ));
        }
        let service = Arc::new(Self::new());
        let ingress = LiveApplicationIngress::new(service.clone(), config.ingress.validate()?)?;
        if let Some(config) = &config.restore {
            ingress.validate_restore_budget(config)?;
        }
        ingress.validate_adoption_budget(config.max_adoption_bytes, config.max_adoption_events)?;
        let sync = config
            .sync
            .map(|c| {
                ingress
                    .sync_admission(c)
                    .map(|admission| (c.policy, admission))
            })
            .transpose()?;
        let settlement = (
            config.max_applications_per_settlement,
            ingress.settlement_admission(config.max_applications_per_settlement)?,
        );
        let owner = ConnectionOwner::authenticated();
        let _ = service.ordinary_live_host.set(OrdinaryHost {
            service: Arc::downgrade(&service),
            owner_delivery_admission: ingress.owner_admission().ok(),
            max_registrations: config.max_registrations,
            max_adoption_bytes: config.max_adoption_bytes,
            max_adoption_events: config.max_adoption_events,
            connection: owner.handle(),
            settlement,
            sync,
            owner_outbox: config.owner_outbox,
            restore: config.restore,
        });
        Ok((service, owner, ingress))
    }

    pub(super) async fn ordinary_live_provision(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            relay_namespace: String,
            host: ApplicationHostCoordinate,
        }
        let config = self.ordinary_live_host.get().ok_or_else(|| {
            WireError::new(ErrorCode::Forbidden, "ordinary live host is not configured")
        })?;
        let connection = ctx
            .connection
            .as_ref()
            .filter(|c| config.connection.same_connection(c) && c.is_current())
            .ok_or_else(|| {
                WireError::new(
                    ErrorCode::SessionExpired,
                    "ordinary live host connection retired",
                )
            })?;
        let params: Params = serde_json::from_value(params).map_err(|_| {
            WireError::new(
                ErrorCode::InvalidParams,
                "invalid ordinary live provisioning",
            )
        })?;
        let workspace = workspace
            .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "workspace required"))?;
        self.provision_live_application(
            connection.clone(),
            LiveApplicationHostConfig {
                workspace,
                namespace: params.relay_namespace,
                coordinate: params.host,
                max_registrations: config.max_registrations,
            },
        )
        .await?;
        Ok(json!({"provisioned": true}))
    }
}
