//! Durable application of relay-committed live updates.
//!
//! The caller owns authenticated delivery and one ApplicationOwner per engine
//! handle. Event parsing supplies no authority. The owner serializes held-handle
//! invalidation with each transaction; the transport must also suppress a reply
//! if its connection closes after this operation returns.
//! New committed applications compact at the existing default threshold after
//! the append transaction closes and its cache entry is evicted. A failed fold
//! leaves the committed application replayable. Exact replay does not compact.
//! The durable `available` column fences a registration; it does not prove that
//! its connection is alive. Owner drop invalidates held handles in memory.

use crate::limits::DEFAULT_COMPACTION_THRESHOLD;
use crate::live_object_binding::LiveObjectBinding;
use crate::{durable, CollabError, DocKey, Regime, WriterDocCache};
use dohc_engine_storage::{
    get_binary_blob, hex_sha256, EngineStore, FaultInjector, NoFaults, StorageError, TxnOutcome,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const SAFE: i64 = 9_007_199_254_740_991;

mod bootstrap;
pub use bootstrap::{
    bootstrap_committed, BootstrapResult, LiveApplicationBootstrap, LiveApplicationBootstrapAck,
};

#[derive(Debug, thiserror::Error)]
pub enum ApplicationError {
    #[error("invalid live application input: {0}")]
    InvalidInput(&'static str),
    #[error("live application workspace does not match the engine handle")]
    WorkspaceMismatch,
    #[error("live application main version does not match durable workspace state")]
    MainVersionMismatch,
    #[error("live application evidence is corrupt")]
    Corrupt,
    #[error("live application delivery or cursor conflicts with retained evidence")]
    Conflict,
    #[error("live application commit acknowledgement was interrupted")]
    Interrupted,
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Collab(#[from] CollabError),
}

fn invalid(message: &'static str) -> ApplicationError {
    ApplicationError::InvalidInput(message)
}
fn read_sql(error: rusqlite::Error) -> ApplicationError {
    StorageError::corrupt_public(error).into()
}
fn write_sql(error: rusqlite::Error) -> ApplicationError {
    StorageError::persist_public(error).into()
}
fn integer(value: i64, min: i64, max: i64) -> Result<(), ApplicationError> {
    if (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(invalid("integer outside shared bound"))
    }
}
fn identifier(value: &str, max: usize) -> Result<(), ApplicationError> {
    if value.is_empty() || value.len() > max || value.bytes().any(|b| b.is_ascii_control()) {
        Err(invalid(
            "identifier is empty, oversized, or contains control bytes",
        ))
    } else {
        Ok(())
    }
}
fn digest(value: &str) -> Result<(), ApplicationError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(invalid("digest must be lowercase SHA-256"))
    }
}
fn wire_integer<'de, D: Deserializer<'de>>(decoder: D) -> Result<i64, D::Error> {
    let value = Value::deserialize(decoder)?;
    let n = value
        .as_f64()
        .ok_or_else(|| serde::de::Error::custom("expected number"))?;
    if n.is_finite() && n.fract() == 0.0 && n.abs() <= SAFE as f64 {
        Ok(n as i64)
    } else {
        Err(serde::de::Error::custom("expected safe integer"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveUpdateReceipt {
    pub delivery_id: String,
    pub update_digest: String,
    #[serde(deserialize_with = "wire_integer")]
    pub journal_cursor: i64,
    #[serde(deserialize_with = "wire_integer")]
    pub accepting_host_epoch: i64,
}
impl LiveUpdateReceipt {
    fn validate(&self) -> Result<(), ApplicationError> {
        identifier(&self.delivery_id, 512)?;
        digest(&self.update_digest)?;
        integer(self.journal_cursor, 1, SAFE)?;
        integer(self.accepting_host_epoch, 1, SAFE)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerDerivedLiveUpdateAuthority {
    Owner {
        principal_id: String,
    },
    Named {
        principal_id: String,
        grant_id: String,
        grant_generation: i64,
    },
    Link {
        principal_id: String,
        grant_id: String,
        grant_generation: i64,
    },
}
impl ServerDerivedLiveUpdateAuthority {
    fn fields(&self) -> (&'static str, &str, Option<&str>, Option<i64>) {
        match self {
            Self::Owner { principal_id } => ("owner", principal_id, None, None),
            Self::Named {
                principal_id,
                grant_id,
                grant_generation,
            } => (
                "named",
                principal_id,
                Some(grant_id),
                Some(*grant_generation),
            ),
            Self::Link {
                principal_id,
                grant_id,
                grant_generation,
            } => (
                "link",
                principal_id,
                Some(grant_id),
                Some(*grant_generation),
            ),
        }
    }
    fn validate(&self) -> Result<(), ApplicationError> {
        let (_, principal, grant, generation) = self.fields();
        identifier(principal, 512)?;
        if let Some(grant) = grant {
            identifier(grant, 512)?;
        }
        if let Some(generation) = generation {
            integer(generation, 1, SAFE)?;
        }
        Ok(())
    }
}
impl Serialize for ServerDerivedLiveUpdateAuthority {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let (kind, principal, grant, generation) = self.fields();
        serde_json::json!({"principalKind":kind,"principalId":principal,"grantId":grant,"grantGeneration":generation}).serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for ServerDerivedLiveUpdateAuthority {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Raw {
            principal_kind: String,
            principal_id: String,
            grant_id: Value,
            grant_generation: Value,
        }
        let raw = Raw::deserialize(decoder)?;
        let authority = if raw.principal_kind == "owner"
            && raw.grant_id.is_null()
            && raw.grant_generation.is_null()
        {
            Self::Owner {
                principal_id: raw.principal_id,
            }
        } else {
            let grant_id = raw
                .grant_id
                .as_str()
                .ok_or_else(|| serde::de::Error::custom("grant ID required"))?
                .to_owned();
            let grant_generation =
                wire_integer(raw.grant_generation).map_err(serde::de::Error::custom)?;
            match raw.principal_kind.as_str() {
                "named" => Self::Named {
                    principal_id: raw.principal_id,
                    grant_id,
                    grant_generation,
                },
                "link" => Self::Link {
                    principal_id: raw.principal_id,
                    grant_id,
                    grant_generation,
                },
                _ => return Err(serde::de::Error::custom("invalid authority kind/null pair")),
            }
        };
        authority.validate().map_err(serde::de::Error::custom)?;
        Ok(authority)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayAcceptedLiveUpdate {
    pub receipt: LiveUpdateReceipt,
    pub binding: LiveObjectBinding,
    pub authority: ServerDerivedLiveUpdateAuthority,
    #[serde(deserialize_with = "wire_integer")]
    pub received_at_ms: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveUpdateStructRange {
    #[serde(deserialize_with = "wire_integer")]
    pub client_id: i64,
    #[serde(deserialize_with = "wire_integer")]
    pub start_clock: i64,
    #[serde(deserialize_with = "wire_integer")]
    pub end_clock: i64,
}
impl LiveUpdateStructRange {
    fn validate(&self) -> Result<(), ApplicationError> {
        integer(self.client_id, 0, SAFE)?;
        integer(self.start_clock, 0, 4_294_967_294)?;
        integer(self.end_clock, 1, 4_294_967_295)?;
        if self.start_clock >= self.end_clock {
            return Err(invalid("empty or reversed range"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdmittedLiveUpdateMetadata {
    pub accepted: RelayAcceptedLiveUpdate,
    pub first_seen: Vec<LiveUpdateStructRange>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmittedLiveUpdate {
    pub metadata: AdmittedLiveUpdateMetadata,
    pub update_bytes: Vec<u8>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveUpdateHostApplicationAck {
    pub delivery_id: String,
    pub update_digest: String,
    #[serde(deserialize_with = "wire_integer")]
    pub journal_cursor: i64,
    #[serde(deserialize_with = "wire_integer")]
    pub accepting_host_epoch: i64,
    #[serde(rename = "localYDocSequence", deserialize_with = "wire_integer")]
    pub local_ydoc_sequence: i64,
    pub application_replayed: bool,
}
impl LiveUpdateHostApplicationAck {
    fn new(receipt: &LiveUpdateReceipt, seq: i64, replayed: bool) -> Self {
        Self {
            delivery_id: receipt.delivery_id.clone(),
            update_digest: receipt.update_digest.clone(),
            journal_cursor: receipt.journal_cursor,
            accepting_host_epoch: receipt.accepting_host_epoch,
            local_ydoc_sequence: seq,
            application_replayed: replayed,
        }
    }
}

fn canonical_binding(binding: &LiveObjectBinding) -> Result<(), ApplicationError> {
    if binding.clone().normalized().map_err(invalid)? != *binding {
        return Err(invalid("noncanonical binding"));
    }
    Ok(())
}
fn canonical_ranges(ranges: &[LiveUpdateStructRange]) -> Result<(), ApplicationError> {
    let mut previous: Option<&LiveUpdateStructRange> = None;
    for range in ranges {
        range.validate()?;
        if let Some(prev) = previous {
            if range.client_id < prev.client_id
                || (range.client_id == prev.client_id && range.start_clock <= prev.end_clock)
            {
                return Err(invalid("noncanonical firstSeen"));
            }
        }
        previous = Some(range);
    }
    Ok(())
}
impl AdmittedLiveUpdate {
    pub fn from_committed_metadata(
        metadata: Value,
        update_bytes: Vec<u8>,
    ) -> Result<Self, ApplicationError> {
        let metadata = decode_metadata(metadata)?;
        let event = Self {
            metadata,
            update_bytes,
        };
        event.validate()?;
        Ok(event)
    }
    /// Validate immutable committed facts before any normalization.
    pub fn validate(&self) -> Result<(), ApplicationError> {
        let accepted = &self.metadata.accepted;
        accepted.receipt.validate()?;
        canonical_binding(&accepted.binding)?;
        accepted.authority.validate()?;
        integer(accepted.received_at_ms, 0, SAFE)?;
        canonical_ranges(&self.metadata.first_seen)?;
        if self.update_bytes.is_empty()
            || hex_sha256(&self.update_bytes) != accepted.receipt.update_digest
        {
            return Err(invalid("update byte/digest mismatch"));
        }
        Ok(())
    }
}

fn normalize_json_integers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            if let Some(n) = number.as_f64() {
                if n.is_finite() && n.fract() == 0.0 && n.abs() <= SAFE as f64 {
                    *number = (n as i64).into();
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(normalize_json_integers),
        Value::Object(fields) => fields.values_mut().for_each(normalize_json_integers),
        _ => {}
    }
}
fn decode_metadata(mut input: Value) -> Result<AdmittedLiveUpdateMetadata, ApplicationError> {
    normalize_json_integers(&mut input);
    serde_json::from_value(input).map_err(|_| invalid("invalid admitted metadata shape"))
}
/// Shared parser normalization. This is not the committed-record integrity gate.
pub fn parse_admitted_metadata(
    input: Value,
) -> Result<AdmittedLiveUpdateMetadata, ApplicationError> {
    let mut metadata = decode_metadata(input)?;
    let a = &mut metadata.accepted;
    a.receipt.validate()?;
    a.authority.validate()?;
    integer(a.received_at_ms, 0, SAFE)?;
    a.binding = a.binding.clone().normalized().map_err(invalid)?;
    for range in &metadata.first_seen {
        range.validate()?;
    }
    metadata
        .first_seen
        .sort_by_key(|range| (range.client_id, range.start_clock));
    let mut merged: Vec<LiveUpdateStructRange> = Vec::new();
    for range in metadata.first_seen {
        if let Some(previous) = merged.last_mut() {
            if previous.client_id == range.client_id && range.start_clock <= previous.end_clock {
                previous.end_clock = previous.end_clock.max(range.end_clock);
                continue;
            }
        }
        merged.push(range);
    }
    metadata.first_seen = merged;
    Ok(metadata)
}
pub fn parse_application_ack(
    input: Value,
) -> Result<LiveUpdateHostApplicationAck, ApplicationError> {
    let ack: LiveUpdateHostApplicationAck =
        serde_json::from_value(input).map_err(|_| invalid("invalid ACK shape"))?;
    LiveUpdateReceipt {
        delivery_id: ack.delivery_id.clone(),
        update_digest: ack.update_digest.clone(),
        journal_cursor: ack.journal_cursor,
        accepting_host_epoch: ack.accepting_host_epoch,
    }
    .validate()?;
    integer(ack.local_ydoc_sequence, 1, SAFE)?;
    Ok(ack)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationHostCoordinate {
    pub host_id: String,
    pub host_epoch: i64,
    pub instance_id: String,
    pub connection_id: String,
}
impl ApplicationHostCoordinate {
    fn validate(&self) -> Result<(), ApplicationError> {
        identifier(&self.host_id, 1024)?;
        integer(self.host_epoch, 1, SAFE)?;
        identifier(&self.instance_id, 1024)?;
        identifier(&self.connection_id, 1024)
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplicationPending {
    DependenciesUnresolved,
    BaselineUnavailable,
    ApplicabilityUnavailable,
    BindingMismatch,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplicationResult {
    Applied(LiveUpdateHostApplicationAck),
    Pending(ApplicationPending),
}

#[derive(Debug)]
struct Registration {
    workspace_id: String,
    namespace: String,
    coordinate: ApplicationHostCoordinate,
    binding: LiveObjectBinding,
    live: bool,
}
/// One trusted delivery owner for an engine workspace. Never deserialize this
/// from an event. The production caller authenticates registration and namespace.
pub struct ApplicationOwner {
    workspace_id: String,
    current: Vec<Arc<Mutex<Registration>>>,
}
/// A captured lifetime. Replacement invalidates every clone of the old handle.
#[derive(Clone)]
pub struct ApplicationHandle {
    registration: Arc<Mutex<Registration>>,
}

impl ApplicationOwner {
    pub fn new(workspace_id: String) -> Result<Self, ApplicationError> {
        identifier(&workspace_id, 512)?;
        Ok(Self {
            workspace_id,
            current: Vec::new(),
        })
    }
    pub fn register(
        &mut self,
        store: &mut EngineStore,
        namespace: String,
        coordinate: ApplicationHostCoordinate,
        binding: LiveObjectBinding,
    ) -> Result<ApplicationHandle, ApplicationError> {
        if namespace.is_empty() {
            return Err(invalid("relay namespace is empty"));
        }
        coordinate.validate()?;
        canonical_binding(&binding)?;
        if binding.workspace_id != self.workspace_id {
            return Err(ApplicationError::WorkspaceMismatch);
        }
        let connection_changed = self.current.iter().any(|entry| {
            entry.lock().map_or(true, |r| {
                r.namespace != namespace || r.coordinate != coordinate
            })
        });
        if connection_changed {
            self.invalidate(store)?;
        }
        let mut replaced = None;
        for (index, current) in self.current.iter().enumerate() {
            let held = current.lock().map_err(|_| ApplicationError::Interrupted)?;
            if held.binding.object_id == binding.object_id {
                replaced = Some(index);
                break;
            }
        }
        if let Some(index) = replaced {
            invalidate_registration(store, &self.current[index])?;
            self.current.remove(index);
        }
        let registration = Registration {
            workspace_id: self.workspace_id.clone(),
            namespace,
            coordinate,
            binding,
            live: true,
        };
        let outcome = store.write_with(&NoFaults, |tx| {
            require_workspace(tx, &registration)?;
            install_binding(tx, &registration)
        })?;
        if !matches!(outcome, TxnOutcome::Committed(())) {
            return Err(ApplicationError::Interrupted);
        }
        let registration = Arc::new(Mutex::new(registration));
        self.current.push(registration.clone());
        Ok(ApplicationHandle { registration })
    }
    pub fn invalidate(&mut self, store: &mut EngineStore) -> Result<(), ApplicationError> {
        for current in &self.current {
            current
                .lock()
                .map_err(|_| ApplicationError::Interrupted)?
                .live = false;
        }
        for current in &self.current {
            invalidate_registration(store, current)?;
        }
        self.current.clear();
        Ok(())
    }
}
fn invalidate_registration(
    store: &mut EngineStore,
    current: &Arc<Mutex<Registration>>,
) -> Result<(), ApplicationError> {
    let mut held = current.lock().map_err(|_| ApplicationError::Interrupted)?;
    held.live = false;
    let c = &held.coordinate;
    let b = &held.binding;
    let outcome = store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE live_device_application_bindings SET available=0 WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND host_id=?5 AND host_epoch=?6 AND instance_id=?7 AND connection_id=?8",
                params![held.namespace, held.workspace_id, b.main_version_id, b.object_id, c.host_id, c.host_epoch, c.instance_id, c.connection_id]).map_err(write_sql)?;
            Ok::<_, ApplicationError>(())
        })?;
    if matches!(outcome, TxnOutcome::Committed(())) {
        Ok(())
    } else {
        Err(ApplicationError::Interrupted)
    }
}
impl Drop for ApplicationOwner {
    fn drop(&mut self) {
        for current in &self.current {
            if let Ok(mut registration) = current.lock() {
                registration.live = false;
            }
        }
    }
}

fn require_workspace(tx: &Connection, registration: &Registration) -> Result<(), ApplicationError> {
    if registration.workspace_id != registration.binding.workspace_id {
        return Err(ApplicationError::WorkspaceMismatch);
    }
    let main: Option<String> = tx
        .query_row(
            "SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1",
            [&registration.workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(read_sql)?;
    if main.as_deref() != Some(registration.binding.main_version_id.as_str()) {
        return Err(ApplicationError::MainVersionMismatch);
    }
    Ok(())
}
fn install_binding(tx: &Transaction<'_>, r: &Registration) -> Result<(), ApplicationError> {
    let b = &r.binding;
    let c = &r.coordinate;
    tx.execute("INSERT INTO live_device_application_bindings (relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,host_id,host_epoch,instance_id,connection_id,available) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,1) ON CONFLICT(relay_database_namespace,workspace_id,main_version_id,object_id) DO UPDATE SET lineage_claim_id=excluded.lineage_claim_id,current_path=excluded.current_path,selector_paths_json=excluded.selector_paths_json,restore_fence_generation=excluded.restore_fence_generation,host_id=excluded.host_id,host_epoch=excluded.host_epoch,instance_id=excluded.instance_id,connection_id=excluded.connection_id,available=1",
        params![r.namespace,r.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.current_path,serde_json::to_string(&b.selector_paths).map_err(|_| invalid("selector JSON"))?,b.restore_fence_generation,c.host_id,c.host_epoch,c.instance_id,c.connection_id]).map_err(write_sql)?;
    Ok(())
}

fn read_binding(
    conn: &Connection,
    r: &Registration,
) -> Result<Option<(LiveObjectBinding, ApplicationHostCoordinate, bool)>, ApplicationError> {
    let b = &r.binding;
    conn.query_row("SELECT lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,host_id,host_epoch,instance_id,connection_id,available FROM live_device_application_bindings WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4",
        params![r.namespace,r.workspace_id,b.main_version_id,b.object_id], |row| {
            let selectors: String = row.get(2)?;
            let binding = LiveObjectBinding { workspace_id:r.workspace_id.clone(),main_version_id:b.main_version_id.clone(),object_id:b.object_id.clone(),lineage_claim_id:row.get(0)?,current_path:row.get(1)?,selector_paths:serde_json::from_str(&selectors).map_err(|e| rusqlite::Error::FromSqlConversionFailure(2,rusqlite::types::Type::Text,Box::new(e)))?,restore_fence_generation:row.get(3)? };
            let coordinate = ApplicationHostCoordinate { host_id:row.get(4)?,host_epoch:row.get(5)?,instance_id:row.get(6)?,connection_id:row.get(7)? };
            let available: i64 = row.get(8)?;
            Ok((binding,coordinate,available))
        }).optional().map_err(read_sql)?.map(|(binding,coordinate,available)| {
            canonical_binding(&binding).map_err(|_| ApplicationError::Corrupt)?;
            coordinate.validate().map_err(|_| ApplicationError::Corrupt)?;
            if !matches!(available,0|1) { return Err(ApplicationError::Corrupt); }
            Ok((binding,coordinate,available==1))
        }).transpose()
}

#[derive(Debug, thiserror::Error)]
enum TransactionError {
    #[error("pending dependencies require rollback")]
    DependenciesUnresolved,
    #[error(transparent)]
    Application(#[from] ApplicationError),
}
impl From<StorageError> for TransactionError {
    fn from(error: StorageError) -> Self {
        Self::Application(error.into())
    }
}
impl From<CollabError> for TransactionError {
    fn from(error: CollabError) -> Self {
        Self::Application(error.into())
    }
}

/// Apply one owned committed event. No outbound origination signal escapes.
/// Pending dependencies roll back this attempt, including a fresh append.
/// A post-commit fold error is safely redeliverable at the original sequence.
pub fn apply_committed(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    handle: &ApplicationHandle,
    event: AdmittedLiveUpdate,
    faults: &dyn FaultInjector,
) -> Result<ApplicationResult, ApplicationError> {
    event.validate()?;
    let held = handle
        .registration
        .lock()
        .map_err(|_| ApplicationError::Interrupted)?;
    let b = &event.metadata.accepted.binding;
    if b.workspace_id != held.workspace_id {
        return Err(ApplicationError::WorkspaceMismatch);
    }
    if !held.live {
        return Ok(ApplicationResult::Pending(
            ApplicationPending::ApplicabilityUnavailable,
        ));
    }
    let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    let mut mutation_attempted = false;
    let mut compaction_due = false;
    let outcome = store.write_with(
        faults,
        |tx| -> Result<ApplicationResult, TransactionError> {
            require_workspace(tx, &held)?;
            if b != &held.binding {
                return Ok(ApplicationResult::Pending(
                    ApplicationPending::BindingMismatch,
                ));
            }
            let Some((binding, coordinate, available)) = read_binding(tx, &held)? else {
                return Ok(ApplicationResult::Pending(
                    ApplicationPending::ApplicabilityUnavailable,
                ));
            };
            if !available || coordinate != held.coordinate || binding != held.binding {
                return Ok(ApplicationResult::Pending(
                    ApplicationPending::ApplicabilityUnavailable,
                ));
            }
            let Some(marker) = durable::read_marker_in(tx, &key)? else {
                return Ok(ApplicationResult::Pending(
                    ApplicationPending::BaselineUnavailable,
                ));
            };
            if marker.regime != Regime::Replicated
                || marker.lineage_claim_status != durable::LineageClaimStatus::Exact
                || marker.lineage_claim_id.as_deref() != Some(&b.lineage_claim_id)
                || marker.path.as_deref() != Some(&b.current_path)
            {
                return Ok(ApplicationResult::Pending(
                    ApplicationPending::BindingMismatch,
                ));
            }
            if let Some(record) =
                read_application(tx, &held.namespace, &event.metadata.accepted.receipt)?
            {
                if record.event != event {
                    return Err(ApplicationError::Conflict.into());
                }
                return Ok(ApplicationResult::Applied(
                    LiveUpdateHostApplicationAck::new(
                        &event.metadata.accepted.receipt,
                        record.sequence,
                        true,
                    ),
                ));
            }
            check_provenance(tx, &held.namespace, &event)?;
            mutation_attempted = true;
            let append = durable::record_update_in_tx(
                tx,
                &key,
                &event.update_bytes,
                None,
                None,
                event.metadata.accepted.received_at_ms,
            )?;
            // A new delivery can reuse old bytes and an older local sequence.
            compaction_due = append.seq.max(marker.head_update_seq) - marker.head_snapshot_seq
                >= i64::from(DEFAULT_COMPACTION_THRESHOLD);
            // Content dedupe bypasses the append's parity gate. Always reconstruct.
            if durable::load_doc_in(tx, &key)?.has_missing_updates() {
                return Err(TransactionError::DependenciesUnresolved);
            }
            integer(append.seq, 1, SAFE)?;
            insert_application(tx, &held, &event, append.seq)?;
            let readback = read_application(tx, &held.namespace, &event.metadata.accepted.receipt)?
                .ok_or(ApplicationError::Corrupt)?;
            if readback.event != event
                || readback.sequence != append.seq
                || readback.coordinate != held.coordinate
            {
                return Err(ApplicationError::Corrupt.into());
            }
            Ok(ApplicationResult::Applied(
                LiveUpdateHostApplicationAck::new(
                    &event.metadata.accepted.receipt,
                    append.seq,
                    false,
                ),
            ))
        },
    );
    if mutation_attempted {
        cache.remove(&key);
    }
    match outcome {
        Ok(TxnOutcome::Committed(result)) => {
            if compaction_due
                && matches!(&result, ApplicationResult::Applied(ack) if !ack.application_replayed)
            {
                // The key is already evicted. As in self_bound_log, an injected
                // fold crash keeps the committed ACK; a real error suppresses it.
                durable::maybe_compact(
                    store,
                    &key,
                    DEFAULT_COMPACTION_THRESHOLD,
                    faults,
                    event.metadata.accepted.received_at_ms,
                )?;
            }
            Ok(result)
        }
        Ok(TxnOutcome::Crashed { .. }) => Err(ApplicationError::Interrupted),
        Err(TransactionError::DependenciesUnresolved) => Ok(ApplicationResult::Pending(
            ApplicationPending::DependenciesUnresolved,
        )),
        Err(TransactionError::Application(error)) => Err(error),
    }
}

struct ApplicationRecord {
    event: AdmittedLiveUpdate,
    sequence: i64,
    coordinate: ApplicationHostCoordinate,
}

fn read_application(
    conn: &Connection,
    namespace: &str,
    receipt: &LiveUpdateReceipt,
) -> Result<Option<ApplicationRecord>, ApplicationError> {
    let mut query = conn.prepare("SELECT workspace_id,delivery_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,update_digest,update_byte_length,journal_cursor,accepting_host_epoch,principal_kind,principal_id,grant_id,grant_generation,received_at_ms,first_seen_count,local_ydoc_sequence,applied_host_id,applied_host_epoch,applied_instance_id,applied_connection_id FROM live_device_update_applications WHERE relay_database_namespace=?1 AND (delivery_id=?2 OR journal_cursor=?3)").map_err(read_sql)?;
    let mut rows = query
        .query(params![
            namespace,
            receipt.delivery_id,
            receipt.journal_cursor
        ])
        .map_err(read_sql)?;
    let Some(row) = rows.next().map_err(read_sql)? else {
        return Ok(None);
    };
    let workspace: String = row.get(0).map_err(read_sql)?;
    let delivery_id: String = row.get(1).map_err(read_sql)?;
    let selector_json: String = row.get(6).map_err(read_sql)?;
    let binding = LiveObjectBinding {
        workspace_id: workspace.clone(),
        main_version_id: row.get(2).map_err(read_sql)?,
        object_id: row.get(3).map_err(read_sql)?,
        lineage_claim_id: row.get(4).map_err(read_sql)?,
        current_path: row.get(5).map_err(read_sql)?,
        selector_paths: serde_json::from_str(&selector_json)
            .map_err(|_| ApplicationError::Corrupt)?,
        restore_fence_generation: row.get(7).map_err(read_sql)?,
    };
    let receipt = LiveUpdateReceipt {
        delivery_id: delivery_id.clone(),
        update_digest: row.get(8).map_err(read_sql)?,
        journal_cursor: row.get(10).map_err(read_sql)?,
        accepting_host_epoch: row.get(11).map_err(read_sql)?,
    };
    let length: i64 = row.get(9).map_err(read_sql)?;
    let authority: ServerDerivedLiveUpdateAuthority = serde_json::from_value(serde_json::json!({"principalKind":row.get::<_,String>(12).map_err(read_sql)?,"principalId":row.get::<_,String>(13).map_err(read_sql)?,"grantId":row.get::<_,Option<String>>(14).map_err(read_sql)?,"grantGeneration":row.get::<_,Option<i64>>(15).map_err(read_sql)?})).map_err(|_| ApplicationError::Corrupt)?;
    let received_at_ms = row.get(16).map_err(read_sql)?;
    let count: i64 = row.get(17).map_err(read_sql)?;
    let sequence: i64 = row.get(18).map_err(read_sql)?;
    let coordinate = ApplicationHostCoordinate {
        host_id: row.get(19).map_err(read_sql)?,
        host_epoch: row.get(20).map_err(read_sql)?,
        instance_id: row.get(21).map_err(read_sql)?,
        connection_id: row.get(22).map_err(read_sql)?,
    };
    if rows.next().map_err(read_sql)?.is_some() {
        return Err(ApplicationError::Conflict);
    }
    let first_seen = read_ranges(conn, namespace, &workspace, &delivery_id, count)?;
    let update_bytes =
        get_binary_blob(conn, &receipt.update_digest)?.ok_or(ApplicationError::Corrupt)?;
    if i64::try_from(update_bytes.len()).ok() != Some(length) {
        return Err(ApplicationError::Corrupt);
    }
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt,
                binding,
                authority,
                received_at_ms,
            },
            first_seen,
        },
        update_bytes,
    };
    event.validate().map_err(|_| ApplicationError::Corrupt)?;
    coordinate
        .validate()
        .map_err(|_| ApplicationError::Corrupt)?;
    integer(sequence, 1, SAFE).map_err(|_| ApplicationError::Corrupt)?;
    Ok(Some(ApplicationRecord {
        event,
        sequence,
        coordinate,
    }))
}

fn read_ranges(
    conn: &Connection,
    namespace: &str,
    workspace: &str,
    delivery: &str,
    count: i64,
) -> Result<Vec<LiveUpdateStructRange>, ApplicationError> {
    integer(count, 0, SAFE).map_err(|_| ApplicationError::Corrupt)?;
    let mut query = conn.prepare("SELECT ordinal,client_id,start_clock,end_clock,workspace_id FROM live_device_application_first_seen WHERE relay_database_namespace=?1 AND delivery_id=?2 ORDER BY ordinal").map_err(read_sql)?;
    let mut rows = query
        .query(params![namespace, delivery])
        .map_err(read_sql)?;
    let mut ranges = Vec::new();
    while let Some(row) = rows.next().map_err(read_sql)? {
        let ordinal: i64 = row.get(0).map_err(read_sql)?;
        if row.get::<_, String>(4).map_err(read_sql)? != workspace
            || usize::try_from(ordinal).ok() != Some(ranges.len())
        {
            return Err(ApplicationError::Corrupt);
        }
        ranges.push(LiveUpdateStructRange {
            client_id: row.get(1).map_err(read_sql)?,
            start_clock: row.get(2).map_err(read_sql)?,
            end_clock: row.get(3).map_err(read_sql)?,
        });
    }
    if i64::try_from(ranges.len()).ok() != Some(count) {
        return Err(ApplicationError::Corrupt);
    }
    canonical_ranges(&ranges).map_err(|_| ApplicationError::Corrupt)?;
    Ok(ranges)
}

fn check_provenance(
    conn: &Connection,
    namespace: &str,
    event: &AdmittedLiveUpdate,
) -> Result<(), ApplicationError> {
    let b = &event.metadata.accepted.binding;
    // Join by the namespace-wide delivery identity, then check the child's raw
    // workspace. A damaged child must not disappear behind a workspace filter.
    let mut query = conn.prepare("SELECT a.delivery_id,a.first_seen_count,f.workspace_id,f.ordinal,f.client_id,f.start_clock,f.end_clock FROM live_device_update_applications a LEFT JOIN live_device_application_first_seen f ON f.relay_database_namespace=a.relay_database_namespace AND f.delivery_id=a.delivery_id WHERE a.relay_database_namespace=?1 AND a.workspace_id=?2 AND a.main_version_id=?3 AND a.object_id=?4 AND a.lineage_claim_id=?5 ORDER BY f.client_id,f.start_clock,a.delivery_id,f.ordinal").map_err(read_sql)?;
    let mut rows = query
        .query(params![
            namespace,
            b.workspace_id,
            b.main_version_id,
            b.object_id,
            b.lineage_claim_id
        ])
        .map_err(read_sql)?;
    let mut parents =
        std::collections::HashMap::<String, (i64, i64, Option<LiveUpdateStructRange>)>::new();
    let mut previous: Option<LiveUpdateStructRange> = None;
    let mut candidates = event.metadata.first_seen.iter().peekable();
    let mut conflict = false;
    while let Some(row) = rows.next().map_err(read_sql)? {
        let delivery: String = row.get(0).map_err(read_sql)?;
        let count: i64 = row.get(1).map_err(read_sql)?;
        integer(count, 0, SAFE).map_err(|_| ApplicationError::Corrupt)?;
        let parent = parents.entry(delivery).or_insert((count, 0, None));
        let Some(workspace) = row.get::<_, Option<String>>(2).map_err(read_sql)? else {
            if count != 0 {
                return Err(ApplicationError::Corrupt);
            }
            continue;
        };
        let ordinal: i64 = row.get(3).map_err(read_sql)?;
        let range = LiveUpdateStructRange {
            client_id: row.get(4).map_err(read_sql)?,
            start_clock: row.get(5).map_err(read_sql)?,
            end_clock: row.get(6).map_err(read_sql)?,
        };
        range.validate().map_err(|_| ApplicationError::Corrupt)?;
        if workspace != b.workspace_id
            || ordinal != parent.1
            || parent.1 >= count
            || parent.2.as_ref().is_some_and(|prev| {
                prev.client_id == range.client_id && range.start_clock <= prev.end_clock
            })
            || previous.as_ref().is_some_and(|prev| {
                prev.client_id == range.client_id && range.start_clock < prev.end_clock
            })
        {
            return Err(ApplicationError::Corrupt);
        }
        parent.1 += 1;
        parent.2 = Some(range.clone());
        while candidates.peek().is_some_and(|candidate| {
            candidate.client_id < range.client_id
                || (candidate.client_id == range.client_id
                    && candidate.end_clock <= range.start_clock)
        }) {
            candidates.next();
        }
        conflict |= candidates.peek().is_some_and(|candidate| {
            candidate.client_id == range.client_id && candidate.start_clock < range.end_clock
        });
        previous = Some(range);
    }
    if parents.values().any(|(count, seen, _)| count != seen) {
        return Err(ApplicationError::Corrupt);
    }
    if conflict {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

fn insert_application(
    tx: &Transaction<'_>,
    r: &Registration,
    event: &AdmittedLiveUpdate,
    sequence: i64,
) -> Result<(), ApplicationError> {
    let a = &event.metadata.accepted;
    let b = &a.binding;
    let c = &r.coordinate;
    let (kind, principal, grant, generation) = a.authority.fields();
    tx.execute("INSERT INTO live_device_update_applications (relay_database_namespace,workspace_id,delivery_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,update_digest,update_byte_length,journal_cursor,accepting_host_epoch,principal_kind,principal_id,grant_id,grant_generation,received_at_ms,first_seen_count,local_ydoc_sequence,applied_host_id,applied_host_epoch,applied_instance_id,applied_connection_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)",
        params![r.namespace,b.workspace_id,a.receipt.delivery_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.current_path,serde_json::to_string(&b.selector_paths).map_err(|_| invalid("selector JSON"))?,b.restore_fence_generation,a.receipt.update_digest,event.update_bytes.len() as i64,a.receipt.journal_cursor,a.receipt.accepting_host_epoch,kind,principal,grant,generation,a.received_at_ms,event.metadata.first_seen.len() as i64,sequence,c.host_id,c.host_epoch,c.instance_id,c.connection_id]).map_err(write_sql)?;
    for (ordinal, range) in event.metadata.first_seen.iter().enumerate() {
        tx.execute("INSERT INTO live_device_application_first_seen (relay_database_namespace,workspace_id,delivery_id,ordinal,client_id,start_clock,end_clock) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![r.namespace,b.workspace_id,a.receipt.delivery_id,ordinal as i64,range.client_id,range.start_clock,range.end_clock]).map_err(write_sql)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ContentKind, Ydoc};
    use dohc_engine_storage::put_binary_blob_with_sha;
    use dohc_test_scratch::ScratchDir;

    #[cfg(feature = "fault-injection")]
    struct Crash(dohc_engine_storage::FaultPoint);
    #[cfg(feature = "fault-injection")]
    impl FaultInjector for Crash {
        fn poll(&self, point: dohc_engine_storage::FaultPoint) -> dohc_engine_storage::FaultAction {
            if point == self.0 {
                dohc_engine_storage::FaultAction::Crash
            } else {
                dohc_engine_storage::FaultAction::Continue
            }
        }
    }

    fn shared_parser(name: &str, mut input: Value) -> Result<Value, ApplicationError> {
        normalize_json_integers(&mut input);
        let output = match name {
            "parseAdmittedLiveUpdateMetadata" => {
                serde_json::to_value(parse_admitted_metadata(input)?)
            }
            "parseLiveUpdateHostApplicationAck" => {
                serde_json::to_value(parse_application_ack(input)?)
            }
            "parseLiveUpdateReceipt" => {
                let receipt: LiveUpdateReceipt =
                    serde_json::from_value(input).map_err(|_| invalid("receipt shape"))?;
                receipt.validate()?;
                serde_json::to_value(receipt)
            }
            "parseServerDerivedLiveUpdateAuthority" => {
                let authority: ServerDerivedLiveUpdateAuthority =
                    serde_json::from_value(input).map_err(|_| invalid("authority shape"))?;
                authority.validate()?;
                serde_json::to_value(authority)
            }
            "parseLiveUpdateStructRange" => {
                let range: LiveUpdateStructRange =
                    serde_json::from_value(input).map_err(|_| invalid("range shape"))?;
                range.validate()?;
                serde_json::to_value(range)
            }
            "parseRelayAcceptedLiveUpdate" => {
                let metadata =
                    parse_admitted_metadata(serde_json::json!({"accepted":input,"firstSeen":[]}))?;
                serde_json::to_value(metadata.accepted)
            }
            _ => panic!("unexpected selected parser: {name}"),
        };
        output.map_err(|_| invalid("serialize shared result"))
    }

    #[test]
    fn shared_typescript_vectors_cover_application_contracts_and_raw_integrity() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/live-session-contract/vectors/live-update-admission-vectors.json"
        ))
        .unwrap();
        let selected = [
            "parseAdmittedLiveUpdateMetadata",
            "parseLiveUpdateHostApplicationAck",
            "parseLiveUpdateReceipt",
            "parseServerDerivedLiveUpdateAuthority",
            "parseLiveUpdateStructRange",
            "parseRelayAcceptedLiveUpdate",
        ];
        let mut counts = std::collections::BTreeMap::new();
        for section in ["accepted", "refused"] {
            for row in vectors[section].as_array().unwrap() {
                let parser = row["parser"].as_str().unwrap();
                if !selected.contains(&parser) {
                    continue;
                }
                *counts.entry(parser).or_insert(0) += 1;
                let result = shared_parser(parser, row["input"].clone());
                if section == "accepted" {
                    assert_eq!(result.unwrap(), row["expected"], "{}", row["case"]);
                } else {
                    assert!(result.is_err(), "{}", row["case"]);
                }
            }
        }
        for parser in selected {
            assert!(
                counts.get(parser).copied().unwrap_or(0) > 0,
                "unexercised {parser}"
            );
        }
        for row in vectors["jsonNumbers"].as_array().unwrap() {
            let input = serde_json::from_str(row["json"].as_str().unwrap()).unwrap();
            assert_eq!(
                shared_parser(row["parser"].as_str().unwrap(), input).unwrap(),
                row["expected"]
            );
        }
        for row in vectors["applicationBytes"].as_array().unwrap() {
            let bytes: Vec<u8> = serde_json::from_value(row["bytes"].clone()).unwrap();
            let parsed =
                parse_admitted_metadata(row["metadata"].clone()).is_ok() && !bytes.is_empty();
            assert_eq!(
                parsed,
                row["parserAccepted"].as_bool().unwrap(),
                "{}",
                row["case"]
            );
            let committed =
                AdmittedLiveUpdate::from_committed_metadata(row["metadata"].clone(), bytes);
            assert_eq!(
                committed.is_ok(),
                row["committedValid"].as_bool().unwrap(),
                "{}",
                row["case"]
            );
        }
    }

    fn binding() -> LiveObjectBinding {
        LiveObjectBinding {
            workspace_id: "workspace-1".into(),
            main_version_id: "main".into(),
            object_id: "object-1".into(),
            lineage_claim_id: hex_sha256(&Ydoc::wire().encode_full_state()),
            current_path: "notes/a.md".into(),
            selector_paths: vec!["notes/a.md".into()],
            restore_fence_generation: 7,
        }
    }
    fn coordinate(connection: &str) -> ApplicationHostCoordinate {
        ApplicationHostCoordinate {
            host_id: "host-1".into(),
            host_epoch: 2,
            instance_id: "instance-1".into(),
            connection_id: connection.into(),
        }
    }
    fn key() -> DocKey {
        DocKey::new("workspace-1", "main", "object-1").unwrap()
    }
    fn fixture() -> (
        ScratchDir,
        EngineStore,
        WriterDocCache,
        ApplicationOwner,
        ApplicationHandle,
    ) {
        let dir = ScratchDir::new_named("live-device-application").unwrap();
        let mut store = EngineStore::open(&dir.join("engine.db"), 0).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace-1", "main", 0, &NoFaults)
            .unwrap();
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('workspace-1','object-1',0)",[]).unwrap();
            Ok::<_,StorageError>(())
        }).unwrap();
        durable::ensure_marker(
            &mut store,
            &key(),
            ContentKind::Plaintext,
            Regime::Replicated,
            &NoFaults,
            0,
        )
        .unwrap();
        store.write_with(&NoFaults, |tx| {
            put_binary_blob_with_sha(tx,&Ydoc::wire().encode_full_state(),&binding().lineage_claim_id).unwrap();
            tx.execute("UPDATE ydoc_docs SET lineage_claim_id=?1,lineage_claim_status='exact',path='notes/a.md'",[binding().lineage_claim_id]).unwrap();
            Ok::<_,StorageError>(())
        }).unwrap();
        let mut owner = ApplicationOwner::new("workspace-1".into()).unwrap();
        let handle = owner
            .register(
                &mut store,
                "relay-A".into(),
                coordinate("connection-1"),
                binding(),
            )
            .unwrap();
        (dir, store, WriterDocCache::new(), owner, handle)
    }
    fn event(delivery: &str, cursor: i64, bytes: Vec<u8>) -> AdmittedLiveUpdate {
        AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: LiveUpdateReceipt {
                        delivery_id: delivery.into(),
                        update_digest: hex_sha256(&bytes),
                        journal_cursor: cursor,
                        accepting_host_epoch: 1,
                    },
                    binding: binding(),
                    authority: ServerDerivedLiveUpdateAuthority::Owner {
                        principal_id: "owner-1".into(),
                    },
                    received_at_ms: 10,
                },
                first_seen: Vec::new(),
            },
            update_bytes: bytes,
        }
    }
    fn apply(
        store: &mut EngineStore,
        cache: &mut WriterDocCache,
        handle: &ApplicationHandle,
        event: AdmittedLiveUpdate,
    ) -> ApplicationResult {
        apply_committed(store, cache, handle, event, &NoFaults).unwrap()
    }
    fn ack(result: ApplicationResult) -> LiveUpdateHostApplicationAck {
        match result {
            ApplicationResult::Applied(ack) => ack,
            other => panic!("expected applied: {other:?}"),
        }
    }
    fn count(store: &EngineStore, table: &str) -> i64 {
        store
            .read_with(|conn| {
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
            })
            .unwrap()
    }
    fn document(store: &EngineStore) -> Ydoc {
        store
            .read_with(|conn| durable::load_doc_in(conn, &key()))
            .unwrap()
    }
    fn reopen(store: EngineStore, dir: &ScratchDir) -> EngineStore {
        drop(store);
        EngineStore::open(&dir.join("engine.db"), 20).unwrap()
    }

    fn warm_cache(store: &mut EngineStore, cache: &mut WriterDocCache) {
        durable::record_local_update(
            store,
            cache,
            &key(),
            &Ydoc::wire().plaintext_insert(0, "warm"),
            durable::LocalAppend::default(),
            &NoFaults,
            1,
            |_, _, _| Ok(()),
        )
        .unwrap();
        assert!(store
            .read_with(|conn| cache
                .doc_for_consumer(conn, &key())
                .map(|doc| doc.is_some()))
            .unwrap());
    }

    #[test]
    fn application_compacts_at_threshold_and_retries_overdue_fold_with_old_bytes() {
        for fail_fold in [false, true] {
            let (dir, mut store, mut cache, _owner, handle) = fixture();
            let source = Ydoc::wire();
            let mut deliveries = Vec::new();
            for cursor in 1..=64 {
                let update = event(
                    &format!("delivery-{cursor}"),
                    cursor,
                    source.plaintext_insert(cursor as u32 - 1, "x"),
                );
                if cursor == 64 {
                    assert_eq!(count(&store, "ydoc_updates"), 63);
                    if fail_fold {
                        store.write_with(&NoFaults, |tx| {
                            tx.execute_batch("CREATE TRIGGER refuse_fold BEFORE INSERT ON ydoc_snapshots WHEN NEW.up_to_seq>0 BEGIN SELECT RAISE(ABORT, 'fold failure'); END;").unwrap();
                            Ok::<_, StorageError>(())
                        }).unwrap();
                    }
                }
                let result =
                    apply_committed(&mut store, &mut cache, &handle, update.clone(), &NoFaults);
                if cursor == 64 && fail_fold {
                    assert!(matches!(result, Err(ApplicationError::Collab(_))));
                } else {
                    assert_eq!(ack(result.unwrap()).local_ydoc_sequence, cursor);
                }
                deliveries.push(update);
            }
            assert_eq!(
                count(&store, "ydoc_updates"),
                if fail_fold { 64 } else { 0 }
            );
            assert_eq!(count(&store, "live_device_update_applications"), 64);
            let replay = ack(apply(
                &mut store,
                &mut cache,
                &handle,
                deliveries[63].clone(),
            ));
            assert!(replay.application_replayed);
            assert_eq!(replay.local_ydoc_sequence, 64);
            if fail_fold {
                assert_eq!(count(&store, "ydoc_updates"), 64);
                store
                    .write_with(&NoFaults, |tx| {
                        tx.execute_batch("DROP TRIGGER refuse_fold").unwrap();
                        Ok::<_, StorageError>(())
                    })
                    .unwrap();
                let mut old_bytes = deliveries[0].clone();
                old_bytes.metadata.accepted.receipt.delivery_id = "delivery-65".into();
                old_bytes.metadata.accepted.receipt.journal_cursor = 65;
                let applied = ack(apply(&mut store, &mut cache, &handle, old_bytes));
                assert!(!applied.application_replayed);
                assert_eq!(applied.local_ydoc_sequence, 1);
                assert_eq!(count(&store, "ydoc_updates"), 0);
                assert_eq!(count(&store, "live_device_update_applications"), 65);
            }
            store = reopen(store, &dir);
            assert!(crate::replay_parity::structurally_equal_v2_for_test(
                &document(&store),
                &source
            )
            .unwrap());
            for (index, update) in deliveries.into_iter().enumerate() {
                let replay = ack(apply(&mut store, &mut cache, &handle, update));
                assert!(replay.application_replayed);
                assert_eq!(replay.local_ydoc_sequence, index as i64 + 1);
            }
        }
    }

    #[test]
    fn pending_rollback_evicts_a_real_warm_cache_without_changing_durable_state() {
        let (dir, mut store, mut cache, _owner, handle) = fixture();
        warm_cache(&mut store, &mut cache);
        let before = document(&store).encode_full_state();
        let producer = Ydoc::wire();
        producer.plaintext_insert(0, "predecessor");
        let update = event("pending", 1, producer.plaintext_insert(11, "dependent"));
        assert_eq!(
            apply(&mut store, &mut cache, &handle, update),
            ApplicationResult::Pending(ApplicationPending::DependenciesUnresolved)
        );
        assert!(store
            .read_with(|conn| cache
                .doc_for_consumer(conn, &key())
                .map(|doc| doc.is_none()))
            .unwrap());
        assert_eq!(count(&store, "ydoc_updates"), 1);
        store = reopen(store, &dir);
        assert_eq!(document(&store).encode_full_state(), before);
        assert_eq!(count(&store, "live_device_update_applications"), 0);
    }

    #[test]
    fn multiple_documents_survive_registration_and_share_connection_invalidation() {
        let (_dir, mut store, mut cache, mut owner, first_handle) = fixture();
        let second_key = DocKey::new("workspace-1", "main", "object-2").unwrap();
        let mut second_binding = binding();
        second_binding.object_id = "object-2".into();
        second_binding.current_path = "notes/b.md".into();
        second_binding.selector_paths = vec!["notes/b.md".into()];
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('workspace-1','object-2',0)", []).unwrap();
            Ok::<_, StorageError>(())
        }).unwrap();
        durable::ensure_marker(
            &mut store,
            &second_key,
            ContentKind::Plaintext,
            Regime::Replicated,
            &NoFaults,
            0,
        )
        .unwrap();
        store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET lineage_claim_id=?1,lineage_claim_status='exact',path='notes/b.md' WHERE object_id='object-2'", [binding().lineage_claim_id]).unwrap();
            Ok::<_, StorageError>(())
        }).unwrap();
        let second_handle = owner
            .register(
                &mut store,
                "relay-A".into(),
                coordinate("connection-1"),
                second_binding.clone(),
            )
            .unwrap();
        let first = event("doc-1", 1, Ydoc::wire().plaintext_insert(0, "first"));
        let mut second = event("doc-2", 2, Ydoc::wire().plaintext_insert(0, "second"));
        second.metadata.accepted.binding = second_binding;
        ack(apply(&mut store, &mut cache, &first_handle, first.clone()));
        ack(apply(
            &mut store,
            &mut cache,
            &second_handle,
            second.clone(),
        ));
        let replaced = owner
            .register(
                &mut store,
                "relay-A".into(),
                coordinate("connection-1"),
                binding(),
            )
            .unwrap();
        assert_eq!(
            apply(&mut store, &mut cache, &first_handle, first.clone()),
            ApplicationResult::Pending(ApplicationPending::ApplicabilityUnavailable)
        );
        assert!(
            ack(apply(
                &mut store,
                &mut cache,
                &second_handle,
                second.clone()
            ))
            .application_replayed
        );
        let reconnected = owner
            .register(
                &mut store,
                "relay-A".into(),
                coordinate("connection-2"),
                binding(),
            )
            .unwrap();
        for (handle, update) in [(&replaced, first.clone()), (&second_handle, second)] {
            assert_eq!(
                apply(&mut store, &mut cache, handle, update),
                ApplicationResult::Pending(ApplicationPending::ApplicabilityUnavailable)
            );
        }
        assert!(ack(apply(&mut store, &mut cache, &reconnected, first)).application_replayed);
    }

    #[test]
    fn populated_verified_backup_restores_application_fragments_and_compacted_replay() {
        use dohc_engine_storage::backup::{create_verified_backup, BackupOutcome, FreeSpaceProbe};
        struct Space;
        impl FreeSpaceProbe for Space {
            fn available_bytes(&self, _: &std::path::Path) -> Result<u64, StorageError> {
                Ok(u64::MAX)
            }
        }
        let (dir, mut store, mut cache, _owner, handle) = fixture();
        let mut update = event("backup", 1, Ydoc::wire().plaintext_insert(0, "durable"));
        update.metadata.first_seen = vec![LiveUpdateStructRange {
            client_id: 17,
            start_clock: 0,
            end_clock: 7,
        }];
        update.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Named {
            principal_id: "person".into(),
            grant_id: "grant".into(),
            grant_generation: 3,
        };
        let first = ack(apply(&mut store, &mut cache, &handle, update.clone()));
        let mut other_owner = ApplicationOwner::new("workspace-1".into()).unwrap();
        let other_handle = other_owner
            .register(&mut store, "relay-B".into(), coordinate("other"), binding())
            .unwrap();
        ack(apply(&mut store, &mut cache, &other_handle, update.clone()));
        durable::maybe_compact(&mut store, &key(), 0, &NoFaults, 30).unwrap();
        let BackupOutcome::Verified(record) = create_verified_backup(
            &store,
            &dir.join("recovery"),
            "populated",
            "test",
            40,
            &Space,
            &NoFaults,
        )
        .unwrap() else {
            panic!("backup interrupted");
        };
        let mut restored = EngineStore::open(&record.backup_path, 50).unwrap();
        for table in [
            "live_device_application_bindings",
            "live_device_update_applications",
            "live_device_application_first_seen",
        ] {
            assert_eq!(count(&restored, table), 2);
        }
        assert_eq!(count(&restored, "ydoc_updates"), 0);
        assert_eq!(
            document(&restored).encode_full_state(),
            document(&store).encode_full_state()
        );
        let mut restored_owner = ApplicationOwner::new("workspace-1".into()).unwrap();
        let restored_handle = restored_owner
            .register(
                &mut restored,
                "relay-A".into(),
                coordinate("restored"),
                binding(),
            )
            .unwrap();
        let replay = ack(apply(
            &mut restored,
            &mut WriterDocCache::new(),
            &restored_handle,
            update.clone(),
        ));
        assert!(replay.application_replayed);
        assert_eq!(replay.local_ydoc_sequence, first.local_ydoc_sequence);
        let restored_other = restored_owner
            .register(
                &mut restored,
                "relay-B".into(),
                coordinate("restored-other"),
                binding(),
            )
            .unwrap();
        assert!(
            ack(apply(
                &mut restored,
                &mut WriterDocCache::new(),
                &restored_other,
                update
            ))
            .application_replayed
        );
    }

    #[test]
    fn integrated_apply_reopen_exact_replay_and_content_dedupe_have_distinct_audits() {
        let (dir, mut store, mut cache, _owner, handle) = fixture();
        let producer = Ydoc::wire();
        let bytes = producer.plaintext_insert(0, "hello");
        let first = event("delivery-1", 1, bytes.clone());
        let initial = ack(apply(&mut store, &mut cache, &handle, first.clone()));
        assert!(!initial.application_replayed);
        assert!(!document(&store).has_missing_updates());
        store = reopen(store, &dir);
        let replay = ack(apply(&mut store, &mut cache, &handle, first.clone()));
        assert!(replay.application_replayed);
        assert_eq!(replay.local_ydoc_sequence, initial.local_ydoc_sequence);
        assert_eq!(replay.accepting_host_epoch, 1);
        let second = ack(apply(
            &mut store,
            &mut cache,
            &handle,
            event("delivery-2", 2, bytes),
        ));
        assert!(!second.application_replayed);
        assert_eq!(second.local_ydoc_sequence, initial.local_ydoc_sequence);
        assert_eq!(count(&store, "live_device_update_applications"), 2);
        assert_eq!(count(&store, "owner_ydoc_outbox_entries"), 0);
        durable::maybe_compact(&mut store, &key(), 0, &NoFaults, 30).unwrap();
        store = reopen(store, &dir);
        assert_eq!(count(&store, "ydoc_updates"), 0);
        assert_eq!(
            ack(apply(&mut store, &mut cache, &handle, first)).local_ydoc_sequence,
            initial.local_ydoc_sequence
        );
    }

    #[test]
    fn missing_insert_and_delete_roll_back_fresh_and_parked_deduped_attempts() {
        for delete in [false, true] {
            for parked in [false, true] {
                let (dir, mut store, mut cache, _owner, handle) = fixture();
                let producer = Ydoc::wire();
                let predecessor = producer.plaintext_insert(0, "x");
                let candidate = if delete {
                    producer.plaintext_delete(0, 1)
                } else {
                    producer.plaintext_insert(1, "y")
                };
                let witness = Ydoc::wire();
                witness.apply(&candidate).unwrap();
                assert!(witness.has_missing_updates());
                if delete {
                    assert!(witness.pending_update_v1().is_none());
                    assert!(witness.pending_delete_set().is_some());
                }
                if parked {
                    store
                        .write_with(&NoFaults, |tx| {
                            durable::record_update_in_tx(tx, &key(), &candidate, None, None, 1)
                        })
                        .unwrap();
                    store = reopen(store, &dir);
                    assert!(document(&store).has_missing_updates());
                    store
                        .write_with(&NoFaults, |tx| {
                            let outcome = durable::record_update_in_tx(
                                tx,
                                &key(),
                                &candidate,
                                None,
                                None,
                                2,
                            )?;
                            assert!(outcome.deduped);
                            Ok::<_, CollabError>(())
                        })
                        .unwrap();
                }
                warm_cache(&mut store, &mut cache);
                producer
                    .apply(&document(&store).encode_full_state())
                    .unwrap();
                let before = count(&store, "ydoc_updates");
                let update = event("dependent", 2, candidate);
                assert_eq!(
                    apply(&mut store, &mut cache, &handle, update.clone()),
                    ApplicationResult::Pending(ApplicationPending::DependenciesUnresolved)
                );
                assert!(store
                    .read_with(|conn| cache
                        .doc_for_consumer(conn, &key())
                        .map(|doc| doc.is_none()))
                    .unwrap());
                store = reopen(store, &dir);
                assert_eq!(count(&store, "ydoc_updates"), before);
                assert_eq!(count(&store, "live_device_update_applications"), 0);
                assert_eq!(count(&store, "live_device_application_first_seen"), 0);
                ack(apply(
                    &mut store,
                    &mut cache,
                    &handle,
                    event("predecessor", 1, predecessor),
                ));
                #[cfg(feature = "fault-injection")]
                {
                    warm_cache(&mut store, &mut cache);
                    producer
                        .apply(&document(&store).encode_full_state())
                        .unwrap();
                    assert!(matches!(
                        apply_committed(
                            &mut store,
                            &mut cache,
                            &handle,
                            update.clone(),
                            &Crash(dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck)
                        ),
                        Err(ApplicationError::Interrupted)
                    ));
                    assert!(store
                        .read_with(|conn| cache
                            .doc_for_consumer(conn, &key())
                            .map(|doc| doc.is_none()))
                        .unwrap());
                    store = reopen(store, &dir);
                    let persisted_sequence = store
                        .read_with(|conn| {
                            read_application(conn, "relay-A", &update.metadata.accepted.receipt)
                        })
                        .unwrap()
                        .unwrap()
                        .sequence;
                    assert_eq!(count(&store, "live_device_update_applications"), 2);
                    let result = ack(apply(&mut store, &mut cache, &handle, update.clone()));
                    assert!(result.application_replayed);
                    assert_eq!(result.local_ydoc_sequence, persisted_sequence);
                }
                #[cfg(not(feature = "fault-injection"))]
                {
                    let result = ack(apply(&mut store, &mut cache, &handle, update.clone()));
                    assert!(!result.application_replayed);
                }
                assert!(!document(&store).has_missing_updates());
                assert!(
                    crate::replay_parity::structurally_equal_v2(&document(&store), &producer)
                        .unwrap()
                );
                assert!(ack(apply(&mut store, &mut cache, &handle, update)).application_replayed);
                assert_eq!(count(&store, "live_device_update_applications"), 2);
            }
        }
    }

    #[test]
    fn workspace_and_actual_main_and_owner_lifetimes_precede_replay() {
        let (_dir, mut store, mut cache, mut owner, handle) = fixture();
        let update = event("delivery", 1, Ydoc::wire().plaintext_insert(0, "x"));
        ack(apply(&mut store, &mut cache, &handle, update.clone()));
        let mut wrong = update.clone();
        wrong.metadata.accepted.binding.workspace_id = "foreign".into();
        assert!(matches!(
            apply_committed(&mut store, &mut cache, &handle, wrong, &NoFaults),
            Err(ApplicationError::WorkspaceMismatch)
        ));
        let replacement = owner
            .register(
                &mut store,
                "relay-A".into(),
                coordinate("connection-2"),
                binding(),
            )
            .unwrap();
        assert_eq!(
            apply(&mut store, &mut cache, &handle, update.clone()),
            ApplicationResult::Pending(ApplicationPending::ApplicabilityUnavailable)
        );
        assert!(
            ack(apply(&mut store, &mut cache, &replacement, update.clone())).application_replayed
        );
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE versioned_workspaces SET main_version_id='actual-main'",
                    [],
                )
                .unwrap();
                Ok::<_, StorageError>(())
            })
            .unwrap();
        assert!(matches!(
            apply_committed(
                &mut store,
                &mut cache,
                &replacement,
                update.clone(),
                &NoFaults
            ),
            Err(ApplicationError::MainVersionMismatch)
        ));
        drop(owner);
        assert_eq!(
            apply(&mut store, &mut cache, &replacement, update),
            ApplicationResult::Pending(ApplicationPending::ApplicabilityUnavailable)
        );
    }

    #[test]
    fn relay_namespaces_isolate_delivery_cursor_and_fragment_identity() {
        let (_dir, mut store, mut cache, _owner, handle) = fixture();
        let mut update = event("same-delivery", 1, Ydoc::wire().plaintext_insert(0, "x"));
        update.metadata.first_seen = vec![LiveUpdateStructRange {
            client_id: 5,
            start_clock: 0,
            end_clock: 1,
        }];
        ack(apply(&mut store, &mut cache, &handle, update.clone()));
        let mut other = ApplicationOwner::new("workspace-1".into()).unwrap();
        let other_handle = other
            .register(&mut store, "relay-B".into(), coordinate("B"), binding())
            .unwrap();
        assert!(
            !ack(apply(&mut store, &mut cache, &other_handle, update.clone())).application_replayed
        );
        assert_eq!(count(&store, "live_device_update_applications"), 2);
        assert_eq!(count(&store, "live_device_application_first_seen"), 2);
        let mut collision = update.clone();
        collision.metadata.accepted.receipt.delivery_id = "different".into();
        assert!(matches!(
            apply_committed(&mut store, &mut cache, &handle, collision, &NoFaults),
            Err(ApplicationError::Conflict)
        ));
        store.write_with(&NoFaults, |tx| {
            assert!(tx.execute("INSERT INTO live_device_application_first_seen VALUES ('relay-C','workspace-1','same-delivery',0,5,0,1)",[]).is_err());
            Ok::<_,StorageError>(())
        }).unwrap();
        assert!(ack(apply(&mut store, &mut cache, &other_handle, update)).application_replayed);
    }

    #[test]
    fn provenance_stream_checks_interleaved_parents_and_raw_fragment_damage() {
        for damage in [
            "UPDATE live_device_update_applications SET first_seen_count=3 WHERE delivery_id='first'",
            "DELETE FROM live_device_application_first_seen WHERE delivery_id='first' AND ordinal=1",
            "UPDATE live_device_application_first_seen SET ordinal=9 WHERE delivery_id='first' AND ordinal=1",
            "UPDATE live_device_application_first_seen SET start_clock=0 WHERE delivery_id='second' AND client_id=2",
            "UPDATE live_device_application_first_seen SET client_id=2,start_clock=1,end_clock=2 WHERE delivery_id='first' AND ordinal=1",
            "UPDATE live_device_application_first_seen SET workspace_id='damaged' WHERE delivery_id='first'",
            "INSERT INTO live_device_application_first_seen VALUES ('relay-A','workspace-1','first',2,7,0,1)",
        ] {
            let (_dir, mut store, mut cache, _owner, handle) = fixture();
            let mut first = event("first", 1, vec![0, 0]);
            first.metadata.first_seen = vec![LiveUpdateStructRange { client_id: 2, start_clock: 0, end_clock: 1 }, LiveUpdateStructRange { client_id: 4, start_clock: 0, end_clock: 1 }];
            let mut second = event("second", 2, vec![0, 0]);
            second.metadata.first_seen = vec![LiveUpdateStructRange { client_id: 2, start_clock: 1, end_clock: 2 }, LiveUpdateStructRange { client_id: 3, start_clock: 0, end_clock: 1 }];
            ack(apply(&mut store, &mut cache, &handle, first.clone()));
            ack(apply(&mut store, &mut cache, &handle, second));
            let mut conflict = event("conflict", 3, vec![0, 0]);
            conflict.metadata.first_seen = vec![LiveUpdateStructRange { client_id: 3, start_clock: 0, end_clock: 1 }];
            assert!(matches!(apply_committed(&mut store, &mut cache, &handle, conflict, &NoFaults), Err(ApplicationError::Conflict)));
            store.read_with(|conn| conn.execute_batch(&format!("PRAGMA foreign_keys=OFF; {damage}; PRAGMA foreign_keys=ON"))).unwrap();
            let before = count(&store, "ydoc_updates");
            assert!(matches!(apply_committed(&mut store, &mut cache, &handle, event("noop", 3, vec![0, 0]), &NoFaults), Err(ApplicationError::Corrupt)), "{damage}");
            assert_eq!(count(&store, "ydoc_updates"), before);
            if damage.contains("workspace_id='damaged'") {
                assert!(matches!(apply_committed(&mut store, &mut cache, &handle, first, &NoFaults), Err(ApplicationError::Corrupt)));
            }
        }
    }

    #[test]
    fn every_immutable_accepted_field_prevents_a_conflicting_replay() {
        let (_dir, mut store, mut cache, _owner, handle) = fixture();
        let mut original = event("immutable", 1, Ydoc::wire().plaintext_insert(0, "x"));
        original.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Named {
            principal_id: "person".into(),
            grant_id: "grant".into(),
            grant_generation: 1,
        };
        ack(apply(&mut store, &mut cache, &handle, original.clone()));
        for (pointer, value) in [
            (
                "/accepted/receipt/deliveryId",
                serde_json::json!("different"),
            ),
            ("/accepted/receipt/journalCursor", serde_json::json!(2)),
            ("/accepted/receipt/acceptingHostEpoch", serde_json::json!(2)),
            (
                "/accepted/binding/workspaceId",
                serde_json::json!("different"),
            ),
            (
                "/accepted/binding/mainVersionId",
                serde_json::json!("different"),
            ),
            ("/accepted/binding/objectId", serde_json::json!("different")),
            (
                "/accepted/binding/lineageClaimId",
                serde_json::json!("different"),
            ),
            (
                "/accepted/binding/currentPath",
                serde_json::json!("notes/b.md"),
            ),
            (
                "/accepted/binding/selectorPaths",
                serde_json::json!(["notes/b.md"]),
            ),
            (
                "/accepted/binding/restoreFenceGeneration",
                serde_json::json!(8),
            ),
            (
                "/accepted/authority/principalKind",
                serde_json::json!("link"),
            ),
            (
                "/accepted/authority/principalId",
                serde_json::json!("different"),
            ),
            (
                "/accepted/authority/grantId",
                serde_json::json!("different"),
            ),
            ("/accepted/authority/grantGeneration", serde_json::json!(2)),
            ("/accepted/receivedAtMs", serde_json::json!(11)),
            (
                "/firstSeen",
                serde_json::json!([{"clientId":1,"startClock":0,"endClock":1}]),
            ),
        ] {
            let mut metadata = serde_json::to_value(&original.metadata).unwrap();
            *metadata.pointer_mut(pointer).unwrap() = value;
            let changed = AdmittedLiveUpdate::from_committed_metadata(
                metadata,
                original.update_bytes.clone(),
            )
            .unwrap();
            assert!(
                !matches!(
                    apply_committed(&mut store, &mut cache, &handle, changed, &NoFaults),
                    Ok(ApplicationResult::Applied(_))
                ),
                "{pointer}"
            );
        }
        let mut changed_bytes = original.clone();
        changed_bytes.update_bytes = vec![0, 0];
        changed_bytes.metadata.accepted.receipt.update_digest =
            hex_sha256(&changed_bytes.update_bytes);
        assert!(matches!(
            apply_committed(&mut store, &mut cache, &handle, changed_bytes, &NoFaults),
            Err(ApplicationError::Conflict)
        ));
        assert_eq!(count(&store, "ydoc_updates"), 1);
        assert_eq!(count(&store, "live_device_update_applications"), 1);
        assert!(ack(apply(&mut store, &mut cache, &handle, original)).application_replayed);
    }

    #[test]
    fn stored_applicability_and_baseline_changes_block_even_exact_replay() {
        for damage in [
            "UPDATE live_device_application_bindings SET available=0",
            "UPDATE live_device_application_bindings SET host_id='other'",
            "UPDATE live_device_application_bindings SET host_epoch=3",
            "UPDATE live_device_application_bindings SET instance_id='other'",
            "UPDATE live_device_application_bindings SET connection_id='other'",
            "UPDATE live_device_application_bindings SET restore_fence_generation=8",
            "UPDATE live_device_application_bindings SET selector_paths_json='[\"notes/a.md\",\"notes/a.md\"]'",
            "UPDATE ydoc_docs SET lineage_claim_status='unclaimed',lineage_claim_id=NULL",
            "UPDATE ydoc_docs SET regime='local-only',lineage_claim_status='unclaimed',lineage_claim_id=NULL",
            "UPDATE ydoc_docs SET path='notes/other.md'",
            "DELETE FROM ydoc_docs",
        ] {
            let (_dir, mut store, mut cache, _owner, handle) = fixture();
            let update = event("stored", 1, vec![0, 0]);
            ack(apply(&mut store, &mut cache, &handle, update.clone()));
            store.write_with(&NoFaults, |tx| { tx.execute_batch(damage).unwrap(); Ok::<_, StorageError>(()) }).unwrap();
            assert!(!matches!(apply_committed(&mut store, &mut cache, &handle, update, &NoFaults), Ok(ApplicationResult::Applied(_))), "{damage}");
            assert_eq!(count(&store, "live_device_update_applications"), 1);
        }
    }

    #[test]
    fn audit_insert_and_fragment_failure_roll_back_the_real_append() {
        for table in [
            "live_device_update_applications",
            "live_device_application_first_seen",
        ] {
            let (dir, mut store, mut cache, _owner, handle) = fixture();
            store.write_with(&NoFaults, |tx| {
                tx.execute_batch(&format!("CREATE TRIGGER reject_application BEFORE INSERT ON {table} BEGIN SELECT RAISE(ABORT,'injected'); END")).unwrap(); Ok::<_,StorageError>(())
            }).unwrap();
            let mut update = event("fail", 1, Ydoc::wire().plaintext_insert(0, "x"));
            update.metadata.first_seen = vec![LiveUpdateStructRange {
                client_id: 1,
                start_clock: 0,
                end_clock: 1,
            }];
            assert!(apply_committed(&mut store, &mut cache, &handle, update, &NoFaults).is_err());
            store = reopen(store, &dir);
            assert_eq!(count(&store, "ydoc_updates"), 0);
            assert_eq!(count(&store, "live_device_update_applications"), 0);
            assert_eq!(count(&store, "live_device_application_first_seen"), 0);
        }
    }

    #[test]
    fn raw_audit_damage_cannot_disappear_through_normalization() {
        for damage in ["UPDATE live_device_update_applications SET selector_paths_json='[\"notes/a.md\",\"notes/a.md\"]'", "UPDATE live_device_update_applications SET first_seen_count=1", "UPDATE live_device_update_applications SET update_byte_length=999", "UPDATE live_device_update_applications SET principal_kind='named',grant_id='g',grant_generation=1"] {
            let (_dir,mut store,mut cache,_owner,handle)=fixture();
            let update=event("stored",1,Ydoc::wire().plaintext_insert(0,"x"));
            ack(apply(&mut store,&mut cache,&handle,update.clone()));
            store.write_with(&NoFaults,|tx| {tx.execute_batch(damage).unwrap();Ok::<_,StorageError>(())}).unwrap();
            assert!(apply_committed(&mut store,&mut cache,&handle,update,&NoFaults).is_err(),"{damage}");
        }
    }

    #[cfg(feature = "fault-injection")]
    #[test]
    fn crash_before_commit_and_after_commit_before_ack_recover_distinctly() {
        use dohc_engine_storage::FaultPoint;
        for point in [
            FaultPoint::StorageBeforePersist,
            FaultPoint::StorageAfterCommitBeforeAck,
        ] {
            let (dir, mut store, mut cache, _owner, handle) = fixture();
            warm_cache(&mut store, &mut cache);
            let update = event("crash", 1, Ydoc::wire().plaintext_insert(0, "x"));
            assert!(matches!(
                apply_committed(
                    &mut store,
                    &mut cache,
                    &handle,
                    update.clone(),
                    &Crash(point)
                ),
                Err(ApplicationError::Interrupted)
            ));
            assert!(store
                .read_with(|conn| cache
                    .doc_for_consumer(conn, &key())
                    .map(|doc| doc.is_none()))
                .unwrap());
            store = reopen(store, &dir);
            let committed = point == FaultPoint::StorageAfterCommitBeforeAck;
            assert_eq!(
                count(&store, "live_device_update_applications"),
                i64::from(committed)
            );
            let result = ack(apply(&mut store, &mut cache, &handle, update));
            assert_eq!(result.application_replayed, committed);
            assert_eq!(count(&store, "live_device_update_applications"), 1);
        }
    }
}
