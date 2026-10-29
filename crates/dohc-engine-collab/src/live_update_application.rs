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
use dohc_engine_domain::AgentDeclaration;
use dohc_engine_storage::{
    get_binary_blob, hex_sha256, EngineStore, FaultInjector, NoFaults, StorageError, TxnOutcome,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::sync::{Arc, Mutex, PoisonError};

const SAFE: i64 = 9_007_199_254_740_991;

mod accepted_history;
mod publication;
pub(crate) use publication::{
    read_native_accepted_cut_in, read_native_accepted_in, read_native_applied_cursor_in,
    read_restore_predecessor_in, require_restore_registration_in,
};
mod ack_read;
pub mod passive;
mod sync;
pub use ack_read::{read_application_ack, LiveApplicationAckIdentity};
pub use sync::{
    read_applied_sync, read_next_applied, AppliedPosition, AppliedSyncCut, AppliedSyncPolicy,
    NextAppliedUpdate,
};
mod activation;
pub use activation::{
    capture_imported_owner_activation, release_imported_owner_activation,
    resume_imported_owner_activation, ImportedOwnerActivation, ImportedOwnerSource,
};
mod adoption;
pub mod owner_activations;
pub use accepted_history::{NativeAcceptedCheckpoint, NativeRestoreHistoryProof};
mod bootstrap;
pub use adoption::{adopt_owner_committed, OwnerAdoptionAck, OwnerAdoptionCut};
mod released_protection;
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub use released_protection::{
    binding_decodes_on_this_thread, lineage_protection_checks_on_this_thread,
    on_released_tail_reader, released_head_loads_on_this_thread,
    released_tail_commitments_on_this_thread, released_tail_scans,
    released_tail_scans_on_this_thread,
};
pub use released_protection::{
    inspect_held, lineage_protection, protection, store_identity, Charged, ContributionArtifact,
    ContributionLocator, HeldInspection, HeldProofAdmission, HeldProofError, HeldProofJob,
    HeldProofLimit, HeldProofRun, HeldProofStop, HeldProofWait, HeldProofs, IncomingCoordinate,
    LineageCoordinates, LineageProtection, PendingValidation, Preservation, PreservationFinding,
    PreservationReason, PreservationStatus, PreservedState, ProofReader, ProofStage, ProofStop,
    ProtectedTail, ProtectedTails, Protection, ProtectionKey, ReleasedLineageBinding,
    ReleasedTails, RetainedAuthors, RetainedContribution, RetainedCoverage, Stop, TailRelease,
    UnprovenCommitment, Validation, ValidationError, Work, HELD_PROOF_CLOSE_BOUND,
    HELD_PROOF_DEADLINE, MAX_PROOF_WAITERS,
};
mod restore_content;
pub(crate) mod restore_fence;
mod restore_resume;
mod retirement;
pub use retirement::{
    begin_retirement, prepare_retirement, reconcile_activation, release_activation,
    CarriedDelivery, JournalEvidence, PreparationKey, PreparationPending, Reconciliation, Release,
    ReleasePending, RetainedPrefix, RetainedPrefixBody, RetirementKey, RetirementPreparations,
    RetirementScope, RetirementTarget,
};
mod settled_base;
pub use settled_base::{
    released_capture, ReleasedCapture, SettledBaseEvidence, RELEASED_CAPTURE_PROOF_BYTES,
};
mod settlement;
pub use bootstrap::{
    bootstrap_committed, BootstrapResult, LiveApplicationBootstrap, LiveApplicationBootstrapAck,
};
pub use restore_content::{
    NativeRestoreApplication, NativeRestoreApplicationReceipt, NativeRestorePoint,
    NativeRestorePreparation, NativeRestoreProposal, NativeRestoreProposalReceipt,
    NativeRestoreSource,
};
pub use restore_fence::require_open as require_restore_open;
pub(crate) use restore_fence::require_registration as require_restore_registration;
pub use restore_fence::{
    current_generation as restore_generation, require_generation as require_restore_generation,
};
pub use restore_fence::{
    NativeRestoreFence, NativeRestoreFenceReceipt, NativeRestoreRefusal,
    NativeRestoreRefusalReason, NativeRestoreSelection, RestoreDeliveryOrigin,
};
pub use restore_resume::{NativeRestoreResume, NativeRestoreResumeReceipt};
pub use settlement::{
    with_retirement_settlement, with_settlement, LiveSettlementAudit,
    LiveSettlementPublicationState, LiveSettlementResult,
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
    /// A hosted replica holds the document, is backfilling it, parked it, or
    /// it left the scope. Unlike [`Conflict`](Self::Conflict), nothing
    /// diverged: it may be ready on a later pull.
    #[error("the hosted replica's document is not ready")]
    HostedDocumentUnready,
    /// The replica holds the document, current through its committed
    /// position, and no Y.Doc of it: nothing live editing could start from
    /// until a device opens it and its base arrives.
    #[error("the live document has no Y.Doc lineage")]
    LiveDocumentWithoutLineage,
    #[error("owner outbox configured budget is below the persisted adoption budget")]
    ConfiguredBudgetMismatch,
    #[error("live application exceeds its configured byte budget")]
    ConfiguredByteBudgetExceeded,
    #[error("live application commit acknowledgement was interrupted")]
    Interrupted,
    /// A read stopped because nobody waits for it any more.
    #[error("the read was cancelled")]
    Cancelled,
    #[error("this document's settlement moments must reach the relay before a restore fence")]
    PublicationPending,
    /// An accepted update still waits on a missing dependency, so the restore
    /// fence cannot yet keep the accepted state a refused seed's copy needs.
    #[error(
        "this document's accepted updates must receive their dependencies before a restore fence"
    )]
    AcceptedStateIncomplete,
    #[error("native restore refused before fencing ({:?})", .0.reason)]
    RestoreRefused(Box<NativeRestoreRefusal>),
    #[error(
        "this document's last settlement must reach its file before its interval can name another author"
    )]
    MaterializationPending,
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Collab(CollabError),
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
    pub fn validate(&self) -> Result<(), ApplicationError> {
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
    /// The person the owner shared with, or the Edit share link, this
    /// authority names; none for the owner.
    fn shared_author(&self) -> Option<dohc_engine_domain::SharedChangeAuthor> {
        match self {
            Self::Owner { .. } => None,
            Self::Named {
                principal_id,
                grant_id,
                grant_generation,
            } => Some(dohc_engine_domain::SharedChangeAuthor::Named {
                user_id: principal_id.clone(),
                grant_id: grant_id.clone(),
                grant_generation: *grant_generation,
            }),
            Self::Link {
                principal_id,
                grant_id,
                grant_generation,
            } => Some(dohc_engine_domain::SharedChangeAuthor::Link {
                grant_id: grant_id.clone(),
                grant_generation: *grant_generation,
                principal_id: principal_id.clone(),
            }),
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
impl RelayAcceptedLiveUpdate {
    /// Validates historical facts; it does not confer current live authority.
    pub fn validate(&self) -> Result<(), ApplicationError> {
        self.receipt.validate()?;
        self.binding.validate_canonical().map_err(invalid)?;
        self.authority.validate()?;
        integer(self.received_at_ms, 0, SAFE)
    }
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
    /// Shared validation for retained arrays and bounded historical readers.
    pub fn validate_after(&self, previous: Option<&Self>) -> Result<(), ApplicationError> {
        self.validate()?;
        if previous.is_some_and(|prev| {
            self.client_id < prev.client_id
                || (self.client_id == prev.client_id && self.start_clock <= prev.end_clock)
        }) {
            return Err(invalid("noncanonical firstSeen"));
        }
        Ok(())
    }

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
pub fn nonnull_optional<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    decoder: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(decoder).map(Some)
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LiveAuthorEntry {
    Unattributed {},
    Automation {
        automation_id: String,
        attribution: dohc_engine_domain::ChangeAttribution,
    },
    Human {
        human_id: String,
        human_name: String,
    },
    Link {
        public_principal_id: String,
        label: String,
    },
    Agent {
        agent_id: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "nonnull_optional"
        )]
        agent_name: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "nonnull_optional"
        )]
        on_behalf_of: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "nonnull_optional"
        )]
        depth: Option<u8>,
    },
}
impl From<AgentDeclaration> for LiveAuthorEntry {
    fn from(declaration: AgentDeclaration) -> Self {
        Self::Agent {
            agent_id: declaration.agent_id,
            agent_name: None,
            on_behalf_of: declaration.on_behalf_of,
            depth: Some(u8::try_from(declaration.depth).unwrap_or(u8::MAX)),
        }
    }
}
impl LiveAuthorEntry {
    pub fn validate(&self) -> Result<(), ApplicationError> {
        match self {
            Self::Unattributed {} => {}
            Self::Automation {
                automation_id,
                attribution,
            } => {
                identifier(automation_id, 512)?;
                if attribution.actor_kind != dohc_engine_domain::ChangeActorKind::Automation {
                    return Err(invalid("invalid automation actor"));
                }
                attribution.validate().map_err(invalid)?;
            }
            Self::Human {
                human_id,
                human_name,
            } => {
                identifier(human_id, 512)?;
                identifier(human_name, 512)?;
            }
            Self::Link {
                public_principal_id,
                label,
            } => {
                identifier(public_principal_id, 512)?;
                identifier(label, 512)?;
            }
            Self::Agent {
                agent_id,
                agent_name,
                on_behalf_of,
                depth,
            } => {
                identifier(agent_id, 512)?;
                if let Some(name) = agent_name {
                    identifier(name, 512)?;
                }
                if let Some(person) = on_behalf_of {
                    identifier(person, 512)?;
                }
                if depth.is_some_and(|depth| depth > 64) {
                    return Err(invalid("invalid agent depth"));
                }
            }
        }
        if serde_json::to_vec(self)
            .map_err(|_| invalid("author JSON"))?
            .len()
            > 4096
        {
            return Err(invalid("author entry exceeds byte bound"));
        }
        Ok(())
    }
    pub fn identity(&self) -> (&'static str, Option<&str>, &str) {
        match self {
            Self::Unattributed {} => ("unattributed", None, ""),
            Self::Automation {
                automation_id,
                attribution,
            } => (
                "automation",
                attribution.run.as_ref().map(|run| run.claim_id.as_str()),
                automation_id,
            ),
            Self::Human { human_id, .. } => ("human", None, human_id),
            Self::Link {
                public_principal_id,
                ..
            } => ("link", None, public_principal_id),
            Self::Agent {
                agent_id,
                on_behalf_of,
                ..
            } => ("agent", on_behalf_of.as_deref(), agent_id),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdmittedLiveUpdateMetadata {
    pub accepted: RelayAcceptedLiveUpdate,
    pub first_seen: Vec<LiveUpdateStructRange>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull_optional"
    )]
    pub canonical_version: Option<u8>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull_optional"
    )]
    pub author_snapshot: Option<Vec<LiveAuthorEntry>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull_optional"
    )]
    pub first_seen_deletes: Option<Vec<LiveUpdateStructRange>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull_optional"
    )]
    pub checkpoint_coverage: Option<Vec<LiveCheckpointAuthorCoverage>>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveCheckpointAuthorCoverage {
    pub author: LiveAuthorEntry,
    pub struct_ranges: Vec<LiveUpdateStructRange>,
    pub deletion_ranges: Vec<LiveUpdateStructRange>,
}
pub fn validate_checkpoint_coverage(
    coverage: &[LiveCheckpointAuthorCoverage],
) -> Result<(), ApplicationError> {
    let mut identities = std::collections::BTreeSet::new();
    for entry in coverage {
        entry.author.validate()?;
        canonical_ranges(&entry.struct_ranges)?;
        canonical_ranges(&entry.deletion_ranges)?;
        if !identities.insert(entry.author.identity()) {
            return Err(invalid("duplicate checkpoint author"));
        }
    }
    let authors: Vec<&LiveAuthorEntry> = coverage.iter().map(|entry| &entry.author).collect();
    if identities.len() > 1024
        || serde_json::to_vec(&authors)
            .map_err(|_| invalid("checkpoint authors JSON"))?
            .len()
            > 128 * 1024
    {
        return Err(invalid("checkpoint authors exceed bound"));
    }
    Ok(())
}
impl AdmittedLiveUpdateMetadata {
    fn field_history_link_author(&self) -> Option<dohc_engine_domain::CollectionLiveLinkAuthor> {
        if self.canonical_version != Some(2) {
            return None;
        }
        let ServerDerivedLiveUpdateAuthority::Link {
            grant_id,
            grant_generation,
            ..
        } = &self.accepted.authority
        else {
            return None;
        };
        let public_principal_id =
            self.author_snapshot
                .as_ref()?
                .iter()
                .find_map(|author| match author {
                    LiveAuthorEntry::Link {
                        public_principal_id,
                        ..
                    } => Some(public_principal_id),
                    _ => None,
                })?;
        Some(dohc_engine_domain::CollectionLiveLinkAuthor::Link {
            grant_id: grant_id.clone(),
            grant_generation: *grant_generation,
            public_principal_id: public_principal_id.clone(),
        })
    }

    fn field_history_actor(&self) -> Option<(String, dohc_engine_domain::ChangeAttribution)> {
        use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
        if self.canonical_version != Some(2) {
            return None;
        }
        if matches!(
            self.accepted.authority,
            ServerDerivedLiveUpdateAuthority::Link { .. }
        ) {
            let agent = self.admitted_declaration()?;
            let dohc_engine_domain::CollectionLiveLinkAuthor::Link {
                public_principal_id,
                ..
            } = self.field_history_link_author()?;
            return (agent.on_behalf_of.as_ref() == Some(&public_principal_id))
                .then(|| (agent.agent_id.clone(), agent.attribution()));
        }
        let authors = self.author_snapshot.as_ref()?;
        let (_, principal, _, _) = self.accepted.authority.fields();
        let person = authors.iter().find_map(|author| match author {
            LiveAuthorEntry::Human { human_id, .. } if human_id == principal => Some(human_id),
            _ => None,
        })?;
        let agent = self.admitted_declaration();
        if agent
            .as_ref()
            .is_some_and(|agent| agent.on_behalf_of.as_ref() != Some(person))
        {
            return None;
        }
        Some(match agent {
            Some(agent) => (agent.agent_id.clone(), agent.attribution()),
            None => (
                person.clone(),
                ChangeAttribution {
                    actor_kind: ChangeActorKind::Human,
                    on_behalf_of: Some(person.clone()),
                    depth: 0,
                    run: None,
                },
            ),
        })
    }

    pub fn admitted_declaration(&self) -> Option<AgentDeclaration> {
        self.author_snapshot
            .as_ref()?
            .iter()
            .find_map(|author| match author {
                LiveAuthorEntry::Agent {
                    agent_id,
                    on_behalf_of,
                    depth,
                    ..
                } => Some(AgentDeclaration {
                    agent_id: agent_id.clone(),
                    on_behalf_of: on_behalf_of.clone(),
                    depth: u32::from(depth.unwrap_or(0)),
                }),
                _ => None,
            })
    }

    pub fn matches_draft_declaration(&self, declaration: Option<&AgentDeclaration>) -> bool {
        let ServerDerivedLiveUpdateAuthority::Owner { principal_id } = &self.accepted.authority
        else {
            return false;
        };
        self.admitted_declaration().as_ref().is_none_or(|admitted| {
            declaration.is_some_and(|draft| {
                // Depth and name are not part of the relay's agent identity.
                admitted.agent_id == draft.agent_id
                    && admitted.on_behalf_of.as_deref() == Some(principal_id.as_str())
            })
        })
    }

    pub fn matches_automation_declaration(
        &self,
        declaration: Option<&dohc_engine_domain::AutomationDeclaration>,
    ) -> bool {
        let admitted = self.author_snapshot.as_ref().and_then(|authors| {
            authors.iter().find_map(|author| match author {
                LiveAuthorEntry::Automation {
                    automation_id,
                    attribution,
                } => Some(dohc_engine_domain::AutomationDeclaration {
                    automation_id: automation_id.clone(),
                    attribution: attribution.clone(),
                }),
                _ => None,
            })
        });
        admitted.as_ref() == declaration
    }

