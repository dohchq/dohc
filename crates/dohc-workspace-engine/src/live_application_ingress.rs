//! Private admitted-update assembly. No deployment values are selected here.

use crate::EngineService;
use crate::rpc::live_application::{
    AdmittedApplicationInput, LiveApplicationInput, LiveApplicationOperation, Registration,
};
use dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES;
use dohc_engine_collab::live_update_application::{
    AdmittedLiveUpdate, AdmittedLiveUpdateMetadata, LiveApplicationBootstrap,
    LiveUpdateStructRange, RelayAcceptedLiveUpdate, parse_admitted_metadata,
};
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::limits::MAX_WIRE_INTEGER;
use dohc_engine_protocol::transport::ConnectionHandle;
use dohc_engine_protocol::wire::{BlobStart, Request};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::mem::size_of;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const RANGE_BYTES: usize = 16;
// Worst-case canonical request with 100 selectors and six-byte JSON escapes.
const MAX_HEADER_BYTES: usize = 643_576;
const MAX_CHUNK_BYTES: usize = 256 * 1024;
mod adoption;
mod restore;
pub(crate) use restore::RestoreConfig;

#[derive(Clone)]
pub struct LiveApplicationIngressConfig {
    pub aggregate_bytes: usize,
    /// Positive admission allowance for accepted history reconstruction, not a heap limiter.
    pub application_working_reserve_bytes: usize,
    pub max_uploads: usize,
    pub upload_deadline: Duration,
}

impl LiveApplicationIngressConfig {
    fn reservation_bytes(&self, update_bytes: usize, ranges: usize) -> Option<usize> {
        // The current raw readback Vec grows geometrically. Charge twice its
        // element length in addition to the final input Vec and update copy.
        update_bytes
            .checked_mul(2)?
            .checked_add(
                ranges
                    .checked_mul(size_of::<LiveUpdateStructRange>())?
                    .checked_mul(3)?,
            )?
            .checked_add(MAX_HEADER_BYTES.checked_mul(3)?)?
            .checked_add(MAX_CHUNK_BYTES.checked_mul(2)?)?
            .checked_add(self.application_working_reserve_bytes)
    }

