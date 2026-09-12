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
    pub owner_delivery_admission: crate::live_application_ingress::SettlementAdmission,
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
        Self::new().configure_ordinary_live_host(config)
    }

    pub(super) fn configure_ordinary_live_host(
        self,
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
        let service = Arc::new(self);
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
        let owner_delivery_admission = ingress.owner_admission().map_err(|_| {
            WireError::new(
                ErrorCode::InvalidParams,
                "invalid ordinary owner delivery budget",
            )
        })?;
        let owner = ConnectionOwner::authenticated();
        let _ = service.ordinary_live_host.set(OrdinaryHost {
            service: Arc::downgrade(&service),
            owner_delivery_admission,
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

#[cfg(test)]
mod tests {
    use super::*;

    // Owner admission charges fourteen maximum updates, bounded wire scratch,
    // and this fixture's configured working reserve.
    const OWNER_RESERVATION_BYTES: usize = 14 * dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES
        + 3 * 643_576
        + 2 * 262_144
        + 1_000_000;

    fn owner_config(aggregate_bytes: usize) -> OrdinaryLiveHostConfig {
        serde_json::from_value(json!({
            "ingress": {"aggregateBytes": aggregate_bytes, "applicationWorkingReserveBytes": 1_000_000,
                "maxUploads": 2, "uploadDeadlineMs": 30_000},
            "maxRegistrations": 2, "maxAdoptionBytes": 1_000_000, "maxAdoptionEvents": 100,
            "maxApplicationsPerSettlement": 8,
            "ownerOutbox": {"maxPendingBytes": 1_000_000, "maxPendingAgeMs": 100_000}
        }))
        .unwrap()
    }

    #[test]
    fn owner_startup_refuses_budget_that_only_fits_base_ingress() {
        let config = owner_config(OWNER_RESERVATION_BYTES - 1);
        let base_ingress = config.ingress.validate().unwrap();
        assert!(base_ingress.minimum_aggregate_bytes().unwrap() <= base_ingress.aggregate_bytes);
        assert!(LiveApplicationIngress::new(Arc::new(EngineService::new()), base_ingress).is_ok());

        let Err(error) = EngineService::ordinary_live_host(config) else {
            panic!("owner startup accepted a budget that can never admit owner delivery");
        };
        assert_eq!(error.code, ErrorCode::InvalidParams);
        assert_eq!(error.message, "invalid ordinary owner delivery budget");
    }

    #[test]
    fn owner_startup_accepts_budget_for_one_owner_reservation() {
        let (service, _connection, _ingress) =
            EngineService::ordinary_live_host(owner_config(OWNER_RESERVATION_BYTES)).unwrap();
        let reservation = service.reserve_owner_delivery().unwrap();
        assert!(service.reserve_owner_delivery().is_err());
        drop(reservation);
        assert!(service.reserve_owner_delivery().is_ok());
    }
}