    pub fn validate_extensions(&self) -> Result<(), ApplicationError> {
        match (
            self.canonical_version,
            &self.author_snapshot,
            &self.first_seen_deletes,
        ) {
            (None, None, None) if self.checkpoint_coverage.is_none() => Ok(()),
            (Some(2), Some(authors), Some(deletes)) => {
                if authors.len() > 2
                    || (authors.len() == 2
                        && (matches!(
                            authors[0],
                            LiveAuthorEntry::Agent { .. } | LiveAuthorEntry::Automation { .. }
                        ) || !matches!(authors[1], LiveAuthorEntry::Agent { .. })))
                {
                    return Err(invalid("noncanonical author snapshot"));
                }
                for author in authors {
                    author.validate()?;
                }
                canonical_ranges(deletes)?;
                if let Some(coverage) = &self.checkpoint_coverage {
                    validate_checkpoint_coverage(coverage)?;
                }
                Ok(())
            }
            _ => Err(invalid("invalid admitted metadata version")),
        }
    }
}
/// Native state replay uses bounded records, not a cumulative proof-read budget.
#[derive(Debug, Clone, Copy)]
pub struct NativeHistoryReconstruction {
    pub working_reserve_bytes: usize,
}
impl NativeHistoryReconstruction {
    pub const MAX_RANGES: usize = (crate::limits::MAX_YDOC_UPDATE_BYTES - 2) / 5;
    pub const HEADER_BYTES: usize = dohc_engine_storage::limits::MAX_LIVE_ACCEPTED_HEADER_BYTES;
    pub const CHUNK_BYTES: usize = 256 * 1024;

    /// Conservative Rust buffer spans plus the existing engine working allowance.
    /// This is admission accounting, not an allocator or SQLite heap measurement.
    pub fn reservation_bytes(self) -> Option<usize> {
        crate::limits::MAX_YDOC_UPDATE_BYTES
            .checked_mul(4)?
            .checked_add(Self::HEADER_BYTES.checked_mul(6)?)?
            .checked_add(Self::CHUNK_BYTES.checked_mul(2)?)?
            .checked_add(self.working_reserve_bytes)
    }
}

#[derive(Clone)]
pub struct AdmittedNativeHistoryReconstruction {
    pub policy: NativeHistoryReconstruction,
    pub reservation: std::sync::Arc<dyn Send + Sync>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

fn canonical_ranges(ranges: &[LiveUpdateStructRange]) -> Result<(), ApplicationError> {
    let mut previous: Option<&LiveUpdateStructRange> = None;
    for range in ranges {
        range.validate_after(previous)?;
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
        accepted.validate()?;
        canonical_ranges(&self.metadata.first_seen)?;
        self.metadata.validate_extensions()?;
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
    normalize_ranges(&mut metadata.first_seen)?;
    if let Some(deletes) = &mut metadata.first_seen_deletes {
        normalize_ranges(deletes)?;
    }
    if let Some(coverage) = &mut metadata.checkpoint_coverage {
        for entry in coverage {
            normalize_ranges(&mut entry.struct_ranges)?;
            normalize_ranges(&mut entry.deletion_ranges)?;
        }
    }
    metadata.validate_extensions()?;
    Ok(metadata)
}
fn normalize_ranges(ranges: &mut Vec<LiveUpdateStructRange>) -> Result<(), ApplicationError> {
    for range in ranges.iter() {
        range.validate()?;
    }
    ranges.sort_by_key(|range| (range.client_id, range.start_clock));
    let mut merged: Vec<LiveUpdateStructRange> = Vec::new();
    for range in ranges.drain(..) {
        if let Some(previous) = merged.last_mut() {
            if previous.client_id == range.client_id && range.start_clock <= previous.end_clock {
                previous.end_clock = previous.end_clock.max(range.end_clock);
                continue;
            }
        }
        merged.push(range);
    }
    *ranges = merged;
    Ok(())
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
    pub fn validate(&self) -> Result<(), ApplicationError> {
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
    /// The current interval cannot name this delivery's declared agent within
    /// its author bounds, and nothing was written. A settlement of the current
    /// terminal that materializes releases the interval, after which the same
    /// delivery applies.
    SettlementRequired,
    /// An earlier delivery applies first: the released chain left an earlier
    /// Carried delivery unapplied, or the current native service activation's
    /// adoption seed has no receipt yet. Until it has one, only the seed's own
    /// delivery and the released chain's rows through F apply. While a
    /// released chain has no adopted successor, nothing applies.
    DeliveryPending,
    /// As [`DeliveryPending`](Self::DeliveryPending), but the seed's outbox is
    /// quarantined, so delivery never retries it. The activation stays held
    /// until recovery or retirement.
    SeedQuarantined,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplicationResult {
    /// The frame is applied, with the automation claims its field changes
    /// inserted; a replayed frame claims nothing.
    Applied(
        LiveUpdateHostApplicationAck,
        Vec<dohc_engine_domain::AutomationClaim>,
    ),
    Pending(ApplicationPending),
}

#[derive(Debug)]
struct Registration {
    workspace_id: String,
    namespace: String,
    coordinate: ApplicationHostCoordinate,
    binding: LiveObjectBinding,
    /// The activation its binding row names; a read-only view leaves it unset.
    activation_id: Option<String>,
    live: bool,
}
/// One trusted delivery owner for an engine workspace. Never deserialize this
/// from an event. The production caller authenticates registration and namespace.
pub struct ApplicationOwner {
    workspace_id: String,
    current: Vec<Arc<Mutex<Registration>>>,
    retired: RetiredActivations,
}

/// The activations a retirement tore down under one owner. None registers
/// again under it, and output tagged with one is no longer current.
#[derive(Clone, Default)]
pub struct RetiredActivations(Arc<Mutex<std::collections::HashSet<String>>>);

impl RetiredActivations {
    pub fn contains(&self, activation_id: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(activation_id)
    }
    /// Run `action` unless `activation_id` is retired, holding the set
    /// throughout, so a retirement lands wholly before the check or after
    /// the action. Returns false, running nothing, for a retired one.
    pub fn unless_retired(&self, activation_id: &str, action: impl FnOnce() -> bool) -> bool {
        let retired = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        !retired.contains(activation_id) && action()
    }
    /// Whether an [`unless_retired`](Self::unless_retired) action holds the set now.
    #[cfg(feature = "test-support")]
    pub fn fenced(&self) -> bool {
        matches!(self.0.try_lock(), Err(std::sync::TryLockError::WouldBlock))
    }
}
/// A captured lifetime. Replacement invalidates every clone of the old handle.
#[derive(Clone)]
pub struct ApplicationHandle {
    registration: Arc<Mutex<Registration>>,
    /// Its owner's retired activations; none of them adopts through it.
    retired: RetiredActivations,
}

impl ApplicationHandle {
    /// The activation this registration serves: the one it resolved when it
    /// registered, or the one its adoption made.
    pub fn activation_id(&self) -> Option<String> {
        self.registration
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .activation_id
            .clone()
    }
}

impl ApplicationOwner {
    pub fn new(workspace_id: String) -> Result<Self, ApplicationError> {
        Self::with_retired(workspace_id, RetiredActivations::default())
    }
    /// An owner that shares `retired` with the owners it replaces, so a
    /// retirement outlasts a host reconnect.
    pub fn with_retired(
        workspace_id: String,
        retired: RetiredActivations,
    ) -> Result<Self, ApplicationError> {
        identifier(&workspace_id, 512)?;
        Ok(Self {
            workspace_id,
            current: Vec::new(),
            retired,
        })
    }
    /// The activations this owner retired, shared with its transport's output guards.
    pub fn retired_activations(&self) -> RetiredActivations {
        self.retired.clone()
    }
    pub fn register(
        &mut self,
        store: &mut EngineStore,
        namespace: String,
        coordinate: ApplicationHostCoordinate,
        binding: LiveObjectBinding,
    ) -> Result<ApplicationHandle, ApplicationError> {
        self.register_with(store, namespace, coordinate, binding, None)
    }
    /// Register a session host for one activation. The binding row names it,
    /// and a mismatch refuses before any existing registration is retired.
    pub fn register_activation(
        &mut self,
        store: &mut EngineStore,
        namespace: String,
        coordinate: ApplicationHostCoordinate,
        binding: LiveObjectBinding,
        activation_id: String,
    ) -> Result<ApplicationHandle, ApplicationError> {
        self.register_with(store, namespace, coordinate, binding, Some(activation_id))
    }
    fn register_with(
        &mut self,
        store: &mut EngineStore,
        namespace: String,
        coordinate: ApplicationHostCoordinate,
        binding: LiveObjectBinding,
        activation_id: Option<String>,
    ) -> Result<ApplicationHandle, ApplicationError> {
        if namespace.is_empty() {
            return Err(invalid("relay namespace is empty"));
        }
        coordinate.validate()?;
        validate_application_binding(store, &self.workspace_id, &binding)?;
        let key = DocKey::new(
            &binding.workspace_id,
            &binding.main_version_id,
            &binding.object_id,
        )?;
        let requested = activation_id;
        let activation_id = store.read_with(|conn| {
            restore_fence::require_registration(conn, &key, &namespace, &binding)?;
            owner_activations::registration_activation(
                conn,
                &namespace,
                &binding,
                requested.as_deref(),
            )
        })?;
        if activation_id
            .as_deref()
            .is_some_and(|id| self.retired.contains(id))
        {
            return Err(ApplicationError::Conflict);
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
            activation_id,
            live: true,
        };
        let outcome = store.write_with(&NoFaults, |tx| {
            require_workspace(tx, &registration)?;
            require_hosted_ready(tx, &key)?;
            restore_fence::require_registration(
                tx,
                &key,
                &registration.namespace,
                &registration.binding,
            )?;
            if owner_activations::registration_activation(
                tx,
                &registration.namespace,
                &registration.binding,
                requested.as_deref(),
            )? != registration.activation_id
            {
                return Err(ApplicationError::Conflict);
            }
            keep_left_recovery_checkpoints(tx, &registration)?;
            install_binding(tx, &registration)
        })?;
        if !matches!(outcome, TxnOutcome::Committed(())) {
            return Err(ApplicationError::Interrupted);
        }
        let registration = Arc::new(Mutex::new(registration));
        self.current.push(registration.clone());
        Ok(ApplicationHandle {
            registration,
            retired: self.retired.clone(),
        })
    }
    /// Retire every registration, on a reconnect or a close. A hosted replica
    /// retires them in memory only, as [`release`](Self::release) does: a
    /// document held meanwhile cannot register again, and its binding must
    /// stay available for the accepted work it journaled to push.
    pub fn invalidate(&mut self, store: &mut EngineStore) -> Result<(), ApplicationError> {
        for current in &self.current {
            current
                .lock()
                .map_err(|_| ApplicationError::Interrupted)?
                .live = false;
        }
        let hosted: bool = store.read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM hosted_replicas WHERE workspace_id=?1)",
                [&self.workspace_id],
                |row| row.get(0),
            )
            .map_err(read_sql)
        })?;
        if !hosted {
            for current in &self.current {
                invalidate_registration(store, current)?;
            }
        }
        self.current.clear();
        Ok(())
    }
    /// Refuse an unload naming `activation_id` while a registration of the
    /// document serves another activation, or any while one serves an
    /// activation and the unload names none.
    pub fn require_unload_activation(
        &self,
        object_id: &str,
        activation_id: Option<&str>,
    ) -> Result<(), ApplicationError> {
        for current in &self.current {
            let held = current.lock().map_err(|_| ApplicationError::Interrupted)?;
            if held.binding.object_id == object_id
                && held
                    .activation_id
                    .as_deref()
                    .is_some_and(|tagged| Some(tagged) != activation_id)
            {
                return Err(ApplicationError::Conflict);
            }
        }
        Ok(())
    }
    /// Release one document's registration, once
    /// [`require_unload_activation`](Self::require_unload_activation) allowed
    /// it. Its durable application state stays.
    pub fn unregister(
        &mut self,
        store: &mut EngineStore,
        object_id: &str,
        activation_id: Option<&str>,
    ) -> Result<(), ApplicationError> {
        self.require_unload_activation(object_id, activation_id)?;
        let mut found = None;
        for (index, current) in self.current.iter().enumerate() {
            let held = current.lock().map_err(|_| ApplicationError::Interrupted)?;
            if held.binding.object_id == object_id {
                found = Some(index);
                break;
            }
        }
        if let Some(index) = found {
            invalidate_registration(store, &self.current[index])?;
            self.current.remove(index);
        }
        Ok(())
    }
    /// Phase A of a retirement: no registration serves `activation_id` under
    /// this owner again. Only this host's registrations tagged with it retire,
    /// in memory; their binding rows stay. The document's cache entry goes
    /// without a close, settlement, or materialization.
    pub fn retire_activation(
        &mut self,
        cache: &mut WriterDocCache,
        namespace: &str,
        coordinate: &ApplicationHostCoordinate,
        key: &DocKey,
        activation_id: &str,
    ) {
        self.retired
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(activation_id.to_owned());
        self.current.retain(|current| {
            let mut held = current.lock().unwrap_or_else(PoisonError::into_inner);
            let retired = held.namespace == namespace
                && held.coordinate == *coordinate
                && held.activation_id.as_deref() == Some(activation_id);
            if retired {
                held.live = false;
            }
            !retired
        });
        cache.remove(key);
        cache.unpin(key);
    }
    /// Retire one document's registration in memory only. Its handles stop
    /// applying and settling, and its binding row stays available, so the
    /// accepted work it journaled still proves and pushes.
    pub fn release(&mut self, object_id: &str) {
        self.current.retain(|current| {
            let mut held = current.lock().unwrap_or_else(PoisonError::into_inner);
            let released = held.binding.object_id == object_id;
            if released {
                held.live = false;
            }
            !released
        });
    }
}

/// Work a host must finish before it unloads a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnloadPending {
    /// A restore fence for the document has not resumed.
    Restore,
    /// Owner updates or deferred replicated updates have not been delivered.
    Delivery,
    /// Applied updates on the current lineage are past its last settlement,
    /// or the Markdown artifact does not hold the document's head.
    Settlement,
    /// A settlement committed but its Markdown artifact is not written yet.
    Materialization,
}

/// A queue of the lineage frozen at its owner's adoption seed: quarantined,
/// with no Try again granted, and the seed never applied. Settlement refuses
/// to pass the seed, so nothing applied on that lineage since the adoption
/// can settle. That work stays in the store, unsettled and unpublished.
/// `a` names the lineage and `$generation` the current binding's restore
/// generation: an earlier generation's seed never holds a successor's work.
macro_rules! frozen_at_refused_seed {
    ($generation:literal) => {
        concat!("EXISTS(SELECT 1 FROM owner_ydoc_outboxes q JOIN owner_ydoc_outbox_entries e ON e.outbox_id=q.outbox_id
            WHERE q.workspace_id=a.workspace_id AND q.main_version_id=a.main_version_id
                AND q.object_id=a.object_id AND q.lineage_claim_id=a.lineage_claim_id
                AND q.restore_fence_generation=", $generation, "
                AND q.state='quarantined' AND q.retry_delivery_id IS NULL
                AND e.pending=1 AND json_extract(e.native_source_json,'$.origin.kind')='adoptionSeed'
                AND NOT EXISTS(SELECT 1 FROM live_device_update_applications s WHERE s.delivery_id=e.delivery_id))")
    };
}

/// `?3` counts deferred updates. A refused queue waits for its owner, not for
/// delivery, unless the owner's Try again granted its head an attempt.
const UNLOAD_PENDING: &str = "SELECT
    EXISTS(SELECT 1 FROM live_restore_fences
        WHERE workspace_id=?1 AND object_id=?2 AND resume_receipt_json IS NULL),
    (?3 AND EXISTS(SELECT 1 FROM ydoc_deferred_updates WHERE workspace_id=?1 AND object_id=?2))
        OR EXISTS(SELECT 1 FROM owner_ydoc_outboxes
            WHERE workspace_id=?1 AND object_id=?2 AND pending_bytes>0
                AND (state<>'quarantined' OR retry_delivery_id IS NOT NULL))";

/// Whether the lineage `(?1..?5)` applied an update, through cursor `?6` when
/// given, past both its last settlement and its owner boundary: the cut of
/// its current activation, or else the furthest cut any of its activations
/// adopted. Updates through an adoption's cut settled before it.
const SETTLEMENT_PENDING: &str = "SELECT EXISTS(SELECT 1 FROM live_device_update_applications a
    WHERE a.relay_database_namespace=?1 AND a.workspace_id=?2 AND a.main_version_id=?3
      AND a.object_id=?4 AND a.lineage_claim_id=?5 AND (?6 IS NULL OR a.journal_cursor<=?6)
      AND a.journal_cursor>max(
        COALESCE((SELECT max(s.terminal_cursor) FROM live_device_settlements s
            WHERE s.relay_database_namespace=?1 AND s.workspace_id=?2 AND s.main_version_id=?3
              AND s.object_id=?4 AND s.lineage_claim_id=?5),0),
        COALESCE((SELECT o.terminal_cursor FROM live_owner_activations o WHERE o.released_at_ms IS NULL
              AND o.relay_database_namespace=?1 AND o.workspace_id=?2 AND o.main_version_id=?3
              AND o.object_id=?4 AND o.lineage_claim_id=?5),
            (SELECT max(o.terminal_cursor) FROM live_owner_activations o
              WHERE o.relay_database_namespace=?1 AND o.workspace_id=?2 AND o.main_version_id=?3
                AND o.object_id=?4 AND o.lineage_claim_id=?5),0)))";