    pub fn minimum_aggregate_bytes(&self) -> Option<usize> {
        self.reservation_bytes(MAX_YDOC_UPDATE_BYTES, (MAX_YDOC_UPDATE_BYTES - 2) / 5)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyParams {
    accepted: RelayAcceptedLiveUpdate,
    registration_id: u64,
    range_count: usize,
    range_stream_id: u64,
    range_digest: String,
    update_stream_id: u64,
    update_byte_length: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BootstrapParams {
    registration_id: u64,
    baseline_stream_id: u64,
    baseline: LiveApplicationBootstrap,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdoptionParams {
    registration_id: u64,
    session_id: String,
    stream_id: u64,
    byte_length: usize,
    digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncParams {
    registration_id: u64,
    stream_id: u64,
    byte_length: usize,
    digest: String,
}

enum Metadata {
    Owner(crate::rpc::owner_delivery::OwnerUpload),
    Sync(dohc_engine_collab::live_update_application::AppliedSyncPolicy),
    Apply(RelayAcceptedLiveUpdate),
    Bootstrap(LiveApplicationBootstrap),
    Adoption {
        registration_id: u64,
        session_id: String,
        max_bytes: usize,
        max_events: usize,
        outbox_limits: dohc_engine_collab::OwnerOutboxLimits,
    },
}

struct Stream {
    id: u64,
    expected: usize,
    received: usize,
    digest: String,
    hash: Sha256,
    started: bool,
    finished: bool,
}

impl Stream {
    fn new(id: u64, expected: usize, digest: String) -> Result<Self, WireError> {
        if id > MAX_WIRE_INTEGER
            || digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid("invalid-live-stream-metadata"));
        }
        Ok(Self {
            id,
            expected,
            received: 0,
            digest,
            hash: Sha256::new(),
            started: false,
            finished: false,
        })
    }

    fn start(&mut self, start: &BlobStart) -> Result<(), WireError> {
        if self.started
            || start.total_bytes != Some(self.expected as u64)
            || start.sha256.as_deref() != Some(&self.digest)
        {
            return Err(invalid("live-stream-start-mismatch"));
        }
        self.started = true;
        Ok(())
    }

    fn chunk(&mut self, bytes: &[u8], fin: bool) -> Result<(), WireError> {
        if !self.started
            || self.finished
            || bytes.len() > MAX_CHUNK_BYTES
            || (bytes.is_empty() && !fin)
        {
            return Err(invalid("invalid-live-stream-chunk"));
        }
        self.received = self
            .received
            .checked_add(bytes.len())
            .ok_or_else(|| invalid("live-stream-length"))?;
        if self.received > self.expected
            || (fin && self.received != self.expected)
            || (!fin && self.received == self.expected)
        {
            return Err(invalid("live-stream-length"));
        }
        self.hash.update(bytes);
        if fin {
            let digest = dohc_engine_storage::hex(&self.hash.clone().finalize());
            if digest != self.digest {
                return Err(invalid("live-stream-digest"));
            }
            self.finished = true;
        }
        Ok(())
    }
}

struct Upload {
    request: Request,
    metadata: Metadata,
    registration: Option<Arc<Registration>>,
    update: Stream,
    ranges: Option<Stream>,
    bytes: Vec<u8>,
    first_seen: Vec<LiveUpdateStructRange>,
    range_tail: Vec<u8>,
    deadline: Instant,
    permit: Arc<Reservation>,
}

struct Reservation {
    _bytes: OwnedSemaphorePermit,
    _upload: OwnedSemaphorePermit,
}

#[derive(Clone)]
pub(crate) struct SettlementAdmission {
    budget: Arc<Semaphore>,
    slots: Arc<Semaphore>,
    bytes: u32,
}

impl SettlementAdmission {
    pub(crate) fn reserve(&self) -> Result<Arc<dyn Send + Sync>, WireError> {
        let overloaded = || WireError::new(ErrorCode::Overloaded, "live-settlement-capacity");
        let upload = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| overloaded())?;
        let bytes = self
            .budget
            .clone()
            .try_acquire_many_owned(self.bytes)
            .map_err(|_| overloaded())?;
        Ok(Arc::new(Reservation {
            _bytes: bytes,
            _upload: upload,
        }))
    }
}

/// Configured by the owning daemon host. Ordinary daemon startup leaves it off.
pub struct LiveApplicationIngress {
    service: Arc<EngineService>,
    config: LiveApplicationIngressConfig,
    budget: Arc<Semaphore>,
    upload_slots: Arc<Semaphore>,
    uploads: HashMap<u64, Upload>,
    restores: HashMap<u64, restore::Upload>,
    last_stream_id: Option<u64>,
}

impl LiveApplicationIngress {
    pub(crate) fn owner_admission(&self) -> Result<SettlementAdmission, WireError> {
        // Two input buffers plus decoded vector, checkpoint and output scratch.
        // The configured working reserve remains charged while the actor hydrates Yrs.
        let bytes = self
            .config
            .reservation_bytes(MAX_YDOC_UPDATE_BYTES * 2, 0)
            .and_then(|n| n.checked_add(MAX_YDOC_UPDATE_BYTES * 10))
            .filter(|n| *n <= self.config.aggregate_bytes)
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(overloaded)?;
        Ok(SettlementAdmission {
            budget: self.budget.clone(),
            slots: self.upload_slots.clone(),
            bytes,
        })
    }
    pub(crate) fn sync_admission(
        &self,
        config: crate::rpc::live_application::sync::SyncConfig,
    ) -> Result<SettlementAdmission, WireError> {
        let bytes = config
            .reservation_bytes()
            .filter(|n| *n <= self.config.aggregate_bytes)
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(|| invalid("invalid applied sync budget"))?;
        Ok(SettlementAdmission {
            budget: self.budget.clone(),
            slots: self.upload_slots.clone(),
            bytes,
        })
    }

    pub(crate) fn validate_adoption_budget(
        &self,
        bytes: usize,
        events: usize,
    ) -> Result<(), WireError> {
        if events == 0
            || self.adoption_reservation(bytes).is_none_or(|charge| {
                charge > self.config.aggregate_bytes || charge > u32::MAX as usize
            })
        {
            return Err(invalid("invalid-owner-adoption-budget"));
        }
        Ok(())
    }

    fn adoption_reservation(&self, bytes: usize) -> Option<usize> {
        // Charge raw upload, typed evidence, JSON parsing, and actor scratch together.
        bytes
            .checked_mul(32)?
            .checked_add(self.config.application_working_reserve_bytes)?
            .checked_add(MAX_CHUNK_BYTES * 2)
    }
    pub(crate) fn settlement_admission(
        &self,
        max_applications: usize,
    ) -> Result<SettlementAdmission, WireError> {
        // Receipt strings, their serialized audit identities, and cold Y.Doc projection
        // stay charged to the same admission budget as incoming applications.
        let bytes = max_applications
            .checked_mul(8192)
            .and_then(|bytes| bytes.checked_add(self.config.application_working_reserve_bytes))
            .and_then(|bytes| bytes.checked_add(MAX_HEADER_BYTES * 3))
            .filter(|bytes| {
                max_applications > 0
                    && self.config.application_working_reserve_bytes > 0
                    && *bytes <= self.config.aggregate_bytes
            })
            .and_then(|bytes| u32::try_from(bytes).ok())
            .ok_or_else(|| invalid("invalid-live-settlement-budget"))?;
        Ok(SettlementAdmission {
            budget: self.budget.clone(),
            slots: self.upload_slots.clone(),
            bytes,
        })
    }

    pub fn new(
        service: Arc<EngineService>,
        config: LiveApplicationIngressConfig,
    ) -> Result<Self, WireError> {
        if config.application_working_reserve_bytes == 0 {
            return Err(invalid("applicationWorkingReserveBytes must be positive"));
        }
        if config.max_uploads == 0
            || config.upload_deadline.is_zero()
            || config.aggregate_bytes > Semaphore::MAX_PERMITS
            || config.max_uploads > Semaphore::MAX_PERMITS
            || config.minimum_aggregate_bytes().is_none_or(|minimum| {
                config.aggregate_bytes < minimum || minimum > u32::MAX as usize
            })
        {
            return Err(invalid("invalid-live-ingress-budget"));
        }
        Ok(Self {
            service,
            budget: Arc::new(Semaphore::new(config.aggregate_bytes)),
            upload_slots: Arc::new(Semaphore::new(config.max_uploads)),
            config,
            uploads: HashMap::new(),
            restores: HashMap::new(),
            last_stream_id: None,
        })
    }

    pub fn begin(
        &mut self,
        mut request: Request,
        connection: &ConnectionHandle,
    ) -> Result<(), WireError> {
        if restore::is_method(&request.method) {
            return restore::begin(self, request, connection);
        }
        if !matches!(
            request.method.as_str(),
            "liveApplication.apply"
                | "ydoc.ownerDelivery.applyAcceptedFrame"
                | "ydoc.ownerDelivery.applyInitialSync"
                | "ydoc.ownerDelivery.appendDraft"
                | "liveApplication.bootstrap"
                | "liveApplication.adoptOwner"
                | "liveApplication.syncOpen"
        ) || request.idempotency_key.is_some()
        {
            return Err(invalid("invalid-live-application-request"));
        }
        if self.uploads.contains_key(&request.id) || self.restores.contains_key(&request.id) {
            return Err(invalid("duplicate-live-request"));
        }
        let upload_slot = self
            .upload_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| overloaded())?;
        let (metadata, registration_id, update, ranges, range_count) = if request
            .method
            .starts_with("ydoc.ownerDelivery.")
        {
            self.service
                .owner_delivery_connection(connection, request.workspace.as_ref())?;
            let params = crate::rpc::owner_delivery::OwnerUpload::parse(
                &request.method,
                std::mem::take(&mut request.params),
            )?;
            let (stream_id, byte_length, digest) = params.stream();
            let stream = Stream::new(stream_id, byte_length, digest)?;
            (Metadata::Owner(params), 0, stream, None, 0)
        } else if request.method == "liveApplication.adoptOwner" {
            let config = self
                .service
                .ordinary_live_host
                .get()
                .ok_or_else(|| invalid("owner-adoption-not-configured"))?;
            if !config.connection.same_connection(connection) || !connection.is_current() {
                return Err(invalid("owner-adoption-connection-retired"));
            }
            let params: AdoptionParams =
                serde_json::from_value(std::mem::take(&mut request.params))
                    .map_err(|_| invalid("invalid-owner-adoption-upload"))?;
            if params.byte_length == 0
                || params.byte_length > config.max_adoption_bytes
                || params.session_id.is_empty()
                || params.session_id.len() > 256
            {
                return Err(invalid("invalid-owner-adoption-bounds"));
            }
            let stream = Stream::new(params.stream_id, params.byte_length, params.digest)?;
            (
                Metadata::Adoption {
                    registration_id: params.registration_id,
                    session_id: params.session_id,
                    max_bytes: config.max_adoption_bytes,
                    max_events: config.max_adoption_events,
                    outbox_limits: config.owner_outbox.clone(),
                },
                params.registration_id,
                stream,
                None,
                0,
            )
        } else if request.method == "liveApplication.syncOpen" {
            let (policy, _admission) = self.service.sync_admission(connection)?;
            let params: SyncParams = serde_json::from_value(std::mem::take(&mut request.params))
                .map_err(|_| invalid("invalid sync vector upload"))?;
            if params.byte_length == 0 || params.byte_length > policy.max_client_vector_bytes {
                return Err(invalid("sync vector limit"));
            }
            (
                Metadata::Sync(policy),
                params.registration_id,
                Stream::new(params.stream_id, params.byte_length, params.digest)?,
                None,
                0,
            )
        } else if request.method == "liveApplication.bootstrap" {
            let params: BootstrapParams =
                serde_json::from_value(std::mem::take(&mut request.params))
                    .map_err(|_| invalid("invalid-live-bootstrap-header"))?;
            params
                .baseline
                .validate()
                .map_err(|_| invalid("invalid-live-bootstrap-header"))?;
            let update = Stream::new(
                params.baseline_stream_id,
                params.baseline.baseline_byte_length as usize,
                params.baseline.baseline_digest.clone(),
            )?;
            (
                Metadata::Bootstrap(params.baseline),
                params.registration_id,
                update,
                None,
                0,
            )
        } else {
            let params: ApplyParams = serde_json::from_value(std::mem::take(&mut request.params))
                .map_err(|_| invalid("invalid-live-application-header"))?;
            let canonical = parse_admitted_metadata(serde_json::json!({
                "accepted": params.accepted, "firstSeen": [],
            }))
            .map_err(|_| invalid("invalid-live-application-header"))?;
            if canonical.accepted != params.accepted {
                return Err(invalid("noncanonical-live-application-header"));
            }
            if !(2..=MAX_YDOC_UPDATE_BYTES).contains(&params.update_byte_length)
                || params.range_count > (params.update_byte_length - 2) / 5
                || params.update_stream_id == params.range_stream_id
            {
                return Err(invalid("invalid-live-application-bounds"));
            }
            let update = Stream::new(
                params.update_stream_id,
                params.update_byte_length,
                params.accepted.receipt.update_digest.clone(),
            )?;
            let ranges = Stream::new(
                params.range_stream_id,
                params.range_count * RANGE_BYTES,
                params.range_digest,
            )?;
            (
                Metadata::Apply(params.accepted),
                params.registration_id,
                update,
                Some(ranges),
                params.range_count,
            )
        };
        if self.last_stream_id.is_some_and(|last| {
            update.id <= last || ranges.as_ref().is_some_and(|ranges| ranges.id <= last)
        }) {
            return Err(invalid("invalid-live-application-bounds"));
        }
        let registration = if matches!(&metadata, Metadata::Owner(_)) {
            None
        } else {
            Some(self.service.live_application_registration(
                connection,
                request.workspace.as_ref(),
                registration_id,
            )?)
        };
        let reserved = if matches!(&metadata, Metadata::Owner(_)) {
            Some(self.owner_admission()?.bytes as usize)
        } else if let Metadata::Sync(_) = &metadata {
            Some(self.service.sync_admission(connection)?.1.bytes as usize)
        } else if let Metadata::Adoption { max_bytes, .. } = &metadata {
            // First adoption can seed a native head larger than the relay baseline.
            self.adoption_reservation(*max_bytes)
        } else {
            self.config.reservation_bytes(update.expected, range_count)
        }
        .and_then(|bytes| u32::try_from(bytes).ok())
        .ok_or_else(overloaded)?;
        let permit = Arc::new(Reservation {
            _upload: upload_slot,
            _bytes: self
                .budget
                .clone()
                .try_acquire_many_owned(reserved)
                .map_err(|_| overloaded())?,
        });
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(update.expected)
            .map_err(|_| overloaded())?;
        let mut first_seen = Vec::new();
        first_seen
            .try_reserve_exact(range_count)
            .map_err(|_| overloaded())?;
        let duration = request
            .deadline_ms
            .map(|ms| Duration::from_millis(u64::from(ms)))
            .unwrap_or(self.config.upload_deadline)
            .min(self.config.upload_deadline);
        let deadline = Instant::now()
            .checked_add(duration)
            .ok_or_else(|| invalid("invalid-live-upload-deadline"))?;
        self.last_stream_id = Some(
            ranges
                .as_ref()
                .map_or(update.id, |ranges| update.id.max(ranges.id)),
        );
        self.uploads.insert(
            request.id,
            Upload {
                request,
                metadata,
                registration,
                update,
                ranges,
                bytes,
                first_seen,
                range_tail: Vec::with_capacity(RANGE_BYTES),
                deadline,
                permit,
            },
        );
        Ok(())
    }

    pub fn start(&mut self, start: BlobStart) -> Result<(), WireError> {
        if let Some(upload) = self.restores.get_mut(&start.request_id) {
            return upload.start(&start);
        }
        let upload = self
            .uploads
            .get_mut(&start.request_id)
            .ok_or_else(|| invalid("unknown-live-request"))?;
        if Instant::now() >= upload.deadline {
            return Err(invalid("live-upload-expired"));
        }
        if start.stream_id == upload.update.id {
            upload.update.start(&start)
        } else if let Some(ranges) = &mut upload.ranges {
            if start.stream_id != ranges.id {
                return Err(invalid("unknown-live-stream"));
            }
            ranges.start(&start)
        } else {
            Err(invalid("unknown-live-stream"))
        }
    }

    pub fn chunk(
        &mut self,
        stream_id: u64,
        fin: bool,
        bytes: &[u8],
    ) -> Result<Option<(Request, LiveApplicationInput)>, WireError> {
        if self
            .restores
            .values()
            .any(|upload| upload.stream_id() == stream_id)
        {
            return restore::chunk(self, stream_id, fin, bytes);
        }
        let id = self
            .uploads
            .iter()
            .find(|(_, upload)| {
                upload.update.id == stream_id
                    || upload
                        .ranges
                        .as_ref()
                        .is_some_and(|ranges| ranges.id == stream_id)
            })
            .map(|(id, _)| *id)
            .ok_or_else(|| invalid("unknown-live-stream"))?;
        let upload = self.uploads.get_mut(&id).expect("located upload");
        if Instant::now() >= upload.deadline {
            return Err(invalid("live-upload-expired"));
        }
        if stream_id == upload.update.id {
            upload.update.chunk(bytes, fin)?;
            upload.bytes.extend_from_slice(bytes);
        } else {
            upload
                .ranges
                .as_mut()
                .ok_or_else(|| invalid("unknown-live-stream"))?
                .chunk(bytes, fin)?;
            for byte in bytes {
                upload.range_tail.push(*byte);
                if upload.range_tail.len() == RANGE_BYTES {
                    let raw = &upload.range_tail;
                    let client = u64::from_le_bytes(raw[0..8].try_into().expect("eight bytes"));
                    let start = u32::from_le_bytes(raw[8..12].try_into().expect("four bytes"));
                    let end = u32::from_le_bytes(raw[12..16].try_into().expect("four bytes"));
                    if client > MAX_WIRE_INTEGER
                        || start >= end
                        || upload.first_seen.last().is_some_and(|previous| {
                            previous.client_id > client as i64
                                || (previous.client_id == client as i64
                                    && previous.end_clock >= i64::from(start))
                        })
                    {
                        return Err(invalid("invalid-live-range"));
                    }
                    upload.first_seen.push(LiveUpdateStructRange {
                        client_id: client as i64,
                        start_clock: i64::from(start),
                        end_clock: i64::from(end),
                    });
                    upload.range_tail.clear();
                }
            }
        }
        if !upload.update.finished
            || upload
                .ranges
                .as_ref()
                .is_some_and(|ranges| !ranges.finished)
        {
            return Ok(None);
        }
        let mut upload = self.uploads.remove(&id).expect("completed upload");
        // Preserve the original deadline for both owner and canonical-host dispatch.
        let remaining = upload
            .deadline
            .saturating_duration_since(Instant::now())
            .as_millis();
        upload.request.deadline_ms = Some(u32::try_from(remaining).unwrap_or(u32::MAX));
        if let Metadata::Owner(params) = upload.metadata {
            return Ok(Some((
                upload.request,
                LiveApplicationInput::Owner(Box::new(crate::rpc::owner_delivery::OwnerInput {
                    params,
                    bytes: upload.bytes,
                    reservation: upload.permit,
                })),
            )));
        }
        let operation = match upload.metadata {
            Metadata::Owner(_) => unreachable!("owner dispatched above"),
            Metadata::Sync(policy) => LiveApplicationOperation::SyncOpen(upload.bytes, policy),
            Metadata::Apply(accepted) => LiveApplicationOperation::Apply(AdmittedLiveUpdate {
                metadata: AdmittedLiveUpdateMetadata {
                    accepted,
                    first_seen: upload.first_seen,
                },
                update_bytes: upload.bytes,
            }),
            Metadata::Bootstrap(metadata) => {
                LiveApplicationOperation::Bootstrap(metadata, upload.bytes)
            }
            Metadata::Adoption {
                registration_id,
                session_id,
                max_bytes,
                max_events,
                outbox_limits,
            } => LiveApplicationOperation::AdoptOwner {
                registration_id,
                session_id,
                cut: adoption::decode(&upload.bytes, max_events, outbox_limits)?,
                max_bytes,
                max_events,
            },
        };
        // Preserve the upload's original deadline after time spent assembling.
        let remaining = upload
            .deadline
            .saturating_duration_since(Instant::now())
            .as_millis();
        upload.request.deadline_ms = Some(u32::try_from(remaining).unwrap_or(u32::MAX));
        Ok(Some((
            upload.request,
            LiveApplicationInput::Admitted(Box::new(AdmittedApplicationInput {
                registration: upload
                    .registration
                    .expect("canonical host upload registration"),
                operation,
                reservation: upload.permit,
                working_reserve_bytes: self.config.application_working_reserve_bytes,
            })),
        )))
    }

    pub fn cancel(&mut self, request_id: u64) -> bool {
        self.uploads.remove(&request_id).is_some() | self.restores.remove(&request_id).is_some()
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        self.uploads
            .values()
            .map(|upload| upload.deadline)
            .chain(self.restores.values().map(|upload| upload.deadline()))
            .min()
    }

    pub fn expire(&mut self) -> Vec<u64> {
        let now = Instant::now();
        let mut expired: Vec<_> = self
            .uploads
            .iter()
            .filter(|(_, upload)| upload.deadline <= now)
            .map(|(id, _)| *id)
            .collect();
        expired.extend(
            self.restores
                .iter()
                .filter(|(_, upload)| upload.deadline() <= now)
                .map(|(id, _)| *id),
        );
        for id in &expired {
            self.uploads.remove(id);
            self.restores.remove(id);
        }
        expired
    }

    pub fn clear(&mut self) {
        self.uploads.clear();
        self.restores.clear();
    }
}

fn invalid(message: &'static str) -> WireError {
    WireError::new(ErrorCode::InvalidParams, message)
}
fn overloaded() -> WireError {
    WireError::new(ErrorCode::Overloaded, "live-application-capacity")
}

#[cfg(test)]
pub(crate) mod tests {
    #[tokio::test]
    async fn settlement_shares_ingress_slots_and_keeps_its_reservation_until_disposal() {
        let (_scratch, service, _owner, workspace, _, _) = fixture().await;
        let ingress = LiveApplicationIngress::new(service.clone(), config()).unwrap();
        assert!(ingress.settlement_admission(0).is_err());
        assert!(ingress.settlement_admission(usize::MAX).is_err());
        let capacity = ingress.budget.available_permits();
        let admission = ingress.settlement_admission(4).unwrap();
        let first = admission.reserve().unwrap();
        let second = admission.reserve().unwrap();
        assert!(admission.reserve().is_err());
        assert!(ingress.budget.available_permits() < capacity);
        assert_eq!(ingress.upload_slots.available_permits(), 0);
        drop(first);
        assert_eq!(ingress.upload_slots.available_permits(), 1);
        drop(second);
        assert_eq!(ingress.budget.available_permits(), capacity);
        service
            .call(
                RequestContext::unbounded(),
                Request {
                    id: 100,
                    method: "workspace.close".into(),
                    workspace: Some(dohc_engine_protocol::wire::WorkspaceHandle(workspace)),
                    deadline_ms: None,
                    idempotency_key: None,
                    params: serde_json::Value::Null,
                },
            )
            .await
            .unwrap();
    }
    use super::*;
    use crate::LiveApplicationHostConfig;
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    use dohc_engine_collab::live_update_application::ApplicationHostCoordinate;
    use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc, durable};
    use dohc_engine_protocol::transport::{ConnectionOwner, EngineService as _, RequestContext};
    use dohc_engine_storage::{
        EngineStore, NoFaults, StorageError, hex_sha256, put_binary_blob_with_sha,
    };
    use dohc_engine_testkit::ScratchDir;
    use serde_json::json;