/// The one settlement-pending predicate: reconciliation, unload and parking
/// all ask it of one lineage. A lineage frozen at a refused adoption seed
/// still reports its unsettled work here; only unload and parking stop
/// waiting for it.
pub(crate) fn settlement_pending(
    conn: &Connection,
    namespace: &str,
    key: &DocKey,
    lineage_claim_id: &str,
    through: Option<i64>,
) -> Result<bool, ApplicationError> {
    conn.query_row(
        SETTLEMENT_PENDING,
        params![
            namespace,
            key.workspace_id,
            key.version_id,
            key.object_id,
            lineage_claim_id,
            through
        ],
        |row| row.get(0),
    )
    .map_err(read_sql)
}

/// Whether the lineage `(?1..?4)` at restore generation `?5` is frozen at a
/// refused adoption seed. Nothing applied on it since can settle, so unload
/// and parking need not wait for its settlement.
fn lineage_frozen_at_refused_seed(
    conn: &Connection,
    key: &DocKey,
    lineage_claim_id: &str,
    restore_fence_generation: i64,
) -> Result<bool, ApplicationError> {
    conn.query_row(
        concat!(
            "SELECT EXISTS(SELECT 1 FROM (SELECT ?1 AS workspace_id,?2 AS main_version_id,?3 AS object_id,?4 AS lineage_claim_id) a WHERE ",
            frozen_at_refused_seed!("?5"),
            ")"
        ),
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            lineage_claim_id,
            restore_fence_generation
        ],
        |row| row.get(0),
    )
    .map_err(read_sql)
}

/// Whether the document's current lineage, at its current binding's restore
/// generation, is frozen at a refused adoption seed. Its head then holds work
/// no settlement can write, so the artifact need not hold it before the
/// document unloads or parks.
pub fn frozen_at_refused_seed(conn: &Connection, key: &DocKey) -> Result<bool, ApplicationError> {
    conn.query_row(
        concat!(
            "SELECT EXISTS(SELECT 1 FROM (SELECT d.workspace_id,d.version_id AS main_version_id,d.object_id,d.lineage_claim_id,b.restore_fence_generation
                FROM ydoc_docs d JOIN live_device_application_bindings b ON b.workspace_id=d.workspace_id
                    AND b.main_version_id=d.version_id AND b.object_id=d.object_id AND b.lineage_claim_id=d.lineage_claim_id
                WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3) a WHERE ",
            frozen_at_refused_seed!("a.restore_fence_generation"),
            ")"
        ),
        params![key.workspace_id, key.version_id, key.object_id],
        |row| row.get(0),
    )
    .map_err(read_sql)
}

/// Name the first incomplete restore, delivery, or settlement record for one
/// document. The caller still proves the artifact holds the head.
pub fn unload_pending(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<UnloadPending>, ApplicationError> {
    pending(conn, workspace_id, object_id, true)
}

/// [`unload_pending`] for parking a hosted document that left the scope.
/// Only work the host accepted counts. A deferred update is a pulled row
/// waiting for rows the feed no longer serves; parking keeps it, and the
/// document's return applies it.
pub fn park_pending(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<UnloadPending>, ApplicationError> {
    pending(conn, workspace_id, object_id, false)
}

fn pending(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
    deferred: bool,
) -> Result<Option<UnloadPending>, ApplicationError> {
    let (restore, delivery): (bool, bool) = conn
        .query_row(
            UNLOAD_PENDING,
            params![workspace_id, object_id, deferred],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(read_sql)?;
    if restore {
        return Ok(Some(UnloadPending::Restore));
    }
    if delivery {
        return Ok(Some(UnloadPending::Delivery));
    }
    // Only each binding's current lineage: a restore replaces the lineage,
    // and the replaced one never settles again. A lineage frozen at a refused
    // adoption seed waits for nothing to settle.
    let mut bindings = conn
        .prepare(
            "SELECT relay_database_namespace,main_version_id,lineage_claim_id,restore_fence_generation
             FROM live_device_application_bindings WHERE workspace_id=?1 AND object_id=?2",
        )
        .map_err(read_sql)?;
    let rows = bindings
        .query_map(params![workspace_id, object_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(read_sql)?;
    for row in rows {
        let (namespace, version, lineage, generation) = row.map_err(read_sql)?;
        let key = DocKey::new(workspace_id, version, object_id)?;
        if settlement_pending(conn, &namespace, &key, &lineage, None)?
            && !lineage_frozen_at_refused_seed(conn, &key, &lineage, generation)?
        {
            return Ok(Some(UnloadPending::Settlement));
        }
    }
    Ok(None)
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
            tx.execute("UPDATE live_device_application_bindings SET available=0 WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND host_id=?5 AND host_epoch=?6 AND instance_id=?7 AND connection_id=?8 AND activation_id IS ?9",
                params![held.namespace, held.workspace_id, b.main_version_id, b.object_id, c.host_id, c.host_epoch, c.instance_id, c.connection_id, held.activation_id]).map_err(write_sql)?;
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
    require_binding_workspace(tx, &registration.workspace_id, &registration.binding)
}

/// A hosted replica refuses a document its current scope holds but not ready,
/// and a parked one. One that left the scope and has not parked registers,
/// so its accepted work can settle and drain.
fn require_hosted_ready(tx: &Connection, key: &DocKey) -> Result<(), ApplicationError> {
    let unready: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM hosted_documents d JOIN hosted_replicas h
                ON h.workspace_id=d.workspace_id
             WHERE d.workspace_id=?1 AND d.object_id=?2 AND (d.state='parked'
                OR (d.scope_generation=h.scope_generation AND d.state<>'ready')))",
            params![key.workspace_id, key.object_id],
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    if unready {
        return Err(ApplicationError::HostedDocumentUnready);
    }
    Ok(())
}

/// Refuse invalid caller bindings before retiring an existing registration.
pub fn validate_application_binding(
    store: &EngineStore,
    workspace_id: &str,
    binding: &LiveObjectBinding,
) -> Result<(), ApplicationError> {
    binding.validate_canonical().map_err(invalid)?;
    store.read_with(|conn| require_binding_workspace(conn, workspace_id, binding))
}

/// Refuse an activation this binding's registration cannot serve, or one
/// `retired` holds, before retiring an existing registration. Without a
/// name, the registration would serve the current activation.
pub fn validate_registration_activation(
    store: &EngineStore,
    namespace: &str,
    binding: &LiveObjectBinding,
    activation_id: Option<&str>,
    retired: &RetiredActivations,
) -> Result<(), ApplicationError> {
    let serves = store.read_with(|conn| {
        owner_activations::registration_activation(conn, namespace, binding, activation_id)
    })?;
    if serves.is_some_and(|id| retired.contains(&id)) {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

fn require_binding_workspace(
    tx: &Connection,
    workspace_id: &str,
    binding: &LiveObjectBinding,
) -> Result<(), ApplicationError> {
    if workspace_id != binding.workspace_id {
        return Err(ApplicationError::WorkspaceMismatch);
    }
    let main: Option<String> = tx
        .query_row(
            "SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(read_sql)?;
    if main.as_deref() != Some(binding.main_version_id.as_str()) {
        return Err(ApplicationError::MainVersionMismatch);
    }
    Ok(())
}
/// Before `r` moves its document's binding to another lineage or restore
/// generation without a restore fence, keeps the final accepted state of the
/// one it leaves for that one's refused seeds, as the fence does. A state it
/// cannot keep, as one still waiting on a missing dependency, leaves those
/// copies refused instead of this registration, which that dependency may need.
/// A storage failure refuses the registration, so the binding stays put.
fn keep_left_recovery_checkpoints(
    tx: &Transaction<'_>,
    r: &Registration,
) -> Result<(), ApplicationError> {
    let Some((left, _, _)) = read_binding(tx, r)? else {
        return Ok(());
    };
    if left.lineage_claim_id == r.binding.lineage_claim_id
        && left.restore_fence_generation == r.binding.restore_fence_generation
    {
        return Ok(());
    }
    match crate::owner_outbox::keep_recovery_checkpoints_in_tx(tx, &left) {
        Err(crate::OwnerOutboxError::Storage(error)) => Err(ApplicationError::Storage(error)),
        _ => Ok(()),
    }
}

fn install_binding(tx: &Transaction<'_>, r: &Registration) -> Result<(), ApplicationError> {
    let b = &r.binding;
    let c = &r.coordinate;
    tx.execute("INSERT INTO live_device_application_bindings (relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,host_id,host_epoch,instance_id,connection_id,available,activation_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,1,?13) ON CONFLICT(relay_database_namespace,workspace_id,main_version_id,object_id) DO UPDATE SET lineage_claim_id=excluded.lineage_claim_id,current_path=excluded.current_path,selector_paths_json=excluded.selector_paths_json,restore_fence_generation=excluded.restore_fence_generation,host_id=excluded.host_id,host_epoch=excluded.host_epoch,instance_id=excluded.instance_id,connection_id=excluded.connection_id,available=1,activation_id=excluded.activation_id",
        params![r.namespace,r.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.current_path,serde_json::to_string(&b.selector_paths).map_err(|_| invalid("selector JSON"))?,b.restore_fence_generation,c.host_id,c.host_epoch,c.instance_id,c.connection_id,r.activation_id]).map_err(write_sql)?;
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
            binding.validate_canonical().map_err(|_| ApplicationError::Corrupt)?;
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

/// Apply one owned committed event and publish its retained facts atomically.
/// Pending dependencies roll back this attempt, including a fresh append.
/// A post-commit fold error is safely redeliverable at the original sequence.
pub fn apply_committed(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    handle: &ApplicationHandle,
    event: AdmittedLiveUpdate,
    faults: &dyn FaultInjector,
    working_reserve_bytes: usize,
    follow_up: impl FnOnce(
        &Transaction<'_>,
        &str,
        &LiveObjectBinding,
        i64,
    ) -> Result<(), ApplicationError>,
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
            if settlement::validate_historical_binding(b, &held.binding).is_err() {
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
            restore_fence::require_registration(tx, &key, &held.namespace, &held.binding)?;
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
                    Vec::new(),
                ));
            }
            let receipt = &event.metadata.accepted.receipt;
            let suffix =
                retirement::retained_suffix(tx, &held.namespace, &key, &b.lineage_claim_id)?;
            // A released chain whose successor has not adopted: anything
            // applied now would move accepted history past the boundary the
            // successor adopts, so every delivery waits for that adoption.
            if suffix.is_some()
                && owner_activations::current_activation(
                    tx,
                    Some(&held.namespace),
                    &key,
                    &b.lineage_claim_id,
                )?
                .is_none()
            {
                return Ok(ApplicationResult::Pending(
                    ApplicationPending::DeliveryPending,
                ));
            }
            match seed_hold(tx, &held.namespace, b)? {
                // Retirement proved the seed never delivered, which stays
                // true only while nothing applies after the cut.
                Some(SeedHold::Abandoned) => {
                    return Ok(ApplicationResult::Pending(
                        ApplicationPending::ApplicabilityUnavailable,
                    ));
                }
                // The released chain's journal rows through F precede the
                // successor's seed, so they drain while it waits.
                Some(SeedHold::Pending {
                    delivery,
                    digest,
                    quarantined,
                }) if (delivery != receipt.delivery_id || digest != receipt.update_digest)
                    && suffix
                        .as_ref()
                        .is_none_or(|suffix| receipt.journal_cursor > suffix.through) =>
                {
                    return Ok(ApplicationResult::Pending(if quarantined {
                        ApplicationPending::SeedQuarantined
                    } else {
                        ApplicationPending::DeliveryPending
                    }));
                }
                _ => {}
            }
            // Nothing overtakes the earliest Carried delivery still unapplied,
            // the seed included, whether or not its receipt is saved.
            if suffix
                .and_then(|suffix| suffix.earliest_carried)
                .is_some_and(|earliest| receipt.journal_cursor > earliest)
            {
                return Ok(ApplicationResult::Pending(
                    ApplicationPending::DeliveryPending,
                ));
            }
            check_provenance(tx, &held.namespace, &event)?;
            if adoption::read_origin(tx, &held)?.is_some_and(|origin| {
                event.metadata.accepted.receipt.journal_cursor
                    <= origin
                        .terminal
                        .as_ref()
                        .map_or(0, |receipt| receipt.journal_cursor)
            }) {
                return Err(ApplicationError::Conflict.into());
            }
            let own = own_draft(tx, &key, &event.metadata.accepted.receipt)?;
            if own.as_ref().is_some_and(|own| {
                !event.metadata.matches_draft_declaration(own.declaration.as_ref())
            }) {
                return Err(ApplicationError::Conflict.into());
            }
            let admitted_actor = if let Some(own) = &own {
                own.author.clone()
            } else if event.metadata.canonical_version == Some(2) {
                event.metadata.author_snapshot.as_ref().and_then(|authors| authors.iter().find_map(|author| match author {
                    LiveAuthorEntry::Automation { automation_id, attribution } => Some((Some(automation_id.clone()), Some(attribution.clone()))),
                    _ => None,
                })).or_else(|| event.metadata.admitted_declaration().map(|declaration| (Some(declaration.agent_id.clone()), Some(declaration.attribution()))))
            } else { None };
            // A person the owner shared with, or an Edit share link, is named
            // from the relay's authority, never the frame, whether or not
            // their client sent a recording context. That entry carries the
            // grant, so it stands in for the same principal's snapshot entry.
            // A declared agent stays beside it.
            let shared = event.metadata.accepted.authority.shared_author();
            let snapshot = event.metadata.author_snapshot.as_deref().unwrap_or_default();
            let mut authors = snapshot.iter()
                .filter(|author| shared.is_none() || !matches!(author, LiveAuthorEntry::Human { .. } | LiveAuthorEntry::Link { .. }))
                .map(|author| match author {
                    LiveAuthorEntry::Automation { automation_id, attribution } => Ok(dohc_engine_domain::moment_author_json(Some(automation_id), Some(attribution)).expect("validated automation author")),
                    _ => serde_json::to_string(&[author]),
                })
                .collect::<Result<Vec<_>, _>>().map_err(|_| ApplicationError::Corrupt)?;
            // A delivery without recording context keeps that gap in coverage,
            // even when the relay's authority names who sent it. A delivery
            // that adds no content leaves no gap.
            let adds_content = !event.metadata.first_seen.is_empty()
                || event.metadata.first_seen_deletes.as_ref().is_some_and(|ranges| !ranges.is_empty());
            if snapshot.is_empty() && adds_content {
                authors.push(r#"[{"kind":"unattributed"}]"#.to_owned());
            }
            // A full interval refuses before anything is written, so nothing
            // is truncated.
            if let Some(shared) = shared {
                authors.push(crate::author_coverage::shared_json(&shared)?);
            }
            match if authors.is_empty() { Ok(()) } else {
                crate::author_coverage::admit_accepted_in(tx, &key, &authors)
            } {
                Err(CollabError::AuthorCapacity)
                    if crate::author_coverage::unresolved_in(tx, &key)? =>
                {
                    return Err(ApplicationError::MaterializationPending.into());
                }
                Err(CollabError::AuthorCapacity) => {
                    return Ok(ApplicationResult::Pending(
                        ApplicationPending::SettlementRequired,
                    ));
                }
                result => result?,
            }
            mutation_attempted = true;
            // Canonical person and agent snapshots retain names and explicit depths.
            let native_actor = admitted_actor.as_ref().filter(|(_, attribution)| {
                own.is_some() || attribution.as_ref().is_some_and(|attribution| {
                    attribution.actor_kind == dohc_engine_domain::ChangeActorKind::Automation
                })
            });
            let append = durable::record_authorized_update_in_tx(
                tx,
                &key,
                &event.update_bytes,
                true,
                native_actor.and_then(|(actor, _)| actor.as_deref()),
                native_actor.and_then(|(_, attribution)| attribution.as_ref()),
                true,
                event.metadata.accepted.received_at_ms,
            )?;
            // Keep canonical snapshot names in coverage instead of synthesizing
            // native authors. Only the field rows created by this append change.
            if own.is_none() && native_actor.is_none() {
                if let (Some(facts), Some(author)) = (
                    append.record_facts.as_ref(), event.metadata.field_history_link_author(),
                ) {
                    let json = serde_json::to_string(&author).map_err(|_| ApplicationError::Corrupt)?;
                    let mut statement = tx.prepare_cached(
                        "UPDATE collection_field_history SET link_author_json=?1 WHERE workspace_id=?2 AND history_id=?3",
                    ).map_err(StorageError::persist_public)?;
                    for field in &facts.fields {
                        statement.execute(params![json, key.workspace_id, field.history_id]).map_err(StorageError::persist_public)?;
                    }
                }
                if let (Some(facts), Some((actor, attribution))) = (
                    append.record_facts.as_ref(),
                    event.metadata.field_history_actor(),
                ) {
                    let mut statement = tx.prepare_cached(
                        "UPDATE collection_field_history SET actor_kind=?1,author_origin_id=?2,\
                         on_behalf_of=?3,chain_depth=?4 WHERE workspace_id=?5 AND history_id=?6",
                    ).map_err(StorageError::persist_public)?;
                    for field in &facts.fields {
                        statement.execute(params![
                            attribution.actor_kind.as_str(), actor, attribution.on_behalf_of,
                            attribution.depth, key.workspace_id, field.history_id,
                        ]).map_err(StorageError::persist_public)?;
                    }
                }
            }
            // A new delivery can reuse old bytes and an older local sequence.
            compaction_due = append.seq.max(marker.head_update_seq) - marker.head_snapshot_seq
                >= i64::from(DEFAULT_COMPACTION_THRESHOLD);
            // Content dedupe bypasses the append's parity gate. Always reconstruct.
            if durable::load_doc_in(tx, &key)?.has_missing_updates() {
                return Err(TransactionError::DependenciesUnresolved);
            }
            integer(append.seq, 1, SAFE)?;
            insert_application(tx, &held, &event, append.seq)?;
            // Every accepted frame but this computer's own draft is a change
            // from elsewhere: a collaborator's, or its owner's on another
            // computer. The application row above makes a replay return
            // before this point.
            if !crate::owner_outbox::is_own_draft_in(
                tx,
                &key,
                &event.metadata.accepted.receipt.update_digest,
                crate::owner_outbox::AcceptedAs::Delivery(
                    &event.metadata.accepted.receipt.delivery_id,
                ),
            )? {
                dohc_engine_storage::count_remote_change_in_tx(tx, &key.workspace_id)?;
            }
            // The session host commits every accepted frame of a live-shared
            // document as local, the owner's and each collaborator's alike,
            // so the host is the one computer that claims its field changes
            // (ADR 0008). The owner applies the same frame from the host's
            // acceptance and a collaborator never journals it; neither
            // claims. The author is the attribution this engine recorded when
            // the frame is its own draft (an automation's write keeps its
            // chain depth), and otherwise the principal the relay accepted it
            // from, at depth 0. A person the owner shared with, or an Edit
            // share link, is also named as the claim's shared author, from
            // the relay's authority and nothing the frame says.
            let mut automation_claims = Vec::new();
            if let Some(mut facts) = append.record_facts {
                // The relay journals every frame it accepts at a cursor, and a
                // settlement carries the frames through its terminal cursor to
                // the relay's log. The claim keeps its history-row key, so it
                // dedupes as before, and the cursor lets the relay place it.
                facts.live_cursor = Some(event.metadata.accepted.receipt.journal_cursor);
                match admitted_actor {
                    Some((actor, attribution)) => {
                        facts.author_origin_id = actor;
                        facts.attribution = attribution;
                    }
                    None => {
                        let authority = &event.metadata.accepted.authority;
                        let (_, principal_id, _, _) = authority.fields();
                        facts.author_origin_id = Some(principal_id.to_owned());
                        facts.shared_author = authority.shared_author();
                    }
                }
                automation_claims = dohc_engine_domain::claim_automation_triggers_in_tx(
                    tx,
                    &key.workspace_id,
                    &facts,
                    event.metadata.accepted.received_at_ms,
                )
                .map_err(|error| {
                    ApplicationError::Collab(CollabError::Corrupt {
                        reason: format!("automation claim insert failed: {error}"),
                    })
                })?;
            }
            accepted_history::append_native(tx, &held, &event, working_reserve_bytes)?;
            let readback = read_application(tx, &held.namespace, &event.metadata.accepted.receipt)?
                .ok_or(ApplicationError::Corrupt)?;
            if readback.event != event
                || readback.sequence != append.seq
                || readback.coordinate != held.coordinate
            {
                return Err(ApplicationError::Corrupt.into());
            }
            let count:Option<i64>=tx.query_row("SELECT event_count FROM live_accepted_updates WHERE relay_database_namespace=?1 AND delivery_id=?2",params![held.namespace,event.metadata.accepted.receipt.delivery_id],|r|r.get(0)).optional().map_err(read_sql)?;
            if let Some(count)=count {
                follow_up(tx,&held.namespace,b,count)?;
            }
            Ok(ApplicationResult::Applied(
                LiveUpdateHostApplicationAck::new(
                    &event.metadata.accepted.receipt,
                    append.seq,
                    false,
                ),
                automation_claims,
            ))
        },
    );
    if mutation_attempted {
        cache.remove(&key);
    }
    match outcome {
        Ok(TxnOutcome::Committed(result)) => {
            if compaction_due
                && matches!(&result, ApplicationResult::Applied(ack, _) if !ack.application_replayed)
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

/// This engine's own adopted native update, when the accepted frame is its
/// delivery: the relay accepted the entry's own delivery, with the same
/// bytes, for the same document.
struct OwnDraft {
    author: Option<(
        Option<String>,
        Option<dohc_engine_domain::ChangeAttribution>,
    )>,
    /// The agent the outbox entry declared for its delivery.
    declaration: Option<AgentDeclaration>,
}

/// What the current activation's adoption seed holds back.
enum SeedHold {
    /// The relay's receipt for it is outstanding. Only its own delivery, and
    /// its released chain's retained suffix, apply.
    Pending {
        delivery: String,
        digest: String,
        quarantined: bool,
    },
    /// Retirement abandoned it. Nothing applies.
    Abandoned,
}

/// Only a native service activation, which keeps its imported source,
/// delivers its seed before applying it; a device host applies its seed first.
fn seed_hold(
    conn: &Connection,
    namespace: &str,
    b: &LiveObjectBinding,
) -> Result<Option<SeedHold>, ApplicationError> {
    let found: Option<(String, String, bool, bool)> = conn.query_row(
        &format!(
            "SELECT e.delivery_id,e.update_digest,e.pending,o.state='quarantined' FROM owner_ydoc_outbox_entries e
             JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id
             JOIN {} v ON v.relay_database_namespace=?1 AND v.workspace_id=o.workspace_id
               AND v.main_version_id=o.main_version_id AND v.object_id=o.object_id
               AND v.lineage_claim_id=o.lineage_claim_id
             JOIN ydoc_owner_activation_sources s ON s.activation_id=v.activation_id
               AND s.relay_database_namespace=?1 AND s.workspace_id=o.workspace_id
               AND s.version_id=o.main_version_id AND s.object_id=o.object_id
               AND s.lineage_claim_id=o.lineage_claim_id
             WHERE o.workspace_id=?2 AND o.main_version_id=?3 AND o.object_id=?4 AND o.lineage_claim_id=?5
               AND json_extract(e.native_source_json,'$.origin.kind')='adoptionSeed'
               AND json_extract(e.native_source_json,'$.adoptionId')=v.activation_id
               AND (e.pending=1 OR (e.terminal_reason=?6 AND e.accepted_receipt_json IS NULL
                 AND e.update_blob_digest IS NULL AND e.terminal_blob_digest IS NULL))",
            owner_activations::CURRENT_ACTIVATIONS
        ),
        params![
            namespace,
            b.workspace_id,
            b.main_version_id,
            b.object_id,
            b.lineage_claim_id,
            crate::owner_outbox::ACTIVATION_RELEASED
        ],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .optional()
    .map_err(read_sql)?;
    Ok(found.map(|(delivery, digest, pending, quarantined)| {
        if pending {
            SeedHold::Pending {
                delivery,
                digest,
                quarantined,
            }
        } else {
            SeedHold::Abandoned
        }
    }))
}

fn own_draft(
    tx: &Transaction<'_>,
    key: &DocKey,
    receipt: &LiveUpdateReceipt,
) -> Result<Option<OwnDraft>, ApplicationError> {
    let entry: Option<(String, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT e.native_source_json,e.agent_declaration_json,e.accepted_receipt_json FROM owner_ydoc_outbox_entries e \
             JOIN owner_ydoc_outboxes o ON o.outbox_id = e.outbox_id \
             WHERE e.delivery_id = ?1 AND e.update_digest = ?2 \
               AND o.workspace_id = ?3 AND o.main_version_id = ?4 AND o.object_id = ?5 \
               AND e.native_source_json IS NOT NULL",
            params![
                receipt.delivery_id,
                receipt.update_digest,
                key.workspace_id,
                key.version_id,
                key.object_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(read_sql)?;
    let Some((source, declaration, saved)) = entry else {
        return Ok(None);
    };
    // An acknowledged entry keeps the receipt the relay gave it; only that
    // acceptance applies as this entry.
    if let Some(saved) = saved {
        let saved: crate::owner_outbox::OwnerDeliveryReceipt =
            serde_json::from_str(&saved).map_err(|_| ApplicationError::Corrupt)?;
        if saved.journal_cursor != receipt.journal_cursor
            || saved.accepting_host_epoch != receipt.accepting_host_epoch
        {
            return Err(ApplicationError::Conflict);
        }
    }
    let source: crate::owner_outbox::OwnerOutboxNativeSource =
        serde_json::from_str(&source).map_err(|_| ApplicationError::Corrupt)?;
    Ok(Some(OwnDraft {
        author: source
            .native_author()
            .map_err(|_| ApplicationError::Corrupt)?,
        declaration: crate::owner_outbox::stored_declaration(declaration)
            .map_err(|_| ApplicationError::Corrupt)?,
    }))
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
    let mut query = conn.prepare("SELECT workspace_id,delivery_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,update_digest,update_byte_length,journal_cursor,accepting_host_epoch,principal_kind,principal_id,grant_id,grant_generation,received_at_ms,first_seen_count,local_ydoc_sequence,applied_host_id,applied_host_epoch,applied_instance_id,applied_connection_id,admitted_metadata_json FROM live_device_update_applications WHERE relay_database_namespace=?1 AND (delivery_id=?2 OR journal_cursor=?3)").map_err(read_sql)?;
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
    let retained_metadata: Option<String> = row.get(23).map_err(read_sql)?;
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
    let mut event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt,
                binding,
                authority,
                received_at_ms,
            },
            first_seen,
            canonical_version: None,
            author_snapshot: None,
            first_seen_deletes: None,
            checkpoint_coverage: None,
        },
        update_bytes,
    };
    if let Some(json) = retained_metadata {
        let metadata: AdmittedLiveUpdateMetadata =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        if metadata.accepted != event.metadata.accepted
            || metadata.first_seen != event.metadata.first_seen
        {
            return Err(ApplicationError::Corrupt);
        }
        event.metadata = metadata;
    }
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
        if ranges.len() as u64 >= count as u64 {
            return Err(ApplicationError::Corrupt);
        }
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
    let native_sql = "SELECT a.delivery_id,a.first_seen_count,f.workspace_id,f.ordinal,f.client_id,f.start_clock,f.end_clock FROM live_device_update_applications a LEFT JOIN live_device_application_first_seen f ON f.relay_database_namespace=a.relay_database_namespace AND f.delivery_id=a.delivery_id WHERE a.relay_database_namespace=?1 AND a.workspace_id=?2 AND a.main_version_id=?3 AND a.object_id=?4 AND a.lineage_claim_id=?5 ORDER BY f.client_id,f.start_clock,a.delivery_id,f.ordinal";
    let mut query = conn.prepare(native_sql).map_err(read_sql)?;
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
    // admitted_metadata_json contains the private link principal and grant. Never export it.
    // Author readers (A2b/B) must read only the author snapshot.
    let a = &event.metadata.accepted;
    let b = &a.binding;
    let c = &r.coordinate;
    let (kind, principal, grant, generation) = a.authority.fields();
    tx.execute("INSERT INTO live_device_update_applications (relay_database_namespace,workspace_id,delivery_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,update_digest,update_byte_length,journal_cursor,accepting_host_epoch,principal_kind,principal_id,grant_id,grant_generation,received_at_ms,first_seen_count,local_ydoc_sequence,applied_host_id,applied_host_epoch,applied_instance_id,applied_connection_id,admitted_metadata_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)",
        params![r.namespace,b.workspace_id,a.receipt.delivery_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.current_path,serde_json::to_string(&b.selector_paths).map_err(|_| invalid("selector JSON"))?,b.restore_fence_generation,a.receipt.update_digest,event.update_bytes.len() as i64,a.receipt.journal_cursor,a.receipt.accepting_host_epoch,kind,principal,grant,generation,a.received_at_ms,event.metadata.first_seen.len() as i64,sequence,c.host_id,c.host_epoch,c.instance_id,c.connection_id,serde_json::to_string(&event.metadata).map_err(|_| invalid("admitted metadata JSON"))?]).map_err(write_sql)?;
    for (ordinal, range) in event.metadata.first_seen.iter().enumerate() {
        tx.execute("INSERT INTO live_device_application_first_seen (relay_database_namespace,workspace_id,delivery_id,ordinal,client_id,start_clock,end_clock) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![r.namespace,b.workspace_id,a.receipt.delivery_id,ordinal as i64,range.client_id,range.start_clock,range.end_clock]).map_err(write_sql)?;
    }
    Ok(())
}

impl From<CollabError> for ApplicationError {
    fn from(error: CollabError) -> Self {
        match error {
            CollabError::ConfiguredByteBudgetExceeded => Self::ConfiguredByteBudgetExceeded,
            error => Self::Collab(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ContentKind, Ydoc};
    use dohc_engine_storage::put_binary_blob_with_sha;
    use dohc_test_scratch::ScratchDir;

    struct Crash(dohc_engine_storage::FaultPoint);
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
                canonical_version: None,
                author_snapshot: None,
                first_seen_deletes: None,
                checkpoint_coverage: None,
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
        apply_committed(
            store,
            cache,
            handle,
            event,
            &NoFaults,
            100_000_000,
            |_, _, _, _| Ok(()),
        )
        .unwrap()
    }
    fn ack(result: ApplicationResult) -> LiveUpdateHostApplicationAck {
        match result {
            ApplicationResult::Applied(ack, _) => ack,
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

    #[test]
    fn owner_admission_without_authorship_does_not_invent_a_human_author() {
        for canonical in [false, true] {
            let (_dir, mut store, mut cache, _owner, handle) = fixture();
            let source = Ydoc::wire();
            let mut update = event(
                "owner-unknown-author",
                1,
                source.plaintext_insert(0, "text"),
            );
            if canonical {
                update.metadata.canonical_version = Some(2);
                update.metadata.author_snapshot = Some(vec![]);
                update.metadata.first_seen_deletes = Some(vec![]);
            }
            ack(apply(&mut store, &mut cache, &handle, update));
            let author: (Option<String>, Option<String>) = store.read_with(|conn| conn.query_row(
                "SELECT actor_origin_id,actor_kind FROM ydoc_updates WHERE workspace_id='workspace-1' AND version_id='main' AND object_id='object-1' AND seq=1",
                [], |row| Ok((row.get(0)?,row.get(1)?)),
            )).unwrap();
            assert_eq!(author, (None, None));
        }
    }

    #[test]
    fn admitted_metadata_v1_bytes_and_v2_digest_versions() {
        let source = Ydoc::wire();
        let legacy = event("versioned", 1, source.plaintext_insert(0, "text"));
        let json = serde_json::to_string(&legacy.metadata).unwrap();
        assert!(json.ends_with(",\"firstSeen\":[]}"));
        assert!(!json.contains("canonicalVersion"));
        let expected = hex_sha256(
            &serde_json::to_vec(&("accepted-event-v1", "previous", 1, &legacy.metadata)).unwrap(),
        );
        assert_eq!(
            accepted_history::next_digest("previous", 1, &legacy.metadata).unwrap(),
            expected
        );
        let mut modern = legacy.metadata.clone();
        modern.canonical_version = Some(2);
        modern.author_snapshot = Some(vec![LiveAuthorEntry::Human {
            human_id: "alice".into(),
            human_name: "Alice".into(),
        }]);
        modern.first_seen_deletes = Some(vec![]);
        assert!(accepted_history::require_version_transition(&legacy.metadata, &modern).is_ok());
        assert!(accepted_history::require_version_transition(&modern, &legacy.metadata).is_err());
        let expected = hex_sha256(
            &serde_json::to_vec(&("accepted-event-v2", "previous", 1, &modern)).unwrap(),
        );
        assert_eq!(
            accepted_history::next_digest("previous", 1, &modern).unwrap(),
            expected
        );
        let mut malformed = serde_json::to_value(&modern).unwrap();
        malformed["firstSeenDeletes"] = Value::Null;
        assert!(parse_admitted_metadata(malformed).is_err());
    }

    #[test]
    fn v2_receipt_retains_metadata_and_rejects_renamed_retries() {
        let (_dir, mut store, mut cache, _owner, handle) = fixture();
        let source = Ydoc::wire();
        let mut update = event("v2-retry", 1, source.plaintext_insert(0, "text"));
        update.metadata.canonical_version = Some(2);
        update.metadata.author_snapshot = Some(vec![LiveAuthorEntry::Human {
            human_id: "alice".into(),
            human_name: "Alice".into(),
        }]);
        update.metadata.first_seen_deletes = Some(vec![]);
        assert!(!ack(apply(&mut store, &mut cache, &handle, update.clone())).application_replayed);
        assert!(ack(apply(&mut store, &mut cache, &handle, update.clone())).application_replayed);
        let retained = store
            .read_with(|conn| read_application(conn, "relay-A", &update.metadata.accepted.receipt))
            .unwrap()
            .unwrap();
        assert_eq!(retained.event.metadata, update.metadata);
        update.metadata.author_snapshot = Some(vec![LiveAuthorEntry::Human {
            human_id: "alice".into(),
            human_name: "Renamed".into(),
        }]);
        let result = apply_committed(
            &mut store,
            &mut cache,
            &handle,
            update,
            &NoFaults,
            100_000_000,
            |_, _, _, _| Ok(()),
        );
        assert!(matches!(result, Err(ApplicationError::Conflict)));
    }

    #[test]
    fn ack_read_preserves_historical_identity_after_restart_without_mutation() {
        let (dir, mut store, mut cache, owner, handle) = fixture();
        let source = Ydoc::wire();
        let first = event("ack-first", 1, source.plaintext_insert(0, "first"));
        let identity = LiveApplicationAckIdentity {
            delivery_id: first.metadata.accepted.receipt.delivery_id.clone(),
            update_digest: first.metadata.accepted.receipt.update_digest.clone(),
        };
        assert!(read_application_ack(&store, &handle, &identity)
            .unwrap()
            .is_none());
        let mut expected = ack(apply(&mut store, &mut cache, &handle, first));
        expected.application_replayed = true;
        apply(
            &mut store,
            &mut cache,
            &handle,
            event("ack-next", 2, source.plaintext_insert(5, " next")),
        );
        assert_eq!(
            read_application_ack(&store, &handle, &identity).unwrap(),
            Some(expected.clone())
        );
        drop(handle);
        drop(owner);
        drop(store);
        let mut store = EngineStore::open(&dir.join("engine.db"), 0).unwrap();
        let mut owner = ApplicationOwner::new("workspace-1".into()).unwrap();
        let mut next = coordinate("new-connection");
        next.host_epoch = 3;
        let handle = owner
            .register(&mut store, "relay-A".into(), next, binding())
            .unwrap();
        let before = document(&store).encode_full_state();
        let count_before = count(&store, "live_device_update_applications");
        assert_eq!(
            read_application_ack(&store, &handle, &identity).unwrap(),
            Some(expected.clone())
        );
        assert_eq!(expected.accepting_host_epoch, 1);
        assert_eq!(expected.local_ydoc_sequence, 1);
        assert_eq!(document(&store).encode_full_state(), before);
        assert_eq!(
            count(&store, "live_device_update_applications"),
            count_before
        );
        let absent = LiveApplicationAckIdentity {
            delivery_id: "absent".into(),
            update_digest: identity.update_digest.clone(),
        };
        assert!(read_application_ack(&store, &handle, &absent)
            .unwrap()
            .is_none());
        let wrong_digest = LiveApplicationAckIdentity {
            update_digest: "00".repeat(32),
            ..identity.clone()
        };
        assert!(matches!(
            read_application_ack(&store, &handle, &wrong_digest),
            Err(ApplicationError::Conflict)
        ));
        owner.invalidate(&mut store).unwrap();
        assert!(read_application_ack(&store, &handle, &identity).is_err());
    }

    #[test]
    fn ack_read_refuses_foreign_binding_generation_namespace_and_corrupt_sequence() {
        let (_dir, mut store, mut cache, mut owner, handle) = fixture();
        let update = event("ack-bound", 1, Ydoc::wire().plaintext_insert(0, "bound"));
        let identity = LiveApplicationAckIdentity {
            delivery_id: update.metadata.accepted.receipt.delivery_id.clone(),
            update_digest: update.metadata.accepted.receipt.update_digest.clone(),
        };
        apply(&mut store, &mut cache, &handle, update);
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE live_device_update_applications SET local_ydoc_sequence=2",
                    [],
                )
                .unwrap();
                Ok::<_, StorageError>(())
            })
            .unwrap();
        assert!(matches!(
            read_application_ack(&store, &handle, &identity),
            Err(ApplicationError::Corrupt)
        ));
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE live_device_update_applications SET local_ydoc_sequence=1",
                    [],
                )
                .unwrap();
                Ok::<_, StorageError>(())
            })
            .unwrap();
        let mut generation = binding();
        generation.restore_fence_generation = 8;
        let replacement = owner
            .register(
                &mut store,
                "relay-A".into(),
                coordinate("connection-1"),
                generation,
            )
            .unwrap();
        assert!(matches!(
            read_application_ack(&store, &replacement, &identity),
            Err(ApplicationError::Conflict)
        ));
        let other_namespace = owner
            .register(
                &mut store,
                "relay-B".into(),
                coordinate("connection-2"),
                binding(),
            )
            .unwrap();
        assert!(read_application_ack(&store, &other_namespace, &identity)
            .unwrap()
            .is_none());
        let current = owner
            .register(
                &mut store,
                "relay-A".into(),
                coordinate("connection-3"),
                binding(),
            )
            .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE live_device_update_applications SET object_id='another-object'",
                    [],
                )
                .unwrap();
                Ok::<_, StorageError>(())
            })
            .unwrap();
        assert!(matches!(
            read_application_ack(&store, &current, &identity),
            Err(ApplicationError::Conflict)
        ));
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE live_device_application_bindings SET available=0",
                    [],
                )
                .unwrap();
                Ok::<_, StorageError>(())
            })
            .unwrap();
        assert!(matches!(
            read_application_ack(&store, &current, &identity),
            Err(ApplicationError::Interrupted)
        ));
    }

    #[test]
    fn ack_read_accepts_different_covering_selectors_and_refuses_damaged_history() {
        let (dir, mut store, mut cache, mut owner, handle) = fixture();
        let update = event(
            "selector-ack",
            1,
            Ydoc::wire().plaintext_insert(0, "retained"),
        );
        let identity = LiveApplicationAckIdentity {
            delivery_id: update.metadata.accepted.receipt.delivery_id.clone(),
            update_digest: update.metadata.accepted.receipt.update_digest.clone(),
        };
        let mut expected = ack(apply(&mut store, &mut cache, &handle, update));
        expected.application_replayed = true;
        let mut unrelated = binding();
        unrelated.selector_paths = vec!["elsewhere".into()];
        let outside = owner
            .register(
                &mut store,
                "relay-A".into(),
                coordinate("outside-selector"),
                unrelated,
            )
            .unwrap();
        assert!(read_application_ack(&store, &outside, &identity).is_err());
        let mut broader = binding();
        broader.selector_paths = vec!["notes".into()];
        let current = owner
            .register(
                &mut store,
                "relay-A".into(),
                coordinate("named-reader"),
                broader,
            )
            .unwrap();
        assert_eq!(
            read_application_ack(&store, &current, &identity).unwrap(),
            Some(expected.clone())
        );
        drop(handle);
        drop(current);
        drop(owner);
        drop(store);
        let mut store = EngineStore::open(&dir.join("engine.db"), 0).unwrap();
        let mut owner = ApplicationOwner::new("workspace-1".into()).unwrap();
        let current = owner
            .register(
                &mut store,
                "relay-A".into(),
                coordinate("after-restart"),
                binding(),
            )
            .unwrap();
        let before = document(&store).encode_full_state();
        for saved in ["[\"notes\"]", "[\"notes\",\"notes/a.md\"]"] {
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "UPDATE live_device_update_applications SET selector_paths_json=?1",
                        [saved],
                    )
                    .unwrap();
                    Ok::<_, StorageError>(())
                })
                .unwrap();
            assert_eq!(
                read_application_ack(&store, &current, &identity).unwrap(),
                Some(expected.clone())
            );
        }
        let oversized = format!("[\"{}\"]", "a".repeat(ack_read::MAX_SELECTOR_JSON_BYTES));
        for (saved, expected_error) in [
            ("[]", ApplicationError::Corrupt),
            ("[1]", ApplicationError::Corrupt),
            ("[\"elsewhere\"]", ApplicationError::Conflict),
            ("[\"notes/a.md\",\"notes\"]", ApplicationError::Corrupt),
            ("[\"notes\",\"notes\"]", ApplicationError::Corrupt),
            ("[\"notes/../elsewhere\"]", ApplicationError::Corrupt),
            (oversized.as_str(), ApplicationError::Corrupt),
        ] {
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "UPDATE live_device_update_applications SET selector_paths_json=?1",
                        [saved],
                    )
                    .unwrap();
                    Ok::<_, StorageError>(())
                })
                .unwrap();
            assert_eq!(
                std::mem::discriminant(
                    &read_application_ack(&store, &current, &identity).unwrap_err()
                ),
                std::mem::discriminant(&expected_error),
                "{saved:.80}"
            );
        }
        assert_eq!(document(&store).encode_full_state(), before);
        assert_eq!(count(&store, "live_device_update_applications"), 1);
    }

    #[test]
    fn ack_read_refuses_an_active_restore_fence_even_with_a_retained_application() {
        let (_dir, mut store, mut cache, _owner, handle) = fixture();
        let update = event("fenced-ack", 1, Ydoc::wire().plaintext_insert(0, "draft"));
        let identity = LiveApplicationAckIdentity {
            delivery_id: "fenced-ack".into(),
            update_digest: update.metadata.accepted.receipt.update_digest.clone(),
        };
        apply(&mut store, &mut cache, &handle, update);
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES ('workspace-1','main','object-1','relay-A','stopped',?1,'{}')",
                [serde_json::json!({"oldBinding":binding(),"newFence":8}).to_string()]).unwrap();
            Ok::<_,StorageError>(())
        }).unwrap();
        assert!(matches!(
            read_application_ack(&store, &handle, &identity),
            Err(ApplicationError::Collab(CollabError::RestoreFenced))
        ));
        assert_eq!(count(&store, "live_device_update_applications"), 1);
    }
    fn reopen(store: EngineStore, dir: &ScratchDir) -> EngineStore {
        drop(store);
        EngineStore::open(&dir.join("engine.db"), 20).unwrap()
    }

    fn declared(agent_id: &str) -> Option<AgentDeclaration> {
        Some(AgentDeclaration {
            agent_id: agent_id.into(),
            on_behalf_of: Some("owner-1".into()),
            depth: 1,
        })
    }

    fn snapshot(metadata: &mut AdmittedLiveUpdateMetadata, declaration: Option<AgentDeclaration>) {
        metadata.canonical_version = Some(2);
        metadata.author_snapshot =
            Some(declaration.into_iter().map(LiveAuthorEntry::from).collect());
        metadata.first_seen_deletes = Some(vec![]);
    }

    #[test]
    fn declared_delivery_replays_after_reopen_and_refuses_a_changed_declaration() {
        let (dir, mut store, mut cache, _owner, handle) = fixture();
        let source = Ydoc::wire();
        let mut agent = event("agent", 1, source.plaintext_insert(0, "agent"));
        snapshot(&mut agent.metadata, declared("trip-agent 旅行"));
        let person = event("person", 2, source.plaintext_insert(5, " person"));
        let first = ack(apply(&mut store, &mut cache, &handle, agent.clone()));
        ack(apply(&mut store, &mut cache, &handle, person.clone()));
        let refused =
            |store: &mut EngineStore, cache: &mut WriterDocCache, update: &AdmittedLiveUpdate| {
                apply_committed(
                    store,
                    cache,
                    &handle,
                    update.clone(),
                    &NoFaults,
                    100_000_000,
                    |_, _, _, _| Ok(()),
                )
            };
        let mut changed = vec![agent.clone(), agent.clone(), agent.clone(), person.clone()];
        snapshot(&mut changed[0].metadata, declared("other-agent"));
        snapshot(&mut changed[1].metadata, None);
        if let LiveAuthorEntry::Agent { depth, .. } =
            &mut changed[2].metadata.author_snapshot.as_mut().unwrap()[0]
        {
            *depth = Some(2);
        }
        snapshot(&mut changed[3].metadata, declared("trip-agent 旅行"));
        store = reopen(store, &dir);
        for update in &changed {
            assert!(matches!(
                refused(&mut store, &mut cache, update),
                Err(ApplicationError::Conflict)
            ));
        }
        let mut expected = first;
        expected.application_replayed = true;
        assert_eq!(ack(apply(&mut store, &mut cache, &handle, agent)), expected);
        assert!(ack(apply(&mut store, &mut cache, &handle, person)).application_replayed);
        let stored: String = store.read_with(|conn| conn.query_row(
            "SELECT admitted_metadata_json FROM live_device_update_applications WHERE delivery_id='agent'", [], |row| row.get(0)
        )).unwrap();
        let metadata: AdmittedLiveUpdateMetadata = serde_json::from_str(&stored).unwrap();
        assert_eq!(metadata.admitted_declaration(), declared("trip-agent 旅行"));
        store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE live_device_update_applications SET admitted_metadata_json='{}' WHERE delivery_id='agent'", []).unwrap();
            Ok::<_, StorageError>(())
        }).unwrap();
        assert!(matches!(
            refused(&mut store, &mut cache, &changed[1]),
            Err(ApplicationError::Corrupt)
        ));
    }

    fn deliver_declared(
        store: &mut EngineStore,
        cache: &mut WriterDocCache,
        handle: &ApplicationHandle,
        cursor: i64,
        bytes: Vec<u8>,
        declaration: &AgentDeclaration,
    ) -> Result<ApplicationResult, ApplicationError> {
        let mut update = event(&format!("declared-{cursor}"), cursor, bytes);
        snapshot(&mut update.metadata, Some(declaration.clone()));
        apply_committed(
            store,
            cache,
            handle,
            update,
            &NoFaults,
            100_000_000,
            |_, _, _, _| Ok(()),
        )
    }

    fn interval_len(store: &EngineStore) -> usize {
        store
            .read_with(|conn| crate::author_coverage::interval_in(conn, &key(), i64::MAX))
            .unwrap()
            .len()
    }

    #[test]
    fn empty_snapshot_credits_content_but_not_no_op_deliveries() {
        for content in ["none", "structs", "deletes"] {
            let (_dir, mut store, mut cache, _owner, handle) = fixture();
            let mut update = event("empty-snapshot", 1, Ydoc::wire().encode_full_state());
            snapshot(&mut update.metadata, None);
            update.metadata.author_snapshot = Some(vec![]);
            let range = LiveUpdateStructRange {
                client_id: 7,
                start_clock: 0,
                end_clock: 1,
            };
            match content {
                "structs" => update.metadata.first_seen.push(range),
                "deletes" => update.metadata.first_seen_deletes = Some(vec![range]),
                _ => {}
            }
            ack(apply(&mut store, &mut cache, &handle, update.clone()));
            assert_eq!(
                interval_len(&store),
                usize::from(content != "none"),
                "{content}"
            );
            assert!(ack(apply(&mut store, &mut cache, &handle, update)).application_replayed);
            assert_eq!(
                interval_len(&store),
                usize::from(content != "none"),
                "replay {content}"
            );
        }
    }

    /// Accepted deliveries' declared agents and local edits' authors share
    /// one interval and its bounds. At the boundary a new identity of either
    /// kind is refused before any write, even for a delivery whose bytes
    /// deduplicate natively; a known identity still applies. While an earlier
    /// moment reserves its authors, settling cannot help, so the delivery
    /// fails instead of asking for a settlement.
    #[test]
    fn declared_and_local_authors_share_one_interval_bound() {
        let (_dir, mut store, mut cache, _owner, handle) = fixture();
        // Escaped quotes make each author as large as the contract allows.
        let large = |index: usize| AgentDeclaration {
            agent_id: format!("{index:03}{}", "\"".repeat(509)),
            on_behalf_of: Some("\"".repeat(512)),
            depth: 1,
        };
        // Every delivery after the first carries the first's bytes again.
        let bytes = Ydoc::wire().plaintext_insert(0, "x");
        let mut admitted = 0;
        let refused = loop {
            assert!(admitted < 80, "the author bound never refused");
            let cursor = admitted as i64 + 1;
            match deliver_declared(
                &mut store,
                &mut cache,
                &handle,
                cursor,
                bytes.clone(),
                &large(admitted),
            )
            .unwrap()
            {
                ApplicationResult::Applied(..) => admitted += 1,
                ApplicationResult::Pending(ApplicationPending::SettlementRequired) => {
                    break cursor;
                }
                other => panic!("unexpected {other:?}"),
            }
        };
        assert!(admitted > 1);
        let unchanged = |store: &EngineStore| {
            (
                count(store, "live_device_update_applications"),
                count(store, "ydoc_updates"),
                interval_len(store),
            )
        };
        let before = unchanged(&store);
        assert_eq!(before, (admitted as i64, 1, admitted));

        // A local edit by a new identity meets the same full interval.
        let local = large(999);
        let attribution = local.attribution();
        let append =
            |store: &mut EngineStore, cache: &mut WriterDocCache, actor: &str, text: &str| {
                durable::record_local_update(
                    store,
                    cache,
                    &key(),
                    &Ydoc::wire().plaintext_insert(0, text),
                    durable::LocalAppend {
                        actor_origin_id: Some(actor),
                        attribution: Some(&attribution),
                        ..Default::default()
                    },
                    &NoFaults,
                    1,
                    |_, _, _| Ok(()),
                )
            };
        assert!(matches!(
            append(&mut store, &mut cache, &local.agent_id, "new"),
            Err(CollabError::AuthorCapacity)
        ));
        assert_eq!(unchanged(&store), before);
        // A local edit by an agent a delivery already declared applies.
        append(&mut store, &mut cache, &large(0).agent_id, "known").unwrap();
        assert_eq!(interval_len(&store), admitted);

        // While an earlier moment's file write is unresolved, a settlement
        // cannot release the interval: the delivery fails and writes nothing.
        let at_refusal = unchanged(&store);
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET settle_prior_update_seq=-1", [])
                    .map_err(write_sql)
            })
            .unwrap();
        assert!(matches!(
            deliver_declared(
                &mut store,
                &mut cache,
                &handle,
                refused,
                bytes.clone(),
                &large(admitted)
            ),
            Err(ApplicationError::MaterializationPending)
        ));
        assert_eq!(unchanged(&store), at_refusal);

        // A settlement that resolves releases the interval, and the same
        // refused delivery then applies and names only its agent.
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET settle_prior_update_seq=NULL", [])
                    .map_err(write_sql)?;
                crate::author_coverage::advance_in(tx, &key(), false)?;
                Ok::<_, ApplicationError>(())
            })
            .unwrap();
        assert!(matches!(
            deliver_declared(
                &mut store,
                &mut cache,
                &handle,
                refused,
                bytes,
                &large(admitted)
            )
            .unwrap(),
            ApplicationResult::Applied(..)
        ));
        assert_eq!(interval_len(&store), 1);
    }

    #[test]
    fn accepted_headers_refuse_parallel_declarations() {
        let owner = event("owner", 1, Ydoc::wire().plaintext_insert(0, "x"));
        let mut value = serde_json::to_value(owner.metadata).unwrap();
        value["accepted"]["agentDeclaration"] =
            serde_json::json!({"agentId":"agent","onBehalfOf":null,"depth":0});
        assert!(parse_admitted_metadata(value).is_err());
    }

    #[test]
    fn draft_snapshot_omission_is_allowed_but_present_agent_must_match() {
        let mut metadata = event("owner", 1, Ydoc::wire().plaintext_insert(0, "x")).metadata;
        snapshot(&mut metadata, None);
        assert!(metadata.matches_draft_declaration(declared("agent").as_ref()));
        snapshot(&mut metadata, declared("agent"));
        assert!(metadata.matches_draft_declaration(declared("agent").as_ref()));
        assert!(!metadata.matches_draft_declaration(declared("other").as_ref()));
        assert!(!metadata.matches_draft_declaration(None));
        for authority in [
            ServerDerivedLiveUpdateAuthority::Named {
                principal_id: "owner-1".into(),
                grant_id: "grant".into(),
                grant_generation: 1,
            },
            ServerDerivedLiveUpdateAuthority::Link {
                principal_id: "owner-1".into(),
                grant_id: "grant".into(),
                grant_generation: 1,
            },
        ] {
            metadata.accepted.authority = authority;
            assert!(!metadata.matches_draft_declaration(declared("agent").as_ref()));
            snapshot(&mut metadata, None);
            assert!(!metadata.matches_draft_declaration(declared("agent").as_ref()));
            snapshot(&mut metadata, declared("agent"));
        }
    }

    #[test]
    fn automation_snapshot_requires_exact_draft_provenance() {
        let mut metadata = event("owner", 1, Ydoc::wire().plaintext_insert(0, "x")).metadata;
        let declaration = dohc_engine_domain::AutomationDeclaration {
            automation_id: "collection:Tasks#mark".into(),
            attribution: dohc_engine_domain::ChangeAttribution {
                actor_kind: dohc_engine_domain::ChangeActorKind::Automation,
                on_behalf_of: Some("presser".into()),
                depth: 1,
                run: None,
            },
        };
        snapshot(&mut metadata, None);
        assert!(!metadata.matches_automation_declaration(Some(&declaration)));
        metadata.author_snapshot = Some(vec![LiveAuthorEntry::Automation {
            automation_id: declaration.automation_id.clone(),
            attribution: declaration.attribution.clone(),
        }]);
        metadata.validate_extensions().unwrap();
        assert!(metadata.matches_automation_declaration(Some(&declaration)));
        assert!(!metadata.matches_automation_declaration(None));
        let mut changed = declaration.clone();
        changed.attribution.on_behalf_of = Some("other".into());
        assert!(!metadata.matches_automation_declaration(Some(&changed)));
        metadata
            .author_snapshot
            .as_mut()
            .unwrap()
            .push(LiveAuthorEntry::from(declared("agent").unwrap()));
        assert!(metadata.validate_extensions().is_err());
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
                let result = apply_committed(
                    &mut store,
                    &mut cache,
                    &handle,
                    update.clone(),
                    &NoFaults,
                    100_000_000,
                    |_, _, _, _| Ok(()),
                );
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
    fn live_application_ended_without_settle_preserves_local_tail() {
        let (dir, mut store, mut cache, owner, handle) = fixture();
        let producer = Ydoc::wire();
        let initial = ack(apply(
            &mut store,
            &mut cache,
            &handle,
            event("unsettled", 1, producer.plaintext_insert(0, "local draft")),
        ));
        drop(owner);
        store = reopen(store, &dir);
        let (tail, settled): (i64, i64) =
            store
                .read_with(|conn| {
                    conn.query_row(
            "SELECT last_local_update_seq,COALESCE(settled_update_seq,0) FROM ydoc_docs", [],
            |row| Ok((row.get(0)?,row.get(1)?)))
                })
                .unwrap();
        assert_eq!(tail, initial.local_ydoc_sequence);
        assert!(
            tail > settled,
            "recovery must wait for this device's open-time settle"
        );
        assert_eq!(
            count(&store, "moments"),
            0,
            "the application did not publish a file"
        );
        assert_eq!(
            document(&store)
                .project(ContentKind::Plaintext)
                .unwrap()
                .content,
            "local draft"
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
    fn historical_byte_delivery_preserves_its_original_update_sequence() {
        let (_dir, mut store, mut cache, _owner, handle) = fixture();
        let producer = Ydoc::wire();
        let first_bytes = producer.plaintext_insert(0, "first");
        let first = event("first", 1, first_bytes.clone());
        let initial = ack(apply(&mut store, &mut cache, &handle, first.clone()));
        let later = producer.plaintext_insert(5, " later");
        let head = ack(apply(
            &mut store,
            &mut cache,
            &handle,
            event("later", 2, later),
        ));
        assert!(head.local_ydoc_sequence > initial.local_ydoc_sequence);
        let deduped = ack(apply(
            &mut store,
            &mut cache,
            &handle,
            event("historical", 3, first_bytes),
        ));
        assert_eq!(deduped.local_ydoc_sequence, initial.local_ydoc_sequence);
        assert!(!deduped.application_replayed);
        let replay = ack(apply(&mut store, &mut cache, &handle, first));
        assert!(replay.application_replayed);
        assert_eq!(replay.local_ydoc_sequence, initial.local_ydoc_sequence);
        assert_eq!(count(&store, "ydoc_updates"), 2);
    }

    #[test]
    fn missing_insert_and_delete_roll_back_fresh_and_parked_deduped_attempts() {
        assert_missing_dependencies_recover(false);
    }

    #[test]
    fn missing_insert_and_delete_recover_after_commit_before_ack() {
        assert_missing_dependencies_recover(true);
    }

    fn assert_missing_dependencies_recover(crash_after_commit: bool) {
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
                if crash_after_commit {
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
                            &Crash(dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck),
                            100_000_000,
                            |_, _, _, _| Ok(())
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
                } else {
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
            apply_committed(
                &mut store,
                &mut cache,
                &handle,
                wrong,
                &NoFaults,
                100_000_000,
                |_, _, _, _| Ok(())
            ),
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
                &NoFaults,
                100_000_000,
                |_, _, _, _| Ok(())
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
            apply_committed(
                &mut store,
                &mut cache,
                &handle,
                collision,
                &NoFaults,
                100_000_000,
                |_, _, _, _| Ok(())
            ),
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
            first.metadata.first_seen = vec![
                LiveUpdateStructRange {
                    client_id: 2,
                    start_clock: 0,
                    end_clock: 1,
                },
                LiveUpdateStructRange {
                    client_id: 4,
                    start_clock: 0,
                    end_clock: 1,
                },
            ];
            let mut second = event("second", 2, vec![0, 0]);
            second.metadata.first_seen = vec![
                LiveUpdateStructRange {
                    client_id: 2,
                    start_clock: 1,
                    end_clock: 2,
                },
                LiveUpdateStructRange {
                    client_id: 3,
                    start_clock: 0,
                    end_clock: 1,
                },
            ];
            ack(apply(&mut store, &mut cache, &handle, first.clone()));
            ack(apply(&mut store, &mut cache, &handle, second));
            let mut conflict = event("conflict", 3, vec![0, 0]);
            conflict.metadata.first_seen = vec![LiveUpdateStructRange {
                client_id: 3,
                start_clock: 0,
                end_clock: 1,
            }];
            assert!(matches!(
                apply_committed(
                    &mut store,
                    &mut cache,
                    &handle,
                    conflict,
                    &NoFaults,
                    100_000_000,
                    |_, _, _, _| Ok(())
                ),
                Err(ApplicationError::Conflict)
            ));
            store
                .read_with(|conn| {
                    conn.execute_batch(&format!(
                        "PRAGMA foreign_keys=OFF; {damage}; PRAGMA foreign_keys=ON"
                    ))
                })
                .unwrap();
            let before = count(&store, "ydoc_updates");
            assert!(
                matches!(
                    apply_committed(
                        &mut store,
                        &mut cache,
                        &handle,
                        event("noop", 3, vec![0, 0]),
                        &NoFaults,
                        100_000_000,
                        |_, _, _, _| Ok(())
                    ),
                    Err(ApplicationError::Corrupt)
                ),
                "{damage}"
            );
            assert_eq!(count(&store, "ydoc_updates"), before);
            if damage.contains("workspace_id='damaged'") {
                assert!(matches!(
                    apply_committed(
                        &mut store,
                        &mut cache,
                        &handle,
                        first,
                        &NoFaults,
                        100_000_000,
                        |_, _, _, _| Ok(())
                    ),
                    Err(ApplicationError::Corrupt)
                ));
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
                    apply_committed(
                        &mut store,
                        &mut cache,
                        &handle,
                        changed,
                        &NoFaults,
                        100_000_000,
                        |_, _, _, _| Ok(())
                    ),
                    Ok(ApplicationResult::Applied(..))
                ),
                "{pointer}"
            );
        }
        let mut changed_bytes = original.clone();
        changed_bytes.update_bytes = vec![0, 0];
        changed_bytes.metadata.accepted.receipt.update_digest =
            hex_sha256(&changed_bytes.update_bytes);
        assert!(matches!(
            apply_committed(
                &mut store,
                &mut cache,
                &handle,
                changed_bytes,
                &NoFaults,
                100_000_000,
                |_, _, _, _| Ok(())
            ),
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
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute_batch(damage).unwrap();
                    Ok::<_, StorageError>(())
                })
                .unwrap();
            assert!(
                !matches!(
                    apply_committed(
                        &mut store,
                        &mut cache,
                        &handle,
                        update,
                        &NoFaults,
                        100_000_000,
                        |_, _, _, _| Ok(())
                    ),
                    Ok(ApplicationResult::Applied(..))
                ),
                "{damage}"
            );
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
            assert!(apply_committed(
                &mut store,
                &mut cache,
                &handle,
                update,
                &NoFaults,
                100_000_000,
                |_, _, _, _| Ok(())
            )
            .is_err());
            store = reopen(store, &dir);
            assert_eq!(count(&store, "ydoc_updates"), 0);
            assert_eq!(count(&store, "live_device_update_applications"), 0);
            assert_eq!(count(&store, "live_device_application_first_seen"), 0);
        }
    }

    #[test]
    fn raw_audit_damage_cannot_disappear_through_normalization() {
        for damage in [
            "UPDATE live_device_update_applications SET selector_paths_json='[\"notes/a.md\",\"notes/a.md\"]'",
            "UPDATE live_device_update_applications SET first_seen_count=1",
            "UPDATE live_device_update_applications SET update_byte_length=999",
            "UPDATE live_device_update_applications SET principal_kind='named',grant_id='g',grant_generation=1",
        ] {
            let (_dir, mut store, mut cache, _owner, handle) = fixture();
            let update = event("stored", 1, Ydoc::wire().plaintext_insert(0, "x"));
            ack(apply(&mut store, &mut cache, &handle, update.clone()));
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute_batch(damage).unwrap();
                    Ok::<_, StorageError>(())
                })
                .unwrap();
            assert!(
                apply_committed(
                    &mut store,
                    &mut cache,
                    &handle,
                    update,
                    &NoFaults,
                    100_000_000,
                    |_, _, _, _| Ok(())
                )
                .is_err(),
                "{damage}"
            );
        }
    }

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
                    &Crash(point),
                    100_000_000,
                    |_, _, _, _| Ok(())
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

    /// The session host counts every accepted frame it commits as a change
    /// from elsewhere, once, except a frame that is this computer's own
    /// draft.
    #[test]
    fn the_session_host_counts_frames_from_elsewhere_once() {
        let (_dir, mut store, mut cache, _owner, handle) = fixture();
        let remote_changes = |store: &EngineStore| {
            store
                .read_with(|conn| {
                    dohc_engine_storage::remote_changes_applied_in(conn, "workspace-1")
                })
                .unwrap()
        };
        let source = Ydoc::wire();
        let own = source.plaintext_insert(0, "own");
        let draft = crate::owner_outbox::append(
            &mut store,
            "workspace-1",
            crate::owner_outbox::OwnerOutboxAppendInput {
                binding: binding(),
                base_update: Ydoc::wire().encode_full_state(),
                append_key: "own-draft".into(),
                update: own.clone(),
                limits: crate::owner_outbox::OwnerOutboxLimits {
                    max_pending_bytes: 10_000,
                    max_pending_age_ms: 10_000,
                },
                created_at_ms: 1,
            },
        )
        .unwrap();
        ack(apply(
            &mut store,
            &mut cache,
            &handle,
            event(&draft.delivery_id, 1, own),
        ));
        assert_eq!(remote_changes(&store), 0, "this computer's own draft");

        let other = event("other", 2, source.plaintext_insert(3, " other"));
        ack(apply(&mut store, &mut cache, &handle, other.clone()));
        assert_eq!(remote_changes(&store), 1, "a frame from elsewhere");
        assert!(ack(apply(&mut store, &mut cache, &handle, other)).application_replayed);
        assert_eq!(remote_changes(&store), 1, "a replayed frame counts once");
    }

    /// A person the owner shared with, or a link holder, whose client sent
    /// recording context is one author: the grant the relay accepted the
    /// frame under. The admitted snapshot keeps their public entry, and a
    /// declared agent is credited beside them.
    #[test]
    fn a_recorded_shared_principal_is_credited_once_beside_its_agent() {
        let (_dir, mut store, mut cache, _owner, handle) = fixture();
        let agent = serde_json::json!({"kind":"agent","agentId":"guest-agent","agentName":"Guest agent","onBehalfOf":"guest-1","depth":1});
        let snapshot = |entries: Vec<serde_json::Value>| -> Vec<LiveAuthorEntry> {
            entries
                .into_iter()
                .map(|entry| serde_json::from_value(entry).unwrap())
                .collect()
        };
        let source = Ydoc::wire();
        let frames = [
            (
                "named-recorded",
                ServerDerivedLiveUpdateAuthority::Named {
                    principal_id: "guest-1".into(),
                    grant_id: "grant-1".into(),
                    grant_generation: 1,
                },
                snapshot(vec![
                    serde_json::json!({"kind":"human","humanId":"guest-1","humanName":"Guest"}),
                    agent.clone(),
                ]),
                source.plaintext_insert(0, "a"),
            ),
            (
                "link-recorded",
                ServerDerivedLiveUpdateAuthority::Link {
                    principal_id: "holder-1".into(),
                    grant_id: "grant-link".into(),
                    grant_generation: 2,
                },
                snapshot(vec![
                    serde_json::json!({"kind":"link","publicPrincipalId":"public-holder-1","label":"Anonymous"}),
                ]),
                source.plaintext_insert(1, "b"),
            ),
        ];
        for (cursor, (delivery, authority, authors, bytes)) in (1..).zip(frames) {
            let mut update = event(delivery, cursor, bytes);
            update.metadata.canonical_version = Some(2);
            update.metadata.author_snapshot = Some(authors);
            update.metadata.first_seen_deletes = Some(Vec::new());
            update.metadata.accepted.authority = authority;
            ack(apply(&mut store, &mut cache, &handle, update.clone()));
            // A replay matches the stored event, admitted snapshot included.
            assert!(ack(apply(&mut store, &mut cache, &handle, update)).application_replayed);
        }
        let interval = store
            .read_with(|conn| crate::author_coverage::interval_in(conn, &key(), i64::MAX))
            .unwrap()
            .json();
        // Each person is one author, by grant, beside their declared agent.
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&interval).unwrap(),
            serde_json::json!([
                agent,
                {"kind":"link","grantId":"grant-link","grantGeneration":2,"principalId":"holder-1"},
                {"kind":"named","userId":"guest-1","grantId":"grant-1","grantGeneration":1}
            ])
        );
    }

    /// A live-shared record: the session host commits each accepted frame,
    /// the owner's and a collaborator's alike, so it claims the frame's field
    /// changes once, as the principal the relay accepted it from.
    #[test]
    fn the_session_host_claims_each_accepted_field_change_once() {
        host_claims_each_accepted_field_change(None, false);
    }

    #[test]
    fn v2_own_draft_keeps_its_automation_author_depth_and_person() {
        host_claims_each_accepted_field_change(Some(2), false);
    }

    #[test]
    fn v2_capped_agent_own_draft_keeps_its_automation_author_depth_and_person() {
        host_claims_each_accepted_field_change(Some(2), true);
    }

    fn host_claims_each_accepted_field_change(canonical_version: Option<u8>, capped_agent: bool) {
        // Each frame first sees what the source wrote since the previous
        // frame, so the same bytes delivered again see nothing new.
        let source = Ydoc::wire();
        let seen = std::cell::RefCell::new(source.state_vector());
        let event = |delivery: &str, cursor: i64, bytes: Vec<u8>| {
            let mut admitted = event(delivery, cursor, bytes);
            let after = source.state_vector();
            let mut first_seen: Vec<_> = after
                .iter()
                .filter_map(|(client, clock)| {
                    let start = seen.borrow().get(client);
                    (*clock > start).then_some(LiveUpdateStructRange {
                        client_id: client.get() as i64,
                        start_clock: i64::from(start),
                        end_clock: i64::from(*clock),
                    })
                })
                .collect();
            first_seen.sort_by_key(|range| range.client_id);
            admitted.metadata.first_seen = first_seen;
            *seen.borrow_mut() = after;
            admitted.metadata.canonical_version = canonical_version;
            if canonical_version == Some(2) {
                admitted.metadata.author_snapshot = Some(if capped_agent {
                    vec![LiveAuthorEntry::Human {
                        human_id: "owner-1".into(),
                        human_name: "Owner".into(),
                    }]
                } else {
                    Vec::new()
                });
                admitted.metadata.first_seen_deletes = Some(Vec::new());
            }
            admitted
        };
        let (dir, mut store, mut cache, _owner, handle) = field_history_fixture();
        let claims = |store: &EngineStore| -> Vec<(String, Option<String>)> {
            store
                .read_with(|conn| {
                    let mut statement = conn.prepare(
                        "SELECT change_kind, author_origin_id FROM automation_claims \
                         ORDER BY created_at_ms, claim_id",
                    )?;
                    let rows = statement
                        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok::<_, rusqlite::Error>(rows)
                })
                .unwrap()
        };
        let shared_authors = |store: &EngineStore| -> Vec<Option<serde_json::Value>> {
            store
                .read_with(|conn| {
                    let mut statement = conn.prepare(
                        "SELECT change_author_json FROM automation_claims \
                         ORDER BY created_at_ms, claim_id",
                    )?;
                    let rows = statement
                        .query_map([], |row| row.get::<_, Option<String>>(0))?
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok::<_, rusqlite::Error>(rows)
                })
                .unwrap()
                .into_iter()
                .map(|json| json.map(|json| serde_json::from_str(&json).unwrap()))
                .collect()
        };

        let owner_edit = event(
            "owner-edit",
            1,
            source.frontmatter_set("status", "done").unwrap(),
        );
        let ApplicationResult::Applied(_, returned) =
            apply(&mut store, &mut cache, &handle, owner_edit.clone())
        else {
            panic!("expected applied");
        };
        assert_eq!(
            claims(&store),
            vec![("changed".to_owned(), Some("owner-1".to_owned()))],
            "the owner's accepted edit claims on the host"
        );
        assert_eq!(
            returned.len(),
            1,
            "the host returns its claim, so the caller can wake the executor"
        );
        let ApplicationResult::Applied(replayed, returned) =
            apply(&mut store, &mut cache, &handle, owner_edit)
        else {
            panic!("expected applied");
        };
        assert!(replayed.application_replayed);
        assert!(returned.is_empty());
        assert_eq!(claims(&store).len(), 1, "a replayed frame claims nothing");

        let mut guest_edit = event(
            "guest-edit",
            2,
            source.frontmatter_set("status", "late").unwrap(),
        );
        guest_edit.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Named {
            principal_id: "guest-1".into(),
            grant_id: "grant-1".into(),
            grant_generation: 1,
        };
        // Recording context names the account the relay accepted the edit from.
        if capped_agent {
            guest_edit.metadata.author_snapshot = Some(vec![LiveAuthorEntry::Human {
                human_id: "guest-1".into(),
                human_name: "Guest".into(),
            }]);
        }
        guest_edit.metadata.accepted.received_at_ms = 20;
        ack(apply(&mut store, &mut cache, &handle, guest_edit));
        assert_eq!(
            claims(&store),
            vec![
                ("changed".to_owned(), Some("owner-1".to_owned())),
                ("changed".to_owned(), Some("guest-1".to_owned())),
            ],
            "a collaborator's accepted edit claims on the host too"
        );

        // An Edit link holder's edit names the link, from the relay's
        // authority, and never a person.
        let mut link_edit = event(
            "link-edit",
            3,
            source.frontmatter_set("status", "linked").unwrap(),
        );
        link_edit.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Link {
            principal_id: "holder-1".into(),
            grant_id: "grant-link".into(),
            grant_generation: 2,
        };
        // A link holder's context names its public principal, not the grant.
        if capped_agent {
            link_edit.metadata.author_snapshot = Some(vec![serde_json::from_value(
                serde_json::json!({"kind":"link","publicPrincipalId":"public-holder-1","label":"Anonymous"}),
            )
            .unwrap()]);
        }
        link_edit.metadata.accepted.received_at_ms = 25;
        ack(apply(&mut store, &mut cache, &handle, link_edit));
        assert_eq!(claims(&store).len(), 3);
        assert_eq!(
            shared_authors(&store),
            vec![
                None,
                Some(
                    serde_json::json!({"kind":"named","userId":"guest-1","grantId":"grant-1","grantGeneration":1})
                ),
                Some(
                    serde_json::json!({"kind":"link","grantId":"grant-link","grantGeneration":2,"principalId":"holder-1"})
                ),
            ],
            "a collaborator's or a link's edit names who the relay accepted it from; the owner's names nobody"
        );
        let persons = |store: &EngineStore| -> Vec<Option<String>> {
            store
                .read_with(|conn| {
                    let mut statement = conn.prepare(
                        "SELECT on_behalf_of FROM automation_claims ORDER BY created_at_ms, claim_id",
                    )?;
                    let rows = statement
                        .query_map([], |row| row.get(0))?
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok::<_, rusqlite::Error>(rows)
                })
                .unwrap()
        };
        // The person a run reads is the collaborator the relay accepted the
        // edit from. A link names no person, and neither does the owner's
        // authority, which an automation on the server also writes under.
        assert_eq!(
            persons(&store),
            vec![None, Some("guest-1".to_owned()), None]
        );
        // The moment that settles these frames names the collaborator and the
        // link once, from the same authority, so History says who changed the
        // file, even when their own snapshot named them too. The owner's
        // snapshot person stays. Frames without recording context also keep
        // the unattributed gap.
        let interval = store
            .read_with(|conn| crate::author_coverage::interval_in(conn, &key(), i64::MAX))
            .unwrap()
            .json();
        let snapshot_author = capped_agent
            .then(|| serde_json::json!({"kind":"human","humanId":"owner-1","humanName":"Owner"}));
        let missing_context = (!capped_agent).then(|| serde_json::json!({"kind":"unattributed"}));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&interval).unwrap(),
            serde_json::Value::Array(
                snapshot_author
                    .into_iter()
                    .chain([
                        serde_json::json!({"kind":"link","grantId":"grant-link","grantGeneration":2,"principalId":"holder-1"}),
                        serde_json::json!({"kind":"named","userId":"guest-1","grantId":"grant-1","grantGeneration":1}),
                    ])
                    .chain(missing_context)
                    .collect()
            ),
        );

        let body_only = event("body-only", 4, source.plaintext_insert(0, "body"));
        ack(apply(&mut store, &mut cache, &handle, body_only));
        assert_eq!(claims(&store).len(), 3, "a body-only frame claims nothing");

        // This engine's own drafts, which an automation wrote at depth 2.
        let own_draft = |store: &mut EngineStore, key: &str, update: &[u8]| {
            let appended = crate::owner_outbox::append(
                store,
                "workspace-1",
                crate::owner_outbox::OwnerOutboxAppendInput {
                    binding: binding(),
                    base_update: Ydoc::wire().encode_full_state(),
                    append_key: key.into(),
                    update: update.to_vec(),
                    limits: crate::owner_outbox::OwnerOutboxLimits {
                        max_pending_bytes: 100_000,
                        max_pending_age_ms: 100_000,
                    },
                    created_at_ms: 1,
                },
            )
            .unwrap();
            let source = crate::owner_outbox::OwnerOutboxNativeSource {
                binding: binding(),
                adoption_id: "adoption-1".into(),
                native_sequence: 1,
                update_digest: appended.update_digest.clone(),
                origin: crate::owner_outbox::OwnerOutboxNativeOrigin::NativeUpdate {
                    actor_origin_id: Some("collection:notes#stamp".into()),
                    actor_kind: Some("automation".into()),
                    on_behalf_of: Some("person-1".into()),
                    chain_depth: Some(2),
                    recorded_at_ms: 1,
                },
            };
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "UPDATE owner_ydoc_outbox_entries SET native_source_json = ?1, agent_declaration_json = ?3 \
                         WHERE delivery_id = ?2",
                        params![
                            serde_json::to_string(&source).unwrap(),
                            appended.delivery_id,
                            capped_agent.then(|| serde_json::to_string(&AgentDeclaration {
                                agent_id: "collection:notes#stamp".into(),
                                on_behalf_of: Some("person-1".into()),
                                depth: 2,
                            }).unwrap())
                        ],
                    )
                    .unwrap();
                    Ok::<_, StorageError>(())
                })
                .unwrap();
            appended.delivery_id
        };
        let newest = |store: &EngineStore| -> (Option<String>, i64, Option<String>) {
            store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT author_origin_id, depth, on_behalf_of FROM automation_claims \
                         ORDER BY created_at_ms DESC, claim_id DESC LIMIT 1",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                })
                .unwrap()
        };
        let stamped = source.frontmatter_set("status", "stamped").unwrap();
        let delivery = own_draft(&mut store, "own-stamp", &stamped);
        let mut accepted = event(&delivery, 5, stamped);
        accepted.metadata.accepted.received_at_ms = 30;
        ack(apply(&mut store, &mut cache, &handle, accepted));
        assert_eq!(
            newest(&store),
            (
                Some("collection:notes#stamp".to_owned()),
                2,
                Some("person-1".to_owned())
            ),
            "the host's own draft keeps its automation author, depth and person"
        );
        assert_eq!(
            newest_field_author(&store),
            (
                Some("automation".into()),
                Some("collection:notes#stamp".into()),
                Some("person-1".into())
            )
        );

        // The same bytes under another delivery are not that draft.
        let restamped = source.frontmatter_set("status", "restamped").unwrap();
        own_draft(&mut store, "own-restamp", &restamped);
        let mut elsewhere = event("elsewhere", 6, restamped);
        elsewhere.metadata.accepted.received_at_ms = 40;
        ack(apply(&mut store, &mut cache, &handle, elsewhere));
        assert_eq!(newest(&store), (Some("owner-1".to_owned()), 0, None));

        // Each claim keeps the relay journal cursor of the frame it came in,
        // the host's own drafts' too, so the relay can place it in the
        // settlement that carried it. The body-only frame at 4 claimed nothing.
        let cursors = |store: &EngineStore| -> Vec<Option<i64>> {
            store
                .read_with(|conn| {
                    let mut statement = conn.prepare(
                        "SELECT change_live_cursor FROM automation_claims \
                         ORDER BY created_at_ms, claim_id",
                    )?;
                    let rows = statement
                        .query_map([], |row| row.get(0))?
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok::<_, rusqlite::Error>(rows)
                })
                .unwrap()
        };
        assert_eq!(
            cursors(&store),
            vec![Some(1), Some(2), Some(3), Some(5), Some(6)]
        );

        // The claim still keys on its history row, so a frame retried after a
        // restart claims nothing more, and the same change delivered again
        // under another delivery id and cursor claims nothing either.
        let final_edit = source.frontmatter_set("status", "final").unwrap();
        let mut last = event("final-edit", 7, final_edit.clone());
        last.metadata.accepted.received_at_ms = 50;
        ack(apply(&mut store, &mut cache, &handle, last.clone()));
        assert_eq!(cursors(&store).len(), 6);
        assert_eq!(cursors(&store).last(), Some(&Some(7)));
        store = reopen(store, &dir);
        let mut cache = WriterDocCache::new();
        let retried = ack(apply(&mut store, &mut cache, &handle, last));
        assert!(retried.application_replayed);
        let mut again = event("final-edit-again", 8, final_edit);
        again.metadata.accepted.received_at_ms = 60;
        ack(apply(&mut store, &mut cache, &handle, again));
        assert_eq!(
            cursors(&store).len(),
            6,
            "a retried or re-delivered frame claims once"
        );
    }

    fn field_history_fixture() -> (
        ScratchDir,
        EngineStore,
        WriterDocCache,
        ApplicationOwner,
        ApplicationHandle,
    ) {
        use dohc_engine_domain::{
            AutomationChangeKind, AutomationSubscription, VersionedTextStore, WriteText,
        };
        let dir = ScratchDir::new_named("live-device-application-claims").unwrap();
        let mut store = EngineStore::open(&dir.join("engine.db"), 0).unwrap();
        let mut versions = VersionedTextStore::new(&mut store);
        versions
            .ensure_main_version("workspace-1", "main", 0, &NoFaults)
            .unwrap();
        for (object_id, path, text) in [
            (
                "schema-object",
                "notes/collection.yaml",
                "fields:\n  status:\n    type: text\n",
            ),
            (
                "object-1",
                "notes/a.md",
                "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nstatus: open\n---\n",
            ),
        ] {
            versions
                .write_text(
                    &WriteText {
                        workspace_id: "workspace-1".into(),
                        version_id: "main".into(),
                        object_id: object_id.into(),
                        path: path.into(),
                        text: text.into(),
                        moment_id: format!("moment:{object_id}"),
                        metadata_origin: "test".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 1,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::reconcile_collections_in_tx(tx, "workspace-1", "main")?;
                dohc_engine_domain::subscribe_automation_in_tx(
                    tx,
                    "workspace-1",
                    &AutomationSubscription {
                        automation_id: "collection:notes#watch".into(),
                        prefix: "notes".into(),
                        kinds: vec![AutomationChangeKind::Changed],
                        fields: None,
                    },
                    1,
                )
            })
            .unwrap();
        durable::ensure_marker(
            &mut store,
            &key(),
            ContentKind::Richdoc,
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
        let cache = WriterDocCache::new();

        (dir, store, cache, owner, handle)
    }

    fn account_frame(
        delivery: &str,
        cursor: i64,
        bytes: Vec<u8>,
        agent: bool,
    ) -> AdmittedLiveUpdate {
        let mut update = event(delivery, cursor, bytes);
        update.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Named {
            principal_id: "guest-1".into(),
            grant_id: "grant-1".into(),
            grant_generation: 1,
        };
        update.metadata.canonical_version = Some(2);
        update.metadata.first_seen_deletes = Some(vec![]);
        let mut authors = vec![LiveAuthorEntry::Human {
            human_id: "guest-1".into(),
            human_name: "Ana".into(),
        }];
        if agent {
            authors.push(LiveAuthorEntry::Agent {
                agent_id: "agent-1".into(),
                agent_name: Some("Helper".into()),
                on_behalf_of: Some("guest-1".into()),
                depth: Some(0),
            });
        }
        update.metadata.author_snapshot = Some(authors);
        update
    }

    fn newest_field_author(
        store: &EngineStore,
    ) -> (Option<String>, Option<String>, Option<String>) {
        store.read_with(|conn| conn.query_row(
            "SELECT actor_kind,author_origin_id,on_behalf_of FROM collection_field_history ORDER BY history_id DESC LIMIT 1",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )).unwrap()
    }

    fn link_frame(delivery: &str, cursor: i64, bytes: Vec<u8>) -> AdmittedLiveUpdate {
        let mut update = account_frame(delivery, cursor, bytes, false);
        update.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Link {
            principal_id: "private-holder-1".into(),
            grant_id: "link-1".into(),
            grant_generation: 2,
        };
        update.metadata.author_snapshot = Some(vec![LiveAuthorEntry::Link {
            public_principal_id: "public-holder-1".into(),
            label: "Self claimed".into(),
        }]);
        update
    }

    #[test]
    fn field_history_names_the_accepted_link_and_preserves_duplicate_author() {
        let (_dir, mut store, mut cache, _owner, handle) = field_history_fixture();
        let bytes = Ydoc::wire().frontmatter_set("status", "done").unwrap();
        let update = link_frame("link", 1, bytes.clone());
        ack(apply(&mut store, &mut cache, &handle, update.clone()));
        let read = |store: &EngineStore| {
            store.read_with(|conn| conn.query_row(
            "SELECT link_author_json FROM collection_field_history ORDER BY history_id DESC LIMIT 1",
            [], |row| row.get::<_, Option<String>>(0),
        )).unwrap()
        };
        let expected = serde_json::json!({"kind":"link","grantId":"link-1","grantGeneration":2,"publicPrincipalId":"public-holder-1"});
        assert_eq!(
            serde_json::from_str::<Value>(&read(&store).unwrap()).unwrap(),
            expected
        );
        assert_eq!(newest_field_author(&store), (None, None, None));
        assert!(ack(apply(&mut store, &mut cache, &handle, update)).application_replayed);
        ack(apply(
            &mut store,
            &mut cache,
            &handle,
            account_frame("duplicate", 2, bytes, false),
        ));
        assert_eq!(count(&store, "collection_field_history"), 1);
        assert_eq!(
            serde_json::from_str::<Value>(&read(&store).unwrap()).unwrap(),
            expected
        );
        for kind in ["legacy", "unattributed", "named", "owner", "link-agent"] {
            let (_dir, mut store, mut cache, _owner, handle) = field_history_fixture();
            let bytes = Ydoc::wire().frontmatter_set("status", "done").unwrap();
            let mut update = if kind == "named" || kind == "owner" {
                account_frame(kind, 1, bytes, false)
            } else {
                link_frame(kind, 1, bytes)
            };
            match kind {
                "legacy" => {
                    update.metadata.canonical_version = None;
                    update.metadata.author_snapshot = None;
                    update.metadata.first_seen_deletes = None;
                }
                "unattributed" => {
                    update.metadata.author_snapshot = Some(vec![LiveAuthorEntry::Unattributed {}])
                }
                "owner" => {
                    update.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Owner {
                        principal_id: "guest-1".into(),
                    }
                }
                "link-agent" => {
                    update
                        .metadata
                        .author_snapshot
                        .as_mut()
                        .unwrap()
                        .push(LiveAuthorEntry::Agent {
                            agent_id: "agent-1".into(),
                            agent_name: None,
                            on_behalf_of: Some("public-holder-1".into()),
                            depth: None,
                        })
                }
                _ => {}
            }
            ack(apply(&mut store, &mut cache, &handle, update));
            if kind == "link-agent" {
                assert_eq!(
                    newest_field_author(&store),
                    (
                        Some("agent".into()),
                        Some("agent-1".into()),
                        Some("public-holder-1".into())
                    )
                );
                assert_eq!(
                    serde_json::from_str::<Value>(&read(&store).unwrap()).unwrap(),
                    expected
                );
            } else {
                assert_eq!(read(&store), None, "{kind}");
            }
        }
    }

    #[test]
    #[ignore = "manual per-frame timing, 30 accepted link field edits"]
    fn field_history_link_frame_cost() {
        let (_dir, mut store, mut cache, _owner, handle) = field_history_fixture();
        let source = Ydoc::wire();
        let mut samples = Vec::new();
        for cursor in 1..=35 {
            let update = link_frame(
                &format!("cost-{cursor}"),
                cursor,
                source
                    .frontmatter_set("status", &format!("value-{cursor}"))
                    .unwrap(),
            );
            let start = std::time::Instant::now();
            ack(apply(&mut store, &mut cache, &handle, update));
            if cursor > 5 {
                samples.push(start.elapsed().as_nanos());
            }
        }
        samples.sort_unstable();
        println!(
            "field_history_link_frame_cost: n={} median_ns={}",
            samples.len(),
            (samples[14] + samples[15]) / 2
        );
    }

    #[test]
    fn field_history_names_the_accepted_person() {
        let (_dir, mut store, mut cache, _owner, handle) = field_history_fixture();
        let update = account_frame(
            "person",
            1,
            Ydoc::wire().frontmatter_set("status", "done").unwrap(),
            false,
        );
        ack(apply(&mut store, &mut cache, &handle, update.clone()));
        assert_eq!(
            newest_field_author(&store),
            (
                Some("human".into()),
                Some("guest-1".into()),
                Some("guest-1".into())
            )
        );
        assert!(ack(apply(&mut store, &mut cache, &handle, update)).application_replayed);
        assert_eq!(count(&store, "collection_field_history"), 1);
        let authors = store
            .read_with(|conn| crate::author_coverage::interval_in(conn, &key(), 1))
            .unwrap()
            .json();
        // The relay's grant names the person once, in place of their snapshot entry.
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&authors).unwrap(),
            serde_json::json!([
                {"kind":"named","userId":"guest-1","grantId":"grant-1","grantGeneration":1}
            ])
        );
    }

    #[test]
    fn field_history_duplicate_bytes_keep_the_earlier_author() {
        let (_dir, mut store, mut cache, _owner, handle) = field_history_fixture();
        let bytes = Ydoc::wire().frontmatter_set("status", "done").unwrap();
        ack(apply(
            &mut store,
            &mut cache,
            &handle,
            account_frame("first-person", 1, bytes.clone(), false),
        ));
        let first_author = newest_field_author(&store);
        assert_eq!(count(&store, "collection_field_history"), 1);
        assert_eq!(first_author.1.as_deref(), Some("guest-1"));

        let mut duplicate = account_frame("other-person", 2, bytes, false);
        duplicate.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Named {
            principal_id: "guest-2".into(),
            grant_id: "grant-2".into(),
            grant_generation: 1,
        };
        duplicate.metadata.author_snapshot = Some(vec![LiveAuthorEntry::Human {
            human_id: "guest-2".into(),
            human_name: "Ben".into(),
        }]);
        ack(apply(&mut store, &mut cache, &handle, duplicate));
        assert_eq!(count(&store, "collection_field_history"), 1);
        assert_eq!(newest_field_author(&store), first_author);
    }

    #[test]
    fn field_history_names_the_accepted_agent_and_person() {
        let (_dir, mut store, mut cache, _owner, handle) = field_history_fixture();
        let update = account_frame(
            "agent",
            1,
            Ydoc::wire().frontmatter_set("status", "done").unwrap(),
            true,
        );
        ack(apply(&mut store, &mut cache, &handle, update));
        assert_eq!(
            newest_field_author(&store),
            (
                Some("agent".into()),
                Some("agent-1".into()),
                Some("guest-1".into())
            )
        );
        let authors = store
            .read_with(|conn| crate::author_coverage::interval_in(conn, &key(), 1))
            .unwrap()
            .json();
        // The agent keeps its canonical name beside the person's grant.
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&authors).unwrap(),
            serde_json::json!([
                {"kind":"agent","agentId":"agent-1","agentName":"Helper","onBehalfOf":"guest-1","depth":0},
                {"kind":"named","userId":"guest-1","grantId":"grant-1","grantGeneration":1}
            ])
        );
    }

    #[test]
    fn field_history_without_a_confirmed_account_stays_unattributed() {
        for kind in [
            "empty",
            "unattributed",
            "agent-only",
            "wrong-person",
            "wrong-agent-person",
            "legacy",
            "wrong-link-agent-principal",
        ] {
            let (_dir, mut store, mut cache, _owner, handle) = field_history_fixture();
            let mut update = account_frame(
                kind,
                1,
                Ydoc::wire().frontmatter_set("status", "done").unwrap(),
                true,
            );
            match kind {
                "empty" => update.metadata.author_snapshot = Some(vec![]),
                "unattributed" => {
                    update.metadata.author_snapshot = Some(vec![LiveAuthorEntry::Unattributed {}])
                }
                "agent-only" => {
                    update.metadata.author_snapshot.as_mut().unwrap().remove(0);
                }
                "wrong-person" => {
                    update.metadata.author_snapshot = Some(vec![LiveAuthorEntry::Human {
                        human_id: "client-declared".into(),
                        human_name: "False name".into(),
                    }]);
                }
                "wrong-agent-person" => {
                    if let LiveAuthorEntry::Agent { on_behalf_of, .. } =
                        &mut update.metadata.author_snapshot.as_mut().unwrap()[1]
                    {
                        *on_behalf_of = Some("client-declared".into());
                    }
                }
                "legacy" => {
                    update.metadata.canonical_version = None;
                    update.metadata.author_snapshot = None;
                    update.metadata.first_seen_deletes = None;
                }
                "wrong-link-agent-principal" => {
                    update.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Link {
                        principal_id: "holder-1".into(),
                        grant_id: "link-1".into(),
                        grant_generation: 1,
                    };
                    update.metadata.author_snapshot = Some(vec![
                        LiveAuthorEntry::Link {
                            public_principal_id: "public-1".into(),
                            label: "Self claimed".into(),
                        },
                        LiveAuthorEntry::Agent {
                            agent_id: "agent-1".into(),
                            agent_name: None,
                            on_behalf_of: Some("holder-1".into()),
                            depth: None,
                        },
                    ]);
                }
                _ => unreachable!(),
            }
            ack(apply(&mut store, &mut cache, &handle, update));
            assert_eq!(newest_field_author(&store), (None, None, None), "{kind}");
        }
    }

    #[test]
    fn field_history_accepted_automation_keeps_its_attribution() {
        let (_dir, mut store, mut cache, _owner, handle) = field_history_fixture();
        let mut update = account_frame(
            "automation",
            1,
            Ydoc::wire().frontmatter_set("status", "done").unwrap(),
            false,
        );
        update.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Owner {
            principal_id: "owner-1".into(),
        };
        update.metadata.author_snapshot = Some(vec![LiveAuthorEntry::Automation {
            automation_id: "collection:notes#stamp".into(),
            attribution: dohc_engine_domain::ChangeAttribution {
                actor_kind: dohc_engine_domain::ChangeActorKind::Automation,
                on_behalf_of: Some("person-1".into()),
                depth: 2,
                run: None,
            },
        }]);
        ack(apply(&mut store, &mut cache, &handle, update));
        assert_eq!(
            newest_field_author(&store),
            (
                Some("automation".into()),
                Some("collection:notes#stamp".into()),
                Some("person-1".into())
            )
        );
    }

    #[test]
    fn field_history_own_human_draft_keeps_its_attribution() {
        let (_dir, mut store, mut cache, _owner, handle) = field_history_fixture();
        let bytes = Ydoc::wire().frontmatter_set("status", "done").unwrap();
        let draft = crate::owner_outbox::append(
            &mut store,
            "workspace-1",
            crate::owner_outbox::OwnerOutboxAppendInput {
                binding: binding(),
                base_update: Ydoc::wire().encode_full_state(),
                append_key: "human-draft".into(),
                update: bytes.clone(),
                limits: crate::owner_outbox::OwnerOutboxLimits {
                    max_pending_bytes: 100_000,
                    max_pending_age_ms: 100_000,
                },
                created_at_ms: 1,
            },
        )
        .unwrap();
        let native = crate::owner_outbox::OwnerOutboxNativeSource {
            binding: binding(),
            adoption_id: "adoption-1".into(),
            native_sequence: 1,
            update_digest: draft.update_digest.clone(),
            origin: crate::owner_outbox::OwnerOutboxNativeOrigin::NativeUpdate {
                actor_origin_id: Some("local-person".into()),
                actor_kind: Some("human".into()),
                on_behalf_of: Some("local-person".into()),
                chain_depth: Some(0),
                recorded_at_ms: 1,
            },
        };
        store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE owner_ydoc_outbox_entries SET native_source_json=?1 WHERE delivery_id=?2", params![serde_json::to_string(&native).unwrap(), draft.delivery_id]).map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        }).unwrap();
        let mut update = account_frame(&draft.delivery_id, 1, bytes, false);
        update.metadata.accepted.authority = ServerDerivedLiveUpdateAuthority::Owner {
            principal_id: "owner-1".into(),
        };
        update.metadata.author_snapshot = Some(vec![LiveAuthorEntry::Human {
            human_id: "owner-1".into(),
            human_name: "Owner".into(),
        }]);
        ack(apply(&mut store, &mut cache, &handle, update));
        assert_eq!(
            newest_field_author(&store),
            (
                Some("human".into()),
                Some("local-person".into()),
                Some("local-person".into())
            )
        );
    }

    #[test]
    #[ignore = "manual per-frame timing, 30 accepted field edits"]
    fn field_history_frame_cost() {
        let (_dir, mut store, mut cache, _owner, handle) = field_history_fixture();
        let source = Ydoc::wire();
        let mut samples = Vec::new();
        for cursor in 1..=35 {
            let update = account_frame(
                &format!("cost-{cursor}"),
                cursor,
                source
                    .frontmatter_set("status", &format!("value-{cursor}"))
                    .unwrap(),
                true,
            );
            let start = std::time::Instant::now();
            ack(apply(&mut store, &mut cache, &handle, update));
            if cursor > 5 {
                samples.push(start.elapsed().as_nanos());
            }
        }
        samples.sort_unstable();
        println!(
            "field_history_frame_cost: n={} median_ns={}",
            samples.len(),
            (samples[14] + samples[15]) / 2
        );
    }
}