    pub(crate) async fn fixture() -> (
        ScratchDir,
        Arc<EngineService>,
        ConnectionOwner,
        String,
        u64,
        LiveObjectBinding,
    ) {
        let scratch = ScratchDir::new().unwrap();
        let db = scratch.path().join(".dohc/engine/engine.db");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let mut store = EngineStore::open(&db, 0).unwrap();
        let root_token = crate::root_binding::write_new_root_binding(scratch.path()).unwrap();
        store.bind_root_token(&root_token, &NoFaults).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        let baseline = Ydoc::wire().encode_full_state();
        let binding = LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "one".into(),
            lineage_claim_id: hex_sha256(&baseline),
            current_path: "one.md".into(),
            selector_paths: vec!["one.md".into()],
            restore_fence_generation: 0,
        };
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES ('workspace','one',0)", []).unwrap();
            put_binary_blob_with_sha(tx, &baseline, &binding.lineage_claim_id).unwrap();
            Ok::<_, StorageError>(())
        }).unwrap();
        durable::ensure_marker(
            &mut store,
            &DocKey::new("workspace", "main", "one").unwrap(),
            ContentKind::Plaintext,
            Regime::Replicated,
            &NoFaults,
            0,
        )
        .unwrap();
        store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET lineage_claim_status='exact',lineage_claim_id=?1,path='one.md'", [&binding.lineage_claim_id]).unwrap();
            Ok::<_, StorageError>(())
        }).unwrap();
        drop(store);
        let supervisor = Box::leak(Box::new(dohc_engine_runtime::WorkspaceSupervisor::new()));
        let service = Arc::new(EngineService::with_supervisor(supervisor));
        let response = service.call(RequestContext::unbounded(), Request { id: 1, method: "workspace.open".into(), workspace: None, deadline_ms: None, idempotency_key: None, params: json!({ "rootDir": scratch.path(), "workspaceId": "workspace", "captureMode": "none" }) }).await.unwrap();
        let workspace = response.response.result["workspace"]
            .as_str()
            .unwrap()
            .to_owned();
        let owner = ConnectionOwner::authenticated();
        service
            .provision_live_application(
                owner.handle(),
                LiveApplicationHostConfig {
                    workspace: dohc_engine_protocol::wire::WorkspaceHandle(workspace.clone()),
                    namespace: "relay-history".into(),
                    coordinate: ApplicationHostCoordinate {
                        host_id: "host".into(),
                        host_epoch: 1,
                        instance_id: "instance".into(),
                        connection_id: "connection".into(),
                    },
                    max_registrations: 4,
                },
            )
            .await
            .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let registration = service
            .call(
                ctx,
                Request {
                    id: 2,
                    method: "liveApplication.register".into(),
                    workspace: Some(dohc_engine_protocol::wire::WorkspaceHandle(
                        workspace.clone(),
                    )),
                    deadline_ms: None,
                    idempotency_key: None,
                    params: json!({ "binding": binding }),
                },
            )
            .await
            .unwrap();
        let id = registration.response.result["registrationId"]
            .as_u64()
            .unwrap();
        (scratch, service, owner, workspace, id, binding)
    }

    pub(crate) fn config() -> LiveApplicationIngressConfig {
        LiveApplicationIngressConfig {
            aggregate_bytes: 512 * 1024 * 1024,
            application_working_reserve_bytes: 32 * 1024 * 1024,
            max_uploads: 2,
            upload_deadline: Duration::from_secs(30),
        }
    }

    #[test]
    fn ordinary_ingress_rejects_zero_reserve_and_keeps_positive_operator_limits() {
        let service = Arc::new(EngineService::new());
        let mut configured = config();
        configured.application_working_reserve_bytes = 0;
        let Err(error) = LiveApplicationIngress::new(service.clone(), configured.clone()) else {
            panic!("zero working reserve was accepted");
        };
        assert_eq!(error.code, ErrorCode::InvalidParams);
        assert_eq!(
            error.message,
            "applicationWorkingReserveBytes must be positive"
        );
        for bytes in [1, 1_000_000] {
            configured.application_working_reserve_bytes = bytes;
            let ingress = LiveApplicationIngress::new(service.clone(), configured.clone()).unwrap();
            assert_eq!(ingress.config.application_working_reserve_bytes, bytes);
        }
    }

    pub(crate) fn request(
        workspace: &str,
        registration: u64,
        binding: &LiveObjectBinding,
        bytes: &[u8],
        ranges: &[u8],
    ) -> Request {
        Request {
            id: 3,
            method: "liveApplication.apply".into(),
            workspace: Some(dohc_engine_protocol::wire::WorkspaceHandle(
                workspace.into(),
            )),
            deadline_ms: Some(30_000),
            idempotency_key: None,
            params: json!({
                "accepted": { "receipt": { "deliveryId": "delivery", "updateDigest": hex_sha256(bytes), "journalCursor": 1, "acceptingHostEpoch": 1 }, "binding": binding, "authority": { "principalKind": "owner", "principalId": "owner", "grantId": null, "grantGeneration": null }, "receivedAtMs": 0 },
                "registrationId": registration, "rangeCount": ranges.len()/16, "rangeStreamId": 2, "rangeDigest": hex_sha256(ranges), "updateStreamId": 1, "updateByteLength": bytes.len(),
            }),
        }
    }

    #[tokio::test]
    async fn packed_ranges_preserve_disjoint_spans_and_refuse_noncanonical_order() {
        let (_scratch, service, owner, workspace, registration, binding) = fixture().await;
        let bytes = Ydoc::wire().plaintext_insert(0, "abcdefghij");
        for (spans, allowed) in [
            ([(7_u64, 0_u32, 3_u32), (7, 5, 10)], true),
            ([(7, 0, 3), (7, 3, 10)], false),
            ([(7, 0, 6), (7, 5, 10)], false),
            ([(7, 0, 3), (6, 5, 10)], false),
        ] {
            let ranges: Vec<u8> = spans
                .iter()
                .flat_map(|(client, start, end)| {
                    let mut packed = client.to_le_bytes().to_vec();
                    packed.extend(start.to_le_bytes());
                    packed.extend(end.to_le_bytes());
                    packed
                })
                .collect();
            let mut ingress = LiveApplicationIngress::new(service.clone(), config()).unwrap();
            ingress
                .begin(
                    request(&workspace, registration, &binding, &bytes, &ranges),
                    &owner.handle(),
                )
                .unwrap();
            for (stream_id, payload) in [(1, &bytes), (2, &ranges)] {
                ingress
                    .start(BlobStart {
                        request_id: 3,
                        stream_id,
                        total_bytes: Some(payload.len() as u64),
                        sha256: Some(hex_sha256(payload)),
                    })
                    .unwrap();
            }
            assert!(ingress.chunk(1, true, &bytes).unwrap().is_none());
            let decoded = ingress.chunk(2, true, &ranges);
            if allowed {
                let (_, input) = decoded.unwrap().unwrap();
                let LiveApplicationInput::Admitted(input) = input else {
                    panic!("expected admitted input")
                };
                let LiveApplicationOperation::Apply(event) = input.operation else {
                    panic!("expected application");
                };
                assert_eq!(
                    event.metadata.first_seen,
                    spans.map(|(client, start, end)| LiveUpdateStructRange {
                        client_id: client as i64,
                        start_clock: i64::from(start),
                        end_clock: i64::from(end)
                    })
                );
            } else {
                assert!(decoded.is_err());
            }
        }
    }

    #[tokio::test]
    async fn bootstrap_commits_through_actor_and_replays_without_second_domain_write() {
        let (scratch, service, owner, workspace, _, mut binding) = fixture().await;
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json"
        ))
        .unwrap();
        let vector = &vectors[1];
        let bytes: Vec<u8> = serde_json::from_value(vector["bytes"].clone()).unwrap();
        let markdown = vector["markdown"].as_str().unwrap();
        binding.object_id = "two".into();
        binding.current_path = "two.md".into();
        binding.selector_paths = vec!["two.md".into()];
        binding.lineage_claim_id = hex_sha256(&bytes);
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let registered = service
            .call(
                ctx,
                Request {
                    id: 10,
                    method: "liveApplication.register".into(),
                    workspace: Some(dohc_engine_protocol::wire::WorkspaceHandle(
                        workspace.clone(),
                    )),
                    deadline_ms: None,
                    idempotency_key: None,
                    params: json!({"binding":binding}),
                },
            )
            .await
            .unwrap();
        let registration = registered.response.result["registrationId"]
            .as_u64()
            .unwrap();
        let mut ingress = LiveApplicationIngress::new(service.clone(), config()).unwrap();
        let budget = ingress.budget.available_permits();
        for sequence in 1..=2 {
            let request = Request {
                id: 20 + sequence,
                method: "liveApplication.bootstrap".into(),
                workspace: Some(dohc_engine_protocol::wire::WorkspaceHandle(
                    workspace.clone(),
                )),
                deadline_ms: Some(30_000),
                idempotency_key: None,
                params: json!({"registrationId":registration,"baselineStreamId":sequence,"baseline":{
                    "bootstrapId":"bootstrap","bootstrapMomentId":"bootstrap-moment","baselineMomentRelaySequence":0,"baselineRegisteredAtMs":100,
                    "baselineDigest":hex_sha256(&bytes),"baselineByteLength":bytes.len(),"projectedMarkdownDigest":hex_sha256(markdown.as_bytes()),"projectedMarkdownByteLength":markdown.len()
                }}),
            };
            ingress.begin(request, &owner.handle()).unwrap();
            ingress
                .start(BlobStart {
                    request_id: 20 + sequence,
                    stream_id: sequence,
                    total_bytes: Some(bytes.len() as u64),
                    sha256: Some(hex_sha256(&bytes)),
                })
                .unwrap();
            let (request, input) = ingress.chunk(sequence, true, &bytes).unwrap().unwrap();
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            let response = service
                .call_with_input(ctx, request, Some(input))
                .await
                .unwrap();
            assert_eq!(response.response.result["status"], "bootstrapped");
            assert_eq!(response.response.result["ack"]["localYDocSequence"], 0);
            assert_eq!(
                response.response.result["ack"]["bootstrapReplayed"],
                sequence == 2
            );
            assert!(response.output_guard.as_ref().unwrap().is_current());
            assert!(ingress.budget.available_permits() < budget);
            let raw =
                rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).unwrap();
            let rows:(i64,i64,i64)=raw.query_row("SELECT (SELECT COUNT(*) FROM live_device_bootstraps),(SELECT COUNT(*) FROM moments WHERE object_id='two'),(SELECT COUNT(*) FROM engine_search_files_fts WHERE object_id='two' AND text=?1)",[markdown],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
            assert_eq!(rows, (1, 1, 1));
            drop(response);
            assert_eq!(ingress.budget.available_permits(), budget);
        }
        service
            .call(
                RequestContext::unbounded(),
                Request {
                    id: 100,
                    method: "workspace.close".into(),
                    workspace: Some(dohc_engine_protocol::wire::WorkspaceHandle(workspace)),
                    deadline_ms: None,
                    idempotency_key: None,
                    params: serde_json::Value::Null,
                },
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn owned_streams_apply_and_keep_the_charge_until_response_disposal() {
        let (_scratch, service, owner, workspace, registration, binding) = fixture().await;
        let mut ingress = LiveApplicationIngress::new(service.clone(), config()).unwrap();
        let capacity = ingress.budget.available_permits();
        let bytes = Ydoc::wire().plaintext_insert(0, "hello");
        ingress
            .begin(
                request(&workspace, registration, &binding, &bytes, &[]),
                &owner.handle(),
            )
            .unwrap();
        assert!(ingress.budget.available_permits() < capacity);
        assert_eq!(ingress.upload_slots.available_permits(), 1);
        ingress
            .start(BlobStart {
                request_id: 3,
                stream_id: 1,
                total_bytes: Some(bytes.len() as u64),
                sha256: Some(hex_sha256(&bytes)),
            })
            .unwrap();
        ingress
            .start(BlobStart {
                request_id: 3,
                stream_id: 2,
                total_bytes: Some(0),
                sha256: Some(hex_sha256(&[])),
            })
            .unwrap();
        assert!(ingress.chunk(1, true, &bytes).unwrap().is_none());
        let (request, input) = ingress.chunk(2, true, &[]).unwrap().unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let response = service
            .call_with_input(ctx, request, Some(input))
            .await
            .unwrap();
        assert_eq!(response.response.result["status"], "applied");
        assert!(
            !response.response.result["ack"]["applicationReplayed"]
                .as_bool()
                .unwrap()
        );
        assert!(response.output_guard.as_ref().unwrap().is_current());
        assert!(ingress.budget.available_permits() < capacity);
        let mut second = self::request(&workspace, registration, &binding, &bytes, &[]);
        second.id = 4;
        second.params["updateStreamId"] = json!(3);
        second.params["rangeStreamId"] = json!(4);
        ingress.begin(second.clone(), &owner.handle()).unwrap();
        let mut third = second;
        third.id = 5;
        third.params["updateStreamId"] = json!(5);
        third.params["rangeStreamId"] = json!(6);
        assert_eq!(
            ingress.begin(third, &owner.handle()).unwrap_err().code,
            ErrorCode::Overloaded
        );
        ingress.clear();
        assert_eq!(
            ingress.upload_slots.available_permits(),
            1,
            "queued response still holds its slot"
        );
        let old_guard = response.output_guard.as_ref().unwrap();
        let retirement = old_guard.retirement_signal();
        let mut last_registration = registration;
        for id in 10..20 {
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            let replacement = service
                .call(
                    ctx,
                    Request {
                        id,
                        method: "liveApplication.register".into(),
                        workspace: Some(dohc_engine_protocol::wire::WorkspaceHandle(
                            workspace.clone(),
                        )),
                        deadline_ms: None,
                        idempotency_key: None,
                        params: json!({"binding": binding}),
                    },
                )
                .await
                .unwrap();
            last_registration = replacement.response.result["registrationId"]
                .as_u64()
                .unwrap();
        }
        assert!(
            !old_guard.is_current(),
            "replacement retires a queued acknowledgement"
        );
        assert!(
            retirement.is_cancelled(),
            "replacement wakes blocked output"
        );
        assert!(
            service
                .live_application_registration(
                    &owner.handle(),
                    Some(&dohc_engine_protocol::wire::WorkspaceHandle(
                        workspace.clone()
                    )),
                    last_registration
                )
                .is_ok()
        );
        assert!(
            service
                .live_application_registration(
                    &owner.handle(),
                    Some(&dohc_engine_protocol::wire::WorkspaceHandle(
                        workspace.clone()
                    )),
                    registration
                )
                .is_err()
        );
        owner.retire();
        assert!(!response.output_guard.as_ref().unwrap().is_current());
        drop(response);
        assert_eq!(ingress.budget.available_permits(), capacity);
        assert_eq!(ingress.upload_slots.available_permits(), 2);
    }

    #[tokio::test]
    async fn malformed_header_and_stream_failures_never_apply_or_retain_a_charge() {
        let (_scratch, service, owner, workspace, registration, binding) = fixture().await;
        let bytes = Ydoc::wire().plaintext_insert(0, "hello");
        let mut ingress = LiveApplicationIngress::new(service.clone(), config()).unwrap();
        let capacity = ingress.budget.available_permits();
        let mut too_long = request(&workspace, registration, &binding, &bytes, &[]);
        too_long.params["accepted"]["authority"]["principalId"] = json!("x".repeat(1024 * 1024));
        assert!(ingress.begin(too_long, &owner.handle()).is_err());
        assert_eq!(ingress.budget.available_permits(), capacity);
        let foreign = ConnectionOwner::authenticated();
        assert!(
            ingress
                .begin(
                    request(&workspace, registration, &binding, &bytes, &[]),
                    &foreign.handle()
                )
                .is_err()
        );
        ingress
            .begin(
                request(&workspace, registration, &binding, &bytes, &[]),
                &owner.handle(),
            )
            .unwrap();
        assert!(ingress.chunk(1, true, &bytes).is_err());
        ingress.clear();
        assert_eq!(ingress.budget.available_permits(), capacity);
        assert!(
            ingress
                .begin(
                    request(&workspace, registration, &binding, &bytes, &[]),
                    &owner.handle()
                )
                .is_err(),
            "stream IDs cannot be reused"
        );
        let db = _scratch.path().join(".dohc/engine/engine.db");
        let raw = rusqlite::Connection::open(db).unwrap();
        assert_eq!(
            raw.query_row(
                "SELECT COUNT(*) FROM live_device_update_applications",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn malformed_streams_release_their_slots_without_mutating_the_document() {
        let (scratch, service, owner, workspace, registration, binding) = fixture().await;
        let bytes = Ydoc::wire().plaintext_insert(0, "bounded input");
        for case in 0..6 {
            let mut ingress = LiveApplicationIngress::new(service.clone(), config()).unwrap();
            ingress
                .begin(
                    request(&workspace, registration, &binding, &bytes, &[]),
                    &owner.handle(),
                )
                .unwrap();
            let start = BlobStart {
                request_id: 3,
                stream_id: 1,
                total_bytes: Some(bytes.len() as u64),
                sha256: Some(hex_sha256(&bytes)),
            };
            ingress.start(start.clone()).unwrap();
            match case {
                0 => assert!(ingress.start(start).is_err()),
                1 => assert!(ingress.chunk(1, true, &bytes[..bytes.len() - 1]).is_err()),
                2 => assert!(ingress.chunk(1, false, &bytes).is_err()),
                3 => {
                    let mut corrupt = bytes.clone();
                    corrupt[0] ^= 1;
                    assert!(ingress.chunk(1, true, &corrupt).is_err());
                }
                4 => assert!(ingress.chunk(99, true, &bytes).is_err()),
                5 => {
                    let mut wrong = start;
                    wrong.request_id = 99;
                    assert!(ingress.start(wrong).is_err());
                }
                _ => unreachable!(),
            }
            ingress.clear();
            assert_eq!(ingress.budget.available_permits(), config().aggregate_bytes);
            assert_eq!(
                ingress.upload_slots.available_permits(),
                config().max_uploads
            );
        }
        let raw =
            rusqlite::Connection::open(scratch.path().join(".dohc/engine/engine.db")).unwrap();
        assert_eq!(
            raw.query_row(
                "SELECT COUNT(*) FROM live_device_update_applications",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
}
